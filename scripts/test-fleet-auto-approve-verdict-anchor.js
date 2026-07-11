#!/usr/bin/env node
/**
 * Standalone, dependency-free test for the verdict-anchoring logic used by
 * `.github/workflows/fleet-auto-approve.yml`'s `evaluate` job (the
 * "Gate + approve + enable auto-merge" step, ~lines 186-228).
 *
 * That job runs under `actions/github-script@v7` with NO `actions/checkout`
 * step anywhere in the workflow (deliberately — see the workflow file's own
 * comments), so the runner never has this repo's files present and the
 * verdict-parsing logic CANNOT `require()` a shared module — it must stay
 * fully inline in the YAML. `decideVerdict()` below is an intentional
 * DUPLICATE (mirror) of that inline logic, kept in sync by hand. If you
 * change the parsing/decision logic in the workflow file, update this
 * function to match, and vice versa.
 *
 * Run: node scripts/test-fleet-auto-approve-verdict-anchor.js
 * Exits 0 if every case passes, 1 otherwise.
 *
 * Context: dev-requests/2026-07-10-fleet-auto-approve-docrejected-anchor-fix.md
 */

'use strict';

/**
 * Mirrors the workflow's verdict-anchoring decision:
 *   - Find only the FIRST occurrence in `docText` matching
 *     /\bVERDICT:\s*(\S.*)$/mi (word-boundary anchored, NOT line-start
 *     anchored — two verdict-doc formats are both in active production use:
 *     a plain "VERDICT: APPROVED — ..." first line, and a markdown heading
 *     "# REVIEW-VERDICT: APPROVED — ..." whose line does not START with
 *     "VERDICT:" but does contain it right after the "-" in "REVIEW-VERDICT",
 *     a non-word char, so `\b` still matches there. An earlier draft used the
 *     line-start anchor `^VERDICT:` and would have wrongly treated every
 *     "# REVIEW-VERDICT:"-style doc as having no verdict at all — caught by
 *     spot-checking real supervisor-inbox docs (e.g. the one for lokal PR
 *     #216) — do not reintroduce `^`.
 *   - No such occurrence at all -> not approved (fail closed).
 *   - That line is a rejection verdict (DISAPPROVED / NOT APPROVED /
 *     CHANGES-REQUESTED / REJECTED) -> not approved (fail closed), full stop.
 *   - That line is an APPROVED verdict AND the PR number appears within a
 *     +/-200-char window anchored around that line -> approved.
 *   - Otherwise -> not approved (fail closed).
 *
 * Returns { approved: boolean, reason: string } — mirrors the shape of the
 * workflow's docApproved/docRejected + note() no-op reasoning, collapsed
 * into one object for easy assertions.
 */
function decideVerdict(docText, prNumber) {
  const verdictLineMatch = docText.match(/\bVERDICT:\s*(\S.*)$/mi);
  if (!verdictLineMatch) {
    return { approved: false, reason: 'no-verdict-line' };
  }
  const verdictLine = verdictLineMatch[0];
  const isRejectedVerdict = /\bVERDICT:\s*(DISAPPROVED|NOT APPROVED|CHANGES-REQUESTED|REJECTED)\b/i.test(verdictLine);
  const isApprovedVerdict = !isRejectedVerdict && /\bVERDICT:\s*APPROVED\b/i.test(verdictLine);
  const windowStart = Math.max(0, verdictLineMatch.index - 200);
  const windowEnd = verdictLineMatch.index + verdictLine.length + 200;
  const prNearVerdict = new RegExp(`PR[- ]?#?${prNumber}\\b`, 'i').test(docText.slice(windowStart, windowEnd));
  const docApproved = isApprovedVerdict && prNearVerdict;
  const docRejected = isRejectedVerdict;
  if (docRejected || !docApproved) {
    return { approved: false, reason: docRejected ? 'first-verdict-line-rejected' : 'not-approved-or-pr-mismatch' };
  }
  return { approved: true, reason: 'approved' };
}

// ── Test harness ─────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function check(label, docText, prNumber, expectedApproved) {
  const result = decideVerdict(docText, prNumber);
  if (result.approved === expectedApproved) {
    passed++;
    console.log(`PASS  ${label}`);
  } else {
    failed++;
    const msg = `FAIL  ${label} — expected approved=${expectedApproved}, got approved=${result.approved} (reason: ${result.reason})`;
    failures.push(msg);
    console.log(msg);
  }
}

