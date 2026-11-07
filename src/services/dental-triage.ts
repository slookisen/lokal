// ─── dental-triage ──────────────────────────────────────────────────────
// dev-request 2026-09-02-dental-permanent-triage-needs-review-drain, slice 3c-1.
//
// WHY: slice 3b (dental-store.ts, recordDentalHomepageFetchResult /
// recordDentalExtractionResult / parkDentalWrongEntity) routes a repeatedly
// parked clinic to verification_status='needs_review' with review_reason in
// {wrong_entity_repeat, dead_homepage_repeat, insufficient_yield_repeat} and a
// review_since stamp. Nothing drained that state. This job drains the part of
// it that can be decided DETERMINISTICALLY, with checks that already exist in
// this codebase:
//
//   1. inactive  — Brreg says the unit is deleted (slettet: slettedato set or
//                  HTTP 410). Brreg lookup: fetchBrregAddressEvidence()
//                  (brreg-client.ts — the dental Brreg sweep's lookup, the one
//                  that tells "deleted" apart from "unreachable"). Write: the
//                  same columns + provenance entry POST /admin/dental/mark-
//                  inactive writes (mergeInactiveProvenance), inactive_reason
//                  'brreg_dissolved' as the dental verifier names it.
//   2. directory_homepage — hjemmeside is a directory/catalog page per
//                  classifyHjemmeside() (dental-hjemmeside-classifier.ts).
//                  Write: the same move POST /admin/dental/hjemmeside-cleanup-
//                  sweep makes (hjemmeside -> directory_url, provenance via
//                  mergeHjemmesideCleanupProvenance), plus enrichment_state
//                  back to 'raw' and the review state cleared.
//   3. verified  — the dental verifier's own rule, unchanged: Brreg active and
//                  no NACE mismatch (verifyOrgNumber + interpretBrregResult),
//                  website ownership (stored observation while fresh, else
//                  fetchPage + websiteOwnershipMatch), rich fields
//                  (countRichFields), all through computeDentalVerifiedRule()
//                  (dental-verified-claim.ts).
//
// Everything else stays needs_review, row untouched (decision 'undecided',
// with a reason). The judgement outcomes (rejected + dental_exclusions,
// catalog_class correction) are NOT here — next slice.
//
// Audit: every applied decision (and every undecided result of a REAL run)
// writes one dental_verifier_findings row (check_type 'dental_triage'); the
// table is the dental per-agent evidence trail (init-dental.ts) and had no
// writer. The undecided row is what lets the picker skip a row it could not
// decide for DENTAL_TRIAGE_UNDECIDED_RECHECK_DAYS, so the oldest 50 undecided
// rows cannot block every newer row forever.
//
// Guards: env DENTAL_TRIAGE_JOB_ENABLED must be exactly "true" for any write;
// the dental enrichment write-pause (dental-enrichment-write-pause.ts) is
// checked before the run and again before each row's write; one transaction
// per row, with a re-read that skips the row if it changed since the decision
// was computed. No LLM, no e-mail. Dry-run (computeDentalTriageDryRun) never
// writes and ignores the flag and the pause.

import { randomUUID } from "crypto";
import { getDb } from "../database/db-factory";
import {
  fetchBrregAddressEvidence,
  verifyOrgNumber,
  type BrregAddressEvidence,
  type BrregVerifyResult,
} from "./brreg-client";
import { fetchPage, type FetchPageResult } from "./fetch-page";
import { classifyHjemmeside } from "./dental-hjemmeside-classifier";
import { DENTAL_NOT_SYNTHETIC_PROBE_SQL } from "./dental-contamination";
import {
  DENTAL_VERIFIER_FETCH_TIMEOUT_MS,
  DENTAL_VERIFIER_USER_AGENT,
  interpretBrregResult,
  isWebsiteOwnershipCacheFresh,
  websiteOwnershipMatch,
} from "./dental-verifier";
import {
  computeDentalVerifiedRule,
  countRichFields,
  type DentalWebsiteOwnership,
} from "./dental-verified-claim";
import type { DentalCatalogClass } from "./dental-catalog-class";
import { dentalEnrichmentWritePauseBlock } from "./dental-enrichment-write-pause";
import type { EnrichmentWritePausedBody } from "./enrichment-write-pause";
import { mergeInactiveProvenance } from "../routes/admin-dental-mark-inactive";
import { mergeHjemmesideCleanupProvenance } from "../routes/admin-dental-hjemmeside-cleanup";

