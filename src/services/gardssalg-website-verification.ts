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
//   missing_source — blank/null hjemmeside AND no evidence_url candidate
//                     promoted (Skive 1, dev-request 2026-08-17-berikelse-
//                     uttrekk-evidence-url-og-render): when hjemmeside is
//                     blank, a candidate evidence_url may still be tried —
//                     see classifyGardssalgProducerWebsiteViaEvidenceUrl
//                     Candidate — but anything short of a full ownership-
//                     evidence pass on that candidate still lands here.
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
import type { FetchPersistence } from "./fetch-page";
// Type-only: this module still performs no fetching and no rendering of its
// own — it only carries the caller's escalation record through to its rows.
import type { RenderEscalationDiagnostic } from "./render-page";
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
  /**
   * Skive 1 (dev-request 2026-08-17-berikelse-uttrekk-evidence-url-og-render):
   * the SAME candidate `selectProvidersForContentRefresh` (experience-store.ts)
   * would fall back to — the first non-empty `experiences.evidence_url` for
   * this provider, via the identical predicate/ordering (TRIM'd, non-empty,
   * `LIMIT 1`, no explicit ORDER BY — whatever row SQLite returns first).
   * Only ever populated when the producer's OWN `hjemmeside` is blank (see
   * the SELECT below); classifyGardssalgProducerWebsite only ever looks at
   * this when `hjemmeside` is null, so the two systems agree on "the
   * candidate" by construction, not by convention.
   */
  evidence_url_candidate?: string | null;
}

/**
 * `unreachable_transient` (Daniel, live session 2026-08-13) is NOT a verdict
 * about the producer — it means we could not reach the site THIS RUN.
 *
 * Before it existed, every fetch failure collapsed into `unverified`, which
 * applyGardssalgWebsiteVerification then wrote durably as
 * `hjemmeside_verification = {verified:false}`. Measured on the 2026-08-13
 * remediation run over the 15 `nettsted_uverifisert` rows: Tromsø
 * Mikrobryggeri's `bryggeri13.no` answered HTTP 5xx — a transient blip — and
 * was permanently recorded as an unverified website, indistinguishable
 * afterwards from a producer whose page genuinely carries no ownership
 * evidence. That is the exact failure the doc comment in routes/opplevelser.ts
 * (~line 10240) already described as live.
 *
 * `permanent`/`blocked` failures (dns_not_found, 404, 401 …) keep collapsing
 * into `unverified` deliberately: a dead domain IS a statement about the
 * stored URL, and queuing it for review is the correct remedy. Only
 * `transient` is exempt.
 */
export type GsWvClassification =
  | "verified"
  | "unverified"
  | "aggregator"
  | "missing_source"
  | "unreachable_transient";

export type GsWvEvidence = ReturnType<typeof gardssalgWebsiteEvidenceMatch>;

export interface GsWvScanRow {
  provider_id: string;
  name: string;
  hjemmeside: string | null;
  classification: GsWvClassification;
  evidence: GsWvEvidence | null;
  /**
   * How many characters of visible text gardssalgWebsiteEvidenceMatch was
   * actually given. Diagnostic only — nothing downstream branches on it, and
   * applyGardssalgWebsiteVerification never writes it to provenance (a
   * measurement is not a verdict).
   *
   * Present only when a page was really fetched: `aggregator` and
   * `missing_source` never fetch, `unreachable_transient` never got a page.
   *
   * Why it earns a field: an `unverified` row is otherwise indistinguishable
   * between "we read the whole site and it names no owner" and "we judged it
   * on 19 characters because the content only exists after JavaScript runs".
   * That is the 67 North case (Daniel, 2026-08-15), and it was invisible from
   * this route's output — the exact place an operator looks first.
   */
  page_chars?: number;
  /**
   * What the caller's headless escalation did on the fetch behind this row —
   * passed straight through from GsWvFetchResult, never interpreted here.
   *
   * This module is the ONLY gårdssalg path that fetches rows which are not
   * yet ownership-verified (content-refresh excludes them by design, see
   * isHjemmesideVerified), so a JS-built producer site can only ever be
   * rendered HERE. Reporting it anywhere else would report it for every row
   * except the ones it exists for.
   */
  render_diagnostic?: RenderEscalationDiagnostic;
  /**
   * Skive 1 (dev-request 2026-08-17-berikelse-uttrekk-evidence-url-og-render):
   * set ONLY when this row is a promotion — the producer's own `hjemmeside`
   * was blank, a candidate evidence_url was fetched instead, and it passed
   * gardssalgWebsiteEvidenceMatch (classification === "verified" in this
   * case). Carries the candidate URL through to applyGardssalgWebsiteVerification,
   * which is the one place in this file that ever WRITES
   * experience_providers.hjemmeside — every other row here only ever touches
   * field_provenance/audit tables. Absent (not merely false) on every other
   * row, including a normal own-hjemmeside "verified" row, which must NOT
   * re-write hjemmeside (a no-op today, and must stay one).
   */
  promoted_from_evidence_url?: string;
}

