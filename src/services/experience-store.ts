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
// dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach, slice 2 —
// reuse the same quality-bar predicate the homepage-content extractor already
// gates candidates with, so applyGardssalgProviderContent() can tell "thin"
// existing content from decent existing content before deciding to replace it.
import { meetsAboutQualityBar } from "./search-enrich";
import { deriveExperienceTags, type ExperienceTag, type TaggableExperience } from "./experience-tags";
import { haversineDistanceKm } from "./geocoding-service";
// dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach, slice 5b —
// reuse the SAME diacritic-fold/lowercase normaliser findOrgnumberByName's
// own name-matching already uses, for the poststed EXACT-match comparison in
// gardssalgOrgnrPostalCorroborated below (never a raw substring test — see
// that function's doc comment for why).
import { normaliseName } from "./brreg-client";
// slice 5d — reuse the curated directory/aggregator host classifier + URL→host
// parser (single source of truth, dev-request 2026-07-19-agg-website-leak).
import { isDirectoryOrAggregatorHost, hostFromUrlLike } from "./cross-source-validator";
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
  // Norwegian display title (dev-request 2026-07-04-opplevagent-dedup-og-
  // norske-titler, item 2): LLM-generated natural Norwegian title, backfilled
  // via POST /admin/experiences-title-no-backfill (routes/opplevelser.ts) —
  // never set by createExperience(). NULL means "not backfilled yet"; every
  // render path falls back to `title` when NULL.
  title_no: z.string().optional().nullable(),
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
    title_no: (row.title_no as string | null) ?? null,
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

// dev-request 2026-07-04-opplevagent-dedup-og-norske-titler, item 3 (detail
// completeness weave): surface provider phone in the single-experience API
// row the same way booking_url already is — no fabrication, null when the
// provider has none on file. Follow-up lookup via getProviderById() (defined
// below; function declarations hoist) rather than widening the experiences
// SELECT, so callers that don't need it pay no extra cost.
function providerPhoneOf(providerId: string | null | undefined): string | null {
  if (!providerId) return null;
  const provider = getProviderById(providerId);
  const raw = provider ? String(provider.telefon ?? "").trim() : "";
  return raw || null;
}

