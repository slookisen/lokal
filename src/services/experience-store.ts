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
import { fylkeEquivalents } from "./norway-fylke";
import { deriveExperienceTags, type ExperienceTag, type TaggableExperience } from "./experience-tags";
import { haversineDistanceKm } from "./geocoding-service";
import {
  findExistingCandidateMatch,
  scoreExperienceRichness,
  type DedupCandidateRow,
  type ExperienceRichnessInput,
} from "./experience-dedup";
export {
  runDedupPass,
  scoreExperienceRichness,
  pickCanonical,
  titlesMatch,
  normalizeExperienceTitle,
  groupDuplicateCandidates,
  type DedupCandidateRow,
  type DedupPassResult,
} from "./experience-dedup";

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
  // How loc_lat/loc_lon was derived — 'address' (precise, geocoded from the
  // provider's street address) vs 'kommune' (approximate, a municipality
  // centroid). Added in PR #207 (item-1, near-me search backfill worker).
  // NULL means the row has no location at all yet.
  geo_precision: z.enum(["address", "kommune"]).optional().nullable(),
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
// lat/lng/radius_km/sort — dev-request 2026-07-04-opplevagent-naer-meg-geosok,
// item 2 (near-me search). All four are optional and additive: omitting them
// produces byte-identical behavior to before this filter existed. `lat`/`lng`
// are the caller's origin point; when both are given, discoverExperiences()
// only returns rows with a real geocoded location (geo_precision NOT NULL —
// never fabricates a distance for an ungeocoded row), attaches a rounded
// `distance_km` to each result, and sorts ascending by distance (the only
// sort `sort:"distance"` can mean — it is accepted as an explicit, documented
// request for that same behavior, which is otherwise already the default the
// moment an origin is given).
const DiscoverFilterBaseSchema = z.object({
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
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  radius_km: z.number().positive().max(5000).optional(),
  sort: z.enum(["distance"]).optional(),
});
export const DiscoverFilterSchema = DiscoverFilterBaseSchema.refine(
  (f) => (f.lat === undefined) === (f.lng === undefined),
  { message: "lat and lng must both be provided together", path: ["lat"] }
);
export type DiscoverFilter = z.infer<typeof DiscoverFilterBaseSchema>;

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

// Additive-only cross-cutting filter tags (Daniel dev-request, 2026-07):
// derived from fields that already exist on the row — see experience-tags.ts.
// No schema change; computed at read time and attached to every hydrated
// experience so discoverExperiences()/getExperienceById()/
// getPublishedExperienceBySlug() callers get it for free.
function hydrateExperience(row: Record<string, unknown>): Experience & { id: string; tags: ExperienceTag[] } {
  const base = {
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
    geo_precision: (row.geo_precision as Experience["geo_precision"]) ?? null,
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
  return { ...base, tags: deriveExperienceTags(base) };
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
      loc_lat, loc_lon, geo_precision, meeting_point, kommune, fylke,
      discovery_source, content_source, evidence_url, confidence,
      enrichment_state, verification_status, seasonal_valid_from, seasonal_valid_to
    ) VALUES (
      @id, @provider_id, @provider_match_status, @title, @slug, @description,
      @category, @subcategory, @activity_tags, @season, @indoor_outdoor, @weather_dependent,
      @physical_intensity, @duration_min, @duration_max, @group_min, @group_max,
      @age_suitability, @min_age, @price_band, @price_from, @price_unit,
      @languages, @accessibility, @booking_url, @booking_type,
      @loc_lat, @loc_lon, @geo_precision, @meeting_point, @kommune, @fylke,
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
    loc_lat: e.loc_lat ?? null, loc_lon: e.loc_lon ?? null, geo_precision: e.geo_precision ?? null,
    meeting_point: e.meeting_point ?? null,
    kommune: e.kommune ?? null, fylke: e.fylke ?? null,
    discovery_source: e.discovery_source ?? null, content_source: e.content_source ?? null,
    evidence_url: e.evidence_url ?? null, confidence: e.confidence ?? null,
    enrichment_state: e.enrichment_state ?? "raw",
    verification_status: e.verification_status ?? "pending_verify",
    seasonal_valid_from: e.seasonal_valid_from ?? null, seasonal_valid_to: e.seasonal_valid_to ?? null,
  });
  return id;
}

