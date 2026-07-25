// ─── RFB Agents Geocode Worker ──────────────────────────────────────
// dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 1a.
//
// The `agents` table (rettfrabonden.com producers) was the ONLY vertical
// without a geocoding worker: dental has dental-geocode-worker.ts, experiences
// has experiences-geocode-worker.ts, RFB had nothing. Coordinates came from
// seed files (src/_seeds/seed-expansion-v2.ts:55,73) and were often a city
// centroid. Measured live 2026-07-25: 948 / 1 499 active producers (63.2 %)
// have lat/lng; 551 (36.8 %) have NONE and are invisible to every geo-filtered
// search. Fase 2's route-corridor search at 10–25 km is meaningless on top of
// that, which is why this lands first.
//
// Structure is deliberately the experiences worker's (same batching, same
// injectable fetch/sleep seam, same try/catch-per-row so one bad record can
// never crash a tick, same "ORDER BY … LIMIT" work-queue), with two additions
// the RFB table needs:
//
//   Tier A — address precision. agent_knowledge.address + postal_code →
//            Kartverket adresser/v1/sok via geocodeOne() (the SAME 4-step
//            retry ladder dental + experiences already use — not
//            re-implemented here). Writes geo_precision='address'.
//   Tier B — city-centroid fallback, ONLY for rows that have no coordinates
//            at all. Goes through geocodingService.geocodePlaceForBackfill(),
//            which is the Fase-0 hardened lookup (navneobjekttype allowlist,
//            `navnestatus` name-similarity guard, ambiguity refusal — so
//            "blåskjell Kautokeino" → Larvik is rejected, not stored) MINUS
//            the local-DB tier and PLUS a kommune corroboration step. Both of
//            those differences were forced by review; see that function's
//            header, and REASON 3 below. Writes 'city' only for a town-scale
//            hit, 'kommune' otherwise — tiers the honesty rule
//            (geo-precision.ts, 1c) renders WITHOUT a km figure.
//   Tier C — the producer NAME's place suffix. See the census below.
//
// ═══════════════════════════════════════════════════════════════════
// THROUGHPUT + COVERAGE FOLLOW-UP (2026-07-25 evening)
// ═══════════════════════════════════════════════════════════════════
// Daniel, looking at the queue a few hours after this worker shipped:
//   «Det ser ut som veldig mange fortsatt står med ukjent opphav. Vi burde
//    lage en pr som forbedrer og fikser dette.»
//
// He was right twice over, and the two reasons are different.
//
// ── Measured live, 2026-07-25T22:17Z ───────────────────────────────
// POST /admin/agents/geocode-batch {limit:1, dry_run:true} reported:
//     active 1595 · address_precision 146 · centroid 4 ·
//     unknown_precision 1445 · missing_coordinates 502 · pending 1022
// and a full per-row census (GET /admin/agents/dump for all 1 595 active rows
// + GET /admin/agents/:id/knowledge for each) cross-tabulated as:
//
//     address + postnummer .................. 1148   Tier-A eligible
//     address, NO postnummer ................   61   postal-backfill's queue
//                                                    (47 already carry the
//                                                     postnummer inline in the
//                                                     address text)
//     no address, has city ..................  134
//     no address, no city ...................  253
//                                              ────
//                                              1595
//
// REASON 1 — CADENCE, not the API. 1 022 pending ÷ 50 rows/hour ≈ 20.4 HOURS,
// while a dry-run probe resolved «Matgalleriet Molde» → address/high in
// 432 ms. Fixed by the adaptive cadence (backfill-scheduler.ts): 60 s between
// ticks while a backlog exists, decaying back to hourly by itself once it is
// drained. ~3 000 rows/hour instead of 50, and the whole backlog drains in
// well under an hour. Bounded by ONE process-wide 2 req/s budget shared with
// the postal-backfill worker (kartverket-budget.ts) — the "not yet shared"
// follow-up that worker's header flagged, which stopped being optional the
// moment this one got 60× faster.
//
// REASON 2 — A STRUCTURALLY UNREACHABLE COHORT. unknown_precision 1445 but
// pending only 1022: ~423 rows the selector could never even pick. Derived
// from the census + the exact `pending` formula:
//     • ~61  have a street address but no postnummer. NOT stuck — this is the
//            postal-backfill worker's queue, and the two workers COOPERATE
//            (it clears geocode_attempted_at, and now geocode_attempts, when
//            it lands a postnummer, so the row jumps to the head of THIS
//            worker's queue instead of waiting a full rotation).
//     • ~110 have a city AND already carry a seed coordinate. Tier B refuses
//            to touch a row that already has a position — swapping an
//            untagged seed coordinate for a city centroid is a guess dressed
//            as an improvement. That refusal stands. What changes is that
//            they are now COUNTED and NAMED in the queue status instead of
//            sitting in "unknown, might be fixable" for ever.
//     • ~253 have neither address nor city. These are the ones Tier C exists
//            for.
//
// ── Tier C — the place suffix RFB's own naming convention already carries ──
// 244 of those 253 rows are named «<Producer> — <Place>»: "Straumbotn Gård —
// Rana", "Bakeverkstedet Salten — Misvær", "Dalheim Gård og Gårdsysteri —
// Kvæfjord". That suffix is a real signal and it was measured before it was
// trusted: all 194 DISTINCT suffix tokens in that cohort were run against
// LIVE Kartverket through this repo's own hardened lookup (type allowlist +
// hovednavn similarity guard + ambiguity refusal), and **174 of 194 (89.7 %)
// resolved**. The 20 that do not (Fenstad, Røyse, Fiskum, Hell, Sørum,
// Krokkleiva, …) are the guard refusing rather than guessing.
//
// THAT FIGURE CAME WITH A CAVEAT THE FIRST VERSION MISSED, and review caught
// it: the measurement ran against an EMPTY `agents` table, while
// geocodingService.geocode() consults the local `agents` table BEFORE
// Kartverket. 80 of the 183 distinct tokens (44 %) exactly match an existing
// agents.city, so in production those rows would have taken the local-DB tier
// and adopted ANOTHER PRODUCER'S SEED COORDINATE — reproduced end to end: «Ny
// Gård — Hegra» landed on a sibling row's TROMSØ position, written as
// source=database, precision=city. Both centroid tiers now call
// geocodePlaceForBackfill(), which has no DB tier at all, so the measured path
// and the production path are the same path.
//
// Tier C NEVER invents a coordinate and never licenses a km figure: it can
// only ever write 'city' or 'kommune' precision, the tiers geo-precision.ts's
// honesty rule renders as «i X-området». And it only runs on rows that have
// NO coordinates at all, exactly like Tier B.
//
// For that label to say anything at all, the resolved place is persisted in
// agents.geo_place_label. This cohort has city = NULL by definition, and
// formatRfbDistanceLabel() falls back to the bare «omtrentlig posisjon» without
// a city — worse still, marketplace-registry's location mapping had a legacy
// `row.city || "Oslo"` default, so ~250 producers in Rana, Misvær and Flåm
// would each have been announced as «i Oslo-området». Being visible somewhere
// wrong is not an improvement on being invisible.
//
// ── REASON 3 (review) — a hamlet can outrank the kommune it shares a name with
// The hardened lookup accepts a REGION or MINOR-settlement hit outright and
// only asks the kommune register when Stedsnavn found nothing at all. Measured
// live, with two REAL producers on it: «Gjerdrum» resolved to a Grend at
// 60.68335/11.7955 — whose own kommune is Våler in Innlandet — while Gjerdrum
// kommune is 60.0788/11.0206 in AKERSHUS, 79.6 km away in another fylke. Bent
// Gate Brewing and Haukerudhagen both landed there. «Målselv» was 45.7 km out
// the same way. geocodePlaceForBackfill() now prefers an unambiguous same-named
// kommune for any sub-town hit; measured over all 183 live tokens that moves
// exactly 8 of them and leaves the 22 genuine bygder (Flåm, Misvær, Hegra …)
// alone. See that function's header for why the cheaper "refuse tier-4
// outright" was rejected: it would have cost 18 producers to fix 0 errors.
//
// ONE MEASURED DESIGN DECISION, because the obvious version was wrong.
// Compound suffixes ("Sparbu, Steinkjer", "Mevika, Gildeskål", "Husøy i
// Senja") need splitting. Splitting and taking the FIRST resolvable token was
// tried first and is UNSAFE: «Mevika, Gildeskål» resolved via "Mevika" to a
// Boligfelt at 61.78/5.27 in Vestland — Gildeskål is in Nordland, ~600 km
// away. That is precisely the fabricated-precision failure this dev-request
// exists to remove, reproduced by the code meant to help. Taking the LAST
// token first — the administrative container — fixes it (Gildeskål →
// 67.006/13.944, correct) and costs nothing elsewhere: re-measured over all
// 31 compound/refused tokens, last-first recovers 17 including every case
// first-first recovered, and gets Mevika right. So: last token first.
//
// Tokens that normalizeCityLabel() rejects as documented pollution (fylke
// names, multi-kommune regions, "Norge" — "Vesterålen", "Sunnmøre", "Jæren",
// "Rogaland", "Trøndelag", "Agder" all appeared in this cohort) are dropped
// before we spend a request on them.
//
// ── Parking: an honest terminal state instead of an infinite retry ──
// The two changes above interact badly if left alone. A row Kartverket will
// never resolve used to be retried about twice a day; at a 60 s cadence a full
// rotation is ~20 minutes, so it would be retried ~70 times a DAY, for ever,
// against a free unauthenticated API — and Tier C adds ~250 more rows that can
// do that. agents.geocode_attempts counts consecutive attempts that produced
// no position; past AGENTS_GEOCODE_MAX_ATTEMPTS the row is PARKED: not
// selected, and reported in the queue status under its own heading. The
// counter resets the instant a position IS written, and the postal-backfill
// worker resets it when it lands the postnummer that was blocking the row, so
// parking is never a one-way door for a row whose DATA improves.
//
// Three invariants:
//   • NEVER DOWNGRADE. A tick that only manages a centroid must leave an
//     existing better-precision row untouched (isPrecisionUpgrade()).
//     Tier B additionally refuses to move a row that already has any
//     coordinates — replacing an unlabelled seed coordinate with a city
//     centroid is not obviously an improvement, and we would be guessing.
//   • ALWAYS STAMP. agents.geocode_attempted_at is written on every attempt,
//     whatever the outcome, and the selector orders by it (never-attempted
//     first, then oldest). Same lesson as the homepage-provenance-batch
//     rotation fix (dev-request 2026-07-19): a selector keyed on a column the
//     failure paths don't write re-picks the identical batch forever
//     (measured there: 3 consecutive calls, identical processed=13 batch).
//   • NEVER RETRY FOR EVER. Every attempt that produces no position bumps
//     agents.geocode_attempts; the selector drops rows past the cap. A row we
//     cannot place ends in a named terminal state, not in a loop.
//
// Dry-run: deps.dryRun = true performs the same lookups and reports what WOULD
// change, but takes no write — not even the attempt stamp or the attempt
// counter. Safe to point at prod.
//
// Rate limiting: TWO layers, and they answer different questions.
//   • Pacing WITHIN a row: geocodeOne() sleeps THROTTLE_MS (350 ms) after every
//     Kartverket request including the successful one; Tier B/C sleep between
//     rows because geocodingService has no throttle of its own.
//   • A CEILING across everything: kartverket-budget.ts, a process-wide 2 req/s
//     token bucket now SHARED with agents-postal-backfill.ts. Tier A draws
//     tokens by handing geocodeOne a budgeted fetch, so all four steps of its
//     retry ladder are counted exactly rather than estimated; Tier B/C reserve
//     their worst case (2) before calling geocodingService, whose HTTP does not
//     go through an injectable seam.
//
// Disable via env var RFB_DISABLE_AGENTS_GEOCODE=1 (used in tests / dev).

