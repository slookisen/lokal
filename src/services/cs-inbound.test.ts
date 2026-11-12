/**
 * cs-inbound.test.ts — dev-request 2026-11-10-cs-paa-serveren (slookisen/A2A),
 * skive S1a: inbound safety net, server-side CRM registration, thread linking,
 * reopen, the Gmail-copy alias, and «trenger svar».
 *
 *   ci1-ci19   pure helpers: subject/id normalising, platform from domain,
 *              automated-mail detection (conservative: a customer subject
 *              must never be mistaken for an auto-reply), forward result.
 *   ci20-ci39  the webhook end to end: log row, BUG FIX (a failed forward is
 *              recorded as failed + kept for retry, never as success), marker
 *              in the forward, registration on the right platform, linking by
 *              header and by subject (same contact only), reopen, automated
 *              mail does not reopen, untriaged, flag off = no CRM write.
 *   ci40-ci49  /admin/crm/ingest of the Gmail copy: alias, no duplicate thread,
 *              Daniel's Gmail reply filed on the server thread, idempotent,
 *              /threads/<gmail-id>/status resolves the alias.
 *   ci50-ci69  «trenger svar»: age/level, outbound clears, done/system/
 *              leverandor/inbound-pitch excluded, reply to OUR outreach kept,
 *              automated latest inbound excluded, no-reply mark until a new
 *              inbound, untriaged listed, routes.
 *   ci70-ci81  review fixes: a QUOTED marker (Gmail reply, nested quote, HTML
 *              blockquote / gmail_quote) or a «Fwd:» never counts as the copy;
 *              only the Gmail thread's first message can create an alias; a
 *              real thread id is never aliased; a parked e-mail's copy opens no
 *              second item; «Re: [Innkommende] X (fra …)» normalises; an
 *              auto-reply never hides an earlier human message; thread stats
 *              pick the latest by time across mixed timestamp formats.
 *   ci82-ci87  second review: a copy the server did NOT file is kept; the last
 *              marker wins; subject fallback; linear-time HTML stripping;
 *              reopen via the Gmail path; unparseable sent_at still listed.
 *   ci88-ci95  third review: only a NEW human inbound reopens via the Gmail
 *              path; a subject-less customer reply is never taken for a copy;
 *              copies whose log row was purged are not filed again; the
 *              header marker wins; the parked fall-through does not file the
 *              copy; parked 202 parity; RFC 2822 dates on outreach replies.
 *   ci96-ci98  fourth review: a subject-less copy is recognised per message
 *              (sender on our domain) also in an aliased thread; a recent copy
 *              with no log row is filed; a kept auto-reply copy never reopens.
 *   ci99-ci104 fifth review: the log's automated_kind alone stops a reopen
 *              (neutral subject); a bounce copy with no log row is read from
 *              «(fra … <mailer-daemon@…>)»; a failed alias lookup answers 500
 *              with nothing filed and the retry reopens the thread.
 *   ci107-ci109 DMARC and TLS reports to a platform address are automated
 *              («report»): filed, but never «trenger svar»; a customer subject
 *              that mentions a report is not caught.
 *   ci110-ci114 the CS agent files the Gmail copy unwrapped (original sender
 *              and subject): still recognised by the forward's header block,
 *              so no duplicate thread; a reply, quote or Fwd never is.
 *   ci105-ci106 second re-review: «(fra …)» with parentheses in the sender
 *              name is parsed whole; the alias branch is one transaction (a
 *              DB error during the reopen rolls the messages back).
 *
 * Every assertion reads the DATABASE where a write is claimed.
 *
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/services/cs-inbound.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { __resetDbFactoryForTesting } from "../database/db-factory";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runCsInboundTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    const prevResendKey = process.env.RESEND_API_KEY;
    const ambientAdminKey = () => process.env.ADMIN_KEY || "test-admin-key";
    const db = new Database(":memory:");

    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);
      process.env.ANALYTICS_ADMIN_KEY = process.env.ANALYTICS_ADMIN_KEY || "test-admin-key";
      process.env.RESEND_API_KEY = "re_test_key";

      const ci = require("./cs-inbound") as typeof import("./cs-inbound");
      const wh = require("./inbound-email-webhook") as typeof import("./inbound-email-webhook");
      const crm = require("./crm-service") as typeof import("./crm-service");
      const nr = require("./crm-needs-reply") as typeof import("./crm-needs-reply");
      const crmRoutes = require("../routes/crm") as any;
      const crmRouter = crmRoutes.default ?? crmRoutes;

      const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

      // ── pure helpers ────────────────────────────────────────────────
      eq(ci.normalizeSubject("SV: Re:  Har vi riktig info om Testgard?"), "har vi riktig info om testgard?", "ci1: Re:/SV: prefixes stripped, case folded, spaces collapsed");
      eq(ci.normalizeSubject("[Innkommende] Re: Hei"), "hei", "ci2: [Innkommende] prefix stripped");
      eq(ci.normalizeSubject("Fwd: VS: Spørsmål"), "spørsmål", "ci3: forward prefixes stripped, æøå kept");
      eq(ci.parseMessageIdList("<A@b.no> <c@D.no>"), ["a@b.no", "c@d.no"], "ci4: References parsed and normalised");
      eq(ci.parseMessageIdList(""), [], "ci5: empty header → no ids");
      eq(ci.normalizeMessageId("<X.1@Host.NO>"), "x.1@host.no", "ci6: brackets stripped, lowercased");

      const v1 = ci.deriveInboundVertical(["kontakt@rettfrabonden.com"]);
      eq(v1.vertical, "rfb", "ci7: rettfrabonden.com → rfb");
      eq(ci.deriveInboundVertical(["post@opplevagent.no"]).vertical, "experiences", "ci8: opplevagent.no → experiences");
      eq(ci.deriveInboundVertical(["kontakt@finn-tannlege.com"]).vertical, "dental", "ci9: finn-tannlege.com → dental");
      eq(ci.deriveInboundVertical(["x@agentplatform.no"]).vertical, null, "ci10: unknown domain → no platform (parked, never a guess)");
      eq(ci.deriveInboundVertical(["kontakt@rettfrabonden.com", "kontakt@opplevagent.no"]).vertical, null, "ci11: two platforms → refused");

      const noHdr = ci.readInboundHeaders({});
      eq(ci.classifyAutomated({ subject: "Re: Har vi riktig info om Testgard?", fromEmail: "a@b.no", headers: noHdr }).kind, null, "ci12: an ordinary reply is not automated");
      eq(ci.classifyAutomated({ subject: "Ferieåpent i jula?", fromEmail: "a@b.no", headers: noHdr }).kind, null, "ci13: «Ferieåpent…» is a customer question, NOT an auto-reply");
      eq(ci.classifyAutomated({ subject: "Automatisk svar: Har vi riktig info", fromEmail: "a@b.no", headers: noHdr }).kind, "auto_reply", "ci14: «Automatisk svar:» → auto_reply");
      eq(ci.classifyAutomated({ subject: "Hei", fromEmail: "MAILER-DAEMON@mx.example.no", headers: noHdr }).kind, "bounce", "ci15: mailer-daemon → bounce");
      eq(ci.classifyAutomated({ subject: "Undeliverable: Hei", fromEmail: "x@y.no", headers: noHdr }).kind, "bounce", "ci16: bounce subject → bounce");
      eq(ci.classifyAutomated({ subject: "Hei", fromEmail: "x@y.no", headers: ci.readInboundHeaders({ headers: { "Auto-Submitted": "auto-replied" } }) }).kind, "auto_reply", "ci17: Auto-Submitted: auto-replied → auto_reply");
      eq(ci.classifyAutomated({ subject: "Hei", fromEmail: "x@y.no", headers: ci.readInboundHeaders({ headers: [{ name: "Auto-Submitted", value: "no" }] }) }).kind, null, "ci18: Auto-Submitted: no → not automated (array header shape)");
      eq([wh.forwardSucceeded({ success: true }), wh.forwardSucceeded({ success: false }), wh.forwardSucceeded(undefined), wh.forwardSucceeded(true)], [true, false, false, false], "ci19: only {success:true} counts as forwarded");

      // ── webhook harness ─────────────────────────────────────────────
      const sent: any[] = [];
      let sendBehaviour: "ok" | "fail" | "throw" = "ok";
      let fetchBody: any = { text: "hei", html: "<p>hei</p>" };
      const deps = (serverIngest = true) => ({
        serverIngest,
        sendEmail: async (o: any) => {
          sent.push(o);
          if (sendBehaviour === "throw") throw new Error("smtp down");
          return sendBehaviour === "ok" ? { success: true, messageId: "<fw@x>" } : { success: false, error: "relay refused" };
        },
        fetchImpl: (async () => ({ ok: true, json: async () => fetchBody })) as any,
      });
      const mkRes = () => {
        const r: any = { code: 0 };
        r.status = (c: number) => { r.code = c; return r; };
        r.json = () => r;
        return r;
      };
      const hook = async (data: any, serverIngest = true) => {
        const res = mkRes();
        await wh.handleInboundEmailWebhook({ body: { type: "email.received", data } } as any, res, deps(serverIngest));
        return res;
      };
      const logRow = (emailId: string) => db.prepare("SELECT * FROM inbound_email_log WHERE email_id = ?").get(emailId) as any;

      // ci20-ci25: a brand-new inbound to RFB
      {
        const res = await hook({ email_id: "em1", from: "Kari Hansen <kari@testgard.no>", to: ["kontakt@rettfrabonden.com"], subject: "Spørsmål om profilen", created_at: hoursAgo(1) });
        eq(res.code, 200, "ci20: webhook answers 200");
        const row = logRow("em1");
        ok(!!row, "ci21: an inbound_email_log row exists");
        eq([row?.crm_status, row?.vertical, row?.forward_status], ["registered", "rfb", "ok"], "ci22: registered on rfb, forward ok");
        const t = db.prepare("SELECT * FROM crm_threads WHERE id = ?").get(row?.crm_thread_id) as any;
        eq([t?.vertical_id, t?.category, t?.subject], ["rfb", "innkommende", "Spørsmål om profilen"], "ci23: thread on rfb, category innkommende, subject kept");
        const m = db.prepare("SELECT * FROM crm_messages WHERE id = 'rsnd-em1'").get() as any;
        eq([m?.direction, m?.from_email, m?.thread_id === row?.crm_thread_id], ["in", "kari@testgard.no", true], "ci24: the message is filed in that thread");
        const last = sent[sent.length - 1];
        ok(String(last?.textContent).includes(`Inbound-ID: ${row?.id}`), "ci25: the Gmail forward carries the Inbound-ID marker");
        ok(String(last?.textContent).indexOf(`Inbound-ID: ${row?.id}`) < String(last?.textContent).indexOf("\n\n"), "ci25b: …also in the header at the top (survives a truncated body)");
      }

      // ci26-ci28: BUG FIX — a failed forward is recorded as failed and kept
      {
        sendBehaviour = "fail";
        await hook({ email_id: "em2", from: "a@b.no", to: ["kontakt@rettfrabonden.com"], subject: "X" });
        const row = logRow("em2");
        eq([row?.forward_status, row?.forward_error], ["failed", "relay refused"], "ci26: {success:false} is logged as FAILED with the error (was: logged as success)");
        ok(typeof row?.forward_payload === "string" && row.forward_payload.includes("[Innkommende]"), "ci27: the forward mail is kept for the retry job");
        sendBehaviour = "throw";
        await hook({ email_id: "em3", from: "a@b.no", to: ["kontakt@rettfrabonden.com"], subject: "Y" });
        eq(logRow("em3")?.forward_status, "failed", "ci28: a throwing transport is also recorded as failed");
        sendBehaviour = "ok";
      }

      // ci29-ci31: reply linked by In-Reply-To to a thread we started (compose-*)
      {
        crm.crmService.ingestThread(
          { threadId: "compose-aaa", subject: "Har vi riktig info om Testgard?", category: "marketing",
            messages: [{ messageId: "out-aaa", direction: "out", fromEmail: "kontakt@rettfrabonden.com", toEmails: ["ola@testgard2.no"], subject: "Har vi riktig info om Testgard?", sentAt: hoursAgo(48) }] },
          "ola@testgard2.no", "rfb");
        db.prepare("INSERT INTO crm_outbox (id, thread_id, intent, status, to_emails, subject, body_text, result_id, created_by) VALUES ('ob-aaa','compose-aaa','resend_send','completed','[\"ola@testgard2.no\"]','s','b','<Orig-Msg@rettfrabonden.com>','claude')").run();
        fetchBody = { text: "Ja, det stemmer", html: "", headers: { "In-Reply-To": "<orig-msg@rettfrabonden.com>" } };
        await hook({ email_id: "em4", from: "Ola <ola@testgard2.no>", to: ["kontakt@rettfrabonden.com"], subject: "Re: Har vi riktig info om Testgard?" });
        const row = logRow("em4");
        eq([row?.crm_thread_id, row?.crm_linked_by], ["compose-aaa", "header"], "ci29: the reply lands in the compose thread (In-Reply-To ↔ crm_outbox.result_id)");
        eq((db.prepare("SELECT COUNT(*) n FROM crm_threads WHERE id LIKE 'inbound-%' AND id = ?").get("inbound-" + row?.id) as any).n, 0, "ci30: no separate inbound thread was created");
        const t = db.prepare("SELECT last_inbound_at FROM crm_threads WHERE id='compose-aaa'").get() as any;
        ok(!!t?.last_inbound_at, "ci31: the compose thread now shows the inbound");
        fetchBody = { text: "hei", html: "<p>hei</p>" };
      }

      // ci32-ci33: subject fallback — same contact only
      {
        crm.crmService.ingestThread(
          { threadId: "compose-bbb", subject: "Har vi riktig info om Bergsgard?", category: "marketing",
            messages: [{ messageId: "out-bbb", direction: "out", fromEmail: "kontakt@rettfrabonden.com", toEmails: ["post@bergsgard.no"], sentAt: hoursAgo(30) }] },
          "post@bergsgard.no", "rfb");
        await hook({ email_id: "em5", from: "post@bergsgard.no", to: ["kontakt@rettfrabonden.com"], subject: "SV: Har vi riktig info om Bergsgard?" });
        eq([logRow("em5")?.crm_thread_id, logRow("em5")?.crm_linked_by], ["compose-bbb", "subject"], "ci32: same contact + same subject → linked by subject");
        await hook({ email_id: "em6", from: "stranger@else.no", to: ["kontakt@rettfrabonden.com"], subject: "Re: Har vi riktig info om Bergsgard?" });
        ok(logRow("em6")?.crm_thread_id !== "compose-bbb", "ci33: a different sender with the same subject is NOT linked into someone else's thread");
      }

      // ci34-ci35: reopen on a human inbound; not on an auto-reply
      {
        crm.crmService.setThreadStatus("compose-bbb", "done", "claude");
        fetchBody = { text: "Jeg er på ferie", headers: { "Auto-Submitted": "auto-replied" } };
        await hook({ email_id: "em7", from: "post@bergsgard.no", to: ["kontakt@rettfrabonden.com"], subject: "Automatisk svar: Har vi riktig info om Bergsgard?" });
        eq((db.prepare("SELECT status FROM crm_threads WHERE id='compose-bbb'").get() as any).status, "done", "ci34: an auto-reply does not reopen a done thread");
        fetchBody = { text: "Glemte en ting", html: "" };
        await hook({ email_id: "em8", from: "post@bergsgard.no", to: ["kontakt@rettfrabonden.com"], subject: "Re: Har vi riktig info om Bergsgard?" });
        eq((db.prepare("SELECT status FROM crm_threads WHERE id='compose-bbb'").get() as any).status, "new", "ci35: a human reply reopens the done thread (status new)");
        fetchBody = { text: "hei", html: "<p>hei</p>" };
      }

      // ci36-ci38: other platforms + untriaged
      {
        await hook({ email_id: "em9", from: "g@gard.no", to: ["kontakt@opplevagent.no"], subject: "Besøk?" });
        eq(logRow("em9")?.vertical, "experiences", "ci36: opplevagent.no → registered on experiences");
        await hook({ email_id: "em10", from: "p@pasient.no", to: ["kontakt@finn-tannlege.com"], subject: "Time?" });
        eq((db.prepare("SELECT vertical_id FROM crm_threads WHERE id = ?").get(logRow("em10")?.crm_thread_id) as any)?.vertical_id, "dental", "ci37: finn-tannlege.com → registered on dental");
        await hook({ email_id: "em11", from: "x@y.no", to: ["kontakt@agentplatform.no"], subject: "Hei" });
        const r11 = logRow("em11");
        eq(r11?.crm_status, "untriaged", "ci38: unknown platform → parked as untriaged (log says so)");
        ok(!!db.prepare("SELECT 1 FROM crm_untriaged WHERE thread_id = ?").get("inbound-" + r11?.id), "ci38b: …and the crm_untriaged row exists");
      }

      // ci39: flag off — log + forward only, no CRM write; duplicate id ignored
      {
        const before = (db.prepare("SELECT COUNT(*) n FROM crm_threads").get() as any).n;
        await hook({ email_id: "em12", from: "z@z.no", to: ["kontakt@rettfrabonden.com"], subject: "Flag off" }, false);
        eq([logRow("em12")?.crm_status, (db.prepare("SELECT COUNT(*) n FROM crm_threads").get() as any).n], ["disabled", before], "ci39: flag off → crm_status disabled, no thread created");
        const n = (db.prepare("SELECT COUNT(*) n FROM inbound_email_log").get() as any).n;
        await hook({ email_id: "em12", from: "z@z.no", to: ["kontakt@rettfrabonden.com"], subject: "Flag off" });
        eq((db.prepare("SELECT COUNT(*) n FROM inbound_email_log").get() as any).n, n, "ci39b: a repeated email_id writes no second log row");
      }

      // ── router harness ──────────────────────────────────────────────
      const call = async (method: string, url: string, body?: any): Promise<{ status: number; body: any }> => {
        const [path, qs] = url.split("?");
        const query: Record<string, string> = {};
        for (const kv of (qs ?? "").split("&").filter(Boolean)) {
          const [k, v] = kv.split("=");
          query[k] = decodeURIComponent(v ?? "");
        }
        const req: any = {
          method, url, originalUrl: url, path, query, body: body ?? {},
          headers: { "x-admin-key": ambientAdminKey(), host: "rettfrabonden.com" },
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
        // As Express's final handler: an error passed on is a 500.
        crmRouter.handle(req, res, (err?: unknown) => { if (err) { res.statusCode = 500; res._body = { error: String((err as any)?.message ?? err) }; } settle(); });
        await done;
        return { status: res.statusCode, body: res._body };
      };

      // ci40-ci45: the CS agent ingests the Gmail copy of em1
      {
        const row = logRow("em1");
        const serverThread = row.crm_thread_id;
        const gmailCopy = {
          messageId: "gm-msg-1", direction: "in", fromEmail: "kontakt@rettfrabonden.com",
          subject: "[Innkommende] Spørsmål om profilen (fra Kari Hansen <kari@testgard.no>)",
          bodyText: `Videresent fra: kari\n\nhei\n\n--\nInbound-ID: ${row.id}`,
        };
        const danielReply = { messageId: "gm-msg-2", direction: "out", fromEmail: "da.daniel@example.no", toEmails: ["kari@testgard.no"], subject: "Re: Spørsmål", bodyText: "Takk!", sentAt: new Date().toISOString() };
        const r = await call("POST", "/ingest", { threadId: "gm-thread-1", primaryFromEmail: "kari@testgard.no", vertical: "rfb", messages: [gmailCopy, danielReply] });
        eq([r.status, r.body?.threadId, r.body?.serverRegistered], [200, serverThread, true], "ci40: ingest answers with the SERVER thread (serverRegistered)");
        eq((db.prepare("SELECT COUNT(*) n FROM crm_threads WHERE id = 'gm-thread-1'").get() as any).n, 0, "ci41: no duplicate thread is created under the Gmail id");
        eq((db.prepare("SELECT thread_id FROM crm_thread_aliases WHERE alias_id = 'gm-thread-1'").get() as any)?.thread_id, serverThread, "ci42: the Gmail id is recorded as an alias");
        eq((db.prepare("SELECT thread_id FROM crm_messages WHERE id = 'gm-msg-2'").get() as any)?.thread_id, serverThread, "ci43: Daniel's Gmail reply is filed on the server thread");
        eq((db.prepare("SELECT COUNT(*) n FROM crm_messages WHERE id = 'gm-msg-1'").get() as any).n, 0, "ci44: the marked forward copy itself is not filed (no duplicate inbound)");
        const r2 = await call("POST", "/ingest", { threadId: "gm-thread-1", primaryFromEmail: "kari@testgard.no", vertical: "rfb", messages: [gmailCopy, danielReply] });
        eq([r2.body?.threadId, r2.body?.newMessages], [serverThread, 0], "ci45: re-ingesting the same Gmail thread is idempotent");
        const r3 = await call("POST", "/threads/gm-thread-1/status", { status: "in_progress", actor: "claude" });
        eq([r3.status, (db.prepare("SELECT status FROM crm_threads WHERE id = ?").get(serverThread) as any)?.status], [200, "in_progress"], "ci46: /threads/<gmail-id>/status resolves the alias to the server thread");

        // ci70-ci76 (review B1): only the copy itself counts — never a quoted marker, a Fwd, or a copy that is not first.
        const quoted = `Hei Kari, takk for meldingen.\n\nPå tirsdag skrev Rett fra Bonden:\n> Videresent fra: kari\n> hei\n> --\n> Inbound-ID: ${row.id}`;
        const rq = await call("POST", "/ingest", {
          threadId: "gm-thread-q", primaryFromEmail: "kari@testgard.no", vertical: "rfb",
          messages: [{ messageId: "gm-q-1", direction: "out", fromEmail: "da.daniel@example.no", toEmails: ["kari@testgard.no"], subject: "Re: [Innkommende] Spørsmål om profilen (fra Kari Hansen <kari@testgard.no>)", bodyText: quoted, sentAt: new Date().toISOString() }],
        });
        ok(rq.status === 200 && rq.body?.serverRegistered !== true && (db.prepare("SELECT COUNT(*) n FROM crm_messages WHERE id = 'gm-q-1'").get() as any).n === 1, "ci70: a Gmail reply QUOTING the marker is filed, not dropped, and creates no alias");
        eq((db.prepare("SELECT COUNT(*) n FROM crm_thread_aliases WHERE alias_id = 'gm-thread-q'").get() as any).n, 0, "ci70b: …no alias for that Gmail thread");
        const follow = { messageId: "gm-msg-3", direction: "in", fromEmail: "kari@testgard.no", subject: "Re: Spørsmål", bodyText: `Supert!\n\n> Takk!\n> > Inbound-ID: ${row.id}`, sentAt: new Date(Date.now() + 1000).toISOString() };
        const rf = await call("POST", "/ingest", { threadId: "gm-thread-1", primaryFromEmail: "kari@testgard.no", vertical: "rfb", messages: [gmailCopy, danielReply, follow] });
        eq([rf.body?.newMessages, (db.prepare("SELECT thread_id FROM crm_messages WHERE id = 'gm-msg-3'").get() as any)?.thread_id], [1, serverThread], "ci71: the customer's follow-up with a nested quoted marker is filed on the server thread");
        eq(ci.forwardCopyMarker({ direction: "in", subject: "[Innkommende] X", bodyText: null, bodyHtml: `<p>Svar</p><blockquote>Inbound-ID: ${row.id}</blockquote>` }), null, "ci72: a marker inside an HTML blockquote does not count");
        eq(ci.forwardCopyMarker({ direction: "in", subject: "[Innkommende] X", bodyText: null, bodyHtml: `<p>Svar</p><div class="gmail_quote"><p>Inbound-ID: ${row.id}</p></div>` }), null, "ci72b: …nor inside a gmail_quote container");
        eq(ci.forwardCopyMarker({ direction: "in", subject: "[Innkommende] X", bodyText: null, bodyHtml: `<pre>hei</pre><p style="color:#999">Inbound-ID: ${row.id}</p>` }), row.id, "ci72c: the copy's own HTML marker line counts");
        eq(ci.forwardCopyMarker({ direction: "in", subject: "Fwd: [Innkommende] X", bodyText: `hei\n\nInbound-ID: ${row.id}` }), null, "ci73: a «Fwd:» of the copy is not the copy");
        const rfw = await call("POST", "/ingest", {
          threadId: "gm-thread-fwd", primaryFromEmail: "produsent@example.no", vertical: "rfb",
          messages: [
            { messageId: "gm-fwd-1", direction: "out", fromEmail: "da.daniel@example.no", toEmails: ["produsent@example.no"], subject: "Fwd: [Innkommende] Spørsmål om profilen", bodyText: `Se under\n\nVideresent fra: kari\nhei\n--\nInbound-ID: ${row.id}`, sentAt: new Date().toISOString() },
            { messageId: "gm-fwd-2", direction: "in", fromEmail: "produsent@example.no", subject: "Re: Fwd: [Innkommende] Spørsmål om profilen", bodyText: "Skal se på det", sentAt: new Date(Date.now() + 1000).toISOString() },
          ],
        });
        ok(rfw.body?.serverRegistered !== true && (db.prepare("SELECT thread_id FROM crm_messages WHERE id = 'gm-fwd-2'").get() as any)?.thread_id !== serverThread, "ci74: a Gmail thread where Daniel forwarded the copy is NOT merged into the customer's thread");
        const rlate = await call("POST", "/ingest", {
          threadId: "gm-thread-late", primaryFromEmail: "kari@testgard.no", vertical: "rfb",
          messages: [
            { messageId: "gm-late-1", direction: "in", fromEmail: "kari@testgard.no", subject: "Noe annet", bodyText: "Første melding", sentAt: hoursAgo(5) },
            { ...gmailCopy, messageId: "gm-late-2", sentAt: hoursAgo(1) },
          ],
        });
        ok(rlate.body?.serverRegistered !== true && (db.prepare("SELECT COUNT(*) n FROM crm_thread_aliases WHERE alias_id = 'gm-thread-late'").get() as any).n === 0, "ci75: a copy that is not the Gmail thread's first message creates no alias");
        eq([ci.recordThreadAlias("compose-bbb", serverThread, "test"), ci.resolveThreadAlias("compose-bbb")], [false, "compose-bbb"], "ci76: an id that is a real thread is never made an alias (no hijack of its routes)");
      }

      // ci82-ci87 (second review): copies the server did NOT file are kept; marker robustness; reopen via Gmail
      {
        const row1 = logRow("em1");
        const serverThread1 = row1.crm_thread_id;
        const off = logRow("em12"); // filed with the flag off → crm_status 'disabled'
        const offCopy = { messageId: "gm-off-1", direction: "in", fromEmail: "kontakt@rettfrabonden.com", subject: "[Innkommende] Flag off (fra z@z.no)", bodyText: `Videresent fra: z\n\nhei\n\n--\nInbound-ID: ${off.id}`, sentAt: new Date(Date.now() + 3000).toISOString() };
        const rOff = await call("POST", "/ingest", { threadId: "gm-thread-1", primaryFromEmail: "kari@testgard.no", vertical: "rfb", messages: [offCopy] });
        eq([rOff.body?.newMessages, (db.prepare("SELECT COUNT(*) n FROM crm_messages WHERE id = 'gm-off-1'").get() as any).n], [1, 1], "ci82: in an aliased Gmail thread, a copy of an e-mail the server did NOT file is kept (its only record)");
        eq(ci.findUnquotedInboundMarker(`kundens tekst\n\nFra: oss\nInbound-ID: inb-older-0001\n\nnyere tekst\n\nInbound-ID: inb-newer-0002`), "inb-newer-0002", "ci83: without a header marker, the LAST unquoted marker wins (older forward history above it)");
        eq(ci.forwardCopyMarker({ direction: "in", bodyText: `hei\n--\nInbound-ID: ${row1.id}` }, "[Innkommende] Spørsmål (fra x)"), row1.id, "ci84: a copy without its own subject is recognised from the Gmail thread subject");
        const t0 = Date.now();
        ci.htmlToPlainText("<".repeat(80_000));
        ci.findUnquotedInboundMarker(null, "<div class=" + "<".repeat(80_000));
        ok(Date.now() - t0 < 1000, "ci85: hostile unterminated-tag HTML is handled in linear time (no event-loop stall)");
        crm.crmService.setThreadStatus(serverThread1, "done", "claude");
        const follow2 = { messageId: "gm-msg-4", direction: "in", fromEmail: "kari@testgard.no", subject: "Re: Spørsmål", bodyText: "En ting til!", sentAt: new Date(Date.now() + 5000).toISOString() };
        await call("POST", "/ingest", { threadId: "gm-thread-1", primaryFromEmail: "kari@testgard.no", vertical: "rfb", messages: [follow2] });
        eq((db.prepare("SELECT status FROM crm_threads WHERE id = ?").get(serverThread1) as any)?.status, "new", "ci86: a new customer message via the Gmail copy path reopens a done thread");

        // ci88-ci94 (third review)
        const gmCopy1 = { messageId: "gm-msg-1", direction: "in", fromEmail: "kontakt@rettfrabonden.com", subject: "[Innkommende] Spørsmål om profilen (fra Kari Hansen <kari@testgard.no>)", bodyText: `Videresent fra: kari\n\nhei\n\n--\nInbound-ID: ${row1.id}`, sentAt: hoursAgo(24 * 100) };
        crm.crmService.setThreadStatus(serverThread1, "done", "claude");
        const daniel2 = { messageId: "gm-msg-5", direction: "out", fromEmail: "da.daniel@example.no", toEmails: ["kari@testgard.no"], subject: "Re: Spørsmål", bodyText: "Svar nr. 2", sentAt: new Date(Date.now() + 6000).toISOString() };
        await call("POST", "/ingest", { threadId: "gm-thread-1", primaryFromEmail: "kari@testgard.no", vertical: "rfb", messages: [gmCopy1, follow2, daniel2] });
        eq((db.prepare("SELECT status FROM crm_threads WHERE id = ?").get(serverThread1) as any)?.status, "done", "ci88: Daniel's own new reply (with an already-filed customer message in the payload) does not reopen the thread");
        const ooo = { messageId: "gm-msg-6", direction: "in", fromEmail: "kari@testgard.no", subject: "Automatisk svar: Re: Spørsmål", bodyText: "Jeg er på ferie", sentAt: new Date(Date.now() + 7000).toISOString(), rawMetadata: { automated: true } };
        await call("POST", "/ingest", { threadId: "gm-thread-1", primaryFromEmail: "kari@testgard.no", vertical: "rfb", messages: [ooo] });
        eq((db.prepare("SELECT status FROM crm_threads WHERE id = ?").get(serverThread1) as any)?.status, "done", "ci89: an auto-reply does not reopen the thread");
        const outlook = { messageId: "gm-msg-7", direction: "in", fromEmail: "kari@testgard.no", bodyText: `Takk, da er alt i orden.\n\nFra: Rett fra Bonden\nVideresent fra: kari\nInbound-ID: ${row1.id}`, sentAt: new Date(Date.now() + 8000).toISOString() };
        await call("POST", "/ingest", { threadId: "gm-thread-1", primaryFromEmail: "kari@testgard.no", subject: "[Innkommende] Spørsmål om profilen (fra Kari Hansen <kari@testgard.no>)", vertical: "rfb", messages: [outlook] });
        eq((db.prepare("SELECT thread_id FROM crm_messages WHERE id = 'gm-msg-7'").get() as any)?.thread_id, serverThread1, "ci90: a subject-less customer reply carrying the marker unquoted (Outlook) is filed, never taken for a copy");
        crm.crmService.setThreadStatus(serverThread1, "done", "claude"); // ci90's real customer reply reopened it, as it should
        db.prepare("DELETE FROM inbound_email_log WHERE id = ?").run(row1.id);
        db.prepare("DELETE FROM crm_messages WHERE id = 'gm-msg-1'").run();
        const daniel3 = { messageId: "gm-msg-8", direction: "out", fromEmail: "da.daniel@example.no", toEmails: ["kari@testgard.no"], subject: "Re: Spørsmål", bodyText: "Svar nr. 3", sentAt: new Date(Date.now() + 9000).toISOString() };
        const rp3 = await call("POST", "/ingest", { threadId: "gm-thread-1", primaryFromEmail: "kari@testgard.no", vertical: "rfb", messages: [gmCopy1, daniel3] });
        eq([rp3.body?.newMessages, (db.prepare("SELECT COUNT(*) n FROM crm_messages WHERE id = 'gm-msg-1'").get() as any).n, (db.prepare("SELECT status FROM crm_threads WHERE id = ?").get(serverThread1) as any)?.status], [1, 0, "done"], "ci91: after the 90-day log purge an old copy is not filed again (and nothing reopens)");
        eq(ci.findUnquotedInboundMarker(`Videresent fra: x\nInbound-ID: inb-header-0001\n\nkundens tekst\nInbound-ID: inb-older-0002`), "inb-header-0001", "ci92: the marker in the forward's header block wins");

        // ci96-ci98 (fourth review)
        const r5 = logRow("em5");
        const copyZ = { messageId: "gm-z-1", direction: "in", fromEmail: "kontakt@rettfrabonden.com", bodyText: `Videresent fra: x\nInbound-ID: ${r5.id}\n\nhei` };
        await call("POST", "/ingest", { threadId: "gm-thread-z", primaryFromEmail: "x@y.no", subject: "[Innkommende] Har vi riktig info? (fra x)", vertical: "rfb", messages: [copyZ] });
        crm.crmService.setThreadStatus(r5.crm_thread_id, "done", "claude");
        const danielZ = { messageId: "gm-z-2", direction: "out", fromEmail: "da.daniel@example.no", toEmails: ["x@y.no"], subject: "Re: Har vi riktig info?", bodyText: "Ja", sentAt: hoursAgo(24 * 200) }; // old, so ci57's thread stays unanswered
        const rz = await call("POST", "/ingest", { threadId: "gm-thread-z", primaryFromEmail: "x@y.no", subject: "[Innkommende] Har vi riktig info? (fra x)", vertical: "rfb", messages: [copyZ, danielZ] });
        eq([rz.body?.newMessages, (db.prepare("SELECT COUNT(*) n FROM crm_messages WHERE id = 'gm-z-1'").get() as any).n, (db.prepare("SELECT status FROM crm_threads WHERE id = ?").get(r5.crm_thread_id) as any)?.status], [1, 0, "done"], "ci96: a re-sent aliased thread recognises its subject-less copy (sent from our address): not filed, nothing reopens");
        crm.crmService.setThreadStatus(r5.crm_thread_id, "new", "claude"); // restore for ci57
        const ghost = { messageId: "gm-ghost-1", direction: "in", fromEmail: "kontakt@rettfrabonden.com", subject: "[Innkommende] Ny bestilling (fra y)", bodyText: `Videresent fra: y\nInbound-ID: inb-restored-000000001\n\nJeg vil bestille`, sentAt: new Date().toISOString() };
        await call("POST", "/ingest", { threadId: "gm-thread-1", primaryFromEmail: "kari@testgard.no", vertical: "rfb", messages: [ghost] });
        eq((db.prepare("SELECT COUNT(*) n FROM crm_messages WHERE id = 'gm-ghost-1'").get() as any).n, 1, "ci97: a RECENT copy whose log row is missing (restored backup) is filed, never dropped as «purged»");
        crm.crmService.setThreadStatus(serverThread1, "done", "claude");
        db.prepare(`INSERT INTO inbound_email_log (id, email_id, from_email, subject, crm_status, automated_kind, received_at) VALUES ('inb-ooo-000000001', 'ooo-1', 'kari@testgard.no', 'Automatisk svar', 'disabled', 'auto_reply', ?)`).run(new Date().toISOString());
        const oooCopy = { messageId: "gm-ooo-copy", direction: "in", fromEmail: "kontakt@rettfrabonden.com", subject: "[Innkommende] Automatisk svar: Re: Spørsmål (fra Kari)", bodyText: `Videresent fra: kari\nInbound-ID: inb-ooo-000000001\n\nPå ferie`, sentAt: new Date().toISOString() };
        await call("POST", "/ingest", { threadId: "gm-thread-1", primaryFromEmail: "kari@testgard.no", vertical: "rfb", messages: [oooCopy] });
        eq([(db.prepare("SELECT COUNT(*) n FROM crm_messages WHERE id = 'gm-ooo-copy'").get() as any).n, (db.prepare("SELECT status FROM crm_threads WHERE id = ?").get(serverThread1) as any)?.status], [1, "done"], "ci98: a kept copy of an auto-reply is filed but does not reopen the thread");

        // ci99-ci104 (fifth review)
        const threadStatus = () => (db.prepare("SELECT status FROM crm_threads WHERE id = ?").get(serverThread1) as any)?.status;
        const filed = (id: string) => (db.prepare("SELECT COUNT(*) n FROM crm_messages WHERE id = ?").get(id) as any).n;
        crm.crmService.setThreadStatus(serverThread1, "done", "claude");
        db.prepare(`INSERT INTO inbound_email_log (id, email_id, from_email, subject, crm_status, automated_kind, received_at) VALUES ('inb-neutral-00001', 'neutral-1', 'kari@testgard.no', 'Om bestillingen', 'disabled', 'auto_reply', ?)`).run(new Date().toISOString());
        const neutralAuto = { messageId: "gm-neutral-auto", direction: "in", fromEmail: "kontakt@rettfrabonden.com", subject: "[Innkommende] Om bestillingen (fra Kari <kari@testgard.no>)", bodyText: `Videresent fra: kari\nInbound-ID: inb-neutral-00001\n\nTakk`, sentAt: new Date().toISOString() };
        await call("POST", "/ingest", { threadId: "gm-thread-1", primaryFromEmail: "kari@testgard.no", vertical: "rfb", messages: [neutralAuto] });
        eq([filed("gm-neutral-auto"), threadStatus()], [1, "done"], "ci99: a kept copy with a NEUTRAL subject whose log row says auto_reply is filed but does not reopen");
        db.prepare(`INSERT INTO inbound_email_log (id, email_id, from_email, subject, crm_status, received_at) VALUES ('inb-neutral-00002', 'neutral-2', 'kari@testgard.no', 'Om bestillingen', 'disabled', ?)`).run(new Date().toISOString());
        const neutralHuman = { ...neutralAuto, messageId: "gm-neutral-human", bodyText: `Videresent fra: kari\nInbound-ID: inb-neutral-00002\n\nNår kan jeg hente?` };
        await call("POST", "/ingest", { threadId: "gm-thread-1", primaryFromEmail: "kari@testgard.no", vertical: "rfb", messages: [neutralHuman] });
        eq([filed("gm-neutral-human"), threadStatus()], [1, "new"], "ci100: the same copy without automated_kind reopens (control for ci99)");
        crm.crmService.setThreadStatus(serverThread1, "done", "claude");
        const bounceCopy = { messageId: "gm-bounce-copy", direction: "in", fromEmail: "kontakt@rettfrabonden.com", subject: "[Innkommende] Re: Om bestillingen (fra Mail Delivery Subsystem <mailer-daemon@googlemail.com>)", bodyText: `Videresent fra: mailer-daemon\nInbound-ID: inb-bounce-nolog-01\n\nAddress not found`, sentAt: new Date().toISOString() };
        await call("POST", "/ingest", { threadId: "gm-thread-1", primaryFromEmail: "kari@testgard.no", vertical: "rfb", messages: [bounceCopy] });
        eq([filed("gm-bounce-copy"), threadStatus()], [1, "done"], "ci101: a bounce copy with no log row is filed (recent) but does not reopen: the sender is read from «(fra … <mailer-daemon@…>)»");
        eq([ci.classifyForwardCopy({ subject: "[Innkommende] Hei (fra Mail Delivery Subsystem)", fromEmail: "kontakt@rettfrabonden.com", headers: {} }).kind, ci.classifyForwardCopy({ subject: "[Innkommende] Leveringstid? (fra Ola <ola@gard.no>)", fromEmail: "kontakt@rettfrabonden.com", headers: {} }).kind, ci.forwardOriginalSender("[Innkommende] X (fra ola@gard.no)")?.email],
          ["bounce", null, "ola@gard.no"], "ci102: classifyForwardCopy reads a bounce from the sender name, leaves a customer subject alone, parses a bare address");
        db.exec("ALTER TABLE crm_thread_aliases RENAME TO crm_thread_aliases_off");
        let threw = false;
        try { ci.resolveThreadAlias("gm-thread-1", { strict: true }); } catch { threw = true; }
        const lenient = ci.resolveThreadAlias("gm-thread-1");
        const customerAnswer = { messageId: "gm-after-alias-err", direction: "in", fromEmail: "kari@testgard.no", subject: "Re: Om bestillingen", bodyText: "Fredag passer", sentAt: new Date().toISOString() };
        const rErr = await call("POST", "/ingest", { threadId: "gm-thread-1", primaryFromEmail: "kari@testgard.no", vertical: "rfb", messages: [customerAnswer] });
        const afterErr = [rErr.status, filed("gm-after-alias-err"), (db.prepare("SELECT COUNT(*) n FROM crm_threads WHERE id = 'gm-thread-1'").get() as any).n];
        db.exec("ALTER TABLE crm_thread_aliases_off RENAME TO crm_thread_aliases");
        eq([threw, lenient], [true, "gm-thread-1"], "ci103: resolveThreadAlias({strict}) lets a DB error through; the lenient form still returns the id");
        eq(afterErr, [500, 0, 0], "ci104: a failed alias lookup on /ingest answers 500 and files nothing (no thread on the Gmail id)");
        const rRetry = await call("POST", "/ingest", { threadId: "gm-thread-1", primaryFromEmail: "kari@testgard.no", vertical: "rfb", messages: [customerAnswer] });
        eq([rRetry.body?.threadId === serverThread1, filed("gm-after-alias-err"), threadStatus()], [true, 1, "new"], "ci104b: the retry files the answer on the server thread and reopens it");
        const nested = "[Innkommende] Re: Bestilling (fra Mail Delivery System (Gmail) <mailer-daemon@googlemail.com>)";
        eq([ci.forwardOriginalSender(nested)?.email, ci.stripForwardSubject(nested), ci.normalizeSubject(nested), ci.classifyForwardCopy({ subject: "[Innkommende] Melding (fra Mail Delivery System (Gmail) <mailer-daemon@googlemail.com>)", fromEmail: "kontakt@rettfrabonden.com", headers: {} as any }).kind],
          ["mailer-daemon@googlemail.com", "Re: Bestilling", "bestilling", "bounce"], "ci105: a sender name with parentheses is parsed whole (address, stripped subject, thread subject, bounce)");
        crm.crmService.setThreadStatus(serverThread1, "done", "claude");
        db.exec("ALTER TABLE crm_actions RENAME TO crm_actions_off");
        const lateAnswer = { messageId: "gm-tx-1", direction: "in", fromEmail: "kari@testgard.no", subject: "Re: Om bestillingen", bodyText: "Lørdag passer bedre", sentAt: new Date().toISOString() };
        const rTx = await call("POST", "/ingest", { threadId: "gm-thread-1", primaryFromEmail: "kari@testgard.no", vertical: "rfb", messages: [lateAnswer] });
        const txState = [rTx.status, filed("gm-tx-1"), threadStatus()];
        db.exec("ALTER TABLE crm_actions_off RENAME TO crm_actions");
        eq(txState, [500, 0, "done"], "ci106: a DB error during the reopen rolls the whole alias branch back (500, nothing filed, still done)");
        await call("POST", "/ingest", { threadId: "gm-thread-1", primaryFromEmail: "kari@testgard.no", vertical: "rfb", messages: [lateAnswer] });
        eq([filed("gm-tx-1"), threadStatus()], [1, "new"], "ci106b: …and the retry files the message and reopens the thread");

        // ci107-ci109: DMARC aggregate and TLS reports are machine mail.
        const H = { messageId: null, inReplyTo: [], references: [], autoSubmitted: null, precedence: null, xAutoreply: false };
        eq([
          ci.classifyAutomated({ subject: "Report domain: rettfrabonden.com Submitter: google.com Report-ID: 15228928930211912773", fromEmail: "noreply-dmarc-support@google.com", headers: H }).kind,
          ci.classifyAutomated({ subject: "Report Domain: opplevagent.no Submitter: enterprise.protection.outlook.com Report-ID: <abc@x>", fromEmail: "someone@microsoft.com", headers: H }).kind,
          ci.classifyAutomated({ subject: "DMARC Aggregate Report for finn-tannlege.com", fromEmail: "rapport@domeneshop.no", headers: H }).kind,
          ci.classifyAutomated({ subject: "Report Domain: rettfrabonden.com Submitter: google.com Report-ID: <2026.11.10T00.00.00Z+rettfrabonden.com@google.com>", fromEmail: "noreply-smtp-tls-reporting@google.com", headers: H }).kind,
        ], ["report", "report", "report", "report"], "ci107: DMARC aggregate reports (Google, Microsoft, Domeneshop) and SMTP TLS reports are «report», by sender or by the providers' report subject");
        eq([
          ci.classifyAutomated({ subject: "Spørsmål om rapport fra Mattilsynet", fromEmail: "kari@testgard.no", headers: H }).kind,
          ci.classifyAutomated({ subject: "Report on our farm", fromEmail: "ola@gard.no", headers: H }).kind,
          ci.classifyAutomated({ subject: "Re: Report domain for nettsiden vår", fromEmail: "ola@gard.no", headers: H }).kind,
          ci.classifyAutomated({ subject: "Fwd: Report domain: gard.no Submitter: google.com Report-ID: 123", fromEmail: "ola@gard.no", headers: H }).kind,
          ci.classifyAutomated({ subject: "DMARC aggregate report – hva betyr dette?", fromEmail: "ola@gard.no", headers: H }).kind,
          ci.classifyAutomated({ subject: "DMARC Aggregate Report for gard.no – kan dere se på den?", fromEmail: "ola@gard.no", headers: H }).kind,
        ], [null, null, null, null, null, null], "ci108: a customer subject that only mentions a report or a domain — or forwards a report with a question — is never taken for one");
        const dm = await hook({ email_id: "em-dmarc-1", from: "noreply-dmarc-support@google.com", to: ["kontakt@rettfrabonden.com"], subject: "Report domain: rettfrabonden.com Submitter: google.com Report-ID: 99887766", created_at: hoursAgo(1) });
        const dmRow = logRow("em-dmarc-1");
        eq([dm.code, dmRow?.crm_status, dmRow?.automated_kind, nr.computeNeedsReply({}).threads.some((t) => t.thread_id === dmRow?.crm_thread_id)],
          [200, "registered", "report", false], "ci109: a DMARC report is filed (and forwarded) but never listed as «trenger svar»");
      }

      // ci110-ci114: the CS agent often files the Gmail copy UNWRAPPED — the
      // original sender and subject instead of the forward's own — with the
      // forward's text verbatim. It is still the copy: no duplicate thread.
      {
        await hook({ email_id: "em-unwrap-1", from: "Ola Nordmann <ola@nordgard.no>", to: ["kontakt@rettfrabonden.com"], subject: "Når kan vi hente?", created_at: hoursAgo(1) });
        const u = logRow("em-unwrap-1");
        const copyText = String(sent[sent.length - 1]?.textContent);
        ok(!!u?.crm_thread_id && copyText.startsWith("Videresent fra:") && copyText.includes(`Inbound-ID: ${u.id}`), "ci110a: setup — the server filed the e-mail and forwarded it with its header block");
        const unwrapped = { messageId: "gm-unwrap-1", direction: "in", fromEmail: "ola@nordgard.no", subject: "Når kan vi hente?", bodyText: copyText, sentAt: hoursAgo(1) };
        eq(ci.forwardCopyMarker(unwrapped), u.id, "ci110: an unwrapped copy (original sender and subject) is recognised by the forward's header block");
        const ru = await call("POST", "/ingest", { threadId: "gm-thread-unwrap", primaryFromEmail: "ola@nordgard.no", vertical: "rfb", messages: [unwrapped] });
        eq([ru.status, ru.body?.threadId, ru.body?.serverRegistered], [200, u.crm_thread_id, true], "ci111: ingest of it answers with the server thread");
        eq([
          (db.prepare("SELECT COUNT(*) n FROM crm_threads WHERE id = 'gm-thread-unwrap'").get() as any).n,
          (db.prepare("SELECT COUNT(*) n FROM crm_messages WHERE id = 'gm-unwrap-1'").get() as any).n,
          (db.prepare("SELECT thread_id FROM crm_thread_aliases WHERE alias_id = 'gm-thread-unwrap'").get() as any)?.thread_id,
        ], [0, 0, u.crm_thread_id], "ci112: no duplicate thread, no duplicate message; the Gmail id becomes an alias");
        eq([
          ci.forwardCopyMarker({ direction: "in", subject: "Re: Når kan vi hente?", bodyText: `Takk!\n\n${copyText}` }),
          ci.forwardCopyMarker({ direction: "in", subject: "Re: Når kan vi hente?", bodyText: copyText.split("\n").map((l) => `> ${l}`).join("\n") }),
          ci.forwardCopyMarker({ direction: "in", subject: "Fwd: Når kan vi hente?", bodyText: `---------- Forwarded message ---------\n${copyText}` }),
          ci.forwardCopyMarker({ direction: "out", subject: "Når kan vi hente?", bodyText: copyText }),
          ci.forwardCopyMarker({ direction: "in", subject: "Når kan vi hente?", bodyText: copyText.replace(/^Inbound-ID: .*$/m, "") }),
        ], [null, null, null, null, null], "ci113: a reply, a quote, a Fwd, an outbound message or a header block without the marker is never taken for the copy");
        eq(ci.forwardCopyMarker({ direction: "in", subject: "Når kan vi hente?", bodyText: "\r\n" + copyText.replace(/\n/g, "\r\n") }), u.id, "ci114: CRLF line ends and a leading blank line still match");
      }

      // ci77-ci78 (review #8): a copy of an e-mail the server parked as untriaged opens no second item
      {
        const u = logRow("em11");
        const untriagedBefore = (db.prepare("SELECT COUNT(*) n FROM crm_untriaged").get() as any).n;
        const uCopy = { messageId: "gm-u-1", direction: "in", fromEmail: "kontakt@rettfrabonden.com", subject: "[Innkommende] Hei (fra x@y.no)", bodyText: `hei\n\n--\nInbound-ID: ${u.id}` };
        const ru = await call("POST", "/ingest", { threadId: "gm-thread-u", primaryFromEmail: "x@y.no", vertical: "rfb", messages: [uCopy] });
        eq([ru.status, ru.body?.parkedUntriaged && ru.body?.untriaged, (db.prepare("SELECT COUNT(*) n FROM crm_untriaged").get() as any).n, (db.prepare("SELECT COUNT(*) n FROM crm_threads WHERE id='gm-thread-u'").get() as any).n],
          [202, true, untriagedBefore, 0], "ci77: the Gmail copy of a parked e-mail is answered as parked (202 + untriaged) — no new thread, no second untriaged item");
        const ru2 = await call("POST", "/ingest", { threadId: "gm-thread-u", primaryFromEmail: "x@y.no", vertical: "rfb", messages: [uCopy, { messageId: "gm-u-2", direction: "out", fromEmail: "da.daniel@example.no", toEmails: ["x@y.no"], subject: "Re: Hei", bodyText: "Hei!", sentAt: new Date().toISOString() }] });
        ok(ru2.status === 200 && (db.prepare("SELECT COUNT(*) n FROM crm_messages WHERE id='gm-u-2'").get() as any).n === 1, "ci78: …but a Daniel reply in that Gmail thread is still filed (nothing lost)");
        eq((db.prepare("SELECT COUNT(*) n FROM crm_messages WHERE id='gm-u-1'").get() as any).n, 0, "ci93: …without filing the parked e-mail's copy a second time");
        ok(typeof ru.body?.untriagedId === "string" && typeof ru.body?.openUntriaged === "number", "ci94: the parked 202 carries untriagedId and openUntriaged like a regular park");
      }

      // ── «trenger svar» ─────────────────────────────────────────────
      const mkThread = (id: string, email: string, category: any, msgs: Array<{ dir: "in" | "out"; h: number; auto?: boolean }>) => {
        crm.crmService.ingestThread(
          { threadId: id, subject: `S ${id}`, category,
            messages: msgs.map((m, i) => ({
              messageId: `${id}-m${i}`, direction: m.dir, fromEmail: m.dir === "in" ? email : "kontakt@rettfrabonden.com",
              toEmails: [m.dir === "in" ? "kontakt@rettfrabonden.com" : email], sentAt: hoursAgo(m.h),
              rawMetadata: m.auto ? { automated: true, automated_kind: "auto_reply" } : {},
            })) },
          email, "rfb");
      };
      mkThread("nr-p0", "a1@x.no", "innkommende", [{ dir: "in", h: 30 }]);
      mkThread("nr-p1", "a2@x.no", "innkommende", [{ dir: "in", h: 13 }]);
      mkThread("nr-new", "a3@x.no", "unknown", [{ dir: "in", h: 1 }]);
      mkThread("nr-answered", "a4@x.no", "innkommende", [{ dir: "in", h: 30 }, { dir: "out", h: 29 }]);
      mkThread("nr-done", "a5@x.no", "innkommende", [{ dir: "in", h: 30 }]);
      crm.crmService.setThreadStatus("nr-done", "done", "claude");
      mkThread("nr-system", "a6@x.no", "system", [{ dir: "in", h: 30 }]);
      mkThread("nr-lev", "a7@x.no", "leverandor", [{ dir: "in", h: 30 }]);
      mkThread("nr-pitch", "a8@x.no", "marketing", [{ dir: "in", h: 30 }]);
      mkThread("nr-outreach-reply", "a9@x.no", "marketing", [{ dir: "out", h: 50 }, { dir: "in", h: 26 }]);
      mkThread("nr-auto", "a10@x.no", "innkommende", [{ dir: "out", h: 50 }, { dir: "in", h: 26, auto: true }]);
      mkThread("nr-mark", "a11@x.no", "innkommende", [{ dir: "in", h: 30 }]);

      const ids = () => nr.computeNeedsReply({ vertical: "rfb" }).threads.map((t) => t.thread_id);
      const rep = nr.computeNeedsReply({ vertical: "rfb" });
      const lvl = (id: string) => rep.threads.find((t) => t.thread_id === id)?.level;
      eq([lvl("nr-p0"), lvl("nr-p1"), lvl("nr-new")], ["p0", "p1", "normal"], "ci50: age → level (30 h p0, 13 h p1, 1 h normal)");
      ok(!ids().includes("nr-answered"), "ci51: an outbound after the inbound clears it");
      ok(!ids().includes("nr-done"), "ci52: a done thread is not listed");
      ok(!ids().includes("nr-system") && !ids().includes("nr-lev"), "ci53: system and leverandor threads are not listed");
      ok(!ids().includes("nr-pitch"), "ci54: an inbound sales pitch (marketing, first message inbound) is not listed");
      ok(ids().includes("nr-outreach-reply"), "ci55: a reply to OUR outreach (marketing, first message outbound) IS listed");
      ok(!ids().includes("nr-auto"), "ci56: a thread whose latest inbound is an auto-reply is not listed");
      ok(ids().includes("compose-bbb"), "ci57: the reopened compose thread (human reply em8) is listed");

      const m1 = nr.markNoReplyNeeded("nr-mark", "Takk-melding, ingen spørsmål", "claude");
      ok(m1.ok === true && !ids().includes("nr-mark"), "ci58: «trenger ikke svar» removes it from the list");
      crm.crmService.ingestThread({ threadId: "nr-mark", messages: [{ messageId: "nr-mark-late", direction: "in", fromEmail: "a11@x.no", sentAt: new Date(Date.now() + 2000).toISOString() }] }, "a11@x.no", "rfb");
      ok(ids().includes("nr-mark"), "ci59: a NEW inbound after the mark puts it back on the list");
      eq(nr.markNoReplyNeeded("nr-mark", "  ", "claude"), { ok: false, error: "reason_required" }, "ci60: a reason is required");
      eq(nr.markNoReplyNeeded("does-not-exist", "x", "claude"), { ok: false, error: "thread_not_found" }, "ci61: unknown thread refused");

      const all = nr.computeNeedsReply({});
      ok(all.untriaged.some((u) => u.thread_id === "inbound-" + logRow("em11")?.id), "ci62: open untriaged rows are reported");
      ok(all.counts.forward_failed >= 2, "ci63: failed forwards are counted (em2, em3)");
      ok(all.counts.by_vertical.experiences === 1 && all.counts.by_vertical.dental === 1, "ci64: counts per platform (experiences em9, dental em10)");

      const g = await call("GET", "/needs-reply?vertical=rfb");
      ok(g.status === 200 && Array.isArray(g.body?.threads) && g.body.threads.some((t: any) => t.thread_id === "nr-p0"), "ci65: GET /needs-reply serves the report");
      const p1 = await call("POST", "/threads/nr-p1/no-reply-needed", { reason: "Bare takk", actor: "daniel" });
      eq([p1.status, (db.prepare("SELECT no_reply_by FROM crm_thread_flags WHERE thread_id='nr-p1'").get() as any)?.no_reply_by], [200, "daniel"], "ci66: POST no-reply-needed stores the mark");
      eq((await call("POST", "/threads/nr-p1/no-reply-needed", {})).status, 400, "ci67: POST without reason → 400");
      eq((await call("POST", "/threads/nope/no-reply-needed", { reason: "x" })).status, 404, "ci68: unknown thread → 404");

      // ci79-ci81 (review #5-#7)
      eq(ci.normalizeSubject("Re: [Innkommende] Hei der (fra Kari <k@x.no>)"), "hei der", "ci79: «Re: [Innkommende] X (fra …)» normalises to X");
      mkThread("nr-auto-hides", "a12@x.no", "innkommende", [{ dir: "in", h: 30 }, { dir: "in", h: 2, auto: true }]);
      const ah = nr.computeNeedsReply({ vertical: "rfb" }).threads.find((t) => t.thread_id === "nr-auto-hides");
      ok(!!ah && ah.level === "p0" && ah.age_hours >= 29, "ci80: a later auto-reply does not hide an earlier unanswered human message (clock from the human one)");
      crm.crmService.ingestThread(
        { threadId: "ts-mix", subject: "Tid", category: "innkommende",
          messages: [
            { messageId: "ts-mix-1", direction: "in", fromEmail: "a13@x.no", sentAt: "2026-11-09T08:00:00Z" },
            { messageId: "ts-mix-2", direction: "in", fromEmail: "a13@x.no", sentAt: "2026-11-09 09:30:00" },
          ] },
        "a13@x.no", "rfb");
      eq((db.prepare("SELECT last_inbound_at FROM crm_threads WHERE id = 'ts-mix'").get() as any)?.last_inbound_at, "2026-11-09 09:30:00", "ci81: thread stats pick the latest by time, not by string, across mixed formats");
      crm.crmService.ingestThread(
        { threadId: "nr-odd-date", subject: "Rar dato", category: "innkommende",
          messages: [{ messageId: "nr-odd-date-1", direction: "in", fromEmail: "a14@x.no", sentAt: "10 Nov 2026 08:00" }] },
        "a14@x.no", "rfb");
      ok(nr.computeNeedsReply({}).threads.some((t) => t.thread_id === "nr-odd-date"), "ci87: an inbound with a sent_at julianday cannot parse is still listed (falls back to received_at)");
      crm.crmService.ingestThread(
        { threadId: "nr-odd-outreach", subject: "Utsending", category: "marketing",
          messages: [
            { messageId: "nr-odd-outreach-1", direction: "out", fromEmail: "kontakt@rettfrabonden.com", toEmails: ["a15@x.no"], sentAt: hoursAgo(50) },
            { messageId: "nr-odd-outreach-2", direction: "in", fromEmail: "a15@x.no", sentAt: "Tue, 10 Nov 2026 08:00:00 +0100" },
          ] },
        "a15@x.no", "rfb");
      ok(nr.computeNeedsReply({}).threads.some((t) => t.thread_id === "nr-odd-outreach"), "ci95: a reply to our outreach with an RFC 2822 date is still a reply (not taken for an inbound pitch)");
    } catch (err: any) {
      failed++;
      failures.push("unexpected error: " + String(err?.stack || err));
    } finally {
      try { db.close(); } catch { /* already closed */ }
      initMod.__setDbForTesting(prevDb as any);
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      __resetDbFactoryForTesting();
      if (prevAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
      else process.env.ANALYTICS_ADMIN_KEY = prevAdminKey;
      if (prevResendKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevResendKey;
    }

    if (log) console.log(`\n${passed} passed, ${failed} failed`);
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runCsInboundTests({ log: true }).then((s) => {
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