// ── Tunables ─────────────────────────────────────────────────────────────

export const DENTAL_TRIAGE_JOB = "dental-triage";
export const DENTAL_TRIAGE_MAX_BATCH = 50;
/** Weekly cadence: a real scheduled run happens at most once per this window (boot_job_state stamp). */
export const DENTAL_TRIAGE_INTERVAL_MS = 7 * 86_400_000;
/** A row a real run left undecided is not re-picked for this many days. */
export const DENTAL_TRIAGE_UNDECIDED_RECHECK_DAYS = 28;
export const DENTAL_TRIAGE_CHECK_TYPE = "dental_triage";

/** The slice 3b review reasons this job drains. */
export const DENTAL_TRIAGE_REVIEW_REASONS = [
  "wrong_entity_repeat",
  "dead_homepage_repeat",
  "insufficient_yield_repeat",
] as const;

/** The catalog classes the dental verifier treats as a clinic (DENTAL_CLINIC_CLASS_SQL). */
const CLINIC_CLASSES = new Set<string>(["klinikk", "offentlig_klinikk", "ukjent"]);

/** On only when the env value is exactly "true". */
export function dentalTriageJobEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DENTAL_TRIAGE_JOB_ENABLED === "true";
}

// ── Types ────────────────────────────────────────────────────────────────

export type DentalTriageDecisionKind = "inactive" | "verified" | "directory_homepage" | "undecided";

export interface DentalTriageCandidateRow {
  id: string;
  navn: string;
  org_nr: string | null;
  hjemmeside: string | null;
  directory_url: string | null;
  poststed: string | null;
  postnummer: string | null;
  catalog_class: string | null;
  verification_status: string | null;
  review_reason: string | null;
  review_since: string | null;
  is_inactive: number | null;
  website_ownership: string | null;
  website_ownership_checked_at: string | null;
  website_ownership_streak: number | null;
  field_provenance: string | null;
  om_oss: string | null;
  specialists: string | null;
  treatment_tech: string | null;
  equipment_brands: string | null;
  patient_focus: string | null;
  accessibility: string | null;
  payment_options: string | null;
  online_booking_url: string | null;
  social_media: string | null;
  treatments_subtypes: string | null;
}

export interface DentalTriageDecision {
  id: string;
  name: string;
  decision: DentalTriageDecisionKind;
  reason: string;
  evidence: Record<string, unknown>;
  /** Values the write needs; not part of the public response. */
  apply?: {
    website_ownership?: DentalWebsiteOwnership | null;
    website_ownership_checked_at?: string | null;
    website_ownership_streak?: number;
  };
}

export interface DentalTriageDeps {
  db?: any;
  fetchImpl?: typeof fetch;
  brregEvidenceFn?: (orgNr: string, fetchImpl?: typeof fetch) => Promise<BrregAddressEvidence>;
  brregVerifyFn?: (orgNr: string, fetchImpl?: typeof fetch) => Promise<BrregVerifyResult>;
  fetchPageFn?: (url: string, opts: { userAgent: string; timeoutMs?: number; fetchImpl?: typeof fetch }) => Promise<FetchPageResult>;
  pauseBlock?: () => EnrichmentWritePausedBody | null;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

// ── Candidate picker ─────────────────────────────────────────────────────

const CANDIDATE_COLUMNS = `id, navn, org_nr, hjemmeside, directory_url, poststed, postnummer, catalog_class,
       verification_status, review_reason, review_since, is_inactive,
       website_ownership, website_ownership_checked_at, website_ownership_streak, field_provenance,
       om_oss, specialists, treatment_tech, equipment_brands, patient_focus,
       accessibility, payment_options, online_booking_url, social_media, treatments_subtypes`;

const REASONS_SQL = DENTAL_TRIAGE_REVIEW_REASONS.map(() => "?").join(", ");

/** The triage state: needs_review from slice 3b, not already closed. */
const CANDIDATE_STATE_SQL = `verification_status = 'needs_review'
          AND review_reason IN (${REASONS_SQL})
          AND (is_inactive IS NULL OR is_inactive = 0)
          AND ${DENTAL_NOT_SYNTHETIC_PROBE_SQL}`;

export function clampDentalTriageLimit(raw: unknown, fallback: number = DENTAL_TRIAGE_MAX_BATCH): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), DENTAL_TRIAGE_MAX_BATCH);
}

