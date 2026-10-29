/**
 * admin-loop-dispatch.test.ts — per-routine /fire overrides and a truthful
 * dispatcher envelope status (routes/admin-loop-dispatch.ts).
 *
 * Prod 2026-09-04 → 2026-10-15: every off-cycle wake of experiences-enrichment
 * got HTTP 401 "Token is not authorized for this routine" (158 calls, 41 days).
 * Each Cloud Routine has its own /fire token, and the one stored for this
 * routine inside the FIRE_ROUTINES JSON secret was not its own — but replacing
 * one token meant rebuilding the whole secret, and every envelope still said
 * "completed". Pins:
 *   d1  FIRE_ROUTINES parsing is unchanged (aliases, bad entries, bad JSON).
 *   d2  FIRE_ROUTINE_<AGENT>_TOKEN / _TRIG override one field of one entry.
 *   d3  an override can add an allowlisted agent missing from the JSON (both
 *       fields needed), and works when FIRE_ROUTINES is unset or unparseable.
 *   d4  the diag never carries trig/token values; set-but-unapplied override
 *       NAMES are listed in override_ignored.
 *   d5  envelope status: completed / partial / failed.
 *   d6  runDispatchTick records the envelope with dispatchEnvelopeStatus().
 *   d7  planNow lists runs by finished_at too (long run finished recently still wakes);
 *       listRecentRuns finishedSinceMinutes; DISPATCH_PLAN_FINISHED_LOOKBACK_MIN knob (pinned in-memory DB).
 * d1-d6 are pure — env is injected; no DB, no network.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/admin-loop-dispatch.test.ts
 *   2. Wired into the gate: tests/test.ts.
 */

