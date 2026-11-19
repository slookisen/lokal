// ─── Gårdssalg manual owner-claim queue (A2A dev-request 2026-11-12-
// opplevagent-o3-eierkrav-og-innlogging, slice O3-5) ───────────────────────
// A claim self-service cannot complete (not brreg_verified, or no org-linked
// address: issueClaimMagicLink()'s refusals) waits here for approve/reject.
// Decisions are dry-run unless apply === true; an applied one stores the old
// ownership state (row + gardssalg_content_audit). Approve runs the RFB claim
// domain rule's helpers: only P1 (e-mail domain = the admin-verified website)
// passes, anything else needs override_reason. age_alarm: older than 2
// business days (Mon–Fri, UTC). Separate from RFB's agent_claims queue.

import crypto from "crypto";
import { getDb } from "../database/db-factory";
import { normalizeEmail } from "./blocklist-service";
import {
  CLAIM_RECOMMENDATION_LABELS, emailDomain, emailDomainMatchesWebsite, isFreeMailDomain, isHostedPlatformHost, isRootWebsite,
  websiteHost, type ClaimRecommendation,
} from "./claim-domain-rule";
import {
  deriveOrgLinkedEmailCandidatesWithHarvest, getClaimProviderById, grantManualQueueOwnership, hasActiveNonRevokedClaim,
  isHjemmesideOwnershipVerified, type ClaimProviderRow, type IssuedClaim,
} from "./gardssalg-claim";

const VERTICAL = "experiences";
export const MANUAL_CLAIM_AGE_ALARM_BUSINESS_DAYS = 2;
export const MANUAL_CLAIM_MAX_PENDING_PER_PROVIDER = 5;
const DAY_MS = 86_400_000;

export const isManualClaimQueueEnabled = (): boolean => process.env.GARDSSALG_CLAIM_MANUAL_QUEUE_ENABLED === "true";
export const isManualClaimReceiptEnabled = (): boolean => process.env.GARDSSALG_CLAIM_MANUAL_QUEUE_RECEIPT_ENABLED === "true";

/** Business time (Mon–Fri, UTC days) between two instants, in days. */
export function businessDaysBetween(from: Date, to: Date): number {
  let ms = 0;
  let t = from.getTime();
  const end = to.getTime();
  while (t < end) {
    const dayEnd = Math.min(end, Math.floor(t / DAY_MS) * DAY_MS + DAY_MS);
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) ms += dayEnd - t;
    t = dayEnd;
  }
  return ms / DAY_MS;
}

export type ManualClaimReason = "not_brreg_verified" | "no_org_linked_email";

/** Why self-service cannot complete for this provider, or null when it can. */
export async function manualClaimReason(provider: ClaimProviderRow): Promise<ManualClaimReason | null> {
  if (!provider.org_nr || provider.brreg_verified !== 1) return "not_brreg_verified";
  const candidates = await deriveOrgLinkedEmailCandidatesWithHarvest(provider, undefined, { cacheKey: provider.id });
  return candidates.length === 0 ? "no_org_linked_email" : null;
}

export interface ManualClaimDomainRule {
  recommendation: ClaimRecommendation; label: string; passes: boolean;
  email_domain: string | null; website_host: string | null; website_verified: boolean;
}

/** The RFB domain rule applied to a gårdssalg provider: P1 needs the claimant's
 *  domain to be the provider's root website, admin-verified (the gårdssalg
 *  counterpart of RFB's independent website). */
export function assessManualClaimDomain(email: string, provider: ClaimProviderRow): ManualClaimDomainRule {
  const domain = emailDomain(normalizeEmail(email));
  const host = websiteHost(provider.hjemmeside);
  const verified = isHjemmesideOwnershipVerified(provider);
  let rec: ClaimRecommendation;
  if (hasActiveNonRevokedClaim(provider.id)) rec = "has_owner";
  else if (!domain || isFreeMailDomain(domain)) rec = "free_mail_needs_extra";
  else if (host && verified && !isHostedPlatformHost(host) && isRootWebsite(provider.hjemmeside) && emailDomainMatchesWebsite(domain, host)) {
    rec = "domain_match_independent";
  } else rec = "needs_review";
  const passes = rec === "domain_match_independent";
  return { recommendation: rec, label: CLAIM_RECOMMENDATION_LABELS[rec], passes, email_domain: domain, website_host: host, website_verified: verified };
}

