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
 * Safety net: on workflow_run (PR CI / gate completion, with a bounded
 * wait-and-re-evaluate loop driven by shouldKeepWaiting) and on a cron
 * backstop, compare main's head with prod's
 * /health.git_sha and dispatch fly-deploy.yml on main when main has been
 * ahead of prod for longer than GRACE_MINUTES and no push/workflow_dispatch
 * run of fly-deploy.yml exists for that head sha at all (so it never redeploys
 * over a Fly-level rollback). All decisions fail closed:
 * anything unexpected means "do nothing and say why".
 *
 * Dependency-free CommonJS so the workflow can require() it straight from the
 * checkout without `npm ci`. Unit tests: tests/deploy-drift.test.ts (wired
 * into `npm test`).
 */

/** Minutes main's head must be older than before the sweep dispatches. In the
 *  event-driven (workflow_run) mode the run re-evaluates every POLL_SECONDS, so
 *  a dispatch follows ~GRACE + 1 min after the merge; the 5-min cron is only a
 *  backstop (GitHub drops most scheduled runs). */
const GRACE_MINUTES = 10;

/** After a successful fly-deploy run for the head sha, wait this long for
 *  /health to report it before treating prod as still stale. */
const POST_DEPLOY_SETTLE_MINUTES = GRACE_MINUTES;

const SHA_RE = /^[0-9a-f]{40}$/;

/** Events under which fly-deploy.yml actually deploys (pull_request runs only build). */
const DEPLOY_EVENTS = new Set(['push', 'workflow_dispatch']);

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
 *        recent fly-deploy.yml runs (any event; pull_request runs are ignored).
 *        Dispatch happens only when NO push/workflow_dispatch run exists for
 *        main's head at all: once the head has been deployed (any conclusion),
 *        prod lagging behind it is a failure or a deliberate rollback, which
 *        a human resolves — the sweep never redeploys over it.
 * @param {Date|number} input.now
 * @param {number} [input.graceMinutes]
 * @returns {{ action: 'dispatch'|'noop', reason: string, level: 'info'|'warning', code: string }}
 *          `code` is a stable machine tag for the branch taken (used by shouldKeepWaiting).
 */
