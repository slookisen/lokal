// ─── Dental DB Schema — Phase 6 (PR-89) ─────────────────────────────
//
// Fresh schema for /data/dental.db. NOT an ALTER on rfb's lokal.db.
// Validated locally via /tmp/dental-poc/dental.db before this PR.
//
// Tables:
//   - dental_agents              one row per clinic (organisasjon)
//   - dental_persons             one row per practitioner (HPR-linked)
//   - dental_clinic_affiliations many-to-many person × clinic (ambulant model)
//   - dental_chains              detected chain brands (Volvat, Colosseum, ...)
//   - dental_verifier_findings   per-agent verifier evidence trail
//
// AMBULANT MODEL: ~60-75% of specialists practice at multiple clinics
// (A6 deep-dive 2026-05-27). dental_clinic_affiliations encodes that
// as first-class data; available_specialties on dental_agents is the
// denormalized read-side cache (recomputed via dental-store).
//
// Per Appendix C #2: each CREATE TABLE wrapped in try/catch so a
// partial-init from an earlier boot doesn't crash a re-deploy.

import Database from "better-sqlite3";

export function initDentalSchema(db: Database.Database): void {
  // dental_agents — one row per clinic (organisasjon)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dental_agents (
        id TEXT PRIMARY KEY,
        org_nr TEXT UNIQUE,
        navn TEXT NOT NULL,
        vertical TEXT DEFAULT 'dental' CHECK(vertical='dental'),
        -- Core contact
        postnummer TEXT,
        poststed TEXT,
        fylke TEXT,
        adresse TEXT,
        telefon TEXT,
        mobil TEXT,
        epost TEXT,
        hjemmeside TEXT,
        -- Brreg metadata
        antall_ansatte INTEGER,
        organisasjonsform TEXT,
        registreringsdato TEXT,
        naeringskode TEXT,
        -- Dental-specifics
        treatments TEXT,
        helfo_agreement TEXT,
        languages_spoken TEXT,
        acute_vakt INTEGER,
        price_band TEXT,
        -- Chain affiliation (denormalized for fast read)
        chain_brand TEXT,
        is_chain_member INTEGER DEFAULT 0,
        chain_parent_orgnr TEXT,
        -- Specialties at this clinic (aggregated from affiliations, denormalized)
        available_specialties TEXT,
        -- Agent-system fields
        enrichment_state TEXT DEFAULT 'raw',
        verification_status TEXT DEFAULT 'pending_verify',
        last_verified_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        last_enriched_at TEXT
      );
    `);
  } catch (e) {
    console.log(`[dental] dental_agents init skipped: ${(e as Error).message}`);
  }

  // ── Dead-homepage parking (enrichment-metode slice 1, 2026-07-16) ─────────
  // Mirrors agent_knowledge's PR #248 columns: consecutive fetch-failure counter
  // + park stamp at 3 (30d backoff). Idempotent ALTERs — error = already present.
  const dentalParkingCols = [
    "ALTER TABLE dental_agents ADD COLUMN homepage_fetch_attempts INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE dental_agents ADD COLUMN homepage_unreachable_since TEXT",
  ];
  for (const stmt of dentalParkingCols) {
    try { db.exec(stmt); } catch { /* already present */ }
  }

  // ── Dead-extraction parking (dev-request 2026-07-12-dental-enrichment-
  // universe-growth-and-queue-hygiene, item 2a, 2026-07-17): mirrors the
  // homepage-parking columns immediately above, but for enrichment/extraction
  // failures (thin directory-listing sites, non-clinic entities that
  // repeatedly fail deep-scrape) instead of homepage-fetch failures. Same
  // semantics: 3 consecutive extraction failures park the clinic
  // (extraction_unreachable_since stamped) for 30 days; a successful
  // extraction fully resets. Idempotent ALTERs — error = already present.
  const dentalExtractionParkingCols = [
    "ALTER TABLE dental_agents ADD COLUMN extraction_attempts INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE dental_agents ADD COLUMN extraction_unreachable_since TEXT",
  ];
  for (const stmt of dentalExtractionParkingCols) {
    try { db.exec(stmt); } catch { /* already present */ }
  }

  // ── Stage V drift auto-correction (dev-request 2026-07-12-dental-
  // enrichment-universe-growth-and-queue-hygiene, slice 4a, 2026-07-20):
  // nullable JSON map of NOT-YET-CONFIRMED Stage-V-observed field values
  // that disagree with the DB, keyed by field name — e.g.
  // {"helfo_agreement": {"value": "true", "observed_at": "<ISO>"}}. Slice
  // 4a only ever reads/writes the "helfo_agreement" key (see
  // recordStageVFieldObservation() in dental-store.ts), but the column is
  // a map (not a single value) so a future item-4b slice can reuse it for
  // `treatments`/`opening_hours` without another migration. Idempotent
  // ALTER — error = already present.
  try {
    db.exec("ALTER TABLE dental_agents ADD COLUMN stage_v_pending_correction TEXT");
  } catch { /* already present */ }

  // dental_persons — one row per practitioner (HPR-linked when known)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dental_persons (
        id TEXT PRIMARY KEY,
        navn TEXT NOT NULL,
        hpr_nr TEXT UNIQUE,
        primary_specialty TEXT,
        all_specialties TEXT,
        own_orgnr TEXT,
        fylke_residence TEXT,
        is_active INTEGER DEFAULT 1,
        source TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
  } catch (e) {
    console.log(`[dental] dental_persons init skipped: ${(e as Error).message}`);
  }

  // dental_clinic_affiliations — many-to-many person × clinic.
  // UNIQUE(person_id, clinic_agent_id, specialty_used_here) so the
  // same person can be linked to the same clinic for different
  // specialties (rare but valid: a dentist who is both an ordinary
  // tannlege and an endodontist at the same place).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dental_clinic_affiliations (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        clinic_agent_id TEXT NOT NULL,
        affiliation_type TEXT,
        role TEXT,
        specialty_used_here TEXT,
        schedule_pattern TEXT,
        is_active INTEGER DEFAULT 1,
        source TEXT,
        evidence_url TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (person_id) REFERENCES dental_persons(id),
        FOREIGN KEY (clinic_agent_id) REFERENCES dental_agents(id),
        UNIQUE(person_id, clinic_agent_id, specialty_used_here)
      );
    `);
  } catch (e) {
    console.log(`[dental] dental_clinic_affiliations init skipped: ${(e as Error).message}`);
  }

  // dental_chains — 24 detected chains per A6 deep-dive
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dental_chains (
        id TEXT PRIMARY KEY,
        chain_brand TEXT UNIQUE NOT NULL,
        parent_orgnr TEXT,
        website TEXT,
        num_locations_advertised INTEGER,
        tier TEXT,
        confidence TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
  } catch (e) {
    console.log(`[dental] dental_chains init skipped: ${(e as Error).message}`);
  }

  // dental_verifier_findings — verifier-SKILL evidence trail
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dental_verifier_findings (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        check_type TEXT NOT NULL,
        status TEXT NOT NULL,
        evidence TEXT,
        notes TEXT,
        checked_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (agent_id) REFERENCES dental_agents(id)
      );
    `);
  } catch (e) {
    console.log(`[dental] dental_verifier_findings init skipped: ${(e as Error).message}`);
  }

  // dental_exclusions (PR-90): anti-rediscovery list. When Brreg
  // discovery re-runs, this table tells us which org_nrs / URLs we
  // have already determined are NOT valid dental clinics — so we
  // don't re-insert them (suppliers, dead domains, booking portals
  // misclassified under NACE 86.230, etc).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dental_exclusions (
        id TEXT PRIMARY KEY,
        org_nr TEXT,
        hjemmeside_url TEXT,
        navn_pattern TEXT,
        reason TEXT NOT NULL,
        evidence TEXT,
        notes TEXT,
        excluded_at TEXT DEFAULT (datetime('now')),
        excluded_by TEXT NOT NULL,
        reactivate_after TEXT,
        is_permanent INTEGER DEFAULT 0
      );
    `);
  } catch (e) {
    console.log(`[dental] dental_exclusions init skipped: ${(e as Error).message}`);
  }

  // dev-request 2026-07-03-places-api-cost-reduction, measure 2: shared-shape
  // call-usage log (same schema as the rfb copy in src/database/init.ts —
  // physically separate DB files, aggregated at read-time). Observability
  // only.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS places_api_call_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        vertical   TEXT NOT NULL,
        endpoint   TEXT NOT NULL,
        sku        TEXT NOT NULL,
        called_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  } catch (e) {
    console.log(`[dental] places_api_call_log init skipped: ${(e as Error).message}`);
  }

  // Indexes — wrapped in try/catch so re-deploy is safe
  const indexes = [
    "CREATE INDEX IF NOT EXISTS idx_dental_org_nr ON dental_agents(org_nr)",
    "CREATE INDEX IF NOT EXISTS idx_dental_fylke ON dental_agents(fylke)",
    "CREATE INDEX IF NOT EXISTS idx_dental_chain ON dental_agents(chain_brand)",
    "CREATE INDEX IF NOT EXISTS idx_dental_verification ON dental_agents(verification_status)",
    "CREATE INDEX IF NOT EXISTS idx_aff_person ON dental_clinic_affiliations(person_id)",
    "CREATE INDEX IF NOT EXISTS idx_aff_clinic ON dental_clinic_affiliations(clinic_agent_id)",
    "CREATE INDEX IF NOT EXISTS idx_persons_hpr ON dental_persons(hpr_nr)",
    "CREATE INDEX IF NOT EXISTS idx_excl_orgnr ON dental_exclusions(org_nr)",
    "CREATE INDEX IF NOT EXISTS idx_excl_url ON dental_exclusions(hjemmeside_url)",
    "CREATE INDEX IF NOT EXISTS idx_excl_reason ON dental_exclusions(reason)",
    "CREATE INDEX IF NOT EXISTS idx_places_api_call_log_called_at ON places_api_call_log(called_at)",
  ];
  for (const stmt of indexes) {
    try {
      db.exec(stmt);
    } catch (e) {
      console.log(`[dental] index init skipped: ${(e as Error).message}`);
    }
  }

  // ─── PR-100: additive schema extension for enrichment pipeline v1.3 ───
  // Adds 16 columns to dental_agents (6 geocoding + 10 deep-scrape).
  // Idempotent: PRAGMA table_info() gate ensures running twice is a no-op.
  // ALL columns are nullable TEXT/REAL — no backfill required, no breaking
  // change to existing reads. JSON columns are stored as TEXT.
  try {
    const existingColumns = new Set(
      (db.prepare('PRAGMA table_info(dental_agents)').all() as Array<{ name: string }>)
        .map((r) => r.name)
    );
    const newColumns: Array<[string, string]> = [
      // Geocoding (6)
      ['lat', 'REAL'],
      ['lng', 'REAL'],
      ['geocode_source', 'TEXT'],
      ['geocode_confidence', 'TEXT'],
      ['opening_hours', 'TEXT'],
      ['field_provenance', 'TEXT'],
      // Deep-scrape (10)
      ['om_oss', 'TEXT'],
      ['specialists', 'TEXT'],
      ['treatment_tech', 'TEXT'],
      ['equipment_brands', 'TEXT'],
      ['patient_focus', 'TEXT'],
      ['accessibility', 'TEXT'],
      ['payment_options', 'TEXT'],
      ['online_booking_url', 'TEXT'],
      ['social_media', 'TEXT'],
      ['treatments_subtypes', 'TEXT'],
    ];
    for (const [name, type] of newColumns) {
      if (!existingColumns.has(name)) {
        db.exec(`ALTER TABLE dental_agents ADD COLUMN ${name} ${type}`);
      }
    }
  } catch (e) {
    console.log(`[dental] PR-100 column extension skipped: ${(e as Error).message}`);
  }

  // ─── PR-104 (2026-06-03): Multi-worker record-claim infrastructure ───
  //   - worker_id: which scheduled-task / process has claimed this record.
  //   - claimed_at: Unix epoch ms when claim was made. Auto-released after
  //     CLAIM_TIMEOUT_MS (30 min) so a crashed worker doesn't lock records
  //     forever.
  const pr104Cols = [
    { name: "worker_id", sql: "ALTER TABLE dental_agents ADD COLUMN worker_id TEXT" },
    { name: "claimed_at", sql: "ALTER TABLE dental_agents ADD COLUMN claimed_at INTEGER" },
  ];
  for (const { name, sql } of pr104Cols) {
    try {
      db.exec(sql);
      console.log(`[init-dental] added column ${name}`);
    } catch (err: any) {
      if (!String(err.message ?? err).includes("duplicate column name")) throw err;
    }
  }

  // Index for claim queries — speeds up SELECT WHERE worker_id IS NULL AND ...
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_dental_claim ON dental_agents (worker_id, claimed_at)");
  } catch (err) {
    console.warn("[init-dental] PR-104 index creation warning:", err);
  }

  // ─── PR-130 (2026-06-27): Google Places rating + price-band provenance ──────
  //   Additive only — all new columns nullable, no backfill required.
  //   - rating REAL               Google Places rating (0.0–5.0, one decimal)
  //   - rating_count INTEGER       Google Places user_ratings_total
  //   - rating_source TEXT         provenance: 'google_places|YYYY-MM-DD'
  //   - price_band TEXT CHECK(...)  enum guard: rimelig | standard | premium | ukjent
  //                                NB: price_band (no CHECK) already exists from PR-89.
  //                                We leave the old column intact for backward-compat;
  //                                new writes target price_band (we add the CHECK via a
  //                                new column price_band_check that the store prefers).
  //                                Simplest migration: treat old price_band as-is, add
  //                                rating_count / rating / rating_source / price_band_source.
  //   - price_band_source TEXT     provenance: source + date price_band was set
  const pr130Cols: Array<{ name: string; sql: string }> = [
    { name: "rating",            sql: "ALTER TABLE dental_agents ADD COLUMN rating REAL" },
    { name: "rating_count",      sql: "ALTER TABLE dental_agents ADD COLUMN rating_count INTEGER" },
    { name: "rating_source",     sql: "ALTER TABLE dental_agents ADD COLUMN rating_source TEXT" },
    { name: "price_band_source", sql: "ALTER TABLE dental_agents ADD COLUMN price_band_source TEXT" },
  ];
  for (const { name, sql } of pr130Cols) {
    try {
      db.exec(sql);
      console.log(`[init-dental] PR-130 added column ${name}`);
    } catch (err: any) {
      if (!String(err.message ?? err).includes("duplicate column name")) throw err;
    }
  }

  // Index on rating — enables future "top-rated clinics" sort without full scan
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_dental_rating ON dental_agents (rating)");
  } catch (err) {
    console.warn("[init-dental] PR-130 rating index warning:", err);
  }

  // ─── dev-request 2026-07-03-places-api-cost-reduction, measure 1 ──────────
  //   Phase-2G no-retry marker — stops the same never-matching records from
  //   being re-sent to Google Places every cycle (was ~600+ wasted calls/mo).
  //   - places_attempted_at TEXT   ISO timestamp of the last real Places
  //                                lookup for this row (matched OR
  //                                no-confident-match; NEVER set on a
  //                                transport error — see safety note in the
  //                                dev-request, a transient 429/5xx/timeout
  //                                must not permanently starve a record).
  //   - places_match_status TEXT   'matched' | 'no_match' — informational.
  const placesAttemptCols: Array<{ name: string; sql: string }> = [
    { name: "places_attempted_at", sql: "ALTER TABLE dental_agents ADD COLUMN places_attempted_at TEXT" },
    { name: "places_match_status", sql: "ALTER TABLE dental_agents ADD COLUMN places_match_status TEXT" },
  ];
  for (const { name, sql } of placesAttemptCols) {
    try {
      db.exec(sql);
      console.log(`[init-dental] added column ${name}`);
    } catch (err: any) {
      if (!String(err.message ?? err).includes("duplicate column name")) throw err;
    }
  }
  try {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_dental_places_attempted ON dental_agents (places_attempted_at)"
    );
  } catch (err) {
    console.warn("[init-dental] places_attempted_at index warning:", err);
  }

  // ─── dev-request 2026-07-18-dental-hjemmeside-directory-portal-cleanup ────
  //   Additive-only: dental_agents.hjemmeside is meant to be a clinic's OWN
  //   homepage, but a lot of rows actually carry a directory-listing site, a
  //   booking portal, or an industry-association URL instead (legelisten.no,
  //   tannlegerinorge.no, ...), which pollutes downstream enrichment. Rather
  //   than deleting those bad values, POST /admin/dental/hjemmeside-cleanup-
  //   sweep (src/routes/admin-dental-hjemmeside-cleanup.ts) moves them here
  //   and clears hjemmeside — reversible, and directory_url IS NULL doubles
  //   as the "not yet cleaned" marker for that sweep's candidate query.
  //   Idempotent ALTER — error = already present.
  try {
    db.exec("ALTER TABLE dental_agents ADD COLUMN directory_url TEXT");
  } catch { /* already present */ }

  console.log("[dental] schema initialized");
}
