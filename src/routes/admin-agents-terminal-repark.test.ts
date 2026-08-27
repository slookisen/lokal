/**
 * admin-agents-terminal-repark.test.ts — tests for
 * POST /admin/agents/terminal-repark (dev-request
 * 2026-08-25-terminal-sweep-false-positives, Daniel-GO 2026-08-25
 * "GO for masseparkering").
 *
 * A categorical correction lever (own internal scan, unlike
 * admin-agents-deactivate.ts which never scans): flips agent_knowledge
 * rows wrongly stuck at verification_status='terminal_unconfirmable' by
 * the pre-#718 sweep bug (no-data treated as dead) back to
 * 'pending_verify', while leaving rows with a genuine terminal_reason
 * (brreg_konkurs / brreg_inactive / non_producer_entity) untouched.
 *
 * Setup: better-sqlite3 ":memory:" + __initSchemaForTesting, route pointed
 * at that DB through its own seam (__setTerminalReparkDbForTesting) — same
 * discipline as admin-agents-deactivate.test.ts: never pins the shared
 * getDb() singleton. Handler driven directly through router.handle() with a
 * fake req/res — no HTTP server.
 *
 * Covers:
 *   (a) auth gate (missing / wrong X-Admin-Key -> 403; unconfigured -> 503)
 *   (b) dry-run classifies all five reason-shapes correctly and writes
 *       NOTHING (verified via DB read-back)
 *   (c) apply: confirmed-dead / confirmed-non-producer rows untouched, no
 *       audit row; would_repark rows flipped to pending_verify with exactly
 *       one agent_knowledge_audit row each
 *   (d) a row not in terminal_unconfirmable status at all is never selected
 *       by the scan
 *   (e) the "no longer terminal by write time" race, covered directly via
 *       the pure classifyTerminalRow function (status changed between scan
 *       and write -> skipped_no_longer_terminal)
 *   (f) TERMINAL_REPARK_MAX_SCAN guardrail: apply=true refused with 400
 *       above the cap while dry-run still returns the full picture
 *   (g) pure helpers: parseTerminalReason, classifyTerminalRow
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
    body?: any;
    query?: Record<string, string>;
  },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "POST",
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

export function runAdminAgentsTerminalReparkTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    // SHARED-GLOBAL DISCIPLINE (tests/test.ts, "SHARED GLOBAL STATE"): never
    // reassign process.env.ADMIN_KEY — read whatever key is already in
    // effect and send that. Only set one ourselves (and restore in finally)
    // when none exists at all (this file run standalone).
    const ambientKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
    const setKeyOurselves = ambientKey === "";
    if (setKeyOurselves) process.env.ADMIN_KEY = "admin-agents-terminal-repark-standalone-key";
    const testKey = process.env.ADMIN_KEY as string;

    const db = new Database(":memory:");
    try {
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES (?, ?, 'test agent', 'test', '', 'https://example.no', 'producer', ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, verification_status, verification_review_reason) VALUES (?, ?, ?)`,
      );

      // ── Fixtures ──────────────────────────────────────────────────────
      // (a) confirmed dead via brreg_konkurs -> skipped_confirmed_dead
      insertAgent.run("tr-1", "Konkurs Gaard AS", "key-tr-1");
      insertKnowledge.run("tr-1", "terminal_unconfirmable", JSON.stringify({ terminal_reason: "brreg_konkurs" }));

      // (b) confirmed dead via brreg_inactive -> skipped_confirmed_dead
      insertAgent.run("tr-2", "Inaktiv Gaard AS", "key-tr-2");
      insertKnowledge.run("tr-2", "terminal_unconfirmable", JSON.stringify({ terminal_reason: "brreg_inactive" }));

      // (c) confirmed non-producer -> skipped_non_producer
      insertAgent.run("tr-3", "Kommune Servicekontor", "key-tr-3");
      insertKnowledge.run("tr-3", "terminal_unconfirmable", JSON.stringify({ terminal_reason: "non_producer_entity" }));

      // (d) legacy pre-#718 row, no terminal_reason key at all -> would_repark
      insertAgent.run("tr-4", "Ekte Gardsbutikk AS", "key-tr-4");
      insertKnowledge.run("tr-4", "terminal_unconfirmable", JSON.stringify({ some_other_key: true }));

      // (e) legacy zero_identity_sources value -> would_repark
      insertAgent.run("tr-5", "Liten Gard DA", "key-tr-5");
      insertKnowledge.run("tr-5", "terminal_unconfirmable", JSON.stringify({ terminal_reason: "zero_identity_sources" }));

      // (f) not terminal at all -> must never be selected by the scan
      insertAgent.run("tr-6", "Verifisert Gard AS", "key-tr-6");
      insertKnowledge.run("tr-6", "verified", JSON.stringify({ terminal_reason: "brreg_konkurs" }));

      // (g) malformed JSON -> treated as {} -> would_repark
      insertAgent.run("tr-7", "Rar Json Gard AS", "key-tr-7");
      insertKnowledge.run("tr-7", "terminal_unconfirmable", "not json");

      delete require.cache[require.resolve("./admin-agents-terminal-repark")];
      const routeMod = require("./admin-agents-terminal-repark");
      const router = routeMod.default;
      routeMod.__setTerminalReparkDbForTesting(db as any);

      function post(body: any, key: string | false = testKey, query?: Record<string, string>): Promise<RouteResult> {
        const headers: Record<string, string> = {};
        if (key !== false) headers["x-admin-key"] = key;
        return callRoute(router, { method: "POST", url: "/", headers, body, query });
      }

      function knowledgeRow(id: string) {
        return db
          .prepare(`SELECT verification_status, verification_review_reason FROM agent_knowledge WHERE agent_id = ?`)
          .get(id) as { verification_status: string; verification_review_reason: string } | undefined;
      }
      function auditFor(id: string) {
        return db
          .prepare(
            `SELECT field_name, old_value, new_value, changed_by, notes
               FROM agent_knowledge_audit WHERE agent_id = ? ORDER BY changed_at, rowid`,
          )
          .all(id) as Array<{ field_name: string; old_value: string | null; new_value: string | null; changed_by: string; notes: string | null }>;
      }
      function resultFor(body: any, id: string) {
        return (body?.results ?? []).find((r: any) => r.agent_id === id);
      }

      // ── (a) auth gate ───────────────────────────────────────────────────
      let r = await post({});
      // (sanity: with an ambient/standalone key configured this must NOT be 503)
      assertTrue(r.status !== 503, "tr-00: admin key is configured for this run");
      r = await post({}, false);
      assertEq(r.status, 403, "tr-01: missing X-Admin-Key -> 403");
      r = await post({}, "wrong-key");
      assertEq(r.status, 403, "tr-02: wrong X-Admin-Key -> 403");

      // ── unconfigured admin key -> 503 ───────────────────────────────────
      // requireAdmin() reads process.env fresh on every request (not at
      // module-load time), so this only needs to blank the env vars around
      // one call to the already-required router — no require.cache dance
      // needed, and the seam/DB binding above is left completely untouched.
      {
        const savedAdmin = process.env.ADMIN_KEY;
        const savedAnalytics = process.env.ANALYTICS_ADMIN_KEY;
        delete process.env.ADMIN_KEY;
        delete process.env.ANALYTICS_ADMIN_KEY;
        const rr = await callRoute(router, { method: "POST", url: "/", headers: {}, body: {} });
        assertEq(rr.status, 503, "tr-03: no admin key configured at all -> 503");
        if (savedAdmin !== undefined) process.env.ADMIN_KEY = savedAdmin;
        if (savedAnalytics !== undefined) process.env.ANALYTICS_ADMIN_KEY = savedAnalytics;
      }

      // ── (b) dry-run: classification + zero writes ───────────────────────
      r = await post({});
      assertEq(r.body?.dry_run, true, "tr-04: dry-run by default");
      assertEq(r.body?.scanned, 6, "tr-05: scan finds exactly the 6 terminal_unconfirmable rows (not tr-6)");

      assertEq(resultFor(r.body, "tr-1")?.outcome, "skipped_confirmed_dead", "tr-06: brreg_konkurs -> skipped_confirmed_dead");
      assertEq(resultFor(r.body, "tr-2")?.outcome, "skipped_confirmed_dead", "tr-07: brreg_inactive -> skipped_confirmed_dead");
      assertEq(resultFor(r.body, "tr-3")?.outcome, "skipped_non_producer", "tr-08: non_producer_entity -> skipped_non_producer");
      assertEq(resultFor(r.body, "tr-4")?.outcome, "would_repark", "tr-09: no terminal_reason key -> would_repark");
      assertEq(resultFor(r.body, "tr-5")?.outcome, "would_repark", "tr-10: legacy zero_identity_sources -> would_repark");
      assertEq(resultFor(r.body, "tr-7")?.outcome, "would_repark", "tr-11: malformed JSON -> would_repark");
      assertEq(resultFor(r.body, "tr-6"), undefined, "tr-12: non-terminal row never appears in results");

      assertEq(r.body?.counts?.skipped_confirmed_dead, 2, "tr-13: counts.skipped_confirmed_dead = 2");
      assertEq(r.body?.counts?.skipped_non_producer, 1, "tr-14: counts.skipped_non_producer = 1");
      assertEq(r.body?.counts?.would_repark, 3, "tr-15: counts.would_repark = 3");

      // Zero writes anywhere.
      for (const id of ["tr-1", "tr-2", "tr-3", "tr-4", "tr-5", "tr-7"]) {
        assertEq(knowledgeRow(id)?.verification_status, "terminal_unconfirmable", `tr-16-${id}: dry-run left status unchanged`);
        assertEq(auditFor(id).length, 0, `tr-17-${id}: dry-run wrote no audit rows`);
      }

      // ── (c) apply: confirmed-dead/non-producer untouched, would_repark flipped ──
      r = await post({}, testKey, { apply: "1" });
      assertEq(r.body?.dry_run, false, "tr-18: apply=1 turns off dry-run");

      assertEq(resultFor(r.body, "tr-1")?.outcome, "skipped_confirmed_dead", "tr-19: apply also skips brreg_konkurs");
      assertEq(knowledgeRow("tr-1")?.verification_status, "terminal_unconfirmable", "tr-20: tr-1 status untouched");
      assertEq(auditFor("tr-1").length, 0, "tr-21: no audit row for tr-1");

      assertEq(resultFor(r.body, "tr-2")?.outcome, "skipped_confirmed_dead", "tr-22: apply also skips brreg_inactive");
      assertEq(knowledgeRow("tr-2")?.verification_status, "terminal_unconfirmable", "tr-23: tr-2 status untouched");
      assertEq(auditFor("tr-2").length, 0, "tr-24: no audit row for tr-2");

      assertEq(resultFor(r.body, "tr-3")?.outcome, "skipped_non_producer", "tr-25: apply also skips non_producer_entity");
      assertEq(knowledgeRow("tr-3")?.verification_status, "terminal_unconfirmable", "tr-26: tr-3 status untouched");
      assertEq(auditFor("tr-3").length, 0, "tr-27: no audit row for tr-3");

      for (const id of ["tr-4", "tr-5", "tr-7"]) {
        assertEq(resultFor(r.body, id)?.outcome, "reparked", `tr-28-${id}: reparked`);
        assertEq(knowledgeRow(id)?.verification_status, "pending_verify", `tr-29-${id}: status flipped to pending_verify`);
        const audit = auditFor(id);
        assertEq(audit.length, 1, `tr-30-${id}: exactly one audit row written`);
        assertEq(audit[0]?.field_name, "verification_status", `tr-31-${id}: audit field_name = verification_status`);
        assertEq(audit[0]?.old_value, "terminal_unconfirmable", `tr-32-${id}: audit old_value = terminal_unconfirmable`);
        assertEq(audit[0]?.new_value, "pending_verify", `tr-33-${id}: audit new_value = pending_verify`);
        assertEq(audit[0]?.changed_by, "system", `tr-34-${id}: audit changed_by = system`);
        assertTrue(
          (audit[0]?.notes ?? "").includes("masse-reparkering per Daniel-GO 2026-08-25"),
          `tr-35-${id}: audit notes cite the Daniel-GO reference`,
        );
      }
      assertTrue(
        (auditFor("tr-4")[0]?.notes ?? "").includes("terminal_reason=none"),
        "tr-36: tr-4 (no terminal_reason key) notes terminal_reason=none",
      );
      assertTrue(
        (auditFor("tr-5")[0]?.notes ?? "").includes("terminal_reason=zero_identity_sources"),
        "tr-37: tr-5 notes carry the legacy terminal_reason value",
      );

      // Idempotent re-apply: tr-1/2/3 stay terminal, tr-4/5/7 are no longer
      // terminal_unconfirmable so the second pass finds a smaller/emptier
      // would_repark cohort and does not double-write.
      r = await post({}, testKey, { apply: "1" });
      assertEq(r.body?.scanned, 3, "tr-38: second apply pass only re-scans the still-terminal rows");
      assertEq(auditFor("tr-4").length, 1, "tr-39: re-apply did not add a second audit row for tr-4");

      // ── (d) status-not-terminal row was never in scope ───────────────────
      assertEq(knowledgeRow("tr-6")?.verification_status, "verified", "tr-40: non-terminal row status untouched throughout");
      assertEq(auditFor("tr-6").length, 0, "tr-41: non-terminal row never audited");

      // ── (e) race: status changed between outer scan and write-time re-check ──
      // Covered directly against the pure classifyTerminalRow function,
      // which is exactly what the apply-time re-check calls against a fresh
      // read — this is the cleanest way to exercise that branch without
      // reaching into the route's private per-row transaction internals.
      assertEq(
        routeMod.classifyTerminalRow("pending_verify", JSON.stringify({ some_other_key: true })).outcome,
        "skipped_no_longer_terminal",
        "tr-42: status no longer terminal_unconfirmable by write time -> skipped_no_longer_terminal",
      );
      assertEq(
        routeMod.classifyTerminalRow("verified", null).outcome,
        "skipped_no_longer_terminal",
        "tr-43: status no longer terminal_unconfirmable (verified) -> skipped_no_longer_terminal",
      );

      // ── (f) TERMINAL_REPARK_MAX_SCAN guardrail ──────────────────────────
      {
        const capDb = new Database(":memory:");
        try {
          initMod.__initSchemaForTesting(capDb as any);
          const insertAgentCap = capDb.prepare(
            `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
             VALUES (?, ?, 'test agent', 'test', '', 'https://example.no', 'producer', ?)`,
          );
          const insertKnowledgeCap = capDb.prepare(
            `INSERT INTO agent_knowledge (agent_id, verification_status, verification_review_reason) VALUES (?, ?, ?)`,
          );
          const overCap = routeMod.TERMINAL_REPARK_MAX_SCAN + 1;
          for (let i = 0; i < overCap; i++) {
            insertAgentCap.run(`cap-${i}`, `Cap Test ${i} AS`, `key-cap-${i}`);
            insertKnowledgeCap.run(`cap-${i}`, "terminal_unconfirmable", "{}");
          }
          routeMod.__setTerminalReparkDbForTesting(capDb as any);

          let rr = await post({}, testKey, { apply: "1" });
          assertEq(rr.status, 400, "tr-44: over-cap cohort refuses apply=true with 400");

          rr = await post({});
          assertEq(rr.status, 200, "tr-45: over-cap cohort still allows dry-run");
          assertEq(rr.body?.scanned, overCap, "tr-46: dry-run above the cap still returns the full scanned count");
        } finally {
          routeMod.__setTerminalReparkDbForTesting(db as any);
          try {
            capDb.close();
          } catch {
            /* ignore */
          }
        }
      }

      // ── (g) pure helpers ──────────────────────────────────────────────
      assertEq(routeMod.parseTerminalReason(null), null, "tr-47: parseTerminalReason(null) -> null");
      assertEq(routeMod.parseTerminalReason("not json"), null, "tr-48: malformed JSON -> null");
      assertEq(routeMod.parseTerminalReason("{}"), null, "tr-49: empty object -> null");
      assertEq(
        routeMod.parseTerminalReason(JSON.stringify({ terminal_reason: "brreg_konkurs" })),
        "brreg_konkurs",
        "tr-50: extracts terminal_reason string",
      );
      assertEq(
        routeMod.parseTerminalReason(JSON.stringify({ terminal_reason: 123 })),
        null,
        "tr-51: non-string terminal_reason treated as absent",
      );
      assertEq(
        routeMod.classifyTerminalRow("terminal_unconfirmable", null).outcome,
        "would_repark",
        "tr-52: classifyTerminalRow with no review reason at all -> would_repark",
      );
    } finally {
      if (setKeyOurselves) delete process.env.ADMIN_KEY;
      try {
        const routeMod = require("./admin-agents-terminal-repark");
        routeMod.__setTerminalReparkDbForTesting(null);
      } catch {
        /* ignore */
      }
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }

    return { passed, failed, failures };
  })();
}
