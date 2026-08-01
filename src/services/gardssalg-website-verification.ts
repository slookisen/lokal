// ─── Gårdssalg website verification — narrow slice of Steg 3/5 ─────────────
//
// dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach,
// Steg 3 ("nettside-verifisering-i-berikelse"), SCOPED-DOWN per the slice
// spec: this file only ADDS a new, independent sweep — it never gates the
// existing content-refresh pipeline (that's left for a follow-up once
// verification data actually exists to evaluate throughput impact against).
//
// For every gårdssalg producer in the outreach cohort, classifies its stored
// `hjemmeside` into exactly one bucket:
//
//   missing_source — blank/null hjemmeside. Never fetched.
//   aggregator     — isDirectoryOrAggregatorHost(hostFromUrlLike(hjemmeside))
//                     is true. Never fetched (Funn 4: a directory/DMO host is
//                     never evidence of ownership, fetching it would just
//                     waste a request).
//   verified       — the page was fetched and gardssalgWebsiteEvidenceMatch
//                     against the producer's OWN stored fields (org_nr,
//                     navn, kommune, poststed, telefon, mobil, adresse,
//                     postnummer) returned verified===true.
//   unverified     — the page was fetched but no evidence matched, OR the
//                     fetch itself failed/timed out. A fetch failure fails
//                     INTO this bucket (never throws, never silently
//                     "verified") — same fail-closed direction the whole
//                     dev-request is built around (Funn 4/5, and the Steg 2
//                     incident this slice was built the same day as: prefer
//                     the conservative bucket over a false positive).
//
// Matching itself is NOT reimplemented here — gardssalgWebsiteEvidenceMatch
// (experience-store.ts) is called unchanged, exactly as the website-discovery
// route (routes/opplevelser.ts, POST /admin/gardssalg-website-discovery)
// already calls it. This module only decides WHICH producers to check and
// WHAT PAGE TEXT to hand it (via an injected fetch function — see GsWvFetchFn
// below), never how the matching itself works.
//
// Page fetching is injected (GsWvFetchFn), not performed here: the real
// fetcher stays exactly where it already lives (crFetchGardssalgContent,
// routes/opplevelser.ts, the SAME SSRF-guarded multi-page crawl the
// content-refresh/retro-scan routes already use) — this file only consumes
// its output via a thin adapter the route wires up, so this module has zero
// network code of its own and is trivially unit-testable with a fake
// fetchFn.
//
// Mirrors gardssalg-experience-conflict.ts's shape: load cohort -> classify
// (pure per-row decision plus the injected fetch) -> summarize -> plan
// (read-only) -> apply (write, dry-run by default at the route layer).

import type Database from "better-sqlite3";
import { v4 as uuid } from "uuid";
import { hostFromUrlLike, isDirectoryOrAggregatorHost } from "./cross-source-validator";
import {
  gardssalgWebsiteEvidenceMatch,
  upsertGardssalgWebsiteReviewQueue,
  listGardssalgWebsiteReviewQueue,
} from "./experience-store";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GsWvProducerRow {
  id: string;
  navn: string;
  hjemmeside: string | null;
  org_nr: string | null;
  kommune: string | null;
  poststed: string | null;
  telefon: string | null;
  mobil: string | null;
  adresse: string | null;
  postnummer: string | null;
  catalog_hidden: number | null;
}

export type GsWvClassification = "verified" | "unverified" | "aggregator" | "missing_source";

export type GsWvEvidence = ReturnType<typeof gardssalgWebsiteEvidenceMatch>;

export interface GsWvScanRow {
  provider_id: string;
  name: string;
  hjemmeside: string | null;
  classification: GsWvClassification;
  evidence: GsWvEvidence | null;
}

export interface GsWvSummary {
  verified: number;
  unverified: number;
  aggregator: number;
  missing_source: number;
  total: number;
}

// Adapter the route wires to crFetchGardssalgContent + gardssalgPageText —
// this module never calls fetch/network code itself, only this contract.
// `reason` is carried through for observability but not currently surfaced
// on the row (classification alone drives all downstream behaviour).
export type GsWvFetchResult = { ok: true; pageText: string } | { ok: false; reason: string };
export type GsWvFetchFn = (homepageUrl: string) => Promise<GsWvFetchResult>;

