// ─── CS på serveren, S1b: vakt + daglig oppsummering ─────────────────────
// dev-request 2026-11-10-cs-paa-serveren (slookisen/A2A), skive S1 punkt 1, 5, 6.
//
// Nothing may stop silently. This module is the server-side watcher that does
// not depend on the CS LLM routine being alive:
//
//   • retryFailedForwards — an inbound e-mail whose forward to Gmail failed
//     (inbound_email_log.forward_status 'failed', mail kept in
//     forward_payload) is re-sent with back-off (10, 20, 40 min); after
//     FORWARD_MAX_ATTEMPTS it stays 'failed' and is alerted.
//   • runCsWatchdog (hourly, CS_WATCHDOG_ENABLED) — computes «trenger svar»,
//     retries forwards, purges old log rows, e-mails the admin about every
//     NEW problem (a thread/untriaged item over 24 h, an exhausted forward, a
//     failed CRM registration) at most once per item per 24 h, and records a
//     run-ledger row (agent cs-watchdog) with the counts.
//   • runCsDailyDigest (daily 07:00 Europe/Oslo, CS_DAILY_DIGEST_ENABLED) — an
//     e-mail to the admin: what came in per platform, what went out, what
//     still needs a reply (with age), what is parked, and what failed.

import { getDb } from "../database/init";
import { emailService } from "./email-service";
import { computeNeedsReply, NeedsReplyReport } from "./crm-needs-reply";
import { recordRun } from "./run-ledger";
import { EnvelopeBuilder } from "../types/run-envelope";
import { getJobLastCompletedAt, markJobCompleted } from "./boot-job-gate";
import { parkPendingWhenAutosendOff, recoverExpiredLeases } from "./cs-reply-proposals";
import { failedReplyDeliveries } from "./crm-delivery-status";
import { contactRejectionsSince } from "./contact-form-cs";

export const CS_WATCHDOG_FLAG = "CS_WATCHDOG_ENABLED";
export const CS_DAILY_DIGEST_FLAG = "CS_DAILY_DIGEST_ENABLED";

function flagOn(name: string, env: NodeJS.ProcessEnv): boolean {
  const v = env[name];
  return v === "1" || v === "true";
}
export function csWatchdogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(CS_WATCHDOG_FLAG, env);
}
export function csDailyDigestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(CS_DAILY_DIGEST_FLAG, env);
}

export type SendFn = (opts: { to: string; subject: string; textContent: string; htmlContent?: string; replyTo?: string; omitAgentHeader?: boolean }) => Promise<unknown>;

function defaultSend(): SendFn {
  return (o) => emailService.sendEmail(o as any);
}

function succeeded(r: unknown): boolean {
  return !!r && typeof r === "object" && (r as { success?: unknown }).success === true;
}

// ─── Forward retry ────────────────────────────────────────────────────

export const FORWARD_MAX_ATTEMPTS = 4;
export const FORWARD_RETRY_BASE_MIN = 10;

/** Is a failed forward with `attempts` tries, last touched at `lastAt`, due for another try at `now`? */
export function forwardRetryDue(attempts: number, lastAt: string | null, now: Date): boolean {
  if (attempts >= FORWARD_MAX_ATTEMPTS) return false;
  if (!lastAt) return true;
  const last = Date.parse(lastAt.includes("T") ? lastAt : lastAt.replace(" ", "T") + "Z");
  if (!Number.isFinite(last)) return true;
  const waitMin = FORWARD_RETRY_BASE_MIN * Math.pow(2, Math.max(0, attempts - 1));
  return now.getTime() - last >= waitMin * 60_000;
}

export interface ForwardRetryResult {
  retried: number;
  recovered: number;
  exhausted: Array<{ id: string; subject: string | null; from_email: string | null; received_at: string; error: string | null }>;
}

