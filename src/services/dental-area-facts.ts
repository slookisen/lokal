// ─── Facts for the dental /sted and /fylke landing pages (F1-S3) ─────────────
//
// dev-request 2026-10-16-finn-tannlege-landingssider. One aggregate over the
// public clinic set, per poststed and per fylke, cached for the same TTL as
// the poststed list (DENTAL_STATS_TTL_MS), so a landing page reads memory and
// never scans dental_agents. The rows are the ones countPublicDentalAgents()
// counts (buildDentalWhere publicOnly), so a page's «N klinikker» and these
// numbers describe the same clinics.
//
// acute_sourced counts with DENTAL_ACUTE_CLAIM_SQL, the SQL twin of
// resolveAcuteClaim(row) !== null: the clinics /sok?akutt=1 lists, whose card
// shows «Akuttvakt» (with provenance) or «Tar imot akuttpasienter». No new
// JSON check lives here.
//
// specialist_clinics counts the clinics whose card shows a specialty: the
// cards' own predicate, clinicSpecialties(row).length > 0, run in JS over the
// rows that have either specialty column filled (one pass, inside the cached
// computation). A filled column alone is not enough: the deep scrape lists
// every staff member in `specialists` ("Tannlege", "Tannhelsesekretær",
// "Klinikkleiar"), and such a clinic has no specialty on its card.
//
// The numbers are per stored poststed and per stored fylke: a /sted page
// counts the clinics with that poststed (the spellings it lists), not the
// whole kommune /sok?q=<place> also reads, so its text says «med poststed».
//
// buildDentalAreaLanding() turns the numbers into the answer-first paragraph,
// the fact table and the FAQ through the vertical-neutral services/
// landing-facts.ts. It only reads; it writes nothing.
//
// The store, db-factory and their handle are required per call (not imported
// at the top) and the cache is kept per DB handle, so a test that swaps those
// modules for a fresh in-memory DB never reads another DB's numbers.

import { createSwrCache, type SwrCache } from "./offthread-stats";
import { DENTAL_ACUTE_CLAIM_SQL } from "./dental-acute-claim";
import { clinicSpecialties } from "../config/dental-search-vocabulary";
import { DENTAL_STATS_TTL_MS } from "./dental-search-gazetteer";
import { DENTAL_LANDING_CONFIG } from "../config/dental-landing";
import {
  buildAnswerFirst,
  buildFactFaq,
  passesLandingGate,
  type FactFaq,
  type LandingQa,
} from "./landing-facts";

/** The numbers for one place or one fylke. */
export interface DentalAreaCounts {
  total: number;
  verified: number;
  /** helfo_agreement = 'true': what the clinics' own websites say. */
  helfo_true: number;
  /** Clinics that show an akutt claim (DENTAL_ACUTE_CLAIM_SQL). */
  acute_sourced: number;
  /** Clinics whose card shows a specialty (clinicSpecialties(row).length > 0). */
  specialist_clinics: number;
  /** Newest updated_at among the clinics ("YYYY-MM-DD HH:MM:SS"), or null. */
  max_updated_at: string | null;
}

export interface DentalAreaFacts {
  /** By the stored poststed spelling ("BERGEN", "Bergen" are separate keys). */
  byPoststed: Map<string, DentalAreaCounts>;
  /** By the stored fylke value. */
  byFylke: Map<string, DentalAreaCounts>;
}

const CACHE_KEY = "area-facts";

// Rows that MAY show a specialty: a row with neither column filled has none
// (clinicSpecialties reads nothing else). Only a pre-filter for the JS pass,
// never a count of its own.
const SPECIALTY_CANDIDATE_SQL =
  "((specialists IS NOT NULL AND specialists != '[]' AND specialists != '') OR " +
  "(available_specialties IS NOT NULL AND available_specialties != '[]' AND available_specialties != ''))";

// A row whose updated_at does not start with a date neither becomes the
// «Sist oppdatert» date nor hides the newest real one (a string MAX ranks
// "ukjent" above every date). The same filter the sitemap lastmod uses
// (getDentalAggregateLastmods), so the two dates agree.
const DATED_UPDATED_AT_SQL = "updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'";

const emptyCounts = (): DentalAreaCounts => ({
  total: 0, verified: 0, helfo_true: 0, acute_sourced: 0, specialist_clinics: 0, max_updated_at: null,
});

function addInto(into: DentalAreaCounts, c: DentalAreaCounts): void {
  into.total += c.total;
  into.verified += c.verified;
  into.helfo_true += c.helfo_true;
  into.acute_sourced += c.acute_sourced;
  into.specialist_clinics += c.specialist_clinics;
  if (c.max_updated_at && (!into.max_updated_at || c.max_updated_at > into.max_updated_at)) {
    into.max_updated_at = c.max_updated_at;
  }
}

