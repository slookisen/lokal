// ─── Owner-claim auto-assessment, slice A (RECORD-ONLY) ───────────────────
// dev-request 2026-10-30-rfb-eierkrav-automatisk-vurdering-og-ettklikk,
// section "A. Vurdering ved innsending". Every new claim row gets a stored
// `claim_assessment` (signals, source and time per signal, result, rule
// version) when CLAIM_AUTO_ASSESSMENT_ENABLED === "true" (default OFF).
//
// Slice A only RECORDS the assessment. It never changes the claim's outcome,
// the response, the status code, any e-mail or any ownership: the queue,
// rule 1 and the claim domain rule (claim-domain-rule.ts) decide exactly as
// before. Later slices (auto-approval, signed links) read what is stored here.
//
//   Anchors (≥1 needed for green)
//     A1  the e-mail's registrable domain (after www-strip) is the profile's
//         website with independent provenance (independentWebsiteHost, the
//         same test the domain rule's P1 uses). A1 through a SIBLING profile
//         (same org.nr, phone or address) is recorded as `A1_sibling`: a
//         possible duplicate, so the result is at most yellow.
//     A2  exactly this address appears in an independent source: the farm's
//         independent website (fetched server-side, front page), or an
//         enrichment provenance record with a source_url. Brreg, Bondens
//         marked and Debio are recorded as not checked in slice A.
//   Supports (≥1 of S1–S3 needed for green)
//     S1  the claimant's name is innehaver / daglig leder / styreleder in
//         Brreg's roles for the profile's org.nr.
//     S2  the website on the e-mail's domain shows the profile's org.nr,
//         phone or street address.
//     S3  the domain was registered ≥ 1 year ago (RDAP; Norid for .no).
//     S4  the phone the claimant gave matches an independent source. The
//         phone is public on the profile, so S4 NEVER counts alone: it is
//         recorded, but only S1, S2 or S3 satisfy the support requirement
//         (S4 adds nothing to the green decision on its own or otherwise).
//   Red flags (any → red)
//     has_owner, shared_address (slice 1b), free_mail without A2,
//     domain_young (< 90 days), no_mx, disposable, lookalike (of the farm's
//     domain, not equal), other_farm_domain (the domain is another farm's),
//     velocity (≥ 3 claims from the same e-mail, IP or domain in 24 h).
//   Result
//     green  = ≥1 own anchor (A1/A2) + ≥1 of S1–S3 + no red flag + no
//              unavailable source + no possible duplicate;
//     red    = any red flag;
//     yellow = everything else. A network source that errors or times out is
//              listed in unavailable_sources and the result can never be
//              green (AC8).
//
// Privacy: only org.nr, a role hit yes/no and the source URL are stored for
// Brreg — never a person's name. Fetched page text is never stored.
//
// All network (HTTP JSON, website text, DNS MX) and the clock are behind
// injectable deps with short timeouts, so tests mock everything.

import crypto from "crypto";
import dns from "dns";
import https from "https";
import { domainToUnicode } from "url";
import {
  emailDomain,
  emailDomainMatchesWebsite,
  isFreeMailDomain,
  isProbeableDomain,
  isPublicIp,
  registrableDomain,
} from "./claim-domain-rule";

/** Env flag (read at call time). Only the exact string "true" turns it on. */
export const CLAIM_ASSESSMENT_FLAG = "CLAIM_AUTO_ASSESSMENT_ENABLED";

export function claimAssessmentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CLAIM_ASSESSMENT_FLAG] === "true";
}

export const CLAIM_ASSESSMENT_RULE_VERSION = "A1" as const;
/** Per network source. */
export const CLAIM_ASSESSMENT_SOURCE_TIMEOUT_MS = 4000;
/** Upper bound for one whole assessment (sources run in parallel). */
export const CLAIM_ASSESSMENT_TOTAL_TIMEOUT_MS = 12000;
export const CLAIM_ASSESSMENT_VELOCITY_MAX = 3;
export const CLAIM_ASSESSMENT_DOMAIN_MIN_AGE_DAYS = 90;
export const CLAIM_ASSESSMENT_DOMAIN_SUPPORT_AGE_DAYS = 365;
const MAX_PAGE_BYTES = 512 * 1024;

export const BRREG_ROLES_URL = (orgNr: string): string =>
  `https://data.brreg.no/enhetsregisteret/api/enheter/${orgNr}/roller`;
