import { v4 as uuid } from "uuid";
import crypto from "crypto";
import { getDb } from "../database/init";
import { isDisplayablePhone, validatePhoneForWrite, stripTrailingContactLabel, stripLeadingContactLabel } from "./contact-normalizer";
import { isJunkDescription, normalizeProse } from "./description-quality";
import { textEntries } from "../utils/text-entries";
import { normalizeEmail } from "./blocklist-service";
import { customerRuleSql } from "./customer-rule";
import {
  type ClaimRecommendation, type DomainHttpsCheck, claimDomainRuleEnabled, emailDomain, emailDomainMatchesWebsite,
  getDomainHttpsCheck, isFreeMailDomain, isHostedPlatformHost, websiteHost,
} from "./claim-domain-rule";

// ─── PR-95 (2026-06-01): Debio cert relabelling ──────────────────────
//
// Daniel-directive: only show a "Debio" / "Debio-sertifisert" label when
// debio_verified=1 (i.e. the producer was matched against the public
// finnoko.debio.no/api/acm/companies feed by
// src/services/debio-verification-service.ts).
//
// Pre-PR-95 the seed-knowledge.ts auto-inferrer pushed "Debio-sertifisert"
// onto certifications[] for any agent whose description contained
// "organic"/"økologisk" — 73 agents on the platform, 0 actually verified.
// That inference line was deleted in PR-95 but stale "Debio-sertifisert"
// entries persist in agent_knowledge.certifications rows seeded prior to
// the deploy.
//
// This helper rewrites the OUTGOING API representation so:
//   - debio_verified=1 → ensure "✓ Debio-verifisert" appears in the list
//                        (drop any stale "Debio-sertifisert" / "Debio")
//   - debio_verified=0 → drop "Debio-sertifisert" / "Debio" and replace
//                        with "Hevder økologisk" if the seed had marked
//                        them organic. This downgrades the trust signal
//                        without dropping the relevance signal for search.
//
// Pure function — does not mutate the input array.
//
// Integration test 2026-10-17 (I-F): `raw` is DB JSON, so it is read with
// textEntries — text entries, trimmed; a list stored as one string is one
// entry. A number or an object among the entries used to reach `.trim()` and
// throw out of every reader (lokal_info, lokal_search, /agents/:id/info).
export function relabelCertifications(
  raw: unknown,
  debioVerified: boolean,
): string[] {
  const list = textEntries(raw);
  const isDebioClaim = (s: string) => /^debio(\b|[-_\s])|debio[-_ ]?sertifisert/i.test(s);
  const isOrganicClaim = (s: string) => /^øk(o(logisk)?)?\b/i.test(s) || /^organic\b/i.test(s);
  const out: string[] = [];
  let hadDebioOrOrganicSeed = false;
  for (const item of list) {
    if (isDebioClaim(item) || isOrganicClaim(item)) {
      hadDebioOrOrganicSeed = true;
      continue; // dropped — re-emitted below per verification status
    }
    out.push(item);
  }
  if (debioVerified) {
    out.unshift("✓ Debio-verifisert");
  } else if (hadDebioOrOrganicSeed) {
    out.push("Hevder økologisk");
  }
  return out;
}

// ─── Agent Knowledge Service ──────────────────────────────────
// The "Google My Business" layer for food agents.
//
// Every agent gets a knowledge profile — auto-populated from
// public sources at registration, enriched over time.
//
// When a buyer agent asks about a seller, this service returns
// everything we know: address, products, hours, reviews, etc.
//
// When a seller claims their agent, they can override and enrich
// the auto-populated data with verified, first-party info.
//
// Data provenance is always tracked:
//   - 'auto'   = scraped/imported from public sources
//   - 'owner'  = seller-provided after claiming
//   - 'hybrid' = mix of both (auto base + owner overrides)

export interface AgentKnowledge {
  agentId: string;
  address?: string;
  postalCode?: string;
  website?: string;
  phone?: string;
  email?: string;
  openingHours: OpeningHour[];
  products: ProductInfo[];
  about?: string;
  specialties: string[];
  certifications: string[];
  paymentMethods: string[];
  deliveryOptions: string[];
  googleRating?: number;
  googleReviewCount?: number;
  tripadvisorRating?: number;
  externalReviews: ExternalReview[];
  externalLinks: ExternalLink[];
  images: string[];
  // Tier 2 fields
  seasonality: SeasonalProduct[];     // Product-to-month mapping
  deliveryRadius?: number;            // km — how far they deliver
  minOrderValue?: number;             // NOK — minimum order for delivery
  dataSource: "auto" | "owner" | "hybrid";
  autoSources: string[];
  lastEnrichedAt?: string;
  ownerUpdatedAt?: string;
  preferences: Record<string, any>;
  /** Phase 4.9a — fields that are customer-curated (set by CS-agent on
   *  customer request). Enrichment must check this and skip locked fields
   *  to avoid overwriting customer's preferred content. */
  curatedFields?: Record<string, CuratedFieldMeta>;
}

/** Per-field lock metadata. Set by rfb-customer-service when applying
 *  a customer-requested change. Enrichment-agent reads and skips. */
export interface CuratedFieldMeta {
  locked_at: string;       // ISO 8601 UTC
  by: string;              // agent that set the lock (e.g. "rfb-customer-service")
  thread_id?: string;      // Gmail thread-id (audit trail)
  request_summary?: string; // 1-line: "Eirin (daglig leder) ba om ny beskrivelse"
}

// ─── Owner lock in the write layer ───────────────────────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere (S1a point 1). The owner
// portal stamps curated_fields.<column>.by = "owner" on every owner save, but
// upsertKnowledge() used to overwrite such a field for any caller (enrichment,
// admin PUT /agents/:id/knowledge …). With OWNER_LOCK_ENFORCE_WRITES on, a
// write that does not come from the owner path leaves an owner-locked field
// as it is and reports it as skipped: owner_locked. Default OFF = the write
// is byte-identical to before. `products` is lockable like any other column
// (an owner-asserted product list / its categories live in that one column).

/** Env flag (read at call time, "1" or "true" = on). Default OFF. */
export const OWNER_LOCK_ENFORCE_FLAG = "OWNER_LOCK_ENFORCE_WRITES";

export function ownerLockEnforcedForWrites(): boolean {
  const v = process.env[OWNER_LOCK_ENFORCE_FLAG];
  return v === "1" || v === "true";
}

/** AgentKnowledge property -> the curated_fields key (the DB column name). */
const LOCKABLE_FIELD_KEYS: Record<string, string> = {
  address: "address", postalCode: "postal_code", website: "website", phone: "phone", email: "email",
  openingHours: "opening_hours", products: "products", about: "about", specialties: "specialties",
  certifications: "certifications", paymentMethods: "payment_methods", deliveryOptions: "delivery_options",
  googleRating: "google_rating", googleReviewCount: "google_review_count", tripadvisorRating: "tripadvisor_rating",
  externalReviews: "external_reviews", externalLinks: "external_links", images: "images", seasonality: "seasonality",
  deliveryRadius: "delivery_radius", minOrderValue: "min_order_value",
};

/** A field a knowledge write left alone. */
export interface SkippedKnowledgeField {
  field: string;
  reason: "owner_locked";
}

/** Result of upsertKnowledge(): fields dropped from the write because of an owner lock. */
export interface UpsertKnowledgeResult {
  skipped: SkippedKnowledgeField[];
}

/** Options of upsertKnowledge(). */
export interface UpsertKnowledgeOptions {
  /** True only on the owner path (ownerUpdate()); it may change owner-locked fields. */
  ownerPath?: boolean;
}

export interface SeasonalProduct {
  product: string;      // "Jordbær", "Epler", "Honning"
  months: number[];     // [6,7,8] = June-August
  note?: string;        // "Selvplukk i juni"
}

export interface OpeningHour {
  day: string;       // "mon", "tue", etc. or "saturday" for markets
  open: string;      // "09:00"
  close: string;     // "17:00"
  note?: string;     // "Kun i sesong (juni-september)"
}

export interface ProductInfo {
  name: string;
  category: string;
  seasonal: boolean;
  months?: number[];  // [6,7,8,9] = June-September
  organic?: boolean;
  note?: string;
  price?: string;       // "275/kg", "150", "200 pr.sekk"
  priceUnit?: string;   // "kr"
}

// ─── Shared product parsing utilities ─────────────────────
// Used by MCP, A2A, auto-response, and web routes to normalize product data.

/** Check if a product entry is a section header (e.g. "🐑 LAM", "📋 STYKNINGSDELER") */
export function isProductHeader(name: string): boolean {
  if (!name || name.length > 50) return false;
  const stripped = name.replace(/[\p{Emoji_Presentation}\p{Emoji}\uFE0F]/gu, "").trim();
  return /^[A-ZÆØÅÉ\s&]+$/.test(stripped) && stripped.length >= 2;
}

/** Check if a product entry should be skipped (dividers, out-of-stock notes, metadata) */
export function isProductNoise(name: string): boolean {
  if (!name) return true;
  if (/^[❌⸻─—\s]+$/.test(name)) return true;           // dividers
  if (/^❌\s/.test(name)) return true;                     // "❌ Tomt for ..."
  if (/^(Alle unntatt|Håndlaget med)/i.test(name)) return true; // notes
  if (/^Kr\s*\.?\s*\d/i.test(name) && !name.includes("–")) return true; // price-only lines like "Kr.1000"
  return false;
}

/**
 * A product's price field as text. Integration test 2026-10-17 (I-F): the
 * products column is DB JSON, and a price is stored as a number (150) as well
 * as text ("275/kg"); a number reached `.trim()` in parseProductPrice and
 * threw out of lokal_info and lokal_search. Text is returned as it is (the
 * callers trim it), a positive number as its digits, and anything else is no
 * price — 0 included, which the old `p.price || ""` read as no price too.
 */
export function productPriceText(price: unknown): string {
  if (typeof price === "string") return price;
  return typeof price === "number" && Number.isFinite(price) && price > 0 ? String(price) : "";
}

