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
  decideDeployDrift: (input: Record<string, unknown>) => { action: string; reason: string; level: string };
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

  // Grace + cron interval must stay within the 15-min detection budget.
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
    base({ runs: [{ event: "workflow_dispatch", status: "in_progress", conclusion: null, head_sha: PROD }] }),
    "noop",
    "deploy in progress → noop",
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
    "dispatch",
    "old successful push deploy but prod still stale → one dispatch",
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

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runDeployDriftTests({ log: true });
  console.log(`deploy-drift: ${r.passed} passed, ${r.failed} failed`);
  process.exit(r.failed > 0 ? 1 : 0);
}
