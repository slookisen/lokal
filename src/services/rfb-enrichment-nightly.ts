// ─── RFB enrichment — the nightly server job (R6) ───────────────────────────
//
// dev-request 2026-10-10-rfb-berikelse-nattjobb (A2A; Daniel GO 2026-10-10,
// amended live 2026-10-11 — daniel-responses/2026-10-11-live-go-rfb-kilder-
// r6-m03-dagstak-10.md: add the Brreg contact step and the Bondens Marked
// step, build in the session, flag may go on before 16.10).
//
// About 730 RFB producers have never been contacted and most of them lack
// data the outreach pool requires (e-mail, a website that answers, enough
// content). The tools that can fetch that data already exist as admin routes,
// but nothing runs them. This job runs them, a little each night, and then
// re-verifies what it changed. It adds NO new write path and lowers NO gate:
// every write goes through the existing tool's own guards (syntax, platform
// domain, LLM gate, claimed/curated locks, fill-only, review queues), and the
// verifier then decides exactly as before. It never sends anything.
//
// Steps, in order, each with its own cap (env, start values from the spec):
//   1  url_check            probeAgentUrl + applyUrlProbeResult (the boot
//                           url-backfill's own path) for cohort rows with a
//                           homepage whose probe is missing or > 30 days old.
//   2  email_domain_website the producer's own e-mail domain (not free-mail,
//                           not umbrella/paraply, not ours) as a website
//                           candidate for rows without k.website, through
//                           evaluateRfbWebsiteCandidate — the external-
//                           candidate intake of POST /admin/rfb-website-
//                           discovery. Queue only (agents_website_review_
//                           queue, reason email_domain_candidate); approval
//                           is unchanged (auto >= 0.95, else judge/human).
//   2b brreg_contact        POST /admin/rfb-brreg-selfsufficiency, in process,
//                           one row per call (strict org_nr write bar, LLM
//                           gate for e-mail — unchanged).
//   2c bm_harvest           GET /admin/bm-producer-harvest?dry_run=false, in
//                           process, over a rotating slug window (`offset`,
//                           cursor persisted in rfb_enrichment_sweep_state),
//                           ALWAYS with fill_only=1 (never replaces a stored
//                           e-mail/phone) and scope_agent_ids = tonight's
//                           cohort (a matched producer outside it is left
//                           alone) — see buildRfbEnrichmentBmHarvestRequest.
//   3  contact_extraction   POST /admin/rfb-contact-extraction, in process,
//                           one row per call, for rows whose site answers and
//                           that have no e-mail.
//   4  content_refresh      refreshRfbCandidateHomepage (the route's own
//                           write-pause gate + target filter + per-agent body,
//                           R2 rules included) for rows whose site answers
//                           and whose content is under the pool threshold or
//                           only category names — or whose stored categories
//                           lack homepage corroboration (the outreach gate's
//                           categories_not_corroborated hold) on a homepage
//                           that is not a social/directory/aggregator host.
//                           Always with categoriesCorroborateOnly: a non-
//                           empty, uncorroborated stored category list is
//                           never replaced by the page's keyword extraction;
//                           it only gains a website_homepage source when the
//                           page supports EVERY stored category
//                           (categories_corroborated), else nothing is
//                           written for it (categories_not_supported_by_
//                           homepage) — always so on a directory/social/
//                           aggregator host or our own domain, also after a
//                           redirect, whichever rule selected the row.
//                           A row whose stored products are only category
//                           names (generic_products_only) also gets ONE
//                           model call (the gårdssalg product-name helper,
//                           retry off, counted as product-list-extractor):
//                           names found verbatim on the producer's own page
//                           replace the generic list (products_replaced →
//                           step 5); nothing usable → products_not_supported_
//                           by_homepage (stamped). Same host/ownership/theme-
//                           spam refusals and curated lock as above. No API
//                           key → the row runs without the call; LLM budget
//                           spent → the row waits for another night.
//   5  reverify             runVerifierBatch({agentIds}) with the tick path's
//                           Brreg lookup, one row per call: every row steps
//                           1–4 changed tonight first, then cohort rows whose
//                           homepage has been unreachable >= 14 days (so a
//                           Brreg konkurs/inactive verdict lands as today).
//   6  owner_refresh        ONLY with OWNER_AUTO_UPDATES_ENABLED (dev-request
//                           2026-11-01-rfb-hold-profilen-oppdatert; off = no
//                           step, no report key, no envelope claim): verified-
//                           owner profiles whose auto.updates is fill_empty /
//                           automatic — NOT the cohort below, which still
//                           leaves every owned profile out. Runs after step 5,
//                           so steps 1–5 select, write and spend exactly as
//                           before; it gets what is left of the run deadline
//                           and of tonight's LLM budget (reserved per profile
//                           like every LLM row), honours the write-pause and
//                           the 08Z ban, and stamps its rotation memory as
//                           step `owner_refresh`. What it may write and how:
//                           services/rfb-owner-refresh.ts. Its rows are not
//                           re-verified (an owned profile is no outreach
//                           candidate) and its numbers stay out of `totals`.
//
// Cohort (who the steps may pick): RFB producers that are not contacted —
// neither `already_sent` nor `already_contacted` exactly as GET /admin/pool-
// blocker-explain derives them (re-derived here as one set-based pass over
// outreach_sent_log and CRM outbound messages instead of two correlated
// subqueries per producer, which would stall the event loop; a test pins the
// two against each other) — and not umbrella, inactive/unpublished, a
// customer (customerRuleSql: claimed or verified claim), hand-curated (any
// curated_fields lock — owner portal / customer-service edits), opted out
// (the outreach gate's own definition), on the blocklist, or terminal with a
// confirmed konkurs/inactive/non-producer reason (classifyTerminalRow).
// Order: closest to the pool first (the spec's Context groups, top-down),
// then least recently attempted by that step (rfb_enrichment_nightly_
// attempts), so a row a step could not help moves to the back and is not
// re-tried by that step for RFB_ENRICHMENT_RETRY_DAYS.
//
// Load and timing guards (serverheng):
//   • Flag RFB_ENRICHMENT_NIGHTLY_ENABLED ("1"/"true"), default OFF. Off =
//     no tick is registered and an apply run is a no-op (no lock, no write,
//     no envelope). A dry run / preview still works, read-only.
//   • Never in 08:00–08:59Z: refused there, and every run's deadline ends
//     RFB_ENRICHMENT_FORBIDDEN_MARGIN before 08:00Z, checked between rows.
//   • Never concurrent with a verifier tick: the run takes the verifier's OWN
//     DB tick lock (orchestrator_locks, agent "lokal-agent-verifier-tick",
//     the same acquireLock + 50-minute staleness runVerifierTick uses). Held
//     → this tick is skipped and retried on the next one. While we hold it,
//     a verifier tick that falls inside our run skips itself as "already ran
//     this hour" — step 5 does that hour's verification work instead. The
//     lock is released at the end (only if still ours). Max runtime is
//     clamped below the staleness so it can never expire mid-run.
//   • Scheduled slot: hours RFB_ENRICHMENT_NIGHTLY_HOURS_UTC (default 00 and
//     01Z — inside the verifier's 22–06Z night, clear of the 03Z prune/WAL
//     checkpoint, the 04Z Debio sync / 04–05Z offsite backup, the 05Z
//     salgskanal sync and the 08Z send window), checked every 5 minutes so a
//     free gap between verifier ticks is always found. Once per ~day
//     (boot_job_state, restart-safe).
//   • One row at a time, a setImmediate yield before every row, bounded wall
//     clock (RFB_ENRICHMENT_MAX_RUNTIME_MINUTES, default 20). Writing steps
//     stop early enough to leave step 5 a reserve.
//   • LLM: at most RFB_ENRICHMENT_LLM_CAP (default 150) model calls per NIGHT
//     (08:00Z→08:00Z; calls already spent tonight are subtracted — the larger
//     of earlier runs' envelopes and a durable per-night counter that every
//     LLM-capable row reserves its worst case in BEFORE it starts, so a run
//     that dies mid-way still counts; unreadable → no LLM budget). A row is
//     only started if its worst case (LLM_CALLS_PER_ROW_MAX) still fits; once
//     it does not, every LLM-needing step stops for the night (no queue
//     builds up). content_refresh is the exception: its model call is per
//     row (generic products only), so only those rows wait; the step goes on
//     for the rest. Real calls are counted by the judges themselves
//     (llm-call-meter.ts) and reported with an estimated cost.
//   • One apply run per night (cron or manual), stamped the moment a run
//     takes the lock (so a run that dies still uses up the night); a manual
//     second run needs an explicit force (which never lifts the LLM cap, the
//     08Z ban or the lock).
//   • Only real per-row outcomes enter the rotation memory; transient ones
//     (timeouts, 5xx, errors, write-pause, a missing admin key, a tool's own
//     run-lock) are retried the next night.
//   • Step 1 never probes a homepage on a social/directory/aggregator host
//     (rfbWebsiteHostExclusionReason + isDirectoryOrAggregatorHost): the pool
//     view reads url_last_status alone, so such a probe could let a row pass
//     the pool's URL leg on someone else's site. Counted as
//     skipped_directory_or_social_host; the preview shows the agents.url-only
//     rows.
//   • Honours the enrichment write-pause (services/enrichment-write-pause.ts)
//     before every writing row; the verifier is exempt by that module's own
//     documented design.
//
// One run-ledger envelope per run (vertical rfb, agent rfb-enrichment-
// nightly) with a claim per step: attempted, written, rejected (+ reasons),
// LLM calls, estimated cost, re-verified, new verified, new in pool. A night
// with no run still gets ONE envelope (run-<night>-rfb-enrichment-nightly-
// no-run): `failed` when an error stopped a run before the lock, `partial`
// when the window ended without one (reason, e.g. the lock was held).
// Manual surfaces: GET /admin/rfb-enrichment-nightly/preview and POST
// /admin/rfb-enrichment-nightly/run (routes/admin-rfb-enrichment-nightly.ts).

import { getDb, isContentQualified, isOwnPlatformHomepage } from "../database/init";
import { recordRun, acquireLock, releaseLock } from "./run-ledger";
import { markJobCompleted, resolveDailyJobLastRunAt, getJobLastCompletedAt, yieldToEventLoop } from "./boot-job-gate";
import { publicListableSql } from "./agent-visibility";
import { customerRuleSql } from "./customer-rule";
import { isBlocked } from "./blocklist-service";
import { enrichmentWritePauseBlock } from "./enrichment-write-pause";
import {
  FREE_MAIL_DOMAINS,
  categoriesLackWebsiteCorroboration,
  hostFromUrlLike,
  isDirectoryOrAggregatorHost,
} from "./cross-source-validator";
import { outreachSentLogHasVerticalColumn } from "./outreach-suppression-signals";
import { createLlmCallMeter, runWithLlmCallMeter, type LlmCallMeter } from "./llm-call-meter";
import { refreshRfbCandidateHomepage } from "./rfb-marketing-daily";
import { generateGardssalgProductList, type GardssalgProductsExtractionDiagnostic } from "./gardssalg-product-list";
import type { HcrProductNamesExtractor } from "../routes/admin-knowledge";
import { classifyTerminalRow } from "../routes/admin-agents-terminal-repark";
import { productsAreGenericCategoryNames } from "../routes/admin-outreach-candidates";
import { isPlatformOwnedEmailDomain } from "../routes/admin-agents-contact-email-write";
import {
  evaluateRfbWebsiteCandidate,
  ensureRfbWebsiteReviewQueueTable,
  rfbWdExistingWebsiteHosts,
  rfbWebsiteHostExclusionReason,
  RFB_WD_HARD_CAP,
  type RfbWdFallbackCounters,
} from "../routes/admin-rfb-website-discovery";
import brregSelfSufficiencyRouter, {
  rfbBssCandidateWhereSql,
  RFB_BSS_HARD_CAP,
} from "../routes/admin-rfb-brreg-selfsufficiency";
import contactExtractionRouter, {
  rfbCxSelectSql,
  RFB_CX_ELIGIBLE_WHERE,
  RFB_CX_HARD_CAP,
} from "../routes/admin-rfb-contact-extraction";
import bmProducerHarvestRouter from "../routes/admin-bm-producer-harvest";
import {
  OWNER_REFRESH_PER_ROW_MS,
  OWNER_REFRESH_STEP,
  buildOwnerRefreshPreview,
  loadOwnerRefreshCohort,
  newOwnerRefreshStepReport,
  ownerRefreshRowLlmCallsMax,
  refreshOwnedProfile,
  resolveOwnerRefreshCap,
  tallyOwnerRefreshRow,
  type OwnerRefreshDeps,
  type OwnerRefreshPreview,
  type OwnerRefreshRowOutcome,
  type OwnerRefreshStepReport,
} from "./rfb-owner-refresh";
import { ownerAutoUpdatesEnabled } from "../owner-features/registry";
import {
  runVerifierBatch,
  resolveBrregLookup,
  probeAgentUrl,
  applyUrlProbeResult,
  emailDomain,
  isParaplyRoutedEmail,
  getAffiliatedUmbrellaDomains,
} from "../agents/lokal-agent-verifier";

type Db = ReturnType<typeof getDb>;

// ─── Knobs ─────────────────────────────────────────────────────────────────

export const RFB_ENRICHMENT_NIGHTLY_AGENT = "rfb-enrichment-nightly";
/** boot_job_state key: the durable "ran today" stamp. */
export const RFB_ENRICHMENT_NIGHTLY_JOB_STATE_KEY = "rfb-enrichment-nightly";
/** runVerifierTick's own lock key and staleness (routes/admin-run-verifier.ts). */
export const VERIFIER_TICK_LOCK_AGENT = "lokal-agent-verifier-tick";
export const VERIFIER_TICK_LOCK_STALE_MINUTES = 50;
/** The morning send window. Never run inside it. */
export const RFB_ENRICHMENT_FORBIDDEN_HOUR_UTC = 8;
/** Every deadline ends this long before 08:00Z (covers one in-flight row/call). */
export const RFB_ENRICHMENT_FORBIDDEN_MARGIN_MS = 5 * 60_000;
/** A run needs at least this much time before its deadline to start at all. */
export const RFB_ENRICHMENT_MIN_RUN_MS = 60_000;
/** Default start hours (UTC). See the header for why 00–01Z. */
export const RFB_ENRICHMENT_DEFAULT_HOURS_UTC: readonly number[] = [0, 1];
/** Start hours a run may be configured for: the verifier night 22–05Z (not 06Z). */
export const RFB_ENRICHMENT_ALLOWED_HOURS_UTC: readonly number[] = [22, 23, 0, 1, 2, 3, 4, 5];
export const RFB_ENRICHMENT_TICK_MS = 5 * 60_000;
export const RFB_ENRICHMENT_FIRST_TICK_MS = 7 * 60_000;
export const RFB_ENRICHMENT_MIN_HOURS_BETWEEN_RUNS = 20;
export const RFB_ENRICHMENT_MAX_RUNTIME_MINUTES_DEFAULT = 20;
/** Below the 50-minute lock staleness, so the lock can never expire mid-run. */
export const RFB_ENRICHMENT_MAX_RUNTIME_MINUTES_MAX = 40;
export const RFB_ENRICHMENT_RETRY_DAYS_DEFAULT = 14;
export const RFB_ENRICHMENT_LLM_CAP_DEFAULT = 150;
export const RFB_ENRICHMENT_LLM_CAP_MAX = 1000;
/** Estimate per model call (small judge prompt, <= 200 output tokens); env-overridable. */
export const RFB_ENRICHMENT_LLM_USD_PER_CALL_DEFAULT = 0.006;
/** URL probes older than this are re-probed by step 1. */
export const RFB_ENRICHMENT_URL_STALE_DAYS = 30;
/** Step 5 also takes cohort rows whose homepage has been unreachable this long. */
export const RFB_ENRICHMENT_UNREACHABLE_DAYS = 14;
/** Per-row deadline for the content refresh (same as the morning send's). */
export const RFB_ENRICHMENT_REFRESH_PER_ROW_MS = 20_000;
/** Safety timeout for one in-process route call. */
export const RFB_ENRICHMENT_ROUTE_CALL_TIMEOUT_MS = 5 * 60_000;
/** The Bondens Marked step needs this much time left to start (60 s route budget + in-flight). */
export const RFB_ENRICHMENT_BM_MIN_REMAINING_MS = 3 * 60_000;
/** Cursor key in rfb_enrichment_sweep_state. */
export const RFB_ENRICHMENT_BM_CURSOR = "bm_producer_harvest";
/** The Brreg step's "contact fetch returned nothing" outcome (a 404/410 or an outage). */
export const RFB_ENRICHMENT_BRREG_FETCH_FAILED = "brreg_contact_fetch_failed";
/** That many in a row = Brreg is down: stop the step for the night, park nobody. */
export const RFB_ENRICHMENT_BRREG_OUTAGE_STREAK = 3;
/** Queue `reason` for step 2's candidates (approval reads confidence, not reason). */
export const RFB_ENRICHMENT_EMAIL_DOMAIN_QUEUE_REASON = "email_domain_candidate";
/** content_refresh: the homepage supports every stored category; a website_homepage source was added (list unchanged). */
export const RFB_ENRICHMENT_CATEGORIES_CORROBORATED = "categories_corroborated";
/** content_refresh: a stored category is not on the homepage; nothing written for categories (a real per-row outcome). */
export const RFB_ENRICHMENT_CATEGORIES_NOT_SUPPORTED = "categories_not_supported_by_homepage";
/** content_refresh: generic stored products replaced by real names found verbatim on the producer's own page (→ step 5). */
export const RFB_ENRICHMENT_PRODUCTS_REPLACED = "products_replaced";
/** content_refresh: no usable product names on the homepage (or refused); nothing written for products (a real per-row outcome). */
export const RFB_ENRICHMENT_PRODUCTS_NOT_SUPPORTED = "products_not_supported_by_homepage";
/** content_refresh: the product-name model call failed (API/network/timeout/unparseable) / was not started (deadline) — transient, retried next night. */
export const RFB_ENRICHMENT_PRODUCTS_EXTRACTION_FAILED = "products_extraction_failed";
export const RFB_ENRICHMENT_PRODUCTS_EXTRACTION_SKIPPED = "products_extraction_skipped";

