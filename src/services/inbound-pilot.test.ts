/**
 * inbound-pilot.test.ts — pilot inbox (pilot@rettfrabonden.com) bypasses the
 * CRM and the CS pipeline but still reaches ADMIN_EMAIL.
 *
 *   ip1-ip5    isPilotInboundMail: To, Cc, case / display-name form, others.
 *   ip6-ip12   pilot mail in To: log row, crm_status 'pilot_skipped', no CRM
 *              thread/message, forward subject «[Pilot] …» (never
 *              «[Innkommende]»), no Inbound-ID in html/text, header block kept.
 *   ip13-ip15  pilot only in Cc: same.
 *   ip16-ip17  uppercase display-name recipient is recognised.
 *   ip18-ip19  failed pilot forward: retry payload is the pilot variant.
 *   ip20-ip23  ordinary kontakt@ mail unchanged («[Innkommende] … (fra …)»,
 *              marker present, registered in CRM).
 *   ip24-ip29  isPilotForwardCopy: platform sender + «[Pilot]» (also after
 *              Re:/Fwd:, or via the thread subject), customers / [Innkommende]
 *              are not.
 *   ip30-ip41  /admin/crm/ingest of the ACTUAL pilot forward (review B1): with
 *              vertical and with routingSignals, nothing reaches crm_threads /
 *              crm_messages / crm_untriaged and the token is in none of them;
 *              a mixed thread files only the customer message; a customer's
 *              own «[Pilot] …» subject is ingested normally.
 *
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/services/inbound-pilot.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { __resetDbFactoryForTesting } from "../database/db-factory";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runInboundPilotTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevResendKey = process.env.RESEND_API_KEY;
    const prevAdminEmail = process.env.ADMIN_EMAIL;
    const prevAnalyticsKey = process.env.ANALYTICS_ADMIN_KEY;
    const db = new Database(":memory:");

    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);
      process.env.RESEND_API_KEY = "re_test_key";
      process.env.ADMIN_EMAIL = "admin@example.test";
      process.env.ANALYTICS_ADMIN_KEY = process.env.ANALYTICS_ADMIN_KEY || "test-admin-key";
      const adminKey = () => process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";

      const wh = require("./inbound-email-webhook") as typeof import("./inbound-email-webhook");

      // ── helper ──────────────────────────────────────────────────────
      ok(wh.isPilotInboundMail(["pilot@rettfrabonden.com"], []), "ip1: pilot@ in To → pilot");
      ok(wh.isPilotInboundMail(["kontakt@rettfrabonden.com"], ["pilot@rettfrabonden.com"]), "ip2: pilot@ only in Cc → pilot");
      ok(wh.isPilotInboundMail(['"Pilot" <PILOT@RettFraBonden.com>'], []), "ip3: display-name + uppercase form → pilot");
      ok(!wh.isPilotInboundMail(["kontakt@rettfrabonden.com"], ["x@y.no"]), "ip4: ordinary recipients → not pilot");
      ok(!wh.isPilotInboundMail(["pilot@rettfrabonden.com.evil.no", "xpilot@rettfrabonden.com"], []), "ip5: look-alike addresses → not pilot");

      // ── webhook harness ─────────────────────────────────────────────
      const TOKEN = "PILOTTOKEN-7f3a9c2e51";
      const sent: any[] = [];
      let sendBehaviour: "ok" | "fail" = "ok";
      const deps = () => ({
        serverIngest: true,
        sendEmail: async (o: any) => {
          sent.push(o);
          return sendBehaviour === "ok" ? { success: true, messageId: "<fw@x>" } : { success: false, error: "relay refused" };
        },
        // Only pilot mails (email_id "pil…") carry the token, so a token found in
        // a CRM table can only have come from a pilot forward.
        fetchImpl: (async (url: string) => {
          const tok = /\/pil[^/]*$/.test(String(url)) ? `?token=${TOKEN}` : "";
          return { ok: true, json: async () => ({ text: `Din innloggingslenke: https://x/y${tok}`, html: `<p>Din innloggingslenke: <a href="https://x/y${tok}">logg inn</a></p>` }) };
        }) as any,
      });
      const mkRes = () => {
        const r: any = { code: 0 };
        r.status = (c: number) => { r.code = c; return r; };
        r.json = () => r;
        return r;
      };
      const hook = async (data: any) => {
        const res = mkRes();
        await wh.handleInboundEmailWebhook({ body: { type: "email.received", data } } as any, res, deps());
        return res;
      };
      const logRow = (emailId: string) => db.prepare("SELECT * FROM inbound_email_log WHERE email_id = ?").get(emailId) as any;
      const crmCount = () => ({
        threads: (db.prepare("SELECT COUNT(*) n FROM crm_threads").get() as any).n,
        messages: (db.prepare("SELECT COUNT(*) n FROM crm_messages").get() as any).n,
        untriaged: (() => { try { return (db.prepare("SELECT COUNT(*) n FROM crm_untriaged").get() as any).n; } catch { return 0; } })(),
      });
      const noMarker = (o: any) => !String(o?.textContent).includes("Inbound-ID") && !String(o?.htmlContent).includes("Inbound-ID");

      // ip6-ip12: pilot in To (a magic-link mail the platform itself sent)
      {
        const before = crmCount();
        const res = await hook({ email_id: "pil1", from: "Rett fra Bonden <kontakt@rettfrabonden.com>", to: ["pilot@rettfrabonden.com"], subject: "Logg inn på Rett fra Bonden" });
        eq(res.code, 200, "ip6: webhook answers 200");
        const row = logRow("pil1");
        ok(!!row, "ip7: an inbound_email_log row exists");
        eq([row?.crm_status, row?.crm_thread_id, row?.forward_status], ["pilot_skipped", null, "ok"], "ip8: crm_status pilot_skipped, no thread, forward ok");
        eq(crmCount(), before, "ip9: nothing written to the CRM");
        const last = sent[sent.length - 1];
        eq([last?.to, last?.subject], ["admin@example.test", "[Pilot] Logg inn på Rett fra Bonden"], "ip10: forwarded to ADMIN_EMAIL as «[Pilot] <subject>»");
        ok(!/^\s*\[Innkommende\]/i.test(String(last?.subject)), "ip11: subject does not start with [Innkommende]");
        ok(noMarker(last) && String(last?.textContent).includes("Til: pilot@rettfrabonden.com") && String(last?.htmlContent).includes("Din innloggingslenke") && last?.replyTo === "kontakt@rettfrabonden.com", "ip12: no Inbound-ID marker; header block, body and replyTo kept");
      }

      // ip13-ip15: pilot only in Cc
      {
        const before = crmCount();
        await hook({ email_id: "pil2", from: "Kari <kari@testgard.no>", to: ["kontakt@rettfrabonden.com"], cc: ["pilot@rettfrabonden.com"], subject: "Hei" });
        eq(logRow("pil2")?.crm_status, "pilot_skipped", "ip13: Cc-only pilot → pilot_skipped");
        eq(crmCount(), before, "ip14: nothing written to the CRM");
        const last = sent[sent.length - 1];
        ok(last?.subject === "[Pilot] Hei" && noMarker(last), "ip15: «[Pilot]» subject, no marker");
      }

      // ip16-ip17: uppercase / display-name form
      {
        const before = crmCount();
        await hook({ email_id: "pil3", from: "a@b.no", to: ['"Pilot" <PILOT@RettFraBonden.com>'], subject: "Test" });
        eq([logRow("pil3")?.crm_status, crmCount()], ["pilot_skipped", before], "ip16: uppercase display-name recipient recognised, no CRM write");
        const last = sent[sent.length - 1];
        ok(last?.subject === "[Pilot] Test" && noMarker(last), "ip17: «[Pilot]» subject, no marker");
      }

      // ip18-ip19: a failed pilot forward keeps the PILOT variant for the retry job
      {
        sendBehaviour = "fail";
        await hook({ email_id: "pil4", from: "a@b.no", to: ["pilot@rettfrabonden.com"], subject: "Retry" });
        sendBehaviour = "ok";
        const row = logRow("pil4");
        eq([row?.forward_status, row?.crm_status], ["failed", "pilot_skipped"], "ip18: failed forward recorded for retry");
        const payload = JSON.parse(row?.forward_payload ?? "{}");
        ok(payload.subject === "[Pilot] Retry" && noMarker(payload), "ip19: stored retry payload is the pilot variant (no marker)");
      }

      // ip20-ip23: ordinary kontakt@ mail unchanged
      {
        const before = crmCount();
        await hook({ email_id: "norm1", from: "Kari Hansen <kari@testgard.no>", to: ["kontakt@rettfrabonden.com"], subject: "Spørsmål" });
        const row = logRow("norm1");
        eq(row?.crm_status, "registered", "ip20: ordinary mail registered in CRM");
        ok(crmCount().threads === before.threads + 1, "ip21: a CRM thread was created");
        const last = sent[sent.length - 1];
        eq(last?.subject, "[Innkommende] Spørsmål (fra Kari Hansen <kari@testgard.no>)", "ip22: subject «[Innkommende] … (fra …)» unchanged");
        const marker = `Inbound-ID: ${row?.id}`;
        ok(String(last?.textContent).includes(marker) && String(last?.htmlContent).includes(marker), "ip23: Inbound-ID marker present in text and html");
      }

      // ── isPilotForwardCopy (helper used by /admin/crm/ingest) ───────
      ok(wh.isPilotForwardCopy({ fromEmail: "kontakt@rettfrabonden.com", subject: "[Pilot] Logg inn" }), "ip24: platform sender + «[Pilot]» → pilot copy");
      ok(wh.isPilotForwardCopy({ fromEmail: "kontakt@rettfrabonden.com", subject: "Re: SV: Fwd: [pilot] Logg inn" }), "ip25: Re:/SV:/Fwd: prefixes stripped, case-insensitive");
      ok(wh.isPilotForwardCopy({ fromEmail: "noreply@mail.rettfrabonden.com", subject: null }, "[Pilot] Logg inn"), "ip26: subject-less message from our address uses the thread subject");
      ok(!wh.isPilotForwardCopy({ fromEmail: "kari@testgard.no", subject: "[Pilot] Spørsmål" }), "ip27: customer sender → not a pilot copy");
      ok(!wh.isPilotForwardCopy({ fromEmail: "kontakt@rettfrabonden.com", subject: "[Innkommende] Hei (fra x)" }), "ip28: [Innkommende] copy → not a pilot copy");
      ok(!wh.isPilotForwardCopy({ fromEmail: "kontakt@rettfrabonden.com", subject: "Hei [Pilot]" }), "ip29: «[Pilot]» not at the start → not a pilot copy");

      // ── /admin/crm/ingest of the actual pilot forward (review B1) ───
      const crmRoutes = require("../routes/crm") as any;
      const crmRouter = crmRoutes.default ?? crmRoutes;
      const call = async (url: string, body: any): Promise<{ status: number; body: any }> => {
        const req: any = {
          method: "POST", url, originalUrl: url, path: url, query: {}, body,
          headers: { "x-admin-key": adminKey(), host: "rettfrabonden.com" },
          get(n: string) { return this.headers[n.toLowerCase()]; },
        };
        let settle: () => void;
        const done = new Promise<void>((r) => { settle = r; });
        const res: any = {
          statusCode: 200, _body: undefined,
          status(c: number) { this.statusCode = c; return this; },
          json(b: any) { this._body = b; settle(); return this; },
          send(b: any) { this._body = b; settle(); return this; },
        };
        crmRouter.handle(req, res, () => settle());
        await done;
        return { status: res.statusCode, body: res._body };
      };
      const tableDump = (t: string): string => {
        try { return JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()); } catch { return ""; }
      };
      const tokenNowhere = () => ["crm_threads", "crm_messages", "crm_untriaged", "crm_actions"].every((t) => !tableDump(t).includes(TOKEN));

      // The forward the webhook actually produced for a magic-link mail to pilot@,
      // as the CS routine reads it back out of Gmail.
      await hook({ email_id: "pil-b1", from: "Rett fra Bonden <kontakt@rettfrabonden.com>", to: ["pilot@rettfrabonden.com"], subject: "Logg inn på Rett fra Bonden" });
      const fw = sent[sent.length - 1];
      ok(String(fw?.textContent).includes(TOKEN) && String(fw?.htmlContent).includes(TOKEN), "ip30: the webhook forward carries the token (precondition)");
      const relayFrom = (() => {
        try {
          const f = String((require("./email-service").emailService as any).fromAddress ?? "");
          return (f.match(/<([^>]+)>/)?.[1] ?? f).trim() || "kontakt@rettfrabonden.com";
        } catch { return "kontakt@rettfrabonden.com"; }
      })();
      const gmailPilotCopy = {
        messageId: "gm-pilot-1", direction: "in", fromEmail: relayFrom, toEmails: [fw.to],
        subject: fw.subject, bodyText: fw.textContent, bodyHtml: fw.htmlContent, snippet: String(fw.textContent).slice(0, 200),
        sentAt: new Date().toISOString(),
      };

      // ip31-ip33: with vertical "rfb"
      {
        const before = crmCount();
        const r = await call("/ingest", { threadId: "gm-pilot-t1", primaryFromEmail: relayFrom, subject: fw.subject, vertical: "rfb", messages: [gmailPilotCopy] });
        eq([r.status, r.body?.alreadyHandled, r.body?.newMessages, r.body?.threadId], [200, true, 0, null], "ip31: vertical rfb → 200, alreadyHandled, nothing filed");
        eq(crmCount(), before, "ip32: no crm_threads / crm_messages / crm_untriaged row");
        ok(tokenNowhere(), "ip33: token in none of the CRM tables");
      }
      // ip34-ip36: with routingSignals (unroutable → would otherwise park in crm_untriaged)
      {
        const before = crmCount();
        const r = await call("/ingest", { threadId: "gm-pilot-t2", primaryFromEmail: relayFrom, subject: fw.subject, routingSignals: { to: ["admin@example.test"] }, messages: [gmailPilotCopy] });
        eq([r.status, r.body?.alreadyHandled, r.body?.untriaged], [200, true, undefined], "ip34: routingSignals → 200 alreadyHandled, not parked (no 202)");
        eq(crmCount(), before, "ip35: no crm_threads / crm_messages / crm_untriaged row");
        ok(tokenNowhere(), "ip36: token in none of the CRM tables (raw_payload included)");
      }
      // ip37-ip39: mixed thread — the pilot copy is dropped, the customer message is filed
      {
        const before = crmCount();
        const customer = { messageId: "gm-mixed-cust", direction: "in", fromEmail: "kari@testgard.no", toEmails: ["kontakt@rettfrabonden.com"], subject: "Spørsmål om levering", bodyText: "Hei, leverer dere til Bergen?", sentAt: new Date(Date.now() + 1000).toISOString() };
        const r = await call("/ingest", { threadId: "gm-mixed-t", primaryFromEmail: "kari@testgard.no", subject: fw.subject, vertical: "rfb", messages: [{ ...gmailPilotCopy, messageId: "gm-mixed-pilot" }, customer] });
        eq([r.status, r.body?.newMessages], [200, 1], "ip37: mixed thread → 200, one new message");
        const ids = (db.prepare("SELECT id FROM crm_messages WHERE id IN ('gm-mixed-pilot','gm-mixed-cust')").all() as any[]).map((x) => x.id);
        eq(ids, ["gm-mixed-cust"], "ip38: only the customer message is in crm_messages");
        ok(crmCount().messages === before.messages + 1 && tokenNowhere(), "ip39: exactly one message row added, token nowhere");
      }
      // ip40-ip41: a customer's own «[Pilot] …» subject is ingested normally
      {
        const before = crmCount();
        const cust = { messageId: "gm-cust-pilotsubj", direction: "in", fromEmail: "ola@gardsbruk.no", toEmails: ["kontakt@rettfrabonden.com"], subject: "[Pilot] Vil være med i piloten", bodyText: "Hei!", sentAt: new Date().toISOString() };
        const r = await call("/ingest", { threadId: "gm-cust-t", primaryFromEmail: "ola@gardsbruk.no", subject: cust.subject, vertical: "rfb", messages: [cust] });
        eq([r.status, r.body?.newMessages, r.body?.alreadyHandled], [200, 1, undefined], "ip40: customer «[Pilot]» mail → filed normally");
        ok(crmCount().messages === before.messages + 1 && !!db.prepare("SELECT 1 FROM crm_messages WHERE id = 'gm-cust-pilotsubj'").get(), "ip41: its crm_messages row exists");
      }
    } catch (err: any) {
      failed++;
      failures.push("unexpected error: " + String(err?.stack || err));
    } finally {
      try { db.close(); } catch { /* already closed */ }
      initMod.__setDbForTesting(prevDb as any);
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      __resetDbFactoryForTesting();
      if (prevResendKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevResendKey;
      if (prevAdminEmail === undefined) delete process.env.ADMIN_EMAIL;
      else process.env.ADMIN_EMAIL = prevAdminEmail;
      if (prevAnalyticsKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
      else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsKey;
    }

    if (log) console.log(`\n${passed} passed, ${failed} failed`);
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runInboundPilotTests({ log: true }).then((s) => {
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
