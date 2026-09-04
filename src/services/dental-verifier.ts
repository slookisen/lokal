// ─── dental-verifier ────────────────────────────────────────────────────
// dev-request 2026-09-02-dental-verifier-website-ownership.
//
// WHY: dental has NO automated verifier. `verification_status='verified'`
// on dental_agents is today only ever set BY HAND (92 of 6975 rows, all
// manual). RFB/opplevagent's outreach flow requires `verified` PLUS proof
// the platform found the CORRECT business's website (never wrong-company
// outreach) before a producer/experience can be contacted -- dental needs
// the same discipline before outreach on dental clinics can even be
// considered. This mirrors the mature, working RFB twin
// (src/agents/lokal-agent-verifier.ts) at the CONCEPT level -- Brreg
// liveness gate, a website-ownership check that quarantines a mismatched
// site, "any success resets the strike counter" -- but is a fresh,
// dental-scoped implementation: dental_agents/dental.db has a materially
// different schema from agents/agent_knowledge (no per-field provenance
// engine, a claim-pool worker_id/claimed_at lock the RFB side doesn't
// have, a catalog_class triage layer RFB doesn't have), so this file does
// NOT import from lokal-agent-verifier.ts and is never imported BY it --
// same vertical-isolation convention dental-hjemmeside-classifier.ts's own
// doc comment states for blocklist-service.ts's normalizeDomain().
//
// Decomposition mirrors the RFB file's own style: small, pure, exported
// helper functions (fully unit-testable with no DB/network) plus one
// exported batch entrypoint (runDentalVerifierBatch) that wires them to a
// real DB handle and a real fetch. Every I/O dependency (db, fetchImpl,
// brregLookupFn, now) is an injectable option on the entrypoint, defaulting
// to the real thing -- same test-seam discipline as runVerifierBatch's own
// opts.brregLookup/opts.db/etc.
//
// Non-goals (explicitly out of scope for this slice -- see the dev-request):
// Stage V opening-hours/sample-recency logic, any edit to the RFB verifier
// itself, outreach-pool wiring, Helfo extraction.

import { getDb } from "../database/db-factory";
import { verifyOrgNumber, type BrregVerifyResult } from "./brreg-client";
import { fetchPage, type FetchPageResult } from "./fetch-page";
import { DENTAL_CLINIC_CLASS_SQL, type DentalCatalogClass } from "./dental-catalog-class";
import { listSpecialistsForClinic } from "./dental-store";

// ── Tunables ─────────────────────────────────────────────────────────────

// Norwegian bot user-agent identifying this crawl, following THIS
// codebase's own established naming convention for dental-vertical
// fetchers (see DENTAL_WD_USER_AGENT, routes/admin-dental-hjemmeside-
// discovery.ts: "Lokal-Dental-<Purpose>/1.0"). The dev-request's own draft
// spec said to identify as "RFBBot" -- grepped the whole tree for that
// literal string and it appears NOWHERE in this codebase (not even in the
// RFB verifier itself), so that claim was unverified/wrong like several
// others in the filed spec. Following the real, existing convention
// instead of inventing a new one.
export const DENTAL_VERIFIER_USER_AGENT = "Lokal-Dental-Verifier/1.0";

export const DENTAL_VERIFIER_FETCH_TIMEOUT_MS = 12_000;

// Don't re-fetch a homepage that already resolved (successfully loaded,
// whether or not it matched) within this window -- Brreg/other signals may
// still be re-checked every pass regardless (dev-request spec, cache/TTL
// paragraph).
export const DENTAL_VERIFIER_HOMEPAGE_CACHE_MS = 7 * 86_400_000;

// Overall re-verify cadence: a clinic checked within this window is not
// re-picked into a batch at all.
export const DENTAL_VERIFIER_REVERIFY_CYCLE_MS = 30 * 86_400_000;

// 3 consecutive website_ownership='unverified' results -> downgrade. Same
// tuning value as dental-store.ts's DENTAL_PARK_AFTER_ATTEMPTS (shared
// convention, not the same column/counter -- see init-dental.ts's own
// column-addition comment for why this counter is independently owned).
export const DENTAL_VERIFIER_STREAK_DOWNGRADE_AT = 3;

// "at least 3 rich fields populated" (dev-request spec, Verified rule).
export const DENTAL_VERIFIER_MIN_RICH_FIELDS = 3;