export async function retryFailedForwards(deps: { send?: SendFn; now?: Date } = {}): Promise<ForwardRetryResult> {
  const db = getDb();
  const now = deps.now ?? new Date();
  const send = deps.send ?? defaultSend();
  const exhausted: ForwardRetryResult["exhausted"] = [];
  const exhaust = (r: { id: string; subject: string | null; from_email: string | null; received_at: string }, error: string | null) => {
    db.prepare(
      `UPDATE inbound_email_log SET forward_status = 'exhausted', forward_error = COALESCE(?, forward_error), updated_at = datetime('now') WHERE id = ?`,
    ).run(error, r.id);
    exhausted.push({ id: r.id, subject: r.subject, from_email: r.from_email, received_at: r.received_at, error });
  };
  // Rows that reached the limit under an older build: make them terminal too.
  const stale = db
    .prepare(
      `SELECT id, subject, from_email, received_at, forward_error FROM inbound_email_log
        WHERE forward_status = 'failed' AND (forward_attempts >= ? OR forward_payload IS NULL)`,
    )
    .all(FORWARD_MAX_ATTEMPTS) as Array<{ id: string; subject: string | null; from_email: string | null; received_at: string; forward_error: string | null }>;
  for (const r of stale) exhaust(r, r.forward_error ?? "no forward_payload");

  // Only rows that may still be retried: an exhausted row never takes a slot
  // from a newer failure.
  const rows = db
    .prepare(
      `SELECT id, forward_attempts, updated_at, forward_payload, subject, from_email, received_at, forward_error
         FROM inbound_email_log
        WHERE forward_status = 'failed' AND forward_attempts < ? AND forward_payload IS NOT NULL
        ORDER BY received_at ASC LIMIT 100`,
    )
    .all(FORWARD_MAX_ATTEMPTS) as Array<{
      id: string; forward_attempts: number; updated_at: string | null; forward_payload: string;
      subject: string | null; from_email: string | null; received_at: string; forward_error: string | null;
    }>;
  let retried = 0;
  let recovered = 0;
  for (const r of rows) {
    if (!forwardRetryDue(r.forward_attempts, r.updated_at, now)) continue;
    let payload: any;
    try {
      payload = JSON.parse(r.forward_payload);
    } catch {
      db.prepare("UPDATE inbound_email_log SET forward_attempts = ? WHERE id = ?").run(FORWARD_MAX_ATTEMPTS, r.id);
      exhaust(r, "unparseable forward_payload");
      continue;
    }
    // Claim the try before the await, conditionally on the row being exactly
    // as this run read it: a second, overlapping run loses the claim.
    const claimed = db
      .prepare(
        `UPDATE inbound_email_log SET updated_at = datetime('now')
          WHERE id = ? AND forward_status = 'failed' AND forward_attempts = ? AND COALESCE(updated_at, '') = COALESCE(?, '')`,
      )
      .run(r.id, r.forward_attempts, r.updated_at);
    if (claimed.changes !== 1) continue;
    retried++;
    let res: unknown;
    let err: string | null = null;
    try {
      res = await send(payload);
    } catch (e: any) {
      err = String(e?.message ?? e);
    }
    const attempts = r.forward_attempts + 1;
    if (succeeded(res)) {
      recovered++;
      db.prepare(
        `UPDATE inbound_email_log SET forward_status = 'ok', forward_attempts = ?, forwarded_at = ?, forward_payload = NULL,
           forward_error = NULL, updated_at = datetime('now') WHERE id = ?`,
      ).run(attempts, now.toISOString(), r.id);
    } else {
      const msg = (err ?? (res && typeof res === "object" ? String((res as any).error ?? "send failed") : "send failed")).slice(0, 500);
      db.prepare("UPDATE inbound_email_log SET forward_attempts = ?, forward_error = ?, updated_at = datetime('now') WHERE id = ?")
        .run(attempts, msg, r.id);
      if (attempts >= FORWARD_MAX_ATTEMPTS) exhaust(r, msg);
    }
  }
  return { retried, recovered, exhausted };
}

// ─── Log retention ────────────────────────────────────────────────────

export const INBOUND_LOG_RETENTION_DAYS = 90;

export const EXHAUSTED_PAYLOAD_DAYS = 30;

/**
 * Delete log rows older than the retention window, and drop the stored mail
 * body of a forward that was given up on more than EXHAUSTED_PAYLOAD_DAYS ago
 * (it was alerted; the e-mail itself is in the CRM when server ingest is on).
 */
export function purgeInboundLog(now: Date = new Date()): number {
  const db = getDb();
  db.prepare(
    `UPDATE inbound_email_log SET forward_payload = NULL
      WHERE forward_status = 'exhausted' AND forward_payload IS NOT NULL AND julianday(received_at) < julianday(?) - ?`,
  ).run(now.toISOString(), EXHAUSTED_PAYLOAD_DAYS);
  const r = db
    .prepare(`DELETE FROM inbound_email_log WHERE julianday(received_at) < julianday(?) - ?`)
    .run(now.toISOString(), INBOUND_LOG_RETENTION_DAYS);
  return r.changes;
}

// ─── Alert de-duplication ────────────────────────────────────────────

/**
 * Is `key` due for an alert? Never alerted → yes. `once` keys are alerted a
 * single time; others again after 24 h. Read-only: the key is recorded by
 * recordAlerts() only once the alert e-mail was actually accepted.
 */
export function alertDue(key: string, now: Date = new Date(), once = false): boolean {
  const row = getDb().prepare("SELECT last_alerted_at FROM cs_alert_log WHERE alert_key = ?").get(key) as
    | { last_alerted_at: string }
    | undefined;
  if (!row) return true;
  if (once) return false;
  const last = Date.parse(row.last_alerted_at);
  return !Number.isFinite(last) || now.getTime() - last >= 24 * 3600_000;
}

export function recordAlerts(keys: string[], now: Date = new Date()): void {
  const db = getDb();
  const ts = now.toISOString();
  const up = db.prepare(
    `INSERT INTO cs_alert_log (alert_key, first_alerted_at, last_alerted_at, count) VALUES (?, ?, ?, 1)
     ON CONFLICT(alert_key) DO UPDATE SET last_alerted_at = excluded.last_alerted_at, count = count + 1`,
  );
  db.transaction(() => {
    for (const k of keys) up.run(k, ts, ts);
  })();
}

/** Due-check and record in one step (kept for callers that alert without e-mail). */
export function claimAlert(key: string, now: Date = new Date()): boolean {
  if (!alertDue(key, now)) return false;
  recordAlerts([key], now);
  return true;
}

