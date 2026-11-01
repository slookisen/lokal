/**
 * rfb-claim-kjent-kontakt.test.ts — dev-request
 * 2026-10-17-rfb-claim-verifisering-mot-kjent-kontakt, decision 11=A
 * (daniel-responses/2026-10-17-live-del-a-gjort-og-beslutninger-1-11.md).
 *
 * Before: POST /api/marketplace/agents/:id/claim sent the code to the
 * `email` the claimant typed, so anyone could become a farm's "owner", get
 * "Verifisert av eier" and change its contact fields. Now the code goes only
 * to the farm's own e-mail, else the claim waits for Daniel in the admin
 * queue, plus the hardening the rule needs (knowledge-service.ts, block
 * above the class).
 *
 * Runs the real handlers (pulled off the routers' stacks, fake req/res, no
 * port — the marketplace-quarantine-gates.test.ts harness) against an
 * in-memory DB. Outgoing mail is captured by a stub transporter on the
 * emailService singleton (the repo's pattern, e.g.
 * opplevelser-booking-send-guard.test.ts), so nothing leaves the process.
 * One acceptance criterion per section:
 *   (ac1) listed farm e-mail, no owner: the code goes there whatever `email`
 *         says; masked recipient; code → token, badge (not for
 *         self_registered), claimant_email = the farm's address, e-mail login
 *         reaches it. Fallback (b): delivered outreach without bounce; never
 *         a bounced, other-vertical or domain-derived address.
 *   (ac2) no farm e-mail / "listed address is wrong": admin queue, no mail;
 *         PUT description/knowledge refuse anything from the claim; a repeat
 *         returns the same entry; verify answers 409.
 *   (ac3) profile with an owner (verified claim, or claimed_at): admin queue
 *         even with the right address; the owner's token still works; no
 *         agent_claims row is deleted; the owner's own address is told to log in.
 *   (ac4) a 2nd code on a profile within 24 h → 429, no mail, open claim kept;
 *         after 24 h a new code supersedes it; the platform hourly cap → 429.
 *   (ac5) 5 wrong codes expire the claim; the right code then fails; verify
 *         is bound to :id; a code from before the rule is refused unchanged.
 *   (ac6) admin queue: GET lists it, approve gives the token to the approved
 *         address + login link (badge per the gate, claimed_via
 *         'admin_approval'), reject changes nothing on the profile.
 *   (ac7) production never returns the code (NODE_ENV=production or Fly).
 *   (ac8) existing owners and e-mail login are unchanged.
 *   (hard) crypto code, 24 h life, send failure gives the slot back, the
 *         per-IP limiter is mounted and blocks the 11th request in an hour.
 *   (ui)  selger.html (its inline script in node:vm, tests/helpers/fake-page.ts)
 *         fed by the real handler: the "listed address is wrong" box, the
 *         queued message, the masked recipient.
 *   (mig) the status-CHECK rebuild keeps every existing row as it was.
 *   (rev) review round 1 of PR #1141: the address check is linear (a 1 MB
 *         adversarial address → 400 at once), field caps, the admin queue's
 *         non-IP caps (per profile, platform per hour) and capped listing,
 *         approval defaults to the proven farm address, the per-profile 429
 *         points to the queue, env-set limits, the admin notice, a generic
 *         500, the wrong-code count raised in SQL.
 *
 * Exported runRfbClaimKjentKontaktTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/rfb-claim-kjent-kontakt.test.ts
 */

import Database from "better-sqlite3";
import express from "express";
import http from "http";
import { inlineScript } from "../../tests/helpers/html-injection";
import { serializeText, jsonResponse, settle, runPage, type FetchStub } from "../../tests/helpers/fake-page";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HandlerResult {
  status: number;
  body: any;
}

