/**
 * admin-privacy-erasure.test.ts — tests for POST /admin/privacy/erasure-by-email
 * (dev-request 2026-10-12-slettefrist-korrespondanse-og-oversettelser, slice C, AC3).
 *
 * Setup: better-sqlite3 ":memory:" + __initSchemaForTesting, route pointed at
 * that DB through its own seam (__setPrivacyErasureDbForTesting) — never pins
 * the shared getDb() singleton. Handler driven through router.handle() with a
 * fake req/res (same harness as admin-agents-deactivate.test.ts).
 *
 * Covers: 403 without/with wrong key; 400 missing/invalid email; dry-run
 * counts per table + DB byte-identical afterwards (db.serialize()); apply
 * deletes exactly the dry-run counts, only for the target address (case/space
 * variants included), other address untouched; suppression rows
 * (email_bounces, agent_blocklist email) kept by default and removed only with
 * include_suppression; audit row written with hash (not the address); 409
 * not_suppressed guard; 409 busy.
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(router: any, opts: { headers?: Record<string, string>; body?: any }): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: "POST",
      url: "/erasure-by-email",
      originalUrl: "/admin/privacy/erasure-by-email",
      query: {},
      headers,
      body: opts.body,
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
      end() {
        resolve({ status: this.statusCode, body: undefined });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ status: err ? 500 : 0, body: err ? { error: String(err) } : undefined });
    });
  });
}

const TARGET = "Ola.Nordmann@Example.no";
const TARGET_NORM = "ola.nordmann@example.no";
const OTHER = "kari@example.no";

function seed(db: Database.Database): void {
  db.prepare(
    `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, is_active)
     VALUES (?, ?, 'test agent', 'test', '', 'https://example.no', 'producer', ?, 'rfb', 1)`,
  ).run("ag-1", "Test Gard", "key-ag-1");

  for (const [who, addr, vertical] of [
    ["t", ` ${TARGET} `, "rfb"],
    ["t2", TARGET_NORM, "experiences"],
    ["o", OTHER, "rfb"],
  ] as const) {
    db.prepare(`INSERT INTO crm_contacts (id, type, email, vertical_id) VALUES (?, 'producer', ?, ?)`).run(
      `c-${who}`,
      addr,
      vertical,
    );
    db.prepare(`INSERT INTO crm_threads (id, contact_id, subject, vertical_id) VALUES (?, ?, 's', ?)`).run(
      `th-${who}`,
      `c-${who}`,
      vertical,
    );
    for (const n of [1, 2]) {
      db.prepare(
        `INSERT INTO crm_messages (id, thread_id, direction, from_email, body_text) VALUES (?, ?, 'in', ?, 'hei')`,
      ).run(`m-${who}-${n}`, `th-${who}`, addr);
    }
    db.prepare(`INSERT INTO crm_actions (id, thread_id, contact_id, type, actor) VALUES (?, ?, ?, 'note', 'system')`).run(
      `a-${who}`,
      `th-${who}`,
      `c-${who}`,
    );
    db.prepare(
      `INSERT INTO crm_outbox (id, thread_id, contact_id, intent, to_emails, subject, body_text, created_by, vertical_id)
       VALUES (?, ?, ?, 'gmail_draft', ?, 's', 'b', 'claude', ?)`,
    ).run(`ob-${who}`, `th-${who}`, `c-${who}`, addr, vertical);
    db.prepare(
      `INSERT INTO crm_retro_tagging_audit (id, batch_id, thread_id, from_vertical, to_vertical, from_contact_id, to_contact_id, tier, evidence, applied_by)
       VALUES (?, 'b1', ?, 'rfb', 'rfb', ?, ?, 't1', 'e', 'test')`,
    ).run(`rt-${who}`, `th-${who}`, `c-${who}`, `c-${who}`);
  }
  for (const [who, addr] of [
    ["t", TARGET.toUpperCase()],
    ["o", OTHER],
  ] as const) {
    db.prepare(`INSERT INTO contact_form_receipts (email, platform, thread_id, outcome, sent_at) VALUES (?, 'rfb', NULL, 'sent', '2026-11-01T00:00:00Z')`).run(addr.toLowerCase());
    db.prepare(`INSERT INTO crm_untriaged (id, thread_id, from_email, reason) VALUES (?, ?, ?, 'r')`).run(
      `u-${who}`,
      `gm-${who}`,
      addr,
    );
    db.prepare(`INSERT INTO inbound_email_log (id, email_id, from_email, subject) VALUES (?, ?, ?, 's')`).run(
      `inb-${who}`,
      `em-${who}`,
      addr,
    );
    db.prepare(`INSERT INTO outreach_sent_log (agent_id, recipient_email) VALUES ('ag-1', ?)`).run(addr);
    db.prepare(
      `INSERT INTO rfb_marketing_send_ledger (day, run_id, agent_id, recipient_email, touch, reserved_at)
       VALUES ('2026-11-01', 'r1', 'ag-1', ?, 't1', '2026-11-01T00:00:00Z')`,
    ).run(addr);
    db.prepare(`INSERT INTO resend_webhook_events (svix_id, event_type, email, outcome) VALUES (?, 'email.bounced', ?, 'x')`).run(
      `sv-${who}`,
      addr,
    );
    db.prepare(`INSERT INTO email_delivery_events (svix_id, email, delivered_at) VALUES (?, ?, '2026-11-01')`).run(
      `sd-${who}`,
      addr,
    );
    db.prepare(`INSERT INTO email_bounces (email, bounced_at, bounce_type) VALUES (?, '2026-11-01', 'unsubscribe')`).run(addr);
    db.prepare(`INSERT INTO agent_blocklist (identifier_type, identifier_value, reason) VALUES ('email', ?, 'r')`).run(
      addr.toLowerCase(),
    );
  }
  // CS på serveren, S1: thread flags and Gmail aliases on the target's and the
  // other person's thread; an inbound e-mail FROM someone else with the target
  // in Cc (erased) and one with a look-alike address in To (kept).
  for (const who of ["t", "o"]) {
    db.prepare(`INSERT INTO crm_thread_flags (thread_id, no_reply_reason, no_reply_at, no_reply_by) VALUES (?, 'fri tekst', '2026-11-01T00:00:00Z', 'daniel')`).run(`th-${who}`);
    db.prepare(`INSERT INTO crm_thread_aliases (alias_id, thread_id, source) VALUES (?, ?, 'cs_gmail_copy')`).run(`gm-alias-${who}`, `th-${who}`);
    db.prepare(
      `INSERT INTO cs_change_requests (id, vertical, target_id, thread_id, requester_email, kind, authority, status, created_by, created_at, updated_at)
       VALUES (?, 'rfb', 'ag-1', ?, ?, 'removal', 'registered_email', 'verified', 'claude', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
    ).run(`chg-${who}`, `th-${who}`, who === "t" ? TARGET_NORM : OTHER);
    db.prepare(
      `INSERT INTO cs_reply_proposals (id, thread_id, vertical, kind, to_email, subject, body_text, created_by, created_at, updated_at)
       VALUES (?, ?, 'rfb', 'takk', ?, 's', 'b', 'claude', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
    ).run(`rp-${who}`, `th-${who}`, who === "t" ? TARGET_NORM : OTHER);
  }
  db.prepare(`INSERT INTO inbound_email_log (id, email_id, from_email, to_emails, cc_emails, subject) VALUES ('inb-cc', 'em-cc', 'third@example.no', '["kontakt@rettfrabonden.com"]', ?, 's')`).run(
    JSON.stringify([TARGET_NORM]),
  );
  // Linked ONLY by the thread: a colleague writing on the target's thread.
  db.prepare(`INSERT INTO inbound_email_log (id, email_id, from_email, to_emails, cc_emails, subject, crm_thread_id, forward_payload) VALUES ('inb-thread', 'em-th', 'colleague@example.no', '["kontakt@rettfrabonden.com"]', '[]', 's', 'th-t', '{"textContent":"x"}')`).run();
  db.prepare(`INSERT INTO inbound_email_log (id, email_id, from_email, to_emails, cc_emails, subject) VALUES ('inb-lookalike', 'em-la', 'third@example.no', ?, '[]', 's')`).run(
    JSON.stringify(["x" + TARGET_NORM]),
  );
  // A delivery event attributed to one of the target's messages but recorded
  // under a different spelling → caught via crm_message_id.
  db.prepare(
    `INSERT INTO email_delivery_events (svix_id, email, delivered_at, crm_message_id) VALUES ('sd-t-m', 'alias@example.no', '2026-11-01', 'm-t-1')`,
  ).run();
}

const EXPECTED_TARGET_COUNTS: Record<string, number> = {
  email_delivery_events: 2,
  crm_outbox: 2,
  crm_actions: 2,
  crm_retro_tagging_audit: 2,
  crm_messages: 4,
  crm_thread_flags: 1,
  crm_thread_aliases: 1,
  cs_change_requests: 1,
  cs_reply_proposals: 1,
  inbound_email_log: 3,
  crm_threads: 2,
  crm_contacts: 2,
  crm_untriaged: 1,
  contact_form_receipts: 1,
  outreach_sent_log: 1,
  rfb_marketing_send_ledger: 1,
  resend_webhook_events: 1,
};

function countAll(db: Database.Database, tables: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
  return out;
}

export async function runAdminPrivacyErasureTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    assertEq(cond, true, label);
  }

  // Never reassign an ambient ADMIN_KEY (shared-global discipline in tests/test.ts).
  const ambientKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  const setKeyOurselves = ambientKey === "";
  if (setKeyOurselves) process.env.ADMIN_KEY = "admin-privacy-erasure-standalone-key";
  const key = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  const H = { "x-admin-key": key };

  const mod = require("./admin-privacy-erasure") as typeof import("./admin-privacy-erasure");
  const router = mod.default;
  const db = new Database(":memory:");
  try {
    initMod.__initSchemaForTesting(db as any);
    seed(db);
    mod.__setPrivacyErasureDbForTesting(db);

    // ── auth + validation ──
    let r = await callRoute(router, { body: { email: TARGET } });
    assertEq(r.status, 403, "403 without X-Admin-Key");
    r = await callRoute(router, { headers: { "x-admin-key": key + "-wrong" }, body: { email: TARGET } });
    assertEq(r.status, 403, "403 with wrong X-Admin-Key");
    r = await callRoute(router, { headers: H, body: {} });
    assertEq(r.status, 400, "400 missing email");
    r = await callRoute(router, { headers: H, body: { email: "not-an-address" } });
    assertEq(r.status, 400, "400 invalid email");
    r = await callRoute(router, { headers: H, body: { email: 42 } });
    assertEq(r.status, 400, "400 non-string email");

    // ── dry-run (default) ──
    const before = db.serialize();
    r = await callRoute(router, { headers: H, body: { email: TARGET } });
    assertEq(r.status, 200, "dry-run 200");
    assertEq(r.body?.dry_run, true, "dry_run is default");
    assertEq(r.body?.email, TARGET_NORM, "address normalized");
    assertEq(r.body?.counts, EXPECTED_TARGET_COUNTS, "dry-run per-table counts");
    assertEq(r.body?.kept_suppression, { email_bounces: 1, agent_blocklist: 1 }, "dry-run reports kept suppression");
    assertEq(r.body?.suppressed_now, true, "suppressed_now");
    assertEq(r.body?.unsuppressed_after, false, "still suppressed after (default)");
    r = await callRoute(router, { headers: H, body: { email: TARGET, apply: "no" } });
    assertEq(r.body?.dry_run, true, "apply:'no' is still a dry-run");
    assertTrue(Buffer.compare(before, db.serialize()) === 0, "DB byte-identical after dry-runs");
    const dryCounts = r.body?.counts;

    // ── busy guard ──
    mod.__setPrivacyErasureInFlightForTesting(true);
    r = await callRoute(router, { headers: H, body: { email: TARGET, apply: true } });
    assertEq(r.status, 409, "409 busy while another erasure runs");
    mod.__setPrivacyErasureInFlightForTesting(false);

    // ── apply ──
    const tables = [...Object.keys(EXPECTED_TARGET_COUNTS), "email_bounces", "agent_blocklist", "privacy_erasure_audit"];
    const totalsBefore = countAll(db, tables);
    r = await callRoute(router, { headers: H, body: { email: TARGET, apply: true, requested_by: "sak-123" } });
    assertEq(r.status, 200, "apply 200");
    assertEq(r.body?.dry_run, false, "apply dry_run=false");
    assertEq(r.body?.counts, dryCounts, "apply counts equal dry-run counts");
    const totalsAfter = countAll(db, tables);
    for (const t of Object.keys(EXPECTED_TARGET_COUNTS)) {
      assertEq(totalsBefore[t] - totalsAfter[t], EXPECTED_TARGET_COUNTS[t], `apply removed exactly the counted rows from ${t}`);
    }
    assertEq(totalsAfter.email_bounces, totalsBefore.email_bounces, "email_bounces (suppression) kept by default");
    assertEq(totalsAfter.agent_blocklist, totalsBefore.agent_blocklist, "agent_blocklist (suppression) kept by default");

    // other address untouched
    const other = (sql: string) => (db.prepare(sql).get(OTHER) as { c: number }).c;
    assertEq(other(`SELECT COUNT(*) AS c FROM crm_contacts WHERE email = ?`), 1, "other contact kept");
    assertEq(
      (db.prepare(`SELECT COUNT(*) AS c FROM crm_messages WHERE thread_id = 'th-o'`).get() as { c: number }).c,
      2,
      "other messages kept",
    );
    assertEq(other(`SELECT COUNT(*) AS c FROM outreach_sent_log WHERE recipient_email = ?`), 1, "other outreach_sent_log kept");
    assertEq(other(`SELECT COUNT(*) AS c FROM rfb_marketing_send_ledger WHERE recipient_email = ?`), 1, "other ledger kept");
    assertEq(other(`SELECT COUNT(*) AS c FROM resend_webhook_events WHERE email = ?`), 1, "other webhook event kept");
    assertEq(other(`SELECT COUNT(*) AS c FROM email_delivery_events WHERE email = ?`), 1, "other delivery event kept");
    assertEq(other(`SELECT COUNT(*) AS c FROM crm_untriaged WHERE from_email = ?`), 1, "other untriaged kept");
    assertEq(
      (db.prepare(`SELECT COUNT(*) AS c FROM crm_outbox WHERE id = 'ob-o'`).get() as { c: number }).c,
      1,
      "other outbox kept",
    );

    // audit row
    const audit = db.prepare(`SELECT * FROM privacy_erasure_audit`).all() as any[];
    assertEq(audit.length, 1, "exactly one audit row");
    assertEq(audit[0]?.id, r.body?.audit_id, "audit id returned");
    assertEq(audit[0]?.actor, "admin", "audit actor");
    assertEq(audit[0]?.requested_by, "sak-123", "audit requested_by");
    assertEq(audit[0]?.email_hash, mod.erasureAddressHash(TARGET_NORM), "audit stores keyed hash");
    assertTrue(!JSON.stringify(audit[0]).includes("example.no"), "audit never stores the address");
    assertEq(JSON.parse(audit[0]?.counts_json || "{}"), EXPECTED_TARGET_COUNTS, "audit per-table counts");
    assertEq(audit[0]?.total_rows, 28, "audit total (20 + 3 inbound_email_log rows + crm_thread_flags + crm_thread_aliases, S1; + cs_reply_proposals, S2; + cs_change_requests, S4; + contact_form_receipts, S5)");
    assertEq(audit[0]?.include_suppression, 0, "audit include_suppression=0");
    assertTrue(typeof audit[0]?.requested_at === "string" && audit[0].requested_at.length > 0, "audit when");

    // second apply is a no-op (idempotent) but still audited
    r = await callRoute(router, { headers: H, body: { email: TARGET_NORM, apply: true } });
    assertEq(r.body?.total, 0, "second apply deletes nothing");

    // ── include_suppression without confirm → 409 not_suppressed ──
    const pre = db.serialize();
    r = await callRoute(router, { headers: H, body: { email: TARGET, apply: true, include_suppression: true } });
    assertEq(r.status, 409, "include_suppression apply without confirm_unsuppressed → 409");
    assertEq(r.body?.error, "not_suppressed", "error not_suppressed");
    assertTrue(Buffer.compare(pre, db.serialize()) === 0, "refused apply writes nothing");
    r = await callRoute(router, {
      headers: H,
      body: { email: TARGET, apply: true, include_suppression: true, confirm_unsuppressed: true },
    });
    assertEq(r.status, 200, "include_suppression + confirm → 200");
    assertEq(r.body?.counts?.email_bounces, 1, "suppression: email_bounces row removed on request");
    assertEq(r.body?.counts?.agent_blocklist, 1, "suppression: agent_blocklist row removed on request");
    assertEq(other(`SELECT COUNT(*) AS c FROM email_bounces WHERE email = ?`), 1, "other email_bounces kept");
    assertEq(
      other(`SELECT COUNT(*) AS c FROM agent_blocklist WHERE identifier_value = ?`),
      1,
      "other agent_blocklist kept",
    );

    // ── unsuppressed address with send history → guarded ──
    db.prepare(`INSERT INTO outreach_sent_log (agent_id, recipient_email) VALUES ('ag-1', 'ny@example.no')`).run();
    r = await callRoute(router, { headers: H, body: { email: "ny@example.no" } });
    assertEq(r.body?.unsuppressed_after, true, "dry-run flags unsuppressed_after");
    r = await callRoute(router, { headers: H, body: { email: "ny@example.no", apply: true } });
    assertEq(r.status, 409, "apply on unsuppressed address with send history → 409");
    r = await callRoute(router, { headers: H, body: { email: "ny@example.no", apply: true, confirm_unsuppressed: true } });
    assertEq(r.body?.counts?.outreach_sent_log, 1, "confirmed apply deletes send history");

    // ── review B1: only hard/complaint/unsubscribe (or blocklist) count as suppression ──
    for (const [bt, addr, expectBlocked] of [
      ["soft", "soft@example.no", true],
      ["unknown", "unknown@example.no", true],
      ["hard", "hard@example.no", false],
    ] as const) {
      db.prepare(`INSERT INTO email_bounces (email, bounced_at, bounce_type) VALUES (?, '2026-11-01', ?)`).run(addr, bt);
      db.prepare(`INSERT INTO outreach_sent_log (agent_id, recipient_email) VALUES ('ag-1', ?)`).run(addr);
      r = await callRoute(router, { headers: H, body: { email: addr } });
      assertEq(r.body?.suppressed_now, !expectBlocked, `${bt}-bounce: suppressed_now`);
      assertEq(r.body?.unsuppressed_after, expectBlocked, `${bt}-bounce: unsuppressed_after`);
      const snap = db.serialize();
      r = await callRoute(router, { headers: H, body: { email: addr, apply: true } });
      if (expectBlocked) {
        assertEq(r.status, 409, `${bt}-bounce + send history → 409`);
        assertEq(r.body?.error, "not_suppressed", `${bt}-bounce → not_suppressed`);
        assertTrue(Buffer.compare(snap, db.serialize()) === 0, `${bt}-bounce refused apply writes nothing`);
      } else {
        assertEq(r.status, 200, `${bt}-bounce + send history → apply goes through`);
        assertEq(r.body?.counts?.outreach_sent_log, 1, `${bt}-bounce apply deletes send history`);
        assertEq(r.body?.kept_suppression?.email_bounces, 1, `${bt}-bounce row kept`);
      }
    }
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err));
  } finally {
    mod.__setPrivacyErasureDbForTesting(null);
    mod.__setPrivacyErasureInFlightForTesting(false);
    db.close();
    if (setKeyOurselves) delete process.env.ADMIN_KEY;
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminPrivacyErasureTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0);
  });
}
