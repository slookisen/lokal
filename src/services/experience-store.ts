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
// dev-request 2026-08-18-gardssalg-set-contact-phone: reuse the SAME write-time
// phone guard the rfb `agent_knowledge` write path already uses (dev-request
// 2026-07-28-rfb-kontaktekstraksjon-orgnr-som-telefon) instead of inventing a
// second phone-shape check for this vertical — see applyGardssalgSetContactPhone
// below for why.
import { validatePhoneForWrite } from "./contact-normalizer";
// dev-request 2026-08-19-kursjustering-drikkefunnel-llm-og-supply, Grep 5b:
// the shared LLM-judge + deterministic-backstop gate (mirrors lokal#655's
// marketplace.ts pattern) that now stands in front of every contact-field
// write this file makes — see gateContactCandidates' own doc comment.
import { gateContactCandidates } from "./contact-candidate-judge";
// dev-request 2026-08-19-kursjustering-drikkefunnel-llm-og-supply, Grep 2b:
// applyGardssalgSetContentField (below) reuses the SAME objective-defect
// classifier the quality-update lever already gates candidates with, rather
// than inventing a second, parallel quality bar for the admin write path.
//
// NB — this is a deliberate module CYCLE: gardssalg-quality-update.ts imports
// isGardssalgFieldOwnerLocked from this file (owner-lock policy A lives here,
// defect/margin policy B+C lives there). It is safe under CommonJS because
// neither side touches the other at MODULE-INIT time — both only call across
// the boundary from inside function bodies, by which point both modules are
// fully evaluated. The alternative (duplicating the classifier here, or
// moving the owner-lock helper) would either fork the policy or churn every
// existing caller, so the cycle is the smaller cost.
import {
  classifyGardssalgFieldDefect,
  type GardssalgDefectType,
  type GardssalgQualityFieldName,
} from "./gardssalg-quality-update";
// dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach, slice 2 —
// reuse the same quality-bar predicate the homepage-content extractor already
// gates candidates with, so applyGardssalgProviderContent() can tell "thin"
// existing content from decent existing content before deciding to replace it.
//
// dev-request 2026-07-20-gardssalg-kvalitetsgate-redesign, slice 2/3/4: this
// gårdssalg-specific gate now uses meetsAboutCheapBar (the cheap, universal
// prefilter — length/mangled-Unicode/boilerplate/Norwegian-check) instead of
// the full meetsAboutQualityBar. By the time a candidate value reaches this
// module, the route's meetsGardssalgAboutQualityBar() cascade
// (routes/opplevelser.ts) has ALREADY run the cheap prefilter + the new LLM
// judge on it — so re-applying the OLD nav-menu-leakage/umbrella-membership
// regex heuristic here would silently re-impose the very heuristic layer
// this dev-request retires for gårdssalg, potentially re-rejecting a
// candidate the LLM judge already approved. Using the cheap-only bar here
// keeps this module's own defense-in-depth check (currentValue "already
// decent" / candidate "itself thin") without depending on the retired
// heuristic. meetsAboutQualityBar itself is UNCHANGED and still used as-is
// by admin-knowledge.ts's unrelated homepage-refresh vertical.
import { meetsAboutCheapBar } from "./search-enrich";
import { buildGardssalgProvenanceSummary, type ProvenanceSummary } from "./cross-source-validator";
// dev-request 2026-07-21-opplevagent-norske-tegn-encoding, criterion 3 —
// mojibake DETECTION (never used to mutate text directly — see
// scanGardssalgProviderRowForMojibake/selectGardssalgMojibakeCandidates
// below and the admin backfill route in routes/opplevelser.ts).
import { containsMojibake, mojibakeSnippet } from "./search-enrich";
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
// registrableDomain: dev-request 2026-07-29-blacklist-backfill-og-
// berikelsestriage, slice 2 — the per-field homepage-provenance screen
// (isContentFieldHomepageSourced below) needs the SAME eTLD+1 comparison
// GET /admin/providers/recently-enriched already uses, not a second
// reimplementation.
import { isDirectoryOrAggregatorHost, hostFromUrlLike, registrableDomain, FREE_MAIL_DOMAINS } from "./cross-source-validator";
// dev-request 2026-08-17-forsyningskjede-samarbeid-og-kvalitetsoppdatering,
// Skive 1: the shared provider_work_queue hand-off table between the
// sweep/berikelse/discovery gårdssalg pipelines — used here only to
// prioritize discovery's own provider selection (see
// selectGardssalgProvidersForWebsiteDiscovery below).
import { listPendingProviderWorkQueue } from "./provider-work-queue";
// dev-request 2026-07-21-gardssalg-soekebasert-nettsidefunn — search-based
// website-discovery candidate source. BraveResult is the shape braveSearch()
// already returns; only the TYPE is needed here (the pure host-extraction
// helper below never calls braveSearch itself — the route wires the real
// network call, see routes/opplevelser.ts).
import type { BraveResult } from "./search-enrich";
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

  // dev-request 2026-07-29-blacklist-backfill-og-berikelsestriage, slice 2
  // FIX-UP (post-approval defect, independent review): mirror
  // applyExperienceContent's per-field provenance discipline at INSERT time
  // too, not just on UPDATE. Every createExperience() call site today is
  // either a harvest/bulk-load ingest (POST /admin/bulk-load's new-experience
  // branch, bulkInsertExperiences()'s new-row branch above) or a hand-curated
  // admin entry (POST /api/opplevelser) — NONE of them is "we just fetched
  // and verified the provider's own homepage" the way the twice-daily
  // content-refresh writer is; that writer only ever UPDATEs an existing row
  // via applyExperienceContent. So a brand-new row's content fields deserve
  // exactly the same provenance discipline applyExperienceContent already
  // applies on every write it makes — including its own bulk-load/re-harvest
  // MATCH branches two call sites away, which already stamp
  // harvestProvenanceOf(evidence_url) unconditionally for whatever they
  // write. Before this fix, content_field_evidence stayed NULL forever on a
  // freshly-inserted row, and isContentFieldHomepageSourced's "no evidence
  // entry -> unknown, keep as homepage-sourced" default silently classified
  // every such provider as `done` for enrichment-selection purposes —
  // reopening the exact bug this slice exists to fix, just relocated from
  // the UPDATE path to the INSERT path. Only fields that actually carry a
  // non-blank value in THIS insert get a provenance entry; a genuinely blank
  // field needs none — isContentFieldHomepageSourced already treats blank as
  // "not homepage content" on its own, independent of evidence.
  const CONTENT_PROVENANCE_FIELDS: Array<[string, unknown]> = [
    ["description", e.description],
    ["category", e.category],
    ["subcategory", e.subcategory],
    ["activity_tags", e.activity_tags && e.activity_tags.length ? e.activity_tags : null],
    ["season", e.season && e.season.length ? e.season : null],
    ["indoor_outdoor", e.indoor_outdoor],
    ["duration_min", e.duration_min],
    ["price_from", e.price_from],
    ["booking_url", e.booking_url],
  ];
  const nonBlankContentFields = CONTENT_PROVENANCE_FIELDS.filter(
    ([, v]) => v !== null && v !== undefined && String(v).trim() !== ""
  );
  let contentFieldEvidence: string | null = null;
  if (nonBlankContentFields.length > 0) {
    const stampUrl = harvestProvenanceOf(e.evidence_url);
    const evidence: Record<string, string> = {};
    for (const [field] of nonBlankContentFields) evidence[field] = stampUrl;
    contentFieldEvidence = JSON.stringify(evidence);
  }

  db.prepare(`
    INSERT INTO experiences (
      id, provider_id, provider_match_status, title, slug, description,
      category, subcategory, activity_tags, season, indoor_outdoor, weather_dependent,
      physical_intensity, duration_min, duration_max, group_min, group_max,
      age_suitability, min_age, price_band, price_from, price_unit,
      languages, accessibility, booking_url, booking_type,
      loc_lat, loc_lon, geo_precision, meeting_point, kommune, fylke,
      discovery_source, content_source, evidence_url, confidence,
      enrichment_state, verification_status, seasonal_valid_from, seasonal_valid_to,
      content_field_evidence
    ) VALUES (
      @id, @provider_id, @provider_match_status, @title, @slug, @description,
      @category, @subcategory, @activity_tags, @season, @indoor_outdoor, @weather_dependent,
      @physical_intensity, @duration_min, @duration_max, @group_min, @group_max,
      @age_suitability, @min_age, @price_band, @price_from, @price_unit,
      @languages, @accessibility, @booking_url, @booking_type,
      @loc_lat, @loc_lon, @geo_precision, @meeting_point, @kommune, @fylke,
      @discovery_source, @content_source, @evidence_url, @confidence,
      @enrichment_state, @verification_status, @seasonal_valid_from, @seasonal_valid_to,
      @content_field_evidence
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
    content_field_evidence: contentFieldEvidence,
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

// dev-request 2026-07-13-proveniens-transparens-side, slice 2 (additive
// public provenance summary): mirrors providerPhoneOf() immediately above —
// same "no fabrication, undefined when the provider has nothing to show"
// discipline, sourced from the provider row's field_provenance +
// brreg_checked_at (the provider's own "most recent verification timestamp"
// — experience_providers has no separate verified_at/last_verified_at
// column; brreg_checked_at is the closest existing verification-style
// timestamp, stamped by setBrregVerification()). Uses
// buildGardssalgProvenanceSummary() because experience_providers.field_provenance
// is a DIFFERENT on-disk shape than agent_knowledge/dental_agents' (see that
// function's doc comment in cross-source-validator.ts).
function providerProvenanceOf(providerId: string | null | undefined): ProvenanceSummary | undefined {
  if (!providerId) return undefined;
  const provider = getProviderById(providerId);
  if (!provider) return undefined;
  let fieldProvenance: Record<string, unknown> | null = null;
  const raw = provider.field_provenance;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        fieldProvenance = parsed as Record<string, unknown>;
      }
    } catch {
      /* tolerate junk JSON, same convention as the writers of this column */
    }
  }
  return buildGardssalgProvenanceSummary(
    fieldProvenance,
    (provider.brreg_checked_at as string | null) ?? null,
    provider.brreg_verified === 1
  );
}

export function getExperienceById(
  id: string
): (Experience & { id: string; tags: ExperienceTag[]; phone: string | null; provenance?: ProvenanceSummary }) | null {
  const db = getDb(VERTICAL);
  const row = db.prepare("SELECT * FROM experiences WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const hydrated = hydrateExperience(row);
  const provenance = providerProvenanceOf(hydrated.provider_id);
  return {
    ...hydrated,
    phone: providerPhoneOf(hydrated.provider_id),
    ...(provenance ? { provenance } : {}),
  };
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

// dev-request 2026-07-19-opplevagent-kart-fylke-gardssalg, slice 1
// (arbeidspunkt 1-3): one map marker's worth of data for /fylke/:fylke.
// Minimal columns only (not the full ExperienceCardRow) — this feeds a
// server-injected JSON island for a Leaflet map, not a card render.
export type ExperienceMapPoint = {
  slug: string;
  title: string;
  title_no: string | null;
  category: string | null;
  kommune: string | null;
  loc_lat: number;
  loc_lon: number;
  geo_precision: "address" | "kommune";
};

/**
 * Published experiences matching an optional category/fylke/provider filter
 * that ALSO have a real geocode. Reuses browseWhere()/PUBLISH_GATE_SQL
 * UNCHANGED (same exact "published" definition as
 * listPublishedExperiences()/countPublishedExperiences()) and appends the
 * same `loc_lat IS NOT NULL AND loc_lon IS NOT NULL` predicate used at the
 * near-me geo filter above (line ~1158) — so the marker count for a given
 * filter is always <= the card-list count for that SAME filter, never a
 * divergent definition of "published" or "has coordinates". geo_precision is
 * additionally constrained NOT NULL so the returned type can be the narrowed
 * "address" | "kommune" union (never a fabricated precision) — in practice a
 * non-null loc_lat/loc_lon pair always carries a non-null geo_precision (the
 * geocode worker sets them together), so this rarely excludes rows in
 * practice; it exists purely so the caller never has to null-check precision.
 */
export function listPublishedExperienceMapPoints(
  filter: BrowseFilter = {}
): ExperienceMapPoint[] {
  const db = getDb(VERTICAL);
  const { sql, params } = browseWhere(filter);
  const rows = db
    .prepare(
      `SELECT e.slug AS slug, e.title AS title, e.title_no AS title_no,
              e.category AS category, e.kommune AS kommune,
              e.loc_lat AS loc_lat, e.loc_lon AS loc_lon,
              e.geo_precision AS geo_precision
       FROM experiences e
       LEFT JOIN experience_providers p ON p.id = e.provider_id
       WHERE ${sql}
         AND e.loc_lat IS NOT NULL AND e.loc_lon IS NOT NULL AND e.geo_precision IS NOT NULL
       ${CARD_ORDER}`
    )
    .all(params) as Array<{
      slug: string;
      title: string;
      title_no: string | null;
      category: string | null;
      kommune: string | null;
      loc_lat: number;
      loc_lon: number;
      geo_precision: "address" | "kommune";
    }>;
  return rows;
}

/** Distinct categories that have ≥1 PUBLISHED experience (with counts). Drives
 *  the homepage cards, the /opplevelser facet list, and the sitemap category
 *  URLs — so every linked category page is guaranteed non-empty.
 *  `lastmod` = MAX(updated_at) of the published rows composing this category —
 *  real per-aggregate freshness for the sitemap (GSC 2026-07 opplevagent
 *  indekseringsfiks, "sitemap lastmod honesty" — no blanket "today"), same
 *  MAX(updated_at)-over-the-underlying-rows pattern rfb's city lastmod uses
 *  (PR #302). Additive column; other callers (facetChips()) ignore it. */
export function listPublishedCategories(): Array<{ category: string; count: number; lastmod: string | null }> {
  const db = getDb(VERTICAL);
  return db
    .prepare(
      `SELECT e.category AS category, COUNT(*) AS count, MAX(e.updated_at) AS lastmod FROM experiences e
       LEFT JOIN experience_providers p ON p.id = e.provider_id
       WHERE e.category IS NOT NULL AND e.category != '' AND ${PUBLISH_GATE_SQL}
       GROUP BY e.category ORDER BY count DESC, e.category ASC`
    )
    .all() as Array<{ category: string; count: number; lastmod: string | null }>;
}

/** Distinct fylker that have ≥1 PUBLISHED experience (with counts). `lastmod` =
 *  MAX(updated_at) of the underlying rows — see listPublishedCategories() doc. */
export function listPublishedFylker(): Array<{ fylke: string; count: number; lastmod: string | null }> {
  const db = getDb(VERTICAL);
  return db
    .prepare(
      `SELECT e.fylke AS fylke, COUNT(*) AS count, MAX(e.updated_at) AS lastmod FROM experiences e
       LEFT JOIN experience_providers p ON p.id = e.provider_id
       WHERE e.fylke IS NOT NULL AND e.fylke != '' AND ${PUBLISH_GATE_SQL}
       GROUP BY e.fylke ORDER BY count DESC, e.fylke ASC`
    )
    .all() as Array<{ fylke: string; count: number; lastmod: string | null }>;
}

/** Distinct kommuner that have ≥1 PUBLISHED experience — with the fylke they sit
 *  in + counts. Drives the /kommune/<x> place pages, the kommune cross-links on
 *  /fylke/<x>, and the sitemap kommune URLs, so every linked kommune page is
 *  guaranteed non-empty (zero orphan/dead entries). One row per distinct kommune
 *  name (MAX(fylke) picks a representative fylke for the breadcrumb/up-link).
 *  `lastmod` = MAX(updated_at) of the underlying rows — see
 *  listPublishedCategories() doc. */
export function listPublishedKommuner(): Array<{ kommune: string; fylke: string | null; count: number; lastmod: string | null }> {
  const db = getDb(VERTICAL);
  return db
    .prepare(
      `SELECT e.kommune AS kommune, MAX(e.fylke) AS fylke, COUNT(*) AS count, MAX(e.updated_at) AS lastmod FROM experiences e
       LEFT JOIN experience_providers p ON p.id = e.provider_id
       WHERE e.kommune IS NOT NULL AND e.kommune != '' AND ${PUBLISH_GATE_SQL}
       GROUP BY e.kommune ORDER BY count DESC, e.kommune ASC`
    )
    .all() as Array<{ kommune: string; fylke: string | null; count: number; lastmod: string | null }>;
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
  // MAX(updated_at) of the underlying published rows in this combo — real
  // per-aggregate freshness for the sitemap (see listPublishedCategories() doc).
  lastmod: string | null;
};
export function listProduktByCombos(): ProduktByComboRow[] {
  const db = getDb(VERTICAL);
  return db
    .prepare(
      `SELECT e.category AS category, e.kommune AS kommune,
              COUNT(*) AS total,
              COUNT(DISTINCT e.provider_id) AS providerCount,
              MIN(e.price_from) AS minPriceFrom,
              MAX(e.updated_at) AS lastmod
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

/** Distinct providers that have ≥1 PUBLISHED experience (id, name, counts).
 *  `lastmod` = MAX(updated_at) of that provider's own published experiences —
 *  real per-aggregate freshness for the sitemap (see listPublishedCategories()
 *  doc). */
export type PublishedProviderRow = {
  id: string;
  slug: string | null;
  navn: string;
  fylke: string | null;
  kommune: string | null;
  count: number;
  lastmod: string | null;
};
export function listPublishedProviders(): PublishedProviderRow[] {
  const db = getDb(VERTICAL);
  return db
    .prepare(
      `SELECT p.id AS id, p.slug AS slug, p.navn AS navn, p.fylke AS fylke, p.kommune AS kommune,
              COUNT(*) AS count, MAX(e.updated_at) AS lastmod
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
            // Harvest-row content: its provenance is the third-party listing at
            // row.evidence_url, never the provider's homepage (round-5 review).
            // When the row carries no evidence_url, `null` would have meant
            // "unknown", which the endpoint keeps and serves as judgeable —
            // re-opening the round-4 leak for exactly those rows. We DO know
            // this is harvest-sourced, so say so (round-7 review, M4).
            }, harvestProvenanceOf(row.evidence_url));
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
  // dev-request 2026-08-02-opplevagent-hjemmesideverifisering-og-enrichment-
  // gate, Steg 3 — raw field_provenance JSON (same defensive-parse pattern
  // as GardssalgContentRefreshTarget.field_provenance below), read here so
  // the general content-refresh route can gate its fetch on
  // isHjemmesideVerified(t.field_provenance) (routes/opplevelser.ts) without
  // a second query. NOTE: `hjemmeside` above can be a COALESCE fallback to
  // an experience's evidence_url when the provider's own `hjemmeside` column
  // is blank (see selectProvidersForContentRefresh's SQL) — the
  // website-verification classifier only ever classifies the PROVIDER's own
  // hjemmeside column, so a fallback-sourced target reads as
  // "missing_source" (verified=false) here and is gated closed too. That is
  // the deliberate, fail-closed choice: the fallback URL was never itself
  // ownership-verified, so it must not be trusted as an enrichment source
  // either.
  field_provenance: string | null;
};

/**
 * Why selectProvidersForContentRefresh() below is a select-loop instead of a
 * one-shot SELECT ... LIMIT (2026-08-01, dev-request selector-window fix):
 *
 * `last_content_attempt_at` is stamped ONLY on providers that actually get
 * processed by POST /admin/content-refresh (markProviderContentAttempted,
 * called unconditionally in apply mode before the fetch). A candidate the SQL
 * pre-filter below fetches but the JS classifyProviderContentBucket() step
 * then discards as not-"enrichable" is NEVER stamped — it keeps
 * last_content_attempt_at IS NULL and therefore sorts first FOREVER under the
 * NULLs-first `ORDER BY (last_content_attempt_at IS NOT NULL), ...` (see the
 * content-refresh-attempt-tracking regression guard above this function for
 * why NULLs-first ordering exists at all). Once that permanently-NULL clump
 * grows past a single window, it silently buries every genuinely-enrichable
 * row behind it — the selector then returns 0 candidates and the route
 * honestly has nothing to say except "nothing found", which downstream cron
 * reporting mistook for real cohort exhaustion (measured live 2026-07-31:
 * limit=3 -> window 200 -> scanned=0; limit=25 -> window 300 -> scanned=0;
 * limit=100 -> window 1000 -> scanned=88 candidates behind the NULL clump).
 *
 * Fix: page through the SAME SQL pre-filter/ORDER BY with an advancing
 * OFFSET, filtering each page in JS, until EITHER (a) `cap` enrichable
 * providers have been found, (b) the SQL side is genuinely exhausted (a page
 * returns fewer rows than requested — end of table), or (c) the hard
 * CONTENT_REFRESH_HARD_SCAN_CAP total-rows-scanned budget is spent (so one
 * call can never scan the whole catalog). The three outcomes are reported
 * back as `stopReason` so the route can tell an honest "nothing left"
 * (real-exhaustion) apart from "stopped early, there may be more"
 * (scan_cap_reached) instead of conflating both into one silent zero.
 */
export type ContentRefreshStopReason = "cap_reached" | "real-exhaustion" | "scan_cap_reached";

export type ContentRefreshSelection = {
  targets: ContentRefreshTarget[];
  /** Total SQL candidate rows examined (summed across all pages this call). */
  scanned: number;
  stopReason: ContentRefreshStopReason;
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

// Over-fetch window for the candidate pre-filter below (per SQL page), same
// pattern as GET /admin/providers/recently-enriched's EXP_ROW_WINDOW
// (round-5 review of dev-request 2026-07-27-kvalitetsporter-uten-signal
// established WHY: the per-field provenance check cannot be expressed in
// SQL — it parses JSON and compares registrable domains — so it has to run
// in JS AFTER a broad SQL pre-filter and BEFORE the final LIMIT. Filtering
// post-LIMIT would mean a page full of aggregator-only candidates returns
// fewer than `cap` results even when genuinely-thin providers exist further
// down the ordering.
const CONTENT_REFRESH_CANDIDATE_WINDOW_MULTIPLIER = 12;
const CONTENT_REFRESH_CANDIDATE_WINDOW_MAX = 1000;

// Hard ceiling on total SQL candidate rows examined across ALL pages of a
// single selectProvidersForContentRefresh() call (2026-08-01 selector-window
// fix — see the doc comment above ContentRefreshSelection for the bug this
// paginated loop fixes). Without a bound, a cohort with a very long run of
// non-enrichable rows ahead of any enrichable one could make one call page
// through the entire experience_providers table. 5000 is deliberately well
// above any single-page window (max 1000) so normal cohorts never come
// close to it, while still being a bounded, sane per-call ceiling.
export const CONTENT_REFRESH_HARD_SCAN_CAP = 5000;

export function selectProvidersForContentRefresh(limit = 25): ContentRefreshSelection {
  const db = getDb(VERTICAL);
  const cap = Math.max(1, Math.min(100, limit));
  const pageSize = Math.min(
    CONTENT_REFRESH_CANDIDATE_WINDOW_MAX,
    Math.max(200, cap * CONTENT_REFRESH_CANDIDATE_WINDOW_MULTIPLIER)
  );

  const pageStmt = db.prepare(
    `SELECT p.id AS id, p.navn AS navn,
            COALESCE(
              CASE WHEN p.hjemmeside IS NOT NULL AND TRIM(p.hjemmeside) != ''
                   THEN TRIM(p.hjemmeside) END,
              (SELECT TRIM(e2.evidence_url)
                 FROM experiences e2
                WHERE e2.provider_id = p.id
                  AND e2.evidence_url IS NOT NULL AND TRIM(e2.evidence_url) != ''
                LIMIT 1)
            ) AS hjemmeside,
            p.field_provenance AS field_provenance
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
          -- BROAD pre-filter only: "an unlocked, live experience exists at
          -- all". Deliberately no longer requires a BLANK field here — that
          -- was exactly the bug (dev-request 2026-07-29-blacklist-backfill-
          -- og-berikelsestriage, slice 2): a non-blank but
          -- aggregator-sourced field must still reach the per-field
          -- provenance check below (isExperienceContentGenuinelyThin /
          -- classifyProviderContentBucket — the SAME shared classifier the
          -- berikelsestriage triage endpoint uses), which SQL alone cannot
          -- express.
          -- NULL-guarded on verification_status (round-3-review fix,
          -- mirrored from GET .../recently-enriched): SQL three-valued
          -- logic makes "NULL != 'verified'" evaluate to NULL, excluding
          -- the row, while isExperienceContentLocked treats a NULL
          -- verification_status as UNLOCKED. Latent today (createExperience
          -- coalesces to 'pending_verify'), cheap to keep correct.
          SELECT 1 FROM experiences e
           WHERE e.provider_id = p.id
             AND (e.verification_status IS NULL OR e.verification_status != 'verified')
             AND (e.content_source IS NULL OR e.content_source NOT IN ('manual','claim'))
             AND e.canonical_id IS NULL
        )
        ${providerParkingExclusionSql("p")}
        ${noYieldBackoffExclusionSql("p")}
      ORDER BY (p.last_content_attempt_at IS NOT NULL), p.last_content_attempt_at ASC, p.created_at ASC
      LIMIT ? OFFSET ?`
  );

  const experiencesStmt = db.prepare(
    `SELECT description, category, content_source, verification_status,
            content_field_evidence, evidence_url, canonical_id
       FROM experiences WHERE provider_id = ?`
  );

  const out: ContentRefreshTarget[] = [];
  let offset = 0;
  let totalScanned = 0;
  let stopReason: ContentRefreshStopReason = "real-exhaustion";

  // Paginate the SQL pre-filter (same ORDER BY, advancing OFFSET) until cap
  // enrichable providers are found, the SQL side runs out of rows (a page
  // comes back shorter than requested), or the hard scan-cap budget is
  // spent — see the doc comment above ContentRefreshSelection for why this
  // replaced a single fetch-then-filter pass.
  while (true) {
    if (totalScanned >= CONTENT_REFRESH_HARD_SCAN_CAP) {
      stopReason = "scan_cap_reached";
      break;
    }

    const fetchSize = Math.min(pageSize, CONTENT_REFRESH_HARD_SCAN_CAP - totalScanned);
    const page = pageStmt.all(fetchSize, offset) as Array<{
      id: string; navn: string; hjemmeside: string | null; field_provenance: string | null;
    }>;

    totalScanned += page.length;
    offset += page.length;

    for (const row of page) {
      if (!row.hjemmeside || !row.hjemmeside.trim()) continue;
      const experiences = experiencesStmt.all(row.id) as BucketableExperienceRow[];
      if (classifyProviderContentBucket(row.hjemmeside, experiences) !== "enrichable") continue;
      out.push({ id: row.id, navn: row.navn, hjemmeside: row.hjemmeside.trim(), field_provenance: row.field_provenance });
      if (out.length >= cap) break;
    }

    if (out.length >= cap) {
      stopReason = "cap_reached";
      break;
    }
    if (page.length < fetchSize) {
      // SQL side returned fewer rows than requested at this offset: there is
      // genuinely nothing left to page through. Honest exhaustion.
      stopReason = "real-exhaustion";
      break;
    }
    if (totalScanned >= CONTENT_REFRESH_HARD_SCAN_CAP) {
      // Full page delivered exactly at the budget boundary — we cannot tell
      // whether more rows exist beyond it without another fetch, and the
      // budget forbids that. Report the cap, not an unproven exhaustion.
      stopReason = "scan_cap_reached";
      break;
    }
    // else: SQL side had more to give and we haven't hit cap/budget — page again.
  }

  return { targets: out, scanned: totalScanned, stopReason };
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
      `SELECT id, navn, TRIM(hjemmeside) AS hjemmeside, field_provenance
         FROM experience_providers WHERE id = ?`
    )
    .get(providerId) as
    | { id: string; navn: string; hjemmeside: string | null; field_provenance: string | null }
    | undefined;
  if (!row || !row.hjemmeside || row.hjemmeside.trim().length === 0) return null;
  return { id: row.id, navn: row.navn, hjemmeside: row.hjemmeside.trim(), field_provenance: row.field_provenance };
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

// ── Berikelsestriage classification (dev-request 2026-07-29-blacklist-
// backfill-og-berikelsestriage, slice 2) ────────────────────────────────
//
// `applyExperienceContent` (below) stamps `content_source = 'provider_site'`
// UNCONDITIONALLY on every write — both a real homepage fetch AND a
// harvest/aggregator-sourced re-write (the two bulk-load call sites
// documented on that function) end up with the identical stamp. So
// `content_source` alone can never tell "this field really came from the
// provider's own site" from "this field came from a third-party aggregator
// row that happened to score richer on a re-harvest". `content_field_evidence`
// (per FIELD, JSON: field name -> source URL/sentinel) is what CAN answer
// that — compare its registrable domain against the provider's own
// hjemmeside. This is the exact per-field provenance screen GET
// /admin/providers/recently-enriched already runs for the platform-verifier
// spot-check (dev-request 2026-07-27-kvalitetsporter-uten-signal, slice C,
// rounds 6-7 review) — pulled out here into standalone functions so BOTH
// selectProvidersForContentRefresh (the live selector) and the
// berikelsestriage triage endpoint share exactly one implementation. Two
// independent re-implementations of "is this genuinely homepage content?"
// WILL drift; a shared function cannot.

/** Parse `experiences.content_field_evidence` defensively — malformed/absent
 *  -> {} (never throws). A missing/malformed entry for a field means "unknown
 *  provenance", not "definitely not the homepage" — see
 *  isContentFieldHomepageSourced. */
export function parseContentFieldEvidence(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    /* malformed -> treat as unknown, i.e. keep (same convention as the
       recently-enriched endpoint's identical parse) */
  }
  return {};
}

/** The provider-level homepage domain a field's evidence is compared
 *  against — `hostFromUrlLike` + `registrableDomain`, or null when there is
 *  no usable homepage string at all. */
export function homepageRegistrableDomain(hjemmeside: string | null | undefined): string | null {
  if (!hjemmeside) return null;
  const host = hostFromUrlLike(hjemmeside);
  return host ? registrableDomain(host) : null;
}

/**
 * True when a judged content field's CURRENT value counts as genuinely
 * homepage-sourced: non-blank, AND (no evidence-map entry for this field —
 * unknown provenance is KEPT, never invented as a gap, matching
 * GET .../recently-enriched's identical convention — OR the recorded
 * evidence URL's registrable domain matches the provider's own homepage
 * domain). A present evidence entry on a DIFFERENT domain is a mismatch, not
 * unknown (round-7 review of dev-request 2026-07-27-kvalitetsporter-uten-
 * signal, M4) — that is precisely the aggregator-leak case this function
 * exists to catch.
 */
export function isContentFieldHomepageSourced(
  value: string | null | undefined,
  field: string,
  evidence: Record<string, string>,
  homepageDomain: string | null,
): boolean {
  if (value === null || value === undefined || String(value).trim() === "") return false;
  const src = evidence[field];
  if (!src || !homepageDomain) return true; // unknown provenance -> keep
  const srcHost = hostFromUrlLike(src);
  if (srcHost && registrableDomain(srcHost) === homepageDomain) return true;
  return false; // recorded source is a different domain -> not the homepage
}

/** The fields `selectProvidersForContentRefresh`'s "thin" gate has always
 *  judged — description and category. Deliberately NOT widened to
 *  booking_url/subcategory/etc: those are outside this fix's scope (the
 *  recently-enriched endpoint's own JUDGED_FIELDS list is a SEPARATE,
 *  wider set for a different consumer — the weekly spot-check — and this
 *  constant intentionally does not chase it). */
export const THIN_CONTENT_JUDGED_FIELDS = ["description", "category"] as const;

/**
 * True when an experience row is a genuine content-refresh candidate: it is
 * UNLOCKED (isExperienceContentLocked) AND at least one of
 * description/category is NOT genuinely homepage-sourced — either truly
 * blank, or non-blank but recorded (content_field_evidence) as coming from a
 * different domain than the provider's own homepage (the aggregator-leak
 * case).
 *
 * This is the CORRECTED "thin" predicate (dev-request 2026-07-29-blacklist-
 * backfill-og-berikelsestriage, slice 2). Before this change,
 * selectProvidersForContentRefresh's SQL tested only
 * "description IS NULL OR TRIM='' OR category IS NULL OR TRIM='' " — ANY
 * non-blank value, regardless of provenance, counted as "not thin". A
 * description filled by a re-harvest from a third-party aggregator row (see
 * applyExperienceContent's own doc comment on its two bulk-load call sites)
 * therefore permanently blocked that row from ever being refreshed from the
 * provider's REAL homepage — exactly the bug this function fixes.
 */
export function isExperienceContentGenuinelyThin(
  row: {
    content_source?: string | null;
    verification_status?: string | null;
    description?: string | null;
    category?: string | null;
    content_field_evidence?: string | null;
  },
  homepageDomain: string | null,
): boolean {
  if (isExperienceContentLocked(row)) return false;
  const evidence = parseContentFieldEvidence(row.content_field_evidence);
  for (const field of THIN_CONTENT_JUDGED_FIELDS) {
    const value = field === "description" ? row.description : row.category;
    if (!isContentFieldHomepageSourced(value, field, evidence, homepageDomain)) return true;
  }
  return false;
}

export type ProviderContentBucket = "enrichable" | "done" | "waiting";

export type BucketableExperienceRow = {
  content_source?: string | null;
  verification_status?: string | null;
  description?: string | null;
  category?: string | null;
  content_field_evidence?: string | null;
  evidence_url?: string | null;
  canonical_id?: string | null;
};

/**
 * The berikelsestriage bucket classifier — the SINGLE function BOTH
 * `selectProvidersForContentRefresh` (the live enrichment selector) and the
 * triage endpoint (GET /admin/providers/content-triage) call, so the two can
 * never independently drift on what counts as "genuinely done" (dev-request
 * 2026-07-29-blacklist-backfill-og-berikelsestriage, slice 2: "prefer
 * classifying bucket membership SERVER-SIDE ... computed by a SHARED
 * function also used by the live selector").
 *
 * Buckets (mirrors the dev-request's table verbatim):
 *   waiting    — no usable hjemmeside: `hjemmeside` blank AND no live
 *                experience carries a usable `evidence_url` fallback (the
 *                SAME fallback selectProvidersForContentRefresh's own SQL
 *                COALESCE already uses today). Never guessed at.
 *   enrichable — has a usable hjemmeside AND at least one live, UNLOCKED
 *                experience is genuinely thin (isExperienceContentGenuinelyThin).
 *   done       — has a usable hjemmeside AND no live experience is
 *                genuinely thin. This deliberately covers two edge cases:
 *                  (a) a provider with a homepage but ZERO live
 *                      experiences — there is nothing to enrich, so it can
 *                      never be selected by selectProvidersForContentRefresh
 *                      either; "done" here means "nothing left to do", not
 *                      literally "content was filled".
 *                  (b) a provider whose only live experiences are LOCKED
 *                      (manual/claim/verified) — those rows are never
 *                      touched by the automated writer regardless of
 *                      whether their content is blank, so they are
 *                      permanently out of scope the same way (a) is.
 *                Documented rule, not an accident: both are "the automated
 *                content-refresh writer will never touch this provider
 *                again", which is exactly what the `done` bucket's
 *                consequence ("skipped") means.
 * "Live" experiences exclude dedup-merged rows (`canonical_id IS NOT NULL`)
 * — the same convention enforced everywhere else `experiences` is read
 * (PUBLISH_GATE_SQL, listCategories, GET .../recently-enriched, the corridor
 * pages, the dedup candidate loader).
 *
 * Mixed multi-experience providers: "ANY genuinely-thin live experience ->
 * enrichable" — matching selectProvidersForContentRefresh's own EXISTS
 * semantics exactly (a provider is selected the moment content-refresh has
 * ANY work left to do for it, not only once ALL its experiences are thin).
 */
export function classifyProviderContentBucket(
  hjemmeside: string | null | undefined,
  experiences: BucketableExperienceRow[],
): ProviderContentBucket {
  const live = experiences.filter((e) => !e.canonical_id);

  let homepageRaw = hjemmeside && hjemmeside.trim() ? hjemmeside.trim() : null;
  if (!homepageRaw) {
    const withEvidence = live.find((e) => e.evidence_url && e.evidence_url.trim());
    homepageRaw = withEvidence ? withEvidence.evidence_url!.trim() : null;
  }
  if (!homepageRaw) return "waiting";

  const homepageDomain = homepageRegistrableDomain(homepageRaw);

  for (const exp of live) {
    if (isExperienceContentGenuinelyThin(exp, homepageDomain)) return "enrichable";
  }
  return "done";
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
/** Recorded as a field's source when content comes from a harvest row that
 *  carries no `evidence_url`. Deliberately not a URL: it must not resolve to
 *  the provider's homepage, so the projection blanks the field rather than
 *  serving harvest text as homepage-sourced. */
export const HARVEST_PROVENANCE_SENTINEL = "harvest:no-evidence-url";

/** Recorded when a caller passes a source URL that is present but BLANK. A
 *  caller handing us a string is claiming to know where the content came from;
 *  if the string is empty the claim is empty too, and treating that as "no
 *  provenance at all" silently skipped the stamp — after which the projection
 *  reads the field as unknown-therefore-keep and serves it as homepage-sourced.
 *  Failing closed to a non-URL sentinel blanks it instead. An explicit `null`
 *  stays different: it says the caller has no provenance concept, not that it
 *  had one and lost it. (Independent review round 8, BLOCKING — reached via
 *  `evidence_url: z.string().optional().nullable()`, where "" validates, so
 *  `?? SENTINEL` fell through and "" arrived here.) */
export const BLANK_PROVENANCE_SENTINEL = "unknown:blank-source-url";

/** The provenance value for content lifted from a harvest ROW. Both harvest
 *  call sites go through this rather than repeating the expression, so the
 *  `?.trim() ||` cannot be right in one place and `??` in the other — which is
 *  how it stood when review found it. Only one of the two call sites is
 *  reachable from a test without a Brreg-mocking route harness, so making them
 *  share one function is what lets the tested one stand for both; a reviewer
 *  checks the untested site by confirming it calls this, one readable line. */
export function harvestProvenanceOf(evidenceUrl: string | null | undefined): string {
  return evidenceUrl?.trim() || HARVEST_PROVENANCE_SENTINEL;
}

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
  },
  // Where this CONTENT came from — the URL actually fetched and extracted from.
  // Round-5 review of dev-request 2026-07-27-kvalitetsporter-uten-signal: this
  // writer stamps `content_source = 'provider_site'` unconditionally, but its
  // three callers are not equivalent. The twice-daily content-refresh really did
  // fetch the provider's homepage; the two bulk-load paths hand it a THIRD-PARTY
  // HARVEST ROW on a re-harvest that scored richer. Both used to end up labelled
  // 'provider_site' with nothing in the row to tell them apart, so a spot-check
  // that judges the text against the provider's homepage scores a false
  // `mismatch` on the harvest-written ones — and §8.4 pauses enrichment writes
  // for the whole vertical above a 10% error rate.
  //
  // `experiences.evidence_url` cannot answer this: it is DISCOVERY provenance,
  // written once at createExperience() and never updated. Mirrors
  // experience_providers.content_evidence_url, stamped by applyProviderContent.
  // Optional: omitting it leaves the column untouched (NULL = unknown, never
  // treated as a mismatch), so no caller is forced to lie.
  // REQUIRED, not optional (round-6 review). As an optional parameter every
  // one of the three call sites could drop its argument with the whole suite
  // green: NULL means "unknown", unknown means "served", and the aggregator
  // leak reopens silently. Making it required turns three untested guards into
  // compile errors. Pass null explicitly when there genuinely is no source.
  sourceUrl: string | null
): string[] {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT id, description, category, subcategory, activity_tags, season,
              indoor_outdoor, duration_min, price_from, booking_url,
              content_source, content_field_evidence, verification_status
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

  // PER-FIELD provenance, not one URL for the row (round-6 review, BLOCKING).
  //
  // The round-5 version stamped a single `content_evidence_url` for the whole
  // row on every write. But this function writes only fields that are currently
  // BLANK, so one row's fields are routinely filled by different sources at
  // different times — and a row-level column records only the most recent one.
  // That mislabels in both directions, reopening the exact harms rounds 4 and 5
  // were about:
  //
  //   harvest writes description (aggregator), then a homepage refresh writes
  //   `season` -> the whole row now reads as homepage-sourced, so the
  //   aggregator description is judged against the homepage and scores a false
  //   `mismatch`, which trips the §8.4 write-pause;
  //
  //   homepage writes description, then a re-harvest writes `booking_url`
  //   -> the row now reads as aggregator-sourced and is dropped, though its
  //   description really is homepage content: a fresh route to `checked=0`.
  //
  // Both orderings are ordinary production sequences. And the consumer judges
  // PER FIELD (description / category / booking_url, platform-verifier §8.3),
  // so a single row-level value cannot answer the question being asked.
  //
  // The `isBlank` gate above is what makes a per-field map cheap AND stable: a
  // field only appears in `written` when it was blank and is being filled now,
  // so recording this call's source for exactly those keys is always correct.
  // MERGE into any existing map rather than replacing it — that is the whole
  // point; replacing is what the row-level column did.
  //
  // Deliberately no "never overwrite an existing key" guard. I wrote one, and
  // mutation testing showed it both unreachable (a field in `written` was blank,
  // so a stale key for it means the value was cleared out-of-band) and wrong in
  // the one case that can reach it: a re-filled field genuinely came from the
  // new source. A guard that cannot be falsified and would be incorrect if it
  // could is worse than no guard.
  // Normalize at the boundary rather than trusting each call site to do it.
  // Two of them used `?? SENTINEL`, which only falls through on null/undefined,
  // so a blank `evidence_url` reached this line and skipped the stamp entirely.
  // Fixing the call sites fixes those two; normalizing here closes the class.
  const stampUrl =
    typeof sourceUrl === "string" ? sourceUrl.trim() || BLANK_PROVENANCE_SENTINEL : null;
  if (stampUrl && written.length > 0) {
    let evidence: Record<string, string> = {};
    const priorRaw = (row as { content_field_evidence?: string | null }).content_field_evidence;
    if (priorRaw) {
      try {
        const parsed = JSON.parse(priorRaw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          evidence = parsed as Record<string, string>;
        }
      } catch { /* malformed -> start fresh rather than throw on a content write */ }
    }
    for (const field of written) {
      evidence[field] = stampUrl;
    }
    sets.push("content_field_evidence = @content_field_evidence");
    params.content_field_evidence = JSON.stringify(evidence);
  }

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
//
// dev-request 2026-08-06-opplevagent-ux-loft-drikkested-lansering, S3: the
// optional trailing `filter` parameter (here and on listGardssalgProviders()/
// listGardssalgProviderMapPoints()) narrows the SAME provider set to rows
// whose LOWER(producer_type) matches one of filter.producerTypes — feeds the
// /kategori/gardssalg/<typeSlug> subpages. STRICTLY additive: when the filter
// is omitted/empty the built SQL string is byte-identical to before this
// parameter existed, so every pre-S3 caller behaves exactly as it always has.
// The IN-list is bound parameters (never string-interpolated values), and the
// predicate is appended AFTER the existing base gate so catalog_hidden=1 rows
// can never leak through any filter combination. NULL producer_type rows
// never match any type filter (LOWER(NULL) IS NULL → not IN) — deliberate:
// NULL-type rfb-seed rows belong to the unfiltered base catalog only, and
// isGardssalgDrinkType() (which counts NULL as drink) must NOT be used here.
export type GardssalgProviderTypeFilter = { producerTypes?: string[] };

function gardssalgTypeFilterSql(filter?: GardssalgProviderTypeFilter): { sql: string; params: string[] } {
  const types = (filter?.producerTypes ?? [])
    .map((t) => String(t).toLowerCase())
    .filter((t) => t.length > 0);
  if (types.length === 0) return { sql: "", params: [] };
  return {
    sql: ` AND LOWER(producer_type) IN (${types.map(() => "?").join(",")})`,
    params: types,
  };
}

export function countGardssalgProviders(filter?: GardssalgProviderTypeFilter): number {
  const db = getDb(VERTICAL);
  const typeFilter = gardssalgTypeFilterSql(filter);
  const row = db
    .prepare(
      "SELECT COUNT(*) AS c FROM experience_providers " +
      // Parens are load-bearing: without them the trailing AND would bind
      // tighter than the OR and change the set. catalog_hidden=1 rows (the
      // hidden booking-flyt-v1 test provider) never bump the count that gates
      // gardssalgVisible() (dev-request 2026-07-14-booking-flyt-v1, slice 0).
      "WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed') " +
      "AND (catalog_hidden IS NULL OR catalog_hidden != 1)" +
      typeFilter.sql
    )
    .get(...typeFilter.params) as { c: number };
  return row.c;
}

// Per-type breakdown of the SAME provider set countGardssalgProviders()
// counts (dev-request 2026-08-06-opplevagent-ux-loft-drikkested-lansering,
// S2 — feeds the homepage drikkested feature section's type chips; S3 will
// reuse it). The WHERE clause is deliberately byte-for-byte the one above:
// parens around the OR are load-bearing (without them the trailing AND binds
// tighter than the OR and changes the set), and catalog_hidden=1 rows (the
// hidden booking-flyt-v1 test provider) must never appear in any per-type
// count either. producer_type comes back VERBATIM (NULL included, as its own
// row — rfb-seed rows without a type are part of the gate's set and the
// caller decides how to present them). Read-only; no join, very fast.
export function countGardssalgProvidersByType(): Array<{ producer_type: string | null; count: number }> {
  const db = getDb(VERTICAL);
  return db
    .prepare(
      "SELECT producer_type, COUNT(*) AS count FROM experience_providers " +
      "WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed') " +
      "AND (catalog_hidden IS NULL OR catalog_hidden != 1) " +
      "GROUP BY producer_type"
    )
    .all() as Array<{ producer_type: string | null; count: number }>;
}

// Bookable subset of countGardssalgProviders()'s SAME provider set — same
// WHERE clause (parens around the OR load-bearing, see that function's own
// comment) plus a booking_live = 1 filter. dev-request 2026-07-19-
// opplevagent-forside-seksjoner-design, arbeidspunkt 1 (slice 6): feeds the
// homepage #drikkested feature section's dark-launch-vs-live CTA copy — the
// section is "live" only when this count is > 0 AND bookingDispatchEnabled()
// (src/services/booking-store.ts) is also true; the caller decides that
// combination, this function only reports the real-provider booking_live=1
// count. catalog_hidden=1 rows (the hidden booking-flyt-v1 test provider)
// are excluded, same as every other gårdssalg count in this file — a hidden
// test provider must never flip the section into "live" copy. Read-only; no
// join, very fast.
export function countGardssalgProvidersBookable(): number {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      "SELECT COUNT(*) AS c FROM experience_providers " +
      "WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed') " +
      "AND (catalog_hidden IS NULL OR catalog_hidden != 1) " +
      "AND booking_live = 1"
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
  // (listGardssalgProviders()/countGardssalgProviders() filter it) AND, as of
  // the 2026-08-17 P0 consent-bug fix, also out of slug lookup
  // (getGardssalgProviderBySlug() now filters it too — see that function's own
  // doc comment for why: a hidden row must be unreachable via its public
  // produsent-profil page, JSON-LD, and booking flow, not just the grid). 0/NULL
  // = today's behavior (visible). Set by the admin test-provider endpoint (its
  // own row) AND by POST /admin/gardssalg-provider-visibility (the CS
  // "fjern oss" delist lever for real producers) — both flows share this one
  // column/semantics.
  catalog_hidden: number | null;
  // Additive (2026-07-25, GSC opplevagent indekseringsfiks, sitemap lastmod
  // honesty item): the provider row's own updated_at — a real per-row
  // freshness signal for the /kategori/gardssalg/produsent/<slug> sitemap
  // entry (same "row.updated_at || today" pattern the /opplevelse/<slug>
  // sitemap loop already uses), instead of a blanket "today" on every request.
  updated_at: string | null;
  // Additive (2026-08-03, dev-request 2026-08-03-claim-bekreftet-merke-og-
  // innlogging): the historical "has this provider ever been claimed"
  // timestamp, stamped once (idempotently) by verifyClaimToken()
  // (services/gardssalg-claim.ts) the first time the owner's magic link is
  // used — never cleared by a later revoke/logout. Distinct from the live,
  // revocable isGardssalgProviderClaimed() query: this is what the
  // /kategori/gardssalg/produsent/<slug> route reads to decide the
  // "Bekreftet av eier" badge vs. the "Er dette din bedrift?" claim CTA.
  // NULL = never claimed.
  claimed_at: string | null;
  // Additive (2026-08-18, dev-request 2026-08-17-kontaktadresse-feilkilde-og-
  // override, Skive C): the row's raw field_provenance JSON blob. Selected
  // here so the RENDER surfaces (routes/experiences-seo.ts's produsent-profil
  // page + its JSON-LD) can read the contact_email_flagged_review stamp and
  // suppress an email whose domain deviates from the homepage domain until a
  // human resolves it (AC4 — "Hull 1"). Kept as the raw string and never
  // parsed here: every consumer parses defensively through its own
  // fail-closed reader (isGardssalgContactEmailFlaggedForReview /
  // isGardssalgContactEmailOverrideActive, routes/opplevelser.ts). NULL on
  // most rows.
  field_provenance: string | null;
};

const GARDSSALG_PROVIDER_COLUMNS =
  "id, navn, hjemmeside, fylke, kommune, poststed, producer_type, enrichment_state, slug, adresse, lat, lon, geocode_confidence, epost, telefon, about_text, visit_text, opening_hours_text, products, booking_live, catalog_hidden, updated_at, claimed_at, field_provenance";

export function listGardssalgProviders(limit = 100, offset = 0, filter?: GardssalgProviderTypeFilter): GardssalgProviderRow[] {
  const db = getDb(VERTICAL);
  // Optional S3 type filter — see countGardssalgProviders()'s doc comment;
  // omitted/empty filter builds the exact pre-S3 SQL string.
  const typeFilter = gardssalgTypeFilterSql(filter);
  return db
    .prepare(
      // catalog_hidden=1 rows (the hidden booking-flyt-v1 test provider) are
      // filtered out of the public grid; they stay bookable only via
      // getGardssalgProviderBySlug() below. Parens around the OR are
      // load-bearing (dev-request 2026-07-14-booking-flyt-v1, slice 0).
      `SELECT ${GARDSSALG_PROVIDER_COLUMNS}
         FROM experience_providers
        WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
          AND (catalog_hidden IS NULL OR catalog_hidden != 1)${typeFilter.sql}
        ORDER BY navn
        LIMIT ? OFFSET ?`
    )
    .all(...typeFilter.params, limit, offset) as GardssalgProviderRow[];
}

export type GardssalgProviderMapPoint = {
  slug: string;
  navn: string;
  producer_type: string | null;
  fylke: string | null;
  kommune: string | null;
  poststed: string | null;
  lat: number;
  lon: number;
  // 'high' | 'medium' | 'low' = Step A's real address-level Kartverket geocode;
  // 'approximate' = Step D's kommune/fylke-centroid fallback (see
  // GardssalgProviderRow.geocode_confidence's doc comment above and
  // experiences-geocode-worker.ts Steps A/D); 'no_match' rows never reach
  // here (they never get a lat/lon at all, so the coordinate predicate below
  // excludes them). Returned VERBATIM — the caller decides address-vs-
  // approximate marker styling from it, never a fabricated precision.
  geocode_confidence: string | null;
};

/**
 * Gårdssalg producers (drink producers; see listGardssalgProviders()'s doc
 * comment for why this queries experience_providers, not experiences) that
 * have a real geocode — feeds the /kategori/gardssalg map (dev-request
 * 2026-07-19-opplevagent-kart-fylke-gardssalg, arbeidspunkt 4). Reuses the
 * EXACT SAME "which providers count" gate as listGardssalgProviders()/
 * countGardssalgProviders() (producer_type set OR rfb-seed; catalog_hidden=1
 * rows — the hidden booking-flyt-v1 test provider — excluded; parens around
 * the OR are load-bearing, see those functions' comments) and appends two
 * predicates on top, same discipline as listPublishedExperienceMapPoints()
 * appending its coords predicate on top of browseWhere():
 *   - lat IS NOT NULL AND lon IS NOT NULL — so the marker count for
 *     /kategori/gardssalg is always <= listGardssalgProviders()'s card count
 *     for the SAME gate, never a divergent definition of "visible provider".
 *   - slug IS NOT NULL AND slug != '' — a marker with no produsent-profil
 *     page to link to isn't useful on a click-through map; every visible
 *     provider normally gets one via backfillProviderSlugs(), so this rarely
 *     excludes rows in practice.
 * geocode_confidence is NOT constrained here (unlike geo_precision on the
 * experiences map point, which IS NOT NULL there) — this table's Step A/Step
 * D writes always pair a non-null lat/lon with a non-null geocode_confidence
 * in practice, but nothing here depends on that; the type keeps it nullable
 * so a caller must handle "no confidence tag" defensively rather than assume
 * exact precision.
 */
export function listGardssalgProviderMapPoints(filter?: GardssalgProviderTypeFilter): GardssalgProviderMapPoint[] {
  const db = getDb(VERTICAL);
  // Optional S3 type filter — see countGardssalgProviders()'s doc comment;
  // omitted/empty filter builds the exact pre-S3 SQL string. Appended AFTER
  // the coordinate/slug predicates so the filtered marker set stays a strict
  // subset of the unfiltered one, in lockstep with the filtered card grid.
  const typeFilter = gardssalgTypeFilterSql(filter);
  return db
    .prepare(
      `SELECT slug, navn, producer_type, fylke, kommune, poststed, lat, lon, geocode_confidence
         FROM experience_providers
        WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
          AND (catalog_hidden IS NULL OR catalog_hidden != 1)
          AND lat IS NOT NULL AND lon IS NOT NULL
          AND slug IS NOT NULL AND slug != ''${typeFilter.sql}
        ORDER BY navn`
    )
    .all(...typeFilter.params) as GardssalgProviderMapPoint[];
}

/** Look up a single gårdssalg provider (drink producer) by slug — for the
 *  /kategori/gardssalg/book/<slug> reservation flow and the
 *  /kategori/gardssalg/produsent/<slug> profile page. Mirrors the WHERE clause
 *  from listGardssalgProviders()/countGardssalgProviders() (producer_type set
 *  OR rfb-seed), NOT the experiences-join publish gate used by
 *  getPublishedProviderBySlug() — gårdssalg producers have zero rows in the
 *  experiences table (their product is a gårdsbesøk booking, not a listed
 *  "experience"), so the join-based gate always 404'd them. That mismatch was
 *  the root cause of the live "Book besøk" 404 bug (2026-07-02).
 *
 *  catalog_hidden=1 rows are excluded here too (fixed 2026-08-17, P0 consent
 *  bug: a real producer asked to be delisted via
 *  POST /admin/gardssalg-provider-visibility, was flagged catalog_hidden=1,
 *  and was told "done" — but this function used to deliberately NOT filter
 *  on catalog_hidden, so their public produsent-profil page, its JSON-LD
 *  LocalBusiness structured data, and the booking flow all stayed fully live
 *  at their old URL. "Hidden" must mean actually hidden on EVERY public
 *  surface, no exceptions — this is now that surface's single enforcement
 *  point, shared by all 4 call sites in routes/experiences-seo.ts (profile
 *  page, its JSON-LD, the booking panel, and the booking POST/confirm
 *  redirects), so they 404 in lockstep, same discipline as
 *  listGardssalgProviders()/countGardssalgProviders()/
 *  searchGardssalgProviders(). Same load-bearing parens as those functions'
 *  WHERE clauses (see their comments): without them the trailing AND binds
 *  tighter than the OR and changes the set.
 *
 *  Known, accepted side effect: this also removes the admin-key-gated
 *  POST /admin/gardssalg/test-provider mechanism's ability to exercise the
 *  real public booking flow end-to-end via its public slug URL (that test
 *  row is itself catalog_hidden=1 — see that route's own comment for where
 *  this is called out). No bypass/flag was added to preserve that — a
 *  reachable-while-hidden exception is exactly the hole this fix closes. */
export function getGardssalgProviderBySlug(slug: string): GardssalgProviderRow | null {
  if (!slug) return null;
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT ${GARDSSALG_PROVIDER_COLUMNS}
         FROM experience_providers
        WHERE slug = @slug
          AND (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
          AND (catalog_hidden IS NULL OR catalog_hidden != 1)`
    )
    .get({ slug }) as GardssalgProviderRow | undefined;
  return row ?? null;
}

