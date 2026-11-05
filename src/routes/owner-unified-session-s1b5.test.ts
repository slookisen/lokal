/**
 * owner-unified-session-s1b5.test.ts — dev-request 2026-10-22-rfb-mine-valg-
 * eierbrytere, S1b punkt 5 («Én eierinnlogging»), AC5. No network, no real
 * e-mail, no production DB: a fresh in-memory SQLite with the real schema and
 * an in-process server with the real routers (owner-portal, owner-orders,
 * payments, marketplace).
 *
 *   gate  OWNER_VERIFIED_OWNER_GATE_ENABLED: off → today's behaviour; on → an
 *         e-mail-match session without verified ownership gets 403 on every
 *         owner endpoint; verified, self-registered and claimed_at owners pass.
 *   one   OWNER_UNIFIED_SESSION_ENABLED: the /selger login also opens the
 *         /eier session → profile, products, statistics, orders with one
 *         login; the portal's «Produkter og åpningstider» button logs the same
 *         owner into /selger without a new e-mail.
 *   out   logout revokes the token (cookie and Bearer), unflagged.
 *   exp   expires_at stored as ISO: expired rejected, valid accepted.
 *
 * Standalone: npx tsx src/routes/owner-unified-session-s1b5.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runOwnerUnifiedSessionS1b5Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed++; if (log) console.log(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${e}\n    actual:   ${a}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const emailMod = require("../services/email-service") as typeof import("../services/email-service");
  const ENV_KEYS = ["OWNER_VERIFIED_OWNER_GATE_ENABLED", "OWNER_UNIFIED_SESSION_ENABLED", "ADMIN_KEY", "PAYMENTS_ENABLED"];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevDb = (() => { try { return initMod.getDb(); } catch { return undefined; } })();
  const es = emailMod.emailService as any;
  const prevSendOwner = es.sendOwnerMagicLink;
  const db = new Database(":memory:");
  let server: http.Server | null = null;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    for (const k of ENV_KEYS) delete process.env[k];
    es.sendOwnerMagicLink = async () => ({ success: true, messageId: "stub" });

    // ── Seed ────────────────────────────────────────────────────────────────
    //   ag-own    verified claim (owner@own.no), is_verified = 1
    //   ag-self   self-registered: verified claim, is_verified = 0
    //   ag-legacy claimed_at set, no claim rows
    //   ag-none   no owner at all; its registered e-mail can still open an
    //             /eier session (the e-mail-match case)
    function agent(id: string, email: string, o: { verified?: number; claimedAt?: string | null } = {}): void {
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories, is_verified, claimed_at)
                  VALUES (?, ?, 'Testprodusent', 'self', ?, 'https://example.no', 'producer', ?, '["vegetables"]', ?, ?)`)
        .run(id, `Gård ${id}`, email, `k-${id}`, o.verified ?? 0, o.claimedAt ?? null);
      db.prepare("INSERT INTO agent_knowledge (agent_id, verification_status, email, phone) VALUES (?, 'verified', ?, '+47 400 00 000')").run(id, email);
    }
    function claim(agentId: string, email: string, token: string): void {
      db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, claim_token, claim_token_expires_at, verified_at)
                  VALUES (?, ?, 'Eier', ?, 'verified', ?, ?, datetime('now'))`)
        .run(`cl-${agentId}`, agentId, email, token, new Date(Date.now() + 30 * 86_400_000).toISOString());
    }
    agent("ag-own", "owner@own.no", { verified: 1 });
    claim("ag-own", "owner@own.no", "claim_own_0");
    agent("ag-self", "self@self.no");
    claim("ag-self", "self@self.no", "claim_self_0");
    agent("ag-legacy", "legacy@legacy.no", { claimedAt: "2026-06-01 10:00:00" });
    agent("ag-none", "info@none.no");

    const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
    function session(agentId: string, email: string, token: string, expiresAt = iso(86_400_000)): string {
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`ml-${token}`, email, token, agentId, iso(0), expiresAt);
      return `rfb_owner_session=${token}`;
    }
    const C_OWN = session("ag-own", "owner@own.no", "tok-own");
    const C_SELF = session("ag-self", "self@self.no", "tok-self");
    const C_LEGACY = session("ag-legacy", "legacy@legacy.no", "tok-legacy");
    const C_NONE = session("ag-none", "info@none.no", "tok-none");

    // ── In-process server with the real routers ────────────────────────────
    {
      const express = require("express");
      const ownerPortal = require("./owner-portal") as typeof import("./owner-portal");
      const ownerOrders = require("./owner-orders") as typeof import("./owner-orders");
      const payments = require("./payments") as typeof import("./payments");
      const marketplace = require("./marketplace") as typeof import("./marketplace");
      const app = express();
      app.use(express.json());
      app.use("/api/marketplace", marketplace.default);
      app.use("/", ownerPortal.default);
      app.use("/", ownerOrders.default);
      payments.mountPaymentRoutes(app, { PAYMENTS_ENABLED: "1", STRIPE_SECRET_KEY: "sk_" + "test_" + "FAKE".repeat(6) });
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    }
    const port = (server!.address() as any).port as number;
    type Resp = { status: number; text: string; json: any; location: string | undefined; setCookie: string[] };
    function req(method: string, urlPath: string, o: { headers?: Record<string, string>; form?: Record<string, string>; json?: unknown } = {}): Promise<Resp> {
      return new Promise((resolve, reject) => {
        let bodyStr: string | undefined;
        const headers: Record<string, string> = { ...(o.headers || {}) };
        if (o.form) { bodyStr = new URLSearchParams(o.form).toString(); headers["Content-Type"] = "application/x-www-form-urlencoded"; }
        if (o.json !== undefined) { bodyStr = JSON.stringify(o.json); headers["Content-Type"] = "application/json"; }
        if (bodyStr !== undefined) headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
        const r = http.request({ method, host: "127.0.0.1", port, path: urlPath, headers }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json: any = null;
            try { json = JSON.parse(text); } catch { /* html */ }
            const sc = resp.headers["set-cookie"];
            resolve({ status: resp.statusCode || 0, text, json, location: resp.headers["location"] as string | undefined, setCookie: Array.isArray(sc) ? sc : sc ? [String(sc)] : [] });
          });
        });
        r.on("error", reject);
        if (bodyStr) r.write(bodyStr);
        r.end();
      });
    }
    const ck = (cookie: string) => ({ headers: { Cookie: cookie } });
    function sessionCookieFrom(r: Resp): string | null {
      for (const c of r.setCookie) {
        const m = /^rfb_owner_session=([^;]+)/.exec(c);
        if (m && m[1]) return `rfb_owner_session=${m[1]}`;
      }
      return null;
    }

    /** Every owner endpoint, as [label, method, path, body]. */
    function ownerEndpoints(id: string): Array<[string, string, string, { json?: unknown; form?: Record<string, string> }]> {
      return [
        ["GET profile", "GET", `/api/agents/${id}/profile`, {}],
        ["POST update-profile", "POST", `/api/agents/${id}/update-profile`, { json: { phone: "+47 999 99 999" } }],
        ["POST order-notifications (json)", "POST", `/api/agents/${id}/order-notifications`, { json: { opt_in: false } }],
        ["GET my-audit", "GET", `/api/agents/${id}/my-audit`, {}],
        ["GET owner-stats", "GET", `/api/agents/${id}/owner-stats`, {}],
        ["GET orders", "GET", `/api/agents/${id}/orders`, {}],
        ["GET translations", "GET", `/api/agents/${id}/translations?lang=en`, {}],
        ["POST translations", "POST", `/api/agents/${id}/translations`, { json: { lang: "en", field: "about", text: "Hi" } }],
        ["DELETE translations", "DELETE", `/api/agents/${id}/translations?lang=en&field=about`, {}],
        ["GET /eier portal", "GET", `/eier/${id}/portal`, {}],
        ["POST /eier save", "POST", `/eier/${id}/save`, { form: { field_phone: "+47 999 99 999" } }],
        ["POST /eier order-notifications", "POST", `/eier/${id}/order-notifications`, { form: { opt_in: "0" } }],
        ["GET /eier ordrer", "GET", `/eier/${id}/ordrer`, {}],
        ["POST /eier ordrer action", "POST", `/eier/${id}/ordrer/no-such-order`, { form: { action: "confirm" } }],
        ["POST /eier betaling/start", "POST", `/eier/${id}/betaling/start`, { form: {} }],
        ["POST /eier betaling/erklaering", "POST", `/eier/${id}/betaling/erklaering`, { form: {} }],
        ["GET /eier betaling/retur", "GET", `/eier/${id}/betaling/retur`, {}],
        ["GET /eier betaling/fornye", "GET", `/eier/${id}/betaling/fornye`, {}],
      ];
    }

    // ════════════════════════════════════════════════════════════════════════
    // gate: off = today's behaviour
    // ════════════════════════════════════════════════════════════════════════
    {
      const p = await req("GET", "/api/agents/ag-none/profile", ck(C_NONE));
      assertEq(p.status, 200, "gate-01: flag off → e-mail-match session still reads its profile (behaviour unchanged)");
      const portal = await req("GET", "/eier/ag-none/portal", ck(C_NONE));
      assertEq(portal.status, 200, "gate-02: flag off → e-mail-match session still opens /eier portal");
      const own = await ownerPortalIsVerified("ag-none");
      assertEq(own, false, "gate-03: isVerifiedOwner is false for the e-mail-match session (predicate is flag-independent)");
    }
    async function ownerPortalIsVerified(id: string): Promise<boolean> {
      const op = require("./owner-portal") as typeof import("./owner-portal");
      return op.isVerifiedOwner(id, { valid: true, agentId: id });
    }

    // ════════════════════════════════════════════════════════════════════════
    // gate: on → 403 on every owner endpoint for the e-mail-match session
    // ════════════════════════════════════════════════════════════════════════
    process.env.OWNER_VERIFIED_OWNER_GATE_ENABLED = "1";
    {
      for (const [label, method, p, body] of ownerEndpoints("ag-none")) {
        const r = await req(method, p, { headers: { Cookie: C_NONE }, ...body });
        assertEq(r.status, 403, `gate-10: e-mail match without verified ownership → 403 on ${label}`);
      }
      // Same with the token as Bearer instead of cookie.
      const b = await req("GET", "/api/agents/ag-none/owner-stats", { headers: { Authorization: "Bearer tok-none" } });
      assertEq([b.status, b.json?.error], [403, "ownership_not_verified"], "gate-11: Bearer e-mail-match session → 403 ownership_not_verified");
      const portal = await req("GET", "/eier/ag-none/portal", ck(C_NONE));
      assertTrue(portal.text.includes("Eierskapet er ikke bekreftet") && portal.text.includes("/selger?agent=ag-none"), "gate-12: 403 portal page explains and links to the ownership claim");
      const phone = (db.prepare("SELECT phone FROM agent_knowledge WHERE agent_id = 'ag-none'").get() as any).phone;
      assertEq(phone, "+47 400 00 000", "gate-13: the 403 writes did not change the profile");
      const noSess = await req("GET", "/api/agents/ag-none/profile");
      assertEq(noSess.status, 401, "gate-14: no session stays 401 (not 403)");

      // Verified owners pass: is_verified owner, self-registered, legacy claimed_at.
      for (const [cookie, id, who] of [[C_OWN, "ag-own", "verified owner"], [C_SELF, "ag-self", "self-registered owner (is_verified=0)"], [C_LEGACY, "ag-legacy", "claimed_at owner"]] as const) {
        for (const p of [`/api/agents/${id}/profile`, `/api/agents/${id}/owner-stats`, `/api/agents/${id}/orders`, `/eier/${id}/portal`, `/eier/${id}/ordrer`]) {
          const r = await req("GET", p, ck(cookie));
          assertEq(r.status, 200, `gate-20: ${who} → 200 on GET ${p}`);
        }
      }
      // Self-registered: the strict is_verified gate for orders is unchanged.
      const on = await req("POST", "/api/agents/ag-self/order-notifications", { headers: { Cookie: C_SELF }, json: { opt_in: true } });
      assertEq([on.status, on.json?.error], [409, "ownership_not_verified"], "gate-21: self-registered owner still cannot switch orders on (is_verified gate unchanged)");
      // Another producer's session → 403 forbidden (not ownership_not_verified).
      const cross = await req("GET", "/api/agents/ag-own/profile", ck(C_SELF));
      assertEq([cross.status, cross.json?.error], [403, "forbidden"], "gate-22: session for another agent → 403 forbidden");
      for (const [label, method, p, body] of ownerEndpoints("ag-own")) {
        if (method === "GET" && (p.includes("/portal") || p.includes("/ordrer"))) continue; // HTML pages checked above
        const r = await req(method, p, { headers: { Cookie: C_SELF }, ...body });
        assertTrue(r.status === 403 || (r.status === 303 && String(r.location).startsWith("/eier/ag-own")), `gate-23: cross-agent session blocked on ${label} (got ${r.status})`);
      }
    }
    delete process.env.OWNER_VERIFIED_OWNER_GATE_ENABLED;

    // ════════════════════════════════════════════════════════════════════════
    // one: one login → profile, products, statistics, orders
    // ════════════════════════════════════════════════════════════════════════
    {
      const ks = (require("../services/knowledge-service") as typeof import("../services/knowledge-service")).knowledgeService;

      // Flag off: the /selger login opens no /eier session (today).
      const l0 = ks.createMagicLink("owner@own.no");
      const v0 = await req("GET", `/api/marketplace/auth/magic-verify?token=${l0.token}`);
      assertEq(v0.status, 200, "one-01: /selger login works with the flag off");
      assertEq(sessionCookieFrom(v0), null, "one-02: flag off → no rfb_owner_session cookie");
      const bridgeOff = await req("POST", "/eier/ag-own/selger", ck(C_OWN));
      assertEq(bridgeOff.status, 404, "one-03: flag off → POST /eier/:id/selger is 404");
      const portalOff = await req("GET", "/eier/ag-own/portal", ck(C_OWN));
      assertTrue(!portalOff.text.includes("/eier/ag-own/selger"), "one-04: flag off → portal has no «Produkter og åpningstider» button");

      process.env.OWNER_UNIFIED_SESSION_ENABLED = "1";
      process.env.OWNER_VERIFIED_OWNER_GATE_ENABLED = "1";
      const l1 = ks.createMagicLink("owner@own.no");
      const v1 = await req("GET", `/api/marketplace/auth/magic-verify?token=${l1.token}`);
      assertEq(v1.status, 200, "one-10: /selger login succeeds");
      const claimToken = v1.json?.data?.claimToken as string;
      const cookie = sessionCookieFrom(v1);
      assertTrue(!!cookie, "one-11: flag on → the /selger login also sets rfb_owner_session");
      assertTrue(v1.setCookie.some((c) => /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c)), "one-12: the session cookie is HttpOnly + SameSite=Lax");
      const row = db.prepare("SELECT used, agent_id, email, expires_at FROM magic_links WHERE token = ?").get(String(cookie).split("=")[1]) as any;
      assertEq([row?.used, row?.agent_id, row?.email], [1, "ag-own", "owner@own.no"], "one-13: session row: used=1, this agent, the claimant e-mail");
      assertTrue(/^\d{4}-\d\d-\d\dT.*Z$/.test(String(row?.expires_at)), "one-14: session expires_at is stored as ISO");
      const c = String(cookie);
      // Profile, products, statistics, orders — no second login.
      assertEq((await req("GET", "/api/agents/ag-own/profile", ck(c))).status, 200, "one-20: same login → profile (API)");
      assertEq((await req("GET", "/eier/ag-own/portal", ck(c))).status, 200, "one-21: same login → /eier portal");
      const kn = await req("GET", "/api/marketplace/agents/ag-own/knowledge", { headers: { "X-Claim-Token": claimToken } });
      assertEq(kn.status, 200, "one-22: same login → products/knowledge (/selger claim token)");
      assertEq((await req("GET", "/api/agents/ag-own/owner-stats", ck(c))).status, 200, "one-23: same login → statistics");
      assertEq((await req("GET", "/api/agents/ag-own/orders", ck(c))).status, 200, "one-24: same login → orders (API)");
      assertEq((await req("GET", "/eier/ag-own/ordrer", ck(c))).status, 200, "one-25: same login → Mine ordrer");

      // Reverse direction: /eier session → /selger without a new e-mail.
      const portal = await req("GET", "/eier/ag-own/portal", ck(C_OWN));
      assertTrue(portal.text.includes(`action="/eier/ag-own/selger"`) && portal.text.includes("Produkter og åpningstider"), "one-30: portal shows «Produkter og åpningstider» button");
      const before = (db.prepare("SELECT COUNT(*) AS n FROM magic_links").get() as any).n;
      const br = await req("POST", "/eier/ag-own/selger", ck(C_OWN));
      assertTrue(br.status === 303 && String(br.location).startsWith("/selger?magic="), "one-31: bridge → 303 to /selger?magic=");
      const bt = decodeURIComponent(String(br.location).split("magic=")[1] || "");
      const brow = db.prepare("SELECT used, email, expires_at FROM magic_links WHERE token = ?").get(bt) as any;
      assertTrue(!!brow && brow.used === 0 && Date.parse(brow.expires_at) - Date.now() <= 15 * 60_000 + 5000, "one-32: bridge token is a one-time, ≤15-minute /selger link");
      const v2 = await req("GET", `/api/marketplace/auth/magic-verify?token=${bt}`, ck(C_OWN));
      assertEq(v2.status, 200, "one-33: /selger auto-login with the bridge token succeeds");
      const kn2 = await req("GET", "/api/marketplace/agents/ag-own/knowledge", { headers: { "X-Claim-Token": String(v2.json?.data?.claimToken) } });
      assertEq(kn2.status, 200, "one-34: bridged claim token reaches products");
      assertEq(sessionCookieFrom(v2), null, "one-35: an existing live session is reused (no second session cookie)");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM magic_links").get() as any).n, before + 1, "one-36: bridge+login adds exactly one row (the bridge link)");
      const v3 = await req("GET", `/api/marketplace/auth/magic-verify?token=${bt}`);
      assertEq(v3.status, 401, "one-37: bridge token cannot be reused");
      // Bridge refuses: e-mail-match session, cross-site, session e-mail ≠ claimant.
      const brNone = await req("POST", "/eier/ag-none/selger", ck(C_NONE));
      assertEq(brNone.status, 403, "one-40: bridge → 403 for e-mail-match session without verified ownership");
      const brX = await req("POST", "/eier/ag-own/selger", { headers: { Cookie: C_OWN, Origin: "https://evil.example" } });
      assertEq(brX.status, 403, "one-41: bridge → 403 cross-site");
      const C_OTHER_MAIL = session("ag-own", "post@own.no", "tok-own-other-mail");
      const brM = await req("POST", "/eier/ag-own/selger", ck(C_OTHER_MAIL));
      assertTrue(brM.status === 303 && brM.location === "/selger?agent=ag-own", "one-42: session e-mail ≠ claimant → no claim token, plain /selger login");
      const brXa = await req("POST", "/eier/ag-own/selger", ck(C_SELF));
      assertTrue(brXa.status === 303 && brXa.location === "/eier/ag-own", "one-43: another agent's session → login redirect, no token");

      // Session rows do not eat the e-mail rate limit (3 per hour).
      for (let i = 0; i < 3; i++) await req("GET", `/api/marketplace/auth/magic-verify?token=${ks.createMagicLink("self@self.no").token}`);
      // ↑ the selger links themselves count (they are e-mails); reset them:
      db.prepare("DELETE FROM magic_links WHERE agent_id = 'ag-self' AND id NOT LIKE 'mlsess_%' AND token != 'tok-self'").run();
      const sess = db.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE agent_id = 'ag-self' AND id LIKE 'mlsess_%'").get() as any;
      assertEq(sess.n, 3, "one-50: three /selger logins opened three session rows");
      const rl = await req("POST", "/api/agents/ag-self/request-magic-link", { json: { email: "self@self.no" } });
      assertEq(rl.status, 200, "one-51: session rows are not counted by the request-magic-link rate limit");
      delete process.env.OWNER_UNIFIED_SESSION_ENABLED;
      delete process.env.OWNER_VERIFIED_OWNER_GATE_ENABLED;
    }

    // ════════════════════════════════════════════════════════════════════════
    // out: logout revokes the token (unflagged)
    // ════════════════════════════════════════════════════════════════════════
    {
      const C = session("ag-own", "owner@own.no", "tok-logout");
      assertEq((await req("GET", "/api/agents/ag-own/profile", ck(C))).status, 200, "out-01: session works before logout");
      const lo = await req("POST", "/eier/ag-own/logout", ck(C));
      assertEq(lo.status, 303, "out-02: logout redirects");
      assertTrue(lo.setCookie.some((c) => /^rfb_owner_session=;/.test(c)), "out-03: logout clears the cookie");
      assertEq((await req("GET", "/api/agents/ag-own/profile", ck(C))).status, 401, "out-04: the old cookie value is unusable after logout");
      assertEq((await req("GET", "/api/agents/ag-own/owner-stats", { headers: { Authorization: "Bearer tok-logout" } })).status, 401, "out-05: the token as Bearer is unusable after logout");
      assertEq((await req("GET", "/eier/ag-own/ordrer", ck(C))).status, 302, "out-06: Mine ordrer → login after logout");
      const relink = await req("GET", "/magic-link-verify?token=tok-logout");
      assertEq(relink.location, "/?error=invalid_token", "out-07: the e-mailed link cannot re-open the revoked session");
      const Cb = session("ag-own", "owner@own.no", "tok-logout-bearer");
      await req("POST", "/eier/ag-own/logout", { headers: { Authorization: "Bearer tok-logout-bearer" } });
      assertEq((await req("GET", "/api/agents/ag-own/profile", ck(Cb))).status, 401, "out-08: Bearer logout revokes the token too");
      assertEq((await req("GET", "/api/agents/ag-own/profile", ck(C_OWN))).status, 200, "out-09: logout revokes only the presented token");
      const html = fs.readFileSync(path.join(__dirname, "..", "public", "selger.html"), "utf8");
      assertTrue(/btnLogout[\s\S]{0,600}\/eier\/' \+ encodeURIComponent\(state\.agentId\) \+ '\/logout'/.test(html), "out-10: /selger «Logg ut» also revokes the owner session");
    }

    // ════════════════════════════════════════════════════════════════════════
    // exp: expires_at stored as ISO
    // ════════════════════════════════════════════════════════════════════════
    {
      const Cexp = session("ag-own", "owner@own.no", "tok-expired", iso(-60_000));
      assertEq((await req("GET", "/api/agents/ag-own/profile", ck(Cexp))).status, 401, "exp-01: ISO expires_at one minute ago → rejected (cookie)");
      assertEq((await req("GET", "/api/agents/ag-own/profile", { headers: { Authorization: "Bearer tok-expired" } })).status, 401, "exp-02: … and as Bearer");
      const v = await req("GET", "/magic-link-verify?token=tok-expired");
      assertEq(v.location, "/?error=invalid_token", "exp-03: expired ISO magic link → invalid_token");
      const Cok = session("ag-own", "owner@own.no", "tok-valid", iso(60_000));
      assertEq((await req("GET", "/api/agents/ag-own/profile", ck(Cok))).status, 200, "exp-04: ISO expires_at one minute ahead → accepted");
      const v2 = await req("GET", "/magic-link-verify?token=tok-valid");
      assertEq(v2.location, "/eier/ag-own/portal", "exp-05: valid ISO magic link → portal");
      // Legacy SQLite-format rows keep working.
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, expires_at) VALUES ('ml-native', 'owner@own.no', 'tok-native', 'ag-own', 1, datetime('now', '+1 hour'))").run();
      assertEq((await req("GET", "/api/agents/ag-own/profile", ck("rfb_owner_session=tok-native"))).status, 200, "exp-06: native-format expires_at still accepted");
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, expires_at) VALUES ('ml-native-old', 'owner@own.no', 'tok-native-old', 'ag-own', 1, datetime('now', '-1 minute'))").run();
      assertEq((await req("GET", "/api/agents/ag-own/profile", ck("rfb_owner_session=tok-native-old"))).status, 401, "exp-07: native-format expired → rejected");
    }
  } catch (err) {
    failed++;
    failures.push(`owner-unified-session-s1b5: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    es.sendOwnerMagicLink = prevSendOwner;
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* best-effort */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── owner-unified-session-s1b5 tests ──");
  runOwnerUnifiedSessionS1b5Tests({ log: true }).then((r) => {
    console.log(`\nowner-unified-session-s1b5: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) { console.log(r.failures.join("\n")); process.exit(1); }
    process.exit(0);
  });
}
