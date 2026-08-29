/**
 * admin-verifier-claim-counts.test.ts — tests GET /admin/verifier/claim-counts
 * (dev-request 2026-08-29-verifier-claim-kind-katalog-gap).
 *
 * Harness mirrors admin-domain-coherence.test.ts:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (full prod-like schema).
 *   - the previous global db handle is saved/restored.
 *   - the router is exercised directly (router.handle(req, res, next)),
 *     no HTTP server / supertest.
 *   - exported runAdminVerifierClaimCountsTests({log}) -> TestSummary;
 *     wired into tests/test.ts.
 *     Standalone: npx tsx src/routes/admin-verifier-claim-counts.test.ts
 *
 * ONE deliberate deviation from admin-domain-coherence.test.ts's own
 * callRoute(): that file's version hardcodes `query: {}` (fine there — its
 * route is POST-only with a JSON body, no query params). This route is a
 * GET with kind/since/until query params, so callRoute() below parses them
 * out of the URL via URLSearchParams (same technique
 * admin-knowledge-truncation-sweep.test.ts already uses in this codebase for
 * the same reason) — everything else (RouteResult shape, DB setup/teardown,
 * fresh require-per-DB-swap) is copied as-is.
 *
 * Coverage (per the dev-request spec):
 *   - Each of the 7 kinds: seeded rows spanning in-window / just-before-since
 *     / just-after-until / wrong-status-or-outcome, confirming BETWEEN's
 *     inclusive-both-ends semantics at the exact since/until boundary and
 *     exclusion of a row just outside the window.
 *   - is_active = 0 agent excluded even when otherwise matching.
 *   - Unknown kind -> 400.
 *   - Missing/malformed since/until -> 400.
 *   - No X-Admin-Key -> 403; wrong key -> 403; ADMIN_KEY unset -> 503.
 *   - sample caps at 5 even when count is higher.
 *   - sample rows come back in a stable order (ORDER BY a.id) across repeat
 *     calls with the same kind/window.
 *
 * Timestamp-format coverage (the actual bug this fix addresses — see the
 * route file's header comment): production write sites do NOT uniformly
 * write datetime('now')-style space-separated timestamps. last_verified_at
 * and homepage_unreachable_since are written as JS ISO-8601
 * (new Date().toISOString(), 'T'-separated with ms and 'Z') at their real
 * call sites, and updated_at is MIXED — some call sites JS-ISO, others
 * literal datetime('now'). So fixtures below deliberately use:
 *   - last_verified_at / homepage_unreachable_since: JS-ISO form throughout
 *     (matching the real write sites), via new Date(...).toISOString().
 *   - domain_reconciliation_checked_at: kept in the space-separated
 *     datetime('now')-style form it already correctly used (stampParking()
 *     is the one write site that's actually right) — regression check that
 *     the fix doesn't break the one column that was already correct.
 *   - updated_at: explicit cases in BOTH formats (JS-ISO and space-separated)
 *     to prove the mixed-format-per-row reality is handled.
 * Plus a same-day/same-hour boundary case for agents_verified and
 * http_unreachable that is the exact repro from the bug report: a JS-ISO
 * last_verified_at seeded for "today", queried with a since/until window
 * covering "today" — before the fix this silently returned count 0.
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
  },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const [path, qs] = opts.url.split("?");
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      path,
      query: Object.fromEntries(new URLSearchParams(qs || "")),
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

export function runAdminVerifierClaimCountsTests(
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
    const testKey = process.env.ADMIN_KEY || "admin-verifier-claim-counts-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      let n = 0;
      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', 'https://example.no', 'producer', ?, ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, verification_status, last_verified_at, updated_at,
            homepage_unreachable_since, verification_review_reason,
            domain_reconciliation_outcome, domain_reconciliation_checked_at,
            about, field_provenance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'A test farm shop', '{}')`,
      );

      // Seeds one agent + its agent_knowledge row. Any field left undefined
      // is written as NULL (or the schema default for verification_status,
      // which the ALTER TABLE default already handles when omitted — here we
      // always pass it explicitly for clarity).
      function seed(
        id: string,
        fields: {
          verificationStatus?: string;
          lastVerifiedAt?: string | null;
          updatedAt?: string | null;
          homepageUnreachableSince?: string | null;
          reviewReason?: string;
          domainOutcome?: string | null;
          domainCheckedAt?: string | null;
          isActive?: number;
        } = {},
      ): void {
        n++;
        insertAgent.run(id, `${id} AS`, `key-${id}-${n}`, fields.isActive ?? 1);
        insertKnowledge.run(
          id,
          fields.verificationStatus ?? "unverified",
          fields.lastVerifiedAt ?? null,
          fields.updatedAt ?? null,
          fields.homepageUnreachableSince ?? null,
          fields.reviewReason ?? "{}",
          fields.domainOutcome ?? null,
          fields.domainCheckedAt ?? null,
        );
      }

      // Shared window for the boundary-behavior tests below. since/until are
      // sent to the route as 'T'-separated ISO-8601 with a trailing 'Z'.
      // Fixture values are written in the format each column is ACTUALLY
      // written in at its real production call site (see file-header
      // comment and this file's own top-of-file coverage note) — most as
      // JS-ISO ('T'-separated, ms, 'Z', via new Date(...).toISOString()),
      // domain_reconciliation_checked_at (the one genuinely-correct column)
      // and the "*_DB" updated_at variants as space-separated
      // datetime('now')-style text. The fix (datetime(...) wrapping both
      // sides of every BETWEEN) must match correctly regardless of which of
      // these two forms a given row is actually in.
      const SINCE_ISO = "2026-08-01T00:00:00Z";
      const UNTIL_ISO = "2026-08-31T23:59:59Z";
      const SINCE_DB = "2026-08-01 00:00:00";
      const UNTIL_DB = "2026-08-31 23:59:59";
      // Exact boundary values in JS-ISO form (with ms) — same instants as
      // SINCE_DB/UNTIL_DB, written the way last_verified_at/
      // homepage_unreachable_since actually arrive in production.
      const SINCE_JS = "2026-08-01T00:00:00.000Z";
      const UNTIL_JS = "2026-08-31T23:59:59.000Z";
      const IN_WINDOW_JS = "2026-08-15T12:00:00.000Z";
      const IN_WINDOW_DB = "2026-08-15 12:00:00";
      const JUST_BEFORE_JS = "2026-07-31T23:59:59.000Z";
      const JUST_BEFORE_DB = "2026-07-31 23:59:59";
      const JUST_AFTER_JS = "2026-09-01T00:00:00.000Z";

      // ── kind 1: agents_verified (last_verified_at — real write site is
      // JS-ISO throughout, lokal-agent-verifier.ts's new Date().toISOString()) ──
      seed("v-in", { verificationStatus: "verified", lastVerifiedAt: IN_WINDOW_JS });
      seed("v-since-boundary", { verificationStatus: "verified", lastVerifiedAt: SINCE_JS });
      seed("v-until-boundary", { verificationStatus: "verified", lastVerifiedAt: UNTIL_JS });
      seed("v-before", { verificationStatus: "verified", lastVerifiedAt: JUST_BEFORE_JS });
      seed("v-after", { verificationStatus: "verified", lastVerifiedAt: JUST_AFTER_JS });
      seed("v-wrongstatus", { verificationStatus: "pending_verify", lastVerifiedAt: IN_WINDOW_JS });
      seed("v-inactive", { verificationStatus: "verified", lastVerifiedAt: IN_WINDOW_JS, isActive: 0 });

      // ── kind 2: agents_review_required (updated_at — MIXED format in
      // production: some call sites JS-ISO, others literal datetime('now').
      // Both an in-window JS-ISO row and an in-window space-separated row
      // are seeded to prove the fix counts both, not just one format.) ──
      seed("rr-in-js", { verificationStatus: "review_required", updatedAt: IN_WINDOW_JS });
      seed("rr-in-db", { verificationStatus: "review_required", updatedAt: IN_WINDOW_DB });
      seed("rr-before", { verificationStatus: "review_required", updatedAt: JUST_BEFORE_JS });
      seed("rr-wrongstatus", { verificationStatus: "verified", updatedAt: IN_WINDOW_JS });

      // ── kind 3: agents_pending_verify (updated_at, mixed format — see kind 2) ──
      seed("pv-in-js", { verificationStatus: "pending_verify", updatedAt: IN_WINDOW_JS });
      seed("pv-in-db", { verificationStatus: "pending_verify", updatedAt: IN_WINDOW_DB });
      seed("pv-before", { verificationStatus: "pending_verify", updatedAt: JUST_BEFORE_JS });
      seed("pv-wrongstatus", { verificationStatus: "verified", updatedAt: IN_WINDOW_JS });

      // ── kind 4: agents_data_insufficient (updated_at, mixed format — see kind 2) ──
      seed("di-in-js", { verificationStatus: "data_insufficient", updatedAt: IN_WINDOW_JS });
      seed("di-in-db", { verificationStatus: "data_insufficient", updatedAt: IN_WINDOW_DB });
      seed("di-before", { verificationStatus: "data_insufficient", updatedAt: JUST_BEFORE_JS });
      seed("di-wrongstatus", { verificationStatus: "verified", updatedAt: IN_WINDOW_JS });

      // ── kind 5: http_unreachable (homepage_unreachable_since — real write
      // sites are JS-ISO, admin-knowledge.ts / marketplace.ts) ────────────
      seed("hu-in", { homepageUnreachableSince: IN_WINDOW_JS });
      seed("hu-before", { homepageUnreachableSince: JUST_BEFORE_JS });
      seed("hu-null", {});

      // ── kind 6: brreg_inactive_flagged (json terminal_reason + updated_at,
      // mixed format — see kind 2) ────────────────────────────────────────
      seed("bi-in-js", {
        reviewReason: JSON.stringify({ terminal_reason: "brreg_inactive" }),
        updatedAt: IN_WINDOW_JS,
      });
      seed("bi-in-db", {
        reviewReason: JSON.stringify({ terminal_reason: "brreg_inactive" }),
        updatedAt: IN_WINDOW_DB,
      });
      seed("bi-wrongreason", {
        reviewReason: JSON.stringify({ terminal_reason: "brreg_konkurs" }),
        updatedAt: IN_WINDOW_JS,
      });
      seed("bi-before", {
        reviewReason: JSON.stringify({ terminal_reason: "brreg_inactive" }),
        updatedAt: JUST_BEFORE_JS,
      });

      // ── kind 7: agents_domain_incoherent (outcome enum + checked_at —
      // stampParking() is the one write site that's genuinely
      // datetime('now')-style space-separated; kept that way here as a
      // regression check that the fix doesn't break the column that was
      // already correct) ──────────────────────────────────────────────────
      seed("di2-scramble", { domainOutcome: "circular_scramble_candidate", domainCheckedAt: IN_WINDOW_DB });
      seed("di2-manual", { domainOutcome: "manual_review_needed", domainCheckedAt: IN_WINDOW_DB });
      seed("di2-noaction", { domainOutcome: "no_action_needed", domainCheckedAt: IN_WINDOW_DB });
      seed("di2-before", { domainOutcome: "circular_scramble_candidate", domainCheckedAt: JUST_BEFORE_DB });

      // ── sample cap: 7 matching rows in a DIFFERENT window than the ones
      // above, so this doesn't perturb the agents_verified boundary counts.
      // JS-ISO timestamp, matching last_verified_at's real write-site format.
      const CAP_SINCE_ISO = "2027-01-01T00:00:00Z";
      const CAP_UNTIL_ISO = "2027-01-31T23:59:59Z";
      for (let i = 1; i <= 7; i++) {
        seed(`cap-${i}`, { verificationStatus: "verified", lastVerifiedAt: "2027-01-15T00:00:00.000Z" });
      }

      delete require.cache[require.resolve("./admin-verifier-claim-counts")];
      const routeMod = require("./admin-verifier-claim-counts");
      const router = routeMod.default;

      function get(qs: string, key: string | false = testKey): Promise<RouteResult> {
        const headers: Record<string, string> = {};
        if (key !== false) headers["x-admin-key"] = key;
        return callRoute(router, { method: "GET", url: `/?${qs}`, headers });
      }

      // ── auth gate ────────────────────────────────────────────────────
      let result = await get(`kind=agents_verified&since=${SINCE_ISO}&until=${UNTIL_ISO}`, false);
      assertEq(result.status, 403, "vcc-01: missing X-Admin-Key -> 403");
      result = await get(`kind=agents_verified&since=${SINCE_ISO}&until=${UNTIL_ISO}`, "wrong-key");
      assertEq(result.status, 403, "vcc-02: wrong X-Admin-Key -> 403");

      // Both ADMIN_KEY and its legacy ANALYTICS_ADMIN_KEY fallback must be
      // unset to reach the "not configured" 503 — tests/test.ts pins a
      // suite-wide canonical ANALYTICS_ADMIN_KEY (SUITE_ANALYTICS_ADMIN_KEY)
      // for the whole run, so clearing ADMIN_KEY alone would still leave
      // getAdminKey() non-empty (see analytics-adminkey.test.ts for the same
      // pattern with the same suite-wide constant).
      const prevAdminKeyForUnset = process.env.ADMIN_KEY;
      const prevAnalyticsAdminKeyForUnset = process.env.ANALYTICS_ADMIN_KEY;
      delete process.env.ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;
      result = await get(`kind=agents_verified&since=${SINCE_ISO}&until=${UNTIL_ISO}`);
      assertEq(result.status, 503, "vcc-03: ADMIN_KEY and ANALYTICS_ADMIN_KEY both unset -> 503");
      if (prevAdminKeyForUnset === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKeyForUnset;
      if (prevAnalyticsAdminKeyForUnset === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
      else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKeyForUnset;

      // ── unknown kind ─────────────────────────────────────────────────
      result = await get(`kind=not_a_real_kind&since=${SINCE_ISO}&until=${UNTIL_ISO}`);
      assertEq(result.status, 400, "vcc-04: unknown kind -> 400");
      assertEq(result.body.success, false, "vcc-05: unknown kind body.success is false");
      assertEq(result.body.error, "unknown kind: not_a_real_kind", "vcc-06: unknown kind error message names the bad kind");

      // ── missing/malformed since/until ───────────────────────────────
      result = await get(`kind=agents_verified&until=${UNTIL_ISO}`);
      assertEq(result.status, 400, "vcc-07: missing since -> 400");
      result = await get(`kind=agents_verified&since=${SINCE_ISO}`);
      assertEq(result.status, 400, "vcc-08: missing until -> 400");
      result = await get(`kind=agents_verified&since=not-a-date&until=${UNTIL_ISO}`);
      assertEq(result.status, 400, "vcc-09: unparseable since -> 400");
      result = await get(`kind=agents_verified&since=${SINCE_ISO}&until=not-a-date`);
      assertEq(result.status, 400, "vcc-10: unparseable until -> 400");

      // ── kind 1: agents_verified ─────────────────────────────────────
      result = await get(`kind=agents_verified&since=${SINCE_ISO}&until=${UNTIL_ISO}`);
      assertEq(result.status, 200, "vcc-11: agents_verified -> 200");
      assertEq(result.body.success, true, "vcc-12: agents_verified body.success");
      assertEq(result.body.kind, "agents_verified", "vcc-13: agents_verified echoes kind");
      assertEq(result.body.since, SINCE_DB, "vcc-14: since echoed in normalized space-separated form");
      assertEq(result.body.until, UNTIL_DB, "vcc-15: until echoed in normalized space-separated form");
      assertEq(result.body.count, 3, "vcc-16: agents_verified count = 3 (in-window + both inclusive boundaries; excludes before/after/wrong-status/inactive)");
      const vIds = result.body.sample.map((r: any) => r.id).sort();
      assertEq(vIds, ["v-in", "v-since-boundary", "v-until-boundary"], "vcc-17: agents_verified sample ids match exactly the 3 counted rows");
      assertTrue(result.body.sample.every((r: any) => typeof r.name === "string" && r.name.length > 0), "vcc-18: sample rows carry a name field");

      // ── kind 2: agents_review_required — mixed updated_at format: one
      // JS-ISO row (rr-in-js) and one space-separated row (rr-in-db) both
      // must count, proving the fix handles both formats on the same column ──
      result = await get(`kind=agents_review_required&since=${SINCE_ISO}&until=${UNTIL_ISO}`);
      assertEq(result.body.count, 2, "vcc-19: agents_review_required count = 2 (JS-ISO row + space-separated row both match; excludes before-window and wrong-status)");
      assertEq(
        result.body.sample.map((r: any) => r.id).sort(),
        ["rr-in-db", "rr-in-js"],
        "vcc-20: agents_review_required sample is exactly the JS-ISO and space-separated in-window rows",
      );

      // ── kind 3: agents_pending_verify — same mixed-format proof as kind 2 ──
      result = await get(`kind=agents_pending_verify&since=${SINCE_ISO}&until=${UNTIL_ISO}`);
      assertEq(result.body.count, 2, "vcc-21: agents_pending_verify count = 2 (JS-ISO + space-separated rows both match)");
      assertEq(
        result.body.sample.map((r: any) => r.id).sort(),
        ["pv-in-db", "pv-in-js"],
        "vcc-22: agents_pending_verify sample is exactly the JS-ISO and space-separated in-window rows",
      );

      // ── kind 4: agents_data_insufficient — same mixed-format proof as kind 2 ──
      result = await get(`kind=agents_data_insufficient&since=${SINCE_ISO}&until=${UNTIL_ISO}`);
      assertEq(result.body.count, 2, "vcc-23: agents_data_insufficient count = 2 (JS-ISO + space-separated rows both match)");
      assertEq(
        result.body.sample.map((r: any) => r.id).sort(),
        ["di-in-db", "di-in-js"],
        "vcc-24: agents_data_insufficient sample is exactly the JS-ISO and space-separated in-window rows",
      );

      // ── kind 5: http_unreachable (JS-ISO fixture, real write-site format) ──
      result = await get(`kind=http_unreachable&since=${SINCE_ISO}&until=${UNTIL_ISO}`);
      assertEq(result.body.count, 1, "vcc-25: http_unreachable count = 1 (excludes before-window and NULL)");
      assertEq(result.body.sample.map((r: any) => r.id), ["hu-in"], "vcc-26: http_unreachable sample is exactly hu-in");

      // ── kind 6: brreg_inactive_flagged — same mixed-format proof as kind 2 ──
      result = await get(`kind=brreg_inactive_flagged&since=${SINCE_ISO}&until=${UNTIL_ISO}`);
      assertEq(result.body.count, 2, "vcc-27: brreg_inactive_flagged count = 2 (JS-ISO + space-separated rows both match; excludes wrong terminal_reason and before-window)");
      assertEq(
        result.body.sample.map((r: any) => r.id).sort(),
        ["bi-in-db", "bi-in-js"],
        "vcc-28: brreg_inactive_flagged sample is exactly the JS-ISO and space-separated in-window rows",
      );

      // ── kind 7: agents_domain_incoherent ────────────────────────────
      result = await get(`kind=agents_domain_incoherent&since=${SINCE_ISO}&until=${UNTIL_ISO}`);
      assertEq(result.body.count, 2, "vcc-29: agents_domain_incoherent count = 2 (both scramble + manual_review outcomes; excludes no_action_needed and before-window)");
      const diIds = result.body.sample.map((r: any) => r.id).sort();
      assertEq(diIds, ["di2-manual", "di2-scramble"], "vcc-30: agents_domain_incoherent sample matches exactly the 2 counted rows");

      // ── is_active = 0 exclusion (already covered structurally above via
      // v-inactive not appearing in vcc-16/17, asserted explicitly here too) ──
      assertTrue(!vIds.includes("v-inactive"), "vcc-31: is_active=0 agent excluded even though it otherwise matches agents_verified");

      // ── sample caps at 5 even when count is higher; ORDER BY a.id makes
      // repeat calls with the same kind/window deterministic ─────────────
      result = await get(`kind=agents_verified&since=${CAP_SINCE_ISO}&until=${CAP_UNTIL_ISO}`);
      assertEq(result.body.count, 7, "vcc-32: sample-cap fixture count = 7");
      assertEq(result.body.sample.length, 5, "vcc-33: sample array caps at 5 even though count is 7");
      assertEq(
        result.body.sample.map((r: any) => r.id),
        ["cap-1", "cap-2", "cap-3", "cap-4", "cap-5"],
        "vcc-34: sample is ordered by a.id (stable — cap-1..cap-5, not arbitrary insertion/DB order)",
      );
      const repeatResult = await get(`kind=agents_verified&since=${CAP_SINCE_ISO}&until=${CAP_UNTIL_ISO}`);
      assertEq(
        repeatResult.body.sample.map((r: any) => r.id),
        result.body.sample.map((r: any) => r.id),
        "vcc-35: repeat call with same kind/window returns the same sample ids in the same order",
      );

      // ── same-day/same-hour boundary repro (the exact original bug): a
      // JS-ISO last_verified_at / homepage_unreachable_since seeded for a
      // single day, queried with a since/until window covering just that
      // day. Before the fix (raw string BETWEEN against a space-separated-
      // normalized bound), SQLite's default collation sorts 'T' (0x54)
      // above ' ' (0x20), so this JS-ISO row would silently sort as "after"
      // the window's until bound and be excluded — count 0 instead of 1. ──
      const REPRO_DAY_SINCE_ISO = "2026-05-10T00:00:00Z";
      const REPRO_DAY_UNTIL_ISO = "2026-05-10T23:59:59Z";
      const REPRO_TS_VERIFIED = "2026-05-10T14:30:00.000Z";
      seed("repro-verified", { verificationStatus: "verified", lastVerifiedAt: REPRO_TS_VERIFIED });
      const REPRO_TS_UNREACHABLE = "2026-05-10T09:05:00.000Z";
      seed("repro-unreachable", { homepageUnreachableSince: REPRO_TS_UNREACHABLE });

      result = await get(`kind=agents_verified&since=${REPRO_DAY_SINCE_ISO}&until=${REPRO_DAY_UNTIL_ISO}`);
      assertEq(result.body.count, 1, "vcc-36: [bug repro] agents_verified same-day JS-ISO last_verified_at is counted (was silently 0 before the datetime() fix)");
      assertEq(result.body.sample.map((r: any) => r.id), ["repro-verified"], "vcc-37: [bug repro] agents_verified sample is exactly repro-verified");

      result = await get(`kind=http_unreachable&since=${REPRO_DAY_SINCE_ISO}&until=${REPRO_DAY_UNTIL_ISO}`);
      assertEq(result.body.count, 1, "vcc-38: [bug repro] http_unreachable same-day JS-ISO homepage_unreachable_since is counted (was silently 0 before the datetime() fix)");
      assertEq(result.body.sample.map((r: any) => r.id), ["repro-unreachable"], "vcc-39: [bug repro] http_unreachable sample is exactly repro-unreachable");
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminVerifierClaimCountsTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
