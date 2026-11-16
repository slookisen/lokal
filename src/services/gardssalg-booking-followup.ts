/**
 * Gårdssalg booking follow-up — O1-1 (audit findings R1 and R11).
 *
 * R1: the follow-up job (producer reminder after 24 h, automatic expiry after
 * 60 h, services/booking-store.ts processBookingFollowups()) was a bare
 * 60-minute setInterval in src/index.ts. With restarts more often than hourly
 * it never ran. scheduleBookingFollowupsJob() adds one run 5 minutes after
 * boot, the same fix the RFB order follow-ups got (skive 1b, S3).
 *
 * R11: the producer's booking e-mail was fire-and-forget; a failure or a
 * missing address was only logged. The outcome is now recorded on the row
 * (gardssalg_bookings.notify_sent_at / notify_failed_at / notify_retried_at),
 * a failure alerts the admin and is re-sent once by the follow-up job, and a
 * missing address alerts the admin once.
 *
 * The 24 h / 60 h clock starts at the REGISTERED notification to the
 * producer (notify_sent_at), never earlier than FOLLOWUP_CLOCK_FLOOR (the
 * deploy date of this change), so old rows can never all expire in one
 * batch. A row whose producer notification was never registered is never
 * reminded and never expired by the job: «the producer did not answer» would
 * be a false statement about a producer who never got the request.
 *
 * Legacy rows: rows created BEFORE the floor predate the notify_* columns, so
 * all three are NULL even though their producer was e-mailed (with the
 * promise of automatic expiry). Such a row — created before the floor, every
 * notify_* column NULL — starts its clock AT the floor (followupRowClockStartMs()).
 * Rows created at/after the floor keep "no registered notification ⇒ never".
 *
 * A producer WITHOUT an address ("not_live") is never e-mailed, so such a row
 * must not look legacy either: recordProducerNotifyOutcome() stamps
 * notify_retried_at on it (see the comment there). That excludes it from the
 * legacy rule above AND from the job's single re-send (whose SELECT/claim
 * require notify_failed_at IS NOT NULL AND notify_retried_at IS NULL).
 *
 * Known residual window: "sent"/"failed" are stamped after the send resolves
 * (seconds). A row created between the deploy and the floor whose process
 * restarts inside that window keeps every notify_* NULL and is treated as
 * legacy. Its producer e-mail was in flight (most likely delivered, with the
 * stated expiry promise), so counting from the floor is the lesser error; an
 * extra "attempted" column was judged not worth it for a <1-day, seconds-wide
 * window. After the floor the window does not exist (no legacy rule there).
 *
 * This module has no import of booking-store (booking-store imports it).
 */

export type ProducerNotifyOutcome = "sent" | "failed" | "not_live";

// ─── Clock ──────────────────────────────────────────────────────────────────

/** Deploy date of O1-1. Override with BOOKING_FOLLOWUP_CLOCK_FLOOR (ISO). */
export const FOLLOWUP_CLOCK_FLOOR = "2026-11-16T00:00:00Z";

export function followupClockFloorMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.BOOKING_FOLLOWUP_CLOCK_FLOOR || "").trim();
  const n = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(n) ? n : Date.parse(FOLLOWUP_CLOCK_FLOOR);
}

/** ISO or SQLite `datetime('now')` (UTC without a zone) → epoch ms; NaN if absent. */
export function stampMs(ts: string | null | undefined): number {
  if (!ts) return NaN;
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(ts) ? ts : ts.replace(" ", "T") + "Z");
}

/** When the follow-up clock starts for a row: MAX(notify_sent_at, floor); NaN = never. */
export function followupClockStartMs(
  notifySentAt: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const sent = stampMs(notifySentAt);
  if (!Number.isFinite(sent)) return NaN;
  return Math.max(sent, followupClockFloorMs(env));
}