/**
 * Oldest review_since first (id as tiebreaker), up to `limit` (max 50). A row
 * a real run left undecided within DENTAL_TRIAGE_UNDECIDED_RECHECK_DAYS is
 * skipped, so undecided rows cannot starve the rest of the queue.
 */
export function pickDentalTriageCandidates(db: any, limit: number = DENTAL_TRIAGE_MAX_BATCH): DentalTriageCandidateRow[] {
  return db
    .prepare(
      `SELECT ${CANDIDATE_COLUMNS}
         FROM dental_agents
        WHERE ${CANDIDATE_STATE_SQL}
          AND NOT EXISTS (
                SELECT 1 FROM dental_verifier_findings f
                 WHERE f.agent_id = dental_agents.id
                   AND f.check_type = ?
                   AND f.status = 'undecided'
                   AND f.checked_at > datetime('now', ?))
        ORDER BY COALESCE(review_since, '9999') ASC, id ASC
        LIMIT ?`,
    )
    .all(
      ...DENTAL_TRIAGE_REVIEW_REASONS,
      DENTAL_TRIAGE_CHECK_TYPE,
      `-${DENTAL_TRIAGE_UNDECIDED_RECHECK_DAYS} days`,
      clampDentalTriageLimit(limit),
    ) as DentalTriageCandidateRow[];
}

