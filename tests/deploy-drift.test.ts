/**
 * deploy-drift.test.ts — unit tests for scripts/deploy-drift.js, the decision
 * logic behind .github/workflows/deploy-drift-sweep.yml
 * (dev-request 2026-11-16-fleet-gate-dispatch-sen-automerge).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx tests/deploy-drift.test.ts
 *   2. Wired into the gate: tests/test.ts calls runDeployDriftTests() and
 *      folds its pass/fail counts into the `npm test` summary.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const drift = require("../scripts/deploy-drift.js") as {
  GRACE_MINUTES: number;
  parseHealth: (text: unknown) => { ok: boolean; sha?: string; error?: string };
  MAX_WAIT_MINUTES: number;
  AUTO_MERGE_WAIT_MINUTES: number;
  POLL_SECONDS: number;
  decideDeployDrift: (input: Record<string, unknown>) => { action: string; reason: string; level: string; code: string };
  countPendingAutoMerge: (pulls: unknown) => number;
  shouldKeepWaiting: (
    decision: { action: string; code?: string } | null,
    ctx: Record<string, unknown>,
  ) => { wait: boolean; reason: string };
};

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const MAIN = "a".repeat(40);
const PROD = "b".repeat(40);
const NOW = new Date("2026-11-16T19:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60000).toISOString();

function base(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mainSha: MAIN,
    mainCommittedAt: minsAgo(30),
    health: { ok: true, sha: PROD },
    compareStatus: "ahead",
    runs: [],
    now: NOW,
    ...over,
  };
}

export function runDeployDriftTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function expectAction(input: Record<string, unknown>, expected: string, label: string): void {
    const d = drift.decideDeployDrift(input);
    if (d.action === expected) {
      passed++;
      if (log) console.log(`  ok ${label} — ${d.reason}`);
    } else {
      failed++;
      const msg = `✗ ${label}: expected ${expected}, got ${d.action} (${d.reason})`;
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

  // Grace + cron interval must stay within the 15-min detection budget (cron is
  // now only a backstop; the event-driven path is bounded by MAX_WAIT_MINUTES).
  assertTrue(drift.GRACE_MINUTES + 5 <= 15, "GRACE_MINUTES + 5-min cron <= 15 min");

  // parseHealth
  assertTrue(drift.parseHealth(JSON.stringify({ git_sha: MAIN })).sha === MAIN, "parseHealth: valid git_sha");
  assertTrue(!drift.parseHealth("<html>").ok, "parseHealth: non-JSON → not ok");
  assertTrue(!drift.parseHealth(JSON.stringify({ status: "ok" })).ok, "parseHealth: missing git_sha → not ok");
  assertTrue(!drift.parseHealth(JSON.stringify({ git_sha: "97f584c" })).ok, "parseHealth: short sha → not ok");
  assertTrue(!drift.parseHealth("").ok, "parseHealth: empty → not ok");

  // decideDeployDrift
  expectAction(base({ health: { ok: true, sha: MAIN }, compareStatus: null }), "noop", "prod == main → noop");
  expectAction(base({ compareStatus: "identical" }), "noop", "compare identical → noop");
  expectAction(base({ mainCommittedAt: minsAgo(3) }), "noop", "ahead + within grace → noop");
  expectAction(base(), "dispatch", "ahead + past grace + no runs → dispatch");
  expectAction(
    base({ runs: [{ event: "pull_request", status: "in_progress", conclusion: null, head_sha: "c".repeat(40) }] }),
    "dispatch",
    "pull_request run in progress does not block",
  );
  expectAction(
    base({ runs: [{ event: "workflow_dispatch", status: "in_progress", conclusion: null, head_sha: "e".repeat(40) }] }),
    "noop",
    "deploy in progress on another sha → noop",
  );
  expectAction(
    base({ runs: [{ event: "push", status: "queued", conclusion: null, head_sha: MAIN }] }),
    "noop",
    "deploy queued → noop",
  );
  expectAction(base({ compareStatus: "behind" }), "noop", "behind → noop (never deploy backwards)");
  expectAction(base({ compareStatus: "diverged" }), "noop", "diverged → noop");
  expectAction(base({ compareStatus: null }), "noop", "compare unavailable → noop");
  expectAction(
    base({ runs: [{ event: "workflow_dispatch", status: "completed", conclusion: "failure", head_sha: MAIN, updated_at: minsAgo(20) }] }),
    "noop",
    "failed run for same sha → noop (no loop)",
  );
  expectAction(
    base({ runs: [{ event: "workflow_dispatch", status: "completed", conclusion: "success", head_sha: MAIN, updated_at: minsAgo(20) }] }),
    "noop",
    "already dispatched for this sha → noop (at most once)",
  );
  expectAction(
    base({ runs: [{ event: "push", status: "completed", conclusion: "success", head_sha: MAIN, updated_at: minsAgo(2) }] }),
    "noop",
    "push deploy just succeeded → noop (settling)",
  );
  expectAction(
    base({ runs: [{ event: "push", status: "completed", conclusion: "success", head_sha: MAIN, updated_at: minsAgo(25) }] }),
    "noop",
    "old successful push deploy but prod still stale → noop (head already deployed once; human decides)",
  );
  {
    // B1: push deployed head H, operator then rolled prod back to ancestor P
    // (fly releases rollback / fly deploy --image). compare P...H = ahead, no
    // workflow_dispatch run for H. The sweep must NOT redeploy over the rollback.
    const input = base({
      mainCommittedAt: minsAgo(120),
      runs: [
        { event: "push", status: "completed", conclusion: "success", head_sha: MAIN, updated_at: minsAgo(90) },
        { event: "push", status: "completed", conclusion: "success", head_sha: PROD, updated_at: minsAgo(200) },
      ],
    });
    expectAction(input, "noop", "Fly rollback to ancestor after successful push deploy → noop (never redeploy over rollback)");
    const d = drift.decideDeployDrift(input);
    assertTrue(d.level === "warning" && /rollback/.test(d.reason) && /human/.test(d.reason), "rollback noop is a warning naming rollback + human");
  }
  {
    const d = drift.decideDeployDrift(
      base({ runs: [{ event: "workflow_dispatch", status: "completed", conclusion: "success", head_sha: MAIN, updated_at: minsAgo(3) }] }),
    );
    assertTrue(d.action === "noop" && d.level === "info" && /catch up/.test(d.reason), "gate dispatch just succeeded → info settling noop (settle checked before human warning)");
  }
  expectAction(
    base({ runs: [{ event: "push", status: "completed", conclusion: "failure", head_sha: MAIN, updated_at: minsAgo(20) }] }),
    "noop",
    "push run for head concluded failure → noop",
  );
  expectAction(
    base({ runs: [{ event: "push", status: "completed", conclusion: "cancelled", head_sha: MAIN, updated_at: minsAgo(20) }] }),
    "noop",
    "push run for head concluded cancelled → noop",
  );
  expectAction(
    base({ runs: [{ event: "push", status: "queued", conclusion: null, head_sha: "d".repeat(40) }] }),
    "noop",
    "queued run on another sha → noop (deploy underway)",
  );
  expectAction(
    base({ runs: [{ event: "pull_request", status: "completed", conclusion: "success", head_sha: MAIN, updated_at: minsAgo(20) }] }),
    "dispatch",
    "completed pull_request build-check for head does not count as a deploy",
  );
  expectAction(
    base({ runs: [{ event: "workflow_dispatch", status: "completed", conclusion: "failure", head_sha: PROD, updated_at: minsAgo(40) }] }),
    "dispatch",
    "failed run for an OLDER sha does not block the new head",
  );
  expectAction(base({ health: { ok: false, error: "/health HTTP 503" } }), "noop", "health error → noop");
  expectAction(base({ health: drift.parseHealth("not json") }), "noop", "health non-JSON → noop");
  expectAction(base({ mainCommittedAt: null }), "noop", "unknown commit date → noop");
  expectAction(base({ mainSha: "" }), "noop", "unknown main sha → noop");

  // decision codes (stable tags consumed by shouldKeepWaiting)
  const code = (over: Record<string, unknown>) => drift.decideDeployDrift(base(over)).code;
  assertTrue(code({ health: { ok: true, sha: MAIN } }) === "in_sync", "code: prod == main → in_sync");
  assertTrue(code({ mainCommittedAt: minsAgo(3) }) === "within_grace", "code: ahead within grace → within_grace");
  assertTrue(code({}) === "dispatch", "code: dispatch → dispatch");
  assertTrue(code({ compareStatus: "diverged" }) === "not_ahead", "code: diverged → not_ahead");
  assertTrue(code({ compareStatus: "behind" }) === "not_ahead", "code: behind → not_ahead");
  assertTrue(code({ health: { ok: false, error: "x" } }) === "health_unusable", "code: health error → health_unusable");
  assertTrue(
    code({ runs: [{ event: "workflow_dispatch", status: "in_progress", conclusion: null, head_sha: MAIN }] }) === "deploy_underway",
    "code: run in progress → deploy_underway",
  );
  assertTrue(
    code({ runs: [{ event: "push", status: "completed", conclusion: "success", head_sha: MAIN, updated_at: minsAgo(60) }] }) === "head_already_deployed",
    "code: head deployed once, prod older → head_already_deployed",
  );

  // countPendingAutoMerge
  assertTrue(drift.countPendingAutoMerge(null) === 0, "countPendingAutoMerge: null → 0");
  assertTrue(
    drift.countPendingAutoMerge([
      { state: "open", auto_merge: { merge_method: "squash" }, base: { ref: "main" } },
      { state: "open", auto_merge: null, base: { ref: "main" } },
      { state: "open", auto_merge: { merge_method: "squash" }, base: { ref: "intl-staging" } },
      { state: "closed", auto_merge: { merge_method: "squash" }, base: { ref: "main" } },
    ]) === 1,
    "countPendingAutoMerge: only open auto-merge PRs into main count",
  );

  // shouldKeepWaiting — event-driven loop control
  const T0 = NOW.getTime();
  const at = (m: number) => new Date(T0 + m * 60000);
  const wait = (over: Record<string, unknown>, ctx: Record<string, unknown>) =>
    drift.shouldKeepWaiting(drift.decideDeployDrift(base(over)), { startedAt: at(0), now: at(0), pendingAutoMerge: 0, ...ctx }).wait;
  assertTrue(drift.MAX_WAIT_MINUTES <= 18, "MAX_WAIT_MINUTES <= 18");
  assertTrue(
    drift.AUTO_MERGE_WAIT_MINUTES + drift.GRACE_MINUTES + drift.POLL_SECONDS / 60 <= drift.MAX_WAIT_MINUTES,
    "a merge landing inside the auto-merge wait still fits grace + one poll under the cap",
  );
  assertTrue(!wait({ health: { ok: true, sha: MAIN } }, {}), "pre-check: prod == main, no auto-merge PR → exit immediately");
  assertTrue(wait({ health: { ok: true, sha: MAIN } }, { pendingAutoMerge: 2 }), "prod == main + open auto-merge PR → wait");
  assertTrue(
    !wait({ health: { ok: true, sha: MAIN } }, { pendingAutoMerge: 1, now: at(drift.AUTO_MERGE_WAIT_MINUTES) }),
    "prod == main + auto-merge PR past auto-merge wait budget → stop",
  );
  assertTrue(wait({ mainCommittedAt: minsAgo(3) }, {}), "within grace → wait");
  assertTrue(wait({ mainCommittedAt: minsAgo(3) }, { now: at(10) }), "within grace at 10 min elapsed → still wait");
  assertTrue(!wait({ mainCommittedAt: minsAgo(3) }, { now: at(17.5) }), "within grace but cap reached → stop");
  assertTrue(!wait({}, {}), "dispatch → stop (caller dispatches once)");
  assertTrue(!wait({ compareStatus: "diverged" }, { pendingAutoMerge: 3 }), "diverged → stop (never deploy backwards)");
  assertTrue(!wait({ compareStatus: null }, {}), "compare unavailable → stop (fail closed)");
  assertTrue(!wait({ health: { ok: false, error: "/health HTTP 503" } }, { pendingAutoMerge: 1 }), "health fetch failure → stop (fail closed)");
  assertTrue(
    !wait({ runs: [{ event: "workflow_dispatch", status: "in_progress", conclusion: null, head_sha: MAIN }] }, {}),
    "deploy underway → stop (its completion re-triggers the sweep)",
  );
  assertTrue(
    !wait({ runs: [{ event: "workflow_dispatch", status: "completed", conclusion: "success", head_sha: MAIN, updated_at: minsAgo(60) }] }, {}),
    "head already deployed (possible rollback) → stop",
  );
  assertTrue(
    !wait({ runs: [{ event: "push", status: "completed", conclusion: "failure", head_sha: MAIN, updated_at: minsAgo(20) }] }, {}),
    "head deploy failed → stop (no loop)",
  );
  assertTrue(!drift.shouldKeepWaiting(null, { startedAt: at(0), now: at(0) }).wait, "no decision → stop");
  assertTrue(
    !drift.shouldKeepWaiting({ action: "noop", code: "within_grace" }, { startedAt: "x", now: at(0) }).wait,
    "unknown clock → stop",
  );

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runDeployDriftTests({ log: true });
  console.log(`deploy-drift: ${r.passed} passed, ${r.failed} failed`);
  process.exit(r.failed > 0 ? 1 : 0);
}