export interface GsWvSummary {
  verified: number;
  unverified: number;
  aggregator: number;
  missing_source: number;
  /** Could not be reached this run. Nothing was recorded about these rows. */
  unreachable_transient: number;
  total: number;
}

// Adapter the route wires to crFetchGardssalgContent + gardssalgPageText —
// this module never calls fetch/network code itself, only this contract.
// `reason` is carried through for observability but not currently surfaced
// on the row (classification alone drives all downstream behaviour).
//
// `title` (AC4, dev-request 2026-08-02-enrichment-kadens-og-kildekvalitet):
// the fetched page's <title> text, already run through gardssalgPageTitle by
// the route (the SAME place pageText is already run through gardssalgPageText
// today) — optional so an existing/simpler fetchFn still type-checks; omitting
// it just means gardssalgWebsiteEvidenceMatch never sees a title source for
// that call (see its own doc comment for exactly what that does and doesn't
// change).
export type GsWvFetchResult =
  | {
      ok: true;
      pageText: string;
      title?: string;
      /**
       * Optional escalation record from the adapter's own fetcher. Carried to
       * GsWvScanRow.render_diagnostic untouched — this module never reads a
       * field of it and nothing here branches on it.
       */
      render?: RenderEscalationDiagnostic;
    }
  | {
      ok: false;
      reason: string;
      /**
       * fetch-page.ts's persistence class, passed straight through. Optional
       * so an existing/simpler fetchFn still type-checks — an adapter that
       * omits it keeps the old fail-closed behaviour (treated as a real
       * negative), which is the safe default for a caller that cannot tell
       * the difference. Only an explicit "transient" earns the exemption.
       */
      persistence?: FetchPersistence;
    };
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

// ─── Cohort axis (Steg 2, dev-request 2026-08-02-opplevagent-hjemmeside
// verifisering-og-enrichment-gate) ──────────────────────────────────────────
//
// A SEPARATE, independent axis from `scope` above. `scope` decides WHICH
// visibility slice of a cohort to look at (visible/hidden/all-visibility);
// `cohort` decides WHICH producer types are IN the cohort at all
// (gårdssalg-only vs. every experience_providers row, platform-wide). The two
// are orthogonal and compose freely — do not conflate "cohort=all" with
// "scope=all"; they mean entirely different things.
//
//   gardssalg (default) — today's existing cohort: producer_type IS NOT NULL
//     OR rfb_seed_source = 'rfb-seed'. Every existing caller who never passes
//     `cohort` gets exactly this, unchanged.
//   all — the producer-type restriction is DROPPED entirely: every row in
//     experience_providers is a candidate, platform-wide. This is
//     substantially larger (experience_providers plausibly holds 1000+ rows
//     platform-wide, vs. today's ~87-row gårdssalg cohort) — callers on this
//     cohort MUST paginate (see MAX_GARDSSALG_AUDIT_LIMIT enforcement at the
//     route layer, which makes `limit` mandatory whenever cohort=all).
//   non_gardssalg (dev-request 2026-08-14-exp-website-verification-stamp) —
//     the exact COMPLEMENT of `gardssalg`: producer_type IS NULL AND
//     rfb_seed_source is not 'rfb-seed'. Added because the generic (non-
//     gårdssalg) experiences content-refresh path (POST /admin/content-refresh,
//     routes/opplevelser.ts) gates every provider on isHjemmesideVerified(
//     field_provenance) — the SAME stamp this file's applyGardssalgWebsite
//     Verification writes — but nothing ever swept the non-gårdssalg
//     population to produce that stamp: the fleet's routine sweep of this
//     vertical always ran with the default cohort=gardssalg, so every
//     generic provider's field_provenance.hjemmeside_verification stayed
//     permanently absent and isHjemmesideVerified() failed closed on all of
//     them (measured: the generic content-refresh selector's own report
//     shows scanned=0 candidates). `cohort=all` already technically reaches
//     these rows too (it is the union of `gardssalg` and `non_gardssalg`),
//     but a routine sweep on `all` would also re-classify the entire
//     gårdssalg cohort on every tick — wasted outbound fetches against
//     producers this vertical already tracks on its own outreach-driven
//     cadence. `non_gardssalg` lets a sweep target exactly the previously-
//     uncovered population without re-touching gårdssalg rows at all.
//     Classification/fetch/write mechanics are 100% unchanged — this is a
//     new SQL predicate only, nothing else in this file branches on it.
export type GsWvCohort = "gardssalg" | "all" | "non_gardssalg";

