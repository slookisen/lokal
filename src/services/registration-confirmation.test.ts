/**
 * registration-confirmation.test.ts — S1 (2026-11-10): flagged confirmation
 * mail to a producer who self-registers through the public
 * POST /api/marketplace/register.
 *
 * Drives the REAL /register handler (pulled off the marketplace router's own
 * stack, fake req/res, no port — same harness shape as
 * routes/marketplace-quarantine-gates.test.ts) on its own in-memory DB
 * (__pinInMemoryDbForTesting), with the emailService singleton's transporter
 * swapped for a recording stub (`isConfigured = true; transporter = {...}`,
 * the repo-wide pattern), restored in `finally` together with the flag.
 *
 * Cases:
 *   1. flag off → 201, nothing sent, nothing written to the send log.
 *   2. flag on → exactly one send: to / from / replyTo / subject / text / html;
 *      201 body unchanged; log row under the normalized address.
 *   3. same address (other case / whitespace) within 24 h → no second send;
 *      after > 24 h (stored timestamp moved back, and an injected clock) →
 *      sends again.
 *   4. rejected registrations (blocklist 403, validation 400, theme spam 400)
 *      → no send.
 *   5. send throws → 201 still returned, no crash, nothing recorded.
 *   6. no address → no send.
 *   7. is_vetted stays 0 (origin self_registered) with the flag on.
 *   + flag must be exactly "true"; dry-run is not recorded; HTML escapes the
 *     name; two concurrent sends for one address → one mail.
 *
 * Exported runRegistrationConfirmationTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/registration-confirmation.test.ts
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

export async function runRegistrationConfirmationTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  function findRouteHandler(router: any, path: string, method: "post"): Function {
    const layer = (router.stack as any[]).find(
      (l: any) => l.route && l.route.path === path && l.route.methods?.[method],
    );
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }

  function makeReq(body: any): any {
    return {
      params: {},
      body,
      query: {},
      headers: {},
      ip: "127.0.0.1",
      lang: "no",
      protocol: "https",
      get(name: string) {
        if (name.toLowerCase() === "host") return "rettfrabonden.com";
        return undefined;
      },
    };
  }

  function invokeHandler(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const settle = (body: any) => {
        if (settled) return;
        settled = true;
        resolve({ status, body });
      };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(payload: any) { settle(payload); return res; },
        send(payload: any) { settle(payload); return res; },
        end() { settle(undefined); return res; },
        header() { return res; },
        set() { return res; },
        type() { return res; },
        setHeader() { return res; },
      };
      try {
        const maybePromise = handler(req, res, () => settle({ __next: true }));
        if (maybePromise && typeof maybePromise.catch === "function") {
          maybePromise.catch((err: any) => settle({ __error: String(err) }));
        }
      } catch (err) {
        settle({ __error: String(err) });
      }
    });
  }

  let seq = 0;
  function regBody(email: string | undefined, overrides: Record<string, unknown> = {}): any {
    seq++;
    const body: any = {
      name: `Testgården Bekreftelse ${seq}`,
      description: "Vi selger poteter, gulrøtter og egg fra egen gård.",
      provider: `Testgården ${seq}`,
      url: `https://testgarden-bekreftelse-${seq}.example.test`,
      role: "producer",
      skills: [{ id: "sell-vegetables", name: "Grønnsaker", description: "Selger grønnsaker", tags: ["poteter"] }],
      ...overrides,
    };
    if (email !== undefined) body.contactEmail = email;
    return body;
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const restoreDb = initMod.__pinInMemoryDbForTesting();
  const prevFlag = process.env.REGISTRATION_CONFIRMATION_EMAIL_ENABLED;

  const emailMod = require("./email-service") as typeof import("./email-service");
  const svc = emailMod.emailService as any;
  const prevIsConfigured = svc.isConfigured;
  const prevTransporter = svc.transporter;

  try {
    const db = initMod.getDb();
    const { loadConfigsAtBoot, getConfig } = require("../config/vertical-config") as
      typeof import("../config/vertical-config");
    try { getConfig(); } catch { try { loadConfigsAtBoot(); } catch { /* CI without verticals/ */ } }

    const rc = require("./registration-confirmation") as typeof import("./registration-confirmation");
    const texts = require("./registration-confirmation-texts") as typeof import("./registration-confirmation-texts");
    const { addManualEntry } = require("./blocklist-service") as typeof import("./blocklist-service");
    const { marketplaceRegistry } = require("./marketplace-registry") as typeof import("./marketplace-registry");
    (marketplaceRegistry as any)._agentsCache = null;
    const marketplaceRouter = (require("../routes/marketplace") as any).default;
    const registerHandler = findRouteHandler(marketplaceRouter, "/register", "post");

    let wire: any[] = [];
    let throwOnSend = false;
    svc.isConfigured = true;
    svc.transporter = {
      sendMail: async (o: any) => {
        if (throwOnSend) throw new Error("smtp down for ola@example.test");
        wire.push(o);
        return { messageId: `wire-${wire.length}` };
      },
    };

    const logCount = () =>
      (db.prepare("SELECT COUNT(*) AS n FROM registration_confirmation_email_log").get() as { n: number }).n;
    const register = async (body: any) => {
      const r = await invokeHandler(registerHandler, makeReq(body));
      await rc.__drainRegistrationConfirmationsForTesting();
      return r;
    };

    // ── 1. flag off ────────────────────────────────────────────────────
    delete process.env.REGISTRATION_CONFIRMATION_EMAIL_ENABLED;
    const off = await register(regBody("av@example.test"));
    assertEq(off.status, 201, "1a: flag unset → /register still 201");
    assertEq(wire.length, 0, "1b: flag unset → nothing sent");
    assertEq(logCount(), 0, "1c: flag unset → nothing written to registration_confirmation_email_log");
    for (const v of ["false", "TRUE", "1", "yes", " true"]) {
      process.env.REGISTRATION_CONFIRMATION_EMAIL_ENABLED = v;
      const r = await register(regBody(`av-${v.trim() || "blank"}@example.test`));
      assertEq([r.status, wire.length, logCount()], [201, 0, 0], `1d: flag ${JSON.stringify(v)} (not exactly "true") → off`);
    }
    {
      // Off means not even a DB read: a db thunk that throws is never called.
      let dbCalled = false;
      delete process.env.REGISTRATION_CONFIRMATION_EMAIL_ENABLED;
      rc.scheduleRegistrationConfirmation(
        { email: "x@example.test", name: "X" },
        { db: () => { dbCalled = true; throw new Error("must not be called"); } },
      );
      await rc.__drainRegistrationConfirmationsForTesting();
      assertEq(dbCalled, false, "1e: flag off → schedule does not touch the DB");
    }
    const offBodyKeys = Object.keys(off.body).concat(Object.keys(off.body.data ?? {}));

    // ── 2. flag on: exactly one send ───────────────────────────────────
    process.env.REGISTRATION_CONFIRMATION_EMAIL_ENABLED = "true";
    const supportEmail = `kontakt@${getConfig().connectors.resend_domain}`;
    const firstBody = regBody("Kari.Nordmann@Example.TEST", { name: "Kari <b>&</b> Gård" });
    const on = await register(firstBody);
    assertEq(on.status, 201, "2a: flag on → /register 201");
    assertEq(
      Object.keys(on.body).concat(Object.keys(on.body.data ?? {})),
      offBodyKeys,
      "2b: 201 body has the same shape as with the flag off",
    );
    assertEq([on.body.success, on.body.message], [true, "Agent registrert i Lokal-markedsplassen"], "2c: 201 body unchanged");
    assertEq(wire.length, 1, "2d: flag on → exactly one send");
    const m = wire[0] ?? {};
    assertEq(m.to, "Kari.Nordmann@Example.TEST", "2e: to = the registration's contactEmail as given");
    assertEq(m.replyTo, supportEmail, "2f: replyTo = customer service (supportEmail)");
    assertEq(m.from, process.env.SMTP_FROM || supportEmail, "2g: from = the default sender");
    assertEq(m.subject, texts.REGISTRATION_CONFIRMATION_SUBJECT, "2h: subject");
    assertEq(m.text, texts.buildRegistrationConfirmationText("Kari <b>&</b> Gård"), "2i: text body from the builder");
    assertEq(m.html, texts.buildRegistrationConfirmationHtml("Kari <b>&</b> Gård"), "2j: html body from the builder");
    assertTrue(
      typeof m.html === "string" && m.html.includes("Kari &lt;b&gt;&amp;&lt;/b&gt; Gård") && !m.html.includes("<b>"),
      "2k: html escapes the producer name",
    );
    assertTrue(
      typeof m.text === "string" && m.text.includes("innen to virkedager") && m.text.includes("kundeservice") && m.text.trimEnd().endsWith("Rett fra Bonden"),
      "2l: text says two working days, replies to customer service, signed Rett fra Bonden",
    );
    assertEq(m.headers?.["X-Lokal-Agent"], undefined, "2m: no outreach agent header on this transactional mail");
    const row = db
      .prepare("SELECT email_normalized, last_agent_id, send_count FROM registration_confirmation_email_log")
      .all() as any[];
    assertEq(row, [{ email_normalized: "kari.nordmann@example.test", last_agent_id: on.body.data.id, send_count: 1 }], "2n: one log row under the normalized address");

    // ── 7. is_vetted untouched ─────────────────────────────────────────
    const agentRow = db.prepare("SELECT origin, is_vetted FROM agents WHERE id = ?").get(on.body.data.id) as any;
    assertEq([agentRow?.origin, agentRow?.is_vetted], ["self_registered", 0], "7a: flag on → agent stays self_registered with is_vetted = 0");

    // ── 3. 24 h limit ──────────────────────────────────────────────────
    const again = await register(regBody("kari.nordmann@example.test"));
    assertEq(again.status, 201, "3a: second registration within 24 h → 201");
    assertEq(wire.length, 1, "3b: same address (lowercase) within 24 h → no second send");
    await register(regBody("KARI.NORDMANN@EXAMPLE.TEST"));
    assertEq(wire.length, 1, "3c: same address (upper case) within 24 h → no second send");
    // Zod's .email() rejects surrounding whitespace at the route, so the
    // trim half of the normalization is proven on the module directly.
    assertEq(
      await rc.sendRegistrationConfirmationIfDue(
        { email: "\tKari.Nordmann@EXAMPLE.test  ", name: "K" },
        { send: async () => { throw new Error("must not send"); } },
      ),
      { sent: false, reason: "recently_sent" },
      "3c2: same address with surrounding whitespace + other case → recently_sent",
    );
    assertEq(rc.normalizeRegistrationEmail("  A.B@Example.TEST\n"), "a.b@example.test", "3c3: normalize = trim + lowercase");
    db.prepare("UPDATE registration_confirmation_email_log SET last_sent_at = ? WHERE email_normalized = ?")
      .run(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), "kari.nordmann@example.test");
    await register(regBody("Kari.Nordmann@example.test"));
    assertEq(wire.length, 2, "3d: after > 24 h (stored timestamp moved back) → sends again");
    assertEq(
      (db.prepare("SELECT send_count FROM registration_confirmation_email_log WHERE email_normalized = ?").get("kari.nordmann@example.test") as any)?.send_count,
      2,
      "3e: the row is updated, not duplicated",
    );
    {
      // Injected clock: 23 h 59 m later → skipped; 24 h + 1 s later → sent.
      const sends: string[] = [];
      const send = async (to: string) => { sends.push(to); return { success: true, messageId: "clock" }; };
      const t0 = new Date("2026-11-10T08:00:00.000Z");
      const r0 = await rc.sendRegistrationConfirmationIfDue({ email: "klokke@example.test", name: "K" }, { send, now: () => t0 });
      const r1 = await rc.sendRegistrationConfirmationIfDue(
        { email: " Klokke@Example.test", name: "K" },
        { send, now: () => new Date(t0.getTime() + 24 * 3600_000 - 60_000) },
      );
      const r2 = await rc.sendRegistrationConfirmationIfDue(
        { email: "KLOKKE@example.test", name: "K" },
        { send, now: () => new Date(t0.getTime() + 24 * 3600_000 + 1_000) },
      );
      assertEq([r0, r1, r2], [{ sent: true }, { sent: false, reason: "recently_sent" }, { sent: true }], "3f: injected clock — inside 24 h skipped, after 24 h sent");
      assertEq(sends.length, 2, "3g: injected clock — two sends in total");
    }

    // ── 4. rejected registrations → no send ────────────────────────────
    const before4 = wire.length;
    addManualEntry({ identifierType: "email", identifierValue: "blokkert@example.test", reason: "test" });
    const blocked = await register(regBody("blokkert@example.test"));
    assertEq(blocked.status, 403, "4a: blocklisted address → 403");
    const invalid = await register(regBody("ugyldig@example.test", { description: "kort" }));
    assertEq(invalid.status, 400, "4b: validation failure → 400");
    const spam = await register(regBody("spam@example.test", { description: "Beste nettcasino med free spins og bonus hver dag." }));
    assertEq(spam.status, 400, "4c: theme spam → 400");
    const badEmail = await register(regBody("ikke-en-adresse"));
    assertEq(badEmail.status, 400, "4d: invalid contactEmail → 400");
    assertEq(wire.length, before4, "4e: no send for any rejected registration");
    assertEq(
      (db.prepare("SELECT COUNT(*) AS n FROM registration_confirmation_email_log WHERE email_normalized IN ('blokkert@example.test','ugyldig@example.test','spam@example.test')").get() as any).n,
      0,
      "4f: no log row for rejected registrations",
    );

    // ── 5. send fails ──────────────────────────────────────────────────
    throwOnSend = true;
    const failing = await register(regBody("feiler@example.test"));
    throwOnSend = false;
    assertEq(failing.status, 201, "5a: transport throws → /register still 201");
    assertTrue(!!failing.body?.data?.id, "5b: transport throws → 201 body still carries the agent id");
    assertEq(
      (db.prepare("SELECT COUNT(*) AS n FROM registration_confirmation_email_log WHERE email_normalized = 'feiler@example.test'").get() as any).n,
      0,
      "5c: failed send is not recorded (next registration may try again)",
    );
    {
      const r = await rc.sendRegistrationConfirmationIfDue(
        { email: "kaster@example.test", name: "K" },
        { send: async () => { throw new Error("boom kaster@example.test"); } },
      );
      assertEq(r, { sent: false, reason: "error" }, "5d: a sender that throws → caught, reason error");
      const r2 = await rc.sendRegistrationConfirmationIfDue(
        { email: "kaster@example.test", name: "K" },
        { send: async () => ({ success: true, messageId: "DRY_RUN" }) },
      );
      assertEq(r2, { sent: false, reason: "dry_run" }, "5e: dry-run send is not recorded");
      let threw = false;
      try {
        rc.scheduleRegistrationConfirmation(
          { email: "kaster@example.test", name: "K" },
          { db: () => { throw new Error("db gone"); } },
        );
        await rc.__drainRegistrationConfirmationsForTesting();
      } catch { threw = true; }
      assertEq(threw, false, "5f: schedule with a failing DB never throws");
    }

    // ── 6. no address → no send ────────────────────────────────────────
    {
      let calls = 0;
      const send = async () => { calls++; return { success: true, messageId: "x" }; };
      const outcomes = [];
      for (const email of ["", "   ", undefined, null, 42]) {
        outcomes.push(await rc.sendRegistrationConfirmationIfDue({ email, name: "Uten" }, { send }));
      }
      assertTrue(outcomes.every((o) => !o.sent && (o as any).reason === "no_email"), "6a: missing/blank/non-string email → no_email");
      assertEq(calls, 0, "6b: missing email → no send");
      const before6 = wire.length;
      const noEmail = await register(regBody(undefined));
      assertEq([noEmail.status, wire.length], [400, before6], "6c: /register without contactEmail → 400, no send");
    }

    // ── concurrency: two at once for one address → one mail ────────────
    {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let calls = 0;
      const send = async () => { calls++; await gate; return { success: true, messageId: "c" }; };
      const p1 = rc.sendRegistrationConfirmationIfDue({ email: "samtidig@example.test", name: "S" }, { send });
      const p2 = rc.sendRegistrationConfirmationIfDue({ email: " SAMTIDIG@example.test", name: "S" }, { send });
      release();
      const [o1, o2] = await Promise.all([p1, p2]);
      assertEq([o1, o2, calls], [{ sent: true }, { sent: false, reason: "in_flight" }, 1], "8a: concurrent sends for one address → one mail");
    }
  } catch (err) {
    failed++;
    failures.push(`registration-confirmation: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    svc.isConfigured = prevIsConfigured;
    svc.transporter = prevTransporter;
    if (prevFlag === undefined) delete process.env.REGISTRATION_CONFIRMATION_EMAIL_ENABLED;
    else process.env.REGISTRATION_CONFIRMATION_EMAIL_ENABLED = prevFlag;
    try {
      const { marketplaceRegistry } = require("./marketplace-registry") as typeof import("./marketplace-registry");
      (marketplaceRegistry as any)._agentsCache = null;
    } catch { /* ignore */ }
    restoreDb();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  process.env.EMAIL_FORCE_DRY_RUN = "true";
  runRegistrationConfirmationTests({ log: true }).then((r) => {
    console.log(`\nregistration-confirmation: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