/** Parse price from a product name like "Lammelår – kr 275/kg" → { cleanName, price } */
export function parseProductPrice(p: ProductInfo): { cleanName: string; price: string | null; section: string | null } {
  // I-F: `p` is one entry of the products DB JSON, so each field is read by
  // its type: a name that is not text is no name, and the price goes through
  // productPriceText. Text values give exactly the result they gave before.
  const entry: Partial<Record<keyof ProductInfo, unknown>> = p && typeof p === "object" ? p : {};
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  const priceText = productPriceText(entry.price);

  // Section header?
  if (isProductHeader(name)) {
    const headerText = name.replace(/[\p{Emoji_Presentation}\p{Emoji}\uFE0F]/gu, "").trim();
    const subInfo = priceText && !/^\d/.test(priceText) ? priceText : null;
    return { cleanName: headerText, price: null, section: subInfo || headerText };
  }

  // Skip noise
  if (isProductNoise(name)) return { cleanName: name, price: null, section: null };

  // Use existing price field if it has a numeric value
  let price = priceText.trim();
  if (price && !/\d/.test(price)) price = ""; // non-numeric price field = descriptor, not price

  let cleanName = name;

  // Parse price from name: "Product – kr XXX/kg" or "Product – kr XXX"
  if (!price) {
    const m = name.match(/^(.+?)\s*[–\-—]\s*kr\.?\s*([\d,.\s]+(?:\/\w+)?)\s*$/i);
    if (m) { cleanName = m[1].trim(); price = `kr ${m[2].trim()}`; }
  }
  // "Product kr.XXX" (no dash)
  if (!price) {
    const m = name.match(/^(.+?)\s+kr\.?\s*([\d,.\s]+(?:\/\w+)?)\s*$/i);
    if (m) { cleanName = m[1].trim(); price = `kr ${m[2].trim()}`; }
  }

  return { cleanName, price: price || null, section: null };
}

export interface ExternalReview {
  source: string;
  text: string;
  rating?: number;
  date?: string;
}

export interface ExternalLink {
  label: string;      // "Facebook-gruppe", "Neste marked"
  url: string;        // Full URL
  type: string;       // "facebook", "info", "schedule", "website"
}

// ─── Structured response for buyer agents ───────────────────
// This is what a buyer agent gets when asking about a seller.
// Clean, parseable, honest about data provenance.

export interface AgentInfoResponse {
  agent: {
    id: string;
    name: string;
    role: string;
    city?: string;
    trustScore: number;
    isVerified: boolean;
    isClaimed: boolean;
    languages: string[];
    schemaVersion: string;
    agentVersion: number;
    /** PR-95: true iff matched against finnoko.debio.no/api/acm/companies */
    debioVerified: boolean;
  };
  knowledge: {
    address?: string;
    postalCode?: string;
    website?: string;
    phone?: string;
    email?: string;
    openingHours: OpeningHour[];
    products: ProductInfo[];
    about?: string;
    description?: string;
    specialties: string[];
    certifications: string[];
    paymentMethods: string[];
    deliveryOptions: string[];
    images: string[];
    seasonality: SeasonalProduct[];
    deliveryRadius?: number;
    minOrderValue?: number;
    /** Never a Google rating (S4-A1a, see getAgentInfo). */
    ratings?: {
      tripadvisor?: { score: number };
    };
    /** Only with getAgentInfo(id, { withGoogleRating: true }): the site's own pages. */
    googleRating?: number;
    googleReviewCount?: number;
  };
  meta: {
    dataSource: "auto" | "owner" | "hybrid";
    autoSources: string[];
    lastUpdated: string;
    disclaimer: string;
  };
}

// ─── Integration test 2026-10-17 (I-F): field shapes of getAgentInfo ──────
// The knowledge columns are JSON whose shape nothing enforces: a list stored
// as one string, null, numbers or objects among its entries, a product with
// no text name. getAgentInfo feeds lokal_info, lokal_search, the producer
// pages and GET /agents/:id/info, so it hands each field over in the shape
// its type declares: list-of-text fields go through textEntries, and the
// lists of records keep the entries a reader can use. Values that already
// have that shape come through unchanged, apart from trimmed text entries.
// The fields inside a product (price, category …) are typed where they are
// read, e.g. parseProductPrice.

/** The entries of a list of records a reader can use: objects, and text (a free-text entry). */
function recordEntries(value: unknown): unknown[] {
  return Array.isArray(value)
    ? value.filter((e) => typeof e === "string" || (e !== null && typeof e === "object" && !Array.isArray(e)))
    : [];
}

/**
 * products: text entries, and product objects with a text name, the field
 * every reader keys on. Exported for the readers that take the products
 * column from getKnowledge (the A2A agent.json, slice I-G).
 */
export function productEntries(value: unknown): ProductInfo[] {
  return recordEntries(value)
    .filter((e) => typeof e === "string" || typeof (e as { name?: unknown }).name === "string") as ProductInfo[];
}

/**
 * openingHours: an array (today's format), or free text such as
 * "Man–fre 10–17", which lokal_info, the producer page and the agent card
 * show as text (slice I-A). The declared type has no text variant, but those
 * readers check for it. Anything else is no opening hours.
 */
function openingHoursField(value: unknown): OpeningHour[] {
  if (typeof value === "string") return value.trim() ? (value as unknown as OpeningHour[]) : [];
  return recordEntries(value) as OpeningHour[];
}

/** A JSON object, or {} for anything else (text, a list, null). */
function plainObjectOrEmpty(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

// ─── Integration test 2026-10-17 (I-G): refused knowledge writes ──────────
// normalizeProducts threw a JavaScript TypeError on products stored as text
// (`products.map`), on a null product (`p.name`) and on a product whose name
// is not text (`.trim`), and PUT /agents/:id/knowledge answered 400 with that
// raw text. Those inputs, and only those, are now refused with a field error
// before anything is written; every value the write path accepted before is
// accepted and stored exactly as before.

/** A knowledge write refused because of one field: `field` is its path, e.g. "products[2].name". */
export class KnowledgeFieldError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = "KnowledgeFieldError";
  }
}

/** The products value a knowledge write cannot store, as a field error; null when it can. */
export function productsWriteError(products: unknown): KnowledgeFieldError | null {
  if (!Array.isArray(products)) {
    // A value with a length reached `.map`; any other value is passed on as before.
    if (!(products as { length?: unknown } | null | undefined)?.length) return null;
    return new KnowledgeFieldError("products", typeof products === "string"
      ? "products må være en liste med produkter, ikke tekst."
      : "products må være en liste med produkter.");
  }
  for (let i = 0; i < products.length; i++) {
    const p: unknown = products[i];
    if (p === null || p === undefined) {
      return new KnowledgeFieldError(`products[${i}]`, `products[${i}] må være et produkt, ikke null.`);
    }
    const name = typeof p === "object" ? (p as { name?: unknown }).name : undefined;
    if (name && typeof name !== "string") {
      return new KnowledgeFieldError(`products[${i}].name`, `products[${i}].name må være tekst.`);
    }
  }
  return null;
}

// ─── Claim rule: decision 11=A ───────────────────────────────────────────
// Daniel 2026-10-17 (daniel-responses/2026-10-17-live-del-a-gjort-og-
// beslutninger-1-11.md, decision 11), dev-request 2026-10-17-rfb-claim-
// verifisering-mot-kjent-kontakt. Before this rule the code went to whatever
// `email` the claimant typed, so anyone could become a farm's "owner", get
// the "Verifisert av eier" badge and change its contact fields.
//   1. The code goes ONLY to the farm's own e-mail (resolveFarmContactEmail).
//      The address the claimant types gets it only when it IS that address.
//   2. No farm e-mail, or the claimant says the listed one is wrong → the
//      claim waits in the admin queue (status 'pending_review'): no code, no
//      token, no badge, no write access until Daniel approves it.
//   3. The profile already has an owner (customerRuleSql) → always the admin
//      queue, also when the e-mail matches. The owner keeps token and access;
//      no claim row is deleted any more.
//   4. At most ONE code per profile per rolling 24 h, whoever asks.
// Hardening A needs, now that guessing the code sent to the farm's inbox is
// the way in: a crypto code that lives 24 h (was Math.random(), 7 days), 5
// wrong tries expire the claim, verify is bound to the profile id, and a
// platform-wide hourly cap on code sends — one code per profile alone would
// still let the form mail hundreds of producers. The admin queue is bounded
// the same way, not by IP: a few open entries per profile and a platform-wide
// hourly cap on new entries, so the public form can neither grow agent_claims
// without limit nor bury real claims in Daniel's queue. The per-IP limit is
// rfbClaimRequestLimiter (middleware/security.ts).
export const CLAIM_CODE_VALID_HOURS = 24;
const CLAIM_TOKEN_VALID_MS = 30 * 24 * 60 * 60 * 1000;
/** RFC 5321's limit on an address; isSingleEmailAddress refuses longer. */
export const EMAIL_ADDRESS_MAX_LENGTH = 254;
// Defaults of claimLimits(); each is also the name of the env var that sets it.
/** Wrong codes per claim; the last one expires the claim. */
export const CLAIM_CODE_MAX_FAILED_ATTEMPTS = 5;
/** Rolling window in which one profile gets at most one code (rule 4). */
export const CLAIM_CODE_PROFILE_WINDOW_HOURS = 24;
/** Code sends across all profiles per rolling hour. */
export const CLAIM_CODE_SENDS_PER_HOUR_MAX = 10;
/** Open admin-queue entries per profile. */
export const CLAIM_REVIEW_OPEN_PER_PROFILE_MAX = 3;
/** New admin-queue entries across all profiles per rolling hour. */
export const CLAIM_REVIEW_INSERTS_PER_HOUR_MAX = 20;
/** Most entries GET /admin/agents/claim-review-queue returns (oldest first). */
export const CLAIM_REVIEW_QUEUE_LIST_MAX = 200;

export interface ClaimLimits {
  maxFailedAttempts: number;
  profileWindowHours: number;
  codeSendsPerHourMax: number;
  reviewOpenPerProfileMax: number;
  reviewInsertsPerHourMax: number;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, dflt: number, min: number, max: number): number {
  const raw = String(env[name] ?? "").trim();
  if (!/^\d+$/.test(raw)) return dflt;
  return Math.min(max, Math.max(min, Number.parseInt(raw, 10)));
}

