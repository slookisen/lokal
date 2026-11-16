'use strict';
/**
 * deploy-drift.js — pure decision logic for `.github/workflows/deploy-drift-sweep.yml`.
 *
 * Problem (dev-request 2026-11-16-fleet-gate-dispatch-sen-automerge): a merge
 * done under GITHUB_TOKEN (the fleet gate's auto-merge) fires no `push` event,
 * so fly-deploy.yml only runs if the gate itself sees the merge land within
 * its ~12 s poll and dispatches it. A later auto-merge never deploys, and prod
 * stays on an old commit until some unrelated merge dispatches a deploy.
 *
 * Safety net: every few minutes, compare main's head with prod's
 * /health.git_sha and dispatch fly-deploy.yml on main when main has been
 * ahead of prod for longer than GRACE_MINUTES. All decisions fail closed:
 * anything unexpected means "do nothing and say why".
 *
 * Dependency-free CommonJS so the workflow can require() it straight from the
 * checkout without `npm ci`. Unit tests: tests/deploy-drift.test.ts (wired
 * into `npm test`).
 */

/** Minutes main's head must be older than before the sweep dispatches. With a
 *  5-min cron the worst-case detection latency is GRACE + 5 = 15 min. */
const GRACE_MINUTES = 10;

/** After a successful fly-deploy run for the head sha, wait this long for
 *  /health to report it before treating prod as still stale. */
const POST_DEPLOY_SETTLE_MINUTES = GRACE_MINUTES;

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Parse the body of GET https://rettfrabonden.com/health.
 * @param {string|null|undefined} text
 * @returns {{ ok: true, sha: string } | { ok: false, error: string }}
 */
function parseHealth(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'empty /health body' };
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: '/health is not JSON' };
  }
  const sha = body && typeof body === 'object' ? body.git_sha : undefined;
  if (typeof sha !== 'string' || !SHA_RE.test(sha.trim().toLowerCase())) {
    return { ok: false, error: '/health has no valid 40-hex git_sha' };
  }
  return { ok: true, sha: sha.trim().toLowerCase() };
}

/**
 * Decide whether the sweep should dispatch fly-deploy.yml on main.
 *
 * @param {object} input
 * @param {string} input.mainSha               main's head sha
 * @param {string|null} input.mainCommittedAt  ISO committer date of main's head
 * @param {{ok:boolean, sha?:string, error?:string}} input.health  parseHealth() result
 *        (or {ok:false, error} when the fetch itself failed)
 * @param {string|null} input.compareStatus    status of GET compare/{prod}...{main}
 *        ('ahead' | 'identical' | 'behind' | 'diverged'), null if the call failed
 * @param {Array<{event:string, status:string, conclusion:string|null, head_sha:string, updated_at?:string}>} input.runs
 *        recent fly-deploy.yml runs (any event; pull_request runs are ignored)
 * @param {Date|number} input.now
 * @param {number} [input.graceMinutes]
 * @returns {{ action: 'dispatch'|'noop', reason: string, level: 'info'|'warning' }}
 */
function decideDeployDrift(input) {
  const grace = typeof input.graceMinutes === 'number' ? input.graceMinutes : GRACE_MINUTES;
  const nowMs = input.now instanceof Date ? input.now.getTime() : Number(input.now);
  const mainSha = String(input.mainSha || '').toLowerCase();
  const noop = (reason, level = 'info') => ({ action: 'noop', reason, level });

  if (!SHA_RE.test(mainSha)) return noop(`main head sha unknown (${input.mainSha || 'empty'})`, 'warning');

  const health = input.health || { ok: false, error: 'no /health result' };
  if (!health.ok) return noop(`prod /health unusable: ${health.error || 'unknown error'} — fail closed`, 'warning');
  const prodSha = String(health.sha).toLowerCase();

  if (prodSha === mainSha) return noop(`prod runs main head ${short(mainSha)} — in sync`);

  const status = input.compareStatus;
  if (status === 'identical') return noop(`compare says ${short(prodSha)}...${short(mainSha)} identical`);
  if (status !== 'ahead') {
    return noop(
      `compare ${short(prodSha)}...${short(mainSha)} is "${status || 'unavailable'}" — main is not strictly ahead of prod; never deploy backwards or over a rollback`,
      'warning',
    );
  }

  // Only push / workflow_dispatch runs can deploy; pull_request runs are build-checks.
  const deployRuns = (Array.isArray(input.runs) ? input.runs : []).filter(
    (r) => r && r.event !== 'pull_request',
  );

  const active = deployRuns.find((r) => r.status !== 'completed');
  if (active) {
    return noop(`a fly-deploy run is already ${active.status} (${short(active.head_sha)}) — deploy underway`);
  }

  const forHead = deployRuns.filter((r) => String(r.head_sha || '').toLowerCase() === mainSha);
  const bad = forHead.find((r) => r.conclusion !== 'success');
  if (bad) {
    return noop(
      `fly-deploy for ${short(mainSha)} already concluded "${bad.conclusion}" — not redispatching (no loop); needs a human`,
      'warning',
    );
  }
  if (forHead.some((r) => r.event === 'workflow_dispatch')) {
    return noop(
      `fly-deploy was already dispatched for ${short(mainSha)} and succeeded, yet prod still reports ${short(prodSha)} — not redispatching (at most once per sha); needs a human`,
      'warning',
    );
  }
  const recentSuccess = forHead.find(
    (r) => r.updated_at && nowMs - Date.parse(r.updated_at) < POST_DEPLOY_SETTLE_MINUTES * 60000,
  );
  if (recentSuccess) {
    return noop(`fly-deploy for ${short(mainSha)} succeeded <${POST_DEPLOY_SETTLE_MINUTES} min ago — waiting for /health to catch up`);
  }

  const committedMs = input.mainCommittedAt ? Date.parse(input.mainCommittedAt) : NaN;
  if (!Number.isFinite(committedMs)) return noop('main head commit date unknown — fail closed', 'warning');
  const ageMin = (nowMs - committedMs) / 60000;
  if (ageMin < grace) {
    return noop(`main ${short(mainSha)} is ahead of prod ${short(prodSha)} but only ${ageMin.toFixed(1)} min old (grace ${grace} min) — letting the normal deploy path win`);
  }

  return {
    action: 'dispatch',
    reason: `main ${short(mainSha)} ahead of prod ${short(prodSha)} for ${ageMin.toFixed(1)} min (> grace ${grace} min) with no deploy run for it — dispatching fly-deploy.yml on main`,
    level: 'warning',
  };
}

function short(sha) {
  return String(sha || '?').slice(0, 7);
}

module.exports = { GRACE_MINUTES, POST_DEPLOY_SETTLE_MINUTES, parseHealth, decideDeployDrift };
