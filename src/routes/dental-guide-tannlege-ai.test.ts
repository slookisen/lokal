/**
 * dental-guide-tannlege-ai.test.ts — A2A dev-request
 * 2026-10-16-merkevare-entitet-og-connector-pakker, G3-S4: the AI guide
 * /guide-tannlege-ai on finn-tannlege.com, in Norwegian and English.
 *
 * In the style of discovery-truth.test.ts: the real dental-seo router, a real
 * MCP server with the register function the live /mcp runs and a real client
 * over the SDK's in-memory transport, against an in-memory dental DB.
 *
 * Covers:
 *   (a) the page: GET /guide-tannlege-ai is 200 Norwegian; /en/guide-tannlege-ai,
 *       through langMiddleware as on the live host, is 200 English with
 *       <html lang="en"> and the Norwegian nav and footer marked lang="nb";
 *       canonical per language, hreflang nb/en/x-default on both, og:locale,
 *       index. Other pages keep the shell as it was (lang nb, no hreflang).
 *   (b) the tools = live tools/list: one card per tool in registration order
 *       in both languages, curated copy for every tool, every <code>
 *       parameter in that tool's input schema, the tools FAQ names them all;
 *       an extra registered tool is listed with its registered description
 *       (escaped) and a removed one disappears (negative).
 *   (c) the examples: the page lists BRAND_ENTITIES.dental.exampleQueries, in
 *       order; each finds at least one clinic through tannlege_search
 *       (tools/call) as written, read by the parser with no fallback and no
 *       leftover words taken as a name (what made the old third prompt find
 *       none); a place with no clinic finds none (control).
 *   (d) no promise of booking: booking is named only in the FAQ answer that
 *       says the service books nothing; FINN.no only in the footer sentence
 *       (G3-S8); no HPR, NTF or Helsedirektoratet claim in the page body.
 *   (e) setup: the remote URL is the server card's endpoint, the npm package
 *       is mcp-server-dental/package.json's name and bin, the Claude Desktop
 *       config is valid JSON for it, and the source link is that folder.
 *   (f) FAQ: the visible questions and answers are the FAQPage JSON-LD.
 *   (g) sitemap: both URLs, once each, without <lastmod>.
 *   (h) discovery: BRAND_ENTITIES.dental.docsUrl is the guide; the footer
 *       links it on every page; llms.txt names both URLs.
 *
 * Standalone: npx tsx src/routes/dental-guide-tannlege-ai.test.ts
 * Wired into tests/test.ts via runDentalGuideTannlegeAiTests().
 */

import * as fs from "fs";
import * as path from "path";

import { BRAND_ENTITIES } from "../config/brand-entities";
import { NOT_AFFILIATED_NB } from "./dental-finn-disambiguation.test";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const ROOT = path.join(__dirname, "..", "..");
/** FINN as a word (capitals: «finn» is also the Norwegian verb), or the domain finn.no in any case. */
const FINN_MENTION = /\bFINN\b|\b[Ff][Ii][Nn][Nn]\.[Nn][Oo]\b/;
/** Spellings of the name the writing rules forbid (as in dental-finn-disambiguation.test.ts). */
const FORBIDDEN_NAME_SPELLINGS: readonly RegExp[] = [/\bFINN[- ]?[Tt]annlege\b/, /\bfinntannlegen?\b/i, /\bFinnTannlege\b/, /\bFinn Tannlege\b/];
/** Data sources the service does not use (dev-request F2-S1's truth check). */
const NOT_A_SOURCE = /HPR|Helsepersonellregister|helsedirektoratet\.no|ntf\.no|tannlegeforening/i;
/** A tolkning line for words the parser kept as a name or place filter. */
const LEFTOVER_WORDS = /^navn eller poststed inneholder:/;

interface RouteResult { status: number; headers: Record<string, string>; text: string; json: any }

