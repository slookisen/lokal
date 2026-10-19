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
// shows «Akuttvakt» (with a stored quote, F1-S4c) or «Tar imot
// akuttpasienter»; the text says «akuttvakt med lagret sitat eller … tar imot
// akuttpasienter» (A2A dev-request 2026-10-16-finn-tannlege-fasettsider,
// F1-S4e point 13). No new JSON check lives here. `verified` counts the same
// way, with the SQL twin of resolveVerifiedClaim (A2A dev-request
// 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon, F2-S8): the clinics
// whose card shows «Verifisert».
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
// The facet pages (A2A dev-request 2026-10-16-finn-tannlege-fasettsider,
// F1-S4: /sted/<sted>/<fasett>, /fylke/<fylke>/<fasett>) read the same counts
// over the clinics in each facet (DentalAreaCounts.facets), from the same
// scan: one column per DENTAL_LANDING_FACETS entry, built from the facet's
// store filter by the store's own clause builder (dentalPublicFilterClauses),
// so a facet is counted with the SQL its page lists the clinics with. A
// fylke's facet counts also say how many of the clinics have each poststed
// (DentalAreaCounts.poststeder), so a fylke facet page that lists exactly
// the clinics of one /sted facet page is found from memory.
//
// buildDentalAreaLanding() and buildDentalFacetLanding() turn the numbers
// into the answer-first paragraph, the fact table and the FAQ through the
// vertical-neutral services/landing-facts.ts. It only reads; it writes
// nothing.
//
// The store, db-factory and their handle are required per call (not imported
// at the top) and the cache is kept per DB handle, so a test that swaps those
// modules for a fresh in-memory DB never reads another DB's numbers.

import { createSwrCache, type SwrCache } from "./offthread-stats";
import { DENTAL_ACUTE_CLAIM_SQL } from "./dental-acute-claim";
import { dentalVerifiedClaimSql } from "./dental-verified-claim";
import { clinicSpecialties } from "../config/dental-search-vocabulary";
import { DENTAL_STATS_TTL_MS } from "./dental-search-gazetteer";
import { DENTAL_EMERGENCY_NOTICE, DENTAL_LANDING_CONFIG, DENTAL_LANDING_FACETS, type DentalLandingFacet } from "../config/dental-landing";
import {
  buildAnswerFirst,
  buildFactFaq,
  passesLandingGate,
  type FactFaq,
  type LandingFacts,
  type LandingQa,
} from "./landing-facts";

