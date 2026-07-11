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
      // 3. Unrepairable: corruption markers start-to-finish — safeMetaDescription()
      //    cleans this to "". Applying must NOT blank a live description; it
      //    must skip the write and leave the row flagged for manual review.
      const unrepairableDescription = "���";
      insertAgent.run("agent-corrupt-1", "Corrupt Gård", corruptedDescription, "key-corrupt-1");
      insertAgent.run("agent-clean-1", "Clean Gård", cleanDescription, "key-clean-1");
      insertAgent.run("agent-unrepairable-1", "Unrepairable Gård", unrepairableDescription, "key-unrepair-1");

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
      assertEq(diag.body?.corrupted_count, 2, "diag: exactly 2 corrupted rows found (repairable + unrepairable)");
      assertTrue(Array.isArray(diag.body?.rows), "diag: rows is an array");
      assertEq(diag.body.rows.length, 2, "diag: rows array has exactly 2 entries");
      const diagRow = diag.body.rows.find((r: any) => r.id === "agent-corrupt-1");
      assertTrue(!!diagRow, "diag: reports the corrupted row's id");
      assertEq(diagRow?.name, "Corrupt Gård", "diag: reports the corrupted row's name");
      assertTrue(
        typeof diagRow?.snippet === "string" && diagRow.snippet.includes("�"),
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
      assertEq(dryDefault.body?.would_update_count, 2, "dry-default: would_update_count is 2 (repairable + unrepairable previewed)");
      const previewCorrupt = dryDefault.body?.would_update?.find((r: any) => r.id === "agent-corrupt-1");
      assertTrue(!!previewCorrupt, "dry-default: previews the repairable row");
      assertTrue(
        typeof previewCorrupt?.after === "string" && !previewCorrupt.after.includes("�"),
        "dry-default: preview 'after' value has the corruption marker removed",
      );
      const previewUnrepairable = dryDefault.body?.would_update?.find((r: any) => r.id === "agent-unrepairable-1");
      assertEq(previewUnrepairable?.after, "", "dry-default: unrepairable row previews as cleaning to an empty string");
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
      assertEq(apply.body?.scanned, 2, "apply: scanned is 2 (both flagged rows)");
      assertEq(apply.body?.updated_count, 1, "apply: updated_count is exactly 1 (only the repairable row)");
      assertEq(apply.body?.updated_ids, ["agent-corrupt-1"], "apply: updated_ids lists exactly the repairable row");
      assertEq(apply.body?.unrepairable_count, 1, "apply: unrepairable_count is 1");
      assertEq(apply.body?.unrepairable_ids, ["agent-unrepairable-1"], "apply: unrepairable_ids lists the row that cleans to empty");
      assertEq(updateCalls, 1, "apply: exactly ONE UPDATE statement issued (repairable row only — never the clean row, never the unrepairable one)");

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

      const unrepairableRowAfter = db
        .prepare("SELECT description FROM agents WHERE id = ?")
        .get("agent-unrepairable-1") as { description: string };
      assertEq(
        unrepairableRowAfter.description,
        unrepairableDescription,
        "apply: the unrepairable row's description is NOT blanked — left exactly as-is for manual review",
      );

      // ── (f) idempotent: a second apply run over the now-mostly-clean catalog
      //      updates nothing new — the unrepairable row stays flagged by
      //      design (it never gets silently blanked or dropped from view) ──
      updateCalls = 0;
      const applyAgain = await callRoute(router, "POST", "/description-truncation-sweep", {
        headers: { "x-admin-key": testKey },
        body: { dry_run: false },
      });
      assertEq(applyAgain.body?.updated_count, 0, "idempotent: second apply run fixes nothing new");
      assertEq(applyAgain.body?.scanned, 1, "idempotent: second apply run still scans the 1 unrepairable row");
      assertEq(applyAgain.body?.unrepairable_count, 1, "idempotent: unrepairable row still reported every run");
      assertEq(updateCalls, 0, "idempotent: second apply run issues no UPDATE");

      // ── diagnostic still reports the 1 unrepairable row (by design) ──
      const diagAfter = await callRoute(router, "GET", "/description-truncation-sweep", {
        headers: { "x-admin-key": testKey },
      });
      assertEq(diagAfter.body?.corrupted_count, 1, "post-apply: diagnostic still flags the 1 unrepairable row");
      assertEq(diagAfter.body?.rows?.[0]?.id, "agent-unrepairable-1", "post-apply: the flagged row is the unrepairable one");
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
