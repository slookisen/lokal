/**
 * rfb-claim-crm-thread-c3.test.ts — eierkrav slice C3: the claim-flow mails to
 * the claimant are filed as outbound crm_messages in ONE CRM thread per claim
 * (`claim-<claimId>`), behind CLAIM_CRM_TRACKING_ENABLED (exactly "true").
 *
 *   (C3.1) flag on: the code mail → one thread, one outbound `claim_code`
 *          message, the code nowhere in the stored rows; the resend → a new
 *          message in the SAME thread; the approval → `claim_approved` in the
 *          same thread, no login link / token stored; no outreach_sent_log
 *          (max-touch-vern) row for any of them.
 *   (C3.2) crmService.getThreadDetail (GET /admin/crm/threads/:id) returns
 *          the messages with the SMTP Message-ID in raw_metadata.
 *   (C3.3) flag off → no crm_threads/crm_messages rows; a send failure →
 *          delivery_status 'failed'; a throw inside the CRM write leaves the
 *          routes' status and body as with the flag off, and writes nothing.
 *
 * Fresh in-memory SQLite with the real schema, the real marketplace and
 * admin-agents route handlers (called directly, past the per-IP limiter), a
 * stub transporter on the emailService singleton. Every global it touches
 * (getDb() singleton, env, transporter, crmService methods) is restored in
 * finally.
 *
 * Exported runRfbClaimCrmThreadC3Tests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/rfb-claim-crm-thread-c3.test.ts
 */

import Database from "better-sqlite3";

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

