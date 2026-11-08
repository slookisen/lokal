/**
 * admin-owner-gate-impact.test.ts — GET /admin/owner-gate-impact (READ-ONLY),
 * dev-request 2026-11-06-rfb-krav-for-portal-og-okter-ved-eierskifte point 1.
 *
 * Setup: better-sqlite3 ":memory:" + __initSchemaForTesting, route pointed at
 * that DB through __setOwnerGateImpactDbForTesting (never pins getDb()).
 * Handler driven through router.handle() with a fake req/res.
 *
 * Covers:
 *   auth      missing / wrong X-Admin-Key → 403; no ADMIN_KEY → 503
 *   (a)       owned profile (claimed_at, or verified agent_claims) with a live
 *             session → counted, not blocked
 *   (b)       unowned profile with a live session and a live login link → both
 *             blocked, agent id listed
 *   (c)       expired rows not counted
 *   extra     used "mlclaim_" row is neither a session nor a link; a row for a
 *             missing agent is blocked; inactive / other-vertical profiles are
 *             out of the profile counts; gate_enabled follows the env flag;
 *             the profile count matches agentHasVerifiedOwner row by row
 *   (d)       no e-mail address, token or magic_links id anywhere in the body
 *   (e)       no writes: total_changes and table contents unchanged
 *
 * Exported runAdminOwnerGateImpactTests({log}) -> TestSummary. Standalone:
 *   npx tsx src/routes/admin-owner-gate-impact.test.ts
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

const GATE_ENV = "OWNER_VERIFIED_OWNER_GATE_ENABLED";

function callRoute(router: any, headers: Record<string, string>): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: "GET",
      url: "/",
      originalUrl: "/admin/owner-gate-impact",
      query: {},
      headers,
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
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ status: err ? 500 : 0, body: err ? { error: String(err) } : undefined });
    });
  });
}

export async function runAdminOwnerGateImpactTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    assertEq(cond, true, label);
  }

  // Never overwrite an ambient admin key (tests/test.ts shared-global rule).
  const ambientKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  const setKeyOurselves = ambientKey === "";
  if (setKeyOurselves) process.env.ADMIN_KEY = "owner-gate-impact-standalone-key";
  const testKey = (process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY) as string;
  const prevGate = process.env[GATE_ENV];

  const routeMod = require("./admin-owner-gate-impact") as typeof import("./admin-owner-gate-impact");
  const router = routeMod.default as any;
  const db = new Database(":memory:");
  try {
    initMod.__initSchemaForTesting(db as any);
    routeMod.__setOwnerGateImpactDbForTesting(db as any);

    const insertAgent = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key,
                           vertical_id, claimed_at, is_active)
       VALUES (?, ?, 'test agent', 'test', ?, 'https://example.no', 'producer', ?, ?, ?, ?)`,
    );
    function agent(id: string, o: { claimedAt?: string | null; vertical?: string; active?: number } = {}): void {
      insertAgent.run(id, `Gard ${id}`, `kontakt@${id}.example.no`, `key-${id}`,
        o.vertical ?? "rfb", o.claimedAt ?? null, o.active ?? 1);
    }
    const insertClaim = db.prepare(
      `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status) VALUES (?, ?, 'Eier', ?, ?)`,
    );
    const insertLink = db.prepare(
      `INSERT INTO magic_links (id, email, token, agent_id, used, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const future = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    const secrets: string[] = [];
    let n = 0;
    function link(agentId: string, idPrefix: string, used: number, expiresAt: string): void {
      n++;
      const id = `${idPrefix}${String(n).padStart(4, "0")}`;
      const email = `innlogging${n}@hemmelig-${agentId}.example.no`;
      const token = `tok${n}`.padEnd(64, "f");
      secrets.push(id, email, token);
      insertLink.run(id, email, token, agentId, used, expiresAt);
    }

    // (a) owned by claimed_at, and owned by a verified claim only
    agent("gi-owned-claimed", { claimedAt: "2026-10-01T00:00:00.000Z" });
    link("gi-owned-claimed", "mlsess_", 1, future);
    link("gi-owned-claimed", "ml_", 0, future);
    agent("gi-owned-claim-row");
    insertClaim.run("cl-1", "gi-owned-claim-row", "eier@gi-owned-claim-row.example.no", "verified");
    link("gi-owned-claim-row", "ml_", 1, future);
    // (b) unowned (only a pending claim): live session + live link → blocked
    agent("gi-unowned-b");
    insertClaim.run("cl-2", "gi-unowned-b", "kanskje@gi-unowned-b.example.no", "pending");
    link("gi-unowned-b", "mlsess_", 1, future);
    link("gi-unowned-b", "ml_", 0, future);
    // a second unowned profile with only an unused /selger-style uuid link
    agent("gi-unowned-a");
    link("gi-unowned-a", "", 0, future);
    // (c) expired rows (owned and unowned) — never counted
    agent("gi-unowned-expired");
    link("gi-unowned-expired", "mlsess_", 1, past);
    link("gi-unowned-expired", "ml_", 0, past);
    link("gi-owned-claimed", "mlsess_", 1, past);
    // used claim-approval link: neither session nor link
    link("gi-unowned-b", "mlclaim_", 1, future);
    // inactive / other vertical: out of profile counts; the inactive unowned
    // one with a live session still counts as blocked (the gate ignores is_active)
    agent("gi-inactive", { active: 0 });
    link("gi-inactive", "mlsess_", 1, future);
    agent("gi-dental", { vertical: "dental" });
    agent("gi-owned-no-access", { claimedAt: "2026-10-02T00:00:00.000Z" });

    // ── auth ───────────────────────────────────────────────────────────
    const noKey = await callRoute(router, {});
    assertEq(noKey.status, 403, "auth: missing X-Admin-Key → 403");
    const wrongKey = await callRoute(router, { "x-admin-key": testKey + "-wrong" });
    assertEq(wrongKey.status, 403, "auth: wrong X-Admin-Key → 403");
    assertTrue(noKey.body && noKey.body.rfb_profiles_total === undefined, "auth: 403 body carries no counts");
    {
      const saveA = process.env.ADMIN_KEY;
      const saveB = process.env.ANALYTICS_ADMIN_KEY;
      delete process.env.ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;
      try {
        const r = await callRoute(router, { "x-admin-key": testKey });
        assertEq(r.status, 503, "auth: no ADMIN_KEY configured → 503");
      } finally {
        if (saveA !== undefined) process.env.ADMIN_KEY = saveA;
        if (saveB !== undefined) process.env.ANALYTICS_ADMIN_KEY = saveB;
      }
    }

    // ── counts ─────────────────────────────────────────────────────────
    const snapshot = () => JSON.stringify([
      db.prepare(`SELECT * FROM magic_links ORDER BY id`).all(),
      db.prepare(`SELECT * FROM agents ORDER BY id`).all(),
      db.prepare(`SELECT * FROM agent_claims ORDER BY id`).all(),
    ]);
    const before = snapshot();
    const changesBefore = (db.prepare(`SELECT total_changes() AS c`).get() as any).c;

    delete process.env[GATE_ENV];
    const r = await callRoute(router, { "x-admin-key": testKey });
    assertEq(r.status, 200, "200 with admin key");
    const b = r.body || {};
    assertEq(Object.keys(b), [
      "gate_enabled", "rfb_profiles_total", "rfb_profiles_without_verified_owner",
      "live_sessions_total", "live_login_links_total", "live_sessions_blocked", "live_login_links_blocked",
      "profiles_with_blocked_live_access", "blocked_agent_ids", "live_by_kind", "checked_at",
    ], "response keys");
    assertEq(b.gate_enabled, false, "gate_enabled false with the flag unset");
    // active rfb: owned-claimed, owned-claim-row, unowned-b, unowned-a, unowned-expired, owned-no-access
    assertEq(b.rfb_profiles_total, 6, "rfb_profiles_total: active rfb only (inactive + dental out)");
    assertEq(b.rfb_profiles_without_verified_owner, 3, "rfb_profiles_without_verified_owner via customerRuleSql");
    // live sessions: owned-claimed mlsess, owned-claim-row ml_ used, unowned-b mlsess, inactive mlsess
    assertEq(b.live_sessions_total, 4, "(a)(b)(c) live_sessions_total");
    // live links: owned-claimed ml_, unowned-b ml_, unowned-a uuid
    assertEq(b.live_login_links_total, 3, "(a)(b)(c) live_login_links_total");
    assertEq(b.live_sessions_blocked, 2, "(b) live_sessions_blocked (unowned-b + inactive), owned not blocked");
    assertEq(b.live_login_links_blocked, 2, "(b) live_login_links_blocked (unowned-b + unowned-a)");
    assertEq(b.profiles_with_blocked_live_access, 3, "distinct blocked agent ids");
    assertEq(b.blocked_agent_ids, ["gi-inactive", "gi-unowned-a", "gi-unowned-b"], "blocked_agent_ids sorted, no owned/expired ids");
    assertEq(b.live_by_kind, {
      sessions: { mlsess: 3, ml: 1, mlclaim: 0, mlbridge: 0, other: 0 },
      login_links: { mlsess: 0, ml: 2, mlclaim: 0, mlbridge: 0, other: 1 },
    }, "live_by_kind split; used mlclaim_ row in neither");
    assertTrue(typeof b.checked_at === "string" && !Number.isNaN(Date.parse(b.checked_at)), "checked_at is ISO");

    // count parity with agentHasVerifiedOwner's predicate, row by row
    {
      const { customerRuleSql } = require("../services/customer-rule") as typeof import("../services/customer-rule");
      const ids = db.prepare(`SELECT id FROM agents WHERE COALESCE(vertical_id,'rfb')='rfb' AND is_active = 1`).all() as any[];
      let unowned = 0;
      for (const { id } of ids) {
        const row = db.prepare(`SELECT ${customerRuleSql("a")} AS owned FROM agents a WHERE a.id = ?`).get(id) as any;
        if (!(row && row.owned === 1)) unowned++;
      }
      assertEq(b.rfb_profiles_without_verified_owner, unowned, "parity with agentHasVerifiedOwner predicate");
    }

    // (d) no e-mail / token / magic_links id in the body
    const text = JSON.stringify(b);
    assertTrue(!/@/.test(text), "(d) no '@' anywhere in the JSON body");
    assertTrue(secrets.every((s) => !text.includes(s)), "(d) no token, address or magic_links id in the body");

    // a live row for an agent id that no longer exists → blocked
    db.pragma("foreign_keys = OFF");
    insertLink.run("ml_orphan0001", "x@orphan.example.no", "orphantoken".padEnd(64, "0"), "gi-gone", 1, future);
    db.pragma("foreign_keys = ON");
    const ghost = routeMod.computeOwnerGateImpact(db as any);
    assertEq(ghost.live_sessions_blocked, 3, "missing agent's live session counts as blocked");
    assertTrue(ghost.blocked_agent_ids.includes("gi-gone"), "missing agent id listed");
    db.prepare(`DELETE FROM magic_links WHERE id = 'ml_orphan0001'`).run();

    // gate flag reflected
    process.env[GATE_ENV] = "1";
    const on = await callRoute(router, { "x-admin-key": testKey });
    assertEq(on.body && on.body.gate_enabled, true, "gate_enabled true with the flag on");
    assertEq(on.body && on.body.live_sessions_blocked, 2, "counts independent of the flag");

    // (e) no writes by the endpoint itself
    const changesAfterCalls = (db.prepare(`SELECT total_changes() AS c`).get() as any).c;
    // the orphan insert + delete above are the test's own 2 changes
    assertEq(changesAfterCalls - changesBefore, 2, "(e) total_changes: only the test's own orphan insert+delete");
    const changesBeforeLast = changesAfterCalls;
    await callRoute(router, { "x-admin-key": testKey });
    const changesAfterLast = (db.prepare(`SELECT total_changes() AS c`).get() as any).c;
    assertEq(changesAfterLast - changesBeforeLast, 0, "(e) endpoint call adds 0 to total_changes");
    assertEq(snapshot(), before, "(e) magic_links / agents / agent_claims byte-identical");
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    routeMod.__setOwnerGateImpactDbForTesting(null);
    if (prevGate === undefined) delete process.env[GATE_ENV];
    else process.env[GATE_ENV] = prevGate;
    if (setKeyOurselves) delete process.env.ADMIN_KEY;
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminOwnerGateImpactTests({ log: true }).then((r) => {
    console.log(`\nadmin-owner-gate-impact: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
