/**
 * admin-knowledge-truncation-sweep.test.ts — dev-request
 * 2026-07-01-cs-corrections-profile-quality item C: catalog-wide
 * `agents.description` truncation sweep.
 *
 * Covers GET/POST /admin/description-truncation-sweep (src/routes/
 * admin-knowledge.ts, descriptionTruncationSweepRouter):
 *   (a) GET without X-Admin-Key -> 403, and issues no DB write.
 *   (b) GET with a valid key -> read-only diagnostic report: finds every row
 *       whose description still carries "�", each with an id/name/snippet,
 *       and leaves clean rows out of the report entirely.
 *   (c) POST with dry_run unset (default) -> reports the same candidates +
 *       a preview of the cleaned value, but makes ZERO DB writes (asserted
 *       by re-reading the corrupted row's description straight from the DB
 *       afterwards — still corrupted).
 *   (d) POST with dry_run explicitly true -> same as (c), still no writes.
 *   (e) POST with dry_run:false (apply) -> cleans exactly the corrupted
 *       row(s), leaves the clean row's description byte-for-byte untouched
 *       (no UPDATE issued against it — verified via a wrapped db.prepare
 *       call counter scoped to the UPDATE statement), and a trailing "�" +
 *       broken word fragment is repaired the same way safeMetaDescription()
 *       repairs it at render time (same function, reused not duplicated).
 *   (f) A second apply run over the now-clean catalog updates nothing
 *       (idempotent — no row still contains "�").
 *
 * Mirrors src/routes/admin-db-table-sizes.test.ts's pattern: in-memory
 * better-sqlite3 DB injected via __setDbForTesting + __initSchemaForTesting
 * (full prod-like schema), the router exercised directly (no HTTP server),
 * and a fresh require of the router module for a clean handler binding.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/admin-knowledge-truncation-sweep.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runDescriptionTruncationSweepTests() and folds its pass/fail counts
 *      into the `npm test` summary.
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
  method: string,
  url: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: opts.headers || {},
      body: opts.body,
      get() {
        return undefined;
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
    });
  });
}

export function runDescriptionTruncationSweepTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const testKey = "admin-truncation-sweep-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    const db = new Database(":memory:");
    const originalPrepare = db.prepare.bind(db);
    let updateCalls = 0;
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      // ── Fixture rows ─────────────────────────────────────────────────
      // 1. Corrupted: trailing replacement-char run + broken word fragment
      //    (the exact reported shape — "...opplevelser p�").
      // 2. Clean: no "�" anywhere — must be left completely untouched.
      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES (?, ?, ?, 'test', 'x@example.com', 'https://example.com', 'producer', ?)`,
      );
      const corruptedDescription = "Gårdsbutikk med lokale råvarer og opplevelser p�";
      const cleanDescription = "Gårdsbutikk med lokale råvarer, ost og egg.";
      insertAgent.run("agent-corrupt-1", "Corrupt Gård", corruptedDescription, "key-corrupt-1");
      insertAgent.run("agent-clean-1", "Clean Gård", cleanDescription, "key-clean-1");

      // Fresh require of the router module for a clean handler binding.
      delete require.cache[require.resolve("./admin-knowledge")];
      const adminKnowledgeMod = require("./admin-knowledge");
      const router = adminKnowledgeMod.descriptionTruncationSweepRouter;
      assertTrue(!!router, "setup: descriptionTruncationSweepRouter is exported");

      // Spy on the UPDATE statement's .run() specifically (not .prepare(),
      // which the route calls unconditionally whether or not there turn out
      // to be any candidate rows) so writes-vs-no-writes is asserted
      // precisely — not just "row changed", which trailing-fixture drift
      // could otherwise mask.
      (db as any).prepare = (sql: string, ...rest: any[]) => {
        const stmt = originalPrepare(sql, ...rest);
        if (/UPDATE agents SET description/.test(sql)) {
          const originalRun = stmt.run.bind(stmt);
          stmt.run = (...runArgs: any[]) => {
            updateCalls++;
            return originalRun(...runArgs);
          };
        }
        return stmt;
      };

      // ── (a) GET without X-Admin-Key -> 403, no write ────────────────
      updateCalls = 0;
      const noKey = await callRoute(router, "GET", "/description-truncation-sweep", {});
      assertEq(noKey.status, 403, "no-key: GET without X-Admin-Key -> 403");
      assertTrue(!noKey.body?.success, "no-key: response is not a success payload");
      assertEq(updateCalls, 0, "no-key: no UPDATE issued");

      // ── (b) GET with valid key -> diagnostic report ─────────────────
      const diag = await callRoute(router, "GET", "/description-truncation-sweep", {
        headers: { "x-admin-key": testKey },
      });
      assertEq(diag.status, 200, "diag: GET with valid key -> 200");
      assertEq(diag.body?.success, true, "diag: success=true");
      assertEq(diag.body?.corrupted_count, 1, "diag: exactly 1 corrupted row found");
      assertTrue(Array.isArray(diag.body?.rows), "diag: rows is an array");
      assertEq(diag.body.rows.length, 1, "diag: rows array has exactly 1 entry");
      assertEq(diag.body.rows[0]?.id, "agent-corrupt-1", "diag: reports the corrupted row's id");
      assertEq(diag.body.rows[0]?.name, "Corrupt Gård", "diag: reports the corrupted row's name");
      assertTrue(
        typeof diag.body.rows[0]?.snippet === "string" && diag.body.rows[0].snippet.includes("�"),
        "diag: snippet includes the corruption marker for review",
      );
      assertTrue(
        !diag.body.rows.some((r: any) => r.id === "agent-clean-1"),
        "diag: the clean row is NOT included in the report",
      );
      assertEq(updateCalls, 0, "diag: GET issues no UPDATE (read-only)");

      // ── (c) POST, dry_run unset (default) -> report only, no writes ──
      updateCalls = 0;
      const dryDefault = await callRoute(router, "POST", "/description-truncation-sweep", {
        headers: { "x-admin-key": testKey },
        body: {},
      });
      assertEq(dryDefault.status, 200, "dry-default: POST with no body -> 200");
      assertEq(dryDefault.body?.dry_run, true, "dry-default: dry_run reported true");
      assertEq(dryDefault.body?.would_update_count, 1, "dry-default: would_update_count is 1");
      assertEq(dryDefault.body?.would_update?.[0]?.id, "agent-corrupt-1", "dry-default: previews the corrupted row");
      assertTrue(
        typeof dryDefault.body?.would_update?.[0]?.after === "string" &&
          !dryDefault.body.would_update[0].after.includes("�"),
        "dry-default: preview 'after' value has the corruption marker removed",
      );
      assertEq(updateCalls, 0, "dry-default: no UPDATE issued (dry-run default)");

      const rowAfterDryDefault = db
        .prepare("SELECT description FROM agents WHERE id = ?")
        .get("agent-corrupt-1") as { description: string };
      assertEq(
        rowAfterDryDefault.description,
        corruptedDescription,
        "dry-default: corrupted row's description is untouched in the DB",
      );

      // ── (d) POST, dry_run explicitly true -> same as (c) ────────────
      updateCalls = 0;
      const dryExplicit = await callRoute(router, "POST", "/description-truncation-sweep", {
        headers: { "x-admin-key": testKey },
        body: { dry_run: true },
      });
      assertEq(dryExplicit.body?.dry_run, true, "dry-explicit: dry_run:true honored");
      assertEq(updateCalls, 0, "dry-explicit: no UPDATE issued");

      // ── (e) POST, dry_run:false (apply) -> cleans exactly the corrupted row ──
      updateCalls = 0;
      const apply = await callRoute(router, "POST", "/description-truncation-sweep", {
        headers: { "x-admin-key": testKey },
        body: { dry_run: false },
      });
      assertEq(apply.status, 200, "apply: POST dry_run:false -> 200");
      assertEq(apply.body?.dry_run, false, "apply: dry_run reported false");
      assertEq(apply.body?.updated_count, 1, "apply: updated_count is exactly 1");
      assertEq(apply.body?.updated_ids, ["agent-corrupt-1"], "apply: updated_ids lists exactly the corrupted row");
      assertEq(updateCalls, 1, "apply: exactly ONE UPDATE statement issued (only the corrupted row, never the clean one)");

      const corruptRowAfter = db
        .prepare("SELECT description FROM agents WHERE id = ?")
        .get("agent-corrupt-1") as { description: string };
      assertTrue(
        !corruptRowAfter.description.includes("�"),
        "apply: corrupted row's description no longer contains the replacement char",
      );
      assertTrue(
        corruptRowAfter.description.startsWith("Gårdsbutikk med lokale råvarer"),
        "apply: the repaired description keeps the leading, unbroken text",
      );
      assertTrue(corruptRowAfter.description.length > 0, "apply: repaired description is non-empty");

      const cleanRowAfter = db
        .prepare("SELECT description FROM agents WHERE id = ?")
        .get("agent-clean-1") as { description: string };
      assertEq(
        cleanRowAfter.description,
        cleanDescription,
        "apply: the clean row's description is byte-for-byte untouched",
      );

      // ── (f) idempotent: a second apply run over the now-clean catalog updates nothing ──
      updateCalls = 0;
      const applyAgain = await callRoute(router, "POST", "/description-truncation-sweep", {
        headers: { "x-admin-key": testKey },
        body: { dry_run: false },
      });
      assertEq(applyAgain.body?.updated_count, 0, "idempotent: second apply run finds nothing left to fix");
      assertEq(applyAgain.body?.scanned, 0, "idempotent: second apply run scans zero candidate rows");
      assertEq(updateCalls, 0, "idempotent: second apply run issues no UPDATE");

      // ── diagnostic now reports zero corrupted rows ───────────────────
      const diagAfter = await callRoute(router, "GET", "/description-truncation-sweep", {
        headers: { "x-admin-key": testKey },
      });
      assertEq(diagAfter.body?.corrupted_count, 0, "post-apply: diagnostic finds no corrupted rows left");
    } finally {
      (db as any).prepare = originalPrepare;
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      db.close();
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/admin-knowledge-truncation-sweep.test.ts`
if (require.main === module) {
  runDescriptionTruncationSweepTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
