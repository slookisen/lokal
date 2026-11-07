#!/usr/bin/env node
/**
 * Standalone, dependency-free test for the scheduled re-evaluation sweep and
 * the fresh-state (merge-conflict) guard in
 * `.github/workflows/fleet-auto-approve.yml`.
 *
 * Unlike the other fleet-auto-approve tests (which mirror inline logic by
 * hand), this one reads the workflow file itself: structural assertions use
 * plain regex over the YAML text, and the pure `gateDecisionForFreshPr()` and
 * `isOwnJob()` helpers are EXTRACTED from the evaluate script and evaluated
 * here, so the test exercises the exact code that ships.
 *
 * Run: node scripts/test-fleet-auto-approve-scheduled-reeval.js
 * Exits 0 if every case passes, 1 otherwise.
 *
 * Context: dev-request 2026-11-06-fleet-auto-approve-gate-poll-budsjett-ingen-ny-evaluering
 * (lokal#1401 hung after the gate's poll budget ran out).
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
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// Slice the top-level `on:` block and each job block by indentation.
function block(text, startRe) {
  const m = text.match(startRe);
  if (!m) return '';
  const start = m.index;
  const indent = m[0].match(/^\s*/)[0].replace(/\n/g, '').length;
  const lines = text.slice(start).split('\n');
  const out = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() !== '' && l.match(/^\s*/)[0].length <= indent) break;
    out.push(l);
  }
  return out.join('\n');
}

console.log('Structure');
const onBlock = block(yml, /^on:\s*$/m);
check('on: block found', onBlock.length > 0);
check('schedule trigger every 30 min', /\n  schedule:\s*\n\s+- cron: '\*\/30 \* \* \* \*'/.test(onBlock));
check('workflow_dispatch trigger', /\n  workflow_dispatch:/.test(onBlock));
check('existing pull_request trigger types kept',
  /types: \[opened, synchronize, reopened, ready_for_review\]/.test(onBlock));
check('existing issue_comment trigger kept', /\n  issue_comment:\s*\n\s+types: \[created\]/.test(onBlock));
check('existing check_suite trigger kept', /\n  check_suite:\s*\n\s+types: \[completed\]/.test(onBlock));

const resolveBlock = block(yml, /^  resolve-pr:\s*$/m);
const evaluateBlock = block(yml, /^  evaluate:\s*$/m);
check('resolve-pr job found', resolveBlock.length > 0);
check('evaluate job found', evaluateBlock.length > 0);
check('resolve-pr outputs pr_numbers', /pr_numbers: \$\{\{ steps\.resolve\.outputs\.pr_numbers \}\}/.test(resolveBlock));
check('resolve-pr no longer outputs single pr_number', !/outputs\.pr_number\b(?!s)/.test(yml));
check('resolve-pr has read-only pull-requests + issues perms',
  /permissions:\s*\n\s+pull-requests: read\s*\n\s+issues: read/.test(resolveBlock));
check('resolve-pr has no write permission', !/: write/.test(resolveBlock));
check('event paths emit single-PR or empty array',
  /JSON\.stringify\(prNumber \? \[prNumber\] : \[\]\)/.test(resolveBlock));
check('sweep lists open PRs oldest first',
  /pulls\.list,\s*\{[^}]*state: 'open'[^}]*direction: 'asc'[^}]*per_page: 100/.test(resolveBlock));
check('sweep caps at 10 PRs', /SWEEP_MAX_PRS = 10\b/.test(resolveBlock));
check('sweep skips drafts and merged', /!p\.draft && !p\.merged_at/.test(resolveBlock));
check('sweep skips PRs already approved by github-actions[bot] on head SHA',
  /r\.user\.login === 'github-actions\[bot\]' && r\.state === 'APPROVED' && r\.commit_id === p\.head\.sha/.test(resolveBlock));

check('evaluate is a matrix over pr_numbers',
  /matrix:\s*\n\s+pr_number: \$\{\{ fromJSON\(needs\.resolve-pr\.outputs\.pr_numbers\) \}\}/.test(evaluateBlock));
check('evaluate fail-fast false', /fail-fast: false/.test(evaluateBlock));
const mp = evaluateBlock.match(/max-parallel: (\d+)/);
check('evaluate max-parallel small (<=3)', mp && parseInt(mp[1], 10) <= 3, mp ? mp[1] : 'missing');
check('evaluate guarded against empty array',
  /if: needs\.resolve-pr\.outputs\.pr_numbers != '' && needs\.resolve-pr\.outputs\.pr_numbers != '\[\]'/.test(evaluateBlock));
check('concurrency group is per matrix PR', /group: fleet-auto-approve-pr-\$\{\{ matrix\.pr_number \}\}/.test(evaluateBlock));
check('event runs keep cancel-in-progress',
  /cancel-in-progress: \$\{\{ github\.event_name != 'schedule' && github\.event_name != 'workflow_dispatch' \}\}/.test(evaluateBlock));
