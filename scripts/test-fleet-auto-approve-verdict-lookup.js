#!/usr/bin/env node
/**
 * Standalone, dependency-free test for the verdict lookup fallback in
 * `.github/workflows/fleet-auto-approve.yml`: when a fleet PR has no trusted
 * REVIEW-VERDICT comment, the gate looks in slookisen/A2A main for
 * supervisor-inbox/<YYYY-MM-DD>-orchestrator-pr-<N>-review.md and uses it only
 * when its Reviewed-head matches the PR's current head.
 *
 * Like the scheduled-reeval / daniels-merge tests, this reads the workflow file
 * itself. The pure helpers are EXTRACTED and evaluated; in addition the WHOLE
 * `evaluate` and `resolve-pr` github-script bodies are extracted and run
 * end-to-end against in-memory mocks of `github`, `core`, `context` and
 * `fetch`, so every gate (protected paths, stop markers, verdict anchoring,
 * checks) runs exactly as shipped.
 *
 * Run: node scripts/test-fleet-auto-approve-verdict-lookup.js
 * Exits 0 if every case passes, 1 otherwise.
 *
 * Context: dev-request 2026-11-22-fleet-gate-leser-verdikt-uten-kommentar.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'fleet-auto-approve.yml');
const yml = fs.readFileSync(WORKFLOW, 'utf8');

let failures = 0;
let passes = 0;
function check(name, cond, detail) {
  if (cond) {
    passes++;
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
  }
}

// Slice a job block by indentation.
function block(text, startRe) {
  const m = text.match(startRe);
  if (!m) return '';
  const lines = text.slice(m.index).split('\n');
  const indent = lines[0].match(/^\s*/)[0].length;
  const out = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() !== '' && l.match(/^\s*/)[0].length <= indent) break;
    out.push(l);
  }
  return out.join('\n');
}

// The `script: |` body of a job block, de-indented.
function scriptBody(jobBlock) {
  const m = jobBlock.match(/^( *)script: \|\s*$/m);
  if (!m) return null;
  const lines = jobBlock.slice(m.index).split('\n').slice(1);
  const out = [];
  for (const l of lines) {
    if (l.trim() !== '' && l.match(/^\s*/)[0].length <= m[1].length) break;
    out.push(l);
  }
  const ind = Math.min(...out.filter((l) => l.trim() !== '').map((l) => l.match(/^\s*/)[0].length));
  return out.map((l) => l.slice(ind)).join('\n');
}

function extractFunction(text, name) {
  const m = text.match(new RegExp(`^( *)function ${name}\\(`, 'm'));
  if (!m) return null;
  const indent = m[1];
  const rest = text.slice(m.index);
  const end = rest.indexOf(`\n${indent}}\n`);
  if (end === -1) return null;
  return rest.slice(0, end + indent.length + 2);
}
const dedent = (s) => (s || '').split('\n').map((l) => l.trim()).join('\n');

const resolveBlock = block(yml, /^  resolve-pr:\s*$/m);
const evaluateBlock = block(yml, /^  evaluate:\s*$/m);
const resolveScript = scriptBody(resolveBlock);
const evaluateScript = scriptBody(evaluateBlock);