// ─── Gårdssalg search (MCP discoverability, dev-request 2026-07-20-
// gardssalg-mcp-discoverability) ───────────────────────────────────────────
// Gårdssalg producers had ZERO presence in the agent-facing MCP surface —
// discover_experiences/get_experience only ever cover the `experiences`
// table, and gårdssalg producers have zero rows there (see
// getGardssalgProviderBySlug's doc comment above). searchGardssalgProviders()
// backs the new discover_gardssalg MCP tool (src/routes/experiences-mcp.ts).
//
// Reuses the EXACT SAME base WHERE clause as listGardssalgProviders()/
// countGardssalgProviders() — load-bearing: a catalog_hidden=1 row (the
// hidden booking-flyt-v1 test provider) must NEVER be returned here under
// any filter combination, same as the public grid/count.
//
// fylke/kommune/producer_type are simple exact-match filters. Unlike
// discoverExperiences()'s fylke handling, this deliberately does NOT bridge
// fylke-reform-era spelling variants via fylkeEquivalents() (see that
// function's doc comment in norway-fylke.ts) — gårdssalg providers were all
// seeded/enriched post-reform, so this column has no pre-2020/pre-2024
// spelling variance to bridge.
//
// near-me (lat/lng[+radius_km]) mirrors discoverExperiences()'s own pattern:
// a coarse bounding-box pre-filter in SQL, then the exact haversine cut +
// ascending-distance sort in JS. This table's geo columns are lat/lon (NOT
// loc_lat/loc_lon like the `experiences` table) — only rows with BOTH
// non-null are ever considered when an origin is given; a row with no
// geocode at all is excluded outright, never assigned a fabricated distance.
export type GardssalgSearchFilter = {
  fylke?: string;
  kommune?: string;
  producer_type?: string;
  booking_live?: boolean;
  lat?: number;
  lng?: number;
  radius_km?: number;
};

export function searchGardssalgProviders(
  filter: GardssalgSearchFilter = {},
  limit = 20
): Array<GardssalgProviderRow & { distance_km?: number }> {
  const db = getDb(VERTICAL);

  // Same base gate as listGardssalgProviders()/countGardssalgProviders() —
  // parens are load-bearing (see those functions' comments). catalog_hidden=1
  // rows must never surface here, regardless of what else is filtered.
  const where: string[] = [
    "(producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')",
    "(catalog_hidden IS NULL OR catalog_hidden != 1)",
  ];
  const params: Record<string, unknown> = {};

  if (filter.fylke) { where.push("fylke = @fylke"); params.fylke = filter.fylke; }
  if (filter.kommune) { where.push("kommune = @kommune"); params.kommune = filter.kommune; }
  if (filter.producer_type) { where.push("producer_type = @producer_type"); params.producer_type = filter.producer_type; }
  // Only the "show me the live ones" case is a real filter; omitted/false
  // means no filter on this column (not "show me the paused ones").
  if (filter.booking_live === true) { where.push("booking_live = 1"); }

  const hasGeo = typeof filter.lat === "number" && typeof filter.lng === "number";
  const originLat = filter.lat;
  const originLng = filter.lng;
  if (hasGeo && typeof originLat === "number" && typeof originLng === "number") {
    // Never fabricate a distance: a row with no lat/lon at all is excluded
    // outright rather than surfaced without a distance_km.
    where.push("lat IS NOT NULL AND lon IS NOT NULL");
    if (typeof filter.radius_km === "number") {
      // Bounding-box pre-filter (cheap, SQL-level) — mirrors
      // discoverExperiences()'s own pattern: a coarse degrees-based box
      // first, then the exact haversine cut (+ real distance_km) is
      // computed in JS on the (small) surviving set below.
      const latDelta = filter.radius_km / 111.0; // ~111km per degree latitude
      const lngDelta = filter.radius_km / (111.0 * Math.cos((originLat * Math.PI) / 180));
      where.push("lat BETWEEN @geoLatMin AND @geoLatMax AND lon BETWEEN @geoLngMin AND @geoLngMax");
      params.geoLatMin = originLat - latDelta;
      params.geoLatMax = originLat + latDelta;
      params.geoLngMin = originLng - lngDelta;
      params.geoLngMax = originLng + lngDelta;
    }
  }

  // Mirrors DiscoverExperiencesInputSchema's limit convention (experiences-
  // mcp.ts): default 20, clamped to [1,50].
  const clampedLimit = Math.max(1, Math.min(50, limit ?? 20));

  // When a geo origin is given, the true top-N-by-distance can't be decided
  // in SQL (no haversine there), so the SQL LIMIT is widened to a generous
  // candidate cap and the real cut to `clampedLimit` happens after the exact
  // distance is computed + sorted in JS below — mirrors discoverExperiences().
  const GEO_CANDIDATE_CAP = 2000;
  params.limit = hasGeo ? GEO_CANDIDATE_CAP : clampedLimit;

  const rows = db
    .prepare(
      `SELECT ${GARDSSALG_PROVIDER_COLUMNS}
         FROM experience_providers
        WHERE ${where.join(" AND ")}
        ORDER BY navn
        LIMIT @limit`
    )
    .all(params) as GardssalgProviderRow[];

  if (!hasGeo || typeof originLat !== "number" || typeof originLng !== "number") {
    return rows;
  }

  // Exact haversine distance + radius cut + ascending-distance sort. The
  // WHERE clause above already guarantees lat/lon are non-null for every row
  // reaching here, so distance_km is always a real number (never fabricated
  // for a non-geocoded row).
  let withDistance: Array<GardssalgProviderRow & { distance_km: number }> = rows.map((r) => ({
    ...r,
    distance_km: Math.round(haversineDistanceKm(originLat, originLng, r.lat as number, r.lon as number) * 10) / 10,
  }));
  if (typeof filter.radius_km === "number") {
    const radiusKm = filter.radius_km;
    withDistance = withDistance.filter((r) => r.distance_km <= radiusKm);
  }
  withDistance.sort((a, b) => a.distance_km - b.distance_km);
  return withDistance.slice(0, clampedLimit);
}

// ─── Gårdssalg free-text search for /sok (dev-request 2026-08-01-gardssalg-
//     profilkomplett-og-soekbar-foer-outreach, Steg 1) ─────────────────────
//
// Measured production bug: /sok's free-text search only ever queried
// `experiences` (via searchPublishedExperiences() above) — gårdssalg
// producers live in `experience_providers` (see listGardssalgProviders()'s
// doc comment for why), so they had ZERO presence in search. 12 of 13
// outreach-candidate producers returned "Ingen treff" on their own name.
//
// Distinct from searchGardssalgProviders(filter, limit) above: that one is
// the STRUCTURED filter (fylke/kommune/producer_type/geo) backing the REST
// /api/opplevelser/discover?category=gardssalg_smaking endpoint (via
// routes/opplevelser.ts) and the discover_gardssalg MCP tool — no free-text
// query param. This one is free-text-only, for the /sok HTML page's search
// box, and deliberately does not touch that REST endpoint (out of scope for
// this slice — see the dev-request).
//
// Reuses the EXACT SAME "is this a gårdssalg producer" gate as
// listGardssalgProviders()/searchGardssalgProviders() (producer_type set OR
// rfb-seed; catalog_hidden=1 rows excluded — parens around the OR are
// load-bearing, see those functions' comments) so a hidden producer can
// never leak into public search, same discipline as everywhere else this
// gate is used.
//
// Matching reuses the SAME tokenised-AND / lower()/LIKE / expandSearchTerm()
// Norwegian-synonym pattern as searchPublishedExperiences() above (rather
// than inventing a second matching approach), so æøå and multi-word queries
// behave consistently across both search surfaces — matched against
// navn/poststed/kommune/fylke/products (products is a JSON-array-of-strings
// text column; a plain substring LIKE still finds a product name inside it).
//
// Also requires a real slug (same discipline as listGardssalgProviderMapPoints():
// a result with no /kategori/gardssalg/produsent/<slug> page to link to isn't
// useful on a search results page) — every visible producer normally has one
// via backfillProviderSlugs(), so this rarely excludes rows in practice.
export type GardssalgSearchByQueryRow = {
  id: string;
  navn: string;
  // Never null on a returned row — see the query's slug predicate below.
  slug: string;
  fylke: string | null;
  kommune: string | null;
  poststed: string | null;
  producer_type: string | null;
};

