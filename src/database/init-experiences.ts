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

  // ─── content-refresh no-yield backoff (dev-request 2026-07-20-experiences-
  // no-yield-backoff) ─────────────────────────────────────────────────────
  // Ports the RFB/marketplace.ts no_yield_streak idea to this vertical: a
  // provider whose homepage fetch succeeds but yields zero extractable fields
  // 3 times running rests NO_YIELD_BACKOFF_DAYS days (same env var, default
  // 14 — see selectProvidersForContentRefresh) before being reselected; any
  // successful field-write resets the streak to 0. Reuses the existing
  // last_content_attempt_at column above as the backoff clock — no new
  // timestamp column needed.
  try { db.exec("ALTER TABLE experience_providers ADD COLUMN content_no_yield_streak INTEGER NOT NULL DEFAULT 0"); } catch { /* already present */ }

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
  //
  // meeting_point_geocode_attempted_at (dev-request 2026-07-25-reisesok, Fase
  // 1b, review B2) is the NEGATIVE CACHE for Step F. Step F re-attempts
  // kommune-precision rows at address level from `meeting_point`, and its two
  // give-up paths (the text is not address-shaped / Kartverket found nothing)
  // originally wrote nothing at all — so the unresolvable residue was
  // re-selected identically every hour forever AND starved every row behind
  // the LIMIT (measured: 3 ticks, byte-identical query list, rows 4-6 never
  // reached; ~100 futile requests/hour against a free public API). It is now
  // stamped on EVERY Step F attempt whatever the outcome, and the selector
  // orders by it (never-attempted first), so failures rotate to the back of
  // the queue instead of blocking it. Same lesson as
  // agent_knowledge.last_enrichment_attempt_at (dev-request 2026-07-19) and
  // agents.geocode_attempted_at (Fase 1a).
  const geocodeBackfillCols = [
    "ALTER TABLE experience_providers ADD COLUMN geocode_source TEXT",
    "ALTER TABLE experience_providers ADD COLUMN geocode_confidence TEXT",
    "ALTER TABLE experiences ADD COLUMN geo_precision TEXT",
    "ALTER TABLE experiences ADD COLUMN meeting_point_geocode_attempted_at TEXT",
  ];
  for (const stmt of geocodeBackfillCols) {
    try { db.exec(stmt); } catch { /* already present */ }
  }

  // ─── Content provenance for experiences rows (dev-request 2026-07-27-
  // kvalitetsporter-uten-signal, round-5 review) ────────────────────────────
  // `experiences.evidence_url` is DISCOVERY provenance: it records the page the
  // harvester found the listing on, is written once at createExperience(), and
  // is never touched again. applyExperienceContent() — the writer that fills
  // description/category/booking_url — stamps `content_source = 'provider_site'`
  // unconditionally and writes no URL at all, so nothing in the row says where
  // the CONTENT came from.
  //
  // That gap is not theoretical. applyExperienceContent has three callers: the
  // twice-daily content-refresh, which fetched the provider's homepage, and two
  // bulk-load paths that hand it a THIRD-PARTY HARVEST ROW on a re-harvest that
  // scored richer. Both end up labelled 'provider_site'. A weekly spot-check
  // that fetches the homepage and judges the text against it therefore scores a
  // false `mismatch` on the harvest-written rows — and §8.4 of the
  // platform-verifier SKILL pauses enrichment writes for the whole vertical
  // above a 10% error rate.
  //
  // An earlier attempt to infer this from `evidence_url` was wrong in BOTH
  // directions and was caught in review: it hid homepage-refreshed rows that
  // still carried their original aggregator discovery URL (a fresh route to the
  // `checked=0` this dev-request exists to remove), while still admitting the
  // re-harvest case it was written for, whose evidence_url is untouched.
  //
  // `experience_providers` already solved this exact problem with
  // `content_evidence_url`, stamped by applyProviderContent(). This mirrors it
  // for experiences rather than inventing a second convention. NULL means
  // "written before this column existed" — treated as unknown, never as a
  // mismatch.
  // PER-FIELD, not one URL for the row: applyExperienceContent only fills BLANK
  // fields, so a row's fields come from different sources at different times and
  // a single column records only the last writer (round-6 review). The consumer
  // judges per field, so the map is what the question actually needs.
  // JSON object: { "<field>": "<url the value was extracted from>" }.
  // Only the per-field map. A row-level `content_evidence_url` was added here
  // during round 5 and superseded by the map in round 6; keeping the ALTER left
  // a column nothing writes, projected on every row as a permanent `null`
  // BESIDE a meaningful same-named key on the provider object — two identical
  // names at two levels, one always null, in a response an LLM reads
  // (round-7 review). Dropped rather than left as decoration.
  const experienceContentProvenanceCols = [
    "ALTER TABLE experiences ADD COLUMN content_field_evidence TEXT",
  ];
  for (const stmt of experienceContentProvenanceCols) {
    try { db.exec(stmt); } catch { /* already present */ }
  }

  // ─── Harvest admission-gate verdict columns (dev-request 2026-06-23-
  // experiences-richer-profiles, faithfulness-inflow slice, 2026-08-25) ──────
  // POST /admin/bulk-load (apply mode) now runs each NEW evidence-backed row
  // through the fail-closed LLM content judge (judgeExperienceContentMatch,
  // experience-content-judge.ts) BEFORE admitting it as `verified`: the judge
  // grades the candidate's own title/category/price against the live
  // evidence_url page. A MISMATCH or an unresolvable check (fetch failure,
  // judge failure, per-request judge-budget cap) still INSERTS the row —
  // never drop harvested data — but forces verification_status='needs_review'
  // regardless of what the Brreg classification would have granted.
  //
  // admission_verdict: human-inspectable outcome text, "<match|mismatch|
  //   unresolved>: <judge reasoning>" — the reasoning is what makes a
  //   quarantined row reviewable without re-running the judge. NULL means
  //   "never gated" (pre-gate rows, rows without an evidence_url, rows
  //   admitted via a dry-run-only call, or non-bulk-load writers).
  // admission_checked_at: when the gate ran for this row (datetime('now'),
  //   same convention as brreg_checked_at). NULL whenever admission_verdict
  //   is NULL.
  // Same additive/idempotent ALTER idiom as the provenance block above; both
  // columns are stamped only by stampExperienceAdmissionVerdict()
  // (experience-store.ts) and read by humans/report tooling, never by any
  // query-layer filter — so no index.
  const admissionGateCols = [
    "ALTER TABLE experiences ADD COLUMN admission_verdict TEXT",
    "ALTER TABLE experiences ADD COLUMN admission_checked_at TEXT",
  ];
  for (const stmt of admissionGateCols) {
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

  // ─── gardssalg_content_audit.notes (dev-request 2026-08-08-booking-
  // aktivering-per-produsent) ─────────────────────────────────────────────
  // Additive, nullable column — every existing row/insert is untouched
  // (defaults to NULL). Mirrors agent_knowledge_audit's own `notes` column
  // (database/init.ts, ~L2053 — this table's own header comment already
  // names agent_knowledge_audit as the shape/purpose this table mirrors),
  // so the admin booking-activation lever (POST
  // /admin/gardssalg-booking-activation, routes/opplevelser.ts) can preserve
  // the operator's written reason for flipping booking_live per audit row,
  // without inventing a second/parallel audit table.
  try {
    db.exec("ALTER TABLE gardssalg_content_audit ADD COLUMN notes TEXT");
  } catch { /* already present */ }

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

  // ─── provider_work_queue (dev-request 2026-08-17-forsyningskjede-
  // samarbeid-og-kvalitetsoppdatering, Skive 1) ───────────────────────────────
  // Shared hand-off queue between the three gårdssalg pipelines (ownership-
  // verification sweep, content-enrichment "berikelse", and website-discovery
  // "discovery") so they hand each other work instead of silently dropping
  // cases: sweep → discovery (missing_source / evidence_url_rejected),
  // berikelse → discovery (parked_needs_replacement), discovery → sweep
  // (resolved when a discovered candidate is written to hjemmeside).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_work_queue (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        provider_name TEXT,
        from_system TEXT NOT NULL,      -- 'sweep' | 'berikelse' | 'discovery'
        to_system TEXT NOT NULL,        -- 'sweep' | 'discovery'
        reason TEXT NOT NULL,           -- 'missing_source' | 'evidence_url_rejected' | 'parked_needs_replacement'
        payload TEXT,                   -- JSON, nullable (e.g. {"rejected_url": "..."})
        batch_id TEXT,
        requested_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        outcome TEXT,
        FOREIGN KEY (provider_id) REFERENCES experience_providers(id) ON DELETE CASCADE
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_provider_work_queue_to_system_resolved ON provider_work_queue(to_system, resolved_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_provider_work_queue_provider_id ON provider_work_queue(provider_id)`);
  } catch (err) {
    console.error("Migration provider_work_queue failed:", err);
  }

  // ─── gardssalg_autosvar_review_queue (dev-request 2026-08-16-opplevagent-
  // outreach-rutine, "Autosvar-regelen") ─────────────────────────────────────
  // GET /admin/gardssalg-autosvar-scan (above, in the routes file) detects an
  // inbound autoreply that redirects to an alternative contact email; POST
  // /admin/gardssalg-autosvar-apply auto-applies ONLY the domain_match case
  // (the candidate email's host agrees with the provider's own hjemmeside).
  // A domain_mismatch or no_website_on_file candidate is NEVER written to
  // epost directly ("Ved domene-avvik: legg i review-kø, aldri auto-bytt") —
  // it lands here instead, for a human to resolve via
  // POST /admin/gardssalg-autosvar-review-approve. One row per provider
  // (UNIQUE(provider_id)): a rerun of the apply route upserts in place rather
  // than accumulating duplicate rows, same refresh-on-rerun idiom as
  // gardssalg_orgnr_review_queue/gardssalg_website_review_queue above.
  // `contact_email` holds the provider's OLD epost (as of the run that queued
  // the row) purely for diffing/display — it is never itself written or read
  // back by the approve route, which always re-reads the live row.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gardssalg_autosvar_review_queue (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL UNIQUE,
        provider_name TEXT,
        candidate_email TEXT NOT NULL,
        contact_email TEXT,
        matched_phrase TEXT,
        classification TEXT NOT NULL,
        thread_id TEXT,
        message_id TEXT,
        reason TEXT NOT NULL DEFAULT 'autosvar_redirect_candidate',
        batch_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (provider_id) REFERENCES experience_providers(id) ON DELETE CASCADE
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_gardssalg_autosvar_review_queue_reason ON gardssalg_autosvar_review_queue(reason)`);
  } catch (err) {
    console.error("Migration gardssalg_autosvar_review_queue failed:", err);
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
  // AND, as of the 2026-08-17 P0 consent-bug fix, out of slug lookup too
  // (getGardssalgProviderBySlug() now filters it — see that function's doc
  // comment in services/experience-store.ts). Originally this column also
  // kept a catalog_hidden=1 row fully bookable by slug, as the mechanism
  // behind a controlled end-to-end booking test whose producer notification
  // is routed only to Daniel's inbox — that is no longer true; a hidden row
  // is unreachable via its public slug on every surface now, no exceptions.
  // Defaults 0 (visible) so every existing row keeps today's behavior the
  // instant this column exists; set by the admin test-provider endpoint AND
  // by POST /admin/gardssalg-provider-visibility (the real-producer delist
  // lever added later — see that route's own comment).
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
    // dev-request 2026-07-26-booking-test-send-guard: marks a booking (and,
    // below, a claim) as a deliberate end-to-end test, so every outgoing
    // email in that one transaction is redirected to TEST_SEND_REDIRECT_EMAIL
    // and the row can be filtered out of stats/reports. Defaults to 0 —
    // every existing row and every non-admin booking path is unaffected.
    // (The matching gardssalg_claims column is added next to that table's own
    // CREATE below — it is created later in this file than this block runs.)
    "ALTER TABLE gardssalg_bookings ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0",
    "CREATE INDEX IF NOT EXISTS idx_gsb_is_test ON gardssalg_bookings(is_test)",
  ];
  for (const stmt of previsitCols) {
    try { db.exec(stmt); } catch { /* already present */ }
  }

  // ─── listing_url (dev-request 2026-07-12-experiences-enrichment-supply-
  // and-aggregator-hygiene, Daniel's 2026-07-19 decision, step 1) ───────────
  // A chunk of experience_providers.hjemmeside rows carry a DMO/aggregator/
  // directory URL (visitnorway.no, tripadvisor.com, ...) instead of the
  // provider's OWN homepage — a catalog/listing page, not the site itself.
  // POST /admin/hjemmeside-cleanup-sweep (src/routes/opplevelser.ts) moves
  // those values OUT of hjemmeside and INTO this additive column, clearing
  // hjemmeside so it stops polluting downstream enrichment/content-refresh.
  // NULL until a row is swept; NULL also doubles as this sweep's "not yet
  // moved" candidate marker (hjemmeside IS NOT NULL AND listing_url IS NULL).
  // Purely additive — every existing row is unaffected (NULL default) until
  // explicitly swept. Re-discovering the real homepage from this value
  // (listing-page-link -> Brreg -> Google Places) is step 2, an explicitly
  // deferred future slice — not built here.
  try { db.exec("ALTER TABLE experience_providers ADD COLUMN listing_url TEXT"); } catch { /* already present */ }

  // ─── experience_homepage_review_queue (dev-request 2026-07-12-experiences-
  // enrichment-supply-and-aggregator-hygiene, Daniel's decision, step 2,
  // evidence-leg (a)) ─────────────────────────────────────────────────────
  // Step 1 (above) moved a chunk of hjemmeside values that were actually DMO/
  // aggregator catalog URLs into listing_url. This queue is where step 2's
  // evidence-leg (a) parks its findings: POST /admin/listing-homepage-
  // discovery (src/routes/opplevelser.ts) fetches a provider's listing_url,
  // finds the provider's OWN outbound website link on that page, and — only
  // if the provider's name is verified present on the candidate site's own
  // text — upserts a row here. NEVER written straight to hjemmeside; adoption
  // goes through POST /admin/listing-homepage-review-approve, the same
  // strict confirmation-surface contract as gardssalg_website_review_queue's
  // approve lever. Deliberately a SEPARATE table from
  // gardssalg_website_review_queue (this queue is gårdssalg-agnostic — any
  // vertical's provider can land here) — sharing that table would conflate
  // two different discovery methods' provenance/evidence shapes.
  // UNIQUE(provider_id) mirrors the gårdssalg twin's refresh-on-rerun upsert
  // idiom: at most one pending candidate per provider; a later scan can
  // re-upsert over an already-resolved (approved/rejected) row the same way.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS experience_homepage_review_queue (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL UNIQUE,
        provider_name TEXT,
        candidate_url TEXT NOT NULL,
        final_url TEXT,
        evidence TEXT,
        confidence REAL,
        reason TEXT NOT NULL DEFAULT 'listing_page_link_candidate',
        batch_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        FOREIGN KEY (provider_id) REFERENCES experience_providers(id) ON DELETE CASCADE
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_experience_homepage_review_queue_status ON experience_homepage_review_queue(status)`);
  } catch (err) {
    console.error("Migration experience_homepage_review_queue failed:", err);
  }

  // Per-provider attempt stamp for listing-homepage discovery (step 2,
  // evidence-leg (a)) — its own column, same anti-starvation role/convention
  // as website_discovery_attempted_at above: the discovery selector orders
  // never-attempted rows first, then oldest attempt.
  try {
    db.exec("ALTER TABLE experience_providers ADD COLUMN listing_homepage_discovery_attempted_at TEXT");
  } catch { /* already present */ }

  // Per-provider attempt stamp for Brreg-website discovery (step 2,
  // evidence-leg (b)) — its OWN column, independent of leg (a)'s
  // listing_homepage_discovery_attempted_at above: a provider with no
  // listing-page candidate should still get a turn at the Brreg leg, and
  // vice versa. Same idempotent ALTER TABLE idiom, same anti-starvation
  // rotation-stamp role.
  try {
    db.exec("ALTER TABLE experience_providers ADD COLUMN brreg_website_discovery_attempted_at TEXT");
  } catch { /* already present */ }

  // Per-provider attempt stamp for web-search homepage discovery (step 2,
  // evidence-leg (d)) — its OWN column, independent of legs (a)/(b) above:
  // the residual cohort this leg targets (no org_nr AND no listing_url) never
  // qualifies as a candidate for either leg (a)'s listing_url-driven fetch or
  // leg (b)'s org_nr-driven Brreg lookup), so it needs its own anti-
  // starvation rotation cursor rather than reusing either sibling column.
  // There is no server-side web-search/LLM capability in this app — GET
  // /admin/providers/homepage-open-uncovered (src/routes/opplevelser.ts)
  // surfaces the residual cohort for an external researcher (human or
  // orchestrator session) to look up, and POST /admin/homepage-review-queue/
  // submit stamps this column once a candidate has been submitted (queued or
  // rejected) so the same rows aren't repeatedly resurfaced. Same idempotent
  // ALTER TABLE idiom as its two siblings.
  try {
    db.exec("ALTER TABLE experience_providers ADD COLUMN web_search_homepage_attempted_at TEXT");
  } catch { /* already present */ }

  // ─── gardssalg_claims (dev-request 2026-07-21-opplevagent-claim-flyt-
  // drikkeprodusenter) ──────────────────────────────────────────────────────
  // Producer owner-claim flow for gårdssalg profiles on opplevagent.no.
  // MIRRORS (does not reuse/modify) RFB's rettfrabonden.com magic_links table
  // (src/database/init.ts) — same shape, same lifecycle (issue -> verify
  // (used=1) -> session), same 7-day expiry convention — but lives in its OWN
  // table in THIS (experiences.db) database, matching how RFB's magic_links
  // and its `agents`/`agent_knowledge` rows live entirely in lokal.db while
  // experience_providers lives here (db-factory.ts's per-vertical DB-file
  // isolation invariant). Reusing the RFB table directly was not an option
  // (cross-file FK, and it would blur RFB/experiences isolation); reusing the
  // PATTERN while keeping the table vertical-scoped is the deliberate choice
  // here (see the route file's module doc for the full rationale).
  //
  // email: the ORG-LINKED target address the link was actually sent to
  //   (Brreg-contact-email or post@<ownership-verified-domain> — see
  //   deriveOrgLinkedEmail() in services/gardssalg-claim.ts). Never a
  //   free-text address the requester typed in — there is no such input on
  //   this flow, by design (Daniel's "never open claiming by name alone").
  // used / used_at: same semantics as magic_links — used=1 once the link is
  //   clicked and the token verified; the session (cookie/Bearer) then reads
  //   off this row same as RFB's verifyOwnerSession().
  // revoked_at: NOT present on RFB's magic_links (RFB's "logout" only clears
  //   the browser cookie; the underlying token stays a valid Bearer
  //   credential until its 7-day expiry). This column is an intentional,
  //   additive improvement over the mirrored pattern — real GDPR-minimum
  //   revocation (POST logout sets this, and verifyGardssalgOwnerSession()
  //   rejects any token with revoked_at set, cookie or Bearer alike) — NOT a
  //   change to RFB's own owner-portal.ts, which is untouched.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gardssalg_claims (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES experience_providers(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        email_source TEXT NOT NULL, -- 'brreg_contact' | 'verified_domain_address' | 'stored_epost_verified' | 'found_same_domain' | 'found_contact_page' | 'found_site_other' | 'found_umbrella_member'
        -- 'stored_epost_verified' added dev-request 2026-07-30-opplevagent-
        -- claim-epost-og-perfelt-laas item 1: the provider's own epost
        -- value, issued only when backed by real provenance -- see
        -- deriveOrgLinkedEmail()'s module doc in services/gardssalg-claim.ts.
        -- 'found_same_domain' | 'found_contact_page' | 'found_site_other'
        -- added dev-request 2026-08-06-aldri-gjett-epostadresse SLICE 2
        -- (2026-08-07) -- see gardssalg-claim.ts's
        -- deriveOrgLinkedEmailCandidatesWithHarvest(); 'found_umbrella_member'
        -- added by that dev-request's SLICE 4 as the fallback below those
        -- three (an address published by the producer's umbrella org, matched
        -- to the producer by name -- see harvestUmbrellaMemberEmail()).
        -- All four were documentation ahead of first use until SLICE 5 / AC7
        -- (2026-08-07) live-wired the harvest into issueClaimMagicLink() and
        -- the public claim-entry route; they are reachable from a live INSERT
        -- into this table from that slice onwards.
        -- Column stays untyped TEXT; every change here has been comment-only,
        -- no migration needed.
        token TEXT NOT NULL UNIQUE,
        used INTEGER NOT NULL DEFAULT 0,
        used_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        -- dev-request 2026-07-26-booking-test-send-guard: marks a claim as a
        -- deliberate end-to-end test so its magic-link email is redirected to
        -- TEST_SEND_REDIRECT_EMAIL. Defaults to 0; only an admin-gated call
        -- can set it.
        is_test INTEGER NOT NULL DEFAULT 0
      )
    `);
    // Same column for DBs created before the guard landed (CREATE TABLE IF NOT
    // EXISTS above is a no-op for them). Idempotent — error means present.
    try { db.exec(`ALTER TABLE gardssalg_claims ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0`); } catch { /* already present */ }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_gardssalg_claims_token ON gardssalg_claims(token)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_gardssalg_claims_provider ON gardssalg_claims(provider_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_gardssalg_claims_created ON gardssalg_claims(provider_id, created_at)`);
  } catch (e) {
    console.log(`[experiences] gardssalg_claims init skipped: ${(e as Error).message}`);
  }

  // ─── claimed_at (dev-request 2026-08-03-claim-bekreftet-merke-og-innlogging)
  // ────────────────────────────────────────────────────────────────────────
  // Additive, explicit "has this profile ever been claimed" signal — distinct
  // from isGardssalgProviderClaimed() (services/gardssalg-claim.ts), which is
  // a LIVE, REVOCABLE query (COUNT of used=1 AND revoked_at IS NULL claims)
  // used for the owner-portal session gate. This column is the opposite
  // semantic on purpose: a historical "has been verified by the owner at
  // least once" badge for the public produsent-profil page, set ONLY inside
  // verifyClaimToken()'s transaction (gardssalg-claim.ts) the first time a
  // magic link is actually used, and NEVER cleared by revokeClaimToken() — a
  // later revoke/logout does not un-badge the profile (AC6). Same idempotent
  // ALTER TABLE idiom as every other additive column in this file.
  try {
    db.exec("ALTER TABLE experience_providers ADD COLUMN claimed_at TEXT");
  } catch { /* already present */ }

  // Backfill: any pre-existing experience_providers row that already has a
  // used, non-revoked gardssalg_claims row (i.e. was claimed before this
  // column existed) gets claimed_at set from that claim's earliest used_at.
  // WHERE claimed_at IS NULL makes this a no-op on every boot after the first
  // (no separate "ran once" flag needed) and never overwrites a claimed_at
  // already stamped live by verifyClaimToken(). Runs after both
  // experience_providers and gardssalg_claims exist (this block is placed
  // after both CREATE TABLE blocks above).
  try {
    db.exec(`
      UPDATE experience_providers
         SET claimed_at = (
           SELECT MIN(gc.used_at)
             FROM gardssalg_claims gc
            WHERE gc.provider_id = experience_providers.id
              AND gc.used = 1
              AND gc.revoked_at IS NULL
              AND gc.used_at IS NOT NULL
         )
       WHERE claimed_at IS NULL
         AND id IN (
           SELECT provider_id FROM gardssalg_claims
            WHERE used = 1 AND revoked_at IS NULL AND used_at IS NOT NULL
         )
    `);
  } catch (e) {
    console.log(`[experiences] claimed_at backfill skipped: ${(e as Error).message}`);
  }

  // ─── merged_into (dev-request 2026-07-31-gardssalg-provider-dubletter-på-
  // tvers-av-seeds, merge lever) ──────────────────────────────────────────────
  // Additive, nullable pointer: NULL means "this row is not a merged-away
  // duplicate" (the default for every existing row, unchanged behavior).
  // Non-NULL means this row was identified as a same-producer duplicate of
  // the row whose id it holds, and its content/contact/org_nr were fill-only
  // migrated to that survivor by POST /admin/gardssalg-provider-dedup-merge
  // (routes/opplevelser.ts) — see that route's own doc comment for the
  // survivorship rule. Same SURVIVOR-POINTER semantic as `experiences.
  // canonical_id` (this file, above — "opplevelses-raden-maskineriet"'s own
  // same-table dedup marker: NULL = live/canonical, non-NULL = merged away,
  // walk hops until a NULL terminal row) and as `agents.merged_into`
  // (database/init.ts) — this column is deliberately named to match the
  // latter (the dev-request's own spec text proposed "merged_into-peker") but
  // carries the FORMER's semantic (row stays in the table, never deleted; a
  // future consumer is responsible for filtering `merged_into IS NULL`,
  // exactly as `experiences` call sites already filter `canonical_id IS
  // NULL` — deliberately NOT retrofitted into any existing
  // experience_providers query by this slice, since widening which queries
  // exclude merged-away rows is outside this slice's scope, see the route's
  // own non-goals). The row is NEVER hard-deleted and NEVER auto-hidden via
  // catalog_hidden by this column alone (a separate, independently-audited
  // lever already owns that toggle — see GET/POST .../gardssalg-provider-
  // visibility below).
  try {
    db.exec("ALTER TABLE experience_providers ADD COLUMN merged_into TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_experience_providers_merged_into ON experience_providers(merged_into)");
  } catch { /* already present */ }

  // ─── experience_provider_conflict_audit (dev-request 2026-08-01-gardssalg-
  // profilkomplett-og-soekbar-foer-outreach, Steg 2) ─────────────────────────
  // Insert-only, field-level changelog for `experiences.booking_url`
  // corrections made by the gårdssalg producer<->experience conflict
  // remediation (POST /admin/gardssalg-experience-conflict-remediation,
  // routes/opplevelser.ts) — the cross-TABLE counterpart to
  // gardssalg_content_audit above. NOT the same table: gardssalg_content_audit
  // is FK'd to experience_providers and is written by the fill-only content
  // pipeline; this table is FK'd to `experiences` (the catalog/"activities"
  // table) and is written by a corrective OVERWRITE — the remediation fixes an
  // experience row whose booking_url was harvested from an unrelated
  // third-party source and conflicts with the real producer's owner-verified
  // hjemmeside (the concrete case: producer atlungstad-brenneri--bbe4185d's
  // hjemmeside is atlungstadbrenneri.no; a same-named-place experience row's
  // booking_url wrongly pointed at atlungstad.no, a different business).
  // Reusing gardssalg_content_audit's own row shape directly was considered
  // and rejected: its provider_id column is NOT NULL + FK'd to
  // experience_providers(id) ON DELETE CASCADE, and planGardssalgContentRollback
  // re-verifies content_source by looking that id up in experience_providers —
  // an experiences.id written into that column would never resolve there, so
  // the row would silently become unrestorable through that lever. Same shape
  // (id/entity_id/field_name/old_value/new_value/source_url/batch_id/
  // changed_by/changed_at), same insert-only/never-mutated discipline, own FK
  // target — see planExperienceConflictRollback/applyExperienceConflictRollback
  // (services/gardssalg-experience-conflict.ts), wired into the SAME
  // POST /admin/gardssalg-content-rollback endpoint via an `entity_type`
  // switch (default "provider", unchanged) rather than a second HTTP surface —
  // per the dev-request's own rollback section ("reverserbart... via
  // gardssalg-content-rollback").
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS experience_provider_conflict_audit (
        id TEXT PRIMARY KEY,
        experience_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        source_url TEXT,
        batch_id TEXT,
        changed_by TEXT NOT NULL DEFAULT 'system',
        changed_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (experience_id) REFERENCES experiences(id) ON DELETE CASCADE
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_exp_provider_conflict_audit_experience ON experience_provider_conflict_audit(experience_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_exp_provider_conflict_audit_batch ON experience_provider_conflict_audit(batch_id)`);
  } catch (err) {
    console.error("Migration experience_provider_conflict_audit failed:", err);
  }

  // ─── gardssalg_website_verification_audit (dev-request 2026-08-01-
  // gardssalg-profilkomplett-og-soekbar-foer-outreach, Steg 3, scoped-down
  // slice) ────────────────────────────────────────────────────────────────
  // Insert-only, per-check changelog for the gårdssalg website-verification
  // sweep (GET /admin/gardssalg-website-verification-audit, POST
  // /admin/gardssalg-website-verification-remediation,
  // services/gardssalg-website-verification.ts). One row per producer per
  // apply run: whether the sweep classified the producer's hjemmeside as
  // verified/unverified/aggregator/missing_source, and the evidence (if any)
  // gardssalgWebsiteEvidenceMatch produced. Mirrors
  // experience_provider_conflict_audit's exact shape/indexing convention
  // (this fleet's established reversible-write audit-trail idiom) — FK'd to
  // experience_providers (this sweep's own entity), ON DELETE CASCADE so
  // orphan audit rows are cleaned up if a provider is ever deleted. Not a
  // rollback lever itself (the write it accompanies —
  // field_provenance.hjemmeside_verification — is a verification STAMP, not
  // a content field with a "restore to" concept the way
  // gardssalg_content_audit's fields are), purely an observability/history
  // trail.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gardssalg_website_verification_audit (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        classification TEXT NOT NULL,
        verified INTEGER NOT NULL DEFAULT 0,
        evidence TEXT,
        batch_id TEXT,
        checked_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (provider_id) REFERENCES experience_providers(id) ON DELETE CASCADE
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_gardssalg_website_verification_audit_provider ON gardssalg_website_verification_audit(provider_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_gardssalg_website_verification_audit_batch ON gardssalg_website_verification_audit(batch_id)`);
  } catch (err) {
    console.error("Migration gardssalg_website_verification_audit failed:", err);
  }
  // promoted_from_evidence_url (Skive 1, dev-request 2026-08-17-berikelse-
  // uttrekk-evidence-url-og-render): NULL on every ordinary row; holds the
  // candidate URL itself (not just a 0/1 flag) on the one row shape this
  // sweep ever promotes — a producer whose own hjemmeside was blank, verified
  // via its experiences.evidence_url fallback instead. TEXT rather than a
  // boolean so the audit row is self-explanatory without joining back to the
  // evidence JSON column. ALTER TABLE ADD COLUMN is idempotent here — error
  // just means already-present.
  try {
    db.exec("ALTER TABLE gardssalg_website_verification_audit ADD COLUMN promoted_from_evidence_url TEXT");
  } catch { /* already present */ }

  // ─── gardssalg_field_concordance_review_queue (orchestrator dev-request
  // 2026-08-03-gardssalg-field-concordance, write-side slice) ────────────────
  // The review queue for `avvik` verdicts produced by the field-concordance
  // sweep (GET /admin/gardssalg-field-concordance-audit, POST
  // /admin/gardssalg-field-concordance-remediation,
  // services/gardssalg-field-concordance.ts). An `avvik` verdict is only
  // possible on the three avvik-capable fields (epost/telefon/mobil — see
  // GFC_AVVIK_CAPABLE_FIELDS in gardssalg-field-concordance.ts); the four
  // presence-only fields never land a row here. Per the dev-request's own
  // spec ("Ingen automatisk overskriving ved avvik"), this queue carries BOTH
  // the stored (`current_value`) and page-extracted (`found_value`) value for
  // a human/future-slice to resolve — applyGardssalgFieldConcordance()
  // (services/gardssalg-field-concordance.ts) NEVER writes epost/telefon/
  // mobil on experience_providers directly; this table + the
  // field_provenance.field_concordance stamp are its only writes.
  //
  // Deliberately a SEPARATE table from gardssalg_website_review_queue, not a
  // shared/reused one, and with a DIFFERENT uniqueness shape:
  // gardssalg_website_review_queue is UNIQUE(provider_id) because only one
  // hjemmeside-URL candidate makes sense pending at a time per provider; here
  // a single producer can simultaneously have a genuine avvik on epost AND
  // telefon (independent fields, independent findings) — so uniqueness is
  // per (provider_id, field_name), letting up to 3 pending rows coexist per
  // provider (one per avvik-capable field) without evicting each other.
  // Upsert-on-rerun semantics on that composite key: a repeat scan reaching
  // the SAME avvik (identical current_value+found_value) is a no-op (skipped
  // at the application layer, not here — see applyGardssalgFieldConcordance's
  // own doc comment) so updated_at doesn't churn pointlessly; a repeat scan
  // finding a CHANGED found_value overwrites the existing row (refresh-on-
  // rerun, same contract as the website queue's own upsert).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gardssalg_field_concordance_review_queue (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        provider_name TEXT,
        field_name TEXT NOT NULL,
        current_value TEXT,
        found_value TEXT,
        reason TEXT NOT NULL DEFAULT 'field_concordance_avvik',
        batch_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(provider_id, field_name),
        FOREIGN KEY (provider_id) REFERENCES experience_providers(id) ON DELETE CASCADE
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_gardssalg_field_concordance_review_queue_reason ON gardssalg_field_concordance_review_queue(reason)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_gardssalg_field_concordance_review_queue_provider ON gardssalg_field_concordance_review_queue(provider_id)`);
  } catch (err) {
    console.error("Migration gardssalg_field_concordance_review_queue failed:", err);
  }

  // ─── experience_provider_field_write_audit (Steg 4 of the
  // 2026-08-03-hjemmeside-skrivespak dev-request — "skrivespak for
  // hjemmeside") ──────────────────────────────────────────────────────────
  // Insert-only, per-write changelog for POST
  // /api/opplevelser/admin/providers/hjemmeside-write (routes/opplevelser.ts).
  // Generalized (field_name column, not hardcoded to "hjemmeside") on
  // purpose so a future write-lever for another experience_providers field
  // can reuse this SAME table rather than spinning up a fourth near-
  // identical audit table — the gardssalg_website_verification_audit table
  // above is NOT reused in place because its classification/verified
  // columns are specific to the verification sweep's own vocabulary and do
  // not fit a plain "old value -> new value" field write. Mirrors
  // gardssalg_website_verification_audit's/experience_provider_conflict_
  // audit's exact shape/indexing convention (this fleet's established
  // reversible-write audit-trail idiom) — FK'd to experience_providers, ON
  // DELETE CASCADE so orphan audit rows are cleaned up if a provider is
  // ever deleted.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS experience_provider_field_write_audit (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        batch_id TEXT,
        written_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (provider_id) REFERENCES experience_providers(id) ON DELETE CASCADE
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_exp_provider_field_write_audit_provider ON experience_provider_field_write_audit(provider_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_exp_provider_field_write_audit_batch ON experience_provider_field_write_audit(batch_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_exp_provider_field_write_audit_field ON experience_provider_field_write_audit(field_name)`);
  } catch (err) {
    console.error("Migration experience_provider_field_write_audit failed:", err);
  }

  // ─── experience_fylke_2024_migration_audit (dev-request
  // 2026-08-07-orch-fylke-2024-migrasjon) ─────────────────────────────────
  // Insert-only changelog for POST /api/opplevelser/admin/fylke-2024-
  // migration's apply path (routes/opplevelser.ts,
  // services/fylke-2024-migration.ts): one row per WRITE the migration
  // makes when it moves a stale 2020-era fylke value ('Viken' /
  // 'Vestfold og Telemark' / 'Troms og Finnmark') to its resolved 2024
  // successor on an `experiences` or `experience_providers` row. `table_name`
  // + `row_id` (rather than a single FK column) because this ONE audit table
  // covers writes to TWO different source tables — mirrors
  // experience_provider_conflict_audit's/gardssalg_website_verification_
  // audit's exact shape/indexing convention (this fleet's established
  // reversible-write audit-trail idiom), but with no FOREIGN KEY (a single
  // row_id column can't reference two different parent tables at once).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS experience_fylke_2024_migration_audit (
        id TEXT PRIMARY KEY,
        table_name TEXT NOT NULL,
        row_id TEXT NOT NULL,
        old_fylke TEXT,
        new_fylke TEXT,
        batch_id TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_exp_fylke_2024_migration_audit_row ON experience_fylke_2024_migration_audit(table_name, row_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_exp_fylke_2024_migration_audit_batch ON experience_fylke_2024_migration_audit(batch_id)`);
  } catch (err) {
    console.error("Migration experience_fylke_2024_migration_audit failed:", err);
  }

  // ─── experience_outreach_sent_log (dev-request
  // 2026-08-07-outreach-pool-krav123-og-pilot, AC4 — pilot send-mechanic) ──
  // This vertical's OWN persistent send-log/cooldown source for POST
  // /admin/gardssalg-outreach-pilot-send (routes/opplevelser.ts). NOT a
  // write into the existing (RFB-db) `outreach_sent_log` table — that table's
  // `agent_id TEXT NOT NULL REFERENCES agents(id)` cannot be satisfied for a
  // gårdssalg/experiences provider (experience_providers has no agents.id;
  // `crm_contacts.provider_id`'s own migration note, init.ts ~L1071, already
  // established provider_id "can never be a REFERENCES clause" for exactly
  // this cross-db reason), and relaxing that NOT NULL/FK on a live,
  // trigger-laden table the RFB revenue-critical 60-day cooldown already
  // depends on is real surgery this slice deliberately does not attempt —
  // see the dev-request's own build log for the full investigation/decision.
  // The pilot-send route ALSO reads (read-only, no write) the existing
  // cross-platform `outreach_sent_log.recipient_email` cooldown check
  // routes/crm.ts already implements, so the cross-platform-cooldown
  // property (same human, same sender identity, RFB+Opplevagent) is
  // preserved without writing into the RFB table. Additive only — no other
  // table/trigger touched. Indexed on recipient_email (the cooldown lookup
  // key, case-insensitive match done at the query layer) and provider_id
  // (per-provider send history lookups).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS experience_outreach_sent_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL,
        recipient_email TEXT NOT NULL,
        sent_at TEXT NOT NULL DEFAULT (datetime('now')),
        channel TEXT NOT NULL DEFAULT 'email',
        message_id TEXT,
        notes TEXT,
        is_test INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_experience_outreach_sent_log_recipient_email ON experience_outreach_sent_log(recipient_email)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_experience_outreach_sent_log_provider ON experience_outreach_sent_log(provider_id)`);
  } catch (err) {
    console.error("Migration experience_outreach_sent_log failed:", err);
  }

  // ─── gardssalg_experience_conflict_review (dev-request 2026-08-07-dublett-
  // evidensbasis-og-pool-avblokkering, slice 2) ──────────────────────────────
  // Human confirm/reject verdicts over the gårdssalg producer<->experience
  // conflict candidates that AREN'T provider_link (name_token/host_name basis
  // — see services/gardssalg-experience-conflict.ts's module doc comment and
  // its "Skive 2" section just above the functions that read/write this
  // table). PRIMARY KEY (producer_id, experience_id) IS the stable pair-key
  // the spec calls for: once a pair is decided (either verdict), it can never
  // be inserted again — a repeat scan keeps finding the same structural
  // match, but this table's presence-or-absence-of-a-row is what the queue
  // (buildGardssalgExperienceConflictQueuePairs) and the readiness gate
  // (computeGardssalgReadinessRows, routes/opplevelser.ts) both key off, so a
  // REJECTED pair never resurfaces and a CONFIRMED pair becomes real evidence
  // exactly once. Deliberately NO FOREIGN KEY to experience_providers/
  // experiences (unlike gardssalg_orgnr_review_queue et al.): this table is
  // seeded below with real producer_id/experience_id values resolved against
  // the LIVE PRODUCTION corpus at spot-check time, which will not exist in a
  // fresh/local/test experiences.db — same "provider_id can never be a
  // REFERENCES clause" reasoning experience_outreach_sent_log's own migration
  // note above already established for a cross-environment id, applied here
  // for a cross-TIME one instead: a hard FK would make the seed below throw
  // (foreign_keys=ON, db-factory.ts) in every environment except the exact
  // prod DB state it was resolved against.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gardssalg_experience_conflict_review (
        producer_id TEXT NOT NULL,
        experience_id TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('confirmed', 'rejected')),
        decided_by TEXT NOT NULL,
        decided_at TEXT NOT NULL DEFAULT (datetime('now')),
        note TEXT,
        PRIMARY KEY (producer_id, experience_id)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_gardssalg_experience_conflict_review_verdict ON gardssalg_experience_conflict_review(verdict)`);
  } catch (err) {
    console.error("Migration gardssalg_experience_conflict_review failed:", err);
  }

  // ─── Pre-seed: the 2026-08-01 human spot-check's own 14 verdicts ─────────
  // (dev-request 2026-08-07-dublett-evidensbasis-og-pool-avblokkering, slice
  // 2, spec point 5 — "arbeidet er gjort, ikke gjør det på nytt"). Resolved
  // from the live prod GET .../gardssalg-experience-conflict-audit dump
  // (2026-08-08) by matching each producer-name substring below to its exact
  // producer_id, then picking the ONE experience row whose title matches the
  // spot-check's own "via" clue. 13 of 14 are REJECT ("falskt par" — a
  // different real business sharing one generic place-name/word); Lervig is
  // the sole CONFIRM ("samme virksomhet"). INSERT OR IGNORE: the PRIMARY KEY
  // makes each row idempotent across repeated boots, so this never overwrites
  // a later human decision on the same pair (there won't be one — these are
  // already-decided from the day the review table shipped — but IGNORE over
  // REPLACE is the conservative choice regardless).
  //
  // Judgment calls made resolving "via" to one exact experience_id (more than
  // one candidate experience existed for these three producers):
  //   - Booze Of Norway: 3 Hunderfossen Eventyrpark experience rows matched
  //     (near-duplicate harvests of the same theme park under slightly
  //     different titles/booking_urls). Picked the first
  //     ("…Norway's Most Legendary Family Park", 1faf6b0c…) — any of the 3
  //     would demonstrate the identical false-pair shape equally well; this
  //     is the extreme case named in the scale note (93 total pairs for this
  //     one producer), so the other ~90 remain live in the pending queue.
  //   - Numedal Stasjonsbryggeri: 2 Norefjell-titled candidates ("Norefjell
  //     Ski Resort…" and "Norefjell Ski & Fjellsenter…"). Picked the latter
  //     (65190755…) — its title is a near-verbatim match to the spec's own
  //     wording ("Norefjell Ski & Fjellsenter").
  //   - Alde Sider (Ulvik): 2 kajakk-themed candidates, one status=unknown
  //     ("Guidede havkajakkturer…") and one status=conflict ("Guidet
  //     kajakktur i Ulvik…", d5c7b8a7…). Picked the conflict-status one — it
  //     is both the closer title match to the spec's singular "kajakktur i
  //     Ulvik" and the one that actually needs a REJECT verdict to leave the
  //     candidate queue (the unknown-status row was never a candidate to
  //     begin with, see buildGardssalgExperienceConflictQueuePairs's
  //     status filter).
  try {
    const seedReviewDecision = db.prepare(`
      INSERT OR IGNORE INTO gardssalg_experience_conflict_review
        (producer_id, experience_id, verdict, decided_by, decided_at, note)
      VALUES (@producer_id, @experience_id, @verdict, @decided_by, datetime('now'), @note)
    `);
    const SPOT_CHECK_DECIDED_BY = "session-spot-check-2026-08-01";
    const SPOT_CHECK_SEED: Array<{
      producer_id: string;
      producer_name: string;
      experience_id: string;
      experience_title: string;
      verdict: "confirmed" | "rejected";
      note: string;
    }> = [
      {
        producer_id: "3b2e4b86-053f-4dc8-848d-6b72b66f04a7",
        producer_name: "Lillehammer Bryggeri",
        experience_id: "c13170e1-19f8-47e7-9138-04e649072b03",
        experience_title: "Birkebeineren Hotel — Lillehammer sentrum",
        verdict: "rejected",
        note: "2026-08-01 spot-check: falskt par, delt token 'lillehammer', ulike virksomheter",
      },
      {
        producer_id: "0f863334-2031-4c98-8088-0be1f59e502e",
        producer_name: "Aurora Spirit Distillery",
        experience_id: "f28efc15-be3d-4141-acbc-4e36878b9bb1",
        experience_title: "Northern Lights Aurora Safari — GuideGunnar",
        verdict: "rejected",
        note: "2026-08-01 spot-check: falskt par, delt token 'aurora' (GuideGunnar nordlys-safari), ulike virksomheter",
      },
      {
        producer_id: "4e319c88-cde2-47c1-9858-df53a48632d8",
        producer_name: "Booze Of Norway",
        experience_id: "1faf6b0c-e57a-483f-baed-466154f4e914",
        experience_title: "Hunderfossen Eventyrpark — Norway's Most Legendary Family Park",
        verdict: "rejected",
        note: "2026-08-01 spot-check: falskt par, delt token 'norway' (Hunderfossen Eventyrpark), ulike virksomheter",
      },
      {
        producer_id: "da05b531-8bc5-40a4-b23f-5e1c8d28ad3e",
        producer_name: "Ciderhuset Balestrand",
        experience_id: "bf01cc22-dac8-4308-ad17-643b33a7e040",
        experience_title: "Dragsvik Fjordhotell — Classic Boutique Hotel on Esefjord at Balestrand",
        verdict: "rejected",
        note: "2026-08-01 spot-check: falskt par, delt token 'balestrand', ulike virksomheter",
      },
      {
        producer_id: "10b2b385-2dd6-4fbd-bcd7-45c0134e9677",
        producer_name: "Numedal Stasjonsbryggeri",
        experience_id: "65190755-ee78-489d-b89f-53caeb4aa92a",
        experience_title: "Norefjell Ski & Fjellsenter — 30 løyper og 15 heiser i Numedal nær Oslo",
        verdict: "rejected",
        note: "2026-08-01 spot-check: falskt par, delt token 'numedal', ulike virksomheter",
      },
      {
        producer_id: "d6508d34-d8b5-453d-ac4c-89250ef056f0",
        producer_name: "Silver Distillery",
        experience_id: "01a8f852-ec70-4d28-ab5a-32c35bfb2784",
        experience_title: "Nordlandsmuseet — Bodø City Museum with Viking Silver Treasure & 10,000-Year History",
        verdict: "rejected",
        note: "2026-08-01 spot-check: falskt par, delt token 'silver' (vikingsølv), ulike virksomheter",
      },
      {
        producer_id: "93e836c7-8624-491a-bf42-37d7e752e4ac",
        producer_name: "Lindesnes Brygghus",
        experience_id: "64ba8dfd-1924-475a-9389-ac03ee69e5cd",
        experience_title: "Under Restaurant — Europe's First Underwater Restaurant at Lindesnes",
        verdict: "rejected",
        note: "2026-08-01 spot-check: falskt par, delt token 'lindesnes', ulike virksomheter",
      },
      {
        producer_id: "e45eab21-4bc8-49bc-a629-b279c73e73c8",
        producer_name: "Norsemen Brewery",
        experience_id: "3372d76f-5b1d-434c-8a2c-56c1d30b212a",
        experience_title: "Hundholmen Brygghus — Craft Brewery, Bar & In-House Beer Tasting in Bodø",
        verdict: "rejected",
        note: "2026-08-01 spot-check: falskt par, delt token 'brewery', ulike virksomheter",
      },
      {
        producer_id: "713e581a-14fe-48ab-a099-bea9895a0b5c",
        producer_name: "Tromsø Mikrobryggeri",
        experience_id: "6b36116b-0122-4d42-975e-682a378344a4",
        experience_title: "Fiskekompaniet — Arctic Seafood Restaurant on Tromsø Harbour",
        verdict: "rejected",
        note: "2026-08-01 spot-check: falskt par, delt token 'tromsø', ulike virksomheter",
      },
      {
        producer_id: "b8a7ae72-11aa-47fc-a035-e3d9398b4a68",
        producer_name: "Norsk Kombucha",
        experience_id: "5a074756-ff48-4dfb-841b-39c9c46ae01d",
        experience_title: "Bryggeloftet & Stuene — Traditional Norwegian Cuisine at Bergen's Bryggen",
        verdict: "rejected",
        note: "2026-08-01 spot-check: falskt par, delt token 'norsk'/'norwegian', ulike virksomheter",
      },
      {
        producer_id: "5fda0eed-f7ba-4653-b663-0f33345ce942",
        producer_name: "Alde Sider (Ulvik)",
        experience_id: "d5c7b8a7-4b31-4cdd-bb9c-fab7382a490e",
        experience_title: "Guidet kajakktur i Ulvik på Hardangerfjorden",
        verdict: "rejected",
        note: "2026-08-01 spot-check: falskt par, delt token 'ulvik' (kajakktur), ulike virksomheter",
      },
      {
        producer_id: "75b8cf2d-3080-4b81-965d-229f0c21b910",
        producer_name: "Sleeping Village Brewing",
        experience_id: "08f93148-320a-4330-a62d-ab4e8d2ccd35",
        experience_title: "World Sauna Award Village & Cultural Program on Oslo Waterfront — SALT",
        verdict: "rejected",
        note: "2026-08-01 spot-check: falskt par, delt token 'village' (SALT sauna village), ulike virksomheter",
      },
      {
        producer_id: "7a6a7eac-a7be-48aa-b07b-0b757cb90766",
        producer_name: "White Dragon Gin",
        experience_id: "848101ef-e23b-4c42-be62-b8d6e0c70a0f",
        experience_title: "Voss Active — White Water Rafting & Canyoning Voss",
        verdict: "rejected",
        note: "2026-08-01 spot-check: falskt par, delt token 'white' (Voss Active rafting), ulike virksomheter",
      },
      // ── The lone CONFIRM — a genuine same-business pair, becomes real
      //    evidence (counts toward has_duplicate_conflict) from the first
      //    boot onward, per computeGardssalgReadinessRows's wiring
      //    (routes/opplevelser.ts). NOT a trigger for any booking_url
      //    remediation write in this slice — that's skive 3, out of scope.
      {
        producer_id: "59db202c-3ebe-49c1-80cb-1bfb99ba0823",
        producer_name: "Lervig",
        experience_id: "4fb72e45-24be-4724-92e1-5bc93fccc550",
        experience_title: "Lervig Local — Guided Beer Tasting at Stavanger Brewpub",
        verdict: "confirmed",
        note: "2026-08-01 spot-check: samme virksomhet (brewpub), bekreftet konflikt-bevis",
      },
    ];
    for (const s of SPOT_CHECK_SEED) {
      seedReviewDecision.run({
        producer_id: s.producer_id,
        experience_id: s.experience_id,
        verdict: s.verdict,
        decided_by: SPOT_CHECK_DECIDED_BY,
        note: s.note,
      });
    }
  } catch (err) {
    console.error("Seed gardssalg_experience_conflict_review (2026-08-01 spot-check) failed:", err);
  }

  // ─── gardssalg_outreach_size_gate_config (dev-request 2026-08-09-daglig-
  // outreach-klargjoering-og-stoerrelsesgate, Skive 1) ───────────────────────
  // Single-row (id='singleton') L1 knob for the antall_ansatte outreach
  // size-gate: `threshold` (antall_ansatte >= threshold => "stor") and
  // `enabled` (the whole gate's off switch — Daniel said "inntil videre").
  // Deliberately DB-backed rather than a repo-tracked YAML/JSON file: the
  // Dockerfile COPYs only src/, tsconfig.json, openapi.yaml, verticals/,
  // mcp-server*/ into the image, so a new top-level config/ dir would need a
  // rebuild+redeploy before an edit ever reached the running container —
  // exactly the "uten deploy" property this knob exists to have. This table
  // lives on the SAME Fly volume (/app/data/experiences.db) every other row
  // in this file already lives on, survives restarts/redeploys untouched,
  // and is written via an authenticated admin endpoint (POST
  // /admin/gardssalg-outreach-size-gate) — same shape as the existing
  // booking_live admin lever (POST /admin/gardssalg-booking-activation,
  // routes/opplevelser.ts) that already proves this pattern in prod.
  // Absence of the singleton row (fresh DB, never configured) is NOT an
  // error — getGardssalgSizeGateConfig() (services/gardssalg-outreach-size-
  // gate.ts) falls back to the documented default (enabled:1, threshold:25)
  // rather than requiring a seed row here.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gardssalg_outreach_size_gate_config (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        threshold INTEGER NOT NULL DEFAULT 25,
        updated_at TEXT,
        updated_by TEXT,
        note TEXT
      )
    `);
  } catch (err) {
    console.error("Migration gardssalg_outreach_size_gate_config failed:", err);
  }

  // ─── experience_providers.terminal_status (dev-request 2026-08-19-
  // kursjustering-drikkefunnel-llm-og-supply, Grep 3a) ────────────────────────
  // Explicit end-status for a gårdssalg row that has been deliberately taken
  // OUT of the readiness/outreach rotation — 'krever_eier' (needs an owner to
  // step forward) or 'dod_kilde' (source website verified dead) — rather than
  // being counted as ordinary pipeline backlog. NULL (the default) means "no
  // terminal status" — every existing row is unaffected the instant this
  // column exists, and its derived readiness_tier is computed exactly as
  // before. See computeGardssalgReadinessTier (routes/opplevelser.ts) for the
  // precedence (terminal_status, when set, short-circuits every other tier
  // check) and applyGardssalgSetTerminalStatus (services/experience-store.ts)
  // for the write path. Setting it back to NULL via that same write path IS
  // the rollback mechanism — no separate rollback route/migration needed.
  try {
    db.exec("ALTER TABLE experience_providers ADD COLUMN terminal_status TEXT DEFAULT NULL");
  } catch { /* already present */ }

  // ─── experiences.evidence_url_verification (dev-request 2026-08-24-
  // evidence-url-verifisering-gate) ───────────────────────────────────────
  // `experiences.evidence_url` (the citation substantiating that a specific
  // experience/supplier is real) was never independently fetched or checked
  // by anything downstream — unlike experience_providers.hjemmeside, which
  // the website-verification sweep confirms before content-refresh trusts it
  // (field_provenance.hjemmeside_verification, isHjemmesideVerified() in
  // routes/opplevelser.ts). A row could pass hjemmeside-based enrichment
  // forever while keeping an evidence_url nothing ever fetched.
  //
  // NEW, ADDITIVE column only — mirrors field_provenance.hjemmeside_
  // verification's JSON shape ({verified, classification, checked_at,
  // evidence?}) but lives on `experiences` (not experience_providers),
  // because evidence_url is itself an experiences column. NEVER touches or
  // overwrites `evidence_url` itself — see isEvidenceUrlVerified() /
  // deriveEvidenceUrlStatus() (routes/opplevelser.ts) for the read side and
  // POST /admin/evidence-url-verification-sweep for the write side. NULL
  // (the default, and every pre-existing row's starting state) reads as
  // "not verified" via isEvidenceUrlVerified()'s fail-closed contract — no
  // retroactive backfill of existing rows in this slice (task spec
  // non-goal); a future batch job can sweep historical rows if wanted.
  // Setting it back to NULL is the rollback — no separate migration needed,
  // and no existing column's semantics change.
  try {
    db.exec("ALTER TABLE experiences ADD COLUMN evidence_url_verification TEXT");
  } catch { /* already present */ }

  // ─── experiences.price_checked_at / price_check_attempts (dev-request
  // 2026-08-25-experiences-pris-ferskhet) ─────────────────────────────────
  // `experiences.price_from` is written once at harvest insertion (LLM-
  // composed) or by the fill-if-blank content-refresh writer
  // (applyExperienceContent -> extractPriceFrom) and is NEVER re-checked
  // afterwards — the 2026-08-25 mismatch investigation found 2/17 rows whose
  // stored price no longer matched the source page (130 vs 180 kr; 200 vs
  // 195 kr), and grep confirmed no price_checked_at-style mechanism existed
  // anywhere in this codebase. These two ADDITIVE columns back the sweep at
  // POST /admin/price-freshness-check (routes/opplevelser.ts) that re-fetches
  // a row's price provenance page and re-runs extractPriceFrom against it.
  //
  // price_checked_at: stamped on EVERY check attempt for this row, whatever
  //   the outcome (fetch failure, unchanged, corrected, or nulled) — same
  //   "stamp on every attempt, not just on success" idiom as
  //   experience_providers.last_content_attempt_at, so a row that keeps
  //   failing to fetch still cycles to the back of the NULLs-first selector
  //   instead of sorting first forever. Doubles as the freshness-window
  //   clock (selectExperiencesForPriceFreshnessCheck's own doc comment
  //   explains the exact combination with price_check_attempts below). NULL
  //   means "never checked" — every pre-existing row's starting state, read
  //   as "needs checking" by the selector, never as a mismatch.
  // price_check_attempts: increments ONLY on a genuine fetch failure (DNS/
  //   HTTP/timeout — the page could not be re-fetched at all) and resets to
  //   0 on any outcome that DID succeed in re-checking the price (unchanged,
  //   corrected, or nulled) — a "checked, price already correct" result is
  //   explicitly NOT a failure and must not count toward this counter, only
  //   toward price_checked_at freshness. Mirrors content_no_yield_streak's
  //   rationale: a permanently-unfetchable page must not get retried
  //   forever, so 3 consecutive fetch failures rest the row for the
  //   freshness window (see PRICE_CHECK_PARK_AFTER_ATTEMPTS,
  //   experience-store.ts) — same idea as PROVIDER_PARK_AFTER_ATTEMPTS, one
  //   level down (per-experience, not per-provider, since price_from lives
  //   on `experiences` not on the provider).
  // Setting both back to NULL/0 (or simply never running the sweep again) is
  // the rollback — no separate migration needed, and no existing column's
  // semantics change; price_from itself keeps whatever value it holds.
  const priceFreshnessCols = [
    "ALTER TABLE experiences ADD COLUMN price_checked_at TEXT",
    "ALTER TABLE experiences ADD COLUMN price_check_attempts INTEGER NOT NULL DEFAULT 0",
  ];
  for (const stmt of priceFreshnessCols) {
    try { db.exec(stmt); } catch { /* already present */ }
  }

  console.log("[experiences] schema initialized");
}
