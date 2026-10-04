/**
 * resend-webhook.test.ts — POST /webhooks/resend (owner decision 2026-09-29
 * «Blacklist bounces», narrowed by «1B»): Svix-signed Resend events →
 * email_bounces ONLY (no agent_blocklist row), the two RFB send-side
 * consumers that must then suppress the address (computeOutreachCandidates +
 * executeCompose's bounce guard), and the non-outreach paths that must NOT
 * (ordering / canOrder, order notifications, registration).
 *
 * Runs the REAL route over loopback HTTP behind the same express.json({verify})
 * raw-body capture index.ts installs, so the signature is checked over the
 * exact bytes on the wire (not a re-serialization). Secret is generated
 * locally per run; nothing leaves 127.0.0.1.
 *
 *   w1  secret unset → 503, nothing written
 *   w2  valid hard bounce → email_bounces 'hard', NO blocklist row;
 *       gate drops the agent it previously returned; compose (claude
 *       resend_send) refuses 409 recipient_bounced with no transport call;
 *       daniel+force overrides; an unrelated address still sends;
 *       «1B»: isBlocked({email}) stays false, findOffers can_order stays
 *       true, the order-notification recipient stays eligible, and both
 *       register blocklist shapes (/register, /admin/register) pass
 *   w3  complaint → same with bounce_type 'complaint', NO blocklist row
 *   w4  soft (Transient / missing type) → ledger only, no bounce, no blocklist
 *   w5  bad / missing / wrong-secret / tampered signature → 401, nothing written
 *   w6  stale and far-future timestamps → 401
 *   w7  replayed svix-id → 200 duplicate, no new rows; a second svix-id for
 *       the same email_id → no duplicate bounce/blocklist rows
 *   w8  unrelated event type → 200 no-op (nothing written)
 *   w9  multi-recipient → ambiguous, nothing recorded; display-name +
 *       upper-case recipient normalized
 *   w10 secret rotation (several v1 sigs, one valid) → accepted
 *   w11 non-JSON Content-Type → 400; oversize body → 413; both write nothing
 *   w12 send attribution (2026-10-04): agent_id_at_send / batch_id /
 *       lane_at_send from the RFB daily ledger (run id), the Opplevagent
 *       sent log (+ covering daily-run id), or outreach_sent_log (compose);
 *       the latest send at/before Resend's acceptance; NULLs outside the
 *       lookback; a failing lookup still records the bounce
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/resend-webhook.test.ts
 *   2. Wired into the gate: tests/test.ts (runSerial — pins the DB singleton).
 */

