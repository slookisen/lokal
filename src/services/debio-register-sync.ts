// ─── Debio register sync (økologi S1) ───────────────────────────────────────
// A2A dev-request 2026-10-28-rfb-okologisk-merking-debio-register-og-
// tekstrevisjon, slice S1: `agents.debio_*` from Debio's full register
// (debio-register-client.ts) instead of the finnoko showcase list, which is
// kept as a helper key (domain / e-mail) only.
//
// Daily from the debio-sync scheduler in index.ts when RFB_DEBIO_REGISTER_SYNC
// is on (otherwise the finnoko sync runs exactly as before), or on demand via
// POST /admin/debio/register-sync (dry run by default).
//
// The status lives in `agent_debio_status` (one row per checked producer,
// see init.ts for why not on `agents`); `agents.debio_verified` is derived.
//
// Run:
//   1. Fetch + normalize. Fewer than DEBIO_REGISTER_MIN_ROWS rows (a cut or
//      broken API) → rejected: nothing on `agents` changes, so the statuses
//      from the last successful run stay (the "last snapshot"), and the
//      reason is recorded (AC1.6).
//   2. Rows → entities (one per org.nr., or per sid without one); status
//      okologisk > karens > annet, expired okologisk certificates ignored.
//   3. Per producer, the first "sikker" match:
//        a. agents.org_nr = clientCode             (org_nr)
//           org_nr:NNNNNNNNN in agents.tags         (tag_org_nr)
//        b. website / e-mail domain via finnoko     (finnoko_domain)
//        c. name + postal code, token overlap ≥ 0.67 after dropping generic
//           words and place names                   (name_postal)
//        d. street + house no. + postal code        (street_postal), or a
//           differing postal code with the same city (street_city) — only
//           when no other active producer of ours has that street + house
//           no. in the same postal code / city; gnr/bnr and P.O. box lines
//           are never streets (review-only signals)
//      If one register entity is the c/d match of more than one producer
//      (or shares a sure match with another producer), those c/d matches go
//      to review instead.
//      A human-approved review row comes first. Everything weaker — name in
//      the same city, another house number, the farm name inside a company
//      name, the farm name as the owner's surname, the owner's first name in
//      the profile text, a chain in the same city — only becomes a
//      `debio_match_review` candidate, never a status.
//   4. Write (unless dry run): status, validity, product groups, sid, method,
//      checked_at in agent_debio_status; `agents.debio_verified` derived (= 1 iff okologisk with a valid
//      certificate and the owner's auto.debio not off). A producer no longer
//      matched, expired or only karens/annet is reset in the same run
//      (AC1.4); every change is logged in `debio_status_changes`.
//
// Privacy (S1.6): Debio `name` / `street` (often a person's name and home)
// are used in memory only — never written to a table, a log line or the
// result.

import type Database from "better-sqlite3";
import { getDb } from "../database/init";
import { fetchDebioRegister, registerExtraCaInUse, normalizeOrgNr, postalCodeOf, type DebioRegisterFetchResult, type DebioRegisterRow } from "./debio-register-client";
import { fetchFinnokoCompanies, type FinnokoCompany } from "./debio-finnoko-client";
import { canonicaliseDomain } from "./debio-verification-service";
import { emailDomain, isFreeMailDomain } from "./claim-domain-rule";
import { nameSimilarity, normaliseForMatch } from "./name-matcher";
import { certValidOn, debioRegisterStale, readDebioRegisterState, DEBIO_REGISTER_STALE_DAYS, DEBIO_REGISTER_SYNC_ENV, debioRegisterSyncEnabled } from "./debio-approval";
import { debioSwitchOffAgentIds } from "../owner-features/enforce";

// The flag lives in debio-approval (read side, no import cycle); re-exported here.
export { DEBIO_REGISTER_SYNC_ENV, debioRegisterSyncEnabled };
export const DEBIO_REGISTER_MIN_ROWS = 2500;
export const NAME_TOKEN_OVERLAP_MIN = 0.67;

export type DebioStatus = "okologisk" | "karens" | "annet" | "ingen";
export type SikkerMethod = "org_nr" | "tag_org_nr" | "finnoko_domain" | "name_postal" | "street_postal" | "street_city" | "review";

