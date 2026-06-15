// ─── Experiences DB Schema — Phase 7 (Skjer) ────────────────────────
//
// Fresh schema for /data/experiences.db. NOT an ALTER on rfb's lokal.db
// or dental.db. Mirrors the conventions of init-dental.ts.
//
// Tables:
//   - experience_providers          one row per provider (org, Brreg-verified)
//   - experiences                   one row per bookable experience (PRIMARY harvest target)
//   - experience_umbrellas          destination companies / industry assoc / aggregators
//   - provider_umbrella_affiliations  many-to-many provider × umbrella
//   - experience_verifier_findings  per-row verifier evidence trail
//
// HARVEST-FIRST MODEL (Daniel 2026-06-14): experiences are discovered from
// curated sources (Visit Norway / destination companies / umbrellas), THEN
// matched to a provider, THEN verified active in Brreg. So experiences.provider_id
// is NULLABLE until matching/verification runs.
//
// Each CREATE TABLE wrapped in try/catch so a partial-init from an earlier
// boot doesn't crash a re-deploy (jf. dental Appendix C #2).

import Database from "better-sqlite3";

export function initExperiencesSchema(db: Database.Database): void {
  // experience_providers — one row per provider (organisasjon), Brreg-verified
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS experience_providers (
        id TEXT PRIMARY KEY,
        org_nr TEXT UNIQUE,
        navn TEXT NOT NULL,
        vertical TEXT DEFAULT 'experiences' CHECK(vertical='experiences'),
        -- Core contact / location
        postnummer TEXT,
        poststed TEXT,
        fylke TEXT,
        kommune TEXT,
        kommunenummer TEXT,
        adresse TEXT,
        lat REAL,
        lon REAL,
        telefon TEXT,
        mobil TEXT,
        epost TEXT,
        hjemmeside TEXT,
        -- Brreg metadata
        antall_ansatte INTEGER,
        organisasjonsform TEXT,
        registreringsdato TEXT,
        naeringskode TEXT,
        provider_type TEXT,                 -- operator | venue | accommodation | transport | nature ...
        -- Brreg verification (core of the trust model)
        brreg_verified INTEGER DEFAULT 0,   -- 1 = matched to an org_nr in Brreg
        brreg_active INTEGER,               -- 1=active, 0=konkurs/avvikling, NULL=unknown
        brreg_checked_at TEXT,
        is_umbrella_member INTEGER DEFAULT 0,
        -- Agent-system fields
        source TEXT,
        confidence TEXT,
        enrichment_state TEXT DEFAULT 'raw',
        verification_status TEXT DEFAULT 'pending_verify',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        last_enriched_at TEXT
      );
    `);
  } catch (e) {
    console.log(`[experiences] experience_providers init skipped: ${(e as Error).message}`);
  }

  // experiences — one row per bookable experience (the search unit)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS experiences (
        id TEXT PRIMARY KEY,
        provider_id TEXT,                   -- FK → experience_providers.id (NULLABLE until matched)
        provider_match_status TEXT DEFAULT 'unmatched',  -- unmatched | matched | ambiguous
        title TEXT NOT NULL,
        slug TEXT UNIQUE,
        description TEXT,                    -- own summary, NOT a verbatim copy (see PHASE7 §5)
        category TEXT,
        subcategory TEXT,
        activity_tags TEXT,                 -- JSON-array
        season TEXT,                        -- JSON-array: ['summer','winter','year_round',...]
        indoor_outdoor TEXT,                -- indoor | outdoor | both
        weather_dependent INTEGER,          -- 0|1
        physical_intensity TEXT,            -- low | medium | high
        duration_min INTEGER,
        duration_max INTEGER,
        group_min INTEGER,
        group_max INTEGER,
        age_suitability TEXT,               -- all | family | adults | kids
        min_age INTEGER,
        price_band TEXT,                    -- rimelig | standard | premium | gratis | ukjent
        price_from INTEGER,
        price_unit TEXT,                    -- per_person | per_group
        languages TEXT,                     -- JSON-array
        accessibility TEXT,                 -- JSON-array
        booking_url TEXT,
        booking_type TEXT,                  -- instant | request | external | none
        loc_lat REAL,
        loc_lon REAL,
        meeting_point TEXT,
        kommune TEXT,
        fylke TEXT,
        -- provenance & quality
        discovery_source TEXT,              -- visitnorway | destination_company | umbrella | tripadvisor_signal | manual
        content_source TEXT,                -- provider_site | manual | claim
        evidence_url TEXT,
        confidence TEXT,                    -- high | medium | low
        enrichment_state TEXT DEFAULT 'raw',        -- raw → matched → enriched → verified
        verification_status TEXT DEFAULT 'pending_verify',
        seasonal_valid_from TEXT,
        seasonal_valid_to TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (provider_id) REFERENCES experience_providers(id)
      );
    `);
  } catch (e) {
    console.log(`[experiences] experiences init skipped: ${(e as Error).message}`);
  }

  // experience_umbrellas — destination companies / industry associations / aggregators
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS experience_umbrellas (
        id TEXT PRIMARY KEY,
        umbrella_name TEXT NOT NULL,
        umbrella_type TEXT,                 -- destination_company | industry_assoc | aggregator | marketplace
        region TEXT,
        fylke TEXT,
        website TEXT,
        source_system TEXT,                 -- tellus | cbis | own | web
        member_count_advertised INTEGER,
        tier TEXT,
        confidence TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
  } catch (e) {
    console.log(`[experiences] experience_umbrellas init skipped: ${(e as Error).message}`);
  }

  // provider_umbrella_affiliations — many-to-many provider × umbrella
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_umbrella_affiliations (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        umbrella_id TEXT NOT NULL,
        source TEXT,
        evidence_url TEXT,
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (provider_id) REFERENCES experience_providers(id),
        FOREIGN KEY (umbrella_id) REFERENCES experience_umbrellas(id),
        UNIQUE(provider_id, umbrella_id)
      );
    `);
  } catch (e) {
    console.log(`[experiences] provider_umbrella_affiliations init skipped: ${(e as Error).message}`);
  }

  // experience_verifier_findings — verifier-SKILL evidence trail
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS experience_verifier_findings (
        id TEXT PRIMARY KEY,
        experience_id TEXT NOT NULL,
        check_type TEXT NOT NULL,           -- link_live | season_valid | price_plausible | brreg_active ...
        status TEXT NOT NULL,               -- pass | fail | warn
        evidence TEXT,
        notes TEXT,
        checked_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (experience_id) REFERENCES experiences(id)
      );
    `);
  } catch (e) {
    console.log(`[experiences] experience_verifier_findings init skipped: ${(e as Error).message}`);
  }

  // Indexes — wrapped in try/catch so re-deploy is safe
  const indexes = [
    "CREATE INDEX IF NOT EXISTS idx_exp_prov_orgnr ON experience_providers(org_nr)",
    "CREATE INDEX IF NOT EXISTS idx_exp_prov_fylke ON experience_providers(fylke)",
    "CREATE INDEX IF NOT EXISTS idx_exp_prov_type ON experience_providers(provider_type)",
    "CREATE INDEX IF NOT EXISTS idx_exp_provider ON experiences(provider_id)",
    "CREATE INDEX IF NOT EXISTS idx_exp_category ON experiences(category)",
    "CREATE INDEX IF NOT EXISTS idx_exp_fylke ON experiences(fylke)",
    "CREATE INDEX IF NOT EXISTS idx_exp_indoor ON experiences(indoor_outdoor)",
    "CREATE INDEX IF NOT EXISTS idx_exp_verification ON experiences(verification_status)",
    "CREATE INDEX IF NOT EXISTS idx_aff_provider ON provider_umbrella_affiliations(provider_id)",
    "CREATE INDEX IF NOT EXISTS idx_aff_umbrella ON provider_umbrella_affiliations(umbrella_id)",
  ];
  for (const stmt of indexes) {
    try {
      db.exec(stmt);
    } catch (e) {
      console.log(`[experiences] index init skipped: ${(e as Error).message}`);
    }
  }

  console.log("[experiences] schema initialized");
}