// ─── Cohort (Part A load) ───────────────────────────────────────────────────
//
// Same base WHERE as GET /admin/gardssalg-outreach-readiness
// (routes/opplevelser.ts ~line 5966: producer_type IS NOT NULL OR
// rfb_seed_source = 'rfb-seed'). No materialized cohort table exists anywhere
// in this codebase (task spec) — this recomputes live from
// experience_providers on every call, same discipline as
// loadGardssalgProducersForConflictScan.
//
// VISIBILITY SCOPE: the original slice hard-excluded hidden producers per
// the dev-request's then-instruction ("hidden producers are never outreach
// candidates, never expose them via a new sweep either"). Daniel overrode
// that live 2026-08-01: verification applies to ALL harvested producers,
// hidden included — «Dette gjelder alle produsenter vi har innhentet, ikke
// bare dem som er outreach-klare». Verification is not exposure: both routes
// stay admin-gated, a hidden producer's rows never reach any public surface,
// and stamping provenance on a hidden row publishes nothing. The DEFAULT
// stays "visible" so every existing caller (and the fleet's scheduled
// sweeps) behaves byte-for-byte as before; "hidden"/"all" are explicit
// per-call opt-ins.
//
// The hidden-exclusion clause uses the established null-safe form
// `(catalog_hidden IS NULL OR catalog_hidden != 1)` every other gårdssalg
// selector in this codebase uses (a bare `!= 1` would silently also exclude
// every NULL row, which is not what "hidden producers excluded" means here).
export type GsWvScope = "visible" | "hidden" | "all";

export const GS_WV_SCOPES: readonly GsWvScope[] = ["visible", "hidden", "all"] as const;

const GARDSSALG_WEBSITE_VERIFICATION_BASE_SQL =
  `(producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')`;

const GS_WV_SCOPE_SQL: Record<GsWvScope, string> = {
  visible: `${GARDSSALG_WEBSITE_VERIFICATION_BASE_SQL} AND (catalog_hidden IS NULL OR catalog_hidden != 1)`,
  hidden: `${GARDSSALG_WEBSITE_VERIFICATION_BASE_SQL} AND catalog_hidden = 1`,
  all: GARDSSALG_WEBSITE_VERIFICATION_BASE_SQL,
};

export function loadGardssalgWebsiteVerificationCohort(
  db: Database.Database,
  scope: GsWvScope = "visible"
): GsWvProducerRow[] {
  return db
    .prepare(
      `SELECT id, navn, hjemmeside, org_nr, kommune, poststed, telefon, mobil, adresse, postnummer, catalog_hidden
         FROM experience_providers
        WHERE ${GS_WV_SCOPE_SQL[scope]}`
    )
    .all() as GsWvProducerRow[];
}

// ─── Classification (pure decision + one injected fetch) ───────────────────

/**
 * Classify ONE producer's hjemmeside. Never throws: a fetch failure/timeout
 * (fetchFn resolving `{ok:false}`) classifies as "unverified" with
 * `evidence: null` — fail into the safer/more-conservative bucket, matching
 * the rest of the spec's fail-closed philosophy, rather than propagating the
 * failure to the caller.
 */