export function getExperienceById(id: string): (Experience & { id: string; tags: ExperienceTag[] }) | null {
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
// dev-request 2026-07-04-opplevagent-dedup-og-norske-titler, item 1: a row
// that the dedup pass folded into another (canonical) row must never surface
// again in any browse/discover/sitemap result — canonical_id IS NULL means
// "this row IS canonical" (see init-experiences.ts + experience-dedup.ts).
const PUBLISH_GATE_SQL =
  "e.verification_status = 'verified' " +
  "AND (e.confidence IS NULL OR e.confidence IN ('high','medium')) " +
  "AND (p.id IS NULL OR p.brreg_active = 1) " +
  "AND e.canonical_id IS NULL";

export function getPublishedExperienceBySlug(
  slug: string
): (Experience & { id: string; tags: ExperienceTag[] }) | null {
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
  // dev-request 2026-07-04-opplevagent-taksonomi-filtre: derived cross-cutting
  // filter tags (see experience-tags.ts), computed at read time — same as
  // hydrateExperience()'s `tags`, wired into the card-listing path too so
  // /sok filter-chips and card badges can rely on it everywhere.
  tags: ExperienceTag[];
};

const CARD_COLS =
  "e.slug AS slug, e.title AS title, e.description AS description, " +
  "e.category AS category, e.fylke AS fylke, e.kommune AS kommune, " +
  "e.indoor_outdoor AS indoor_outdoor, e.duration_min AS duration_min, " +
  "e.price_from AS price_from, e.price_band AS price_band, e.confidence AS confidence, " +
  // Extra raw columns needed ONLY to derive `tags` (deriveExperienceTags's
  // TaggableExperience shape) — not part of the public ExperienceCardRow
  // surface; stripped by hydrateCardRow() below.
  "e.age_suitability AS age_suitability, e.min_age AS min_age, " +
  "e.weather_dependent AS weather_dependent, e.accessibility AS accessibility, " +
  "e.season AS season, e.seasonal_valid_from AS seasonal_valid_from, " +
  "e.seasonal_valid_to AS seasonal_valid_to";

/** Maps one raw CARD_COLS row (incl. the tag-derivation-only columns) to the
 *  public ExperienceCardRow shape, attaching the derived `tags`. */
function hydrateCardRow(row: Record<string, unknown>): ExperienceCardRow {
  return {
    slug: row.slug as string,
    title: row.title as string,
    description: (row.description as string | null) ?? null,
    category: (row.category as string | null) ?? null,
    fylke: (row.fylke as string | null) ?? null,
    kommune: (row.kommune as string | null) ?? null,
    indoor_outdoor: (row.indoor_outdoor as string | null) ?? null,
    duration_min: (row.duration_min as number | null) ?? null,
    price_from: (row.price_from as number | null) ?? null,
    price_band: (row.price_band as string | null) ?? null,
    confidence: (row.confidence as string | null) ?? null,
    tags: deriveExperienceTags({
      age_suitability: (row.age_suitability as TaggableExperience["age_suitability"]) ?? null,
      min_age: (row.min_age as number | null) ?? null,
      price_band: (row.price_band as string | null) ?? null,
      price_from: (row.price_from as number | null) ?? null,
      indoor_outdoor: (row.indoor_outdoor as TaggableExperience["indoor_outdoor"]) ?? null,
      weather_dependent: (row.weather_dependent as 0 | 1 | null) ?? null,
      accessibility: parseJsonArray(row.accessibility),
      season: parseJsonArray(row.season),
      seasonal_valid_from: (row.seasonal_valid_from as string | null) ?? null,
      seasonal_valid_to: (row.seasonal_valid_to as string | null) ?? null,
    }),
  };
}

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
  const rows = db
    .prepare(
      `SELECT ${CARD_COLS} FROM experiences e
       LEFT JOIN experience_providers p ON p.id = e.provider_id
       WHERE ${sql}
       ${CARD_ORDER}
       LIMIT @limit OFFSET @offset`
    )
    .all(params) as Record<string, unknown>[];
  return rows.map(hydrateCardRow);
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

// dev-request 2026-07-04-opplevagent-nl-parser-og-fylkesnormalisering, item 5:
// case/diacritic-insensitive fylke/kommune URL matching (routes/experiences-seo.ts
// /fylke/:fylke and /kommune/:kommune 301-redirect a differently-cased or
// ascii-folded param — e.g. "/kommune/tromso" — to the canonical, live-DB-cased
// path — e.g. "/kommune/Tromsø" — instead of 404ing).
//
// NOTE: this is a SLUG-COMPARISON helper only — never used for display, and
// deliberately independent of norway-fylke.ts's `key()` (which additionally
// strips spaces/punctuation and applies 2020/2024 fylke-reform alias
// resolution; neither is wanted here — this only needs to recognise the SAME
// place spelled with different case/diacritics, e.g. "Kristiansand S" must
// stay "kristiansand s", not collapse into "kristiansands").
/**
 * Lowercase + ascii-fold a Norwegian place name for case/diacritic-insensitive
 * comparison. Strips combining diacritical marks left behind by Unicode NFD
 * decomposition (handles é/è/ü/etc., and also å — which canonically
 * decomposes to `a` + U+030A under NFD, so it is already folded by the strip
 * step); ø and æ have no NFD decomposition (they are their own code points),
 * so the explicit replacements below handle those two. All three explicit
 * replacements are kept regardless of which step actually does the work, so
 * the function's behavior doesn't depend on normalize()'s decomposition
 * table. Whitespace is preserved (only trimmed at the ends) so multi-word
 * names remain distinguishable ("Kristiansand S" → "kristiansand s", never
 * merged with an unrelated "Kristiansands").
 *
 *   foldPlaceSlug("Tromsø")          → "tromso"
 *   foldPlaceSlug("TROMSØ")          → "tromso"
 *   foldPlaceSlug("Ålesund")         → "alesund"
 *   foldPlaceSlug("Kristiansand S")  → "kristiansand s"
 */
export function foldPlaceSlug(raw: string): string {
  if (typeof raw !== "string") return "";
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip NFD combining diacritical marks
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/å/g, "a")
    .trim();
}