export function searchGardssalgProvidersByQuery(query: string, limit = 30): GardssalgSearchByQueryRow[] {
  const q = String(query || "").trim();
  if (!q) return [];
  // Same tokenisation cap (8 terms) as searchPublishedExperiences() — an
  // absurdly long query degrades gracefully rather than building an
  // unbounded WHERE clause.
  const terms = q.split(/\s+/).filter((t) => t.length > 0).slice(0, 8);
  if (terms.length === 0) return [];
  const db = getDb(VERTICAL);
  const params: Record<string, unknown> = { limit: Math.max(1, Math.min(100, limit)) };
  const termClauses = terms.map((t, i) => {
    // Expand Norwegian term into [original, ...english_synonyms] — same
    // helper searchPublishedExperiences() uses, kept consistent rather than
    // reimplemented (SEARCH_SYNONYMS is activity-word-shaped, not producer-
    // name-shaped, so it mostly no-ops here, but a shared helper means the
    // two search surfaces never silently diverge in behavior).
    const expanded = expandSearchTerm(t);
    const fieldClauses = expanded.flatMap((et, ei) => {
      const key = `t${i}_${ei}`;
      params[key] = `%${et.toLowerCase()}%`;
      return [
        `lower(navn) LIKE @${key}`,
        `lower(COALESCE(poststed,'')) LIKE @${key}`,
        `lower(COALESCE(kommune,'')) LIKE @${key}`,
        `lower(COALESCE(fylke,'')) LIKE @${key}`,
        `lower(COALESCE(products,'')) LIKE @${key}`,
      ];
    });
    return `(${fieldClauses.join(" OR ")})`;
  });
  const rows = db
    .prepare(
      `SELECT id, navn, slug, fylke, kommune, poststed, producer_type
         FROM experience_providers
        WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
          AND (catalog_hidden IS NULL OR catalog_hidden != 1)
          AND slug IS NOT NULL AND slug != ''
          AND ${termClauses.join(" AND ")}
        ORDER BY navn
        LIMIT @limit`
    )
    .all(params) as GardssalgSearchByQueryRow[];
  return rows;
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
  // dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach,
  // Steg 3 follow-up — raw field_provenance JSON (same defensive-parse
  // pattern as every other field_provenance read in this file, e.g.
  // applyGardssalgWebsiteVerification in gardssalg-website-verification.ts),
  // read here so the content-refresh route can gate its fetch on
  // field_provenance.hjemmeside_verification.verified === true (PR #448's
  // website-verification sweep) without a second query.
  field_provenance: string | null;
};

/**
 * Auto-select gårdssalg providers eligible for a content-refresh: gårdssalg
 * providers (producer_type set OR rfb-seed) WITH a website, not fully locked
 * (content_source != 'manual' — sub-slice 3i: 'claim' rows ARE now included
 * here, since locking is gated per-field downstream in
 * applyGardssalgProviderContent via isGardssalgFieldOwnerLocked, not by
 * excluding the whole row at select time), and THIN on at least one of
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
              about_text, visit_text, opening_hours_text, products, field_provenance
         FROM experience_providers
        WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
          AND (producer_type IS NULL OR producer_type != 'test-gardssalg')
          AND hjemmeside IS NOT NULL AND TRIM(hjemmeside) != ''
          AND (content_source IS NULL OR content_source != 'manual')
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
              about_text, visit_text, opening_hours_text, products, field_provenance
         FROM experience_providers
        WHERE id = ?
          AND (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')`
    )
    .get(providerId) as GardssalgContentRefreshTarget | undefined;
  if (!row || !row.hjemmeside || row.hjemmeside.trim().length === 0) return null;
  return row;
}

// ─── Gårdssalg content QUALITY-UPDATE selection (dev-request 2026-08-17-
// forsyningskjede-samarbeid-og-kvalitetsoppdatering, Skive 3 — "erstatter
// fill-only") ────────────────────────────────────────────────────────────
//
// selectGardssalgProvidersForContentRefresh above only ever selects rows
// THIN on a field (fill-only's own scope). Skive 3 policy-changes the
// pipeline to also be able to REPLACE a measurably-defective or measurably-
// thinner NON-BLANK value — see services/gardssalg-quality-update.ts for the
// classifier/margin/anti-churn policy this selection feeds. This is the
// counterpart selection: candidates with a website, not row-locked, and with
// AT LEAST ONE of about_text/visit_text/opening_hours_text already NON-blank
// (a row where all three are blank has nothing for this lever to do — that's
// entirely fill-only's job, unchanged).
export type GardssalgQualityUpdateTarget = {
  id: string;
  navn: string;
  hjemmeside: string;
  content_source: string | null;
  producer_type: string | null;
  about_text: string | null;
  visit_text: string | null;
  opening_hours_text: string | null;
  field_provenance: string | null;
};

/**
 * Auto-select candidates for POST /admin/gardssalg-content-quality-update.
 * Same exclusions as selectGardssalgProvidersForContentRefresh (gårdssalg
 * WITH a website, real producers only — 'test-gardssalg' excluded, same as
 * every other admin sweep in this file — not catalog_hidden, not row-locked
 * 'manual'; 'claim' rows ARE included here, since the per-field owner-lock
 * decision happens downstream via isGardssalgFieldOwnerLocked, never by
 * excluding the whole row at select time) and the SAME
 * providerParkingExclusionSql() 3-strikes exclusion. Ordered oldest-attempted
 * first via the SAME last_content_attempt_at/homepage_fetch_attempts cadence
 * counters selectGardssalgProvidersForContentRefresh uses — this lever is a
 * different admin route, but it fetches the SAME homepages and should not
 * re-hammer a site another gårdssalg fetcher already tried recently.
 */
export function selectGardssalgProvidersForQualityUpdate(limit = 25): GardssalgQualityUpdateTarget[] {
  const db = getDb(VERTICAL);
  const cap = Math.max(1, Math.min(200, limit));
  return db
    .prepare(
      `SELECT id, navn, TRIM(hjemmeside) AS hjemmeside, content_source, producer_type,
              about_text, visit_text, opening_hours_text, field_provenance
         FROM experience_providers
        WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
          AND (producer_type IS NULL OR producer_type != 'test-gardssalg')
          AND hjemmeside IS NOT NULL AND TRIM(hjemmeside) != ''
          AND (catalog_hidden IS NULL OR catalog_hidden != 1)
          AND (content_source IS NULL OR content_source != 'manual')
          AND (
                (about_text IS NOT NULL AND TRIM(about_text) != '')
             OR (visit_text IS NOT NULL AND TRIM(visit_text) != '')
             OR (opening_hours_text IS NOT NULL AND TRIM(opening_hours_text) != '')
              )
          ${providerParkingExclusionSql()}
        ORDER BY (last_content_attempt_at IS NOT NULL), last_content_attempt_at ASC, created_at ASC
        LIMIT ?`
    )
    .all(cap) as GardssalgQualityUpdateTarget[];
}

/**
 * Resolve an explicit providerId for the quality-update route's
 * `providerIds` override — mirrors getGardssalgProviderContentTarget's own
 * override semantics exactly (bypasses the thin/blank + lock filters above,
 * so an admin can force-run a SPECIFIC provider — e.g. the Bringebærlandet
 * (ce85458a) acceptance-criterion fixture — regardless of auto-select
 * eligibility/cadence ordering). Returns null when the provider doesn't
 * exist, isn't a gårdssalg provider, or has no usable website.
 */
export function getGardssalgProviderQualityUpdateTarget(providerId: string): GardssalgQualityUpdateTarget | null {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT id, navn, TRIM(hjemmeside) AS hjemmeside, content_source, producer_type,
              about_text, visit_text, opening_hours_text, field_provenance
         FROM experience_providers
        WHERE id = ?
          AND (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')`
    )
    .get(providerId) as GardssalgQualityUpdateTarget | undefined;
  if (!row || !row.hjemmeside || row.hjemmeside.trim().length === 0) return null;
  return row;
}

/**
 * Every gårdssalg provider's CURRENT stored value for the three quality-
 * update fields, keyed by id — feeds the "identical to another provider's
 * stored value" (template-leakage) defect check in
 * services/gardssalg-quality-update.ts. One query per run (not per
 * candidate row): cheap (dozens of gårdssalg rows total), and every
 * candidate row's duplicate-check needs the SAME full set to compare
 * against. Scoped the same as listGardssalgProviders (visible gårdssalg rows
 * only — a value only stored on a catalog_hidden test row is not a
 * meaningful template-leakage signal for a real producer).
 */
export function listGardssalgFieldValuesForQualityUpdate(): Array<{
  id: string;
  about_text: string | null;
  visit_text: string | null;
  opening_hours_text: string | null;
}> {
  const db = getDb(VERTICAL);
  return db
    .prepare(
      `SELECT id, about_text, visit_text, opening_hours_text
         FROM experience_providers
        WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
          AND (catalog_hidden IS NULL OR catalog_hidden != 1)`
    )
    .all() as Array<{ id: string; about_text: string | null; visit_text: string | null; opening_hours_text: string | null }>;
}

// ─── Gårdssalg mojibake detection + candidate scan (dev-request 2026-07-21-
// opplevagent-norske-tegn-encoding, criterion 3) ────────────────────────────
//
// PR lokal#360 fixed fetchHtml()'s decode path (search-enrich.ts) so NEW
// crawls never mis-decode a source page's æ/ø/å again. It did nothing for
// producer text ALREADY written to the DB before that fix — this section is
// the DETECTION half of the repair: scanning STORED about_text/visit_text/
// opening_hours_text/products for known mojibake signatures
// (containsMojibake, search-enrich.ts) to build a CANDIDATE list of provider
// ids to re-crawl. This never mutates text directly. See the admin backfill
// route (POST /admin/gardssalg-mojibake-backfill, routes/opplevelser.ts) for
// the actual re-fetch + re-extract + re-write step, which goes through
// applyGardssalgProviderContent()'s `forceFields` bypass (added alongside
// this) so the repair is audited/provenance-stamped exactly like any other
// gårdssalg content write.

export type GardssalgMojibakeFieldName = "about_text" | "visit_text" | "opening_hours_text" | "products";

export interface GardssalgMojibakeFieldMatch {
  field: GardssalgMojibakeFieldName;
  snippet: string;
}

export interface GardssalgMojibakeCandidate {
  id: string;
  navn: string;
  hjemmeside: string;
  fields: GardssalgMojibakeFieldMatch[];
}

/**
 * Scan ONE provider row's free-text content fields for known mojibake
 * signatures (containsMojibake). `products` is the JSON-array-of-strings
 * column (see GardssalgContentRefreshTarget's doc comment above); a
 * malformed/non-JSON value is scanned as a raw string instead of erroring —
 * a signature match there is exactly as actionable a scan hit as in any
 * other field. Returns one match per field (products is checked element-by-
 * element internally but reported as a single field-level hit, since the
 * whole column would need re-extraction regardless of which element(s) are
 * corrupted). PURE — no DB, no network.
 */
export function scanGardssalgProviderRowForMojibake(row: {
  about_text?: string | null;
  visit_text?: string | null;
  opening_hours_text?: string | null;
  products?: string | null;
}): GardssalgMojibakeFieldMatch[] {
  const out: GardssalgMojibakeFieldMatch[] = [];
  const scalarFields: Array<[GardssalgMojibakeFieldName, string | null | undefined]> = [
    ["about_text", row.about_text],
    ["visit_text", row.visit_text],
    ["opening_hours_text", row.opening_hours_text],
  ];
  for (const [field, value] of scalarFields) {
    if (containsMojibake(value)) {
      out.push({ field, snippet: mojibakeSnippet(value) });
    }
  }
  if (row.products) {
    let productStrings: string[] = [];
    try {
      const parsed = JSON.parse(row.products);
      if (Array.isArray(parsed)) {
        productStrings = parsed.filter((p): p is string => typeof p === "string");
      }
    } catch {
      // Non-JSON value in a column that should always be JSON — still worth
      // scanning as a raw string rather than silently skipping it.
      productStrings = [row.products];
    }
    for (const p of productStrings) {
      if (containsMojibake(p)) {
        out.push({ field: "products", snippet: mojibakeSnippet(p) });
        break; // one hit is enough to flag the whole column for re-extraction
      }
    }
  }
  return out;
}

/**
 * Auto-select gårdssalg providers (producer_type set OR rfb-seed), NOT
 * locked (content_source not in manual/claim), WITH a website, whose stored
 * content fields contain a mojibake signature — the candidate list for
 * POST /admin/gardssalg-mojibake-backfill. Scans every eligible row (the
 * catalog is small — hard-capped at 48 providers total, same ceiling as
 * selectGardssalgProvidersForContentRefresh) rather than paging, since the
 * scan itself is a cheap in-process string search with no I/O; `limit` only
 * caps how many MATCHING candidates are returned.
 */