export const GS_WV_COHORTS: readonly GsWvCohort[] = ["gardssalg", "all", "non_gardssalg"] as const;

// The `producer_type != 'test-gardssalg'` leg is the SAME exclusion every
// other gårdssalg selector in this codebase already carries (experience-store
// .ts's listing/count queries, gardssalg-experience-conflict.ts's scan cohort,
// the outreach-readiness route) — this file was written without it. The row it
// excludes is the single synthetic provider POST /admin/gardssalg/test-provider
// upserts: it is not a real producer, so a fetch against its (deliberately
// non-resolving) hjemmeside would file a bogus `verification_failed` entry in
// the very review queue this vertical is trying to drive to empty. Null-safe
// form for the same reason as the catalog_hidden clause below — a bare `!=`
// would drop every producer_type IS NULL row too. This exclusion is
// UNCONDITIONAL — it applies to BOTH cohorts, since it is about a synthetic
// test fixture, not about which cohort is selected.
const GS_WV_TEST_GARDSSALG_EXCLUSION_SQL = `(producer_type IS NULL OR producer_type != 'test-gardssalg')`;

// The gårdssalg producer-type restriction — dropped entirely for cohort=all.
const GS_WV_GARDSSALG_PRODUCER_TYPE_SQL = `(producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')`;

// The exact complement of GS_WV_GARDSSALG_PRODUCER_TYPE_SQL above — written
// out explicitly rather than as `NOT (${GS_WV_GARDSSALG_PRODUCER_TYPE_SQL})`.
// SQL three-valued logic makes that naive negation wrong: for a row with
// producer_type IS NULL and rfb_seed_source IS NULL, the gårdssalg predicate
// evaluates `FALSE OR NULL` = NULL (not FALSE, since `rfb_seed_source =
// 'rfb-seed'` against a NULL column is NULL, not FALSE), and NOT(NULL) is
// itself NULL, which a WHERE clause treats as excluding the row — silently
// dropping exactly the rows this cohort exists to include (the common case:
// a generic provider with neither column ever set). Same null-safe-form
// discipline as GS_WV_TEST_GARDSSALG_EXCLUSION_SQL/GS_WV_SCOPE_ONLY_SQL.visible
// above — this file has already been burned once by a bare `!=`/negation
// silently eating NULL rows.
const GS_WV_NON_GARDSSALG_PRODUCER_TYPE_SQL = `(producer_type IS NULL AND (rfb_seed_source IS NULL OR rfb_seed_source != 'rfb-seed'))`;

const GS_WV_COHORT_SQL: Record<GsWvCohort, string> = {
  gardssalg: `${GS_WV_GARDSSALG_PRODUCER_TYPE_SQL} AND ${GS_WV_TEST_GARDSSALG_EXCLUSION_SQL}`,
  all: GS_WV_TEST_GARDSSALG_EXCLUSION_SQL,
  // non_gardssalg needs no separate test-gardssalg exclusion term: that
  // synthetic row's producer_type is 'test-gardssalg' (NOT NULL), so the
  // predicate above already excludes it on its own — same end state as the
  // other two cohorts, reached structurally rather than by an extra AND leg.
  non_gardssalg: GS_WV_NON_GARDSSALG_PRODUCER_TYPE_SQL,
};