export function getExperienceById(
  id: string
): (Experience & { id: string; tags: ExperienceTag[]; phone: string | null }) | null {
  const db = getDb(VERTICAL);
  const row = db.prepare("SELECT * FROM experiences WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const hydrated = hydrateExperience(row);
  return { ...hydrated, phone: providerPhoneOf(hydrated.provider_id) };
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
//
// Exported (item 3, detail-completeness weave) so the catalog-wide
// detail-completeness-coverage admin report (opplevelser.ts) reports over
// the SAME "published" set the detail page/`/discover` actually surface,
// rather than redefining the gate a second time.
export const PUBLISH_GATE_SQL =
  "e.verification_status = 'verified' " +
  "AND (e.confidence IS NULL OR e.confidence IN ('high','medium')) " +
  "AND (p.id IS NULL OR p.brreg_active = 1) " +
  "AND e.canonical_id IS NULL";

export function getPublishedExperienceBySlug(
  slug: string
): (Experience & { id: string; tags: ExperienceTag[]; phone: string | null }) | null {
  if (!slug) return null;
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT e.* FROM experiences e
       LEFT JOIN experience_providers p ON p.id = e.provider_id
       WHERE e.slug = @slug AND ${PUBLISH_GATE_SQL}`
    )
    .get({ slug }) as Record<string, unknown> | undefined;
  if (!row) return null;
  const hydrated = hydrateExperience(row);
  return { ...hydrated, phone: providerPhoneOf(hydrated.provider_id) };
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
  // Norwegian display title (dev-request 2026-07-04-opplevagent-dedup-og-
  // norske-titler, item 2) — NULL until backfilled; render paths fall back
  // to `title` when NULL. See ExperienceSchema's title_no field for detail.
  title_no: string | null;
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
  "e.slug AS slug, e.title AS title, e.title_no AS title_no, e.description AS description, " +
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
    title_no: (row.title_no as string | null) ?? null,
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

// ─── Distance/precision label (dev-request 2026-07-04-opplevagent-naer-meg-
// geosok, item 3: «Nær meg» on /sok) ──────────────────────────────────────
// PURE — no DB access. Mirrors the geo_precision honesty rule enforced
// server-side by discoverExperiences() above: an 'address'-precision row
// (geocoded from the provider's real street address) gets an exact
// "2,4 km unna" distance; a 'kommune'-precision row (municipality-centroid
// fallback — see experiences-geocode-worker.ts Step C) NEVER claims a
// street-level distance, since none exists — it says "i <kommune> kommune"
// instead. Returns null when there's nothing honest to say (no geo_precision
// at all, i.e. the row was never geocoded / excluded from a geo search).
export function formatDistanceLabel(
  distance_km: number | null | undefined,
  geo_precision: "address" | "kommune" | null | undefined,
  kommune?: string | null
): string | null {
  if (geo_precision === "address" && typeof distance_km === "number" && Number.isFinite(distance_km)) {
    const km = distance_km.toLocaleString("nb-NO", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return `${km} km unna`;
  }
  if (geo_precision === "kommune") {
    return kommune ? `i ${kommune} kommune` : "omtrentlig posisjon (kommune)";
  }
  return null;
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

/**
 * If `slug` belongs to a row that has since been merged away as a duplicate
 * (canonical_id set), resolve the LIVE slug of its canonical row — so the
 * /opplevelse/:slug route can 301 to it instead of 404ing on a stale
 * bookmarked/indexed URL for a row the dedup pass folded into another row.
 * Returns null when the slug doesn't exist, isn't a duplicate, or its
 * canonical row is missing/has no slug of its own.
 *
 * dev-request 2026-07-11-dedup-false-positive-remediation: canonical_id can
 * CHAIN — a row's canonical target may itself have been merged away by a
 * later pass (A→B→C) — so walk hops until the TERMINAL row (canonical_id IS
 * NULL) instead of stopping after one. A visited set guards against a cyclic
 * chain (bad data must 404, not hang the request); on a cycle this returns
 * null. The 0-hop and 1-hop cases behave exactly as before.
 */
export function resolveCanonicalSlugForDuplicate(slug: string): string | null {
  if (!slug) return null;
  const db = getDb(VERTICAL);
  const row = db
    .prepare("SELECT id, canonical_id FROM experiences WHERE slug = ?")
    .get(slug) as { id: string; canonical_id: string | null } | undefined;
  if (!row || !row.canonical_id) return null;
  const getById = db.prepare("SELECT slug, canonical_id FROM experiences WHERE id = ?");
  const visited = new Set<string>([row.id]);
  let currentId: string = row.canonical_id;
  for (;;) {
    if (visited.has(currentId)) return null; // cycle — no terminal row exists
    visited.add(currentId);
    const current = getById.get(currentId) as
      | { slug: string | null; canonical_id: string | null }
      | undefined;
    if (!current) return null; // dangling canonical_id
    if (!current.canonical_id) return current.slug ?? null; // terminal row
    currentId = current.canonical_id;
  }
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
  title_no?: string | null;
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
          title_no: row.title_no ?? null,
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
// ── Dead-homepage parking (enrichment-metode slice 1, 2026-07-16) ────────────
// Mirrors the RFB PR #248 semantics exactly: 3 consecutive fetch failures park
// the provider (homepage_unreachable_since stamped) for 30 days; a successful
// fetch fully resets. RE-STAMP on failure after an expired backoff — without it
// a stale timestamp keeps satisfying the `<= now-30d` exclusion forever and a
// still-dead provider reverts to being selected every run (PR #248 review
// blocker, inherited here). Env EXPERIENCES_HOMEPAGE_PARKING_DISABLED=true
// bypasses the selector exclusion (rollback flag, read per query).
export const PROVIDER_PARK_AFTER_ATTEMPTS = 3;
export const PROVIDER_PARK_BACKOFF_MS = 30 * 86_400_000;

export function providerParkingExclusionSql(alias = ""): string {
  if (process.env.EXPERIENCES_HOMEPAGE_PARKING_DISABLED === "true") return "";
  const col = alias ? `${alias}.homepage_unreachable_since` : "homepage_unreachable_since";
  return `AND (${col} IS NULL OR ${col} <= datetime('now','-30 days'))`;
}

// ── Content-refresh no-yield backoff (dev-request 2026-07-20-experiences-
// no-yield-backoff) ───────────────────────────────────────────────────────
// Ports marketplace.ts's no_yield_streak idea to this vertical: a provider
// whose homepage fetch succeeds but yields zero extractable fields 3 times
// running rests NO_YIELD_BACKOFF_DAYS days (default 14, env-configurable,
// parsed defensively the same way marketplace.ts parses it) before being
// reselected; a single subsequent successful field-write resets
// content_no_yield_streak to 0, which alone clears the exclusion. Distinct
// from providerParkingExclusionSql above, which guards fetch FAILURES
// (homepage_unreachable_since) — this guards fetches that SUCCEED but
// extract nothing. Reuses last_content_attempt_at as the backoff clock (no
// new timestamp column).
export function noYieldBackoffExclusionSql(alias = ""): string {
  const col = alias ? `${alias}.content_no_yield_streak` : "content_no_yield_streak";
  const attemptCol = alias ? `${alias}.last_content_attempt_at` : "last_content_attempt_at";
  const noYieldBackoffDays = Math.max(
    1,
    parseInt(String(process.env.NO_YIELD_BACKOFF_DAYS ?? "14"), 10) || 14,
  );
  return (
    `AND (${col} < 3 ` +
    `OR ${attemptCol} IS NULL ` +
    `OR ${attemptCol} <= datetime('now','-${noYieldBackoffDays} days'))`
  );
}

/**
 * Record whether a content-refresh attempt yielded any extractable/writable
 * field for this provider. `yielded=false` increments content_no_yield_streak
 * (3 consecutive no-yield outcomes trigger the NO_YIELD_BACKOFF_DAYS rest
 * period enforced by noYieldBackoffExclusionSql, above); `yielded=true`
 * resets the streak to 0. Mirrors the shape of recordProviderHomepageFetchResult/
 * markProviderContentAttempted (providerId in, best-effort UPDATE). Best-effort;
 * returns true if a row changed.
 */
export function recordProviderContentYield(providerId: string, yielded: boolean): boolean {
  const db = getDb(VERTICAL);
  const res = db
    .prepare(
      yielded
        ? `UPDATE experience_providers SET content_no_yield_streak = 0 WHERE id = ?`
        : `UPDATE experience_providers SET content_no_yield_streak = content_no_yield_streak + 1 WHERE id = ?`
    )
    .run(providerId);
  return res.changes > 0;
}

export function recordProviderHomepageFetchResult(
  providerId: string,
  ok: boolean,
): { found: boolean; attempts: number; parked: boolean; parked_now: boolean } {
  const db = getDb(VERTICAL);
  const exists = db.prepare("SELECT id FROM experience_providers WHERE id = ?").get(providerId);
  if (!exists) return { found: false, attempts: 0, parked: false, parked_now: false };

  if (ok) {
    db.prepare(
      "UPDATE experience_providers SET homepage_fetch_attempts = 0, homepage_unreachable_since = NULL WHERE id = ?"
    ).run(providerId);
    return { found: true, attempts: 0, parked: false, parked_now: false };
  }

  db.prepare(
    "UPDATE experience_providers SET homepage_fetch_attempts = homepage_fetch_attempts + 1 WHERE id = ?"
  ).run(providerId);
  const row = db
    .prepare("SELECT homepage_fetch_attempts, homepage_unreachable_since FROM experience_providers WHERE id = ?")
    .get(providerId) as { homepage_fetch_attempts: number; homepage_unreachable_since: string | null };

  let parkedNow = false;
  if (row.homepage_fetch_attempts >= PROVIDER_PARK_AFTER_ATTEMPTS) {
    const since = row.homepage_unreachable_since;
    const expired = since !== null && Date.parse(since) <= Date.now() - PROVIDER_PARK_BACKOFF_MS;
    if (!since || expired) {
      db.prepare("UPDATE experience_providers SET homepage_unreachable_since = ? WHERE id = ?")
        .run(new Date().toISOString(), providerId);
      parkedNow = true;
    }
  }
  const parked = row.homepage_fetch_attempts >= PROVIDER_PARK_AFTER_ATTEMPTS;
  return { found: true, attempts: row.homepage_fetch_attempts, parked, parked_now: parkedNow };
}

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
          ${providerParkingExclusionSql("p")}
          ${noYieldBackoffExclusionSql("p")}
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
      // Parens are load-bearing: without them the trailing AND would bind
      // tighter than the OR and change the set. catalog_hidden=1 rows (the
      // hidden booking-flyt-v1 test provider) never bump the count that gates
      // gardssalgVisible() (dev-request 2026-07-14-booking-flyt-v1, slice 0).
      "WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed') " +
      "AND (catalog_hidden IS NULL OR catalog_hidden != 1)"
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
  // Additive (2026-07-12, gardssalg-go-live-gate slice 3): tags lat/lon's
  // precision. 'approximate' = experiences-geocode-worker.ts Step D's
  // kommune/fylke-centroid fallback (no street-level address resolved);
  // 'high'/'medium'/'low' = Step A's real address-level Kartverket geocode;
  // null = not geocoded yet. Read by the produsent-profil map block so it
  // never claims exact-address precision it doesn't have.
  geocode_confidence: string | null;
  epost: string | null;
  telefon: string | null;
  // Additive (2026-07-10, gårdssalg multi-page-crawl content-enrichment
  // slice, Fase 1 item 3 of the rike-profiler dev-request): real per-producer
  // "Om produsenten"/"Besøket"/opening-hours copy, filled by
  // POST /admin/gardssalg-content-refresh. NULL until enrichment runs — every
  // consumer (the produsent profile route) must be null-safe and keep
  // rendering its existing honest-omission fallback until then.
  about_text: string | null;
  visit_text: string | null;
  opening_hours_text: string | null;
  // Additive (2026-07-12, gårdssalg RFB-enrichment slice): JSON array of the
  // producer's drink products (["Eplesider",…]). NULL until enrichment fills it.
  products: string | null;
  // Additive (2026-07-12, dev-request 2026-07-12-gardssalg-dark-launch-stop,
  // slice 0): per-provider booking gate — 0/NULL until a future onboarding
  // slice flips a given producer to 1. Read together with the
  // BOOKING_DISPATCH_ENABLED env flag (see isBookingPaused() in
  // services/booking-store.ts) by the booking panel, produsent profile, and
  // category-card "coming soon" notices, and by the booking submission gate
  // in routes/opplevelser.ts + routes/experiences-seo.ts.
  booking_live: number | null;
  // Additive (2026-07-14, dev-request 2026-07-14-booking-flyt-v1, slice 0):
  // hidden-from-catalog flag. 1 = kept out of the public gårdssalg grid + count
  // (listGardssalgProviders()/countGardssalgProviders() filter it) but STILL
  // bookable by slug (getGardssalgProviderBySlug() deliberately does not filter)
  // — the mechanism behind the controlled end-to-end booking test. 0/NULL =
  // today's behavior (visible). Only the admin test-provider endpoint sets it 1.
  catalog_hidden: number | null;
};

const GARDSSALG_PROVIDER_COLUMNS =
  "id, navn, hjemmeside, fylke, kommune, poststed, producer_type, enrichment_state, slug, adresse, lat, lon, geocode_confidence, epost, telefon, about_text, visit_text, opening_hours_text, products, booking_live, catalog_hidden";

export function listGardssalgProviders(limit = 100, offset = 0): GardssalgProviderRow[] {
  const db = getDb(VERTICAL);
  return db
    .prepare(
      // catalog_hidden=1 rows (the hidden booking-flyt-v1 test provider) are
      // filtered out of the public grid; they stay bookable only via
      // getGardssalgProviderBySlug() below. Parens around the OR are
      // load-bearing (dev-request 2026-07-14-booking-flyt-v1, slice 0).
      `SELECT ${GARDSSALG_PROVIDER_COLUMNS}
         FROM experience_providers
        WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
          AND (catalog_hidden IS NULL OR catalog_hidden != 1)
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

// ─── Gårdssalg content-refresh (dev-request 2026-07-03-gardssalg-rike-
//     profiler-bilder-agentbooking, Fase 1 item 3, 2026-07-10) ──────────────
//
// The multi-page-crawl twin of selectProvidersForContentRefresh() /
// getProviderContentTarget() / applyExperienceContent() above, but writing
// directly onto experience_providers (about_text/visit_text/
// opening_hours_text) instead of the experiences table — gårdssalg producers
// have zero rows in `experiences` (their product is a gårdsbesøk booking, not
// a listed "experience"; see getGardssalgProviderBySlug's doc comment above).
// Reuses markProviderContentAttempted() as-is for attempt tracking (same
// last_content_attempt_at column, same "cycle to the back of the queue on any
// outcome" discipline). LOCK convention mirrors the experiences table exactly
// (see isExperienceContentLocked above): content_source 'manual'/'claim' is
// human/owner-authored and NEVER auto-overwritten by this crawl.

export type GardssalgContentRefreshTarget = {
  id: string;
  navn: string;
  hjemmeside: string;
  content_source: string | null;
  about_text: string | null;
  visit_text: string | null;
  opening_hours_text: string | null;
  // dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach, slice 5c —
  // raw JSON-array-of-strings column (see init-experiences.ts), read here so
  // the content-refresh route can gate the products-extraction path on
  // gardssalgProductsEligible() without a second query.
  products: string | null;
};

/**
 * Auto-select gårdssalg providers eligible for a content-refresh: gårdssalg
 * providers (producer_type set OR rfb-seed) WITH a website, NOT locked
 * (content_source not in manual/claim), and THIN on at least one of
 * about_text/visit_text/opening_hours_text. Ordered oldest-attempted first
 * (last_content_attempt_at NULLs first, same discipline as
 * selectProvidersForContentRefresh — see that function's doc comment for why
 * last_content_attempt_at rather than a success-only timestamp drives
 * ordering). Hard-capped at 48 — there are only 48 gårdssalg providers total.
 */
export function selectGardssalgProvidersForContentRefresh(limit = 25): GardssalgContentRefreshTarget[] {
  const db = getDb(VERTICAL);
  const cap = Math.max(1, Math.min(48, limit));
  return db
    .prepare(
      `SELECT id, navn, TRIM(hjemmeside) AS hjemmeside, content_source,
              about_text, visit_text, opening_hours_text, products
         FROM experience_providers
        WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
          AND hjemmeside IS NOT NULL AND TRIM(hjemmeside) != ''
          AND (content_source IS NULL OR content_source NOT IN ('manual','claim'))
          AND (
                about_text IS NULL OR TRIM(about_text) = ''
             OR visit_text IS NULL OR TRIM(visit_text) = ''
             OR opening_hours_text IS NULL OR TRIM(opening_hours_text) = ''
             OR products IS NULL OR TRIM(products) = '' OR TRIM(products) = '[]'
              )
          ${providerParkingExclusionSql()}
        ORDER BY (last_content_attempt_at IS NOT NULL), last_content_attempt_at ASC, created_at ASC
        LIMIT ?`
    )
    .all(cap) as GardssalgContentRefreshTarget[];
}

/**
 * Resolve an explicit providerId for the gårdssalg content-refresh's
 * `providerIds` override. Scoped to the gårdssalg WHERE clause (producer_type
 * set OR rfb-seed) — NOT the thin/lock filters above, so an admin can force a
 * refresh of a provider that isn't currently "eligible" by the auto-select
 * query (mirrors getProviderContentTarget's override semantics). Returns null
 * when the provider doesn't exist, isn't a gårdssalg provider, or has no
 * usable website.
 */
export function getGardssalgProviderContentTarget(providerId: string): GardssalgContentRefreshTarget | null {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT id, navn, TRIM(hjemmeside) AS hjemmeside, content_source,
              about_text, visit_text, opening_hours_text, products
         FROM experience_providers
        WHERE id = ?
          AND (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')`
    )
    .get(providerId) as GardssalgContentRefreshTarget | undefined;
  if (!row || !row.hjemmeside || row.hjemmeside.trim().length === 0) return null;
  return row;
}

/**
 * Decide what applyGardssalgProviderContent() would do for ONE about_text/
 * visit_text field, given the row's current (pre-write) value and a raw
 * candidate value. Shared between the writer itself and the gårdssalg
 * content-refresh route's dry-run projection so the preview can never drift
 * from the real write path. NOT used for opening_hours_text, which keeps the
 * old fill-only-blank rule (structured/short by nature, not prose-quality-
 * gated). Returns:
 *   "filled"   — current value is blank and the candidate has content
 *                (the original, unchanged behavior).
 *   "replaced" — current value is non-blank but THIN (fails
 *                meetsAboutQualityBar), the candidate itself passes the
 *                quality bar, AND the candidate is strictly longer than the
 *                current value — so a replace never swaps thin-but-real
 *                content for something equally or less substantial.
 *   null       — no write: current value already meets the quality bar
 *                (never churned), or the candidate doesn't qualify.
 */
export function gardssalgReplaceableFieldAction(
  currentValue: string | null | undefined,
  candidateValue: string | null | undefined
): "filled" | "replaced" | null {
  const candidate = candidateValue?.trim();
  if (!candidate) return null;
  const isCurrentBlank = currentValue === null || currentValue === undefined || String(currentValue).trim() === "";
  if (isCurrentBlank) return "filled";
  if (meetsAboutQualityBar(currentValue)) return null; // decent existing content — never churned
  if (!meetsAboutQualityBar(candidate)) return null; // candidate itself thin — can't replace thin with thin
  const currentTrimmed = String(currentValue).trim();
  if (!(candidate.length > currentTrimmed.length)) return null; // must be a genuine improvement in length
  return "replaced";
}

/**
 * Decide whether a gårdssalg about_text/visit_text field is eligible for the
 * source-grounded LLM REWRITE path (dev-request 2026-07-18-gardssalg-
 * profilkvalitet-foer-outreach, slice 5a) — the "passing-bar-but-short"
 * cohort that gardssalgReplaceableFieldAction() deliberately never touches
 * ("decent existing content — never churned", see its doc comment above).
 * This is a SEPARATE, ADDITIVE function — gardssalgReplaceableFieldAction()
 * itself is byte-unchanged by this slice, and neither function calls the
 * other.
 *
 * Returns true only when ALL of:
 *   - currentValue is non-blank,
 *   - currentValue passes meetsAboutQualityBar (>=80 chars, not boilerplate/
 *     nav-leakage/mangled/wrong-entity — i.e. the value
 *     gardssalgReplaceableFieldAction itself would refuse to ever churn),
 *   - currentValue.trim().length < 200 (still genuinely thin by this
 *     rewrite slice's own, stricter 200-char bar).
 *
 * A field already >=200 chars is never eligible — this is what makes a
 * second run idempotent with no extra state/flag: once a field is rewritten
 * (the LLM helper's code-enforced 200-500 char output range guarantees
 * >=200), it drops out of the eligible set on its own.
 */
export function gardssalgRewriteEligible(currentValue: string | null | undefined): boolean {
  if (currentValue === null || currentValue === undefined) return false;
  const trimmed = String(currentValue).trim();
  if (!trimmed) return false;
  if (!meetsAboutQualityBar(trimmed)) return false;
  return trimmed.length < 200;
}

/**
 * Eligibility gate for the gårdssalg "products" (JSON array of drink/product
 * names) FILL-ONLY extraction (dev-request 2026-07-18-gardssalg-
 * profilkvalitet-foer-outreach, slice 5c). Unlike about_text/visit_text,
 * `products` has no replace-thin-content concept — any existing non-empty
 * list (however short) was either written by the RFB-knowledge copy path
 * (2026-07-12) or a prior run of this same extraction, and is left
 * untouched; this only ever fills a currently-blank/empty column.
 *
 * Returns true when currentProducts is null/undefined, blank/whitespace, the
 * literal "[]", or parses as a JSON array with zero elements. A value that
 * fails to parse as JSON is treated as NOT eligible (conservative: an
 * unexpected non-JSON value in this column should never be silently
 * overwritten by an automated pass).
 */
export function gardssalgProductsEligible(currentProducts: string | null | undefined): boolean {
  if (currentProducts === null || currentProducts === undefined) return true;
  const trimmed = String(currentProducts).trim();
  if (trimmed === "" || trimmed === "[]") return true;
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) && parsed.length === 0;
  } catch {
    return false;
  }
}

/**
 * Apply crawled content to ONE gårdssalg provider, respecting the lock gate:
 * NEVER writes anything if the provider is locked (content_source
 * 'manual'/'claim'). For about_text/visit_text, writes a candidate field
 * when it is blank (fill) OR when the current value is thin/low-quality and
 * the candidate is a genuine, quality-bar-passing improvement (replace —
 * see gardssalgReplaceableFieldAction). opening_hours_text keeps the
 * original fill-only-blank rule unchanged. Stamps content_source=
 * 'provider_site', content_evidence_url, and content_updated_at in the SAME
 * UPDATE, but only when at least one field was actually written (a no-op
 * write stamps nothing). Returns the field names actually written.
 * Idempotent: a second run against an already-filled, non-thin provider
 * writes nothing.
 *
 * Rollback/provenance bookkeeping (dev-request 2026-07-18-gardssalg-
 * profilkvalitet-foer-outreach, slice 1) — additive, does NOT change which
 * fields get written or the guard behavior above: for every field actually
 * written, this also (in the same transaction) inserts one
 * gardssalg_content_audit row (old_value = the value immediately before this
 * write, new_value = the value just written, source_url = evidenceUrl,
 * batch_id = the optional `batchId` param) and merges a
 * {source_url, fetched_at} entry into experience_providers.field_provenance
 * for that field, preserving any existing entries for OTHER fields
 * (read-modify-write, never clobbers). old_value is read generically from
 * the row snapshot taken before any write below — since slice 2, about_text/
 * visit_text writes can be a REPLACE of real prior content, so old_value is
 * no longer always null/blank; the audit code makes no assumption either
 * way and needed no change to stay correct for that case.
 *
 * `rewriteFields` (dev-request 2026-07-18-gardssalg-profilkvalitet-foer-
 * outreach, slice 5a) — OPTIONAL, additive, empty/omitted by every pre-
 * existing call site (byte-identical behavior when not passed): names the
 * about_text/visit_text fields whose `candidate` value is an ACCEPTED LLM
 * rewrite (see generateGardssalgAboutRewrite in routes/opplevelser.ts) of a
 * field whose current value already passes meetsAboutQualityBar — i.e. a
 * field gardssalgReplaceableFieldAction() would otherwise refuse to ever
 * touch ("decent existing content — never churned"). The caller is expected
 * to have already gated this via gardssalgRewriteEligible() AND the rewrite
 * helper's own 200-500-char acceptance gate; this function does one more
 * defense-in-depth re-check (gardssalgRewriteEligible against the FRESH row
 * snapshot read below, not the caller's possibly-stale one) before writing,
 * so a field that changed between selection and write never gets silently
 * churned. For a field named here, the write bypasses
 * gardssalgReplaceableFieldAction()'s decision (which is a no-op for it
 * anyway, since eligibility requires the current value to already pass the
 * quality bar) but goes through the exact same audit-row + field_provenance
 * + lock-guard machinery as every other field.
 */
export function applyGardssalgProviderContent(
  providerId: string,
  candidate: {
    about_text?: string | null;
    visit_text?: string | null;
    opening_hours_text?: string | null;
    // dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach, slice 5c
    // — OPTIONAL, additive, omitted by every pre-existing call site (byte-
    // identical behavior when not passed). A non-empty array of already-
    // validated (never-fabricated, length/count-capped — see
    // generateGardssalgProductList in routes/opplevelser.ts) product name
    // strings, FILL-ONLY (see gardssalgProductsEligible's doc comment: no
    // replace-thin-content path for this field, unlike about_text/visit_text).
    products?: string[] | null;
  },
  evidenceUrl: string,
  batchId?: string,
  rewriteFields?: Array<"about_text" | "visit_text">
): string[] {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT id, content_source, about_text, visit_text, opening_hours_text, products, field_provenance
         FROM experience_providers WHERE id = ?`
    )
    .get(providerId) as
    | {
        id: string;
        content_source: string | null;
        about_text: string | null;
        visit_text: string | null;
        opening_hours_text: string | null;
        products: string | null;
        field_provenance: string | null;
      }
    | undefined;
  if (!row) return [];
  if (row.content_source === "manual" || row.content_source === "claim") return [];

  function isBlank(v: unknown): boolean {
    return v === null || v === undefined || String(v).trim() === "";
  }

  const sets: string[] = [];
  const params: Record<string, unknown> = { id: providerId };
  const written: string[] = [];
  // Pre-write snapshot of every rollback-eligible field, keyed by field name —
  // captured BEFORE any write below, so the audit trail's old_value is always
  // the true pre-write value regardless of which fields end up written.
  const oldValues: Record<string, string | null> = {
    about_text: row.about_text,
    visit_text: row.visit_text,
    opening_hours_text: row.opening_hours_text,
    products: row.products,
  };

  // Slice 5a: accepted-rewrite fields, re-validated against the FRESH row
  // snapshot (not the caller's possibly-stale target snapshot) — see this
  // function's doc comment. Naturally mutually exclusive with the
  // gardssalgReplaceableFieldAction branch below: eligibility requires the
  // current value to already pass meetsAboutQualityBar, for which
  // gardssalgReplaceableFieldAction always returns null ("never churned").
  const rewriteSet = new Set(rewriteFields ?? []);

  if (rewriteSet.has("about_text") && candidate.about_text?.trim() && gardssalgRewriteEligible(row.about_text)) {
    sets.push("about_text = @about_text");
    params.about_text = candidate.about_text.trim();
    written.push("about_text");
  } else if (gardssalgReplaceableFieldAction(row.about_text, candidate.about_text)) {
    sets.push("about_text = @about_text");
    params.about_text = candidate.about_text!.trim();
    written.push("about_text");
  }
  if (rewriteSet.has("visit_text") && candidate.visit_text?.trim() && gardssalgRewriteEligible(row.visit_text)) {
    sets.push("visit_text = @visit_text");
    params.visit_text = candidate.visit_text.trim();
    written.push("visit_text");
  } else if (gardssalgReplaceableFieldAction(row.visit_text, candidate.visit_text)) {
    sets.push("visit_text = @visit_text");
    params.visit_text = candidate.visit_text!.trim();
    written.push("visit_text");
  }
  if (isBlank(row.opening_hours_text) && candidate.opening_hours_text?.trim()) {
    sets.push("opening_hours_text = @opening_hours_text");
    params.opening_hours_text = candidate.opening_hours_text.trim();
    written.push("opening_hours_text");
  }
  // Slice 5c — fill-only, re-checked against the FRESH row snapshot (not the
  // caller's possibly-stale target snapshot), same defense-in-depth
  // discipline as the rewriteFields re-check above.
  if (candidate.products && candidate.products.length > 0 && gardssalgProductsEligible(row.products)) {
    sets.push("products = @products");
    params.products = JSON.stringify(candidate.products);
    written.push("products");
  }

  if (sets.length === 0) return [];

  sets.push("content_source = 'provider_site'");
  sets.push("content_evidence_url = @evidence_url");
  sets.push("content_updated_at = datetime('now')");
  params.evidence_url = evidenceUrl;

  // ── field_provenance merge (read-modify-write, preserves other fields) ──
  let provenance: Record<string, { source_url: string; fetched_at: string }> = {};
  if (row.field_provenance) {
    try {
      const parsed = JSON.parse(row.field_provenance);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        provenance = parsed as Record<string, { source_url: string; fetched_at: string }>;
      }
    } catch {
      /* malformed existing JSON -> treat as empty rather than clobber the write */
    }
  }
  const fetchedAt = new Date().toISOString();
  for (const f of written) {
    provenance[f] = { source_url: evidenceUrl, fetched_at: fetchedAt };
  }
  sets.push("field_provenance = @field_provenance");
  params.field_provenance = JSON.stringify(provenance);

  const applyWithAudit = db.transaction(() => {
    db.prepare(`UPDATE experience_providers SET ${sets.join(", ")} WHERE id = @id`).run(params);
    const insertAudit = db.prepare(
      `INSERT INTO gardssalg_content_audit
         (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
       VALUES (@id, @provider_id, @field_name, @old_value, @new_value, @source_url, @batch_id, 'system', datetime('now'))`
    );
    for (const f of written) {
      insertAudit.run({
        id: uuid(),
        provider_id: providerId,
        field_name: f,
        old_value: oldValues[f] ?? null,
        new_value: (params[f] as string | undefined) ?? null,
        source_url: evidenceUrl,
        batch_id: batchId ?? null,
      });
    }
  });
  applyWithAudit();

  return written;
}

// ─── Gårdssalg address enrichment (dev-request 2026-07-18-gardssalg-
//     profilkvalitet-foer-outreach, slice 3) ─────────────────────────────────
//
// Of the 74 gårdssalg provider profiles, only 42 have a street `adresse`
// filled in — this blocks the "Sted" (location) section of their public
// profile and blocks experiences-geocode-worker.ts (which already geocodes
// any provider that HAS an adresse+postnummer via Kartverket, but does
// nothing for providers where those fields are simply blank). This backfills
// ONLY the missing address text from Brreg (brreg-client.ts's
// fetchBrregBusinessAddress) — it does NOT geocode anything; the existing
// geocode worker picks up newly-filled addresses automatically on its next
// scheduled tick.
//
// Mirrors selectGardssalgProvidersForContentRefresh/
// getGardssalgProviderContentTarget/applyGardssalgProviderContent above:
// same gårdssalg scoping WHERE clause (producer_type set OR rfb-seed), same
// lock guard (content_source in manual/claim never auto-overwritten), same
// gardssalg_content_audit + field_provenance write discipline. UNLIKE the
// content-refresh writer, this is FILL-ONLY for all three fields — there is
// no "thin address" concept (an existing address, however short, e.g. just
// a road name with no number, is left untouched; only about_text/visit_text
// have a replace-thin-content path, per slice 2). Also deliberately does
// NOT stamp content_source/content_evidence_url: those are the about/visit/
// hours website-crawl provenance fields, and stamping them here would
// incorrectly imply the whole profile came from a website crawl when only
// the address came from Brreg. Address provenance lives solely in
// field_provenance.

export type GardssalgAddressEnrichmentTarget = {
  id: string;
  navn: string;
  org_nr: string;
  content_source: string | null;
  adresse: string | null;
  postnummer: string | null;
  poststed: string | null;
};

/**
 * Auto-select gårdssalg providers eligible for a Brreg address backfill:
 * gårdssalg providers (producer_type set OR rfb-seed) WITH an org_nr, NOT
 * locked (content_source not in manual/claim), and with a blank adresse.
 * Excludes catalog_hidden=1 rows (the hidden booking-flyt-v1 test provider),
 * matching the same exclusion listGardssalgProviders()/
 * countGardssalgProviders() already apply — providerParkingExclusionSql()
 * itself only gates on homepage_unreachable_since (irrelevant here, this
 * function never fetches a homepage), so the catalog_hidden exclusion is
 * applied directly, the same raw `(catalog_hidden IS NULL OR
 * catalog_hidden != 1)` clause those two functions use.
 * Ordered oldest-created first (ORDER BY created_at ASC) — there's no
 * per-address-attempt timestamp column to reuse here (out of scope for this
 * one-shot backfill), so plain creation order is used instead of the
 * last_content_attempt_at ordering the content-refresh selector uses.
 * Hard-capped at 48 (mirrors selectGardssalgProvidersForContentRefresh's cap).
 */
export function selectGardssalgProvidersForAddressEnrichment(limit = 48): GardssalgAddressEnrichmentTarget[] {
  const db = getDb(VERTICAL);
  const cap = Math.max(1, Math.min(48, limit));
  return db
    .prepare(
      `SELECT id, navn, org_nr, content_source, adresse, postnummer, poststed
         FROM experience_providers
        WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
          AND org_nr IS NOT NULL AND TRIM(org_nr) != ''
          AND (content_source IS NULL OR content_source NOT IN ('manual','claim'))
          AND (adresse IS NULL OR TRIM(adresse) = '')
          AND (catalog_hidden IS NULL OR catalog_hidden != 1)
        ORDER BY created_at ASC
        LIMIT ?`
    )
    .all(cap) as GardssalgAddressEnrichmentTarget[];
}

/**
 * Resolve an explicit providerId for the address-enrichment route's
 * `providerIds` override. Scoped to the gårdssalg WHERE clause (producer_type
 * set OR rfb-seed) — NOT the blank-adresse/lock filters above, so an admin
 * can force a lookup for a provider that isn't currently "eligible" by the
 * auto-select query (mirrors getGardssalgProviderContentTarget's override
 * semantics). Returns null when the provider doesn't exist, isn't a
 * gårdssalg provider, or has no org_nr.
 */
export function getGardssalgProviderAddressTarget(providerId: string): GardssalgAddressEnrichmentTarget | null {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT id, navn, org_nr, content_source, adresse, postnummer, poststed
         FROM experience_providers
        WHERE id = ?
          AND (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')`
    )
    .get(providerId) as GardssalgAddressEnrichmentTarget | undefined;
  if (!row || !row.org_nr || row.org_nr.trim().length === 0) return null;
  return row;
}

/**
 * Apply a Brreg address candidate to ONE gårdssalg provider, respecting the
 * lock gate: NEVER writes anything if the provider is locked (content_source
 * 'manual'/'claim'). FILL-ONLY for all three fields — adresse/postnummer/
 * poststed are each written only if the row's current value is blank AND
 * the candidate has content; an existing non-blank value (however short) is
 * never replaced (unlike about_text/visit_text, there is no "thin address"
 * quality bar). In the same transaction: UPDATEs the written fields +
 * updated_at, INSERTs one gardssalg_content_audit row per field actually
 * written (old_value = pre-write snapshot, new_value = what was written,
 * source_url = evidenceUrl, batch_id = optional batchId — same shape as
 * applyGardssalgProviderContent's audit inserts), and merges a
 * {source_url, fetched_at} entry into field_provenance for each written
 * field (read-modify-write, preserving existing entries for other fields).
 * Deliberately does NOT touch content_source/content_evidence_url (see the
 * section doc comment above). Returns the field names actually written
 * (empty array if nothing to write — e.g. the row already has all three
 * fields, or the provider is locked). Idempotent: a second call against an
 * already-fully-filled row writes nothing.
 */
export function applyGardssalgProviderAddress(
  providerId: string,
  candidate: { adresse?: string | null; postnummer?: string | null; poststed?: string | null },
  evidenceUrl: string,
  batchId?: string
): string[] {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT id, content_source, adresse, postnummer, poststed, field_provenance
         FROM experience_providers WHERE id = ?`
    )
    .get(providerId) as
    | {
        id: string;
        content_source: string | null;
        adresse: string | null;
        postnummer: string | null;
        poststed: string | null;
        field_provenance: string | null;
      }
    | undefined;
  if (!row) return [];
  if (row.content_source === "manual" || row.content_source === "claim") return [];

  function isBlank(v: unknown): boolean {
    return v === null || v === undefined || String(v).trim() === "";
  }

  const sets: string[] = [];
  const params: Record<string, unknown> = { id: providerId };
  const written: string[] = [];
  // Pre-write snapshot — captured BEFORE any write below, so the audit
  // trail's old_value is always the true pre-write value.
  const oldValues: Record<string, string | null> = {
    adresse: row.adresse,
    postnummer: row.postnummer,
    poststed: row.poststed,
  };

  if (isBlank(row.adresse) && candidate.adresse?.trim()) {
    sets.push("adresse = @adresse");
    params.adresse = candidate.adresse.trim();
    written.push("adresse");
  }
  if (isBlank(row.postnummer) && candidate.postnummer?.trim()) {
    sets.push("postnummer = @postnummer");
    params.postnummer = candidate.postnummer.trim();
    written.push("postnummer");
  }
  if (isBlank(row.poststed) && candidate.poststed?.trim()) {
    sets.push("poststed = @poststed");
    params.poststed = candidate.poststed.trim();
    written.push("poststed");
  }

  if (sets.length === 0) return [];

  sets.push("updated_at = datetime('now')");

  // ── field_provenance merge (read-modify-write, preserves other fields) ──
  let provenance: Record<string, { source_url: string; fetched_at: string }> = {};
  if (row.field_provenance) {
    try {
      const parsed = JSON.parse(row.field_provenance);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        provenance = parsed as Record<string, { source_url: string; fetched_at: string }>;
      }
    } catch {
      /* malformed existing JSON -> treat as empty rather than clobber the write */
    }
  }
  const fetchedAt = new Date().toISOString();
  for (const f of written) {
    provenance[f] = { source_url: evidenceUrl, fetched_at: fetchedAt };
  }
  sets.push("field_provenance = @field_provenance");
  params.field_provenance = JSON.stringify(provenance);

  const applyWithAudit = db.transaction(() => {
    db.prepare(`UPDATE experience_providers SET ${sets.join(", ")} WHERE id = @id`).run(params);
    const insertAudit = db.prepare(
      `INSERT INTO gardssalg_content_audit
         (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
       VALUES (@id, @provider_id, @field_name, @old_value, @new_value, @source_url, @batch_id, 'system', datetime('now'))`
    );
    for (const f of written) {
      insertAudit.run({
        id: uuid(),
        provider_id: providerId,
        field_name: f,
        old_value: oldValues[f] ?? null,
        new_value: (params[f] as string | undefined) ?? null,
        source_url: evidenceUrl,
        batch_id: batchId ?? null,
      });
    }
  });
  applyWithAudit();

  return written;
}

// ─── Gårdssalg org_nr backfill (dev-request 2026-07-18-gardssalg-
// profilkvalitet-foer-outreach, slice 5b) ────────────────────────────────────
// Slice 4's batch report found 0/74 gårdssalg providers have org_nr set —
// this is the key slice 3's Brreg address-enrichment needs (direct-by-orgnr
// lookup), so slice 3's write path has sat idle with nothing to key off of.
// This slice backfills org_nr using Brreg's NAME-search (findOrgnumberByName,
// brreg-client.ts) purely as a CANDIDATE generator — per Daniel's binding
// identitetskrav (slice 4-GO, ordrett): "vær sikker på at man ikke krysser
// ulike agenter med data" / "ved tvil: ikke skriv". A candidate is
// auto-written ONLY when BOTH (a) Brreg's own confidence score is the
// rubric's exact-match tier (1.0 — normalised query name == normalised hit
// name, see brreg-client.ts's doc comment) AND (b) this function's own
// independent postal corroboration (isBlank-safe compare of the provider's
// existing postnummer/poststed, if any, against the hit's own postal) also
// agrees. Anything short of that — no candidate, sub-1.0 confidence, no
// existing postnummer/poststed to corroborate against, or a corroboration
// mismatch — is NEVER auto-written; the caller (the admin route) routes it
// to gardssalg_orgnr_review_queue instead. This mirrors, not duplicates,
// applyGardssalgProviderAddress's fill-only/lock-guard/audit discipline.

export type GardssalgOrgnrBackfillTarget = {
  id: string;
  navn: string;
  org_nr: string | null;
  content_source: string | null;
  postnummer: string | null;
  poststed: string | null;
};

/**
 * Auto-select gårdssalg providers eligible for an org_nr backfill attempt:
 * gårdssalg providers (producer_type set OR rfb-seed), NOT locked
 * (content_source not in manual/claim), with a blank org_nr, excluding
 * catalog_hidden=1 — same scoping convention as
 * selectGardssalgProvidersForAddressEnrichment above, just keyed on org_nr
 * instead of adresse. Ordered oldest-created first. Hard-capped at 48.
 */
export function selectGardssalgProvidersForOrgnrBackfill(limit = 48): GardssalgOrgnrBackfillTarget[] {
  const db = getDb(VERTICAL);
  const cap = Math.max(1, Math.min(48, limit));
  return db
    .prepare(
      `SELECT id, navn, org_nr, content_source, postnummer, poststed
         FROM experience_providers
        WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
          AND (org_nr IS NULL OR TRIM(org_nr) = '')
          AND (content_source IS NULL OR content_source NOT IN ('manual','claim'))
          AND (catalog_hidden IS NULL OR catalog_hidden != 1)
        ORDER BY created_at ASC
        LIMIT ?`
    )
    .all(cap) as GardssalgOrgnrBackfillTarget[];
}

/**
 * Resolve an explicit providerId for the org_nr-backfill route's
 * `providerIds` override. Scoped to the gårdssalg WHERE clause only (NOT the
 * blank-org_nr/lock filters) — mirrors getGardssalgProviderAddressTarget's
 * override semantics, so an admin can force a lookup on any gårdssalg
 * provider. Unlike the address target getter, this does NOT require org_nr
 * to already be present (the whole point here is finding it).
 */
export function getGardssalgProviderOrgnrTarget(providerId: string): GardssalgOrgnrBackfillTarget | null {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT id, navn, org_nr, content_source, postnummer, poststed
         FROM experience_providers
        WHERE id = ?
          AND (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')`
    )
    .get(providerId) as GardssalgOrgnrBackfillTarget | undefined;
  return row ?? null;
}

/**
 * True only when an existing, non-blank postnummer OR poststed on the
 * provider's own row agrees with the Brreg hit's own postal fields
 * (brreg_postal is a postnummer, compared exactly; poststed is compared as
 * an EXACT normalised match against the hit's own brreg_poststed field —
 * NOT a substring test against the formatted `address` display string,
 * which is unsafe: a short poststed like "Nes" or "Os" is a substring of
 * unrelated towns like "Sandnes"/"Oslo", which would have silently
 * "corroborated" an org_nr for the wrong provider — see brreg-client.ts's
 * BrregHit.brreg_poststed doc comment, added specifically to close this).
 * Returns false (never true) when the provider has NEITHER field set, or
 * when the hit has no comparable field for the one the provider does have —
 * there is nothing to corroborate against, so per Daniel's "ved tvil: ikke
 * skriv" this can never pass by absence of a signal. Exported for unit
 * tests.
 */
export function gardssalgOrgnrPostalCorroborated(
  target: { postnummer: string | null; poststed: string | null },
  hit: { brreg_postal?: string | null; brreg_poststed?: string | null }
): boolean {
  const targetPostnr = (target.postnummer || "").trim();
  const hitPostnr = (hit.brreg_postal || "").trim();
  if (targetPostnr && hitPostnr && targetPostnr === hitPostnr) return true;

  // Postnummer CONFLICT veto (integration review M2, 2026-07-19): when both
  // sides carry a postnummer and they point at different postal REGIONS
  // (different first digit), a same-named poststed elsewhere in the country
  // (Vik, Nes, Sand … recur across regions) must NOT corroborate — falling
  // through to the name check here would be exactly the wrong-entity write
  // this gate exists to prevent. Same-region mismatches (e.g. neighbouring
  // postnummer within one kommune) still fall through to the poststed check.
  if (targetPostnr && hitPostnr && targetPostnr[0] !== hitPostnr[0]) return false;

  const targetPoststed = normaliseName(target.poststed || "");
  const hitPoststed = normaliseName(hit.brreg_poststed || "");
  if (targetPoststed && hitPoststed && targetPoststed === hitPoststed) return true;

  return false;
}

/**
 * True only when Brreg's own name-match confidence is the rubric's exact-
 * match tier (1.0 — see brreg-client.ts's scoreNameMatch doc comment) AND
 * gardssalgOrgnrPostalCorroborated agrees. This is the ONLY gate that may
 * ever auto-write an org_nr — anything else must go to the review queue.
 * Exported for unit tests.
 */
export function gardssalgOrgnrAutoWriteEligible(
  target: { postnummer: string | null; poststed: string | null },
  hit: { confidence: number; brreg_postal?: string | null; brreg_poststed?: string | null }
): boolean {
  return hit.confidence === 1.0 && gardssalgOrgnrPostalCorroborated(target, hit);
}

/**
 * Apply a confirmed org_nr candidate to ONE gårdssalg provider. Same lock
 * guard + fill-only + audit/provenance discipline as
 * applyGardssalgProviderAddress: NEVER writes if the provider is locked
 * (content_source manual/claim); only writes if the row's own org_nr is
 * currently blank (a second call against an already-filled row is a no-op,
 * idempotent). Because experience_providers.org_nr is UNIQUE, this also
 * re-checks (at write time, inside the same transaction) that no OTHER
 * provider already holds this org_nr — a genuine possibility given known
 * catalog duplicates (see slice 4b's "Ciderhuset-paret" finding) — and skips
 * the write (returns []) rather than letting the UNIQUE constraint throw,
 * so a caller-side race or a stale candidate never crashes the batch loop.
 * Does NOT stamp content_source/content_evidence_url (org_nr is registry
 * metadata, not website-crawled content — same rationale as
 * applyGardssalgProviderAddress). Returns the field names actually written
 * (empty array if nothing to write).
 */
export function applyGardssalgProviderOrgnr(
  providerId: string,
  orgNr: string,
  evidenceUrl: string,
  batchId?: string
): string[] {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(`SELECT id, content_source, org_nr, field_provenance FROM experience_providers WHERE id = ?`)
    .get(providerId) as
    | { id: string; content_source: string | null; org_nr: string | null; field_provenance: string | null }
    | undefined;
  if (!row) return [];
  if (row.content_source === "manual" || row.content_source === "claim") return [];

  const cleanOrgNr = (orgNr || "").trim();
  // Norwegian org numbers are exactly 9 digits — nothing else may reach the
  // UNIQUE-indexed column (also subsumes the empty-string check).
  if (!/^\d{9}$/.test(cleanOrgNr)) return [];
  if (row.org_nr && row.org_nr.trim() !== "") return []; // fill-only

  const conflict = db
    .prepare(`SELECT id FROM experience_providers WHERE org_nr = ? AND id != ?`)
    .get(cleanOrgNr, providerId) as { id: string } | undefined;
  if (conflict) return [];

  let provenance: Record<string, { source_url: string; fetched_at: string }> = {};
  if (row.field_provenance) {
    try {
      const parsed = JSON.parse(row.field_provenance);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        provenance = parsed as Record<string, { source_url: string; fetched_at: string }>;
      }
    } catch {
      /* malformed existing JSON -> treat as empty rather than clobber the write */
    }
  }
  provenance.org_nr = { source_url: evidenceUrl, fetched_at: new Date().toISOString() };

  const applyWithAudit = db.transaction(() => {
    // Fill-only guard repeated INSIDE the UPDATE's WHERE (integration review
    // N2): harmless today (synchronous read→tx, mirrors the address writer),
    // but makes the statement itself unable to clobber a concurrently-set
    // org_nr under any future multi-process deployment.
    const upd = db.prepare(
      `UPDATE experience_providers SET org_nr = @org_nr, field_provenance = @field_provenance, updated_at = datetime('now')
        WHERE id = @id AND (org_nr IS NULL OR TRIM(org_nr) = '')`
    ).run({ id: providerId, org_nr: cleanOrgNr, field_provenance: JSON.stringify(provenance) });
    if (upd.changes === 0) throw new Error("orgnr_filled_concurrently");
    db.prepare(
      `INSERT INTO gardssalg_content_audit
         (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
       VALUES (@id, @provider_id, 'org_nr', @old_value, @new_value, @source_url, @batch_id, 'system', datetime('now'))`
    ).run({
      id: uuid(),
      provider_id: providerId,
      old_value: row.org_nr ?? null,
      new_value: cleanOrgNr,
      source_url: evidenceUrl,
      batch_id: batchId ?? null,
    });
  });
  try {
    applyWithAudit();
  } catch (e: any) {
    if (String(e?.message) === "orgnr_filled_concurrently") return [];
    throw e;
  }

  return ["org_nr"];
}

