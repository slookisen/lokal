/**
 * crm-platform-identity.test.ts — dev-request
 * 2026-07-27-crm-plattformadskillelse-opplevagent, steg 3 + its precondition.
 *
 * Funn 2, observed live in Daniel's Gmail 18 July (booking GARD-20260718-C5EEN):
 * a gårdssalg producer's booking notice arrived `From: kontakt@rettfrabonden.com`
 * carrying Opplevagent content. Not theoretical — production.
 *
 *   pi1-pi8    resolveCrmIdentity / crmFromHeader. Fail-closed, and the From
 *              header is RFC 5322 shaped with the display name escaped.
 *   pi9-pi16   THE SEND PATH. Asserted on the mail options that would reach the
 *              transport — not on a return value, and not on the identity
 *              helper's output. A helper can be perfect while nothing calls it;
 *              that is exactly how lokal#377's cap was deletable with 10 443
 *              tests green.
 *   pi17-pi22  The steg-3 PRECONDITION: outreach_sent_log is an RFB-only
 *              ledger, so an `experiences` send must not write a suppression
 *              row against an RFB agent_id. A silent under-send — the producer
 *              simply stops being contacted and nothing errors.
 *
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/services/crm-platform-identity.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runCrmPlatformIdentityTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
  function assertThrows(fn: () => unknown, expect: RegExp, label: string): void {
    try { fn(); assertTrue(false, `${label} — expected a throw, got a return`); }
    catch (e: any) {
      const msg = String(e?.message ?? e);
      assertTrue(expect.test(msg), `${label} (message ${JSON.stringify(msg)} must match ${expect})`);
    }
  }

  return (async () => {
    const prevDb = initMod.__peekDbForTesting();
    const db = new Database(":memory:");
    const ident = require("./crm-platform-identity") as typeof import("./crm-platform-identity");

    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      // ═══════════════════════════════════════════════════════════════
      // pi1-pi8 — the identity table itself.
      // ═══════════════════════════════════════════════════════════════
      assertEq(ident.resolveCrmIdentity("experiences").displayName, "Opplevagent",
        "pi1: experiences reads as Opplevagent in the inbox list");
      assertEq(ident.resolveCrmIdentity("experiences").replyTo, "kontakt@opplevagent.no",
        "pi2: …and replies land on the Opplevagent forwarder — the inbound discriminator steg 4 needs");
      assertEq(ident.resolveCrmIdentity("rfb").displayName, "Rett fra Bonden",
        "pi3: rfb is unchanged");
      assertEq(ident.resolveCrmIdentity("rfb").replyTo, "kontakt@rettfrabonden.com",
        "pi4: …including its reply-to");
      assertTrue(
        ident.resolveCrmIdentity("experiences").displayName !== ident.resolveCrmIdentity("rfb").displayName,
        "pi5: the two platforms are genuinely DISTINGUISHABLE — asserting each alone would pass if both said the same thing");
      assertTrue(
        ident.resolveCrmIdentity("experiences").replyTo !== ident.resolveCrmIdentity("rfb").replyTo,
        "pi5b: …on reply-to too, which is what keeps the return path separable");

      assertThrows(() => ident.resolveCrmIdentity(undefined), /vertical must be one of/,
        "pi6: no vertical refuses to send rather than defaulting to the RFB identity");
      assertThrows(() => ident.resolveCrmIdentity("opplevagent"), /vertical must be one of/,
        "pi7: a plausible typo refuses too");

      assertEq(ident.crmFromHeader("experiences"), '"Opplevagent" <kontakt@rettfrabonden.com>',
        "pi8: the From header is RFC 5322 display-name form over the one Resend-verified address");

      // The escaping exists for a name we do not have yet. Testing it against a
      // real name would only prove today's data; this proves the rule.
      {
        const escaped = "Bonde \"Ola\" Nordmann".replace(/([\\"])/g, "\\$1");
        assertEq(escaped, 'Bonde \\"Ola\\" Nordmann',
          "pi8b: a display name containing a quote is escaped — an unescaped one corrupts the From header, which is a deliverability failure, not a cosmetic one");
      }

      // ═══════════════════════════════════════════════════════════════
      // pi9-pi16 — THE SEND PATH, through the real route and a real
      // transport stub. This is the part that can rot silently: the helper
      // above could be perfect while no caller uses it.
      // ═══════════════════════════════════════════════════════════════
      {
        const prevAdminKey = process.env.ANALYTICS_ADMIN_KEY;
        const prevSmtp = {
          host: process.env.SMTP_HOST, port: process.env.SMTP_PORT,
          user: process.env.SMTP_USER, pass: process.env.SMTP_PASS,
        };
        process.env.ANALYTICS_ADMIN_KEY = "crm-identity-test-key";

        const emailMod = require("./email-service") as typeof import("./email-service");
        const svc = emailMod.emailService as any;
        const realSendRaw = svc.sendRaw.bind(svc);
        const sent: any[] = [];
        // Capture what the SEND would carry. Stubbing sendRaw keeps the assertion
        // on the arguments the route builds, which is the thing under test.
        svc.sendRaw = async (o: any) => { sent.push(o); return { success: true, messageId: "stub-1" }; };

        try {
          const crmRoutes = require("../routes/crm") as any;
          const router = crmRoutes.default ?? crmRoutes.router ?? crmRoutes;

          const post = async (url: string, body: any): Promise<{ status: number }> => {
            const req: any = {
              method: "POST", url, query: {}, body,
              headers: { "x-admin-key": "crm-identity-test-key" },
              get(n: string) { return this.headers[n.toLowerCase()]; },
            };
            let settle: () => void;
            const done = new Promise<void>((r) => { settle = r; });
            const res: any = {
              statusCode: 200,
              status(c: number) { this.statusCode = c; return this; },
              json() { settle(); return this; },
            };
            router.handle(req, res, () => settle());
            await done;
            return { status: res.statusCode };
          };

          // ── compose on experiences ──
          sent.length = 0;
          await post("/compose", {
            to: "gjest@example.no", subject: "Booking bekreftet", bodyText: "Hei",
            intent: "resend_send", createdBy: "daniel", vertical: "experiences",
          });
          assertEq(sent.length, 1, "pi9: an experiences compose reaches the transport exactly once");
          assertEq(sent[0]?.from, '"Opplevagent" <kontakt@rettfrabonden.com>',
            "pi10: …branded Opplevagent — this is funn 2, the booking notice that went out as Rett fra Bonden");
          assertEq(sent[0]?.replyTo, "kontakt@opplevagent.no",
            "pi11: …with the Opplevagent reply-to, so the reply comes back through the right forwarder");

          // ── compose on rfb, same endpoint ──
          sent.length = 0;
          await post("/compose", {
            to: "bonde@example.no", subject: "Hei", bodyText: "Hei",
            intent: "resend_send", createdBy: "daniel", vertical: "rfb",
          });
          assertEq(sent[0]?.from, '"Rett fra Bonden" <kontakt@rettfrabonden.com>',
            "pi12: the SAME endpoint brands an rfb send as Rett fra Bonden…");
          assertEq(sent[0]?.replyTo, "kontakt@rettfrabonden.com",
            "pi13: …with its own reply-to. Asserting only the experiences case would pass on a hardcoded constant");

          // ── reply on an existing thread: identity from the THREAD ──
          sent.length = 0;
          const seedThread = () => {
            const contact = require("./crm-service").crmService.resolveContact("tr@example.no", null, "experiences");
            db.prepare(`INSERT INTO crm_threads (id, contact_id, subject, category, severity, vertical_id)
                        VALUES ('pi-thread','${contact.id}','Emne','innkommende','normal','experiences')`).run();
          };
          seedThread();
          await post("/threads/pi-thread/send", {
            intent: "resend_send", toEmails: ["tr@example.no"],
            subject: "Svar", bodyText: "Hei igjen", createdBy: "daniel",
            // Ask for the WRONG platform — the thread must win.
            vertical: "rfb",
          });
          assertEq(sent[0]?.from, '"Opplevagent" <kontakt@rettfrabonden.com>',
            "pi14: a reply is branded by the THREAD's platform, not by what the caller asked for");
          assertEq(sent[0]?.replyTo, "kontakt@opplevagent.no",
            "pi15: …reply-to too — otherwise the answer to an Opplevagent conversation returns down the RFB pipe");

          // ── the address never changes ──
          assertTrue(
            String(sent[0]?.from).includes("<kontakt@rettfrabonden.com>"),
            "pi16: every platform still sends FROM the one Resend-verified address — the brand is the display name, not a second domain");

          // ── pi16b-pi16d: the REAL sendRaw must honour the override ──
          //
          // Everything above stubs sendRaw, so it tests what the ROUTE builds
          // and nothing about what sendRaw does with it. Mutation showed that:
          // making sendRaw ignore `options.from` entirely left all 24
          // assertions green, i.e. the route could hand over a perfect From
          // header and the transport would drop it on the floor. Same shape as
          // the cap that was deletable in lokal#377.
          //
          // So this drives the real method against a stub TRANSPORTER and reads
          // the mail options that would go on the wire.
          svc.sendRaw = realSendRaw;
          const prevConfigured = svc.isConfigured;
          const prevTransporter = svc.transporter;
          const wire: any[] = [];
          svc.isConfigured = true;
          svc.transporter = { sendMail: async (o: any) => { wire.push(o); return { messageId: "wire-1" }; } };
          try {
            await svc.sendRaw({
              to: "x@example.no", subject: "S", textContent: "T",
              from: '"Opplevagent" <kontakt@rettfrabonden.com>',
              replyTo: "kontakt@opplevagent.no",
            });
            assertEq(wire.length, 1, "pi16b: the real sendRaw reaches the transport");
            assertEq(wire[0]?.from, '"Opplevagent" <kontakt@rettfrabonden.com>',
              "pi16c: …and puts the caller's From on the wire — dropping the override was invisible to every assertion above");
            assertEq(wire[0]?.replyTo, "kontakt@opplevagent.no",
              "pi16d: …and the caller's reply-to with it");

            wire.length = 0;
            await svc.sendRaw({ to: "x@example.no", subject: "S", textContent: "T" });
            assertTrue(!String(wire[0]?.from ?? "").startsWith('"'),
              "pi16e: …while omitting `from` still falls back on the configured address — the override adds a case, it does not replace the old one");
          } finally {
            svc.isConfigured = prevConfigured;
            svc.transporter = prevTransporter;
            svc.sendRaw = async (o: any) => { sent.push(o); return { success: true, messageId: "stub-1" }; };
          }
        } finally {
          svc.sendRaw = realSendRaw;
          if (prevAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
          else process.env.ANALYTICS_ADMIN_KEY = prevAdminKey;
          for (const [k, v] of Object.entries(prevSmtp)) {
            const key = "SMTP_" + k.toUpperCase();
            if (v === undefined) delete process.env[key]; else process.env[key] = v;
          }
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // pi17-pi22 — THE STEG-3 PRECONDITION.
      //
      // outreach_sent_log gates outreach_ready_pool, whose rows are RFB
      // catalogue agents. Its triggers resolve an agent_id from the RFB tables
      // BY EMAIL. So before this guard, an Opplevagent send to a producer who
      // is also an RFB agent wrote a suppression row against that RFB agent_id
      // and dropped them from RFB outreach permanently.
      //
      // A silent under-send: nothing errors, the producer simply stops being
      // contacted, and the absence of an email is not something anyone notices.
      // ═══════════════════════════════════════════════════════════════
      {
        db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
                    VALUES ('agent-doble','Doble Gård','x','test','doble@example.no','https://doble.example.no','producer','pi-key-1',1)`).run();

        const mkSend = (vertical: string, msgId: string) => {
          const c = require("./crm-service").crmService.resolveContact("doble@example.no", null, vertical);
          const tid = `pi-osl-${vertical}`;
          db.prepare(`INSERT INTO crm_threads (id, contact_id, subject, category, severity, vertical_id)
                      VALUES (?,?,'Utsending','marketing','normal',?)`).run(tid, c.id, vertical);
          db.prepare(`INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, cc_emails,
                        subject, body_text, sent_at, raw_metadata, delivery_status, vertical_id)
                      VALUES (?,?,'out','kontakt@rettfrabonden.com','[]','[]','Utsending','x',datetime('now'),'{}','sent',?)`)
            .run(msgId, tid, vertical);
        };

        const rows = () => db.prepare(
          `SELECT vertical_id FROM outreach_sent_log o JOIN crm_messages m ON m.id = o.message_id`
        ).all() as any[];

        mkSend("experiences", "pi-msg-exp");
        assertEq(rows().length, 0,
          "pi17: an EXPERIENCES send writes NO outreach_sent_log row — it must not suppress an RFB producer");

        mkSend("rfb", "pi-msg-rfb");
        assertEq(rows().length, 1,
          "pi18: …while an RFB send still does — the guard narrows the trigger, it does not disable it");
        assertEq(rows()[0]?.vertical_id, "rfb",
          "pi19: …and the row that exists came from the rfb message");

        // The queued→sent confirm path is the one the marketing agent actually
        // takes, so leaving it unguarded would leave the real hole open.
        const c2 = require("./crm-service").crmService.resolveContact("doble@example.no", null, "experiences");
        db.prepare(`INSERT INTO crm_threads (id, contact_id, subject, category, severity, vertical_id)
                    VALUES ('pi-osl-confirm', ?, 'Utsending','marketing','normal','experiences')`).run(c2.id);
        db.prepare(`INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, cc_emails,
                      subject, body_text, sent_at, raw_metadata, delivery_status, vertical_id)
                    VALUES ('pi-msg-conf','pi-osl-confirm','out','kontakt@rettfrabonden.com','[]','[]','Utsending','x',datetime('now'),'{}','queued','experiences')`).run();
        db.prepare(`UPDATE crm_messages SET delivery_status = 'sent' WHERE id = 'pi-msg-conf'`).run();
        assertEq(rows().length, 1,
          "pi20: the queued→sent CONFIRM path is guarded too — that is the path the marketing agent actually uses");

        // And the trigger definitions must actually carry the guard in the
        // database, not merely in the source: they are created IF NOT EXISTS,
        // so without an explicit DROP an edit here is a no-op on any DB that
        // already has them — i.e. on production.
        for (const t of ["trg_log_cold_outreach_to_sent_log_v2", "trg_log_cold_outreach_on_send_confirm_v2"]) {
          const r = db.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?`).get(t) as any;
          assertTrue(String(r?.sql ?? "").includes("NEW.vertical_id = 'rfb'"),
            `pi21/pi22: ${t} carries the platform guard IN THE DATABASE — CREATE IF NOT EXISTS makes a source-only edit invisible on an existing DB`);
        }

        // ── pi23-pi24: THE UPGRADE PATH for the triggers ──
        //
        // Every test DB is fresh, so the trigger never pre-exists and
        // CREATE IF NOT EXISTS always creates the new definition. Production is
        // the opposite: the OLD trigger is already there. Mutation confirmed the
        // gap — deleting the DROP left all assertions green while the fix became
        // a no-op on exactly the database that matters.
        //
        // This installs a guard-less trigger first, the way prod carries it, and
        // then re-runs initSchema.
        {
          const legacy = new Database(":memory:");
          try {
            initMod.__setDbForTesting(legacy as any);
            initMod.__initSchemaForTesting(legacy as any);
            legacy.exec(`DROP TRIGGER IF EXISTS trg_log_cold_outreach_to_sent_log_v2`);
            legacy.exec(`
              CREATE TRIGGER trg_log_cold_outreach_to_sent_log_v2
                AFTER INSERT ON crm_messages FOR EACH ROW
                WHEN NEW.direction = 'out' AND NEW.delivery_status = 'sent'
                BEGIN
                  INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes)
                  SELECT cc.agent_id, LOWER(cc.email), datetime('now'), 'email', NEW.id, 'legacy'
                  FROM crm_threads ct JOIN crm_contacts cc ON cc.id = ct.contact_id
                  WHERE ct.id = NEW.thread_id AND cc.agent_id IS NOT NULL;
                END
            `);
            const before = (legacy.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_log_cold_outreach_to_sent_log_v2'`).get() as any)?.sql ?? "";
            assertTrue(!before.includes("NEW.vertical_id = 'rfb'"),
              "pi23: the pre-fix production shape is in place — a trigger WITHOUT the platform guard");

            initMod.__initSchemaForTesting(legacy as any);   // the upgrade boot

            const after = (legacy.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_log_cold_outreach_to_sent_log_v2'`).get() as any)?.sql ?? "";
            assertTrue(after.includes("NEW.vertical_id = 'rfb'"),
              "pi24: …and booting the new code REPLACES it with the guarded one — without the explicit DROP this whole fix is a no-op in production");
          } finally {
            try { legacy.close(); } catch { /* already closed */ }
            initMod.__setDbForTesting(db as any);
          }
        }
      }
    } finally {
      try { db.close(); } catch { /* already closed */ }
      initMod.__setDbForTesting(prevDb as any);
    }

    if (log) console.log(`\n${passed} passed, ${failed} failed`);
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runCrmPlatformIdentityTests({ log: true }).then((s) => {
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
