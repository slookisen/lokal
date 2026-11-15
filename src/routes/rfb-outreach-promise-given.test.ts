/**
 * rfb-outreach-promise-given.test.ts — dev-request 2026-11-15-rfb-utsending-
 * loftesetning-holdes. The RFB follow-up (rfb-outreach-v4-followup) promises
 * «Jeg skriver ikke igjen om dette.»; an address that got it is held back.
 *
 *   AK1: latest send = rfb-outreach-v4-followup → not a mode=second candidate.
 *   AK2: one older first send (rfb-outreach-v4), no follow-up → still a candidate.
 *   Plus: ledger fallback (touch='second' sent), 'reserved' not counted,
 *   malformed raw_metadata tolerated, suppressed_counts.promise_given,
 *   pool-blocker-explain gate.promise_given, and the executeCompose guard
 *   (409 promise_given, force/daniel do not override, nothing sent, no cap
 *   slot reserved).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/rfb-outreach-promise-given.test.ts
 *   2. Wired into the gate: tests/test.ts (runSerial — pins the DB singleton).
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRouteSync(router: any, query: Record<string, string>, headers: Record<string, string>): { status: number; body: any } {
  let result: { status: number; body: any } = { status: 200, body: undefined };
  const req: any = { method: "GET", url: "/", query, headers, get: (n: string) => headers[n.toLowerCase()] };
  const res: any = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      result = { status: this.statusCode, body: payload };
      return this;
    },
  };
  router.handle(req, res, (err?: any) => {
    if (err) result = { status: 500, body: { error: String(err) } };
  });
  return result;
}

export async function runRfbOutreachPromiseGivenTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const prevDb = initMod.__peekDbForTesting();
  const ENV_KEYS = ["ADMIN_KEY", "OUTREACH_PAUSED", "OUTREACH_MAX_PER_DAY", "OUTREACH_COOLDOWN_DAYS"] as const;
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  const testKey = "rfb-outreach-promise-given-test-key";
  process.env.ADMIN_KEY = testKey;
  const auth = { "x-admin-key": testKey };

  try {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = OFF");
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const tpl = require("../services/rfb-outreach-template") as typeof import("../services/rfb-outreach-template");
    const promise = require("../services/rfb-outreach-promise") as typeof import("../services/rfb-outreach-promise");
    const candidatesRouter = require("./admin-outreach-candidates").default;
    const explainRouter = require("./admin-pool-blocker-explain").default;
    const crm = require("./crm") as typeof import("./crm");

    const agent = (id: string, email: string): void => {
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES (?, ?, 'test producer', 'test', ?, 'https://example.no', 'producer', ?)`,
      ).run(id, `Gard ${id}`, email, `key-${id}`);
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, email, about, field_provenance, verification_status, enrichment_status, url_last_status, url_last_probed)
         VALUES (?, ?, ?, '{}', 'verified', 'rich', 200, datetime('now'))`,
      ).run(id, email, "x".repeat(200));
    };
    // A cold send as the RFB job files it: a CRM message carrying raw_metadata
    // (queued, so the sent-log trigger does not fire) + its outreach_sent_log row.
    const send = (id: string, email: string, n: number, daysAgo: number, rawMetadata: string | null): void => {
      const msgId = `m-${id}-${n}`;
      db.prepare(`INSERT OR IGNORE INTO crm_contacts (id, type, agent_id, email, name) VALUES (?, 'producer', ?, ?, ?)`).run(`c-${id}`, id, email, id);
      db.prepare(`INSERT OR IGNORE INTO crm_threads (id, contact_id, subject, category) VALUES (?, ?, 's', 'marketing')`).run(`t-${id}`, `c-${id}`);
      if (rawMetadata !== null) {
        db.prepare(
          `INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, subject, body_text, sent_at, raw_metadata, delivery_status)
           VALUES (?, ?, 'out', 'x@y.no', '[]', 's', 'b', datetime('now', ?), ?, 'queued')`,
        ).run(msgId, `t-${id}`, `-${daysAgo} days`, rawMetadata);
      }
      db.prepare(
        `INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes, vertical_id)
         VALUES (?, ?, datetime('now', ?), 'email', ?, 'test', 'rfb')`,
      ).run(id, email, `-${daysAgo} days`, msgId);
    };
    const ledger = (id: string, email: string, touch: string, status: string, daysAgo: number): void => {
      db.prepare(
        `INSERT INTO rfb_marketing_send_ledger (day, run_id, agent_id, recipient_email, touch, status, reserved_at)
         VALUES (date('now', ?), 'run-test', ?, ?, ?, ?, datetime('now', ?))`,
      ).run(`-${daysAgo} days`, id, email, touch, status, `-${daysAgo} days`);
    };
    const meta = (t: string) => JSON.stringify({ template: t, subject_arm: "A", source: "crm-compose" });

    // AK1: first send, then the follow-up (latest).
    agent("pg-followup", "post@followup.pg-test.no");
    send("pg-followup", "post@followup.pg-test.no", 1, 160, meta(tpl.RFB_OUTREACH_TEMPLATE_ID));
    send("pg-followup", "post@followup.pg-test.no", 2, 100, meta(tpl.RFB_OUTREACH_FOLLOWUP_TEMPLATE_ID));
    // AK2: one older first send, no follow-up.
    agent("pg-first", "post@first.pg-test.no");
    send("pg-first", "post@first.pg-test.no", 1, 100, meta(tpl.RFB_OUTREACH_TEMPLATE_ID));
    // Legacy: no template on the CRM row, but the job's ledger says a second touch was sent.
    agent("pg-ledger", "post@ledger.pg-test.no");
    send("pg-ledger", "post@ledger.pg-test.no", 1, 100, null);
    ledger("pg-ledger", "Post@Ledger.pg-test.no", "second", "sent", 100);
    // A 'reserved' second touch (the job's in-flight row) is not counted.
    agent("pg-reserved", "post@reserved.pg-test.no");
    send("pg-reserved", "post@reserved.pg-test.no", 1, 100, meta(tpl.RFB_OUTREACH_TEMPLATE_ID));
    ledger("pg-reserved", "post@reserved.pg-test.no", "second", "reserved", 0);
    // Malformed raw_metadata: tolerated, not a promise.
    agent("pg-malformed", "post@malformed.pg-test.no");
    send("pg-malformed", "post@malformed.pg-test.no", 1, 100, "{not json");

    // ── gate, mode=second ──
    const second = callRouteSync(candidatesRouter, { mode: "second", cooldown_days: "60" }, auth);
    assertEq(second.status, 200, "g0: mode=second -> 200");
    const emails = (second.body?.candidates ?? []).map((c: any) => c.email);
    assertEq(emails.includes("post@followup.pg-test.no"), false, "AK1: latest send rfb-outreach-v4-followup -> not a candidate");
    assertEq(emails.includes("post@first.pg-test.no"), true, "AK2: one older first send, no follow-up -> still a candidate");
    assertEq(emails.includes("post@ledger.pg-test.no"), false, "g1: ledger second touch 'sent' (no CRM template) -> held");
    assertEq(emails.includes("post@reserved.pg-test.no"), true, "g2: 'reserved' second touch is not counted");
    assertEq(emails.includes("post@malformed.pg-test.no"), true, "g3: malformed raw_metadata -> no throw, not held");
    assertEq(second.body?.suppressed_counts?.promise_given, 2, "g4: suppressed_counts.promise_given counts both held rows");
    const first = callRouteSync(candidatesRouter, { mode: "first" }, auth);
    assertEq(first.body?.suppressed_counts?.promise_given, 0, "g5: mode=first reports promise_given 0");

    // ── pool-blocker-explain ──
    const ex = callRouteSync(explainRouter, { agentIds: "pg-followup,pg-first" }, auth);
    assertEq(
      (ex.body?.agents ?? []).map((a: any) => a.gate?.promise_given),
      [true, false],
      "e1: pool-blocker-explain gate.promise_given names the reason",
    );

    // ── helper ──
    assertEq(promise.hasRfbPromiseGiven(db as any, " POST@FOLLOWUP.pg-test.no "), true, "h1: single-address check is case/space-insensitive");
    assertEq(promise.hasRfbPromiseGiven(db as any, "post@first.pg-test.no"), false, "h2: first send only -> false");

    // ── executeCompose guard ──
    const wire: unknown[] = [];
    const sendRaw = async (o: any) => {
      wire.push(o);
      return { success: true, messageId: `stub-${wire.length}` };
    };
    const base = {
      to: "post@followup.pg-test.no",
      contactName: "Gard",
      subject: "Hei",
      bodyText: "Hei.",
      intent: "resend_send",
      category: "marketing",
      createdBy: "daniel",
      force: true,
      vertical: "rfb",
    };
    const msgsBefore = (db.prepare(`SELECT COUNT(*) AS n FROM crm_messages`).get() as { n: number }).n;
    const refused = await crm.executeCompose(base, { sendRaw });
    assertEq([refused.httpStatus, refused.body.error, refused.delivery], [409, "promise_given", "not_sent"], "c1: manual (daniel+force) compose -> 409 promise_given");
    const refusedClaude = await crm.executeCompose({ ...base, createdBy: "claude", force: false }, { sendRaw });
    assertEq([refusedClaude.httpStatus, refusedClaude.body.error], [409, "promise_given"], "c2: claude compose -> 409 promise_given");
    assertEq(wire.length, 0, "c3: nothing handed to the transport");
    assertEq(db.prepare(`SELECT COUNT(*) AS n FROM outreach_daily_send_cap`).get(), { n: 0 }, "c4: no daily-cap slot reserved");
    assertEq((db.prepare(`SELECT COUNT(*) AS n FROM crm_messages`).get() as { n: number }).n, msgsBefore, "c5: no CRM message written");
    const okFirst = await crm.executeCompose({ ...base, to: "post@first.pg-test.no" }, { sendRaw });
    assertEq([okFirst.httpStatus, okFirst.delivery], [200, "sent"], "c6: address without the promise still sends");
  } catch (err) {
    failed++;
    failures.push(`rfb-outreach-promise-given: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  } finally {
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    if (prevDb) initMod.__setDbForTesting(prevDb);
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbOutreachPromiseGivenTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
