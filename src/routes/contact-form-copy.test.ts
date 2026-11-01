/**
 * contact-form-copy.test.ts — e-mail copy of every contact-form submission
 * (POST /api/contact) to ADMIN_NOTIFICATION_EMAIL. Daniel asked for it on
 * 2026-11-01: the form only wrote a CRM thread, so nothing reached his inbox.
 *
 *   a  ADMIN_NOTIFICATION_EMAIL set: 200 + the unchanged success body, one CRM
 *      thread (written as before), exactly one e-mail to that address —
 *      text-only, Reply-To = the visitor, subject «[Kontaktskjema · <label>]
 *      <subject>», body with name, e-mail, message and the thread id.
 *   b  a subject carrying "\r\nBcc: …" is flattened to one line (no header
 *      injection) and the whole subject is capped at 150 characters.
 *   c  an empty subject becomes «Ny melding».
 *   d  ADMIN_NOTIFICATION_EMAIL unset: still 200 + thread, no e-mail.
 *   e  sendEmail rejects, throws or never settles: still 200 + thread, nothing
 *      thrown, no unhandled rejection, no visitor address/message in the logs.
 *   f  honeypot and invalid input send no e-mail and write nothing.
 *   g  each platform (given or inferred from the host) gets its own label.
 *
 * Real contact router on the production schema in an in-memory DB; the POST
 * handler is pulled off the router stack and driven with fake req/res (same
 * harness as owner-opening-hours-json-t0d.test.ts). emailService.sendEmail —
 * the instance sendAdminContactFormCopy sends through — is stubbed to capture.
 * verifyTurnstile passes because NODE_ENV=test; every touched env var is
 * restored in finally.
 * Exported runContactFormCopyTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone:
 *   npx tsx src/routes/contact-form-copy.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HandlerResult {
  status: number;
  body: any;
}

const ADMIN_MAIL = "admin@plattform.example.test";
const ENV_KEYS = ["NODE_ENV", "ADMIN_NOTIFICATION_EMAIL"] as const;
const OK_BODY = { success: true, message: "Takk! Vi svarer så snart vi kan." };
const STUB_ERR = "stub-smtp-feil";
const FINAL_LINE = "Svar på denne e-posten går rett til avsenderen. Svaret havner ikke av seg selv i CRM-tråden.";
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export async function runContactFormCopyTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.info(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.info("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void { assertEq(!!cond, true, label); }

  const initMod = require("../database/init") as typeof import("../database/init");
  const emailMod = require("../services/email-service") as typeof import("../services/email-service");
  const svc = emailMod.emailService as any;
  const hadOwnSend = Object.prototype.hasOwnProperty.call(svc, "sendEmail");
  const prevSend = svc.sendEmail;
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];

  function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  // A fresh documentation-range IP per request, so the route's 3/hour per-IP
  // limit never answers 429 here.
  let ipN = 0;
  function makeReq(body: Record<string, unknown>, host: string): any {
    const headers: Record<string, string> = { host };
    return {
      method: "POST", url: "/contact", path: "/contact", originalUrl: "/api/contact",
      body, query: {}, headers, hostname: host, ip: `198.51.100.${++ipN}`,
      get(name: string) { return headers[name.toLowerCase()]; },
    };
  }
  function invoke(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body }); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { settle(p); return res; },
        send(p: any) { settle(p); return res; },
        end() { settle(undefined); return res; },
        header() { return res; }, set() { return res; }, setHeader() { return res; },
      };
      try {
        const p = handler(req, res, (err?: any) => settle({ __next: true, err: err ? String(err) : undefined }));
        if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
      } catch (err) {
        settle({ __error: String(err) });
      }
    });
  }

  const prevLog = console.log;
  const prevWarn = console.warn;
  const prevError = console.error;
  const errorLog: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  let restoreDb: (() => void) | null = null;

  try {
    console.log = () => { /* silence route/service logging */ };
    console.warn = (...a: unknown[]) => { errorLog.push(a.map(String).join(" ")); };
    console.error = (...a: unknown[]) => { errorLog.push(a.map(String).join(" ")); };
    process.on("unhandledRejection", onUnhandled);
    restoreDb = initMod.__pinInMemoryDbForTesting();
    const db = initMod.__peekDbForTesting()!;
    // verifyTurnstile skips the Cloudflare call only under NODE_ENV=test.
    process.env.NODE_ENV = "test";

    const contactMod = require("./contact") as typeof import("./contact");
    const handler = findRouteHandler(contactMod.default, "/contact", "post");

    let sent: any[] = [];
    let sendImpl: (o: any) => any = async () => ({ success: true, messageId: "stub" });
    svc.sendEmail = (o: any) => { sent.push(o); return sendImpl(o); };

    // Lets the fire-and-forget copy run to its end before we look.
    const flush = () => new Promise<void>((r) => setImmediate(r));
    const submit = async (body: Record<string, unknown>, host = "rettfrabonden.com"): Promise<HandlerResult> => {
      const r = await invoke(handler, makeReq(body, host));
      await flush();
      return r;
    };
    const threadCount = () => (db.prepare("SELECT COUNT(*) n FROM crm_threads").get() as any).n as number;
    const lastThread = () => db.prepare(
      "SELECT t.id, t.subject, t.vertical_id, m.body_text FROM crm_threads t JOIN crm_messages m ON m.thread_id = t.id ORDER BY t.rowid DESC LIMIT 1",
    ).get() as any;
    const stubRejections = () => unhandled.filter((r: any) => String(r?.message ?? r).includes(STUB_ERR));

    process.env.ADMIN_NOTIFICATION_EMAIL = ADMIN_MAIL;

    // ── a: the copy goes out, text-only, Reply-To the visitor ────────────
    {
      const MSG = "Hei!\nKan dere levere til Bergen?\n<b>ikke html</b> & takk";
      sent = [];
      const before = threadCount();
      const r = await submit({ name: "Kari Nordmann", email: "kari@example.no", subject: "Spørsmål om levering", message: MSG, platform: "rfb" });
      assertEq([r.status, r.body], [200, OK_BODY], "a-01: 200 + the unchanged success body");
      assertEq(threadCount() - before, 1, "a-02: exactly one CRM thread is created");
      const t = lastThread();
      assertEq([t?.subject, t?.body_text, t?.vertical_id],
        ["[Kontaktskjema] Spørsmål om levering", `Navn: Kari Nordmann\nE-post: kari@example.no\n\n${MSG}`, "rfb"],
        "a-03: the CRM thread and message are written exactly as before");
      assertEq(sent.length, 1, "a-04: exactly one e-mail is sent");
      const m = sent[0] || {};
      assertEq(m.to, ADMIN_MAIL, "a-05: it goes to ADMIN_NOTIFICATION_EMAIL");
      assertTrue(!("htmlContent" in m), "a-06: text-only — no htmlContent is passed");
      assertEq(m.replyTo, "kari@example.no", "a-07: Reply-To is the visitor, so «Svar» reaches them");
      assertEq(m.subject, "[Kontaktskjema · Rett fra Bonden] Spørsmål om levering", "a-08: subject = [Kontaktskjema · label] + the visitor's subject");
      assertTrue(typeof t?.id === "string" && t.id.startsWith("kontakt-"), "a-09: the thread id is the route's kontakt-<uuid>");
      assertEq(m.textContent, [
        "Plattform: Rett fra Bonden",
        "Navn: Kari Nordmann",
        "E-post: kari@example.no",
        "Emne: Spørsmål om levering",
        "",
        MSG,
        "",
        `CRM-tråd: ${t?.id}`,
        FINAL_LINE,
      ].join("\n"), "a-10: body = Plattform/Navn/E-post/Emne, the message as given, the CRM thread id and the reply note");
      assertTrue(["Kari Nordmann", "kari@example.no", MSG, String(t?.id)].every((s) => String(m.textContent).includes(s)),
        "a-11: the body carries name, e-mail, message and thread id");
      assertEq([m.omitAgentHeader, m.redactRecipientInLogs], [true, true], "a-12: no outreach header; addresses kept out of the send log");
    }

    // ── b: CR/LF and other controls never reach the header; subject capped ──
    {
      const evil = "Hjelp\r\nBcc: x@y.example\t\u2028\u0085" + "a".repeat(170);
      sent = [];
      const before = threadCount();
      const r = await submit({ name: "Ola", email: "ola@example.no", subject: evil, message: "Test", platform: "rfb" });
      assertEq([r.status, r.body?.success, threadCount() - before], [200, true, 1], "b-01: still 200 + one thread");
      const s = String(sent[0]?.subject ?? "");
      assertTrue(sent.length === 1 && !/[\r\n]/.test(s), `b-02: no CR/LF in the subject (got ${JSON.stringify(s)})`);
      assertTrue(!CONTROL_RE.test(s), "b-03: no other control or line-separator characters either");
      assertTrue(s.startsWith("[Kontaktskjema · Rett fra Bonden] Hjelp Bcc: x@y.example a"), "b-04: the text survives on one line («Bcc:» is just text)");
      assertEq([Array.from(s).length, s.endsWith("…")], [150, true], "b-05: the whole subject is capped at 150 characters, ending in …");
      const text = String(sent[0]?.textContent ?? "");
      assertTrue(text.split("\n")[3].startsWith("Emne: Hjelp Bcc: x@y.example") && !/\nBcc:/.test(text),
        "b-06: the body's Emne line is one line too");

      sent = [];
      await submit({ name: "Ola", email: "ola@example.no", subject: "Kort emne", message: "Test", platform: "rfb" });
      assertEq(sent[0]?.subject, "[Kontaktskjema · Rett fra Bonden] Kort emne", "b-07: a short subject is not cut");
    }

    // ── c: empty subject → «Ny melding» ──────────────────────────────────
    {
      for (const [tag, subj] of [["empty", ""], ["blank", "   "], ["absent", undefined]] as const) {
        sent = [];
        const body: Record<string, unknown> = { name: "Per", email: "per@example.no", message: "Hei", platform: "rfb" };
        if (subj !== undefined) body.subject = subj;
        const r = await submit(body);
        assertEq([r.status, sent.length, sent[0]?.subject], [200, 1, "[Kontaktskjema · Rett fra Bonden] Ny melding"],
          `c-01 (${tag}): no subject → «Ny melding»`);
        assertEq(String(sent[0]?.textContent ?? "").split("\n")[3], "Emne: (ikke oppgitt)", `c-02 (${tag}): the body says the subject was not given`);
      }
    }

    // ── d: ADMIN_NOTIFICATION_EMAIL unset → no e-mail, response unchanged ─
    {
      delete process.env.ADMIN_NOTIFICATION_EMAIL;
      sent = [];
      const before = threadCount();
      const r = await submit({ name: "Siri", email: "siri@example.no", subject: "Uten admin", message: "Hei", platform: "rfb" });
      assertEq([r.status, r.body, threadCount() - before, sent.length], [200, OK_BODY, 1, 0],
        "d-01: unset → still 200 + thread, and nothing is sent");
      const direct = await emailMod.emailService.sendAdminContactFormCopy({
        platform: "rfb", name: "Siri", email: "siri@example.no", subject: "x", message: "y", threadId: "kontakt-d",
      });
      assertEq([direct, sent.length], [{ success: true, messageId: "NO_ADMIN_EMAIL" }, 0], "d-02: the service reports NO_ADMIN_EMAIL and sends nothing");
      process.env.ADMIN_NOTIFICATION_EMAIL = ADMIN_MAIL;
    }

    // ── e: a failing or slow send never changes the response ─────────────
    {
      const VISITOR = "feil-avsender@example.no";
      const MARK = "HEMMELIG-MELDING-E";
      const cases: Array<[string, (o: any) => any]> = [
        ["rejects", async () => { throw new Error(`${STUB_ERR} for ${VISITOR}`); }],
        ["throws synchronously", () => { throw new Error(`${STUB_ERR} for ${VISITOR}`); }],
      ];
      for (const [tag, impl] of cases) {
        sendImpl = impl;
        sent = [];
        const before = threadCount();
        const logFrom = errorLog.length;
        let threw = "";
        let r: HandlerResult = { status: -1, body: null };
        try {
          r = await submit({ name: "Eva", email: VISITOR, subject: "Feiltest", message: `Tekst ${MARK}`, platform: "rfb" });
          await flush();
        } catch (err: any) { threw = String(err?.message || err); }
        assertEq([threw, r.status, r.body, threadCount() - before, sent.length], ["", 200, OK_BODY, 1, 1],
          `e-01 (${tag}): still 200 + thread, nothing thrown (the send was attempted)`);
        assertEq(stubRejections().length, 0, `e-02 (${tag}): no unhandled rejection`);
        const lines = errorLog.slice(logFrom);
        assertTrue(lines.length > 0 && lines.every((l) => !l.includes(VISITOR) && !l.includes(MARK)),
          `e-03 (${tag}): the failure is logged without the visitor's address or message (got ${JSON.stringify(lines)})`);
      }

      // Never settles: the response must not wait for it.
      sendImpl = () => new Promise(() => { /* hangs forever */ });
      sent = [];
      const before = threadCount();
      let timer: NodeJS.Timeout | undefined;
      const r = await Promise.race([
        submit({ name: "Eva", email: VISITOR, subject: "Treg", message: "Hei", platform: "rfb" }),
        new Promise<HandlerResult>((res) => { timer = setTimeout(() => res({ status: -1, body: "timeout" }), 2000); }),
      ]);
      if (timer) clearTimeout(timer);
      assertEq([r.status, r.body, threadCount() - before, sent.length], [200, OK_BODY, 1, 1],
        "e-04 (never settles): the response does not wait for the e-mail");

      sendImpl = () => { throw new Error(`${STUB_ERR} direct`); };
      let threw = "";
      let direct: any = null;
      try {
        direct = await emailMod.emailService.sendAdminContactFormCopy({
          platform: "dental", name: "A", email: "a@example.no", subject: "", message: "m", threadId: "kontakt-e",
        });
      } catch (err: any) { threw = String(err?.message || err); }
      assertEq([threw, direct?.success, typeof direct?.error], ["", false, "string"], "e-05: the service itself never throws — {success:false, error}");
      sendImpl = async () => ({ success: true, messageId: "stub" });
    }

    // ── f: honeypot and invalid input send nothing ───────────────────────
    {
      const valid = { name: "Nina", email: "nina@example.no", subject: "Hei", message: "Melding", platform: "rfb" };
      const cases: Array<[string, Record<string, unknown>, number, string]> = [
        ["honeypot", { ...valid, _honey: "bot" }, 400, "invalid"],
        ["missing message", { ...valid, message: "" }, 422, "missing_required_fields"],
        ["invalid e-mail", { ...valid, email: "ikke-en-adresse" }, 422, "invalid_email"],
        ["too long", { ...valid, message: "x".repeat(2001) }, 422, "field_too_long"],
        ["unknown platform", { ...valid, platform: "opplevagent" }, 422, "invalid_platform"],
      ];
      for (const [tag, body, status, error] of cases) {
        sent = [];
        const before = threadCount();
        const r = await submit(body);
        assertEq([r.status, r.body?.error, threadCount() - before, sent.length], [status, error, 0, 0],
          `f-01 (${tag}): ${status} ${error}, nothing written, no e-mail`);
      }
    }

    // ── g: each platform gets its label ──────────────────────────────────
    {
      const cases: Array<[string, Record<string, unknown>, string, string, string]> = [
        ["rfb", { platform: "rfb" }, "rettfrabonden.com", "rfb", "Rett fra Bonden"],
        ["experiences", { platform: "experiences" }, "rettfrabonden.com", "experiences", "Opplevagent"],
        ["dental", { platform: "dental" }, "rettfrabonden.com", "dental", "Finn-tannlege"],
        ["inferred opplevagent.no", {}, "opplevagent.no", "experiences", "Opplevagent"],
        ["inferred finn-tannlege.com", {}, "finn-tannlege.com", "dental", "Finn-tannlege"],
      ];
      for (const [tag, extra, host, vertical, label] of cases) {
        sent = [];
        const r = await submit({ name: "Gunn", email: "gunn@example.no", subject: "Plattformtest", message: "Hei", ...extra }, host);
        const t = lastThread();
        assertEq([r.status, t?.vertical_id, sent[0]?.subject, String(sent[0]?.textContent ?? "").split("\n")[0]],
          [200, vertical, `[Kontaktskjema · ${label}] Plattformtest`, `Plattform: ${label}`],
          `g-01 (${tag}): ${vertical} → «${label}» in subject and body`);
      }
    }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    console.warn = prevWarn;
    console.error = prevError;
    process.off("unhandledRejection", onUnhandled);
    if (hadOwnSend) svc.sendEmail = prevSend; else delete svc.sendEmail;
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k];
    }
    if (restoreDb) restoreDb();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runContactFormCopyTests({ log: true }).then((r) => {
    console.info(`contact-form-copy: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