interface SentMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export async function runRfbClaimKjentKontaktTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // The claim limits' env vars (claimLimits) are cleared so every section
  // runs on the defaults; (rev) sets them itself.
  const LIMIT_ENV = ["CLAIM_CODE_MAX_FAILED_ATTEMPTS", "CLAIM_CODE_PROFILE_WINDOW_HOURS", "CLAIM_CODE_SENDS_PER_HOUR_MAX",
    "CLAIM_REVIEW_OPEN_PER_PROFILE_MAX", "CLAIM_REVIEW_INSERTS_PER_HOUR_MAX"] as const;
  const savedEnv: Record<string, string | undefined> = {
    ADMIN_KEY: process.env.ADMIN_KEY,
    ADMIN_NOTIFICATION_EMAIL: process.env.ADMIN_NOTIFICATION_EMAIL,
    NODE_ENV: process.env.NODE_ENV,
    FLY_APP_NAME: process.env.FLY_APP_NAME,
  };
  for (const k of LIMIT_ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  const ADMIN = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "rfb-claim-kjent-kontakt-standalone-key";
  if (!process.env.ADMIN_KEY && !process.env.ANALYTICS_ADMIN_KEY) process.env.ADMIN_KEY = ADMIN;
  // The routes mail ADMIN_NOTIFICATION_EMAIL fire-and-forget; off here so
  // every captured mail below is one the claim flow itself sent ((rev) turns
  // it on for the admin notice).
  delete process.env.ADMIN_NOTIFICATION_EMAIL;

  // ── outgoing mail: a stub transporter, restored in finally ─────────────
  const emailSvc = (require("../services/email-service") as typeof import("../services/email-service")).emailService as any;
  const origConfigured = emailSvc.isConfigured;
  const origTransporter = emailSvc.transporter;
  const mails: SentMail[] = [];
  let nextSend: "ok" | "dry_run" | "throw" = "ok";
  emailSvc.isConfigured = true;
  emailSvc.transporter = {
    sendMail: async (m: Record<string, any>) => {
      const mode = nextSend;
      nextSend = "ok";
      if (mode === "throw") throw new Error("SMTP unavailable (test)");
      mails.push({ to: String(m.to), subject: String(m.subject), text: String(m.text ?? ""), html: String(m.html ?? "") });
      return { messageId: mode === "dry_run" ? "DRY_RUN" : `stub-${mails.length}` };
    },
  };
  const codeIn = (m: SentMail | undefined): string => (m?.text.match(/\b(\d{6})\b/) ?? [])[1] ?? "";

  // ── handler harness ─────────────────────────────────────────────────────
  function findRoute(router: any, path: string, method: "get" | "post" | "put"): any {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route;
  }
  const handlerOf = (router: any, path: string, method: "get" | "post" | "put"): Function => {
    const route = findRoute(router, path, method);
    return route.stack[route.stack.length - 1].handle;
  };
  function makeReq(o: { params?: Record<string, string>; body?: any; headers?: Record<string, string> }): any {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.headers || {})) headers[k.toLowerCase()] = v;
    return {
      params: o.params || {}, body: o.body, query: {}, headers, ip: "127.0.0.1", lang: "no", protocol: "https",
      get(name: string) { return name.toLowerCase() === "host" ? "rettfrabonden.com" : headers[name.toLowerCase()]; },
    };
  }
  function invoke(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body }); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { settle(p); return res; },
        send(p: any) { settle(p); return res; },
        end() { settle(undefined); return res; },
        header() { return res; }, set() { return res; }, type() { return res; }, setHeader() { return res; },
      };
      try {
        const p = handler(req, res, () => settle({ __next: true }));
        if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
      } catch (err) {
        settle({ __error: String(err) });
      }
    });
  }

  try {
    initMod.__setDbForTesting(db);
    initMod.__initSchemaForTesting(db);
    try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* already loaded */ }

    delete require.cache[require.resolve("./marketplace")];
    delete require.cache[require.resolve("./admin-agents")];
    const marketplaceRouter = require("./marketplace").default as any;
    const adminAgentsRouter = require("./admin-agents").default as any;
    const marketplaceMod = require("./marketplace") as typeof import("./marketplace");
    const ks = require("../services/knowledge-service") as typeof import("../services/knowledge-service");
    const { knowledgeService } = ks;
    const { maskEmail } = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
    const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");

    const claimH = handlerOf(marketplaceRouter, "/agents/:id/claim", "post");
    const verifyH = handlerOf(marketplaceRouter, "/agents/:id/claim/verify", "post");
    const loginH = handlerOf(marketplaceRouter, "/auth/login", "post");
    const putDescH = handlerOf(marketplaceRouter, "/agents/:id/description", "put");
    const putKnowH = handlerOf(marketplaceRouter, "/agents/:id/knowledge", "put");
    const queueH = handlerOf(adminAgentsRouter, "/claim-review-queue", "get");
    const approveH = handlerOf(adminAgentsRouter, "/claim-review-approve", "post");
    const rejectH = handlerOf(adminAgentsRouter, "/claim-review-reject", "post");
    const admin = { "x-admin-key": ADMIN };

    // ── fixtures ────────────────────────────────────────────────────────
    const insAgent = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, claimed_at, claimed_via, origin)
       VALUES (?, ?, 'En gård med egne produkter.', 'test', ?, ?, 'producer', ?, ?, ?, ?)`,
    );
    function agent(id: string, o: { listed?: string | null; origin?: string; claimedAt?: string | null; claimedVia?: string | null; url?: string } = {}): string {
      insAgent.run(id, `Gård ${id}`, `registrert@${id}.example.test`, o.url ?? `https://${id}.example.test`, `key-${id}`,
        o.claimedAt ?? null, o.claimedVia ?? null, o.origin ?? "discovery");
      if (o.listed !== undefined) db.prepare("INSERT INTO agent_knowledge (agent_id, email) VALUES (?, ?)").run(id, o.listed);
      marketplaceRegistry._agentsCache = null;
      return id;
    }
    const claimRow = (id: string): any => db.prepare("SELECT * FROM agent_claims WHERE id = ?").get(id);
    const agentRow = (id: string): any => db.prepare("SELECT is_verified, claimed_at, claimed_via FROM agents WHERE id = ?").get(id);
    const claimsOf = (agentId: string): any[] => db.prepare("SELECT * FROM agent_claims WHERE agent_id = ? ORDER BY created_at, id").all(agentId) as any[];
    const claim = (agentId: string, body: Record<string, unknown>) => invoke(claimH, makeReq({ params: { id: agentId }, body }));
    const verify = (agentId: string, claimId: string, code: unknown) => invoke(verifyH, makeReq({ params: { id: agentId }, body: { claimId, code } }));

    // ══ (ac1) code only to the farm's own address ═══════════════════════
    {
      agent("ac1", { listed: "  Post@Gard-AC1.example.test " });
      const before = mails.length;
      const r = await claim("ac1", { name: "Ukjent", email: "angriper@evil.example.test" });
      eq(r.status, 200, "ac1: claim with a listed farm e-mail → 200, code sent");
      eq(r.body?.data?.status, "code_sent", "ac1: status code_sent");
      eq(mails.length, before + 1, "ac1: exactly one mail");
      eq(mails[mails.length - 1]?.to, "post@gard-ac1.example.test", "ac1: the code goes to the LISTED address (normalized), not the typed one");
      ok(!mails.some((m) => m.to.includes("evil.example.test")), "ac1: nothing is mailed to the address the claimant typed");
      eq(r.body?.data?.sentTo, maskEmail("post@gard-ac1.example.test"), "ac1: the response shows the recipient masked");
      const raw = JSON.stringify(r.body);
      ok(!raw.includes("post@gard-ac1.example.test"), "ac1: the full farm address is not in the response");
      const code = codeIn(mails[mails.length - 1]);
      ok(/^\d{6}$/.test(code), "ac1: the mail carries a 6-digit code");
      ok(mails[mails.length - 1]!.text.includes("Gård ac1") && mails[mails.length - 1]!.text.includes("Del aldri koden med andre"),
        "ac1: the mail names the profile and warns never to share the code");
      ok(!raw.includes(code), "ac1: the code is not in the response when the mail went out");
      const row = claimRow(r.body.data.claimId);
      eq([row.status, row.code_sent_to, row.claimant_email, row.verification_code], ["code_sent", "post@gard-ac1.example.test", "angriper@evil.example.test", code],
        "ac1: claim row: code_sent, code_sent_to = farm, claimant_email = typed until verified");
      const lifeH = (Date.parse(row.expires_at) - Date.parse(row.created_at)) / 3_600_000;
      ok(Math.abs(lifeH - 24) < 0.01, `hard: the code lives 24 h (got ${lifeH.toFixed(3)} h)`);

      const v = await verify("ac1", r.body.data.claimId, code);
      eq(v.status, 200, "ac1: the right code → 200");
      ok(typeof v.body?.data?.claimToken === "string" && v.body.data.claimToken.startsWith("claim_"), "ac1: claim token issued");
      eq(claimRow(r.body.data.claimId).claimant_email, "post@gard-ac1.example.test", "ac1: claimant_email becomes the farm's address the code went to");
      eq(claimRow(r.body.data.claimId).claimant_email_typed, "angriper@evil.example.test", "ac1: the typed address is kept for audit (claimant_email_typed)");
      eq([agentRow("ac1").is_verified, agentRow("ac1").claimed_via], [1, "claim"], "ac1: badge set (discovery origin), claimed_via 'claim'");
      ok(!!agentRow("ac1").claimed_at, "ac1: claimed_at stamped");
      const ml = knowledgeService.createMagicLink("post@gard-ac1.example.test");
      eq([ml.success, ml.agentId], [true, "ac1"], "ac1: e-mail login for the farm's address reaches the profile");
      eq(knowledgeService.createMagicLink("angriper@evil.example.test").success, false, "ac1: the typed address cannot log in");

      // Same address as listed → same flow, code to that address.
      agent("ac1-same", { listed: "eier@ac1-same.example.test" });
      const rs = await claim("ac1-same", { name: "Eier", email: "Eier@AC1-same.example.test" });
      eq([rs.status, mails[mails.length - 1]?.to], [200, "eier@ac1-same.example.test"], "ac1: claimant typing the listed address gets the code there");

      // self_registered with a listed address: code works, badge withheld (Mikhailo gate 2).
      agent("ac1-self", { listed: "post@ac1-self.example.test", origin: "self_registered" });
      const r2 = await claim("ac1-self", { name: "Selv", email: "post@ac1-self.example.test" });
      const v2 = await verify("ac1-self", r2.body?.data?.claimId, codeIn(mails[mails.length - 1]));
      eq([v2.status, agentRow("ac1-self").is_verified], [200, 0], "ac1: self_registered — the claim succeeds, is_verified stays 0");

      // (b) fallback: delivered outreach for the agent, no bounce.
      agent("ac1-osl", { listed: null });
      const osl = db.prepare("INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, vertical_id) VALUES (?, ?, ?, 'email', ?)");
      osl.run("ac1-osl", "Kontakt@AC1-osl.example.test", "2026-09-01 10:00:00", "rfb");
      osl.run("ac1-osl", "bounced@ac1-osl.example.test", "2026-09-05 10:00:00", "rfb");
      osl.run("ac1-osl", "oa@ac1-osl.example.test", "2026-09-06 10:00:00", "experiences");
      db.prepare("INSERT INTO email_bounces (email, bounced_at) VALUES (?, ?)").run("bounced@ac1-osl.example.test", "2026-09-05 11:00:00");
      eq(knowledgeService.resolveFarmContactEmail("ac1-osl"), "kontakt@ac1-osl.example.test",
        "ac1(b): falls back to the newest delivered RFB outreach address with no bounce (not the bounced one, not the Opplevagent one)");
      const r3 = await claim("ac1-osl", { name: "X", email: "x@annen.example.test" });
      eq([r3.status, mails[mails.length - 1]?.to], [200, "kontakt@ac1-osl.example.test"], "ac1(b): the code goes to that delivered address");

      // Listed field with two addresses or prose is not one address → (b) or queue.
      agent("ac1-two", { listed: "a@ac1-two.example.test, b@ac1-two.example.test" });
      eq(knowledgeService.resolveFarmContactEmail("ac1-two"), null, "ac1: a listed field with two addresses is not a farm address");
      // Never derived from the domain: a website alone gives no address.
      agent("ac1-dom", { url: "https://ac1-dom.example.test" });
      eq(knowledgeService.resolveFarmContactEmail("ac1-dom"), null, "ac1: no address is derived from the website's domain");
      agent("ac1-oa", {});
      osl.run("ac1-oa", "oa@ac1-oa.example.test", "2026-09-06 10:00:00", "experiences");
      eq(knowledgeService.resolveFarmContactEmail("ac1-oa"), null, "ac1(b): an Opplevagent-vertical send is not an RFB farm address");
    }

    // ══ (ac2) no farm e-mail / listed address wrong → admin queue ════════
    let queuedNoEmail = "";
    let queuedWrong = "";
    {
      agent("ac2", { listed: null });
      const before = mails.length;
      const r = await claim("ac2", { name: "Kari Gård", email: "Kari@Gmail.example.test", phone: "91234567" });
      eq(r.status, 202, "ac2: no farm e-mail → 202 accepted into the admin queue");
      eq([r.body?.data?.status, r.body?.data?.reason], ["pending_review", "no_known_email"], "ac2: status pending_review, reason no_known_email");
      eq(mails.length, before, "ac2: no mail is sent");
      ok(r.body?.data?.verificationCode === undefined, "ac2: no code in the response");
      queuedNoEmail = r.body.data.claimId;
      const row = claimRow(queuedNoEmail);
      eq([row.status, row.verification_code, row.claim_token, row.code_sent_to, row.claimant_email, row.verification_method],
        ["pending_review", null, null, null, "kari@gmail.example.test", "manual"], "ac2: queue row has no code, no token, no recipient");
      eq(agentRow("ac2").is_verified, 0, "ac2: no badge before approval");

      for (const token of [queuedNoEmail, "", `claim_${"0".repeat(64)}`]) {
        const d = await invoke(putDescH, makeReq({ params: { id: "ac2" }, headers: token ? { "x-claim-token": token } : {}, body: { name: "Overtatt" } }));
        eq(d.status, 403, `ac2: PUT /agents/:id/description refused before approval (token ${token ? token.slice(0, 8) : "none"})`);
        const k = await invoke(putKnowH, makeReq({ params: { id: "ac2" }, headers: token ? { "x-claim-token": token } : {}, body: { email: "kapret@evil.example.test" } }));
        eq(k.status, 403, `ac2: PUT /agents/:id/knowledge refused before approval (token ${token ? token.slice(0, 8) : "none"})`);
      }
      const v = await verify("ac2", queuedNoEmail, "123456");
      eq([v.status, v.body?.data?.status, v.body?.data?.claimToken], [409, "pending_review", undefined], "ac2: verify on a queued claim → 409, no token");

      const again = await claim("ac2", { name: "Kari Gård", email: "kari@gmail.example.test" });
      eq([again.status, again.body?.data?.claimId], [202, queuedNoEmail], "ac2: a repeat from the same claimant returns the same queue entry");
      eq(claimsOf("ac2").length, 1, "ac2: no duplicate queue row");

      agent("ac2-wrong", { listed: "gammel@ac2-wrong.example.test" });
      const w = await claim("ac2-wrong", { name: "Ny Eier", email: "ny@ac2-wrong.example.test", listedEmailWrong: true });
      eq([w.status, w.body?.data?.reason, mails.length], [202, "listed_email_wrong", before], "ac2: 'listed address is wrong' → queue (listed_email_wrong), no mail");
      queuedWrong = w.body.data.claimId;
      const notTrue = await claim("ac2-wrong", { name: "Ny Eier", email: "ny2@ac2-wrong.example.test", listedEmailWrong: "true" });
      eq([notTrue.status, mails[mails.length - 1]?.to], [200, "gammel@ac2-wrong.example.test"], "ac2: only listedEmailWrong === true counts; otherwise the code goes to the listed address");
    }

    // ══ (ac3) profile with an owner → always the admin queue ═════════════
    let ownerToken = "";
    {
      agent("ac3", { listed: "post@ac3.example.test" });
      const r = await claim("ac3", { name: "Eier", email: "post@ac3.example.test" });
      ownerToken = (await verify("ac3", r.body.data.claimId, codeIn(mails[mails.length - 1]))).body?.data?.claimToken;
      ok(!!ownerToken, "ac3: setup — the farm has a verified owner");
      // Compare the owner's rows by id, not by position: the new rows can share created_at with them and ids are
      // random UUIDs, so ORDER BY created_at, id puts them in a random place (determinism gate, lokal#1141).
      const rowsBeforeList = claimsOf("ac3");
      const rowsBefore = rowsBeforeList.length;
      const idsBefore = new Set(rowsBeforeList.map((c) => c.id));
      const byId = (rows: any[]): string => JSON.stringify([...rows].sort((x, y) => String(x.id).localeCompare(String(y.id))));
      const ownerRowBefore = byId(rowsBeforeList);
      const before = mails.length;

      const other = await claim("ac3", { name: "Ukjent", email: "post@ac3.example.test".replace("post", "annen") });
      eq([other.status, other.body?.data?.reason, mails.length], [202, "has_owner", before], "ac3: another claimant → queue (has_owner), no mail");
      // The listed address itself, from someone else's claim id, still queues.
      const same = await claim("ac3", { name: "Ukjent 2", email: "kopi@ac3.example.test" });
      eq([same.status, same.body?.data?.reason], [202, "has_owner"], "ac3: has_owner queues whatever address is typed");
      eq(claimsOf("ac3").length, rowsBefore + 2, "ac3: no agent_claims row is deleted (two added)");
      ok(byId(claimsOf("ac3").filter((x) => idsBefore.has(x.id))) === ownerRowBefore, "ac3: the owner's claim row is unchanged");
      const login = await invoke(loginH, makeReq({ body: { token: ownerToken } }));
      eq([login.status, login.body?.data?.agentId], [200, "ac3"], "ac3: the owner's token still logs in");
      eq(knowledgeService.getClaimByToken(ownerToken)?.agentId, "ac3", "ac3: the owner's token still authorizes the profile");

      const own = await claim("ac3", { name: "Eier", email: " POST@ac3.example.test" });
      eq(own.status, 400, "ac3: the owner's own address → 400 (log in by e-mail), as before");
      ok(String(own.body?.error).includes("innlogging med e-post"), "ac3: … with the e-mail-login message");

      agent("ac3-stamped", { listed: "post@ac3-stamped.example.test", claimedAt: "2026-01-01T00:00:00.000Z", claimedVia: "admin" });
      const st = await claim("ac3-stamped", { name: "X", email: "post@ac3-stamped.example.test" });
      eq([st.status, st.body?.data?.reason], [202, "has_owner"], "ac3: claimed_at alone also counts as an owner (customer rule)");
    }

    // ══ (ac4) one code per profile per 24 h; platform cap ════════════════
    {
      agent("ac4", { listed: "post@ac4.example.test" });
      const r1 = await claim("ac4", { name: "A", email: "a@ac4.example.test" });
      eq(r1.status, 200, "ac4: first code → 200");
      const before = mails.length;
      const rowsBefore = claimsOf("ac4").length;
      const r2 = await claim("ac4", { name: "B", email: "b@another.example.test" });
      eq(r2.status, 429, "ac4: a second code request within 24 h → 429, whoever asks");
      eq([mails.length, claimsOf("ac4").length], [before, rowsBefore], "ac4: … no mail and no new row");
      eq(claimRow(r1.body.data.claimId).status, "code_sent", "ac4: the open claim is kept (not deleted, not replaced)");

      // 25 h later: a new code supersedes the old one.
      db.prepare("UPDATE agent_claims SET created_at = ?, expires_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 25 * 3_600_000).toISOString(), new Date(Date.now() - 3_600_000).toISOString(), r1.body.data.claimId);
      const r3 = await claim("ac4", { name: "C", email: "c@ac4.example.test" });
      eq(r3.status, 200, "ac4: after 24 h a new code is sent");
      eq(claimRow(r1.body.data.claimId).status, "superseded", "ac4: the earlier code gets status 'superseded' (not deleted)");
      eq(claimsOf("ac4").length, rowsBefore + 1, "ac4: all rows are kept");
      const old = await verify("ac4", r1.body.data.claimId, claimRow(r1.body.data.claimId).verification_code);
      // K3 (dev-request 2026-11-01-rfb-kravflyt-tal-eiere-fra-e-post): Norwegian, says to use the newest e-mail.
      eq([old.status, old.body?.data?.status, String(old.body?.error).startsWith("Denne koden er erstattet av en nyere")], [400, "superseded", true],
        "ac4: a superseded code no longer works");

      // Platform-wide cap: CLAIM_CODE_SENDS_PER_HOUR_MAX sends in the last hour.
      const capped = db.prepare("SELECT COUNT(*) AS n FROM agent_claims WHERE code_sent_to IS NOT NULL AND datetime(created_at) >= datetime('now', '-1 hours')").get() as { n: number };
      const fill = ks.CLAIM_CODE_SENDS_PER_HOUR_MAX - capped.n;
      agent("ac4-cap-src", { listed: "x@cap.example.test" });
      const insSend = db.prepare(
        `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, verification_code, status, source, expires_at, created_at, code_sent_to)
         VALUES (?, 'ac4-cap-src', 'Cap', 'cap@x.example.test', '111111', 'superseded', 'organic', ?, ?, 'x@cap.example.test')`,
      );
      // ISO rows from 2 h ago must not count (created_at is wrapped in datetime()).
      for (let i = 0; i < 3; i++) insSend.run(`cap-old-${i}`, new Date().toISOString(), new Date(Date.now() - 2 * 3_600_000).toISOString());
      for (let i = 0; i < fill - 1; i++) insSend.run(`cap-${i}`, new Date().toISOString(), new Date().toISOString());
      agent("ac4-cap", { listed: "post@ac4-cap.example.test" });
      agent("ac4-cap2", { listed: "post@ac4-cap2.example.test" });
      const underCap = await claim("ac4-cap", { name: "D", email: "d@ac4-cap.example.test" });
      eq(underCap.status, 200, "ac4: the last code under the hourly cap is sent (rows older than 1 h do not count)");
      const capBefore = mails.length;
      const overCap = await claim("ac4-cap2", { name: "E", email: "e@ac4-cap2.example.test" });
      eq([overCap.status, mails.length], [429, capBefore], `ac4: code send nr ${ks.CLAIM_CODE_SENDS_PER_HOUR_MAX + 1} in an hour → 429, no mail`);
      // Queue entries do not count against the cap and are still accepted.
      agent("ac4-cap-queue", { listed: null });
      eq((await claim("ac4-cap-queue", { name: "F", email: "f@x.example.test" })).status, 202, "ac4: a queue entry is still accepted at the cap (no mail)");
      // Free the hourly cap for the sections below (the sends move 2 h back —
      // still inside each profile's 24 h window).
      db.prepare("UPDATE agent_claims SET created_at = ? WHERE code_sent_to IS NOT NULL AND datetime(created_at) >= datetime('now', '-1 hours')")
        .run(new Date(Date.now() - 2 * 3_600_000).toISOString());
    }

    // ══ (ac5) 5 wrong codes; bound to :id; legacy codes ══════════════════
    {
      agent("ac5", { listed: "post@ac5.example.test" });
      agent("ac5-other", { listed: "post@ac5-other.example.test" });
      const r = await claim("ac5", { name: "A", email: "a@x.example.test" });
      const id = r.body.data.claimId;
      const code = codeIn(mails[mails.length - 1]);
      const wrong = code === "999999" ? "999998" : "999999";

      const cross = await verify("ac5-other", id, code);
      eq([cross.status, cross.body?.data?.status, String(cross.body?.error).startsWith("Vi finner ikke dette kravet")], [400, "not_found", true],
        "ac5: verify under another profile's :id → not found (K3: Norwegian)");
      eq([claimRow(id).status, claimRow(id).failed_attempts], ["code_sent", 0], "ac5: … and it does not touch the claim");

      for (let i = 1; i <= 4; i++) {
        const v = await verify("ac5", id, wrong);
        eq([v.status, v.body?.data?.status, v.body?.data?.attemptsLeft, String(v.body?.error).includes(`Du har ${5 - i} forsøk igjen`)],
          [400, "invalid_code", 5 - i, true], `ac5: wrong code ${i} → invalid, ${5 - i} tries left (K3)`);
      }
      eq([claimRow(id).status, claimRow(id).failed_attempts], ["code_sent", 4], "ac5: 4 wrong codes — still open, counted");
      const fifth = await verify("ac5", id, wrong);
      eq(fifth.status, 400, "ac5: the 5th wrong code → 400");
      ok(String(fifth.body?.error).includes("For mange feil koder"), "ac5: … says too many wrong codes");
      eq([claimRow(id).status, claimRow(id).failed_attempts], ["expired", 5], "ac5: the claim is expired after 5 wrong codes");
      const right = await verify("ac5", id, code);
      eq([right.status, right.body?.data?.claimToken], [400, undefined], "ac5: the right code no longer works");
      eq([agentRow("ac5").is_verified, agentRow("ac5").claimed_at], [0, null], "ac5: the profile is untouched");

      // A code from before the rule (no code_sent_to): refused, row unchanged.
      agent("ac5-legacy", { listed: "post@ac5-legacy.example.test" });
      db.prepare(
        `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, verification_code, status, source, expires_at, created_at)
         VALUES ('legacy-1', 'ac5-legacy', 'Gammel', 'hvem@som.helst.example.test', '123456', 'code_sent', 'organic', ?, ?)`,
      ).run(new Date(Date.now() + 6 * 86_400_000).toISOString(), new Date(Date.now() - 86_400_000).toISOString());
      const legacyBefore = JSON.stringify(claimRow("legacy-1"));
      const lv = await verify("ac5-legacy", "legacy-1", "123456");
      eq([lv.status, lv.body?.data?.claimToken], [400, undefined], "ac5: a pre-11=A code (sent to a typed address) is not accepted");
      eq(JSON.stringify(claimRow("legacy-1")), legacyBefore, "ac5: … and the legacy row is left exactly as it was");
      eq(agentRow("ac5-legacy").is_verified, 0, "ac5: … no badge");
      // A numeric code in JSON is read as its digits.
      agent("ac5-num", { listed: "post@ac5-num.example.test" });
      const rn = await claim("ac5-num", { name: "N", email: "n@x.example.test" });
      eq((await verify("ac5-num", rn.body.data.claimId, Number(codeIn(mails[mails.length - 1])))).status, 200, "ac5: a numeric code body is accepted");
    }

    // ══ (ac6) admin queue: list, approve, reject ═════════════════════════
    {
      eq((await invoke(queueH, makeReq({}))).status, 403, "ac6: GET claim-review-queue without X-Admin-Key → 403");
      eq((await invoke(approveH, makeReq({ body: { claimId: queuedNoEmail } }))).status, 403, "ac6: approve without X-Admin-Key → 403");
      eq((await invoke(rejectH, makeReq({ body: { claimId: queuedWrong } }))).status, 403, "ac6: reject without X-Admin-Key → 403");

      const q = await invoke(queueH, makeReq({ headers: admin }));
      eq(q.status, 200, "ac6: GET claim-review-queue → 200");
      const entry = (q.body?.entries ?? []).find((e: any) => e.claim_id === queuedNoEmail);
      eq(entry && [entry.agent_id, entry.agent_name, entry.claimant_name, entry.claimant_email, entry.claimant_phone, entry.reason, entry.has_owner],
        ["ac2", "Gård ac2", "Kari Gård", "kari@gmail.example.test", "91234567", "no_known_email", 0],
        "ac6: the queue shows profile, claimant name and address, reason");
      ok(!!entry?.created_at, "ac6: … and the time");
      const order = (q.body?.entries ?? []).map((e: any) => e.created_at);
      ok(order.every((t: string, i: number) => i === 0 || order[i - 1] <= t), "ac6: oldest first");
      ok((q.body?.entries ?? []).every((e: any) => claimRow(e.claim_id).status === "pending_review"), "ac6: only pending_review claims are listed");

      const before = mails.length;
      const a = await invoke(approveH, makeReq({ headers: admin, body: { claimId: queuedNoEmail } }));
      eq(a.status, 200, "ac6: approve → 200");
      eq([a.body?.isVerified, a.body?.loginLinkSent, a.body?.sentTo], [true, true, maskEmail("kari@gmail.example.test")], "ac6: badge (discovery origin), login link sent, masked");
      eq([mails.length, mails[mails.length - 1]?.to], [before + 1, "kari@gmail.example.test"], "ac6: one mail, to the approved address");
      ok(/\/api\/marketplace\/auth\/m\/[0-9a-f]{64}/.test(mails[mails.length - 1]?.text ?? ""), "ac6: the mail carries a one-time login link");
      ok(!(mails[mails.length - 1]?.text ?? "").includes("claim_"), "ac6: the claim token itself is never mailed");
      const row = claimRow(queuedNoEmail);
      eq([row.status, row.verification_method, row.claimant_email], ["verified", "manual", "kari@gmail.example.test"], "ac6: the claim is verified, manual, bound to the approved address");
      ok(!!row.claim_token && knowledgeService.getClaimByToken(row.claim_token)?.agentId === "ac2", "ac6: the token authorizes the profile");
      eq([agentRow("ac2").is_verified, agentRow("ac2").claimed_via], [1, "admin_approval"], "ac6: claimed_via = 'admin_approval'");
      ok(!!agentRow("ac2").claimed_at, "ac6: claimed_at stamped");
      eq((await invoke(approveH, makeReq({ headers: admin, body: { claimId: queuedNoEmail } }))).status, 409, "ac6: approving twice → 409");
      eq((await invoke(approveH, makeReq({ headers: admin, body: { claimId: "nope" } }))).status, 404, "ac6: unknown claim → 404");
      eq((await invoke(approveH, makeReq({ headers: admin, body: {} }))).status, 400, "ac6: missing claimId → 400");

      // Approve with an address Daniel checked himself, on a profile with an owner.
      const hasOwnerEntry = claimsOf("ac3").find((c) => c.status === "pending_review");
      const ov = await invoke(approveH, makeReq({ headers: admin, body: { claimId: hasOwnerEntry.id, email: "Bekreftet@AC3.example.test" } }));
      eq([ov.status, mails[mails.length - 1]?.to, claimRow(hasOwnerEntry.id).claimant_email], [200, "bekreftet@ac3.example.test", "bekreftet@ac3.example.test"],
        "ac6: approve with an explicit address binds and mails that address");
      ok(["annen@ac3.example.test", "kopi@ac3.example.test"].includes(hasOwnerEntry.claimant_email) && claimRow(hasOwnerEntry.id).claimant_email_typed === hasOwnerEntry.claimant_email,
        "ac6: … the address the claimant typed is kept for audit");
      eq(knowledgeService.getClaimByToken(ownerToken)?.agentId, "ac3", "ac6: the existing owner's token still works after a second owner is approved");
      ok(!mails.some((m) => m.to === "post@ac3.example.test" && m.subject.startsWith("Gratulerer")), "ac6: the existing owner gets no mail");
      eq((await invoke(approveH, makeReq({ headers: admin, body: { claimId: claimsOf("ac3").find((c) => c.status === "pending_review").id, email: "ikke en adresse" } }))).status, 400,
        "ac6: an invalid approved address → 400");

      // self_registered: approval gives the token but not the badge.
      agent("ac6-self", { listed: null, origin: "self_registered" });
      const sq = await claim("ac6-self", { name: "S", email: "s@ac6-self.example.test" });
      const sa = await invoke(approveH, makeReq({ headers: admin, body: { claimId: sq.body.data.claimId } }));
      eq([sa.status, sa.body?.isVerified, agentRow("ac6-self").is_verified], [200, false, 0], "ac6: approved self_registered claim — no badge (quarantine gate)");

      // Reject: status 'rejected', the profile and its knowledge unchanged.
      const profileBefore = JSON.stringify([db.prepare("SELECT * FROM agents WHERE id = 'ac2-wrong'").get(), db.prepare("SELECT * FROM agent_knowledge WHERE agent_id = 'ac2-wrong'").get()]);
      const rj = await invoke(rejectH, makeReq({ headers: admin, body: { claimId: queuedWrong, note: "Ikke bekreftet" } }));
      eq([rj.status, rj.body?.status], [200, "rejected"], "ac6: reject → 200");
      eq([claimRow(queuedWrong).status, claimRow(queuedWrong).notes, claimRow(queuedWrong).claim_token], ["rejected", "Ikke bekreftet", null], "ac6: status 'rejected', note kept, no token");
      eq(JSON.stringify([db.prepare("SELECT * FROM agents WHERE id = 'ac2-wrong'").get(), db.prepare("SELECT * FROM agent_knowledge WHERE agent_id = 'ac2-wrong'").get()]), profileBefore,
        "ac6: rejecting changes nothing on the profile");
      eq((await invoke(rejectH, makeReq({ headers: admin, body: { claimId: queuedWrong } }))).status, 409, "ac6: rejecting twice → 409");
      eq((await invoke(rejectH, makeReq({ headers: admin, body: { claimId: "nope" } }))).status, 404, "ac6: reject unknown claim → 404");
      ok(!(await invoke(queueH, makeReq({ headers: admin }))).body.entries.some((e: any) => [queuedNoEmail, queuedWrong].includes(e.claim_id)), "ac6: decided claims leave the queue");
    }

    // ══ (ac7) production never returns the code ══════════════════════════
    {
      eq(marketplaceMod.mayReturnDevClaimCode({ NODE_ENV: "production" } as any), false, "ac7: NODE_ENV=production → never");
      eq(marketplaceMod.mayReturnDevClaimCode({ NODE_ENV: "test", FLY_APP_NAME: "lokal" } as any), false, "ac7: on Fly → never, whatever NODE_ENV says");
      eq(marketplaceMod.mayReturnDevClaimCode({ NODE_ENV: "test", FLY_APP_NAME: "  " } as any), true, "ac7: a blank FLY_APP_NAME is not Fly");
      eq(marketplaceMod.mayReturnDevClaimCode({} as any), true, "ac7: local dev (nothing set) → the dev code is allowed");

      for (const [label, env] of [["NODE_ENV=production", { NODE_ENV: "production" }], ["FLY_APP_NAME", { FLY_APP_NAME: "lokal" }]] as const) {
        const id = agent(`ac7-${label.length}`, { listed: `post@ac7-${label.length}.example.test` });
        Object.assign(process.env, env);
        nextSend = "dry_run";
        let r: HandlerResult;
        try {
          r = await claim(id, { name: "P", email: "p@x.example.test" });
        } finally {
          if (savedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedEnv.NODE_ENV;
          if (savedEnv.FLY_APP_NAME === undefined) delete process.env.FLY_APP_NAME; else process.env.FLY_APP_NAME = savedEnv.FLY_APP_NAME;
        }
        const row = claimsOf(id)[0];
        ok(r.body?.data?.verificationCode === undefined && !JSON.stringify(r.body).includes(row.verification_code), `ac7: ${label} + DRY_RUN → the code is not in the response`);
        eq(r.status, 502, `ac7: ${label} + DRY_RUN → 502 (no code reached the farm)`);
        eq([row.status, row.code_sent_to], ["expired", null], `ac7: ${label} — the unsent claim is expired and gives its slot back`);
      }
      // Off production a DRY_RUN still returns the code (dev/test convenience).
      agent("ac7-dev", { listed: "post@ac7-dev.example.test" });
      nextSend = "dry_run";
      const dev = await claim("ac7-dev", { name: "D", email: "d@x.example.test" });
      eq([dev.status, dev.body?.data?.verificationCode], [200, claimsOf("ac7-dev")[0].verification_code], "ac7: off production a DRY_RUN returns the code");
    }

    // ══ (ac8) existing owners and e-mail login unchanged ═════════════════
    {
      agent("ac8", { listed: "post@ac8.example.test", claimedAt: "2026-05-01T08:00:00.000Z", claimedVia: "claim" });
      db.prepare(
        `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, verification_code, status, claim_token, claim_token_expires_at, source, created_at, verified_at, expires_at)
         VALUES ('legacy-owner', 'ac8', 'Gammel Eier', 'gammel.eier@gmail.example.test', '654321', 'verified', ?, ?, 'organic', '2026-05-01T07:00:00.000Z', '2026-05-01T08:00:00.000Z', '2026-05-08T07:00:00.000Z')`,
      ).run(`claim_${"a".repeat(64)}`, new Date(Date.now() + 10 * 86_400_000).toISOString());
      const ownerBefore = JSON.stringify(claimRow("legacy-owner"));
      eq((await claim("ac8", { name: "Ny", email: "ny@ac8.example.test" })).status, 202, "ac8: a new claim on an existing owner's profile queues");
      eq(JSON.stringify(claimRow("legacy-owner")), ownerBefore, "ac8: the existing owner's claim row is untouched");
      const ml = knowledgeService.createMagicLink("gammel.eier@gmail.example.test");
      eq([ml.success, ml.agentId], [true, "ac8"], "ac8: the existing owner (free-mail address, not the listed one) can still log in by e-mail");
      const vm = knowledgeService.verifyMagicLink(ml.token as string);
      ok(vm.success && !!vm.claimToken && knowledgeService.getClaimByToken(vm.claimToken)?.agentId === "ac8", "ac8: … and gets a working token");
      eq((await invoke(loginH, makeReq({ body: { token: vm.claimToken } }))).body?.data?.agentId, "ac8", "ac8: token login works");
    }

    // ══ (rev) review round 1 of PR #1141 ══════════════════════════════════
    {
      const { isSingleEmailAddress, EMAIL_ADDRESS_MAX_LENGTH, claimLimits } = ks;
      const msSince = (t0: bigint): number => Number(process.hrtime.bigint() - t0) / 1e6;

      // ── B1: the address check is linear on any input ──────────────────
      eq(EMAIL_ADDRESS_MAX_LENGTH, 254, "B1: the address cap is RFC 5321's 254 characters");
      const shapes: Array<[string, boolean]> = [
        ["a@b.no", true], ["post@gard-ac1.example.test", true], ["ø@gård.no", true],
        ["a@b", false], ["a@.b.no", false], ["a@b..no", false], ["a@b.no.", false], ["a b@c.no", false],
        ["a@b.no, c@d.no", false], ["a@b@c.no", false], ["", false],
      ];
      eq(shapes.map(([s]) => isSingleEmailAddress(s)), shapes.map(([, v]) => v),
        "B1: one-address shapes pass; lists, spaces, missing or empty domain labels do not");
      const at254 = `${"a".repeat(EMAIL_ADDRESS_MAX_LENGTH - "@gard.no".length)}@gard.no`;
      eq([at254.length, isSingleEmailAddress(at254), isSingleEmailAddress(`a${at254}`)], [254, true, false], "B1: 254 characters pass, 255 do not");
      for (const s of ["a@" + ".".repeat(1_000_000) + ",", "a@" + "b.".repeat(500_000) + ",", "a@" + ".".repeat(250) + ","]) {
        const t0 = process.hrtime.bigint();
        const shapeOk = isSingleEmailAddress(s);
        const ms = msSince(t0);
        ok(!shapeOk && ms < 100, `B1: a ${s.length}-character adversarial string is refused in < 100 ms (${ms.toFixed(1)} ms)`);
      }
      agent("rev-redos", { listed: "post@rev-redos.example.test" });
      const big = "a@" + ".".repeat(1_000_000) + ",";
      const t1 = process.hrtime.bigint();
      const rBig = await claim("rev-redos", { name: "X", email: big });
      const msBig = msSince(t1);
      eq(rBig.status, 400, "B1: POST claim with a 1 MB adversarial address → 400");
      ok(msBig < 100, `B1: … answered in < 100 ms (${msBig.toFixed(1)} ms)`);
      eq(claimsOf("rev-redos").length, 0, "B1: … and nothing is written");
      agent("rev-redos-listed", { listed: "a@" + ".".repeat(100_000) + "," });
      const t2 = process.hrtime.bigint();
      const listedLong = knowledgeService.resolveFarmContactEmail("rev-redos-listed");
      eq(listedLong, null, "B1: a long junk listed address is not a farm address");
      ok(msSince(t2) < 100, "B1: … and is refused in < 100 ms");

      // ── B2: field caps ────────────────────────────────────────────────
      agent("rev-caps", { listed: null });
      const capMail = (len: number) => `${"a".repeat(len - "@rev-caps.example.test".length)}@rev-caps.example.test`;
      const capCases: Array<[string, Record<string, unknown>]> = [
        ["a name of 201 characters", { name: "n".repeat(201), email: "a@rev-caps.example.test" }],
        ["an address of 255 characters", { name: "N", email: capMail(255) }],
        ["a phone of 41 characters", { name: "N", email: "a@rev-caps.example.test", phone: "9".repeat(41) }],
        ["a phone that is not a string", { name: "N", email: "a@rev-caps.example.test", phone: { n: 1 } }],
        ["a source of 65 characters", { name: "N", email: "a@rev-caps.example.test", source: "s".repeat(65) }],
        ["a source that is not a string", { name: "N", email: "a@rev-caps.example.test", source: ["x"] }],
      ];
      for (const [label, body] of capCases) eq((await claim("rev-caps", body)).status, 400, `B2: ${label} → 400`);
      eq(claimsOf("rev-caps").length, 0, "B2: … and none of them writes a row");
      const atCaps = await claim("rev-caps", { name: "n".repeat(200), email: capMail(254), phone: "9".repeat(40), source: "s".repeat(64) });
      eq(atCaps.status, 202, "B2: every field exactly at its cap is accepted");

      // ── B2: the admin queue's caps, not keyed on IP ───────────────────
      const lim = claimLimits();
      eq([lim.reviewOpenPerProfileMax, lim.reviewInsertsPerHourMax], [3, 20], "B2: defaults — 3 open queue entries per profile, 20 new entries per hour");
      for (let i = 2; i <= lim.reviewOpenPerProfileMax; i++) {
        eq((await claim("rev-caps", { name: `K${i}`, email: `k${i}@x.example.test` })).status, 202, `B2: open queue entry ${i} on one profile → 202`);
      }
      const rowsAtCap = claimsOf("rev-caps").length;
      const overProfile = await claim("rev-caps", { name: "K9", email: "k9@x.example.test" });
      eq([overProfile.status, claimsOf("rev-caps").length], [429, rowsAtCap], "B2: one more open entry on the profile → 429, no row");
      ok(String(overProfile.body?.error).includes("manuell godkjenning"), "B2: … saying the profile already has claims waiting");
      eq((await claim("rev-caps", { name: "K2", email: "k2@x.example.test" })).status, 202, "B2: a claimant with an open entry still gets it back at the cap");
      await invoke(rejectH, makeReq({ headers: admin, body: { claimId: claimsOf("rev-caps")[0].id } }));
      eq((await claim("rev-caps", { name: "K9", email: "k9@x.example.test" })).status, 202, "B2: a decided entry frees its place");

      const queuedLastHour = (): number => (db.prepare(
        "SELECT COUNT(*) AS n FROM agent_claims WHERE review_reason IS NOT NULL AND datetime(created_at) >= datetime('now', '-1 hours')",
      ).get() as { n: number }).n;
      const startQueued = queuedLastHour();
      ok(startQueued < lim.reviewInsertsPerHourMax - 1, `B2: setup — ${startQueued} queue entries so far this hour`);
      agent("rev-qcap-src", { listed: null });
      const insQueued = db.prepare(
        `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, review_reason, source, created_at)
         VALUES (?, 'rev-qcap-src', 'Q', ?, 'rejected', 'no_known_email', 'organic', ?)`,
      );
      // Entries from 2 h ago do not count; decided ones from this hour do.
      for (let i = 0; i < 3; i++) insQueued.run(`qcap-old-${i}`, `old${i}@q.example.test`, new Date(Date.now() - 2 * 3_600_000).toISOString());
      for (let i = 0; i < lim.reviewInsertsPerHourMax - startQueued - 1; i++) insQueued.run(`qcap-${i}`, `q${i}@q.example.test`, new Date().toISOString());
      agent("rev-qcap", { listed: null });
      agent("rev-qcap2", { listed: null });
      eq((await claim("rev-qcap", { name: "Q", email: "q@rev-qcap.example.test" })).status, 202, "B2: the last new queue entry under the hourly cap → 202");
      const overPlatform = await claim("rev-qcap2", { name: "Q", email: "q@rev-qcap2.example.test" });
      eq([overPlatform.status, claimsOf("rev-qcap2").length], [429, 0], `B2: new queue entry nr ${lim.reviewInsertsPerHourMax + 1} in an hour → 429, no row`);
      agent("rev-qcap-code", { listed: "post@rev-qcap-code.example.test" });
      eq((await claim("rev-qcap-code", { name: "C", email: "c@x.example.test" })).status, 200, "B2: the queue cap does not block a code send");
      // Free the hourly queue cap for the sections below.
      db.prepare("UPDATE agent_claims SET created_at = ? WHERE review_reason IS NOT NULL AND datetime(created_at) >= datetime('now', '-1 hours')")
        .run(new Date(Date.now() - 2 * 3_600_000).toISOString());

      const all = knowledgeService.listClaimReviewQueue();
      const two = knowledgeService.listClaimReviewQueue(2);
      eq([two.total, two.entries.map((e) => e.claim_id)], [all.total, all.entries.slice(0, 2).map((e) => e.claim_id)],
        "B2: the queue list is capped, oldest first, and still counts every waiting entry");
      eq([ks.CLAIM_REVIEW_QUEUE_LIST_MAX, all.entries.length <= ks.CLAIM_REVIEW_QUEUE_LIST_MAX], [200, true], "B2: GET lists at most 200 entries");
      const qList = await invoke(queueH, makeReq({ headers: admin }));
      eq([qList.body?.count, qList.body?.entries?.length], [all.total, all.entries.length], "B2: GET claim-review-queue: count = every waiting entry");

      // ── S2: the per-profile 429 points to the queue, not to the code ───
      agent("rev-s2", { listed: "post@rev-s2.example.test" });
      eq((await claim("rev-s2", { name: "A", email: "a@x.example.test" })).status, 200, "S2: setup — a code went to the farm");
      const again = await claim("rev-s2", { name: "B", email: "b@x.example.test" });
      const boxLabel = "E-postadressen som står på profilen er feil eller utdatert";
      eq(again.status, 429, "S2: a second code within the window → 429");
      ok(String(again.body?.error).includes(boxLabel) && !String(again.body?.error).includes("Bruk den"),
        "S2: … pointing to the 'listed address is wrong' box, not to 'use the code'");
      ok((require("fs").readFileSync(require("path").join(__dirname, "../public/selger.html"), "utf8") as string).includes(boxLabel),
        "S2: … whose label is the one selger.html shows");
      const viaBox = await claim("rev-s2", { name: "B", email: "b@x.example.test", listedEmailWrong: true });
      eq([viaBox.status, viaBox.body?.data?.reason], [202, "listed_email_wrong"], "S2: … and that box does take the claim to the queue within the window");

      // ── S3: env-set limits ────────────────────────────────────────────
      eq(claimLimits({} as NodeJS.ProcessEnv),
        { maxFailedAttempts: 5, profileWindowHours: 24, codeSendsPerHourMax: 10, reviewOpenPerProfileMax: 3, reviewInsertsPerHourMax: 20 },
        "S3: unset → today's values");
      eq(claimLimits({ CLAIM_CODE_MAX_FAILED_ATTEMPTS: "3", CLAIM_CODE_PROFILE_WINDOW_HOURS: "48", CLAIM_CODE_SENDS_PER_HOUR_MAX: "4",
        CLAIM_REVIEW_OPEN_PER_PROFILE_MAX: "2", CLAIM_REVIEW_INSERTS_PER_HOUR_MAX: "5" } as NodeJS.ProcessEnv),
        { maxFailedAttempts: 3, profileWindowHours: 48, codeSendsPerHourMax: 4, reviewOpenPerProfileMax: 2, reviewInsertsPerHourMax: 5 },
        "S3: each limit is set by the env var of its name");
      const loose = claimLimits({ CLAIM_CODE_MAX_FAILED_ATTEMPTS: "50", CLAIM_CODE_PROFILE_WINDOW_HOURS: "1" } as NodeJS.ProcessEnv);
      eq([loose.maxFailedAttempts, loose.profileWindowHours], [5, 24], "S3: env cannot loosen decision 11=A (more than 5 wrong codes, a window under 24 h)");
      const junk = claimLimits({ CLAIM_CODE_MAX_FAILED_ATTEMPTS: "0", CLAIM_CODE_SENDS_PER_HOUR_MAX: "abc", CLAIM_REVIEW_INSERTS_PER_HOUR_MAX: "-3" } as NodeJS.ProcessEnv);
      eq([junk.maxFailedAttempts, junk.codeSendsPerHourMax, junk.reviewInsertsPerHourMax], [1, 10, 20], "S3: 0 is raised to 1; junk or a sign gives the default");
      agent("rev-s3", { listed: "post@rev-s3.example.test" });
      const r3 = await claim("rev-s3", { name: "A", email: "a@x.example.test" });
      const code3 = codeIn(mails[mails.length - 1]);
      const wrong3 = code3 === "999999" ? "999998" : "999999";
      process.env.CLAIM_CODE_MAX_FAILED_ATTEMPTS = "2";
      try {
        await verify("rev-s3", r3.body.data.claimId, wrong3);
        const second = await verify("rev-s3", r3.body.data.claimId, wrong3);
        ok(String(second.body?.error).includes("For mange feil koder") && claimRow(r3.body.data.claimId).status === "expired",
          "S3: with CLAIM_CODE_MAX_FAILED_ATTEMPTS=2 the 2nd wrong code expires the claim");
      } finally {
        delete process.env.CLAIM_CODE_MAX_FAILED_ATTEMPTS;
      }

      // ── S8: the wrong-code count is raised in SQL (NULL → 1) ──────────
      agent("rev-s8", { listed: "post@rev-s8.example.test" });
      db.prepare(
        `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, verification_code, status, source, expires_at, created_at, code_sent_to, failed_attempts)
         VALUES ('s8-null', 'rev-s8', 'N', 'n@x.example.test', '123456', 'code_sent', 'organic', ?, ?, 'post@rev-s8.example.test', NULL)`,
      ).run(new Date(Date.now() + 3_600_000).toISOString(), new Date(Date.now() - 30 * 3_600_000).toISOString());
      await verify("rev-s8", "s8-null", "654321");
      eq([claimRow("s8-null").failed_attempts, claimRow("s8-null").status], [1, "code_sent"], "S8: a NULL count becomes 1 on the first wrong code");

      // ── S6: an unexpected error → generic 500; the owner's own address is a result ──
      const ownRequestClaim = Object.prototype.hasOwnProperty.call(knowledgeService, "requestClaim");
      (knowledgeService as any).requestClaim = () => { throw new Error("CHECK constraint failed: status IN ('pending')"); };
      let crash: HandlerResult;
      try {
        crash = await claim("ac1", { name: "X", email: "x@x.example.test" });
      } finally {
        if (!ownRequestClaim) delete (knowledgeService as any).requestClaim;
      }
      eq(crash.status, 500, "S6: an unexpected error in the claim request → 500");
      ok(!JSON.stringify(crash.body).includes("CHECK") && String(crash.body?.error).includes("Noe gikk galt"), "S6: … with a generic message, never the SQLite text");
      eq(knowledgeService.requestClaim("ac3", { claimantName: "Eier", claimantEmail: "post@ac3.example.test" }).kind, "already_owner",
        "S6: the owner's own address is a result (already_owner), not a thrown error");

      // ── S5 + S1: the admin notice; approval defaults to the proven farm address ──
      process.env.ADMIN_NOTIFICATION_EMAIL = "admin@plattform.example.test";
      const adminMails = () => mails.filter((m) => m.to === "admin@plattform.example.test");
      const flush = () => new Promise<void>((r) => setTimeout(r, 20));
      try {
        agent("rev-s5", { listed: null });
        const n0 = adminMails().length;
        await claim("rev-s5", { name: "Kari", email: "kari@rev-s5.example.test" });
        await flush();
        eq(adminMails().length, n0 + 1, "S5: a new queue entry notifies the admin once");
        const notice = adminMails()[adminMails().length - 1];
        ok(notice?.subject === "Eierkrav venter på godkjenning: Gård rev-s5" && notice.text.includes("kari@rev-s5.example.test")
          && notice.text.includes("profilen har ingen kjent e-postadresse") && notice.text.includes("/admin/agents/claim-review-queue"),
          "S5: … naming the profile, the claimant, the reason and the queue");
        await claim("rev-s5", { name: "Kari", email: "kari@rev-s5.example.test" });
        await flush();
        eq(adminMails().length, n0 + 1, "S5: a repeat of the same claimant does not notify again");
        agent("rev-s5-code", { listed: "post@rev-s5-code.example.test" });
        await claim("rev-s5-code", { name: "C", email: "c@x.example.test" });
        await flush();
        eq(adminMails().length, n0 + 1, "S5: a code send does not notify the admin");

        agent("rev-s1", { listed: "post@rev-s1.example.test" });
        const rc = await claim("rev-s1", { name: "Ola", email: "ola.typed@x.example.test" });
        const code1 = codeIn(mails.filter((m) => m.to === "post@rev-s1.example.test").pop());
        db.prepare("UPDATE agents SET claimed_at = ?, claimed_via = 'admin' WHERE id = 'rev-s1'").run(new Date().toISOString());
        const n1 = adminMails().length;
        const vq = await verify("rev-s1", rc.body.data.claimId, code1);
        await flush();
        eq([vq.status, vq.body?.data?.status], [409, "pending_review"], "S1: the right code on a profile that got an owner meanwhile → queued (409)");
        eq(adminMails().length, n1 + 1, "S5: the claim queued at verify time notifies the admin");
        const entry = knowledgeService.listClaimReviewQueue().entries.find((e) => e.claim_id === rc.body.data.claimId);
        eq([entry?.reason, entry?.proven_email, entry?.claimant_email], ["has_owner", "post@rev-s1.example.test", "ola.typed@x.example.test"],
          "S1: the queue shows the proven farm address next to the typed one");
        const ap = await invoke(approveH, makeReq({ headers: admin, body: { claimId: rc.body.data.claimId } }));
        const approvedRow = claimRow(rc.body.data.claimId);
        eq([ap.status, approvedRow.claimant_email, approvedRow.claimant_email_typed], [200, "post@rev-s1.example.test", "ola.typed@x.example.test"],
          "S1: approval without an address binds the claim to the proven farm address (S12: the typed one is kept)");
        eq(mails[mails.length - 1]?.to, "post@rev-s1.example.test", "S1: … and the login link goes to the farm address");
      } finally {
        delete process.env.ADMIN_NOTIFICATION_EMAIL;
      }

      // Free the hourly code cap for the sections below.
      db.prepare("UPDATE agent_claims SET created_at = ? WHERE code_sent_to IS NOT NULL AND datetime(created_at) >= datetime('now', '-1 hours')")
        .run(new Date(Date.now() - 2 * 3_600_000).toISOString());
    }

    // ══ (hard) crypto code, send failure, per-IP limiter ═════════════════
    {
      const src = require("fs").readFileSync(require.resolve("../services/knowledge-service").replace(/\.js$/, ".ts"), "utf8") as string;
      const gen = src.match(/private generateVerificationCode\(\): string \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
      ok(gen.includes("crypto.randomInt(100000, 1000000)") && !gen.includes("Math.random"), "hard: the code comes from crypto.randomInt, not Math.random");
      const codes = new Set<string>();
      for (let i = 0; i < 200; i++) codes.add((knowledgeService as any).generateVerificationCode());
      ok([...codes].every((c) => /^[1-9]\d{5}$/.test(c)) && codes.size > 190, "hard: codes are 6 digits and vary");

      agent("hard-fail", { listed: "post@hard-fail.example.test" });
      nextSend = "throw";
      const f = await claim("hard-fail", { name: "F", email: "f@x.example.test" });
      eq(f.status, 502, "hard: a failed send → 502");
      eq([claimsOf("hard-fail")[0].status, claimsOf("hard-fail")[0].code_sent_to], ["expired", null], "hard: … the claim is expired, its slot given back");
      eq((await claim("hard-fail", { name: "F", email: "f@x.example.test" })).status, 200, "hard: … so the farm can ask again at once");

      eq((await claim("ac1", { name: "X" })).status, 400, "hard: missing e-mail → 400");
      eq((await claim("ac1", { name: "X", email: "a@b.example.test, c@d.example.test" })).status, 400, "hard: more than one address → 400");
      eq((await claim("ac1", { name: { x: 1 }, email: "a@b.example.test" })).status, 400, "hard: a non-string name → 400");
      eq((await claim("finnes-ikke", { name: "X", email: "a@b.example.test" })).status, 404, "hard: unknown profile → 404");

      const { rfbClaimRequestLimiter } = require("../middleware/security") as typeof import("../middleware/security");
      const route = findRoute(marketplaceRouter, "/agents/:id/claim", "post");
      eq(route.stack[0].handle === rfbClaimRequestLimiter, true, "hard: POST /agents/:id/claim runs rfbClaimRequestLimiter first");
      // Real HTTP through node:http (not the global fetch, which other suites
      // stub while they run), and a client IP of its own (X-Forwarded-For with
      // trust proxy, as in production) so no other request shares the bucket.
      const app = express();
      app.set("trust proxy", true);
      app.post("/claim", rfbClaimRequestLimiter, (_req, res) => { res.json({ ok: true }); });
      const server = http.createServer(app);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      const clientIp = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
      const post = (port: number): Promise<{ status: number; body: any }> => new Promise((resolve, reject) => {
        const rq = http.request({ host: "127.0.0.1", port, path: "/claim", method: "POST", headers: { "X-Forwarded-For": clientIp } }, (rs) => {
          let data = "";
          rs.setEncoding("utf8");
          rs.on("data", (c) => { data += c; });
          rs.on("end", () => { let body: any; try { body = JSON.parse(data); } catch { body = data; } resolve({ status: rs.statusCode ?? 0, body }); });
        });
        rq.on("error", reject);
        rq.end();
      });
      try {
        const port = (server.address() as any).port;
        let firstBlocked = -1;
        let blockedBody: any;
        for (let i = 1; i <= 11; i++) {
          const resp = await post(port);
          if (resp.status === 429 && firstBlocked === -1) { firstBlocked = i; blockedBody = resp.body; }
        }
        eq(firstBlocked, 11, "hard: the per-IP limiter blocks the 11th claim request in an hour");
        eq(blockedBody?.success, false, "hard: … with the JSON error shape selger.html shows");
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    }

    // ══ (ui) selger.html against the real handler ═════════════════════════
    {
      const selgerScript = inlineScript("selger.html", "function escHtml");
      const API = "https://rettfrabonden.com/api/marketplace";
      const alertBox = (type: string, html: string) => `<div class="alert alert-${type}">${html}</div>`;
      const escRef = (s: string) => serializeText(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
      let sentBody: any;
      const realClaim: FetchStub = async (url: string, o?: { method?: string }) => {
        const m = url.match(/\/agents\/([^/]+)\/claim$/);
        if (!url.startsWith(API) || !m) return jsonResponse({ success: false }, 404);
        sentBody = JSON.parse((o as { body?: string } | undefined)?.body ?? "{}");
        const r = await invoke(claimH, makeReq({ params: { id: m[1]! }, body: sentBody }));
        return jsonResponse(r.body, r.status);
      };
      async function requestFromPage(agentId: string, listedWrong: boolean) {
        const page = runPage(selgerScript, realClaim, { pathname: "/selger" });
        await settle();
        page.context.startClaim({ id: agentId, name: "Gård", description: "" });
        page.el("claimName").value = "Ola";
        page.el("claimEmail").value = "ola@x.example.test";
        page.el("claimListedEmailWrong").checked = listedWrong;
        page.el("btnRequestClaim").click();
        await settle();
        return page;
      }

      agent("ui-queue", { listed: null });
      const q = await requestFromPage("ui-queue", false);
      eq(sentBody?.listedEmailWrong, false, "ui: the form sends listedEmailWrong=false when the box is not ticked");
      eq(q.el("claimAlert").innerHTML, alertBox("success", escRef("Profilen har ingen kjent e-postadresse vi kan sende koden til. Kravet er sendt til manuell godkjenning, og vi kontakter deg på e-postadressen du oppga.")),
        "ui: a queued claim shows the server's message (escaped)");
      eq(q.el("verifyAlert").innerHTML, "", "ui: … nothing in the code step");

      agent("ui-wrong", { listed: "post@ui-wrong.example.test" });
      await requestFromPage("ui-wrong", true);
      eq([sentBody?.listedEmailWrong, claimsOf("ui-wrong")[0]?.review_reason], [true, "listed_email_wrong"], "ui: the ticked box sends listedEmailWrong=true and the claim is queued");

      agent("ui-code", { listed: "post@ui-code.example.test" });
      const c = await requestFromPage("ui-code", false);
      eq(c.el("verifyAlert").innerHTML, alertBox("info", escRef(`Koden er sendt til gårdens e-post: ${maskEmail("post@ui-code.example.test")}`)),
        "ui: a sent code shows the masked farm address in the code step");
      ok(!c.el("verifyAlert").innerHTML.includes("post@ui-code.example.test"), "ui: … never the full address");

      // Self-registration's auto-claim is queued: the page says so instead
      // of telling the registrant to claim again.
      agent("ui-reg", { listed: null, origin: "self_registered" });
      const regFetch: FetchStub = async (url, o) =>
        url === `${API}/register` ? jsonResponse({ success: true, data: { id: "ui-reg", apiKey: "key-ui-reg" } }, 201) : realClaim(url, o);
      const reg = runPage(selgerScript, regFetch, { pathname: "/selger" });
      await settle();
      reg.el("regName").value = "Ny gård";
      reg.el("regDescription").value = "Grønnsaker fra gården";
      reg.el("regEmail").value = "ola@ui-reg.example.test";
      const doc = reg.context.document;
      const qsa = doc.querySelectorAll;
      doc.querySelectorAll = (sel: string) => (sel.includes("regCategories") ? [{ checked: true, value: "vegetables" }] : qsa(sel));
      reg.el("btnRegister").click();
      await settle();
      const regHtml = reg.el("regAlert").innerHTML;
      eq(claimsOf("ui-reg")[0]?.status, "pending_review", "ui: the auto-claim after self-registration is queued");
      ok(regHtml.includes("sendt til manuell godkjenning") && regHtml.includes("key-ui-reg") && !regHtml.includes("Gjør krav"),
        "ui: … and the page says it is waiting for approval (with the API key), not 'claim again'");
    }

    // ══ (mig) the status-CHECK rebuild keeps every row ═══════════════════
    {
      const old = new Database(":memory:");
      old.pragma("journal_mode = DELETE");
      initMod.__initSchemaForTesting(old);
      old.pragma("foreign_keys = OFF");
      // Back to the pre-11=A table (narrow CHECK, vertical_id added by ALTER), as in prod.
      old.exec("DROP TABLE agent_claims");
      old.exec(`
        CREATE TABLE IF NOT EXISTS agent_claims (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          claimant_name TEXT NOT NULL,
          claimant_email TEXT NOT NULL,
          claimant_phone TEXT,
          verification_method TEXT DEFAULT 'email',  -- 'email' | 'phone' | 'manual'
          verification_code TEXT,                     -- 6-digit code sent to verify
          status TEXT DEFAULT 'pending' CHECK(status IN ('pending','code_sent','verified','rejected','expired')),
          claim_token TEXT,                           -- Token for managing agent after claim
          claim_token_expires_at TEXT,                -- Token expires 30 days after issue
          notes TEXT,                                 -- Admin notes
          source TEXT DEFAULT 'organic',              -- 'organic' | 'email-apr26' | 'test' | campaign tag
          created_at TEXT DEFAULT (datetime('now')),
          verified_at TEXT,
          expires_at TEXT                             -- Claims expire after 7 days if unverified
        )`);
      old.exec("ALTER TABLE agent_claims ADD COLUMN vertical_id TEXT NOT NULL DEFAULT 'rfb'");
      old.exec("CREATE INDEX IF NOT EXISTS idx_agent_claims_agent ON agent_claims(agent_id)");
      old.exec("CREATE INDEX IF NOT EXISTS idx_agent_claims_status ON agent_claims(status)");
      old.exec("CREATE INDEX IF NOT EXISTS idx_agent_claims_email ON agent_claims(claimant_email)");
      const insOld = old.prepare(
        `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, claimant_phone, verification_code, status, claim_token, claim_token_expires_at, notes, source, created_at, verified_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insOld.run("m-owner", "gimsoya", "Eier", "eier@gmail.example.test", null, "111111", "verified", "claim_x", "2026-11-01T00:00:00.000Z", null, "organic", "2026-09-09T11:16:00.000Z", "2026-09-09T11:20:00.000Z", "2026-09-16T11:16:00.000Z");
      insOld.run("m-pending", "orphan-agent", "Venter", "v@x.example.test", "+47 1", "222222", "code_sent", null, null, "note", "email-apr26", "2026-10-16T10:00:00.000Z", null, "2026-10-23T10:00:00.000Z");
      insOld.run("m-rejected", "gimsoya", "Nei", "n@x.example.test", null, null, "rejected", null, null, "spam", "organic", "2026-08-01T00:00:00.000Z", null, null);
      const cols = "id, agent_id, claimant_name, claimant_email, claimant_phone, verification_method, verification_code, status, claim_token, claim_token_expires_at, notes, source, created_at, verified_at, expires_at, vertical_id";
      const before = JSON.stringify(old.prepare(`SELECT ${cols} FROM agent_claims ORDER BY id`).all());

      initMod.__initSchemaForTesting(old);
      const sql = (old.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_claims'").get() as { sql: string }).sql;
      ok(sql.includes("'pending_review'") && sql.includes("'superseded'"), "mig: the status CHECK now allows 'pending_review' and 'superseded'");
      eq(JSON.stringify(old.prepare(`SELECT ${cols} FROM agent_claims ORDER BY id`).all()), before, "mig: every existing row (incl. one whose agent is gone) is copied unchanged");
      const emptyCols = { code_sent_to: null, failed_attempts: 0, review_reason: null, claimant_email_typed: null };
      eq(old.prepare("SELECT code_sent_to, failed_attempts, review_reason, claimant_email_typed FROM agent_claims ORDER BY id").all(),
        [emptyCols, emptyCols, emptyCols],
        "mig: the new columns start empty on existing rows");
      const idx = (old.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_claims' AND sql IS NOT NULL ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
      eq(idx, ["idx_agent_claims_agent", "idx_agent_claims_email", "idx_agent_claims_status"], "mig: the indexes are recreated");
      eq(old.pragma("foreign_keys", { simple: true }), 0, "mig: the foreign_keys setting is restored as it was");
      let badRefused = false;
      try { old.prepare("INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status) VALUES ('bad', 'gimsoya', 'x', 'x', 'bogus')").run(); } catch { badRefused = true; }
      ok(badRefused, "mig: the CHECK still refuses an unknown status");
      old.prepare("INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status) VALUES ('q', 'gimsoya', 'x', 'x', 'pending_review')").run();
      initMod.__initSchemaForTesting(old);
      eq((old.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_claims'").get() as { sql: string }).sql, sql, "mig: a later boot does not rebuild again");
      eq((old.prepare("SELECT COUNT(*) AS n FROM agent_claims").get() as { n: number }).n, 4, "mig: … and keeps every row");
      old.close();
    }
  } catch (err) {
    failed++;
    failures.push(`rfb-claim-kjent-kontakt: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    emailSvc.isConfigured = origConfigured;
    emailSvc.transporter = origTransporter;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("./marketplace")]; } catch { /* ignore */ }
    try { delete require.cache[require.resolve("./admin-agents")]; } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";
  if (!process.env.EMAIL_FORCE_DRY_RUN) process.env.EMAIL_FORCE_DRY_RUN = "true";
  runRfbClaimKjentKontaktTests({ log: true }).then((r) => {
    console.log(`\nrfb-claim-kjent-kontakt: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
