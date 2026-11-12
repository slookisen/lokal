/**
 * crm-delivery-status.test.ts — dev-request 2026-11-10-cs-paa-serveren
 * (slookisen/A2A), skive S3: Resend's delivery verdict per CRM message.
 *
 *   ds1-ds4   recordMessageDelivery: status only moves forward
 *             (soft_bounced < delivered < bounced < complained).
 *   ds5-ds8   the Resend webhook links delivered / bounced / complained to the
 *             reply by recipient + time; a duplicate event changes nothing.
 *   ds9-ds13  a bounced reply puts the thread back in «trenger svar», is
 *             alerted once, shown in the digest and in the thread detail; a
 *             cold-outreach bounce (no inbound on the thread) is not.
 *
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/services/crm-delivery-status.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { __resetDbFactoryForTesting } from "../database/db-factory";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runCrmDeliveryStatusTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function ok(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function eq(actual: unknown, expected: unknown, label: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    ok(a === e, `${label} (expected ${e}, got ${a})`);
  }

  return (async () => {
    const prevDb = initMod.__peekDbForTesting();
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    __resetDbFactoryForTesting();
    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);
      const ds = require("./crm-delivery-status") as typeof import("./crm-delivery-status");
      const crm = require("./crm-service") as typeof import("./crm-service");
      const nr = require("./crm-needs-reply") as typeof import("./crm-needs-reply");
      const cw = require("./cs-watchdog") as typeof import("./cs-watchdog");
      const wh = require("./resend-webhook") as typeof import("./resend-webhook");

      const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
      const status = (id: string) => (db.prepare("SELECT status FROM crm_message_delivery WHERE crm_message_id = ?").get(id) as any)?.status;

      // ── forward-only status ──────────────────────────────────────────
      ok(ds.recordMessageDelivery({ crmMessageId: "m-x", status: "soft_bounced", eventType: "email.bounced" }), "ds1: a first verdict is stored");
      ds.recordMessageDelivery({ crmMessageId: "m-x", status: "delivered", eventType: "email.delivered" });
      eq(status("m-x"), "delivered", "ds2: a soft bounce followed by delivery → delivered");
      ds.recordMessageDelivery({ crmMessageId: "m-x", status: "complained", eventType: "email.complained" });
      eq(status("m-x"), "complained", "ds3: a complaint after delivery → complained");
      ok(ds.recordMessageDelivery({ crmMessageId: "m-x", status: "delivered", eventType: "email.delivered" }) === false && status("m-x") === "complained", "ds4: a late «delivered» never hides a complaint");

      // ── a CS reply on a thread with an inbound message ───────────────
      const mk = (id: string, email: string, withInbound: boolean) => {
        crm.crmService.ingestThread(
          {
            threadId: id, subject: `Sak ${id}`, category: withInbound ? "innkommende" : "marketing",
            messages: withInbound ? [{ messageId: `${id}-in`, direction: "in", fromEmail: email, bodyText: "Spørsmål", sentAt: ago(3) }] : [],
          } as any,
          email,
          "rfb",
        );
        return crm.crmService.recordOutboundReply({ threadId: id, vertical: "rfb", toEmails: [email], subject: `Re: Sak ${id}`, bodyText: "Svar", deliveryStatus: "sent", sentAt: ago(1) }).messageId;
      };
      // ingestThread requires ≥1 message for a new thread, so the cold one gets its outbound via ingest
      const replyOk = mk("ds-t1", "levert@x.no", true);
      const replyBounce = mk("ds-t2", "avvist@x.no", true);
      const replySpam = mk("ds-t3", "spam@x.no", true);
      crm.crmService.ingestThread(
        { threadId: "ds-cold", subject: "Utsending", category: "marketing", messages: [{ messageId: "ds-cold-out", direction: "out", fromEmail: "kontakt@rettfrabonden.com", toEmails: ["kald@x.no"], sentAt: ago(1) }] },
        "kald@x.no", "rfb");
      const ev = (type: string, to: string, extra: Record<string, unknown> = {}) => ({ type, created_at: new Date().toISOString(), data: { to: [to], created_at: new Date().toISOString(), email_id: "re_" + Math.random().toString(36).slice(2), ...extra } });
      wh.processResendWebhookEvent("svix-d1", ev("email.delivered", "levert@x.no"));
      eq(status(replyOk), "delivered", "ds5: email.delivered → the reply is «delivered»");
      wh.processResendWebhookEvent("svix-b1", ev("email.bounced", "avvist@x.no", { bounce: { type: "Permanent", subType: "General" } }));
      eq(status(replyBounce), "bounced", "ds6: a permanent bounce → «bounced»");
      wh.processResendWebhookEvent("svix-c1", ev("email.complained", "spam@x.no"));
      eq(status(replySpam), "complained", "ds7: a complaint → «complained»");
      const before = (db.prepare("SELECT updated_at FROM crm_message_delivery WHERE crm_message_id = ?").get(replyBounce) as any).updated_at;
      wh.processResendWebhookEvent("svix-b1", ev("email.bounced", "avvist@x.no", { bounce: { type: "Permanent" } }));
      eq((db.prepare("SELECT updated_at FROM crm_message_delivery WHERE crm_message_id = ?").get(replyBounce) as any).updated_at, before, "ds8: a duplicate webhook delivery changes nothing");
      wh.processResendWebhookEvent("svix-cold", ev("email.bounced", "kald@x.no", { bounce: { type: "Permanent" } }));
      eq(status("ds-cold-out"), "bounced", "ds8b: a cold-outreach bounce is recorded on its message too");

      // ── S2/S3 review B5: two replies to one address minutes apart ───
      {
        crm.crmService.ingestThread({ threadId: "ds-two-a", subject: "Sak A", category: "innkommende", messages: [{ messageId: "ds-two-a-in", direction: "in", fromEmail: "to@x.no", sentAt: ago(3) }] }, "to@x.no", "rfb");
        crm.crmService.ingestThread({ threadId: "ds-two-b", subject: "Sak B", category: "innkommende", messages: [{ messageId: "ds-two-b-in", direction: "in", fromEmail: "to@x.no", sentAt: ago(3) }] }, "to@x.no", "rfb");
        const ra = crm.crmService.recordOutboundReply({ threadId: "ds-two-a", vertical: "rfb", toEmails: ["to@x.no"], subject: "Re: Sak A", bodyText: "A", deliveryStatus: "sent", sentAt: new Date(Date.now() - 5 * 60_000).toISOString() }).messageId;
        const rb = crm.crmService.recordOutboundReply({ threadId: "ds-two-b", vertical: "rfb", toEmails: ["to@x.no"], subject: "Re: Sak B", bodyText: "B", deliveryStatus: "sent", sentAt: new Date(Date.now() - 4 * 60_000).toISOString() }).messageId;
        wh.processResendWebhookEvent("svix-two-1", ev("email.bounced", "to@x.no", { subject: "Re: Sak A", bounce: { type: "Permanent" } }));
        eq([status(ra), status(rb)], ["bounced", undefined], "ds14: the subject picks the right reply when two went to the same address minutes apart");
        wh.processResendWebhookEvent("svix-two-2", ev("email.delivered", "to@x.no"));
        eq(status(rb), undefined, "ds15: without a subject, two candidates minutes apart are ambiguous — no verdict rather than a wrong one");
      }

      // ── consequences ─────────────────────────────────────────────────
      const ids = nr.computeNeedsReply({}).threads.map((t) => t.thread_id);
      ok(ids.includes("ds-t2") && ids.includes("ds-t3") && !ids.includes("ds-t1"), "ds9: a bounced / spam-flagged reply puts its thread back in «trenger svar»; a delivered one does not");
      const rep = nr.computeNeedsReply({});
      ok(rep.outbound_failed.some((o) => o.thread_id === "ds-t2" && /bounced/.test(String(o.reason))) && !rep.outbound_failed.some((o) => o.thread_id === "ds-cold"), "ds10: listed as an outbound that did not get out (replies only, not cold outreach)");
      const alerts: any[] = [];
      const send = async (o: any) => { alerts.push(o); return { success: true }; };
      await cw.runCsWatchdog({ send, adminEmail: "admin@example.no", trigger: "manual" });
      const text = String(alerts[0]?.textContent ?? "");
      ok(text.includes("kom ikke fram (bounce)") && text.includes("merket som spam") && !text.includes("Utsending"), "ds11: the watchdog alerts the bounced and the spam-flagged reply, not the cold-outreach bounce");
      await cw.runCsWatchdog({ send, adminEmail: "admin@example.no", trigger: "manual", now: new Date(Date.now() + 26 * 3600_000) });
      ok(!alerts.slice(1).some((a) => String(a.textContent).includes("kom ikke fram (bounce)")), "ds11b: …once, not every day");
      ok(cw.buildDailyDigest(new Date()).text.includes("SVAR SOM BOUNCET ELLER BLE MERKET SOM SPAM"), "ds12: the digest has the section");
      const detail = crm.crmService.getThreadDetail("ds-t2");
      eq(detail?.deliveries?.[replyBounce]?.status, "bounced", "ds13: the thread detail carries the verdict per message");
    } catch (err: any) {
      failed++;
      failures.push("unexpected error: " + String(err?.stack || err));
    } finally {
      try { db.close(); } catch { /* already closed */ }
      initMod.__setDbForTesting(prevDb as any);
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      __resetDbFactoryForTesting();
    }
    if (log) console.log(`\n${passed} passed, ${failed} failed`);
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runCrmDeliveryStatusTests({ log: true }).then((s) => {
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