function decideDeployDrift(input) {
  const grace = typeof input.graceMinutes === 'number' ? input.graceMinutes : GRACE_MINUTES;
  const nowMs = input.now instanceof Date ? input.now.getTime() : Number(input.now);
  const mainSha = String(input.mainSha || '').toLowerCase();
  const noop = (reason, level = 'info', code = 'other') => ({ action: 'noop', reason, level, code });

  if (!SHA_RE.test(mainSha)) return noop(`main head sha unknown (${input.mainSha || 'empty'})`, 'warning', 'main_sha_unknown');

  const health = input.health || { ok: false, error: 'no /health result' };
  if (!health.ok) return noop(`prod /health unusable: ${health.error || 'unknown error'} — fail closed`, 'warning', 'health_unusable');
  const prodSha = String(health.sha).toLowerCase();

  if (prodSha === mainSha) return noop(`prod runs main head ${short(mainSha)} — in sync`, 'info', 'in_sync');

  const status = input.compareStatus;
  if (status === 'identical') return noop(`compare says ${short(prodSha)}...${short(mainSha)} identical`, 'info', 'identical');
  if (status !== 'ahead') {
    return noop(
      `compare ${short(prodSha)}...${short(mainSha)} is "${status || 'unavailable'}" — main is not strictly ahead of prod; never deploy backwards or over a rollback`,
      'warning',
      'not_ahead',
    );
  }

  // Any non-pull_request run that is not finished counts as a deploy underway
  // (pull_request runs are build-checks and never deploy).
  const allRuns = Array.isArray(input.runs) ? input.runs.filter(Boolean) : [];
  const active = allRuns.find((r) => r.event !== 'pull_request' && r.status !== 'completed');
  if (active) {
    return noop(`a fly-deploy run (${active.event}) is already ${active.status} for ${short(active.head_sha)} — deploy underway`, 'info', 'deploy_underway');
  }

  // Completed deploy-event runs (push or workflow_dispatch, any conclusion) for main's head.
  const forHead = allRuns.filter(
    (r) => DEPLOY_EVENTS.has(r.event) && String(r.head_sha || '').toLowerCase() === mainSha,
  );
  if (forHead.length > 0) {
    // Settle window first: right after a deploy (e.g. the gate's own dispatch),
    // /health may simply not have caught up yet — no warning noise.
    const recentSuccess = forHead.find(
      (r) => r.conclusion === 'success' && r.updated_at &&
        nowMs - Date.parse(r.updated_at) < POST_DEPLOY_SETTLE_MINUTES * 60000,
    );
    if (recentSuccess) {
      return noop(
        `fly-deploy (${recentSuccess.event}) for ${short(mainSha)} succeeded <${POST_DEPLOY_SETTLE_MINUTES} min ago — waiting for /health to catch up`,
        'info',
        'settling',
      );
    }
    const bad = forHead.find((r) => r.conclusion !== 'success');
    if (bad) {
      return noop(
        `fly-deploy (${bad.event}) for ${short(mainSha)} already concluded "${bad.conclusion}" — not redispatching (no loop); needs a human`,
        'warning',
        'head_deploy_failed',
      );
    }
    // A successful deploy of the head exists, yet prod reports an older
    // ancestor: most likely a Fly-level rollback (`fly releases rollback` /
    // `fly deploy --image`). Redeploying would undo the rollback.
    return noop(
      `prod ${short(prodSha)} is behind main ${short(mainSha)}, which was already deployed once (${forHead[0].event}, "${forHead[0].conclusion}") — either that deploy never took effect or prod was rolled back (possible Fly rollback); not redispatching, a human decides`,
      'warning',
      'head_already_deployed',
    );
  }

  const committedMs = input.mainCommittedAt ? Date.parse(input.mainCommittedAt) : NaN;
  if (!Number.isFinite(committedMs)) return noop('main head commit date unknown — fail closed', 'warning', 'commit_date_unknown');
  const ageMin = (nowMs - committedMs) / 60000;
  if (ageMin < grace) {
    return noop(`main ${short(mainSha)} is ahead of prod ${short(prodSha)} but only ${ageMin.toFixed(1)} min old (grace ${grace} min) — letting the normal deploy path win`, 'info', 'within_grace');
  }

  return {
    action: 'dispatch',
    reason: `main ${short(mainSha)} ahead of prod ${short(prodSha)} for ${ageMin.toFixed(1)} min (> grace ${grace} min) with no deploy run ever for that sha — dispatching fly-deploy.yml on main`,
    level: 'warning',
    code: 'dispatch',
  };
}

/** Event-driven (workflow_run) mode: hard cap on how long one sweep run keeps
 *  re-evaluating. Sized so a merge landing at the start of the wait is
 *  dispatched within GRACE_MINUTES + one poll. Job timeout-minutes is above it. */
const MAX_WAIT_MINUTES = 18;

/** While prod == main and an open PR into main has auto-merge enabled, keep
 *  waiting for that merge to land for at most this long. A merge landing
 *  inside this window still has GRACE_MINUTES (+ one poll) of budget left
 *  under MAX_WAIT_MINUTES, so the same run can dispatch it. */
const AUTO_MERGE_WAIT_MINUTES = MAX_WAIT_MINUTES - GRACE_MINUTES - 1;

/** Seconds between re-evaluations in event-driven mode. */
const POLL_SECONDS = 60;

/**
 * Count open PRs into main that have auto-merge enabled (GET /pulls items).
 * Pure: takes the list the workflow fetched.
 * @param {Array<{state?:string, draft?:boolean, auto_merge?:object|null, base?:{ref?:string}}>|null|undefined} pulls
 * @returns {number}
 */
function countPendingAutoMerge(pulls) {
  if (!Array.isArray(pulls)) return 0;
  return pulls.filter(
    (p) => p && (p.state === undefined || p.state === 'open') && p.auto_merge != null &&
      (!p.base || p.base.ref === undefined || p.base.ref === 'main'),
  ).length;
}

