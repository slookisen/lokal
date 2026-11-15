// ─── Hidden, bookable gårdssalg test producer — reviewer state ──────────────
// dev-request 2026-11-12-f1-felles-for-ai-kanalene, slice F1-5.
//
// The one hidden gårdssalg test producer (KNOWN_TEST_PROVIDER_ID,
// init-experiences.ts) must be bookable end-to-end by app-store reviewers
// (OpenAI / Claude) and by us through book_gardssalg / POST
// /api/opplevelser/book with its explicit provider_id, and hidden everywhere
// else. Both halves already exist as mechanisms, this module only pins the
// row's DATA to them:
//
//   hidden    catalog_hidden = 1 with catalog_hidden_reason = 'test_fixture'
//             (gardssalg-visibility.ts: every public surface hides it; only
//             `claim` and an admin's «Vis som offentlig» request see it).
//   bookable  booking_live = 1 + is_test_provider = 1 (isBookingPaused() in
//             booking-store.ts lets exactly this flagged hidden row dispatch,
//             whatever the global switch says).
//   mail      the producer notification goes to experience_providers.epost
//             (sendProducerNotification), so epost is set to the reserved
//             platform address below — never a private inbox.
//   neutral   no private phone, address or website on the row.
//
// planTestProducerReviewerState() is the dry-run (old and new value per
// field, zero writes); applyTestProducerReviewerState() writes the same plan
// in one transaction pinned to `id AND is_test_provider = 1`, with one
// gardssalg_content_audit row per changed field. Running apply again is the
// reset. The admin route (routes/opplevelser-test-producer-reviewer.ts) is
// the only caller.

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { KNOWN_TEST_PROVIDER_ID } from "../database/init-experiences";
import { GARDSSALG_TEST_FIXTURE_REASON } from "./gardssalg-visibility";

/** Reserved inbox for e-mail to «the producer» when the hidden test producer
 *  is booked. On opplevagent.no, the domain the experiences vertical sends
 *  from (crmSenderAddress / kontakt@opplevagent.no). */
export const GARDSSALG_TEST_PRODUCER_EMAIL = "testprodusent@opplevagent.no";

/** gardssalg_content_audit.batch_id for writes made by the apply. */
export const REVIEWER_STATE_AUDIT_BATCH = "admin-test-provider-reviewer-state";

export type ReviewerStateValue = string | number | null;

/** The target value per field. Order is the order of the plan's `changes`. */
export const TEST_PRODUCER_REVIEWER_TARGET: Readonly<Record<string, ReviewerStateValue>> = Object.freeze({
  epost: GARDSSALG_TEST_PRODUCER_EMAIL,
  telefon: null,
  mobil: null,
  adresse: null,
  hjemmeside: null,
  catalog_hidden: 1,
  catalog_hidden_reason: GARDSSALG_TEST_FIXTURE_REASON,
  is_test_provider: 1,
  booking_live: 1,
});

const TARGET_FIELDS = Object.keys(TEST_PRODUCER_REVIEWER_TARGET);

export interface ReviewerStateChange {
  field: string;
  old: ReviewerStateValue;
  new: ReviewerStateValue;
}

export type ReviewerStatePlan =
  | { status: "not_found"; provider_id: string }
  | { status: "not_test_provider"; provider_id: string }
  | {
      status: "ok";
      provider_id: string;
      changes: ReviewerStateChange[];
      unchanged: string[];
    };

function sameValue(a: unknown, b: ReviewerStateValue): boolean {
  if (a === null || a === undefined) return b === null;
  if (b === null) return false;
  return String(a) === String(b);
}

/** Dry-run: what apply would change on the test row. Never writes. */
export function planTestProducerReviewerState(
  db: Database.Database,
  providerId: string = KNOWN_TEST_PROVIDER_ID,
): ReviewerStatePlan {
  const row = db
    .prepare(`SELECT ${TARGET_FIELDS.join(", ")} FROM experience_providers WHERE id = ?`)
    .get(providerId) as Record<string, unknown> | undefined;
  if (!row) return { status: "not_found", provider_id: providerId };
  // Only the flagged test row is ever a target (the migration in
  // init-experiences.ts flags KNOWN_TEST_PROVIDER_ID on every boot).
  if (Number(row.is_test_provider) !== 1) return { status: "not_test_provider", provider_id: providerId };
  const changes: ReviewerStateChange[] = [];
  const unchanged: string[] = [];
  for (const field of TARGET_FIELDS) {
    const next = TEST_PRODUCER_REVIEWER_TARGET[field] as ReviewerStateValue;
    const old = (row[field] ?? null) as ReviewerStateValue;
    if (sameValue(old, next)) unchanged.push(field);
    else changes.push({ field, old, new: next });
  }
  return { status: "ok", provider_id: providerId, changes, unchanged };
}

/**
 * Writes the plan. Returns the plan that was applied (its `changes` are what
 * was written). The UPDATE is pinned to `id = ? AND is_test_provider = 1` in
 * its own WHERE, so no other row can be touched.
 */
export function applyTestProducerReviewerState(
  db: Database.Database,
  providerId: string = KNOWN_TEST_PROVIDER_ID,
): ReviewerStatePlan {
  const tx = db.transaction((): ReviewerStatePlan => {
    const plan = planTestProducerReviewerState(db, providerId);
    if (plan.status !== "ok" || plan.changes.length === 0) return plan;
    const sets = plan.changes.map((c) => `${c.field} = @${c.field}`);
    const params: Record<string, ReviewerStateValue> = { id: providerId };
    for (const c of plan.changes) params[c.field] = c.new;
    const r = db
      .prepare(
        `UPDATE experience_providers SET ${sets.join(", ")}, updated_at = datetime('now')
          WHERE id = @id AND is_test_provider = 1`,
      )
      .run(params);
    if (r.changes !== 1) return { status: "not_test_provider", provider_id: providerId };
    const audit = db.prepare(
      `INSERT INTO gardssalg_content_audit (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at, notes)
       VALUES (?, ?, ?, ?, ?, NULL, ?, 'admin', datetime('now'), 'POST /admin/gardssalg/test-provider/reviewer-state')`,
    );
    for (const c of plan.changes) {
      audit.run(
        randomUUID(),
        providerId,
        c.field,
        c.old === null ? null : String(c.old),
        c.new === null ? null : String(c.new),
        REVIEWER_STATE_AUDIT_BATCH,
      );
    }
    return plan;
  });
  return tx();
}
