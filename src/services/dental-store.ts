// ─── Dental Store — Phase 6 (PR-89) ─────────────────────────────────
//
// CRUD for the dental marketplace. ALL queries hit /data/dental.db
// via getDb('dental') — NEVER references the rfb `agents` table.
//
// Mirrors the conventions of src/services/knowledge-service.ts:
//   - uses better-sqlite3 prepared statements
//   - uuid for primary keys
//   - Zod for input validation
//   - JSON-array fields are stored as TEXT (SQLite convention)
//
// AMBULANT MODEL: createAffiliation + recomputeAvailableSpecialties
// keep dental_agents.available_specialties in sync with the
// authoritative source (dental_clinic_affiliations).

import { v4 as uuid } from "uuid";
import { z } from "zod";
import { getDb } from "../database/db-factory";
// dev-request 2026-07-12-dental-enrichment-universe-growth-and-queue-hygiene,
// slice 4a: reuse the same read-existing → merge → write field_provenance
// idiom already used by the generic PUT route (dental.ts) and the Places-
// backfill block, for Stage V's own corrections. Precedent for a service
// importing this helper from routes/admin-knowledge.ts already exists
// (src/services/search-enrich-sweep.ts) — no circular dependency (that file
// imports only express/db/utils, never dental-store).
import { mergeFieldProvenance } from "../routes/admin-knowledge";

// ─── Schemas (input validation) ─────────────────────────────────────

const HelfoAgreementSchema = z.enum(["true", "false", "unknown"]);
const VerificationStatusSchema = z.enum([
  "pending_verify",
  "verified",
  "needs_review",
  "rejected",
]);

export const DentalAgentSchema = z.object({
  id: z.string().optional(), // generated if absent
  org_nr: z.string().optional().nullable(),
  navn: z.string().min(1),
  postnummer: z.string().optional().nullable(),
  poststed: z.string().optional().nullable(),
  fylke: z.string().optional().nullable(),
  adresse: z.string().optional().nullable(),
  telefon: z.string().optional().nullable(),
  mobil: z.string().optional().nullable(),
  epost: z.string().email().optional().nullable(),
  hjemmeside: z.string().optional().nullable(),
  antall_ansatte: z.number().int().nonnegative().optional().nullable(),
  organisasjonsform: z.string().optional().nullable(),
  registreringsdato: z.string().optional().nullable(),
  naeringskode: z.string().optional().nullable(),
  treatments: z.array(z.string()).optional(),
  helfo_agreement: HelfoAgreementSchema.optional(),
  languages_spoken: z.array(z.string()).optional(),
  acute_vakt: z.union([z.literal(0), z.literal(1)]).optional().nullable(),
  price_band: z.string().optional().nullable(),
  chain_brand: z.string().optional().nullable(),
  is_chain_member: z.union([z.literal(0), z.literal(1)]).optional(),
  chain_parent_orgnr: z.string().optional().nullable(),
  available_specialties: z.array(z.string()).optional(),
  enrichment_state: z.string().optional(),
  verification_status: VerificationStatusSchema.optional(),

  // ─── PR-130: Google Places rating + price-band provenance ──────────
  rating: z.number().min(0).max(5).optional().nullable(),
  rating_count: z.number().int().nonnegative().optional().nullable(),
  rating_source: z.string().optional().nullable(),
  price_band_source: z.string().optional().nullable(),

  // ─── PR-100: geocoding fields (6) ──────────────────────────────────
  lat: z.number().min(-90).max(90).optional().nullable(),
  lng: z.number().min(-180).max(180).optional().nullable(),
  geocode_source: z.enum(["kartverket", "google_places", "manual"]).optional().nullable(),
  geocode_confidence: z.enum(["high", "medium", "low", "no_match"]).optional().nullable(),
  opening_hours: z
    .array(
      z.object({
        day: z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
        open: z.string().regex(/^\d{2}:\d{2}$/),
        close: z.string().regex(/^\d{2}:\d{2}$/),
      })
    )
    .optional()
    .nullable(),
  field_provenance: z.record(z.string(), z.unknown()).optional().nullable(),

  // ─── PR-100: deep-scrape fields (10) ───────────────────────────────
  om_oss: z.string().max(2000).optional().nullable(),
  specialists: z
    .array(
      z.object({
        name: z.string(),
        title: z.string().optional(),
        specialty: z.string().optional(),
      })
    )
    .optional()
    .nullable(),
  treatment_tech: z
    .array(
      z.enum([
        "intraoral_camera",
        "3d_scanner",
        "laser",
        "cad_cam",
        "panorama_xray",
        "cbct",
        "sedation",
        "microscope",
      ])
    )
    .optional()
    .nullable(),
  equipment_brands: z.record(z.string(), z.array(z.string())).optional().nullable(),
  patient_focus: z.array(z.string()).optional().nullable(),
  accessibility: z.array(z.string()).optional().nullable(),
  payment_options: z.array(z.string()).optional().nullable(),
  online_booking_url: z.string().url().optional().nullable(),
  social_media: z
    .object({
      facebook: z.string().url().optional().nullable(),
      instagram: z.string().url().optional().nullable(),
      linkedin: z.string().url().optional().nullable(),
    })
    .optional()
    .nullable(),
  treatments_subtypes: z.record(z.string(), z.array(z.string())).optional().nullable(),
});
export type DentalAgent = z.infer<typeof DentalAgentSchema>;

export const DentalPersonSchema = z.object({
  id: z.string().optional(),
  navn: z.string().min(1),
  hpr_nr: z.string().optional().nullable(),
  primary_specialty: z.string().optional().nullable(),
  all_specialties: z.array(z.string()).optional(),
  own_orgnr: z.string().optional().nullable(),
  fylke_residence: z.string().optional().nullable(),
  is_active: z.union([z.literal(0), z.literal(1)]).optional(),
  source: z.string().optional().nullable(),
});
export type DentalPerson = z.infer<typeof DentalPersonSchema>;

export const AffiliationSchema = z.object({
  person_id: z.string().min(1),
  clinic_agent_id: z.string().min(1),
  affiliation_type: z.string().optional().nullable(),
  role: z.string().optional().nullable(),
  specialty_used_here: z.string().optional().nullable(),
  schedule_pattern: z.string().optional().nullable(),
  is_active: z.union([z.literal(0), z.literal(1)]).optional(),
  source: z.string().optional().nullable(),
  evidence_url: z.string().optional().nullable(),
});
export type Affiliation = z.infer<typeof AffiliationSchema>;

export const ListFilterSchema = z.object({
  fylke: z.string().optional(),
  chain_brand: z.string().optional(),
  specialty: z.string().optional(),
  verification_status: VerificationStatusSchema.optional(),
  // PR-109 additive fields (also implements pending PR-105 spec)
  q: z.string().optional(),                                       // free-text: name OR poststed LIKE
  helfo_agreement: z.enum(["true", "false", "unknown"]).optional(),
  acute_vakt: z.union([z.literal(0), z.literal(1)]).optional(),
  // PR-120: thin_site added as a valid enrichment_state filter value.
  enrichment_state: z.enum(["raw", "enriched", "thin_site"]).optional(),
  // PR-116: bysidesfilter
  poststed: z.string().optional(),
});
export type ListFilter = z.infer<typeof ListFilterSchema>;

// Loose schema for bulk-merged rows (Phase A.5 step 2). The merge
// script produces a wider object than DentalAgentSchema; we accept
// any superset and only persist the columns we recognise.
export type MergedRow = Partial<DentalAgent> & {
  navn: string;
  org_nr?: string | null;
};

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