export interface FollowupRow {
  status: string;
  pre_status: string;
  respond_token: string | null;
  respond_token_expires_at: string | null;
  reminder_sent_at: string | null;
  notify_sent_at: string | null;
  // Legacy detection (isLegacyPreFloorRow()). Absent = not a legacy row.
  created_at?: string | null;
  notify_failed_at?: string | null;
  notify_retried_at?: string | null;
}

/**
 * A row created before the floor with every notify_* column NULL: it predates
 * the registration columns, so "NULL" there means "not recorded", not "not sent".
 */
export function isLegacyPreFloorRow(row: FollowupRow, env: NodeJS.ProcessEnv = process.env): boolean {
  if (row.notify_sent_at || row.notify_failed_at || row.notify_retried_at) return false;
  const created = stampMs(row.created_at);
  return Number.isFinite(created) && created < followupClockFloorMs(env);
}

/** Clock start for a row: the floor for a legacy pre-floor row, else followupClockStartMs(notify_sent_at). */
export function followupRowClockStartMs(row: FollowupRow, env: NodeJS.ProcessEnv = process.env): number {
  if (isLegacyPreFloorRow(row, env)) return followupClockFloorMs(env);
  return followupClockStartMs(row.notify_sent_at, env);
}

/** The one reminder: awaiting an answer, not yet reminded, reminderHours after the clock start. */
export function previsitReminderDue(
  row: FollowupRow,
  nowMs: number,
  reminderHours: number,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!row.respond_token || row.status !== "reserved") return false;
  if (row.pre_status !== "awaiting_provider" || row.reminder_sent_at) return false;
  const start = followupRowClockStartMs(row, env);
  return Number.isFinite(start) && nowMs - start >= reminderHours * 3600_000;
}

/**
 * Expiry moment of an awaiting_provider row in epoch ms (NaN = never): the
 * clock start + expireHours, and never before the stamped
 * respond_token_expires_at (the deadline the producer e-mail states).
 */
export function awaitingExpiryDueMs(
  row: FollowupRow,
  expireHours: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const start = followupRowClockStartMs(row, env);
  if (!Number.isFinite(start)) return NaN;
  const byClock = start + expireHours * 3600_000;
  const token = stampMs(row.respond_token_expires_at);
  return Number.isFinite(token) ? Math.max(byClock, token) : byClock;
}

/** What the booking response reports about the producer notification. */
export function producerNotifyAddressStatus(epost: string | null | undefined): "queued" | "not_live" {
  return typeof epost === "string" && epost.trim() ? "queued" : "not_live";
}

// ─── Recording the producer notification outcome ────────────────────────────

type AlertFn = (subject: string, text: string) => Promise<boolean>;
let _alertOverride: AlertFn | null = null;
/** Tests: capture admin alerts instead of e-mailing ADMIN_NOTIFICATION_EMAIL. */
export function __setBookingNotifyAlertForTesting(fn: AlertFn | null): void { _alertOverride = fn; }

/** The existing admin alert channel (ADMIN_NOTIFICATION_EMAIL, order-notify-service). Never throws. */
export async function sendBookingAdminAlert(subject: string, text: string): Promise<boolean> {
  try {
    if (_alertOverride) return await _alertOverride(subject, text);
    const { sendAdminOrderAlert } = await import("./order-notify-service");
    return await sendAdminOrderAlert(subject, text);
  } catch (err) {
    console.error("[booking-notify] admin alert failed:", err);
    return false;
  }
}

interface MinimalDb {
  prepare(sql: string): { run(...params: unknown[]): { changes: number } };
}

/**
 * Stamps the outcome on the row and alerts the admin when the producer did
 * not get the request. `retry` = the follow-up job's single re-send. Never throws.
 */