export type RfbEnrichmentStep =
  | "url_check"
  | "email_domain_website"
  | "brreg_contact"
  | "bm_harvest"
  | "contact_extraction"
  | "content_refresh"
  | "reverify";

export const RFB_ENRICHMENT_STEP_ORDER: readonly RfbEnrichmentStep[] = [
  "url_check",
  "email_domain_website",
  "brreg_contact",
  "bm_harvest",
  "contact_extraction",
  "content_refresh",
  "reverify",
];

interface CapSpec {
  env: string;
  def: number;
  max: number;
}

/** Per-step caps: env name, start value (spec / Daniel 2026-10-11), hard max (the tool's own cap). */
export const RFB_ENRICHMENT_CAP_SPECS: Readonly<Record<RfbEnrichmentStep, CapSpec>> = {
  url_check: { env: "RFB_ENRICHMENT_CAP_URL_CHECK", def: 50, max: 200 },
  email_domain_website: { env: "RFB_ENRICHMENT_CAP_EMAIL_DOMAIN_WEBSITE", def: 30, max: RFB_WD_HARD_CAP },
  brreg_contact: { env: "RFB_ENRICHMENT_CAP_BRREG", def: 25, max: RFB_BSS_HARD_CAP },
  bm_harvest: { env: "RFB_ENRICHMENT_CAP_BM_SLUGS", def: 60, max: 400 },
  contact_extraction: { env: "RFB_ENRICHMENT_CAP_CONTACT_EXTRACTION", def: 30, max: RFB_CX_HARD_CAP },
  content_refresh: { env: "RFB_ENRICHMENT_CAP_CONTENT", def: 30, max: 100 },
  reverify: { env: "RFB_ENRICHMENT_CAP_REVERIFY", def: 60, max: 100 },
};

/** Steps that write producer data (gated by the enrichment write-pause). */
const WRITING_STEPS: ReadonlySet<RfbEnrichmentStep> = new Set([
  "url_check",
  "email_domain_website",
  "brreg_contact",
  "bm_harvest",
  "contact_extraction",
  "content_refresh",
]);

export function isRfbEnrichmentNightlyEnabled(): boolean {
  const v = (process.env.RFB_ENRICHMENT_NIGHTLY_ENABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

function intEnv(name: string, def: number, min: number, max: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!/^\d+$/.test(raw)) return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

/** Per-step caps from env; unset/junk → start value; clamped to [0, the tool's own max]; 0 turns a step off. */
export function resolveRfbEnrichmentCaps(): Record<RfbEnrichmentStep, number> {
  const out = {} as Record<RfbEnrichmentStep, number>;
  for (const step of RFB_ENRICHMENT_STEP_ORDER) {
    const spec = RFB_ENRICHMENT_CAP_SPECS[step];
    out[step] = intEnv(spec.env, spec.def, 0, spec.max);
  }
  return out;
}

export function resolveRfbEnrichmentLlmCap(): number {
  return intEnv("RFB_ENRICHMENT_LLM_CAP", RFB_ENRICHMENT_LLM_CAP_DEFAULT, 0, RFB_ENRICHMENT_LLM_CAP_MAX);
}

export function resolveRfbEnrichmentMaxRuntimeMs(): number {
  return (
    intEnv(
      "RFB_ENRICHMENT_MAX_RUNTIME_MINUTES",
      RFB_ENRICHMENT_MAX_RUNTIME_MINUTES_DEFAULT,
      1,
      RFB_ENRICHMENT_MAX_RUNTIME_MINUTES_MAX,
    ) * 60_000
  );
}

export function resolveRfbEnrichmentRetryDays(): number {
  return intEnv("RFB_ENRICHMENT_RETRY_DAYS", RFB_ENRICHMENT_RETRY_DAYS_DEFAULT, 1, 90);
}

export function resolveRfbEnrichmentUsdPerCall(): number {
  const raw = (process.env.RFB_ENRICHMENT_LLM_USD_PER_CALL ?? "").trim();
  const n = Number(raw);
  if (raw === "" || !Number.isFinite(n) || n < 0 || n > 1) return RFB_ENRICHMENT_LLM_USD_PER_CALL_DEFAULT;
  return n;
}

/** RFB_ENRICHMENT_NIGHTLY_HOURS_UTC ("0,1") → allowed start hours; junk/empty → default. */
export function resolveRfbEnrichmentWindowHours(): number[] {
  const raw = (process.env.RFB_ENRICHMENT_NIGHTLY_HOURS_UTC ?? "").trim();
  if (!raw) return [...RFB_ENRICHMENT_DEFAULT_HOURS_UTC];
  const hours = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d{1,2}$/.test(s))
    .map((s) => parseInt(s, 10))
    .filter((h) => RFB_ENRICHMENT_ALLOWED_HOURS_UTC.includes(h));
  const unique = Array.from(new Set(hours));
  return unique.length > 0 ? unique : [...RFB_ENRICHMENT_DEFAULT_HOURS_UTC];
}

/**
 * Worst-case model calls ONE row of a step can make — the cap check uses this
 * before a row starts, so the real count can never pass the cap:
 *   brreg_contact / contact_extraction: gateContactCandidates with only an
 *     e-mail candidate → at most one judgeContactCandidate call.
 *   reverify: at most one second-line judge call, and only when
 *     RFB_SECOND_LINE_VERIFICATION_ENABLED is "true" (read per run).
 *   content_refresh: at most one product-list-extractor call (the gårdssalg
 *     product-name helper with its retry turned off), and only for a row
 *     whose stored products are generic category names — the per-row figure
 *     is rfbEnrichmentRowLlmCallsMax; other rows reserve nothing.
 *   everything else: deterministic, no model call.
 */
export function rfbEnrichmentLlmCallsPerRowMax(step: RfbEnrichmentStep): number {
  if (step === "brreg_contact" || step === "contact_extraction" || step === "content_refresh") return 1;
  if (step === "reverify") return process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED === "true" ? 1 : 0;
  return 0;
}

/**
 * Steps whose model call is optional per row: when tonight's LLM budget is
 * spent, only the rows that would need it are left for another night (not
 * attempted, not stamped); the step itself still runs for the others.
 */
const RFB_ENRICHMENT_LLM_OPTIONAL_STEPS: ReadonlySet<RfbEnrichmentStep> = new Set(["content_refresh"]);

/** The product-name model call needs ANTHROPIC_API_KEY; without it the step runs without that call. */
export function rfbEnrichmentProductNamesLlmAvailable(): boolean {
  return (process.env.ANTHROPIC_API_KEY ?? "").trim() !== "";
}

/** content_refresh: the row's stored products are only category names (the gate's generic_products_only). */
function rfbEnrichmentRowWantsProductNames(step: RfbEnrichmentStep, row: RfbEnrichmentCohortRow): boolean {
  return step === "content_refresh" && productsAreGenericCategoryNames(row.products);
}

/** Worst-case model calls for THIS row (the reservation): see rfbEnrichmentLlmCallsPerRowMax. */
export function rfbEnrichmentRowLlmCallsMax(step: RfbEnrichmentStep, row: RfbEnrichmentCohortRow): number {
  if (step === "content_refresh") {
    return rfbEnrichmentRowWantsProductNames(step, row) && rfbEnrichmentProductNamesLlmAvailable() ? 1 : 0;
  }
  return rfbEnrichmentLlmCallsPerRowMax(step);
}

/**
 * The real product-name extractor R6 hands to the refresh: the gårdssalg
 * helper (generateGardssalgProductList — same prompt: only names that are in
 * the source text) with its one retry OFF, so a row makes at most ONE model
 * call (its reservation), counted on the run's meter as product-list-extractor.
 *
 * A well-formed answer with no usable name — the sentinel, a literal `[]`, or
 * an array whose every entry the helper's own filter drops
 * (invalid_unparseable / empty_after_filter) — is the model's answer for THIS
 * page: `none` (→ products_not_supported_by_homepage, stamped, 14-day retry).
 * Only a failure that may not repeat (network / timeout / API error / no text
 * block / not JSON / not an array) is `failed` (transient, retried next night).
 */
export const rfbEnrichmentProductNameExtractor: HcrProductNamesExtractor = async (pageText, io) => {
  const diag: GardssalgProductsExtractionDiagnostic = {};
  const names = await generateGardssalgProductList(pageText, diag, { retryOnUnparseable: false, signal: io.signal });
  if (names && names.length > 0) return { outcome: "names", names };
  if (diag.outcome === "sentinel_no_products") return { outcome: "none" };
  if (diag.outcome === "invalid_unparseable" && diag.invalid_reason === "empty_after_filter") {
    return { outcome: "none", detail: "empty_after_filter" };
  }
  return { outcome: "failed", detail: [diag.outcome ?? "infra_failure", diag.invalid_reason].filter(Boolean).join(":") };
};

// ─── Scheduling ────────────────────────────────────────────────────────────

export function isRfbEnrichmentForbiddenHour(d: Date): boolean {
  return d.getUTCHours() === RFB_ENRICHMENT_FORBIDDEN_HOUR_UTC;
}

/** The next 08:00Z at or after `d` (the start of the forbidden hour). */
export function nextForbiddenWindowStart(d: Date): Date {
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), RFB_ENRICHMENT_FORBIDDEN_HOUR_UTC));
  if (d.getTime() >= start.getTime()) start.setUTCDate(start.getUTCDate() + 1);
  return start;
}

/**
 * A run's hard deadline: max runtime from `start`, but never later than the
 * forbidden-window margin before the next 08:00Z.
 */
export function computeRfbEnrichmentDeadline(start: Date, maxRuntimeMs: number): Date {
  const cutoff = nextForbiddenWindowStart(start).getTime() - RFB_ENRICHMENT_FORBIDDEN_MARGIN_MS;
  return new Date(Math.min(start.getTime() + maxRuntimeMs, cutoff));
}

/** Pure tick guard: inside a configured start hour, never 08Z, at most once per ~day. */
export function shouldRunRfbEnrichmentNightly(opts: {
  now: Date;
  lastRunAt: Date | null;
  windowHours?: readonly number[];
  minHoursBetween?: number;
}): boolean {
  if (isRfbEnrichmentForbiddenHour(opts.now)) return false;
  const hours = opts.windowHours ?? resolveRfbEnrichmentWindowHours();
  if (!hours.includes(opts.now.getUTCHours())) return false;
  if (opts.lastRunAt) {
    const minHours = opts.minHoursBetween ?? RFB_ENRICHMENT_MIN_HOURS_BETWEEN_RUNS;
    if (opts.now.getTime() - opts.lastRunAt.getTime() < minHours * 3600_000) return false;
  }
  return true;
}

/**
 * Whether a run counts as "tonight's run" for the stamp. A lock-held,
 * in-flight or forbidden-hour skip is retried on the next tick; everything
 * else (including an error) consumes the night so a failing run is not
 * repeated every 5 minutes.
 */
export function rfbEnrichmentRunConsumesWindow(r: { skipped_reason: string | null }): boolean {
  return (
    r.skipped_reason !== "verifier_tick_lock_held" &&
    r.skipped_reason !== "run_in_progress" &&
    r.skipped_reason !== "forbidden_hour" &&
    r.skipped_reason !== "disabled_by_env" &&
    r.skipped_reason !== "already_ran_tonight"
  );
}

// ─── Nights ────────────────────────────────────────────────────────────────
//
// A "night" runs from 08:00Z to the next 08:00Z: the forbidden send hour
// opens the next one, so every possible run slot (22–05Z) of one night falls
// inside the same window. The per-night LLM cap, the "one apply run per
// night" rule and the at-most-once no-run envelope all key on it.

/** Start (08:00Z) of the night `d` belongs to. */
export function rfbEnrichmentNightStart(d: Date): Date {
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), RFB_ENRICHMENT_FORBIDDEN_HOUR_UTC));
  if (d.getTime() < start.getTime()) start.setUTCDate(start.getUTCDate() - 1);
  return start;
}

/** The night's key: the UTC date its 08:00Z start falls on. */
export function rfbEnrichmentNightKey(d: Date): string {
  return rfbEnrichmentNightStart(d).toISOString().slice(0, 10);
}

/** End of the last configured start hour inside the night `d` belongs to. */
export function rfbEnrichmentWindowEnd(d: Date, hours: readonly number[]): Date {
  const nightStartMs = rfbEnrichmentNightStart(d).getTime();
  let end = nightStartMs;
  for (const h of hours) {
    const offsetHours = (((h - RFB_ENRICHMENT_FORBIDDEN_HOUR_UTC) % 24) + 24) % 24;
    end = Math.max(end, nightStartMs + (offsetHours + 1) * 3600_000);
  }
  return new Date(end);
}

/**
 * LLM calls already spent by this job's runs that STARTED in the night `now`
 * belongs to (sum of the envelopes' rfb_enrichment_llm_calls claims). Throws
 * when the ledger cannot be read — the caller fails closed.
 */
export function readRfbEnrichmentLlmCallsTonight(db: Db, now: Date): number {
  const start = rfbEnrichmentNightStart(now);
  const end = new Date(start.getTime() + 86_400_000);
  const rows = db
    .prepare(`SELECT claims FROM runs WHERE agent = ? AND started_at >= ? AND started_at < ?`)
    .all(RFB_ENRICHMENT_NIGHTLY_AGENT, start.toISOString(), end.toISOString()) as Array<{ claims: string }>;
  let total = 0;
  for (const r of rows) {
    try {
      const claims = JSON.parse(r.claims) as Array<{ value?: unknown; meta?: { kind?: string } }>;
      const llm = Array.isArray(claims) ? claims.find((c) => c?.meta?.kind === "rfb_enrichment_llm_calls") : undefined;
      const n = Number(llm?.value);
      if (Number.isFinite(n) && n > 0) total += n;
    } catch {
      // an unparseable envelope carries no LLM count
    }
  }
  return total;
}

/**
 * Durable per-night LLM counter (survives a run that dies before its
 * envelope): a row in rfb_enrichment_sweep_state keyed
 * `llm_calls_night:<night>`, whose next_offset column holds the night's
 * count. Before every LLM-capable row starts, the row's worst case is added
 * (a reservation); when it finishes, the difference to the calls it really
 * made is settled — never below the reservation for a row whose route call
 * timed out (504), whose judge call may still land later. So at any instant —
 * including the moment a process dies — the counter is >= the calls actually
 * spent tonight. One caveat: a late call after a 504 that lands after 08:00Z
 * is counted on the night the run started in.
 */
