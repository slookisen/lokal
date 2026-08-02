/**
 * admin-crm-chimera-agent-clear.test.ts — tests
 * POST /admin/crm-chimera-agent-clear (dev-request
 * 2026-07-23-crm-house-bucket-kimaere-opprydding, slice 2).
 *
 * Mirrors admin-domain-coherence.test.ts's harness:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (full prod-like schema).
 *   - the previous global db handle is saved/restored.
 *   - the router is exercised directly (router.handle(req, res, next)),
 *     no HTTP server / supertest.
 *   - exported runAdminCrmChimeraAgentClearTests({log}) -> TestSummary;
 *     wired into tests/test.ts.
 *     Standalone: npx tsx src/routes/admin-crm-chimera-agent-clear.test.ts
 *
 * Coverage:
 *   - dry-run (default / apply=false) returns the CURRENT contaminated
 *     values and a preview of the empty target values, without writing.
 *   - apply=true clears exactly the 13 listed fields to their correct
 *     empty representation (NULL for scalars, '[]' for JSON-array columns)
 *     and reports rows_touched=1.
 *   - a second apply=true call is idempotent: already-empty stays empty,
 *     no error, rows_touched still 1.
 *   - an unrelated second agent's agent_knowledge row is byte-for-byte
 *     unchanged after apply.
 *   - fields NOT in the clear list (website, certifications, images,
 *     data_source, ...) are left untouched.
 *   - auth is enforced: missing/wrong X-Admin-Key -> 403 (matches the
 *     requireAdmin convention this route reuses from
 *     admin-domain-coherence.ts / admin-wrong-entity-retro-sweep.ts).
 *   - agent_knowledge row missing entirely -> 404, no crash.
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
  ended: boolean;
}

function callRoute(
  router: any,
  opts: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    body?: any;
  },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      query: opts.query || {},
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
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload, ended: true });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined, ended: true });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) {
        resolve({ status: 500, body: { error: String(err) }, ended: true });
      } else {
        resolve({ status: 0, body: undefined, ended: false });
      }
    });
  });
}

const CHIMERA_AGENT_ID = "2b5fc7a6-b446-4bea-8c2d-21315c6c6e17";

export function runAdminCrmChimeraAgentClearTests(
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

  return (async () => {
    const prevDb = initMod.getDb();
    const testKey = process.env.ADMIN_KEY || "admin-crm-chimera-agent-clear-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, umbrella_type)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, ?, ?, NULL)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (
           agent_id, address, postal_code, website, phone, email,
           opening_hours, products, about, specialties, certifications,
           payment_methods, delivery_options, google_rating, google_review_count,
           external_reviews, images, data_source, auto_sources
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      // The chimera row itself, seeded with Bondens-Kolonial-shaped
      // contamination mirroring the live prod card response described in
      // the task background.
      insertAgent.run(CHIMERA_AGENT_ID, "Rett fra Bonden", "https://rettfrabonden.com", "logistics", "key-chimera");
      insertKnowledge.run(
        CHIMERA_AGENT_ID,
        "Tangvallveien 1",
        "4640",
        "https://bondens-kolonial.no",
        "+47 900 22 070",
        "toralv@bondens-kolonial.no",
        JSON.stringify([{ day: "mon", open: "09:00", close: "17:00" }]),
        JSON.stringify([{ name: "Ost", category: "dairy" }]),
        "Bondens Kolonial er en lokal gårdsbutikk...",
        JSON.stringify(["Økologiske grønnsaker"]),
        JSON.stringify(["Debio"]),
        JSON.stringify(["Vipps", "Kort"]),
        JSON.stringify(["Henting på gård"]),
        4.7,
        55,
        JSON.stringify([{ source: "Google", text: "Flott butikk!", rating: 5 }]),
        JSON.stringify(["https://bondens-kolonial.no/img1.jpg"]),
        "auto",
        JSON.stringify(["google_maps"]),
      );

      // Unrelated second agent — must be byte-for-byte unchanged by any
      // call this route ever makes.
      insertAgent.run("agent-unrelated", "Unrelated Gård AS", "https://unrelated-gard.no", "producer", "key-unrelated");
      insertKnowledge.run(
        "agent-unrelated",
        "Unrelatedveien 5",
        "1234",
        "https://unrelated-gard.no",
        "+47 900 11 111",
        "post@unrelated-gard.no",
        JSON.stringify([{ day: "tue", open: "10:00", close: "16:00" }]),
        JSON.stringify([{ name: "Egg", category: "dairy" }]),
        "En helt vanlig, uberørt produsent.",
        JSON.stringify(["Frittgående høns"]),
        JSON.stringify(["Nyt Norge"]),
        JSON.stringify(["Kontant"]),
        JSON.stringify(["REKO-ring"]),
        4.2,
        10,
        JSON.stringify([{ source: "Google", text: "Bra egg", rating: 4 }]),
        JSON.stringify(["https://unrelated-gard.no/img1.jpg"]),
        "owner",
        JSON.stringify(["manual"]),
      );

      delete require.cache[require.resolve("./admin-crm-chimera-agent-clear")];
      const routeMod = require("./admin-crm-chimera-agent-clear");
      const router = routeMod.default;
      assertEq(routeMod.CHIMERA_AGENT_ID, CHIMERA_AGENT_ID, "cc-00: exported CHIMERA_AGENT_ID constant matches the hardcoded row we seeded");

      function post(query?: Record<string, string>, body?: any, key: string | false = testKey): Promise<RouteResult> {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (key !== false) headers["x-admin-key"] = key;
        return callRoute(router, {
          method: "POST",
          url: "/",
          headers,
          query,
          body,
        });
      }

      const unrelatedSnapshotBefore = db.prepare("SELECT * FROM agent_knowledge WHERE agent_id = 'agent-unrelated'").get();

      // ── auth gate ─────────────────────────────────────────────────────
      let result = await post({}, {}, false);
      assertEq(result.status, 403, "cc-01: missing X-Admin-Key -> 403");
      result = await post({}, {}, "wrong-key");
      assertEq(result.status, 403, "cc-02: wrong X-Admin-Key -> 403");

      // ── dry-run (no apply param) ─────────────────────────────────────
      result = await post({}, {});
      assertEq(result.status, 200, "cc-03: dry-run POST -> 200");
      assertEq(result.body.apply, false, "cc-04: apply reflects false when absent");
      assertEq(result.body.agent_id, CHIMERA_AGENT_ID, "cc-05: agent_id echoed back is the hardcoded chimera id");
      assertEq(result.body.rows_touched, 0, "cc-06: dry-run reports rows_touched=0");

      assertEq(result.body.before.address, "Tangvallveien 1", "cc-07: dry-run reports the current (contaminated) address");
      assertEq(result.body.before.email, "toralv@bondens-kolonial.no", "cc-08: dry-run reports the current (contaminated) email");
      assertEq(result.body.before.google_rating, 4.7, "cc-09: dry-run reports the current google_rating");
      assertEq(result.body.before.google_review_count, 55, "cc-10: dry-run reports the current google_review_count");
      assertTrue(String(result.body.before.opening_hours).includes("mon"), "cc-11: dry-run reports the current (JSON-string) opening_hours");

      assertEq(result.body.after_preview.address, null, "cc-12: dry-run preview shows address will become null");
      assertEq(result.body.after_preview.email, null, "cc-13: dry-run preview shows email will become null");
      assertEq(result.body.after_preview.google_rating, null, "cc-14: dry-run preview shows google_rating will become null");
      assertEq(result.body.after_preview.opening_hours, "[]", "cc-15: dry-run preview shows opening_hours will become '[]'");
      assertEq(result.body.after_preview.products, "[]", "cc-16: dry-run preview shows products will become '[]'");
      assertEq(result.body.after_preview.specialties, "[]", "cc-17: dry-run preview shows specialties will become '[]'");
      assertEq(result.body.after_preview.payment_methods, "[]", "cc-18: dry-run preview shows payment_methods will become '[]'");
      assertEq(result.body.after_preview.delivery_options, "[]", "cc-19: dry-run preview shows delivery_options will become '[]'");
      assertEq(result.body.after_preview.external_reviews, "[]", "cc-20: dry-run preview shows external_reviews will become '[]'");
      assertEq(result.body.after_preview.about, null, "cc-21: dry-run preview shows about will become null");
      assertEq(result.body.after_preview.postal_code, null, "cc-22: dry-run preview shows postal_code will become null");
      assertEq(result.body.after_preview.phone, null, "cc-23: dry-run preview shows phone will become null");

      const expectedFields = [
        "about", "address", "postal_code", "phone", "email",
        "google_rating", "google_review_count",
        "opening_hours", "products", "specialties", "payment_methods",
        "delivery_options", "external_reviews",
      ].sort();
      assertEq([...result.body.fields_cleared].sort(), expectedFields, "cc-24: fields_cleared is exactly the 13-field list, no more no less");

      // ── dry-run must not write anything ──────────────────────────────
      const preApplyRow = db.prepare("SELECT address, email, google_rating, opening_hours, website, images, data_source FROM agent_knowledge WHERE agent_id = ?").get(CHIMERA_AGENT_ID) as any;
      assertEq(preApplyRow.address, "Tangvallveien 1", "cc-25: dry-run does not write address");
      assertEq(preApplyRow.email, "toralv@bondens-kolonial.no", "cc-26: dry-run does not write email");
      assertEq(preApplyRow.google_rating, 4.7, "cc-27: dry-run does not write google_rating");

      // ── apply=true (query string) ────────────────────────────────────
      result = await post({ apply: "true" }, {});
      assertEq(result.status, 200, "cc-28: apply POST -> 200");
      assertEq(result.body.apply, true, "cc-29: apply reflects true");
      assertEq(result.body.rows_touched, 1, "cc-30: exactly 1 row touched");

      const postApplyRow = db.prepare(`SELECT * FROM agent_knowledge WHERE agent_id = ?`).get(CHIMERA_AGENT_ID) as any;
      assertEq(postApplyRow.address, null, "cc-31: address cleared to NULL");
      assertEq(postApplyRow.postal_code, null, "cc-32: postal_code cleared to NULL");
      assertEq(postApplyRow.phone, null, "cc-33: phone cleared to NULL");
      assertEq(postApplyRow.email, null, "cc-34: email cleared to NULL");
      assertEq(postApplyRow.about, null, "cc-35: about cleared to NULL");
      assertEq(postApplyRow.google_rating, null, "cc-36: google_rating cleared to NULL");
      assertEq(postApplyRow.google_review_count, null, "cc-37: google_review_count cleared to NULL");
      assertEq(postApplyRow.opening_hours, "[]", "cc-38: opening_hours cleared to '[]'");
      assertEq(postApplyRow.products, "[]", "cc-39: products cleared to '[]'");
      assertEq(postApplyRow.specialties, "[]", "cc-40: specialties cleared to '[]'");
      assertEq(postApplyRow.payment_methods, "[]", "cc-41: payment_methods cleared to '[]'");
      assertEq(postApplyRow.delivery_options, "[]", "cc-42: delivery_options cleared to '[]'");
      assertEq(postApplyRow.external_reviews, "[]", "cc-43: external_reviews cleared to '[]'");

      // Fields explicitly OUT of scope must be untouched.
      assertEq(postApplyRow.website, "https://bondens-kolonial.no", "cc-44: website is NOT cleared (out of scope, no contamination evidence)");
      assertEq(postApplyRow.certifications, JSON.stringify(["Debio"]), "cc-45: certifications is NOT cleared");
      assertEq(postApplyRow.images, JSON.stringify(["https://bondens-kolonial.no/img1.jpg"]), "cc-46: images is NOT cleared");
      assertEq(postApplyRow.data_source, "auto", "cc-47: data_source is NOT cleared");
      assertEq(postApplyRow.auto_sources, JSON.stringify(["google_maps"]), "cc-48: auto_sources is NOT cleared");

      // ── idempotency: second apply on an already-cleared row ──────────
      result = await post({ apply: "true" }, {});
      assertEq(result.status, 200, "cc-49: second apply POST -> 200 (no error on already-empty row)");
      assertEq(result.body.apply, true, "cc-50: second apply still reports apply=true");
      assertEq(result.body.rows_touched, 1, "cc-51: second apply still reports rows_touched=1 (the row exists, UPDATE is a no-op)");
      assertEq(result.body.before.address, null, "cc-52: second apply's 'before' shows already-null address");
      assertEq(result.body.after.address, null, "cc-53: second apply's 'after' confirms address is still null");
      assertEq(result.body.after.opening_hours, "[]", "cc-54: second apply's 'after' confirms opening_hours is still '[]'");

      const doubleAppliedRow = db.prepare(`SELECT * FROM agent_knowledge WHERE agent_id = ?`).get(CHIMERA_AGENT_ID) as any;
      assertEq(doubleAppliedRow.address, null, "cc-55: idempotent — address still null after second apply");
      assertEq(doubleAppliedRow.opening_hours, "[]", "cc-56: idempotent — opening_hours still '[]' after second apply");
      assertEq(doubleAppliedRow.website, "https://bondens-kolonial.no", "cc-57: idempotent — out-of-scope website still untouched after second apply");

      // ── the unrelated agent's row is byte-for-byte unchanged ─────────
      const unrelatedSnapshotAfter = db.prepare("SELECT * FROM agent_knowledge WHERE agent_id = 'agent-unrelated'").get();
      assertEq(unrelatedSnapshotAfter, unrelatedSnapshotBefore, "cc-58: unrelated agent's agent_knowledge row is byte-for-byte unchanged after two apply calls");

      // ── query-param apply also accepted as apply=1 ────────────────────
      // Reset the chimera row to contaminated values, then verify ?apply=1
      // (not just "true") also triggers the write path.
      db.prepare("UPDATE agent_knowledge SET email = ? WHERE agent_id = ?").run("toralv@bondens-kolonial.no", CHIMERA_AGENT_ID);
      result = await post({ apply: "1" }, {});
      assertEq(result.body.apply, true, "cc-59: ?apply=1 also triggers apply mode");
      const afterOne = db.prepare("SELECT email FROM agent_knowledge WHERE agent_id = ?").get(CHIMERA_AGENT_ID) as { email: string | null };
      assertEq(afterOne.email, null, "cc-60: ?apply=1 actually wrote the clear");

      // ── apply=false explicitly stays dry-run ──────────────────────────
      db.prepare("UPDATE agent_knowledge SET phone = ? WHERE agent_id = ?").run("+47 900 22 070", CHIMERA_AGENT_ID);
      result = await post({ apply: "false" }, {});
      assertEq(result.body.apply, false, "cc-61: ?apply=false stays dry-run");
      const afterFalse = db.prepare("SELECT phone FROM agent_knowledge WHERE agent_id = ?").get(CHIMERA_AGENT_ID) as { phone: string | null };
      assertEq(afterFalse.phone, "+47 900 22 070", "cc-62: ?apply=false does not write");
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
    }

    // ── missing agent_knowledge row -> 404, isolated DB ──────────────────
    {
      const prevDb2 = initMod.getDb();
      const testKey2 = process.env.ADMIN_KEY || "admin-crm-chimera-agent-clear-404-test-key";
      const prevAdminKey2 = process.env.ADMIN_KEY;
      process.env.ADMIN_KEY = testKey2;
      const db2 = new Database(":memory:");
      try {
        initMod.__setDbForTesting(db2 as any);
        initMod.__initSchemaForTesting(db2 as any);
        // No agents/agent_knowledge rows inserted at all.

        delete require.cache[require.resolve("./admin-crm-chimera-agent-clear")];
        const routeMod2 = require("./admin-crm-chimera-agent-clear");
        const router2 = routeMod2.default;

        const r = await callRoute(router2, {
          method: "POST",
          url: "/",
          headers: { "content-type": "application/json", "x-admin-key": testKey2 },
          query: {},
          body: {},
        });
        assertEq(r.status, 404, "cc-63: missing agent_knowledge row -> 404");
        assertEq(r.body.success, false, "cc-64: 404 response has success:false");
      } finally {
        initMod.__setDbForTesting(prevDb2);
        if (prevAdminKey2 === undefined) delete process.env.ADMIN_KEY;
        else process.env.ADMIN_KEY = prevAdminKey2;
      }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminCrmChimeraAgentClearTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
