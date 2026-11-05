/**
 * rfb-selger-en-butikk.test.ts — dev-request 2026-10-22-rfb-utsending-v4,
 * skive 1 (endring 7, AC5): /selger?agent=<id> viser bare den ene butikken
 * når produsenten ikke er tatt over.
 *
 * Kjører selger.html sitt eget inline-script i node:vm (tests/helpers/fake-page.ts),
 * matet med svar i samme form som GET /api/marketplace/agents/:id/info.
 *   (a) ikke overtatt: én butikk, vasket navn, sted, «Dette er min butikk»,
 *       søkefelt og trefliste skjult, knappen starter claim-flyten
 *   (b) uten agent=: ingen /info-kall, siden som før
 *   (c) ukjent agent (404) og id uten navn: siden som før
 *   (d) overtatt (isClaimed) eller verifisert: siden som før
 *   (e) navnevask, både TS-hjelperen og den inline kopien
 *
 * Exported runRfbSelgerEnButikkTests({log}) -> TestSummary; koblet inn i tests/test.ts.
 * Standalone: npx tsx src/routes/rfb-selger-en-butikk.test.ts
 */

import * as fs from "fs";
import * as path from "path";
import { inlineScript } from "../../tests/helpers/html-injection";
import { jsonResponse, settle, runPage, type FetchStub } from "../../tests/helpers/fake-page";
import { washStoreName } from "../utils/rfb-store-name";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runRfbSelgerEnButikkTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const eq = (actual: unknown, expected: unknown, label: string): void => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    }
  };

  const script = inlineScript("selger.html", "function escHtml");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "selger.html"), "utf8");
  const ID = "11111111-2222-3333-4444-555555555555";
  const info = (agent: Record<string, unknown>) => ({ success: true, data: { agent: { id: ID, ...agent }, knowledge: {} } });

  async function open(search: string, reply: (id: string) => ReturnType<typeof jsonResponse>) {
    const urls: string[] = [];
    const stub: FetchStub = async (url) => {
      urls.push(url);
      const m = url.match(/\/agents\/([^/]+)\/info$/);
      return m ? reply(decodeURIComponent(m[1]!)) : jsonResponse({ success: false }, 404);
    };
    const page = runPage(script, stub, { pathname: "/selger", search });
    await settle();
    return { page, urls, infoCalls: urls.filter((u) => u.endsWith("/info")) };
  }
  const hiddenOf = (page: any, id: string) => page.el(id).style.display === "none";

  // (a) ikke overtatt
  {
    const { page, infoCalls } = await open(`?agent=${ID}`, () =>
      jsonResponse(info({ name: "Strandkaien Fisk — Bergen AS", city: "Bergen", isClaimed: false, isVerified: false })));
    eq(infoCalls.length, 1, "a: ett /info-kall for agent=");
    eq(page.el("singleStoreName").textContent, "Strandkaien Fisk", "a: vasket navn vises");
    eq(page.el("singleStoreCity").textContent, "Bergen", "a: sted vises");
    eq(page.el("singleStore").style.display, "", "a: én-butikk-visningen er synlig");
    eq([hiddenOf(page, "findDefault"), hiddenOf(page, "findResults")], [true, true], "a: søkefelt og trefliste er skjult");
    eq(page.el("findAlert").innerHTML, "", "a: ingen «Henter butikken»-melding blir stående");
    ok2(/id="btnSingleStoreClaim"[^>]*>Dette er min butikk</.test(html), "a: knappen heter «Dette er min butikk»");
    // K2 (2026-11-01-rfb-kravflyt-tal-eiere-fra-e-post): the store block now stands before the
    // registration hero, so it ends where the hero starts.
    ok2(/<h2[^>]*>Ta over siden til butikken din<\/h2>/.test(html) && !/Registrer/.test(html.slice(html.indexOf('id="singleStore"'), html.indexOf('class="claim-hero"'))),
      "a: overskriften sier ta over siden, ikke registrer");
    // knappen starter den eksisterende claim-flyten (kode på e-post)
    page.el("btnSingleStoreClaim").click();
    eq(page.el("claimAgentName").textContent, "Strandkaien Fisk", "a: knappen åpner claim-steget med butikkens navn");
    eq(page.context.claimAgentId, ID, "a: claim-steget bruker produsentens id");
  }
  function ok2(c: boolean, label: string) { eq(!!c, true, label); }

  // (b) uten agent=
  {
    const { page, infoCalls } = await open("", () => jsonResponse(info({ name: "X", isClaimed: false })));
    eq(infoCalls.length, 0, "b: uten agent= ingen /info-kall");
    eq(page.el("singleStore").style.display, undefined, "b: én-butikk-visningen aldri rørt (markup skjuler den)");
    eq([page.el("findDefault").style.display, page.el("findResults").style.display], [undefined, undefined], "b: søkefelt og trefliste urørt");
    eq(page.el("singleStoreName").textContent, "", "b: ingen butikk fylt inn");
  }

  // (c) ukjent agent
  for (const [label, reply] of [
    ["404", () => jsonResponse({ success: false }, 404)],
    ["uten navn", () => jsonResponse({ success: true, data: { agent: {} } })],
    ["uten id", () => jsonResponse({ success: true, data: { agent: { name: "Navn", isClaimed: false } } })],
  ] as const) {
    const { page } = await open(`?agent=${ID}`, reply);
    eq([page.el("findDefault").style.display, page.el("findResults").style.display, page.el("singleStoreName").textContent],
      [undefined, undefined, ""], `c: ukjent agent (${label}) gir siden som før`);
    if (label !== "uten id") eq(page.el("findAlert").innerHTML, "", `c: ukjent agent (${label}) rydder «Henter»-meldingen`);
  }

  // (d) overtatt / verifisert
  for (const flags of [{ isClaimed: true, isVerified: false }, { isClaimed: false, isVerified: true }]) {
    const { page } = await open(`?agent=${ID}`, () => jsonResponse(info({ name: "Gården AS", city: "Voss", ...flags })));
    eq([page.el("findDefault").style.display, page.el("findResults").style.display, page.el("singleStoreName").textContent],
      [undefined, undefined, ""], `d: ${JSON.stringify(flags)} gir siden som før`);
    eq(page.el("findName").value, "Gården AS", `d: ${JSON.stringify(flags)} fyller søkefeltet som i dag`);
  }

  // (e) navnevask
  const cases: Array<[string, string]> = [
    ["Strandkaien Fisk — Bergen", "Strandkaien Fisk"],
    ["Ola Gård, Voss", "Ola Gård"],
    ["Fjordmat AS", "Fjordmat"],
    ["Bakeriet SA", "Bakeriet"],
    ["Honning og Co DA", "Honning og Co"],
    ["Aker Gård ANS", "Aker Gård"],
    ["Hagen ENK", "Hagen"],
    ["Fisk — Bergen, Norge AS", "Fisk"],
    ["Grønn Gård, Oslo — Nord", "Grønn Gård"],
    ["Fjordmat AS — Oslo", "Fjordmat"],
    ["Basen", "Basen"],
    ["ASKER", "ASKER"],
  ];
  const inline = runPage(script, async () => jsonResponse({}, 404), { pathname: "/selger" }).context.washStoreName as (s: string) => string;
  for (const [raw, want] of cases) {
    eq(washStoreName(raw), want, `e: washStoreName(${JSON.stringify(raw)})`);
    eq(inline(raw), want, `e: inline kopi i selger.html gir det samme for ${JSON.stringify(raw)}`);
  }
  eq(washStoreName(null), "", "e: null gir tom streng");

  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbSelgerEnButikkTests({ log: true }).then((s) => {
    console.log(`${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0);
  });
}