console.log('Structure');
check('resolve-pr script found', !!resolveScript);
check('evaluate script found', !!evaluateScript);
const helperNames = ['lookupVerdictCandidates', 'isLokalVerdictDocFor', 'reviewedHeadMatch'];
const helpers = {};
for (const n of helperNames) {
  const r = extractFunction(resolveBlock, n);
  const e = extractFunction(evaluateBlock, n);
  check(`${n} present in resolve-pr`, !!r);
  check(`${n} present in evaluate`, !!e);
  check(`${n} identical in resolve-pr and evaluate`, !!r && dedent(r) === dedent(e));
  // eslint-disable-next-line no-new-func
  helpers[n] = e ? new Function(`${e}\nreturn ${n};`)() : () => null;
}
check('resolve-pr step gets A2A_READ_PAT', /A2A_READ_PAT: \$\{\{ secrets\.A2A_READ_PAT \}\}/.test(resolveBlock));
check('resolve-pr stays read-only', !/: write/.test(resolveBlock));
check('lookup only runs when no verdict comment (comment path first)',
  /if \(verdictComment\) \{\s*\n\s*rawRef = verdictComment\.body\.match\(verdictRe\)\[1\];\s*\n\s*\} else \{/.test(evaluateScript || ''));
check('path allowlist still applied after the lookup',
  (evaluateScript || '').indexOf("verdictSource = 'lookup';") < (evaluateScript || '').indexOf('if (!pathRe.test(rawRef))'));
check('head check precedes the doc checks',
  (evaluateScript || '').indexOf("if (verdictSource === 'lookup') {") < (evaluateScript || '').indexOf('if (hasGenuineNeedsDanielFlag(docText))'));

console.log('lookupVerdictCandidates');
const cands = helpers.lookupVerdictCandidates;
const pick = (names, n) => cands(names, n)[0] || null;
check('exact name matches', pick(['2026-11-22-orchestrator-pr-16-review.md'], 16) === '2026-11-22-orchestrator-pr-16-review.md');
check('pr-16 does not match pr-1623', pick(['2026-11-22-orchestrator-pr-1623-review.md'], 16) === null);
check('pr-1623 does not match pr-16', pick(['2026-11-22-orchestrator-pr-16-review.md'], 1623) === null);
check('pr-162 does not match pr-1623 prefix', pick(['2026-11-22-orchestrator-pr-162-review.md'], 1623) === null);
check('-r2 round suffix accepted', pick(['2026-11-22-orchestrator-pr-16-review-r2.md'], 16) === '2026-11-22-orchestrator-pr-16-review-r2.md');
check('-head-<sha> suffix form rejected', pick(['2026-11-22-orchestrator-pr-16-review-head-38da5b2.md'], 16) === null);
check('-r without digits rejected', pick(['2026-11-22-orchestrator-pr-16-review-r.md'], 16) === null);
check('a2a- form rejected', pick(['2026-11-22-orchestrator-pr-a2a-16-review.md'], 16) === null);
check('missing date rejected', pick(['orchestrator-pr-16-review.md'], 16) === null);
check('prefix junk rejected', pick(['x2026-11-22-orchestrator-pr-16-review.md'], 16) === null);
check('suffix junk rejected', pick(['2026-11-22-orchestrator-pr-16-review.md.bak'], 16) === null);
check('newest date wins',
  pick(['2026-11-20-orchestrator-pr-16-review.md', '2026-11-23-orchestrator-pr-16-review.md', '2026-11-21-orchestrator-pr-16-review-r3.md',
    '2026-11-24-orchestrator-pr-1623-review.md'], 16) === '2026-11-23-orchestrator-pr-16-review.md');
check('same date: r3 > r2 > none (r10 > r9 numerically)',
  JSON.stringify(cands(['2026-11-22-orchestrator-pr-16-review.md', '2026-11-22-orchestrator-pr-16-review-r2.md',
    '2026-11-22-orchestrator-pr-16-review-r10.md', '2026-11-22-orchestrator-pr-16-review-r9.md'], 16))
    === JSON.stringify(['2026-11-22-orchestrator-pr-16-review-r10.md', '2026-11-22-orchestrator-pr-16-review-r9.md',
      '2026-11-22-orchestrator-pr-16-review-r2.md', '2026-11-22-orchestrator-pr-16-review.md']));
check('newer date beats older higher round',
  pick(['2026-11-21-orchestrator-pr-16-review-r3.md', '2026-11-22-orchestrator-pr-16-review.md'], 16) === '2026-11-22-orchestrator-pr-16-review.md');
check('newest across a year boundary', pick(['2026-12-31-orchestrator-pr-16-review.md', '2027-01-01-orchestrator-pr-16-review.md'], 16) === '2027-01-01-orchestrator-pr-16-review.md');
check('empty / bad input -> none', pick([], 16) === null && pick(null, 16) === null && pick(['x'], NaN) === null);
check('non-string entries ignored', pick([null, 5, '2026-11-22-orchestrator-pr-16-review.md'], 16) === '2026-11-22-orchestrator-pr-16-review.md');

console.log('isLokalVerdictDocFor');
const isLokal = helpers.isLokalVerdictDocFor;
check('lokal APPROVED first line', isLokal('VERDICT: APPROVED — PR #1224 (slookisen/lokal)\nReviewed-head: abc', 1224) === true);
check('lokal CHANGES-REQUESTED first line still counts (newest wins, blocks later)',
  isLokal('VERDICT: CHANGES-REQUESTED — PR #1224 (slookisen/lokal)', 1224) === true);
check('A2A doc with the same number rejected', isLokal('VERDICT: CHANGES-REQUESTED — PR #1224 (slookisen/A2A)', 1224) === false);
check('wrong PR number rejected', isLokal('VERDICT: APPROVED — PR #12245 (slookisen/lokal)', 1224) === false);
check('lokal only on line 2 rejected', isLokal('VERDICT: APPROVED — PR #1224\n(slookisen/lokal)', 1224) === false);
check('no VERDICT on line 1 rejected', isLokal('# Review of PR #1224 (slookisen/lokal)\nVERDICT: APPROVED', 1224) === false);
check('BOM + CRLF tolerated', isLokal('﻿VERDICT: APPROVED — PR #1224 (slookisen/lokal)\r\nx', 1224) === true);

console.log('reviewedHeadMatch');
const HEAD = 'c7a5aa384ab377e2d630e7d049a1ee02a5214413';
const OTHER = '0c40bf599f7ec6b11e16b14e2b977317345e4823';
const rh = helpers.reviewedHeadMatch;
check('full SHA match', rh(`VERDICT: x\nReviewed-head: ${HEAD}\n`, HEAD).ok === true);
check('7-char prefix match', rh(`Reviewed-head: ${HEAD.slice(0, 7)}`, HEAD).ok === true);
check('uppercase hex match', rh(`Reviewed-head: ${HEAD.toUpperCase()}`, HEAD).ok === true);
check('CRLF line match', rh(`VERDICT: x\r\nReviewed-head: ${HEAD}\r\n`, HEAD).ok === true);
check('6-char rejected', rh(`Reviewed-head: ${HEAD.slice(0, 6)}`, HEAD).ok === false);
check('41-char rejected', rh(`Reviewed-head: ${HEAD}a`, HEAD).ok === false);
check('non-hex rejected', rh('Reviewed-head: zzzzzzzz', HEAD).ok === false);
const other = rh(`Reviewed-head: ${OTHER}`, HEAD);
check('other SHA -> not ok, reason names a different head', other.ok === false && /different head/.test(other.reason), other.reason);
const none = rh('VERDICT: APPROVED — PR #16 (slookisen/lokal)\n', HEAD);
check('no Reviewed-head line -> not ok with reason', none.ok === false && /no Reviewed-head/.test(none.reason), none.reason);
check('Reviewed-head mid-line not accepted', rh(`text Reviewed-head: ${HEAD}`, HEAD).ok === false);
check('first Reviewed-head line is authoritative', rh(`Reviewed-head: ${OTHER}\nReviewed-head: ${HEAD}`, HEAD).ok === false);

// ---------------------------------------------------------------------------
// End-to-end harness: run the shipped github-script bodies against mocks.
// ---------------------------------------------------------------------------
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const PR = 1630;

function makeWorld(opts = {}) {
  const w = {
    pr: {
      number: PR, state: 'open', merged: false, draft: false, mergeable: true, mergeable_state: 'clean',
      user: { login: 'slookisen' }, head: { sha: HEAD }, node_id: 'PR_x',
      body: opts.body !== undefined ? opts.body : '**MERGE: GATEN** · ingen handling fra Daniel\n\nSummary',
      labels: opts.labels || [], additions: 10, deletions: 2,
    },
    files: opts.files || [{ filename: 'src/routes/producers.ts', patch: '@@ -1 +1 @@\n-a\n+b' }],
    comments: opts.comments || [],
    reviews: [],
    inbox: opts.inbox !== undefined ? opts.inbox : [],
    docs: opts.docs || {},
    checksConclusion: opts.checksConclusion || 'success',
    notes: [], approvals: [], merged: false, info: [], warnings: [], fetches: [],
  };
  return w;
}

function makeGithub(w) {
  const rest = {
    pulls: {
      get: async () => ({ data: { ...w.pr, merged: w.merged, merge_commit_sha: w.merged ? 'm1' : null } }),
      list: async () => ({ data: [w.pr] }),
      listFiles: async () => ({ data: w.files }),
      listReviews: async () => ({ data: w.reviews }),
      createReview: async (a) => { w.approvals.push(a); return { data: {} }; },
      merge: async () => { w.merged = true; return { data: { sha: 'm1' } }; },
    },
    issues: {
      listComments: async () => ({ data: w.comments }),
      createComment: async (a) => {
        w.notes.push(a.body);
        w.comments.push({ user: { login: 'github-actions[bot]' }, body: a.body });
        return { data: {} };
      },
    },
    repos: { getCombinedStatusForRef: async () => ({ data: { state: 'success', statuses: [] } }) },
    checks: {
      listForRef: async () => ({ data: { check_runs: [{ name: 'build', status: 'completed', conclusion: w.checksConclusion }] } }),
    },
    actions: { createWorkflowDispatch: async () => ({ data: {} }) },
  };
  return {
    rest,
    paginate: async (fn, args) => (await fn(args)).data,
    graphql: async () => ({}),
  };
}

function makeFetch(w) {
  return async (url) => {
    w.fetches.push(url);
    const base = 'https://api.github.com/repos/slookisen/A2A/contents/';
    const rel = url.startsWith(base) ? url.slice(base.length).replace(/\?ref=main$/, '') : null;
    if (rel === 'supervisor-inbox') {
      if (w.inbox === 'error') return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
      return { ok: true, status: 200, json: async () => w.inbox.map((name) => ({ name, type: 'file' })), text: async () => '' };
    }
    if (rel && Object.prototype.hasOwnProperty.call(w.docs, rel)) {
      return { ok: true, status: 200, text: async () => w.docs[rel], json: async () => ({}) };
    }
    return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
  };
}

function makeCore(w) {
  return {
    info: (m) => w.info.push(m),
    warning: (m) => w.warnings.push(m),
    setOutput: (k, v) => { w.output = { k, v }; },
    setFailed: (m) => { w.failed = m; },
  };
}

async function runScript(src, w, eventName, extraEnv = {}) {
  const env = { PR_NUMBER: String(PR), A2A_READ_PAT: 'tok', ...extraEnv };
  const fakeProcess = { env };
  const context = { eventName, repo: { owner: 'slookisen', repo: 'lokal' }, payload: { inputs: {} } };
  const fn = new AsyncFunction('github', 'context', 'core', 'fetch', 'process', src);
  await fn(makeGithub(w), context, makeCore(w), makeFetch(w), fakeProcess);
  return w;
}

const DOC_FILE = `2026-11-23-orchestrator-pr-${PR}-review.md`;
const goodDoc = (head = HEAD, extra = '') =>
  `VERDICT: APPROVED — PR #${PR} (slookisen/lokal)\nReviewed-head: ${head}\n\n# Review\n${extra}`;
const lookupWorld = (o = {}) => makeWorld({
  inbox: [DOC_FILE, '2026-11-20-orchestrator-pr-1-review.md'],
  docs: { [`supervisor-inbox/${DOC_FILE}`]: goodDoc(o.head, o.extra) },
  ...o,
});
const approved = (w) => w.approvals.length === 1;

async function main() {
  if (!evaluateScript || !resolveScript) {
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(1);
  }

  console.log('AK1 — no comment, doc with matching Reviewed-head, all green');
  let w = await runScript(evaluateScript, lookupWorld(), 'pull_request');
  check('approved', approved(w), JSON.stringify({ notes: w.notes, info: w.info.slice(-3) }));
  check('merged', w.merged === true);
  check('approval text says verdict source is lookup',
    approved(w) && w.approvals[0].body.includes(`verdict source: A2A lookup (supervisor-inbox/${DOC_FILE})`), approved(w) ? w.approvals[0].body : '');
  check('listing fetched from A2A main', w.fetches.some((u) => u === 'https://api.github.com/repos/slookisen/A2A/contents/supervisor-inbox?ref=main'));
  w = await runScript(evaluateScript, lookupWorld({ head: HEAD.slice(0, 12) }), 'pull_request');
  check('AK1 short-SHA prefix also approves', approved(w));

  console.log('AK2 — Reviewed-head is another SHA');
  w = await runScript(evaluateScript, lookupWorld({ head: OTHER }), 'pull_request');
  check('not approved', !approved(w) && !w.merged);
  check('note says the verdict applies to a different head', w.notes.some((n) => /different head/.test(n) && n.includes(DOC_FILE)), JSON.stringify(w.notes));
  w = lookupWorld();
  w.docs[`supervisor-inbox/${DOC_FILE}`] = `VERDICT: APPROVED — PR #${PR} (slookisen/lokal)\n\nbody`;
  await runScript(evaluateScript, w, 'pull_request');
  check('no Reviewed-head line -> not approved, note says why', !approved(w) && w.notes.some((n) => /no Reviewed-head line/.test(n)), JSON.stringify(w.notes));
  w = lookupWorld({ head: OTHER });
  await runScript(evaluateScript, w, 'schedule');
  await runScript(evaluateScript, w, 'schedule');
  check('sweep does not repeat the identical head note', w.notes.length === 1, String(w.notes.length));

  console.log('AK3 — no comment and no doc');
  w = await runScript(evaluateScript, makeWorld({ inbox: ['2026-11-22-orchestrator-pr-16300-review.md'] }), 'pull_request');
  check('not approved, no note (waits silently as today)', !approved(w) && w.notes.length === 0, JSON.stringify(w.notes));
  check('logs that it is waiting', w.info.some((m) => /waiting/.test(m)));
  w = await runScript(evaluateScript, lookupWorld(), 'pull_request', { A2A_READ_PAT: '' });
  check('no A2A_READ_PAT -> waits, no note, no fetch', !approved(w) && w.notes.length === 0 && w.fetches.length === 0);
  w = await runScript(evaluateScript, makeWorld({ inbox: 'error' }), 'pull_request');
  check('listing 404 -> waits without approving', !approved(w) && w.warnings.length > 0);

  console.log('AK4 — with comment: unchanged behaviour');
  const commentRef = 'supervisor-inbox/2026-11-23-some-other-review.md';
  const cWorld = (o = {}) => makeWorld({
    comments: [{ user: { login: 'slookisen' }, body: `REVIEW-VERDICT: APPROVED — ${commentRef}` }],
    inbox: [DOC_FILE],
    docs: { [commentRef]: `VERDICT: APPROVED — PR #${PR} (slookisen/lokal)\n\nno head line`, [`supervisor-inbox/${DOC_FILE}`]: goodDoc(OTHER) },
    ...o,
  });
  w = await runScript(evaluateScript, cWorld(), 'pull_request');
  check('approved via comment', approved(w));
  check('approval text says verdict source: comment', approved(w) && w.approvals[0].body.includes('verdict source: comment)'));
  check('comment path does not list the inbox (no Reviewed-head required)', !w.fetches.some((u) => /supervisor-inbox\?ref=main$/.test(u)));
  w = await runScript(evaluateScript, cWorld({ docs: { [commentRef]: `VERDICT: CHANGES-REQUESTED — PR #${PR}` } }), 'pull_request');
  check('comment doc CHANGES-REQUESTED still blocks', !approved(w) && w.notes.some((n) => /does not contain an explicit/.test(n)));
  w = await runScript(evaluateScript, cWorld({ comments: [{ user: { login: 'stranger' }, body: `REVIEW-VERDICT: APPROVED — ${commentRef}` }], inbox: [] }), 'pull_request');
  check('untrusted comment author ignored -> waits', !approved(w));

  console.log('AK5 — every gate still applies to a lookup-found verdict');
  w = await runScript(evaluateScript, lookupWorld({ files: [{ filename: 'src/routes/owner-portal.ts', patch: '' }] }), 'pull_request');
  check('protected path -> not approved', !approved(w) && w.notes.some((n) => /protected path/.test(n)));
  w = await runScript(evaluateScript, lookupWorld({ body: '**MERGE: DANIEL** · L4\n\nSummary' }), 'pull_request');
  check('MERGE: DANIEL first line -> not approved', !approved(w) && w.notes.some((n) => /MERGE: DANIEL/.test(n)));
  w = await runScript(evaluateScript, lookupWorld({ labels: [{ name: 'daniels-merge' }] }), 'pull_request');
  check('daniels-merge label -> not approved', !approved(w) && w.notes.some((n) => /MERGE: DANIEL/.test(n)));
  w = lookupWorld();
  w.docs[`supervisor-inbox/${DOC_FILE}`] = `VERDICT: CHANGES-REQUESTED — PR #${PR} (slookisen/lokal)\nReviewed-head: ${HEAD}\n`;
  await runScript(evaluateScript, w, 'pull_request');
  check('lookup doc CHANGES-REQUESTED -> not approved', !approved(w));
  w = lookupWorld();
  w.docs[`supervisor-inbox/${DOC_FILE}`] = `VERDICT: APPROVED — PR #999 (slookisen/lokal)\nReviewed-head: ${HEAD}\n`;
  await runScript(evaluateScript, w, 'pull_request');
  check('lookup doc for another PR number -> not approved', !approved(w));
  w = lookupWorld({ extra: 'Escalation: needs_' + 'daniel (protected surface).' });
  await runScript(evaluateScript, w, 'pull_request');
  check('reviewer escalation flag in lookup doc -> not approved', !approved(w) && w.notes.some((n) => /Needs Daniel/.test(n)));
  w = await runScript(evaluateScript, lookupWorld({ checksConclusion: 'failure' }), 'pull_request');
  check('red checks -> not approved', !approved(w) && w.notes.some((n) => /red/.test(n)));
  w = lookupWorld();
  w.pr.additions = 5000;
  await runScript(evaluateScript, w, 'pull_request');
  check('size cap -> not approved', !approved(w));

  console.log('Lookup file choice end-to-end');
  w = makeWorld({
    inbox: [`2026-11-23-orchestrator-pr-${PR}3-review.md`, `2026-11-21-orchestrator-pr-${PR}-review.md`, `2026-11-22-orchestrator-pr-${PR}-review.md`],
    docs: {
      [`supervisor-inbox/2026-11-23-orchestrator-pr-${PR}3-review.md`]: goodDoc(),
      [`supervisor-inbox/2026-11-21-orchestrator-pr-${PR}-review.md`]: goodDoc(),
      [`supervisor-inbox/2026-11-22-orchestrator-pr-${PR}-review.md`]: goodDoc(OTHER),
    },
  });
  await runScript(evaluateScript, w, 'pull_request');
  check('newest matching file wins (its stale head blocks, older file not used)', !approved(w) && w.notes.some((n) => n.includes(`2026-11-22-orchestrator-pr-${PR}-review.md`)));

  console.log('A2A-PR collision and review rounds end-to-end');
  w = makeWorld({
    inbox: [`2026-11-23-orchestrator-pr-${PR}-review.md`, `2026-11-22-orchestrator-pr-${PR}-review.md`],
    docs: {
      [`supervisor-inbox/2026-11-23-orchestrator-pr-${PR}-review.md`]: `VERDICT: CHANGES-REQUESTED — PR #${PR} (slookisen/A2A)\nReviewed-head: ${OTHER}\n`,
      [`supervisor-inbox/2026-11-22-orchestrator-pr-${PR}-review.md`]: goodDoc(),
    },
  });
  await runScript(evaluateScript, w, 'pull_request');
  check('newer A2A doc with colliding number is skipped; lokal doc approves', approved(w)
    && w.approvals[0].body.includes(`A2A lookup (supervisor-inbox/2026-11-22-orchestrator-pr-${PR}-review.md)`), JSON.stringify(w.notes));
  w = makeWorld({
    inbox: [`2026-11-23-orchestrator-pr-${PR}-review.md`],
    docs: { [`supervisor-inbox/2026-11-23-orchestrator-pr-${PR}-review.md`]: `VERDICT: APPROVED — PR #${PR} (slookisen/A2A)\nReviewed-head: ${HEAD}\n` },
  });
  await runScript(evaluateScript, w, 'pull_request');
  check('only an A2A doc -> waits, not approved, no note', !approved(w) && w.notes.length === 0);
  w = makeWorld({
    inbox: [`2026-11-23-orchestrator-pr-${PR}-review.md`, `2026-11-23-orchestrator-pr-${PR}-review-r2.md`],
    docs: {
      [`supervisor-inbox/2026-11-23-orchestrator-pr-${PR}-review.md`]: goodDoc(OTHER),
      [`supervisor-inbox/2026-11-23-orchestrator-pr-${PR}-review-r2.md`]: goodDoc(),
    },
  });
  await runScript(evaluateScript, w, 'pull_request');
  check('r2 beats the plain doc on the same date', approved(w) && w.approvals[0].body.includes(`-review-r2.md)`));
  w = makeWorld({
    inbox: [`2026-11-23-orchestrator-pr-${PR}-review-r2.md`, `2026-11-22-orchestrator-pr-${PR}-review.md`],
    docs: {
      [`supervisor-inbox/2026-11-23-orchestrator-pr-${PR}-review-r2.md`]: `VERDICT: CHANGES-REQUESTED — PR #${PR} (slookisen/lokal)\nReviewed-head: ${HEAD}\n`,
      [`supervisor-inbox/2026-11-22-orchestrator-pr-${PR}-review.md`]: goodDoc(),
    },
  });
  await runScript(evaluateScript, w, 'pull_request');
  check('newest lokal doc CHANGES-REQUESTED blocks; no fallback to older APPROVED',
    !approved(w) && w.notes.some((n) => n.includes('-review-r2.md') && /does not contain an explicit/.test(n)), JSON.stringify(w.notes));
  w = makeWorld({
    inbox: [`2026-11-23-orchestrator-pr-${PR}-review-r2.md`, `2026-11-22-orchestrator-pr-${PR}-review.md`],
    docs: { [`supervisor-inbox/2026-11-22-orchestrator-pr-${PR}-review.md`]: goodDoc() },
  });
  await runScript(evaluateScript, w, 'pull_request');
  check('fetch error on the newest candidate -> waits, no fallback', !approved(w));

  console.log('Sweep (resolve-pr) candidate selection');
  const picked = (x) => (x.output ? JSON.parse(x.output.v) : null);
  w = await runScript(resolveScript, lookupWorld(), 'schedule');
  check('PR with matching lookup doc and no comment is picked', JSON.stringify(picked(w)) === `[${PR}]`, JSON.stringify(picked(w)));
  w = makeWorld({
    inbox: [`2026-11-23-orchestrator-pr-${PR}-review.md`],
    docs: { [`supervisor-inbox/2026-11-23-orchestrator-pr-${PR}-review.md`]: `VERDICT: APPROVED — PR #${PR} (slookisen/A2A)\nReviewed-head: ${HEAD}\n` },
  });
  await runScript(resolveScript, w, 'schedule');
  check('sweep ignores an A2A doc with a colliding number', JSON.stringify(picked(w)) === '[]');
  w = await runScript(resolveScript, lookupWorld({ head: OTHER }), 'schedule');
  check('PR whose lookup doc is for another head is not picked', JSON.stringify(picked(w)) === '[]', JSON.stringify(picked(w)));
  w = await runScript(resolveScript, makeWorld({ inbox: [] }), 'schedule');
  check('PR with neither comment nor doc is not picked', JSON.stringify(picked(w)) === '[]');
  w = await runScript(resolveScript, lookupWorld(), 'schedule', { A2A_READ_PAT: '' });
  check('sweep without A2A_READ_PAT does not pick by lookup', JSON.stringify(picked(w)) === '[]' && w.fetches.length === 0);
  w = await runScript(resolveScript, makeWorld({ comments: [{ user: { login: 'claude[bot]' }, body: 'REVIEW-VERDICT: APPROVED — supervisor-inbox/x.md' }] }), 'schedule');
  check('PR with a verdict comment is still picked (unchanged)', JSON.stringify(picked(w)) === `[${PR}]` && w.fetches.length === 0);
  w = lookupWorld();
  w.reviews = [{ user: { login: 'github-actions[bot]' }, state: 'APPROVED', commit_id: HEAD }];
  await runScript(resolveScript, w, 'schedule');
  check('already-approved head still skipped', JSON.stringify(picked(w)) === '[]');

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(`  FAIL  harness crashed — ${e && e.stack}`);
  process.exit(1);
});