export function rfbEnrichmentLlmCounterKey(now: Date): string {
  return `llm_calls_night:${rfbEnrichmentNightKey(now)}`;
}

/** The night's durable LLM counter (0 when none). Throws when unreadable — callers fail closed. */
export function readRfbEnrichmentNightLlmCounter(db: Db, now: Date): number {
  const row = db
    .prepare(`SELECT next_offset FROM rfb_enrichment_sweep_state WHERE cursor = ?`)
    .get(rfbEnrichmentLlmCounterKey(now)) as { next_offset: number } | undefined;
  const n = Number(row?.next_offset ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Add `delta` (may be negative when settling) to the night's counter, never below 0. Throws on a DB error. */
export function bumpRfbEnrichmentNightLlmCounter(db: Db, now: Date, delta: number, at: Date): void {
  db.prepare(
    `INSERT INTO rfb_enrichment_sweep_state (cursor, next_offset, total, updated_at)
     VALUES (@key, MAX(0, @delta), NULL, @at)
     ON CONFLICT(cursor) DO UPDATE SET
       next_offset = MAX(0, next_offset + @delta),
       updated_at = @at`,
  ).run({ key: rfbEnrichmentLlmCounterKey(now), delta: Math.trunc(delta), at: at.toISOString() });
}

/**
 * LLM calls already spent tonight for budgeting: the larger of the envelopes'
 * sum and the durable counter (the counter also covers a run that died before
 * writing its envelope). Throws when either is unreadable — callers fail closed.
 */
export function readRfbEnrichmentLlmSpentTonight(db: Db, now: Date): number {
  return Math.max(readRfbEnrichmentLlmCallsTonight(db, now), readRfbEnrichmentNightLlmCounter(db, now));
}

/** Whether any envelope of this job (a run's or the no-run one) started in the night `now` belongs to. */
function hasEnvelopeTonight(db: Db, now: Date): boolean {
  const start = rfbEnrichmentNightStart(now);
  const end = new Date(start.getTime() + 86_400_000);
  try {
    return !!db
      .prepare(`SELECT 1 AS x FROM runs WHERE agent = ? AND started_at >= ? AND started_at < ? LIMIT 1`)
      .get(RFB_ENRICHMENT_NIGHTLY_AGENT, start.toISOString(), end.toISOString());
  } catch {
    return true; // ledger unreadable: do not try to write to it either
  }
}

/**
 * The one "nothing ran tonight" envelope (N4): `failed` when an error stopped
 * a run before it could take the lock, `partial` when the night's window
 * ended without a run (e.g. the verifier tick lock was held at every try).
 * Deterministic run_id per night → at most one per night. Returns whether it
 * was written now.
 */
export function recordRfbEnrichmentNoRunEnvelope(
  db: Db,
  now: Date,
  status: "partial" | "failed",
  trigger: "cron" | "manual",
  meta: { reason: string } & Record<string, unknown>,
): boolean {
  const night = rfbEnrichmentNightKey(now);
  const runId = `run-${night}-${RFB_ENRICHMENT_NIGHTLY_AGENT}-no-run`;
  try {
    if (db.prepare(`SELECT 1 FROM runs WHERE run_id = ?`).get(runId)) return false;
    recordRun({
      run_id: runId,
      vertical: "rfb",
      agent: RFB_ENRICHMENT_NIGHTLY_AGENT,
      trigger_source: trigger,
      started_at: now.toISOString(),
      finished_at: now.toISOString(),
      status,
      claims: [{ type: "custom", value: 0, meta: { kind: "rfb_enrichment_no_run", night, status, ...meta } }],
      evidence: [],
      notes: `no enrichment run tonight (${night}): ${meta.reason}`.slice(0, 490),
    });
    return true;
  } catch (err) {
    console.error("[rfb-enrichment-nightly] no-run envelope not recorded (non-fatal):", err);
    return false;
  }
}

/** Why tonight's tick-driven runs were skipped (this process only). */
interface NoRunTracker {
  night: string;
  lockHeldSkips: number;
  lastHolder: { run_id: string; started_at: string } | null;
  otherSkips: Record<string, number>;
}
let noRunTracker: NoRunTracker = { night: "", lockHeldSkips: 0, lastHolder: null, otherSkips: {} };
const MODULE_LOADED_AT = new Date();

/** Test-only: forget this process's skip memory. */
export function __resetRfbEnrichmentNoRunTrackerForTesting(): void {
  noRunTracker = { night: "", lockHeldSkips: 0, lastHolder: null, otherSkips: {} };
}

function trackSkip(now: Date, r: RfbEnrichmentNightlyReport): void {
  const night = rfbEnrichmentNightKey(now);
  if (noRunTracker.night !== night) noRunTracker = { night, lockHeldSkips: 0, lastHolder: null, otherSkips: {} };
  if (!r.skipped_reason) return;
  if (r.skipped_reason === "verifier_tick_lock_held") {
    noRunTracker.lockHeldSkips++;
    noRunTracker.lastHolder = r.lock.holder ?? null;
  } else {
    noRunTracker.otherSkips[r.skipped_reason] = (noRunTracker.otherSkips[r.skipped_reason] ?? 0) + 1;
  }
}

/**
 * After tonight's window has ended without a run, write the no-run envelope
 * once. Only when this process was up before the window ended (a deploy at
 * 03:00Z knows nothing about the 00–01Z window).
 */
function maybeRecordNoRunEnvelope(db: Db, now: Date, lastRunAt: Date | null, processStartedAt: Date): boolean {
  // A run (e.g. a manual POST /run apply) is in flight in this process: its
  // envelope is still to come. The index.ts tick guard only serialises ticks.
  if (runInFlight) return false;
  const windowEnd = rfbEnrichmentWindowEnd(now, resolveRfbEnrichmentWindowHours());
  if (now.getTime() < windowEnd.getTime()) return false;
  if (processStartedAt.getTime() >= windowEnd.getTime()) return false;
  // A run's envelope (or this night's no-run envelope) is already on record.
  if (hasEnvelopeTonight(db, now)) return false;
  const nightStartMs = rfbEnrichmentNightStart(now).getTime();
  const stampedTonight = (d: Date | null) => !!d && d.getTime() >= nightStartMs && d.getTime() <= now.getTime();
  // Stamped but no envelope: a run took the lock and then died (deploy, OOM,
  // restart) before it could write one — still one envelope for the night.
  const runDied = stampedTonight(lastRunAt) || stampedTonight(getJobLastCompletedAt(db, RFB_ENRICHMENT_NIGHTLY_JOB_STATE_KEY));
  const night = rfbEnrichmentNightKey(now);
  const t = noRunTracker.night === night ? noRunTracker : { lockHeldSkips: 0, lastHolder: null, otherSkips: {} as Record<string, number> };
  const reason = runDied
    ? "run_started_without_envelope"
    : t.lockHeldSkips > 0
      ? "verifier_tick_lock_held"
      : Object.keys(t.otherSkips)[0] ?? "no_run_in_window";
  return recordRfbEnrichmentNoRunEnvelope(db, now, "partial", "cron", {
    reason,
    window_hours_utc: resolveRfbEnrichmentWindowHours(),
    window_end: windowEnd.toISOString(),
    lock_held_skips: t.lockHeldSkips,
    last_lock_holder: t.lastHolder,
    other_skips: t.otherSkips,
    ...(runDied ? { llm_calls_counted_tonight: safeCounter(db, now) } : {}),
  });
}

function safeCounter(db: Db, now: Date): number | null {
  try {
    return readRfbEnrichmentNightLlmCounter(db, now);
  } catch {
    return null;
  }
}

/**
 * One 5-minute tick (src/index.ts). Returns the stamp to keep in memory and
 * the report (null when the guard said "not now" or the flag is off).
 */
export async function tickRfbEnrichmentNightly(opts: {
  now: Date;
  lastRunAt: Date | null;
  deps?: RfbEnrichmentNightlyDeps;
  /** When this process started (tests); default: module load time. */
  processStartedAt?: Date;
}): Promise<{ lastRunAt: Date | null; report: RfbEnrichmentNightlyReport | null; noRunEnvelopeRecorded?: boolean }> {
  if (!isRfbEnrichmentNightlyEnabled()) return { lastRunAt: opts.lastRunAt, report: null };
  const db = getDb();
  const lastRunAt = resolveDailyJobLastRunAt(db, RFB_ENRICHMENT_NIGHTLY_JOB_STATE_KEY, opts.lastRunAt, opts.now);
  if (!shouldRunRfbEnrichmentNightly({ now: opts.now, lastRunAt })) {
    const noRunEnvelopeRecorded = maybeRecordNoRunEnvelope(db, opts.now, lastRunAt, opts.processStartedAt ?? MODULE_LOADED_AT);
    return { lastRunAt, report: null, ...(noRunEnvelopeRecorded ? { noRunEnvelopeRecorded } : {}) };
  }
  const report = await runRfbEnrichmentNightly({ apply: true, trigger: "cron", now: opts.now, deps: opts.deps });
  trackSkip(opts.now, report);
  if (!rfbEnrichmentRunConsumesWindow(report)) return { lastRunAt, report };
  // runRfbEnrichmentNightly already stamped boot_job_state for a real run.
  return { lastRunAt: opts.now, report };
}

// ─── State tables ──────────────────────────────────────────────────────────

export function ensureRfbEnrichmentNightlyTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rfb_enrichment_nightly_attempts (
      agent_id TEXT NOT NULL,
      step TEXT NOT NULL,
      last_attempted_at TEXT NOT NULL,
      last_outcome TEXT,
      last_run_id TEXT,
      PRIMARY KEY (agent_id, step)
    );
    CREATE TABLE IF NOT EXISTS rfb_enrichment_sweep_state (
      cursor TEXT PRIMARY KEY,
      next_offset INTEGER NOT NULL DEFAULT 0,
      total INTEGER,
      updated_at TEXT
    );
  `);
}

/** step → agent_id → last attempt (ms). Read-only; a missing table reads as empty. */
export function readRfbEnrichmentAttempts(db: Db): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  let rows: Array<{ agent_id: string; step: string; last_attempted_at: string }> = [];
  try {
    rows = db
      .prepare(`SELECT agent_id, step, last_attempted_at FROM rfb_enrichment_nightly_attempts`)
      .all() as typeof rows;
  } catch {
    return out;
  }
  for (const r of rows) {
    const t = Date.parse(r.last_attempted_at);
    if (Number.isNaN(t)) continue;
    let m = out.get(r.step);
    if (!m) {
      m = new Map();
      out.set(r.step, m);
    }
    m.set(r.agent_id, t);
  }
  return out;
}

function stampAttempt(db: Db, agentId: string, step: RfbEnrichmentStep | typeof OWNER_REFRESH_STEP, at: Date, outcome: string, runId: string): void {
  try {
    db.prepare(
      `INSERT INTO rfb_enrichment_nightly_attempts (agent_id, step, last_attempted_at, last_outcome, last_run_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, step) DO UPDATE SET
         last_attempted_at = excluded.last_attempted_at,
         last_outcome = excluded.last_outcome,
         last_run_id = excluded.last_run_id`,
    ).run(agentId, step, at.toISOString(), outcome.slice(0, 200), runId);
  } catch (err) {
    console.error(`[rfb-enrichment-nightly] could not stamp attempt ${step}/${agentId} (non-fatal):`, err);
  }
}

/** The Bondens Marked cursor (0 when never stored). Read-only. */
export function getRfbEnrichmentBmCursor(db: Db): { next_offset: number; total: number | null; updated_at: string | null } {
  try {
    const row = db
      .prepare(`SELECT next_offset, total, updated_at FROM rfb_enrichment_sweep_state WHERE cursor = ?`)
      .get(RFB_ENRICHMENT_BM_CURSOR) as { next_offset: number; total: number | null; updated_at: string | null } | undefined;
    if (!row) return { next_offset: 0, total: null, updated_at: null };
    const n = Number(row.next_offset);
    return { next_offset: Number.isSafeInteger(n) && n > 0 ? n : 0, total: row.total ?? null, updated_at: row.updated_at ?? null };
  } catch {
    return { next_offset: 0, total: null, updated_at: null };
  }
}

export function setRfbEnrichmentBmCursor(db: Db, nextOffset: number, total: number | null, at: Date): void {
  db.prepare(
    `INSERT INTO rfb_enrichment_sweep_state (cursor, next_offset, total, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(cursor) DO UPDATE SET
       next_offset = excluded.next_offset,
       total = excluded.total,
       updated_at = excluded.updated_at`,
  ).run(RFB_ENRICHMENT_BM_CURSOR, Math.max(0, Math.floor(nextOffset)), total, at.toISOString());
}

/**
 * Where the NEXT run starts: offset + scanned, wrapping to 0 at the end of the
 * slug list (so ~6 nights of 60 cover ~354 slugs, then start over).
 */
export function nextBmCursor(offset: number, scanned: number, totalSlugs: number): number {
  if (totalSlugs <= 0) return offset;
  const next = offset + Math.max(0, scanned);
  return next >= totalSlugs ? 0 : next;
}

// ─── Cohort ────────────────────────────────────────────────────────────────

export type RfbEnrichmentExclusion =
  | "umbrella"
  | "inactive"
  | "unvetted"
  | "customer"
  | "curated"
  | "opt_out"
  | "contacted"
  | "blocklisted"
  | "terminal_dead";

export interface RfbEnrichmentCohortRow {
  id: string;
  name: string;
  contact_email: string | null;
  org_nr: string | null;
  a_url: string | null;
  created_at: string | null;
  categories: string | null;
  has_knowledge: boolean;
  k_website: string | null;
  k_email: string | null;
  about: string | null;
  products: string | null;
  field_provenance: string | null;
  verification_status: string | null;
  url_last_status: number | null;
  url_last_probed: string | null;
  homepage_unreachable_since: string | null;
  /** 1 = closest to the pool … 6 = furthest (see tierOf). */
  tier: number;
}

export interface RfbEnrichmentCohort {
  rows: RfbEnrichmentCohortRow[];
  considered: number;
  excluded: Record<RfbEnrichmentExclusion, number>;
  by_tier: Record<string, number>;
}

interface BaseRow {
  id: string;
  name: string | null;
  contact_email: string | null;
  contact_email_lower: string | null;
  org_nr: string | null;
  a_url: string | null;
  created_at: string | null;
  categories: string | null;
  umbrella_type: string | null;
  is_active: number | null;
  is_vetted: number | null;
  is_customer: number;
  k_agent_id: string | null;
  k_website: string | null;
  k_email: string | null;
  k_email_lower: string | null;
  about: string | null;
  products: string | null;
  field_provenance: string | null;
  verification_status: string | null;
  verification_review_reason: string | null;
  url_last_status: number | null;
  url_last_probed: string | null;
  homepage_unreachable_since: string | null;
  curated_fields: string | null;
}

function baseRowsSql(extraWhere = ""): string {
  return `
    SELECT a.id AS id, a.name AS name, a.contact_email AS contact_email,
           LOWER(a.contact_email) AS contact_email_lower,
           a.org_nr AS org_nr, a.url AS a_url, a.created_at AS created_at, a.categories AS categories,
           a.umbrella_type AS umbrella_type, a.is_active AS is_active, a.is_vetted AS is_vetted,
           CASE WHEN ${customerRuleSql("a")} THEN 1 ELSE 0 END AS is_customer,
           k.agent_id AS k_agent_id, k.website AS k_website, k.email AS k_email,
           LOWER(k.email) AS k_email_lower,
           k.about AS about, k.products AS products, k.field_provenance AS field_provenance,
           k.verification_status AS verification_status,
           k.verification_review_reason AS verification_review_reason,
           k.url_last_status AS url_last_status, k.url_last_probed AS url_last_probed,
           k.homepage_unreachable_since AS homepage_unreachable_since,
           k.curated_fields AS curated_fields
      FROM agents a
      LEFT JOIN agent_knowledge k ON k.agent_id = a.id
     WHERE a.role = 'producer'
       AND ${publicListableSql("a")}
       ${extraWhere}
     ORDER BY a.created_at ASC, a.id ASC
  `;
}

function trimmed(v: string | null | undefined): string {
  return (v ?? "").trim();
}

function hasCuratedLock(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

function siteLooksDead(r: { url_last_status: number | null; homepage_unreachable_since: string | null }): boolean {
  if (r.homepage_unreachable_since) return true;
  return r.url_last_status !== null && r.url_last_status !== undefined && (r.url_last_status < 200 || r.url_last_status >= 400);
}

/** Last URL probe answered 2xx/3xx and the homepage is not parked. */
export function rfbEnrichmentSiteAnswers(r: { url_last_status: number | null; homepage_unreachable_since: string | null }): boolean {
  if (r.homepage_unreachable_since) return false;
  return r.url_last_status !== null && r.url_last_status !== undefined && r.url_last_status >= 200 && r.url_last_status < 400;
}

/**
 * The spec's Context groups, closest to the pool first:
 *   1 e-mail + website that answers (or not yet probed)
 *   2 website (answers / not probed), no e-mail
 *   3 e-mail, no website
 *   4 e-mail + dead website
 *   5 dead website, no e-mail
 *   6 neither
 * "website" is agent_knowledge.website — the field the verifier's gate reads.
 */
export function tierOf(r: {
  k_email: string | null;
  k_website: string | null;
  url_last_status: number | null;
  homepage_unreachable_since: string | null;
}): number {
  const email = trimmed(r.k_email) !== "";
  const site = trimmed(r.k_website) !== "";
  const dead = site && siteLooksDead(r);
  if (email && site && !dead) return 1;
  if (!email && site && !dead) return 2;
  if (email && !site) return 3;
  if (email && site && dead) return 4;
  if (!email && site && dead) return 5;
  return 6;
}

/**
 * The "contacted" signals of GET /admin/pool-blocker-explain, as sets:
 *   already_contacted — an outbound CRM message with a sent_at, to a contact
 *     whose e-mail equals agents.contact_email case-insensitively
 *     (pool-blocker-explain: MAX(m.sent_at) over that join is truthy);
 *   already_sent — an outreach_sent_log row (vertical rfb) for the agent id,
 *     or whose recipient_email equals LOWER(agent_knowledge.email).
 */
export interface RfbContactedSignals {
  crmOutEmails: Set<string>;
  sentAgentIds: Set<string>;
  sentRecipients: Set<string>;
}

export function readRfbContactedSignals(db: Db): RfbContactedSignals {
  const crmOutEmails = new Set<string>();
  const crmRows = db
    .prepare(
      `SELECT LOWER(c.email) AS e, MAX(m.sent_at) AS last_sent
         FROM crm_messages m
         JOIN crm_threads t ON t.id = m.thread_id
         JOIN crm_contacts c ON c.id = t.contact_id
        WHERE m.direction = 'out'
        GROUP BY LOWER(c.email)`,
    )
    .all() as Array<{ e: string | null; last_sent: string | null }>;
  for (const r of crmRows) if (r.e !== null && r.last_sent) crmOutEmails.add(r.e);

  const sentAgentIds = new Set<string>();
  const sentRecipients = new Set<string>();
  const verticalScoped = outreachSentLogHasVerticalColumn(db);
  const sentRows = db
    .prepare(
      `SELECT agent_id, recipient_email FROM outreach_sent_log${verticalScoped ? ` WHERE vertical_id = 'rfb'` : ""}`,
    )
    .all() as Array<{ agent_id: string | null; recipient_email: string | null }>;
  for (const r of sentRows) {
    if (r.agent_id) sentAgentIds.add(r.agent_id);
    if (r.recipient_email !== null && r.recipient_email !== undefined) sentRecipients.add(r.recipient_email);
  }
  return { crmOutEmails, sentAgentIds, sentRecipients };
}

/** already_sent || already_contacted, exactly as pool-blocker-explain derives them. */
export function isContactedPerPoolBlockerExplain(
  row: { id: string; contact_email_lower: string | null; k_email_lower: string | null },
  s: RfbContactedSignals,
): boolean {
  const ce = row.contact_email_lower;
  if (ce !== null && ce !== "" && s.crmOutEmails.has(ce)) return true;
  if (s.sentAgentIds.has(row.id)) return true;
  if (row.k_email_lower !== null && s.sentRecipients.has(row.k_email_lower)) return true;
  return false;
}

function readOptOutAgentIds(db: Db): Set<string> {
  const rows = db
    .prepare(`SELECT DISTINCT agent_id FROM crm_contacts WHERE agent_id IS NOT NULL AND status != 'active'`)
    .all() as Array<{ agent_id: string }>;
  return new Set(rows.map((r) => r.agent_id));
}

function toCohortRow(r: BaseRow): RfbEnrichmentCohortRow {
  return {
    id: r.id,
    name: r.name ?? "",
    contact_email: r.contact_email,
    org_nr: r.org_nr,
    a_url: r.a_url,
    created_at: r.created_at,
    categories: r.categories,
    has_knowledge: r.k_agent_id !== null,
    k_website: r.k_website,
    k_email: r.k_email,
    about: r.about,
    products: r.products,
    field_provenance: r.field_provenance,
    verification_status: r.verification_status,
    url_last_status: r.url_last_status,
    url_last_probed: r.url_last_probed,
    homepage_unreachable_since: r.homepage_unreachable_since,
    tier: tierOf(r),
  };
}

/**
 * The uncontacted RFB cohort. Read-only; yields to the event loop between
 * phases and every 200 rows of the per-row checks.
 */
export async function loadRfbEnrichmentCohort(db: Db): Promise<RfbEnrichmentCohort> {
  const base = db.prepare(baseRowsSql()).all() as BaseRow[];
  await yieldToEventLoop();
  const contacted = readRfbContactedSignals(db);
  const optOut = readOptOutAgentIds(db);
  await yieldToEventLoop();

  const excluded: Record<RfbEnrichmentExclusion, number> = {
    umbrella: 0,
    inactive: 0,
    unvetted: 0,
    customer: 0,
    curated: 0,
    opt_out: 0,
    contacted: 0,
    blocklisted: 0,
    terminal_dead: 0,
  };
  const rows: RfbEnrichmentCohortRow[] = [];
  const byTier: Record<string, number> = {};
  for (let i = 0; i < base.length; i++) {
    if (i > 0 && i % 200 === 0) await yieldToEventLoop();
    const r = base[i];
    let reason: RfbEnrichmentExclusion | null = null;
    if (r.umbrella_type) reason = "umbrella";
    else if (r.is_active !== 1) reason = "inactive";
    else if (r.is_vetted !== null && r.is_vetted !== 1) reason = "unvetted";
    else if (r.is_customer === 1) reason = "customer";
    else if (hasCuratedLock(r.curated_fields)) reason = "curated";
    else if (r.verification_status === "opt_out" || optOut.has(r.id)) reason = "opt_out";
    else if (isContactedPerPoolBlockerExplain(r, contacted)) reason = "contacted";
    else if (
      isBlocked({
        agentId: r.id,
        name: r.name ?? undefined,
        email: trimmed(r.k_email) || undefined,
        website: trimmed(r.k_website) || undefined,
      }).blocked
    )
      reason = "blocklisted";
    else {
      const terminal = classifyTerminalRow(r.verification_status, r.verification_review_reason);
      if (terminal.outcome === "skipped_confirmed_dead" || terminal.outcome === "skipped_non_producer") {
        reason = "terminal_dead";
      }
    }
    if (reason) {
      excluded[reason]++;
      continue;
    }
    const row = toCohortRow(r);
    rows.push(row);
    byTier[String(row.tier)] = (byTier[String(row.tier)] ?? 0) + 1;
  }
  return { rows, considered: base.length, excluded, by_tier: byTier };
}

/**
 * Re-read the cohort rows' own columns (one query) after earlier steps wrote
 * to them; the exclusion decisions from the first load are kept (nothing this
 * job does can contact, claim or curate a producer).
 */
async function refreshCohortRows(db: Db, cohort: RfbEnrichmentCohort): Promise<void> {
  const ids = new Set(cohort.rows.map((r) => r.id));
  const fresh = db.prepare(baseRowsSql()).all() as BaseRow[];
  await yieldToEventLoop();
  const byId = new Map<string, RfbEnrichmentCohortRow>();
  for (const r of fresh) if (ids.has(r.id)) byId.set(r.id, toCohortRow(r));
  cohort.rows = cohort.rows.map((r) => byId.get(r.id) ?? r);
}

// ─── Step selection ────────────────────────────────────────────────────────

interface SelectionContext {
  db: Db;
  nowMs: number;
  retryMs: number;
  attempts: Map<string, Map<string, number>>;
  brregCandidateIds?: Set<string>;
  cxEligibleIds?: Set<string>;
  pendingQueueAgentIds?: Set<string>;
}

export interface RfbEnrichmentSelection {
  eligible: number;
  rows: RfbEnrichmentCohortRow[];
  /** Rows the step would otherwise have taken but must not, by reason. */
  skipped: Record<string, number>;
  /** url_check only: rows whose URL is agents.url because k.website is blank. */
  a_url_only?: { eligible: number; selected: number };
}

function parseMs(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(v.includes("T") || v.endsWith("Z") ? v : `${v.replace(" ", "T")}Z`);
  return Number.isNaN(t) ? null : t;
}

function homepageOf(r: RfbEnrichmentCohortRow): string {
  return trimmed(r.k_website) || trimmed(r.a_url);
}

/**
 * A homepage on a social / directory / known-hijacked host (the website-
 * discovery exclusion) or a directory/aggregator host (the cross-source
 * list) is never the producer's own site. Step 1 must not probe it: the pool
 * view reads url_last_status alone, so a probe of, say, a Facebook page
 * stored in agents.url would let a row pass the pool's URL leg on someone
 * else's site. Both lists are reused, not copied.
 */
export function rfbEnrichmentHomepageHostExcluded(url: string): boolean {
  const host = hostFromUrlLike(url);
  if (!host) return false;
  return !!rfbWebsiteHostExclusionReason(host) || isDirectoryOrAggregatorHost(host);
}

/** The e-mail domain step 2 would try as a website, or null when it may not. */
export function emailDomainWebsiteCandidate(db: Db, r: RfbEnrichmentCohortRow): string | null {
  if (trimmed(r.k_website)) return null;
  const email = trimmed(r.k_email) || trimmed(r.contact_email);
  if (!email) return null;
  const dom = emailDomain(email);
  if (!dom || !dom.includes(".") || !/^[a-z0-9.-]+$/.test(dom)) return null;
  if (FREE_MAIL_DOMAINS.includes(dom)) return null;
  if (isPlatformOwnedEmailDomain(email)) return null;
  if (rfbWebsiteHostExclusionReason(dom)) return null;
  if (isParaplyRoutedEmail(email, getAffiliatedUmbrellaDomains(db, r.id))) return null;
  return dom;
}

/** true = take it; false = not eligible; a string = would be eligible but is skipped for that reason (counted). */
function stepEligible(step: RfbEnrichmentStep, r: RfbEnrichmentCohortRow, ctx: SelectionContext): boolean | string {
  switch (step) {
    case "url_check": {
      const url = homepageOf(r);
      if (!url) return false;
      // Our own domain as "homepage" is a data bug, never the producer's site.
      if (isOwnPlatformHomepage({ website: r.k_website, url: r.a_url })) return false;
      const probed = parseMs(r.url_last_probed);
      if (!(probed === null || probed < ctx.nowMs - RFB_ENRICHMENT_URL_STALE_DAYS * 86_400_000)) return false;
      if (rfbEnrichmentHomepageHostExcluded(url)) return "skipped_directory_or_social_host";
      return true;
    }
    case "email_domain_website":
      if (ctx.pendingQueueAgentIds?.has(r.id)) return false;
      return emailDomainWebsiteCandidate(ctx.db, r) !== null;
    case "brreg_contact":
      return !!ctx.brregCandidateIds?.has(r.id);
    case "contact_extraction":
      return (
        !!ctx.cxEligibleIds?.has(r.id) &&
        trimmed(r.k_website) !== "" &&
        trimmed(r.k_email) === "" &&
        rfbEnrichmentSiteAnswers(r)
      );
    case "content_refresh": {
      const url = homepageOf(r);
      if (url === "" || isOwnPlatformHomepage({ website: r.k_website, url: r.a_url }) || !rfbEnrichmentSiteAnswers(r)) {
        return false;
      }
      if (!isContentQualified({ about: r.about, products: r.products }) || productsAreGenericCategoryNames(r.products)) {
        return true;
      }
      // Content is enough, but the outreach gate holds the row on
      // categories_not_corroborated (agents.categories without a homepage/
      // owner source). Only the producer's own site may corroborate them.
      if (!categoriesLackWebsiteCorroboration(r.categories, r.field_provenance)) return false;
      if (rfbEnrichmentHomepageHostExcluded(url)) return "skipped_directory_or_social_host";
      return true;
    }
    case "reverify": {
      const since = parseMs(r.homepage_unreachable_since);
      return since !== null && since <= ctx.nowMs - RFB_ENRICHMENT_UNREACHABLE_DAYS * 86_400_000;
    }
    case "bm_harvest":
      return false;
  }
}

function idSet(db: Db, sql: string): Set<string> {
  try {
    return new Set((db.prepare(sql).all() as Array<{ id: string }>).map((r) => r.id));
  } catch {
    return new Set();
  }
}

/** Per-step id sets the tools' own cohort SQL defines (read-only). */
function buildSelectionContext(
  db: Db,
  nowMs: number,
  attempts: Map<string, Map<string, number>>,
): SelectionContext {
  return {
    db,
    nowMs,
    retryMs: resolveRfbEnrichmentRetryDays() * 86_400_000,
    attempts,
    brregCandidateIds: idSet(
      db,
      `SELECT a.id AS id FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id WHERE ${rfbBssCandidateWhereSql(db)}`,
    ),
    cxEligibleIds: idSet(db, rfbCxSelectSql(RFB_CX_ELIGIBLE_WHERE)),
    pendingQueueAgentIds: idSet(db, `SELECT agent_id AS id FROM agents_website_review_queue WHERE status = 'pending'`),
  };
}

/**
 * Rows a step would take now: eligible, not attempted by this step within the
 * retry window, ordered closest-to-pool first then least recently attempted;
 * `rows` is the first `cap`. Read-only.
 */
export async function selectRfbEnrichmentStepRows(
  step: RfbEnrichmentStep,
  cohort: RfbEnrichmentCohort,
  ctx: SelectionContext,
  cap: number,
): Promise<RfbEnrichmentSelection> {
  const last = ctx.attempts.get(step) ?? new Map<string, number>();
  const picked: Array<{ row: RfbEnrichmentCohortRow; attemptMs: number; second: number }> = [];
  const skipped: Record<string, number> = {};
  for (let i = 0; i < cohort.rows.length; i++) {
    if (i > 0 && i % 200 === 0) await yieldToEventLoop();
    const r = cohort.rows[i];
    const attemptMs = last.get(r.id) ?? null;
    if (attemptMs !== null && attemptMs > ctx.nowMs - ctx.retryMs) continue;
    const ok = stepEligible(step, r, ctx);
    if (typeof ok === "string") {
      skipped[ok] = (skipped[ok] ?? 0) + 1;
      continue;
    }
    if (!ok) continue;
    // Brreg: within a tier, rows WITHOUT a contact e-mail first. The route
    // calls the LLM e-mail gate for every row with a Brreg e-mail, but an
    // existing contact_email is never replaced ("own site wins"), so for
    // those rows the call cannot add an e-mail — they come after the rows
    // where it can (their org_nr/website gain is unchanged).
    const second = step === "brreg_contact" && trimmed(r.contact_email) !== "" ? 1 : 0;
    picked.push({ row: r, attemptMs: attemptMs ?? 0, second });
  }
  // Stable sort: cohort order (created_at, id) breaks the remaining ties.
  picked.sort((a, b) => a.row.tier - b.row.tier || a.second - b.second || a.attemptMs - b.attemptMs);
  const rows = picked.slice(0, Math.max(0, cap)).map((p) => p.row);
  const out: RfbEnrichmentSelection = { eligible: picked.length, rows, skipped };
  if (step === "url_check") {
    const aOnly = (r: RfbEnrichmentCohortRow) => trimmed(r.k_website) === "";
    out.a_url_only = { eligible: picked.filter((p) => aOnly(p.row)).length, selected: rows.filter(aOnly).length };
  }
  return out;
}

// ─── In-process admin route calls ──────────────────────────────────────────

/**
 * Call an admin route's OWN Express handler in process via Router.handle() —
 * never an HTTP round-trip to ourselves. Same fake req/res idiom as
 * callGardssalgAdminRouteInProcess (routes/opplevelser.ts) and the route
 * test harnesses. The X-Admin-Key is the server's own, so the route's
 * requireAdmin passes exactly as for an operator call; every other guard in
 * the route runs unchanged. A route that never answers resolves as 504 after
 * `timeoutMs` (its work is still bounded by its own budgets).
 */
export function callAdminRouterInProcess(
  router: any,
  req: { method: "GET" | "POST"; path: string; query?: Record<string, string>; body?: unknown; timeoutMs?: number },
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    "x-admin-key": process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "",
  };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status: number, body: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, body });
    };
    const timer = setTimeout(
      () => finish(504, { error: "in_process_route_timeout" }),
      req.timeoutMs ?? RFB_ENRICHMENT_ROUTE_CALL_TIMEOUT_MS,
    );
    const innerReq: any = {
      method: req.method,
      url: req.path,
      originalUrl: `/admin${req.path}`,
      path: req.path,
      query: req.query ?? {},
      body: req.body ?? {},
      headers,
      ip: "127.0.0.1",
      get(name: string) {
        return headers[String(name).toLowerCase()];
      },
    };
    const innerRes: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        finish(this.statusCode, payload);
        return this;
      },
      send(payload: any) {
        finish(this.statusCode, payload);
        return this;
      },
    };
    try {
      router.handle(innerReq, innerRes, (err?: any) =>
        finish(err ? 500 : 404, { error: err ? String(err?.message ?? err) : "unmatched" }),
      );
    } catch (err: any) {
      finish(500, { error: String(err?.message ?? err) });
    }
  });
}

// ─── Step executors (the seams tests replace) ──────────────────────────────

/**
 * What a finished row's LLM reservation is settled to (B1): the calls the
 * meter saw — except after a 504 / route_timeout, where the abandoned route
 * call may still make its judge call after we moved on. Then the row keeps at
 * least its reservation, so the durable counter never drops below the real
 * spend.
 */
export function settledLlmCalls(outcome: string, stop: string | undefined, reserved: number, actual: number): number {
  const timedOut = outcome === "route_timeout" || stop === "route_timeout";
  return timedOut ? Math.max(reserved, actual) : actual;
}

/** Outcomes that say nothing about the row itself — never stamped as an attempt. */
const TRANSIENT_ROW_OUTCOMES: ReadonlySet<string> = new Set([
  "route_timeout",
  "run_in_progress",
  "enrichment_write_paused",
  "write_paused",
  "timeout",
  "error",
  "no_result",
  "skipped_refresh_budget",
  // NB: brreg_contact_fetch_failed is NOT here — fetchBrregContact also
  // returns null on a 404/410 (wrong, deleted or sub-unit org_nr), a real
  // per-row outcome. An outage is caught by the step instead: three in a row
  // stop the Brreg step for the night (brreg_unavailable), unstamped.
  // contact extraction: the host is in a temporary 429 cooldown (NB3).
  // (`fetch_failed` stays a real outcome: the site may really be dead.)
  "cooldown_skipped",
  // content_refresh: the product-name model call failed (API/network/
  // timeout/unparseable answer) or was not started (too close to the
  // deadline) and nothing else was written — retried next night, not parked.
  // (An empty answer — no product names, or none usable on the page — is
  // products_not_supported_by_homepage: a real per-row outcome, stamped.)
  "products_extraction_failed",
  "products_extraction_skipped",
]);

/**
 * Row outcome for a non-200 answer from an in-process route call. A 4xx
 * (bad request shape, auth) or a 503 (admin key not configured) is the same
 * for every row, so it stops the step for the night instead of being retried
 * row by row up to the cap (NB5); a 504 is the call's own timeout; any other
 * 5xx is one row's failure. All are transient (never stamped).
 */
export function rfbEnrichmentHttpFailureOutcome(status: number, detail?: string): RfbEnrichmentRowOutcome {
  if (status === 504) {
    return { outcome: "route_timeout", written: false, changed: false, error: true, stop: "route_timeout" };
  }
  const stepWide = (status >= 400 && status < 500) || status === 503;
  return {
    outcome: `http_${status}`,
    written: false,
    changed: false,
    error: true,
    ...(stepWide ? { stop: `http_${status}` } : {}),
    ...(detail ? { detail } : {}),
  };
}

export function isTransientRfbEnrichmentOutcome(out: { outcome: string; error?: boolean; stop?: string }): boolean {
  if (out.error || out.stop) return true;
  if (TRANSIENT_ROW_OUTCOMES.has(out.outcome)) return true;
  return /^http_\d+$/.test(out.outcome); // incl. http_503 = no admin key configured
}

export interface RfbEnrichmentRowOutcome {
  /** Short outcome code; tallied in `outcomes`. */
  outcome: string;
  /**
   * content_refresh only: what the categories-corroborate-only refresh did
   * with the stored categories (tallied in the step's extra.categories_
   * corroboration, also when another outcome — e.g. refreshed — wins).
   */
  categories_corroboration?: string;
  /**
   * content_refresh only: what the product-name step did for a row whose
   * stored products were generic (tallied in extra.product_names).
   */
  product_names?: string;
  /** Something was written (a column, or a review-queue proposal). */
  written: boolean;
  /** A producer column changed — the row goes to step 5. */
  changed: boolean;
  /** Stop this step now (e.g. write-pause, the tool's own run-lock). */
  stop?: string;
  error?: boolean;
  detail?: string;
}

export interface RfbEnrichmentBmOutcome {
  status: number;
  total_slugs: number;
  offset: number;
  scanned: number;
  time_budget_exceeded: boolean;
  counts: Record<string, number>;
  changed_agent_ids: string[];
  written: number;
  error?: string;
}

export interface RfbEnrichmentReverifyOutcome {
  outcome: string;
  prior: string | null;
  next: string | null;
  error?: boolean;
  detail?: string;
}

export interface RfbEnrichmentBmArgs {
  offset: number;
  limit: number;
  /** Tonight's cohort: matched producers outside it get no write. */
  scopeAgentIds: string[];
}

/**
 * The exact in-process request the BM step sends. fill_only is not optional
 * here: the route's default still REPLACES a different stored e-mail/phone
 * (2026-10-11: 7 e-mails + 2 phones overwritten by a manual apply run), and
 * this job only ever fills blanks.
 */
export function buildRfbEnrichmentBmHarvestRequest(args: RfbEnrichmentBmArgs): {
  method: "GET";
  path: string;
  query: Record<string, string>;
  body: { scope_agent_ids: string[] };
} {
  return {
    method: "GET",
    path: "/",
    query: { dry_run: "false", fill_only: "1", limit: String(args.limit), offset: String(args.offset) },
    body: { scope_agent_ids: args.scopeAgentIds },
  };
}

export interface RfbEnrichmentExecutors {
  urlCheck(row: RfbEnrichmentCohortRow): Promise<RfbEnrichmentRowOutcome>;
  emailDomainWebsite(row: RfbEnrichmentCohortRow): Promise<RfbEnrichmentRowOutcome>;
  brregContact(row: RfbEnrichmentCohortRow): Promise<RfbEnrichmentRowOutcome>;
  bmHarvest(args: RfbEnrichmentBmArgs): Promise<RfbEnrichmentBmOutcome>;
  contactExtraction(row: RfbEnrichmentCohortRow): Promise<RfbEnrichmentRowOutcome>;
  /**
   * opts.productNames: the row's LLM reservation is in place — hand the
   * refresh the product-name extractor (generic stored products only).
   */
  contentRefresh(row: RfbEnrichmentCohortRow, deadlineAtMs: number, opts?: { productNames?: boolean }): Promise<RfbEnrichmentRowOutcome>;
  reverify(agentId: string): Promise<RfbEnrichmentReverifyOutcome>;
}

/**
 * The real executors: each one is an existing tool, unchanged.
 * `productNameExtractor`: the product-name model call content_refresh uses
 * (default the real one; tests pass a stub — never a real model call).
 */
export function createDefaultRfbEnrichmentExecutors(
  db: Db,
  batchId: string,
  productNameExtractor: HcrProductNamesExtractor = rfbEnrichmentProductNameExtractor,
): RfbEnrichmentExecutors {
  let wdState: { existing: Set<string>; proposed: Set<string>; counters: RfbWdFallbackCounters } | null = null;
  return {
    async urlCheck(row) {
      if (!row.has_knowledge) return { outcome: "no_knowledge_row", written: false, changed: false };
      const url = homepageOf(row);
      if (rfbEnrichmentHomepageHostExcluded(url)) {
        return { outcome: "skipped_directory_or_social_host", written: false, changed: false };
      }
      let probe: { status: number; ok: boolean };
      try {
        probe = await probeAgentUrl(url);
      } catch {
        probe = { status: 0, ok: false };
      }
      const r = applyUrlProbeResult(db, row.id, { status: probe.status, ok: probe.ok, probedAt: new Date().toISOString() });
      const wasOk = row.url_last_status !== null && row.url_last_status >= 200 && row.url_last_status < 400;
      return {
        outcome: probe.ok ? "probe_ok" : `probe_failed_${probe.status}`,
        written: true,
        changed: wasOk !== probe.ok,
        ...(r.demoted ? { detail: "enrichment_status rich→partial" } : {}),
      };
    },

    async emailDomainWebsite(row) {
      const dom = emailDomainWebsiteCandidate(db, row);
      if (!dom) return { outcome: "no_candidate", written: false, changed: false };
      if (!wdState) {
        ensureRfbWebsiteReviewQueueTable(db);
        wdState = { existing: rfbWdExistingWebsiteHosts(db), proposed: new Set(), counters: { attempted: 0, verified: 0 } };
      }
      const r = await evaluateRfbWebsiteCandidate(
        db,
        { agentId: row.id, url: `https://${dom}` },
        wdState.existing,
        wdState.proposed,
        wdState.counters,
        batchId,
        RFB_ENRICHMENT_EMAIL_DOMAIN_QUEUE_REASON,
      );
      if (r.outcome === "proposed") {
        return { outcome: "queued", written: true, changed: false, detail: `${r.candidate_url} conf=${r.confidence}` };
      }
      if (r.outcome === "rejected") return { outcome: `rejected_${r.reason}`, written: false, changed: false };
      return { outcome: r.outcome, written: false, changed: false };
    },

    async brregContact(row) {
      const r = await callAdminRouterInProcess(brregSelfSufficiencyRouter, {
        method: "POST",
        path: "/rfb-brreg-selfsufficiency",
        body: { agentIds: [row.id], apply: true, limit: 1 },
      });
      if (r.status === 423) return { outcome: "enrichment_write_paused", written: false, changed: false, stop: "enrichment_write_paused" };
      if (r.status !== 200) return rfbEnrichmentHttpFailureOutcome(r.status, String(r.body?.error ?? r.body?.detail ?? ""));
      const d = Array.isArray(r.body?.details) ? r.body.details[0] : null;
      const errs = Array.isArray(r.body?.errors) ? r.body.errors : [];
      if (!d) {
        if (errs.length > 0) return { outcome: `error_${errs[0]?.stage ?? "unknown"}`, written: false, changed: false, error: true, detail: String(errs[0]?.error ?? "") };
        const locked = Array.isArray(r.body?.skipped_locked) && r.body.skipped_locked.includes(row.id);
        return { outcome: locked ? "skipped_locked" : "no_result", written: false, changed: false };
      }
      const orgWritten = d.org_nr_outcome === "written";
      const emailWritten = d.email_outcome === "email_written";
      const proposed = d.website_outcome === "website_proposed";
      let outcome: string;
      if (emailWritten) outcome = "email_written";
      else if (orgWritten) outcome = "org_nr_written";
      else if (proposed) outcome = "website_proposed";
      else if (d.email_outcome && d.email_outcome !== "not_attempted") outcome = d.email_outcome;
      else if (d.website_outcome && d.website_outcome !== "skipped_no_org_nr") outcome = d.website_outcome;
      else outcome = `org_nr_${d.org_nr_outcome}`;
      return {
        outcome,
        written: orgWritten || emailWritten || proposed,
        changed: orgWritten || emailWritten,
        detail: `org_nr=${d.org_nr_outcome} website=${d.website_outcome} email=${d.email_outcome}`,
        ...(errs.length > 0 ? { error: true } : {}),
      };
    },

    async bmHarvest(args) {
      const { offset } = args;
      const r = await callAdminRouterInProcess(bmProducerHarvestRouter, buildRfbEnrichmentBmHarvestRequest(args));
      const body = r.body ?? {};
      const results: any[] = Array.isArray(body.results) ? body.results : [];
      const changed = new Set<string>();
      let written = 0;
      for (const it of results) {
        const emailW = it?.outcome === "written";
        const phoneW = it?.phone_outcome === "phone_written";
        const urlQ = it?.url_outcome === "url_proposed";
        if (emailW || phoneW || urlQ) written++;
        if ((emailW || phoneW) && typeof it?.agent_id === "string") changed.add(it.agent_id);
      }
      return {
        status: r.status,
        total_slugs: Number(body.total_slugs) || 0,
        offset: Number.isFinite(Number(body.offset)) ? Number(body.offset) : offset,
        scanned: Number(body.scanned) || 0,
        time_budget_exceeded: body.time_budget_exceeded === true,
        counts: body.counts && typeof body.counts === "object" ? body.counts : {},
        changed_agent_ids: Array.from(changed),
        written,
        ...(r.status !== 200 ? { error: String(body.error ?? body.detail ?? `http_${r.status}`) } : {}),
      };
    },

    async contactExtraction(row) {
      const r = await callAdminRouterInProcess(contactExtractionRouter, {
        method: "POST",
        path: "/rfb-contact-extraction",
        body: { agentIds: [row.id], apply: true },
      });
      if (r.status === 409) return { outcome: "run_in_progress", written: false, changed: false, stop: "contact_extraction_run_in_progress" };
      if (r.status !== 200) return rfbEnrichmentHttpFailureOutcome(r.status, String(r.body?.error ?? ""));
      const item = Array.isArray(r.body?.results) ? r.body.results[0] : null;
      const outcome = typeof item?.outcome === "string" ? item.outcome : "no_result";
      const written = outcome === "written";
      return { outcome, written, changed: written, ...(item?.detail ? { detail: String(item.detail) } : {}) };
    },

    async contentRefresh(row, deadlineAtMs, opts) {
      // categoriesCorroborateOnly: stored categories are corroborated or left
      // alone, never replaced by the page's keyword extraction (header, step 4).
      // extractProductNames: only when the step reserved this row's one model
      // call (generic stored products, API key present, budget left).
      const r = await refreshRfbCandidateHomepage(db, row.id, {
        deadlineAt: deadlineAtMs,
        categoriesCorroborateOnly: true,
        ...(opts?.productNames ? { extractProductNames: productNameExtractor } : {}),
      });
      if (r.outcome === "write_paused") {
        return { outcome: "write_paused", written: false, changed: false, stop: "enrichment_write_paused" };
      }
      const fields = r.fields ?? [];
      const written = r.outcome === "refreshed" || fields.length > 0;
      let outcome: string = r.outcome;
      if (r.product_names === "products_replaced" && r.outcome === "refreshed") {
        outcome = RFB_ENRICHMENT_PRODUCTS_REPLACED;
      } else if (r.categories_corroboration === "corroborated" && r.outcome === "refreshed") {
        outcome = RFB_ENRICHMENT_CATEGORIES_CORROBORATED;
      } else if (r.outcome === "unchanged" && (r.product_names === "products_extraction_failed" || r.product_names === "products_extraction_skipped")) {
        // Nothing written and the model call did not happen / answer: retry tomorrow.
        outcome = r.product_names;
      } else if (r.outcome === "unchanged" && r.product_names === "products_not_supported_by_homepage") {
        outcome = RFB_ENRICHMENT_PRODUCTS_NOT_SUPPORTED;
      } else if (r.categories_corroboration === "categories_not_supported_by_homepage" && r.outcome === "unchanged") {
        outcome = RFB_ENRICHMENT_CATEGORIES_NOT_SUPPORTED;
      }
      const detail = [
        ...(fields.length > 0 ? [fields.join(",")] : []),
        ...(r.error || r.rejected ? [String(r.error ?? r.rejected)] : []),
      ].join("; ");
      return {
        outcome,
        written,
        changed: written,
        ...(r.categories_corroboration ? { categories_corroboration: r.categories_corroboration } : {}),
        ...(r.product_names ? { product_names: r.product_names } : {}),
        ...(r.outcome === "failed" ? { error: true } : {}),
        ...(detail ? { detail } : {}),
      };
    },

    async reverify(agentId) {
      const r = await runVerifierBatch({ agentIds: [agentId], brregLookup: resolveBrregLookup, batchSize: 1 });
      const v = r.results[0];
      if (!v) return { outcome: "not_found", prior: null, next: null };
      return { outcome: v.new_verification_status, prior: v.prior_verification_status ?? null, next: v.new_verification_status };
    },
  };
}

