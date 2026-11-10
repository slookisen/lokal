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
        crmRouter.handle(req, res, () => settle());
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