export interface SyncDebioRegisterOptions {
  fetchImpl?: typeof fetch;
  /** Default true for the admin endpoint; the scheduler passes false. */
  dryRun?: boolean;
  now?: Date;
  minRows?: number;
  /** Skip the finnoko in-process cache. */
  skipCache?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface SyncDebioRegisterResult {
  dry_run: boolean;
  accepted: boolean;
  reject_reason: string | null;
  /** True when the register request used DEBIO_REGISTER_EXTRA_CA_PEM (boolean only, never the PEM). */
  extra_ca: boolean;
  fetched_raw: number;
  normalized: number;
  rejected_rows: number;
  rows_without_valid_to: number;
  entities: number;
  producers_checked: number;
  matched: Record<SikkerMethod, number>;
  status_counts: Record<DebioStatus, number>;
  verified: number;
  review_candidates: number;
  would_reset: number;
  changes: number;
  owner_switch_off: number;
  finnoko_helper: "ok" | "failed";
  stale: boolean;
  warnings: string[];
  errors: string[];
}

// ─── entities ───────────────────────────────────────────────────────────────

interface Entity {
  key: string;
  sid: string | null;
  orgNr: string | null;
  status: Exclude<DebioStatus, "ingen"> | "ingen";
  validTo: string | null;
  productGroups: string[];
  /** In memory only. */
  names: string[];
  postalCodes: string[];
  cities: string[];
  /** Normalized street keys "<street>|<no>" (in memory only). */
  streets: Array<{ street: string; no: string }>;
  /** gnr/bnr and P.O. box lines — review-only signals (in memory only). */
  nonStreets: NonStreetAddress[];
}

/** One entity per org.nr. (or sid); expired or not-yet-started okologisk certificates do not count. */
export function buildEntities(rows: readonly DebioRegisterRow[], now: Date): Entity[] {
  const groups = new Map<string, DebioRegisterRow[]>();
  for (const r of rows) {
    const key = r.orgNr ?? `sid:${r.sid}`;
    const list = groups.get(key);
    if (list) list.push(r); else groups.set(key, [r]);
  }
  const out: Entity[] = [];
  for (const [key, list] of groups) {
    const today = now.toISOString().slice(0, 10);
    const started = (r: DebioRegisterRow) => !r.validFrom || r.validFrom.slice(0, 10) <= today;
    const live = list.filter((r) => r.status !== "okologisk" || (started(r) && (!r.validTo || certValidOn(r.validTo, now))));
    const oko = live.filter((r) => r.status === "okologisk");
    const karens = live.filter((r) => r.status === "karens");
    const basis = oko.length ? oko : karens.length ? karens : live;
    const status: Entity["status"] = oko.length ? "okologisk" : karens.length ? "karens" : live.length ? "annet" : "ingen";
    const validTo = basis.map((r) => r.validTo).filter((v): v is string => !!v).sort().pop() ?? null;
    const productGroups: string[] = [];
    for (const r of basis) for (const g of r.productGroups) if (!productGroups.includes(g)) productGroups.push(g);
    const streets: Entity["streets"] = [];
    const nonStreets: NonStreetAddress[] = [];
    for (const r of list) {
      const s = parseStreet(r.street);
      if (s) streets.push(s);
      else { const n = parseNonStreet(r.street); if (n) nonStreets.push(n); }
    }
    out.push({
      key,
      sid: (basis[0] ?? list[0]).sid,
      orgNr: list[0].orgNr,
      status,
      validTo,
      productGroups,
      names: [...new Set(list.map((r) => r.name))],
      postalCodes: [...new Set(list.map((r) => r.postalCode).filter((p): p is string => !!p))],
      cities: [...new Set(list.map((r) => normCity(r.city)).filter((c): c is string => !!c))],
      streets,
      nonStreets,
    });
  }
  return out;
}

// ─── normalisation ──────────────────────────────────────────────────────────

/** Generic words that never identify a business on their own. */
const GENERIC = new Set([
  "as", "sa", "da", "ans", "enk", "ba", "nuf", "asa", "ved", "v", "og", "i", "pa", "pa", "the", "and", "of",
  "gard", "gaard", "garden", "gardsbruk", "gardsbutikk", "gardsutsalg", "bruk", "farm",
]);
/** Company markers: «X Gard AS», «X Is AS», «X Gard ved …». */
const COMPANY_MARKERS = new Set(["as", "sa", "da", "ans", "enk", "ba", "nuf", "asa", "gard", "gaard", "ved", "v", "is", "bakeri", "gardsbruk"]);

export function normCity(c: unknown): string | null {
  if (typeof c !== "string") return null;
  const n = normaliseForMatch(c);
  return n || null;
}

function tokens(s: string): string[] {
  return normaliseForMatch(s).split(" ").filter((t) => t.length >= 2);
}

/** Identifying name tokens: generic words and place names dropped. */
export function coreTokens(name: string, places: readonly (string | null)[]): string[] {
  const placeTokens = new Set<string>();
  for (const p of places) if (p) for (const t of p.split(" ")) placeTokens.add(t);
  return [...new Set(tokens(name).filter((t) => !GENERIC.has(t) && !placeTokens.has(t)))];
}

/** |A ∩ B| / max(|A|, |B|) — 0 when either side is empty. */
export function tokenOverlap(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  const inter = a.filter((t) => sb.has(t)).length;
  return inter / Math.max(a.length, b.length);
}

/**
 * Street name key: case, punctuation and spaces out; «veien/vegen/veg/vei/vn.»
 * → «v», «gata/gate/gt.» → «g», «Allé/alle» alike, a genitive «s» before the
 * suffix dropped (Gunnarsrudsvegen = Gunnarsrudvegen).
 */
export function streetKey(name: string): string {
  let s = name.normalize("NFC").toLowerCase().replace(/é/g, "e").replace(/[.,'´`’\-]/g, " ");
  s = s.replace(/\s+/g, "");
  s = s.replace(/(veien|vegen|vegan|veg|vei|vn)$/, "v").replace(/(gata|gate|gt)$/, "g");
  s = s.replace(/([a-zæøå]{2,})s(v|g)$/, "$1$2");
  return s;
}

/**
 * Cadastral (gnr/bnr) and P.O. box forms are not street addresses: «Gnr 12
 * Bnr 5» would read as street «gnr» no. 12 (and match the neighbour «Gnr 12
 * Bnr 3»), «Postboks 12» would match the same box number at another post
 * office. Such lines never give a street key (parseStreet → null); they only
 * feed review-only signals (parseNonStreet). «Pboks», «P.boks», «Postboksnr.»
 * and «Boksnr.» count too: the letter boundary would otherwise let «pboks»
 * through as a street name.
 */
const NON_STREET_RE = /(?:^|[^a-zæøå])(?:g\s*\.?\s*nr|b\s*\.?\s*nr|gbnr|g\s*\/\s*bnr|gards\s*nr|gårds\s*nr|bruks\s*nr|matr(?:ikkel)?|postboks\s*\.?\s*nr|postboks|postb|post\s*box|p\s*\.?\s*o\s*\.?\s*box|pob|p\s*\.?\s*boks\s*\.?\s*nr|p\s*\.?\s*boks|boks\s*\.?\s*nr|boks|box|pb|p\s*\.\s*b)(?:[^a-zæøå]|$)/;

function firstSegment(address: string): string {
  return address.split(",")[0].trim();
}

export type NonStreetAddress = { kind: "gnr"; gnr: string; bnr: string | null } | { kind: "po_box"; no: string };

/** «Gnr 12 Bnr 5», «gnr. 12/5», «Postboks 12», «Pb 12» → review-only key. */
export function parseNonStreet(address: unknown): NonStreetAddress | null {
  if (typeof address !== "string") return null;
  const first = firstSegment(address).normalize("NFC").toLowerCase();
  if (!NON_STREET_RE.test(first)) return null;
  const g = /(?:g\s*\.?\s*nr|gards\s*nr|gårds\s*nr)\.?\s*(\d+)(?:\s*[\/,-]?\s*(?:(?:b\s*\.?\s*nr|bruks\s*nr)\.?\s*)?(\d+))?/.exec(first);
  if (g) {
    // «Gnr. 14, bnr. 5»: the bnr sits in the next comma segment.
    const next = g[2] ? null : /^(?:b\s*\.?\s*nr|bruks\s*nr)\.?\s*(\d+)/.exec((address.split(",")[1] ?? "").trim().normalize("NFC").toLowerCase());
    return { kind: "gnr", gnr: g[1], bnr: g[2] ?? next?.[1] ?? null };
  }
  const pb = /(?:postboks|postb|post\s*box|p\s*\.?\s*o\s*\.?\s*box|pob|p\s*\.?\s*boks|boks|box|pb|p\s*\.\s*b)(?:\s*\.?\s*nr)?\.?\s*(\d+)/.exec(first);
  if (pb) return { kind: "po_box", no: pb[1] };
  return null;
}

/** «Børsumvn. 51», «Hillevågsveien 99 B, 4016 Stavanger» → street key + house no. */
export function parseStreet(address: unknown): { street: string; no: string } | null {
  if (typeof address !== "string") return null;
  const first = firstSegment(address);
  if (NON_STREET_RE.test(first.normalize("NFC").toLowerCase())) return null;
  const m = /^(.*?[^\d\s])\s*(\d+)\s*([a-zA-Z])?(?:\s|$)/.exec(first);
  if (!m) return null;
  const street = streetKey(m[1]);
  if (street.length < 3) return null;
  return { street, no: `${m[2]}${(m[3] || "").toLowerCase()}` };
}

/** Postal code and city from an address line «…, 8360 Bøstad». */
function postalFromAddress(address: unknown): { postal: string | null; city: string | null } {
  if (typeof address !== "string") return { postal: null, city: null };
  const m = /(?:^|[,\s])(\d{4})\s+([^\d,]+)\s*$/.exec(address.trim());
  return m ? { postal: m[1], city: normCity(m[2]) } : { postal: null, city: null };
}

// ─── producers ──────────────────────────────────────────────────────────────

interface Producer {
  id: string;
  name: string;
  orgNr: string | null;
  tagOrgNrs: string[];
  domains: string[];
  postal: string | null;
  city: string | null;
  street: { street: string; no: string } | null;
  nonStreet: NonStreetAddress | null;
  /** Lower-cased profile text + e-mail local parts, for support signals only. */
  text: string;
  old: { status: string | null; verified: number; sid: string | null; method: string | null; validTo: string | null };
}

function tagOrgNrs(tags: unknown): string[] {
  let list: unknown = tags;
  if (typeof tags === "string") { try { list = JSON.parse(tags); } catch { list = []; } }
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const t of list) {
    if (typeof t !== "string") continue;
    const m = /^org_?nr\s*[:=]\s*(.+)$/i.exec(t.trim());
    const nr = m ? normalizeOrgNr(m[1]) : null;
    if (nr && !out.includes(nr)) out.push(nr);
  }
  return out;
}

function loadProducers(db: Database.Database): Producer[] {
  const rows = db.prepare(`
    SELECT a.id, a.name, a.org_nr, a.tags, a.city, a.description, a.contact_email,
           a.debio_verified, s.debio_status, s.debio_sid, s.debio_match_method, s.debio_cert_valid_to,
           k.website, k.email AS k_email, k.address, k.postal_code, k.about
    FROM agents a
    LEFT JOIN agent_knowledge k ON k.agent_id = a.id
    LEFT JOIN agent_debio_status s ON s.agent_id = a.id
    WHERE a.is_active = 1
      AND (a.umbrella_type IS NULL OR a.umbrella_type = '')
      AND (a.role IS NULL OR a.role = 'producer')
  `).all() as any[];
  return rows.map((r) => {
    const domains: string[] = [];
    const site = canonicaliseDomain(r.website);
    if (site) domains.push(site);
    for (const e of [r.contact_email, r.k_email]) {
      const d = emailDomain(e);
      if (d && !isFreeMailDomain(d)) { const c = canonicaliseDomain(d); if (c && !domains.includes(c)) domains.push(c); }
    }
    const fromAddr = postalFromAddress(r.address);
    const mailLocals = [r.contact_email, r.k_email].filter((e) => typeof e === "string").map((e: string) => e.split("@")[0]);
    return {
      id: r.id,
      name: String(r.name || ""),
      orgNr: normalizeOrgNr(r.org_nr),
      tagOrgNrs: tagOrgNrs(r.tags),
      domains,
      postal: postalCodeOf(r.postal_code) ?? fromAddr.postal,
      city: normCity(r.city) ?? fromAddr.city,
      street: parseStreet(r.address),
      nonStreet: parseNonStreet(r.address),
      text: normaliseForMatch([r.description, r.about, ...mailLocals].filter((x) => typeof x === "string").join(" ")),
      old: {
        status: r.debio_status ?? null,
        verified: r.debio_verified === 1 ? 1 : 0,
        sid: r.debio_sid ?? null,
        method: r.debio_match_method ?? null,
        validTo: r.debio_cert_valid_to ?? null,
      },
    };
  });
}

// ─── matching ───────────────────────────────────────────────────────────────

interface Index {
  byOrgNr: Map<string, Entity>;
  bySid: Map<string, Entity>;
  byPostal: Map<string, Entity[]>;
  byCity: Map<string, Entity[]>;
  byStreet: Map<string, Entity[]>;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const l = m.get(k);
  if (l) { if (!l.includes(v)) l.push(v); } else m.set(k, [v]);
}

function buildIndex(entities: readonly Entity[]): Index {
  const ix: Index = { byOrgNr: new Map(), bySid: new Map(), byPostal: new Map(), byCity: new Map(), byStreet: new Map() };
  for (const e of entities) {
    if (e.orgNr) ix.byOrgNr.set(e.orgNr, e);
    if (e.sid) ix.bySid.set(e.sid, e);
    for (const p of e.postalCodes) push(ix.byPostal, p, e);
    for (const c of e.cities) push(ix.byCity, c, e);
    for (const s of e.streets) push(ix.byStreet, `${s.street}|${s.no}`, e);
  }
  return ix;
}

interface Candidate { entity: Entity; method: string; score: number; reasons: string[] }
interface MatchOutcome { sikker: { entity: Entity; method: SikkerMethod } | null; review: Candidate[] }

/** finnoko company ↔ register entity by (near-)identical name; unique best only. */
function finnokoToEntity(c: FinnokoCompany, entities: readonly Entity[]): Entity | null {
  let best: Entity | null = null;
  let bestScore = 0;
  let tie = false;
  for (const e of entities) {
    for (const n of e.names) {
      const s = nameSimilarity(c.display_name, n);
      if (s > bestScore) { best = e; bestScore = s; tie = false; } else if (s === bestScore && e !== best && s > 0) tie = true;
    }
  }
  return best && bestScore >= 0.9 && !tie ? best : null;
}

function entityAt(e: Entity, p: Producer): { postal: boolean; city: boolean } {
  return { postal: !!p.postal && e.postalCodes.includes(p.postal), city: !!p.city && e.cities.includes(p.city) };
}

/** Our producers by street key + house no. — for the uniqueness check on street matches. */
type StreetPeers = Map<string, Producer[]>;

function buildStreetPeers(producers: readonly Producer[]): StreetPeers {
  const m: StreetPeers = new Map();
  for (const p of producers) if (p.street) push(m, `${p.street.street}|${p.street.no}`, p);
  return m;
}

/**
 * A street match is only "sikker" when the producer is the only active
 * producer of ours at that street + house no. in the same postal code or city
 * (a mathall, Bondens marked or business building houses several).
 */
function streetUnique(p: Producer, peers: StreetPeers | undefined): boolean {
  if (!p.street) return false;
  if (!peers) return false;
  const list = peers.get(`${p.street.street}|${p.street.no}`) ?? [];
  const local = list.filter((q) => q === p || (!!p.postal && q.postal === p.postal) || (!!p.city && q.city === p.city));
  return local.length === 1 && local[0] === p;
}

export function matchProducer(
  p: Producer,
  ix: Index,
  finnokoByDomain: Map<string, Entity>,
  rejected: Set<string>,
  streetPeers?: StreetPeers,
): MatchOutcome {
  const ok = (e: Entity | undefined | null): e is Entity => !!e && !rejected.has(`${p.id}|${e.key}`);
  // a. org.nr.
  if (p.orgNr && ok(ix.byOrgNr.get(p.orgNr))) return { sikker: { entity: ix.byOrgNr.get(p.orgNr)!, method: "org_nr" }, review: [] };
  for (const nr of p.tagOrgNrs) {
    const e = ix.byOrgNr.get(nr);
    if (ok(e)) return { sikker: { entity: e, method: "tag_org_nr" }, review: [] };
  }
  // b. domain / e-mail via finnoko
  for (const d of p.domains) {
    const e = finnokoByDomain.get(d);
    if (ok(e)) return { sikker: { entity: e, method: "finnoko_domain" }, review: [] };
  }

  const review = new Map<string, Candidate>();
  const addReview = (e: Entity, method: string, score: number, reason: string) => {
    if (!ok(e)) return;
    const c = review.get(e.key);
    if (c) { if (!c.reasons.includes(reason)) c.reasons.push(reason); c.score = Math.max(c.score, score); }
    else review.set(e.key, { entity: e, method, score, reasons: [reason] });
  };

  // Entities near the producer: same postal code or same city.
  const near = new Set<Entity>();
  if (p.postal) for (const e of ix.byPostal.get(p.postal) ?? []) near.add(e);
  if (p.city) for (const e of ix.byCity.get(p.city) ?? []) near.add(e);

  // c. name + postal code
  const nameHits: Array<{ e: Entity; score: number; postal: boolean }> = [];
  for (const e of near) {
    const at = entityAt(e, p);
    let best = 0;
    for (const n of e.names) {
      const places = [p.city, ...e.cities];
      best = Math.max(best, tokenOverlap(coreTokens(p.name, places), coreTokens(n, places)));
    }
    if (best >= NAME_TOKEN_OVERLAP_MIN) nameHits.push({ e, score: best, postal: at.postal });
  }
  const strongName = nameHits.filter((h) => h.postal);
  if (strongName.length === 1 && ok(strongName[0].e)) {
    return { sikker: { entity: strongName[0].e, method: "name_postal" }, review: [] };
  }
  for (const h of nameHits) addReview(h.e, "name", h.score, h.postal ? "name_postal_ambiguous" : "name_city");

  // d. street + house no. (+ postal code, or the same city)
  if (p.street) {
    const same = (ix.byStreet.get(`${p.street.street}|${p.street.no}`) ?? []).filter(ok);
    const byPostal = same.filter((e) => entityAt(e, p).postal);
    const byCity = same.filter((e) => !entityAt(e, p).postal && entityAt(e, p).city);
    const unique = streetUnique(p, streetPeers);
    if (unique && byPostal.length === 1) return { sikker: { entity: byPostal[0], method: "street_postal" }, review: [] };
    if (unique && byPostal.length === 0 && byCity.length === 1) return { sikker: { entity: byCity[0], method: "street_city" }, review: [] };
    const sureShape = byPostal.length === 1 || (byPostal.length === 0 && byCity.length === 1);
    for (const e of [...byPostal, ...byCity]) addReview(e, "street", 0.8, sureShape && !unique ? "street_shared_address" : "street_ambiguous");
    for (const e of same) if (!byPostal.includes(e) && !byCity.includes(e)) addReview(e, "street", 0.5, "street_other_place");
    // Same street, another house number, near the producer.
    for (const e of near) {
      if (e.streets.some((s) => s.street === p.street!.street && s.no !== p.street!.no)) addReview(e, "street", 0.5, "street_other_house_no");
    }
  }

  // gnr/bnr and P.O. box — review only, never a status.
  if (p.nonStreet) {
    const ns = p.nonStreet;
    for (const e of near) {
      for (const n of e.nonStreets) {
        if (ns.kind === "gnr" && n.kind === "gnr" && n.gnr === ns.gnr) {
          const sameBnr = !!ns.bnr && n.bnr === ns.bnr;
          addReview(e, "address", sameBnr ? 0.6 : 0.3, sameBnr ? "gnr_bnr_same" : "gnr_other_bnr");
        } else if (ns.kind === "po_box" && n.kind === "po_box" && n.no === ns.no) {
          addReview(e, "address", 0.3, "po_box_same_no");
        }
      }
    }
  }

  // Support signals — review only, never a status.
  const core = coreTokens(p.name, [p.city]);
  const farm = core.find((t) => t.length >= 4) ?? null;
  for (const e of near) {
    const at = entityAt(e, p);
    for (const n of e.names) {
      const nt = tokens(n);
      if (farm && nt.includes(farm)) {
        if (nt.some((t) => COMPANY_MARKERS.has(t))) addReview(e, "support", 0.4, "farm_name_in_company");
        else if (nt.length >= 2 && nt[nt.length - 1] === farm) addReview(e, "support", 0.4, "farm_name_as_surname");
      }
      // The owner's first name in our profile text — only with the postal code
      // or the street to back it (never alone).
      const looksPerson = nt.length >= 2 && !nt.some((t) => COMPANY_MARKERS.has(t));
      if (looksPerson && nt[0].length >= 3 && (at.postal || review.has(e.key)) && new RegExp(`(^| )${nt[0]}( |$)`).test(p.text)) {
        addReview(e, "support", 0.3, "owner_name_in_profile");
      }
      // Chains: «Godt Brød …» with a certified unit in the same city.
      if (core.length >= 2 && at.city && core.every((t) => nt.includes(t))) addReview(e, "support", 0.4, "chain_same_city");
    }
  }
  return { sikker: null, review: [...review.values()].sort((a, b) => b.score - a.score) };
}

// ─── writes ─────────────────────────────────────────────────────────────────

interface Decision {
  status: DebioStatus;
  validTo: string | null;
  groups: string[];
  sid: string | null;
  method: SikkerMethod | null;
  verified: 0 | 1;
  reason: string;
}

function decide(entity: Entity | null, method: SikkerMethod | null, switchOff: boolean, now: Date): Decision {
  if (!entity) return { status: "ingen", validTo: null, groups: [], sid: null, method: null, verified: 0, reason: "not_in_register" };
  const valid = entity.status === "okologisk" && certValidOn(entity.validTo, now);
  return {
    status: entity.status,
    validTo: entity.validTo,
    groups: entity.productGroups,
    sid: entity.sid,
    method,
    verified: valid && !switchOff ? 1 : 0,
    reason: switchOff ? "owner_switch_off" : entity.status === "ingen" ? "expired" : entity.status === "okologisk" && !valid ? "cert_not_valid" : "register_status",
  };
}

/** One agent's register status (agent_debio_status, see init.ts). */
const UPSERT_STATUS_SQL = `
  INSERT INTO agent_debio_status
    (agent_id, debio_status, debio_cert_valid_to, debio_product_groups, debio_sid, debio_checked_at, debio_match_method)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(agent_id) DO UPDATE SET
    debio_status = excluded.debio_status, debio_cert_valid_to = excluded.debio_cert_valid_to,
    debio_product_groups = excluded.debio_product_groups, debio_sid = excluded.debio_sid,
    debio_checked_at = excluded.debio_checked_at, debio_match_method = excluded.debio_match_method
`;
/** The derived flag every reader uses. */
const UPDATE_VERIFIED_SQL = `
  UPDATE agents SET debio_verified = ?, debio_verified_at = CASE WHEN ? = 1 THEN ? ELSE debio_verified_at END WHERE id = ?
`;

function logChange(db: Database.Database, agentId: string, old: Producer["old"], d: Pick<Decision, "status" | "verified" | "reason" | "sid">, source: string, nowIso: string): void {
  db.prepare(
    `INSERT INTO debio_status_changes (agent_id, old_status, new_status, old_verified, new_verified, reason, debio_sid, source, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(agentId, old.status, d.status, old.verified, d.verified, d.reason, d.sid, source, nowIso);
}

function updateState(db: Database.Database, patch: Partial<Record<"last_attempt_at" | "last_success_at" | "last_success_rows" | "last_reject_at" | "last_reject_reason", string | number | null>>): void {
  db.prepare("INSERT OR IGNORE INTO debio_register_sync_state (id) VALUES (1)").run();
  for (const [k, v] of Object.entries(patch)) {
    // Column names come from the fixed key union above, never from input.
    db.prepare(`UPDATE debio_register_sync_state SET ${k} = ? WHERE id = 1`).run(v);
  }
}

/**
 * > DEBIO_REGISTER_STALE_DAYS since the last successful register sync →
 * register-checked producers lose `debio_verified` (every reader of the column
 * then shows no organic status); a warning is returned. No-op when the
 * register sync never ran, and with RFB_DEBIO_REGISTER_SYNC off (rollback: the
 * finnoko sync owns debio_verified again). `enabled` overrides the flag.
 */
export function enforceDebioRegisterFreshness(
  db: Database.Database,
  now: Date = new Date(),
  opts: { enabled?: boolean } = {},
): { stale: boolean; cleared: number; warning: string | null } {
  if (!(opts.enabled ?? debioRegisterSyncEnabled())) return { stale: false, cleared: 0, warning: null };
  const state = readDebioRegisterState(db);
  if (!state) return { stale: false, cleared: 0, warning: null };
  if (!debioRegisterStale(state, now)) return { stale: false, cleared: 0, warning: null };
  const warning = `Debio register: no successful sync for more than ${DEBIO_REGISTER_STALE_DAYS} days (last success: ${state.last_success_at ?? "never"}) — no organic status is shown`;
  const ids = db.prepare("SELECT a.id, s.debio_status, s.debio_sid FROM agents a JOIN agent_debio_status s ON s.agent_id = a.id WHERE a.debio_verified = 1").all() as Array<{ id: string; debio_status: string; debio_sid: string | null }>;
  if (ids.length) {
    const nowIso = now.toISOString();
    db.transaction(() => {
      const upd = db.prepare("UPDATE agents SET debio_verified = 0 WHERE id = ?");
      for (const r of ids) {
        upd.run(r.id);
        logChange(db, r.id, { status: r.debio_status, verified: 1, sid: r.debio_sid, method: null, validTo: null },
          { status: r.debio_status as DebioStatus, verified: 0, reason: "stale_register", sid: r.debio_sid }, "freshness", nowIso);
      }
    })();
  }
  return { stale: true, cleared: ids.length, warning };
}

function emptyResult(dryRun: boolean): SyncDebioRegisterResult {
  return {
    dry_run: dryRun, accepted: false, reject_reason: null, extra_ca: false,
    fetched_raw: 0, normalized: 0, rejected_rows: 0, rows_without_valid_to: 0, entities: 0, producers_checked: 0,
    matched: { org_nr: 0, tag_org_nr: 0, finnoko_domain: 0, name_postal: 0, street_postal: 0, street_city: 0, review: 0 },
    status_counts: { okologisk: 0, karens: 0, annet: 0, ingen: 0 },
    verified: 0, review_candidates: 0, would_reset: 0, changes: 0, owner_switch_off: 0,
    finnoko_helper: "ok", stale: false, warnings: [], errors: [],
  };
}

/** Run the register sync once. See the file header for the steps. */
export async function syncDebioRegister(db: Database.Database = getDb(), opts: SyncDebioRegisterOptions = {}): Promise<SyncDebioRegisterResult> {
  const dryRun = opts.dryRun ?? true;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const minRows = opts.minRows ?? DEBIO_REGISTER_MIN_ROWS;
  const result = emptyResult(dryRun);

  const reject = (reason: string): SyncDebioRegisterResult => {
    result.reject_reason = reason;
    result.errors.push(reason);
    if (!dryRun) {
      updateState(db, { last_attempt_at: nowIso, last_reject_at: nowIso, last_reject_reason: reason });
      // A write run is the register sync at work: enforce regardless of the flag.
      const f = enforceDebioRegisterFreshness(db, now, { enabled: true });
      result.stale = f.stale;
      if (f.warning) result.warnings.push(f.warning);
    } else {
      const state = readDebioRegisterState(db);
      result.stale = state !== null && debioRegisterStale(state, now);
    }
    console.warn(`[debio-register] sync rejected, last snapshot kept: ${reason}`);
    return result;
  };

  let fetched: DebioRegisterFetchResult;
  const env = opts.env ?? process.env;
  result.extra_ca = registerExtraCaInUse({ fetchImpl: opts.fetchImpl, env });
  try {
    fetched = await fetchDebioRegister({ fetchImpl: opts.fetchImpl, env, now });
  } catch (e) {
    return reject(`fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  result.fetched_raw = fetched.raw;
  result.normalized = fetched.rows.length;
  result.rejected_rows = fetched.rejected;
  result.rows_without_valid_to = fetched.rows.filter((r) => !r.validTo).length;
  if (fetched.rows.length < minRows) {
    return reject(`too few rows: ${fetched.rows.length} normalized (${fetched.raw} raw), minimum ${minRows}`);
  }
  result.accepted = true;

  const entities = buildEntities(fetched.rows, now);
  result.entities = entities.length;
  const ix = buildIndex(entities);

  // finnoko as helper key: domain → register entity.
  const finnokoByDomain = new Map<string, Entity>();
  try {
    const companies = await fetchFinnokoCompanies({ fetchImpl: opts.fetchImpl, skipCache: opts.skipCache });
    for (const c of companies) {
      const domains = [canonicaliseDomain(c.website), canonicaliseDomain(c.website2)];
      const md = emailDomain(c.contact_mail);
      if (md && !isFreeMailDomain(md)) domains.push(canonicaliseDomain(md));
      const live = domains.filter((d): d is string => !!d);
      if (!live.length) continue;
      const e = finnokoToEntity(c, entities);
      if (e) for (const d of live) if (!finnokoByDomain.has(d)) finnokoByDomain.set(d, e);
    }
  } catch (e) {
    result.finnoko_helper = "failed";
    result.warnings.push(`finnoko helper unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }

  const producers = loadProducers(db);
  result.producers_checked = producers.length;
  const switchOff = debioSwitchOffAgentIds(producers.map((p) => p.id), { db, env: opts.env });

  const reviewRows = db.prepare("SELECT agent_id, entity_key, org_nr, debio_sid, state FROM debio_match_review WHERE state IN ('approved','rejected')").all() as Array<{ agent_id: string; entity_key: string; org_nr: string | null; debio_sid: string | null; state: string }>;
  const rejectedPairs = new Set(reviewRows.filter((r) => r.state === "rejected").map((r) => `${r.agent_id}|${r.entity_key}`));
  const approved = new Map<string, { org_nr: string | null; debio_sid: string | null }>();
  for (const r of reviewRows) if (r.state === "approved") approved.set(r.agent_id, r);

  const streetPeers = buildStreetPeers(producers);
  type Matched = { p: Producer; entity: Entity | null; method: SikkerMethod | null; review: Candidate[] };
  const matchedList: Matched[] = [];
  for (const p of producers) {
    let entity: Entity | null = null;
    let method: SikkerMethod | null = null;
    let review: Candidate[] = [];
    const a = approved.get(p.id);
    if (a) {
      entity = (a.org_nr ? ix.byOrgNr.get(a.org_nr) : undefined) ?? (a.debio_sid ? ix.bySid.get(a.debio_sid) : undefined) ?? null;
      if (entity) method = "review";
    }
    if (!entity) {
      try {
        const m = matchProducer(p, ix, finnokoByDomain, rejectedPairs, streetPeers);
        if (m.sikker) { entity = m.sikker.entity; method = m.sikker.method; }
        review = m.review;
      } catch (e) {
        result.errors.push(`match failed for agent ${p.id}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
    }
    matchedList.push({ p, entity, method, review });
  }

  // One register entity, several of our producers: a weak "sikker" method
  // (name / street) is then not sure for any of them → all to review.
  // org_nr, tag_org_nr, finnoko_domain and approved review matches stay.
  const WEAK: ReadonlySet<SikkerMethod> = new Set<SikkerMethod>(["name_postal", "street_postal", "street_city"]);
  const perEntity = new Map<string, number>();
  for (const m of matchedList) if (m.entity && m.method) perEntity.set(m.entity.key, (perEntity.get(m.entity.key) ?? 0) + 1);
  for (const m of matchedList) {
    if (!m.entity || !m.method || !WEAK.has(m.method) || (perEntity.get(m.entity.key) ?? 0) < 2) continue;
    const kind = m.method === "name_postal" ? "name" : "street";
    m.review = [{ entity: m.entity, method: kind, score: 0.8, reasons: [`${m.method}_shared_entity`] },
      ...m.review.filter((c) => c.entity.key !== m.entity!.key)];
    m.entity = null;
    m.method = null;
  }

  type Planned = { p: Producer; d: Decision; review: Candidate[] };
  const planned: Planned[] = [];
  for (const { p, entity, method, review } of matchedList) {
    const d = decide(entity, method, switchOff.has(p.id), now);
    if (switchOff.has(p.id)) result.owner_switch_off++;
    if (method) result.matched[method]++;
    result.status_counts[d.status]++;
    if (d.verified) result.verified++;
    result.review_candidates += review.length;
    if (p.old.verified === 1 && d.verified === 0) result.would_reset++;
    planned.push({ p, d, review });
  }

  if (dryRun) return result;

  db.transaction(() => {
    const upsertStatus = db.prepare(UPSERT_STATUS_SQL);
    const updVerified = db.prepare(UPDATE_VERIFIED_SQL);
    const upsertReview = db.prepare(`
      INSERT INTO debio_match_review
        (agent_id, entity_key, debio_sid, org_nr, status, cert_valid_to, product_groups, postal_code, city,
         match_method, score, reasons, state, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(agent_id, entity_key) DO UPDATE SET
        debio_sid = excluded.debio_sid, org_nr = excluded.org_nr, status = excluded.status,
        cert_valid_to = excluded.cert_valid_to, product_groups = excluded.product_groups,
        postal_code = excluded.postal_code, city = excluded.city, match_method = excluded.match_method,
        score = excluded.score, reasons = excluded.reasons, last_seen_at = excluded.last_seen_at
    `);
    const clearPending = db.prepare("DELETE FROM debio_match_review WHERE agent_id = ? AND state = 'pending'");
    for (const { p, d, review } of planned) {
      upsertStatus.run(p.id, d.status, d.validTo, JSON.stringify(d.groups), d.sid, nowIso, d.method);
      updVerified.run(d.verified, d.verified, nowIso, p.id);
      // Logged: every status / verified change, except a never-checked,
      // never-verified producer becoming «ingen» (the first run's bulk).
      const changed = p.old.status !== d.status || p.old.verified !== d.verified;
      const firstIngen = p.old.status === null && p.old.verified === 0 && d.status === "ingen";
      if (changed && !firstIngen) {
        logChange(db, p.id, p.old, d, "register_sync", nowIso);
        result.changes++;
      }
      if (d.method !== null) {
        clearPending.run(p.id);
      } else {
        for (const c of review) {
          const e = c.entity;
          upsertReview.run(p.id, e.key, e.sid, e.orgNr, e.status, e.validTo, JSON.stringify(e.productGroups),
            e.postalCodes[0] ?? null, e.cities[0] ?? null, c.method, Math.round(c.score * 100) / 100, JSON.stringify(c.reasons), nowIso, nowIso);
        }
      }
    }
    updateState(db, { last_attempt_at: nowIso, last_success_at: nowIso, last_success_rows: fetched.rows.length, last_reject_reason: null });
  })();

  console.log(
    `[debio-register] rows=${result.normalized} rejected_rows=${result.rejected_rows} entities=${result.entities} ` +
    `verified=${result.verified} review=${result.review_candidates} reset=${result.would_reset} changes=${result.changes}`,
  );
  return result;
}

// ─── match review (admin) ───────────────────────────────────────────────────

export interface MatchReviewItem {
  id: number;
  agent: { id: string; name: string | null; city: string | null; postal_code: string | null; org_nr: string | null };
  debio: { sid: string | null; org_nr: string | null; status: string; cert_valid_to: string | null; product_groups: string[]; postal_code: string | null; city: string | null; source_url: string | null };
  match_method: string;
  score: number | null;
  reasons: string[];
  state: string;
  first_seen_at: string;
  last_seen_at: string;
  decided_at: string | null;
}

function jsonList(v: unknown): string[] {
  if (typeof v !== "string") return [];
  try { const x = JSON.parse(v); return Array.isArray(x) ? x.filter((s) => typeof s === "string") : []; } catch { return []; }
}

/** Review candidates (agent side + Debio sid / city / postal code + reason codes; no Debio names). */
export function listMatchReview(db: Database.Database, state: "pending" | "approved" | "rejected" | "all" = "pending", limit = 200): MatchReviewItem[] {
  const rows = db.prepare(`
    SELECT r.*, a.name AS agent_name, a.city AS agent_city, a.org_nr AS agent_org_nr, k.postal_code AS agent_postal
    FROM debio_match_review r
    LEFT JOIN agents a ON a.id = r.agent_id
    LEFT JOIN agent_knowledge k ON k.agent_id = r.agent_id
    WHERE (? = 'all' OR r.state = ?)
    ORDER BY r.score DESC, r.id ASC
    LIMIT ?
  `).all(state, state, limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    agent: { id: r.agent_id, name: r.agent_name ?? null, city: r.agent_city ?? null, postal_code: r.agent_postal ?? null, org_nr: r.agent_org_nr ?? null },
    debio: {
      sid: r.debio_sid, org_nr: r.org_nr, status: r.status, cert_valid_to: r.cert_valid_to,
      product_groups: jsonList(r.product_groups), postal_code: r.postal_code, city: r.city,
      source_url: r.debio_sid ? `https://portal.debio.no/ACM/?certSid=${encodeURIComponent(r.debio_sid)}` : null,
    },
    match_method: r.match_method,
    score: r.score,
    reasons: jsonList(r.reasons),
    state: r.state,
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    decided_at: r.decided_at,
  }));
}

/**
 * Approve: the agent gets the candidate's status (method `review`), verified
 * only for okologisk with a valid certificate and auto.debio not off; later
 * runs keep it while the entity stays in the register. Reject: never proposed
 * again for this agent. Returns null for an unknown id.
 */
export function decideMatchReview(
  db: Database.Database,
  id: number,
  action: "approve" | "reject",
  opts: { now?: Date; env?: NodeJS.ProcessEnv } = {},
): { id: number; state: string; agent_id: string; debio_status?: string; debio_verified?: number } | null {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const r = db.prepare("SELECT * FROM debio_match_review WHERE id = ?").get(id) as any;
  if (!r) return null;
  if (action === "reject") {
    db.prepare("UPDATE debio_match_review SET state = 'rejected', decided_at = ? WHERE id = ?").run(nowIso, id);
    return { id, state: "rejected", agent_id: r.agent_id };
  }
  const old = db.prepare("SELECT s.debio_status, a.debio_verified, s.debio_sid FROM agents a LEFT JOIN agent_debio_status s ON s.agent_id = a.id WHERE a.id = ?").get(r.agent_id) as any;
  if (!old) return null;
  const switchOff = debioSwitchOffAgentIds([r.agent_id], { db, env: opts.env }).has(r.agent_id);
  const status = (["okologisk", "karens", "annet", "ingen"].includes(r.status) ? r.status : "annet") as DebioStatus;
  const verified: 0 | 1 = status === "okologisk" && certValidOn(r.cert_valid_to, now) && !switchOff ? 1 : 0;
  db.transaction(() => {
    // One approved candidate per agent: an earlier approval for another entity is withdrawn.
    db.prepare("UPDATE debio_match_review SET state = 'pending', decided_at = NULL WHERE agent_id = ? AND state = 'approved' AND id <> ?").run(r.agent_id, id);
    db.prepare("UPDATE debio_match_review SET state = 'approved', decided_at = ? WHERE id = ?").run(nowIso, id);
    db.prepare(UPSERT_STATUS_SQL).run(r.agent_id, status, r.cert_valid_to, r.product_groups ?? "[]", r.debio_sid, nowIso, "review");
    db.prepare(UPDATE_VERIFIED_SQL).run(verified, verified, nowIso, r.agent_id);
    logChange(db, r.agent_id, { status: old.debio_status ?? null, verified: old.debio_verified === 1 ? 1 : 0, sid: old.debio_sid ?? null, method: null, validTo: null },
      { status, verified, reason: switchOff ? "owner_switch_off" : "review_approved", sid: r.debio_sid }, "review", nowIso);
  })();
  return { id, state: "approved", agent_id: r.agent_id, debio_status: status, debio_verified: verified };
}
