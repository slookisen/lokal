/**
 * rfb-owner-access-revocation.test.ts — dev-request 2026-11-06-rfb-krav-for-
 * portal-og-okter-ved-eierskifte, spec point 2 / acceptance criterion 2:
 * «etter eierskifte, unclaim og reset-claim gir gammel økt og gammel lenke
 * ingen tilgang; ny eier logger inn.»
 *
 *   (unclaim)  POST /api/marketplace/agents/:id/unclaim: the old owner's
 *              /eier session (cookie and Bearer) fails verifyOwnerSession,
 *              an old unused login link no longer logs in; a remaining
 *              verified co-owner keeps their session.
 *   (reset)    POST /api/marketplace/admin/agents/:id/reset-claim: every
 *              session and open link for the profile is dead; a refused
 *              (403) reset revokes nothing.
 *   (shift)    eierskifte by admin approval (approveClaimReview) on a profile
 *              owned by activation link: the old owner's session and link are
 *              dead; the new owner gets a fresh link by request-magic-link,
 *              it logs in and the session verifies.
 *   (code)     the code path (verifyClaim): a stray session for an address
 *              that is not the new owner is revoked; the new owner's own
 *              existing session is kept.
 *   (coowner)  admin approval while another verified owner stays: that
 *              owner's session is kept (they are still an owner).
 *   (other)    rows of other agents are never touched.
 *   (atomic)   revocation failing makes reset-claim answer 500 and roll back:
 *              the claims are still there.
 *
 * Fresh in-memory SQLite with the real schema and an in-process server with
 * the real marketplace and owner-portal routers. getDb(), env and the e-mail
 * stub are restored in finally.
 *
 * Exported runRfbOwnerAccessRevocationTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/rfb-owner-access-revocation.test.ts
 */