/** The counts of several stored spellings together (a /sted group). */
export function sumAreaCounts(parts: Array<DentalAreaCounts | undefined>): DentalAreaCounts {
  const sum = emptyCounts();
  for (const p of parts) if (p) addInto(sum, p);
  return sum;
}

interface DbStatement {
  all(params?: unknown): unknown[];
  /** better-sqlite3: rows as arrays of the selected columns, in order. */
  raw(toggle?: boolean): DbStatement;
}
interface DbHandle {
  prepare(sql: string): DbStatement;
}

/**
 * One scan of the public clinic set, folded in JS into the per-poststed and
 * per-fylke maps. SQL works out the plain flags per row (verified, Helfo, the
 * akutt claim, a dated updated_at) and hands over the two specialty columns
 * only for the rows that have one filled; JS runs clinicSpecialties on those.
 * Exported for the benchmark and parity tests; the pages go through
 * getDentalAreaFacts().
 */
export function computeDentalAreaFacts(db: DbHandle): DentalAreaFacts {
  const store = require("./dental-store") as typeof import("./dental-store");
  const { where, params } = store.buildDentalWhere({}, { publicOnly: true });
  // Raw rows (arrays, in this column order): one scan, no object per row.
  const rows = db.prepare(
    "SELECT poststed, fylke," +
    " CASE WHEN verification_status = 'verified' THEN 1 ELSE 0 END," +
    " CASE WHEN helfo_agreement = 'true' THEN 1 ELSE 0 END," +
    ` CASE WHEN ${DENTAL_ACUTE_CLAIM_SQL} THEN 1 ELSE 0 END,` +
    ` CASE WHEN ${DATED_UPDATED_AT_SQL} THEN updated_at END,` +
    ` CASE WHEN ${SPECIALTY_CANDIDATE_SQL} THEN 1 ELSE 0 END,` +
    ` CASE WHEN ${SPECIALTY_CANDIDATE_SQL} THEN available_specialties END,` +
    ` CASE WHEN ${SPECIALTY_CANDIDATE_SQL} THEN specialists END` +
    ` FROM dental_agents WHERE ${where.join(" AND ")}`
  ).raw(true).all(params) as Array<[
    poststed: string | null, fylke: string | null,
    verified: number, helfo_true: number, acute_sourced: number, updated_at: string | null,
    specialty_candidate: number, available_specialties: unknown, specialists: unknown,
  ]>;

  const byPoststed = new Map<string, DentalAreaCounts>();
  const byFylke = new Map<string, DentalAreaCounts>();
  const bump = (
    map: Map<string, DentalAreaCounts>, key: string,
    verified: number, helfo: number, acute: number, specialist: number, updatedAt: string | null
  ): void => {
    let c = map.get(key);
    if (!c) map.set(key, (c = emptyCounts()));
    c.total++;
    c.verified += verified;
    c.helfo_true += helfo;
    c.acute_sourced += acute;
    c.specialist_clinics += specialist;
    if (updatedAt && (!c.max_updated_at || updatedAt > c.max_updated_at)) c.max_updated_at = updatedAt;
  };
  for (const [poststed, fylke, verified, helfo, acute, updatedAt, candidate, availableSpecialties, specialists] of rows) {
    // The cards' specialty predicate, on the columns parsed as the cards' rows are.
    const specialist = candidate === 1 &&
      clinicSpecialties(store.hydrateSpecialtySource({ available_specialties: availableSpecialties, specialists })).length > 0 ? 1 : 0;
    if (poststed) bump(byPoststed, poststed, verified, helfo, acute, specialist, updatedAt);
    if (fylke) bump(byFylke, fylke, verified, helfo, acute, specialist, updatedAt);
  }
  return { byPoststed, byFylke };
}

// One cache per DB handle: production has one handle; a test with a fresh
// in-memory DB gets a fresh cache.
let caches = new WeakMap<object, SwrCache<DentalAreaFacts>>();

/**
 * The area aggregate, from memory. The first call per DB computes it
 * synchronously (one query); later calls return the cached value and, once it
 * is older than the TTL, refresh it in the background while still returning
 * the old one. Empty maps while the DB is not ready (not cached).
 */
