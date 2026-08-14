/**
 * admin-agents-deactivate.test.ts — tests for POST /admin/agents/deactivate
 * (dev-request 2026-08-10-rfb-hjemmesidejakt-full-loype, Skive 8).
 *
 * One controlled admin lever that deactivates one or more STANDALONE
 * agents rows given an explicit caller-supplied {id, reason, evidence}
 * decision — is_active=0 only (merged_into untouched), row-lock on
 * claimed_at / any-truthy curated_fields key, reversible via
 * agent_knowledge_audit (old_value='1', new_value='0').
 *
 * Setup: better-sqlite3 ":memory:" + __initSchemaForTesting, route pointed
 * at that DB through its own seam (__setAgentDeactivateDbForTesting) — same
 * discipline as admin-agents-duplicate-merge.test.ts: never pins the shared
 * getDb() singleton. Handler driven directly through router.handle() with a
 * fake req/res — no HTTP server.
 *
 * Covers:
 *   (a) auth gate (missing / wrong X-Admin-Key -> 403)
 *   (b) dry-run vs apply (dry-run writes nothing, verified via DB read-back)
 *   (c) apply on a valid unclaimed/uncurated row -> is_active=0 + exactly
 *       one agent_knowledge_audit row with old_value='1'/new_value='0'
 *   (d) missing reason / missing evidence -> rejected_invalid_item (per item)
 *   (e) claimed row -> skipped_claimed, zero writes
 *   (f) curated row (any truthy key) -> skipped_curated, zero writes
 *   (g) unknown id -> not_found
 *   (h) already-inactive row -> skipped_already_inactive, idempotent re-apply
 *   (i) duplicate id within one batch -> second occurrence rejected
 *   (j) batch cap (25) -> 400 for the whole request
 *   (k) pure helper: hasAnyCuratedField
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

export function runAdminAgentsDeactivateTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    if (setKeyOurselves) process.env.ADMIN_KEY = "admin-agents-deactivate-standalone-key";
    const testKey = process.env.ADMIN_KEY as string;

    const db = new Database(":memory:");
    try {
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, claimed_at, is_active)
         VALUES (?, ?, 'test agent', 'test', '', 'https://example.no', 'producer', ?, 'rfb', ?, ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, curated_fields) VALUES (?, ?)`,
      );

      // ── Fixtures ──────────────────────────────────────────────────────
      // (1) plain valid, unclaimed, uncurated, active row
      insertAgent.run("dz-1", "Wrong Entity One AS", "key-dz-1", null, 1);
      insertKnowledge.run("dz-1", "{}");

      // (2) claimed row -> skipped_claimed
      insertAgent.run("dz-2", "Claimed Two AS", "key-dz-2", "2026-01-01T00:00:00.000Z", 1);
      insertKnowledge.run("dz-2", "{}");

      // (3) curated row (any truthy key) -> skipped_curated
      insertAgent.run("dz-3", "Curated Three AS", "key-dz-3", null, 1);
      insertKnowledge.run("dz-3", JSON.stringify({ phone: { by: "owner" } }));

      // (4) already-inactive row -> skipped_already_inactive
      insertAgent.run("dz-4", "Already Inactive Four AS", "key-dz-4", null, 0);
      insertKnowledge.run("dz-4", "{}");

      // (5) row with NO agent_knowledge row at all (must not crash / must
      //     be treated as not-curated)
      insertAgent.run("dz-5", "No Knowledge Row Five AS", "key-dz-5", null, 1);

      // (6) reused-id fixture for batch hygiene
      insertAgent.run("dz-6", "Reused Id Six AS", "key-dz-6", null, 1);
      insertKnowledge.run("dz-6", "{}");

      // (7) missing reason/evidence fixture
      insertAgent.run("dz-7", "Missing Fields Seven AS", "key-dz-7", null, 1);
      insertKnowledge.run("dz-7", "{}");

      delete require.cache[require.resolve("./admin-agents-deactivate")];
      const routeMod = require("./admin-agents-deactivate");
      const router = routeMod.default;
      routeMod.__setAgentDeactivateDbForTesting(db as any);

      function post(body: any, key: string | false = testKey, query?: Record<string, string>): Promise<RouteResult> {
        const headers: Record<string, string> = {};
        if (key !== false) headers["x-admin-key"] = key;
        return callRoute(router, { method: "POST", url: "/", headers, body, query });
      }

      function agentRow(id: string) {
        return db.prepare(`SELECT is_active, merged_into, claimed_at FROM agents WHERE id = ?`).get(id) as
          | { is_active: number; merged_into: string | null; claimed_at: string | null }
          | undefined;
      }
      function auditFor(id: string) {
        return db
          .prepare(
            `SELECT field_name, old_value, new_value, changed_by, notes
               FROM agent_knowledge_audit WHERE agent_id = ? ORDER BY changed_at, rowid`,
          )
          .all(id) as Array<{ field_name: string; old_value: string | null; new_value: string | null; changed_by: string; notes: string | null }>;
      }

      const ITEM = (id: string, reason = "wrong_entity", evidence = "org-nr mismatch vs brreg lookup") => ({
        items: [{ id, reason, evidence }],
      });

      // ── (a) auth gate ───────────────────────────────────────────────────
      let r = await post(ITEM("dz-1"), false);
      assertEq(r.status, 403, "dz-01: missing X-Admin-Key -> 403");
      r = await post(ITEM("dz-1"), "wrong-key");
      assertEq(r.status, 403, "dz-02: wrong X-Admin-Key -> 403");

      // ── (b) dry-run writes NOTHING ──────────────────────────────────────
      r = await post(ITEM("dz-1"));
      assertEq(r.body?.dry_run, true, "dz-03: dry-run by default");
      assertEq(r.body?.results?.[0]?.outcome, "would_deactivate", "dz-04: dry-run reports would_deactivate");
      assertEq(agentRow("dz-1")?.is_active, 1, "dz-05: dry-run left row active");
      assertEq(auditFor("dz-1").length, 0, "dz-06: dry-run wrote no audit rows");

      // ── (c) apply: deactivates + exactly one audit row ───────────────────
      r = await post(ITEM("dz-1", "wrong_entity", "org-nr mismatch vs brreg lookup"), testKey, { apply: "1" });
      assertEq(r.body?.dry_run, false, "dz-07: apply=1 turns off dry-run");
      assertEq(r.body?.results?.[0]?.outcome, "deactivated", "dz-08: apply reports deactivated");
      assertEq(agentRow("dz-1")?.is_active, 0, "dz-09: is_active set to 0");
      assertEq(agentRow("dz-1")?.merged_into, null, "dz-10: merged_into left untouched (NULL)");
      const audit1 = auditFor("dz-1");
      assertEq(audit1.length, 1, "dz-11: exactly one audit row written");
      assertEq(audit1[0]?.field_name, "is_active", "dz-12: audit field_name = is_active");
      assertEq(audit1[0]?.old_value, "1", "dz-13: audit old_value = '1'");
      assertEq(audit1[0]?.new_value, "0", "dz-14: audit new_value = '0'");
      assertEq(audit1[0]?.changed_by, "system", "dz-15: audit changed_by = system");
      assertTrue(
        (audit1[0]?.notes ?? "").includes("wrong_entity") && (audit1[0]?.notes ?? "").includes("org-nr mismatch vs brreg lookup"),
        "dz-16: audit notes carry both reason and evidence",
      );

      // ── (h) idempotent re-apply on the now-inactive row ───────────────────
      r = await post(ITEM("dz-1"), testKey, { apply: "1" });
      assertEq(r.body?.results?.[0]?.outcome, "skipped_already_inactive", "dz-17: re-apply on already-inactive -> skipped_already_inactive");
      assertEq(auditFor("dz-1").length, 1, "dz-18: re-apply wrote no additional audit row");

      // ── (e) claimed row ────────────────────────────────────────────────
      r = await post(ITEM("dz-2"), testKey, { apply: "1" });
      assertEq(r.body?.results?.[0]?.outcome, "skipped_claimed", "dz-19: claimed row -> skipped_claimed");
      assertEq(agentRow("dz-2")?.is_active, 1, "dz-20: claimed row left active");
      assertEq(auditFor("dz-2").length, 0, "dz-21: no audit rows for skipped_claimed");
      r = await post(ITEM("dz-2"));
      assertEq(r.body?.results?.[0]?.outcome, "skipped_claimed", "dz-22: dry-run also reports skipped_claimed");

      // ── (f) curated row ────────────────────────────────────────────────
      r = await post(ITEM("dz-3"), testKey, { apply: "1" });
      assertEq(r.body?.results?.[0]?.outcome, "skipped_curated", "dz-23: curated row -> skipped_curated");
      assertEq(agentRow("dz-3")?.is_active, 1, "dz-24: curated row left active");
      assertEq(auditFor("dz-3").length, 0, "dz-25: no audit rows for skipped_curated");

      // ── (h) already-inactive fixture (fresh row, never touched here) ─────
      r = await post(ITEM("dz-4"), testKey, { apply: "1" });
      assertEq(r.body?.results?.[0]?.outcome, "skipped_already_inactive", "dz-26: pre-inactive row -> skipped_already_inactive");
      assertEq(auditFor("dz-4").length, 0, "dz-27: no audit row written for already-inactive row");

      // ── row with no agent_knowledge row -> not curated, deactivates fine ─
      r = await post(ITEM("dz-5"), testKey, { apply: "1" });
      assertEq(r.body?.results?.[0]?.outcome, "deactivated", "dz-28: no-knowledge-row agent deactivates normally");
      assertEq(agentRow("dz-5")?.is_active, 0, "dz-29: no-knowledge-row agent is_active set to 0");

      // ── (g) unknown id ─────────────────────────────────────────────────
      r = await post(ITEM("does-not-exist"), testKey, { apply: "1" });
      assertEq(r.body?.results?.[0]?.outcome, "not_found", "dz-30: unknown id -> not_found");

      // ── (d) missing reason / missing evidence ─────────────────────────────
      r = await post({ items: [{ id: "dz-7", evidence: "some evidence" }] }, testKey, { apply: "1" });
      assertEq(r.body?.results?.[0]?.outcome, "rejected_invalid_item", "dz-31: missing reason -> rejected_invalid_item");
      assertEq(agentRow("dz-7")?.is_active, 1, "dz-32: row untouched when reason missing");

      r = await post({ items: [{ id: "dz-7", reason: "wrong_entity" }] }, testKey, { apply: "1" });
      assertEq(r.body?.results?.[0]?.outcome, "rejected_invalid_item", "dz-33: missing evidence -> rejected_invalid_item");
      assertEq(agentRow("dz-7")?.is_active, 1, "dz-34: row untouched when evidence missing");

      r = await post({ items: [{ id: "dz-7", reason: "  ", evidence: "  " }] }, testKey, { apply: "1" });
      assertEq(r.body?.results?.[0]?.outcome, "rejected_invalid_item", "dz-35: blank/whitespace-only reason+evidence -> rejected_invalid_item");

      // Whole batch is NOT a 400 just because one item is invalid.
      assertEq(r.status, 200, "dz-36: invalid single item does not 400 the whole batch");

      // ── (i) duplicate id within one batch ─────────────────────────────────
      r = await post(
        {
          items: [
            { id: "dz-6", reason: "wrong_entity", evidence: "first" },
            { id: "dz-6", reason: "wrong_entity", evidence: "second-reuses-id" },
          ],
        },
        testKey,
        { apply: "1" },
      );
      assertEq(r.body?.results?.[0]?.outcome, "deactivated", "dz-37: first occurrence of id processed normally");
      assertEq(r.body?.results?.[1]?.outcome, "rejected_invalid_item", "dz-38: second occurrence of id rejected");
      assertEq(r.body?.results?.[1]?.detail, "id_already_used_in_batch", "dz-39: rejection detail names the reuse");
      assertEq(auditFor("dz-6").length, 1, "dz-40: only ONE audit row written for the reused id");

      // ── (j) batch cap ──────────────────────────────────────────────────
      const tooMany = Array.from({ length: routeMod.AGENT_DEACTIVATE_MAX_ITEMS + 1 }, (_v, i) => ({
        id: `x-${i}`,
        reason: "r",
        evidence: "e",
      }));
      r = await post({ items: tooMany }, testKey, { apply: "1" });
      assertEq(r.status, 400, "dz-41: oversized batch -> 400");
      r = await post({ items: [] });
      assertEq(r.status, 400, "dz-42: empty items -> 400");
      r = await post({});
      assertEq(r.status, 400, "dz-43: missing items -> 400");

      // ── pure helpers ────────────────────────────────────────────────────
      assertEq(routeMod.hasAnyCuratedField(null), false, "dz-44: hasAnyCuratedField(null) false");
      assertEq(routeMod.hasAnyCuratedField("{}"), false, "dz-45: hasAnyCuratedField('{}') false");
      assertEq(
        routeMod.hasAnyCuratedField(JSON.stringify({ phone: false, email: null })),
        false,
        "dz-46: hasAnyCuratedField with only falsy values is false",
      );
      assertEq(
        routeMod.hasAnyCuratedField(JSON.stringify({ phone: false, address: true })),
        true,
        "dz-47: hasAnyCuratedField true when ANY key is truthy",
      );
      assertEq(routeMod.hasAnyCuratedField("not json"), false, "dz-48: malformed curated JSON treated as unlocked");
    } finally {
      if (setKeyOurselves) delete process.env.ADMIN_KEY;
      try {
        const routeMod = require("./admin-agents-deactivate");
        routeMod.__setAgentDeactivateDbForTesting(null);
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
