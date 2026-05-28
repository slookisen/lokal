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

  // Indexes — wrapped in try/catch so re-deploy is safe
  const indexes = [
    "CREATE INDEX IF NOT EXISTS idx_dental_org_nr ON dental_agents(org_nr)",
    "CREATE INDEX IF NOT EXISTS idx_dental_fylke ON dental_agents(fylke)",
    "CREATE INDEX IF NOT EXISTS idx_dental_chain ON dental_agents(chain_brand)",
    "CREATE INDEX IF NOT EXISTS idx_dental_verification ON dental_agents(verification_status)",
    "CREATE INDEX IF NOT EXISTS idx_aff_person ON dental_clinic_affiliations(person_id)",
    "CREATE INDEX IF NOT EXISTS idx_aff_clinic ON dental_clinic_affiliations(clinic_agent_id)",
    "CREATE INDEX IF NOT EXISTS idx_persons_hpr ON dental_persons(hpr_nr)",
  ];
  for (const stmt of indexes) {
    try {
      db.exec(stmt);
    } catch (e) {
      console.log(`[dental] index init skipped: ${(e as Error).message}`);
    }
  }

  console.log("[dental] schema initialized");
}
