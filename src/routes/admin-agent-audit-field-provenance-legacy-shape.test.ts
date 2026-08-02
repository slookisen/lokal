/**
 * admin-agent-audit-field-provenance-legacy-shape.test.ts — unit tests for
 * GET /admin/agent-audit/field-provenance-legacy-shape
 * (src/routes/admin-agent-audit.ts).
 *
 * dev-request 2026-07-19-field-provenance-legacy-shape-audit: after lokal
 * PR #298 fixed mergeFieldProvenance() (src/routes/admin-knowledge.ts) so a
 * field already stored in the legacy wrapped `{ sources: [...] }` shape is
 * unwrapped-and-preserved on the next merge instead of silently wiped to
 * `[]`, the independent code-reviewer on that PR recommended checking
 * whether any OTHER rows already hold that shape from before the fix. This
 * read-only endpoint scans both tables that carry a field_provenance
 * column — agent_knowledge (rfb) and dental_agents (dental) — and reports
 * every (table, id, field) still in the wrapped shape. It never writes.
 *
 * Setup: rfb side mirrors admin-agents-category-sanity-report.test.ts
 * (fresh in-memory DB via __setDbForTesting/__initSchemaForTesting on
 * src/database/init.ts); dental side mirrors
 * dental-agent-put-field-provenance.test.ts (DENTAL_DB_PATH=":memory:" +
 * db-factory.__resetDbFactoryForTesting(), fresh require of db-factory so
 * getDb("dental") opens a throwaway schema). The route itself is exercised
 * via router.handle() (not a plucked single handler) since the route is
 * wired behind the `requireAdmin` Express-middleware form used in this
 * file (unlike admin-agents.ts's inline boolean-check form).
 *
 * Covers:
 *   1. A field stored as `{ sources: [...] }` (wrapped) -> flagged.
 *   2. A field stored as a bare array (on-disk shape) -> NOT flagged.
 *   3. A row with one wrapped field and one bare-array field -> only the
 *      wrapped field is flagged, the bare one is not.
 *   4. field_provenance = NULL / '{}' -> excluded from findings, but still
 *      counted in the table's `scanned` total.
 *   5. Malformed/non-JSON field_provenance -> excluded, no throw, 200.
 *   6. dental_agents wrapped field is flagged with table: "dental_agents".
 *   7. Missing/wrong X-Admin-Key -> 403.
 *   8. Read-only: repeated calls make zero DB writes on either table.
 */

import Database from "better-sqlite3";

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
  opts: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
  },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: opts.method || "GET",
      url: opts.path,
      originalUrl: opts.path,
      path: opts.path,
      params: {},
      query: opts.query || {},
      headers: opts.headers || {},
      get(name: string) {
        return this.headers[name.toLowerCase()];
      },
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
      else resolve({ status: res.statusCode, body: res.body });
    });
  });
}

