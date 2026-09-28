/**
 * crm-compose-extraction-parity.test.ts — pins that extracting the body of
 * POST /admin/crm/compose into executeCompose() (dev-request 2026-09-19-rfb-
 * marketing-utsending-inn-i-plattformjobben) left the route unchanged, and that
 * the outcome the platform-side daily RFB send reads is truthful:
 *
 *   (1) for every branch of the guard chain — 400 invalid body, 429
 *       max-touch-vern, 423 OUTREACH_PAUSED, 429 OUTREACH_MAX_PER_DAY, 429
 *       cooldown, 429 24h rate-limit, the inbound exemption, 200 gmail_draft,
 *       200 resend_send, 500 transport failure (with the cap slot released),
 *       force+daniel bypass, a post-send write failure and a pre-send write
 *       failure — the route's (status, body) and every DB side effect are
 *       identical to calling executeCompose() directly on an identical fresh
 *       database (generated ids/timestamps normalized);
 *   (2) `delivery` / `transportAttempted` / `postSendError` tell the truth
 *       about the wire: in particular a transport-ACCEPTED e-mail whose
 *       post-send bookkeeping write fails is still a 500 (unchanged route
 *       behaviour) but reports delivery "sent";
 *   (3) the `sendRaw` seam replaces the transport completely and receives the
 *       platform identity (From / Reply-To) the route would put on the wire.
 *
 * (A one-off differential run against the untouched origin/main handler —
 * 18 scenarios, response + DB side effects — showed zero differences; this
 * file keeps the equivalence pinned going forward.)
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/crm-compose-extraction-parity.test.ts
 *   2. Wired into the gate: tests/test.ts (runSerial — pins the DB singleton).
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(router: any, body: any, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req: any = {
      method: "POST",
      url: "/compose",
      originalUrl: "/compose",
      query: {},
      headers,
      body,
      ip: "127.0.0.1",
      get(name: string) {
        return headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve(err ? { status: 500, body: { error: String(err) } } : { status: 404, body: "unmatched" });
    });
  });
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TS_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g;
function norm(x: unknown): string {
  return JSON.stringify(x).replace(UUID_RE, "<uuid>").replace(TS_RE, "<ts>");
}

export async function runCrmComposeExtractionParityTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  try {
    (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
  } catch {
    // already loaded
  }
  const initMod = require("../database/init") as typeof import("../database/init");
  const crm = require("./crm") as typeof import("./crm");
  const identity = require("../services/crm-platform-identity") as typeof import("../services/crm-platform-identity");
  const emailSvc = (require("../services/email-service") as typeof import("../services/email-service")).emailService as any;

  const prevDb = initMod.__peekDbForTesting();
  const ENV_KEYS = ["OUTREACH_PAUSED", "OUTREACH_MAX_PER_DAY", "OUTREACH_COOLDOWN_DAYS"] as const;
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevAdminKey = process.env.ADMIN_KEY;
  const testKey = process.env.ADMIN_KEY || "crm-compose-extraction-parity-test-key";
  process.env.ADMIN_KEY = testKey;
  const origConfigured = emailSvc.isConfigured;
  const origTransporter = emailSvc.transporter;

  function freshDb(): any {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = OFF");
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    return db;
  }
  function dump(db: any): string {
    return norm({
      threads: db.prepare(`SELECT contact_id, subject, category, severity, status, vertical_id, message_count FROM crm_threads ORDER BY rowid`).all(),
      messages: db.prepare(`SELECT direction, to_emails, subject, body_text, body_html, delivery_status, (sent_at IS NOT NULL) AS has_sent_at, vertical_id FROM crm_messages ORDER BY rowid`).all(),
      outbox: db.prepare(`SELECT intent, to_emails, status, result_id, error, created_by, vertical_id FROM crm_outbox ORDER BY rowid`).all(),
      actions: db.prepare(`SELECT type, actor FROM crm_actions ORDER BY rowid`).all(),
      cap: db.prepare(`SELECT reserved_count FROM outreach_daily_send_cap ORDER BY day`).all(),
      osl: db.prepare(`SELECT agent_id, recipient_email, notes, vertical_id FROM outreach_sent_log ORDER BY id`).all(),
      contacts: db.prepare(`SELECT email, name, type, vertical_id FROM crm_contacts ORDER BY rowid`).all(),
    });
  }

  const TO = "prod@parity-compose.no";
  const base = {
    to: TO,
    contactName: "Paritet Gård",
    subject: "Har vi info riktig om Paritet Gård?",
    bodyText: "Hei,\n\nJeg har laget en profil.\n\nMvh,\nDaniel Fredriksen",
    intent: "resend_send",
    category: "marketing",
    createdBy: "claude",
    vertical: "rfb",
  };
  const priorOsl = (db: any, daysAgo: number, vertical: string, n = 1) => {
    for (let i = 0; i < n; i++) {
      db.prepare(
        `INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes, vertical_id)
         VALUES ('ag', ?, datetime('now', ?), 'email', ?, 'test:prior', ?)`,
      ).run(TO, `-${daysAgo + i} days`, `prior-${daysAgo}-${i}`, vertical);
    }
  };
  const threadWith = (db: any, direction: "in" | "out", hoursAgo: number) => {
    db.prepare(`INSERT INTO crm_contacts (id, type, agent_id, email, name, vertical_id) VALUES ('c-p', 'producer', NULL, ?, 'P', 'rfb')`).run(TO);
    db.prepare(`INSERT INTO crm_threads (id, contact_id, subject, category, status, assigned_to, vertical_id) VALUES ('t-p', 'c-p', 's', 'innkommende', 'new', 'claude', 'rfb')`).run();
    db.prepare(
      `INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, subject, body_text, received_at, sent_at, delivery_status, vertical_id)
       VALUES ('m-p', 't-p', ?, 'x@y.no', '[]', 's', 'b', datetime('now', ?), datetime('now', ?), 'sent', 'rfb')`,
    ).run(direction, `-${hoursAgo} hours`, `-${hoursAgo} hours`);
  };

  type Scenario = {
    name: string;
    body: any;
    env?: Partial<Record<(typeof ENV_KEYS)[number], string>>;
    setup?: (db: any) => void;
    transport?: "ok" | "fail";
    expect: { status: number; delivery: string; transportAttempted: boolean; postSendError: boolean };
  };
  const scenarios: Scenario[] = [
    { name: "400 invalid body (no vertical)", body: { ...base, vertical: undefined }, expect: { status: 400, delivery: "not_sent", transportAttempted: false, postSendError: false } },
    { name: "429 max-touch-vern", body: base, setup: (db) => priorOsl(db, 100, "rfb", 3), expect: { status: 429, delivery: "not_sent", transportAttempted: false, postSendError: false } },
    { name: "423 OUTREACH_PAUSED", body: base, env: { OUTREACH_PAUSED: "true" }, expect: { status: 423, delivery: "not_sent", transportAttempted: false, postSendError: false } },
    {
      name: "429 OUTREACH_MAX_PER_DAY",
      body: base,
      env: { OUTREACH_MAX_PER_DAY: "1" },
      setup: (db) => db.prepare(`INSERT INTO outreach_daily_send_cap (day, reserved_count) VALUES (?, 1)`).run(new Date().toISOString().slice(0, 10)),
      expect: { status: 429, delivery: "not_sent", transportAttempted: false, postSendError: false },
    },
    { name: "429 cooldown (cross-platform)", body: base, setup: (db) => priorOsl(db, 5, "experiences"), expect: { status: 429, delivery: "not_sent", transportAttempted: false, postSendError: false } },
    { name: "429 24h rate-limit", body: base, setup: (db) => threadWith(db, "out", 1), expect: { status: 429, delivery: "not_sent", transportAttempted: false, postSendError: false } },
    { name: "200 inbound exemption", body: base, setup: (db) => threadWith(db, "in", 24), expect: { status: 200, delivery: "sent", transportAttempted: true, postSendError: false } },
    { name: "200 gmail_draft", body: { ...base, intent: "gmail_draft" }, expect: { status: 200, delivery: "draft_queued", transportAttempted: false, postSendError: false } },
    { name: "200 resend_send", body: base, transport: "ok", expect: { status: 200, delivery: "sent", transportAttempted: true, postSendError: false } },
    { name: "500 transport failure", body: base, transport: "fail", expect: { status: 500, delivery: "not_sent", transportAttempted: true, postSendError: false } },
    {
      name: "200 force+daniel bypass",
      body: { ...base, createdBy: "daniel", force: true },
      env: { OUTREACH_PAUSED: "true" },
      setup: (db) => priorOsl(db, 5, "rfb"),
      expect: { status: 200, delivery: "sent", transportAttempted: true, postSendError: false },
    },
    {
      name: "500 post-send write failure (e-mail WAS sent)",
      body: base,
      transport: "ok",
      setup: (db) =>
        db.exec(`CREATE TRIGGER t_p BEFORE UPDATE OF delivery_status ON crm_messages WHEN NEW.delivery_status = 'sent'
                 BEGIN SELECT RAISE(ABORT, 'simulated disk full'); END;`),
      expect: { status: 500, delivery: "sent", transportAttempted: true, postSendError: true },
    },
    {
      name: "500 pre-send write failure",
      body: base,
      setup: (db) => db.exec(`CREATE TRIGGER t_q BEFORE INSERT ON crm_threads BEGIN SELECT RAISE(ABORT, 'simulated disk full'); END;`),
      expect: { status: 500, delivery: "not_sent", transportAttempted: false, postSendError: false },
    },
  ];

  const setEnv = (values: Scenario["env"] = {}) => {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(values)) if (v !== undefined) process.env[k] = v;
  };
  const setTransport = (mode?: "ok" | "fail") => {
    emailSvc.isConfigured = origConfigured;
    emailSvc.transporter = origTransporter;
    if (mode === "ok") {
      emailSvc.isConfigured = true;
      emailSvc.transporter = { sendMail: async () => ({ messageId: "stub-parity" }) };
    } else if (mode === "fail") {
      emailSvc.isConfigured = true;
      emailSvc.transporter = { sendMail: async () => { throw new Error("smtp 550 rejected"); } };
    }
  };

  try {
    // ── (1) + (2) ──────────────────────────────────────────────────────────
    const router = crm.default as any;
    for (const sc of scenarios) {
      setEnv(sc.env);
      setTransport(sc.transport);
      const dbRoute = freshDb();
      sc.setup?.(dbRoute);
      const viaRoute = await callRoute(router, sc.body, { "x-admin-key": testKey });
      const routeDump = dump(dbRoute);

      setTransport(sc.transport);
      const dbDirect = freshDb();
      sc.setup?.(dbDirect);
      const outcome = await crm.executeCompose(sc.body);
      const directDump = dump(dbDirect);

      assertEq(viaRoute.status, sc.expect.status, `c1 ${sc.name}: route status`);
      assertEq(norm({ status: viaRoute.status, body: viaRoute.body }), norm({ status: outcome.httpStatus, body: outcome.body }), `c1 ${sc.name}: route (status, body) === executeCompose()`);
      assertEq(routeDump, directDump, `c1 ${sc.name}: identical DB side effects`);
      assertEq(
        [outcome.delivery, outcome.transportAttempted, typeof outcome.postSendError === "string"],
        [sc.expect.delivery, sc.expect.transportAttempted, sc.expect.postSendError],
        `c2 ${sc.name}: delivery/transportAttempted/postSendError`,
      );
    }
    setEnv({});
    setTransport(undefined);

    // Specific facts the table above relies on.
    {
      setTransport("fail");
      const db = freshDb();
      await crm.executeCompose(base);
      const cap = db.prepare(`SELECT reserved_count FROM outreach_daily_send_cap`).get() as { reserved_count: number };
      assertEq(cap.reserved_count, 0, "c3: a transport failure releases its OUTREACH_MAX_PER_DAY slot (unchanged)");
      setTransport(undefined);
    }
    {
      setTransport("ok");
      const db = freshDb();
      db.exec(`CREATE TRIGGER t_p BEFORE UPDATE OF delivery_status ON crm_messages WHEN NEW.delivery_status = 'sent'
               BEGIN SELECT RAISE(ABORT, 'simulated disk full'); END;`);
      const o = await crm.executeCompose(base);
      assertEq([o.httpStatus, o.body.error, o.postSendError], [500, "simulated disk full", "simulated disk full"], "c4: post-send failure keeps the route's 500 body and reports the error");
      const osl = (db.prepare(`SELECT COUNT(*) AS c FROM outreach_sent_log`).get() as { c: number }).c;
      assertEq(osl, 0, "c5: …and outreach_sent_log has no row — why a caller must trust `delivery`, not the status code");
      setTransport(undefined);
    }

    // ── (2b) synchronous exactly where the handler was synchronous ─────────
    // Before the extraction every non-send outcome was answered before the
    // handler's first await, i.e. in the same tick (crm-vertical.test.ts's
    // synchronous harness depends on it). Only resend_send awaits.
    {
      freshDb();
      assertEq(crm.executeCompose({ ...base, vertical: undefined }) instanceof Promise, false, "c10: a validation failure is returned synchronously");
      assertEq(crm.executeCompose({ ...base, intent: "gmail_draft" }) instanceof Promise, false, "c11: gmail_draft is returned synchronously");
      process.env.OUTREACH_PAUSED = "true";
      const refusal = crm.executeCompose(base);
      delete process.env.OUTREACH_PAUSED;
      assertEq(refusal instanceof Promise, false, "c12: a guard refusal is returned synchronously");
      const send = crm.executeCompose(base);
      assertEq(send instanceof Promise, true, "c13: only a resend_send is asynchronous");
      await send;
      const answeredInSameTick = (body: any): boolean => {
        let answered = false;
        const req: any = {
          method: "POST", url: "/compose", originalUrl: "/compose", query: {}, body,
          headers: { "x-admin-key": testKey },
          get(name: string) { return this.headers[name.toLowerCase()]; },
        };
        const res: any = {
          statusCode: 200,
          status(c: number) { this.statusCode = c; return this; },
          json() { answered = true; return this; },
        };
        router.handle(req, res, () => { /* unmatched */ });
        return answered;
      };
      assertEq(answeredInSameTick({ ...base, vertical: undefined }), true, "c14: the route answers a 400 in the same tick");
      assertEq(answeredInSameTick({ ...base, intent: "gmail_draft", to: "draft@parity-compose.no" }), true, "c15: the route answers a gmail_draft in the same tick");
    }

    // ── (3) the sendRaw seam ───────────────────────────────────────────────
    {
      const wire: Array<Record<string, any>> = [];
      let transporterTouched = false;
      emailSvc.isConfigured = true;
      emailSvc.transporter = { sendMail: async () => { transporterTouched = true; return { messageId: "should-not-be-used" }; } };
      freshDb();
      const o = await crm.executeCompose(base, {
        sendRaw: async (opts) => {
          wire.push(opts);
          return { success: true, messageId: "seam-1" };
        },
      });
      assertEq([o.httpStatus, o.body.messageId, o.delivery], [200, "seam-1", "sent"], "c6: seam result flows through the unchanged success path");
      assertEq(transporterTouched, false, "c7: the seam replaces the transport completely");
      assertEq([wire[0].to, wire[0].from, wire[0].replyTo], [TO, identity.crmFromHeader("rfb"), identity.resolveCrmIdentity("rfb").replyTo], "c8: seam receives the platform identity");
      assertEq(wire[0].textContent, base.bodyText, "c9: seam receives the text body verbatim");
      setTransport(undefined);
    }
  } catch (err) {
    failed++;
    failures.push(`crm-compose-extraction-parity: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  } finally {
    emailSvc.isConfigured = origConfigured;
    emailSvc.transporter = origTransporter;
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevDb) initMod.__setDbForTesting(prevDb);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  process.env.NODE_ENV = "test";
  process.env.EMAIL_FORCE_DRY_RUN = "true";
  runCrmComposeExtractionParityTests({ log: true }).then((r) => {
    console.log(`\ncrm-compose-extraction-parity: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      for (const f of r.failures) console.log(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