interface ManualClaimRow {
  id: string; provider_id: string; claimant_name: string; claimant_email: string; message: string | null;
  reason: string; status: string; created_at: string;
}

export type SubmitManualClaimResult =
  | { ok: true; id: string; created: boolean; provider: ClaimProviderRow; email: string; name: string }
  | { ok: false; error: "provider_not_found" | "invalid_input" | "already_claimed" | "self_service_available" | "too_many" };

export async function submitManualClaim(providerId: string, input: Record<string, unknown>, now = new Date()): Promise<SubmitManualClaimResult> {
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 200) : "";
  const email = typeof input.email === "string" ? normalizeEmail(input.email.trim()) : "";
  const message = typeof input.message === "string" ? input.message.trim().slice(0, 2000) : "";
  if (!name || !email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "invalid_input" };
  const provider = getClaimProviderById(providerId);
  if (!provider) return { ok: false, error: "provider_not_found" };
  if (hasActiveNonRevokedClaim(providerId)) return { ok: false, error: "already_claimed" };
  const reason = await manualClaimReason(provider);
  if (!reason) return { ok: false, error: "self_service_available" };
  const db = getDb(VERTICAL);
  return db.transaction((): SubmitManualClaimResult => { // dedupe + per-provider cap + insert, atomically
    const open = db.prepare(`SELECT id FROM gardssalg_manual_claims WHERE provider_id = ? AND status = 'pending' AND claimant_email = ?`)
      .get(providerId, email) as { id: string } | undefined;
    if (open) return { ok: true, id: open.id, created: false, provider, email, name };
    const pending = db.prepare(`SELECT COUNT(*) AS n FROM gardssalg_manual_claims WHERE provider_id = ? AND status = 'pending'`).get(providerId) as { n: number };
    if (pending.n >= MANUAL_CLAIM_MAX_PENDING_PER_PROVIDER) return { ok: false, error: "too_many" };
    const id = `gsm_${crypto.randomBytes(8).toString("hex")}`;
    db.prepare(
      `INSERT INTO gardssalg_manual_claims (id, provider_id, claimant_name, claimant_email, message, reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(id, providerId, name, email, message || null, reason, now.toISOString());
    return { ok: true, id, created: true, provider, email, name };
  })();
}

export function markManualClaimReceiptSent(id: string, now: Date = new Date()): void {
  getDb(VERTICAL).prepare(`UPDATE gardssalg_manual_claims SET receipt_sent_at = ? WHERE id = ?`).run(now.toISOString(), id);
}

/** The pending queue, oldest first, with age per row (AK1). */
export function listManualClaimQueue(now: Date = new Date()) {
  const rows = getDb(VERTICAL).prepare(
    `SELECT m.id, m.provider_id, p.navn AS provider_name, m.claimant_name, m.claimant_email, m.message, m.reason,
            m.status, m.created_at, m.receipt_sent_at
       FROM gardssalg_manual_claims m LEFT JOIN experience_providers p ON p.id = m.provider_id
      WHERE m.status = 'pending' ORDER BY m.created_at ASC`,
  ).all() as Array<ManualClaimRow & { provider_name: string | null; receipt_sent_at: string | null }>;
  const entries = rows.map((r) => {
    const created = new Date(r.created_at);
    const ageBusinessDays = businessDaysBetween(created, now);
    const provider = getClaimProviderById(r.provider_id);
    return {
      ...r,
      age_hours: Math.round(((now.getTime() - created.getTime()) / 3_600_000) * 10) / 10,
      age_business_days: Math.round(ageBusinessDays * 100) / 100,
      age_alarm: ageBusinessDays > MANUAL_CLAIM_AGE_ALARM_BUSINESS_DAYS,
      domain_rule: provider ? assessManualClaimDomain(r.claimant_email, provider) : null,
    };
  });
  return { count: entries.length, alarm_count: entries.filter((e) => e.age_alarm).length, entries };
}

export interface ManualClaimDecisionOpts { apply: boolean; overrideReason?: string; note?: string; now?: Date }

export type ManualClaimDecisionResult =
  | {
      ok: true; dry_run: boolean; id: string; decision: "approve" | "reject"; provider_id: string; provider_name: string;
      claimant_email: string; old_value: Record<string, unknown>; domain_rule?: ManualClaimDomainRule;
      would_block?: "domain_rule_mismatch" | null; granted_claim_id?: string;
      /** Set on an applied approve: the login link for the route to mail. */
      loginLink?: IssuedClaim;
    }
  | { ok: false; error: "not_found" | "not_pending" | "provider_not_found" | "already_claimed" | "domain_rule_mismatch" | "grant_failed"; domain_rule?: ManualClaimDomainRule };

function ownershipState(providerId: string): Record<string, unknown> {
  const db = getDb(VERTICAL);
  const p = db.prepare(`SELECT content_source, claimed_at FROM experience_providers WHERE id = ?`).get(providerId) as any;
  const owners = db.prepare(`SELECT COUNT(*) AS n FROM gardssalg_claims WHERE provider_id = ? AND used = 1 AND revoked_at IS NULL`).get(providerId) as { n: number };
  return { content_source: p?.content_source ?? null, claimed_at: p?.claimed_at ?? null, active_owner_claims: owners.n };
}

export function decideManualClaim(id: string, decision: "approve" | "reject", opts: ManualClaimDecisionOpts): ManualClaimDecisionResult {
  const db = getDb(VERTICAL);
  const now = (opts.now ?? new Date()).toISOString();
  const override = (opts.overrideReason ?? "").trim();
  const note = (opts.note ?? "").trim();
  const run = (): ManualClaimDecisionResult => {
    const row = db.prepare(`SELECT * FROM gardssalg_manual_claims WHERE id = ?`).get(id) as ManualClaimRow | undefined;
    if (!row) return { ok: false, error: "not_found" };
    if (row.status !== "pending") return { ok: false, error: "not_pending" };
    const provider = getClaimProviderById(row.provider_id);
    if (!provider) return { ok: false, error: "provider_not_found" };
    const oldValue = ownershipState(row.provider_id);
    const base = { id, decision, provider_id: row.provider_id, old_value: oldValue, claimant_email: row.claimant_email, provider_name: provider.navn };
    if (decision === "reject") {
      if (!opts.apply) return { ok: true, dry_run: true, ...base };
      db.prepare(
        `UPDATE gardssalg_manual_claims SET status = 'rejected', decided_at = ?, decision_note = ?, old_value = ? WHERE id = ? AND status = 'pending'`,
      ).run(now, note || null, JSON.stringify(oldValue), id);
      audit(row.provider_id, "gardssalg_manual_claim_rejected", oldValue, id, note);
      return { ok: true, dry_run: false, ...base };
    }
    const rule = assessManualClaimDomain(row.claimant_email, provider);
    if (hasActiveNonRevokedClaim(row.provider_id)) return { ok: false, error: "already_claimed", domain_rule: rule };
    const block = !rule.passes && !override ? "domain_rule_mismatch" : null;
    if (!opts.apply) return { ok: true, dry_run: true, ...base, domain_rule: rule, would_block: block };
    if (block) return { ok: false, error: "domain_rule_mismatch", domain_rule: rule };
    const granted = grantManualQueueOwnership(row.provider_id, row.claimant_email);
    if (!granted) return { ok: false, error: "grant_failed", domain_rule: rule };
    const decisionNote = [override && `override: ${override}`, note].filter(Boolean).join(" | ");
    db.prepare(
      `UPDATE gardssalg_manual_claims SET status = 'approved', decided_at = ?, decision_note = ?, domain_rule = ?, old_value = ?, granted_claim_id = ?
        WHERE id = ? AND status = 'pending'`,
    ).run(now, decisionNote || null, JSON.stringify(rule), JSON.stringify(oldValue), granted.ownerClaimId, id);
    audit(row.provider_id, "gardssalg_manual_claim_approved", oldValue, granted.ownerClaimId, decisionNote);
    return { ok: true, dry_run: false, ...base, domain_rule: rule, would_block: null, granted_claim_id: granted.ownerClaimId, loginLink: granted.loginLink };
  };
  // A dry run reads only; an apply runs check + writes in one transaction.
  return opts.apply ? db.transaction(run)() : run();
}

function audit(providerId: string, field: string, oldValue: Record<string, unknown>, newValue: string, notes: string): void {
  getDb(VERTICAL).prepare(
    `INSERT INTO gardssalg_content_audit (id, provider_id, field_name, old_value, new_value, changed_by, notes)
     VALUES (?, ?, ?, ?, ?, 'admin', ?)`,
  ).run(`gca_${crypto.randomUUID()}`, providerId, field, JSON.stringify(oldValue), newValue, notes || null);
}