import { getDb } from "../database/init";
import { geocodeOne, type GeocodeDeps } from "./dental-geocode-worker";
import { geocodingService, isMajorSettlementType } from "./geocoding-service";
import { isPrecisionUpgrade, type GeoPrecision } from "./geo-precision";
import { normalizeCityLabel } from "./city-normalizer";
import { budgetedFetch, takeKartverketBudget, KARTVERKET_MAX_RPS } from "./kartverket-budget";
import {
  startBackfillScheduler,
  type BackfillSchedulerDeps,
  type BackfillSchedulerHandle,
} from "./backfill-scheduler";

// Tier B/C's inter-row pacing (Tier A is paced by geocodeOne's own throttle).
const CENTROID_THROTTLE_MS = 350;

/**
 * Consecutive no-progress attempts before a row is PARKED (stops being
 * selected, gets counted under its own heading in the queue status).
 *
 * 5, not 3: the cadence is now ~20 minutes per full rotation, so five attempts
 * is roughly an hour and a half of trying. A transient Kartverket outage would
 * have to span five separate rotations to park a resolvable row, and even then
 * `unpark` on the admin endpoint puts it back. The counter resets to 0 on any
 * successful write, so a row only accumulates while it genuinely is not moving.
 */
export const AGENTS_GEOCODE_MAX_ATTEMPTS = 5;

