/**
 * crm-send-dobbeltsperre.test.ts — dev-request
 * 2026-11-23-crm-send-dobbeltsending-og-tydelig-kvittering, AC2–AC4
 * (server side of POST /admin/crm/threads/:id/send).
 *
 *   g1-g9   AC2: two identical sends to the same thread inside 10 minutes →
 *           one sent mail; the second is 409 duplicate_send with the
 *           existing crm_messages id and never reaches the transport. The
 *           match is on the NORMALIZED text (spacing/line endings) and
 *           recipient (case); a different text, or a different recipient,
 *           goes through; a FAILED attempt does not block a retry; a send
 *           older than the window does not block.
 *   p1-p7   AC3: Daniel's own reply sets the routine's pending /
 *           approval_needed proposals on the SAME thread to `superseded`
 *           (and their outbox rows); other threads and already-sent
 *           proposals are untouched; needs-reply's counts.approval_needed
 *           drops accordingly.
 *   u1-u9   AC4: Gmail redirect links (google.com/url?q=…) are unwrapped
 *           before sending — the transport and the stored message get the
 *           real link; anything that is not exactly that shape is left alone.
 *
 * Standalone: npx tsx src/routes/crm-send-dobbeltsperre.test.ts
 * Wired into tests/test.ts.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runCrmSendDobbeltsperreTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  const summary: TestSummary = { passed: 0, failed: 0, failures: [] };
  const check = (name: string, cond: boolean, extra?: unknown) => {
    if (cond) {
      summary.passed++;
      if (log) console.log(`  ok ${name}`);
    } else {
      summary.failed++;
      const msg = extra === undefined ? name : `${name} — got ${JSON.stringify(extra)}`;
      summary.failures.push(msg);
      if (log) console.log(`  ✗ ${msg}`);
    }
  };

  // ── AC4 unit: the unwrap helper itself ───────────────────────────────
  {
    const { unwrapGoogleRedirectLinks: u } = require("../utils/unwrap-google-redirect") as typeof import("../utils/unwrap-google-redirect");
    check("u1: AC4 example is unwrapped to the decoded target",
      u("Se https://www.google.com/url?q=https%3A%2F%2Frettfrabonden.com%2Feier%2Fx%2Fvalg&sa=E her") ===
        "Se https://rettfrabonden.com/eier/x/valg her");
    check("u2: the raw Gmail shape (unencoded q, source/ust/sa) is unwrapped",
      u("https://www.google.com/url?q=https://rettfrabonden.com/eier/abc/valg&source=gmail&ust=1700000000000&usg=AOv") ===
        "https://rettfrabonden.com/eier/abc/valg");
    check("u3: google.com without www, and the url= parameter, are unwrapped",
      u("http://google.com/url?url=https%3A%2F%2Fexample.no%2Fa%3Fb%3D1&sa=D") === "https://example.no/a?b=1");
    check("u4: sentence punctuation after the link stays outside it",
      u("Lenke: https://www.google.com/url?q=https://example.no/x&sa=E.") === "Lenke: https://example.no/x.");
    const untouched = [
      "https://www.google.com/search?q=https://example.no",
      "https://maps.google.com/url?q=https://example.no",
      "https://www.google.com.evil.example/url?q=https://example.no",
      "https://www.google.com/url?q=javascript:alert(1)",
      "https://www.google.com/url?q=ftp://example.no/file",
      "https://www.google.com/url?sa=E",
      "https://rettfrabonden.com/eier/x/valg",
    ];
    check("u5: other google paths/hosts, non-http targets and missing q are left untouched",
      untouched.every((t) => u(t) === t), untouched.map((t) => u(t)));
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } = initMod;
  const prevDb = __peekDbForTesting();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  // adopt-ambient: reuse the suite's ADMIN_KEY when present (see tests/test.ts).
  const adminKey = process.env.ADMIN_KEY || "crm-dobbeltsperre-test-key";

  const emailMod = require("../services/email-service") as any;
  const svc = emailMod.emailService;
  const realSendRaw = svc.sendRaw;

  try {
    __setDbForTesting(db);
    __initSchemaForTesting(db);
    process.env.ADMIN_KEY = adminKey;
    process.env.ANALYTICS_ADMIN_KEY = process.env.ANALYTICS_ADMIN_KEY || adminKey;

    const { crmService } = require("../services/crm-service") as typeof import("../services/crm-service");
    const { computeNeedsReply } = require("../services/crm-needs-reply") as typeof import("../services/crm-needs-reply");
    const routePath = require.resolve("./crm");
    delete require.cache[routePath];
    const router = (require("./crm") as typeof import("./crm")).default as any;

    function call(method: string, url: string, body?: any): Promise<{ status: number; body: any }> {
      const req: any = {
        method, url, query: {}, body,
        headers: { "x-admin-key": adminKey },
        get(n: string) { return this.headers[n.toLowerCase()]; },
      };
      return new Promise((resolve) => {
        const res: any = {
          statusCode: 200,
          status(c: number) { this.statusCode = c; return this; },
          json(b: any) { this.body = b; resolve({ status: this.statusCode, body: b }); return this; },
        };
        router.handle(req, res, () => resolve({ status: res.statusCode, body: res.body }));
      });
    }

    const sent: any[] = [];
    let failNext = false;
    svc.sendRaw = async (p: any) => {
      if (failNext) { failNext = false; return { success: false, error: "stub transport down" }; }
      sent.push(p);
      return { success: true, messageId: `stub-${sent.length}` };
    };

    const contact = crmService.resolveContact("hallo@solvanggard.com", "Solvang Gård", "rfb");
    function seedThread(id: string) {
      db.prepare(`
        INSERT INTO crm_threads (id, contact_id, subject, category, severity, vertical_id, message_count)
        VALUES (?, ?, 'Spørsmål', 'innkommende', 'normal', 'rfb', 1)
      `).run(id, contact.id);
      db.prepare(`
        INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, cc_emails, subject, body_text, sent_at, delivery_status, vertical_id)
        VALUES (?, ?, 'in', 'hallo@solvanggard.com', '[]', '[]', 'Spørsmål', 'Hei, et spørsmål.', datetime('now','-1 hour'), 'sent', 'rfb')
      `).run(`in-${id}`, id);
    }
    const outbound = (threadId: string) =>
      db.prepare(`SELECT id, body_text, delivery_status FROM crm_messages WHERE thread_id = ? AND direction = 'out' ORDER BY rowid`).all(threadId) as any[];
    const reply = (over: Record<string, unknown> = {}) => ({
      intent: "resend_send",
      toEmails: ["hallo@solvanggard.com"],
      subject: "Re: Spørsmål",
      bodyText: "Takk, vi ordner det.",
      createdBy: "daniel",
      ...over,
    });

    // ── AC2 ──────────────────────────────────────────────────────────
    {
      const t = "dobbel-thread-1";
      seedThread(t);
      const r1 = await call("POST", `/threads/${t}/send`, reply());
      check("g1: first send succeeds", r1.status === 200, r1);
      const r2 = await call("POST", `/threads/${t}/send`, reply());
      check("g2: AC2 — the identical second send is refused 409 duplicate_send", r2.status === 409 && r2.body?.error === "duplicate_send", r2);
      check("g3: …naming the existing message id", r2.body?.duplicateMessageId === r1.body?.internalMessageId, r2.body);
      check("g4: …and nothing was sent a second time (one transport call, one outbound row)", sent.length === 1 && outbound(t).length === 1);

      const r3 = await call("POST", `/threads/${t}/send`, reply({ bodyText: "  Takk,\r\nvi   ordner det.  ", toEmails: ["Hallo@SolvangGard.com"] }));
      check("g5: the same text with other spacing/line endings, recipient in other case, is still a duplicate", r3.status === 409, r3);

      const r4 = await call("POST", `/threads/${t}/send`, reply({ bodyText: "Takk, vi ordner det i morgen." }));
      check("g6: a different text goes through as before", r4.status === 200 && sent.length === 2, r4);

      const r5 = await call("POST", `/threads/${t}/send`, reply({ toEmails: ["annen@solvanggard.com"] }));
      check("g7: the same text to a different recipient goes through", r5.status === 200 && sent.length === 3, r5);

      // A send older than the 10-minute window no longer blocks.
      db.prepare(`UPDATE crm_messages SET received_at = datetime('now', '-11 minutes') WHERE thread_id = ? AND direction = 'out'`).run(t);
      const r6 = await call("POST", `/threads/${t}/send`, reply());
      check("g8: the same text after more than 10 minutes is not blocked", r6.status === 200, r6);

      const tf = "dobbel-thread-failed";
      seedThread(tf);
      failNext = true;
      const f1 = await call("POST", `/threads/${tf}/send`, reply());
      const f2 = await call("POST", `/threads/${tf}/send`, reply());
      check("g9: a FAILED attempt does not block a retry with the same text", f1.status === 500 && f2.status === 200, [f1.status, f2.status]);
    }

    // ── AC3 ──────────────────────────────────────────────────────────
    {
      const t = "dobbel-thread-proposals";
      const other = "dobbel-thread-other";
      seedThread(t);
      seedThread(other);
      const ts = new Date(Date.now() - 60_000).toISOString();
      const ins = db.prepare(`
        INSERT INTO cs_reply_proposals (id, thread_id, vertical, kind, to_email, subject, body_text, created_by, status, created_at, updated_at)
        VALUES (?, ?, 'rfb', 'annet', 'hallo@solvanggard.com', 'Re: Spørsmål', 'Forslag', 'claude', ?, ?, ?)
      `);
      ins.run("rp-same-approval", t, "approval_needed", ts, ts);
      ins.run("rp-same-pending", t, "pending", ts, ts);
      ins.run("rp-same-sent", t, "sent", ts, ts);
      ins.run("rp-other-approval", other, "approval_needed", ts, ts);
      db.prepare(`
        INSERT INTO crm_outbox (id, thread_id, contact_id, intent, status, to_emails, subject, body_text, created_by, vertical_id)
        VALUES ('ob-rp-same', ?, ?, 'resend_send', 'pending', '["hallo@solvanggard.com"]', 'Re: Spørsmål', 'Forslag', 'claude', 'rfb')
      `).run(t, contact.id);
      db.prepare(`UPDATE cs_reply_proposals SET outbox_id = 'ob-rp-same' WHERE id = 'rp-same-approval'`).run();

      const before = computeNeedsReply().counts.approval_needed;
      const r = await call("POST", `/threads/${t}/send`, reply({ bodyText: "Eget svar fra Daniel." }));
      check("p1: Daniel's own reply is sent", r.status === 200, r);
      const st = (id: string) => (db.prepare(`SELECT status FROM cs_reply_proposals WHERE id = ?`).get(id) as any)?.status;
      check("p2: AC3 — the approval_needed proposal on the same thread is now superseded", st("rp-same-approval") === "superseded");
      check("p3: …and so is the pending one", st("rp-same-pending") === "superseded");
      check("p4: an already-sent proposal and another thread's proposal are untouched",
        st("rp-same-sent") === "sent" && st("rp-other-approval") === "approval_needed");
      check("p5: the superseded proposal's outbox row is released as superseded",
        (db.prepare(`SELECT status FROM crm_outbox WHERE id = 'ob-rp-same'`).get() as any)?.status === "superseded");
      const after = computeNeedsReply().counts.approval_needed;
      check("p6: needs-reply no longer counts it as approval_needed", after === before - 1, { before, after });
      check("p7: the response lists the superseded proposals",
        JSON.stringify([...(r.body?.supersededProposals ?? [])].sort()) === JSON.stringify(["rp-same-approval", "rp-same-pending"]), r.body);
    }

    // ── AC4 through the route ────────────────────────────────────────
    {
      const t = "dobbel-thread-gmail-link";
      seedThread(t);
      const n = sent.length;
      const r = await call("POST", `/threads/${t}/send`, reply({
        bodyText: "Her er lenken: https://www.google.com/url?q=https%3A%2F%2Frettfrabonden.com%2Feier%2Fx%2Fvalg&sa=E",
      }));
      check("u6: the reply with a Gmail redirect link is sent", r.status === 200 && sent.length === n + 1, r);
      check("u7: AC4 — the transport gets the unwrapped link in the text part",
        sent[n]?.textContent === "Her er lenken: https://rettfrabonden.com/eier/x/valg", sent[n]?.textContent);
      check("u8: …and in the HTML part, with no google.com/url left",
        String(sent[n]?.htmlContent).includes("https://rettfrabonden.com/eier/x/valg") && !String(sent[n]?.htmlContent).includes("google.com/url"));
      check("u9: the stored thread message carries the unwrapped text",
        outbound(t)[0]?.body_text === "Her er lenken: https://rettfrabonden.com/eier/x/valg", outbound(t));
    }
  } catch (err: any) {
    summary.failed++;
    summary.failures.push("unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    svc.sendRaw = realSendRaw;
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("./crm")]; } catch { /* ignore */ }
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    db.close();
  }
  return summary;
}

if (require.main === module) {
  runCrmSendDobbeltsperreTests({ log: true }).then((s) => {
    console.log(`\ncrm-send-dobbeltsperre: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      for (const f of s.failures) console.error(`  FAILED: ${f}`);
      process.exit(1);
    }
    // Imported services keep module-level timers alive; exit explicitly.
    process.exit(0);
  });
}