export async function classifyGardssalgProducerWebsite(
  producer: GsWvProducerRow,
  fetchFn: GsWvFetchFn
): Promise<GsWvScanRow> {
  const hjemmeside = producer.hjemmeside && producer.hjemmeside.trim() !== "" ? producer.hjemmeside.trim() : null;

  if (!hjemmeside) {
    return { provider_id: producer.id, name: producer.navn, hjemmeside: null, classification: "missing_source", evidence: null };
  }

  const host = hostFromUrlLike(hjemmeside);
  if (host && isDirectoryOrAggregatorHost(host)) {
    // Funn 4: a directory/aggregator/DMO host is never ownership evidence,
    // domain-only is explicitly insufficient per this dev-request — and the
    // task spec is explicit this case must NOT fetch the page at all.
    return { provider_id: producer.id, name: producer.navn, hjemmeside, classification: "aggregator", evidence: null };
  }

  let fetched: GsWvFetchResult;
  try {
    fetched = await fetchFn(hjemmeside);
  } catch {
    // fetchFn's own contract (see crFetchGardssalgContent) never throws in
    // practice, but this module treats a throw exactly like a reported
    // failure — fail-closed either way, never an uncaught rejection.
    fetched = { ok: false, reason: "fetch_threw" };
  }
  if (!fetched.ok) {
    return { provider_id: producer.id, name: producer.navn, hjemmeside, classification: "unverified", evidence: null };
  }

  const evidence = gardssalgWebsiteEvidenceMatch(fetched.pageText, {
    orgNr: producer.org_nr,
    navn: producer.navn,
    kommune: producer.kommune,
    poststed: producer.poststed,
    telefon: producer.telefon,
    mobil: producer.mobil,
    adresse: producer.adresse,
    postnummer: producer.postnummer,
  });

  // Strict boolean comparison (never a bare `if (evidence.verified)` /
  // truthy check) — deliberate, see this module's own test coverage: wiring
  // this any other way is exactly the kind of silent-weakening bug the
  // 2026-08-01 Steg 2 incident (six review rounds, one under-tested matcher)
  // is why this slice's tests specifically probe for it.
  return {
    provider_id: producer.id,
    name: producer.navn,
    hjemmeside,
    classification: evidence.verified === true ? "verified" : "unverified",
    evidence,
  };
}

/** Bulk classification over an already-loaded producer list, bounded
 *  concurrency (caller supplies the concurrency — routes/opplevelser.ts
 *  reuses its own CR_CONCURRENCY constant so every gårdssalg sweep in this
 *  file shares one throttle). Order of `rows` matches `producers`. */
export async function scanGardssalgWebsiteVerificationRows(
  producers: GsWvProducerRow[],
  fetchFn: GsWvFetchFn,
  concurrency = 3
): Promise<{ summary: GsWvSummary; rows: GsWvScanRow[] }> {
  const rows: GsWvScanRow[] = [];
  const step = Math.max(1, concurrency);
  for (let i = 0; i < producers.length; i += step) {
    const slice = producers.slice(i, i + step);
    const results = await Promise.all(slice.map((p) => classifyGardssalgProducerWebsite(p, fetchFn)));
    rows.push(...results);
  }
  return { summary: summarizeGardssalgWebsiteVerification(rows), rows };
}

export function summarizeGardssalgWebsiteVerification(rows: GsWvScanRow[]): GsWvSummary {
  const summary: GsWvSummary = { verified: 0, unverified: 0, aggregator: 0, missing_source: 0, total: rows.length };
  for (const r of rows) summary[r.classification]++;
  return summary;
}

/** Full Part A pass: load the whole cohort fresh from the DB and classify
 *  every row. Pure read on the DB side (the only non-pure part is the
 *  injected fetchFn, which the caller controls) — never writes anything. */
export async function runGardssalgWebsiteVerificationScan(
  db: Database.Database,
  fetchFn: GsWvFetchFn,
  concurrency = 3,
  scope: GsWvScope = "visible"
): Promise<{ summary: GsWvSummary; rows: GsWvScanRow[] }> {
  const producers = loadGardssalgWebsiteVerificationCohort(db, scope);
  return scanGardssalgWebsiteVerificationRows(producers, fetchFn, concurrency);
}

// ─── Plan (Part B — read-only) ──────────────────────────────────────────────

/**
 * Candidates for the review queue: "unverified" rows ONLY. "aggregator" rows
 * are deliberately NOT enqueued here — that is what the existing, separate
 * POST /admin/gardssalg-website-discovery endpoint is for (finding a
 * REPLACEMENT url); this sweep never duplicates that job, it only reports
 * that the current hjemmeside couldn't be confirmed to belong to the
 * producer.
 */
export function planGardssalgWebsiteVerificationRemediation(
  rows: GsWvScanRow[]
): { wouldEnqueue: GsWvScanRow[] } {
  return { wouldEnqueue: rows.filter((r) => r.classification === "unverified") };
}

// ─── Apply (Part B — write) ─────────────────────────────────────────────────

export interface GsWvApplyResult {
  provider_id: string;
  classification: GsWvClassification;
  enqueued: boolean;
}