/** The numbers for one place or one fylke. */
export interface DentalAreaCounts {
  total: number;
  /** Clinics that show «Verifisert» (the read-time claim, F2-S8). */
  verified: number;
  /** helfo_agreement = 'true': what the clinics' own websites say. */
  helfo_true: number;
  /** Clinics that show an akutt claim (DENTAL_ACUTE_CLAIM_SQL). */
  acute_sourced: number;
  /** Clinics whose card shows a specialty (clinicSpecialties(row).length > 0). */
  specialist_clinics: number;
  /** Newest updated_at among the clinics ("YYYY-MM-DD HH:MM:SS"), or null. */
  max_updated_at: string | null;
  /**
   * The same counts over the clinics in each facet, by DENTAL_LANDING_FACETS
   * slug (F1-S4); a facet without a clinic here has no entry. Read it with a
   * slug from the config, never one from a URL.
   */
  facets?: Record<string, DentalAreaCounts>;
  /**
   * On a fylke's facet counts only (byFylke, F1-S4a): the stored poststed of
   * the facet's clinics in the fylke and how many have each. A clinic with
   * no poststed is in `total` but not here. It tells whether a /sted facet
   * page lists exactly the same clinics (routes/dental-seo.ts). sumAreaCounts
   * does not add it up.
   */
  poststeder?: Map<string, number>;
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
  for (const [slug, fc] of Object.entries(c.facets ?? {})) addInto((into.facets ??= {})[slug] ??= emptyCounts(), fc);
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
  // One 0/1 column per facet: its filter's own clauses, parameters prefixed
  // per facet so two specialty facets do not share a name.
  const facetColumns = DENTAL_LANDING_FACETS.map((facet, i) => {
    const m = store.dentalPublicFilterClauses(facet.filter, `facet${i}_`);
    Object.assign(params, m.params);
    return `, CASE WHEN ${facet.filter.specialty ? `${SPECIALTY_CANDIDATE_SQL} AND ` : ""}${m.sql} THEN 1 ELSE 0 END`;
  });
  // Raw rows (arrays, in this column order): one scan, no object per row.
  const rows = db.prepare(
    "SELECT poststed, fylke," +
    ` CASE WHEN ${dentalVerifiedClaimSql()} THEN 1 ELSE 0 END,` +
    " CASE WHEN helfo_agreement = 'true' THEN 1 ELSE 0 END," +
    ` CASE WHEN ${DENTAL_ACUTE_CLAIM_SQL} THEN 1 ELSE 0 END,` +
    ` CASE WHEN ${DATED_UPDATED_AT_SQL} THEN updated_at END,` +
    ` CASE WHEN ${SPECIALTY_CANDIDATE_SQL} THEN 1 ELSE 0 END,` +
    ` CASE WHEN ${SPECIALTY_CANDIDATE_SQL} THEN available_specialties END,` +
    ` CASE WHEN ${SPECIALTY_CANDIDATE_SQL} THEN specialists END` +
    facetColumns.join("") +
    ` FROM dental_agents WHERE ${where.join(" AND ")}`
  ).raw(true).all(params) as Array<[
    poststed: string | null, fylke: string | null,
    verified: number, helfo_true: number, acute_sourced: number, updated_at: string | null,
    specialty_candidate: number, available_specialties: unknown, specialists: unknown,
    ...in_facet: number[],
  ]>;
  const FIRST_FACET_COLUMN = 9;

