/**
 * privacy-retention.test.ts — tests for the nightly 24-month retention job
 * (services/privacy-retention.ts), dev-request
 * 2026-10-12-slettefrist-korrespondanse-og-oversettelser, slice A (AC1).
 *
 * Setup: better-sqlite3 ":memory:" + __initSchemaForTesting (the real schema,
 * triggers included) — never the shared getDb() singleton. The job takes the
 * db handle directly; the clock is injected (03:15 UTC on 2026-11-07, so the
 * 24-month cutoff is 2024-11-07 03:15:00).
 *
 * Covers: env parsing (mode default dry_run; months < 12 → 24); rows older
 * than the cutoff deleted, younger kept; an address with mixed old+new
 * activity fully kept; every email_bounces row kept (hard, soft, NULL type,
 * with or without outreach_sent_log rows) + agent_blocklist kept; dry_run
 * writes nothing (db.serialize() identical) and plans exactly what apply then
 * deletes; outreach_sent_log untouched; max-touch guard (per-address + batch
 * lookup), cooldown input (outreach_sent_log last send), gårdssalg reply
 * guard and the enrichment «already contacted» signal give the same answer
 * before and after apply for an address at the touch cap, one that replied
 * and one in cooldown; batch row cap honoured (remaining > 0, next night
 * continues); window / off / already-running guards; race guard (a row
 * written after the plan keeps the address).
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const NOW = new Date("2026-11-07T03:15:00Z");
const CLOCK = () => NOW;
const OLD = "2023-06-01 10:00:00";
const OLD_ISO = "2023-06-02T11:00:00.000Z";
const NEW = "2026-10-01 10:00:00";
const RECENT = "2026-10-28 09:00:00"; // inside a 60-day cooldown

function addAgent(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, is_active)
     VALUES (?, ?, 'test agent', 'test', '', 'https://example.no', 'producer', ?, 'rfb', 1)`,
  ).run(id, `Gard ${id}`, `key-${id}`);
}

interface ConvOpts {
  agent?: string;
  vertical?: "rfb" | "experiences";
  provider?: string;
  inbound?: boolean;
  outbound?: number;
  extras?: boolean; // action + outbox + retro audit
}

/** One contact + one thread with messages, all stamped `ts`. */
function addConversation(db: Database.Database, who: string, email: string, ts: string, o: ConvOpts = {}): void {
  const vertical = o.vertical ?? "rfb";
  db.prepare(
    `INSERT INTO crm_contacts (id, type, email, vertical_id, agent_id, provider_id, first_seen_at, last_seen_at)
     VALUES (?, 'producer', ?, ?, ?, ?, ?, ?)`,
  ).run(`c-${who}`, email, vertical, o.agent ?? null, o.provider ?? null, ts, ts);
  db.prepare(
    `INSERT INTO crm_threads (id, contact_id, subject, vertical_id, created_at, updated_at, last_message_at)
     VALUES (?, ?, 's', ?, ?, ?, ?)`,
  ).run(`th-${who}`, `c-${who}`, vertical, ts, ts, ts);
  // Inbound first, so the cold-outreach trigger does not auto-log the outbound.
  if (o.inbound) {
    db.prepare(
      `INSERT INTO crm_messages (id, thread_id, direction, from_email, body_text, sent_at, received_at, vertical_id)
       VALUES (?, ?, 'in', ?, 'svar', ?, ?, ?)`,
    ).run(`m-${who}-in`, `th-${who}`, email, ts, ts, vertical);
  }
  for (let i = 0; i < (o.outbound ?? 1); i++) {
    db.prepare(
      `INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, body_text, sent_at, received_at, delivery_status, vertical_id)
       VALUES (?, ?, 'out', 'kontakt@rettfrabonden.com', ?, 'hei', ?, ?, 'sent', ?)`,
    ).run(`m-${who}-out${i}`, `th-${who}`, JSON.stringify([email]), ts, ts, vertical);
  }
  if (o.extras !== false) {
    db.prepare(
      `INSERT INTO crm_actions (id, thread_id, contact_id, type, actor, created_at) VALUES (?, ?, ?, 'note', 'system', ?)`,
    ).run(`a-${who}`, `th-${who}`, `c-${who}`, ts);
    db.prepare(
      `INSERT INTO crm_outbox (id, thread_id, contact_id, intent, to_emails, subject, body_text, created_by, created_at, vertical_id)
       VALUES (?, ?, ?, 'gmail_draft', ?, 's', 'b', 'claude', ?, ?)`,
    ).run(`ob-${who}`, `th-${who}`, `c-${who}`, email, ts, vertical);
    db.prepare(
      `INSERT INTO crm_retro_tagging_audit (id, batch_id, thread_id, from_vertical, to_vertical, from_contact_id, to_contact_id, tier, evidence, applied_by, applied_at)
       VALUES (?, 'b1', ?, ?, ?, ?, ?, 't1', 'e', 'test', ?)`,
    ).run(`rt-${who}`, `th-${who}`, vertical, vertical, `c-${who}`, `c-${who}`, ts);
  }
  // Undo the triggers' datetime('now') on the thread.
  db.prepare(`UPDATE crm_threads SET updated_at = ?, last_outbound_at = ? WHERE id = ?`).run(ts, ts, `th-${who}`);
}