/** Named rows (dry-run inspection): in triage state, regardless of the undecided recheck window. */
function pickDentalTriageByIds(db: any, ids: string[]): DentalTriageCandidateRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT ${CANDIDATE_COLUMNS}
         FROM dental_agents
        WHERE ${CANDIDATE_STATE_SQL}
          AND id IN (${placeholders})
        ORDER BY COALESCE(review_since, '9999') ASC, id ASC`,
    )
    .all(...DENTAL_TRIAGE_REVIEW_REASONS, ...ids) as DentalTriageCandidateRow[];
}

// ── Decision (no writes) ─────────────────────────────────────────────────

type BrregState = "deleted" | "active" | "not_active_not_deleted" | "not_found" | "unreachable" | "no_orgnr";

function brregStateOf(ev: BrregAddressEvidence | null): BrregState {
  if (!ev) return "no_orgnr";
  if (ev.kind === "error") return "unreachable";
  if (ev.kind === "not_found") return "not_found";
  if (ev.slettet) return "deleted";
  if (ev.konkurs || ev.underAvvikling) return "not_active_not_deleted";
  return "active";
}

function undecided(row: DentalTriageCandidateRow, reason: string, evidence: Record<string, unknown>): DentalTriageDecision {
  return { id: row.id, name: row.navn, decision: "undecided", reason, evidence };
}

/**
 * Compute the triage decision for one row. Reads Brreg / the homepage over the
 * network (read-only); never writes. A Brreg failure can only lead to
 * 'undecided' (or the Brreg-independent directory decision), never 'verified'.
 */
export async function decideDentalTriage(
  row: DentalTriageCandidateRow,
  deps: DentalTriageDeps = {},
): Promise<DentalTriageDecision> {
  const fetchImpl = deps.fetchImpl;
  const brregEvidenceFn = deps.brregEvidenceFn ?? fetchBrregAddressEvidence;
  const brregVerifyFn = deps.brregVerifyFn ?? verifyOrgNumber;
  const fetchPageFn = deps.fetchPageFn ?? fetchPage;
  const nowMs = (deps.now ?? Date.now)();

  const evidence: Record<string, unknown> = {
    review_reason: row.review_reason,
    review_since: row.review_since,
  };

  // ── 1. Brreg deleted -> inactive ─────────────────────────────────────
  const orgNr = row.org_nr && row.org_nr.trim() !== "" ? row.org_nr.trim() : null;
  let ev: BrregAddressEvidence | null = null;
  if (orgNr) {
    ev = await brregEvidenceFn(orgNr, fetchImpl).catch((): BrregAddressEvidence => ({ kind: "error" }));
  }
  const brregState = brregStateOf(ev);
  evidence.brreg = ev && ev.kind === "found"
    ? { state: brregState, org_nr: orgNr, slettet: ev.slettet, konkurs: ev.konkurs, under_avvikling: ev.underAvvikling }
    : { state: brregState, org_nr: orgNr };

  if (brregState === "deleted") {
    return { id: row.id, name: row.navn, decision: "inactive", reason: "brreg_dissolved", evidence };
  }

  // ── 2. Directory/catalog homepage -> directory_url, back to raw ──────
  const hjemmeside = row.hjemmeside && row.hjemmeside.trim() !== "" ? row.hjemmeside.trim() : null;
  if (hjemmeside) {
    const cls = classifyHjemmeside(hjemmeside);
    if (cls.isBad && cls.reason) {
      evidence.hjemmeside = { value: row.hjemmeside, classifier_reason: cls.reason };
      if (row.directory_url !== null && row.directory_url !== undefined) {
        evidence.directory_url = row.directory_url;
        return undecided(row, "directory_homepage_but_directory_url_set", evidence);
      }
      return { id: row.id, name: row.navn, decision: "directory_homepage", reason: `hjemmeside_${cls.reason}`, evidence };
    }
  }

  // ── 3. The dental verifier's Verified rule ───────────────────────────
  if (brregState !== "active") {
    return undecided(row, brregState === "no_orgnr" ? "no_orgnr" : `brreg_${brregState}`, evidence);
  }
  if (row.catalog_class !== null && !CLINIC_CLASSES.has(row.catalog_class)) {
    evidence.catalog_class = row.catalog_class;
    return undecided(row, "not_clinic_catalog_class", evidence);
  }

  const verified = await brregVerifyFn(orgNr as string, fetchImpl).catch((): BrregVerifyResult => ({
    exists: false, active: false, name: null, nace: [], registrertDato: null, slettetDato: null, flag: "no_orgnr", employees: null,
  }));
  const brreg = interpretBrregResult(verified);
  evidence.brreg_verify = { status: brreg.status, nace: verified.nace, nace_mismatch: brreg.naceMismatch };
  if (brreg.status !== "active") return undecided(row, `brreg_verify_${brreg.status}`, evidence);
  if (brreg.naceMismatch) return undecided(row, "brreg_nace_mismatch", evidence);

  let websiteOwnership: DentalWebsiteOwnership | null = (row.website_ownership as DentalWebsiteOwnership | null) ?? null;
  let checkedAt: string | null = null;
  let streak = row.website_ownership_streak ?? 0;
  let ownershipSource: string;
  if (!hjemmeside) {
    websiteOwnership = "n/a";
    ownershipSource = "no_hjemmeside";
  } else if (isWebsiteOwnershipCacheFresh(row.website_ownership, row.website_ownership_checked_at, nowMs)) {
    ownershipSource = "stored_fresh";
  } else {
    const fetched = await fetchPageFn(hjemmeside, {
      userAgent: DENTAL_VERIFIER_USER_AGENT,
      timeoutMs: DENTAL_VERIFIER_FETCH_TIMEOUT_MS,
      fetchImpl,
    }).catch((): FetchPageResult => ({
      ok: false, reason: "unknown", persistence: "transient", status: null, detail: "fetchPageFn threw", attempts: 0,
    }));
    if (!fetched.ok) {
      websiteOwnership = null;
      ownershipSource = `fetch_failed:${fetched.reason}`;
    } else {
      const match = websiteOwnershipMatch(fetched.html, {
        orgNr: row.org_nr, navn: row.navn, poststed: row.poststed, postnummer: row.postnummer,
      });
      websiteOwnership = match.matched ? "verified" : "unverified";
      ownershipSource = match.matched ? `fetched_match:${match.reason}` : "fetched_no_match";
      checkedAt = new Date(nowMs).toISOString();
      streak = match.matched ? 0 : streak + 1;
    }
  }
  const richFieldCount = countRichFields(row);
  evidence.website_ownership = { value: websiteOwnership, source: ownershipSource };
  evidence.rich_field_count = richFieldCount;

  const passes = computeDentalVerifiedRule({
    brregStatus: brreg.status,
    websiteOwnership,
    catalogClass: row.catalog_class as DentalCatalogClass | null,
    directoryUrl: row.directory_url,
    richFieldCount,
  });
  if (!passes) return undecided(row, "verified_rule_not_met", evidence);

  return {
    id: row.id,
    name: row.navn,
    decision: "verified",
    reason: "verified_rule_met",
    evidence,
    apply: {
      website_ownership: websiteOwnership,
      website_ownership_checked_at: checkedAt,
      website_ownership_streak: checkedAt ? streak : undefined,
    },
  };
}

function publicDecision(d: DentalTriageDecision): Omit<DentalTriageDecision, "apply"> {
  return { id: d.id, name: d.name, decision: d.decision, reason: d.reason, evidence: d.evidence };
}

// ── Dry-run ──────────────────────────────────────────────────────────────

export interface DentalTriageDryRunResult {
  dry_run: true;
  flag_enabled: boolean;
  candidates: number;
  decisions: Array<Omit<DentalTriageDecision, "apply">>;
  undecided: Array<Omit<DentalTriageDecision, "apply">>;
  /** Requested ids that are not in the triage state (or do not exist). */
  not_candidates: string[];
}

/** Computes decisions for the candidates; writes nothing, whatever the flag or the pause say. */
export async function computeDentalTriageDryRun(
  opts: { limit?: number; ids?: string[] } & DentalTriageDeps = {},
): Promise<DentalTriageDryRunResult> {
  const db = opts.db ?? getDb("dental");
  const ids = opts.ids ?? null;
  const rows = ids ? pickDentalTriageByIds(db, ids) : pickDentalTriageCandidates(db, opts.limit ?? DENTAL_TRIAGE_MAX_BATCH);
  const decisions: Array<Omit<DentalTriageDecision, "apply">> = [];
  const undecidedOut: Array<Omit<DentalTriageDecision, "apply">> = [];
  for (const row of rows) {
    const d = await decideDentalTriage(row, opts);
    (d.decision === "undecided" ? undecidedOut : decisions).push(publicDecision(d));
  }
  const found = new Set(rows.map((r) => r.id));
  return {
    dry_run: true,
    flag_enabled: dentalTriageJobEnabled(opts.env),
    candidates: rows.length,
    decisions,
    undecided: undecidedOut,
    not_candidates: ids ? ids.filter((id) => !found.has(id)) : [],
  };
}

// ── Writes ───────────────────────────────────────────────────────────────

function insertTriageFinding(db: any, d: DentalTriageDecision, nowIso: string): void {
  db.prepare(
    `INSERT INTO dental_verifier_findings (id, agent_id, check_type, status, evidence, notes, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    d.id,
    DENTAL_TRIAGE_CHECK_TYPE,
    d.decision,
    JSON.stringify(d.evidence),
    d.reason,
    nowIso.replace("T", " ").slice(0, 19), // same text form as datetime('now'), so the recheck comparison holds
  );
}