export async function recordProducerNotifyOutcome(
  db: MinimalDb,
  booking: { booking_id: string; booking_ref: string; provider_id: string },
  outcome: ProducerNotifyOutcome,
  opts: { retry?: boolean; reason?: string; now?: Date } = {},
): Promise<void> {
  const stamp = (opts.now ?? new Date()).toISOString();
  try {
    if (outcome === "sent") {
      db.prepare("UPDATE gardssalg_bookings SET notify_sent_at = COALESCE(notify_sent_at, ?) WHERE booking_id = ?")
        .run(stamp, booking.booking_id);
      return;
    }
    if (outcome === "not_live") {
      // No address: the producer never gets the request. notify_retried_at is
      // the marker "no (further) send attempt will be made" — it is the column
      // the job's re-send already uses to mean exactly that, so no schema
      // change is needed. Effects: the row is not legacy (isLegacyPreFloorRow
      // needs every notify_* NULL), so it is never reminded/expired; and the
      // re-send never picks it (needs notify_failed_at IS NOT NULL AND
      // notify_retried_at IS NULL). notify_sent_at stays NULL = not delivered.
      // COALESCE keeps the retry claim's stamp when the re-send ends here.
      db.prepare("UPDATE gardssalg_bookings SET notify_retried_at = COALESCE(notify_retried_at, ?) WHERE booking_id = ?")
        .run(stamp, booking.booking_id);
    } else if (outcome === "failed" && !opts.retry) {
      db.prepare("UPDATE gardssalg_bookings SET notify_failed_at = COALESCE(notify_failed_at, ?) WHERE booking_id = ?")
        .run(stamp, booking.booking_id);
    }
  } catch (err) {
    console.error(`[booking-notify] could not record outcome ${outcome} for ${booking.booking_ref}:`, err);
  }
  const who = `Gårdssalg-forespørsel ${booking.booking_ref} (produsent ${booking.provider_id})`;
  const subject = outcome === "not_live"
    ? `Gårdssalg ${booking.booking_ref}: produsenten har ingen e-postadresse`
    : opts.retry
      ? `Gårdssalg ${booking.booking_ref}: nytt forsøk på produsent-e-post feilet`
      : `Gårdssalg ${booking.booking_ref}: produsent-e-posten feilet`;
  const text = outcome === "not_live"
    ? `${who} ble ikke sendt til produsenten: ingen e-postadresse registrert.\n` +
      "Forespørselen får verken påminnelse eller automatisk utløp. Kontakt produsenten eller gjesten direkte."
    : `Produsent-e-posten for ${who} kunne ikke sendes${opts.retry ? " heller ved nytt forsøk" : ""}.\n` +
      (opts.reason ? `Årsak: ${opts.reason.slice(0, 200)}\n` : "") +
      (opts.retry
        ? "Ingen flere forsøk. Forespørselen får verken påminnelse eller automatisk utløp. Kontakt produsenten direkte."
        : "Systemet prøver én gang til ved neste kjøring av booking-followups.");
  await sendBookingAdminAlert(subject, text);
}

// ─── Scheduling (R1) ────────────────────────────────────────────────────────

export const BOOKING_FOLLOWUPS_FIRST_RUN_DELAY_MS = 5 * 60_000;
export const BOOKING_FOLLOWUPS_INTERVAL_MS = 60 * 60_000;

export interface JobTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  setInterval: (fn: () => void, ms: number) => unknown;
}

/**
 * Runs `tick` once firstRunDelayMs after boot AND every intervalMs. The job is
 * idempotent, so the extra run is harmless. Timers are injectable for tests.
 */
export function scheduleBookingFollowupsJob(
  tick: () => unknown,
  opts: { timers?: JobTimers; firstRunDelayMs?: number; intervalMs?: number; log?: (msg: string) => void } = {},
): void {
  const timers: JobTimers = opts.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    setInterval: (fn, ms) => setInterval(fn, ms),
  };
  const log = opts.log ?? ((m: string) => console.log(m));
  timers.setTimeout(() => {
    log("[booking-followups] first run after boot");
    void tick();
  }, opts.firstRunDelayMs ?? BOOKING_FOLLOWUPS_FIRST_RUN_DELAY_MS);
  timers.setInterval(() => { void tick(); }, opts.intervalMs ?? BOOKING_FOLLOWUPS_INTERVAL_MS);
}
