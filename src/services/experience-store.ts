// ─── Experience Store — Phase 7 (Skjer) ─────────────────────────────
//
// CRUD + discovery for the experiences marketplace. ALL queries hit
// /data/experiences.db via getDb('experiences') — NEVER references the
// rfb `agents` table or the dental DB.
//
// Mirrors the conventions of src/services/dental-store.ts:
//   - better-sqlite3 prepared statements
//   - uuid for primary keys
//   - Zod for input validation
//   - JSON-array fields stored as TEXT
//
// HARVEST-FIRST: experiences are created first (from curated sources),
// provider_id is attached later by the Brreg-matcher. discoverExperiences()
// only surfaces rows that are verified + provider brreg_active + confidence>=medium.

import { v4 as uuid } from "uuid";
import { z } from "zod";
import { getDb } from "../database/db-factory";

const VERTICAL = "experiences";

// ─── Enums / shared ─────────────────────────────────────────────────
const VerificationStatusSchema = z.enum([
  "pending_verify",
  "verified",
  "needs_review",
  "rejected",
]);
const IndoorOutdoorSchema = z.enum(["indoor", "outdoor", "both"]);
const ConfidenceSchema = z.enum(["high", "medium", "low"]);

// ─── Provider schema ────────────────────────────────────────────────
export const ProviderSchema = z.object({
  id: z.string().optional(),
  org_nr: z.string().optional().nullable(),
  navn: z.string().min(1),
  postnummer: z.string().optional().nullable(),
  poststed: z.string().optional().nullable(),
  fylke: z.string().optional().nullable(),
  kommune: z.string().optional().nullable(),
  kommunenummer: z.string().optional().nullable(),
  adresse: z.string().optional().nullable(),
  lat: z.number().optional().nullable(),
  lon: z.number().optional().nullable(),
  telefon: z.string().optional().nullable(),
  mobil: z.string().optional().nullable(),
  epost: z.string().email().optional().nullable(),
  hjemmeside: z.string().optional().nullable(),
  antall_ansatte: z.number().int().nonnegative().optional().nullable(),
  organisasjonsform: z.string().optional().nullable(),
  registreringsdato: z.string().optional().nullable(),
  naeringskode: z.string().optional().nullable(),
  provider_type: z.string().optional().nullable(),
  brreg_verified: z.union([z.literal(0), z.literal(1)]).optional(),
  brreg_active: z.union([z.literal(0), z.literal(1)]).optional().nullable(),
  is_umbrella_member: z.union([z.literal(0), z.literal(1)]).optional(),
  source: z.string().optional().nullable(),
  confidence: ConfidenceSchema.optional().nullable(),
  enrichment_state: z.string().optional(),
  verification_status: VerificationStatusSchema.optional(),
});
export type Provider = z.infer<typeof ProviderSchema>;

// ─── Experience schema ──────────────────────────────────────────────
export const ExperienceSchema = z.object({
  id: z.string().optional(),
  provider_id: z.string().optional().nullable(),
  provider_match_status: z.enum(["unmatched", "matched", "ambiguous"]).optional(),
  title: z.string().min(1),
  slug: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  subcategory: z.string().optional().nullable(),
  activity_tags: z.array(z.string()).optional(),
  season: z.array(z.string()).optional(),
  indoor_outdoor: IndoorOutdoorSchema.optional().nullable(),
  weather_dependent: z.union([z.literal(0), z.literal(1)]).optional().nullable(),
  physical_intensity: z.enum(["low", "medium", "high"]).optional().nullable(),
  duration_min: z.number().int().optional().nullable(),
  duration_max: z.number().int().optional().nullable(),
  group_min: z.number().int().optional().nullable(),
  group_max: z.number().int().optional().nullable(),
  age_suitability: z.enum(["all", "family", "adults", "kids"]).optional().nullable(),
  min_age: z.number().int().optional().nullable(),
  price_band: z.string().optional().nullable(),
  price_from: z.number().int().optional().nullable(),
  price_unit: z.string().optional().nullable(),
  languages: z.array(z.string()).optional(),
  accessibility: z.array(z.string()).optional(),
  booking_url: z.string().optional().nullable(),
  booking_type: z.enum(["instant", "request", "external", "none"]).optional().nullable(),
  loc_lat: z.number().optional().nullable(),
  loc_lon: z.number().optional().nullable(),
  meeting_point: z.string().optional().nullable(),
  kommune: z.string().optional().nullable(),
  fylke: z.string().optional().nullable(),
  discovery_source: z.string().optional().nullable(),
  content_source: z.string().optional().nullable(),
  evidence_url: z.string().optional().nullable(),
  confidence: ConfidenceSchema.optional().nullable(),
  enrichment_state: z.string().optional(),
  verification_status: VerificationStatusSchema.optional(),
  seasonal_valid_from: z.string().optional().nullable(),
  seasonal_valid_to: z.string().optional().nullable(),
});
export type Experience = z.infer<typeof ExperienceSchema>;

// ─── Discovery filter ───────────────────────────────────────────────
export const DiscoverFilterSchema = z.object({
  fylke: z.string().optional(),
  kommune: z.string().optional(),
  category: z.string().optional(),
  indoor_outdoor: IndoorOutdoorSchema.optional(),
  weather: z.enum(["rain", "snow", "clear", "any"]).optional(),
  season: z.string().optional(),               // 'summer' | 'winter' | ...
  group_size: z.number().int().positive().optional(),
  age: z.number().int().nonnegative().optional(),
  max_price: z.number().int().positive().optional(),
  duration_max: z.number().int().positive().optional(),
  language: z.string().optional(),
});
export type DiscoverFilter = z.infer<typeof DiscoverFilterSchema>;

