/**
 * Gårdssalg guest-contact sweep — dev-request
 * 2026-10-23-opplevagent-besoksforesporsler-automatisk-sletting.
 *
 * Clears the guest contact columns on `gardssalg_bookings` (guest_name,
 * guest_email, guest_phone, notes) so visit requests no longer keep personal
 * data forever. Eligible rows:
 *   - status confirmed_attended / no_show / cancelled and resolved_at is
 *     30 or more days old;
 *   - status reserved (never resolved) and slot_at (the wished visit date) is
 *     30 or more days in the past.
 * A reserved row with a future slot_at, or a resolved row younger than 30
 * days, is untouched.
 *
 * guest_name / guest_email are NOT NULL in the schema, so they are set to the
 * fixed sentinel GARDSSALG_SWEPT_SENTINEL (''); guest_phone and notes become
 * NULL. Every other column (provider_id, slot_at, party_size, status,
 * billable, commission_rate, booking_ref/id, timestamps) is kept. A row is
 * "already swept" when name/email equal the sentinel and phone/notes are NULL,
 * so the sweep is idempotent.
 *
 * Date handling: slot_at / resolved_at may be ISO ("2026-10-01T10:00:00.000Z")
 * or SQLite ("YYYY-MM-DD HH:MM:SS", UTC, no offset). Both are normalised in JS
 * by parseStoredUtc() — never compared as raw strings.
 *
 * Privacy: returns and logs only booking ids and counts, never contents.
 * No-op (count 0) when the experiences DB is unavailable.
 *
 * Wired into the once-daily tick in src/index.ts behind
 * GARDSSALG_GUEST_CONTACT_SWEEP_LIVE (dryRun unless exactly "true").
 */

import { getDb as getVerticalDb } from "../database/db-factory";

export const GARDSSALG_SWEPT_SENTINEL = "";
export const GARDSSALG_SWEEP_CUTOFF_DAYS = 30;

let _testDb: any = null;
export function __setGardssalgGuestContactSweepTestDb(db: any): void {
  _testDb = db;
}

export interface GardssalgGuestContactSweepResult {
  sweptIds: string[];
  sweptCount: number;
  dryRun: boolean;
}

const RESOLVED_STATUSES: ReadonlySet<string> = new Set(["confirmed_attended", "no_show", "cancelled"]);

/** Parse an ISO or SQLite-style timestamp as UTC ms; NaN when unparseable. */
export function parseStoredUtc(v: unknown): number {
  if (typeof v !== "string" || !v.trim()) return NaN;
  let s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) {
    s = s.replace(" ", "T") + "Z"; // no offset stored => UTC
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    s += "T00:00:00Z";
  }
  return Date.parse(s);
}

function resolveDb(): any | null {
  if (_testDb) return _testDb;
  try {
    return getVerticalDb("experiences");
  } catch {
    return null;
  }
}

export function sweepExpiredGardssalgGuestContact(
  cutoffDays: number = GARDSSALG_SWEEP_CUTOFF_DAYS,
  now: Date = new Date(),
  dryRun: boolean = false
): GardssalgGuestContactSweepResult {
  const empty: GardssalgGuestContactSweepResult = { sweptIds: [], sweptCount: 0, dryRun };
  const db = resolveDb();
  if (!db) return empty;
  const cutoffMs = now.getTime() - cutoffDays * 24 * 60 * 60 * 1000;

  let candidates: Array<{ booking_id: string; status: string; slot_at: string; resolved_at: string | null }>;
  try {
    candidates = db.prepare(`
      SELECT booking_id, status, slot_at, resolved_at
      FROM gardssalg_bookings
      WHERE NOT (guest_name = ? AND guest_email = ? AND guest_phone IS NULL AND notes IS NULL)
    `).all(GARDSSALG_SWEPT_SENTINEL, GARDSSALG_SWEPT_SENTINEL);
  } catch {
    return empty; // table missing (experiences not initialised)
  }

  const ids: string[] = [];
  for (const c of candidates) {
    let clock = NaN;
    if (RESOLVED_STATUSES.has(c.status)) clock = parseStoredUtc(c.resolved_at);
    else if (c.status === "reserved") clock = parseStoredUtc(c.slot_at);
    if (Number.isFinite(clock) && clock <= cutoffMs) ids.push(c.booking_id);
  }

  if (!dryRun && ids.length) {
    const upd = db.prepare(`
      UPDATE gardssalg_bookings
      SET guest_name = ?, guest_email = ?, guest_phone = NULL, notes = NULL
      WHERE booking_id = ?
    `);
    db.transaction(() => {
      for (const id of ids) upd.run(GARDSSALG_SWEPT_SENTINEL, GARDSSALG_SWEPT_SENTINEL, id);
    })();
  }
  return { sweptIds: ids, sweptCount: ids.length, dryRun };
}