export function selectGardssalgMojibakeCandidates(limit = 25): GardssalgMojibakeCandidate[] {
  const db = getDb(VERTICAL);
  const cap = Math.max(1, Math.min(48, limit));
  const rows = db
    .prepare(
      `SELECT id, navn, TRIM(hjemmeside) AS hjemmeside,
              about_text, visit_text, opening_hours_text, products
         FROM experience_providers
        WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
          AND hjemmeside IS NOT NULL AND TRIM(hjemmeside) != ''
          AND (content_source IS NULL OR content_source NOT IN ('manual','claim'))
        ORDER BY (last_content_attempt_at IS NOT NULL), last_content_attempt_at ASC, created_at ASC`
    )
    .all() as Array<{
      id: string;
      navn: string;
      hjemmeside: string;
      about_text: string | null;
      visit_text: string | null;
      opening_hours_text: string | null;
      products: string | null;
    }>;

  const candidates: GardssalgMojibakeCandidate[] = [];
  for (const row of rows) {
    const fields = scanGardssalgProviderRowForMojibake(row);
    if (fields.length > 0) {
      candidates.push({ id: row.id, navn: row.navn, hjemmeside: row.hjemmeside, fields });
      if (candidates.length >= cap) break;
    }
  }
  return candidates;
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
 *                meetsAboutCheapBar) OR judged-contaminated (see
 *                currentValueJudgedContaminated below), the candidate itself
 *                passes the cheap bar, AND the candidate is strictly longer
 *                than the current value — so a replace never swaps
 *                thin-but-real content for something equally or less
 *                substantial.
 *   null       — no write: current value already meets the cheap bar AND is
 *                not judged-contaminated (never churned), or the candidate
 *                doesn't qualify.
 *
 * dev-request 2026-07-20-gardssalg-kvalitetsgate-redesign, slice 2/3/4: uses
 * meetsAboutCheapBar (cheap/universal parts only), NOT the full
 * meetsAboutQualityBar — see the import's doc comment for why. The semantic
 * "is this candidate actually good" judgment for gårdssalg now happens
 * upstream, in the route's meetsGardssalgAboutQualityBar() cascade, before a
 * candidate value ever reaches this function.
 *
 * `currentValueJudgedContaminated` (fix-up round, independent review's
 * blocking finding): "current value passes the cheap bar" is NOT the same
 * as "current value is decent" — nav-menu chrome glued to one real sentence
 * (the Draopar incident shape) is long enough and real-Norwegian-enough to
 * clear meetsAboutCheapBar every time, so the original slice-2/3/4 code
 * ("current passes cheap bar -> never touch it, full stop") permanently
 * locked ALREADY-contaminated rows out of ever being fixed by this endpoint
 * again — precisely the incident class this redesign exists to close. The
 * caller (routes/opplevelser.ts) is expected to have already run the SAME
 * LLM judge used on candidates (meetsGardssalgAboutQualityBar) against the
 * CURRENT value too, but ONLY when it was cost-effective to do so (current
 * passes the cheap bar AND a judge-approved fresh candidate exists — see the
 * caller's own doc comment for the exact cost-bounded ordering), and passes
 * the negated verdict in here. When true, a cheap-bar-passing current value
 * is treated as if it had failed the cheap bar for the "never churn" check
 * below — everything else (candidate must itself pass the cheap bar, and be
 * strictly longer) is unchanged. Defaults to false so every pre-existing
 * caller/test that doesn't pass it keeps the exact old behavior.
 */
export function gardssalgReplaceableFieldAction(
  currentValue: string | null | undefined,
  candidateValue: string | null | undefined,
  currentValueJudgedContaminated: boolean = false
): "filled" | "replaced" | null {
  const candidate = candidateValue?.trim();
  if (!candidate) return null;
  const isCurrentBlank = currentValue === null || currentValue === undefined || String(currentValue).trim() === "";
  if (isCurrentBlank) return "filled";
  if (meetsAboutCheapBar(currentValue) && !currentValueJudgedContaminated) return null; // decent existing content — never churned
  if (!meetsAboutCheapBar(candidate)) return null; // candidate itself thin — can't replace thin with thin
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
 *   - currentValue passes meetsAboutCheapBar (>=80 chars, not boilerplate/
 *     mangled/foreign — i.e. the value gardssalgReplaceableFieldAction
 *     itself would refuse to ever churn; see that gate's doc comment for why
 *     this uses the cheap bar rather than the full meetsAboutQualityBar),
 *   - currentValue.trim().length < 200 (still genuinely thin by this
 *     rewrite slice's own, stricter 200-char bar).
 *
 * A field already >=200 chars is never eligible — this is what makes a
 * second run idempotent with no extra state/flag: once a field is rewritten
 * (the LLM helper's code-enforced 200-500 char output range guarantees
 * >=200), it drops out of the eligible set on its own.
 *
 * `currentValueJudgedContaminated` (fix-up round 2, independent review's
 * blocking finding — "gardssalgRewriteEligible also lost its nav-check, and
 * unlike the main replace path, has no compensating LLM-judge check at
 * all"): mirrors gardssalgReplaceableFieldAction's own
 * currentValueJudgedContaminated param above (same fix-up round-1 pattern).
 * A cheap-bar-passing-but-<200-char current value that "looks" eligible by
 * this function's own structural rule is EXACTLY the Draopar-shaped nav-junk
 * cohort: long+Norwegian-looking enough to pass meetsAboutCheapBar, still
 * short enough (<200) to look like a genuine "thin, expand it" candidate —
 * except it is nav chrome, not real prose, and generateGardssalgAboutRewrite
 * (routes/opplevelser.ts) takes this exact value as TRUSTED grounding text
 * for its expansion. The caller is expected to run the SAME LLM judge used
 * elsewhere in this redesign (meetsGardssalgAboutQualityBar) against the
 * current value ONLY when it already passes the structural rule below (cost-
 * bounded — no upfront judging of every current value regardless of rewrite
 * candidacy, same discipline as gardssalgReplaceableFieldAction's caller),
 * and pass the negated verdict in here. Defaults to false so every pre-
 * existing caller/test that doesn't pass it keeps the exact old behavior.
 */
export function gardssalgRewriteEligible(
  currentValue: string | null | undefined,
  currentValueJudgedContaminated: boolean = false
): boolean {
  if (currentValue === null || currentValue === undefined) return false;
  const trimmed = String(currentValue).trim();
  if (!trimmed) return false;
  if (currentValueJudgedContaminated) return false;
  if (!meetsAboutCheapBar(trimmed)) return false;
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
 * `forceFields` (dev-request 2026-07-21-opplevagent-norske-tegn-encoding,
 * criterion 3 — mojibake databackfill) — OPTIONAL, additive, empty/omitted
 * by every pre-existing call site (byte-identical behavior when not
 * passed): names the about_text/visit_text/opening_hours_text fields whose
 * `candidate` value the caller has ALREADY independently verified is a
 * genuine correctness fix (re-fetched via the already-fixed decode path,
 * re-extracted, and confirmed both to DIFFER from the stored value and to
 * NOT itself match a mojibake signature — see the admin backfill route,
 * routes/opplevelser.ts). This is the same "bypass gardssalgReplaceable
 * FieldAction()'s decision, still go through the same audit-row +
 * field_provenance + lock-guard machinery" pattern `rewriteFields` below
 * already established — it exists here because
 * gardssalgReplaceableFieldAction()'s own "candidate must be strictly
 * LONGER than the current value" replace rule is actively WRONG for this
 * use case: mojibake corruption (e.g. "Ã¦" replacing "æ") typically makes
 * the corrupted stored text LONGER than its correctly-decoded repair, so
 * relying on that heuristic here would silently block most real fixes. The
 * force branch still requires a non-blank trimmed candidate value and is
 * gated by the SAME row-lock check above (content_source manual/claim never
 * reaches any per-field branch, forced or not) — only the length-based
 * "is this an improvement" heuristic is skipped, never the audit/lock
 * discipline.
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
 * helper's own 200-500-char acceptance gate — and, since fix-up round 2
 * (independent review's blocking finding), also via the SAME gårdssalg LLM
 * judge (meetsGardssalgAboutQualityBar) against BOTH the current value
 * (before it's trusted as rewrite grounding — fed into
 * gardssalgRewriteEligible's currentValueJudgedContaminated param) AND the
 * rewrite's own output (before it's accepted at all) — see the caller's own
 * doc comment above its rewrite block for the full two-gate rationale; this
 * function does one more defense-in-depth re-check (gardssalgRewriteEligible
 * against the FRESH row snapshot read below, not the caller's possibly-stale
 * one, though WITHOUT re-running the contamination judge — the value being
 * written here already cleared the output judge, so this recheck only
 * guards the structural cheap-bar/length race, same as before fix-up round
 * 2) before writing, so a field that changed between selection and write
 * never gets silently churned. For a field named here, the write bypasses
 * gardssalgReplaceableFieldAction()'s decision (which is a no-op for it
 * anyway, since eligibility requires the current value to already pass the
 * quality bar) but goes through the exact same audit-row + field_provenance
 * + lock-guard machinery as every other field.
 *
 * `contaminatedFields` (fix-up round, independent review's blocking
 * finding) — OPTIONAL, additive, empty/omitted by every pre-existing call
 * site (byte-identical behavior when not passed): names the about_text/
 * visit_text fields whose CURRENT value the caller already ran through the
 * LLM judge (meetsGardssalgAboutQualityBar in routes/opplevelser.ts) and
 * found NOT approved, despite passing the cheap bar — i.e. the Draopar-
 * shaped "long enough, real-Norwegian-enough, but actually leaked nav
 * chrome" case. Forwarded straight into gardssalgReplaceableFieldAction()'s
 * `currentValueJudgedContaminated` param for that field, against THIS
 * function's own FRESH row snapshot (not the caller's possibly-stale one) —
 * same defense-in-depth discipline as `rewriteFields` above. If the row's
 * current value changed between the caller's selection-time judge call and
 * this write (a narrow race), the contamination verdict could be stale for
 * the new value; this is accepted as the same tolerance already baked into
 * the candidate side (a candidate's judge-approval is likewise not
 * re-verified against a materially different row here, only re-checked
 * structurally via the cheap bar).
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
  rewriteFields?: Array<"about_text" | "visit_text">,
  contaminatedFields?: Array<"about_text" | "visit_text">,
  // dev-request 2026-07-21-opplevagent-norske-tegn-encoding, criterion 3 —
  // see this function's own doc comment above for the full rationale.
  forceFields?: Array<"about_text" | "visit_text" | "opening_hours_text">
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
  // dev-request 2026-07-30-opplevagent-claim-epost-og-perfelt-laas, sub-slice
  // 3i: 'manual' rows keep the unconditional, full-row freeze (unchanged).
  // 'claim' rows no longer bail here -- the freeze narrows to per-field below,
  // via isGardssalgFieldOwnerLocked(row, fieldName) guarding each of the 4
  // write branches individually (same helper PR #472/#478 already ship and
  // review; no new policy logic added here).
  if (row.content_source === "manual") return [];

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
  // gardssalgReplaceableFieldAction always returns null ("never churned")
  // UNLESS the field is also named in contaminatedSet below.
  const rewriteSet = new Set(rewriteFields ?? []);
  // Fix-up round: fields whose CURRENT value the caller's LLM judge already
  // found contaminated (see this function's doc comment above) — forwarded
  // into gardssalgReplaceableFieldAction()'s currentValueJudgedContaminated
  // param so a cheap-bar-passing-but-contaminated current value can still
  // be replaced by a genuinely good fresh candidate.
  const contaminatedSet = new Set(contaminatedFields ?? []);
  // Mojibake-backfill force set (criterion 3, see this function's doc
  // comment above) — checked FIRST, ahead of both the rewrite and the
  // replaceable-field-action branches, since the caller has already done
  // its own correctness verification (differs from stored + not itself
  // still corrupted) and only needs the audit/lock machinery below, not a
  // second opinion from a length-based heuristic that doesn't apply here.
  const forceSet = new Set(forceFields ?? []);
  // Sub-slice 3i per-field owner-lock guard: only meaningful for
  // content_source='claim' rows (isGardssalgFieldOwnerLocked always returns
  // false for any other content_source, including the enrichment-derived
  // rows this function otherwise handles) — reuses the SAME already-shipped,
  // already-reviewed helper the hjemmeside pilot (3c) and the rollback
  // writers (3b) already gate on. No new policy logic here, only wiring.
  const isFieldOwnerLocked = (fieldName: string): boolean =>
    row.content_source === "claim" && isGardssalgFieldOwnerLocked(row, fieldName);

  if (!isFieldOwnerLocked("about_text")) {
    if (forceSet.has("about_text") && candidate.about_text?.trim()) {
      sets.push("about_text = @about_text");
      params.about_text = candidate.about_text.trim();
      written.push("about_text");
    } else if (rewriteSet.has("about_text") && candidate.about_text?.trim() && gardssalgRewriteEligible(row.about_text)) {
      sets.push("about_text = @about_text");
      params.about_text = candidate.about_text.trim();
      written.push("about_text");
    } else if (gardssalgReplaceableFieldAction(row.about_text, candidate.about_text, contaminatedSet.has("about_text"))) {
      sets.push("about_text = @about_text");
      params.about_text = candidate.about_text!.trim();
      written.push("about_text");
    }
  }
  if (!isFieldOwnerLocked("visit_text")) {
    if (forceSet.has("visit_text") && candidate.visit_text?.trim()) {
      sets.push("visit_text = @visit_text");
      params.visit_text = candidate.visit_text.trim();
      written.push("visit_text");
    } else if (rewriteSet.has("visit_text") && candidate.visit_text?.trim() && gardssalgRewriteEligible(row.visit_text)) {
      sets.push("visit_text = @visit_text");
      params.visit_text = candidate.visit_text.trim();
      written.push("visit_text");
    } else if (gardssalgReplaceableFieldAction(row.visit_text, candidate.visit_text, contaminatedSet.has("visit_text"))) {
      sets.push("visit_text = @visit_text");
      params.visit_text = candidate.visit_text!.trim();
      written.push("visit_text");
    }
  }
  if (!isFieldOwnerLocked("opening_hours_text")) {
    if (forceSet.has("opening_hours_text") && candidate.opening_hours_text?.trim()) {
      sets.push("opening_hours_text = @opening_hours_text");
      params.opening_hours_text = candidate.opening_hours_text.trim();
      written.push("opening_hours_text");
    } else if (isBlank(row.opening_hours_text) && candidate.opening_hours_text?.trim()) {
      sets.push("opening_hours_text = @opening_hours_text");
      params.opening_hours_text = candidate.opening_hours_text.trim();
      written.push("opening_hours_text");
    }
  }
  // Slice 5c — fill-only, re-checked against the FRESH row snapshot (not the
  // caller's possibly-stale target snapshot), same defense-in-depth
  // discipline as the rewriteFields re-check above.
  if (!isFieldOwnerLocked("products")) {
    if (candidate.products && candidate.products.length > 0 && gardssalgProductsEligible(row.products)) {
      sets.push("products = @products");
      params.products = JSON.stringify(candidate.products);
      written.push("products");
    }
  }

  if (sets.length === 0) return [];

  // Sub-slice 3i fix (fresh-context review, CHANGES-REQUESTED): a still-
  // 'claim' row must keep its content_source identity across a per-field
  // write. Before this guard, the very first partial-field write to a claim
  // row re-stamped content_source='provider_site' unconditionally, which
  // would make the NEXT content-refresh run treat the row as fully
  // unprotected (isFieldOwnerLocked/isGardssalgFieldOwnerLocked only gate
  // when content_source === "claim") — silently unlocking every remaining
  // field the owner explicitly locked via the claim portal. 'manual' rows
  // never reach this function's write path (row-level bail above), and
  // every other content_source is unaffected — this only excludes 'claim'.
  if (row.content_source !== "claim") {
    sets.push("content_source = 'provider_site'");
  }
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

// ─── Gårdssalg retroactive quality-gate scan (dev-request 2026-07-20-
//     gardssalg-kvalitetsgate-redesign, criterion 6) ────────────────────────
//
// Criteria 1-5 of this dev-request only apply the new extraction+judge gate
// (extractProseText's structure-aware extraction + meetsGardssalgAboutQuality
// Bar's cheap-bar+LLM-judge cascade) going FORWARD, to fresh candidates a
// content-refresh run derives. Rows whose about_text/visit_text was written
// BEFORE this gate existed (or by a run that only had the fresh-candidate-
// gated version of the current-value check — see applyGardssalgProviderContent's
// currentValueContaminated doc comment) are never revisited by that forward-
// only path. This is the retroactive sweep: judge the CURRENTLY STORED value
// of every non-locked gårdssalg row against the SAME gate, and null out
// whatever no longer clears it — backed by the exact same
// gardssalg_content_audit + field_provenance write discipline as every other
// gårdssalg writer in this file, so POST /admin/gardssalg-content-rollback
// (which restores from gardssalg_content_audit's old_value; see that
// endpoint's doc comment in routes/opplevelser.ts) undoes it with zero
// changes needed on the rollback side — about_text/visit_text are already in
// GARDSSALG_ROLLBACKABLE_FIELDS.

export type GardssalgRetroScanTarget = {
  id: string;
  navn: string;
  hjemmeside: string;
  content_source: string | null;
  about_text: string | null;
  visit_text: string | null;
  field_provenance: string | null;
};

/**
 * Auto-select gårdssalg providers in scope for the retroactive scan:
 * gårdssalg providers (producer_type set OR rfb-seed) WITH a website, NOT
 * row-level locked (content_source != 'manual'). Sub-slice 3j (dev-request
 * 2026-07-30-opplevagent-claim-epost-og-perfelt-laas): 'claim' rows are now
 * IN scope here too — the whole-row freeze narrows to a per-field freeze,
 * enforced downstream in applyGardssalgRetroScanNull via the same already-
 * shipped isGardssalgFieldOwnerLocked(row, fieldName) helper sub-slice 3i
 * wired through the content-refresh writer. `field_provenance` is selected
 * so that per-field check has the `owner_locks` data it needs, without a
 * second DB round-trip. Deliberately does NOT filter on catalog_hidden — the
 * dev-request explicitly requires "both visible AND hidden" rows in scope,
 * unlike selectGardssalgProvidersForAddressEnrichment's catalog_hidden
 * exclusion above. Deliberately does NOT filter on whether about_text/
 * visit_text is blank/thin either — unlike
 * selectGardssalgProvidersForContentRefresh, this is a full retroactive
 * sweep, not a "only rows with an obvious gap" queue; a row whose about_text/
 * visit_text is already blank is simply a no-op once selected (nothing to
 * judge/null). Ordered oldest-created first — there is no dedicated
 * retro-scan attempt timestamp (out of scope for this one-shot sweep,
 * mirrors selectGardssalgProvidersForAddressEnrichment's own choice of
 * created_at ASC over adding a new column). Hard-capped at 48 — there are
 * only 48 gårdssalg providers total.
 */
export function selectGardssalgProvidersForRetroScan(limit = 48): GardssalgRetroScanTarget[] {
  const db = getDb(VERTICAL);
  const cap = Math.max(1, Math.min(48, limit));
  return db
    .prepare(
      `SELECT id, navn, TRIM(hjemmeside) AS hjemmeside, content_source, about_text, visit_text, field_provenance
         FROM experience_providers
        WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
          AND (producer_type IS NULL OR producer_type != 'test-gardssalg')
          AND hjemmeside IS NOT NULL AND TRIM(hjemmeside) != ''
          AND (content_source IS NULL OR content_source != 'manual')
        ORDER BY created_at ASC
        LIMIT ?`
    )
    .all(cap) as GardssalgRetroScanTarget[];
}

/**
 * Resolve an explicit providerId for the retro-scan's `providerIds`
 * override. Scoped to the gårdssalg WHERE clause (producer_type set OR
 * rfb-seed) — NOT the lock filter above, so an explicitly-requested locked
 * provider still resolves to a target (and is then reported in
 * skipped_locked by the route's own in-code check, same convention as
 * getGardssalgProviderContentTarget/getGardssalgProviderAddressTarget).
 * Returns null when the provider doesn't exist, isn't a gårdssalg provider,
 * or has no usable website.
 */
export function getGardssalgProviderRetroScanTarget(providerId: string): GardssalgRetroScanTarget | null {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT id, navn, TRIM(hjemmeside) AS hjemmeside, content_source, about_text, visit_text, field_provenance
         FROM experience_providers
        WHERE id = ?
          AND (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')`
    )
    .get(providerId) as GardssalgRetroScanTarget | undefined;
  if (!row || !row.hjemmeside || row.hjemmeside.trim().length === 0) return null;
  return row;
}

/**
 * Null a set of about_text/visit_text/opening_hours_text fields on ONE
 * gårdssalg provider — either because the retro-scan (POST /admin/gardssalg-
 * retro-scan, routes/opplevelser.ts, about_text/visit_text only — see that
 * route's own "Non-goals: no changes to opening_hours_text" note) judged the
 * CURRENTLY STORED value as no longer clearing the gårdssalg quality gate, or
 * because an admin explicitly asked POST /admin/gardssalg-content-clear
 * (dev-request 2026-08-18-apningstider-llm-dommer, spec D — about_text/
 * visit_text only until then) to blank a contaminated field so the fill
 * machinery can re-populate it. `fields` accepts opening_hours_text purely so
 * that second caller can reuse this exact same audited, reversible write
 * path rather than duplicating it — the retro-scan route itself never passes
 * it. Mirrors applyGardssalgProviderContent's
 * exact write discipline so the row stays reversible via the existing
 * /admin/gardssalg-content-rollback lever (no new rollback mechanism):
 *   - lock re-checked against a FRESH row snapshot (defense in depth — the
 *     caller already checked the target's pre-fetch snapshot, but a row
 *     could in principle have been claimed between selection and this
 *     write); a locked row writes nothing.
 *   - content_source/content_evidence_url/content_updated_at stamped in the
 *     SAME UPDATE as the field nulls, only when >=1 field is actually
 *     nulled (a no-op write stamps nothing) — identical convention to
 *     applyGardssalgProviderContent.
 *   - one gardssalg_content_audit row per field actually nulled (old_value =
 *     the contaminated value just cleared, new_value = NULL), so
 *     planGardssalgContentRollback/applyGardssalgContentRollback (unchanged)
 *     can restore it.
 *   - field_provenance entries for nulled fields are REMOVED (read-modify-
 *     write, preserves other fields' entries) — a blank field has no source
 *     backing it any more.
 * A field already blank is left alone (nothing to null); a provider with
 * nothing to null across the requested fields writes nothing and returns [].
 *
 * Sub-slice 3j (dev-request 2026-07-30-opplevagent-claim-epost-og-perfelt-
 * laas): 'manual' rows keep the unconditional, full-row freeze (unchanged —
 * still bails before the loop below). 'claim' rows no longer bail here — the
 * freeze narrows to per-field, via the SAME already-shipped, already-
 * reviewed isGardssalgFieldOwnerLocked(row, fieldName) helper sub-slice 3i
 * wired through applyGardssalgProviderContent (no new policy logic, only
 * wiring): each requested field is checked individually inside the loop
 * below, and an owner-locked field is skipped (never nulled, never added to
 * `written`) exactly like an already-blank field is. This is the real
 * enforcement point — the route's own prediction (see processOne in
 * routes/opplevelser.ts) is only a preview; this function's fresh DB read of
 * `row` is what actually decides.
 */
export function applyGardssalgRetroScanNull(
  providerId: string,
  fields: Array<"about_text" | "visit_text" | "opening_hours_text">,
  evidenceUrl: string,
  batchId?: string
): string[] {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT id, content_source, about_text, visit_text, opening_hours_text, field_provenance FROM experience_providers WHERE id = ?`
    )
    .get(providerId) as
    | {
        id: string;
        content_source: string | null;
        about_text: string | null;
        visit_text: string | null;
        opening_hours_text: string | null;
        field_provenance: string | null;
      }
    | undefined;
  if (!row) return [];
  if (row.content_source === "manual") return [];

  const oldValues: Record<string, string | null> = {
    about_text: row.about_text,
    visit_text: row.visit_text,
    opening_hours_text: row.opening_hours_text,
  };
  const sets: string[] = [];
  const params: Record<string, unknown> = { id: providerId };
  const written: string[] = [];

  for (const f of fields) {
    const current = oldValues[f];
    if (current === null || current === undefined || String(current).trim() === "") continue; // already blank — nothing to null
    if (row.content_source === "claim" && isGardssalgFieldOwnerLocked(row, f)) continue; // owner-locked — never null a field the owner explicitly locked
    sets.push(`${f} = NULL`);
    written.push(f);
  }
  if (written.length === 0) return [];

  sets.push("content_source = 'provider_site'");
  sets.push("content_evidence_url = @evidence_url");
  sets.push("content_updated_at = datetime('now')");
  params.evidence_url = evidenceUrl;

  // field_provenance merge — remove the entry for each nulled field (no
  // source backs a blank value any more), preserving every OTHER field's
  // entry (read-modify-write, never clobbers).
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
  for (const f of written) delete provenance[f];
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
        new_value: null,
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

// ─── Gårdssalg Brreg contact backfill (dev-request 2026-07-26-brreg-kontakt-
// backfill) ──────────────────────────────────────────────────────────────────
//
// Measured 2026-07-27 over the full live cohort: 344 of 389 gårdssalg
// providers have NEITHER epost NOR telefon on file, which makes them
// simultaneously un-contactable (no outreach) and un-claimable (the claim
// flow derives its magic-link target from an org-linked email). 333 of those
// have an org_nr; 101 of them (30.3 %) have a contact channel registered in
// Brreg's own /enheter/{orgNr} response — a field the codebase never read.
//
// Unlike selectGardssalgProvidersForAddressEnrichment above, this selector
// deliberately does NOT exclude catalog_hidden=1 rows. Hidden IS the cohort:
// 246 of the 257 website-less providers are hidden precisely because we have
// no content for them, and giving them a contact channel is the only path by
// which they ever get claimed and published. Writing a fill-only contact
// field onto a hidden row publishes nothing and sends nothing (sends stay
// behind their own separate gate).

export type GardssalgContactBackfillTarget = {
  id: string;
  navn: string;
  org_nr: string;
  content_source: string | null;
  epost: string | null;
  telefon: string | null;
  hjemmeside: string | null;
};

// Higher than the 48 the sibling gårdssalg admin routes use: this cohort is
// ~333 rows and criterion 6 calls for a dry-run over ALL of them, so a 48-cap
// would need 7 round-trips. 100 sequential Brreg lookups is ~25s — comfortably
// inside the request timeout — and keeps the walk to 4 calls.
export const GS_CB_HARD_CAP = 100;

const GS_CONTACT_TARGET_COLUMNS = `id, navn, org_nr, content_source, epost, telefon, hjemmeside`;

/**
 * Auto-select gårdssalg providers eligible for a Brreg contact backfill:
 * gårdssalg providers (producer_type set OR rfb-seed) WITH an org_nr, NOT
 * locked (content_source not in manual/claim), and missing AT LEAST ONE of
 * epost/telefon. Fill-only downstream, so a row missing just one of the two
 * is still worth a lookup.
 *
 * Ordered by created_at ASC then id ASC — a total order, so paging with
 * `offset` is stable across calls (the dry-run has to walk a ~333-row cohort
 * in batches, and a non-deterministic tie-break would silently skip rows).
 * Hard-capped at GS_CB_HARD_CAP per call.
 */
export function selectGardssalgProvidersForContactBackfill(
  limit = 48,
  offset = 0
): GardssalgContactBackfillTarget[] {
  const db = getDb(VERTICAL);
  const cap = Math.max(1, Math.min(GS_CB_HARD_CAP, limit));
  const off = Math.max(0, Math.floor(offset));
  return db
    .prepare(
      `SELECT ${GS_CONTACT_TARGET_COLUMNS}
         FROM experience_providers
        WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
          AND org_nr IS NOT NULL AND TRIM(org_nr) != ''
          AND (content_source IS NULL OR content_source NOT IN ('manual','claim'))
          AND ((epost IS NULL OR TRIM(epost) = '') OR (telefon IS NULL OR TRIM(telefon) = ''))
        ORDER BY created_at ASC, id ASC
        LIMIT ? OFFSET ?`
    )
    .all(cap, off) as GardssalgContactBackfillTarget[];
}

/** Total size of the contact-backfill cohort — lets the route report how far
 * a paged dry-run has to walk, instead of the caller guessing. */
export function countGardssalgProvidersForContactBackfill(): number {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM experience_providers
        WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
          AND org_nr IS NOT NULL AND TRIM(org_nr) != ''
          AND (content_source IS NULL OR content_source NOT IN ('manual','claim'))
          AND ((epost IS NULL OR TRIM(epost) = '') OR (telefon IS NULL OR TRIM(telefon) = ''))`
    )
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Resolve an explicit providerId for the contact-backfill route's
 * `providerIds` override. Scoped to the gårdssalg WHERE clause only — NOT the
 * blank-contact/lock filters — so an admin can force a lookup for a provider
 * the auto-selector wouldn't pick (mirrors getGardssalgProviderAddressTarget's
 * override semantics). Returns null when the provider doesn't exist, isn't a
 * gårdssalg provider, or has no org_nr.
 */
export function getGardssalgProviderContactTarget(providerId: string): GardssalgContactBackfillTarget | null {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT ${GS_CONTACT_TARGET_COLUMNS}
         FROM experience_providers
        WHERE id = ?
          AND (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')`
    )
    .get(providerId) as GardssalgContactBackfillTarget | undefined;
  if (!row || !row.org_nr || row.org_nr.trim().length === 0) return null;
  return row;
}

// ── Contact-email review queue (dev-request 2026-08-17-kontaktadresse-
// feilkilde-og-override, Skive C) ──────────────────────────────────────────
//
// field_provenance stamp key for an email candidate/value whose registrable
// domain deviates from the provider's established hjemmeside domain. Same
// "verification STAMP living inside field_provenance" idiom as
// GardssalgContactEmailOverrideStamp below (and hjemmeside_verification
// before it) — no shared typed FieldProvenance interface exists in this
// codebase, so this is a local minimal shape scoped to just this one stamp.
//
// Two producers write it:
//   1. applyGardssalgProviderContact's write-time gate — a NEW candidate
//      held back instead of written (the row's epost stays blank);
//   2. POST /admin/gardssalg-contact-email-audit (apply=true) — an
//      ALREADY-PUBLISHED legacy mismatch, retroactively flagged so the
//      render surfaces hide it (AC4/AC5).
//
// One consumer today: isGardssalgContactEmailFlaggedForReview
// (routes/opplevelser.ts), read by the produsent-profil page + its JSON-LD.
// Scoped to `flagged_email` on purpose, exactly like the override stamp's
// approved_email: if epost later changes by ANY path, the stamp no longer
// matches the row's current value and the flag lapses on its own — no
// explicit cleanup step, and a stale flag can never suppress a NEW,
// never-flagged address.
export interface GardssalgContactEmailFlaggedReviewStamp {
  flagged_email: string;
  website_domain: string | null;
  email_domain: string;
  reason: "domain_mismatch";
  source: string;
  flagged_at: string;
}

/** What applyGardssalgProviderContact reports back about a held-back epost. */
export type GardssalgContactEmailFlaggedForReview = {
  candidate: string;
  website_domain: string;
  email_domain: string;
};

export type GardssalgProviderContactWriteResult = {
  /** Field names actually written (empty when nothing was written). */
  written: string[];
  /**
   * Present only when the epost candidate was withheld by the write-time
   * domain gate — lets a caller distinguish "wrote nothing because the field
   * was already filled / the row is locked" from "wrote nothing because the
   * address is under review".
   */
  epostFlaggedForReview?: GardssalgContactEmailFlaggedForReview;
  /**
   * Present when the shared LLM-judge contact gate (gateContactCandidates)
   * rejected the epost and/or telefon candidate passed in — keyed by field,
   * valued by the gate's rejection reason. Without this, a judge-rejected
   * candidate wrote nothing and looked identical to "the field was already
   * filled / the row is locked" from the caller's side (both report
   * written: [] with no other signal). Mirrors the observability the other
   * 3 gated sites already have (RFB contact-extraction, RFB brreg-backfill,
   * gårdssalg autosvar).
   */
  contactGateRejected?: { epost?: string; telefon?: string };
};

/**
 * Stamp field_provenance.contact_email_flagged_review for ONE provider.
 * Read-modify-write merge that preserves every other key (malformed existing
 * JSON is treated as {} rather than clobbering the write — same defensive
 * parse as applyGardssalgProviderContact/applyGardssalgSetContactEmail).
 *
 * Deliberately does NOT touch the `epost` column, does NOT insert a
 * gardssalg_content_audit row and does NOT bump updated_at: this is a
 * provenance/queue stamp about a candidate, not a change to a published
 * field. (gardssalg_content_audit is the visible-content change log; a
 * write-time-blocked candidate never became visible content, and bumping
 * updated_at would make the sitemap claim a freshness that no reader can
 * observe.) Idempotent in effect — re-stamping the same address just
 * refreshes flagged_at.
 */
export function flagGardssalgContactEmailForReview(
  providerId: string,
  stamp: Omit<GardssalgContactEmailFlaggedReviewStamp, "flagged_at">,
): void {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(`SELECT field_provenance FROM experience_providers WHERE id = ?`)
    .get(providerId) as { field_provenance: string | null } | undefined;
  if (!row) return;
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
  const full: GardssalgContactEmailFlaggedReviewStamp = { ...stamp, flagged_at: new Date().toISOString() };
  provenance.contact_email_flagged_review = full;
  db.prepare(`UPDATE experience_providers SET field_provenance = @fp WHERE id = @id`).run({
    id: providerId,
    fp: JSON.stringify(provenance),
  });
}

/**
 * Apply a Brreg contact candidate to ONE gårdssalg provider. Same discipline
 * as applyGardssalgProviderAddress: NEVER writes if the provider is locked
 * ('manual'/'claim'); FILL-ONLY (a field is written only when the row's
 * current value is blank AND the candidate has content — an existing value is
 * never replaced); one gardssalg_content_audit row per field actually written
 * with the true pre-write old_value; a {source_url, fetched_at} entry merged
 * into field_provenance per written field; all in one transaction.
 *
 * Scope is epost/telefon ONLY. `hjemmeside` is deliberately NOT written here
 * even though Brreg returns it in the same response — website adoption has an
 * established evidence-checked review-queue path
 * (gardssalg_website_review_queue) and this backfill routes candidates there
 * instead of bypassing it. Returns the field names actually written (empty
 * array when there was nothing to write) plus, when the epost candidate was
 * held back by the write-time domain gate below, a description of what was
 * flagged instead. Idempotent.
 *
 * WRITE-TIME DOMAIN GATE (2026-08-18, dev-request 2026-08-17-kontaktadresse-
 * feilkilde-og-override, Skive C(a)): a candidate epost whose registrable
 * domain disagrees with the provider's established hjemmeside domain is NOT
 * written as a publishable address — it is stamped into
 * field_provenance.contact_email_flagged_review (a review queue a human
 * resolves later via POST /admin/gardssalg-set-contact-email with
 * force:true, the Skive A override path) and reported back to the caller.
 * The check lives HERE rather than in each route because both writers
 * (POST /admin/gardssalg-contact-extraction, HTML-scrape source, and
 * POST /admin/gardssalg-contact-backfill, Brreg-registry source) funnel
 * their real write through this one function — one choke point, no
 * duplicated logic, no way for a new caller to skip it.
 *
 * Exemptions, all deliberate and mirroring applyGardssalgSetContactEmail's
 * own domain check:
 *   - no established hjemmeside on file -> nothing to contradict, write
 *     proceeds (same precedent as Skive A);
 *   - freemail candidate (FREE_MAIL_DOMAINS) -> a farm on gmail.com is the
 *     norm, not a wrong-company signal, and extractGardssalgContactEmail
 *     already treats freemail as its own trusted tier;
 *   - telefon is completely unaffected — this gate is epost-only.
 *
 * LLM-JUDGE CONTACT GATE (2026-08-19, dev-request 2026-08-19-kursjustering-
 * drikkefunnel-llm-og-supply, Grep 5b): every incoming epost/telefon
 * candidate is now ALSO run through gateContactCandidates (backstop
 * classifier + LLM judge, src/services/contact-candidate-judge.ts) before
 * anything below decides what to write — the exact same "one choke point,
 * no duplicated logic, no way for a new caller to skip it" rationale as the
 * domain gate above, and living in the same place for the same reason: both
 * writer routes (contact-extraction, contact-backfill) funnel through this
 * one function. A judge-rejected candidate is treated EXACTLY like the
 * extractor having found nothing for that field — fail-closed, no write, no
 * throw — and the existing fill-only/lock/domain-mismatch guards below run
 * UNCHANGED on whatever survives the gate. `gateContext` carries the
 * business name + page/source text the judge needs; callers that omit it
 * (there should be none in production — both writer routes pass it) still
 * get a safe fail-closed gate call with an empty context, which can only
 * ever make the judge MORE likely to reject, never less.
 *
 * A rejection is logged (`[gardssalg-contact-write] ... REJECTED by contact
 * gate ...`, matching the format the other 3 gated sites already use) and
 * reported back via the result's `contactGateRejected` field — without this,
 * a judge-rejected candidate wrote nothing and was indistinguishable from
 * "field already filled" / "row locked" to both callers of this function.
 */
export async function applyGardssalgProviderContact(
  providerId: string,
  candidate: { epost?: string | null; telefon?: string | null; epostSource?: string | null },
  evidenceUrl: string,
  batchId?: string,
  gateContext?: { businessName: string; sourceContext: string }
): Promise<GardssalgProviderContactWriteResult> {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT id, content_source, epost, telefon, hjemmeside, field_provenance
         FROM experience_providers WHERE id = ?`
    )
    .get(providerId) as
    | {
        id: string;
        content_source: string | null;
        epost: string | null;
        telefon: string | null;
        hjemmeside: string | null;
        field_provenance: string | null;
      }
    | undefined;
  if (!row) return { written: [] };
  if (row.content_source === "manual" || row.content_source === "claim") return { written: [] };

  function isBlank(v: unknown): boolean {
    return v === null || v === undefined || String(v).trim() === "";
  }

  // ── LLM-judge contact gate (Grep 5b) — see doc comment above ────────────
  // Eligibility computed BEFORE the gate call, against the untouched
  // candidate, using the exact same fill-only + not-rolled-back conditions
  // the write decision below re-checks — so a rejection is only logged/
  // reported for a field that would actually have been written had the
  // gate approved it. Without this scoping, a redundant candidate for an
  // already-filled or rolled-back field (routes pass the full candidate
  // regardless of per-field eligibility) would misreport as "gate
  // rejected" a value that was never going to be written anyway.
  const epostGateEligible =
    isBlank(row.epost) && !!candidate.epost?.trim() && !gardssalgContactFieldWasRolledBack(providerId, "epost");
  const telefonGateEligible =
    isBlank(row.telefon) && !!candidate.telefon?.trim() && !gardssalgContactFieldWasRolledBack(providerId, "telefon");
  const gated = await gateContactCandidates({
    businessName: gateContext?.businessName ?? "",
    sourceContext: gateContext?.sourceContext ?? "",
    candidateEmail: candidate.epost ?? null,
    candidatePhone: candidate.telefon ?? null,
  });
  let contactGateRejected: { epost?: string; telefon?: string } | undefined;
  const gateLogName = gateContext?.businessName?.trim() || providerId;
  if (epostGateEligible && !gated.email) {
    const reason = gated.emailRejectedReason ?? "unknown reason";
    contactGateRejected = { ...contactGateRejected, epost: reason };
    console.log(
      `[gardssalg-contact-write] ${providerId} (${gateLogName}) epost candidate "${(candidate.epost as string).trim()}" REJECTED by contact gate — ${reason}; not written`
    );
  }
  if (telefonGateEligible && !gated.phone) {
    const reason = gated.phoneRejectedReason ?? "unknown reason";
    contactGateRejected = { ...contactGateRejected, telefon: reason };
    console.log(
      `[gardssalg-contact-write] ${providerId} (${gateLogName}) telefon candidate "${(candidate.telefon as string).trim()}" REJECTED by contact gate — ${reason}; not written`
    );
  }
  candidate = { epost: gated.email, telefon: gated.phone, epostSource: candidate.epostSource };

  const sets: string[] = [];
  const params: Record<string, unknown> = { id: providerId };
  const written: string[] = [];
  // Pre-write snapshot — captured BEFORE any write, so the audit trail's
  // old_value is always the true pre-write value.
  const oldValues: Record<string, string | null> = {
    epost: row.epost,
    telefon: row.telefon,
  };

  // Write-time domain gate (Skive C(a)) — see this function's doc comment.
  // Computed BEFORE the epost branch decides anything, so a flagged
  // candidate never reaches `sets`/`written`.
  let epostFlaggedForReview: GardssalgContactEmailFlaggedForReview | null = null;
  if (isBlank(row.epost) && candidate.epost?.trim() && !gardssalgContactFieldWasRolledBack(providerId, "epost")) {
    const candidateEmail = candidate.epost.trim();
    if (row.hjemmeside && row.hjemmeside.trim() !== "") {
      const websiteHost = hostFromUrlLike(row.hjemmeside);
      const websiteDomain = websiteHost ? registrableDomain(websiteHost) : null;
      if (websiteDomain) {
        const emailHostRaw = candidateEmail.split("@").pop() || "";
        const emailHost = hostFromUrlLike(emailHostRaw);
        const emailDomain = emailHost ? registrableDomain(emailHost) : "";
        const isFreeMail =
          FREE_MAIL_DOMAINS.includes(emailHostRaw.toLowerCase()) || FREE_MAIL_DOMAINS.includes(emailDomain);
        if (emailDomain !== websiteDomain && !isFreeMail) {
          epostFlaggedForReview = {
            candidate: candidateEmail,
            website_domain: websiteDomain,
            email_domain: emailDomain,
          };
        }
      }
    }
  }

  if (
    isBlank(row.epost)
    && candidate.epost?.trim()
    && !gardssalgContactFieldWasRolledBack(providerId, "epost")
    && !epostFlaggedForReview
  ) {
    sets.push("epost = @epost");
    params.epost = candidate.epost.trim();
    written.push("epost");
  }
  if (isBlank(row.telefon) && candidate.telefon?.trim() && !gardssalgContactFieldWasRolledBack(providerId, "telefon")) {
    sets.push("telefon = @telefon");
    params.telefon = candidate.telefon.trim();
    written.push("telefon");
  }

  // The flag stamp is written even when there is nothing else to write —
  // that is the whole point: a held-back candidate must leave a visible,
  // resolvable trace rather than vanishing. Always stamped AFTER this
  // function's own field_provenance write below (when there is one), because
  // both are read-modify-write merges over the same column: stamping first
  // would be clobbered by the `provenance` object this function already read
  // from the pre-write row.
  const stampFlag = (): void => {
    if (!epostFlaggedForReview) return;
    flagGardssalgContactEmailForReview(providerId, {
      flagged_email: epostFlaggedForReview.candidate,
      website_domain: epostFlaggedForReview.website_domain,
      email_domain: epostFlaggedForReview.email_domain,
      reason: "domain_mismatch",
      source: candidate.epostSource?.trim() || "unknown",
    });
  };

  if (sets.length === 0) {
    stampFlag();
    return {
      written: [],
      ...(epostFlaggedForReview ? { epostFlaggedForReview } : {}),
      ...(contactGateRejected ? { contactGateRejected } : {}),
    };
  }

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
  stampFlag();

  return {
    written,
    ...(epostFlaggedForReview ? { epostFlaggedForReview } : {}),
    ...(contactGateRejected ? { contactGateRejected } : {}),
  };
}

export type GardssalgSetContactEmailResult =
  | { ok: true; old_value: string | null; new_value: string }
  | { ok: false; reason: "provider_not_found" }
  | { ok: false; reason: "domain_mismatch"; website_domain: string; email_domain: string };

// field_provenance stamp key for a force-approved domain-mismatch override
// (dev-request 2026-08-17-kontaktadresse-feilkilde-og-override, Skive A).
// Same "verification STAMP living inside field_provenance" idiom this file
// already uses for hjemmeside_verification (see isHjemmesideVerified in
// routes/opplevelser.ts) — a human/session confirmed this EXACT address is
// correct despite the domain mismatch, so the daily-prep
// address_domain_mismatch gate (routes/opplevelser.ts,
// GET /admin/gardssalg-outreach-daily-prep) can stop re-flagging it. Scoped
// to the exact approved_email value on purpose (AC2): if epost is later
// changed by ANY path (this endpoint again, contact-backfill, field-
// concordance, ...) without a fresh force-approval, the stamp's
// approved_email no longer equals the row's current epost, so the reader
// (getGardssalgContactEmailOverride, routes/opplevelser.ts) reports it as
// lapsed rather than silently carrying the old approval over to a new,
// never-reviewed address. No shared typed FieldProvenance interface exists
// in this codebase (every field_provenance read/write inlines its own shape
// — see isHjemmesideVerified's own doc comment), so this is a local, minimal
// shape scoped to just this one stamp, matching that convention.
export interface GardssalgContactEmailOverrideStamp {
  approved_email: string;
  approved_by: string;
  approved_at: string;
  source: string;
  website_domain: string;
  email_domain: string;
}

/**
 * Correct an already-filled (or blank) gårdssalg provider `epost`, unlike
 * applyGardssalgProviderContact above which is strictly fill-only. Backs
 * POST /admin/gardssalg-set-contact-email — the missing "correct a
 * wrong-but-filled value" path (e.g. an autoresponder reports the old
 * contact person left and gives a new address).
 *
 * Domain check: when the provider has an established hjemmeside on file, the
 * new email's registrable domain must match the hjemmeside's registrable
 * domain unless `force` is true — same eTLD+1 comparison
 * (hostFromUrlLike + registrableDomain) used elsewhere in this file. A
 * provider with no hjemmeside has no evidence to contradict, so the write
 * proceeds regardless of `force`.
 *
 * force-approval persistence (Skive A, dev-request 2026-08-17-kontaktadresse-
 * feilkilde-og-override): when `force: true` is the reason a genuine domain
 * mismatch was bypassed (website has an established domain AND it disagrees
 * with the new email's domain), a GardssalgContactEmailOverrideStamp is
 * written to field_provenance.contact_email_domain_override so the daily-
 * prep address_domain_mismatch gate can respect it later — see that type's
 * own doc comment. `force: true` on a write that never actually hit a
 * mismatch (no hjemmeside on file, or the domains already agreed) writes NO
 * stamp — there was nothing to override.
 *
 * NOTE: deliberately does NOT check content_source ('manual'/'claim') the
 * way applyGardssalgProviderContact does — that lock-guard was considered
 * for this slice and left out of scope on purpose (see PR description).
 *
 * Write discipline mirrors applyGardssalgProviderContact: pre-write
 * old_value snapshot, read-merge-write field_provenance (malformed/missing
 * JSON treated as {} rather than clobbered), one gardssalg_content_audit row,
 * all inside a single transaction.
 */
export function applyGardssalgSetContactEmail(
  providerId: string,
  email: string,
  source: string,
  force: boolean
): GardssalgSetContactEmailResult {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT id, epost, hjemmeside, content_source, field_provenance
         FROM experience_providers WHERE id = ?`
    )
    .get(providerId) as
    | {
        id: string;
        epost: string | null;
        hjemmeside: string | null;
        content_source: string | null;
        field_provenance: string | null;
      }
    | undefined;
  if (!row) return { ok: false, reason: "provider_not_found" };

  // ── domain check (only when the provider has an established hjemmeside) ──
  // domainOverride is set only when `force` actually bypassed a REAL
  // mismatch — never on a force:true call that never hit one.
  let domainOverride: { website_domain: string; email_domain: string } | null = null;
  if (row.hjemmeside && row.hjemmeside.trim() !== "") {
    const websiteHost = hostFromUrlLike(row.hjemmeside);
    const websiteDomain = websiteHost ? registrableDomain(websiteHost) : null;
    if (websiteDomain) {
      const emailHost = hostFromUrlLike(email.split("@").pop() || "");
      const emailDomain = emailHost ? registrableDomain(emailHost) : "";
      if (emailDomain !== websiteDomain) {
        if (force !== true) {
          return {
            ok: false,
            reason: "domain_mismatch",
            website_domain: websiteDomain,
            email_domain: emailDomain,
          };
        }
        domainOverride = { website_domain: websiteDomain, email_domain: emailDomain };
      }
    }
  }

  const oldValue = row.epost;

  // ── field_provenance merge (read-modify-write, preserves other fields) ──
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
  provenance.epost = { source_url: source, fetched_at: new Date().toISOString() };
  // Skive C fix-up (independent review, finding B1): a confirmed epost write
  // through THIS endpoint is a human resolving the address, so it always ends
  // any pending review on this row. Without it, an address flagged by the
  // write-time gate or the catalog audit (field_provenance.contact_email_
  // flagged_review) stayed flagged even after a human force-approved that
  // EXACT address here — the documented resolution path silently did nothing
  // and the produsent-profil page + its JSON-LD kept hiding the approved
  // address forever. Done inside the same read-modify-write merge (no extra
  // write, every other provenance key preserved); a no-op when no flag exists.
  delete provenance.contact_email_flagged_review;
  if (domainOverride) {
    const stamp: GardssalgContactEmailOverrideStamp = {
      approved_email: email,
      approved_by: "admin",
      approved_at: new Date().toISOString(),
      source,
      website_domain: domainOverride.website_domain,
      email_domain: domainOverride.email_domain,
    };
    provenance.contact_email_domain_override = stamp;
  }

  const applyWithAudit = db.transaction(() => {
    db.prepare(
      `UPDATE experience_providers SET epost = @email, field_provenance = @field_provenance WHERE id = @id`
    ).run({ id: providerId, email, field_provenance: JSON.stringify(provenance) });
    db.prepare(
      `INSERT INTO gardssalg_content_audit
         (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
       VALUES (@id, @provider_id, 'epost', @old_value, @new_value, @source_url, NULL, 'admin', datetime('now'))`
    ).run({
      id: uuid(),
      provider_id: providerId,
      old_value: oldValue,
      new_value: email,
      source_url: source,
    });
  });
  applyWithAudit();

  return { ok: true, old_value: oldValue, new_value: email };
}

export type GardssalgSetContactPhoneResult =
  | { ok: true; old_value: string | null; new_value: string }
  | { ok: false; reason: "provider_not_found" }
  | { ok: false; reason: "invalid_phone" };

/**
 * Correct an already-filled (or blank) gårdssalg provider `telefon`, the
 * phone-field counterpart to applyGardssalgSetContactEmail above (same
 * "correct a wrong-but-filled value" gap, this time surfaced by the Monkey
 * Brew case: a producer replied with a corrected phone number and no write
 * path existed to apply it — dev-request 2026-08-18-gardssalg-set-contact-phone).
 * Backs POST /admin/gardssalg-set-contact-phone.
 *
 * Unlike the email sibling, there is no domain-mismatch concept for a phone
 * number, so this has no `force` parameter — the only gate is the SAME
 * write-time phone guard `agent_knowledge` writes already use
 * (validatePhoneForWrite/classifyPhoneForWrite, contact-normalizer.ts):
 * reject values that don't reduce to a valid 8-digit Norwegian national
 * number, that collide with the provider's own org_nr, or that look like a
 * YYYYMMDD date. That guard was built specifically because unvalidated
 * "phone" writes have previously persisted org-numbers and dates verbatim
 * (2026-07-27 regressions, see contact-normalizer.ts's own doc comment) — an
 * admin-typed correction is not exempt from that failure mode just because a
 * human typed it, so this endpoint reuses the existing check rather than
 * skipping it.
 *
 * `validatePhoneForWrite` returns the ORIGINAL string unchanged when it
 * passes (see that function's own doc comment) — it validates SHAPE, it does
 * not normalize for storage. So a formatted input ("+47 476 36 504") is
 * accepted and persisted verbatim, not collapsed to bare digits. This
 * matches applyGardssalgSetContactEmail's precedent of storing the
 * admin-supplied value as typed, with no separate normalization step.
 *
 * Write discipline mirrors applyGardssalgSetContactEmail: pre-write
 * old_value snapshot, read-merge-write field_provenance (malformed/missing
 * JSON treated as {} rather than clobbered), one gardssalg_content_audit row,
 * all inside a single transaction.
 */
export function applyGardssalgSetContactPhone(
  providerId: string,
  phone: string,
  source: string
): GardssalgSetContactPhoneResult {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT id, telefon, org_nr, field_provenance
         FROM experience_providers WHERE id = ?`
    )
    .get(providerId) as
    | { id: string; telefon: string | null; org_nr: string | null; field_provenance: string | null }
    | undefined;
  if (!row) return { ok: false, reason: "provider_not_found" };

  const validated = validatePhoneForWrite(phone, row.org_nr);
  if (validated === null) return { ok: false, reason: "invalid_phone" };

  const oldValue = row.telefon;

  // ── field_provenance merge (read-modify-write, preserves other fields) ──
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
  provenance.telefon = { source_url: source, fetched_at: new Date().toISOString() };

  const applyWithAudit = db.transaction(() => {
    db.prepare(
      `UPDATE experience_providers SET telefon = @phone, field_provenance = @field_provenance WHERE id = @id`
    ).run({ id: providerId, phone: validated, field_provenance: JSON.stringify(provenance) });
    db.prepare(
      `INSERT INTO gardssalg_content_audit
         (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
       VALUES (@id, @provider_id, 'telefon', @old_value, @new_value, @source_url, NULL, 'admin', datetime('now'))`
    ).run({
      id: uuid(),
      provider_id: providerId,
      old_value: oldValue,
      new_value: validated,
      source_url: source,
    });
  });
  applyWithAudit();

  return { ok: true, old_value: oldValue, new_value: validated };
}

export type GardssalgSetContentFieldResult =
  | { ok: true; old_value: string | null; new_value: string }
  | { ok: false; reason: "provider_not_found" }
  | { ok: false; reason: "owner_locked" }
  | { ok: false; reason: "value_required" }
  | { ok: false; reason: "defective_value"; defect_type: GardssalgDefectType | null };

/**
 * Write ONE gårdssalg CONTENT field (about_text / visit_text /
 * opening_hours_text) with a CALLER-SUPPLIED value — Grep 2b (dev-request
 * 2026-08-19-kursjustering-drikkefunnel-llm-og-supply). Backs POST
 * /admin/gardssalg-set-content-field.
 *
 * Why this exists at all: every existing content writer either generates its
 * own candidate or is fill-only. applyGardssalgProviderContent is fill-only
 * once a field is non-blank (bar the narrow replace-thin carve-out), and the
 * gardssalg-content-refresh route cannot carry LLM-authored text at all —
 * measured 0/12 rows enriched on the drinks cohort. So a CORRECTED value
 * (LLM-authored, or typed by a human after a producer reply) had no write
 * path onto the row. This is that path: the value comes from the caller, not
 * from a fetch.
 *
 * Scope is deliberately the THREE quality-vocabulary fields only.
 * `products` is NOT accepted: classifyGardssalgFieldDefect has no vocabulary
 * for it (GardssalgQualityFieldName, gardssalg-quality-update.ts), and
 * gardssalgProductsEligible is an emptiness check, not a value-quality
 * judge — accepting products here would mean writing it through NO quality
 * gate at all, which is exactly what this endpoint exists to avoid.
 *
 * Three gates, all mandatory, in this order:
 *   1. Owner-lock (isGardssalgFieldOwnerLocked, below) — re-read fresh from
 *      the row, never from a caller snapshot. Unlike the phone/email
 *      siblings (which deliberately skip content_source, having no
 *      owner-lock-eligible field to protect), these three fields are exactly
 *      the claim-portal-editable ones an owner can lock, so the same guard
 *      applyGardssalgProviderContent and applyGardssalgQualityReplacement
 *      already enforce applies here too. An admin lever is not an exemption
 *      from an owner's own edit.
 *   2. Non-blank value, checked HERE and not only in the route. This gate is
 *      not redundant: classifyGardssalgFieldDefect deliberately reports a
 *      blank value as NOT defective ("blank -> fill-only's job, not this
 *      classifier's", gardssalg-quality-update.ts), so without this check a
 *      fully type-checking direct call — applyGardssalgSetContentField(id,
 *      "about_text", "   ", src) — would sail past gate 3, BLANK a good
 *      value, and write an audit row asserting the change. Blanking is the
 *      most destructive outcome this function can produce, so the guard sits
 *      on the function itself; the route keeps its own earlier blank check
 *      (which maps this reason back onto the same 400 `value_required`), and
 *      the two together are defense in depth for non-HTTP callers.
 *   3. Objective defect (classifyGardssalgFieldDefect) on the SUPPLIED
 *      value. Called WITHOUT `othersForField`, exactly like the candidate-
 *      side classification in planGardssalgFieldReplacement: the
 *      duplicate-of-other-provider check compares against the whole live
 *      cohort and is meaningful for a scraped candidate, not for a value a
 *      caller deliberately typed for THIS provider. A defective value is
 *      rejected with NO write and NO audit row — fail closed; "an admin
 *      typed it" is not evidence that the text is not truncated,
 *      placeholder, UI chrome or CSS leakage (the LLM-authored case has
 *      exactly the same failure modes as the scraped one).
 *
 * There is deliberately no `force`/override parameter: an escape hatch past
 * gate 3 would make the gate decorative, and a genuinely-good value that
 * trips the classifier is a classifier bug to fix, not a value to smuggle in.
 *
 * What is NOT touched, on purpose: content_source, content_evidence_url,
 * content_updated_at, updated_at. Re-stamping content_source would flip the
 * row's ownership semantics (a 'manual'/'claim' stamp is what the owner-lock
 * above reads); content_updated_at is read by the quality lever's anti-churn
 * logic (checkGardssalgAntiChurn) and content_evidence_url asserts a fetched
 * page backs the value — none of which is true of an admin-supplied string.
 * Same minimalism as applyGardssalgSetContactPhone above.
 *
 * Rollback needs no new wiring: all three fields are already in
 * GARDSSALG_ROLLBACKABLE_FIELDS and the single audit row written below is
 * exactly the shape planGardssalgContentRollback reads.
 */
export function applyGardssalgSetContentField(
  providerId: string,
  field: GardssalgQualityFieldName,
  value: string,
  source: string
): GardssalgSetContentFieldResult {
  const db = getDb(VERTICAL);
  // All three content columns listed EXPLICITLY — `field` never reaches SQL
  // as text, here or in the UPDATE below (see the switch), even though it is
  // already narrowed to the closed union by the route's own validation.
  const row = db
    .prepare(
      `SELECT id, about_text, visit_text, opening_hours_text, content_source, field_provenance
         FROM experience_providers WHERE id = ?`
    )
    .get(providerId) as
    | {
        id: string;
        about_text: string | null;
        visit_text: string | null;
        opening_hours_text: string | null;
        content_source: string | null;
        field_provenance: string | null;
      }
    | undefined;
  if (!row) return { ok: false, reason: "provider_not_found" };

  // Gate 1 — owner lock, on the FRESH row (see doc comment).
  if (isGardssalgFieldOwnerLocked(row, field)) return { ok: false, reason: "owner_locked" };

  const trimmed = value.trim();
  // Gate 2 — non-blank. MUST run before the classifier: classifyGardssalgFieldDefect
  // reports a blank value as NOT defective on purpose (blank is fill-only's
  // job, not the classifier's), so without this a direct caller passing "" or
  // "   " would blank an existing good value AND get an audit row asserting
  // the change. The route checks this too; this is the same check on the
  // function itself, for callers that never go through HTTP.
  if (!trimmed) return { ok: false, reason: "value_required" };
  // Gate 3 — objective defect on the supplied value. No othersForField: see
  // doc comment. Returns before any write, so a rejected value leaves neither
  // a column change nor an audit row behind.
  const defect = classifyGardssalgFieldDefect(field, trimmed);
  if (defect.defective) {
    return { ok: false, reason: "defective_value", defect_type: defect.type };
  }

  const oldValue = row[field];

  // ── field_provenance merge (read-modify-write, preserves other fields) ──
  // Same parse-guard as applyGardssalgSetContactPhone above: malformed
  // existing JSON is treated as {} rather than clobbering the write. NB this
  // preserves any existing `owner_locks` object untouched — gate 1 already
  // refused every row where the lock applies to THIS field, and a lock on a
  // DIFFERENT field must survive this write.
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
  provenance[field] = { source_url: source, fetched_at: new Date().toISOString() };
  const provenanceJson = JSON.stringify(provenance);

  const applyWithAudit = db.transaction(() => {
    // Three LITERAL statements chosen by a switch — no column name is ever
    // built by interpolation, so this write path is structurally incapable of
    // taking a column name from request data.
    switch (field) {
      case "about_text":
        db.prepare(
          `UPDATE experience_providers SET about_text = @value, field_provenance = @field_provenance WHERE id = @id`
        ).run({ id: providerId, value: trimmed, field_provenance: provenanceJson });
        break;
      case "visit_text":
        db.prepare(
          `UPDATE experience_providers SET visit_text = @value, field_provenance = @field_provenance WHERE id = @id`
        ).run({ id: providerId, value: trimmed, field_provenance: provenanceJson });
        break;
      case "opening_hours_text":
        db.prepare(
          `UPDATE experience_providers SET opening_hours_text = @value, field_provenance = @field_provenance WHERE id = @id`
        ).run({ id: providerId, value: trimmed, field_provenance: provenanceJson });
        break;
      default: {
        // Do NOT "simplify" this away. Without it an unmatched field falls
        // through with NO UPDATE while the audit INSERT below still runs —
        // a PHANTOM audit row claiming a change that never happened, which
        // planGardssalgContentRollback then acts on and uses to DESTROY real
        // data (it restores old_value over a column this write never
        // touched). Throwing aborts the transaction before the INSERT, so
        // better-sqlite3 rolls the whole thing back and nothing is written.
        //
        // The `never` assignment makes the same case a COMPILE error the day
        // a fourth GardssalgQualityFieldName is added: TypeScript does not
        // flag a non-exhaustive switch on its own, so without this the switch
        // would silently stay at three cases. Same defense-in-depth
        // discipline applyGardssalgContentRollback applies to field_name.
        const _exhaustive: never = field;
        throw new Error(`unsupported field: ${String(_exhaustive)}`);
      }
    }
    // Exactly ONE audit row, same shape every other gårdssalg writer uses —
    // this is what makes the write reversible through the EXISTING POST
    // /admin/gardssalg-content-rollback with zero changes there.
    db.prepare(
      `INSERT INTO gardssalg_content_audit
         (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
       VALUES (@id, @provider_id, @field_name, @old_value, @new_value, @source_url, NULL, 'admin', datetime('now'))`
    ).run({
      id: uuid(),
      provider_id: providerId,
      field_name: field,
      old_value: oldValue,
      new_value: trimmed,
      source_url: source,
    });
  });
  applyWithAudit();

  return { ok: true, old_value: oldValue, new_value: trimmed };
}

export type GardssalgSetTerminalStatusResult =
  | { ok: true; old_value: string | null; new_value: string | null }
  | { ok: false; reason: "provider_not_found" };

export type GardssalgSetProducerTypeResult =
  | { ok: true; old_value: string | null; new_value: string | null }
  | { ok: false; reason: "provider_not_found" };

/**
 * Manually OVERRIDE a gårdssalg provider's `producer_type` — Grep 3c
 * (dev-request 2026-08-19-kursjustering-drikkefunnel-llm-og-supply follow-on).
 * Backs POST /admin/gardssalg-set-producer-type.
 *
 * Structurally mirrors applyGardssalgSetTerminalStatus above EXACTLY:
 * pre-write old_value snapshot, one gardssalg_content_audit row, all inside a
 * single transaction. Deliberately UNCONDITIONAL — no
 * `AND producer_type IS NULL` guard — unlike the existing
 * applyGardssalgProducerType() (routes/opplevelser.ts), which is fill-only
 * and therefore cannot correct an already-set, wrong classification (e.g. a
 * "bryggeri" that turns out to actually be an event venue, not a real drink
 * producer). This function is the missing override lever for that gap. No
 * field_provenance merge here either, same as the terminal_status precedent.
 *
 * `producerType: null` clears the column — this IS the rollback path for
 * this endpoint, same "null clears" discipline as terminal_status.
 *
 * Validation of `producerType` against the closed
 * DRINK_PRODUCER_TYPES/NON_DRINK_PRODUCER_TYPES vocabulary is the HTTP
 * handler's job (same division of labor as applyGardssalgSetTerminalStatus's
 * caller) — this function trusts its typed parameter.
 */
export function applyGardssalgSetProducerType(
  providerId: string,
  producerType: string | null,
  reason: string,
  sourceUrl?: string
): GardssalgSetProducerTypeResult {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(`SELECT id, producer_type FROM experience_providers WHERE id = ?`)
    .get(providerId) as { id: string; producer_type: string | null } | undefined;
  if (!row) return { ok: false, reason: "provider_not_found" };

  const oldValue = row.producer_type;
  const provenance = sourceUrl && sourceUrl.trim() ? sourceUrl.trim() : reason;

  const applyWithAudit = db.transaction(() => {
    db.prepare(
      `UPDATE experience_providers SET producer_type = @producer_type WHERE id = @id`
    ).run({ id: providerId, producer_type: producerType });
    db.prepare(
      `INSERT INTO gardssalg_content_audit
         (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
       VALUES (@id, @provider_id, 'producer_type', @old_value, @new_value, @source_url, NULL, 'admin', datetime('now'))`
    ).run({
      id: uuid(),
      provider_id: providerId,
      old_value: oldValue,
      new_value: producerType,
      source_url: provenance,
    });
  });
  applyWithAudit();

  return { ok: true, old_value: oldValue, new_value: producerType };
}

/**
 * Set (or, with `terminalStatus: null`, CLEAR) a gårdssalg provider's
 * `terminal_status` — dev-request 2026-08-19-kursjustering-drikkefunnel-llm-
 * og-supply, Grep 3a ("Ærlig kulling av de 296"). Backs POST
 * /admin/gardssalg-set-terminal-status.
 *
 * Structurally mirrors applyGardssalgSetContactPhone above: pre-write
 * old_value snapshot, one gardssalg_content_audit row, all inside a single
 * transaction. No field_provenance merge here — that column is a
 * telefon/epost/hjemmeside-only concept (per-contact-field source/fetched_at
 * shape), not something terminal_status participates in.
 *
 * `terminalStatus: null` is the ROLLBACK path for this write (dev-request's
 * own Rollback section) — clearing the column returns the row to its
 * ordinary derived readiness_tier (computeGardssalgReadinessTier,
 * routes/opplevelser.ts) on the very next read. No separate rollback route
 * exists or is needed.
 *
 * Validation of `terminalStatus` against the three allowed values
 * ("krever_eier" | "dod_kilde" | null) is the HTTP handler's job (same
 * division of labor as validatePhoneForWrite's caller above) — this function
 * trusts its typed parameter.
 */
export function applyGardssalgSetTerminalStatus(
  providerId: string,
  terminalStatus: "krever_eier" | "dod_kilde" | null,
  reason: string,
  sourceUrl?: string
): GardssalgSetTerminalStatusResult {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(`SELECT id, terminal_status FROM experience_providers WHERE id = ?`)
    .get(providerId) as { id: string; terminal_status: string | null } | undefined;
  if (!row) return { ok: false, reason: "provider_not_found" };

  const oldValue = row.terminal_status;
  const provenance = sourceUrl && sourceUrl.trim() ? sourceUrl.trim() : reason;

  const applyWithAudit = db.transaction(() => {
    db.prepare(
      `UPDATE experience_providers SET terminal_status = @terminal_status WHERE id = @id`
    ).run({ id: providerId, terminal_status: terminalStatus });
    db.prepare(
      `INSERT INTO gardssalg_content_audit
         (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
       VALUES (@id, @provider_id, 'terminal_status', @old_value, @new_value, @source_url, NULL, 'admin', datetime('now'))`
    ).run({
      id: uuid(),
      provider_id: providerId,
      old_value: oldValue,
      new_value: terminalStatus,
      source_url: provenance,
    });
  });
  applyWithAudit();

  return { ok: true, old_value: oldValue, new_value: terminalStatus };
}

export type GardssalgAutosvarReviewQueueEntry = {
  provider_id: string;
  provider_name?: string | null;
  candidate_email: string;
  contact_email?: string | null;
  matched_phrase?: string | null;
  classification: "domain_mismatch" | "no_website_on_file";
  thread_id?: string | null;
  message_id?: string | null;
  reason?: string;
  batch_id?: string | null;
};

/**
 * Upsert one autosvar-review-queue row — same UNIQUE(provider_id)
 * refresh-on-rerun idiom as the org_nr/website queues. Backs
 * POST /admin/gardssalg-autosvar-apply's domain_mismatch/no_website_on_file
 * branch (never a direct epost write — see that route's doc comment).
 */
export function upsertGardssalgAutosvarReviewQueue(entry: GardssalgAutosvarReviewQueueEntry): void {
  const db = getDb(VERTICAL);
  db.prepare(
    `INSERT INTO gardssalg_autosvar_review_queue
       (id, provider_id, provider_name, candidate_email, contact_email, matched_phrase, classification, thread_id, message_id, reason, batch_id, created_at, updated_at)
     VALUES (@id, @provider_id, @provider_name, @candidate_email, @contact_email, @matched_phrase, @classification, @thread_id, @message_id, @reason, @batch_id, datetime('now'), datetime('now'))
     ON CONFLICT(provider_id) DO UPDATE SET
       provider_name = excluded.provider_name,
       candidate_email = excluded.candidate_email,
       contact_email = excluded.contact_email,
       matched_phrase = excluded.matched_phrase,
       classification = excluded.classification,
       thread_id = excluded.thread_id,
       message_id = excluded.message_id,
       reason = excluded.reason,
       batch_id = excluded.batch_id,
       updated_at = datetime('now')`
  ).run({
    id: uuid(),
    provider_id: entry.provider_id,
    provider_name: entry.provider_name ?? null,
    candidate_email: entry.candidate_email,
    contact_email: entry.contact_email ?? null,
    matched_phrase: entry.matched_phrase ?? null,
    classification: entry.classification,
    thread_id: entry.thread_id ?? null,
    message_id: entry.message_id ?? null,
    reason: entry.reason ?? "autosvar_redirect_candidate",
    batch_id: entry.batch_id ?? null,
  });
}

/** Removes a provider's autosvar-queue entry once the correction is resolved. */
export function clearGardssalgAutosvarReviewQueueEntry(providerId: string): void {
  const db = getDb(VERTICAL);
  db.prepare(`DELETE FROM gardssalg_autosvar_review_queue WHERE provider_id = ?`).run(providerId);
}

/** Lists all current autosvar-queue entries, newest-updated first. */
export function listGardssalgAutosvarReviewQueue(): (GardssalgAutosvarReviewQueueEntry & {
  id: string;
  created_at: string;
  updated_at: string;
})[] {
  const db = getDb(VERTICAL);
  return db
    .prepare(`SELECT * FROM gardssalg_autosvar_review_queue ORDER BY updated_at DESC`)
    .all() as (GardssalgAutosvarReviewQueueEntry & { id: string; created_at: string; updated_at: string })[];
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

// ─── Gårdssalg Norske Destillerier medlemsliste-bekreftelse (dev-request
// 2026-08-10-veien-til-pool-berikelseskjede-og-koedrenering, Skive 3) ────────
//
// Norske Destillerier's own member list (norskedestillerier.no/medlemmer/)
// publishes each member's OWN address/postal/phone/email/website — a
// producer-owned source, but a paraply/umbrella one: the association's copy
// can be stale (67 North: the list's `www.67-north.no` doesn't answer, while
// the producer's live site publishes a different, working address). The
// route (POST /admin/gardssalg-medlemsliste-bekreft) matches members to
// EXISTING experience_providers rows by DOMAIN, never creates a row, and
// this function is the fill-only writer behind that route's `apply` gate.

export interface GardssalgMedlemslisteEnrichmentCandidate {
  adresse?: string | null;
  postnummer?: string | null;
  poststed?: string | null;
  telefon?: string | null;
  epost?: string | null;
}

/**
 * Apply a Norske Destillerier medlemsliste candidate to ONE gårdssalg
 * provider. Same lock guard as every sibling gårdssalg writer (NEVER writes
 * if content_source is 'manual'/'claim'). FILL-ONLY per field — adresse/
 * postnummer/poststed/telefon/epost are each written only if the row's
 * CURRENT value is blank; a field already populated — whether confirmed on
 * the producer's own live website or filled from any other source — is never
 * touched (AK10). This is the sole enforcement point: since a field that
 * already carries a producer-own-website value is, BY CONSTRUCTION, no
 * longer blank, the isBlank() guard below is what makes the umbrella source
 * unable to ever overwrite a fresher first-hand finding — no separate
 * "is this fresher" comparison is needed or attempted.
 *
 * telefon/epost additionally honour gardssalgContactFieldWasRolledBack (the
 * same veto applyGardssalgProviderContact already applies to those two
 * fields — an admin's earlier rollback of a bad contact value must not be
 * silently re-written by this, a different source feeding the same fields).
 * adresse/postnummer/poststed do NOT carry that veto, mirroring
 * applyGardssalgProviderAddress's own established convention for those three
 * fields (no rollback-veto check there either).
 *
 * field_provenance gets a read-modify-write merge (preserves every other
 * field's existing entry) — each written field's entry carries BOTH the
 * generic {source_url, fetched_at} shape every other gårdssalg writer here
 * uses AND the explicit {source: "norskedestillerier_medlemsliste",
 * confirmed_at} tag the dev-request asks for by name, so the write is
 * auditable/rollback-capable by the existing generic tooling (gardssalg_
 * content_audit + content-rollback) while also being self-describing about
 * which lever wrote it. Same transaction/audit shape as
 * applyGardssalgProviderAddress/applyGardssalgProviderContact — one
 * gardssalg_content_audit row per field actually written. Returns the field
 * names actually written (empty array if nothing to write).
 */
export function applyGardssalgMedlemslisteEnrichment(
  providerId: string,
  candidate: GardssalgMedlemslisteEnrichmentCandidate,
  sourceUrl: string,
  batchId?: string
): string[] {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT id, content_source, adresse, postnummer, poststed, telefon, epost, field_provenance
         FROM experience_providers WHERE id = ?`
    )
    .get(providerId) as
    | {
        id: string;
        content_source: string | null;
        adresse: string | null;
        postnummer: string | null;
        poststed: string | null;
        telefon: string | null;
        epost: string | null;
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
    telefon: row.telefon,
    epost: row.epost,
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
  if (
    isBlank(row.telefon) &&
    candidate.telefon?.trim() &&
    !gardssalgContactFieldWasRolledBack(providerId, "telefon")
  ) {
    sets.push("telefon = @telefon");
    params.telefon = candidate.telefon.trim();
    written.push("telefon");
  }
  if (
    isBlank(row.epost) &&
    candidate.epost?.trim() &&
    !gardssalgContactFieldWasRolledBack(providerId, "epost")
  ) {
    sets.push("epost = @epost");
    params.epost = candidate.epost.trim();
    written.push("epost");
  }

  if (sets.length === 0) return [];

  sets.push("updated_at = datetime('now')");

  // ── field_provenance merge (read-modify-write, preserves other fields) ──
  let provenance: Record<string, Record<string, unknown>> = {};
  if (row.field_provenance) {
    try {
      const parsed = JSON.parse(row.field_provenance);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        provenance = parsed as Record<string, Record<string, unknown>>;
      }
    } catch {
      /* malformed existing JSON -> treat as empty rather than clobber the write */
    }
  }
  const confirmedAt = new Date().toISOString();
  for (const f of written) {
    provenance[f] = {
      source_url: sourceUrl,
      fetched_at: confirmedAt,
      source: "norskedestillerier_medlemsliste",
      confirmed_at: confirmedAt,
    };
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
        source_url: sourceUrl,
        batch_id: batchId ?? null,
      });
    }
  });
  applyWithAudit();

  return written;
}

export interface GardssalgMedlemslisteMatchCandidate {
  id: string;
  navn: string;
  hjemmeside: string | null;
  content_source: string | null;
}

const GS_MEDLEM_MATCH_COLUMNS = `id, navn, hjemmeside, content_source`;

/**
 * Auto-select the gårdssalg provider universe for the medlemsliste-bekreft
 * route's cohort (no `providerIds`) mode. Same "gårdssalg providers"
 * predicate every sibling selector in this file uses (producer_type set OR
 * rfb-seed), and — mirroring the gardssalg-veien-til-pool review fix-up
 * (finding 1) — excludes the synthetic producer_type='test-gardssalg'
 * canary row and catalog_hidden=1 rows from the AUTOMATIC cohort, so a sweep
 * can never touch either; an explicit providerIds call still can (see
 * getGardssalgProviderMedlemslisteTarget below), the same deliberate-act
 * distinction gardssalg-veien-til-pool draws. Unlike the address/orgnr
 * backfill selectors, this does NOT filter on any field already being
 * blank — matching is by DOMAIN (against whatever `hjemmeside` the row
 * already holds, or lack of one for the name-only tier), and per-field
 * fill-only is enforced downstream by applyGardssalgMedlemslisteEnrichment
 * itself. No limit/cap: the gårdssalg population is ~48 rows total (see
 * GS_CR_HARD_CAP's own comment), a single indexed scan.
 */
export function selectGardssalgProvidersForMedlemslisteMatch(): GardssalgMedlemslisteMatchCandidate[] {
  const db = getDb(VERTICAL);
  return db
    .prepare(
      `SELECT ${GS_MEDLEM_MATCH_COLUMNS}
         FROM experience_providers
        WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
          AND (producer_type IS NULL OR producer_type != 'test-gardssalg')
          AND (catalog_hidden IS NULL OR catalog_hidden != 1)
        ORDER BY created_at ASC`
    )
    .all() as GardssalgMedlemslisteMatchCandidate[];
}

/**
 * Resolve an explicit providerId for the medlemsliste-bekreft route's
 * `providerIds` override — scoped to the gårdssalg predicate only (NOT the
 * test-canary/catalog_hidden exclusions above), mirroring
 * getGardssalgProviderAddressTarget's own override semantics: an admin
 * naming a specific row is a deliberate act, categorically different from an
 * automated sweep picking it up incidentally.
 */
export function getGardssalgProviderMedlemslisteTarget(providerId: string): GardssalgMedlemslisteMatchCandidate | null {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT ${GS_MEDLEM_MATCH_COLUMNS}
         FROM experience_providers
        WHERE id = ? AND (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')`
    )
    .get(providerId) as GardssalgMedlemslisteMatchCandidate | undefined;
  return row ?? null;
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
  return gardssalgContactFieldWasRolledBack(providerId, "org_nr");
}

/**
 * Generalisering av gardssalgOrgnrWasRolledBack til vilkårlig felt (2026-07-31,
 * lokal#438-review B1): en rollback nuller feltet, som gjør raden kvalifisert
 * for fill-only-selektorene igjen — uten denne sjekken ville neste kjøring
 * stille re-skrevet nøyaktig verdien et menneske nettopp rullet tilbake («an
 * undo that un-undoes itself», org_nr-presedensens egne ord). Konsumeres av
 * applyGardssalgProviderContact per felt (dekker både contact-extraction og
 * Brreg-backfill i ett choke point) i tillegg til org_nr-wrapperen over.
 * NB: kun EKSAKT feltnavn fra kallere — aldri brukerinput rett inn her.
 */
export function gardssalgContactFieldWasRolledBack(providerId: string, fieldName: string): boolean {
  const db = getDb(VERTICAL);
  const latest = db
    .prepare(
      `SELECT source_url FROM gardssalg_content_audit
        WHERE provider_id = ? AND field_name = ?
        ORDER BY rowid DESC LIMIT 1`
    )
    .get(providerId, fieldName) as { source_url: string | null } | undefined;
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
  // Måling 2026-07-30 (wdv2-kjøringen): to feiltreff-klasser som passerte
  // navn+sted-beviset — regionale smaks-DMO-er utenfor visit*-mønsteret
  // (tastehardanger.com foreslått som Måge Siders hjemmeside) og
  // hobbyblogger (*.blog foreslått for Borøy Ciderhus). En blogg-TLD er
  // aldri en produsents hjemmeside.
  if (/^taste[a-z0-9-]*\.(no|com)$/.test(h)) return "dmo_taste_domain";
  if (h.endsWith(".blog")) return "blog_tld_host";
  return null;
}

// ─── Social-media exclusion (dev-request 2026-07-21-gardssalg-soekebasert-
//     nettsidefunn) ─────────────────────────────────────────────────────────
//
// Search-based candidate generation (below) commonly turns up a producer's
// Facebook/Instagram page rather than a real homepage — very common for
// small Norwegian gårdssalg producers who have no website at all. facebook.com
// and instagram.com already trip isDirectoryOrAggregatorHost (they're in
// KNOWN_DIRECTORY_HOSTS), so they were already blocked from ever being
// proposed as a homepage — but that generic "blocklisted_directory_domain"
// reason doesn't tell the reviewer/operator that this specific host is a
// social profile (a genuinely useful "found the producer, but not a
// homepage" signal) rather than an unrelated tourism/aggregator directory.
// This gives that a dedicated, more specific reason, checked BEFORE the
// generic directory check. A small curated list — kept separate from
// KNOWN_DIRECTORY_HOSTS on purpose (that set is the single source of truth
// for "never a producer's own site"; this one is only about NAMING the
// social-media subset of it for reporting).
const SOCIAL_MEDIA_HOSTS: ReadonlySet<string> = new Set([
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "linkedin.com",
  "pinterest.com",
  "snapchat.com",
]);

/** Pure host-level rule — exported for tests. Suffix-walks like
 * isDirectoryOrAggregatorHost so e.g. "m.facebook.com" / "business.facebook.com"
 * also match, not just the bare eTLD+1. */
export function gardssalgSocialMediaHostReason(host: string | null): string | null {
  if (!host) return null;
  const h = host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  const labels = h.split(".").filter(Boolean);
  for (let i = 0; i + 2 <= labels.length; i++) {
    if (SOCIAL_MEDIA_HOSTS.has(labels.slice(i).join("."))) return "social_media_host";
  }
  return null;
}

/** Combined pre-fetch exclusion reason for a website-discovery candidate host
 * (social-media checked first — a more specific/useful reason than the
 * generic directory one for hosts that happen to be in both). Exported for
 * tests; the route uses this single entry point for BOTH the initial
 * candidate host and the post-redirect final-host re-check, so social and
 * directory/DMO exclusion apply identically at both points. */
export function gardssalgWebsiteHostExclusionReason(host: string | null): string | null {
  return gardssalgSocialMediaHostReason(host) ?? gardssalgSharedDomainReason(host);
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
  // dev-request 2026-07-21-gardssalg-soekebasert-nettsidefunn — optional
  // keyword appended to the search-based candidate query (e.g. "bryggeri").
  producer_type: string | null;
  // v2 (Daniels retning 2026-07-30): «finne informasjon vi har som passer
  // overens (ikke bare navn)» — the provider's OWN registered contact data
  // become ownership-evidence signals a candidate page can be checked
  // against. All nullable; a missing value is simply a signal that cannot
  // fire, never a verification failure.
  telefon: string | null;
  mobil: string | null;
  adresse: string | null;
  postnummer: string | null;
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

  // Skive 1 (dev-request 2026-08-17-forsyningskjede-samarbeid-og-
  // kvalitetsoppdatering): providers explicitly handed to discovery by the
  // sweep/berikelse pipelines (provider_work_queue, to_system='discovery')
  // go FIRST, in the queue's own requested_at order — before falling back to
  // the normal oldest-first rotation below. A queue-pending provider that no
  // longer meets the eligibility filters (already has a hjemmeside, got
  // locked, etc.) is simply not returned here; its queue row is left alone
  // for a later cycle to re-evaluate, not resolved/touched by this selector.
  const pending = listPendingProviderWorkQueue("discovery", cap);
  const queueTargets: GardssalgWebsiteDiscoveryTarget[] = [];
  if (pending.length > 0) {
    // A provider can legitimately have more than one unresolved queue row
    // targeting discovery (idempotency key is provider_id+to_system+reason,
    // e.g. missing_source then evidence_url_rejected before either
    // resolves) — dedupe here so the same provider isn't pushed into
    // queueTargets twice, which would waste a discovery slot/tier-2 lookup
    // on a repeat instead of a distinct provider. Set preserves first-seen
    // (i.e. queue requested_at) order.
    const pendingIds = [...new Set(pending.map((p) => p.provider_id))];
    const placeholders = pendingIds.map(() => "?").join(", ");
    const eligibleRows = db
      .prepare(
        `SELECT id, navn, org_nr, kommune, poststed, content_source, producer_type,
                telefon, mobil, adresse, postnummer
           FROM experience_providers
          WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
            AND (hjemmeside IS NULL OR TRIM(hjemmeside) = '')
            AND (content_source IS NULL OR content_source NOT IN ('manual', 'claim'))
            AND (producer_type IS NULL OR producer_type != 'test-gardssalg')
            AND id IN (${placeholders})`
      )
      .all(...pendingIds) as GardssalgWebsiteDiscoveryTarget[];
    const eligibleById = new Map(eligibleRows.map((r) => [r.id, r]));
    // Preserve the queue's own requested_at order (SQL's IN(...) does not
    // guarantee row order matches the placeholder list).
    for (const providerId of pendingIds) {
      const row = eligibleById.get(providerId);
      if (row) queueTargets.push(row);
    }
  }

  const remaining = cap - queueTargets.length;
  let rotationTargets: GardssalgWebsiteDiscoveryTarget[] = [];
  if (remaining > 0) {
    const excludeIds = queueTargets.map((t) => t.id);
    const excludeClause = excludeIds.length > 0 ? `AND id NOT IN (${excludeIds.map(() => "?").join(", ")})` : "";
    rotationTargets = db
      .prepare(
        `SELECT id, navn, org_nr, kommune, poststed, content_source, producer_type,
                telefon, mobil, adresse, postnummer
           FROM experience_providers
          WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
            AND (hjemmeside IS NULL OR TRIM(hjemmeside) = '')
            AND (content_source IS NULL OR content_source NOT IN ('manual', 'claim'))
            AND (producer_type IS NULL OR producer_type != 'test-gardssalg')
            ${excludeClause}
          ORDER BY (website_discovery_attempted_at IS NOT NULL), website_discovery_attempted_at ASC, created_at ASC
          LIMIT ?`
      )
      .all(...excludeIds, remaining) as GardssalgWebsiteDiscoveryTarget[];
  }

  return [...queueTargets, ...rotationTargets].slice(0, cap);
}

/** Explicit-target resolver for the route's providerIds override — gårdssalg-
 * scoped and test-provider-excluded like the selector, but NOT filtered on
 * blank hjemmeside/locks (those are decided and reported by the route). */
export function getGardssalgWebsiteDiscoveryTarget(providerId: string): (GardssalgWebsiteDiscoveryTarget & { hjemmeside: string | null }) | null {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT id, navn, org_nr, kommune, poststed, content_source, producer_type, hjemmeside,
              telefon, mobil, adresse, postnummer
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
  // v2: breweries in particular brand on .com (measured 2026-07-30: 7 Fjell
  // Bryggeri's real site is 7fjellbryggeri.com — tier 1 guessed only .no and
  // missed it). One .com per transliteration, joined label only, appended
  // AFTER the .no guesses so the cheaper national TLD is still tried first.
  for (const v of variants) {
    const clean = v.map((t) => t.replace(/[^a-z0-9]/g, "")).filter(Boolean);
    if (clean.length === 0) continue;
    const label = clean.join("");
    if (label.length < 4 || label.length > 63) continue;
    const host = `${label}.com`;
    if (!hosts.includes(host)) hosts.push(host);
  }
  return hosts.slice(0, 6);
}

// ─── Gårdssalg search-based website-discovery candidates (dev-request
//     2026-07-21-gardssalg-soekebasert-nettsidefunn) ───────────────────────
//
// The name-based domain guess above almost never matches a Norwegian
// producer's real brand domain (a live 20-row test scored 0/20 verified). It
// is kept as a free, zero-cost first tier (no API call, tried before we ever
// spend a paid search) — see the route's doc comment for the full tier-1/
// tier-2 rationale. This block adds the tier-2 SEARCH-based source: a single
// Brave query per row, whose top organic hits' hosts become candidates that
// flow through the SAME pre-fetch exclusion + fetch + ownership-evidence
// pipeline as the name-guess tier (nothing downstream changes).

/**
 * Build the Brave query for one target: `"<pruned name>" <kommune/poststed>
 * [<producer_type>]`, e.g. `"Fjelldal Brenneri" Saltdal bryggeri`. Mirrors
 * search-enrich-sweep's `"<name>" <geo>`.trim() query shape, extended with an
 * optional trailing producer_type keyword ("bryggeri", "sideri", …) when one
 * is known — narrows the search without a second API call. Pure — exported
 * for tests.
 */
export function gardssalgWebsiteSearchQuery(target: {
  navn: string;
  kommune?: string | null;
  poststed?: string | null;
  producer_type?: string | null;
}): string {
  const name = gardssalgSearchName(target.navn);
  const place = (target.kommune || target.poststed || "").trim();
  const keyword = (target.producer_type || "").trim();
  return [`"${name}"`, place, keyword].filter(Boolean).join(" ").trim();
}

/**
 * Turn Brave organic search results into candidate homepage hosts: the
 * host of each result's URL, in Brave's own relevance order, deduplicated,
 * capped at `maxCandidates`. Pure — no ranking/scoring of its own (Brave's
 * ranking is trusted as-is, unlike search-enrich's rankCandidates which
 * re-ranks by name-stem overlap — that module crawls MULTIPLE candidate
 * pages per producer; this one takes the first VERIFIED hit, so passing
 * through Brave's own order and letting the existing exclusion+evidence
 * pipeline reject bad hosts is sufficient). Exported for tests.
 */
export function gardssalgWebsiteSearchCandidateHosts(
  results: BraveResult[],
  maxCandidates = 5
): string[] {
  const hosts: string[] = [];
  for (const r of results) {
    const host = hostFromUrlLike(r?.url || "");
    if (!host) continue;
    if (!hosts.includes(host)) hosts.push(host);
    if (hosts.length >= maxCandidates) break;
  }
  return hosts;
}

// Injectable Brave-search function — test seam mirroring
// experience-brreg.ts's __setBrregFetchForTesting / order-notify-service.ts's
// __setOrderNotifySendForTesting: a module-level override, null by default
// (production uses the real braveSearch, wired by the route with the env
// key), settable by tests so route-level tests never hit the network and
// never need to fabricate Brave's raw JSON response shape — they hand back
// BraveResult[] directly, exactly like search-enrich-sweep's injected
// EnrichDeps.search.
export type GardssalgWebsiteSearchFn = (query: string) => Promise<BraveResult[]>;
let _gardssalgWebsiteSearchOverride: GardssalgWebsiteSearchFn | null = null;
export function __setGardssalgWebsiteSearchForTesting(fn: GardssalgWebsiteSearchFn | null): void {
  _gardssalgWebsiteSearchOverride = fn;
}
export function getGardssalgWebsiteSearchOverride(): GardssalgWebsiteSearchFn | null {
  return _gardssalgWebsiteSearchOverride;
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
 * Extract a page's <title> text for evidence matching — dev-request
 * 2026-08-02-enrichment-kadens-og-kildekvalitet, AC4: a real incident found
 * 7 of 9 sibling-TLD candidate homepages were WRONG (squatted domains,
 * unrelated organisations) yet all 7 passed the existing body-text
 * name/place checks; none of the 7 ever carried the producer's brand in
 * their <title>, so the title is a cheap, independent corroborating signal.
 *
 * Regex-only extraction (this codebase has no HTML parser anywhere — see
 * organic-keyword-detector.ts:19 for why), same entity/whitespace handling
 * gardssalgPageText already applies to body text so title and body text
 * compare on equal footing once both are run through normaliseName. Only
 * the literal <title> tag is read — deliberately NOT the og:title fallback
 * extractTitle (search-enrich.ts) also checks, since that can carry
 * page-specific marketing copy rather than the whole site's own title.
 * Pure — exported for tests.
 */
export function gardssalgPageTitle(html: string): string {
  const m = (html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m || !m[1]) return "";
  return m[1]
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Embedded-content text extraction — dev-request
 * 2026-08-08-gardssalg-brreg-verify-og-embedded-evidens.
 *
 * gardssalgPageText() deliberately strips <script> blocks, which is correct
 * for classic server-rendered pages but blinds every evidence/extraction
 * step on sitebuilder SPAs (Wix/Squarespace/Next.js): their raw HTML renders
 * an empty shell whose actual page content — the address line, the contact
 * email, the place name — lives INSIDE script-embedded JSON as string
 * literals. Measured live on 67 North Distillery (67northdistillery.no,
 * org 925174971): visible text after stripping is 19 chars (the <title>
 * only), while the script JSON carries "Skomakergata 13\n8250 Rognan" and
 * "post@67northdistillery.no" — every signal the evidence matcher needs,
 * all invisible to it.
 *
 * This helper extracts DECODED string literals from <script> blocks (JSON
 * escape sequences resolved) plus the description/og:* meta-tag contents,
 * and returns them as one whitespace-collapsed text. It extracts only what
 * the page itself ships — nothing is inferred or fabricated — so matching
 * registry-held signals (org_nr, registered address/phone, postnr, place)
 * against it is the SAME evidence discipline as the visible-text layer,
 * one layer deeper. Callers must treat matches from this layer as a
 * SECOND-CHANCE source and report which layer verified (review-gated
 * adoption is unchanged).
 *
 * Guards: per-string 2..2000 chars (skips empties and bundled blobs),
 * base64ish runs ≥80 chars skipped, must contain a letter/digit, total
 * output capped. Pure — exported for tests.
 */
const GS_EMBEDDED_TEXT_MAX_TOTAL = 300_000;
export function gardssalgEmbeddedPageText(html: string): string {
  const source = html || "";
  const parts: string[] = [];
  let total = 0;
  const decode = (raw: string): string =>
    raw.replace(/\\(u([0-9a-fA-F]{4})|n|t|r|"|\/|\\)/g, (_s, esc: string, hex?: string) => {
      if (hex) return String.fromCharCode(parseInt(hex, 16));
      if (esc === "n" || esc === "t" || esc === "r") return " ";
      return esc;
    });
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = scriptRe.exec(source)) !== null && total < GS_EMBEDDED_TEXT_MAX_TOTAL) {
    const script = sm[1] || "";
    const strRe = /"((?:[^"\\]|\\.)*)"/g;
    let m: RegExpExecArray | null;
    while ((m = strRe.exec(script)) !== null && total < GS_EMBEDDED_TEXT_MAX_TOTAL) {
      const raw = m[1] || "";
      if (raw.length < 2 || raw.length > 2000) continue;
      if (!/[\p{L}\p{N}]/u.test(raw)) continue;
      if (/^[A-Za-z0-9+/=_-]{80,}$/.test(raw)) continue;
      const decoded = decode(raw);
      parts.push(decoded);
      total += decoded.length + 1;
    }
  }
  // Meta description / og:* content attributes — page-authored text that
  // tag-stripping also discards (a "Destilleri i Saltdal" description is
  // real place evidence). Attribute order varies by generator, so match the
  // whole tag first, then read name/property and content independently.
  const metaTagRe = /<meta\b[^>]*>/gi;
  const metaNameRe = /(?:name|property)\s*=\s*["'](description|keywords|og:title|og:site_name|og:description)["']/i;
  const metaContentRe = /content\s*=\s*["']([^"']*)["']/i;
  let mm: RegExpExecArray | null;
  while ((mm = metaTagRe.exec(source)) !== null && total < GS_EMBEDDED_TEXT_MAX_TOTAL) {
    const tag = mm[0] || "";
    if (!metaNameRe.test(tag)) continue;
    const cm = tag.match(metaContentRe);
    const content = (cm?.[1] || "").trim();
    if (!content) continue;
    parts.push(content);
    total += content.length + 1;
  }
  return parts.join(" ").replace(/&[a-z]+;|&#\d+;/gi, " ").replace(/\s+/g, " ").trim();
}

/**
 * Normalise a Norwegian phone number to its 8 significant digits: strips
 * +47/0047 country prefixes and every non-digit. Returns null when what
 * remains is not exactly 8 digits — a partial number must never match.
 * Pure — exported for tests.
 */
export function normaliseNorwegianPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("0047")) digits = digits.slice(4);
  else if (digits.startsWith("47") && digits.length === 10) digits = digits.slice(2);
  return /^\d{8}$/.test(digits) ? digits : null;
}

