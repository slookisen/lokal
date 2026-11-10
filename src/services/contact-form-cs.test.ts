/**
 * contact-form-cs.test.ts — dev-request 2026-11-10-cs-paa-serveren
 * (slookisen/A2A), skive S5: the public contact form.
 *
 *   cf1-cf4   rejected submissions (honeypot, invalid input, rate limit) are
 *             counted per day / platform / reason — no personal data.
 *   cf5-cf11  automatic receipt: off by default; fixed template that never
 *             echoes the visitor's name or text; at most one per address per
 *             24 h; a dry-run transport is never «sent»; the outcome is on the
 *             thread as an action, not a message, so the thread still needs a
 *             reply.
 *   cf12-cf13 «trenger svar» marks the source; the digest shows rejections.
 *
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/services/contact-form-cs.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { __resetDbFactoryForTesting } from "../database/db-factory";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runContactFormCsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevNodeEnv = process.env.NODE_ENV;
    const prevAdmin = process.env.ADMIN_NOTIFICATION_EMAIL;
    const prevReceipt = process.env.CS_CONTACT_RECEIPT_ENABLED;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.NODE_ENV = "test"; // Turnstile passes in test
    process.env.ADMIN_NOTIFICATION_EMAIL = "admin@example.no";
    delete process.env.CS_CONTACT_RECEIPT_ENABLED;
    __resetDbFactoryForTesting();
    const db = new Database(":memory:");
    const prevError = console.error;
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);
      const cf = require("./contact-form-cs") as typeof import("./contact-form-cs");
      const nr = require("./crm-needs-reply") as typeof import("./crm-needs-reply");
      const cw = require("./cs-watchdog") as typeof import("./cs-watchdog");
      const emailMod = require("./email-service") as typeof import("./email-service");
      const contactRouter = (require("../routes/contact") as any).default;

      // Keep the admin copy off the wire.
      const svc = emailMod.emailService as any;
      const prevSendEmail = svc.sendEmail;
      svc.sendEmail = async () => ({ success: true, messageId: "stub" });
      console.error = () => {};

      const handler = (contactRouter.stack as any[]).find((l: any) => l.route?.path === "/contact" && l.route.methods?.post).route.stack.slice(-1)[0].handle;
      let ipN = 0;
      const post = (body: Record<string, unknown>, host = "rettfrabonden.com", ip?: string): Promise<{ status: number; body: any }> =>
        new Promise((resolve) => {
          const headers: Record<string, string> = { host };
          const req: any = { method: "POST", url: "/contact", path: "/contact", body, query: {}, headers, hostname: host, ip: ip ?? `203.0.113.${++ipN}`, get: (n: string) => headers[n.toLowerCase()] };
          let status = 200;
          const res: any = { status(c: number) { status = c; return res; }, json(p: any) { resolve({ status, body: p }); return res; }, set() { return res; }, setHeader() { return res; } };
          handler(req, res, () => resolve({ status: 0, body: null }));
        });
      const rejections = () => cf.contactRejectionsSince(new Date(Date.now() - 86400_000).toISOString());
      const n = (platform: string, reason: string) => rejections().find((r) => r.platform === platform && r.reason === reason)?.n ?? 0;

      // ── rejections ──────────────────────────────────────────────────
      await post({ name: "Bot", email: "bot@x.no", message: "spam", _honey: "filled" });
      eq(n("rfb", "honeypot"), 1, "cf1: honeypot rejection counted (rfb from the host)");
      await post({ name: "", email: "x@x.no", message: "" }, "opplevagent.no");
      eq(n("experiences", "invalid_input"), 1, "cf2: invalid input counted on the right platform");
      for (let i = 0; i < 4; i++) await post({ name: "Kari", email: "rate@x.no", message: "Hei" }, "rettfrabonden.com", "203.0.113.250");
      eq(n("rfb", "rate_limit"), 1, "cf3: the 4th submission from one IP within the hour is counted as rate limit");
      ok(!JSON.stringify(db.prepare("SELECT * FROM contact_form_rejections").all()).includes("@"), "cf4: the rejection table holds no addresses");

      // ── receipt ─────────────────────────────────────────────────────
      const ok1 = await post({ name: "Ola Nordmann", email: "Ola@Example.no", message: "Hemmelig tekst 123", subject: "Spørsmål" });
      eq(ok1.status, 200, "cf5: a valid submission is accepted");
      const thread = db.prepare("SELECT id FROM crm_threads WHERE id LIKE 'kontakt-%' ORDER BY created_at DESC LIMIT 1").get() as { id: string };
      await new Promise((r) => setTimeout(r, 20));
      eq((db.prepare("SELECT COUNT(*) n FROM contact_form_receipts").get() as any).n, 0, "cf6: receipt flag off → nothing sent or logged");
      const sent: any[] = [];
      const stubSend = async (o: any) => { sent.push(o); return { success: true, messageId: "<r1@rfb>" }; };
      const ON = { CS_CONTACT_RECEIPT_ENABLED: "1" } as unknown as NodeJS.ProcessEnv;
      const r1 = await cf.sendContactReceipt({ email: "Ola@Example.no", platform: "rfb", threadId: thread.id }, { env: ON, sendRaw: stubSend, liveTransport: true });
      eq([r1, sent.length, sent[0]?.to], ["sent", 1, "ola@example.no"], "cf7: flag on → one receipt to the form address");
      ok(!String(sent[0]?.textContent).includes("Ola") && !String(sent[0]?.textContent).includes("Hemmelig") && String(sent[0]?.from).includes("Rett fra Bonden"), "cf8: fixed template — never echoes the visitor's name or text; platform identity");
      const r2 = await cf.sendContactReceipt({ email: "ola@example.no", platform: "rfb", threadId: thread.id }, { env: ON, sendRaw: stubSend, liveTransport: true });
      eq([r2, sent.length], ["already_sent_24h", 1], "cf9: at most one receipt per address per 24 h");
      const r3 = await cf.sendContactReceipt({ email: "ny@example.no", platform: "experiences", threadId: thread.id }, { env: ON, sendRaw: stubSend, liveTransport: false });
      eq([r3, sent.length], ["dry_run", 1], "cf10: a dry-run transport is never «sent»");
      db.prepare(`INSERT INTO email_bounces (email, bounced_at, bounce_type) VALUES ('klaget@example.no', '2026-11-01', 'complaint')`).run();
      const r4 = await cf.sendContactReceipt({ email: "klaget@example.no", platform: "rfb", threadId: thread.id }, { env: ON, sendRaw: stubSend, liveTransport: true });
      eq([r4, sent.length], ["suppressed", 1], "cf10b: no receipt to an address with a complaint / hard bounce / on the blocklist");
      const r5 = await cf.sendContactReceipt({ email: "mange@example.no", platform: "rfb", threadId: thread.id }, { env: { ...ON, CS_CONTACT_RECEIPT_MAX_PER_DAY: "1" } as any, sendRaw: stubSend, liveTransport: true });
      eq([r5, sent.length], ["daily_cap", 1], "cf10c: a global daily cap on receipts");
      ok(!!db.prepare("SELECT 1 FROM crm_actions WHERE thread_id = ? AND type = 'receipt_sent'").get(thread.id) && (db.prepare("SELECT COUNT(*) n FROM crm_messages WHERE thread_id = ? AND direction = 'out'").get(thread.id) as any).n === 0, "cf11: the receipt is an action on the thread, not a message");

      // ── needs-reply + digest ────────────────────────────────────────
      const listed = nr.computeNeedsReply({}).threads.find((t) => t.thread_id === thread.id);
      eq([!!listed, listed?.source], [true, "kontaktskjema"], "cf12: the form thread still needs a reply and is marked as from the contact form");
      ok(cw.buildDailyDigest(new Date()).text.includes("kontaktskjema avvist"), "cf13: the digest shows rejected submissions");

      svc.sendEmail = prevSendEmail;
    } catch (err: any) {
      failed++;
      failures.push("unexpected error: " + String(err?.stack || err));
    } finally {
      console.error = prevError;
      try { db.close(); } catch { /* already closed */ }
      initMod.__setDbForTesting(prevDb as any);
      const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
      restore("EXPERIENCES_DB_PATH", prevExperiencesDbPath);
      restore("NODE_ENV", prevNodeEnv);
      restore("ADMIN_NOTIFICATION_EMAIL", prevAdmin);
      restore("CS_CONTACT_RECEIPT_ENABLED", prevReceipt);
      __resetDbFactoryForTesting();
    }
    if (log) console.log(`\n${passed} passed, ${failed} failed`);
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runContactFormCsTests({ log: true }).then((s) => {
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