export const rdapUrl = (domain: string): string =>
  domain.endsWith(".no") ? `https://rdap.norid.no/domain/${domain}` : `https://rdap.org/domain/${domain}`;

export type ClaimAssessmentResult = "green" | "yellow" | "red";
export type SignalStatus = "ok" | "unavailable" | "not_checked" | "skipped";

export type SignalId =
  | "A1" | "A1_sibling" | "A2_website" | "A2_enrichment" | "A2_brreg" | "A2_bondensmarked" | "A2_debio"
  | "S1" | "S2" | "S3" | "S4"
  | "has_owner" | "shared_address" | "free_mail" | "domain_young" | "no_mx" | "disposable" | "lookalike"
  | "other_farm_domain" | "velocity_email" | "velocity_ip" | "velocity_domain";

export interface ClaimSignal {
  id: SignalId;
  hit: boolean;
  /** Where the answer came from: "profile", "db", "website", "brreg", "rdap", "dns", "static_list", "clock". */
  source: string;
  source_url?: string;
  checked_at: string;
  status: SignalStatus;
  /** A short machine reason (no PII), e.g. "no_org_nr", "http_404". */
  note?: string;
}

export type NetworkSource = "brreg_roller" | "rdap" | "dns_mx" | "website_farm" | "website_email_domain";

export interface ClaimAssessment {
  result: ClaimAssessmentResult;
  anchors: SignalId[];
  supports: SignalId[];
  red_flags: SignalId[];
  unavailable_sources: NetworkSource[];
  /** A sibling profile (same org.nr, phone or address) exists: a possible duplicate. */
  possible_duplicate: boolean;
  signals: ClaimSignal[];
  rule_version: typeof CLAIM_ASSESSMENT_RULE_VERSION;
  /** The org.nr Brreg was asked about (or null). */
  org_nr: string | null;
}

/** What the DB knows about a claim — gathered by knowledge-service.ts. */
export interface ClaimAssessmentInput {
  claimantName: string;
  claimantEmail: string;
  claimantPhone?: string | null;
  profile: {
    orgNr: string | null;
    /** false when the org.nr may come from the claimant (a self-registration). */
    orgNrIndependent: boolean;
    phone: string | null;
    address: string | null;
    postalCode: string | null;
    /** Host of the profile's website, any provenance (lookalike reference). */
    websiteHost: string | null;
    /** independentWebsiteHost (knowledge-service.ts), or null. */
    independentWebsiteHost: string | null;
    hasOwner: boolean;
  };
  /** Profiles with the same org.nr, phone or address, with their independent website host. */
  siblings: Array<{ independentWebsiteHost: string | null }>;
  /** The claimant's address is the known e-mail of >1 profile, or the claim row was queued as shared_address. */
  sharedAddress: boolean;
  /** Another (non-sibling) farm profile has a website or e-mail on the claimant's registrable domain. */
  otherFarmHasDomain: boolean;
  /** Enrichment provenance records with a source_url (field_provenance.email / .phone), non-owner, non-inference. */
  enrichment: { emails: Array<{ value: string; sourceUrl: string }>; phones: Array<{ value: string; sourceUrl: string }> };
  /** Claim rows in the last 24 h (including this one). ip: null when no IP was known. */
  recentClaims: { sameEmail: number; sameDomain: number; sameIp: number | null };
}

export interface HttpAnswer {
  status: number;
  body: string;
}

export interface ClaimAssessmentDeps {
  /** GET a fixed public JSON/text API (Brreg, RDAP). Throws on network error/timeout. */
  fetchApi: (url: string, timeoutMs: number) => Promise<HttpAnswer>;
  /** GET https://<host>/ of a farm or claimant site (SSRF-guarded). Throws on network error/timeout. */
  fetchSite: (host: string, timeoutMs: number) => Promise<HttpAnswer>;
  /** MX records of a domain. Throws (with `code`) on failure; ENOTFOUND/ENODATA mean "none". */
  resolveMx: (domain: string) => Promise<Array<{ exchange: string; priority: number }>>;
  now: () => Date;
  timeoutMs?: number;
}

// ─── static lists ─────────────────────────────────────────────────────────