  const byPoststed = new Map<string, DentalAreaCounts>();
  const byFylke = new Map<string, DentalAreaCounts>();
  const add = (c: DentalAreaCounts, verified: number, helfo: number, acute: number, specialist: number, updatedAt: string | null): void => {
    c.total++;
    c.verified += verified;
    c.helfo_true += helfo;
    c.acute_sourced += acute;
    c.specialist_clinics += specialist;
    if (updatedAt && (!c.max_updated_at || updatedAt > c.max_updated_at)) c.max_updated_at = updatedAt;
  };
  // `inPoststed`: the row's poststed, for a fylke's facet breakdown
  // (DentalAreaCounts.poststeder); null on the poststed map.
  const bump = (
    map: Map<string, DentalAreaCounts>, key: string, row: (typeof rows)[number],
    verified: number, helfo: number, acute: number, specialist: number, updatedAt: string | null,
    inPoststed: string | null
  ): void => {
    let c = map.get(key);
    if (!c) map.set(key, (c = emptyCounts()));
    add(c, verified, helfo, acute, specialist, updatedAt);
    for (let i = 0; i < DENTAL_LANDING_FACETS.length; i++) {
      if (row[FIRST_FACET_COLUMN + i] !== 1) continue;
      const fc = (c.facets ??= {})[DENTAL_LANDING_FACETS[i]!.slug] ??= emptyCounts();
      add(fc, verified, helfo, acute, specialist, updatedAt);
      if (inPoststed) {
        const perPoststed = (fc.poststeder ??= new Map());
        perPoststed.set(inPoststed, (perPoststed.get(inPoststed) ?? 0) + 1);
      }
    }
  };
  for (const row of rows) {
    const [poststed, fylke, verified, helfo, acute, updatedAt, candidate, availableSpecialties, specialists] = row;
    // The cards' specialty predicate, on the columns parsed as the cards' rows are.
    const specialist = candidate === 1 &&
      clinicSpecialties(store.hydrateSpecialtySource({ available_specialties: availableSpecialties, specialists })).length > 0 ? 1 : 0;
    if (poststed) bump(byPoststed, poststed, row, verified, helfo, acute, specialist, updatedAt, null);
    if (fylke) bump(byFylke, fylke, row, verified, helfo, acute, specialist, updatedAt, poststed);
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

/** What a facet page says on top of the area text (F1-S4). */
export interface DentalFacetLanding extends DentalAreaLanding {
  /** The lead and what every clinic in the facet has, plain text (the meta description). */
  summary: string;
  /**
   * The same without a number, for a page whose list and aggregate disagree
   * (the cache a little behind the data), which states no count: «Oversikt
   * over tannlegeklinikker med akuttvakt i Vestland. Alle oppgir akuttvakt
   * med lagret sitat.»
   */
  uncountedSummary: string;
}

/** The facts the landing gates weigh: every count except the clinic total, which is the listing count. */
function gateFacts(c: DentalAreaCounts): LandingFacts & { listings: number } {
  return { listings: c.total, verified: c.verified, helfo_true: c.helfo_true, acute_sourced: c.acute_sourced, specialist_clinics: c.specialist_clinics };
}

/**
 * True when a facet's clinics in one place are enough for a page of their
 * own (DENTAL_LANDING_CONFIG.facets). The facet route, the sitemap and the
 * links from /sted and /fylke all ask this, so a facet URL in the sitemap
 * always answers 200, and one under the gate is a 404 everywhere.
 */
export function passesDentalFacetGate(counts: DentalAreaCounts | undefined): boolean {
  return counts !== undefined && passesLandingGate(gateFacts(counts), DENTAL_LANDING_CONFIG.facets);
}

interface FacetWords {
  /** What the clinics have, after «med»: «kjeveortopedi», «akuttvakt». */
  feature: string;
  /** The count the facet is named for. It is the clinic total, so it is not stated again. */
  own: "helfo_true" | "acute_sourced" | "specialist_clinics";
  /** What every clinic in the facet has, worded for one clinic or for several. */
  definition(single: boolean): string;
  /** Said after the count in the FAQ answer (for akutt the emergency notice, F1-S4e point 14). */
  advice: string;
}

function facetWords(facet: DentalLandingFacet): FacetWords {
  const all = (single: boolean): string => (single ? "Den" : "Alle");
  switch (facet.kind) {
    case "helfo":
      return {
        feature: "Helfo-direkteoppgjør",
        own: "helfo_true",
        definition: (single) => `${all(single)} oppgir Helfo-direkteoppgjør ifølge ${single ? "klinikkens egen nettside" : "klinikkenes egne nettsider"}.`,
        advice: "Bekreft alltid med klinikken før du bestiller time.",
      };
    case "tannlegevakt":
      return { feature: "akuttvakt", own: "acute_sourced", definition: (single) => `${all(single)} oppgir akuttvakt med lagret sitat.`, advice: DENTAL_EMERGENCY_NOTICE.text };
    case "specialty": {
      const navn = facet.filter.specialty ?? "";
      return {
        feature: navn,
        own: "specialist_clinics",
        definition: (single) => `${navn.charAt(0).toUpperCase()}${navn.slice(1)} er oppført som spesialitet hos ${single ? "den" : "hver av dem"}.`,
        advice: "",
      };
    }
  }
}

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
  const { summary: _summary, uncountedSummary: _uncounted, ...landing } = buildLanding(counts, opts, null);
  return landing;
}

/**
 * The same for a facet page: `counts` are the facet's own (the place's
 * counts.facets[facet.slug]). The text says what the clinics have («med
 * kjeveortopedi og poststed Bergen», «med akuttvakt i Vestland») and what
 * that means (Helfo «ifølge klinikkenes egne nettsider», akutt «med lagret sitat»),
 * and leaves out the count the facet is named for. The FAQ follows the facet
 * gate (passesDentalFacetGate), which the page itself is behind.
 */
export function buildDentalFacetLanding(
  counts: DentalAreaCounts,
  opts: { name: string; url: string; scope: DentalAreaScope; facet: DentalLandingFacet }
): DentalFacetLanding {
  return buildLanding(counts, opts, opts.facet);
}

function buildLanding(
  counts: DentalAreaCounts,
  opts: { name: string; url: string; scope: DentalAreaScope },
  facet: DentalLandingFacet | null
): DentalFacetLanding {
  const { name, scope } = opts;
  const n = counts.total;
  const words = facet ? facetWords(facet) : null;
  /** A count worth a sentence: above zero, and not the one the facet is named for. */
  const states = (k: FacetWords["own"] | "verified"): boolean => counts[k] > 0 && words?.own !== k;
  const plural = (k: number, one: string, many: string): string => (k === 1 ? one : many);
  const clinics = `${nb(n)} ${plural(n, "tannlegeklinikk", "tannlegeklinikker")}`;
  /** « med kjeveortopedi» on a facet page, "" on an area page. */
  const withFeature = words ? ` med ${words.feature}` : "";
  /** «med poststed Bergen» / «i Vestland», after a noun; «med kjeveortopedi og poststed Bergen» / «med kjeveortopedi i Vestland» for a facet. */
  const where = scope === "poststed"
    ? `med ${words ? `${words.feature} og ` : ""}poststed ${name}`
    : `${words ? `med ${words.feature} ` : ""}i ${name}`;
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
      : `I ${name} har vi ${clinics}${withFeature} i oversikten.`,
  ];
  if (words) sentences.push(words.definition(n === 1));
  const summary = sentences.join(" ");
  const uncountedSummary = `Oversikt over tannlegeklinikker ${where}.${words ? ` ${words.definition(false)}` : ""}`;
  if (states("helfo_true")) {
    sentences.push(`${n === 1 ? "Den" : `${nb(counts.helfo_true)} av dem`} oppgir Helfo-direkteoppgjør ifølge ${websites(counts.helfo_true)}.`);
  }
  if (states("acute_sourced")) {
    sentences.push(`${lead(counts.acute_sourced)} oppgir akuttvakt med lagret sitat eller ${theyAccept(counts.acute_sourced)}.`);
  }
  if (states("specialist_clinics")) sentences.push(`${lead(counts.specialist_clinics)} har minst én oppført spesialitet.`);
  if (states("verified")) sentences.push(`${lead(counts.verified)} har Verifisert-merket hos Finn-tannlege.`);
  if (updated) sentences.push(`Oversikten ble sist oppdatert ${updated}.`);
  // Where the numbers come from, and «ask the clinic»: one sentence for
  // buildAnswerFirst on an area page, as before, so its text is unchanged; two
  // on a facet page. Its definition sentence leaves room for the 28 words
  // together only when the numbers are short, and the paragraph would
  // otherwise come out under 40 words and be left out.
  const sources = "Opplysningene er hentet fra offentlige registre og fra klinikkenes egne nettsider.";
  const askTheClinic = "Ta kontakt med klinikken direkte for å bekrefte avtaler, priser og åpningstider før du bestiller time.";
  if (words) sentences.push(sources, askTheClinic);
  else sentences.push(`${sources} ${askTheClinic}`);
  const intro = buildAnswerFirst(sentences, { minWords: 40, maxWords: 60 });
  const introHtml = intro ? `<p class="landing-intro" style="font-size:1rem;line-height:1.55;margin-bottom:20px">${escapeHtml(intro)}</p>` : "";

