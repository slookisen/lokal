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
  const rows = db
    .prepare(
      `SELECT id, forward_attempts, updated_at, forward_payload, subject, from_email, received_at, forward_error
         FROM inbound_email_log WHERE forward_status = 'failed' ORDER BY received_at ASC LIMIT 100`,
    )
    .all() as Array<{
      id: string; forward_attempts: number; updated_at: string | null; forward_payload: string | null;
      subject: string | null; from_email: string | null; received_at: string; forward_error: string | null;
    }>;
  let retried = 0;
  let recovered = 0;
  const exhausted: ForwardRetryResult["exhausted"] = [];
  for (const r of rows) {
    if (!r.forward_payload || r.forward_attempts >= FORWARD_MAX_ATTEMPTS) {
      exhausted.push({ id: r.id, subject: r.subject, from_email: r.from_email, received_at: r.received_at, error: r.forward_error });
      continue;
    }
    if (!forwardRetryDue(r.forward_attempts, r.updated_at, now)) continue;
    let payload: any;
    try {
      payload = JSON.parse(r.forward_payload);
    } catch {
      db.prepare("UPDATE inbound_email_log SET forward_attempts = ?, forward_error = 'unparseable forward_payload', updated_at = datetime('now') WHERE id = ?")
        .run(FORWARD_MAX_ATTEMPTS, r.id);
      exhausted.push({ id: r.id, subject: r.subject, from_email: r.from_email, received_at: r.received_at, error: "unparseable forward_payload" });
      continue;
    }
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
      if (attempts >= FORWARD_MAX_ATTEMPTS) {
        exhausted.push({ id: r.id, subject: r.subject, from_email: r.from_email, received_at: r.received_at, error: msg });
      }
    }
  }
  return { retried, recovered, exhausted };
}

// ─── Log retention ────────────────────────────────────────────────────

export const INBOUND_LOG_RETENTION_DAYS = 90;

/** Delete log rows older than the retention window. Undelivered forwards are kept until resolved. */
export function purgeInboundLog(now: Date = new Date()): number {
  const r = getDb()
    .prepare(
      `DELETE FROM inbound_email_log
        WHERE julianday(received_at) < julianday(?) - ?
          AND forward_status != 'failed'`,
    )
    .run(now.toISOString(), INBOUND_LOG_RETENTION_DAYS);
  return r.changes;
}

// ─── Alert de-duplication ────────────────────────────────────────────