/**
 * Ownership evidence for a candidate page — v2 (Daniels retning 2026-07-30:
 * «finne informasjon vi har som passer overens (ikke bare navn)»).
 *
 * Independent signals, each measured against data WE already hold for the
 * provider (never inferred from the page):
 *   org_nr    — 9-digit run, separator-collapsed, not embedded in longer run
 *   name      — exact pruned name at token boundaries; short/generic single
 *               tokens («Sider», «Engel») never fire
 *   place     — kommune/poststed at token boundaries
 *   phone     — the provider's registered telefon/mobil found among the
 *               page's digit runs (+47/0047/separators normalised away)
 *   address   — registered street address at token boundaries (≥6 chars
 *               normalised, so a bare street name like «Berg» can't fire)
 *   postnr    — the 4-digit postnummer as its own digit run. Deliberately
 *               NEVER sufficient (thousands of businesses share one) — it
 *               only strengthens name.
 *   title     — (AC4, dev-request 2026-08-02-enrichment-kadens-og-
 *               kildekvalitet) the page's own <title> text (gardssalgPageTitle,
 *               caller-supplied — this function does no fetching/parsing of
 *               its own beyond the regex helper) containing the pruned name
 *               at the same token boundaries as the body-text `name` check.
 *               Caller-optional: when the caller has no title source to
 *               offer (`pageTitle` omitted), title_found is simply false and
 *               plays no part beyond what's documented below.
 *
 * verified =
 *   org_nr
 *   OR (phone AND (name OR place))   — the provider's own registered number
 *                                      plus any second signal; phone ALONE
 *                                      stays insufficient (call-list pages)
 *   OR (name AND (place OR address OR postnr) AND title)
 *       — title is required on this branch ONLY (2026-08-06 incident: 7 of
 *         9 sibling-TLD candidates had name+place-only body-text hits and
 *         were all wrong; org_nr and phone are already independently
 *         registry-sourced signals and do NOT gain a title requirement).
 *         Every caller so far updated to supply `pageTitle` opts into this;
 *         a caller that never passes `pageTitle` keeps evaluating this
 *         branch as it did before AC4 (title_found is vacuously false only
 *         when title data was actually offered and didn't match — a caller
 *         offering no title source at all is a caller not yet wired for
 *         this signal, not a caller whose pages provably lack a title).
 *
 * The v1 rule (org_nr OR name+place) is a strict subset of the org_nr and
 * phone branches — nothing that verified via those stops verifying; only
 * the weakest (name-only-corroborated) branch tightens, and only for
 * callers that opt in by supplying `pageTitle`.
 * Pure — exported for tests.
 */