import fs from "fs";
import path from "path";
import { dispatchEnvelopeStatus, fireRoutineEnvStem, parseRoutines, planNow } from "./admin-loop-dispatch";
import { __pinInMemoryDbForTesting } from "../database/init";
import { listRecentRuns, recordRun } from "../services/run-ledger";
import { resolveFinishedLookbackMin } from "../services/loop-dispatch";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runAdminLoopDispatchTests(opts: { log?: boolean } = {}): TestSummary {
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

  const json = JSON.stringify({
    orchestrator: { trig: "trig_orch", token: "tok_orch" },
    "experiences-enrichment": { trig: "trig_exp", token: "tok_exp_wrong" },
    "rfb-customer-service": { trig: "trig_cs", token: "tok_cs" },
    broken: { trig: "trig_only" },
  });

  try {
    // ── d1: JSON parsing unchanged ──────────────────────────────────────────
    {
      const { map, diag } = parseRoutines({ FIRE_ROUTINES: json });
      assertEq(map["platform-orchestrator"], { trig: "trig_orch", token: "tok_orch" }, "d1: short key 'orchestrator' maps to platform-orchestrator");
      assertEq(map["experiences-enrichment"], { trig: "trig_exp", token: "tok_exp_wrong" }, "d1: full key kept as-is");
      assertTrue(!("broken" in map), "d1: an entry without a token is dropped");
      assertEq(diag.raw_keys, ["orchestrator", "experiences-enrichment", "rfb-customer-service", "broken"], "d1: raw_keys lists every JSON key");
      assertEq(diag.mapped_keys, ["platform-orchestrator", "experiences-enrichment", "rfb-customer-service"], "d1: mapped_keys lists canonical names");
      assertEq(diag.override_keys, [], "d1: no overrides without FIRE_ROUTINE_* vars");
      assertTrue(diag.present && diag.parse_ok && diag.parse_error === null, "d1: diag reports a clean parse");
    }
    {
      const { map, diag } = parseRoutines({});
      assertEq(map, {}, "d1: FIRE_ROUTINES unset → empty map");
      assertTrue(!diag.present && !diag.parse_ok, "d1: unset → present=false, parse_ok=false");
    }
    {
      const { map, diag } = parseRoutines({ FIRE_ROUTINES: "{not json" });
      assertEq(map, {}, "d1: bad JSON → empty map");
      assertTrue(diag.present && !diag.parse_ok && typeof diag.parse_error === "string", "d1: bad JSON → parse_error set");
    }
    for (const notObject of ["null", "[1,2]", '"text"', "42"]) {
      const { map, diag } = parseRoutines({ FIRE_ROUTINES: notObject });
      assertEq(map, {}, `d1: JSON ${notObject} (not an object) → empty map`);
      assertTrue(!diag.parse_ok && typeof diag.parse_error === "string", `d1: JSON ${notObject} → parse_ok=false with parse_error (never both)`);
    }

    // ── d2: per-routine override of one field ───────────────────────────────
    assertEq(fireRoutineEnvStem("experiences-enrichment"), "EXPERIENCES_ENRICHMENT", "d2: env stem upper-cases and maps '-' to '_'");
    assertEq(fireRoutineEnvStem("orchestrator-v3-controller"), "ORCHESTRATOR_V3_CONTROLLER", "d2: env stem keeps digits");
    {
      const { map, diag } = parseRoutines({
        FIRE_ROUTINES: json,
        FIRE_ROUTINE_EXPERIENCES_ENRICHMENT_TOKEN: "tok_exp_new",
      });
      assertEq(map["experiences-enrichment"], { trig: "trig_exp", token: "tok_exp_new" }, "d2: TOKEN override replaces only the token, trig kept from JSON");
      assertEq(map["rfb-customer-service"], { trig: "trig_cs", token: "tok_cs" }, "d2: other entries untouched");
      assertEq(diag.override_keys, ["experiences-enrichment"], "d2: override_keys names the overridden agent");
    }
    {
      const { map } = parseRoutines({
        FIRE_ROUTINES: json,
        FIRE_ROUTINE_EXPERIENCES_ENRICHMENT_TRIG: " trig_exp_new ",
        FIRE_ROUTINE_EXPERIENCES_ENRICHMENT_TOKEN: "tok_exp_new\n",
      });
      assertEq(map["experiences-enrichment"], { trig: "trig_exp_new", token: "tok_exp_new" }, "d2: TRIG + TOKEN override both, values trimmed");
    }
    {
      const { map, diag } = parseRoutines({ FIRE_ROUTINES: json, FIRE_ROUTINE_PLATFORM_ORCHESTRATOR_TOKEN: "tok_orch_new" });
      assertEq(map["platform-orchestrator"], { trig: "trig_orch", token: "tok_orch_new" }, "d2: override keys off the canonical name, also for an aliased JSON key");
      assertEq(diag.override_keys, ["platform-orchestrator"], "d2: override_keys uses the canonical name");
    }
    {
      const { map, diag } = parseRoutines({ FIRE_ROUTINES: json, FIRE_ROUTINE_EXPERIENCES_ENRICHMENT_TOKEN: "   " });
      assertEq(map["experiences-enrichment"], { trig: "trig_exp", token: "tok_exp_wrong" }, "d2: a blank override is ignored");
      assertEq(diag.override_keys, [], "d2: a blank override is not reported");
    }

    // ── d3: overrides can add an allowlisted agent; work without the JSON ───
    {
      const { map, diag } = parseRoutines({
        FIRE_ROUTINE_EXPERIENCES_ENRICHMENT_TRIG: "trig_exp_new",
        FIRE_ROUTINE_EXPERIENCES_ENRICHMENT_TOKEN: "tok_exp_new",
      });
      assertEq(map, { "experiences-enrichment": { trig: "trig_exp_new", token: "tok_exp_new" } }, "d3: FIRE_ROUTINES unset + both overrides → one entry");
      assertEq(diag.override_keys, ["experiences-enrichment"], "d3: override reported when the JSON is absent");
    }
    {
      const { map, diag } = parseRoutines({ FIRE_ROUTINE_EXPERIENCES_ENRICHMENT_TOKEN: "tok_exp_new" });
      assertEq(map, {}, "d3: a token alone cannot create an entry with no trig");
      assertEq(diag.override_keys, [], "d3: incomplete override not reported as applied");
      assertEq(diag.override_ignored, ["FIRE_ROUTINE_EXPERIENCES_ENRICHMENT_TOKEN"], "d3: … but named in override_ignored");
    }
    {
      const { map } = parseRoutines({
        FIRE_ROUTINES: "{not json",
        FIRE_ROUTINE_LOKAL_AGENT_ENRICHMENT_TRIG: "trig_lae",
        FIRE_ROUTINE_LOKAL_AGENT_ENRICHMENT_TOKEN: "tok_lae",
      });
      assertEq(map, { "lokal-agent-enrichment": { trig: "trig_lae", token: "tok_lae" } }, "d3: overrides still apply when FIRE_ROUTINES is unparseable");
    }
    {
      const { map, diag } = parseRoutines({ FIRE_ROUTINE_NOT_AN_AGENT_TRIG: "t", FIRE_ROUTINE_NOT_AN_AGENT_TOKEN: "k" });
      assertEq(map, {}, "d3: an agent neither in the JSON nor in DEFAULT_ALLOWLIST is not created");
      assertEq(diag.override_ignored, ["FIRE_ROUTINE_NOT_AN_AGENT_TOKEN", "FIRE_ROUTINE_NOT_AN_AGENT_TRIG"], "d3: unknown-agent overrides are named in override_ignored (sorted)");
    }
    {
      const { map, diag } = parseRoutines({ FIRE_ROUTINES: json, FIRE_ROUTINE_ORCHESTRATOR_TOKEN: "tok_short_key" });
      assertEq(map["platform-orchestrator"], { trig: "trig_orch", token: "tok_orch" }, "d3: a short-key override name (ORCHESTRATOR) is not applied");
      assertEq(diag.override_ignored, ["FIRE_ROUTINE_ORCHESTRATOR_TOKEN"], "d3: … and is reported in override_ignored instead of vanishing");
    }
    {
      const { diag } = parseRoutines({ FIRE_ROUTINES: json, FIRE_ROUTINE_EXPERIENCES_ENRICHMENT_TOKEN: "tok_exp_new", FIRE_ROUTINE_FOO_SECRET: "x" });
      assertEq(diag.override_ignored, [], "d3: applied overrides and unrelated FIRE_ROUTINE_* vars are not listed as ignored");
    }

    // ── d4: the diag never leaks values ─────────────────────────────────────
    {
      const { diag } = parseRoutines({
        FIRE_ROUTINES: json,
        FIRE_ROUTINE_EXPERIENCES_ENRICHMENT_TRIG: "trig_exp_new",
        FIRE_ROUTINE_EXPERIENCES_ENRICHMENT_TOKEN: "tok_exp_new",
      });
      const s = JSON.stringify(diag);
      assertTrue(!/tok_|trig_/.test(s), "d4: diag carries no trig/token values");
      const { diag: d2 } = parseRoutines({ FIRE_ROUTINE_NOT_AN_AGENT_TOKEN: "tok_secret_value" });
      assertTrue(!JSON.stringify(d2).includes("tok_secret_value"), "d4: override_ignored lists names, never values");
    }

    // ── d5: envelope status ─────────────────────────────────────────────────
    assertEq(dispatchEnvelopeStatus([]), "completed", "d5: nothing fired → completed");
    assertEq(dispatchEnvelopeStatus([{ ok: true }, { ok: true }]), "completed", "d5: all fired → completed");
    assertEq(dispatchEnvelopeStatus([{ ok: true }, { ok: false }]), "partial", "d5: some failed → partial");
    assertEq(dispatchEnvelopeStatus([{ ok: false }]), "failed", "d5: all failed → failed");

    // ── d6: the tick uses it ────────────────────────────────────────────────
    const src = fs.readFileSync(path.join(__dirname, "admin-loop-dispatch.ts"), "utf8");
    assertTrue(
      /agent: "loop-dispatcher",\s*trigger_source: "cron",\s*started_at: startedAt,\s*finished_at: finishedAt,\s*status: dispatchEnvelopeStatus\(fired\),/.test(src),
      "d6: the loop-dispatcher envelope takes its status from dispatchEnvelopeStatus(fired)",
    );
    assertEq((src.match(/status: "completed",/g) || []).length, 1, "d6: the only hardcoded completed is the fire-marker (success-only)");
    assertTrue(/if \(r\.ok\) \{[\s\S]{0,400}firemarker-[\s\S]{0,300}status: "completed",/.test(src), "d6: that completed sits inside the r.ok fire-marker block");

    // ── d7: finished_at lookback (long run started >1h ago, finished recently) ──
    // Bug: planNow() listed runs by started_at >= now-1h, computeWakeList judges freshness
    // by finished_at, so a run >60 min long never had its next_suggested seen.
    const envKeys = ["FIRE_ROUTINES", "DISPATCH_PLAN_FINISHED_LOOKBACK_MIN", "DISPATCH_WINDOW_MIN", "DISPATCH_ACTIVE_START_UTC", "DISPATCH_ACTIVE_END_UTC"];
    const savedEnv: Record<string, string | undefined> = {};
    for (const k of envKeys) savedEnv[k] = process.env[k];
    const restoreDb = __pinInMemoryDbForTesting();
    try {
      for (const k of envKeys) delete process.env[k];
      process.env.FIRE_ROUTINES = JSON.stringify({ orchestrator: { trig: "trig_o", token: "tok_o" } });
      const min = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
      let seq = 0;
      const put = (agent: string, startAgoMin: number, finAgoMin: number | null, next: string[] | null) => {
        recordRun({
          run_id: `d7-${++seq}`,
          vertical: "rfb",
          agent,
          trigger_source: "cron",
          started_at: min(startAgoMin),
          finished_at: finAgoMin === null ? (null as any) : min(finAgoMin),
          status: "completed",
          claims: [],
          evidence: [],
          next_suggested: next ?? undefined,
        });
      };
      const wakes = () => planNow().wake.map((w) => w.agent);
      const clear = () => { const { getDb } = require("../database/init"); getDb().prepare("DELETE FROM runs").run(); };

      // 1. started 110 min ago, finished 5 min ago, self-continue → exactly one wake
      put("platform-orchestrator", 110, 5, ["platform-orchestrator"]);
      assertEq(wakes(), ["platform-orchestrator"], "d7.1: long run finished recently -> one wake of platform-orchestrator");

      // 5. knob 0 disables the OR-part → run invisible again (old behaviour)
      process.env.DISPATCH_PLAN_FINISHED_LOOKBACK_MIN = "0";
      assertEq(wakes(), [], "d7.5: DISPATCH_PLAN_FINISHED_LOOKBACK_MIN=0 disables the finished_at lookback");
      delete process.env.DISPATCH_PLAN_FINISHED_LOOKBACK_MIN;

      // 2. a newer run/fire-marker for the same agent after it finished → already continued
      put("platform-orchestrator", 1, 1, []);
      assertEq(wakes(), [], "d7.2: newer run for platform-orchestrator after finish -> no wake (already continued)");

      // 3a. finished 50 min ago (outside 45-min window) → no wake
      clear();
      put("platform-orchestrator", 110, 50, ["platform-orchestrator"]);
      assertEq(wakes(), [], "d7.3a: finished 50 min ago (outside window) -> no wake");
      // 3b. still in flight (finished_at null) → no wake
      clear();
      put("platform-orchestrator", 110, null, ["platform-orchestrator"]);
      assertEq(wakes(), [], "d7.3b: started 110 min ago, in flight -> no wake");

      // 4. listRecentRuns default behaviour unchanged; option adds the finished-recently run
      clear();
      put("platform-orchestrator", 120, 1, ["x"]);
      put("platform-orchestrator", 30, 20, null);
      put("platform-orchestrator", 120, 90, null);
      assertEq(listRecentRuns({ sinceHours: 1 }).length, 1, "d7.4: without finishedSinceMinutes only started_at-fresh rows");
      assertEq(listRecentRuns({ sinceHours: 1, finishedSinceMinutes: 0 }).length, 1, "d7.4: finishedSinceMinutes=0 == unset");
      assertEq(listRecentRuns({ sinceHours: 1, finishedSinceMinutes: 60 }).length, 2, "d7.4: with option, run started 2h ago finished 1 min ago is included (90-min-old finish still excluded)");
      assertEq(listRecentRuns({ sinceHours: 1, finishedSinceMinutes: 60, agent: "nobody" }).length, 0, "d7.4: agent filter ANDs with the OR-part");
      // started_at-fresh rows stay in even when finished_at is old or NULL (pins the OR, not finished_at-only)
      clear();
      put("platform-orchestrator", 30, null, null);
      assertEq(listRecentRuns({ sinceHours: 1, finishedSinceMinutes: 5 }).length, 1, "d7.4: in-flight run started 30 min ago is still listed with the option");

      // knob parsing
      assertEq(resolveFinishedLookbackMin(undefined, 45), 60, "d7: default lookback = windowMin + 15");
      assertEq(resolveFinishedLookbackMin("0", 45), 0, "d7: 0 disables");
      assertEq(resolveFinishedLookbackMin("90", 45), 90, "d7: valid integer overrides");
      assertEq(resolveFinishedLookbackMin("-5", 45), 60, "d7: negative -> default");
      assertEq(resolveFinishedLookbackMin("abc", 45), 60, "d7: garbage -> default");
      assertEq(resolveFinishedLookbackMin("1.5", 45), 60, "d7: non-integer -> default");
      assertEq(resolveFinishedLookbackMin("999999999999", 45), 1440, "d7: huge value clamped to 1440");
      process.env.DISPATCH_PLAN_FINISHED_LOOKBACK_MIN = "999999999999";
      assertEq(Array.isArray(planNow().wake), true, "d7: planNow does not throw on a huge knob value");
      delete process.env.DISPATCH_PLAN_FINISHED_LOOKBACK_MIN;
    } finally {
      for (const k of envKeys) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
      restoreDb();
    }
  } catch (err) {
    failed++;
    failures.push(`admin-loop-dispatch: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  process.env.NODE_ENV = "test";
  process.env.EMAIL_FORCE_DRY_RUN = "true";
  process.env.OFFTHREAD_STATS_DISABLED = "1";
  const r = runAdminLoopDispatchTests({ log: true });
  console.log(`\nadmin-loop-dispatch: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    for (const f of r.failures) console.log(f);
    process.exit(1);
  }
  process.exit(0);
}