const PLATFORM_NAME: Record<string, string> = { rfb: "Rett fra Bonden", experiences: "Opplevagent", dental: "Finn tannlege" };
function platformName(v: string | null | undefined): string {
  return (v && PLATFORM_NAME[v]) || v || "ukjent plattform";
}

function adminCrmUrl(): string {
  const base = (process.env.PUBLIC_BASE_URL || "https://rettfrabonden.com").replace(/\/+$/, "");
  return `${base}/admin-crm.html`;
}

// ─── Watchdog ─────────────────────────────────────────────────────────

export interface WatchdogResult {
  run_id: string;
  report_counts: NeedsReplyReport["counts"];
  forward: ForwardRetryResult;
  purged: number;
  alerted_items: number;
  alert_sent: boolean | null;
  envelope_recorded: boolean;
}

/** Per-run stamp to the second: runs.run_id is ON CONFLICT DO NOTHING, so an hourly id would drop a second run in the same hour. */
function runStamp(now: Date): string {
  return now.toISOString().slice(0, 19).replace(/[:]/g, "");
}

/** Most items one alert e-mail itemizes (and records). */
export const ALERT_MAX_LINES = 40;

export interface AlertItem {
  key: string;
  /** Alerted a single time (true) or again every 24 h while it lasts (false). */
  once: boolean;
  line: string;
}

