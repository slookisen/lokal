/**
 * admin-db-table-sizes.test.ts — tests for the read-only DB table-size
 * diagnostic (GET /admin/db/table-sizes), added 2026-07-03 as Step 1 of
 * dev-requests/2026-06-30-platform-housekeeping-audit.md.
 *
 * Mirrors bm-events-scrape-job.test.ts:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (full prod-like schema, so dbstat/sqlite_master
 *     reflect the real table set).
 *   - the previous global db handle is saved/restored so this test never
 *     leaves the module-level singleton swapped for later blocks.
 *   - the router is exercised directly (no HTTP server / supertest — this
 *     repo's convention, see the pr68/pr94 blocks in tests/test.ts): build a
 *     minimal req/res pair and call `router.handle(req, res, next)`.
 *   - exported runAdminDbTableSizesTests({log}) → TestSummary; wired into
 *     tests/test.ts. Standalone: npx tsx src/routes/admin-db-table-sizes.test.ts
 *
 * Covers:
 *   (a) 403 without X-Admin-Key
 *   (b) 200 with valid key → tables[] sorted descending by bytes, includes
 *       the fixture tables with correct row_count
 *   (c) total_bytes / total_mb present and sane
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
  opts: { headers?: Record<string, string> } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: "GET",
      url: "/table-sizes",
      query: {},
      headers: opts.headers || {},
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runAdminDbTableSizesTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const testKey = "admin-db-table-sizes-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      // Fixture rows in two real, prod-schema tables so we have known,
      // non-zero row counts to assert against.
      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', 'https://example.com', 'producer', ?)`,
      );
      insertAgent.run("agent-1", "Test Gård 1", "key-1");
      insertAgent.run("agent-2", "Test Gård 2", "key-2");
      insertAgent.run("agent-3", "Test Gård 3", "key-3");

      const insertRun = db.prepare(
        `INSERT INTO runs (run_id, vertical, agent, trigger_source, started_at, finished_at, status)
         VALUES (?, 'rfb', 'marketing', 'cron', '2026-07-01T00:00:00Z', '2026-07-01T00:05:00Z', 'completed')`,
      );
      insertRun.run("run-fixture-1");

      // Fresh require of the router module for a clean handler binding
      // (the module has no per-request state, so a plain require is fine).
      delete require.cache[require.resolve("./admin-db-table-sizes")];
      const router = require("./admin-db-table-sizes").default;

      // ── (a) 403 without X-Admin-Key ─────────────────────────────
      const noKey = await callRoute(router, {});
      assertEq(noKey.status, 403, "no-key: GET /table-sizes without X-Admin-Key -> 403");
      assertTrue(!noKey.body?.success, "no-key: response is not a success payload");

      // ── (b)/(c) 200 with valid key ──────────────────────────────
      const ok = await callRoute(router, { headers: { "x-admin-key": testKey } });
      assertEq(ok.status, 200, "with-key: GET /table-sizes -> 200");
      assertEq(ok.body?.success, true, "with-key: success=true");

      assertTrue(typeof ok.body?.total_bytes === "number" && ok.body.total_bytes > 0,
        "with-key: total_bytes is a positive number");
      assertTrue(typeof ok.body?.total_mb === "number" && ok.body.total_mb > 0,
        "with-key: total_mb is a positive number");
      assertTrue(typeof ok.body?.generated_at === "string" && !isNaN(Date.parse(ok.body.generated_at)),
        "with-key: generated_at is a parseable ISO timestamp");

      assertTrue(Array.isArray(ok.body?.tables), "with-key: tables is an array");
      const tables: any[] = ok.body.tables;
      assertTrue(tables.length > 0, "with-key: tables is non-empty");

      // Sorted descending by bytes.
      let sortedDesc = true;
      for (let i = 1; i < tables.length; i++) {
        if (tables[i].bytes > tables[i - 1].bytes) { sortedDesc = false; break; }
      }
      assertTrue(sortedDesc, "with-key: tables sorted descending by bytes");

      // Every row has the documented shape.
      const shapeOk = tables.every(
        (t) =>
          typeof t.name === "string" &&
          (t.type === "table" || t.type === "index") &&
          typeof t.bytes === "number" &&
          typeof t.mb === "number" &&
          typeof t.pages === "number" &&
          (t.type === "table" ? typeof t.row_count === "number" : t.row_count === null),
      );
      assertTrue(shapeOk, "with-key: every table entry matches { name, type, bytes, mb, pages, row_count }");

      // Fixture tables present with the right label + row counts.
      const agentsRow = tables.find((t) => t.name === "agents");
      assertTrue(!!agentsRow, "with-key: 'agents' table present in output");
      assertEq(agentsRow?.type, "table", "with-key: 'agents' labeled as type=table");
      assertEq(agentsRow?.row_count, 3, "with-key: 'agents' row_count reflects the 3 fixture rows");

      const runsRow = tables.find((t) => t.name === "runs");
      assertTrue(!!runsRow, "with-key: 'runs' table present in output");
      assertEq(runsRow?.row_count, 1, "with-key: 'runs' row_count reflects the 1 fixture row");

      // At least one index is present and correctly labeled (dbstat includes
      // btrees for indexes too — this is what distinguishes 'table' vs 'index').
      const anyIndex = tables.find((t) => t.type === "index");
      assertTrue(!!anyIndex, "with-key: at least one index row present, labeled type=index");
      assertTrue(anyIndex?.row_count === null, "with-key: index rows have row_count=null");
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      db.close();
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/admin-db-table-sizes.test.ts`
if (require.main === module) {
  runAdminDbTableSizesTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