// PR-100: parse arbitrary JSON column (object or array). Returns null
// on missing / invalid input so the hydrated DentalAgent stays
// well-typed. Used by all new JSON columns (specialists, opening_hours,
// equipment_brands, social_media, field_provenance, treatments_subtypes,
// treatment_tech, patient_focus, accessibility, payment_options).
function parseJsonOrNull(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// PR-100: stringify a JS value for the JSON-typed columns above. null /
// undefined → null (do NOT stringify "null" into the column).
function stringifyJsonOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

// Hydrate raw SQLite row into a typed DentalAgent (parses JSON cols).
function hydrateAgent(row: Record<string, unknown>): DentalAgent & {
  id: string;
} {
  return {
    id: row.id as string,
    org_nr: (row.org_nr as string | null) ?? null,
    navn: row.navn as string,
    postnummer: (row.postnummer as string | null) ?? null,
    poststed: (row.poststed as string | null) ?? null,
    fylke: (row.fylke as string | null) ?? null,
    adresse: (row.adresse as string | null) ?? null,
    telefon: (row.telefon as string | null) ?? null,
    mobil: (row.mobil as string | null) ?? null,
    epost: (row.epost as string | null) ?? null,
    hjemmeside: (row.hjemmeside as string | null) ?? null,
    antall_ansatte: (row.antall_ansatte as number | null) ?? null,
    organisasjonsform: (row.organisasjonsform as string | null) ?? null,
    registreringsdato: (row.registreringsdato as string | null) ?? null,
    naeringskode: (row.naeringskode as string | null) ?? null,
    treatments: parseJsonArray(row.treatments),
    helfo_agreement:
      (row.helfo_agreement as DentalAgent["helfo_agreement"]) ?? undefined,
    languages_spoken: parseJsonArray(row.languages_spoken),
    acute_vakt: (row.acute_vakt as 0 | 1 | null) ?? null,
    price_band: (row.price_band as string | null) ?? null,
    chain_brand: (row.chain_brand as string | null) ?? null,
    is_chain_member: (row.is_chain_member as 0 | 1) ?? 0,
    chain_parent_orgnr: (row.chain_parent_orgnr as string | null) ?? null,
    available_specialties: parseJsonArray(row.available_specialties),
    enrichment_state: (row.enrichment_state as string) ?? "raw",
    verification_status:
      (row.verification_status as DentalAgent["verification_status"]) ??
      "pending_verify",

    // ─── PR-130: rating + price-band provenance ─────────────────────
    rating: (row.rating as number | null) ?? null,
    rating_count: (row.rating_count as number | null) ?? null,
    rating_source: (row.rating_source as string | null) ?? null,
    price_band_source: (row.price_band_source as string | null) ?? null,

    // ─── PR-100: geocoding fields ────────────────────────────────────
    lat: (row.lat as number | null) ?? null,
    lng: (row.lng as number | null) ?? null,
    geocode_source:
      (row.geocode_source as DentalAgent["geocode_source"]) ?? null,
    geocode_confidence:
      (row.geocode_confidence as DentalAgent["geocode_confidence"]) ?? null,
    opening_hours: parseJsonOrNull(row.opening_hours) as DentalAgent["opening_hours"],
    field_provenance: parseJsonOrNull(row.field_provenance) as DentalAgent["field_provenance"],

    // ─── PR-100: deep-scrape fields ──────────────────────────────────
    om_oss: (row.om_oss as string | null) ?? null,
    specialists: parseJsonOrNull(row.specialists) as DentalAgent["specialists"],
    treatment_tech: parseJsonOrNull(row.treatment_tech) as DentalAgent["treatment_tech"],
    equipment_brands: parseJsonOrNull(row.equipment_brands) as DentalAgent["equipment_brands"],
    patient_focus: parseJsonOrNull(row.patient_focus) as DentalAgent["patient_focus"],
    accessibility: parseJsonOrNull(row.accessibility) as DentalAgent["accessibility"],
    payment_options: parseJsonOrNull(row.payment_options) as DentalAgent["payment_options"],
    online_booking_url: (row.online_booking_url as string | null) ?? null,
    social_media: parseJsonOrNull(row.social_media) as DentalAgent["social_media"],
    treatments_subtypes: parseJsonOrNull(row.treatments_subtypes) as DentalAgent["treatments_subtypes"],
  };
}

// ─── Public API ─────────────────────────────────────────────────────

export function createDentalAgent(input: DentalAgent): string {
  const parsed = DentalAgentSchema.parse(input);

  // EXCLUSION CHECK (PR-90): refuse insert if org_nr or hjemmeside
  // is on the anti-rediscovery list. Prevents Brreg/discovery from
  // re-inserting records we've already determined are not clinics.
  const excl = isExcluded(parsed.org_nr ?? null, parsed.hjemmeside ?? null);
  if (excl.excluded) {
    throw new Error(`Refused: agent is excluded (reason=${excl.reason})`);
  }

  const id = parsed.id ?? uuid();
  const db = getDb("dental");

  db.prepare(
    `
    INSERT INTO dental_agents (
      id, org_nr, navn,
      postnummer, poststed, fylke, adresse,
      telefon, mobil, epost, hjemmeside,
      antall_ansatte, organisasjonsform, registreringsdato, naeringskode,
      treatments, helfo_agreement, languages_spoken, acute_vakt, price_band,
      chain_brand, is_chain_member, chain_parent_orgnr,
      available_specialties,
      enrichment_state, verification_status
    ) VALUES (
      @id, @org_nr, @navn,
      @postnummer, @poststed, @fylke, @adresse,
      @telefon, @mobil, @epost, @hjemmeside,
      @antall_ansatte, @organisasjonsform, @registreringsdato, @naeringskode,
      @treatments, @helfo_agreement, @languages_spoken, @acute_vakt, @price_band,
      @chain_brand, @is_chain_member, @chain_parent_orgnr,
      @available_specialties,
      @enrichment_state, @verification_status
    )
  `
  ).run({
    id,
    org_nr: parsed.org_nr ?? null,
    navn: parsed.navn,
    postnummer: parsed.postnummer ?? null,
    poststed: parsed.poststed ?? null,
    fylke: parsed.fylke ?? null,
    adresse: parsed.adresse ?? null,
    telefon: parsed.telefon ?? null,
    mobil: parsed.mobil ?? null,
    epost: parsed.epost ?? null,
    hjemmeside: parsed.hjemmeside ?? null,
    antall_ansatte: parsed.antall_ansatte ?? null,
    organisasjonsform: parsed.organisasjonsform ?? null,
    registreringsdato: parsed.registreringsdato ?? null,
    naeringskode: parsed.naeringskode ?? null,
    treatments: jsonOrNull(parsed.treatments),
    helfo_agreement: parsed.helfo_agreement ?? "unknown",
    languages_spoken: jsonOrNull(parsed.languages_spoken),
    acute_vakt: parsed.acute_vakt ?? null,
    price_band: parsed.price_band ?? null,
    chain_brand: parsed.chain_brand ?? null,
    is_chain_member: parsed.is_chain_member ?? 0,
    chain_parent_orgnr: parsed.chain_parent_orgnr ?? null,
    available_specialties: jsonOrNull(parsed.available_specialties),
    enrichment_state: parsed.enrichment_state ?? "raw",
    verification_status: parsed.verification_status ?? "pending_verify",
  });

  return id;
}

export function getDentalAgentByOrgnr(
  orgnr: string
): (DentalAgent & { id: string }) | null {
  const db = getDb("dental");
  const row = db
    .prepare("SELECT * FROM dental_agents WHERE org_nr = ?")
    .get(orgnr) as Record<string, unknown> | undefined;
  return row ? hydrateAgent(row) : null;
}

export function getDentalAgentById(
  id: string
): (DentalAgent & { id: string }) | null {
  const db = getDb("dental");
  const row = db
    .prepare("SELECT * FROM dental_agents WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? hydrateAgent(row) : null;
}

// ─── Specialty filter helper (PR: finn-tannlege search) ─────────────
// Specialty data is sparse on dental_agents.available_specialties (the
// clinic-level JSON array is populated for only ~2% of rows). The same
// information frequently lives in the `specialists` JSON array
// (objects with a "specialty" field) that PR-100 deep-scrape fills.
// To make the specialty filter useful instead of zeroing-out results,
// match the requested specialty against EITHER column. Both columns are
// JSON-array text, so a LIKE on the quoted specialty value is the
// pragmatic match (json_each() would be exact but heavier; revisit if
// false-positives appear). Returns a SQL fragment + binds the params.
function pushSpecialtyClause(
  where: string[],
  params: Record<string, unknown>,
  specialty: string
): void {
  where.push(
    "(available_specialties LIKE @specialty OR specialists LIKE @specialtyPerson)"
  );
  // available_specialties: ["oral kirurgi og oral medisin"]  → match %"<value>"%
  params.specialty = `%"${specialty}"%`;
  // specialists: [{"name":"...","specialty":"oral kirurgi og oral medisin"}]
  //   → match %"specialty":"<value>"%  (tolerant of whitespace via the
  //   colon-space variant; JSON.stringify emits no space, so this is exact).
  params.specialtyPerson = `%"specialty":"${specialty}"%`;
}

// ── Dead-homepage parking (enrichment-metode slice 1, 2026-07-16) ────────────
// Mirrors the RFB PR #248 semantics: 3 consecutive fetch failures park the
// clinic (homepage_unreachable_since stamped) for 30 days; a successful fetch
// fully resets. RE-STAMP on failure after an expired backoff — without it a
// stale timestamp keeps satisfying the `<= now-30d` exclusion forever (PR #248
// review blocker, inherited here). The dental enrichment ROUTINE fetches
// homepages itself (unlike the server-fetching experiences/RFB endpoints), so
// it REPORTS outcomes via POST /admin/homepage-fetch-result; the server owns
// the strike counting + parking. DENTAL_HOMEPAGE_PARKING_DISABLED=true bypasses
// the list exclusion (rollback flag, read per query).
export const DENTAL_PARK_AFTER_ATTEMPTS = 3;
export const DENTAL_PARK_BACKOFF_MS = 30 * 86_400_000;

export function recordDentalHomepageFetchResult(
  id: string,
  ok: boolean,
): { found: boolean; attempts: number; parked: boolean; parked_now: boolean } {
  const db = getDb("dental");
  const exists = db.prepare("SELECT id FROM dental_agents WHERE id = ?").get(id);
  if (!exists) return { found: false, attempts: 0, parked: false, parked_now: false };

  if (ok) {
    db.prepare(
      "UPDATE dental_agents SET homepage_fetch_attempts = 0, homepage_unreachable_since = NULL WHERE id = ?"
    ).run(id);
    return { found: true, attempts: 0, parked: false, parked_now: false };
  }

  db.prepare(
    "UPDATE dental_agents SET homepage_fetch_attempts = homepage_fetch_attempts + 1 WHERE id = ?"
  ).run(id);
  const row = db
    .prepare("SELECT homepage_fetch_attempts, homepage_unreachable_since FROM dental_agents WHERE id = ?")
    .get(id) as { homepage_fetch_attempts: number; homepage_unreachable_since: string | null };

  let parkedNow = false;
  if (row.homepage_fetch_attempts >= DENTAL_PARK_AFTER_ATTEMPTS) {
    const since = row.homepage_unreachable_since;
    const expired = since !== null && Date.parse(since) <= Date.now() - DENTAL_PARK_BACKOFF_MS;
    if (!since || expired) {
      db.prepare("UPDATE dental_agents SET homepage_unreachable_since = ? WHERE id = ?")
        .run(new Date().toISOString(), id);
      parkedNow = true;
    }
  }
  const parked = row.homepage_fetch_attempts >= DENTAL_PARK_AFTER_ATTEMPTS;
  return { found: true, attempts: row.homepage_fetch_attempts, parked, parked_now: parkedNow };
}

// ── Dead-extraction parking (dev-request 2026-07-12-dental-enrichment-
// universe-growth-and-queue-hygiene, item 2a, 2026-07-17) ────────────────────
// Mirrors recordDentalHomepageFetchResult() immediately above, applied to
// extraction/enrichment failures instead of homepage-fetch failures: the
// daily claim-batch worker was repeatedly re-claiming dead records (thin
// directory-listing sites, non-clinic entities) because there was no
// attempts-counter/parking mechanism for extraction failures — only for the
// homepage-backfill case above. Same semantics, reusing the same shared
// DENTAL_PARK_AFTER_ATTEMPTS / DENTAL_PARK_BACKOFF_MS tuning constants: 3
// consecutive failures park (extraction_unreachable_since stamped) for 30
// days, success fully resets both columns. RE-STAMP on failure after an
// expired backoff (same PR #248 review-blocker fix inherited by the
// homepage twin) — without it a stale timestamp would keep satisfying the
// `<= now-30d` exclusion forever. `reason` is accepted for observability
// (logged on failure) but is not persisted — there is no reason column on
// dental_agents for this slice. The claim-pool exclusion this feeds is
// dental-claim-service.ts's buildWhereClause() `excludeParkedExtraction`
// option (opt-in), not listDentalAgents/excludeParked — extraction parking
// only ever needs to keep dead rows out of the CLAIM pool, not the public
// read-side listing.
export function recordDentalExtractionResult(
  id: string,
  ok: boolean,
  reason?: string,
): { found: boolean; attempts: number; parked: boolean; parked_now: boolean } {
  const db = getDb("dental");
  const exists = db.prepare("SELECT id FROM dental_agents WHERE id = ?").get(id);
  if (!exists) return { found: false, attempts: 0, parked: false, parked_now: false };

  if (ok) {
    db.prepare(
      "UPDATE dental_agents SET extraction_attempts = 0, extraction_unreachable_since = NULL WHERE id = ?"
    ).run(id);
    return { found: true, attempts: 0, parked: false, parked_now: false };
  }

  db.prepare(
    "UPDATE dental_agents SET extraction_attempts = extraction_attempts + 1 WHERE id = ?"
  ).run(id);
  const row = db
    .prepare("SELECT extraction_attempts, extraction_unreachable_since FROM dental_agents WHERE id = ?")
    .get(id) as { extraction_attempts: number; extraction_unreachable_since: string | null };

  let parkedNow = false;
  if (row.extraction_attempts >= DENTAL_PARK_AFTER_ATTEMPTS) {
    const since = row.extraction_unreachable_since;
    const expired = since !== null && Date.parse(since) <= Date.now() - DENTAL_PARK_BACKOFF_MS;
    if (!since || expired) {
      db.prepare("UPDATE dental_agents SET extraction_unreachable_since = ? WHERE id = ?")
        .run(new Date().toISOString(), id);
      parkedNow = true;
    }
  }
  const parked = row.extraction_attempts >= DENTAL_PARK_AFTER_ATTEMPTS;
  if (reason) {
    console.log(`[dental] extraction failure for ${id}: ${reason}`);
  }
  return { found: true, attempts: row.extraction_attempts, parked, parked_now: parkedNow };
}

// ── Stage V helfo_agreement auto-correction (dev-request 2026-07-12-dental-
// enrichment-universe-growth-and-queue-hygiene, item 4 / slice 4a, 2026-07-20)
// ─────────────────────────────────────────────────────────────────────────
// Mirrors recordDentalHomepageFetchResult()/recordDentalExtractionResult()
// above: read row, branch, write, return an outcome object. Stage V (the
// enrichment routine's §5 sample-verify) re-fetches a small sample of
// clinics each cycle and checks the site's helfo-signal against the DB
// value; today it can only flag a mismatch ("drift" → needs_review), never
// correct it. This function is the correction path for non-Brreg fields:
// a SINGLE contradicting observation is parked (not yet trusted — could be
// a stale/transient site glitch); only when the SAME contradicting value is
// confirmed TWICE IN A ROW does it auto-correct the DB and record
// provenance. This NEVER touches verification_status — the existing §5.3
// drift→needs_review rule is completely unchanged, orthogonal side-channel.
//
// `field` is restricted to "helfo_agreement" this slice (item 4b —
// treatments/opening_hours — is future work); the caller (the route below)
// validates this before calling, so this function trusts its `field`
// argument the same way recordDentalExtractionResult trusts `reason` being
// pre-validated by its caller.
export function recordStageVFieldObservation(
  id: string,
  field: "helfo_agreement",
  observedValue: string,
):
  | { found: false }
  | { found: true; corrected: false; cleared: true }
  | { found: true; corrected: false; pending: true }
  | { found: true; corrected: true; previous_value: string | null; new_value: string } {
  const db = getDb("dental");
  const row = db
    .prepare(
      "SELECT helfo_agreement, field_provenance, stage_v_pending_correction FROM dental_agents WHERE id = ?"
    )
    .get(id) as
    | {
        helfo_agreement: string | null;
        field_provenance: string | null;
        stage_v_pending_correction: string | null;
      }
    | undefined;
  if (!row) return { found: false };

  // Tolerant parse — junk/missing JSON is treated as an empty pending map,
  // mirroring the tolerant-parse idiom used for field_provenance elsewhere
  // in this file/dental.ts (never throw on a malformed side-channel column).
  let pendingMap: Record<string, { value: string; observed_at: string }> = {};
  if (row.stage_v_pending_correction) {
    try {
      const parsed = JSON.parse(row.stage_v_pending_correction);
      if (parsed && typeof parsed === "object") {
        pendingMap = parsed as Record<string, { value: string; observed_at: string }>;
      }
    } catch {
      /* tolerate junk — treat as empty */
    }
  }

  const writePendingMap = (map: Record<string, { value: string; observed_at: string }>) => {
    const hasAny = Object.keys(map).length > 0;
    db.prepare("UPDATE dental_agents SET stage_v_pending_correction = ? WHERE id = ?").run(
      hasAny ? JSON.stringify(map) : null,
      id
    );
  };

  // Site now agrees with the DB — any stale pending disagreement for this
  // field was transient. Clear it so a FUTURE contradiction needs 2 fresh
  // confirmations again, not 1.
  if (observedValue === row.helfo_agreement) {
    if (field in pendingMap) {
      delete pendingMap[field];
      writePendingMap(pendingMap);
    }
    return { found: true, corrected: false, cleared: true };
  }

  const pendingEntry = pendingMap[field];
  if (pendingEntry && pendingEntry.value === observedValue) {
    // SAME contradicting value seen twice in a row → auto-correct.
    const previousValue = row.helfo_agreement;

    let existingProv: Record<string, unknown> = {};
    if (row.field_provenance) {
      try {
        const parsed = JSON.parse(row.field_provenance);
        if (parsed && typeof parsed === "object") existingProv = parsed as Record<string, unknown>;
      } catch {
        /* tolerate junk */
      }
    }
    const mergedProv = mergeFieldProvenance(existingProv, {
      [field]: {
        sources: [
          {
            source_type: "stage_v_correction",
            value: observedValue,
            fetched_at: new Date().toISOString(),
          },
        ],
      },
    });

    delete pendingMap[field];
    db.prepare(
      "UPDATE dental_agents SET helfo_agreement = ?, field_provenance = ?, stage_v_pending_correction = ? WHERE id = ?"
    ).run(
      observedValue,
      JSON.stringify(mergedProv),
      Object.keys(pendingMap).length ? JSON.stringify(pendingMap) : null,
      id
    );

    return { found: true, corrected: true, previous_value: previousValue, new_value: observedValue };
  }

  // First observation of this contradicting value, or a different value than
  // whatever was pending — (re)start the 2-confirmation window.
  pendingMap[field] = { value: observedValue, observed_at: new Date().toISOString() };
  writePendingMap(pendingMap);
  return { found: true, corrected: false, pending: true };
}

export function listDentalAgents(
  filter: ListFilter = {},
  limit = 50,
  offset = 0,
  // enrichment-metode slice 1: opt-in exclusion of parked clinics so the
  // enrichment routine's candidate listing skips dead homepages for 30d.
  // Opt-in (4th param → route's ?exclude_parked=1) so existing consumers are
  // byte-for-byte unchanged.
  opts: { excludeParked?: boolean } = {}
): Array<DentalAgent & { id: string }> {
  const parsed = ListFilterSchema.parse(filter);
  const db = getDb("dental");

  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (opts.excludeParked && process.env.DENTAL_HOMEPAGE_PARKING_DISABLED !== "true") {
    where.push("(homepage_unreachable_since IS NULL OR homepage_unreachable_since <= datetime('now','-30 days'))");
  }

  if (parsed.fylke) {
    where.push("fylke = @fylke");
    params.fylke = parsed.fylke;
  }
  if (parsed.chain_brand) {
    where.push("chain_brand = @chain_brand");
    params.chain_brand = parsed.chain_brand;
  }
  if (parsed.verification_status) {
    where.push("verification_status = @verification_status");
    params.verification_status = parsed.verification_status;
  }
  if (parsed.specialty) {
    pushSpecialtyClause(where, params, parsed.specialty);
  }
  // PR-109 / PR-105 additive filters
  if (parsed.q) {
    where.push("(navn LIKE @q OR poststed LIKE @q)");
    params.q = `%${parsed.q}%`;
  }
  if (parsed.helfo_agreement !== undefined) {
    where.push("helfo_agreement = @helfo_agreement");
    params.helfo_agreement = parsed.helfo_agreement;
  }
  if (parsed.acute_vakt !== undefined) {
    where.push("acute_vakt = @acute_vakt");
    params.acute_vakt = parsed.acute_vakt;
  }
  if (parsed.enrichment_state !== undefined) {
    where.push("enrichment_state = @enrichment_state");
    params.enrichment_state = parsed.enrichment_state;
  }
  if (parsed.poststed) { where.push("poststed = @poststed"); params.poststed = parsed.poststed; }

  const sql =
    "SELECT * FROM dental_agents" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY navn ASC LIMIT @limit OFFSET @offset";

  params.limit = Math.max(1, Math.min(500, limit));
  params.offset = Math.max(0, offset);

  const rows = db.prepare(sql).all(params) as Array<Record<string, unknown>>;
  return rows.map(hydrateAgent);
}

// ─── PR-109: new public query functions ─────────────────────────────

/** COUNT(*) with the same WHERE building as listDentalAgents. */
export function countDentalAgents(filter: ListFilter = {}): number {
  const parsed = ListFilterSchema.parse(filter);
  const db = getDb("dental");

  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (parsed.fylke) { where.push("fylke = @fylke"); params.fylke = parsed.fylke; }
  if (parsed.chain_brand) { where.push("chain_brand = @chain_brand"); params.chain_brand = parsed.chain_brand; }
  if (parsed.verification_status) { where.push("verification_status = @verification_status"); params.verification_status = parsed.verification_status; }
  if (parsed.specialty) { pushSpecialtyClause(where, params, parsed.specialty); }
  if (parsed.q) { where.push("(navn LIKE @q OR poststed LIKE @q)"); params.q = `%${parsed.q}%`; }
  if (parsed.helfo_agreement !== undefined) { where.push("helfo_agreement = @helfo_agreement"); params.helfo_agreement = parsed.helfo_agreement; }
  if (parsed.acute_vakt !== undefined) { where.push("acute_vakt = @acute_vakt"); params.acute_vakt = parsed.acute_vakt; }
  if (parsed.enrichment_state !== undefined) { where.push("enrichment_state = @enrichment_state"); params.enrichment_state = parsed.enrichment_state; }

  const sql = "SELECT COUNT(*) AS n FROM dental_agents" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "");
  const row = db.prepare(sql).get(params) as { n: number };
  return row.n;
}

/**
 * Like countDentalAgents but always excludes verification_status='rejected'.
 * Used by public-facing pages (/sok, /fylke) where rejected clinics
 * must not appear in the total count shown to visitors.
 */
export function countPublicDentalAgents(filter: ListFilter = {}): number {
  const parsed = ListFilterSchema.parse(filter);
  const db = getDb("dental");

  const where: string[] = ["verification_status != 'rejected'"];
  const params: Record<string, unknown> = {};

  if (parsed.fylke) { where.push("fylke = @fylke"); params.fylke = parsed.fylke; }
  if (parsed.chain_brand) { where.push("chain_brand = @chain_brand"); params.chain_brand = parsed.chain_brand; }
  if (parsed.verification_status && parsed.verification_status !== "rejected") {
    where.push("verification_status = @verification_status");
    params.verification_status = parsed.verification_status;
  }
  if (parsed.specialty) { pushSpecialtyClause(where, params, parsed.specialty); }
  if (parsed.q) { where.push("(navn LIKE @q OR poststed LIKE @q)"); params.q = `%${parsed.q}%`; }
  if (parsed.helfo_agreement !== undefined) { where.push("helfo_agreement = @helfo_agreement"); params.helfo_agreement = parsed.helfo_agreement; }
  if (parsed.acute_vakt !== undefined) { where.push("acute_vakt = @acute_vakt"); params.acute_vakt = parsed.acute_vakt; }
  if (parsed.enrichment_state !== undefined) { where.push("enrichment_state = @enrichment_state"); params.enrichment_state = parsed.enrichment_state; }
  if (parsed.poststed) { where.push("poststed = @poststed"); params.poststed = parsed.poststed; }

  const sql = "SELECT COUNT(*) AS n FROM dental_agents" +
    ` WHERE ${where.join(" AND ")}`;
  const row = db.prepare(sql).get(params) as { n: number };
  return row.n;
}

/**
 * Public-facing list: same WHERE building as listDentalAgents but
 * ALWAYS excludes verification_status='rejected', and applies a
 * quality-first sort: verified first, then enriched, then those with
 * website or phone, then alphabetically.
 */
export function listPublicDentalAgents(
  filter: ListFilter = {},
  limit = 50,
  offset = 0
): Array<DentalAgent & { id: string }> {
  const parsed = ListFilterSchema.parse(filter);
  const db = getDb("dental");

  const where: string[] = ["verification_status != 'rejected'"]; // always exclude rejected
  const params: Record<string, unknown> = {};

  if (parsed.fylke) { where.push("fylke = @fylke"); params.fylke = parsed.fylke; }
  if (parsed.chain_brand) { where.push("chain_brand = @chain_brand"); params.chain_brand = parsed.chain_brand; }
  if (parsed.verification_status && parsed.verification_status !== "rejected") {
    where.push("verification_status = @verification_status");
    params.verification_status = parsed.verification_status;
  }
  if (parsed.specialty) { pushSpecialtyClause(where, params, parsed.specialty); }
  if (parsed.q) { where.push("(navn LIKE @q OR poststed LIKE @q)"); params.q = `%${parsed.q}%`; }
  if (parsed.helfo_agreement !== undefined) { where.push("helfo_agreement = @helfo_agreement"); params.helfo_agreement = parsed.helfo_agreement; }
  if (parsed.acute_vakt !== undefined) { where.push("acute_vakt = @acute_vakt"); params.acute_vakt = parsed.acute_vakt; }
  if (parsed.enrichment_state !== undefined) { where.push("enrichment_state = @enrichment_state"); params.enrichment_state = parsed.enrichment_state; }
  if (parsed.poststed) { where.push("poststed = @poststed"); params.poststed = parsed.poststed; }

  const sql =
    "SELECT * FROM dental_agents" +
    ` WHERE ${where.join(" AND ")}` +
    " ORDER BY" +
    "  CASE verification_status WHEN 'verified' THEN 0 ELSE 1 END ASC," +
    "  CASE enrichment_state WHEN 'enriched' THEN 0 ELSE 1 END ASC," +
    "  CASE WHEN hjemmeside IS NOT NULL OR telefon IS NOT NULL THEN 0 ELSE 1 END ASC," +
    "  navn ASC" +
    " LIMIT @limit OFFSET @offset";

  params.limit = Math.max(1, Math.min(500, limit));
  params.offset = Math.max(0, offset);

  const rows = db.prepare(sql).all(params) as Array<Record<string, unknown>>;
  return rows.map(hydrateAgent);
}

/**
 * Returns the subset of `candidates` (canonical specialty names) for which
 * at least one non-rejected clinic exists — matching the SAME logic the
 * /sok specialty filter uses (available_specialties OR specialists JSON).
 *
 * The public search dropdown is populated from this so users can only pick
 * specialties that actually return clinics; a specialty with zero coverage
 * is hidden rather than silently zeroing-out the result list.
 */
export function getAvailableSpecialties(candidates: string[]): string[] {
  const db = getDb("dental");
  const stmt = db.prepare(
    `SELECT 1 FROM dental_agents
     WHERE verification_status != 'rejected'
       AND (available_specialties LIKE @s OR specialists LIKE @p)
     LIMIT 1`
  );
  return candidates.filter((name) => {
    const row = stmt.get({ s: `%"${name}"%`, p: `%"specialty":"${name}"%` });
    return !!row;
  });
}

export interface DentalStats {
  total: number;
  per_fylke: Array<{ fylke: string; count: number }>;
  helfo_count: number;
  chain_count: number;
  acute_count: number;
  specialist_clinic_count: number;
}

/** Aggregate stats for the finn-tannlege.com frontpage. Excludes rejected rows. */
export function getDentalStats(): DentalStats {
  const db = getDb("dental");
  const base = "FROM dental_agents WHERE verification_status != 'rejected'";

  const total = (db.prepare(`SELECT COUNT(*) AS n ${base}`).get() as { n: number }).n;

  const perFylkeRows = db.prepare(
    `SELECT fylke, COUNT(*) AS n ${base} AND fylke IS NOT NULL GROUP BY fylke ORDER BY n DESC`
  ).all() as Array<{ fylke: string; n: number }>;
  const per_fylke = perFylkeRows.map((r) => ({ fylke: r.fylke, count: r.n }));

  const helfo_count = (db.prepare(
    `SELECT COUNT(*) AS n ${base} AND helfo_agreement = 'true'`
  ).get() as { n: number }).n;

  const chain_count = (db.prepare(
    `SELECT COUNT(*) AS n ${base} AND is_chain_member = 1`
  ).get() as { n: number }).n;

  const acute_count = (db.prepare(
    `SELECT COUNT(*) AS n ${base} AND acute_vakt = 1`
  ).get() as { n: number }).n;

  // specialist_clinic_count: clinics whose specialists OR available_specialties
  // is a non-empty JSON array.
  const specialist_clinic_count = (db.prepare(
    `SELECT COUNT(*) AS n ${base} AND (
       (specialists IS NOT NULL AND specialists != '[]' AND specialists != '') OR
       (available_specialties IS NOT NULL AND available_specialties != '[]' AND available_specialties != '')
     )`
  ).get() as { n: number }).n;

  return { total, per_fylke, helfo_count, chain_count, acute_count, specialist_clinic_count };
}


export function upsertDentalPerson(input: DentalPerson): string {
  const parsed = DentalPersonSchema.parse(input);
  const db = getDb("dental");

  // Try to find by hpr_nr first (unique), then by id.
  let existing: { id: string } | undefined;
  if (parsed.hpr_nr) {
    existing = db
      .prepare("SELECT id FROM dental_persons WHERE hpr_nr = ?")
      .get(parsed.hpr_nr) as { id: string } | undefined;
  } else if (parsed.id) {
    existing = db
      .prepare("SELECT id FROM dental_persons WHERE id = ?")
      .get(parsed.id) as { id: string } | undefined;
  }

  const id = existing?.id ?? parsed.id ?? uuid();

  if (existing) {
    db.prepare(
      `
      UPDATE dental_persons SET
        navn = @navn,
        primary_specialty = @primary_specialty,
        all_specialties = @all_specialties,
        own_orgnr = @own_orgnr,
        fylke_residence = @fylke_residence,
        is_active = @is_active,
        source = @source,
        updated_at = datetime('now')
      WHERE id = @id
    `
    ).run({
      id,
      navn: parsed.navn,
      primary_specialty: parsed.primary_specialty ?? null,
      all_specialties: jsonOrNull(parsed.all_specialties),
      own_orgnr: parsed.own_orgnr ?? null,
      fylke_residence: parsed.fylke_residence ?? null,
      is_active: parsed.is_active ?? 1,
      source: parsed.source ?? null,
    });
  } else {
    db.prepare(
      `
      INSERT INTO dental_persons (
        id, navn, hpr_nr, primary_specialty, all_specialties,
        own_orgnr, fylke_residence, is_active, source
      ) VALUES (
        @id, @navn, @hpr_nr, @primary_specialty, @all_specialties,
        @own_orgnr, @fylke_residence, @is_active, @source
      )
    `
    ).run({
      id,
      navn: parsed.navn,
      hpr_nr: parsed.hpr_nr ?? null,
      primary_specialty: parsed.primary_specialty ?? null,
      all_specialties: jsonOrNull(parsed.all_specialties),
      own_orgnr: parsed.own_orgnr ?? null,
      fylke_residence: parsed.fylke_residence ?? null,
      is_active: parsed.is_active ?? 1,
      source: parsed.source ?? null,
    });
  }

  return id;
}

export function createAffiliation(input: Affiliation): string {
  const parsed = AffiliationSchema.parse(input);
  const id = uuid();
  const db = getDb("dental");

  db.prepare(
    `
    INSERT OR IGNORE INTO dental_clinic_affiliations (
      id, person_id, clinic_agent_id,
      affiliation_type, role, specialty_used_here,
      schedule_pattern, is_active, source, evidence_url
    ) VALUES (
      @id, @person_id, @clinic_agent_id,
      @affiliation_type, @role, @specialty_used_here,
      @schedule_pattern, @is_active, @source, @evidence_url
    )
  `
  ).run({
    id,
    person_id: parsed.person_id,
    clinic_agent_id: parsed.clinic_agent_id,
    affiliation_type: parsed.affiliation_type ?? null,
    role: parsed.role ?? null,
    specialty_used_here: parsed.specialty_used_here ?? null,
    schedule_pattern: parsed.schedule_pattern ?? null,
    is_active: parsed.is_active ?? 1,
    source: parsed.source ?? null,
    evidence_url: parsed.evidence_url ?? null,
  });

  // Keep denormalized read-side in sync.
  recomputeAvailableSpecialties(parsed.clinic_agent_id);

  return id;
}

export function recomputeAvailableSpecialties(clinic_id: string): void {
  const db = getDb("dental");
  const rows = db
    .prepare(
      `
      SELECT DISTINCT specialty_used_here
      FROM dental_clinic_affiliations
      WHERE clinic_agent_id = ?
        AND is_active = 1
        AND specialty_used_here IS NOT NULL
        AND specialty_used_here <> ''
    `
    )
    .all(clinic_id) as Array<{ specialty_used_here: string }>;

  const specialties = rows.map((r) => r.specialty_used_here).sort();
  const json = specialties.length ? JSON.stringify(specialties) : null;

  db.prepare(
    "UPDATE dental_agents SET available_specialties = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(json, clinic_id);
}

export function listSpecialistsForClinic(
  clinic_id: string
): Array<DentalPerson & { id: string; specialty_used_here: string | null }> {
  const db = getDb("dental");
  const rows = db
    .prepare(
      `
      SELECT p.*, a.specialty_used_here
      FROM dental_persons p
      JOIN dental_clinic_affiliations a ON a.person_id = p.id
      WHERE a.clinic_agent_id = ? AND a.is_active = 1
      ORDER BY p.navn ASC
    `
    )
    .all(clinic_id) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: row.id as string,
    navn: row.navn as string,
    hpr_nr: (row.hpr_nr as string | null) ?? null,
    primary_specialty: (row.primary_specialty as string | null) ?? null,
    all_specialties: parseJsonArray(row.all_specialties),
    own_orgnr: (row.own_orgnr as string | null) ?? null,
    fylke_residence: (row.fylke_residence as string | null) ?? null,
    is_active: (row.is_active as 0 | 1) ?? 1,
    source: (row.source as string | null) ?? null,
    specialty_used_here: (row.specialty_used_here as string | null) ?? null,
  }));
}

