/**
 * rfb-owner-claim-customer.test.ts — dev-request
 * 2026-10-01-rfb-eierkrav-utelates-fra-outreach (slice 1).
 *
 * Covers:
 *   (a) customerRuleSql: claimed_at OR verified agent_claims row; code_sent /
 *       rejected / expired claims do NOT count
 *   (b) computeOutreachCandidates: an agent with a verified claim and
 *       claimed_at NULL is NOT a candidate (first mode); an unclaimed twin is
 *   (c) verifyClaim sets claimed_at/claimed_via, never overwrites an existing
 *       claimed_at / claimed_via, and also stamps self_registered rows
 *   (d) POST /admin/agents/claim-backfill: 403, dry-run default (no writes),
 *       apply fills + one audit row per agent, idempotent second apply,
 *       existing claimed_at untouched
 *   (e) POST /webhooks/inbound-email handler: same email_id twice -> one
 *       forward, both answers 200; early 200 (before fetch resolves); fetch
 *       timeout signal passed; no email_id -> still forwarded
 *
 * Pins the getDb() singleton to its own in-memory DB (restored in finally) —
 * wired into tests/test.ts via runSerial.
 */
import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary { passed: number; failed: number; failures: string[] }

const GOOD_ABOUT =
  "Vi driver en liten gård i Valdres med sau og bier, og selger lammekjøtt, honning og ull direkte fra gården hele året.";

function callRoute(router: any, opts: { url: string; headers?: Record<string, string>; body?: any; query?: any }): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = { method: "POST", url: opts.url, originalUrl: opts.url, query: opts.query || {}, headers, body: opts.body, ip: "127.0.0.1", get: (n: string) => headers[n.toLowerCase()] };
    const res: any = {
      statusCode: 200,
      status(c: number) { this.statusCode = c; return this; },
      json(p: any) { resolve({ status: this.statusCode, body: p }); return this; },
      end() { resolve({ status: this.statusCode, body: undefined }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 0, body: err ? { error: String(err) } : undefined }));
  });
}

export async function runRfbOwnerClaimCustomerTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const eq = (a: unknown, e: unknown, label: string) => {
    if (JSON.stringify(a) === JSON.stringify(e)) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}\n    expected: ${JSON.stringify(e)}\n    actual:   ${JSON.stringify(a)}`); }
  };
  const ok = (c: boolean, label: string) => eq(!!c, true, label);

  const ambientKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  if (ambientKey === "") process.env.ADMIN_KEY = "rfb-owner-claim-customer-standalone-key";
  const setKeyOurselves = ambientKey === "";
  const testKey = (process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY) as string;
  const prevPaused = process.env.OUTREACH_PAUSED;
  delete process.env.OUTREACH_PAUSED;

  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = OFF");
  initMod.__setDbForTesting(db);
  initMod.__initSchemaForTesting(db);

  try {
    let seq = 0;
    const insA = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, claimed_at, claimed_via, origin)
       VALUES (?, ?, 'Gård', 'test', ?, 'https://gard-test.no', 'producer', ?, ?, ?, ?)`,
    );
    const insK = db.prepare(
      `INSERT INTO agent_knowledge (agent_id, email, about, products, field_provenance, verification_status, enrichment_status, url_last_status, url_last_probed, outreach_eligible_at)
       VALUES (?, ?, ?, '[]', '{}', 'verified', 'rich', 200, datetime('now'), ?)`,
    );
    function seed(id: string, o: { claimedAt?: string | null; claimedVia?: string | null; origin?: string } = {}): void {
      seq++;
      insA.run(id, `Gård ${id}`, `${id}@gard-test.no`, `key-${id}`, o.claimedAt ?? null, o.claimedVia ?? null, o.origin ?? "discovery");
      insK.run(id, `${id}@gard-test.no`, GOOD_ABOUT, `2026-01-01 00:00:${String(seq % 60).padStart(2, "0")}`);
    }
    function claim(id: string, agentId: string, status: string, verifiedAt: string | null, code = "123456"): void {
      db.prepare(
        `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, verification_code, status, source, expires_at, created_at, verified_at)
         VALUES (?, ?, 'Eier', ?, ?, ?, 'organic', datetime('now','+7 days'), '2026-07-20T00:00:00.000Z', ?)`,
      ).run(id, agentId, `${agentId}@owner.no`, code, status, verifiedAt);
    }

    // ── (a)+(b) the rule + the outreach gate ──────────────────────────────
    seed("free");                                   // plain candidate
    seed("vclaim");                                 // verified claim, claimed_at NULL (Solvang case)
    claim("c-vclaim", "vclaim", "verified", "2026-07-22T07:14:21.000Z");
    seed("pending");                                // only code_sent claim -> still a candidate
    claim("c-pending", "pending", "code_sent", null);
    seed("rejected");
    claim("c-rejected", "rejected", "rejected", null);
    seed("stamped", { claimedAt: "2026-01-01T00:00:00.000Z", claimedVia: "admin" });

    const { customerRuleSql, isCustomerSnapshot } = require("../services/customer-rule");
    const isCust = (id: string) =>
      (db.prepare(`SELECT ${customerRuleSql("a")} AS c FROM agents a WHERE a.id = ?`).get(id) as any).c;
    eq(isCust("free"), 0, "(a) unclaimed, no claim -> not customer");
    eq(isCust("vclaim"), 1, "(a) verified claim, claimed_at NULL -> customer");
    eq(isCust("pending"), 0, "(a) code_sent claim -> not customer");
    eq(isCust("rejected"), 0, "(a) rejected claim -> not customer");
    eq(isCust("stamped"), 1, "(a) claimed_at set -> customer");
    ok(isCustomerSnapshot({ claimed_at: null, verified_claims: 1 }) && !isCustomerSnapshot({ claimed_at: null, verified_claims: 0 }) && isCustomerSnapshot({ claimed_at: "x", verified_claims: 0 }), "(a) isCustomerSnapshot mirrors the SQL rule");
    let threw = false;
    try { customerRuleSql("a; DROP TABLE agents"); } catch { threw = true; }
    ok(threw, "(a) customerRuleSql rejects a non-identifier alias");

    const { computeOutreachCandidates } = require("./admin-outreach-candidates");
    const gate = computeOutreachCandidates(db, { mode: "first", cooldownDays: 60, limit: 100 });
    const ids = gate.candidates.map((c: any) => c.agent_id).sort();
    ok(ids.includes("free"), "(b) unclaimed agent IS a candidate (control)");
    ok(ids.includes("pending"), "(b) code_sent-claim agent IS a candidate");
    ok(!ids.includes("vclaim"), "(b) verified-claim agent with claimed_at NULL is NOT a candidate");
    ok(!ids.includes("stamped"), "(b) claimed_at agent is NOT a candidate");

    // ── (c) verifyClaim ───────────────────────────────────────────────────
    const { knowledgeService } = require("../services/knowledge-service");
    const agentRow = (id: string) => db.prepare("SELECT claimed_at, claimed_via, is_verified FROM agents WHERE id = ?").get(id) as any;

    seed("vc-new");
    claim("c-vc-new", "vc-new", "code_sent", null, "111111");
    const r1 = knowledgeService.verifyClaim("c-vc-new", "111111");
    ok(r1.success, "(c) verifyClaim succeeds");
    const a1 = agentRow("vc-new");
    ok(!!a1.claimed_at && a1.claimed_via === "claim", "(c) verifyClaim sets claimed_at + claimed_via='claim'");
    const vAt = (db.prepare("SELECT verified_at FROM agent_claims WHERE id = 'c-vc-new'").get() as any).verified_at;
    eq(a1.claimed_at, vAt, "(c) claimed_at == agent_claims.verified_at");

    seed("vc-old", { claimedAt: "2026-02-02T00:00:00.000Z", claimedVia: "admin" });
    claim("c-vc-old", "vc-old", "code_sent", null, "222222");
    knowledgeService.verifyClaim("c-vc-old", "222222");
    const a2 = agentRow("vc-old");
    eq([a2.claimed_at, a2.claimed_via], ["2026-02-02T00:00:00.000Z", "admin"], "(c) verifyClaim does not overwrite existing claimed_at/claimed_via");

    seed("vc-self", { origin: "self_registered" });
    claim("c-vc-self", "vc-self", "code_sent", null, "333333");
    knowledgeService.verifyClaim("c-vc-self", "333333");
    const a3 = agentRow("vc-self");
    ok(!!a3.claimed_at && a3.is_verified === 0, "(c) self_registered: claimed_at set, badge still withheld");

    seed("vc-bad");
    claim("c-vc-bad", "vc-bad", "code_sent", null, "444444");
    knowledgeService.verifyClaim("c-vc-bad", "999999");
    eq(agentRow("vc-bad").claimed_at, null, "(c) wrong code -> claimed_at untouched");

    // ── (d) backfill route ────────────────────────────────────────────────
    delete require.cache[require.resolve("./admin-agents-claim-backfill")];
    const bf = require("./admin-agents-claim-backfill");
    bf.__setClaimBackfillDbForTesting(db);
    const post = (body: any, key: string | false = testKey) =>
      callRoute(bf.default, { url: "/", headers: key === false ? {} : { "x-admin-key": key }, body });
    const auditCount = (id: string) => (db.prepare("SELECT COUNT(*) AS n FROM agent_knowledge_audit WHERE agent_id = ? AND field_name = 'claimed_at'").get(id) as any).n;

    // fresh fixtures: two backfill targets (one with two verified claims -> earliest), one already stamped
    seed("bf-1"); claim("c-bf-1", "bf-1", "verified", "2026-07-01T10:00:00.000Z");
    seed("bf-2"); claim("c-bf-2a", "bf-2", "verified", "2026-08-05T10:00:00.000Z"); claim("c-bf-2b", "bf-2", "verified", "2026-06-05T10:00:00.000Z");
    seed("bf-3", { claimedAt: "2026-03-03T00:00:00.000Z" }); claim("c-bf-3", "bf-3", "verified", "2026-09-09T00:00:00.000Z");

    eq((await post({}, false)).status, 403, "(d) no admin key -> 403");
    const dry = await post({});
    eq(dry.body.dry_run, true, "(d) dry-run is the default");
    const dryIds = dry.body.items.map((i: any) => i.id).sort();
    eq(dryIds, ["bf-1", "bf-2", "vclaim"], "(d) dry-run lists exactly the verified-claim agents with NULL claimed_at");
    const it2 = dry.body.items.find((i: any) => i.id === "bf-2");
    eq(it2.claimed_at, "2026-06-05T10:00:00.000Z", "(d) date = earliest verified claim");
    ok(typeof it2.name === "string" && it2.name.length > 0, "(d) items carry id, name, date");
    eq(agentRow("bf-1").claimed_at, null, "(d) dry-run wrote nothing");
    eq(auditCount("bf-1"), 0, "(d) dry-run wrote no audit row");

    const app1 = await post({ apply: true });
    eq(app1.body.dry_run, false, "(d) apply flag respected");
    eq(app1.body.count, 3, "(d) apply changed 3 agents");
    eq(agentRow("bf-1").claimed_at, "2026-07-01T10:00:00.000Z", "(d) bf-1 claimed_at = verified_at");
    eq(agentRow("bf-1").claimed_via, "claim", "(d) bf-1 claimed_via = 'claim'");
    eq(agentRow("vclaim").claimed_at, "2026-07-22T07:14:21.000Z", "(d) Solvang-style agent backfilled");
    eq(agentRow("bf-3").claimed_at, "2026-03-03T00:00:00.000Z", "(d) existing claimed_at untouched");
    eq([auditCount("bf-1"), auditCount("bf-2"), auditCount("vclaim"), auditCount("bf-3")], [1, 1, 1, 0], "(d) one audit row per changed agent only");
    const gate2 = computeOutreachCandidates(db, { mode: "first", cooldownDays: 60, limit: 100 });
    ok(!gate2.candidates.some((c: any) => ["bf-1", "bf-2", "vclaim"].includes(c.agent_id)), "(d) backfilled agents are not candidates");
    const app2 = await post({ apply: true });
    eq(app2.body.count, 0, "(d) second apply is a no-op (idempotent)");
    eq(auditCount("bf-1"), 1, "(d) second apply wrote no extra audit rows");
    bf.__setClaimBackfillDbForTesting(null);

    // ── (e) inbound-email webhook ─────────────────────────────────────────
    const wh = require("../services/inbound-email-webhook");
    const sent: any[] = [];
    let fetchCalls = 0;
    let sawSignal = false;
    let releaseFetch: () => void = () => {};
    const gateP = new Promise<void>((r) => { releaseFetch = r; });
    const deps = {
      sendEmail: async (o: any) => { sent.push(o); return { success: true }; },
      fetchImpl: (async (_u: string, init: any) => {
        fetchCalls++;
        sawSignal = !!init?.signal;
        await gateP;
        return { ok: true, json: async () => ({ text: "hei", html: "<p>hei</p>" }) };
      }) as any,
    };
    const prevKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "re_test_key";
    const mkReq = (body: any): any => ({ body });
    function mkRes() {
      const r: any = { code: 0, payload: null, statusCalledAt: 0 };
      r.status = (c: number) => { r.code = c; return r; };
      r.json = (p: any) => { r.payload = p; r.respondedAt = Date.now(); r.respondedBeforeForward = sent.length; return r; };
      return r;
    }
    const payload = { type: "email.received", data: { email_id: "em_abc", from: "Andrea <hallo@solvanggard.com>", to: ["post@rettfrabonden.com"], subject: "Re: Profil" } };
    const res1 = mkRes();
    const p1 = wh.handleInboundEmailWebhook(mkReq(payload), res1, deps);
    await new Promise((r) => setTimeout(r, 20));
    eq(res1.code, 200, "(e) early 200 while the Resend fetch is still pending");
    eq(sent.length, 0, "(e) nothing forwarded before the fetch resolves");
    releaseFetch();
    await p1;
    eq(sent.length, 1, "(e) first delivery forwarded once");
    ok(sawSignal, "(e) Resend fetch carries a timeout signal");
    const res2 = mkRes();
    await wh.handleInboundEmailWebhook(mkReq(payload), res2, deps);
    eq([res2.code, sent.length, fetchCalls], [200, 1, 1], "(e) same email_id again -> 200, no second forward, no second fetch");
    const res3 = mkRes();
    await wh.handleInboundEmailWebhook(mkReq({ data: { email_id: "em_other", from: "x@y.no", subject: "s" } }), res3, deps);
    eq(sent.length, 2, "(e) a different email_id is forwarded");
    const res4 = mkRes();
    await wh.handleInboundEmailWebhook(mkReq({ from: "x@y.no", subject: "no id" }), res4, deps);
    eq([res4.code, sent.length], [200, 3], "(e) payload without email_id is still forwarded (fail-open)");
    eq((db.prepare("SELECT COUNT(*) AS n FROM inbound_email_seen").get() as any).n, 2, "(e) one inbound_email_seen row per distinct email_id");
    if (prevKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prevKey;
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err));
  } finally {
    if (prevPaused === undefined) delete process.env.OUTREACH_PAUSED; else process.env.OUTREACH_PAUSED = prevPaused;
    if (setKeyOurselves) delete process.env.ADMIN_KEY;
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbOwnerClaimCustomerTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed ? 1 : 0);
  });
}