import Database from "better-sqlite3";
import * as http from "http";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runRfbOwnerAccessRevocationTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const initMod = require("../database/init") as typeof import("../database/init");
  const emailMod = require("../services/email-service") as typeof import("../services/email-service");
  const prevDb = initMod.__peekDbForTesting();
  const ENV_KEYS = ["ADMIN_KEY", "OWNER_VERIFIED_OWNER_GATE_ENABLED", "OWNER_UNIFIED_SESSION_ENABLED"];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const es = emailMod.emailService as any;
  const prevSendOwner = es.sendOwnerMagicLink;
  const sentLinks: Array<{ to: string; verifyUrl: string }> = [];
  const db = new Database(":memory:");
  const ADMIN = "rfb-owner-access-revocation-key";
  let server: http.Server | null = null;

  try {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ADMIN_KEY = ADMIN;
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* already loaded */ }
    es.sendOwnerMagicLink = async (o: { to: string; verifyUrl: string }) => { sentLinks.push({ to: o.to, verifyUrl: o.verifyUrl }); return { success: true, messageId: "stub" }; };

    const ownerPortal = require("./owner-portal") as typeof import("./owner-portal");
    const { knowledgeService } = require("../services/knowledge-service") as typeof import("../services/knowledge-service");
    {
      const express = require("express");
      const marketplace = require("./marketplace") as typeof import("./marketplace");
      const app = express();
      app.use(express.json());
      app.use("/api/marketplace", marketplace.default);
      app.use("/", ownerPortal.default);
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    }
    const port = (server!.address() as any).port as number;
    type Resp = { status: number; json: any; location: string | undefined; setCookie: string[] };
    function req(method: string, urlPath: string, o: { headers?: Record<string, string>; json?: unknown } = {}): Promise<Resp> {
      return new Promise((resolve, reject) => {
        const headers: Record<string, string> = { ...(o.headers || {}) };
        let bodyStr: string | undefined;
        if (o.json !== undefined) {
          bodyStr = JSON.stringify(o.json);
          headers["Content-Type"] = "application/json";
          headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
        }
        const r = http.request({ method, host: "127.0.0.1", port, path: urlPath, headers }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json: any = null;
            try { json = JSON.parse(text); } catch { /* not json */ }
            const sc = resp.headers["set-cookie"];
            resolve({ status: resp.statusCode || 0, json, location: resp.headers.location as string | undefined, setCookie: Array.isArray(sc) ? sc : sc ? [sc] : [] });
          });
        });
        r.on("error", reject);
        if (bodyStr !== undefined) r.write(bodyStr);
        r.end();
      });
    }

    // ── fixtures ────────────────────────────────────────────────────────
    function agent(id: string, email: string, o: { isVerified?: number; claimedAt?: string | null; claimedVia?: string | null } = {}): void {
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories, is_verified, claimed_at, claimed_via)
                  VALUES (?, ?, 'Testprodusent', 'test', ?, 'https://example.test', 'producer', ?, '["vegetables"]', ?, ?, ?)`)
        .run(id, `Gård ${id}`, email, `k-${id}`, o.isVerified ?? 0, o.claimedAt ?? null, o.claimedVia ?? null);
      db.prepare("INSERT INTO agent_knowledge (agent_id, email, data_source) VALUES (?, ?, 'auto')").run(id, email);
    }
    function verifiedClaim(id: string, agentId: string, email: string, token: string): void {
      db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, claim_token, claim_token_expires_at, verified_at)
                  VALUES (?, ?, 'Eier', ?, 'verified', ?, ?, datetime('now'))`)
        .run(id, agentId, email, token, new Date(Date.now() + 30 * 86_400_000).toISOString());
    }
    const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
    /** A 7-day /eier session row (used = 1), like openOwnerSession writes. */
    function session(agentId: string, email: string, token: string): string {
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, used_at, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)")
        .run(`mlsess_${token}`, email, token, agentId, iso(0), iso(0), iso(7 * 86_400_000));
      return token;
    }
    /** An open e-mailed login link (used = 0), like createOwnerLoginLink writes. */
    function link(agentId: string, email: string, token: string): string {
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?)")
        .run(`ml_${token}`, email, token, agentId, iso(0), iso(7 * 86_400_000));
      return token;
    }
    /** Both ways a session token is presented: cookie and Bearer. */
    const sessionValid = (token: string): [boolean, boolean] => [
      ownerPortal.verifyOwnerSession({ headers: { cookie: `rfb_owner_session=${token}` } } as any).valid,
      ownerPortal.verifyOwnerSession({ headers: { authorization: `Bearer ${token}` } } as any).valid,
    ];
    /** Opens /magic-link-verify; "portal" when it logged in, else "refused". */
    async function useLink(token: string): Promise<string> {
      const r = await req("GET", `/magic-link-verify?token=${encodeURIComponent(token)}`);
      return r.status === 302 && /^\/eier\/[^/]+\/portal$/.test(r.location || "") ? "portal" : "refused";
    }
    const live = (token: string): boolean =>
      !!db.prepare("SELECT 1 FROM magic_links WHERE token = ? AND datetime(expires_at) > datetime('now')").get(token);
    const rowCount = (token: string): number =>
      (db.prepare("SELECT COUNT(*) AS c FROM magic_links WHERE token = ?").get(token) as { c: number }).c;

    // Another agent whose rows must never be touched by anything below.
    agent("ag-other", "eier@other.example.test", { isVerified: 1 });
    verifiedClaim("cl-other", "ag-other", "eier@other.example.test", "claim_other");
    session("ag-other", "eier@other.example.test", "tok-other-sess");
    link("ag-other", "eier@other.example.test", "tok-other-link");
    const otherIntact = (label: string) =>
      eq([sessionValid("tok-other-sess"), live("tok-other-link")], [[true, true], true], `other: ${label} leaves another agent's session and link live`);

    // ══ (unclaim) ════════════════════════════════════════════════════════
    {
      agent("ag-u", "eier@u.example.test", { isVerified: 1 });
      verifiedClaim("cl-u", "ag-u", "eier@u.example.test", "claim_u");
      session("ag-u", "eier@u.example.test", "tok-u-sess");
      session("ag-u", "INFO@U.example.test ", "tok-u-sess2");
      link("ag-u", "eier@u.example.test", "tok-u-link");
      eq(sessionValid("tok-u-sess"), [true, true], "unclaim: the owner's session is valid before");

      const r = await req("POST", "/api/marketplace/agents/ag-u/unclaim", { headers: { "x-claim-token": "claim_u" } });
      eq([r.status, r.json?.success], [200, true], "unclaim: 200");
      eq(sessionValid("tok-u-sess"), [false, false], "unclaim: the old session fails verifyOwnerSession (cookie and Bearer)");
      eq(sessionValid("tok-u-sess2"), [false, false], "unclaim: any other session for the profile is dead too");
      eq(await useLink("tok-u-link"), "refused", "unclaim: the old unused login link no longer logs in");
      eq(rowCount("tok-u-sess"), 1, "unclaim: rows are expired, not deleted");
      otherIntact("unclaim");
    }

    // ══ (unclaim) with a verified co-owner remaining ═════════════════════
    {
      agent("ag-u2", "a@u2.example.test", { isVerified: 1 });
      verifiedClaim("cl-u2a", "ag-u2", "a@u2.example.test", "claim_u2a");
      verifiedClaim("cl-u2b", "ag-u2", "b@u2.example.test", "claim_u2b");
      session("ag-u2", "a@u2.example.test", "tok-u2-a");
      session("ag-u2", "b@u2.example.test", "tok-u2-b");
      const r = await req("POST", "/api/marketplace/agents/ag-u2/unclaim", { headers: { "x-claim-token": "claim_u2a" } });
      eq(r.status, 200, "unclaim/co-owner: 200");
      eq(sessionValid("tok-u2-a"), [false, false], "unclaim/co-owner: the leaving owner's session is dead");
      eq(sessionValid("tok-u2-b"), [true, true], "unclaim/co-owner: the remaining verified owner keeps theirs");
    }

    // ══ (reset) ══════════════════════════════════════════════════════════
    {
      agent("ag-r", "eier@r.example.test", { isVerified: 1, claimedAt: iso(-86_400_000), claimedVia: "claim" });
      verifiedClaim("cl-r", "ag-r", "eier@r.example.test", "claim_r");
      session("ag-r", "eier@r.example.test", "tok-r-sess");
      session("ag-r", "ordre@r.example.test", "tok-r-act");
      link("ag-r", "eier@r.example.test", "tok-r-link");

      const refused = await req("POST", "/api/marketplace/admin/agents/ag-r/reset-claim", { headers: { "x-admin-key": "wrong" } });
      eq([refused.status, sessionValid("tok-r-sess"), live("tok-r-link")], [403, [true, true], true], "reset: a refused reset (403) revokes nothing");

      const r = await req("POST", "/api/marketplace/admin/agents/ag-r/reset-claim", { headers: { "x-admin-key": ADMIN } });
      eq([r.status, r.json?.success], [200, true], "reset: 200");
      eq([sessionValid("tok-r-sess"), sessionValid("tok-r-act")], [[false, false], [false, false]], "reset: every session for the profile fails verifyOwnerSession");
      eq(await useLink("tok-r-link"), "refused", "reset: the old unused login link no longer logs in");
      otherIntact("reset-claim");
    }

    // ══ (shift) eierskifte by admin approval ═════════════════════════════
    {
      // Owned by activation link (no claim row); the old owner has a session
      // and an open link. Daniel approves a queued claim for a new address.
      agent("ag-e", "gammel@e.example.test", { isVerified: 1, claimedAt: iso(-86_400_000), claimedVia: "activation_link" });
      session("ag-e", "gammel@e.example.test", "tok-e-old");
      link("ag-e", "gammel@e.example.test", "tok-e-oldlink");
      db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, review_reason)
                  VALUES ('cl-e', 'ag-e', 'Ny eier', 'ny@e.example.test', 'pending_review', 'has_owner')`).run();

      const ap = knowledgeService.approveClaimReview("cl-e", "Ny@E.example.test");
      eq(ap.ok && [ap.agentId, ap.email], ["ag-e", "ny@e.example.test"], "shift: the claim is approved for the new address");
      eq(sessionValid("tok-e-old"), [false, false], "shift: the old owner's session fails verifyOwnerSession");
      eq(await useLink("tok-e-oldlink"), "refused", "shift: the old owner's unused link no longer logs in");

      // New owner logs in: request a link for the confirmed address, open it.
      sentLinks.length = 0;
      const rq = await req("POST", "/api/agents/ag-e/request-magic-link", { json: { email: "ny@e.example.test" } });
      eq([rq.status, sentLinks.length, sentLinks[0]?.to], [200, 1, "ny@e.example.test"], "shift: the new owner gets a fresh login link");
      const newToken = new URL(sentLinks[0]!.verifyUrl).searchParams.get("token") || "";
      const v = await req("GET", `/magic-link-verify?token=${encodeURIComponent(newToken)}`);
      eq([v.status, v.location], [302, "/eier/ag-e/portal"], "shift: the new owner's link logs in to the portal");
      const cookie = v.setCookie.find((c) => c.startsWith("rfb_owner_session="))?.split(";")[0]?.slice("rfb_owner_session=".length) || "";
      eq(sessionValid(decodeURIComponent(cookie)), [true, true], "shift: the new owner's session verifies");
      otherIntact("eierskifte");
    }

    // ══ (code) first owner by claim code; a stray address loses its session ══
    {
      agent("ag-c", "post@c.example.test");
      session("ag-c", "post@c.example.test", "tok-c-owner");
      session("ag-c", "tidligere@c.example.test", "tok-c-stray");
      db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, verification_code, status, expires_at, code_sent_to)
                  VALUES ('cl-c', 'ag-c', 'Eier', 'typed@c.example.test', '123456', 'code_sent', ?, 'post@c.example.test')`).run(iso(3_600_000));
      const v = knowledgeService.verifyClaim("cl-c", "123456", "ag-c");
      eq(v.success, true, "code: verifyClaim grants ownership");
      eq(sessionValid("tok-c-stray"), [false, false], "code: a session for an address that is not the owner is revoked");
      eq(sessionValid("tok-c-owner"), [true, true], "code: the new owner's own session is kept");
    }

    // ══ (coowner) admin approval while the old verified owner stays ══════
    {
      agent("ag-k", "a@k.example.test", { isVerified: 1, claimedAt: iso(-86_400_000), claimedVia: "claim" });
      verifiedClaim("cl-ka", "ag-k", "a@k.example.test", "claim_ka");
      session("ag-k", "a@k.example.test", "tok-k-a");
      db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, review_reason)
                  VALUES ('cl-kb', 'ag-k', 'B', 'b@k.example.test', 'pending_review', 'has_owner')`).run();
      const ap = knowledgeService.approveClaimReview("cl-kb");
      eq(ap.ok, true, "coowner: approval succeeds");
      eq(sessionValid("tok-k-a"), [true, true], "coowner: a verified owner who stays keeps their session");
    }

    // ══ (atomic) a revocation failure rolls reset-claim back ═════════════
    {
      agent("ag-z", "eier@z.example.test", { isVerified: 1 });
      verifiedClaim("cl-z", "ag-z", "eier@z.example.test", "claim_z");
      db.exec("DROP TABLE magic_links");
      const r = await req("POST", "/api/marketplace/admin/agents/ag-z/reset-claim", { headers: { "x-admin-key": ADMIN } });
      const kept = db.prepare("SELECT status FROM agent_claims WHERE id = 'cl-z'").get() as { status: string } | undefined;
      const verified = (db.prepare("SELECT is_verified FROM agents WHERE id = 'ag-z'").get() as { is_verified: number }).is_verified;
      eq([r.status, kept?.status, verified], [500, "verified", 1], "atomic: revocation failing → 500 and the reset is rolled back");
    }
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${err?.stack || err}`);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    es.sendOwnerMagicLink = prevSendOwner;
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    try { db.close(); } catch { /* closed */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbOwnerAccessRevocationTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) { for (const f of r.failures) console.log(f); process.exit(1); }
  });
}
