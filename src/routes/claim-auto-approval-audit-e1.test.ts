/**
 * claim-auto-approval-audit-e1.test.ts — eierkrav slice E1: read-only audit
 * of automatic owner-claim approvals,
 * GET /api/marketplace/admin/claims/auto-approval-audit.
 *
 *   E1.1  an auto-approved claim with assessment, CRM thread, claim_approved
 *         message and delivery within 1 h → ok; each missing piece → its
 *         verdict (first missing in order); delivery after 61 min →
 *         not_delivered_1h; approved 10 min ago, no delivery → pending;
 *         manual approvals and claims outside the window are left out;
 *         revoked claims are in, with status and revoked_at
 *   E1.2  since_hours 0 / 721 / abc / 1.5 → 400; wrong or missing key → 403;
 *         no key configured → 503; the body holds no "@"; nothing is written
 *
 * Pins getDb() to its own in-memory DB and swaps ADMIN_KEY /
 * ANALYTICS_ADMIN_KEY and the claim flags (restored in finally).
 *
 * Exported runClaimAutoApprovalAuditE1Tests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/claim-auto-approval-audit-e1.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runClaimAutoApprovalAuditE1Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const ENV_KEYS = ["ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "CLAIM_AUTO_APPROVE_ENABLED", "CLAIM_AUTO_ASSESSMENT_ENABLED",
    "CLAIM_CRM_TRACKING_ENABLED"] as const;
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { prevEnv[k] = process.env[k]; delete process.env[k]; }
  const KEY = "e1-audit-admin-key";

  const handlerOf = (router: any, path: string): Function => {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.get);
    if (!layer) throw new Error(`route not found: GET ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  };
  function invoke(handler: Function, query: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
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
      const req: any = { params: {}, query, headers, ip: "203.0.113.9", get() { return undefined; } };
      try {
        const p = handler(req, res, () => settle({ __next: true }));
        if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
      } catch (err) {
        settle({ __error: String(err) });
      }
    });
  }

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);

    const audit = require("../services/claim-auto-approval-audit") as typeof import("../services/claim-auto-approval-audit");

    // ── pure helper (fixed now) ──────────────────────────────────────────
    {
      const now = new Date("2026-11-09T12:00:00.000Z");
      const full = {
        verifiedAt: "2026-11-09T10:00:00.000Z", assessmentPresent: true, threadExists: true,
        approvedMessageId: "m1", deliveredAt: "2026-11-09T10:05:00.000Z",
      };
      const v = (o: Partial<typeof full>) => audit.computeClaimAuditVerdict({ ...full, ...o }, now);
      eq(v({}), "ok", "E1.1 helper: all present, delivered after 5 min → ok");
      eq(v({ deliveredAt: "2026-11-09T11:00:00.000Z" }), "ok", "E1.1 helper: delivered at exactly 60 min → ok");
      eq(v({ deliveredAt: "2026-11-09T11:01:00.000Z" }), "not_delivered_1h", "E1.1 helper: delivered after 61 min → not_delivered_1h");
      eq(v({ deliveredAt: null }), "not_delivered_1h", "E1.1 helper: 2 h, no delivery → not_delivered_1h");
      eq(v({ verifiedAt: "2026-11-09T11:50:00.000Z", deliveredAt: null }), "pending", "E1.1 helper: 10 min, no delivery → pending");
      eq(v({ verifiedAt: "2026-11-09 11:50:00", deliveredAt: null }), "pending", "E1.1 helper: SQLite-format verified_at is read as UTC");
      eq(v({ assessmentPresent: false, threadExists: false, approvedMessageId: null, deliveredAt: null }), "missing_assessment",
        "E1.1 helper: assessment missing is reported first");
      eq(v({ threadExists: false, approvedMessageId: null }), "missing_crm_thread", "E1.1 helper: no thread → missing_crm_thread");
      eq(v({ approvedMessageId: null, deliveredAt: null }), "missing_approved_message", "E1.1 helper: no message → missing_approved_message");
      eq(v({ verifiedAt: "2026-11-09T11:50:00.000Z", approvedMessageId: null, deliveredAt: null }), "missing_approved_message",
        "E1.1 helper: a recent approval without message is not pending");
      eq(["1", "48", "720"].map(audit.parseAuditSinceHours), [1, 48, 720], "E1.2 helper: 1, 48, 720 accepted");
      eq(audit.parseAuditSinceHours(undefined), 48, "E1.2 helper: absent → 48");
      eq(["0", "721", "abc", "1.5", "", "-1", " 5", "1e2"].map(audit.parseAuditSinceHours), [null, null, null, null, null, null, null, null],
        "E1.2 helper: 0, 721, abc, 1.5, empty, -1, padded, exponent → null");
      eq(audit.parseAuditSinceHours(["5", "6"]), null, "E1.2 helper: repeated parameter → null");
    }

    // ── fixtures ─────────────────────────────────────────────────────────
    const nowMs = Date.now();
    const ago = (min: number) => new Date(nowMs - min * 60_000).toISOString();
    const after = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60_000).toISOString();
    const GREEN = JSON.stringify({ result: "green", anchors: ["A1"], supports: ["S1"], red_flags: [], unavailable_sources: [],
      possible_duplicate: false, signals: [], rule_version: 1, org_nr: null });

    let seq = 0;
    db.prepare(`INSERT INTO crm_contacts (id, type, email, name) VALUES ('e1-contact', 'producer', 'kari@gard-e1.no', 'Kari Nordmann')`).run();
    function fixture(o: {
      id: string; method?: string; verifiedMin: number; assessment?: string | null; thread?: boolean;
      message?: "approved" | "code_only" | null; deliveredAfterMin?: number | null; status?: string; revokedAt?: string | null;
    }): void {
      seq++;
      const agentId = `e1-agent-${seq}`;
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, origin, is_vetted)
                  VALUES (?, ?, 'En gård.', 'test', ?, ?, 'producer', ?, 'discovery', 1)`)
        .run(agentId, `Gård E1 ${seq}`, `post@${agentId}.example.test`, `https://${agentId}.example.test`, `key-${agentId}`);
      const verifiedAt = ago(o.verifiedMin);
      db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, claimant_phone, verification_method, status,
                    verified_at, revoked_at, claim_assessment)
                  VALUES (?, ?, 'Kari Nordmann', 'kari@gard-e1.no', '+4799999999', ?, ?, ?, ?, ?)`)
        .run(o.id, agentId, o.method ?? "auto_assessment", o.status ?? "verified", verifiedAt, o.revokedAt ?? null,
          o.assessment === undefined ? GREEN : o.assessment);
      if (o.thread === false) return;
      const threadId = `claim-${o.id}`;
      db.prepare(`INSERT INTO crm_threads (id, contact_id, subject, category, severity, assigned_to, status, vertical_id)
                  VALUES (?, 'e1-contact', 'Profilen til Gård E1 er nå din', 'system', 'normal', 'unassigned', 'done', 'rfb')`).run(threadId);
      const msg = (id: string, kind: string, sentAt: string) => db.prepare(`
        INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, subject, body_text, sent_at, raw_metadata, delivery_status, vertical_id)
        VALUES (?, ?, 'out', 'post@rettfrabonden.com', '["kari@gard-e1.no"]', 'Emne kari@gard-e1.no', 'Hei Kari', ?, ?, 'sent', 'rfb')`)
        .run(id, threadId, sentAt, JSON.stringify({ source: "claim-flow", claimId: o.id, kind }));
      msg(`${o.id}-code`, "claim_code", ago(o.verifiedMin + 30));
      const message = o.message === undefined ? "approved" : o.message;
      if (message !== "approved") return;
      const msgId = `${o.id}-approved`;
      msg(msgId, "claim_approved", verifiedAt);
      if (o.deliveredAfterMin === null || o.deliveredAfterMin === undefined) return;
      db.prepare(`INSERT INTO email_delivery_events (svix_id, resend_email_id, email, delivered_at, crm_message_id) VALUES (?, ?, ?, ?, ?)`)
        .run(`svix-${o.id}`, `re-${o.id}`, "kari@gard-e1.no", after(verifiedAt, o.deliveredAfterMin), msgId);
    }

    fixture({ id: "c-ok", verifiedMin: 120, deliveredAfterMin: 5 });
    fixture({ id: "c-no-assessment", verifiedMin: 130, assessment: null, deliveredAfterMin: 5 });
    fixture({ id: "c-bad-assessment", verifiedMin: 135, assessment: "not json", deliveredAfterMin: 5 });
    fixture({ id: "c-no-thread", verifiedMin: 140, thread: false });
    fixture({ id: "c-no-message", verifiedMin: 150, message: "code_only" });
    fixture({ id: "c-late", verifiedMin: 160, deliveredAfterMin: 61 });
    fixture({ id: "c-undelivered", verifiedMin: 170, deliveredAfterMin: null });
    fixture({ id: "c-pending", verifiedMin: 10, deliveredAfterMin: null });
    fixture({ id: "c-revoked", verifiedMin: 180, deliveredAfterMin: 2, status: "revoked", revokedAt: ago(100) });
    fixture({ id: "c-manual", method: "manual", verifiedMin: 60, deliveredAfterMin: 5 });
    fixture({ id: "c-old", verifiedMin: 49 * 60, deliveredAfterMin: 5 });

    delete require.cache[require.resolve("./marketplace")];
    const marketplaceRouter = require("./marketplace").default as any;
    const h = handlerOf(marketplaceRouter, "/admin/claims/auto-approval-audit");

    // ── E1.2: guard and validation ──────────────────────────────────────
    eq((await invoke(h, {}, { "x-admin-key": KEY })).status, 503, "E1.2: no admin key configured → 503");
    process.env.ADMIN_KEY = KEY;
    eq((await invoke(h, {}, { "x-admin-key": "wrong" })).status, 403, "E1.2: wrong key → 403");
    eq((await invoke(h, {})).status, 403, "E1.2: missing key → 403");
    eq((await invoke(h, { since_hours: "0" }, { "x-admin-key": "wrong" })).status, 403, "E1.2: wrong key is checked before since_hours");
    for (const bad of ["0", "721", "abc", "1.5"]) {
      eq((await invoke(h, { since_hours: bad }, { "x-admin-key": KEY })).status, 400, `E1.2: since_hours=${bad} → 400`);
    }

    // ── E1.1: verdicts ──────────────────────────────────────────────────
    const changesBefore = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const r = await invoke(h, {}, { "x-admin-key": KEY });
    eq(r.status, 200, "E1.1: default window → 200");
    const body = r.body;
    eq(body.since_hours, 48, "E1.1: since_hours defaults to 48");
    eq(body.flags, { auto_approve_enabled: false, crm_tracking_enabled: false }, "E1.1: flags off by default");
    const byId = Object.fromEntries((body.claims as any[]).map((c) => [c.claim_id, c]));
    eq(Object.fromEntries((body.claims as any[]).map((c) => [c.claim_id, c.verdict])), {
      "c-pending": "pending",
      "c-ok": "ok",
      "c-no-assessment": "missing_assessment",
      "c-bad-assessment": "missing_assessment",
      "c-no-thread": "missing_crm_thread",
      "c-no-message": "missing_approved_message",
      "c-late": "not_delivered_1h",
      "c-undelivered": "not_delivered_1h",
      "c-revoked": "ok",
    }, "E1.1: verdict per claim; manual and out-of-window claims excluded");
    eq((body.claims as any[]).map((c) => c.claim_id),
      ["c-pending", "c-ok", "c-no-assessment", "c-bad-assessment", "c-no-thread", "c-no-message", "c-late", "c-undelivered", "c-revoked"],
      "E1.1: newest first");
    eq(body.summary, { ok: 2, pending: 1, missing_assessment: 2, missing_crm_thread: 1, missing_approved_message: 1, not_delivered_1h: 2, total: 9 },
      "E1.1: summary counts per verdict + total");
    eq(body.truncated, false, "E1.1: not truncated");
    const okc = byId["c-ok"];
    eq([okc.assessment, okc.crm, okc.delivery.within_1h, okc.status, okc.revoked_at],
      [{ present: true, result: "green" },
        { thread_id: "claim-c-ok", thread_exists: true, approved_message_id: "c-ok-approved", approved_delivery_status: "sent" },
        true, "verified", null],
      "E1.1: ok claim — assessment, crm and delivery fields");
    ok(typeof okc.delivery.delivered_at === "string", "E1.1: ok claim — delivered_at present");
    eq([byId["c-late"].delivery.within_1h, typeof byId["c-late"].delivery.delivered_at], [false, "string"], "E1.1: late delivery — within_1h false");
    eq(byId["c-no-message"].crm.approved_message_id, null, "E1.1: a claim_code message is not the approved message");
    eq(byId["c-no-thread"].crm, { thread_id: "claim-c-no-thread", thread_exists: false, approved_message_id: null, approved_delivery_status: null },
      "E1.1: missing thread — crm fields");
    eq([byId["c-revoked"].status, typeof byId["c-revoked"].revoked_at], ["revoked", "string"], "E1.1: revoked claim included with status and revoked_at");
    eq(byId["c-bad-assessment"].assessment, { present: false, result: null }, "E1.1: unreadable assessment → present false");

    // ── E1.2: no personal data, no writes ────────────────────────────────
    const text = JSON.stringify(body);
    ok(!text.includes("@"), "E1.2: response body contains no @");
    ok(!/Kari|Nordmann|\+4799999999|Emne|Hei Kari|Gård E1/.test(text), "E1.2: no name, phone, subject or body in the response");
    eq((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n, changesBefore, "E1.2: the audit writes nothing");

    // ── window and flags ─────────────────────────────────────────────────
    const wide = await invoke(h, { since_hours: "720" }, { "x-admin-key": KEY });
    eq([wide.status, wide.body.summary.total, (wide.body.claims as any[]).some((c) => c.claim_id === "c-old")], [200, 10, true],
      "E1.1: since_hours=720 includes the 49 h old claim");
    const narrow = await invoke(h, { since_hours: "1" }, { "x-admin-key": KEY });
    eq((narrow.body.claims as any[]).map((c) => c.claim_id), ["c-pending"], "E1.1: since_hours=1 → only the 10 min old claim");
    process.env.CLAIM_AUTO_APPROVE_ENABLED = "true";
    process.env.CLAIM_AUTO_ASSESSMENT_ENABLED = "true";
    process.env.CLAIM_CRM_TRACKING_ENABLED = "true";
    eq((await invoke(h, { key: KEY })).body.flags, { auto_approve_enabled: true, crm_tracking_enabled: true },
      "E1.1: flags reflect the env (key via ?key= as on /admin/claims)");

    // ── cap at 200 ───────────────────────────────────────────────────────
    const insertMany = db.transaction(() => {
      for (let i = 0; i < 200; i++) fixture({ id: `c-bulk-${i}`, verifiedMin: 200 + i, thread: false });
    });
    insertMany();
    const big = await invoke(h, {}, { "x-admin-key": KEY });
    eq([(big.body.claims as any[]).length, big.body.truncated, big.body.summary.total, big.body.summary.missing_crm_thread],
      [200, true, 209, 201], "E1.1: claims capped at 200, truncated true, summary counts all");
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runClaimAutoApprovalAuditE1Tests({ log: true }).then((s) => {
    console.log(`\nclaim-auto-approval-audit-e1: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed) for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0);
  });
}