function addSentLog(db: Database.Database, agent: string, email: string, ts: string): void {
  db.prepare(`INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, vertical_id) VALUES (?, ?, ?, 'rfb')`).run(
    agent,
    email,
    ts,
  );
}

function addLedger(db: Database.Database, agent: string, email: string, ts: string, day: string): void {
  db.prepare(
    `INSERT INTO rfb_marketing_send_ledger (day, run_id, agent_id, recipient_email, touch, status, reserved_at, updated_at)
     VALUES (?, 'r1', ?, ?, 'first', 'sent', ?, ?)`,
  ).run(day, agent, email, ts, ts);
}

function addBounce(db: Database.Database, email: string, type: string | null, ts: string, sid: string): void {
  db.prepare(`INSERT INTO email_bounces (email, bounced_at, bounce_type, resend_email_id, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    email,
    ts,
    type,
    sid,
    ts,
  );
}

function addWebhook(db: Database.Database, sid: string, email: string, ts: string): void {
  db.prepare(`INSERT INTO resend_webhook_events (svix_id, event_type, email, outcome, received_at) VALUES (?, 'email.delivered', ?, 'x', ?)`).run(
    sid,
    email,
    ts,
  );
}

function seedMain(db: Database.Database): void {
  for (const a of ["ag-cap", "ag-rep", "ag-cool", "ag-osl"]) addAgent(db, a);

  // old@ — everything older than the cutoff, no outreach_sent_log row.
  addConversation(db, "old", "Old@Example.no ", OLD, { inbound: true });
  db.prepare(`INSERT INTO crm_untriaged (id, thread_id, from_email, reason, created_at) VALUES ('u-old', 'gm-old', 'OLD@example.no', 'r', ?)`).run(OLD);
  addLedger(db, "ag-cap", "old@example.no", OLD_ISO, "2023-06-02");
  addWebhook(db, "sv-old", "old@example.no", OLD);
  db.prepare(`INSERT INTO email_delivery_events (svix_id, email, delivered_at, created_at) VALUES ('sd-old', 'old@example.no', ?, ?)`).run(
    OLD_ISO,
    OLD,
  );
  // Old soft bounce, no RFB outreach_sent_log row (e.g. an Opplevagent address):
  // must stay, gardssalg-claim.hasClaimBlockingBounce reads it as a send block.
  addBounce(db, "old@example.no", "soft", OLD, "b-old-soft");

  // supp@ — old correspondence + suppression rows (hard bounce, blocklist) + a soft bounce.
  addConversation(db, "supp", "supp@example.no", OLD);
  addBounce(db, "supp@example.no", "hard", OLD, "b-supp-hard");
  addBounce(db, "supp@example.no", null, OLD, "b-supp-null");
  addWebhook(db, "sv-supp", "supp@example.no", OLD);
  db.prepare(`INSERT INTO agent_blocklist (identifier_type, identifier_value, reason, created_at) VALUES ('email', 'supp@example.no', 'r', ?)`).run(OLD);

  // oslsoft@ — old outreach_sent_log row + old soft bounce: the bounce must stay.
  addSentLog(db, "ag-osl", "oslsoft@example.no", OLD);
  addBounce(db, "oslsoft@example.no", "soft", OLD, "b-osl-soft");
  addWebhook(db, "sv-osl", "oslsoft@example.no", OLD);

  // cap@ — at the touch cap: 3 cold sends (trigger logs them), never replied.
  addConversation(db, "cap", "cap@example.no", OLD, { agent: "ag-cap", outbound: 3 });

  // replied@ — 3 sends, but replied once (old).
  addConversation(db, "rep", "replied@example.no", OLD, { agent: "ag-rep", inbound: true, outbound: 3 });
  for (let i = 0; i < 3; i++) addSentLog(db, "ag-rep", "replied@example.no", OLD);

  // cool@ — old CRM thread, but a send 10 days ago (cooldown) → everything kept.
  addConversation(db, "cool", "cool@example.no", OLD, { agent: "ag-cool", extras: false });
  addSentLog(db, "ag-cool", "cool@example.no", RECENT);

  // exp@ — Opplevagent contact that replied (old).
  addConversation(db, "exp", "exp@example.no", OLD, { vertical: "experiences", provider: "prov-1", inbound: true, outbound: 0, extras: false });

  // mixed@ — old thread, but a recent ledger row → kept.
  addConversation(db, "mixed", "mixed@example.no", OLD);
  addLedger(db, "ag-cap", "mixed@example.no", "2026-10-01T10:00:00.000Z", "2026-10-01");

  // new@ — recent everything.
  addConversation(db, "new", "new@example.no", NEW);

  // weird@ — unparsable timestamp → unknown → kept.
  db.prepare(
    `INSERT INTO crm_untriaged (id, thread_id, from_email, reason, created_at) VALUES ('u-weird', 'gm-weird', 'weird@example.no', 'r', 'Mon, 01 Jan 2023 10:00:00 +0000')`,
  ).run();
}

function count(db: Database.Database, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { c: number }).c;
}

function threadRows(db: Database.Database, who: string): number {
  return (
    count(db, `SELECT COUNT(*) AS c FROM crm_threads WHERE id = ?`, `th-${who}`) +
    count(db, `SELECT COUNT(*) AS c FROM crm_messages WHERE thread_id = ?`, `th-${who}`) +
    count(db, `SELECT COUNT(*) AS c FROM crm_actions WHERE id = ?`, `a-${who}`) +
    count(db, `SELECT COUNT(*) AS c FROM crm_outbox WHERE id = ?`, `ob-${who}`) +
    count(db, `SELECT COUNT(*) AS c FROM crm_retro_tagging_audit WHERE id = ?`, `rt-${who}`)
  );
}

export async function runPrivacyRetentionTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const assertTrue = (c: boolean, label: string) => assertEq(c, true, label);

  const mod = require("./privacy-retention") as typeof import("./privacy-retention");
  const vern = require("./outreach-max-touch-vern") as typeof import("./outreach-max-touch-vern");
  const enrich = require("./rfb-enrichment-nightly") as typeof import("./rfb-enrichment-nightly");
  const opp = require("../routes/opplevelser") as typeof import("../routes/opplevelser");

  // ── env parsing ────────────────────────────────────────────────────────
  assertEq(mod.resolvePrivacyRetentionMode(undefined), "dry_run", "mode: unset → dry_run");
  assertEq(mod.resolvePrivacyRetentionMode(""), "dry_run", "mode: empty → dry_run");
  assertEq(mod.resolvePrivacyRetentionMode("yes"), "dry_run", "mode: unknown → dry_run");
  assertEq(mod.resolvePrivacyRetentionMode(" APPLY "), "apply", "mode: APPLY → apply");
  assertEq(mod.resolvePrivacyRetentionMode("off"), "off", "mode: off → off");
  assertEq(mod.resolvePrivacyRetentionMonths(undefined), 24, "months: unset → 24");
  assertEq(mod.resolvePrivacyRetentionMonths("6"), 24, "months: 6 (< 12) → 24");
  assertEq(mod.resolvePrivacyRetentionMonths("11"), 24, "months: 11 (< 12) → 24");
  assertEq(mod.resolvePrivacyRetentionMonths("0"), 24, "months: 0 → 24");
  assertEq(mod.resolvePrivacyRetentionMonths("-3"), 24, "months: -3 → 24");
  assertEq(mod.resolvePrivacyRetentionMonths("2 4"), 24, "months: garbage → 24");
  assertEq(mod.resolvePrivacyRetentionMonths("12"), 12, "months: 12 allowed");
  assertEq(mod.resolvePrivacyRetentionMonths("36"), 36, "months: 36 allowed");
  assertEq(mod.computePrivacyRetentionCutoff(NOW, 24, 60), "2024-11-07 03:15:00", "cutoff: now − 24 months");
  assertEq(mod.computePrivacyRetentionCutoff(NOW, 12, 500), "2025-06-24 03:15:00", "cutoff: never closer than longest cooldown + 1 day");
  assertEq(
    mod.computePrivacyRetentionCutoff(new Date("2028-02-29T03:15:00Z"), 24, 60),
    "2026-02-28 03:15:00",
    "cutoff: 2028-02-29 − 24 months clamps to 2026-02-28",
  );
  assertEq(
    mod.computePrivacyRetentionCutoff(new Date("2026-03-31T03:15:00Z"), 25, 60),
    "2024-02-29 03:15:00",
    "cutoff: 2026-03-31 − 25 months clamps to 2024-02-29",
  );
  assertEq(
    mod.computePrivacyRetentionCutoff(new Date("2026-01-31T03:15:00Z"), 13, 60),
    "2024-12-31 03:15:00",
    "cutoff: 2026-01-31 − 13 months keeps day 31",
  );
  assertEq(mod.normalizeRetentionTs("2023-06-02T11:00:00.000Z"), "2023-06-02 11:00:00", "ts: ISO normalized");
  assertEq(mod.normalizeRetentionTs("Mon, 01 Jan 2023"), "9999-12-31 23:59:59", "ts: unparsable → newest (keep)");
  assertEq(mod.normalizeRetentionTs(null), null, "ts: null → none");

  const db = new Database(":memory:");
  try {
    initMod.__initSchemaForTesting(db as any);
    seedMain(db);

    const cfg = { enabled: true, threshold: 3, updated_at: null, updated_by: null, note: null, is_default: true } as any;
    const probe = ["cap@example.no", "replied@example.no", "cool@example.no", "old@example.no", "supp@example.no"];
    const decisions = () => {
      const lookup = vern.createMaxTouchStatusLookup(db, cfg);
      const out: Record<string, unknown> = {};
      for (const e of probe) {
        const s = vern.getMaxTouchStatusForEmail(db, e, cfg);
        const b = lookup(e);
        out[e] = {
          send_count: s.send_count,
          last_sent_at: s.last_sent_at,
          has_inbound_ever: s.has_inbound_ever,
          suppressed: s.suppressed,
          batch_same: JSON.stringify(s) === JSON.stringify(b),
        };
      }
      const sig = enrich.readRfbContactedSignals(db as any);
      out.crmOutEmails = [...sig.crmOutEmails].sort();
      out.gardssalgReply = opp.gardssalgProducerHasCrmReply(db as any, "prov-1");
      out.sentLog = count(db, `SELECT COUNT(*) AS c FROM outreach_sent_log`);
      return out;
    };

    const before = decisions();
    assertEq((before["cap@example.no"] as any).suppressed, true, "precondition: cap@ suppressed by the touch cap");
    assertEq((before["replied@example.no"] as any).suppressed, false, "precondition: replied@ not suppressed (replied)");
    assertEq((before["cool@example.no"] as any).last_sent_at, RECENT, "precondition: cool@ last send inside cooldown");
    assertEq(before.gardssalgReply, true, "precondition: gårdssalg reply guard sees prov-1's reply");

    const osBefore = db.prepare(`SELECT * FROM outreach_sent_log ORDER BY id`).all();
    const blockBefore = db.prepare(`SELECT * FROM agent_blocklist ORDER BY id`).all();

    // ── off / window / running guards ─────────────────────────────────────
    const snap0 = Buffer.from(db.serialize()).toString("base64");
    const off = await mod.runPrivacyRetention(db, { mode: "off", now: CLOCK });
    assertEq(off.stopped_reason, "mode_off", "off: does nothing");
    const outside = await mod.runPrivacyRetention(db, { mode: "apply", now: () => new Date("2026-11-07T08:00:00Z") });
    assertEq(outside.stopped_reason, "outside_window", "window: 08 UTC refused");
    mod.__setPrivacyRetentionRunningForTesting(true);
    const busy = await mod.runPrivacyRetention(db, { mode: "apply", now: CLOCK });
    mod.__setPrivacyRetentionRunningForTesting(false);
    assertEq(busy.stopped_reason, "already_running", "running flag: overlapping run refused");
    assertEq(Buffer.from(db.serialize()).toString("base64") === snap0, true, "off/window/running: DB unchanged");

    // ── dry_run ───────────────────────────────────────────────────────────
    const dry = await mod.runPrivacyRetention(db, { mode: "dry_run", now: CLOCK });
    assertEq(Buffer.from(db.serialize()).toString("base64") === snap0, true, "dry_run: DB byte-identical afterwards");
    assertEq(dry.deleted_total, 0, "dry_run: deleted_total 0");
    assertEq(dry.cutoff, "2024-11-07 03:15:00", "dry_run: cutoff");
    const expectedPlanned = {
      email_delivery_events: 1, // old
      crm_outbox: 4, // old, supp, cap, rep
      crm_actions: 4,
      crm_retro_tagging_audit: 4,
      crm_messages: 2 + 1 + 3 + 4 + 1, // old, supp, cap, rep, exp
      crm_threads: 5, // old, supp, cap, rep, exp
      crm_untriaged: 1, // old (weird kept)
      rfb_marketing_send_ledger: 1, // old (mixed kept)
      resend_webhook_events: 3, // old, supp, oslsoft
      email_bounces: 0, // never deleted: any bounce is a claim-code send block
    };
    assertEq(dry.planned, expectedPlanned, "dry_run: per-table planned counts");
    assertEq(dry.addresses_expired, 6, "dry_run: 6 expired addresses with deletable rows");
    const logLine = mod.formatPrivacyRetentionLog(dry);
    assertTrue(logLine.startsWith("[privacy-retention] mode=dry_run") && logLine.includes("no rows modified"), "dry_run: one [privacy-retention] log line");

    // ── apply ─────────────────────────────────────────────────────────────
    const app = await mod.runPrivacyRetention(db, { mode: "apply", now: CLOCK });
    assertEq(app.deleted, expectedPlanned, "apply: deletes exactly the dry_run counts");
    assertEq(app.deleted_total, dry.planned_total, "apply: deleted_total = dry_run planned_total");
    assertEq([app.capped, app.remaining, app.addresses_failed, app.addresses_skipped_changed], [false, 0, 0, 0], "apply: not capped, nothing left");

    for (const who of ["old", "supp", "cap", "rep"]) assertEq(threadRows(db, who), 0, `apply: ${who}@ correspondence deleted`);
    assertEq(count(db, `SELECT COUNT(*) AS c FROM crm_messages WHERE thread_id = 'th-exp'`), 0, "apply: exp@ messages deleted");
    for (const who of ["cool", "mixed", "new"]) assertTrue(threadRows(db, who) > 0, `apply: ${who}@ correspondence kept`);
    assertEq(count(db, `SELECT COUNT(*) AS c FROM rfb_marketing_send_ledger WHERE recipient_email = 'mixed@example.no'`), 1, "apply: mixed@ recent ledger kept");
    assertEq(count(db, `SELECT COUNT(*) AS c FROM crm_untriaged WHERE id = 'u-weird'`), 1, "apply: unparsable timestamp kept");
    assertEq(count(db, `SELECT COUNT(*) AS c FROM crm_untriaged WHERE id = 'u-old'`), 0, "apply: old untriaged deleted");
    assertEq(count(db, `SELECT COUNT(*) AS c FROM email_delivery_events`), 0, "apply: old delivery event deleted");
    assertEq(count(db, `SELECT COUNT(*) AS c FROM crm_contacts`), 8, "apply: crm_contacts rows kept (suppression memory)");

    assertEq(
      db.prepare(`SELECT resend_email_id AS id FROM email_bounces ORDER BY rowid`).all(),
      [{ id: "b-old-soft" }, { id: "b-supp-hard" }, { id: "b-supp-null" }, { id: "b-osl-soft" }],
      "apply: every email_bounces row kept (hard, soft, NULL type; with or without outreach_sent_log)",
    );
    assertEq(
      count(db, `SELECT COUNT(*) AS c FROM email_bounces WHERE LOWER(TRIM(email)) = 'old@example.no' AND bounce_type = 'soft' AND bounced_at < '${app.cutoff}'`),
      1,
      "apply: old soft bounce without outreach_sent_log row kept (claim-code block stays)",
    );
    assertEq(db.prepare(`SELECT * FROM agent_blocklist ORDER BY id`).all(), blockBefore, "apply: agent_blocklist untouched");
    assertEq(db.prepare(`SELECT * FROM outreach_sent_log ORDER BY id`).all(), osBefore, "apply: outreach_sent_log untouched");

    const marks = db
      .prepare(`SELECT id, retention_last_inbound_at AS i, retention_last_outbound_at AS o FROM crm_contacts WHERE id IN ('c-rep','c-cap','c-exp') ORDER BY id`)
      .all();
    assertEq(
      marks,
      [
        { id: "c-cap", i: null, o: OLD },
        { id: "c-exp", i: OLD, o: null },
        { id: "c-rep", i: OLD, o: OLD },
      ],
      "apply: contact markers hold the deleted messages' newest inbound/outbound",
    );

    // ── AC1: decisions identical before vs after ──────────────────────────
    const after = decisions();
    assertEq(after, before, "AC1: max-touch (both forms), cooldown input, gårdssalg reply guard, enrichment signal identical");
    assertEq((after["cap@example.no"] as any).suppressed, true, "AC1: cap@ still suppressed");
    assertEq((after["replied@example.no"] as any).has_inbound_ever, true, "AC1: replied@ still counts as replied");
    assertEq((after["cool@example.no"] as any).last_sent_at, RECENT, "AC1: cool@ still in cooldown");

    // Candidates' has_replied fragment (agent-keyed) — same SQL shape as admin-outreach-candidates.
    const hasRepliedSql = `
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM crm_contacts cc JOIN crm_threads ct ON ct.contact_id = cc.id JOIN crm_messages cm ON cm.thread_id = ct.id
        WHERE cc.agent_id = ? AND cm.direction = 'in')
      OR EXISTS (SELECT 1 FROM crm_contacts ccr WHERE ccr.agent_id = ? AND ccr.retention_last_inbound_at IS NOT NULL)
      THEN 1 ELSE 0 END AS r`;
    assertEq(
      [(db.prepare(hasRepliedSql).get("ag-rep", "ag-rep") as any).r, (db.prepare(hasRepliedSql).get("ag-cap", "ag-cap") as any).r],
      [1, 0],
      "AC1: candidates has_replied (agent-keyed) still 1 for ag-rep, 0 for ag-cap",
    );

    // Second night: nothing left to do.
    const again = await mod.runPrivacyRetention(db, { mode: "apply", now: CLOCK });
    assertEq([again.planned_total, again.deleted_total], [0, 0], "idempotent: second run deletes nothing");
    const prodLike = mod.formatPrivacyRetentionLog(again);
    assertTrue(prodLike.includes("remaining=0"), "apply log line includes remaining");
  } catch (err: any) {
    failed++;
    failures.push(`main: unexpected error: ${err?.stack || err}`);
  } finally {
    db.close();
  }

  // ── batch cap ───────────────────────────────────────────────────────────
  const db2 = new Database(":memory:");
  try {
    initMod.__initSchemaForTesting(db2 as any);
    for (let i = 0; i < 5; i++) addConversation(db2, `b${i}`, `b${i}@example.no`, OLD, { extras: false }); // 2 rows each
    const r1 = await mod.runPrivacyRetention(db2, { mode: "apply", now: CLOCK, maxRowsPerRun: 3, batchRows: 1 });
    assertEq([r1.deleted_total, r1.capped, r1.remaining, r1.stopped_reason], [4, true, 6, "row_cap"], "cap: stops after the cap, remaining 6");
    const r2 = await mod.runPrivacyRetention(db2, { mode: "apply", now: CLOCK, maxRowsPerRun: 3, batchRows: 1 });
    assertEq([r2.deleted_total, r2.remaining], [4, 2], "cap: next night continues");
    const r3 = await mod.runPrivacyRetention(db2, { mode: "apply", now: CLOCK, maxRowsPerRun: 3, batchRows: 1 });
    assertEq([r3.deleted_total, r3.remaining, r3.capped], [2, 0, false], "cap: third night finishes");
    assertEq(count(db2, `SELECT COUNT(*) AS c FROM crm_messages`), 0, "cap: all old messages gone after three nights");
  } catch (err: any) {
    failed++;
    failures.push(`cap: unexpected error: ${err?.stack || err}`);
  } finally {
    db2.close();
  }

  // ── race: a row written after the plan keeps the address ───────────────
  const db3 = new Database(":memory:");
  try {
    initMod.__initSchemaForTesting(db3 as any);
    addConversation(db3, "r1", "race@example.no", OLD, { extras: false });
    addConversation(db3, "r2", "calm@example.no", OLD, { extras: false });
    const r = await mod.runPrivacyRetention(db3, {
      mode: "apply",
      now: CLOCK,
      onPlanned: () => {
        db3.prepare(
          `INSERT INTO crm_messages (id, thread_id, direction, from_email, body_text, sent_at, vertical_id) VALUES ('m-late', 'th-r1', 'in', 'race@example.no', 'nytt svar', ?, 'rfb')`,
        ).run(NEW);
      },
    });
    assertEq([r.addresses_skipped_changed, r.addresses_processed], [1, 1], "race: changed address skipped, other processed");
    assertEq(count(db3, `SELECT COUNT(*) AS c FROM crm_messages WHERE thread_id = 'th-r1'`), 2, "race: skipped address fully kept");
    assertEq(count(db3, `SELECT COUNT(*) AS c FROM crm_messages WHERE thread_id = 'th-r2'`), 0, "race: other address deleted");
  } catch (err: any) {
    failed++;
    failures.push(`race: unexpected error: ${err?.stack || err}`);
  } finally {
    db3.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runPrivacyRetentionTests({ log: true }).then((s) => {
    console.log(`\nprivacy-retention: ${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
