/**
 * admin-loop-dispatch-fire-alert.test.ts — P0 alert at the first /fire 401/403 per
 * agent per UTC day (dev-requests/2026-10-30-fire-feil-detektor-og-varsel-ved-4xx.md,
 * slice 2). Pins:
 *   a1  first 401 -> one alert; a second 401 (later tick) -> none
 *   a2  403 behaves like 401; 503 / 404 / 429 / network(0) never alert
 *   a3  two agents, first 401 each -> one alert each; dedup is per agent
 *   a4  a new UTC day -> alerts again (pure helper + ledger marker dated yesterday)
 *   a5  success / shadow mode never alert; envelope notes/claims otherwise unchanged
 *   a6  alert send that throws never breaks the tick; the envelope is still recorded
 *   a7  restart: in-memory set empty but ledger says already alerted -> no alert
 *   p   pure helpers (selectFireAuthAlerts, alertedTodayFromRuns)
 * In-memory DB + stubbed fetch + injected sender: no network, no real e-mail.
 *
 * Run: npx tsx src/routes/admin-loop-dispatch-fire-alert.test.ts  (also wired into tests/test.ts)
 */

import {
  runDispatchTick,
  selectFireAuthAlerts,
  alertedTodayFromRuns,
  __setFireAlertSendForTesting,
  __resetFireAlertStateForTesting,
} from "./admin-loop-dispatch";
import { __pinInMemoryDbForTesting } from "../database/init";
import { listRecentRuns, recordRun } from "../services/run-ledger";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runAdminLoopDispatchFireAlertTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const assertEq = (actual: unknown, expected: unknown, label: string): void => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  };

  const envKeys = [
    "FIRE_ROUTINES", "ADMIN_NOTIFICATION_EMAIL", "DISPATCH_WINDOW_MIN",
    "DISPATCH_ACTIVE_START_UTC", "DISPATCH_ACTIVE_END_UTC", "DISPATCH_PLAN_FINISHED_LOOKBACK_MIN",
  ];
  const savedEnv: Record<string, string | undefined> = {};
  for (const k of envKeys) savedEnv[k] = process.env[k];
  const realFetch = globalThis.fetch;
  const origErr = console.error;
  const restoreDb = __pinInMemoryDbForTesting();

  try {
    console.error = () => {};
    for (const k of envKeys) delete process.env[k];
    process.env.ADMIN_NOTIFICATION_EMAIL = "admin@example.test";
    process.env.FIRE_ROUTINES = JSON.stringify({
      "experiences-enrichment": { trig: "trig_exp", token: "tok_exp" },
      "rfb-customer-service": { trig: "trig_cs", token: "tok_cs" },
    });

    // ── pure helpers ─────────────────────────────────────────────────────────
    const F = (agent: string, status: number, ok = false) => ({ agent, ok, status });
    assertEq(selectFireAuthAlerts([F("a", 401), F("b", 403)], new Set()), ["a", "b"], "p: 401 and 403 select");
    assertEq(selectFireAuthAlerts([F("a", 503), F("b", 404), F("c", 429), F("d", 0), F("e", 200, true)], new Set()), [], "p: other statuses never select");
    assertEq(selectFireAuthAlerts([F("a", 401), F("a", 401)], new Set()), ["a"], "p: same agent twice in one tick -> once");
    assertEq(selectFireAuthAlerts([F("a", 401), F("b", 401)], new Set(["a"])), ["b"], "p: already-alerted agent skipped");
    const now = new Date("2026-11-03T10:00:00.000Z");
    const mk = (fin: string, alerted?: string[], kind = "wakes_failed", agent = "loop-dispatcher") => ({
      agent, started_at: fin, finished_at: fin,
      claims: [{ meta: { kind, ...(alerted ? { alerted } : {}) } }],
    });
    assertEq([...alertedTodayFromRuns([mk("2026-11-03T01:00:00.000Z", ["a"])], now)], ["a"], "p: today's marker counts");
    assertEq([...alertedTodayFromRuns([mk("2026-11-02T23:59:59.000Z", ["a"])], now)], [], "a4: yesterday's marker does not count");
    assertEq([...alertedTodayFromRuns([mk("2026-11-03T01:00:00.000Z", ["a"], "other")], now)], [], "p: only wakes_failed meta counts");
    assertEq([...alertedTodayFromRuns([mk("2026-11-03T01:00:00.000Z", ["a"], "wakes_failed", "someone-else")], now)], [], "p: only loop-dispatcher runs count");

    // ── tick harness ─────────────────────────────────────────────────────────
    let fetchStatus: Record<string, number> = {};
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      const agent = u.includes("trig_exp") ? "experiences-enrichment" : "rfb-customer-service";
      const st = fetchStatus[agent] ?? 200;
      if (st === 0) throw new Error("ECONNRESET");
      return new Response(st >= 400 ? "Token is not authorized for this routine" : "{}", { status: st });
    }) as any;
    const sent: Array<{ to: string; subject: string; textContent: string; omitAgentHeader?: boolean }> = [];
    let sendThrows = false;
    __setFireAlertSendForTesting(async (o) => {
      if (sendThrows) throw new Error("smtp down");
      sent.push(o);
      return { success: true, messageId: "m" };
    });
    const { getDb } = require("../database/init");
    const clearLedger = () => getDb().prepare("DELETE FROM runs").run();
    let seq = 0;
    // A fresh suggester run that wants both agents woken; failed fires leave no
    // fire-marker so they stay wake candidates on every later tick.
    const seed = () =>
      recordRun({
        run_id: `fa-seed-${++seq}`, vertical: "rfb", agent: "platform-orchestrator", trigger_source: "cron",
        started_at: new Date().toISOString(), finished_at: new Date().toISOString(), status: "completed",
        claims: [], evidence: [], next_suggested: ["experiences-enrichment", "rfb-customer-service"],
      });
    const reset = () => {
      clearLedger(); __resetFireAlertStateForTesting(); sent.length = 0; sendThrows = false; fetchStatus = {}; seed();
    };
    const dispatcherRuns = () => listRecentRuns({ agent: "loop-dispatcher", sinceHours: 48 });

    // a1: first 401 -> one alert, second tick -> none
    reset();
    fetchStatus = { "experiences-enrichment": 401, "rfb-customer-service": 200 };
    let r = await runDispatchTick("active");
    assertEq(sent.length, 1, "a1: first 401 -> exactly one alert");
    assertEq(sent[0]?.subject, "[P0] loop-dispatch: /fire HTTP401 for experiences-enrichment", "a1: subject names status and agent");
    assertEq(sent[0]?.to, "admin@example.test", "a1: sent to ADMIN_NOTIFICATION_EMAIL");
    assertEq(sent[0]?.omitAgentHeader, true, "a1: omitAgentHeader set");
    assertEq(/Token is not authorized/.test(sent[0]?.textContent ?? "") && /only Daniel can re-issue/.test(sent[0]?.textContent ?? ""), true, "a1: body has detail + Daniel line");
    assertEq(/tok_exp|trig_exp/.test(sent[0]?.textContent ?? ""), false, "a1: body never carries token/trigger id");
    assertEq(/FIRE-FAILURES: experiences-enrichment=HTTP401/.test(dispatcherRuns()[0]?.notes ?? ""), true, "a5: FIRE-FAILURES note unchanged");
    assertEq((dispatcherRuns()[0]?.notes ?? "").length <= 480, true, "a5: notes <= 480");
    const meta = dispatcherRuns()[0]?.claims.find((c) => c.meta?.kind === "wakes_failed")?.meta;
    assertEq(meta?.alerted, ["experiences-enrichment"], "a1: marker recorded in wakes_failed meta");
    assertEq(r.fired.length, 2, "a5: both agents still fired");
    seed();
    await runDispatchTick("active");
    assertEq(sent.length, 1, "a1: second 401 same UTC day (later tick) -> no new alert");

    // a7: restart (in-memory empty), ledger says alerted -> no alert
    __resetFireAlertStateForTesting();
    seed();
    await runDispatchTick("active");
    assertEq(sent.length, 1, "a7: restart with durable marker -> no new alert");

    // a4: marker from yesterday only -> alerts again
    reset();
    recordRun({
      run_id: "fa-yday", vertical: "rfb", agent: "loop-dispatcher", trigger_source: "cron",
      started_at: new Date(Date.now() - 30 * 3600_000).toISOString(),
      finished_at: new Date(Date.now() - 30 * 3600_000).toISOString(), status: "partial",
      claims: [{ type: "db_state_change", value: 1, meta: { kind: "wakes_failed", alerted: ["experiences-enrichment"] } }],
      evidence: [],
    });
    fetchStatus = { "experiences-enrichment": 401 };
    await runDispatchTick("active");
    assertEq(sent.length, 1, "a4: marker from a previous UTC day -> first 401 today alerts again");

    // a2: 403 like 401; 503/404/429/network never
    reset();
    fetchStatus = { "experiences-enrichment": 403 };
    await runDispatchTick("active");
    assertEq(sent.map((s) => s.subject), ["[P0] loop-dispatch: /fire HTTP403 for experiences-enrichment"], "a2: 403 alerts");
    for (const st of [503, 404, 429, 0]) {
      reset();
      fetchStatus = { "experiences-enrichment": st, "rfb-customer-service": st };
      await runDispatchTick("active");
      assertEq(sent.length, 0, `a2: status ${st} sends no alert`);
      assertEq(dispatcherRuns().length, 1, `a2: status ${st} still records the envelope`);
    }

    // a3: two agents, each first 401 -> one alert each; per-agent dedup
    reset();
    fetchStatus = { "experiences-enrichment": 401, "rfb-customer-service": 401 };
    await runDispatchTick("active");
    assertEq(sent.map((s) => s.subject).sort(), [
      "[P0] loop-dispatch: /fire HTTP401 for experiences-enrichment",
      "[P0] loop-dispatch: /fire HTTP401 for rfb-customer-service",
    ], "a3: one alert per agent");
    reset();
    fetchStatus = { "experiences-enrichment": 401, "rfb-customer-service": 503 };
    await runDispatchTick("active");
    fetchStatus = { "experiences-enrichment": 401, "rfb-customer-service": 401 };
    seed();
    await runDispatchTick("active");
    assertEq(sent.length, 2, "a3: later first-401 of a second agent still alerts (dedup is per agent)");

    // a5: success and shadow never alert
    reset();
    await runDispatchTick("active");
    assertEq(sent.length, 0, "a5: successful fires never alert");
    reset();
    fetchStatus = { "experiences-enrichment": 401 };
    r = await runDispatchTick("shadow");
    assertEq([sent.length, r.fired.length], [0, 0], "a5: shadow mode fires nothing and never alerts");

    // a6: sender throwing / no address never breaks the tick
    reset();
    sendThrows = true;
    fetchStatus = { "experiences-enrichment": 401 };
    let threw = false;
    try { await runDispatchTick("active"); } catch { threw = true; }
    assertEq(threw, false, "a6: throwing sender does not throw out of runDispatchTick");
    assertEq(dispatcherRuns().length, 1, "a6: envelope still recorded");
    reset();
    delete process.env.ADMIN_NOTIFICATION_EMAIL;
    fetchStatus = { "experiences-enrichment": 401 };
    threw = false;
    try { await runDispatchTick("active"); } catch { threw = true; }
    assertEq([threw, sent.length], [false, 0], "a6: no address configured -> log only, no throw");
  } catch (err) {
    failed++;
    failures.push(`admin-loop-dispatch-fire-alert: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  } finally {
    console.error = origErr;
    globalThis.fetch = realFetch;
    __setFireAlertSendForTesting(null);
    __resetFireAlertStateForTesting();
    for (const k of envKeys) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    restoreDb();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  process.env.NODE_ENV = "test";
  process.env.EMAIL_FORCE_DRY_RUN = "true";
  process.env.OFFTHREAD_STATS_DISABLED = "1";
  runAdminLoopDispatchFireAlertTests({ log: true }).then((r) => {
    console.log(`\nadmin-loop-dispatch-fire-alert: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