const GS_WV_SCOPE_ONLY_SQL: Record<GsWvScope, string> = {
  visible: `(catalog_hidden IS NULL OR catalog_hidden != 1)`,
  hidden: `catalog_hidden = 1`,
  all: `1=1`,
};

export function loadGardssalgWebsiteVerificationCohort(
  db: Database.Database,
  scope: GsWvScope = "visible",
  cohort: GsWvCohort = "gardssalg"
): GsWvProducerRow[] {
  const whereSql = `${GS_WV_COHORT_SQL[cohort]} AND ${GS_WV_SCOPE_ONLY_SQL[scope]}`;
  return db
    .prepare(
      `SELECT id, navn, hjemmeside, org_nr, kommune, poststed, telefon, mobil, adresse, postnummer, catalog_hidden,
              -- Skive 1 (dev-request 2026-08-17-berikelse-uttrekk-evidence-url-
              -- og-render): the IDENTICAL correlated-subquery fragment
              -- selectProvidersForContentRefresh (experience-store.ts) already
              -- uses for its own COALESCE fallback — copied verbatim rather
              -- than shared, so the two systems agree on "the candidate" by
              -- construction. Computed for every row (cheap, indexed on
              -- provider_id); classifyGardssalgProducerWebsite only ever
              -- consults it when hjemmeside is itself blank.
              (SELECT TRIM(e2.evidence_url) FROM experiences e2
                WHERE e2.provider_id = experience_providers.id
                  AND e2.evidence_url IS NOT NULL AND TRIM(e2.evidence_url) != ''
                LIMIT 1) AS evidence_url_candidate
         FROM experience_providers
        WHERE ${whereSql}
        ORDER BY id`
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
    // Skive 1 (dev-request 2026-08-17-berikelse-uttrekk-evidence-url-og-
    // render, Funn 1): before giving up as missing_source, try the SAME
    // evidence_url candidate selectProvidersForContentRefresh would fall
    // back to. This is the ONLY extension to the "blank hjemmeside" path —
    // everything below runs the exact same ownership-evidence machinery as
    // a producer's own hjemmeside, just against a different candidate URL.
    return classifyGardssalgProducerWebsiteViaEvidenceUrlCandidate(producer, fetchFn);
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
    // A site we could not reach this run is not a producer we have judged.
    // See GsWvClassification's doc comment for the measured incident.
    const classification: GsWvClassification =
      fetched.persistence === "transient" ? "unreachable_transient" : "unverified";
    return { provider_id: producer.id, name: producer.navn, hjemmeside, classification, evidence: null };
  }

  const evidence = gardssalgWebsiteEvidenceMatch(
    fetched.pageText,
    {
      orgNr: producer.org_nr,
      navn: producer.navn,
      kommune: producer.kommune,
      poststed: producer.poststed,
      telefon: producer.telefon,
      mobil: producer.mobil,
      adresse: producer.adresse,
      postnummer: producer.postnummer,
    },
    fetched.title
  );

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
    // Diagnostics, attached on the one path that actually read a page. Both
    // are pass-through/measurement — see their doc comments on GsWvScanRow.
    page_chars: fetched.pageText.length,
    ...(fetched.render ? { render_diagnostic: fetched.render } : {}),
  };
}

