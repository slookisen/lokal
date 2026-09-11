#!/usr/bin/env node
/**
 * Standalone, dependency-free test for the PROTECTED-path/content list and
 * the needs_daniel hard stop used by `.github/workflows/fleet-auto-approve.yml`'s
 * `evaluate` job (steps "1.5 needs_daniel", "2. Protected paths").
 *
 * That job runs under `actions/github-script@v7` with NO `actions/checkout`
 * step, so the runner never has this repo's files present and this logic
 * CANNOT `require()` a shared module — it must stay fully inline in the
 * YAML. Everything below is an intentional DUPLICATE (mirror) of that
 * inline logic, kept in sync by hand. If you change it in the workflow
 * file, update this file to match, and vice versa.
 *
 * Run: node scripts/test-fleet-auto-approve-protected-paths.js
 * Exits 0 if every case passes, 1 otherwise.
 *
 * Context:
 * - dev-requests/2026-07-13-fleet-auto-approve-protected-path-regex-widen.md
 *   (widened after PR #206 and PR #287 both auto-merged changes to
 *   src/routes/owner-portal.ts uncaught — /auth/i alone doesn't match a
 *   filename that only contains "owner-portal", not "auth").
 * - dev-requests/2026-08-16-fleet-auto-approve-protected-innholdsbasert-deteksjon.md
 *   (Slice A: content-based detection, added after lokal#455/#499/#583 all
 *   auto-merged real auth-mechanism edits in neutrally-named files because
 *   the old check only ever looked at f.filename. Slice B: needs_daniel is
 *   now a hard stop independent of PROTECTED, since all three incidents
 *   ALSO had a reviewer who had already said "needs Daniel" and got
 *   overridden.)
 */

'use strict';

const PROTECTED = [
  /(^|\/)\.github\/workflows\//i,
  /(^|\/)fly\.toml$/i,
  /(^|\/)dockerfile$/i,
  /auth/i,
  /session/i,
  /cookie/i,
  /admin-key/i,
  /owner-portal/i,
  /magic-link/i,
  /(^|\/)\.env/i,
  /secret/i,
];