check('PR_NUMBER env comes from matrix', /PR_NUMBER: \$\{\{ matrix\.pr_number \}\}/.test(evaluateBlock));
check('poll budget shorter on sweep, 40 on events', /const MAX_POLLS = isSweep \? 4 : 40;/.test(evaluateBlock));
check('sweep suppresses the checks-still-running note',
  /if \(isSweep\) \{[\s\S]{0,200}core\.info\('sweep: checks still running[\s\S]{0,120}return;\s*\}\s*\n\s*await note\('checks still running after the ~10-minute poll budget/.test(evaluateBlock));
check('dirty guard uses noteOnce on all triggers',
  /if \(freshDecision === 'dirty'\) \{\s*\n(\s*\/\/.*\n)*\s*await noteOnce\('this PR conflicts with main/.test(evaluateBlock));
check('mergeable null triggers one refetch after ~3s',
  /if \(freshDecision === 'unknown'\) \{\s*\n\s*await new Promise\(\(r\) => setTimeout\(r, 3000\)\);\s*\n\s*\(\{ data: pr \} = await github\.rest\.pulls\.get/.test(evaluateBlock));

// Trusted identity set + verdict anchor must be identical in both jobs.
const idsRe = /const FLEET_IDENTITIES = (\[.*\]);/;
const verdictReRe = /const verdictRe = (\/.*\/m);/;
const idsResolve = (resolveBlock.match(idsRe) || [])[1];
const idsEvaluate = (evaluateBlock.match(idsRe) || [])[1];
check('FLEET_IDENTITIES identical in resolve-pr and evaluate',
  idsResolve && idsResolve === idsEvaluate, `${idsResolve} vs ${idsEvaluate}`);
const vResolve = (resolveBlock.match(verdictReRe) || [])[1];
const vEvaluate = (evaluateBlock.match(verdictReRe) || [])[1];
check('verdictRe identical in resolve-pr and evaluate', vResolve && vResolve === vEvaluate, `${vResolve} vs ${vEvaluate}`);

// Extract a `function name(...) { ... }` from the evaluate script by indentation.
function extractFunction(text, name) {
  const m = text.match(new RegExp(`^( *)function ${name}\\(`, 'm'));
  if (!m) return null;
  const indent = m[1];
  const rest = text.slice(m.index);
  const end = rest.indexOf(`\n${indent}}\n`);
  if (end === -1) return null;
  return rest.slice(0, end + indent.length + 2);
}

console.log('gateDecisionForFreshPr (extracted from the workflow)');
const fnSrc = extractFunction(evaluateBlock, 'gateDecisionForFreshPr');
check('gateDecisionForFreshPr found in evaluate script', !!fnSrc);
// eslint-disable-next-line no-new-func
const gateDecisionForFreshPr = fnSrc ? new Function(`${fnSrc}\nreturn gateDecisionForFreshPr;`)() : () => 'missing';
const base = { state: 'open', merged: false, draft: false, mergeable: true, mergeable_state: 'clean' };
const cases = [
  ['clean open PR', base, 'proceed'],
  ['mergeable_state dirty', { ...base, mergeable: false, mergeable_state: 'dirty' }, 'dirty'],
  ['mergeable_state dirty, mergeable still true', { ...base, mergeable_state: 'dirty' }, 'dirty'],
  ['mergeable false', { ...base, mergeable: false, mergeable_state: 'unknown' }, 'dirty'],
  ['mergeable null (still computing)', { ...base, mergeable: null, mergeable_state: 'unknown' }, 'unknown'],
  ['mergeable missing', { ...base, mergeable: undefined }, 'unknown'],
  ['draft PR', { ...base, draft: true }, 'draft'],
  ['draft PR that also conflicts', { ...base, draft: true, mergeable: false, mergeable_state: 'dirty' }, 'dirty'],
  ['merged PR', { ...base, state: 'closed', merged: true }, 'closed'],
  ['closed unmerged PR', { ...base, state: 'closed' }, 'closed'],
  ['blocked (checks pending) but mergeable', { ...base, mergeable_state: 'blocked' }, 'proceed'],
  ['behind main but no conflict', { ...base, mergeable_state: 'behind' }, 'proceed'],
  ['null PR', null, 'unknown'],
];
for (const [name, input, want] of cases) {
  const got = gateDecisionForFreshPr(input);
  check(`${name} -> ${want}`, got === want, `got ${got}`);
}

console.log('isOwnJob (extracted from the workflow)');
const ownJobLine = evaluateBlock.match(/const OWN_JOB_NAMES = .*;\s*\n\s*const isOwnJob = .*;/);
check('OWN_JOB_NAMES + isOwnJob found', !!ownJobLine);
// eslint-disable-next-line no-new-func
const isOwnJob = ownJobLine ? new Function(`${ownJobLine[0]}\nreturn isOwnJob;`)() : () => null;
check('matrix leg "evaluate (1401)" is own job', isOwnJob('evaluate (1401)') === true);
check('"resolve-pr" is own job', isOwnJob('resolve-pr') === true);
check('legacy "evaluate" is own job', isOwnJob('evaluate') === true);
check('"build" is not own job', isOwnJob('build') === false);
check('"evaluate-something" is not own job', isOwnJob('evaluate-something') === false);

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
