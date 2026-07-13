/**
 * lokal-agent-verifier-tz-parking.test.ts — timezone regression test for
 * the pending_verify re-stamp-eligibility check in applyVerifierOutcome
 * (src/agents/lokal-agent-verifier.ts).
 *
 * Second-review finding (orch-pr-20260713-verifier-sweep-parking): the
 * previous fix (commit 9f3019d) corrected the *write* side to stamp
 * pending_verify_parked_since via SQL's datetime('now') instead of a JS
 * ISO string, but left the *re-stamp-eligibility* check reading that
 * SQL-native "YYYY-MM-DD HH:MM:SS" (no timezone marker) string back into
 * JS and comparing it with `Date.parse(since) <= Date.now() - 30days`. Per
 * ECMA-262, `Date.parse` on a timezone-less string like that is parsed as
 * LOCAL time, not UTC — so under a UTC-behind timezone (e.g. US zones),
 * a row SQL already considers 30-days-expired could be misjudged as "not
 * yet expired" by this JS check, for up to the zone's UTC-offset in extra
 * hours, silently skipping the re-stamp.
 *
 * The existing pending-verify-parking.test.ts boundary tests (pvp-26 /
 * pvp-27) don't catch this: they run in whatever TZ the CI/dev process
 * happens to be in (normally UTC) and use a margin (1 hour past 30 days)
 * that only demonstrates the fix already applied to the *write* format —
 * they never actually exercised a non-UTC process TZ, so the JS-vs-SQL
 * gap this second fix removes was invisible to them.
 *
 * This test forces a GENUINE non-UTC repro by spawning a child `tsx`
 * process with TZ=America/New_York set in its env. A mid-process
 * `process.env.TZ = ...` mutation is NOT used here on purpose: it would
 * leak into every test that runs afterward in this shared, single-process
 * `tests/test.ts` runner (most of which build/compare Date values), and —
 * separately — we want an unambiguous, fully-isolated repro the way the
 * reviewer's own throwaway repro apparently worked, not a same-process env
 * flip that could be confounded by V8/ICU tz caching in some engines. A
 * brand-new child process reads TZ at OS/libc + V8 startup with no
 * ambiguity. (Empirically verified separately: this Node/V8 build DOES
 * also respect a mid-process `process.env.TZ` mutation for `Date.parse`/
 * `Date.now()` — so either mechanism would technically work here — but
 * the child-process route avoids polluting shared test-runner state and
 * gives a cleaner, unambiguous repro.)
 *
 * The child script ages a REAL applyVerifierOutcome-written
 * pending_verify_parked_since stamp to "30 days + 2 hours" in the past
 * (true UTC terms, via pure-SQL `datetime('now','-30 days','-2 hours')`):
 *   - SQL-native comparison (the fix): 30d2h >= 30d -> expired -> re-stamp.
 *   - The OLD JS Date.parse-as-local-time bug, under America/New_York
 *     (UTC-4 in July): misinterprets the stored string as ~4h "later"
 *     than its true UTC instant, so it would only treat the row as
 *     expired past "30 days + 4 hours" -> at 30d2h it would WRONGLY skip
 *     the re-stamp. 2 hours sits inside that 0-4h gap, so this margin
 *     would have failed under the pre-fix code and must pass now.
 *
 * A second child run under TZ=UTC (control) confirms the same margin
 * behaves correctly there too, i.e. the fix is TZ-invariant, not just
 * "happens to work in New York".
 *
 * Exported runLokalAgentVerifierTzParkingTests({log}) -> TestSummary;
 * wired into tests/test.ts via runSerial (spawns its own child process +
 * its own in-memory DB inside that child — never touches the shared
 * getDb() singleton in the parent test process).
 * Standalone: npx tsx src/agents/lokal-agent-verifier-tz-parking.test.ts
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface ChildResult {
  beforeAge: string;
  afterAge: string;
  beforeNearBoundary: string;
  afterNearBoundary: string;
  tz: string | undefined;
  offsetMin: number;
}

// Runs the aging/re-stamp scenario inside a fresh child process pinned to
// the given TZ. Returns the raw before/after parked_since values so the
// caller can assert on them.
function runInChildProcess(tz: string): ChildResult {
  const verifierModulePath = require.resolve("./lokal-agent-verifier");
  const initModulePath = require.resolve("../database/init");
  const betterSqlite3Path = require.resolve("better-sqlite3");

  const script = `
    const Database = require(${JSON.stringify(betterSqlite3Path)});
    const initMod = require(${JSON.stringify(initModulePath)});
    const verifierMod = require(${JSON.stringify(verifierModulePath)});

    const db = new Database(":memory:");
    initMod.__setDbForTesting(db);
    initMod.__initSchemaForTesting(db);

    const { applyVerifierOutcome } = verifierMod;

    db.prepare(
      "INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key) " +
      "VALUES ('agent-tz', 'TzTestgard AS', 'test agent', 'test', 'x@example.com', 'https://tz-test-gard.no', 'producer', 'key-tz')"
    ).run();
    db.prepare(
      "INSERT INTO agent_knowledge (agent_id, website, email, about, field_provenance, verification_status) " +
      "VALUES ('agent-tz', 'https://tz-test-gard.no', NULL, 'A test farm shop', '{}', 'pending_verify')"
    ).run();

    function noProgress(runStartedAt) {
      applyVerifierOutcome(db, "agent-tz", {
        new_verification_status: "pending_verify",
        new_enrichment_status: "thin",
        http_status: 200,
        runStartedAt,
        eligibleAt: null,
      });
    }

    function parkedSince() {
      return db.prepare(
        "SELECT pending_verify_parked_since FROM agent_knowledge WHERE agent_id = 'agent-tz'"
      ).get().pending_verify_parked_since;
    }

    // Park the agent via 3 REAL applyVerifierOutcome calls (real write path).
    noProgress("2026-07-01T00:00:00.000Z");
    noProgress("2026-07-02T00:00:00.000Z");
    noProgress("2026-07-03T00:00:00.000Z");

    // ── Scenario A: age to "30 days + 2 hours" old (true UTC terms) ──
    // SQL says expired (>= 30 days) — must re-stamp under the fix,
    // regardless of TZ. The pre-fix JS Date.parse-as-local-time bug under
    // a UTC-behind zone like America/New_York would treat this as NOT YET
    // expired (needs ~30d4h under EDT) and wrongly skip the re-stamp.
    db.prepare(
      "UPDATE agent_knowledge SET pending_verify_parked_since = datetime('now','-30 days','-2 hours') WHERE agent_id = 'agent-tz'"
    ).run();
    const beforeAge = parkedSince();
    noProgress("2026-07-04T00:00:00.000Z");
    const afterAge = parkedSince();

    // ── Scenario B: age to "29 days 22 hours" old — still within the
    // 30-day backoff by SQL terms — must NOT re-stamp (byte-identical).
    db.prepare(
      "UPDATE agent_knowledge SET pending_verify_parked_since = datetime('now','-29 days','-22 hours') WHERE agent_id = 'agent-tz'"
    ).run();
    const beforeNearBoundary = parkedSince();
    noProgress("2026-07-05T00:00:00.000Z");
    const afterNearBoundary = parkedSince();

    process.stdout.write(JSON.stringify({
      beforeAge, afterAge, beforeNearBoundary, afterNearBoundary,
      tz: process.env.TZ,
      offsetMin: new Date().getTimezoneOffset(),
    }));
  `;

  const scriptPath = path.join(os.tmpdir(), `lokal-verifier-tz-repro-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(scriptPath, script, "utf8");
  try {
    const stdout = execFileSync("npx", ["tsx", scriptPath], {
      env: { ...process.env, TZ: tz },
      encoding: "utf8",
      timeout: 30_000,
    });
    // __initSchemaForTesting (and other init-time code) may log
    // migration/progress lines to stdout ahead of our JSON payload — the
    // result is always the last line the child prints.
    const lines = stdout.trim().split("\n");
    return JSON.parse(lines[lines.length - 1]!) as ChildResult;
  } finally {
    try { fs.unlinkSync(scriptPath); } catch { /* best-effort cleanup */ }
  }
}

export function runLokalAgentVerifierTzParkingTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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

  return (async () => {
    // ── genuine non-UTC repro: America/New_York (UTC-4 in July / EDT) ──
    const ny = runInChildProcess("America/New_York");
    assertEq(ny.tz, "America/New_York", "tz-01: child process actually ran with TZ=America/New_York");
    assertTrue(ny.offsetMin === 240 || ny.offsetMin === 300,
      `tz-02: child process getTimezoneOffset() reflects a real US-Eastern offset (got ${ny.offsetMin})`);
    assertTrue(ny.afterAge !== ny.beforeAge,
      "tz-03: under TZ=America/New_York, a stamp aged past the true 30-day SQL boundary (30d2h) IS re-stamped (the exact bug this fix removes — pre-fix JS Date.parse-as-local-time would have skipped this)");
    assertEq(ny.afterNearBoundary, ny.beforeNearBoundary,
      "tz-04: under TZ=America/New_York, a stamp still within the 30-day window (29d22h) is NOT re-stamped");

    // ── control: UTC (should behave identically — the fix is TZ-invariant) ──
    const utc = runInChildProcess("UTC");
    assertEq(utc.tz, "UTC", "tz-05: control child process actually ran with TZ=UTC");
    assertEq(utc.offsetMin, 0, "tz-06: control child process getTimezoneOffset() is 0 (true UTC)");
    assertTrue(utc.afterAge !== utc.beforeAge,
      "tz-07: under TZ=UTC (control), the same 30d2h-aged stamp is also re-stamped");
    assertEq(utc.afterNearBoundary, utc.beforeNearBoundary,
      "tz-08: under TZ=UTC (control), the same 29d22h-aged stamp is also NOT re-stamped");

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runLokalAgentVerifierTzParkingTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
