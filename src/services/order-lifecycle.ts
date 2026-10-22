/**
 * Order lifecycle settings and helpers — Fase A1 of dev-request
 * 2026-10-21-rfb-mine-ordrer-ett-klikk-og-kjoperagent («ett klikk»).
 *
 * Pure module (no DB, no imports of other services), so the receipt service,
 * the order-action layer and the follow-ups job can all read the same
 * switches without an import cycle.
 *
 *   ORDER_AUTOCOMPLETE_ENABLED       «1» turns the automatic close on. Default
 *                                    OFF: no order is ever closed by itself.
 *   ORDER_AUTOCOMPLETE_GRACE_HOURS   hours after orders.pickup_time (default 24).
 *                                    Also the window in which a buyer «hentet»
 *                                    and a seller «kom ikke» count as a conflict.
 *   ORDER_AUTOCOMPLETE_DEFAULT_DAYS  days after confirmation when the order has
 *                                    no pickup time (default 3).
 */

export function isOrderAutocompleteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORDER_AUTOCOMPLETE_ENABLED === "1";
}

function envPositive(name: string, dflt: number, env: NodeJS.ProcessEnv): number {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

export function orderAutocompleteGraceHours(env: NodeJS.ProcessEnv = process.env): number {
  return envPositive("ORDER_AUTOCOMPLETE_GRACE_HOURS", 24, env);
}

export function orderAutocompleteDefaultDays(env: NodeJS.ProcessEnv = process.env): number {
  return envPositive("ORDER_AUTOCOMPLETE_DEFAULT_DAYS", 3, env);
}

/** SQLite `datetime('now')` (UTC, no zone marker) or an ISO string → epoch ms (NaN if unparseable). */
export function parseOrderTimestamp(ts: string | null | undefined): number {
  if (!ts) return NaN;
  const s = String(ts).trim();
  if (!s) return NaN;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) return Date.parse(s);
  return Date.parse(s.replace(" ", "T") + "Z");
}

/**
 * When a confirmed order is closed automatically: pickup_time + grace hours,
 * or, without a pickup time, the confirmation time + default days. null when
 * neither time is known (never closed automatically).
 */
export function autoCompleteDueMs(
  o: { pickup_time: string | null | undefined; confirmed_at: string | null | undefined },
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const pickup = parseOrderTimestamp(o.pickup_time);
  if (Number.isFinite(pickup)) return pickup + orderAutocompleteGraceHours(env) * 3600_000;
  const confirmed = parseOrderTimestamp(o.confirmed_at);
  if (Number.isFinite(confirmed)) return confirmed + orderAutocompleteDefaultDays(env) * 86_400_000;
  return null;
}

/** Europe/Oslo UTC offset (ms) at the given instant. */
function osloOffsetMs(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Oslo", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * The seller's pickup time → an ISO UTC string. Accepts an ISO string with a
 * zone, or a `datetime-local` value («2026-10-25T14:00», Oslo time). Returns
 * null for an empty value and "invalid" for anything unparseable or outside
 * [now − 1 day, now + 366 days].
 */
export function normalizePickupTime(input: unknown, now: Date = new Date()): string | null | "invalid" {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;
  let ms: number;
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (local) {
    const guess = Date.UTC(+local[1]!, +local[2]! - 1, +local[3]!, +local[4]!, +local[5]!, +(local[6] ?? 0));
    let t = guess - osloOffsetMs(guess);
    const off2 = osloOffsetMs(t);
    if (guess - off2 !== t) t = guess - off2;
    ms = t;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([zZ]|[+-]\d{2}:?\d{2})$/.test(s)) {
    ms = Date.parse(s);
  } else {
    return "invalid";
  }
  if (!Number.isFinite(ms)) return "invalid";
  if (ms < now.getTime() - 86_400_000 || ms > now.getTime() + 366 * 86_400_000) return "invalid";
  return new Date(ms).toISOString();
}

/** «25. oktober kl. 14:00» in Oslo time; the raw value when unparseable. */
export function formatPickupTimeOslo(ts: string | null | undefined): string {
  const ms = parseOrderTimestamp(ts);
  if (!Number.isFinite(ms)) return ts ? String(ts) : "";
  const d = new Date(ms);
  const date = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", day: "numeric", month: "long" }).format(d);
  const time = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${date} kl. ${time.replace(".", ":")}`;
}