export const DEFAULT_DENTAL_VERIFIER_BATCH_SIZE = 200;

// The dental NACE codes this codebase already treats as "clinic NACE"
// elsewhere (src/services/dental-catalog-class.ts,
// classifyDentalCatalogEntry rule 7: "company forms with dental NACE").
// Reused here rather than invented, so the verifier's notion of "wrong
// NACE" cannot silently drift from the catalog classifier's own notion of
// "dental NACE". verifyOrgNumber() itself does NOT compute a wrong_nace
// flag -- its own doc comment is explicit: "'wrong_nace' ... [is] NOT
// computed here; [it requires] vertical-specific NACE allow-lists ...
// callers may set [it] themselves after inspecting the result." This is
// that caller-side computation.
export const DENTAL_VERIFIER_NACE_ALLOWLIST: readonly string[] = ["86.230", "86.221", "86.220"];

// The 10 PR-100 "deep-scrape" columns (init-dental.ts, PR-100 comment
// block: "Deep-scrape (10)") -- the codebase's own existing definition of
// what makes a dental_agents row substantively enriched beyond the raw
// Brreg-sweep import. No prior "richness" concept exists anywhere else in
// the dental code for this file to ground itself in (grepped
// enrichment_state's own values -- raw/enriched/thin_site -- and found no
// numeric field-count threshold anywhere), so this is the most directly
// grounded definition available: the exact column set another PR already
// singled out, by name, as "deepen[ing] enrichment beyond the raw import".
export const DENTAL_RICH_FIELDS: readonly string[] = [
  "om_oss",
  "specialists",
  "treatment_tech",
  "equipment_brands",
  "patient_focus",
  "accessibility",
  "payment_options",
  "online_booking_url",
  "social_media",
  "treatments_subtypes",
];

// ── Types ────────────────────────────────────────────────────────────────

export interface DentalVerifierCandidateRow {
  id: string;
  navn: string;
  org_nr: string | null;
  hjemmeside: string | null;
  poststed: string | null;
  postnummer: string | null;
  catalog_class: DentalCatalogClass | null;
  directory_url: string | null;
  verification_status: string;
  last_verified_at: string | null;
  website_ownership: string | null;
  website_ownership_checked_at: string | null;
  website_ownership_streak: number;
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

export type DentalWebsiteOwnership = "verified" | "unverified" | "n/a";
export type DentalBrregStatus =
  | "active"
  | "dissolved"
  | "bankrupt"
  // Brreg's own `active` boolean (verifyOrgNumber, brreg-client.ts) also
  // folds in `underAvvikling`/`underTvangsavviklingEllerTvangsopplosning`
  // (under voluntary/forced liquidation), but its `flag` field only ever
  // surfaces "dissolved"/"bankrupt"/null for those two -- a CONFIRMED
  // (200-response, exists:true) entity that is inactive for one of those
  // two OTHER reasons would otherwise be silently misbucketed as the
  // ambiguous not-found-or-unreachable case below. Kept as its own bucket
  // so a genuine, confirmed inactive-but-unflagged Brreg answer is never
  // conflated with "we don't actually know".
  | "inactive_other"
  | "orgnr_not_found_or_unreachable";

export interface DentalVerifierResult {
  id: string;
  navn: string;
  brreg_status: DentalBrregStatus | null;
  website_ownership: DentalWebsiteOwnership | null;
  /**
   * ISO timestamp to persist into website_ownership_checked_at, or null to
   * leave the stored value untouched. Set ONLY when a real fetch attempt
   * was actually made this pass (a definitive fetched.ok===true or a non-
   * transient fetched.ok===false) -- deliberately NOT set on a cache hit or
   * a transient-failure skip, or every pass would keep bumping the clock
   * and the 7-day cache TTL (isWebsiteOwnershipCacheFresh) could never go
   * stale.
   */
  website_ownership_checked_at: string | null;
  website_ownership_streak: number;
  specialists_verified: boolean;
  new_verification_status: string;
  verifier_review_reason: string | null;
  new_is_inactive: boolean;
  inactive_reason: string | null;
  rich_field_count: number;
}

// ── Pure helpers ─────────────────────────────────────────────────────────

/**
 * How many of DENTAL_RICH_FIELDS are genuinely populated on this row. JSON
 * array/object columns are parsed so a stored '[]'/'{}' (never written by
 * dental-store.ts's own jsonOrNull(), but defensively guarded the same way
 * dental-claim-service.ts's own completion-mode completeness check already
 * guards these exact columns) does not count as populated. Pure, never
 * throws.
 */
export function countRichFields(row: Partial<DentalVerifierCandidateRow>): number {
  let count = 0;
  const raw = (name: string): string | null | undefined => (row as Record<string, unknown>)[name] as string | null | undefined;

  // om_oss: plain text.
  if ((raw("om_oss") ?? "").trim() !== "") count++;

  // The remaining 9 fields are all JSON-array or JSON-object TEXT columns.
  const jsonFields = DENTAL_RICH_FIELDS.filter((f) => f !== "om_oss");
  for (const field of jsonFields) {
    const value = raw(field);
    if (!value || value.trim() === "") continue;
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        if (parsed.length > 0) count++;
      } else if (parsed && typeof parsed === "object") {
        if (Object.keys(parsed).length > 0) count++;
      } else if (parsed !== null && parsed !== "") {
        count++;
      }
    } catch {
      // Malformed JSON but non-empty text -- still counts as "something is
      // there" rather than silently treating a write bug as "not rich".
      count++;
    }
  }
  return count;
}

