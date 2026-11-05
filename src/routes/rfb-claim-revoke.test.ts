/**
 * rfb-claim-revoke.test.ts — dev-request 2026-10-30-rfb-eierkrav-automatisk-
 * vurdering-og-ettklikk, slice C1 (acceptance criterion 4: «claim-revoke
 * setter profilen tilbake slik den var før godkjenningen»).
 *
 *   (snap)    grantClaimOwnership stores the pre-grant profile on the claim
 *             (pre_grant_state) — code path and admin approval.
 *   (claim)   code path → revoke: is_verified, claimed_at, claimed_via and
 *             data_source are exactly as before the grant (discovery and
 *             self_registered rows); the claim token no longer resolves; the
 *             customer rule no longer counts the agent.
 *   (admin)   admin approval → revoke, also for a row already is_verified=1
 *             with an earlier claimed_at stamp, and one with no knowledge row.
 *   (owner)   another verified claim remains → owner stamps kept, the agent
 *             stays a customer; revoking that one too restores the original.
 *   (edit)    data_source changed by the owner after the grant is kept.
 *   (legacy)  a claim with no snapshot: claimed_at/claimed_via cleared only
 *             for a grant's claimed_via, is_verified left; "partial_no_snapshot".
 *   (login)   unexpired magic_links rows for this agent + the claim's address
 *             are expired; other addresses / agents are left; a shared
 *             address with a remaining verified claim keeps its rows.
 *   (reverify) a revoked claim's old code is refused (status 'revoked'),
 *             never overwritten by 'expired', and no resend path revives it.
 *   (order)   two owners revoked in grant order end at the original profile
 *             (the later grant carries the first owner's baseline); with a
 *             pre-C1 owner the baseline is unknown → partial_no_snapshot.
 *   (trust)   the route recalculates agents.trust_score.
 *   (route)   POST /admin/agents/claim-revoke: 403 without / with a wrong
 *             X-Admin-Key, 400 on a bad body, 404 unknown, 409 pending, 409 on
 *             a second revoke, 200 shape.
 *   (mig)     an 11=A-shaped agent_claims table is rebuilt with 'revoked' in
 *             the status CHECK, rows unchanged, foreign_keys restored (OFF and
 *             ON); a second boot does not rebuild.
 *
 * Fresh in-memory SQLite with the real schema and an in-process server with
 * the real admin-agents router. getDb() singleton, ADMIN_KEY and the require
 * cache are restored in finally.
 *
 * Exported runRfbClaimRevokeTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/rfb-claim-revoke.test.ts
 */