/**
 * Apply a previously-scanned set of rows (ALL classifications, not just
 * "unverified" — every row gets a field_provenance stamp so a caller can
 * tell "checked and it's fine" apart from "never checked").
 *
 * For every row: read-modify-write the `hjemmeside_verification` key of
 * experience_providers.field_provenance (a NEW key — never touches the
 * existing `hjemmeside` key, which tracks where the URL value itself came
 * from, not whether it has since been verified), and insert exactly ONE
 * gardssalg_website_verification_audit row (insert-only) per write.
 *
 * Additionally, for "unverified" rows only: upsert
 * gardssalg_website_review_queue with reason "verification_failed" — SKIPPED
 * if the provider already has a pending queue row with the SAME
 * reason+candidate_url (idempotent re-run: a re-scan that reaches the same
 * conclusion must not just keep bumping updated_at/duplicating queue churn).
 * gardssalg_website_review_queue has UNIQUE(provider_id), so a DIFFERENT
 * pending reason/url for the same provider (e.g. a stale
 * website_discovery_candidate row) is legitimately overwritten by the
 * upsert — that is the existing table's own established refresh-on-rerun
 * contract (see upsertGardssalgWebsiteReviewQueue's doc comment), unchanged
 * by this slice.
 */
export function applyGardssalgWebsiteVerification(
  db: Database.Database,
  rows: GsWvScanRow[],
  batchId: string | null
): { applied: GsWvApplyResult[] } {
  const applied: GsWvApplyResult[] = [];
  const checkedAt = new Date().toISOString();
  const existingQueueByProvider = new Map(listGardssalgWebsiteReviewQueue().map((q) => [q.provider_id, q]));

  const runOne = db.transaction((row: GsWvScanRow) => {
    const providerRow = db
      .prepare(`SELECT field_provenance FROM experience_providers WHERE id = ?`)
      .get(row.provider_id) as { field_provenance: string | null } | undefined;
    if (!providerRow) return; // provider vanished mid-run (deleted) -> nothing to stamp

    let provenance: Record<string, unknown> = {};
    if (providerRow.field_provenance) {
      try {
        const parsed = JSON.parse(providerRow.field_provenance);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          provenance = parsed as Record<string, unknown>;
        }
      } catch {
        /* malformed existing JSON -> treat as empty rather than clobber the write */
      }
    }

    const verified = row.classification === "verified";
    const entry: Record<string, unknown> = {
      verified,
      classification: row.classification,
      checked_at: checkedAt,
    };
    // "omit if classification is aggregator/missing_source" (task spec) —
    // neither of those ever fetched a page, so there is no evidence object
    // to attach.
    if ((row.classification === "verified" || row.classification === "unverified") && row.evidence) {
      entry.evidence = row.evidence;
    }
    provenance.hjemmeside_verification = entry;

    db.prepare(
      `UPDATE experience_providers SET field_provenance = @field_provenance, updated_at = datetime('now') WHERE id = @id`
    ).run({ id: row.provider_id, field_provenance: JSON.stringify(provenance) });

    db.prepare(
      `INSERT INTO gardssalg_website_verification_audit
         (id, provider_id, classification, verified, evidence, batch_id, checked_at)
       VALUES (@id, @provider_id, @classification, @verified, @evidence, @batch_id, @checked_at)`
    ).run({
      id: uuid(),
      provider_id: row.provider_id,
      classification: row.classification,
      verified: verified ? 1 : 0,
      evidence: row.evidence ? JSON.stringify(row.evidence) : null,
      batch_id: batchId,
      checked_at: checkedAt,
    });

    let enqueued = false;
    if (row.classification === "unverified" && row.hjemmeside) {
      const existing = existingQueueByProvider.get(row.provider_id);
      const alreadyQueuedSame =
        !!existing && existing.reason === "verification_failed" && existing.candidate_url === row.hjemmeside;
      if (!alreadyQueuedSame) {
        upsertGardssalgWebsiteReviewQueue({
          provider_id: row.provider_id,
          provider_name: row.name,
          candidate_url: row.hjemmeside,
          evidence: row.evidence ? JSON.stringify(row.evidence) : null,
          reason: "verification_failed",
          batch_id: batchId,
        });
        enqueued = true;
      }
    }

    applied.push({ provider_id: row.provider_id, classification: row.classification, enqueued });
  });

  for (const row of rows) runOne(row);

  return { applied };
}