/**
 * True when this provider's LATEST org_nr audit row is a rollback (an admin
 * deliberately undid an earlier backfill). The backfill route treats such
 * rows as review-only (integration review M3): without this, the same
 * deterministic Brreg answer would silently re-write the very org_nr a human
 * just rolled back on the next scheduled run — an undo that un-undoes
 * itself. Exported for tests.
 */
export function gardssalgOrgnrWasRolledBack(providerId: string): boolean {
  const db = getDb(VERTICAL);
  const latest = db
    .prepare(
      `SELECT source_url FROM gardssalg_content_audit
        WHERE provider_id = ? AND field_name = 'org_nr'
        ORDER BY rowid DESC LIMIT 1`
    )
    .get(providerId) as { source_url: string | null } | undefined;
  return !!latest && latest.source_url === GARDSSALG_ROLLBACK_MARKER;
}

export type GardssalgOrgnrReviewQueueEntry = {
  provider_id: string;
  provider_name?: string | null;
  candidate_orgnr?: string | null;
  candidate_name?: string | null;
  candidate_confidence?: number | null;
  candidate_address?: string | null;
  reason: string;
  batch_id?: string | null;
};

/**
 * Upsert (INSERT OR REPLACE, keyed on provider_id's UNIQUE constraint) one
 * gardssalg_orgnr_review_queue row — a re-run of the backfill route
 * overwrites a provider's prior review-queue entry rather than accumulating
 * duplicates, same "refresh, don't pile up" idiom as hanen_unmatched_members
 * (init.ts). `id` is preserved across an upsert only when the row doesn't
 * already exist (fresh uuid); an existing row keeps its own id via ON
 * CONFLICT, so foreign references (none exist yet) would remain stable.
 */
