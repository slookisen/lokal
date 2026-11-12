#!/usr/bin/env node
/**
 * Standalone, dependency-free test for the transient-5xx retry around the
 * check/status polling loop in `.github/workflows/fleet-auto-approve.yml`.
 *
 * Reads the workflow file itself: structural assertions use plain regex over
 * the YAML text, and the pure `withRetry5xx()` helper is EXTRACTED from the
 * evaluate script and evaluated here (with an injected no-op sleep), so the
 * test exercises the exact code that ships.
 *
 * Run: node scripts/test-fleet-auto-approve-5xx-retry.js
 * Exits 0 if every case passes, 1 otherwise.
 *
 * Context: dev-request 2026-10-24-fleet-auto-approve-ingen-retry-ved-github-500
 * (a single HttpError 500 from GET /commits/{sha}/check-runs killed the gate
 * run on lokal#1243).
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
    console.log(`  FAIL  ${name}${detail !== undefined ? ` (${detail})` : ''}`);
  }
}

// Extract an `[async ]function name(...) { ... }` by indentation.
function extractFunction(text, name) {
  const m = text.match(new RegExp(`^( *)(?:async )?function ${name}\\(`, 'm'));
  if (!m) return null;
  const indent = m[1];
  const rest = text.slice(m.index);
  const end = rest.indexOf(`\n${indent}}\n`);
  if (end === -1) return null;
  return rest.slice(0, end + indent.length + 2);
}

function httpError(status) {
  const e = new Error(`HttpError ${status}`);
  e.status = status;
  return e;
}

async function main() {
  console.log('Structure');
  check('getCombinedStatusForRef wrapped in withRetry5xx',
    /await withRetry5xx\(\(\) => github\.rest\.repos\.getCombinedStatusForRef\(/.test(yml));
  check('checks.listForRef wrapped in withRetry5xx',
    /await withRetry5xx\(\(\) => github\.rest\.checks\.listForRef\(/.test(yml));
  check('no unwrapped getCombinedStatusForRef call',
    !/await github\.rest\.repos\.getCombinedStatusForRef\(/.test(yml));
  check('no unwrapped checks.listForRef call',
    !/await github\.rest\.checks\.listForRef\(/.test(yml));
  check('poll budget unchanged', /const MAX_POLLS = isSweep \? 4 : 40;/.test(yml));
  check('poll interval unchanged', /const POLL_INTERVAL_MS = 15000;/.test(yml));

  console.log('withRetry5xx (extracted from the workflow)');
  const fnSrc = extractFunction(yml, 'withRetry5xx');
  check('withRetry5xx found in workflow', !!fnSrc);
  if (!fnSrc) {
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(1);
  }
  // eslint-disable-next-line no-new-func
  const withRetry5xx = new Function(`${fnSrc}\nreturn withRetry5xx;`)();

  const sleeps = [];
  const logs = [];
  const opts = () => {
    sleeps.length = 0;
    logs.length = 0;
    return { sleep: async (ms) => { sleeps.push(ms); }, log: (m) => logs.push(m) };
  };

  // Success on first try -> 1 call, no sleep.
  {
    let calls = 0;
    const o = opts();
    const v = await withRetry5xx(async () => { calls++; return { data: 'ok' }; }, o);
    check('success first try returns value', v && v.data === 'ok');
    check('success first try -> 1 call', calls === 1, calls);
    check('success first try -> no sleep', sleeps.length === 0, sleeps.length);
  }

  // 500 then success -> retried, value returned.
  {
    let calls = 0;
    const o = opts();
    const v = await withRetry5xx(async () => {
      calls++;
      if (calls === 1) throw httpError(500);
      return { data: 'recovered' };
    }, o);
    check('500 then success returns value', v && v.data === 'recovered');
    check('500 then success -> 2 calls', calls === 2, calls);
    check('500 then success -> one 2000ms backoff', sleeps.length === 1 && sleeps[0] === 2000, JSON.stringify(sleeps));
    check('500 retry is logged', logs.length === 1 && /HTTP 500/.test(logs[0]), JSON.stringify(logs));
  }

  // 502, 503, 500 all fail -> throws after exactly 3 attempts (default).
  {
    let calls = 0;
    const seq = [502, 503, 500];
    const o = opts();
    let thrown = null;
    try {
      await withRetry5xx(async () => { throw httpError(seq[calls++]); }, o);
    } catch (e) { thrown = e; }
    check('persistent 5xx throws', !!thrown);
    check('persistent 5xx -> exactly 3 attempts', calls === 3, calls);
    check('persistent 5xx rethrows the last error', thrown && thrown.status === 500, thrown && thrown.status);
    check('persistent 5xx backoff 2000,4000', JSON.stringify(sleeps) === '[2000,4000]', JSON.stringify(sleeps));
  }

  // Custom attempt count honoured.
  {
    let calls = 0;
    const o = { ...opts(), attempts: 4 };
    try { await withRetry5xx(async () => { calls++; throw httpError(503); }, o); } catch (_) { /* expected */ }
    check('attempts: 4 -> exactly 4 attempts', calls === 4, calls);
    check('attempts: 4 backoff 2000,4000,8000', JSON.stringify(sleeps) === '[2000,4000,8000]', JSON.stringify(sleeps));
  }

  // 404 -> no retry, throws immediately.
  {
    let calls = 0;
    const o = opts();
    let thrown = null;
    try { await withRetry5xx(async () => { calls++; throw httpError(404); }, o); } catch (e) { thrown = e; }
    check('404 throws', thrown && thrown.status === 404);
    check('404 -> 1 call (no retry)', calls === 1, calls);
    check('404 -> no sleep', sleeps.length === 0, sleeps.length);
  }

  // Non-HTTP error -> no retry.
  {
    let calls = 0;
    const o = opts();
    let thrown = null;
    try { await withRetry5xx(async () => { calls++; throw new TypeError('boom'); }, o); } catch (e) { thrown = e; }
    check('non-HTTP error rethrown as-is', thrown instanceof TypeError);
    check('non-HTTP error -> 1 call (no retry)', calls === 1, calls);
  }

  // String status (not numeric) -> treated as non-HTTP, no retry.
  {
    let calls = 0;
    const o = opts();
    try {
      await withRetry5xx(async () => { calls++; const e = new Error('x'); e.status = '500'; throw e; }, o);
    } catch (_) { /* expected */ }
    check('non-numeric status -> no retry', calls === 1, calls);
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
