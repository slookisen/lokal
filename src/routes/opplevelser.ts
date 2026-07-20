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
  markProviderEnriched,
  markProviderContentAttempted,
  // enrichment-metode slice 1 (2026-07-16): dead-homepage parking
  recordProviderHomepageFetchResult,
  // dev-request 2026-07-20-experiences-no-yield-backoff
  recordProviderContentYield,
  type ContentRefreshTarget,
  // dev-request 2026-07-03-gardssalg-rike-profiler-bilder-agentbooking, Fase 1
  // item 3 — multi-page-crawl content enrichment (about/visit/opening-hours)
  selectGardssalgProvidersForContentRefresh,
  getGardssalgProviderContentTarget,
  applyGardssalgProviderContent,
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
  gardssalgSharedDomainReason,
  upsertGardssalgWebsiteReviewQueue,
  clearGardssalgWebsiteReviewQueueEntry,
  listGardssalgWebsiteReviewQueue,
  stampGardssalgWebsiteDiscoveryAttempt,
  applyGardssalgProviderWebsite,
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
  // dev-request 2026-07-20-gardssalg-navstoy-duplikatfelt-heuristikk — nav-
  // pollution/duplicate-field retroactive scan (dry-run) + fixer (apply),
  // backing POST /admin/gardssalg-content-quality-scan below.
  selectGardssalgProvidersForQualityScan,
  evaluateGardssalgContentQuality,
  applyGardssalgContentQualityFixes,
  type GardssalgContentQualityFlag,
} from "../services/experience-store";
// dev-request 2026-07-11-dedup-false-positive-remediation — read-only audit
// of the merged groups the prod backfill produced (titlesMatch()'s single-
// common-token rule merged some genuinely different experiences), consumed by
// the two admin endpoints at the bottom of this file.
import { auditMergedGroups } from "../services/experience-dedup-audit";
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
} from "../services/search-enrich";
import { classifyProvider, sleep, BrregClass } from "../services/experience-brreg";
// dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach, slice 3 —
// Brønnøysundregistrene business-address lookup (same GET /enheter/{orgNr}
// endpoint verifyOrgNumber()/fetchBrregActivityDescription() already call).
import { fetchBrregBusinessAddress, BRREG_BASE_URL, BRREG_SEARCH_PATH } from "../services/brreg-client";
// dev-request 2026-07-19-agg-website-leak — reuse the curated DMO/aggregator
// host classifier (same one admin-knowledge.ts's classifyWebsite() uses) so a
// harvest row's `website` is never blindly trusted as a provider's OWN
// homepage on CREATE. See isAggregatorWebsite()/firstNonAggregatorWebsite()
// below, near the bulk-load handler that consumes them.
import { isDirectoryOrAggregatorHost, hostFromUrlLike } from "../services/cross-source-validator";
// dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach, slice 5b —
// Brreg name-search (candidate generator only, see gardssalgOrgnrAutoWriteEligible);
// verifyOrgNumber (existing, cached) backs the write-bar's liveness veto — an
// exact-name match to a bankrupt/deregistered org must never claim a row.
// scoreNameMatch: NACE-discoveryens navne-dedup mot eksisterende gårdssalg-rader.
import { findOrgnumberByName, verifyOrgNumber, scoreNameMatch } from "../services/brreg-client";
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

const APP_URL = process.env.APP_URL || "https://opplevagent.no";

const router = Router();

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

const BulkRowSchema = z.object({
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
});
const BulkLoadSchema = z.object({
  experiences: z.array(BulkRowSchema).min(1).max(5000),
  apply: z.boolean().optional().default(false),
});
type BulkRow = z.infer<typeof BulkRowSchema>;

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
function isAggregatorWebsite(raw: string): boolean {
  let parsed: URL;
  try {
    // Same scheme-fallback convention as admin-knowledge.ts's parsedHostForUrl.
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    parsed = new URL(withScheme);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!host) return false;
  return isDirectoryOrAggregatorHost(host);
}

// First row's `website` that is truthy AND not a known aggregator/directory
// host, else null. Used for the provider-CREATE `hjemmeside` write only (see
// below) — order-independent: an aggregator-host row earlier in `rows` is
// skipped in favor of a later row with a real domain.
function firstNonAggregatorWebsite(rows: BulkRow[]): string | null {
  return rows.find((r) => r.website && !isAggregatorWebsite(r.website))?.website ?? null;
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
            });
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

