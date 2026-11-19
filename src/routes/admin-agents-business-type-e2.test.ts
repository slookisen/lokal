/**
 * admin-agents-business-type-e2.test.ts — dev-request
 * 2026-11-15-rfb-butikkregel-fisk-og-kjott, slice E2: the READ-ONLY
 * classification dry-run (GET /admin/agents/business-type/classification-dryrun)
 * suggests retail_focus (fisk / kjott / frukt_gront / annet), a Norwegian
 * `reason`, knows national chain names, has scope=all, and returns `counts`.
 *
 * Covers: fish-shop name -> retail_shop/fisk; butcher -> retail_shop/kjott;
 * generic "butikk" -> annet; chain name -> annet + chain signal; farm-shop hint
 * lowers confidence; focus-only profiles get a modest confidence; a plain farm
 * is not a candidate; scope=all includes an agent with an outreach_sent_log row
 * while scope=uncontacted excludes it; counts; and the endpoint writes nothing.
 *
 * All names are fictitious. Own in-memory DB; swaps ADMIN_KEY (restored).
 * Exported runAdminAgentsBusinessTypeE2Tests({log}) -> TestSummary, wired into
 * tests/test.ts. Standalone:
 *   npx tsx src/routes/admin-agents-business-type-e2.test.ts
 */

import Database from "better-sqlite3";
import { getDb, __setDbForTesting, __initSchemaForTesting } from "../database/init";
import businessTypeRouter, { __setBusinessTypeDbForTesting, classifyRetailSignals } from "./admin-agents-business-type";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(router: any, opts: { method: string; url: string; headers?: Record<string, string>; query?: Record<string, string> }): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = { method: opts.method, url: opts.url, originalUrl: opts.url, query: opts.query || {}, headers, body: undefined, ip: "127.0.0.1", get: (n: string) => headers[n.toLowerCase()] };
    const res: any = {
      statusCode: 200,
      status(c: number) { this.statusCode = c; return this; },
      json(p: any) { resolve({ status: this.statusCode, body: p }); return this; },
      end() { resolve({ status: this.statusCode, body: undefined }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 0, body: err ? { error: String(err) } : undefined }));
  });
}