// ─── Reports ───────────────────────────────────────────────────────────────

export interface RfbEnrichmentStepReport {
  step: RfbEnrichmentStep;
  cap: number;
  eligible: number;
  selected: number;
  attempted: number;
  written: number;
  rejected: number;
  errors: number;
  outcomes: Record<string, number>;
  llm_calls: number;
  llm_calls_per_row_max: number;
  est_cost_usd: number;
  /** Of the rows this step changed: re-verified / became verified / entered the pool in step 5. */
  re_verified: number;
  new_verified: number;
  new_in_pool: number;
  skipped_reason: string | null;
  stopped_reason: string | null;
  changed_agent_ids: string[];
  rows: Array<{ agent_id: string; outcome: string; detail?: string }>;
  duration_ms: number;
  extra?: Record<string, unknown>;
}

export type RfbEnrichmentSkipReason =
  | "disabled_by_env"
  | "run_in_progress"
  | "forbidden_hour"
  | "already_ran_tonight"
  | "verifier_tick_lock_held"
  | "error";

export interface RfbEnrichmentPreview {
  generated_at: string;
  enabled_by_env: boolean;
  window_hours_utc: number[];
  forbidden_hour_utc: number;
  in_window_now: boolean;
  forbidden_now: boolean;
  last_run_at: string | null;
  verifier_tick_lock: { held: boolean; run_id: string | null; locked_at: string | null };
  caps: Record<RfbEnrichmentStep, number>;
  llm_cap: number;
  llm_calls_per_row_max: Record<RfbEnrichmentStep, number>;
  max_runtime_minutes: number;
  retry_days: number;
  cohort: { considered: number; eligible: number; excluded: Record<RfbEnrichmentExclusion, number>; by_tier: Record<string, number> };
  steps: Array<{
    step: RfbEnrichmentStep;
    cap: number;
    eligible: number;
    selected: number;
    selected_ids: string[];
    /** Would be eligible but skipped, by reason (e.g. skipped_directory_or_social_host). */
    skipped?: Record<string, number>;
    /** url_check: rows whose URL is agents.url because k.website is blank. */
    a_url_only?: { eligible: number; selected: number };
    note?: string;
    bm?: { offset: number; limit: number; last_total: number | null; cursor_updated_at: string | null };
  }>;
  /** Step 6 — only with OWNER_AUTO_UPDATES_ENABLED (absent otherwise). */
  owner_refresh?: OwnerRefreshPreview;
}

