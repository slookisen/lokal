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

const PROTECTED_CONTENT = [
  /\bADMIN_KEY\b/,
  /\bANALYTICS_ADMIN_KEY\b/,
  /\brequireAdmin\w*\b/,
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

// Mirrors contentEditMatch() in the workflow: a pattern must match on BOTH
// an added and a removed line of the SAME file's patch to count — i.e. the
// diff EDITS existing matching code, not just adds a brand-new admin route
// that follows the repo's own standard requireAdmin()/ADMIN_KEY boilerplate.
function contentEditMatch(patch) {
  const added = patchLines(patch, '+');
  const removed = patchLines(patch, '-');
  return PROTECTED_CONTENT.find((re) => re.test(added) && re.test(removed)) || null;
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