/**
 * Skive 1 (dev-request 2026-08-17-berikelse-uttrekk-evidence-url-og-render,
 * Funn 1): the "own hjemmeside is blank" path. Attempts the SAME evidence_url
 * candidate selectProvidersForContentRefresh (experience-store.ts) would fall
 * back to (see GsWvProducerRow.evidence_url_candidate — loaded by the
 * identical SQL fragment), running it through the identical ownership-
 * evidence check used for a producer's own site. Fail-closed in every
 * direction, same as classifyGardssalgProducerWebsite's own contract: a
 * throw from fetchFn on the candidate must not propagate.
 *
 * Rules (dev-request spec, Skive 1):
 *   1. No candidate at all -> missing_source, unchanged from before this
 *      slice existed.
 *   2. Candidate resolves to a directory/aggregator host -> never fetched,
 *      missing_source (a directory host is never ownership evidence, same
 *      principle as the own-hjemmeside "aggregator" bucket — but this stays
 *      missing_source rather than "aggregator" since the producer's OWN
 *      hjemmeside really is still blank).
 *   3. Candidate fetched (fetch fails OR evidence doesn't match) -> NOTHING
 *      happens: missing_source, deliberately NOT unverified — an
 *      `unverified` classification enqueues a review-queue entry in
 *      applyGardssalgWebsiteVerification, and a random evidence_url that
 *      doesn't match this producer does not deserve one (only a producer's
 *      OWN declared, non-matching hjemmeside does). No page_chars/evidence
 *      recorded either — missing_source stays uniformly "never fetched
 *      anything worth reporting" regardless of which leg produced it.
 *   4. Candidate fetched AND verified -> "verified", with
 *      `promoted_from_evidence_url` set so applyGardssalgWebsiteVerification
 *      can promote the candidate to hjemmeside.
 */