export function gardssalgWebsiteEvidenceMatch(
  pageText: string,
  target: {
    orgNr?: string | null;
    navn: string;
    kommune?: string | null;
    poststed?: string | null;
    telefon?: string | null;
    mobil?: string | null;
    adresse?: string | null;
    postnummer?: string | null;
  },
  pageTitle?: string
): {
  org_nr_found: boolean;
  name_found: boolean;
  place_found: boolean;
  phone_found: boolean;
  address_found: boolean;
  postnr_found: boolean;
  title_found: boolean;
  verified: boolean;
} {
  const text = pageText || "";
  let orgFound = false;
  const orgNr = (target.orgNr || "").trim();
  const digitCollapsed = text.replace(/(\d)[\s. ]+(?=\d)/g, "$1");
  if (/^\d{9}$/.test(orgNr)) {
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

  // phone: the provider's registered number(s) against the page's collapsed
  // digit runs — «+47 912 34 567» collapses to one run; the optional 47/0047
  // prefix inside the pattern lets a prefixed page form match a bare stored
  // form and vice versa, with the same not-embedded guard as org_nr.
  let phoneFound = false;
  for (const cand of [normaliseNorwegianPhone(target.telefon), normaliseNorwegianPhone(target.mobil)]) {
    if (!cand) continue;
    if (new RegExp(`(?<!\\d)(?:0047|47)?${cand}(?!\\d)`).test(digitCollapsed)) {
      phoneFound = true;
      break;
    }
  }

  const normAdresse = normaliseName(target.adresse || "");
  const addressFound = normAdresse.length >= 6 && boundaryIncludes(normText, normAdresse);

  const postnr = (target.postnummer || "").trim();
  const postnrFound = /^\d{4}$/.test(postnr) && new RegExp(`(?<!\\d)${postnr}(?!\\d)`).test(digitCollapsed);

  // title: same token-boundary-safe containment as `name` above, against the
  // caller-supplied page <title> text instead of the body. `pageTitle`
  // undefined means "no title source offered" (pre-AC4 caller) — titleFound
  // stays false either way, but see the weakest-branch gate below, which
  // only imposes the new requirement on callers that DID offer a title.
  const titleOffered = pageTitle !== undefined;
  const normTitle = normaliseName(pageTitle || "");
  const titleFound = titleOffered && nameSpecific && boundaryIncludes(normTitle, normName);

  const weakestBranchBase = nameFound && (placeFound || addressFound || postnrFound);
  // Incident fix (2026-08-06): once a caller has wired a title source, the
  // weakest branch — the ONLY branch with neither org_nr nor phone behind it
  // — must also see the producer's name in the page <title>. org_nr and
  // phone are registry-sourced and stay completely untouched by this gate.
  const weakestBranchVerified = titleOffered ? weakestBranchBase && titleFound : weakestBranchBase;

  return {
    org_nr_found: orgFound,
    name_found: nameFound,
    place_found: placeFound,
    phone_found: phoneFound,
    address_found: addressFound,
    postnr_found: postnrFound,
    title_found: titleFound,
    verified:
      orgFound ||
      (phoneFound && (nameFound || placeFound)) ||
      weakestBranchVerified,
  };
}

/**
 * Contact-ish same-host subpage links from a front page — v2. The evidence
 * (org.nr, address, phone) usually lives on /kontakt or /om-oss, not the
 * front page; this picks up to `max` internal links whose href or anchor
 * text look like contact/about pages. Same-host only — a cross-host link is
 * a different site, and only the exclusion pipeline may judge those.
 * Pure — exported for tests.
 */
export function gardssalgContactPageLinks(html: string, baseHost: string, max = 3): string[] {
  const seen = new Set<string>();
  const found: Array<{ url: string; tier: number; order: number }> = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  // Tier 0 — an explicit contact page. A general inbox (post@, kontakt@) lives
  // here, and that is the address outreach should use.
  const isContact = (h: string, t: string): boolean =>
    /kontakt|contact/.test(h) || /\bkontakt\b|\bcontact\b/.test(t);
  // Tier 1 — about/visit pages. Often carry the same general address.
  const isAbout = (h: string, t: string): boolean =>
    /om-oss|om_oss|omoss|about|besok|bes%c3%b8k/.test(h) ||
    /\bom oss\b|\babout\b|\bbesøk\b/.test(t);
  // Tier 2 — team/staff pages. Added 2026-08-17 after Eik & Tid: eiktid.no has
  // NO contact page at all, and its four links are /, /the-brewery/, /the-beer/
  // and /the-team/. All three addresses (bjorn@, amund@, linda@eiktid.no) and
  // the phone number sit on /the-team/, which this rule did not recognise — so
  // the route fetched /the-brewery/, found nothing, and reported the producer
  // as having no contact information at all. Fetching /the-team/ by hand and
  // running this file's own extractor on it returns
  // {"email":"bjorn@eiktid.no","source":"text_same_domain"} plus a cued phone.
  // The page was always readable; it was never requested.
  //
  // Ranked LAST deliberately: a team page yields a named person's address, and
  // a general inbox on a contact page is the better outreach target when both
  // exist. This makes team pages a fallback, not a competitor.
  const isTeam = (h: string, t: string): boolean =>
    /team|ansatte|staff|people|folka?\b|om-?bryggeriet|crew/.test(h) ||
    /\bteam\b|\bansatte\b|\bstaff\b|\bvårt team\b|\bfolka\b/.test(t);

  let order = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html || "")) !== null) {
    const href = (m[1] || "").trim();
    const anchorText = gardssalgPageText(m[2] || "").toLowerCase();
    if (!href || /^(mailto:|tel:|javascript:)/i.test(href)) continue;
    let url: URL;
    try {
      url = new URL(href, `https://${baseHost}`);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== baseHost.toLowerCase().replace(/^www\./, "")) continue;
    const path = url.pathname.toLowerCase();
    const tier = isContact(path, anchorText) ? 0 : isAbout(path, anchorText) ? 1 : isTeam(path, anchorText) ? 2 : -1;
    if (tier < 0) continue;
    const key = url.origin + url.pathname;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ url: url.toString(), tier, order: order++ });
  }
  // Stable within a tier — document order is still the tie-break, so the same
  // page produces the same list on every run.
  return found
    .sort((a, b) => a.tier - b.tier || a.order - b.order)
    .slice(0, max)
    .map((f) => f.url);
}

// ─── Gårdssalg kontakt-utvinning fra hjemmeside (Daniels GO 2026-07-30:
//     «Kjør kontakt-utvinning fra de nye hjemmesidene») ────────────────────
//
// 243 av 389 gårdssalg-produsenter er «unreachable» (verken epost eller
// telefon), og Brreg-kilden er uttømt. Det som FINNES er nå hjemmesider
// (website-discovery v2) — og kontaktinfoen står på dem. Disse to PURE
// ekstraktorene leser en side og finner verdier, med proveniens-regler som
// gjør en feilskriving usannsynlig; skrivingen selv gjenbruker
// applyGardssalgProviderContact (fill-only, lås-guard, audit, provenance).

/** Junk mailbox prefixes that are never a producer's contact address. */
const CX_SKIP_LOCALPARTS = /^(noreply|no-reply|postmaster|webmaster|abuse|mailer-daemon|test|example)$/i;

/**
 * Sitebuilder-template placeholder domains. A mailto pointing at one of
 * these is boilerplate the site owner never customised — NOT a contact
 * address. Found the hard way in the 2026-07-31 cohort run: an
 * un-customised Wix template served `mailto:info@mysite.com` on a real
 * producer's site and the extractor trusted it (mailto = highest tier).
 */
const CX_PLACEHOLDER_DOMAINS = new Set([
  "mysite.com",
  "example.com",
  "example.no",
  "yourdomain.com",
  "yoursite.com",
  "yourwebsite.com",
  "domain.com",
  "email.com",
  "example.org",
  "example.net",
  "test.com",
  "company.com",
  "website.com",
  "yourcompany.com",
  "wixpress.com",
  "sentry.io",
  "wix.com",
  "squarespace.com",
  "wordpress.com",
]);

/**
 * Extract the producer's contact EMAIL from a page.
 *
 * Trust order (rewritten by dev-request kontaktadresse-domeneblind-mailto-
 * og-tekst: tier 1 and (old) tier 3 used to accept the FIRST mailto/visible
 * candidate regardless of whose domain it was on, so a distributor's or web
 * agency's address up top could beat the producer's own same-domain address
 * lower on the page — confirmed live on lofotpils.no, tg@dng-norge.no):
 *
 *   1. SAME-DOMAIN (registrable domain matches homepageDomain), in this
 *      sub-order — mailto -> visible text -> embedded:
 *        a. mailto: links (explicit, author-intended contact affordance)
 *        b. addresses in visible text
 *        c. addresses in EMBEDDED content (script-JSON string literals /
 *           meta tags — gardssalgEmbeddedPageText). Dev-request 2026-08-08-
 *           gardssalg-brreg-verify-og-embedded-evidens: sitebuilder SPAs
 *           (Wix et al.) render their contact paragraph client-side, so the
 *           address the visitor SEES exists in the raw HTML only as an
 *           escaped JSON string ("post@67northdistillery.no" on
 *           67northdistillery.no). Same-domain-only contract UNCHANGED —
 *           just moved earlier in the flow (it always ranked below every
 *           visible-text tier; now it ranks below every SAME-DOMAIN tier).
 *   2. FREEMAIL (gmail.com, outlook.com, … — FREE_MAIL_DOMAINS, common for
 *      small Norwegian farms with no company mailbox), same eligibility as
 *      before:
 *        a. via mailto — unconditional on page type — source stays "mailto"
 *        b. via visible text — ONLY when `pageIsContactish` (a kontakt/
 *           om-oss page, where a listed address is overwhelmingly the
 *           site's own) — source stays "text_contact_page"
 *        c. NEVER from embedded content (script blobs carry third-party
 *           config; only a same-domain embedded address is trustworthy —
 *           see tier 1c)
 *   3. FOREIGN/OTHER domain — flagged, not silently dropped. Reached only
 *      when nothing above matched. The address is still returned (an
 *      outreach candidate is never worth losing) but marked `needsReview`
 *      instead of trusted outright:
 *        a. via mailto — unconditional on page type, mirroring 1a/2a —
 *           source "mailto_other_domain"
 *        b. via visible text — ONLY when `pageIsContactish`, mirroring 2b —
 *           source "text_other_domain"
 *        c. embedded foreign-domain addresses stay unmatched -> null
 *           (no embedded-foreign tier; embedded is same-domain-only, full
 *           stop)
 *
 * Junk localparts (noreply/postmaster/…) never match. Pure — exported for
 * tests.
 */