// GEO: aggregate FAQ-relevant stats for the category/kommune browse pages
// (dev-request 2026-06-30-geo-content-structured-data, category/city slice —
// the producer-vertical city page already has this in routes/seo.ts; these
// two feed the experiences-vertical `/kategori/:category` and
// `/kommune/:kommune` pages' FAQPage JSON-LD, built by
// buildCategoryFaqJsonLd()/buildKommuneFaqJsonLd() in routes/experiences-seo.ts).
// Both reuse the SAME browseWhere() filter + PUBLISH_GATE_SQL the listing
// itself queries with, so the FAQ facts can never diverge from what the page
// actually lists — regardless of which page of paginated results is open.

/** Aggregate stats for one category's FAQPage JSON-LD: how many distinct
 *  fylker/kommuner have a published experience in this category, and the
 *  lowest listed starting price (null if no row states one — never guessed). */
export function getCategoryFaqStats(category: string): {
  fylkeCount: number;
  kommuneCount: number;
  minPriceFrom: number | null;
} {
  const db = getDb(VERTICAL);
  const { sql, params } = browseWhere({ category });
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT e.fylke) AS fylkeCount,
              COUNT(DISTINCT e.kommune) AS kommuneCount,
              MIN(e.price_from) AS minPriceFrom
       FROM experiences e
       LEFT JOIN experience_providers p ON p.id = e.provider_id
       WHERE ${sql}`
    )
    .get(params) as { fylkeCount: number; kommuneCount: number; minPriceFrom: number | null } | undefined;
  return {
    fylkeCount: row?.fylkeCount || 0,
    kommuneCount: row?.kommuneCount || 0,
    minPriceFrom: row?.minPriceFrom ?? null,
  };
}

/** Aggregate stats for one kommune's FAQPage JSON-LD: how many distinct
 *  categories have a published experience there, and the lowest listed
 *  starting price (null if no row states one — never guessed). Mirrors
 *  getCategoryFaqStats() but grouped by kommune instead of category. */
export function getKommuneFaqStats(kommune: string): {
  categoryCount: number;
  minPriceFrom: number | null;
} {
  const db = getDb(VERTICAL);
  const { sql, params } = browseWhere({ kommune });
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT e.category) AS categoryCount,
              MIN(e.price_from) AS minPriceFrom
       FROM experiences e
       LEFT JOIN experience_providers p ON p.id = e.provider_id
       WHERE ${sql}`
    )
    .get(params) as { categoryCount: number; minPriceFrom: number | null } | undefined;
  return {
    categoryCount: row?.categoryCount || 0,
    minPriceFrom: row?.minPriceFrom ?? null,
  };
}

// GEO: category×kommune cross-tab aggregate + candidate list for the
// "query landing pages" slice (dev-request 2026-06-30-geo-content-structured-data,
// final remaining slice — programmatic `/kategori/:category/:kommune` pages
// targeting "Hvor får jeg [produkt] i [by]"-style queries). Both reuse the
// SAME browseWhere()/PUBLISH_GATE_SQL filter as getCategoryFaqStats()/
// getKommuneFaqStats() and the listing itself, so the facts driving the
// quality gate can never diverge from what the page actually lists.

/** Aggregate stats for one category×kommune combo's FAQPage JSON-LD +
 *  quality gate: how many published experiences of this category exist in
 *  this kommune, how many distinct providers offer them, and the lowest
 *  listed starting price (null if none stated — never guessed). Mirrors
 *  getCategoryFaqStats()/getKommuneFaqStats() but for the intersection of
 *  both dimensions. */