/**
 * Apply one decision in its own transaction. Re-reads the row first and skips
 * it (returns false) if it left the triage state or its review_since /
 * hjemmeside changed since the decision was computed.
 */
export function applyDentalTriageDecision(
  db: any,
  row: DentalTriageCandidateRow,
  d: DentalTriageDecision,
  nowIso: string,
): boolean {
  let applied = false;
  const tx = db.transaction(() => {
    const current = db
      .prepare(
        `SELECT verification_status, review_reason, review_since, is_inactive, hjemmeside, directory_url, field_provenance
           FROM dental_agents WHERE id = ?`,
      )
      .get(row.id) as
      | {
          verification_status: string | null; review_reason: string | null; review_since: string | null;
          is_inactive: number | null; hjemmeside: string | null; directory_url: string | null; field_provenance: string | null;
        }
      | undefined;
    if (!current) return;
    if (current.verification_status !== "needs_review") return;
    if (current.review_since !== row.review_since || current.review_reason !== row.review_reason) return;
    if (current.is_inactive === 1) return;
    if (current.hjemmeside !== row.hjemmeside) return;

    if (d.decision === "inactive") {
      // Same columns + provenance entry as POST /admin/dental/mark-inactive;
      // brreg_status/brreg_checked_at as the dental verifier stores them.
      // verification_status stays as it is (the verifier also leaves a
      // Brreg-closed row at needs_review); is_inactive takes it out of every
      // public path, the claim pool and this job's own candidate set.
      const prov = mergeInactiveProvenance(current.field_provenance, { reason: d.reason, marked_inactive_at: nowIso });
      db.prepare(
        `UPDATE dental_agents
            SET is_inactive = 1, inactive_reason = ?, inactive_since = ?,
                brreg_status = 'dissolved', brreg_checked_at = ?,
                field_provenance = ?, updated_at = datetime('now')
          WHERE id = ?`,
      ).run(d.reason, nowIso, nowIso, prov, row.id);
    } else if (d.decision === "directory_homepage") {
      if (current.directory_url !== null) return;
      const recheck = classifyHjemmeside(current.hjemmeside);
      if (!recheck.isBad || !recheck.reason || !current.hjemmeside) return;
      // Same move as POST /admin/dental/hjemmeside-cleanup-sweep, plus back to
      // raw enrichment and out of needs_review (pending_verify is the column default).
      const prov = mergeHjemmesideCleanupProvenance(current.field_provenance, {
        cleaned_reason: recheck.reason,
        previous_value: current.hjemmeside,
        cleaned_at: nowIso,
      });
      db.prepare(
        `UPDATE dental_agents
            SET directory_url = ?, hjemmeside = NULL, field_provenance = ?,
                enrichment_state = 'raw', verification_status = 'pending_verify',
                review_reason = NULL, review_since = NULL, updated_at = datetime('now')
          WHERE id = ?`,
      ).run(current.hjemmeside, prov, row.id);
    } else if (d.decision === "verified") {
      // The columns the dental verifier writes for a 'verified' outcome, so the
      // public read-time rule (resolveVerifiedClaim) reads the same basis.
      const a = d.apply ?? {};
      db.prepare(
        `UPDATE dental_agents
            SET verification_status = 'verified', last_verified_at = ?,
                verifier_review_reason = NULL,
                brreg_status = 'active', brreg_checked_at = ?,
                website_ownership = COALESCE(?, website_ownership),
                website_ownership_checked_at = COALESCE(?, website_ownership_checked_at),
                website_ownership_streak = COALESCE(?, website_ownership_streak),
                review_reason = NULL, review_since = NULL, updated_at = datetime('now')
          WHERE id = ?`,
      ).run(
        nowIso, nowIso,
        a.website_ownership ?? null,
        a.website_ownership_checked_at ?? null,
        a.website_ownership_streak ?? null,
        row.id,
      );
    }
    // 'undecided': dental_agents untouched; only the audit row below.
    insertTriageFinding(db, d, nowIso);
    applied = true;
  });
  tx();
  return applied;
}

