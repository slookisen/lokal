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
  discoverExperiences,
  listCategories,
  createProvider,
  getProviderByOrgnr,
  getProviderByName,
  setBrregVerification,
  experienceExistsForProvider,
  ExperienceSchema,
  DiscoverFilterSchema,
  // orch-experiences-content-refresh — homepage→content writer
  selectProvidersForContentRefresh,
  getProviderContentTarget,
  getExperiencesForProvider,
  applyExperienceContent,
  markProviderEnriched,
  type ContentRefreshTarget,
} from "../services/experience-store";
// PURE homepage extractors + SSRF guard — REUSED from the rfb search-enrich
// module (same code the rfb POST /admin/homepage-content-refresh uses). Only the
// category mapper differs (experiences vocab, not the food vocab).
import {
  isSafeFetchUrl,
  extractVisibleText,
  summarizeAbout,
  meetsAboutQualityBar,
  mapToExperienceCategories,
} from "../services/search-enrich";
import { classifyProvider, sleep, BrregClass } from "../services/experience-brreg";

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
  });
}

// ─── GET /api/opplevelser/discover — intent discovery ───────────────
// «Hva kan vi finne på i Oslo (det regner)»:
//   /api/opplevelser/discover?fylke=Oslo&weather=rain&group_size=4
router.get("/discover", (req: Request, res: Response) => {
  try {
    const filter = parseDiscoverQuery(req);
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || "20", 10) || 20));
    const results = discoverExperiences(filter, limit);
    res.json({
      vertical: "experiences",
      query: filter,
      count: results.length,
      results: results.map((e) => ({
        id: e.id,
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
      for (const r of rows) {
        if (experienceExistsForProvider(providerId, r.title)) {
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
            kommune: r.kommune ?? kommune,
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
  const byField: Record<string, number> = { description: 0, category: 0 };
  const changed: Array<{ provider_id: string; fields: string[] }> = [];
  const skippedLocked: Array<{ provider_id: string; experience_ids: string[] }> = [];
  const errors: Array<{ provider_id: string; error: string }> = [];

  async function processOne(t: ContentRefreshTarget): Promise<void> {
    const providerId = t.id;

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

    // Run the SHARED extractors + the experiences-vocab category mapper.
    const contentText = extractVisibleText(combinedHtml);
    const aboutSummary = summarizeAbout(primaryHtml);
    const expCategories = mapToExperienceCategories(contentText);

    // Build candidate content: about → description (quality-gated), first mapped
    // slug → category. Both are only WRITTEN onto thin/empty fields by the store.
    const candidateDescription = meetsAboutQualityBar(aboutSummary) ? aboutSummary : null;
    const candidateCategory = expCategories.length > 0 ? expCategories[0] : null;

    scanned++;
    if (!candidateDescription && !candidateCategory) return; // nothing extractable

    // Gate per experience through the store (respects locks + thin-only).
    const expRows = getExperiencesForProvider(providerId);
    const writtenFields = new Set<string>();
    const lockedExpIds: string[] = [];
    const toApply: Array<{ id: string }> = [];

    for (const e of expRows) {
      // Reportable lock detection (mirrors the store's gate) so the response can
      // surface skipped_locked even on a dry-run.
      if (e.verification_status === "verified" || e.content_source === "manual" || e.content_source === "claim") {
        // Only count it as "skipped_locked" if it WOULD otherwise have been a
        // write target (has a thin field this run could have filled).
        const descBlank = !e.description || String(e.description).trim() === "";
        const catBlank = !e.category || String(e.category).trim() === "";
        if ((candidateDescription && descBlank) || (candidateCategory && catBlank)) {
          lockedExpIds.push(e.id);
        }
        continue;
      }
      toApply.push({ id: e.id });
    }

    if (lockedExpIds.length > 0) {
      skippedLocked.push({ provider_id: providerId, experience_ids: lockedExpIds });
    }

    if (dryRun) {
      // Report what WOULD be written, write nothing. Recompute thin-only here.
      for (const e of expRows) {
        if (e.verification_status === "verified" || e.content_source === "manual" || e.content_source === "claim") {
          continue;
        }
        const descBlank = !e.description || String(e.description).trim() === "";
        const catBlank = !e.category || String(e.category).trim() === "";
        if (candidateDescription && descBlank) writtenFields.add("description");
        if (candidateCategory && catBlank) writtenFields.add("category");
      }
    } else {
      // Apply through the lock-respecting store writer.
      for (const a of toApply) {
        try {
          const fields = applyExperienceContent(a.id, {
            description: candidateDescription,
            category: candidateCategory,
          });
          for (const f of fields) writtenFields.add(f);
        } catch (e: any) {
          errors.push({ provider_id: providerId, error: `write_failed ${a.id}: ${e?.message ?? String(e)}` });
        }
      }
      if (writtenFields.size > 0) {
        try {
          markProviderEnriched(providerId);
        } catch {
          /* best-effort enrichment stamp */
        }
      }
    }

    if (writtenFields.size > 0) {
      const fieldList = Array.from(writtenFields);
      for (const f of fieldList) if (f in byField) byField[f] += 1;
      changed.push({ provider_id: providerId, fields: fieldList });
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

export default router;