  const rows: Array<[string, string]> = [["Klinikker totalt", nb(n)]];
  if (states("verified")) rows.push(["Med Verifisert-merket", nb(counts.verified)]);
  if (states("helfo_true")) rows.push(["Oppgir Helfo-direkteoppgjør (ifølge klinikkenes nettsider)", nb(counts.helfo_true)]);
  if (states("acute_sourced")) rows.push(["Akuttvakt med lagret sitat eller tar imot akuttpasienter", nb(counts.acute_sourced)]);
  if (states("specialist_clinics")) rows.push(["Med minst én oppført spesialitet", nb(counts.specialist_clinics)]);
  if (updated) rows.push(["Sist oppdatert", updated]);
  const tableHtml =
    `<table class="landing-facts" style="border-collapse:collapse;margin:0 0 24px;width:100%;max-width:640px">` +
    `<caption style="text-align:left;font-weight:600;padding-bottom:6px">Fakta om tannlegeklinikker ${escapeHtml(where)}</caption>` +
    `<tbody>` +
    rows.map(([k, v]) => `<tr><th scope="row" style="text-align:left;font-weight:400;padding:6px 12px 6px 0;border-bottom:1px solid var(--g200,#e5e7eb)">${escapeHtml(k)}</th><td style="padding:6px 0;border-bottom:1px solid var(--g200,#e5e7eb)">${escapeHtml(v)}</td></tr>`).join("") +
    `</tbody></table>`;

