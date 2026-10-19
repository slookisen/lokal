/**
 * dental-akutt-tekster.test.ts — A2A dev-request 2026-10-16-finn-tannlege-fasettsider,
 * F1-S4e: the akutt texts on Finn-tannlege say what the badges and the filter do
 * after F1-S4c, with Daniel's definition A of «Akuttvakt» (questions 33 and 34).
 *
 * The real dental-seo router on an in-memory dental DB with one clinic per akutt
 * claim: «Akuttvakt» (acute_vakt 1 with a stored quote), «Tar imot akuttpasienter»
 * (a stamp without a quote, or akutt in patient_focus) and none (the bare flag,
 * nothing). Groups, by prefix (the spec's points in brackets):
 *   S   /sok: the filter's label is «Akutthjelp», for both claims; akutt=1
 *       lists the same clinics as before (the claim rows, DENTAL_ACUTE_CLAIM_SQL
 *       and resolveAcuteClaim agree) and keeps the box ticked [1];
 *   F   the homepage banner links /sok?akutt=1 with «Se klinikker som oppgir
 *       akutthjelp» [2];
 *   H   /hvordan-det-fungerer: the FAQ JSON-LD answer to «Hva gjør jeg ved
 *       akutt tannverk?» is DENTAL_EMERGENCY_NOTICE.text, and «Akutt tannverk»
 *       shows the same text (the notice box, tel: links) in place of «søk på
 *       klinikker med Akuttvakt-merke» [3, 5]; «Hva betyr merkene?» explains
 *       both badges in the card's badge style, «Akuttvakt» by definition A [4];
 *       step 1 names the filter by its label;
 *   P   /proveniens, nb and en: «Akuttvakt» needs a stored quote from the
 *       clinic's own page, by definition A; a stored source is not enough [6];
 *   J   /.well-known/ai-plugin.json is valid JSON, and its descriptions name the
 *       claim, not the duty alone [7];
 *   G   the tool cards and the tools FAQ on /guide-tannlege-ai (nb, en) read as
 *       the tool texts of G3-S6d: an «akuttpåstand» / «emergency claim»,
 *       «Akuttvakt» only with a stored quote [8];
 *   A   the A2A agent card's description and skill texts [9]; tannlege_stats'
 *       «(akutt)» [10] is in dental-mcp-instructions.test.ts (D9d, D10c);
 *   L   the lock [11]: emergencyDutyWithoutQuote() finds nothing on the
 *       surfaces of points 3–9, and each surface still names the claim (not
 *       vacuous). Left out, as the spec says: the search words (the agent
 *       card's examples, dental-search-vocabulary.ts), and the field list and
 *       method table built from DENTAL_DATA_SOURCES, whose «akuttvakt» /
 *       «emergency duty» names the stored field;
 *   Z   no public page or document in this test says «Akuttvakt-merke» or
 *       «akuttvakt-tilbud», or gives the directory-enquiry number the spec
 *       rules out; the akutt texts give no phone number beyond
 *       DENTAL_EMERGENCY_NOTICE's (llms.txt and the raw REST text follow F2-S7
 *       and are not read here);
 *   N   the checks are not vacuous: every text before F1-S4e fails them.
 *
 * Standalone: npx tsx src/routes/dental-akutt-tekster.test.ts
 * Wired into tests/test.ts via runDentalAkuttTeksterTests().
 */

import { emergencyDutyWithoutQuote } from "./dental-mcp-instructions.test";

export interface TestSummary { passed: number; failed: number; failures: string[] }

interface RouteResult { status: number; text: string; json: any }

function fakeReq(url: string, lang: string): any {
  const query = Object.fromEntries(new URLSearchParams(url.split("?")[1] ?? ""));
  return {
    method: "GET", url, originalUrl: url,
    // A getter, as on a real request: langMiddleware rewrites req.url.
    get path() { return String(this.url).split("?")[0]; },
    params: {}, query, headers: {}, ip: "127.0.0.1", hostname: "finn-tannlege.com", lang,
    get() { return undefined; },
  };
}

function fakeRes(resolve: (r: RouteResult) => void): any {
  return {
    statusCode: 200,
    locals: {},
    status(code: number) { this.statusCode = code; return this; },
    setHeader() { return this; },
    header() { return this; },
    set() { return this; },
    vary() { return this; },
    once() { return this; },
    send(payload: any) { resolve({ status: this.statusCode, text: String(payload ?? ""), json: undefined }); return this; },
    json(payload: any) { resolve({ status: this.statusCode, text: JSON.stringify(payload), json: payload }); return this; },
  };
}

function callRoute(router: any, url: string): Promise<RouteResult> {
  return new Promise((resolve) => {
    router.handle(fakeReq(url, "no"), fakeRes(resolve), () => resolve({ status: 404, text: "unhandled", json: undefined }));
  });
}