/**
 * Cadence. A backfill wants "fast while there is work, quiet when there is
 * not" — see backfill-scheduler.ts for why a fixed hourly setInterval was the
 * wrong shape and what it measured at.
 *
 * 60 s × 50 rows ≈ 3 000 rows/hour, i.e. the 1 022-row backlog measured on
 * 2026-07-25 drains in ~21 minutes instead of ~20 hours. The rate ceiling is
 * enforced separately and independently by kartverket-budget.ts, so these
 * numbers can never on their own put us above KARTVERKET_MAX_RPS.
 */
export const AGENTS_GEOCODE_BACKLOG_INTERVAL_MS = 60_000;
export const AGENTS_GEOCODE_IDLE_INTERVAL_MS = 60 * 60_000;
export const AGENTS_GEOCODE_BOOT_DELAY_MS = 30_000;

export type AgentsGeocodeDeps = GeocodeDeps & {
  /** Report what would change; write nothing (not even the attempt stamp). */
  dryRun?: boolean;
};

export type AgentsGeocodePlannedChange = {
  agent_id: string;
  name: string;
  from_precision: string | null;
  to_precision: GeoPrecision | null;
  lat: number | null;
  lng: number | null;
  outcome: string;
  /** Resolved place name for centroid tiers — what the honesty label will say. */
  place_label?: string | null;
};

export type AgentsGeocodeResult = {
  dry_run: boolean;
  /** Rows selected and attempted this tick. */
  processed: number;
  /** Rows that gained (or would gain) address precision. */
  address_precision: number;
  /** Address hits by the retry ladder's confidence tier. */
  address_high: number;
  address_medium: number;
  address_low: number;
  /** Rows placed (or would be placed) at a city/kommune centroid. */
  centroid_precision: number;
  /** …of which came from Tier C, the place suffix in the producer's name. */
  name_suffix_precision: number;
  /** Rows where every lookup missed — stamped, retried much later. */
  no_match: number;
  /**
   * Rows whose attempt counter reached AGENTS_GEOCODE_MAX_ATTEMPTS during this
   * tick and are therefore now PARKED (no longer selected). Logged per tick so
   * "the queue stopped shrinking" is always attributable to something named.
   */
  parked_now: number;
  /** Rows where a result existed but was not an upgrade (never downgrade). */
  skipped_no_upgrade: number;
  errors: number;
  duration_ms: number;
  /** Populated on dry runs so an admin can see exactly what a real run does. */
  planned: AgentsGeocodePlannedChange[];
  /** True when the single-flight guard turned this call into a no-op. */
  skipped_already_running: boolean;
};

type CandidateRow = {
  id: string;
  name: string | null;
  lat: number | null;
  lng: number | null;
  city: string | null;
  geo_precision: string | null;
  address: string | null;
  postal_code: string | null;
  geocode_attempts: number | null;
};

// ── Tier C — the place suffix in the producer's own name ────────────

/**
 * The naming convention RFB's discovery pipeline writes: «<Producer> — <Place>».
 * Em dash and en dash both occur in live data; a plain hyphen deliberately does
 * NOT, because hyphens are common INSIDE Norwegian names ("Midt-Telemark",
 * "Øvre-Ål", "Bent Gate Brewing") and splitting on them would manufacture
 * garbage tokens.
 */
const NAME_PLACE_SUFFIX = /[—–]\s*([^—–]+)\s*$/;

// NOTE on the SQL side of this: the selector's HAS_NAME_DASH predicate
// deliberately OVER-selects (any em/en dash anywhere in the name). This regex
// is the precise test. A row the SQL admits but this rejects simply becomes a
// stamped no_match and rotates out — the cheap direction to be wrong in.

/**
 * Place candidates mined from a producer name, in the order they should be
 * tried.
 *
 * LAST TOKEN FIRST, and that ordering is a measured safety property rather
 * than a preference. Compound suffixes ("Sparbu, Steinkjer", "Mevika,
 * Gildeskål", "Husøy i Senja") are "<locality>, <container>". Trying the
 * locality first resolved «Mevika, Gildeskål» to a Boligfelt in VESTLAND,
 * ~600 km from Gildeskål in Nordland — a confident, precise, wrong point, the
 * exact failure class this dev-request exists to remove. Trying the container
 * first gives Gildeskål kommune (67.006/13.944), and re-measured across all 31
 * compound tokens in the live cohort it recovers a strict superset of what
 * locality-first recovered.
 *
 * Every candidate is passed through normalizeCityLabel() first, which drops the
 * documented pollution classes — "Norge", fylke names, multi-kommune region
 * labels. All six of "Vesterålen", "Sunnmøre", "Jæren", "Rogaland",
 * "Trøndelag" and "Agder" appear as name suffixes in the live cohort and are
 * dropped here rather than costing a request to discover they are too coarse.
 */
/**
 * Kartverket `navneobjekttype` → the precision tier we are willing to CLAIM.
 *
 * Only a MAJOR settlement (By, Tettsted, Tettbebyggelse, Bydel …) earns 'city'.
 * Everything else acceptable — administrative areas, named regions and minor
 * settlements alike — is tagged 'kommune', the coarsest tier.
 *
 * The previous mapping was `kommune|fylke|annen administrativ inndeling →
 * 'kommune', else 'city'`, which INVERTED the ranking for region types:
 * «Landskapsområde», «Dalføre», «Øy i sjø» and «Halvøy i sjø» are all coarser
 * than a kommune, yet claimed the finer tier — «Målselv» and «Ringerike» landed
 * as 'city'. GEO_PRECISION_RANK puts city (2) above kommune (1), so the
 * never-downgrade guard would have let a region point overwrite a real kommune
 * centroid. Nothing user-visible today (both suppress the km figure), but it
 * was backwards, and it is the guard's input.
 *
 * It also does the honest thing for the residual risk in
 * geocodePlaceForBackfill()'s rule (3): an uncorroborated hamlet-scale hit
 * makes the coarsest possible claim rather than the second-finest.
 */
export function precisionForPlaceType(placeType: string | null | undefined): GeoPrecision {
  return isMajorSettlementType(placeType) ? "city" : "kommune";
}

