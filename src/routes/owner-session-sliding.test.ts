/**
 * owner-session-sliding.test.ts — A2A dev-request
 * 2026-11-09-rfb-eierokt-fornyes-ved-bruk: the RFB owner session that is
 * renewed by use (OWNER_SESSION_SLIDING_ENABLED, default off).
 *
 *   on-*    AC1, flag on, with a fake clock: login t0 → use at t0+20 d →
 *           expires_at = t0+50 d; no use for 30 d → invalid; daily use →
 *           invalid at t0+90 d; logout and revokeOwnerAccessForAgent → invalid
 *           and never renewed (also when they land between the read and the
 *           write); claim-approval link and mlbridge_ row never renewed; two
 *           calls the same day → one write; cookie Max-Age = time to the new
 *           expiry; Bearer → no Set-Cookie; a re-clicked mail link never
 *           resets the 90-day cap; new sessions last 30 days (capped).
 *   off-*   AC2, flag off: expires_at, cookie and answers as before (7 days
 *           fixed, no renewal writes).
 *   pv-*    AC2/AC3: /personvern nb + en — off: the sentence as before; on:
 *           Daniel's approved wording with the numbers from the settings, and
 *           nothing else on the page changes.
 *
 * Fake clock: SQLite's datetime('now') (the readers' and the renewal's guard)
 * cannot be faked, so time is moved the other way — `advance(token, ms)`
 * shifts the row's used_at / created_at / expires_at back by `ms`, which is
 * exactly what the passing of `ms` looks like to every reader. Expiries are
 * read back relative to the session's own (shifted) t0.
 *
 * Fresh in-memory SQLite with the real schema, an in-process server with the
 * real owner-portal router plus a probe route that answers with
 * verifyOwnerSession(req). Every global it touches (getDb() singleton, env)
 * is restored in finally.
 *
 * Exported runOwnerSessionSlidingTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/owner-session-sliding.test.ts
 */

import Database from "better-sqlite3";
import * as http from "http";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const DAY = 24 * 60 * 60 * 1000;
const TOL_MS = 5000;

export async function runOwnerSessionSlidingTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const near = (actual: number, expected: number, label: string, tol = TOL_MS): void =>
    ok(Math.abs(actual - expected) <= tol, `${label} (got ${actual}, want ${expected} ± ${tol})`);

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");

  const ENV_KEYS = [
    "OWNER_SESSION_SLIDING_ENABLED", "OWNER_SESSION_IDLE_DAYS", "OWNER_SESSION_MAX_DAYS",
    "OWNER_VERIFIED_OWNER_GATE_ENABLED", "OWNER_UNIFIED_SESSION_ENABLED", "PRODUCT_IMPORT_OUTREACH_ENABLED",
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  let server: http.Server | null = null;
  const flag = (v: string | undefined): void => {
    if (v === undefined) delete process.env.OWNER_SESSION_SLIDING_ENABLED;
    else process.env.OWNER_SESSION_SLIDING_ENABLED = v;
  };

  try {
    for (const k of ENV_KEYS) delete process.env[k];
    initMod.__setDbForTesting(db);
    initMod.__initSchemaForTesting(db);
    try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* already loaded */ }

    const ownerPortal = require("./owner-portal") as typeof import("./owner-portal");
    const sliding = require("../services/owner-session-sliding") as typeof import("../services/owner-session-sliding");
    const { revokeOwnerAccessForAgent } = require("../services/owner-access-revocation") as typeof import("../services/owner-access-revocation");
    {
      const express = require("express");
      const app = express();
      app.get("/__probe", (req: any, res: any) => { res.json(ownerPortal.verifyOwnerSession(req)); });
      app.use("/", ownerPortal.default);
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    }
    const port = (server!.address() as any).port as number;
    type Resp = { status: number; json: any; location: string | undefined; setCookie: string[] };
    function req(method: string, urlPath: string, headers: Record<string, string> = {}): Promise<Resp> {
      return new Promise((resolve, reject) => {
        const r = http.request({ method, host: "127.0.0.1", port, path: urlPath, headers }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => {
            let json: any = null;
            try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* html */ }
            const sc = resp.headers["set-cookie"];
            resolve({ status: resp.statusCode || 0, json, location: resp.headers["location"] as string | undefined,
              setCookie: Array.isArray(sc) ? sc : sc ? [String(sc)] : [] });
          });
        });
        r.on("error", reject);
        r.end();
      });
    }
    const probe = (token: string, how: "cookie" | "bearer" = "cookie") =>
      req("GET", "/__probe", how === "cookie" ? { Cookie: `rfb_owner_session=${token}` } : { Authorization: `Bearer ${token}` });
    const verifyLink = (token: string) => req("GET", `/magic-link-verify?token=${encodeURIComponent(token)}`);
    /** The rfb_owner_session Set-Cookie: its value and Max-Age (seconds), or null. */
    const sessionCookie = (r: Resp): { value: string; maxAge: number } | null => {
      for (const c of r.setCookie) {
        const m = /^rfb_owner_session=([^;]*)/.exec(c);
        if (!m) continue;
        const a = /;\s*Max-Age=(-?\d+)/i.exec(c);
        return { value: m[1] ?? "", maxAge: a ? Number(a[1]) : NaN };
      }
      return null;
    };
    const writes = (): number => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const row = (token: string): any => db.prepare("SELECT * FROM magic_links WHERE token = ?").get(token);
    const at = (v: unknown): number => sliding.parseOwnerSessionTime(v);

    // ── fixtures ────────────────────────────────────────────────────────
    const AG = "oss-a";
    db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories)
                VALUES (?, 'Glidegården', 'Testprodusent', 'test', 'post@oss-a.example.test', 'https://example.test', 'producer', 'k-oss-a', '["vegetables"]')`)
      .run(AG);
    db.prepare("INSERT INTO agent_knowledge (agent_id, email) VALUES (?, ?)").run(AG, "eier@oss-a.example.test");
    let seq = 0;
    /** A session row as openOwnerSession writes it, t0 = now; returns token + its clock. */
    function session(o: { id?: string; used?: 0 | 1; lifetimeMs?: number } = {}): { token: string; t0: number } {
      const n = ++seq;
      const token = `oss-token-${n}-${"x".repeat(32)}`;
      const now = Date.now();
      db.prepare(`INSERT INTO magic_links (id, email, token, agent_id, used, used_at, created_at, expires_at)
                  VALUES (?, 'eier@oss-a.example.test', ?, ?, ?, ?, ?, ?)`)
        .run(o.id ?? `mlsess_oss${n}`, token, AG, o.used ?? 1, (o.used ?? 1) === 1 ? new Date(now).toISOString() : null,
          new Date(now).toISOString(), new Date(now + (o.lifetimeMs ?? 30 * DAY)).toISOString());
      return { token, t0: now };
    }
    /** Fake clock: `ms` pass for this session (its timestamps move back by `ms`). */
    const clocks = new Map<string, number>();
    function advance(s: { token: string; t0: number }, ms: number): void {
      const r = row(s.token);
      const back = (v: unknown): string | null => (v == null ? null : new Date(at(v) - ms).toISOString());
      db.prepare("UPDATE magic_links SET used_at = ?, created_at = ?, expires_at = ? WHERE token = ?")
        .run(back(r.used_at), back(r.created_at), back(r.expires_at), s.token);
      clocks.set(s.token, (clocks.get(s.token) ?? 0) + ms);
    }
    /** expires_at relative to the session's t0, in ms (fake-clock time). */
    const relExpiry = (s: { token: string; t0: number }): number => at(row(s.token).expires_at) + (clocks.get(s.token) ?? 0) - s.t0;

    // ══ off-*: flag off → today's behaviour, byte-identical ══════════════
    flag(undefined);
    {
      eq(sliding.newOwnerSessionLifetimeMs(), 7 * DAY, "off-01: a new session lasts 7 days with the flag off");
      for (const v of ["0", "false", "yes", "TRUE", ""]) {
        eq(sliding.isOwnerSessionSlidingEnabled({ OWNER_SESSION_SLIDING_ENABLED: v } as any), false, `off-02: OWNER_SESSION_SLIDING_ENABLED=${JSON.stringify(v)} is off`);
      }
      // The e-mailed link (ml_ row, 7 days from sending): token becomes the session.
      const created = Date.now() - 2 * DAY;
      const linkExp = new Date(created + 7 * DAY).toISOString();
      db.prepare(`INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES ('ml_off1', 'eier@oss-a.example.test', 'oss-off-link', ?, 0, ?, ?)`)
        .run(AG, new Date(created).toISOString(), linkExp);
      const login = await verifyLink("oss-off-link");
      eq([login.status, login.location], [302, `/eier/${AG}/portal`], "off-03: /magic-link-verify redirects to the portal as before");
      eq(sessionCookie(login)?.maxAge, 7 * 24 * 60 * 60, "off-04: cookie Max-Age is exactly 7 days");
      eq([row("oss-off-link").used, row("oss-off-link").expires_at], [1, linkExp], "off-05: the row is marked used, expires_at untouched");
      const w0 = writes();
      const use = await probe("oss-off-link");
      eq([use.json?.valid, use.json?.agentId, writes() - w0, sessionCookie(use)], [true, AG, 0, null],
        "off-06: a use is accepted with no write and no Set-Cookie");
      // An open session at day 5 of 7: still nothing renewed.
      const s = session({ lifetimeMs: 7 * DAY });
      advance(s, 5 * DAY);
      const w1 = writes();
      const r5 = await probe(s.token);
      eq([r5.json?.valid, writes() - w1, sessionCookie(r5)], [true, 0, null], "off-07: day 5 of 7 — valid, no write, no cookie");
      near(relExpiry(s), 7 * DAY, "off-08: expires_at still t0 + 7 d");
      advance(s, 2 * DAY + 60_000);
      eq((await probe(s.token)).json?.valid, false, "off-09: invalid after 7 days, as before");
      // Claim-approval link → fresh mlsess_ row, 7 days, cookie 7 days.
      db.prepare(`INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES ('mlclaim_off', 'eier@oss-a.example.test', 'oss-off-claim', ?, 0, ?, ?)`)
        .run(AG, new Date().toISOString(), new Date(Date.now() + 15 * 60_000).toISOString());
      const claimLogin = await verifyLink("oss-off-claim");
      const c = sessionCookie(claimLogin);
      eq(c?.maxAge, 7 * 24 * 60 * 60, "off-10: openOwnerSession cookie Max-Age 7 days");
      const sess = c ? row(c.value) : null;
      ok(!!sess && String(sess.id).startsWith("mlsess_"), "off-11: openOwnerSession wrote an mlsess_ row");
      if (sess) near(at(sess.expires_at) - at(sess.created_at), 7 * DAY, "off-12: openOwnerSession expires_at = now + 7 d", 2);
      // The direct helper refuses with the flag off.
      const s2 = session({ lifetimeMs: 2 * DAY });
      eq(sliding.renewOwnerSessionOnUse(db as any, row(s2.token)), null, "off-13: renewOwnerSessionOnUse is a no-op with the flag off");
    }

    // ══ on-*: flag on (AC1) ═══════════════════════════════════════════
    flag("1");
    {
      eq(sliding.newOwnerSessionLifetimeMs(), 30 * DAY, "on-00a: a new session lasts 30 days with the flag on");
      eq(sliding.isOwnerSessionSlidingEnabled({ OWNER_SESSION_SLIDING_ENABLED: "true" } as any), true, "on-00b: «true» is on");
      eq(sliding.newOwnerSessionLifetimeMs({ OWNER_SESSION_SLIDING_ENABLED: "1", OWNER_SESSION_MAX_DAYS: "20" } as any), 20 * DAY,
        "on-00c: a new session is capped by OWNER_SESSION_MAX_DAYS");
      eq(sliding.newOwnerSessionLifetimeMs({ OWNER_SESSION_SLIDING_ENABLED: "1", OWNER_SESSION_IDLE_DAYS: "abc" } as any), 30 * DAY,
        "on-00d: an unreadable OWNER_SESSION_IDLE_DAYS falls back to 30");
      eq(sliding.parseOwnerSessionTime("2026-11-13 10:00:00"), Date.parse("2026-11-13T10:00:00Z"), "on-00e: SQLite native timestamps are read as UTC");

      // on-01..05: login t0 via the e-mailed link → use at t0+20 d → t0+50 d.
      db.prepare(`INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES ('ml_on1', 'eier@oss-a.example.test', 'oss-on-link', ?, 0, ?, ?)`)
        .run(AG, new Date(Date.now() - DAY).toISOString(), new Date(Date.now() + 6 * DAY).toISOString());
      const t0 = Date.now();
      const login = await verifyLink("oss-on-link");
      const s = { token: "oss-on-link", t0 };
      eq([login.status, login.location], [302, `/eier/${AG}/portal`], "on-01: /magic-link-verify redirects to the portal");
      near((sessionCookie(login)?.maxAge ?? 0) * 1000, 30 * DAY, "on-02: login cookie Max-Age = 30 days");
      near(relExpiry(s), 30 * DAY, "on-03: login sets expires_at = t0 + 30 d");
      near(at(row(s.token).used_at), t0, "on-03b: used_at = the login time (the cap's start)");
      advance(s, 20 * DAY);
      const w0 = writes();
      const use20 = await probe(s.token);
      eq([use20.json?.valid, use20.json?.agentId, writes() - w0], [true, AG, 1], "on-04: use at t0+20 d is accepted with one write");
      near(relExpiry(s), 50 * DAY, "on-05: expires_at = t0 + 50 d after the use at t0+20 d");
      near((sessionCookie(use20)?.maxAge ?? 0) * 1000, at(row(s.token).expires_at) - Date.now(), "on-06: cookie Max-Age = time to the new expires_at (30 d)");
      eq(sessionCookie(use20)?.value, s.token, "on-06b: the re-set cookie carries the same token");

      // on-07..08: two calls the same day → one write.
      const exp1 = row(s.token).expires_at;
      const w1 = writes();
      const again = await probe(s.token);
      eq([again.json?.valid, writes() - w1, sessionCookie(again), row(s.token).expires_at], [true, 0, null, exp1],
        "on-07: a second call right after → no write, no cookie");
      advance(s, 12 * 60 * 60 * 1000);
      const w2 = writes();
      const half = await probe(s.token);
      eq([half.json?.valid, writes() - w2, sessionCookie(half)], [true, 0, null], "on-08: a call 12 h later the same day → no write, no cookie");
      near(relExpiry(s), 50 * DAY, "on-08b: expires_at still t0 + 50 d");

      // on-09..10: Bearer → the row renews, no Set-Cookie.
      const b = session();
      advance(b, 10 * DAY);
      const bear = await probe(b.token, "bearer");
      eq([bear.json?.valid, bear.setCookie.length], [true, 0], "on-09: Bearer use is accepted with no Set-Cookie at all");
      near(relExpiry(b), 40 * DAY, "on-10: Bearer use at t0+10 d → expires_at = t0 + 40 d");

      // on-11..12: no use for 30 days → invalid, and not revived.
      const idle = session();
      advance(idle, 30 * DAY + 60_000);
      const expIdle = row(idle.token).expires_at;
      const idleUse = await probe(idle.token);
      eq([idleUse.json?.valid, sessionCookie(idleUse)], [false, null], "on-11: no use for 30 days → invalid");
      eq(row(idle.token).expires_at, expIdle, "on-12: the expired row is not renewed");

      // on-13..15: daily use → invalid at t0+90 d.
      const daily = session();
      let allValid = true;
      for (let d = 1; d <= 89; d++) {
        advance(daily, DAY);
        if ((await probe(daily.token)).json?.valid !== true) { allValid = false; break; }
      }
      ok(allValid, "on-13: daily use keeps the session valid through day 89");
      near(relExpiry(daily), 90 * DAY, "on-14: daily use reaches the cap: expires_at = t0 + 90 d (the final step onto the cap is written)");
      advance(daily, 12 * 60 * 60 * 1000);
      const wCap = writes();
      await probe(daily.token);
      eq(writes() - wCap, 0, "on-14b: on the cap a further use writes nothing");
      near(relExpiry(daily), 90 * DAY, "on-14c: … and the expiry stays on the cap");
      advance(daily, 12 * 60 * 60 * 1000 + 60_000);
      eq((await probe(daily.token)).json?.valid, false, "on-15: daily use → invalid at t0 + 90 d");

      // on-16: near the cap the cookie follows the capped expiry.
      const cap = session();
      advance(cap, 25 * DAY);
      await probe(cap.token); // t0 + 25 d → expires t0 + 55 d
      advance(cap, 25 * DAY);
      await probe(cap.token); // t0 + 50 d → expires t0 + 80 d
      advance(cap, 20 * DAY); // t0 + 70 d
      const capUse = await probe(cap.token);
      near(relExpiry(cap), 90 * DAY, "on-16: use at t0+70 d → expires_at = t0 + 90 d (cap), not t0 + 100 d");
      near((sessionCookie(capUse)?.maxAge ?? 0) * 1000, 20 * DAY, "on-17: cookie Max-Age = time to the capped expiry (20 d)");

      // on-18..20: logout → invalid at once, never renewed.
      const lo = session();
      advance(lo, 5 * DAY);
      const out = await req("POST", `/eier/${AG}/logout`, { Cookie: `rfb_owner_session=${lo.token}` });
      eq(out.status, 303, "on-18: logout answers 303");
      const expLo = row(lo.token).expires_at;
      ok(at(expLo) < Date.now(), "on-18b: logout moved expires_at into the past");
      const afterLo = await probe(lo.token);
      const afterLoB = await probe(lo.token, "bearer");
      eq([afterLo.json?.valid, afterLoB.json?.valid, sessionCookie(afterLo), row(lo.token).expires_at], [false, false, null, expLo],
        "on-19: after logout the token is invalid (cookie and Bearer) and expires_at is unchanged");
      // Logout landing between the read and the write: the guarded UPDATE loses.
      const race = session();
      advance(race, 10 * DAY);
      const stale = row(race.token);
      ownerPortal.revokeOwnerSessionToken(race.token);
      const expRace = row(race.token).expires_at;
      eq([sliding.renewOwnerSessionOnUse(db as any, stale), row(race.token).expires_at], [null, expRace],
        "on-20: a logout between the read and the renewal wins — the row stays expired");

      // on-21..22: revokeOwnerAccessForAgent → invalid, never renewed.
      const rv = session();
      advance(rv, 10 * DAY);
      const staleRv = row(rv.token);
      ok(revokeOwnerAccessForAgent(db as any, AG, { reason: "test" }) >= 1, "on-21: revokeOwnerAccessForAgent revoked the agent's rows");
      const expRv = row(rv.token).expires_at;
      const rvUse = await probe(rv.token);
      eq([rvUse.json?.valid, sessionCookie(rvUse), row(rv.token).expires_at], [false, null, expRv], "on-22: a revoked session is invalid and not renewed");
      eq([sliding.renewOwnerSessionOnUse(db as any, staleRv), row(rv.token).expires_at], [null, expRv],
        "on-22b: a revocation between the read and the renewal wins");

      // on-23..25: claim-approval link and bridge row are never renewed.
      const cl = session({ id: "mlclaim_oss1", lifetimeMs: 15 * 60_000 });
      const expCl = row(cl.token).expires_at;
      const clUse = await probe(cl.token);
      eq([clUse.json?.valid, sessionCookie(clUse), row(cl.token).expires_at], [false, null, expCl],
        "on-23: a used claim-approval link is no session and is not renewed");
      const br = session({ id: "mlbridge_oss1", lifetimeMs: 15 * 60_000 });
      advance(br, 5 * 60_000);
      const expBr = row(br.token).expires_at;
      const w3 = writes();
      const brUse = await probe(br.token);
      eq([brUse.json?.valid, writes() - w3, sessionCookie(brUse), row(br.token).expires_at], [true, 0, null, expBr],
        "on-24: a used mlbridge_ row is accepted as before but never renewed");
      eq(sliding.renewOwnerSessionOnUse(db as any, row(br.token)), null, "on-24b: renewOwnerSessionOnUse refuses a bridge row");
      const brNew = session({ id: "mlbridge_oss2", used: 0, lifetimeMs: 15 * 60_000 });
      const expBrNew = row(brNew.token).expires_at;
      const brLogin = await verifyLink(brNew.token);
      eq([sessionCookie(brLogin)?.maxAge, row(brNew.token).expires_at], [7 * 24 * 60 * 60, expBrNew],
        "on-25: /magic-link-verify with a bridge token keeps today's branch — expires_at untouched");

      // on-26..27: a re-clicked e-mail link never resets the cap.
      const rc = session();
      advance(rc, 85 * DAY); // the cap (t0 + 90 d) is now 5 days ahead
      const usedAt = row(rc.token).used_at;
      // Give the (by now expired) row a live expiry: t0 + 87 d, 2 days ahead.
      db.prepare("UPDATE magic_links SET expires_at = ? WHERE token = ?").run(new Date(Date.now() + 2 * DAY).toISOString(), rc.token);
      const reclick = await verifyLink(rc.token);
      eq([reclick.status, row(rc.token).used_at], [302, usedAt], "on-26: re-clicking an already used link keeps used_at (the cap's start)");
      near(relExpiry(rc), 90 * DAY, "on-27: the re-click renews only up to the cap (t0 + 90 d), not to now + 30 d");
      near((sessionCookie(reclick)?.maxAge ?? 0) * 1000, 5 * DAY, "on-27b: its cookie Max-Age = time to that expiry (5 d)");

      // on-28..30: new sessions (openOwnerSession via the claim link) — 30 days, capped.
      db.prepare(`INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES ('mlclaim_on2', 'eier@oss-a.example.test', 'oss-on-claim', ?, 0, ?, ?)`)
        .run(AG, new Date().toISOString(), new Date(Date.now() + 15 * 60_000).toISOString());
      const cLogin = await verifyLink("oss-on-claim");
      const c = sessionCookie(cLogin);
      near((c?.maxAge ?? 0) * 1000, 30 * DAY, "on-28: openOwnerSession cookie Max-Age = 30 days");
      const cs = c ? row(c.value) : null;
      ok(!!cs && String(cs.id).startsWith("mlsess_"), "on-29: openOwnerSession wrote an mlsess_ row");
      if (cs) near(at(cs.expires_at) - at(cs.created_at), 30 * DAY, "on-30: openOwnerSession expires_at = now + 30 d", 2);
      process.env.OWNER_SESSION_MAX_DAYS = "20";
      db.prepare(`INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES ('mlclaim_on3', 'eier@oss-a.example.test', 'oss-on-claim3', ?, 0, ?, ?)`)
        .run(AG, new Date().toISOString(), new Date(Date.now() + 15 * 60_000).toISOString());
      const c3 = sessionCookie(await verifyLink("oss-on-claim3"));
      near((c3?.maxAge ?? 0) * 1000, 20 * DAY, "on-31: with OWNER_SESSION_MAX_DAYS=20 a new session is capped at 20 days");
      delete process.env.OWNER_SESSION_MAX_DAYS;

      // on-32: a fake request without a response object (direct callers) still works.
      const d = session();
      advance(d, 10 * DAY);
      const direct = ownerPortal.verifyOwnerSession({ headers: { cookie: `rfb_owner_session=${d.token}` } } as any);
      eq(direct.valid, true, "on-32: verifyOwnerSession without req.res is valid");
      near(relExpiry(d), 40 * DAY, "on-32b: … and renews the row");
    }

    // ══ pv-*: the privacy page (AC2 + AC3) ═══════════════════════════════
    {
      const seoRouter = require("./seo").default as any;
      const render = (lang: "no" | "en"): string => {
        const layer = (seoRouter.stack as any[]).find((l: any) => l.route?.path === "/personvern" && l.route.methods?.get);
        let body = "";
        const res: any = {
          status() { return this; }, send(b: unknown) { body = String(b); return this; },
          setHeader() { return this; }, header() { return this; }, set() { return this; }, type() { return this; },
        };
        layer.route.stack[layer.route.stack.length - 1].handle({ lang, params: {}, query: {}, headers: {}, get() { return undefined; } }, res, () => {});
        return body;
      };
      const OLD_NB = "en innloggings-cookie for selgere som verifiserer en magisk lenke eller et gårdssalg-eierskapskrav (httpOnly, utløper etter 7 dager)";
      const OLD_EN = "a sign-in session cookie for sellers who verify a magic link or a farm-shop ownership claim (httpOnly, expires after 7 days)";
      const NEW_NB = "en innloggings-cookie for selgere som verifiserer en magisk lenke (httpOnly, utløper etter 30 dager uten bruk og senest etter 90 dager) eller et gårdssalg-eierskapskrav (httpOnly, utløper etter 7 dager)";
      const NEW_EN = "a sign-in session cookie for sellers who verify a magic link (httpOnly, expires after 30 days without use and after 90 days at the latest) or a farm-shop ownership claim (httpOnly, expires after 7 days)";
      flag(undefined);
      const offNb = render("no");
      const offEn = render("en");
      ok(offNb.includes(`informasjonskapsler: ${OLD_NB}, og`) && !offNb.includes("uten bruk"), "pv-01: flag off — nb sentence exactly as before");
      ok(offEn.includes(`essential cookies: ${OLD_EN}, and`) && !offEn.includes("without use"), "pv-02: flag off — en sentence exactly as before");
      flag("0");
      eq([render("no"), render("en")], [offNb, offEn], "pv-03: flag «0» renders byte-identical to unset");
      flag("1");
      const onNb = render("no");
      const onEn = render("en");
      ok(onNb.includes(`informasjonskapsler: ${NEW_NB}, og`), "pv-04: flag on — nb shows Daniel's approved wording");
      ok(onEn.includes(`essential cookies: ${NEW_EN}, and`), "pv-05: flag on — en shows Daniel's approved wording");
      eq(onNb.replace(NEW_NB, OLD_NB), offNb, "pv-06: flag on — nothing else on the nb page changes");
      eq(onEn.replace(NEW_EN, OLD_EN), offEn, "pv-07: flag on — nothing else on the en page changes");
      process.env.OWNER_SESSION_IDLE_DAYS = "21";
      process.env.OWNER_SESSION_MAX_DAYS = "60";
      ok(render("no").includes("(httpOnly, utløper etter 21 dager uten bruk og senest etter 60 dager)")
        && render("en").includes("(httpOnly, expires after 21 days without use and after 60 days at the latest)"),
        "pv-08: the numbers come from OWNER_SESSION_IDLE_DAYS / OWNER_SESSION_MAX_DAYS");
      delete process.env.OWNER_SESSION_IDLE_DAYS;
      delete process.env.OWNER_SESSION_MAX_DAYS;
      flag(undefined);
    }
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${err?.stack || err}`);
    if (log) console.log(`  ✗ unexpected error: ${err?.stack || err}`);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";
  if (!process.env.EMAIL_FORCE_DRY_RUN) process.env.EMAIL_FORCE_DRY_RUN = "true";
  runOwnerSessionSlidingTests({ log: true }).then((r) => {
    console.log(`\nowner-session-sliding: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