export async function runAdminAgentAuditFieldProvenanceLegacyShapeTests(
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

  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const prevDentalPath = process.env.DENTAL_DB_PATH;
  const testKey = process.env.ADMIN_KEY || "field-provenance-legacy-shape-test-key";

  const {
    __setDbForTesting,
    __initSchemaForTesting,
    __peekDbForTesting,
    getDb: getRfbDb,
  } = require("../database/init") as typeof import("../database/init");
  const prevRfbDb = __peekDbForTesting();

  const rfbTestDb = new Database(":memory:");
  rfbTestDb.pragma("journal_mode = DELETE");
  rfbTestDb.pragma("foreign_keys = OFF");

  process.env.ADMIN_KEY = testKey;
  delete process.env.ANALYTICS_ADMIN_KEY;
  process.env.DENTAL_DB_PATH = ":memory:";

  const dbFactoryPath = require.resolve("../database/db-factory");
  const routePath = require.resolve("../routes/admin-agent-audit");
  delete require.cache[dbFactoryPath];
  delete require.cache[routePath];

  try {
    __setDbForTesting(rfbTestDb as any);
    __initSchemaForTesting(rfbTestDb as any);

    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const dentalDb = dbFactory.getDb("dental");

    // ── rfb fixtures (agent_knowledge) ──────────────────────────────────
    const insertKnowledge = rfbTestDb.prepare(
      `INSERT INTO agent_knowledge (agent_id, field_provenance) VALUES (@agent_id, @field_provenance)`,
    );

    // (1) wrapped shape on `phone` -> flagged.
    insertKnowledge.run({
      agent_id: "rfb-wrapped",
      field_provenance: JSON.stringify({
        phone: { sources: [{ source_type: "google_places", value: "12345678", fetched_at: "2026-07-01T00:00:00.000Z" }] },
      }),
    });

    // (2) bare-array (on-disk) shape -> NOT flagged.
    insertKnowledge.run({
      agent_id: "rfb-bare-array",
      field_provenance: JSON.stringify({
        phone: [{ source_type: "google_places", value: "87654321", fetched_at: "2026-07-01T00:00:00.000Z" }],
      }),
    });

    // (3) one wrapped field + one bare field on the same row -> only the
    // wrapped one is flagged.
    insertKnowledge.run({
      agent_id: "rfb-mixed",
      field_provenance: JSON.stringify({
        address: { sources: [{ source_type: "brreg", value: "Gate 1", fetched_at: "2026-07-01T00:00:00.000Z" }] },
        about: [{ source_type: "homepage", value: "En gård.", fetched_at: "2026-07-01T00:00:00.000Z" }],
      }),
    });

    // (4a) column left at its schema default ('{}', NOT NULL) -> excluded
    // from findings, still counted.
    rfbTestDb.prepare(`INSERT INTO agent_knowledge (agent_id) VALUES (?)`).run("rfb-default-prov");

    // (4b) explicit '{}' field_provenance -> excluded from findings, still counted.
    insertKnowledge.run({ agent_id: "rfb-empty-prov", field_provenance: "{}" });

    // (5) malformed JSON -> excluded, no throw.
    insertKnowledge.run({ agent_id: "rfb-junk-prov", field_provenance: "{not valid json" });

    // ── dental fixtures (dental_agents) ─────────────────────────────────
    const insertDental = dentalDb.prepare(
      `INSERT INTO dental_agents (id, navn, field_provenance) VALUES (@id, @navn, @field_provenance)`,
    );

    // (6) wrapped shape on `epost` -> flagged, table = dental_agents.
    insertDental.run({
      id: "dental-wrapped",
      navn: "Wrapped Tannlege AS",
      field_provenance: JSON.stringify({
        epost: { sources: [{ source_type: "hjemmeside_scrape", value: "post@example.no", fetched_at: "2026-07-01T00:00:00.000Z" }] },
      }),
    });

    // bare-array dental row -> NOT flagged.
    insertDental.run({
      id: "dental-bare-array",
      navn: "Normal Tannlege AS",
      field_provenance: JSON.stringify({
        telefon: [{ source_type: "hjemmeside_scrape", value: "12121212", fetched_at: "2026-07-01T00:00:00.000Z" }],
      }),
    });

    const auditRouter = (require("../routes/admin-agent-audit") as typeof import("../routes/admin-agent-audit"))
      .default as any;

    // ── (7) auth ─────────────────────────────────────────────────────────
    {
      const noKey = await callRoute(auditRouter, { path: "/field-provenance-legacy-shape" });
      assertEq(noKey.status, 401, "auth: GET without X-Admin-Key -> 401");
      const wrongKey = await callRoute(auditRouter, {
        path: "/field-provenance-legacy-shape",
        headers: { "x-admin-key": "wrong" },
      });
      assertEq(wrongKey.status, 401, "auth: GET with wrong X-Admin-Key -> 401");
    }

    // ── main run ─────────────────────────────────────────────────────────
    const r = await callRoute(auditRouter, {
      path: "/field-provenance-legacy-shape",
      headers: { "x-admin-key": testKey },
    });
    assertEq(r.status, 200, "main: GET with valid key -> 200");
    assertEq(r.body?.success, true, "main: success=true");

    // (4) scanned totals — ALL rows in each table, regardless of shape.
    assertEq(r.body?.scanned?.agent_knowledge, 6, "scanned: agent_knowledge counts all 6 inserted rfb rows");
    assertEq(r.body?.scanned?.dental_agents, 2, "scanned: dental_agents counts both inserted dental rows");

    const findings: Array<{ table: string; id: string; field: string }> = r.body?.findings ?? [];
    const key = (f: { table: string; id: string; field: string }) => `${f.table}/${f.id}/${f.field}`;
    const foundKeys = findings.map(key);

    // (1)
    assertTrue(foundKeys.includes("agent_knowledge/rfb-wrapped/phone"), "1: rfb-wrapped/phone flagged");
    // (2)
    assertTrue(!foundKeys.includes("agent_knowledge/rfb-bare-array/phone"), "2: rfb-bare-array/phone NOT flagged");
    // (3)
    assertTrue(foundKeys.includes("agent_knowledge/rfb-mixed/address"), "3a: rfb-mixed/address (wrapped) flagged");
    assertTrue(!foundKeys.includes("agent_knowledge/rfb-mixed/about"), "3b: rfb-mixed/about (bare array) NOT flagged");
    // (4) default / empty-object rows never produce a finding, no throw.
    assertTrue(!findings.some((f) => f.id === "rfb-default-prov"), "4a: rfb-default-prov produces no finding");
    assertTrue(!findings.some((f) => f.id === "rfb-empty-prov"), "4b: rfb-empty-prov produces no finding");
    // (5) malformed JSON tolerated.
    assertTrue(!findings.some((f) => f.id === "rfb-junk-prov"), "5: malformed field_provenance excluded, no throw");
    // (6) dental table flagged with correct table name.
    assertTrue(foundKeys.includes("dental_agents/dental-wrapped/epost"), "6a: dental-wrapped/epost flagged, table=dental_agents");
    assertTrue(!foundKeys.includes("dental_agents/dental-bare-array/telefon"), "6b: dental-bare-array/telefon NOT flagged");

    assertEq(r.body?.wrapped_shape_count, findings.length, "wrapped_shape_count matches findings.length");
    assertEq(r.body?.wrapped_shape_count, 3, "wrapped_shape_count is exactly 3 (rfb-wrapped, rfb-mixed, dental-wrapped)");

    // ── (8) read-only: zero writes on either table ──────────────────────
    const rfbBefore = rfbTestDb.prepare("SELECT agent_id, field_provenance FROM agent_knowledge ORDER BY agent_id").all();
    const dentalBefore = dentalDb.prepare("SELECT id, field_provenance FROM dental_agents ORDER BY id").all();
    await callRoute(auditRouter, { path: "/field-provenance-legacy-shape", headers: { "x-admin-key": testKey } });
    const rfbAfter = rfbTestDb.prepare("SELECT agent_id, field_provenance FROM agent_knowledge ORDER BY agent_id").all();
    const dentalAfter = dentalDb.prepare("SELECT id, field_provenance FROM dental_agents ORDER BY id").all();
    assertEq(rfbAfter, rfbBefore, "read-only: agent_knowledge byte-identical after repeated GET");
    assertEq(dentalAfter, dentalBefore, "read-only: dental_agents byte-identical after repeated GET");
  } catch (err) {
    failed++;
    failures.push(
      `field-provenance-legacy-shape: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`,
    );
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
    else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    if (prevRfbDb) __setDbForTesting(prevRfbDb);
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
    } catch {
      /* ignore */
    }
    try {
      delete require.cache[require.resolve("../routes/admin-agent-audit")];
    } catch {
      /* ignore */
    }
    try {
      delete require.cache[require.resolve("../database/db-factory")];
    } catch {
      /* ignore */
    }
    rfbTestDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/admin-agent-audit-field-provenance-legacy-shape.test.ts`
if (require.main === module) {
  console.log(
    "── admin-agent-audit field-provenance-legacy-shape (dev-request 2026-07-19-field-provenance-legacy-shape-audit) unit tests ──",
  );
  runAdminAgentAuditFieldProvenanceLegacyShapeTests({ log: true }).then((r) => {
    console.log(`\nfield-provenance-legacy-shape: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
