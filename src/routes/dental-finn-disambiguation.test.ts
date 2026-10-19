/**
 * dental-finn-disambiguation.test.ts — A2A dev-request
 * 2026-10-16-merkevare-entitet-og-connector-pakker, G3-S8 (Daniel's
 * decision 4=A: the name Finn-tannlege stays, and every text sets it clearly
 * apart from FINN.no).
 *
 * The sentence lives once, in BRAND_ENTITIES.dental.disambiguation
 * (src/config/brand-entities.ts). Covers:
 *   (a) the sentence: nb «ikke tilknyttet FINN.no» (or «ingen tilknytning
 *       til FINN.no», the wording the name check also allows), en «not
 *       affiliated with FINN.no»; it names Finn-tannlege.com and the company.
 *   (b) every dental HTML page (front page, /om, /hvordan-det-fungerer and the
 *       other shells, a 404 included) has the nb sentence as one footer line,
 *       right under the operator line; never in the title, a meta description
 *       or a heading; FINN.no nowhere else on the page; no «FINN-tannlege»,
 *       «FINN Tannlege», «finntannlege(n)» or «Finn Tannlege».
 *   (c) /om says it in the paragraph on what the service is not tied to.
 *   (d) the front page's Organization JSON-LD has disambiguatingDescription;
 *       no JSON-LD node carries FINN in alternateName, sameAs or keywords.
 *   (e) machine surfaces: llms.txt (intro, nb + en), /openapi.json
 *       info.description (en), /.well-known/ai-plugin.json
 *       description_for_human (nb) and description_for_model (en, catalog
 *       count kept), agents.txt «Name: Finn-tannlege» (was «Finn Tannlege»),
 *       MCP server card and agent card free of FINN.
 *   (f) the Claude directory pack: the dental listing description ends with
 *       the en sentence, the name row is DONE, the other brands' packs never
 *       mention FINN; renderPack() adds the paragraph only for a brand that
 *       has a sentence.
 *   (g) the route and spec sources print no FINN text of their own.
 *
 * Harness as in dental-seo-lastmod-antall-404-agents-txt.test.ts: in-memory
 * dental DB, the router driven through router.handle().
 *
 * Standalone: npx tsx src/routes/dental-finn-disambiguation.test.ts
 * Wired into tests/test.ts via runDentalFinnDisambiguationTests().
 */

import * as fs from "fs";
import * as path from "path";

import { BRAND_ENTITIES } from "../config/brand-entities";
import { organizationJsonLd, parentOrganizationJsonLd } from "../services/company-legal";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

/** The wordings the name check accepts; a lawyer's wording is changed in brand-entities.ts only. */
export const NOT_AFFILIATED_NB = /\b(?:ikke tilknyttet|ingen tilknytning til) FINN\.no\b/;
export const NOT_AFFILIATED_EN = /\b(?:not affiliated with|no affiliation with) FINN\.no\b/;
/** Spellings of the name the writing rules forbid (spec G3-S8, acceptance criteria and the rule list). */
const FORBIDDEN_NAME_SPELLINGS: readonly RegExp[] = [/\bFINN[- ]?[Tt]annlege\b/, /\bfinntannlegen?\b/i, /\bFinnTannlege\b/, /\bFinn Tannlege\b/];
/** FINN as a word (capitals: «finn» is also the Norwegian verb), or the domain finn.no in any case. */
const FINN_MENTION = /\bFINN\b|\b[Ff][Ii][Nn][Nn]\.[Nn][Oo]\b/;

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
      send(payload: any) {
        resolve({ status: this.statusCode, text: String(payload ?? ""), json: undefined });
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, text: JSON.stringify(payload), json: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, text: String(err), json: undefined });
      else resolve({ status: 404, text: "unhandled", json: undefined });
    });
  });
}

/** Every application/ld+json block of a page, parsed, arrays flattened. */
function jsonLdOf(html: string): any[] {
  const out: any[] = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const v = JSON.parse(m[1]!);
      if (Array.isArray(v)) out.push(...v);
      else out.push(v);
    } catch { /* not ours to judge here */ }
  }
  return out;
}

