/**
 * marketplace-knowledge-geocode-invalidate.test.ts — the customer-service
 * correction route PUT /api/marketplace/agents/:id/knowledge now resets the
 * geocode when it changes the address or postal code, and the new
 * POST /admin/agents/:id/geocode-reset re-queues one producer.
 *
 * Why (2026-10-05, ChatGPT app pre-submission review): Snill Bie and Myrvold
 * Gård had addresses imported from unrelated Brreg entities. Correcting the
 * address through this route left the map pin 321 and 398 km away, so radius
 * searches still matched them in the wrong county. PUT /admin/knowledge has
 * reset the geocode on an address change since dev-request
 * 2026-09-11-rettet-adresse-oppdaterer-ikke-kartpunktet; this route did not.
 *
 * Covers:
 *   g1-g3  an address change resets lat/lng/geo_precision/attempts and
 *          reports geocode_invalidated:true
 *   g4     a postal-code-only change resets too
 *   g5-g6  re-sending the stored address, or a write that never touches the
 *          address, leaves a good geocode alone
 *   g7-g9  geocode-reset: 403 without the admin key, 404 for an unknown id,
 *          resets one row (and only that row) with an admin key
 *
 * Standalone: npx tsx src/routes/marketplace-knowledge-geocode-invalidate.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: { method: string; url: string; headers?: Record<string, string>; body?: any },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method,
      url: opts.url,
      originalUrl: opts.url,
      query: {},
      headers,
      body: opts.body,
      ip: "127.0.0.1",
      get(name: string) {
        return headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      setHeader() { /* no-op */ },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ status: err ? 500 : 404, body: err ? { error: String(err) } : undefined });
    });
  });
}

export async function runMarketplaceKnowledgeGeocodeInvalidateTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  const prevDb = initMod.__peekDbForTesting();
  const prevAdminKey = process.env.ADMIN_KEY;
  const testKey = "marketplace-geocode-invalidate-test-key";
  process.env.ADMIN_KEY = testKey;
  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry chatter */ };

  const db = new Database(":memory:");
  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);

    const insertAgent = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key,
                           lat, lng, geo_precision, geocode_source, geocode_outcome,
                           geocode_attempts, geocode_attempted_at)
       VALUES (?, ?, 'test agent', 'test', 'post@example.no', '', 'producer', ?,
               61.1527, 10.3804, 'address', 'kartverket_adresse', 'high', 3, '2026-10-01T10:00:00.000Z')`,
    );
    const insertKnowledge = db.prepare(
      `INSERT INTO agent_knowledge (agent_id, address, postal_code, field_provenance) VALUES (?, ?, ?, '{}')`,
    );
    const seed = (id: string, address: string, postal: string) => {
      insertAgent.run(id, `Test Gård ${id}`, `key-${id}`);
      insertKnowledge.run(id, address, postal);
    };
    const geo = (id: string) =>
      db.prepare("SELECT lat, lng, geo_precision, geocode_attempts, geocode_attempted_at FROM agents WHERE id = ?").get(id) as any;

    delete require.cache[require.resolve("./marketplace")];
    const router = (require("./marketplace") as typeof import("./marketplace")).default;
    const admin = { "x-admin-key": testKey, "content-type": "application/json" };
    const put = (id: string, body: any) =>
      callRoute(router, { method: "PUT", url: `/agents/${id}/knowledge`, headers: admin, body });

    // g1-g3: Snill Bie-shaped correction, Fåberg → Bømlo.
    seed("snill", "Baklivegen 60, 2625 FÅBERG", "2625");
    let r = await put("snill", { address: "Rubbestadvegen 38, 5427 Urangsvåg", postalCode: "5427" });
    assertEq(r.status, 200, "g1: the correcting write succeeds");
    assertEq(geo("snill"), { lat: null, lng: null, geo_precision: null, geocode_attempts: 0, geocode_attempted_at: null },
      "g2: the stale Fåberg pin is cleared and the row is selectable for the geocode worker again");
    assertEq(r.body?.geocode_invalidated, true, "g3: the response reports geocode_invalidated:true");

    // g4: postal code alone.
    seed("postal", "Storgata 1, 0155 Oslo", "0155");
    r = await put("postal", { postalCode: "0150" });
    assertEq(geo("postal").lat, null, "g4: a postal-code-only change also clears the pin");

    // g5-g6: nothing that moves the producer.
    seed("same", "Nordhuglo 232, 5413 Huglo", "5413");
    r = await put("same", { address: "Nordhuglo 232, 5413 Huglo", postalCode: "5413" });
    assertEq([geo("same").geo_precision, r.body?.geocode_invalidated], ["address", undefined],
      "g5: re-sending the stored address keeps the good geocode, no geocode_invalidated flag");
    r = await put("same", { about: "Gården er åpen i sesong." });
    assertEq(geo("same").lat, 61.1527, "g6: a write that never touches the address keeps the pin");

    // g7-g9: single-producer geocode reset.
    seed("reset", "Sørgrenda 264, 7622 Markabygda", "7622");
    seed("bystander", "Torget 1, 7600 Levanger", "7600");
    r = await callRoute(router, { method: "POST", url: "/admin/agents/reset/geocode-reset", headers: {} });
    assertEq([r.status, geo("reset").lat], [403, 61.1527], "g7: without the admin key: 403 and nothing changes");
    r = await callRoute(router, { method: "POST", url: "/admin/agents/does-not-exist/geocode-reset", headers: admin });
    assertEq(r.status, 404, "g8: an unknown id is a 404");
    r = await callRoute(router, { method: "POST", url: "/admin/agents/reset/geocode-reset", headers: admin });
    assertEq([r.status, r.body?.data?.before?.lat, geo("reset").lat, geo("reset").geocode_attempts, geo("bystander").lat],
      [200, 61.1527, null, 0, 61.1527],
      "g9: resets exactly that producer (reporting the old pin) and leaves every other row alone");
  } catch (err: any) {
    failed++;
    failures.push("marketplace-knowledge-geocode-invalidate: unexpected error: " + String(err?.stack || err));
  } finally {
    console.log = prevLog;
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runMarketplaceKnowledgeGeocodeInvalidateTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