// 1. First line APPROVED for PR #999; later prose has an unrelated
//    "Verdict: CHANGES-REQUESTED" describing an earlier round -> approved.
//    This is the exact bug shape from lokal#208.
check(
  'case1: approved first line, historical CHANGES-REQUESTED in body -> approved',
  [
    'VERDICT: APPROVED — PR #999',
    '',
    '## Review history',
    'Round-1 outcome: **Verdict: CHANGES-REQUESTED** (missing test coverage).',
    'Round-2: fix-up landed, all comments addressed.',
  ].join('\n'),
  999,
  true
);

// 2. First VERDICT: line is itself CHANGES-REQUESTED, even though unrelated
//    prose elsewhere says "APPROVED" -> not approved. No regression on the
//    actual protective case this logic exists for.
check(
  'case2: first line CHANGES-REQUESTED, stray APPROVED in prose -> rejected',
  [
    'VERDICT: CHANGES-REQUESTED — PR #999',
    '',
    'Note: the previous reviewer APPROVED an earlier, since-superseded diff;',
    'this round requests changes to the retry logic.',
  ].join('\n'),
  999,
  false
);

// 3. Bare "rejected" substring (no VERDICT: prefix) anywhere in the doc, but
//    the doc's first (and only) VERDICT: line is APPROVED for PR #500 ->
//    approved. This is the original lokal#171/PR#161 regression.
check(
  'case3: bare "rejected" substring elsewhere, first VERDICT line approved -> approved',
  [
    'VERDICT: APPROVED — PR #500',
    '',
    'Testing notes: initially the request still rejected with 400 during local',
    'testing due to a stale token; re-ran after refreshing credentials and it',
    'passed cleanly.',
  ].join('\n'),
  500,
  true
);

// 4. No VERDICT: line at all -> not approved (fail closed).
check(
  'case4: no VERDICT line at all -> rejected (fail closed)',
  [
    'This review doc forgot to include a verdict line entirely.',
    'Everything looked fine to me.',
  ].join('\n'),
  500,
  false
);

// 5. First VERDICT line says APPROVED but names a DIFFERENT PR number than
//    the one being checked -> not approved for the PR actually being gated.
check(
  'case5: approved verdict for a different PR number -> rejected for this PR',
  [
    'VERDICT: APPROVED — PR #500',
    '',
    'Looks good, ship it.',
  ].join('\n'),
  501,
  false
);

// 6a. First line DISAPPROVED -> rejected (not fooled by "APPROVED" substring).
check(
  'case6a: first line DISAPPROVED -> rejected',
  [
    'VERDICT: DISAPPROVED — PR #999',
    '',
    'Multiple correctness issues found; see inline comments.',
  ].join('\n'),
  999,
  false
);

// 6b. First line NOT APPROVED -> rejected (not fooled by "APPROVED" substring).
check(
  'case6b: first line NOT APPROVED -> rejected',
  [
    'VERDICT: NOT APPROVED — PR #999',
    '',
    'Needs another pass before this can land.',
  ].join('\n'),
  999,
  false
);

// 7. Real-world format #2: a markdown H1 heading "# REVIEW-VERDICT: APPROVED
//    — ..." as the first line (literal line does NOT start with "VERDICT:",
//    only contains it after "REVIEW-"), with a later, historical
//    CHANGES-REQUESTED mention in the body -> approved. This is the format
//    used by e.g. supervisor-inbox/2026-07-11-orchestrator-pr-216-review.md;
//    the `^`-anchored draft of this fix would have wrongly no-op'd here.
check(
  'case7: "# REVIEW-VERDICT:" heading format, historical CHANGES-REQUESTED in body -> approved',
  [
    '# REVIEW-VERDICT: APPROVED — slookisen/lokal#216 (PR #216: dedup-audit v2 corpus-distinct counting)',
    '',
    '## Review history',
    'Round-1 outcome: **Verdict: CHANGES-REQUESTED** (needed provider-distinct counting).',
    'Round-2: fix-up landed, all comments addressed.',
  ].join('\n'),
  216,
  true
);

// ── Summary ─────────────────────────────────────────────────────────────
console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('');
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