export function getProduktByStats(category: string, kommune: string): {
  total: number;
  providerCount: number;
  minPriceFrom: number | null;
} {
  const db = getDb(VERTICAL);
  const { sql, params } = browseWhere({ category, kommune });
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COUNT(DISTINCT e.provider_id) AS providerCount,
              MIN(e.price_from) AS minPriceFrom
       FROM experiences e
       LEFT JOIN experience_providers p ON p.id = e.provider_id
       WHERE ${sql}`
    )
    .get(params) as { total: number; providerCount: number; minPriceFrom: number | null } | undefined;
  return {
    total: row?.total || 0,
    providerCount: row?.providerCount || 0,
    minPriceFrom: row?.minPriceFrom ?? null,
  };
}

/** Every (category, kommune) combo that has ≥1 PUBLISHED experience, with
 *  the same three facts getProduktByStats() returns — the DB-driven
 *  candidate list for the query-landing-pages sitemap loop. Deliberately NOT
 *  a full category × kommune cross-product (most cells of that grid are
 *  empty): one GROUP BY query returns exactly the combos that exist in the
 *  catalog, with the quality-gate facts already attached, so the sitemap
 *  builder can apply the ≥2-real-facts gate in-memory over this one result
 *  set instead of issuing a query per candidate combo. */
export type ProduktByComboRow = {
  category: string;
  kommune: string;
  total: number;
  providerCount: number;
  minPriceFrom: number | null;
};
export function listProduktByCombos(): ProduktByComboRow[] {
  const db = getDb(VERTICAL);
  return db
    .prepare(
      `SELECT e.category AS category, e.kommune AS kommune,
              COUNT(*) AS total,
              COUNT(DISTINCT e.provider_id) AS providerCount,
              MIN(e.price_from) AS minPriceFrom
       FROM experiences e
       LEFT JOIN experience_providers p ON p.id = e.provider_id
       WHERE e.category IS NOT NULL AND e.category != ''
         AND e.kommune IS NOT NULL AND e.kommune != ''
         AND ${PUBLISH_GATE_SQL}
       GROUP BY e.category, e.kommune
       ORDER BY total DESC, e.category ASC, e.kommune ASC`
    )
    .all() as ProduktByComboRow[];
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

/** Count of distinct providers with ≥1 PUBLISHED experience — the "Tilbydere"
 *  counter powering the homepage counter strip (dev-request
 *  2026-07-04-opplevagent-besokstall-og-forside-friskhet). Mirrors
 *  listPublishedProviders()'s WHERE/JOIN shape but returns just the count
 *  (no full row hydration) so the homepage can call it on every render
 *  without materializing the whole provider list. */
export function countPublishedProviders(): number {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT p.id) AS c
       FROM experiences e
       JOIN experience_providers p ON p.id = e.provider_id
       WHERE e.slug IS NOT NULL AND ${PUBLISH_GATE_SQL}`
    )
    .get() as { c: number };
  return row.c;
}

/** Count of distinct kommuner with ≥1 PUBLISHED experience — the "Kommuner"
 *  counter powering the homepage counter strip (same dev-request as
 *  countPublishedProviders() above). Mirrors listPublishedKommuner()'s
 *  WHERE shape but returns just the count. */