  // The FAQ. Each Q/A is built only from a number above zero, in one list
  // that both the visible block and the JSON-LD come from. The questions ask
  // about clinics in the page's scope, as the answers count them. The akutt
  // answer ends with the reviewed emergency notice from its one source,
  // config/dental-landing.ts, as on /hvordan-det-fungerer and in MCP
  // tannlege_akutt (F1-S4e point 14).
  const ofAll = (k: number): string => `${nb(k)} av ${nb(n)} ${plural(n, "klinikk", "klinikker")}`;
  const countTail = words ? ` ${words.definition(n === 1)}${words.advice ? ` ${words.advice}` : ""}` : "";
  const qas: LandingQa[] = [
    scope === "poststed"
      ? { q: `Hvor mange tannlegeklinikker${withFeature} har poststed ${name}?`, a: `Vi har ${clinics} ${where} registrert.${countTail}` }
      : { q: `Hvor mange tannlegeklinikker${withFeature} finnes det i ${name}?`, a: `Vi har ${clinics}${withFeature} registrert i ${name}.${countTail}` },
  ];
  if (states("helfo_true")) {
    qas.push({
      q: `Hvor mange tannlegeklinikker ${where} oppgir Helfo-direkteoppgjør?`,
      a: `${ofAll(counts.helfo_true)} oppgir Helfo-direkteoppgjør ifølge ${websites(counts.helfo_true)}. Bekreft alltid med klinikken før du bestiller time.`,
    });
  }
  if (states("acute_sourced")) {
    qas.push({
      q: `Hvor mange tannlegeklinikker ${where} tar imot akuttpasienter?`,
      a: `${nb(counts.acute_sourced)} ${plural(counts.acute_sourced, "klinikk", "klinikker")} oppgir akuttvakt med lagret sitat eller ${theyAccept(counts.acute_sourced)}. ${DENTAL_EMERGENCY_NOTICE.text}`,
    });
  }
  if (states("specialist_clinics")) {
    qas.push({
      q: `Hvor mange tannlegeklinikker ${where} har en oppført spesialitet?`,
      a: `${ofAll(counts.specialist_clinics)} har minst én oppført spesialitet.`,
    });
  }
  if (states("verified")) {
    qas.push({
      q: `Hvor mange tannlegeklinikker ${where} har Verifisert-merket?`,
      a: `${ofAll(counts.verified)} har Verifisert-merket hos Finn-tannlege.`,
    });
  }
  const gate = words ? passesDentalFacetGate(counts) : passesLandingGate(gateFacts(counts), DENTAL_LANDING_CONFIG.faq);
  const faq: FactFaq = gate ? buildFactFaq(qas, { url: opts.url, minQas: DENTAL_LANDING_CONFIG.faq.minQas }) : { html: "", jsonLd: null };

  return { introHtml, tableHtml, faqHtml: faq.html, faqJsonLd: faq.jsonLd, summary, uncountedSummary };
}