export async function runCsWatchdog(
  deps: {
    send?: SendFn;
    now?: Date;
    adminEmail?: string | null;
    trigger?: "cron" | "manual";
    env?: NodeJS.ProcessEnv;
    /** Extra alert items (tests; later slices). */
    extraItems?: (now: Date) => AlertItem[];
  } = {},
): Promise<WatchdogResult> {
  const now = deps.now ?? new Date();
  const send = deps.send ?? defaultSend();
  const runId = `run-${runStamp(now)}-cs-watchdog`;
  const env = new EnvelopeBuilder({ run_id: runId, vertical: "rfb", agent: "cs-watchdog", trigger_source: deps.trigger ?? "cron" });

  let forward: ForwardRetryResult = { retried: 0, recovered: 0, exhausted: [] };
  try {
    forward = await retryFailedForwards({ send, now });
  } catch (e: any) {
    env.error(`retryFailedForwards: ${String(e?.message ?? e)}`);
  }
  let purged = 0;
  try {
    purged = purgeInboundLog(now);
  } catch (e: any) {
    env.error(`purgeInboundLog: ${String(e?.message ?? e)}`);
  }
  const report = computeNeedsReply({});

  // Every item that may need an alert. A key is recorded in cs_alert_log only
  // AFTER the alert e-mail was accepted — a relay outage or a missing admin
  // address leaves the items due, so the next run tries again.
  const items: AlertItem[] = [];
  const db = getDb();
  const exhaustedRows = db
    .prepare(
      `SELECT l.id, l.subject, l.from_email, l.received_at, l.forward_error FROM inbound_email_log l
        WHERE l.forward_status = 'exhausted'
          AND NOT EXISTS (SELECT 1 FROM cs_alert_log a WHERE a.alert_key = 'forward:' || l.id)
        ORDER BY l.received_at ASC LIMIT 200`,
    )
    .all() as Array<{ id: string; subject: string | null; from_email: string | null; received_at: string; forward_error: string | null }>;
  for (const f of exhaustedRows) {
    items.push({
      key: `forward:${f.id}`,
      once: true,
      line: `• [Videresending feilet ${FORWARD_MAX_ATTEMPTS} ganger] ${f.subject ?? "(uten emne)"} — fra ${f.from_email ?? "?"}, mottatt ${f.received_at}: ${f.forward_error ?? "ukjent feil"}`,
    });
  }
  for (const f of db
    .prepare(
      `SELECT l.id, l.subject, l.from_email, l.received_at FROM inbound_email_log l
        WHERE l.forward_status = 'pending' AND julianday(l.received_at) < julianday(?) - 30.0 / 1440
          AND NOT EXISTS (SELECT 1 FROM cs_alert_log a WHERE a.alert_key = 'forward-pending:' || l.id)
        ORDER BY l.received_at ASC LIMIT 100`,
    )
    .all(now.toISOString()) as Array<{ id: string; subject: string | null; from_email: string | null; received_at: string }>) {
    items.push({
      key: `forward-pending:${f.id}`,
      once: true,
      line: `• [Videresending uavklart] ${f.subject ?? "(uten emne)"} — fra ${f.from_email ?? "?"}, mottatt ${f.received_at}: serveren stoppet før videresendingen var ferdig`,
    });
  }
  const regErrors = db
    .prepare(
      `SELECT id, subject, from_email, crm_error FROM inbound_email_log
        WHERE crm_status = 'error' AND julianday(received_at) >= julianday(?) - 7`,
    )
    .all(now.toISOString()) as Array<{ id: string; subject: string | null; from_email: string | null; crm_error: string | null }>;
  for (const r of regErrors) {
    items.push({ key: `register:${r.id}`, once: true, line: `• [Ikke registrert i CRM] ${r.subject ?? "(uten emne)"} — fra ${r.from_email ?? "?"}: ${r.crm_error ?? "ukjent feil"}` });
  }
  // S2: replies that did not get out, and outbox rows nobody finished.
  try {
    const parked = parkPendingWhenAutosendOff(deps.env ?? process.env, now);
    if (parked > 0) env.notes(`autosend off: ${parked} pending proposal(s) moved to the approval queue`);
    recoverExpiredLeases(now);
    for (const f of db
      .prepare(
        `SELECT p.id, p.vertical, p.subject, p.to_email, p.block_reason, p.block_detail, p.last_error
           FROM cs_reply_proposals p
          WHERE p.status = 'failed' AND julianday(p.updated_at) >= julianday(?) - 7
          ORDER BY p.updated_at ASC LIMIT 100`,
      )
      .all(now.toISOString()) as Array<{ id: string; vertical: string; subject: string; to_email: string; block_reason: string | null; block_detail: string | null; last_error: string | null }>) {
      items.push({
        key: `proposal:${f.id}`,
        once: true,
        line: `• [Svar ikke sendt] [${platformName(f.vertical)}] ${f.subject} — til ${f.to_email}: ${f.block_detail ?? f.last_error ?? f.block_reason ?? "ukjent feil"}`,
      });
    }
  } catch (e: any) {
    env.error(`proposal checks: ${String(e?.message ?? e)}`);
  }
  const draftStaleMin = Math.max(60, parseInt(String((deps.env ?? process.env).CS_OUTBOX_DRAFT_STALE_MINUTES ?? ""), 10) || 360);
  for (const o of db
    .prepare(
      `SELECT id, intent, status, vertical_id, subject, created_at FROM crm_outbox
        WHERE (intent = 'resend_send' AND status IN ('pending', 'processing') AND julianday(created_at) < julianday(?) - 1.0 / 24)
           OR (intent = 'gmail_draft' AND status IN ('pending', 'processing') AND julianday(created_at) < julianday(?) - ? / 1440.0)
        ORDER BY created_at ASC LIMIT 100`,
    )
    .all(now.toISOString(), now.toISOString(), draftStaleMin) as Array<{ id: string; intent: string; status: string; vertical_id: string; subject: string; created_at: string }>) {
    // A resend_send row that waits for its own retry belongs to a proposal and is not stuck.
    const owner = (() => {
      try {
        return db.prepare(`SELECT status FROM cs_reply_proposals WHERE outbox_id = ?`).get(o.id) as { status: string } | undefined;
      } catch {
        return undefined;
      }
    })();
    if (owner && (owner.status === "pending" || owner.status === "approved" || owner.status === "sending")) continue;
    items.push({
      key: `outbox:${o.id}`,
      once: true,
      line: `• [Utboks henger] [${platformName(o.vertical_id)}] ${o.subject} — ${o.intent === "gmail_draft" ? "Gmail-utkast" : "sending"} ${o.status} siden ${o.created_at}`,
    });
  }
  // S3: a reply that bounced or drew a complaint — the thread is back in «Trenger svar».
  for (const d of failedReplyDeliveries(new Date(now.getTime() - 7 * 86400_000).toISOString())) {
    items.push({
      key: `delivery:${d.crm_message_id}`,
      once: true,
      line: `• [Svar ${d.status === "complained" ? "merket som spam" : "kom ikke fram (bounce)"}] [${platformName(d.vertical)}] ${d.subject ?? "(uten emne)"} — til ${d.to_emails ?? "?"}${d.detail ? `: ${d.detail}` : ""}`,
    });
  }
  for (const extra of deps.extraItems?.(now) ?? []) items.push(extra);
  // Threads last: a backlog of old threads must never push a one-time problem
  // (an exhausted forward, a failed registration) out of the e-mail.
  for (const u of report.untriaged.filter((x) => x.level === "p0")) {
    items.push({
      key: `untriaged:${u.id}`,
      once: u.age_hours > 14 * 24,
      line: `• [Ikke fordelt] ${u.subject ?? "(uten emne)"} — fra ${u.from_email}, ${Math.floor(u.age_hours)} t (plattform ukjent)`,
    });
  }
  for (const t of report.threads.filter((x) => x.level === "p0")) {
    items.push({
      key: `thread:${t.thread_id}`,
      // A thread already two weeks old is a backlog item: alerted once, then only in the digest.
      once: t.age_hours > 14 * 24,
      line: `• [${platformName(t.vertical)}] ${t.subject ?? "(uten emne)"} — fra ${t.contact_email}, ${Math.floor(t.age_hours)} t uten svar (tråd ${t.thread_id})`,
    });
  }

  const due = items.filter((i) => alertDue(i.key, now, i.once));
  // Only what the e-mail itemizes is recorded as alerted; the rest stays due
  // and is itemized by the next run.
  const shown = due.slice(0, ALERT_MAX_LINES);
  const lines = shown.map((i) => i.line);

  let alertSent: boolean | null = null;
  const adminEmail = (deps.adminEmail !== undefined ? deps.adminEmail : process.env.ADMIN_NOTIFICATION_EMAIL || "")?.trim() || "";
  if (lines.length > 0) {
    if (!adminEmail) {
      alertSent = false;
      env.error("ADMIN_NOTIFICATION_EMAIL is not set — CS alert could not be sent", { items: lines.length });
      console.error(`[cs-watchdog] ${lines.length} new item(s) need attention but ADMIN_NOTIFICATION_EMAIL is not set`);
    } else {
      const text =
        `Disse sakene har ingen svar eller håndtering etter 24 timer, eller har feilet:\n\n` +
        lines.join("\n") +
        (due.length > shown.length ? `\n… og ${due.length - shown.length} til (kommer i neste varsel).` : "") +
        `\n\nAlt som venter: ${adminCrmUrl()} (Trenger svar)\n` +
        `Totalt nå: ${report.counts.threads} tråder trenger svar (${report.counts.p0} over 24 t, ${report.counts.p1} over 12 t), ` +
        `${report.counts.untriaged_open} ikke fordelt, ${report.counts.forward_failed} videresendinger feilet.\n\n` +
        `Hver sak varsles høyst én gang per døgn. — CS-vakten på serveren`;
      try {
        alertSent = succeeded(await send({ to: adminEmail, subject: `CS-vakt: ${due.length} sak(er) trenger handling`, textContent: text, omitAgentHeader: true }));
      } catch (e: any) {
        alertSent = false;
        env.error(`alert send failed: ${String(e?.message ?? e)}`);
      }
      if (alertSent) {
        try {
          recordAlerts(shown.map((i) => i.key), now);
        } catch (e: any) {
          env.error(`recordAlerts failed: ${String(e?.message ?? e)}`);
        }
      } else {
        env.error("CS alert e-mail was not accepted by the mail relay", { items: lines.length });
      }
    }
  }

  env.claim({
    type: "custom",
    value: report.counts.p0,
    meta: {
      kind: "cs_needs_reply",
      threads: report.counts.threads,
      p0: report.counts.p0,
      p1: report.counts.p1,
      by_vertical: report.counts.by_vertical,
      untriaged_open: report.counts.untriaged_open,
      forward_failed: report.counts.forward_failed,
      crm_register_errors_7d: report.counts.crm_register_errors_7d,
      oldest: report.threads.slice(0, 10).map((t) => ({ thread_id: t.thread_id, vertical: t.vertical, age_hours: t.age_hours })),
    },
  });
  env.claim({
    type: "custom",
    value: forward.recovered,
    meta: { kind: "cs_forward_retry", retried: forward.retried, recovered: forward.recovered, exhausted: forward.exhausted.length },
  });
  env.claim({ type: "custom", value: lines.length, meta: { kind: "cs_alert", new_items: lines.length, sent: alertSent, purged_log_rows: purged } });
  env.notes(
    `needs_reply=${report.counts.threads} p0=${report.counts.p0} p1=${report.counts.p1} untriaged=${report.counts.untriaged_open} ` +
      `forward_failed=${report.counts.forward_failed} retried=${forward.retried} recovered=${forward.recovered} new_alerts=${lines.length} sent=${alertSent}`,
  );
  const status = alertSent === false ? "partial" : "completed";
  let recorded = false;
  try {
    recordRun(env.finish(status));
    recorded = true;
  } catch (e) {
    console.error("[cs-watchdog] recordRun failed:", e);
  }
  return { run_id: runId, report_counts: report.counts, forward, purged, alerted_items: lines.length, alert_sent: alertSent, envelope_recorded: recorded };
}

