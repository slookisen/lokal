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

export type ContentRefreshTarget = {
  id: string;
  navn: string;
  hjemmeside: string;
};

/**
 * Auto-select providers eligible for a homepage content-refresh: providers that
 * HAVE a website (hjemmeside) AND own ≥1 experience whose content is THIN
 * (description empty OR category empty) and NOT locked (not verified, not
 * manual/claim-sourced). Ordered oldest-enriched first (last_enriched_at NULLs
 * first) so a sweep makes progress. Capped by `limit`.
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
                  OR e.category    IS NULL OR TRIM(e.category)    = ''
                   )
          )
        ORDER BY (p.last_enriched_at IS NOT NULL), p.last_enriched_at ASC, p.created_at ASC
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
  content_source: string | null;
  verification_status: string | null;
};

export function getExperiencesForProvider(providerId: string): ExperienceContentRow[] {
  const db = getDb(VERTICAL);
  return db
    .prepare(
      `SELECT id, title, description, category, content_source, verification_status
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
 * gate. Writes `description` only if currently blank, `category` only if
 * currently empty; stamps content_source='provider_site', enrichment_state and
 * updated_at when anything changed. Returns the field names actually written
 * (empty array = nothing written: locked, or no thin field, or no candidates).
 * NEVER touches contact/orgnr/Brreg fields. Idempotent: a second run finds the
 * fields populated and writes nothing.
 */
export function applyExperienceContent(
  experienceId: string,
  candidate: { description?: string | null; category?: string | null }
): string[] {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT id, description, category, content_source, verification_status
         FROM experiences WHERE id = ?`
    )
    .get(experienceId) as ExperienceContentRow | undefined;
  if (!row) return [];
  if (isExperienceContentLocked(row)) return [];

  const sets: string[] = [];
  const params: Record<string, unknown> = { id: experienceId };
  const written: string[] = [];

  const descBlank = !row.description || String(row.description).trim() === "";
  if (descBlank && candidate.description && candidate.description.trim().length > 0) {
    sets.push("description = @description");
    params.description = candidate.description.trim();
    written.push("description");
  }

  const catBlank = !row.category || String(row.category).trim() === "";
  if (catBlank && candidate.category && candidate.category.trim().length > 0) {
    sets.push("category = @category");
    params.category = candidate.category.trim();
    written.push("category");
  }

  if (sets.length === 0) return [];

  // Mark provenance + enrichment state on any successful content write.
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
