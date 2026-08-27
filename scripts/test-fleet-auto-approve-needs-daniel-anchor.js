#!/usr/bin/env node
/**
 * Standalone, dependency-free test for the `needs_daniel` negation-aware
 * detection logic used by `.github/workflows/fleet-auto-approve.yml`'s
 * `evaluate` job (the "Gate + approve + enable auto-merge" step).
 *
 * That job runs under `actions/github-script@v7` with NO `actions/checkout`
 * step anywhere in the workflow (deliberately — see the workflow file's own
 * comments), so the runner never has this repo's files present and the
 * detection logic CANNOT `require()` a shared module — it must stay fully
 * inline in the YAML. `hasGenuineNeedsDanielFlag()` below is an intentional
 * DUPLICATE (mirror) of that inline logic, kept in sync by hand — same
 * convention as scripts/test-fleet-auto-approve-verdict-anchor.js for the
 * VERDICT: anchoring logic. If you change the detection logic in the
 * workflow file, update this function to match, and vice versa.
 *
 * Run: node scripts/test-fleet-auto-approve-needs-daniel-anchor.js
 * Exits 0 if every case passes, 1 otherwise.
 *
 * Context: dev-requests/2026-08-27-fleet-auto-approve-needs-daniel-substring-bug.md
 */

'use strict';

/**
 * Mirrors the workflow's needs_daniel detection for free-form prose (PR body,
 * review-verdict doc). The old logic was a bare `/needs[_-]?daniel/i.test()`
 * substring match — it tripped exactly as hard on a NEGATED mention ("not a
 * protected path, no needs_daniel flag required") as on a real escalation,
 * and recurred 3x (2026-08-24/26/27) costing an extra review round each time.
 *
 * Fix: for every occurrence of the term, find the nearest clause boundary
 * BEFORE it and require that no negation word
 * (no/not/never/without/ingen/uten/aldri/ikke) appears between that boundary
 * and the term. A single un-negated occurrence anywhere in the text still
 * trips the flag — fail closed toward escalation, same direction as the
 * original check — this only silences occurrences that are themselves
 * explicitly negated. It never requires reviewers to adopt a new required
 * syntax they don't already use (unlike the VERDICT: anchor, which IS a
 * required syntax) — real historical escalation docs (lokal#455/#499/#583
 * era phrasing, e.g. "(needs_daniel, protected-path)" or "## Why
 * `needs_daniel`") keep working unchanged; see cases 5-9 below, drawn from
 * actual supervisor-inbox/ docs.
 *
 * Two independent review rounds widened the boundary definition:
 *  - Round 1 found the first cut (./!/?/newline/comma only) missed this
 *    repo's own house style of joining clauses with an em-dash — "Not fully
 *    protected on its own — but this needs_daniel because..." — added
 *    colon/semicolon/em-dash/en-dash (cases 12-15).
 *  - Round 2 found the widened version still missed the literal ASCII "--"
 *    (a far more common em-dash substitute in raw plain-text/markdown than
 *    the real — character), an open paren "(" (a parenthetical aside is its
 *    own clause), and — the structurally different gap — clause transitions
 *    with NO punctuation before them at all, signalled only by a conjunction
 *    word (but/however/although/though/yet, plus Norwegian men/likevel).
 *    Added all of these (cases 17-20), plus negative controls proving a
 *    negation that IS in the same post-conjunction/paren clause still
 *    correctly suppresses (cases 21-23).
 *
 * Known residual gap (documented, not solved): two clauses fused with
 * NEITHER punctuation NOR one of the conjunction words above (a true
 * run-on) can still leak a negation across. Judged an acceptable residual
 * for a dependency-free textual heuristic running inline in a github-script
 * step with no checkout — a fully general fix needs real sentence parsing.
 *
 * PR labels are exact short tags, not prose, so the workflow's label check
 * is intentionally left on the original plain substring test — this
 * function is for free-form text only (PR body + review doc).
 */
