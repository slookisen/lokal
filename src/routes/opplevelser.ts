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
  type ContentRefreshTarget,
  // dev-request 2026-07-03-gardssalg-rike-profiler-bilder-agentbooking, Fase 1
  // item 3 — multi-page-crawl content enrichment (about/visit/opening-hours)
  selectGardssalgProvidersForContentRefresh,
  getGardssalgProviderContentTarget,
  applyGardssalgProviderContent,
  type GardssalgContentRefreshTarget,
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
import {
  createBooking,
  getBookingByRef,
  getBookingByToken,
  resolveBooking,
  getCommissionStatement,
  BookingInputSchema,
  buildIcs,
  sendBookingConfirmation,
  // dev-request 2026-07-12-gardssalg-dark-launch-stop, slice 0
  isBookingPaused,
  sendProducerNotification,
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
          hjemmeside: rows.find((r) => r.website)?.website ?? null,
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
      return;
    }
    if (!fetched) {
      errors.push({ provider_id: providerId, error: `fetch_failed for ${t.hjemmeside}` });
      return;
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
    if (!hasAnyCandidate) return;

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
    by_field: byField,
    changed,
    skipped_locked: skippedLocked,
    errors,
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
    const base = `${u.protocol}//${u.host}`;
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
  const byField: Record<string, number> = { about_text: 0, visit_text: 0, opening_hours_text: 0 };
  type GsProvenanceMap = Record<string, { source_url: string; snippet: string | null }>;
  const changed: Array<{ provider_id: string; fields: string[]; provenance: GsProvenanceMap }> = [];
  const skippedLocked: string[] = [];
  const errors: Array<{ provider_id: string; error: string }> = [];

  async function processOne(t: GardssalgContentRefreshTarget): Promise<void> {
    const providerId = t.id;

    // Stamp the attempt UNCONDITIONALLY (apply mode only) before doing any
    // fetch/extraction work — same "cycle to the back of the queue on any
    // outcome" reasoning as the experiences-table route above (see
    // markProviderContentAttempted's doc comment).
    if (apply) {
      try { markProviderContentAttempted(providerId); } catch { /* best-effort */ }
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
      return;
    }
    if (!fetched) {
      errors.push({ provider_id: providerId, error: `fetch_failed for ${t.hjemmeside}` });
      return;
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

    // THIN-FIELD check against the target's own snapshot (taken at selection
    // time, before any write in this run) — used for the dry-run projection.
    const wouldWrite: string[] = [];
    if (candidateAbout && isBlank(t.about_text)) wouldWrite.push("about_text");
    if (candidateVisit && isBlank(t.visit_text)) wouldWrite.push("visit_text");
    if (candidateHours && isBlank(t.opening_hours_text)) wouldWrite.push("opening_hours_text");

    if (wouldWrite.length === 0) return;

    if (dryRun) {
      for (const f of wouldWrite) if (f in byField) byField[f] += 1;
      changed.push({ provider_id: providerId, fields: wouldWrite, provenance });
    } else {
      try {
        const written = applyGardssalgProviderContent(
          providerId,
          {
            about_text: candidateAbout ?? undefined,
            visit_text: candidateVisit ?? undefined,
            opening_hours_text: candidateHours ?? undefined,
          },
          fetched.fetchUrl
        );
        if (written.length > 0) {
          for (const f of written) if (f in byField) byField[f] += 1;
          changed.push({ provider_id: providerId, fields: written, provenance });
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
    by_field: byField,
    changed,
    skipped_locked: skippedLocked,
    errors,
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
// GET  /api/opplevelser/book/confirm/:token — producer confirm (attended/no_show)
// GET  /api/opplevelser/book/:ref/ics     — download ICS calendar file
// GET  /api/opplevelser/admin/gardssalg/commission — monthly commission statement
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
    | { booking_live?: number | null; epost?: string | null }
    | null;
  if (isBookingPaused(providerBook?.booking_live ?? null)) {
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

  const confirmUrl = `${APP_URL}/api/opplevelser/book/confirm/${booking.confirm_token}`;

  res.status(201).json({
    success: true,
    booking_ref: booking.booking_ref,
    status: booking.status,
    source: booking.source,
    confirm_url: confirmUrl,
    message: `Påmelding registrert! Bekreftelse sendes til ${booking.guest_email}.`,
  });
});

// ─── GET /api/opplevelser/book/confirm/:token ────────────────────────
// Producer-facing: resolve a booking as attended or no_show.
// Accepts ?action=attended (default) or ?action=no_show
// Returns JSON; a producer portal page can wrap this with a simple form.
router.get(
  "/book/confirm/:token",
  (req: Request, res: Response) => {
    const { token } = req.params;
    const action = (req.query.action as string) === "no_show" ? "no_show" : "confirmed_attended";

    const existing = getBookingByToken(token as string);
    if (!existing) {
      res.status(404).json({ error: "Booking ikke funnet" });
      return;
    }
    if (existing.status !== "reserved") {
      res.json({
        success: true,
        booking_ref: existing.booking_ref,
        status: existing.status,
        message: `Allerede registrert: ${existing.status}`,
      });
      return;
    }

    const resolved = resolveBooking(token as string, action, req.ip || "producer");
    if (!resolved) {
      res.status(409).json({ error: "Kunne ikke oppdatere booking" });
      return;
    }

    res.json({
      success: true,
      booking_ref: resolved.booking_ref,
      status: resolved.status,
      billable: resolved.billable === 1,
      message:
        resolved.status === "confirmed_attended"
          ? `Oppmøte bekreftet — ref ${resolved.booking_ref} regnes med i provisjon.`
          : `Ikke-oppmøte registrert — ref ${resolved.booking_ref} ekskludert fra provisjon.`,
    });
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
