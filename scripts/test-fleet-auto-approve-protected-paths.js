#!/usr/bin/env node
/**
 * Standalone, dependency-free test for the PROTECTED-path list used by
 * `.github/workflows/fleet-auto-approve.yml`'s `evaluate` job (step "2.
 * Protected paths", ~lines 99-121).
 *
 * That job runs under `actions/github-script@v7` with NO `actions/checkout`
 * step, so the runner never has this repo's files present and the
 * protected-path logic CANNOT `require()` a shared module — it must stay
 * fully inline in the YAML. `PROTECTED` below is an intentional DUPLICATE
 * (mirror) of that inline array, kept in sync by hand. If you change the
 * array in the workflow file, update this array to match, and vice versa.
 *
 * Run: node scripts/test-fleet-auto-approve-protected-paths.js
 * Exits 0 if every case passes, 1 otherwise.
 *
 * Context: dev-requests/2026-07-13-fleet-auto-approve-protected-path-regex-widen.md
 * (widened after PR #206 and PR #287 both auto-merged changes to
 * src/routes/owner-portal.ts uncaught — /auth/i alone doesn't match a
 * filename that only contains "owner-portal", not "auth").
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

function isProtected(filename) {
  return PROTECTED.some((re) => re.test(filename));
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