export function listChains(): Array<{
  id: string;
  chain_brand: string;
  parent_orgnr: string | null;
  website: string | null;
  num_locations_advertised: number | null;
  tier: string | null;
  confidence: string | null;
}> {
  const db = getDb("dental");
  const rows = db
    .prepare(
      "SELECT id, chain_brand, parent_orgnr, website, num_locations_advertised, tier, confidence FROM dental_chains ORDER BY chain_brand ASC"
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    chain_brand: r.chain_brand as string,
    parent_orgnr: (r.parent_orgnr as string | null) ?? null,
    website: (r.website as string | null) ?? null,
    num_locations_advertised:
      (r.num_locations_advertised as number | null) ?? null,
    tier: (r.tier as string | null) ?? null,
    confidence: (r.confidence as string | null) ?? null,
  }));
}

// Allow-list of PUT-writable dental_agents fields — never id or vertical.
// Exported (enrichment-metode slice 1 review fix) so the PUT route can compute
// fields_updated as the INTERSECTION of the validated body and this list:
// a schema-valid key outside the list (e.g. available_specialties, which is
// derived from affiliations) is silently skipped by updateDentalAgent below,
// and must therefore never be reported as written.
export const DENTAL_AGENT_WRITABLE_FIELDS: ReadonlyArray<string> = [
    "org_nr",
    "navn",
    "postnummer",
    "poststed",
    "fylke",
    "adresse",
    "telefon",
    "mobil",
    "epost",
    "hjemmeside",
    "antall_ansatte",
    "organisasjonsform",
    "registreringsdato",
    "naeringskode",
    "treatments",
    "helfo_agreement",
    "languages_spoken",
    "acute_vakt",
    "price_band",
    "chain_brand",
    "is_chain_member",
    "chain_parent_orgnr",
    "enrichment_state",
    "verification_status",
    // PR-130: rating + price-band provenance
    "rating",
    "rating_count",
    "rating_source",
    "price_band_source",
    // PR-100: geocoding (6)
    "lat",
    "lng",
    "geocode_source",
    "geocode_confidence",
    "opening_hours",
    "field_provenance",
    // PR-100: deep-scrape (10)
    "om_oss",
    "specialists",
    "treatment_tech",
    "equipment_brands",
    "patient_focus",
    "accessibility",
    "payment_options",
    "online_booking_url",
    "social_media",
    "treatments_subtypes",
  ];