export function placeSuffixCandidates(name: string | null | undefined): string[] {
  const m = NAME_PLACE_SUFFIX.exec(name || "");
  if (!m) return [];
  const raw = m[1].trim();
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  // " i " is a separator too: "Husøy i Senja" → Senja (measured recovery).
  for (const part of raw.split(/[/|,]| og | i /i).map((s) => s.trim()).filter(Boolean).reverse()) {
    const norm = normalizeCityLabel(part);
    if (!norm || norm.length < 2) continue;
    const key = norm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out.slice(0, 2);
}

// ── Strictly-increasing attempt stamps ──────────────────────────────
// datetime('now') has 1-second granularity, and a tick with a warm geocode
// cache can stamp a whole batch inside the same second — which would make the
// "oldest attempt first" ordering fall back to the `id` tiebreaker and hand
// the NEXT tick the exact same rows. Monotonic ms stamps make consecutive
// batches provably disjoint.
let lastStampMs = 0;
function nextAttemptStamp(): string {
  const now = Date.now();
  lastStampMs = now > lastStampMs ? now : lastStampMs + 1;
  return new Date(lastStampMs).toISOString();
}

// ── Single-flight guard (review follow-up 6) ────────────────────────
// The hourly setInterval tick and an admin POST /admin/agents/geocode-batch
// can overlap. Selection happens up front and the attempt stamp is only
// written when a row FINISHES, so two concurrent ticks select the identical
// batch: measured 4/4 overlap and 8 Kartverket requests for 4 rows. The
// outcome is benign (same writes, never-downgrade holds) but it doubles load
// on a free public API and makes a dry run's `planned` list misleading.
// A module-level flag is enough — this worker is single-process by design.
let running = false;

// ── Admin-request parsing (pure, unit-tested) ───────────────────────
// Extracted from the route so the two decisions that actually matter are
// testable without touching process.env.ADMIN_KEY — the shared global behind
// this repo's documented cart-*/gardssalg-claim/orch-pr-9 test races.

export const GEOCODE_BATCH_LIMIT_DEFAULT = 50;
export const GEOCODE_BATCH_LIMIT_MAX = 200;

/** Clamp a caller-supplied batch limit into [1, 200]; non-numbers → default. */
export function clampGeocodeBatchLimit(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : GEOCODE_BATCH_LIMIT_DEFAULT;
  return Math.max(1, Math.min(GEOCODE_BATCH_LIMIT_MAX, n));
}

/**
 * Parse the dry_run flag STRICTLY (review B4).
 *
 * `body.dry_run === true` fails OPEN: `{"dry_run":"true"}` — the obvious curl
 * typo, and JSON-stringified booleans are common from shell scripts — is not
 * `true`, so it silently performed a REAL WRITE against production. This
 * endpoint exists precisely to rehearse against prod, so failing open defeats
 * its purpose. Anything that is not a real boolean is now rejected rather than
 * interpreted. (The repo's other dry_run endpoints use the loose convention,
 * but none of them is a prod-mutation rehearsal switch.)
 */
export function parseDryRunFlag(raw: unknown): { ok: true; dryRun: boolean } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, dryRun: false };
  if (typeof raw === "boolean") return { ok: true, dryRun: raw };
  return {
    ok: false,
    error:
      `dry_run må være en boolsk verdi (true/false uten anførselstegn) — fikk ${JSON.stringify(raw)}. ` +
      `Avvist i stedet for tolket: en feilskrevet dry_run ville ellers ha kjørt en ekte skriving mot produksjon.`,
  };
}

// ── The selector, as SQL fragments shared by the tick and the status ──
// The candidate query and the queue-status query used to state the same
// eligibility rule twice. That is exactly how `pending` comes to mean something
// different from "what the worker will actually pick" — the drift Daniel would
// be reading past. They are now ONE source of truth, interpolated into both.

/** Nothing below 'address' is the ceiling; an address-precision row cannot improve. */
const IMPROVABLE = `(a.geo_precision IS NULL OR a.geo_precision <> 'address')`;
const NOT_PARKED = `COALESCE(a.geocode_attempts, 0) < ${AGENTS_GEOCODE_MAX_ATTEMPTS}`;
const PARKED = `COALESCE(a.geocode_attempts, 0) >= ${AGENTS_GEOCODE_MAX_ATTEMPTS}`;
const NO_COORDS = `(a.lat IS NULL OR a.lng IS NULL)`;
const HAS_ADDRESS = `(k.address IS NOT NULL AND TRIM(k.address) <> '')`;
const HAS_POSTAL = `(k.postal_code IS NOT NULL AND TRIM(k.postal_code) <> '')`;
const HAS_CITY = `(a.city IS NOT NULL AND TRIM(a.city) <> '')`;
/** Over-selects on purpose — placeSuffixCandidates() is the precise test. */
const HAS_NAME_DASH = `(a.name LIKE '%' || CHAR(8212) || '%' OR a.name LIKE '%' || CHAR(8211) || '%')`;

const TIER_A = `(${HAS_ADDRESS} AND ${HAS_POSTAL})`;
const TIER_B = `(${NO_COORDS} AND ${HAS_CITY})`;
const TIER_C = `(${NO_COORDS} AND ${HAS_NAME_DASH})`;
const SELECTABLE = `${IMPROVABLE} AND ${NOT_PARKED} AND (${TIER_A} OR ${TIER_B} OR ${TIER_C})`;

export type AgentsGeocodeQueueStatus = {
  active: number;
  address_precision: number;
  centroid_precision: number;
  unknown_precision: number;
  missing_coordinates: number;
  /** Rows this worker will select — the drain queue. */
  pending: number;
  never_attempted: number;
  /**
   * Which ladder tier each pending row will be tried on (first match wins,
   * same order the tick uses). Answers "what KIND of work is left".
   */
  pending_by_tier: { address: number; city_centroid: number; name_suffix: number };
  /**
   * Rows below address precision that this worker will NOT select, broken down
   * by why. This is the honest answer to "what is left that never will finish".
   */
  unreachable: {
    total: number;
    /** Has a street address but no postnummer — agents-postal-backfill's queue, not stuck. */
    awaiting_postal_backfill: number;
    /**
     * Carries a coordinate of UNKNOWN provenance (geo_precision NULL — a seed
     * value) and has no address to improve on it. We will not overwrite it with
     * a centroid, because it might be the real farm; we cannot confirm it,
     * because there is no address. This is the genuinely stuck cohort.
     */
    seed_coordinates_no_address: number;
    /**
     * Placed honestly at city/kommune precision BY THIS WORKER and cannot go
     * further without a street address. Counted apart from the seed cohort
     * above on purpose: "we know this to city level" and "we do not know what
     * this coordinate is" are different states and only one of them is a
     * problem. Tier C moves rows from `no_usable_signal` into HERE.
     */
    placed_at_centroid_no_address: number;
    /** No address, no city, no place suffix in the name — nothing to geocode from. */
    no_usable_signal: number;
    /** Tried AGENTS_GEOCODE_MAX_ATTEMPTS times without ever resolving. */
    parked_after_retries: number;
  };
  /** "Will this finish, and when?" — derived, not stored. */
  drain: {
    batch_limit: number;
    tick_interval_seconds: number;
    rows_per_hour: number;
    eta_hours: number | null;
    max_requests_per_second: number;
  };
};