/** Fetch one URL's HTML server-side (SSRF-guarded). Returns null on any failure. */
async function crFetchHtml(url: string): Promise<string | null> {
  if (!isSafeFetchUrl(url)) return null;
  const fetchUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const resp = await fetch(fetchUrl, {
      redirect: "follow",
      headers: { "User-Agent": CR_UA, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(CR_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

/**
 * Fetch a provider's homepage + same-host content sub-pages, concatenated. The
 * primary page's HTML is returned first (so summarizeAbout's og/meta lookups hit
 * the homepage), with sub-page HTML appended for the category-token scan. Returns
 * null only if the primary homepage cannot be fetched.
 */
async function crFetchHomepageContent(
  homepageUrl: string
): Promise<{ primaryHtml: string; combinedHtml: string; fetchUrl: string } | null> {
  const fetchUrl = /^https?:\/\//i.test(homepageUrl) ? homepageUrl : `https://${homepageUrl}`;
  const primaryHtml = await crFetchHtml(fetchUrl);
  if (primaryHtml === null) return null;
  let combinedHtml = primaryHtml;
  try {
    const u = new URL(fetchUrl);
    const base = `${u.protocol}//${u.host}`;
    for (const path of CR_CONTENT_PATHS) {
      const sub = await crFetchHtml(`${base}${path}`);
      if (sub) combinedHtml += "\n" + sub;
    }
  } catch {
    /* malformed URL — primary homepage content still stands */
  }
  return { primaryHtml, combinedHtml, fetchUrl };
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
  let targets: ContentRefreshTarget[];
  if (Array.isArray(body.providerIds) && body.providerIds.length > 0) {
    const ids = (body.providerIds as unknown[])
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim())
      .slice(0, limit);
    targets = ids
      .map((id) => getProviderContentTarget(id))
      .filter((t): t is ContentRefreshTarget => t !== null);
  } else {
    targets = selectProvidersForContentRefresh(limit);
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

    // Fetch homepage content server-side (SSRF-guarded).
    let fetched: { primaryHtml: string; combinedHtml: string; fetchUrl: string } | null;
    try {
      fetched = await crFetchHomepageContent(t.hjemmeside);
    } catch (e: any) {
      errors.push({ provider_id: providerId, error: e?.message ?? String(e) });
      // Dead-homepage parking (enrichment-metode slice 1): count the failure;
      // 3 strikes park the provider 30d (apply mode only — dry-run never writes).
      if (apply) {
        try {
          const p = recordProviderHomepageFetchResult(providerId, false);
          if (p.parked_now) parkedNow.push(providerId);
        } catch { /* best-effort */ }
      }
      return;
    }
    if (!fetched) {
      errors.push({ provider_id: providerId, error: `fetch_failed for ${t.hjemmeside}` });
      if (apply) {
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
          const fields = applyExperienceContent(a.id, candidateObj);
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
async function crFetchGardssalgContent(
  homepageUrl: string
): Promise<{ primaryHtml: string; combinedHtml: string; fetchUrl: string } | null> {
  const fetchUrl = /^https?:\/\//i.test(homepageUrl) ? homepageUrl : `https://${homepageUrl}`;
  const primaryHtml = await crFetchHtml(fetchUrl);
  if (primaryHtml === null) return null;
  let combinedHtml = primaryHtml;
  let pagesFetched = 1;
  try {
    const u = new URL(fetchUrl);
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
  return { primaryHtml, combinedHtml, fetchUrl };
}

const GS_CR_DEFAULT_LIMIT = 25;
const GS_CR_HARD_CAP = 48; // there are only 48 gårdssalg providers total

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

    // Fetch homepage + gårdssalg sub-pages server-side (SSRF-guarded).
    let fetched: { primaryHtml: string; combinedHtml: string; fetchUrl: string } | null;
    try {
      fetched = await crFetchGardssalgContent(t.hjemmeside);
    } catch (e: any) {
      errors.push({ provider_id: providerId, error: e?.message ?? String(e) });
      // Dead-homepage parking (enrichment-metode slice 1): count the failure;
      // 3 strikes park the provider 30d (apply mode only — dry-run never writes).
      if (apply) {
        try {
          const p = recordProviderHomepageFetchResult(providerId, false);
          if (p.parked_now) parkedNow.push(providerId);
        } catch { /* best-effort */ }
      }
      return;
    }
    if (!fetched) {
      errors.push({ provider_id: providerId, error: `fetch_failed for ${t.hjemmeside}` });
      if (apply) {
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

    const candidateAbout = meetsAboutQualityBar(aboutSummary) ? aboutSummary : null;
    const candidateVisit = meetsAboutQualityBar(visitSummary) ? visitSummary : null;
    const candidateHours = hoursSnippet && hoursSnippet.trim() ? hoursSnippet : null;

    const provenance: GsProvenanceMap = {};
    if (candidateAbout) provenance.about_text = { source_url: fetched.fetchUrl, snippet: candidateAbout.slice(0, 120) };
    if (candidateVisit) provenance.visit_text = { source_url: fetched.fetchUrl, snippet: candidateVisit.slice(0, 120) };
    if (candidateHours) provenance.opening_hours_text = { source_url: fetched.fetchUrl, snippet: candidateHours };

    function isBlank(v: unknown): boolean {
      return v === null || v === undefined || String(v).trim() === "";
    }

    // THIN/BLANK-FIELD check against the target's own snapshot (taken at
    // selection time, before any write in this run) — used both to gate
    // whether there's anything to do at all AND for the dry-run projection.
    // about_text/visit_text go through gardssalgReplaceableFieldAction (the
    // SAME fill-blank-OR-replace-thin decision applyGardssalgProviderContent
    // makes) so the preview can never drift from the real write path.
    // opening_hours_text stays on the old fill-only-blank check (unchanged).
    const wouldWriteActions: Record<string, GsFieldAction> = {};
    const aboutAction = gardssalgReplaceableFieldAction(t.about_text, candidateAbout);
    if (aboutAction) wouldWriteActions.about_text = aboutAction;
    const visitAction = gardssalgReplaceableFieldAction(t.visit_text, candidateVisit);
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
    let rewriteAbout: string | null = null;
    let rewriteVisit: string | null = null;
    if (!wouldWriteActions.about_text && gardssalgRewriteEligible(t.about_text)) {
      rewriteAbout = await generateGardssalgAboutRewrite(contentText, t.about_text as string, "about");
      if (rewriteAbout) {
        wouldWriteActions.about_text = "rewritten";
        provenance.about_text = { source_url: fetched.fetchUrl, snippet: rewriteAbout.slice(0, 120) };
      }
    }
    if (!wouldWriteActions.visit_text && gardssalgRewriteEligible(t.visit_text)) {
      rewriteVisit = await generateGardssalgAboutRewrite(contentText, t.visit_text as string, "visit");
      if (rewriteVisit) {
        wouldWriteActions.visit_text = "rewritten";
        provenance.visit_text = { source_url: fetched.fetchUrl, snippet: rewriteVisit.slice(0, 120) };
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
        const written = applyGardssalgProviderContent(
          providerId,
          {
            about_text: rewriteAbout ?? candidateAbout ?? undefined,
            visit_text: rewriteVisit ?? candidateVisit ?? undefined,
            opening_hours_text: candidateHours ?? undefined,
            products: productsCandidate ?? undefined,
          },
          fetched.fetchUrl,
          undefined,
          rewriteFields.length > 0 ? rewriteFields : undefined
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
              try {
                upsertGardssalgOrgnrReviewQueue({
                  provider_id: nameMatch.id,
                  provider_name: nameMatch.navn,
                  candidate_orgnr: orgnr,
                  candidate_name: e.navn,
                  candidate_confidence: 1.0,
                  candidate_address: candidateAddress,
                  reason: "nace_discovery_name_match",
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
// source-based, so without a website a row can never be filled. Per target:
// deterministic candidate hosts from the provider's own name
// (gardssalgWebsiteCandidateHosts), pre-fetch identity checks (curated
// directory/aggregator + visit*-DMO hosts rejected; hosts ALREADY carried by
// any catalog row rejected — adopting one would create the shared-host
// situation the 5d guard quarantines), fetch (SSRF-guarded, redirects
// followed and the FINAL host re-checked), then ownership evidence on the
// page text: the provider's org_nr, or exact pruned name + kommune/poststed
// (gardssalgWebsiteEvidenceMatch). First verified candidate wins.
//
// Verified candidates are parked in gardssalg_website_review_queue — NEVER
// written to the row by this route. Adoption goes through the approve lever
// below. Dry-run by default: dry-run fetches (read-only) but writes NOTHING
// (no queue rows, no attempt stamps). Apply mode stamps
// website_discovery_attempted_at on every processed target (anti-starvation)
// and upserts the queue. Selection includes catalog_hidden rows by design —
// the komplett-foer-synlig plan runs this on hidden batches.
const GS_WD_DEFAULT_LIMIT = 16;
const GS_WD_HARD_CAP = 48;

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
  let targets: Array<{ id: string; navn: string; org_nr: string | null; kommune: string | null; poststed: string | null; content_source: string | null }> = [];

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

  for (const t of targets) {
    processedIds.push(t.id);
    const candidates = gardssalgWebsiteCandidateHosts(t.navn);
    const tried: string[] = [];
    const excludedHere: Array<{ host: string; reason: string }> = [];
    let hit: { host: string; finalUrl: string; evidence: ReturnType<typeof gardssalgWebsiteEvidenceMatch> } | null = null;

    for (const host of candidates) {
      const listed = gardssalgSharedDomainReason(host);
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
        const listedFinal = gardssalgSharedDomainReason(finalHost);
        if (listedFinal) {
          excludedHere.push({ host: finalHost, reason: listedFinal });
          continue;
        }
        if ((hostCounts.get(finalHost) || 0) >= 1) {
          excludedHere.push({ host: finalHost, reason: "host_already_in_catalog" });
          continue;
        }
      }
      const ev = gardssalgWebsiteEvidenceMatch(gardssalgPageText(page.html), {
        orgNr: t.org_nr,
        navn: t.navn,
        kommune: t.kommune,
        poststed: t.poststed,
      });
      if (ev.verified) {
        hit = { host, finalUrl: page.finalUrl, evidence: ev };
        break;
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
      const confidence = hit.evidence.org_nr_found ? 1.0 : 0.9;
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
router.post("/admin/gardssalg-content-rollback", requireAdmin, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    provider_id?: unknown;
    field_name?: unknown;
    batch_id?: unknown;
    apply?: unknown;
  };

  const providerId =
    typeof body.provider_id === "string" && body.provider_id.trim() ? body.provider_id.trim() : undefined;
  const fieldName =
    typeof body.field_name === "string" && body.field_name.trim() ? body.field_name.trim() : undefined;
  const batchId =
    typeof body.batch_id === "string" && body.batch_id.trim() ? body.batch_id.trim() : undefined;
  const apply =
    body.apply === true || body.apply === 1 || body.apply === "1" || body.apply === "true";

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

// ─── POST /api/opplevelser/admin/gardssalg-content-quality-scan (admin) ─────
//
// dev-request 2026-07-20-gardssalg-navstoy-duplikatfelt-heuristikk, spec item
// 4 — retroactive bulk scan for the two Draopar-class defects (nav-menu
// vocabulary glued into about_text/visit_text, and about_text===visit_text
// duplication) across ALL gårdssalg providers, visible AND catalog_hidden=1
// (see selectGardssalgProvidersForQualityScan's doc comment for why hidden
// rows are included). Dry-run by default (same convention as every other
// admin route in this file); apply=1 nulls the flagged fields via the SAME
// gardssalg_content_audit + field_provenance path every other gårdssalg
// writer uses (so POST /admin/gardssalg-content-rollback can undo a scan-fix
// batch too) and resets last_content_attempt_at so the row is first in line
// for the next content-refresh pass. NEVER writes new content itself —
// purely a "clear the contamination, re-queue for a clean refill" lever.
//
// Body: { providerIds?: string[], apply? }. providerIds optionally scopes
// the scan to a subset (mirrors the content-refresh/address-enrichment
// routes' override convention); omitted/empty scans the full catalog.
// Response: { dry_run, scanned, flagged, flags, applied?, skipped? }.
// Auth: same X-Admin-Key convention (requireAdmin) as the rest of this file.
router.post("/admin/gardssalg-content-quality-scan", requireAdmin, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { providerIds?: unknown; apply?: unknown };
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  try {
    let rows = selectGardssalgProvidersForQualityScan();
    if (Array.isArray(body.providerIds) && body.providerIds.length > 0) {
      const ids = new Set(
        (body.providerIds as unknown[]).filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      );
      rows = rows.filter((r) => ids.has(r.id));
    }

    const flags: GardssalgContentQualityFlag[] = evaluateGardssalgContentQuality(rows);

    if (dryRun) {
      res.json({ dry_run: true, scanned: rows.length, flagged: flags.length, flags });
      return;
    }

    const batchTag = `quality-scan-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
    const { applied, skipped } = applyGardssalgContentQualityFixes(flags, batchTag);
    res.json({
      dry_run: false,
      scanned: rows.length,
      flagged: flags.length,
      flags,
      batch_id: batchTag,
      applied,
      skipped,
    });
  } catch (err: any) {
    console.error("[opplevelser] gardssalg-content-quality-scan failed", err);
    res.status(500).json({ error: "Internal error" });
  }
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
const TEST_PROVIDER_ORG_NR = "TEST000000";
const TEST_PROVIDER_DEFAULT_NAME = "TEST — Ikke book (booking-flyt-v1 slice 0)";
const TEST_PROVIDER_DEFAULT_SLUG = "test-ikke-book-slice0";
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

  const expDb = getExpDb("experiences");

  try {
    // Converge on ONE row: match an existing test row by slug OR the fixed test
    // org_nr (the stable identity across repeat calls, even if the slug changes).
    const existing = expDb
      .prepare("SELECT id FROM experience_providers WHERE slug = ? OR org_nr = ? LIMIT 1")
      .get(slug, TEST_PROVIDER_ORG_NR) as { id: string } | undefined;

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

    console.log(
      `[test-provider] upserted hidden test provider id=${providerId} slug=${slug} epost=${email} (catalog_hidden=1, booking_live=1)`
    );

    res.json({
      success: true,
      provider_id: providerId,
      slug,
      booking_url: `${APP_URL}/kategori/gardssalg/book/${slug}`,
      epost: email,
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
//   products, content_source, content_evidence_url, field_provenance: null,
//   provenance_model: "none" }] }
router.get("/admin/providers/recently-enriched", requireAdmin, (req: Request, res: Response) => {
  try {
    const expDb = getExpDb("experiences");

    const DEFAULT_SINCE_DAYS = 7;
    let since = new Date(Date.now() - DEFAULT_SINCE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const sinceParam = req.query.since;
    if (typeof sinceParam === "string" && sinceParam.trim()) {
      const parsed = new Date(sinceParam);
      if (!isNaN(parsed.getTime())) {
        since = parsed.toISOString();
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

    const providers = rows.map((r) => {
      let products: unknown[] = [];
      if (r.products) {
        try {
          const parsed = JSON.parse(r.products);
          if (Array.isArray(parsed)) products = parsed;
        } catch { /* malformed → empty */ }
      }
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
  const id = req.params.id;
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
    const expDb = getExpDb("experiences");
    const existing = expDb
      .prepare(`SELECT id, hjemmeside FROM experience_providers WHERE id = ?`)
      .get(id) as { id: string; hjemmeside: string | null } | undefined;

    if (!existing) {
      res.status(404).json({ error: "Provider not found", id });
      return;
    }

    expDb
      .prepare(
        `UPDATE experience_providers
            SET hjemmeside = ?, updated_at = datetime('now')
          WHERE id = ?`
      )
      .run(normalized, id);

    res.json({
      success: true,
      id,
      previous_hjemmeside: existing.hjemmeside,
      new_hjemmeside: normalized,
    });
  } catch (err) {
    console.error("[opplevelser] admin/providers/:id/hjemmeside PATCH failed", err);
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
        model: "claude-opus-4-8",
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
        model: "claude-opus-4-8",
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
async function generateTitleNo(candidate: TitleNoCandidate): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const place = [candidate.kommune, candidate.fylke].filter(Boolean).join(", ");
  const prompt = `Gi en naturlig norsk visningstittel for denne opplevelsen (kort, ingen anførselstegn, ingen annen tekst).

Tittel: ${candidate.title}
Kategori: ${candidate.category || "ukjent"}
Sted: ${place || "ukjent"}`;

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
        model: "claude-opus-4-8",
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
      const proposed = await generateTitleNo(row);
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
    generated.push({ id: row.id, title_no: await generateTitleNo(row) });
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

export default router;