function fakeReq(url: string, lang: string): any {
  return {
    method: "GET", url, originalUrl: url,
    // A getter, as on a real request: langMiddleware rewrites req.url.
    get path() { return String(this.url).split("?")[0]; },
    params: {}, query: {}, headers: {}, ip: "127.0.0.1", hostname: "finn-tannlege.com", lang,
    get() { return undefined; },
  };
}

function fakeRes(resolve: (r: RouteResult) => void): any {
  const headers: Record<string, string> = {};
  return {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = String(v); return this; },
    header(k: string, v: string) { headers[k.toLowerCase()] = String(v); return this; },
    send(payload: any) { resolve({ status: this.statusCode, headers, text: String(payload ?? ""), json: undefined }); return this; },
    json(payload: any) { resolve({ status: this.statusCode, headers, text: JSON.stringify(payload), json: payload }); return this; },
  };
}

function callRoute(router: any, url: string, lang = "no"): Promise<RouteResult> {
  return new Promise((resolve) => {
    router.handle(fakeReq(url, lang), fakeRes(resolve), () => resolve({ status: 404, headers: {}, text: "unhandled", json: undefined }));
  });
}

/** As on the live host: langMiddleware (index.ts, before the dental gate), then the router. */
function callThroughLangMiddleware(langMiddleware: any, router: any, url: string): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req = fakeReq(url, "no");
    const res = fakeRes(resolve);
    langMiddleware(req, res, () => router.handle(req, res, () => resolve({ status: 404, headers: {}, text: "unhandled", json: undefined })));
  });
}

const unescapeHtml = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** The visible text of an HTML fragment: tags dropped, entities read, whitespace collapsed. */
const textOf = (html: string): string => unescapeHtml(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function jsonLdOf(html: string): any[] {
  const out: any[] = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const v = JSON.parse(m[1]!);
      if (Array.isArray(v)) out.push(...v); else out.push(v);
    } catch { /* counted as missing */ }
  }
  return out;
}

const mainOf = (html: string): string => (html.match(/<main>[\s\S]*?<\/main>/) || [""])[0];
const cardsOf = (html: string): Array<[string, string]> =>
  [...html.matchAll(/<div class="gta-tool"><code>([^<]*)<\/code><p>([\s\S]*?)<\/p><\/div>/g)].map((m) => [m[1]!, m[2]!]);
const examplesOf = (html: string): string[] =>
  [...((html.match(/<ul class="gta-examples">([\s\S]*?)<\/ul>/) || ["", ""])[1]!).matchAll(/<li>([^<]*)<\/li>/g)].map((m) => unescapeHtml(m[1]!));
const visibleFaq = (html: string): Array<[string, string]> =>
  [...html.matchAll(/<div class="gta-faq-item"><h3>([^<]*)<\/h3><p>([^<]*)<\/p><\/div>/g)].map((m) => [unescapeHtml(m[1]!), unescapeHtml(m[2]!)]);
const metaProp = (html: string, prop: string): string | null =>
  (html.match(new RegExp(`<meta (?:property|name)="${prop.replace(/[:.]/g, "\\$&")}" content="([^"]*)">`)) || [])[1] ?? null;

export async function runDentalGuideTannlegeAiTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const base = process.env.DENTAL_BASE_URL || "https://finn-tannlege.com";
  const NB_URL = `${base}/guide-tannlege-ai`;
  const EN_URL = `${base}/en/guide-tannlege-ai`;
  const prevDentalPath = process.env.DENTAL_DB_PATH;
  const prevParserOff = process.env.DENTAL_QUERY_PARSER_DISABLED;
  process.env.DENTAL_DB_PATH = ":memory:";
  delete process.env.DENTAL_QUERY_PARSER_DISABLED;
  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("../services/dental-catalog-class"),
    require.resolve("../services/dental-search-gazetteer"),
    require.resolve("./dental-seo"),
    require.resolve("./dental-mcp"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
  let closeMcp: (() => Promise<void>) | null = null;

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const gaz = require("../services/dental-search-gazetteer") as typeof import("../services/dental-search-gazetteer");

    // ── fixture: one clinic per example, plus clinics none of them may find ──
    const add = (row: Record<string, unknown>, extra: Record<string, unknown> = {}): string => {
      const id = store.createDentalAgent({ telefon: "22000000", ...row } as any);
      const cols = Object.keys(extra);
      if (cols.length) db.prepare(`UPDATE dental_agents SET ${cols.map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`).run({ ...extra, id });
      return id;
    };
    add({ navn: "Bryggen Tann", poststed: "BERGEN", fylke: "Vestland", postnummer: "5003" });
    add({ navn: "Majorstua Tann", poststed: "OSLO", fylke: "Oslo", postnummer: "0151", helfo_agreement: "true" });
    add({ navn: "Grünerløkka Tann", poststed: "OSLO", fylke: "Oslo", postnummer: "0552" });
    // A sourced emergency duty: a public akutt search lists only clinics whose card shows the claim.
    add({ navn: "Stavanger Akuttvakt", poststed: "STAVANGER", fylke: "Rogaland", postnummer: "4006" },
      { acute_vakt: 1, field_provenance: JSON.stringify({ acute_vakt: [{ source_type: "homepage", value: 1 }] }) });
    add({ navn: "Sandnes Tann", poststed: "SANDNES", fylke: "Rogaland", postnummer: "4306" });
    gaz.__resetDentalSearchGazetteerForTesting();

    const dentalSeo = require("./dental-seo") as typeof import("./dental-seo");
    const router = dentalSeo.default as any;
    const manifest = require("../services/mcp-tool-manifest") as typeof import("../services/mcp-tool-manifest");
    const { langMiddleware } = require("../i18n/middleware") as typeof import("../i18n/middleware");

    // A real tools/list and tools/call, as a client gets them.
    const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as typeof import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js") as typeof import("@modelcontextprotocol/sdk/inMemory.js");
    const server = new McpServer({ name: "guide-tannlege-ai-test", version: "0.0.0" });
    (require("./dental-mcp") as typeof import("./dental-mcp")).registerDentalTools(server);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "guide-tannlege-ai-test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    closeMcp = async () => { await client.close(); await server.close(); };
    const listed = (await client.listTools()).tools;
    const liveNames = listed.map((t) => t.name);
    const params = new Map(listed.map((t) => [t.name, Object.keys((t.inputSchema as any)?.properties || {})]));
    const search = async (query: string) =>
      JSON.parse(((await client.callTool({ name: "tannlege_search", arguments: { query } })) as any).content[0].text);

    // ── (a) the page ──────────────────────────────────────────────────────
    const nb = await callRoute(router, "/guide-tannlege-ai", "no");
    const en = await callThroughLangMiddleware(langMiddleware, router, "/en/guide-tannlege-ai");
    const pages = { nb, en } as const;
    assertTrue(nb.status === 200 && nb.headers["content-type"] === "text/html; charset=utf-8", "a1: GET /guide-tannlege-ai is 200 text/html");
    assertTrue(en.status === 200 && en.headers["content-type"] === "text/html; charset=utf-8", "a2: GET /en/guide-tannlege-ai (through langMiddleware) is 200 text/html");
    assertTrue(nb.text.startsWith("<!DOCTYPE html>\n<html lang=\"nb\">") && en.text.startsWith("<!DOCTYPE html>\n<html lang=\"en\">"),
      "a3: <html lang> is nb on the Norwegian page and en on the English one");
    assertEq((nb.text.match(/<link rel="canonical" href="([^"]+)">/g) || []), [`<link rel="canonical" href="${NB_URL}">`], "a4: the Norwegian canonical is /guide-tannlege-ai");
    assertEq((en.text.match(/<link rel="canonical" href="([^"]+)">/g) || []), [`<link rel="canonical" href="${EN_URL}">`], "a5: the English canonical is /en/guide-tannlege-ai");
    const hreflang = [
      `<link rel="alternate" hreflang="nb" href="${NB_URL}">`,
      `<link rel="alternate" hreflang="en" href="${EN_URL}">`,
      `<link rel="alternate" hreflang="x-default" href="${NB_URL}">`,
    ];
    for (const [lang, r] of Object.entries(pages)) {
      assertEq(r.text.match(/<link rel="alternate" hreflang="[^"]+" href="[^"]+">/g), hreflang, `a6 ${lang}: hreflang nb, en and x-default (nb)`);
      assertEq(metaProp(r.text, "robots"), "index, follow, max-snippet:-1, max-image-preview:large", `a7 ${lang}: indexable`);
      assertEq(metaProp(r.text, "og:url"), lang === "en" ? EN_URL : NB_URL, `a8 ${lang}: og:url is the canonical`);
    }
    assertEq([metaProp(nb.text, "og:locale"), metaProp(en.text, "og:locale")], ["nb_NO", "en_US"], "a9: og:locale nb_NO / en_US");
    assertTrue(/<nav class="nav" role="navigation" aria-label="Hovednavigasjon" lang="nb">/.test(en.text) && /<footer class="footer" role="contentinfo" lang="nb">/.test(en.text),
      "a10: on the English page the Norwegian nav and footer say lang=\"nb\"");
    assertTrue(/<nav class="nav" role="navigation" aria-label="Hovednavigasjon">/.test(nb.text) && /<footer class="footer" role="contentinfo">/.test(nb.text),
      "a11: on the Norwegian page nav and footer carry no lang of their own");
    const nbTitle = (nb.text.match(/<title>([^<]*)<\/title>/) || [])[1];
    const enTitle = (en.text.match(/<title>([^<]*)<\/title>/) || [])[1];
    assertTrue(!!nbTitle && !!enTitle && nbTitle !== enTitle && nbTitle.endsWith(" — Finn-tannlege.com") && enTitle.endsWith(" — Finn-tannlege.com"),
      "a12: a title per language, with the site suffix", `${nbTitle} | ${enTitle}`);
    assertTrue(/<h1>Søk etter tannlege med AI-assistenten din<\/h1>/.test(nb.text) && /<h1>Find a dentist in Norway with your AI assistant<\/h1>/.test(en.text),
      "a13: one h1 per language");
    assertTrue(nb.text.includes('<a href="/en/guide-tannlege-ai" hreflang="en" lang="en">English</a>') && en.text.includes('<a href="/guide-tannlege-ai" hreflang="nb" lang="nb">Norsk</a>'),
      "a14: each page links the other language");
    {
      const om = await callRoute(router, "/om", "no");
      assertTrue(om.text.startsWith("<!DOCTYPE html>\n<html lang=\"nb\">") && !om.text.includes('hreflang="') && metaProp(om.text, "og:locale") === "nb_NO" && !/<nav[^>]* lang=/.test(om.text),
        "a15 (regression): other pages keep the shell as it was (lang nb, no hreflang, og:locale nb_NO, nav without lang)");
    }

    // ── (b) the tools = live tools/list ───────────────────────────────────
    assertTrue(liveNames.length >= 5, `b0 control: live tools/list returns the dental tools (${liveNames.join(", ")})`);
    assertEq(manifest.registeredMcpToolNames("dental"), liveNames, "b1: registeredMcpTools(\"dental\") is the live tools/list, in order");
    for (const [lang, r] of Object.entries(pages)) {
      const siteLang = lang as "nb" | "en";
      const cards = cardsOf(r.text);
      assertEq(cards.map((c) => c[0]), liveNames, `b2 ${lang}: one card per live tool, in registration order`);
      const tools = dentalSeo.dentalMcpGuideTools(siteLang);
      assertTrue(tools.every((t) => t.curated), `b3 ${lang}: every registered tool has curated copy (missing: ${tools.filter((t) => !t.curated).map((t) => t.name).join(", ") || "none"})`);
      assertEq(cards.map((c) => c[1]), tools.map((t) => t.cardHtml), `b4 ${lang}: the cards are dentalMcpGuideTools()`);
      const unknownParams = tools.flatMap((t) =>
        [...t.cardHtml.matchAll(/<code>([^<]*)<\/code>/g)].map((m) => m[1]!).filter((p) => !(params.get(t.name) || []).includes(p)).map((p) => `${t.name}.${p}`));
      assertEq(unknownParams, [], `b5 ${lang}: every parameter a card names is in that tool's input schema`);
      assertTrue(tools.find((t) => t.name === "tannlege_search")?.cardHtml.includes("<code>query</code>") === true && (params.get("tannlege_search") || []).includes("query"),
        `b6 ${lang}: the search card documents \`query\`, and tannlege_search takes it`);
      const faqLd = jsonLdOf(r.text).find((n) => n?.["@type"] === "FAQPage");
      const toolsAnswer: string = faqLd?.mainEntity?.[1]?.acceptedAnswer?.text ?? "";
      assertTrue(liveNames.every((n) => toolsAnswer.includes(n)), `b7 ${lang}: the tools FAQ answer names every live tool`, toolsAnswer);
    }
    assertTrue(dentalSeo.dentalMcpGuideTools("nb").every((t, i) => t.cardHtml !== dentalSeo.dentalMcpGuideTools("en")[i]!.cardHtml),
      "b8: the Norwegian and English cards are their own text");
    {
      const registered = manifest.registeredMcpTools("dental");
      const future = dentalSeo.dentalMcpGuideTools("nb", [...registered, { name: "tannlege_future", description: "Does a <b>thing</b>." }]);
      assertEq(future[future.length - 1], { name: "tannlege_future", cardHtml: "Does a &lt;b&gt;thing&lt;/b&gt;.", faq: "tannlege_future: Does a <b>thing</b>", curated: false },
        "b9 (negative): a registered tool with no copy is listed with its registered description, escaped on the card");
      const faqFuture = dentalSeo.buildDentalMcpGuideFaqJsonLd("en", "u", [...registered, { name: "tannlege_future", description: "Does a thing." }]);
      assertTrue(String(faqFuture.mainEntity[1]!.acceptedAnswer.text).endsWith("; tannlege_future: Does a thing."), "b10: … and named in the tools FAQ answer");
      const without = registered.filter((t) => t.name !== "tannlege_kjeder");
      assertTrue(!dentalSeo.dentalMcpGuideTools("nb", without).some((t) => t.name === "tannlege_kjeder") &&
        !JSON.stringify(dentalSeo.buildDentalMcpGuideFaqJsonLd("nb", "u", without)).includes("tannlege_kjeder"),
        "b11 (negative): a tool that is no longer registered leaves the cards and the FAQ");
      assertTrue(dentalSeo.dentalMcpGuideTools("nb", [{ name: "constructor", description: "x." }])[0]!.curated === false,
        "b12: a tool named like an Object property is not mistaken for curated copy");
    }

    // ── (c) the examples ──────────────────────────────────────────────────
    const examples = BRAND_ENTITIES.dental.exampleQueries;
    assertTrue(examples.length >= 3, `c0 control: the brand has example prompts (${examples.length})`);
    assertEq(examplesOf(nb.text), examples.map((q) => `«${q}»`), "c1 nb: the page lists BRAND_ENTITIES.dental.exampleQueries, in order");
    assertEq(examplesOf(en.text), examples.map((q) => `"${q}"`), "c2 en: the page lists BRAND_ENTITIES.dental.exampleQueries, in order");
    for (const q of examples) {
      const r = await search(q);
      assertTrue(r.count >= 1 && r.klinikker.length >= 1, `c3 «${q}»: tannlege_search finds at least one clinic (${r.count})`);
      const lines: string[] = r.tolkning?.tolket_som ?? [];
      assertTrue(r.tolkning?.fallback === false && lines.some((l) => l.startsWith("sted: ")) && !lines.some((l) => LEFTOVER_WORDS.test(l)),
        `c4 «${q}»: read by the parser (a place, no fallback, no leftover words as a name)`, JSON.stringify(lines));
    }
    {
      const r = await search("Find a dentist in Tromsø");
      assertEq(r.count, 0, "c5 control: a place with no clinic in the fixture finds none (c3 is not vacuous)");
      assertTrue(LEFTOVER_WORDS.test("navn eller poststed inneholder: care, tonight"), "c6 control: the leftover-word check matches the line the parser writes");
    }

    // ── (d) no promise of booking; FINN.no only in the footer sentence ────
    for (const [lang, r] of Object.entries(pages)) {
      const main = textOf(mainOf(r.text));
      const faqLd = jsonLdOf(r.text).find((n) => n?.["@type"] === "FAQPage");
      const pairs: Array<[string, string]> = (faqLd?.mainEntity ?? []).map((qa: any) => [qa.name, qa.acceptedAnswer.text]);
      const booking = pairs.filter(([q]) => /\bbook|bestill/i.test(q));
      assertEq(booking.length, 1, `d1 ${lang}: one FAQ question asks about booking`);
      const [bq, ba] = booking[0] ?? ["", ""];
      assertTrue(lang === "en" ? ba.startsWith("No. Finn-tannlege does not book appointments and takes no payment.") : ba.startsWith("Nei. Finn-tannlege bestiller ikke time og tar ikke imot betaling."),
        `d2 ${lang}: its answer says the service books nothing and takes no payment`, ba);
      const rest = main.split(bq).join(" ").split(ba).join(" ");
      assertTrue(main.length > 2000 && main.includes(bq) && main.includes(ba), `d3 control ${lang}: the page body is read, with the booking Q&A in it`);
      assertTrue(!/\bbook|bestill|timebestilling/i.test(rest), `d4 ${lang}: no other text on the page mentions booking`, (rest.match(/.{0,40}(\bbook|bestill).{0,40}/i) || [""])[0]);
      assertTrue(!NOT_A_SOURCE.test(main), `d5 ${lang}: the page body names no HPR, NTF or Helsedirektoratet`);
      const footer = (r.text.match(/<footer[\s\S]*?<\/footer>/) || [""])[0];
      assertTrue(NOT_AFFILIATED_NB.test(footer), `d6 ${lang}: the footer keeps the FINN.no sentence (G3-S8)`);
      const nbSentence = BRAND_ENTITIES.dental.disambiguation?.nb ?? "\u0000";
      assertTrue(!FINN_MENTION.test(r.text.split(nbSentence).join("")), `d7 ${lang}: FINN.no is named only in that sentence`);
      const spellings = FORBIDDEN_NAME_SPELLINGS.map((re) => r.text.match(re)?.[0]).filter((m): m is string => !!m);
      assertEq(spellings, [], `d8 ${lang}: no «FINN-tannlege», «FINN Tannlege», «finntannlege(n)», «FinnTannlege» or «Finn Tannlege»`);
    }

    // ── (e) setup ─────────────────────────────────────────────────────────
    {
      const card = await callRoute(router, "/.well-known/mcp/server-card.json");
      const remote: string = card.json?.endpoints?.[0]?.url ?? "";
      assertEq(remote, `${base}/mcp`, "e1 control: the server card's endpoint is <base>/mcp");
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "mcp-server-dental", "package.json"), "utf8"));
      for (const [lang, r] of Object.entries(pages)) {
        assertTrue((r.text.match(new RegExp(`<code>${remote.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}</code>`, "g")) || []).length === 2,
          `e2 ${lang}: the remote URL shown (what it is, and the remote setup) is the server card's endpoint`);
        assertTrue(r.text.includes(`<code>npx ${pkg.name}</code>`) && typeof pkg.bin?.[pkg.name] === "string",
          `e3 ${lang}: «npx ${pkg.name}» is mcp-server-dental/package.json's name, and its bin has that command`);
        const pre = unescapeHtml((r.text.match(/<pre class="gta-code">([\s\S]*?)<\/pre>/) || ["", ""])[1]!);
        let config: unknown = null;
        try { config = JSON.parse(pre); } catch { /* reported below */ }
        assertEq(config, { mcpServers: { "finn-tannlege": { command: "npx", args: [pkg.name] } } }, `e4 ${lang}: the Claude Desktop config is valid JSON that runs the package`);
        const source = (r.text.match(/<a href="(https:\/\/github\.com\/slookisen\/lokal\/tree\/main\/[^"]+)" rel="noopener" target="_blank">/) || [])[1] ?? "";
        const dir = source.replace("https://github.com/slookisen/lokal/tree/main/", "");
        assertTrue(dir !== "" && fs.existsSync(path.join(ROOT, dir, "package.json")) && JSON.parse(fs.readFileSync(path.join(ROOT, dir, "package.json"), "utf8")).name === pkg.name,
          `e5 ${lang}: the source link is the package's folder in this repository (${dir})`);
      }
    }

    // ── (f) FAQ ───────────────────────────────────────────────────────────
    for (const [lang, r] of Object.entries(pages)) {
      const faqLd = jsonLdOf(r.text).find((n) => n?.["@type"] === "FAQPage");
      const pairs = (faqLd?.mainEntity ?? []).map((qa: any) => [qa.name, qa.acceptedAnswer.text]);
      assertTrue(!!faqLd && pairs.length === 6, `f1 ${lang}: a FAQPage with six questions`);
      assertEq(visibleFaq(r.text), pairs, `f2 ${lang}: the visible FAQ is the FAQPage JSON-LD`);
      assertEq(faqLd?.["@id"], `${lang === "en" ? EN_URL : NB_URL}#faq`, `f3 ${lang}: FAQPage @id is the canonical #faq`);
    }

    // ── (g) sitemap ───────────────────────────────────────────────────────
    {
      dentalSeo.__resetDentalSitemapCacheForTesting();
      const sm = await callRoute(router, "/sitemap.xml");
      assertEq(sm.status, 200, "g1: GET /sitemap.xml 200");
      for (const u of [NB_URL, EN_URL]) {
        const entries = sm.text.match(new RegExp(`<url><loc>${u.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}</loc>.*?</url>`, "g")) || [];
        assertEq(entries, [`<url><loc>${u}</loc><changefreq>monthly</changefreq><priority>0.6</priority></url>`],
          `g2: ${u} is in the sitemap once, without <lastmod> (its tool list changes with the registration)`);
      }
    }

    // ── (h) discovery ─────────────────────────────────────────────────────
    {
      assertEq(BRAND_ENTITIES.dental.docsUrl, "https://finn-tannlege.com/guide-tannlege-ai", "h1: BRAND_ENTITIES.dental.docsUrl is the guide (the directory pack's documentation URL)");
      assertEq(dentalSeo.dentalAiGuideUrl("nb"), NB_URL, "h2: dentalAiGuideUrl(nb)");
      for (const p of ["/", "/kontakt"]) {
        const r = await callRoute(router, p);
        const footer = (r.text.match(/<footer[\s\S]*?<\/footer>/) || [""])[0];
        assertTrue(footer.includes('<a href="/guide-tannlege-ai">'), `h3 ${p}: the footer links the guide`);
      }
      const llms = await callRoute(router, "/llms.txt");
      assertTrue(llms.text.includes(NB_URL) && llms.text.includes(EN_URL), "h4: llms.txt names the guide in both languages");
    }
  } catch (err: any) {
    failed++;
    failures.push("dental guide-tannlege-ai: unexpected error: " + String(err?.stack || err?.message || err));
    if (log) console.log(`  ✗ unexpected error: ${err?.stack || err}`);
  } finally {
    if (closeMcp) await closeMcp().catch(() => {});
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    if (prevParserOff === undefined) delete process.env.DENTAL_QUERY_PARSER_DISABLED;
    else process.env.DENTAL_QUERY_PARSER_DISABLED = prevParserOff;
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
  console.log("── dental-guide-tannlege-ai: the AI guide on finn-tannlege.com (G3-S4) ──");
  runDentalGuideTannlegeAiTests({ log: true }).then((r) => {
    console.log(`\ndental guide-tannlege-ai: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