export function countPublishedKommuner(): number {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT e.kommune) AS c FROM experiences e
       LEFT JOIN experience_providers p ON p.id = e.provider_id
       WHERE e.kommune IS NOT NULL AND e.kommune != '' AND ${PUBLISH_GATE_SQL}`
    )
    .get() as { c: number };
  return row.c;
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
  const rows = db
    .prepare(
      `SELECT ${CARD_COLS} FROM experiences e
       LEFT JOIN experience_providers p ON p.id = e.provider_id
       WHERE e.slug IS NOT NULL AND ${PUBLISH_GATE_SQL}
         AND ${termClauses.join(" AND ")}
       ${CARD_ORDER}
       LIMIT @limit`
    )
    .all(params) as Record<string, unknown>[];
  return rows.map(hydrateCardRow);
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
): Array<Experience & { id: string; tags: ExperienceTag[]; distance_km?: number }> {
  const f = DiscoverFilterSchema.parse(filter);
  const db = getDb(VERTICAL);

  const where: string[] = [
    "e.verification_status = 'verified'",
    "(e.confidence IS NULL OR e.confidence IN ('high','medium'))",
    "(p.id IS NULL OR p.brreg_active = 1)",
    // dev-request 2026-07-04-opplevagent-dedup-og-norske-titler, item 1: never
    // surface a row the dedup pass merged away as a duplicate.
    "e.canonical_id IS NULL",
  ];
  const params: Record<string, unknown> = {};

  // near-me geo filter (dev-request 2026-07-04-opplevagent-naer-meg-geosok,
  // item 2). Both lat+lng present is enforced by DiscoverFilterSchema's
  // refine, so narrowing on both together here is exact (not just a hint).
  const hasGeo = typeof f.lat === "number" && typeof f.lng === "number";
  const originLat = f.lat;
  const originLng = f.lng;
  if (hasGeo && typeof originLat === "number" && typeof originLng === "number") {
    // Never fabricate a distance: a row with no geocoded location at all
    // (geo_precision IS NULL, e.g. never backfilled, or backfill failed) is
    // excluded outright rather than surfaced without a distance_km.
    where.push("e.loc_lat IS NOT NULL AND e.loc_lon IS NOT NULL AND e.geo_precision IS NOT NULL");
    if (typeof f.radius_km === "number") {
      // Bounding-box pre-filter (cheap, SQL-level) — mirrors the pattern in
      // src/services/marketplace-registry.ts's discover(): a coarse degrees-
      // based box first, then the exact haversine cut (+ real distance_km)
      // is computed in JS on the (small) surviving set below.
      const latDelta = f.radius_km / 111.0; // ~111km per degree latitude
      const lngDelta = f.radius_km / (111.0 * Math.cos((originLat * Math.PI) / 180));
      where.push("e.loc_lat BETWEEN @geoLatMin AND @geoLatMax AND e.loc_lon BETWEEN @geoLngMin AND @geoLngMax");
      params.geoLatMin = originLat - latDelta;
      params.geoLatMax = originLat + latDelta;
      params.geoLngMin = originLng - lngDelta;
      params.geoLngMax = originLng + lngDelta;
    }
  }

  if (f.fylke) {
    // Bridge pre-2024/2020 fylke-reform era spellings against whatever era
    // the DB row's fylke column happens to be in (see norway-fylke.ts) —
    // a caller-supplied "Troms" must still match a DB row stored as the
    // pre-2024 "Troms og Finnmark", and vice versa.
    const equivalents = fylkeEquivalents(f.fylke);
    const placeholders = equivalents.map((_, i) => `@fylke${i}`);
    where.push(`e.fylke IN (${placeholders.join(", ")})`);
    equivalents.forEach((v, i) => { params[`fylke${i}`] = v; });
  }
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

  // When a geo origin is given, the true top-N-by-distance can't be decided
  // in SQL (no haversine there), so the SQL LIMIT is widened to a generous
  // candidate cap and the real cut to `limit` happens after the exact
  // distance is computed + sorted in JS below — otherwise SQL's default
  // ORDER BY could discard closer rows before the distance sort ever sees them.
  const GEO_CANDIDATE_CAP = 2000;
  params.limit = hasGeo ? GEO_CANDIDATE_CAP : Math.max(1, Math.min(100, limit));

  const sql = `
    SELECT e.* FROM experiences e
    LEFT JOIN experience_providers p ON p.id = e.provider_id
    WHERE ${where.join(" AND ")}
    ORDER BY CASE e.confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, e.title ASC
    LIMIT @limit
  `;
  const rows = db.prepare(sql).all(params) as Array<Record<string, unknown>>;
  const hydrated = rows.map(hydrateExperience);

  if (!hasGeo || typeof originLat !== "number" || typeof originLng !== "number") return hydrated;

  // Exact haversine distance + radius cut + ascending-distance sort. The
  // WHERE clause above already guarantees loc_lat/loc_lon/geo_precision are
  // non-null for every row reaching here, so distance_km is always a real
  // number (never fabricated for an ungeocoded row).
  let withDistance = hydrated.map((e) => ({
    ...e,
    distance_km: Math.round(haversineDistanceKm(originLat, originLng, e.loc_lat as number, e.loc_lon as number) * 10) / 10,
  }));
  if (typeof f.radius_km === "number") {
    const radiusKm = f.radius_km;
    withDistance = withDistance.filter((e) => e.distance_km <= radiusKm);
  }
  withDistance.sort((a, b) => a.distance_km - b.distance_km);
  return withDistance.slice(0, Math.max(1, Math.min(100, limit)));
}

// ─── Zero-hit graceful degradation (dev-request 2026-07-04-opplevagent-nl-
// parser-og-fylkesnormalisering, item 3) ─────────────────────────────────
// An agent asking a place/season/weather question should never get a bare
// "no results" when the DB has hundreds of publishable rows — the query was
// almost certainly over-constrained. On zero hits we relax filters one at a
// time, weakest/most-peripheral constraint first, until results appear.
// Location is the user's core intent, so fylke/kommune are relaxed last.
const RELAX_ORDER: Array<keyof DiscoverFilter> = [
  "duration_max",
  "max_price",
  "language",
  "group_size",
  "age",
  "weather",
  "season",
  "indoor_outdoor",
  "category",
  "kommune",
  "fylke",
];

const FILTER_LABELS: Record<keyof DiscoverFilter, string> = {
  fylke: "fylke",
  kommune: "kommune",
  category: "kategori",
  indoor_outdoor: "innendørs/utendørs",
  weather: "vær",
  season: "sesong",
  group_size: "gruppestørrelse",
  age: "aldersgrense",
  max_price: "maks pris",
  duration_max: "maks varighet",
  language: "språk",
  lat: "breddegrad",
  lng: "lengdegrad",
  radius_km: "søkeradius",
  sort: "sortering",
};

export interface RelaxedDiscoverResult {
  results: Array<Experience & { id: string; tags: ExperienceTag[]; distance_km?: number }>;
  originalFilter: DiscoverFilter;
  appliedFilter: DiscoverFilter;
  relaxedKeys: Array<keyof DiscoverFilter>;
}

/**
 * discoverExperiences(), but on zero hits progressively drops filters
 * (weakest first, per RELAX_ORDER) and retries until results appear or every
 * filter is exhausted. Always returns whichever result set it landed on,
 * plus which keys were dropped so the caller can surface a relaxation note.
 */
export function discoverExperiencesRelaxed(
  filter: DiscoverFilter = {},
  limit = 20
): RelaxedDiscoverResult {
  const original = DiscoverFilterSchema.parse(filter);
  let results = discoverExperiences(original, limit);
  if (results.length > 0) {
    return { results, originalFilter: original, appliedFilter: original, relaxedKeys: [] };
  }

  const working: DiscoverFilter = { ...original };
  const relaxedKeys: Array<keyof DiscoverFilter> = [];
  for (const key of RELAX_ORDER) {
    if (working[key] === undefined) continue;
    delete working[key];
    relaxedKeys.push(key);
    results = discoverExperiences(working, limit);
    if (results.length > 0) break;
  }
  return { results, originalFilter: original, appliedFilter: working, relaxedKeys };
}

/** Bilingual note describing which filters were relaxed to produce results. Null if none were. */
export function buildRelaxationNote(relaxedKeys: Array<keyof DiscoverFilter>): string | null {
  if (relaxedKeys.length === 0) return null;
  const labels = relaxedKeys.map((k) => FILTER_LABELS[k]).join(", ");
  return (
    `Ingen treff med de opprinnelige filtrene — løsnet: ${labels}. / ` +
    `No matches with the original filters — relaxed: ${labels}.`
  );
}

/**
 * 2-3 bilingual suggestions for narrowing back down from a relaxed result
 * set, derived from what the relaxed results actually contain (so every
 * suggestion is guaranteed to return >0 hits if reapplied).
 */
export function buildNarrowingSuggestions(
  results: Array<Pick<Experience, "category" | "kommune" | "fylke">>,
  relaxedKeys: Array<keyof DiscoverFilter>,
  limit = 3
): string[] {
  if (relaxedKeys.length === 0) return [];
  const suggestions: string[] = [];
  const distinct = (vals: Array<string | null | undefined>) =>
    Array.from(new Set(vals.filter((v): v is string => !!v)));

  if (relaxedKeys.includes("category")) {
    for (const c of distinct(results.map((r) => r.category))) {
      if (suggestions.length >= limit) break;
      suggestions.push(`Prøv kategori=${c} / Try category=${c}`);
    }
  }
  if (suggestions.length < limit && relaxedKeys.includes("kommune")) {
    for (const k of distinct(results.map((r) => r.kommune))) {
      if (suggestions.length >= limit) break;
      suggestions.push(`Prøv kommune=${k} / Try kommune=${k}`);
    }
  }
  if (suggestions.length < limit && relaxedKeys.includes("fylke")) {
    for (const f of distinct(results.map((r) => r.fylke))) {
      if (suggestions.length >= limit) break;
      suggestions.push(`Prøv fylke=${f} / Try fylke=${f}`);
    }
  }
  if (suggestions.length === 0 && results.length > 0) {
    suggestions.push(
      "Prøv et bredere søk uten pris-, varighets- eller gruppestørrelsesbegrensning. / " +
        "Try a broader search without price, duration, or group-size limits."
    );
  }
  return suggestions.slice(0, limit);
}

export function listCategories(): Array<{ category: string; count: number }> {
  const db = getDb(VERTICAL);
  return db.prepare(`
    SELECT category, COUNT(*) as count FROM experiences
    WHERE category IS NOT NULL AND verification_status = 'verified' AND canonical_id IS NULL
    GROUP BY category ORDER BY count DESC
  `).all() as Array<{ category: string; count: number }>;
}

// ─── Dedup: slug-redirect helper + re-harvest guard (dev-request 2026-07-04-
// opplevagent-dedup-og-norske-titler, item 1) ───────────────────────────────

// Max hops to walk a canonical_id redirect chain before bailing out. A
// re-run of the dedup backfill can re-pick a new, richer canonical for a
// group, leaving an older duplicate row's canonical_id pointing at a row
// that has ITSELF since been merged away (i.e. that row now also has a
// non-null canonical_id, pointing at the new terminal canonical). This bound
// is purely a cycle/corruption guard — legitimate chains should never come
// close to it — so we never infinite-loop even if data is ever corrupt/cyclic.
const MAX_CANONICAL_CHAIN_HOPS = 10;

/**
 * If `slug` belongs to a row that has since been merged away as a duplicate
 * (canonical_id set), resolve the LIVE slug of its canonical row — so the
 * /opplevelse/:slug route can 301 to it instead of 404ing on a stale
 * bookmarked/indexed URL for a row the dedup pass folded into another row.
 *
 * Walks the canonical_id chain until it reaches a row with canonical_id IS
 * NULL (the true terminal canonical) — a single hop isn't enough because a
 * later, idempotent re-run of the backfill can re-pick a new canonical for a
 * group, leaving an older duplicate pointed at a row that has itself since
 * been merged into a different, newer canonical. Bounded by
 * MAX_CANONICAL_CHAIN_HOPS so a corrupt/cyclic chain can't infinite-loop —
 * if the bound is hit, returns the last-known slug on the chain rather than
 * looping forever.
 *
 * Returns null when the slug doesn't exist, isn't a duplicate, or its
 * canonical row is missing/has no slug of its own.
 */
export function resolveCanonicalSlugForDuplicate(slug: string): string | null {
  if (!slug) return null;
  const db = getDb(VERTICAL);
  const row = db
    .prepare("SELECT canonical_id FROM experiences WHERE slug = ?")
    .get(slug) as { canonical_id: string | null } | undefined;
  if (!row || !row.canonical_id) return null;

  const getById = db.prepare("SELECT id, slug, canonical_id FROM experiences WHERE id = ?");
  const visited = new Set<string>();
  let currentId = row.canonical_id;
  let lastResolved: { id: string; slug: string | null; canonical_id: string | null } | undefined;

  for (let hop = 0; hop < MAX_CANONICAL_CHAIN_HOPS; hop++) {
    if (visited.has(currentId)) break; // cycle guard — bail to the last-known id
    visited.add(currentId);
    const next = getById.get(currentId) as
      | { id: string; slug: string | null; canonical_id: string | null }
      | undefined;
    if (!next) break; // dangling reference — bail to the last-known resolved row
    lastResolved = next;
    if (!next.canonical_id) break; // reached the true terminal canonical
    currentId = next.canonical_id;
  }

  return lastResolved?.slug ?? null;
}

/**
 * Re-harvest guard, store-level wrapper: find an existing (unmerged)
 * experience that a not-yet-inserted harvest candidate would form a duplicate
 * group with (same provider identity + kommune + fuzzy title). Used by
 * bulkInsertExperiences() and the /admin/bulk-load route so a re-harvest of
 * an already-known experience never resurrects a duplicate that was already
 * merged away.
 */
export function findExistingExperienceMatch(candidate: {
  provider_id?: string | null;
  title: string;
  kommune?: string | null;
}): DedupCandidateRow | null {
  const db = getDb(VERTICAL);
  return findExistingCandidateMatch(db, candidate);
}

// ─── Bulk insert (Phase A harvest ingest) ───────────────────────────
export type HarvestRow = Partial<Experience> & { title: string };

export function bulkInsertExperiences(
  rows: HarvestRow[]
): { inserted: number; skipped: number; updated: number } {
  const db = getDb(VERTICAL);
  let inserted = 0, skipped = 0, updated = 0;
  const tx = db.transaction((batch: HarvestRow[]) => {
    for (const row of batch) {
      if (!row.title) { skipped++; continue; }
      try {
        // Re-harvest guard: never insert a brand-new row that duplicates an
        // existing (unmerged) experience — same provider + kommune + fuzzy
        // title. If the existing row already has equal-or-better data, skip;
        // otherwise fill its blanks from this candidate (never overwrite,
        // never resurrect a row already merged away).
        const match = findExistingCandidateMatch(db, {
          provider_id: row.provider_id ?? null,
          title: row.title,
          kommune: row.kommune ?? null,
        });
        if (match) {
          const candidateScore = scoreExperienceRichness(row as ExperienceRichnessInput);
          const existingScore = scoreExperienceRichness(match);
          if (candidateScore > existingScore) {
            applyExperienceContent(match.id, {
              description: row.description ?? null,
              category: row.category ?? null,
              subcategory: row.subcategory ?? null,
              activity_tags: row.activity_tags ?? null,
              season: row.season ?? null,
              indoor_outdoor: row.indoor_outdoor ?? null,
              duration_min: row.duration_min ?? null,
              price_from: row.price_from ?? null,
              booking_url: row.booking_url ?? null,
            });
            updated++;
          } else {
            skipped++;
          }
          continue;
        }
        createExperience(row as Experience);
        inserted++;
      } catch {
        skipped++;
      }
    }
  });
  tx(rows);
  return { inserted, skipped, updated };
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

export type ContentRefreshTarget = {
  id: string;
  navn: string;
  hjemmeside: string;
};

/**
 * Auto-select providers eligible for a homepage content-refresh: providers that
 * HAVE a website (hjemmeside) AND own ≥1 experience whose content is THIN
 * (description empty OR category empty) and NOT locked (not verified, not
 * manual/claim-sourced). Ordered oldest-attempted first (last_content_attempt_at
 * NULLs first) so a sweep makes progress. Deliberately keys off
 * last_content_attempt_at (stamped on every attempt, success or failure) rather
 * than last_enriched_at (stamped only on a successful write) — a provider whose
 * homepage is permanently unreachable never succeeds, so ordering by
 * last_enriched_at alone would leave it NULL/first forever, crowding out every
 * other candidate once the eligible pool exceeds `limit` (2026-07-05,
 * controller-handoff/2026-07-05-experiences-enrichment-content-refresh-
 * aggregator-1.md). Capped by `limit`.
 */
export function selectProvidersForContentRefresh(limit = 25): ContentRefreshTarget[] {
  const db = getDb(VERTICAL);
  const cap = Math.max(1, Math.min(100, limit));
  const rows = db
    .prepare(
      `SELECT p.id AS id, p.navn AS navn,
              COALESCE(
                CASE WHEN p.hjemmeside IS NOT NULL AND TRIM(p.hjemmeside) != ''
                     THEN TRIM(p.hjemmeside) END,
                (SELECT TRIM(e2.evidence_url)
                   FROM experiences e2
                  WHERE e2.provider_id = p.id
                    AND e2.evidence_url IS NOT NULL AND TRIM(e2.evidence_url) != ''
                  LIMIT 1)
              ) AS hjemmeside
         FROM experience_providers p
        WHERE (
            (p.hjemmeside IS NOT NULL AND TRIM(p.hjemmeside) != '')
            OR EXISTS (
                SELECT 1 FROM experiences e2
                 WHERE e2.provider_id = p.id
                   AND e2.evidence_url IS NOT NULL AND TRIM(e2.evidence_url) != ''
                   AND p.hjemmeside IS NULL
               )
          )
          AND EXISTS (
            SELECT 1 FROM experiences e
             WHERE e.provider_id = p.id
               AND e.verification_status != 'verified'
               AND (e.content_source IS NULL OR e.content_source NOT IN ('manual','claim'))
               AND (
                     e.description IS NULL OR TRIM(e.description) = ''
                  OR e.category    IS NULL OR TRIM(e.category)    = ''
                   )
          )
        ORDER BY (p.last_content_attempt_at IS NOT NULL), p.last_content_attempt_at ASC, p.created_at ASC
        LIMIT ?`
    )
    .all(cap) as Array<{ id: string; navn: string; hjemmeside: string }>;
  return rows.filter((r) => r.hjemmeside && r.hjemmeside.trim().length > 0);
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
    return s === "" || s === "null" || s === "[]";
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

/** Stamp that a content-refresh ATTEMPT happened for this provider, regardless
 * of outcome (success or failure). Deliberately does NOT touch
 * enrichment_state/last_enriched_at — those mean "successfully enriched"; this
 * means "we tried", so a provider whose homepage is permanently unreachable
 * still cycles to the back of selectProvidersForContentRefresh()'s queue
 * instead of sorting first on every run forever. Best-effort. */
export function markProviderContentAttempted(providerId: string): boolean {
  const db = getDb(VERTICAL);
  const res = db
    .prepare(
      `UPDATE experience_providers
          SET last_content_attempt_at = datetime('now')
        WHERE id = ?`
    )
    .run(providerId);
  return res.changes > 0;
}

// ─── Gårdssalg feature flag ──────────────────────────────────────────────────
// Count providers eligible for the Gårdssalg & smaking category: those with
// producer_type set (seeded or enriched drikkeprodusenter) OR rfb_seed_source =
// 'rfb-seed'. Used by the SSR feature flag (gardssalgVisible()) to decide
// whether to surface /kategori/gardssalg in nav, homepage cards, and sitemap.
// Threshold: ≥5 providers → category becomes visible. Phase 1 (2026-06-28).
// Query hits experience_providers only — no join, very fast.
export function countGardssalgProviders(): number {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      "SELECT COUNT(*) AS c FROM experience_providers " +
      "WHERE producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed'"
    )
    .get() as { c: number };
  return row.c;
}

export type GardssalgProviderRow = {
  id: string;
  navn: string;
  hjemmeside: string | null;
  fylke: string | null;
  kommune: string | null;
  poststed: string | null;
  producer_type: string | null;
  enrichment_state: string | null;
  slug: string | null;
  // Additive (2026-07-03, gårdssalg profile-page slice): geo + address + contact,
  // already columns on experience_providers (see init-experiences.ts) but not
  // previously selected here. Read by the /kategori/gardssalg/produsent/<slug>
  // profile page for its map block + JSON-LD `geo`/`address` + practical info.
  // Most rows have these NULL until enrichment runs — every consumer must be
  // null-safe (same discipline as lat/lon on the `experiences` table).
  adresse: string | null;
  lat: number | null;
  lon: number | null;
  epost: string | null;
  telefon: string | null;
};

const GARDSSALG_PROVIDER_COLUMNS =
  "id, navn, hjemmeside, fylke, kommune, poststed, producer_type, enrichment_state, slug, adresse, lat, lon, epost, telefon";

export function listGardssalgProviders(limit = 100, offset = 0): GardssalgProviderRow[] {
  const db = getDb(VERTICAL);
  return db
    .prepare(
      `SELECT ${GARDSSALG_PROVIDER_COLUMNS}
         FROM experience_providers
        WHERE producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed'
        ORDER BY navn
        LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as GardssalgProviderRow[];
}

/** Look up a single gårdssalg provider (drink producer) by slug — for the
 *  /kategori/gardssalg/book/<slug> reservation flow and the
 *  /kategori/gardssalg/produsent/<slug> profile page. Mirrors the WHERE clause
 *  from listGardssalgProviders()/countGardssalgProviders() (producer_type set
 *  OR rfb-seed), NOT the experiences-join publish gate used by
 *  getPublishedProviderBySlug() — gårdssalg producers have zero rows in the
 *  experiences table (their product is a gårdsbesøk booking, not a listed
 *  "experience"), so the join-based gate always 404'd them. That mismatch was
 *  the root cause of the live "Book besøk" 404 bug (2026-07-02). */
export function getGardssalgProviderBySlug(slug: string): GardssalgProviderRow | null {
  if (!slug) return null;
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT ${GARDSSALG_PROVIDER_COLUMNS}
         FROM experience_providers
        WHERE slug = @slug
          AND (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')`
    )
    .get({ slug }) as GardssalgProviderRow | undefined;
  return row ?? null;
}