export function updateDentalAgent(
  id: string,
  patch: Partial<DentalAgent>
): boolean {
  const db = getDb("dental");
  const existing = getDentalAgentById(id);
  if (!existing) return false;

  // Allow-list — never let an UPDATE touch id or vertical.
  const allowed: Array<keyof DentalAgent> = DENTAL_AGENT_WRITABLE_FIELDS as Array<keyof DentalAgent>;

  // PR-100: columns that must be JSON.stringify'd before SQL bind.
  // Mirrors the existing pattern for treatments / languages_spoken.
  const jsonCols = new Set<keyof DentalAgent>([
    "treatments",
    "languages_spoken",
    // PR-100 JSON-typed columns
    "opening_hours",
    "field_provenance",
    "specialists",
    "treatment_tech",
    "equipment_brands",
    "patient_focus",
    "accessibility",
    "payment_options",
    "social_media",
    "treatments_subtypes",
  ]);

  const sets: string[] = [];
  const params: Record<string, unknown> = { id };

  for (const key of allowed) {
    if (!(key in patch)) continue;
    const raw = patch[key];
    if (key === "treatments" || key === "languages_spoken") {
      sets.push(`${key} = @${key}`);
      params[key] = jsonOrNull(raw as string[] | undefined);
    } else if (jsonCols.has(key)) {
      sets.push(`${key} = @${key}`);
      params[key] = stringifyJsonOrNull(raw);
    } else {
      sets.push(`${key} = @${key}`);
      params[key] = raw ?? null;
    }
  }

  if (sets.length === 0) return true; // nothing to do
  sets.push("updated_at = datetime('now')");

  db.prepare(`UPDATE dental_agents SET ${sets.join(", ")} WHERE id = @id`).run(
    params
  );
  return true;
}