export function upsertGardssalgOrgnrReviewQueue(entry: GardssalgOrgnrReviewQueueEntry): void {
  const db = getDb(VERTICAL);
  db.prepare(
    `INSERT INTO gardssalg_orgnr_review_queue
       (id, provider_id, provider_name, candidate_orgnr, candidate_name, candidate_confidence,
        candidate_address, reason, batch_id, created_at, updated_at)
     VALUES (@id, @provider_id, @provider_name, @candidate_orgnr, @candidate_name, @candidate_confidence,
             @candidate_address, @reason, @batch_id, datetime('now'), datetime('now'))
     ON CONFLICT(provider_id) DO UPDATE SET
       provider_name = excluded.provider_name,
       candidate_orgnr = excluded.candidate_orgnr,
       candidate_name = excluded.candidate_name,
       candidate_confidence = excluded.candidate_confidence,
       candidate_address = excluded.candidate_address,
       reason = excluded.reason,
       batch_id = excluded.batch_id,
       updated_at = datetime('now')`
  ).run({
    id: uuid(),
    provider_id: entry.provider_id,
    provider_name: entry.provider_name ?? null,
    candidate_orgnr: entry.candidate_orgnr ?? null,
    candidate_name: entry.candidate_name ?? null,
    candidate_confidence: entry.candidate_confidence ?? null,
    candidate_address: entry.candidate_address ?? null,
    reason: entry.reason,
    batch_id: entry.batch_id ?? null,
  });
}