export async function runRfbClaimCrmThreadC3Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const ENV_KEYS = [
    "CLAIM_CRM_TRACKING_ENABLED", "APP_URL", "ADMIN_KEY", "ADMIN_NOTIFICATION_EMAIL", "NODE_ENV", "FLY_APP_NAME",
    "CLAIM_CODE_MAX_FAILED_ATTEMPTS", "CLAIM_CODE_PROFILE_WINDOW_HOURS", "CLAIM_CODE_SENDS_PER_HOUR_MAX",
    "CLAIM_REVIEW_OPEN_PER_PROFILE_MAX", "CLAIM_REVIEW_INSERTS_PER_HOUR_MAX", "CLAIM_DOMAIN_RULE_ENABLED",
    "CLAIM_AUTO_ASSESSMENT_ENABLED",
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  const ADMIN = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "rfb-claim-c3-standalone-key";

  // ── outgoing mail: a stub transporter, restored in finally ─────────────
  const emailSvc = (require("../services/email-service") as typeof import("../services/email-service")).emailService as any;
  const origConfigured = emailSvc.isConfigured;
  const origTransporter = emailSvc.transporter;
  const mails: SentMail[] = [];
  let nextSend: "ok" | "throw" = "ok";

  const crmMod = require("../services/crm-service") as typeof import("../services/crm-service");
  const crm = crmMod.crmService as any;
  const origRecordOutboundReply = crm.recordOutboundReply;

  // ── handler harness (the rfb-claim-kravflyt.test.ts pattern) ────────────
  const handlerOf = (router: any, routePath: string, method: "get" | "post"): Function => {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === routePath && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${routePath}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  };
  function makeReq(o: { params?: Record<string, string>; body?: any; headers?: Record<string, string> }): any {
    return {
      params: o.params || {}, body: o.body, query: {}, headers: o.headers || {}, ip: "127.0.0.1", lang: "no", protocol: "https",
      get(name: string) { return name.toLowerCase() === "host" ? "rettfrabonden.com" : undefined; },
    };
  }
  function invoke(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const done = (body: any) => { if (!settled) { settled = true; resolve({ status, body }); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { done(p); return res; },
        send(p: any) { done(p); return res; },
        end() { done(undefined); return res; },
        header() { return res; }, set() { return res; }, type() { return res; }, setHeader() { return res; },
      };
      try {
        const p = handler(req, res, () => done({ __next: true }));
        if (p && typeof p.catch === "function") p.catch((err: any) => done({ __error: String(err) }));
      } catch (err) {
        done({ __error: String(err) });
      }
    });
  }

  try {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.APP_URL = "https://rettfrabonden.com";
    process.env.ADMIN_KEY = ADMIN;
    emailSvc.isConfigured = true;
    emailSvc.transporter = {
      sendMail: async (m: Record<string, any>) => {
        const mode = nextSend;
        nextSend = "ok";
        if (mode === "throw") throw new Error("SMTP unavailable (test)");
        mails.push({ to: String(m.to), subject: String(m.subject), text: String(m.text ?? ""), html: String(m.html ?? "") });
        return { messageId: `<stub-${mails.length}@c3.example.test>` };
      },
    };

    initMod.__setDbForTesting(db);
    initMod.__initSchemaForTesting(db);
    try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* already loaded */ }

    delete require.cache[require.resolve("./marketplace")];
    delete require.cache[require.resolve("./admin-agents")];
    const marketplaceRouter = require("./marketplace").default as any;
    const adminAgentsRouter = require("./admin-agents").default as any;
    const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
    const tracking = require("../services/claim-crm-tracking") as typeof import("../services/claim-crm-tracking");

    const claimH = handlerOf(marketplaceRouter, "/agents/:id/claim", "post");
    const resendH = handlerOf(marketplaceRouter, "/agents/:id/claim/resend", "post");
    const approveH = handlerOf(adminAgentsRouter, "/claim-review-approve", "post");

    // ── fixtures ────────────────────────────────────────────────────────
    const insAgent = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, origin)
       VALUES (?, ?, 'En gård med egne produkter.', 'test', ?, ?, 'producer', ?, 'discovery')`,
    );
    function agent(id: string): string {
      insAgent.run(id, `Gård ${id}`, `registrert@${id}.example.test`, `https://${id}.example.test`, `key-${id}`);
      db.prepare("INSERT INTO agent_knowledge (agent_id, email) VALUES (?, ?)").run(id, `post@${id}.example.test`);
      marketplaceRegistry._agentsCache = null;
      return id;
    }
    const claim = (agentId: string) =>
      invoke(claimH, makeReq({ params: { id: agentId }, body: { name: "Ola Nordmann", email: `ola@${agentId}.example.test` } }));
    const resend = (agentId: string, claimId: string) => invoke(resendH, makeReq({ params: { id: agentId }, body: { claimId } }));
    const approve = (claimId: string) => invoke(approveH, makeReq({ headers: { "x-admin-key": ADMIN }, body: { claimId } }));
    /** Lets the resend through (it opens 10 minutes after the first send). */
    const sentElevenMinutesAgo = (claimId: string) => {
      const ms = 11 * 60_000;
      db.prepare("UPDATE agent_claims SET created_at = ?, expires_at = ? WHERE id = ?")
        .run(new Date(Date.now() - ms).toISOString(), new Date(Date.now() - ms + 24 * 3_600_000).toISOString(), claimId);
    };
    /** Puts the claim in Daniel's queue so it can be approved by hand. */
    const toReview = (claimId: string) =>
      db.prepare("UPDATE agent_claims SET status = 'pending_review', review_reason = 'listed_email_wrong' WHERE id = ?").run(claimId);
    const codeIn = (m: SentMail | undefined): string => (m?.text.match(/\b(\d{6})\b/) ?? [])[1] ?? "";
    const tokenIn = (m: SentMail | undefined): string => (m?.text.match(/token=([0-9a-f]{64})/) ?? [])[1] ?? "";
    const threadRow = (claimId: string): any => db.prepare("SELECT * FROM crm_threads WHERE id = ?").get(`claim-${claimId}`);
    const messagesOf = (claimId: string): any[] =>
      db.prepare("SELECT * FROM crm_messages WHERE thread_id = ? ORDER BY received_at, rowid").all(`claim-${claimId}`) as any[];
    const meta = (m: any): any => JSON.parse(m?.raw_metadata ?? "{}");
    const countOf = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    /** The body without the per-claim values, for comparing two runs. */
    const shape = (r: HandlerResult): unknown => JSON.parse(
      JSON.stringify(r).replace(/"(claimId|agentId|expiresAt|resendAvailableAt|retryAt)":"[^"]*"/g, '"$1":"*"').replace(/c3-[a-z0-9-]+/g, "AGENT"),
    );

    // ══ C3.1 flag on: code, resend, approval → one thread ════════════════
    process.env.CLAIM_CRM_TRACKING_ENABLED = "true";
    const A = agent("c3-on");
    const FARM = `post@${A}.example.test`;
    // Unrelated outreach_sent_log rows that must survive the per-message
    // cleanup DELETE in claim-crm-tracking (scope pinned to message_id).
    const OTHER = agent("c3-other");
    const insSent = db.prepare(
      `INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes, vertical_id)
       VALUES (?, ?, datetime('now', '-3 days'), 'email', ?, ?, 'rfb')`,
    );
    const seeded = [
      [OTHER, `post@${OTHER}.example.test`, "seed-other-cold-msg", "auto:cold_outreach_v2"],
      [OTHER, null, "seed-backfill-msg", "backfill:pr38_marketing_sends_v1"],
      [A, FARM, "seed-same-farm-cold-msg", "auto:cold_outreach_v2"],
      [A, FARM, "seed-same-farm-confirm-msg", "auto:cold_outreach_confirm_v2"],
    ] as const;
    const seededIds = seeded.map((r) => Number(insSent.run(...r).lastInsertRowid));
    const seededRows = (): unknown[] =>
      db.prepare(`SELECT id, agent_id, recipient_email, message_id, notes FROM outreach_sent_log WHERE id IN (${seededIds.join(",")}) ORDER BY id`).all();
    const seededBefore = seededRows();
    eq(seededBefore.length, seeded.length, "C3.1: setup — unrelated outreach_sent_log rows seeded");
    const r1 = await claim(A);
    eq([r1.status, r1.body?.data?.status], [200, "code_sent"], "C3.1: the claim request sends the code (200, code_sent)");
    const claimId: string = r1.body?.data?.claimId;
    const code = codeIn(mails[mails.length - 1]);
    ok(/^\d{6}$/.test(code), "C3.1: … a 6-digit code was mailed to the farm");
    const thread = threadRow(claimId);
    eq([thread?.id, thread?.vertical_id, thread?.category, thread?.message_count], [`claim-${claimId}`, "rfb", "system", 1],
      "C3.1: one thread claim-<claimId>, vertical rfb, category system, 1 message");
    let msgs = messagesOf(claimId);
    eq(msgs.map((m) => [m.direction, m.delivery_status, meta(m).kind, m.vertical_id]), [["out", "sent", "claim_code", "rfb"]],
      "C3.1: … one outbound 'sent' claim_code message");
    eq([meta(msgs[0]).source, meta(msgs[0]).claimId, meta(msgs[0]).agentId, meta(msgs[0]).smtpMessageId],
      ["claim-flow", claimId, A, `<stub-${mails.length}@c3.example.test>`], "C3.1: … raw_metadata source/claimId/agentId/smtpMessageId");
    eq(JSON.parse(msgs[0].to_emails), [FARM], "C3.1: … to the farm address the code went to");
    const contact = db.prepare("SELECT email, vertical_id FROM crm_contacts WHERE id = ?").get(thread.contact_id) as any;
    eq([contact?.email, contact?.vertical_id], [FARM, "rfb"], "C3.1: … contact resolved for that address on rfb");
    ok(!JSON.stringify([thread, msgs]).includes(code), "C3.1: the code is nowhere in the stored thread or message");
    eq(tracking.CODE_MASK, "••••••", "C3.1: … the code mask is the literal non-empty mask");
    ok([msgs[0].body_text, msgs[0].body_html].every((b: string) => b.includes(tracking.CODE_MASK)), "C3.1: … the bodies carry the mask instead");
    eq(msgs[0].subject, mails[mails.length - 1].subject, "C3.1: … the stored subject is the sent subject");

    sentElevenMinutesAgo(claimId);
    const r2 = await resend(A, claimId);
    eq([r2.status, r2.body?.data?.status], [200, "code_sent"], "C3.1: the resend sends the code again");
    msgs = messagesOf(claimId);
    eq(msgs.map((m) => meta(m).kind), ["claim_code", "claim_code"], "C3.1: … a second claim_code message in the SAME thread");
    eq((db.prepare("SELECT COUNT(*) AS n FROM crm_threads WHERE id LIKE 'claim-%'").get() as any).n, 1, "C3.1: … still one claim thread");
    eq(threadRow(claimId).message_count, 2, "C3.1: … message_count recomputed to 2");

    toReview(claimId);
    const r3 = await approve(claimId);
    eq([r3.status, r3.body?.success, r3.body?.loginLinkSent], [200, true, true], "C3.1: the approval mails the login link");
    const token = tokenIn(mails[mails.length - 1]);
    ok(token.length === 64, "C3.1: … the sent mail carries a one-time token");
    msgs = messagesOf(claimId);
    eq(msgs.map((m) => meta(m).kind), ["claim_code", "claim_code", "claim_approved"], "C3.1: … claim_approved lands in the same thread");
    const appr = msgs[2];
    ok(!JSON.stringify(appr).includes(token) && !/magic-link-verify|token=/.test(JSON.stringify(appr)),
      "C3.1: … no token and no login link in the stored approval message");
    eq(tracking.LOGIN_LINK_PLACEHOLDER, "[innloggingslenke]", "C3.1: … the login-link placeholder is the literal non-empty placeholder");
    ok(appr.body_text.includes(tracking.LOGIN_LINK_PLACEHOLDER) && appr.body_html.includes(tracking.LOGIN_LINK_PLACEHOLDER),
      "C3.1: … the link is replaced by [innloggingslenke]");
    ok(!JSON.stringify(msgs).includes(code), "C3.1: the code is still nowhere in the thread");
    eq(msgs.length, 3, "C3.1: … three claim message ids to check");
    eq((db.prepare(`SELECT COUNT(*) AS n FROM outreach_sent_log WHERE (recipient_email = ? AND id NOT IN (${seededIds.join(",")}))
        OR message_id IN (SELECT id FROM crm_messages WHERE thread_id = ?)`)
      .get(FARM, `claim-${claimId}`) as any).n, 0, "C3.1: no outreach_sent_log (max-touch-vern) row for the claim mails");
    eq(seededRows(), seededBefore,
      "C3.1: … the cleanup is scoped to the claim's own message_id — unrelated cold-outreach, backfill and same-farm rows all survive");

    // ══ C3.2 getThreadDetail (GET /admin/crm/threads/:id) ════════════════
    {
      const detail = crm.getThreadDetail(`claim-${claimId}`);
      eq(detail?.thread?.contact_email, FARM, "C3.2: getThreadDetail returns the claim thread with its contact");
      eq((detail?.messages ?? []).map((m: any) => meta(m).smtpMessageId),
        msgs.map((m) => meta(m).smtpMessageId), "C3.2: … the three messages with their Message-IDs");
      ok((detail?.messages ?? []).every((m: any) => /^<stub-\d+@c3\.example\.test>$/.test(meta(m).smtpMessageId)),
        "C3.2: … each Message-ID is the one sendEmail returned");
    }

    // ══ C3.3 send failure → delivery_status failed ═══════════════════════
    {
      const F = agent("c3-fail");
      nextSend = "throw";
      const r = await claim(F);
      eq(r.status, 502, "C3.3: a failed code send still answers 502 as before");
      const row = db.prepare("SELECT * FROM agent_claims WHERE agent_id = ?").get(F) as any;
      const m = messagesOf(row.id);
      eq(m.map((x) => [x.delivery_status, x.sent_at, meta(x).smtpMessageId, meta(x).kind]), [["failed", null, null, "claim_code"]],
        "C3.3: … recorded as delivery_status 'failed', no sent_at, no Message-ID");
    }

    // ══ C3.3 a throw inside the CRM write changes nothing ════════════════
    const runFlow = async (id: string) => {
      const AG = agent(id);
      const c = await claim(AG);
      const cid: string = c.body?.data?.claimId;
      sentElevenMinutesAgo(cid);
      const rs = await resend(AG, cid);
      toReview(cid);
      const ap = await approve(cid);
      return { cid, results: [c, rs, ap] };
    };
    process.env.CLAIM_CRM_TRACKING_ENABLED = "false";
    const threadsBefore = countOf("crm_threads");
    const messagesBefore = countOf("crm_messages");
    const contactsBefore = countOf("crm_contacts");
    const mailsBefore = mails.length;
    const off = await runFlow("c3-off");
    eq([countOf("crm_threads"), countOf("crm_messages"), countOf("crm_contacts")], [threadsBefore, messagesBefore, contactsBefore],
      "C3.3: flag off ('false') → no crm_threads / crm_messages / crm_contacts rows");
    eq(mails.length - mailsBefore, 3, "C3.3: … the three mails are still sent");
    delete process.env.CLAIM_CRM_TRACKING_ENABLED;
    ok(!tracking.isClaimCrmTrackingEnabled(), "C3.3: unset → off");
    process.env.CLAIM_CRM_TRACKING_ENABLED = "TRUE";
    ok(!tracking.isClaimCrmTrackingEnabled(), "C3.3: only exactly \"true\" turns it on");

    process.env.CLAIM_CRM_TRACKING_ENABLED = "true";
    crm.recordOutboundReply = () => { throw new Error("CRM write failed (test)"); };
    const boom = await runFlow("c3-boom");
    crm.recordOutboundReply = origRecordOutboundReply;
    eq(boom.results.map(shape), off.results.map(shape), "C3.3: a throw in the CRM write → same status and body as flag off (request, resend, approval)");
    eq(boom.results.map((r) => r.status), [200, 200, 200], "C3.3: … all three succeed");
    eq([threadRow(boom.cid), messagesOf(boom.cid).length], [undefined, 0], "C3.3: … and nothing is left half-written (thread insert rolled back)");
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err));
  } finally {
    crm.recordOutboundReply = origRecordOutboundReply;
    emailSvc.isConfigured = origConfigured;
    emailSvc.transporter = origTransporter;
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* already closed */ }
    delete require.cache[require.resolve("./marketplace")];
    delete require.cache[require.resolve("./admin-agents")];
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";
  runRfbClaimCrmThreadC3Tests({ log: true }).then((r) => {
    console.log(`\nrfb-claim-crm-thread-c3: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