/**
 * Work-queue counts for the admin endpoint / ops. Cheap: one table scan.
 *
 * Daniel watches this output directly, so it is built to answer his two
 * questions without a follow-up round-trip: **will this finish** (`drain`) and
 * **what is left that never will** (`unreachable`, broken down by cause).
 */
export function agentsGeocodeQueueStatus(
  batchLimit: number = GEOCODE_BATCH_LIMIT_DEFAULT
): AgentsGeocodeQueueStatus {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS active,
         COUNT(*) FILTER (WHERE a.geo_precision = 'address') AS address_precision,
         COUNT(*) FILTER (WHERE a.geo_precision IN ('postal','city','kommune')) AS centroid_precision,
         COUNT(*) FILTER (WHERE a.geo_precision IS NULL) AS unknown_precision,
         COUNT(*) FILTER (WHERE ${NO_COORDS}) AS missing_coordinates,
         COUNT(*) FILTER (WHERE a.geocode_attempted_at IS NULL) AS never_attempted,

         COUNT(*) FILTER (WHERE ${SELECTABLE}) AS pending,
         COUNT(*) FILTER (WHERE ${SELECTABLE} AND ${TIER_A}) AS pending_tier_a,
         COUNT(*) FILTER (WHERE ${SELECTABLE} AND NOT ${TIER_A} AND ${TIER_B}) AS pending_tier_b,
         COUNT(*) FILTER (WHERE ${SELECTABLE} AND NOT ${TIER_A} AND NOT ${TIER_B} AND ${TIER_C})
           AS pending_tier_c,

         COUNT(*) FILTER (WHERE ${IMPROVABLE} AND NOT (${SELECTABLE})) AS unreachable_total,
         COUNT(*) FILTER (WHERE ${IMPROVABLE} AND ${PARKED}) AS parked,
         COUNT(*) FILTER (
           WHERE ${IMPROVABLE} AND NOT (${SELECTABLE}) AND NOT ${PARKED}
             AND ${HAS_ADDRESS} AND NOT ${HAS_POSTAL}
         ) AS awaiting_postal,
         COUNT(*) FILTER (
           WHERE ${IMPROVABLE} AND NOT (${SELECTABLE}) AND NOT ${PARKED}
             AND NOT (${HAS_ADDRESS} AND NOT ${HAS_POSTAL})
             AND NOT ${NO_COORDS} AND a.geo_precision IS NULL
         ) AS seed_coords_no_address,
         COUNT(*) FILTER (
           WHERE ${IMPROVABLE} AND NOT (${SELECTABLE}) AND NOT ${PARKED}
             AND NOT (${HAS_ADDRESS} AND NOT ${HAS_POSTAL})
             AND NOT ${NO_COORDS} AND a.geo_precision IS NOT NULL
         ) AS placed_centroid_no_address,
         COUNT(*) FILTER (
           WHERE ${IMPROVABLE} AND NOT (${SELECTABLE}) AND NOT ${PARKED}
             AND NOT (${HAS_ADDRESS} AND NOT ${HAS_POSTAL})
             AND ${NO_COORDS}
         ) AS no_usable_signal
       FROM agents a
       LEFT JOIN agent_knowledge k ON k.agent_id = a.id
       WHERE a.is_active = 1`
    )
    .get() as any;

  const pending = row?.pending ?? 0;
  const limit = Math.max(1, batchLimit);
  const tickSeconds = Math.round(AGENTS_GEOCODE_BACKLOG_INTERVAL_MS / 1000);
  // Rows/hour is the CADENCE ceiling, not a promise: a tick that takes longer
  // than the interval simply pushes the next one out (the scheduler re-arms
  // after the tick finishes, never during it), so real throughput can only be
  // lower. Reported as an upper bound, which is the useful direction for an ETA.
  const rowsPerHour = Math.round((limit * 3600) / Math.max(1, tickSeconds));
  return {
    active: row?.active ?? 0,
    address_precision: row?.address_precision ?? 0,
    centroid_precision: row?.centroid_precision ?? 0,
    unknown_precision: row?.unknown_precision ?? 0,
    missing_coordinates: row?.missing_coordinates ?? 0,
    pending,
    never_attempted: row?.never_attempted ?? 0,
    pending_by_tier: {
      address: row?.pending_tier_a ?? 0,
      city_centroid: row?.pending_tier_b ?? 0,
      name_suffix: row?.pending_tier_c ?? 0,
    },
    unreachable: {
      total: row?.unreachable_total ?? 0,
      awaiting_postal_backfill: row?.awaiting_postal ?? 0,
      seed_coordinates_no_address: row?.seed_coords_no_address ?? 0,
      placed_at_centroid_no_address: row?.placed_centroid_no_address ?? 0,
      no_usable_signal: row?.no_usable_signal ?? 0,
      parked_after_retries: row?.parked ?? 0,
    },
    drain: {
      batch_limit: limit,
      tick_interval_seconds: tickSeconds,
      rows_per_hour: rowsPerHour,
      eta_hours: pending === 0 ? 0 : Math.round((pending / rowsPerHour) * 100) / 100,
      max_requests_per_second: KARTVERKET_MAX_RPS,
    },
  };
}

/** True while the worker still has rows to select — the scheduler's cadence input. */
export function agentsGeocodeHasBacklog(): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM agents a
         LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE a.is_active = 1 AND ${SELECTABLE}`
    )
    .get() as any;
  return (row?.n ?? 0) > 0;
}

/**
 * Clear the parking counter so parked rows are retried.
 *
 * Manual escape hatch for the case parking is designed to survive but cannot
 * detect: a Kartverket outage long enough to burn five rotations, or a data
 * import that fixed the underlying records without going through the
 * postal-backfill worker (which resets the counter itself). Returns the number
 * of rows it would clear; `dryRun` makes it count without writing.
 */
export function unparkAgentsGeocode(dryRun: boolean): number {
  const db = getDb();
  const n = (db
    .prepare(`SELECT COUNT(*) AS n FROM agents a WHERE a.is_active = 1 AND ${PARKED} AND ${IMPROVABLE}`)
    .get() as any)?.n ?? 0;
  if (!dryRun && n > 0) {
    // No alias in an UPDATE target, so the shared fragments are re-stated here
    // in their unaliased form. Kept adjacent to the SELECT above so a change to
    // the parking rule is obvious in one screen.
    db.prepare(
      `UPDATE agents SET geocode_attempts = 0, geocode_attempted_at = NULL
        WHERE is_active = 1
          AND COALESCE(geocode_attempts, 0) >= ${AGENTS_GEOCODE_MAX_ATTEMPTS}
          AND (geo_precision IS NULL OR geo_precision <> 'address')`
    ).run();
  }
  return n;
}