/** Every object node inside a JSON value (the node itself included). */
function objectNodes(v: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(v)) v.forEach((x) => objectNodes(x, out));
  else if (v && typeof v === "object") {
    out.push(v as Record<string, unknown>);
    Object.values(v).forEach((x) => objectNodes(x, out));
  }
  return out;
}

/** Lines of a source file that are code (not a // or block-comment line). */
function codeLines(src: string): string[] {
  return src.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*(\s|\/|$))/.test(l));
}

export async function runDentalFinnDisambiguationTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const D = BRAND_ENTITIES.dental;
  const NB = D.disambiguation?.nb ?? "";
  const EN = D.disambiguation?.en ?? "";
  /** The text with the configured sentences taken out: what must not mention FINN at all. */
  const withoutSentences = (text: string): string => text.split(NB).join("").split(EN).join("");
  const forbiddenSpellings = (text: string): string[] =>
    FORBIDDEN_NAME_SPELLINGS.map((re) => text.match(re)?.[0]).filter((m): m is string => !!m);

  // ── (a) the sentence ──────────────────────────────────────────────────
  const { COMPANY_INFO } = require("../config/company-info") as typeof import("../config/company-info");
  assertTrue(NB !== "" && EN !== "", "a1: BRAND_ENTITIES.dental has a disambiguation sentence in nb and en");
  assertTrue(NOT_AFFILIATED_NB.test(NB), "a2: nb says «ikke tilknyttet FINN.no» (or «ingen tilknytning til FINN.no»)", NB);
  assertTrue(NOT_AFFILIATED_EN.test(EN), "a3: en says «not affiliated with FINN.no»", EN);
  for (const [lang, s] of [["nb", NB], ["en", EN]] as const) {
    assertTrue(s.startsWith("Finn-tannlege.com "), `a4 ${lang}: the sentence names the service as «Finn-tannlege.com»`, s);
    assertTrue(s.includes(COMPANY_INFO.displayName), `a5 ${lang}: the sentence names the company (${COMPANY_INFO.displayName})`, s);
    assertEq((s.match(/FINN/g) || []).length, 1, `a6 ${lang}: FINN appears once, as «FINN.no»`);
    assertEq(forbiddenSpellings(s), [], `a7 ${lang}: no forbidden spelling of the name`);
    assertTrue(!/[<>&"]/.test(s), `a8 ${lang}: no HTML-special characters (the pages print it escaped, the tests match it raw)`);
  }
  assertTrue(!NOT_AFFILIATED_NB.test("Finn-tannlege.com er tilknyttet FINN.no.") && !NOT_AFFILIATED_EN.test("Finn-tannlege.com is affiliated with FINN.no."),
    "a9 control: a sentence that claims a tie to FINN.no fails the wording check");
  assertTrue(NOT_AFFILIATED_NB.test("Finn-tannlege.com har ingen tilknytning til FINN.no."), "a10: the alternative wording «har ingen tilknytning til FINN.no» passes");

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

    // ── fixture: two public clinics in Oslo, so the listings have content ──
    const clinics = [["Sentrum Tannklinikk AS", "918960001"], ["Majorstuen Tann AS", "918960002"]].map(([navn, org_nr]) => {
      const id = store.createDentalAgent({ navn, org_nr, poststed: "OSLO", fylke: "Oslo", adresse: "Storgata 1", telefon: "22110099" } as any);
      db.prepare("UPDATE dental_agents SET catalog_class = 'klinikk' WHERE id = ?").run(id);
      return dentalSeo.slugifyClinic(navn!, org_nr!);
    });

    // ── (b) every dental HTML page ────────────────────────────────────────
    const footerLine = `<div class="footer-disambiguation">${NB}</div>`;
    const pages: Array<[string, number]> = [
      ["/", 200], ["/om", 200], ["/hvordan-det-fungerer", 200], ["/kontakt", 200], ["/personvern", 200],
      ["/proveniens", 200], ["/sok?q=oslo", 200], ["/sted/oslo", 200], ["/fylke/Oslo", 200],
      [`/klinikk/${clinics[0]}`, 200], ["/finnes-ikke-404", 404],
    ];
    const html: Record<string, string> = {};
    for (const [p, status] of pages) {
      const r = await callRoute(router, p);
      html[p] = r.text;
      const page = r.text;
      assertEq(r.status, status, `b1 ${p}: status`);
      const footer = page.match(/<footer[\s\S]*?<\/footer>/)?.[0] ?? "";
      assertEq(footer.split(footerLine).length - 1, 1, `b2 ${p}: the footer has the sentence once, as its own line`);
      assertTrue(/<div class="footer-company">[\s\S]*?<\/div>\s*<div class="footer-disambiguation">/.test(footer),
        `b3 ${p}: the sentence sits right under the operator line`);
      assertTrue(NOT_AFFILIATED_NB.test(page), `b4 ${p}: the page says «ikke tilknyttet FINN.no»`);
      const headish = [
        ...(page.match(/<title>[\s\S]*?<\/title>/g) || []),
        ...(page.match(/<meta (?:name|property)="[^"]+" content="[^"]*">/g) || []),
        ...(page.match(/<h[1-6][\s>][\s\S]*?<\/h[1-6]>/g) || []),
      ];
      assertTrue(headish.length >= 3, `b5 control ${p}: title, meta and headings are read (${headish.length})`);
      assertEq(headish.filter((h) => FINN_MENTION.test(h)), [], `b6 ${p}: FINN is in no title, meta description or heading`);
      assertTrue(!FINN_MENTION.test(withoutSentences(page)), `b7 ${p}: FINN.no is named only in the sentence itself`);
      assertEq(forbiddenSpellings(page), [], `b8 ${p}: no «FINN-tannlege», «FINN Tannlege», «finntannlege(n)» or «Finn Tannlege»`);
    }

    // ── (c) /om ───────────────────────────────────────────────────────────
    {
      const main = html["/om"]!.match(/<main>[\s\S]*?<\/main>/)?.[0] ?? "";
      const lead = main.match(/<p>[^<]*klinikkjede[^<]*<\/p>/)?.[0] ?? "";
      assertTrue(lead.includes("ikke tilknyttet noen klinikkjede, forsikringsselskap eller bestillingsportal"), "c1 control: /om keeps its «ikke tilknyttet noen klinikkjede …» paragraph");
      assertTrue(lead.includes(NB), "c2: that paragraph also says the service is not affiliated with FINN.no (the sentence from brand-entities.ts)", lead);
      assertTrue(!/<h1>[^<]*FINN/.test(main), "c3: the /om heading does not mention FINN");
    }

    // ── (d) JSON-LD on the front page ─────────────────────────────────────
    {
      const ld = jsonLdOf(html["/"]!);
      const org = ld.find((n) => n?.["@type"] === "Organization");
      assertTrue(!!org, "d1 control: the front page has an Organization node");
      assertEq(org?.disambiguatingDescription, NB, "d2: Organization.disambiguatingDescription is the nb sentence");
      assertEq([org?.name, org?.url], ["Finn-tannlege", "https://finn-tannlege.com"], "d3: name and url unchanged (no rename)");
      assertTrue(!!org?.parentOrganization?.["@id"], "d4: parentOrganization kept");
      // G3-S1-dental: the node is the shared builder's output (mutation-sensitive: a hand-rolled node would miss @id / logo / parent).
      assertEq(org?.["@id"], "https://finn-tannlege.com/#organization", "d6: Organization has the brand @id");
      assertEq(org?.logo, "https://finn-tannlege.com/favicon-512.png", "d7: Organization.logo is the brand-config PNG");
      assertEq(org?.parentOrganization, parentOrganizationJsonLd(), "d8: parentOrganization deep-equals parentOrganizationJsonLd()");
      assertEq(org, organizationJsonLd("dental"), "d9: the front-page Organization is exactly organizationJsonLd(\"dental\")");
      const site = ld.find((n) => n?.["@type"] === "WebSite");
      assertTrue(!!site && !("disambiguatingDescription" in site) && !FINN_MENTION.test(JSON.stringify(site)), "d5: the WebSite node (the main field) does not mention FINN");
      const nodes = ld.flatMap((n) => objectNodes(n));
      const finnIn = (key: string) => nodes.filter((n) => key in n && FINN_MENTION.test(JSON.stringify(n[key])));
      for (const key of ["alternateName", "sameAs", "keywords", "name"]) {
        assertEq(finnIn(key).length, 0, `d6: no JSON-LD node has FINN in ${key}`);
      }
      // A clinic page's JSON-LD: the sentence is the site's, not the clinic's.
      const clinicLd = jsonLdOf(html[`/klinikk/${clinics[0]}`]!);
      assertTrue(clinicLd.length > 0 && !FINN_MENTION.test(JSON.stringify(clinicLd)), "d7: a clinic page's JSON-LD does not mention FINN");
    }

    // ── (e) machine surfaces ──────────────────────────────────────────────
    {
      const llms = await callRoute(router, "/llms.txt");
      assertEq(llms.status, 200, "e1: /llms.txt 200");
      const intro = llms.text.split("## Hva er dette?")[1]?.split("\n## ")[0] ?? "";
      assertTrue(intro.includes("uavhengig søketjeneste"), "e2 control: the llms.txt intro is read");
      assertTrue(intro.includes(NB) && intro.includes(EN), "e3: the llms.txt intro has the sentence in nb and en");
      assertTrue(!FINN_MENTION.test(withoutSentences(llms.text)), "e4: llms.txt names FINN.no only in the sentence (no alternateName, keyword or tool text with FINN)");
      assertEq(forbiddenSpellings(llms.text), [], "e5: llms.txt has no forbidden spelling of the name");
    }
    {
      const spec = await callRoute(router, "/openapi.json");
      const desc = String(spec.json?.info?.description ?? "");
      assertEq(spec.status, 200, "e6: /openapi.json 200");
      assertTrue(desc.startsWith("REST API for Norwegian dental clinic discovery") && desc.endsWith(` ${EN}`), "e7: info.description keeps its text and ends with the en sentence", desc);
      assertTrue(NOT_AFFILIATED_EN.test(desc), "e8: info.description says «not affiliated with FINN.no»");
      assertEq(spec.json?.info?.title, "Finn-tannlege.com API", "e9: info.title unchanged");
      assertTrue(!FINN_MENTION.test(withoutSentences(spec.text)), "e10: openapi.json names FINN.no only in that sentence");
    }
    {
      const plug = await callRoute(router, "/.well-known/ai-plugin.json");
      const human = String(plug.json?.description_for_human ?? "");
      const model = String(plug.json?.description_for_model ?? "");
      assertEq(plug.status, 200, "e11: /.well-known/ai-plugin.json 200");
      assertTrue(human.startsWith("Finn og sammenlign tannlegeklinikker i Norge") && human.endsWith(` ${NB}`), "e12: description_for_human keeps its text and ends with the nb sentence", human);
      assertTrue(model.startsWith("Plugin for searching and comparing Norwegian dental clinics.") && model.endsWith(` ${EN}`), "e13: description_for_model keeps its text and ends with the en sentence", model);
      assertTrue(/access to [\d\s]+ clinics|Provides access to clinics/.test(model), "e14: description_for_model keeps the catalog-count phrase discovery-truth reads");
      assertEq([plug.json?.name_for_human, plug.json?.name_for_model], ["Finn-tannlege", "finn_tannlege"], "e15: plugin names unchanged");
      assertTrue(!FINN_MENTION.test(withoutSentences(plug.text)), "e16: ai-plugin.json names FINN.no only in the two sentences");
    }
    {
      const agents = await callRoute(router, "/.well-known/agents.txt");
      assertEq(agents.status, 200, "e17: agents.txt 200");
      assertEq((agents.text.match(/^Name: (.+)$/m) || [])[1], "Finn-tannlege", "e18: agents.txt «Name: Finn-tannlege» (regression: was «Finn Tannlege»)");
      assertTrue(!FINN_MENTION.test(agents.text) && forbiddenSpellings(agents.text).length === 0, "e19: agents.txt has no FINN and no forbidden spelling");
    }
    {
      const card = await callRoute(router, "/.well-known/mcp/server-card.json");
      assertEq(card.status, 200, "e20: MCP server card 200");
      assertTrue(!FINN_MENTION.test(withoutSentences(card.text)) && forbiddenSpellings(card.text).length === 0, "e21: the MCP server card has no FINN outside the sentence and no forbidden spelling");
      const { getDentalAgentCard } = require("../services/dental-agent-card") as typeof import("../services/dental-agent-card");
      const agentCard = JSON.stringify(getDentalAgentCard(5400));
      assertTrue(!FINN_MENTION.test(withoutSentences(agentCard)) && forbiddenSpellings(agentCard).length === 0, "e22: the agent card has no FINN outside the sentence and no forbidden spelling");
    }

    // ── (f) the Claude directory pack ─────────────────────────────────────
    {
      const gen = require("../../scripts/gen-connector-packs") as typeof import("../../scripts/gen-connector-packs");
      const rendered = gen.renderConnectorPacks();
      const listing = rendered.get("dental-connectors-prep/claude-directory/listing.md") ?? "";
      const readme = rendered.get("dental-connectors-prep/README.md") ?? "";
      const block = listing.match(/## Description \(limit [\d,]+\)\n\n```\n([\s\S]*?)\n```/)?.[1] ?? "";
      const paras = block.split("\n\n");
      assertTrue(paras.length >= 4, `f1 control: the dental listing description is read (${paras.length} paragraphs)`);
      assertEq(paras[paras.length - 1], EN, "f2: the dental listing description ends with the en sentence from brand-entities.ts");
      assertTrue(!FINN_MENTION.test(withoutSentences(block)), "f3: the description names FINN.no only in that sentence");
      const nameBlock = listing.match(/## Server name[^\n]*\n\n```\n([^\n]*)\n```/)?.[1];
      const oneLiner = listing.match(/## One-liner[^\n]*\n\n```\n([^\n]*)\n```/)?.[1] ?? "";
      assertTrue(nameBlock === "Finn-tannlege" && oneLiner !== "" && !FINN_MENTION.test(oneLiner), "f4: server name «Finn-tannlege» and the one-liner do not mention FINN");
      assertTrue(/^\| Name decision for Finn-tannlege \| \*\*DONE\*\* \|.*decision 4=A/m.test(readme), "f5: the README's name row is DONE and cites decision 4=A");
      assertTrue(!readme.includes("Submit after Daniel has settled the name"), "f6: the old WAITING text is gone");
      for (const dir of ["rfb-connectors-prep", "opplevagent-connectors-prep"]) {
        const files = [...rendered].filter(([k]) => k.startsWith(`${dir}/`));
        assertTrue(files.length === 4 && files.every(([, c]) => !FINN_MENTION.test(c)), `f7 ${dir}: the pack never mentions FINN (the field is dental's only)`);
      }
      // renderPack() on synthetic input: the paragraph follows the brand, not the vertical.
      const input = gen.gatherPackInput("dental");
      const descOf = (files: Record<string, string>): string =>
        files["claude-directory/listing.md"]!.match(/## Description \(limit [\d,]+\)\n\n```\n([\s\S]*?)\n```/)?.[1] ?? "";
      const without = descOf(gen.renderPack(gen.PACKS.dental, { ...input, brand: { ...input.brand, disambiguation: undefined } }));
      assertEq(without, gen.PACKS.dental.description(gen.formatInt(input.floor)).join("\n\n"), "f8: a brand without the field gets the description unchanged");
      assertTrue(!without.includes("FINN"), "f9: … and no FINN.no line");
      const other = descOf(gen.renderPack(gen.PACKS.dental, { ...input, brand: { ...input.brand, disambiguation: { nb: "x", en: "Not affiliated with Example." } } }));
      assertTrue(other.endsWith("\n\nNot affiliated with Example."), "f10: the configured sentence, whatever it says, is the last paragraph");
    }

    // ── (g) sources print no FINN text of their own ───────────────────────
    for (const rel of ["dental-seo.ts", path.join("..", "services", "dental-openapi.ts")]) {
      const code = codeLines(fs.readFileSync(path.join(__dirname, rel), "utf8")).join("\n");
      assertTrue(!FINN_MENTION.test(code), `g1 ${rel}: no FINN literal in code (the sentence comes from brand-entities.ts)`);
      assertEq(forbiddenSpellings(code), [], `g2 ${rel}: no forbidden spelling of the name`);
    }
  } catch (err: any) {
    failed++;
    failures.push("dental FINN disambiguation: unexpected error: " + String(err?.stack || err?.message || err));
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
  runDentalFinnDisambiguationTests({ log: true }).then((r) => {
    console.log(`\ndental FINN disambiguation: ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