async function classifyGardssalgProducerWebsiteViaEvidenceUrlCandidate(
  producer: GsWvProducerRow,
  fetchFn: GsWvFetchFn
): Promise<GsWvScanRow> {
  const missingSource: GsWvScanRow = {
    provider_id: producer.id,
    name: producer.navn,
    hjemmeside: null,
    classification: "missing_source",
    evidence: null,
  };

  const candidate =
    producer.evidence_url_candidate && producer.evidence_url_candidate.trim() !== ""
      ? producer.evidence_url_candidate.trim()
      : null;
  if (!candidate) return missingSource; // Rule 1

  const host = hostFromUrlLike(candidate);
  if (host && isDirectoryOrAggregatorHost(host)) return missingSource; // Rule 2 — never fetched

  let fetched: GsWvFetchResult;
  try {
    fetched = await fetchFn(candidate);
  } catch {
    // Same fail-closed treatment as classifyGardssalgProducerWebsite's own
    // catch block: a throwing fetchFn is indistinguishable from {ok:false}.
    fetched = { ok: false, reason: "fetch_threw" };
  }
  if (!fetched.ok) return missingSource; // Rule 3 — fetch failure leg

  const evidence = gardssalgWebsiteEvidenceMatch(
    fetched.pageText,
    {
      orgNr: producer.org_nr,
      navn: producer.navn,
      kommune: producer.kommune,
      poststed: producer.poststed,
      telefon: producer.telefon,
      mobil: producer.mobil,
      adresse: producer.adresse,
      postnummer: producer.postnummer,
    },
    fetched.title
  );

  // Strict boolean comparison — same discipline classifyGardssalgProducer
  // Website's own comment calls out on its equivalent line.
  if (evidence.verified !== true) return missingSource; // Rule 3 — evidence-mismatch leg

  // Rule 4 — promotion.
  return {
    provider_id: producer.id,
    name: producer.navn,
    hjemmeside: candidate,
    classification: "verified",
    evidence,
    promoted_from_evidence_url: candidate,
    page_chars: fetched.pageText.length,
    ...(fetched.render ? { render_diagnostic: fetched.render } : {}),
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
  const summary: GsWvSummary = {
    verified: 0,
    unverified: 0,
    aggregator: 0,
    missing_source: 0,
    unreachable_transient: 0,
    total: rows.length,
  };
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
  scope: GsWvScope = "visible",
  cohort: GsWvCohort = "gardssalg"
): Promise<{ summary: GsWvSummary; rows: GsWvScanRow[] }> {
  const producers = loadGardssalgWebsiteVerificationCohort(db, scope, cohort);
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
  /**
   * Skive 1: true when this row's `hjemmeside` was actually written this run
   * (the promotion happened AND the defensive re-check found it still blank
   * at apply time). Observability only — a promotion row whose write raced
   * and was skipped still gets its field_provenance/audit stamp (see
   * applyGardssalgWebsiteVerification's own doc comment), so this flag is
   * the one place to see whether the hjemmeside column itself changed.
   */
  promoted?: boolean;
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
 *
 * Skive 1 (dev-request 2026-08-17-berikelse-uttrekk-evidence-url-og-render):
 * a row carrying `promoted_from_evidence_url` is the ONE case in this whole
 * function that ever writes `experience_providers.hjemmeside` itself —
 * everywhere else this function only ever touches field_provenance/audit.
 * Guarded by a defensive re-read of hjemmeside at apply time: if it is no
 * longer blank (a race between scan and apply — e.g. a concurrent write, or
 * the same producer scanned twice in one batch), the hjemmeside write is
 * skipped, but field_provenance/audit are still stamped exactly as if the
 * write had happened (the candidate DID pass ownership verification; that
 * fact doesn't depend on which value ended up winning the race).
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
      .prepare(`SELECT field_provenance, hjemmeside FROM experience_providers WHERE id = ?`)
      .get(row.provider_id) as { field_provenance: string | null; hjemmeside: string | null } | undefined;
    if (!providerRow) return; // provider vanished mid-run (deleted) -> nothing to stamp

    // A transient unreachability is not a finding about the producer, so it
    // must leave NO durable trace that any downstream gate could read as one:
    // no provenance stamp (isHjemmesideVerified gates the content step on it),
    // no review-queue entry, no audit row claiming verified=0. The row is left
    // exactly as it was for the next run to judge properly. Recorded in
    // `applied` so the caller can still see it was attempted and skipped.
    if (row.classification === "unreachable_transient") {
      applied.push({ provider_id: row.provider_id, classification: row.classification, enqueued: false });
      return;
    }

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

    // Skive 1: this row's hjemmeside was promoted from an evidence_url
    // candidate rather than being the producer's own already-stored value.
    // The marker is stamped regardless of whether the hjemmeside write below
    // actually happens (see the defensive re-check) — it records what the
    // candidate proved, not which value won a scan/apply race.
    const isPromotion = row.classification === "verified" && !!row.promoted_from_evidence_url;
    if (isPromotion) {
      entry.source = "promoted_from_evidence_url";
    }
    provenance.hjemmeside_verification = entry;

    // Defensive re-check (spec): only write hjemmeside if it is STILL blank
    // at apply time — a scan can be minutes old by the time apply runs, and
    // this is the only path in this file that ever writes hjemmeside itself.
    const stillBlank = isPromotion && (!providerRow.hjemmeside || providerRow.hjemmeside.trim() === "");
    if (stillBlank) {
      db.prepare(
        `UPDATE experience_providers SET field_provenance = @field_provenance, hjemmeside = @hjemmeside, updated_at = datetime('now') WHERE id = @id`
      ).run({
        id: row.provider_id,
        field_provenance: JSON.stringify(provenance),
        hjemmeside: row.promoted_from_evidence_url,
      });
    } else {
      db.prepare(
        `UPDATE experience_providers SET field_provenance = @field_provenance, updated_at = datetime('now') WHERE id = @id`
      ).run({ id: row.provider_id, field_provenance: JSON.stringify(provenance) });
    }

    db.prepare(
      `INSERT INTO gardssalg_website_verification_audit
         (id, provider_id, classification, verified, evidence, batch_id, checked_at, promoted_from_evidence_url)
       VALUES (@id, @provider_id, @classification, @verified, @evidence, @batch_id, @checked_at, @promoted_from_evidence_url)`
    ).run({
      id: uuid(),
      provider_id: row.provider_id,
      classification: row.classification,
      verified: verified ? 1 : 0,
      evidence: row.evidence ? JSON.stringify(row.evidence) : null,
      batch_id: batchId,
      checked_at: checkedAt,
      // Independently auditable regardless of the defensive-recheck outcome
      // above — see this function's own doc comment.
      promoted_from_evidence_url: isPromotion ? row.promoted_from_evidence_url : null,
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

    applied.push({
      provider_id: row.provider_id,
      classification: row.classification,
      enqueued,
      ...(isPromotion ? { promoted: stillBlank } : {}),
    });
  });

  for (const row of rows) runOne(row);

  return { applied };
}