/** Lower-case, diacritic-preserving (Norwegian æøå fold correctly via JS's
 * own Unicode-aware toLowerCase()), punctuation-stripped normalisation for
 * substring matching. Pure, never throws. */
export function normalizeForMatch(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Norwegian company-form suffixes stripped off the end of a clinic name
// before matching, so "Bjørn Tannlege AS" and a page reading "Bjørn
// Tannlege" both match. Conservative (word-boundary, end-of-string only).
const COMPANY_FORM_SUFFIX_RE = /\s+(as|da|ans|nuf|sa|asa|enk|ba|ks)$/i;

export function coreClinicName(navn: string | null | undefined): string {
  return (navn ?? "").trim().replace(COMPANY_FORM_SUFFIX_RE, "").trim();
}

export interface WebsiteOwnershipMatchInput {
  orgNr: string | null;
  navn: string | null;
  poststed: string | null;
  postnummer: string | null;
}

export type WebsiteOwnershipMatchReason = "org_nr" | "name_location" | null;

/**
 * Verified rule, signal 2 (dev-request spec): "org number OR (normalized
 * clinic name + poststed/postnummer) appears on the fetched page". Pure --
 * takes already-fetched page text, never fetches anything itself.
 *
 * Org-nr match: both sides digit-stripped, so "911 234 567", "NO 911234567
 * MVA" and a bare "911234567" all match a stored "911234567". A 9-digit
 * literal collision is astronomically unlikely to be a false positive.
 *
 * Name+location match: the clinic's core name (company-form suffix
 * stripped) AND (poststed OR the 4-digit postnummer) must BOTH appear.
 * Either alone is not ownership evidence -- many directory/aggregator pages
 * list a city name or a competitor's own name incidentally.
 */
export function websiteOwnershipMatch(
  pageText: string,
  input: WebsiteOwnershipMatchInput
): { matched: boolean; reason: WebsiteOwnershipMatchReason } {
  const pageDigits = (pageText || "").replace(/\D+/g, "");
  const orgNrDigits = (input.orgNr || "").replace(/\D+/g, "");
  if (orgNrDigits.length === 9 && pageDigits.includes(orgNrDigits)) {
    return { matched: true, reason: "org_nr" };
  }

  const pageNorm = normalizeForMatch(pageText);
  const nameNorm = normalizeForMatch(coreClinicName(input.navn));
  const nameOk = nameNorm.length >= 3 && pageNorm.includes(nameNorm);

  const poststedNorm = normalizeForMatch(input.poststed);
  const postnummer = (input.postnummer || "").trim();
  const locationOk =
    (poststedNorm.length >= 2 && pageNorm.includes(poststedNorm)) ||
    (/^\d{4}$/.test(postnummer) && pageDigits.includes(postnummer));

  if (nameOk && locationOk) return { matched: true, reason: "name_location" };
  return { matched: false, reason: null };
}

/**
 * True when a cached website_ownership observation is still fresh enough
 * that the homepage should NOT be re-fetched this pass (dev-request spec:
 * "don't re-fetch a homepage you already successfully fetched within the
 * last 7 days"). Only 'verified'/'unverified' count as a real, successful
 * fetch -- 'n/a' means there was never a hjemmeside to fetch (irrelevant
 * here, callers never reach this for a blank hjemmeside), and a NULL/never-
 * checked row is always due. Pure given an explicit `now`.
 */
export function isWebsiteOwnershipCacheFresh(
  websiteOwnership: string | null,
  checkedAt: string | null,
  now: number
): boolean {
  if (websiteOwnership !== "verified" && websiteOwnership !== "unverified") return false;
  if (!checkedAt) return false;
  const checkedMs = Date.parse(checkedAt);
  if (Number.isNaN(checkedMs)) return false;
  return now - checkedMs < DENTAL_VERIFIER_HOMEPAGE_CACHE_MS;
}

export interface DentalBrregOutcome {
  status: DentalBrregStatus;
  naceMismatch: boolean;
}

/**
 * Interpret a verifyOrgNumber() result for the dental verifier's own
 * purposes: bucket it into DentalBrregStatus, and separately compute the
 * NACE-mismatch signal verifyOrgNumber() itself deliberately leaves to
 * callers (see its own doc comment). Pure.
 *
 * naceMismatch is only ever computed when Brreg reports the entity as
 * ACTIVE and has at least one NACE code on file -- an inactive/dissolved
 * entity's NACE is not this check's concern (the brreg-death path already
 * disqualifies it), and an entity with NO NACE at all (common for the
 * catalog's `offentlig_klinikk` county-import rows -- see dental-catalog-
 * class.ts rule 4) must never be flagged for a mismatch it has no data to
 * mismatch on, mirroring computeKvalitetsGate's own `if (input.brreg?.naering)`
 * guard in the RFB verifier.
 */
export function interpretBrregResult(verified: BrregVerifyResult): DentalBrregOutcome {
  if (!verified.exists) {
    return { status: "orgnr_not_found_or_unreachable", naceMismatch: false };
  }
  if (verified.flag === "dissolved") return { status: "dissolved", naceMismatch: false };
  if (verified.flag === "bankrupt") return { status: "bankrupt", naceMismatch: false };

  const naceMismatch =
    verified.active &&
    verified.nace.length > 0 &&
    !verified.nace.some((code) => DENTAL_VERIFIER_NACE_ALLOWLIST.includes(code));

  // exists:true, flag is neither "dissolved" nor "bankrupt". If Brreg's
  // `active` boolean is nonetheless false, it can only be because
  // underAvvikling / underTvangsavviklingEllerTvangsopplosning is set (the
  // one other case `active` folds in) -- a confirmed, not ambiguous, answer.
  return { status: verified.active ? "active" : "inactive_other", naceMismatch };
}

export interface DentalVerifiedRuleInput {
  brregStatus: DentalBrregStatus | null;
  websiteOwnership: DentalWebsiteOwnership | null;
  catalogClass: DentalCatalogClass | null;
  directoryUrl: string | null;
  richFieldCount: number;
}

/**
 * The Verified rule (dev-request spec): Brreg active AND (website_ownership
 * verified OR it's an offentlig_klinikk with a directory_url present) AND
 * at least DENTAL_VERIFIER_MIN_RICH_FIELDS rich fields populated. Pure.
 */
export function computeDentalVerifiedRule(input: DentalVerifiedRuleInput): boolean {
  if (input.brregStatus !== "active") return false;
  const ownershipOk =
    input.websiteOwnership === "verified" ||
    (input.catalogClass === "offentlig_klinikk" && !!input.directoryUrl && input.directoryUrl.trim() !== "");
  if (!ownershipOk) return false;
  return input.richFieldCount >= DENTAL_VERIFIER_MIN_RICH_FIELDS;
}

// ── Batch picker ─────────────────────────────────────────────────────────

/**
 * Select up to `limit` candidate clinics: catalog_class IN
 * (klinikk, offentlig_klinikk) (DENTAL_CLINIC_CLASS_SQL -- the SAME clause
 * the claim-pool/Places auto-select already use, so this verifier's notion
 * of "clinic" can never drift from theirs), not permanently closed
 * (is_inactive), not checked within the 30-day re-verify cycle, oldest
 * last_verified_at first with NULLs (never-verified rows) first.
 *
 * Deliberately does NOT touch dental_agents.worker_id/claimed_at (the
 * enrichment-SKILL claim-pool lock, dental-claim-service.ts) -- this
 * verifier writes an entirely disjoint set of columns (website_ownership*,
 * brreg_*, verification_status, is_inactive, specialists_verified) from
 * what the enrichment claim protects (om_oss/treatments/etc, its OWN
 * extraction_attempts/wrong_entity_streak), so there is no write race to
 * guard against, and mirrors the RFB verifier's own pickBatch(), which
 * likewise performs a plain unlocked SELECT with no claim mechanism.
 */
export function pickDentalVerifierBatch(
  db: any,
  limit: number = DEFAULT_DENTAL_VERIFIER_BATCH_SIZE
): DentalVerifierCandidateRow[] {
  return db
    .prepare(
      `SELECT id, navn, org_nr, hjemmeside, poststed, postnummer, catalog_class, directory_url,
              verification_status, last_verified_at,
              website_ownership, website_ownership_checked_at, website_ownership_streak,
              om_oss, specialists, treatment_tech, equipment_brands, patient_focus,
              accessibility, payment_options, online_booking_url, social_media, treatments_subtypes
         FROM dental_agents
        WHERE ${DENTAL_CLINIC_CLASS_SQL}
          AND (is_inactive IS NULL OR is_inactive = 0)
          -- A human/prior sweep explicitly rejected this row -- same
          -- junk-exclusion precedent as dental-claim-service.ts's own
          -- buildWhereClause() default (verification_status NOT IN
          -- ('needs_review','rejected')), narrowed to just 'rejected' here:
          -- unlike the enrichment claim pool, THIS verifier's whole job is
          -- to re-examine 'needs_review' rows and promote them back to
          -- 'verified' once conditions improve, so needs_review stays
          -- eligible; only an explicit 'rejected' is excluded.
          AND (verification_status IS NULL OR verification_status != 'rejected')
          -- 30-day re-verify cycle (DENTAL_VERIFIER_REVERIFY_CYCLE_MS) --
          -- evaluated SQLite-side (same 'now','-N days' idiom dental-claim-
          -- service.ts's own parking exclusions already use) rather than
          -- bound from the JS constant, so the two must be kept in sync by
          -- hand if either ever changes.
          AND (last_verified_at IS NULL OR last_verified_at <= datetime('now','-30 days'))
     ORDER BY COALESCE(last_verified_at, '1970-01-01') ASC, id ASC
        LIMIT ?`
    )
    .all(limit) as DentalVerifierCandidateRow[];
}

// ── DB write ─────────────────────────────────────────────────────────────

function applyDentalVerifierResult(
  db: any,
  row: DentalVerifierCandidateRow,
  outcome: DentalVerifierResult,
  nowIso: string
): void {
  db.prepare(
    `UPDATE dental_agents SET
       verification_status          = ?,
       last_verified_at             = ?,
       verifier_review_reason       = ?,
       is_inactive                  = ?,
       inactive_reason              = ?,
       inactive_since                = CASE WHEN ? = 1 AND (is_inactive IS NULL OR is_inactive = 0) THEN ? ELSE inactive_since END,
       brreg_status                 = ?,
       brreg_checked_at             = ?,
       website_ownership            = COALESCE(?, website_ownership),
       website_ownership_checked_at = COALESCE(?, website_ownership_checked_at),
       website_ownership_streak     = ?,
       specialists_verified         = ?,
       updated_at                   = datetime('now')
     WHERE id = ?`
  ).run(
    outcome.new_verification_status,
    nowIso,
    outcome.verifier_review_reason,
    outcome.new_is_inactive ? 1 : 0,
    outcome.inactive_reason,
    outcome.new_is_inactive ? 1 : 0,
    nowIso,
    outcome.brreg_status,
    outcome.brreg_status !== null ? nowIso : null,
    outcome.website_ownership,
    outcome.website_ownership_checked_at,
    outcome.website_ownership_streak,
    outcome.specialists_verified ? 1 : 0,
    row.id
  );
}

// ── Batch entrypoint ─────────────────────────────────────────────────────

export interface RunDentalVerifierBatchOpts {
  batchSize?: number;
  db?: any;
  /** Injectable Brreg lookup; defaults to the real verifyOrgNumber(). Test seam. */
  brregLookupFn?: (orgNr: string, fetchImpl?: typeof fetch) => Promise<BrregVerifyResult>;
  /** Injectable page fetcher; defaults to the real fetchPage(). Test seam. */
  fetchPageFn?: (url: string, opts: { userAgent: string; timeoutMs?: number; fetchImpl?: typeof fetch }) => Promise<FetchPageResult>;
  fetchImpl?: typeof fetch;
  /** Injectable candidate picker; defaults to pickDentalVerifierBatch. Test seam. */
  pickFn?: (db: any, limit?: number) => DentalVerifierCandidateRow[];
  /** Injectable specialist-affiliation lookup; defaults to listSpecialistsForClinic(). Test seam. */
  listSpecialistsFn?: (clinicId: string) => Array<{ id: string }>;
  now?: () => number;
}

export async function runDentalVerifierBatch(opts: RunDentalVerifierBatchOpts = {}): Promise<{
  run_id: string;
  started_at: string;
  finished_at: string;
  results: DentalVerifierResult[];
}> {
  const db = opts.db ?? getDb("dental");
  const limit = opts.batchSize ?? DEFAULT_DENTAL_VERIFIER_BATCH_SIZE;
  const pickFn = opts.pickFn ?? pickDentalVerifierBatch;
  const brregLookupFn = opts.brregLookupFn ?? verifyOrgNumber;
  const fetchPageFn = opts.fetchPageFn ?? fetchPage;
  const listSpecialistsFn = opts.listSpecialistsFn ?? listSpecialistsForClinic;
  const nowFn = opts.now ?? Date.now;

  const startedAt = new Date(nowFn()).toISOString();
  const runId = `run-${startedAt.replace(/[:.]/g, "").slice(0, 15)}-dental-verifier`;

  const candidates = pickFn(db, limit);
  const results: DentalVerifierResult[] = [];

  for (const row of candidates) {
    const nowMs = nowFn();

    // ── Signal 1: Brreg liveness ──────────────────────────────────────
    let brregStatus: DentalBrregStatus | null = null;
    let naceMismatch = false;
    if (row.org_nr && row.org_nr.trim() !== "") {
      const verified = await brregLookupFn(row.org_nr, opts.fetchImpl).catch(
        (): BrregVerifyResult => ({
          exists: false,
          active: false,
          name: null,
          nace: [],
          registrertDato: null,
          slettetDato: null,
          flag: "no_orgnr",
          employees: null,
        })
      );
      const brreg = interpretBrregResult(verified);
      brregStatus = brreg.status;
      naceMismatch = brreg.naceMismatch;
    }

    // ── Signal 2: website ownership ───────────────────────────────────
    let websiteOwnership: DentalWebsiteOwnership | null = row.website_ownership as DentalWebsiteOwnership | null;
    let streak = row.website_ownership_streak ?? 0;
    // Only set when a REAL fetch attempt resolved this pass (definitively,
    // not a transient skip) -- see DentalVerifierResult.website_ownership_
    // checked_at's own doc comment for why this must stay null otherwise.
    let websiteOwnershipCheckedAt: string | null = null;
    const hjemmeside = row.hjemmeside && row.hjemmeside.trim() !== "" ? row.hjemmeside.trim() : null;
    const nowIsoForRow = new Date(nowMs).toISOString();

    if (!hjemmeside) {
      websiteOwnership = "n/a";
      // No website is not a negative ownership signal -- leave the streak
      // untouched (dev-request spec: the streak only tracks "page loads but
      // doesn't match").
    } else if (isWebsiteOwnershipCacheFresh(row.website_ownership, row.website_ownership_checked_at, nowMs)) {
      // Cache hit -- reuse the stored observation, no new fetch, streak
      // untouched (nothing new was observed this pass).
      websiteOwnership = row.website_ownership as DentalWebsiteOwnership;
    } else {
      const fetched = await fetchPageFn(hjemmeside, {
        userAgent: DENTAL_VERIFIER_USER_AGENT,
        timeoutMs: DENTAL_VERIFIER_FETCH_TIMEOUT_MS,
        fetchImpl: opts.fetchImpl,
      }).catch(
        (): FetchPageResult => ({
          ok: false,
          reason: "unknown",
          persistence: "blocked",
          status: null,
          detail: "fetchPageFn threw",
          attempts: 0,
        })
      );

      if (!fetched.ok && fetched.persistence === "transient") {
        // Momentary blip -- no observation made this pass. Neither
        // website_ownership nor the streak changes; website_ownership_
        // checked_at stays as-is (never stamped for a non-observation), so
        // the next pass will simply try again (never cached as "resolved").
        websiteOwnership = row.website_ownership as DentalWebsiteOwnership | null;
      } else if (!fetched.ok) {
        // permanent/blocked: a dead/wrong-answering URL IS a statement
        // about the stored value -- same precedent already established by
        // gardssalg-website-verification.ts's own GsWvClassification doc
        // comment ("permanent/blocked failures keep collapsing into
        // unverified deliberately").
        websiteOwnership = "unverified";
        streak = streak + 1;
        websiteOwnershipCheckedAt = nowIsoForRow;
      } else {
        const match = websiteOwnershipMatch(fetched.html, {
          orgNr: row.org_nr,
          navn: row.navn,
          poststed: row.poststed,
          postnummer: row.postnummer,
        });
        if (match.matched) {
          websiteOwnership = "verified";
          streak = 0; // any success resets the strike counter
        } else {
          websiteOwnership = "unverified";
          streak = streak + 1;
        }
        websiteOwnershipCheckedAt = nowIsoForRow;
      }
    }

    // ── Signal 3: HPR/specialist check ────────────────────────────────
    let specialistsVerified = false;
    if (row.specialists && row.specialists.trim() !== "" && row.specialists.trim() !== "[]") {
      try {
        specialistsVerified = listSpecialistsFn(row.id).length > 0;
      } catch {
        specialistsVerified = false;
      }
    }

    // ── Verified / downgrade rules ────────────────────────────────────
    const richFieldCount = countRichFields(row);
    let newStatus = row.verification_status;
    let reviewReason: string | null = null;
    let newIsInactive = false;
    let inactiveReason: string | null = null;

    if (brregStatus === "dissolved" || brregStatus === "bankrupt" || brregStatus === "inactive_other") {
      // Signal 1 (spec): Brreg-confirmed dissolved/bankrupt (or the third,
      // unflagged-but-still-confirmed inactive case -- see DentalBrregStatus's
      // own doc comment) -> permanently inactive + review, same precedent as
      // the RFB verifier's own brreg_konkurs/brreg_inactive terminal
      // handling. Only a CONFIRMED (200-response) result ever reaches here
      // -- see interpretBrregResult and DentalBrregOutcome's own doc
      // comment: the ambiguous orgnr_not_found_or_unreachable bucket never
      // does this.
      newIsInactive = true;
      inactiveReason = `brreg_${brregStatus}`;
      newStatus = "needs_review";
      reviewReason = `brreg_${brregStatus}`;
    } else if (naceMismatch) {
      newStatus = "needs_review";
      reviewReason = "brreg_nace_mismatch";
    } else if (
      computeDentalVerifiedRule({
        brregStatus,
        websiteOwnership,
        catalogClass: row.catalog_class,
        directoryUrl: row.directory_url,
        richFieldCount,
      })
    ) {
      newStatus = "verified";
    } else if (streak >= DENTAL_VERIFIER_STREAK_DOWNGRADE_AT) {
      newStatus = "needs_review";
      reviewReason = "website_ownership_streak";
    }
    // Otherwise: leave verification_status exactly as it already was --
    // "not yet passing" is not itself a downgrade signal (mirrors the RFB
    // verifier's own monotonic-guard philosophy for non-punitive signals).

    const outcome: DentalVerifierResult = {
      id: row.id,
      navn: row.navn,
      brreg_status: brregStatus,
      website_ownership: websiteOwnership,
      website_ownership_checked_at: websiteOwnershipCheckedAt,
      website_ownership_streak: streak,
      specialists_verified: specialistsVerified,
      new_verification_status: newStatus,
      verifier_review_reason: reviewReason,
      new_is_inactive: newIsInactive,
      inactive_reason: inactiveReason,
      rich_field_count: richFieldCount,
    };

    applyDentalVerifierResult(db, row, outcome, nowIsoForRow);
    results.push(outcome);
  }

  const finishedAt = new Date(nowFn()).toISOString();
  return { run_id: runId, started_at: startedAt, finished_at: finishedAt, results };
}