/** Disposable / throwaway mail domains (compared against the registrable domain). */
export const DISPOSABLE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "guerrillamailblock.com",
  "sharklasers.com", "grr.la", "10minutemail.com", "10minutemail.net", "temp-mail.org", "temp-mail.io",
  "tempmail.dev", "tempmailo.com", "tempr.email", "yopmail.com", "yopmail.net", "trashmail.com", "trashmail.de",
  "getnada.com", "nada.email", "dispostable.com", "maildrop.cc", "throwawaymail.com", "mohmal.com",
  "emailondeck.com", "fakeinbox.com", "mintemail.com", "mailnesia.com", "discard.email", "spamgourmet.com",
  "burnermail.io", "33mail.com", "mytemp.email", "moakt.com", "inboxkitten.com", "mail.tm", "getairmail.com",
  "mailcatch.com", "spambox.us", "tempinbox.com", "emailfake.com", "byom.de", "einrot.com", "mvrht.net",
]);

/** Brreg role codes that count for S1: innehaver, daglig leder, styrets leder. */
const S1_ROLE_CODES: ReadonlySet<string> = new Set(["INNH", "DAGL", "LEDE"]);

// ─── helpers ──────────────────────────────────────────────────────────────

/** Rejects after `ms` (the source counts as unavailable). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Lower case, diacritics folded (æ→ae, ø→o, å→a), non-letters → space. */
export function normalizePersonName(raw: string): string[] {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s-]/g, " ")
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Does the claimant's name match a Brreg person name? Conservative: the
 * claimant's first token equals the person's first given name AND the
 * claimant's last token equals the person's last surname token (middle names
 * ignored). A single-token name never matches.
 */
export function personNameMatches(claimantName: string, person: { fornavn?: unknown; etternavn?: unknown }): boolean {
  const c = normalizePersonName(claimantName);
  const f = normalizePersonName(String(person.fornavn ?? ""));
  const e = normalizePersonName(String(person.etternavn ?? ""));
  if (c.length < 2 || !f.length || !e.length) return false;
  return c[0] === f[0] && c[c.length - 1] === e[e.length - 1];
}

/** Norwegian phone → its 8 national digits (or the digits as given when not Norwegian-shaped). */
export function normalizePhoneDigits(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  let d = String(raw).replace(/\D/g, "");
  if (d.startsWith("0047")) d = d.slice(4);
  else if (d.length === 10 && d.startsWith("47")) d = d.slice(2);
  return d.length >= 8 ? d : null;
}

/** 9-digit org.nr or null. */
export function normalizeOrgNr(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const d = String(raw).replace(/\s/g, "");
  return /^\d{9}$/.test(d) ? d : null;
}

