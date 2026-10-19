/**
 * dental-sources-truth.test.ts — A2A dev-request
 * 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon, F2-S1 (honest data
 * sources, from one list) and F2-S2 (the method page «Metode og kilder»).
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
 *       credit line and extract date equal the dataset's own meta; each
 *       entry has its own list label; the name sentences.
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
 *       against the code that shows the badge (and no claim that Helfo needs
 *       a source before F2-S6 builds that rule); needs_review, «sist
 *       kontrollert» and «sist oppdatert»; how to report an error; the live
 *       numbers from the caches only (no query per request, «minst» when a
 *       clinic has no fylke); the repeat-park rule only while
 *       DENTAL_REPEAT_PARK_TO_REVIEW is on; no claim of how often anything
 *       runs.
 *   (m) /om links the method page, and «Om plattformen» no longer claims
 *       continuous verification or an «uverifisert» marking.
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
    // written with the integration it lists (no code, no entry).
    const dentalRoute = read("src/routes/dental.ts");
    const verifierSrc = read("src/services/dental-verifier.ts");
    const GROUNDED: Record<string, () => boolean> = {
      brreg: () =>
        /import \{[^}]*\bverifyOrgNumber\b[^}]*\} from "\.\/brreg-client"/.test(verifierSrc) &&
        read("src/routes/admin-dental-brreg-address-sweep.ts").includes('import { fetchBrregBusinessAddress } from "../services/brreg-client"') &&
        read("src/routes/admin-dental-hjemmeside-discovery.ts").includes('import { fetchBrregWebsite } from "../services/brreg-client"'),
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
    // Names and sentences.
    assertEq(src.dentalSourceNames("nb"), ["Brønnøysundregistrene", "klinikkenes egne nettsider (KI-assistert uttrekk)", "Google Places", "Kartverket"],
      "a18: the names, each once (the two Kartverket datasets are one name)");
    assertEq(src.dentalSourceNamesSentence("nb"), "Brønnøysundregistrene, klinikkenes egne nettsider (KI-assistert uttrekk), Google Places og Kartverket", "a19: nb sentence");
    assertEq(src.dentalSourceNamesSentence("en"), "Brønnøysundregistrene, the clinics' own websites (AI-assisted extraction), Google Places and Kartverket", "a20: en sentence (the spec's OpenAPI wording)");
    assertEq(src.dentalSourceNameLabels("en"), ["Brønnøysundregistrene", "The clinics' own websites (AI-assisted extraction)", "Google Places", "Kartverket"],
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

    // ── (b) the «Verifisert» text and the verifier ────────────────────────
    const T = src.DENTAL_VERIFIED_BADGE_TEXT;
    const MIN = verifier.DENTAL_VERIFIER_MIN_RICH_FIELDS;
    const ALL = verifier.DENTAL_RICH_FIELDS.length;
    assertTrue(T.nb.includes(`minst ${MIN} av ${ALL} utvidede profilfelt`) && T.en.includes(`at least ${MIN} of ${ALL} extended profile fields`),
      `b1: the text's numbers are the verifier's (${MIN} of ${ALL} rich fields)`);
    assertTrue(T.nb.includes("tre ganger på rad") && T.en.includes("three times in a row") && verifier.DENTAL_VERIFIER_STREAK_DOWNGRADE_AT === 3,
      "b2: «tre ganger på rad» is DENTAL_VERIFIER_STREAK_DOWNGRADE_AT");
    assertTrue(T.nb.includes("manuelt, etter at en administrator har gått gjennom profilen, eller av en regelstyrt kontroll") &&
      T.en.includes("by hand, after an administrator has reviewed the profile, or by a rule-based check"), "b3: two ways: by hand or by the rule-based check");
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
      "b10: a public clinic with a directory listing -> the badge («for en offentlig tannklinikk holder det med en katalogoppføring»)");
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
    assertTrue(indexSrc.includes('app.use("/admin/run-dental-verifier"') && !indexSrc.includes("runDentalVerifierBatch") &&
      read("src/scripts/run-dental-verifier.ts").includes('process.env.DENTAL_VERIFIER_SCHEDULER_ENABLED !== "1"') &&
      read("src/routes/admin-run-dental-verifier.ts").includes("|| 20, 1), 50);"),
      "b14: «manuelt, i små partier»: only the admin route (at most 50 a call) runs the verifier; the runner is off by default");

    // ── fixture: two public clinics in Oslo, so the listings have content ──
    // The first has the «Verifisert» badge. A third, also verified, has no
    // stored fylke: the total counts it, the fylke aggregate does not (l12).
    // Set before any page is served, since the pages cache the numbers.
    const slugs = [["Sentrum Tannklinikk AS", "918960001"], ["Majorstuen Tann AS", "918960002"]].map(([navn, org_nr], i) => {
      const id = store.createDentalAgent({ navn, org_nr, poststed: "OSLO", fylke: "Oslo", adresse: "Storgata 1", postnummer: "0150", telefon: "22110099" } as any);
      db.prepare("UPDATE dental_agents SET catalog_class = 'klinikk', verification_status = ? WHERE id = ?").run(i === 0 ? "verified" : "pending_verify", id);
      return dentalSeo.slugifyClinic(navn!, org_nr!);
    });
    {
      const id = store.createDentalAgent({ navn: "Fjordkanten Tann AS", org_nr: "918960003", poststed: "HAMAR", adresse: "Torget 2", postnummer: "2317" } as any);
      db.prepare("UPDATE dental_agents SET catalog_class = 'klinikk', verification_status = 'verified', fylke = NULL WHERE id = ?").run(id);
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
      assertTrue(block.split("\n\n").includes(`The data comes from ${src.dentalSourceNamesSentence("en")}.`),
        "h1: the listing description names the list's sources (scripts/gen-connector-packs.ts, PACKS.dental)", block);
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
        assertTrue(on.llms.includes("Kartverket og Prøveregisteret.") && on.llms.includes("- Prøveregisteret: Prøvelisens 1.0, https://example.org/lisens"),
          "j4: llms.txt names it in the intro and under «Lisens»");
        assertTrue(on.openapi.includes("Google Places, Kartverket and the Probe Register."), "j5: openapi.json names it");
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

      // Helfo: read from the clinic's website; the badge is shown from
      // helfo_agreement alone until F2-S6 (resolveHelfoClaim) adds the source rule.
      const seoSrc = read("src/routes/dental-seo.ts");
      const helfoNb = paragraphStarting(nbPart, "Helfo-direkteoppgjør");
      const helfoEn = paragraphStarting(enPart, "Helfo direct billing");
      assertTrue(helfoNb.includes("er tolket automatisk fra klinikkens nettside") && helfoNb.includes("ikke en bekreftelse fra Helfo") &&
        helfoEn.includes("is read automatically from the clinic's website") && helfoEn.includes("not a confirmation from Helfo"),
        "l4: Helfo is read automatically from the clinic's website, and is no confirmation from Helfo");
      assertTrue(seoSrc.includes('if (!inactive && agent.helfo_agreement === "true")'), "l4b control: the profile shows the Helfo badge from helfo_agreement alone");
      assertTrue(!fs.existsSync(path.join(ROOT, "src/services/dental-helfo-claim.ts")) && !seoSrc.includes("resolveHelfoClaim("),
        "l4c control: F2-S6's resolveHelfoClaim is not built yet (when it lands, the Helfo text and l4d change with it)");
      assertTrue(!/\bbare\b|\bonly\b/.test(helfoNb + helfoEn) && helfoNb.includes("merket vises når uttrekket har registrert det") &&
        helfoEn.includes("the badge is shown when the extraction has recorded that"),
        "l4d: the Helfo text claims no source rule yet, only what shows the badge today", helfoNb);

      // Akutt: as resolveAcuteClaim decides.
      const acute = require("../services/dental-acute-claim") as typeof import("../services/dental-acute-claim");
      const akuttNb = paragraphStarting(nbPart, "Akuttvakt");
      const akuttEn = paragraphStarting(enPart, "Emergency duty");
      assertTrue(akuttNb.includes("vises bare når kilden til opplysningen er lagret sammen med feltet") && akuttNb.includes(`«${acute.ACUTE_ACCEPTS_LABEL}»`) &&
        akuttEn.includes("is shown only when the source of the detail is stored with the field") && akuttEn.includes(`<span lang="nb">${acute.ACUTE_ACCEPTS_LABEL}</span>`),
        "l5: «Akuttvakt» only with a stored source, otherwise «Tar imot akuttpasienter» when the extraction mentions akutt");
      assertEq([
        acute.resolveAcuteClaim({ acute_vakt: 1, field_provenance: null, patient_focus: null }),
        acute.resolveAcuteClaim({ acute_vakt: 1, field_provenance: { acute_vakt: [{ source_type: "website", value: "1" }] }, patient_focus: null }),
        acute.resolveAcuteClaim({ acute_vakt: 0, field_provenance: null, patient_focus: ["Akuttpasienter"] }),
        acute.resolveAcuteClaim({ acute_vakt: 0, field_provenance: null, patient_focus: ["Barn"] }),
      ], [null, "vakt", "accepts", null], "l5b: … as resolveAcuteClaim decides (no source: no «Akuttvakt»; akutt in the extraction: the soft claim; else none)");

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
      const FREQUENCY = /kontinuerlig|daglig|ukentlig|hver (?:dag|uke|natt|time|måned)|continuous|daily|weekly|hourly|every (?:day|week|night|hour|month)/i;
      const omMain = (await callRoute(router, "/om")).text.match(/<main>[\s\S]*?<\/main>/)?.[0] ?? "";
      assertTrue(FREQUENCY.test("AI-agenter jobber kontinuerlig") && FREQUENCY.test("updated daily"), "l11 control: the pattern catches a frequency claim");
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
      assertTrue(platform.includes("«Verifisert»-merket settes enten manuelt eller av en regelstyrt kontroll") && platform.includes("kontrollen kjøres i dag manuelt, i små partier") &&
        platform.includes("Klinikker uten merket vises uten noen annen markering"), "m4: «Om plattformen» says how the badge is set, as the «Verifisert» text does");
      assertTrue(platform.includes('<a href="/proveniens">'), "m5: … and points to the method page");
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
    console.log(`\ndental sources truth (F2-S1, F2-S2): ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
