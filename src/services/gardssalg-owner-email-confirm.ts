/**
 * gardssalg-owner-email-confirm.ts — "Bekreftet av eier" on an e-mail
 * confirmation (dev-request 2026-10-22-opplevagent-takksvar-eierlenke-og-
 * bekreftet-av-eier, slice 1: data, admin lever, display, withdrawal).
 *
 * A producer who confirms their profile by replying from an address the claim
 * flow accepts FOR THAT PRODUCER gets experience_providers.owner_email_confirmed_at
 * stamped. That is a second, separate basis for the badge: claimed_at keeps
 * meaning "an owner logged in" and is never touched here.
 *
 * Address rule: NOT re-implemented. The sender must equal one of the candidates
 * deriveOrgLinkedEmailCandidatesWithHarvest() returns for this provider — the
 * exact list issueClaimMagicLink() validates a claim against (Brreg-verified
 * provider required, then Brreg contact / provenance-backed stored epost /
 * addresses found on the producer's own site). An address on the same domain
 * that is not on that list is rejected: the claim flow would not send a login
 * link there either.
 *
 * Field locks: confirmed fields are locked with the existing admin field lock
 * (applyGardssalgFieldLock), so enrichment cannot change a confirmed value
 * under the badge. A field that is already locked (manual/claim row, or an
 * existing owner/admin lock) is left exactly as it is — a lock is never
 * downgraded or overwritten.
 */

import { v4 as uuid } from "uuid";
import { getDb } from "../database/db-factory";
import { normalizeEmail } from "./blocklist-service";
import {
  deriveOrgLinkedEmailCandidatesWithHarvest,
  getClaimProviderById,
  maskEmail,
} from "./gardssalg-claim";
import {
  applyGardssalgFieldLock,
  isGardssalgFieldOwnerLocked,
  GARDSSALG_LOCKABLE_FIELDS,
  type GardssalgLockableField,
} from "./experience-store";

const VERTICAL = "experiences";

export type OwnerEmailConfirmRejection =
  | "provider_not_found"
  | "provider_hidden"
  | "invalid_sender"
  | "not_brreg_verified"
  | "no_org_linked_email"
  | "sender_not_accepted";

export type SenderCheck =
  | { ok: true; source: string }
  | { ok: false; reason: OwnerEmailConfirmRejection };