import Database from "better-sqlite3";
import * as http from "http";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runRfbClaimRevokeTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");

  const savedAdminKey = process.env.ADMIN_KEY;
  const ADMIN = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "rfb-claim-revoke-standalone-key";
  let server: http.Server | null = null;

  try {
    process.env.ADMIN_KEY = ADMIN;
    initMod.__setDbForTesting(db);
    initMod.__initSchemaForTesting(db);
    try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* already loaded */ }

    delete require.cache[require.resolve("./admin-agents")];
    const adminAgentsRouter = require("./admin-agents").default as any;
    const { knowledgeService } = require("../services/knowledge-service") as typeof import("../services/knowledge-service");
    const { customerRuleSql } = require("../services/customer-rule") as typeof import("../services/customer-rule");
    {
      const express = require("express");
      const app = express();
      app.use(express.json());
      app.use("/admin/agents", adminAgentsRouter);
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    }
    const port = (server!.address() as any).port as number;
    function post(urlPath: string, body: unknown, headers: Record<string, string> = { "X-Admin-Key": ADMIN }): Promise<{ status: number; json: any }> {
      return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(body);
        const h = { ...headers, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(bodyStr)) };
        const r = http.request({ method: "POST", host: "127.0.0.1", port, path: urlPath, headers: h }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json: any = null;
            try { json = JSON.parse(text); } catch { /* not json */ }
            resolve({ status: resp.statusCode || 0, json });
          });
        });
        r.on("error", reject);
        r.write(bodyStr);
        r.end();
      });
    }
    const revoke = (body: unknown, headers?: Record<string, string>) => post("/admin/agents/claim-revoke", body, headers);

    // ── fixtures ────────────────────────────────────────────────────────
    function agent(id: string, o: { origin?: string; isVerified?: number; claimedAt?: string | null; claimedVia?: string | null; dataSource?: string | null } = {}): void {
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories, is_verified, claimed_at, claimed_via, origin)
                  VALUES (?, ?, 'Testprodusent', 'test', ?, 'https://example.test', 'producer', ?, '["vegetables"]', ?, ?, ?, ?)`)
        .run(id, `Gård ${id}`, `registrert@${id}.example.test`, `k-${id}`, o.isVerified ?? 0, o.claimedAt ?? null, o.claimedVia ?? null, o.origin ?? "discovery");
      if (o.dataSource !== null) {
        db.prepare("INSERT INTO agent_knowledge (agent_id, email, data_source) VALUES (?, ?, ?)").run(id, `post@${id}.example.test`, o.dataSource ?? "auto");
      }
    }
    let seq = 0;
    function codeClaim(agentId: string, code = "123456"): string {
      const id = `rv-claim-${++seq}`;
      db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, verification_code, status, expires_at, code_sent_to)
                  VALUES (?, ?, 'Eier', ?, ?, 'code_sent', ?, ?)`)
        .run(id, agentId, `typed@${agentId}.example.test`, code, new Date(Date.now() + 3_600_000).toISOString(), `post@${agentId}.example.test`);
      return id;
    }
    function queuedClaim(agentId: string, email: string, reason = "no_known_email"): string {
      const id = `rv-claim-${++seq}`;
      db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, review_reason)
                  VALUES (?, ?, 'Eier', ?, 'pending_review', ?)`).run(id, agentId, email, reason);
      return id;
    }
    const profile = (id: string) => {
      const a = db.prepare("SELECT is_verified, claimed_at, claimed_via FROM agents WHERE id = ?").get(id) as any;
      const k = db.prepare("SELECT data_source FROM agent_knowledge WHERE agent_id = ?").get(id) as any;
      return { is_verified: a?.is_verified ?? null, claimed_at: a?.claimed_at ?? null, claimed_via: a?.claimed_via ?? null, data_source: k ? k.data_source : "(no knowledge row)" };
    };
    const owned = (id: string): number => (db.prepare(`SELECT ${customerRuleSql("a")} AS c FROM agents a WHERE a.id = ?`).get(id) as { c: number }).c;
    const claimRow = (id: string): any => db.prepare("SELECT * FROM agent_claims WHERE id = ?").get(id);

    // ══ (claim) code path, discovery row ════════════════════════════════
    {
      agent("rv-a");
      const before = profile("rv-a");
      const c = codeClaim("rv-a");
      const v = knowledgeService.verifyClaim(c, "123456", "rv-a");
      ok(v.success && !!v.claimToken, "claim: verifyClaim succeeds");
      const granted = profile("rv-a");
      eq([granted.is_verified, granted.claimed_via, granted.data_source, !!granted.claimed_at], [1, "claim", "hybrid", true], "claim: the grant set the owner stamps (as before C1)");
      eq(JSON.parse(claimRow(c).pre_grant_state), { v: 1, is_verified: 0, claimed_at: null, claimed_via: null, has_knowledge: true, data_source: "auto" }, "snap: the code path stores the pre-grant profile");
      ok(!!knowledgeService.getClaimByToken(v.claimToken!), "claim: the token resolves before revoke");
      eq(owned("rv-a"), 1, "claim: the customer rule counts the agent as owned");

      const r = await revoke({ claimId: c, note: "feil eier" });
      eq([r.status, r.json], [200, { success: true, claimId: c, agentId: "rv-a", restored: "snapshot", ownerRemains: false }], "claim: revoke → 200 with the response shape");
      eq(profile("rv-a"), before, "claim: the profile is exactly as before the grant");
      const row = claimRow(c);
      eq([row.status, row.claim_token, row.revoke_note, !!row.revoked_at, !!row.claim_token_expires_at], ["revoked", null, "feil eier", true, true], "claim: the claim is 'revoked', token cleared, note + revoked_at stamped");
      eq(knowledgeService.getClaimByToken(v.claimToken!), null, "claim: the old claim token no longer resolves");
      eq(owned("rv-a"), 0, "claim: the customer rule no longer counts the agent as owned");
      eq(knowledgeService.createMagicLink(row.claimant_email).success, false, "claim: /selger magic-link login no longer finds the revoked claim");

      const again = await revoke({ claimId: c });
      eq([again.status, again.json?.error], [409, "not_verified"], "route: a second revoke → 409");
    }

    // ══ (claim) code path, self_registered row ═══════════════════════════
    {
      agent("rv-self", { origin: "self_registered" });
      const before = profile("rv-self");
      const c = codeClaim("rv-self", "222222");
      ok(knowledgeService.verifyClaim(c, "222222", "rv-self").success, "claim/self: verifyClaim succeeds");
      eq(profile("rv-self").is_verified, 0, "claim/self: the badge is withheld (unchanged gate)");
      const r = knowledgeService.revokeClaimOwnership(c);
      eq(r.ok && [r.restored, r.ownerRemains], ["snapshot", false], "claim/self: restored from the snapshot");
      eq(profile("rv-self"), before, "claim/self: the profile is exactly as before the grant");
      eq(owned("rv-self"), 0, "claim/self: no longer owned");
    }

    // ══ (admin) approval of a row already is_verified=1 with a claimed_at ══
    {
      agent("rv-b", { isVerified: 1, claimedAt: "2026-02-02T00:00:00.000Z", claimedVia: "admin", dataSource: "owner" });
      const before = profile("rv-b");
      const c = queuedClaim("rv-b", "eier@rv-b.example.test", "has_owner");
      const ap = knowledgeService.approveClaimReview(c);
      ok(ap.ok, "admin: approveClaimReview succeeds");
      eq(JSON.parse(claimRow(c).pre_grant_state), { v: 1, is_verified: 1, claimed_at: "2026-02-02T00:00:00.000Z", claimed_via: "admin", has_knowledge: true, data_source: "owner" }, "snap: the admin path stores the pre-grant profile");
      const r = await revoke({ claimId: c });
      eq([r.status, r.json?.restored, r.json?.ownerRemains], [200, "snapshot", false], "admin: revoke → 200, snapshot");
      eq(profile("rv-b"), before, "admin: an already-verified, already-stamped profile is exactly as before");
      eq(owned("rv-b"), 1, "admin: still a customer by its own earlier claimed_at stamp (not from this claim)");
    }

    // ══ (admin) approval of a plain row with no knowledge row ════════════
    {
      agent("rv-c", { dataSource: null });
      const before = profile("rv-c");
      const c = queuedClaim("rv-c", "eier@rv-c.example.test");
      ok(knowledgeService.approveClaimReview(c).ok, "admin/plain: approve succeeds");
      eq([profile("rv-c").is_verified, profile("rv-c").claimed_via], [1, "admin_approval"], "admin/plain: the grant stamped admin_approval + badge");
      const r = knowledgeService.revokeClaimOwnership(c, "test");
      eq(r.ok && r.restored, "snapshot", "admin/plain: restored from the snapshot");
      eq(profile("rv-c"), before, "admin/plain: the profile is exactly as before");
      eq(owned("rv-c"), 0, "admin/plain: no longer owned");
    }

    // ══ (edit) an owner edit to data_source after the grant is kept ══════
    {
      agent("rv-e");
      const c = codeClaim("rv-e", "333333");
      ok(knowledgeService.verifyClaim(c, "333333", "rv-e").success, "edit: verify succeeds");
      db.prepare("UPDATE agent_knowledge SET data_source = 'owner' WHERE agent_id = 'rv-e'").run();
      knowledgeService.revokeClaimOwnership(c);
      const p = profile("rv-e");
      eq([p.is_verified, p.claimed_at, p.claimed_via, p.data_source], [0, null, null, "owner"], "edit: owner stamps restored, a later data_source change is not undone");
    }

    // ══ (owner) another verified claim remains ═══════════════════════════
    {
      agent("rv-d");
      const before = profile("rv-d");
      const first = codeClaim("rv-d", "444444");
      ok(knowledgeService.verifyClaim(first, "444444", "rv-d").success, "owner: first owner verified");
      const granted = profile("rv-d");
      const second = queuedClaim("rv-d", "andre@rv-d.example.test", "has_owner");
      ok(knowledgeService.approveClaimReview(second).ok, "owner: second owner approved");
      const r = await revoke({ claimId: second });
      eq([r.status, r.json?.restored, r.json?.ownerRemains], [200, "kept_other_owner", true], "owner: revoking one of two → kept_other_owner, ownerRemains");
      eq(profile("rv-d"), granted, "owner: the remaining owner's stamps are left alone");
      eq(owned("rv-d"), 1, "owner: still owned by the remaining verified claim");
      eq(claimRow(first).status, "verified", "owner: the other claim is untouched");
      const r2 = knowledgeService.revokeClaimOwnership(first);
      eq(r2.ok && [r2.restored, r2.ownerRemains], ["snapshot", false], "owner: revoking the last one restores from its snapshot");
      eq(profile("rv-d"), before, "owner: … the profile is as before the first grant");
      eq(owned("rv-d"), 0, "owner: no longer owned");
    }

    // ══ (legacy) a verified claim granted before C1 (no snapshot) ════════
    {
      agent("rv-l", { isVerified: 1, claimedAt: "2026-07-22T07:14:21.000Z", claimedVia: "claim", dataSource: "hybrid" });
      db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, claim_token, verified_at)
                  VALUES ('rv-legacy', 'rv-l', 'Eier', 'eier@rv-l.example.test', 'verified', 'claim_legacy_tok', '2026-07-22T07:14:21.000Z')`).run();
      const r = await revoke({ claimId: "rv-legacy" });
      eq([r.status, r.json?.restored, r.json?.ownerRemains], [200, "partial_no_snapshot", false], "legacy: no snapshot → partial_no_snapshot");
      eq(profile("rv-l"), { is_verified: 1, claimed_at: null, claimed_via: null, data_source: "hybrid" }, "legacy: claimed_at/claimed_via cleared, is_verified and data_source left");
      eq(knowledgeService.getClaimByToken("claim_legacy_tok"), null, "legacy: the token no longer resolves");
      eq(owned("rv-l"), 0, "legacy: no longer owned");

      agent("rv-l2", { claimedAt: "2026-01-01T00:00:00.000Z", claimedVia: "admin" });
      db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, verified_at)
                  VALUES ('rv-legacy2', 'rv-l2', 'Eier', 'eier@rv-l2.example.test', 'verified', '2026-07-22T07:14:21.000Z')`).run();
      knowledgeService.revokeClaimOwnership("rv-legacy2");
      eq([profile("rv-l2").claimed_at, profile("rv-l2").claimed_via], ["2026-01-01T00:00:00.000Z", "admin"], "legacy: a claimed_via not set by a grant is left");
    }

    // ══ (login) owner login rows bound to this agent + address ═══════════
    {
      agent("rv-s");
      agent("rv-s-other");
      const c = queuedClaim("rv-s", "Eier@RV-S.example.test");
      ok(knowledgeService.approveClaimReview(c).ok, "login: approve succeeds");
      const email = claimRow(c).claimant_email as string;
      const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
      const ins = db.prepare(`INSERT INTO magic_links (id, email, token, agent_id, used, expires_at) VALUES (?, ?, ?, ?, ?, ?)`);
      ins.run("mlsess_rv1", email, "tok-rv-sess", "rv-s", 1, future);
      ins.run("mlclaim_rv1", email, "tok-rv-claim", "rv-s", 0, future);
      ins.run("ml_rv1", "EIER@rv-s.example.test ", "tok-rv-ml", "rv-s", 1, future);
      ins.run("mlsess_rv2", "annen@rv-s.example.test", "tok-rv-annen", "rv-s", 1, future);
      ins.run("mlsess_rv3", email, "tok-rv-other-agent", "rv-s-other", 1, future);
      const live = (tok: string): boolean =>
        (db.prepare("SELECT datetime(expires_at) > datetime('now') AS x FROM magic_links WHERE token = ?").get(tok) as { x: number }).x === 1;
      const r = knowledgeService.revokeClaimOwnership(c);
      eq(r.ok && r.sessionsRevoked, 3, "login: three login rows for this agent + address expired");
      eq(["tok-rv-sess", "tok-rv-claim", "tok-rv-ml"].map(live), [false, false, false], "login: session, claim-approval link and request link (case/space-insensitive) no longer valid");
      eq(["tok-rv-annen", "tok-rv-other-agent"].map(live), [true, true], "login: another address on the agent and the same address on another agent are left");

      // A remaining verified claim with the same address keeps the login.
      agent("rv-s2");
      const v1 = queuedClaim("rv-s2", "felles@rv-s2.example.test");
      ok(knowledgeService.approveClaimReview(v1).ok, "login/shared: first approve");
      const v2 = queuedClaim("rv-s2", "felles@rv-s2.example.test", "has_owner");
      ok(knowledgeService.approveClaimReview(v2).ok, "login/shared: second approve (same address)");
      ins.run("mlsess_rv4", "felles@rv-s2.example.test", "tok-rv-shared", "rv-s2", 1, future);
      const r2 = knowledgeService.revokeClaimOwnership(v2);
      eq(r2.ok && [r2.sessionsRevoked, r2.ownerRemains], [0, true], "login/shared: no login row expired while that address still owns the agent");
      eq(live("tok-rv-shared"), true, "login/shared: … the session still works");
    }

    // ══ (reverify) a revoked claim cannot be verified again ══════════════
    {
      agent("rv-x");
      const before = profile("rv-x");
      const c = codeClaim("rv-x", "555555");
      const v = knowledgeService.verifyClaim(c, "555555", "rv-x");
      ok(v.success, "reverify: first verify succeeds");
      ok(knowledgeService.revokeClaimOwnership(c).ok, "reverify: revoke succeeds");
      const row = claimRow(c);
      eq([row.verification_code, !!row.expires_at && Date.parse(row.expires_at) <= Date.now()], [null, true], "reverify: revoke clears the code and ends its expiry");
      const again = knowledgeService.verifyClaim(c, "555555", "rv-x");
      eq([again.success, again.status, again.claimToken], [false, "revoked", undefined], "reverify: verifyClaim with the same code is refused with status 'revoked'");
      eq(claimRow(c).status, "revoked", "reverify: the status stays 'revoked'");
      eq(profile("rv-x"), before, "reverify: the profile is not granted again");
      eq(owned("rv-x"), 0, "reverify: still not owned");
      // The old code restored by hand (a stale row) is still refused.
      db.prepare("UPDATE agent_claims SET verification_code = '555555', expires_at = ? WHERE id = ?").run(new Date(Date.now() + 3_600_000).toISOString(), c);
      eq(knowledgeService.verifyClaim(c, "555555", "rv-x").status, "revoked", "reverify: refused even with a live code on the row");
      db.prepare("UPDATE agent_claims SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 3_600_000).toISOString(), c);
      knowledgeService.verifyClaim(c, "555555", "rv-x");
      eq(claimRow(c).status, "revoked", "reverify: an expired code does not overwrite 'revoked' with 'expired'");
      const rs = knowledgeService.resendClaimCode(c, "rv-x");
      eq([rs.kind, (rs as any).reason], ["refused", "closed"], "reverify: «Send koden på nytt» refuses a revoked claim");
      eq(claimRow(c).status, "revoked", "reverify: … and leaves it 'revoked'");
      eq(knowledgeService.resendClaimToken("rv-x", row.claimant_email).success, false, "reverify: resendClaimToken finds no claim to revive");
      eq(knowledgeService.getClaimByToken(v.claimToken!), null, "reverify: the old token still does not resolve");
    }

    // ══ (order) two owners revoked in grant order (A, then B) ════════════
    {
      agent("rv-o");
      const before = profile("rv-o");
      const a = codeClaim("rv-o", "666666");
      ok(knowledgeService.verifyClaim(a, "666666", "rv-o").success, "order: owner A verified");
      const b = queuedClaim("rv-o", "b@rv-o.example.test", "has_owner");
      ok(knowledgeService.approveClaimReview(b).ok, "order: owner B approved while A owns");
      eq(claimRow(b).pre_grant_state, claimRow(a).pre_grant_state, "order: B carries A's baseline, not A's post-grant state");
      const ra = knowledgeService.revokeClaimOwnership(a);
      eq(ra.ok && ra.restored, "kept_other_owner", "order: revoking A first keeps B's stamps");
      const rb = knowledgeService.revokeClaimOwnership(b);
      eq(rb.ok && [rb.restored, rb.ownerRemains], ["snapshot", false], "order: revoking B last restores from the baseline");
      eq(profile("rv-o"), before, "order: the profile is exactly as before A's grant");
      eq(owned("rv-o"), 0, "order: no longer owned");
    }

    // ══ (order) a pre-C1 owner + a new owner: baseline unknown ═══════════
    {
      agent("rv-p", { isVerified: 1, claimedAt: "2026-07-22T07:14:21.000Z", claimedVia: "claim", dataSource: "hybrid" });
      db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, verified_at)
                  VALUES ('rv-p-legacy', 'rv-p', 'Eier', 'eier@rv-p.example.test', 'verified', '2026-07-22T07:14:21.000Z')`).run();
      const b = queuedClaim("rv-p", "b@rv-p.example.test", "has_owner");
      ok(knowledgeService.approveClaimReview(b).ok, "order/legacy: new owner approved");
      eq(claimRow(b).pre_grant_state, null, "order/legacy: no snapshot stored when an existing owner has none");
      knowledgeService.revokeClaimOwnership("rv-p-legacy");
      const rb = knowledgeService.revokeClaimOwnership(b);
      eq(rb.ok && rb.restored, "partial_no_snapshot", "order/legacy: the last revoke restores only partly");
      eq(profile("rv-p"), { is_verified: 1, claimed_at: null, claimed_via: null, data_source: "hybrid" }, "order/legacy: owner stamps cleared, the rest left");
      eq(owned("rv-p"), 0, "order/legacy: no longer owned");
    }

    // ══ (trust) the route recalculates the trust score ═══════════════════
    {
      const { trustScoreService } = require("../services/trust-score-service") as typeof import("../services/trust-score-service");
      agent("rv-t");
      const c = codeClaim("rv-t", "777777");
      ok(knowledgeService.verifyClaim(c, "777777", "rv-t").success, "trust: verify succeeds");
      db.prepare("UPDATE agents SET trust_score = 0.4242 WHERE id = 'rv-t'").run();
      eq((await revoke({ claimId: c })).status, 200, "trust: revoke → 200");
      const ts = (db.prepare("SELECT trust_score FROM agents WHERE id = 'rv-t'").get() as { trust_score: number }).trust_score;
      eq(ts, trustScoreService.calculate("rv-t"), "trust: trust_score was recalculated for the revoked profile (trustScoreService.update)");
      ok(ts !== 0.4242, "trust: … the sentinel value is gone");
    }

    // ══ (route) auth, body, unknown, pending ═════════════════════════════
    {
      agent("rv-r");
      const pending = codeClaim("rv-r");
      const queued = queuedClaim("rv-r", "q@rv-r.example.test");
      eq((await revoke({ claimId: pending }, {})).status, 403, "route: no X-Admin-Key → 403");
      eq((await revoke({ claimId: pending }, { "X-Admin-Key": "wrong" })).status, 403, "route: wrong X-Admin-Key → 403");
      eq((await revoke({})).status, 400, "route: no claimId → 400");
      eq((await revoke({ claimId: 42 })).status, 400, "route: non-string claimId → 400");
      eq((await revoke({ claimId: "   " })).status, 400, "route: blank claimId → 400");
      eq((await revoke({ claimId: pending, note: 5 })).status, 400, "route: non-string note → 400");
      eq((await revoke({ claimId: pending, note: "x".repeat(1001) })).status, 400, "route: note over 1000 characters → 400");
      const unk = await revoke({ claimId: "rv-nope" });
      eq([unk.status, unk.json?.error], [404, "not_found"], "route: unknown claim → 404");
      const p = await revoke({ claimId: pending });
      eq([p.status, p.json?.error], [409, "not_verified"], "route: code_sent claim → 409");
      eq((await revoke({ claimId: queued })).status, 409, "route: pending_review claim → 409");
      eq([claimRow(pending).status, claimRow(queued).status], ["code_sent", "pending_review"], "route: refused revokes change nothing");
    }

    // ══ (mig) 11=A-shaped table → 'revoked' in the CHECK ═════════════════
    {
      const old = new Database(":memory:");
      old.pragma("journal_mode = DELETE");
      initMod.__initSchemaForTesting(old);
      const cur = (old.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_claims'").get() as { sql: string }).sql;
      ok(cur.includes("'revoked'"), "mig: a fresh schema allows 'revoked'");
      old.pragma("foreign_keys = OFF");
      old.exec("ALTER TABLE agent_claims RENAME TO agent_claims_fresh");
      old.exec(cur.replace(",'revoked')", ")"));
      old.exec("INSERT INTO agent_claims SELECT * FROM agent_claims_fresh");
      old.exec("DROP TABLE agent_claims_fresh");
      old.exec("CREATE INDEX IF NOT EXISTS idx_agent_claims_agent ON agent_claims(agent_id)");
      old.exec("CREATE INDEX IF NOT EXISTS idx_agent_claims_status ON agent_claims(status)");
      old.exec("CREATE INDEX IF NOT EXISTS idx_agent_claims_email ON agent_claims(claimant_email)");
      let refusedBefore = false;
      try { old.prepare("INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status) VALUES ('pre', 'x', 'x', 'x', 'revoked')").run(); } catch { refusedBefore = true; }
      ok(refusedBefore, "mig: the 11=A-shaped table refuses 'revoked'");
      old.prepare("INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, verified_at) VALUES ('m1', 'gone', 'Eier', 'e@x.example.test', 'verified', '2026-09-09T11:20:00.000Z')").run();
      old.prepare("INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status) VALUES ('m2', 'gone', 'Kø', 'k@x.example.test', 'pending_review')").run();
      const before = JSON.stringify(old.prepare("SELECT * FROM agent_claims ORDER BY id").all());
      initMod.__initSchemaForTesting(old);
      const sql = (old.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_claims'").get() as { sql: string }).sql;
      ok(sql.includes("'revoked'") && sql.includes("'pending_review'"), "mig: the rebuilt CHECK allows 'revoked'");
      eq(JSON.stringify(old.prepare("SELECT * FROM agent_claims ORDER BY id").all()), before, "mig: every row is copied unchanged");
      const idx = (old.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_claims' AND sql IS NOT NULL ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
      eq(idx, ["idx_agent_claims_agent", "idx_agent_claims_email", "idx_agent_claims_status"], "mig: the indexes are recreated");
      eq(old.pragma("foreign_keys", { simple: true }), 0, "mig: the foreign_keys setting is restored as it was");
      old.prepare("UPDATE agent_claims SET status = 'revoked' WHERE id = 'm1'").run();
      initMod.__initSchemaForTesting(old);
      // The same rebuild with foreign_keys ON: the setting must come back ON.
      old.exec("ALTER TABLE agent_claims RENAME TO agent_claims_fresh");
      old.exec(sql.replace(",'revoked')", ")"));
      old.exec("INSERT INTO agent_claims SELECT * FROM agent_claims_fresh WHERE status != 'revoked'");
      old.exec("DROP TABLE agent_claims_fresh");
      old.pragma("foreign_keys = ON");
      initMod.__initSchemaForTesting(old);
      ok(((old.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_claims'").get() as { sql: string }).sql).includes("'revoked'"), "mig: rebuilt again with foreign_keys ON");
      eq(old.pragma("foreign_keys", { simple: true }), 1, "mig: foreign_keys ON is restored as it was");
      eq((old.prepare("SELECT COUNT(*) AS n FROM agent_claims").get() as { n: number }).n, 1, "mig: … rows copied (orphan agent row kept)");
      initMod.__initSchemaForTesting(old);
      eq((old.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_claims'").get() as { sql: string }).sql, sql, "mig: a later boot does not rebuild again");
      old.close();
    }
  } catch (err) {
    failed++;
    failures.push(`rfb-claim-revoke: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (savedAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = savedAdminKey;
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("./admin-agents")]; } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";
  if (!process.env.EMAIL_FORCE_DRY_RUN) process.env.EMAIL_FORCE_DRY_RUN = "true";
  runRfbClaimRevokeTests({ log: true }).then((r) => {
    console.log(`\nrfb-claim-revoke: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
