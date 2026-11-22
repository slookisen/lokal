#!/usr/bin/env node
/**
 * Standalone, dependency-free test for the MERGE: DANIEL hard stop in
 * `.github/workflows/fleet-auto-approve.yml` (step 1.6).
 *
 * The pure `isMarkedDanielsMerge()` helper (plus its two constants) is
 * EXTRACTED from the workflow file and evaluated here, so the test exercises
 * the exact code that ships and cannot drift.
 *
 * Run: node scripts/test-fleet-auto-approve-daniels-merge.js
 * Exits 0 if every case passes, 1 otherwise.
 *
 * Context: dev-request 2026-11-22-fleet-gate-respekterer-daniels-merge
 * (lokal#1552, #1608, #1618 were marked MERGE: DANIEL but the gate merged them).
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

// Extract from the label constant through the end of isMarkedDanielsMerge().
function extractHelper(text) {
  const startM = text.match(/^( *)const DANIELS_MERGE_LABEL = /m);
  if (!startM) return null;
  const rest = text.slice(startM.index);
  const fnM = rest.match(/^( *)function isMarkedDanielsMerge\(/m);
  if (!fnM) return null;
  const indent = fnM[1];
  const end = rest.indexOf(`\n${indent}}\n`, fnM.index);
  if (end === -1) return null;
  return rest.slice(0, end + indent.length + 2);
}

console.log('Extraction');
const src = extractHelper(yml);
check('isMarkedDanielsMerge + constants found in workflow', !!src);
// eslint-disable-next-line no-new-func
const isMarkedDanielsMerge = src ? new Function(`${src}\nreturn isMarkedDanielsMerge;`)() : () => 'missing';

console.log('Placement');
const iLabelStop = yml.indexOf("core.info('needs_daniel label — no-op');");
const iCall = yml.indexOf('if (isMarkedDanielsMerge(pr)) {');
const iProtected = yml.indexOf('// 2. Protected paths');
check('existing label stop found', iLabelStop !== -1);
check('MERGE: DANIEL stop found', iCall !== -1);
check('protected-paths comment found', iProtected !== -1);
check('MERGE: DANIEL stop is after the label stop', iCall > iLabelStop, `${iCall} vs ${iLabelStop}`);
check('MERGE: DANIEL stop is before step 2 protected paths', iCall !== -1 && iCall < iProtected, `${iCall} vs ${iProtected}`);
const stopBlock = iCall === -1 ? '' : yml.slice(iCall, iProtected);
check('stop posts the Norwegian note and returns',
  /await note\('PR er merket MERGE: DANIEL\. Venter på Daniel\.'\);\s*\n\s*core\.info\(.*\);\s*\n\s*return;/.test(stopBlock));
check('needsDanielRe line unchanged', /\n *const needsDanielRe = \/needs\[_-\]\?daniel\/i;\n/.test(yml));
check('exactly one needsDanielRe = / assignment', (yml.match(/needsDanielRe = \//g) || []).length === 1);

console.log('Cases');
const DANIEL_L4 = '**MERGE: DANIEL** · L4';
const GATEN = '**MERGE: GATEN** · ingen handling fra Daniel';
const lbl = (name) => ({ name });
const cases = [
  ['AK1 label object, empty body', { labels: [lbl('daniels-merge')], body: '' }, true],
  ['AK1 label string, empty body', { labels: ['daniels-merge'], body: '' }, true],
  ['AK1 label mixed case + padding', { labels: [lbl('  Daniels-Merge ')], body: '' }, true],
  ['AK2 no label, first line DANIEL', { labels: [], body: `${DANIEL_L4}\n\nSummary...` }, true],
  ['AK2 leading whitespace before DANIEL', { labels: [], body: `   ${DANIEL_L4}\nx` }, true],
  ['AK3 first line GATEN, no label', { labels: [], body: `${GATEN}\n\nSummary...` }, false],
  ['DANIEL on line 2 only', { labels: [], body: `${GATEN}\n${DANIEL_L4}` }, false],
  ['DANIEL on line 2 after blank line 1', { labels: [], body: `\n${DANIEL_L4}` }, false],
  ['CRLF body, DANIEL first line', { labels: [], body: `${DANIEL_L4}\r\nmore\r\n` }, true],
  ['label daniels-merge-later', { labels: [lbl('daniels-merge-later')], body: '' }, false],
  ['label not-daniels-merge', { labels: ['not-daniels-merge'], body: '' }, false],
  ['null body', { labels: [], body: null }, false],
  ['undefined body', { labels: [] }, false],
  ['labels missing', { body: 'hello' }, false],
  ['label object without name', { labels: [{}, null], body: '' }, false],
  ['null PR', null, false],
];
for (const n of [1552, 1608, 1618]) {
  cases.push([`AK4 lokal#${n} label + first line`, { number: n, labels: [lbl('daniels-merge')], body: `${DANIEL_L4}\n\nBody` }, true]);
  cases.push([`AK4 lokal#${n} label only`, { number: n, labels: [lbl('daniels-merge')], body: 'Body' }, true]);
  cases.push([`AK4 lokal#${n} first line only`, { number: n, labels: [], body: `${DANIEL_L4}\n\nBody` }, true]);
}
for (const [name, input, want] of cases) {
  const got = isMarkedDanielsMerge(input);
  check(`${name} -> ${want ? 'stop' : 'no stop'}`, got === want, `got ${got}`);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