// ── Real run ─────────────────────────────────────────────────────────────

export interface DentalTriageRunSummary {
  run_id: string;
  started_at: string;
  finished_at: string;
  disabled: boolean;
  paused: boolean;
  pause_reason: string | null;
  candidates: number;
  inactive: number;
  verified: number;
  directory_homepage: number;
  undecided: number;
  undecided_reasons: Record<string, number>;
  skipped_changed: number;
  decisions: Array<Omit<DentalTriageDecision, "apply">>;
}

let dentalTriageRunning = false;

export function isDentalTriageRunning(): boolean {
  return dentalTriageRunning;
}

/**
 * One real pass. No-op (disabled:true, zero writes) unless
 * DENTAL_TRIAGE_JOB_ENABLED === "true"; no-op (paused:true) while the dental
 * enrichment write-pause is on or its lookup fails closed. Throws if a pass is
 * already running.
 */
export async function runDentalTriage(opts: { limit?: number } & DentalTriageDeps = {}): Promise<DentalTriageRunSummary> {
  const nowFn = opts.now ?? Date.now;
  const startedAt = new Date(nowFn()).toISOString();
  const summary: DentalTriageRunSummary = {
    run_id: `run-${startedAt.replace(/[:.]/g, "").slice(0, 15)}-dental-triage`,
    started_at: startedAt,
    finished_at: startedAt,
    disabled: false,
    paused: false,
    pause_reason: null,
    candidates: 0,
    inactive: 0,
    verified: 0,
    directory_homepage: 0,
    undecided: 0,
    undecided_reasons: {},
    skipped_changed: 0,
    decisions: [],
  };
  if (!dentalTriageJobEnabled(opts.env)) {
    summary.disabled = true;
    return summary;
  }
  const pauseFn = opts.pauseBlock ?? dentalEnrichmentWritePauseBlock;
  const checkPause = (): boolean => {
    const block = pauseFn();
    if (block) {
      summary.paused = true;
      summary.pause_reason = block.reason ?? (block.fail_closed ? "fail_closed" : null);
      return true;
    }
    return false;
  };
  if (checkPause()) return summary;

  if (dentalTriageRunning) throw new Error("dental_triage_already_running");
  dentalTriageRunning = true;
  try {
    const db = opts.db ?? getDb("dental");
    const rows = pickDentalTriageCandidates(db, opts.limit ?? DENTAL_TRIAGE_MAX_BATCH);
    summary.candidates = rows.length;
    for (const row of rows) {
      const d = await decideDentalTriage(row, opts);
      // The pause may have been set while we waited on the network.
      if (checkPause()) break;
      const applied = applyDentalTriageDecision(db, row, d, new Date(nowFn()).toISOString());
      if (!applied) {
        summary.skipped_changed++;
        continue;
      }
      summary.decisions.push(publicDecision(d));
      if (d.decision === "undecided") {
        summary.undecided++;
        summary.undecided_reasons[d.reason] = (summary.undecided_reasons[d.reason] ?? 0) + 1;
      } else {
        summary[d.decision]++;
      }
    }
  } finally {
    dentalTriageRunning = false;
    summary.finished_at = new Date(nowFn()).toISOString();
  }
  return summary;
}