/** True (and recorded) when `key` has not been alerted in the last 24 h. */
export function claimAlert(key: string, now: Date = new Date()): boolean {
  const db = getDb();
  const row = db.prepare("SELECT last_alerted_at FROM cs_alert_log WHERE alert_key = ?").get(key) as
    | { last_alerted_at: string }
    | undefined;
  if (row) {
    const last = Date.parse(row.last_alerted_at);
    if (Number.isFinite(last) && now.getTime() - last < 24 * 3600_000) return false;
    db.prepare("UPDATE cs_alert_log SET last_alerted_at = ?, count = count + 1 WHERE alert_key = ?").run(now.toISOString(), key);
    return true;
  }
  db.prepare("INSERT INTO cs_alert_log (alert_key, first_alerted_at, last_alerted_at, count) VALUES (?, ?, ?, 1)")
    .run(key, now.toISOString(), now.toISOString());
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

export async function runCsWatchdog(deps: { send?: SendFn; now?: Date; adminEmail?: string | null; trigger?: "cron" | "manual" } = {}): Promise<WatchdogResult> {
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

  // New problems since the last alert for each item.
  const lines: string[] = [];
  for (const t of report.threads.filter((x) => x.level === "p0")) {
    if (!claimAlert(`thread:${t.thread_id}`, now)) continue;
    lines.push(`• [${platformName(t.vertical)}] ${t.subject ?? "(uten emne)"} — fra ${t.contact_email}, ${Math.floor(t.age_hours)} t uten svar (tråd ${t.thread_id})`);
  }
  for (const u of report.untriaged.filter((x) => x.level === "p0")) {
    if (!claimAlert(`untriaged:${u.id}`, now)) continue;
    lines.push(`• [Ikke fordelt] ${u.subject ?? "(uten emne)"} — fra ${u.from_email}, ${Math.floor(u.age_hours)} t (plattform ukjent)`);
  }
  for (const f of forward.exhausted) {
    if (!claimAlert(`forward:${f.id}`, now)) continue;
    lines.push(`• [Videresending feilet ${FORWARD_MAX_ATTEMPTS} ganger] ${f.subject ?? "(uten emne)"} — fra ${f.from_email ?? "?"}, mottatt ${f.received_at}: ${f.error ?? "ukjent feil"}`);
  }
  const regErrors = getDb()
    .prepare(
      `SELECT id, subject, from_email, crm_error FROM inbound_email_log
        WHERE crm_status = 'error' AND julianday(received_at) >= julianday(?) - 7`,
    )
    .all(now.toISOString()) as Array<{ id: string; subject: string | null; from_email: string | null; crm_error: string | null }>;
  for (const r of regErrors) {
    if (!claimAlert(`register:${r.id}`, now)) continue;
    lines.push(`• [Ikke registrert i CRM] ${r.subject ?? "(uten emne)"} — fra ${r.from_email ?? "?"}: ${r.crm_error ?? "ukjent feil"}`);
  }

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
        lines.slice(0, 40).join("\n") +
        (lines.length > 40 ? `\n… og ${lines.length - 40} til.` : "") +
        `\n\nAlt som venter: ${adminCrmUrl()} (Trenger svar)\n` +
        `Totalt nå: ${report.counts.threads} tråder trenger svar (${report.counts.p0} over 24 t, ${report.counts.p1} over 12 t), ` +
        `${report.counts.untriaged_open} ikke fordelt, ${report.counts.forward_failed} videresendinger feilet.\n\n` +
        `Hver sak varsles høyst én gang per døgn. — CS-vakten på serveren`;
      try {
        alertSent = succeeded(await send({ to: adminEmail, subject: `CS-vakt: ${lines.length} sak(er) trenger handling`, textContent: text, omitAgentHeader: true }));
      } catch (e: any) {
        alertSent = false;
        env.error(`alert send failed: ${String(e?.message ?? e)}`);
      }
      if (!alertSent) env.error("CS alert e-mail was not accepted by the mail relay", { items: lines.length });
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
  lines.push("");
  lines.push("UT");
  if (outbound.length === 0) lines.push("• Ingen svar eller utsendinger registrert i CRM.");
  for (const v of [...new Set(outbound.map((r) => r.vertical))].sort()) {
    const rows = outbound.filter((r) => r.vertical === v);
    lines.push(`• ${platformName(v)}: ${rows.map((r) => `${r.status} ${r.n}`).join(", ")}`);
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
    counts: { inbound, forms, outbound, needs_reply: report.counts },
  };
}

export async function runCsDailyDigest(deps: { send?: SendFn; now?: Date; adminEmail?: string | null; trigger?: "cron" | "manual" } = {}): Promise<{
  run_id: string; sent: boolean; reason: string | null; envelope_recorded: boolean;
}> {
  const now = deps.now ?? new Date();
  const send = deps.send ?? defaultSend();
  const runId = `run-${osloClock(now).date}-cs-daily-digest`;
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

export async function tickCsWatchdog(state: { lastWatchdogAt: Date | null; lastDigestAt: Date | null }, deps: { now?: Date; send?: SendFn; env?: NodeJS.ProcessEnv } = {}): Promise<{
  lastWatchdogAt: Date | null; lastDigestAt: Date | null; ranWatchdog: boolean; ranDigest: boolean;
}> {
  const now = deps.now ?? new Date();
  const env = deps.env ?? process.env;
  const db = getDb();
  let { lastWatchdogAt, lastDigestAt } = state;
  let ranWatchdog = false;
  let ranDigest = false;
  if (csWatchdogEnabled(env)) {
    const persisted = getJobLastCompletedAt(db, CS_WATCHDOG_JOB);
    const last = [lastWatchdogAt, persisted].filter((d): d is Date => !!d && d.getTime() <= now.getTime()).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    if (watchdogDue(now, last)) {
      await runCsWatchdog({ now, send: deps.send });
      markJobCompleted(db, CS_WATCHDOG_JOB, now);
      lastWatchdogAt = now;
      ranWatchdog = true;
    }
  }
  if (csDailyDigestEnabled(env)) {
    const persisted = getJobLastCompletedAt(db, CS_DIGEST_JOB);
    const last = [lastDigestAt, persisted].filter((d): d is Date => !!d && d.getTime() <= now.getTime()).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    if (digestDue(now, last)) {
      await runCsDailyDigest({ now, send: deps.send });
      markJobCompleted(db, CS_DIGEST_JOB, now);
      lastDigestAt = now;
      ranDigest = true;
    }
  }
  return { lastWatchdogAt, lastDigestAt, ranWatchdog, ranDigest };
}