function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Does the claim flow's address rule accept `sender` for this very provider? */
export async function checkOwnerConfirmationSender(
  providerId: string,
  senderEmail: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<SenderCheck> {
  const provider = getClaimProviderById(providerId);
  if (!provider) return { ok: false, reason: "provider_not_found" };

  const hidden = getDb(VERTICAL)
    .prepare(`SELECT catalog_hidden, merged_into FROM experience_providers WHERE id = ?`)
    .get(providerId) as { catalog_hidden: number | null; merged_into: string | null } | undefined;
  if (hidden && (hidden.catalog_hidden === 1 || (hidden.merged_into != null && hidden.merged_into !== ""))) {
    return { ok: false, reason: "provider_hidden" };
  }

  const sender = normalizeEmail(senderEmail);
  if (!sender || !isPlausibleEmail(sender)) return { ok: false, reason: "invalid_sender" };

  if (!provider.org_nr || provider.brreg_verified !== 1) return { ok: false, reason: "not_brreg_verified" };

  const candidates = await deriveOrgLinkedEmailCandidatesWithHarvest(provider, undefined, {
    fetchImpl: opts.fetchImpl,
    cacheKey: provider.id,
  });
  if (candidates.length === 0) return { ok: false, reason: "no_org_linked_email" };

  const match = candidates.find((c) => normalizeEmail(c.email) === sender);
  if (!match) return { ok: false, reason: "sender_not_accepted" };
  return { ok: true, source: match.source };
}

export interface OwnerEmailConfirmInput {
  providerId: string;
  senderEmail: string;
  /** CRM thread id — evidence, stored on the row and in the audit trail. */
  threadId: string;
  /** Fields the producer confirmed; each is locked unless already locked. */
  confirmedFields?: GardssalgLockableField[];
  apply: boolean;
  fetchImpl?: typeof fetch;
}

export type FieldLockPlan = {
  field: GardssalgLockableField;
  action: "lock" | "already_locked";
  reason?: "row_locked_manual_or_claim" | "field_locked";
};

export type OwnerEmailConfirmResult =
  | { ok: false; reason: OwnerEmailConfirmRejection }
  | {
      ok: true;
      dry_run: boolean;
      provider_id: string;
      sender_masked: string;
      accepted_source: string;
      /** true when the provider already had a confirmation (first one is kept). */
      already_confirmed: boolean;
      confirmed_at: string | null;
      fields: FieldLockPlan[];
    };

export async function confirmOwnerByEmail(input: OwnerEmailConfirmInput): Promise<OwnerEmailConfirmResult> {
  const check = await checkOwnerConfirmationSender(input.providerId, input.senderEmail, { fetchImpl: input.fetchImpl });
  if (!check.ok) return check;

  const db = getDb(VERTICAL);
  const row = db
    .prepare(`SELECT id, content_source, field_provenance, owner_email_confirmed_at FROM experience_providers WHERE id = ?`)
    .get(input.providerId) as
    | { id: string; content_source: string | null; field_provenance: string | null; owner_email_confirmed_at: string | null }
    | undefined;
  if (!row) return { ok: false, reason: "provider_not_found" };

  const wanted = Array.from(new Set(input.confirmedFields ?? []));
  const fields: FieldLockPlan[] = wanted.map((field) => {
    if (row.content_source === "manual" || row.content_source === "claim") {
      return { field, action: "already_locked", reason: "row_locked_manual_or_claim" };
    }
    if (isGardssalgFieldOwnerLocked(row, field)) {
      return { field, action: "already_locked", reason: "field_locked" };
    }
    return { field, action: "lock" };
  });

  const alreadyConfirmed = row.owner_email_confirmed_at != null;
  const sender = normalizeEmail(input.senderEmail);
  const base = {
    ok: true as const,
    provider_id: input.providerId,
    sender_masked: maskEmail(sender),
    accepted_source: check.source,
    already_confirmed: alreadyConfirmed,
    fields,
  };
  if (!input.apply) return { ...base, dry_run: true, confirmed_at: row.owner_email_confirmed_at };

  const threadRef = `crm-thread:${input.threadId}`;
  const batchId = `owner-email-confirm-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`;
  let confirmedAt = row.owner_email_confirmed_at;

  if (!alreadyConfirmed) {
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare(
        `UPDATE experience_providers
            SET owner_email_confirmed_at = @at, owner_email_confirmed_email = @email,
                owner_email_confirmed_thread = @thread, updated_at = datetime('now')
          WHERE id = @id AND owner_email_confirmed_at IS NULL`,
      ).run({ at: now, email: sender, thread: input.threadId, id: input.providerId });
      db.prepare(
        `INSERT INTO gardssalg_content_audit
           (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
         VALUES (@id, @provider_id, 'owner_email_confirmed_at', NULL, @new_value, @source_url, @batch_id, 'admin', datetime('now'))`,
      ).run({ id: uuid(), provider_id: input.providerId, new_value: now, source_url: threadRef, batch_id: batchId });
    })();
    confirmedAt = now;
  }

  for (const f of fields) {
    if (f.action === "lock") applyGardssalgFieldLock(input.providerId, f.field, true, threadRef);
  }

  return { ...base, dry_run: false, confirmed_at: confirmedAt };
}

export type OwnerEmailClearResult =
  | { ok: false; reason: "provider_not_found" }
  | { ok: true; dry_run: boolean; provider_id: string; had_confirmation: boolean; previous_confirmed_at: string | null };

/** Withdraw the e-mail confirmation (producer asked to be removed, or an admin
 *  reset). Field locks are left in place on purpose: they only protect values. */
export function clearOwnerEmailConfirmation(
  providerId: string,
  opts: { apply: boolean; batchPrefix?: string } = { apply: false },
): OwnerEmailClearResult {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(`SELECT owner_email_confirmed_at FROM experience_providers WHERE id = ?`)
    .get(providerId) as { owner_email_confirmed_at: string | null } | undefined;
  if (!row) return { ok: false, reason: "provider_not_found" };
  const had = row.owner_email_confirmed_at != null;
  const base = {
    ok: true as const,
    provider_id: providerId,
    had_confirmation: had,
    previous_confirmed_at: row.owner_email_confirmed_at,
  };
  if (!opts.apply || !had) return { ...base, dry_run: !opts.apply };

  const batchId = `${opts.batchPrefix ?? "owner-email-confirm-clear"}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`;
  db.transaction(() => {
    db.prepare(
      `UPDATE experience_providers
          SET owner_email_confirmed_at = NULL, owner_email_confirmed_email = NULL,
              owner_email_confirmed_thread = NULL, updated_at = datetime('now')
        WHERE id = ?`,
    ).run(providerId);
    db.prepare(
      `INSERT INTO gardssalg_content_audit
         (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
       VALUES (?, ?, 'owner_email_confirmed_at', ?, NULL, NULL, ?, 'admin', datetime('now'))`,
    ).run(uuid(), providerId, row.owner_email_confirmed_at, batchId);
  })();
  return { ...base, dry_run: false };
}

export { GARDSSALG_LOCKABLE_FIELDS };
