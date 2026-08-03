// ─── Experiences Routes — Phase 7 (Skjer) ───────────────────────────
//
// All endpoints under /api/opplevelser/*. Every query goes through
// experience-store against /data/experiences.db. Zero overlap with
// rfb's marketplace.ts or dental.ts.
//
// Mounted in src/index.ts as: app.use('/api/opplevelser', opplevelserRoutes);
// (see src/index.ts.diff for the exact additive patch).
//
// The /discover endpoint is the HTTP twin of the MCP discover tool
// (the /mcp surface lands in a follow-up PR, mirroring dental F4).
// Admin POST requires X-Admin-Key (same env var as rfb/dental).

import { Router, Request, Response, NextFunction } from "express";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  createExperience,
  getExperienceById,
  discoverExperiencesRelaxed,
  buildRelaxationNote,
  buildNarrowingSuggestions,
  listCategories,
  createProvider,
  getProviderByOrgnr,
  getProviderByName,
  setBrregVerification,
  ExperienceSchema,
  DiscoverFilterSchema,
  // orch-experiences-content-refresh — homepage→content writer
  selectProvidersForContentRefresh,
  getProviderContentTarget,
  getExperiencesForProvider,
  applyExperienceContent,
  harvestProvenanceOf,
  markProviderEnriched,
  markProviderContentAttempted,
  // enrichment-metode slice 1 (2026-07-16): dead-homepage parking
  recordProviderHomepageFetchResult,
  // dev-request 2026-07-20-experiences-no-yield-backoff
  recordProviderContentYield,
  type ContentRefreshTarget,
  type ContentRefreshStopReason,
  // dev-request 2026-07-03-gardssalg-rike-profiler-bilder-agentbooking, Fase 1
  // item 3 — multi-page-crawl content enrichment (about/visit/opening-hours)
  selectGardssalgProvidersForContentRefresh,
  getGardssalgProviderContentTarget,
  applyGardssalgProviderContent,
  // dev-request 2026-07-20-gardssalg-kvalitetsgate-redesign, criterion 6 —
  // retroactive scan+null of about_text/visit_text values that no longer
  // clear the new extraction+judge gate (see POST /admin/gardssalg-retro-scan).
  selectGardssalgProvidersForRetroScan,
  getGardssalgProviderRetroScanTarget,
  applyGardssalgRetroScanNull,
  type GardssalgRetroScanTarget,
  // dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach, slice 2 —
  // shared fill-vs-replace decision so the dry-run preview below can never
  // drift from what applyGardssalgProviderContent() actually does.
  gardssalgReplaceableFieldAction,
  // dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach, slice 5a —
  // eligibility gate for the source-grounded LLM rewrite of "passing-bar-
  // but-short" about_text/visit_text (see generateGardssalgAboutRewrite below).
  gardssalgRewriteEligible,
  // dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach, slice 5c —
  // fill-only eligibility gate for the "products" JSON-array column (see
  // generateGardssalgProductList below).
  gardssalgProductsEligible,
  // dev-request 2026-07-19-brreg-nace-drikkeprodusenter — NACE discovery
  // landing (display-name transform + name-dedup basis incl. hidden rows).
  brregDisplayName,
  listGardssalgNameDedupRows,
  type GardssalgContentRefreshTarget,
  // dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach, slice 1 —
  // rollback/provenance substrate backing POST /admin/gardssalg-content-rollback
  planGardssalgContentRollback,
  applyGardssalgContentRollback,
  type GardssalgRollbackPlanItem,
  // dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach, slice 3 —
  // Brreg street-address backfill (fills adresse/postnummer/poststed only;
  // geocoding is out of scope, experiences-geocode-worker.ts picks it up)
  selectGardssalgProvidersForAddressEnrichment,
  getGardssalgProviderAddressTarget,
  applyGardssalgProviderAddress,
  type GardssalgAddressEnrichmentTarget,
  // dev-request 2026-07-26-brreg-kontakt-backfill — epost/telefon fill-only
  // backfill from the same GET /enheter/{orgNr} response, for the 344-row
  // cohort that has no contact channel at all today.
  selectGardssalgProvidersForContactBackfill,
  countGardssalgProvidersForContactBackfill,
  getGardssalgProviderContactTarget,
  applyGardssalgProviderContact,
  GS_CB_HARD_CAP,
  type GardssalgContactBackfillTarget,
  // dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach, slice 5b —
  // org_nr backfill via Brreg name-search + exact-name/postal corroboration
  // (auto-write only when both agree; otherwise the review queue).
  selectGardssalgProvidersForOrgnrBackfill,
  getGardssalgProviderOrgnrTarget,
  applyGardssalgProviderOrgnr,
  gardssalgOrgnrAutoWriteEligible,
  upsertGardssalgOrgnrReviewQueue,
  clearGardssalgOrgnrReviewQueueEntry,
  listGardssalgOrgnrReviewQueue,
  type GardssalgOrgnrBackfillTarget,
  // slice 5b integration hardening (2026-07-19 review) — display-suffix
  // strip before search + rolled-back veto.
  gardssalgSearchName,
  gardssalgOrgnrWasRolledBack,
  // slice 5d — shared-/directory-domain guard on the content-refresh route
  // (the hanen.no cross-contamination incident): exclusion decided BEFORE
  // any fetch, reported in its own additive response bucket.
  gardssalgSharedHostCounts,
  gardssalgContentExclusionReason,
  // skive B (2026-07-19, komplett-foer-synlig) — website discovery: candidate
  // generation + ownership evidence + review queue + approved fill-only write.
  selectGardssalgProvidersForWebsiteDiscovery,
  getGardssalgWebsiteDiscoveryTarget,
  gardssalgWebsiteCandidateHosts,
  gardssalgPageText,
  gardssalgWebsiteEvidenceMatch,
  gardssalgContactPageLinks,
  extractGardssalgContactEmail,
  extractGardssalgContactPhone,
  selectGardssalgProvidersForContactExtraction,
  homepageRegistrableDomain,
  upsertGardssalgWebsiteReviewQueue,
  clearGardssalgWebsiteReviewQueueEntry,
  listGardssalgWebsiteReviewQueue,
  stampGardssalgWebsiteDiscoveryAttempt,
  applyGardssalgProviderWebsite,
  // dev-request 2026-07-30-opplevagent-claim-epost-og-perfelt-laas, sub-slice
  // 3d — narrows POST /admin/providers/hjemmeside-write's lock check from
  // row-level content_source to this SAME per-field owner_locks helper
  // (gated on gårdssalg-row identity; see isHjemmesideLocked below).
  isGardssalgFieldOwnerLocked,
  // dev-request 2026-07-21-gardssalg-soekebasert-nettsidefunn — search-based
  // candidate source (tier 2, after the free name-guess tier above): combined
  // social-media + directory/DMO pre-fetch exclusion, query builder, Brave
  // result→host extraction, and the injectable-search test seam.
  gardssalgWebsiteHostExclusionReason,
  gardssalgWebsiteSearchQuery,
  gardssalgWebsiteSearchCandidateHosts,
  getGardssalgWebsiteSearchOverride,
  type GardssalgWebsiteSearchFn,
  // dev-request 2026-07-04-opplevagent-dedup-og-norske-titler, item 1 —
  // re-harvest guard (never insert/resurrect a duplicate already known/merged)
  findExistingExperienceMatch,
  scoreExperienceRichness,
  // dev-request 2026-07-04-opplevagent-dedup-og-norske-titler, item 1 follow-up —
  // admin-triggerable run of the one-off backfill (no flyctl/SSH access to the
  // deployed machine exists in this fleet's tooling, so the backfill script
  // added in PR #209 has no way to execute against the live DB without an
  // HTTP trigger — mirrors this file's other requireAdmin-gated one-off actions).
  runDedupPass,
  // dev-request 2026-07-12-gardssalg-dark-launch-stop, slice 0 — need the
  // full provider row (booking_live + epost) to gate/dispatch bookings.
  getProviderById,
  // dev-request 2026-07-04-opplevagent-dedup-og-norske-titler, item 3
  // (detail completeness weave) — the SAME "published" gate the detail
  // page/`/discover` use, reused by the new catalog-wide coverage report
  // below rather than redefined.
  PUBLISH_GATE_SQL,
  // dev-request 2026-07-19-gardssalg-agent-flater — REST /discover intercept
  // for category=gardssalg_smaking, reusing the EXACT SAME search surface as
  // the discover_gardssalg MCP tool (src/routes/experiences-mcp.ts) instead
  // of routing through discoverExperiencesRelaxed() (which only ever queries
  // `experiences` and has zero gårdssalg rows to find, so its zero-hit
  // fallback used to silently relax category into unrelated results).
  searchGardssalgProviders,
  type GardssalgSearchFilter,
  // dev-request 2026-07-21-opplevagent-norske-tegn-encoding, criterion 3 —
  // mojibake candidate scan (detection only) backing
  // POST /admin/gardssalg-mojibake-backfill below.
  scanGardssalgProviderRowForMojibake,
  selectGardssalgMojibakeCandidates,
  type GardssalgMojibakeCandidate,
  // dev-request 2026-07-29-blacklist-backfill-og-berikelsestriage, slice 2 —
  // berikelsestriage: the SAME shared classifier selectProvidersForContentRefresh
  // uses, reused server-side by GET /admin/providers/content-triage below so
  // the triage and the live selector can never independently drift.
  classifyProviderContentBucket,
  type ProviderContentBucket,
  type BucketableExperienceRow,
} from "../services/experience-store";
// dev-request 2026-07-11-dedup-false-positive-remediation — read-only audit
// of the merged groups the prod backfill produced (titlesMatch()'s single-
// common-token rule merged some genuinely different experiences), consumed by
// the two admin endpoints at the bottom of this file.
import { auditMergedGroups } from "../services/experience-dedup-audit";
// dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach,
// Steg 2 — gårdssalg producer <-> experience/activity cross-table conflict
// diagnosis (GET /admin/gardssalg-experience-conflict-audit) + remediation
// (POST /admin/gardssalg-experience-conflict-remediation) + the rollback
// substrate wired into the EXISTING POST /admin/gardssalg-content-rollback
// below via its new `entity_type` param. NOT the same thing as lokal#440's
// GET /admin/gardssalg-provider-dedup-audit above (that one dedupes
// experience_providers rows against EACH OTHER — same-table dedup; this is a
// producer-vs-experience cross-table identity check).
import {
  runGardssalgExperienceConflictScan,
  planGardssalgExperienceConflictRemediation,
  applyGardssalgExperienceConflictRemediation,
  verifyGardssalgExperienceConflictWrites,
  buildAmbiguousExperienceDetail,
  planExperienceConflictRollback,
  applyExperienceConflictRollback,
  type GsExpMatchedPair,
  type GsExpConflictPlanItem,
  type GsExpConflictRollbackPlanItem,
} from "../services/gardssalg-experience-conflict";
// dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach,
// Steg 3 ("nettside-verifisering-i-berikelse"), scoped-down slice — a new,
// independent sweep that checks each gårdssalg producer's stored hjemmeside
// against gardssalgWebsiteEvidenceMatch (reused unchanged) and stamps the
// result onto field_provenance.hjemmeside_verification. GET
// /admin/gardssalg-website-verification-audit (read-only) + POST
// /admin/gardssalg-website-verification-remediation (dry-run by default),
// below. Does NOT gate the existing content-refresh pipeline (deliberately
// out of scope for this slice) and does NOT duplicate POST
// /admin/gardssalg-website-discovery (that endpoint finds a REPLACEMENT url
// for a BLANK hjemmeside; this one only judges whether an EXISTING
// hjemmeside is verifiably the producer's own).
import {
  loadGardssalgWebsiteVerificationCohort,
  scanGardssalgWebsiteVerificationRows,
  planGardssalgWebsiteVerificationRemediation,
  applyGardssalgWebsiteVerification,
  GS_WV_SCOPES,
  GS_WV_COHORTS,
  type GsWvFetchFn,
  type GsWvScope,
  type GsWvCohort,
} from "../services/gardssalg-website-verification";
// orchestrator dev-request 2026-08-03-gardssalg-field-concordance:
// GET /admin/gardssalg-field-concordance-audit — read-only per-field
// concordance check (DB-stored value vs. what's actually findable on the
// producer's own already-verified homepage) over the verified drink-producer
// cohort. Pure comparison logic lives entirely in gardssalg-field-
// concordance.ts (no DB access, no fetch) — this route only supplies the
// cohort rows (reusing GET /admin/gardssalg-verified-drinkproducer-cohort's
// own provider-id-set query below, unchanged) and each producer's
// already-fetched page text via crFetchGardssalgContent + gardssalgPageText,
// the SAME pipeline content-refresh/website-verification already use.
import {
  buildProviderConcordanceRow,
  summarizeGfc,
  applyGardssalgFieldConcordance,
  GFC_AVVIK_CAPABLE_FIELDS,
  type GfcProviderResult,
  type GfcFieldName,
} from "../services/gardssalg-field-concordance";
// PURE homepage extractors + SSRF guard — REUSED from the rfb search-enrich
// module (same code the rfb POST /admin/homepage-content-refresh uses). Only the
// category mapper differs (experiences vocab, not the food vocab).
import {
  isSafeFetchUrl,
  extractVisibleText,
  summarizeAbout,
  meetsAboutQualityBar,
  mapToExperienceCategories,
  extractPriceFrom,
  extractDurationMin,
  extractSeasons,
  extractIndoorOutdoor,
  extractActivityTags,
  extractBookingUrl,
  // gårdssalg multi-page-crawl content enrichment (Fase 1 item 3)
  summarizeVisit,
  extractOpeningHours,
  // dev-request 2026-07-20-gardssalg-kvalitetsgate-redesign, slice 2/3/4 —
  // the cheap/universal prefilter, reused (not duplicated) as cascade stage
  // 1 of meetsGardssalgAboutQualityBar below.
  meetsAboutCheapBar,
  // dev-request 2026-07-21-gardssalg-soekebasert-nettsidefunn — the SAME
  // braveSearch already used in production by the RFB search-enrich-sweep;
  // reused as-is (no new HTTP client) for the gårdssalg website-discovery
  // route's tier-2 search-based candidate source.
  braveSearch,
  type BraveResult,
  // dev-request 2026-07-21-opplevagent-norske-tegn-encoding, criterion 3 —
  // buildPageEvidence already runs the FIXED decode path (fetchHtml() reads
  // raw bytes + decodeHtmlBytes, PR lokal#360); reused as-is for the mojibake
  // backfill route's re-fetch step (no new fetch implementation). containsMojibake
  // is the same detector scanGardssalgProviderRowForMojibake uses, reused
  // here as the "is the freshly re-extracted candidate itself still corrupt"
  // safety net before ever writing it.
  buildPageEvidence,
  containsMojibake,
  type PageEvidence,
} from "../services/search-enrich";
// dev-request 2026-07-27-fetch-infrastruktur-diagnose (P0-1) — the shared,
// CLASSIFIED fetcher. It owns the charset-correct decode that used to be done
// here via decodeHtmlBytes (PR lokal#365), and adds the named failure reason,
// the one-shot transient retry and the empty-body check.
import { fetchPage, discoverContentLinks, type FetchPageResult } from "../services/fetch-page";
import { classifyProvider, sleep, BrregClass } from "../services/experience-brreg";
// dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach, slice 3 —
// Brønnøysundregistrene business-address lookup (same GET /enheter/{orgNr}
// endpoint verifyOrgNumber()/fetchBrregActivityDescription() already call).
import { fetchBrregBusinessAddress, BRREG_BASE_URL, BRREG_SEARCH_PATH } from "../services/brreg-client";
// dev-request 2026-07-12-experiences-enrichment-supply-and-aggregator-
// hygiene, step 2, evidence-leg (b) — Brreg's own hjemmeside field, direct
// by org-nr (same GET /enheter/{orgNr} endpoint the three lookups above already
// call). See POST /admin/brreg-website-discovery below.
import { fetchBrregWebsite } from "../services/brreg-client";
// dev-request 2026-07-26-brreg-kontakt-backfill — epostadresse/telefon/mobil
// out of that SAME GET /enheter/{orgNr} response (fields no code read until
// now). See POST /admin/gardssalg-contact-backfill below.
import { fetchBrregContact } from "../services/brreg-client";
// dev-request 2026-07-26-booking-test-send-guard — the two admin-gated test
// drivers below (POST /admin/booking-test-send, POST /admin/claim-test-send)
// are the ONLY call sites that may set the per-transaction test flag.
import { testSendRedirectAddress } from "../services/send-guard";
import {
  issueClaimMagicLink,
  getClaimProviderById,
  isClaimableDomain,
  backfillGardssalgOwnerLockProvenance,
} from "../services/gardssalg-claim";
import { normalizeDomain } from "../services/blocklist-service";
import { emailService } from "../services/email-service";

// Same derivation as gardssalg-claim.ts's own constant — the verify URL must
// point at the host that serves the claim routes.
const OPPLEVAGENT_CLAIM_BASE_URL = (process.env.OPPLEVAGENT_BASE_URL || "https://opplevagent.no").replace(/\/$/, "");
// dev-request 2026-07-19-agg-website-leak — reuse the curated DMO/aggregator
// host classifier (same one admin-knowledge.ts's classifyWebsite() uses) so a
// harvest row's `website` is never blindly trusted as a provider's OWN
// homepage on CREATE. See isAggregatorWebsite()/firstNonAggregatorWebsite()
// below, near the bulk-load handler that consumes them.
import {
  isDirectoryOrAggregatorHost,
  hostFromUrlLike,
  registrableDomain,
  PLACEHOLDER_EMAIL_DOMAINS,
} from "../services/cross-source-validator";
// dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach, slice 5b —
// Brreg name-search (candidate generator only, see gardssalgOrgnrAutoWriteEligible);
// verifyOrgNumber (existing, cached) backs the write-bar's liveness veto — an
// exact-name match to a bankrupt/deregistered org must never claim a row.
// scoreNameMatch: NACE-discoveryens navne-dedup mot eksisterende gårdssalg-rader.
// normaliseName: dev-request 2026-07-31-gardssalg-provider-dubletter-på-tvers-
// av-seeds — bucketing key for GET /admin/gardssalg-provider-dedup-audit below
// (same normalization scoreNameMatch itself uses internally for its
// first-token tier, re-exposed here so the audit route can pre-bucket rows
// instead of comparing every row against every other row).
import { findOrgnumberByName, verifyOrgNumber, scoreNameMatch, normaliseName } from "../services/brreg-client";
// dev-request 2026-07-19-brreg-nace-drikkeprodusenter — kommune→fylke best-effort
// ved landing av nye NACE-oppdagede providere.
import { cityToFylke } from "../services/norway-fylke";
import {
  createBooking,
  getBookingByRef,
  getBookingByToken,
  getCommissionStatement,
  BookingInputSchema,
  buildIcs,
  sendBookingConfirmation,
  // dev-request 2026-07-12-gardssalg-dark-launch-stop, slice 0
  isBookingPaused,
  sendProducerNotification,
  // booking-flyt-v1 slice 2: pre-visit reminder + auto-expiry engine
  processBookingFollowups,
} from "../services/booking-store";
// dev-request 2026-07-25-reisesok…, Fase 2 — corridor discovery API.
import { buildReiseApiRouter } from "./reise-api";
import { getDb as getExperiencesDbHandle } from "../database/db-factory";

const APP_URL = process.env.APP_URL || "https://opplevagent.no";

const router = Router();

// ── GET /api/opplevelser/reise — corridor discovery ───────────────────
// dev-request 2026-07-25-reisesok…, Fase 2. Mirror of the RFB mount in
// marketplace.ts, carrying the OTHER half of the catalogue — experiences +
// gårdssalg, and never a single RFB row. See reise-api.ts's header for why the
// source list is closed over rather than read from the query string.
//
// Mounted here, at the top, so it is matched before this file's
// `router.get("/:id")` (≈line 5343), which would otherwise swallow /reise as
// an experience UUID lookup.
router.use(buildReiseApiRouter({
  sources: ["experience", "gardssalg"],
  databases: () => ({ experiencesDb: getExperiencesDbHandle("experiences") }),
}));

function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const expected = getAdminKey();
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (!expected || !provided || provided !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return;
  }
  next();
}

function parseDiscoverQuery(req: Request) {
  const num = (v: unknown) => {
    const n = parseInt((v as string) || "", 10);
    return Number.isFinite(n) ? n : undefined;
  };
  // Geo params (lat/lng/radius_km) are floating-point, unlike the existing
  // int-only filters above — a separate parseFloat helper (dev-request
  // 2026-07-04-opplevagent-naer-meg-geosok, item 2).
  const numFloat = (v: unknown) => {
    const n = parseFloat((v as string) || "");
    return Number.isFinite(n) ? n : undefined;
  };
  return DiscoverFilterSchema.parse({
    fylke: req.query.fylke as string | undefined,
    kommune: req.query.kommune as string | undefined,
    category: req.query.category as string | undefined,
    indoor_outdoor: req.query.indoor_outdoor as string | undefined,
    weather: req.query.weather as string | undefined,
    season: req.query.season as string | undefined,
    group_size: num(req.query.group_size),
    age: num(req.query.age),
    max_price: num(req.query.max_price),
    duration_max: num(req.query.duration_max),
    language: req.query.language as string | undefined,
    lat: numFloat(req.query.lat),
    lng: numFloat(req.query.lng),
    radius_km: numFloat(req.query.radius_km),
    sort: req.query.sort as string | undefined,
  });
}

// ─── GET /api/opplevelser/discover — intent discovery ───────────────
// «Hva kan vi finne på i Oslo (det regner)»:
//   /api/opplevelser/discover?fylke=Oslo&weather=rain&group_size=4
router.get("/discover", (req: Request, res: Response) => {
  try {
    const filter = parseDiscoverQuery(req);
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || "20", 10) || 20));

    // dev-request 2026-07-19-gardssalg-agent-flater: gårdssalg (farm-sale
    // drink producer) rows live in experience_providers, NOT `experiences` —
    // discoverExperiencesRelaxed() only ever queries `experiences`, so
    // category=gardssalg_smaking always got zero direct hits there, and its
    // zero-hit fallback then silently dropped `category` (and possibly other
    // filters) one at a time until it found UNRELATED experiences to return.
    // Intercept BEFORE discoverExperiencesRelaxed() runs and route to the
    // real gårdssalg search surface instead — every other category value
    // falls straight through to the unchanged relaxation path below.
    if (filter.category === "gardssalg_smaking") {
      const gsFilter: GardssalgSearchFilter = {};
      if (filter.fylke) gsFilter.fylke = filter.fylke;
      if (filter.kommune) gsFilter.kommune = filter.kommune;
      // producer_type is gårdssalg-specific — not part of DiscoverFilterSchema —
      // so it's read directly off the raw query, same as booking_live below.
      const producerType = req.query.producer_type as string | undefined;
      if (producerType) gsFilter.producer_type = producerType;
      // Only the literal string "true" is a real filter — omitted/false means
      // "no filter on this column" (matches discover_gardssalg's own
      // isBookingPaused-adjacent semantics, NOT "show only paused ones").
      if (req.query.booking_live === "true") gsFilter.booking_live = true;
      if (typeof filter.lat === "number") gsFilter.lat = filter.lat;
      if (typeof filter.lng === "number") gsFilter.lng = filter.lng;
      if (typeof filter.radius_km === "number") gsFilter.radius_km = filter.radius_km;
      const hasGeo = typeof gsFilter.lat === "number" && typeof gsFilter.lng === "number";

      const gsResults = searchGardssalgProviders(gsFilter, limit);
      res.json({
        vertical: "gardssalg",
        query: gsFilter,
        count: gsResults.length,
        results: gsResults.map((row) => {
          // Same shape/construction as discover_gardssalg's own formatting
          // (src/routes/experiences-mcp.ts) — kept byte-identical on purpose
          // so an agent gets the same honest booking status either surface.
          const live = !isBookingPaused(row.booking_live);
          return {
            navn: row.navn,
            fylke: row.fylke ?? null,
            kommune: row.kommune ?? null,
            producer_type: row.producer_type ?? null,
            lat: row.lat ?? null,
            lon: row.lon ?? null,
            geocode_confidence: row.geocode_confidence ?? null,
            booking: {
              live,
              mode: live ? ("request" as const) : ("paused" as const),
              note: live
                ? "Book direkte. / Book directly."
                : "Reservasjoner åpner snart; ta kontakt via profilsiden. / Bookings open soon; visit the profile page to get in touch.",
            },
            profile_url: row.slug ? `${APP_URL}/kategori/gardssalg/produsent/${row.slug}` : null,
            // Only present when an origin (lat/lng) was given — mirrors the
            // experiences-branch's own ...(hasGeo ? {...} : {}) spread below.
            ...(hasGeo ? { distance_km: row.distance_km ?? null } : {}),
          };
        }),
      });
      return;
    }

    const { results, relaxedKeys } = discoverExperiencesRelaxed(filter, limit);
    const note = buildRelaxationNote(relaxedKeys);
    const suggestions = buildNarrowingSuggestions(results, relaxedKeys);
    // distance_km/geo_precision are only meaningful (and only ever present)
    // when an origin was given — omitting lat/lng must produce byte-identical
    // rows to before this feature existed.
    const hasGeo = typeof filter.lat === "number" && typeof filter.lng === "number";
    res.json({
      vertical: "experiences",
      query: filter,
      count: results.length,
      relaxed_filters: relaxedKeys.length > 0 ? relaxedKeys : undefined,
      note: note ?? undefined,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
      results: results.map((e) => ({
        id: e.id,
        slug: e.slug,
        title: e.title,
        title_no: e.title_no,
        category: e.category,
        fylke: e.fylke,
        kommune: e.kommune,
        indoor_outdoor: e.indoor_outdoor,
        duration_min: e.duration_min,
        price_from: e.price_from,
        price_band: e.price_band,
        booking_url: e.booking_url,
        confidence: e.confidence,
        tags: e.tags,
        ...(hasGeo
          ? {
              distance_km: e.distance_km ?? null,
              // Honesty about precision: 'address' = geocoded from the
              // provider's exact street address; 'kommune' = a municipality
              // centroid (approximate) — never presented as an exact distance.
              geo_precision: e.geo_precision ?? null,
            }
          : {}),
      })),
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid query", details: err.issues });
      return;
    }
    console.error("[opplevelser] /discover failed", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── GET /api/opplevelser/categories ────────────────────────────────
router.get("/categories", (_req: Request, res: Response) => {
  res.json({ categories: listCategories() });
});

// ─── POST /api/opplevelser/admin/bulk-load (admin) ──────────────────
// Bulk-load harvested providers+experiences for the Skjer vertical with
// SERVER-SIDE Brreg verification (the harvest sandbox can't reach Brreg;
// the lokal app can). Default is a DRY-RUN (writes nothing) — pass
// apply:true to actually insert.
//
// Pipeline (mirrors the rfb quality fix):
//   1. group rows by provider_name
//   2. classify each distinct provider via Brreg (paced + capped)
//   3. NEVER insert `inactive` providers (slettet/konkurs/avvikling, e.g.
//      Glaciertour). Insert `verified_active` always; insert `unverified`
//      only when evidence-backed (an evidence_url on at least one row).
//   4. idempotent: skip a provider already present (org_nr or name), skip
//      an experience whose (provider, title) already exists.
//
// NB: MUST come before "/:id" so "admin" isn't swallowed as an id param.

export const BulkRowSchema = z.object({
  title: z.string().min(1),
  provider_name: z.string().min(1),
  category: z.string().optional().nullable(),
  subcategory: z.string().optional().nullable(),
  activity_tags: z.array(z.string()).optional(),
  season: z.array(z.string()).optional(),
  indoor_outdoor: z.enum(["indoor", "outdoor", "both"]).optional().nullable(),
  kommune: z.string().optional().nullable(),
  fylke: z.string().optional().nullable(),
  price_from: z.number().int().optional().nullable(),
  duration_min: z.number().int().optional().nullable(),
  booking_url: z.string().optional().nullable(),
  evidence_url: z.string().optional().nullable(),
  confidence: z.enum(["high", "medium", "low"]).optional().nullable(),
  website: z.string().optional().nullable(),
  // `hjemmeside` is an ACCEPTED ALIAS for `website` (dev-request
  // 2026-07-27-harvest-hjemmeside-feltnavn-tapes).
  //
  // The harvest SKILL (scheduled-agents/experiences-harvest.md) has been
  // telling its agent to send `hjemmeside` — under the heading "Build rows
  // matching BulkRowSchema EXACTLY" — while this schema only ever accepted
  // `website`. z.object() strips unknown keys silently, so every harvested
  // homepage was discarded at the door, with no error and no warning: the
  // request 200s, the provider is created, and its `hjemmeside` column is
  // NULL.
  //
  // That is not a cosmetic mismatch. `firstNonAggregatorWebsite()` below is the
  // ONLY input to the provider-CREATE homepage write, so the provider is
  // created with a NULL homepage.
  //
  // CORRECTED after independent review — the first version of this comment
  // claimed such a provider "can never be content-enriched". That is not what
  // the code does. selectProvidersForContentRefresh()
  // (services/experience-store.ts) COALESCEs the homepage with the provider's
  // first non-empty experience `evidence_url`, and its WHERE clause explicitly
  // admits `hjemmeside IS NULL` rows that have one. Since bulk-load requires an
  // `evidence_url` for `unverified` providers, most affected providers WERE
  // still picked up for content-refresh.
  //
  // The real harm is subtler and arguably worse: enrichment then fetched and
  // extracted from the EVIDENCE url — the DMO/listing page the provider was
  // discovered on — instead of the provider's own site. That is the same
  // aggregator-as-homepage failure mode dev-request 2026-07-19-agg-website-leak
  // was filed for, and it is why enrichment runs kept reporting `fetch_failed`
  // against visitnorway.com / visithelgeland.com URLs.
  //
  // Accepting BOTH names here (rather than only correcting the SKILL) is
  // deliberate: Cloud Routines have repeatedly been observed executing a
  // STALE copy of their SKILL text (see dev-request
  // 2026-07-17-brreg-discovery-indexerror-og-stale-dispatch, reproduced three
  // times), so a fix that depends on new SKILL text reaching the runner would
  // not take effect reliably. A server-side alias works for old and new
  // callers alike.
  hjemmeside: z.string().optional().nullable(),
});
const BulkLoadSchema = z.object({
  experiences: z.array(BulkRowSchema).min(1).max(5000),
  apply: z.boolean().optional().default(false),
});
export type BulkRow = z.infer<typeof BulkRowSchema>;

// dev-request 2026-07-19-agg-website-leak: a 2026-07-12 harvest run wrote a
// regional tourism-aggregator/DMO page (a KNOWN_DIRECTORY_HOSTS entry) into
// 5 providers' `hjemmeside` on CREATE — those providers have since failed
// every enrichment content-refresh fetch (http_unreachable), because
// content-refresh fetches whatever's in `hjemmeside`. A harvest row's
// `website` is evidence of where the provider was DISCOVERED, not proof it's
// the provider's OWN site, so it must be screened the same way
// admin-knowledge.ts's classifyWebsite()/parsedHostForUrl() screen
// agents.url/knowledge.website before treating a host as aggregator-owned.
//
// Permissive by design: only KNOWN aggregator/directory hosts are rejected;
// a merely-malformed or unparseable URL is NOT rejected here (that's a
// separate concern from provenance-trust, and over-rejecting would silently
// drop a real homepage the harvester just formatted oddly).
// Parsed with hostFromUrlLike(), NOT with new URL() (round-4 review, blocking).
// This function and looksLikeHomepageValue() below screen the SAME string, and
// while they used two different parsers they disagreed on a whole input class —
// with the aggregator winning every time:
//
//   new URL("http://visitnorway.com:99999")  throws (port > 65535)
//     -> the catch below returned false, i.e. "not an aggregator"
//   hostFromUrlLike("http://visitnorway.com:99999")  ->  "visitnorway.com"
//     -> the shape screen passed
//
// so `http://visitnorway.com:99999/` was stored as a provider homepage AND
// discarded the row's real `hjemmeside`. Same for :80443, :abc, :-1, and the
// visithelgeland.com equivalents. One parser, used by both, closes the class —
// and removes the fail-open at the same time, since hostFromUrlLike returns a
// host for anything host-shaped rather than throwing.
//
// Still permissive about what it does NOT know: only KNOWN aggregator/directory
// hosts are rejected. A merely-malformed URL is not this function's business
// (that is looksLikeHomepageValue's job) — over-rejecting here would silently
// drop a real homepage the harvester just formatted oddly.
// Exported for tests (round-6 review): this function is the SOLE classifier
// for POST /admin/hjemmeside-cleanup-sweep, which irreversibly NULLs a
// provider's homepage — yet every assertion about it went through
// firstNonAggregatorWebsite, where looksLikeHomepageValue rejects the
// interesting inputs first. Five guards therefore survived their own removal
// with the full suite green. Testing it directly is the only way to pin the
// behavior the sweep actually depends on.
export function isAggregatorWebsite(raw: string): boolean {
  // BOTH parsers, new URL() first (round-5 review). Round 4 replaced new URL()
  // with hostFromUrlLike() to end their disagreement, and that did close the
  // invalid-port hole — but it opened two others, because new URL() does things
  // hostFromUrlLike does not: it percent-decodes the host and treats `\\` as a
  // path separator. So `http://visitnorway%2Ecom/` and
  // `http://visitnorway.com\\evil` stopped being recognized as aggregators, and
  // `http://gard.no\\@visitnorway.com` started being recognized as one — a FALSE
  // POSITIVE in applyHjemmesideListingSweepToRow, which NULLs the homepage.
  //
  // Preferring new URL() and falling back only when it throws keeps every case
  // it used to catch AND closes the invalid-port hole it could not, with no new
  // false positive. Two parsers is fine; two parsers that disagree about which
  // one is authoritative is not.
  let host: string | null = null;
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    host = new URL(withScheme).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    host = hostFromUrlLike(raw);
  }
  if (!host) return false;
  return isDirectoryOrAggregatorHost(host);
}

// Does `v` have the SHAPE of a real homepage — i.e. does it parse to a host
// with at least two labels and a plausible TLD? Used only to keep placeholder
// junk out of experience_providers.hjemmeside.
//
// Why this exists at all: isAggregatorWebsite() is permissive about
// unparseable URLs BY DESIGN (a real homepage the harvester formatted oddly
// must not be dropped), so it passes anything that isn't a KNOWN aggregator
// host. A placeholder like "n/a" or "TBD" is therefore truthy, survives the
// aggregator screen, and gets written verbatim — and a junk homepage is worse
// than a null one, because it satisfies neither branch of
// selectProvidersForContentRefresh()'s hjemmeside/evidence_url COALESCE.
//
// Round-3 review, blocking: the first version of this was `v.includes(".")`,
// which only catches dot-LESS junk. "n.a", "n.a.", "-.-", "tbd.", "1.2.3.4",
// "post@gard.no" and "Se nettsiden deres." all passed it, got stored, AND
// shadowed a real `hjemmeside` in the same row — the third repetition of the
// exact defect class this function was twice rewritten to fix. The check was
// calibrated to its own test fixtures rather than to the shape of a hostname.
//
// So: screen the PARSED HOST, not the raw string. hostFromUrlLike() already
// does the parse the rest of this file uses (scheme/path/query/port/userinfo
// stripped, trailing FQDN root dot removed, IDN → punycode, lowercased), so
// `gard.no/kontakt`, `https://gard.no?a=b`, `GÅRD.NO`, `gård.no` and
// `gard.no.` all reduce to the same accepted host, while `http://gardsbutikken
// /index.html` correctly fails on its dot-less HOST even though its path has a
// dot. Requiring ≥2 non-empty labels plus an alphabetic (or punycode) TLD of
// ≥2 chars additionally rejects "n.a", "a.b", "-.-" and bare IPv4 literals.
//
// isPlausibleUrlish() below carries the length + no-whitespace half of the
// same contract and is the sanctioned guard for the OTHER writer of this
// column (PATCH /admin/providers/:id/hjemmeside, which 400s on failure) —
// reuse it rather than growing a second, weaker validator for one column
// (round-3 review). Declarations hoist, so the forward reference is fine.
//
// Round-4 review, blocking: `@` was rejected anywhere in the string, on the
// reasoning that hostFromUrlLike() strips userinfo so "post@gard.no" would
// reduce to a valid host. True for the AUTHORITY — but `@` is perfectly legal
// in a path, query or fragment, and the blanket test dropped
// "https://gard.no/kontakt?epost=post@gard.no", "https://gard.no/@gardsbutikk"
// and "https://gard.no/side#a@b" to null. `origin/main` stored all three. A
// false rejection is not a lesser sin here: it is this PR's own failure mode
// (a real producer homepage silently lost) reintroduced with a new cause. So
// the check now looks only at the authority, which still rejects a bare
// "post@gard.no" and the "https://gard.no@visitnorway.com" userinfo swap.
function authorityOf(v: string): string {
  // The `^\/\/` strip mirrors cross-source-validator's stripProtocol (round-5
  // review). Without it the two disagreed on a protocol-relative value:
  // "//gard.no@visitbergen.com" had no `@` in what THIS function called the
  // authority, so the guard passed, while hostFromUrlLike read the host as
  // `visitbergen.com` — the same two-parsers-disagreeing class one layer down.
  const afterScheme = v.replace(/^[a-z0-9+.-]+:\/\//i, "").replace(/^\/\//, "");
  return afterScheme.split("/")[0]!.split("?")[0]!.split("#")[0]!;
}

// Registrable-domain placeholders that parse perfectly but are never anyone's
// homepage (round-4 review, blocking). PLACEHOLDER_EMAIL_DOMAINS is the repo's
// EXISTING list of exactly these sentinels — "left behind by boilerplate
// contact forms / CMS themes" — and every one of them sailed through the
// round-3 host-shape check. Reusing it rather than writing a fourth list is
// the same "don't reinvent a weaker validator" correction round 3 made.
//
// example.com is the one that matters most in practice: it is RFC-2606
// reserved and is the single most likely thing an LLM harvester emits when
// told to fill a URL field it does not know.
// Words that are a placeholder wherever they appear as a domain LABEL, not a
// producer's name. This replaces a KNOWN_TLDS allowlist that round-5 review
// dismantled, correctly and at the root: a TLD-RECOGNITION heuristic is not a
// junk-DETECTION heuristic, and the two are uncorrelated. Measured on the real
// values —
//
//   ukjent.no, nettside.no, eksempel.no   -> recognized TLD, pure junk
//   storgarden.nu, storgarden.tech        -> unrecognized TLD, real producers
//
// — so ranking by TLD promoted the junk and demoted the producers, which is the
// exact shadowing this function has now been rewritten five times to stop.
//
// What the junk actually has in common is the OTHER label: `ikke`.oppgitt,
// `ingen`.hjemmeside, `kommer`.snart, `null`.null, `ukjent`.no,
// `nettside`.no. So screen the labels, and keep the list conservative: with the
// tiering gone this is a HARD reject, and a false reject costs a homepage. Only
// words that are never a Norwegian producer's own name are listed — "under" and
// "se" were considered and deliberately left out as too plausible.
const PLACEHOLDER_DOMAIN_LABELS: ReadonlySet<string> = new Set([
  // Norwegian
  "ikke", "ikkeoppgitt", "oppgitt", "ingen", "ukjent", "mangler", "kommer",
  "snart", "hjemmeside", "nettside", "nettsted", "eksempel", "tilgjengelig",
  "arbeid", "finnesikke",
  // English / machine
  "example", "unknown", "none", "null", "undefined", "placeholder", "tbd",
  "insert", "yourdomain", "yourcompany", "dummy", "todo", "notfound",
]);

function isPlaceholderHomepageHost(host: string): boolean {
  // hostFromUrlLike already strips `www.`; kept only because this function is
  // also reachable with a hand-built host in tests.
  const bare = host.replace(/^www\./, "");
  // registrableDomain() from cross-source-validator handles MULTI_LABEL_SUFFIXES
  // (co.uk et al.); the local last-two-labels version this replaces returned
  // "co.uk" for "example.co.uk" and would have defeated any multi-label entry
  // added to PLACEHOLDER_EMAIL_DOMAINS later (round-5 review — the same
  // "don't reinvent a weaker validator" correction round 3 made).
  // One check, not two (round-6 review): a separate `includes(bare)` line was
  // unfalsifiable — registrableDomain(x) === x for every two-label host, and
  // PLACEHOLDER_EMAIL_DOMAINS contains no multi-label-suffix entry, so no input
  // could distinguish them. A guard no test can kill is not a guard.
  if (PLACEHOLDER_EMAIL_DOMAINS.includes(registrableDomain(bare))) return true;
  // Only the REGISTRABLE domain's labels, not every label of the host (round-6
  // review): screening every label rejected ordinary Norwegian hosting
  // subdomains — `hjemmeside.storgarden.no`, `nettside.storgarden.no` — which
  // origin/main stored. The junk this list targets sits at the registrable
  // level.
  //
  // A label counts as a placeholder if it COLLAPSES to one of the words, or if
  // any of its separator-split WORDS is one (round-7 review, BLOCKING). The
  // previous version only collapsed separators, so it caught `ikke-oppgitt`
  // solely because "ikkeoppgitt" happened to be hard-coded — and that is the
  // one hyphenated compound with a test. The other two named in this very
  // comment block, `ingen-hjemmeside` and `kommer-snart`, sailed through, as
  // did `under-arbeid`; measured against origin/main all three are stored and,
  // in `hjemmeside`, now beat a real `website`. Fixture-calibration once more,
  // inside the screen written to escape fixture-calibration.
  //
  // Splitting into words makes the rule general instead of enumerated: a label
  // built out of status words is a placeholder however it is spelled. It also
  // means "under" need not be listed — `under-arbeid` is caught by "arbeid" —
  // so round 5's conservative omissions still stand.
  //
  // "Any position" is kept — NOT narrowed to "last split word only" (oppfølging,
  // dev-request 2026-07-27-384-placeholder-regel-etterslep, funn 1). A "last
  // word only" narrowing was tried in an earlier commit on this same PR to stop
  // hard-rejecting real-looking REGISTERED domains whose FIRST component is a
  // status word used as a modifier rather than the placeholder itself:
  // `arbeid-helse.no`, `hjemmeside-design.no`, `null-utslipp.no`, `todo-as.no`.
  // An independent fresh-context review of that commit found it reintroduces a
  // real, previously-nonexistent false-accept regression: any qualifier-first
  // junk compound whose TRAILING word is one of the ~14 status NOUNS still
  // reads as a placeholder to a human, but if that trailing word happens NOT to
  // be one of the ~14 words in PLACEHOLDER_DOMAIN_LABELS, "last word only"
  // waves it through — even though the LEADING word is a dead giveaway.
  // Concretely, `ukjent-produsent.no`, `mangler-info.no`, `ingen-svar.no`,
  // `snart-ferdig.no`, `eksempel-gaard.no`, `tbd-gaarden.no` were all correctly
  // rejected under "any position" (they still are, pinned in alias-30c below)
  // but would have silently started being ACCEPTED under "last word only" —
  // each one starts with a genuine PLACEHOLDER_DOMAIN_LABELS word (ukjent,
  // mangler, ingen, snart, eksempel, tbd) followed by a trailing word that is
  // not separately listed. That false-accept surface is unbounded — any junk
  // qualifier + any noun — whereas the four named domains this PR wanted to
  // rescue are a closed, measured set (0 of 335 real producer hosts affected
  // either way). So "any position" stays: the four domains above remain
  // rejected (pinned in alias-30, re-purposed to assert `null` rather than
  // accept), and the false-accept class the narrowing would have opened is
  // pinned rejected too (alias-30c) so nobody re-attempts the same "last word"
  // narrowing blind in a future round without a test going red.
  //
  // The underscore half of `[-_]` here is DEAD CODE for this function's only
  // caller (oppfølging, finding 4): looksLikeHomepageValue() below calls this
  // function BEFORE its own per-label DNS-shape regex
  // (`/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/`), which has no `_` in its
  // character class and therefore rejects EVERY label this function could ever
  // see that contains one — regardless of what this function decides. Every
  // label `isPlaceholderLabel` examines is also one of `host`'s own labels (the
  // registrable domain is a suffix of the host), so whichever check runs first
  // is redundant with the other whenever `_` is present. Verified by mutation:
  // dropping `_` from BOTH regexes here (collapse to `-` only) leaves the full
  // suite green — `ikke_oppgitt.no`/`ingen_nettside.no` (alias-28) still yield
  // null, via the DNS-shape regex instead. Only dropping `_` from THIS function
  // AND relaxing the DNS-shape regex to also allow `_` is what turns those two
  // fixtures red — proof the DNS-shape regex, not this split, is what pins
  // them today (their comment in the test file has been corrected to say so).
  // Left in rather than removed: harmless, cheap, and a future caller of this
  // now-still-unexported function that skips the DNS-shape regex would need it.
  //
  // The COLLAPSE branch below (label.replace(/[-_]/g, "") producing a match)
  // had no falsifying fixture of its own either (finding 5): every existing
  // negative that reaches it — `ikke-oppgitt`, `finnes-ikke` — also has its
  // LAST split word independently in the set ("oppgitt", "ikke"), so the split
  // branch below always caught them too and the collapse branch's removal
  // never went red. Pinned by alias-32 with `your-domain.no`/`your-company.no`:
  // "domain" and "company" are deliberately NOT in PLACEHOLDER_DOMAIN_LABELS
  // (only the collapsed "yourdomain"/"yourcompany" are), so only the collapse
  // branch rejects them — verified by mutation, deleting this line alone flips
  // both to accepted with the rest of the suite unaffected.
  const isPlaceholderLabel = (label: string): boolean => {
    if (PLACEHOLDER_DOMAIN_LABELS.has(label.replace(/[-_]/g, ""))) return true;
    return label.split(/[-_]+/).filter(Boolean).some((w) => PLACEHOLDER_DOMAIN_LABELS.has(w));
  };
  return registrableDomain(bare).split(".").some(isPlaceholderLabel);
}

// Aggregator/DMO hosts that are harvest SOURCES for this endpoint specifically.
// Round-5 review, blocking: the harvest SKILL names these six as the pages the
// agent scrapes, and dev-request 2026-07-19-agg-website-leak documents
// aggregator URLs genuinely arriving in `website` in production — so
// `website` = the source listing, `hjemmeside` = the producer's own site is the
// EXPECTED row shape, not a crafted one. Before this PR the alias was stripped,
// so there was nothing for a DMO `website` to shadow; accepting the alias turns
// a documented gap into active data loss.
//
// Applied ONLY in firstNonAggregatorWebsite, never inside isAggregatorWebsite
// (round-6 review, BLOCKING). I first put it in isAggregatorWebsite and wrote a
// comment claiming it "only decides which of a bulk-load row's own fields
// becomes the provider's homepage". That was false: isAggregatorWebsite is also
// the SOLE classifier for POST /admin/hjemmeside-cleanup-sweep, which runs
// `SET listing_url = ?, hjemmeside = NULL`. Measured on 10 seeded providers,
// origin/main moved 1 and that version moved 9 — irreversibly NULLing the
// homepage of every provider on these six hosts AND their subdomains.
//
// Which is exactly the "speculative add" the note in cross-source-validator.ts
// refuses for these same six hosts, reached by a side door. KNOWN_DIRECTORY_HOSTS'
// own doc warns about it in as many words: "Tourism-board hosts are NOT
// pattern-matched (false-positive risk on an irreversible NULL)."
//
// So the screen lives at the one call site whose harm is actually measured: the
// bulk-load CREATE path, where `website` = the listing the agent scraped and
// `hjemmeside` = the producer's own site is the expected row shape.
const HARVEST_SOURCE_HOSTS: ReadonlySet<string> = new Set([
  "nordnorge.com", "visittromso.no", "visitbergen.com",
  "visitoslo.com", "visittrondheim.no", "fjordtours.com",
]);

function isHarvestSourceHost(raw: string): boolean {
  const host = hostFromUrlLike(raw);
  if (!host) return false;
  return HARVEST_SOURCE_HOSTS.has(registrableDomain(host));
}

function looksLikeHomepageValue(v: string): boolean {
  if (!isPlausibleUrlish(v)) return false;
  if (authorityOf(v).includes("@")) return false;
  const host = hostFromUrlLike(v);
  if (!host) return false;
  if (isPlaceholderHomepageHost(host)) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  // Per-label DNS shape, not just the TLD (round-4 review, minor): "-gard.no"
  // and "gard-.no" are RFC-invalid and were being stored. 63 is the DNS label
  // limit; the only other length bound was isPlausibleUrlish's 2048 chars.
  if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return false;
  const tld = labels[labels.length - 1]!;
  // Punycode TLDs (xn--…) are vanishingly rare for Norwegian producers but are
  // legitimate, so admit them explicitly rather than by accident. Pinned by
  // alias-32 (finding 5, dev-request 2026-07-27-384-placeholder-regel-etterslep)
  // — had no falsifying fixture before; verified by mutation that deleting this
  // alternative flips it to rejected with no other fixture affected.
  return /^[a-z]{2,}$/.test(tld) || /^xn--[a-z0-9-]{2,}$/.test(tld);
}

// First row's `website` — or its accepted alias `hjemmeside` — that has the
// shape of a homepage AND is not a known aggregator/directory host, else null.
// Used for the provider-CREATE `hjemmeside` write only (see below).
// Order-independent in both directions: an aggregator/junk value earlier in
// `rows`, or in the sibling field of the SAME row, is skipped in favor of a
// later real domain. Returns the candidate VERBATIM (trimmed) — the parsed
// host is used for screening only, never for the stored value, so a legitimate
// deep link like `gard.no/gardsbutikk` survives intact.
export function firstNonAggregatorWebsite(rows: BulkRow[]): string | null {
  // `website` and its accepted alias `hjemmeside` (see BulkRowSchema) are
  // treated identically; `website` wins when a row carries both with content.
  //
  // `||` on the TRIMMED value, deliberately not `??` (independent review,
  // blocking): `??` only falls through on null/undefined, so a row with
  // `website: ""` — which the schema accepts, and which an LLM harvester
  // filling every documented key with a placeholder produces routinely —
  // would shadow a perfectly good `hjemmeside` and yield null. That is the
  // very failure this alias exists to fix, reintroduced one field over.
  //
  // Trimming matters just as much: a whitespace-only `website` is truthy and
  // survives isAggregatorWebsite() (which is deliberately permissive about
  // unparseable URLs), so it would be written verbatim into
  // experience_providers.hjemmeside — and a whitespace homepage is strictly
  // WORSE than a null one. selectProvidersForContentRefresh() requires
  // `TRIM(hjemmeside) != ''` for its primary branch and `hjemmeside IS NULL`
  // for its evidence_url fallback, so a whitespace value satisfies neither and
  // drops the provider out of content-refresh entirely.
  // Screen EACH candidate independently — do not pick a winner first and screen
  // afterwards (round-2 review, blocking). Resolving `website || hjemmeside`
  // into one value before the aggregator check meant a row carrying an
  // aggregator `website` alongside a perfectly good `hjemmeside` returned null:
  // the aggregator won the `||`, failed the screen, and the loop moved to the
  // NEXT ROW without ever looking at this row's alias. That is the same silent
  // discard this alias exists to fix, one field over — and mixed-field rows are
  // exactly what the stale-dispatch rationale above predicts, while
  // dev-request 2026-07-19-agg-website-leak documents aggregator URLs really
  // arriving in `website` in production.
  //
  // Junk is screened by looksLikeHomepageValue() above — see its comment for
  // why a bare `includes(".")` was not enough.
  //
  // Deliberately NOT case-normalized on the way out, unlike the Brreg-discovery
  // writer's `.trim().toLowerCase()`: a candidate may carry a path, and paths
  // are case-sensitive, so lowercasing the whole value can break a working deep
  // link. Host-level comparisons downstream all go through hostFromUrlLike(),
  // which lowercases, so the differing case in the column is not load-bearing.
  //
  // ── The tiering is GONE (round-5 review, blocking) ──────────────────────
  // Round 4 replaced a strict screen with a two-tier preference: a candidate
  // whose TLD was in a KNOWN_TLDS allowlist won outright, anything else was
  // only a fallback. The stated safety argument was "an omission costs a
  // preference, never a homepage". Round 5 executed it and showed that is
  // false — an omission cost a homepage:
  //
  //   {website: "storgarden.nu",   hjemmeside: "ikke-oppgitt.no"} -> ikke-oppgitt.no
  //   {website: "storgarden.tech", hjemmeside: "hjemmeside.com"}  -> hjemmeside.com
  //
  // and it inverted row order too, breaking this function's own contract. The
  // mechanism was wrong at the root: TLD RECOGNITION is not junk DETECTION,
  // and the two do not correlate. `ukjent.no` is a recognized TLD and pure
  // junk; `.nu` is a mainstream Nordic ccTLD I had simply not listed.
  //
  // So: back to first-passing-candidate, which never lost a homepage, with the
  // junk signal moved to where the junk actually lives — the domain LABEL (see
  // PLACEHOLDER_DOMAIN_LABELS). That screens `ikke.oppgitt`, `ukjent.no` and
  // `nettside.no` alike, and leaves `storgarden.nu` alone.
  // `hjemmeside` FIRST, not `website` (round-6 review, BLOCKING). The two
  // fields do not carry equally trustworthy values, and this file asserted both
  // halves of a contradiction: that `website` = the scraped listing and
  // `hjemmeside` = the producer's own site is the EXPECTED row shape, and that
  // `website` wins when both are present. Under `website`-first the fix only
  // fires when the listing host happens to be on a known list — and review
  // measured 7 of 12 real Norwegian regional tourism hosts (visitlofoten.com,
  // hardangerfjord.com, visitrogaland.com, visitnordfjord.no,
  // visitalesund-geiranger.com, visitvesteralen.com, nasjonaleturistveger.no)
  // beating the real `hjemmeside` in that shape. The list is admittedly
  // incomplete, and no list of this kind can be complete.
  //
  // Preferring `hjemmeside` needs no list. Being precise about why, because the
  // simple version of this argument is not quite true:
  //
  // The harvest SKILL attaches a strict contract to whichever field it sends —
  // "the provider's OWN official homepage", never a DMO/aggregator page, and
  // "if you cannot verify it with certainty, LEAVE IT OPEN — NEVER guess". Its
  // old text sent `hjemmeside`; A2A#411 renames that to `website`. So a row
  // from EITHER a stale or a fresh runner carries the strict contract, and each
  // sends only ONE of the two fields. Precedence therefore never decides a
  // harvest row at all.
  //
  // It decides the MIXED rows, which come from everything else — other
  // bulk-load callers, hand-assembled payloads, transitional states. And there
  // the asymmetry is real and measured: dev-request 2026-07-19-agg-website-leak
  // documents aggregator URLs genuinely arriving in `website` in production,
  // with no equivalent record for the alias. `website` is also the field a
  // generic scraper fills by default.
  //
  // So on the only rows where it matters, `hjemmeside` is the higher-confidence
  // value — and a junk or listing value in it is screened below regardless,
  // which makes this strictly safer than depending on a domain list that this
  // file already admits is incomplete.
  for (const r of rows) {
    for (const candidate of [r.hjemmeside?.trim(), r.website?.trim()]) {
      if (
        candidate
        && looksLikeHomepageValue(candidate)
        && !isAggregatorWebsite(candidate)
        && !isHarvestSourceHost(candidate)
      ) {
        return candidate;
      }
    }
  }
  return null;
}

const MAX_PROVIDERS_PER_CALL = 200;
const BRREG_PACE_MS = 200; // 150–300ms politeness window between Brreg calls

router.post("/admin/bulk-load", requireAdmin, async (req: Request, res: Response) => {
  let body: z.infer<typeof BulkLoadSchema>;
  try {
    body = BulkLoadSchema.parse(req.body);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid body", details: err.issues });
      return;
    }
    console.error("[opplevelser] bulk-load parse failed", err);
    res.status(500).json({ error: "Internal error" });
    return;
  }

  const dryRun = body.apply !== true;

  // ── 1. Group rows by provider_name (trimmed). ─────────────────────
  const byProvider = new Map<string, BulkRow[]>();
  for (const row of body.experiences) {
    const key = row.provider_name.trim();
    const arr = byProvider.get(key);
    if (arr) arr.push(row);
    else byProvider.set(key, [row]);
  }

  // Cap providers/call to avoid hammering Brreg (rows beyond the cap are
  // reported but not classified/inserted this call).
  const allProviderNames = [...byProvider.keys()];
  const providerNames = allProviderNames.slice(0, MAX_PROVIDERS_PER_CALL);
  const cappedProviders = allProviderNames.length - providerNames.length;

  const counts: Record<BrregClass, number> = { verified_active: 0, inactive: 0, unverified: 0 };
  const excludedInactive: string[] = [];
  let providersInserted = 0;
  let experiencesInserted = 0;
  let skipped = 0; // providers/experiences skipped as already-present or non-evidence unverified

  // ── 2–3. Classify + (conditionally) insert, one provider at a time. ─
  for (let i = 0; i < providerNames.length; i++) {
    const name = providerNames[i] as string;
    const rows = byProvider.get(name) as BulkRow[];
    // kommune hint = first row that carries one (helps the Brreg tiebreaker).
    const kommune = rows.find((r) => r.kommune)?.kommune ?? null;

    try {
      // Pace Brreg calls (skip the wait before the first call).
      if (i > 0) await sleep(BRREG_PACE_MS);

      const verdict = await classifyProvider({ name, kommune });
      counts[verdict.classification]++;

      // NEVER insert inactive providers — exclude + record.
      if (verdict.classification === "inactive") {
        excludedInactive.push(name);
        continue;
      }

      // `unverified` only inserts when evidence-backed (≥1 row has evidence_url).
      const evidenceBacked = rows.some((r) => !!r.evidence_url);
      if (verdict.classification === "unverified" && !evidenceBacked) {
        skipped++;
        continue;
      }

      if (dryRun) {
        // Dry-run: count what WOULD be inserted, write nothing.
        // (every row whose (provider,title) we'd create — all rows here,
        // since dry-run has no DB state to dedup against.)
        experiencesInserted += rows.length;
        providersInserted += 1;
        continue;
      }

      // ── apply: resolve-or-create the provider (idempotent). ─────────
      let providerId: string;
      const existing =
        (verdict.org_nr ? getProviderByOrgnr(verdict.org_nr) : null) ?? getProviderByName(name);
      if (existing) {
        providerId = existing.id as string;
        // keep Brreg stamp fresh on a re-run for already-present providers
        if (verdict.brreg_verified === 1) {
          setBrregVerification(providerId, (verdict.brreg_active ?? 0) as 0 | 1, verdict.org_nr ?? undefined);
        }
      } else {
        providerId = createProvider({
          navn: name,
          org_nr: verdict.org_nr,
          kommune,
          fylke: rows.find((r) => r.fylke)?.fylke ?? null,
          hjemmeside: firstNonAggregatorWebsite(rows),
          naeringskode: verdict.naeringskode ?? null,
          brreg_verified: verdict.brreg_verified,
          brreg_active: verdict.brreg_active,
          source: "bulk-load",
          confidence: verdict.match_confidence ?? null,
          verification_status: verdict.classification === "verified_active" ? "verified" : "needs_review",
        });
        // Stamp brreg_checked_at via the verifier path.
        if (verdict.brreg_verified === 1) {
          setBrregVerification(providerId, (verdict.brreg_active ?? 0) as 0 | 1, verdict.org_nr ?? undefined);
        }
        providersInserted += 1;
      }

      // ── insert this provider's experiences (idempotent by title). ───
      // Re-harvest guard (dev-request 2026-07-04-opplevagent-dedup-og-norske-
      // titler, item 1): experienceExistsForProvider()'s exact-title check is
      // subsumed by the fuzzy candidate-key match below (same provider +
      // kommune + fuzzy title) — a re-harvest of an already-known experience
      // (worded differently by a different source) must never insert a new
      // duplicate row, and must never resurrect a row already merged away by
      // the dedup pass (findExistingExperienceMatch only looks at unmerged rows).
      for (const r of rows) {
        const rowKommune = r.kommune ?? kommune;
        const match = findExistingExperienceMatch({
          provider_id: providerId,
          title: r.title,
          kommune: rowKommune,
        });
        if (match) {
          const candidateScore = scoreExperienceRichness({
            subcategory: r.subcategory ?? null,
            activity_tags: r.activity_tags ?? null,
            season: r.season ?? null,
            indoor_outdoor: r.indoor_outdoor ?? null,
            price_from: r.price_from ?? null,
            duration_min: r.duration_min ?? null,
            booking_url: r.booking_url ?? null,
            evidence_url: r.evidence_url ?? null,
            confidence: r.confidence ?? null,
          });
          const existingScore = scoreExperienceRichness(match);
          if (candidateScore > existingScore) {
            applyExperienceContent(match.id, {
              category: r.category ?? null,
              subcategory: r.subcategory ?? null,
              activity_tags: r.activity_tags ?? null,
              season: r.season ?? null,
              indoor_outdoor: r.indoor_outdoor ?? null,
              duration_min: r.duration_min ?? null,
              price_from: r.price_from ?? null,
              booking_url: r.booking_url ?? null,
              // This content came from the HARVEST ROW — i.e. the third-party
              // listing page at r.evidence_url, not the provider's own site.
              // Recording that is the whole point: without it the row is
              // indistinguishable from homepage-extracted content, and the
              // weekly spot-check judges it against the homepage and scores a
              // mismatch that is not an error.
            }, harvestProvenanceOf(r.evidence_url));
          }
          skipped++;
          continue;
        }
        try {
          createExperience({
            provider_id: providerId,
            provider_match_status: "matched",
            title: r.title,
            category: r.category ?? null,
            subcategory: r.subcategory ?? null,
            activity_tags: r.activity_tags,
            season: r.season,
            indoor_outdoor: r.indoor_outdoor ?? null,
            kommune: rowKommune,
            fylke: r.fylke ?? null,
            price_from: r.price_from ?? null,
            duration_min: r.duration_min ?? null,
            booking_url: r.booking_url ?? null,
            evidence_url: r.evidence_url ?? null,
            confidence: r.confidence ?? null,
            discovery_source: "bulk-load",
            verification_status:
              verdict.classification === "verified_active" ? "verified" : "needs_review",
          });
          experiencesInserted += 1;
        } catch {
          // e.g. a slug UNIQUE collision from a concurrent insert — treat as skip.
          skipped++;
        }
      }
    } catch (err) {
      // Per-provider isolation: one Brreg/DB failure never aborts the batch.
      console.error(`[opplevelser] bulk-load provider failed: ${name}`, err);
      skipped++;
    }
  }

  res.json({
    dry_run: dryRun,
    providers: counts,
    experiences_inserted: experiencesInserted,
    providers_inserted: providersInserted,
    skipped,
    excluded_inactive: excludedInactive,
    ...(cappedProviders > 0 ? { capped_providers: cappedProviders } : {}),
  });
});

// ─── POST /api/opplevelser/admin/content-refresh (admin) ────────────
//
// orch-experiences-content-refresh (2026-06-17). The experiences twin of the
// rfb `POST /admin/homepage-content-refresh` (orch-pr-24a). The experiences
// vertical has 41 bulk-loaded providers but NO enrichment pipeline — their
// experiences' content isn't sourced from the providers' OWN homepages. This
// endpoint is that writer: for targeted/auto-selected providers WITH a website,
// it fetches the homepage server-side (SSRF-guarded, timeout, + /om-oss /about),
// runs the SHARED PR-22 extractors (extractVisibleText/summarizeAbout) plus the
// experiences-vocab category mapper (mapToExperienceCategories), and writes
// description/category onto that provider's EXPERIENCES through a gate that
// respects owner/curated/verified locks. Dry-run by default; apply=1 writes.
//
// SAFETY: writes ONLY to experiences.db via experience-store. NEVER touches
// contact/orgnr/Brreg-verification fields; never overwrites a verified/manual/
// claim-sourced row; only fills THIN (empty) description/category. Reuses the
// rfb SSRF guard + extractors verbatim. Auth: same X-Admin-Key (requireAdmin).
//
// NB: MUST come before "/:id" so "admin" isn't swallowed as an id param.

const CR_FETCH_TIMEOUT_MS = 10_000;
const CR_UA = "Lokal-Experiences-Scraper/1.0 (+https://opplevagent.no)";
// Same-host sub-pages worth crawling for content (mirrors the rfb writer).
const CR_CONTENT_PATHS: readonly string[] = ["/om-oss", "/about"];
const CR_DEFAULT_LIMIT = 25;
const CR_HARD_CAP = 100;
const CR_CONCURRENCY = 3;

/**
 * Fetch one URL's HTML server-side, classified (dev-request
 * 2026-07-27-fetch-infrastruktur-diagnose, P0-1). Delegates to the shared
 * fetchPage(): same SSRF guard and charset-correct decode as before, plus a
 * named failure reason, a one-shot retry for transient faults, and empty-body
 * detection. This vertical is the one whose `http_unreachable_per_run`
 * guardrail has been in warn-breach (35.3 vs a threshold of 15) for 20+
 * controller cycles with no way to see what the 35 actually were.
 */
async function crFetchPage(url: string): Promise<FetchPageResult> {
  return fetchPage(url, { userAgent: CR_UA, timeoutMs: CR_FETCH_TIMEOUT_MS });
}

async function crFetchHtml(url: string): Promise<string | null> {
  const r = await crFetchPage(url);
  return r.ok ? r.html : null;
}

/**
 * Fetch a provider's homepage + same-host content sub-pages, concatenated. The
 * primary page's HTML is returned first (so summarizeAbout's og/meta lookups hit
 * the homepage), with sub-page HTML appended for the category-token scan. Returns
 * null only if the primary homepage cannot be fetched.
 */
type CrFetchOutcome =
  | { ok: true; primaryHtml: string; combinedHtml: string; fetchUrl: string }
  | { ok: false; reason: string; persistence: string; status: number | null };

async function crFetchHomepageContent(homepageUrl: string): Promise<CrFetchOutcome> {
  const fetchUrl = /^https?:\/\//i.test(homepageUrl) ? homepageUrl : `https://${homepageUrl}`;
  const primary = await crFetchPage(fetchUrl);
  if (!primary.ok) {
    return { ok: false, reason: primary.reason, persistence: primary.persistence, status: primary.status };
  }
  const primaryHtml = primary.html;
  let combinedHtml = primaryHtml;
  // Link-driven sub-page crawl with CR_CONTENT_PATHS as fallback — see
  // buildPageEvidence in services/search-enrich.ts for the measurement.
  //
  // Resolve against the FINAL url, not the requested one. discoverContentLinks
  // keeps same-host links only, and a homepage that redirects across hosts
  // (apex→www, renamed domain) typically emits ABSOLUTE self-links on the new
  // host — stock WordPress does, via home_url(). Judging those against the
  // pre-redirect host would reject every one of them, silently collapsing the
  // discovery back to the fixed-path guessing this replaced, against a host
  // that no longer serves the site.
  try {
    const u = new URL(primary.finalUrl || fetchUrl);
    const base = `${u.protocol}//${u.host}`;
    const discovered = discoverContentLinks(primaryHtml, u.toString(), CR_CONTENT_PATHS.length);
    const targets = discovered.length > 0 ? discovered : CR_CONTENT_PATHS.map((p) => `${base}${p}`);
    for (const target of targets) {
      const sub = await crFetchHtml(target);
      if (sub) combinedHtml += "\n" + sub;
    }
  } catch {
    /* malformed URL — primary homepage content still stands */
  }
  return { ok: true, primaryHtml, combinedHtml, fetchUrl };
}

router.post("/admin/content-refresh", requireAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { providerIds?: unknown; limit?: unknown; apply?: unknown };

  // apply: dry-run by default. apply=1/"1"/true (body) or ?apply=1.
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  // limit: default 25, hard cap 100.
  const limit = Math.min(
    typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : CR_DEFAULT_LIMIT,
    CR_HARD_CAP
  );

  // ── Target selection ──────────────────────────────────────────────
  // stopReason is only meaningful for the auto-select path below (an
  // explicit providerIds request isn't a scan of the candidate window at
  // all) — null there.
  let targets: ContentRefreshTarget[];
  let stopReason: ContentRefreshStopReason | null = null;
  if (Array.isArray(body.providerIds) && body.providerIds.length > 0) {
    const ids = (body.providerIds as unknown[])
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim())
      .slice(0, limit);
    targets = ids
      .map((id) => getProviderContentTarget(id))
      .filter((t): t is ContentRefreshTarget => t !== null);
  } else {
    // selectProvidersForContentRefresh() pages through the SQL candidate
    // window until `limit` enrichable providers are found, the SQL side is
    // genuinely exhausted, or the hard scan cap is hit (2026-08-01
    // selector-window fix) — see that function's doc comment
    // (src/services/experience-store.ts) for the NULL-clump starvation bug
    // this replaced. stopReason distinguishes an honest "nothing left"
    // (real-exhaustion) from "stopped early, there may be more"
    // (scan_cap_reached) so downstream cron reporting no longer conflates
    // the two into a false "real-exhaustion".
    const selection = selectProvidersForContentRefresh(limit);
    targets = selection.targets;
    stopReason = selection.stopReason;
  }

  let scanned = 0;
  const byField: Record<string, number> = {
    description: 0, category: 0, subcategory: 0,
    activity_tags: 0, season: 0, indoor_outdoor: 0,
    duration_min: 0, price_from: 0, booking_url: 0,
  };
  type ProvenanceMap = Record<string, { source_url: string; snippet: string | null }>;
  const changed: Array<{ provider_id: string; fields: string[]; provenance: ProvenanceMap }> = [];
  const skippedLocked: Array<{ provider_id: string; experience_ids: string[] }> = [];
  const errors: Array<{ provider_id: string; error: string }> = [];
  // Providers that crossed the 3-failure parking threshold THIS run
  // (enrichment-metode slice 1; mirrors provenance-batch's parked_now).
  const parkedNow: string[] = [];
  // dev-request 2026-08-02-opplevagent-hjemmesideverifisering-og-enrichment-
  // gate, Steg 3: providers excluded because their hjemmeside is not stamped
  // verified=true by the website-verification sweep (isHjemmesideVerified()
  // above — mirrors PR #453's gate on the gårdssalg content-refresh route).
  // Own named bucket (never lumped into errors/skipped_locked) so a run's
  // report always makes visible how many rows were skipped for this reason,
  // instead of it silently inflating the generic `errors`/
  // http_unreachable_per_run metric the way ordinary fetch failures do.
  const excludedUnverifiedWebsite: Array<{ provider_id: string; reason: string }> = [];

  async function processOne(t: ContentRefreshTarget): Promise<void> {
    const providerId = t.id;

    // Stamp the attempt UNCONDITIONALLY (apply mode only — dry-run stays
    // read-only) before doing any fetch/extraction work, so a provider whose
    // homepage is permanently unreachable still advances to the back of
    // selectProvidersForContentRefresh()'s queue on its next call, instead of
    // sorting first forever (see markProviderContentAttempted's doc comment).
    if (apply) {
      try { markProviderContentAttempted(providerId); } catch { /* best-effort */ }
    }

    // Website-verification gate — before any fetch, fail-closed: a
    // hjemmeside the website-verification sweep has not stamped
    // verified=true (missing, malformed, or classification other than
    // "verified") must never be trusted as an enrichment source for this
    // producer. See isHjemmesideVerified()'s doc comment above. This also
    // gates the COALESCE-fallback case (t.hjemmeside sourced from an
    // experience's evidence_url because the provider's own hjemmeside column
    // is blank — see selectProvidersForContentRefresh's SQL): the
    // verification sweep only ever classifies the provider's OWN hjemmeside
    // column, so a fallback-sourced target's field_provenance reads
    // "missing_source" (verified=false) here and is skipped too, by design
    // (the fallback URL was never itself ownership-verified).
    if (!isHjemmesideVerified(t.field_provenance)) {
      excludedUnverifiedWebsite.push({ provider_id: providerId, reason: "unverified_website" });
      return;
    }

    // Fetch homepage content server-side (SSRF-guarded).
    let fetched: CrFetchOutcome;
    try {
      fetched = await crFetchHomepageContent(t.hjemmeside);
    } catch (e: any) {
      errors.push({ provider_id: providerId, error: e?.message ?? String(e) });
      // NO parking strike here. fetchPage() never throws — it returns a
      // classified failure — so reaching this catch means an INTERNAL fault on
      // our side (a malformed stored URL, a bug), which is no evidence at all
      // that the producer's site is dead. Striking on it would park a provider
      // for 30 days for our own error.
      return;
    }
    if (!fetched.ok) {
      // Classified reason instead of a bare "fetch_failed" (dev-request
      // 2026-07-27-fetch-infrastruktur-diagnose, P0-1).
      errors.push({
        provider_id: providerId,
        error: `fetch_failed:${fetched.reason} (${fetched.persistence}) for ${t.hjemmeside}`,
      });
      // PARKING NOW DEPENDS ON PERSISTENCE. A `transient` failure (timeout,
      // 5xx, 429, connection reset) must NOT count a strike: the 2026-07-26
      // probe found two of fourteen "dead" producer domains answering HTTP 200
      // on re-probe the day after they were reported as hard 503s, so counting
      // those blips was parking live producers for 30 days and then reporting
      // the resulting empty candidate pool as "exhaustion". Genuinely dead
      // (`permanent`) and deliberately-refusing (`blocked`) URLs still strike.
      if (apply && fetched.persistence !== "transient") {
        try {
          const p = recordProviderHomepageFetchResult(providerId, false);
          if (p.parked_now) parkedNow.push(providerId);
        } catch { /* best-effort */ }
      }
      return;
    }
    if (apply) {
      try { recordProviderHomepageFetchResult(providerId, true); } catch { /* best-effort */ }
    }
    const { primaryHtml, combinedHtml } = fetched;

    // ── Extract content + structured attributes from the fetched homepage ──────
    const contentText = extractVisibleText(combinedHtml);
    const aboutSummary = summarizeAbout(primaryHtml);
    const expCategories = mapToExperienceCategories(contentText);

    // Structured-attribute extraction (richer profiles, 2026-06-25).
    const priceResult   = extractPriceFrom(contentText);
    const durationResult = extractDurationMin(contentText);
    const seasonResult  = extractSeasons(contentText);
    const ioResult      = extractIndoorOutdoor(contentText);
    const tagsResult    = extractActivityTags(contentText);
    const bookingResult = extractBookingUrl(primaryHtml, fetched.fetchUrl);

    const candidateDescription = meetsAboutQualityBar(aboutSummary) ? aboutSummary : null;
    const candidateCategory = expCategories.length > 0 ? expCategories[0] : null;
    const candidateActivityTags = tagsResult.values.length > 0 ? tagsResult.values : null;
    const candidateSeason = seasonResult.values.length > 0 ? seasonResult.values : null;

    // Provenance map — keyed by field name, value is { source_url, snippet }.
    // Stored in the response only (not in DB). Faithfulness evidence for Daniel.
    const provenance: ProvenanceMap = {};
    if (candidateDescription)   provenance.description   = { source_url: fetched.fetchUrl, snippet: aboutSummary.slice(0, 120) };
    if (candidateCategory)      provenance.category      = { source_url: fetched.fetchUrl, snippet: candidateCategory };
    if (priceResult.value !== null)   provenance.price_from    = { source_url: fetched.fetchUrl, snippet: priceResult.snippet };
    if (durationResult.value !== null) provenance.duration_min = { source_url: fetched.fetchUrl, snippet: durationResult.snippet };
    if (candidateSeason)        provenance.season        = { source_url: fetched.fetchUrl, snippet: seasonResult.snippets.join(", ") };
    if (ioResult.value)         provenance.indoor_outdoor = { source_url: fetched.fetchUrl, snippet: ioResult.snippet };
    if (candidateActivityTags)  provenance.activity_tags = { source_url: fetched.fetchUrl, snippet: tagsResult.snippets.join(", ") };
    if (bookingResult.value)    provenance.booking_url   = { source_url: fetched.fetchUrl, snippet: bookingResult.snippet };

    // Check if anything extractable at all (avoids wasted processing).
    const hasAnyCandidate = candidateDescription || candidateCategory || priceResult.value !== null
      || durationResult.value !== null || candidateSeason || ioResult.value || candidateActivityTags
      || bookingResult.value;
    scanned++;
    if (!hasAnyCandidate) {
      // dev-request 2026-07-20-experiences-no-yield-backoff: homepage fetched
      // fine but nothing extractable — bump content_no_yield_streak so 3
      // consecutive no-yield outcomes trigger the NO_YIELD_BACKOFF_DAYS rest
      // period (selectProvidersForContentRefresh's WHERE clause). Apply mode
      // only — dry-run stays fully read-only.
      if (apply) {
        try { recordProviderContentYield(providerId, false); } catch { /* best-effort */ }
      }
      return;
    }

    const expRows = getExperiencesForProvider(providerId);
    const writtenFields = new Set<string>();
    const lockedExpIds: string[] = [];
    const toApply: Array<{ id: string }> = [];

    const candidateObj = {
      description:    candidateDescription,
      category:       candidateCategory,
      activity_tags:  candidateActivityTags,
      season:         candidateSeason,
      indoor_outdoor: ioResult.value,
      duration_min:   durationResult.value,
      price_from:     priceResult.value,
      booking_url:    bookingResult.value,
    };

    for (const e of expRows) {
      if (e.verification_status === "verified" || e.content_source === "manual" || e.content_source === "claim") {
        // Count as skipped_locked only if at least one thin field would have been filled.
        const anyThin = (candidateDescription && !e.description) || (candidateCategory && !e.category)
          || (candidateObj.price_from !== null && !e.price_from)
          || (candidateObj.duration_min !== null && !e.duration_min)
          || (candidateObj.season && !e.season)
          || (candidateObj.indoor_outdoor && !e.indoor_outdoor)
          || (candidateObj.activity_tags && !e.activity_tags)
          || (candidateObj.booking_url && !e.booking_url);
        if (anyThin) lockedExpIds.push(e.id);
        continue;
      }
      toApply.push({ id: e.id });
    }

    if (lockedExpIds.length > 0) {
      skippedLocked.push({ provider_id: providerId, experience_ids: lockedExpIds });
    }

    if (dryRun) {
      for (const e of expRows) {
        if (e.verification_status === "verified" || e.content_source === "manual" || e.content_source === "claim") continue;
        if (candidateDescription && (!e.description || !String(e.description).trim())) writtenFields.add("description");
        if (candidateCategory && (!e.category || !String(e.category).trim())) writtenFields.add("category");
        if (candidateObj.price_from !== null && !e.price_from) writtenFields.add("price_from");
        if (candidateObj.duration_min !== null && !e.duration_min) writtenFields.add("duration_min");
        if (candidateObj.season && (!e.season || e.season === "[]")) writtenFields.add("season");
        if (candidateObj.indoor_outdoor && !e.indoor_outdoor) writtenFields.add("indoor_outdoor");
        if (candidateObj.activity_tags && (!e.activity_tags || e.activity_tags === "[]")) writtenFields.add("activity_tags");
        if (candidateObj.booking_url && !e.booking_url) writtenFields.add("booking_url");
      }
    } else {
      for (const a of toApply) {
        try {
          // fetched.fetchUrl is the page this content was extracted from — the
          // same URL the per-field provenance above records as source_url.
          const fields = applyExperienceContent(a.id, candidateObj, fetched.fetchUrl);
          for (const f of fields) writtenFields.add(f);
        } catch (e: any) {
          errors.push({ provider_id: providerId, error: `write_failed ${a.id}: ${e?.message ?? String(e)}` });
        }
      }
      if (writtenFields.size > 0) {
        try { markProviderEnriched(providerId); } catch { /* best-effort */ }
        // dev-request 2026-07-20-experiences-no-yield-backoff: a real field
        // write resets content_no_yield_streak to 0, clearing any backoff.
        try { recordProviderContentYield(providerId, true); } catch { /* best-effort */ }
      }
    }

    if (writtenFields.size > 0) {
      const fieldList = Array.from(writtenFields);
      for (const f of fieldList) if (f in byField) byField[f] += 1;
      changed.push({ provider_id: providerId, fields: fieldList, provenance });
    }
  }

  // Bounded concurrency for the network fetches.
  for (let i = 0; i < targets.length; i += CR_CONCURRENCY) {
    const slice = targets.slice(i, i + CR_CONCURRENCY);
    await Promise.all(slice.map((t) => processOne(t)));
  }

  res.json({
    dry_run: dryRun,
    scanned,
    // agents_enriched: the method's PRIMARY success metric (enrichment-metode
    // slice 1) — providers that actually had >=1 field improved this run.
    agents_enriched: changed.length,
    by_field: byField,
    changed,
    skipped_locked: skippedLocked,
    errors,
    // Providers parked (3 consecutive fetch failures) during THIS run.
    parked_now: parkedNow,
    // Steg 3 — providers excluded because their hjemmeside is not stamped
    // verified=true by the website-verification sweep; additive bucket,
    // every excluded provider is visible, never dropped or lumped into
    // `errors` (which otherwise becomes the http_unreachable_per_run
    // guardrail metric and would misread aggregator-URL rot as real
    // unreachability).
    excluded_unverified_website: excludedUnverifiedWebsite,
    // Why selection stopped this call: "real-exhaustion" only when the SQL
    // candidate window is genuinely tapped out; "scan_cap_reached" when the
    // hard CONTENT_REFRESH_HARD_SCAN_CAP scan budget stopped the search
    // first (more candidates may exist further down the queue);
    // "cap_reached" is the normal case (found `limit` enrichable providers);
    // null for an explicit providerIds request (no candidate scan ran).
    stop_reason: stopReason,
  });
});

// ─── POST /api/opplevelser/admin/gardssalg-content-refresh (admin) ──────────
//
// dev-request 2026-07-03-gardssalg-rike-profiler-bilder-agentbooking, Fase 1
// item 3 (2026-07-10). The multi-page-crawl enrichment slice referenced by the
// comment above GET /kategori/gardssalg/produsent/:providerSlug (PR #135):
// that route's "Om produsenten"/"Besøket" sections render generic,
// type-general placeholder copy "until the separate multi-page-crawl
// enrichment slice fills real per-producer copy" — this is that slice.
//
// For targeted/auto-selected gårdssalg providers WITH a website, this fetches
// the homepage + up to 4 gårdssalg-specific sub-pages (om-oss/besøk/smaking/
// kontakt/åpningstider — capped at 5 total page-fetches per producer, the
// "~5 sider" cap from the dev-request), runs summarizeAbout (reused from the
// existing content-refresh route) + the new summarizeVisit/extractOpeningHours
// extractors, and writes about_text/visit_text/opening_hours_text onto
// experience_providers through the SAME thin-field + lock discipline as every
// other content writer in this file (see applyExperienceContent's doc
// comment). Dry-run by default; apply=1 writes.
//
// SAFETY: writes ONLY about_text/visit_text/opening_hours_text +
// content_source/content_evidence_url/content_updated_at on
// experience_providers. NEVER touches contact/orgnr/Brreg-verification
// fields; never overwrites a manual/claim-locked provider; only fills THIN
// (empty) fields. Reuses the same SSRF guard + extractors as
// /admin/content-refresh. Auth: same X-Admin-Key (requireAdmin).
//
// The lock check (content_source manual/claim) is deliberately done from the
// TARGET row's own snapshot — BEFORE any fetch is attempted — rather than
// after (unlike the experiences-table route above, which can only know a
// sub-row is locked after loading its experiences). This lets a locked
// gårdssalg provider short-circuit to skipped_locked without ever touching
// the network, which is also what makes the lock-check path deterministically
// testable without live network access.
//
// NB: MUST come before "/:id" so "admin" isn't swallowed as an id param.

// Gårdssalg-specific candidate sub-pages — a bigger list than CR_CONTENT_PATHS
// because these producers' useful content (visit/tasting/hours) tends to live
// on dedicated sub-pages rather than the homepage itself. crFetchGardssalgContent
// stops once it has fetched 5 pages total (homepage + up to 4 of these), not
// all 10 — bounding requests per producer to the dev-request's "~5 sider" cap.
const GARDSSALG_CONTENT_PATHS: readonly string[] = [
  "/om-oss", "/om", "/besok", "/besøk", "/smaking",
  "/smaksprover", "/smaksprøver", "/kontakt", "/apningstider", "/åpningstider",
];
const GARDSSALG_MAX_PAGES = 5; // homepage + up to 4 sub-pages

/**
 * Fetch a gårdssalg provider's homepage + up to 4 of its content sub-pages
 * (GARDSSALG_CONTENT_PATHS), concatenated, stopping once 5 pages total have
 * been successfully fetched. Same shape/contract as crFetchHomepageContent:
 * the primary page's HTML is returned first (so summarizeAbout's og/meta
 * lookups hit the homepage), with sub-page HTML appended for the
 * visit/opening-hours scans. Returns null only if the primary homepage cannot
 * be fetched. A 404/failure on any candidate sub-page costs nothing extra —
 * crFetchHtml already returns null on any failure, so it's just skipped.
 */
async function crFetchGardssalgContent(homepageUrl: string): Promise<CrFetchOutcome> {
  const fetchUrl = /^https?:\/\//i.test(homepageUrl) ? homepageUrl : `https://${homepageUrl}`;
  const primary = await crFetchPage(fetchUrl);
  if (!primary.ok) {
    return { ok: false, reason: primary.reason, persistence: primary.persistence, status: primary.status };
  }
  const primaryHtml = primary.html;
  let combinedHtml = primaryHtml;
  let pagesFetched = 1;
  try {
    // Final url, not the requested one — a cross-host redirect otherwise leaves
    // the whole sub-page crawl pointed at a host that no longer serves the site.
    const u = new URL(primary.finalUrl || fetchUrl);
    // Slice 5d: sub-page candidates resolve relative to the STORED URL's
    // section, not the host root. For the normal case (hjemmeside is the
    // site root) this is identical to the old `${protocol}//${host}` base;
    // for a deep-path hjemmeside it keeps the crawl inside that page's own
    // section instead of walking onto whatever else the host serves — the
    // exact mechanism behind the 2026-07-19 hanen.no cross-contamination
    // (directory root's /om-oss described the directory org, not the farm).
    // An extensionless last segment ("/medlem/gard-x") is treated as a
    // section of its own (integration review M1) — only an explicit file
    // ("/index.html") falls back to its parent directory.
    let dir = u.pathname;
    if (!dir.endsWith("/")) {
      const lastSeg = dir.slice(dir.lastIndexOf("/") + 1);
      dir = lastSeg.includes(".") ? dir.replace(/[^/]*$/, "") : `${dir}/`;
    }
    const base = `${u.protocol}//${u.host}${dir === "/" ? "" : dir.replace(/\/$/, "")}`;
    for (const path of GARDSSALG_CONTENT_PATHS) {
      if (pagesFetched >= GARDSSALG_MAX_PAGES) break;
      const sub = await crFetchHtml(`${base}${path}`);
      if (sub) {
        combinedHtml += "\n" + sub;
        pagesFetched++;
      }
    }
  } catch {
    /* malformed URL — primary homepage content still stands */
  }
  return { ok: true, primaryHtml, combinedHtml, fetchUrl };
}

const GS_CR_DEFAULT_LIMIT = 25;
const GS_CR_HARD_CAP = 48; // there are only 48 gårdssalg providers total

// dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach,
// Steg 3 follow-up (Funn 4): the content-refresh route below fetches a
// producer's hjemmeside and trusts it as a content-enrichment SOURCE. That
// is only safe once PR #448's website-verification sweep
// (gardssalg-website-verification.ts's applyGardssalgWebsiteVerification)
// has actually confirmed the hjemmeside belongs to THIS producer — an
// unrelated business with a similar name, or an aggregator link, must never
// silently become an "enrichment source". No shared typed FieldProvenance
// interface exists anywhere in this codebase yet (every other
// field_provenance read/write inlines its own defensive JSON.parse — see
// applyGardssalgWebsiteVerification and the field_provenance merge blocks in
// experience-store.ts), so this is a local, minimal shape scoped to just
// this one check rather than a new shared abstraction.
interface HjemmesideVerificationEntry {
  verified?: unknown;
  classification?: unknown;
}

/**
 * Fail-closed gate: true only when field_provenance.hjemmeside_verification
 * exists and verified === true. Missing field_provenance, missing/malformed
 * hjemmeside_verification, malformed JSON, or verified !== true (this
 * includes classifications "unverified"/"aggregator"/"missing_source", and
 * rows the verification sweep never scanned at all) -> false. Any ambiguity
 * resolves to "not verified" — never to "assume verified".
 */
export function isHjemmesideVerified(fieldProvenanceRaw: string | null): boolean {
  if (!fieldProvenanceRaw) return false;
  try {
    const parsed = JSON.parse(fieldProvenanceRaw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const entry = (parsed as Record<string, unknown>).hjemmeside_verification as
      | HjemmesideVerificationEntry
      | undefined;
    if (!entry || typeof entry !== "object") return false;
    return entry.verified === true;
  } catch {
    return false; // malformed existing JSON -> fail closed, never treat as verified
  }
}

router.post("/admin/gardssalg-content-refresh", requireAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { providerIds?: unknown; limit?: unknown; apply?: unknown };

  // apply: dry-run by default. apply=1/"1"/true (body) or ?apply=1.
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  // limit: default 25, hard cap 48 (Math.min mirrors CR_HARD_CAP's role, but
  // scoped to this vertical's real ceiling).
  const limit = Math.min(
    typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : GS_CR_DEFAULT_LIMIT,
    GS_CR_HARD_CAP
  );

  // ── Target selection ──────────────────────────────────────────────
  let targets: GardssalgContentRefreshTarget[];
  if (Array.isArray(body.providerIds) && body.providerIds.length > 0) {
    const ids = (body.providerIds as unknown[])
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim())
      .slice(0, limit);
    targets = ids
      .map((id) => getGardssalgProviderContentTarget(id))
      .filter((t): t is GardssalgContentRefreshTarget => t !== null);
  } else {
    targets = selectGardssalgProvidersForContentRefresh(limit);
  }

  let scanned = 0;
  const byField: Record<string, number> = { about_text: 0, visit_text: 0, opening_hours_text: 0, products: 0 };
  type GsProvenanceMap = Record<string, { source_url: string; snippet: string | null }>;
  // dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach, slice 2 —
  // `actions` is ADDITIVE alongside the existing `fields: string[]` (kept
  // as-is for backward compatibility with existing callers/tests): a
  // field-keyed map of "filled" (was blank) vs "replaced" (was thin,
  // non-blank) so a future batch report can tell the two apart per field.
  // "rewritten" (slice 5a) is a THIRD, additive value: current value was
  // already non-blank AND already passing the quality bar (so neither
  // "filled" nor "replaced" would ever apply) but still <200 chars — a
  // source-grounded LLM expansion, not an extractive fill/replace.
  type GsFieldAction = "filled" | "replaced" | "rewritten";
  const changed: Array<{
    provider_id: string;
    fields: string[];
    actions: Record<string, GsFieldAction>;
    provenance: GsProvenanceMap;
  }> = [];
  const skippedLocked: string[] = [];
  const errors: Array<{ provider_id: string; error: string }> = [];
  // Providers that crossed the 3-failure parking threshold THIS run
  // (enrichment-metode slice 1; mirrors provenance-batch's parked_now).
  const parkedNow: string[] = [];
  // Slice 5d — shared-/directory-domain guard (the 2026-07-19 hanen.no
  // cross-contamination incident, caught live by the slice-4b identity
  // audit): a provider whose hjemmeside lives on a directory/DMO domain, or
  // on a host shared by 2+ providers in this catalog, is EXCLUDED from all
  // content fetching/writing and reported here — never silently dropped.
  // Host counts are computed once per request (cheap, two-digit catalog).
  const excludedSharedDomain: Array<{ provider_id: string; reason: string }> = [];
  const sharedHostCounts = gardssalgSharedHostCounts();
  // Steg 3 follow-up (Funn 4) — providers whose hjemmeside is not stamped
  // verified=true by the website-verification sweep. Own named bucket
  // (never lumped into skipped_locked/excluded_shared_domain) so a run's
  // report always makes visible how many rows were skipped for this reason.
  const excludedUnverifiedWebsite: Array<{ provider_id: string; reason: string }> = [];

  async function processOne(t: GardssalgContentRefreshTarget): Promise<void> {
    const providerId = t.id;

    // Stamp the attempt UNCONDITIONALLY (apply mode only) before doing any
    // fetch/extraction work — same "cycle to the back of the queue on any
    // outcome" reasoning as the experiences-table route above (see
    // markProviderContentAttempted's doc comment). This INCLUDES providers
    // the shared-domain guard below excludes (integration review B2): an
    // unstamped excluded provider would stay permanently first in the
    // last_content_attempt_at-ordered auto-select and starve the queue's
    // limit slots forever — stamping cycles it to the back like every other
    // no-progress outcome.
    if (apply) {
      try { markProviderContentAttempted(providerId); } catch { /* best-effort */ }
    }

    // Shared-domain guard — before lock/fetch: an excluded provider must
    // never touch the network or receive content writes.
    const exclusionReason = gardssalgContentExclusionReason(t.hjemmeside, sharedHostCounts);
    if (exclusionReason) {
      excludedSharedDomain.push({ provider_id: providerId, reason: exclusionReason });
      return;
    }

    // LOCK check — from the target's own row snapshot, BEFORE any fetch, so a
    // locked provider never touches the network at all.
    if (t.content_source === "manual" || t.content_source === "claim") {
      skippedLocked.push(providerId);
      return;
    }

    // Website-verification gate — before any fetch, fail-closed: a
    // hjemmeside the website-verification sweep has not stamped
    // verified=true (missing, malformed, or classification other than
    // "verified") must never be trusted as an enrichment source for this
    // producer. See isHjemmesideVerified()'s doc comment above.
    if (!isHjemmesideVerified(t.field_provenance)) {
      excludedUnverifiedWebsite.push({ provider_id: providerId, reason: "unverified_website" });
      return;
    }

    // Fetch homepage + gårdssalg sub-pages server-side (SSRF-guarded).
    let fetched: CrFetchOutcome;
    try {
      fetched = await crFetchGardssalgContent(t.hjemmeside);
    } catch (e: any) {
      errors.push({ provider_id: providerId, error: e?.message ?? String(e) });
      // NO parking strike here. fetchPage() never throws — it returns a
      // classified failure — so reaching this catch means an INTERNAL fault on
      // our side (a malformed stored URL, a bug), which is no evidence at all
      // that the producer's site is dead. Striking on it would park a provider
      // for 30 days for our own error.
      return;
    }
    if (!fetched.ok) {
      errors.push({
        provider_id: providerId,
        error: `fetch_failed:${fetched.reason} (${fetched.persistence}) for ${t.hjemmeside}`,
      });
      // Persistence-gated parking — SAME rule as /admin/content-refresh above.
      // These gårdssalg routes write the very same counter
      // (experience_providers.homepage_fetch_attempts) and are excluded by the
      // very same providerParkingExclusionSql(), so leaving them striking on a
      // transient 503 would have re-created the mis-parking this whole change
      // exists to eliminate — on the same rows, just via a different route.
      if (apply && fetched.persistence !== "transient") {
        try {
          const p = recordProviderHomepageFetchResult(providerId, false);
          if (p.parked_now) parkedNow.push(providerId);
        } catch { /* best-effort */ }
      }
      return;
    }
    if (apply) {
      try { recordProviderHomepageFetchResult(providerId, true); } catch { /* best-effort */ }
    }
    scanned++;
    const { primaryHtml, combinedHtml } = fetched;

    // ── Extract content ─────────────────────────────────────────────
    const contentText = extractVisibleText(combinedHtml);
    const aboutSummary = summarizeAbout(primaryHtml);
    const visitSummary = summarizeVisit(combinedHtml);
    const hoursSnippet = extractOpeningHours(contentText);

    // Kvalitetsgate-redesign (dev-request 2026-07-20-gardssalg-kvalitetsgate-
    // redesign, slice 2/3/4): about_text/visit_text candidates are judged by
    // meetsGardssalgAboutQualityBar()'s cascade (cheap prefilter, THEN an LLM
    // judge in place of the old regex nav-menu-leakage heuristic layer — see
    // that function's doc comment above generateGardssalgAboutRewrite for
    // the full contract and the reasoning for NOT touching the shared
    // meetsAboutQualityBar/admin-knowledge.ts's use of it).
    //
    // Fix-up round (independent review, blocking finding): the original cost
    // control here ("only judge the candidate when the current value has a
    // classic write opportunity — blank or cheap-bar-failing") silently made
    // ALREADY-contaminated existing content permanently unfixable through
    // this endpoint: nav-menu chrome glued to one real sentence (the
    // Draopar incident shape) is long enough and real-Norwegian-enough to
    // clear meetsAboutCheapBar every time, so a row that already had that
    // exact contamination in the DB would never even get a fresh candidate
    // computed for it, let alone replaced — precisely the incident class
    // this whole redesign exists to close. Fix: the candidate is now ALWAYS
    // computed/judged, regardless of the current value's write-opportunity
    // status; cost stays bounded because meetsGardssalgAboutQualityBar's own
    // cheap-bar prefilter means a candidate that couldn't possibly qualify
    // never reaches the LLM (unchanged from before).
    const candidateAbout = (await meetsGardssalgAboutQualityBar(aboutSummary, t.navn, "about"))
      ? aboutSummary
      : null;
    const candidateVisitRaw = (await meetsGardssalgAboutQualityBar(visitSummary, t.navn, "visit"))
      ? visitSummary
      : null;
    // Duplicate-field guard (dev-request 2026-07-20-kvalitetsgate slice 1 —
    // the Draopar incident): summarizeAbout() and summarizeVisit() extract
    // independently from primaryHtml/combinedHtml, but when a source page
    // has no distinct "visit us" section they can both land on the exact
    // same block — e.g. summarizeVisit's own keyword scan is a plain
    // substring match (VISIT_KEYWORDS.some(kw => lower.includes(kw))) with
    // no word boundary, so "smaking" inside nav copy like "Salg og
    // sidersmaking" false-matches and picks the same leading blob
    // summarizeAbout()'s fallback already picked. Rather than chase every
    // way the two extractors could coincide, guard the assignment itself:
    // if they produced byte-identical text, only about_text gets it —
    // visit_text stays null (blank/unset) rather than mirroring about_text.
    // Do NOT fabricate a distinct visit_text from nothing.
    const candidateVisit =
      candidateVisitRaw && candidateVisitRaw !== candidateAbout ? candidateVisitRaw : null;
    const candidateHours = hoursSnippet && hoursSnippet.trim() ? hoursSnippet : null;

    function isBlank(v: unknown): boolean {
      return v === null || v === undefined || String(v).trim() === "";
    }

    // Current-value CONTAMINATION check — the actual fix for the blocking
    // finding above. A cheap-bar-passing current value is no longer treated
    // as automatically decent: when there's something to actually gain from
    // checking (current passes the cheap bar AND a fresh, ALREADY
    // judge-approved candidate exists for the same field — candidateAbout/
    // candidateVisit are only non-null once meetsGardssalgAboutQualityBar
    // has approved them above), the SAME LLM judge is run against the
    // CURRENT value too. Judging the candidate first (above) and the
    // current value only afterward, and only conditionally, bounds this to
    // at most one extra LLM call per field per run — and zero extra calls
    // for the overwhelming common case (blank current, or a current/
    // candidate that fails the free, deterministic cheap-bar check). If the
    // current value fails ITS judge call, it's contaminated despite passing
    // the cheap bar, and gardssalgReplaceableFieldAction() below is told so.
    const aboutCurrentCheapBarPass = !isBlank(t.about_text) && meetsAboutCheapBar(t.about_text);
    const aboutCurrentContaminated =
      aboutCurrentCheapBarPass && candidateAbout
        ? !(await meetsGardssalgAboutQualityBar(t.about_text, t.navn, "about"))
        : false;
    const visitCurrentCheapBarPass = !isBlank(t.visit_text) && meetsAboutCheapBar(t.visit_text);
    const visitCurrentContaminated =
      visitCurrentCheapBarPass && candidateVisit
        ? !(await meetsGardssalgAboutQualityBar(t.visit_text, t.navn, "visit"))
        : false;

    const provenance: GsProvenanceMap = {};
    if (candidateAbout) provenance.about_text = { source_url: fetched.fetchUrl, snippet: candidateAbout.slice(0, 120) };
    if (candidateVisit) provenance.visit_text = { source_url: fetched.fetchUrl, snippet: candidateVisit.slice(0, 120) };
    if (candidateHours) provenance.opening_hours_text = { source_url: fetched.fetchUrl, snippet: candidateHours };

    // THIN/BLANK-FIELD check against the target's own snapshot (taken at
    // selection time, before any write in this run) — used both to gate
    // whether there's anything to do at all AND for the dry-run projection.
    // about_text/visit_text go through gardssalgReplaceableFieldAction (the
    // SAME fill-blank-OR-replace-thin-OR-replace-contaminated decision
    // applyGardssalgProviderContent makes) so the preview can never drift
    // from the real write path. opening_hours_text stays on the old
    // fill-only-blank check (unchanged).
    const wouldWriteActions: Record<string, GsFieldAction> = {};
    const aboutAction = gardssalgReplaceableFieldAction(t.about_text, candidateAbout, aboutCurrentContaminated);
    if (aboutAction) wouldWriteActions.about_text = aboutAction;
    const visitAction = gardssalgReplaceableFieldAction(t.visit_text, candidateVisit, visitCurrentContaminated);
    if (visitAction) wouldWriteActions.visit_text = visitAction;
    if (candidateHours && isBlank(t.opening_hours_text)) wouldWriteActions.opening_hours_text = "filled";

    // ── Slice 5a: source-grounded REWRITE for the "passing-bar-but-short"
    // cohort (dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach).
    // Only for about_text/visit_text fields that did NOT already get a
    // wouldWriteActions entry above AND whose CURRENT value (the target's own
    // pre-write snapshot, same as every other check above) is
    // gardssalgRewriteEligible — non-blank, already passing the quality bar
    // (so gardssalgReplaceableFieldAction would never touch it), but still
    // <200 chars. Reuses the ALREADY-fetched/extracted contentText — no new
    // fetch. Runs in BOTH dry-run and apply mode (dry-run still calls the LLM
    // so the preview is real, same convention as the extractive path above);
    // dry-run still writes nothing regardless of the LLM's answer.
    //
    // Fix-up round 2 (independent review's new blocking finding): the
    // structural gardssalgRewriteEligible check ("passes the cheap bar AND
    // <200 chars") is exactly as foolable as gardssalgReplaceableFieldAction's
    // pre-fix-up-round-1 cheap-bar-only check was — nav-menu chrome glued to
    // one real sentence (the Draopar shape) is long+Norwegian-looking enough
    // to pass the cheap bar and still land under 200 chars, so it "looks"
    // like genuine thin content worth expanding. Unlike the replace path,
    // this rewrite path had NO compensating judge check at all: the
    // contaminated current value was trusted as grounding text handed
    // straight to generateGardssalgAboutRewrite, and that helper's OUTPUT
    // then went straight to the DB with zero semantic check. Two
    // independent, cost-bounded gates close this (mirrors this file's
    // existing cascade discipline — the LLM is never called for a field
    // that couldn't possibly qualify):
    //   (b) BEFORE generating: once the cheap structural rule says "maybe",
    //       judge the CURRENT value with the SAME gårdssalg LLM judge used
    //       everywhere else in this redesign (meetsGardssalgAboutQualityBar)
    //       and feed the negated verdict into gardssalgRewriteEligible's
    //       currentValueJudgedContaminated param — a contaminated current
    //       value is never even handed to the rewrite generator as trusted
    //       grounding.
    //   (a) AFTER generating: the rewrite model's own OUTPUT is judged by the
    //       SAME LLM judge before it is allowed into wouldWriteActions/the
    //       write path — protects against the rewrite model itself producing
    //       something bad even from clean grounding, and is the fully
    //       consistent form of this redesign's philosophy ("every candidate
    //       about_text/visit_text write for gårdssalg goes through the judge
    //       cascade before landing").
    // Fail-closed throughout: any judge failure/ambiguity (missing API key,
    // network error, unparseable/ambiguous response) resolves to "not
    // approved" (see judgeGardssalgAboutCandidate's own fail-closed
    // contract), which here means "not eligible" / "candidate rejected" —
    // never written on doubt.
    // Cost dedup: aboutCurrentContaminated/visitCurrentContaminated above are
    // only a REAL (LLM-backed) verdict when they were actually computed —
    // i.e. when the current value passed the cheap bar AND a fresh,
    // judge-approved extractive candidate existed to check it against. In the
    // narrow case where that already happened for this exact current value
    // (t.about_text/t.visit_text — unchanged since) but
    // gardssalgReplaceableFieldAction still declined to act (e.g. the fresh
    // extractive candidate wasn't strictly longer), re-running the SAME judge
    // question against the SAME text here would be a wasted, redundant LLM
    // call — so reuse that verdict instead of asking twice. Only fall back to
    // a fresh judge call when the earlier check never actually ran.
    let rewriteAbout: string | null = null;
    let rewriteVisit: string | null = null;
    if (!wouldWriteActions.about_text && gardssalgRewriteEligible(t.about_text)) {
      const aboutCurrentRewriteContaminated = aboutCurrentCheapBarPass && candidateAbout
        ? aboutCurrentContaminated
        : !(await meetsGardssalgAboutQualityBar(t.about_text, t.navn, "about"));
      if (gardssalgRewriteEligible(t.about_text, aboutCurrentRewriteContaminated)) {
        const aboutRewriteCandidate = await generateGardssalgAboutRewrite(contentText, t.about_text as string, "about");
        if (aboutRewriteCandidate && (await meetsGardssalgAboutQualityBar(aboutRewriteCandidate, t.navn, "about"))) {
          rewriteAbout = aboutRewriteCandidate;
          wouldWriteActions.about_text = "rewritten";
          provenance.about_text = { source_url: fetched.fetchUrl, snippet: rewriteAbout.slice(0, 120) };
        }
      }
    }
    if (!wouldWriteActions.visit_text && gardssalgRewriteEligible(t.visit_text)) {
      const visitCurrentRewriteContaminated = visitCurrentCheapBarPass && candidateVisit
        ? visitCurrentContaminated
        : !(await meetsGardssalgAboutQualityBar(t.visit_text, t.navn, "visit"));
      if (gardssalgRewriteEligible(t.visit_text, visitCurrentRewriteContaminated)) {
        const visitRewriteCandidate = await generateGardssalgAboutRewrite(contentText, t.visit_text as string, "visit");
        if (visitRewriteCandidate && (await meetsGardssalgAboutQualityBar(visitRewriteCandidate, t.navn, "visit"))) {
          rewriteVisit = visitRewriteCandidate;
          wouldWriteActions.visit_text = "rewritten";
          provenance.visit_text = { source_url: fetched.fetchUrl, snippet: rewriteVisit.slice(0, 120) };
        }
      }
    }

    // ── Blank about_text LLM fill (dev-request 2026-07-20-gardssalg-fyll-
    // blank-fra-kildeinnhold): about_text is completely BLANK AND the
    // extractive pass above (candidateAbout, gated by meetsAboutQualityBar)
    // did NOT already produce a wouldWriteActions.about_text entry — i.e.
    // there is a real fetched homepage but neither the extractive summarizer
    // nor (structurally, since it requires a non-blank current value)
    // gardssalgRewriteEligible produced anything. Reuses the ALREADY-
    // fetched/extracted contentText — no new fetch. Runs in BOTH dry-run and
    // apply mode, same convention as the slice 5a/5c LLM paths above
    // (dry-run still calls the LLM so the preview is real; dry-run still
    // writes nothing regardless of the LLM's answer).
    let generatedAbout: string | null = null;
    if (!wouldWriteActions.about_text && isBlank(t.about_text)) {
      generatedAbout = await generateGardssalgAboutFromSource(contentText, t.navn);
      if (generatedAbout) {
        wouldWriteActions.about_text = "filled";
        provenance.about_text = { source_url: fetched.fetchUrl, snippet: generatedAbout.slice(0, 120) };
      }
    }

    // ── Slice 5c: fill-only "products" extraction (dev-request 2026-07-18-
    // gardssalg-profilkvalitet-foer-outreach). Only fires when the column is
    // currently blank/empty (gardssalgProductsEligible) — no replace-thin
    // path, unlike about_text/visit_text. Reuses the ALREADY-fetched/
    // extracted contentText — no new fetch. Runs in BOTH dry-run and apply
    // mode (dry-run still calls the LLM so the preview is real), same
    // convention as the slice 5a rewrite path above.
    let productsCandidate: string[] | null = null;
    if (gardssalgProductsEligible(t.products)) {
      productsCandidate = await generateGardssalgProductList(contentText);
      if (productsCandidate && productsCandidate.length > 0) {
        wouldWriteActions.products = "filled";
        provenance.products = {
          source_url: fetched.fetchUrl,
          snippet: productsCandidate.slice(0, 5).join(", ").slice(0, 120),
        };
      }
    }

    const wouldWrite = Object.keys(wouldWriteActions);
    if (wouldWrite.length === 0) return;

    if (dryRun) {
      for (const f of wouldWrite) if (f in byField) byField[f] += 1;
      changed.push({ provider_id: providerId, fields: wouldWrite, actions: wouldWriteActions, provenance });
    } else {
      try {
        const rewriteFields: Array<"about_text" | "visit_text"> = [];
        if (rewriteAbout) rewriteFields.push("about_text");
        if (rewriteVisit) rewriteFields.push("visit_text");
        // Fix-up round: tell the writer which fields' CURRENT value was
        // already judged contaminated above, so gardssalgReplaceableFieldAction
        // (called again inside applyGardssalgProviderContent against the
        // FRESH row) can replace a cheap-bar-passing-but-contaminated current
        // value instead of refusing to ever touch it.
        const contaminatedFields: Array<"about_text" | "visit_text"> = [];
        if (aboutCurrentContaminated) contaminatedFields.push("about_text");
        if (visitCurrentContaminated) contaminatedFields.push("visit_text");
        const written = applyGardssalgProviderContent(
          providerId,
          {
            about_text: rewriteAbout ?? candidateAbout ?? generatedAbout ?? undefined,
            visit_text: rewriteVisit ?? candidateVisit ?? undefined,
            opening_hours_text: candidateHours ?? undefined,
            products: productsCandidate ?? undefined,
          },
          fetched.fetchUrl,
          undefined,
          rewriteFields.length > 0 ? rewriteFields : undefined,
          contaminatedFields.length > 0 ? contaminatedFields : undefined
        );
        if (written.length > 0) {
          const actions: Record<string, GsFieldAction> = {};
          for (const f of written) {
            if (f in byField) byField[f] += 1;
            actions[f] = wouldWriteActions[f] ?? "filled";
          }
          changed.push({ provider_id: providerId, fields: written, actions, provenance });
        }
      } catch (e: any) {
        errors.push({ provider_id: providerId, error: `write_failed: ${e?.message ?? String(e)}` });
      }
    }
  }

  // Bounded concurrency for the network fetches (reuses CR_CONCURRENCY).
  for (let i = 0; i < targets.length; i += CR_CONCURRENCY) {
    const slice = targets.slice(i, i + CR_CONCURRENCY);
    await Promise.all(slice.map((t) => processOne(t)));
  }

  res.json({
    dry_run: dryRun,
    scanned,
    // agents_enriched: the method's PRIMARY success metric (enrichment-metode
    // slice 1) — providers that actually had >=1 field improved this run.
    agents_enriched: changed.length,
    by_field: byField,
    changed,
    skipped_locked: skippedLocked,
    errors,
    // Providers parked (3 consecutive fetch failures) during THIS run.
    parked_now: parkedNow,
    // Slice 5d: providers excluded by the shared-/directory-domain guard —
    // additive bucket; every excluded provider is visible, never dropped.
    excluded_shared_domain: excludedSharedDomain,
    // Steg 3 follow-up (Funn 4): providers excluded because their hjemmeside
    // is not stamped verified=true by the website-verification sweep —
    // additive bucket; every excluded provider is visible, never dropped.
    excluded_unverified_website: excludedUnverifiedWebsite,
  });
});

// ─── POST /api/opplevelser/admin/gardssalg-retro-scan (admin) ───────────────
//
// dev-request 2026-07-20-gardssalg-kvalitetsgate-redesign, criterion 6. The
// content-refresh route above only applies the new extraction+judge gate
// (extractProseText's structure-aware extraction, criterion 1; meetsGardssalg
// AboutQualityBar's cheap-bar+LLM-judge cascade, criteria 2-4) going FORWARD,
// to fresh candidates, and only judges a row's CURRENT about_text/visit_text
// when a fresh judge-approved candidate ALSO exists (cost-bounded — see
// applyGardssalgProviderContent's currentValueContaminated doc comment
// above). Content written before the gate existed, or by a run where no
// fresh candidate happened to qualify, is never revisited. This endpoint is
// the retroactive sweep: for every non-locked gårdssalg row (visible AND
// hidden — "excluding only content_source IN ('manual','claim')", the
// dev-request's own words), it re-fetches the stored hjemmeside (reusing
// crFetchGardssalgContent, same SSRF-guarded pipeline as content-refresh, so
// content_evidence_url is a real, freshly-verified URL) and judges the
// row's CURRENTLY STORED about_text/visit_text — not a freshly generated
// candidate — against the SAME gate. A field that no longer clears it is
// NULLED (apply mode), audited via the same gardssalg_content_audit +
// field_provenance discipline applyGardssalgProviderContent uses, so it is
// reversible via the existing POST /admin/gardssalg-content-rollback with NO
// changes to that endpoint (about_text/visit_text are already in
// GARDSSALG_ROLLBACKABLE_FIELDS there).
//
// Extraction is deliberately NOT re-run against the current value here:
// summarizeAbout()/summarizeVisit() (criterion 1's extractProseText fallback
// included) derive a NEW candidate from freshly fetched HTML, but this
// route's job is judging what's ALREADY STORED, not deriving a replacement —
// see the Non-goals below. The refetch is still real (not skipped) because
// the write discipline requires a genuine evidence_url, and because a
// currently-unreachable homepage is treated the same as content-refresh
// treats it (recordProviderHomepageFetchResult / dead-homepage parking) —
// see processOne() below.
//
// FAIL-CLOSED, but in the OPPOSITE direction from every other gårdssalg LLM
// call site in this file: judgeGardssalgAboutCandidate's own contract
// resolves ANY doubt (missing key/network/parse/ambiguous-verdict failure)
// to `{ approved: false }`, because for a CANDIDATE "not approved" means
// "don't publish it" — the safe default. Here, "not approved" would instead
// mean "null out content that's already live" — a DESTRUCTIVE action, so
// blindly nulling on `approved === false` would mean an API outage nulls
// every row's content in one sweep. isJudgeInfraFailure() below tells a
// genuine LLM rejection (real Norwegian reasoning from the model) apart from
// an infra failure (judgeGardssalgAboutCandidate's own fail-closed sentinel
// reasoning, every branch of which ends in the literal marker "avvist
// fail-closed" — see that function's source) and only the FORMER nulls a
// field; an infra failure leaves the field exactly as it is (retried next
// run), matching this endpoint's own constraint: "on judge uncertainty/
// error, do NOT null the field". meetsAboutCheapBar's "thin/boilerplate/
// mangled/foreign" rejection needs no such split — it is a deterministic,
// local, network-free check with no failure mode to be uncertain about.
//
// "Re-queue": no new queue mechanism is added. selectGardssalgProviders
// ForContentRefresh's WHERE clause already re-selects any row whose
// about_text/visit_text/opening_hours_text/products is blank — nulling a
// field here makes it blank, so the very next content-refresh run (cron or
// manual) picks the row back up on its own. Verified, not invented, per this
// criterion's own instruction.
//
// Non-goals (explicit): no replacement candidate is generated or written by
// this route — it only nulls + re-queues. No automatic re-visibility of a
// row whose fields get nulled. No changes to opening_hours_text/products, no
// changes to the content-refresh route's own generation logic.
//
// NB: MUST come before "/:id" so "admin" isn't swallowed as an id param.

/**
 * Tell a genuine LLM rejection apart from judgeGardssalgAboutCandidate's own
 * fail-closed sentinel (missing key / network / non-200 / unparseable JSON /
 * unexpected shape / ambiguous verdict text) — see that function's source:
 * every one of those failure branches' reasoning ends in the exact literal
 * suffix below; a genuine AVVIS verdict's reasoning is either the model's
 * own one-sentence Norwegian explanation or, if the model returned no
 * reasoning at all, the literal "avvist av LLM-dommer" fallback — neither of
 * which ends in this suffix.
 */
const GARDSSALG_JUDGE_INFRA_FAILURE_SUFFIX = "avvist fail-closed";
function isJudgeInfraFailure(verdict: GardssalgJudgeVerdict): boolean {
  return verdict.reasoning.endsWith(GARDSSALG_JUDGE_INFRA_FAILURE_SUFFIX);
}

/**
 * Decide whether ONE currently-stored about_text/visit_text value should be
 * nulled by the retro-scan: a deterministic meetsAboutCheapBar fail is
 * confident, real information (never "doubt") and nulls outright; a
 * cheap-bar pass is then judged by the LLM, and ONLY a genuine (non-infra-
 * failure) rejection nulls — an infra failure leaves the field untouched
 * (fail-closed toward NOT destroying data, per this route's own contract).
 * Blank values are never flagged (nothing to judge). Returns the judge's
 * reasoning (or a fixed cheap-bar reason) for the response's `changed[]`.
 */
async function gardssalgRetroScanShouldNull(
  value: string | null | undefined,
  producerName: string,
  kind: "about" | "visit"
): Promise<{ shouldNull: boolean; reason: string | null }> {
  if (value === null || value === undefined || String(value).trim() === "") {
    return { shouldNull: false, reason: null };
  }
  if (!meetsAboutCheapBar(value)) {
    return { shouldNull: true, reason: "fails the cheap bar (too short/boilerplate/mangled/foreign)" };
  }
  const verdict = await judgeGardssalgAboutCandidate(value, producerName, kind);
  if (verdict.approved) return { shouldNull: false, reason: null };
  if (isJudgeInfraFailure(verdict)) {
    // Never destroy data on doubt — leave the field exactly as it is.
    return { shouldNull: false, reason: null };
  }
  return { shouldNull: true, reason: verdict.reasoning };
}

const GS_RS_DEFAULT_LIMIT = 48;
const GS_RS_HARD_CAP = 48; // there are only 48 gårdssalg providers total

router.post("/admin/gardssalg-retro-scan", requireAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { providerIds?: unknown; limit?: unknown; apply?: unknown };

  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  const limit = Math.min(
    typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : GS_RS_DEFAULT_LIMIT,
    GS_RS_HARD_CAP
  );

  let targets: GardssalgRetroScanTarget[];
  if (Array.isArray(body.providerIds) && body.providerIds.length > 0) {
    const ids = (body.providerIds as unknown[])
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim())
      .slice(0, limit);
    targets = ids
      .map((id) => getGardssalgProviderRetroScanTarget(id))
      .filter((t): t is GardssalgRetroScanTarget => t !== null);
  } else {
    targets = selectGardssalgProvidersForRetroScan(limit);
  }

  let scanned = 0;
  const byField: Record<"about_text" | "visit_text", { flagged: number; nulled: number }> = {
    about_text: { flagged: 0, nulled: 0 },
    visit_text: { flagged: 0, nulled: 0 },
  };
  const changed: Array<{ provider_id: string; fields: string[]; reasons: Record<string, string> }> = [];
  const skippedLocked: string[] = [];
  const errors: Array<{ provider_id: string; error: string }> = [];

  async function processOne(t: GardssalgRetroScanTarget): Promise<void> {
    const providerId = t.id;

    // LOCK check — from the target's own row snapshot, BEFORE any fetch, so
    // a locked provider never touches the network at all. Same discipline as
    // /admin/gardssalg-content-refresh (see that route's own doc comment for
    // why this is deliberately a pre-fetch, snapshot-based check).
    if (t.content_source === "manual" || t.content_source === "claim") {
      skippedLocked.push(providerId);
      return;
    }

    let fetched: CrFetchOutcome;
    try {
      fetched = await crFetchGardssalgContent(t.hjemmeside);
    } catch (e: any) {
      errors.push({ provider_id: providerId, error: e?.message ?? String(e) });
      // NO parking strike — see the note on the other fetch catches: an
      // exception here is our fault, not the site's.
      return;
    }
    if (!fetched.ok) {
      errors.push({
        provider_id: providerId,
        error: `fetch_failed:${fetched.reason} (${fetched.persistence}) for ${t.hjemmeside}`,
      });
      // Persistence-gated parking — same counter, same rule as the two routes above.
      if (apply && fetched.persistence !== "transient") {
        try { recordProviderHomepageFetchResult(providerId, false); } catch { /* best-effort */ }
      }
      return;
    }
    if (apply) {
      try { recordProviderHomepageFetchResult(providerId, true); } catch { /* best-effort */ }
    }
    scanned++;

    const [aboutVerdict, visitVerdict] = await Promise.all([
      gardssalgRetroScanShouldNull(t.about_text, t.navn, "about"),
      gardssalgRetroScanShouldNull(t.visit_text, t.navn, "visit"),
    ]);

    const wouldNullFields: Array<"about_text" | "visit_text"> = [];
    const reasons: Record<string, string> = {};
    if (aboutVerdict.shouldNull) {
      wouldNullFields.push("about_text");
      reasons.about_text = aboutVerdict.reason!;
    }
    if (visitVerdict.shouldNull) {
      wouldNullFields.push("visit_text");
      reasons.visit_text = visitVerdict.reason!;
    }
    if (wouldNullFields.length === 0) return;

    for (const f of wouldNullFields) byField[f].flagged += 1;

    if (dryRun) {
      changed.push({ provider_id: providerId, fields: wouldNullFields, reasons });
      return;
    }

    try {
      const written = applyGardssalgRetroScanNull(providerId, wouldNullFields, fetched.fetchUrl);
      if (written.length > 0) {
        for (const f of written) byField[f as "about_text" | "visit_text"].nulled += 1;
        changed.push({ provider_id: providerId, fields: written, reasons });
      }
    } catch (e: any) {
      errors.push({ provider_id: providerId, error: `write_failed: ${e?.message ?? String(e)}` });
    }
  }

  // Bounded concurrency for the network fetches + judge calls (reuses
  // CR_CONCURRENCY, same as every other gårdssalg admin sweep in this file).
  for (let i = 0; i < targets.length; i += CR_CONCURRENCY) {
    const slice = targets.slice(i, i + CR_CONCURRENCY);
    await Promise.all(slice.map((t) => processOne(t)));
  }

  res.json({
    dry_run: dryRun,
    scanned,
    by_field: byField,
    changed,
    skipped_locked: skippedLocked,
    errors,
  });
});

// ─── POST /api/opplevelser/admin/gardssalg-nace-discovery (admin) ────────────
//
// dev-request 2026-07-19-brreg-nace-drikkeprodusenter (motivert av 67 North
// Distillery-funnet: NACE 11.010 var usynlig for all discovery). Sweeps
// Brreg's registry by the DRINK NACE code family and lands new gårdssalg
// providers org_nr-KEYED from birth — with Brreg business address and
// hjemmeside in the same insert, so a discovered provider is born with the
// identity key + "Sted" data the legacy 74 lacked. Dry-run by default.
//
// Fixed, validated code→producer_type map — arbitrary codes are rejected
// (400), this endpoint scans the drink family only:
//   11.010 destilleri · 11.030 sideri · 11.040 mjøderi · 11.050 bryggeri
//
// Per candidate enhet:
//   dead        — konkurs / underAvvikling / underTvangsavviklingEller-
//                 Tvangsopplosning / slettedato → skipped, reported.
//   duplicate   — org_nr already in experience_providers (ANY row), or
//                 exact name match (scoreNameMatch === 1.0 against the raw
//                 OR the «— Sted»-pruned catalog name; legacy dash-suffixed
//                 rows score only 0.8 raw, and re-creating them would mint
//                 a public duplicate that also steals the org_nr (UNIQUE)
//                 the legacy row needs) against an existing gårdssalg row
//                 (incl. catalog_hidden) → skipped. In apply mode the
//                 name-match variant is also upserted into
//                 gardssalg_orgnr_review_queue (reason
//                 nace_discovery_name_match) so the approve lever can adopt
//                 the suggested org_nr onto the EXISTING row.
//   capped      — creatable but beyond maxCreate → counted per code and
//                 reported, so a capped run is distinguishable from a
//                 complete sweep.
//   created     — createProvider() with org_nr/navn (brregDisplayName)/
//                 forretningsadresse/kommune(+nummer)/fylke (cityToFylke
//                 best effort)/hjemmeside/organisasjonsform/naeringskode,
//                 then producer_type + batch tag (rfb_seed_source =
//                 batch_tag — any value other than the literal 'rfb-seed'
//                 is inert for the gårdssalg WHERE clause; visibility comes
//                 from producer_type) + verification_status pending_verify.
//                 booking_live is NEVER set (onboarding owns that).
//
// Batch rollback (acceptance criterion 5): body {rollbackBatch: "<tag>",
// apply} deletes ONLY rows whose rfb_seed_source equals that tag — the
// one-operation undo for a whole discovery batch (no DB shell exists in
// this environment, so the lever must be an endpoint). Rows a producer has
// since claimed (content_source manual/claim) survive the rollback and are
// reported as skipped_locked — the same lock every gårdssalg writer
// honours. The tag itself is per-RUN unique (date+time), so two batches
// landed the same day roll back independently.
//
// NB: MUST come before "/:id" so "admin" isn't swallowed as an id param.
const GARDSSALG_NACE_PRODUCER_TYPE: Record<string, string> = {
  "11.010": "destilleri",
  "11.030": "sideri",
  "11.040": "mjøderi",
  "11.050": "bryggeri",
};
const GS_ND_PAGE_SIZE = 100;
const GS_ND_MAX_PAGES_PER_CODE = 10; // 1000/code — far above the real ~240 ceiling
const GS_ND_DEFAULT_MAX_CREATE = 400;

router.post("/admin/gardssalg-nace-discovery", requireAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    codes?: unknown;
    apply?: unknown;
    maxCreate?: unknown;
    rollbackBatch?: unknown;
  };

  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  // ── Batch rollback mode ─────────────────────────────────────────────
  if (typeof body.rollbackBatch === "string" && body.rollbackBatch.trim()) {
    const tag = body.rollbackBatch.trim();
    if (tag === "rfb-seed") {
      res.status(400).json({ error: "Refusing: 'rfb-seed' is the legacy seed marker, not a discovery batch tag" });
      return;
    }
    const db = getExpDb("experiences");
    const tagged = db
      .prepare(`SELECT id, navn, org_nr, content_source FROM experience_providers WHERE rfb_seed_source = ?`)
      .all(tag) as Array<{ id: string; navn: string; org_nr: string | null; content_source: string | null }>;
    // A provider claimed/manually curated AFTER discovery must survive the
    // batch undo — deleting it would destroy producer-entered content.
    const skippedLocked = tagged.filter((r) => r.content_source === "manual" || r.content_source === "claim");
    const rows = tagged.filter((r) => r.content_source !== "manual" && r.content_source !== "claim");
    if (dryRun) {
      res.json({ success: true, dry_run: true, batch_tag: tag, would_delete: rows.length, rows, skipped_locked: skippedLocked });
      return;
    }
    const del = db
      .prepare(
        `DELETE FROM experience_providers
          WHERE rfb_seed_source = ?
            AND (content_source IS NULL OR content_source NOT IN ('manual', 'claim'))`
      )
      .run(tag);
    res.json({ success: true, dry_run: false, batch_tag: tag, deleted: del.changes, rows, skipped_locked: skippedLocked });
    return;
  }

  // ── Discovery mode ──────────────────────────────────────────────────
  let codes: string[];
  if (Array.isArray(body.codes) && body.codes.length > 0) {
    codes = (body.codes as unknown[]).filter((c): c is string => typeof c === "string").map((c) => c.trim());
    const unknown = codes.filter((c) => !(c in GARDSSALG_NACE_PRODUCER_TYPE));
    if (unknown.length > 0) {
      res.status(400).json({ error: `Unknown NACE codes: ${unknown.join(", ")} — this endpoint scans the drink family only`, allowed: Object.keys(GARDSSALG_NACE_PRODUCER_TYPE) });
      return;
    }
  } else {
    codes = Object.keys(GARDSSALG_NACE_PRODUCER_TYPE);
  }
  const maxCreate = Math.min(
    typeof body.maxCreate === "number" && body.maxCreate > 0 ? Math.floor(body.maxCreate) : GS_ND_DEFAULT_MAX_CREATE,
    GS_ND_DEFAULT_MAX_CREATE
  );

  // One dedup snapshot up front: org_nr set spans ALL provider rows; the
  // pruned-name basis spans gårdssalg rows (incl. hidden test provider).
  const gardssalgRows = listGardssalgNameDedupRows();
  const db = getExpDb("experiences");
  const knownOrgnr = new Set(
    (db.prepare(`SELECT org_nr FROM experience_providers WHERE org_nr IS NOT NULL AND TRIM(org_nr) != ''`).all() as Array<{ org_nr: string }>)
      .map((r) => r.org_nr.trim())
  );

  // Date+time stamped: a date-only tag collides when two runs land the same
  // day, and rollbackBatch would then undo BOTH batches as one.
  const batchTag = `brreg-nace-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
  const perCode: Record<string, { total: number; dead: number; duplicates: number; created: number; capped: number }> = {};
  const created: Array<{ provider_id?: string; org_nr: string; navn: string; producer_type: string; kommune: string | null; hjemmeside: string | null }> = [];
  const duplicates: Array<{ org_nr: string; brreg_navn: string; reason: string; existing_provider_id?: string; suggested_orgnr_for_existing?: string }> = [];
  const dead: Array<{ org_nr: string; navn: string }> = [];
  const errors: Array<{ code: string; error: string }> = [];
  const seenThisBatch = new Set<string>();
  // Tracks how many times each existing gårdssalg provider_id has already
  // been matched-and-queued THIS sweep. Two distinct Brreg candidates in the
  // same run can exact-name-match the same unkeyed row (across NACE
  // codes/pages); without this, the second upsertGardssalgOrgnrReviewQueue
  // call (ON CONFLICT(provider_id) DO UPDATE) silently overwrites the
  // first's queue row, and the persisted state loses the fact that the
  // org_nr was ambiguous — a human could approve the wrong one.
  const nameMatchCountThisBatch = new Map<string, number>();
  let cappedTotal = 0;

  for (const code of codes) {
    perCode[code] = { total: 0, dead: 0, duplicates: 0, created: 0, capped: 0 };
    try {
      for (let page = 0; page < GS_ND_MAX_PAGES_PER_CODE; page++) {
        const url = `${BRREG_BASE_URL}${BRREG_SEARCH_PATH}?naeringskode=${encodeURIComponent(code)}&size=${GS_ND_PAGE_SIZE}&page=${page}`;
        const resp = await fetch(url);
        if (!resp.ok) {
          errors.push({ code, error: `brreg_http_${resp.status}_page_${page}` });
          break;
        }
        const json: any = await resp.json();
        const enheter: any[] = json?._embedded?.enheter ?? [];
        const totalPages: number = json?.page?.totalPages ?? 1;

        for (const e of enheter) {
          if (!e || typeof e.organisasjonsnummer !== "string" || typeof e.navn !== "string") continue;
          const orgnr = e.organisasjonsnummer.trim();
          if (seenThisBatch.has(orgnr)) continue;
          seenThisBatch.add(orgnr);
          perCode[code].total++;

          if (e.konkurs === true || e.underAvvikling === true || e.underTvangsavviklingEllerTvangsopplosning === true || e.slettedato) {
            perCode[code].dead++;
            dead.push({ org_nr: orgnr, navn: e.navn });
            continue;
          }
          if (knownOrgnr.has(orgnr)) {
            perCode[code].duplicates++;
            duplicates.push({ org_nr: orgnr, brreg_navn: e.navn, reason: "orgnr_exists" });
            continue;
          }
          // Match the raw catalog name AND the «— Sted»-pruned one: legacy
          // dash-suffixed rows («Ægir Bryggeri — Flåm») score only 0.8 raw,
          // and missing them here would CREATE a public duplicate whose
          // insert also takes the org_nr (UNIQUE) — permanently un-keying
          // the legacy row. Over-matching is the safe direction: worst case
          // a genuinely new enhet lands in the review queue instead of the
          // catalog.
          const nameMatch = gardssalgRows.find(
            (g) =>
              scoreNameMatch(g.navn, e.navn, null, null) === 1.0 ||
              scoreNameMatch(gardssalgSearchName(g.navn), e.navn, null, null) === 1.0
          );
          if (nameMatch) {
            perCode[code].duplicates++;
            duplicates.push({
              org_nr: orgnr,
              brreg_navn: e.navn,
              reason: "exact_name_matches_existing_gardssalg",
              existing_provider_id: nameMatch.id,
              suggested_orgnr_for_existing: orgnr,
            });
            // Make the suggestion adoptable, not just reportable: land it in
            // the durable review queue for the approve lever. Apply mode
            // only (dry-run stays side-effect free), and only while the
            // existing row still lacks an org_nr — the queue reflects
            // unresolved rows, and the applier is fill-only anyway.
            if (!dryRun && !(nameMatch.org_nr && nameMatch.org_nr.trim() !== "")) {
              const fa = e.forretningsadresse ?? {};
              const candidateAddress =
                [
                  Array.isArray(fa.adresse) ? fa.adresse.filter(Boolean).join(", ") : "",
                  typeof fa.postnummer === "string" ? fa.postnummer : "",
                  typeof fa.poststed === "string" ? fa.poststed : "",
                ]
                  .filter(Boolean)
                  .join(", ") || null;
              const priorMatches = nameMatchCountThisBatch.get(nameMatch.id) ?? 0;
              nameMatchCountThisBatch.set(nameMatch.id, priorMatches + 1);
              const isAmbiguous = priorMatches > 0;
              try {
                upsertGardssalgOrgnrReviewQueue({
                  provider_id: nameMatch.id,
                  provider_name: nameMatch.navn,
                  candidate_orgnr: isAmbiguous ? null : orgnr,
                  candidate_name: e.navn,
                  candidate_confidence: 1.0,
                  candidate_address: candidateAddress,
                  reason: isAmbiguous ? "nace_discovery_name_match_ambiguous" : "nace_discovery_name_match",
                  batch_id: batchTag,
                });
              } catch {
                /* review-queue is best-effort; discovery itself must not fail on it */
              }
            }
            continue;
          }

          if (created.length >= maxCreate) {
            perCode[code].capped++;
            cappedTotal++;
            continue;
          }

          const fa = e.forretningsadresse ?? {};
          const adresse = Array.isArray(fa.adresse) ? fa.adresse.filter(Boolean).join(", ") : null;
          const kommune = typeof fa.kommune === "string" ? brregDisplayName(fa.kommune) : null;
          const poststed = typeof fa.poststed === "string" ? brregDisplayName(fa.poststed) : null;
          const hjemmeside =
            typeof e.hjemmeside === "string" && e.hjemmeside.trim()
              ? e.hjemmeside.trim().toLowerCase()
              : null;
          const displayNavn = brregDisplayName(e.navn);
          const producerType = GARDSSALG_NACE_PRODUCER_TYPE[code];

          if (dryRun) {
            perCode[code].created++;
            created.push({ org_nr: orgnr, navn: displayNavn, producer_type: producerType, kommune, hjemmeside });
          } else {
            try {
              const providerId = createProvider({
                org_nr: orgnr,
                navn: displayNavn,
                adresse: adresse ?? undefined,
                postnummer: typeof fa.postnummer === "string" ? fa.postnummer : undefined,
                poststed: poststed ?? undefined,
                kommune: kommune ?? undefined,
                kommunenummer: typeof fa.kommunenummer === "string" ? fa.kommunenummer : undefined,
                fylke: cityToFylke(kommune) ?? undefined,
                hjemmeside: hjemmeside ?? undefined,
                organisasjonsform: e.organisasjonsform?.kode ?? undefined,
                naeringskode: code,
                source: "brreg-nace-discovery",
                confidence: "high",
              } as any);
              db.prepare(
                `UPDATE experience_providers
                    SET producer_type = @pt, rfb_seed_source = @tag, brreg_verified = 1, brreg_active = 1
                  WHERE id = @id`
              ).run({ pt: producerType, tag: batchTag, id: providerId });
              perCode[code].created++;
              created.push({ provider_id: providerId, org_nr: orgnr, navn: displayNavn, producer_type: producerType, kommune, hjemmeside });
            } catch (err: any) {
              errors.push({ code, error: `create_failed ${orgnr}: ${err?.message ?? String(err)}` });
            }
          }
        }

        if (page + 1 >= totalPages) break;
      }
    } catch (err: any) {
      errors.push({ code, error: err?.message ?? String(err) });
    }
  }

  res.json({
    dry_run: dryRun,
    batch_tag: batchTag,
    per_code: perCode,
    created_count: created.length,
    capped_count: cappedTotal,
    created,
    duplicates,
    dead,
    errors,
  });
});

// ─── POST /api/opplevelser/admin/gardssalg-website-discovery (admin) ────────
//
// dev-request 2026-07-19-gardssalg-nye-agenter-komplett-foer-synlig, skive B
// (L4 — Daniels GO gitt ordrett samme dag). Finds candidate websites for
// gårdssalg providers whose hjemmeside is blank — the enrichment chain is
// source-based, so without a website a row can never be filled. Per target,
// TWO candidate-host tiers are tried, first verified candidate wins:
//
//   Tier 1 (free, tried first) — deterministic candidate hosts guessed from
//     the provider's own name (gardssalgWebsiteCandidateHosts).
//   Tier 2 (paid, only when tier 1 verifies nothing) — dev-request
//     2026-07-21-gardssalg-soekebasert-nettsidefunn: ONE braveSearch call for
//     `"<name>" <kommune/poststed> [<producer_type>]`, whose top organic
//     hits' hosts become candidates (gardssalgWebsiteSearchQuery /
//     gardssalgWebsiteSearchCandidateHosts). A live 20-row test of tier 1
//     alone scored 0/20 verified — this tier is what actually finds real
//     Norwegian producer domains.
//
// Tier 1 is kept rather than removed: it costs no API call and (per Brave's
// free-tier pacing) a fast DNS/connect failure on a wrong guess is cheaper
// than a search call, so trying it first before ever spending tier 2 is
// strictly a cost win on the rare rows where it verifies. See the PR
// description for the full removal-vs-keep tradeoff.
//
// BOTH tiers flow through the IDENTICAL pre-fetch exclusion → SSRF-guarded
// fetch (redirects followed, FINAL host re-checked) → ownership-evidence
// pipeline (tryGardssalgCandidateHosts, below) — nothing about verification,
// the review queue, or the approval lever changes for tier 2. Pre-fetch
// exclusion is gardssalgWebsiteHostExclusionReason: curated directory/
// aggregator + visit*-DMO hosts (as before) PLUS, new in this dev-request, a
// dedicated social-media check (facebook.com/instagram.com/… — common tier-2
// hits for producers with only a Facebook page, no real site) so a social
// profile is reported with its own "social_media_host" reason rather than
// ever being proposed as a homepage; hosts ALREADY carried by any catalog row
// are also still rejected (shared-host guard).
//
// Verified candidates are parked in gardssalg_website_review_queue — NEVER
// written to the row by this route. Adoption goes through the approve lever
// below. Dry-run by default: dry-run fetches (read-only) but writes NOTHING
// (no queue rows, no attempt stamps). Apply mode stamps
// website_discovery_attempted_at on every processed target (anti-starvation)
// and upserts the queue. Selection includes catalog_hidden rows by design —
// the komplett-foer-synlig plan runs this on hidden batches.
//
// Cost control: at most ONE braveSearch call per row per run (tier 2 is
// tried once, using the first search response's hits — never re-queried),
// and only when tier 1 found nothing. The per-run row-count cap
// (GS_WD_DEFAULT_LIMIT/GS_WD_HARD_CAP, unchanged) still bounds how many rows
// — and therefore how many search calls — a single run can make. If no Brave
// key is configured (BRAVE_API_KEY / BRAVE_SEARCH_API_KEY) and no test
// override is set, tier 2 is silently skipped (tier 1 still runs) rather
// than 503ing the whole route — unlike POST /admin/search-enrich, whose
// entire purpose is search, this endpoint still has a free tier that works
// without a key.
const GS_WD_DEFAULT_LIMIT = 16;
// v2: max contact-ish subpages fetched per candidate host when the front
// page carries a partial signal but doesn't verify on its own.
const GS_WD_SUBPAGES_PER_HOST = 2;
const GS_WD_HARD_CAP = 48;
// v2 (Daniels retning 2026-07-30): raised 5 → 10. Measured on the live
// drikkested cohort: the top organic hits are dominated by directory domains
// (1881/proff/gulesider/purehelp/untappd) that the exclusion pipeline
// correctly rejects — at 5 the surviving candidate list was often empty
// before the real brand domain was ever reached.
const GS_WD_SEARCH_MAX_CANDIDATES = 10;

async function wdFetchPage(url: string): Promise<{ html: string; finalUrl: string } | null> {
  if (!isSafeFetchUrl(url)) return null;
  const fetchUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const resp = await fetch(fetchUrl, {
      redirect: "follow",
      headers: { "User-Agent": CR_UA, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(CR_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    return { html, finalUrl: resp.url || fetchUrl };
  } catch {
    return null;
  }
}

/**
 * Try a list of candidate hosts (either tier) in order: pre-fetch exclusion
 * (social-media / directory-aggregator / DMO / shared-host-in-catalog),
 * SSRF-guarded fetch, final-host re-check after redirect (same exclusions),
 * then ownership-evidence match. Returns the first VERIFIED hit, or null.
 * Mutates `tried`/`excludedHere` (shared across BOTH tiers for one row) so
 * the response's per-provider `tried`/`excluded` reporting is a single,
 * complete picture regardless of which tier a host came from.
 */
async function tryGardssalgCandidateHosts(
  hosts: string[],
  hostCounts: Map<string, number>,
  target: {
    org_nr: string | null;
    navn: string;
    kommune: string | null;
    poststed: string | null;
    telefon?: string | null;
    mobil?: string | null;
    adresse?: string | null;
    postnummer?: string | null;
  },
  tried: string[],
  excludedHere: Array<{ host: string; reason: string }>,
): Promise<{ host: string; finalUrl: string; evidence: ReturnType<typeof gardssalgWebsiteEvidenceMatch> } | null> {
  for (const host of hosts) {
    const listed = gardssalgWebsiteHostExclusionReason(host);
    if (listed) {
      excludedHere.push({ host, reason: listed });
      continue;
    }
    if ((hostCounts.get(host) || 0) >= 1) {
      excludedHere.push({ host, reason: "host_already_in_catalog" });
      continue;
    }
    tried.push(host);
    const page = await wdFetchPage(`https://${host}`);
    if (!page) continue;
    const finalHost = hostFromUrlLike(page.finalUrl) || host;
    if (finalHost !== host) {
      const listedFinal = gardssalgWebsiteHostExclusionReason(finalHost);
      if (listedFinal) {
        excludedHere.push({ host: finalHost, reason: listedFinal });
        continue;
      }
      if ((hostCounts.get(finalHost) || 0) >= 1) {
        excludedHere.push({ host: finalHost, reason: "host_already_in_catalog" });
        continue;
      }
    }
    const evTarget = {
      orgNr: target.org_nr,
      navn: target.navn,
      kommune: target.kommune,
      poststed: target.poststed,
      telefon: target.telefon ?? null,
      mobil: target.mobil ?? null,
      adresse: target.adresse ?? null,
      postnummer: target.postnummer ?? null,
    };
    const ev = gardssalgWebsiteEvidenceMatch(gardssalgPageText(page.html), evTarget);
    if (ev.verified) {
      return { host, finalUrl: page.finalUrl, evidence: ev };
    }
    // v2: the deciding evidence (org.nr, address, phone) usually lives on
    // /kontakt or /om-oss, not the front page. When the front page shows at
    // least ONE partial signal (an unrelated site shows none — crawling it
    // further is pure waste), follow up to GS_WD_SUBPAGES_PER_HOST contact-
    // ish same-host links and re-run the SAME evidence match per page. First
    // verified page wins, and its URL is returned as final_url so the queue
    // row records where the evidence actually was.
    const anySignal = ev.name_found || ev.place_found || ev.phone_found || ev.address_found;
    if (anySignal) {
      const subpages = gardssalgContactPageLinks(page.html, host, GS_WD_SUBPAGES_PER_HOST);
      for (const sub of subpages) {
        const subPage = await wdFetchPage(sub);
        if (!subPage) continue;
        const subHost = hostFromUrlLike(subPage.finalUrl) || host;
        if (subHost.toLowerCase().replace(/^www\./, "") !== host.toLowerCase().replace(/^www\./, "")) continue;
        const subEv = gardssalgWebsiteEvidenceMatch(gardssalgPageText(subPage.html), evTarget);
        if (subEv.verified) {
          return { host, finalUrl: subPage.finalUrl, evidence: subEv };
        }
      }
    }
  }
  return null;
}

router.post("/admin/gardssalg-website-discovery", requireAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { providerIds?: unknown; limit?: unknown; apply?: unknown };
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;
  const batchTag = `website-discovery-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;

  const skippedLocked: Array<{ provider_id: string; navn: string }> = [];
  const alreadyHasWebsite: Array<{ provider_id: string; navn: string }> = [];
  const notFound: string[] = [];
  let targets: Array<{ id: string; navn: string; org_nr: string | null; kommune: string | null; poststed: string | null; content_source: string | null; producer_type: string | null }> = [];

  if (Array.isArray(body.providerIds) && body.providerIds.length > 0) {
    const ids = (body.providerIds as unknown[]).filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
    if (ids.length > GS_WD_HARD_CAP) {
      res.status(400).json({ error: `Too many providerIds (max ${GS_WD_HARD_CAP} per call)` });
      return;
    }
    for (const id of ids) {
      const t = getGardssalgWebsiteDiscoveryTarget(id);
      if (!t) {
        notFound.push(id);
      } else if (t.content_source === "manual" || t.content_source === "claim") {
        skippedLocked.push({ provider_id: t.id, navn: t.navn });
      } else if (t.hjemmeside && t.hjemmeside.trim() !== "") {
        alreadyHasWebsite.push({ provider_id: t.id, navn: t.navn });
      } else {
        targets.push(t);
      }
    }
  } else {
    const limit =
      typeof body.limit === "number" && body.limit > 0
        ? Math.min(Math.floor(body.limit), GS_WD_HARD_CAP)
        : GS_WD_DEFAULT_LIMIT;
    targets = selectGardssalgProvidersForWebsiteDiscovery(limit);
  }

  const hostCounts = gardssalgSharedHostCounts();
  // Tier-2 search dependency: a test override always wins (never touches the
  // network); otherwise the real braveSearch, wired with whichever Brave env
  // key is configured — or null (tier 2 silently skipped) if neither is set.
  const braveKey = process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY || "";
  const searchFn: GardssalgWebsiteSearchFn | null =
    getGardssalgWebsiteSearchOverride() ??
    (braveKey ? (query: string) => braveSearch(query, braveKey, GS_WD_SEARCH_MAX_CANDIDATES) : null);

  const proposed: Array<{
    provider_id: string;
    navn: string;
    candidate_url: string;
    final_url: string;
    evidence: { org_nr_found: boolean; name_found: boolean; place_found: boolean; verified: boolean };
    confidence: number;
  }> = [];
  const noCandidateVerified: Array<{ provider_id: string; navn: string; tried: string[] }> = [];
  const excluded: Array<{ provider_id: string; navn: string; hosts: Array<{ host: string; reason: string }> }> = [];
  const processedIds: string[] = [];
  let searchCallCount = 0;

  for (const t of targets) {
    processedIds.push(t.id);
    const tried: string[] = [];
    const excludedHere: Array<{ host: string; reason: string }> = [];

    // Tier 1 — free name-guess candidates, tried first.
    const nameGuessHosts = gardssalgWebsiteCandidateHosts(t.navn);
    let hit = await tryGardssalgCandidateHosts(nameGuessHosts, hostCounts, t, tried, excludedHere);

    // Tier 2 — search-based candidates, ONLY when tier 1 verified nothing,
    // and at most ONE braveSearch call for this row.
    if (!hit && searchFn) {
      searchCallCount++;
      try {
        const query = gardssalgWebsiteSearchQuery(t);
        const results: BraveResult[] = await searchFn(query);
        const searchHosts = gardssalgWebsiteSearchCandidateHosts(results, GS_WD_SEARCH_MAX_CANDIDATES);
        hit = await tryGardssalgCandidateHosts(searchHosts, hostCounts, t, tried, excludedHere);
      } catch {
        // A search failure (network/HTTP error) must not abort the row — it
        // simply falls through to no_candidate_verified like a tier with no
        // hits would.
      }
    }

    if (excludedHere.length > 0) excluded.push({ provider_id: t.id, navn: t.navn, hosts: excludedHere });
    if (hit) {
      let finalOrigin: string;
      try {
        const u = new URL(hit.finalUrl);
        finalOrigin = `${u.protocol}//${u.host.toLowerCase()}`;
      } catch {
        finalOrigin = `https://${hit.host}`;
      }
      // v2 graded confidence: org.nr is registry-grade; the provider's own
      // registered phone on the page is nearly as strong; name+address next;
      // name+place (the v1 rule) keeps its 0.9.
      const confidence = hit.evidence.org_nr_found
        ? 1.0
        : hit.evidence.phone_found
          ? 0.95
          : hit.evidence.address_found
            ? 0.92
            : 0.9;
      proposed.push({
        provider_id: t.id,
        navn: t.navn,
        candidate_url: finalOrigin,
        final_url: hit.finalUrl,
        evidence: hit.evidence,
        confidence,
      });
      if (!dryRun) {
        try {
          upsertGardssalgWebsiteReviewQueue({
            provider_id: t.id,
            provider_name: t.navn,
            candidate_url: finalOrigin,
            final_url: hit.finalUrl,
            evidence: JSON.stringify(hit.evidence),
            confidence,
            reason: "website_discovery_candidate",
            batch_id: batchTag,
          });
        } catch {
          /* queue is best-effort; the run itself must not fail on it */
        }
      }
    } else {
      noCandidateVerified.push({ provider_id: t.id, navn: t.navn, tried });
    }
  }

  if (!dryRun && processedIds.length > 0) stampGardssalgWebsiteDiscoveryAttempt(processedIds);

  res.json({
    dry_run: dryRun,
    batch_tag: batchTag,
    scanned: targets.length,
    proposed_count: proposed.length,
    proposed,
    no_candidate_verified: noCandidateVerified,
    excluded,
    skipped_locked: skippedLocked,
    already_has_website: alreadyHasWebsite,
    not_found: notFound,
    queue_size: listGardssalgWebsiteReviewQueue().length,
    // dev-request 2026-07-21-gardssalg-soekebasert-nettsidefunn — observability
    // for the cost-control acceptance criterion: at most one braveSearch call
    // per scanned row, and 0 whenever no Brave key/override is configured.
    search_calls: searchCallCount,
    search_configured: searchFn !== null,
  });
});

// ─── POST /api/opplevelser/admin/gardssalg-website-review-approve (admin) ───
//
// The adoption lever for website-discovery candidates — same strict
// confirmation-surface contract as the org_nr approve lever: ONLY the queued
// (provider_id, candidate_url) pair can be approved; a different URL is
// rejected (mismatch_with_queued_candidate), a non-queued provider is
// rejected. Writes go through applyGardssalgProviderWebsite (fill-only, lock
// guard, shared-host identity re-check, audit + provenance), and the queue
// entry is cleared on a confirmed write. Never an arbitrary-write surface.
router.post("/admin/gardssalg-website-review-approve", requireAdmin, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { approvals?: unknown; apply?: unknown };
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  if (!Array.isArray(body.approvals) || body.approvals.length === 0) {
    res.status(400).json({ error: "Body must contain a non-empty 'approvals' array of {provider_id, url}" });
    return;
  }
  if (body.approvals.length > 200) {
    res.status(400).json({ error: "Too many approvals (max 200 per call)" });
    return;
  }

  const queue = listGardssalgWebsiteReviewQueue();
  const byProvider = new Map(queue.map((q) => [q.provider_id, q]));
  const seen = new Set<string>();
  const approved: Array<{ provider_id: string; url: string }> = [];
  const written: Array<{ provider_id: string; url: string }> = [];
  const rejected: Array<{ provider_id: string; reason: string }> = [];

  for (const raw of body.approvals as unknown[]) {
    const a = raw as { provider_id?: unknown; url?: unknown };
    const pid = typeof a?.provider_id === "string" ? a.provider_id.trim() : "";
    const url = typeof a?.url === "string" ? a.url.trim() : "";
    if (!pid || !url) {
      rejected.push({ provider_id: pid || "(missing)", reason: "invalid_item" });
      continue;
    }
    if (seen.has(pid)) {
      rejected.push({ provider_id: pid, reason: "duplicate_in_request" });
      continue;
    }
    seen.add(pid);
    const q = byProvider.get(pid);
    if (!q) {
      rejected.push({ provider_id: pid, reason: "not_in_review_queue" });
      continue;
    }
    if (q.candidate_url !== url) {
      rejected.push({ provider_id: pid, reason: "mismatch_with_queued_candidate" });
      continue;
    }
    approved.push({ provider_id: pid, url });
    if (!dryRun) {
      try {
        const w = applyGardssalgProviderWebsite(pid, q.candidate_url, q.final_url || q.candidate_url, q.batch_id ?? undefined);
        if (w.length > 0) {
          written.push({ provider_id: pid, url: q.candidate_url });
          clearGardssalgWebsiteReviewQueueEntry(pid);
        } else {
          rejected.push({ provider_id: pid, reason: "write_skipped_by_guards" });
        }
      } catch (err: any) {
        rejected.push({ provider_id: pid, reason: `write_failed: ${err?.message ?? String(err)}` });
      }
    }
  }

  res.json({
    dry_run: dryRun,
    approved_count: approved.length,
    approved,
    written_count: written.length,
    written,
    rejected,
  });
});

// ─── POST /api/opplevelser/admin/listing-homepage-discovery (admin) ────────
//
// dev-request 2026-07-12-experiences-enrichment-supply-and-aggregator-hygiene,
// Daniel's decision, step 2, evidence-leg (a) ONLY — "offisiell nettside-
// lenken PÅ listing-siden" (the official-website link found on the listing
// page itself). Legs (b) Brreg org-nr lookup and (c) Google Places (licensed
// API, has a cost) are explicitly deferred to their own follow-on slices, not
// built here.
//
// WHY: step 1 (POST /admin/hjemmeside-cleanup-sweep, above) already moved
// providers' wrongly-set hjemmeside — actually a DMO/aggregator catalog URL,
// not the provider's own site — out into listing_url. Those providers are now
// hjemmeside-blank and starve the enrichment pipeline. This route fetches
// listing_url (SSRF-guarded, same wdFetchPage helper defined above for the
// gårdssalg website-discovery pair), extracts the outbound <a href> hostnames
// on that listing page in natural page order, screens out known directory/
// aggregator hosts (a listing page can link to ANOTHER catalog page) and
// hosts already adopted elsewhere (either as a live hjemmeside on a DIFFERENT
// provider, or already queued pending for a DIFFERENT provider) — then, for
// the first surviving host, fetches https://<host> and verifies the
// provider's OWN name literally appears on that candidate page's text. A
// verified candidate is parked in experience_homepage_review_queue — NEVER
// written directly to hjemmeside. Adoption goes through the approve lever
// below, mirroring gårdssalg-website-discovery/-review-approve's strict
// confirmation-surface contract (same table shape, same dry-run/apply
// convention) — a SEPARATE table/route pair rather than reusing the
// gårdssalg twin directly, since this slice is vertical-agnostic (any
// provider with a listing_url can land here) and works off a fetched
// LISTING page's own links rather than deterministic name-derived candidate
// hosts.
//
// Non-goals (this slice): no Brreg org-nr lookup, no Google Places calls, no
// auto-write of hjemmeside outside the approve lever, no changes to
// evidence_url/bulk-load/the step-1 sweep, no new KNOWN_DIRECTORY_HOSTS
// entries added speculatively.
const LH_DISCOVERY_BATCH_CAP = 30;

/**
 * Outbound <a href> hostnames from a listing page's raw HTML, resolved
 * against `baseUrl` (the listing page's OWN final fetched URL — relative
 * hrefs must resolve against it), first-seen page order, de-duplicated,
 * excluding the listing page's own host. A simple regex href extraction —
 * this file already does regex-based lightweight HTML handling elsewhere
 * (gardssalgPageText's tag-strip, isAggregatorWebsite's host parse) — no
 * HTML-parser dependency needed here either. mailto:/tel:/javascript:/bare-
 * fragment hrefs and per-href resolution errors are swallowed; one bad link
 * never aborts the extraction. Pure — exported for unit testing.
 */
export function extractOutboundHostsFromListingPage(html: string, baseUrl: string): string[] {
  let ownHost: string | null = null;
  try {
    ownHost = new URL(baseUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    ownHost = null;
  }
  const hosts: string[] = [];
  const hrefRe = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    const raw = (m[2] || "").trim();
    if (!raw || /^(mailto|tel|javascript):/i.test(raw) || raw.startsWith("#")) continue;
    let resolved: URL;
    try {
      resolved = new URL(raw, baseUrl);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
    const host = resolved.hostname.toLowerCase().replace(/^www\./, "");
    if (!host || host === ownHost) continue;
    if (!hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

/**
 * Ownership evidence for a listing-homepage candidate page: strips HTML tags
 * to plain text (script/style content dropped first, same convention as
 * gardssalgPageText above), then a literal, case-insensitive substring check
 * for the provider's own (trimmed) name. Norwegian æøå are NOT transliterated
 * — kept as-is per the dev-request, this is a substring check only, no
 * scoring heuristic. Pure — exported for unit testing.
 */
export function listingHomepageNameVerified(html: string, providerName: string): boolean {
  const name = (providerName || "").trim().toLowerCase();
  if (!name) return false;
  const text = (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return text.includes(name);
}

// Upsert one row into experience_homepage_review_queue — UNIQUE(provider_id)
// refresh-on-rerun idiom, same shape as upsertGardssalgWebsiteReviewQueue
// (gardssalg_website_review_queue, above) adapted to this queue's own
// status/resolved_at columns (a re-upsert always lands back in 'pending').
// `reason` defaults to leg (a)'s original 'listing_page_link_candidate' —
// unchanged for that existing caller — and is a plain parameter (not a
// hardcoded SQL literal) so leg (b) below can pass its own
// 'brreg_website_candidate' value through the SAME upsert helper rather than
// duplicating this table-write logic a second time.
function upsertListingHomepageReviewQueue(
  db: ReturnType<typeof getExpDb>,
  entry: {
    provider_id: string;
    provider_name: string;
    candidate_url: string;
    final_url: string;
    evidence: string;
    confidence: number;
    batch_id: string;
    reason?: string;
  }
): void {
  db.prepare(
    `INSERT INTO experience_homepage_review_queue
       (id, provider_id, provider_name, candidate_url, final_url, evidence, confidence, reason, batch_id, status, created_at, resolved_at)
     VALUES (@id, @provider_id, @provider_name, @candidate_url, @final_url, @evidence, @confidence, @reason, @batch_id, 'pending', datetime('now'), NULL)
     ON CONFLICT(provider_id) DO UPDATE SET
       provider_name = excluded.provider_name,
       candidate_url = excluded.candidate_url,
       final_url = excluded.final_url,
       evidence = excluded.evidence,
       confidence = excluded.confidence,
       reason = excluded.reason,
       batch_id = excluded.batch_id,
       status = 'pending',
       created_at = datetime('now'),
       resolved_at = NULL`
  ).run({
    id: crypto.randomUUID(),
    reason: entry.reason || "listing_page_link_candidate",
    provider_id: entry.provider_id,
    provider_name: entry.provider_name,
    candidate_url: entry.candidate_url,
    final_url: entry.final_url,
    evidence: entry.evidence,
    confidence: entry.confidence,
    batch_id: entry.batch_id,
  });
}

router.post("/admin/listing-homepage-discovery", requireAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { providerIds?: unknown; apply?: unknown };
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;
  const batchTag = `listing-homepage-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;

  const expDb = getExpDb("experiences");
  const skippedLocked: Array<{ provider_id: string; navn: string }> = [];
  const alreadyHasWebsite: Array<{ provider_id: string; navn: string }> = [];
  const notFound: string[] = [];
  let targets: Array<{ id: string; navn: string; listing_url: string | null; content_source: string | null }> = [];

  if (Array.isArray(body.providerIds) && body.providerIds.length > 0) {
    const ids = (body.providerIds as unknown[]).filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
    if (ids.length > LH_DISCOVERY_BATCH_CAP) {
      res.status(400).json({ error: `Too many providerIds (max ${LH_DISCOVERY_BATCH_CAP} per call)` });
      return;
    }
    for (const id of ids) {
      const t = expDb
        .prepare(
          `SELECT id, navn, listing_url, hjemmeside, content_source, field_provenance, producer_type, rfb_seed_source FROM experience_providers WHERE id = ?`
        )
        .get(id) as
        | {
            id: string;
            navn: string;
            listing_url: string | null;
            hjemmeside: string | null;
            content_source: string | null;
            field_provenance: string | null;
            producer_type: string | null;
            rfb_seed_source: string | null;
          }
        | undefined;
      if (!t) {
        notFound.push(id);
      } else if (
        isHjemmesideLocked({
          id: t.id,
          hjemmeside: t.hjemmeside,
          content_source: t.content_source,
          field_provenance: t.field_provenance,
          producer_type: t.producer_type,
          rfb_seed_source: t.rfb_seed_source,
        })
      ) {
        skippedLocked.push({ provider_id: t.id, navn: t.navn });
      } else if (t.hjemmeside && t.hjemmeside.trim() !== "") {
        alreadyHasWebsite.push({ provider_id: t.id, navn: t.navn });
      } else {
        targets.push({ id: t.id, navn: t.navn, listing_url: t.listing_url, content_source: t.content_source });
      }
    }
  } else {
    targets = expDb
      .prepare(
        `SELECT id, navn, listing_url, content_source
           FROM experience_providers
          WHERE listing_url IS NOT NULL AND hjemmeside IS NULL AND (content_source IS NULL OR content_source NOT IN ('manual','claim'))
          ORDER BY (listing_homepage_discovery_attempted_at IS NOT NULL), listing_homepage_discovery_attempted_at ASC, created_at ASC
          LIMIT ?`
      )
      .all(LH_DISCOVERY_BATCH_CAP) as Array<{ id: string; navn: string; listing_url: string | null; content_source: string | null }>;
  }

  const proposed: Array<{
    provider_id: string;
    navn: string;
    candidate_url: string;
    final_url: string;
    evidence: { host: string; listing_url: string; name_verified: boolean };
    confidence: number;
  }> = [];
  const noCandidateVerified: Array<{ provider_id: string; navn: string; tried: string[] }> = [];
  const excluded: Array<{ provider_id: string; navn: string; hosts: Array<{ host: string; reason: string }> }> = [];
  const processedIds: string[] = [];
  // Hosts queued (pending) for a DIFFERENT provider WITHIN this same run —
  // apply-mode only, so two candidates discovered in the same batch can't
  // both claim the same host before either write actually lands.
  const queuedThisRun = new Set<string>();
  // Normalized-host set for host_already_in_catalog, computed ONCE per
  // request (not per-candidate) and reused across the whole batch. This is
  // the same normalized-host-comparison approach as gardssalgSharedHostCounts()
  // in experience-store.ts, but deliberately NOT that function — this queue
  // is gårdssalg-agnostic (see the queue table's migration comment), so it
  // must dedup against ALL experience_providers' hjemmeside, not just
  // gårdssalg rows. A raw SQL `LIKE '%' || host` against the stored
  // hjemmeside string is NOT equivalent: a stored hjemmeside of
  // 'https://site.no/' or 'https://site.no/kontakt' does not literally END
  // with 'site.no', so it silently fails to match and an already-catalogued
  // host slips past dedup and gets proposed for a second provider.
  const catalogHosts = new Set<string>();
  for (const row of expDb
    .prepare(`SELECT hjemmeside FROM experience_providers WHERE hjemmeside IS NOT NULL AND TRIM(hjemmeside) != ''`)
    .all() as Array<{ hjemmeside: string }>) {
    const h = hostFromUrlLike(row.hjemmeside);
    if (h) catalogHosts.add(h);
  }

  for (const t of targets) {
    processedIds.push(t.id);
    const tried: string[] = [];
    const excludedHere: Array<{ host: string; reason: string }> = [];
    let hit: { host: string; finalUrl: string } | null = null;

    const listingPage = t.listing_url ? await wdFetchPage(t.listing_url) : null;
    if (listingPage) {
      const candidateHosts = extractOutboundHostsFromListingPage(listingPage.html, listingPage.finalUrl);
      for (const host of candidateHosts) {
        if (isDirectoryOrAggregatorHost(host)) {
          excludedHere.push({ host, reason: "directory_or_aggregator_host" });
          continue;
        }
        if (catalogHosts.has(host)) {
          excludedHere.push({ host, reason: "host_already_in_catalog" });
          continue;
        }
        const queuedElsewhereCount = (
          expDb
            .prepare(
              `SELECT COUNT(*) AS n FROM experience_homepage_review_queue
                WHERE status = 'pending' AND provider_id != ? AND candidate_url LIKE ?`
            )
            .get(t.id, "%" + host) as { n: number }
        ).n;
        if (queuedElsewhereCount > 0 || queuedThisRun.has(host)) {
          excludedHere.push({ host, reason: "host_already_queued_elsewhere" });
          continue;
        }

        tried.push(host);
        const candidatePage = await wdFetchPage(`https://${host}`);
        if (!candidatePage) continue;
        if (!listingHomepageNameVerified(candidatePage.html, t.navn)) continue;
        hit = { host, finalUrl: candidatePage.finalUrl };
        break;
      }
    }

    // Genuinely new for this provider only if it doesn't already have a
    // pending/approved queue entry — e.g. leg (b)'s Brreg-based discovery
    // already proposed something for it, or an earlier run of this same leg
    // did — skip rather than re-upsert, so this leg never clobbers a
    // still-live proposal (from either leg) with its own. Mirrors leg (b)'s
    // identical ownPendingOrApproved guard in POST /admin/brreg-website-
    // discovery above.
    if (hit) {
      const ownPendingOrApproved = expDb
        .prepare(
          `SELECT 1 FROM experience_homepage_review_queue WHERE provider_id = ? AND status IN ('pending','approved')`
        )
        .get(t.id);
      if (ownPendingOrApproved) {
        excludedHere.push({ host: hit.host, reason: "already_queued_for_provider" });
        hit = null;
      }
    }

    if (excludedHere.length > 0) excluded.push({ provider_id: t.id, navn: t.navn, hosts: excludedHere });

    if (hit) {
      let finalOrigin: string;
      try {
        const u = new URL(hit.finalUrl);
        finalOrigin = `${u.protocol}//${u.host.toLowerCase()}`;
      } catch {
        finalOrigin = `https://${hit.host}`;
      }
      const evidence = { host: hit.host, listing_url: t.listing_url as string, name_verified: true };
      const confidence = 0.8;
      proposed.push({
        provider_id: t.id,
        navn: t.navn,
        candidate_url: finalOrigin,
        final_url: hit.finalUrl,
        evidence,
        confidence,
      });
      if (!dryRun) {
        try {
          upsertListingHomepageReviewQueue(expDb, {
            provider_id: t.id,
            provider_name: t.navn,
            candidate_url: finalOrigin,
            final_url: hit.finalUrl,
            evidence: JSON.stringify(evidence),
            confidence,
            batch_id: batchTag,
          });
          queuedThisRun.add(hit.host);
        } catch {
          /* queue write is best-effort; the run itself must not fail on it */
        }
      }
    } else {
      noCandidateVerified.push({ provider_id: t.id, navn: t.navn, tried });
    }
  }

  if (!dryRun && processedIds.length > 0) {
    const stampStmt = expDb.prepare(
      `UPDATE experience_providers SET listing_homepage_discovery_attempted_at = datetime('now') WHERE id = ?`
    );
    for (const id of processedIds) stampStmt.run(id);
  }

  res.json({
    dry_run: dryRun,
    batch_tag: batchTag,
    scanned: targets.length,
    proposed_count: proposed.length,
    proposed,
    no_candidate_verified: noCandidateVerified,
    excluded,
    skipped_locked: skippedLocked,
    already_has_website: alreadyHasWebsite,
    not_found: notFound,
    queue_size: (expDb.prepare(`SELECT COUNT(*) AS n FROM experience_homepage_review_queue`).get() as { n: number }).n,
  });
});

// ─── POST /api/opplevelser/admin/listing-homepage-review-approve (admin) ───
//
// The adoption lever for listing-homepage-discovery candidates — same strict
// confirmation-surface contract as the gårdssalg website-review-approve twin
// above: ONLY the queued (provider_id, candidate_url) pair can be approved; a
// different url is rejected (mismatch_with_queued_candidate), a non-pending
// provider is rejected (not_in_review_queue — an already-approved row is no
// longer "in the review queue" for this route's purposes, so a repeat call
// on the same pair is idempotent). Writes go through writeProviderHjemmeside
// (the same shared UPDATE+row-fetch helper the PATCH .../:id/hjemmeside
// route below uses) ONLY after a fresh fill-only + lock re-check immediately
// before writing — mirrors the discipline applyGardssalgProviderWebsite
// applies at write time, even though that gårdssalg-specific function is not
// itself called here. A guard-failed approval leaves the queue row 'pending'
// (NOT approved, NOT rejected) — it may become writable later; only a
// confirmed write ever moves a row out of 'pending'.
router.post("/admin/listing-homepage-review-approve", requireAdmin, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { approvals?: unknown; apply?: unknown };
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  if (!Array.isArray(body.approvals) || body.approvals.length === 0) {
    res.status(400).json({ error: "Body must contain a non-empty 'approvals' array of {provider_id, url}" });
    return;
  }
  if (body.approvals.length > 200) {
    res.status(400).json({ error: "Too many approvals (max 200 per call)" });
    return;
  }

  const expDb = getExpDb("experiences");
  // Only 'pending' rows are "in the review queue" for this route's purposes —
  // an already-approved row correctly falls into not_in_review_queue below.
  const queue = expDb
    .prepare(`SELECT provider_id, candidate_url FROM experience_homepage_review_queue WHERE status = 'pending'`)
    .all() as Array<{ provider_id: string; candidate_url: string }>;
  const byProvider = new Map(queue.map((q) => [q.provider_id, q]));
  const seen = new Set<string>();
  const approved: Array<{ provider_id: string; url: string }> = [];
  const written: Array<{ provider_id: string; url: string }> = [];
  const rejected: Array<{ provider_id: string; reason: string }> = [];

  for (const raw of body.approvals as unknown[]) {
    const a = raw as { provider_id?: unknown; url?: unknown };
    const pid = typeof a?.provider_id === "string" ? a.provider_id.trim() : "";
    const url = typeof a?.url === "string" ? a.url.trim() : "";
    if (!pid || !url) {
      rejected.push({ provider_id: pid || "(missing)", reason: "invalid_item" });
      continue;
    }
    if (seen.has(pid)) {
      rejected.push({ provider_id: pid, reason: "duplicate_in_request" });
      continue;
    }
    seen.add(pid);
    const q = byProvider.get(pid);
    if (!q) {
      rejected.push({ provider_id: pid, reason: "not_in_review_queue" });
      continue;
    }
    if (q.candidate_url !== url) {
      rejected.push({ provider_id: pid, reason: "mismatch_with_queued_candidate" });
      continue;
    }
    approved.push({ provider_id: pid, url });
    if (!dryRun) {
      // Re-check IMMEDIATELY before writing — fill-only + lock guard, mirrors
      // applyGardssalgProviderWebsite's discipline. If hjemmeside is no
      // longer NULL (filled by something else since queueing) OR
      // content_source has since become manual/claim, the write is skipped
      // and the queue row stays 'pending' (never approved, never rejected).
      const provider = expDb
        .prepare(`SELECT id, hjemmeside, content_source FROM experience_providers WHERE id = ?`)
        .get(pid) as { id: string; hjemmeside: string | null; content_source: string | null } | undefined;
      const guardOk =
        !!provider &&
        (provider.hjemmeside === null || provider.hjemmeside.trim() === "") &&
        provider.content_source !== "manual" &&
        provider.content_source !== "claim";
      if (!guardOk) {
        rejected.push({ provider_id: pid, reason: "write_skipped_by_guards" });
        continue;
      }
      const result = writeProviderHjemmeside(pid, q.candidate_url);
      if (!result) {
        rejected.push({ provider_id: pid, reason: "write_skipped_by_guards" });
        continue;
      }
      expDb
        .prepare(`UPDATE experience_homepage_review_queue SET status = 'approved', resolved_at = datetime('now') WHERE provider_id = ?`)
        .run(pid);
      written.push({ provider_id: pid, url: q.candidate_url });
    }
  }

  res.json({
    dry_run: dryRun,
    approved_count: approved.length,
    approved,
    written_count: written.length,
    written,
    rejected,
  });
});

// ─── POST /api/opplevelser/admin/brreg-website-discovery (admin) ───────────
//
// dev-request 2026-07-12-experiences-enrichment-supply-and-aggregator-hygiene,
// Daniel's decision, step 2, evidence-leg (b) ONLY — Brreg's own `hjemmeside`
// (website) field, looked up directly by the provider's already-known
// `org_nr`. Leg (c) (Google Places, licensed/paid API) stays out of scope.
//
// Mirrors listing-homepage-discovery (leg (a)) closely: same admin gate, same
// apply-boolean dry-run-by-default convention, same batch cap (30), same
// experience_homepage_review_queue destination (NEVER writes hjemmeside
// directly — queue only), same aggregator-host + already-live-elsewhere
// shared-host exclusion checks. Genuinely NEW here (leg (a) never needed it,
// since it was the only writer of this queue when it was built): a result
// already carrying a pending/approved queue entry for THIS provider is
// skipped rather than re-upserted — UNIQUE(provider_id) means an unconditional
// upsert would silently clobber another leg's (or an earlier run's) still-live
// proposal for the same provider.
//
// Candidate set: org_nr IS NOT NULL AND hjemmeside IS NULL AND content_source
// NOT IN ('manual','claim') — mirroring leg (a)'s NULL-safe form of that
// condition (a bare `content_source NOT IN (...)` is NULL for every row whose
// content_source is itself NULL, per SQL's three-valued logic, which would
// silently exclude every un-sourced/auto-discovered provider — not the
// intent; leg (a)'s existing selector already guards against exactly this).
//
// Non-goals (this slice): no Brreg org-nr lookup CHANGES (verifyOrgNumber/
// fetchBrregActivityDescription/fetchBrregBusinessAddress untouched), no
// Google Places calls, no auto-write of hjemmeside outside the EXISTING
// listing-homepage-review-approve lever (reused as-is, no new approve route),
// no new KNOWN_DIRECTORY_HOSTS entries added speculatively.
const BW_DISCOVERY_BATCH_CAP = 30;

router.post("/admin/brreg-website-discovery", requireAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { providerIds?: unknown; apply?: unknown };
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;
  const batchTag = `brreg-website-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;

  const expDb = getExpDb("experiences");
  const skippedLocked: Array<{ provider_id: string; navn: string }> = [];
  const alreadyHasWebsite: Array<{ provider_id: string; navn: string }> = [];
  const notFound: string[] = [];
  let targets: Array<{ id: string; navn: string; org_nr: string | null; content_source: string | null }> = [];

  if (Array.isArray(body.providerIds) && body.providerIds.length > 0) {
    const ids = (body.providerIds as unknown[]).filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
    if (ids.length > BW_DISCOVERY_BATCH_CAP) {
      res.status(400).json({ error: `Too many providerIds (max ${BW_DISCOVERY_BATCH_CAP} per call)` });
      return;
    }
    for (const id of ids) {
      const t = expDb
        .prepare(`SELECT id, navn, org_nr, hjemmeside, content_source FROM experience_providers WHERE id = ?`)
        .get(id) as
        | { id: string; navn: string; org_nr: string | null; hjemmeside: string | null; content_source: string | null }
        | undefined;
      if (!t) {
        notFound.push(id);
      } else if (t.content_source === "manual" || t.content_source === "claim") {
        skippedLocked.push({ provider_id: t.id, navn: t.navn });
      } else if (t.hjemmeside && t.hjemmeside.trim() !== "") {
        alreadyHasWebsite.push({ provider_id: t.id, navn: t.navn });
      } else {
        targets.push({ id: t.id, navn: t.navn, org_nr: t.org_nr, content_source: t.content_source });
      }
    }
  } else {
    targets = expDb
      .prepare(
        `SELECT id, navn, org_nr, content_source
           FROM experience_providers
          WHERE org_nr IS NOT NULL AND hjemmeside IS NULL AND (content_source IS NULL OR content_source NOT IN ('manual','claim'))
          ORDER BY (brreg_website_discovery_attempted_at IS NOT NULL), brreg_website_discovery_attempted_at ASC, created_at ASC
          LIMIT ?`
      )
      .all(BW_DISCOVERY_BATCH_CAP) as Array<{ id: string; navn: string; org_nr: string | null; content_source: string | null }>;
  }

  const proposed: Array<{
    provider_id: string;
    navn: string;
    candidate_url: string;
    evidence: { host: string; org_nr: string; source: "brreg_hjemmeside" };
    confidence: number;
  }> = [];
  const noWebsiteInBrreg: Array<{ provider_id: string; navn: string }> = [];
  const excluded: Array<{ provider_id: string; navn: string; host: string; reason: string }> = [];
  const processedIds: string[] = [];
  // Hosts queued (pending) for a DIFFERENT provider WITHIN this same run —
  // apply-mode only, mirrors listing-homepage-discovery's queuedThisRun guard.
  const queuedThisRun = new Set<string>();
  // Normalized-host set for host_already_in_catalog — computed ONCE per
  // request and reused across the whole batch, same shared-host guard leg
  // (a) already computes (vertical-agnostic: dedups against ALL
  // experience_providers' hjemmeside, not just this vertical's rows).
  const catalogHosts = new Set<string>();
  for (const row of expDb
    .prepare(`SELECT hjemmeside FROM experience_providers WHERE hjemmeside IS NOT NULL AND TRIM(hjemmeside) != ''`)
    .all() as Array<{ hjemmeside: string }>) {
    const h = hostFromUrlLike(row.hjemmeside);
    if (h) catalogHosts.add(h);
  }

  for (const t of targets) {
    processedIds.push(t.id);

    const website = t.org_nr ? await fetchBrregWebsite(t.org_nr) : null;
    if (!website) {
      noWebsiteInBrreg.push({ provider_id: t.id, navn: t.navn });
      continue;
    }

    const host = hostFromUrlLike(website);
    if (!host) {
      noWebsiteInBrreg.push({ provider_id: t.id, navn: t.navn });
      continue;
    }

    if (isDirectoryOrAggregatorHost(host)) {
      excluded.push({ provider_id: t.id, navn: t.navn, host, reason: "directory_or_aggregator_host" });
      continue;
    }
    if (catalogHosts.has(host)) {
      excluded.push({ provider_id: t.id, navn: t.navn, host, reason: "host_already_in_catalog" });
      continue;
    }
    const queuedElsewhereCount = (
      expDb
        .prepare(
          `SELECT COUNT(*) AS n FROM experience_homepage_review_queue
            WHERE status = 'pending' AND provider_id != ? AND candidate_url LIKE ?`
        )
        .get(t.id, "%" + host) as { n: number }
    ).n;
    if (queuedElsewhereCount > 0 || queuedThisRun.has(host)) {
      excluded.push({ provider_id: t.id, navn: t.navn, host, reason: "host_already_queued_elsewhere" });
      continue;
    }

    // Genuinely new for this leg: a pending/approved queue entry already
    // exists for THIS SAME provider (e.g. leg (a)'s listing-page discovery
    // already proposed something, or an earlier run of this same leg did) —
    // skip rather than re-upsert, so this leg never clobbers a still-live
    // proposal (from either leg) with its own.
    const ownPendingOrApproved = expDb
      .prepare(
        `SELECT 1 FROM experience_homepage_review_queue WHERE provider_id = ? AND status IN ('pending','approved')`
      )
      .get(t.id);
    if (ownPendingOrApproved) {
      excluded.push({ provider_id: t.id, navn: t.navn, host, reason: "already_queued_for_provider" });
      continue;
    }

    let finalOrigin: string;
    try {
      const u = new URL(website);
      finalOrigin = `${u.protocol}//${u.host.toLowerCase()}`;
    } catch {
      finalOrigin = `https://${host}`;
    }
    const evidence = { host, org_nr: t.org_nr as string, source: "brreg_hjemmeside" as const };
    const confidence = 1.0;
    proposed.push({
      provider_id: t.id,
      navn: t.navn,
      candidate_url: finalOrigin,
      evidence,
      confidence,
    });
    if (!dryRun) {
      try {
        upsertListingHomepageReviewQueue(expDb, {
          provider_id: t.id,
          provider_name: t.navn,
          candidate_url: finalOrigin,
          final_url: finalOrigin,
          evidence: JSON.stringify(evidence),
          confidence,
          batch_id: batchTag,
          reason: "brreg_website_candidate",
        });
        queuedThisRun.add(host);
      } catch {
        /* queue write is best-effort; the run itself must not fail on it */
      }
    }
  }

  if (!dryRun && processedIds.length > 0) {
    const stampStmt = expDb.prepare(
      `UPDATE experience_providers SET brreg_website_discovery_attempted_at = datetime('now') WHERE id = ?`
    );
    for (const id of processedIds) stampStmt.run(id);
  }

  res.json({
    dry_run: dryRun,
    batch_tag: batchTag,
    scanned: targets.length,
    proposed_count: proposed.length,
    proposed,
    no_website_in_brreg: noWebsiteInBrreg,
    excluded,
    skipped_locked: skippedLocked,
    already_has_website: alreadyHasWebsite,
    not_found: notFound,
    queue_size: (expDb.prepare(`SELECT COUNT(*) AS n FROM experience_homepage_review_queue`).get() as { n: number }).n,
  });
});

// ─── GET /api/opplevelser/admin/providers/homepage-open-uncovered (admin) ──
// POST /api/opplevelser/admin/homepage-review-queue/submit (admin) ──────────
//
// dev-request 2026-07-12-experiences-enrichment-supply-and-aggregator-hygiene,
// Daniel's decision, step 2, evidence-leg (d) — the RESIDUAL cohort: providers
// with NEITHER org_nr NOR listing_url set, so neither leg (a)'s
// listing_url-driven candidate set NOR leg (b)'s org_nr-driven candidate set
// ever selects them. There is no server-side web-search/LLM capability in
// this app (and none is added here) — an external process (a human, or an
// orchestrator session) does the actual research and submits results. These
// two routes are the plumbing only:
//   - GET .../homepage-open-uncovered surfaces the residual cohort (read-only,
//     rotates through the cohort via web_search_homepage_attempted_at, same
//     cursor idiom as legs (a)/(b)).
//   - POST .../homepage-review-queue/submit accepts already-researched
//     {provider_id, candidate_url, name_verified} triples and, after the SAME
//     guard checks legs (a)/(b) already enforce (locked content_source,
//     already-has-website, directory/aggregator host, host-already-in-
//     catalog, already-queued-for-provider) PLUS a hard name_verified===true
//     requirement (the API-boundary enforcement that the external caller
//     actually confirmed the provider's name on the candidate site — this
//     route has no way to verify that itself), upserts survivors into
//     experience_homepage_review_queue with reason 'web_search_candidate' and
//     a conservative confidence (0.6 — lower than leg (b)'s 1.0 Brreg-
//     registry confidence, since this is unverified-by-structured-data).
//     NEVER writes hjemmeside directly — adoption goes through the EXISTING
//     listing-homepage-review-approve lever, unmodified (it keys off
//     provider_id/candidate_url against the shared queue table, not off
//     reason, so it already works generically for this leg's rows too).
//
// Non-goals (this slice): no web-search/LLM call from application code (the
// caller is expected to have already done that research), no new approve
// route, no Google Places calls, no new KNOWN_DIRECTORY_HOSTS entries added
// speculatively.
const HOMEPAGE_OPEN_UNCOVERED_DEFAULT_LIMIT = 30;
const HOMEPAGE_OPEN_UNCOVERED_MAX_LIMIT = 30;
router.get("/admin/providers/homepage-open-uncovered", requireAdmin, (req: Request, res: Response) => {
  let limit = parseInt((req.query.limit as string) || "", 10);
  if (!Number.isFinite(limit)) limit = HOMEPAGE_OPEN_UNCOVERED_DEFAULT_LIMIT;
  if (limit > HOMEPAGE_OPEN_UNCOVERED_MAX_LIMIT) {
    res.status(400).json({ error: `limit too large (max ${HOMEPAGE_OPEN_UNCOVERED_MAX_LIMIT} per call)` });
    return;
  }
  if (limit < 1) limit = HOMEPAGE_OPEN_UNCOVERED_DEFAULT_LIMIT;

  try {
    const expDb = getExpDb("experiences");
    const rows = expDb
      .prepare(
        `SELECT id, navn, kommune, producer_type
           FROM experience_providers
          WHERE hjemmeside IS NULL AND org_nr IS NULL AND listing_url IS NULL
            AND (content_source IS NULL OR content_source NOT IN ('manual','claim'))
          ORDER BY (web_search_homepage_attempted_at IS NOT NULL), web_search_homepage_attempted_at ASC, created_at ASC
          LIMIT ?`
      )
      .all(limit) as Array<{ id: string; navn: string; kommune: string | null; producer_type: string | null }>;

    const candidates = rows.map((r) => ({
      id: r.id,
      navn: r.navn,
      kommune: r.kommune,
      producer_type: r.producer_type,
    }));

    res.json({ candidates });
  } catch (err) {
    console.error("[opplevelser] admin/providers/homepage-open-uncovered failed", err);
    res.status(500).json({ error: "Internal error" });
  }
});

const HRQ_SUBMIT_BATCH_CAP = 30;
router.post("/admin/homepage-review-queue/submit", requireAdmin, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { candidates?: unknown; apply?: unknown };
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  if (!Array.isArray(body.candidates) || body.candidates.length === 0) {
    res.status(400).json({ error: "Body must contain a non-empty 'candidates' array of {provider_id, candidate_url, name_verified}" });
    return;
  }
  if (body.candidates.length > HRQ_SUBMIT_BATCH_CAP) {
    res.status(400).json({ error: `Too many candidates (max ${HRQ_SUBMIT_BATCH_CAP} per call)` });
    return;
  }

  const expDb = getExpDb("experiences");
  const batchTag = `web-search-homepage-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;

  // Normalized-host set for host_already_in_catalog — same construction
  // pattern as legs (a)/(b) above: computed ONCE per request, reused across
  // the whole batch, vertical-agnostic (dedups against ALL
  // experience_providers.hjemmeside, not just this vertical's rows).
  const catalogHosts = new Set<string>();
  for (const row of expDb
    .prepare(`SELECT hjemmeside FROM experience_providers WHERE hjemmeside IS NOT NULL AND TRIM(hjemmeside) != ''`)
    .all() as Array<{ hjemmeside: string }>) {
    const h = hostFromUrlLike(row.hjemmeside);
    if (h) catalogHosts.add(h);
  }
  // Hosts queued (apply-mode only) for a DIFFERENT provider WITHIN this same
  // run — mirrors legs (a)/(b)'s queuedThisRun guard.
  const queuedThisRun = new Set<string>();

  const seen = new Set<string>();
  const wouldQueue: Array<{ provider_id: string; navn: string; candidate_url: string; host: string }> = [];
  const queued: Array<{ provider_id: string; navn: string; candidate_url: string; host: string }> = [];
  const rejected: Array<{ provider_id: string; reason: string }> = [];
  // Providers whose attempt should be stamped — every candidate this route
  // actually processed (survived or rejected for a substantive reason),
  // EXCEPT invalid_item/duplicate_in_request/not_found, which never resolved
  // to a real, attributable attempt on a real provider row.
  const toStamp: string[] = [];

  for (const raw of body.candidates as unknown[]) {
    const c = raw as { provider_id?: unknown; candidate_url?: unknown; name_verified?: unknown };
    const pid = typeof c?.provider_id === "string" ? c.provider_id.trim() : "";
    const url = typeof c?.candidate_url === "string" ? c.candidate_url.trim() : "";
    if (!pid || !url) {
      rejected.push({ provider_id: pid || "(missing)", reason: "invalid_item" });
      continue;
    }
    if (seen.has(pid)) {
      rejected.push({ provider_id: pid, reason: "duplicate_in_request" });
      continue;
    }
    seen.add(pid);

    const provider = expDb
      .prepare(`SELECT id, navn, hjemmeside, org_nr, listing_url, content_source FROM experience_providers WHERE id = ?`)
      .get(pid) as
      | { id: string; navn: string; hjemmeside: string | null; org_nr: string | null; listing_url: string | null; content_source: string | null }
      | undefined;
    if (!provider) {
      rejected.push({ provider_id: pid, reason: "not_found" });
      continue;
    }

    // From here on, this is a real provider row — every outcome (survive or
    // reject) is an attributable attempt, so the cursor stamp applies.
    toStamp.push(pid);

    if (c?.name_verified !== true) {
      rejected.push({ provider_id: pid, reason: "name_not_verified" });
      continue;
    }
    if (provider.hjemmeside && provider.hjemmeside.trim() !== "") {
      rejected.push({ provider_id: pid, reason: "already_has_website" });
      continue;
    }
    if (provider.content_source === "manual" || provider.content_source === "claim") {
      rejected.push({ provider_id: pid, reason: "locked_content_source" });
      continue;
    }

    // Not one of the dev-request's own listed rejection reasons — a defensive
    // fallback for a candidate_url so degenerate hostFromUrlLike can't derive
    // a host at all (e.g. "https://"). Deliberately its OWN reason (not
    // "invalid_item", which is reserved for the missing/blank-field
    // structural check above) since this candidate DID name a real,
    // unlocked, name-verified provider — a meaningful, stampable attempt.
    const host = hostFromUrlLike(url);
    if (!host) {
      rejected.push({ provider_id: pid, reason: "invalid_candidate_url" });
      continue;
    }
    if (isDirectoryOrAggregatorHost(host)) {
      rejected.push({ provider_id: pid, reason: "directory_or_aggregator_host" });
      continue;
    }
    if (catalogHosts.has(host) || queuedThisRun.has(host)) {
      rejected.push({ provider_id: pid, reason: "host_already_in_catalog" });
      continue;
    }
    const queuedElsewhereCount = (
      expDb
        .prepare(
          `SELECT COUNT(*) AS n FROM experience_homepage_review_queue
            WHERE status = 'pending' AND provider_id != ? AND candidate_url LIKE ?`
        )
        .get(pid, "%" + host) as { n: number }
    ).n;
    if (queuedElsewhereCount > 0 || queuedThisRun.has(host)) {
      rejected.push({ provider_id: pid, reason: "host_already_queued_elsewhere" });
      continue;
    }

    const ownPendingOrApproved = expDb
      .prepare(
        `SELECT 1 FROM experience_homepage_review_queue WHERE provider_id = ? AND status IN ('pending','approved')`
      )
      .get(pid);
    if (ownPendingOrApproved) {
      rejected.push({ provider_id: pid, reason: "already_queued_for_provider" });
      continue;
    }

    // Survived every guard.
    if (dryRun) {
      wouldQueue.push({ provider_id: pid, navn: provider.navn, candidate_url: url, host });
    } else {
      const evidence = { source: "web_search", host };
      try {
        upsertListingHomepageReviewQueue(expDb, {
          provider_id: pid,
          provider_name: provider.navn,
          candidate_url: url,
          final_url: url,
          evidence: JSON.stringify(evidence),
          confidence: 0.6,
          batch_id: batchTag,
          reason: "web_search_candidate",
        });
        queuedThisRun.add(host);
        queued.push({ provider_id: pid, navn: provider.navn, candidate_url: url, host });
      } catch {
        /* queue write is best-effort; the run itself must not fail on it */
        rejected.push({ provider_id: pid, reason: "queue_write_failed" });
      }
    }
  }

  // Stamping is a DB write, so — same dry-run-is-truly-read-only discipline
  // as legs (a)/(b) above — it only lands in apply mode. A dry-run call is a
  // pure preview: it must leave the cursor exactly where it was so a
  // dry-run-first workflow doesn't accidentally advance rows past the caller
  // before anything is actually queued.
  if (!dryRun && toStamp.length > 0) {
    const stampStmt = expDb.prepare(
      `UPDATE experience_providers SET web_search_homepage_attempted_at = datetime('now') WHERE id = ?`
    );
    for (const id of toStamp) stampStmt.run(id);
  }

  res.json({
    dry_run: dryRun,
    would_queue_count: wouldQueue.length,
    would_queue: wouldQueue,
    queued_count: queued.length,
    queued,
    rejected,
  });
});

// ─── POST /api/opplevelser/admin/gardssalg-address-enrichment (admin) ───────
//
// dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach, slice 3.
// Of the 74 gårdssalg provider profiles, only 42 have a street `adresse`
// filled in — this blocks the "Sted" (location) section of their public
// profile and blocks experiences-geocode-worker.ts (which already geocodes
// any provider that HAS an adresse+postnummer via Kartverket, but does
// nothing when those fields are simply blank). This endpoint fills ONLY the
// missing address TEXT from Brreg (the authoritative Norwegian business
// registry) — it does NOT geocode anything; the existing geocode worker
// picks up newly-filled addresses automatically on its next scheduled tick.
//
// Body: { providerIds?: string[], limit?: number, apply?: boolean }. Same
// dry-run-by-default convention as every other admin route in this file
// (apply=1/"1"/true body, or ?apply=1/?apply=true query). limit defaults to
// (and is hard-capped at) 48 — mirrors GS_CR_HARD_CAP's role, scoped to this
// route's own ceiling (there are only 74 gårdssalg providers total, and only
// a fraction lack org_nr or have a blank adresse).
//
// Target selection: explicit providerIds (de-duplicated, first occurrence
// wins, before the limit slice — a caller-supplied duplicate must not be
// scanned/written twice) via getGardssalgProviderAddressTarget (filtered for
// nulls) OR auto-select via selectGardssalgProvidersForAddressEnrichment.
// Per target: locked (content_source manual/claim) -> skipped_locked, no Brreg
// call. Otherwise calls fetchBrregBusinessAddress(org_nr) — a lightweight
// direct-by-orgnr lookup, not a multi-page crawl, so this uses a plain
// sequential loop (no CR_CONCURRENCY fan-out needed). null / no usable street
// address -> unresolved (reason: "no_brreg_street_address"); a thrown
// exception -> errors. A usable address computes which of adresse/
// postnummer/poststed are currently blank per the target's own row snapshot;
// if that projection is already empty -> unresolved (reason:
// "already_filled"). Otherwise dry-run records the projection without
// writing; apply calls applyGardssalgProviderAddress(), which re-reads the
// row at write time and returns only what it ACTUALLY wrote (may be a subset
// of the projection, e.g. postnummer already filled by a concurrent write
// since the snapshot was taken) -> unresolved (reason:
// "already_filled_at_write_time") if that turns out to be empty too. Every
// `scanned` target lands in exactly one of changed/skipped_locked/
// unresolved/errors — no branch silently drops a target.
//
// NB: MUST come before "/:id" so "admin" isn't swallowed as an id param.

const GS_AE_DEFAULT_LIMIT = 48;
const GS_AE_HARD_CAP = 48; // there are only 74 gårdssalg providers total

router.post("/admin/gardssalg-address-enrichment", requireAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { providerIds?: unknown; limit?: unknown; apply?: unknown };

  // apply: dry-run by default. apply=1/"1"/true (body) or ?apply=1/?apply=true (query).
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  const limit = Math.min(
    typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : GS_AE_DEFAULT_LIMIT,
    GS_AE_HARD_CAP
  );

  // ── Target selection ──────────────────────────────────────────────
  // providerIds is de-duplicated (first occurrence wins) BEFORE the limit
  // slice and BEFORE target resolution: nothing here validates that a
  // caller's providerIds array is duplicate-free, and processing the same
  // id twice in one request served no purpose (the second pass is always
  // either a stale-snapshot re-scan of a row the first pass already wrote,
  // or — pre-existing-fix below — a harmless but pointless already_filled
  // no-op). De-duping up front is strictly more useful than leaving it to
  // fall through the loop: it avoids a redundant Brreg call and a doubled
  // `scanned` count for what is, from the caller's perspective, one target.
  let targets: GardssalgAddressEnrichmentTarget[];
  if (Array.isArray(body.providerIds) && body.providerIds.length > 0) {
    const ids = Array.from(
      new Set(
        (body.providerIds as unknown[])
          .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
          .map((id) => id.trim())
      )
    ).slice(0, limit);
    targets = ids
      .map((id) => getGardssalgProviderAddressTarget(id))
      .filter((t): t is GardssalgAddressEnrichmentTarget => t !== null);
  } else {
    targets = selectGardssalgProvidersForAddressEnrichment(limit);
  }

  let scanned = 0;
  type GsAeProvenanceMap = Record<string, { source_url: string }>;
  const changed: Array<{ provider_id: string; fields: string[]; provenance: GsAeProvenanceMap }> = [];
  const skippedLocked: string[] = [];
  const unresolved: Array<{ provider_id: string; reason: string }> = [];
  const errors: Array<{ provider_id: string; error: string }> = [];

  function isBlank(v: unknown): boolean {
    return v === null || v === undefined || String(v).trim() === "";
  }

  for (const t of targets) {
    const providerId = t.id;

    // LOCK check — from the target's own row snapshot, so a locked provider
    // never triggers a Brreg call at all.
    if (t.content_source === "manual" || t.content_source === "claim") {
      skippedLocked.push(providerId);
      continue;
    }

    let candidate: { adresse: string | null; postnummer: string | null; poststed: string | null } | null;
    try {
      candidate = await fetchBrregBusinessAddress(t.org_nr);
    } catch (e: any) {
      errors.push({ provider_id: providerId, error: e?.message ?? String(e) });
      continue;
    }
    scanned++;

    if (!candidate || !candidate.adresse) {
      unresolved.push({ provider_id: providerId, reason: "no_brreg_street_address" });
      continue;
    }

    const wouldWrite: string[] = [];
    if (isBlank(t.adresse) && candidate.adresse) wouldWrite.push("adresse");
    if (isBlank(t.postnummer) && candidate.postnummer) wouldWrite.push("postnummer");
    if (isBlank(t.poststed) && candidate.poststed) wouldWrite.push("poststed");

    if (wouldWrite.length === 0) {
      // Only reachable via the explicit providerIds override (which
      // deliberately does not pre-filter on blank-address, so an admin can
      // force a lookup on any gårdssalg provider): Brreg returned a usable
      // address, but every target field was already non-blank, so there's
      // nothing left to fill. Route to `unresolved` (not a silent
      // `continue`) so every `scanned` provider lands in exactly one bucket.
      unresolved.push({ provider_id: providerId, reason: "already_filled" });
      continue;
    }

    const evidenceUrl = `${BRREG_BASE_URL}${BRREG_SEARCH_PATH}/${encodeURIComponent(t.org_nr)}`;
    const provenance: GsAeProvenanceMap = {};
    for (const f of wouldWrite) provenance[f] = { source_url: evidenceUrl };

    if (dryRun) {
      changed.push({ provider_id: providerId, fields: wouldWrite, provenance });
    } else {
      try {
        const written = applyGardssalgProviderAddress(providerId, candidate, evidenceUrl);
        if (written.length > 0) {
          changed.push({ provider_id: providerId, fields: written, provenance });
        } else {
          // applyGardssalgProviderAddress does its own fresh DB read at
          // write time, which can find every target field already
          // non-blank even though this loop's earlier (pre-await, and for
          // providerIds, pre-loop) `t`/`wouldWrite` snapshot said otherwise
          // — e.g. a concurrent request wrote this same row in between (no
          // row lock is held across this loop). De-duping providerIds
          // above closes the same-request-duplicate trigger, but this
          // fresh-read result can still legitimately be empty via that
          // race, so it's handled here too rather than assumed unreachable.
          // Route to `unresolved`, not a silent fall-through, so every
          // `scanned` provider still lands in exactly one bucket — same
          // invariant the wouldWrite.length === 0 branch above enforces at
          // the pre-write check.
          unresolved.push({ provider_id: providerId, reason: "already_filled_at_write_time" });
        }
      } catch (e: any) {
        errors.push({ provider_id: providerId, error: `write_failed: ${e?.message ?? String(e)}` });
      }
    }
  }

  res.json({
    dry_run: dryRun,
    scanned,
    agents_enriched: changed.length,
    changed,
    skipped_locked: skippedLocked,
    unresolved,
    errors,
  });
});

// ─── POST /api/opplevelser/admin/booking-test-send (admin) ─────────────────
// ─── POST /api/opplevelser/admin/claim-test-send   (admin) ─────────────────
//
// dev-request 2026-07-26-booking-test-send-guard.
//
// The ONLY two call sites in the codebase that can set the per-transaction
// test flag. Both are behind requireAdmin (X-Admin-Key). The public booking
// entry points — POST /api/opplevelser/book and the book_gardssalg MCP tool —
// both parse their payload with BookingInputSchema, which has no such field
// and (being zod) strips unknown keys, so there is no field name a public
// caller could smuggle to reach `createBooking`'s third argument. Likewise the
// public claim route calls issueClaimMagicLink() with one argument.
//
// Both routes check the redirect address BEFORE creating anything, so an
// unconfigured TEST_SEND_REDIRECT_EMAIL produces a clear 400 and no DB row at
// all — rather than a row whose emails then silently fail closed downstream.
// (The downstream fail-closed in email-service.ts still stands; this is the
// belt to its braces, and gives the operator an actionable error.)
//
// These exist to run acceptance criterion 6 on two OTHER dev-requests:
// 2026-07-21-opplevagent-mcp-booking-verktoy (MCP booking E2E) and
// 2026-07-21-opplevagent-claim-flyt-drikkeprodusenter (claim E2E).
//
// NB: MUST come before "/:id" so "admin" isn't swallowed as an id param.

router.post("/admin/booking-test-send", requireAdmin, async (req: Request, res: Response) => {
  const redirect = testSendRedirectAddress();
  if (!redirect) {
    return res.status(400).json({
      success: false,
      error: "test_send_redirect_not_configured",
      message:
        "TEST_SEND_REDIRECT_EMAIL is not configured. Refusing to create a test booking " +
        "rather than risk a send to a real recipient.",
    });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const source = typeof body.source === "string" && body.source.trim() !== "" ? body.source.trim() : "mcp";

  const parsed = BookingInputSchema.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: "invalid_input",
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    });
  }

  // Same gate as the public path — a test must not bypass booking_live /
  // BOOKING_DISPATCH_ENABLED, or it would not be testing the real flow.
  const provider = getProviderById(parsed.data.provider_id) as
    | { booking_live?: number | null; epost?: string | null; catalog_hidden?: number | null }
    | null;
  if (isBookingPaused(provider?.booking_live ?? null, provider?.catalog_hidden ?? null)) {
    return res.status(409).json({ success: false, error: "not_live", provider_id: parsed.data.provider_id });
  }

  let booking;
  try {
    booking = createBooking(parsed.data, source, { isTest: true });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: "create_failed", message: e?.message ?? String(e) });
  }

  // AWAITED here (unlike the fire-and-forget public path) so the operator gets
  // the actual send outcome back in the response — that IS the test result.
  const sends: Array<{ kind: string; ok: boolean; error?: string }> = [];
  try {
    await sendBookingConfirmation(booking);
    sends.push({ kind: "guest_confirmation", ok: true });
  } catch (e: any) {
    sends.push({ kind: "guest_confirmation", ok: false, error: e?.message ?? String(e) });
  }
  try {
    await sendProducerNotification(booking, provider?.epost ?? null);
    sends.push({ kind: "producer_notification", ok: true });
  } catch (e: any) {
    sends.push({ kind: "producer_notification", ok: false, error: e?.message ?? String(e) });
  }

  res.json({
    success: true,
    test_mode: true,
    redirected_to: redirect,
    booking_ref: booking.booking_ref,
    booking_id: booking.booking_id,
    source: booking.source,
    is_test: booking.is_test,
    intended_recipients: {
      guest: booking.guest_email,
      producer: provider?.epost ?? null,
    },
    sends,
  });
});

router.post("/admin/claim-test-send", requireAdmin, (req: Request, res: Response) => {
  const redirect = testSendRedirectAddress();
  if (!redirect) {
    return res.status(400).json({
      success: false,
      error: "test_send_redirect_not_configured",
      message:
        "TEST_SEND_REDIRECT_EMAIL is not configured. Refusing to issue a test claim link " +
        "rather than risk a send to a real recipient.",
    });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const providerId = typeof body.provider_id === "string" ? body.provider_id.trim() : "";
  if (!providerId) {
    return res.status(400).json({ success: false, error: "provider_id_required" });
  }

  const result = issueClaimMagicLink(providerId, null, { isTest: true });
  if (!result.ok) {
    return res.status(result.error === "provider_not_found" ? 404 : result.error === "rate_limited" ? 429 : 403).json({
      success: false,
      error: result.error,
    });
  }

  const verifyUrl = `${OPPLEVAGENT_CLAIM_BASE_URL}/kategori/gardssalg/eier/magic-link-verify?token=${result.claim.token}`;
  const provider = getClaimProviderById(providerId);

  emailService
    .sendGardssalgClaimMagicLink({
      to: result.claim.email,
      providerName: provider?.navn || "din profil",
      verifyUrl,
      isTestSend: result.claim.isTest,
    })
    .then((r) => {
      if (!r.success) console.error(`[claim-test-send] send failed for ${providerId}: ${r.error}`);
    })
    .catch((e) => console.error("[claim-test-send] send error:", e));

  res.json({
    success: true,
    test_mode: true,
    redirected_to: redirect,
    claim_id: result.claim.claimId,
    is_test: result.claim.isTest,
    intended_recipient: result.claim.email,
    intended_recipient_masked: result.claim.maskedEmail,
    email_source: result.claim.source,
    expires_at: result.claim.expiresAt,
  });
});

// ─── POST /api/opplevelser/admin/gardssalg-contact-backfill (admin) ─────────
//
// dev-request 2026-07-26-brreg-kontakt-backfill.
//
// The outreach-readiness report found 344 of 389 gårdssalg providers with
// NEITHER epost NOR telefon on file — un-contactable and un-claimable at the
// same time, i.e. dead rows. Brreg's GET /enheter/{orgNr} response carries the
// entity's own registered `epostadresse`/`telefon`/`mobil`, which no code in
// this repo read until fetchBrregContact() (brreg-client.ts). Measured over
// the full live cohort 2026-07-27: 101 of 333 (30.3 %) have a contact channel
// there.
//
// Write discipline is deliberately identical to the address-enrichment route
// above and NOT loosened: dry-run by default, admin-gated, fill-only (an
// existing value is never replaced), manual/claim-locked rows skipped and
// reported, one audit row + field_provenance entry per written field, fully
// reversible through the existing content-rollback lever.
//
// `hjemmeside` is reported but NEVER written here. Brreg's hjemmeside is
// self-reported and therefore strong evidence, but website adoption already
// has an evidence-checked path (gardssalg_website_review_queue + the approve
// lever), and this route feeds that queue rather than bypassing it.
//
// Body: { providerIds?: string[], limit?: number, offset?: number,
//         apply?: boolean }. `offset` exists because the cohort (~333) is
// larger than one call's hard cap — the selector's ORDER BY is a total order
// so paging is stable. Response carries `cohort_total` so the caller knows
// how far the walk has left to go.
//
// NB: MUST come before "/:id" so "admin" isn't swallowed as an id param.

// ─── POST /api/opplevelser/admin/gardssalg-contact-extraction (admin) ───────
//
// Daniels GO 2026-07-30: «Kjør kontakt-utvinning fra de nye hjemmesidene.»
//
// The Brreg contact source is exhausted (measured: fill-only refusals across
// the whole cohort), but website-discovery v2 just gave the drink cohort real
// homepages — and the contact info lives on THEM. Per target: fetch the
// front page, prefer its kontakt/om-oss subpages (gardssalgContactPageLinks —
// same helper the v2 evidence crawl uses), extract epost + telefon with the
// provenance rules in extractGardssalgContact{Email,Phone} (mailto first,
// same-domain text next, freemail only on contact-ish pages; phone only with
// a tlf-cue or on a contact-ish page). The WRITE is the existing
// applyGardssalgProviderContact — fill-only, manual/claim-lås respected,
// audit + field_provenance per field, rollbackable via the standard lever —
// with the URL the value was actually found on as evidence.
//
// Dry-run by default; offset paging over a stable total order (same idiom as
// gardssalg-contact-backfill); cohort_total in the response so the caller
// knows how far the walk has left.
//
// NB: MUST come before "/:id" so "admin" isn't swallowed as an id param.
// Herding (dev-request 2026-07-30-kontakt-utvinning-kjorelaas-og-pacing —
// leveren hang prod to ganger 30.07):
//   1. Kjørelås: Express avbryter ikke en handler når klienten kobler fra, så
//      timede-ut apply-kall STABLET seg og mettet event-loopen. Ett kall om
//      gangen; nummer to får 409 umiddelbart.
//   2. Default-limit 24 → 8 + 250ms pause mellom rader (yield til event-loopen
//      så /health alltid får svare).
//   3. Klient-frakobling sjekkes mellom rader — en forlatt kjøring avbrytes i
//      stedet for å fullføre i det stille (det var de forlatte kjøringene som
//      stablet seg).
const GS_CX_DEFAULT_LIMIT = 8;
const GS_CX_ROW_DELAY_MS = 250;
let gsCxRunning = false;
// Testene setter radpausen til 0 (fortsatt en ekte setTimeout-yield, bare uten
// ventetid) — test-harnesset er timing-sensitivt (se tests/test.ts-headeren om
// runSerial-kjeden), så sekunder med kunstig pause i én suite forskyver
// urelaterte suiter inn i kjente races. Prod beholder 250ms.
let gsCxRowDelayMs = GS_CX_ROW_DELAY_MS;
export function __setGsCxRowDelayForTesting(ms: number | null): void {
  gsCxRowDelayMs = ms ?? GS_CX_ROW_DELAY_MS;
}

router.post("/admin/gardssalg-contact-extraction", requireAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { limit?: unknown; offset?: unknown; apply?: unknown };
  const apply =
    body.apply === true || body.apply === 1 || body.apply === "1" || body.apply === "true" ||
    req.query?.apply === "1" || req.query?.apply === "true";
  const dryRun = !apply;
  const limit =
    typeof body.limit === "number" && body.limit > 0 ? Math.min(Math.floor(body.limit), 48) : GS_CX_DEFAULT_LIMIT;
  const offset = typeof body.offset === "number" && body.offset >= 0 ? Math.floor(body.offset) : 0;

  // Kjørelås — sjekket og satt FØR noe arbeid. finally-blokken under er eneste
  // som slipper den, så en kastet feil aldri etterlater låsen hengende.
  if (gsCxRunning) {
    res.status(409).json({ error: "run_in_progress", detail: "en contact-extraction-kjøring pågår allerede — vent til den er ferdig" });
    return;
  }
  gsCxRunning = true;
  try {
  const batchId = `contact-extraction-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;

  const { targets, cohortTotal } = selectGardssalgProvidersForContactExtraction(limit, offset);

  const changed: Array<{ provider_id: string; navn: string; fields: string[]; epost: string | null; telefon: string | null; source_url: string; email_source?: string; phone_cued?: boolean }> = [];
  const noContactFound: Array<{ provider_id: string; navn: string; pages_tried: number }> = [];
  const fetchFailed: Array<{ provider_id: string; navn: string }> = [];
  const errors: Array<{ provider_id: string; error: string }> = [];

  let clientDisconnected = false;
  for (const t of targets) {
    // 3: en forlatt kjøring (klient timet ut / koblet fra) skal ikke fullføre
    // i det stille — det var nøyaktig slik kjøringene stablet seg 30.07.
    if ((req as any).aborted === true || res.writableEnded || (res as any).destroyed === true) {
      clientDisconnected = true;
      break;
    }
    // 2: yield til event-loopen mellom rader så helsesjekk/øvrig trafikk
    // alltid får svare under en kjøring.
    await new Promise((r) => setTimeout(r, gsCxRowDelayMs));
    try {
      const front = await wdFetchPage(t.hjemmeside);
      if (!front) {
        fetchFailed.push({ provider_id: t.id, navn: t.navn });
        continue;
      }
      const host = hostFromUrlLike(front.finalUrl) || hostFromUrlLike(t.hjemmeside) || "";
      const homeDomain = homepageRegistrableDomain(t.hjemmeside);
      // Contact-ish subpages FIRST (that's where the info is authoritative),
      // front page as fallback.
      const pages: Array<{ url: string; html: string; contactish: boolean }> = [];
      for (const sub of gardssalgContactPageLinks(front.html, host, 2)) {
        const p = await wdFetchPage(sub);
        if (p) pages.push({ url: p.finalUrl, html: p.html, contactish: true });
      }
      pages.push({ url: front.finalUrl, html: front.html, contactish: false });

      const needEmail = !t.epost || t.epost.trim() === "";
      const needPhone = !t.telefon || t.telefon.trim() === "";
      let email: ReturnType<typeof extractGardssalgContactEmail> = null;
      let emailUrl = "";
      let phone: ReturnType<typeof extractGardssalgContactPhone> = null;
      let phoneUrl = "";
      for (const pg of pages) {
        if (needEmail && !email) {
          email = extractGardssalgContactEmail(pg.html, homeDomain, pg.contactish);
          if (email) emailUrl = pg.url;
        }
        if (needPhone && !phone) {
          phone = extractGardssalgContactPhone(pg.html, pg.contactish);
          if (phone) phoneUrl = pg.url;
        }
        if ((!needEmail || email) && (!needPhone || phone)) break;
      }

      if (!email && !phone) {
        noContactFound.push({ provider_id: t.id, navn: t.navn, pages_tried: pages.length });
        continue;
      }

      const evidenceUrl = emailUrl || phoneUrl;
      const fields = [...(email ? ["epost"] : []), ...(phone ? ["telefon"] : [])];
      if (dryRun) {
        changed.push({
          provider_id: t.id, navn: t.navn, fields,
          epost: email?.email ?? null, telefon: phone?.phone ?? null,
          source_url: evidenceUrl, email_source: email?.source, phone_cued: phone?.cued,
        });
      } else {
        const written = applyGardssalgProviderContact(
          t.id,
          { epost: email?.email ?? null, telefon: phone?.phone ?? null },
          evidenceUrl,
          batchId,
        );
        if (written.length > 0) {
          changed.push({
            provider_id: t.id, navn: t.navn, fields: written,
            epost: email?.email ?? null, telefon: phone?.phone ?? null,
            source_url: evidenceUrl, email_source: email?.source, phone_cued: phone?.cued,
          });
        }
      }
    } catch (e: any) {
      errors.push({ provider_id: t.id, error: e?.message ?? String(e) });
    }
  }

  res.json({
    dry_run: dryRun,
    batch_id: batchId,
    cohort_total: cohortTotal,
    offset,
    scanned: targets.length,
    providers_enriched: changed.length,
    aborted_client_disconnect: clientDisconnected,
    changed,
    no_contact_found: noContactFound,
    fetch_failed: fetchFailed,
    errors,
  });
  } finally {
    gsCxRunning = false;
  }
});

const GS_CB_DEFAULT_LIMIT = 48;

router.post("/admin/gardssalg-contact-backfill", requireAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    providerIds?: unknown;
    limit?: unknown;
    offset?: unknown;
    apply?: unknown;
  };

  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  const limit = Math.min(
    typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : GS_CB_DEFAULT_LIMIT,
    GS_CB_HARD_CAP
  );
  const offset =
    typeof body.offset === "number" && body.offset > 0 ? Math.floor(body.offset) : 0;

  let targets: GardssalgContactBackfillTarget[];
  if (Array.isArray(body.providerIds) && body.providerIds.length > 0) {
    const ids = Array.from(
      new Set(
        (body.providerIds as unknown[])
          .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
          .map((id) => id.trim())
      )
    ).slice(0, limit);
    targets = ids
      .map((id) => getGardssalgProviderContactTarget(id))
      .filter((t): t is GardssalgContactBackfillTarget => t !== null);
  } else {
    targets = selectGardssalgProvidersForContactBackfill(limit, offset);
  }

  const batchId = `contact-backfill-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`;

  let scanned = 0;
  let brregHitEpost = 0;
  let brregHitTelefon = 0;
  let brregHitAny = 0;
  const changed: Array<{
    provider_id: string;
    fields: string[];
    epost: string | null;
    telefon: string | null;
    source_url: string;
  }> = [];
  const websiteCandidates: Array<{ provider_id: string; candidate_url: string }> = [];
  const skippedLocked: string[] = [];
  const unresolved: Array<{ provider_id: string; reason: string }> = [];
  const errors: Array<{ provider_id: string; error: string }> = [];

  for (const t of targets) {
    const providerId = t.id;

    if (t.content_source === "manual" || t.content_source === "claim") {
      skippedLocked.push(providerId);
      continue;
    }

    const epostBlank = !t.epost || t.epost.trim() === "";
    const telefonBlank = !t.telefon || t.telefon.trim() === "";
    const hjemmesideBlank = !t.hjemmeside || t.hjemmeside.trim() === "";
    if (!epostBlank && !telefonBlank && !hjemmesideBlank) {
      // Only reachable via the explicit providerIds override — nothing this
      // route could contribute.
      unresolved.push({ provider_id: providerId, reason: "already_filled" });
      continue;
    }

    let contact: Awaited<ReturnType<typeof fetchBrregContact>>;
    try {
      contact = await fetchBrregContact(t.org_nr);
    } catch (e: any) {
      // fetchBrregContact is documented never-throws; this catch exists so a
      // contract violation degrades one row instead of the whole batch.
      errors.push({ provider_id: providerId, error: e?.message ?? String(e) });
      continue;
    }
    scanned++;

    if (!contact) {
      unresolved.push({ provider_id: providerId, reason: "brreg_lookup_failed_or_404" });
      continue;
    }
    if (contact.epost) brregHitEpost++;
    if (contact.telefon) brregHitTelefon++;
    if (contact.epost || contact.telefon) brregHitAny++;

    // ── hjemmeside: queued for review, never written from here ──
    if (hjemmesideBlank && contact.hjemmeside) {
      websiteCandidates.push({ provider_id: providerId, candidate_url: contact.hjemmeside });
      if (!dryRun) {
        try {
          upsertGardssalgWebsiteReviewQueue({
            provider_id: providerId,
            provider_name: t.navn,
            candidate_url: contact.hjemmeside,
            evidence: `brreg_hjemmeside:${t.org_nr}`,
            reason: "brreg_registered_hjemmeside",
            batch_id: batchId,
          });
        } catch (e: any) {
          errors.push({ provider_id: providerId, error: `queue_failed: ${e?.message ?? String(e)}` });
        }
      }
    }

    // ── epost/telefon: fill-only write ──
    const wouldWriteEpost = epostBlank && !!contact.epost;
    const wouldWriteTelefon = telefonBlank && !!contact.telefon;
    if (!wouldWriteEpost && !wouldWriteTelefon) {
      if (!(hjemmesideBlank && contact.hjemmeside)) {
        unresolved.push({ provider_id: providerId, reason: "no_brreg_contact" });
      }
      continue;
    }

    const evidenceUrl = `${BRREG_BASE_URL}${BRREG_SEARCH_PATH}/${encodeURIComponent(t.org_nr)}`;

    if (dryRun) {
      changed.push({
        provider_id: providerId,
        fields: [...(wouldWriteEpost ? ["epost"] : []), ...(wouldWriteTelefon ? ["telefon"] : [])],
        epost: wouldWriteEpost ? contact.epost : null,
        telefon: wouldWriteTelefon ? contact.telefon : null,
        source_url: evidenceUrl,
      });
    } else {
      try {
        const written = applyGardssalgProviderContact(
          providerId,
          { epost: contact.epost, telefon: contact.telefon },
          evidenceUrl,
          batchId
        );
        if (written.length > 0) {
          changed.push({
            provider_id: providerId,
            fields: written,
            epost: written.includes("epost") ? contact.epost : null,
            telefon: written.includes("telefon") ? contact.telefon : null,
            source_url: evidenceUrl,
          });
        } else {
          // Fresh-read-at-write-time found the fields already non-blank or the
          // provider now locked — same race class the sibling routes document.
          unresolved.push({ provider_id: providerId, reason: "already_filled_or_locked_at_write_time" });
        }
      } catch (e: any) {
        errors.push({ provider_id: providerId, error: `write_failed: ${e?.message ?? String(e)}` });
      }
    }
  }

  res.json({
    dry_run: dryRun,
    batch_id: batchId,
    cohort_total: countGardssalgProvidersForContactBackfill(),
    offset,
    limit,
    scanned,
    brreg_hits: { epost: brregHitEpost, telefon: brregHitTelefon, any: brregHitAny },
    providers_enriched: changed.length,
    changed,
    website_candidates: websiteCandidates,
    skipped_locked: skippedLocked,
    unresolved,
    errors,
  });
});

// ─── POST /api/opplevelser/admin/gardssalg-producer-type-classify (admin) ───
//
// Steg C — producer_type is currently set ONLY manually or via the 4-entry
// GARDSSALG_NACE_PRODUCER_TYPE map keyed off naeringskode (NACE code) inside
// POST /admin/gardssalg-nace-discovery above. Legacy rfb_seed_source='rfb-seed'
// rows with no naeringskode have no signal that map-based path can use — this
// endpoint backfills producer_type for exactly that cohort using an LLM judge
// over navn + about_text/visit_text, restricted to the SAME closed vocabulary
// already in use (DRINK_PRODUCER_TYPES ∪ NON_DRINK_PRODUCER_TYPES,
// route-corridor-service.ts) plus an explicit "uklassifisert" (cannot tell)
// escape hatch — never inventing a new category, never guessing when unsure.
//
// Non-goals: no change to GARDSSALG_NACE_PRODUCER_TYPE or the NACE-discovery
// path; no overwrite of any row that already has producer_type set (fill-only,
// same discipline as applyGardssalgProviderContact above); no change to
// DRINK_PRODUCER_TYPES/NON_DRINK_PRODUCER_TYPES membership.
//
// Request/response shape mirrors gardssalg-contact-backfill above exactly:
// { providerIds?, limit?, offset?, apply? } in, apply falsy/absent -> dry-run
// (report only, zero writes). providerIds, when given, BYPASSES the selector's
// WHERE clause entirely (existence-only lookup) — mirrors how
// getGardssalgProviderContactTarget resolves locked/already-filled rows too,
// so an admin can force a classification the auto-selector wouldn't surface
// (e.g. a row that already has naeringskode, which the default selector
// deliberately excludes since it belongs to the NACE-map path instead).
import { NON_DRINK_PRODUCER_TYPES } from "../services/route-corridor-service";

interface GardssalgProducerTypeCandidate {
  id: string;
  navn: string;
  about_text: string | null;
  visit_text: string | null;
  content_source: string | null;
  field_provenance: string | null;
  producer_type?: string | null;
}

const GS_PTC_DEFAULT_LIMIT = 48;
const GS_PTC_HARD_CAP = 100;
const GS_PTC_TEXT_CHAR_CAP = 4000;
const GARDSSALG_PRODUCER_TYPE_UKLASSIFISERT = "uklassifisert";
// DRINK_PRODUCER_TYPES is already imported module-level above (used by the
// verified-drinkproducer-cohort route) — imports hoist, so it's in scope here
// too; importing it a second time would be a duplicate-identifier error.
const GARDSSALG_PRODUCER_TYPE_VOCAB: Set<string> = new Set<string>([
  ...Array.from(DRINK_PRODUCER_TYPES),
  ...Array.from(NON_DRINK_PRODUCER_TYPES),
]);

/**
 * judgeGardssalgProducerType — mirrors judgeGardssalgAboutCandidate's EXACT
 * fail-closed contract (below, ~line 9049): direct fetch to
 * https://api.anthropic.com/v1/messages, ANTHROPIC_API_KEY from env, model
 * claude-haiku-4-5. ANY doubt or failure — missing key, network failure,
 * non-200, unparseable JSON, a response that isn't an EXACT vocabulary token
 * or the literal "uklassifisert" escape hatch — resolves to `type: null`.
 * Never throws, never fabricates a category, never guesses. The literal
 * "uklassifisert" response is a valid, non-ambiguous parse (the judge
 * genuinely could not tell) but STILL yields `type: null` — there is nothing
 * to apply either way; `raw` carries the model's raw text so callers/tests
 * can tell the two null cases apart if they need to.
 */
async function judgeGardssalgProducerType(
  navn: string,
  aboutText: string | null,
  visitText: string | null
): Promise<{ type: string | null; raw: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { type: null, raw: "ANTHROPIC_API_KEY mangler — avvist fail-closed" };
  }

  const vocabList = Array.from(GARDSSALG_PRODUCER_TYPE_VOCAB).sort().join(", ");
  const cappedAbout = (aboutText || "").slice(0, GS_PTC_TEXT_CHAR_CAP);
  const cappedVisit = (visitText || "").slice(0, GS_PTC_TEXT_CHAR_CAP);
  const prompt = `Du er en klassifiserer som skal bestemme produsenttype for en norsk gårdssalg-produsent, basert KUN på teksten under.

Produsentnavn: ${navn}

Om produsenten:
${cappedAbout || "(ingen tekst)"}

Besøket hos produsenten:
${cappedVisit || "(ingen tekst)"}

Svar med EKSAKT ett av disse ordene alene på første linje, uten annen tekst på linjen:
${vocabList}

Hvis du ikke kan avgjøre produsenttypen ut fra teksten over, svar i stedet med det eksakte ordet:
${GARDSSALG_PRODUCER_TYPE_UKLASSIFISERT}

Ved minste tvil, svar ${GARDSSALG_PRODUCER_TYPE_UKLASSIFISERT}. Finn ALDRI på en ny kategori som ikke står i listen.`;

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 50,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    return { type: null, raw: "nettverksfeil under klassifiserer-kall — avvist fail-closed" }; // never fabricate
  }

  if (!response.ok) {
    return { type: null, raw: `klassifiserer-API svarte status ${response.status} — avvist fail-closed` };
  }

  let result: any;
  try {
    result = await response.json();
  } catch {
    return { type: null, raw: "ikke-parsbar JSON fra klassifiserer-API — avvist fail-closed" };
  }

  const contentArr = Array.isArray(result?.content) ? result.content : [];
  const text = contentArr.find((c: any) => c?.type === "text")?.text;
  if (typeof text !== "string") {
    return { type: null, raw: "uventet svarformat fra klassifiserer-API — avvist fail-closed" };
  }

  const firstLine = (text.trim().split(/\r?\n/)[0] || "").trim();

  // Only an EXACT vocabulary token applies a value. A token that merely
  // CONTAINS a vocabulary word inside a longer sentence, garbage, or an
  // invented category is a reject — fail-closed on any ambiguity.
  if (GARDSSALG_PRODUCER_TYPE_VOCAB.has(firstLine)) {
    return { type: firstLine, raw: text };
  }
  return { type: null, raw: text || "uventet/tvetydig klassifiserer-svar — avvist fail-closed" };
}

/**
 * Apply a judged producer_type to ONE gårdssalg provider. Same discipline as
 * applyGardssalgProviderContact above: fresh read (never trusts the caller's
 * stale row), NEVER writes if the provider is locked ('manual'/'claim'),
 * FILL-ONLY via a transactional `WHERE producer_type IS NULL` guard (belt AND
 * suspenders alongside the pre-check), one gardssalg_content_audit row,
 * {source: "llm_classification", classified_at} merged into field_provenance
 * (read-modify-write — every other existing key survives untouched). All in
 * one transaction, mirroring applyGardssalgProviderContact's transaction shape
 * (experience-store.ts) rather than hand-rolling a new one. Returns whether
 * the write actually happened.
 */
function applyGardssalgProducerType(providerId: string, judgedType: string, batchId: string): boolean {
  const expDb = getExpDb("experiences");
  const row = expDb
    .prepare(`SELECT id, content_source, producer_type, field_provenance FROM experience_providers WHERE id = ?`)
    .get(providerId) as
    | { id: string; content_source: string | null; producer_type: string | null; field_provenance: string | null }
    | undefined;
  if (!row) return false;
  if (row.content_source === "manual" || row.content_source === "claim") return false;
  if (row.producer_type !== null && row.producer_type !== undefined && String(row.producer_type).trim() !== "") {
    return false;
  }

  // ── field_provenance merge (read-modify-write, preserves other keys) ──
  let provenance: Record<string, unknown> = {};
  if (row.field_provenance) {
    try {
      const parsed = JSON.parse(row.field_provenance);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        provenance = parsed as Record<string, unknown>;
      }
    } catch {
      /* malformed existing JSON -> treat as empty rather than clobber the write */
    }
  }
  provenance.producer_type = { source: "llm_classification", classified_at: new Date().toISOString() };

  const applyWithAudit = expDb.transaction(() => {
    const result = expDb
      .prepare(
        `UPDATE experience_providers
            SET producer_type = @producer_type, field_provenance = @field_provenance, updated_at = datetime('now')
          WHERE id = @id AND producer_type IS NULL`
      )
      .run({ id: providerId, producer_type: judgedType, field_provenance: JSON.stringify(provenance) });
    if (result.changes === 0) {
      // Fresh-read-at-write-time race: the pre-check above passed but the row
      // was locked/filled between the pre-check and this transaction. Nothing
      // was written, so nothing to audit either.
      return false;
    }
    expDb
      .prepare(
        `INSERT INTO gardssalg_content_audit
           (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
         VALUES (@id, @provider_id, @field_name, @old_value, @new_value, @source_url, @batch_id, 'system', datetime('now'))`
      )
      .run({
        id: crypto.randomUUID(),
        provider_id: providerId,
        field_name: "producer_type",
        old_value: null,
        new_value: judgedType,
        source_url: null,
        batch_id: batchId ?? null,
      });
    return true;
  });
  return applyWithAudit();
}

router.post("/admin/gardssalg-producer-type-classify", requireAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    providerIds?: unknown;
    limit?: unknown;
    offset?: unknown;
    apply?: unknown;
  };

  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  const limit = Math.min(
    typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : GS_PTC_DEFAULT_LIMIT,
    GS_PTC_HARD_CAP
  );
  const offset = typeof body.offset === "number" && body.offset > 0 ? Math.floor(body.offset) : 0;

  const expDb = getExpDb("experiences");

  let targets: GardssalgProducerTypeCandidate[];
  if (Array.isArray(body.providerIds) && body.providerIds.length > 0) {
    // Explicit ids bypass the selector's WHERE clause entirely (existence-only
    // lookup) — mirrors gardssalg-contact-backfill's providerIds override.
    const ids = Array.from(
      new Set(
        (body.providerIds as unknown[])
          .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
          .map((id) => id.trim())
      )
    ).slice(0, limit);
    const stmt = expDb.prepare(
      `SELECT id, navn, about_text, visit_text, content_source, field_provenance, producer_type
         FROM experience_providers WHERE id = ?`
    );
    targets = ids
      .map((id) => stmt.get(id) as GardssalgProducerTypeCandidate | undefined)
      .filter((t): t is GardssalgProducerTypeCandidate => t !== undefined);
  } else {
    targets = expDb
      .prepare(
        `SELECT id, navn, about_text, visit_text, content_source, field_provenance
           FROM experience_providers
          WHERE rfb_seed_source = 'rfb-seed'
            AND producer_type IS NULL
            AND (naeringskode IS NULL OR naeringskode = '')
          ORDER BY created_at ASC, id ASC
          LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as GardssalgProducerTypeCandidate[];
  }

  const batchId = `producer-type-classify-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`;

  let classified = 0;
  let unclassified = 0;
  let skippedLocked = 0;
  let skippedNotBlank = 0;
  const results: Array<{ id: string; navn: string; judged_type: string | null; applied: boolean }> = [];

  for (const row of targets) {
    if (row.content_source === "manual" || row.content_source === "claim") {
      skippedLocked++;
      results.push({ id: row.id, navn: row.navn, judged_type: null, applied: false });
      continue;
    }
    if (typeof row.producer_type === "string" && row.producer_type.trim() !== "") {
      skippedNotBlank++;
      results.push({ id: row.id, navn: row.navn, judged_type: null, applied: false });
      continue;
    }

    const verdict = await judgeGardssalgProducerType(row.navn, row.about_text, row.visit_text);
    if (verdict.type === null) {
      unclassified++;
      results.push({ id: row.id, navn: row.navn, judged_type: null, applied: false });
      continue;
    }

    classified++;
    let applied = false;
    if (apply) {
      applied = applyGardssalgProducerType(row.id, verdict.type, batchId);
    }
    results.push({ id: row.id, navn: row.navn, judged_type: verdict.type, applied });
  }

  res.json({
    success: true,
    dryRun,
    summary: {
      candidates: targets.length,
      classified,
      unclassified,
      skippedLocked,
      skippedNotBlank,
    },
    results,
  });
});

// ─── POST /api/opplevelser/admin/gardssalg-orgnr-backfill (admin) ───────────
//
// dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach, slice 5b.
// Slice 4's batch report found 0/74 gårdssalg providers have org_nr set,
// which starves slice 3's Brreg address-enrichment (a direct-by-orgnr
// lookup) of the key it needs — this endpoint backfills org_nr itself, using
// Brreg's name-search (findOrgnumberByName, brreg-client.ts) as a CANDIDATE
// GENERATOR ONLY. Per Daniel's binding identitetskrav (slice 4-GO, ordrett:
// "vær sikker på at man ikke krysser ulike agenter med data" / "ved tvil:
// ikke skriv"), a candidate is auto-written ONLY when Brreg's own confidence
// is the exact-match tier (1.0) AND this route's own independent postal
// corroboration (gardssalgOrgnrAutoWriteEligible, experience-store.ts) also
// agrees — see that function's doc comment for the exact gate. Every other
// outcome (no Brreg candidate, sub-1.0 confidence, or a corroboration
// mismatch/no-signal) is NEVER auto-written: it's upserted into
// gardssalg_orgnr_review_queue for a human to resolve, and bucketed
// `unresolved` in this response (reason "needs_human_review" or
// "no_brreg_candidate").
//
// Body: { providerIds?: string[], limit?: number, apply?: boolean }. Same
// dry-run-by-default convention, providerIds de-dup-before-limit, and
// hard-cap-at-48 convention as every other gårdssalg admin route in this
// file (mirrors GS_AE_DEFAULT_LIMIT/GS_AE_HARD_CAP's role above).
//
// NB: MUST come before "/:id" so "admin" isn't swallowed as an id param.

const GS_OB_DEFAULT_LIMIT = 48;
const GS_OB_HARD_CAP = 48; // there are only 74 gårdssalg providers total

router.post("/admin/gardssalg-orgnr-backfill", requireAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { providerIds?: unknown; limit?: unknown; apply?: unknown };

  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  const limit = Math.min(
    typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : GS_OB_DEFAULT_LIMIT,
    GS_OB_HARD_CAP
  );

  let targets: GardssalgOrgnrBackfillTarget[];
  if (Array.isArray(body.providerIds) && body.providerIds.length > 0) {
    const ids = Array.from(
      new Set(
        (body.providerIds as unknown[])
          .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
          .map((id) => id.trim())
      )
    ).slice(0, limit);
    targets = ids
      .map((id) => getGardssalgProviderOrgnrTarget(id))
      .filter((t): t is GardssalgOrgnrBackfillTarget => t !== null);
  } else {
    targets = selectGardssalgProvidersForOrgnrBackfill(limit);
  }

  let scanned = 0;
  const changed: Array<{ provider_id: string; org_nr: string; source_url: string }> = [];
  const skippedLocked: string[] = [];
  const unresolved: Array<{ provider_id: string; reason: string }> = [];
  const errors: Array<{ provider_id: string; error: string }> = [];

  for (const t of targets) {
    const providerId = t.id;

    if (t.content_source === "manual" || t.content_source === "claim") {
      skippedLocked.push(providerId);
      continue;
    }

    if (t.org_nr && t.org_nr.trim() !== "") {
      // Only reachable via the explicit providerIds override (the auto-
      // selector already filters blank-org_nr) — nothing to backfill.
      unresolved.push({ provider_id: providerId, reason: "already_filled" });
      continue;
    }

    // Integration hardening (2026-07-19 review): search with the catalog's
    // display suffix ("— Sted") stripped — an exact company-name match must
    // not be demoted to the 0.8x tier by our own display convention. When
    // stripping actually changed the name, the write bar is tightened below.
    const searchName = gardssalgSearchName(t.navn);
    const nameWasStripped = searchName !== t.navn.replace(/\s+/g, " ").trim();

    let hit: Awaited<ReturnType<typeof findOrgnumberByName>>;
    try {
      hit = await findOrgnumberByName(searchName, t.postnummer);
    } catch (e: any) {
      errors.push({ provider_id: providerId, error: e?.message ?? String(e) });
      continue;
    }
    scanned++;

    if (!hit) {
      unresolved.push({ provider_id: providerId, reason: "no_brreg_candidate" });
      upsertGardssalgOrgnrReviewQueue({
        provider_id: providerId,
        provider_name: t.navn,
        candidate_orgnr: null,
        candidate_name: null,
        candidate_confidence: null,
        candidate_address: null,
        reason: "no_brreg_candidate",
      });
      continue;
    }

    // ── Write-bar veto chain (integration review B1/M3/M5) — each veto is a
    // review-queue outcome, never a write. Order: cheapest checks first.
    let vetoReason: string | null = null;
    if ((hit.exact_ties ?? (hit.confidence === 1.0 ? 1 : 0)) > 1) {
      // ≥2 exact-name hits in one response (ENK vs AS with the same pruned
      // name, bankrupt predecessor + successor, …): which one wins is
      // response-order luck — structurally ambiguous, a human must pick.
      vetoReason = "ambiguous_exact_name_ties";
    } else if (nameWasStripped && !(t.postnummer && hit.brreg_postal && t.postnummer.trim() === hit.brreg_postal.trim())) {
      // The name we searched is OUR truncation of the display name — demand
      // the strongest corroboration channel (exact postnummer) before
      // trusting a match against a name we ourselves shortened.
      vetoReason = "stripped_name_requires_postal_match";
    } else {
      // A human deliberately rolled this provider's org_nr back — the same
      // deterministic Brreg answer must not silently re-apply it. The audit
      // lookup itself is best-effort (an audit-storage failure must surface
      // through the WRITE path's own error handling, not turn this read
      // into a request-killing 500).
      let rolledBack = false;
      try { rolledBack = gardssalgOrgnrWasRolledBack(providerId); } catch { rolledBack = false; }
      if (rolledBack) vetoReason = "previously_rolled_back";
    }
    if (!vetoReason && gardssalgOrgnrAutoWriteEligible(t, hit)) {
      // Liveness LAST (one extra Brreg call, cached): an exact-name match to
      // a bankrupt/deregistered org must not claim the row — the successor
      // entity case is exactly the wrong-identity write Daniel's rule bans.
      try {
        const ver = await verifyOrgNumber(hit.orgnumber);
        if (!ver.exists || !ver.active) vetoReason = "brreg_not_active";
      } catch {
        vetoReason = "brreg_verify_failed";
      }
    }
    if (vetoReason) {
      unresolved.push({ provider_id: providerId, reason: vetoReason });
      upsertGardssalgOrgnrReviewQueue({
        provider_id: providerId,
        provider_name: t.navn,
        candidate_orgnr: hit.orgnumber,
        candidate_name: hit.name,
        candidate_confidence: hit.confidence,
        candidate_address: hit.address,
        reason: vetoReason,
      });
      continue;
    }

    if (!gardssalgOrgnrAutoWriteEligible(t, hit)) {
      unresolved.push({ provider_id: providerId, reason: "needs_human_review" });
      upsertGardssalgOrgnrReviewQueue({
        provider_id: providerId,
        provider_name: t.navn,
        candidate_orgnr: hit.orgnumber,
        candidate_name: hit.name,
        candidate_confidence: hit.confidence,
        candidate_address: hit.address,
        reason: "needs_human_review",
      });
      continue;
    }

    const evidenceUrl = `${BRREG_BASE_URL}${BRREG_SEARCH_PATH}/${encodeURIComponent(hit.orgnumber)}`;

    if (dryRun) {
      changed.push({ provider_id: providerId, org_nr: hit.orgnumber, source_url: evidenceUrl });
    } else {
      try {
        const written = applyGardssalgProviderOrgnr(providerId, hit.orgnumber, evidenceUrl);
        if (written.length > 0) {
          changed.push({ provider_id: providerId, org_nr: hit.orgnumber, source_url: evidenceUrl });
          // A confirmed, applied write supersedes any stale review-queue
          // entry an earlier run may have left for this provider.
          clearGardssalgOrgnrReviewQueueEntry(providerId);
        } else {
          // Fresh-read-at-write-time found the field already non-blank, the
          // provider now locked, or (UNIQUE org_nr) another provider already
          // holds this exact org_nr — same race class documented on the
          // address-enrichment route above. Bucketed, not silently dropped.
          unresolved.push({ provider_id: providerId, reason: "already_filled_or_conflict_at_write_time" });
        }
      } catch (e: any) {
        errors.push({ provider_id: providerId, error: `write_failed: ${e?.message ?? String(e)}` });
      }
    }
  }

  res.json({
    dry_run: dryRun,
    scanned,
    agents_enriched: changed.length,
    changed,
    skipped_locked: skippedLocked,
    unresolved,
    errors,
  });
});

// ─── GET /api/opplevelser/admin/gardssalg-orgnr-review-queue (admin) ────────
//
// dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach, slice 5b.
// Read-only listing of every gårdssalg provider the backfill route above
// could NOT auto-confirm an org_nr for — the durable counterpart to that
// route's per-run `unresolved[]` array (see gardssalg_orgnr_review_queue's
// schema doc comment, init-experiences.ts). No UI reads this yet; it exists
// so Daniel/CS has something to query once a triage surface is built.
//
// NB: MUST come before "/:id" so "admin" isn't swallowed as an id param.
router.get("/admin/gardssalg-orgnr-review-queue", requireAdmin, (_req: Request, res: Response) => {
  const entries = listGardssalgOrgnrReviewQueue();
  res.json({ count: entries.length, entries });
});

// ─── POST /api/opplevelser/admin/gardssalg-orgnr-review-approve (admin) ──────
//
// dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach, slice 5b —
// the review queue's missing APPLY lever. The first live backfill run
// (2026-07-19) routed 61 providers to the queue exactly as the write bar
// intends — but the queue had no resolution mechanism, so a human decision
// had nowhere to go. This endpoint closes that loop under a strict contract:
//
//   A human may ONLY approve the exact (provider_id, org_nr) pair the queue
//   itself carries — the org_nr in the request must equal the queue entry's
//   candidate_orgnr, or the item is rejected (`mismatch`). This is a
//   confirmation surface, not an arbitrary-write surface: candidates still
//   come exclusively from the corroborated Brreg search, the human adds the
//   judgment the auto-bar refused to exercise, and the write still passes
//   through applyGardssalgProviderOrgnr's fill-only/lock/UNIQUE guards and
//   lands in the same audit/provenance/rollback machinery.
//
// Body: { approvals: [{provider_id, org_nr}], apply? } — dry-run by default.
// Response buckets: approved / rejected (reason per item) — every submitted
// item lands in exactly one.
router.post("/admin/gardssalg-orgnr-review-approve", requireAdmin, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { approvals?: unknown; apply?: unknown };
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  if (!Array.isArray(body.approvals) || body.approvals.length === 0) {
    res.status(400).json({ error: "Requires approvals: [{provider_id, org_nr}]" });
    return;
  }

  const queue = listGardssalgOrgnrReviewQueue();
  const byProvider = new Map(queue.map((q) => [q.provider_id, q]));

  const approved: Array<{ provider_id: string; org_nr: string }> = [];
  const rejected: Array<{ provider_id: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const raw of body.approvals as unknown[]) {
    const a = (raw ?? {}) as { provider_id?: unknown; org_nr?: unknown };
    const providerId = typeof a.provider_id === "string" ? a.provider_id.trim() : "";
    const orgNr = typeof a.org_nr === "string" ? a.org_nr.replace(/\s+/g, "") : "";
    if (!providerId || !orgNr) {
      rejected.push({ provider_id: providerId || "<mangler>", reason: "invalid_item" });
      continue;
    }
    if (seen.has(providerId)) {
      rejected.push({ provider_id: providerId, reason: "duplicate_in_request" });
      continue;
    }
    seen.add(providerId);

    const entry = byProvider.get(providerId);
    if (!entry) {
      rejected.push({ provider_id: providerId, reason: "not_in_review_queue" });
      continue;
    }
    if (!entry.candidate_orgnr || entry.candidate_orgnr.trim() !== orgNr) {
      // The human must approve the QUEUED candidate — a different org_nr in
      // the request is a data-entry error or an attempt to use this as an
      // arbitrary-write surface. Either way: rejected, nothing written.
      rejected.push({ provider_id: providerId, reason: "mismatch_with_queued_candidate" });
      continue;
    }

    if (dryRun) {
      approved.push({ provider_id: providerId, org_nr: orgNr });
      continue;
    }
    try {
      const evidenceUrl = `${BRREG_BASE_URL}${BRREG_SEARCH_PATH}/${encodeURIComponent(orgNr)}`;
      const written = applyGardssalgProviderOrgnr(providerId, orgNr, evidenceUrl);
      if (written.length > 0) {
        clearGardssalgOrgnrReviewQueueEntry(providerId);
        approved.push({ provider_id: providerId, org_nr: orgNr });
      } else {
        rejected.push({ provider_id: providerId, reason: "write_refused_filled_locked_or_conflict" });
      }
    } catch (e: any) {
      rejected.push({ provider_id: providerId, reason: `write_failed: ${e?.message ?? String(e)}` });
    }
  }

  res.json({ dry_run: dryRun, approved_count: approved.length, approved, rejected });
});

// ─── POST /api/opplevelser/admin/gardssalg-content-rollback (admin) ─────────
//
// dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach, slice 1
// (widened in slice 3 to also cover applyGardssalgProviderAddress's address
// fields). Daniel wants a full content-quality pass over all 74 gårdssalg
// producer profiles run in ONE batch with NO canary; the agreed-upon
// substitute safety net is that every field write made by the content
// pipeline (applyGardssalgProviderContent AND applyGardssalgProviderAddress,
// both in experience-store.ts) is reversible via the gardssalg_content_audit
// changelog + experience_providers.field_provenance columns (see
// init-experiences.ts / experience-store.ts and GARDSSALG_ROLLBACKABLE_FIELDS
// there for the exact set of rollback-eligible field names). This endpoint is
// that rollback lever. This slice builds ONLY the rollback substrate — it
// does not change what content gets written by the batch pass.
//
// Body: { provider_id?, field_name?, batch_id?, apply? }. Either provider_id
// (optionally scoped to one field_name) OR batch_id is required — 400 if
// neither is given. batch_id rolls back EVERY field any provider had
// touched under that batch, across all of them.
//
// apply: dry-run by default (same convention as every other admin route in
// this file). apply=false/omitted is a HARD read-only guarantee: the
// planning step (planGardssalgContentRollback) only ever SELECTs — no
// UPDATE/INSERT statement runs anywhere on that path. apply=true performs
// the restores AND inserts a NEW audit row per restore (never mutates/
// deletes existing audit rows), so the rollback itself is auditable.
//
// A (provider_id, field_name) pair with no audit history, or whose latest
// audit row's old_value already matches the field's current live value
// (already rolled back / never actually changed), is reported in `skipped`
// rather than erroring — a batch-wide rollback partially applied earlier
// must be safely re-runnable.
//
// Response: { success: true, dry_run, restored: [...], skipped: [...] }.
// Auth: same X-Admin-Key convention (requireAdmin) as the rest of this file.
//
// entity_type (dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-
// foer-outreach, Steg 2 addition): "provider" (default, UNCHANGED behavior —
// every existing caller omits this and keeps targeting experience_providers
// via gardssalg_content_audit exactly as before) or "experience" — targets
// the `experiences` table via experience_provider_conflict_audit instead
// (the audit trail POST /admin/gardssalg-experience-conflict-remediation
// writes). Body shape mirrors provider_id/field_name/batch_id exactly, using
// experience_id in place of provider_id. ONE HTTP surface for both audit
// trails rather than a second rollback endpoint — per the dev-request's own
// rollback section ("reverserbart... via gardssalg-content-rollback").
router.post("/admin/gardssalg-content-rollback", requireAdmin, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    provider_id?: unknown;
    experience_id?: unknown;
    field_name?: unknown;
    batch_id?: unknown;
    apply?: unknown;
    entity_type?: unknown;
  };

  const entityType = body.entity_type === "experience" ? "experience" : "provider";
  const providerId =
    typeof body.provider_id === "string" && body.provider_id.trim() ? body.provider_id.trim() : undefined;
  const experienceId =
    typeof body.experience_id === "string" && body.experience_id.trim() ? body.experience_id.trim() : undefined;
  const fieldName =
    typeof body.field_name === "string" && body.field_name.trim() ? body.field_name.trim() : undefined;
  const batchId =
    typeof body.batch_id === "string" && body.batch_id.trim() ? body.batch_id.trim() : undefined;
  const apply =
    body.apply === true || body.apply === 1 || body.apply === "1" || body.apply === "true";

  if (entityType === "experience") {
    if (!experienceId && !batchId) {
      res.status(400).json({ error: "Requires experience_id or batch_id" });
      return;
    }
    try {
      const expDb = getExpDb("experiences");
      const { restorable, skipped } = planExperienceConflictRollback(expDb, {
        experience_id: experienceId,
        batch_id: batchId,
      });

      if (!apply) {
        res.json({
          success: true,
          dry_run: true,
          restored: restorable.map((r) => ({
            experience_id: r.experience_id,
            field_name: r.field_name,
            current_value: r.current_value,
            would_restore_to: r.restore_to,
          })),
          skipped,
        });
        return;
      }

      const applied = applyExperienceConflictRollback(expDb, restorable as GsExpConflictRollbackPlanItem[]);
      res.json({
        success: true,
        dry_run: false,
        restored: applied.map((r) => ({
          experience_id: r.experience_id,
          field_name: r.field_name,
          restored_to: r.restored_to,
        })),
        skipped,
      });
    } catch (err: any) {
      console.error("[opplevelser] gardssalg-content-rollback (experience) failed", err);
      res.status(500).json({ error: "Internal error" });
    }
    return;
  }

  if (!providerId && !batchId) {
    res.status(400).json({ error: "Requires provider_id or batch_id" });
    return;
  }

  try {
    const { restorable, skipped } = planGardssalgContentRollback({
      provider_id: providerId,
      field_name: fieldName,
      batch_id: batchId,
    });

    if (!apply) {
      // Dry-run: report what WOULD be restored without writing anything —
      // planGardssalgContentRollback is a pure read (SELECT-only), so no DB
      // mutation happens on this path.
      res.json({
        success: true,
        dry_run: true,
        restored: restorable.map((r) => ({
          provider_id: r.provider_id,
          field_name: r.field_name,
          current_value: r.current_value,
          would_restore_to: r.restore_to,
        })),
        skipped,
      });
      return;
    }

    const applied = applyGardssalgContentRollback(restorable as GardssalgRollbackPlanItem[]);
    res.json({
      success: true,
      dry_run: false,
      restored: applied.map((r) => ({
        provider_id: r.provider_id,
        field_name: r.field_name,
        restored_to: r.restored_to,
      })),
      skipped,
    });
  } catch (err: any) {
    console.error("[opplevelser] gardssalg-content-rollback failed", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── POST /api/opplevelser/admin/gardssalg-mojibake-backfill (admin) ────────
//
// dev-request 2026-07-21-opplevagent-norske-tegn-encoding, criterion 3. PR
// lokal#360 fixed fetchHtml()'s decode path (search-enrich.ts) so future
// crawls never mis-decode a source page's æ/ø/å again — but that fix does
// NOTHING for producer text ALREADY written to the DB before it shipped.
// This endpoint is the databackfill for that already-corrupted text.
//
// Explicitly NOT a blind find/replace on mojibake byte patterns (rejected in
// the dev-request as too risky — it could mangle text that only
// coincidentally matches, or miss nested/double-encoded corruption). The
// repair instead re-runs the SAME re-fetch → re-extract → write pipeline any
// other gårdssalg content refresh uses, just now with the corrected decode
// path underneath it:
//   1. scanGardssalgProviderRowForMojibake (experience-store.ts) flags which
//      STORED fields (about_text/visit_text/opening_hours_text/products)
//      contain a known mojibake signature (containsMojibake) — detection
//      only, never used to mutate text directly.
//   2. dry_run (default): returns that candidate list — provider id, name,
//      which field(s) matched, a short snippet of the corrupted text. No
//      fetch, no write.
//   3. apply=true: for each candidate, re-fetches the provider's homepage via
//      buildPageEvidence() (the ALREADY-FIXED decode path) and re-extracts
//      about_text/visit_text/opening_hours_text with the SAME deterministic,
//      non-LLM extractors the original write path used (summarizeAbout/
//      summarizeVisit/extractOpeningHours) — no LLM call, since this is a
//      pure encoding-correctness repair, not a content-quality judgment.
//      A field is only written when the freshly re-extracted value (a)
//      is non-empty, (b) DIFFERS from the currently stored value, AND
//      (c) does NOT itself still match a mojibake signature (the safety net
//      against re-corrupting, or against a source site whose text is itself
//      genuinely unrecoverable). Anything that fails any of those three
//      checks is skipped and reported, never blanked, never guessed.
//   4. Writes go through the EXISTING applyGardssalgProviderContent() —
//      forced via its new `forceFields` param (see that function's own doc
//      comment for why a force-bypass is needed here specifically:
//      gardssalgReplaceableFieldAction's "candidate must be strictly LONGER"
//      replace rule is actively wrong for mojibake repair, since corrupted
//      text is typically LONGER than its correctly-decoded fix) — so every
//      write still gets the SAME gardssalg_content_audit row +
//      field_provenance stamp + content_source='manual'/'claim' lock-guard
//      as any other gårdssalg content write. That audit trail is the
//      rollback lever (POST /admin/gardssalg-content-rollback, unmodified —
//      about_text/visit_text/opening_hours_text are already in
//      GARDSSALG_ROLLBACKABLE_FIELDS there).
//
// `products` (JSON-array-of-strings column) is INCLUDED in detection (dry-run
// candidates can list it) but NOT auto-repaired here: unlike about_text/
// visit_text/opening_hours_text, there is no deterministic (non-LLM)
// extractor that reconstructs the literal product-name strings originally
// written by generateGardssalgProductList — guessing a replacement without
// one would violate this endpoint's own "never guess" rule. A products-only
// match is reported for manual review rather than silently dropped or
// blindly rewritten; see `products_flagged_for_manual_review` in the
// response and this route's own doc comment for the reasoning. (Flagged, not
// silently expanded in scope — a future slice could add an LLM-backed
// products re-extraction path mirroring generateGardssalgProductList.)
//
// Body: { providerIds?: string[], limit?: number, apply?: boolean }.
// apply: dry-run by default (same convention as every other admin route in
// this file) — apply=1/"1"/true (body) or ?apply=1/"true" (query).
// limit: default 25, hard cap 48 (same ceiling as the candidate scan itself
// — there are only 48 gårdssalg providers total).
// Auth: same X-Admin-Key convention (requireAdmin) as the rest of this file.
const MB_DEFAULT_LIMIT = 25;
const MB_HARD_CAP = 48;

router.post("/admin/gardssalg-mojibake-backfill", requireAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { providerIds?: unknown; limit?: unknown; apply?: unknown };

  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  const limit = Math.min(
    typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : MB_DEFAULT_LIMIT,
    MB_HARD_CAP
  );

  // ── Candidate selection (detection only — no fetch, no write) ─────────
  let candidates: GardssalgMojibakeCandidate[];
  if (Array.isArray(body.providerIds) && body.providerIds.length > 0) {
    const ids = (body.providerIds as unknown[])
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim())
      .slice(0, limit);
    candidates = [];
    for (const id of ids) {
      const t = getGardssalgProviderContentTarget(id);
      if (!t) continue;
      // getGardssalgProviderContentTarget() does NOT itself filter locked
      // (content_source manual/claim) rows — same override semantics as the
      // sibling content-refresh route's providerIds resolution. Unlike that
      // route, a locked row is never even surfaced as a mojibake-backfill
      // candidate here (not just skipped-before-fetch): forcing a fix onto a
      // human/owner-authored row is never in scope for this endpoint, dry-run
      // or apply, explicit id or not.
      if (t.content_source === "manual" || t.content_source === "claim") continue;
      const fields = scanGardssalgProviderRowForMojibake(t);
      if (fields.length > 0) candidates.push({ id: t.id, navn: t.navn, hjemmeside: t.hjemmeside, fields });
    }
  } else {
    candidates = selectGardssalgMojibakeCandidates(limit);
  }

  if (dryRun) {
    res.json({
      dry_run: true,
      candidates: candidates.length,
      written: 0,
      skipped_still_corrupt: 0,
      skipped_no_change: 0,
      errors: [],
      rows: candidates.map((c) => ({
        provider_id: c.id,
        name: c.navn,
        fields: c.fields,
      })),
      products_flagged_for_manual_review: candidates
        .filter((c) => c.fields.some((f) => f.field === "products"))
        .map((c) => c.id),
    });
    return;
  }

  // ── apply=true: re-fetch (already-fixed decode path) + re-extract +
  // force-write only what genuinely differs and is no longer corrupt. ────
  const rows: Array<{ provider_id: string; name: string; field: string; before: string; after: string }> = [];
  let written = 0;
  let skippedStillCorrupt = 0;
  let skippedNoChange = 0;
  const errors: Array<{ provider_id: string; error: string }> = [];
  const productsFlagged: string[] = [];

  for (const c of candidates) {
    const flaggedFieldsPreFetch = new Set(c.fields.map((f) => f.field));
    if (flaggedFieldsPreFetch.has("products")) productsFlagged.push(c.id);
    // No deterministic (non-LLM) re-extraction path exists for `products` —
    // if that's the ONLY flagged field, there is nothing this route can
    // repair, so skip the fetch entirely rather than paying for a network
    // round-trip with no possible write at the end of it.
    const needsFetch =
      flaggedFieldsPreFetch.has("about_text") ||
      flaggedFieldsPreFetch.has("visit_text") ||
      flaggedFieldsPreFetch.has("opening_hours_text");
    if (!needsFetch) continue;

    let page: PageEvidence | null;
    try {
      page = await buildPageEvidence(c.hjemmeside);
    } catch (e: any) {
      errors.push({ provider_id: c.id, error: `fetch_failed: ${e?.message ?? String(e)}` });
      continue;
    }
    if (!page) {
      errors.push({ provider_id: c.id, error: `fetch_failed for ${c.hjemmeside}` });
      continue;
    }

    // Re-read the CURRENT stored row (not the candidate's selection-time
    // snapshot, which may be stale by the time this loop reaches it) so the
    // "differs from stored" check and the before/after diff are always
    // against live data — same discipline as every other gårdssalg writer
    // in this file re-checking against a fresh row.
    const target = getGardssalgProviderContentTarget(c.id);
    if (!target) {
      errors.push({ provider_id: c.id, error: "provider_not_found_or_locked" });
      continue;
    }

    const flaggedFields = flaggedFieldsPreFetch;

    const freshAbout = flaggedFields.has("about_text") ? summarizeAbout(page.html) : null;
    const freshVisit = flaggedFields.has("visit_text") ? summarizeVisit(page.html) : null;
    const freshHours = flaggedFields.has("opening_hours_text")
      ? extractOpeningHours(page.contentText ?? extractVisibleText(page.html))
      : null;

    const candidateWrite: { about_text?: string; visit_text?: string; opening_hours_text?: string } = {};
    const forceFields: Array<"about_text" | "visit_text" | "opening_hours_text"> = [];
    const beforeSnapshot: Record<string, string | null> = {
      about_text: target.about_text,
      visit_text: target.visit_text,
      opening_hours_text: target.opening_hours_text,
    };

    function evaluate(
      field: "about_text" | "visit_text" | "opening_hours_text",
      fresh: string | null,
      stored: string | null
    ): void {
      if (!flaggedFields.has(field)) return;
      const freshTrimmed = fresh?.trim() || "";
      const storedTrimmed = (stored ?? "").trim();
      if (!freshTrimmed || freshTrimmed === storedTrimmed) {
        skippedNoChange++;
        return;
      }
      if (containsMojibake(freshTrimmed)) {
        skippedStillCorrupt++;
        return;
      }
      candidateWrite[field] = freshTrimmed;
      forceFields.push(field);
    }

    evaluate("about_text", freshAbout, target.about_text);
    evaluate("visit_text", freshVisit, target.visit_text);
    evaluate("opening_hours_text", freshHours, target.opening_hours_text);

    if (forceFields.length === 0) continue;

    try {
      const writtenFields = applyGardssalgProviderContent(
        c.id,
        candidateWrite,
        page.url || c.hjemmeside,
        undefined,
        undefined,
        undefined,
        forceFields
      );
      for (const f of writtenFields) {
        written++;
        rows.push({
          provider_id: c.id,
          name: c.navn,
          field: f,
          before: beforeSnapshot[f] ?? "",
          after: (candidateWrite as Record<string, string | undefined>)[f] ?? "",
        });
      }
    } catch (e: any) {
      errors.push({ provider_id: c.id, error: `write_failed: ${e?.message ?? String(e)}` });
    }
  }

  res.json({
    dry_run: false,
    candidates: candidates.length,
    written,
    skipped_still_corrupt: skippedStillCorrupt,
    skipped_no_change: skippedNoChange,
    errors,
    rows,
    products_flagged_for_manual_review: productsFlagged,
  });
});

// ─── Admin rfb-seed routes ───────────────────────────────────────────
//
// DELETE /api/opplevelser/admin/rfb-seed   — rollback: deletes all rows seeded
//   by rfb-seed (rfb_seed_source='rfb-seed'). Safe: never touches claimed/enriched/manual rows.
//
// POST /api/opplevelser/admin/rfb-seed     — seed pass: reads drink producers
//   from the main RFB marketplace DB and seeds them as experience_providers rows.
//   Idempotent — deduplicates on navn.
//   Default is DRY-RUN. Add ?apply=true (query) or {"apply":true} (body) to write.
//
// INVARIANT: reads ONLY from the rfb DB; NEVER writes back to it.
// NB: MUST come before "/:id" so "admin" isn't swallowed as an id param.

import { getDb as getRfbDb } from "../database/init";
import { getDb as getExpDb } from "../database/db-factory";
import {
  indexRfbByDomain,
  indexRfbByName,
  pickEnrichmentFields,
  type RfbSource,
  type EnrichProviderRow,
} from "../services/gardssalg-rfb-enrich";

// Tight drikkeprodusent filter — beverage manufacturers with on-site production only.
// INCLUDE: bryggeri, cideri/sideri, mjød, destilleri/brenneri, vin, kombucha.
// EXCLUDE: coffee roasters (kafferøst/kaffebrenneri), cheese (ysteri), plain gårdsbutikk.
const RFB_DRINKS_TAGS = new Set([
  "bryggeri", "cideri", "sideri", "distillery", "brennevin", "mjød", "vin",
]);
// Keywords matched case-insensitively against the agent name.
const DRINKS_NAME_KEYWORDS = [
  "bryggeri", "gårdsbryggeri", "mikrobryggeri",
  "cideri", "sideri", "cider",
  "mjød", "mead",
  "destilleri", "brenneri",
  "kombucha",
  "vingård", "vinprodusent", "vingårdsbryggeri",
];
// Coffee roasters match "brenneri" via substring — exclude them explicitly.
const DRINKS_NAME_EXCLUSIONS = [
  "kaffebrenneri", "kaffibrenneri", "kafferøst", "kafferoasteri", "kaffebar",
];

// ─── DELETE /api/opplevelser/admin/rfb-seed — rollback ───────────────────────
router.delete("/admin/rfb-seed", requireAdmin, (req: Request, res: Response) => {
  const expDb = getExpDb("experiences");
  try {
    const result = expDb
      .prepare("DELETE FROM experience_providers WHERE rfb_seed_source = 'rfb-seed'")
      .run();
    res.json({
      deleted: result.changes,
      note: "Deleted all rfb_seed_source='rfb-seed' providers. Safe: claimed/enriched/manual rows untouched.",
    });
  } catch (err) {
    console.error("[rfb-seed rollback] Delete failed:", err);
    res.status(500).json({ error: "Rollback failed", details: String(err) });
  }
});

router.post("/admin/rfb-seed", requireAdmin, (req: Request, res: Response) => {
  // Default is DRY-RUN — caller must explicitly opt in to a live write.
  const apply =
    req.query.apply === "true" || req.query.apply === "1" ||
    req.body?.apply === true || req.body?.apply === "true" || req.body?.apply === "1";
  const dryRun = !apply;

  // Open both DBs (both are cached singletons — no double-open risk).
  const rfbDb = getRfbDb();
  const expDb = getExpDb("experiences");

  // ── Pull candidate agents from rfb DB ────────────────────────────────────
  // Tags are JSON arrays stored as TEXT. '"<tag>"' always appears verbatim.
  // Name keywords are matched case-insensitively (SQLite LIKE is case-insensitive for ASCII).
  const tagClauses = [...RFB_DRINKS_TAGS].map(() => "tags LIKE ?").join(" OR ");
  const tagParams = [...RFB_DRINKS_TAGS].map((t) => `%"${t}"%`);
  const nameClauses = DRINKS_NAME_KEYWORDS.map(() => "lower(name) LIKE ?").join(" OR ");
  const nameParams = DRINKS_NAME_KEYWORDS.map((k) => `%${k}%`);
  const excludeClauses = DRINKS_NAME_EXCLUSIONS.map(() => "lower(name) NOT LIKE ?").join(" AND ");
  const excludeParams = DRINKS_NAME_EXCLUSIONS.map((k) => `%${k}%`);

  type AgentRow = {
    id: string;
    name: string;
    url: string | null;
    city: string | null;
    tags: string | null;
    categories: string | null;
  };

  let candidates: AgentRow[] = [];
  try {
    candidates = rfbDb
      .prepare(
        `SELECT id, name, url, city, tags, categories
           FROM agents
          WHERE is_active = 1
            AND ((${tagClauses}) OR (${nameClauses}))
            AND (${excludeClauses})`
      )
      .all(...tagParams, ...nameParams, ...excludeParams) as AgentRow[];
  } catch (err) {
    console.error("[rfb-seed] Failed to query agents table:", err);
    res.status(500).json({ error: "Failed to query rfb agents" });
    return;
  }

  console.log(`[rfb-seed] Found ${candidates.length} candidate(s) in rfb DB (dry_run=${dryRun})`);

  // ── Seed pass ─────────────────────────────────────────────────────────────
  let seeded = 0;
  let skippedDuplicate = 0;
  const candidateNames: string[] = [];

  for (const agent of candidates) {
    candidateNames.push(agent.name);

    // Dedup: check if experience_providers already has a row for this agent.
    // Agents table has no org_nr, so we dedup on navn.
    let alreadyExists = false;
    try {
      const existing = expDb
        .prepare("SELECT id FROM experience_providers WHERE navn = ? LIMIT 1")
        .get(agent.name);
      alreadyExists = !!existing;
    } catch (err) {
      console.error(`[rfb-seed] Dedup check failed for "${agent.name}":`, err);
      continue;
    }

    if (alreadyExists) {
      console.log(`[rfb-seed] SKIP duplicate: ${agent.name}`);
      skippedDuplicate++;
      continue;
    }

    if (dryRun) {
      console.log(`[rfb-seed] DRY_RUN would seed: ${agent.name}`);
      seeded++;
      continue;
    }

    // INSERT the provider row. Per-record try/catch so one failure never aborts the batch.
    try {
      const id = crypto.randomUUID();
      expDb
        .prepare(
          `INSERT INTO experience_providers
             (id, org_nr, navn, vertical, hjemmeside,
              fylke, kommune, postnummer, poststed, adresse,
              rfb_seed_source, enrichment_state, verification_status,
              source, confidence)
           VALUES
             (@id, @org_nr, @navn, @vertical, @hjemmeside,
              @fylke, @kommune, @postnummer, @poststed, @adresse,
              @rfb_seed_source, @enrichment_state, @verification_status,
              @source, @confidence)`
        )
        .run({
          id,
          org_nr: null,
          navn: agent.name,
          vertical: "experiences",
          hjemmeside: agent.url ?? null,
          fylke: null,
          kommune: agent.city ?? null,
          postnummer: null,
          poststed: agent.city ?? null,
          adresse: null,
          rfb_seed_source: "rfb-seed",
          enrichment_state: "raw",
          verification_status: "pending_verify",
          source: "rfb-marketplace-seed",
          confidence: "medium",
        });
      console.log(`[rfb-seed] SEEDED: ${agent.name} (id=${id})`);
      seeded++;
    } catch (err) {
      console.error(`[rfb-seed] INSERT failed for "${agent.name}":`, err);
    }
  }

  res.json({
    seeded,
    skipped_duplicate: skippedDuplicate,
    dry_run: dryRun,
    apply_mode: !dryRun,
    candidates: candidateNames,
  });
});

// ─── POST /api/opplevelser/admin/gardssalg/test-provider ─────────────────────
//
// dev-request 2026-07-14-booking-flyt-v1, slice 0: idempotent upsert of ONE
// hidden test gårdssalg provider used to drive a controlled end-to-end booking
// test. The row is catalog_hidden=1 — never in the public grid, the
// countGardssalgProviders() gate, or the sitemap (see listGardssalgProviders()/
// countGardssalgProviders() in experience-store.ts) — yet booking_live=1 and
// fully bookable by slug, so a booking POST against it (with
// BOOKING_DISPATCH_ENABLED=true) exercises the real reserve→confirm chain and
// dispatches the producer notification to the email supplied here (Daniel's
// inbox), and nowhere else. This endpoint never emails anyone itself; it only
// writes, and only when called with the admin key. Idempotent: re-running with
// the same slug/test org_nr updates the one existing row instead of erroring on
// the UNIQUE indexes or duplicating. Not dry-run — it is an explicit, gated
// admin action that creates a single hidden, double-gated test row.
// NB: MUST come before "/:id" so "admin" isn't swallowed as an id param.
//
// ── `claimable: true` (dev-request 2026-07-21-opplevagent-claim-flyt-
// drikkeprodusenter, acceptance criterion 6) ──────────────────────────────
// The booking E2E above only needs booking_live; the CLAIM E2E needs the row
// to satisfy deriveOrgLinkedEmail() (services/gardssalg-claim.ts), and none of
// the fields it reads were reachable from any admin lever: brreg_verified has
// no write route for experience_providers at all, and PATCH /admin/providers/
// :id/hjemmeside sets hjemmeside WITHOUT the field_provenance stamp that makes
// a domain "ownership-verified". So the claim flow had no repeatable end-to-end
// test path. This opt-in flag closes exactly that gap and nothing else.
//
// It sets the three fields deriveOrgLinkedEmail() needs, and deliberately does
// NOT use content_source='manual' as the ownership proof even though that is
// the cheaper of the two accepted paths: the owner portal disables its whole
// edit form on content_source==='manual' (routes/gardssalg-claim.ts), so a
// 'manual' test row would verify the magic link and then present a read-only
// portal — testing the wrong thing. The field_provenance.hjemmeside.source_url
// path leaves the portal editable, which is what a claim E2E must exercise.
//
// SAFETY — the claimable writes are pinned to `org_nr = TEST_PROVIDER_ORG_NR`
// in the UPDATE's own WHERE clause, not merely to the id resolved above. The
// pre-existing upsert matches `slug = ? OR org_nr = ?`, so a caller passing a
// REAL provider's slug already resolves to that real row; without the pin, this
// flag would hand a real producer a forged ownership stamp and reset a genuine
// content_source lock. With it, a non-test row is refused before any write.
//
// The default domain is RFC-6761-reserved `.invalid` — guaranteed never to
// resolve — so even if a NON-test claim were ever issued against this row (the
// public POST .../request route, which does not redirect), the derived
// post@<domain> address cannot reach a real third party. It is also outside
// GENERIC_DOMAINS, which isClaimableDomain() requires.
//
// content_source is RESET to NULL so the test is repeatable: a completed claim
// stamps content_source='claim' (verifyClaimToken), which would otherwise make
// the second run start from a claimed row. Same org_nr pin guards that reset.
const TEST_PROVIDER_ORG_NR = "TEST000000";
const TEST_PROVIDER_DEFAULT_NAME = "TEST — Ikke book (booking-flyt-v1 slice 0)";
const TEST_PROVIDER_DEFAULT_SLUG = "test-ikke-book-slice0";
const TEST_PROVIDER_DEFAULT_HJEMMESIDE = "https://test-ikke-book.invalid";
router.post("/admin/gardssalg/test-provider", requireAdmin, (req: Request, res: Response) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  // Same shape as ProviderSchema's z.string().email() so createProvider() below
  // won't reject it — validate up front for a clean 400 instead of a 500.
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).json({ error: "Body må inneholde en gyldig { email }" });
    return;
  }
  const name =
    typeof req.body?.name === "string" && req.body.name.trim()
      ? req.body.name.trim()
      : TEST_PROVIDER_DEFAULT_NAME;
  const slug =
    typeof req.body?.slug === "string" && req.body.slug.trim()
      ? req.body.slug.trim()
      : TEST_PROVIDER_DEFAULT_SLUG;

  // Strict-true parse, same convention as every other opt-in flag in this file:
  // only the literal JSON boolean `true` turns the claim fields on.
  const claimable = req.body?.claimable === true;
  const hjemmeside =
    typeof req.body?.hjemmeside === "string" && req.body.hjemmeside.trim()
      ? req.body.hjemmeside.trim()
      : TEST_PROVIDER_DEFAULT_HJEMMESIDE;

  // A caller-supplied hjemmeside is NOT free-form here, because whatever lands
  // in this column decides who receives real mail. normalizeDomain() treats any
  // string containing "@" as an email address and keeps only what follows it
  // (blocklist-service.ts), so an unvalidated value like
  //   "https://x.no\nBcc: victim@evil.example"
  // stores one thing as the website and mints post@evil.example as the claim
  // address — and the PUBLIC claim route (POST /kategori/gardssalg/eier/:id/
  // request) is unauthenticated and sends WITHOUT the test redirect, so any
  // visitor who knows the slug could then trigger a genuine magic-link email to
  // that unrelated domain. The `.invalid` default is only a safe default; it
  // protects nothing once a caller passes their own value.
  //
  // Three gates, cheapest first, and all three are required:
  //   1. isPlausibleUrlish  — the same shape check PATCH /admin/providers/:id/
  //      hjemmeside already applies; rejects whitespace (so header/CRLF
  //      injection cannot survive) and anything without a dot.
  //   2. a parseable http(s) URL whose host equals the normalized domain — this
  //      is what closes the "@" trick: a value whose derived domain is not
  //      simply the host of the URL we are storing is refused outright, so the
  //      stored website and the minted address can never disagree.
  //   3. isClaimableDomain — the SAME rule deriveOrgLinkedEmail() applies at
  //      mint time, so a bad domain is a clean 400 instead of a silently
  //      non-claimable test row.
  const claimDomain = claimable ? normalizeDomain(hjemmeside) : "";
  if (claimable) {
    let urlHost = "";
    try {
      const parsed = new URL(hjemmeside);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        urlHost = parsed.hostname.toLowerCase().replace(/^www\./, "");
      }
    } catch {
      /* unparseable -> urlHost stays "" -> refused below */
    }
    if (!isPlausibleUrlish(hjemmeside) || !urlHost || urlHost !== claimDomain) {
      res.status(400).json({
        error:
          "'hjemmeside' må være en http(s)-URL uten mellomrom, og vertsnavnet må være " +
          "nøyaktig det domenet claim-adressen utledes fra (ellers kan lagret nettside og " +
          "utledet post@-adresse peke på ulike domener)",
        hjemmeside,
        url_host: urlHost || null,
        normalized_domain: claimDomain,
      });
      return;
    }
    if (!isClaimableDomain(claimDomain)) {
      res.status(400).json({
        error:
          "'hjemmeside' må være et domene claim-flyten kan utlede post@<domene> fra " +
          "(må inneholde punktum, og kan ikke være et generisk/delt domene)",
        hjemmeside,
        normalized_domain: claimDomain,
      });
      return;
    }
  } else if (typeof req.body?.hjemmeside === "string" && req.body.hjemmeside.trim()) {
    // Without the flag the value is never written. Say so rather than accepting
    // it and silently discarding it.
    res.status(400).json({
      error: "'hjemmeside' krever { claimable: true } — uten flagget skrives den ikke",
    });
    return;
  }

  const expDb = getExpDb("experiences");

  try {
    // Converge on ONE row: match an existing test row by slug OR the fixed test
    // org_nr (the stable identity across repeat calls, even if the slug changes).
    // ORDER BY prefers the SLUG match. It only matters when the two legs hit
    // DIFFERENT rows — i.e. the caller passed a real provider's slug while the
    // test row exists — and there the slug match is the row we must surface, so
    // the guard below can name it in a clean 409. Without the ordering,
    // SQLite's choice is arbitrary: picking the test row instead would send the
    // unconditional UPDATE on to `SET slug = <the real row's slug>`, which
    // violates the UNIQUE index on slug (init-experiences.ts) and surfaces as a
    // 500 that says nothing useful. Same row on both legs in the normal case,
    // so the ordering is a no-op there.
    const existing = expDb
      .prepare(
        `SELECT id, org_nr FROM experience_providers
          WHERE slug = @slug OR org_nr = @testOrgNr
          ORDER BY (slug = @slug) DESC
          LIMIT 1`
      )
      .get({ slug, testOrgNr: TEST_PROVIDER_ORG_NR }) as { id: string; org_nr: string | null } | undefined;

    // The `slug OR org_nr` match above can land on a REAL provider — any row
    // whose slug the caller happened to pass. Everything below this point
    // rewrites the resolved row into the test provider (navn, producer_type,
    // catalog_hidden, booking_live, commission_rate, verification_status), so
    // refusing has to happen BEFORE the first write, not after it: a check
    // placed later would report "refused" on a row it had already overwritten.
    // The endpoint's whole contract is "upsert THE ONE test row", so a
    // resolved row that isn't it is always a caller error, never a valid
    // target — with or without the claimable flag.
    if (existing && existing.org_nr !== TEST_PROVIDER_ORG_NR) {
      res.status(409).json({
        error:
          `Nekter: slug '${slug}' tilhører en ekte produsent, ikke testprodusenten ` +
          `(org_nr ${existing.org_nr ?? "NULL"} != ${TEST_PROVIDER_ORG_NR}). Ingenting er skrevet.`,
        provider_id: existing.id,
      });
      return;
    }

    // createProvider() covers the ProviderSchema-known fields (navn/org_nr/epost/
    // verification_status); the raw UPDATE below sets the columns the schema
    // doesn't (producer_type/booking_live/catalog_hidden/rfb_seed_source) plus
    // commission_rate — exactly the createProvider()+raw-UPDATE split the tests
    // use. On a repeat call we reuse the existing row's id instead.
    const providerId = existing
      ? existing.id
      : createProvider({
          navn: name,
          org_nr: TEST_PROVIDER_ORG_NR,
          epost: email,
          verification_status: "verified",
        });

    expDb
      .prepare(
        `UPDATE experience_providers
            SET navn = @navn, epost = @email, slug = @slug,
                producer_type = 'test-gardssalg', rfb_seed_source = NULL,
                catalog_hidden = 1, booking_live = 1, commission_rate = 0,
                verification_status = 'verified', updated_at = datetime('now')
          WHERE id = @id`
      )
      .run({ id: providerId, navn: name, email, slug });

    // ── claimable opt-in (see this route's doc comment) ──────────────────
    let claimReady = false;
    if (claimable) {
      // MERGE the provenance, don't clobber it — both other writers of this
      // column (applyGardssalgProviderWebsite in experience-store.ts, and the
      // verification sweep's hjemmeside_verification stamp) read the existing
      // JSON, set only their own key, and write back, treating malformed JSON
      // as empty rather than failing the write. A wholesale stringify here
      // would silently drop any key they had set. The org_nr pin below means
      // that can only ever be the synthetic test row today, and the cohort
      // exclusions keep the sweeps off it — so this is convention, not a live
      // bug. Which is the reason to follow it: the next writer of this column
      // should find three call sites agreeing, not two and an exception.
      //
      // Read AND write inside ONE transaction, same as
      // applyGardssalgWebsiteVerification: split across two statements, a
      // concurrent provenance writer could land between them and lose its key —
      // which is the exact failure the merge exists to prevent.
      //
      // The UPDATE's `AND org_nr = @testOrgNr` is belt to the pre-write guard's
      // braces. That guard already turns a real-provider slug into a 409 before
      // anything is written, so this pin should be unreachable — but it is what
      // makes the forged-ownership write structurally impossible rather than
      // merely unreached, and it costs one AND. `changes === 0` means it fired;
      // note that if it ever DID fire, the unconditional UPDATE above would
      // already have run, so the 409 below would be reporting a partial write.
      // That is precisely the defect the pre-write guard was added to remove —
      // keep them in that order.
      const result = expDb.transaction(() => {
        let provenance: Record<string, unknown> = {};
        const existingProv = expDb
          .prepare(`SELECT field_provenance FROM experience_providers WHERE id = ?`)
          .get(providerId) as { field_provenance: string | null } | undefined;
        if (existingProv?.field_provenance) {
          try {
            const parsed = JSON.parse(existingProv.field_provenance);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              provenance = parsed as Record<string, unknown>;
            }
          } catch {
            /* malformed existing JSON -> treat as empty rather than clobber the write */
          }
        }
        provenance.hjemmeside = {
          source_url: hjemmeside,
          fetched_at: new Date().toISOString(),
          source: "admin-test-provider",
        };
        return expDb
          .prepare(
            `UPDATE experience_providers
                SET brreg_verified = 1, hjemmeside = @hjemmeside,
                    field_provenance = @stamp, content_source = NULL,
                    updated_at = datetime('now')
              WHERE id = @id AND org_nr = @testOrgNr`
          )
          .run({
            id: providerId,
            hjemmeside,
            stamp: JSON.stringify(provenance),
            testOrgNr: TEST_PROVIDER_ORG_NR,
          });
      })();

      if (result.changes === 0) {
        res.status(409).json({
          error:
            "Nekter claimable-skriv: raden er ikke testprodusenten " +
            `(org_nr != ${TEST_PROVIDER_ORG_NR}). Bruk en slug som ikke tilhører en ekte produsent.`,
          provider_id: providerId,
        });
        return;
      }
      claimReady = true;
    }

    console.log(
      `[test-provider] upserted hidden test provider id=${providerId} slug=${slug} epost=${email} ` +
        `(catalog_hidden=1, booking_live=1, claimable=${claimReady})`
    );

    res.json({
      success: true,
      provider_id: providerId,
      slug,
      booking_url: `${APP_URL}/kategori/gardssalg/book/${slug}`,
      epost: email,
      claimable: claimReady,
      ...(claimReady
        ? {
            claim_url: `${APP_URL}/kategori/gardssalg/eier/${slug}`,
            claim_hjemmeside: hjemmeside,
            // The address the claim would derive. Reported so the operator can
            // confirm the E2E redirect actually diverted the send — nothing is
            // ever sent to it by this route (it sends no email at all).
            derived_claim_email: `post@${claimDomain}`,
          }
        : {}),
    });
  } catch (err) {
    console.error("[test-provider] upsert failed:", err);
    res.status(500).json({ error: "Kunne ikke opprette testprodusent", details: String(err) });
  }
});

// ─── POST /api/opplevelser/admin/rfb-knowledge-enrich ────────────────────────
//
// Fills the sparse rfb-seeded gårdssalg providers from their rich RFB producer
// twin (agents + agent_knowledge in lokal.db). STRICT website-domain match only;
// skips low-quality/inference-only values; respects the content_source lock;
// fills only MISSING fields. See services/gardssalg-rfb-enrich.ts for the rules.
//
// DRY-RUN by default (returns the full match/would-copy report); pass
// ?apply=true (or body.apply) for a live write. Idempotent: re-running only
// fills fields still missing. Records provenance content_source='rfb-knowledge'
// + content_evidence_url=<RFB homepage> (the producer's own site as proof).
router.post("/admin/rfb-knowledge-enrich", requireAdmin, (req: Request, res: Response) => {
  const apply =
    req.query.apply === "true" || req.query.apply === "1" ||
    req.body?.apply === true || req.body?.apply === "true" || req.body?.apply === "1";
  const dryRun = !apply;

  const rfbDb = getRfbDb();
  const expDb = getExpDb("experiences");

  // Load the RFB producers (agents + agent_knowledge) and index by domain.
  let sources: RfbSource[] = [];
  try {
    sources = rfbDb.prepare(
      `SELECT a.id AS agent_id, a.name AS name,
              COALESCE(k.website, a.url) AS url,
              a.lat AS lat, a.lng AS lng,
              k.about AS about, k.address AS address, k.phone AS phone,
              k.email AS email, k.products AS products,
              k.verification_review_reason AS verification_review_reason
         FROM agents a
         LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE a.is_active = 1`
    ).all() as RfbSource[];
  } catch (err) {
    console.error("[rfb-knowledge-enrich] failed to query rfb agents:", err);
    res.status(500).json({ error: "Failed to query rfb agents" });
    return;
  }
  const byDomain = indexRfbByDomain(sources);
  const byName = indexRfbByName(sources);

  // Load the seeded gårdssalg providers.
  let providers: EnrichProviderRow[] = [];
  try {
    providers = expDb.prepare(
      `SELECT id, navn, hjemmeside, adresse, telefon, epost, lat, lon,
              about_text, products, content_source
         FROM experience_providers
        WHERE rfb_seed_source = 'rfb-seed'`
    ).all() as EnrichProviderRow[];
  } catch (err) {
    console.error("[rfb-knowledge-enrich] failed to query providers:", err);
    res.status(500).json({ error: "Failed to query experience_providers" });
    return;
  }

  const results = providers.map((p) => pickEnrichmentFields(p, byDomain, byName));

  let enriched = 0;
  const fieldFillCounts: Record<string, number> = {};
  if (apply) {
    const now = new Date().toISOString();
    for (const r of results) {
      if (r.status !== "would_enrich") continue;
      const sets: string[] = [];
      const vals: Array<string | number | null> = [];
      for (const [field, value] of Object.entries(r.copy)) {
        sets.push(`${field} = ?`);
        vals.push(value);
        fieldFillCounts[field] = (fieldFillCounts[field] || 0) + 1;
      }
      // Provenance: mark as rfb-knowledge sourced with the producer's own site
      // as evidence URL (Daniel: "bruk agentens hjemmeside som proof på info").
      const evidenceUrl = r.matched_rfb ? (byDomain.get(r.matched_rfb.domain)?.url ?? null) : null;
      sets.push("content_source = ?", "content_evidence_url = ?", "content_updated_at = ?");
      vals.push("rfb-knowledge", evidenceUrl, now);
      try {
        expDb.prepare(`UPDATE experience_providers SET ${sets.join(", ")} WHERE id = ?`).run(...vals, r.provider_id);
        enriched++;
      } catch (err) {
        console.error(`[rfb-knowledge-enrich] UPDATE failed for ${r.navn}:`, err);
      }
    }
  } else {
    for (const r of results) if (r.status === "would_enrich") for (const f of Object.keys(r.copy)) fieldFillCounts[f] = (fieldFillCounts[f] || 0) + 1;
  }

  const wouldEnrich = results.filter((r) => r.status === "would_enrich");
  const summary = {
    total_providers: results.length,
    would_enrich: wouldEnrich.length,
    would_enrich_by_domain: wouldEnrich.filter((r) => r.matched_by === "domain").length,
    would_enrich_by_name: wouldEnrich.filter((r) => r.matched_by === "name").length,
    locked: results.filter((r) => r.status === "locked").length,
    no_domain: results.filter((r) => r.status === "no_domain").length,
    no_match: results.filter((r) => r.status === "no_match").length,
    nothing_to_fill: results.filter((r) => r.status === "nothing_to_fill").length,
    field_fill_counts: fieldFillCounts,
  };

  res.json({
    dry_run: dryRun,
    apply_mode: apply,
    enriched,
    summary,
    // Full per-provider detail so Daniel can eyeball every match before applying.
    results,
  });
});

// ─── GET /api/opplevelser/admin/gardssalg-contact-coverage ───────────────────
//
// Slice 2 PREP of dev-request 2026-07-12-gardssalg-go-live-gate-dark-launch-
// og-onboarding: a contact-field coverage report over the seeded gårdssalg
// providers (rfb_seed_source = 'rfb-seed'), needed before drafting onboarding
// outreach. Unlike /admin/rfb-knowledge-enrich above (which reports what it
// WOULD copy from RFB), this reports raw current field presence.
//
// Read-only — a single SELECT, no writes. Privacy-minimized by design: never
// returns raw epost/telefon/hjemmeside/adresse values, only booleans/counts;
// the unreachable list carries just id+navn — enough to act on, nothing more.
router.get("/admin/gardssalg-contact-coverage", requireAdmin, (_req: Request, res: Response) => {
  const expDb = getExpDb("experiences");

  let providers: Array<{
    id: string;
    navn: string;
    epost: string | null;
    telefon: string | null;
    hjemmeside: string | null;
    adresse: string | null;
  }> = [];
  try {
    providers = expDb
      .prepare(
        `SELECT id, navn, epost, telefon, hjemmeside, adresse
           FROM experience_providers
          WHERE rfb_seed_source = 'rfb-seed'`
      )
      .all() as typeof providers;
  } catch (err) {
    console.error("[gardssalg-contact-coverage] failed to query providers:", err);
    res.status(500).json({ error: "Failed to query experience_providers" });
    return;
  }

  const present = (v: string | null): boolean => v !== null && v.trim() !== "";

  let withEmail = 0;
  let withPhone = 0;
  let withWebsite = 0;
  let withAddress = 0;
  let reachable = 0;
  const unreachable: Array<{ provider_id: string; navn: string }> = [];

  for (const p of providers) {
    const hasEmail = present(p.epost);
    const hasPhone = present(p.telefon);
    if (present(p.hjemmeside)) withWebsite++;
    if (present(p.adresse)) withAddress++;
    if (hasEmail) withEmail++;
    if (hasPhone) withPhone++;
    if (hasEmail || hasPhone) {
      reachable++;
    } else {
      unreachable.push({ provider_id: p.id, navn: p.navn });
    }
  }

  res.json({
    total_providers: providers.length,
    with_email: withEmail,
    with_phone: withPhone,
    with_website: withWebsite,
    with_address: withAddress,
    reachable,
    unreachable,
  });
});

// ─── GET /api/opplevelser/admin/gardssalg-outreach-readiness ─────────────────
//
// dev-request 2026-07-21-gardssalg-outreach-beredskapsrapport: an outreach-
// readiness report over EVERY gårdssalg provider — the same scoping WHERE
// clause listGardssalgProviders()/countGardssalgProviders() etc. use
// (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed'), but unlike
// those callers this deliberately does NOT add the "(catalog_hidden IS NULL
// OR catalog_hidden != 1)" clause they layer on top, and does NOT exclude
// content_source IN ('manual','claim') rows either: Daniel needs the WHOLE
// picture here (visible + hidden, auto-enriched + manually-claimed), never a
// silently-filtered subset. Hidden/claimed status is surfaced per-row
// (`visible`, `claim_status`) instead of used to drop rows.
//
// Read-only — a single SELECT, no writes, no LLM call, no outbound fetch:
// every field below is read straight off already-stored experience_providers
// columns and folded through the two pure helpers below (computeBookingStatus
// reuses booking-store's isBookingPaused() rather than re-deriving booking
// state; computeReadinessTier is a small pure function over booleans) — no
// network I/O anywhere in this handler, easy to confirm by inspection.
//
// booking_status reuses isBookingPaused() (services/booking-store.ts, already
// imported above for the public gårdssalg discover route) rather than
// inventing new booking-status logic. isBookingPaused() itself only returns a
// binary "blocked right now" signal (folding in the BOOKING_DISPATCH_ENABLED
// master switch); to recover the third "none" state (never onboarded at all,
// vs. onboarded-but-currently-paused) this combines it with the raw
// booking_live column, matching what routes/opplevelser.ts's discover
// endpoint and experiences-mcp.ts's discover_gardssalg already treat as
// "never onboarded" (booking_live !== 1) vs. "onboarded" underneath their own
// binary request/paused UI label.
type OutreachBookingStatus = "live" | "paused" | "none";

function computeBookingStatus(
  bookingLive: number | null,
  catalogHidden: number | null,
): OutreachBookingStatus {
  if (bookingLive !== 1) return "none";
  return isBookingPaused(bookingLive, catalogHidden) ? "paused" : "live";
}

// Deterministic, exhaustive tier assignment — every row gets EXACTLY one tier.
// Precedence (highest first), per the dev-request:
//   1. unreachable      — no email AND no phone: outreach is impossible no
//      matter how complete the content is, so this wins over everything else.
//   2. no_website        — (has a contact method, but) no website at all: an
//      outreach/claim candidate lacking a source to enrich from, not a
//      content-completeness gap.
//   3. needs_enrichment    — has a website and a contact method, but is
//      missing about_text/opening_hours_text/etc.
//   4. content-complete: would have been "outreach_ready" before dev-request
//      2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach, Steg 4 —
//      now gated by four further checks (skjult / ikke_soekbar /
//      nettsted_uverifisert / dublettkonflikt), see below.
export type GardssalgReadinessTier =
  | "outreach_ready"
  | "needs_enrichment"
  | "no_website"
  | "unreachable"
  | "skjult"
  | "ikke_soekbar"
  | "nettsted_uverifisert"
  | "dublettkonflikt";

export function computeGardssalgReadinessTier(input: {
  has_website: boolean;
  has_about_text: boolean;
  has_opening_hours: boolean;
  has_email: boolean;
  has_phone: boolean;
  catalog_hidden: boolean;
  is_searchable: boolean;
  website_verified: boolean;
  has_duplicate_conflict: boolean;
}): GardssalgReadinessTier {
  if (!input.has_email && !input.has_phone) return "unreachable";
  if (!input.has_website) return "no_website";
  if (!(input.has_about_text && input.has_opening_hours)) return "needs_enrichment";
  // Content-complete from here on — Steg 4 tightens "ready" beyond "fields
  // are non-empty" with four more checks, in this order:
  //   - catalog_hidden first: a hidden row is ALSO unsearchable by
  //     construction (search excludes catalog_hidden=1, see
  //     searchGardssalgProvidersByQuery()), so checking is_searchable first
  //     would make "skjult" dead code — and "hidden" is the more specific,
  //     actionable reason (an operator's deliberate choice) than the generic
  //     "not searchable".
  //   - then is_searchable, website_verified, has_duplicate_conflict, in the
  //     order Daniel specified: findable -> verified -> conflict-free.
  if (input.catalog_hidden) return "skjult";
  if (!input.is_searchable) return "ikke_soekbar";
  if (!input.website_verified) return "nettsted_uverifisert";
  if (input.has_duplicate_conflict) return "dublettkonflikt";
  return "outreach_ready";
}

// Extracted for dev-request
// 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach, Steg 5 (the
// outreach pre-flight gate): the per-row readiness computation used to live
// inline in the GET handler below. It is now a standalone function so the
// new POST pre-flight endpoint can reuse EXACTLY the same tiering logic —
// never a second, divergently-maintained copy of computeGardssalgReadinessTier
// or its inputs. `providerIds`, when given (non-empty array), narrows the
// returned ROWS to that id set via a parameter-bound `AND id IN (...)`
// clause (never string-interpolated — same discipline as the
// gardssalg-verified-drinkproducer-cohort route's DRINK_PRODUCER_TYPES query
// a few hundred lines below). The conflict scan itself is ALWAYS run
// unfiltered (full corpus) regardless of providerIds — duplicate-conflict
// detection needs the whole picture, only the returned rows are filtered.
function computeGardssalgReadinessRows(
  expDb: Database.Database,
  providerIds?: string[],
): Array<{
  id: string;
  name: string;
  org_nr: string | null;
  kommune: string | null;
  visible: boolean;
  claim_status: string | null;
  has_website: boolean;
  has_about_text: boolean;
  has_visit_text: boolean;
  has_opening_hours: boolean;
  has_products: boolean;
  has_email: boolean;
  has_phone: boolean;
  is_searchable: boolean;
  website_verified: boolean;
  has_duplicate_conflict: boolean;
  booking_status: OutreachBookingStatus;
  readiness_tier: GardssalgReadinessTier;
}> {
  let rows: Array<{
    id: string;
    navn: string;
    org_nr: string | null;
    kommune: string | null;
    hjemmeside: string | null;
    epost: string | null;
    telefon: string | null;
    about_text: string | null;
    visit_text: string | null;
    opening_hours_text: string | null;
    products: string | null;
    content_source: string | null;
    booking_live: number | null;
    catalog_hidden: number | null;
    slug: string | null;
    field_provenance: string | null;
  }> = [];

  // Same base gårdssalg scoping WHERE clause as listGardssalgProviders() et
  // al. (experience-store.ts) — producer_type set OR seeded via RFB — but
  // deliberately WITHOUT their catalog_hidden/content_source exclusions:
  // every row must appear exactly once here.
  let sql = `SELECT id, navn, org_nr, kommune, hjemmeside, epost, telefon,
                about_text, visit_text, opening_hours_text, products,
                content_source, booking_live, catalog_hidden, slug,
                field_provenance
           FROM experience_providers
          WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')`;
  const params: string[] = [];
  if (providerIds && providerIds.length > 0) {
    const placeholders = providerIds.map(() => "?").join(", ");
    sql += ` AND id IN (${placeholders})`;
    params.push(...providerIds);
  }

  rows = expDb.prepare(sql).all(...params) as typeof rows;

  const present = (v: string | null): boolean => v !== null && v.trim() !== "";

  // dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach,
  // Steg 4 — has_duplicate_conflict is computed from ONE scan over the whole
  // producer/experience corpus (O(providers × experiences)), never per-row,
  // then looked up per-row as an O(1) Set membership check below. Always run
  // UNFILTERED regardless of providerIds — conflict detection needs the
  // whole picture, not just the requested subset.
  const { pairs: conflictPairs } = runGardssalgExperienceConflictScan(expDb);
  const duplicateConflictProducerIds = new Set<string>();
  for (const pair of conflictPairs) {
    if (pair.status === "conflict" || pair.status === "ambiguous") {
      duplicateConflictProducerIds.add(pair.producer_id);
    }
  }

  return rows.map((p) => {
    const has_website = present(p.hjemmeside);
    const has_about_text = present(p.about_text);
    const has_visit_text = present(p.visit_text);
    const has_opening_hours = present(p.opening_hours_text);
    const has_products = present(p.products);
    const has_email = present(p.epost);
    const has_phone = present(p.telefon);
    const catalog_hidden = p.catalog_hidden === 1;
    // Mirrors searchGardssalgProvidersByQuery()'s (experience-store.ts) exact
    // predicate for whether a row can ever surface in /sok search.
    const is_searchable = !catalog_hidden && present(p.slug);
    const website_verified = isHjemmesideVerified(p.field_provenance);
    const has_duplicate_conflict = duplicateConflictProducerIds.has(p.id);

    const readiness_tier = computeGardssalgReadinessTier({
      has_website,
      has_about_text,
      has_opening_hours,
      has_email,
      has_phone,
      catalog_hidden,
      is_searchable,
      website_verified,
      has_duplicate_conflict,
    });

    return {
      id: p.id,
      name: p.navn,
      org_nr: p.org_nr,
      kommune: p.kommune,
      visible: p.catalog_hidden !== 1,
      claim_status: p.content_source,
      has_website,
      has_about_text,
      has_visit_text,
      has_opening_hours,
      has_products,
      has_email,
      has_phone,
      is_searchable,
      website_verified,
      has_duplicate_conflict,
      booking_status: computeBookingStatus(p.booking_live, p.catalog_hidden),
      readiness_tier,
    };
  });
}

router.get("/admin/gardssalg-outreach-readiness", requireAdmin, (_req: Request, res: Response) => {
  const expDb = getExpDb("experiences");

  let providers: ReturnType<typeof computeGardssalgReadinessRows>;
  try {
    providers = computeGardssalgReadinessRows(expDb);
  } catch (err) {
    console.error("[gardssalg-outreach-readiness] failed to query providers:", err);
    res.status(500).json({ error: "Failed to query experience_providers" });
    return;
  }

  const summary = {
    outreach_ready: 0,
    needs_enrichment: 0,
    no_website: 0,
    unreachable: 0,
    skjult: 0,
    ikke_soekbar: 0,
    nettsted_uverifisert: 0,
    dublettkonflikt: 0,
    total: 0,
  };
  for (const p of providers) {
    summary[p.readiness_tier]++;
    summary.total++;
  }

  res.json({ providers, summary });
});

// ─── POST /api/opplevelser/admin/gardssalg-outreach-preflight ───────────────
//
// dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach,
// Steg 5: given a caller-supplied batch of provider ids, answer GO/NO-GO per
// id for an outreach campaign — using EXACTLY the same tiering logic as GET
// /admin/gardssalg-outreach-readiness above (computeGardssalgReadinessRows /
// computeGardssalgReadinessTier), never a second, divergently-maintained
// copy. Purely read-only — one SELECT (narrowed to the requested ids) plus
// the full-corpus conflict scan, no writes, no outbound fetch, no LLM call;
// synchronous handler, same style as the sibling GET route above.
//
// Batch size is capped at 200 ids (mirrors the explicit-cap-then-400
// precedent already established by MAX_GARDSSALG_AUDIT_LIMIT /
// gardssalg-website-verification-audit above) — never silently truncated.
const MAX_GARDSSALG_PREFLIGHT_BATCH = 200;

router.post("/admin/gardssalg-outreach-preflight", requireAdmin, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { provider_ids?: unknown };
  const rawIds = body.provider_ids;

  if (
    !Array.isArray(rawIds) ||
    rawIds.length === 0 ||
    !rawIds.every((v) => typeof v === "string" && v.trim() !== "")
  ) {
    res.status(400).json({ error: "provider_ids must be a non-empty array of strings" });
    return;
  }
  if (rawIds.length > MAX_GARDSSALG_PREFLIGHT_BATCH) {
    res.status(400).json({ error: `provider_ids exceeds max batch size of ${MAX_GARDSSALG_PREFLIGHT_BATCH}` });
    return;
  }

  // Dedupe while preserving first-seen order — every requested id must
  // appear EXACTLY once in the response, in the order first seen in input.
  const seen = new Set<string>();
  const orderedIds: string[] = [];
  for (const rawId of rawIds as string[]) {
    if (!seen.has(rawId)) {
      seen.add(rawId);
      orderedIds.push(rawId);
    }
  }

  const expDb = getExpDb("experiences");
  try {
    const rows = computeGardssalgReadinessRows(expDb, orderedIds);
    const byId = new Map(rows.map((r) => [r.id, r]));

    let go = 0;
    let no_go = 0;
    const results = orderedIds.map((id) => {
      const row = byId.get(id);
      if (!row) {
        no_go++;
        return { provider_id: id, name: null, go: false, reason: "ikke_funnet" };
      }
      if (row.readiness_tier === "outreach_ready") {
        go++;
        return { provider_id: id, name: row.name, go: true, reason: null };
      }
      no_go++;
      return { provider_id: id, name: row.name, go: false, reason: row.readiness_tier };
    });

    res.json({ results, summary: { go, no_go, total: results.length } });
  } catch (err) {
    console.error("[gardssalg-outreach-preflight] failed:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── GET /api/opplevelser/admin/gardssalg-verified-drinkproducer-cohort ──────
//
// dev-request 2026-08-02-drikkesteder-hjemmeside-verifisert-kohort-berikelse,
// Step A prerequisite: the cohort of drink-producer providers (producer_type
// IN DRINK_PRODUCER_TYPES — services/route-corridor-service.ts) whose
// hjemmeside has already been ownership-verified (isHjemmesideVerified() on
// field_provenance.hjemmeside_verification, defined above — fails closed on
// anything short of a literal verified === true). Everything downstream of
// this list (content-refresh execution, field-concordance check,
// producer_type backfill, queue draining) is separate, later work.
//
// Deliberately NARROWER than the usual gårdssalg base clause used elsewhere
// in this file (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed'):
// an rfb-seed row with producer_type IS NULL must never appear here, because
// this cohort is drink-producer-type-specific by definition, not "any
// gårdssalg row". producer_type values are parameter-bound, never
// string-interpolated into the SQL.
//
// Read-only — a single SELECT, no writes, no LLM call, no outbound fetch;
// synchronous handler, matching gardssalg-outreach-readiness's handler above.
import { DRINK_PRODUCER_TYPES } from "../services/route-corridor-service";

router.get("/admin/gardssalg-verified-drinkproducer-cohort", requireAdmin, (_req: Request, res: Response) => {
  const expDb = getExpDb("experiences");

  const drinkTypes = Array.from(DRINK_PRODUCER_TYPES);
  const placeholders = drinkTypes.map(() => "?").join(", ");

  let rows: Array<{
    id: string;
    navn: string;
    producer_type: string | null;
    catalog_hidden: number | null;
    field_provenance: string | null;
  }> = [];
  try {
    rows = expDb
      .prepare(
        `SELECT id, navn, producer_type, catalog_hidden, field_provenance
           FROM experience_providers
          WHERE producer_type IN (${placeholders})`
      )
      .all(...drinkTypes) as typeof rows;
  } catch (err) {
    console.error("[gardssalg-verified-drinkproducer-cohort] failed to query providers:", err);
    res.status(500).json({ error: "Failed to query experience_providers" });
    return;
  }

  const total_drink_producer_rows = rows.length;

  const verifiedRows = rows.filter((p) => isHjemmesideVerified(p.field_provenance));

  let verified_visible = 0;
  let verified_hidden = 0;

  const cohort = verifiedRows.map((p) => {
    const visible = p.catalog_hidden !== 1;
    if (visible) verified_visible++;
    else verified_hidden++;
    return {
      id: p.id,
      name: p.navn,
      producer_type: p.producer_type,
      visible,
    };
  });

  res.json({
    success: true,
    summary: {
      total_drink_producer_rows,
      verified_visible,
      verified_hidden,
      verified_total: verified_visible + verified_hidden,
    },
    cohort,
  });
});

// ─── GET /api/opplevelser/admin/gardssalg-field-concordance-audit ───────────
//
// orchestrator dev-request 2026-08-03-gardssalg-field-concordance: for every
// producer in the verified drink-producer cohort (the SAME provider-id set
// GET /admin/gardssalg-verified-drinkproducer-cohort just above computes —
// producer_type IN DRINK_PRODUCER_TYPES AND isHjemmesideVerified(field_
// provenance), reused/mirrored here rather than re-derived, since that route
// itself has no exported cohort-loader function to call directly), compares
// epost/telefon/mobil/adresse/postnummer/poststed/opening_hours_text against
// what's actually findable on the producer's own already-verified homepage,
// and reports a per-field verdict (bekreftet / avvik / ikke_funnet_på_siden
// — see gardssalg-field-concordance.ts's own doc comment for the full rule).
//
// Fetch mechanism: crFetchGardssalgContent + gardssalgPageText, the SAME
// SSRF-guarded pipeline content-refresh/gardssalg-website-verification.ts
// already use — never a new fetch path. A fetch failure (or a cohort row
// with no usable hjemmeside at all — should not occur in practice since
// isHjemmesideVerified implies a hjemmeside was once verified, but handled
// defensively anyway) fails CLOSED: every field for that provider verdicts
// ikke_funnet_på_siden, never guessed, never thrown — a failure inside one
// producer's fetch must never crash or skip the rest of the batch.
//
// providerIds: optional filter, query-string (`?providerIds=id1,id2` or
// repeated `?providerIds=id1&providerIds=id2` — either form is accepted).
// Same validation discipline as POST /admin/gardssalg-outreach-preflight's
// own provider_ids batch (a few hundred lines above): parameter-bound
// `IN (...)` only, never string-interpolated; deduplicated preserving
// first-seen order; capped at MAX_GARDSSALG_FIELD_CONCORDANCE_BATCH with a
// 400 if exceeded. An id that doesn't resolve to a row in the drink-producer
// cohort (unknown id, or a real id just outside that cohort) is silently
// absent from the response rather than erroring — unlike outreach-preflight,
// this endpoint's contract is "a verdict per COHORT MEMBER", not "an answer
// per REQUESTED id", so there is no ikke_funnet-style placeholder row to
// synthesize for it; the acceptance bar is simply that it never crashes the
// rest of the batch, which the parameter-bound SQL already guarantees.
//
// Zero writes of any kind — no field_provenance stamp, no queue insert, no
// DB write whatsoever. This is a pure GET, purely diagnostic. The write side
// (queue + provenance stamp) is POST /admin/gardssalg-field-concordance-
// remediation, below — see its own doc comment.
const MAX_GARDSSALG_FIELD_CONCORDANCE_BATCH = 200;

// Thrown by runGardssalgFieldConcordanceScan when the cohort query itself
// fails (malformed SQL / DB error, not a page-fetch failure — those fail
// closed per-row inside buildProviderConcordanceRow and never throw). A
// dedicated class lets each route's own catch block recognize this ONE
// failure mode and reply with the same specific "Failed to query
// experience_providers" message the original (pre-refactor) GET route always
// gave, instead of collapsing into the generic "Internal error" every other
// unexpected failure gets.
class GfcQueryError extends Error {}

// Shared providerIds validation for both the GET audit route and the POST
// remediation route below — same discipline as POST /admin/gardssalg-
// outreach-preflight's own provider_ids batch: parameter-bound only (never
// string-interpolated — callers pass this straight into an `IN (...)`
// clause), deduplicated preserving first-seen order, capped at
// MAX_GARDSSALG_FIELD_CONCORDANCE_BATCH with a 400 if exceeded or if nothing
// usable survives trimming.
function parseGfcProviderIdsFilter(rawList: string[]): { ids: string[] } | { error: string } {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of rawList) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  if (ordered.length === 0) {
    return { error: "providerIds må inneholde minst én ikke-tom id." };
  }
  if (ordered.length > MAX_GARDSSALG_FIELD_CONCORDANCE_BATCH) {
    return { error: `providerIds overstiger maks batch-størrelse på ${MAX_GARDSSALG_FIELD_CONCORDANCE_BATCH}.` };
  }
  return { ids: ordered };
}

// Extracted from the original inline GET route body (dev-request 2026-08-03-
// gardssalg-field-concordance-write) so the write-side POST route below can
// run the EXACT same scan rather than duplicating the cohort query + fetch
// loop. Loads the verified drink-producer cohort (producer_type IN
// DRINK_PRODUCER_TYPES AND isHjemmesideVerified(field_provenance) —
// unchanged from before this refactor), fetches each producer's homepage via
// crFetchGardssalgContent/gardssalgPageText (the SAME SSRF-guarded pipeline
// content-refresh/website-verification already use), and builds each row via
// buildProviderConcordanceRow. Zero writes — this function itself never
// touches the DB beyond the initial SELECT.
async function runGardssalgFieldConcordanceScan(
  expDb: Database.Database,
  providerIdsFilter?: string[],
): Promise<{ providers: GfcProviderResult[] }> {
  const drinkTypes = Array.from(DRINK_PRODUCER_TYPES);
  const typePlaceholders = drinkTypes.map(() => "?").join(", ");

  let sql = `SELECT id, navn, hjemmeside, epost, telefon, mobil, adresse, postnummer, poststed,
                    opening_hours_text, field_provenance
               FROM experience_providers
              WHERE producer_type IN (${typePlaceholders})`;
  const params: string[] = [...drinkTypes];
  if (providerIdsFilter) {
    const idPlaceholders = providerIdsFilter.map(() => "?").join(", ");
    sql += ` AND id IN (${idPlaceholders})`;
    params.push(...providerIdsFilter);
  }
  sql += ` ORDER BY id`;

  let rows: Array<{
    id: string;
    navn: string;
    hjemmeside: string | null;
    epost: string | null;
    telefon: string | null;
    mobil: string | null;
    adresse: string | null;
    postnummer: string | null;
    poststed: string | null;
    opening_hours_text: string | null;
    field_provenance: string | null;
  }> = [];
  try {
    rows = expDb.prepare(sql).all(...params) as typeof rows;
  } catch (err) {
    console.error("[gardssalg-field-concordance-scan] failed to query providers:", err);
    throw new GfcQueryError("Failed to query experience_providers");
  }

  // Same fail-closed gate as GET /admin/gardssalg-verified-drinkproducer-
  // cohort above — verified === true only, never a truthy/ambiguous check.
  const cohort = rows.filter((p) => isHjemmesideVerified(p.field_provenance));

  const fetchFn: GsWvFetchFn = async (homepageUrl: string) => {
    const fetched = await crFetchGardssalgContent(homepageUrl);
    if (!fetched.ok) return { ok: false, reason: fetched.reason };
    return { ok: true, pageText: gardssalgPageText(fetched.combinedHtml) };
  };

  const providers: GfcProviderResult[] = [];
  for (let i = 0; i < cohort.length; i += CR_CONCURRENCY) {
    const slice = cohort.slice(i, i + CR_CONCURRENCY);
    const sliceResults = await Promise.all(
      slice.map(async (p) => {
        const hjemmeside = p.hjemmeside && p.hjemmeside.trim() !== "" ? p.hjemmeside.trim() : null;
        let pageText: string | null = null;
        if (hjemmeside) {
          try {
            const fetched = await fetchFn(hjemmeside);
            pageText = fetched.ok ? fetched.pageText : null;
          } catch {
            // fetchFn's own contract never throws in practice, but this
            // route treats a throw exactly like a reported failure —
            // fail-closed either way, never an uncaught rejection, never a
            // crashed batch.
            pageText = null;
          }
        }
        return buildProviderConcordanceRow(
          {
            id: p.id,
            navn: p.navn,
            epost: p.epost,
            telefon: p.telefon,
            mobil: p.mobil,
            adresse: p.adresse,
            postnummer: p.postnummer,
            poststed: p.poststed,
            opening_hours_text: p.opening_hours_text,
          },
          pageText,
        );
      }),
    );
    providers.push(...sliceResults);
  }

  return { providers };
}

router.get("/admin/gardssalg-field-concordance-audit", requireAdmin, async (req: Request, res: Response) => {
  const rawProviderIds = req.query.providerIds;
  let providerIdsFilter: string[] | undefined;
  if (rawProviderIds !== undefined) {
    const rawList: string[] = Array.isArray(rawProviderIds)
      ? (rawProviderIds as unknown[]).map((v) => String(v))
      : String(rawProviderIds).split(",");
    const parsed = parseGfcProviderIdsFilter(rawList);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    providerIdsFilter = parsed.ids;
  }

  const expDb = getExpDb("experiences");
  try {
    const { providers } = await runGardssalgFieldConcordanceScan(expDb, providerIdsFilter);
    res.json({
      success: true,
      count: providers.length,
      summary: summarizeGfc(providers),
      providers,
    });
  } catch (err) {
    if (err instanceof GfcQueryError) {
      res.status(500).json({ error: err.message });
      return;
    }
    console.error("[gardssalg-field-concordance-audit] failed:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── POST /api/opplevelser/admin/gardssalg-field-concordance-remediation ────
//
// orchestrator dev-request 2026-08-03-gardssalg-field-concordance (write-side
// slice): the WRITE side the read-only GET .../gardssalg-field-concordance-
// audit route above deliberately left out. Re-runs the EXACT same scan as
// GET (via the shared runGardssalgFieldConcordanceScan helper above — never
// duplicated) with an optional `providerIds` override (same validation as
// GET's own filter, see parseGfcProviderIdsFilter above) and an optional
// `batch_id` string recorded on any queue rows written.
//
// Dry-run (apply omitted/false — the default): ZERO writes. Reports
// `would_queue`: the avvik entries (epost/telefon/mobil only — the only
// avvik-capable fields) a real apply would upsert into
// gardssalg_field_concordance_review_queue. Lists every current avvik found
// by this scan, new or already-queued alike — dry-run is a preview of the
// scan's findings, not a diff against the queue's current contents.
//
// Apply: calls applyGardssalgFieldConcordance (services/gardssalg-field-
// concordance.ts) — for every scanned provider, read-modify-writes
// field_provenance.field_concordance (a verdict-only stamp; never touches
// hjemmeside_verification or any other existing provenance key), then
// upserts a gardssalg_field_concordance_review_queue row for every field
// whose verdict is exactly "avvik" (skipped if an identical pending entry
// already exists, for idempotent re-runs). Per the dev-request's own spec
// ("Ingen automatisk overskriving ved avvik"), this NEVER writes epost/
// telefon/mobil/adresse/postnummer/poststed/opening_hours_text on
// experience_providers directly, under any circumstance — see that
// function's own doc comment for the full write contract.
router.post("/admin/gardssalg-field-concordance-remediation", requireAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { apply?: unknown; providerIds?: unknown; batch_id?: unknown };
  const apply = body.apply === true || body.apply === 1 || body.apply === "1" || body.apply === "true";
  const batchId = typeof body.batch_id === "string" && body.batch_id.trim() ? body.batch_id.trim() : null;

  const rawProviderIds = body.providerIds;
  let providerIdsFilter: string[] | undefined;
  if (rawProviderIds !== undefined) {
    const rawList: string[] = Array.isArray(rawProviderIds)
      ? (rawProviderIds as unknown[]).map((v) => String(v))
      : String(rawProviderIds).split(",");
    const parsed = parseGfcProviderIdsFilter(rawList);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    providerIdsFilter = parsed.ids;
  }

  const expDb = getExpDb("experiences");
  try {
    const { providers } = await runGardssalgFieldConcordanceScan(expDb, providerIdsFilter);
    const summary = summarizeGfc(providers);

    if (!apply) {
      const would_queue: Array<{
        provider_id: string;
        field_name: GfcFieldName;
        current_value: string | null;
        found_value: string | null;
      }> = [];
      for (const p of providers) {
        for (const field of GFC_AVVIK_CAPABLE_FIELDS) {
          const cell = p[field];
          if (cell.verdict === "avvik") {
            would_queue.push({
              provider_id: p.provider_id,
              field_name: field,
              current_value: cell.current,
              found_value: cell.found,
            });
          }
        }
      }
      res.json({ success: true, dry_run: true, would_queue, summary });
      return;
    }

    const { applied, provenance_written, total_queued } = applyGardssalgFieldConcordance(expDb, providers, batchId);
    res.json({
      success: true,
      dry_run: false,
      provenance_written,
      queued: total_queued,
      applied,
      summary,
    });
  } catch (err) {
    if (err instanceof GfcQueryError) {
      res.status(500).json({ error: err.message });
      return;
    }
    console.error("[gardssalg-field-concordance-remediation] failed:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── GET /api/opplevelser/admin/gardssalg-provider-dedup-audit ───────────────
//
// dev-request 2026-07-31-gardssalg-provider-dubletter-på-tvers-av-seeds, slice
// 1 of 3 (audit only — no merge lever, no outreach-guard; those are separate
// future slices). Coverage measurement found that the SAME real-world
// producer can end up as two distinct experience_providers rows across
// different seed batches (rfb-seed vs NACE-discovery vs manual), e.g. a
// sparse row seeded early (often now homepage_unreachable_since-flagged) and
// a richer row discovered later with full contact info. There is no dedup
// mechanism for this table today; this is READ-ONLY groundwork for one.
//
// NOT the same table/endpoint as GET .../experiences-dedup-audit (the
// `activities`-table dedup audit) — that endpoint is untouched by this slice.
//
// Read-only — a single SELECT, no writes, no UPDATE/DELETE/merge of any row.
//
// Grouping signals (a group is any row whose id transitively connects to
// another row's id via one or more of these — union-find over all three):
//   1. org_nr        — both sides have a non-blank org_nr and it's equal.
//   2. domain         — both sides have a hjemmeside and its registrable
//                       domain (homepageRegistrableDomain — same helper the
//                       rest of this file's gårdssalg content-refresh/
//                       provenance code already uses on this exact column)
//                       is equal.
//   3. name           — scoreNameMatch (services/brreg-client.ts), the SAME
//                       name-dedup function this file's own NACE-discovery
//                       dedup already runs against gårdssalg rows (see
//                       listGardssalgNameDedupRows() call above), tried both
//                       on the raw navn and on the "— Sted"-suffix-stripped
//                       gardssalgSearchName() variant (so "X — By" still
//                       matches a bare "X"), keeping the higher score:
//                         score 1.0  -> "name_exact"            (high conf.)
//                         score 0.95 -> "name_first_token_postal" (high conf.
//                                       — first word matches AND same postal)
//                         score 0.80 -> "name_first_token"       (LOW conf.
//                                       — first word matches alone; e.g.
//                                       "Himkok" vs "Himkok Rtd" lands here:
//                                       genuinely ambiguous — could be the
//                                       same producer re-seeded, or a
//                                       deliberately distinct product line —
//                                       surfaced for human judgment, never
//                                       silently merged or silently dropped)
//
// A row-pair comparison is O(n²) in the worst case, so name-matching first
// buckets rows by the normalised first token of gardssalgSearchName(navn)
// (exactly the token scoreNameMatch's own first-token tier keys off) and
// only scores pairs within the same bucket.
//
// Privacy: same minimization convention as gardssalg-contact-coverage/
// gardssalg-provider-lookup above — no raw epost/telefon/hjemmeside value is
// ever returned, only booleans (has_email/has_phone) and the matching
// SIGNAL NAMES (not the raw domain string). org_nr is returned raw, matching
// gardssalg-outreach-readiness's existing precedent (a public Brreg registry
// number, not a contact channel).
type GsDedupNameTier = "name_exact" | "name_first_token_postal" | "name_first_token";
const GS_DEDUP_HIGH_CONF_NAME_TIERS: ReadonlySet<GsDedupNameTier> = new Set([
  "name_exact",
  "name_first_token_postal",
]);

function gsDedupNameTierForScore(score: number): GsDedupNameTier | null {
  if (score >= 1.0) return "name_exact";
  if (score >= 0.95) return "name_first_token_postal";
  if (score >= 0.8) return "name_first_token";
  return null;
}

interface GsDedupRow {
  id: string;
  navn: string;
  org_nr: string | null;
  hjemmeside: string | null;
  epost: string | null;
  telefon: string | null;
  postnummer: string | null;
  rfb_seed_source: string | null;
  producer_type: string | null;
  content_source: string | null;
  homepage_unreachable_since: string | null;
}

// Best (highest-tier) name-match between two rows, trying both the raw navn
// and the dash-suffix-stripped gardssalgSearchName() variant — pure, exported
// for tests.
export function gsDedupBestNameTier(a: GsDedupRow, b: GsDedupRow): GsDedupNameTier | null {
  const raw = scoreNameMatch(a.navn, b.navn, a.postnummer, b.postnummer);
  const stripped = scoreNameMatch(
    gardssalgSearchName(a.navn),
    gardssalgSearchName(b.navn),
    a.postnummer,
    b.postnummer,
  );
  return gsDedupNameTierForScore(Math.max(raw, stripped));
}

// Minimal union-find, scoped to this route.
class GsDedupUnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

const gsDedupPresent = (v: string | null): boolean => v !== null && v.trim() !== "";

router.get("/admin/gardssalg-provider-dedup-audit", requireAdmin, (_req: Request, res: Response) => {
  const expDb = getExpDb("experiences");

  let rows: GsDedupRow[] = [];
  try {
    rows = expDb
      .prepare(
        // Same base gårdssalg scoping as the other admin gårdssalg reports
        // (producer_type set OR seeded via rfb-seed), minus the hidden
        // booking-flyt-v1 synthetic test provider (excluded the same way
        // gardssalgSharedHostCounts() excludes it above) — a fixed test row
        // must never surface as a "duplicate candidate".
        `SELECT id, navn, org_nr, hjemmeside, epost, telefon, postnummer,
                rfb_seed_source, producer_type, content_source, homepage_unreachable_since
           FROM experience_providers
          WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
            AND (producer_type IS NULL OR producer_type != 'test-gardssalg')`
      )
      .all() as GsDedupRow[];
  } catch (err) {
    console.error("[gardssalg-provider-dedup-audit] failed to query providers:", err);
    res.status(500).json({ error: "Failed to query experience_providers" });
    return;
  }

  const uf = new GsDedupUnionFind(rows.length);

  // ── Signal 1: org_nr (both sides set, equal) ────────────────────────────
  const orgNrBuckets = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const v = r.org_nr && r.org_nr.trim();
    if (!v) return;
    const list = orgNrBuckets.get(v) ?? [];
    list.push(i);
    orgNrBuckets.set(v, list);
  });
  for (const idxs of orgNrBuckets.values()) {
    for (let k = 1; k < idxs.length; k++) uf.union(idxs[0], idxs[k]);
  }

  // ── Signal 2: registrable website domain (both sides set, equal) ───────
  const domainBuckets = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const d = homepageRegistrableDomain(r.hjemmeside);
    if (!d) return;
    const list = domainBuckets.get(d) ?? [];
    list.push(i);
    domainBuckets.set(d, list);
  });
  for (const idxs of domainBuckets.values()) {
    for (let k = 1; k < idxs.length; k++) uf.union(idxs[0], idxs[k]);
  }

  // ── Signal 3: name (bucketed by first-token, then scored pairwise) ─────
  const nameBuckets = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const key = normaliseName(gardssalgSearchName(r.navn)).split(" ")[0] ?? "";
    if (!key) return;
    const list = nameBuckets.get(key) ?? [];
    list.push(i);
    nameBuckets.set(key, list);
  });
  for (const idxs of nameBuckets.values()) {
    for (let x = 0; x < idxs.length; x++) {
      for (let y = x + 1; y < idxs.length; y++) {
        if (gsDedupBestNameTier(rows[idxs[x]], rows[idxs[y]])) uf.union(idxs[x], idxs[y]);
      }
    }
  }

  // ── Collect connected components ────────────────────────────────────────
  const componentsByRoot = new Map<number, number[]>();
  rows.forEach((_, i) => {
    const root = uf.find(i);
    const list = componentsByRoot.get(root) ?? [];
    list.push(i);
    componentsByRoot.set(root, list);
  });

  const toRowOut = (r: GsDedupRow) => ({
    id: r.id,
    navn: r.navn,
    org_nr: r.org_nr,
    rfb_seed_source: r.rfb_seed_source,
    producer_type: r.producer_type,
    content_source: r.content_source,
    has_email: gsDedupPresent(r.epost),
    has_phone: gsDedupPresent(r.telefon),
    unreachable: r.homepage_unreachable_since !== null,
    homepage_unreachable_since: r.homepage_unreachable_since,
  });

  const groups: Array<{
    signals: string[];
    confidence: "high" | "low";
    rows: ReturnType<typeof toRowOut>[];
  }> = [];

  for (const idxs of componentsByRoot.values()) {
    if (idxs.length < 2) continue;
    // Re-derive which signal(s) fired for AT LEAST one pair in this group —
    // groups are small (a handful of rows at most), so re-checking every
    // pair here (rather than threading evidence through the union-find
    // above) is cheap and keeps the "why grouped" logic in one place.
    const signals = new Set<string>();
    let highConfidence = false;
    for (let x = 0; x < idxs.length; x++) {
      for (let y = x + 1; y < idxs.length; y++) {
        const a = rows[idxs[x]];
        const b = rows[idxs[y]];
        const orgA = a.org_nr && a.org_nr.trim();
        const orgB = b.org_nr && b.org_nr.trim();
        if (orgA && orgB && orgA === orgB) {
          signals.add("org_nr");
          highConfidence = true;
        }
        const domA = homepageRegistrableDomain(a.hjemmeside);
        const domB = homepageRegistrableDomain(b.hjemmeside);
        if (domA && domB && domA === domB) {
          signals.add("domain");
          highConfidence = true;
        }
        const tier = gsDedupBestNameTier(a, b);
        if (tier) {
          signals.add(tier);
          if (GS_DEDUP_HIGH_CONF_NAME_TIERS.has(tier)) highConfidence = true;
        }
      }
    }
    groups.push({
      signals: Array.from(signals),
      confidence: highConfidence ? "high" : "low",
      rows: idxs.map((i) => toRowOut(rows[i])),
    });
  }

  res.json({
    total_providers_scanned: rows.length,
    groups_found: groups.length,
    groups,
  });
});

// ─── GET /api/opplevelser/admin/gardssalg-experience-conflict-audit ─────────
//
// dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach,
// Steg 2 (Part A — dry-run diagnosis, read-only). See the module doc comment
// in services/gardssalg-experience-conflict.ts for the full matching design
// and how this differs from lokal#440's GET /admin/gardssalg-provider-dedup-
// audit just above (same-table producer dedup — untouched by this endpoint).
//
// For every gårdssalg producer (catalog_hidden is noted per-row via
// `producer_hidden`, never used to exclude a producer from the scan — task
// spec), finds `experiences` catalog rows that plausibly describe the SAME
// real-world business and reports whether that experience's booking_url
// conflicts with, agrees with, or leaves unknown the producer's verified
// hjemmeside. Pure read: runGardssalgExperienceConflictScan() only SELECTs,
// no UPDATE/INSERT anywhere on this path.
// `ambiguous_detail` (dev-request 2026-08-01-gardssalg-steg2-apply-tar-ikke-
// varig-effekt, gjenstående scope §4): purely additive, derived from the SAME
// `pairs` array below by grouping status==="ambiguous" rows by experience_id
// (buildAmbiguousExperienceDetail, services/gardssalg-experience-conflict.ts)
// — no second scan, no new SQL. Surfaces the "N producers collide on one
// experience, remediation will never auto-fix this" cases (Atlungstad is the
// concrete one) that were previously just flat rows indistinguishable from
// any other pair.
router.get("/admin/gardssalg-experience-conflict-audit", requireAdmin, (_req: Request, res: Response) => {
  const expDb = getExpDb("experiences");
  try {
    const { pairs, summary } = runGardssalgExperienceConflictScan(expDb);
    res.json({
      summary,
      pairs: pairs.map((p) => ({
        producer_id: p.producer_id,
        producer_name: p.producer_name,
        producer_hidden: p.producer_hidden,
        producer_hjemmeside: p.producer_hjemmeside,
        experience_id: p.experience_id,
        experience_title: p.experience_title,
        experience_booking_url: p.experience_booking_url,
        match_basis: p.match_basis,
        status: p.status,
      })),
      ambiguous_detail: buildAmbiguousExperienceDetail(pairs),
    });
  } catch (err) {
    console.error("[gardssalg-experience-conflict-audit] failed:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── POST /api/opplevelser/admin/gardssalg-experience-conflict-remediation ──
//
// dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach,
// Steg 2 (Part B — write, dry-run by default). Re-runs the SAME diagnosis
// scan as GET .../gardssalg-experience-conflict-audit above (never trusts a
// client-supplied pair list — same "recompute from live DB state" discipline
// as POST /admin/gardssalg-content-rollback's own planner), filters to
// status==="conflict" pairs ONLY (agree/unknown pairs are never written —
// planGardssalgExperienceConflictRemediation doesn't even see them), and for
// each: corrects experiences.booking_url to the producer's verified
// hjemmeside, or nulls it when copying that hjemmeside would itself be
// unsafe (aggregator/directory host) — see the doc comment on
// planGardssalgExperienceConflictRemediation (services/gardssalg-experience-
// conflict.ts) for the exact rule. Never leaves a row in conflict.
//
// apply: dry-run by default (same convention as every other admin write
// route in this file, e.g. POST /admin/gardssalg-content-rollback just
// below). apply=false/omitted performs zero writes.
// batch_id: optional caller-supplied tag, stamped on every
// experience_provider_conflict_audit row this call inserts — the SAME lever
// POST /admin/gardssalg-content-rollback's batch_id targeting already uses,
// just against this table (pass entity_type: "experience" there — see that
// endpoint below).
//
// Response shape — dry-run vs apply are DELIBERATELY DIFFERENT (dev-request
// 2026-08-01-gardssalg-steg2-apply-tar-ikke-varig-effekt: a P0 caused in part
// by a dry-run response being byte-for-byte the same shape as an apply
// response, so a caller reading `.applied.length` reported "137 corrected"
// off a call that wrote nothing):
//   - dry_run=true  -> { success, dry_run: true,  planned: [...], applied: [],       skipped }
//   - apply=true    -> { success, dry_run: false, planned: [],    applied: [...],    skipped,
//                        verified_written, verification_mismatches: [...] }
// `planned` and `applied` share the SAME item shape (experience_id,
// producer_id, current_value, would_write/new_value, action) — only the key
// name differs, on purpose, so `.applied.length` reads 0 on a dry-run instead
// of silently reporting the plan as if it were a completed write.
router.post("/admin/gardssalg-experience-conflict-remediation", requireAdmin, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { apply?: unknown; batch_id?: unknown };
  const apply = body.apply === true || body.apply === 1 || body.apply === "1" || body.apply === "true";
  const batchId = typeof body.batch_id === "string" && body.batch_id.trim() ? body.batch_id.trim() : null;

  const expDb = getExpDb("experiences");
  try {
    const { pairs } = runGardssalgExperienceConflictScan(expDb);
    const conflicting: GsExpMatchedPair[] = pairs.filter((p) => p.status === "conflict");
    const { applicable, skipped } = planGardssalgExperienceConflictRemediation(expDb, conflicting);

    if (!apply) {
      res.json({
        success: true,
        dry_run: true,
        planned: applicable.map((item) => ({
          experience_id: item.experience_id,
          producer_id: item.producer_id,
          current_value: item.old_value,
          would_write: item.new_value,
          action: item.action,
        })),
        applied: [],
        skipped,
      });
      return;
    }

    const applied = applyGardssalgExperienceConflictRemediation(
      expDb,
      applicable as GsExpConflictPlanItem[],
      batchId
    );

    // Post-apply read-back (dev-request 2026-08-01-gardssalg-steg2-apply-tar-
    // ikke-varig-effekt, gjenstående scope §3): the transaction above already
    // committed — this re-reads the CURRENT DB state for every row just
    // written and compares it against what was supposed to land. A write
    // that did not land, or did not STAY landed, must not be reported as a
    // plain success.
    const { verified_written, mismatches } = verifyGardssalgExperienceConflictWrites(expDb, applied);
    if (mismatches.length > 0) {
      console.error(
        "[gardssalg-experience-conflict-remediation] post-apply verification found mismatches:",
        mismatches
      );
      res.status(500).json({
        success: false,
        dry_run: false,
        planned: [],
        applied,
        skipped,
        verified_written,
        verification_mismatches: mismatches,
      });
      return;
    }

    res.json({
      success: true,
      dry_run: false,
      planned: [],
      applied,
      skipped,
      verified_written,
      verification_mismatches: [],
    });
  } catch (err) {
    console.error("[gardssalg-experience-conflict-remediation] failed:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── GET /api/opplevelser/admin/gardssalg-website-verification-audit ────────
//
// dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach,
// Steg 3 (scoped-down slice — Part A, read-only). For every producer in the
// outreach cohort (same base WHERE as GET /admin/gardssalg-outreach-readiness
// AND catalog_hidden != 1 — see loadGardssalgWebsiteVerificationCohort's own
// doc comment, services/gardssalg-website-verification.ts), classifies the
// stored hjemmeside as verified / unverified / aggregator / missing_source.
// A page IS fetched here (via crFetchGardssalgContent, the SAME SSRF-guarded
// crawler content-refresh/retro-scan already use) for anything that isn't
// already missing_source/aggregator — this is the one gårdssalg admin GET in
// this file that makes outbound network calls, same as
// POST .../gardssalg-website-discovery already does; it performs ZERO
// database writes either way.
//
// MAX_GARDSSALG_AUDIT_LIMIT: `limit` (added just above, dev-request
// 2026-08-02-opplevagent-hjemmesideverifisering-og-enrichment-gate Steg 1)
// still needed a hard server-side ceiling — a large-but-"valid" positive
// integer reproduces the exact unbounded-scan risk (PR #432) the pagination
// itself exists to avoid. Live measurement on today's 87-row cohort:
// ?limit=5 (2 CR_CONCURRENCY batches) ~7.8s, but ?limit=20 (7 batches)
// ~77.4s — already past this route's 60s target, and the per-batch cost
// grew FASTER than linearly (~3.9s/batch at limit=5 vs. ~11s/batch at
// limit=20), so per-row cost is not safely extrapolable to a big ceiling.
// 12 (= 4 full CR_CONCURRENCY batches) sits well clear of the only
// measured-safe point (5) and, per that observed growth curve, projects to
// roughly 40-45s worst case — comfortably under 60s, not just barely under.
const MAX_GARDSSALG_AUDIT_LIMIT = 12;

router.get("/admin/gardssalg-website-verification-audit", requireAdmin, async (req: Request, res: Response) => {
  const expDb = getExpDb("experiences");
  // scope=visible (default) | hidden | all — Daniel's 2026-08-01 live
  // override: verification covers ALL harvested producers, hidden included
  // (see loadGardssalgWebsiteVerificationCohort's doc comment for why the
  // default stays "visible" and why verifying hidden rows exposes nothing).
  // STRICTLY validated: an unknown value is a 400, never a silent fallback —
  // a caller who typos `scope=al` must not walk away believing they scanned
  // everything when they scanned the visible cohort.
  const rawScope = req.query.scope;
  const scope: GsWvScope = rawScope === undefined ? "visible" : (rawScope as GsWvScope);
  if (rawScope !== undefined && !GS_WV_SCOPES.includes(scope)) {
    res.status(400).json({ error: `Ugyldig scope — må være en av: ${GS_WV_SCOPES.join(", ")}` });
    return;
  }
  // cohort=gardssalg (default) | all — Steg 2 of dev-request 2026-08-02-
  // opplevagent-hjemmesideverifisering-og-enrichment-gate. A SEPARATE axis
  // from `scope` above (visibility) — this one decides WHICH producer types
  // are in the cohort at all (see loadGardssalgWebsiteVerificationCohort's
  // own doc comment). STRICTLY validated, same discipline as `scope`: an
  // unknown value is a 400, never a silent fallback.
  const rawCohort = req.query.cohort;
  const cohortParam: GsWvCohort = rawCohort === undefined ? "gardssalg" : (rawCohort as GsWvCohort);
  if (rawCohort !== undefined && !GS_WV_COHORTS.includes(cohortParam)) {
    res.status(400).json({ error: `Ugyldig cohort — må være en av: ${GS_WV_COHORTS.join(", ")}` });
    return;
  }
  // Steg 1 of dev-request 2026-08-02-opplevagent-hjemmesideverifisering-og-
  // enrichment-gate: optional `limit`/`offset` so a caller can page through
  // the cohort instead of forcing this route to fetch every producer's live
  // homepage in one HTTP request — the cohort is ~87 rows today, but Steg 2
  // widens it to the full experience_providers table (thousands of rows),
  // and an unbounded synchronous scan at that size is exactly the timeout/
  // event-loop-stall risk PR #432 already burned this codebase on once.
  // Both are strictly validated (never a silent clamp/default) — same
  // discipline as `scope` immediately above. `offset` without `limit` is
  // ALSO invalid: there is no sane default page size to guess, and silently
  // picking one would make `?offset=50` alone quietly behave nothing like
  // what its caller asked for.
  let limit: number | undefined;
  let offset: number | undefined;
  if (req.query.limit !== undefined) {
    const rawLimit = String(req.query.limit);
    const parsedLimit = Number(rawLimit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      res.status(400).json({ error: "Ugyldig limit — må være et positivt heltall." });
      return;
    }
    if (parsedLimit > MAX_GARDSSALG_AUDIT_LIMIT) {
      res.status(400).json({ error: `Ugyldig limit — maks er ${MAX_GARDSSALG_AUDIT_LIMIT}.` });
      return;
    }
    limit = parsedLimit;
  }
  if (req.query.offset !== undefined) {
    const rawOffset = String(req.query.offset);
    const parsedOffset = Number(rawOffset);
    if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
      res.status(400).json({ error: "Ugyldig offset — må være et ikke-negativt heltall." });
      return;
    }
    offset = parsedOffset;
  }
  if (limit === undefined && offset !== undefined) {
    res.status(400).json({ error: "Ugyldig offset — må være et ikke-negativt heltall." });
    return;
  }
  // MANDATORY pagination when cohort=all: that cohort drops the gårdssalg
  // producer-type restriction entirely, so it can be 1000+ rows platform-
  // wide (vs. today's ~87-row gårdssalg cohort) — the unbounded (`limit`
  // absent) synchronous-scan code path immediately above exists ONLY so the
  // default cohort=gardssalg stays byte-for-byte backward compatible for
  // callers who never paginate; at cohort=all scale it reproduces exactly
  // the timeout/event-loop-stall risk (PR #432) `limit`/MAX_GARDSSALG_AUDIT_
  // LIMIT were added to prevent. Checked BEFORE any DB load or fetch.
  if (cohortParam === "all" && limit === undefined) {
    res.status(400).json({
      error: "Ugyldig — limit er påkrevd når cohort=all (kohorten er for stor for et enkelt kall uten paginering).",
    });
    return;
  }
  try {
    const fetchFn: GsWvFetchFn = async (homepageUrl: string) => {
      const fetched = await crFetchGardssalgContent(homepageUrl);
      if (!fetched.ok) return { ok: false, reason: fetched.reason };
      return { ok: true, pageText: gardssalgPageText(fetched.combinedHtml) };
    };
    const cohortRows = loadGardssalgWebsiteVerificationCohort(expDb, scope, cohortParam);

    if (limit === undefined) {
      // No pagination requested: byte-for-byte identical behavior/response
      // shape to before this slice — the cohort's new ORDER BY doesn't
      // change WHICH rows come back, only their order, so this branch's
      // output is unaffected. (cohort=all can never reach here — rejected
      // above — so this unbounded path only ever runs for cohort=gardssalg,
      // same as before this slice existed.)
      const { summary, rows } = await scanGardssalgWebsiteVerificationRows(cohortRows, fetchFn, CR_CONCURRENCY);
      res.json({ success: true, scope, cohort: cohortParam, summary, rows });
      return;
    }

    const pageOffset = offset ?? 0;
    const page = cohortRows.slice(pageOffset, pageOffset + limit);
    const { summary, rows } = await scanGardssalgWebsiteVerificationRows(page, fetchFn, CR_CONCURRENCY);
    const total = cohortRows.length;
    const returned = rows.length;
    const nextOffset = pageOffset + returned < total ? pageOffset + returned : null;
    res.json({
      success: true,
      scope,
      cohort: cohortParam,
      summary,
      rows,
      pagination: { total, offset: pageOffset, limit, returned, next_offset: nextOffset },
    });
  } catch (err) {
    console.error("[gardssalg-website-verification-audit] failed:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── POST /api/opplevelser/admin/gardssalg-website-verification-remediation ─
//
// dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach,
// Steg 3 (scoped-down slice — Part B, write, dry-run by default). Re-runs
// the SAME classification as GET .../gardssalg-website-verification-audit
// above by default (recomputes live — never trusts a client-supplied result
// set for the bulk sweep), with an optional `providerIds` override to
// re-target specific producers only (same precedent as
// POST /admin/gardssalg-website-discovery's own providerIds override) —
// the default/no-body case always recomputes the full live cohort.
//
// Dry-run (apply omitted/false): zero DB writes, reports would_enqueue (the
// "unverified" rows that a real apply would add to the review queue).
// Apply: for every scanned row (ALL classifications, not just unverified),
// read-modify-writes field_provenance.hjemmeside_verification + inserts one
// gardssalg_website_verification_audit row; additionally, for "unverified"
// rows only, upserts gardssalg_website_review_queue with reason
// "verification_failed" (skipped if an identical pending entry already
// exists, for idempotent re-runs) — see applyGardssalgWebsiteVerification's
// own doc comment (services/gardssalg-website-verification.ts) for the full
// write contract.
//
// cohort/limit/offset (dev-request 2026-08-02-opplevagent-hjemmeside-
// verifisering-og-enrichment-gate, Steg 2b): the SAME `cohort` + pagination
// discipline as the GET audit route above, read from the request BODY (this
// is a POST) instead of the query string — see that route's own doc comment
// for the full rationale (MAX_GARDSSALG_AUDIT_LIMIT, mandatory pagination at
// cohort=all). Reusing the same constant is deliberate: this route performs
// the same per-row live outbound fetch as the GET route, so it carries
// exactly the same PR #432 unbounded-scan risk at scale — an earlier gap
// here (cohort hardcoded to "gardssalg", no limit/offset) was safe only
// because the gårdssalg cohort itself is small (~87 rows). Paginating BEFORE
// the scan also bounds `apply=true`'s blast radius to the paged rows only.
router.post("/admin/gardssalg-website-verification-remediation", requireAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    apply?: unknown;
    providerIds?: unknown;
    batch_id?: unknown;
    scope?: unknown;
    cohort?: unknown;
    limit?: unknown;
    offset?: unknown;
  };
  const apply = body.apply === true || body.apply === 1 || body.apply === "1" || body.apply === "true";
  const batchId = typeof body.batch_id === "string" && body.batch_id.trim() ? body.batch_id.trim() : null;
  // Same scope contract and strict validation as the GET audit route above —
  // and the same reason: a typo silently narrowing an APPLY to the visible
  // cohort is worse than the read-only case, because the caller then stamps
  // provenance on a third of the base believing they covered all of it.
  const rawScope = body.scope;
  const scope: GsWvScope = rawScope === undefined ? "visible" : (rawScope as GsWvScope);
  if (rawScope !== undefined && !GS_WV_SCOPES.includes(scope)) {
    res.status(400).json({ error: `Ugyldig scope — må være en av: ${GS_WV_SCOPES.join(", ")}` });
    return;
  }
  // cohort=gardssalg (default) | all — same axis/discipline as the GET audit
  // route above (dev-request 2026-08-02-opplevagent-hjemmesideverifisering-
  // og-enrichment-gate, Steg 2b): a SEPARATE axis from `scope` (visibility),
  // decides WHICH producer types are eligible at all. Read from the BODY
  // (this is a POST), never silently falling back on an unrecognized value.
  const rawCohort = body.cohort;
  const cohortParam: GsWvCohort = rawCohort === undefined ? "gardssalg" : (rawCohort as GsWvCohort);
  if (rawCohort !== undefined && !GS_WV_COHORTS.includes(cohortParam)) {
    res.status(400).json({ error: `Ugyldig cohort — må være en av: ${GS_WV_COHORTS.join(", ")}` });
    return;
  }
  // limit/offset — same contract, same MAX_GARDSSALG_AUDIT_LIMIT ceiling, and
  // the same reason as the GET audit route: this route scans the ENTIRE
  // loaded cohort synchronously with a live outbound fetch per row, so an
  // unbounded cohort=all sweep here reproduces the exact PR #432 hang class.
  // Read from the body, not the query string, since this is a POST.
  let limit: number | undefined;
  let offset: number | undefined;
  if (body.limit !== undefined) {
    const parsedLimit = Number(body.limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      res.status(400).json({ error: "Ugyldig limit — må være et positivt heltall." });
      return;
    }
    if (parsedLimit > MAX_GARDSSALG_AUDIT_LIMIT) {
      res.status(400).json({ error: `Ugyldig limit — maks er ${MAX_GARDSSALG_AUDIT_LIMIT}.` });
      return;
    }
    limit = parsedLimit;
  }
  if (body.offset !== undefined) {
    const parsedOffset = Number(body.offset);
    if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
      res.status(400).json({ error: "Ugyldig offset — må være et ikke-negativt heltall." });
      return;
    }
    offset = parsedOffset;
  }
  if (limit === undefined && offset !== undefined) {
    res.status(400).json({ error: "Ugyldig offset — må være et ikke-negativt heltall." });
    return;
  }
  // Mandatory pagination at scale — same rule as the GET audit route:
  // cohort=all can be 1000+ rows platform-wide, so the unbounded (`limit`
  // absent) synchronous-scan path stays reachable ONLY for the default
  // cohort=gardssalg, preserving today's byte-for-byte behavior for callers
  // who never pass a body at all. Checked before any DB load or fetch.
  if (cohortParam === "all" && limit === undefined) {
    res.status(400).json({
      error: "Ugyldig — limit er påkrevd når cohort=all (kohorten er for stor for et enkelt kall uten paginering).",
    });
    return;
  }

  const expDb = getExpDb("experiences");
  try {
    const fetchFn: GsWvFetchFn = async (homepageUrl: string) => {
      const fetched = await crFetchGardssalgContent(homepageUrl);
      if (!fetched.ok) return { ok: false, reason: fetched.reason };
      return { ok: true, pageText: gardssalgPageText(fetched.combinedHtml) };
    };

    let cohort = loadGardssalgWebsiteVerificationCohort(expDb, scope, cohortParam);
    if (Array.isArray(body.providerIds) && body.providerIds.length > 0) {
      const idSet = new Set(
        (body.providerIds as unknown[])
          .filter((v): v is string => typeof v === "string" && v.trim() !== "")
          .map((v) => v.trim())
      );
      cohort = cohort.filter((p) => idSet.has(p.id));
    }

    // Paginate BEFORE scanning — mirrors the GET audit route's own
    // `cohortRows.slice(pageOffset, pageOffset + limit)` pattern, so only the
    // requested page ever incurs a live outbound fetch, and (for apply=true)
    // only the paged rows are ever written — the blast radius of a single
    // call is bounded by `limit`, never the full (possibly cohort=all) set.
    const total = cohort.length;
    let pageOffset: number | undefined;
    if (limit !== undefined) {
      pageOffset = offset ?? 0;
      cohort = cohort.slice(pageOffset, pageOffset + limit);
    }

    const { summary, rows } = await scanGardssalgWebsiteVerificationRows(cohort, fetchFn, CR_CONCURRENCY);
    const pagination =
      limit === undefined
        ? undefined
        : {
            total,
            offset: pageOffset as number,
            limit,
            returned: rows.length,
            next_offset: (pageOffset as number) + rows.length < total ? (pageOffset as number) + rows.length : null,
          };

    if (!apply) {
      const { wouldEnqueue } = planGardssalgWebsiteVerificationRemediation(rows);
      res.json({
        success: true,
        dry_run: true,
        scope,
        cohort: cohortParam,
        would_enqueue: wouldEnqueue,
        summary,
        ...(pagination ? { pagination } : {}),
      });
      return;
    }

    const { applied } = applyGardssalgWebsiteVerification(expDb, rows, batchId);
    res.json({
      success: true,
      dry_run: false,
      scope,
      cohort: cohortParam,
      enqueued: applied.filter((a) => a.enqueued).length,
      provenance_written: applied.length,
      summary,
      ...(pagination ? { pagination } : {}),
    });
  } catch (err) {
    console.error("[gardssalg-website-verification-remediation] failed:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── POST /api/opplevelser/admin/gardssalg-owner-lock-backfill ──────────────
//
// dev-request 2026-07-30-opplevagent-claim-epost-og-perfelt-laas, item 3
// (scoped-down slice — see this route's own scoping note at the top of
// gardssalg-claim.ts's updateClaimedProviderProfile, which now stamps
// field_provenance.owner_locks.<field> GOING FORWARD on every new owner
// edit). This is the one-time catch-up for owner edits that happened
// BEFORE that forward-stamping existed: it reads gardssalg_content_audit
// (changed_by='owner') and back-fills the same owner_locks entries from
// that historical trail — see backfillGardssalgOwnerLockProvenance's own
// doc comment (services/gardssalg-claim.ts) for the full write contract,
// including why it is idempotent (a field whose owner_locks entry already
// exists — from a prior run of this route OR from the forward-stamping
// path — is left untouched and counted under already_stamped, never
// rewritten/re-dated).
//
// Dry-run (apply omitted/false, same convention as every other gårdssalg
// admin write route in this file, e.g. POST .../gardssalg-website-
// verification-remediation just above): performs the exact same scan/merge
// logic but skips the final UPDATE — literally zero DB writes — and reports
// would_stamp instead of stamped.
router.post("/admin/gardssalg-owner-lock-backfill", requireAdmin, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { apply?: unknown };
  const apply = body.apply === true || body.apply === 1 || body.apply === "1" || body.apply === "true";
  try {
    const result = backfillGardssalgOwnerLockProvenance(apply);
    if (!apply) {
      res.json({
        success: true,
        dry_run: true,
        scanned: result.scanned,
        would_stamp: result.stamped,
        already_stamped: result.already_stamped,
        skipped_missing_provider: result.skipped_missing_provider,
      });
      return;
    }
    res.json({
      success: true,
      dry_run: false,
      scanned: result.scanned,
      stamped: result.stamped,
      already_stamped: result.already_stamped,
      skipped_missing_provider: result.skipped_missing_provider,
    });
  } catch (err) {
    console.error("[gardssalg-owner-lock-backfill] failed:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── GET /api/opplevelser/admin/website-review-queues ───────────────────────
//
// dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach
// (Daniels oppfølging 2026-08-01: «Jeg ønsker å få innhentet hjemmesider på
// dem som mangler»). Both website review queues already have discovery
// WRITERS (gardssalg-website-discovery, brreg-website-discovery,
// listing-homepage-discovery, homepage-review-queue/submit, and the
// verification sweep's "unverified" enqueue) and APPROVE levers that demand
// the exact queued (provider_id, candidate_url) pair — but NO reader.
// Measured live 2026-08-01: 43 pending gardssalg + 219 pending homepage
// entries were sitting unreachable from outside; discovery re-runs yielded
// 0 new proposals because the pool is already parked here. This closes that
// gap with the smallest possible surface: one admin-gated, read-only GET.
//
// Pending rows only (that is what the approve levers accept). The two tables
// model "pending" DIFFERENTLY, deliberately mirrored here rather than
// papered over: gardssalg_website_review_queue has NO status column — its
// approve lever DELETES the row (clearGardssalgWebsiteReviewQueueEntry), so
// every row that exists is pending by construction. The homepage queue keeps
// resolved rows and marks them (status='approved'), so it needs the WHERE.
// Pure read — two SELECTs, zero writes, no network. NB: mounted (like every
// other /admin/* GET in this block) well before the /:id catch-all.
router.get("/admin/website-review-queues", requireAdmin, (_req: Request, res: Response) => {
  const expDb = getExpDb("experiences");
  try {
    const gardssalg = listGardssalgWebsiteReviewQueue()
      .map((q) => ({
        provider_id: q.provider_id,
        provider_name: q.provider_name,
        candidate_url: q.candidate_url,
        reason: q.reason,
        evidence: q.evidence ?? null,
        batch_id: q.batch_id ?? null,
        updated_at: q.updated_at,
      }));
    const homepage = expDb
      .prepare(
        `SELECT provider_id, provider_name, candidate_url, final_url, evidence, confidence, reason, batch_id, created_at
           FROM experience_homepage_review_queue
          WHERE status = 'pending'
          ORDER BY created_at DESC`
      )
      .all();
    res.json({
      success: true,
      counts: { gardssalg_pending: gardssalg.length, homepage_pending: (homepage as unknown[]).length },
      gardssalg,
      homepage,
    });
  } catch (err) {
    console.error("[website-review-queues] failed:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── GET /api/opplevelser/admin/gardssalg-provider-lookup ────────────────────
//
// Closes a gap surfaced while targeting /admin/gardssalg-content-refresh at
// two just-registered+seeded providers (Bringebærlandet, Klostergården
// Håndbryggeri): /admin/rfb-seed only ever returns candidate NAMES, never the
// new experience_providers.id it assigns, and there was no way to look that
// id up by name afterwards short of a wide auto-select (scope creep onto
// unrelated older raw rows). This is a narrow, read-only, name -> id lookup.
//
// NB: MUST come before /:id (the generic single-experience catch-all route
// below) so this path isn't swallowed as an experience id.
//
// Read-only — a single SELECT, no writes. Case-insensitive substring match
// on navn only. NB: SQLite's built-in lower()/LIKE case-folding is ASCII-only
// (confirmed: lower('BRINGEBÆRLANDET') -> 'bringebÆrlandet' — the Æ is left
// untouched), which would silently break case-insensitivity for exactly the
// Norwegian names (æ/ø/å) this endpoint exists to look up. So the SQL layer
// only fetches columns (no user input in the query at all — nothing to
// inject), and the case-insensitive substring match itself is done in JS via
// toLowerCase(), which correctly folds Unicode. Privacy-minimized like
// /admin/gardssalg-contact-coverage above: never returns epost/telefon/
// hjemmeside/adresse, only id/navn/rfb_seed_source/created_at.
router.get("/admin/gardssalg-provider-lookup", requireAdmin, (req: Request, res: Response) => {
  const navnParam = req.query.navn;
  const navn = typeof navnParam === "string" ? navnParam.trim() : "";
  if (!navn) {
    res.status(400).json({ error: "Query param 'navn' is required and must be non-blank" });
    return;
  }

  const expDb = getExpDb("experiences");

  let rows: Array<{
    id: string;
    navn: string;
    rfb_seed_source: string | null;
    created_at: string | null;
  }> = [];
  try {
    rows = expDb
      .prepare(
        `SELECT id, navn, rfb_seed_source, created_at
           FROM experience_providers`
      )
      .all() as typeof rows;
  } catch (err) {
    console.error("[gardssalg-provider-lookup] failed to query providers:", err);
    res.status(500).json({ error: "Failed to query experience_providers" });
    return;
  }

  const needle = navn.toLowerCase();
  const matches = rows.filter((r) => r.navn.toLowerCase().includes(needle));

  res.json({ matches });
});

// ─── GET /api/opplevelser/admin/providers/recently-enriched ──────────────────
//
// Slice 5 of dev-request 2026-07-13-enrichment-metode-maldrevet-evidens:
// mirrors marketplace.ts's GET /admin/agents/recently-enriched and
// dental.ts's GET /admin/agents/recently-enriched for the experiences
// vertical — a random sample of recently-enriched providers for the
// platform-verifier's weekly homepage spot-check. Serves the sample only;
// the spot-check logic (re-fetch + compare + escalate) lives in a
// separate SKILL.
//
// Uses "providers" (not "agents") in both the route and the response key,
// matching this file's existing naming (gardssalg-provider-lookup,
// experience_providers) rather than the rfb/dental "agents" convention.
//
// NOTE (experiences has no field_provenance column — see the LOCK MODEL
// comment near getProviderByName/ContentRefreshTarget above): this
// response omits field_provenance entirely in favor of an explicit
// `provenance_model: "none"` marker, rather than inventing a fake
// rfb-shaped provenance object. The content fields returned instead
// (about_text/visit_text/opening_hours_text/products/content_source/
// content_evidence_url) are exactly what the gårdssalg content-refresh
// writer (applyProviderContent et al.) fills from a provider's homepage —
// i.e. what a homepage-truth spot-check would need to verify.
//
// Query params:
//   ?since=<ISO-8601>  — default: 7 days before now (also the fallback
//                        for an unparseable value)
//   ?limit=<int>       — default 10, clamped to [1, 50]
//
// Auth: requireAdmin (same X-Admin-Key convention as the rest of this file).
// Returns: 200 { success, count, providers: [{ id, name, website,
//   last_enriched_at, about_text, visit_text, opening_hours_text,
//   products, content_source, content_evidence_url, enriched_experiences,
//   field_provenance: null, provenance_model: "none" }] }
//
// `enriched_experiences` carries the provider's own enriched EXPERIENCES rows:
// `{ id, title, description, category, subcategory, booking_url,
// content_source, evidence_url, discovery_source, content_field_evidence,
// updated_at }`, at most 10 per provider, ordered
// `updated_at DESC` — a provider with more enriched rows than that IS
// truncated, which matters to a consumer computing `checked`. Note the order is
// LAST TOUCHED, not last enriched: the geocode worker, the title_no backfill
// and the dedup pass all bump `updated_at` without writing content, so which 10
// of >10 rows you get is not strictly "the 10 most recently enriched"
// (round-4 review).
//
// Excluded, so that every row served is content the enrichment pass wrote from
// the page the consumer is about to fetch:
//   - `content_source` 'manual' or 'claim' — the two owner/claim-authored
//     values the schema defines (`curator` is not one of them);
//   - `verification_status = 'verified'` — note this is the EXPERIENCE-level
//     column, not `enrichment_state`, whose 'verified' rung IS served;
//   - rows the dedup pass merged away (`canonical_id IS NOT NULL`);
//   - PER FIELD: a judged field (`description`/`category`/`booking_url`) whose
//     recorded source in `content_field_evidence` is on a different registrable
//     domain than the homepage is set to `null`, and the row is dropped only
//     when nothing judgeable is left. This is per FIELD, not per row, because
//     the writer fills only blank fields and a row's fields therefore come from
//     different sources at different times. `content_source` cannot answer this
//     at all — see the long comment at the filter.
//
// On the merged-away exclusion, one thing worth stating so a later reader does
// not over-read it: "exists on no user-visible surface" is TRUE of every row
// this endpoint serves, since PUBLISH_GATE_SQL requires
// `verification_status = 'verified'` and this query requires the opposite —
// the two sets are disjoint (round-4 review). The exclusion stands on the
// lock-model grounds stated at the query, not on publishability.
//
// Provider-level keys, each ABSENT rather than false/0 when it does not apply:
// `enriched_experiences_filtered` (rows dropped for provenance),
// `enriched_experiences_fields_blanked` (individual fields nulled),
// `enriched_experiences_window_exhausted` (more rows exist than the read window
// and fewer than 10 survived), `homepage_is_aggregator` (the PROVIDER's own
// registered homepage is a DMO page, which inverts the provenance comparison).
//
// On a query fault the provider carries `enriched_experiences_error: true`
// alongside an empty list — score that as `skipped`, never as "nothing was
// written". The key is ABSENT (not `false`) on success.
// The provider-level content columns above are the gårdssalg writer's fields;
// a provider enriched only by the generic content-refresh has all of those
// null, which is why the spot-check needs both. See the inline comment at the
// query below.
router.get("/admin/providers/recently-enriched", requireAdmin, (req: Request, res: Response) => {
  try {
    const expDb = getExpDb("experiences");

    const DEFAULT_SINCE_DAYS = 7;
    // Compared against `last_enriched_at`, which is only ever written as
    // SQLite `datetime('now')` — "2026-07-20 23:59:59", a SPACE separator.
    // A JS `.toISOString()` gives "2026-07-20T00:00:00.000Z", and SQLite
    // string-compares the two: ' ' (0x20) < 'T' (0x54), so
    //   '2026-07-20 23:59:59' >= '2026-07-20T00:00:00.000Z'  ->  0
    // Every provider enriched on the boundary calendar day was excluded
    // regardless of the time of day, making the effective window 6 days plus a
    // fraction instead of 7 (round-4 review). Pre-existing, but it thins
    // exactly the sample this endpoint change exists to enlarge, so it is
    // fixed here rather than filed away. Emitting the same shape SQLite writes
    // makes the comparison mean what it reads as.
    const toSqliteDatetime = (d: Date): string => d.toISOString().slice(0, 19).replace("T", " ");
    let since = toSqliteDatetime(new Date(Date.now() - DEFAULT_SINCE_DAYS * 24 * 60 * 60 * 1000));
    const sinceParam = req.query.since;
    if (typeof sinceParam === "string" && sinceParam.trim()) {
      const parsed = new Date(sinceParam);
      if (!isNaN(parsed.getTime())) {
        since = toSqliteDatetime(parsed);
      }
    }

    let limit = parseInt((req.query.limit as string) || "10", 10);
    if (!Number.isFinite(limit)) limit = 10;
    limit = Math.min(50, Math.max(1, limit));

    const rows = expDb
      .prepare(
        `SELECT id, navn, hjemmeside, last_enriched_at, about_text, visit_text,
                opening_hours_text, products, content_source, content_evidence_url
           FROM experience_providers
          WHERE last_enriched_at >= ?
          ORDER BY RANDOM()
          LIMIT ?`
      )
      .all(since, limit) as Array<{
        id: string;
        navn: string;
        hjemmeside: string | null;
        last_enriched_at: string | null;
        about_text: string | null;
        visit_text: string | null;
        opening_hours_text: string | null;
        products: string | null;
        content_source: string | null;
        content_evidence_url: string | null;
      }>;

    // enriched_experiences: the fields this vertical's MAIN enrichment pass
    // actually writes (dev-request 2026-07-27-kvalitetsporter-uten-signal,
    // slice C).
    //
    // Without this the weekly field-truth spot-check had nothing to look at.
    // It reads the provider-level columns above (about_text / visit_text /
    // opening_hours_text / products) — but those are the GÅRDSSALG writer's
    // fields (applyProviderContent). The generic content-refresh that runs
    // twice a day writes `description`/`category`/`booking_url` and friends
    // onto the provider's EXPERIENCES rows (applyExperienceContent), and only
    // stamps `last_enriched_at` on the provider.
    //
    // So a provider could be genuinely, correctly enriched and still come back
    // from this endpoint with every checkable field null — which is exactly
    // what the 2026-W30 spot-check reported: "experiences: checked=0 ...
    // all 10 sampled providers have null content fields". The sample was real;
    // the projection was looking in the wrong table.
    // `IN ('enriched','verified')`, not `= 'enriched'`: init-experiences.ts
    // documents the ladder as raw → matched → enriched → verified. Nothing
    // writes 'verified' to `experiences` today, so this is a no-op now — but
    // the day a verifier pass starts stamping it, an `= 'enriched'` filter
    // would make those rows vanish from this projection and report `checked=0`
    // silently. That is the very failure mode this endpoint change exists to
    // remove; it should not be re-armed for a future state (independent review).
    // Prepared once, outside the row loop — but guarded: if the statement
    // itself cannot be prepared, the provider-level content is still worth
    // serving, so degrade to the error flag rather than 500-ing the whole
    // sample (round-2 review, nit).
    // Bounded read: 50 providers x this window. Named so the value and the
    // window-exhausted signal below cannot drift apart.
    const EXP_ROW_WINDOW = 50;
    let expRowsStmt: ReturnType<typeof expDb.prepare> | null = null;
    try {
      expRowsStmt = expDb.prepare(
      `SELECT id, title, description, category, subcategory, booking_url,
              content_source, evidence_url, discovery_source,
              content_field_evidence, updated_at
         FROM experiences
        WHERE provider_id = ?
          AND enrichment_state IN ('enriched', 'verified')
          -- Merged-away rows must never surface (round-3 review, BLOCKING).
          -- canonical_id IS NOT NULL means the dedup pass folded this row
          -- into another one, and the convention — stated at
          -- experience-store.ts:461-464 and enforced by PUBLISH_GATE_SQL
          -- (:474), listCategories (:1392), the corridor pages
          -- (route-corridor-service.ts:621) and the dedup candidate loader
          -- (experience-dedup.ts:499) — is that such a row appears on NO
          -- user-visible surface again. This projection was the only read of
          -- experiences that omitted it.
          --
          -- Not cosmetic, and worse than a plain leak: runDedupPass() stamps
          -- the loser rows with canonical_id AND bumps
          -- updated_at = datetime('now') (experience-dedup.ts:562-563), so
          -- under the ORDER BY updated_at DESC LIMIT 10 below the
          -- freshly-merged-away duplicates sort ABOVE the live rows and can
          -- fill the whole window. The spot-check would then judge rows that
          -- no longer exist anywhere, against the provider's homepage.
          AND canonical_id IS NULL
          -- Lock guard: the same two-part clause as
          -- experience-store.ts:1708-1709, which is the one genuine precedent
          -- for it (round-3 review — round 2's comment also cited :2222/:2360/
          -- :2859, but those are the content_source half ALONE and they
          -- query experience_providers, guarding applyProviderContent, whose
          -- lock model deliberately has no verification_status). The canonical
          -- definition is isExperienceContentLocked (:1775-1782).
          --
          -- applyExperienceContent() provably REFUSES to write owner- or
          -- claim-authored or already-verified rows, so serving them here
          -- would hand the weekly spot-check content that never came from the
          -- homepage it is about to judge against. That matters concretely:
          -- §8.4 of the platform-verifier SKILL sets
          -- controller/enrichment-write-pause.yaml → enabled: true at
          -- error_rate > 0.10, so a couple of owner-written rows in a
          -- 10-provider sample could pause enrichment writes for the whole
          -- vertical over mismatches that are not errors at all.
          --
          -- NULL-guarded, unlike :1708 (round-3 review): SQL three-valued
          -- logic makes NULL != 'verified' evaluate to NULL, which excludes
          -- the row — while isExperienceContentLocked treats a NULL
          -- verification_status as UNLOCKED, i.e. a row applyExperienceContent
          -- would happily enrich. Hiding exactly those rows is the false
          -- checked=0 this endpoint exists to remove. Latent today
          -- (createExperience coalesces to 'pending_verify'), cheap forever.
          AND (verification_status IS NULL OR verification_status != 'verified')
          AND (content_source IS NULL OR content_source NOT IN ('manual','claim'))
        ORDER BY updated_at DESC
        -- Over-fetch, then filter, then slice to 10 in JS (round-5 review).
        -- The provenance filter below cannot be expressed in SQL (it compares
        -- registrable domains), and running it AFTER a LIMIT 10 meant a
        -- provider with 10 fresh harvest-sourced rows and 5 good older ones
        -- returned ZERO — a brand-new route to the checked=0 this endpoint
        -- exists to remove. 50 is a bounded read (50 providers x 50 rows) and
        -- the response is still capped at 10.
        LIMIT ${EXP_ROW_WINDOW + 1}`
      );
    } catch (err) {
      console.error("[opplevelser] providers/recently-enriched: could not prepare enriched_experiences query", err);
    }

    const providers = rows.map((r) => {
      let products: unknown[] = [];
      if (r.products) {
        try {
          const parsed = JSON.parse(r.products);
          if (Array.isArray(parsed)) products = parsed;
        } catch { /* malformed → empty */ }
      }
      let enrichedExperiences: unknown[] = [];
      let enrichedExperiencesError = false;
      let enrichedExperiencesFiltered = 0;
      let enrichedExperiencesFieldsBlanked = 0;
      let enrichedExperiencesWindowExhausted = false;
      let homepageIsAggregator = false;
      try {
        const raw = expRowsStmt
          ? (expRowsStmt.all(r.id) as Array<Record<string, unknown>>)
          : [];
        // PER-FIELD provenance screen (round-6 review, BLOCKING).
        //
        // Round 4 established the harm: applyExperienceContent stamps
        // `content_source = 'provider_site'` unconditionally, so aggregator text
        // reaches the spot-check labelled as homepage content, scores a false
        // `mismatch`, and trips §8.4's write-pause.
        //
        // Round 5 showed my filter used `evidence_url`, which is DISCOVERY
        // provenance. Round 6 showed the replacement — one `content_evidence_url`
        // per ROW — was wrong too: applyExperienceContent writes only BLANK
        // fields, so one row's fields come from different sources at different
        // times and a row-level column records only the last writer. It
        // mislabelled in both directions, reopening both earlier harms.
        //
        // The consumer judges PER FIELD, so screen per field. A judged field
        // whose recorded source is on a different registrable domain than the
        // provider's homepage is blanked, and a row left with no judged field is
        // dropped entirely — there is nothing left to check on it.
        //
        // Unknown provenance (no map entry, or a row written before the column
        // existed) is KEPT, which is the pre-change behavior: never invent an
        // exclusion from missing data.
        const JUDGED_FIELDS = ["description", "category", "booking_url"] as const;
        const homepageHost = r.hjemmeside ? hostFromUrlLike(r.hjemmeside) : null;
        const homepageDomain = homepageHost ? registrableDomain(homepageHost) : null;

        let fieldsBlanked = 0;
        const kept: Array<Record<string, unknown>> = [];
        for (const row of raw) {
          let evidence: Record<string, string> = {};
          const rawMap = row.content_field_evidence;
          if (typeof rawMap === "string" && rawMap) {
            try {
              const parsed = JSON.parse(rawMap);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                evidence = parsed as Record<string, string>;
              }
            } catch { /* malformed -> treat as unknown, i.e. keep */ }
          }
          const out: Record<string, unknown> = { ...row };
          // The map is an INPUT to this screen, not part of its output. Serving
          // it leaked a raw JSON string into the response — a second, differently
          // shaped copy of a decision the blanking already encodes, which the
          // consumer would have to parse to use and could then disagree with
          // (round-8 review, MINOR 3).
          delete out.content_field_evidence;
          let judgeable = 0;
          for (const field of JUDGED_FIELDS) {
            if (out[field] === null || out[field] === undefined || out[field] === "") continue;
            const src = evidence[field];
            if (!src || !homepageDomain) { judgeable++; continue; }   // unknown -> keep
            const srcHost = hostFromUrlLike(src);
            // A source that does not parse to a host is NOT the homepage
            // (round-7 review, M4). It used to be kept as "unknown", which made
            // the harvest sentinel — and any malformed entry — read as
            // judgeable homepage content. Absence of an entry still means
            // unknown; a PRESENT entry we cannot match is a mismatch.
            if (srcHost && registrableDomain(srcHost) === homepageDomain) { judgeable++; continue; }
            out[field] = null;      // written from somewhere else — not checkable here
            fieldsBlanked++;
          }
          if (judgeable > 0) kept.push(out);
        }
        enrichedExperiencesFiltered = Math.min(raw.length, EXP_ROW_WINDOW) - Math.min(kept.length, EXP_ROW_WINDOW);
        enrichedExperiencesFieldsBlanked = fieldsBlanked;
        enrichedExperiences = kept.slice(0, 10);
        // Rows the 50-row window could not reach. Without this a provider with
        // more than 50 rows can still come back short or empty with no way for
        // the consumer to tell that from "enrichment wrote nothing" — the old
        // LIMIT-10 cliff moved outward rather than removed (round-6 review).
        // Read one MORE than the window, so this is "there really are more rows"
        // and not merely "the window happened to fill" (round-7 review, M5).
        // The distinction is expensive: A2A §8.3 tells the cron to score the
        // whole provider `skipped` on this flag, so a provider with exactly 50
        // rows and 9 good ones would have thrown away nine judgeable rows — and
        // `checked < 5 -> insufficient_sample` means that can manufacture the
        // very `checked=0` this change exists to remove.
        if (raw.length > EXP_ROW_WINDOW && kept.length < 10) {
          enrichedExperiencesWindowExhausted = true;
        }
        // A provider whose OWN hjemmeside is an aggregator inverts the screen:
        // every source domain matches it, so aggregator text is judged against
        // the aggregator page it came from and scores `ok`, INFLATING the signal
        // rather than measuring it. The consumer cannot see that from the rows.
        if (homepageHost && isDirectoryOrAggregatorHost(homepageHost)) {
          homepageIsAggregator = true;
        }
        if (!expRowsStmt) enrichedExperiencesError = true;
      } catch (err) {
        enrichedExperiencesError = true;
        // NOT the zero-rows case — `.all()` returns [] for that and never
        // throws (an earlier version of this comment claimed otherwise;
        // independent review corrected it). Reaching here means a real query
        // fault, e.g. SQLITE_BUSY under the `journal_mode = DELETE` fallback
        // while a content-refresh writes. That must be LOUD: silently
        // returning [] makes the weekly spot-check read "enrichment wrote
        // nothing" — reintroducing the exact false `checked=0` signal this
        // projection exists to eliminate.
        console.error(
          `[opplevelser] providers/recently-enriched: enriched_experiences query failed for provider ${r.id}`,
          err,
        );
      }
      // The console.error alone was not enough (round-2 review, blocking): the
      // only consumer is a cron routine doing `curl -fsS` (platform-verifier
      // §8.2) which never sees server logs, so a query fault still reached it
      // as a clean 200 with an empty list — i.e. exactly the false "enrichment
      // wrote nothing" reading this projection exists to eliminate. The flag
      // below is the consumer-visible half: the spot-check can score the
      // provider as `skipped` instead of counting a phantom `checked=0`.
      // Failing the whole request would be worse — one bad provider would
      // destroy an otherwise usable 10-provider sample.
      return {
        id: r.id,
        name: r.navn,
        website: r.hjemmeside,
        last_enriched_at: r.last_enriched_at,
        about_text: r.about_text,
        visit_text: r.visit_text,
        opening_hours_text: r.opening_hours_text,
        products,
        content_source: r.content_source,
        content_evidence_url: r.content_evidence_url,
        enriched_experiences: enrichedExperiences,
        ...(enrichedExperiencesError ? { enriched_experiences_error: true } : {}),
        // Round-5 review: an empty list caused by the provenance filter was
        // indistinguishable from "enrichment wrote nothing" — the same argument
        // that made a bare console.error unacceptable in round 2, applied to the
        // filter path this time. Emitted only when it actually happened.
        ...(enrichedExperiencesFiltered > 0
          ? { enriched_experiences_filtered: enrichedExperiencesFiltered }
          : {}),
        ...(enrichedExperiencesFieldsBlanked > 0
          ? { enriched_experiences_fields_blanked: enrichedExperiencesFieldsBlanked }
          : {}),
        ...(enrichedExperiencesWindowExhausted
          ? { enriched_experiences_window_exhausted: true }
          : {}),
        ...(homepageIsAggregator ? { homepage_is_aggregator: true } : {}),
        field_provenance: null,
        provenance_model: "none",
      };
    });

    res.json({ success: true, count: providers.length, providers });
  } catch (err: any) {
    console.error("[opplevelser] providers/recently-enriched failed", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── GET /api/opplevelser/admin/providers/by-hjemmeside ──────────────────────
// PATCH /api/opplevelser/admin/providers/:id/hjemmeside
//
// dev-request 2026-07-12-experiences-enrichment-supply-and-aggregator-hygiene:
// the enrichment pipeline is supply-starved partly because there was no way
// to (a) find providers whose hjemmeside is wrongly set to an aggregator/DMO
// domain (visitnorway.com etc.) instead of their own site — ~13 known cases —
// and (b) no write path to correct hjemmeside on an existing
// experience_providers row once bad data was in. This pair closes both gaps:
// GET .../by-hjemmeside is the read-only lookup half, PATCH .../:id/hjemmeside
// is the write half. Neither touches any other provider field.
//
// GET is registered here (alongside the other providers/* admin routes)
// rather than right before the generic /:id catch-all further below —
// unlike /admin/gardssalg-provider-lookup's NB comment, there is no actual
// collision risk here: this path has 3 segments (admin/providers/by-
// hjemmeside) and the catch-all is a single-segment /:id, so Express can
// never confuse the two regardless of registration order.
//
// Read-only — a single SELECT, parameterized LIKE (`%pattern%` bound as a
// query parameter, never string-concatenated into the SQL). Case-
// insensitive per SQLite's built-in (ASCII-only) LIKE folding — sufficient
// here since hjemmeside values are URLs/domains (ASCII per RFC), unlike the
// Norwegian navn field gardssalg-provider-lookup has to fold in JS instead.
// Response is deliberately minimal — id/navn/hjemmeside/vertical only, same
// privacy-minimization pattern as /admin/gardssalg-contact-coverage above
// (no epost/telefon/adresse).
const BY_HJEMMESIDE_DEFAULT_LIMIT = 100;
const BY_HJEMMESIDE_MAX_LIMIT = 500;
router.get("/admin/providers/by-hjemmeside", requireAdmin, (req: Request, res: Response) => {
  const patternParam = req.query.pattern;
  const pattern = typeof patternParam === "string" ? patternParam.trim() : "";
  if (!pattern) {
    res.status(400).json({ error: "Query param 'pattern' is required and must be non-blank" });
    return;
  }

  let limit = parseInt((req.query.limit as string) || "", 10);
  if (!Number.isFinite(limit)) limit = BY_HJEMMESIDE_DEFAULT_LIMIT;
  limit = Math.min(BY_HJEMMESIDE_MAX_LIMIT, Math.max(1, limit));

  try {
    const expDb = getExpDb("experiences");
    const providers = expDb
      .prepare(
        `SELECT id, navn, hjemmeside, vertical
           FROM experience_providers
          WHERE hjemmeside LIKE ?
          ORDER BY navn
          LIMIT ?`
      )
      .all(`%${pattern}%`, limit) as Array<{
        id: string;
        navn: string;
        hjemmeside: string | null;
        vertical: string;
      }>;

    res.json({ success: true, count: providers.length, providers });
  } catch (err) {
    console.error("[opplevelser] admin/providers/by-hjemmeside failed", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── GET /api/opplevelser/admin/providers/all ────────────────────────────────
//
// dev-request 2026-07-30-experience-providers-enumerate: the routine's
// persistent, git-committed blacklist ledger needs to be able to enumerate
// EVERY row in experience_providers — including rows with no hjemmeside at
// all. by-hjemmeside above cannot do this: it requires a non-blank `pattern`
// and only ever matches rows with a (non-null) hjemmeside. This route is a
// plain, paginated, unfiltered (aside from catalog_hidden below) SELECT over
// the whole table, ordered by id so repeated calls walk the table
// deterministically (navn is not unique and can tie, so it cannot be used as
// the sole ORDER BY for stable pagination).
//
// Pagination is keyset (cursor), NOT offset/limit: the caller passes `after`
// — the last-seen `id` from the previous page (default "" for the first
// call) — and the query filters on `id > ?`. OFFSET/LIMIT was rejected:
// `DELETE FROM experience_providers` exists in production code
// (rollbackBatch, DELETE /admin/rfb-seed). If a row BEFORE the current
// OFFSET cursor is deleted between two page fetches of a long-running
// paginated walk, every subsequent page's OFFSET window silently shifts up
// by one and the row that would have been the first item of the next page
// is skipped — never returned in ANY page. Since every row this endpoint
// enumerates becomes a permanent skip-entry in a persistent blacklist
// ledger, a silently skipped provider is exactly the failure mode this
// endpoint must not have. `id` is stable/immutable/unique (TEXT PRIMARY KEY,
// set once via uuid() at creation in experience-store.ts createProvider(),
// never UPDATEd), so anchoring the cursor on it is safe even if rows earlier
// in id-order are deleted mid-walk — a deleted row simply drops out of the
// enumeration, but nothing else shifts or gets skipped.
//
// Excludes catalog_hidden=1 rows — same "(catalog_hidden IS NULL OR
// catalog_hidden != 1)" clause services/experience-store.ts already uses for
// catalog-wide reads (see e.g. listGardssalgProviders/countGardssalgProviders).
// The booking-flyt-v1 synthetic test provider (≈ line 5282 above) is seeded
// with catalog_hidden=1 specifically so it never appears in the public
// catalog; it must likewise never end up in a full-catalog enumeration that
// backs a persistent blacklist ledger.
//
// Read-only — a single SELECT plus a COUNT(*) with the identical
// catalog_hidden WHERE clause (NOT filtered by `after`) so `total` reflects
// the full catalog_hidden-excluded population as a progress hint; unlike
// offset it is not itself part of the pagination cursor, so it carries no
// skip risk. Response is deliberately minimal — id/navn/hjemmeside/vertical
// only, same privacy-minimization pattern as by-hjemmeside just above (no
// epost/telefon/adresse). `next_after` is the last id in the current page
// (or null once a page comes back empty/short) — the caller keeps calling
// with `after: next_after` until `next_after` is null.
const PROVIDERS_ALL_DEFAULT_LIMIT = 200;
const PROVIDERS_ALL_MAX_LIMIT = 1000;
const PROVIDERS_ALL_WHERE = "WHERE (catalog_hidden IS NULL OR catalog_hidden != 1)";
router.get("/admin/providers/all", requireAdmin, (req: Request, res: Response) => {
  let limit = parseInt((req.query.limit as string) || "", 10);
  if (!Number.isFinite(limit)) limit = PROVIDERS_ALL_DEFAULT_LIMIT;
  limit = Math.min(PROVIDERS_ALL_MAX_LIMIT, Math.max(1, limit));

  const after = typeof req.query.after === "string" ? req.query.after : "";

  try {
    const expDb = getExpDb("experiences");
    const providers = expDb
      .prepare(
        `SELECT id, navn, hjemmeside, vertical
           FROM experience_providers
          ${PROVIDERS_ALL_WHERE}
            AND id > ?
          ORDER BY id ASC
          LIMIT ?`
      )
      .all(after, limit) as Array<{
        id: string;
        navn: string;
        hjemmeside: string | null;
        vertical: string;
      }>;

    const totalRow = expDb
      .prepare(`SELECT COUNT(*) AS total FROM experience_providers ${PROVIDERS_ALL_WHERE}`)
      .get() as { total: number };

    const next_after = providers.length > 0 ? providers[providers.length - 1].id : null;

    res.json({
      success: true,
      count: providers.length,
      total: totalRow.total,
      next_after,
      limit,
      providers,
    });
  } catch (err) {
    console.error("[opplevelser] admin/providers/all failed", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── GET /api/opplevelser/admin/providers/content-triage ────────────────────
//
// dev-request 2026-07-29-blacklist-backfill-og-berikelsestriage, slice 2
// (berikelsestriage): full-catalog enumeration that additionally classifies
// EVERY provider into exactly one of three buckets —
//   enrichable — has a usable hjemmeside, at least one live experience is
//                genuinely thin (not yet homepage-sourced)
//   done       — has a usable hjemmeside, nothing left for content-refresh
//                to do (see classifyProviderContentBucket's own doc comment
//                for the two edge cases this covers)
//   waiting    — no usable hjemmeside — never guessed
// — so a batch triage run (A2A `scripts/experiences-berikelsestriage.py`)
// never has to re-implement the classification rule itself. `bucket` is
// computed SERVER-SIDE by `classifyProviderContentBucket`, the SAME shared
// function `selectProvidersForContentRefresh` (the live enrichment selector)
// calls — a second, independent Python re-implementation of this rule WOULD
// drift from the live selector; a single server-computed field cannot.
//
// Same keyset (`after`/`next_after`) pagination contract as
// GET /admin/providers/all just above, for the identical reason (see that
// route's doc comment: an OFFSET/LIMIT page silently drops a row when a row
// before the cursor is deleted mid-walk; this table has production DELETE
// call sites). Same catalog_hidden=1 exclusion.
//
// Per-page bucket classification costs one extra `experiences` query per
// provider row (bounded by `limit`, same as GET .../recently-enriched's
// per-provider enriched_experiences query) — acceptable for an admin/batch
// route walked in pages of up to CONTENT_TRIAGE_MAX_LIMIT, not a hot path.
//
// Read-only — a single SELECT plus a COUNT(*) (not part of the pagination
// cursor, a progress hint only, same convention as .../providers/all).
// Response: 200 { success, count, total, next_after, limit,
//   providers: [{ id, navn, hjemmeside, bucket }] }
const CONTENT_TRIAGE_DEFAULT_LIMIT = 200;
const CONTENT_TRIAGE_MAX_LIMIT = 500;
router.get("/admin/providers/content-triage", requireAdmin, (req: Request, res: Response) => {
  let limit = parseInt((req.query.limit as string) || "", 10);
  if (!Number.isFinite(limit)) limit = CONTENT_TRIAGE_DEFAULT_LIMIT;
  limit = Math.min(CONTENT_TRIAGE_MAX_LIMIT, Math.max(1, limit));

  const after = typeof req.query.after === "string" ? req.query.after : "";

  try {
    const expDb = getExpDb("experiences");
    const providerRows = expDb
      .prepare(
        `SELECT id, navn, hjemmeside
           FROM experience_providers
          ${PROVIDERS_ALL_WHERE}
            AND id > ?
          ORDER BY id ASC
          LIMIT ?`
      )
      .all(after, limit) as Array<{ id: string; navn: string; hjemmeside: string | null }>;

    const experiencesStmt = expDb.prepare(
      `SELECT description, category, content_source, verification_status,
              content_field_evidence, evidence_url, canonical_id
         FROM experiences WHERE provider_id = ?`
    );

    const providers = providerRows.map((p) => {
      const experiences = experiencesStmt.all(p.id) as BucketableExperienceRow[];
      const bucket: ProviderContentBucket = classifyProviderContentBucket(p.hjemmeside, experiences);
      return { id: p.id, navn: p.navn, hjemmeside: p.hjemmeside, bucket };
    });

    const totalRow = expDb
      .prepare(`SELECT COUNT(*) AS total FROM experience_providers ${PROVIDERS_ALL_WHERE}`)
      .get() as { total: number };

    const next_after = providers.length > 0 ? providers[providers.length - 1].id : null;

    res.json({
      success: true,
      count: providers.length,
      total: totalRow.total,
      next_after,
      limit,
      providers,
    });
  } catch (err) {
    console.error("[opplevelser] admin/providers/content-triage failed", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// Very light "does this look like a URL" sanity check — deliberately NOT a
// strict domain/TLD validator (the dev-request explicitly says not to
// overengineer this: this route corrects known-bad values like a leaked
// aggregator domain, it does not need to prove the new value is a live,
// working homepage). Rejects obvious garbage (whitespace, no dot at all,
// absurd length); accepts anything URL-shaped (with or without a scheme,
// with a path/query/port, incl. Norwegian æøå in the host).
function isPlausibleUrlish(v: string): boolean {
  if (v.length === 0 || v.length > 2048) return false;
  if (/\s/.test(v)) return false;
  return v.includes(".");
}

// Shared fetch-existing-row + UPDATE + return-previous/new logic for writing
// experience_providers.hjemmeside — factored out (dev-request 2026-07-12-
// experiences-enrichment-supply-and-aggregator-hygiene, step 2, evidence-leg
// (a)) so BOTH the free-form admin PATCH route below AND the listing-
// homepage-review-approve lever above write through the exact same UPDATE
// shape, rather than a second copy-pasted UPDATE statement. Deliberately
// does NOT carry the PATCH route's own validation (isPlausibleUrlish,
// required-field-present checks) — those are specific to its own free-form-
// admin-correction use case; callers with their own guards (like the
// approve lever's fill-only + lock re-check) run those BEFORE calling this.
// Returns null if the provider does not exist; never throws for a missing
// row. Does not change either caller's external response shape.
function writeProviderHjemmeside(
  id: string,
  value: string | null
): { previous_hjemmeside: string | null; new_hjemmeside: string | null } | null {
  const expDb = getExpDb("experiences");
  const existing = expDb
    .prepare(`SELECT id, hjemmeside FROM experience_providers WHERE id = ?`)
    .get(id) as { id: string; hjemmeside: string | null } | undefined;

  if (!existing) return null;

  expDb
    .prepare(
      `UPDATE experience_providers
          SET hjemmeside = ?, updated_at = datetime('now')
        WHERE id = ?`
    )
    .run(value, id);

  return { previous_hjemmeside: existing.hjemmeside, new_hjemmeside: value };
}

// Body: { hjemmeside: string | null }. The field must be PRESENT in the
// body — entirely missing -> 400 (distinct from an explicit null, which is
// a valid "clear the homepage" instruction). Present but neither string nor
// null -> 400. An empty (or empty-after-trim) string is accepted input but
// normalized to null before writing, matching the "no homepage" semantics
// used elsewhere in this file (e.g. the present() helper in
// /admin/gardssalg-contact-coverage above).
//
// Response carries BOTH previous_hjemmeside and new_hjemmeside — the audit
// trail a human/orchestrator correcting bad data needs to confirm exactly
// what changed. This is a deliberate design requirement of the dev-request,
// not an incidental extra field.
router.patch("/admin/providers/:id/hjemmeside", requireAdmin, (req: Request, res: Response) => {
  const id = req.params.id as string;
  const body = (req.body ?? {}) as { hjemmeside?: unknown };

  if (!("hjemmeside" in body)) {
    res.status(400).json({ error: "Body field 'hjemmeside' is required (string or null)" });
    return;
  }
  const raw = body.hjemmeside;
  if (raw !== null && typeof raw !== "string") {
    res.status(400).json({ error: "'hjemmeside' must be a string or null" });
    return;
  }

  let normalized: string | null = raw === null ? null : raw.trim();
  if (normalized === "") normalized = null;

  if (normalized !== null && !isPlausibleUrlish(normalized)) {
    res.status(400).json({ error: "'hjemmeside' does not look like a plausible URL" });
    return;
  }

  try {
    const result = writeProviderHjemmeside(id, normalized);
    if (!result) {
      res.status(404).json({ error: "Provider not found", id });
      return;
    }

    res.json({
      success: true,
      id,
      previous_hjemmeside: result.previous_hjemmeside,
      new_hjemmeside: result.new_hjemmeside,
    });
  } catch (err) {
    console.error("[opplevelser] admin/providers/:id/hjemmeside PATCH failed", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── POST /api/opplevelser/admin/providers/hjemmeside-write (admin) ─────────
//
// Steg 4 of the 2026-08-03-hjemmeside-skrivespak dev-request — the batch
// write-lever the free-form PATCH .../providers/:id/hjemmeside route above
// (isPlausibleUrlish only, no lock/denylist checks) intentionally never grew.
// Modeled structurally on src/routes/admin-agents-url-write.ts (dry-run/apply
// parsing, per-row transaction, batch cap, one-failure-never-aborts-the-batch)
// but adapted to experience_providers' OWN conventions rather than the
// agents/agent_claims ones:
//
//   * lock signal: `content_source IN ('manual','claim')` is the WHOLE lock
//     — there is no separate "verified claims" table for experience_providers
//     the way agent_claims backs agents.claimed_at. Override via
//     `allow_locked_override: true` (per-row or top-level), the direct analog
//     of admin-agents-url-write.ts's `allow_directory_host` escape-hatch
//     convention (must be stated, never inferred).
//   * host parsing: hostFromUrlLike() (cross-source-validator.ts) — the SAME
//     parser the rest of the experiences/gardssalg code already uses
//     everywhere (isAggregatorWebsite, gardssalg-website-verification.ts,
//     etc.) — NOT admin-agents-url-write.ts's own local hostOf(). Two
//     independent host-parsers already exist in this codebase; this route
//     uses the one native to its own vertical. hostFromUrlLike already strips
//     URL userinfo (`user:pass@host` / `user@host`) the same way hostOf()
//     does, so the `https://evil.com@rettfrabonden.com/`-style bypass is
//     already closed at the shared parser.
//   * directory/aggregator denylist: isDirectoryOrAggregatorHost() +
//     KNOWN_DIRECTORY_HOSTS (cross-source-validator.ts) — the SAME list
//     gardssalg-website-verification.ts already classifies "aggregator" rows
//     against, not a second copy of DIRECTORY_HOSTS.
//   * platform-host denylist: experience_providers has NO existing
//     platform-owned-host check (only admin-agents-url-write.ts's
//     isPlatformOwnedHost(), scoped to the RFB/agents side). isPlatformOwnedHostForExperiences()
//     below is a local twin, same two domains verbatim
//     (rettfrabonden.com/.rettfrabonden.com, fly.dev/.fly.dev — the
//     platform's actual infra domains; experience_providers can be hosted on
//     the same Fly infra) since this is genuinely the same defect class on a
//     second vertical, not a speculative new rule.
//   * verification invalidation: a write that actually CHANGES the URL (skip-
//     if-unchanged already filters no-op writes) flips a prior
//     field_provenance.hjemmeside_verification `{verified:true}` stamp to
//     `{verified:false, classification:"unverified", ...}` so
//     isHjemmesideVerified() (above in this file) correctly stops trusting
//     the OLD verification for the NEW, unverified URL. Read-modify-write on
//     field_provenance, defensive JSON parse (malformed/missing -> `{}`,
//     never throws, never clobbers other keys) — same pattern
//     applyGardssalgWebsiteVerification() (gardssalg-website-verification.ts)
//     uses, reimplemented locally here (not imported) since that function's
//     own shape is tied to a full verification-scan row, not a single field
//     write.
//   * audit: one row per successful write in the NEW, generalized
//     experience_provider_field_write_audit table (init-experiences.ts) —
//     gardssalg_website_verification_audit is NOT reused in place, its
//     classification/verified columns don't fit a plain field write.

/** Hard cap per call — mirrors admin-agents-url-write.ts's URL_WRITE_MAX_ITEMS. */
export const HJEMMESIDE_WRITE_MAX_ITEMS = 200;

/** Our own hosts — never a provider's homepage. Local twin of
 *  admin-agents-url-write.ts's isPlatformOwnedHost(), same two domains
 *  verbatim, scoped to the experiences vertical (uses hostFromUrlLike, not
 *  that file's local hostOf()). */
function isPlatformOwnedHostForExperiences(url: string): boolean {
  const h = hostFromUrlLike(url);
  if (!h) return false;
  if (h === "rettfrabonden.com" || h.endsWith(".rettfrabonden.com")) return true;
  if (h === "fly.dev" || h.endsWith(".fly.dev")) return true;
  return false;
}

type HjemmesideWriteOutcome =
  | "written"
  | "would_write"
  | "rejected_locked"
  | "rejected_invalid_item"
  | "rejected_directory_host"
  | "rejected_platform_host"
  | "skipped_unchanged"
  | "not_found"
  | "error";

interface HjemmesideWriteResultItem {
  provider_id: string;
  status: HjemmesideWriteOutcome;
  previous_hjemmeside?: string | null;
  new_hjemmeside?: string | null;
  detail?: string;
}

interface HjemmesideWriteRow {
  id: string;
  hjemmeside: string | null;
  content_source: string | null;
  field_provenance: string | null;
  producer_type: string | null;
  rfb_seed_source: string | null;
}

const HJEMMESIDE_WRITE_ROW_SQL =
  `SELECT id, hjemmeside, content_source, field_provenance, producer_type, rfb_seed_source FROM experience_providers WHERE id = ?`;

/** Lock signal for experience_providers: content_source alone (no sibling
 *  "verified claims" table exists for this entity, unlike agents/agent_claims) —
 *  EXCEPT experience_providers is shared with the gårdssalg sub-vertical
 *  (dev-request 2026-07-30-opplevagent-claim-epost-og-perfelt-laas, sub-slice
 *  3d), whose claim portal writes a per-field field_provenance.owner_locks
 *  stamp that isGardssalgFieldOwnerLocked() (experience-store.ts) already
 *  consults to narrow the freeze from row-level to field-level. That helper
 *  must NEVER be called on a non-gårdssalg row — a coincidental owner_locks
 *  key there isn't a real owner-lock stamp — so gate on the SAME gårdssalg-row
 *  predicate already used elsewhere in this file (e.g.
 *  admin/gardssalg-provider-visibility above): producer_type IS NOT NULL OR
 *  rfb_seed_source = 'rfb-seed'. Non-gårdssalg rows keep the original
 *  unconditional row-level freeze. */
function isHjemmesideLocked(row: HjemmesideWriteRow): boolean {
  const isGardssalgRow = row.producer_type !== null || row.rfb_seed_source === "rfb-seed";
  if (isGardssalgRow) return isGardssalgFieldOwnerLocked(row, "hjemmeside");
  return row.content_source === "manual" || row.content_source === "claim";
}

/**
 * Read-modify-write field_provenance, invalidating a stale
 * `hjemmeside_verification: {verified:true}` stamp when the URL actually
 * changes. Defensive parse: malformed/missing JSON -> {}, never throws,
 * never clobbers other keys — same pattern as
 * applyGardssalgWebsiteVerification() (gardssalg-website-verification.ts).
 * Returns the merged object ready for JSON.stringify, or null if there was
 * nothing to change (no prior verification entry, or it wasn't verified:true
 * to begin with) — in which case the caller leaves field_provenance untouched.
 */
function invalidateHjemmesideVerificationIfPresent(
  fieldProvenanceRaw: string | null
): Record<string, unknown> | null {
  let provenance: Record<string, unknown> = {};
  if (fieldProvenanceRaw) {
    try {
      const parsed = JSON.parse(fieldProvenanceRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        provenance = parsed as Record<string, unknown>;
      }
    } catch {
      /* malformed existing JSON -> treat as empty, never clobber/throw */
    }
  }

  const existing = provenance["hjemmeside_verification"];
  const wasVerified =
    !!existing && typeof existing === "object" && (existing as Record<string, unknown>)["verified"] === true;
  if (!wasVerified) return null; // nothing to invalidate — leave field_provenance alone

  provenance["hjemmeside_verification"] = {
    verified: false,
    classification: "unverified",
    checked_at: new Date().toISOString(),
    reason: "hjemmeside_write_invalidated_prior_verification",
  };
  return provenance;
}

router.post("/admin/providers/hjemmeside-write", requireAdmin, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    items?: unknown;
    apply?: unknown;
    allow_locked_override?: unknown;
  };
  const apply =
    body.apply === true || body.apply === 1 || body.apply === "1" || body.apply === "true" ||
    req.query?.apply === "1" || req.query?.apply === "true";
  const dryRun = !apply;
  const topLevelAllowLockedOverride = body.allow_locked_override === true;

  if (!Array.isArray(body.items)) {
    res.status(400).json({ error: "Body must contain an 'items' array of {provider_id, hjemmeside}" });
    return;
  }
  if (body.items.length > HJEMMESIDE_WRITE_MAX_ITEMS) {
    res.status(400).json({ error: `Too many items (max ${HJEMMESIDE_WRITE_MAX_ITEMS} per call)` });
    return;
  }

  const expDb = getExpDb("experiences");
  const batchId = `hjemmeside-write-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
  const results: HjemmesideWriteResultItem[] = [];

  for (const raw of body.items as unknown[]) {
    const it = (raw ?? {}) as {
      provider_id?: unknown;
      hjemmeside?: unknown;
      allow_locked_override?: unknown;
    };
    const providerId = typeof it.provider_id === "string" ? it.provider_id.trim() : "";
    if (!providerId) {
      results.push({ provider_id: "(missing)", status: "rejected_invalid_item", detail: "provider_id required" });
      continue;
    }

    // hjemmeside must be explicitly present: a string, or null to clear.
    // `undefined` is a malformed item, never an inferred instruction.
    let newValue: string | null;
    if (it.hjemmeside === null) {
      newValue = null;
    } else if (typeof it.hjemmeside === "string") {
      const trimmed = it.hjemmeside.trim();
      if (trimmed === "") {
        results.push({
          provider_id: providerId,
          status: "rejected_invalid_item",
          detail: "empty string is not a clear instruction — send hjemmeside: null",
        });
        continue;
      }
      newValue = trimmed;
    } else {
      results.push({ provider_id: providerId, status: "rejected_invalid_item", detail: "hjemmeside must be a string or null" });
      continue;
    }

    const rowAllowLockedOverride = it.allow_locked_override === true;
    const allowLockedOverride = topLevelAllowLockedOverride || rowAllowLockedOverride;

    try {
      // 1. Load the provider row — not found never aborts the batch.
      const cur = expDb.prepare(HJEMMESIDE_WRITE_ROW_SQL).get(providerId) as HjemmesideWriteRow | undefined;
      if (!cur) {
        results.push({ provider_id: providerId, status: "not_found" });
        continue;
      }
      // 2. Lock check — content_source is the WHOLE lock signal here.
      if (isHjemmesideLocked(cur) && !allowLockedOverride) {
        results.push({ provider_id: providerId, status: "rejected_locked", previous_hjemmeside: cur.hjemmeside });
        continue;
      }
      // 3. Validate the new value (skipped entirely when clearing).
      if (newValue !== null) {
        if (!isPlausibleUrlish(newValue)) {
          results.push({ provider_id: providerId, status: "rejected_invalid_item", detail: "hjemmeside does not look like a plausible URL", previous_hjemmeside: cur.hjemmeside, new_hjemmeside: newValue });
          continue;
        }
        const host = hostFromUrlLike(newValue);
        if (host && isDirectoryOrAggregatorHost(host)) {
          results.push({ provider_id: providerId, status: "rejected_directory_host", previous_hjemmeside: cur.hjemmeside, new_hjemmeside: newValue });
          continue;
        }
        if (isPlatformOwnedHostForExperiences(newValue)) {
          results.push({ provider_id: providerId, status: "rejected_platform_host", previous_hjemmeside: cur.hjemmeside, new_hjemmeside: newValue });
          continue;
        }
      }
      // 4. Skip-if-unchanged.
      const currentValue = cur.hjemmeside ?? null;
      if (currentValue === newValue) {
        results.push({ provider_id: providerId, status: "skipped_unchanged", previous_hjemmeside: cur.hjemmeside, new_hjemmeside: newValue });
        continue;
      }

      if (dryRun) {
        results.push({ provider_id: providerId, status: "would_write", previous_hjemmeside: cur.hjemmeside, new_hjemmeside: newValue });
        continue;
      }

      const tx = expDb.transaction((): HjemmesideWriteResultItem => {
        // Re-read from a fresh snapshot inside the transaction so a
        // concurrent write between the pre-check above and here can't race.
        const fresh = expDb.prepare(HJEMMESIDE_WRITE_ROW_SQL).get(providerId) as HjemmesideWriteRow | undefined;
        if (!fresh) return { provider_id: providerId, status: "not_found" };
        if (isHjemmesideLocked(fresh) && !allowLockedOverride) {
          return { provider_id: providerId, status: "rejected_locked", previous_hjemmeside: fresh.hjemmeside };
        }
        const freshCurrentValue = fresh.hjemmeside ?? null;
        if (freshCurrentValue === newValue) {
          return { provider_id: providerId, status: "skipped_unchanged", previous_hjemmeside: fresh.hjemmeside, new_hjemmeside: newValue };
        }

        expDb
          .prepare(`UPDATE experience_providers SET hjemmeside = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(newValue, providerId);

        const invalidatedProvenance = invalidateHjemmesideVerificationIfPresent(fresh.field_provenance);
        if (invalidatedProvenance) {
          expDb
            .prepare(`UPDATE experience_providers SET field_provenance = ? WHERE id = ?`)
            .run(JSON.stringify(invalidatedProvenance), providerId);
        }

        expDb
          .prepare(
            `INSERT INTO experience_provider_field_write_audit
               (id, provider_id, field_name, old_value, new_value, batch_id, written_at)
             VALUES (?, ?, 'hjemmeside', ?, ?, ?, datetime('now'))`
          )
          .run(crypto.randomUUID(), providerId, fresh.hjemmeside, newValue, batchId);

        return { provider_id: providerId, status: "written", previous_hjemmeside: fresh.hjemmeside, new_hjemmeside: newValue };
      });

      results.push(tx());
    } catch (err: any) {
      results.push({ provider_id: providerId, status: "error", detail: err?.message ?? String(err) });
    }
  }

  const summary = {
    written: 0,
    would_write: 0,
    rejected_locked: 0,
    rejected_directory_host: 0,
    rejected_platform_host: 0,
    skipped_unchanged: 0,
    not_found: 0,
    error: 0,
  } as Record<string, number>;
  for (const r of results) {
    if (r.status in summary) summary[r.status]!++;
  }

  res.json({
    success: true,
    dry_run: dryRun,
    batch_id: batchId,
    results,
    summary,
  });
});

// ─── POST /api/opplevelser/admin/hjemmeside-cleanup-sweep (admin) ───────────
//
// dev-request 2026-07-12-experiences-enrichment-supply-and-aggregator-hygiene,
// Daniel's 2026-07-19 decision, step 1 (classify + move only — step 2,
// re-discovering the real homepage via listing-page-link -> Brreg org-nr ->
// Google Places, is an explicitly deferred follow-on slice, not built here).
//
// WHY: a chunk of experience_providers.hjemmeside rows carry a DMO/aggregator
// URL (visitnorway.no, tripadvisor.com, ...) instead of the provider's OWN
// homepage — a catalog/listing page, not the site itself. The prior slice on
// this same dev-request (item 2) already stopped NEW leaks at bulk-load
// CREATE time (see isAggregatorWebsite()/firstNonAggregatorWebsite() above),
// but rows written before that fix are still sitting on aggregator URLs
// today. This is the (repeatable) classify-and-move sweep: it moves those
// values OUT of hjemmeside and INTO the additive listing_url column (see
// init-experiences.ts) — additive and reversible, nothing deleted, the
// original value survives verbatim in both listing_url and
// field_provenance.
//
// Classification reuses cross-source-validator.ts's isDirectoryOrAggregatorHost
// (already covers this exact cohort) via the isAggregatorWebsite() local
// helper already defined above (the same one the bulk-load CREATE-path fix
// uses) — no new classifier module, no new domain list, per this
// dev-request's own "reuse, don't reinvent" instruction. Mirrors the
// dental#290 precedent (src/routes/admin-dental-hjemmeside-cleanup.ts)
// adapted to this file's own conventions (requireAdmin gate, getExpDb, the
// by-hjemmeside/PATCH-hjemmeside pair just above) rather than copy-pasted
// verbatim.
//
// Candidate set: hjemmeside IS NOT NULL AND listing_url IS NULL (a row this
// sweep already moved is never re-scanned — listing_url IS NULL doubles as
// the "not yet swept" marker), ordered created_at ASC, id ASC, hard batch cap
// (mirrors the dental twin's HJEMMESIDE_CLEANUP_BATCH_CAP).
//
// dry_run STRICT-FALSE parse (same convention as every other sweep in this
// file, e.g. /admin/experiences-dedup-unmerge, /admin/experiences-title-no-
// backfill): body.dry_run !== false — only the literal JSON boolean false
// triggers a real write; null/"false"/0/""/undefined all mean dry-run.
//
// Apply path: for each flagged row, RE-FETCH hjemmeside/listing_url
// immediately before writing (re-verify pattern, mirrors admin-domain-
// coherence.ts's apply loop and the dental precedent) — skipped (reported in
// `skipped`) if hjemmeside changed since the scan, or listing_url is no
// longer NULL (already moved by a concurrent call). Otherwise, one UPDATE:
// copy hjemmeside -> listing_url, set hjemmeside = NULL, and merge a
// {source_url, fetched_at}-shaped entry for the "hjemmeside" key into
// field_provenance using THIS codebase's LOCAL read-modify-write convention
// (mirrors experience-store.ts's applyGardssalgProviderContent /
// applyGardssalgProviderAddress ~lines 2414-2431/2633-2650) — NOT
// admin-knowledge.ts's shared mergeFieldProvenance() helper (that's an
// RFB/dental-only mechanism; this codebase deliberately keeps
// provenance-merge logic vertical-local, so it is never cross-imported
// here).
//
// A row the classifier does NOT flag is never touched, dry-run or apply.
// requireAdmin-gated, same as every other admin route in this file.
//
// Non-goals (this slice): no Brreg/Places re-discovery of the real homepage
// (step 2, future slice); no changes to evidence_url (legitimately allowed to
// stay a DMO pointer); no changes to the bulk-load CREATE path (already
// fixed by the prior slice); no new aggregator domains added speculatively to
// KNOWN_DIRECTORY_HOSTS.
const HJEMMESIDE_LISTING_SWEEP_BATCH_CAP = 200;
const HJEMMESIDE_LISTING_SWEEP_SAMPLE_CAP = 50;

interface ListingSweepCandidate {
  id: string;
  navn: string;
  hjemmeside: string;
}

// Shared WHERE clause for both the count and the capped batch query, so the
// two can never drift out of sync with each other.
function listingSweepCandidateWhereSql(): string {
  return "hjemmeside IS NOT NULL AND listing_url IS NULL";
}

function countListingSweepCandidates(db: ReturnType<typeof getExpDb>): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM experience_providers WHERE ${listingSweepCandidateWhereSql()}`)
    .get() as { n: number };
  return row?.n ?? 0;
}

// Deterministic, oldest-registered-first ordering (created_at, then id as a
// tiebreaker) — a hard LIMIT means only up to HJEMMESIDE_LISTING_SWEEP_BATCH_CAP
// rows are ever scanned/moved per invocation.
function fetchListingSweepCandidateBatch(
  db: ReturnType<typeof getExpDb>,
  cap: number
): ListingSweepCandidate[] {
  return db
    .prepare(
      `SELECT id, navn, hjemmeside FROM experience_providers
       WHERE ${listingSweepCandidateWhereSql()}
       ORDER BY created_at ASC, id ASC
       LIMIT ?`
    )
    .all(cap) as ListingSweepCandidate[];
}

// Merges a {source_url, fetched_at} provenance entry for the "hjemmeside" key
// into an existing field_provenance blob, preserving every OTHER field's
// entry untouched — mirrors experience-store.ts's own inline read-modify-
// write convention for this exact column (applyGardssalgProviderContent /
// applyGardssalgProviderAddress), not admin-knowledge.ts's cross-vertical
// mergeFieldProvenance() helper. Malformed/non-object/array JSON is treated
// as empty so a corrupted existing blob never blocks the write. Exported for
// unit-testing.
export function mergeHjemmesideListingProvenance(
  existingRaw: string | null | undefined,
  entry: { source_url: string; fetched_at: string }
): string {
  let provenance: Record<string, { source_url: string; fetched_at: string }> = {};
  if (existingRaw) {
    try {
      const parsed = JSON.parse(existingRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        provenance = parsed as Record<string, { source_url: string; fetched_at: string }>;
      }
    } catch {
      /* malformed existing JSON -> treat as empty rather than clobber the write */
    }
  }
  provenance.hjemmeside = entry;
  return JSON.stringify(provenance);
}

export interface ListingSweepApplyOutcome {
  applied: boolean;
  previous_hjemmeside?: string;
  listing_url?: string;
  skip_reason?: "row_not_found" | "already_moved" | "hjemmeside_changed" | "no_longer_flagged";
}

// Re-fetches a single row's CURRENT hjemmeside/listing_url/field_provenance
// and, ONLY if it's still exactly the row `flag` was computed from (same
// hjemmeside value, still un-moved) AND still classifies as an aggregator on
// that fresh read, writes the move in one UPDATE. Otherwise it's a no-op skip
// — this is the re-verify-immediately-before-writing guard (mirrors
// admin-domain-coherence.ts's apply loop and the dental precedent's
// applyHjemmesideCleanupToRow) that stops a row whose hjemmeside changed (or
// that another call already moved) between an earlier scan and this write
// from being clobbered. Exported standalone so the "changed since the scan"
// skip path can be unit-tested directly, without needing an actual
// concurrent request (this handler has no `await` in its own request-body
// scan-then-write path, so that race can't be reproduced through two
// ordinary sequential HTTP calls alone).
export function applyHjemmesideListingSweepToRow(
  db: ReturnType<typeof getExpDb>,
  flag: ListingSweepCandidate,
  nowIso: string
): ListingSweepApplyOutcome {
  const current = db
    .prepare(`SELECT hjemmeside, listing_url, field_provenance FROM experience_providers WHERE id = ?`)
    .get(flag.id) as
    | { hjemmeside: string | null; listing_url: string | null; field_provenance: string | null }
    | undefined;
  if (!current) return { applied: false, skip_reason: "row_not_found" }; // row gone since the scan
  if (current.listing_url !== null) return { applied: false, skip_reason: "already_moved" }; // already moved by something else
  if (current.hjemmeside !== flag.hjemmeside) return { applied: false, skip_reason: "hjemmeside_changed" }; // changed since the scan — never clobber

  // Re-verify against the CURRENT value, not the earlier scan read —
  // belt-and-braces alongside the equality check just above.
  if (!current.hjemmeside || !isAggregatorWebsite(current.hjemmeside)) {
    return { applied: false, skip_reason: "no_longer_flagged" };
  }

  const mergedProvenance = mergeHjemmesideListingProvenance(current.field_provenance, {
    source_url: current.hjemmeside,
    fetched_at: nowIso,
  });
  db.prepare(
    `UPDATE experience_providers
        SET listing_url = ?, hjemmeside = NULL, field_provenance = ?, updated_at = datetime('now')
      WHERE id = ?`
  ).run(current.hjemmeside, mergedProvenance, flag.id);

  return { applied: true, previous_hjemmeside: current.hjemmeside, listing_url: current.hjemmeside };
}

router.post("/admin/hjemmeside-cleanup-sweep", requireAdmin, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { dry_run?: unknown };
  // STRICT-FALSE parse — identical convention to every other admin sweep in
  // this file: writes execute ONLY on the literal JSON boolean false.
  const dryRun = body.dry_run !== false;

  try {
    const expDb = getExpDb("experiences");
    const candidateCount = countListingSweepCandidates(expDb);
    const batchRows = fetchListingSweepCandidateBatch(expDb, HJEMMESIDE_LISTING_SWEEP_BATCH_CAP);
    const flagged = batchRows.filter((r) => isAggregatorWebsite(r.hjemmeside));

    if (dryRun) {
      res.json({
        success: true,
        dry_run: true,
        candidate_count: candidateCount,
        would_move: flagged.slice(0, HJEMMESIDE_LISTING_SWEEP_SAMPLE_CAP).map((r) => ({
          id: r.id,
          navn: r.navn,
          hjemmeside: r.hjemmeside,
        })),
        would_move_count: flagged.length,
        skipped: [],
        // Dry-run makes ZERO writes: if this exact batch were applied, only
        // the flagged (would_move) rows would ever leave the candidate set —
        // every scanned-but-not-flagged row (a legitimate own-domain
        // homepage) stays a candidate forever, so it must NOT be subtracted.
        remaining_count: Math.max(0, candidateCount - flagged.length),
      });
      return;
    }

    // Apply: re-fetch + re-verify each flagged row's CURRENT state
    // immediately before writing (see applyHjemmesideListingSweepToRow) — a
    // row that changed (or was already moved by a concurrent call) since the
    // scan above is skipped, never clobbered.
    const moved: Array<{ id: string; navn: string; previous_hjemmeside: string; listing_url: string }> = [];
    const skipped: Array<{ id: string; navn: string; reason: string }> = [];
    const nowIso = new Date().toISOString();

    const tx = expDb.transaction(() => {
      for (const flag of flagged) {
        const outcome = applyHjemmesideListingSweepToRow(expDb, flag, nowIso);
        if (!outcome.applied) {
          skipped.push({ id: flag.id, navn: flag.navn, reason: outcome.skip_reason ?? "unknown" });
          continue;
        }
        moved.push({
          id: flag.id,
          navn: flag.navn,
          previous_hjemmeside: outcome.previous_hjemmeside!,
          listing_url: outcome.listing_url!,
        });
      }
    });
    tx();

    // Apply DOES write, so remaining_count must be the TRUE current candidate
    // count, re-queried from the DB after the transaction — a fresh COUNT(*)
    // is the only accurate source here (mirrors the dental precedent).
    const remainingCount = countListingSweepCandidates(expDb);

    res.json({
      success: true,
      dry_run: false,
      candidate_count: candidateCount,
      moved: moved.slice(0, HJEMMESIDE_LISTING_SWEEP_SAMPLE_CAP),
      moved_count: moved.length,
      skipped,
      remaining_count: remainingCount,
    });
  } catch (err) {
    console.error("[opplevelser] admin/hjemmeside-cleanup-sweep failed", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── POST /api/opplevelser/admin/gardssalg-provider-visibility (admin) ──────
//
// dev-request 2026-07-19-brreg-nace-drikkeprodusenter, triage-oppfølging:
// NACE-kodene skiller ikke håndverk fra industri, så en discovery-apply kan
// lande rader som er formelt korrekte drikkeprodusenter men ikke besøks-/
// gårdssalgsrelevante (Ringnes-klassen, konkursbo-etterfølgere, rene
// holdingselskaper). Denne spaken setter/nuller catalog_hidden for
// EKSPLISITT opplistede rader — samme kolonne og semantikk som den skjulte
// booking-flyt-testprovideren: listGardssalgProviders filtrerer
// catalog_hidden=1 ut av det offentlige grid'et, mens slug-oppslag fortsatt
// virker, så en skjult rad er reversibel og lenkbar, aldri slettet.
//
// Body: { providerIds?: string[], orgNrs?: string[], hidden: boolean,
// apply? } — dry-run default som alle andre admin-ruter i denne fila.
// Ingen wildcard-/alle-modus: et kall må navngi radene sine (id eller
// org_nr), så spaken kan aldri skjule eller avsløre noe den ikke eksplisitt
// ble bedt om. Oppslagene er gårdssalg-scopet (samme klausul som
// listGardssalgProviders) — en referanse til en ikke-gårdssalg-rad lander i
// not_found i stedet for å flippe synlighet utenfor vertikalen.
// manual/claim-låste rader hoppes over og rapporteres (skipped_locked) —
// samme lås som alle andre gårdssalg-skrivere.
const GS_PV_MAX_TARGETS = 500;

router.post("/admin/gardssalg-provider-visibility", requireAdmin, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    providerIds?: unknown;
    orgNrs?: unknown;
    hidden?: unknown;
    apply?: unknown;
  };

  if (typeof body.hidden !== "boolean") {
    res.status(400).json({ error: "Body field 'hidden' is required (boolean)" });
    return;
  }
  const hidden = body.hidden;
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  const providerIds = Array.isArray(body.providerIds)
    ? (body.providerIds as unknown[]).filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim())
    : [];
  const orgNrs = Array.isArray(body.orgNrs)
    ? (body.orgNrs as unknown[]).filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim())
    : [];
  if (providerIds.length === 0 && orgNrs.length === 0) {
    res.status(400).json({ error: "Provide at least one target via 'providerIds' and/or 'orgNrs'" });
    return;
  }
  if (providerIds.length + orgNrs.length > GS_PV_MAX_TARGETS) {
    res.status(400).json({ error: `Too many targets (max ${GS_PV_MAX_TARGETS} per call)` });
    return;
  }

  try {
    const expDb = getExpDb("experiences");
    const byId = expDb.prepare(
      `SELECT id, navn, org_nr, catalog_hidden, content_source FROM experience_providers
        WHERE id = ? AND (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')`
    );
    const byOrgNr = expDb.prepare(
      `SELECT id, navn, org_nr, catalog_hidden, content_source FROM experience_providers
        WHERE org_nr = ? AND (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')`
    );
    type PvRow = { id: string; navn: string; org_nr: string | null; catalog_hidden: number | null; content_source: string | null };

    const matched = new Map<string, PvRow>();
    const notFound: Array<{ ref: string; via: string }> = [];
    for (const pid of providerIds) {
      const row = byId.get(pid) as PvRow | undefined;
      if (row) matched.set(row.id, row);
      else notFound.push({ ref: pid, via: "provider_id" });
    }
    for (const orgnr of orgNrs) {
      const row = byOrgNr.get(orgnr) as PvRow | undefined;
      if (row) matched.set(row.id, row);
      else notFound.push({ ref: orgnr, via: "org_nr" });
    }

    const skippedLocked: Array<{ id: string; navn: string; org_nr: string | null }> = [];
    const unchanged: Array<{ id: string; navn: string; org_nr: string | null }> = [];
    const changed: Array<{ id: string; navn: string; org_nr: string | null; previous_hidden: boolean }> = [];
    const targetValue = hidden ? 1 : null;

    const upd = expDb.prepare(
      `UPDATE experience_providers SET catalog_hidden = ?, updated_at = datetime('now') WHERE id = ?`
    );
    for (const row of matched.values()) {
      if (row.content_source === "manual" || row.content_source === "claim") {
        skippedLocked.push({ id: row.id, navn: row.navn, org_nr: row.org_nr });
        continue;
      }
      const currentlyHidden = row.catalog_hidden === 1;
      if (currentlyHidden === hidden) {
        unchanged.push({ id: row.id, navn: row.navn, org_nr: row.org_nr });
        continue;
      }
      if (!dryRun) upd.run(targetValue, row.id);
      changed.push({ id: row.id, navn: row.navn, org_nr: row.org_nr, previous_hidden: currentlyHidden });
    }

    res.json({
      success: true,
      dry_run: dryRun,
      hidden,
      matched_count: matched.size,
      changed_count: changed.length,
      changed,
      unchanged,
      skipped_locked: skippedLocked,
      not_found: notFound,
    });
  } catch (err) {
    console.error("[opplevelser] admin/gardssalg-provider-visibility POST failed", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── GET /api/opplevelser/admin/detail-completeness-coverage ─────────────────
//
// dev-request 2026-07-04-opplevagent-dedup-og-norske-titler, item 3 ("detail
// completeness weave"): unlike /admin/gardssalg-contact-coverage above (scoped
// to seeded gårdssalg providers via rfb_seed_source = 'rfb-seed'), this reports
// booking_url/phone/website field coverage over the FULL catalog of published
// experiences — the same "published" set the detail page (/opplevelse/:slug)
// and /discover actually surface (PUBLISH_GATE_SQL: verified + confidence
// high/medium/null + provider brreg_active-or-none + canonical_id IS NULL).
//
// Read-only — a single SELECT, no writes. Phone/website are read via the
// experience_providers join (same fields item 3 surfaces on the detail page
// and in the single-experience API row); booking_url lives directly on
// experiences and is already fully wired elsewhere — this endpoint only
// reads it to report coverage, never touches its existing behavior.
router.get("/admin/detail-completeness-coverage", requireAdmin, (_req: Request, res: Response) => {
  const expDb = getExpDb("experiences");

  let rows: Array<{
    booking_url: string | null;
    telefon: string | null;
    hjemmeside: string | null;
  }> = [];
  try {
    rows = expDb
      .prepare(
        `SELECT e.booking_url AS booking_url, p.telefon AS telefon, p.hjemmeside AS hjemmeside
           FROM experiences e
           LEFT JOIN experience_providers p ON p.id = e.provider_id
          WHERE ${PUBLISH_GATE_SQL}`
      )
      .all() as typeof rows;
  } catch (err) {
    console.error("[detail-completeness-coverage] failed to query experiences:", err);
    res.status(500).json({ error: "Failed to query experiences" });
    return;
  }

  const present = (v: string | null): boolean => v !== null && v.trim() !== "";
  const pct = (count: number, total: number): number =>
    total === 0 ? 0 : Math.round((count / total) * 1000) / 10;

  let withBookingUrl = 0;
  let withPhone = 0;
  let withWebsite = 0;
  for (const r of rows) {
    if (present(r.booking_url)) withBookingUrl++;
    if (present(r.telefon)) withPhone++;
    if (present(r.hjemmeside)) withWebsite++;
  }

  const total = rows.length;
  res.json({
    total_experiences: total,
    with_booking_url: { count: withBookingUrl, pct: pct(withBookingUrl, total) },
    with_phone: { count: withPhone, pct: pct(withPhone, total) },
    with_website: { count: withWebsite, pct: pct(withWebsite, total) },
  });
});

// ─── GET /api/opplevelser/:id — single experience ───────────────────
router.get("/:id", (req: Request, res: Response) => {
  const exp = getExperienceById(req.params.id as string);
  if (!exp) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ experience: exp });
});

// ─── POST /api/opplevelser (admin) — hand-curated entry ─────────────
router.post("/", requireAdmin, (req: Request, res: Response) => {
  try {
    const parsed = ExperienceSchema.parse(req.body);
    const id = createExperience(parsed);
    res.status(201).json({ id });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid body", details: err.issues });
      return;
    }
    console.error("[opplevelser] POST / failed", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── Phase 2 — Gårdssalg booking endpoints (2026-06-28) ──────────────
//
// POST /api/opplevelser/book              — guest påmelding
// GET  /api/opplevelser/book/confirm/:token — 302 → /kategori/gardssalg/bekreft/:token (producer confirm page)
// GET  /api/opplevelser/book/:ref/ics     — download ICS calendar file
// GET  /api/opplevelser/admin/gardssalg/commission — monthly commission statement
// GET  /api/opplevelser/admin/gardssalg/bookings-count — existing-rows count (below)
//
// All writes persist to gardssalg_bookings in experiences.db.
// No payments; no auto-send; drafts only. Daniel sends confirmations manually.

// buildIcs() and sendBookingConfirmation() now live in ../services/booking-store
// (moved 2026-07-02) so the gårdssalg SSR reservation form's no-JS fallback
// route in experiences-seo.ts can reuse the exact same confirmation logic
// instead of duplicating it.

// ─── POST /api/opplevelser/book ──────────────────────────────────────
router.post("/book", async (req: Request, res: Response) => {
  const parsed = BookingInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Ugyldig forespørsel", details: parsed.error.issues });
    return;
  }

  // ─── Dark-launch-stop gate (dev-request 2026-07-12-gardssalg-dark-launch-
  // stop, slice 0) — the gårdssalg flow looks fully functional to a guest
  // but no producer is notified/onboarded yet, a live trust/reputation risk.
  // Hard stop, independent of any UI notice: unless BOOKING_DISPATCH_ENABLED
  // is "true" AND this specific provider is booking_live=1, never create a
  // 'reserved' row, never send the guest confirmation, never notify a
  // producer. See isBookingPaused() in services/booking-store.ts.
  const providerBook = getProviderById(parsed.data.provider_id) as
    | { booking_live?: number | null; epost?: string | null; catalog_hidden?: number | null }
    | null;
  if (isBookingPaused(providerBook?.booking_live ?? null, providerBook?.catalog_hidden ?? null)) {
    res.status(200).json({
      success: false,
      paused: true,
      message: "Reservasjoner er ikke aktive ennå — kommer snart.",
    });
    return;
  }

  let booking;
  try {
    booking = createBooking(parsed.data);
  } catch (err) {
    console.error("[booking] createBooking failed", err);
    res.status(500).json({ error: "Kunne ikke opprette påmelding" });
    return;
  }

  // Fire-and-forget confirmation email; never block the response on it
  sendBookingConfirmation(booking).catch((e) =>
    console.error("[booking] email failed", booking.booking_ref, e),
  );

  // Fire-and-forget producer notification — the gate above already confirmed
  // dispatch is on and this provider is booking_live.
  sendProducerNotification(booking, providerBook?.epost ?? null).catch((e) =>
    console.error("[booking] producer notification failed", booking.booking_ref, e),
  );

  // NB (booking-flyt-v1 "bekreft-løkka"): the response deliberately does NOT
  // carry confirm_url anymore. The confirm token is the PRODUCER's credential
  // for resolving attendance (billable/commission) — handing it to the
  // booking caller let a guest resolve their own booking. The producer now
  // gets the link in their notification email instead.
  res.status(201).json({
    success: true,
    booking_ref: booking.booking_ref,
    status: booking.status,
    source: booking.source,
    message: `Påmelding registrert! Bekreftelse sendes til ${booking.guest_email}.`,
  });
});

// ─── GET /api/opplevelser/book/confirm/:token ────────────────────────
// Producer-facing. This USED to resolve the booking directly on GET
// (?action=attended default) — a state-mutating GET, which meant any
// link-prefetching mail scanner would have auto-confirmed attendance the
// moment the link landed in an inbox. It now redirects (302, mutating
// NOTHING) to the human confirm page, where the actual resolution is a
// POST from an explicit button press. Kept as a route so the confirm_urls
// in old server logs / API responses still work.
router.get(
  "/book/confirm/:token",
  (req: Request, res: Response) => {
    const { token } = req.params;
    const existing = getBookingByToken(token as string);
    if (!existing) {
      res.status(404).json({ error: "Booking ikke funnet" });
      return;
    }
    res.redirect(302, `/kategori/gardssalg/bekreft/${encodeURIComponent(token as string)}`);
  },
);

// ─── GET /api/opplevelser/book/:ref/ics ─────────────────────────────
// Download ICS calendar file by booking ref (for guest self-service re-download).
router.get("/book/:ref/ics", (req: Request, res: Response) => {
  const booking = getBookingByRef(req.params.ref as string);
  if (!booking) {
    res.status(404).json({ error: "Booking ikke funnet" });
    return;
  }
  const ics = buildIcs(booking);
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="gardssalg-${booking.booking_ref}.ics"`,
  );
  res.send(ics);
});

// ─── GET /api/opplevelser/admin/gardssalg/commission ────────────────
// Monthly commission statement for one provider.
// ?provider_id=<id>&month=<YYYY-MM>  (admin-keyed)
router.get(
  "/admin/gardssalg/commission",
  requireAdmin,
  (req: Request, res: Response) => {
    const provider_id = req.query.provider_id as string | undefined;
    const month = req.query.month as string | undefined;

    if (!provider_id || !month || !/^\d{4}-\d{2}$/.test(month)) {
      res.status(400).json({
        error: "provider_id og month (YYYY-MM) påkrevd",
      });
      return;
    }

    const statement = getCommissionStatement(provider_id, month);
    res.json({ success: true, ...statement });
  },
);

// ─── POST /api/opplevelser/admin/booking-followups ──────────────────
// booking-flyt-v1 slice 2: run the pre-visit reminder + auto-expiry pass on
// demand (the hourly tick in src/index.ts runs the same function). Idempotent
// by construction — reminder_sent_at / pre_status / expired_guest_notified_at
// guards inside processBookingFollowups() make a back-to-back second call a
// no-op. Admin-keyed like every other one-off action in this file; the
// external Cloud Routines can call this instead of waiting for the tick.
router.post(
  "/admin/booking-followups",
  requireAdmin,
  async (_req: Request, res: Response) => {
    try {
      const result = await processBookingFollowups();
      res.json({ success: true, ...result });
    } catch (err) {
      console.error("[booking-followups] admin run failed:", err);
      res.status(500).json({ error: "Kunne ikke kjøre booking-followups" });
    }
  },
);

// ─── GET /api/opplevelser/admin/gardssalg/bookings-count ────────────
// dev-request 2026-07-12-gardssalg-go-live-gate-dark-launch-og-onboarding,
// acceptance criterion 5 ("Eksisterende bookings-rader talt og rapportert").
// The booking form went live 2026-07-03, a full 9 days before the 2026-07-12
// dark-launch-stop deploy — so gardssalg_bookings may already hold real rows
// written while the flow looked (but wasn't) fully functional. This routine
// has no DB-shell access, so this is the only way to get that count for the
// daily brief / any CS follow-up decision. Read-only, admin-gated, zero
// writes. Deliberately does NOT return guest_name/guest_email/guest_phone in
// bulk (PII-minimizing — same honest-omission discipline as the rest of this
// file): the `rows` list carries only non-identifying fields, capped at 200,
// so an admin can see there ARE real (non-zero-party, real-lead-time) rows
// worth a CS follow-up without this endpoint itself becoming a bulk contact
// export. A specific booking's guest contact is already reachable today via
// the existing `/book/:ref/ics` / confirm-token flow for that one row.
const GSB_ROWS_CAP = 200;
router.get(
  "/admin/gardssalg/bookings-count",
  requireAdmin,
  (_req: Request, res: Response) => {
    const expDb = getExpDb("experiences");

    let byStatus: Array<{ status: string; count: number }> = [];
    try {
      byStatus = expDb
        .prepare(
          `SELECT status, COUNT(*) AS count
             FROM gardssalg_bookings
            GROUP BY status`
        )
        .all() as Array<{ status: string; count: number }>;
    } catch (err) {
      console.error("[gardssalg/bookings-count] status query failed:", err);
      res.status(500).json({ error: "Failed to query gardssalg_bookings" });
      return;
    }

    const by_status: Record<string, number> = {
      reserved: 0,
      confirmed_attended: 0,
      no_show: 0,
      cancelled: 0,
    };
    let total = 0;
    for (const row of byStatus) {
      if (row.status in by_status) by_status[row.status] = row.count;
      total += row.count;
    }

    let rows: Array<{
      booking_id: string;
      provider_id: string;
      status: string;
      party_size: number;
      created_at: string | null;
    }> = [];
    try {
      rows = expDb
        .prepare(
          `SELECT booking_id, provider_id, status, party_size, created_at
             FROM gardssalg_bookings
            ORDER BY created_at ASC
            LIMIT ?`
        )
        .all(GSB_ROWS_CAP) as typeof rows;
    } catch (err) {
      console.error("[gardssalg/bookings-count] rows query failed:", err);
      res.status(500).json({ error: "Failed to query gardssalg_bookings rows" });
      return;
    }

    res.json({
      success: true,
      total,
      by_status,
      rows_returned: rows.length,
      rows_capped: total > GSB_ROWS_CAP,
      rows,
    });
  },
);

// dev-request 2026-07-04-opplevagent-dedup-og-norske-titler, item 1 follow-up:
// admin-triggerable run of the dedup backfill (src/scripts/experiences-dedup-
// backfill.ts / runDedupPass() from PR #209). That script assumes shell access
// to the deployed machine ("npx tsx src/scripts/experiences-dedup-backfill.ts"),
// which this fleet's tooling has no path to invoke (no flyctl/SSH). This
// endpoint runs the exact same, already-reviewed runDedupPass() against the
// live DB, HTTP-triggered like every other one-off admin action in this file.
// Idempotent (runDedupPass only loads canonical_id IS NULL rows) — safe to
// call more than once; a second call finds nothing left to merge.
router.post("/admin/experiences-dedup-backfill", requireAdmin, (_req: Request, res: Response) => {
  const db = getExpDb("experiences");
  const result = runDedupPass(db);
  res.json({ success: true, ...result });
});

// dev-request 2026-07-11-dedup-false-positive-remediation: the backfill above
// merged 418 groups / 1361 rows under titlesMatch()'s defective single-
// common-token rule, and some are false positives ("Fjelltur til
// Galdhøpiggen" folded into "Fjelltur til Snøhetta"-style groups). This pair
// of endpoints is the remediation surface: a read-only AUDIT that re-examines
// every merged row and flags the ones whose only link is a corpus-common
// token (see src/services/experience-dedup-audit.ts), and an UN-MERGE action
// that reverses specific soft merges (canonical_id → NULL + merged_from
// cleanup) after a human has reviewed the audit output.

// GET /api/opplevelser/admin/experiences-dedup-audit?generic_min=5
// Read-only — zero writes. Responds with the full summary plus group detail
// for ONLY the groups that contain suspect rows (capped, so a pathological
// audit can't produce an unbounded response).
const AUDIT_RESPONSE_GROUP_CAP = 100;
router.get("/admin/experiences-dedup-audit", requireAdmin, (req: Request, res: Response) => {
  const rawGenericMin = parseInt((req.query.generic_min as string) || "", 10);
  const genericMin = Number.isFinite(rawGenericMin) && rawGenericMin >= 1 ? rawGenericMin : undefined;

  const db = getExpDb("experiences");
  const { groups, summary } = auditMergedGroups(db, genericMin !== undefined ? { genericMin } : {});
  const suspectGroups = groups.filter((g) => g.rows.some((r) => r.suspect));

  res.json({
    success: true,
    // Review caveat for the human reading this JSON: 'suspect' means REVIEW ME,
    // not certainly-false. The audit's whole-string bar (0.85) is deliberately
    // stricter than the matcher that made the merges (0.6), so a genuine
    // duplicate in the 0.6-0.85 band with only generic shared tokens can be
    // flagged. Inspect both titles + shared_tokens/corpus counts before
    // un-merging; a wrongly-un-merged true duplicate is a cosmetic resurfaced
    // listing, a false merge left in place hides a distinct bookable product.
    note: "suspect = review-me, NOT certainly-false — inspect titles/tokens before un-merging; re-audit after each un-merge batch (sibling links recompute)",
    summary,
    groups_returned: Math.min(suspectGroups.length, AUDIT_RESPONSE_GROUP_CAP),
    groups_truncated: suspectGroups.length > AUDIT_RESPONSE_GROUP_CAP,
    groups: suspectGroups.slice(0, AUDIT_RESPONSE_GROUP_CAP),
  });
});

// POST /api/opplevelser/admin/experiences-dedup-unmerge
// Body: { ids: string[], dry_run?: boolean } — dry_run DEFAULTS TO TRUE when
// absent, so the endpoint never writes unless explicitly told to. For each
// listed id the row must currently be merged away (canonical_id set); rows
// that aren't are reported as skipped, never as errors — which also makes a
// re-run of the same body a harmless no-op (idempotent). A real run clears
// canonical_id on the listed rows and removes them from their canonical row's
// merged_from JSON array (NULL when the list empties), mirroring exactly the
// format runDedupPass() writes. The whole real run is one transaction.
// SEQUENCING CONSTRAINT (review note 1): titlesMatch() is deliberately untouched by this
// slice, so every un-merged false positive is STILL a titlesMatch() match — re-running
// POST /admin/experiences-dedup-backfill (or any runDedupPass invocation) will RE-MERGE
// everything this endpoint un-merges. Do NOT re-run the backfill until the titlesMatch
// corroboration fix (dev-request 2026-07-11 slice C) is live.
router.post("/admin/experiences-dedup-unmerge", requireAdmin, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { ids?: unknown; dry_run?: unknown };
  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    res.status(400).json({ error: "ids (ikke-tom liste) påkrevd" });
    return;
  }
  const ids = body.ids.map(String);
  // STRICT-FALSE parse (review blocker, PR round 2): writes execute ONLY on the JSON
  // boolean false. null / "false" / 0 / "" / undefined all mean dry run — many JSON
  // clients serialize an unset optional boolean as null, and a caller who left dry_run
  // unset must get the documented dry-run default, never live un-merges.
  const dryRun = body.dry_run !== false;

  const db = getExpDb("experiences");
  const getRow = db.prepare("SELECT id, canonical_id FROM experiences WHERE id = ?");

  const toUnmerge: Array<{ id: string; canonical_id: string }> = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const id of ids) {
    const row = getRow.get(id) as { id: string; canonical_id: string | null } | undefined;
    if (!row) skipped.push({ id, reason: "not_found" });
    else if (!row.canonical_id) skipped.push({ id, reason: "not_merged" });
    else toUnmerge.push({ id: row.id, canonical_id: row.canonical_id });
  }

  if (dryRun) {
    res.json({
      success: true,
      dry_run: true,
      requested: ids.length,
      would_unmerge: toUnmerge.map((r) => r.id),
      skipped,
    });
    return;
  }

  const clearCanonicalId = db.prepare(
    "UPDATE experiences SET canonical_id = NULL, updated_at = datetime('now') WHERE id = ?"
  );
  const getMergedFrom = db.prepare("SELECT merged_from FROM experiences WHERE id = ?");
  const setMergedFrom = db.prepare(
    "UPDATE experiences SET merged_from = ?, updated_at = datetime('now') WHERE id = ?"
  );

  const tx = db.transaction(() => {
    for (const row of toUnmerge) {
      clearCanonicalId.run(row.id);
    }
    // Group the un-merged ids per canonical row so each merged_from list is
    // rewritten once. Parse tolerantly, mirroring runDedupPass().
    const removedByCanonical = new Map<string, Set<string>>();
    for (const row of toUnmerge) {
      const set = removedByCanonical.get(row.canonical_id);
      if (set) set.add(row.id);
      else removedByCanonical.set(row.canonical_id, new Set([row.id]));
    }
    for (const [canonicalId, removedIds] of removedByCanonical) {
      const existingRaw = (getMergedFrom.get(canonicalId) as { merged_from: string | null } | undefined)
        ?.merged_from;
      let existingIds: string[] = [];
      if (existingRaw) {
        try {
          const parsed = JSON.parse(existingRaw);
          if (Array.isArray(parsed)) existingIds = parsed.map(String);
        } catch {
          /* corrupt/legacy value — treat as empty rather than throw */
        }
      }
      const remaining = existingIds.filter((id) => !removedIds.has(id));
      setMergedFrom.run(remaining.length > 0 ? JSON.stringify(remaining) : null, canonicalId);
    }
  });
  tx();

  res.json({
    success: true,
    dry_run: false,
    requested: ids.length,
    unmerged: toUnmerge.map((r) => r.id),
    skipped,
  });
});

// ─── POST /api/opplevelser/admin/experiences-title-no-backfill ────────────
// dev-request 2026-07-04-opplevagent-dedup-og-norske-titler, item 2 —
// Norwegian display titles. Narrowest first slice: an admin-triggerable
// backfill that asks Claude for a natural Norwegian display title per
// CANONICAL experience row (canonical_id IS NULL) — merged-away duplicates
// never need their own title_no, every render path resolves through the
// canonical row (see experience-store.ts / experiences-seo.ts).
//
// NEVER FABRICATE: on missing ANTHROPIC_API_KEY, HTTP failure, or an
// unparseable response for a given row, that row is SKIPPED (title_no stays
// NULL) — never guessed, never a pattern-transform fallback. Titles are too
// varied (already-Norwegian, mixed, hybrid) for a blind "Aktivitet i Sted —
// Tilbyder" pattern to be a safe real fallback; NULL + render-time fallback
// to the original `title` (experience-store.ts hydration / experiences-
// seo.ts renderCard()+detail <h1>) is the safe default.
//
// dry_run DEFAULTS TO TRUE (STRICT-FALSE parse, same idiom as
// /admin/experiences-dedup-unmerge above) — the caller must pass
// `dry_run: false` explicitly to write. A dry run never writes and only
// samples a FEW candidates for a useful preview (TITLE_NO_DRY_RUN_SAMPLE) —
// on an empty candidate set it makes zero LLM calls, so it never requires
// ANTHROPIC_API_KEY or a working LLM call to succeed.
//
// TITLE_NO_BATCH_CAP bounds LLM spend per HTTP call so a single admin
// trigger can't runaway-spend against the LLM API — repeated calls drain the
// remaining title_no IS NULL backlog, same operational shape as
// /admin/experiences-dedup-backfill above.
const TITLE_NO_BATCH_CAP = 20;
const TITLE_NO_DRY_RUN_SAMPLE = 5;

type TitleNoCandidate = {
  id: string;
  title: string;
  category: string | null;
  kommune: string | null;
  fylke: string | null;
};

// ─── judgeGardssalgAboutCandidate + meetsGardssalgAboutQualityBar
//     (dev-request 2026-07-20-gardssalg-kvalitetsgate-redesign, slice 2/3/4)
//     ───────────────────────────────────────────────────────────────────────
// Redesign of the gårdssalg about_text/visit_text quality gate: replaces the
// old regex nav-menu-leakage heuristic (isLikelyNavMenuLeakage,
// hasVerbatimRepeatedPhrase, NAV_BOILERPLATE_MARKERS,
// UMBRELLA_MEMBERSHIP_MARKERS — search-enrich.ts) with an LLM judge for the
// SEMANTIC question ("is this candidate actually good, about the right
// entity, not leaked nav chrome") — the four-times-patched heuristic layer
// that let the Draopar incident through on a single loophole word ("er").
//
// SCOPING NOTE (why the shared meetsAboutQualityBar in search-enrich.ts is
// UNTOUCHED): that function is also called from routes/admin-knowledge.ts
// for the RFB producer/agent homepage-content-refresh vertical — a
// completely different, non-gårdssalg use case this dev-request's "Ikke-mål"
// section explicitly does not target. This LLM judge is scoped ONLY to
// gårdssalg's about_text/visit_text. Blindly stripping the nav-heuristic
// checks out of the shared function would silently lower admin-knowledge.ts's
// quality gate too, with no LLM-judge replacement wired in for it — a real
// regression outside this dev-request's scope. So: meetsAboutQualityBar keeps
// its existing behavior/callers unchanged; gårdssalg gets its OWN additive
// gate (meetsGardssalgAboutQualityBar below), reusing only the cheap,
// universal parts (meetsAboutCheapBar, search-enrich.ts) and replacing the
// heuristic layer with the LLM judge. This means isLikelyNavMenuLeakage /
// hasVerbatimRepeatedPhrase / NAV_BOILERPLATE_MARKERS /
// UMBRELLA_MEMBERSHIP_MARKERS are NOT deleted from search-enrich.ts (the
// dev-request's literal "removed, not left dead" instruction assumed
// meetsAboutQualityBar was gårdssalg-exclusive, which it is not) — they stay,
// unaffected, serving admin-knowledge.ts exactly as before. Gårdssalg simply
// no longer calls them.
//
// judgeGardssalgAboutCandidate mirrors generateGardssalgAboutRewrite's EXACT
// sentinel/fail-closed contract below: direct fetch to
// https://api.anthropic.com/v1/messages, ANTHROPIC_API_KEY from env, model
// claude-opus-4-8. ANY doubt or failure — missing key, network failure,
// non-200, unparseable JSON, a response that isn't the exact expected
// verdict token — resolves to REJECT. Never throws, never silently
// approves.
export interface GardssalgJudgeVerdict {
  approved: boolean;
  reasoning: string;
}

const GARDSSALG_JUDGE_APPROVE_TOKEN = "GODKJENN";
const GARDSSALG_JUDGE_REJECT_TOKEN = "AVVIS";
const GARDSSALG_JUDGE_CANDIDATE_CHAR_CAP = 4000;

export async function judgeGardssalgAboutCandidate(
  candidateText: string,
  producerName: string,
  kind: "about" | "visit"
): Promise<GardssalgJudgeVerdict> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { approved: false, reasoning: "ANTHROPIC_API_KEY mangler — avvist fail-closed" };
  }

  const sectionLabel = kind === "about" ? "Om produsenten" : "Besøket hos produsenten";
  const cappedCandidate = (candidateText || "").slice(0, GARDSSALG_JUDGE_CANDIDATE_CHAR_CAP);
  const prompt = `Du er en kvalitetsdommer for produsentprofiler på en norsk markedsplattform for gårdssalg. Vurder om kandidatteksten under er egnet til å publiseres som seksjonen "${sectionLabel}" for produsenten "${producerName}".

Kandidattekst:
${cappedCandidate}

Godkjenn KUN hvis teksten er:
- sammenhengende, ekte norsk prosa spesifikt om DENNE produsenten (ikke en paraplyorganisasjon/reiselivslag/turistkontor sine mange medlemmer omtalt samlet),
- fri for lekket navigasjonsmeny-, sidetopp- eller bunntekst-innhold (lenkelister, "hjem"/"kontakt"/"meny"-navigasjon, cookie-/samtykketekst, "hopp til innhold" og lignende),
- fri for åpenbart oppstykket, avkuttet eller ødelagt tekst,
- faktisk informativ om produsenten, ikke bare en generisk floskel.

Svar med EKSAKT ett av disse to ordene alene på første linje, etterfulgt av en kort norsk begrunnelse på én setning på neste linje:
${GARDSSALG_JUDGE_APPROVE_TOKEN}
<kort begrunnelse>

eller

${GARDSSALG_JUDGE_REJECT_TOKEN}
<kort begrunnelse>

Ved minste tvil, svar ${GARDSSALG_JUDGE_REJECT_TOKEN}.`;

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    return { approved: false, reasoning: "nettverksfeil under dommer-kall — avvist fail-closed" }; // never fabricate
  }

  if (!response.ok) {
    return { approved: false, reasoning: `dommer-API svarte status ${response.status} — avvist fail-closed` };
  }

  let result: any;
  try {
    result = await response.json();
  } catch {
    return { approved: false, reasoning: "ikke-parsbar JSON fra dommer-API — avvist fail-closed" };
  }

  const contentArr = Array.isArray(result?.content) ? result.content : [];
  const text = contentArr.find((c: any) => c?.type === "text")?.text;
  if (typeof text !== "string") {
    return { approved: false, reasoning: "uventet svarformat fra dommer-API — avvist fail-closed" };
  }

  const lines = text.trim().split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const verdictToken = (lines[0] || "").toUpperCase();
  const reasoning = lines.slice(1).join(" ").trim();

  // Only the EXACT approve token approves. Anything else — the reject
  // token, an empty response, garbage, a token that merely CONTAINS the
  // approve word inside a longer sentence — is a reject. Fail-closed on any
  // ambiguity, never a silent approval.
  if (verdictToken === GARDSSALG_JUDGE_APPROVE_TOKEN) {
    return { approved: true, reasoning: reasoning || "godkjent av LLM-dommer" };
  }
  if (verdictToken === GARDSSALG_JUDGE_REJECT_TOKEN) {
    return { approved: false, reasoning: reasoning || "avvist av LLM-dommer" };
  }
  return { approved: false, reasoning: "uventet/tvetydig dommersvar — avvist fail-closed" };
}

/**
 * The gårdssalg-specific about_text/visit_text quality gate — the cascade
 * this dev-request builds: the cheap, deterministic prefilter (
 * meetsAboutCheapBar, search-enrich.ts — length/mangled-Unicode/boilerplate/
 * Norwegian-check) FIRST, and the LLM judge above ONLY when that passes.
 * Cost control: a candidate the cheap filter would already reject never
 * reaches the LLM at all.
 *
 * This is the function gårdssalg's about_text/visit_text write call sites
 * use in place of the shared meetsAboutQualityBar (see this section's top
 * doc comment for why the shared function itself is untouched).
 */
export async function meetsGardssalgAboutQualityBar(
  candidateText: string | null | undefined,
  producerName: string,
  kind: "about" | "visit"
): Promise<boolean> {
  if (!meetsAboutCheapBar(candidateText)) return false;
  const verdict = await judgeGardssalgAboutCandidate(String(candidateText), producerName, kind);
  return verdict.approved;
}

// ─── generateGardssalgAboutRewrite (dev-request 2026-07-18-gardssalg-
//     profilkvalitet-foer-outreach, slice 5a) ───────────────────────────────
// Source-grounded rewrite/expansion of a gårdssalg provider's about_text/
// visit_text for the "passing-bar-but-short" cohort (see
// gardssalgRewriteEligible in services/experience-store.ts): current value
// already clears meetsAboutQualityBar (>=80 chars, so
// gardssalgReplaceableFieldAction refuses to ever touch it — "never churn
// quality-passing content") but is still <200 chars.
//
// Mirrors generateTitleNo()'s exact never-fabricate contract (see its doc
// comment immediately below): sync fetch to
// https://api.anthropic.com/v1/messages, ANTHROPIC_API_KEY from env, model
// claude-opus-4-8. Returns null — NEVER throws, NEVER fabricates — on
// missing key / network failure / non-200 / unparseable body.
//
// Grounding (Daniel's "kun kildebasert" + "ingen oppdiktede fakta"): the
// prompt passes ONLY the already-fetched, already-extracted visible page
// text (sourceText — the SAME extractVisibleText(combinedHtml) the calling
// route already computed, capped to ~6000 chars here — no new fetch/host-
// binding surface) + the current value as context (build on real existing
// content, don't replace it wholesale), with an explicit kun-kildebasert
// instruction and an escape sentinel (GARDSSALG_REWRITE_SENTINEL) the model
// must return verbatim when the source text can't support a genuine
// 200-400 char expansion.
//
// Length gate is enforced HERE, in code — not trusted to the prompt alone:
// a non-sentinel response is only accepted if
// GARDSSALG_REWRITE_MIN_LEN <= trimmed.length <= GARDSSALG_REWRITE_MAX_LEN
// (the 500 soft ceiling above the 400 target tolerates natural sentence-
// boundary overshoot). Anything outside that range — including the sentinel
// itself — is null; never truncated mid-sentence.
//
// Exported (unlike generateTitleNo) purely so it has a direct unit-test
// surface for its own never-fabricate contract, separate from the
// route-level dry-run/apply test.
const GARDSSALG_REWRITE_SENTINEL = "INGEN_UTVIDELSE_MULIG";
const GARDSSALG_REWRITE_SOURCE_CHAR_CAP = 6000;
const GARDSSALG_REWRITE_MIN_LEN = 200;
const GARDSSALG_REWRITE_MAX_LEN = 500;

// The profile template renders about_text/visit_text as plain text, so any
// markdown the model emits lands on the public page as literal syntax —
// found live 2026-07-19 on the first real rewrite ("**Smaksprøver og
// foredrag**" rendered with raw asterisks on Røros' Besøket section, batch
// held + field rolled back). The prose in that candidate was grounded and
// fine; only the formatting was noise — so strip the common markers rather
// than reject the candidate (a reject would silently shrink the rescued
// cohort for a purely cosmetic reason). Prompt also instructs plain text,
// but per this file's convention the output contract is enforced in code,
// never trusted to the prompt alone. Collapses to single-paragraph prose
// (newlines → space) since the template renders one flow anyway.
function stripMarkdownArtifacts(s: string): string {
  return s
    .replace(/^#{1,6}\s+/gm, "")            // # headings (marker only — text kept)
    // Bullets BEFORE bold/italic (review finding, round 1): on "* Vi har
    // *mange* gode øl" the bullet star would otherwise pair with the
    // italic's opening star and leak a raw "*" into the result. The bullet
    // regex requires whitespace after the marker, so "*kursiv*"/"**fet**"
    // at line start are untouched. A plain "- " reply-dash at line start is
    // knowingly eaten too (acceptable in this domain; typographic "– "/"— "
    // are preserved).
    .replace(/^\s*[-*•]\s+/gm, "")          // list bullets at line start
    // Links/images (review round 2 — the most realistic remaining leak):
    // "[nettsiden](https://…)" must land as "nettsiden", never with raw
    // bracket/paren syntax. Runs before bold/italic so link TEXT can still
    // carry emphasis markers that the later rules then strip.
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/^\s*>\s+/gm, "")              // blockquote markers at line start
    .replace(/^[=\-_]{3,}\s*$/gm, "")       // horizontal rules / setext underlines
    .replace(/\*\*([^*]+)\*\*/g, "$1")      // **bold**
    .replace(/__([^_]+)__/g, "$1")          // __bold__
    // Paired same-line italics — but only when the stars hug the text
    // ("*ord*"), so spaced multiplication signs ("2 * 3") never pair up and
    // silently change meaning; they instead survive to the residual check
    // below and reject the candidate (skip, never corrupt).
    .replace(/\*(\S(?:[^*\n]*?\S)?)\*/g, "$1")
    .replace(/`+/g, "")                      // code ticks
    .replace(/\s*\n+\s*/g, " ")             // newlines → single-paragraph flow
    .replace(/ {2,}/g, " ")
    .trim();
}

// Fail-closed residual check (review finding, round 1): stripping handles the
// well-formed shapes, but unpaired "**", "_kursiv_", spaced "*" etc. can
// survive it — and this contract is "no markdown artifact ever reaches the
// public page", not "most don't". Any leftover marker → reject the candidate
// entirely (skip-not-publish, same bias as the rest of the never-fabricate
// contract). Underscore is included: legitimate underscores in this prose are
// essentially nonexistent (a URL-bearing candidate is fine to skip), and
// rejecting beats corrupting. This also makes the one-pass strip safe despite
// not being strictly idempotent — nothing with residual syntax ever lands.
// Round-2 widening: brackets (leftover link/checkbox syntax), backslash
// (escaped-markdown remnants like "\*ekte\*" → "\ekte\") and ">" (inline
// blockquote remnants) — all verified publishable through the narrower set.
// Round-3 widening (reviewer's own recipe, verbatim): "~" (strikethrough —
// "~~stengt~~" would read as CURRENT text once published raw) and "|"
// (markdown tables → pipe soup); neither has legitimate use in this prose.
// NB: a link URL containing ")" can leave a stray paren behind (e.g.
// wikipedia "...(bruk))" links) — parens can't join this set (legitimate
// prose), accepted cosmetic residue.
const GARDSSALG_REWRITE_RESIDUAL_MARKDOWN = /[*#`_\\[\]>~|]/;

export async function generateGardssalgAboutRewrite(
  sourceText: string,
  currentValue: string,
  kind: "about" | "visit"
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const cappedSource = (sourceText || "").slice(0, GARDSSALG_REWRITE_SOURCE_CHAR_CAP);
  const sectionLabel = kind === "about" ? "Om produsenten" : "Besøket hos produsenten";
  const prompt = `Du skal utvide en kort, men allerede godkjent, norsk tekst om en gårdsprodusent (seksjonen "${sectionLabel}") til en mer utfyllende tekst på 200–400 tegn.

Nåværende tekst: ${currentValue}

Kildetekst (hentet fra produsentens egen nettside):
${cappedSource}

Bruk KUN fakta som faktisk står i kildeteksten under. Ikke finn på detaljer, produkter, åpningstider eller annet som ikke er nevnt. Svar i ren løpende tekst uten markdown-formatering — ingen stjerner, overskrifter, punktlister eller linjeskift. Hvis kildeteksten ikke gir nok materiale til en utvidet, faktabasert tekst på 200–400 tegn, svar med nøyaktig ${GARDSSALG_REWRITE_SENTINEL} og ingenting annet.`;

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    return null; // network/fetch failure — never fabricate
  }

  if (!response.ok) return null;

  let result: any;
  try {
    result = await response.json();
  } catch {
    return null; // unparseable JSON body — never fabricate
  }

  const contentArr = Array.isArray(result?.content) ? result.content : [];
  const text = contentArr.find((c: any) => c?.type === "text")?.text;
  if (typeof text !== "string") return null;
  const cleaned = text.trim();
  if (cleaned === GARDSSALG_REWRITE_SENTINEL) return null; // explicit "not enough material" escape

  // Strip markdown BEFORE the length gate: the gate must judge the exact
  // string that would land on the public page, not a version padded by
  // formatting syntax (a 205-char candidate that is 195 chars of prose plus
  // asterisks must be rejected as too short, not accepted).
  const plain = stripMarkdownArtifacts(cleaned);

  // Sentinel embedded/wrapped rather than verbatim (review finding, round 1:
  // "**INGEN_UTVIDELSE_MULIG**", or the sentinel inside ≥200 chars of prose)
  // must also count as "no expansion possible" — the raw === check above only
  // catches the exact form the prompt asks for. Checked BEFORE the residual
  // gate (round-2 finding: the sentinel itself contains "_", so the other
  // order made this line unreachable dead code).
  if (plain.includes(GARDSSALG_REWRITE_SENTINEL)) return null;

  // Residual markers after stripping (unpaired "**", "_x_", spaced "*", …)
  // → reject outright; see GARDSSALG_REWRITE_RESIDUAL_MARKDOWN's comment.
  if (GARDSSALG_REWRITE_RESIDUAL_MARKDOWN.test(plain)) return null;

  // Length gate enforced in code, not trusted to the prompt alone (spec
  // requirement) — reject anything outside [200, 500], never truncate.
  if (plain.length < GARDSSALG_REWRITE_MIN_LEN || plain.length > GARDSSALG_REWRITE_MAX_LEN) return null;
  return plain;
}

// ─── generateGardssalgAboutFromSource (dev-request 2026-07-20-gardssalg-
//     fyll-blank-fra-kildeinnhold) ──────────────────────────────────────────
// Source-grounded GENERATE-FROM-SCRATCH of about_text for the "completely
// blank, extractive pass found nothing usable" cohort — distinct from
// generateGardssalgAboutRewrite (slice 5a) above, which only ever EXPANDS an
// already non-blank, already-passing-bar value. ~22 gårdssalg providers have
// a real homepage that fetches fine, but summarizeAbout()'s extractive
// heuristics (no og:description, no matching keyword block) come up with
// nothing that clears meetsAboutQualityBar, and gardssalgRewriteEligible()
// never fires either (it requires a non-blank current value) — so today
// NOTHING fills about_text for them. This function is the dedicated fill
// path for exactly that gap.
//
// Mirrors generateGardssalgAboutRewrite's exact never-fabricate contract:
// sync fetch to https://api.anthropic.com/v1/messages, ANTHROPIC_API_KEY
// from env, model claude-opus-4-8. Returns null — NEVER throws, NEVER
// fabricates — on missing key / network failure / non-200 / unparseable
// body / the sentinel / residual markdown / failing the shared quality bar.
//
// Grounding: the prompt passes ONLY the already-fetched, already-extracted
// visible page text (pageText — the SAME extractVisibleText(combinedHtml)
// the calling route already computed, capped to the same
// GARDSSALG_REWRITE_SOURCE_CHAR_CAP — no new fetch/host-binding surface) and
// the producer's name (navn, for the model to address the right entity),
// with an explicit kun-kildebasert instruction and the SAME escape sentinel
// (GARDSSALG_REWRITE_SENTINEL) the model must return verbatim when the
// source text can't support a genuine short factual paragraph. Unlike the
// rewrite prompt's 200–400 char expansion target, this asks for a FRESH
// short text (~100–300 chars) since there is no existing text to build on.
//
// Signature is deliberately 2-arg (pageText, navn) — the dev-request's draft
// spec sketched a third `sted` (place) arg, but GardssalgContentRefreshTarget
// (services/experience-store.ts) has no city/kommune column and no other
// consumer needs one; extending the SELECT/type purely for this would be
// scope creep for a single-field ask. Noted as a deliberate deviation.
//
// Acceptance is judged by the SAME meetsAboutQualityBar() every other
// extractive/fill candidate in this route already has to clear (no separate
// arbitrary length range) — this is a FILL-blank candidate, so it must be
// genuinely good enough to stand alone as the field's sole content.
export async function generateGardssalgAboutFromSource(
  pageText: string,
  navn: string
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const cappedSource = (pageText || "").slice(0, GARDSSALG_REWRITE_SOURCE_CHAR_CAP);
  const prompt = `Skriv en kort, faktabasert norsk tekst (seksjonen "Om produsenten") om gårdsprodusenten "${navn}", på ca. 100–300 tegn.

Kildetekst (hentet fra produsentens egen nettside):
${cappedSource}

Bruk KUN fakta som faktisk står i kildeteksten under. Ikke finn på detaljer, produkter, åpningstider eller annet som ikke er nevnt der. Svar i ren løpende tekst uten markdown-formatering — ingen stjerner, overskrifter, punktlister eller linjeskift. Hvis kildeteksten ikke gir nok materiale til en genuin, faktabasert tekst om produsenten, svar med nøyaktig ${GARDSSALG_REWRITE_SENTINEL} og ingenting annet.`;

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    return null; // network/fetch failure — never fabricate
  }

  if (!response.ok) return null;

  let result: any;
  try {
    result = await response.json();
  } catch {
    return null; // unparseable JSON body — never fabricate
  }

  const contentArr = Array.isArray(result?.content) ? result.content : [];
  const text = contentArr.find((c: any) => c?.type === "text")?.text;
  if (typeof text !== "string") return null;
  const cleaned = text.trim();
  if (cleaned === GARDSSALG_REWRITE_SENTINEL) return null; // explicit "not enough material" escape

  // Strip markdown BEFORE the quality-bar check — same reasoning as the
  // rewrite helper: the bar must judge the exact string that would land on
  // the public page, not a version padded/shortened by formatting syntax.
  const plain = stripMarkdownArtifacts(cleaned);

  // Sentinel embedded/wrapped rather than verbatim — same two-check
  // discipline as generateGardssalgAboutRewrite (checked BEFORE the residual
  // gate since the sentinel itself contains "_").
  if (plain.includes(GARDSSALG_REWRITE_SENTINEL)) return null;

  // Residual markers after stripping (unpaired "**", "_x_", spaced "*", …)
  // → reject outright; see GARDSSALG_REWRITE_RESIDUAL_MARKDOWN's comment.
  if (GARDSSALG_REWRITE_RESIDUAL_MARKDOWN.test(plain)) return null;

  // Acceptance gate enforced in code, not trusted to the prompt alone: reuse
  // the SAME shared quality bar every other fill candidate in this route is
  // judged by, rather than inventing a separate arbitrary length range.
  if (!meetsAboutQualityBar(plain)) return null;
  return plain;
}

// ─── generateGardssalgProductList (dev-request 2026-07-18-gardssalg-
//     profilkvalitet-foer-outreach, slice 5c) ────────────────────────────────
// Fill-only extraction of the drink/product names a gårdssalg provider
// actually sells, sourced ONLY from the already-fetched, already-extracted
// visible page text (sourceText — the SAME extractVisibleText(combinedHtml)
// the calling route already computed, capped like the rewrite helper — no
// new fetch/host-binding surface). Mirrors generateGardssalgAboutRewrite's
// exact never-fabricate contract: sync fetch to
// https://api.anthropic.com/v1/messages, ANTHROPIC_API_KEY from env, model
// claude-opus-4-8. Returns null — NEVER throws, NEVER fabricates — on
// missing key / network failure / non-200 / unparseable body / a response
// that isn't a valid JSON array / an empty result after validation.
//
// Grounding (Daniel's "kun kildebasert" + "ingen oppfunne produkter"): the
// prompt instructs the model to list ONLY product/drink names literally
// present in the source text, in the exact wording used there, and to
// return the literal sentinel GARDSSALG_PRODUCTS_SENTINEL when the source
// text names no products at all.
//
// Validation is enforced HERE, in code — not trusted to the prompt alone:
// the response must parse as JSON representing an array; non-string,
// empty-after-trim, or over-length (> GARDSSALG_PRODUCTS_MAX_ITEM_LEN)
// entries are silently dropped (filtering, not fabricating — never invents
// a replacement for a dropped entry); the survivors are deduped case-
// insensitively (first occurrence wins) and capped to
// GARDSSALG_PRODUCTS_MAX_ITEMS. An empty list after all of that (including
// the explicit sentinel) is null, never an empty-but-truthy array.
const GARDSSALG_PRODUCTS_SENTINEL = "INGEN_PRODUKTER_FUNNET";
const GARDSSALG_PRODUCTS_SOURCE_CHAR_CAP = 6000;
const GARDSSALG_PRODUCTS_MAX_ITEMS = 20;
const GARDSSALG_PRODUCTS_MAX_ITEM_LEN = 60;

export async function generateGardssalgProductList(sourceText: string): Promise<string[] | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const cappedSource = (sourceText || "").slice(0, GARDSSALG_PRODUCTS_SOURCE_CHAR_CAP);
  const prompt = `Lag en liste over produkter/drikkevarer denne gårdsprodusenten selger, KUN basert på kildeteksten under.

Kildetekst (hentet fra produsentens egen nettside):
${cappedSource}

Bruk KUN produktnavn som faktisk står i kildeteksten, med samme ordlyd som der. Ikke finn på produkter som ikke er nevnt. Svar med EKSAKT et JSON-array av strenger, f.eks. ["Eplesider","Eplemost"], og ingenting annet. Hvis kildeteksten ikke nevner noen konkrete produkter, svar med nøyaktig ${GARDSSALG_PRODUCTS_SENTINEL} og ingenting annet.`;

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    return null; // network/fetch failure — never fabricate
  }

  if (!response.ok) return null;

  let result: any;
  try {
    result = await response.json();
  } catch {
    return null; // unparseable JSON body — never fabricate
  }

  const contentArr = Array.isArray(result?.content) ? result.content : [];
  const text = contentArr.find((c: any) => c?.type === "text")?.text;
  if (typeof text !== "string") return null;
  const cleaned = text.trim();
  if (cleaned === GARDSSALG_PRODUCTS_SENTINEL) return null; // explicit "no products" escape

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null; // not valid JSON — never fabricate/guess a list from prose
  }
  if (!Array.isArray(parsed)) return null;

  const seen = new Set<string>();
  const items: string[] = [];
  for (const raw of parsed) {
    if (typeof raw !== "string") continue;
    const item = raw.trim();
    if (!item || item.length > GARDSSALG_PRODUCTS_MAX_ITEM_LEN) continue;
    const key = item.toLocaleLowerCase("nb-NO");
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length >= GARDSSALG_PRODUCTS_MAX_ITEMS) break;
  }

  return items.length > 0 ? items : null;
}

// Calls the Anthropic API the same way ClaudeVisionProvider.analyze() does
// (src/services/vision-provider.ts) — sync fetch to
// https://api.anthropic.com/v1/messages, ANTHROPIC_API_KEY from env,
// x-api-key/anthropic-version headers. One row per call. Returns null (never
// throws) on any failure so the caller can skip-not-fabricate.
//
// `fetchImpl` defaults to the real global `fetch`, so production behavior is
// unchanged; it exists purely as an injection seam so tests can supply a
// scoped stub (via the Express app instance's "titleNoBackfillFetchImpl"
// setting, resolved in the route handler below) instead of overwriting
// `globalThis.fetch`, which would leak into other concurrently-running
// test blocks.
async function generateTitleNo(
  candidate: TitleNoCandidate,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const place = [candidate.kommune, candidate.fylke].filter(Boolean).join(", ");
  const prompt = `Gi en naturlig norsk visningstittel for denne opplevelsen (kort, ingen anførselstegn, ingen annen tekst).

Tittel: ${candidate.title}
Kategori: ${candidate.category || "ukjent"}
Sted: ${place || "ukjent"}`;

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    return null; // network/fetch failure — never fabricate
  }

  if (!response.ok) return null;

  let result: any;
  try {
    result = await response.json();
  } catch {
    return null; // unparseable JSON body — never fabricate
  }

  const contentArr = Array.isArray(result?.content) ? result.content : [];
  const text = contentArr.find((c: any) => c?.type === "text")?.text;
  if (typeof text !== "string") return null;
  const cleaned = text.trim().replace(/^["'«]+|["'»]+$/g, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

router.post("/admin/experiences-title-no-backfill", requireAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { dry_run?: unknown };
  // STRICT-FALSE parse (same idiom as /admin/experiences-dedup-unmerge above):
  // writes execute ONLY on the JSON boolean false. null / "false" / 0 / "" /
  // undefined all mean dry run.
  const dryRun = body.dry_run !== false;

  // Per-app-instance fetch injection seam (see generateTitleNo's doc comment
  // above): tests set this via `app.set("titleNoBackfillFetchImpl", stub)`
  // on their OWN Express app instance. Production never sets it, so
  // `req.app.get(...)` returns undefined and we fall back to the real global
  // `fetch` — production behavior is unchanged.
  const fetchImpl =
    (req.app.get("titleNoBackfillFetchImpl") as typeof fetch | undefined) ?? fetch;

  const db = getExpDb("experiences");
  const candidateRows = db
    .prepare(
      `SELECT id, title, category, kommune, fylke FROM experiences
       WHERE canonical_id IS NULL AND title_no IS NULL
       ORDER BY id`
    )
    .all() as TitleNoCandidate[];

  if (dryRun) {
    const sample = candidateRows.slice(0, TITLE_NO_DRY_RUN_SAMPLE);
    const proposals: Array<{ id: string; title: string; proposed_title_no: string | null }> = [];
    for (const row of sample) {
      const proposed = await generateTitleNo(row, fetchImpl);
      proposals.push({ id: row.id, title: row.title, proposed_title_no: proposed });
    }
    res.json({
      success: true,
      dry_run: true,
      candidates: candidateRows.length,
      sample: proposals,
    });
    return;
  }

  const batch = candidateRows.slice(0, TITLE_NO_BATCH_CAP);
  const generated: Array<{ id: string; title_no: string | null }> = [];
  for (const row of batch) {
    generated.push({ id: row.id, title_no: await generateTitleNo(row, fetchImpl) });
  }

  const setTitleNo = db.prepare(
    "UPDATE experiences SET title_no = ?, updated_at = datetime('now') WHERE id = ?"
  );
  const tx = db.transaction(() => {
    for (const r of generated) {
      if (r.title_no) setTitleNo.run(r.title_no, r.id);
    }
  });
  tx();

  const written = generated.filter((r) => r.title_no).length;
  const skippedCount = generated.length - written;

  res.json({
    success: true,
    dry_run: false,
    candidates: candidateRows.length,
    processed: generated.length,
    written,
    skipped: skippedCount,
    remaining: Math.max(0, candidateRows.length - generated.length),
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// dev-request 2026-07-12-opplevagent-serp-innholdsberikelse, item 1
// ("Innholdsberikelse") — POST /admin/experiences-description-enrichment
// ═══════════════════════════════════════════════════════════════════════════
//
// PROBLEM. A large share of opplevagent.no detail pages render the
// placeholder lede in routes/experiences-seo.ts (`descBlock`'s else branch):
// "Detaljert beskrivelse publiseres fortløpende. <tittel> er en <kategori>-
// opplevelse i <sted>. Se tilbyderens nettside for program, priser og
// bestilling." — because `experiences.description` is blank, or holds
// scraped nav junk that isJunkDescription() suppresses at render time.
//
// WHAT THIS BUILDS. A fail-closed writer for that column: for each candidate
// row it generates a ≥400-word Norwegian description grounded ONLY in that
// row's OWN structured catalog columns (the exact field set the detail page
// already renders as `facts`/`badges`), has a SECOND LLM judge verify the
// text invents nothing and is real prose, and only then writes it. The read
// path is untouched — experiences-seo.ts already renders `description` when
// it is present and non-junk.
//
// SAFETY POSTURE (read before changing anything here)
// ───────────────────────────────────────────────────
// This writer publishes prose on public, indexed pages under a provider's
// name. A fabricated price/opening hour/landmark is a wrong-data incident,
// not a copy nit. Every gate below is therefore fail-closed — "skip this
// row" is always cheaper than "write something we are not sure about":
//
//   1. GROUNDING. The prompt carries nothing but the row's own structured
//      fields (plus the provider name/Brreg flag from the JOIN). No scraped
//      page text, no web search, no model world-knowledge is invited in.
//   2. THIN DATA -> SKIP, NEVER PAD. A row with fewer than
//      EXP_DESC_MIN_FACT_FIELDS populated fact-fields never reaches the LLM
//      at all (zero tokens spent). Padding a two-fact row up to 400 words
//      is exactly how invented facts get in.
//   3. DETERMINISTIC POST-CHECKS before the judge: sentinel escape, word
//      floor/ceiling, char cap, and an ungrounded-number scan (every digit
//      run in the prose must appear in the facts block — prices, durations,
//      group sizes and years are the highest-risk fabrication class and the
//      cheapest to catch without a model).
//   4. LLM JUDGE. Same exact-token GODKJENN/AVVIS contract as
//      judgeGardssalgAboutCandidate() above; any doubt -> AVVIS.
//   5. WRITE ONLY IF BOTH the generator and the judge succeeded. Missing
//      ANTHROPIC_API_KEY, network failure, non-200, unparseable JSON or an
//      unexpected shape at EITHER step resolves to "skip", never a throw.
//   6. NEVER OVERWRITE GOOD COPY. Candidates are only rows whose current
//      description is blank or fails isJunkDescription().
//
// WHY NOT isExperienceContentLocked() AS THE CANDIDATE GATE (deliberate).
// That predicate locks a row when `verification_status === 'verified'` OR
// content_source is 'manual'/'claim'. Its purpose is stopping a SCRAPE from
// overwriting human/verified content. Reusing it wholesale here would make
// this feature a no-op: PUBLISH_GATE_SQL only serves rows with
// verification_status = 'verified', so the verified half covers 100% of the
// pages that actually show the placeholder. This writer is a different
// animal from a scrape — it never overwrites a good value, and its input is
// the row's own already-verified structured columns rather than an external
// page. So we honour the HUMAN-AUTHORED half of that lock (content_source
// 'manual'/'claim' rows are skipped: a curator/owner touched that row, and
// machine prose should not land on it without them) and deliberately do NOT
// apply the `verified` half. Anyone widening this gate should re-read this
// paragraph first.
import { isJunkDescription as expDescIsJunk } from "../services/description-quality";
import { parseContentFieldEvidence as expDescParseFieldEvidence } from "../services/experience-store";

// Batch cap: HALF of TITLE_NO_BATCH_CAP (20). This feature spends TWO LLM
// calls per row (generate + judge) instead of one, and the generate call
// emits ~400-1200 words rather than a short title — so 10 rows/call keeps
// both the per-request call count (<=20) and the per-request token spend in
// the same ballpark the title-no backfill already proved safe. The
// orchestrator drives the backlog by calling repeatedly, exactly as it does
// for title-no.
const EXP_DESC_BATCH_CAP = 10;
// Dry-run sample: 3 (vs. title-no's 5) for the same reason — a dry run is
// still 2 real LLM calls per sampled row, and 3 proposals are plenty to
// eyeball quality before an apply run.
const EXP_DESC_DRY_RUN_SAMPLE = 3;
// Hard cap on an explicit `ids` list, mirroring the providerIds caps on the
// gårdssalg admin endpoints above (a named priority list, not a bulk lever).
const EXP_DESC_IDS_CAP = 100;

// THIN-DATA THRESHOLD. A row must carry at least this many DISTINCT populated
// fact-fields (out of the 13 buildExperienceDescriptionFacts() knows about)
// before we are willing to ask for 400 words about it.
//
// Why 6: the fact set is category, subcategory, place, season, inne/ute,
// varighet, gruppe, pris, språk, tilgjengelighet, oppmøtested, bestilling,
// tilbyder. A row with <6 of them is essentially "title + category + a
// municipality" — there is no honest way to reach 400 words from that, so
// the model would have to pad or invent, and the judge would (correctly)
// reject the result after we had already paid for two calls. 6 is also
// comfortably above the floor a bulk-loaded harvest row lands on
// (title/category/kommune/fylke, i.e. 2 fact-fields since kommune+fylke
// collapse into one "Sted" fact), so the gate actually bites. It is
// deliberately a count of DISTINCT FACT KINDS, not of non-null columns:
// kommune+fylke count once, duration_min+duration_max count once, and a
// price_band of 'ukjent' counts as nothing at all.
const EXP_DESC_MIN_FACT_FIELDS = 6;

// The dev-request's own bar. Below it we skip rather than write a short one:
// the placeholder we are replacing is at least honest about being a stub.
const EXP_DESC_MIN_WORDS = 400;
// Ceiling: a run-away generation (repetition loops) is a quality failure, not
// a bonus. ~1200 words is 3x the floor.
const EXP_DESC_MAX_WORDS = 1200;
const EXP_DESC_MAX_CHARS = 12000;
// Escape hatch the model may return instead of padding — same idiom as
// GARDSSALG_PRODUCTS_SENTINEL / GARDSSALG_REWRITE_SENTINEL above.
const EXP_DESC_SENTINEL = "UTILSTREKKELIG_GRUNNLAG";
// Verdict protocol: deliberately the SAME two tokens judgeGardssalgAbout-
// Candidate() uses, declared separately so the two judges can evolve their
// prompts independently without one silently redefining the other's tokens.
const EXP_DESC_JUDGE_APPROVE_TOKEN = "GODKJENN";
const EXP_DESC_JUDGE_REJECT_TOKEN = "AVVIS";

/**
 * Per-field provenance recorded for a description written by THIS writer.
 * Deliberately not a URL, exactly like HARVEST_PROVENANCE_SENTINEL in
 * experience-store.ts: isContentFieldHomepageSourced() must never mistake
 * LLM prose for the provider's own homepage copy. Concretely this keeps the
 * row inside isExperienceContentGenuinelyThin()'s candidate pool — i.e. the
 * twice-daily homepage content-refresh selector behaves exactly as it did
 * before this endpoint existed, instead of silently reclassifying the row as
 * `done` the moment we fill `description`. (applyExperienceContent is
 * fill-only, so it can never clobber what we wrote either way.)
 */
export const EXP_DESC_GENERATED_PROVENANCE_SENTINEL = "generated:katalogfelt-llm";

/** The row shape the generator/judge are grounded on — the SAME field set
 *  routes/experiences-seo.ts builds its `facts`/`badges` from. */
export type ExperienceDescriptionCandidate = {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  subcategory: string | null;
  season: string | null;          // JSON array text
  indoor_outdoor: string | null;
  duration_min: number | null;
  duration_max: number | null;
  group_min: number | null;
  group_max: number | null;
  price_band: string | null;
  price_from: number | null;
  price_unit: string | null;
  languages: string | null;       // JSON array text
  accessibility: string | null;   // JSON array text
  meeting_point: string | null;
  kommune: string | null;
  fylke: string | null;
  booking_url: string | null;
  content_source: string | null;
  content_field_evidence: string | null;
  provider_navn: string | null;
  provider_brreg_verified: number | null;
};

// Norwegian display labels. Intentional small duplication of the maps in
// routes/experiences-seo.ts (CATEGORY_LABELS / SEASON_LABELS / ioLabel /
// PRICE_BAND_LABELS), which are module-private there — same call this repo
// already made for services/experience-og-image.ts's companion colour map.
// Importing a route module from another route module to share ten short
// strings is more coupling than the duplication costs, and drift here can
// only change PROMPT wording (these values are never rendered), so it is a
// copy nit, not a correctness hazard.
const EXP_DESC_CATEGORY_LABELS: Record<string, string> = {
  vinter_sno: "Vinter og snø",
  sightseeing_transport: "Sightseeing og transport",
  dyreliv_safari: "Dyreliv og safari",
  natur_friluft: "Natur og friluft",
  kultur_historie: "Kultur og historie",
  overnatting_opplevelse: "Overnatting og opplevelse",
  adrenalin_action: "Adrenalin og action",
  velvaere_spa: "Velvære og spa",
  mat_drikke: "Mat og drikke",
  gardssalg: "Gårdssalg og smaking",
};
const EXP_DESC_SEASON_LABELS: Record<string, string> = {
  summer: "sommer", winter: "vinter", spring: "vår",
  autumn: "høst", fall: "høst", year_round: "hele året",
};
const EXP_DESC_PRICE_BAND_LABELS: Record<string, string> = {
  gratis: "gratis", rimelig: "rimelig prisnivå",
  standard: "standard prisnivå", premium: "premium prisnivå",
};

/** Safe JSON-array-column read. Never throws, never guesses a list out of a
 *  non-JSON string — an unreadable column is simply "no fact here". */
function expDescJsonArray(raw: string | null | undefined): string[] {
  const t = (raw ?? "").trim();
  if (!t) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return []; // not JSON — treat as absent, never parsed out of prose
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .map((v) => v.trim());
}

/**
 * The row's populated fact-fields, as [norsk etikett, verdi] pairs — the ONLY
 * material the generator is ever given. Mirrors the detail page's facts table
 * (routes/experiences-seo.ts ~line 1863) field for field, so what we ground on
 * is exactly what the page already claims. Each entry is one DISTINCT fact
 * kind (see EXP_DESC_MIN_FACT_FIELDS), and `facts.length` is the thin-data
 * measure.
 */
export function buildExperienceDescriptionFacts(
  row: ExperienceDescriptionCandidate
): Array<[string, string]> {
  const facts: Array<[string, string]> = [];

  const cat = (row.category ?? "").trim();
  if (cat) facts.push(["Kategori", EXP_DESC_CATEGORY_LABELS[cat] || cat.replace(/_/g, " ")]);

  const sub = (row.subcategory ?? "").trim();
  if (sub) facts.push(["Underkategori", sub.replace(/_/g, " ")]);

  const place = [row.kommune, row.fylke].map((v) => (v ?? "").trim()).filter(Boolean).join(", ");
  if (place) facts.push(["Sted", place]);

  const seasons = expDescJsonArray(row.season).map((s) => EXP_DESC_SEASON_LABELS[s] || s);
  if (seasons.length) facts.push(["Sesong", seasons.join(", ")]);

  const io = row.indoor_outdoor === "indoor" ? "innendørs"
    : row.indoor_outdoor === "outdoor" ? "utendørs"
    : row.indoor_outdoor === "both" ? "både inne og ute" : "";
  if (io) facts.push(["Inne eller ute", io]);

  if (row.duration_min || row.duration_max) {
    const d = row.duration_min && row.duration_max && row.duration_min !== row.duration_max
      ? `${row.duration_min}-${row.duration_max} minutter`
      : `omtrent ${row.duration_min || row.duration_max} minutter`;
    facts.push(["Varighet", d]);
  }

  if (row.group_min || row.group_max) {
    const g = row.group_min && row.group_max
      ? `${row.group_min}-${row.group_max} personer`
      : row.group_max ? `inntil ${row.group_max} personer` : `fra ${row.group_min} personer`;
    facts.push(["Gruppestørrelse", g]);
  }

  // price_band 'ukjent' literally means "we do not know" — it is not a fact.
  const band = (row.price_band ?? "").trim();
  const bandIsFact = band !== "" && band !== "ukjent";
  if (row.price_from || bandIsFact) {
    const unit = row.price_unit === "per_person" ? " per person"
      : row.price_unit === "per_group" ? " per gruppe" : "";
    const pr = row.price_from
      ? `fra ${row.price_from} kroner${unit}`
      : (EXP_DESC_PRICE_BAND_LABELS[band] || band);
    facts.push(["Pris", pr]);
  }

  const langs = expDescJsonArray(row.languages);
  if (langs.length) facts.push(["Språk", langs.join(", ")]);

  const acc = expDescJsonArray(row.accessibility);
  if (acc.length) facts.push(["Tilgjengelighet", acc.join(", ")]);

  const meet = (row.meeting_point ?? "").trim();
  if (meet) facts.push(["Oppmøtested", meet]);

  // The URL itself is deliberately NOT handed to the model (nothing good
  // comes of prose quoting a booking link) — only the FACT that the tilbyder
  // takes bookings through their own channel.
  if ((row.booking_url ?? "").trim()) {
    facts.push(["Bestilling", "opplevelsen bestilles hos tilbyderen via tilbyderens egen bestillingsside"]);
  }

  const provName = (row.provider_navn ?? "").trim();
  if (provName) {
    facts.push([
      "Tilbyder",
      Number(row.provider_brreg_verified) === 1
        ? `${provName} (verifisert mot Brønnøysundregistrene)`
        : provName,
    ]);
  }

  return facts;
}

/** The exact text block handed to BOTH the generator and the judge, so the
 *  judge grades against byte-identical grounding material. */
export function renderExperienceDescriptionFactsBlock(
  row: ExperienceDescriptionCandidate,
  facts: Array<[string, string]>
): string {
  return [`Tittel: ${row.title}`, ...facts.map(([k, v]) => `${k}: ${v}`)].join("\n");
}

/** Whitespace word count — the deterministic half of the ≥400-ord bar. */
export function expDescWordCount(text: string | null | undefined): number {
  const t = (text ?? "").trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

/**
 * True when the prose contains a number that does NOT appear in the facts
 * block — i.e. an invented price, duration, group size, year, distance or
 * count. Cheap, deterministic, and it catches the single highest-risk
 * fabrication class before we spend a judge call on it.
 *
 * Digit groups are normalised first so a thousands separator can't cause a
 * false positive ("1 200 kroner" in the prose vs. "1200" in the facts). The
 * prompt tells the model in as many words to use no numbers beyond the fact
 * list and to spell numbers out where it can, so a hit here is a real signal
 * rather than an inevitability. Fail-closed either way: a hit means we skip
 * the row, never that we write something doubtful.
 */
export function expDescHasUngroundedNumbers(text: string, factsBlock: string): boolean {
  const normalise = (s: string) => s.replace(/(\d)[ .\u00a0](?=\d)/g, "$1");
  const allowed = new Set((normalise(factsBlock).match(/\d+/g) ?? []).map((n) => String(Number(n))));
  for (const raw of normalise(text).match(/\d+/g) ?? []) {
    if (!allowed.has(String(Number(raw)))) return true;
  }
  return false;
}

/**
 * Generate the description. Mirrors generateTitleNo()'s never-fabricate,
 * never-throw contract byte for byte: direct fetch to
 * https://api.anthropic.com/v1/messages, ANTHROPIC_API_KEY from env, model
 * claude-haiku-4-5 (the model every generate/judge call site in this file
 * uses today), `fetchImpl` as the DI seam, and `null` on ANY deviation —
 * missing key, network failure, non-200, unparseable body, unexpected shape,
 * the escape sentinel, or a candidate that fails the deterministic
 * post-checks (word floor/ceiling, char cap, ungrounded numbers).
 *
 * Returns null for a thin row WITHOUT calling the LLM at all.
 */
export async function generateExperienceDescriptionNo(
  row: ExperienceDescriptionCandidate,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  const facts = buildExperienceDescriptionFacts(row);
  if (facts.length < EXP_DESC_MIN_FACT_FIELDS) return null; // thin -> never call the LLM

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const factsBlock = renderExperienceDescriptionFactsBlock(row, facts);
  const prompt = `Du skriver produktbeskrivelser for opplevagent.no, en norsk markedsplass for opplevelser. Skriv beskrivelsen av opplevelsen under.

ABSOLUTTE REGLER:
- Bruk KUN faktaopplysningene i listen nedenfor. Du har ingen annen kunnskap om denne opplevelsen.
- Du skal ALDRI finne på fakta. Ingen priser, klokkeslett, datoer, årstall, avstander, adresser, stedsnavn, severdigheter, fjell, fossefall, personer, historie, utstyr, måltider eller antall som ikke står i listen.
- Ikke bruk tall som ikke står i faktalisten. Skriv heller tall som ord der det er naturlig.
- Ikke gjett hva opplevelsen "sannsynligvis" inneholder, og ikke lån detaljer fra liknende opplevelser du kjenner til.
- Du KAN utdype og forklare de oppgitte faktaene, og gi tydelig generelle, praktiske råd som følger direkte av dem (for eksempel at utendørsaktiviteter krever klær etter været). Slike generelle råd må aldri formuleres som en konkret opplysning om nettopp denne opplevelsen.
- Skriv på norsk bokmål, i sammenhengende avsnitt. Ingen overskrifter, ingen punktlister, ingen markdown, ingen lenker, ingen HTML.
- Teksten skal være minst ${EXP_DESC_MIN_WORDS} ord og høyst ${EXP_DESC_MAX_WORDS} ord.
- Ikke gjenta setninger eller fyll ut med tomme fraser.
- Hvis faktagrunnlaget er for tynt til å skrive ${EXP_DESC_MIN_WORDS} ord uten å finne på noe, svar med KUN dette ordet: ${EXP_DESC_SENTINEL}

Fakta:
${factsBlock}

Svar med kun selve beskrivelsen (eller ${EXP_DESC_SENTINEL}). Ingen innledning, ingen forklaring, ingen anførselstegn.`;

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 3000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    return null; // network/fetch failure — never fabricate
  }

  if (!response.ok) return null;

  let result: any;
  try {
    result = await response.json();
  } catch {
    return null; // unparseable JSON body — never fabricate
  }

  const contentArr = Array.isArray(result?.content) ? result.content : [];
  const text = contentArr.find((c: any) => c?.type === "text")?.text;
  if (typeof text !== "string") return null;

  const cleaned = text.trim();
  if (!cleaned) return null;
  if (cleaned === EXP_DESC_SENTINEL) return null; // explicit "too thin" escape
  if (cleaned.includes(EXP_DESC_SENTINEL)) return null; // sentinel smuggled into prose
  if (cleaned.length > EXP_DESC_MAX_CHARS) return null;

  const words = expDescWordCount(cleaned);
  if (words < EXP_DESC_MIN_WORDS || words > EXP_DESC_MAX_WORDS) return null;

  if (expDescHasUngroundedNumbers(cleaned, factsBlock)) return null;

  return cleaned;
}

export interface ExperienceDescriptionJudgeVerdict {
  approved: boolean;
  reasoning: string;
}

/**
 * The anti-fabrication judge. Same shape and the same fail-closed discipline
 * as judgeGardssalgAboutCandidate() above (exact-token verdict on the first
 * line, any doubt -> reject, never throws, never silently approves) — but the
 * question is different: it is handed BOTH the candidate prose AND the exact
 * facts block the prose was supposed to be grounded in, and must confirm that
 * the text adds no fact that is not in that block.
 */
export async function judgeExperienceDescriptionCandidate(
  candidateText: string,
  factsBlock: string,
  fetchImpl: typeof fetch = fetch
): Promise<ExperienceDescriptionJudgeVerdict> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { approved: false, reasoning: "ANTHROPIC_API_KEY mangler — avvist fail-closed" };
  }

  const capped = (candidateText || "").slice(0, EXP_DESC_MAX_CHARS);
  const prompt = `Du er faktakontrollør for opplevelsesbeskrivelser på den norske markedsplassen opplevagent.no. Teksten under skal være skrevet UTELUKKENDE på grunnlag av faktalisten under, som er alt vi vet om opplevelsen.

Faktaliste (alt som er kjent):
${factsBlock}

Kandidattekst:
${capped}

Svar ${EXP_DESC_JUDGE_APPROVE_TOKEN} KUN hvis ALLE punktene under er oppfylt:
- Hver konkrete opplysning i teksten (pris, varighet, gruppestørrelse, sted, sesong, inne/ute, språk, tilgjengelighet, oppmøtested, bestilling, tilbydernavn) stemmer med faktalisten.
- Teksten inneholder ingen konkrete opplysninger som IKKE står i faktalisten — ingen oppdiktede priser, klokkeslett, datoer, årstall, avstander, adresser, stedsnavn, severdigheter, personer, historie, utstyr, måltider eller antall.
- Teksten er sammenhengende, ekte norsk prosa på minst ${EXP_DESC_MIN_WORDS} ord — ikke fyllstoff, ikke gjentatte setninger, ikke oppramsing av faktalisten.
- Teksten er ren prosa uten overskrifter, punktlister, markdown, lenker eller HTML.

Svar med EKSAKT ett av disse to ordene alene på første linje, etterfulgt av en kort norsk begrunnelse på én setning på neste linje:
${EXP_DESC_JUDGE_APPROVE_TOKEN}
<kort begrunnelse>

eller

${EXP_DESC_JUDGE_REJECT_TOKEN}
<kort begrunnelse>

Ved minste tvil, svar ${EXP_DESC_JUDGE_REJECT_TOKEN}.`;

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    return { approved: false, reasoning: "nettverksfeil under dommer-kall — avvist fail-closed" };
  }

  if (!response.ok) {
    return { approved: false, reasoning: `dommer-API svarte status ${response.status} — avvist fail-closed` };
  }

  let result: any;
  try {
    result = await response.json();
  } catch {
    return { approved: false, reasoning: "ikke-parsbar JSON fra dommer-API — avvist fail-closed" };
  }

  const contentArr = Array.isArray(result?.content) ? result.content : [];
  const text = contentArr.find((c: any) => c?.type === "text")?.text;
  if (typeof text !== "string") {
    return { approved: false, reasoning: "uventet svarformat fra dommer-API — avvist fail-closed" };
  }

  const lines = text.trim().split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const verdictToken = (lines[0] || "").toUpperCase();
  const reasoning = lines.slice(1).join(" ").trim();

  // Only the EXACT approve token approves — a longer sentence that merely
  // CONTAINS the word is a reject, same as the gårdssalg judge.
  if (verdictToken === EXP_DESC_JUDGE_APPROVE_TOKEN) {
    return { approved: true, reasoning: reasoning || "godkjent av LLM-dommer" };
  }
  if (verdictToken === EXP_DESC_JUDGE_REJECT_TOKEN) {
    return { approved: false, reasoning: reasoning || "avvist av LLM-dommer" };
  }
  return { approved: false, reasoning: "uventet/tvetydig dommersvar — avvist fail-closed" };
}

export type ExperienceDescriptionOutcome = {
  id: string;
  title: string;
  fact_count: number;
  thin: boolean;
  proposed_description: string | null;
  word_count: number;
  judge_approved: boolean | null;
  judge_reasoning: string | null;
  skip_reason: "thin_data" | "generation_failed" | "judge_rejected" | null;
};

/**
 * The whole per-row cascade, in ONE function so the dry-run preview and the
 * apply run can never drift on what they would do (the drift hazard this
 * repo already hit with gardssalgReplaceableFieldAction). Pure with respect
 * to the DB — it decides, the caller writes.
 */
export async function enrichOneExperienceDescription(
  row: ExperienceDescriptionCandidate,
  fetchImpl: typeof fetch = fetch
): Promise<ExperienceDescriptionOutcome> {
  const facts = buildExperienceDescriptionFacts(row);
  const base = { id: row.id, title: row.title, fact_count: facts.length };

  if (facts.length < EXP_DESC_MIN_FACT_FIELDS) {
    // Thin -> zero LLM calls, zero tokens, nothing written.
    return {
      ...base, thin: true, proposed_description: null, word_count: 0,
      judge_approved: null, judge_reasoning: null, skip_reason: "thin_data",
    };
  }

  const proposed = await generateExperienceDescriptionNo(row, fetchImpl);
  if (!proposed) {
    return {
      ...base, thin: false, proposed_description: null, word_count: 0,
      judge_approved: null, judge_reasoning: null, skip_reason: "generation_failed",
    };
  }

  const factsBlock = renderExperienceDescriptionFactsBlock(row, facts);
  const verdict = await judgeExperienceDescriptionCandidate(proposed, factsBlock, fetchImpl);
  return {
    ...base,
    thin: false,
    proposed_description: proposed,
    word_count: expDescWordCount(proposed),
    judge_approved: verdict.approved,
    judge_reasoning: verdict.reasoning,
    skip_reason: verdict.approved ? null : "judge_rejected",
  };
}

/** Candidate predicate: blank, or junk by the SAME render-time guard
 *  experiences-seo.ts already suppresses with. A good description is never a
 *  candidate, so it can never be overwritten. */
export function experienceDescriptionNeedsEnrichment(desc: string | null | undefined): boolean {
  const t = (desc ?? "").trim();
  if (!t) return true;
  return expDescIsJunk(t);
}

router.post("/admin/experiences-description-enrichment", requireAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { dry_run?: unknown; ids?: unknown };
  // STRICT-FALSE parse — identical idiom to /admin/experiences-title-no-backfill
  // above: writes execute ONLY on the JSON boolean false. null / "false" / 0 /
  // "" / undefined all mean dry run.
  const dryRun = body.dry_run !== false;

  // Optional priority list. Parameterised placeholders only — never string
  // interpolation of caller data into SQL (same discipline as the
  // providerIds handling on the gårdssalg admin endpoints above).
  //
  // A MALFORMED `ids` is a 400, not a silent fall-through to the unfiltered
  // catalog scan: "I asked for three named rows and instead got a full-batch
  // spend across the whole catalog" is exactly the runaway this cap family
  // exists to prevent. Omitting the key (or sending an explicitly empty
  // array) remains the way to ask for the unfiltered scan.
  let ids: string[] | null = null;
  if (body.ids !== undefined && body.ids !== null) {
    if (!Array.isArray(body.ids)) {
      res.status(400).json({ error: "ids must be an array of experience ids" });
      return;
    }
    if (body.ids.length > 0) {
      ids = (body.ids as unknown[])
        .filter((v): v is string => typeof v === "string" && v.trim() !== "")
        .map((v) => v.trim());
      if (ids.length > EXP_DESC_IDS_CAP) {
        res.status(400).json({ error: `Too many ids (max ${EXP_DESC_IDS_CAP} per call)` });
        return;
      }
      if (ids.length === 0) {
        res.status(400).json({ error: "ids contained no usable experience id" });
        return;
      }
    }
  }

  // Per-app-instance fetch injection seam, same shape as the title-no
  // backfill's `titleNoBackfillFetchImpl`: tests set it on their OWN Express
  // app instance, production never does, so this falls back to global fetch.
  const fetchImpl =
    ((req.app?.get?.("experienceDescriptionFetchImpl")) as typeof fetch | undefined) ?? fetch;

  const db = getExpDb("experiences");
  const sql =
    `SELECT e.id, e.title, e.description, e.category, e.subcategory, e.season,
            e.indoor_outdoor, e.duration_min, e.duration_max, e.group_min, e.group_max,
            e.price_band, e.price_from, e.price_unit, e.languages, e.accessibility,
            e.meeting_point, e.kommune, e.fylke, e.booking_url,
            e.content_source, e.content_field_evidence,
            p.navn AS provider_navn, p.brreg_verified AS provider_brreg_verified
       FROM experiences e
       LEFT JOIN experience_providers p ON p.id = e.provider_id
      WHERE e.canonical_id IS NULL
        AND (e.content_source IS NULL OR e.content_source NOT IN ('manual','claim'))` +
    (ids ? ` AND e.id IN (${ids.map(() => "?").join(",")})` : "") +
    ` ORDER BY e.id`;
  const scanned = (ids ? db.prepare(sql).all(...ids) : db.prepare(sql).all()) as ExperienceDescriptionCandidate[];
  // The junk guard is JS, not SQL — so the blank/junk filter runs here rather
  // than in the WHERE clause. A GOOD existing description drops out at this
  // line and is never seen again by this endpoint.
  const candidateRows = scanned.filter((r) => experienceDescriptionNeedsEnrichment(r.description));

  if (dryRun) {
    // slice() of an empty array iterates zero times -> zero LLM calls, same
    // documented behavior as the title-no backfill's empty-candidate case.
    const sample = candidateRows.slice(0, EXP_DESC_DRY_RUN_SAMPLE);
    const proposals: ExperienceDescriptionOutcome[] = [];
    for (const row of sample) {
      proposals.push(await enrichOneExperienceDescription(row, fetchImpl));
    }
    res.json({
      success: true,
      dry_run: true,
      candidates: candidateRows.length,
      batch_cap: EXP_DESC_BATCH_CAP,
      sample: proposals,
    });
    return;
  }

  const batch = candidateRows.slice(0, EXP_DESC_BATCH_CAP);
  const outcomes: ExperienceDescriptionOutcome[] = [];
  for (const row of batch) {
    outcomes.push(await enrichOneExperienceDescription(row, fetchImpl));
  }

  const writable = batch
    .map((row, i) => ({ row, outcome: outcomes[i] }))
    .filter(({ outcome }) => outcome.judge_approved === true && !!outcome.proposed_description);

  const setDescription = db.prepare(
    "UPDATE experiences SET description = ?, content_field_evidence = ?, updated_at = datetime('now') WHERE id = ?"
  );
  const tx = db.transaction(() => {
    for (const { row, outcome } of writable) {
      const evidence = expDescParseFieldEvidence(row.content_field_evidence);
      evidence.description = EXP_DESC_GENERATED_PROVENANCE_SENTINEL;
      setDescription.run(outcome.proposed_description, JSON.stringify(evidence), row.id);
    }
  });
  tx();

  const written = writable.length;
  const skippedCount = outcomes.length - written;

  res.json({
    success: true,
    dry_run: false,
    candidates: candidateRows.length,
    processed: outcomes.length,
    written,
    skipped: skippedCount,
    remaining: Math.max(0, candidateRows.length - outcomes.length),
    skipped_reasons: {
      thin_data: outcomes.filter((o) => o.skip_reason === "thin_data").length,
      generation_failed: outcomes.filter((o) => o.skip_reason === "generation_failed").length,
      judge_rejected: outcomes.filter((o) => o.skip_reason === "judge_rejected").length,
    },
  });
});

export default router;