export function extractGardssalgContactEmail(
  html: string,
  homepageDomain: string | null,
  pageIsContactish: boolean,
): {
  email: string;
  source:
    | "mailto"
    | "text_same_domain"
    | "text_contact_page"
    | "embedded_same_domain"
    | "mailto_other_domain"
    | "text_other_domain";
  needsReview?: true;
} | null {
  const candidates: Array<{ email: string; viaMailto: boolean; embedded: boolean }> = [];
  const seen = new Set<string>();
  const push = (raw: string, viaMailto: boolean, embedded = false): void => {
    const email = raw.trim().toLowerCase().replace(/^mailto:/i, "").split("?")[0]!;
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return;
    const local = email.split("@")[0]!;
    if (CX_SKIP_LOCALPARTS.test(local)) return;
    if (email.endsWith(".invalid")) return;
    const dom = email.split("@")[1]!;
    if (CX_PLACEHOLDER_DOMAINS.has(dom) || CX_PLACEHOLDER_DOMAINS.has(registrableDomain(dom) ?? dom)) return;
    if (seen.has(email)) return;
    seen.add(email);
    candidates.push({ email, viaMailto, embedded });
  };
  const mailtoRe = /href\s*=\s*["']mailto:([^"'?]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = mailtoRe.exec(html || "")) !== null) push(m[1]!, true);
  const text = gardssalgPageText(html || "");
  const textRe = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  while ((m = textRe.exec(text)) !== null) push(m[0]!, false);
  // Tier-4 source: embedded string content. Pushed LAST so a same address
  // already found in visible text keeps its (higher-trust) classification.
  const embeddedText = gardssalgEmbeddedPageText(html || "");
  while ((m = textRe.exec(embeddedText)) !== null) push(m[0]!, false, true);

  const domainOf = (c: { email: string }): string | null => registrableDomain(c.email.split("@")[1]!);
  const isSameDomain = (c: { email: string }): boolean => homepageDomain != null && domainOf(c) === homepageDomain;
  const isFreeMail = (c: { email: string }): boolean => {
    const dom = c.email.split("@")[1]!;
    return FREE_MAIL_DOMAINS.includes(dom) || FREE_MAIL_DOMAINS.includes(domainOf(c) ?? dom);
  };

  // ── Tier 1: same-domain — mailto -> visible text -> embedded ──────────
  const mailtoSame = candidates.find((c) => c.viaMailto && !c.embedded && isSameDomain(c));
  if (mailtoSame) return { email: mailtoSame.email, source: "mailto" };
  const textSame = candidates.find((c) => !c.viaMailto && !c.embedded && isSameDomain(c));
  if (textSame) return { email: textSame.email, source: "text_same_domain" };
  const embeddedSame = candidates.find((c) => c.embedded && isSameDomain(c));
  if (embeddedSame) return { email: embeddedSame.email, source: "embedded_same_domain" };

  // ── Tier 2: freemail — mailto unconditional, visible text only on a
  // contact-ish page, never from embedded content ────────────────────────
  const mailtoFree = candidates.find((c) => c.viaMailto && !c.embedded && isFreeMail(c));
  if (mailtoFree) return { email: mailtoFree.email, source: "mailto" };
  if (pageIsContactish) {
    const textFree = candidates.find((c) => !c.viaMailto && !c.embedded && isFreeMail(c));
    if (textFree) return { email: textFree.email, source: "text_contact_page" };
  }

  // ── Tier 3: foreign/other domain — flagged for review, never silently
  // dropped. mailto unconditional, visible text only on a contact-ish
  // page; embedded foreign addresses are never reached (same-domain-only
  // contract on tier 1c). ────────────────────────────────────────────────
  const mailtoOther = candidates.find((c) => c.viaMailto && !c.embedded);
  if (mailtoOther) return { email: mailtoOther.email, source: "mailto_other_domain", needsReview: true };
  if (pageIsContactish) {
    const textOther = candidates.find((c) => !c.viaMailto && !c.embedded);
    if (textOther) return { email: textOther.email, source: "text_other_domain", needsReview: true };
  }

  return null;
}

/**
 * Extract the producer's contact PHONE from a page: Norwegian 8-digit
 * numbers (first digit 2-7 or 9 — 8xx are toll/special, 0/1 invalid),
 * +47/0047 prefixes and separators normalised away. A number appearing near
 * a tlf/telefon/mobil/ring cue wins over a bare digit run; without any cued
 * match, a bare run is accepted only on a contact-ish page (digit runs on
 * arbitrary pages are too often order numbers/postal codes glued together).
 * Pure — exported for tests.
 */
export function extractGardssalgContactPhone(
  html: string,
  pageIsContactish: boolean,
): { phone: string; cued: boolean } | null {
  const text = gardssalgPageText(html || "");
  const numRe = /(?:\+47|0047)?[\s.]?(?:\d[\s.]?){8}/g;
  const found: Array<{ phone: string; cued: boolean }> = [];
  // Not-embedded guard (cx-10, samme disiplin som org.nr-matchingen): en
  // 8-sifret kandidat som er del av en LENGRE sifferrekke — de første åtte
  // av et 9-sifret org.nr, et 12-sifret kontonummer — er aldri et telefonnr.
  const digitAdjacent = (idx: number, dir: -1 | 1): boolean => {
    let i = idx;
    while (i >= 0 && i < text.length && /[\s.]/.test(text[i]!)) i += dir;
    return i >= 0 && i < text.length && /\d/.test(text[i]!);
  };
  let m: RegExpExecArray | null;
  while ((m = numRe.exec(text)) !== null) {
    const phone = normaliseNorwegianPhone(m[0]!);
    if (!phone) continue;
    if (!/^[2-79]/.test(phone)) continue;
    if (digitAdjacent(m.index - 1, -1) || digitAdjacent(m.index + m[0]!.length, 1)) continue;
    const before = text.slice(Math.max(0, m.index - 30), m.index).toLowerCase();
    const cued = /tlf|telefon|mobil|ring|phone|tel[.:\s]/.test(before);
    found.push({ phone, cued });
  }
  const cued = found.find((f) => f.cued);
  if (cued) return cued;
  if (pageIsContactish && found.length > 0) return found[0]!;
  return null;
}

export type GardssalgContactExtractionTarget = {
  id: string;
  navn: string;
  hjemmeside: string;
  epost: string | null;
  telefon: string | null;
  content_source: string | null;
};

/**
 * Cohort for homepage contact extraction: gårdssalg rows WITH a homepage but
 * MISSING epost and/or telefon, unlocked, not the test provider. Stable total
 * order (created_at, id) so offset paging walks the whole cohort exactly once
 * — same idiom as the Brreg contact backfill.
 */
/**
 * Cohort selector for contact extraction.
 *
 * `providerIds` (dev-request 2026-08-10-veien-til-pool-berikelseskjede-og-
 * koedrenering, AK1) NARROWS the cohort to exactly those rows — it never
 * widens it. Every existing guard still applies, so a targeted call can no
 * more overwrite a stored address, touch a claimed row or hit the test
 * provider than a cohort call can. Before this parameter existed the route
 * could only run over the whole cohort, so a batch containing ONE bad
 * candidate had to be abandoned wholesale — which is exactly how 67 North
 * Distillery's own correct address stayed unwritten while two umbrella
 * addresses blocked the run.
 */
export function selectGardssalgProvidersForContactExtraction(
  limit: number,
  offset: number,
  providerIds?: string[],
): { targets: GardssalgContactExtractionTarget[]; cohortTotal: number } {
  const db = getDb(VERTICAL);
  const ids = (providerIds ?? []).filter((v) => typeof v === "string" && v.trim() !== "");
  const idFilter = ids.length > 0 ? ` AND id IN (${ids.map(() => "?").join(", ")})` : "";
  const where = `
    (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
    AND hjemmeside IS NOT NULL AND TRIM(hjemmeside) != ''
    AND ((epost IS NULL OR TRIM(epost) = '') OR (telefon IS NULL OR TRIM(telefon) = ''))
    AND (content_source IS NULL OR content_source NOT IN ('manual','claim'))
    AND (producer_type IS NULL OR producer_type != 'test-gardssalg')${idFilter}`;
  const cohortTotal = (
    db.prepare(`SELECT COUNT(*) AS n FROM experience_providers WHERE ${where}`).get(...ids) as { n: number }
  ).n;
  const targets = db
    .prepare(
      `SELECT id, navn, hjemmeside, epost, telefon, content_source
         FROM experience_providers WHERE ${where}
        ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`
    )
    .all(...ids, limit, offset) as GardssalgContactExtractionTarget[];
  return { targets, cohortTotal };
}

export type GardssalgContactEmailAuditRow = {
  id: string;
  navn: string;
  hjemmeside: string;
  epost: string;
  content_source: string | null;
  field_provenance: string | null;
};

/**
 * Cohort for the one-time catalog-wide contact-email domain audit
 * (dev-request 2026-08-17-kontaktadresse-feilkilde-og-override, Skive C(c),
 * AC5): every gårdssalg row that has BOTH an established hjemmeside AND a
 * stored epost — i.e. every row where a domain comparison is even possible.
 *
 * Same base population predicate as
 * selectGardssalgProvidersForContactExtraction above (gårdssalg scope, test
 * provider excluded); deliberately does NOT exclude locked or catalog_hidden
 * rows — the audit must COUNT the whole catalog honestly. The caller decides
 * what to do per row (POST /admin/gardssalg-contact-email-audit never
 * auto-flags a manual/claim-locked row, but does report it).
 *
 * Unpaged on purpose: this is a one-time full-catalog pass over a few
 * hundred rows, looped in JS exactly like
 * countActiveGardssalgContactEmailOverrides (routes/opplevelser.ts).
 */
export function selectGardssalgProvidersForContactEmailAudit(): GardssalgContactEmailAuditRow[] {
  const db = getDb(VERTICAL);
  return db
    .prepare(
      `SELECT id, navn, hjemmeside, epost, content_source, field_provenance
         FROM experience_providers
        WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
          AND hjemmeside IS NOT NULL AND TRIM(hjemmeside) != ''
          AND epost IS NOT NULL AND TRIM(epost) != ''
          AND (producer_type IS NULL OR producer_type != 'test-gardssalg')
        ORDER BY navn ASC, id ASC`
    )
    .all() as GardssalgContactEmailAuditRow[];
}

// ─── Paraply-/foreningsvern (dev-request 2026-08-10-veien-til-pool-…, AK2) ──
//
// Daniel's standing email rule: an address may come from the producer's own
// site, or from their umbrella organisation's listing — but it must be the
// PRODUCER's address, "ikke e-post til paraply men til dem". A trade body's
// own inbox reaches the association, not the producer, so outreach sent
// there is both wrong and embarrassing.
//
// Measured 2026-08-10: a cohort run would have written
// post@norskedestillerier.no to Norstill (Norske Destillerier is an interest
// organisation founded 2024 for ~40 craft distilleries) and
// post@mosseolets-venner.no to Moss Bryggeri (a members' association, not
// the brewery).
//
// Deliberately a CURATED DENY-LIST, not a heuristic. A "does the domain look
// like the producer?" rule would reject plenty of legitimate addresses —
// By Brenneri publishes hermod.fledsberg@by-gaard.no, Inderøy Brenneri uses
// info@berg-gaard.no — and Daniel's instruction for this pipeline is
// explicitly "ikke blokker unødvendig". Off-domain addresses are therefore
// REPORTED (see offDomain on the route) but not blocked; only these known
// association domains are refused outright.
export const UMBRELLA_EMAIL_DOMAINS = new Set<string>([
  "norskedestillerier.no",
  "mosseolets-venner.no",
  "bryggeriforeningen.no",
  "nortura.no",
  "hanen.no",
]);

/**
 * True when `email`'s registrable domain belongs to a known umbrella /
 * trade-association inbox. Case- and whitespace-insensitive; a blank or
 * malformed address is never "umbrella" (it simply is not an address).
 */
export function isUmbrellaContactEmail(email: string | null | undefined): boolean {
  const at = (email ?? "").trim().toLowerCase().lastIndexOf("@");
  if (at < 0) return false;
  const domain = (email ?? "").trim().toLowerCase().slice(at + 1);
  if (!domain) return false;
  if (UMBRELLA_EMAIL_DOMAINS.has(domain)) return true;
  // www./mail. style hosts and any sub-domain of a listed umbrella host
  return Array.from(UMBRELLA_EMAIL_DOMAINS).some((u) => domain.endsWith(`.${u}`));
}

// ─── Gårdssalg Brreg-verifisering (dev-request 2026-08-08-gardssalg-brreg-
//     verify-og-embedded-evidens) ──────────────────────────────────────────
//
// The krav-2 outreach gate (computeGardssalgReadinessTier) requires
// brreg_verified = 1, but no lever has ever SET that flag for the seed-era
// rows: NACE-discovered rows are born brreg_verified=1 (created straight
// from a Brreg record) and the claim flow stamps it, while rows imported
// from curated seed lists pre-date both paths. Measured live 2026-08-08:
// 57 rows carry website + contact + about_text + products and are blocked
// from the pool by this flag alone. This block is the missing lever:
// verify a stored org_nr directly against Brreg (existence + active state +
// exact normalised name match) and stamp brreg_verified/brreg_active with
// audit + provenance. Evidence-only: an inexact name, a dead org, or a
// missing org_nr NEVER writes — those rows are reported for the existing
// org_nr review-queue path instead.

export type GardssalgBrregVerifyTarget = {
  id: string;
  navn: string;
  org_nr: string;
  content_source: string | null;
  brreg_verified: number | null;
  // Skive 4 (dev-request 2026-08-09-daglig-outreach-klargjoering-og-
  // stoerrelsesgate): carried so the route can decide whether an
  // already-verified row is eligible for the antall_ansatte-only refresh
  // path (refreshEmployees) without a second query.
  antall_ansatte: number | null;
};

/**
 * Cohort: gårdssalg rows NOT yet brreg_verified that DO carry a 9-digit
 * org_nr, unlocked, not the test provider. Stable total order for offset
 * paging (same idiom as the contact-extraction selector). Also reports how
 * many unverified rows sit OUTSIDE the cohort for lack of an org_nr — those
 * need the org_nr review-queue path first, and the number keeps the report
 * honest about what this lever cannot reach.
 */
export function selectGardssalgProvidersForBrregVerify(
  limit: number,
  offset: number,
): { targets: GardssalgBrregVerifyTarget[]; cohortTotal: number; noOrgnrTotal: number } {
  const db = getDb(VERTICAL);
  const base = `
    (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
    AND (brreg_verified IS NULL OR brreg_verified != 1)
    AND (content_source IS NULL OR content_source NOT IN ('manual','claim'))
    AND (producer_type IS NULL OR producer_type != 'test-gardssalg')`;
  const where = `${base}
    AND org_nr IS NOT NULL AND TRIM(org_nr) != '' AND LENGTH(TRIM(org_nr)) = 9`;
  const cohortTotal = (db.prepare(`SELECT COUNT(*) AS n FROM experience_providers WHERE ${where}`).get() as { n: number }).n;
  const noOrgnrTotal = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM experience_providers WHERE ${base}
           AND (org_nr IS NULL OR TRIM(org_nr) = '' OR LENGTH(TRIM(org_nr)) != 9)`
      )
      .get() as { n: number }
  ).n;
  const targets = db
    .prepare(
      `SELECT id, navn, org_nr, content_source, brreg_verified, antall_ansatte
         FROM experience_providers WHERE ${where}
        ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as GardssalgBrregVerifyTarget[];
  return { targets, cohortTotal, noOrgnrTotal };
}

/** Explicit-target resolver for the route's providerIds override — gårdssalg-
 * scoped and test-provider-excluded like the selector, but NOT filtered on
 * brreg_verified/org_nr/locks (those are decided and reported by the route). */
export function getGardssalgBrregVerifyTarget(
  providerId: string,
): (Omit<GardssalgBrregVerifyTarget, "org_nr"> & { org_nr: string | null }) | null {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT id, navn, org_nr, content_source, brreg_verified, antall_ansatte
         FROM experience_providers
        WHERE id = ?
          AND (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
          AND (producer_type IS NULL OR producer_type != 'test-gardssalg')`
    )
    .get(providerId) as (Omit<GardssalgBrregVerifyTarget, "org_nr"> & { org_nr: string | null }) | undefined;
  return row ?? null;
}

// Injectable Brreg-verify function — same test seam pattern as
// __setGardssalgWebsiteSearchForTesting: module-level override, null by
// default (production uses the real verifyOrgNumber), settable by tests so
// route-level tests never hit the network.
export type GardssalgBrregVerifyFn = (orgNr: string) => Promise<import("./brreg-client").BrregVerifyResult>;
let _gardssalgBrregVerifyOverride: GardssalgBrregVerifyFn | null = null;
export function __setGardssalgBrregVerifyForTesting(fn: GardssalgBrregVerifyFn | null): void {
  _gardssalgBrregVerifyOverride = fn;
}
export function getGardssalgBrregVerifyOverride(): GardssalgBrregVerifyFn | null {
  return _gardssalgBrregVerifyOverride;
}

/**
 * Stamp brreg_verified=1 (+ brreg_active=1) on one provider after a
 * successful Brreg verification. One-directional by design: only ever flips
 * 0/NULL → 1, never the reverse, and touches NO other data field. Same
 * write discipline as applyGardssalgProviderContact: manual/claim lock
 * respected, one gardssalg_content_audit row per changed field,
 * field_provenance entry (source_url = the Brreg API URL the evidence came
 * from), all inside one transaction. Returns the field names written
 * ([] when locked / already verified / row missing).
 *
 * `antallAnsatte` (dev-request 2026-08-09-daglig-outreach-klargjoering-og-
 * stoerrelsesgate, Skive 1) piggybacks the antall_ansatte column onto this
 * SAME one-time write — no new Brreg HTTP call, no new endpoint. Optional:
 * `undefined` (a caller/stub that doesn't know about this field, e.g. every
 * pre-existing test double of GardssalgBrregVerifyFn) is a strict no-op for
 * this column, same as omitting any other optional param. Only written to
 * `gardssalg_content_audit`/reported in the return value when it actually
 * CHANGES the stored value — a `null` (or absent) fetched figure over an
 * already-null column is not a change worth an audit row.
 */
export function applyGardssalgBrregVerified(
  providerId: string,
  evidenceUrl: string,
  batchId?: string,
  antallAnsatte?: number | null,
): string[] {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT id, content_source, brreg_verified, brreg_active, field_provenance, antall_ansatte
         FROM experience_providers WHERE id = ?`
    )
    .get(providerId) as
    | {
        id: string;
        content_source: string | null;
        brreg_verified: number | null;
        brreg_active: number | null;
        field_provenance: string | null;
        antall_ansatte: number | null;
      }
    | undefined;
  if (!row) return [];
  if (row.content_source === "manual" || row.content_source === "claim") return [];
  if (row.brreg_verified === 1) return [];

  const written: Array<{ field: string; oldValue: string | null }> = [
    { field: "brreg_verified", oldValue: row.brreg_verified === null ? null : String(row.brreg_verified) },
  ];
  if (row.brreg_active !== 1) {
    written.push({ field: "brreg_active", oldValue: row.brreg_active === null ? null : String(row.brreg_active) });
  }
  const hasAntallAnsatte = antallAnsatte !== undefined;
  const nextAntallAnsatte = hasAntallAnsatte ? antallAnsatte : row.antall_ansatte;
  if (hasAntallAnsatte && nextAntallAnsatte !== row.antall_ansatte) {
    written.push({
      field: "antall_ansatte",
      oldValue: row.antall_ansatte === null ? null : String(row.antall_ansatte),
    });
  }

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
  provenance["brreg_verified"] = { source_url: evidenceUrl, fetched_at: new Date().toISOString() };
  if (hasAntallAnsatte) {
    provenance["antall_ansatte"] = { source_url: evidenceUrl, fetched_at: new Date().toISOString() };
  }

  const applyWithAudit = db.transaction(() => {
    db.prepare(
      `UPDATE experience_providers
          SET brreg_verified = 1, brreg_active = 1,
              antall_ansatte = @antall_ansatte,
              field_provenance = @field_provenance, updated_at = datetime('now')
        WHERE id = @id`
    ).run({
      id: providerId,
      antall_ansatte: nextAntallAnsatte,
      field_provenance: JSON.stringify(provenance),
    });
    const insertAudit = db.prepare(
      `INSERT INTO gardssalg_content_audit
         (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
       VALUES (@id, @provider_id, @field_name, @old_value, @new_value, @source_url, @batch_id, 'system', datetime('now'))`
    );
    for (const w of written) {
      insertAudit.run({
        id: uuid(),
        provider_id: providerId,
        field_name: w.field,
        old_value: w.oldValue,
        new_value: w.field === "antall_ansatte" ? String(nextAntallAnsatte ?? "") : "1",
        source_url: evidenceUrl,
        batch_id: batchId ?? null,
      });
    }
  });
  applyWithAudit();

  return written.map((w) => w.field);
}

/**
 * Etterfyllingsvei for `antall_ansatte` på rader som er brreg_verified FRA
 * FØR (dev-request 2026-08-09-daglig-outreach-klargjoering-og-
 * stoerrelsesgate, Skive 4 — supervisor-inbox/2026-08-10-priority-headsup-
 * stoerrelsesgaten-er-inert-antall-ansatte-mangler.md). Uten denne var
 * antall_ansatte umulig å etterfylle på nesten hele poolen, fordi
 * applyGardssalgBrregVerified over har `if (row.brreg_verified === 1) return
 * [];` — riktig for førstegangs-verifisering (idempotent), men det stenger
 * samtidig den eneste veien inn for et felt som ble lagt til ETTER at raden
 * allerede var verifisert. Denne funksjonen eier KUN antall_ansatte-kolonnen:
 * krever brreg_verified === 1 inn (den etablerer aldri verifisering — det er
 * fortsatt eneansvaret til applyGardssalgBrregVerified), er en no-op
 * (returnerer `[]`, ingen audit-rad) hvis antall_ansatte allerede har en
 * verdi (NULL→verdi only; periodisk ferskvare-refresh av et allerede fylt
 * tall er bevisst utenfor scope for denne skiven) eller hvis det innhentede
 * Brreg-tallet selv er null/undefined (ingenting å skrive), og respekterer
 * manual/claim-lås som alle andre skriveveier i denne fila. Samme
 * transaksjon+audit+field_provenance-mønster som naboen over — bare
 * begrenset til én kolonne.
 */
export function applyGardssalgBrregEmployeesRefresh(
  providerId: string,
  evidenceUrl: string,
  batchId: string | undefined,
  antallAnsatte: number | null | undefined,
): string[] {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT id, content_source, brreg_verified, field_provenance, antall_ansatte
         FROM experience_providers WHERE id = ?`
    )
    .get(providerId) as
    | {
        id: string;
        content_source: string | null;
        brreg_verified: number | null;
        field_provenance: string | null;
        antall_ansatte: number | null;
      }
    | undefined;
  if (!row) return [];
  if (row.content_source === "manual" || row.content_source === "claim") return [];
  if (row.brreg_verified !== 1) return [];
  if (row.antall_ansatte !== null && row.antall_ansatte !== undefined) return [];
  if (antallAnsatte === null || antallAnsatte === undefined) return [];

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
  provenance["antall_ansatte"] = { source_url: evidenceUrl, fetched_at: new Date().toISOString() };

  const applyWithAudit = db.transaction(() => {
    db.prepare(
      `UPDATE experience_providers
          SET antall_ansatte = @antall_ansatte,
              field_provenance = @field_provenance, updated_at = datetime('now')
        WHERE id = @id`
    ).run({
      id: providerId,
      antall_ansatte: antallAnsatte,
      field_provenance: JSON.stringify(provenance),
    });
    db.prepare(
      `INSERT INTO gardssalg_content_audit
         (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
       VALUES (@id, @provider_id, 'antall_ansatte', @old_value, @new_value, @source_url, @batch_id, 'system', datetime('now'))`
    ).run({
      id: uuid(),
      provider_id: providerId,
      old_value: row.antall_ansatte === null ? null : String(row.antall_ansatte),
      new_value: String(antallAnsatte),
      source_url: evidenceUrl,
      batch_id: batchId ?? null,
    });
  });
  applyWithAudit();

  return ["antall_ansatte"];
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
 * Normalizes a URL string for AT-PLACE COMPARISON PURPOSES ONLY (AC9
 * follow-up, dev-request 2026-08-07-kontaktjakt-drikkeprodusenter): strips a
 * single leading http(s):// scheme and exactly one trailing slash. Nothing
 * else — no lowercasing, no www. stripping, no path/query normalization.
 * Deliberately narrow so it can never paper over an actual host difference;
 * see applyGardssalgProviderWebsite's isAtPlace check below.
 */
function normalizeUrlForAtPlaceComparison(value: string): string {
  const withoutScheme = value.trim().replace(/^https?:\/\//i, "");
  return withoutScheme.endsWith("/") ? withoutScheme.slice(0, -1) : withoutScheme;
}

/**
 * Apply an approved website candidate to ONE gårdssalg provider. Same
 * discipline as applyGardssalgProviderOrgnr: lock guard, FILL-ONLY (an
 * existing hjemmeside is never replaced), URL sanity, and an identity
 * re-check at write time — if the candidate's host is already carried by any
 * other provider in the catalog (gardssalgSharedHostCounts), the write is
 * skipped: adopting it would create exactly the shared-host situation the 5d
 * guard exists to quarantine. Godkjenn-på-plass: when the candidate is
 * byte-identical to the row's OWN current hjemmeside — OR merely differs by
 * scheme (http/https) and/or a single trailing slash (AC9 follow-up; see
 * normalizeUrlForAtPlaceComparison) — the fill-only and shared-host guards
 * are skipped (neither protects against colliding with yourself) and only
 * field_provenance is (re)stamped — this clears review-queue duplicates and
 * unblocks the claim-time email harvester's verified-homepage gate without
 * ever changing the stored value. Stamps field_provenance.hjemmeside and a
 * gardssalg_content_audit row (field hjemmeside — in
 * GARDSSALG_ROLLBACKABLE_FIELDS, so the standard rollback lever covers it;
 * old_value/new_value are both the row's actual unchanged stored value on
 * the at-place path, never the candidate, so the audit trail never claims a
 * URL changed when it didn't). Returns the field names actually written ([]
 * if nothing written).
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
  if (row.content_source === "manual") return [];
  if (row.content_source === "claim" && isGardssalgFieldOwnerLocked(row, "hjemmeside")) return [];

  const cleanUrl = (url || "").trim();
  if (cleanUrl.length === 0 || cleanUrl.length > 2048) return [];

  const existingUrl = (row.hjemmeside || "").trim();
  const isAtPlace =
    existingUrl !== "" &&
    (existingUrl === cleanUrl ||
      normalizeUrlForAtPlaceComparison(existingUrl) === normalizeUrlForAtPlaceComparison(cleanUrl));

  // Sanity gate: reject garbage (no dot, whitespace-only, etc.) on the fill
  // path — the at-place branch below never writes cleanUrl at all (it only
  // stamps provenance and leaves the column as existingUrl, which was
  // already schema-validated when first stored), so it's exempt.
  //
  // 2026-08-13 (dev-request 2026-08-07-kontaktjakt-drikkeprodusenter,
  // Daniel-ordered live fix): the scheme (http(s)://) used to be REQUIRED
  // here even on the fill path. That silently blocked exactly the
  // Brreg-sourced and website-discovery candidates this table already
  // stores scheme-less elsewhere (e.g. existing hjemmeside values like
  // "cervisiam.no", "northbrew.no" with no protocol) — a genuinely NEW,
  // well-evidenced candidate (brreg_registered_hjemmeside reason, real
  // org.nr match) could reach this function and still be silently refused
  // as write_skipped_by_guards for no reason other than missing "https://".
  // The scheme is now optional; cleanUrl is still stored verbatim below
  // either way, so a scheme-less accepted candidate is persisted scheme-less
  // — consistent with what's already in this column today.
  if (!isAtPlace && !/^(https?:\/\/)?\S+\.\S+/i.test(cleanUrl)) return [];

  if (!isAtPlace) {
    if (row.hjemmeside && row.hjemmeside.trim() !== "") return []; // fill-only
  }

  const host = hostFromUrlLike(cleanUrl);
  if (!host) return [];
  if (!isAtPlace) {
    if ((gardssalgSharedHostCounts().get(host) || 0) >= 1) return [];
  }

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
    if (isAtPlace) {
      // Optimistic-concurrency compare against existingUrl (the value
      // actually read from the row), NOT cleanUrl (the candidate) — under a
      // normalized-only match the two are textually different, and this
      // clause must still match the row it read.
      const upd = db.prepare(
        `UPDATE experience_providers SET field_provenance = @field_provenance, updated_at = datetime('now')
          WHERE id = @id AND TRIM(hjemmeside) = @hjemmeside`
      ).run({ id: providerId, hjemmeside: existingUrl, field_provenance: JSON.stringify(provenance) });
      if (upd.changes === 0) throw new Error("hjemmeside_changed_concurrently");
    } else {
      const upd = db.prepare(
        `UPDATE experience_providers SET hjemmeside = @hjemmeside, field_provenance = @field_provenance, updated_at = datetime('now')
          WHERE id = @id AND (hjemmeside IS NULL OR TRIM(hjemmeside) = '')`
      ).run({ id: providerId, hjemmeside: cleanUrl, field_provenance: JSON.stringify(provenance) });
      if (upd.changes === 0) throw new Error("hjemmeside_filled_concurrently");
    }
    db.prepare(
      `INSERT INTO gardssalg_content_audit
         (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
       VALUES (@id, @provider_id, 'hjemmeside', @old_value, @new_value, @source_url, @batch_id, 'system', datetime('now'))`
    ).run({
      id: uuid(),
      provider_id: providerId,
      old_value: row.hjemmeside ?? null,
      // At-place path never actually changes the stored value, so new_value
      // must be existingUrl (the actual unchanged stored value), not
      // cleanUrl (the candidate) — under exact match these already coincide;
      // this only matters for the normalized-match case. Non-at-place path
      // (fill) is unaffected: cleanUrl there IS the real new value.
      new_value: isAtPlace ? existingUrl : cleanUrl,
      source_url: evidenceUrl,
      batch_id: batchId ?? null,
    });
  });
  try {
    applyWithAudit();
  } catch (e: any) {
    const msg = String(e?.message);
    if (msg === "hjemmeside_filled_concurrently" || msg === "hjemmeside_changed_concurrently") return [];
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
  // 2026-07-31 (kontakt-utvinning follow-up) — applyGardssalgProviderContact
  // has written audit rows for these since lokal#432, but this allowlist
  // never included them, so a bad extracted address (e.g. a sitebuilder
  // placeholder mailto like info@mysite.com) had no undo lever. The audit
  // trail already exists; this only lets the planner act on it. Kjent og
  // akseptert (samme som hjemmeside/adresse): field_provenance-oppføringen
  // blir stående stale etter rollback (peker på kilde-URL-en mens verdien er
  // null) — den er visning/audit i experiences, aldri en gate. Re-fill etter
  // rollback vetoes av gardssalgContactFieldWasRolledBack i skriveren.
  "epost",
  "telefon",
  // 2026-08-03 (gardssalg-field-concordance-review-approve) —
  // applyGardssalgFieldConcordanceApproval writes mobil via the same
  // audit-trail discipline as epost/telefon above (a confirmed avvik
  // approval, not a fill-only extraction, but the audit row shape is
  // identical), so the standard rollback lever must cover it too.
  "mobil",
  // dev-request 2026-07-31-gardssalg-provider-dubletter-på-tvers-av-seeds,
  // merge lever (POST /admin/gardssalg-provider-dedup-merge,
  // routes/opplevelser.ts, backed by services/gardssalg-provider-merge.ts):
  // every write that route makes — the fill-only field copies onto the
  // survivor (all fields already listed above, plus org_nr, already in this
  // set), the org_nr NULL-out on the removed row, and the removed row's own
  // merged_into stamp — goes through gardssalg_content_audit the SAME way as
  // every other write in this file (both remove_id and keep_id are ordinary
  // experience_providers ids, so this table's existing provider_id FK fits
  // directly; no second audit table was needed — see that route's own doc
  // comment on why this differs from the experiences-table conflict-
  // remediation case, which DID need a second table). Adding "merged_into"
  // here is therefore the ENTIRE rollback-wiring this merge lever needs: the
  // existing POST /admin/gardssalg-content-rollback (default/"provider"
  // entity_type, unchanged) already restores any (provider_id, field_name)
  // pair with gardssalg_content_audit history, and a merge's batch_id spans
  // BOTH the keep_id and remove_id rows it touched, so a single batch_id
  // rollback call undoes an entire merge.
  "merged_into",
]);
// source_url marker stamped on audit rows inserted BY a rollback itself
// (as opposed to rows inserted by a content-refresh write) — lets
// planGardssalgContentRollback tell the two apart for idempotency (see its
// doc comment) without a dedicated boolean column.
const GARDSSALG_ROLLBACK_MARKER = "internal://rollback";
// source_url marker stamped on the ONE audit row applyGardssalgRollbackVetoOverride
// inserts (2026-08-09 rollback-veto-override lever, ~line 6355 below) — records
// that an admin deliberately overrode a gardssalgContactFieldWasRolledBack veto
// for a (provider, field) pair, WITHOUT itself changing the field's stored
// value (old_value/new_value are both the untouched current value; only the
// audit trail — and thus future eligibility — changes). Deliberately distinct
// from GARDSSALG_ROLLBACK_MARKER: gardssalgContactFieldWasRolledBack only ever
// treats a LATEST row whose source_url === GARDSSALG_ROLLBACK_MARKER as a live
// veto, so inserting a row stamped with THIS marker instead is exactly what
// lifts the veto (the override row becomes the new "latest", and it is not
// the rollback marker) — see applyGardssalgRollbackVetoOverride's own doc
// comment.
const GARDSSALG_ROLLBACK_VETO_OVERRIDE_MARKER = "internal://rollback-veto-override";

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

// Fields the claim portal actually lets an owner edit AND that the rollback
// allow-list also covers (booking_live is claim-editable but is a consent
// toggle with no rollback candidate, so it's excluded here on purpose — see
// CLAIM_EDITABLE_FIELDS in gardssalg-claim.ts, which is the source of truth
// this list is drawn from). Only these five fields ever get a per-field
// owner_locks lookup in isGardssalgFieldOwnerLocked below.
const GARDSSALG_OWNER_LOCK_ELIGIBLE_FIELDS = new Set([
  "about_text",
  "visit_text",
  "opening_hours_text",
  "products",
  "hjemmeside",
]);

/**
 * Per-field owner-lock policy for gårdssalg rollback writes (dev-request
 * 2026-08-03-gardssalg-owner-lock-rollback). Prior to this, both rollback
 * functions gated on the WHOLE ROW: content_source 'manual' or 'claim' froze
 * every field. PR #472 (commit 5410fd9) added an ADDITIVE per-field stamp —
 * field_provenance.owner_locks.<field> = {locked_at} — written by the claim
 * portal (updateClaimedProviderProfile, gardssalg-claim.ts) whenever an
 * owner edits one of CLAIM_EDITABLE_FIELDS. This helper consults that stamp
 * to narrow the freeze from row-level to field-level, but ONLY for
 * content_source='claim' rows and ONLY for the five claim-editable,
 * rollback-eligible fields:
 *
 *   1. content_source === 'manual' -> always locked, unconditionally. Manual
 *      rows never consult owner_locks (a claim-portal-only concept) — the
 *      full-row freeze for manual rows is unchanged.
 *   2. content_source === 'claim':
 *      - fieldName in GARDSSALG_OWNER_LOCK_ELIGIBLE_FIELDS -> locked IFF
 *        field_provenance.owner_locks.<fieldName> is present (the owner
 *        touched THIS field via the portal); if absent, the owner never
 *        touched it and rollback may proceed.
 *      - any other fieldName (org_nr, epost, telefon, adresse, postnummer,
 *        poststed — fields owner_locks can never contain, since the claim
 *        portal doesn't expose them) -> always locked, unconditionally, same
 *        as today's row-level behavior. No change for these fields.
 *   3. any other content_source (null, enrichment-derived, etc.) -> not
 *      locked, same as today's existing behavior.
 *
 * field_provenance is read defensively (same JSON-parse-with-try-catch
 * recipe used throughout this file, e.g. applyGardssalgProviderWebsite
 * above) — malformed JSON is treated as "no owner_locks" rather than
 * thrown.
 */
export function isGardssalgFieldOwnerLocked(
  providerRow: { content_source: string | null; field_provenance?: string | null },
  fieldName: string
): boolean {
  if (providerRow.content_source === "manual") return true;
  if (providerRow.content_source === "claim") {
    if (!GARDSSALG_OWNER_LOCK_ELIGIBLE_FIELDS.has(fieldName)) return true;
    let ownerLocks: Record<string, unknown> | undefined;
    if (providerRow.field_provenance) {
      try {
        const parsed = JSON.parse(providerRow.field_provenance);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const ol = (parsed as Record<string, unknown>).owner_locks;
          if (ol && typeof ol === "object" && !Array.isArray(ol)) {
            ownerLocks = ol as Record<string, unknown>;
          }
        }
      } catch {
        /* malformed existing JSON -> treat as no owner_locks rather than throw */
      }
    }
    return Boolean(ownerLocks && Object.prototype.hasOwnProperty.call(ownerLocks, fieldName));
  }
  return false;
}

// Resolve the (provider_id, field_name) pairs a rollback request targets:
// batch_id -> every field any provider had touched under that batch;
// provider_id (+ optional field_name) -> that provider's field(s) with any
// audit history. Pure lookup — no writes, no idempotency checks (those
// happen in planGardssalgContentRollback).
//
// batch_id ordering (dev-request 2026-07-31-gardssalg-provider-dubletter-på-
// tvers-av-seeds, merge lever): `ORDER BY MAX(rowid) DESC` — the
// MOST-recently-written (provider_id, field_name) pair in the batch is
// restored FIRST — rather than the previous plain `SELECT DISTINCT` (whose
// row order was unspecified/implementation-defined). This matters for
// exactly one existing rollbackable field: org_nr carries a UNIQUE
// constraint, and the provider-merge lever's org_nr MOVE writes two audit
// rows in the SAME batch — clear the removed row's org_nr (earlier rowid),
// then set the survivor's org_nr to that value (later rowid). Restoring in
// insertion order would try to write the survivor's PRE-restore org_nr back
// onto the removed row WHILE the survivor still holds it — a live UNIQUE
// collision (reproduced by opplevelser-gardssalg-provider-dedup-merge.test.ts's
// own rollback coverage). Restoring in REVERSE-chronological (LIFO) order
// undoes the LATER write (survivor -> NULL) before the EARLIER one (removed
// row -> the value), which never collides. Every other rollbackable field on
// experience_providers has no UNIQUE constraint, so this ordering change is
// a no-op for every batch that doesn't contain this exact shape (each
// UPDATE's own correctness never depended on sibling-item order before).
//
// batch_id per target, and the chain-merge history-loss fix (2026-08-15,
// fix-up to the provider-merge lever above): the GROUP BY above collapses
// EVERY audit row a (provider_id, field_name) pair accumulated within the
// batch down to a single target — that's correct for the "which pairs does
// this batch touch" question, but a CHAIN merge within one batch (pair 1:
// remove=A,keep=B; pair 2, same batch_id: remove=B,keep=C — see this
// module's own doc comment on why chains across pairs in one batch are
// intentionally allowed) writes org_nr on B TWICE: once as a fill target
// (NULL -> X, when A->B happens) and once cleared back out (X -> NULL, when
// B->C happens). Both survive as separate gardssalg_content_audit rows —
// the GROUP BY here only ever discarded which ROW to key the target on, it
// never discarded the rows themselves. planGardssalgContentRollback (below)
// now uses that: for a batch-resolved target it looks up the EARLIEST row
// for that (provider_id, field_name) WITHIN THIS batch_id (not the global
// latest) to compute restore_to, which is the row whose old_value is the
// TRUE pre-batch value — for B above, that's the first (fill) row's
// old_value = NULL, correctly ignoring the intermediate X it only held
// transiently mid-batch. For every (provider_id, field_name) touched only
// ONCE in the batch (every existing case before this fix), the earliest
// row and the latest row are the SAME row, so this is a no-op — old
// single-write batches restore identically to before. Returning `batch_id`
// on each target here (rather than only accepting it as a resolveGardssalg-
// RollbackTargets input) is what lets planGardssalgContentRollback tell a
// batch-resolved target apart from a provider_id-resolved one and scope its
// lookup query accordingly — provider_id-resolved targets are UNCHANGED
// (still the global-latest-row lookup, since there's no batch to scope to).
//
// This was evaluated against the "reject chain-merges in one batch instead"
// fallback and rejected in favor of this resolver-side fix: chain merges are
// a real, intentional feature here (this module's own doc comment, and 4 of
// 6 pairs in the dev-request's own verified-pairs table move org_nr across a
// chain), so refusing them would be a feature regression, not just a bug
// fix — and the fix above is narrow (two functions, additive `batch_id` on
// the resolver's return shape, a single extra WHERE clause + ASC-vs-DESC
// flip in the lookup query) and provably reconstructs the true pre-batch
// state for arbitrarily long chains within a batch, not just the two-hop
// case: see opplevelser-gardssalg-provider-dedup-merge.test.ts's chain-merge
// rollback coverage.
function resolveGardssalgRollbackTargets(
  opts: GardssalgRollbackTarget
): Array<{ provider_id: string; field_name: string; batch_id?: string }> {
  const db = getDb(VERTICAL);
  if (opts.batch_id) {
    const rows = db
      .prepare(
        `SELECT provider_id, field_name FROM gardssalg_content_audit
          WHERE batch_id = ?
          GROUP BY provider_id, field_name
          ORDER BY MAX(rowid) DESC`
      )
      .all(opts.batch_id) as Array<{ provider_id: string; field_name: string }>;
    return rows.map((r) => ({ ...r, batch_id: opts.batch_id }));
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
    //
    // Batch-scoped targets (t.batch_id set — see resolveGardssalgRollback-
    // Targets's doc comment on the 2026-08-15 chain-merge fix) look up the
    // EARLIEST row for this (provider_id, field_name) WITHIN THAT batch
    // (ORDER BY rowid ASC, WHERE batch_id = ...) instead of the global
    // latest: that row's old_value is the true pre-batch value, correctly
    // skipping past any intermediate value this same field held only
    // transiently mid-batch (e.g. org_nr passing through a middle row on its
    // way A->B->C in a chain merge). A provider_id-resolved target (no
    // batch_id — the plain, non-batch rollback path) is UNCHANGED: it keeps
    // the original global-latest lookup, since there is no batch to scope
    // to and this is the path the "already rolled back" idempotency check
    // (case (2) below) actually depends on.
    const latest = t.batch_id
      ? (db
          .prepare(
            `SELECT old_value, new_value, source_url, changed_at FROM gardssalg_content_audit
              WHERE provider_id = ? AND field_name = ? AND batch_id = ?
              ORDER BY rowid ASC LIMIT 1`
          )
          .get(t.provider_id, t.field_name, t.batch_id) as
          | { old_value: string | null; new_value: string | null; source_url: string | null; changed_at: string }
          | undefined)
      : (db
          .prepare(
            `SELECT old_value, new_value, source_url, changed_at FROM gardssalg_content_audit
              WHERE provider_id = ? AND field_name = ?
              ORDER BY rowid DESC LIMIT 1`
          )
          .get(t.provider_id, t.field_name) as
          | { old_value: string | null; new_value: string | null; source_url: string | null; changed_at: string }
          | undefined);
    if (!latest) {
      skipped.push({ provider_id: t.provider_id, field_name: t.field_name, reason: "no_audit_row" });
      continue;
    }
    const providerRow = db
      .prepare(
        `SELECT ${t.field_name} AS current_value, content_source, field_provenance FROM experience_providers WHERE id = ?`
      )
      .get(t.provider_id) as
      | { current_value: string | null; content_source: string | null; field_provenance: string | null }
      | undefined;
    if (!providerRow) {
      skipped.push({ provider_id: t.provider_id, field_name: t.field_name, reason: "no_audit_row" });
      continue;
    }
    // Same write guard as applyGardssalgProviderContent() (~line 2031): once a
    // provider's content_source is 'manual' or 'claim', the automated
    // pipeline never touches that row again — a rollback is part of the same
    // automated pipeline, so it must never overwrite manually-provided
    // content either, even if a stale audit row from before the claim/manual
    // edit makes the field look "restorable". Narrowed to per-field for
    // content_source='claim' rows via isGardssalgFieldOwnerLocked (dev-request
    // 2026-08-03-gardssalg-owner-lock-rollback) — see its doc comment.
    if (isGardssalgFieldOwnerLocked(providerRow, t.field_name)) {
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
 * Thrown by applyGardssalgContentRollback when ANY item in the batch fails
 * to apply (2026-08-15 chain-merge-rollback fix-up — the whole-batch
 * transaction safety net described on that function's own doc comment).
 * Distinguishing this from a generic thrown error lets the route layer
 * (POST /admin/gardssalg-content-rollback, opplevelser.ts) tell the caller
 * plainly that the rollback did NOT happen at all — better-sqlite3 has
 * already rolled back every write this call attempted — rather than
 * returning a bare, uninformative 500 that leaves an operator unsure
 * whether the batch is half-applied. `cause` carries the original thrown
 * error (e.g. the SqliteError for a UNIQUE constraint violation) for
 * logging/diagnosis.
 */
export class GardssalgRollbackApplyError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "GardssalgRollbackApplyError";
  }
}

/**
 * Apply a previously-planned gårdssalg content rollback (see
 * planGardssalgContentRollback): restores experience_providers.<field_name>
 * to `restore_to` for every item, and — critically — inserts a NEW
 * gardssalg_content_audit row per restore (old_value = the value
 * immediately before the rollback, new_value = the restored value,
 * changed_by='system', source_url carries an `internal://rollback` marker)
 * so the rollback itself is auditable and the audit trail is never
 * silently mutated or deleted. field_name is re-validated against the same
 * allow-list as planGardssalgContentRollback (defense in depth — items
 * should already be plan() output, but this function never trusts
 * field_name blindly). content_source is likewise re-verified right before
 * each write (same defense in depth — items should already have been
 * filtered by plan()'s manual/claim check, but this function never trusts
 * that blindly either): if a provider's content_source is 'manual' or
 * 'claim', the item is skipped entirely (no write, no audit row, omitted
 * from the returned `restored` array) rather than restored.
 *
 * Whole-batch atomicity (2026-08-15, chain-merge-rollback fix-up): the ENTIRE
 * loop below runs inside ONE outer db.transaction — previously each item ran
 * in its OWN separate transaction, with nothing wrapping the loop itself, so
 * a failure partway through a multi-item batch (e.g. a UNIQUE constraint
 * violation restoring a chain-merged field — see resolveGardssalgRollback-
 * Targets's doc comment) left every item BEFORE the failure already
 * committed and every item AFTER it never attempted: a silently
 * half-applied, corrupted rollback. Wrapping the whole loop makes it
 * all-or-nothing — if ANY item throws (this bug or any future one),
 * better-sqlite3 rolls back every write this call made, and the DB is left
 * byte-for-byte as it was before the call. The exception is re-thrown as
 * GardssalgRollbackApplyError so the caller can tell "atomically failed,
 * nothing applied" apart from other failure modes. This is a general
 * robustness fix to shared rollback machinery, independent of the
 * chain-merge case that surfaced it — it protects every caller of this
 * function, not just the provider-merge lever's batches.
 */
export function applyGardssalgContentRollback(
  items: GardssalgRollbackPlanItem[]
): Array<{ provider_id: string; field_name: string; restored_to: string | null }> {
  const db = getDb(VERTICAL);
  const restored: Array<{ provider_id: string; field_name: string; restored_to: string | null }> = [];

  const runAll = db.transaction((batchItems: GardssalgRollbackPlanItem[]) => {
    for (const item of batchItems) {
      if (!GARDSSALG_ROLLBACKABLE_FIELDS.has(item.field_name)) continue;
      // Same write guard as applyGardssalgProviderContent() (~line 2031) and
      // planGardssalgContentRollback's manual/claim check above — re-verified
      // here, right before the UPDATE, rather than trusting that this item
      // already passed that check in plan()'s `restorable` list. If a manual
      // or claim edit reaches this function anyway, skip it silently: no
      // write, no audit row, and it's simply omitted from `restored`. Narrowed
      // to per-field for content_source='claim' rows via
      // isGardssalgFieldOwnerLocked (dev-request 2026-08-03-gardssalg-owner-
      // lock-rollback) — see its doc comment.
      const providerRow = db
        .prepare(`SELECT content_source, field_provenance FROM experience_providers WHERE id = ?`)
        .get(item.provider_id) as
        | { content_source: string | null; field_provenance: string | null }
        | undefined;
      if (providerRow && isGardssalgFieldOwnerLocked(providerRow, item.field_name)) {
        continue;
      }
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
      restored.push({ provider_id: item.provider_id, field_name: item.field_name, restored_to: item.restore_to });
    }
  });

  try {
    runAll(items);
  } catch (e: any) {
    // better-sqlite3 has already rolled the whole transaction back by the
    // time this catch runs — `restored` (built up inside the transaction
    // closure above) is discarded rather than returned, since none of it
    // actually persisted.
    throw new GardssalgRollbackApplyError(
      `gardssalg content rollback failed atomically — no changes were applied: ${e?.message ?? String(e)}`,
      e
    );
  }

  return restored;
}

// ─── Gårdssalg field-concordance review-queue approval (orchestrator
// dev-request 2026-08-03-gardssalg-field-concordance-review-approve) ────────
// The missing consumer for gardssalg_field_concordance_review_queue (see its
// schema doc comment, init-experiences.ts, and applyGardssalgFieldConcordance
// above — the scanner that populates the queue but never resolves it). Same
// strict "confirmation surface, never an arbitrary-write surface" contract as
// applyGardssalgProviderOrgnr/applyGardssalgProviderWebsite's own approve
// levers: the route (routes/opplevelser.ts) only ever calls this with the
// EXACT (provider_id, field_name, found_value) triple the queue itself
// carries, having already rejected anything else.

/** Field names this approval function may ever write. adresse/postnummer/
 *  poststed/opening_hours_text (the four presence-only GFC fields) are
 *  deliberately NEVER in this set — they can never land an avvik in the
 *  queue in the first place (see GFC_AVVIK_CAPABLE_FIELDS), and this
 *  function must reject them even if a caller tried anyway. Validated BEFORE
 *  fieldName is ever used in a SQL string. */
const GFC_APPROVAL_FIELDS = new Set(["epost", "telefon", "mobil"]);

export type GfcApprovalResult = {
  provider_id: string;
  field_name: string;
  written: boolean;
  reason?:
    | "invalid_field"
    | "not_found"
    | "owner_locked"
    | "stale_current_value"
    | "rollback_vetoed"
    | "already_blank";
};

/**
 * Apply ONE confirmed gardssalg_field_concordance_review_queue finding to
 * experience_providers.<fieldName>. Unlike every other gårdssalg write
 * helper in this file (applyGardssalgProviderContact et al., which are
 * fill-only — they only ever write when the existing value is blank), this
 * one OVERWRITES a non-blank value: the entire point of an `avvik` finding
 * is "the stored value contradicts the producer's own verified homepage",
 * so a confirmed approval must be able to correct it, not just fill a gap.
 *
 * Guard order (first failing gate wins, no DB write on any of them):
 *   1. fieldName not in GFC_APPROVAL_FIELDS -> "invalid_field", no DB call
 *      at all (defense in depth — field_name can arrive from an admin
 *      request body one hop up).
 *   2. provider not found -> "not_found".
 *   3. isGardssalgFieldOwnerLocked(row, fieldName) -> "owner_locked" (the
 *      SAME per-field lock policy every other gårdssalg write helper in this
 *      file consults — see its own doc comment. mobil is not in
 *      GARDSSALG_OWNER_LOCK_ELIGIBLE_FIELDS, so for content_source='claim'
 *      rows it always falls into that helper's "any other fieldName ->
 *      always locked" branch, same as epost/telefon today).
 *   4. gardssalgContactFieldWasRolledBack(providerId, fieldName) -> true ->
 *      "rollback_vetoed" (2026-08-09 gap fix). Without this gate a human who
 *      deliberately rolled back a bad epost/telefon/mobil value (POST
 *      /admin/gardssalg-content-rollback) could have that exact value
 *      silently re-written the next time the field-concordance scanner
 *      re-flags it as an avvik and someone approves the (now stale, but
 *      byte-identical-looking) finding — the same "an undo that un-undoes
 *      itself" failure applyGardssalgProviderContact already guards against
 *      for its own fill-only writes (see gardssalgContactFieldWasRolledBack's
 *      own doc comment). Fail-closed: checked BEFORE staleness, so a vetoed
 *      field is rejected as vetoed even if expectedCurrentValue happens to
 *      still match. The lever to deliberately override this veto is
 *      applyGardssalgRollbackVetoOverride below — this function itself never
 *      bypasses it.
 *   5. the row's CURRENT value for fieldName (trimmed, blank -> null)
 *      doesn't match `expectedCurrentValue` (same normalisation) ->
 *      "stale_current_value" — something else already changed the field
 *      since this finding was queued; approving the stale finding would
 *      silently clobber that other change.
 *
 * On success: read-modify-write field_provenance[fieldName] (defensive JSON
 * parse, malformed/missing -> {}, never clobbers other keys — same recipe as
 * applyGardssalgProviderContact above), UPDATE the column, and insert one
 * gardssalg_content_audit row (old_value = the true pre-write trimmed
 * current value, new_value = newValue, source_url = the same value stamped
 * into field_provenance) — all inside one db.transaction. Returns
 * `{written: true}` (no `reason`).
 */
export function applyGardssalgFieldConcordanceApproval(
  providerId: string,
  fieldName: string,
  expectedCurrentValue: string | null,
  newValue: string,
  batchId?: string
): GfcApprovalResult {
  if (!GFC_APPROVAL_FIELDS.has(fieldName)) {
    return { provider_id: providerId, field_name: fieldName, written: false, reason: "invalid_field" };
  }

  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT id, content_source, epost, telefon, mobil, hjemmeside, field_provenance
         FROM experience_providers WHERE id = ?`
    )
    .get(providerId) as
    | {
        id: string;
        content_source: string | null;
        epost: string | null;
        telefon: string | null;
        mobil: string | null;
        hjemmeside: string | null;
        field_provenance: string | null;
      }
    | undefined;
  if (!row) {
    return { provider_id: providerId, field_name: fieldName, written: false, reason: "not_found" };
  }

  if (isGardssalgFieldOwnerLocked(row, fieldName)) {
    return { provider_id: providerId, field_name: fieldName, written: false, reason: "owner_locked" };
  }

  if (gardssalgContactFieldWasRolledBack(providerId, fieldName)) {
    return { provider_id: providerId, field_name: fieldName, written: false, reason: "rollback_vetoed" };
  }

  const normalise = (v: string | null | undefined): string | null => {
    if (v === null || v === undefined) return null;
    const trimmed = String(v).trim();
    return trimmed === "" ? null : trimmed;
  };
  const currentValueRaw = (row as unknown as Record<string, string | null>)[fieldName] ?? null;
  const currentValue = normalise(currentValueRaw);
  if (currentValue !== normalise(expectedCurrentValue)) {
    return { provider_id: providerId, field_name: fieldName, written: false, reason: "stale_current_value" };
  }

  const evidenceUrl = row.hjemmeside || "internal://field-concordance-review-approve";

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
  provenance[fieldName] = { source_url: evidenceUrl, fetched_at: new Date().toISOString() };

  const applyWithAudit = db.transaction(() => {
    db.prepare(
      `UPDATE experience_providers SET ${fieldName} = @newValue, field_provenance = @field_provenance, updated_at = datetime('now') WHERE id = @id`
    ).run({ id: providerId, newValue, field_provenance: JSON.stringify(provenance) });
    db.prepare(
      `INSERT INTO gardssalg_content_audit
         (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
       VALUES (@id, @provider_id, @field_name, @old_value, @new_value, @source_url, @batch_id, 'system', datetime('now'))`
    ).run({
      id: uuid(),
      provider_id: providerId,
      field_name: fieldName,
      old_value: currentValue,
      new_value: newValue,
      source_url: evidenceUrl,
      batch_id: batchId ?? null,
    });
  });
  applyWithAudit();

  return { provider_id: providerId, field_name: fieldName, written: true };
}

// ─── Gårdssalg field-concordance CLEAR (2026-08-09, dev-request 2026-08-09-
// epost-korrigering-paa-plass) ──────────────────────────────────────────────
//
// applyGardssalgFieldConcordanceApproval above CORRECTS epost/telefon/mobil —
// it always writes a caller-supplied non-blank newValue. It has no way to
// express "this field should become blank": a `field_concordance` scan that
// finds NOTHING on the page verdicts ikke_funnet_på_siden, which (per that
// module's own doc comment) deliberately conflates "genuinely absent from a
// successfully-fetched page" with "the page couldn't even be fetched" —
// there is no approval lever that can act on the former without also being
// exposed to the latter's fail-open risk.
//
// This function is that lever, but DELIBERATELY NOT a generalization of
// applyGardssalgFieldConcordanceApproval — it is narrower on purpose:
//   - fieldName is NOT a parameter. It is hardcoded to "epost" inside this
//     function's own body, never selected by a caller. This is the ONE path
//     in this codebase that can null out a previously-non-blank contact
//     field, so its blast radius must stay structurally scoped to epost
//     only — a generalized "clear any field" lever would let one careless
//     caller null telefon/mobil/hjemmeside/etc. through the same door, and
//     each of those has different downstream consumers and different risk.
//     If a future dev-request needs the same lever for another field, that
//     is a new, equally narrow function, not a widened version of this one.
//   - This function does NOT fetch anything and does NOT decide "genuinely
//     absent" — that judgment is the CALLER's (the route below) to make,
//     via a FRESH, same-request, successful crFetchGardssalgContent +
//     checkEmailField(...) === "ikke_funnet_på_siden" check. This function
//     only performs the guarded write once that judgment has already been
//     made; it trusts its caller completely on that point, so every caller
//     MUST have just proven genuine absence on a live page, never on a
//     cached/batched verdict (the exact ambiguity the module doc comment
//     above warns about).
//
// Guard order (first failing gate wins, no DB write on any of them) — SAME
// three guards applyGardssalgFieldConcordanceApproval runs, in the same
// order, plus one this function alone needs:
//   1. provider not found -> "not_found".
//   2. isGardssalgFieldOwnerLocked(row, "epost") -> "owner_locked" (mobil/
//      epost/telefon are never in GARDSSALG_OWNER_LOCK_ELIGIBLE_FIELDS, so
//      for content_source='claim' rows this always falls into that helper's
//      "any other fieldName -> always locked" branch, same as the approval
//      lever above).
//   3. gardssalgContactFieldWasRolledBack(providerId, "epost") ->
//      "rollback_vetoed" — same "an undo that un-undoes itself" gap the
//      approval lever's own guard closes (see its doc comment), equally
//      real here: a human who deliberately rolled epost back to a specific
//      (possibly non-blank) value must not have that decision silently
//      overwritten by an unrelated "the page doesn't show anything anymore"
//      clear.
//   4. the row's CURRENT epost (trimmed) is already blank/null ->
//      "already_blank" — nothing to clear, and nulling an already-NULL
//      column would still be a no-op write with a misleading audit row, so
//      this is refused before touching the DB rather than silently
//      succeeding at nothing.
//
// On success: read-modify-write field_provenance.epost (defensive JSON
// parse, malformed/missing -> {}, never clobbers other keys — same recipe as
// applyGardssalgFieldConcordanceApproval), UPDATE epost to NULL, and insert
// one gardssalg_content_audit row (old_value = the true pre-write trimmed
// epost value, new_value = NULL, source_url = evidenceUrl) — all inside one
// db.transaction. Returns `{written: true}` (no `reason`).
export function applyGardssalgFieldConcordanceClear(
  providerId: string,
  evidenceUrl: string,
  batchId?: string
): GfcApprovalResult {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT id, content_source, epost, field_provenance
         FROM experience_providers WHERE id = ?`
    )
    .get(providerId) as
    | {
        id: string;
        content_source: string | null;
        epost: string | null;
        field_provenance: string | null;
      }
    | undefined;
  if (!row) {
    return { provider_id: providerId, field_name: "epost", written: false, reason: "not_found" };
  }

  if (isGardssalgFieldOwnerLocked(row, "epost")) {
    return { provider_id: providerId, field_name: "epost", written: false, reason: "owner_locked" };
  }

  if (gardssalgContactFieldWasRolledBack(providerId, "epost")) {
    return { provider_id: providerId, field_name: "epost", written: false, reason: "rollback_vetoed" };
  }

  const currentValue = (row.epost || "").trim() || null;
  if (!currentValue) {
    return { provider_id: providerId, field_name: "epost", written: false, reason: "already_blank" };
  }

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
  provenance.epost = { source_url: evidenceUrl, fetched_at: new Date().toISOString() };

  const applyWithAudit = db.transaction(() => {
    db.prepare(
      `UPDATE experience_providers SET epost = NULL, field_provenance = @field_provenance, updated_at = datetime('now') WHERE id = @id`
    ).run({ id: providerId, field_provenance: JSON.stringify(provenance) });
    db.prepare(
      `INSERT INTO gardssalg_content_audit
         (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
       VALUES (@id, @provider_id, @field_name, @old_value, @new_value, @source_url, @batch_id, 'system', datetime('now'))`
    ).run({
      id: uuid(),
      provider_id: providerId,
      field_name: "epost",
      old_value: currentValue,
      new_value: null,
      source_url: evidenceUrl,
      batch_id: batchId ?? null,
    });
  });
  applyWithAudit();

  return { provider_id: providerId, field_name: "epost", written: true };
}

// ─── Gårdssalg rollback-veto override (2026-08-09, criterion 4 — closes the
// gap opened by applyGardssalgFieldConcordanceApproval's new rollback_vetoed
// guard above) ───────────────────────────────────────────────────────────────
// A rollback veto (gardssalgContactFieldWasRolledBack) is a deliberate,
// permanent-until-overridden human decision — correct as a default, but a
// human/orchestrator sometimes DOES want to let a field become writable again
// (e.g. the original rollback turns out to have been a mistake, or new
// evidence supersedes it). This is that lever: a single-item, explicitly
// justified override that changes ONLY eligibility, never the field's stored
// content — it must never be confused with (or substitute for) actually
// approving a new value, which still goes through
// applyGardssalgFieldConcordanceApproval's own guard chain afterwards.

export type GardssalgRollbackVetoOverrideResult = {
  provider_id: string;
  field_name: string;
  overridden: boolean;
  reason?: "invalid_field" | "justification_required" | "not_found" | "not_vetoed";
};

/**
 * Read-only precheck for applyGardssalgRollbackVetoOverride: computes and
 * returns the SAME result the apply path would, without ever writing to the
 * DB (backs the dry-run branch of POST /admin/gardssalg-rollback-veto-
 * override). Guard order mirrors the apply function exactly — see its doc
 * comment.
 */
export function planGardssalgRollbackVetoOverride(
  providerId: string,
  fieldName: string,
  justification: string
): GardssalgRollbackVetoOverrideResult {
  if (!GFC_APPROVAL_FIELDS.has(fieldName)) {
    return { provider_id: providerId, field_name: fieldName, overridden: false, reason: "invalid_field" };
  }

  const trimmedJustification = typeof justification === "string" ? justification.trim() : "";
  if (trimmedJustification === "") {
    return { provider_id: providerId, field_name: fieldName, overridden: false, reason: "justification_required" };
  }

  const db = getDb(VERTICAL);
  const row = db.prepare(`SELECT id FROM experience_providers WHERE id = ?`).get(providerId) as
    | { id: string }
    | undefined;
  if (!row) {
    return { provider_id: providerId, field_name: fieldName, overridden: false, reason: "not_found" };
  }

  if (!gardssalgContactFieldWasRolledBack(providerId, fieldName)) {
    return { provider_id: providerId, field_name: fieldName, overridden: false, reason: "not_vetoed" };
  }

  return { provider_id: providerId, field_name: fieldName, overridden: true };
}

/**
 * Deliberately override a live rollback veto (gardssalgContactFieldWasRolledBack)
 * for ONE (provider_id, fieldName) pair, so the field becomes writable again
 * by the normal fill-only / concordance-approval paths. `fieldName` is
 * validated against the SAME GFC_APPROVAL_FIELDS allow-list
 * applyGardssalgFieldConcordanceApproval uses (epost/telefon/mobil only) —
 * BEFORE any SQL, defense in depth, since fieldName can arrive from an admin
 * request body one hop up.
 *
 * Guard order (first failing gate wins):
 *   1. fieldName not in GFC_APPROVAL_FIELDS -> "invalid_field", no SQL at all.
 *   2. justification missing/blank (after .trim()) -> "justification_required",
 *      no write, and — unlike every other guard here — checked BEFORE the DB
 *      is ever queried for the provider at all: an override with no stated
 *      reason should never even reveal whether the provider/veto exist.
 *   3. provider not found -> "not_found".
 *   4. gardssalgContactFieldWasRolledBack(providerId, fieldName) is false ->
 *      "not_vetoed" — nothing to override, avoided as a no-op rather than
 *      silently "succeeding" at doing nothing.
 *
 * On success: inserts exactly ONE new gardssalg_content_audit row —
 * old_value AND new_value both set to the field's CURRENT stored value (this
 * lever changes eligibility only; it NEVER touches experience_providers, so
 * the field's content is byte-identical before and after), source_url the
 * new GARDSSALG_ROLLBACK_VETO_OVERRIDE_MARKER sentinel (distinct from
 * GARDSSALG_ROLLBACK_MARKER — see its own doc comment for why that
 * distinction is what actually lifts the veto), notes the trimmed
 * justification silently truncated to 1000 chars (mirrors the
 * gardssalg-booking-activation `note` truncation convention, except this
 * field is REQUIRED rather than optional), changed_by 'admin', batch_id
 * carried through if given. The table is insert-only — this NEVER
 * UPDATEs/DELETEs the pre-existing rollback-marker row or any other audit
 * row.
 */
export function applyGardssalgRollbackVetoOverride(
  providerId: string,
  fieldName: string,
  justification: string,
  batchId?: string
): GardssalgRollbackVetoOverrideResult {
  if (!GFC_APPROVAL_FIELDS.has(fieldName)) {
    return { provider_id: providerId, field_name: fieldName, overridden: false, reason: "invalid_field" };
  }

  const trimmedJustification = typeof justification === "string" ? justification.trim() : "";
  if (trimmedJustification === "") {
    return { provider_id: providerId, field_name: fieldName, overridden: false, reason: "justification_required" };
  }
  const notes = trimmedJustification.slice(0, 1000);

  const db = getDb(VERTICAL);
  const row = db.prepare(`SELECT id, ${fieldName} AS current_value FROM experience_providers WHERE id = ?`).get(
    providerId
  ) as { id: string; current_value: string | null } | undefined;
  if (!row) {
    return { provider_id: providerId, field_name: fieldName, overridden: false, reason: "not_found" };
  }

  if (!gardssalgContactFieldWasRolledBack(providerId, fieldName)) {
    return { provider_id: providerId, field_name: fieldName, overridden: false, reason: "not_vetoed" };
  }

  const currentValue = row.current_value ?? null;
  db.prepare(
    `INSERT INTO gardssalg_content_audit
       (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, notes, changed_at)
     VALUES (@id, @provider_id, @field_name, @old_value, @new_value, @source_url, @batch_id, 'admin', @notes, datetime('now'))`
  ).run({
    id: uuid(),
    provider_id: providerId,
    field_name: fieldName,
    old_value: currentValue,
    new_value: currentValue,
    source_url: GARDSSALG_ROLLBACK_VETO_OVERRIDE_MARKER,
    batch_id: batchId ?? null,
    notes,
  });

  return { provider_id: providerId, field_name: fieldName, overridden: true };
}

export type GardssalgFieldConcordanceReviewQueueEntry = {
  id: string;
  provider_id: string;
  provider_name: string | null;
  field_name: string;
  current_value: string | null;
  found_value: string | null;
  reason: string;
  batch_id: string | null;
  created_at: string;
  updated_at: string;
};

/** Lists all current gardssalg_field_concordance_review_queue entries,
 *  newest-updated first. Read-only, backs GET /admin/gardssalg-field-
 *  concordance-review-queue. Mirrors listGardssalgOrgnrReviewQueue's
 *  shape/typing style. */
export function listGardssalgFieldConcordanceReviewQueue(): GardssalgFieldConcordanceReviewQueueEntry[] {
  const db = getDb(VERTICAL);
  return db
    .prepare(`SELECT * FROM gardssalg_field_concordance_review_queue ORDER BY updated_at DESC`)
    .all() as GardssalgFieldConcordanceReviewQueueEntry[];
}

/** Removes ONE (provider_id, field_name) entry from
 *  gardssalg_field_concordance_review_queue. IMPORTANT: unlike
 *  clearGardssalgOrgnrReviewQueueEntry/clearGardssalgWebsiteReviewQueueEntry
 *  (both UNIQUE(provider_id) only), this table is UNIQUE(provider_id,
 *  field_name) — a single producer can have up to 3 independently-pending
 *  avvik rows (epost/telefon/mobil). The DELETE is scoped to BOTH columns so
 *  approving one field never wrongly deletes a different still-pending field
 *  for the same provider. Never throws if no row exists. */
export function clearGardssalgFieldConcordanceReviewQueueEntry(providerId: string, fieldName: string): void {
  const db = getDb(VERTICAL);
  db.prepare(`DELETE FROM gardssalg_field_concordance_review_queue WHERE provider_id = ? AND field_name = ?`).run(
    providerId,
    fieldName
  );
}
