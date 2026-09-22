/**
 * admin-outreach-pool-pending-verify-parking.test.ts — tests the
 * `pending_verify_parking` rotation-visibility fields added to
 * GET /admin/outreach-ready-pool/stats (src/routes/admin-outreach-pool.ts),
 * dev-request 2026-09-19-rfb-verifiseringskoen-maalrettet-reverifisering-og-
 * parkerings-innsyn (item 2 only — "Innsyn: parkeringens rotasjon skal være
 * lesbar"; item 1, the run-verifier `agentIds` filter, shipped separately in
 * lokal#904 and is untouched here).
 *
 * New fields, all additive and read-only, computed from a single extra SQL
 * query against agent_knowledge (no app-memory row-pulling, no new column,
 * no gate/threshold/cooldown change):
 *   - parked_age_buckets: {"0-7d","7-14d","14-30d","30d+"} — age =
 *     now - pending_verify_parked_since, bucketed with the lower bound
 *     inclusive / upper bound exclusive (i.e. age<7, 7<=age<14, 14<=age<30,
 *     age>=30). The four buckets are asserted to sum to
 *     parked_active + parked_expired_ready_for_retry (see the AC4 judgment
 *     call documented above the SQL query in admin-outreach-pool.ts: the
 *     dev-request's own "summerer til parked_active" wording is ambiguous,
 *     since the 30d+ bucket is by construction the parked_expired
 *     population, not a subset of parked_active — the only reading under
 *     which the four buckets are a genuine, non-overlapping partition of
 *     "every row currently parked" is parked_active + parked_expired).
 *   - next_release_at: earliest active-parked row's parked_since + 30 days,
 *     or null when there is no active-parked row.
 *   - oldest_parked_since: earliest parked_since across ALL currently-parked
 *     rows (active + expired), or null when nothing is parked at all.
 *
 * Mirrors admin-outreach-pool-blocker-breakdown.test.ts's convention:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (full prod-like schema).
 *   - the previous global db handle is saved/restored per scenario.
 *   - the router is exercised directly (router.handle(req, res, next)), no
 *     HTTP server / supertest.
 *   - exported runAdminOutreachPoolPendingVerifyParkingTests({log}) ->
 *     TestSummary; wired into tests/test.ts the same way.
 *     Standalone: npx tsx src/routes/admin-outreach-pool-pending-verify-parking.test.ts
 *
 * There was no pre-existing dedicated test file/block asserting
 * pending_verify_parking's two pre-existing fields (parked_active,
 * parked_expired_ready_for_retry) on THIS route before this dev-request —
 * grepped for "pending_verify_parking"/"parked_active" across src/**\/*.test.ts
 * and found none besides the agent-verifier's own applyVerifierOutcome
 * parking-mechanism tests (a different layer: they test when parked_since
 * gets stamped/cleared, not this route's stats read). So AC6's regression
 * coverage is established here, for the first time, rather than extended
 * from an existing file — see scenario 1 below.
 *
 * Scenario 1 ("general"): rows aged 3, 10, 20, 35, 40 days (the dev-request's
 * own suggested fixture set, AC3) plus two boundary-sensitive rows and one
 * never-parked (NULL) row, to pin down bucket edges, the 30d+/parked_expired
 * invariant (AC3), next_release_at with actives present, oldest_parked_since,
 * and the pre-existing parked_active/parked_expired_ready_for_retry values
 * (AC6 regression).
 * Scenario 2 ("no active-parked rows"): only expired rows -> next_release_at
 * must be null (AC4), oldest_parked_since still computed over the expired
 * population (AC5).
 * Scenario 3 ("zero parked rows at all"): no row has a non-null
 * pending_verify_parked_since -> everything zero/null (AC4, AC5).
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
    const req: any = {
      method: opts.method || "GET",
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

export function runAdminOutreachPoolPendingVerifyParkingTests(
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
    const testKey = process.env.ADMIN_KEY || "admin-outreach-pool-pending-verify-parking-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    delete require.cache[require.resolve("./admin-outreach-pool")];
    const statsRouteMod = require("./admin-outreach-pool");
    const statsRouter = statsRouteMod.default;

    // Builds a fresh in-memory prod-schema DB and inserts one agent +
    // agent_knowledge row per fixture. agent_knowledge's non-key columns all
    // have NOT NULL DEFAULTs in the schema (verification_status,
    // enrichment_status, field_provenance, curated_fields, sweep_round, ...),
    // so only agent_id + pending_verify_parked_since need to be supplied —
    // this route's pending_verify_parking query has no WHERE clause beyond
    // pending_verify_parked_since itself, so verification/enrichment status
    // are irrelevant to it.
    function buildDb(fixtures: Array<{ id: string; parkedSinceOffset: string | null }>): Database.Database {
      const db = new Database(":memory:");
      initMod.__initSchemaForTesting(db as any);
      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES (?, ?, ?, 'test', ?, ?, 'producer', ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, pending_verify_parked_since) VALUES (?, ?)`,
      );
      const offsetToTimestamp = (offset: string | null): string | null =>
        offset === null ? null : (db.prepare(`SELECT datetime('now', ?) AS d`).get(offset) as { d: string }).d;
      for (const f of fixtures) {
        insertAgent.run(f.id, f.id, `${f.id} description`, `${f.id}@dummy.invalid`, `https://${f.id}.invalid`, `key-${f.id}`);
        insertKnowledge.run(f.id, offsetToTimestamp(f.parkedSinceOffset));
      }
      return db;
    }

    async function runScenario(
      label: string,
      fixtures: Array<{ id: string; parkedSinceOffset: string | null }>,
      assertFn: (pvp: any, db: Database.Database) => void,
    ): Promise<void> {
      const db = buildDb(fixtures);
      try {
        initMod.__setDbForTesting(db as any);
        const result = await callRoute(statsRouter, {
          method: "GET",
          url: "/stats",
          headers: { "x-admin-key": testKey },
        });
        assertEq(result.status, 200, `${label}: GET /admin/outreach-ready-pool/stats -> 200`);
        assertTrue(!!result.body?.pending_verify_parking, `${label}: response includes pending_verify_parking`);
        assertFn(result.body?.pending_verify_parking ?? {}, db);
      } finally {
        db.close();
      }
    }

    try {
      // ── Scenario 1: general — rows at 3, 10, 20, 35, 40 days (AC3's own
      // suggested fixture set), plus two boundary-sensitive rows well clear
      // of any query-execution-time jitter (a few hours' margin either side
      // of the 7d/14d edges, not seconds), plus one never-parked (NULL) row
      // that must not be counted anywhere. ──────────────────────────────
      await runScenario(
        "pvp-general",
        [
          { id: "p-3d", parkedSinceOffset: "-3 days" },
          { id: "p-10d", parkedSinceOffset: "-10 days" },
          { id: "p-20d", parkedSinceOffset: "-20 days" },
          { id: "p-35d", parkedSinceOffset: "-35 days" },
          { id: "p-40d", parkedSinceOffset: "-40 days" },
          // boundary pair: just under 7d (0-7d bucket) vs. just over 7d
          // (7-14d bucket). Each offset must be a SINGLE datetime() modifier
          // (SQLite doesn't accept a compound "-N days -N hours" string in
          // one modifier argument), so these are expressed in hours: 166h =
          // 6d22h (< 168h/7d, 2h margin), 170h = 7d2h (> 168h/7d, 2h margin).
          { id: "p-boundary-under7", parkedSinceOffset: "-166 hours" },
          { id: "p-boundary-over7", parkedSinceOffset: "-170 hours" },
          { id: "n-never-parked", parkedSinceOffset: null },
        ],
        (pvp) => {
          // AC6 regression — pre-existing fields unchanged in value AND
          // meaning: parked_active counts every row with a non-null
          // parked_since less than 30 days old (p-3d, p-10d, p-20d, both
          // boundary rows = 5); parked_expired_ready_for_retry counts every
          // row with a non-null parked_since 30+ days old (p-35d, p-40d = 2).
          // n-never-parked (NULL) is excluded from both, exactly as before.
          assertEq(pvp.parked_active, 5, "pvp-01: parked_active unchanged — 5 active-parked rows (p-3d,p-10d,p-20d,both boundary rows)");
          assertEq(pvp.parked_expired_ready_for_retry, 2, "pvp-02: parked_expired_ready_for_retry unchanged — 2 expired-parked rows (p-35d,p-40d)");

          // ── new: parked_age_buckets ──────────────────────────────────
          assertEq(
            pvp.parked_age_buckets,
            { "0-7d": 2, "7-14d": 2, "14-30d": 1, "30d+": 2 },
            "pvp-03: parked_age_buckets — 0-7d: p-3d + p-boundary-under7; 7-14d: p-10d + p-boundary-over7; 14-30d: p-20d; 30d+: p-35d,p-40d",
          );
          const bucketSum =
            pvp.parked_age_buckets["0-7d"] + pvp.parked_age_buckets["7-14d"] +
            pvp.parked_age_buckets["14-30d"] + pvp.parked_age_buckets["30d+"];
          assertEq(
            bucketSum,
            pvp.parked_active + pvp.parked_expired_ready_for_retry,
            "pvp-04: AC2/AC4 reconciliation — the 4 age buckets sum to parked_active + parked_expired_ready_for_retry (8), the complete currently-parked population; NOT parked_active alone, since the 30d+ bucket is the parked_expired population, not a subset of parked_active (see the AC4 judgment-call comment in admin-outreach-pool.ts)",
          );
          assertEq(
            pvp.parked_age_buckets["30d+"],
            pvp.parked_expired_ready_for_retry,
            "pvp-05: AC3 invariant — the 30d+ bucket is internally consistent with (the exact same population as) parked_expired_ready_for_retry",
          );

          // ── new: next_release_at ─────────────────────────────────────
          // Earliest active-parked row = p-20d (20 days ago is the earliest/
          // most-in-the-past timestamp among the 5 active rows) -> + 30 days
          // = ~10 days from now. Assert via a tolerant window rather than an
          // exact string match (both sides evaluate `datetime('now', ...)`
          // at slightly different wall-clock instants).
          assertTrue(typeof pvp.next_release_at === "string" && pvp.next_release_at.length > 0,
            "pvp-06: next_release_at is a non-empty string when active-parked rows exist");
          const nextReleaseMs = Date.parse(pvp.next_release_at.replace(" ", "T") + "Z");
          const expectedMs = Date.now() + 10 * 24 * 60 * 60 * 1000; // ~10 days from now (30 - 20)
          assertTrue(
            Math.abs(nextReleaseMs - expectedMs) < 5 * 60 * 1000, // 5-minute tolerance
            `pvp-07: next_release_at ≈ earliest active parked_since (p-20d) + 30 days ≈ now+10d (got ${pvp.next_release_at}, expected ~${new Date(expectedMs).toISOString()})`,
          );

          // ── new: oldest_parked_since ─────────────────────────────────
          // Earliest across ALL parked rows (active + expired) = p-40d.
          assertTrue(typeof pvp.oldest_parked_since === "string" && pvp.oldest_parked_since.length > 0,
            "pvp-08: oldest_parked_since is a non-empty string when parked rows exist");
          const oldestMs = Date.parse(pvp.oldest_parked_since.replace(" ", "T") + "Z");
          const expectedOldestMs = Date.now() - 40 * 24 * 60 * 60 * 1000;
          assertTrue(
            Math.abs(oldestMs - expectedOldestMs) < 5 * 60 * 1000,
            `pvp-09: oldest_parked_since ≈ p-40d's parked_since (got ${pvp.oldest_parked_since}, expected ~${new Date(expectedOldestMs).toISOString()})`,
          );
        },
      );

      // ── Scenario 2: only expired rows -> no active-parked row at all ──
      await runScenario(
        "pvp-no-active",
        [
          { id: "e-35d", parkedSinceOffset: "-35 days" },
          { id: "e-40d", parkedSinceOffset: "-40 days" },
        ],
        (pvp) => {
          assertEq(pvp.parked_active, 0, "pvp-10: parked_active is 0 when every parked row is expired");
          assertEq(pvp.parked_expired_ready_for_retry, 2, "pvp-11: parked_expired_ready_for_retry still counts both expired rows");
          assertEq(pvp.parked_age_buckets, { "0-7d": 0, "7-14d": 0, "14-30d": 0, "30d+": 2 },
            "pvp-12: parked_age_buckets — everything in 30d+, matches parked_expired_ready_for_retry");
          assertEq(pvp.next_release_at, null, "pvp-13: AC4 — next_release_at is null when there are zero active-parked rows");
          assertTrue(typeof pvp.oldest_parked_since === "string" && pvp.oldest_parked_since.length > 0,
            "pvp-14: AC5 — oldest_parked_since is still computed over the expired population when no active rows exist");
        },
      );

      // ── Scenario 3: nothing parked at all (all NULL) ───────────────────
      await runScenario(
        "pvp-nothing-parked",
        [
          { id: "z-1", parkedSinceOffset: null },
          { id: "z-2", parkedSinceOffset: null },
        ],
        (pvp) => {
          assertEq(pvp.parked_active, 0, "pvp-15: parked_active is 0 when nothing is parked");
          assertEq(pvp.parked_expired_ready_for_retry, 0, "pvp-16: parked_expired_ready_for_retry is 0 when nothing is parked");
          assertEq(pvp.parked_age_buckets, { "0-7d": 0, "7-14d": 0, "14-30d": 0, "30d+": 0 },
            "pvp-17: parked_age_buckets are all 0 when nothing is parked");
          assertEq(pvp.next_release_at, null, "pvp-18: AC4 — next_release_at is null when there are zero active-parked rows");
          assertEq(pvp.oldest_parked_since, null, "pvp-19: AC5 — oldest_parked_since is null when there are zero parked rows (active or expired) at all");
        },
      );
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminOutreachPoolPendingVerifyParkingTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
