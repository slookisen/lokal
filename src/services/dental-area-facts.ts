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
// buildDentalAreaLanding() turns the numbers into the answer-first paragraph,
// the fact table and the FAQ through the vertical-neutral services/
// landing-facts.ts. It only reads; it writes nothing.
//
// The store, db-factory and their handle are required per call (not imported
// at the top) and the cache is kept per DB handle, so a test that swaps those
// modules for a fresh in-memory DB never reads another DB's numbers.

import { createSwrCache, type SwrCache } from "./offthread-stats";
import { DENTAL_ACUTE_CLAIM_SQL } from "./dental-acute-claim";
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

const SPECIALIST_SQL =
  "((specialists IS NOT NULL AND specialists != '[]' AND specialists != '') OR " +
  "(available_specialties IS NOT NULL AND available_specialties != '[]' AND available_specialties != ''))";

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

interface DbHandle {
  prepare(sql: string): { all(params?: unknown): unknown[] };
}

/**
 * One GROUP BY poststed, fylke over the public clinic set, folded in JS into
 * the per-poststed and per-fylke maps. Exported for the benchmark and parity
 * tests; the pages go through getDentalAreaFacts().
 */
export function computeDentalAreaFacts(db: DbHandle): DentalAreaFacts {
  const store = require("./dental-store") as typeof import("./dental-store");
  const { where, params } = store.buildDentalWhere({}, { publicOnly: true });
  const rows = db.prepare(
    "SELECT poststed, fylke, COUNT(*) AS total," +
    " SUM(CASE WHEN verification_status = 'verified' THEN 1 ELSE 0 END) AS verified," +
    " SUM(CASE WHEN helfo_agreement = 'true' THEN 1 ELSE 0 END) AS helfo_true," +
    ` SUM(CASE WHEN ${DENTAL_ACUTE_CLAIM_SQL} THEN 1 ELSE 0 END) AS acute_sourced,` +
    ` SUM(CASE WHEN ${SPECIALIST_SQL} THEN 1 ELSE 0 END) AS specialist_clinics,` +
    " MAX(updated_at) AS max_updated_at" +
    ` FROM dental_agents WHERE ${where.join(" AND ")} GROUP BY poststed, fylke`
  ).all(params) as Array<DentalAreaCounts & { poststed: string | null; fylke: string | null }>;

  const byPoststed = new Map<string, DentalAreaCounts>();
  const byFylke = new Map<string, DentalAreaCounts>();
  for (const r of rows) {
    const c: DentalAreaCounts = {
      total: r.total, verified: r.verified, helfo_true: r.helfo_true,
      acute_sourced: r.acute_sourced, specialist_clinics: r.specialist_clinics,
      max_updated_at: r.max_updated_at ?? null,
    };
    if (r.poststed) {
      let p = byPoststed.get(r.poststed);
      if (!p) byPoststed.set(r.poststed, (p = emptyCounts()));
      addInto(p, c);
    }
    if (r.fylke) {
      let f = byFylke.get(r.fylke);
      if (!f) byFylke.set(r.fylke, (f = emptyCounts()));
      addInto(f, c);
    }
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
      refresh: () => Promise.resolve().then(() => computeDentalAreaFacts(db)),
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

/** "2026-10-12 08:30:00" -> "12. oktober 2026"; null for anything that is not a date. */
export function formatNorwegianDate(value: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || "");
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${Number(m[3])}. ${MONTHS_NB[month - 1]} ${m[1]}`;
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
 * The intro, table and FAQ for one place or fylke. `counts.total` must be the
 * page's own clinic count (the caller checks that). `name` is the display
 * name; every value is escaped here.
 */
export function buildDentalAreaLanding(
  counts: DentalAreaCounts,
  opts: { name: string; url: string }
): DentalAreaLanding {
  const { name } = opts;
  const n = counts.total;
  const clinics = `${nb(n)} ${n === 1 ? "tannlegeklinikk" : "tannlegeklinikker"}`;
  const updated = formatNorwegianDate(counts.max_updated_at);

  // Only numbers that are above zero are stated, so no Helfo or akutt claim
  // ever appears without one.
  const sentences: string[] = [`I ${name} har vi ${clinics} i oversikten.`];
  if (counts.helfo_true > 0) sentences.push(`${nb(counts.helfo_true)} av dem oppgir Helfo-direkteoppgjør ifølge klinikkenes nettsider.`);
  if (counts.acute_sourced > 0) sentences.push(`${nb(counts.acute_sourced)} oppgir akutt-tilbud med kilde, som akuttvakt eller at de tar imot akuttpasienter.`);
  if (counts.specialist_clinics > 0) sentences.push(`${nb(counts.specialist_clinics)} har oppført spesialister eller spesialiteter.`);
  if (counts.verified > 0) sentences.push(`${nb(counts.verified)} har verifisert oppføring i registeret.`);
  if (updated) sentences.push(`Oversikten ble sist oppdatert ${updated}.`);
  sentences.push("Opplysningene er hentet fra offentlige registre og fra klinikkenes egne nettsider. Ta kontakt med klinikken direkte for å bekrefte avtaler, priser og åpningstider før du bestiller time.");
  const intro = buildAnswerFirst(sentences, { minWords: 40, maxWords: 60 });
  const introHtml = intro ? `<p class="landing-intro" style="font-size:1rem;line-height:1.55;margin-bottom:20px">${escapeHtml(intro)}</p>` : "";

  const rows: Array<[string, string]> = [["Klinikker totalt", nb(n)]];
  if (counts.verified > 0) rows.push(["Med verifisert oppføring", nb(counts.verified)]);
  if (counts.helfo_true > 0) rows.push(["Oppgir Helfo-direkteoppgjør (ifølge klinikkenes nettsider)", nb(counts.helfo_true)]);
  if (counts.acute_sourced > 0) rows.push(["Akutt-tilbud med kilde", nb(counts.acute_sourced)]);
  if (counts.specialist_clinics > 0) rows.push(["Med spesialister eller spesialiteter", nb(counts.specialist_clinics)]);
  if (updated) rows.push(["Sist oppdatert", updated]);
  const tableHtml =
    `<table class="landing-facts" style="border-collapse:collapse;margin:0 0 24px;width:100%;max-width:640px">` +
    `<caption style="text-align:left;font-weight:600;padding-bottom:6px">Fakta om tannleger i ${escapeHtml(name)}</caption>` +
    `<tbody>` +
    rows.map(([k, v]) => `<tr><th scope="row" style="text-align:left;font-weight:400;padding:6px 12px 6px 0;border-bottom:1px solid var(--g200,#e5e7eb)">${escapeHtml(k)}</th><td style="padding:6px 0;border-bottom:1px solid var(--g200,#e5e7eb)">${escapeHtml(v)}</td></tr>`).join("") +
    `</tbody></table>`;

  // The FAQ. Each Q/A is built only from a number above zero, in one list
  // that both the visible block and the JSON-LD come from.
  const qas: LandingQa[] = [
    { q: `Hvor mange tannleger finnes det i ${name}?`, a: `Vi har ${clinics} registrert i ${name}.` },
  ];
  if (counts.helfo_true > 0) {
    qas.push({
      q: `Hvor mange tannleger i ${name} oppgir Helfo-direkteoppgjør?`,
      a: `${nb(counts.helfo_true)} av ${nb(n)} klinikker oppgir Helfo-direkteoppgjør ifølge klinikkenes nettsider. Bekreft alltid med klinikken før du bestiller time.`,
    });
  }
  if (counts.acute_sourced > 0) {
    qas.push({
      q: `Finnes det akutt tannlegehjelp i ${name}?`,
      a: `${nb(counts.acute_sourced)} ${counts.acute_sourced === 1 ? "klinikk" : "klinikker"} oppgir akutt-tilbud med kilde. Ring klinikken først og spør om de kan ta deg imot. Ved akutt sykdom eller skade utenfor åpningstid kan du ringe legevakten på 116 117.`,
    });
  }
  if (counts.specialist_clinics > 0) {
    qas.push({
      q: `Er det spesialister blant tannlegene i ${name}?`,
      a: `${nb(counts.specialist_clinics)} av ${nb(n)} klinikker har oppført spesialister eller spesialiteter.`,
    });
  }
  if (counts.verified > 0) {
    qas.push({
      q: `Hvor mange av klinikkene i ${name} er verifisert?`,
      a: `${nb(counts.verified)} av ${nb(n)} klinikker har verifisert oppføring i registeret.`,
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
