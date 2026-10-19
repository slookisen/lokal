/**
 * dental-sources-truth.test.ts — A2A dev-request
 * 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon, F2-S1 (honest data
 * sources, from one list).
 *
 * Finn-tannlege.com names no data source it does not use, and every surface
 * reads DENTAL_DATA_SOURCES (src/services/dental-data-sources.ts). HPR, NTF
 * and Helsedirektoratet are not sources: no client exists, and each comes
 * later as its own case (Daniel 2026-10-18, question 14). Covers:
 *   (a) the list: well-formed; every entry has code behind it (one grounding
 *       check per id, and an id without one fails); Google Places' fields are
 *       in the field mask; Brreg's licence is NLOD 2.0 (data.brreg.no, read
 *       2026-10-19), not CC0; the Kartverket postnummer licence and credit
 *       line equal the dataset's own meta; the name sentences.
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
 *   (e) /om, /hvordan-det-fungerer and /proveniens (nb and en) list exactly
 *       the entries; /om has each licence's credit line and link;
 *       /proveniens and /hvordan-det-fungerer print the «Verifisert» text.
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
 *
 * Harness as in dental-finn-disambiguation.test.ts: in-memory dental DB, the
 * router driven through router.handle().
 *
 * Standalone: npx tsx src/routes/dental-sources-truth.test.ts
 * Wired into tests/test.ts via runDentalSourcesTruthTests().
 */

import * as fs from "fs";
import * as path from "path";