// ─── Daily digest ─────────────────────────────────────────────────────

export const CS_DIGEST_HOUR_OSLO = 7;
export const CS_DIGEST_JOB = "cs-daily-digest";
export const CS_WATCHDOG_JOB = "cs-watchdog";

/** {date "YYYY-MM-DD", hour 0-23} in Europe/Oslo. */
export function osloClock(now: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: parseInt(get("hour"), 10) };
}

/** Due when it is ≥ 07:00 in Oslo and the last digest was not sent on this Oslo date. */
export function digestDue(now: Date, lastRunAt: Date | null): boolean {
  const c = osloClock(now);
  if (c.hour < CS_DIGEST_HOUR_OSLO) return false;
  if (!lastRunAt) return true;
  return osloClock(lastRunAt).date !== c.date;
}

/** Hourly watchdog due when ≥ 55 min since the last run. */
export function watchdogDue(now: Date, lastRunAt: Date | null): boolean {
  return !lastRunAt || now.getTime() - lastRunAt.getTime() >= 55 * 60_000;
}

export function buildDailyDigest(now: Date = new Date()): { subject: string; text: string; counts: Record<string, unknown> } {
  const db = getDb();
  const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const inbound = db
    .prepare(
      `SELECT COALESCE(vertical, '-') AS vertical, crm_status, COUNT(*) AS n
         FROM inbound_email_log WHERE julianday(received_at) >= julianday(?) GROUP BY 1, 2`,
    )
    .all(since) as Array<{ vertical: string; crm_status: string; n: number }>;
  const forms = db
    .prepare(
      `SELECT vertical_id AS vertical, COUNT(*) AS n FROM crm_threads
        WHERE id LIKE 'kontakt-%' AND julianday(created_at) >= julianday(?) GROUP BY 1`,
    )
    .all(since) as Array<{ vertical: string; n: number }>;
  const outbound = db
    .prepare(
      `SELECT vertical_id AS vertical, delivery_status AS status, COUNT(*) AS n FROM crm_messages
        WHERE direction = 'out' AND julianday(COALESCE(sent_at, received_at)) >= julianday(?) GROUP BY 1, 2`,
    )
    .all(since) as Array<{ vertical: string; status: string; n: number }>;
  const report = computeNeedsReply({});

  const lines: string[] = [];
  lines.push(`Kundeservice siste døgn (til ${osloClock(now).date} kl. ${String(CS_DIGEST_HOUR_OSLO).padStart(2, "0")}:00).`);
  lines.push("");
  lines.push("INN");
  const vs = new Set<string>([...inbound.map((r) => r.vertical), ...forms.map((r) => r.vertical)]);
  if (vs.size === 0) lines.push("• Ingen e-post eller kontaktskjema mottatt via plattformadressene.");
  for (const v of [...vs].sort()) {
    const rows = inbound.filter((r) => r.vertical === v);
    const total = rows.reduce((a, r) => a + r.n, 0);
    const by = rows.map((r) => `${r.crm_status} ${r.n}`).join(", ");
    const f = forms.find((r) => r.vertical === v)?.n ?? 0;
    lines.push(`• ${v === "-" ? "Ukjent plattform" : platformName(v)}: ${total} e-post${by ? ` (${by})` : ""}, ${f} kontaktskjema`);
  }
  // S5: rejected contact-form submissions (spam protection at work, or a broken form).
  const rejected = contactRejectionsSince(since);
  if (rejected.length > 0) {
    const byP = new Map<string, string[]>();
    for (const r of rejected) byP.set(r.platform, [...(byP.get(r.platform) ?? []), `${r.reason} ${r.n}`]);
    for (const [p, parts] of byP) lines.push(`• ${platformName(p)}: kontaktskjema avvist — ${parts.join(", ")}`);
  }
  lines.push("");
  lines.push("UT");
  if (outbound.length === 0) lines.push("• Ingen svar eller utsendinger registrert i CRM.");
  for (const v of [...new Set(outbound.map((r) => r.vertical))].sort()) {
    const rows = outbound.filter((r) => r.vertical === v);
    lines.push(`• ${platformName(v)}: ${rows.map((r) => `${r.status} ${r.n}`).join(", ")}`);
  }
  // S2: what the server sent on its own vs. what Daniel sent from the queue, and what waits for him.
  let proposalCounts: Record<string, unknown> = {};
  try {
    const sentRows = db
      .prepare(
        `SELECT vertical, sent_mode, COUNT(*) AS n FROM cs_reply_proposals
          WHERE status = 'sent' AND julianday(sent_at) >= julianday(?) GROUP BY 1, 2`,
      )
      .all(since) as Array<{ vertical: string; sent_mode: string; n: number }>;
    for (const v of [...new Set(sentRows.map((r) => r.vertical))].sort()) {
      const auto = sentRows.find((r) => r.vertical === v && r.sent_mode === "auto")?.n ?? 0;
      const appr = sentRows.find((r) => r.vertical === v && r.sent_mode === "approved")?.n ?? 0;
      lines.push(`• ${platformName(v)}: ${auto} svar sendt automatisk, ${appr} sendt av Daniel fra godkjenningskøen`);
    }
    const queue = db
      .prepare(
        `SELECT p.id, p.vertical, p.subject, p.block_reason, (julianday(?) - julianday(p.created_at)) * 24.0 AS age_h
           FROM cs_reply_proposals p WHERE p.status = 'approval_needed' ORDER BY p.created_at ASC LIMIT 200`,
      )
      .all(now.toISOString()) as Array<{ id: string; vertical: string; subject: string; block_reason: string | null; age_h: number }>;
    const failed = db
      .prepare(
        `SELECT vertical, subject, to_email, COALESCE(block_detail, last_error, block_reason) AS why FROM cs_reply_proposals
          WHERE status = 'failed' AND julianday(updated_at) >= julianday(?) ORDER BY updated_at ASC LIMIT 50`,
      )
      .all(since) as Array<{ vertical: string; subject: string; to_email: string; why: string | null }>;
    const viaApi = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM crm_actions WHERE type = 'proposal_approved' AND julianday(created_at) >= julianday(?)
             AND json_valid(payload) AND json_extract(payload, '$.source') = 'api'`,
        )
        .get(since) as { n: number }
    ).n;
    lines.push("");
    lines.push(`GODKJENNINGSKØ: ${queue.length} svarforslag venter på deg${queue.some((q) => q.age_h > 48) ? ` (${queue.filter((q) => q.age_h > 48).length} over 48 t — påminnelse)` : ""}`);
    for (const q of queue.slice(0, 20)) {
      lines.push(`• ${Math.floor(q.age_h)} t — [${platformName(q.vertical)}] ${q.subject} — stoppet: ${q.block_reason ?? "?"}${q.age_h > 48 ? " ⚠" : ""}`);
    }
    if (queue.length > 20) lines.push(`• … og ${queue.length - 20} til.`);
    if (failed.length > 0) {
      lines.push("");
      lines.push(`SVAR SOM IKKE KOM UT siste døgn: ${failed.length}`);
      for (const f of failed.slice(0, 20)) lines.push(`• [${platformName(f.vertical)}] ${f.subject} — til ${f.to_email}: ${f.why ?? "ukjent feil"}`);
    }
    const bounced = failedReplyDeliveries(since);
    if (bounced.length > 0) {
      lines.push("");
      lines.push(`SVAR SOM BOUNCET ELLER BLE MERKET SOM SPAM siste døgn: ${bounced.length} (trådene ligger igjen i «Trenger svar»)`);
      for (const b of bounced.slice(0, 20)) lines.push(`• [${platformName(b.vertical)}] ${b.subject ?? "(uten emne)"} — ${b.status}${b.detail ? ` (${b.detail})` : ""}`);
    }
    if (viaApi > 0) lines.push(`Merk: ${viaApi} forslag ble godkjent via API-et, ikke fra admin-siden.`);
    proposalCounts = { sent: sentRows, approval_queue: queue.length, approval_over_48h: queue.filter((q) => q.age_h > 48).length, failed_24h: failed.length, approved_via_api: viaApi };
  } catch {
    // cs_reply_proposals missing (pre-migration DB)
  }
  lines.push("");
  lines.push(`TRENGER SVAR: ${report.counts.threads} (${report.counts.p0} over 24 t, ${report.counts.p1} over 12 t)`);
  for (const t of report.threads.slice().sort((a, b) => b.age_hours - a.age_hours).slice(0, 25)) {
    lines.push(`• ${Math.floor(t.age_hours)} t — [${platformName(t.vertical)}] ${t.subject ?? "(uten emne)"} — ${t.contact_email}`);
  }
  if (report.threads.length > 25) lines.push(`• … og ${report.threads.length - 25} til.`);
  lines.push("");
  lines.push(`IKKE FORDELT TIL PLATTFORM: ${report.counts.untriaged_open}`);
  for (const u of report.untriaged.slice(0, 10)) {
    lines.push(`• ${Math.floor(u.age_hours)} t — ${u.subject ?? "(uten emne)"} — ${u.from_email}`);
  }
  lines.push("");
  lines.push(`FEIL: ${report.counts.forward_failed} videresending(er) til Gmail feilet, ${report.counts.crm_register_errors_7d} e-post ikke registrert i CRM siste 7 døgn.`);
  lines.push("");
  lines.push(`Alt som venter: ${adminCrmUrl()}`);
  lines.push("— Daglig oppsummering fra serveren (CS_DAILY_DIGEST_ENABLED)");

  const subject = `CS-oppsummering ${osloClock(now).date}: ${report.counts.threads} trenger svar (${report.counts.p0} over 24 t)`;
  return {
    subject,
    text: lines.join("\n"),
    counts: { inbound, forms, contact_form_rejected: rejected, outbound, needs_reply: report.counts, proposals: proposalCounts },
  };
}

export async function runCsDailyDigest(deps: { send?: SendFn; now?: Date; adminEmail?: string | null; trigger?: "cron" | "manual" } = {}): Promise<{
  run_id: string; sent: boolean; reason: string | null; envelope_recorded: boolean;
}> {
  const now = deps.now ?? new Date();
  const send = deps.send ?? defaultSend();
  // Per run, not per day: runs is ON CONFLICT DO NOTHING, so a successful
  // retry after a failed attempt must get its own row.
  const runId = `run-${runStamp(now)}-cs-daily-digest`;
  const env = new EnvelopeBuilder({ run_id: runId, vertical: "rfb", agent: "cs-daily-digest", trigger_source: deps.trigger ?? "cron" });
  const digest = buildDailyDigest(now);
  const adminEmail = (deps.adminEmail !== undefined ? deps.adminEmail : process.env.ADMIN_NOTIFICATION_EMAIL || "")?.trim() || "";
  let sent = false;
  let reason: string | null = null;
  if (!adminEmail) {
    reason = "no_admin_email";
    env.error("ADMIN_NOTIFICATION_EMAIL is not set — daily digest not sent");
    console.error("[cs-daily-digest] ADMIN_NOTIFICATION_EMAIL is not set — digest not sent");
  } else {
    try {
      sent = succeeded(await send({ to: adminEmail, subject: digest.subject, textContent: digest.text, omitAgentHeader: true }));
      if (!sent) reason = "relay_refused";
    } catch (e: any) {
      reason = `send_threw: ${String(e?.message ?? e)}`.slice(0, 200);
    }
    if (!sent) env.error(`daily digest not accepted: ${reason}`);
  }
  env.claim({ type: "emails_sent", value: sent ? 1 : 0, meta: { kind: "cs_daily_digest", counts: digest.counts } });
  env.notes(`digest ${sent ? "sent" : "NOT sent"}: ${digest.subject}`);
  let recorded = false;
  try {
    recordRun(env.finish(sent ? "completed" : "failed"));
    recorded = true;
  } catch (e) {
    console.error("[cs-daily-digest] recordRun failed:", e);
  }
  return { run_id: runId, sent, reason, envelope_recorded: recorded };
}

// ─── Tick (called every 10 min from index.ts) ────────────────────────

export interface CsTickState {
  lastWatchdogAt: Date | null;
  lastDigestAt: Date | null;
  /** Last digest attempt that did NOT get through — retried after ≥ 55 min, not every tick. */
  lastDigestAttemptAt?: Date | null;
  /** Last log purge (runs daily even with both flags off — the log is always written). */
  lastPurgeAt?: Date | null;
}

let tickInFlight = false;
let tickStartedAt = 0;
let tickStuckReported = false;
/** A tick running longer than this is reported (the relay is hanging). */
export const TICK_STUCK_MS = 30 * 60_000;

/** For tests: whether a tick is running right now. */
export function csTickInFlight(): boolean {
  return tickInFlight;
}

export async function tickCsWatchdog(
  state: CsTickState,
  deps: { now?: Date; send?: SendFn; env?: NodeJS.ProcessEnv; extraItems?: (now: Date) => AlertItem[] } = {},
): Promise<{
  lastWatchdogAt: Date | null;
  lastDigestAt: Date | null;
  lastDigestAttemptAt: Date | null;
  lastPurgeAt: Date | null;
  ranWatchdog: boolean;
  ranDigest: boolean;
  ranPurge: boolean;
  skippedOverlap: boolean;
}> {
  const now = deps.now ?? new Date();
  const env = deps.env ?? process.env;
  let { lastWatchdogAt, lastDigestAt } = state;
  let lastDigestAttemptAt = state.lastDigestAttemptAt ?? null;
  let lastPurgeAt = state.lastPurgeAt ?? null;
  let ranWatchdog = false;
  let ranDigest = false;
  let ranPurge = false;
  // A slow relay can make one run outlast the 10-min interval; a second run
  // over the same rows would forward the same customer e-mail twice.
  if (tickInFlight) {
    if (!tickStuckReported && Date.now() - tickStartedAt > TICK_STUCK_MS) {
      tickStuckReported = true;
      const mins = Math.round((Date.now() - tickStartedAt) / 60_000);
      console.error(`[cs-watchdog] a tick has been running for ${mins} min — watchdog, digest and purge are blocked (mail relay hanging?)`);
      try {
        const b = new EnvelopeBuilder({ run_id: `run-${runStamp(now)}-cs-watchdog`, vertical: "rfb", agent: "cs-watchdog", trigger_source: "cron" });
        b.error(`tick stuck for ${mins} min — watchdog, digest and purge blocked`);
        recordRun(b.finish("failed"));
      } catch {
        // ledger down — the console line above is what is left
      }
    }
    return { lastWatchdogAt, lastDigestAt, lastDigestAttemptAt, lastPurgeAt, ranWatchdog, ranDigest, ranPurge, skippedOverlap: true };
  }
  tickInFlight = true;
  tickStartedAt = Date.now();
  tickStuckReported = false;
  try {
    const db = getDb();
    const watchOn = csWatchdogEnabled(env);
    if (watchOn) {
      const persisted = getJobLastCompletedAt(db, CS_WATCHDOG_JOB);
      const last = [lastWatchdogAt, persisted].filter((d): d is Date => !!d && d.getTime() <= now.getTime()).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      if (watchdogDue(now, last)) {
        lastWatchdogAt = now;
        ranWatchdog = true;
        try {
          await runCsWatchdog({ now, send: deps.send, env, extraItems: deps.extraItems });
          markJobCompleted(db, CS_WATCHDOG_JOB, now);
        } catch (e: any) {
          // Not completed: retried at the next hourly slot. Recorded so the failure is visible.
          console.error("[cs-watchdog] run failed:", e);
          try {
            const b = new EnvelopeBuilder({ run_id: `run-${runStamp(now)}-cs-watchdog`, vertical: "rfb", agent: "cs-watchdog", trigger_source: "cron" });
            b.error(`watchdog run threw: ${String(e?.message ?? e)}`);
            recordRun(b.finish("failed"));
          } catch {
            // the ledger itself is down — the console line above is all that is left
          }
        }
      }
    } else if (!lastPurgeAt || now.getTime() - lastPurgeAt.getTime() >= 24 * 3600_000) {
      // The watchdog purges on every run; with it off, purge once a day here.
      try {
        purgeInboundLog(now);
        ranPurge = true;
      } catch (e) {
        console.error("[cs-watchdog] purge failed:", e);
      }
      lastPurgeAt = now;
    }
    if (csDailyDigestEnabled(env)) {
      const persisted = getJobLastCompletedAt(db, CS_DIGEST_JOB);
      const last = [lastDigestAt, persisted].filter((d): d is Date => !!d && d.getTime() <= now.getTime()).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      const backoffOk = !lastDigestAttemptAt || now.getTime() - lastDigestAttemptAt.getTime() >= 55 * 60_000;
      if (digestDue(now, last) && backoffOk) {
        ranDigest = true;
        try {
          const r = await runCsDailyDigest({ now, send: deps.send });
          if (r.sent) {
            markJobCompleted(db, CS_DIGEST_JOB, now);
            lastDigestAt = now;
            lastDigestAttemptAt = null;
          } else {
            lastDigestAttemptAt = now;
          }
        } catch (e) {
          console.error("[cs-daily-digest] run failed:", e);
          lastDigestAttemptAt = now;
        }
      }
    }
  } finally {
    tickInFlight = false;
  }
  return { lastWatchdogAt, lastDigestAt, lastDigestAttemptAt, lastPurgeAt, ranWatchdog, ranDigest, ranPurge, skippedOverlap: false };
}