const REQUIRE_ADMIN_RE = /\brequireAdmin\w*\b/;
const PROTECTED_CONTENT = [
  /\bADMIN_KEY\b/,
  /\bANALYTICS_ADMIN_KEY\b/,
  REQUIRE_ADMIN_RE,
  /\bsessionFromRequest\b/,
  /\bverifyOwnerSession\b/,
  /\breadSessionCookie\b/,
  /\bissueClaimMagicLink\b/,
  /res\.cookie\(/,
  /res\.setHeader\(\s*['"]Set-Cookie['"]/i,
  /process\.env\.[A-Z_]*(SECRET|KEY|TOKEN|PASS)\b/,
];

const needsDanielRe = /needs[_-]?daniel/i;

function isProtected(filename) {
  return PROTECTED.some((re) => re.test(filename));
}

// github.rest.pulls.listFiles's per-file `patch` field is hunks-only (starts
// at the first `@@ ... @@` marker) — it never carries +++/--- headers, so
// there is no doubled-prefix header line to filter out here. Do not
// reintroduce a `!l.startsWith(prefix + prefix)` guard: it silently drops
// any added/removed line whose CONTENT itself starts with a literal +/- at
// column 0 (caught in review, dev-request 2026-08-16-fleet-auto-approve-
// protected-innholdsbasert-deteksjon — see test case below).
function patchLines(patch, prefix) {
  return (patch || '')
    .split('\n')
    .filter((l) => l.startsWith(prefix))
    .join('\n');
}

// requireAdminEditMatch(patch) — dev-request 2026-09-11-fleet-auto-approve-
// requireadmin-falsk-positiv. Scoped to the requireAdmin pattern ONLY; every
// other PROTECTED_CONTENT pattern still goes through the plain whole-pool
// added&&removed test in contentEditMatch below, untouched (AC6).
//
// Root cause this fixes (lokal PR #626, #646): the whole-pool test flags a
// file whenever *some* added line and *some* removed line anywhere in the
// file's patch each merely CONTAIN "requireAdmin" — even when the one line
// that actually changed left requireAdmin byte-identical and only touched
// something else on that line (e.g. `(req` -> `async (req`), and the pool
// only has a requireAdmin "removed" hit at all because of that same untouched
// call. A file that separately adds a brand-new, ordinary requireAdmin-
// guarded route (routine boilerplate — a pure ADDITION, no removed
// counterpart) then makes the added/removed pools intersect on pure
// coincidence, not because anything auth-relevant changed.
//
// Fix: parse the patch into "replace blocks" — a maximal run of removed (-)
// lines immediately followed by a maximal run of added (+) lines (the
// standard unified-diff "these lines were modified" shape). When a block's
// removed-run and added-run have the SAME length, pair them positionally.
// For each paired (removed, added) line that is NOT a requireAdmin
// *definition* line on either side, if the sequence of requireAdmin-pattern
// tokens matched on the removed line is IDENTICAL (same tokens, same order)
// to the sequence matched on the added line, that pair's requireAdmin
// occurrences are "explained" — the guard itself didn't change, something
// else on the line did — and are masked out of the pool for this pattern
// only before the final added/removed test. Anything NOT covered by such an
// exempted pair (unpaired hunks, unequal-length replace blocks, pure
// single-sided add/remove, or any definition-line edit) is left in the pool
// exactly as before: fail-closed by construction, we only ever SUBTRACT
// signal we can positively explain, never add leniency anywhere else (AC9).
//
// Definition lines are NEVER eligible for the exemption (AC1's "editing
// requireAdmin's own implementation IS still flagged", suggested-approach
// point 4): a line matching `function requireAdmin\w*(` on EITHER side of the
// pair always counts as a genuine hit, even if the requireAdmin token
// sequence on that line happens to be identical (e.g. only a parameter type
// changed) — a token-sequence match alone can't tell "narrow signature tweak"
// from "harmless", and this is a security-relevant surface, so it stays
// unconditionally flagged rather than guessed at.
//
// Gap check (dev-request 2026-09-11-fleet-auto-approve-requireadmin-
// falsk-positiv, reviewer-found gap): a same-requireAdmin-token-
// sequence pair is NOT automatically collateral — a reviewer showed
// `if (!requireAdmin(req, res)) return;` -> `if (isDevMode ||
// !requireAdmin(req, res)) return;` has an identical token sequence
// (["requireAdmin"] both sides) yet obviously must stay flagged: a
// new `||`/`&&`/`!` conjoined directly onto the guard's own
// invocation changes whether/when it gets evaluated. Token-sequence
// equality alone can't distinguish that from the PR-646 case (an
// unrelated `async` inserted elsewhere on the line), so
// requireAdminChangeIsCollateral() below additionally locates the
// single edited span on the line (longest common prefix/suffix
// between the removed/added content) and requires every
// requireAdmin occurrence to be separated from that span by a
// structural boundary character — the call/statement has closed
// (`,` `;` `}` `)`) — before treating the pair as collateral.
// Mirrored (duplicated intentionally — the workflow runner has no checkout
// step, so this logic must stay inline there) in
// .github/workflows/fleet-auto-approve.yml — keep both in sync (AC3/AC7).
const REQUIRE_ADMIN_TOKEN_RE = /\brequireAdmin\w*\b/g;
const REQUIRE_ADMIN_DEF_RE = /function\s+requireAdmin\w*\s*\(/;
// Boundary characters that, found strictly between a requireAdmin
// occurrence and the line's single edited span, mark the edit as
// structurally separate from the guard's own invocation — the call/
// argument-list/statement has closed. Deliberately EXCLUDES `(`
// (a changed argument list starts right after `requireAdmin(` and
// must stay flagged) and all boolean/negation operator characters
// `!` `&` `|` (a newly inserted `isDevMode ||` or bare `!` sits
// directly against the guard's own invocation with nothing
// structural between them, so it must never read as a safe stop).
const REQUIRE_ADMIN_GAP_BOUNDARY_RE = /[,;{})]/;
// requireAdminChangeIsCollateral(rContent, aContent) — true only when
// every requireAdmin occurrence in rContent is separated from the
// line's single edited span (found via longest common prefix/suffix
// between rContent and aContent — cheap and sufficient since callers
// already confirmed the requireAdmin token sequence itself matches)
// by a boundary character. The prefix/suffix region is byte-identical
// on both sides by construction, so checking rContent's occurrences
// against it is enough — no need to separately re-check aContent. Any
// occurrence that overlaps the edited span itself, or whose gap has
// no boundary character, fails the WHOLE pair closed (conservative:
// one unexplained occurrence is enough to keep it flagged).
function requireAdminChangeIsCollateral(rContent, aContent) {
  if (rContent === aContent) return true;
  const minLen = Math.min(rContent.length, aContent.length);
  let prefixLen = 0;
  while (prefixLen < minLen && rContent[prefixLen] === aContent[prefixLen]) prefixLen++;
  let suffixLen = 0;
  const maxSuffix = minLen - prefixLen;
  while (
    suffixLen < maxSuffix &&
    rContent[rContent.length - 1 - suffixLen] === aContent[aContent.length - 1 - suffixLen]
  ) suffixLen++;
  const changeStart = prefixLen;
  const changeEnd = rContent.length - suffixLen;
  REQUIRE_ADMIN_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = REQUIRE_ADMIN_TOKEN_RE.exec(rContent))) {
    const ts = m.index;
    const te = ts + m[0].length;
    if (te <= changeStart) {
      if (!REQUIRE_ADMIN_GAP_BOUNDARY_RE.test(rContent.slice(te, changeStart))) return false;
    } else if (ts >= changeEnd) {
      if (!REQUIRE_ADMIN_GAP_BOUNDARY_RE.test(rContent.slice(changeEnd, ts))) return false;
    } else {
      return false; // occurrence overlaps the edited span itself
    }
  }
  return true;
}
function requireAdminEditMatch(patch) {
  const lines = (patch || '').split('\n');
  const maskRemoved = new Map();
  const maskAdded = new Map();
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith('-')) {
      const removedIdx = [];
      while (i < lines.length && lines[i].startsWith('-')) { removedIdx.push(i); i++; }
      const addedIdx = [];
      while (i < lines.length && lines[i].startsWith('+')) { addedIdx.push(i); i++; }
      if (removedIdx.length === addedIdx.length) {
        for (let k = 0; k < removedIdx.length; k++) {
          const rContent = lines[removedIdx[k]].slice(1);
          const aContent = lines[addedIdx[k]].slice(1);
          if (REQUIRE_ADMIN_DEF_RE.test(rContent) || REQUIRE_ADMIN_DEF_RE.test(aContent)) continue;
          const rMatches = rContent.match(REQUIRE_ADMIN_TOKEN_RE) || [];
          const aMatches = aContent.match(REQUIRE_ADMIN_TOKEN_RE) || [];
          const sameSeq = rMatches.length === aMatches.length && rMatches.every((m, idx2) => m === aMatches[idx2]);
          if (rMatches.length > 0 && sameSeq && requireAdminChangeIsCollateral(rContent, aContent)) {
            maskRemoved.set(removedIdx[k], rContent.replace(REQUIRE_ADMIN_TOKEN_RE, ''));
            maskAdded.set(addedIdx[k], aContent.replace(REQUIRE_ADMIN_TOKEN_RE, ''));
          }
        }
      }
    } else {
      i++;
    }
  }
  const addedPool = lines
    .map((l, idx) => (l.startsWith('+') ? (maskAdded.has(idx) ? maskAdded.get(idx) : l.slice(1)) : null))
    .filter((x) => x !== null)
    .join('\n');
  const removedPool = lines
    .map((l, idx) => (l.startsWith('-') ? (maskRemoved.has(idx) ? maskRemoved.get(idx) : l.slice(1)) : null))
    .filter((x) => x !== null)
    .join('\n');
  return REQUIRE_ADMIN_RE.test(addedPool) && REQUIRE_ADMIN_RE.test(removedPool);
}

