/**
 * rfb-address-line-no-duplicate-postal.test.ts — svar-gjennomgang 2026-09-09
 * (Daniel: «gå gjennom svarene … finn feilene og utbedre dem»), dev-request
 * 2026-09-09-rfb-profil-adresselinje-postnummer-dobbelt.
 *
 * `agent_knowledge.address` very often already carries the postal code and
 * city ("Bergemoveien 42, 4886 GRIMSTAD"). The profile page appended
 * `, ${postalCode}` unconditionally, so 17 of 42 sampled live profiles
 * rendered "…, 4886 GRIMSTAD, 4886" (Smaken av Grimstad's reply 2026-09-09:
 * «postkoden er skrevet to ganger»). formatAddressLine() appends the postal
 * code only when the address string does not already contain it.
 *
 * Same synthetic router.handle() harness + in-memory-DB pattern as
 * rfb-trust-score-public-display-removed.test.ts.
 */
import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runAddressLineNoDuplicatePostalTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  // ── (1) Unit: formatAddressLine ─────────────────────────────────────────
  const { formatAddressLine } = require("./seo") as typeof import("./seo");
  assertTrue(formatAddressLine("Bergemoveien 42, 4886 GRIMSTAD", "4886") === "Bergemoveien 42, 4886 GRIMSTAD",
    "unit: postal code already in address (Brreg-style line) is not appended again");
  assertTrue(formatAddressLine("Storgata 1", "0150") === "Storgata 1, 0150",
    "unit: postal code absent from address is appended once");
  assertTrue(formatAddressLine("Storgata 1", null) === "Storgata 1",
    "unit: no postal code -> address unchanged");
  assertTrue(formatAddressLine("", "0150") === "0150",
    "unit: empty address -> postal code alone");
  assertTrue(formatAddressLine("Vei 148860, 4886 Grimstad", "4886") === "Vei 148860, 4886 Grimstad",
    "unit: the standalone-number match ignores the code embedded in a longer number");
  assertTrue(formatAddressLine("Kronprinsens gate 57, 4614 Kristiansand", " 4614 ") === "Kronprinsens gate 57, 4614 Kristiansand",
    "unit: whitespace around the postal code is tolerated");
  assertTrue(formatAddressLine("Ringveien 5", "4614") === "Ringveien 5, 4614",
    "unit: different house number does not count as the postal code");

  // ── (2) Route: GET /produsent/:slug renders the line without duplication ─
  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");
  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();
  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");
  function seedAgent(row: { id: string; name: string; city: string }): void {
    testDb.prepare(
      `INSERT INTO agents (
        id, name, description, provider, contact_email, url, role, api_key,
        categories, tags, skills, capabilities, languages, city, lat, lng,
        trust_score, is_active, is_verified, brreg_verified, discovery_count, interaction_count,
        total_interactions, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'producer', ?,
        '["vegetables"]', '[]', '[]', '{}', '["no"]', ?, 58.34, 8.59,
        0.6, 1, 1, 0, 0, 0, 0, datetime('now'), datetime('now'))`,
    ).run(row.id, row.name, "En beskrivelse", row.name, `${row.id}@example.no`, `https://${row.id}.example.no`, `key-${row.id}`, row.city);
  }
  function seedKnowledge(agentId: string, address: string, postalCode: string | null): void {
    testDb.prepare(`INSERT INTO agent_knowledge (agent_id, address, postal_code) VALUES (?, ?, ?)`).run(agentId, address, postalCode);
  }
  function resetRegistryCache(): void {
    const regMod = require("../services/marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;
  }
  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite, or dir missing in CI */ }
    const seoRoutePath = require.resolve("./seo");
    delete require.cache[seoRoutePath];
    const seoRouter = require("./seo").default as any;
    function invoke(routePath: string, req: any): { status: number; body: string } {
      const layer = (seoRouter.stack as any[]).find((l: any) => l.route && l.route.path === routePath && l.route.methods?.get);
      assertTrue(!!layer, `setup: GET ${routePath} layer is registered`);
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      let status = 200;
      let body = "";
      const res: any = {
        status: (c: number) => { status = c; return res; },
        send: (b: unknown) => { body = typeof b === "string" ? b : String(b); return res; },
        redirect: (_c: number, _l: string) => { status = 301; return res; },
      };
      handler(req, res, (_e?: unknown) => {});
      return { status, body };
    }
    seedAgent({ id: "dup-1", name: "Grimstad Frukt Test", city: "Grimstad" });
    seedKnowledge("dup-1", "Bergemoveien 42, 4886 GRIMSTAD", "4886");
    seedAgent({ id: "nodup-1", name: "Storgata Bakeri Test", city: "Oslo" });
    seedKnowledge("nodup-1", "Storgata 1", "0150");
    resetRegistryCache();

    {
      const r = invoke("/produsent/:slug", { params: { slug: "grimstad-frukt-test" }, lang: "no", ip: "127.0.0.1" });
      assertTrue(r.status === 200, "produsent (address carries postal code): renders 200");
      assertTrue(r.body.includes("Bergemoveien 42, 4886 GRIMSTAD"), "produsent: the stored address line renders");
      assertTrue(!r.body.includes("4886 GRIMSTAD, 4886"), "produsent: pf-loc does not repeat the postal code after the city");
      assertTrue(!/GRIMSTAD, 4886<\/div>/.test(r.body), "produsent: contact item (ct-val) does not repeat the postal code either");
    }
    {
      const r = invoke("/produsent/:slug", { params: { slug: "storgata-bakeri-test" }, lang: "no", ip: "127.0.0.1" });
      assertTrue(r.status === 200, "produsent (address without postal code): renders 200");
      assertTrue(r.body.includes("Storgata 1, 0150"), "produsent: postal code is still appended when the address lacks it");
    }
  } finally {
    try { __setDbForTesting(prevDb as any); } catch { /* ignore */ }
    try { testDb.close(); } catch { /* ignore */ }
    try { delete require.cache[require.resolve("./seo")]; } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}
