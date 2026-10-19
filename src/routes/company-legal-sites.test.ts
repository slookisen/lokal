/**
 * company-legal-sites.test.ts — A2A dev-request
 * 2026-10-08-juridisk-info-nettsteder-agentplatform-as (+ the 2026-10-09
 * additions T1–T3): AGENTPLATFORM.NO AS operates rettfrabonden.com,
 * opplevagent.no and finn-tannlege.com, and the sites say so.
 *
 * Drives the REAL routers over HTTP with the real Host header (the same
 * host → router dispatch index.ts does) and asserts the acceptance criteria:
 *
 *   AC1 / T1  footer line «En tjeneste fra AGENTPLATFORM.NO AS · Org.nr.
 *             938 635 676» (EN «A service from …») on the front page and deep
 *             pages of every site, NO + EN — the name links to agentplatform.no,
 *             the org.nr. to the site's own /kontakt. Rendered, not escaped.
 *   AC2       /kontakt (NO + EN) shows every § 8 / § 7-2 fact incl. the
 *             site's OWN contact e-mail.
 *   AC3       /personvern names the company as data controller; no public
 *             legal page says «Daniel Fredriksen», «uavhengig prosjekt»,
 *             «independent project» or «Finn-tannlege.com er behandlingsansvarlig».
 *   AC4       /vilkar + /terms (rfb, opplevagent, finn-tannlege) name the
 *             company as operator; «Daniels alminnelige verneting» is gone.
 *   F2-S5     finn-tannlege.com /vilkar (+ /terms, /terms-of-service, /tos;
 *             A2A dev-request 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon,
 *             Daniel approves the text): one canonical, NO + EN, the health
 *             wording (no medical advice, 113 / 116 117, «som de er», clinics'
 *             corrections), the FINN.no sentence, no HPR/NTF claim, the
 *             footer link, the sitemap and ai-plugin.json legal_info_url.
 *   T2        site Organization JSON-LD carries parentOrganization.
 *   T3        agent-card provider (+ MCP server-card vendor, agent-skills
 *             provider) is Agentplatform.no AS; the cards keep their brand name.
 *   Address   the street address is printed on /kontakt and /personvern only.
 *   AC5       the org.nr. digits are hard-coded nowhere in non-test source
 *             except src/config/company-info.ts; the static public HTML pages
 *             that cannot call TS carry a literal copy of the helper output,
 *             locked here so it can never drift.
 *
 * Exported runCompanyLegalSitesTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/company-legal-sites.test.ts
 */

import Database from "better-sqlite3";
import express from "express";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface Resp {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const RFB = "rettfrabonden.com";
const OA = "opplevagent.no";
const FT = "finn-tannlege.com";

/** Every <footer …>…</footer> block of a page, concatenated. */
function footersOf(html: string): string {
  return (html.match(/<footer[\s\S]*?<\/footer>/g) || []).join("\n");
}

/** Every application/ld+json block of a page, parsed (unparseable blocks are skipped). */
function jsonLdOf(html: string): any[] {
  const out: any[] = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const v = JSON.parse(m[1]);
      if (Array.isArray(v)) out.push(...v);
      else out.push(v);
    } catch { /* not ours to judge here */ }
  }
  return out;
}

/** Lines of a source file that are code (not a // or block-comment line). */
function codeLines(src: string): string[] {
  return src.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*(\s|\/|$))/.test(l));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