// ─── Helpers ────────────────────────────────────────────────────────
function jsonOrNull(arr: string[] | undefined): string | null {
  if (!arr || arr.length === 0) return null;
  return JSON.stringify(arr);
}
function parseJsonArray(value: unknown): string[] {
  if (!value || typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

function hydrateExperience(row: Record<string, unknown>): Experience & { id: string } {
  return {
    id: row.id as string,
    provider_id: (row.provider_id as string | null) ?? null,
    provider_match_status: (row.provider_match_status as Experience["provider_match_status"]) ?? "unmatched",
    title: row.title as string,
    slug: (row.slug as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    category: (row.category as string | null) ?? null,
    subcategory: (row.subcategory as string | null) ?? null,
    activity_tags: parseJsonArray(row.activity_tags),
    season: parseJsonArray(row.season),
    indoor_outdoor: (row.indoor_outdoor as Experience["indoor_outdoor"]) ?? null,
    weather_dependent: (row.weather_dependent as 0 | 1 | null) ?? null,
    physical_intensity: (row.physical_intensity as Experience["physical_intensity"]) ?? null,
    duration_min: (row.duration_min as number | null) ?? null,
    duration_max: (row.duration_max as number | null) ?? null,
    group_min: (row.group_min as number | null) ?? null,
    group_max: (row.group_max as number | null) ?? null,
    age_suitability: (row.age_suitability as Experience["age_suitability"]) ?? null,
    min_age: (row.min_age as number | null) ?? null,
    price_band: (row.price_band as string | null) ?? null,
    price_from: (row.price_from as number | null) ?? null,
    price_unit: (row.price_unit as string | null) ?? null,
    languages: parseJsonArray(row.languages),
    accessibility: parseJsonArray(row.accessibility),
    booking_url: (row.booking_url as string | null) ?? null,
    booking_type: (row.booking_type as Experience["booking_type"]) ?? null,
    loc_lat: (row.loc_lat as number | null) ?? null,
    loc_lon: (row.loc_lon as number | null) ?? null,
    meeting_point: (row.meeting_point as string | null) ?? null,
    kommune: (row.kommune as string | null) ?? null,
    fylke: (row.fylke as string | null) ?? null,
    discovery_source: (row.discovery_source as string | null) ?? null,
    content_source: (row.content_source as string | null) ?? null,
    evidence_url: (row.evidence_url as string | null) ?? null,
    confidence: (row.confidence as Experience["confidence"]) ?? null,
    enrichment_state: (row.enrichment_state as string) ?? "raw",
    verification_status: (row.verification_status as Experience["verification_status"]) ?? "pending_verify",
    seasonal_valid_from: (row.seasonal_valid_from as string | null) ?? null,
    seasonal_valid_to: (row.seasonal_valid_to as string | null) ?? null,
  };
}

// ─── Providers ──────────────────────────────────────────────────────
export function createProvider(input: Provider): string {
  const p = ProviderSchema.parse(input);
  const id = p.id ?? uuid();
  const db = getDb(VERTICAL);
  db.prepare(`
    INSERT INTO experience_providers (
      id, org_nr, navn, postnummer, poststed, fylke, kommune, kommunenummer,
      adresse, lat, lon, telefon, mobil, epost, hjemmeside,
      antall_ansatte, organisasjonsform, registreringsdato, naeringskode, provider_type,
      brreg_verified, brreg_active, is_umbrella_member, source, confidence,
      enrichment_state, verification_status
    ) VALUES (
      @id, @org_nr, @navn, @postnummer, @poststed, @fylke, @kommune, @kommunenummer,
      @adresse, @lat, @lon, @telefon, @mobil, @epost, @hjemmeside,
      @antall_ansatte, @organisasjonsform, @registreringsdato, @naeringskode, @provider_type,
      @brreg_verified, @brreg_active, @is_umbrella_member, @source, @confidence,
      @enrichment_state, @verification_status
    )
  `).run({
    id, org_nr: p.org_nr ?? null, navn: p.navn,
    postnummer: p.postnummer ?? null, poststed: p.poststed ?? null, fylke: p.fylke ?? null,
    kommune: p.kommune ?? null, kommunenummer: p.kommunenummer ?? null, adresse: p.adresse ?? null,
    lat: p.lat ?? null, lon: p.lon ?? null, telefon: p.telefon ?? null, mobil: p.mobil ?? null,
    epost: p.epost ?? null, hjemmeside: p.hjemmeside ?? null,
    antall_ansatte: p.antall_ansatte ?? null, organisasjonsform: p.organisasjonsform ?? null,
    registreringsdato: p.registreringsdato ?? null, naeringskode: p.naeringskode ?? null,
    provider_type: p.provider_type ?? null,
    brreg_verified: p.brreg_verified ?? 0, brreg_active: p.brreg_active ?? null,
    is_umbrella_member: p.is_umbrella_member ?? 0, source: p.source ?? null,
    confidence: p.confidence ?? null, enrichment_state: p.enrichment_state ?? "raw",
    verification_status: p.verification_status ?? "pending_verify",
  });
  return id;
}

export function getProviderByOrgnr(orgnr: string): Record<string, unknown> | null {
  const db = getDb(VERTICAL);
  return (db.prepare("SELECT * FROM experience_providers WHERE org_nr = ?").get(orgnr) as Record<string, unknown>) ?? null;
}

/** Stamp Brreg verification result onto a provider (verifier role). */
export function setBrregVerification(providerId: string, active: 0 | 1, orgnr?: string): boolean {
  const db = getDb(VERTICAL);
  const res = db.prepare(`
    UPDATE experience_providers
    SET brreg_verified = 1, brreg_active = @active, org_nr = COALESCE(@orgnr, org_nr),
        brreg_checked_at = datetime('now'), updated_at = datetime('now')
    WHERE id = @id
  `).run({ id: providerId, active, orgnr: orgnr ?? null });
  return res.changes > 0;
}

// ─── Experiences ────────────────────────────────────────────────────
export function createExperience(input: Experience): string {
  const e = ExperienceSchema.parse(input);
  const id = e.id ?? uuid();
  const slug = e.slug ?? `${slugify(e.title)}--${(e.provider_id ?? id).slice(0, 8)}`;
  const db = getDb(VERTICAL);
  db.prepare(`
    INSERT INTO experiences (
      id, provider_id, provider_match_status, title, slug, description,
      category, subcategory, activity_tags, season, indoor_outdoor, weather_dependent,
      physical_intensity, duration_min, duration_max, group_min, group_max,
      age_suitability, min_age, price_band, price_from, price_unit,
      languages, accessibility, booking_url, booking_type,
      loc_lat, loc_lon, meeting_point, kommune, fylke,
      discovery_source, content_source, evidence_url, confidence,
      enrichment_state, verification_status, seasonal_valid_from, seasonal_valid_to
    ) VALUES (
      @id, @provider_id, @provider_match_status, @title, @slug, @description,
      @category, @subcategory, @activity_tags, @season, @indoor_outdoor, @weather_dependent,
      @physical_intensity, @duration_min, @duration_max, @group_min, @group_max,
      @age_suitability, @min_age, @price_band, @price_from, @price_unit,
      @languages, @accessibility, @booking_url, @booking_type,
      @loc_lat, @loc_lon, @meeting_point, @kommune, @fylke,
      @discovery_source, @content_source, @evidence_url, @confidence,
      @enrichment_state, @verification_status, @seasonal_valid_from, @seasonal_valid_to
    )
  `).run({
    id, provider_id: e.provider_id ?? null,
    provider_match_status: e.provider_match_status ?? "unmatched",
    title: e.title, slug, description: e.description ?? null,
    category: e.category ?? null, subcategory: e.subcategory ?? null,
    activity_tags: jsonOrNull(e.activity_tags), season: jsonOrNull(e.season),
    indoor_outdoor: e.indoor_outdoor ?? null, weather_dependent: e.weather_dependent ?? null,
    physical_intensity: e.physical_intensity ?? null,
    duration_min: e.duration_min ?? null, duration_max: e.duration_max ?? null,
    group_min: e.group_min ?? null, group_max: e.group_max ?? null,
    age_suitability: e.age_suitability ?? null, min_age: e.min_age ?? null,
    price_band: e.price_band ?? null, price_from: e.price_from ?? null, price_unit: e.price_unit ?? null,
    languages: jsonOrNull(e.languages), accessibility: jsonOrNull(e.accessibility),
    booking_url: e.booking_url ?? null, booking_type: e.booking_type ?? null,
    loc_lat: e.loc_lat ?? null, loc_lon: e.loc_lon ?? null, meeting_point: e.meeting_point ?? null,
    kommune: e.kommune ?? null, fylke: e.fylke ?? null,
    discovery_source: e.discovery_source ?? null, content_source: e.content_source ?? null,
    evidence_url: e.evidence_url ?? null, confidence: e.confidence ?? null,
    enrichment_state: e.enrichment_state ?? "raw",
    verification_status: e.verification_status ?? "pending_verify",
    seasonal_valid_from: e.seasonal_valid_from ?? null, seasonal_valid_to: e.seasonal_valid_to ?? null,
  });
  return id;
}

export function getExperienceById(id: string): (Experience & { id: string }) | null {
  const db = getDb(VERTICAL);
  const row = db.prepare("SELECT * FROM experiences WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? hydrateExperience(row) : null;
}
// ─── Site-quality: server-rendered detail-page reads (opplevagent.no) ──────
// Added by the opplevagent-site-quality loop (work-order 2026-06-20,
// increment #2: /opplevelse/<slug>). These mirror the discoverExperiences()
// publish-gate (verified + confidence>=medium + provider brreg_active) so the
// set of live HTML detail pages == the set surfaced by /discover (100% weave,
// zero orphan/dead pages). Read-only; no schema change.
const PUBLISH_GATE_SQL =
  "e.verification_status = 'verified' " +
  "AND (e.confidence IS NULL OR e.confidence IN ('high','medium')) " +
  "AND (p.id IS NULL OR p.brreg_active = 1)";

export function getPublishedExperienceBySlug(
  slug: string
): (Experience & { id: string }) | null {
  if (!slug) return null;
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT e.* FROM experiences e
       LEFT JOIN experience_providers p ON p.id = e.provider_id
       WHERE e.slug = @slug AND ${PUBLISH_GATE_SQL}`
    )
    .get({ slug }) as Record<string, unknown> | undefined;
  return row ? hydrateExperience(row) : null;
}

export function getProviderById(id: string): Record<string, unknown> | null {
  if (!id) return null;
  const db = getDb(VERTICAL);
  return (
    (db
      .prepare("SELECT * FROM experience_providers WHERE id = ?")
      .get(id) as Record<string, unknown>) ?? null
  );
}

export type PublishedSlugRow = { slug: string; updated_at: string | null };
export function listPublishedExperienceSlugs(): PublishedSlugRow[] {
  const db = getDb(VERTICAL);
  return db
    .prepare(
      `SELECT e.slug AS slug, e.updated_at AS updated_at
       FROM experiences e
       LEFT JOIN experience_providers p ON p.id = e.provider_id
       WHERE e.slug IS NOT NULL AND ${PUBLISH_GATE_SQL}
       ORDER BY e.updated_at DESC, e.title ASC`
    )
    .all() as PublishedSlugRow[];
}

export type RelatedExperienceRow = {
  slug: string;
  title: string;
  category: string | null;
  fylke: string | null;
  kommune: string | null;
};
export function getRelatedPublishedExperiences(
  category: string | null,
  excludeId: string,
  limit = 6
): RelatedExperienceRow[] {
  if (!category) return [];
  const db = getDb(VERTICAL);
  return db
    .prepare(
      `SELECT e.slug AS slug, e.title AS title, e.category AS category,
              e.fylke AS fylke, e.kommune AS kommune
       FROM experiences e
       LEFT JOIN experience_providers p ON p.id = e.provider_id
       WHERE e.category = @category AND e.id != @excludeId
         AND e.slug IS NOT NULL AND ${PUBLISH_GATE_SQL}
       ORDER BY CASE e.confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, e.title ASC
       LIMIT @limit`
    )
    .all({
      category,
      excludeId,
      limit: Math.max(1, Math.min(24, limit)),
    }) as RelatedExperienceRow[];
}

// ─── Phase 2: human-browse listing reads (opplevagent.no) ───────────────────
// The browse subpages (/opplevelser, /kategori/:c, /fylke/:f, /tilbyder/:id,
// /sok) plus the DB-driven sitemap all read through these. EVERY query reuses
// the SAME PUBLISH_GATE_SQL the detail page + /discover use, so the set of rows
// reachable from any index page == the set with a live detail page == the set
// in the sitemap (100% weave, zero orphan/dead links — the work-order's core
// requirement). Read-only; no schema change.

// One card's worth of columns — the shared listing-row shape used by every
// browse page (index/category/fylke/provider/search).
export type ExperienceCardRow = {
  slug: string;
  title: string;
  description: string | null;
  category: string | null;
  fylke: string | null;
  kommune: string | null;
  indoor_outdoor: string | null;
  duration_min: number | null;
  price_from: number | null;
  price_band: string | null;
  confidence: string | null;
};

const CARD_COLS =
  "e.slug AS slug, e.title AS title, e.description AS description, " +
  "e.category AS category, e.fylke AS fylke, e.kommune AS kommune, " +
  "e.indoor_outdoor AS indoor_outdoor, e.duration_min AS duration_min, " +
  "e.price_from AS price_from, e.price_band AS price_band, e.confidence AS confidence";

// Confidence-then-title ordering, identical to /discover, so listings rank the
// same way the agent surface does.
const CARD_ORDER =
  "ORDER BY CASE e.confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, e.title ASC";

export type BrowseFilter = {
  category?: string | null;
  fylke?: string | null;
  kommune?: string | null;
  providerId?: string | null;
};

function browseWhere(filter: BrowseFilter): { sql: string; params: Record<string, unknown> } {
  const where: string[] = [`e.slug IS NOT NULL`, PUBLISH_GATE_SQL];
  const params: Record<string, unknown> = {};
  if (filter.category) { where.push("e.category = @category"); params.category = filter.category; }
  if (filter.fylke) { where.push("e.fylke = @fylke"); params.fylke = filter.fylke; }
  if (filter.kommune) { where.push("e.kommune = @kommune"); params.kommune = filter.kommune; }
  if (filter.providerId) { where.push("e.provider_id = @providerId"); params.providerId = filter.providerId; }
  return { sql: where.join(" AND "), params };
}

/** Count published experiences matching an optional category/fylke/provider filter. */
export function countPublishedExperiences(filter: BrowseFilter = {}): number {
  const db = getDb(VERTICAL);
  const { sql, params } = browseWhere(filter);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM experiences e
       LEFT JOIN experience_providers p ON p.id = e.provider_id
       WHERE ${sql}`
    )
    .get(params) as { c: number };
  return row.c;
}

/** A page of published experience cards (paginated), optionally filtered. */
export function listPublishedExperiences(
  filter: BrowseFilter = {},
  limit = 24,
  offset = 0
): ExperienceCardRow[] {
  const db = getDb(VERTICAL);
  const { sql, params } = browseWhere(filter);
  params.limit = Math.max(1, Math.min(100, limit));
  params.offset = Math.max(0, offset);
  return db
    .prepare(
      `SELECT ${CARD_COLS} FROM experiences e
       LEFT JOIN experience_providers p ON p.id = e.provider_id
       WHERE ${sql}
       ${CARD_ORDER}
       LIMIT @limit OFFSET @offset`
    )
    .all(params) as ExperienceCardRow[];
}

/** Distinct categories that have ≥1 PUBLISHED experience (with counts). Drives
 *  the homepage cards, the /opplevelser facet list, and the sitemap category
 *  URLs — so every linked category page is guaranteed non-empty. */
export function listPublishedCategories(): Array<{ category: string; count: number }> {
  const db = getDb(VERTICAL);
  return db
    .prepare(
      `SELECT e.category AS category, COUNT(*) AS count FROM experiences e
       LEFT JOIN experience_providers p ON p.id = e.provider_id
       WHERE e.category IS NOT NULL AND e.category != '' AND ${PUBLISH_GATE_SQL}
       GROUP BY e.category ORDER BY count DESC, e.category ASC`
    )
    .all() as Array<{ category: string; count: number }>;
}

/** Distinct fylker that have ≥1 PUBLISHED experience (with counts). */
export function listPublishedFylker(): Array<{ fylke: string; count: number }> {
  const db = getDb(VERTICAL);
  return db
    .prepare(
      `SELECT e.fylke AS fylke, COUNT(*) AS count FROM experiences e
       LEFT JOIN experience_providers p ON p.id = e.provider_id
       WHERE e.fylke IS NOT NULL AND e.fylke != '' AND ${PUBLISH_GATE_SQL}
       GROUP BY e.fylke ORDER BY count DESC, e.fylke ASC`
    )
    .all() as Array<{ fylke: string; count: number }>;
}

/** Distinct kommuner that have ≥1 PUBLISHED experience — with the fylke they sit
 *  in + counts. Drives the /kommune/<x> place pages, the kommune cross-links on
 *  /fylke/<x>, and the sitemap kommune URLs, so every linked kommune page is
 *  guaranteed non-empty (zero orphan/dead entries). One row per distinct kommune
 *  name (MAX(fylke) picks a representative fylke for the breadcrumb/up-link). */
export function listPublishedKommuner(): Array<{ kommune: string; fylke: string | null; count: number }> {
  const db = getDb(VERTICAL);
  return db
    .prepare(
      `SELECT e.kommune AS kommune, MAX(e.fylke) AS fylke, COUNT(*) AS count FROM experiences e
       LEFT JOIN experience_providers p ON p.id = e.provider_id
       WHERE e.kommune IS NOT NULL AND e.kommune != '' AND ${PUBLISH_GATE_SQL}
       GROUP BY e.kommune ORDER BY count DESC, e.kommune ASC`
    )
    .all() as Array<{ kommune: string; fylke: string | null; count: number }>;
}

/** Distinct providers that have ≥1 PUBLISHED experience (id, name, counts). */
export type PublishedProviderRow = {
  id: string;
  slug: string | null;
  navn: string;
  fylke: string | null;
  kommune: string | null;
  count: number;
};
export function listPublishedProviders(): PublishedProviderRow[] {
  const db = getDb(VERTICAL);
  return db
    .prepare(
      `SELECT p.id AS id, p.slug AS slug, p.navn AS navn, p.fylke AS fylke, p.kommune AS kommune,
              COUNT(*) AS count
       FROM experiences e
       JOIN experience_providers p ON p.id = e.provider_id
       WHERE e.slug IS NOT NULL AND ${PUBLISH_GATE_SQL}
       GROUP BY p.id ORDER BY count DESC, p.navn ASC`
    )
    .all() as PublishedProviderRow[];
}

/** A provider row, but only if it currently has ≥1 PUBLISHED experience. Used by
 *  the /tilbyder/:id page so providers with no live experience 404 (no orphan). */
export function getPublishedProviderById(id: string): Record<string, unknown> | null {
  if (!id) return null;
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT p.* FROM experience_providers p
       WHERE p.id = @id AND EXISTS (
         SELECT 1 FROM experiences e
         WHERE e.provider_id = p.id AND e.slug IS NOT NULL AND ${PUBLISH_GATE_SQL}
       )`
    )
    .get({ id }) as Record<string, unknown> | undefined;
  return row ?? null;
}

/** Look up a provider by its generated slug — for the /tilbyder/<slug> URL. */
export function getPublishedProviderBySlug(slug: string): Record<string, unknown> | null {
  if (!slug) return null;
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT p.* FROM experience_providers p
       WHERE p.slug = @slug AND EXISTS (
         SELECT 1 FROM experiences e
         WHERE e.provider_id = p.id AND e.slug IS NOT NULL AND ${PUBLISH_GATE_SQL}
       )`
    )
    .get({ slug }) as Record<string, unknown> | undefined;
  return row ?? null;
}

/**
 * Backfill the slug column for experience_providers rows that have none.
 * Slug format: <slugified-navn>--<first-8-chars-of-id>.
 * Idempotent and boot-safe: skips rows already having a slug.
 * Returns the count of rows updated.
 */
export function backfillProviderSlugs(): number {
  const db = getDb(VERTICAL);
  const rows = db
    .prepare("SELECT id, navn FROM experience_providers WHERE slug IS NULL OR slug = ''")
    .all() as { id: string; navn: string }[];
  let updated = 0;
  for (const row of rows) {
    const base = `${slugify(row.navn)}--${row.id.slice(0, 8)}`;
    try {
      const changed = db
        .prepare("UPDATE experience_providers SET slug = ? WHERE id = ? AND (slug IS NULL OR slug = '')")
        .run(base, row.id).changes;
      updated += changed;
    } catch {
      // Rare: duplicate slug (two providers with identical name+id-prefix).
      // Append more of the id to break the tie.
      const fallback = `${slugify(row.navn)}--${row.id.replace(/-/g, "").slice(0, 12)}`;
      try {
        const changed = db
          .prepare("UPDATE experience_providers SET slug = ? WHERE id = ? AND (slug IS NULL OR slug = '')")
          .run(fallback, row.id).changes;
        updated += changed;
      } catch { /* give up on this row */ }
    }
  }
  return updated;
}

/**
 * Norwegian→English synonym map for the /sok search route.
 * Allows Norwegian-speaking users to find experiences with English-language
 * titles. Keys: lowercase Norwegian terms. Values: English equivalents to OR
 * into the LIKE clauses. Kept small and curated — only terms with confirmed
 * gaps in the production DB (all experience titles are in English).
 */
const SEARCH_SYNONYMS: Record<string, string[]> = {
  hval:        ["whale"],
  hvalsafari:  ["whale"],
  nordlys:     ["aurora", "northern lights"],
  brevandring: ["glacier"],
  isbre:       ["glacier"],
  hundespann:  ["dog"],
  reinsdyr:    ["reindeer"],
  sjøørn:      ["eagle"],
  klatring:    ["climb"],
  klatre:      ["climb"],
  kajak:       ["kayak"],
  kajakk:      ["kayak"],
  badstue:     ["sauna"],
  vandring:    ["hike", "hiking"],
  fjelltur:    ["mountain", "hike"],
  midnattssol: ["midnight"],
  rorbu:       ["cabin", "fisherman"],
  fiske:       ["fishing"],
  dykking:     ["dive", "diving"],
};

/** Expand one query token with Norwegian→English synonyms (returns ≥1 term). */
function expandSearchTerm(term: string): string[] {
  const lower = term.toLowerCase();
  const synonyms = SEARCH_SYNONYMS[lower] ?? [];
  return synonyms.length > 0 ? [lower, ...synonyms] : [lower];
}

/** Free-text search over PUBLISHED experiences (title/description/category/place).
 *  Reuses the publish gate so search only ever returns rows that have a live
 *  detail page. Tokenised AND match — every whitespace-separated term must hit
 *  at least one searchable column. Norwegian query terms are expanded via
 *  SEARCH_SYNONYMS so e.g. "hval" also matches English-titled whale experiences. */
export function searchPublishedExperiences(query: string, limit = 30): ExperienceCardRow[] {
  const q = String(query || "").trim();
  if (!q) return [];
  const terms = q.split(/\s+/).filter((t) => t.length > 0).slice(0, 8);
  if (terms.length === 0) return [];
  const db = getDb(VERTICAL);
  const params: Record<string, unknown> = { limit: Math.max(1, Math.min(100, limit)) };
  const termClauses = terms.map((t, i) => {
    // Expand Norwegian term into [original, ...english_synonyms]
    const expanded = expandSearchTerm(t);
    const fieldClauses = expanded.flatMap((et, ei) => {
      const key = `t${i}_${ei}`;
      params[key] = `%${et.toLowerCase()}%`;
      return [
        `lower(e.title) LIKE @${key}`,
        `lower(COALESCE(e.description,'')) LIKE @${key}`,
        `lower(COALESCE(e.category,'')) LIKE @${key}`,
        `lower(COALESCE(e.fylke,'')) LIKE @${key}`,
        `lower(COALESCE(e.kommune,'')) LIKE @${key}`,
      ];
    });
    return `(${fieldClauses.join(" OR ")})`;
  });
  return db
    .prepare(
      `SELECT ${CARD_COLS} FROM experiences e
       LEFT JOIN experience_providers p ON p.id = e.provider_id
       WHERE e.slug IS NOT NULL AND ${PUBLISH_GATE_SQL}
         AND ${termClauses.join(" AND ")}
       ${CARD_ORDER}
       LIMIT @limit`
    )
    .all(params) as ExperienceCardRow[];
}


/**
 * Intent-discovery query — the heart of "Hva kan vi finne på i [sted]".
 *
 * Only surfaces rows that are publishable: verified experience whose provider
 * is brreg_active, confidence >= medium. Weather/season/group/age narrow the
 * set; final fine-ranking is left to the MCP/agent layer.
 */
export function discoverExperiences(
  filter: DiscoverFilter = {},
  limit = 20
): Array<Experience & { id: string }> {
  const f = DiscoverFilterSchema.parse(filter);
  const db = getDb(VERTICAL);

  const where: string[] = [
    "e.verification_status = 'verified'",
    "(e.confidence IS NULL OR e.confidence IN ('high','medium'))",
    "(p.id IS NULL OR p.brreg_active = 1)",
  ];
  const params: Record<string, unknown> = {};

  if (f.fylke) { where.push("e.fylke = @fylke"); params.fylke = f.fylke; }
  if (f.kommune) { where.push("e.kommune = @kommune"); params.kommune = f.kommune; }
  if (f.category) { where.push("e.category = @category"); params.category = f.category; }
  if (f.indoor_outdoor) { where.push("e.indoor_outdoor IN (@io, 'both')"); params.io = f.indoor_outdoor; }
  // Rain/snow → prefer indoor + weather-independent.
  if (f.weather === "rain" || f.weather === "snow") {
    where.push("(e.indoor_outdoor IN ('indoor','both') OR e.weather_dependent = 0)");
  }
  if (f.season) { where.push("(e.season IS NULL OR e.season LIKE @season OR e.season LIKE '%year_round%')"); params.season = `%"${f.season}"%`; }
  if (typeof f.group_size === "number") {
    where.push("(e.group_min IS NULL OR e.group_min <= @gs) AND (e.group_max IS NULL OR e.group_max >= @gs)");
    params.gs = f.group_size;
  }
  if (typeof f.age === "number") { where.push("(e.min_age IS NULL OR e.min_age <= @age)"); params.age = f.age; }
  if (typeof f.max_price === "number") { where.push("(e.price_from IS NULL OR e.price_from <= @maxp)"); params.maxp = f.max_price; }
  if (typeof f.duration_max === "number") { where.push("(e.duration_min IS NULL OR e.duration_min <= @dmax)"); params.dmax = f.duration_max; }
  if (f.language) { where.push("(e.languages IS NULL OR e.languages LIKE @lang)"); params.lang = `%"${f.language}"%`; }

  params.limit = Math.max(1, Math.min(100, limit));

  const sql = `
    SELECT e.* FROM experiences e
    LEFT JOIN experience_providers p ON p.id = e.provider_id
    WHERE ${where.join(" AND ")}
    ORDER BY CASE e.confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, e.title ASC
    LIMIT @limit
  `;
  const rows = db.prepare(sql).all(params) as Array<Record<string, unknown>>;
  return rows.map(hydrateExperience);
}

export function listCategories(): Array<{ category: string; count: number }> {
  const db = getDb(VERTICAL);
  return db.prepare(`
    SELECT category, COUNT(*) as count FROM experiences
    WHERE category IS NOT NULL AND verification_status = 'verified'
    GROUP BY category ORDER BY count DESC
  `).all() as Array<{ category: string; count: number }>;
}

// ─── Bulk insert (Phase A harvest ingest) ───────────────────────────
export type HarvestRow = Partial<Experience> & { title: string };

export function bulkInsertExperiences(rows: HarvestRow[]): { inserted: number; skipped: number } {
  const db = getDb(VERTICAL);
  let inserted = 0, skipped = 0;
  const tx = db.transaction((batch: HarvestRow[]) => {
    for (const row of batch) {
      if (!row.title) { skipped++; continue; }
      try {
        createExperience(row as Experience);
        inserted++;
      } catch {
        skipped++;
      }
    }
  });
  tx(rows);
  return { inserted, skipped };
}

// ─── Idempotency helper (orchestrator-pr-18 bulk-load) ──────────────
/**
 * True if an experience with this (provider_id, title) already exists.
 * Used by the admin bulk-load to skip re-inserting a row on a re-run.
 * Title match is case-insensitive/trim-insensitive to absorb harvest noise.
 */
export function experienceExistsForProvider(providerId: string, title: string): boolean {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      "SELECT 1 FROM experiences WHERE provider_id = ? AND lower(trim(title)) = lower(trim(?)) LIMIT 1"
    )
    .get(providerId, title);
  return !!row;
}

/**
 * Find a provider by exact (case-insensitive/trim) name. Used by bulk-load
 * to dedup `unverified` providers that have no org_nr (so getProviderByOrgnr
 * can't catch them) on a re-run.
 */
export function getProviderByName(navn: string): Record<string, unknown> | null {
  const db = getDb(VERTICAL);
  return (
    (db
      .prepare("SELECT * FROM experience_providers WHERE lower(trim(navn)) = lower(trim(?)) LIMIT 1")
      .get(navn) as Record<string, unknown>) ?? null
  );
}

// ─── Homepage-content enrichment (orch-experiences-content-refresh) ──
//
// Mirrors the rfb `POST /admin/homepage-content-refresh` writer, adapted to the
// experiences data model. In experiences, the human-readable "about" content
// lives on the `experiences.description` column (providers carry no about field)
// and the activity classification lives on `experiences.category`. So the
// content-refresh writer enriches a provider's EXPERIENCES (description +
// category) from that provider's own homepage, and stamps provider enrichment
// metadata — it NEVER touches contact/orgnr/Brreg-verification fields.
//
// LOCK MODEL (experiences-native; there is no rfb-style field_provenance here):
//   - an experience is LOCKED for content writes when it is owner/curator/claim
//     sourced or already verified — i.e. verification_status='verified' OR
//     content_source IN ('manual','claim'). Those are human/owner-authored and
//     must never be overwritten by a homepage scrape.
//   - within an UNLOCKED experience, a field is only written when it is THIN:
//     description is written only if currently empty/blank; category is written
//     only if currently empty. We never overwrite an existing non-empty value
//     (blank beats wrong), matching the rfb "only fill google-sourced/empty" gate.

/**
 * Placeholder description inserted by the bulk-load seed (experiences vertical).
 * Providers whose description equals this string are treated as having an EMPTY
 * description for content-refresh selection and write purposes — they are fully
 * eligible for homepage-based enrichment.
 */
export const EXPERIENCE_DESCRIPTION_PLACEHOLDER =
  "Detaljert beskrivelse publiseres fortløpende.";

export type ContentRefreshTarget = {
  id: string;
  navn: string;
  hjemmeside: string;
};

/**
 * Auto-select providers eligible for a homepage content-refresh: providers that
 * HAVE a website (hjemmeside) AND own ≥1 experience whose content is THIN
 * (description empty/placeholder OR category empty) and NOT locked (not verified,
 * not manual/claim-sourced). The bulk-load placeholder text
 * (EXPERIENCE_DESCRIPTION_PLACEHOLDER) is treated as empty so bulk-loaded providers
 * are selectable for enrichment. Ordered oldest-enriched first (last_enriched_at
 * NULLs first) so a sweep makes progress. Capped by `limit`.
 */
export function selectProvidersForContentRefresh(limit = 25): ContentRefreshTarget[] {
  const db = getDb(VERTICAL);
  const cap = Math.max(1, Math.min(100, limit));
  const rows = db
    .prepare(
      `SELECT p.id AS id, p.navn AS navn, TRIM(p.hjemmeside) AS hjemmeside
         FROM experience_providers p
        WHERE p.hjemmeside IS NOT NULL AND TRIM(p.hjemmeside) != ''
          AND EXISTS (
            SELECT 1 FROM experiences e
             WHERE e.provider_id = p.id
               AND e.verification_status != 'verified'
               AND (e.content_source IS NULL OR e.content_source NOT IN ('manual','claim'))
               AND (
                     e.description IS NULL OR TRIM(e.description) = ''
                  OR TRIM(e.description) = ?
                  OR e.category    IS NULL OR TRIM(e.category)    = ''
                   )
          )
        ORDER BY (p.last_enriched_at IS NOT NULL), p.last_enriched_at ASC, p.created_at ASC
        LIMIT ?`
    )
    .all(EXPERIENCE_DESCRIPTION_PLACEHOLDER, cap) as Array<{ id: string; navn: string; hjemmeside: string }>;
  return rows.filter((r) => r.hjemmeside && r.hjemmeside.trim().length > 0);
}

/**
 * Select providers that have thin experiences (description empty/placeholder OR
 * category empty, unlocked) but NO usable hjemmeside URL — they cannot be scraped
 * but should appear in the content-refresh error list so operators know they exist.
 * Capped by `limit`.
 */
export function selectProvidersNeedingEnrichmentNoHomepage(limit = 100): Array<{ id: string; navn: string }> {
  const db = getDb(VERTICAL);
  const cap = Math.max(1, Math.min(500, limit));
  const rows = db
    .prepare(
      `SELECT p.id AS id, p.navn AS navn
         FROM experience_providers p
        WHERE (p.hjemmeside IS NULL OR TRIM(p.hjemmeside) = '')
          AND EXISTS (
            SELECT 1 FROM experiences e
             WHERE e.provider_id = p.id
               AND e.verification_status != 'verified'
               AND (e.content_source IS NULL OR e.content_source NOT IN ('manual','claim'))
               AND (
                     e.description IS NULL OR TRIM(e.description) = ''
                  OR TRIM(e.description) = ?
                  OR e.category    IS NULL OR TRIM(e.category)    = ''
                   )
          )
        ORDER BY p.created_at ASC
        LIMIT ?`
    )
    .all(EXPERIENCE_DESCRIPTION_PLACEHOLDER, cap) as Array<{ id: string; navn: string }>;
  return rows;
}

/**
 * Resolve an explicit providerId for content-refresh. Returns the target shape
 * only when the provider exists AND has a usable website; otherwise null (the
 * caller records it as skipped/no-website).
 */
export function getProviderContentTarget(providerId: string): ContentRefreshTarget | null {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT id, navn, TRIM(hjemmeside) AS hjemmeside
         FROM experience_providers WHERE id = ?`
    )
    .get(providerId) as { id: string; navn: string; hjemmeside: string | null } | undefined;
  if (!row || !row.hjemmeside || row.hjemmeside.trim().length === 0) return null;
  return { id: row.id, navn: row.navn, hjemmeside: row.hjemmeside.trim() };
}

/** A provider's experiences, with only the columns the content gate needs. */
export type ExperienceContentRow = {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  subcategory: string | null;
  activity_tags: string | null;   // JSON-encoded string[] stored in DB
  season: string | null;          // JSON-encoded string[] stored in DB
  indoor_outdoor: string | null;
  duration_min: number | null;
  price_from: number | null;
  booking_url: string | null;
  content_source: string | null;
  verification_status: string | null;
};

export function getExperiencesForProvider(providerId: string): ExperienceContentRow[] {
  const db = getDb(VERTICAL);
  return db
    .prepare(
      `SELECT id, title, description, category, subcategory, activity_tags, season,
              indoor_outdoor, duration_min, price_from, booking_url,
              content_source, verification_status
         FROM experiences WHERE provider_id = ? ORDER BY created_at ASC`
    )
    .all(providerId) as ExperienceContentRow[];
}

/**
 * True when an experience is LOCKED against homepage content writes: it is
 * owner/curator/claim authored or already verified. Such rows are never
 * overwritten by a scrape (PURE-ish — reads only the passed row).
 */
export function isExperienceContentLocked(row: {
  content_source?: string | null;
  verification_status?: string | null;
}): boolean {
  if (row.verification_status === "verified") return true;
  if (row.content_source === "manual" || row.content_source === "claim") return true;
  return false;
}

/**
 * Apply homepage-sourced content to ONE experience, respecting locks + thin-only
 * gate. Writes each candidate field only if the experience's current value is
 * blank; stamps content_source='provider_site', enrichment_state, and updated_at
 * when anything changed. Returns the field names actually written.
 * NEVER touches contact/orgnr/Brreg/owner fields. Idempotent: a second run finds
 * the fields populated and writes nothing.
 *
 * Extended by experiences-richer-profiles (2026-06-25) to also write structured
 * attributes: subcategory, activity_tags, season, indoor_outdoor, duration_min,
 * price_from, booking_url — all written only to EMPTY + UNLOCKED experiences.
 */
export function applyExperienceContent(
  experienceId: string,
  candidate: {
    description?: string | null;
    category?: string | null;
    subcategory?: string | null;
    activity_tags?: string[] | null;
    season?: string[] | null;
    indoor_outdoor?: string | null;
    duration_min?: number | null;
    price_from?: number | null;
    booking_url?: string | null;
  }
): string[] {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT id, description, category, subcategory, activity_tags, season,
              indoor_outdoor, duration_min, price_from, booking_url,
              content_source, verification_status
         FROM experiences WHERE id = ?`
    )
    .get(experienceId) as ExperienceContentRow | undefined;
  if (!row) return [];
  if (isExperienceContentLocked(row)) return [];

  const sets: string[] = [];
  const params: Record<string, unknown> = { id: experienceId };
  const written: string[] = [];

  function isBlank(v: unknown): boolean {
    if (v === null || v === undefined) return true;
    const s = String(v).trim();
    return s === "" || s === "null" || s === "[]" || s === EXPERIENCE_DESCRIPTION_PLACEHOLDER;
  }

  if (isBlank(row.description) && candidate.description?.trim()) {
    sets.push("description = @description");
    params.description = candidate.description.trim();
    written.push("description");
  }
  if (isBlank(row.category) && candidate.category?.trim()) {
    sets.push("category = @category");
    params.category = candidate.category.trim();
    written.push("category");
  }
  if (isBlank(row.subcategory) && candidate.subcategory?.trim()) {
    sets.push("subcategory = @subcategory");
    params.subcategory = candidate.subcategory.trim();
    written.push("subcategory");
  }
  if (isBlank(row.activity_tags) && candidate.activity_tags?.length) {
    sets.push("activity_tags = @activity_tags");
    params.activity_tags = JSON.stringify(candidate.activity_tags);
    written.push("activity_tags");
  }
  if (isBlank(row.season) && candidate.season?.length) {
    sets.push("season = @season");
    params.season = JSON.stringify(candidate.season);
    written.push("season");
  }
  if (isBlank(row.indoor_outdoor) && candidate.indoor_outdoor) {
    sets.push("indoor_outdoor = @indoor_outdoor");
    params.indoor_outdoor = candidate.indoor_outdoor;
    written.push("indoor_outdoor");
  }
  if (isBlank(row.duration_min) && typeof candidate.duration_min === "number") {
    sets.push("duration_min = @duration_min");
    params.duration_min = candidate.duration_min;
    written.push("duration_min");
  }
  if (isBlank(row.price_from) && typeof candidate.price_from === "number") {
    sets.push("price_from = @price_from");
    params.price_from = candidate.price_from;
    written.push("price_from");
  }
  if (isBlank(row.booking_url) && candidate.booking_url?.trim()) {
    sets.push("booking_url = @booking_url");
    params.booking_url = candidate.booking_url.trim();
    written.push("booking_url");
  }

  if (sets.length === 0) return [];

  sets.push("content_source = 'provider_site'");
  sets.push("enrichment_state = 'enriched'");
  sets.push("updated_at = datetime('now')");

  db.prepare(`UPDATE experiences SET ${sets.join(", ")} WHERE id = @id`).run(params);
  return written;
}

/** Stamp a provider's enrichment metadata after a content-refresh pass (no
 * contact/Brreg fields touched). Best-effort; returns true if a row changed. */
export function markProviderEnriched(providerId: string): boolean {
  const db = getDb(VERTICAL);
  const res = db
    .prepare(
      `UPDATE experience_providers
          SET enrichment_state = 'enriched', last_enriched_at = datetime('now'),
              updated_at = datetime('now')
        WHERE id = ?`
    )
    .run(providerId);
  return res.changes > 0;
}