export async function runAdminAgentsBusinessTypeE2Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`); }
  }
  function assertTrue(c: boolean, label: string): void { assertEq(!!c, true, label); }

  // ── Pure classifier ──
  const fish = classifyRetailSignals({ name: "Bryggens Fiskebutikk", about: "Fersk fisk hver dag." });
  assertEq([fish.suggested_business_type, fish.suggested_retail_focus], ["retail_shop", "fisk"], "e2-01: fiskebutikk i navn -> retail_shop/fisk");
  assertTrue(fish.signals.includes("name:fiskebutikk"), "e2-01b: signal name:fiskebutikk");
  assertTrue(typeof fish.reason === "string" && fish.reason.includes("fiskebutikk"), "e2-01c: reason nevner signalet");

  const meat = classifyRetailSignals({ name: "Nordby Slakter", about: "Vi selger lam og storfe." });
  assertEq([meat.suggested_business_type, meat.suggested_retail_focus], ["retail_shop", "kjott"], "e2-02: slakter i navn -> retail_shop/kjott");
  const meat2 = classifyRetailSignals({ name: "Testesen Kjøttprodukter", about: null });
  assertEq(meat2.suggested_retail_focus, "kjott", "e2-02b: kjøttprodukter -> kjott");
  const shell = classifyRetailSignals({ name: "Kystby Skalldyr", about: "" });
  assertEq(shell.suggested_retail_focus, "fisk", "e2-02c: skalldyr -> fisk");
  const bare = classifyRetailSignals({ name: "Fjordfisk", about: "" });
  assertEq([bare.suggested_business_type, bare.suggested_retail_focus], ["retail_shop", "fisk"], "e2-02d: navn som slutter på «fisk» -> fisk");
  const fg = classifyRetailSignals({ name: "Torget Frukt & Grønt", about: "" });
  assertEq(fg.suggested_retail_focus, "frukt_gront", "e2-02e: frukt & grønt -> frukt_gront");

  const generic = classifyRetailSignals({ name: "Hjørnets Butikk", about: "" });
  assertEq([generic.suggested_business_type, generic.suggested_retail_focus], ["retail_shop", "annet"], "e2-03: generisk butikk -> annet");

  const chain = classifyRetailSignals({ name: "Kiwi Storgata", about: "" });
  assertEq([chain.suggested_business_type, chain.suggested_retail_focus], ["retail_shop", "annet"], "e2-04: kjedenavn -> retail_shop/annet");
  assertTrue(chain.signals.includes("chain:kiwi"), "e2-04b: signal chain:kiwi");
  const chainInAbout = classifyRetailSignals({ name: "Haugen Gård", about: "Eggene våre selges på Rema 1000 og Coop." });
  assertEq(chainInAbout.signals.length, 0, "e2-04c: kjedenavn i om-tekst er ikke et signal");
  const notChain = classifyRetailSignals({ name: "Sparebakken Gård", about: "" });
  assertTrue(!notChain.signals.some((s) => s.startsWith("chain:")), "e2-04d: «spar» inne i et ord er ikke kjede");

  const farmMeat = classifyRetailSignals({ name: "Li Gård Kjøttbutikk", about: "Gårdsbutikk med eget kjøtt." });
  const shopMeat = classifyRetailSignals({ name: "Li Kjøttbutikk", about: "Kjøttbutikk med eget kjøtt." });
  assertTrue(farmMeat.farm_shop_hint && farmMeat.confidence < shopMeat.confidence, "e2-05: gårdsbutikk-hint senker sikkerheten");
  assertTrue(farmMeat.reason.includes("gårdsbutikk"), "e2-05b: reason nevner gårdsbutikk-hint");

  assertTrue(shell.confidence <= 0.4 && shell.confidence > 0, "e2-06: bare fisk/kjøtt-ord gir moderat sikkerhet");
  assertTrue(shell.reason.includes("kan være produsent"), "e2-06b: reason sier at det kan være produsent");
  assertTrue(chain.confidence > shell.confidence, "e2-06c: kjede har høyere sikkerhet enn bare fisk-ord");

  // B1: a focus-only profile that would score 0.9 uncapped stays at <= 0.4.
  const capped = classifyRetailSignals({ name: "Vik Fiskehandel Sjømat", about: "fiskehandel og sjømat" });
  assertEq([capped.suggested_business_type, capped.suggested_retail_focus], ["retail_shop", "fisk"], "e2-06d: fiskehandel+sjømat -> retail_shop/fisk");
  assertTrue(capped.confidence <= 0.4 && capped.confidence > 0, "e2-06e: taket for bare fokus-ord holder (<= 0.4) selv med mange treff");

  // N1: tie between two focuses -> annet, "blandet fokus".
  const tie = classifyRetailSignals({ name: "Fisk og Kjøtt", about: "" });
  assertEq([tie.suggested_business_type, tie.suggested_retail_focus], ["retail_shop", "annet"], "e2-06f: likt fisk/kjøtt -> annet");
  assertTrue(tie.reason.includes("blandet fokus"), "e2-06g: reason sier blandet fokus");

  // N2: a digit may end a chain word; a letter may not.
  const rema = classifyRetailSignals({ name: "Rema1000 Moa", about: "" });
  assertTrue(rema.signals.includes("chain:rema") && rema.suggested_retail_focus === "annet", "e2-04e: «Rema1000» gir chain:rema");
  const notChain2 = classifyRetailSignals({ name: "Obsidian Sparebank", about: "" });
  assertTrue(!notChain2.signals.some((s) => s.startsWith("chain:")), "e2-04f: «Obsidian»/«Sparebank» er ikke kjede");

  // N3: frukt-og-grønt with hyphens on both sides.
  const fgHyph = classifyRetailSignals({ name: "Bondens Frukt-og-grønt", about: "" });
  assertEq(fgHyph.suggested_retail_focus, "frukt_gront", "e2-02f: «Frukt-og-grønt» -> frukt_gront");

  const farm = classifyRetailSignals({ name: "Nedre Bakke Gård", about: "Vi dyrker poteter og gulrøtter." });
  assertEq([farm.signals.length, farm.suggested_business_type, farm.suggested_retail_focus], [0, null, null], "e2-07: vanlig gård har ingen signaler");

  const cafe = classifyRetailSignals({ name: "Bakgårdens Kafé", about: "" });
  assertEq([cafe.suggested_business_type, cafe.suggested_retail_focus], ["cafe", null], "e2-08: kafé -> cafe, ingen retail_focus");

  // ── Route ──
  const prevDb = getDb();
  const db = new Database(":memory:");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);
  __setBusinessTypeDbForTesting(db as any);
  const prevKey = process.env.ADMIN_KEY;
  const ambient = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  const key = ambient || "e2-test-key";
  if (!ambient) process.env.ADMIN_KEY = key;

  try {
    function add(id: string, name: string, about: string): void {
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
                  VALUES (?, ?, 'test', 'test', ?, ?, 'producer', ?)`)
        .run(id, name, `${id}@e2-test.no`, `https://${id}.e2-test.no`, `key-${id}`);
      db.prepare(`INSERT INTO agent_knowledge (agent_id, email, about) VALUES (?, ?, ?)`).run(id, `${id}@e2-test.no`, about);
    }
    add("e2-fish", "Havnas Fiskehandel", "Fersk fisk fra båtene.");
    add("e2-meat", "Sentrum Kjøttbutikk", "Lam og storfe.");
    add("e2-generic", "Bygdas Butikk", "Alt du trenger.");
    add("e2-chain", "Joker Vestbyen", "");
    add("e2-farm", "Øvre Li Gård", "Vi dyrker korn.");
    add("e2-sent", "Kaias Sjømat", "Fersk sjømat."); // has an RFB outreach row
    // B2: a non-RFB agent with shop words must stay out of scope=all.
    add("e2-dental", "Tannklinikkens Butikk", "Butikk og dagligvare.");
    db.prepare(`UPDATE agents SET vertical_id = 'dental' WHERE id = 'e2-dental'`).run();
    db.prepare(`INSERT INTO outreach_sent_log (agent_id, channel, notes, vertical_id) VALUES ('e2-sent', 'email', 'e2-test', 'rfb')`).run();

    const H = { "x-admin-key": key };
    const snap = () => JSON.stringify(db.prepare(`SELECT id, business_type, retail_focus FROM agents ORDER BY id`).all());
    const before = snap();
    const changesBefore = (db.prepare(`SELECT total_changes() AS c`).get() as any).c;

    const all = await callRoute(businessTypeRouter, { method: "GET", url: "/classification-dryrun", headers: H, query: { scope: "all" } });
    const unc = await callRoute(businessTypeRouter, { method: "GET", url: "/classification-dryrun", headers: H, query: {} });
    assertEq([all.status, all.body?.scope, all.body?.read_only], [200, "all", true], "e2-10: scope=all svarer read_only");
    assertEq(unc.body?.scope, "uncontacted", "e2-11: uncontacted er fortsatt standard");
    const allIds = (all.body?.candidates ?? []).map((c: any) => c.agent_id);
    const uncIds = (unc.body?.candidates ?? []).map((c: any) => c.agent_id);
    assertTrue(allIds.includes("e2-sent"), "e2-12: scope=all tar med agent med outreach_sent_log-rad");
    assertTrue(!uncIds.includes("e2-sent"), "e2-13: scope=uncontacted utelater den");
    assertTrue(!allIds.includes("e2-farm"), "e2-14: vanlig gård er ikke kandidat");
    assertTrue(!allIds.includes("e2-dental"), "e2-14b: scope=all utelater agent fra annen vertikal (dental)");

    const byId: Record<string, any> = {};
    for (const c of all.body?.candidates ?? []) byId[c.agent_id] = c;
    assertEq(byId["e2-fish"]?.suggested_retail_focus, "fisk", "e2-15: rute: fiskehandel -> fisk");
    assertEq(byId["e2-meat"]?.suggested_retail_focus, "kjott", "e2-16: rute: kjøttbutikk -> kjott");
    assertEq(byId["e2-generic"]?.suggested_retail_focus, "annet", "e2-17: rute: butikk -> annet");
    assertTrue((byId["e2-chain"]?.signals ?? []).includes("chain:joker"), "e2-18: rute: kjede-signal");
    assertTrue(typeof byId["e2-fish"]?.reason === "string" && byId["e2-fish"].reason.length > 0, "e2-19: rute: reason er med");

    const sorted = (o: Record<string, number> | undefined) => Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => a.localeCompare(b)));
    assertEq({
      suggested_business_type: sorted(all.body?.counts?.suggested_business_type),
      suggested_retail_focus: sorted(all.body?.counts?.suggested_retail_focus),
    }, {
      suggested_business_type: { retail_shop: 5 },
      suggested_retail_focus: { annet: 2, fisk: 2, kjott: 1 },
    }, "e2-20: counts per business_type og retail_focus (scope=all)");
    assertEq(all.body?.returned, 5, "e2-21: returned stemmer med counts");
    const sumFocus = Object.values(unc.body?.counts?.suggested_retail_focus ?? {}).reduce((a: number, b: any) => a + b, 0);
    assertEq(sumFocus, unc.body?.returned, "e2-22: counts summerer til returned (uncontacted)");
    const lim = await callRoute(businessTypeRouter, { method: "GET", url: "/classification-dryrun", headers: H, query: { scope: "all", limit: "2" } });
    assertEq([lim.body?.returned, Object.values(lim.body?.counts?.suggested_business_type ?? {}).reduce((a: number, b: any) => a + b, 0)], [2, 2], "e2-23: counts gjelder returnerte kandidater (limit)");

    assertEq(snap(), before, "e2-24: business_type/retail_focus uendret etter kallene");
    assertEq((db.prepare(`SELECT business_type FROM agents WHERE id='e2-fish'`).get() as any).business_type, null, "e2-25: business_type fortsatt NULL");
    assertEq((db.prepare(`SELECT total_changes() AS c`).get() as any).c, changesBefore, "e2-26: ingen skriving (total_changes uendret)");
    const noAuth = await callRoute(businessTypeRouter, { method: "GET", url: "/classification-dryrun", headers: {}, query: { scope: "all" } });
    assertEq(noAuth.status, 403, "e2-27: scope=all krever admin-nøkkel");
  } catch (err) {
    failed++;
    failures.push(`admin-agents-business-type-e2: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    __setBusinessTypeDbForTesting(null);
    __setDbForTesting(prevDb as any);
    if (!ambient) { if (prevKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevKey; }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminAgentsBusinessTypeE2Tests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    if (r.failed > 0) process.exit(1);
  });
}