function emptyStats(dryRun: boolean): AgentsGeocodeResult {
  return {
    dry_run: dryRun,
    processed: 0,
    address_precision: 0,
    address_high: 0,
    address_medium: 0,
    address_low: 0,
    centroid_precision: 0,
    name_suffix_precision: 0,
    no_match: 0,
    parked_now: 0,
    skipped_no_upgrade: 0,
    errors: 0,
    duration_ms: 0,
    planned: [],
    skipped_already_running: false,
  };
}

/**
 * One tick. Selects up to `limit` active producers that could still improve,
 * runs Tier A then Tier B per row, and stamps every attempt so the next tick
 * picks a disjoint batch.
 *
 * Single-flight (review follow-up 6): if a tick is already in progress this
 * returns immediately with skipped_already_running=true rather than selecting
 * — and re-fetching — the same batch a second time.
 */
export async function agentsGeocodeTick(
  limit: number = 50,
  deps: AgentsGeocodeDeps = {}
): Promise<AgentsGeocodeResult> {
  if (running) {
    console.log("[agents-geocode] tick skipped — a tick is already running");
    return { ...emptyStats(deps.dryRun === true), skipped_already_running: true };
  }
  running = true;
  try {
    return await runAgentsGeocodeTick(limit, deps);
  } finally {
    running = false;
  }
}

