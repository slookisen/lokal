#!/usr/bin/env node
'use strict';

/**
 * Determinism gate for tests/test.ts.
 *
 * dev-request 2026-07-25-testsuite-ikke-deterministisk-delte-globaler,
 * kriterium 4: "legg til et CI-steg som kjører suiten 3x på samme SHA og
 * feiler hvis feilsettet varierer" — run the suite N times on the same
 * checkout and fail if the SET of failing test names varies between runs.
 *
 * This is deliberately NOT a "must be green" gate. tests/test.ts may have
 * pre-existing failures for reasons unrelated to this class of bug (see the
 * same dev-request's "Motfunn 2026-07-26" section) — those are fine here as
 * long as they are the SAME failures, byte-for-byte, on every run. What this
 * gate exists to catch is the shared-mutable-globals hazard documented at
 * the top of tests/test.ts ("SHARED GLOBAL STATE" — globalThis.fetch,
 * process.env.ADMIN_KEY/ANALYTICS_ADMIN_KEY, the getDb() singleton): a block
 * that races another block over one of those and sometimes wins, sometimes
 * loses, producing a DIFFERENT failure on different runs of the identical
 * code. Comparing just the failure COUNT would miss that (1 failure vs. 1
 * different failure still "matches" on count) — this script compares the
 * actual SET of failure entries.
 *
 * Usage:
 *   node scripts/check-test-determinism.js                  # run suite 3x, compare
 *   node scripts/check-test-determinism.js --runs=5          # run suite 5x
 *   node scripts/check-test-determinism.js --out-dir=DIR     # where run logs go
 *                                                              (default: .determinism-logs/,
 *                                                              already covered by .gitignore's
 *                                                              "*.log" — safe to leave in place
 *                                                              for CI to upload as an artifact)
 *   node scripts/check-test-determinism.js --self-test        # unit-test the
 *                                                              parser/differ only;
 *                                                              does NOT run the suite
 *
 * Exit code: 0 if all N runs produce an identical failure set, 1 otherwise
 * (including on any internal/unexpected error). --self-test exits 0/1 the
 * same way, based on whether the embedded fixtures behave as expected.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────
// Parsing: pull the "failure set" out of one run's raw captured output.
//
// tests/test.ts's tail (see the tail of tests/test.ts, search for
// `console.log(\`\n${passed} passed, ${failed} failed\n\`)`) prints, in
// order:
//   <passed> passed, <failed> failed
//   [blank line]
//   Failures:              <- ONLY printed if failed > 0
//   <failure entry 1>
//   <failure entry 2>
//   ...
// (process.exit() follows immediately, so nothing comes after the last
// entry). If failed === 0, there is no "Failures:" header at all — that is
// a valid, expected shape (empty failure set), not a parse error.
//
// One wrinkle: entries pushed via assertEq() are single array elements that
// contain embedded newlines internally, e.g.:
//   ✗ label
//       expected: "foo"
//       actual:   "bar"
// A naive line-by-line split would fracture that into three separate
// "failures", which would make two runs that both failed the exact same
// assertion look "different" merely because of how the multi-line message
// prints. To avoid that, a line with leading whitespace is treated as a
// continuation of the previous (non-indented) entry, not a new one.
// ─────────────────────────────────────────────────────────────────────────
function extractFailureSet(output) {
  const lines = output.split(/\r?\n/);
  const headerIdx = lines.lastIndexOf('Failures:');
  if (headerIdx === -1) {
    return []; // no header => 0 failures this run (valid, expected case)
  }
  const entries = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue; // ignore blank separator lines
    if (/^\s/.test(line) && entries.length > 0) {
      entries[entries.length - 1] += '\n' + line;
    } else {
      entries.push(line);
    }
  }
  // De-duplicate (two identical failure messages in one run collapse to one
  // set member — the "SET" the acceptance criteria asks for, not a
  // multiset) and sort for a stable comparison order.
  return Array.from(new Set(entries.map((e) => e.trim()))).sort();
}

// Does this output even look like a completed run of tests/test.ts? Guards
// against silently treating a crashed/truncated run (OOM, segfault, runner
// killed) as "0 failures" just because it never reached the "Failures:"
// header.
const SUMMARY_LINE_RE = /^\d+ passed, \d+ failed\s*$/m;
function looksLikeCompletedRun(output) {
  return SUMMARY_LINE_RE.test(output);
}

function setsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Human-readable diff between two named failure sets — used both for the
// final report and by --self-test.
function diffSets(labelA, setA, labelB, setB) {
  const bSet = new Set(setB);
  const aSet = new Set(setA);
  const onlyInA = setA.filter((x) => !bSet.has(x));
  const onlyInB = setB.filter((x) => !aSet.has(x));
  const lines = [];
  for (const x of onlyInA) lines.push(`  in ${labelA} but not ${labelB}: ${x}`);
  for (const x of onlyInB) lines.push(`  in ${labelB} but not ${labelA}: ${x}`);
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────
// Self-test — proves the parser/differ discriminates correctly, without
// running the (slow, ~30-40s) real suite. Mirrors this fleet's
// --self-test convention (e.g. scripts/harvest-blacklist-merge.py
// --self-test, scripts/v3-b0-quality-harness.py --self-test).
// ─────────────────────────────────────────────────────────────────────────
function runSelfTest() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
      passed++;
    } else {
      failed++;
      failures.push(`${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  }

  // ── 1. Zero-failure run: no "Failures:" header at all ────────────────────
  const cleanRun = '11716 passed, 0 failed\n\n✓ all tests passed\n';
  check('clean run -> empty failure set', extractFailureSet(cleanRun), []);
  check('clean run looks completed', looksLikeCompletedRun(cleanRun), true);

  // ── 2. Simple single-line failures, same set, different order/whitespace ─
  const runA = [
    '11714 passed, 2 failed',
    '',
    'Failures:',
    'suiteX: unexpected error: boom',
    'suiteY: something else broke',
  ].join('\n');
  const runB = [
    '11714 passed, 2 failed',
    '',
    'Failures:',
    'suiteY: something else broke',
    'suiteX: unexpected error: boom',
  ].join('\n');
  const setA = extractFailureSet(runA);
  const setB = extractFailureSet(runB);
  check('same failures, different order -> equal sets', setsEqual(setA, setB), true);
  check('order-independent set has 2 members', setA.length, 2);

  // ── 3. THE core discriminator: same COUNT, different SET (must NOT match) ──
  // This is the exact scenario the acceptance criteria calls out: run 1
  // fails {A,B}, run 2 fails {A,C} — same failure count, different set.
  const runSameCountDifferentSet1 = [
    '11715 passed, 1 failed',
    '',
    'Failures:',
    'suiteA: flaky assertion',
  ].join('\n');
  const runSameCountDifferentSet2 = [
    '11715 passed, 1 failed',
    '',
    'Failures:',
    'suiteC: a totally different flaky assertion',
  ].join('\n');
  const setC1 = extractFailureSet(runSameCountDifferentSet1);
  const setC2 = extractFailureSet(runSameCountDifferentSet2);
  check('same failure COUNT (1 vs 1) is not, by itself, a false negative', setC1.length === setC2.length, true);
  check('...but the SETS correctly compare as different', setsEqual(setC1, setC2), false);
  const diff = diffSets('run1', setC1, 'run2', setC2);
  check('diff output names the divergent failure from run1', diff.some((l) => l.includes('suiteA') && l.includes('run1 but not run2')), true);
  check('diff output names the divergent failure from run2', diff.some((l) => l.includes('suiteC') && l.includes('run2 but not run1')), true);

  // ── 4. Multi-line assertEq()-style entries must stay grouped as ONE entry ──
  const multiLineRun1 = [
    '11700 passed, 1 failed',
    '',
    'Failures:',
    '✗ pid-16: no products table → empty map, no throw',
    '    expected: 0',
    '    actual:   1',
  ].join('\n');
  const multiLineRun2 = [
    '11700 passed, 1 failed',
    '',
    'Failures:',
    '✗ pid-16: no products table → empty map, no throw',
    '    expected: 0',
    '    actual:   1',
  ].join('\n');
  const setM1 = extractFailureSet(multiLineRun1);
  const setM2 = extractFailureSet(multiLineRun2);
  check('multi-line failure entry parses as exactly 1 set member', setM1.length, 1);
  check('identical multi-line entries across runs compare equal', setsEqual(setM1, setM2), true);

  // ── 5. Duplicate failure lines WITHIN one run collapse to one set member ──
  const dupRun = [
    '11710 passed, 2 failed',
    '',
    'Failures:',
    'suiteZ: same message twice',
    'suiteZ: same message twice',
  ].join('\n');
  check('duplicate lines within a run collapse (SET, not multiset)', extractFailureSet(dupRun).length, 1);

  // ── 6. A run that never produced the summary line (crash/truncation) must
  //      be recognized as NOT a completed run, not silently treated as "0
  //      failures" ────────────────────────────────────────────────────────
  const crashedRun = 'RangeError: Maximum call stack size exceeded\n    at foo (bar.js:1:1)\n';
  check('crashed/truncated run is NOT mistaken for a clean 0-failure run', looksLikeCompletedRun(crashedRun), false);

  console.log(`\nself-test: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    console.log('Failures:');
    for (const f of failures) console.log('  - ' + f);
    return false;
  }
  console.log('✓ self-test: parser/differ correctly accepts identical sets, rejects differing sets (including the same-count/different-set case), groups multi-line entries, and detects non-completed runs.');
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// Main: actually run the suite N times and compare.
// ─────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { runs: 3, outDir: '.determinism-logs', selfTest: false };
  for (const raw of argv) {
    if (raw === '--self-test') args.selfTest = true;
    else if (raw.startsWith('--runs=')) args.runs = parseInt(raw.slice('--runs='.length), 10);
    else if (raw.startsWith('--out-dir=')) args.outDir = raw.slice('--out-dir='.length);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.selfTest) {
    const ok = runSelfTest();
    process.exit(ok ? 0 : 1);
  }

  if (!Number.isInteger(args.runs) || args.runs < 2) {
    console.error(`--runs must be an integer >= 2 (got ${process.argv.find((a) => a.startsWith('--runs='))})`);
    process.exit(1);
  }

  const outDir = path.resolve(process.cwd(), args.outDir);
  fs.mkdirSync(outDir, { recursive: true });

  const results = []; // { n, stdout, set }

  for (let n = 1; n <= args.runs; n++) {
    console.log(`\n=== test-determinism: run ${n}/${args.runs} ===`);
    const start = Date.now();
    const proc = spawnSync('npx', ['tsx', 'tests/test.ts'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 256,
      env: process.env,
    });
    const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
    // IMPORTANT: parse stdout ONLY, never stdout+stderr concatenated.
    // tests/test.ts prints the "<passed> passed, <failed> failed" / "Failures:"
    // report exclusively via console.log (stdout). Plenty of code exercised
    // by the suite logs unrelated operational noise via console.warn/
    // console.error (stderr) — e.g. email-service's dry-run warnings,
    // booking-store's "producer notification SKIPPED" line, bm-events-
    // scrape-job's failure log — some of which includes per-run-unique IDs
    // (booking refs, timestamps) that would look like "the failure set
    // changed" if blended in. spawnSync captures stdout/stderr as two
    // separate buffers with no shared timeline, so concatenating them
    // (`stdout + stderr`) does NOT reproduce real chronological order — it
    // silently appends ALL of stderr after ALL of stdout, which previously
    // caused this script to misreport stderr noise as failure-set entries
    // appearing "after" the real Failures: header. Keeping them separate
    // avoids that entirely; stderr is still captured to the log file
    // (labeled) purely for human debugging.
    const stdout = proc.stdout || '';
    const stderr = proc.stderr || '';
    const logPath = path.join(outDir, `run-${n}.log`);
    fs.writeFileSync(
      logPath,
      `${stdout}\n` +
        `\n───────────────────────────────────────────────────────────────\n` +
        `stderr (operational logging noise — NOT parsed for failure-set purposes; see comment in scripts/check-test-determinism.js)\n` +
        `───────────────────────────────────────────────────────────────\n` +
        `${stderr}`,
    );

    if (proc.error) {
      console.error(`run ${n}: failed to spawn test process: ${proc.error.message}`);
      process.exit(1);
    }

    if (!looksLikeCompletedRun(stdout)) {
      console.error(`run ${n}: did NOT produce a "<passed> passed, <failed> failed" summary line on stdout — treating as a hard failure (crash/timeout/OOM), not a 0-failure run. Full output saved to ${logPath}. Tail of stdout:`);
      console.error(stdout.split(/\r?\n/).slice(-40).join('\n'));
      process.exit(1);
    }

    const set = extractFailureSet(stdout);
    console.log(`run ${n}/${args.runs}: ${set.length} distinct failure(s) (exit code ${proc.status}, ${elapsedSec}s) — log: ${logPath}`);
    results.push({ n, stdout, set });
  }

  // Compare every run's set against run 1's (equivalent to comparing all
  // pairs, since equality is transitive, but we still report every
  // divergent pair explicitly so nothing gets swept under "differs from
  // run 1" alone).
  let allEqual = true;
  const mismatchReports = [];
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      if (!setsEqual(results[i].set, results[j].set)) {
        allEqual = false;
        const diff = diffSets(`run ${results[i].n}`, results[i].set, `run ${results[j].n}`, results[j].set);
        mismatchReports.push(`run ${results[i].n} vs run ${results[j].n}:\n${diff.join('\n')}`);
      }
    }
  }

  if (!allEqual) {
    console.error('\n✗ DETERMINISM VIOLATION: the failure SET differs between runs of the identical checkout.');
    console.error('This means the same code, run back-to-back, fails differently each time — almost certainly');
    console.error('a shared-mutable-global race (globalThis.fetch / ADMIN_KEY / getDb() singleton — see the');
    console.error('"SHARED GLOBAL STATE" comment atop tests/test.ts), not a real functional regression.\n');
    for (const report of mismatchReports) {
      console.error(report);
      console.error('');
    }
    console.error(`Full run logs saved under ${outDir}/ for inspection.`);
    process.exit(1);
  }

  console.log(`\n✓ DETERMINISM OK: all ${args.runs} runs produced the identical failure set (${results[0].set.length} distinct failure(s), same names every run).`);
  console.log('(This gate does not require the suite to be green — only that it fails the same way every time.)');
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { extractFailureSet, looksLikeCompletedRun, setsEqual, diffSets };