function hasGenuineNeedsDanielFlag(text) {
  if (!text) return false;
  const NEGATION_RE = /\b(no|not|never|without|ingen|uten|aldri|ikke)\b/i;
  const CONJUNCTION_RE = /\b(but|however|although|though|yet|men|likevel)\b/gi;
  const PUNCT_TOKENS = ['--', '—', '–', '\n', '.', '!', '?', ',', ';', ':', '('];
  function clauseStart(preceding) {
    let best = 0;
    for (const t of PUNCT_TOKENS) {
      const idx = preceding.lastIndexOf(t);
      if (idx !== -1) {
        const end = idx + t.length;
        if (end > best) best = end;
      }
    }
    CONJUNCTION_RE.lastIndex = 0;
    let cm;
    while ((cm = CONJUNCTION_RE.exec(preceding))) {
      const end = cm.index + cm[0].length;
      if (end > best) best = end;
    }
    return best;
  }
  const re = /needs[_-]?daniel/gi;
  let m;
  while ((m = re.exec(text))) {
    const windowStart = Math.max(0, m.index - 80);
    const preceding = text.slice(windowStart, m.index);
    const clause = preceding.slice(clauseStart(preceding));
    if (!NEGATION_RE.test(clause)) {
      return true;
    }
  }
  return false;
}

// ── Test harness ─────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function check(label, text, expectedFlagged) {
  const got = hasGenuineNeedsDanielFlag(text);
  if (got === expectedFlagged) {
    passed++;
    console.log(`PASS  ${label}`);
  } else {
    failed++;
    const msg = `FAIL  ${label} — expected flagged=${expectedFlagged}, got flagged=${got}`;
    failures.push(msg);
    console.log(msg);
  }
}

// 1 (AC1). The exact recurring false positive: a negated mention of the term
// must NOT trip the gate. This is the real bug — verbatim shape of the
// sentence that tripped PR lokal#732 the 3rd time.
check(
  'case1 (AC1): "not a protected path, no needs_daniel flag required" -> not flagged',
  'Reviewed the diff: not a protected path, no `needs_daniel` flag required for this PR.',
  false
);

// 2 (AC1 variant). Negation word further from the term but same clause.
check(
  'case2 (AC1 variant): negation earlier in the same clause -> not flagged',
  'This is not the kind of change that needs_daniel review.',
  false
);

// 3 (AC2). A genuine escalation, synthetic, matching the real production
// parenthetical-flag format seen in lokal#455/#499/#583-era docs.
check(
  'case3 (AC2): genuine parenthetical flag, real incident phrasing -> flagged',
  'Touches owner-portal.ts session cookie logic (needs_daniel, protected-path).',
  true
);

// 4 (AC2). A genuine escalation as a plain declarative sentence.
check(
  'case4 (AC2): genuine flag as a plain sentence -> flagged',
  'This PR needs_daniel because it changes the admin-key rotation flow.',
  true
);

// 5-9: real historical verdict-doc excerpts (A2A supervisor-inbox/), used
// verbatim as regression fixtures so the fix cannot silently break a real
// past escalation while fixing the false-positive class above.

// 5. supervisor-inbox/2026-08-06-orchestrator-pr-503-review.md L43-45 —
// genuine escalation, semicolon-then-backtick immediately before the term
// (no comma/period between "verdict" and the term itself within the clause).
check(
  'case5 (real, PR #503): protected-path escalation prose -> flagged',
  "Confirmed `src/routes/owner-portal.ts` matches `fleet-auto-approve.yml`'s `PROTECTED` regex\n" +
  "(`/owner-portal/i`) — the gate cannot auto-merge this regardless of verdict; `needs_daniel`\n" +
  "filing is the expected path, not a workaround.",
  true
);

// 6. Same doc, L49 — markdown heading form.
check(
  'case6 (real, PR #503): "## Why `needs_daniel`" heading -> flagged',
  '## Why `needs_daniel`\nSame risk shape as sibling PR #502: relaxes a rate limit on an unauthenticated route.',
  true
);

// 7. supervisor-inbox/2026-07-24-orchestrator-pr-353-review.md L62 — "not"
// appears immediately AFTER the term (negating "gate-eligible", not the
// term itself) — must still flag, since the negation is not preceding it.
check(
  'case7 (real, PR #353): "why this is `needs_daniel`, not gate-eligible" -> flagged',
  '## Why this is `needs_daniel`, not gate-eligible\nPer platform-orchestrator.md §3.3 (protected-path/auth-surface detection):',
  true
);

// 8. supervisor-inbox/2026-07-11-orchestrator-pr-220-review.md L28-29 —
// genuine escalation for a protected-path (.github/workflows/**) PR.
check(
  'case8 (real, PR #220): protected-path workflow-diff escalation -> flagged',
  '- **Protected path:** yes — `.github/workflows/**` — the gate refuses to auto-merge this by\n' +
  '  design. Flagged `needs_daniel`; falls back to Daniel\'s manual UI merge (safe default, not\n' +
  '  a failure).',
  true
);