/** One-line run summary for the log. */
export function formatDentalTriageSummary(s: DentalTriageRunSummary): string {
  if (s.disabled) return `[dental-triage] run_id=${s.run_id} disabled (DENTAL_TRIAGE_JOB_ENABLED is not "true") — nothing written`;
  if (s.paused && s.candidates === 0) return `[dental-triage] run_id=${s.run_id} held back by dental enrichment write-pause: ${s.pause_reason ?? "-"}`;
  return (
    `[dental-triage] run_id=${s.run_id} candidates=${s.candidates} inactive=${s.inactive} verified=${s.verified} ` +
    `directory_homepage=${s.directory_homepage} undecided=${s.undecided} skipped_changed=${s.skipped_changed} ` +
    `paused=${s.paused} undecided_reasons=${JSON.stringify(s.undecided_reasons)}`
  );
}

/** True when the weekly scheduled run is due (no persisted run, or the last one is ≥ 7 days old). */
export function isDentalTriageDue(lastCompletedAt: Date | null, now: Date): boolean {
  if (!lastCompletedAt) return true;
  const age = now.getTime() - lastCompletedAt.getTime();
  if (age < 0) return true; // future stamp (clock skew): not trusted
  return age >= DENTAL_TRIAGE_INTERVAL_MS;
}