/** Page text for matching: tags removed, entities for @ decoded, whitespace collapsed, lower case. */
function pageText(html: string): string {
  return html
    .replace(/&#64;|&#x40;|&commat;/gi, "@")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Exact address as a whole token in the raw page (text or mailto:). */
export function pageHasEmail(html: string, email: string): boolean {
  const target = email.trim().toLowerCase();
  if (!target.includes("@")) return false;
  const hay = `${html.toLowerCase().replace(/&#64;|&#x40;|&commat;/g, "@")} ${pageText(html)}`;
  const esc = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9._%+-])${esc}($|[^a-z0-9.-]|\\.(?![a-z0-9]))`).test(hay);
}

/** The page shows this 9-digit org.nr (spaces between groups allowed). */
export function pageHasOrgNr(html: string, orgNr: string): boolean {
  const digitsOnly = pageText(html).replace(/(\d)[\s. ]+(?=\d)/g, "$1");
  return new RegExp(`(^|\\D)${orgNr}(\\D|$)`).test(digitsOnly);
}

/** The page shows this phone (8 national digits, any spacing, optional +47). */
export function pageHasPhone(html: string, phoneDigits: string): boolean {
  const compact = pageText(html).replace(/(\d)[\s.\- ]+(?=\d)/g, "$1").replace(/(\+|00)47(?=\d{8}(\D|$))/g, "");
  return new RegExp(`(^|\\D)${phoneDigits}(\\D|$)`).test(compact);
}

/** The page shows the street core of the address ("Gardsvegen 12"), case-insensitive. */
export function pageHasAddress(html: string, address: string): boolean {
  const core = String(address).split(",")[0]!.trim().toLowerCase().replace(/\s+/g, " ");
  if (core.length < 6 || !/\d/.test(core)) return false; // needs a street + number to mean anything
  return pageText(html).includes(core);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** Visual skeleton of a domain: IDN decoded, confusables folded. */
export function homoglyphSkeleton(domain: string): string {
  let s = (domainToUnicode(domain) || domain).toLowerCase();
  const map: Record<string, string> = {
    "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d",
    "ɡ": "g", "ø": "o", "ö": "o", "ó": "o", "ò": "o", "å": "a", "ä": "a", "á": "a", "à": "a", "é": "e", "è": "e",
    "ü": "u", "ú": "u", "í": "i", "ı": "i",
  };
  s = s.replace(/æ/g, "ae").split("").map((ch) => map[ch] ?? ch).join("");
  return s.replace(/rn/g, "m").replace(/vv/g, "w").replace(/0/g, "o").replace(/[1il|]/g, "l").replace(/5/g, "s");
}

/**
 * Is `emailReg` a lookalike of the farm's registrable domain `farmReg` (and
 * not equal)? Yes when their visual skeletons are equal, when the label is
 * the same under another suffix (gard.no vs gard.com), or when the edit
 * distance is ≤ 2 and both labels have ≥ 5 characters (so short unrelated
 * names such as ab.no / cd.no do not trip it).
 */
export function isLookalikeDomain(emailReg: string, farmReg: string): boolean {
  if (!emailReg || !farmReg || emailReg === farmReg) return false;
  if (homoglyphSkeleton(emailReg) === homoglyphSkeleton(farmReg)) return true;
  const le = emailReg.split(".")[0]!;
  const lf = farmReg.split(".")[0]!;
  if (le === lf) return true;
  return Math.min(le.length, lf.length) >= 5 && levenshtein(emailReg, farmReg) <= 2;
}

/** RDAP registration date (ISO) from an RDAP domain object, or null. */
export function rdapRegistrationDate(json: unknown): string | null {
  const events = (json as { events?: unknown })?.events;
  if (!Array.isArray(events)) return null;
  for (const ev of events) {
    const action = String((ev as any)?.eventAction ?? "").toLowerCase();
    const date = (ev as any)?.eventDate;
    if (action === "registration" && typeof date === "string" && Number.isFinite(Date.parse(date))) return date;
  }
  return null;
}

/** Is this a Brreg roles answer (rollegrupper[].roller[]) that names the claimant in an S1 role? */
export function brregRolesHit(json: unknown, claimantName: string): boolean {
  const groups = (json as { rollegrupper?: unknown })?.rollegrupper;
  if (!Array.isArray(groups)) return false;
  for (const g of groups) {
    const roles = (g as any)?.roller;
    if (!Array.isArray(roles)) continue;
    for (const r of roles) {
      const code = String(r?.type?.kode ?? "").toUpperCase();
      if (!S1_ROLE_CODES.has(code) || r?.fratraadt === true || r?.avregistrert === true) continue;
      const navn = r?.person?.navn;
      if (navn && personNameMatches(claimantName, navn)) return true;
    }
  }
  return false;
}

function hostOfUrl(u: string): string | null {
  try {
    return new URL(u).hostname.toLowerCase().replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

const isNoRecordsDnsError = (e: unknown): boolean => {
  const code = String((e as { code?: unknown })?.code ?? "");
  return code === "ENOTFOUND" || code === "ENODATA" || code === dns.NOTFOUND || code === dns.NODATA;
};

// ─── the assessment ───────────────────────────────────────────────────────

export async function assessClaim(input: ClaimAssessmentInput, deps: ClaimAssessmentDeps): Promise<ClaimAssessment> {
  const timeout = deps.timeoutMs ?? CLAIM_ASSESSMENT_SOURCE_TIMEOUT_MS;
  const stamp = (): string => deps.now().toISOString();
  const signals: ClaimSignal[] = [];
  const unavailable = new Set<NetworkSource>();
  const add = (s: Omit<ClaimSignal, "checked_at"> & { checked_at?: string }): void => {
    signals.push({ ...s, checked_at: s.checked_at ?? stamp() });
  };

  const email = String(input.claimantEmail ?? "").trim().toLowerCase();
  const domain = emailDomain(email);
  const reg = domain ? registrableDomain(domain.replace(/^www\./, "")) : null;
  const freeMail = !domain || isFreeMailDomain(domain);
  const ownDomain = !freeMail && !!domain && isProbeableDomain(domain);
  const p = input.profile;
  const orgNr = normalizeOrgNr(p.orgNr);
  const profilePhone = normalizePhoneDigits(p.phone);
  const claimantPhone = normalizePhoneDigits(input.claimantPhone ?? null);

  // ── A1 ──
  const a1 = !!domain && !freeMail && !!p.independentWebsiteHost && emailDomainMatchesWebsite(domain, p.independentWebsiteHost);
  add({ id: "A1", hit: a1, source: "profile", status: p.independentWebsiteHost ? "ok" : "skipped",
    ...(p.independentWebsiteHost ? { source_url: `https://${p.independentWebsiteHost}/` } : { note: "no_independent_website" }) });
  const siblingSite = !domain || freeMail ? null
    : input.siblings.map((s) => s.independentWebsiteHost).find((h): h is string => !!h && emailDomainMatchesWebsite(domain, h)) ?? null;
  add({ id: "A1_sibling", hit: !!siblingSite, source: "db", status: input.siblings.length ? "ok" : "skipped",
    ...(siblingSite ? { source_url: `https://${siblingSite}/` } : {}) });

  // ── network, in parallel ──
  type Page = { host: string; html: string } | null;
  const fetchPage = async (host: string, src: NetworkSource): Promise<{ page: Page; note?: string }> => {
    try {
      const r = await withTimeout(deps.fetchSite(host, timeout), timeout);
      if (r.status >= 500) { unavailable.add(src); return { page: null, note: `http_${r.status}` }; }
      if (r.status < 200 || r.status >= 300) return { page: null, note: `http_${r.status}` };
      return { page: { host, html: String(r.body ?? "").slice(0, MAX_PAGE_BYTES) } };
    } catch {
      unavailable.add(src);
      return { page: null, note: "unavailable" };
    }
  };
  const farmHost = p.independentWebsiteHost && isProbeableDomain(p.independentWebsiteHost) ? p.independentWebsiteHost : null;
  const sameSite = !!farmHost && !!domain && ownDomain && farmHost.replace(/^www\./, "") === domain.replace(/^www\./, "");
  const farmPageP = farmHost ? fetchPage(farmHost, "website_farm") : Promise.resolve({ page: null as Page, note: "skipped" });
  const emailPageP = ownDomain && !sameSite ? fetchPage(domain!, "website_email_domain") : sameSite ? farmPageP : Promise.resolve({ page: null as Page, note: "skipped" });

  const brregP = (async (): Promise<{ hit: boolean; status: SignalStatus; note?: string }> => {
    if (!orgNr) return { hit: false, status: "skipped", note: "no_org_nr" };
    if (!p.orgNrIndependent) return { hit: false, status: "skipped", note: "org_nr_not_independent" };
    try {
      const r = await withTimeout(deps.fetchApi(BRREG_ROLES_URL(orgNr), timeout), timeout);
      if (r.status === 404 || r.status === 410) return { hit: false, status: "ok", note: `http_${r.status}` };
      if (r.status < 200 || r.status >= 300) { unavailable.add("brreg_roller"); return { hit: false, status: "unavailable", note: `http_${r.status}` }; }
      let json: unknown;
      try { json = JSON.parse(r.body); } catch { unavailable.add("brreg_roller"); return { hit: false, status: "unavailable", note: "bad_json" }; }
      return { hit: brregRolesHit(json, input.claimantName), status: "ok" };
    } catch {
      unavailable.add("brreg_roller");
      return { hit: false, status: "unavailable", note: "unavailable" };
    }
  })();

  const rdapP = (async (): Promise<{ ageDays: number | null; status: SignalStatus; note?: string }> => {
    if (!ownDomain || !reg) return { ageDays: null, status: "skipped", note: freeMail ? "free_mail" : "no_domain" };
    try {
      const r = await withTimeout(deps.fetchApi(rdapUrl(reg), timeout), timeout);
      if (r.status === 404) {
        // Not registered at all: no S3, and the "young" flag cannot be ruled out → unavailable.
        unavailable.add("rdap");
        return { ageDays: null, status: "unavailable", note: "http_404" };
      }
      if (r.status < 200 || r.status >= 300) { unavailable.add("rdap"); return { ageDays: null, status: "unavailable", note: `http_${r.status}` }; }
      let json: unknown;
      try { json = JSON.parse(r.body); } catch { unavailable.add("rdap"); return { ageDays: null, status: "unavailable", note: "bad_json" }; }
      const at = rdapRegistrationDate(json);
      if (!at) { unavailable.add("rdap"); return { ageDays: null, status: "unavailable", note: "no_registration_date" }; }
      return { ageDays: (deps.now().getTime() - Date.parse(at)) / 86_400_000, status: "ok" };
    } catch {
      unavailable.add("rdap");
      return { ageDays: null, status: "unavailable", note: "unavailable" };
    }
  })();

  const mxP = (async (): Promise<{ none: boolean; status: SignalStatus; note?: string }> => {
    if (!ownDomain) return { none: false, status: "skipped", note: freeMail ? "free_mail" : "no_domain" };
    try {
      const recs = await withTimeout(deps.resolveMx(domain!), timeout);
      const usable = (recs ?? []).filter((r) => r && typeof r.exchange === "string" && r.exchange !== "" && r.exchange !== ".");
      return { none: usable.length === 0, status: "ok" };
    } catch (e) {
      if (isNoRecordsDnsError(e)) return { none: true, status: "ok", note: "no_records" };
      unavailable.add("dns_mx");
      return { none: false, status: "unavailable", note: "unavailable" };
    }
  })();

  const [farmPage, emailPage, brreg, rdap, mx] = await Promise.all([farmPageP, emailPageP, brregP, rdapP, mxP]);

  // ── A2 ──
  const a2Web = !!farmPage.page && pageHasEmail(farmPage.page.html, email);
  add({ id: "A2_website", hit: a2Web, source: "website", status: farmHost ? (farmPage.page ? "ok" : unavailable.has("website_farm") ? "unavailable" : "ok") : "skipped",
    ...(farmHost ? { source_url: `https://${farmHost}/` } : {}), ...(farmPage.note ? { note: farmPage.note } : {}) });
  const ownRegs = new Set<string>([p.independentWebsiteHost ? registrableDomain(p.independentWebsiteHost.replace(/^www\./, "")) : null].filter((x): x is string => !!x));
  const a2Rec = input.enrichment.emails.find((r) => {
    if (r.value.trim().toLowerCase() !== email) return false;
    const h = hostOfUrl(r.sourceUrl);
    if (!h) return false;
    const hr = registrableDomain(h.replace(/^www\./, ""));
    // The claimant's own domain is not independent of the claimant, unless it is the farm's independent site.
    return !(reg && hr === reg && !ownRegs.has(hr));
  });
  add({ id: "A2_enrichment", hit: !!a2Rec, source: "db", status: "ok", ...(a2Rec ? { source_url: a2Rec.sourceUrl } : {}) });
  for (const id of ["A2_brreg", "A2_bondensmarked", "A2_debio"] as const) {
    add({ id, hit: false, source: id.slice(3), status: "not_checked", note: "slice_a" });
  }
  const a2 = a2Web || !!a2Rec;

  // ── supports ──
  add({ id: "S1", hit: brreg.hit, source: "brreg", status: brreg.status,
    ...(orgNr && p.orgNrIndependent ? { source_url: BRREG_ROLES_URL(orgNr) } : {}), ...(brreg.note ? { note: brreg.note } : {}) });
  let s2 = false;
  if (emailPage.page) {
    const h = emailPage.page.html;
    s2 = (!!orgNr && pageHasOrgNr(h, orgNr)) || (!!profilePhone && pageHasPhone(h, profilePhone)) || (!!p.address && pageHasAddress(h, p.address));
  }
  add({ id: "S2", hit: s2, source: "website", status: !ownDomain ? "skipped" : emailPage.page ? "ok" : unavailable.has(sameSite ? "website_farm" : "website_email_domain") ? "unavailable" : "ok",
    ...(ownDomain ? { source_url: `https://${sameSite ? farmHost : domain}/` } : {}), ...(emailPage.note ? { note: emailPage.note } : {}) });
  const s3 = rdap.ageDays !== null && rdap.ageDays >= CLAIM_ASSESSMENT_DOMAIN_SUPPORT_AGE_DAYS;
  add({ id: "S3", hit: s3, source: "rdap", status: rdap.status, ...(reg && ownDomain ? { source_url: rdapUrl(reg) } : {}), ...(rdap.note ? { note: rdap.note } : {}) });
  // S4: the claimant's phone against an independent source (enrichment record
  // with source_url, or the farm's independent website). Never counts alone.
  let s4: { url: string; source: string } | null = null;
  if (claimantPhone) {
    const rec = input.enrichment.phones.find((r) => normalizePhoneDigits(r.value) === claimantPhone && !!hostOfUrl(r.sourceUrl));
    if (rec) s4 = { url: rec.sourceUrl, source: "db" };
    else if (farmPage.page && pageHasPhone(farmPage.page.html, claimantPhone)) s4 = { url: `https://${farmHost}/`, source: "website" };
  }
  add({ id: "S4", hit: !!s4, source: s4?.source ?? "db", status: claimantPhone ? "ok" : "skipped",
    ...(s4 ? { source_url: s4.url } : {}), ...(claimantPhone ? {} : { note: "no_phone" }) });

  // ── red flags ──
  add({ id: "has_owner", hit: p.hasOwner, source: "db", status: "ok" });
  add({ id: "shared_address", hit: input.sharedAddress, source: "db", status: "ok" });
  add({ id: "free_mail", hit: freeMail && !a2, source: "static_list", status: "ok", ...(domain ? {} : { note: "invalid_domain" }) });
  const young = rdap.ageDays !== null && rdap.ageDays < CLAIM_ASSESSMENT_DOMAIN_MIN_AGE_DAYS;
  add({ id: "domain_young", hit: young, source: "rdap", status: rdap.status, ...(reg && ownDomain ? { source_url: rdapUrl(reg) } : {}) });
  add({ id: "no_mx", hit: mx.none, source: "dns", status: mx.status, ...(mx.note ? { note: mx.note } : {}) });
  const disposable = !!reg && (DISPOSABLE_MAIL_DOMAINS.has(reg) || (!!domain && DISPOSABLE_MAIL_DOMAINS.has(domain)));
  add({ id: "disposable", hit: disposable, source: "static_list", status: "ok" });
  const farmReg = p.websiteHost ? registrableDomain(p.websiteHost.replace(/^www\./, "")) : null;
  const lookalike = !!reg && !!farmReg && !freeMail && isLookalikeDomain(reg, farmReg);
  add({ id: "lookalike", hit: lookalike, source: "profile", status: farmReg ? "ok" : "skipped" });
  add({ id: "other_farm_domain", hit: !freeMail && input.otherFarmHasDomain, source: "db", status: freeMail ? "skipped" : "ok" });
  const vmax = CLAIM_ASSESSMENT_VELOCITY_MAX;
  add({ id: "velocity_email", hit: input.recentClaims.sameEmail >= vmax, source: "db", status: "ok" });
  add({ id: "velocity_ip", hit: input.recentClaims.sameIp !== null && input.recentClaims.sameIp >= vmax, source: "db",
    status: input.recentClaims.sameIp === null ? "skipped" : "ok" });
  add({ id: "velocity_domain", hit: !freeMail && input.recentClaims.sameDomain >= vmax, source: "db", status: freeMail ? "skipped" : "ok" });

  // ── result ──
  const hits = (ids: readonly SignalId[]): SignalId[] => ids.filter((id) => signals.some((s) => s.id === id && s.hit));
  const anchors = hits(["A1", "A1_sibling", "A2_website", "A2_enrichment"]);
  const supports = hits(["S1", "S2", "S3", "S4"]);
  const redFlags = hits(["has_owner", "shared_address", "free_mail", "domain_young", "no_mx", "disposable", "lookalike",
    "other_farm_domain", "velocity_email", "velocity_ip", "velocity_domain"]);
  const ownAnchor = anchors.some((a) => a !== "A1_sibling");
  // S4 never satisfies the support requirement (see header).
  const realSupport = supports.some((s) => s !== "S4");
  const possibleDuplicate = input.siblings.length > 0;
  const unavailableSources = [...unavailable].sort() as NetworkSource[];
  const result: ClaimAssessmentResult = redFlags.length > 0 ? "red"
    : ownAnchor && realSupport && unavailableSources.length === 0 && !possibleDuplicate ? "green"
    : "yellow";

  return {
    result, anchors, supports, red_flags: redFlags, unavailable_sources: unavailableSources,
    possible_duplicate: possibleDuplicate, signals, rule_version: CLAIM_ASSESSMENT_RULE_VERSION,
    org_nr: orgNr && p.orgNrIndependent ? orgNr : null,
  };
}