/** As on the live host: langMiddleware (index.ts, before the dental gate), then the router. */
function callThroughLangMiddleware(langMiddleware: any, router: any, url: string): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req = fakeReq(url, "no");
    const res = fakeRes(resolve);
    langMiddleware(req, res, () => router.handle(req, res, () => resolve({ status: 404, text: "unhandled", json: undefined })));
  });
}

const unescapeHtml = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&mdash;/g, "—").replace(/&amp;/g, "&");

/** The visible text of an HTML fragment: tags dropped, entities read, whitespace collapsed. */
const textOf = (html: string): string =>
  unescapeHtml(html.replace(/<\/?(span|a|strong|em|code)\b[^>]*>/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

const mainOf = (html: string): string => (html.match(/<main>[\s\S]*?<\/main>/) || [""])[0];

function jsonLdOf(html: string): any[] {
  const out: any[] = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const v = JSON.parse(m[1]!);
    if (Array.isArray(v)) out.push(...v); else out.push(v);
  }
  return out;
}

/** Every string in a JSON value. */
function stringsOf(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(stringsOf);
  if (v && typeof v === "object") return Object.values(v).flatMap(stringsOf);
  return [];
}

/** The HTML from an opening tag at `start` to its matching close (same tag name), for <ul>, <div>, <p>. */
function elementAt(html: string, start: number): string {
  const tag = html.slice(start + 1).match(/^[a-z0-9]+/)?.[0] ?? "";
  const re = new RegExp(`<${tag}\\b|</${tag}>`, "g");
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return "";
}

/** The element that starts with `opening` (the first one), or "". */
const elementStarting = (html: string, opening: string): string => {
  const at = html.indexOf(opening);
  return at < 0 ? "" : elementAt(html, at);
};

/** From the heading with this text to the next heading of the same or a higher level (h2/h3), exclusive. */
function sectionAfter(html: string, headingText: string): string {
  const m = html.match(new RegExp(`<h([23])[^>]*>${headingText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</h\\1>`));
  if (!m || m.index === undefined) return "";
  const rest = html.slice(m.index + m[0].length);
  const end = rest.search(m[1] === "2" ? /<h2[ >]/ : /<h[23][ >]/);
  return end < 0 ? rest : rest.slice(0, end);
}

// The texts before F1-S4e (main b30ee3d2), for N.
const OLD = {
  sokLabel: "Akuttvakt",
  banner: "Se klinikker med akuttvakt-tilbud",
  faqAnswer: "Søk etter klinikker med Akuttvakt-merke på Finn-tannlege.com. Mange kommuner har kommunal tannlegevakt — ring klinikken for informasjon om åpningstider.",
  badgeItem: "Akuttvakt Klinikken tilbyr akuttbehandling utenom ordinær arbeidstid. Ring alltid for å bekrefte åpningstider.",
  akuttSection: "Tilbudet om kommunal tannlegevakt varierer mye fra kommune til kommune, og åpningstidene er som regel begrenset til kvelder og helger. Det beste rådet er å søke på klinikker med Akuttvakt-merke og ringe direkte. Mange klinikker setter av tid til akuttpasienter på kort varsel i ordinær åpningstid.",
  provNb: "Akuttvakt vises bare når kilden til opplysningen er lagret sammen med feltet. Uten en slik kilde viser vi «Tar imot akuttpasienter» når uttrekket fra klinikkens nettside nevner akutt, og ellers ingen akuttopplysning. Ring alltid klinikken først.",
  provEnHeading: "Helfo, emergency duty and specialties",
  provEn: "Emergency duty (the \"Akuttvakt\" badge) is shown only when the source of the detail is stored with the field. Without such a source we show \"Tar imot akuttpasienter\" (accepts emergency patients) when the extraction from the clinic's website mentions emergencies, and otherwise no emergency detail. Always call the clinic first.",
  pluginHuman: "Finn og sammenlign tannlegeklinikker i Norge — Helfo-avtale, spesialitet og akuttvakt.",
  pluginModel: "Provides access to clinics with filters for county (fylke), specialty, Helfo direct-billing agreement and emergency-duty (akuttvakt).",
  guideInfoNb: "Akuttvakt vises bare når den har en kilde.",
  guideInfoEn: "Emergency duty is shown only when it has a recorded source.",
  guideStatsNb: "Antall tannlegeklinikker i Norge: totalt, per fylke, og hvor mange som har Helfo-direkteoppgjør, hører til en kjede, viser et akuttilbud eller har en spesialist.",
  guideStatsEn: "Counts of dental clinics in Norway: the total, per county (fylke), and how many have Helfo direct billing, belong to a chain, show emergency care or list a specialist.",
  guideAkuttNb: "Finner akutt tannlege: klinikker med akuttvakt som har en kilde, eller som sier at de tar imot akuttpasienter, eventuelt i ett fylke (fylke).",
  guideAkuttEn: "Finds an emergency dentist: clinics with an emergency duty that has a recorded source, or that say they take emergency patients, optionally in one county (fylke).",
  guideAkuttFaqNb: "tannlege_akutt finner klinikker med akuttvakt eller som tar imot akuttpasienter, eventuelt i ett fylke",
  guideAkuttFaqEn: "tannlege_akutt finds clinics with emergency duty or that take emergency patients, optionally in one county",
  cardNb: "A2A-markedsplass for norske tannlegeklinikker med Helfo-avtale-, spesialitet- og akuttvakt-data.",
  cardEn: "A2A marketplace for Norwegian dental clinics with Helfo-agreement, speciality, and emergency-duty data.",
  cardSearch: "`acute_vakt` (1: clinics with an emergency claim, that is a sourced akuttvakt or that they take emergency patients)",
  cardStatsNb: "viser en akuttpåstand (akuttvakt med kilde, eller at klinikken tar imot akuttpasienter)",
};

// The quote, as the extraction stores it once F1-S4d is in (F1-S4c reads it already).
const QUOTED = { acute_vakt: [{ source_type: "homepage", value: "1", quote: "Vi tar imot nye pasienter med akutt tannverk alle kvelder og i helgene." }] };
const STAMP = { acute_vakt: [{ source_type: "homepage", value: "1" }] };

export async function runDentalAkuttTeksterTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string, detail?: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}${detail ? ` — ${detail}` : ""}`); if (log) console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

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
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
  // /sok logs each search; nothing is written here.
  const { analyticsService } = require("../services/analytics-service") as typeof import("../services/analytics-service");
  const realLogWebSearch = analyticsService.logWebSearch;
  (analyticsService as any).logWebSearch = () => {};

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    (require("../services/dental-search-gazetteer") as typeof import("../services/dental-search-gazetteer")).__resetDentalSearchGazetteerForTesting();
    const { ACUTE_ACCEPTS_LABEL, DENTAL_ACUTE_CLAIM_SQL, resolveAcuteClaim } =
      require("../services/dental-acute-claim") as typeof import("../services/dental-acute-claim");
    const { DENTAL_EMERGENCY_NOTICE } = require("../config/dental-landing") as typeof import("../config/dental-landing");
    const { dentalEmergencyNoticeHtml } = require("./dental-landing") as typeof import("./dental-landing");
    const { langMiddleware } = require("../i18n/middleware") as typeof import("../i18n/middleware");

    // ── Fixture: one clinic per akutt claim ──────────────────────────────
    const add = (navn: string, org: string, extra: Record<string, unknown>): string => {
      const id = store.createDentalAgent({ navn, org_nr: org, poststed: "BERGEN", fylke: "Vestland", postnummer: "5003", telefon: "55000000" } as any);
      const cols: Record<string, unknown> = { catalog_class: "klinikk", ...extra };
      const json = (v: unknown) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v);
      db.prepare(`UPDATE dental_agents SET ${Object.keys(cols).map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`)
        .run({ ...Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, json(v)])), id });
      return id;
    };
    add("Sitat Vakt Tannklinikk AS", "918780101", { acute_vakt: 1, field_provenance: QUOTED });
    add("Stempel Akutt Tannklinikk AS", "918780102", { acute_vakt: 1, field_provenance: STAMP });
    add("Fokus Akutt Tannklinikk AS", "918780103", { acute_vakt: 0, patient_focus: ["Akuttpasienter"] });
    add("Flagg Uten Kilde Tannklinikk AS", "918780104", { acute_vakt: 1 });
    add("Vanlig Tannklinikk AS", "918780105", {});
    const rows = db.prepare("SELECT navn, acute_vakt, field_provenance, patient_focus FROM dental_agents").all() as Array<Record<string, any>>;
    const claimOf = (r: Record<string, any>) => resolveAcuteClaim({
      acute_vakt: r.acute_vakt, field_provenance: r.field_provenance ? JSON.parse(r.field_provenance) : null,
      patient_focus: r.patient_focus ? JSON.parse(r.patient_focus) : null,
    });
    assertEq(rows.map((r) => [r.navn, claimOf(r)]), [
      ["Sitat Vakt Tannklinikk AS", "vakt"], ["Stempel Akutt Tannklinikk AS", "accepts"], ["Fokus Akutt Tannklinikk AS", "accepts"],
      ["Flagg Uten Kilde Tannklinikk AS", null], ["Vanlig Tannklinikk AS", null],
    ], "fixture control: one clinic with «Akuttvakt», two with the soft claim, two with none");

    const dentalSeo = require("./dental-seo") as typeof import("./dental-seo");
    const router = dentalSeo.default as any;
    const page = async (url: string) => (await callRoute(router, url)).text;

    // ── S: /sok [1] ──────────────────────────────────────────────────────
    {
      const label = dentalSeo.DENTAL_ACUTE_FILTER_LABEL;
      assertEq(label, "Akutthjelp", "S1: the akutt filter's label is «Akutthjelp» (the spec's recommendation)");
      const plain = await page("/sok");
      const box = (html: string) => (html.match(/<label class="filter-check">\s*<input type="checkbox" name="akutt" value="1"( checked)?> ([^<]*)<\/label>/) || []);
      assertEq([box(plain)[1] ?? "", (box(plain)[2] ?? "").trim()], ["", label], "S2: /sok shows the akutt checkbox (name akutt, value 1) labelled «Akutthjelp», not ticked");
      assertTrue(!/name="akutt" value="1"[^>]*> Akuttvakt\b/.test(plain), "S3: … and not «Akuttvakt», which is one of the two badges the filter covers");
      const akutt = await page("/sok?akutt=1");
      assertEq([box(akutt)[1], (box(akutt)[2] ?? "").trim()], [" checked", label], "S4: /sok?akutt=1 keeps the box ticked");
      const claimNames = rows.filter((r) => claimOf(r) !== null).map((r) => r.navn).sort();
      const shown = rows.map((r) => r.navn as string).filter((n) => akutt.includes(`>${n}<`)).sort();
      const sqlCount = (db.prepare(`SELECT COUNT(*) AS n FROM dental_agents WHERE ${DENTAL_ACUTE_CLAIM_SQL}`).get() as { n: number }).n;
      assertEq([shown, sqlCount, store.countPublicDentalAgents({ acute_vakt: 1 } as any)], [claimNames, 3, 3],
        "S5: /sok?akutt=1 lists the same clinics as before: the three with a claim (Akuttvakt or the soft claim), as DENTAL_ACUTE_CLAIM_SQL and the store count");
      assertTrue(akutt.includes("3 klinikker funnet"), "S6: … and counts them (3)");
    }

    // ── F: the homepage banner [2] ───────────────────────────────────────
    const home = await page("/");
    {
      const banner = elementStarting(home, '<div class="akutt-banner"');
      assertTrue(banner.includes('<a href="/sok?akutt=1">Se klinikker som oppgir akutthjelp</a>'), "F1: the banner links /sok?akutt=1 as «Se klinikker som oppgir akutthjelp»", textOf(banner));
      assertTrue(!/akuttvakt/i.test(banner), "F2: … and names no akuttvakt");
    }

    // ── H: /hvordan-det-fungerer [3, 4, 5] ───────────────────────────────
    const hvordan = await page("/hvordan-det-fungerer");
    const hvordanMain = mainOf(hvordan);
    const merkene = elementAt(hvordanMain, hvordanMain.indexOf("<ul", hvordanMain.indexOf(">Hva betyr merkene?</h3>")));
    const akuttSection = sectionAfter(hvordanMain, "Akutt tannverk");
    {
      const faq = jsonLdOf(hvordan).find((x) => x["@type"] === "FAQPage");
      const q = (faq?.mainEntity ?? []).find((e: any) => e.name === "Hva gjør jeg ved akutt tannverk?");
      assertEq(q?.acceptedAnswer?.text, DENTAL_EMERGENCY_NOTICE.text, "H1: the FAQ JSON-LD answer to «Hva gjør jeg ved akutt tannverk?» is DENTAL_EMERGENCY_NOTICE.text, word for word [3]");
      assertTrue(akuttSection.includes(dentalEmergencyNoticeHtml()), "H2: «Akutt tannverk» shows the emergency notice box (dentalEmergencyNoticeHtml, tel: links) [5]");
      assertTrue(textOf(akuttSection).includes(q?.acceptedAnswer?.text ?? "\u0000"), "H3: … so the visible answer is the JSON-LD answer");
      assertTrue(/href="tel:113"/.test(akuttSection) && /href="tel:116117"/.test(akuttSection), "H4: … with 113 and 116 117 as tel: links");
      assertTrue(textOf(akuttSection).includes("Mange klinikker setter av tid til akuttpasienter på kort varsel i ordinær åpningstid.") &&
        !/Det beste rådet|Akuttvakt/.test(akuttSection), "H5: the sentence on appointments in opening hours stays; «Det beste rådet er å søke på klinikker med Akuttvakt-merke» is gone [5]");
      assertEq((faq?.mainEntity ?? []).length, 4, "H6: the FAQ keeps its four questions");

      const items = [...merkene.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1]!);
      const akuttItems = items.filter((i) => i.includes('class="badge badge-akutt"'));
      const badge = (i: string) => i.match(/<span class="badge badge-akutt" style="margin-right:8px">([^<]*)<\/span>/)?.[1];
      assertEq(akuttItems.map(badge), ["Akuttvakt", ACUTE_ACCEPTS_LABEL], "H7: «Hva betyr merkene?» explains both badges, «Akuttvakt» and «Tar imot akuttpasienter», in the card's badge style [4]");
      const [vakt, accepts] = akuttItems.map(textOf);
      assertEq(vakt, "Akuttvakt Klinikken sier på egne sider at den tar imot nye pasienter for akutt behandling utenom vanlig åpningstid (kveld, helg eller natt), og vi har lagret setningen som sitat. Ring alltid klinikken først.",
        "H8: «Akuttvakt» is definition A (new patients, outside regular opening hours: evening, weekend or night; the sentence stored as a quote) [4]");
      assertEq(accepts, `${ACUTE_ACCEPTS_LABEL} Klinikken nevner akutt behandling på egne sider, uten et lagret sitat om akuttvakt. Ring alltid klinikken først.`,
        "H9: «Tar imot akuttpasienter»: the clinic mentions emergency treatment on its own pages, with no stored quote about a vakt [4]");
      assertTrue(items.length === 4 && items.some((i) => i.includes("badge-verified")) && items.some((i) => i.includes("badge-helfo")), "H10: the Verifisert and Helfo items stay");
      const sok = textOf(hvordanMain.match(/<li[^>]*><strong>Søk<\/strong>[\s\S]*?<\/li>/)?.[0] ?? "");
      assertTrue(sok.endsWith("Du kan filtrere på fylke, spesialitet, Helfo-avtale og akutthjelp."), "H11: step «Søk» names the filter by its /sok label", sok);
    }

    // ── P: /proveniens, nb and en [6] ────────────────────────────────────
    const prov = await page("/proveniens");
    const provMain = mainOf(prov);
    const enAt = provMain.indexOf('<div lang="en">');
    const provNb = provMain.slice(0, enAt);
    const provEn = provMain.slice(enAt);
    {
      const para = (html: string, lead: string) => textOf(html.match(new RegExp(`<p><strong>${lead}</strong>[\\s\\S]*?</p>`))?.[0] ?? "");
      assertEq(para(provNb, "Akuttvakt"),
        "Akuttvakt vises bare med et lagret sitat fra klinikkens egen nettside, der klinikken sier at den tar imot nye pasienter for akutt behandling utenom vanlig åpningstid (kveld, helg eller natt). " +
        `Det holder ikke at kilden til opplysningen er lagret. Uten et slikt sitat viser vi «${ACUTE_ACCEPTS_LABEL}» når uttrekket fra klinikkens nettside nevner akutt, og ellers ingen akuttopplysning. Ring alltid klinikken først.`,
        "P1: nb: «Akuttvakt» needs a stored quote from the clinic's own page, by definition A; a stored source is not enough");
      assertEq(para(provEn, "Emergency duty"),
        "Emergency duty (the \"Akuttvakt\" badge) is shown only with a stored quote from the clinic's own website, in which the clinic says it takes new patients for emergency treatment outside regular opening hours (evening, weekend or night). " +
        `A stored source for the detail is not enough. Without such a quote we show "${ACUTE_ACCEPTS_LABEL}" (accepts emergency patients) when the extraction from the clinic's website mentions emergencies, and otherwise no emergency detail. Always call the clinic first.`,
        "P2: en: the same, following the Norwegian text");
      assertTrue(provNb.includes("<h2>Helfo, akutt og spesialiteter</h2>") && provEn.includes("<h2>Helfo, emergency claims and specialties</h2>"),
        "P3: the headings: «Helfo, akutt og spesialiteter» and «Helfo, emergency claims and specialties»");
      // The text says what the code does (hasAcuteVaktQuote through resolveAcuteClaim).
      assertEq([resolveAcuteClaim({ acute_vakt: 1, field_provenance: QUOTED, patient_focus: null }), resolveAcuteClaim({ acute_vakt: 1, field_provenance: STAMP, patient_focus: null })],
        ["vakt", "accepts"], "P4 control: a stored quote gives «Akuttvakt», a stored source without one the soft claim");
    }

    // ── J: /.well-known/ai-plugin.json [7] ───────────────────────────────
    const plug = await callRoute(router, "/.well-known/ai-plugin.json");
    let plugJson: any = null;
    try { plugJson = JSON.parse(plug.text); } catch { /* J1 */ }
    {
      assertTrue(plug.status === 200 && plugJson !== null && typeof plugJson === "object", "J1: ai-plugin.json is 200 and valid JSON");
      const human = String(plugJson?.description_for_human ?? "");
      const model = String(plugJson?.description_for_model ?? "");
      assertTrue(human.startsWith("Finn og sammenlign tannlegeklinikker i Norge — Helfo-avtale, spesialitet og akutthjelp. "), "J2: description_for_human names «akutthjelp», which covers both badges", human);
      assertTrue(model.includes("Helfo direct-billing agreement and emergency claims (an emergency duty backed by a stored quote from the source, or that the clinic says it takes emergency patients). Read-only:"),
        "J3: description_for_model names the emergency claim: a duty only with a stored quote, or that the clinic takes emergency patients", model);
    }

    // ── G: the tool cards on /guide-tannlege-ai [8] ──────────────────────
    const guide = {
      nb: await callRoute(router, "/guide-tannlege-ai"),
      en: await callThroughLangMiddleware(langMiddleware, router, "/en/guide-tannlege-ai"),
    };
    const cardsOf = (html: string) => new Map([...html.matchAll(/<div class="gta-tool"><code>([^<]*)<\/code><p>([\s\S]*?)<\/p><\/div>/g)].map((m) => [m[1]!, textOf(m[2]!)]));
    const faqOf = (lang: "nb" | "en") => new Map(dentalSeo.dentalMcpGuideTools(lang).map((t) => [t.name, t.faq]));
    {
      const nb = cardsOf(guide.nb.text);
      const en = cardsOf(guide.en.text);
      assertEq([guide.nb.status, guide.en.status, nb.size, en.size], [200, 200, 5, 5], "G0: both guide pages are 200 with five tool cards");
      assertTrue((nb.get("tannlege_info") ?? "").includes(`Helfo-status, akuttpåstand, spesialiteter`) &&
        (nb.get("tannlege_info") ?? "").endsWith(`Akuttpåstanden er «Akuttvakt» bare når akuttvakten har et lagret sitat fra kilden, og «${ACUTE_ACCEPTS_LABEL}» når klinikken sier at den tar imot akuttpasienter.`),
        "G1 nb: tannlege_info returns the akuttpåstand, «Akuttvakt» only with a stored quote (the tool text of G3-S6d)", nb.get("tannlege_info"));
      assertTrue((en.get("tannlege_info") ?? "").includes("Helfo status, emergency claim, specialties") &&
        (en.get("tannlege_info") ?? "").endsWith(`The emergency claim is «Akuttvakt» only when an emergency duty has a stored quote from the source, and «${ACUTE_ACCEPTS_LABEL}» when the clinic says it takes emergency patients.`),
        "G1 en: tannlege_info returns the emergency claim, with the same rule", en.get("tannlege_info"));
      assertTrue((nb.get("tannlege_stats") ?? "").includes("viser en akuttpåstand eller har en spesialist.") &&
        (nb.get("tannlege_stats") ?? "").endsWith(`En akuttpåstand er «Akuttvakt», som krever et lagret sitat fra kilden, eller «${ACUTE_ACCEPTS_LABEL}», at klinikken sier at den tar imot akuttpasienter.`),
        "G2 nb: tannlege_stats counts the akuttpåstand and says what it is", nb.get("tannlege_stats"));
      assertTrue((en.get("tannlege_stats") ?? "").includes("show an emergency claim or list a specialist.") &&
        (en.get("tannlege_stats") ?? "").endsWith(`An emergency claim is «Akuttvakt», an emergency duty backed by a stored quote from the source, or «${ACUTE_ACCEPTS_LABEL}», that the clinic says it takes emergency patients.`),
        "G2 en: tannlege_stats counts the emergency claim and says what it is (the tool's own sentence)", en.get("tannlege_stats"));
      assertTrue((nb.get("tannlege_akutt") ?? "").startsWith("Finner akutt tannlege: klinikker som sier at de tar imot akuttpasienter, eventuelt i ett fylke (fylke).") &&
        (nb.get("tannlege_akutt") ?? "").includes(`Akuttpåstanden er «Akuttvakt» bare når akuttvakten har et lagret sitat fra kilden, og ellers «${ACUTE_ACCEPTS_LABEL}».`),
        "G3 nb: tannlege_akutt finds clinics that say they take emergency patients, «Akuttvakt» only with a stored quote", nb.get("tannlege_akutt"));
      assertTrue((en.get("tannlege_akutt") ?? "").startsWith("Finds an emergency dentist: clinics that say they take emergency patients, optionally in one county (fylke).") &&
        (en.get("tannlege_akutt") ?? "").includes(`The emergency claim is «Akuttvakt» only when an emergency duty has a stored quote from the source, and otherwise «${ACUTE_ACCEPTS_LABEL}».`),
        "G3 en: the same, as the tool's first sentence (G3-S6d)", en.get("tannlege_akutt"));
      assertTrue(/<span lang="nb">Akuttvakt<\/span>/.test(guide.en.text) && guide.en.text.includes(`<span lang="nb">${ACUTE_ACCEPTS_LABEL}</span>`),
        "G4 en: the Norwegian badge names are marked lang=\"nb\" on the English page");
      assertEq([faqOf("nb").get("tannlege_stats"), faqOf("nb").get("tannlege_akutt"), faqOf("en").get("tannlege_stats"), faqOf("en").get("tannlege_akutt")], [
        "tannlege_stats teller klinikkene totalt og per fylke, og hvor mange som har Helfo-avtale, akuttpåstand eller spesialist",
        "tannlege_akutt finner klinikker som sier at de tar imot akuttpasienter, eventuelt i ett fylke",
        "tannlege_stats counts the clinics in total and per county, and how many have a Helfo agreement, an emergency claim or a specialist",
        "tannlege_akutt finds clinics that say they take emergency patients, optionally in one county",
      ], "G5: the tools FAQ answers say the same");
    }

    // ── A: the A2A agent card [9] ────────────────────────────────────────
    const { getDentalAgentCard } = require("../services/dental-agent-card") as typeof import("../services/dental-agent-card");
    const card = getDentalAgentCard() as { description: string; skills: Array<{ id: string; description: string; examples: string[] }> };
    const skill = (id: string) => card.skills.find((s) => s.id === id)?.description ?? "";
    {
      assertEq(card.description,
        "A2A-markedsplass for norske tannlegeklinikker med Helfo-avtale-, spesialitet- og akutthjelp-data. A2A marketplace for Norwegian dental clinics with Helfo-agreement, speciality, and emergency-claim data.",
        "A1: the card's description names the akutt data by a word that covers both badges, nb and en");
      assertTrue(skill("tannlege_search").includes("`acute_vakt` (1: clinics with an emergency claim, that is an akuttvakt with a stored quote from the source or that they take emergency patients)"),
        "A2: the search skill's `acute_vakt`: an akuttvakt only with a stored quote, or that the clinic takes emergency patients");
      assertTrue(skill("tannlege_stats").includes("viser en akuttpåstand (akuttvakt med lagret sitat fra kilden, eller at klinikken tar imot akuttpasienter)") &&
        skill("tannlege_stats").includes("show an emergency claim (an akuttvakt with a stored quote from the source, or that the clinic takes emergency patients)"),
        "A3: the stats skill, nb and en, the same");
      assertTrue(card.skills.find((s) => s.id === "tannlege_search")?.examples.includes("akuttvakt tannlege Stavanger") === true,
        "A4 control: the search example «akuttvakt tannlege Stavanger» is a search word and stays (the lock leaves examples out)");
    }

    // ── L: the lock [11] ─────────────────────────────────────────────────
    // The field list (/hvordan-det-fungerer «For klinikker») and the method
    // table (/proveniens) come from DENTAL_DATA_SOURCES; their «akuttvakt» /
    // «emergency duty» names the stored field, not the badge.
    const withoutDataSources = (html: string): string => html
      .replace(/<div class="method-table-wrap"[\s\S]*?<\/table>\s*<\/div>/g, "")
      .replace(/(henter klinikkdata fra disse kildene:<\/p>\s*)<ul>[\s\S]*?<\/ul>/, "$1");
    const surfaces: Array<[string, string]> = [
      ["/hvordan-det-fungerer (main)", textOf(withoutDataSources(hvordanMain))],
      ...jsonLdOf(hvordan).flatMap(stringsOf).map((s, i): [string, string] => [`/hvordan-det-fungerer JSON-LD #${i}`, s]),
      ["/proveniens (main)", textOf(withoutDataSources(provMain))],
      ...jsonLdOf(prov).flatMap(stringsOf).map((s, i): [string, string] => [`/proveniens JSON-LD #${i}`, s]),
      ["ai-plugin description_for_human", String(plugJson?.description_for_human ?? "")],
      ["ai-plugin description_for_model", String(plugJson?.description_for_model ?? "")],
      ["/guide-tannlege-ai (main)", textOf(mainOf(guide.nb.text))],
      ["/en/guide-tannlege-ai (main)", textOf(mainOf(guide.en.text))],
      ...jsonLdOf(guide.nb.text).concat(jsonLdOf(guide.en.text)).flatMap(stringsOf).map((s, i): [string, string] => [`/guide-tannlege-ai JSON-LD #${i}`, s]),
      ["agent card description", card.description],
      ...card.skills.map((s): [string, string] => [`agent card skill ${s.id}`, s.description]),
    ];
    {
      assertEq(surfaces.flatMap(([where, text]) => emergencyDutyWithoutQuote(text).map((s) => `${where}: ${s}`)), [],
        "L1: no surface of points 3–9 names «Akuttvakt» / an emergency duty without the quote rule");
      const names = (where: string) => surfaces.filter(([w]) => w.startsWith(where)).some(([, t]) => /\bakuttvakt|\bemergency[- ]duty\b/i.test(t));
      assertEq(["/hvordan-det-fungerer (main)", "/proveniens (main)", "ai-plugin description_for_model", "/guide-tannlege-ai (main)", "/en/guide-tannlege-ai (main)", "agent card skill"].filter((w) => !names(w)), [],
        "L2: the lock is not vacuous: each of these still names the duty, with the rule");
      assertTrue(surfaces.every(([, t]) => t.length > 0) && surfaces.length > 10, `L3 control: every surface was read (${surfaces.length})`);
    }

    // ── Z: no page says «Akuttvakt-merke» or «akuttvakt-tilbud», and no new phone number ──
    {
      const sted = await callRoute(router, "/sted/bergen");
      const fylke = await callRoute(router, "/fylke/Vestland");
      const profile = await callRoute(router, `/klinikk/${dentalSeo.slugifyClinic("Sitat Vakt Tannklinikk AS", "918780101")}`);
      assertEq([sted.status, fylke.status, profile.status], [200, 200, 200], "Z0 control: /sted/bergen, /fylke/Vestland and a profile answer 200");
      const docs: Array<[string, string]> = [
        ["/", home], ["/sok", await page("/sok")], ["/sok?akutt=1", await page("/sok?akutt=1")], ["/hvordan-det-fungerer", hvordan],
        ["/proveniens", prov], ["/om", await page("/om")], ["/guide-tannlege-ai", guide.nb.text], ["/en/guide-tannlege-ai", guide.en.text],
        ["/sted/bergen", sted.text], ["/fylke/Vestland", fylke.text], ["profile", profile.text],
        ["ai-plugin.json", plug.text], ["agent card", JSON.stringify(card)],
      ];
      assertEq(docs.filter(([, t]) => /Akuttvakt-merke|akuttvakt-tilbud/i.test(t)).map(([p]) => p), [], "Z1: no public page or document says «Akuttvakt-merke» or «akuttvakt-tilbud»");
      // Built from parts, so the number appears nowhere in the code either (the spec: it must not occur).
      const directoryEnquiries = ["18", "81"].join("");
      assertEq(docs.filter(([, t]) => t.includes(directoryEnquiries)).map(([p]) => p), [], "Z2: the directory-enquiry number is on no page");
      assertTrue(profile.text.includes('<span class="badge badge-akutt">Akuttvakt</span>'), "Z3 control: the profile with a stored quote still shows «Akuttvakt» (F1-S4c, unchanged)");
      // The akutt texts give the notice's numbers and no other.
      const numbers = (t: string) => [...t.matchAll(/\d[\d ]*\d|\d/g)].map((m) => m[0].trim());
      const allowed = DENTAL_EMERGENCY_NOTICE.phones.map((p) => p.number);
      const akuttItems = [...merkene.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1]!).filter((i) => i.includes("badge-akutt")).map(textOf);
      const akuttTexts = [...akuttItems, textOf(akuttSection), textOf(provNb.match(/<p><strong>Akuttvakt<\/strong>[\s\S]*?<\/p>/)?.[0] ?? ""),
        textOf(provEn.match(/<p><strong>Emergency duty<\/strong>[\s\S]*?<\/p>/)?.[0] ?? ""), String(plugJson?.description_for_human ?? "").split(" Finn-tannlege.com er")[0]!,
        ...[...cardsOf(guide.nb.text).values(), ...cardsOf(guide.en.text).values()]];
      assertEq([akuttItems.length, [...new Set(akuttTexts.flatMap(numbers))].filter((n) => !allowed.includes(n))], [2, []],
        "Z4: the akutt texts (badges, «Akutt tannverk», /proveniens, ai-plugin, the tool cards) give no number beyond 113 and 116 117");
      assertEq(numbers(textOf(akuttSection)), allowed, "Z5: «Akutt tannverk» gives exactly 113 and 116 117, from the notice");
    }

    // ── N: the texts before F1-S4e fail the checks ───────────────────────
    {
      const dutyTexts = [OLD.banner, OLD.faqAnswer, OLD.badgeItem, OLD.akuttSection, OLD.provNb, OLD.provEnHeading, OLD.provEn, OLD.pluginHuman, OLD.pluginModel,
        OLD.guideInfoNb, OLD.guideInfoEn, OLD.guideAkuttNb, OLD.guideAkuttEn, OLD.guideAkuttFaqNb, OLD.guideAkuttFaqEn, OLD.cardNb, OLD.cardEn, OLD.cardSearch, OLD.cardStatsNb];
      assertEq(dutyTexts.filter((t) => emergencyDutyWithoutQuote(t).length === 0), [], "N1: the lock (L1) flags every text before F1-S4e that named the duty");
      assertTrue(OLD.faqAnswer !== DENTAL_EMERGENCY_NOTICE.text && !OLD.akuttSection.includes(DENTAL_EMERGENCY_NOTICE.text), "N2: the old FAQ answer and «Akutt tannverk» fail H1 and H3");
      assertTrue(OLD.sokLabel !== dentalSeo.DENTAL_ACUTE_FILTER_LABEL && !/akuttpåstand/.test(OLD.guideStatsNb) && !/emergency claim/.test(OLD.guideStatsEn),
        "N3: the old /sok label fails S1, and the old stats cards fail G2 (no akuttpåstand / emergency claim)");
      assertTrue(/Akuttvakt-merke|akuttvakt-tilbud/i.test(OLD.banner + OLD.faqAnswer + OLD.akuttSection), "N4: the old banner, FAQ answer and section fail Z1");
      assertEq(emergencyDutyWithoutQuote("Akuttvakt Klinikken tar imot nye pasienter for akutt behandling utenom vanlig åpningstid. Vi har lagret setningen som sitat."),
        ["Akuttvakt Klinikken tar imot nye pasienter for akutt behandling utenom vanlig åpningstid."],
        "N5: the quote rule counts only in the sentence that names the badge");
    }
  } catch (err: any) {
    failed++;
    failures.push("dental akutt-tekster: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    (analyticsService as any).logWebSearch = realLogWebSearch;
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    if (prevParserOff === undefined) delete process.env.DENTAL_QUERY_PARSER_DISABLED;
    else process.env.DENTAL_QUERY_PARSER_DISABLED = prevParserOff;
    try {
      (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    restoreModuleCache();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runDentalAkuttTeksterTests({ log: true }).then((r) => {
    console.log(`\ndental akutt-tekster: ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