async function runAgentsGeocodeTick(
  limit: number,
  deps: AgentsGeocodeDeps
): Promise<AgentsGeocodeResult> {
  const start = Date.now();
  const dryRun = deps.dryRun === true;
  const db = getDb();
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const stats: AgentsGeocodeResult = emptyStats(dryRun);

  // ── Candidate selection ───────────────────────────────────────────
  // A row is worth a lookup when it is active, is not already at address
  // precision (the ceiling — nothing here can improve on it), and has either
  //   • a street address + postnummer  → Tier A can run, or
  //   • no coordinates at all + a city → Tier B can at least make it visible.
  // Rotation: never-attempted rows first (the `IS NOT NULL` expression sorts
  // false=0 before true=1), then oldest attempt.
  const candidates = db
    .prepare(
      `SELECT a.id AS id, a.name AS name, a.lat AS lat, a.lng AS lng, a.city AS city,
              a.geo_precision AS geo_precision, a.geocode_attempts AS geocode_attempts,
              k.address AS address, k.postal_code AS postal_code
         FROM agents a
         LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE a.is_active = 1
          AND ${SELECTABLE}
        ORDER BY (a.geocode_attempted_at IS NOT NULL), a.geocode_attempted_at ASC, a.id ASC
        LIMIT ?`
    )
    .all(limit) as CandidateRow[];

  // geocode_prev_lat/lng capture the coordinate this worker is about to
  // overwrite (review follow-up 10), in the SAME statement so there is no
  // window where the old value is lost but the new one is not yet written.
  // Tier A replaces seed coordinates in place, so without this the
  // dev-request's "kan stoppes" rollback restores nothing.
  //
  // geocode_attempts is reset to 0 here and INCREMENTED on the attempt-only
  // path below: the counter measures consecutive NON-progress, so any write of
  // a real position clears it and a row can never be parked while it is
  // actually improving.
  const updatePosition = db.prepare(
    `UPDATE agents
        SET geocode_prev_lat = lat, geocode_prev_lng = lng,
            lat = ?, lng = ?, geo_precision = ?, geocode_source = ?,
            geocode_outcome = ?, geo_place_label = ?,
            geocode_attempted_at = ?, geocode_attempts = 0
      WHERE id = ?`
  );
  const updateAttemptOnly = db.prepare(
    `UPDATE agents
        SET geocode_outcome = ?, geocode_attempted_at = ?,
            geocode_attempts = COALESCE(geocode_attempts, 0) + 1
      WHERE id = ?`
  );

  for (const row of candidates) {
    stats.processed++;
    try {
      const address = (row.address || "").trim();
      const postal = (row.postal_code || "").trim();
      const city = (row.city || "").trim();

      let wrote = false;

      // ── Tier A — real street address via the Kartverket adresse ladder ──
      if (address && postal) {
        // budgetedFetch wraps the seam EVERY step of geocodeOne's 4-step retry
        // ladder goes through, so all of them draw from the shared 2 req/s
        // ceiling. Wrapping here rather than estimating "1 request per row" is
        // the difference between a bound and a hope: a row that walks the whole
        // ladder costs four requests, and at limit=200 that is 800.
        const hit = await geocodeOne(address, postal, city, {
          ...deps,
          fetchImpl: budgetedFetch(deps.fetchImpl ?? fetch, sleep),
        });
        if (hit.confidence !== "no_match") {
          if (isPrecisionUpgrade(row.geo_precision, "address")) {
            stats.address_precision++;
            if (hit.confidence === "high") stats.address_high++;
            else if (hit.confidence === "medium") stats.address_medium++;
            else stats.address_low++;
            record(row, "address", hit.lat, hit.lng, "kartverket_adresse", hit.confidence);
            wrote = true;
          } else {
            // Unreachable today (the selector excludes 'address' rows) but
            // kept as the explicit never-downgrade guard so a future selector
            // change cannot silently start overwriting better data.
            stats.skipped_no_upgrade++;
            recordAttemptOnly(row, "skipped_no_upgrade");
            wrote = true;
          }
        }
      }

      // ── Tier B — city centroid, only for rows with NO position at all ──
      // Deliberately not applied to rows that already have coordinates: an
      // untagged seed coordinate might be the actual farm, and swapping it for
      // a city centroid would be a guess dressed as an improvement. Those rows
      // are reported as `unreachable.seed_coordinates_no_address` rather than
      // silently left in the "unknown" bucket.
      const hasNoPosition = row.lat === null || row.lng === null;
      if (!wrote && hasNoPosition && city) {
        if (await placeCentroid(row, city, "city_centroid")) wrote = true;
      }

      // ── Tier C — the place suffix in the producer's own NAME ────────
      // «Straumbotn Gård — Rana». Measured: 244 of the 253 live rows with
      // neither address nor city carry this suffix, and 174 of the 194 distinct
      // tokens resolve through the SAME hardened geocoder Tier B uses. Same
      // no-coordinates precondition, same 'city'/'kommune' ceiling — Tier C can
      // never produce an 'address' tag and therefore can never license a km
      // figure. See placeSuffixCandidates() for why the LAST token is tried
      // first (it is a safety property, measured, not a preference).
      if (!wrote && hasNoPosition) {
        for (const candidate of placeSuffixCandidates(row.name)) {
          if (await placeCentroid(row, candidate, "name_suffix_centroid")) {
            wrote = true;
            break;
          }
        }
      }

      // ── Nothing resolved — stamp anyway so the row rotates out ──────
      if (!wrote) {
        stats.no_match++;
        recordAttemptOnly(row, "no_match");
      }
    } catch (err) {
      stats.errors++;
      console.error(`[agents-geocode] failed for ${row.id}:`, err);
      // REVIEW B3: the ALWAYS-STAMP invariant this file's header states was
      // not honoured on the error path. A row that throws every tick (bad
      // upstream data, a persistent DNS/TLS failure for its address) kept
      // NULL geocode_attempted_at, so the selector re-picked the identical
      // head of the queue forever and everything behind the LIMIT starved —
      // at limit=50, fifty persistently-erroring rows silently halt the whole
      // backfill and the only symptom is `errors=50` in an hourly log line.
      // Stamping an 'error' outcome rotates them out; they come back round
      // once the rest of the universe has been attempted.
      try {
        recordAttemptOnly(row, "error");
      } catch (stampErr) {
        // Guard the guard: if the DB itself is the thing failing, a throw here
        // would abort the whole tick and lose the rows already processed.
        console.error(`[agents-geocode] could not stamp attempt for ${row.id}:`, stampErr);
      }
    }
  }

  stats.duration_ms = Date.now() - start;
  return stats;

  /**
   * Shared body of Tier B and Tier C: resolve ONE place label through the
   * Fase-0 hardened geocoder and record the outcome.
   *
   * Returns true when the label resolved (whether that produced a write or a
   * never-downgrade skip), false when it did not — so the caller can try the
   * next candidate, then the next tier, and finally fall through to the
   * always-stamp no_match path.
   *
   * geocodingService owns its own HTTP and takes no fetch seam, so its worst
   * case (Stedsnavn, then the Kommuneinfo fallback) is RESERVED against the
   * shared budget up front. Over-reserving can only slow us down, which is the
   * safe direction for a courtesy limit against a free API. A cache hit costs
   * no request at all and still pays the reservation — accepted, because the
   * alternative is reaching into geocoding-service's internals from here.
   */
  async function placeCentroid(
    row: CandidateRow,
    placeLabel: string,
    outcome: string
  ): Promise<boolean> {
    await takeKartverketBudget(sleep, 2);
    // geocodePlaceForBackfill, NOT geocode(): the latter consults the local
    // `agents` table BEFORE Kartverket and answers with ANOTHER PRODUCER'S seed
    // coordinate. See that function's header — 80 of the 183 live Tier-C tokens
    // exactly match an existing agents.city, and «Ny Gård — Hegra» was
    // reproduced adopting a sibling row's Tromsø position (69.6496/18.956).
    const geo = await geocodingService.geocodePlaceForBackfill(placeLabel);
    await sleep(CENTROID_THROTTLE_MS);
    if (!geo) return false;

    const precision = precisionForPlaceType(geo.placeType);
    // geo.source is the geocoding-service tier that answered
    // ("kartverket" = Stedsnavn, "kommuneinfo" = the kommune register,
    // "hardcoded" = the curated major-city table). Recorded verbatim apart from
    // disambiguating Stedsnavn from the adresse API, since both would otherwise
    // read "kartverket". `database` can no longer occur here.
    const source = geo.source === "kartverket" ? "kartverket_stedsnavn" : geo.source;
    if (isPrecisionUpgrade(row.geo_precision, precision)) {
      stats.centroid_precision++;
      if (outcome === "name_suffix_centroid") stats.name_suffix_precision++;
      // geo.name is the place Kartverket actually matched — the thing the
      // honesty label has to be able to say. See record()'s note on why storing
      // it is not optional.
      record(row, precision, geo.lat, geo.lng, source, outcome, geo.name || placeLabel);
    } else {
      stats.skipped_no_upgrade++;
      recordAttemptOnly(row, "skipped_no_upgrade");
    }
    return true;
  }

  function record(
    row: CandidateRow,
    precision: GeoPrecision,
    lat: number,
    lng: number,
    source: string,
    outcome: string,
    /**
     * The place this position represents, for centroid tiers.
     *
     * NOT decoration. formatRfbDistanceLabel() renders a centroid row as
     * «i {city}-området», falling back to the bare, useless «omtrentlig
     * posisjon» when city is null — and the ENTIRE Tier-C cohort is defined by
     * having no city. Without persisting the resolved place, ~250 producers
     * would become visible in proximity search with no indication of where they
     * are, which is most of the point of placing them at all. Stored in
     * agents.geo_place_label rather than agents.city on purpose: `city` is a
     * curated, owner-editable field that also feeds the stats counters and
     * geocode()'s own lookupInDatabase() tier, and writing worker-derived
     * values into it would feed exactly the tier B2 was about back into itself.
     */
    placeLabel: string | null = null
  ): void {
    stats.planned.push({
      agent_id: row.id,
      name: row.name ?? "",
      from_precision: row.geo_precision,
      to_precision: precision,
      lat,
      lng,
      outcome,
      place_label: placeLabel,
    });
    if (dryRun) return;
    updatePosition.run(lat, lng, precision, source, outcome, placeLabel, nextAttemptStamp(), row.id);
  }

  function recordAttemptOnly(row: CandidateRow, outcome: string): void {
    // The counter this attempt is about to become. Computed from the value the
    // selector read, so a dry run reports the same parking transition a real
    // run would perform — without writing it.
    const attemptsAfter = (row.geocode_attempts ?? 0) + 1;
    if (attemptsAfter >= AGENTS_GEOCODE_MAX_ATTEMPTS) stats.parked_now++;
    stats.planned.push({
      agent_id: row.id,
      name: row.name ?? "",
      from_precision: row.geo_precision,
      to_precision: null,
      lat: null,
      lng: null,
      outcome: attemptsAfter >= AGENTS_GEOCODE_MAX_ATTEMPTS ? `${outcome}_parked` : outcome,
    });
    if (dryRun) return;
    updateAttemptOnly.run(outcome, nextAttemptStamp(), row.id);
  }
}

// ── Scheduling ──────────────────────────────────────────────────────