export function getDentalAreaFacts(): DentalAreaFacts {
  let db: DbHandle;
  try {
    db = (require("../database/db-factory") as typeof import("../database/db-factory")).getDb("dental") as unknown as DbHandle;
  } catch {
    return { byPoststed: new Map(), byFylke: new Map() };
  }
  let cache = caches.get(db as object);
  if (!cache) {
    cache = createSwrCache<DentalAreaFacts>({
      ttlMs: DENTAL_STATS_TTL_MS,
      // Read at call time, so a test can move the clock.
      now: () => Date.now(),
      refresh: () => Promise.resolve().then(() => computeDentalAreaFacts(db)),
      // A failing refresh keeps serving the old numbers and retries after
      // the back-off; the warning makes a lasting failure visible. The
      // message only, never a row.
      onError: (_key, err) =>
        console.warn(`[dental-area-facts] background refresh failed: ${err instanceof Error ? err.message : String(err)}`),
    });
    caches.set(db as object, cache);
  }
  if (!cache.has(CACHE_KEY)) {
    try {
      cache.set(CACHE_KEY, computeDentalAreaFacts(db));
    } catch {
      return { byPoststed: new Map(), byFylke: new Map() }; // db not ready
    }
  }
  return cache.get(CACHE_KEY)!.value;
}

/** Test-only: drop every cached aggregate. */
export function __resetDentalAreaFactsForTesting(): void {
  caches = new WeakMap();
}

// ─── Text ────────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const MONTHS_NB = [
  "januar", "februar", "mars", "april", "mai", "juni",
  "juli", "august", "september", "oktober", "november", "desember",
];

/** "2026-10-12 08:30:00" -> "12. oktober 2026"; null for anything that is not a calendar date. */
export function formatNorwegianDate(value: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || "");
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  // Day 0 of the next month is the last day of this one (2026-02-30 is no date).
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  return `${day}. ${MONTHS_NB[month - 1]} ${m[1]}`;
}

const nb = (n: number): string => n.toLocaleString("nb");

export interface DentalAreaLanding {
  /** The 40-60 word answer-first paragraph, or "" when it would be too thin. */
  introHtml: string;
  /** The fact table. */
  tableHtml: string;
  /** The visible FAQ, "" when the gate or the Q/A count says no. */
  faqHtml: string;
  /** FAQPage JSON-LD from the same Q/As as faqHtml, or null. */
  faqJsonLd: Record<string, unknown> | null;
}

/**
 * What a page's numbers count. "poststed": the clinics with that poststed
 * (a /sted page and the spellings it lists), worded «med poststed X», since
 * /sok?q=X also reads the rest of the kommune. "fylke": the clinics in the
 * fylke (a /fylke page), worded «i X».
 */
export type DentalAreaScope = "poststed" | "fylke";

/**
 * The intro, table and FAQ for one place or fylke. `counts.total` must be the
 * page's own clinic count (the caller checks that). `name` is the display
 * name; every value is escaped here. Every statement names what it counts:
 * tannlegeklinikker, in the scope of the page.
 */