// ─── PR-130: targeted rating update ──────────────────────────────────────────
//
// Called by the Google Places enrichment step after Places API returns
// rating + user_ratings_total for a clinic that already has a Places match.
// Stores rating/rating_count plus the provenance string
// (e.g. "google_places|2026-06-27"). Idempotent: always overwrites.

export function updateDentalRating(
  id: string,
  rating: number,
  ratingCount: number,
  source: string
): boolean {
  const db = getDb("dental");
  const res = db
    .prepare(
      `UPDATE dental_agents
       SET rating = ?, rating_count = ?, rating_source = ?, updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(rating, ratingCount, source, id);
  return res.changes > 0;
}

// ─── PR-130: targeted price_band update (with provenance) ────────────────────
//
// Updates price_band + price_band_source atomically. Validates enum value.
// Called from Stage X enrichment when confidence >= 0.80.
// Valid values: rimelig | standard | premium | ukjent (per dental-specific.yaml)

const PRICE_BAND_ENUM = new Set(["rimelig", "standard", "premium", "ukjent"]);

export function updateDentalPriceBand(
  id: string,
  priceBand: string,
  source: string
): boolean {
  if (!PRICE_BAND_ENUM.has(priceBand)) {
    throw new Error(
      `Invalid price_band value: ${priceBand}. Must be one of: ${[...PRICE_BAND_ENUM].join(", ")}`
    );
  }
  const db = getDb("dental");
  const res = db
    .prepare(
      `UPDATE dental_agents
       SET price_band = ?, price_band_source = ?, updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(priceBand, source, id);
  return res.changes > 0;
}

/**
 * Bulk-insert from the Phase A.5 merged dataset.
 *
 * `INSERT OR IGNORE` on org_nr — if a row with the same org_nr already
 * exists, we skip it (no clobber). Returns counts so the script can
 * report how much new data was ingested.
 *
 * Wrapped in a single transaction for ~50x speedup on 7k rows.
 */
export function bulkInsertFromMerged(rows: MergedRow[]): {
  inserted: number;
  skipped: number;
  excluded: number;
} {
  const db = getDb("dental");
  let inserted = 0;
  let skipped = 0;
  let excluded = 0;

  const insertOne = db.prepare(`
    INSERT OR IGNORE INTO dental_agents (
      id, org_nr, navn,
      postnummer, poststed, fylke, adresse,
      telefon, mobil, epost, hjemmeside,
      antall_ansatte, organisasjonsform, registreringsdato, naeringskode,
      treatments, helfo_agreement, languages_spoken, acute_vakt, price_band,
      chain_brand, is_chain_member, chain_parent_orgnr,
      enrichment_state, verification_status
    ) VALUES (
      @id, @org_nr, @navn,
      @postnummer, @poststed, @fylke, @adresse,
      @telefon, @mobil, @epost, @hjemmeside,
      @antall_ansatte, @organisasjonsform, @registreringsdato, @naeringskode,
      @treatments, @helfo_agreement, @languages_spoken, @acute_vakt, @price_band,
      @chain_brand, @is_chain_member, @chain_parent_orgnr,
      @enrichment_state, @verification_status
    )
  `);

  const tx = db.transaction((batch: MergedRow[]) => {
    for (const row of batch) {
      // Light-touch validation — bulk pipeline upstream owns shape.
      if (!row.navn) {
        skipped++;
        continue;
      }
      // EXCLUSION CHECK (PR-90): skip rows whose org_nr or URL is on
      // the anti-rediscovery list.
      const excl = isExcluded(row.org_nr ?? null, row.hjemmeside ?? null);
      if (excl.excluded) {
        excluded++;
        continue;
      }
      const id = row.id ?? uuid();
      const result = insertOne.run({
        id,
        org_nr: row.org_nr ?? null,
        navn: row.navn,
        postnummer: row.postnummer ?? null,
        poststed: row.poststed ?? null,
        fylke: row.fylke ?? null,
        adresse: row.adresse ?? null,
        telefon: row.telefon ?? null,
        mobil: row.mobil ?? null,
        epost: row.epost ?? null,
        hjemmeside: row.hjemmeside ?? null,
        antall_ansatte: row.antall_ansatte ?? null,
        organisasjonsform: row.organisasjonsform ?? null,
        registreringsdato: row.registreringsdato ?? null,
        naeringskode: row.naeringskode ?? null,
        treatments: jsonOrNull(row.treatments),
        helfo_agreement: row.helfo_agreement ?? "unknown",
        languages_spoken: jsonOrNull(row.languages_spoken),
        acute_vakt: row.acute_vakt ?? null,
        price_band: row.price_band ?? null,
        chain_brand: row.chain_brand ?? null,
        is_chain_member: row.is_chain_member ?? 0,
        chain_parent_orgnr: row.chain_parent_orgnr ?? null,
        enrichment_state: row.enrichment_state ?? "raw",
        verification_status: row.verification_status ?? "pending_verify",
      });
      if (result.changes > 0) inserted++;
      else skipped++;
    }
  });

  tx(rows);
  return { inserted, skipped, excluded };
}


// ─── Phase B exclusions (PR-90) ──────────────────────────────────────
//
// Anti-rediscovery: dental_exclusions records orgnrs / URLs we've
// determined are NOT valid dental clinics (suppliers, dead domains,
// booking portals misclassified under NACE 86.230, etc). createDentalAgent
// and bulkInsertFromMerged consult this table before inserting.

export type ExclusionReason =
  | "not_a_clinic"
  | "dead_domain"
  | "robots_blocked_permanent"
  | "supplier"
  | "booking_portal"
  | "duplicate_orgnr"
  | "fylkeskommunal_dot"
  | "manual_review";

export interface IsExcludedResult {
  excluded: boolean;
  reason?: ExclusionReason;
  notes?: string;
}

export function isExcluded(
  orgnr?: string | null,
  hjemmesideUrl?: string | null
): IsExcludedResult {
  const db = getDb("dental");
  if (orgnr) {
    const row = db
      .prepare(
        `SELECT reason, notes FROM dental_exclusions
         WHERE org_nr = ?
         AND (is_permanent = 1 OR reactivate_after IS NULL OR reactivate_after > datetime('now'))
         LIMIT 1`
      )
      .get(orgnr) as { reason: ExclusionReason; notes?: string } | undefined;
    if (row) return { excluded: true, reason: row.reason, notes: row.notes };
  }
  if (hjemmesideUrl) {
    const row = db
      .prepare(
        `SELECT reason, notes FROM dental_exclusions
         WHERE hjemmeside_url = ?
         AND (is_permanent = 1 OR reactivate_after IS NULL OR reactivate_after > datetime('now'))
         LIMIT 1`
      )
      .get(hjemmesideUrl) as { reason: ExclusionReason; notes?: string } | undefined;
    if (row) return { excluded: true, reason: row.reason, notes: row.notes };
  }
  return { excluded: false };
}

export interface RecordExclusionInput {
  orgnr?: string | null;
  hjemmesideUrl?: string | null;
  navnPattern?: string | null;
  reason: ExclusionReason;
  evidence?: string | null;
  notes?: string | null;
  excludedBy: string;
  reactivateAfter?: string | null;
  isPermanent?: boolean;
}

export function recordExclusion(args: RecordExclusionInput): string {
  const id = "excl-" + uuid();
  getDb("dental")
    .prepare(
      `INSERT INTO dental_exclusions
       (id, org_nr, hjemmeside_url, navn_pattern, reason, evidence, notes, excluded_by, reactivate_after, is_permanent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      args.orgnr ?? null,
      args.hjemmesideUrl ?? null,
      args.navnPattern ?? null,
      args.reason,
      args.evidence ?? null,
      args.notes ?? null,
      args.excludedBy,
      args.reactivateAfter ?? null,
      args.isPermanent ? 1 : 0
    );
  return id;
}

export interface ListExclusionsFilter {
  reason?: ExclusionReason;
  limit?: number;
}

export function listExclusions(
  filter: ListExclusionsFilter = {}
): Array<Record<string, unknown>> {
  let sql = `SELECT * FROM dental_exclusions WHERE 1=1`;
  const params: unknown[] = [];
  if (filter.reason) {
    sql += ` AND reason = ?`;
    params.push(filter.reason);
  }
  sql += ` ORDER BY excluded_at DESC LIMIT ?`;
  params.push(filter.limit ?? 100);
  return getDb("dental")
    .prepare(sql)
    .all(...params) as Array<Record<string, unknown>>;
}


// ─── PR-116: SEO helpers ─────────────────────────────────────────────────────

/**
 * Returns all distinct non-empty poststeder (cities) with a count of
 * non-rejected clinics, ordered by count descending.
 * poststed values are stored UPPERCASE in the DB (e.g. "OSLO").
 */
export interface PoststedRow {
  poststed: string;
  fylke: string | null;
  count: number;
}

export function listPoststeder(minCount = 1): PoststedRow[] {
  const db = getDb("dental");
  // For each poststed, pick the most common fylke (subquery via GROUP BY + ORDER BY n DESC LIMIT 1)
  const rows = db.prepare(`
    SELECT poststed,
           (SELECT fylke FROM dental_agents da2
            WHERE da2.poststed = da.poststed
              AND da2.verification_status != 'rejected'
              AND da2.fylke IS NOT NULL AND da2.fylke != ''
            GROUP BY fylke ORDER BY COUNT(*) DESC LIMIT 1) AS fylke,
           COUNT(*) AS n
    FROM dental_agents da
    WHERE verification_status != 'rejected'
      AND poststed IS NOT NULL AND poststed != ''
    GROUP BY poststed
    HAVING n >= ?
    ORDER BY n DESC
  `).all(minCount) as Array<{ poststed: string; fylke: string | null; n: number }>;

  return rows.map((r) => ({
    poststed: r.poststed,
    fylke: r.fylke ?? null,
    count: r.n,
  }));
}

/**
 * Related clinics in the same poststed, excluding the given agent id,
 * not rejected, quality-sorted (same order as listPublicDentalAgents).
 */
export function listRelatedClinics(
  agent: DentalAgent & { id: string },
  limit = 6
): Array<DentalAgent & { id: string }> {
  if (!agent.poststed) return [];
  const db = getDb("dental");
  const rows = db.prepare(`
    SELECT * FROM dental_agents
    WHERE poststed = ?
      AND id != ?
      AND verification_status != 'rejected'
    ORDER BY
      CASE verification_status WHEN 'verified' THEN 0 ELSE 1 END ASC,
      CASE enrichment_state WHEN 'enriched' THEN 0 ELSE 1 END ASC,
      CASE WHEN hjemmeside IS NOT NULL OR telefon IS NOT NULL THEN 0 ELSE 1 END ASC,
      navn ASC
    LIMIT ?
  `).all(agent.poststed, agent.id, Math.max(1, Math.min(20, limit))) as Array<Record<string, unknown>>;
  return rows.map(hydrateAgent);
}

/**
 * Minimal list for sitemap generation: org_nr, navn, updated_at.
 * Only non-rejected rows with an org_nr (required for stable slug).
 */
export function getDentalAgentsForSitemap(): Array<{ org_nr: string; navn: string; updated_at: string | null }> {
  const db = getDb("dental");
  const rows = db.prepare(`
    SELECT org_nr, navn, updated_at
    FROM dental_agents
    WHERE verification_status != 'rejected'
      AND org_nr IS NOT NULL AND org_nr != ''
    ORDER BY navn ASC
  `).all() as Array<{ org_nr: string; navn: string; updated_at: string | null }>;
  return rows;
}

// ─── PR-127: opening_hours normalization (tolerant ingest) ───────────────────
//
// Real-world clinic hours are messy ("9–15.30", "Man-Tor 08-16", "mandag",
// "stengt", "etter avtale"). The opening_hours zod schema is strict
// (array of { day: mon..sun, open:"HH:MM", close:"HH:MM" }), and PUT /agents/:id
// hard-400s the WHOLE body on any invalid field — so one malformed hours entry
// dropped every other field in the same enrichment PUT (observed:
// opening_hours_shape_failures + stage_x_field_puts_failed in dental worker
// envelopes). This helper salvages what it can and drops the rest, so a best-
// effort hours array reaches the DB instead of nuking the record.

const _DAY_MAP: Record<string, "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun"> = {
  mon: "mon", monday: "mon", man: "mon", mandag: "mon", må: "mon",
  tue: "tue", tues: "tue", tuesday: "tue", tir: "tue", tirsdag: "tue", ti: "tue",
  wed: "wed", weds: "wed", wednesday: "wed", ons: "wed", onsdag: "wed", on: "wed",
  thu: "thu", thur: "thu", thurs: "thu", thursday: "thu", tor: "thu", torsdag: "thu", to: "thu",
  fri: "fri", friday: "fri", fre: "fri", fredag: "fri", fr: "fri",
  sat: "sat", saturday: "sat", lor: "sat", "lør": "sat", lordag: "sat", "lørdag": "sat", la: "sat",
  sun: "sun", sunday: "sun", son: "sun", "søn": "sun", sondag: "sun", "søndag": "sun", "sø": "sun",
};

/** Normalize a single day token to mon..sun, or null if unrecognized. */
export function normalizeDayToken(raw: unknown): "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun" | null {
  if (typeof raw !== "string") return null;
  const k = raw.trim().toLowerCase().replace(/\.$/, "");
  // Prototype-safe lookup: reserved keys ("constructor", "__proto__") must
  // resolve to null, not inherited Object.prototype members (PR-127 review).
  return Object.prototype.hasOwnProperty.call(_DAY_MAP, k) ? _DAY_MAP[k] : null;
}

/** Normalize a clock token to zero-padded "HH:MM", or null if unparseable. */
export function normalizeTimeToken(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw)) raw = String(raw);
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  // Accept "8", "8:30", "08.30", "0830", "8 30".
  let m = s.match(/^(\d{1,2})\s*[:.\s]\s*(\d{2})$/);
  if (!m) {
    const only = s.match(/^(\d{1,2})$/);
    if (only) m = [s, only[1], "00"] as unknown as RegExpMatchArray;
  }
  if (!m) {
    const four = s.match(/^(\d{2})(\d{2})$/);
    if (four) m = [s, four[1], four[2]] as unknown as RegExpMatchArray;
  }
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export interface OpeningHoursEntry { day: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun"; open: string; close: string; }

/**
 * Best-effort normalize an opening_hours value into the strict schema shape.
 * Accepts the canonical array, an array with sloppy day/time tokens, a
 * range string per entry ("08:00-16:00"), or a day-keyed object map
 * ({ mon: "08-16" } / { monday: { open, close } }). Unsalvageable entries
 * (closed / "etter avtale" / bad times / unknown day) are dropped.
 * Returns { value, dropped } — value is null when nothing survived.
 */
export function normalizeOpeningHours(
  input: unknown
): { value: OpeningHoursEntry[] | null; dropped: number } {
  let dropped = 0;
  const out: OpeningHoursEntry[] = [];

  const pushFrom = (dayRaw: unknown, openRaw: unknown, closeRaw: unknown): void => {
    const day = normalizeDayToken(dayRaw);
    const open = normalizeTimeToken(openRaw);
    const close = normalizeTimeToken(closeRaw);
    if (typeof day === "string" && open && close) out.push({ day, open, close });
    else dropped++;
  };

  // Split a value that may be a range string ("08:00-16:00", "8–16") into [open, close].
  const splitRange = (v: unknown): [unknown, unknown] => {
    if (typeof v === "string") {
      const parts = v.split(/[-–—to]+/i).map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 2) return [parts[0], parts[1]];
      return [v, undefined];
    }
    return [v, undefined];
  };

  if (Array.isArray(input)) {
    for (const e of input) {
      if (e && typeof e === "object" && !Array.isArray(e)) {
        const obj = e as Record<string, unknown>;
        if (obj.open !== undefined || obj.close !== undefined) {
          pushFrom(obj.day, obj.open, obj.close);
        } else if (typeof obj.hours === "string" || typeof obj.time === "string") {
          const [o, c] = splitRange(obj.hours ?? obj.time);
          pushFrom(obj.day, o, c);
        } else {
          dropped++;
        }
      } else {
        dropped++;
      }
    }
  } else if (input && typeof input === "object") {
    // Day-keyed object map.
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const o = (v as Record<string, unknown>).open;
        const c = (v as Record<string, unknown>).close;
        pushFrom(k, o, c);
      } else if (typeof v === "string") {
        const [o, c] = splitRange(v);
        pushFrom(k, o, c);
      } else {
        dropped++;
      }
    }
  } else if (input == null) {
    return { value: null, dropped: 0 };
  } else {
    return { value: null, dropped: 1 };
  }

  return { value: out.length ? out : null, dropped };
}