import crypto from "crypto";
import http from "http";
import type { AddressInfo } from "net";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runResendWebhookTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const out = console.log.bind(console); // console.log is muted while the route logs
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) out(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) out("  " + msg);
    }
  }

  try {
    // compose resolves the platform identity from vertical config (same as crm-compose-extraction-parity).
    (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
  } catch {
    // already loaded
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const express = require("express");
  const initMod = require("../database/init") as typeof import("../database/init");
  const svc = require("../services/resend-webhook") as typeof import("../services/resend-webhook");
  const routeMod = require("./resend-webhook") as typeof import("./resend-webhook");
  const aoc = require("./admin-outreach-candidates") as typeof import("./admin-outreach-candidates");
  const crm = require("./crm") as typeof import("./crm");
  const { isBlocked } = require("../services/blocklist-service") as typeof import("../services/blocklist-service");
  const { findOffers } = require("../services/catalog-offers") as typeof import("../services/catalog-offers");
  const { resolveOrderNotificationRecipient } = require("../services/order-notify-service") as typeof import("../services/order-notify-service");

  const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");

  const restoreDb = initMod.__pinInMemoryDbForTesting();
  const prevPaused = process.env.OUTREACH_PAUSED;
  delete process.env.OUTREACH_PAUSED;
  // w12 opens an in-memory experiences db for the Opplevagent attribution source.
  const prevEnableExperiences = process.env.ENABLE_EXPERIENCES;
  const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
  const origLog = console.log;
  const origWarn = console.warn;

  // Locally generated test secret — same shape as Resend's (whsec_ + base64(24 bytes)).
  const keyBytes = crypto.randomBytes(24);
  const SECRET = "whsec_" + keyBytes.toString("base64");
  const OTHER_KEY = crypto.randomBytes(24);

  const app = express();
  // Identical raw-body capture to index.ts's global parser.
  app.use(express.json({ limit: "1mb", verify: (req: any, _res: any, buf: Buffer) => { req.rawBody = buf; } }));
  app.set("resendWebhookSecret", SECRET);
  app.use("/", routeMod.default);
  const server: http.Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;

  async function post(body: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
    const r = await fetch(`http://127.0.0.1:${port}/webhooks/resend`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
    const text = await r.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
    return { status: r.status, body: parsed };
  }
  const nowS = () => Math.floor(Date.now() / 1000);
  function signed(body: string, id: string, opts2: { ts?: number; key?: Buffer } = {}): Record<string, string> {
    const ts = String(opts2.ts ?? nowS());
    return {
      "svix-id": id,
      "svix-timestamp": ts,
      "svix-signature": "v1," + svc.computeSvixSignature(opts2.key ?? keyBytes, id, ts, body),
    };
  }
  function bounced(to: unknown, bounce: any, emailId = "em_" + crypto.randomBytes(4).toString("hex")): string {
    return JSON.stringify({
      type: "email.bounced",
      created_at: "2026-09-29T10:00:00.000Z",
      data: { email_id: emailId, from: "RFB <kontakt@example.test>", to, subject: "Hei fra RFB", created_at: "2026-09-29T09:59:00.000Z", bounce },
    });
  }
  function complained(to: unknown, emailId = "em_c1"): string {
    return JSON.stringify({ type: "email.complained", created_at: "2026-09-29T11:00:00.000Z", data: { email_id: emailId, to, subject: "x" } });
  }
  const db = () => initMod.getDb();
  const counts = () => ({
    bounces: (db().prepare("SELECT COUNT(*) c FROM email_bounces").get() as any).c,
    blocklist: (db().prepare("SELECT COUNT(*) c FROM agent_blocklist").get() as any).c,
    ledger: (db().prepare("SELECT COUNT(*) c FROM resend_webhook_events").get() as any).c,
  });
  function seedAgent(id: string, name: string, email: string): void {
    db().prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
       VALUES (?, ?, 'test producer', 'test', ?, 'https://rw-farm.no', 'producer', ?)`,
    ).run(id, name, email, `key-${id}`);
    db().prepare(
      `INSERT INTO agent_knowledge
         (agent_id, email, about, field_provenance, verification_status, enrichment_status, url_last_status, url_last_probed)
       VALUES (?, ?, 'Vi driver en liten gård med sau og honning, og selger kjøtt og honning direkte fra gården hele året.', '{}', 'verified', 'rich', 200, datetime('now'))`,
    ).run(id, email);
  }
  const gateIds = () =>
    aoc.computeOutreachCandidates(db(), { mode: "first", cooldownDays: 60, limit: 500 }).candidates.map((c: any) => c.agent_id).sort();
  let transportCalls: string[] = [];
  const fakeSend = async (o: any) => { transportCalls.push(o.to); return { success: true, messageId: "fake-" + transportCalls.length } as any; };
  async function compose(to: string, who: "claude" | "daniel" = "claude", force?: boolean) {
    return await crm.executeCompose(
      { to, subject: "Hei", bodyText: "Tekst", intent: "resend_send", createdBy: who, vertical: "rfb", category: "marketing", ...(force ? { force: true } : {}) },
      { sendRaw: fakeSend },
    );
  }

  try {
    console.log = () => {};
    console.warn = () => {};

    seedAgent("rw-hard", "Hard Gård", "hard@rw-farm.no");
    seedAgent("rw-comp", "Klage Gård", "complain@rw-farm.no");
    seedAgent("rw-soft", "Myk Gård", "soft@rw-farm.no");
    seedAgent("rw-ok", "Grei Gård", "ok@rw-farm.no");
    assertEq(gateIds(), ["rw-comp", "rw-hard", "rw-ok", "rw-soft"], "w0: all four agents are gate candidates before any event");

    // ── w1 secret unset ────────────────────────────────────────────────
    {
      app.set("resendWebhookSecret", "");
      const before = counts();
      const body = bounced(["hard@rw-farm.no"], { type: "Permanent", subType: "General", message: "550 no such user" });
      const r = await post(body, signed(body, "msg_w1"));
      assertEq(r.status, 503, "w1: no secret → 503");
      assertEq(counts(), before, "w1: nothing written");
      app.set("resendWebhookSecret", "whsec_!!not-base64!!");
      const r2 = await post(body, signed(body, "msg_w1b"));
      assertEq(r2.status, 503, "w1: unusable secret → 503 (fail closed)");
      app.set("resendWebhookSecret", SECRET);
    }

    // ── w2 hard bounce ─────────────────────────────────────────────────
    {
      const body = bounced(["hard@rw-farm.no"], { type: "Permanent", subType: "General", message: "550 5.1.1 user unknown" }, "em_hard1");
      const r = await post(body, signed(body, "msg_w2"));
      assertEq([r.status, r.body.outcome], [200, "hard_bounce_recorded"], "w2: 200 hard_bounce_recorded");
      const b = db().prepare("SELECT email, bounce_type, resend_email_id, bounced_at, reason FROM email_bounces WHERE email = 'hard@rw-farm.no'").all() as any[];
      assertEq(b.map((x) => [x.email, x.bounce_type, x.resend_email_id, x.bounced_at]), [["hard@rw-farm.no", "hard", "em_hard1", "2026-09-29T10:00:00.000Z"]], "w2: email_bounces row (hard)");
      assertEq(String(b[0]?.reason).startsWith("resend-webhook: Permanent/General — 550 5.1.1"), true, "w2: reason carries source + diagnostic");
      assertEq(db().prepare("SELECT * FROM agent_blocklist").all(), [], "w2: «1B» NO agent_blocklist row written");
      assertEq(isBlocked({ email: "HARD@rw-farm.no" }).blocked, false, "w2: «1B» isBlocked({email}) stays false");
      assertEq((db().prepare("SELECT COUNT(*) c FROM agents WHERE id = 'rw-hard'").get() as any).c, 1, "w2: profile NOT deleted");
      assertEq(gateIds(), ["rw-comp", "rw-ok", "rw-soft"], "w2: outreach gate drops the bounced agent");
      const s = aoc.computeOutreachCandidates(db(), { mode: "first", cooldownDays: 60, limit: 500 }).suppressed_counts as any;
      assertEq([s.hard_bounced, s.blocklisted], [1, 0], "w2: gate counts it as hard_bounced (via email_bounces), not blocklisted");

      // «1B»: ordering, order notifications and registration are untouched
      // for the bounced address.
      db().prepare(
        `UPDATE agents SET is_verified = 1, is_active = 1, order_notifications_opt_in = 1, lat = 59.91, lng = 10.75, city = 'Oslo'
          WHERE id = 'rw-hard'`,
      ).run();
      db().prepare(
        `INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability)
         VALUES ('rw-p1', 'rw-hard', 'Honning', 'honning', 150, 'glass', 'in_stock')`,
      ).run();
      const offers = await findOffers({ q: "honning", lat: 59.91, lng: 10.75 }, { geocode: async () => null });
      assertEq(
        offers.offers.filter((o) => o.producer.agent_id === "rw-hard").map((o) => o.producer.can_order),
        [true],
        "w2: «1B» findOffers can_order stays true for the bounced producer",
      );
      assertEq(
        resolveOrderNotificationRecipient("rw-hard"),
        { eligible: true, email: "hard@rw-farm.no", via: "verified_contact" },
        "w2: «1B» order-notification recipient stays eligible",
      );
      assertEq(
        isBlocked({ name: "Hard Gård", website: "https://rw-farm.no", email: "hard@rw-farm.no" }).blocked,
        false,
        "w2: «1B» /register blocklist gate passes the bounced address",
      );
      assertEq(
        isBlocked({ name: "Hard Gård", website: "https://rw-farm.no", email: "hard@rw-farm.no", orgNr: "999999999" }).blocked,
        false,
        "w2: «1B» /admin/register blocklist gate passes the bounced address",
      );
      transportCalls = [];
      const c = await compose("hard@rw-farm.no");
      assertEq([c.httpStatus, (c.body as any).error, c.transportAttempted, transportCalls.length], [409, "recipient_bounced", false, 0], "w2: compose refuses 409 recipient_bounced, no transport");
      const cf = await compose("Hard@RW-farm.no", "claude", true);
      assertEq(cf.httpStatus, 409, "w2: claude force=true does NOT bypass (case-insensitive match)");
      const cd = await compose("hard@rw-farm.no", "daniel", true);
      assertEq([cd.httpStatus, transportCalls], [200, ["hard@rw-farm.no"]], "w2: daniel+force manual override sends");
      transportCalls = [];
      const ok = await compose("control@elsewhere.test");
      assertEq([ok.httpStatus, transportCalls], [200, ["control@elsewhere.test"]], "w2: an unrelated address still sends");
    }

    // ── w3 complaint ───────────────────────────────────────────────────
    {
      const body = complained(["complain@rw-farm.no"], "em_c1");
      const r = await post(body, signed(body, "msg_w3"));
      assertEq([r.status, r.body.outcome], [200, "complaint_recorded"], "w3: 200 complaint_recorded");
      assertEq(db().prepare("SELECT bounce_type FROM email_bounces WHERE email = 'complain@rw-farm.no'").all(), [{ bounce_type: "complaint" }], "w3: email_bounces row (complaint)");
      assertEq(db().prepare("SELECT COUNT(*) c FROM agent_blocklist").get(), { c: 0 }, "w3: «1B» still no blocklist row");
      assertEq(isBlocked({ email: "complain@rw-farm.no" }).blocked, false, "w3: «1B» isBlocked({email}) stays false");
      assertEq(gateIds(), ["rw-ok", "rw-soft"], "w3: gate drops the complainer");
      const c = await compose("complain@rw-farm.no");
      assertEq([c.httpStatus, (c.body as any).bounce_type], [409, "complaint"], "w3: compose refuses");
    }

    // ── w4 soft bounce ─────────────────────────────────────────────────
    {
      const before = counts();
      const body = bounced(["soft@rw-farm.no"], { type: "Transient", subType: "MailboxFull", message: "452 mailbox full" });
      const r = await post(body, signed(body, "msg_w4"));
      assertEq([r.status, r.body.outcome], [200, "soft_bounce_logged"], "w4: Transient → soft_bounce_logged");
      const body2 = bounced(["soft@rw-farm.no"], undefined);
      const r2 = await post(body2, signed(body2, "msg_w4b"));
      assertEq(r2.body.outcome, "soft_bounce_logged", "w4: missing bounce.type → soft (nothing recorded)");
      const after = counts();
      assertEq([after.bounces - before.bounces, after.blocklist - before.blocklist, after.ledger - before.ledger], [0, 0, 2], "w4: ledger only — no bounce, no blocklist");
      assertEq(gateIds(), ["rw-ok", "rw-soft"], "w4: soft-bounced agent stays a candidate");
    }

    // ── w5 bad signatures ──────────────────────────────────────────────
    {
      const before = counts();
      const body = bounced(["ok@rw-farm.no"], { type: "Permanent" });
      const good = signed(body, "msg_w5");
      const cases: Array<[string, Record<string, string>, string]> = [
        ["garbage signature", { ...good, "svix-signature": "v1,AAAA" }, "bad_signature"],
        ["missing svix-signature", { "svix-id": good["svix-id"], "svix-timestamp": good["svix-timestamp"] }, "missing_headers"],
        ["missing svix-id", { "svix-timestamp": good["svix-timestamp"], "svix-signature": good["svix-signature"] }, "missing_headers"],
        ["no headers at all", {}, "missing_headers"],
        ["signed with another secret", signed(body, "msg_w5", { key: OTHER_KEY }), "bad_signature"],
        ["v2 scheme only", { ...good, "svix-signature": good["svix-signature"].replace(/^v1,/, "v2,") }, "bad_signature"],
        ["svix-id swapped after signing", { ...good, "svix-id": "msg_other" }, "bad_signature"],
      ];
      for (const [label, h, reason] of cases) {
        const r = await post(body, h);
        assertEq([r.status, r.body.reason], [401, reason], `w5: ${label} → 401 ${reason}`);
      }
      const tampered = body.replace("ok@rw-farm.no", "hard@rw-farm.no");
      const rt = await post(tampered, good);
      assertEq(rt.status, 401, "w5: body tampered after signing → 401");
      assertEq(counts(), before, "w5: nothing written by any rejected request");
      assertEq(gateIds(), ["rw-ok", "rw-soft"], "w5: gate unchanged");
    }

    // ── w6 timestamps ──────────────────────────────────────────────────
    {
      const before = counts();
      const body = bounced(["ok@rw-farm.no"], { type: "Permanent" });
      const stale = await post(body, signed(body, "msg_w6", { ts: nowS() - 6 * 60 }));
      assertEq([stale.status, stale.body.reason], [401, "stale_timestamp"], "w6: 6 min old → 401 stale_timestamp");
      const future = await post(body, signed(body, "msg_w6", { ts: nowS() + 6 * 60 }));
      assertEq([future.status, future.body.reason], [401, "stale_timestamp"], "w6: 6 min in the future → 401");
      const within = svc.verifySvixSignature({
        key: keyBytes, id: "x", timestamp: String(nowS() - 4 * 60), rawBody: Buffer.from("{}"),
        signatureHeader: "v1," + svc.computeSvixSignature(keyBytes, "x", String(nowS() - 4 * 60), "{}"),
      });
      assertEq(within, { ok: true }, "w6: 4 min old is inside the tolerance");
      const nonNum = await post(body, { ...signed(body, "msg_w6"), "svix-timestamp": "2026-09-29T10:00:00Z" });
      assertEq([nonNum.status, nonNum.body.reason], [401, "bad_timestamp"], "w6: non-integer timestamp → 401");
      assertEq(counts(), before, "w6: nothing written");
    }

    // ── w7 replay / idempotency ────────────────────────────────────────
    {
      const before = counts();
      const body = bounced(["hard@rw-farm.no"], { type: "Permanent", subType: "General", message: "550 5.1.1 user unknown" }, "em_hard1");
      const r = await post(body, signed(body, "msg_w2")); // same svix-id as w2, freshly timestamped
      assertEq([r.status, r.body.outcome, r.body.duplicate], [200, "duplicate", true], "w7: replayed svix-id → 200 duplicate");
      assertEq(counts(), before, "w7: replay wrote nothing");
      const r2 = await post(body, signed(body, "msg_w7_new")); // Resend re-sent same email_id under a new svix-id
      assertEq(r2.body.outcome, "hard_bounce_recorded", "w7: new svix-id, same email_id → processed");
      const after = counts();
      assertEq([after.bounces - before.bounces, after.blocklist - before.blocklist, after.ledger - before.ledger], [0, 0, 1], "w7: no duplicate bounce rows, no blocklist rows (only the ledger grows)");
    }

    // ── w8 unrelated event ─────────────────────────────────────────────
    {
      const before = counts();
      for (const type of ["email.delivered", "email.sent", "email.opened", "contact.created"]) {
        const body = JSON.stringify({ type, created_at: "2026-09-29T10:00:00Z", data: { email_id: "em_x", to: ["ok@rw-farm.no"] } });
        const r = await post(body, signed(body, "msg_w8_" + type));
        assertEq([r.status, r.body.outcome], [200, "ignored_event_type"], `w8: ${type} → 200 ignored`);
      }
      assertEq(counts(), before, "w8: nothing written (not even the ledger)");
    }

    // ── w9 recipient shapes ────────────────────────────────────────────
    {
      const before = counts();
      const body = bounced(["ok@rw-farm.no", "soft@rw-farm.no"], { type: "Permanent" });
      const r = await post(body, signed(body, "msg_w9"));
      assertEq(r.body.outcome, "ambiguous_recipient", "w9: two recipients → ambiguous_recipient");
      const junk = bounced(["not-an-address"], { type: "Permanent" });
      const rj = await post(junk, signed(junk, "msg_w9j"));
      assertEq(rj.body.outcome, "ambiguous_recipient", "w9: implausible address → ambiguous_recipient");
      const after = counts();
      assertEq([after.bounces - before.bounces, after.blocklist - before.blocklist], [0, 0], "w9: nothing recorded");
      const named = bounced(["Grei Gård <OK@RW-Farm.no>"], { type: "permanent" });
      const rn = await post(named, signed(named, "msg_w9n"));
      assertEq(rn.body.outcome, "hard_bounce_recorded", "w9: display-name form + lower-case 'permanent' accepted");
      assertEq(db().prepare("SELECT email FROM email_bounces WHERE resend_email_id IS NOT NULL AND email LIKE 'ok@%'").all(), [{ email: "ok@rw-farm.no" }], "w9: stored normalized (lower-case bare address)");
      assertEq(gateIds(), ["rw-soft"], "w9: gate now drops it too");
    }

    // ── w10 rotation ───────────────────────────────────────────────────
    {
      const body = bounced(["soft@rw-farm.no"], { type: "Transient" });
      const good = signed(body, "msg_w10");
      const other = signed(body, "msg_w10", { key: OTHER_KEY });
      const r = await post(body, { ...good, "svix-signature": `${other["svix-signature"]} v1,short ${good["svix-signature"]}` });
      assertEq([r.status, r.body.outcome], [200, "soft_bounce_logged"], "w10: one valid sig among several → accepted");
    }

    // ── w11 content-type / size ────────────────────────────────────────
    {
      const before = counts();
      const body = bounced(["soft@rw-farm.no"], { type: "Permanent" });
      const rq = await fetch(`http://127.0.0.1:${port}/webhooks/resend`, { method: "POST", headers: { "content-type": "text/plain", ...signed(body, "msg_w11") }, body });
      assertEq(rq.status, 400, "w11: non-JSON content-type → 400");
      const big = JSON.stringify({ type: "email.bounced", data: { to: ["soft@rw-farm.no"], bounce: { type: "Permanent" }, pad: "x".repeat(70 * 1024) } });
      const rb = await post(big, signed(big, "msg_w11b"));
      assertEq(rb.status, 413, "w11: > 64 KiB → 413");
      assertEq(counts(), before, "w11: nothing written");
    }

    // ── w12 send attribution (2026-10-04) ──────────────────────────────
    {
      process.env.ENABLE_EXPERIENCES = "1";
      process.env.EXPERIENCES_DB_PATH = ":memory:";
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const bounceAt = (to: string, acceptedAt: string, emailId: string, type = "email.bounced") =>
        JSON.stringify({
          type,
          created_at: "2026-09-29T12:00:00.000Z",
          data: { email_id: emailId, to: [to], subject: "x", created_at: acceptedAt, bounce: { type: "Permanent", subType: "General" } },
        });
      const attributed = (email: string) =>
        db().prepare("SELECT agent_id_at_send, batch_id, lane_at_send FROM email_bounces WHERE email = ? ORDER BY id DESC LIMIT 1").get(email);
      const sentLog = (agentId: string, email: string, sentAt: string, vertical: string) =>
        db().prepare(
          `INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes, vertical_id)
           VALUES (?, ?, ?, 'email', ?, 'test', ?)`,
        ).run(agentId, email, sentAt, `m-${email}-${sentAt}`, vertical);
      seedAgent("rw-led", "Ledger Gård", "led@rw-farm.no");
      seedAgent("rw-opp", "Opplev Gård", "opp@rw-farm.no");
      seedAgent("rw-cmp", "Compose Gård", "cmp@rw-farm.no");
      seedAgent("rw-old", "Gammel Gård", "old@rw-farm.no");

      // RFB daily job: ledger + the sent-log row compose's trigger writes for
      // the same send → the ledger wins (it carries the run id).
      db().prepare(
        `INSERT INTO rfb_marketing_send_ledger (day, run_id, agent_id, recipient_email, touch, subject_variant, status, reserved_at)
         VALUES ('2026-09-29', 'run-2026-09-29-rfb-marketing-platform', 'rw-led', 'led@rw-farm.no', 'first', 'A', 'sent', '2026-09-29T08:12:00.000Z')`,
      ).run();
      sentLog("rw-led", "led@rw-farm.no", "2026-09-29 08:12:01", "rfb");
      let body = bounceAt("led@rw-farm.no", "2026-09-29T08:12:02.000Z", "em_w12a");
      let r = await post(body, signed(body, "msg_w12a"));
      assertEq(r.body.outcome, "hard_bounce_recorded", "w12: RFB daily-job bounce recorded");
      assertEq(attributed("led@rw-farm.no"), { agent_id_at_send: "rw-led", batch_id: "run-2026-09-29-rfb-marketing-platform", lane_at_send: "rfb" }, "w12a: RFB daily-job send → ledger agent + run id, lane rfb");

      // Opplevagent: experience_outreach_sent_log + the daily-run envelope that
      // covers it; the CRM-trigger sent-log row (vertical 'experiences', an RFB
      // agent matched by e-mail) loses to the lane's own log.
      expDb.prepare(
        `INSERT INTO experience_outreach_sent_log (provider_id, recipient_email, sent_at, message_id, is_test)
         VALUES ('prov-opp', 'Opp@rw-farm.no', '2026-09-29 08:00:50', '<x@rettfrabonden.com>', 0)`,
      ).run();
      db().prepare(
        `INSERT INTO runs (run_id, vertical, agent, trigger_source, started_at, finished_at, status)
         VALUES ('run-2026-09-29-opplevagent-outreach-platform', 'experiences', 'opplevagent-outreach-platform', 'cron',
                 '2026-09-29T08:00:40.000Z', '2026-09-29T08:01:30.000Z', 'completed')`,
      ).run();
      sentLog("rw-opp", "opp@rw-farm.no", "2026-09-29T08:00:50.500Z", "experiences");
      body = bounceAt("opp@rw-farm.no", "2026-09-29T08:00:51.000Z", "em_w12b");
      r = await post(body, signed(body, "msg_w12b"));
      assertEq(attributed("opp@rw-farm.no"), { agent_id_at_send: "prov-opp", batch_id: "run-2026-09-29-opplevagent-outreach-platform", lane_at_send: "opplevagent" }, "w12b: Opplevagent send → provider id + covering daily-run id, lane opplevagent");

      // Compose-only RFB send (routine/manual): sent-log row only → its agent,
      // no batch. A LATER send (after Resend accepted the bounced mail) and an
      // older Opplevagent send are not it.
      expDb.prepare(
        `INSERT INTO experience_outreach_sent_log (provider_id, recipient_email, sent_at, is_test)
         VALUES ('prov-cmp', 'cmp@rw-farm.no', '2026-09-10 08:00:00', 0)`,
      ).run();
      sentLog("rw-cmp", "cmp@rw-farm.no", "2026-09-28 14:00:00", "rfb");
      sentLog("rw-cmp", "cmp@rw-farm.no", "2026-09-29 15:00:00", "rfb");
      body = bounceAt("cmp@rw-farm.no", "2026-09-28T14:00:03.000Z", "em_w12c", "email.complained");
      r = await post(body, signed(body, "msg_w12c"));
      assertEq(r.body.outcome, "complaint_recorded", "w12: complaint recorded");
      assertEq(attributed("cmp@rw-farm.no"), { agent_id_at_send: "rw-cmp", batch_id: null, lane_at_send: "rfb" }, "w12c: compose send → sent-log agent, no batch; the latest send at/before acceptance wins");

      // Nothing within the lookback → recorded exactly as before (NULLs).
      sentLog("rw-old", "old@rw-farm.no", "2026-08-01 08:00:00", "rfb");
      body = bounceAt("old@rw-farm.no", "2026-09-29T08:00:00.000Z", "em_w12d");
      r = await post(body, signed(body, "msg_w12d"));
      assertEq([r.body.outcome, attributed("old@rw-farm.no")], ["hard_bounce_recorded", { agent_id_at_send: null, batch_id: null, lane_at_send: null }], "w12d: no send inside the lookback → NULL attribution");

      // A failing lookup never fails the webhook: the bounce is still recorded.
      expDb.exec(`DROP TABLE experience_outreach_sent_log`);
      sentLog("rw-ok", "ok2@rw-farm.no", "2026-09-29 08:00:00", "rfb");
      body = bounceAt("ok2@rw-farm.no", "2026-09-29T08:00:01.000Z", "em_w12e");
      r = await post(body, signed(body, "msg_w12e"));
      assertEq([r.status, r.body.outcome, attributed("ok2@rw-farm.no")], [200, "hard_bounce_recorded", { agent_id_at_send: null, batch_id: null, lane_at_send: null }], "w12e: attribution lookup error → 200, bounce recorded without attribution");
    }
  } catch (err: any) {
    failed++;
    failures.push("resend-webhook: unexpected error: " + String(err?.stack || err));
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    restoreDb();
    if (prevPaused === undefined) delete process.env.OUTREACH_PAUSED;
    else process.env.OUTREACH_PAUSED = prevPaused;
    if (prevEnableExperiences === undefined) delete process.env.ENABLE_EXPERIENCES;
    else process.env.ENABLE_EXPERIENCES = prevEnableExperiences;
    if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
    else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
    dbFactory.__resetDbFactoryForTesting();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runResendWebhookTests({ log: true }).then((r) => {
    console.log(`\nresend-webhook: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed === 0 ? 0 : 1);
  });
}
