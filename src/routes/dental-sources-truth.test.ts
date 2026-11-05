/**
 * dental-sources-truth.test.ts — A2A dev-request
 * 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon, F2-S1 (honest data
 * sources, from one list), F2-S2 (the method page «Metode og kilder») and
 * F2-S9 (the directory import of May 2026 in the list, interim).
 *
 * Finn-tannlege.com names no data source it does not use, and every surface
 * reads DENTAL_DATA_SOURCES (src/services/dental-data-sources.ts). HPR, NTF
 * and Helsedirektoratet are not sources: no client exists, and each comes
 * later as its own case (Daniel 2026-10-18, question 14). Covers:
 *   (a) the list: well-formed; every entry has code behind it (one grounding
 *       check per id, and an id without one fails); Google Places' fields are
 *       in the field mask; Brreg's licence is NLOD 2.0 (data.brreg.no, read
 *       2026-10-19), not CC0; the Kartverket address API is CC BY 4.0
 *       (Kartkatalog, read 2026-10-19); the Kartverket postnummer licence,
 *       credit line and extract date equal the dataset's own meta; the
 *       Brreg date says what the verifier stores (brreg_checked_at on every
 *       lookup, also one Brreg gives no definite answer to); each entry has
 *       its own list label; the name sentences. F2-S9: the directory
 *       import is grounded in src/data/dental-import-2026-05.json (the counts
 *       of A2A dental-phase-a/dental-merge-report-all.md) and rule 4 of
 *       dental-catalog-class.ts; it stays neutral until Daniel has answered
 *       (no url, licence or credit line, no web address, no number besides
 *       the year, not «åpen»); its fields, month and filled columns are the
 *       data file's; Brreg says it applies to clinics with an org.nr., and
 *       the industry codes its method names are the data file's.
 *   (b) the «Verifisert» text matches dental-verifier.ts: its numbers are the
 *       verifier's constants, computeDentalVerifiedRule and
 *       websiteOwnershipMatch give the badge in exactly the cases the text
 *       names, and nothing but the admin route runs the verifier.
 *   (c) no page names a source the list does not have: the front page, /om,
 *       /hvordan-det-fungerer, /proveniens, the other shells, a 404, llms.txt,
 *       openapi.json, ai-plugin.json, the agent and MCP server cards.
 *       /personvern is exempt on purpose: its HPR line belongs to personvern
 *       part B (needs_daniel) and dental-privacy-truth.test.ts locks it. Only
 *       its footer is checked.
 *   (d) the footer's «Datakilder» column is the list's names, each linking
 *       /proveniens, on every page; no link to helsedirektoratet.no or ntf.no.
 *   (e) /om and /hvordan-det-fungerer list exactly the entries, and the
 *       field table on /proveniens (nb and en) is exactly the entries: one
 *       row per field, the source with its link and licence, the method and
 *       the date; /om has each licence's credit line and link; /proveniens
 *       and /hvordan-det-fungerer print the «Verifisert» text.
 *   (f) llms.txt: the intro names the list, «Lisens» is the list's licences
 *       (no CC0, no «HPR-data er offentlig»), the verification section prints
 *       the text in nb and en.
 *   (g) openapi.json: description and licence from the list.
 *   (h) the Claude directory listing names the list; no dental pack file
 *       names HPR, NTF or Helsedirektoratet.
 *   (i) the FINN.no sentence (G3-S8) still stands in the footer, on /om, in
 *       llms.txt and in openapi.json.
 *   (j) one new entry shows on every runtime surface, and is gone again once
 *       it is removed (negative).
 *   (k) no route or spec source hard-codes HPR, NTF or Helsedirektoratet,
 *       outside the /personvern handler and comments.
 *   (l) F2-S2, /proveniens is the method page: title and h1 «Metode og
 *       kilder»; Daniel named as responsible editor (Daniel 2026-10-18,
 *       question 14); the Helfo, akutt and specialty texts, each checked
 *       against the code that shows the badge (Helfo needs a stored source
 *       since F2-S6, and the text says so); needs_review, «sist
 *       kontrollert» and «sist oppdatert»; how to report an error; the live
 *       numbers from the caches only (no query per request, «minst» when a
 *       clinic has no fylke); the repeat-park rule only while
 *       DENTAL_REPEAT_PARK_TO_REVIEW is on; no claim of how often anything
 *       runs.
 *   (m) /om links the method page, and «Om plattformen» no longer claims
 *       continuous verification or an «uverifisert» marking; it says the
 *       profile shows what was checked and when, or «Ikke kontrollert ennå»
 *       (F2-S3), as the profile shows it (not «no other marking»: a closed
 *       clinic shows «Nedlagt»).
 *   (n) F2-S9, as the pages show it: the import's rows in the field table
 *       (nb and en), its item on /om and /hvordan-det-fungerer, the footer,
 *       llms.txt and openapi.json, with no link and no licence; Brreg's
 *       method there says it applies to clinics with an org.nr.
 *
 * Harness as in dental-finn-disambiguation.test.ts: in-memory dental DB, the
 * router driven through router.handle(). dental-data-sources and
 * dental-openapi are swapped out with the routes, so the entry (j) adds to
 * the list lives in this block's copy only.
 *
 * Standalone: npx tsx src/routes/dental-sources-truth.test.ts
 * Wired into tests/test.ts via runDentalSourcesTruthTests().
 */

import * as fs from "fs";
import * as path from "path";

import { BRAND_ENTITIES } from "../config/brand-entities";
import { COMPANY_INFO } from "../config/company-info";
import type { DentalDataSource } from "../services/dental-data-sources";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const ROOT = path.join(__dirname, "..", "..");

/**
 * Names of sources the service does not use. Case-insensitive like the
 * acceptance grep (`grep -ciE 'HPR|Helsepersonellregister|helsedirektoratet\.no|ntf\.no|tannlegeforening'`),
 * widened to the bare words Helsedirektorat(et) and NTF.
 */
export const NOT_A_SOURCE = /HPR|Helsepersonellregister|Helsedirektorat|helsedirektoratet\.no|ntf\.no|tannlegeforening|\bNTF\b/i;

/** F2-S9: the counts of the Phase-A import, which ran outside this repository. */
const IMPORT_FILE = "src/data/dental-import-2026-05.json";
/**
 * The numbers in A2A dental-phase-a/dental-merge-report-all.md (input and
 * match stats) and PHASE6-DENTAL-VERTICAL.md (run date): entities from the
 * Enhetsregisteret search, directory entries fetched, kept as rows without an
 * org.nr., and rows with an org.nr. the directory filled.
 */
const PHASE_A = { run_date: "2026-05-27", entities: 6247, fetched: 2803, withoutOrgnr: 821, filled: 1466 } as const;

interface RouteResult {
  status: number;
  text: string;
  json: any;
}

function callRoute(router: any, urlPath: string): Promise<RouteResult> {
  return new Promise((resolve) => {
    const [p, qs = ""] = urlPath.split("?");
    const req: any = {
      method: "GET",
      url: urlPath,
      originalUrl: urlPath,
      path: p,
      params: {},
      query: Object.fromEntries(new URLSearchParams(qs)),
      headers: {},
      ip: "127.0.0.1",
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      setHeader() { return this; },
      header() { return this; },
      send(payload: any) { resolve({ status: this.statusCode, text: String(payload ?? ""), json: undefined }); return this; },
      json(payload: any) { resolve({ status: this.statusCode, text: JSON.stringify(payload), json: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, text: String(err), json: undefined });
      else resolve({ status: 404, text: "unhandled", json: undefined });
    });
  });
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const unescapeHtml = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&mdash;/g, "—").replace(/&amp;/g, "&");

const footerOf = (html: string): string => html.match(/<footer[\s\S]*?<\/footer>/)?.[0] ?? "";

/** The footer's «Datakilder» column: its links as [href, text]. */
function sourceColumnOf(html: string): { links: Array<[string, string]>; rest: string } {
  const col = footerOf(html).match(/<div class="footer-col">\s*<h4>Datakilder<\/h4>([\s\S]*?)<\/div>/)?.[1] ?? "";
  const links = [...col.matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)].map((m) => [m[1]!, unescapeHtml(m[2]!)] as [string, string]);
  return { links, rest: col.replace(/<a href="[^"]*">[^<]*<\/a>/g, "").trim() };
}

interface ListItem { url: string | null; label: string; rest: string }

/** The source items of the first <ul> after `marker`: name (with its link, if any) and the text after the dash. */
function sourceItemsAfter(html: string, marker: string): ListItem[] {
  const at = html.indexOf(marker);
  if (at < 0) return [];
  const ul = html.slice(at).match(/<ul>([\s\S]*?)<\/ul>/)?.[1] ?? "";
  return [...ul.matchAll(/<li><strong>(?:<a href="([^"]*)" rel="nofollow noopener" target="_blank">)?([^<]*)(?:<\/a>)?<\/strong> &mdash; ([^<]*)<\/li>/g)]
    .map((m) => ({ url: m[1] ? unescapeHtml(m[1]) : null, label: unescapeHtml(m[2]!), rest: unescapeHtml(m[3]!) }));
}

interface MethodGroup {
  id: string;
  /** The row header of each row, in order. */
  fields: string[];
  /** rowspan of the three spanning cells ("" when the source has one field). */
  spans: string[];
  url: string | null;
  label: string;
  licence: { url: string; name: string } | null;
  method: string;
  date: string;
}

/** The field table labelled by `headingId` on /proveniens: one group per <tbody>. */
function methodTableOf(html: string, headingId: string): MethodGroup[] {
  const at = html.indexOf(`<table class="method-table" aria-labelledby="${headingId}">`);
  if (at < 0) return [];
  const table = html.slice(at, html.indexOf("</table>", at));
  return [...table.matchAll(/<tbody data-source="([^"]*)">([\s\S]*?)<\/tbody>/g)].map((g) => {
    const rows = [...g[2]!.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((r) => r[1]!);
    const cells = [...(rows[0] ?? "").matchAll(/<td( rowspan="\d+")?>([\s\S]*?)<\/td>/g)];
    const source = (cells[0]?.[2] ?? "").match(
      /^(?:<a href="([^"]*)" rel="nofollow noopener" target="_blank">)?([^<]*)(?:<\/a>)?(?:<br><span class="method-licence">(?:Lisens|Licence): <a href="([^"]*)" rel="license noopener" target="_blank">([^<]*)<\/a><\/span>)?$/
    );
    return {
      id: g[1]!,
      fields: rows.map((r) => unescapeHtml(r.match(/^<th scope="row">([^<]*)<\/th>/)?.[1] ?? "?")),
      spans: cells.map((c) => c[1] ?? ""),
      url: source?.[1] ? unescapeHtml(source[1]) : null,
      label: unescapeHtml(source?.[2] ?? "?"),
      licence: source?.[3] ? { url: unescapeHtml(source[3]), name: unescapeHtml(source[4]!) } : null,
      method: unescapeHtml(cells[1]?.[2] ?? "?"),
      date: unescapeHtml(cells[2]?.[2] ?? "?"),
    };
  });
}

