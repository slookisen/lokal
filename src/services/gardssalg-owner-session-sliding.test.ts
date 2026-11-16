/**
 * gardssalg-owner-session-sliding.test.ts — A2A dev-request 2026-11-12-
 * opplevagent-o3-eierkrav-og-innlogging, slice O3-3: the gårdssalg owner
 * session is renewed by use (GARDSSALG_OWNER_SESSION_SLIDING_ENABLED, default
 * off), and an ownership change ends the previous owner's sessions.
 *
 *   ak1-*  flag on: login → used day 29 → valid day 50 → cap at day 90 →
 *          invalid day 91; at most one renewal write per day; a re-clicked
 *          link never moves the cap anchor; the cookie is re-set on renewal.
 *   rv-*   an expired or revoked row is never revived.
 *   ak2-*  a different address taking the provider revokes the previous
 *          owner's sessions (flag off and on); the same address does not.
 *   off-*  flag off: rows, answers and cookie exactly as before.
 *   l1     no token in any log line.
 *
 * Fake clock: SQLite's datetime('now') cannot be faked, so time is moved the
 * other way — `advance(token, ms)` shifts the row's used_at / created_at /
 * expires_at back by `ms` (same approach as src/routes/owner-session-sliding.test.ts).
 *
 * Exported runGardssalgOwnerSessionSlidingTests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/services/gardssalg-owner-session-sliding.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const DAY = 24 * 60 * 60 * 1000;
const TOL_MS = 5000;

export function runGardssalgOwnerSessionSlidingTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const eq = (actual: unknown, expected: unknown, label: string): void => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  };
  const ok = (cond: boolean, label: string): void => eq(!!cond, true, label);
  const near = (actual: number, expected: number, label: string): void =>
    ok(Math.abs(actual - expected) <= TOL_MS, `${label} (got ${actual}, want ${expected} ± ${TOL_MS})`);

  return (async () => {
    const ENV_KEYS = ["EXPERIENCES_DB_PATH", "GARDSSALG_OWNER_SESSION_SLIDING_ENABLED", "GARDSSALG_OWNER_SESSION_IDLE_DAYS", "GARDSSALG_OWNER_SESSION_MAX_DAYS", "GARDSSALG_CLAIM_CONFIRM_STEP_ENABLED"];
    const savedEnv: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    const flag = (v: string | undefined): void => {
      if (v === undefined) delete process.env.GARDSSALG_OWNER_SESSION_SLIDING_ENABLED;
      else process.env.GARDSSALG_OWNER_SESSION_SLIDING_ENABLED = v;
    };

    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("./gardssalg-claim"),
      require.resolve("./gardssalg-owner-session-sliding"),
      require.resolve("../routes/gardssalg-claim"),
    ]);
    const logged: string[] = [];
    const origConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    const tokens: string[] = [];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const claimSvc = require("./gardssalg-claim") as typeof import("./gardssalg-claim");
      const sliding = require("./gardssalg-owner-session-sliding") as typeof import("./gardssalg-owner-session-sliding");
      const { parseOwnerSessionTime } = require("./owner-session-sliding") as typeof import("./owner-session-sliding");
      const routerMod = require("../routes/gardssalg-claim") as typeof import("../routes/gardssalg-claim");

      const insertProvider = db.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, content_source, epost, enrichment_state, verification_status, source, confidence)
        VALUES (@id, @id, @id, 'experiences', @org_nr, 1, NULL, NULL, 'raw', 'pending_verify', 'test-fixture', 'medium')
      `);
      ["p-ak1", "p-rv", "p-ak2", "p-ak2on", "p-off"].forEach((id, i) => insertProvider.run({ id, org_nr: `91330000${i}` }));
      let seq = 0;
      const newClaim = (providerId: string, email: string): string => {
        seq++;
        const token = (seq.toString(16) + "a".repeat(64)).slice(0, 64);
        tokens.push(token);
        db.prepare(
          `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at)
           VALUES (?, ?, ?, 'manual', ?, 0, ?, ?)`,
        ).run(`gsc_t${seq}`, providerId, email, token, new Date().toISOString(), new Date(Date.now() + 7 * DAY).toISOString());
        return token;
      };
      const row = (token: string) => db.prepare(`SELECT * FROM gardssalg_claims WHERE token = ?`).get(token) as any;
      const advance = (token: string, ms: number): void => {
        const r = row(token);
        const shift = (v: string | null) => (v ? new Date(parseOwnerSessionTime(v) - ms).toISOString() : v);
        db.prepare(`UPDATE gardssalg_claims SET used_at = ?, created_at = ?, expires_at = ? WHERE token = ?`)
          .run(shift(r.used_at), shift(r.created_at), shift(r.expires_at), token);
      };
      // Expiry and start relative to the session's own (shifted) start.
      const sinceStart = (token: string): number => {
        const r = row(token);
        return parseOwnerSessionTime(r.expires_at) - parseOwnerSessionTime(r.used_at);
      };
      const verify = (token: string) => claimSvc.verifyGardssalgOwnerSessionToken(token);

      for (const k of ["log", "warn", "error", "info"] as const) {
        (console as any)[k] = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
      }

      // ── AK1: flag on ─────────────────────────────────────────────────────
      flag("1");
      const t1 = newClaim("p-ak1", "eier@gard.test");
      eq(claimSvc.verifyClaimToken(t1).valid, true, "ak1-1: flag on, the claim link opens a session");
      near(sinceStart(t1), 30 * DAY, "ak1-2: a new session lasts 30 days");
      near(claimSvc.gardssalgOwnerSessionCookieMaxAge(t1), 30 * DAY, "ak1-3: the login cookie lasts 30 days");
      advance(t1, 29 * DAY);
      const d29 = verify(t1);
      ok(d29.valid && typeof d29.renewedExpiresAtMs === "number", "ak1-4: used on day 29 → valid and renewed");
      near(sinceStart(t1), 59 * DAY, "ak1-5: … expiry moved to day 59");
      const before = row(t1).expires_at;
      const again = verify(t1);
      eq([again.valid, again.renewedExpiresAtMs, row(t1).expires_at], [true, undefined, before], "ak1-6: a second use the same day writes nothing");
      advance(t1, 21 * DAY);
      // The cookie path: a cookie session gets its cookie re-set on renewal.
      const cookies: Array<{ name: string; value: string; maxAge: number }> = [];
      const fakeRes = { headersSent: false, cookie: (name: string, value: string, o: any) => { cookies.push({ name, value, maxAge: o.maxAge }); } };
      const s50 = routerMod.sessionFromRequest({ headers: { cookie: `oa_owner_session=${t1}` }, res: fakeRes } as any);
      eq([s50.valid, s50.providerId], [true, "p-ak1"], "ak1-7: AK1 — valid on day 50");
      near(sinceStart(t1), 80 * DAY, "ak1-8: … expiry moved to day 80");
      ok(cookies.length === 1 && cookies[0]!.name === "oa_owner_session" && Math.abs(cookies[0]!.maxAge - 30 * DAY) <= TOL_MS, "ak1-9: … cookie re-set with maxAge = time to the new expiry");
      advance(t1, 29 * DAY);
      ok(verify(t1).valid, "ak1-10: used on day 79 → valid");
      near(sinceStart(t1), 90 * DAY, "ak1-11: … expiry capped at day 90 from login");
      advance(t1, 10 * DAY);
      ok(verify(t1).valid, "ak1-12: day 89 → still valid, no move past the cap");
      near(sinceStart(t1), 90 * DAY, "ak1-13: … expiry still day 90");
      advance(t1, 2 * DAY);
      eq(verify(t1).valid, false, "ak1-14: AK1 — invalid on day 91");

      const t1b = newClaim("p-ak1", "eier@gard.test");
      claimSvc.verifyClaimToken(t1b);
      const startB = row(t1b).used_at;
      advance(t1b, 10 * DAY);
      const shiftedStart = row(t1b).used_at;
      ok(claimSvc.verifyClaimToken(t1b).valid, "ak1-15: a re-clicked link still logs in");
      eq([row(t1b).used_at !== startB, row(t1b).used_at], [true, shiftedStart], "ak1-16: … the re-click keeps used_at (the cap anchor)");
      near(sinceStart(t1b), 40 * DAY, "ak1-17: … and renews to now + 30 days");

      // ── never revived ──────────────────────────────────────────────────
      const tExp = newClaim("p-rv", "eier@rv.test");
      claimSvc.verifyClaimToken(tExp);
      advance(tExp, 31 * DAY);
      const expRow = row(tExp);
      eq(verify(tExp).valid, false, "rv-1: unused for 31 days → invalid");
      eq([sliding.renewGardssalgOwnerSessionOnUse(db, expRow), row(tExp).expires_at], [null, expRow.expires_at], "rv-2: an expired row is never renewed");
      const tRev = newClaim("p-rv", "eier@rv.test");
      claimSvc.verifyClaimToken(tRev);
      advance(tRev, 5 * DAY);
      const revRow = row(tRev);
      claimSvc.revokeClaimToken(tRev);
      eq(verify(tRev).valid, false, "rv-3: logged out → invalid");
      eq([sliding.renewGardssalgOwnerSessionOnUse(db, revRow), row(tRev).expires_at], [null, revRow.expires_at], "rv-4: a revoked row is never renewed, even from a read made before the logout");

      // ── AK2: ownership change ─────────────────────────────────────────
      for (const [mode, prov] of [["off", "p-ak2"], ["on", "p-ak2on"]] as const) {
        flag(mode === "on" ? "true" : undefined);
        const a1 = newClaim(prov, "Gammel@Gard.test");
        const a2 = newClaim(prov, "gammel@gard.test ");
        claimSvc.verifyClaimToken(a1);
        claimSvc.verifyClaimToken(a2);
        ok(verify(a1).valid && verify(a2).valid, `ak2-${mode}-1: the same address logging in again keeps its other sessions`);
        const b = newClaim(prov, "ny@gard.test");
        const confirmed = mode === "on" ? claimSvc.confirmClaimToken(b) : claimSvc.verifyClaimToken(b);
        eq(confirmed.valid, true, `ak2-${mode}-2: a new owner takes the provider`);
        eq([verify(a1).valid, verify(a2).valid], [false, false], `ak2-${mode}-3: AK2 — the previous owner's sessions are invalid`);
        eq(verify(b).providerId, prov, `ak2-${mode}-4: the new owner's session is valid`);
        const audit = db.prepare(`SELECT COUNT(*) AS c FROM gardssalg_content_audit WHERE provider_id = ? AND field_name = 'gardssalg_claim_revoked' AND changed_by = 'ownership_change'`).get(prov) as { c: number };
        eq(audit.c, 2, `ak2-${mode}-5: each revoked session is audited`);
        eq(claimSvc.isGardssalgProviderClaimed(prov), true, `ak2-${mode}-6: the provider stays claimed`);
      }

      // ── flag off: unchanged ───────────────────────────────────────────
      for (const v of [undefined, "false", "0"]) {
        flag(v);
        const t = newClaim("p-off", "eier@off.test");
        const issuedExpiry = row(t).expires_at;
        claimSvc.verifyClaimToken(t);
        const r = row(t);
        eq([r.used, r.expires_at], [1, issuedExpiry], `off-${v}-1: using the link keeps the link's own expiry`);
        advance(t, 3 * DAY);
        const snap = JSON.stringify(row(t));
        eq(verify(t), { valid: true, providerId: "p-off", token: t }, `off-${v}-2: the session answer is as before`);
        eq(JSON.stringify(row(t)), snap, `off-${v}-3: verifying writes nothing`);
        const cookieCalls: unknown[] = [];
        routerMod.sessionFromRequest({ headers: { cookie: `oa_owner_session=${t}` }, res: { headersSent: false, cookie: (...a: unknown[]) => cookieCalls.push(a) } } as any);
        eq(cookieCalls.length, 0, `off-${v}-4: no cookie is re-set`);
        eq(claimSvc.gardssalgOwnerSessionCookieMaxAge(t), 7 * DAY, `off-${v}-5: the login cookie stays 7 days`);
        advance(t, 5 * DAY);
        eq(verify(t).valid, false, `off-${v}-6: invalid after the link's 7 days, as before`);
      }

      const allLogs = logged.join("\n");
      ok(!tokens.some((t) => allLogs.includes(t)), "l1: no token in any log line");
    } catch (err: any) {
      failed++;
      failures.push("gardssalg-owner-session-sliding: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      Object.assign(console, origConsole);
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* ignore */ }
      restoreModuleCache();
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runGardssalgOwnerSessionSlidingTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      for (const f of r.failures) console.log(f);
      process.exit(1);
    }
  });
}
