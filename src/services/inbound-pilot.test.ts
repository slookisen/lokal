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
    const db = new Database(":memory:");

    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);
      process.env.RESEND_API_KEY = "re_test_key";
      process.env.ADMIN_EMAIL = "admin@example.test";

      const wh = require("./inbound-email-webhook") as typeof import("./inbound-email-webhook");

      // ── helper ──────────────────────────────────────────────────────
      ok(wh.isPilotInboundMail(["pilot@rettfrabonden.com"], []), "ip1: pilot@ in To → pilot");
      ok(wh.isPilotInboundMail(["kontakt@rettfrabonden.com"], ["pilot@rettfrabonden.com"]), "ip2: pilot@ only in Cc → pilot");
      ok(wh.isPilotInboundMail(['"Pilot" <PILOT@RettFraBonden.com>'], []), "ip3: display-name + uppercase form → pilot");
      ok(!wh.isPilotInboundMail(["kontakt@rettfrabonden.com"], ["x@y.no"]), "ip4: ordinary recipients → not pilot");
      ok(!wh.isPilotInboundMail(["pilot@rettfrabonden.com.evil.no", "xpilot@rettfrabonden.com"], []), "ip5: look-alike addresses → not pilot");

      // ── webhook harness ─────────────────────────────────────────────
      const sent: any[] = [];
      let sendBehaviour: "ok" | "fail" = "ok";
      const deps = () => ({
        serverIngest: true,
        sendEmail: async (o: any) => {
          sent.push(o);
          return sendBehaviour === "ok" ? { success: true, messageId: "<fw@x>" } : { success: false, error: "relay refused" };
        },
        fetchImpl: (async () => ({ ok: true, json: async () => ({ text: "Din innloggingslenke: https://x/y", html: "<p>Din innloggingslenke</p>" }) })) as any,
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