/**
 * Register the adaptive tick loop. Replaces the boot `setTimeout` +
 * hourly `setInterval` pair that used to live inline in src/index.ts.
 *
 * The cadence is chosen from the queue itself after every tick — 60 s while
 * rows remain, an hour once they do not — so the worker is fast exactly while
 * it has something to do and goes quiet by itself afterwards, with no flag to
 * remember to unset. Measured motivation is in backfill-scheduler.ts's header.
 */
export function startAgentsGeocodeWorker(
  overrides: Partial<BackfillSchedulerDeps> = {}
): BackfillSchedulerHandle {
  return startBackfillScheduler({
    label: "agents-geocode",
    backlogDelayMs: AGENTS_GEOCODE_BACKLOG_INTERVAL_MS,
    idleDelayMs: AGENTS_GEOCODE_IDLE_INTERVAL_MS,
    bootDelayMs: AGENTS_GEOCODE_BOOT_DELAY_MS,
    hasBacklog: agentsGeocodeHasBacklog,
    runTick: async () => {
      const r = await agentsGeocodeTick(GEOCODE_BATCH_LIMIT_DEFAULT);
      if (r.skipped_already_running) {
        // A tick can legitimately outlive its own interval (batch × retry
        // ladder × HTTP timeout). Saying so explicitly is what separates
        // "nothing happened this minute" from "the worker is wedged".
        console.log("[agents-geocode] tick skipped — the previous tick is still running");
        return;
      }
      console.log(
        `[agents-geocode] tick processed=${r.processed} ` +
        `address=${r.address_precision} (high=${r.address_high} medium=${r.address_medium} low=${r.address_low}) ` +
        `centroid=${r.centroid_precision} (name_suffix=${r.name_suffix_precision}) ` +
        `no_match=${r.no_match} skipped_no_upgrade=${r.skipped_no_upgrade} ` +
        `parked_now=${r.parked_now} errors=${r.errors} duration_ms=${r.duration_ms}`
      );
    },
    ...overrides,
  });
}

// ── Seed-coordinate audit (read-only measurement, never writes) ──────
//
// Review adjudication (c). The ~110 rows in
// `unreachable.seed_coordinates_no_address` carry a coordinate of unknown
// provenance and a city, and this worker deliberately refuses to overwrite
// them. The first version of this slice framed the choice as "reclassify them
// as 'city' on an inference, or leave them alone" and deferred to Daniel on
// that basis. That framing was wrong: there is a third option, and it is a
// MEASUREMENT rather than a guess.
//
// Geocode each such row's own `city` and compare the result to the coordinate
// already stored. If they agree to within ~1 km, the stored value demonstrably
// IS the city centroid — so tagging it 'city' would not be an inference at all,
// it would be recording something we checked. If they disagree by tens of
// kilometres, the stored coordinate is something else (plausibly the real farm,
// plausibly wrong) and must keep its honest NULL.
//
// This function only produces the distribution. It writes NOTHING — no
// coordinates, no precision, not even an attempt stamp — so it is safe to point
// at production, and the reclassification decision stays with Daniel, made on
// real numbers instead of on either of us guessing.
//
// It must go through geocodePlaceForBackfill(): geocode() would consult
// lookupInDatabase(), which for a row's own city can return THAT ROW'S OWN
// coordinate and report a triumphant 0.0 km agreement for every single row.

export type SeedCoordinateAuditRow = {
  agent_id: string;
  name: string;
  city: string;
  stored_lat: number;
  stored_lng: number;
  centroid_lat: number | null;
  centroid_lng: number | null;
  centroid_place: string | null;
  distance_km: number | null;
  verdict: "is_centroid" | "near_centroid" | "far_from_centroid" | "city_unresolvable";
};

export type SeedCoordinateAudit = {
  examined: number;
  /** ≤1 km from the city centroid — the stored value IS the centroid. */
  is_centroid: number;
  /** 1–10 km — same place, but not literally the centroid point. */
  near_centroid: number;
  /** >10 km — the stored coordinate means something else. Leave it alone. */
  far_from_centroid: number;
  /** The row's own city could not be resolved safely; no verdict possible. */
  city_unresolvable: number;
  duration_ms: number;
  rows: SeedCoordinateAuditRow[];
};

/** Great-circle km. Local copy: this module must not import the corridor service. */
function auditHaversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export async function auditSeedCoordinates(
  limit: number = 50,
  deps: AgentsGeocodeDeps = {}
): Promise<SeedCoordinateAudit> {
  const start = Date.now();
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT a.id AS id, a.name AS name, a.city AS city, a.lat AS lat, a.lng AS lng
         FROM agents a
         LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE a.is_active = 1
          AND a.geo_precision IS NULL
          AND a.lat IS NOT NULL AND a.lng IS NOT NULL
          AND ${HAS_CITY}
          AND NOT ${HAS_ADDRESS}
        ORDER BY a.id ASC
        LIMIT ?`
    )
    .all(Math.max(1, Math.min(500, Math.floor(limit)))) as Array<{
      id: string; name: string | null; city: string; lat: number; lng: number;
    }>;

  const out: SeedCoordinateAudit = {
    examined: 0, is_centroid: 0, near_centroid: 0, far_from_centroid: 0,
    city_unresolvable: 0, duration_ms: 0, rows: [],
  };

  for (const r of rows) {
    out.examined++;
    let centroid: { lat: number; lng: number; name: string } | null = null;
    try {
      await takeKartverketBudget(sleep, 2);
      const g = await geocodingService.geocodePlaceForBackfill(r.city.trim());
      await sleep(CENTROID_THROTTLE_MS);
      if (g) centroid = { lat: g.lat, lng: g.lng, name: g.name };
    } catch (err) {
      // A lookup failure is not evidence about the coordinate. Report it as
      // unresolvable rather than letting one bad row abort the whole audit.
      console.error(`[seed-audit] lookup failed for ${r.id}:`, err);
    }

    const km = centroid ? auditHaversineKm(r.lat, r.lng, centroid.lat, centroid.lng) : null;
    const verdict: SeedCoordinateAuditRow["verdict"] =
      km === null ? "city_unresolvable"
        : km <= 1 ? "is_centroid"
        : km <= 10 ? "near_centroid"
        : "far_from_centroid";
    out[verdict === "city_unresolvable" ? "city_unresolvable" : verdict]++;

    out.rows.push({
      agent_id: r.id,
      name: r.name ?? "",
      city: r.city,
      stored_lat: r.lat,
      stored_lng: r.lng,
      centroid_lat: centroid?.lat ?? null,
      centroid_lng: centroid?.lng ?? null,
      centroid_place: centroid?.name ?? null,
      distance_km: km === null ? null : Math.round(km * 100) / 100,
      verdict,
    });
  }

  out.duration_ms = Date.now() - start;
  return out;
}