export interface RfbEnrichmentNightlyReport {
  run_id: string;
  agent: string;
  vertical: "rfb";
  trigger: "cron" | "manual";
  apply: boolean;
  enabled_by_env: boolean;
  started_at: string;
  finished_at: string;
  skipped_reason: RfbEnrichmentSkipReason | null;
  stopped_reason: string | null;
  deadline_at: string | null;
  write_deadline_at: string | null;
  lock: { acquired: boolean; holder?: { run_id: string; started_at: string }; released: boolean };
  caps: Record<RfbEnrichmentStep, number>;
  llm: {
    /** The per-NIGHT cap (RFB_ENRICHMENT_LLM_CAP). */
    cap: number;
    /** Calls already spent tonight by earlier runs (their envelopes). */
    used_before_this_run: number;
    /** What this run may spend: cap − used_before_this_run (0 if unreadable). */
    run_budget: number;
    calls: number;
    est_cost_usd: number;
    usd_per_call: number;
    by_source: Record<string, number>;
    cap_reached: boolean;
  };
  cohort: { considered: number; eligible: number; excluded: Record<RfbEnrichmentExclusion, number>; by_tier: Record<string, number> } | null;
  steps: RfbEnrichmentStepReport[];
  totals: { attempted: number; written: number; changed_agents: number; re_verified: number; new_verified: number; new_in_pool: number };
  preview?: RfbEnrichmentPreview;
  /** Step 6 — only with OWNER_AUTO_UPDATES_ENABLED, in an apply run that reached the steps (absent otherwise). */
  owner_refresh?: OwnerRefreshStepReport;
  envelope_recorded: boolean;
  errors: string[];
}