/**
 * Event-driven mode loop control: after a decideDeployDrift() result, should
 * the sweep run sleep POLL_SECONDS and evaluate again?
 *
 * Only two states are worth waiting on; everything else is terminal:
 *   - `within_grace`: main is ahead of prod but younger than the grace period —
 *     re-evaluating later turns this into `dispatch` (or the normal deploy path
 *     catches up, giving `in_sync` / `deploy_underway`).
 *   - `in_sync` with an open auto-merge PR into main: the merge may land
 *     without any event; wait (at most AUTO_MERGE_WAIT_MINUTES) to see it.
 * Terminal: `dispatch` (caller dispatches once), `deploy_underway` (that run's
 * completion re-triggers the sweep via workflow_run), already deployed /
 * settling / failed, behind/diverged, and every fail-closed error.
 *
 * @param {{action:string, code?:string}} decision
 * @param {object} ctx
 * @param {number} ctx.pendingAutoMerge  countPendingAutoMerge() result
 * @param {Date|number} ctx.startedAt    when this sweep run started evaluating
 * @param {Date|number} ctx.now
 * @param {number} [ctx.maxWaitMinutes]
 * @param {number} [ctx.autoMergeWaitMinutes]
 * @param {number} [ctx.pollSeconds]
 * @returns {{ wait: boolean, reason: string }}
 */
function shouldKeepWaiting(decision, ctx) {
  const c = ctx || {};
  const toMs = (v) => (v instanceof Date ? v.getTime() : Number(v));
  const maxWait = typeof c.maxWaitMinutes === 'number' ? c.maxWaitMinutes : MAX_WAIT_MINUTES;
  const mergeWait = typeof c.autoMergeWaitMinutes === 'number' ? c.autoMergeWaitMinutes : AUTO_MERGE_WAIT_MINUTES;
  const poll = typeof c.pollSeconds === 'number' ? c.pollSeconds : POLL_SECONDS;
  const startedMs = toMs(c.startedAt);
  const nowMs = toMs(c.now);
  if (!decision || typeof decision !== 'object') return { wait: false, reason: 'no decision — stop' };
  if (decision.action === 'dispatch') return { wait: false, reason: 'dispatch decided — stop and dispatch once' };
  if (!Number.isFinite(startedMs) || !Number.isFinite(nowMs)) return { wait: false, reason: 'clock unknown — stop' };
  const elapsedMin = (nowMs - startedMs) / 60000;
  // Only wait if one more poll still fits under the cap.
  if (elapsedMin + poll / 60 > maxWait) {
    return { wait: false, reason: `wait budget ${maxWait} min used up (${elapsedMin.toFixed(1)} min) — stop; schedule backstop remains` };
  }
  if (decision.code === 'within_grace') {
    return { wait: true, reason: 'main ahead of prod but within grace — re-evaluate' };
  }
  if (decision.code === 'in_sync') {
    const pending = Number(c.pendingAutoMerge) || 0;
    if (pending <= 0) return { wait: false, reason: 'prod == main and no open auto-merge PR into main — nothing to wait for' };
    if (elapsedMin + poll / 60 > mergeWait) {
      return { wait: false, reason: `prod == main; ${pending} auto-merge PR(s) still open after ${mergeWait} min — stop; a later trigger or the schedule picks the merge up` };
    }
    return { wait: true, reason: `prod == main; ${pending} open auto-merge PR(s) into main — waiting for a merge to land` };
  }
  return { wait: false, reason: `terminal state (${decision.code || 'unknown'}) — stop` };
}

function short(sha) {
  return String(sha || '?').slice(0, 7);
}

module.exports = {
  GRACE_MINUTES,
  POST_DEPLOY_SETTLE_MINUTES,
  MAX_WAIT_MINUTES,
  AUTO_MERGE_WAIT_MINUTES,
  POLL_SECONDS,
  parseHealth,
  decideDeployDrift,
  countPendingAutoMerge,
  shouldKeepWaiting,
};