/**
 * The claim limits, read from env on every call (unset or junk → the
 * default). The two decision 11=A sets — one code per profile per 24 h and 5
 * wrong codes — are clamped so env can only make them stricter.
 */
export function claimLimits(env: NodeJS.ProcessEnv = process.env): ClaimLimits {
  return {
    maxFailedAttempts: intEnv(env, "CLAIM_CODE_MAX_FAILED_ATTEMPTS", CLAIM_CODE_MAX_FAILED_ATTEMPTS, 1, CLAIM_CODE_MAX_FAILED_ATTEMPTS),
    profileWindowHours: intEnv(env, "CLAIM_CODE_PROFILE_WINDOW_HOURS", CLAIM_CODE_PROFILE_WINDOW_HOURS, CLAIM_CODE_PROFILE_WINDOW_HOURS, 7 * 24),
    codeSendsPerHourMax: intEnv(env, "CLAIM_CODE_SENDS_PER_HOUR_MAX", CLAIM_CODE_SENDS_PER_HOUR_MAX, 1, 100),
    reviewOpenPerProfileMax: intEnv(env, "CLAIM_REVIEW_OPEN_PER_PROFILE_MAX", CLAIM_REVIEW_OPEN_PER_PROFILE_MAX, 1, 20),
    reviewInsertsPerHourMax: intEnv(env, "CLAIM_REVIEW_INSERTS_PER_HOUR_MAX", CLAIM_REVIEW_INSERTS_PER_HOUR_MAX, 1, 200),
  };
}

/** Why a claim waits in the admin queue (agent_claims.review_reason). */
export type ClaimReviewReason = "no_known_email" | "listed_email_wrong" | "has_owner";

/** Which limit refused a request: a code send (rule 4 / the platform cap) or
 *  a new admin-queue entry (per profile / the platform cap). */
export type ClaimRateLimitScope = "profile" | "platform" | "review_profile" | "review_platform";

/** Which rule sent a code: rule 1 (the farm's own e-mail) or the domain
 *  rule's P1/P2 (the claimant's own address; claim-domain-rule.ts). */
export type ClaimCodeRoute = "farm_email" | "domain_match_independent" | "domain_code_sent";

/** What the claim domain rule (claim-domain-rule.ts) makes of a claim:
 *  the recommendation for a queue row, and whether P1 applies or P2 could
 *  (P2 still needs the HTTPS probe). */
export interface ClaimDomainAssessment {
  recommendation: ClaimRecommendation;
  route: "p1" | "p2_candidate" | null;
  /** The claimant's e-mail domain, normalized (null: invalid). */
  domain: string | null;
}

export type ClaimRequestResult =
  | { kind: "code_sent"; claimId: string; verificationCode: string; recipient: string; via: ClaimCodeRoute }
  /** `created` is false when the claimant's own open entry is returned. */
  | { kind: "queued"; claimId: string; reason: ClaimReviewReason; created: boolean }
  | { kind: "rate_limited"; scope: ClaimRateLimitScope }
  /** The address is this profile's owner's own: log in by e-mail instead. */
  | { kind: "already_owner" };

export interface ClaimReviewEntry {
  claim_id: string;
  agent_id: string;
  agent_name: string | null;
  /** The profile's listed contact e-mail now (public). */
  listed_email: string | null;
  claimant_name: string;
  claimant_email: string;
  claimant_phone: string | null;
  reason: ClaimReviewReason;
  /** The claim domain rule's advice (claim-domain-rule.ts); null on rows
   *  queued before the rule existed. */
  recommendation: ClaimRecommendation | null;
  /** Set only when the claimant entered the right code sent to this farm address
   *  and the claim was queued because the profile got an owner meanwhile. */
  proven_email: string | null;
  /** 1 when the profile has an owner now (customer rule). */
  has_owner: number;
  source: string | null;
  created_at: string;
}

/** One plausible address and nothing else (a listed field can hold two
 *  addresses or prose). A shape check, not RFC validation: delivery is what
 *  proves an address. Linear on any input: the length is checked first, and
 *  the domain labels exclude the dot, so each character has one place in the
 *  pattern (a domain class that also took '.' backtracked quadratically —
 *  "a@" + "."×200k held the event loop for ~24 s). */
export function isSingleEmailAddress(value: string): boolean {
  return value.length <= EMAIL_ADDRESS_MAX_LENGTH &&
    /^[^\s@,;:<>()]+@[^\s@,;:<>().]+(?:\.[^\s@,;:<>().]+)+$/.test(value);
}