// Mirrors contentEditMatch() in the workflow: a pattern must match on BOTH
// an added and a removed line of the SAME file's patch to count — i.e. the
// diff EDITS existing matching code, not just adds a brand-new admin route
// that follows the repo's own standard requireAdmin()/ADMIN_KEY boilerplate.
// The requireAdmin pattern is the one exception: it routes through the
// line-pair-aware requireAdminEditMatch() above instead of the plain
// whole-pool test (AC6 — every other pattern here is untouched).
function contentEditMatch(patch) {
  const added = patchLines(patch, '+');
  const removed = patchLines(patch, '-');
  for (const re of PROTECTED_CONTENT) {
    if (re === REQUIRE_ADMIN_RE) {
      if (requireAdminEditMatch(patch)) return re;
      continue;
    }
    if (re.test(added) && re.test(removed)) return re;
  }
  return null;
}

let passed = 0;
let failed = 0;
const failures = [];

function check(name, filename, expected) {
  const actual = isProtected(filename);
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}: isProtected(${JSON.stringify(filename)}) = ${actual}, expected ${expected}`);
  }
}

// ── Acceptance criterion 1: the regression this widen fixes ──────────────
check('owner-portal.ts is caught (the #206/#287 gap)', 'src/routes/owner-portal.ts', true);
check('owner-portal.ts nested under src/routes/ with different casing', 'src/routes/Owner-Portal.ts', true);

// ── Charter-documented surface, each independently ────────────────────────
check('a session-handling file', 'src/services/session-service.ts', true);
check('a cookie-handling file', 'src/utils/cookie-parser.ts', true);
check('an admin-key file', 'src/config/admin-key.ts', true);
check('a magic-link file', 'src/routes/magic-link.ts', true);
check('an auth file (pre-existing)', 'src/middleware/auth.ts', true);

// ── Pre-existing infra guards, unchanged (non-goal: don't touch these) ────
check('a workflow file', '.github/workflows/deploy.yml', true);
check('fly.toml', 'fly.toml', true);
check('a Dockerfile', 'Dockerfile', true);
check('a .env file', '.env.production', true);
check('a file with "secret" in the name', 'src/secrets-loader.ts', true);

// ── Acceptance criterion 2: ordinary PRs must NOT be caught (no regression) ──
check('an unrelated route file', 'src/routes/marketplace-cart.ts', false);
check('an unrelated service file', 'src/services/order-notify-service.ts', false);
check('an unrelated test file', 'tests/test.ts', false);
check('an unrelated frontend file', 'src/public/selger.html', false);
check('a database schema file (not itself an auth surface)', 'src/database/init.ts', false);

function checkContent(name, patch, expectMatch) {
  const hit = contentEditMatch(patch);
  const actual = !!hit;
  if (actual === expectMatch) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}: contentEditMatch(...) = ${hit}, expected match=${expectMatch}`);
  }
}