import { BRAND_ENTITIES } from "../config/brand-entities";
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
  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
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
    const S = src.DENTAL_DATA_SOURCES;
    const byId = (id: string): DentalDataSource | undefined => S.find((s) => s.id === id);

    // ── (a) the list ──────────────────────────────────────────────────────
    assertTrue(S.length >= 4, `a1 control: the list is read (${S.length} entries)`);
    assertEq(new Set(S.map((s) => s.id)).size, S.length, "a2: ids are unique");
    for (const s of S) {
      assertTrue(/^[a-z][a-z0-9_]*$/.test(s.id), `a3 ${s.id}: id is a lower-case key`);
      assertTrue([s.name_nb, s.name_en, s.method_nb, s.method_en].every((t) => t.trim() !== "" && !/[<>&]/.test(t)),
        `a4 ${s.id}: names and methods are set, plain text (the pages escape them)`);
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
    assertTrue(!byId("kartverket_geocoding")?.license, "a17: no licence is claimed for the address API (its documentation names none)");
    // Names and sentences.
    assertEq(src.dentalSourceNames("nb"), ["Brønnøysundregistrene", "klinikkenes egne nettsider (KI-assistert uttrekk)", "Google Places", "Kartverket"],
      "a18: the names, each once (the two Kartverket datasets are one name)");
    assertEq(src.dentalSourceNamesSentence("nb"), "Brønnøysundregistrene, klinikkenes egne nettsider (KI-assistert uttrekk), Google Places og Kartverket", "a19: nb sentence");
    assertEq(src.dentalSourceNamesSentence("en"), "Brønnøysundregistrene, the clinics' own websites (AI-assisted extraction), Google Places and Kartverket", "a20: en sentence (the spec's OpenAPI wording)");
    assertEq(src.dentalSourceLabels("en"), ["Brønnøysundregistrene", "The clinics' own websites (AI-assisted extraction)", "Google Places", "Kartverket"], "a21: list labels capitalise the first letter");
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
    const slugs = [["Sentrum Tannklinikk AS", "918960001"], ["Majorstuen Tann AS", "918960002"]].map(([navn, org_nr]) => {
      const id = store.createDentalAgent({ navn, org_nr, poststed: "OSLO", fylke: "Oslo", adresse: "Storgata 1", postnummer: "0150", telefon: "22110099" } as any);
      db.prepare("UPDATE dental_agents SET catalog_class = 'klinikk' WHERE id = ?").run(id);
      return dentalSeo.slugifyClinic(navn!, org_nr!);
    });

    // ── (c) + (d) every page ──────────────────────────────────────────────
    const pages: Array<[string, number]> = [
      ["/", 200], ["/om", 200], ["/hvordan-det-fungerer", 200], ["/proveniens", 200], ["/kontakt", 200], ["/personvern", 200],
      ["/sok?q=oslo", 200], ["/sted/oslo", 200], ["/fylke/Oslo", 200], ["/spesialitet/kjeveortopedi", 200],
      [`/klinikk/${slugs[0]}`, 200], ["/guide-tannlege-ai", 200], ["/finnes-ikke-404", 404],
    ];
    const html: Record<string, string> = {};
    const expectedColumn = src.dentalSourceLabels("nb").map((l) => ["/proveniens", l]);
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
    const expectedItems = (lang: "nb" | "en", withMethod: boolean): ListItem[] =>
      S.map((s) => ({
        url: s.url,
        label: src.dentalSourceLabel(s, lang),
        rest: `${src.dentalSourceFields(s, lang)}${withMethod ? `. ${src.dentalSourceMethod(s, lang)}` : ""}`,
      }));
    assertEq(sourceItemsAfter(html["/om"]!, "<h2>Datakilder</h2>"), expectedItems("nb", false), "e1: /om lists exactly the entries (name, link, fields)");
    assertEq(sourceItemsAfter(html["/hvordan-det-fungerer"]!, "henter klinikkdata fra disse kildene:"), expectedItems("nb", false),
      "e2: /hvordan-det-fungerer «For klinikker» lists exactly the entries");
    assertTrue(!html["/hvordan-det-fungerer"]!.includes("tre offentlige kilder"), "e3: /hvordan-det-fungerer no longer says «tre offentlige kilder»");
    // /proveniens: name, fields and method; the Places item may carry the A4-D
    // display-rule sentence after it (dental-places-visning.test.ts owns it).
    const prov = html["/proveniens"]!;
    for (const [lang, marker] of [["nb", "<h2>Kildene vi kryssjekker mot</h2>"], ["en", "<h2>The sources we cross-check against</h2>"]] as const) {
      const got = sourceItemsAfter(prov, marker);
      const want = expectedItems(lang, true);
      assertEq(got.map((i) => [i.url, i.label]), want.map((i) => [i.url, i.label]), `e4 /proveniens ${lang}: the entries, in order, with their links`);
      for (const [k, w] of want.entries()) {
        const g = got[k]?.rest ?? "";
        const ok = S[k]!.id === "google_places" ? g === w.rest || g.startsWith(`${w.rest} `) : g === w.rest;
        assertTrue(ok, `e5 /proveniens ${lang} ${S[k]!.id}: fields and method from the list`, g);
      }
    }
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
        prov: sourceItemsAfter((await callRoute(router, "/proveniens")).text, "<h2>The sources we cross-check against</h2>").map((i) => i.label),
        llms: (await callRoute(router, "/llms.txt")).text,
        openapi: String((await callRoute(router, "/openapi.json")).json?.info?.description ?? ""),
      });
      list.push(probe);
      try {
        const on = await surfaces();
        assertEq(on.footer[on.footer.length - 1], "Prøveregisteret", "j1: the footer names the new entry");
        assertEq([on.om[on.om.length - 1], on.hvordan[on.hvordan.length - 1], on.prov[on.prov.length - 1]], ["Prøveregisteret", "Prøveregisteret", "The Probe Register"],
          "j2: /om, /hvordan-det-fungerer and /proveniens (en) list it");
        assertTrue(on.omLicence, "j3: /om gives its credit line");
        assertTrue(on.llms.includes("Kartverket og Prøveregisteret.") && on.llms.includes("- Prøveregisteret: Prøvelisens 1.0, https://example.org/lisens"),
          "j4: llms.txt names it in the intro and under «Lisens»");
        assertTrue(on.openapi.includes("Google Places, Kartverket and the Probe Register."), "j5: openapi.json names it");
      } finally {
        list.splice(list.indexOf(probe), 1);
      }
      const off = await surfaces();
      assertTrue(!off.footer.includes("Prøveregisteret") && !off.om.includes("Prøveregisteret") && !off.hvordan.includes("Prøveregisteret") &&
        !off.prov.includes("The Probe Register") && !off.omLicence && !off.llms.includes("Prøveregisteret") && !off.openapi.includes("Probe Register"),
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
    console.log(`\ndental sources truth (F2-S1): ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
