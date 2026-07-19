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

  // Additive migration (boot-safe): slug column on experience_providers for
  // human-readable /tilbyder/<slug> URLs (opplevagent-site-quality increment).
  // ALTER TABLE ... ADD COLUMN is idempotent — error means column already exists.
  try { db.exec("ALTER TABLE experience_providers ADD COLUMN slug TEXT"); } catch { /* already present */ }
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_exp_prov_slug ON experience_providers(slug)"); } catch { /* already present */ }

  // ─── Gårdssalg / drikkeprodusent additive columns (Phase 0, 2026-06-28) ────
  // All additive — ALTER TABLE errors on re-deploy just mean already-present.
  const drikkecols = [
    "ALTER TABLE experience_providers ADD COLUMN producer_type TEXT",          // bryggeri|cideri|vingård|destilleri|mjøderi|seltzeri
    "ALTER TABLE experience_providers ADD COLUMN alcohol_categories TEXT",     // JSON: ['gruppe1','gruppe2','gruppe3']
    "ALTER TABLE experience_providers ADD COLUMN tasting_available INTEGER",   // 0|1
    "ALTER TABLE experience_providers ADD COLUMN visit_required INTEGER",      // 0|1 (required under the new gårdssalg law)
    "ALTER TABLE experience_providers ADD COLUMN legal_basis TEXT",            // 'existing-2016'|'pending-new-law'
    "ALTER TABLE experience_providers ADD COLUMN bevilling_status TEXT",       // unknown|holds|na
    "ALTER TABLE experience_providers ADD COLUMN commission_rate REAL",        // per-provider, null = platform default
    "ALTER TABLE experience_providers ADD COLUMN rfb_seed_source TEXT",        // 'rfb-seed' if seeded from RFB registry
    "CREATE INDEX IF NOT EXISTS idx_exp_prov_producer_type ON experience_providers(producer_type)",
  ];
  for (const stmt of drikkecols) {
    try { db.exec(stmt); } catch { /* already present */ }
  }

  // Phase-3 inert placeholders (not used until law proposisjon + counsel)
  const phase3cols = [
    "ALTER TABLE experience_providers ADD COLUMN purchase_cap_note TEXT",
    "ALTER TABLE experience_providers ADD COLUMN annual_volume_ledger_ref TEXT",
  ];
  for (const stmt of phase3cols) {
    try { db.exec(stmt); } catch { /* already present */ }
  }

  // ─── content-refresh attempt tracking (2026-07-05) ───────────────────────
  // selectProvidersForContentRefresh() ordered candidates by last_enriched_at
  // (set only on a SUCCESSFUL write), so a provider whose homepage is
  // permanently unreachable (dead site / wrong aggregator URL) never gets a
  // timestamp and sorts first FOREVER — starving every other candidate once
  // the eligible pool exceeds cap_per_run. This column is updated on every
  // content-refresh attempt regardless of outcome, so a repeatedly-failing
  // provider still cycles to the back of the queue instead of blocking it.
  try { db.exec("ALTER TABLE experience_providers ADD COLUMN last_content_attempt_at TEXT"); } catch { /* already present */ }

  // ─── FAQPage schema-drift guard (2026-07-05, orch-pr-faq-schema-drift-fixup) ──
  // getCategoryFaqStats()/getKommuneFaqStats() (PR #149) read experiences.fylke,
  // .kommune, .category, .price_from via COUNT(DISTINCT ...)/MIN(...). Git
  // archaeology confirms all four have been part of the ORIGINAL
  // `CREATE TABLE IF NOT EXISTS experiences (...)` above since the commit that
  // first created this table (9a0bbf7) — i.e. NOT schema drift under normal
  // circumstances, since CREATE TABLE IF NOT EXISTS only no-ops on a table that
  // already existed with an EARLIER, narrower column set, and no such earlier
  // version of this table exists in history. These ALTER TABLE ADD COLUMN
  // guards are added anyway, purely as free, provably-idempotent insurance
  // (identical pattern to every guard above) against any drift between this
  // git history and whatever actually shipped to the live Fly volume (e.g. an
  // out-of-band data restore) — a scenario we can't rule out without a live DB
  // shell. No-ops today; harmless if ever not.
  const faqStatsCols = [
    "ALTER TABLE experiences ADD COLUMN fylke TEXT",
    "ALTER TABLE experiences ADD COLUMN kommune TEXT",
    "ALTER TABLE experiences ADD COLUMN category TEXT",
    "ALTER TABLE experiences ADD COLUMN price_from INTEGER",
  ];
  for (const stmt of faqStatsCols) {
    try { db.exec(stmt); } catch { /* already present */ }
  }

  // ─── Phase 2 — Gårdssalg bookings (2026-06-28) ───────────────────────────
  // Attribution + attendance tracking for legally-required paid visits.
  // status lifecycle: reserved → confirmed_attended | no_show | cancelled
  // billable = 1 only when status = confirmed_attended (post-visit commission).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gardssalg_bookings (
        booking_id    TEXT PRIMARY KEY,
        experience_id TEXT,
        provider_id   TEXT NOT NULL,
        slot_at       TEXT NOT NULL,
        party_size    INTEGER NOT NULL DEFAULT 1,
        guest_name    TEXT NOT NULL,
        guest_email   TEXT NOT NULL,
        guest_phone   TEXT,
        booking_ref   TEXT UNIQUE NOT NULL,
        confirm_token TEXT UNIQUE NOT NULL,
        source        TEXT NOT NULL DEFAULT 'opplevagent',
        status        TEXT NOT NULL DEFAULT 'reserved'
                        CHECK(status IN ('reserved','confirmed_attended','no_show','cancelled')),
        resolved_by   TEXT,
        resolved_at   TEXT,
        commission_rate REAL,
        billable      INTEGER NOT NULL DEFAULT 0,
        notes         TEXT,
        created_at    TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (provider_id) REFERENCES experience_providers(id)
      )
    `);
  } catch (e) {
    console.log(`[experiences] gardssalg_bookings init skipped: ${(e as Error).message}`);
  }
  const bookingIndexes = [
    "CREATE INDEX IF NOT EXISTS idx_gsb_provider ON gardssalg_bookings(provider_id)",
    "CREATE INDEX IF NOT EXISTS idx_gsb_status   ON gardssalg_bookings(status)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_gsb_ref   ON gardssalg_bookings(booking_ref)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_gsb_token ON gardssalg_bookings(confirm_token)",
  ];
  for (const stmt of bookingIndexes) {
    try { db.exec(stmt); } catch { /* already present */ }
  }

  // ─── Geocode backfill columns (dev-request 2026-07-04-opplevagent-naer-meg-geosok,
  // item 1, 2026-07-10) ──────────────────────────────────────────────────────
  // Mirrors dental_agents' geocode_source/geocode_confidence columns exactly
  // (see init-dental.ts) so experiences-geocode-worker.ts can run the same
  // Kartverket address-geocoding + idempotent work-queue pattern against
  // experience_providers. geocode_confidence doubles as negative-cache: once
  // set to 'no_match' the row drops out of the WHERE lat IS NULL AND
  // geocode_confidence IS NULL work queue so dead addresses aren't retried
  // every tick.
  //
  // experiences.geo_precision records HOW a given experience's loc_lat/loc_lon
  // were resolved: 'address' = copied down from its provider's geocoded street
  // address (high/medium/low Kartverket confidence), 'kommune' = fallback
  // centroid via geocodingService (provider missing/ungeocodable, or experience
  // has no provider yet — harvest-first model). NULL = not yet resolved.
  const geocodeBackfillCols = [
    "ALTER TABLE experience_providers ADD COLUMN geocode_source TEXT",
    "ALTER TABLE experience_providers ADD COLUMN geocode_confidence TEXT",
    "ALTER TABLE experiences ADD COLUMN geo_precision TEXT",
  ];
  for (const stmt of geocodeBackfillCols) {
    try { db.exec(stmt); } catch { /* already present */ }
  }

  // ─── Dedup / canonical-merge columns (dev-request 2026-07-04-opplevagent-
  // dedup-og-norske-titler, item 1, 2026-07-10) ─────────────────────────────
  // Same real-world experience was harvested from multiple sources into
  // multiple DB rows (confirmed on prod /fylke/Oslo: Kon-Tiki Museet 4x, KOK
  // Oslo 3x, Astrup Fearnley 2x, RIB Oslo 2x, Klatreverket 2x, Teknisk Museum
  // 2x), polluting both the human browse pages and /api/opplevelser/discover.
  //
  // canonical_id: NULL means "this row IS canonical" (either never had a
  //   duplicate, or is the one duplicate-group member picked to keep). Set to
  //   another experiences.id when this row was folded into that canonical row
  //   by the dedup pass — every read path that surfaces experiences to humans
  //   or agents (discover, MCP, browse/sitemap listings) filters
  //   `canonical_id IS NULL` so a duplicate row never appears twice.
  // merged_from: JSON array of the ids merged INTO this (canonical) row, kept
  //   for auditability/rollback — never read by any query-layer filter.
  // ALTER TABLE ... ADD COLUMN is idempotent here — error means already-present.
  const dedupCols = [
    "ALTER TABLE experiences ADD COLUMN canonical_id TEXT",
    "ALTER TABLE experiences ADD COLUMN merged_from TEXT",
    "CREATE INDEX IF NOT EXISTS idx_exp_canonical_id ON experiences(canonical_id)",
  ];
  for (const stmt of dedupCols) {
    try { db.exec(stmt); } catch { /* already present */ }
  }

  // ─── Norwegian display-title column (dev-request 2026-07-04-opplevagent-
  // dedup-og-norske-titler, item 2, 2026-07-12) ─────────────────────────────
  // title_no: LLM-generated natural Norwegian display title for a CANONICAL
  //   row (canonical_id IS NULL) — merged-away duplicates never need one, the
  //   render path always resolves through the canonical row. NULL means "not
  //   backfilled yet" (or backfill deliberately skipped this row — never
  //   fabricated); every render path (experiences-seo.ts renderCard()/detail
  //   <h1>) falls back to the original `title` when NULL, so this column is
  //   purely additive and can never surface a broken/empty title. Backfilled
  //   via POST /admin/experiences-title-no-backfill (routes/opplevelser.ts).
  //   No index — never filtered/joined on, only ever read alongside `title`
  //   for the row already being rendered.
  // Same additive/idempotent idiom as the dedup-cols block above.
  const titleNoCols = [
    "ALTER TABLE experiences ADD COLUMN title_no TEXT",
  ];
  for (const stmt of titleNoCols) {
    try { db.exec(stmt); } catch { /* already present */ }
  }

  // ─── Gårdssalg content-enrichment columns (dev-request 2026-07-03-gardssalg-
  // rike-profiler-bilder-agentbooking, Fase 1 item 3, 2026-07-10) ─────────────
  // Additive columns for the multi-page-crawl enrichment slice that fills real
  // per-producer "Om produsenten" / "Besøket" / opening-hours copy on
  // GET /kategori/gardssalg/produsent/:providerSlug (PR #135), replacing the
  // generic, type-general placeholder documented in that route's comment block
  // until now. content_source mirrors the EXACT convention already used on the
  // `experiences` table (see applyExperienceContent / isExperienceContentLocked
  // in experience-store.ts and the lock-check in routes/opplevelser.ts ~line
  // 615): 'provider_site' = auto-filled by this crawl; 'manual'/'claim' =
  // locked, human/owner-authored, never auto-overwritten. last_content_attempt_at
  // (added above, 2026-07-05) is REUSED as-is for this slice's attempt
  // tracking via markProviderContentAttempted() — no new attempt-tracking
  // column here.
  const gardssalgContentCols = [
    "ALTER TABLE experience_providers ADD COLUMN about_text TEXT",
    "ALTER TABLE experience_providers ADD COLUMN visit_text TEXT",
    "ALTER TABLE experience_providers ADD COLUMN opening_hours_text TEXT",
    "ALTER TABLE experience_providers ADD COLUMN content_source TEXT",
    "ALTER TABLE experience_providers ADD COLUMN content_evidence_url TEXT",
    "ALTER TABLE experience_providers ADD COLUMN content_updated_at TEXT",
    // products (2026-07-12, gårdssalg RFB-enrichment slice): JSON array of the
    // drink products the producer sells (["Eplesider","Eplemost",…]). The
    // gårdssalg produsent page renders a "Produkter" section from this. NULL
    // until filled — either by the RFB-knowledge enrichment (agent_knowledge
    // .products, verified-quality only) or a future homepage-crawl pass. Kept
    // as its own column (not alcohol_categories, which holds legal alcohol
    // GROUPS gruppe1/2/3, not product names).
    "ALTER TABLE experience_providers ADD COLUMN products TEXT",
    // Dead-homepage parking (enrichment-metode slice 1, 2026-07-16): mirrors
    // agent_knowledge's PR #248 columns — consecutive fetch-failure counter +
    // park stamp at 3 (30d backoff). Both content-refresh selectors exclude
    // parked providers unless EXPERIENCES_HOMEPAGE_PARKING_DISABLED=true.
    "ALTER TABLE experience_providers ADD COLUMN homepage_fetch_attempts INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE experience_providers ADD COLUMN homepage_unreachable_since TEXT",
    // field_provenance (dev-request 2026-07-18-gardssalg-profilkvalitet-foer-
    // outreach, slice 1 — rollback/provenance substrate): JSON object, one
    // entry per gårdssalg-content-pipeline-written field, e.g.
    // {"about_text":{"source_url":"...","fetched_at":"..."}, "visit_text":{...}}.
    // NOT the same thing as rfb's agent_knowledge.field_provenance (an array-
    // per-field, multi-source, evidence-graded model used for verification/
    // locking decisions there) — see the "LOCK MODEL (experiences-native;
    // there is no rfb-style field_provenance here)" comment in
    // experience-store.ts, which is about content-write LOCKING and is
    // unaffected by this column. This column exists purely so a future
    // batch content-improvement pass has a per-field "where did this value
    // come from and when" record to show alongside the gardssalg_content_audit
    // changelog (below) — it does not gate/lock any write path. Written by
    // applyGardssalgProviderContent() (read-modify-write merge, never
    // clobbers other fields' entries); read by nothing yet in this slice.
    "ALTER TABLE experience_providers ADD COLUMN field_provenance TEXT",
  ];
  for (const stmt of gardssalgContentCols) {
    try { db.exec(stmt); } catch { /* already present */ }
  }

  // ─── gardssalg_content_audit (dev-request 2026-07-18-gardssalg-
  // profilkvalitet-foer-outreach, slice 1) ───────────────────────────────────
  // Insert-only, field-level changelog for every value the gårdssalg
  // content-refresh pipeline (applyGardssalgProviderContent) writes onto
  // experience_providers. Mirrors agent_knowledge_audit's shape/purpose in
  // src/database/init.ts (~line 1632) — this fleet's established convention
  // for a reversible-write audit trail — adapted to this vertical's provider
  // rows. Built BEFORE any batch content-improvement writes happen: Daniel
  // agreed to run the 74-producer content-quality pass in one batch with NO
  // canary, on the condition that every field write is reversible via this
  // audit trail (see POST /admin/gardssalg-content-rollback in
  // routes/opplevelser.ts), proven working first. This slice adds ONLY the
  // audit/provenance substrate — it does not change what content gets
  // written.
  // FK ON DELETE CASCADE: orphan-audits cleaned up if a provider is ever
  // deleted (mirrors agent_knowledge_audit's FK).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gardssalg_content_audit (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        source_url TEXT,
        batch_id TEXT,
        changed_by TEXT NOT NULL DEFAULT 'system',
        changed_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (provider_id) REFERENCES experience_providers(id) ON DELETE CASCADE
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_gardssalg_content_audit_provider ON gardssalg_content_audit(provider_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_gardssalg_content_audit_batch ON gardssalg_content_audit(batch_id)`);
  } catch (err) {
    console.error("Migration gardssalg_content_audit failed:", err);
  }

  // ─── gardssalg_orgnr_review_queue (dev-request 2026-07-18-gardssalg-
  // profilkvalitet-foer-outreach, slice 5b) ───────────────────────────────────
  // Every gårdssalg provider whose org_nr the Brreg-name-search backfill
  // (POST /admin/gardssalg-orgnr-backfill) could NOT auto-confirm — either no
  // Brreg candidate was found at all, or a candidate was found but failed the
  // exact-name + kommune/poststed corroboration bar (Daniel's binding
  // identitetskrav, slice 4-GO: "ved tvil: ikke skriv") — lands here instead
  // of being written. One row per provider (UNIQUE(provider_id)): a rerun of
  // the backfill route upserts in place rather than accumulating duplicate
  // rows, mirroring hanen_unmatched_members's (src/database/init.ts)
  // refresh-on-rerun idiom — this fleet's established pattern for a durable,
  // human-triageable "couldn't auto-resolve" list (as opposed to the
  // ephemeral `unresolved[]` array the route also returns per-run). No UI
  // reads this yet; it exists so Daniel/CS has something queryable once a
  // triage surface is built, same deferred-UI rationale as
  // hanen_unmatched_members.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gardssalg_orgnr_review_queue (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL UNIQUE,
        provider_name TEXT,
        candidate_orgnr TEXT,
        candidate_name TEXT,
        candidate_confidence REAL,
        candidate_address TEXT,
        reason TEXT NOT NULL,
        batch_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (provider_id) REFERENCES experience_providers(id) ON DELETE CASCADE
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_gardssalg_orgnr_review_queue_reason ON gardssalg_orgnr_review_queue(reason)`);
  } catch (err) {
    console.error("Migration gardssalg_orgnr_review_queue failed:", err);
  }

  // ─── gardssalg_website_review_queue (dev-request 2026-07-19-gardssalg-
  // nye-agenter-komplett-foer-synlig, skive B) ───────────────────────────────
  // Website-discovery candidates for gårdssalg providers whose hjemmeside is
  // blank: a domain-pattern candidate that VERIFIED (the fetched page carries
  // the provider's org_nr, or its exact name together with its kommune/
  // poststed) lands here — NEVER written directly to the row. Adoption goes
  // through POST /admin/gardssalg-website-review-approve, the same strict
  // confirmation-surface contract as the org_nr queue: only the queued
  // (provider_id, url) pair can be approved. Deliberately a SEPARATE table
  // from gardssalg_orgnr_review_queue (whose UNIQUE(provider_id) upsert
  // idiom this mirrors): sharing that table would make a website candidate
  // overwrite a provider's pending org_nr candidate and vice versa —
  // two different decisions must not evict each other.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gardssalg_website_review_queue (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL UNIQUE,
        provider_name TEXT,
        candidate_url TEXT NOT NULL,
        final_url TEXT,
        evidence TEXT,
        confidence REAL,
        reason TEXT NOT NULL DEFAULT 'website_discovery_candidate',
        batch_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (provider_id) REFERENCES experience_providers(id) ON DELETE CASCADE
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_gardssalg_website_review_queue_reason ON gardssalg_website_review_queue(reason)`);
  } catch (err) {
    console.error("Migration gardssalg_website_review_queue failed:", err);
  }

  // Per-provider attempt stamp for website discovery (skive B) — its own
  // column, NOT last_content_attempt_at (that one orders the content-refresh
  // selector; overloading it would let a website-discovery sweep push
  // never-content-refreshed rows to the back of the content queue). Same
  // anti-starvation role as the content stamp: the discovery selector orders
  // never-attempted first, then oldest attempt.
  try {
    db.exec("ALTER TABLE experience_providers ADD COLUMN website_discovery_attempted_at TEXT");
  } catch { /* already present */ }

  // ─── Gårdssalg dark-launch-stop (dev-request 2026-07-12-gardssalg-dark-
  // launch-stop, slice 0) ────────────────────────────────────────────────────
  // The gårdssalg booking flow has been live on prod since 2026-07-03 but no
  // producer is ever notified of a reservation and no producer has been
  // onboarded — a trust/reputation risk. booking_live is the per-provider
  // gate a FUTURE onboarding slice will flip to 1 once a given producer has
  // actually agreed to receive bookings; it defaults to 0 (not live) so every
  // existing row is safe the instant this column exists. Read alongside the
  // BOOKING_DISPATCH_ENABLED env flag (see bookingDispatchEnabled() /
  // isBookingPaused() in services/booking-store.ts) — booking submission and
  // the "coming soon" UI notices both gate on the pair, not on this column
  // alone. This slice only adds the column; nothing sets it to 1 yet.
  try {
    db.exec("ALTER TABLE experience_providers ADD COLUMN booking_live INTEGER DEFAULT 0");
  } catch { /* already present */ }

  // ─── Booking-flyt-v1 hidden test provider (dev-request 2026-07-14-booking-
  // flyt-v1, slice 0) ─────────────────────────────────────────────────────────
  // catalog_hidden gates a provider OUT of the public gårdssalg catalog + count
  // (listGardssalgProviders()/countGardssalgProviders() filter rows carrying it)
  // while keeping it fully bookable by slug (getGardssalgProviderBySlug() does
  // NOT filter) — the mechanism behind a controlled end-to-end booking test
  // whose producer notification is routed only to Daniel's inbox. Defaults 0
  // (visible) so every existing row keeps today's behavior the instant this
  // column exists; nothing but the admin test-provider endpoint ever sets it 1.
  try {
    db.exec("ALTER TABLE experience_providers ADD COLUMN catalog_hidden INTEGER DEFAULT 0");
  } catch { /* already present */ }

  // ─── Booking-flyt-v1 slice 2 — pre-visit e-post-svarsløyfe (dev-request
  // 2026-07-14-booking-flyt-v1, slice 2) ─────────────────────────────────────
  // The existing status/confirm_token pair is strictly POST-visit (attendance
  // → billable/commission) and is untouched. This block adds the PRE-visit
  // request→answer loop as its own parallel state machine:
  //
  //   pre_status: awaiting_provider → provider_confirmed | provider_declined
  //                                 | time_suggested (→ confirmed/declined via
  //                                   the guest's decision) | expired
  //
  //   respond_token / respond_token_expires_at / respond_token_used_at —
  //     the PRODUCER's one-time, expiring credential for the
  //     /kategori/gardssalg/svar/:token answer page (Bekreft / Foreslå nytt
  //     tidspunkt / Avslå). used_at is stamped on a TERMINAL answer.
  //   suggested_slot_at + guest_decision_token — set when the producer
  //     suggests a new time; the guest's one-shot-for-action accept/decline
  //     credential for /kategori/gardssalg/gjestesvar/:token.
  //   guest_status_token — the guest's always-readable (never-mutating)
  //     status-page credential (/kategori/gardssalg/status/:ref/:token).
  //   reminder_sent_at / expired_guest_notified_at — one-shot markers for the
  //     producer reminder and the guest's "expired, sorry" notification, so
  //     processBookingFollowups() stays idempotent.
  //
  // pre_status defaults to 'awaiting_provider', but rows created BEFORE this
  // slice have respond_token NULL — every pre-visit read/followup path
  // requires respond_token IS NOT NULL, so legacy rows keep today's behavior
  // (post-visit flow only) and are never reminded/expired retroactively.
  // ALTER TABLE ADD COLUMN is idempotent here — error means already-present.
  const previsitCols = [
    "ALTER TABLE gardssalg_bookings ADD COLUMN pre_status TEXT NOT NULL DEFAULT 'awaiting_provider'",
    "ALTER TABLE gardssalg_bookings ADD COLUMN respond_token TEXT",
    "ALTER TABLE gardssalg_bookings ADD COLUMN respond_token_expires_at TEXT",
    "ALTER TABLE gardssalg_bookings ADD COLUMN respond_token_used_at TEXT",
    "ALTER TABLE gardssalg_bookings ADD COLUMN suggested_slot_at TEXT",
    "ALTER TABLE gardssalg_bookings ADD COLUMN guest_decision_token TEXT",
    "ALTER TABLE gardssalg_bookings ADD COLUMN guest_status_token TEXT",
    "ALTER TABLE gardssalg_bookings ADD COLUMN reminder_sent_at TEXT",
    "ALTER TABLE gardssalg_bookings ADD COLUMN expired_guest_notified_at TEXT",
    // Unique lookup indexes — SQLite unique indexes allow any number of NULLs,
    // so legacy rows (all tokens NULL) are unaffected.
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_gsb_respond_token ON gardssalg_bookings(respond_token)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_gsb_guest_decision_token ON gardssalg_bookings(guest_decision_token)",
    "CREATE INDEX IF NOT EXISTS idx_gsb_pre_status ON gardssalg_bookings(pre_status)",
  ];
  for (const stmt of previsitCols) {
    try { db.exec(stmt); } catch { /* already present */ }
  }

  console.log("[experiences] schema initialized");
}