/** Constant-time compare of the stored code with the one entered. */
function claimCodeMatches(stored: unknown, entered: unknown): boolean {
  const given = typeof entered === "number" ? String(entered) : entered;
  if (typeof stored !== "string" || typeof given !== "string") return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(given.trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class KnowledgeService {

  // ─── Get knowledge for an agent ──────────────────────────
  // Integration test 2026-10-17 (I-F): a JSON column that does not parse is
  // read as empty and logged (jsonColumn), so one bad row no longer throws out
  // of lokal_info, a whole lokal_search answer or llms-full.txt.
  getKnowledge(agentId: string): AgentKnowledge | null {
    const row = this.selectKnowledgeRow(agentId);
    return row ? this.rowToKnowledge(row, "lenient") : null;
  }

  private selectKnowledgeRow(agentId: string): any {
    return getDb().prepare(`SELECT agent_id, address, postal_code, website, phone, email,
      opening_hours, products, about, specialties, certifications, payment_methods,
      delivery_options, google_rating, google_review_count, tripadvisor_rating,
      external_reviews, external_links, images, seasonality, delivery_radius, min_order_value,
      data_source, auto_sources, last_enriched_at,
      owner_updated_at, preferences, curated_fields FROM agent_knowledge WHERE agent_id = ?`).get(agentId);
  }

  // ─── Get structured info response for buyer agents ────────
  // This is the main endpoint buyers use: "tell me about this seller"
  //
  // dev-request 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-
  // treffvakt (S4-A1a): A2A agent/info, GET /agents/:id/info, the MCP resource
  // lokal://producers/{id} and the knowledge PUT hand this object on as it
  // is, so it carries no Google rating. Google's Places terms call passing a
  // stored rating on "reshare" (protocols/juridisk-sjekk-google-ratinger-
  // 2026-10-17.md §4.2). Only the site's own pages ask for it with
  // withGoogleRating, and RATING_DISPLAY_MODE (structured-data-policy.ts)
  // decides whether they show it.
  getAgentInfo(agentId: string, opts: { withGoogleRating?: boolean } = {}): AgentInfoResponse | null {
    const db = getDb();
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
    if (!agent) return null;

    const knowledge = this.getKnowledge(agentId);
    const isClaimed = this.isAgentClaimed(agentId);

    const dataSource = knowledge?.dataSource || "auto";
    const lastUpdated = knowledge?.ownerUpdatedAt || knowledge?.lastEnrichedAt || agent.created_at;

    // PR-95: debio_verified is set by the daily finnoko.debio.no sync
    // service. Older databases pre-migration may not have the column —
    // treat absence/NULL as 0.
    const debioVerified =
      agent.debio_verified === 1 || agent.debio_verified === "1";

    return {
      agent: {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        city: agent.city,
        trustScore: agent.trust_score,
        isVerified: agent.is_verified === 1,
        isClaimed,
        languages: textEntries(this.jsonColumn(agentId, "agents.languages", agent.languages, ["no"], "lenient")),
        schemaVersion: agent.schema_version || "urn:a2a:1.0",
        agentVersion: agent.agent_version || 1,
        debioVerified,
      },
      knowledge: {
        address: knowledge?.address,
        postalCode: knowledge?.postalCode,
        website: knowledge?.website,
        // wrong_contact_rate guardrail: this feeds the public buyer-facing
        // "tell me about this seller" endpoint — never return an invalid phone.
        phone: isDisplayablePhone(knowledge?.phone) ? knowledge?.phone : undefined,
        email: knowledge?.email,
        // I-F: each JSON field in the shape its type declares — see
        // openingHoursField and the helpers above the class.
        openingHours: openingHoursField(knowledge?.openingHours),
        products: productEntries(knowledge?.products),
        // dev-request 2026-07-04-rfb-datakvalitet item 1 (description
        // sanitizer, render-guard-only slice): mirrors the isDisplayablePhone
        // guard above — this feeds the public buyer-facing "tell me about
        // this seller" endpoints (GET /agents/:id/info, MCP lokal_info),
        // so scraped nav/boilerplate junk (e.g. "Skip to content ... Meny")
        // must never be returned as if it were a real description/about text.
        about: this.guardedDescriptionField(agentId, agent.name, "knowledge.about", knowledge?.about),
        description: this.guardedDescriptionField(agentId, agent.name, "agent.description", agent.description),
        specialties: textEntries(knowledge?.specialties),
        // PR-95: rewrite certifications to reflect debio_verified flag.
        certifications: relabelCertifications(knowledge?.certifications, debioVerified),
        paymentMethods: textEntries(knowledge?.paymentMethods),
        deliveryOptions: textEntries(knowledge?.deliveryOptions),
        images: textEntries(knowledge?.images),
        seasonality: recordEntries(knowledge?.seasonality) as SeasonalProduct[],
        deliveryRadius: knowledge?.deliveryRadius,
        minOrderValue: knowledge?.minOrderValue,
        ratings: this.buildRatings(knowledge),
        ...(opts.withGoogleRating
          ? { googleRating: knowledge?.googleRating, googleReviewCount: knowledge?.googleReviewCount }
          : {}),
      },
      meta: {
        dataSource,
        autoSources: textEntries(knowledge?.autoSources),
        lastUpdated,
        disclaimer: dataSource === "owner"
          ? "Denne informasjonen er verifisert av eieren."
          : "Denne informasjonen er basert på offentlig tilgjengelige kilder og kan være utdatert. Kontakt selger direkte for oppdatert informasjon.",
      },
    };
  }

  // Render-time junk guard for getAgentInfo's `about`/`description` fields
  // (dev-request 2026-07-04-rfb-datakvalitet item 1). Returns the raw text
  // unchanged when it passes the heuristic; returns "" and logs a low-noise
  // diagnostic when it doesn't — never a silent catch-and-null, same
  // convention as every other suppression path in this codebase.
  private guardedDescriptionField(agentId: string, agentName: string, fieldLabel: string, raw: string | null | undefined): string {
    const value = raw || "";
    if (value && isJunkDescription(value)) {
      console.log(`[description-guard] suppressed junk ${fieldLabel} (getAgentInfo) for ${agentId} (${agentName})`);
      return "";
    }
    // Strip an enrichment routine's own working note appended to real prose
    // (Daniel 2026-09-03) — the note goes, the producer's prose stays. A
    // note-ONLY value never reaches here: isJunkDescription above reports it.
    return normalizeProse(value);
  }

  // ─── Normalize products before storage ─────────────────
  // Extracts prices embedded in product names and moves them to the price field.
  // This handles data from sellers who paste AI-extracted product lists.
  private normalizeProducts(products: ProductInfo[]): ProductInfo[] {
    if (!products?.length) return products;
    // I-G: what the map below cannot read is refused with a field error
    // (productsWriteError) instead of a TypeError, before anything is written.
    const fieldError = productsWriteError(products);
    if (fieldError) throw fieldError;
    return products.map(p => {
      const name = (p.name || "").trim();
      if (!name) return p;
      // Skip if price field already has a numeric value
      if (p.price && /\d/.test(p.price)) return p;
      // Skip section headers and noise
      if (isProductHeader(name) || isProductNoise(name)) return p;

      const { cleanName, price } = parseProductPrice(p);
      if (price && cleanName !== name) {
        return { ...p, name: cleanName, price, priceUnit: p.priceUnit || "kr" };
      }
      return p;
    });
  }

  // ─── Set/update knowledge (used by enrichment + owner) ────
  upsertKnowledge(agentId: string, data: Partial<AgentKnowledge>, opts: UpsertKnowledgeOptions = {}): UpsertKnowledgeResult {
    const db = getDb();
    const skipped: SkippedKnowledgeField[] = [];
    // I-F: the merge base is read strictly. The merge below writes every
    // column back, so a lenient read would replace a column that does not
    // parse with its empty value. Such a row still fails the write, as
    // before — this change repairs no data.
    const existingRow = this.selectKnowledgeRow(agentId);
    const existing = existingRow ? this.rowToKnowledge(existingRow, "strict") : null;
    const now = new Date().toISOString();

    // Owner lock (OWNER_LOCK_ENFORCE_WRITES, default off): drop owner-locked
    // fields from a non-owner write before anything below sees them.
    if (existingRow && !opts.ownerPath && ownerLockEnforcedForWrites()) {
      const locks = this.parseCuratedFields((existingRow as { curated_fields?: string | null }).curated_fields);
      const kept: Partial<AgentKnowledge> = { ...data };
      for (const [prop, key] of Object.entries(LOCKABLE_FIELD_KEYS)) {
        if ((data as Record<string, unknown>)[prop] === undefined) continue;
        if (locks[key]?.by === "owner") {
          delete (kept as Record<string, unknown>)[prop];
          skipped.push({ field: key, reason: "owner_locked" });
        }
      }
      data = kept;
    }

    // Write-time contact guard (dev-request 2026-07-28-rfb-kontaktekstraksjon-orgnr-som-telefon,
    // slice 1). Validate the INCOMING `data` before it participates in either
    // the INSERT or the UPDATE/merge branch below — so a rejected/cleaned
    // value never gets merged in ahead of `existing`'s good value. Only
    // guards NEW incoming data; `existing` is never touched here.
    if (data.phone) {
      const agentRow = db.prepare("SELECT org_nr FROM agents WHERE id = ?").get(agentId) as { org_nr?: string } | undefined;
      const validatedPhone = validatePhoneForWrite(data.phone, agentRow?.org_nr ?? null);
      if (validatedPhone === null) {
        console.log(`[contact-write-guard] agent ${agentId}: rejected phone write, field left blank`);
      }
      data = { ...data, phone: validatedPhone ?? undefined };
    }
    if (data.address) {
      // dev-request 2026-08-10-verifier-portkjede-og-provenansrydding (slice
      // D): strip a LEADING label/company-name-box run first (e.g. "Kontakt
      // Oceanfood AS ..."), then the existing trailing-label strip — the two
      // are independent (a value could in principle carry both) and neither
      // depends on the other's output shape.
      data = { ...data, address: stripTrailingContactLabel(stripLeadingContactLabel(data.address)) ?? undefined };
    }

    // Normalize products: extract prices from name field before storage
    if (data.products?.length) {
      data = { ...data, products: this.normalizeProducts(data.products) };
    }

    if (!existing) {
      db.prepare(`
        INSERT INTO agent_knowledge (
          agent_id, address, postal_code, website, phone, email,
          opening_hours, products, about, specialties, certifications,
          payment_methods, delivery_options, google_rating, google_review_count,
          tripadvisor_rating, external_reviews, external_links, images,
          seasonality, delivery_radius, min_order_value,
          data_source, auto_sources, last_enriched_at, preferences,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        agentId,
        data.address || null,
        data.postalCode || null,
        data.website || null,
        data.phone || null,
        data.email || null,
        JSON.stringify(data.openingHours || []),
        JSON.stringify(data.products || []),
        data.about || null,
        JSON.stringify(data.specialties || []),
        JSON.stringify(data.certifications || []),
        JSON.stringify(data.paymentMethods || []),
        JSON.stringify(data.deliveryOptions || []),
        data.googleRating || null,
        data.googleReviewCount || null,
        data.tripadvisorRating || null,
        JSON.stringify(data.externalReviews || []),
        JSON.stringify(data.externalLinks || []),
        JSON.stringify(data.images || []),
        JSON.stringify(data.seasonality || []),
        data.deliveryRadius || null,
        data.minOrderValue || null,
        data.dataSource || "auto",
        JSON.stringify(data.autoSources || []),
        now,
        JSON.stringify(data.preferences || {}),
        now, now,
      );
    } else {
      // Merge: owner data takes precedence over auto data
      const merged = this.mergeKnowledge(existing, data);
      const isOwnerUpdate = data.dataSource === "owner";

      db.prepare(`
        UPDATE agent_knowledge SET
          address = ?, postal_code = ?, website = ?, phone = ?, email = ?,
          opening_hours = ?, products = ?, about = ?, specialties = ?,
          certifications = ?, payment_methods = ?, delivery_options = ?,
          google_rating = ?, google_review_count = ?, tripadvisor_rating = ?,
          external_reviews = ?, external_links = ?, images = ?,
          seasonality = ?, delivery_radius = ?, min_order_value = ?,
          data_source = ?,
          auto_sources = ?,
          last_enriched_at = CASE WHEN ? = 'auto' THEN ? ELSE last_enriched_at END,
          owner_updated_at = CASE WHEN ? = 'owner' THEN ? ELSE owner_updated_at END,
          preferences = ?,
          updated_at = ?
        WHERE agent_id = ?
      `).run(
        merged.address || null,
        merged.postalCode || null,
        merged.website || null,
        merged.phone || null,
        merged.email || null,
        JSON.stringify(merged.openingHours || []),
        JSON.stringify(merged.products || []),
        merged.about || null,
        JSON.stringify(merged.specialties || []),
        JSON.stringify(merged.certifications || []),
        JSON.stringify(merged.paymentMethods || []),
        JSON.stringify(merged.deliveryOptions || []),
        merged.googleRating || null,
        merged.googleReviewCount || null,
        merged.tripadvisorRating || null,
        JSON.stringify(merged.externalReviews || []),
        JSON.stringify(merged.externalLinks || []),
        JSON.stringify(merged.images || []),
        JSON.stringify(merged.seasonality || []),
        merged.deliveryRadius || null,
        merged.minOrderValue || null,
        isOwnerUpdate ? (existing.dataSource === "auto" ? "hybrid" : "owner") : merged.dataSource,
        JSON.stringify(merged.autoSources || []),
        data.dataSource || "auto", now,
        data.dataSource || "auto", now,
        JSON.stringify(merged.preferences || {}),
        now,
        agentId,
      );
    }

    // Auto-increment agent_version on every knowledge change (A2A spec compliance)
    try {
      db.prepare(`UPDATE agents SET agent_version = COALESCE(agent_version, 0) + 1 WHERE id = ?`).run(agentId);
    } catch {
      // Column may not exist yet on older DBs — safe to skip
    }
    return { skipped };
  }

  // ─── Owner update (after claiming) ──────────────────────
  // The owner path: the only caller that may change owner-locked fields.
  ownerUpdate(agentId: string, data: Partial<AgentKnowledge>): void {
    this.upsertKnowledge(agentId, { ...data, dataSource: "owner" }, { ownerPath: true });
  }

  // ─── Bulk enrich from auto sources ─────────────────────
  bulkEnrich(enrichments: Array<{ agentId: string; data: Partial<AgentKnowledge> }>): number {
    const db = getDb();
    let count = 0;
    const transaction = db.transaction(() => {
      for (const { agentId, data } of enrichments) {
        try {
          this.upsertKnowledge(agentId, { ...data, dataSource: "auto" });
          count++;
        } catch (e) {
          console.error(`Failed to enrich agent ${agentId}:`, e);
        }
      }
    });
    transaction();
    return count;
  }

  // ─── Claim system ──────────────────────────────────────
  // Who may become a profile's owner: decision 11=A, see the block above the
  // class (CLAIM_CODE_* constants).

  isAgentClaimed(agentId: string): boolean {
    const db = getDb();
    const row = db.prepare(
      "SELECT COUNT(*) as c FROM agent_claims WHERE agent_id = ? AND status = 'verified'"
    ).get(agentId) as any;
    return row.c > 0;
  }

  /** Rule 3's "already has an owner": the shared customer rule (claimed_at
   *  set, or a verified claim) — one definition, services/customer-rule.ts. */
  private agentHasOwner(agentId: string): boolean {
    const row = getDb().prepare(`SELECT ${customerRuleSql("a")} AS owned FROM agents a WHERE a.id = ?`)
      .get(agentId) as { owned: number } | undefined;
    return !!row?.owned;
  }

  /**
   * The farm's own e-mail — the only address a claim code may go to (rule 1).
   * In this order:
   *   (a) the contact e-mail listed on the profile (agent_knowledge.email, the
   *       one shown publicly);
   *   (b) else an address the platform delivered e-mail to for this profile
   *       without a bounce: outreach_sent_log for the agent_id and no
   *       email_bounces row — the RFB twin of wasEpostDeliveredOutreachNoBounce()
   *       in gardssalg-claim.ts.
   * Never an address derived from a domain (Daniel 2026-08-06: never guess an
   * e-mail address). null → the claim goes to the admin queue. Returned
   * normalized (trim + lower case) like createMagicLink's lookup, so the
   * owner's e-mail login reaches the same inbox.
   */
  resolveFarmContactEmail(agentId: string): string | null {
    const db = getDb();
    const listed = db.prepare("SELECT email FROM agent_knowledge WHERE agent_id = ?").get(agentId) as
      { email: string | null } | undefined;
    const listedEmail = normalizeEmail(listed?.email);
    if (isSingleEmailAddress(listedEmail)) return listedEmail;
    try {
      const delivered = db.prepare(
        `SELECT LOWER(TRIM(o.recipient_email)) AS email
           FROM outreach_sent_log o
          WHERE o.agent_id = ? AND o.vertical_id = 'rfb' AND o.recipient_email IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM email_bounces b WHERE LOWER(TRIM(b.email)) = LOWER(TRIM(o.recipient_email))
                            AND (b.bounce_type IS NULL OR b.bounce_type <> 'unsubscribe'))
          ORDER BY o.sent_at DESC, o.id DESC`
      ).all(agentId) as Array<{ email: string }>;
      return delivered.map((r) => r.email).find(isSingleEmailAddress) ?? null;
    } catch (err) {
      // Fails closed: no farm address proven → admin queue, never a code.
      console.warn(`[claim] delivered-outreach lookup failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * The host of the profile's website when it comes from an INDEPENDENT
   * source — the only website the domain rule's P1 trusts (dev-request
   * 2026-10-27-rfb-eierkrav-domeneregel-og-cs-sjekkliste). agent_knowledge has
   * no per-field provenance for `website`, so independence is read from what
   * the row does record, and every doubt answers null (→ not P1):
   *   - agents.origin is not 'self_registered' (a self-registration's website
   *     and e-mail come from the same person who claims);
   *   - agent_knowledge.data_source = 'auto' and owner_updated_at IS NULL: no
   *     owner-path write ever touched the row (ownerUpdate, an API-key/claim-
   *     token PUT, or an admin PUT relaying the owner with dataSource "owner"
   *     all set 'owner'/'hybrid' and owner_updated_at);
   *   - no curated_fields.website lock (a customer-requested value is the
   *     owner's word, relayed by CS), and curated_fields parses;
   *   - field_provenance parses and website_ownership is not 'unverified'
   *     (the homepage crawl found the page does not name the producer);
   *   - the value parses to a public host that is not a hosting/social
   *     platform (gard.wixsite.com, facebook.com/…).
   * agents.url is not used: it is what a registration or discovery row was
   * created with, with no record of who supplied it.
   */
  independentWebsiteHost(agentId: string): string | null {
    const row = getDb().prepare(
      `SELECT a.origin, k.website, k.data_source, k.owner_updated_at, k.curated_fields, k.field_provenance
         FROM agents a JOIN agent_knowledge k ON k.agent_id = a.id WHERE a.id = ?`
    ).get(agentId) as {
      origin: string | null; website: string | null; data_source: string | null; owner_updated_at: string | null;
      curated_fields: string | null; field_provenance: string | null;
    } | undefined;
    if (!row || row.origin === "self_registered") return null;
    if (row.data_source !== "auto" || row.owner_updated_at) return null;
    const parseObj = (raw: string | null): Record<string, unknown> | null => {
      if (raw === null || raw === undefined || raw === "") return {};
      try {
        const v = JSON.parse(raw);
        return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    };
    const curated = parseObj(row.curated_fields);
    if (!curated || curated.website !== undefined) return null;
    const prov = parseObj(row.field_provenance);
    if (!prov) return null;
    const wo = prov.website_ownership;
    if (wo && typeof wo === "object" && (wo as Record<string, unknown>).status === "unverified") return null;
    const host = websiteHost(row.website);
    if (!host || isHostedPlatformHost(host)) return null;
    return host;
  }

  /**
   * What the claim domain rule makes of a claim (claim-domain-rule.ts). Pure
   * reading, no network: P2 is only a candidate here — the HTTPS probe is
   * the caller's (requestClaimWithDomainRule).
   *   has_owner              the profile has an owner (P4);
   *   free_mail_needs_extra  the address's domain is free-mail or invalid (P3);
   *   domain_match_independent  the domain is the independent website's (P1);
   *   needs_review           the profile has an independent website on
   *                          another domain — no P2 then;
   *   otherwise a P2 candidate (no independent website).
   */
  assessClaimDomain(agentId: string, claimantEmail: string, hasOwner = this.agentHasOwner(agentId)): ClaimDomainAssessment {
    const domain = emailDomain(normalizeEmail(claimantEmail));
    if (hasOwner) return { recommendation: "has_owner", route: null, domain };
    if (!domain || isFreeMailDomain(domain)) return { recommendation: "free_mail_needs_extra", route: null, domain };
    const site = this.independentWebsiteHost(agentId);
    if (site) {
      return emailDomainMatchesWebsite(domain, site)
        ? { recommendation: "domain_match_independent", route: "p1", domain }
        : { recommendation: "needs_review", route: null, domain };
    }
    return { recommendation: "needs_review", route: "p2_candidate", domain };
  }

  /**
   * requestClaim behind the claim domain rule's kill switch
   * (CLAIM_DOMAIN_RULE_ENABLED, default off). Off: requestClaim as before —
   * no probe, only the queue row's `recommendation`. On: when the profile has
   * no known farm e-mail and no owner and the claim is a P2 candidate, the
   * HTTPS probe runs first (outside the DB transaction); a false, a throw or
   * a timeout leaves the claim on its way to the queue. requestClaim checks
   * everything else again inside its transaction.
   */
  async requestClaimWithDomainRule(
    agentId: string,
    opts: Parameters<KnowledgeService["requestClaim"]>[1],
    deps: { env?: NodeJS.ProcessEnv; httpsCheck?: DomainHttpsCheck } = {},
  ): Promise<ClaimRequestResult> {
    if (!claimDomainRuleEnabled(deps.env ?? process.env)) return this.requestClaim(agentId, opts);
    let httpsAnswered = false;
    const hasOwner = this.agentHasOwner(agentId);
    if (!hasOwner && !this.resolveFarmContactEmail(agentId)) {
      const pre = this.assessClaimDomain(agentId, opts.claimantEmail, hasOwner);
      if (pre.route === "p2_candidate" && pre.domain && this.claimCodeSlotFree(agentId)) {
        try {
          httpsAnswered = (await (deps.httpsCheck ?? getDomainHttpsCheck())(pre.domain)) === true;
        } catch (err) {
          console.warn(`[claim-domain-rule] HTTPS check failed for ${pre.domain}: ${err instanceof Error ? err.message : String(err)}`);
          httpsAnswered = false;
        }
      }
    }
    return this.requestClaim(agentId, { ...opts, domainRule: { httpsAnswered } });
  }

  /** Would a code send on this profile pass rule 4 and the platform cap now?
   *  Only spares the HTTPS probe when it would be refused anyway; requestClaim
   *  decides. */
  private claimCodeSlotFree(agentId: string): boolean {
    const db = getDb();
    const limits = claimLimits();
    const since = (where: string, hours: number, ...params: unknown[]): number => (db.prepare(
      `SELECT COUNT(*) AS n FROM agent_claims
        WHERE ${where} AND datetime(created_at) >= datetime('now', '-' || ? || ' hours')`
    ).get(...params, hours) as { n: number }).n;
    return since("agent_id = ? AND code_sent_to IS NOT NULL", limits.profileWindowHours, agentId) < 1 &&
      since("code_sent_to IS NOT NULL", 1) < limits.codeSendsPerHourMax;
  }

  /**
   * A claim request under decision 11=A:
   *   - "already_owner": the address is the owner's own (as before): that
   *     owner logs in by e-mail instead;
   *   - "queued": the claim waits in the admin queue (rule 2 or 3); one open
   *     entry per claimant and profile, a repeat returns it;
   *   - "rate_limited": nothing is written — a code went to this profile in
   *     the window (rule 4) or the platform's hourly code cap is reached, or,
   *     for a new queue entry, the profile's open entries or the platform's
   *     hourly entries are at their cap (claimLimits);
   *   - "code_sent": a new code for `recipient`, the farm's own address. The
   *     caller sends it; if that fails it calls markClaimCodeUnsent().
   */
  requestClaim(agentId: string, opts: {
    claimantName: string;
    claimantEmail: string;
    claimantPhone?: string;
    source?: string;
    /** The claimant says the profile's listed address is wrong or outdated. */
    listedEmailWrong?: boolean;
    /** Set only with CLAIM_DOMAIN_RULE_ENABLED on (requestClaimWithDomainRule):
     *  P1/P2 may send the code to the claimant's own address. `httpsAnswered`
     *  is the HTTPS probe's answer for the claimant's domain (P2). */
    domainRule?: { httpsAnswered: boolean };
  }): ClaimRequestResult {
    const db = getDb();
    const claimantEmail = normalizeEmail(opts.claimantEmail);
    const limits = claimLimits();
    // Claims matching `where` created in the last `hours`. created_at is
    // ISO-8601 ("…T…Z") while datetime('now', …) is "… …", so both go through
    // datetime() — a bare string compare would count the whole UTC day (see
    // isClaimRateLimited in gardssalg-claim.ts). Each `where` is its own
    // prepared statement, so the per-profile ones use the agent_id index.
    const createdSince = (where: string, hours: number, ...params: unknown[]): number => (db.prepare(
      `SELECT COUNT(*) AS n FROM agent_claims
        WHERE ${where} AND datetime(created_at) >= datetime('now', '-' || ? || ' hours')`
    ).get(...params, hours) as { n: number }).n;
    return db.transaction((): ClaimRequestResult => {
      // Check if this specific email already has a verified claim on this agent
      const existingClaim = db.prepare(
        "SELECT COUNT(*) as c FROM agent_claims WHERE agent_id = ? AND LOWER(TRIM(claimant_email)) = ? AND status = 'verified'"
      ).get(agentId, claimantEmail) as any;
      if (existingClaim.c > 0) return { kind: "already_owner" };

      const farmEmail = this.resolveFarmContactEmail(agentId);
      const hasOwner = this.agentHasOwner(agentId);
      const now = new Date().toISOString();

      // The claim domain rule (claim-domain-rule.ts): only where the claim
      // would otherwise wait as no_known_email, and only with the flag on.
      const assessment = this.assessClaimDomain(agentId, claimantEmail, hasOwner);
      let domainRoute: "domain_match_independent" | "domain_code_sent" | null = null;
      if (opts.domainRule && !hasOwner && !farmEmail) {
        if (assessment.route === "p1") domainRoute = "domain_match_independent";
        else if (assessment.route === "p2_candidate" && opts.domainRule.httpsAnswered === true) domainRoute = "domain_code_sent";
      }

      if (!domainRoute && (hasOwner || !farmEmail || opts.listedEmailWrong)) {
        const reason: ClaimReviewReason = hasOwner ? "has_owner" : !farmEmail ? "no_known_email" : "listed_email_wrong";
        const recommendation: ClaimRecommendation = assessment.recommendation;
        const open = db.prepare(
          "SELECT id, review_reason FROM agent_claims WHERE agent_id = ? AND LOWER(TRIM(claimant_email)) = ? AND status = 'pending_review' LIMIT 1"
        ).get(agentId, claimantEmail) as { id: string; review_reason: ClaimReviewReason } | undefined;
        if (open) return { kind: "queued", claimId: open.id, reason: open.review_reason, created: false };
        // Bounds that do not depend on the client's IP: open entries on this
        // profile, and new entries platform-wide in the last hour (every
        // entry has review_reason, also one queued at verify time).
        const openOnProfile = (db.prepare(
          "SELECT COUNT(*) AS n FROM agent_claims WHERE agent_id = ? AND status = 'pending_review'"
        ).get(agentId) as { n: number }).n;
        if (openOnProfile >= limits.reviewOpenPerProfileMax) return { kind: "rate_limited", scope: "review_profile" };
        if (createdSince("review_reason IS NOT NULL", 1) >= limits.reviewInsertsPerHourMax) {
          return { kind: "rate_limited", scope: "review_platform" };
        }
        const id = uuid();
        db.prepare(`
          INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, claimant_phone, verification_method, status, review_reason, source, created_at, recommendation)
          VALUES (?, ?, ?, ?, ?, 'manual', 'pending_review', ?, ?, ?, ?)
        `).run(id, agentId, opts.claimantName, claimantEmail, opts.claimantPhone || null, reason, opts.source || 'organic', now, recommendation);
        return { kind: "queued", claimId: id, reason, created: true };
      }

      // Rule 4 and the platform cap count code sends (code_sent_to set).
      if (createdSince("agent_id = ? AND code_sent_to IS NOT NULL", limits.profileWindowHours, agentId) >= 1) {
        return { kind: "rate_limited", scope: "profile" };
      }
      if (createdSince("code_sent_to IS NOT NULL", 1) >= limits.codeSendsPerHourMax) return { kind: "rate_limited", scope: "platform" };

      // A new code replaces the previous one. Open codes used to be DELETEd
      // here; now they are marked. Rows from before this rule (no
      // code_sent_to) are left as they are — verifyClaim refuses them.
      db.prepare(
        "UPDATE agent_claims SET status = 'superseded' WHERE agent_id = ? AND status = 'code_sent' AND code_sent_to IS NOT NULL"
      ).run(agentId);

      // Rule 1: the farm's own address. P1/P2: the claimant's own address —
      // whoever enters the code proves that mailbox (recommendation records
      // which rule sent it; grantClaimOwnership reads it for P2).
      const recipient = domainRoute ? claimantEmail : farmEmail!;
      const id = uuid();
      const code = this.generateVerificationCode();
      const expiresAt = new Date(Date.now() + CLAIM_CODE_VALID_HOURS * 60 * 60 * 1000).toISOString();
      db.prepare(`
        INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, claimant_phone, verification_method, verification_code, status, source, expires_at, created_at, code_sent_to, failed_attempts, recommendation)
        VALUES (?, ?, ?, ?, ?, 'email', ?, 'code_sent', ?, ?, ?, ?, 0, ?)
      `).run(id, agentId, opts.claimantName, claimantEmail, opts.claimantPhone || null, code, opts.source || 'organic', expiresAt, now, recipient, domainRoute);
      return { kind: "code_sent", claimId: id, verificationCode: code, recipient, via: domainRoute ?? "farm_email" };
    })();
  }

  /** The code e-mail was not sent: the claim is expired and gives its place
   *  in the per-profile and platform counts back (no code reached anyone). */
  markClaimCodeUnsent(claimId: string): void {
    getDb().prepare(
      "UPDATE agent_claims SET status = 'expired', code_sent_to = NULL WHERE id = ? AND status = 'code_sent'"
    ).run(claimId);
  }

  verifyClaim(claimId: string, code: unknown, agentId: string): { success: boolean; claimToken?: string; error?: string; status?: string; queued?: boolean } {
    const db = getDb();
    const claim = db.prepare("SELECT * FROM agent_claims WHERE id = ?").get(claimId) as any;

    // A claim on another profile is answered exactly like an unknown one.
    if (!claim || claim.agent_id !== agentId) return { success: false, error: "Claim not found" };
    if (claim.status === "verified") return { success: false, error: "Already verified" };
    if (claim.status === "pending_review") {
      return { success: false, status: "pending_review", error: "Kravet venter på manuell godkjenning." };
    }
    if (claim.status === "expired" || claim.status === "rejected" || claim.status === "superseded") {
      return { success: false, error: `Claim is ${claim.status}` };
    }
    // A code from before decision 11=A went to whatever address the claimant
    // typed, so it is not accepted (the row itself is left as it is).
    if (!claim.code_sent_to) {
      return { success: false, error: "Koden er ikke lenger gyldig. Be om en ny kode." };
    }

    // Check expiry
    if (new Date(claim.expires_at) < new Date()) {
      db.prepare("UPDATE agent_claims SET status = 'expired' WHERE id = ?").run(claimId);
      return { success: false, error: "Claim has expired" };
    }

    // Verify code — the last allowed wrong one (claimLimits, 5) expires the
    // claim, so even the right code no longer works after that. The count is
    // raised in SQL, never from the value read above.
    if (!claimCodeMatches(claim.verification_code, code)) {
      db.prepare(
        `UPDATE agent_claims
            SET failed_attempts = COALESCE(failed_attempts, 0) + 1,
                status = CASE WHEN COALESCE(failed_attempts, 0) + 1 >= ? THEN 'expired' ELSE status END
          WHERE id = ? AND status = 'code_sent'`
      ).run(claimLimits().maxFailedAttempts, claimId);
      const after = db.prepare("SELECT status FROM agent_claims WHERE id = ?").get(claimId) as { status: string } | undefined;
      return after?.status === "expired"
        ? { success: false, error: "For mange feil koder. Kravet er utløpt – be om en ny kode." }
        : { success: false, error: "Invalid verification code" };
    }

    // Rule 3 holds at verify time too: if the profile got an owner after the
    // code was sent (an admin approval), the claim goes to the admin queue.
    // `queued` marks the move, so the caller tells the admin once.
    if (this.agentHasOwner(agentId)) {
      db.prepare("UPDATE agent_claims SET status = 'pending_review', review_reason = 'has_owner' WHERE id = ?").run(claimId);
      return { success: false, status: "pending_review", queued: true, error: "Profilen har fått en eier i mellomtiden. Kravet er sendt til manuell godkjenning." };
    }

    const claimToken = db.transaction(() => this.grantClaimOwnership(claim, claim.code_sent_to, "claim"))();
    return { success: true, claimToken };
  }

  /**
   * Makes a claim the profile's owner: status 'verified', a new 30-day claim
   * token, and claimant_email = `ownerEmail` — the farm address the code went
   * to, or the address Daniel approved — so e-mail login (createMagicLink)
   * reaches that inbox. The address the claimant typed is kept for audit in
   * claimant_email_typed. Shared by verifyClaim and approveClaimReview, so the
   * badge gate and the owner stamp below are the same on both paths.
   */
  private grantClaimOwnership(claim: { id: string; agent_id: string }, ownerEmail: string, claimedVia: "claim" | "admin_approval"): string {
    const db = getDb();
    const claimId = claim.id;
    // Success — generate claim token for future management (expires in 30 days)
    const claimToken = `claim_${crypto.randomBytes(32).toString("hex")}`;
    const now = new Date().toISOString();
    const tokenExpiry = new Date(Date.now() + CLAIM_TOKEN_VALID_MS).toISOString();

    // SET reads the row as it was, so claimant_email_typed gets the typed address.
    db.prepare(`
      UPDATE agent_claims SET status = 'verified', claim_token = ?, claim_token_expires_at = ?, verified_at = ?,
             claimant_email_typed = COALESCE(claimant_email_typed, claimant_email), claimant_email = ?
      WHERE id = ?
    `).run(claimToken, tokenExpiry, now, ownerEmail, claimId);

    // ─── dev-request 2026-08-03-mikhailo-quarantine-gates (Gate 2) ──────────
    // Mark agent as verified — EXCEPT when the agent's own registration is
    // the thing being "verified": a self_registered row (created via the
    // PUBLIC POST /register — anyone on the internet) was claimed through
    // this SAME code-based flow, so the claimant controls both ends (the
    // registration AND the "verification" email) and this UPDATE would hand
    // out a public trust badge on zero real evidence — exactly the Mikhailo
    // T incident (2026-07-30) this gate exists to close.
    //
    // The claim itself still fully succeeds above (status='verified',
    // claimToken issued, claimant CAN still manage the listing) — only the
    // public "Verifisert" badge is withheld for this origin.
    //
    // KNOWN, DELIBERATE LIMITATION: there is no automated Brreg/domain-
    // evidence escape hatch in this slice — a genuine small producer who
    // self-registers has no way to earn the badge today short of a human
    // (Daniel) manually flipping is_verified after reviewing the profile via
    // the self-registered-review-queue (routes/admin-agents.ts). No such
    // evidence-matching machinery exists for this generic marketplace-agents
    // table today (unlike e.g. the Brreg org-nr cross-check for discovery-
    // origin rows). This is a hard, unconditional gate, not a placeholder for
    // logic that secretly runs elsewhere.
    //
    // A discovery-origin (or any legacy/NULL-defaulted, pre-migration) row is
    // BYTE-IDENTICAL to pre-gate behaviour: the UPDATE below fires
    // unconditionally whenever origin !== 'self_registered'.
    //
    // Decision 11=A: an admin-approved claim (approveClaimReview) passes this
    // same gate — approving a claim does not give a self_registered row the badge.
    const claimedAgent = db.prepare("SELECT origin FROM agents WHERE id = ?").get(claim.agent_id) as
      { origin: string | null } | undefined;
    // Claim domain rule P2 (dev-request 2026-10-27-rfb-eierkrav-domeneregel-
    // og-cs-sjekkliste): the code proved a mailbox on a domain that answers
    // on HTTPS, nothing that ties that domain to this farm — so a P2 owner
    // never gets the badge, whatever the origin (a self_registered row would
    // not get it anyway). is_vetted is not touched here on any path.
    const viaRow = db.prepare("SELECT recommendation FROM agent_claims WHERE id = ?").get(claimId) as
      { recommendation: string | null } | undefined;
    const domainCodeOnly = claimedVia === "claim" && viaRow?.recommendation === "domain_code_sent";
    if (domainCodeOnly) {
      console.log(`[claim-verify:domain-rule] withheld is_verified badge for ${claim.agent_id}: P2 claim ${claimId} (domain answers on HTTPS, not tied to the profile)`);
    } else if (claimedAgent?.origin !== "self_registered") {
      db.prepare("UPDATE agents SET is_verified = 1 WHERE id = ?").run(claim.agent_id);
    } else {
      console.log(`[claim-verify:quarantine-gate] withheld is_verified badge for self_registered agent ${claim.agent_id} (claim ${claimId} still succeeded)`);
    }

    // ─── dev-request 2026-10-01-rfb-eierkrav-utelates-fra-outreach ──────────
    // Stamp agents.claimed_at/claimed_via so every reader of the owner lock
    // (outreach customer gate, contact-write guards, sweeps) sees the owner.
    // Fill-only: never overwrites an existing claimed_at/claimed_via (e.g. one
    // set by an earlier claim). Applies to self_registered rows too — the
    // ownership is real even though the public badge is withheld above.
    // agent_claims carries no user id, so claimed_by_user_id is left alone.
    // claimed_via is 'claim' for the code path, 'admin_approval' for a claim
    // Daniel approved from the admin queue (decision 11=A).
    db.prepare(`
      UPDATE agents
         SET claimed_at = ?, claimed_via = COALESCE(claimed_via, ?)
       WHERE id = ? AND claimed_at IS NULL
    `).run(now, claimedVia, claim.agent_id);

    // Update knowledge data_source
    const knowledge = this.getKnowledge(claim.agent_id);
    if (knowledge) {
      db.prepare("UPDATE agent_knowledge SET data_source = 'hybrid' WHERE agent_id = ? AND data_source = 'auto'")
        .run(claim.agent_id);
    }

    return claimToken;
  }

  // ─── Admin queue (decision 11=A, rules 2 and 3) ─────────────────────────
  // Read and decided through GET /admin/agents/claim-review-queue and POST
  // /admin/agents/claim-review-approve|-reject (routes/admin-agents.ts).

  /** Claims waiting for Daniel, oldest first: at most `limit` entries, and
   *  `total` waiting in all. */
  listClaimReviewQueue(limit: number = CLAIM_REVIEW_QUEUE_LIST_MAX): { total: number; entries: ClaimReviewEntry[] } {
    const db = getDb();
    const total = (db.prepare(
      "SELECT COUNT(*) AS n FROM agent_claims c JOIN agents a ON a.id = c.agent_id WHERE c.status = 'pending_review'"
    ).get() as { n: number }).n;
    const entries = db.prepare(`
      SELECT c.id AS claim_id, c.agent_id, a.name AS agent_name, k.email AS listed_email,
             c.claimant_name, c.claimant_email, c.claimant_phone, c.review_reason AS reason,
             c.recommendation, c.code_sent_to AS proven_email, ${customerRuleSql("a")} AS has_owner,
             c.source, c.created_at
        FROM agent_claims c
        JOIN agents a ON a.id = c.agent_id
        LEFT JOIN agent_knowledge k ON k.agent_id = c.agent_id
       WHERE c.status = 'pending_review'
       ORDER BY c.created_at ASC, c.id ASC
       LIMIT ?
    `).all(limit) as ClaimReviewEntry[];
    return { total, entries };
  }

  /**
   * Approves a queued claim: it becomes an owner (grantClaimOwnership — the
   * badge follows the quarantine gate, claimed_via = 'admin_approval') bound
   * to `approvedEmail`. When none is passed: the farm address the claimant
   * proved with the right code (proven_email — a claim queued at verify time
   * because the profile got an owner meanwhile), else the address the
   * claimant gave. An existing owner keeps its own claim and token. The
   * caller sends the login link to `email`.
   */
  approveClaimReview(claimId: string, approvedEmail?: string):
    | { ok: true; agentId: string; email: string; isVerified: boolean }
    | { ok: false; error: "not_found" | "not_pending_review" | "invalid_email" } {
    const db = getDb();
    const claim = db.prepare("SELECT id, agent_id, status, claimant_email, code_sent_to FROM agent_claims WHERE id = ?").get(claimId) as
      { id: string; agent_id: string; status: string; claimant_email: string; code_sent_to: string | null } | undefined;
    if (!claim || !db.prepare("SELECT 1 FROM agents WHERE id = ?").get(claim.agent_id)) return { ok: false, error: "not_found" };
    if (claim.status !== "pending_review") return { ok: false, error: "not_pending_review" };
    const email = normalizeEmail(approvedEmail ?? claim.code_sent_to ?? claim.claimant_email);
    if (!isSingleEmailAddress(email)) return { ok: false, error: "invalid_email" };
    db.transaction(() => {
      db.prepare("UPDATE agent_claims SET verification_method = 'manual' WHERE id = ?").run(claimId);
      this.grantClaimOwnership(claim, email, "admin_approval");
    })();
    const agent = db.prepare("SELECT is_verified FROM agents WHERE id = ?").get(claim.agent_id) as { is_verified: number } | undefined;
    return { ok: true, agentId: claim.agent_id, email, isVerified: agent?.is_verified === 1 };
  }

  /** Rejects a queued claim: status 'rejected' (with Daniel's note); the
   *  profile is not touched. */
  rejectClaimReview(claimId: string, note?: string):
    | { ok: true; agentId: string }
    | { ok: false; error: "not_found" | "not_pending_review" } {
    const db = getDb();
    const claim = db.prepare("SELECT agent_id, status FROM agent_claims WHERE id = ?").get(claimId) as
      { agent_id: string; status: string } | undefined;
    if (!claim) return { ok: false, error: "not_found" };
    if (claim.status !== "pending_review") return { ok: false, error: "not_pending_review" };
    db.prepare("UPDATE agent_claims SET status = 'rejected', notes = COALESCE(?, notes) WHERE id = ? AND status = 'pending_review'")
      .run(note ?? null, claimId);
    return { ok: true, agentId: claim.agent_id };
  }

  getClaimByToken(token: string): { agentId: string; claimantName: string; claimantEmail: string } | null {
    const db = getDb();
    const row = db.prepare(
      `SELECT agent_id, claimant_name, claimant_email, claim_token_expires_at
       FROM agent_claims WHERE claim_token = ? AND status = 'verified'`
    ).get(token) as any;
    if (!row) return null;

    // Reject expired tokens (null expires_at = legacy token, allow for now)
    if (row.claim_token_expires_at && new Date(row.claim_token_expires_at) < new Date()) {
      return null;
    }

    return { agentId: row.agent_id, claimantName: row.claimant_name, claimantEmail: row.claimant_email };
  }

  // ─── Resend claim token (lost login) ─────────────
  resendClaimToken(agentId: string, email: string): { success: boolean; claimToken?: string; error?: string } {
    const db = getDb();
    const claim = db.prepare(
      "SELECT * FROM agent_claims WHERE agent_id = ? AND status = 'verified' AND claimant_email = ?"
    ).get(agentId, email) as any;

    if (!claim) {
      return { success: false, error: "Ingen verifisert krav funnet for denne e-postadressen" };
    }

    const newToken = `claim_${crypto.randomBytes(32).toString("hex")}`;
    const tokenExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE agent_claims SET claim_token = ?, claim_token_expires_at = ? WHERE id = ?").run(newToken, tokenExpiry, claim.id);
    return { success: true, claimToken: newToken };
  }

  // ─── Magic Link Login ─────────────────────────────────

  createMagicLink(email: string): { success: boolean; token?: string; agentId?: string; agentName?: string; error?: string } {
    const db = getDb();

    // Find verified claim for this email
    const claim = db.prepare(
      `SELECT ac.agent_id, ac.claim_token, a.name as agent_name
       FROM agent_claims ac
       JOIN agents a ON a.id = ac.agent_id
       WHERE ac.claimant_email = ? AND ac.status = 'verified'
       ORDER BY ac.verified_at DESC LIMIT 1`
    ).get(email) as any;

    if (!claim) {
      return { success: false, error: "Ingen registrert agent funnet for denne e-postadressen" };
    }

    // Generate a secure magic link token (valid 15 min)
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const id = uuid();

    db.prepare(
      `INSERT INTO magic_links (id, email, token, agent_id, expires_at) VALUES (?, ?, ?, ?, ?)`
    ).run(id, email, token, claim.agent_id, expiresAt);

    return { success: true, token, agentId: claim.agent_id, agentName: claim.agent_name };
  }

  verifyMagicLink(token: string): { success: boolean; agentId?: string; claimToken?: string; claimantName?: string; email?: string; error?: string } {
    const db = getDb();

    const link = db.prepare(
      `SELECT ml.*, ac.claim_token, ac.claimant_name
       FROM magic_links ml
       JOIN agent_claims ac ON ac.agent_id = ml.agent_id AND ac.claimant_email = ml.email AND ac.status = 'verified'
       WHERE ml.token = ? AND ml.used = 0`
    ).get(token) as any;

    if (!link) {
      return { success: false, error: "Ugyldig eller brukt lenke" };
    }

    if (new Date(link.expires_at) < new Date()) {
      return { success: false, error: "Lenken har utløpt. Be om en ny." };
    }

    // Mark as used
    db.prepare(`UPDATE magic_links SET used = 1 WHERE token = ?`).run(token);

    // Clean up old magic links (older than 1 hour)
    // datetime(expires_at): expires_at is ISO (toISOString) — compare as dates,
    // not as strings against SQLite's space-separated format (S1b punkt 5).
    db.prepare(`DELETE FROM magic_links WHERE datetime(expires_at) < datetime('now', '-1 hour')`).run();

    // Refresh the claim token — extend expiry by 30 days on each successful login
    const crypto = require("crypto");
    const newToken = `claim_${crypto.randomBytes(32).toString("hex")}`;
    const newExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `UPDATE agent_claims SET claim_token = ?, claim_token_expires_at = ? WHERE agent_id = ? AND claimant_email = ? AND status = 'verified'`
    ).run(newToken, newExpiry, link.agent_id, link.email);

    return {
      success: true,
      agentId: link.agent_id,
      claimToken: newToken,
      claimantName: link.claimant_name,
      email: link.email,
    };
  }

  // ─── Stats ────────────────────────────────────────────

  getKnowledgeStats(): { total: number; enriched: number; claimed: number; autoOnly: number; ownerOrHybrid: number } {
    const db = getDb();
    const total = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as any).c;
    const enriched = (db.prepare("SELECT COUNT(*) as c FROM agent_knowledge").get() as any).c;
    const claimed = (db.prepare("SELECT COUNT(*) as c FROM agent_claims WHERE status = 'verified'").get() as any).c;
    const autoOnly = (db.prepare("SELECT COUNT(*) as c FROM agent_knowledge WHERE data_source = 'auto'").get() as any).c;
    const ownerOrHybrid = (db.prepare("SELECT COUNT(*) as c FROM agent_knowledge WHERE data_source IN ('owner','hybrid')").get() as any).c;

    return { total, enriched, claimed, autoOnly, ownerOrHybrid };
  }

  // ─── Private helpers ─────────────────────────────────────

  // Six digits from the crypto RNG (was Math.random(), finding
  // rfb-claim-kode-kan-gjettes).
  private generateVerificationCode(): string {
    return crypto.randomInt(100000, 1000000).toString();
  }

  private mergeKnowledge(existing: AgentKnowledge, update: Partial<AgentKnowledge>): AgentKnowledge {
    // Owner data always wins over auto data
    return {
      agentId: existing.agentId,
      address: update.address ?? existing.address,
      postalCode: update.postalCode ?? existing.postalCode,
      website: update.website ?? existing.website,
      phone: update.phone ?? existing.phone,
      email: update.email ?? existing.email,
      // Phase 5.4 follow-up (orchestrator-pr-3): explicit `[]` clears the field; `undefined` preserves existing.
      // Previous logic (`update.X?.length ? ...`) silently no-op'd owner-requested clears.
      openingHours: Array.isArray(update.openingHours) ? update.openingHours : existing.openingHours,
      products: Array.isArray(update.products) ? update.products : existing.products,
      about: update.about ?? existing.about,
      specialties: Array.isArray(update.specialties) ? update.specialties : existing.specialties,
      certifications: Array.isArray(update.certifications) ? update.certifications : existing.certifications,
      paymentMethods: Array.isArray(update.paymentMethods) ? update.paymentMethods : existing.paymentMethods,
      deliveryOptions: Array.isArray(update.deliveryOptions) ? update.deliveryOptions : existing.deliveryOptions,
      googleRating: update.googleRating ?? existing.googleRating,
      googleReviewCount: update.googleReviewCount ?? existing.googleReviewCount,
      tripadvisorRating: update.tripadvisorRating ?? existing.tripadvisorRating,
      externalReviews: Array.isArray(update.externalReviews) ? update.externalReviews : existing.externalReviews,
      externalLinks: Array.isArray(update.externalLinks) ? update.externalLinks : existing.externalLinks,
      images: Array.isArray(update.images) ? update.images : existing.images,
      seasonality: Array.isArray(update.seasonality) ? update.seasonality : existing.seasonality,
      deliveryRadius: update.deliveryRadius ?? existing.deliveryRadius,
      minOrderValue: update.minOrderValue ?? existing.minOrderValue,
      dataSource: update.dataSource || existing.dataSource,
      // I-F: spreading a list stored as one string gave one source per letter,
      // and spreading a string or an array into preferences gave one key per
      // character or entry. Only text entries and plain objects are merged.
      autoSources: [...new Set([...textEntries(existing.autoSources), ...textEntries(update.autoSources)])],
      lastEnrichedAt: update.lastEnrichedAt ?? existing.lastEnrichedAt,
      ownerUpdatedAt: update.ownerUpdatedAt ?? existing.ownerUpdatedAt,
      preferences: { ...plainObjectOrEmpty(existing.preferences), ...plainObjectOrEmpty(update.preferences) },
    };
  }

  // S4-A1a: no `google` entry (getAgentInfo above), and with it no invented
  // `reviews: 0` when the count is unknown; the REST card read it from here.
  private buildRatings(knowledge: AgentKnowledge | null): AgentInfoResponse["knowledge"]["ratings"] {
    if (!knowledge) return undefined;
    const ratings: any = {};
    if (knowledge.tripadvisorRating) {
      ratings.tripadvisor = { score: knowledge.tripadvisorRating };
    }
    return Object.keys(ratings).length > 0 ? ratings : undefined;
  }

  /**
   * One JSON column of a read. Integration test 2026-10-17 (I-F): text that
   * does not parse threw out of every reader. A lenient read gives the
   * fallback instead and logs `[knowledge-guard]` with the agent id and the
   * column, never the value: it can hold contact details, and JSON.parse's
   * own message quotes it. A strict read throws, as every read did before.
   */
  private jsonColumn<T>(agentId: string, column: string, text: unknown, fallback: T, mode: "strict" | "lenient"): T {
    if (!text) return fallback;
    if (mode === "strict") return JSON.parse(text as string);
    try {
      return JSON.parse(text as string);
    } catch {
      console.error(`[knowledge-guard] agent ${agentId}: ${column} is not valid JSON, read as empty`);
      return fallback;
    }
  }

  private rowToKnowledge(row: any, mode: "strict" | "lenient"): AgentKnowledge {
    const json = <T>(column: string, fallback: T): T =>
      this.jsonColumn(row.agent_id, `agent_knowledge.${column}`, row[column], fallback, mode);
    return {
      agentId: row.agent_id,
      address: row.address,
      postalCode: row.postal_code,
      website: row.website,
      phone: row.phone,
      email: row.email,
      openingHours: json("opening_hours", []),
      products: json("products", []),
      about: row.about,
      specialties: json("specialties", []),
      certifications: json("certifications", []),
      paymentMethods: json("payment_methods", []),
      deliveryOptions: json("delivery_options", []),
      googleRating: row.google_rating,
      googleReviewCount: row.google_review_count,
      tripadvisorRating: row.tripadvisor_rating,
      externalReviews: json("external_reviews", []),
      externalLinks: json("external_links", []),
      images: json("images", []),
      seasonality: json("seasonality", []),
      deliveryRadius: row.delivery_radius || undefined,
      minOrderValue: row.min_order_value || undefined,
      dataSource: row.data_source || "auto",
      autoSources: json("auto_sources", []),
      lastEnrichedAt: row.last_enriched_at,
      ownerUpdatedAt: row.owner_updated_at,
      preferences: json("preferences", {}),
      curatedFields: json("curated_fields", {}),
    };
  }

  /** Phase 4.9a — set or unset a curated-field lock.
   *  Used by rfb-customer-service when applying customer-requested changes. */
  setCuratedFieldLock(
    agentId: string,
    field: string,
    meta: CuratedFieldMeta | null,
  ): void {
    const db = getDb();
    const row = db.prepare("SELECT curated_fields FROM agent_knowledge WHERE agent_id = ?").get(agentId) as { curated_fields?: string } | undefined;
    if (!row) return;
    const current: Record<string, CuratedFieldMeta> = row.curated_fields
      ? JSON.parse(row.curated_fields)
      : {};
    if (meta === null) {
      delete current[field];
    } else {
      current[field] = meta;
    }
    db.prepare("UPDATE agent_knowledge SET curated_fields = ? WHERE agent_id = ?")
      .run(JSON.stringify(current), agentId);
  }

  /** curated_fields column text -> locks; unreadable text reads as "no locks" (as getCuratedFields). */
  private parseCuratedFields(raw: string | null | undefined): Record<string, CuratedFieldMeta> {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Phase 4.9a — get current curated-field locks (used by enrichment-agent
   *  before PUT, and by orchestrator for KPI-reporting). */
  getCuratedFields(agentId: string): Record<string, CuratedFieldMeta> {
    const db = getDb();
    const row = db.prepare("SELECT curated_fields FROM agent_knowledge WHERE agent_id = ?").get(agentId) as { curated_fields?: string } | undefined;
    if (!row || !row.curated_fields) return {};
    try {
      return JSON.parse(row.curated_fields) as Record<string, CuratedFieldMeta>;
    } catch {
      return {};
    }
  }
}

// Singleton
export const knowledgeService = new KnowledgeService();
