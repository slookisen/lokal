/**
 * init-outreach-pool-retail-gate.test.ts — dev-request
 * 2026-10-01-rfb-butikker-i-outreach-poolen (AC1).
 *
 * outreach_ready_pool VIEW retail gate (POOL_RETAIL_SHOP_GATE_SQL), its pure
 * mirror retailShopPoolBlockers, pool-blocker-explain's named reasons, the
 * mode=second candidate query, and POST /admin/agents/business-type
 * (dry-run default, audit, explicit ids) + the read-only classification dry-run.
 *
 * Exported runInitOutreachPoolRetailGateTests({log}) -> Promise<TestSummary>;
 * wired into tests/test.ts. Standalone:
 *   npx tsx src/database/init-outreach-pool-retail-gate.test.ts
 */

import Database from "better-sqlite3";
import { getDb, __setDbForTesting, __initSchemaForTesting, retailShopPoolBlockers } from "./init";
import businessTypeRouter, { __setBusinessTypeDbForTesting, classifyRetailSignals } from "../routes/admin-agents-business-type";
import explainRouter from "../routes/admin-pool-blocker-explain";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(router: any, opts: { method: string; url: string; headers?: Record<string, string>; body?: any; query?: Record<string, string> }): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = { method: opts.method, url: opts.url, originalUrl: opts.url, query: opts.query || {}, headers, body: opts.body, ip: "127.0.0.1", get: (n: string) => headers[n.toLowerCase()] };
    const res: any = {
      statusCode: 200,
      status(c: number) { this.statusCode = c; return this; },
      json(p: any) { resolve({ status: this.statusCode, body: p }); return this; },
      end() { resolve({ status: this.statusCode, body: undefined }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 0, body: err ? { error: String(err) } : undefined }));
  });
}

const ABOUT_SHOP = "Vi er en frukt- og grøntbutikk i hjertet av byen. Vi selger sesongens frukt, bær og grønnsaker fra lokale leverandører, og har alltid friske varer klare for deg i butikken vår hver dag.";
const PROV_HOMEPAGE = JSON.stringify({ about: [{ value: "x", source_type: "homepage", fetched_at: "2026-10-01" }] });
const PROV_OTHER = JSON.stringify({ about: [{ value: "x", source_type: "google_places", fetched_at: "2026-10-01" }] });
const PRODUCTS3 = JSON.stringify([{ name: "Epler" }, { name: "Pærer" }, { name: "Gulrøtter" }]);

export function runInitOutreachPoolRetailGateTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`); }
  }
  function assertTrue(c: boolean, label: string): void { assertEq(!!c, true, label); }

  return (async () => {
    const prevDb = getDb();
    const db = new Database(":memory:");
    __setDbForTesting(db as any);
    __initSchemaForTesting(db as any);
    __setBusinessTypeDbForTesting(db as any);
    const prevKey = process.env.ADMIN_KEY;
    const ambient = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
    const key = ambient || "retail-gate-test-key";
    if (!ambient) process.env.ADMIN_KEY = key;

    function add(id: string, o: { bt?: string | null; rf?: string | null; about?: string; prov?: string; products?: string; role?: string }): void {
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, business_type, retail_focus)
                  VALUES (?, ?, 'test', 'test', ?, ?, ?, ?, ?, ?)`)
        .run(id, `Navn ${id}`, `${id}@rg-test.no`, `https://${id}.rg-test.no`, o.role ?? "producer", `key-${id}`, o.bt ?? null, o.rf ?? null);
      db.prepare(`INSERT INTO agent_knowledge (agent_id, email, website, field_provenance, verification_status, enrichment_status, url_last_status, url_last_probed, about, products)
                  VALUES (?, ?, ?, ?, 'verified', 'rich', 200, datetime('now'), ?, ?)`)
        .run(id, `${id}@rg-test.no`, `https://${id}.rg-test.no`, o.prov ?? PROV_HOMEPAGE, o.about ?? ABOUT_SHOP, o.products ?? PRODUCTS3);
    }

    try {
      // AC1 fixtures
      add("rg-other-focus", { bt: "retail_shop", rf: "annet" });                         // ute: annet fokus
      add("rg-fish", { bt: "retail_shop", rf: "fisk" });                                  // ute: fisk ikke avklart
      add("rg-fg-thin", { bt: "retail_shop", rf: "frukt_gront", about: "Liten butikk.", prov: "{}", products: "[]" }); // ute: tynn
      add("rg-fg-enriched", { bt: "retail_shop", rf: "frukt_gront" });                    // inne
      add("rg-farmshop", { bt: "farm_shop" });                                            // inne
      add("rg-plain-producer", {});                                                       // inne (umerket)
      add("rg-explicit-producer", { bt: "producer" });                                    // inne
      // Én feil om gangen på en ellers beriket frukt/grønt-butikk
      add("rg-fg-no-homepage-prov", { bt: "retail_shop", rf: "frukt_gront", prov: PROV_OTHER });
      add("rg-fg-two-products", { bt: "retail_shop", rf: "frukt_gront", products: JSON.stringify([{ name: "a" }, { name: "b" }]) });
      add("rg-fg-not-shop-text", { bt: "retail_shop", rf: "frukt_gront", about: "Vi dyrker epler, pærer og plommer på gården vår ved fjorden, og har gjort det i tre generasjoner. Alt plukkes for hånd og sendes ferskt til deg." });
      add("rg-fg-malformed-json", { bt: "retail_shop", rf: "frukt_gront", prov: "{not json", products: "[broken" });
      add("rg-fg-wrapped-prov", { bt: "retail_shop", rf: "frukt_gront", prov: JSON.stringify({ about: { sources: [{ value: "x", source_type: "homepage" }] } }) });

      const inPool = new Set((db.prepare(`SELECT agent_id FROM outreach_ready_pool`).all() as Array<{ agent_id: string }>).map((r) => r.agent_id));
      assertTrue(!inPool.has("rg-other-focus"), "rg-01: butikk med annet fokus er ute av poolen");
      assertTrue(!inPool.has("rg-fish"), "rg-02: fisk-fokus regnes ikke som tillatt (Daniels svar ikke gitt)");
      assertTrue(!inPool.has("rg-fg-thin"), "rg-03: frukt/grønt-butikk med tynn profil er ute");
      assertTrue(inPool.has("rg-fg-enriched"), "rg-04: frukt/grønt-butikk med beriket profil er inne");
      assertTrue(inPool.has("rg-farmshop"), "rg-05: produsentens gårdsbutikk er inne");
      assertTrue(inPool.has("rg-plain-producer"), "rg-06: vanlig produsent (umerket) er uberørt");
      assertTrue(inPool.has("rg-explicit-producer"), "rg-07: business_type=producer er uberørt");
      assertTrue(!inPool.has("rg-fg-no-homepage-prov"), "rg-08: uten homepage-proveniens på om-tekst er ute");
      assertTrue(!inPool.has("rg-fg-two-products"), "rg-09: færre enn 3 produkter er ute");
      assertTrue(!inPool.has("rg-fg-not-shop-text"), "rg-10: tekst som ikke beskriver butikk er ute");
      assertTrue(!inPool.has("rg-fg-malformed-json"), "rg-11: ugyldig JSON gir ute (ingen krasj)");
      assertTrue(inPool.has("rg-fg-wrapped-prov"), "rg-12: {sources:[...]}-proveniens godtas");

      // SQL og TS-speil må være enige for alle fixtures
      const rows = db.prepare(`SELECT a.id, a.business_type, a.retail_focus, k.about, k.products, k.field_provenance FROM agents a JOIN agent_knowledge k ON k.agent_id = a.id WHERE a.id LIKE 'rg-%'`).all() as any[];
      let mismatches = 0;
      for (const r of rows) {
        const tsBlocked = retailShopPoolBlockers(r).length > 0;
        if (tsBlocked === inPool.has(r.id)) mismatches++;
      }
      assertEq(mismatches, 0, "rg-13: retailShopPoolBlockers er enig med VIEW for alle fixtures");
      assertEq(retailShopPoolBlockers(rows.find((r) => r.id === "rg-other-focus")), ["retail_shop_not_eligible"], "rg-14: navngitt grunn retail_shop_not_eligible");
      assertEq(retailShopPoolBlockers(rows.find((r) => r.id === "rg-fg-thin")), ["retail_profile_not_ready"], "rg-15: navngitt grunn retail_profile_not_ready");

      // pool-blocker-explain navngir sperren
      const ex = await callRoute(explainRouter, { method: "GET", url: "/", headers: { "x-admin-key": key }, query: { agentIds: "rg-other-focus,rg-fg-thin,rg-fg-enriched,rg-farmshop" } });
      const byId: Record<string, any> = {};
      for (const a of ex.body?.agents ?? []) byId[a.agent_id] = a;
      assertTrue((byId["rg-other-focus"]?.pool_blockers ?? []).includes("retail_shop_not_eligible"), "rg-16: explain viser retail_shop_not_eligible");
      assertTrue((byId["rg-fg-thin"]?.pool_blockers ?? []).includes("retail_profile_not_ready"), "rg-17: explain viser retail_profile_not_ready");
      assertTrue(!(byId["rg-fg-enriched"]?.pool_blockers ?? []).some((b: string) => b.startsWith("retail_")), "rg-18: beriket frukt/grønt har ingen butikksperre i explain");
      assertEq(byId["rg-fg-enriched"]?.in_pool, true, "rg-19: explain in_pool=true for beriket frukt/grønt");
      assertTrue(!(byId["rg-farmshop"]?.pool_blockers ?? []).some((b: string) => b.startsWith("retail_")), "rg-20: gårdsbutikk har ingen butikksperre i explain");

      // mode=second-spørringen (kopi av VIEW-vilkårene): samme sperre
      const { POOL_RETAIL_SHOP_GATE_SQL } = require("./init") as typeof import("./init");
      const second = new Set((db.prepare(`SELECT a.id FROM agents a INNER JOIN agent_knowledge k ON k.agent_id = a.id WHERE a.id LIKE 'rg-%' AND ${POOL_RETAIL_SHOP_GATE_SQL}`).all() as Array<{ id: string }>).map((r) => r.id));
      assertTrue(!second.has("rg-other-focus") && second.has("rg-fg-enriched") && second.has("rg-farmshop"), "rg-21: POOL_RETAIL_SHOP_GATE_SQL alene gir samme utfall");

      // ── Admin-rute: business-type ──
      const H = { "x-admin-key": key };
      const noAuth = await callRoute(businessTypeRouter, { method: "POST", url: "/", headers: {}, body: { agentIds: ["rg-plain-producer"], business_type: "retail_shop", retail_focus: "annet", reason: "t" } });
      assertEq(noAuth.status, 403, "bt-01: uten admin-nøkkel gir 403");
      const noIds = await callRoute(businessTypeRouter, { method: "POST", url: "/", headers: H, body: { business_type: "retail_shop", retail_focus: "annet", reason: "t" } });
      assertEq(noIds.status, 400, "bt-02: mangler agentIds gir 400");
      const noFocus = await callRoute(businessTypeRouter, { method: "POST", url: "/", headers: H, body: { agentIds: ["rg-plain-producer"], business_type: "retail_shop", reason: "t" } });
      assertEq(noFocus.status, 400, "bt-03: retail_shop uten retail_focus gir 400");
      const noReason = await callRoute(businessTypeRouter, { method: "POST", url: "/", headers: H, body: { agentIds: ["rg-plain-producer"], business_type: "cafe" } });
      assertEq(noReason.status, 400, "bt-04: mangler reason gir 400");

      const dry = await callRoute(businessTypeRouter, { method: "POST", url: "/", headers: H, body: { agentIds: ["rg-plain-producer", "finnes-ikke"], business_type: "retail_shop", retail_focus: "annet", reason: "test" } });
      assertEq(dry.body?.dry_run, true, "bt-05: tørrkjøring er standard");
      assertEq(dry.body?.counts, { would_set: 1, not_found: 1 }, "bt-06: tørrkjøring teller would_set/not_found");
      const still = db.prepare(`SELECT business_type FROM agents WHERE id='rg-plain-producer'`).get() as any;
      assertEq(still.business_type, null, "bt-07: tørrkjøring skriver ingenting");
      assertEq((db.prepare(`SELECT COUNT(*) c FROM agent_knowledge_audit WHERE field_name IN ('business_type','retail_focus')`).get() as any).c, 0, "bt-08: tørrkjøring skriver ingen audit-rad");

      const ap = await callRoute(businessTypeRouter, { method: "POST", url: "/", headers: H, body: { agentIds: ["rg-plain-producer"], business_type: "retail_shop", retail_focus: "annet", reason: "test", apply: true } });
      assertEq(ap.body?.counts, { set: 1 }, "bt-09: apply setter merket");
      const after = db.prepare(`SELECT business_type, retail_focus FROM agents WHERE id='rg-plain-producer'`).get() as any;
      assertEq(after, { business_type: "retail_shop", retail_focus: "annet" }, "bt-10: merket ligger på raden");
      assertEq((db.prepare(`SELECT COUNT(*) c FROM agent_knowledge_audit WHERE agent_id='rg-plain-producer' AND field_name IN ('business_type','retail_focus') AND changed_by='admin'`).get() as any).c, 2, "bt-11: én audit-rad per endret kolonne");
      const view2 = db.prepare(`SELECT 1 FROM outreach_ready_pool WHERE agent_id='rg-plain-producer'`).get();
      assertTrue(!view2, "bt-12: merket butikk (annet) faller ut av poolen");
      const again = await callRoute(businessTypeRouter, { method: "POST", url: "/", headers: H, body: { agentIds: ["rg-plain-producer"], business_type: "retail_shop", retail_focus: "annet", reason: "test", apply: true } });
      assertEq(again.body?.counts, { unchanged: 1 }, "bt-13: idempotent");
      const clear = await callRoute(businessTypeRouter, { method: "POST", url: "/", headers: H, body: { agentIds: ["rg-plain-producer"], business_type: null, reason: "angre", apply: true } });
      assertEq(clear.body?.counts, { set: 1 }, "bt-14: null fjerner merket");
      assertTrue(!!db.prepare(`SELECT 1 FROM outreach_ready_pool WHERE agent_id='rg-plain-producer'`).get(), "bt-15: etter fjerning er raden tilbake i poolen");

      // ── Klassifiserings-tørrkjøring (read-only) ──
      const sigShop = classifyRetailSignals({ name: "Havens Kolonial", about: "Nettbutikk for dagligvarer" });
      const sigFarm = classifyRetailSignals({ name: "Hansen Gård", about: "Vår gårdsbutikk er åpen lørdag" });
      assertTrue(sigShop.confidence > sigFarm.confidence, "cl-01: kolonial/nettbutikk har høyere sikkerhet enn gårdsbutikk");
      assertTrue(sigFarm.farm_shop_hint, "cl-02: gårdsbutikk flagges som farm_shop_hint");
      db.prepare(`UPDATE agents SET name='Grønlandstorg Frukt & Grønt Butikk' WHERE id='rg-plain-producer'`).run();
      const before = JSON.stringify(db.prepare(`SELECT id, business_type, retail_focus FROM agents ORDER BY id`).all());
      const dr = await callRoute(businessTypeRouter, { method: "GET", url: "/classification-dryrun", headers: H, query: { scope: "pool" } });
      assertEq(dr.body?.read_only, true, "cl-03: dry-run er read_only");
      assertTrue((dr.body?.candidates ?? []).some((c: any) => c.agent_id === "rg-plain-producer"), "cl-04: kandidat med butikk-signal i navn listes");
      assertEq(JSON.stringify(db.prepare(`SELECT id, business_type, retail_focus FROM agents ORDER BY id`).all()), before, "cl-05: dry-run endrer ingen rader");
      const drNoAuth = await callRoute(businessTypeRouter, { method: "GET", url: "/classification-dryrun", headers: {} });
      assertEq(drNoAuth.status, 403, "cl-06: dry-run krever admin-nøkkel");
    } catch (err) {
      failed++;
      failures.push(`init-outreach-pool-retail-gate: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
    } finally {
      __setBusinessTypeDbForTesting(null);
      __setDbForTesting(prevDb as any);
      if (!ambient) { if (prevKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevKey; }
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runInitOutreachPoolRetailGateTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    if (r.failed > 0) process.exit(1);
  });
}