export function buildDentalAreaLanding(
  counts: DentalAreaCounts,
  opts: { name: string; url: string; scope: DentalAreaScope }
): DentalAreaLanding {
  const { name, scope } = opts;
  const n = counts.total;
  const plural = (k: number, one: string, many: string): string => (k === 1 ? one : many);
  const clinics = `${nb(n)} ${plural(n, "tannlegeklinikk", "tannlegeklinikker")}`;
  /** «med poststed Bergen» / «i Vestland», after a noun. */
  const where = scope === "poststed" ? `med poststed ${name}` : `i ${name}`;
  const updated = formatNorwegianDate(counts.max_updated_at);
  const websites = (k: number): string => plural(k, "klinikkens nettside", "klinikkenes nettsider");
  /** «at de tar imot» / «at den tar imot». */
  const theyAccept = (k: number): string => `at ${plural(k, "den", "de")} tar imot akuttpasienter`;

  // Only numbers that are above zero are stated, so no Helfo or akutt claim
  // ever appears without one. With one clinic, «Den» stands for it.
  const lead = (k: number): string => (n === 1 ? "Den" : nb(k));
  const sentences: string[] = [
    scope === "poststed"
      ? `Vi har ${clinics} ${where} i oversikten.`
      : `I ${name} har vi ${clinics} i oversikten.`,
  ];
  if (counts.helfo_true > 0) {
    sentences.push(`${n === 1 ? "Den" : `${nb(counts.helfo_true)} av dem`} oppgir Helfo-direkteoppgjør ifølge ${websites(counts.helfo_true)}.`);
  }
  if (counts.acute_sourced > 0) {
    sentences.push(`${lead(counts.acute_sourced)} oppgir akuttvakt med kilde eller ${theyAccept(counts.acute_sourced)}.`);
  }
  if (counts.specialist_clinics > 0) sentences.push(`${lead(counts.specialist_clinics)} har minst én oppført spesialitet.`);
  if (counts.verified > 0) sentences.push(`${lead(counts.verified)} har Verifisert-merket hos Finn-tannlege.`);
  if (updated) sentences.push(`Oversikten ble sist oppdatert ${updated}.`);
  sentences.push("Opplysningene er hentet fra offentlige registre og fra klinikkenes egne nettsider. Ta kontakt med klinikken direkte for å bekrefte avtaler, priser og åpningstider før du bestiller time.");
  const intro = buildAnswerFirst(sentences, { minWords: 40, maxWords: 60 });
  const introHtml = intro ? `<p class="landing-intro" style="font-size:1rem;line-height:1.55;margin-bottom:20px">${escapeHtml(intro)}</p>` : "";

  const rows: Array<[string, string]> = [["Klinikker totalt", nb(n)]];
  if (counts.verified > 0) rows.push(["Med Verifisert-merket", nb(counts.verified)]);
  if (counts.helfo_true > 0) rows.push(["Oppgir Helfo-direkteoppgjør (ifølge klinikkenes nettsider)", nb(counts.helfo_true)]);
  if (counts.acute_sourced > 0) rows.push(["Akuttvakt med kilde eller tar imot akuttpasienter", nb(counts.acute_sourced)]);
  if (counts.specialist_clinics > 0) rows.push(["Med minst én oppført spesialitet", nb(counts.specialist_clinics)]);
  if (updated) rows.push(["Sist oppdatert", updated]);
  const tableHtml =
    `<table class="landing-facts" style="border-collapse:collapse;margin:0 0 24px;width:100%;max-width:640px">` +
    `<caption style="text-align:left;font-weight:600;padding-bottom:6px">Fakta om tannlegeklinikker ${escapeHtml(where)}</caption>` +
    `<tbody>` +
    rows.map(([k, v]) => `<tr><th scope="row" style="text-align:left;font-weight:400;padding:6px 12px 6px 0;border-bottom:1px solid var(--g200,#e5e7eb)">${escapeHtml(k)}</th><td style="padding:6px 0;border-bottom:1px solid var(--g200,#e5e7eb)">${escapeHtml(v)}</td></tr>`).join("") +
    `</tbody></table>`;

  // The FAQ. Each Q/A is built only from a number above zero, in one list
  // that both the visible block and the JSON-LD come from. The questions ask
  // about clinics in the page's scope, as the answers count them.
  const ofAll = (k: number): string => `${nb(k)} av ${nb(n)} ${plural(n, "klinikk", "klinikker")}`;
  const qas: LandingQa[] = [
    scope === "poststed"
      ? { q: `Hvor mange tannlegeklinikker har poststed ${name}?`, a: `Vi har ${clinics} ${where} registrert.` }
      : { q: `Hvor mange tannlegeklinikker finnes det ${where}?`, a: `Vi har ${clinics} registrert ${where}.` },
  ];
  if (counts.helfo_true > 0) {
    qas.push({
      q: `Hvor mange tannlegeklinikker ${where} oppgir Helfo-direkteoppgjør?`,
      a: `${ofAll(counts.helfo_true)} oppgir Helfo-direkteoppgjør ifølge ${websites(counts.helfo_true)}. Bekreft alltid med klinikken før du bestiller time.`,
    });
  }
  if (counts.acute_sourced > 0) {
    qas.push({
      q: `Hvor mange tannlegeklinikker ${where} tar imot akuttpasienter?`,
      a: `${nb(counts.acute_sourced)} ${plural(counts.acute_sourced, "klinikk", "klinikker")} oppgir akuttvakt med kilde eller ${theyAccept(counts.acute_sourced)}. Ring klinikken først og spør om de kan ta deg imot. Ved akutt sykdom eller skade utenfor åpningstid kan du ringe legevakten på 116 117. Ved livstruende situasjoner ringer du 113.`,
    });
  }
  if (counts.specialist_clinics > 0) {
    qas.push({
      q: `Hvor mange tannlegeklinikker ${where} har en oppført spesialitet?`,
      a: `${ofAll(counts.specialist_clinics)} har minst én oppført spesialitet.`,
    });
  }
  if (counts.verified > 0) {
    qas.push({
      q: `Hvor mange tannlegeklinikker ${where} har Verifisert-merket?`,
      a: `${ofAll(counts.verified)} har Verifisert-merket hos Finn-tannlege.`,
    });
  }
  const cfg = DENTAL_LANDING_CONFIG.faq;
  const gate = passesLandingGate(
    { listings: n, verified: counts.verified, helfo_true: counts.helfo_true, acute_sourced: counts.acute_sourced, specialist_clinics: counts.specialist_clinics },
    { minListings: cfg.minListings, minFacts: cfg.minFacts }
  );
  const faq: FactFaq = gate ? buildFactFaq(qas, { url: opts.url, minQas: cfg.minQas }) : { html: "", jsonLd: null };

  return { introHtml, tableHtml, faqHtml: faq.html, faqJsonLd: faq.jsonLd };
}