// 9. supervisor-inbox/2026-08-07-orchestrator-pr-506-review.md L64-65 — a
// REAL historical negated mention ("not `needs_daniel`"), same shape as the
// bug this fix targets. Under the OLD bare-substring check this doc would
// have wrongly withheld auto-approval too; the fix must not flag it.
check(
  'case9 (real, PR #506): "not `needs_daniel`" -> not flagged',
  'Protected-path check: admin-gated (`requireAdmin`) internal route, no auth/session/cookie/\n' +
  "admin-key-generation/owner-portal/magic-link surface touched — not `needs_daniel`.",
  false
);

// 10. No mention of the term at all -> not flagged.
check('case10: no mention at all -> not flagged', 'Clean bug fix, fully reviewed, all tests green.', false);

// 11. A negated mention earlier in the doc must not suppress an unrelated,
// genuine mention later in the doc (fail-closed toward escalation: a SINGLE
// un-negated occurrence anywhere is enough).
check(
  'case11: one negated + one genuine mention in the same doc -> flagged',
  'Earlier draft said no needs_daniel flag required, but on reflection this needs_daniel review.',
  true
);

// 12-15: round-1 adversarial cases. Each is a genuine escalation using an
// em-dash/colon/semicolon to join clauses, with an unrelated negation word
// earlier in the SAME sentence — the "not fully X — but genuinely
// needs_daniel Y" rhetorical shape this bug's own scenario invites.
check(
  'case12 (round1 adversarial, em-dash): "Not a protected path on its own — but this needs_daniel..." -> flagged',
  'Not a protected path on its own — but this needs_daniel because it also touches ADMIN_KEY rotation elsewhere.',
  true
);
check(
  'case13 (round1 adversarial, em-dash): "No single file here is protected — however ... needs_daniel..." -> flagged',
  'No single file here is protected — however the combined diff needs_daniel review given the auth surface touched.',
  true
);
check(
  'case14 (round1 adversarial, em-dash + colon): "not merely cosmetic — needs_daniel: it rewrites..." -> flagged',
  'This is not merely cosmetic — needs_daniel: it rewrites the session cookie signing key derivation.',
  true
);
check(
  'case15 (round1 adversarial, semicolon): "Not blocking on its own; still needs_daniel..." -> flagged',
  'Not blocking on its own; still needs_daniel given the session-cookie change nearby.',
  true
);

// 16. Negative control for cases 12-15: a negation word IN the same
// em-dash-joined clause as the term must still correctly suppress it.
check(
  'case16 (negative control): negation within the SAME em-dash clause -> not flagged',
  'This touches session cookies — but no `needs_daniel` flag is actually required here.',
  false
);

// 17-20: round-2 adversarial cases (found against the round-1 fix).
check(
  'case17 (round2 adversarial, literal "--"): "...on its own -- but this needs_daniel..." -> flagged',
  'Not fully protected on its own -- but this needs_daniel because of the admin-key rotation.',
  true
);
check(
  'case18 (round2 adversarial, "but" with ZERO punctuation before it): flagged',
  'Not a protected path but needs_daniel given the scope',
  true
);
check(
  'case19 (round2 adversarial, "however" with ZERO punctuation before it): flagged',
  'No protected path here however needs_daniel per the size of the diff',
  true
);
check(
  'case20 (round2 adversarial, open paren as a clause boundary): flagged',
  'No issue with naming here (needs_daniel though, given the admin-key touch)',
  true
);

// 21-23: negative controls for cases 17-20 — a negation word that IS in the
// same conjunction/paren-opened clause as the term must still suppress it
// (widening the boundary set must never become "never suppress after but/
// however/(" — only "don't let an EARLIER, unrelated clause's negation
// leak across").
check(
  'case21 (negative control, but+not in same clause): not flagged',
  'This looks concerning but not actually needs_daniel here',
  false
);
check(
  'case22 (negative control, paren+not in same clause): not flagged',
  'No issue with naming here (not needs_daniel, just a style nit)',
  false
);
check(
  'case23 (negative control, however+not in same clause): not flagged',
  'Style nit only, however not needs_daniel in the strict sense',
  false
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