// ─── default (real) deps ──────────────────────────────────────────────────

const UA = "Lokal-RFB-ClaimAssessment/1.0 (+https://rettfrabonden.com)";

/** GET a fixed public API URL with global fetch and an abort timeout. */
async function defaultFetchApi(url: string, timeoutMs: number): Promise<HttpAnswer> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  (t as any).unref?.();
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { Accept: "application/json, application/rdap+json", "User-Agent": UA } });
    const body = (await r.text()).slice(0, MAX_PAGE_BYTES);
    return { status: r.status, body };
  } finally {
    clearTimeout(t);
  }
}

/**
 * GET https://<host>/ — same SSRF guard as the domain rule's HTTPS probe
 * (isProbeableDomain on the name, isPublicIp on every DNS answer inside the
 * request's own lookup), no redirect followed, body capped, ~timeout.
 */
function defaultFetchSite(host: string, timeoutMs: number): Promise<HttpAnswer> {
  if (!isProbeableDomain(host)) return Promise.reject(new Error("not probeable"));
  return new Promise<HttpAnswer>((resolve, reject) => {
    let done = false;
    const ok = (v: HttpAnswer) => { if (!done) { done = true; resolve(v); } };
    const fail = (e: Error) => { if (!done) { done = true; reject(e); } };
    const safeLookup = (hostname: string, options: dns.LookupOptions, cb: (...args: any[]) => void): void => {
      dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
        if (err) return cb(err);
        const list = (addrs as dns.LookupAddress[]) ?? [];
        if (!list.length || list.some((a) => !isPublicIp(a.address))) {
          return cb(Object.assign(new Error(`non-public address for ${hostname}`), { code: "ENOTFOUND" }));
        }
        if ((options as { all?: boolean }).all) return cb(null, list);
        return cb(null, list[0]!.address, list[0]!.family);
      });
    };
    try {
      const req = https.request({
        host, port: 443, path: "/", method: "GET", servername: host, timeout: timeoutMs, lookup: safeLookup as any, agent: false,
        headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.5" },
      }, (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size <= MAX_PAGE_BYTES) chunks.push(c);
          else { res.destroy(); ok({ status, body: Buffer.concat(chunks).toString("utf8") }); }
        });
        res.on("end", () => ok({ status, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (e) => fail(e));
      });
      const hard = setTimeout(() => { req.destroy(); fail(new Error("timeout")); }, timeoutMs + 500);
      hard.unref?.();
      req.on("timeout", () => { req.destroy(); fail(new Error("timeout")); });
      req.on("error", (e) => fail(e));
      req.on("close", () => { clearTimeout(hard); fail(new Error("closed")); });
      req.end();
    } catch (e) {
      fail(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

export const defaultClaimAssessmentDeps: ClaimAssessmentDeps = {
  fetchApi: defaultFetchApi,
  fetchSite: defaultFetchSite,
  resolveMx: (domain: string) => dns.promises.resolveMx(domain),
  now: () => new Date(),
};

let depsOverride: Partial<ClaimAssessmentDeps> | null = null;

/** The deps the claim route uses (the defaults unless a test replaced some). */
export function getClaimAssessmentDeps(): ClaimAssessmentDeps {
  return { ...defaultClaimAssessmentDeps, ...(depsOverride ?? {}) };
}

/** Tests only: replace some deps (null restores the defaults). */
export function __setClaimAssessmentDepsForTesting(d: Partial<ClaimAssessmentDeps> | null): void {
  depsOverride = d;
}

// ─── per-process IP window (velocity_ip) ──────────────────────────────────
// The claims table has no IP column, and slice A adds none: the IP is kept
// only in memory, hashed, for 24 h, per process (a restart or another
// machine starts empty — documented limitation).

const IP_WINDOW_MS = 24 * 3_600_000;
const IP_WINDOW_MAX_KEYS = 10_000;
const ipWindow = new Map<string, number[]>();
const ipSalt = crypto.randomBytes(16).toString("hex");

const ipKey = (ip: string): string => crypto.createHash("sha256").update(`${ipSalt}:${ip}`).digest("hex").slice(0, 32);

/** Records one claim from `ip` at `nowMs` and returns the count in the last 24 h (this one included). */
export function recordClaimIp(ip: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (!ip || typeof ip !== "string") return null;
  const key = ipKey(ip.trim());
  const list = (ipWindow.get(key) ?? []).filter((t) => nowMs - t < IP_WINDOW_MS);
  list.push(nowMs);
  ipWindow.delete(key);
  ipWindow.set(key, list);
  if (ipWindow.size > IP_WINDOW_MAX_KEYS) {
    const oldest = ipWindow.keys().next().value;
    if (oldest !== undefined) ipWindow.delete(oldest);
  }
  return list.length;
}

/** Tests only. */
export function __resetClaimIpWindowForTesting(): void {
  ipWindow.clear();
}

// ─── fire-and-forget tracking (tests await it) ────────────────────────────

const pending = new Set<Promise<void>>();

export function trackClaimAssessment(p: Promise<void>): void {
  pending.add(p);
  p.finally(() => pending.delete(p)).catch(() => { /* already handled */ });
}

/** Tests only: resolves when every assessment started so far has finished. */
export async function __waitForClaimAssessmentsForTesting(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}