export interface RfbEnrichmentNightlyDeps {
  /** Replace any of the real executors (tests). */
  executors?: Partial<RfbEnrichmentExecutors>;
  /** The real content_refresh executor's product-name model call (tests: a stub). */
  productNameExtractor?: HcrProductNamesExtractor;
  /** The run's clock (tests); default: `now` plus real elapsed time. */
  clock?: () => Date;
  /** Step 6's about judges / fetch seam (tests: stubs — never a real model call or fetch). */
  ownerRefresh?: OwnerRefreshDeps;
}

function roundUsd(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function newStepReport(step: RfbEnrichmentStep, cap: number): RfbEnrichmentStepReport {
  return {
    step,
    cap,
    eligible: 0,
    selected: 0,
    attempted: 0,
    written: 0,
    rejected: 0,
    errors: 0,
    outcomes: {},
    llm_calls: 0,
    llm_calls_per_row_max: rfbEnrichmentLlmCallsPerRowMax(step),
    est_cost_usd: 0,
    re_verified: 0,
    new_verified: 0,
    new_in_pool: 0,
    skipped_reason: null,
    stopped_reason: null,
    changed_agent_ids: [],
    rows: [],
    duration_ms: 0,
  };
}

function readVerifierLockState(db: Db, now: Date): { held: boolean; run_id: string | null; locked_at: string | null } {
  try {
    const row = db
      .prepare(`SELECT run_id, locked_at FROM orchestrator_locks WHERE agent = ?`)
      .get(VERIFIER_TICK_LOCK_AGENT) as { run_id: string; locked_at: string } | undefined;
    if (!row) return { held: false, run_id: null, locked_at: null };
    const lockedMs = Date.parse(row.locked_at);
    const held = !Number.isNaN(lockedMs) && lockedMs > now.getTime() - VERIFIER_TICK_LOCK_STALE_MINUTES * 60_000;
    return { held, run_id: row.run_id, locked_at: row.locked_at };
  } catch {
    return { held: false, run_id: null, locked_at: null };
  }
}

function isInPool(db: Db, agentId: string): boolean {
  try {
    return !!db.prepare(`SELECT 1 AS x FROM outreach_ready_pool WHERE agent_id = ?`).get(agentId);
  } catch {
    return false;
  }
}

// ─── Preview (dry run) ─────────────────────────────────────────────────────

/**
 * What every step WOULD take now, ids + counts. Read-only: no fetch, no
 * write, no lock, no envelope. Steps 3–4 read the URL probes as they stand
 * (step 1 may refresh some tonight); step 5 lists the unreachable-site rows
 * (tonight's changed rows are added at run time).
 */
export async function buildRfbEnrichmentPreview(db: Db, now: Date): Promise<RfbEnrichmentPreview> {
  const caps = resolveRfbEnrichmentCaps();
  const windowHours = resolveRfbEnrichmentWindowHours();
  const cohort = await loadRfbEnrichmentCohort(db);
  const ctx = buildSelectionContext(db, now.getTime(), readRfbEnrichmentAttempts(db));
  const perRow = {} as Record<RfbEnrichmentStep, number>;
  for (const s of RFB_ENRICHMENT_STEP_ORDER) perRow[s] = rfbEnrichmentLlmCallsPerRowMax(s);
  const steps: RfbEnrichmentPreview["steps"] = [];
  for (const step of RFB_ENRICHMENT_STEP_ORDER) {
    if (step === "bm_harvest") {
      const cur = getRfbEnrichmentBmCursor(db);
      steps.push({
        step,
        cap: caps[step],
        eligible: 0,
        selected: 0,
        selected_ids: [],
        note: "slugs are read from bondensmarked.no at run time; the window starts at the stored cursor; always fill_only=1, scoped to the cohort",
        bm: { offset: cur.next_offset, limit: caps[step], last_total: cur.total, cursor_updated_at: cur.updated_at },
      });
      continue;
    }
    const sel = await selectRfbEnrichmentStepRows(step, cohort, ctx, caps[step]);
    steps.push({
      step,
      cap: caps[step],
      eligible: sel.eligible,
      selected: sel.rows.length,
      selected_ids: sel.rows.map((r) => r.id),
      ...(Object.keys(sel.skipped).length > 0 ? { skipped: sel.skipped } : {}),
      ...(sel.a_url_only ? { a_url_only: sel.a_url_only } : {}),
      ...(step === "reverify" ? { note: "plus every row steps 1–4 change tonight (taken first, same cap)" } : {}),
    });
  }
  const last = getJobLastCompletedAt(db, RFB_ENRICHMENT_NIGHTLY_JOB_STATE_KEY);
  // Step 6 (OWNER_AUTO_UPDATES_ENABLED only — the preview is unchanged without it).
  const ownerRefresh = ownerAutoUpdatesEnabled()
    ? await buildOwnerRefreshPreview(db, {
        nowMs: now.getTime(),
        fillEmptyRetryMs: resolveRfbEnrichmentRetryDays() * 86_400_000,
        cap: resolveOwnerRefreshCap(),
      })
    : null;
  return {
    generated_at: now.toISOString(),
    enabled_by_env: isRfbEnrichmentNightlyEnabled(),
    window_hours_utc: windowHours,
    forbidden_hour_utc: RFB_ENRICHMENT_FORBIDDEN_HOUR_UTC,
    in_window_now: windowHours.includes(now.getUTCHours()),
    forbidden_now: isRfbEnrichmentForbiddenHour(now),
    last_run_at: last ? last.toISOString() : null,
    verifier_tick_lock: readVerifierLockState(db, now),
    caps,
    llm_cap: resolveRfbEnrichmentLlmCap(),
    llm_calls_per_row_max: perRow,
    max_runtime_minutes: resolveRfbEnrichmentMaxRuntimeMs() / 60_000,
    retry_days: resolveRfbEnrichmentRetryDays(),
    cohort: { considered: cohort.considered, eligible: cohort.rows.length, excluded: cohort.excluded, by_tier: cohort.by_tier },
    steps,
    ...(ownerRefresh ? { owner_refresh: ownerRefresh } : {}),
  };
}

// ─── The run ───────────────────────────────────────────────────────────────

let runInFlight = false;

/** Test-only: forget the in-process "a run is in flight" flag (simulates a new process). */
export function __resetRfbEnrichmentRunInFlightForTesting(): void {
  runInFlight = false;
}

/**
 * One run. `apply: false` = dry run: the preview, nothing else. `apply:
 * true` = the real thing, behind every guard in the header. Records one
 * run-ledger envelope for a run that got the lock (whatever happened after);
 * a skip records nothing, except an error before the lock (the night's one
 * `failed` no-run envelope). Never throws.
 */
export async function runRfbEnrichmentNightly(opts: {
  apply: boolean;
  trigger: "cron" | "manual";
  now?: Date;
  deps?: RfbEnrichmentNightlyDeps;
  /**
   * Manual only: allow a second apply run in a night that already had one.
   * Never lifts the per-night LLM cap, the 08Z ban or the lock.
   */
  force?: boolean;
}): Promise<RfbEnrichmentNightlyReport> {
  if (opts.apply && runInFlight) return runGuarded({ ...opts, alreadyRunning: true });
  if (!opts.apply) return runGuarded({ ...opts, alreadyRunning: false });
  runInFlight = true;
  try {
    return await runGuarded({ ...opts, alreadyRunning: false });
  } finally {
    runInFlight = false;
  }
}

async function runGuarded(opts: {
  apply: boolean;
  trigger: "cron" | "manual";
  now?: Date;
  deps?: RfbEnrichmentNightlyDeps;
  force?: boolean;
  alreadyRunning: boolean;
}): Promise<RfbEnrichmentNightlyReport> {
  const now = opts.now ?? new Date();
  const realStart = Date.now();
  const clock = opts.deps?.clock ?? ((): Date => new Date(now.getTime() + (Date.now() - realStart)));
  const day = now.toISOString().slice(0, 10);
  const runId =
    opts.trigger === "cron"
      ? `run-${day}-${RFB_ENRICHMENT_NIGHTLY_AGENT}`
      : `run-${day}-${RFB_ENRICHMENT_NIGHTLY_AGENT}-manual-${now.toISOString().slice(11, 23).replace(/[:.]/g, "")}-${Math.random().toString(16).slice(2, 6)}`;
  const enabled = isRfbEnrichmentNightlyEnabled();
  const caps = resolveRfbEnrichmentCaps();
  const llmCap = resolveRfbEnrichmentLlmCap();
  const usdPerCall = resolveRfbEnrichmentUsdPerCall();
  const meter: LlmCallMeter = createLlmCallMeter();
  const errors: string[] = [];
  const report: RfbEnrichmentNightlyReport = {
    run_id: runId,
    agent: RFB_ENRICHMENT_NIGHTLY_AGENT,
    vertical: "rfb",
    trigger: opts.trigger,
    apply: opts.apply,
    enabled_by_env: enabled,
    started_at: now.toISOString(),
    finished_at: now.toISOString(),
    skipped_reason: null,
    stopped_reason: null,
    deadline_at: null,
    write_deadline_at: null,
    lock: { acquired: false, released: false },
    caps,
    llm: { cap: llmCap, used_before_this_run: 0, run_budget: llmCap, calls: 0, est_cost_usd: 0, usd_per_call: usdPerCall, by_source: {}, cap_reached: false },
    cohort: null,
    steps: [],
    totals: { attempted: 0, written: 0, changed_agents: 0, re_verified: 0, new_verified: 0, new_in_pool: 0 },
    envelope_recorded: false,
    errors,
  };
  const done = (): RfbEnrichmentNightlyReport => {
    report.finished_at = clock().toISOString();
    report.llm.calls = meter.calls;
    report.llm.by_source = { ...meter.bySource };
    report.llm.est_cost_usd = roundUsd(meter.calls * usdPerCall);
    console.log(
      `[rfb-enrichment-nightly] run_id=${report.run_id} apply=${report.apply} enabled=${enabled} ` +
        `skipped=${report.skipped_reason ?? "-"} stopped=${report.stopped_reason ?? "-"} ` +
        `written=${report.totals.written} re_verified=${report.totals.re_verified} new_verified=${report.totals.new_verified} ` +
        `new_in_pool=${report.totals.new_in_pool} llm=${report.llm.calls}/${llmCap} envelope=${report.envelope_recorded}`,
    );
    return report;
  };

  let db: Db;
  try {
    db = getDb();
  } catch (err) {
    errors.push(`db unavailable: ${errMessage(err)}`);
    report.skipped_reason = "error";
    return done();
  }

  // ── Dry run: the preview, read-only, any time of day, flag on or off.
  if (!opts.apply) {
    try {
      const preview = await buildRfbEnrichmentPreview(db, now);
      report.preview = preview;
      report.cohort = preview.cohort;
    } catch (err) {
      errors.push(`preview failed: ${errMessage(err)}`);
      report.skipped_reason = "error";
    }
    return done();
  }

  if (!enabled) {
    report.skipped_reason = "disabled_by_env";
    return done();
  }
  if (opts.alreadyRunning) {
    report.skipped_reason = "run_in_progress";
    return done();
  }
  const deadline = computeRfbEnrichmentDeadline(now, resolveRfbEnrichmentMaxRuntimeMs());
  if (isRfbEnrichmentForbiddenHour(now) || deadline.getTime() - now.getTime() < RFB_ENRICHMENT_MIN_RUN_MS) {
    report.skipped_reason = "forbidden_hour";
    return done();
  }
  // One apply run per night (cron or manual) unless explicitly forced.
  {
    const last = getJobLastCompletedAt(db, RFB_ENRICHMENT_NIGHTLY_JOB_STATE_KEY);
    const nightStartMs = rfbEnrichmentNightStart(now).getTime();
    if (!opts.force && last && last.getTime() >= nightStartMs && last.getTime() <= now.getTime()) {
      report.skipped_reason = "already_ran_tonight";
      return done();
    }
  }
  const runMs = deadline.getTime() - now.getTime();
  const verifyReserveMs = Math.min(5 * 60_000, Math.floor(runMs * 0.25));
  const writeDeadline = new Date(deadline.getTime() - verifyReserveMs);
  report.deadline_at = deadline.toISOString();
  report.write_deadline_at = writeDeadline.toISOString();

  // ── The verifier's own tick lock: never concurrent with a verifier tick.
  let lock: ReturnType<typeof acquireLock>;
  try {
    lock = acquireLock({
      agent: VERIFIER_TICK_LOCK_AGENT,
      run_id: runId,
      started_at: now.toISOString(),
      staleMinutes: VERIFIER_TICK_LOCK_STALE_MINUTES,
      db,
    });
  } catch (err) {
    errors.push(`verifier tick lock unreadable: ${errMessage(err)}`);
    report.skipped_reason = "error";
    report.envelope_recorded = recordRfbEnrichmentNoRunEnvelope(db, now, "failed", opts.trigger, {
      reason: "error_before_lock",
      error: errMessage(err),
    });
    return done();
  }
  if (!lock.acquired) {
    report.skipped_reason = "verifier_tick_lock_held";
    report.lock = { acquired: false, holder: lock.holder, released: false };
    return done();
  }
  report.lock = { acquired: true, released: false };

  // The night is used up the moment a run holds the lock — before it can
  // spend a single LLM call. A run that then dies (deploy, OOM, restart)
  // leaves this stamp, so the next tick is already_ran_tonight instead of a
  // second full-budget run. Every skip path (flag off, in flight, forbidden
  // hour, already ran, lock held, error before the lock) returns ABOVE this
  // line, so a skip never consumes the night; nothing between the lock and
  // runSteps can skip.
  markJobCompleted(db, RFB_ENRICHMENT_NIGHTLY_JOB_STATE_KEY, now);

  // The LLM cap is per NIGHT: subtract what tonight already spent — the larger
  // of the envelopes' sum and the durable counter (which also covers a run
  // that died before its envelope). Unreadable → no LLM budget (fail closed);
  // the rest of the run goes on.
  let runBudget = 0;
  try {
    ensureRfbEnrichmentNightlyTables(db);
    const used = readRfbEnrichmentLlmSpentTonight(db, now);
    report.llm.used_before_this_run = used;
    runBudget = Math.max(0, llmCap - used);
  } catch (err) {
    errors.push(`LLM calls tonight unreadable — LLM steps skipped (fail closed): ${errMessage(err)}`);
  }
  report.llm.run_budget = runBudget;

  try {
    await runWithLlmCallMeter(meter, () =>
      runSteps({ db, report, now, clock, deadline, writeDeadline, meter, llmCap: runBudget, usdPerCall, deps: opts.deps }),
    );
  } catch (err) {
    errors.push(`run aborted: ${errMessage(err)}`);
  } finally {
    try {
      report.lock.released = releaseLock({ agent: VERIFIER_TICK_LOCK_AGENT, run_id: runId, db }).released;
    } catch (err) {
      errors.push(`verifier tick lock not released (expires on its own): ${errMessage(err)}`);
    }
  }

  // (The night was stamped when the lock was taken — see above.)
  recordEnvelope(db, report, meter, usdPerCall, clock);
  return done();
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface RunContext {
  db: Db;
  report: RfbEnrichmentNightlyReport;
  now: Date;
  clock: () => Date;
  deadline: Date;
  writeDeadline: Date;
  meter: LlmCallMeter;
  /** This run's LLM budget (the per-night cap minus what tonight already used). */
  llmCap: number;
  usdPerCall: number;
  deps?: RfbEnrichmentNightlyDeps;
}

async function runSteps(rc: RunContext): Promise<void> {
  const { db, report, now, clock, meter, llmCap, usdPerCall } = rc;
  const batchId = `rfb-enrichment-nightly-${now.toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
  const exec: RfbEnrichmentExecutors = {
    ...createDefaultRfbEnrichmentExecutors(db, batchId, rc.deps?.productNameExtractor),
    ...(rc.deps?.executors ?? {}),
  };

  const cohort = await loadRfbEnrichmentCohort(db);
  report.cohort = { considered: cohort.considered, eligible: cohort.rows.length, excluded: cohort.excluded, by_tier: cohort.by_tier };
  const attempts = readRfbEnrichmentAttempts(db);

  /** agent_id → the first step that changed it tonight (step 5's work list, in order). */
  const changed = new Map<string, RfbEnrichmentStep>();
  let globalStop: string | null = null;
  let llmCapReached = false;
  let writesPaused = false;

  const writePauseActive = (): boolean => {
    try {
      return enrichmentWritePauseBlock(() => db, "rfb") !== null;
    } catch {
      return true; // unreadable → fail closed, same as the routes
    }
  };

  /** Why the next row may not start (null = go). */
  const stopBefore = (step: RfbEnrichmentStep, perRowLlm: number): string | null => {
    const t = clock();
    if (isRfbEnrichmentForbiddenHour(t)) {
      globalStop = "forbidden_hour";
      return globalStop;
    }
    if (t.getTime() >= rc.deadline.getTime()) {
      globalStop = "time_budget";
      return globalStop;
    }
    if (WRITING_STEPS.has(step) && t.getTime() >= rc.writeDeadline.getTime()) return "time_budget";
    if (perRowLlm > 0 && meter.calls + perRowLlm > llmCap) {
      llmCapReached = true;
      return "llm_cap_reached";
    }
    if (WRITING_STEPS.has(step) && writePauseActive()) {
      writesPaused = true;
      return "enrichment_write_paused";
    }
    return null;
  };

  /**
   * Durable LLM reservation (NB1): before an LLM-capable row starts, add its
   * worst case to the night's counter; null when the counter cannot be
   * written — then every LLM step stops for the night (fail closed).
   */
  const reserveLlm = (perRowLlm: number): number | null => {
    if (perRowLlm <= 0) return 0;
    try {
      bumpRfbEnrichmentNightLlmCounter(db, now, perRowLlm, clock());
      return perRowLlm;
    } catch (err) {
      llmCapReached = true;
      report.errors.push(`LLM counter unwritable — LLM steps stopped (fail closed): ${errMessage(err)}`);
      return null;
    }
  };
  /**
   * After the row: replace the reservation by the calls it really made — but
   * a timed-out row keeps at least its reservation (settledLlmCalls), because
   * the abandoned call may still spend it later.
   */
  const settleLlm = (reserved: number, actual: number): void => {
    if (reserved <= 0 && actual <= 0) return;
    if (actual === reserved) return;
    try {
      bumpRfbEnrichmentNightLlmCounter(db, now, actual - reserved, clock());
    } catch {
      // the reservation stays: over-counting is the safe direction
    }
  };

  /** Why a whole step may not start (null = go). */
  const skipStep = (step: RfbEnrichmentStep, cap: number): string | null => {
    if (globalStop) return globalStop;
    if (cap <= 0) return "cap_zero";
    // A step whose model call is optional per row still runs for the rows
    // that need none (RFB_ENRICHMENT_LLM_OPTIONAL_STEPS).
    const stepLlm = RFB_ENRICHMENT_LLM_OPTIONAL_STEPS.has(step) ? 0 : rfbEnrichmentLlmCallsPerRowMax(step);
    if (stepLlm > 0 && llmCapReached) return "llm_cap_reached";
    if (WRITING_STEPS.has(step) && writesPaused) return "enrichment_write_paused";
    return stopBefore(step, stepLlm);
  };

  const finishStep = (sr: RfbEnrichmentStepReport, t0: number, llmBefore: number): void => {
    sr.llm_calls = meter.calls - llmBefore;
    sr.est_cost_usd = roundUsd(sr.llm_calls * usdPerCall);
    sr.duration_ms = Date.now() - t0;
    sr.rows = sr.rows.slice(0, 100);
    report.steps.push(sr);
    if (sr.stopped_reason && !report.stopped_reason) report.stopped_reason = `${sr.step}:${sr.stopped_reason}`;
  };

  /** extra[group][key] += 1 (the step's envelope claim carries extra). */
  const tallyExtra = (sr: RfbEnrichmentStepReport, group: string, key: string): void => {
    const extra = (sr.extra ??= {});
    const m = (extra[group] ??= {}) as Record<string, number>;
    m[key] = (m[key] ?? 0) + 1;
  };

  const tally = (sr: RfbEnrichmentStepReport, agentId: string, out: RfbEnrichmentRowOutcome): void => {
    sr.attempted++;
    sr.outcomes[out.outcome] = (sr.outcomes[out.outcome] ?? 0) + 1;
    if (out.error) sr.errors++;
    if (out.written) sr.written++;
    else sr.rejected++;
    if (out.changed && !changed.has(agentId)) {
      changed.set(agentId, sr.step);
      sr.changed_agent_ids.push(agentId);
    }
    if (out.categories_corroboration) {
      const extra = (sr.extra ??= {});
      const tallyMap = (extra.categories_corroboration ??= {}) as Record<string, number>;
      tallyMap[out.categories_corroboration] = (tallyMap[out.categories_corroboration] ?? 0) + 1;
    }
    if (out.product_names) tallyExtra(sr, "product_names", out.product_names);
    sr.rows.push({ agent_id: agentId, outcome: out.outcome, ...(out.detail ? { detail: out.detail.slice(0, 200) } : {}) });
  };

  const runRowStep = async (
    step: RfbEnrichmentStep,
    run: (row: RfbEnrichmentCohortRow, rowLlm: number) => Promise<RfbEnrichmentRowOutcome>,
  ): Promise<void> => {
    const t0 = Date.now();
    const llmBefore = meter.calls;
    const sr = newStepReport(step, report.caps[step]);
    const skip = skipStep(step, sr.cap);
    if (skip) {
      sr.skipped_reason = skip;
      finishStep(sr, t0, llmBefore);
      return;
    }
    if (step === "contact_extraction" || step === "content_refresh") await refreshCohortRows(db, cohort);
    const sel = await selectRfbEnrichmentStepRows(step, cohort, buildSelectionContext(db, now.getTime(), attempts), sr.cap);
    sr.eligible = sel.eligible;
    sr.selected = sel.rows.length;
    if (Object.keys(sel.skipped).length > 0 || sel.a_url_only) {
      sr.extra = {
        ...(Object.keys(sel.skipped).length > 0 ? { skipped_before_selection: sel.skipped } : {}),
        ...(sel.a_url_only ? { a_url_only: sel.a_url_only } : {}),
      };
    }
    const llmOptional = RFB_ENRICHMENT_LLM_OPTIONAL_STEPS.has(step);
    // Brreg outage guard (R3-NB1): consecutive brreg_contact_fetch_failed rows
    // are held back unstamped; a different outcome (or the end of the step)
    // stamps them as the real per-row outcomes they were, while the third in
    // a row stops the step for the night and leaves all three unstamped.
    const pendingFetchFailed: Array<{ id: string; outcome: string }> = [];
    const flushPending = () => {
      for (const p of pendingFetchFailed) stampAttempt(db, p.id, step, clock(), p.outcome, report.run_id);
      pendingFetchFailed.length = 0;
    };
    for (const row of sel.rows) {
      await yieldToEventLoop();
      const perRowLlm = rfbEnrichmentRowLlmCallsMax(step, row);
      const stop = stopBefore(step, llmOptional ? 0 : perRowLlm);
      if (stop) {
        sr.stopped_reason = stop;
        break;
      }
      if (llmOptional && rfbEnrichmentRowWantsProductNames(step, row) && perRowLlm === 0) {
        // No API key: the row runs without the product-name call.
        tallyExtra(sr, "product_names", "skipped_no_api_key");
      }
      if (llmOptional && perRowLlm > 0 && (llmCapReached || meter.calls + perRowLlm > llmCap)) {
        // Tonight's LLM budget is spent: this row (it needs the model call) is
        // left for another night — not attempted, not stamped; rows that need
        // no call go on.
        llmCapReached = true;
        tallyExtra(sr, "product_names", "skipped_llm_cap");
        continue;
      }
      const reserved = reserveLlm(perRowLlm);
      if (reserved === null) {
        if (llmOptional) {
          // Counter unwritable: llmCapReached is set; run the row without the call.
          tallyExtra(sr, "product_names", "skipped_llm_counter_unwritable");
        } else {
          sr.stopped_reason = "llm_counter_unwritable";
          break;
        }
      }
      const callsBefore = meter.calls;
      const rowLlm = reserved ?? 0;
      let out: RfbEnrichmentRowOutcome;
      try {
        out = await run(row, rowLlm);
      } catch (err) {
        out = { outcome: "error", written: false, changed: false, error: true, detail: errMessage(err) };
      }
      // A route call that timed out (504) may still be working, and its judge
      // call can land AFTER this point (B1): keep at least the reservation.
      settleLlm(rowLlm, settledLlmCalls(out.outcome, out.stop, rowLlm, meter.calls - callsBefore));
      tally(sr, row.id, out);
      if (step === "brreg_contact" && out.outcome === RFB_ENRICHMENT_BRREG_FETCH_FAILED) {
        pendingFetchFailed.push({ id: row.id, outcome: out.outcome });
        if (pendingFetchFailed.length >= RFB_ENRICHMENT_BRREG_OUTAGE_STREAK) {
          pendingFetchFailed.length = 0; // an outage parks nobody
          sr.stopped_reason = "brreg_unavailable";
          break;
        }
        continue;
      }
      flushPending();
      // Only a real per-row outcome enters the rotation memory; a transient
      // one (timeout, 5xx, error, write-pause, missing admin key, the tool's
      // own run-lock) is retried tomorrow, not parked for the retry window.
      if (!isTransientRfbEnrichmentOutcome(out)) stampAttempt(db, row.id, step, clock(), out.outcome, report.run_id);
      if (out.stop) {
        sr.stopped_reason = out.stop;
        if (out.stop === "enrichment_write_paused") writesPaused = true;
        // A route that never answered may still be working (and could still
        // make its one model call): start nothing else tonight.
        if (out.stop === "route_timeout") globalStop = "route_timeout";
        break;
      }
    }
    flushPending(); // fewer than three in a row: real per-row outcomes
    finishStep(sr, t0, llmBefore);
  };

  // 1–2b
  await runRowStep("url_check", (row) => exec.urlCheck(row));
  await runRowStep("email_domain_website", (row) => exec.emailDomainWebsite(row));
  await runRowStep("brreg_contact", (row) => exec.brregContact(row));

  // 2c — Bondens Marked: one in-process call over the cursor's window.
  {
    const step: RfbEnrichmentStep = "bm_harvest";
    const t0 = Date.now();
    const llmBefore = meter.calls;
    const sr = newStepReport(step, report.caps[step]);
    let skip = skipStep(step, sr.cap);
    if (!skip && rc.writeDeadline.getTime() - clock().getTime() < RFB_ENRICHMENT_BM_MIN_REMAINING_MS) skip = "time_budget";
    if (skip) {
      sr.skipped_reason = skip;
    } else {
      await yieldToEventLoop();
      const cursor = getRfbEnrichmentBmCursor(db);
      let offset = cursor.next_offset;
      let out: RfbEnrichmentBmOutcome;
      try {
        const scopeAgentIds = cohort.rows.map((r) => r.id);
        out = await exec.bmHarvest({ offset, limit: sr.cap, scopeAgentIds });
        // The catalog shrank below the stored cursor: start over at 0 now.
        if (out.status === 200 && out.total_slugs > 0 && out.scanned === 0 && offset >= out.total_slugs) {
          offset = 0;
          out = await exec.bmHarvest({ offset, limit: sr.cap, scopeAgentIds });
        }
      } catch (err) {
        out = {
          status: 500, total_slugs: 0, offset, scanned: 0, time_budget_exceeded: false, counts: {},
          changed_agent_ids: [], written: 0, error: errMessage(err),
        };
      }
      const next = out.status === 200 ? nextBmCursor(offset, out.scanned, out.total_slugs) : offset;
      if (out.status === 200 && out.total_slugs > 0) {
        try {
          setRfbEnrichmentBmCursor(db, next, out.total_slugs, clock());
        } catch (err) {
          report.errors.push(`bm cursor not stored: ${errMessage(err)}`);
        }
      }
      sr.selected = out.scanned;
      sr.attempted = out.scanned;
      sr.written = out.written;
      sr.rejected = Math.max(0, out.scanned - out.written);
      sr.outcomes = { ...out.counts };
      if (out.error) {
        sr.errors = 1;
        sr.stopped_reason = out.status === 423 ? "enrichment_write_paused" : `error:${out.error}`.slice(0, 120);
      } else if (out.time_budget_exceeded) {
        sr.stopped_reason = "route_time_budget";
      }
      for (const id of out.changed_agent_ids) {
        if (!changed.has(id)) {
          changed.set(id, step);
          sr.changed_agent_ids.push(id);
        }
      }
      sr.extra = {
        offset,
        next_offset: next,
        total_slugs: out.total_slugs,
        scanned: out.scanned,
        time_budget_exceeded: out.time_budget_exceeded,
        wrapped: next === 0 && out.status === 200 && out.total_slugs > 0,
      };
    }
    finishStep(sr, t0, llmBefore);
  }

  // 3–4
  await runRowStep("contact_extraction", (row) => exec.contactExtraction(row));
  await runRowStep("content_refresh", (row, rowLlm) =>
    exec.contentRefresh(
      row,
      Math.min(Date.now() + RFB_ENRICHMENT_REFRESH_PER_ROW_MS, Date.now() + (rc.writeDeadline.getTime() - clock().getTime())),
      // The product-name call only with this row's reservation in place.
      rowLlm > 0 ? { productNames: true } : undefined,
    ),
  );

  // 5 — re-verify: tonight's changed rows first, then unreachable-site rows.
  {
    const step: RfbEnrichmentStep = "reverify";
    const t0 = Date.now();
    const llmBefore = meter.calls;
    const sr = newStepReport(step, report.caps[step]);
    const skip = skipStep(step, sr.cap);
    if (skip) {
      sr.skipped_reason = skip;
      // The changed rows are not verified tonight; the hourly verifier reaches them.
    } else {
      const work: Array<{ id: string; source: RfbEnrichmentStep | "unreachable_14d" }> = [];
      for (const [id, from] of changed) work.push({ id, source: from });
      const sel = await selectRfbEnrichmentStepRows(step, cohort, buildSelectionContext(db, now.getTime(), attempts), sr.cap);
      for (const r of sel.rows) if (!changed.has(r.id)) work.push({ id: r.id, source: "unreachable_14d" });
      const take = work.slice(0, sr.cap);
      sr.eligible = work.length;
      sr.selected = take.length;
      const perRowLlm = rfbEnrichmentLlmCallsPerRowMax(step);
      const byTransition: Record<string, number> = {};
      const stepReports = new Map(report.steps.map((s) => [s.step, s]));
      let terminal = 0;
      for (const w of take) {
        await yieldToEventLoop();
        const stop = stopBefore(step, perRowLlm);
        if (stop) {
          sr.stopped_reason = stop;
          break;
        }
        const reserved = reserveLlm(perRowLlm);
        if (reserved === null) {
          sr.stopped_reason = "llm_counter_unwritable";
          break;
        }
        const callsBefore = meter.calls;
        const before = isInPool(db, w.id);
        let out: RfbEnrichmentReverifyOutcome;
        try {
          out = await exec.reverify(w.id);
        } catch (err) {
          out = { outcome: "error", prior: null, next: null, error: true, detail: errMessage(err) };
        }
        settleLlm(reserved, settledLlmCalls(out.outcome, undefined, reserved, meter.calls - callsBefore));
        const after = isInPool(db, w.id);
        sr.attempted++;
        sr.outcomes[out.outcome] = (sr.outcomes[out.outcome] ?? 0) + 1;
        if (out.error) sr.errors++;
        else sr.written++;
        const key = `${out.prior ?? "?"}->${out.next ?? "?"}`;
        byTransition[key] = (byTransition[key] ?? 0) + 1;
        const newlyVerified = out.prior !== "verified" && out.next === "verified";
        const newlyInPool = !before && after;
        if (out.next === "terminal_unconfirmable" && out.prior !== "terminal_unconfirmable") terminal++;
        if (!out.error) sr.re_verified++;
        if (newlyVerified) sr.new_verified++;
        if (newlyInPool) sr.new_in_pool++;
        if (w.source !== "unreachable_14d") {
          const origin = stepReports.get(w.source);
          if (origin && !out.error) origin.re_verified++;
          if (origin && newlyVerified) origin.new_verified++;
          if (origin && newlyInPool) origin.new_in_pool++;
        } else if (!out.error) {
          stampAttempt(db, w.id, step, clock(), out.outcome, report.run_id);
        }
        sr.changed_agent_ids.push(w.id);
        sr.rows.push({ agent_id: w.id, outcome: key, detail: `${w.source}${newlyInPool ? " +pool" : ""}${out.detail ? ` ${out.detail}` : ""}`.slice(0, 200) });
      }
      sr.rejected = 0;
      sr.extra = { by_transition: byTransition, new_terminal_unconfirmable: terminal, changed_tonight: changed.size };
    }
    finishStep(sr, t0, llmBefore);
  }

  // 6 — owner refresh (OWNER_AUTO_UPDATES_ENABLED only; header step 6). After
  // step 5 on purpose: steps 1–5 above ran exactly as without it. It may use
  // the time up to the run deadline (step 5's reserve is spent) and what is
  // left of tonight's LLM budget; its outcomes stay out of report.steps,
  // `totals` and the run's stopped_reason (its own report has them).
  if (ownerAutoUpdatesEnabled()) {
    const t0 = Date.now();
    const llmBefore = meter.calls;
    const orr = newOwnerRefreshStepReport(resolveOwnerRefreshCap());
    report.owner_refresh = orr;
    const skip = globalStop ?? (orr.cap <= 0 ? "cap_zero" : writesPaused ? "enrichment_write_paused" : null);
    if (skip) {
      orr.skipped_reason = skip;
    } else {
      try {
        const cohort = await loadOwnerRefreshCohort(db, {
          nowMs: now.getTime(),
          fillEmptyRetryMs: resolveRfbEnrichmentRetryDays() * 86_400_000,
        });
        const take = cohort.eligible.slice(0, orr.cap);
        orr.considered = cohort.considered;
        orr.eligible = cohort.eligible.length;
        orr.selected = take.length;
        orr.skipped_before_selection = cohort.skipped;
        for (const row of take) {
          await yieldToEventLoop();
          const t = clock();
          if (isRfbEnrichmentForbiddenHour(t)) { orr.stopped_reason = "forbidden_hour"; break; }
          if (t.getTime() >= rc.deadline.getTime()) { orr.stopped_reason = "time_budget"; break; }
          if (writePauseActive()) { orr.stopped_reason = "enrichment_write_paused"; break; }
          const perRowLlm = ownerRefreshRowLlmCallsMax(row);
          if (perRowLlm > 0 && (llmCapReached || meter.calls + perRowLlm > llmCap)) {
            // Tonight's LLM budget is spent: a profile that needs the about
            // judges waits (not attempted, not stamped); the others go on.
            llmCapReached = true;
            orr.outcomes.skipped_llm_cap = (orr.outcomes.skipped_llm_cap ?? 0) + 1;
            continue;
          }
          const reserved = reserveLlm(perRowLlm);
          if (reserved === null) {
            orr.outcomes.skipped_llm_counter_unwritable = (orr.outcomes.skipped_llm_counter_unwritable ?? 0) + 1;
            continue;
          }
          const callsBefore = meter.calls;
          let out: OwnerRefreshRowOutcome;
          try {
            out = await refreshOwnedProfile(db, row, {
              deadlineAt: Date.now() + Math.min(OWNER_REFRESH_PER_ROW_MS, rc.deadline.getTime() - clock().getTime()),
              runId: report.run_id,
              deps: rc.deps?.ownerRefresh,
            });
          } catch (err) {
            // refreshOwnedProfile catches its own failures; anything that still
            // throws is a real outcome too (stamped), never retried every night.
            out = { outcome: "error", written: [], refused: [], detail: errMessage(err) };
          }
          // A refresh we stopped waiting for may still make its judge calls.
          const actual = meter.calls - callsBefore;
          settleLlm(reserved, out.outcome === "timeout" ? Math.max(reserved, actual) : actual);
          tallyOwnerRefreshRow(orr, row, out);
          if (!out.transient) stampAttempt(db, row.id, OWNER_REFRESH_STEP, clock(), out.outcome, report.run_id);
        }
      } catch (err) {
        orr.errors.push(`owner refresh aborted: ${errMessage(err)}`);
      }
    }
    orr.llm_calls = meter.calls - llmBefore;
    orr.est_cost_usd = roundUsd(orr.llm_calls * usdPerCall);
    orr.duration_ms = Date.now() - t0;
    orr.rows = orr.rows.slice(0, 100);
  }

  report.llm.cap_reached = llmCapReached;
  if (globalStop && !report.stopped_reason) report.stopped_reason = globalStop;
  const t = report.totals;
  for (const s of report.steps) {
    if (s.step === "reverify") continue;
    t.attempted += s.attempted;
    t.written += s.written;
  }
  t.changed_agents = changed.size;
  const rv = report.steps.find((s) => s.step === "reverify");
  t.re_verified = rv?.re_verified ?? 0;
  t.new_verified = rv?.new_verified ?? 0;
  t.new_in_pool = rv?.new_in_pool ?? 0;
}

// ─── Envelope ──────────────────────────────────────────────────────────────

function recordEnvelope(
  db: Db,
  report: RfbEnrichmentNightlyReport,
  meter: LlmCallMeter,
  usdPerCall: number,
  clock: () => Date,
): void {
  try {
    const isTaken = db.prepare(`SELECT 1 FROM runs WHERE run_id = ?`);
    const base = report.run_id;
    let n = 0;
    while (isTaken.get(report.run_id)) {
      n += 1;
      report.run_id = `${base}-${clock().toISOString().slice(11, 23).replace(/[:.]/g, "")}${n > 1 ? `-${n}` : ""}`;
    }
  } catch {
    // ledger unavailable — recordRun below reports it
  }
  const finishedAt = clock().toISOString();
  const stepsRan = report.steps.some((s) => s.attempted > 0);
  const troubled =
    report.errors.length > 0 || report.stopped_reason !== null || report.steps.some((s) => s.errors > 0 || s.stopped_reason !== null);
  const status = report.errors.some((e) => e.startsWith("run aborted")) && !stepsRan ? "failed" : troubled ? "partial" : "completed";
  const llmCalls = meter.calls;
  const short: Record<RfbEnrichmentStep, string> = {
    url_check: "url",
    email_domain_website: "maildomain",
    brreg_contact: "brreg",
    bm_harvest: "bm",
    contact_extraction: "contact",
    content_refresh: "content",
    reverify: "verify",
  };
  const notes = (
    report.steps
      .map((s) => `${short[s.step]}=${s.written}/${s.attempted}${s.skipped_reason ? `(skip:${s.skipped_reason})` : s.stopped_reason ? `(stop:${s.stopped_reason})` : ""}`)
      .join(" ") +
    ` new_verified=${report.totals.new_verified} new_in_pool=${report.totals.new_in_pool}` +
    ` llm=${llmCalls}/${report.llm.cap} est_usd=${roundUsd(llmCalls * usdPerCall)}` +
    (report.stopped_reason ? ` stopped=${report.stopped_reason}` : "") +
    (report.errors.length > 0 ? ` errors=${report.errors.length}` : "")
  ).slice(0, 490);
  const stepClaims = report.steps.map((s) => ({
    type: "custom" as const,
    value: s.written,
    meta: {
      kind: `rfb_enrichment_step_${s.step}`,
      step: s.step,
      cap: s.cap,
      eligible: s.eligible,
      selected: s.selected,
      attempted: s.attempted,
      written: s.written,
      rejected: s.rejected,
      rejected_reasons: Object.fromEntries(Object.entries(s.outcomes).filter(([k]) => !isWrittenOutcome(s.step, k))),
      outcomes: s.outcomes,
      errors: s.errors,
      llm_calls: s.llm_calls,
      est_cost_usd: s.est_cost_usd,
      re_verified: s.re_verified,
      new_verified: s.new_verified,
      new_in_pool: s.new_in_pool,
      skipped_reason: s.skipped_reason,
      stopped_reason: s.stopped_reason,
      agent_ids: s.changed_agent_ids.slice(0, 100),
      ...(s.extra ? { extra: s.extra } : {}),
    },
  }));
  const reverifyIdx = report.steps.findIndex((s) => s.step === "reverify");
  try {
    recordRun({
      run_id: report.run_id,
      vertical: "rfb",
      agent: RFB_ENRICHMENT_NIGHTLY_AGENT,
      trigger_source: report.trigger === "cron" ? "cron" : "manual",
      started_at: report.started_at,
      finished_at: finishedAt,
      status,
      claims: [
        ...stepClaims,
        {
          type: "custom",
          value: llmCalls,
          meta: {
            kind: "rfb_enrichment_llm_calls",
            cap: report.llm.cap,
            cap_scope: "night",
            used_before_this_run: report.llm.used_before_this_run,
            run_budget: report.llm.run_budget,
            cap_reached: report.llm.cap_reached,
            est_cost_usd: roundUsd(llmCalls * usdPerCall),
            usd_per_call: usdPerCall,
            by_source: { ...meter.bySource },
          },
        },
        {
          type: "custom",
          value: report.totals.new_in_pool,
          meta: {
            kind: "rfb_enrichment_totals",
            ...report.totals,
            cohort: report.cohort,
            deadline_at: report.deadline_at,
            stopped_reason: report.stopped_reason,
          },
        },
        // Step 6 (OWNER_AUTO_UPDATES_ENABLED only): its own claim, so the
        // claims above read exactly as without it. Its errors are here, not
        // in the run's status.
        ...(report.owner_refresh
          ? [{
              type: "custom" as const,
              value: report.owner_refresh.written,
              meta: {
                kind: "rfb_enrichment_owner_refresh",
                cap: report.owner_refresh.cap,
                considered: report.owner_refresh.considered,
                eligible: report.owner_refresh.eligible,
                selected: report.owner_refresh.selected,
                attempted: report.owner_refresh.attempted,
                written: report.owner_refresh.written,
                fields_written: report.owner_refresh.fields_written,
                refused: report.owner_refresh.refused,
                outcomes: report.owner_refresh.outcomes,
                skipped_before_selection: report.owner_refresh.skipped_before_selection,
                skipped_reason: report.owner_refresh.skipped_reason,
                stopped_reason: report.owner_refresh.stopped_reason,
                llm_calls: report.owner_refresh.llm_calls,
                est_cost_usd: report.owner_refresh.est_cost_usd,
                agent_ids: report.owner_refresh.changed_agent_ids.slice(0, 100),
                errors: report.owner_refresh.errors,
              },
            }]
          : []),
      ],
      evidence:
        reverifyIdx >= 0
          ? [{ claim_idx: reverifyIdx, ids: report.steps[reverifyIdx].changed_agent_ids.slice(0, 100) }]
          : [],
      errors: report.errors.length > 0 ? report.errors.map((message) => ({ message })) : undefined,
      notes,
    });
    report.envelope_recorded = true;
  } catch (err) {
    console.error("[rfb-enrichment-nightly] run envelope not recorded (non-fatal):", err);
  }
}

/** Outcomes that count as `written` per step (for the rejected-reasons split). */
function isWrittenOutcome(step: RfbEnrichmentStep, outcome: string): boolean {
  switch (step) {
    case "url_check":
      return outcome.startsWith("probe_");
    case "email_domain_website":
      return outcome === "queued";
    case "brreg_contact":
      return outcome === "email_written" || outcome === "org_nr_written" || outcome === "website_proposed";
    case "bm_harvest":
      return outcome === "written" || outcome === "phone_written" || outcome === "url_proposed";
    case "contact_extraction":
      return outcome === "written";
    case "content_refresh":
      return (
        outcome === "refreshed" ||
        outcome === RFB_ENRICHMENT_CATEGORIES_CORROBORATED ||
        outcome === RFB_ENRICHMENT_PRODUCTS_REPLACED
      );
    case "reverify":
      return outcome !== "error" && outcome !== "not_found";
  }
}