export async function runCompanyLegalSitesTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, label: string, detail?: string): void => {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}${detail ? ` — ${detail}` : ""}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  };

  const legal = require("../services/company-legal") as typeof import("../services/company-legal");
  const { COMPANY_INFO } = require("../config/company-info") as typeof import("../config/company-info");
  const NAME = COMPANY_INFO.legalName;
  const ORGNR = COMPANY_INFO.orgNrDisplay;
  const STREET = COMPANY_INFO.address.street;
  const line = (lang: "nb" | "en", contactHref: string) => legal.companyFooterLineHtml(lang, { contactHref });
  const NB_LINE = line("nb", "/kontakt");
  const EN_LINE_EN_KONTAKT = line("en", "/en/kontakt");

  // ── Sanity on the helper output itself (rendered HTML, not escaped) ──
  check(NB_LINE.startsWith("En tjeneste fra <a href=\"https://agentplatform.no\">AGENTPLATFORM.NO AS</a> · "), "helper: NB footer line names the company and links it to agentplatform.no", NB_LINE);
  check(NB_LINE.includes('<a href="/kontakt">Org.nr. 938 635 676</a>'), "helper: NB footer line links the org.nr. to the site's /kontakt", NB_LINE);
  check(EN_LINE_EN_KONTAKT.startsWith("A service from ") && EN_LINE_EN_KONTAKT.includes('<a href="/en/kontakt">Org. no. 938 635 676</a>'), "helper: EN footer line", EN_LINE_EN_KONTAKT);
  check(!NB_LINE.includes(STREET) && !/MVA/.test(NB_LINE), "helper: footer line has no street address and no «MVA»");

  // ── Hermetic DBs + fresh routers (same isolation as discovery-truth.test.ts) ──
  const { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } = require("../database/init") as
    typeof import("../database/init");
  const prevRfbDb = __peekDbForTesting();
  const prevDentalDbPath = process.env.DENTAL_DB_PATH;
  const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
  const rfbTestDb = new Database(":memory:");
  rfbTestDb.pragma("journal_mode = DELETE");
  rfbTestDb.pragma("foreign_keys = OFF");
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.EXPERIENCES_DB_PATH = ":memory:";

  const cachePaths = [
    "../database/db-factory",
    "../services/dental-store",
    "../services/experience-store",
    "./a2a",
    "./seo",
    "./discovery",
    "./conversation-ui",
    "./agent-readiness",
    "./dental-seo",
    "./experiences-seo",
    "./mcp",
    "./experiences-mcp",
    "./dental-mcp",
  ].map((rel) => require.resolve(rel));
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

  let server: http.Server | undefined;
  try {
    const cfgMod = require("../config/vertical-config") as typeof import("../config/vertical-config");
    cfgMod._resetConfigCacheForTests();
    cfgMod.loadConfigsAtBoot({ dir: "./verticals" });

    __setDbForTesting(rfbTestDb as any);
    __initSchemaForTesting(rfbTestDb as any);
    const regMod = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
    (regMod.marketplaceRegistry as any)._statsCache = null;
    (regMod.marketplaceRegistry as any)._agentsCache = null;
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    dbFactory.getDb("dental");
    dbFactory.getDb("experiences");

    const { langMiddleware } = require("../i18n/middleware") as typeof import("../i18n/middleware");
    const seoRouter = require("./seo").default;
    const discoveryRouter = require("./discovery").default;
    const conversationRouter = require("./conversation-ui").default;
    const readinessRouter = require("./agent-readiness").default;
    const a2aRouter = require("./a2a").default;
    const rfbMcpRouter = require("./mcp").default;
    const expRouter = require("./experiences-seo").default;
    const expMcpRouter = require("./experiences-mcp").default;
    const dentalRouter = require("./dental-seo").default;
    const dentalMcpRouter = require("./dental-mcp").default;

    // Host → router dispatch, mirroring index.ts (langMiddleware first, then
    // the dental / opplevagent host gates, then the rfb routers at root).
    const app = express();
    app.use(express.json());
    app.use(langMiddleware);
    app.use((req: any, res: any, next: any) => {
      const p = req.path;
      if (req.hostname === FT) {
        if (p === "/mcp" || p.startsWith("/mcp/")) return dentalMcpRouter(req, res, next);
        return dentalRouter(req, res, next);
      }
      if (req.hostname === OA) {
        if (p === "/mcp" || p.startsWith("/mcp/")) return expMcpRouter(req, res, next);
        return expRouter(req, res, next);
      }
      return next();
    });
    app.use("/mcp", rfbMcpRouter);
    app.use("/", readinessRouter);
    app.use("/", a2aRouter);
    app.use("/", conversationRouter);
    app.use("/", discoveryRouter);
    app.use("/", seoRouter);
    app.use((_req, res) => res.status(418).send("fell-through"));

    server = http.createServer(app);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    const get = (p: string, host: string, accept = "text/html"): Promise<Resp> =>
      new Promise((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path: p, headers: { host, accept } }, (resp) => {
            const chunks: Buffer[] = [];
            resp.on("data", (c) => chunks.push(c as Buffer));
            resp.on("end", () => resolve({ status: resp.statusCode || 0, headers: resp.headers, body: Buffer.concat(chunks).toString("utf8") }));
          })
          .on("error", reject);
      });

    // Pages collected for the cross-cutting checks at the end.
    const seen: { label: string; host: string; path: string; body: string }[] = [];
    const page = async (host: string, p: string, accept?: string): Promise<Resp> => {
      const r = await get(p, host, accept);
      seen.push({ label: `${host}${p}`, host, path: p, body: r.body });
      return r;
    };

    // ═══════════════ AC1 / T1 — footer line on every site, NO + EN ═══════════════
    const footerCases: { host: string; path: string; expect: string; accept?: string }[] = [
      // rettfrabonden.com — shell() footer (front + deep, NO + EN)
      { host: RFB, path: "/", expect: NB_LINE },
      { host: RFB, path: "/en", expect: EN_LINE_EN_KONTAKT },
      { host: RFB, path: "/om", expect: NB_LINE },
      { host: RFB, path: "/en/om", expect: EN_LINE_EN_KONTAKT },
      { host: RFB, path: "/teknologi", expect: NB_LINE },
      { host: RFB, path: "/kontakt", expect: NB_LINE },
      { host: RFB, path: "/en/kontakt", expect: EN_LINE_EN_KONTAKT },
      { host: RFB, path: "/personvern", expect: NB_LINE },
      { host: RFB, path: "/en/personvern", expect: EN_LINE_EN_KONTAKT },
      // conversation-ui chatShell, the bilingual /vilkar page, the /mcp browser page
      { host: RFB, path: "/samtaler", expect: NB_LINE },
      { host: RFB, path: "/vilkar", expect: NB_LINE },
      { host: RFB, path: "/terms", expect: NB_LINE },
      { host: RFB, path: "/mcp", expect: NB_LINE, accept: "text/html,application/xhtml+xml" },
      // opplevagent.no — shared site footer (front NO/EN), browse footer,
      // legal-page footer, guide footer (NO/EN), /kontakt, /mcp browser page
      { host: OA, path: "/", expect: NB_LINE },
      { host: OA, path: "/en", expect: EN_LINE_EN_KONTAKT },
      { host: OA, path: "/opplevelser", expect: NB_LINE },
      { host: OA, path: "/reise", expect: NB_LINE },
      { host: OA, path: "/guide-opplevelser-mcp", expect: NB_LINE },
      { host: OA, path: "/en/guide-opplevelser-mcp", expect: EN_LINE_EN_KONTAKT },
      { host: OA, path: "/kontakt", expect: NB_LINE },
      { host: OA, path: "/personvern", expect: NB_LINE },
      { host: OA, path: "/vilkar", expect: NB_LINE },
      { host: OA, path: "/for-tilbydere", expect: NB_LINE },
      { host: OA, path: "/finnes-ikke-404", expect: NB_LINE },
      { host: OA, path: "/mcp", expect: NB_LINE, accept: "text/html,application/xhtml+xml" },
      // finn-tannlege.com — dentalShell footer (Norwegian site: /en/ serves the
      // same Norwegian page, footer included; the AI guide is the one English
      // page, G3-S4), /mcp browser page
      { host: FT, path: "/", expect: NB_LINE },
      { host: FT, path: "/en/", expect: NB_LINE },
      { host: FT, path: "/en/guide-tannlege-ai", expect: EN_LINE_EN_KONTAKT },
      { host: FT, path: "/om", expect: NB_LINE },
      { host: FT, path: "/personvern", expect: NB_LINE },
      { host: FT, path: "/kontakt", expect: NB_LINE },
      { host: FT, path: "/vilkar", expect: NB_LINE },
      { host: FT, path: "/terms", expect: NB_LINE },
      { host: FT, path: "/finnes-ikke-404", expect: NB_LINE },
      { host: FT, path: "/mcp", expect: NB_LINE, accept: "text/html,application/xhtml+xml" },
    ];
    for (const c of footerCases) {
      const r = await page(c.host, c.path, c.accept);
      const foot = footersOf(r.body);
      check(r.status === 200 || (c.path.includes("404") && r.status === 404), `T1 ${c.host}${c.path}: renders (status ${r.status})`);
      check(foot.includes(c.expect), `T1 ${c.host}${c.path}: footer carries the company line (${c.expect.startsWith("A service") ? "EN" : "NO"})`, foot.slice(0, 400));
      check(foot.includes(NAME) && foot.includes(ORGNR), `AC1 ${c.host}${c.path}: footer shows «${NAME}» and «${ORGNR}»`);
      check(!foot.includes(STREET), `address ${c.host}${c.path}: no street address in the footer`);
      check(!/&lt;a href="https:\/\/agentplatform\.no/.test(r.body), `xss ${c.host}${c.path}: company link rendered as HTML, not double-escaped`);
    }

    // ═══════════════ AC2 — /kontakt facts, NO + EN, each site's own e-mail ═══════════════
    const contactCases: { host: string; path: string; lang: "nb" | "en"; email: string; others: string[] }[] = [
      { host: RFB, path: "/kontakt", lang: "nb", email: "kontakt@rettfrabonden.com", others: ["kontakt@opplevagent.no", "kontakt@finn-tannlege.com"] },
      { host: RFB, path: "/en/kontakt", lang: "en", email: "kontakt@rettfrabonden.com", others: ["kontakt@opplevagent.no", "kontakt@finn-tannlege.com"] },
      { host: OA, path: "/kontakt", lang: "nb", email: "kontakt@opplevagent.no", others: ["kontakt@rettfrabonden.com", "kontakt@finn-tannlege.com"] },
      { host: OA, path: "/en/kontakt", lang: "en", email: "kontakt@opplevagent.no", others: ["kontakt@rettfrabonden.com", "kontakt@finn-tannlege.com"] },
      { host: FT, path: "/kontakt", lang: "nb", email: "kontakt@finn-tannlege.com", others: ["kontakt@rettfrabonden.com", "kontakt@opplevagent.no"] },
      { host: FT, path: "/en/kontakt", lang: "en", email: "kontakt@finn-tannlege.com", others: ["kontakt@rettfrabonden.com", "kontakt@opplevagent.no"] },
    ];
    for (const c of contactCases) {
      const r = await page(c.host, c.path);
      const b = r.body;
      const label = `AC2 ${c.host}${c.path}`;
      check(r.status === 200, `${label}: 200`);
      check(b.includes(legal.companyContactBlockHtml(c.lang, { siteEmail: c.email, className: "co-facts" })), `${label}: the facts block is the helper's output (COMPANY_INFO), with the site's own e-mail`);
      check(b.includes(c.lang === "en" ? "Company information" : "Selskapsinformasjon"), `${label}: «${c.lang === "en" ? "Company information" : "Selskapsinformasjon"}» heading`);
      check(b.includes(NAME), `${label}: company name`);
      check(c.lang === "en" ? b.includes("Private limited company (AS)") : b.includes("Aksjeselskap"), `${label}: organisation form`);
      check(b.includes(c.lang === "en" ? "Head office" : "Hovedkontor") && b.includes("<dd>Oslo</dd>"), `${label}: head office Oslo`);
      check(b.includes(`${STREET}, ${COMPANY_INFO.address.postalCode} ${COMPANY_INFO.address.city}`), `${label}: business address`);
      check(b.includes("Foretaksregisteret") && b.includes(ORGNR), `${label}: «Foretaksregisteret» + org.nr.`);
      check(
        c.lang === "en" ? b.includes("Not registered in the Norwegian VAT Register") : b.includes("Ikke registrert i Merverdiavgiftsregisteret"),
        `${label}: VAT status (not VAT-registered)`,
      );
      check(b.includes(`mailto:${c.email}`), `${label}: the site's own contact e-mail (${c.email})`);
      check(c.others.every((o) => !b.includes(o)), `${label}: no other site's contact e-mail`);
      check(b.includes('href="https://agentplatform.no"'), `${label}: company website link`);
    }

    // ═══════════════ AC3 — /personvern names the company as data controller ═══════════════
    {
      const no = await page(RFB, "/personvern");
      const en = await page(RFB, "/en/personvern");
      check(no.body.includes(legal.companyControllerSentenceHtml("nb", { siteName: "Rett fra Bonden", siteEmail: "kontakt@rettfrabonden.com" })), "AC3 rfb /personvern: controller sentence (NO) with the company, org.nr., address and site e-mail");
      check(en.body.includes(legal.companyControllerSentenceHtml("en", { siteName: "Rett fra Bonden", siteEmail: "kontakt@rettfrabonden.com" })), "AC3 rfb /en/personvern: controller sentence (EN)");
      const oa = await page(OA, "/personvern");
      check(oa.body.includes(legal.companyControllerSentenceHtml("nb", { siteName: "Opplevagent", siteEmail: "kontakt@opplevagent.no" })), "AC3 opplevagent /personvern: controller sentence (NO section)");
      check(oa.body.includes(legal.companyControllerSentenceHtml("en", { siteName: "Opplevagent", siteEmail: "kontakt@opplevagent.no" })), "AC3 opplevagent /personvern: controller sentence (EN section)");
      const ft = await page(FT, "/personvern");
      check(ft.body.includes(legal.companyControllerSentenceHtml("nb", { siteName: "Finn-tannlege.com", siteEmail: "kontakt@finn-tannlege.com" })), "AC3 finn-tannlege /personvern: controller sentence");
      for (const [label, r] of [["rfb", no], ["rfb en", en], ["opplevagent", oa], ["finn-tannlege", ft]] as const) {
        check(r.body.includes(NAME) && r.body.includes(ORGNR), `AC3 ${label} /personvern: «${NAME}» with org.nr.`);
        check(r.body.includes(STREET), `AC3 ${label} /personvern: business address stated (art. 13 controller identity)`);
      }
      // Unchanged privacy wording around the replaced sentence stays put.
      check(no.body.includes("er en åpen katalog over lokale") && en.body.includes("is an open catalogue of local"), "AC3 rfb /personvern: the surrounding «Hvem vi er» wording is untouched");
      check(ft.body.includes("<h2>Behandlingsansvarlig</h2>") && ft.body.includes("<h2>Hvilke data behandler vi?</h2>"), "AC3 finn-tannlege /personvern: headings kept (data wording corrected in dental-privacy-truth.test.ts)");
      // 2026-10-13 (statistikk-riktig-for-investorer, S2): the visit and search
      // statistics have their own section, and are not called anonymous.
      check(ft.body.includes("<h2>Besøks- og søkestatistikk</h2>") && ft.body.includes("slettes automatisk etter 60 dager") && !ft.body.includes("kun anonym, aggregert"),
        "AC3 finn-tannlege /personvern: visit and search statistics described (IP hash, 60 days), not called anonymous");
      check(oa.body.includes("Ingen sporingscookies.") && oa.body.includes("No tracking cookies."), "AC3 opplevagent /personvern: cookie wording untouched");
    }

    // ═══════════════ AC4 — /vilkar + /terms name the company as operator ═══════════════
    for (const host of [RFB, OA, FT]) {
      for (const p of ["/vilkar", "/terms"]) {
        const r = await page(host, p);
        const label = `AC4 ${host}${p}`;
        check(r.status === 200, `${label}: 200`);
        check(r.body.includes(legal.companyOperatorSentence("nb")), `${label}: «${legal.companyOperatorSentence("nb")}»`);
        check(r.body.includes(legal.companyOperatorSentence("en")), `${label}: «${legal.companyOperatorSentence("en")}»`);
        check(r.body.includes("selskapets alminnelige verneting"), `${label}: «selskapets alminnelige verneting»`);
        check(r.body.includes("the company's ordinary venue"), `${label}: «the company's ordinary venue»`);
        check(!r.body.includes(STREET), `${label}: no street address on the terms page`);
      }
    }

    // ═══════════════ F2-S5 — finn-tannlege.com /vilkar ═══════════════
    // A 404 until this slice: new terms were a non-goal of the 2026-10-08
    // legal-info dev-request, because Daniel approves the text first.
    {
      const { BRAND_ENTITIES } = require("../config/brand-entities") as typeof import("../config/brand-entities");
      const FINN_NB = BRAND_ENTITIES.dental.disambiguation?.nb ?? "";
      const FINN_EN = BRAND_ENTITIES.dental.disambiguation?.en ?? "";
      const CANONICAL = '<link rel="canonical" href="https://finn-tannlege.com/vilkar">';
      const vilkar = await page(FT, "/vilkar");
      for (const p of ["/vilkar", "/terms", "/terms-of-service", "/tos"]) {
        const r = p === "/vilkar" ? vilkar : await page(FT, p);
        const label = `F2-S5 ${FT}${p}`;
        check(r.status === 200 && String(r.headers["content-type"]).startsWith("text/html"), `${label}: 200 text/html`, `${r.status} ${r.headers["content-type"]}`);
        check(r.body.split(CANONICAL).length === 2, `${label}: one canonical, https://finn-tannlege.com/vilkar`);
        check(r.body === vilkar.body, `${label}: the same page as /vilkar`);
      }
      const main = vilkar.body.match(/<main>[\s\S]*?<\/main>/)?.[0] ?? "";
      const [nb, en = ""] = main.split('<h1 id="en">');
      check(nb.includes("<h1>Vilkår for bruk</h1>") && en.startsWith("Terms of Service</h1>"), "F2-S5 /vilkar: Norwegian section, then the English one under #en");
      check(/<div lang="en">\s*$/.test(nb) && nb.includes('<a href="#en">English</a>'), "F2-S5 /vilkar: the English section is marked lang=\"en\" and linked from the top");
      check(nb.includes(legal.companyOperatorSentence("nb")) && en.includes(legal.companyOperatorSentence("en")), "F2-S5 /vilkar: each language has its operator line");
      check(FINN_NB !== "" && nb.includes(FINN_NB) && FINN_EN !== "" && en.includes(FINN_EN), "F2-S5 /vilkar: each language says Finn-tannlege.com is not affiliated with FINN.no (BRAND_ENTITIES.dental)");
      // The health wording the spec asks for, in both languages.
      const wording: Array<[string, string, string]> = [
        ["bestiller ikke timer og tar ikke imot betaling", "do not book appointments and we do not take payments", "no booking, no payment"],
        ["ikke medisinsk eller odontologisk rådgivning", "not medical or dental advice", "not medical advice"],
        ["<strong>Ved akutt fare for liv eller helse: ring 113.</strong>", "<strong>If life or health is in immediate danger: call 113.</strong>", "113 first"],
        ["legevakten på 116 117 eller tannlegevakten der du bor", "(legevakt) on 116 117 or the emergency dental service (tannlegevakt) where you live", "legevakt 116 117 or tannlegevakt"],
        ["betyr ikke at den kan ta imot deg nå", "may still be unable to see you now", "an emergency badge is no promise"],
        ["<strong>Opplysningene vises «som de er».</strong>", "<strong>The information is provided \"as is\".</strong>", "as is"],
        ['href="/proveniens"', 'href="/proveniens"', "sources and method on /proveniens"],
        ["kan klinikken be om at de rettes, eller at oppføringen fjernes", "the clinic can ask for it to be corrected, or for the listing to be removed", "clinics' corrections and removal"],
        ['href="mailto:kontakt@finn-tannlege.com"', 'href="mailto:kontakt@finn-tannlege.com"', "the site's own e-mail"],
        ['href="/personvern"', 'href="/personvern"', "the privacy policy"],
        ["Norsk rett gjelder.", "Norwegian law applies.", "Norwegian law"],
      ];
      for (const [no, eng, what] of wording) {
        check(nb.includes(no), `F2-S5 /vilkar NO: ${what}`, no);
        check(en.includes(eng), `F2-S5 /vilkar EN: ${what}`, eng);
      }
      check(!["kontakt@rettfrabonden.com", "kontakt@opplevagent.no"].some((e) => vilkar.body.includes(e)), "F2-S5 /vilkar: no other site's contact e-mail");
      // Pkt. 7 and 11 in each language link the site's own address, read from
      // BRAND_ENTITIES.dental.supportEmail (not a second copy in the handler).
      const MAILTO = `href="mailto:${BRAND_ENTITIES.dental.supportEmail}"`;
      for (const [lang, section] of [["NO", nb], ["EN", en]] as const) {
        const links = section.match(/href="mailto:[^"]*"/g) || [];
        check(links.length === 2 && links.every((l) => l === MAILTO), `F2-S5 /vilkar ${lang}: both e-mail links are BRAND_ENTITIES.dental.supportEmail`, links.join(", "));
      }
      // F2-S1's acceptance grep, on the page content: none of the sources the
      // code does not use (the footer's «Datakilder» column is F2-S1's).
      const unused = main.match(/HPR|Helsepersonellregister|helsedirektoratet|ntf\.no|tannlegeforening/gi) || [];
      check(unused.length === 0, "F2-S5 /vilkar: names no HPR, Helsedirektoratet or NTF source", unused.join(", "));
      const compliance = ["sertifisert", "certified", "compliance", "compliant"].filter((w) => main.toLowerCase().includes(w));
      check(compliance.length === 0, "F2-S5 /vilkar: claims no certification or compliance", compliance.join(", "));

      // Footer link on every dental shell page fetched above, once per path
      // (not the /mcp browser page, which has only the company line).
      const shellPages = [...new Map(seen.filter((s) => s.host === FT && s.path !== "/mcp").map((s) => [s.path, s])).values()];
      check(shellPages.length >= 8, `F2-S5 control: dental shell pages fetched (${shellPages.length})`);
      for (const s of shellPages) {
        check(footersOf(s.body).includes('<a href="/vilkar">Vilkår</a>'), `F2-S5 ${s.label}: the footer links /vilkar`);
      }

      const plug = await get("/.well-known/ai-plugin.json", FT, "application/json");
      let manifest: any = null;
      try { manifest = JSON.parse(plug.body); } catch { /* reported below */ }
      check(manifest?.legal_info_url === "https://finn-tannlege.com/vilkar", "F2-S5 ai-plugin.json: legal_info_url is /vilkar (regression: /om)", String(manifest?.legal_info_url));
      check(manifest?.contact_url === "https://finn-tannlege.com/kontakt", "F2-S5 ai-plugin.json: contact_url unchanged");
      const sitemap = await get("/sitemap.xml", FT, "application/xml");
      check(sitemap.body.split("<loc>https://finn-tannlege.com/vilkar</loc>").length === 2, "F2-S5 sitemap.xml: lists /vilkar once");
      check(!/<loc>https:\/\/finn-tannlege\.com\/(terms|terms-of-service|tos)<\/loc>/.test(sitemap.body), "F2-S5 sitemap.xml: the aliases are not listed");
      check(BRAND_ENTITIES.dental.termsUrl === "https://finn-tannlege.com/vilkar", "F2-S5 brand-entities: BRAND_ENTITIES.dental.termsUrl is /vilkar", String(BRAND_ENTITIES.dental.termsUrl));
    }

    // ═══════════════ AC3 / AC4 — forbidden phrases on every page fetched ═══════════════
    const FORBIDDEN = [
      "Daniel Fredriksen",
      "uavhengig prosjekt",
      "independent project",
      "Finn-tannlege.com er behandlingsansvarlig",
      "Daniels alminnelige verneting",
      "Daniel's ordinary venue",
      "Daniel&#39;s ordinary venue",
    ];
    for (const s of seen) {
      const hits = FORBIDDEN.filter((f) => s.body.includes(f));
      check(hits.length === 0, `AC3 ${s.label}: none of the replaced operator statements`, hits.join(", "));
      // The «938 635 676 MVA» suffix (same text run, at most inline tags in
      // between). The /kontakt facts list's own «MVA» row label — the VAT
      // status line the spec asks for — sits in a separate <dt> and is fine.
      check(
        !new RegExp(`${ORGNR}\\s*(?:<\\/?(?:a|span|strong|b|em)\\b[^>]*>\\s*)*MVA`, "i").test(s.body),
        `mva ${s.label}: never «MVA» after the org.nr.`,
      );
    }

    // ═══════════════ Street address only on /kontakt and /personvern ═══════════════
    for (const s of seen) {
      const allowed = /\/(kontakt|personvern)$/.test(s.path);
      if (!allowed) check(!s.body.includes(STREET), `address ${s.label}: street address absent (only /kontakt and /personvern carry it)`);
    }

    // ═══════════════ T2 — parentOrganization in each site's Organization JSON-LD ═══════════════
    // G3-S1 (A2A dev-request 2026-10-16-merkevare-entitet-og-connector-pakker):
    // the parent carries sameAs with the Brreg page on every site, and the
    // rettfrabonden.com and opplevagent.no front pages publish
    // organizationJsonLd(<vertical>) (PNG logo, the domain as alternateName).
    // finn-tannlege.com follows once dental-seo.ts is wired to it.
    const parent = legal.parentOrganizationJsonLd();
    const builtFor: Record<string, "rfb" | "experiences" | null> = { [RFB]: "rfb", [OA]: "experiences", [FT]: null };
    for (const [host, p] of [[RFB, "/"], [RFB, "/en"], [OA, "/"], [OA, "/en"], [FT, "/"]] as const) {
      const r = await get(p, host);
      const lds = jsonLdOf(r.body);
      const org = lds.find((o) => o && o["@type"] === "Organization" && o.parentOrganization);
      check(!!org, `T2 ${host}${p}: the site's Organization JSON-LD has parentOrganization`);
      check(!!org && JSON.stringify(org.parentOrganization) === JSON.stringify(parent), `T2 ${host}${p}: parentOrganization is parentOrganizationJsonLd() (Agentplatform.no AS, url https://agentplatform.no)`, org ? JSON.stringify(org.parentOrganization) : "");
      check(!!org && org.parentOrganization.url === "https://agentplatform.no", `T2 ${host}${p}: parentOrganization.url = https://agentplatform.no`);
      check(!!org && Array.isArray(org.parentOrganization.sameAs) && org.parentOrganization.sameAs.includes(COMPANY_INFO.brregUrl), `G3-S1 ${host}${p}: parentOrganization.sameAs holds the Brreg URL`, org ? JSON.stringify(org.parentOrganization.sameAs) : "");
      check(!!org && org.name !== NAME && org.name !== COMPANY_INFO.displayName, `T2 ${host}${p}: the site's Organization keeps its brand name (${org?.name})`);
      check(!JSON.stringify(lds).includes(STREET), `T2 ${host}${p}: no street address in JSON-LD`);
      check(lds.some((o) => o && o["@type"] === "WebSite"), `T2 ${host}${p}: WebSite JSON-LD still present`);
      const vertical = builtFor[host];
      if (vertical) {
        const built = legal.organizationJsonLd(vertical);
        check(!!org && Object.entries(built).every(([k, v]) => JSON.stringify(org[k]) === JSON.stringify(v)), `G3-S1 ${host}${p}: the front-page Organization is organizationJsonLd("${vertical}")`, org ? JSON.stringify(org) : "");
        check(!!org && typeof org.logo === "string" && /^https:\/\/\S+\.png$/.test(org.logo), `G3-S1 ${host}${p}: Organization.logo is a PNG`, String(org?.logo));
        check(lds.filter((o) => o && o["@type"] === "Organization").length === 1, `G3-S1 ${host}${p}: exactly one site Organization on the front page`);
      }
    }

    // ═══════════════ T3 — agent-card provider (+ server-card vendor) ═══════════════
    const expectedProvider = { organization: "Agentplatform.no AS", url: "https://agentplatform.no" };
    check(JSON.stringify(legal.agentCardProvider()) === JSON.stringify(expectedProvider), "T3: agentCardProvider() = Agentplatform.no AS / https://agentplatform.no");
    for (const [host, brand] of [[RFB, "Rett fra Bonden"], [OA, "Opplevagent"], [FT, "Finn-tannlege"]] as const) {
      const r = await get("/.well-known/agent-card.json", host, "application/json");
      let card: any = null;
      try { card = JSON.parse(r.body); } catch { /* reported below */ }
      check(r.status === 200 && !!card, `T3 ${host}: /.well-known/agent-card.json serves JSON`, `${r.status}`);
      check(card?.provider?.organization === expectedProvider.organization, `T3 ${host}: provider.organization = «${expectedProvider.organization}»`, JSON.stringify(card?.provider));
      check(card?.provider?.url === expectedProvider.url, `T3 ${host}: provider.url = ${expectedProvider.url}`);
      check(card?.name === brand, `T3 ${host}: card name keeps the brand «${brand}»`, String(card?.name));
      const sc = await get("/.well-known/mcp/server-card.json", host, "application/json");
      let scard: any = null;
      try { scard = JSON.parse(sc.body); } catch { /* reported below */ }
      check(scard?.vendor?.name === expectedProvider.organization && scard?.vendor?.url === expectedProvider.url, `T3 ${host}: MCP server-card vendor = the company`, JSON.stringify(scard?.vendor));
    }
    {
      const r = await get("/a2a", RFB, "application/json");
      let card: any = null;
      try { card = JSON.parse(r.body); } catch { /* reported below */ }
      check(card?.provider?.organization === expectedProvider.organization && card?.provider?.url === expectedProvider.url, "T3 rettfrabonden.com: GET /a2a card provider matches the .well-known card", JSON.stringify(card?.provider));
      check(card?.name === "Rett fra Bonden", "T3 rettfrabonden.com: GET /a2a card keeps the brand name");
      const skills = await get("/.well-known/agent-skills/index.json", RFB, "application/json");
      let idx: any = null;
      try { idx = JSON.parse(skills.body); } catch { /* reported below */ }
      check(idx?.provider?.name === expectedProvider.organization && idx?.provider?.url === expectedProvider.url, "T3 rettfrabonden.com: agent-skills index provider = the company", JSON.stringify(idx?.provider));
    }
  } catch (err: any) {
    failed++;
    failures.push(`company-legal-sites: unexpected error: ${err?.stack || err?.message || String(err)}`);
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    if (prevRfbDb) __setDbForTesting(prevRfbDb);
    if (prevDentalDbPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalDbPath;
    if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
    try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best-effort */ }
    try {
      const regMod = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
      (regMod.marketplaceRegistry as any)._statsCache = null;
      (regMod.marketplaceRegistry as any)._agentsCache = null;
    } catch { /* best-effort */ }
    restoreModuleCache();
    try { rfbTestDb.close(); } catch { /* best-effort */ }
  }

  // ═══════════════ AC5 — org.nr. hard-coded only in company-info.ts ═══════════════
  {
    const { COMPANY_INFO } = require("../config/company-info") as typeof import("../config/company-info");
    const srcRoot = path.join(__dirname, "..");
    const configFile = path.join(srcRoot, "config", "company-info.ts");
    const digitsRe = new RegExp(`${COMPANY_INFO.orgNr.slice(0, 3)}[\\s\\u00a0.]?${COMPANY_INFO.orgNr.slice(3, 6)}[\\s\\u00a0.]?${COMPANY_INFO.orgNr.slice(6)}`);
    check(codeLines(fs.readFileSync(configFile, "utf8")).some((l) => digitsRe.test(l)), "AC5 control: the scanner does find the org.nr. in company-info.ts (not a vacuous scan)");
    const offenders: string[] = [];
    for (const f of walk(srcRoot)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts") || f === configFile) continue;
      const lines = codeLines(fs.readFileSync(f, "utf8"));
      if (lines.some((l) => digitsRe.test(l))) offenders.push(path.relative(srcRoot, f));
    }
    check(offenders.length === 0, "AC5: no non-test .ts source outside src/config/company-info.ts hard-codes the org.nr.", offenders.join(", "));

    // Static public pages (served by express.static, cannot call TS): they may
    // carry the org.nr. ONLY inside an exact copy of the helper's footer line.
    const legal = require("../services/company-legal") as typeof import("../services/company-legal");
    const NB = legal.companyFooterLineHtml("nb", { contactHref: "/kontakt" });
    const EN = legal.companyFooterLineHtml("en", { contactHref: "/en/kontakt" });
    const publicDir = path.join(srcRoot, "public");
    const htmlOffenders: string[] = [];
    for (const f of fs.readdirSync(publicDir)) {
      if (!f.endsWith(".html")) continue;
      const stripped = fs.readFileSync(path.join(publicDir, f), "utf8").split(NB).join("").split(EN).join("");
      if (digitsRe.test(stripped)) htmlOffenders.push(f);
    }
    check(htmlOffenders.length === 0, "AC5: src/public/*.html carry the org.nr. only inside an exact copy of companyFooterLineHtml() (drift lock)", htmlOffenders.join(", "));
    for (const f of ["app.html", "dashboard.html", "selger.html"]) {
      const html = fs.readFileSync(path.join(publicDir, f), "utf8");
      check(digitsRe.test(html), `AC5 control: the HTML scan sees the org.nr. in ${f} before stripping the helper copies`);
      const foot = footersOf(html);
      check(foot.includes(NB), `T1 static ${f}: footer carries the literal NO company line, byte-equal to companyFooterLineHtml("nb")`);
      check(!foot.includes(COMPANY_INFO.address.street), `address static ${f}: no street address in the footer`);
    }
    {
      const selger = fs.readFileSync(path.join(publicDir, "selger.html"), "utf8");
      check(footersOf(selger).includes(EN), 'T1 static selger.html: EN company line, byte-equal to companyFooterLineHtml("en", "/en/kontakt")');
      check(/document\.querySelectorAll\('\[data-company-lang\]'\)/.test(selger), "T1 static selger.html: applyLang() switches the company line with the page language");
    }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runCompanyLegalSitesTests({ log: true }).then((s) => {
    console.log(`\ncompany-legal-sites: ${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    // route modules start background timers; exit explicitly
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