/** The <p> that starts with `<strong>${lead}</strong>`. */
function paragraphStarting(html: string, lead: string): string {
  return html.match(new RegExp(`<p><strong>${lead}</strong>[\\s\\S]*?</p>`))?.[0] ?? "";
}

/** Lines of a source file that are code (not a // or block-comment line). */
function codeLines(src: string): string[] {
  return src.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*(\s|\/|$))/.test(l));
}

export async function runDentalSourcesTruthTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string, detail?: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
      if (log) console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }
  const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

  const FINN_NB = BRAND_ENTITIES.dental.disambiguation?.nb ?? "";
  const FINN_EN = BRAND_ENTITIES.dental.disambiguation?.en ?? "";

  // ── control: the pattern catches what the old pages said ─────────────
  for (const old of ["Helsedirektoratet / HPR", "https://www.ntf.no/", "Den norske tannlegeforening (NTF)", "Offentlige helseregistre (HPR)", "HPR-data er offentlig", "sourced from Brreg, HPR, and direct enrichment"]) {
    assertTrue(NOT_A_SOURCE.test(old), `z1 control: the pattern catches «${old}»`);
  }
  for (const fine of ["Brønnøysundregistrene", "Kartverket", "Google Places", "Helfo-direkteoppgjør", "klinikkenes egne nettsider"]) {
    assertTrue(!NOT_A_SOURCE.test(fine), `z2 control: the pattern leaves «${fine}» alone`);
  }

  const prevDentalPath = process.env.DENTAL_DB_PATH;
  process.env.DENTAL_DB_PATH = ":memory:";
  // dental-data-sources and dental-openapi too: (j) adds an entry to the
  // list, and it must stay in this block's copy, never the shared one.
  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("../services/dental-data-sources"),
    require.resolve("../services/dental-openapi"),
    require.resolve("./dental-seo"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const dentalSeo = require("./dental-seo") as typeof import("./dental-seo");
    const router = dentalSeo.default as any;
    const src = require("../services/dental-data-sources") as typeof import("../services/dental-data-sources");
    const verifier = require("../services/dental-verifier") as typeof import("../services/dental-verifier");
    const { postnummerDatasetMeta } = require("../services/norway-postnummer") as typeof import("../services/norway-postnummer");
    const areaFacts = require("../services/dental-area-facts") as typeof import("../services/dental-area-facts");
    const { classifyDentalCatalogEntry } = require("../services/dental-catalog-class") as typeof import("../services/dental-catalog-class");
    const S = src.DENTAL_DATA_SOURCES;
    const byId = (id: string): DentalDataSource | undefined => S.find((s) => s.id === id);

    // ── (a) the list ──────────────────────────────────────────────────────
    assertTrue(S.length >= 4, `a1 control: the list is read (${S.length} entries)`);
    assertEq(new Set(S.map((s) => s.id)).size, S.length, "a2: ids are unique");
    for (const s of S) {
      assertTrue(/^[a-z][a-z0-9_]*$/.test(s.id), `a3 ${s.id}: id is a lower-case key`);
      assertTrue([s.name_nb, s.name_en, s.method_nb, s.method_en, s.date_nb, s.date_en].every((t) => t.trim() !== "" && !/[<>&]/.test(t)),
        `a4 ${s.id}: names, methods and dates are set, plain text (the pages escape them)`);
      assertTrue([s.label_nb, s.label_en].every((t) => t === undefined || (t.trim() !== "" && !/[<>&]/.test(t))) && (s.label_nb === undefined) === (s.label_en === undefined),
        `a4b ${s.id}: a list label is plain text, in both languages or neither`);
      assertTrue(s.fields.length > 0 && s.fields.every((f) => f.nb.trim() !== "" && f.en.trim() !== ""), `a5 ${s.id}: fields in nb and en`);
      assertTrue(s.url === null || /^https:\/\/[^\s"<>]+$/.test(s.url), `a6 ${s.id}: url is https or null`);
      assertTrue(!s.license || (/^https:\/\//.test(s.license.url) && s.license.name.trim() !== ""), `a7 ${s.id}: a licence has a name and an https url`);
      assertTrue(!s.attribution || !!s.license, `a8 ${s.id}: a credit line belongs to a licence`);
      assertTrue(!NOT_A_SOURCE.test(JSON.stringify(s)), `a9 ${s.id}: the entry names no HPR, NTF or Helsedirektoratet`);
    }

    // Every entry has code behind it. A new id needs its own check here,
    // written with the integration it lists (no code, no entry). The Phase-A
    // import of 2026-05-27 ran outside this repository (F2-S9): its counts
    // are in a data file, checked against the A2A merge report's numbers.
    const dentalRoute = read("src/routes/dental.ts");
    const verifierSrc = read("src/services/dental-verifier.ts");
    let importData: any = null;
    try { importData = JSON.parse(read(IMPORT_FILE)); } catch { /* a10 and a23 report it */ }
    /** The data file has the merge report's numbers. */
    const importCounted = (d: any): boolean =>
      d?.meta?.run_date === PHASE_A.run_date && d?.enhetsregisteret_search?.entities === PHASE_A.entities &&
      d?.directory_import?.entries_fetched === PHASE_A.fetched && d?.directory_import?.entries_added_without_orgnr === PHASE_A.withoutOrgnr &&
      d?.directory_import?.orgnr_rows_filled === PHASE_A.filled;
    /** The industry codes a text names, each once, sorted. */
    const naceIn = (text: string): string[] => [...new Set(text.match(/\b\d{2}\.\d{3}\b/g) ?? [])].sort();
    /** The text names exactly the industry codes the Phase-A search used (F2-S9). */
    const searchCodesNamed = (text: string, d: any): boolean => {
      const codes = d?.enhetsregisteret_search?.naeringskoder;
      return Array.isArray(codes) && codes.length > 0 && JSON.stringify(naceIn(text)) === JSON.stringify([...codes].sort());
    };
    const GROUNDED: Record<string, () => boolean> = {
      brreg: () =>
        /import \{[^}]*\bverifyOrgNumber\b[^}]*\} from "\.\/brreg-client"/.test(verifierSrc) &&
        /import \{[^}]*\bfetchBrregAddressEvidence\b[^}]*\} from "\.\.\/services\/brreg-client"/.test(read("src/routes/admin-dental-brreg-address-sweep.ts")) &&
        read("src/routes/admin-dental-hjemmeside-discovery.ts").includes('import { fetchBrregWebsite } from "../services/brreg-client"') &&
        [byId("brreg")!.method_nb, byId("brreg")!.method_en].every((t) => searchCodesNamed(t, importData)),
      clinic_websites: () =>
        typeof verifier.websiteOwnershipMatch === "function" &&
        dentalRoute.includes('router.post("/admin/extraction-result"') && dentalRoute.includes('router.post("/admin/stage-v-drift-result"'),
      google_places: () =>
        ["places.formattedAddress", "places.internationalPhoneNumber", "places.websiteUri", "places.regularOpeningHours"].every((f) => dentalRoute.includes(`"${f}"`)) &&
        dentalRoute.includes('source_type: "google_places"'),
      kartverket_geocoding: () => read("src/services/dental-geocode-worker.ts").includes('"https://ws.geonorge.no/adresser/v1/sok"'),
      kartverket_postnummer: () =>
        /^Kartverket/.test(String(postnummerDatasetMeta()?.source ?? "")) &&
        read("src/services/dental-query-parser.ts").includes('from "./norway-postnummer"'),
      // The data file has the merge report's numbers, and the rows without an
      // org.nr. are the ones catalog-class rule 4 classifies (no Brreg metadata).
      katalogimport_2026_05: () =>
        importCounted(importData) &&
        classifyDentalCatalogEntry({ navn: "Kari Nordmann", organisasjonsform: null, naeringskode: null, hjemmeside: null }).rule === "no_brreg_metadata",
    };
    for (const s of S) {
      const check = GROUNDED[s.id];
      assertTrue(!!check && check(), `a10 ${s.id}: the source has code behind it`, check ? "the grounding check failed" : "no grounding check for this id");
    }
    assertTrue(!GROUNDED.unknown_probe, "a10b control: an id with no grounding check has none (it would fail a10)");
    // Google Places' four fields are the four the batch writes (fill-only).
    assertEq(byId("google_places")?.fields.map((f) => f.nb), ["adresse", "telefon", "nettsted", "åpningstider"], "a11: Google Places gives address, phone, website and opening hours (the columns the batch writes)");
    for (const col of ["hjemmeside", "adresse", "telefon", "opening_hours"]) {
      assertTrue(dentalRoute.includes(`patch.${col} =`), `a11b: the Places batch writes ${col}`);
    }
    // Licences.
    assertEq(byId("brreg")?.license, { name: "Norsk lisens for offentlige data (NLOD) 2.0", url: "https://data.norge.no/nlod/no/2.0" },
      "a12: Brønnøysundregistrene's licence is NLOD 2.0 (data.brreg.no, read 2026-10-19)");
    assertTrue(!/CC0|creativecommons\.org\/publicdomain/i.test(JSON.stringify(S)), "a13: no entry says CC0 (regression: «Data fra Brønnøysundregistrene er CC0»)");
    assertEq(byId("brreg")?.attribution, "Inneholder data under Norsk lisens for offentlige data (NLOD) tilgjengeliggjort av Brønnøysundregistrene",
      "a14: Brreg's credit line is NLOD 2.0 §5's default wording");
    const meta = postnummerDatasetMeta();
    const pn = byId("kartverket_postnummer");
    assertTrue(!!meta, "a15 control: the postnummer dataset's meta is read");
    assertEq([pn?.license?.name, pn?.license?.url, pn?.attribution], [meta?.license, meta?.license_url, meta?.attribution],
      "a16: the Kartverket postnummer licence and credit line are the dataset's own (src/data/postnummer-kommune-2026.json meta)");
    // Kartkatalog, «Adresse REST-API» (metadata 44eeffdc-6069-4000-a49b-2d6bfc59ac61,
    // read 2026-10-19): Constraints.OtherConstraintsLinkText «Creative Commons BY 4.0
    // (CC BY 4.0)», OtherConstraintsLink https://creativecommons.org/licenses/by/4.0/,
    // owner Kartverket. Was: no licence (F2-S1 found none in the API documentation).
    const geo = byId("kartverket_geocoding");
    assertEq([geo?.license, geo?.attribution], [{ name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" }, "Inneholder data fra Kartverket (Adresse REST-API)"],
      "a17: the address API is CC BY 4.0 with a credit line (Kartkatalog 44eeffdc-6069-4000-a49b-2d6bfc59ac61, read 2026-10-19)");
    assertEq(geo?.url, "https://kartkatalog.geonorge.no/metadata/44eeffdc-6069-4000-a49b-2d6bfc59ac61", "a17b: the address API links its Kartkatalog record, where the licence is stated");
    // The extract date the postnummer entry states is the dataset's own.
    const extract = meta?.dataset_extract_date ?? "";
    const extractEn = /^\d{4}-\d{2}-\d{2}$/.test(extract)
      ? new Date(`${extract}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
      : "?";
    assertTrue(!!areaFacts.formatNorwegianDate(extract) && pn!.date_nb.includes(`${areaFacts.formatNorwegianDate(extract)}.`) && pn!.date_en.includes(`${extractEn}.`),
      `a17c: the postnummer entry's date is the dataset's extract date (${extract})`, `${pn?.date_nb} / ${pn?.date_en}`);
    // The Brreg date is the verifier's brreg_checked_at, which it stamps on
    // every lookup, also one Brreg gives no definite answer to, and leaves
    // NULL without an org.nr. Driven through the real verifyOrgNumber with a
    // stubbed fetch (no network), on throwaway rows removed before the
    // fixture below is made.
    {
      const brreg = byId("brreg");
      const dates = `${brreg?.date_nb} / ${brreg?.date_en}`;
      assertTrue(!!brreg?.date_nb.endsWith("Når kontrollen slår opp organisasjonsnummeret, lagres datoen for oppslaget, også når registeret ikke gir et sikkert svar.") &&
        !!brreg?.date_en.endsWith("When the check looks up the organisation number, the date of the lookup is stored, also when the register gives no definite answer."),
        "a17d: the Brreg date is the date of the check's lookup, also when Brreg gives no definite answer", dates);
      assertTrue(!/får et sikkert svar|bare når|gets a definite answer|only when/i.test(dates), "a17e: … not only when Brreg gives a definite answer (the verifier does not work that way)", dates);
      const NOW = "2026-10-19T08:00:00.000Z";
      const asked: string[] = [];
      const fetchImpl = (async (url: string) => {
        const orgNr = String(url).split("/").pop() ?? "";
        asked.push(orgNr);
        if (orgNr === "918960091") {
          return new Response(JSON.stringify({ organisasjonsnummer: orgNr, navn: "Svar Tann AS", naeringskode1: { kode: "86.230" } }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (orgNr === "918960092") return new Response("", { status: 503 });
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch;
      const ids = ([["Svar Tann AS", "918960091"], ["Utilgjengelig Tann AS", "918960092"], ["Nettfeil Tann AS", "918960093"], ["Uten Orgnr Tann AS", null]] as const)
        .map(([navn, org_nr]) => store.createDentalAgent({ navn, org_nr, poststed: "OSLO" } as any));
      try {
        const rows = ids.map((id) => db.prepare("SELECT * FROM dental_agents WHERE id = ?").get(id));
        await verifier.runDentalVerifierBatch({ db, pickFn: () => rows as any, fetchImpl, now: () => Date.parse(NOW) });
        const stored = ids.map((id) => db.prepare("SELECT brreg_status, brreg_checked_at FROM dental_agents WHERE id = ?").get(id) as { brreg_status: string | null; brreg_checked_at: string | null });
        assertEq(asked, ["918960091", "918960092", "918960093"], "a17f control: the verifier asked Brreg for each org.nr., and for no clinic without one");
        assertEq(stored.map((r) => [r.brreg_status, r.brreg_checked_at]), [
          ["active", NOW],
          ["orgnr_not_found_or_unreachable", NOW],
          ["orgnr_not_found_or_unreachable", NOW],
          [null, null],
        ], "a17g control: brreg_checked_at is the lookup's date with a definite answer, with an error status and with a network error; NULL without an org.nr.");
      } finally {
        for (const id of ids) db.prepare("DELETE FROM dental_agents WHERE id = ?").run(id);
      }
    }
    // Names and sentences.
    assertEq(src.dentalSourceNames("nb"), ["Brønnøysundregistrene", "klinikkenes egne nettsider (KI-assistert uttrekk)", "Google Places", "Kartverket", "en engangsimport fra en nettkatalog (mai 2026)"],
      "a18: the names, each once (the two Kartverket datasets are one name)");
    assertEq(src.dentalSourceNamesSentence("nb"), "Brønnøysundregistrene, klinikkenes egne nettsider (KI-assistert uttrekk), Google Places, Kartverket og en engangsimport fra en nettkatalog (mai 2026)", "a19: nb sentence");
    assertEq(src.dentalSourceNamesSentence("en"), "Brønnøysundregistrene, the clinics' own websites (AI-assisted extraction), Google Places, Kartverket and a one-time import from an online directory (May 2026)", "a20: en sentence (the spec's OpenAPI wording, and the import)");
    assertEq(src.dentalSourceNameLabels("en"), ["Brønnøysundregistrene", "The clinics' own websites (AI-assisted extraction)", "Google Places", "Kartverket", "A one-time import from an online directory (May 2026)"],
      "a21: the footer's names capitalise the first letter, each once");
    // Each entry has a label of its own in the lists and the field table: the
    // two Kartverket datasets were both «Kartverket» (F2-S1 review).
    for (const lang of ["nb", "en"] as const) {
      const labels = S.map((s) => src.dentalSourceLabel(s, lang));
      assertEq(new Set(labels).size, S.length, `a21b ${lang}: every entry has its own list label (${labels.join(" | ")})`);
    }
    assertEq([byId("kartverket_geocoding"), byId("kartverket_postnummer")].map((s) => [src.dentalSourceLabel(s!, "nb"), src.dentalSourceLabel(s!, "en")]),
      [["Kartverket (adresse-API)", "Kartverket (address API)"], ["Kartverket (postnummerområder)", "Kartverket (postcode areas)"]],
      "a21c: the Kartverket entries are named by dataset");
    assertEq([src.dentalSourceLabel(byId("google_places")!, "nb"), src.dentalSourceLabel(byId("clinic_websites")!, "nb")],
      ["Google Places", "Klinikkenes egne nettsider (KI-assistert uttrekk)"], "a21d: without a label of its own, the label is the capitalised name");
    assertEq([src.dentalFieldLabel({ nb: "om enheten er aktiv", en: "whether the entity is active" }, "nb"), src.dentalFieldLabel({ nb: "x", en: "map position" }, "en")],
      ["Om enheten er aktiv", "Map position"], "a21e: a field as a table label capitalises its first letter");
    assertEq([src.joinDentalList([], "nb"), src.joinDentalList(["a"], "nb"), src.joinDentalList(["a", "b"], "en"), src.joinDentalList(["a", "b", "c"], "nb")],
      ["", "a", "a and b", "a, b og c"], "a22: joinDentalList");

    // F2-S9: the directory import of May 2026, interim until Daniel has
    // decided what happens to its data (A2A FUNN dental-katalogimport-valg-
    // hos-daniel). The data file is the merge report's counts, and nothing else.
    {
      const imp = byId("katalogimport_2026_05");
      const brreg = byId("brreg")!;
      const dir = importData?.directory_import;
      const reg = importData?.enhetsregisteret_search;
      assertTrue(!!imp, "a23 control: the list has the directory import");
      assertTrue(!!importData && importCounted(importData), `a23b: ${IMPORT_FILE} has the merge report's numbers (${JSON.stringify(PHASE_A)})`);
      assertEq((dir?.entries_added_without_orgnr ?? 0) + (dir?.entries_matched_to_orgnr_rows?.by_phone ?? 0) + (dir?.entries_matched_to_orgnr_rows?.by_name_and_postcode ?? 0) + (dir?.entries_not_used ?? 0),
        PHASE_A.fetched, "a23c: every directory entry fetched was kept as its own row, matched to a row with an org.nr., or not used");
      assertEq(Object.values(reg?.entities_by_first_industry_code ?? {}).reduce((a: number, b) => a + Number(b), 0), PHASE_A.entities,
        "a23d: the entities from the Enhetsregisteret search add up by industry code");
      assertEq(Object.keys(reg?.entities_by_first_industry_code ?? {}).filter((k) => k !== "other").sort(), [...(reg?.naeringskoder ?? [])].sort(),
        "a23e: the codes searched are the codes counted (and three entities had another first code)");
      // Counts only: no rows, no names, no contact details, no address of
      // the directory, and no number in its text but the year.
      const strings: string[] = [];
      const walk = (v: unknown): void => {
        if (typeof v === "string") strings.push(v);
        else if (v && typeof v === "object") Object.values(v).forEach(walk);
      };
      // F2-S10 (b): the org.nr. map and its input hashes are checked by
      // dental-import-display.test.ts (org.nr. and column names only).
      const { fields_by_org_nr: _fields, meta: importMeta, ...counted } = importData ?? {};
      const { fields_by_org_nr: _fieldsMeta, ...ownMeta } = importMeta ?? {};
      walk({ meta: ownMeta, ...counted });
      walk(_fieldsMeta?.description);
      const WEB = /https?:|www\.|\b[a-z0-9-]+\.(?:no|com|net|org)\b/i;
      assertEq(Object.keys(importData ?? {}), ["meta", "enhetsregisteret_search", "directory_import", "fields_by_org_nr"], "a24: the data file has counts and the F2-S10 org.nr. map, nothing else (no rows)");
      assertTrue(strings.length > 0 && !strings.some((t) => WEB.test(t)) && strings.every((t) => (t.match(/\d{4}/g) ?? []).every((d) => d === "2026")),
        "a24b: … and its text has no web address and no four-digit number but the year", strings.find((t) => WEB.test(t) || (t.match(/\d{4}/g) ?? []).some((d) => d !== "2026")));
      if (imp) {
        // Neutral until Daniel has answered: no link, licence or credit line.
        assertEq([imp.url, imp.license, imp.attribution], [null, undefined, undefined], "a25: the import entry has no url, licence or credit line until Daniel has answered");
        const { id: _id, ...shown } = imp; // the id is a key, not text
        const text = JSON.stringify(shown);
        assertTrue(!WEB.test(text) && (text.match(/\d+/g) ?? []).every((d) => d === "2026") && !/åpen|\bopen\b/i.test(text),
          "a26: … names no web address and no number but the year, and does not say «åpen» (it could read as an open licence)", text.match(WEB)?.[0] ?? text.match(/åpen|\bopen\b/i)?.[0]);
        assertEq([imp.label_nb, imp.label_en], ["Katalogimport (mai 2026)", "Directory import (May 2026)"], "a26b: its list labels");
        // Its fields are the columns the import wrote on rows without an
        // org.nr.; the columns it filled on rows with one are among them.
        const COLUMN: Record<string, string> = { navn: "navn", adresse: "adresse", telefon: "telefon", nettsted: "hjemmeside" };
        const cols = imp.fields.map((f) => COLUMN[f.nb] ?? `?${f.nb}`);
        assertEq(imp.fields.map((f) => f.nb), ["navn", "adresse", "telefon", "nettsted"], "a27: the import gives name, address, phone and website");
        assertTrue(cols.every((c) => (dir?.fields_on_rows_without_orgnr ?? []).includes(c)), "a27b: … columns the import wrote on rows without an org.nr.", cols.join(", "));
        assertTrue((dir?.fields_filled_on_orgnr_rows_when_empty ?? []).length > 0 && (dir?.fields_filled_on_orgnr_rows_when_empty ?? []).every((c: string) => cols.includes(c)),
          "a27c: … and the columns it filled on rows with an org.nr. are among them");
        // The month is the run date's.
        const run = new Date(`${importData?.meta?.run_date}T00:00:00Z`);
        const month = { nb: run.toLocaleDateString("nb", { month: "long", year: "numeric", timeZone: "UTC" }), en: run.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }) };
        assertEq(month, { nb: "mai 2026", en: "May 2026" }, "a28 control: the run date's month");
        assertTrue([imp.name_nb, imp.label_nb!, imp.method_nb, imp.date_nb, brreg.method_nb].every((t) => t.includes(month.nb)) &&
          [imp.name_en, imp.label_en!, imp.method_en, imp.date_en, brreg.method_en].every((t) => t.includes(month.en)),
          "a28b: the import's name, label, method and date, and Brreg's method, give the run date's month");
        // F2-S10 (d): addresses and websites only (the phone numbers it filled
        // were the Brreg mobile number), and the values are not shown.
        assertTrue(imp.method_nb.includes("for oppføringer uten organisasjonsnummer") && imp.method_nb.includes("tomme adresser og nettsteder på en del klinikker med organisasjonsnummer") &&
          imp.method_nb.includes("Verdiene er ikke hentet på nytt, og ingen kilde er lagret per felt.") &&
          imp.method_nb.endsWith("Verdiene vises ikke på Finn-tannlege før de er hentet på nytt fra en offisiell kilde: fylkeskommunens tannhelseside, Enhetsregisteret eller klinikkens eget nettsted.") &&
          imp.method_en.includes("for listings without an organisation number") && imp.method_en.includes("empty addresses and websites on some clinics with an organisation number") &&
          imp.method_en.includes("The values have not been fetched again, and no source is stored per field.") &&
          imp.method_en.endsWith("The values are not shown on Finn-tannlege until they have been fetched again from an official source: the county's dental health service page, the Central Coordinating Register for Legal Entities (Enhetsregisteret) or the clinic's own website.") &&
          !/telefonnumre|phone numbers/.test(`${imp.method_nb} ${imp.method_en}`),
          "a29: the method: rows without an org.nr. from the import, empty addresses and websites filled on some with one, no source per field, not shown until fetched again from an official source", `${imp.method_nb} / ${imp.method_en}`);
        assertEq([imp.date_nb, imp.date_en], ["Ingen dato per felt. Verdiene er fra mai 2026.", "No date per field. The values are from May 2026."], "a29b: the date: none per field");
      }
      // Brreg applies to clinics with an org.nr., and the clinic list was built
      // by one search by industry code (FUNN dental-brreg-metode-nace-sveip).
      assertTrue(brreg.method_nb.startsWith("Gjelder klinikker med organisasjonsnummer. ") && brreg.method_en.startsWith("Applies to clinics with an organisation number. "),
        "a30: Brreg's method applies to clinics with an org.nr. (no field from the import is credited to Brreg)", brreg.method_nb);
      assertTrue(brreg.method_nb.includes("Klinikklisten ble bygd i mai 2026 med ett søk i Enhetsregisteret etter næringskoden for tannlegetjenester (86.230) og to nærliggende koder (86.221 og 32.500)") &&
        brreg.method_en.includes("The list of clinics was built in May 2026 with one search of the Central Coordinating Register for Legal Entities (Enhetsregisteret) by the industry code for dental practice activities (86.230) and two related codes (86.221 and 32.500)"),
        "a30b: … the clinic list was built by one search of Enhetsregisteret by industry code", brreg.method_en);
      assertTrue(brreg.date_nb.startsWith("Det som kom med søket i mai 2026, har ingen egen dato. ") && brreg.date_en.startsWith("What came with the search in May 2026 has no date of its own. "),
        "a30c: the date names that search, not «the first import»", brreg.date_nb);
      // Negative controls: the grounding checks see a wrong count or code.
      assertTrue(!importCounted(null) && !importCounted({ ...importData, directory_import: { ...dir, entries_fetched: PHASE_A.fetched - 1 } }) &&
        !importCounted({ ...importData, meta: { ...importData?.meta, run_date: "2026-06-27" } }),
        "a31 control: a missing data file, a wrong count or a wrong date fails the import's grounding");
      assertTrue(searchCodesNamed(brreg.method_nb, importData) && !searchCodesNamed("Søk etter 86.230 og 86.221.", importData) &&
        !searchCodesNamed(`${brreg.method_nb} Også 86.900.`, importData) && !searchCodesNamed(brreg.method_nb, null),
        "a31b control: a code left out, a code added or no data file fails Brreg's grounding");
    }

    // ── (b) the «Verifisert» text and the verifier ────────────────────────
    const T = src.DENTAL_VERIFIED_BADGE_TEXT;
    const MIN = verifier.DENTAL_VERIFIER_MIN_RICH_FIELDS;
    const ALL = verifier.DENTAL_RICH_FIELDS.length;
    assertTrue(T.nb.includes(`minst ${MIN} av ${ALL} utvidede profilfelt`) && T.en.includes(`at least ${MIN} of ${ALL} extended profile fields`),
      `b1: the text's numbers are the verifier's (${MIN} of ${ALL} rich fields)`);
    assertTrue(T.nb.includes("tre ganger på rad") && T.en.includes("three times in a row") && verifier.DENTAL_VERIFIER_STREAK_DOWNGRADE_AT === 3,
      "b2: «tre ganger på rad» is DENTAL_VERIFIER_STREAK_DOWNGRADE_AT");
    // F2-S8: no manual way (no review is recorded anywhere), and the badge is
    // shown only on what the check stored (resolveVerifiedClaim, b15-b18).
    assertTrue(T.nb.startsWith("«Verifisert»-merket vises bare når den siste kontrollen fant ") && T.en.startsWith("The \"Verified\" badge is shown only when the latest check found ") &&
      !/administrator|gått gjennom profilen|settes på to måter/i.test(T.nb) && !/administrator|reviewed the profile|one of two ways/i.test(T.en),
      "b3: one way: the badge shows only when the latest check found the conditions; no manual way");
    assertTrue(T.nb.includes("Kontrollen kjøres i dag manuelt, i små partier") && T.en.includes("The check is run by hand today, in small batches"), "b4: the check is run by hand, in small batches");
    assertTrue(!NOT_A_SOURCE.test(T.nb + T.en) && !/[<>&]/.test(T.nb + T.en), "b5: the text names no HPR and has no HTML-special characters besides quotes");
    const rule = verifier.computeDentalVerifiedRule;
    const base = { brregStatus: "active" as const, websiteOwnership: "verified" as const, catalogClass: "klinikk" as const, directoryUrl: null, richFieldCount: MIN };
    assertTrue(rule(base), "b6: active in Brreg + own website + enough fields -> the badge");
    for (const st of ["dissolved", "bankrupt", "inactive_other", "orgnr_not_found_or_unreachable", null] as const) {
      assertTrue(!rule({ ...base, brregStatus: st }), `b7: Brreg status ${st} -> no badge («enheten er aktiv i Brønnøysundregistrene»)`);
    }
    assertTrue(!rule({ ...base, websiteOwnership: "unverified" }) && !rule({ ...base, websiteOwnership: null }), "b8: website not confirmed -> no badge");
    assertTrue(!rule({ ...base, richFieldCount: MIN - 1 }), `b9: ${MIN - 1} fields -> no badge`);
    assertTrue(rule({ ...base, websiteOwnership: "n/a", catalogClass: "offentlig_klinikk", directoryUrl: "https://example.org/klinikk" }),
      "b10: a public clinic with a directory listing -> the badge («en katalogoppføring kan erstatte kravet om bekreftet nettsted»)");
    assertTrue(!rule({ ...base, websiteOwnership: "n/a", catalogClass: "offentlig_klinikk", directoryUrl: null }) &&
      !rule({ ...base, websiteOwnership: "unverified", catalogClass: "klinikk", directoryUrl: "https://example.org/klinikk" }),
      "b11: … but no listing, or a listing for a private clinic, gives none");
    const own = { orgNr: "918960001", navn: "Sentrum Tannklinikk AS", poststed: "OSLO", postnummer: "0150" };
    assertTrue(verifier.websiteOwnershipMatch("Org.nr. 918 960 001", own).matched &&
      verifier.websiteOwnershipMatch("Sentrum Tannklinikk, Storgata 1, 0150 Oslo", own).matched &&
      !verifier.websiteOwnershipMatch("Sentrum Tannklinikk", own).matched,
      "b12: «the page shows the org.nr., or the name together with town or postcode»: the name alone is not enough");
    assertTrue(verifier.DENTAL_VERIFIER_NACE_ALLOWLIST.length > 0 && /naceMismatch[\s\S]{0,200}needs_review/.test(verifierSrc),
      "b13: an industry code that does not fit takes the badge (needs_review)");
    const indexSrc = read("src/index.ts");
    // The in-process hourly scheduler (index.ts) exists but is gated OFF by
    // default: it only starts behind shouldRunDentalVerifierScheduler()
    // (both DENTAL_VERIFIER_SCHEDULER_ENABLED and ENABLE_DENTAL exactly "1"),
    // and no fly config sets the flag. While that holds, the text's
    // «manuelt, i små partier» stays true; turning the flag on (Daniel only)
    // must come with a text change, and this assertion will need updating.
    const schedGate = require("../services/dental-verifier-scheduler") as typeof import("../services/dental-verifier-scheduler");
    const flyConfigs = fs.readdirSync(ROOT).filter((f: string) => /^fly.*\.toml$/.test(f)).map((f: string) => read(f)).join("\n");
    assertTrue(indexSrc.includes('app.use("/admin/run-dental-verifier"') &&
      (indexSrc.match(/runDentalVerifierBatch\(/g) || []).length === 1 &&
      /if \(shouldRunDentalVerifierScheduler\(\)\) \{[\s\S]{0,1500}runDentalVerifierBatch\(/.test(indexSrc) &&
      !schedGate.shouldRunDentalVerifierScheduler({ ENABLE_DENTAL: "1" }) &&
      !/DENTAL_VERIFIER_SCHEDULER_ENABLED\s*=\s*["']?1/.test(flyConfigs) &&
      read("src/scripts/run-dental-verifier.ts").includes('process.env.DENTAL_VERIFIER_SCHEDULER_ENABLED !== "1"') &&
      read("src/routes/admin-run-dental-verifier.ts").includes("|| 20, 1), 50);"),
      "b14: «manuelt, i små partier»: by default only the admin route (at most 50 a call) runs the verifier; the runner and the in-process scheduler are off by default");
    // F2-S8: each condition the text names is one the read-time claim reads,
    // and the badge goes when it fails.
    {
      const claim = require("../services/dental-verified-claim") as typeof import("../services/dental-verified-claim");
      const shown = { verification_status: "verified", is_inactive: 0, brreg_status: "active", website_ownership: "verified", catalog_class: "klinikk", directory_url: null, rich_field_count: MIN };
      assertTrue(claim.VERIFIED_CLAIM_REQUIRES_RULE && claim.resolveVerifiedClaim(shown), "b15 control: the claim is on, and a row with every condition shows the badge");
      const conditions: Array<[string, string, Record<string, unknown>]> = [
        ["aktiv i Brønnøysundregistrene", "active in Brønnøysundregistrene", { brreg_status: "orgnr_not_found_or_unreachable" }],
        ["nettstedet bekreftet som klinikkens eget", "the website confirmed as the clinic's own", { website_ownership: "unverified" }],
        [`minst ${MIN} av ${ALL} utvidede profilfelt`, `at least ${MIN} of ${ALL} extended profile fields`, { rich_field_count: MIN - 1 }],
      ];
      for (const [nb, en, broken] of conditions) {
        assertTrue(T.nb.includes(nb) && T.en.includes(en) && !claim.resolveVerifiedClaim({ ...shown, ...broken }), `b15 «${nb}»: named in nb and en, and the badge goes without it`);
      }
      const listed = { ...shown, website_ownership: "n/a", catalog_class: "offentlig_klinikk", directory_url: "https://example.org/klinikk" };
      assertTrue(T.nb.includes("For en offentlig tannklinikk kan en katalogoppføring erstatte kravet om bekreftet nettsted, men ikke kravet om aktiv enhet i Brønnøysundregistrene.") &&
        T.en.includes("For a public dental clinic, a directory listing can take the place of a confirmed website, but not of an active entity in Brønnøysundregistrene.") &&
        claim.resolveVerifiedClaim(listed) && !claim.resolveVerifiedClaim({ ...listed, brreg_status: null }),
        "b16: a public clinic's listing stands in for the website, not for an active entity (text and claim)");
      assertTrue(T.nb.includes("Et merke som er satt på annen måte, for eksempel av en tidligere automatisk rutine, vises bare når de samme vilkårene er oppfylt.") &&
        T.en.includes("A badge set in another way, for example by an earlier automated routine, is shown only when the same conditions are met.") &&
        !claim.resolveVerifiedClaim({ verification_status: "verified" }), "b17: a badge stored without the check's results is not shown");
      assertTrue(!/uverifisert|unverified|ikke verifisert|not verified/i.test(T.nb + T.en), "b18: the text marks no clinic «uverifisert»");
    }

    // ── fixture: two public clinics in Oslo, so the listings have content ──
    // The first has the «Verifisert» badge. A third, also verified, has no
    // stored fylke: the total counts it, the fylke aggregate does not (l12).
    // Set before any page is served, since the pages cache the numbers.
    // F2-S8: both verified clinics carry what the verifier stores when the
    // rule passes, so the badge shows.
    const BASIS = "brreg_status = 'active', website_ownership = 'verified', om_oss = 'Om klinikken.', payment_options = '[\"kort\"]', social_media = '{\"facebook\":\"https://example.test\"}'";
    const slugs = [["Sentrum Tannklinikk AS", "918960001"], ["Majorstuen Tann AS", "918960002"]].map(([navn, org_nr], i) => {
      const id = store.createDentalAgent({ navn, org_nr, poststed: "OSLO", fylke: "Oslo", adresse: "Storgata 1", postnummer: "0150", telefon: "22110099" } as any);
      db.prepare(`UPDATE dental_agents SET catalog_class = 'klinikk', verification_status = ?${i === 0 ? `, ${BASIS}` : ""} WHERE id = ?`).run(i === 0 ? "verified" : "pending_verify", id);
      return dentalSeo.slugifyClinic(navn!, org_nr!);
    });
    {
      const id = store.createDentalAgent({ navn: "Fjordkanten Tann AS", org_nr: "918960003", poststed: "HAMAR", adresse: "Torget 2", postnummer: "2317" } as any);
      db.prepare(`UPDATE dental_agents SET catalog_class = 'klinikk', verification_status = 'verified', fylke = NULL, ${BASIS} WHERE id = ?`).run(id);
    }

    // ── (c) + (d) every page ──────────────────────────────────────────────
    const pages: Array<[string, number]> = [
      ["/", 200], ["/om", 200], ["/hvordan-det-fungerer", 200], ["/proveniens", 200], ["/kontakt", 200], ["/personvern", 200],
      ["/sok?q=oslo", 200], ["/sted/oslo", 200], ["/fylke/Oslo", 200], ["/spesialitet/kjeveortopedi", 200],
      [`/klinikk/${slugs[0]}`, 200], ["/guide-tannlege-ai", 200], ["/finnes-ikke-404", 404],
    ];
    const html: Record<string, string> = {};
    const expectedColumn = src.dentalSourceNameLabels("nb").map((l) => ["/proveniens", l]);
    for (const [p, status] of pages) {
      const r = await callRoute(router, p);
      html[p] = r.text;
      assertEq(r.status, status, `c1 ${p}: status`);
      if (p === "/personvern") {
        // Exempt (personvern part B): the page keeps its HPR line, which
        // dental-privacy-truth.test.ts locks; the footer is checked like any page.
        assertTrue(NOT_A_SOURCE.test(r.text.match(/<main[\s\S]*?<\/main>/)?.[0] ?? ""), "c2 control /personvern: the exemption is real (its body still has the HPR line)");
        assertTrue(!NOT_A_SOURCE.test(footerOf(r.text)), "c3 /personvern: its footer names no HPR, NTF or Helsedirektoratet");
      } else {
        assertTrue(!NOT_A_SOURCE.test(r.text), `c3 ${p}: the page names no HPR, NTF or Helsedirektoratet`, r.text.match(NOT_A_SOURCE)?.[0]);
      }
      const column = sourceColumnOf(r.text);
      assertEq(column.links, expectedColumn, `d1 ${p}: the footer's «Datakilder» column is the list's names, each linking /proveniens`);
      assertEq(column.rest, "", `d2 ${p}: nothing else in that column`);
      assertTrue(!/href="https?:\/\/(?:www\.)?(?:helsedirektoratet|ntf)\.no/i.test(r.text), `d3 ${p}: no link to helsedirektoratet.no or ntf.no`);
      assertEq(footerOf(r.text).split(`<div class="footer-disambiguation">${escapeHtml(FINN_NB)}</div>`).length - 1, 1, `i1 ${p}: the footer keeps the FINN.no sentence`);
    }
    for (const p of ["/llms.txt", "/openapi.json", "/.well-known/ai-plugin.json", "/.well-known/mcp/server-card.json", "/robots.txt"]) {
      const r = await callRoute(router, p);
      assertEq(r.status, 200, `c4 ${p}: status`);
      assertTrue(!NOT_A_SOURCE.test(r.text), `c5 ${p}: names no HPR, NTF or Helsedirektoratet`, r.text.match(NOT_A_SOURCE)?.[0]);
    }
    {
      // The agent card's route logs usage first; the card itself is what it serves.
      const { getDentalAgentCard } = require("../services/dental-agent-card") as typeof import("../services/dental-agent-card");
      const card = JSON.stringify(getDentalAgentCard(5400));
      assertTrue(card.length > 500 && !NOT_A_SOURCE.test(card), "c6: the A2A agent card names no HPR, NTF or Helsedirektoratet");
    }

    // ── (e) the lists on /om, /hvordan-det-fungerer and /proveniens ───────
    const expectedItems = (lang: "nb" | "en"): ListItem[] =>
      S.map((s) => ({ url: s.url, label: src.dentalSourceLabel(s, lang), rest: src.dentalSourceFields(s, lang) }));
    assertEq(sourceItemsAfter(html["/om"]!, "<h2>Datakilder</h2>"), expectedItems("nb"), "e1: /om lists exactly the entries (name, link, fields)");
    assertEq(sourceItemsAfter(html["/hvordan-det-fungerer"]!, "henter klinikkdata fra disse kildene:"), expectedItems("nb"),
      "e2: /hvordan-det-fungerer «For klinikker» lists exactly the entries");
    assertTrue(!html["/hvordan-det-fungerer"]!.includes("tre offentlige kilder"), "e3: /hvordan-det-fungerer no longer says «tre offentlige kilder»");
    // /proveniens (F2-S2): the field table, one <tbody> per entry, one row per
    // field. The Places method may carry the A4-D display-rule sentence after
    // it (dental-places-visning.test.ts owns that sentence).
    const prov = html["/proveniens"]!;
    for (const [lang, headingId] of [["nb", "felt-for-felt"], ["en", "field-by-field"]] as const) {
      const got = methodTableOf(prov, headingId);
      assertEq(got.map((g) => g.id), S.map((s) => s.id), `e4 /proveniens ${lang}: the field table has the entries, in order`);
      for (const [k, s] of S.entries()) {
        const g = got[k];
        const span = s.fields.length > 1 ? ` rowspan="${s.fields.length}"` : "";
        assertEq(g?.fields, s.fields.map((f) => src.dentalFieldLabel(f, lang)), `e5 /proveniens ${lang} ${s.id}: one row per field, in order`);
        assertEq(g?.spans, [span, span, span], `e5b /proveniens ${lang} ${s.id}: source, method and date span the entry's rows`);
        assertEq([g?.url, g?.label, g?.licence], [s.url, src.dentalSourceLabel(s, lang), s.license ? { url: s.license.url, name: s.license.name } : null],
          `e5c /proveniens ${lang} ${s.id}: the source, its link and its licence`);
        const method = src.dentalSourceMethod(s, lang);
        assertTrue(s.id === "google_places" ? g?.method === method || !!g?.method.startsWith(`${method} `) : g?.method === method,
          `e5d /proveniens ${lang} ${s.id}: the method from the list`, g?.method);
        assertEq(g?.date, src.dentalSourceDate(s, lang), `e5e /proveniens ${lang} ${s.id}: the date from the list`);
      }
    }
    assertTrue(!prov.includes("Kildene vi kryssjekker mot") && !prov.includes("The sources we cross-check against"),
      "e5f /proveniens: the old source list is gone (the table replaces it, nothing twice)");
    for (const [p, lang] of [["/proveniens", "nb"], ["/proveniens", "en"], ["/hvordan-det-fungerer", "nb"]] as const) {
      assertTrue(html[p]!.includes(escapeHtml(T[lang])), `e6 ${p}: prints the «Verifisert» text (${lang})`);
    }
    assertTrue(!/redaksjonelt satt status|editorially-set status|Statusen settes manuelt per klinikk|Data er kryssjekket mot offentlige registre/.test(prov + html["/hvordan-det-fungerer"]!),
      "e7: the old manual-only and «kryssjekket mot … HPR» texts are gone");
    const omLicences = html["/om"]!.match(/<p>Lisenser og kildeangivelse:<\/p>\s*<ul>([\s\S]*?)<\/ul>/)?.[1] ?? "";
    for (const s of src.dentalLicensedSources()) {
      assertTrue(omLicences.includes(`<li>${escapeHtml(s.attribution ?? "")}. Lisens: <a href="${escapeHtml(s.license.url)}" rel="license noopener" target="_blank">${escapeHtml(s.license.name)}</a>.</li>`),
        `e8 /om: ${s.id}'s credit line with a link to its licence`);
    }
    assertEq((omLicences.match(/<li>/g) || []).length, src.dentalLicensedSources().length, "e9 /om: one credit line per licensed entry");
    assertTrue(html["/om"]!.includes(escapeHtml(FINN_NB)), "i2: /om keeps the FINN.no sentence");

    // ── (f) llms.txt ──────────────────────────────────────────────────────
    {
      const llms = (await callRoute(router, "/llms.txt")).text;
      const intro = llms.split("## Hva er dette?")[1]?.split("\n## ")[0] ?? "";
      assertTrue(intro.replace(/\s+/g, " ").includes(`med opplysninger fra ${src.dentalSourceNamesSentence("nb")}.`), "f1: the intro names the list's sources", intro);
      const lisens = llms.split("## Lisens")[1]?.split("\n## ")[0] ?? "";
      const lines = src.dentalLicensedSources().map((s) => `- ${src.dentalSourceLabel(s, "nb")}: ${s.license.name}, ${s.license.url}${s.attribution ? `\n  ${s.attribution}.` : ""}`);
      assertEq(lisens.trim(), [...lines, "Klinikkdata fra nettsider gjengis som faktaoppsummering."].join("\n"), "f2: «Lisens» is the list's licences and credit lines");
      assertTrue(!/CC0|HPR-data/.test(llms), "f3: no «CC0» and no «HPR-data er offentlig» (regression)");
      const verif = llms.split("## Datakvalitet og verifisering")[1] ?? "";
      assertTrue(verif.includes(T.nb) && verif.includes(T.en), "f4: the verification section prints the «Verifisert» text in nb and en");
      assertTrue(!/redaksjonelt satt status|editorially-set status|Hvert felt i en klinikkprofil|Every field in a clinic profile/.test(verif), "f5: the old manual-only and «every field» texts are gone");
      assertTrue(intro.includes(FINN_NB) && intro.includes(FINN_EN), "i3: llms.txt keeps the FINN.no sentence (nb and en)");
    }

    // ── (g) openapi.json ──────────────────────────────────────────────────
    {
      const spec = (await callRoute(router, "/openapi.json")).json;
      assertEq(spec?.info?.description,
        `REST API for Norwegian dental clinic discovery, sourced from ${src.dentalSourceNamesSentence("en")}. All read endpoints are public; no authentication required. ${FINN_EN}`,
        "g1: info.description names the list's sources (and keeps its other sentences)");
      const brreg = byId("brreg")!;
      assertEq(spec?.info?.license, { name: `${brreg.license!.name}, for data from Brønnøysundregistrene`, url: brreg.license!.url }, "g2: info.license is Brreg's licence from the list (was «CC0 (Brreg data)»)");
      assertTrue(spec?.info?.description.endsWith(` ${FINN_EN}`), "i4: openapi.json keeps the FINN.no sentence");
    }

    // ── (h) the Claude directory pack ─────────────────────────────────────
    {
      const listing = read("dental-connectors-prep/claude-directory/listing.md");
      const block = listing.match(/## Description \(limit [\d,]+\)\n\n```\n([\s\S]*?)\n```/)?.[1] ?? "";
      // The paragraph opens with the list's sentence; since G3-S6d the method-page sentence follows it.
      const sources = `The data comes from ${src.dentalSourceNamesSentence("en")}.`;
      assertTrue(block.split("\n\n").some((p) => p === sources || p.startsWith(`${sources} `)),
        "h1: a paragraph of the listing description opens with the list's sources (scripts/gen-connector-packs.ts, PACKS.dental)", block);
      for (const f of ["README.md", "claude-directory/listing.md", "claude-directory/portal-answers.md", "claude-directory/test-instructions.md"]) {
        const text = read(`dental-connectors-prep/${f}`);
        assertTrue(!NOT_A_SOURCE.test(text), `h2 ${f}: names no HPR, NTF or Helsedirektoratet`, text.match(NOT_A_SOURCE)?.[0]);
      }
    }

    // ── (j) one new entry, on every runtime surface ───────────────────────
    {
      const probe: DentalDataSource = {
        id: "probe_register",
        name_nb: "Prøveregisteret",
        name_en: "the Probe Register",
        fields: [{ nb: "prøvefelt", en: "probe field" }],
        method_nb: "Prøvemetode.",
        method_en: "Probe method.",
        date_nb: "Prøvedato.",
        date_en: "Probe date.",
        url: "https://example.org/probe",
        license: { name: "Prøvelisens 1.0", url: "https://example.org/lisens" },
        attribution: "Inneholder prøvedata",
      };
      const list = S as DentalDataSource[];
      // The names before the probe's: the probe comes last in every sentence.
      const lastNb = src.dentalSourceName(S[S.length - 1]!, "nb");
      const lastEn = src.dentalSourceName(S[S.length - 1]!, "en");
      const surfaces = async () => ({
        footer: sourceColumnOf((await callRoute(router, "/")).text).links.map(([, t]) => t),
        om: sourceItemsAfter((await callRoute(router, "/om")).text, "<h2>Datakilder</h2>").map((i) => i.label),
        omLicence: (await callRoute(router, "/om")).text.includes("Inneholder prøvedata. Lisens:"),
        hvordan: sourceItemsAfter((await callRoute(router, "/hvordan-det-fungerer")).text, "henter klinikkdata fra disse kildene:").map((i) => i.label),
        prov: methodTableOf((await callRoute(router, "/proveniens")).text, "field-by-field").map((g) => g.label),
        provNb: methodTableOf((await callRoute(router, "/proveniens")).text, "felt-for-felt").find((g) => g.id === "probe_register"),
        llms: (await callRoute(router, "/llms.txt")).text,
        openapi: String((await callRoute(router, "/openapi.json")).json?.info?.description ?? ""),
      });
      list.push(probe);
      try {
        const on = await surfaces();
        assertEq(on.footer[on.footer.length - 1], "Prøveregisteret", "j1: the footer names the new entry");
        assertEq([on.om[on.om.length - 1], on.hvordan[on.hvordan.length - 1], on.prov[on.prov.length - 1]], ["Prøveregisteret", "Prøveregisteret", "The Probe Register"],
          "j2: /om, /hvordan-det-fungerer and /proveniens (en) list it");
        assertEq([on.provNb?.fields, on.provNb?.method, on.provNb?.date, on.provNb?.licence?.name], [["Prøvefelt"], "Prøvemetode.", "Prøvedato.", "Prøvelisens 1.0"],
          "j2b: the field table (nb) gives its field, method, date and licence");
        assertTrue(on.omLicence, "j3: /om gives its credit line");
        assertTrue(on.llms.includes(`${lastNb} og Prøveregisteret.`) && on.llms.includes("- Prøveregisteret: Prøvelisens 1.0, https://example.org/lisens"),
          "j4: llms.txt names it in the intro and under «Lisens»");
        assertTrue(on.openapi.includes(`, ${lastEn} and the Probe Register.`), "j5: openapi.json names it");
      } finally {
        list.splice(list.indexOf(probe), 1);
      }
      const off = await surfaces();
      assertTrue(!off.footer.includes("Prøveregisteret") && !off.om.includes("Prøveregisteret") && !off.hvordan.includes("Prøveregisteret") &&
        !off.prov.includes("The Probe Register") && !off.provNb && !off.omLicence && !off.llms.includes("Prøveregisteret") && !off.openapi.includes("Probe Register"),
        "j6: removed again, it is gone from every surface (negative)");
    }

    // ── (k) sources hard-code no non-source ───────────────────────────────
    {
      const seo = read("src/routes/dental-seo.ts");
      const pvStart = seo.indexOf('router.get("/personvern"');
      const pvEnd = seo.indexOf("\nrouter.", pvStart + 1);
      assertTrue(pvStart > 0 && pvEnd > pvStart, "k1 control: the /personvern handler is found");
      const outside = seo.slice(0, pvStart) + seo.slice(pvEnd);
      const hits = codeLines(outside).filter((l) => NOT_A_SOURCE.test(l));
      assertEq(hits, [], "k2: dental-seo.ts has no HPR, NTF or Helsedirektoratet in code outside /personvern");
      for (const rel of ["src/services/dental-openapi.ts", "src/services/dental-data-sources.ts"]) {
        assertEq(codeLines(read(rel)).filter((l) => NOT_A_SOURCE.test(l)), [], `k3 ${rel}: no HPR, NTF or Helsedirektoratet in code`);
      }
    }

    // ── (l) F2-S2: /proveniens is the method page «Metode og kilder» ──────
    {
      const page = (await callRoute(router, "/proveniens")).text;
      const main = page.match(/<main>[\s\S]*?<\/main>/)?.[0] ?? "";
      const enAt = main.indexOf('<div lang="en">');
      const nbPart = enAt > 0 ? main.slice(0, enAt) : "";
      const enPart = enAt > 0 ? main.slice(enAt) : "";
      assertTrue(enAt > 0, 'l0 control: the English section is in its own <div lang="en">');
      assertTrue(page.includes("<title>Metode og kilder — Finn-tannlege.com</title>") && nbPart.includes("<h1>Metode og kilder</h1>") && enPart.includes('<h1 id="en">Method and sources</h1>'),
        "l1: title and h1 are «Metode og kilder» (en: «Method and sources»)");
      assertEq((main.match(/<h1[ >]/g) || []).length, 2, "l1b: one h1 per language");
      assertTrue(page.includes('<link rel="canonical" href="https://finn-tannlege.com/proveniens">'), "l1c: no new URL: the canonical is /proveniens");
      assertEq([methodTableOf(nbPart, "felt-for-felt").length, methodTableOf(enPart, "field-by-field").length, (main.match(/<table class="method-table"/g) || []).length],
        [S.length, S.length, 2], "l2: one field table per language, with every entry of the list");
      assertTrue(nbPart.includes('<thead><tr><th scope="col">Felt</th><th scope="col">Kilde</th><th scope="col">Slik hentes det</th><th scope="col">Dato</th></tr></thead>') &&
        enPart.includes('<thead><tr><th scope="col">Field</th><th scope="col">Source</th><th scope="col">How it is obtained</th><th scope="col">Date</th></tr></thead>'),
        "l2b: the columns are field, source, method and date");

      // Responsible editor: Daniel (2026-10-18, question 14), from the company record.
      assertEq(COMPANY_INFO.founder.name, "Daniel Fredriksen", "l3 control: the company record names Daniel");
      assertTrue(nbPart.includes(`<p>Ansvarlig redaktør: ${COMPANY_INFO.founder.name}.</p>`) && enPart.includes(`<p>Responsible editor: ${COMPANY_INFO.founder.name}.</p>`),
        "l3: the page names Daniel as responsible editor, nb and en");
      assertEq((main.match(/Ansvarlig redaktør|Responsible editor/g) || []).length, 2, "l3b: … and names no other");

      // Helfo: read from the clinic's website; since F2-S6 the badge needs a
      // stored source (resolveHelfoClaim), and the text says so.
      const seoSrc = read("src/routes/dental-seo.ts");
      const helfoNb = paragraphStarting(nbPart, "Helfo-direkteoppgjør");
      const helfoEn = paragraphStarting(enPart, "Helfo direct billing");
      assertTrue(helfoNb.includes("er tolket automatisk fra klinikkens nettside") && helfoNb.includes("ikke en bekreftelse fra Helfo") &&
        helfoEn.includes("is read automatically from the clinic's website") && helfoEn.includes("not a confirmation from Helfo"),
        "l4: Helfo is read automatically from the clinic's website, and is no confirmation from Helfo");
      const helfoClaim = require("../services/dental-helfo-claim") as typeof import("../services/dental-helfo-claim");
      assertTrue(seoSrc.includes("if (!inactive && resolveHelfoClaim(agent))") && helfoClaim.HELFO_CLAIM_REQUIRES_SOURCE,
        "l4b control: the profile shows the Helfo badge from resolveHelfoClaim, with the source rule on");
      assertTrue(!/if \((!inactive && )?agent\.helfo_agreement === "true"\)/.test(seoSrc),
        "l4c control: no Helfo badge or sentence is read from helfo_agreement alone");
      assertTrue(helfoNb.includes("merket vises bare når uttrekket har lagret kilden sammen med opplysningen") && helfoNb.includes("Uten lagret kilde viser vi ingen Helfo-opplysning") &&
        helfoEn.includes("the badge is shown only when the extraction has stored its source with the detail") && helfoEn.includes("Without a stored source we show no Helfo detail"),
        "l4d: the Helfo text states the source rule the badge follows (F2-S6)", helfoNb);

      // Akutt: as resolveAcuteClaim decides.
      const acute = require("../services/dental-acute-claim") as typeof import("../services/dental-acute-claim");
      const akuttNb = paragraphStarting(nbPart, "Akuttvakt");
      const akuttEn = paragraphStarting(enPart, "Emergency duty");
      // F1-S4c (A2A dev-request 2026-10-16-finn-tannlege-fasettsider): the stored source must carry
      // the quote from the page; a stamp without it gives the soft claim. F1-S4e says so on the page,
      // with definition A (Daniel, questions 33 and 34); dental-akutt-tekster.test.ts P reads it whole.
      assertTrue(akuttNb.includes("vises bare med et lagret sitat fra klinikkens egen nettside") && akuttNb.includes("Det holder ikke at kilden til opplysningen er lagret.") &&
        akuttNb.includes(`«${acute.ACUTE_ACCEPTS_LABEL}»`) &&
        akuttEn.includes("is shown only with a stored quote from the clinic's own website") && akuttEn.includes("A stored source for the detail is not enough.") &&
        akuttEn.includes(`<span lang="nb">${acute.ACUTE_ACCEPTS_LABEL}</span>`),
        "l5: «Akuttvakt» only with a stored quote from the clinic's own page (a stored source is not enough), otherwise «Tar imot akuttpasienter» when the extraction mentions akutt");
      assertEq([
        acute.resolveAcuteClaim({ acute_vakt: 1, field_provenance: null, patient_focus: null }),
        acute.resolveAcuteClaim({ acute_vakt: 1, field_provenance: { acute_vakt: [{ source_type: "website", value: "1", quote: "Vi har akuttvakt i helgene." }] }, patient_focus: null }),
        acute.resolveAcuteClaim({ acute_vakt: 1, field_provenance: { acute_vakt: [{ source_type: "website", value: "1" }] }, patient_focus: null }),
        acute.resolveAcuteClaim({ acute_vakt: 0, field_provenance: null, patient_focus: ["Akuttpasienter"] }),
        acute.resolveAcuteClaim({ acute_vakt: 0, field_provenance: null, patient_focus: ["Barn"] }),
      ], [null, "vakt", "accepts", "accepts", null], "l5b: … as resolveAcuteClaim decides (no source: no «Akuttvakt»; a source with its quote: «Akuttvakt»; a source without one, or akutt in the extraction: the soft claim; else none)");

      // Specialties: as clinicSpecialties reads them.
      const { clinicSpecialties } = require("../config/dental-search-vocabulary") as typeof import("../config/dental-search-vocabulary");
      const specNb = paragraphStarting(nbPart, "Spesialiteter");
      const specEn = paragraphStarting(enPart, "Specialties");
      assertTrue(specNb.includes("enten som noe klinikken tilbyr eller som tittelen til en behandler der (for eksempel «kjeveortoped»)") &&
        specNb.includes("Vi har ikke kontrollert at behandlerne har spesialistgodkjenning") &&
        specEn.includes("We have not checked that the practitioners are approved specialists"),
        "l6: specialties come from the clinic's website, and no specialist approval is claimed");
      assertEq([clinicSpecialties({ specialists: [{ title: "Kjeveortoped" }] }), clinicSpecialties({ available_specialties: ["periodonti"] }), clinicSpecialties({ specialists: [{ title: "Tannlege" }] })],
        [["kjeveortopedi"], ["periodonti"], []], "l6b: … as clinicSpecialties reads them (the title «kjeveortoped», or what the clinic offers; «Tannlege» adds none)");

      // «Verifisert» taken away = needs_review; Brreg-confirmed closure = nedlagt.
      assertTrue(nbPart.includes("I disse tilfellene settes klinikken til ny vurdering, og den har ikke merket før den er kontrollert på nytt.") &&
        nbPart.includes("Er enheten slettet, konkurs eller under avvikling, markeres klinikken i tillegg som nedlagt.") &&
        enPart.includes("In these cases the clinic is set for review, and it has no badge until it has been checked again."),
        "l7: the verifier's downgrades set the clinic for review, and a closed entity is marked closed");
      assertTrue(/newIsInactive = true;[\s\S]{0,120}newStatus = "needs_review";/.test(verifierSrc) && /naceMismatch\) \{\s*newStatus = "needs_review";/.test(verifierSrc) &&
        /streak >= DENTAL_VERIFIER_STREAK_DOWNGRADE_AT\) \{\s*newStatus = "needs_review";/.test(verifierSrc),
        "l7b: … as dental-verifier.ts does (Brreg closure also sets is_inactive; industry code; website streak)");

      // «Sist kontrollert» and «sist oppdatert».
      assertTrue(nbPart.includes("Datoen for siste kontroll («sist kontrollert») lagres for hver klinikk kontrollen har gått gjennom. En klinikk som ikke er kontrollert, har ingen slik dato.") &&
        nbPart.includes("«Sist oppdatert» på en klinikkprofil er datoen profilen sist ble endret") &&
        enPart.includes('The date of the last check ("last checked") is stored for each clinic the check has gone through.'),
        "l8: «sist kontrollert» and «sist oppdatert» are explained");
      assertTrue(/last_verified_at\s+= \?/.test(verifierSrc) && read("src/services/dental-store.ts").includes(`sets.push("updated_at = datetime('now')");`),
        "l8b: … as the code stores them (the verifier stamps last_verified_at; a profile write stamps updated_at)");

      // How to report an error.
      for (const [part, lang] of [[nbPart, "nb"], [enPart, "en"]] as const) {
        assertTrue(part.includes('<a href="mailto:kontakt@finn-tannlege.com">kontakt@finn-tannlege.com</a>') && part.includes('<a href="/kontakt">'),
          `l9 ${lang}: how to report an error: the contact address and the contact form`);
      }

      // The repeat-park rule, only while dental-store.ts applies it.
      {
        const storeSrc = read("src/services/dental-store.ts");
        assertTrue(storeSrc.split('process.env.DENTAL_REPEAT_PARK_TO_REVIEW === "true"').length - 1 === 3 &&
          ["dead_homepage_repeat", "insufficient_yield_repeat", "wrong_entity_repeat"].every((r) => storeSrc.includes(`"${r}"`)) &&
          store.DENTAL_PARK_AFTER_ATTEMPTS === 3 && store.DENTAL_PARK_BACKOFF_MS === 30 * 86_400_000,
          "l10 control: dental-store.ts sends a repeat park (3 failures in a row, then again after 30 days) to needs_review only behind DENTAL_REPEAT_PARK_TO_REVIEW, for the homepage, the extraction and a wrong entity");
        const NB_RULE = "tre ganger på rad og så igjen etter minst 30 dager";
        const EN_RULE = "three times in a row and then again after at least 30 days";
        const prev = process.env.DENTAL_REPEAT_PARK_TO_REVIEW;
        try {
          delete process.env.DENTAL_REPEAT_PARK_TO_REVIEW;
          const off = (await callRoute(router, "/proveniens")).text;
          process.env.DENTAL_REPEAT_PARK_TO_REVIEW = "false";
          const offFalse = (await callRoute(router, "/proveniens")).text;
          process.env.DENTAL_REPEAT_PARK_TO_REVIEW = "true";
          const on = (await callRoute(router, "/proveniens")).text;
          assertTrue(![off, offFalse].some((t) => t.includes(NB_RULE) || t.includes(EN_RULE)), "l10b: flag off (as in production) or false: the page does not claim the rule");
          assertTrue(on.includes(NB_RULE) && on.includes(EN_RULE), "l10c: flag on: the page names it, nb and en");
          assertEq(on.split(NB_RULE).length - 1, 1, "l10d: … once per language");
        } finally {
          if (prev === undefined) delete process.env.DENTAL_REPEAT_PARK_TO_REVIEW;
          else process.env.DENTAL_REPEAT_PARK_TO_REVIEW = prev;
        }
      }

      // No claim of how often anything runs, here or on /om.
      const FREQUENCY = new RegExp([
        "kontinuerlig", "daglig", "ukentlig", "hver (?:dag|uke|natt|time|måned)", "jevnlig", "regelmessig", "løpende", "automatisk oppdatert",
        "continuous", "daily", "weekly", "hourly", "every (?:day|week|night|hour|month)", "regularly", "periodically", "automatically updated",
      ].join("|"), "i");
      const omMain = (await callRoute(router, "/om")).text.match(/<main>[\s\S]*?<\/main>/)?.[0] ?? "";
      assertTrue(FREQUENCY.test("AI-agenter jobber kontinuerlig") && FREQUENCY.test("updated daily"), "l11 control: the pattern catches a frequency claim");
      for (const claim of ["Dataene sjekkes jevnlig", "Vi kontrollerer regelmessig", "Profilene oppdateres løpende", "Data blir automatisk oppdatert",
        "The data is checked regularly", "Profiles are refreshed periodically", "Automatically updated listings"]) {
        assertTrue(FREQUENCY.test(claim), `l11a control: the pattern catches «${claim}»`);
      }
      assertTrue(!FREQUENCY.test(main) && !FREQUENCY.test(omMain), "l11b: /proveniens and /om claim no frequency", (main + omMain).match(FREQUENCY)?.[0]);

      // The live numbers: the fixture has 3 public clinics, 2 verified, one of
      // them with no fylke, so the fylke aggregate sees 1 and the page says «minst 1».
      assertEq([store.getDentalStats().total, (db.prepare("SELECT COUNT(*) AS n FROM dental_agents WHERE verification_status = 'verified'").get() as { n: number }).n,
        (db.prepare("SELECT COUNT(*) AS n FROM dental_agents WHERE fylke IS NULL").get() as { n: number }).n], [3, 2, 1],
        "l12 control: the fixture has 3 public clinics, 2 verified, 1 without a fylke");
      assertTrue(nbPart.includes('<p class="method-counts">Klinikker i katalogen: <strong>3</strong> &middot; Med «Verifisert»-merket: <strong>minst 1</strong></p>') &&
        enPart.includes('<p class="method-counts">Clinics in the directory: <strong>3</strong> &middot; With the &quot;Verified&quot; badge: <strong>at least 1</strong></p>'),
        "l12: the total, and the verified clinics summed over the fylke aggregate: a lower bound («minst»), since one clinic has no fylke");
      const counts = dentalSeo.dentalMethodCounts;
      const n = (x: number, lang: "nb" | "en") => x.toLocaleString(lang);
      assertEq([
        counts({ total: 5446, verified: 312, verifiedComplete: true }, "nb"),
        counts({ total: 5446, verified: 312, verifiedComplete: false }, "nb"),
        counts({ total: 5446, verified: 312, verifiedComplete: false }, "en"),
        counts({ total: 12, verified: 0, verifiedComplete: true }, "nb"),
        counts({ total: 12, verified: 0, verifiedComplete: false }, "nb"),
        counts({ total: 0, verified: 0, verifiedComplete: true }, "nb"),
      ], [
        [["Klinikker i katalogen", n(5446, "nb")], ["Med «Verifisert»-merket", "312"]],
        [["Klinikker i katalogen", n(5446, "nb")], ["Med «Verifisert»-merket", "minst 312"]],
        [["Clinics in the directory", "5,446"], ['With the "Verified" badge', "at least 312"]],
        [["Klinikker i katalogen", "12"], ["Med «Verifisert»-merket", "0"]],
        [["Klinikker i katalogen", "12"]],
        [],
      ], "l12b: dentalMethodCounts: exact when every clinic has a fylke, «minst» otherwise, no «minst 0», nothing without a total");

      // No query per request: with warm caches the page reads memory only.
      {
        const handle = db as unknown as { prepare: (...a: unknown[]) => unknown };
        const own = Object.prototype.hasOwnProperty.call(handle, "prepare");
        const realPrepare = handle.prepare;
        let prepared = 0;
        handle.prepare = function (this: unknown, ...a: unknown[]) { prepared++; return realPrepare.apply(this, a); };
        try {
          await callRoute(router, "/proveniens");
          await new Promise((r) => setImmediate(r));
          prepared = 0;
          await callRoute(router, "/proveniens");
          assertEq(prepared, 0, "l13: with warm caches, /proveniens runs no query of its own");
          areaFacts.__resetDentalAreaFactsForTesting();
          await callRoute(router, "/proveniens");
          assertTrue(prepared > 0, "l13b control: the counter sees the aggregate's query once its cache is dropped");
        } finally {
          if (own) handle.prepare = realPrepare;
          else delete (handle as { prepare?: unknown }).prepare;
        }
      }
    }

    // ── (m) /om: the method page, and no claim the code does not back ─────
    {
      const om = (await callRoute(router, "/om")).text.match(/<main>[\s\S]*?<\/main>/)?.[0] ?? "";
      assertTrue(om.includes('<a href="/proveniens">Metode og kilder</a>'), "m1: /om links the method page");
      const platform = om.split("<h2>Om plattformen</h2>")[1]?.match(/<p>([\s\S]*?)<\/p>/)?.[1] ?? "";
      assertTrue(platform.length > 0, "m2 control: «Om plattformen» is read");
      assertTrue(!/kontinuerlig|uverifisert|tydelig merket/i.test(om), "m3: /om claims no continuous verification and no «uverifisert» marking (regression)");
      assertTrue(platform.includes("«Verifisert»-merket vises bare når klinikken oppfyller vilkårene til en regelstyrt kontroll") && platform.includes("kontrollen kjøres i dag manuelt, i små partier") &&
        !/settes enten manuelt|manuelt eller/.test(platform),
        "m4: «Om plattformen» says when the badge shows, as the «Verifisert» text does, with no manual way (F2-S8)");
      assertTrue(platform.includes("Profilsiden viser hva som er kontrollert og når, eller «Ikke kontrollert ennå».") && !platform.includes("ingen merknad om kontrollen") && !platform.includes("uten noen annen markering"),
        "m4b: … and that the profile shows what was checked and when, or «Ikke kontrollert ennå» (F2-S3; not «no other marking»: a closed clinic shows «Nedlagt»)", platform);
      assertTrue(platform.includes('<a href="/proveniens">'), "m5: … and points to the method page");
      // As the profile shows it: no header badge for a clinic without the
      // badge (the fixture's second clinic), and its only note about the
      // check is F2-S3's «Kontroll og kilder» box (no «uverifisert» marking),
      // «Nedlagt» for a closed one (a throwaway row, removed again). Only the
      // header row is read: the page also lists other clinics, with theirs.
      const profile = async (navn: string, orgNr: string): Promise<{ badges: string | null; main: string }> => {
        const main = (await callRoute(router, `/klinikk/${dentalSeo.slugifyClinic(navn, orgNr)}`)).text.match(/<main[\s\S]*<\/main>/)?.[0] ?? "";
        return { badges: main.match(/<div class="clinic-badges"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? null, main };
      };
      const NOT_CHECKED = /uverifisert|ikke verifisert|ikke kontrollert|unverified|not verified|not checked/i;
      const plain = await profile("Majorstuen Tann AS", "918960002");
      const outsideBox = plain.main.replace(/<div class="section-box verification-meta">[\s\S]*?<\/ul><\/div>/, "");
      assertTrue(plain.main.includes("<h1 class=\"profile-name\">Majorstuen Tann AS</h1>") && plain.badges === "" && !NOT_CHECKED.test(outsideBox) &&
        /<div class="section-box verification-meta">[\s\S]*?<li>Ikke kontrollert ennå<\/li>[\s\S]*?<\/div>/.test(plain.main),
        "m4c control: a profile without the badge has no header badge, and its only note about the check is the F2-S3 box, «Ikke kontrollert ennå»", `${plain.badges} ${outsideBox.match(NOT_CHECKED)?.[0] ?? ""}`);
      const closedId = store.createDentalAgent({ navn: "Nedlagt Fjord Tann AS", org_nr: "918960094", poststed: "OSLO", fylke: "Oslo" } as any);
      try {
        db.prepare("UPDATE dental_agents SET catalog_class = 'klinikk', verification_status = 'needs_review', is_inactive = 1 WHERE id = ?").run(closedId);
        const closed = await profile("Nedlagt Fjord Tann AS", "918960094");
        assertTrue(!!closed.badges && /^<span class="badge"[^>]*>Nedlagt<\/span>$/.test(closed.badges),
          "m4d control: a closed clinic's only header badge is «Nedlagt», so «no other marking» would be wrong", closed.badges ?? "no header");
      } finally {
        db.prepare("DELETE FROM dental_agents WHERE id = ?").run(closedId);
      }
    }

    // ── (n) F2-S9: the directory import, as the pages show it ─────────────
    {
      const imp = byId("katalogimport_2026_05")!;
      const prov = (await callRoute(router, "/proveniens")).text;
      const nb = methodTableOf(prov, "felt-for-felt");
      const en = methodTableOf(prov, "field-by-field");
      const rowNb = nb.find((g) => g.id === "katalogimport_2026_05");
      const rowEn = en.find((g) => g.id === "katalogimport_2026_05");
      assertEq([rowNb?.fields, rowNb?.url, rowNb?.label, rowNb?.licence, rowNb?.method, rowNb?.date],
        [["Navn", "Adresse", "Telefon", "Nettsted"], null, "Katalogimport (mai 2026)", null, imp.method_nb, "Ingen dato per felt. Verdiene er fra mai 2026."],
        "n1 /proveniens nb: the import's rows: name, address, phone and website, no link and no licence, its method and date");
      assertEq([rowEn?.fields, rowEn?.url, rowEn?.label, rowEn?.licence, rowEn?.method, rowEn?.date],
        [["Name", "Address", "Phone", "Website"], null, "Directory import (May 2026)", null, imp.method_en, "No date per field. The values are from May 2026."],
        "n1b /proveniens en: … and in English");
      assertTrue(!!nb.find((g) => g.id === "brreg")?.method.startsWith("Gjelder klinikker med organisasjonsnummer. ") &&
        !!en.find((g) => g.id === "brreg")?.method.startsWith("Applies to clinics with an organisation number. "),
        "n2 /proveniens: Brreg's method says it applies to clinics with an org.nr. (nb and en)", nb.find((g) => g.id === "brreg")?.method);
      for (const [p, marker] of [["/om", "<h2>Datakilder</h2>"], ["/hvordan-det-fungerer", "henter klinikkdata fra disse kildene:"]] as const) {
        const items = sourceItemsAfter((await callRoute(router, p)).text, marker);
        assertEq(items[items.length - 1], { url: null, label: "Katalogimport (mai 2026)", rest: "navn, adresse, telefon og nettsted" }, `n3 ${p}: lists the import, without a link`);
      }
      assertTrue(sourceColumnOf((await callRoute(router, "/")).text).links.some(([href, t]) => href === "/proveniens" && t === "En engangsimport fra en nettkatalog (mai 2026)"),
        "n4: the footer's «Datakilder» names it, linking /proveniens");
      const omLicences = (await callRoute(router, "/om")).text.match(/<p>Lisenser og kildeangivelse:<\/p>\s*<ul>([\s\S]*?)<\/ul>/)?.[1] ?? "";
      assertTrue(omLicences.includes("<li>") && !/nettkatalog|katalogimport/i.test(omLicences), "n5 /om: no licence or credit line for it");
      const llms = (await callRoute(router, "/llms.txt")).text;
      assertTrue(llms.includes("Google Places, Kartverket og en engangsimport fra en nettkatalog (mai 2026).") &&
        !/nettkatalog|katalogimport/i.test(llms.split("## Lisens")[1]?.split("\n## ")[0] ?? "nettkatalog"),
        "n6: llms.txt names it in the intro, and not under «Lisens»");
      const description = String((await callRoute(router, "/openapi.json")).json?.info?.description ?? "");
      assertTrue(description.includes("Google Places, Kartverket and a one-time import from an online directory (May 2026)."), "n7: openapi.json names it", description);
    }
  } catch (err: any) {
    failed++;
    failures.push("dental sources truth: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    restoreModuleCache();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runDentalSourcesTruthTests({ log: true }).then((r) => {
    console.log(`\ndental sources truth (F2-S1, F2-S2, F2-S9): ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