function checkNeedsDaniel(name, text, expected) {
  const actual = needsDanielRe.test(text);
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}: needsDanielRe.test(...) = ${actual}, expected ${expected}`);
  }
}

// ── AC1/AC3: content-based detection, retro-tested against the real
// patches from the 3 documented gate-integrity misses (each in a file whose
// NAME matches no PROTECTED pattern) ──────────────────────────────────────

// lokal#455 (src/routes/crm.ts) — precedence flip, ANALYTICS_ADMIN_KEY
// present on both the added and removed line.
checkContent(
  'lokal#455 crm.ts requireAdminAuth() precedence edit is caught by content',
  [
    '@@ -20,9 +20,9 @@',
    '-  const expectedKey = process.env.ANALYTICS_ADMIN_KEY || process.env.ADMIN_API_KEY || "";',
    '+  const expectedKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";',
  ].join('\n'),
  true,
);

// lokal#583 (src/routes/analytics.ts) — same precedence-flip shape.
checkContent(
  'lokal#583 analytics.ts requireAdminAuth() precedence edit is caught by content',
  [
    '@@ -67,7 +67,7 @@',
    '-  const expectedKey = process.env.ANALYTICS_ADMIN_KEY || process.env.ADMIN_API_KEY || "";',
    '+  const expectedKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";',
  ].join('\n'),
  true,
);

// lokal#499 (src/routes/gardssalg-claim.ts) — sessionFromRequest exported
// (module-private -> exported is still an EDIT of the same matching line).
checkContent(
  'lokal#499 gardssalg-claim.ts sessionFromRequest export edit is caught by content',
  [
    '@@ -133,7 +133,7 @@',
    '-function sessionFromRequest(req: Request): { valid: boolean; providerId?: string; token?: string } {',
    '+export function sessionFromRequest(req: Request): { valid: boolean; providerId?: string; token?: string } {',
  ].join('\n'),
  true,
);

// ── AC4 (false-positive discipline): a BRAND-NEW admin route that only
// follows the repo's own standard requireAdmin()/ADMIN_KEY boilerplate
// (added lines only, nothing pre-existing edited) must NOT be flagged —
// empirically the majority case (12/30 of the last 30 auto-merged PRs
// before this shipped would have been wrongly caught by an unscoped
// "patch contains ADMIN_KEY anywhere" check; this add+remove-scoped
// version measured 2/30). ──────────────────────────────────────────────
checkContent(
  'a brand-new admin route using the standard requireAdmin()/ADMIN_KEY boilerplate is NOT flagged',
  [
    '@@ -0,0 +1,12 @@',
    '+function requireAdmin(req: Request, res: Response): boolean {',
    '+  const expected = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";',
    '+  if (!expected || req.headers["x-admin-key"] !== expected) {',
    '+    res.status(401).json({ error: "Unauthorized" });',
    '+    return false;',
    '+  }',
    '+  return true;',
    '+}',
  ].join('\n'),
  false,
);
checkContent(
  'a purely unrelated diff is not flagged',
  ['@@ -1,3 +1,3 @@', '-const x = 1;', '+const x = 2;'].join('\n'),
  false,
);

// ── dev-request 2026-09-11-fleet-auto-approve-requireadmin-falsk-positiv ──
// AC1/AC4: PR #646 reproduction — an EXISTING route-registration line is
// edited for a reason wholly unrelated to auth (`(req` -> `async (req`);
// `requireAdmin` itself is byte-identical on both sides of that line. The
// file's patch ALSO adds a brand-new route elsewhere that itself calls
// requireAdmin (ordinary boilerplate) — a pure addition with no removed
// counterpart. Before this fix, the file-wide added-pool AND removed-pool
// both ended up containing "requireAdmin" matches (the untouched call on
// the edited line supplies the removed-side hit, the new route supplies the
// added-side hit) purely by coincidence — must resolve NOT flagged now.
checkContent(
  'PR #646 reproduction: requireAdmin unchanged on a modified route-registration line, only `async` inserted, is NOT flagged',
  [
    '@@ -40,7 +40,7 @@',
    '-router.post("/admin/gardssalg-website-review-approve", requireAdmin, (req: Request, res: Response) => {',
    '+router.post("/admin/gardssalg-website-review-approve", requireAdmin, async (req: Request, res: Response) => {',
    '   // existing handler body, unchanged',
    ' });',
    '@@ -80,6 +80,17 @@',
    ' // unrelated context further down the same file',
    '+router.post("/admin/gardssalg-website-review-new", requireAdmin, (req: Request, res: Response) => {',
    '+  res.json({ ok: true });',
    '+});',
  ].join('\n'),
  false,
);

// Reviewer-found gap fix (dev-request 2026-09-11-fleet-auto-approve-
// requireadmin-falsk-positiv, post-merge review round): the requireAdmin
// token sequence is IDENTICAL on both sides of these pairs (["requireAdmin"]
// both times), so the token-sequence-only check alone would wrongly treat
// them as collateral like the PR-646 `async` case — but here a new boolean
// operator is conjoined DIRECTLY onto the guard's own invocation, changing
// whether/when it actually gets evaluated. Must stay flagged.
checkContent(
  'reviewer gap: requireAdmin guard short-circuited by a newly-inserted `isDevMode ||` is flagged',
  [
    '@@ -10,3 +10,3 @@',
    '-  if (!requireAdmin(req, res)) return;',
    '+  if (isDevMode || !requireAdmin(req, res)) return;',
  ].join('\n'),
  true,
);
checkContent(
  'reviewer gap: requireAdmin guard short-circuited by a newly-inserted `featureFlagOff &&` is flagged',
  [
    '@@ -10,3 +10,3 @@',
    '-  if (!requireAdmin(req, res)) return;',
    '+  if (featureFlagOff && !requireAdmin(req, res)) return;',
  ].join('\n'),
  true,
);

// AC1: a PR that edits requireAdmin's OWN implementation (its definition
// line) must still be flagged — even though the requireAdmin token itself
// is textually identical on both sides of that line (only the parameter
// list narrowed), the definition-line carve-out in the suggested approach
// (point 4) makes this unconditional: definition lines are never eligible
// for the "unchanged, so exempt" treatment the #646 case above relies on.
checkContent(
  'editing requireAdmin\'s own definition line IS still flagged, even with an identical requireAdmin token on both sides',
  [
    '@@ -5,3 +5,3 @@',
    '-function requireAdmin(req: Request, res: Response): boolean {',
    '+function requireAdmin(req, res): boolean {',
    '   const expected = process.env.ADMIN_KEY || "";',
  ].join('\n'),
  true,
);

// AC1 (a second angle on the same requirement): a genuine body-level edit to
// requireAdmin's implementation — the signature line itself changes and
// still mentions requireAdmin on both sides — must be flagged too.
checkContent(
  'a real edit to requireAdmin\'s implementation (signature widened) is flagged',
  [
    '@@ -5,3 +5,3 @@',
    '-function requireAdmin(req: Request, res: Response): boolean {',
    '+function requireAdminV2(req: Request, res: Response, opts: { strict?: boolean }): boolean {',
  ].join('\n'),
  true,
);

// Regression (caught in review before merge): patchLines() must NOT drop a
// line whose CONTENT itself starts with the same character as the diff's
// own +/- marker — e.g. content "-ADMIN_KEY;" on a removed line reads as
// "--ADMIN_KEY;" (diff marker + content), and content "+ADMIN_KEY;" on an
// added line reads as "++ADMIN_KEY;". There is no +++/--- header in
// listFiles's per-file `patch` field to guard against (that only exists in
// a raw `git diff`), so an earlier version's doubled-prefix filter was
// solving a problem that cannot occur here while silently dropping exactly
// these real content lines (unindented code, markdown-bullet-shaped
// content) — a false negative in the very detection this file exists to test.
checkContent(
  'a removed/added line whose content itself starts with -/+ (doubles the diff marker) is still matched',
  ['@@ -1,1 +1,1 @@', '--ADMIN_KEY;', '++ADMIN_KEY;'].join('\n'),
  true,
);

// ── AC2/Slice B: needs_daniel is a hard stop wherever the fleet records it ──
checkNeedsDaniel('needs_daniel in PR body', 'Adds a new field. needs_daniel: touches contact resolution.', true);
checkNeedsDaniel('needs-daniel (hyphenated) still matches', 'flagging this needs-daniel, protected-path', true);
checkNeedsDaniel('needs_daniel in a review-verdict doc', 'VERDICT: APPROVED — PR #455\n(needs_daniel, protected-path)', true);
checkNeedsDaniel('an ordinary PR body does not false-positive', 'Fixes the null-check in the readiness gate.', false);

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