/** Removes a provider's review-queue entry — called once org_nr is actually
 * resolved for it (by a later auto-write, or a human filling it in some
 * other way), so the queue only ever reflects CURRENTLY-unresolved
 * providers. Never throws if no row exists. */
export function clearGardssalgOrgnrReviewQueueEntry(providerId: string): void {
  const db = getDb(VERTICAL);
  db.prepare(`DELETE FROM gardssalg_orgnr_review_queue WHERE provider_id = ?`).run(providerId);
}

/** Lists all current review-queue entries, newest-updated first. Read-only,
 * backs GET /admin/gardssalg-orgnr-review-queue. */
export function listGardssalgOrgnrReviewQueue(): (GardssalgOrgnrReviewQueueEntry & {
  id: string;
  created_at: string;
  updated_at: string;
})[] {
  const db = getDb(VERTICAL);
  return db
    .prepare(`SELECT * FROM gardssalg_orgnr_review_queue ORDER BY updated_at DESC`)
    .all() as (GardssalgOrgnrReviewQueueEntry & { id: string; created_at: string; updated_at: string })[];
}

// The catalog's display names often carry a "— Sted" suffix ("Ægir Bryggeri —
// Flåm") that Brreg registry names never have; searching/scoring with the
// suffix attached demotes a genuinely exact company-name match to the
// first-token 0.8x tier — which under the auto-write gate above means the row
// needlessly lands in the review queue instead of auto-filling. Strips a
// SPACED dash segment only (em/en/hyphen with whitespace on both sides), so
// inner compound hyphens ("Saft- og Siderfabrikk") are untouched. Pure +
// exported for tests; wired into the backfill route's findOrgnumberByName
// call (slice 5d integration round).
export function gardssalgSearchName(navn: string): string {
  return (navn || "")
    .split(/\s+[—–-]\s+/)[0]
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Gårdssalg shared-domain guard (dev-request 2026-07-18-gardssalg-
//     profilkvalitet-foer-outreach, slice 5d) ────────────────────────────────
//
// Slice 4b's post-apply audit caught Daniel's exact feared incident live: a
// provider whose `hjemmeside` points at its hanen.no DIRECTORY page got
// about/visit text describing a DIFFERENT member farm, because
// crFetchGardssalgContent crawls sub-pages from the HOST ROOT — on a shared
// directory domain that root serves other entities' content. Guard, applied
// by the content-refresh route before any fetch:
//   (a) the CURATED directory/aggregator host classifier from
//       cross-source-validator.ts (dev-request 2026-07-19-agg-website-leak —
//       hanen.no, siderruta.no, visitnorway, gulesider/proff/1881, the
//       *.hanen.no-style family suffixes, …) — one source of truth, not a
//       second hand-rolled list;
//   (b) a visit*-DMO prefix rule ON TOP: cross-source-validator deliberately
//       refuses to pattern-match tourism boards because ITS action
//       (NULLing a hjemmeside) is irreversible — here the action is
//       "skip content-writes this run" (fully reversible), so the
//       fail-closed pattern is the right trade for gårdssalg text safety;
//   (c) an automatic red flag when the SAME host serves more than one
//       provider's hjemmeside in this catalog — no fixed list can know every
//       shared domain, but a host with 2+ providers is by definition not one
//       producer's own site. (The Ciderhuset/Balholm duplicate-provider pair
//       is the known benign hit of (c) — correct outcome: excluded from
//       automated TEXT writes until the dedup resolves, since the crawl
//       cannot know which row the content belongs to.)
// Excluded providers are reported (never silently dropped) and land on the
// outreach-hook list — a producer fixing their hjemmeside via claim is the
// durable fix.

/** Pure host-level rule — exported for tests. */
export function gardssalgSharedDomainReason(host: string | null): string | null {
  if (!host) return null;
  const h = host.toLowerCase().replace(/^www\./, "");
  if (isDirectoryOrAggregatorHost(h)) return "blocklisted_directory_domain";
  if (/^visit[a-z0-9-]*\.(no|com)$/.test(h)) return "dmo_visit_domain";
  return null;
}

/**
 * Catalog-wide shared-domain map: host → number of gårdssalg providers whose
 * hjemmeside lives on it. One cheap full scan (the catalog is two-digit
 * sized) per refresh request — no caching, so a just-corrected hjemmeside
 * takes effect immediately.
 */
export function gardssalgSharedHostCounts(): Map<string, number> {
  const db = getDb(VERTICAL);
  // Hidden rows ARE counted (komplett-foer-synlig, 2026-07-19): the NACE
  // landing plan parks whole discovery batches as catalog_hidden while they
  // are enriched, and a contamination guard that cannot see the very rows
  // being enriched is blind exactly when it matters. The one row that must
  // NOT count is the booking-flyt test provider — excluded by its stable
  // producer_type marker instead of the old catalog_hidden!=1 clause (which
  // silently excluded every hidden real row along with it).
  const rows = db
    .prepare(
      `SELECT hjemmeside FROM experience_providers
        WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
          AND hjemmeside IS NOT NULL AND TRIM(hjemmeside) != ''
          AND (producer_type IS NULL OR producer_type != 'test-gardssalg')`
    )
    .all() as Array<{ hjemmeside: string }>;
  const counts = new Map<string, number>();
  for (const r of rows) {
    const h = hostFromUrlLike(r.hjemmeside);
    if (h) counts.set(h, (counts.get(h) || 0) + 1);
  }
  return counts;
}

/**
 * Full exclusion decision for one provider's hjemmeside, given the catalog
 * host counts. Returns null when the host is fine, or a machine-readable
 * reason ("blocklisted_directory_domain" | "dmo_visit_domain" |
 * "shared_host_multiple_providers").
 */
export function gardssalgContentExclusionReason(
  hjemmeside: string | null | undefined,
  hostCounts: Map<string, number>
): string | null {
  const host = hostFromUrlLike(hjemmeside || "");
  if (!host) return null;
  const listed = gardssalgSharedDomainReason(host);
  if (listed) return listed;
  if ((hostCounts.get(host) || 0) > 1) return "shared_host_multiple_providers";
  return null;
}

// ─── Gårdssalg NACE discovery support (dev-request 2026-07-19-brreg-nace-
//     drikkeprodusenter) ─────────────────────────────────────────────────────

// Brreg registry names are UPPERCASE with a trailing org-form suffix
// ("67 NORTH DISTILLERY AS"); the catalog shows human display names
// ("67 North Distillery"). Deterministic transform: strip trailing org-form
// tokens, then title-case — digits kept verbatim, Norwegian small words
// lowercased unless first. Pure + exported for tests.
const BRREG_ORG_SUFFIX_TOKENS = new Set(["as", "asa", "ans", "da", "enk", "sa", "ba", "nuf", "iks", "kf"]);
const NORWEGIAN_SMALL_WORDS = new Set(["og", "i", "på", "av", "med", "for", "til", "fra"]);
export function brregDisplayName(brregNavn: string): string {
  const tokens = (brregNavn || "").trim().split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && BRREG_ORG_SUFFIX_TOKENS.has(tokens[tokens.length - 1].toLowerCase())) {
    tokens.pop();
  }
  return tokens
    .map((t, i) => {
      const lower = t.toLowerCase();
      if (/^\d+$/.test(t)) return t;
      if (i > 0 && NORWEGIAN_SMALL_WORDS.has(lower)) return lower;
      return lower
        .split("-")
        .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
        .join("-");
    })
    .join(" ");
}

/**
 * Name-dedup basis for NACE discovery: every existing gårdssalg row's
 * id/navn/org_nr (INCLUDING catalog_hidden — a discovery candidate matching
 * the hidden test provider must still be treated as a duplicate, never
 * re-created as a visible row).
 */
export function listGardssalgNameDedupRows(): Array<{ id: string; navn: string; org_nr: string | null; kommune: string | null }> {
  const db = getDb(VERTICAL);
  return db
    .prepare(
      `SELECT id, navn, org_nr, kommune FROM experience_providers
        WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')`
    )
    .all() as Array<{ id: string; navn: string; org_nr: string | null; kommune: string | null }>;
}

// ─── Gårdssalg website discovery (dev-request 2026-07-19-gardssalg-nye-
//     agenter-komplett-foer-synlig, skive B) ─────────────────────────────────
//
// Most NACE-discovered rows carry no hjemmeside in Brreg, and the whole
// enrichment chain (content-refresh → 5a rewrite → 5c products) is source-
// based: no website, nothing to enrich from. This block generates candidate
// websites deterministically (domain patterns derived from the provider's own
// name), verifies OWNERSHIP evidence on the fetched page (the provider's
// org_nr, or its exact name together with its kommune/poststed), and parks
// verified candidates in gardssalg_website_review_queue — hjemmeside is NEVER
// written directly by discovery. Daniel's binding identity rule (2026-07-19)
// applies doubly to source selection: a wrong homepage would poison every
// downstream field write, so adoption always goes through the human-approved
// lever (POST /admin/gardssalg-website-review-approve).

export type GardssalgWebsiteDiscoveryTarget = {
  id: string;
  navn: string;
  org_nr: string | null;
  kommune: string | null;
  poststed: string | null;
  content_source: string | null;
};

/**
 * Auto-select gårdssalg providers eligible for website discovery: blank
 * hjemmeside, not manual/claim-locked, not the test provider. Deliberately
 * does NOT filter catalog_hidden — the komplett-foer-synlig plan parks whole
 * discovery batches hidden precisely while this machinery runs on them.
 * Never-attempted rows first, then oldest attempt (website_discovery_
 * attempted_at — its own stamp, see init-experiences.ts), then oldest row.
 */
export function selectGardssalgProvidersForWebsiteDiscovery(limit = 16): GardssalgWebsiteDiscoveryTarget[] {
  const db = getDb(VERTICAL);
  const cap = Math.max(1, Math.min(48, limit));
  return db
    .prepare(
      `SELECT id, navn, org_nr, kommune, poststed, content_source
         FROM experience_providers
        WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
          AND (hjemmeside IS NULL OR TRIM(hjemmeside) = '')
          AND (content_source IS NULL OR content_source NOT IN ('manual', 'claim'))
          AND (producer_type IS NULL OR producer_type != 'test-gardssalg')
        ORDER BY (website_discovery_attempted_at IS NOT NULL), website_discovery_attempted_at ASC, created_at ASC
        LIMIT ?`
    )
    .all(cap) as GardssalgWebsiteDiscoveryTarget[];
}

/** Explicit-target resolver for the route's providerIds override — gårdssalg-
 * scoped and test-provider-excluded like the selector, but NOT filtered on
 * blank hjemmeside/locks (those are decided and reported by the route). */
export function getGardssalgWebsiteDiscoveryTarget(providerId: string): (GardssalgWebsiteDiscoveryTarget & { hjemmeside: string | null }) | null {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT id, navn, org_nr, kommune, poststed, content_source, hjemmeside
         FROM experience_providers
        WHERE id = ?
          AND (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
          AND (producer_type IS NULL OR producer_type != 'test-gardssalg')`
    )
    .get(providerId) as (GardssalgWebsiteDiscoveryTarget & { hjemmeside: string | null }) | undefined;
  return row ?? null;
}

/**
 * Deterministic candidate hosts from the provider's own display name: the
 * «— Sted»-pruned name, org-form suffix dropped, in the two common Norwegian
 * domain transliterations (ø→o/å→a and ø→oe/å→aa; æ→ae in both), each as
 * joined and hyphenated labels under .no. Max 4, degenerate labels (<4 or
 * >63 chars) dropped. Pure — exported for tests.
 */
export function gardssalgWebsiteCandidateHosts(navn: string): string[] {
  const tokens = gardssalgSearchName(navn).toLowerCase().split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && BRREG_ORG_SUFFIX_TOKENS.has(tokens[tokens.length - 1])) tokens.pop();
  const variants = [
    tokens.map((t) => t.replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a")),
    tokens.map((t) => t.replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa")),
  ];
  const hosts: string[] = [];
  for (const v of variants) {
    const clean = v.map((t) => t.replace(/[^a-z0-9]/g, "")).filter(Boolean);
    if (clean.length === 0) continue;
    for (const label of [clean.join(""), clean.join("-")]) {
      if (label.length < 4 || label.length > 63) continue;
      const host = `${label}.no`;
      if (!hosts.includes(host)) hosts.push(host);
    }
  }
  return hosts.slice(0, 4);
}

/** Visible-text extraction for evidence matching — scripts/styles/tags out,
 * entities-as-space, whitespace collapsed. Pure — exported for tests. */
export function gardssalgPageText(html: string): string {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ");
}

/**
 * Ownership evidence for a candidate page. verified requires the provider's
 * org_nr on the page (separators inside digit runs collapsed, and the match
 * must not be embedded in a longer digit run), OR the exact pruned name AND
 * the kommune/poststed both present. Short/generic names (single token under
 * 8 chars — «Sider», «Engel») never verify on name alone. Pure — exported
 * for tests.
 */
export function gardssalgWebsiteEvidenceMatch(
  pageText: string,
  target: { orgNr?: string | null; navn: string; kommune?: string | null; poststed?: string | null }
): { org_nr_found: boolean; name_found: boolean; place_found: boolean; verified: boolean } {
  const text = pageText || "";
  let orgFound = false;
  const orgNr = (target.orgNr || "").trim();
  if (/^\d{9}$/.test(orgNr)) {
    const digitCollapsed = text.replace(/(\d)[\s. ]+(?=\d)/g, "$1");
    orgFound = new RegExp(`(?<!\\d)${orgNr}(?!\\d)`).test(digitCollapsed);
  }
  const normName = normaliseName(gardssalgSearchName(target.navn));
  const normText = normaliseName(text);
  // Word-boundary containment in the normalized space (review M2,
  // 2026-07-19): normaliseName collapses all whitespace to single spaces, so
  // space-padding both sides gives exact token-boundary semantics — «berg
  // gard» must NOT verify against a «Berg Gardsdrift» page, and kommune
  // «Nes» must NOT match «Sandnes»/«Nesbyen» mid-word.
  const boundaryIncludes = (haystack: string, needle: string): boolean =>
    needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
  const nameSpecific = normName.length >= 8 || normName.split(" ").filter(Boolean).length >= 2;
  const nameFound = nameSpecific && boundaryIncludes(normText, normName);
  const normKommune = normaliseName(target.kommune || "");
  const normPoststed = normaliseName(target.poststed || "");
  const placeFound =
    (normKommune.length >= 3 && boundaryIncludes(normText, normKommune)) ||
    (normPoststed.length >= 3 && boundaryIncludes(normText, normPoststed));
  return {
    org_nr_found: orgFound,
    name_found: nameFound,
    place_found: placeFound,
    verified: orgFound || (nameFound && placeFound),
  };
}

export type GardssalgWebsiteReviewQueueEntry = {
  provider_id: string;
  provider_name?: string | null;
  candidate_url: string;
  final_url?: string | null;
  evidence?: string | null;
  confidence?: number | null;
  reason?: string;
  batch_id?: string | null;
};

/** Upsert one website-review-queue row — same UNIQUE(provider_id)
 * refresh-on-rerun idiom as the org_nr queue. */
export function upsertGardssalgWebsiteReviewQueue(entry: GardssalgWebsiteReviewQueueEntry): void {
  const db = getDb(VERTICAL);
  db.prepare(
    `INSERT INTO gardssalg_website_review_queue
       (id, provider_id, provider_name, candidate_url, final_url, evidence, confidence, reason, batch_id, created_at, updated_at)
     VALUES (@id, @provider_id, @provider_name, @candidate_url, @final_url, @evidence, @confidence, @reason, @batch_id, datetime('now'), datetime('now'))
     ON CONFLICT(provider_id) DO UPDATE SET
       provider_name = excluded.provider_name,
       candidate_url = excluded.candidate_url,
       final_url = excluded.final_url,
       evidence = excluded.evidence,
       confidence = excluded.confidence,
       reason = excluded.reason,
       batch_id = excluded.batch_id,
       updated_at = datetime('now')`
  ).run({
    id: uuid(),
    provider_id: entry.provider_id,
    provider_name: entry.provider_name ?? null,
    candidate_url: entry.candidate_url,
    final_url: entry.final_url ?? null,
    evidence: entry.evidence ?? null,
    confidence: entry.confidence ?? null,
    reason: entry.reason ?? "website_discovery_candidate",
    batch_id: entry.batch_id ?? null,
  });
}

/** Removes a provider's website-queue entry once hjemmeside is resolved. */
export function clearGardssalgWebsiteReviewQueueEntry(providerId: string): void {
  const db = getDb(VERTICAL);
  db.prepare(`DELETE FROM gardssalg_website_review_queue WHERE provider_id = ?`).run(providerId);
}

/** Lists all current website-queue entries, newest-updated first. */
export function listGardssalgWebsiteReviewQueue(): (GardssalgWebsiteReviewQueueEntry & {
  id: string;
  created_at: string;
  updated_at: string;
})[] {
  const db = getDb(VERTICAL);
  return db
    .prepare(`SELECT * FROM gardssalg_website_review_queue ORDER BY updated_at DESC`)
    .all() as (GardssalgWebsiteReviewQueueEntry & { id: string; created_at: string; updated_at: string })[];
}

/** Anti-starvation stamp for website discovery (mirrors the content-refresh
 * attempt stamp's role, on its own column). */
export function stampGardssalgWebsiteDiscoveryAttempt(providerIds: string[]): void {
  const db = getDb(VERTICAL);
  const upd = db.prepare(
    `UPDATE experience_providers SET website_discovery_attempted_at = datetime('now') WHERE id = ?`
  );
  for (const id of providerIds) upd.run(id);
}

/**
 * Apply an approved website candidate to ONE gårdssalg provider. Same
 * discipline as applyGardssalgProviderOrgnr: lock guard, FILL-ONLY (an
 * existing hjemmeside is never replaced), URL sanity, and an identity
 * re-check at write time — if the candidate's host is already carried by any
 * other provider in the catalog (gardssalgSharedHostCounts), the write is
 * skipped: adopting it would create exactly the shared-host situation the 5d
 * guard exists to quarantine. Stamps field_provenance.hjemmeside and a
 * gardssalg_content_audit row (field hjemmeside — in
 * GARDSSALG_ROLLBACKABLE_FIELDS, so the standard rollback lever covers it).
 * Returns the field names actually written ([] if nothing written).
 */
export function applyGardssalgProviderWebsite(
  providerId: string,
  url: string,
  evidenceUrl: string,
  batchId?: string
): string[] {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(`SELECT id, content_source, hjemmeside, field_provenance FROM experience_providers WHERE id = ?`)
    .get(providerId) as
    | { id: string; content_source: string | null; hjemmeside: string | null; field_provenance: string | null }
    | undefined;
  if (!row) return [];
  if (row.content_source === "manual" || row.content_source === "claim") return [];

  const cleanUrl = (url || "").trim();
  if (cleanUrl.length === 0 || cleanUrl.length > 2048) return [];
  if (!/^https?:\/\/\S+\.\S+/i.test(cleanUrl)) return [];
  if (row.hjemmeside && row.hjemmeside.trim() !== "") return []; // fill-only

  const host = hostFromUrlLike(cleanUrl);
  if (!host) return [];
  if ((gardssalgSharedHostCounts().get(host) || 0) >= 1) return [];

  let provenance: Record<string, { source_url: string; fetched_at: string }> = {};
  if (row.field_provenance) {
    try {
      const parsed = JSON.parse(row.field_provenance);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        provenance = parsed as Record<string, { source_url: string; fetched_at: string }>;
      }
    } catch {
      /* malformed existing JSON -> treat as empty rather than clobber the write */
    }
  }
  provenance.hjemmeside = { source_url: evidenceUrl, fetched_at: new Date().toISOString() };

  const applyWithAudit = db.transaction(() => {
    const upd = db.prepare(
      `UPDATE experience_providers SET hjemmeside = @hjemmeside, field_provenance = @field_provenance, updated_at = datetime('now')
        WHERE id = @id AND (hjemmeside IS NULL OR TRIM(hjemmeside) = '')`
    ).run({ id: providerId, hjemmeside: cleanUrl, field_provenance: JSON.stringify(provenance) });
    if (upd.changes === 0) throw new Error("hjemmeside_filled_concurrently");
    db.prepare(
      `INSERT INTO gardssalg_content_audit
         (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
       VALUES (@id, @provider_id, 'hjemmeside', @old_value, @new_value, @source_url, @batch_id, 'system', datetime('now'))`
    ).run({
      id: uuid(),
      provider_id: providerId,
      old_value: row.hjemmeside ?? null,
      new_value: cleanUrl,
      source_url: evidenceUrl,
      batch_id: batchId ?? null,
    });
  });
  try {
    applyWithAudit();
  } catch (e: any) {
    if (String(e?.message) === "hjemmeside_filled_concurrently") return [];
    throw e;
  }

  return ["hjemmeside"];
}

// ─── Gårdssalg content rollback (dev-request 2026-07-18-gardssalg-
// profilkvalitet-foer-outreach, slice 1; widened in slice 3 to also cover
// applyGardssalgProviderAddress's adresse/postnummer/poststed writes) ────────
// Reads/writes gardssalg_content_audit + experience_providers.<field> to
// undo a gårdssalg content-refresh write. Backs POST /admin/gardssalg-
// content-rollback (routes/opplevelser.ts). Only the fields
// applyGardssalgProviderContent()/applyGardssalgProviderAddress() can ever
// write are rollback-eligible — field_name is validated against this fixed
// allow-list BEFORE it is ever interpolated into SQL, since field_name can
// arrive directly from an admin request body.
const GARDSSALG_ROLLBACKABLE_FIELDS = new Set([
  "about_text",
  "visit_text",
  "opening_hours_text",
  "adresse",
  "postnummer",
  "poststed",
  // slice 5c (2026-07-19) — fill-only products (JSON array of strings)
  "products",
  // slice 5b (2026-07-19) — fill-only org_nr backfill (Brreg name-search +
  // exact-name/postal corroboration; see applyGardssalgProviderOrgnr below)
  "org_nr",
  // skive B (2026-07-19, komplett-foer-synlig) — fill-only hjemmeside adopted
  // from the website-discovery review queue; see applyGardssalgProviderWebsite
  "hjemmeside",
]);
// source_url marker stamped on audit rows inserted BY a rollback itself
// (as opposed to rows inserted by a content-refresh write) — lets
// planGardssalgContentRollback tell the two apart for idempotency (see its
// doc comment) without a dedicated boolean column.
const GARDSSALG_ROLLBACK_MARKER = "internal://rollback";

export type GardssalgRollbackTarget = {
  provider_id?: string;
  field_name?: string;
  batch_id?: string;
};

export type GardssalgRollbackPlanItem = {
  provider_id: string;
  field_name: string;
  current_value: string | null;
  restore_to: string | null;
};

export type GardssalgRollbackSkip = {
  provider_id: string;
  field_name: string;
  reason: "no_audit_row" | "already_current" | "unknown_field" | "manual_or_claim_source";
};

// Resolve the (provider_id, field_name) pairs a rollback request targets:
// batch_id -> every field any provider had touched under that batch;
// provider_id (+ optional field_name) -> that provider's field(s) with any
// audit history. Pure lookup — no writes, no idempotency checks (those
// happen in planGardssalgContentRollback).
function resolveGardssalgRollbackTargets(
  opts: GardssalgRollbackTarget
): Array<{ provider_id: string; field_name: string }> {
  const db = getDb(VERTICAL);
  if (opts.batch_id) {
    return db
      .prepare(
        `SELECT DISTINCT provider_id, field_name FROM gardssalg_content_audit WHERE batch_id = ?`
      )
      .all(opts.batch_id) as Array<{ provider_id: string; field_name: string }>;
  }
  if (opts.provider_id) {
    if (opts.field_name) {
      return [{ provider_id: opts.provider_id, field_name: opts.field_name }];
    }
    const rows = db
      .prepare(`SELECT DISTINCT field_name FROM gardssalg_content_audit WHERE provider_id = ?`)
      .all(opts.provider_id) as Array<{ field_name: string }>;
    return rows.map((r) => ({ provider_id: opts.provider_id as string, field_name: r.field_name }));
  }
  return [];
}

/**
 * Read-only: compute what a gårdssalg content rollback WOULD do, without
 * writing anything. For each targeted (provider_id, field_name) pair, finds
 * the MOST RECENT audit row and compares its old_value against the field's
 * CURRENT live value: if they already match, the field is already rolled
 * back (or was never actually changed) — skipped as "already_current"
 * rather than restorable, so a rollback is never blindly re-applied.
 * A field/provider with no audit row at all is skipped as "no_audit_row".
 * An unknown field_name (not one of the gårdssalg content-refresh/address-
 * enrichment writes in GARDSSALG_ROLLBACKABLE_FIELDS) is skipped as
 * "unknown_field" and never reaches SQL interpolation.
 */
export function planGardssalgContentRollback(
  opts: GardssalgRollbackTarget
): { restorable: GardssalgRollbackPlanItem[]; skipped: GardssalgRollbackSkip[] } {
  const db = getDb(VERTICAL);
  const targets = resolveGardssalgRollbackTargets(opts);
  const restorable: GardssalgRollbackPlanItem[] = [];
  const skipped: GardssalgRollbackSkip[] = [];

  for (const t of targets) {
    if (!GARDSSALG_ROLLBACKABLE_FIELDS.has(t.field_name)) {
      skipped.push({ provider_id: t.provider_id, field_name: t.field_name, reason: "unknown_field" });
      continue;
    }
    // ORDER BY rowid (SQLite's implicit insertion-order column), not
    // changed_at/id: changed_at has only second resolution (a write followed
    // by a rollback within the same second would tie), and id is a random
    // UUID with no relationship to insertion order — rowid is the only
    // column that reliably reflects "most recently inserted".
    const latest = db
      .prepare(
        `SELECT old_value, new_value, source_url, changed_at FROM gardssalg_content_audit
          WHERE provider_id = ? AND field_name = ?
          ORDER BY rowid DESC LIMIT 1`
      )
      .get(t.provider_id, t.field_name) as
      | { old_value: string | null; new_value: string | null; source_url: string | null; changed_at: string }
      | undefined;
    if (!latest) {
      skipped.push({ provider_id: t.provider_id, field_name: t.field_name, reason: "no_audit_row" });
      continue;
    }
    const providerRow = db
      .prepare(`SELECT ${t.field_name} AS current_value, content_source FROM experience_providers WHERE id = ?`)
      .get(t.provider_id) as { current_value: string | null; content_source: string | null } | undefined;
    if (!providerRow) {
      skipped.push({ provider_id: t.provider_id, field_name: t.field_name, reason: "no_audit_row" });
      continue;
    }
    // Same write guard as applyGardssalgProviderContent() (~line 2031): once a
    // provider's content_source is 'manual' or 'claim', the automated
    // pipeline never touches that row again — a rollback is part of the same
    // automated pipeline, so it must never overwrite manually-provided
    // content either, even if a stale audit row from before the claim/manual
    // edit makes the field look "restorable".
    if (providerRow.content_source === "manual" || providerRow.content_source === "claim") {
      skipped.push({ provider_id: t.provider_id, field_name: t.field_name, reason: "manual_or_claim_source" });
      continue;
    }
    const currentValue = providerRow.current_value ?? null;
    // Idempotency — two cases where there's genuinely nothing to restore:
    //   (1) currentValue already equals the value we'd be restoring TO
    //       (latest.old_value) — someone already put it back, via this
    //       endpoint or otherwise.
    //   (2) the LATEST audit row is itself a previous rollback
    //       (source_url === GARDSSALG_ROLLBACK_MARKER) whose new_value
    //       already matches currentValue — i.e. this exact field was
    //       already rolled back and nothing has touched it since. This
    //       case matters because after a rollback, the "latest" audit row
    //       becomes the ROLLBACK's own row (old_value = the pre-rollback
    //       value, new_value = the restored value); naively using ITS
    //       old_value as the next restore target would restore the
    //       pre-rollback (undesired) value right back — i.e. undo the undo.
    //       Case (1) alone does not catch this, since currentValue (the
    //       restored value) generally does NOT equal that row's old_value
    //       (the pre-rollback value).
    const alreadyAtRestoreTarget = currentValue === (latest.old_value ?? null);
    const alreadyRolledBack =
      latest.source_url === GARDSSALG_ROLLBACK_MARKER && currentValue === (latest.new_value ?? null);
    if (alreadyAtRestoreTarget || alreadyRolledBack) {
      skipped.push({ provider_id: t.provider_id, field_name: t.field_name, reason: "already_current" });
      continue;
    }
    restorable.push({
      provider_id: t.provider_id,
      field_name: t.field_name,
      current_value: currentValue,
      restore_to: latest.old_value ?? null,
    });
  }

  return { restorable, skipped };
}

/**
 * Apply a previously-planned gårdssalg content rollback (see
 * planGardssalgContentRollback): restores experience_providers.<field_name>
 * to `restore_to` for every item, and — critically — inserts a NEW
 * gardssalg_content_audit row per restore (old_value = the value
 * immediately before the rollback, new_value = the restored value,
 * changed_by='system', source_url carries an `internal://rollback` marker)
 * so the rollback itself is auditable and the audit trail is never
 * silently mutated or deleted. Each restore + its audit row is applied in
 * one transaction. field_name is re-validated against the same allow-list
 * as planGardssalgContentRollback (defense in depth — items should already
 * be plan() output, but this function never trusts field_name blindly).
 * content_source is likewise re-verified right before each write (same
 * defense in depth — items should already have been filtered by plan()'s
 * manual/claim check, but this function never trusts that blindly either):
 * if a provider's content_source is 'manual' or 'claim', the item is
 * skipped entirely (no write, no audit row, omitted from the returned
 * `restored` array) rather than restored.
 */
export function applyGardssalgContentRollback(
  items: GardssalgRollbackPlanItem[]
): Array<{ provider_id: string; field_name: string; restored_to: string | null }> {
  const db = getDb(VERTICAL);
  const restored: Array<{ provider_id: string; field_name: string; restored_to: string | null }> = [];

  const runOne = db.transaction((item: GardssalgRollbackPlanItem) => {
    db.prepare(`UPDATE experience_providers SET ${item.field_name} = @val WHERE id = @id`).run({
      val: item.restore_to,
      id: item.provider_id,
    });
    db.prepare(
      `INSERT INTO gardssalg_content_audit
         (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
       VALUES (@id, @provider_id, @field_name, @old_value, @new_value, @source_url, NULL, 'system', datetime('now'))`
    ).run({
      id: uuid(),
      provider_id: item.provider_id,
      field_name: item.field_name,
      old_value: item.current_value,
      new_value: item.restore_to,
      source_url: GARDSSALG_ROLLBACK_MARKER,
    });
  });

  for (const item of items) {
    if (!GARDSSALG_ROLLBACKABLE_FIELDS.has(item.field_name)) continue;
    // Same write guard as applyGardssalgProviderContent() (~line 2031) and
    // planGardssalgContentRollback's manual/claim check above — re-verified
    // here, right before the UPDATE, rather than trusting that this item
    // already passed that check in plan()'s `restorable` list. If a manual
    // or claim edit reaches this function anyway, skip it silently: no
    // write, no audit row, and it's simply omitted from `restored`.
    const providerRow = db
      .prepare(`SELECT content_source FROM experience_providers WHERE id = ?`)
      .get(item.provider_id) as { content_source: string | null } | undefined;
    if (providerRow && (providerRow.content_source === "manual" || providerRow.content_source === "claim")) {
      continue;
    }
    runOne(item);
    restored.push({ provider_id: item.provider_id, field_name: item.field_name, restored_to: item.restore_to });
  }

  return restored;
}
