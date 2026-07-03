import Database from "better-sqlite3";
import path from "path";

// ─── Database Initialization ─────────────────────────────────
// SQLite is the right call for phase 1-3:
//   - Zero infrastructure (one file, no Docker, no cloud)
//   - 2000+ qps with joins (we need <100)
//   - Persistent — data survives restart (Gap 1 fixed)
//   - SQL is SQL — migration to PostgreSQL is schema 1:1
//
// The DB file lives at ./data/lokal.db relative to project root.
// In production, this path would be configurable via env.

// DB path: use env var, or ./data/lokal.db relative to project root.
// On Windows mounted filesystems, WAL mode may not work — we detect and fallback.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "../../data/lokal.db");

let db: Database.Database;

// Test-only: inject an in-memory DB so unit tests can run without touching prod.
// Never call this from production code paths.
export function __setDbForTesting(injected: Database.Database): void {
  db = injected;
}

// Test-only: run the full production schema initialization (CREATE TABLE …,
// migrations, VIEWs) on an injected in-memory DB. `getDb()` only calls
// initSchema when the module-level `db` is null, so a test that injects its own
// DB via __setDbForTesting must call this to actually create the tables.
// Never call from production code.
export function __initSchemaForTesting(injected: Database.Database): void {
  initSchema(injected);
}

export function getDb(): Database.Database {
  if (!db) {
    // Ensure data directory exists
    const dir = path.dirname(DB_PATH);
    const fs = require("fs");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    db = new Database(DB_PATH);

    // Performance tuning:
    // Try WAL mode first (best perf), fall back to DELETE if filesystem doesn't support it
    try {
      db.pragma("journal_mode = WAL");
    } catch {
      console.log("⚠️  WAL mode not supported on this filesystem, using DELETE journal mode");
      db.pragma("journal_mode = DELETE");
    }
    db.pragma("synchronous = NORMAL");
    db.pragma("cache_size = -64000");
    db.pragma("foreign_keys = ON");

    initSchema(db);
  }
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    -- ════════════════════════════════════════════════════════════
    -- AGENTS: The core registry table
    -- Every producer, consumer, logistics agent lives here
    -- ════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      provider TEXT NOT NULL,
      contact_email TEXT NOT NULL,
      url TEXT NOT NULL,
      version TEXT DEFAULT '1.0.0',
      role TEXT NOT NULL CHECK(role IN ('producer','consumer','logistics','quality','price-intel')),
      api_key TEXT UNIQUE NOT NULL,

      -- Location (nullable for non-geo agents)
      lat REAL,
      lng REAL,
      city TEXT,
      radius_km REAL,

      -- JSON arrays stored as TEXT (SQLite way)
      categories TEXT DEFAULT '[]',
      tags TEXT DEFAULT '[]',
      skills TEXT DEFAULT '[]',
      capabilities TEXT DEFAULT '{}',
      languages TEXT DEFAULT '["no"]',

      -- Trust & activity metrics
      trust_score REAL DEFAULT 0.5,
      is_active INTEGER DEFAULT 1,
      is_verified INTEGER DEFAULT 0,
      discovery_count INTEGER DEFAULT 0,
      interaction_count INTEGER DEFAULT 0,
      total_interactions INTEGER DEFAULT 0,
      avg_response_time_ms REAL,

      -- Timestamps
      created_at TEXT DEFAULT (datetime('now')),
      last_seen_at TEXT DEFAULT (datetime('now'))
    );

    -- ════════════════════════════════════════════════════════════
    -- LISTINGS: What's for sale right now
    -- The "live inventory" — timestamped, expiring, geo-located
    -- ════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      product_name TEXT NOT NULL,
      category TEXT,
      description TEXT,
      quantity REAL,
      unit TEXT,
      price_per_unit REAL,
      currency TEXT DEFAULT 'NOK',
      is_organic INTEGER DEFAULT 0,
      image_url TEXT,
      available_from TEXT DEFAULT (datetime('now')),
      expires_at TEXT,
      delivery_options TEXT DEFAULT '[]',

      -- Can override agent location (e.g. different pickup spot)
      lat REAL,
      lng REAL,

      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ════════════════════════════════════════════════════════════
    -- TASKS: A2A task lifecycle (Gap 7 fix)
    -- submitted → working → input-required → completed → failed
    -- ════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      consumer_agent_id TEXT,
      method TEXT NOT NULL,
      params TEXT,
      status TEXT DEFAULT 'submitted' CHECK(status IN ('submitted','working','input-required','completed','failed','canceled')),
      result TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ════════════════════════════════════════════════════════════
    -- CHAIN_PRICES: Supermarket price comparison data
    -- "Your tomatoes are 22% cheaper than Rema 1000"
    -- ════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS chain_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_name TEXT NOT NULL,
      chain TEXT NOT NULL,
      price_per_unit REAL NOT NULL,
      unit TEXT DEFAULT 'kg',
      currency TEXT DEFAULT 'NOK',
      is_organic INTEGER DEFAULT 0,
      scraped_at TEXT DEFAULT (datetime('now')),
      UNIQUE(product_name, chain, is_organic)
    );

    -- ════════════════════════════════════════════════════════════
    -- INTERACTIONS: Every time an agent touches Lokal
    -- This is the foundation for analytics, billing, and trust
    -- ════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS interactions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('search','discover','register','view','message','transaction')),
      agent_id TEXT,                          -- who initiated (null = anonymous)
      query TEXT,                             -- what they asked for
      result_count INTEGER DEFAULT 0,        -- how many results returned
      matched_agent_ids TEXT DEFAULT '[]',    -- JSON array of matched agent IDs
      metadata TEXT DEFAULT '{}',            -- extra context (parsed query, filters, etc.)
      ip_hash TEXT,                           -- privacy-safe requester fingerprint
      duration_ms INTEGER,                   -- how long the request took
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ════════════════════════════════════════════════════════════
    -- CONVERSATIONS: Agent-to-agent dialogue sessions
    -- Lokal is the operator — we broker the conversation
    -- ════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      buyer_agent_id TEXT,                   -- who's looking to buy (or NULL for anonymous)
      seller_agent_id TEXT REFERENCES agents(id),
      status TEXT DEFAULT 'open' CHECK(status IN ('open','negotiating','accepted','completed','expired','cancelled')),
      query_text TEXT,                       -- original search that started this
      task_id TEXT REFERENCES tasks(id),     -- linked A2A task
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ════════════════════════════════════════════════════════════
    -- MESSAGES: Individual messages within a conversation
    -- The "chat log" between buyer and seller agents
    -- ════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_role TEXT NOT NULL CHECK(sender_role IN ('buyer','seller','system')),
      sender_agent_id TEXT,
      content TEXT NOT NULL,                 -- the actual message
      message_type TEXT DEFAULT 'text' CHECK(message_type IN ('text','offer','accept','reject','info')),
      metadata TEXT DEFAULT '{}',            -- price info, product details, etc.
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ════════════════════════════════════════════════════════════
    -- AGENT_METRICS: Aggregated performance per agent
    -- Powers seller dashboards and social proof
    -- ════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS agent_metrics (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      times_discovered INTEGER DEFAULT 0,    -- shown in search results
      times_contacted INTEGER DEFAULT 0,     -- conversation started
      times_chosen INTEGER DEFAULT 0,        -- deal completed
      total_revenue_nok REAL DEFAULT 0,      -- sum of completed transactions
      avg_response_time_ms REAL,
      repeat_buyer_count INTEGER DEFAULT 0,  -- unique buyers who came back
      last_interaction_at TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ════════════════════════════════════════════════════════════
    -- AGENT_KNOWLEDGE: Enriched public info for each agent
    -- "Google My Business" for food agents — auto-populated from
    -- public sources, upgraded when sellers claim their agent.
    -- ════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS agent_knowledge (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,

      -- Basic public info
      address TEXT,                        -- Street address
      postal_code TEXT,
      website TEXT,                         -- Official website
      phone TEXT,
      email TEXT,                           -- Public contact email

      -- Opening hours (JSON: [{day:"mon",open:"09:00",close:"17:00"},...])
      opening_hours TEXT DEFAULT '[]',

      -- What they sell (JSON: [{name:"Tomater",category:"vegetables",seasonal:true,months:[6,7,8,9]},...])
      products TEXT DEFAULT '[]',

      -- Rich description from public sources
      about TEXT,                           -- Long-form description
      specialties TEXT DEFAULT '[]',        -- JSON array: ["Økologiske grønnsaker", "Gårdsost"]
      certifications TEXT DEFAULT '[]',     -- JSON array: ["Debio", "Nyt Norge"]
      payment_methods TEXT DEFAULT '[]',    -- JSON array: ["Vipps", "Kontant", "Kort"]
      delivery_options TEXT DEFAULT '[]',   -- JSON array: ["Henting på gård", "REKO-ring"]

      -- Social proof from public sources
      google_rating REAL,                  -- Google Maps rating (1-5)
      google_review_count INTEGER,
      tripadvisor_rating REAL,
      external_reviews TEXT DEFAULT '[]',  -- JSON: [{source:"Google",text:"...",rating:5}]

      -- Images (JSON array of URLs — empty until seller uploads)
      images TEXT DEFAULT '[]',

      -- Data provenance
      data_source TEXT DEFAULT 'auto',     -- 'auto' | 'owner' | 'hybrid'
      auto_sources TEXT DEFAULT '[]',      -- JSON: ["google_maps","bondensmarked.no","rekonorge.no"]
      last_enriched_at TEXT,               -- When auto-enrichment last ran
      owner_updated_at TEXT,               -- When owner last made changes

      -- External links (JSON: [{label:"Facebook",url:"https://...",type:"facebook"},{label:"Neste marked",url:"...",type:"info"}])
      external_links TEXT DEFAULT '[]',

      -- Future: seller preferences (v2 — NL responses, target groups)
      preferences TEXT DEFAULT '{}',       -- JSON: reserved for seller customization

      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ════════════════════════════════════════════════════════════
    -- AGENT_CLAIMS: Seller ownership of their agent
    -- Flow: request → verify (email/phone) → approved → owner
    -- ════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS agent_claims (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      claimant_name TEXT NOT NULL,
      claimant_email TEXT NOT NULL,
      claimant_phone TEXT,
      verification_method TEXT DEFAULT 'email',  -- 'email' | 'phone' | 'manual'
      verification_code TEXT,                     -- 6-digit code sent to verify
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','code_sent','verified','rejected','expired')),
      claim_token TEXT,                           -- Token for managing agent after claim
      claim_token_expires_at TEXT,                -- Token expires 30 days after issue
      notes TEXT,                                 -- Admin notes
      source TEXT DEFAULT 'organic',              -- 'organic' | 'email-apr26' | 'test' | campaign tag
      created_at TEXT DEFAULT (datetime('now')),
      verified_at TEXT,
      expires_at TEXT                             -- Claims expire after 7 days if unverified
    );

    -- ════════════════════════════════════════════════════════════
    -- ANALYTICS: Human visitor tracking (privacy-first)
    -- Tracks page views with referrer source inference
    -- ════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS analytics_page_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,                          -- /sok, /oslo, /produsent/xyz
      referrer TEXT,                               -- HTTP referrer (full URL)
      source TEXT DEFAULT 'unknown',               -- 'direct','organic','search','social','referral'
      user_agent_hash TEXT,                        -- Hashed UA (privacy-safe, no full UA)
      session_id TEXT,                             -- Cookies-based session tracking
      status_code INTEGER,                         -- HTTP status (200/301/404 etc) — null for legacy rows
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ════════════════════════════════════════════════════════════
    -- ANALYTICS: AI agent queries (A2A, MCP, API, search)
    -- Every query by ChatGPT, Claude, or API clients
    -- ════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS analytics_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      protocol TEXT NOT NULL,                      -- 'a2a', 'mcp', 'api', 'search'
      query TEXT NOT NULL,                         -- What they searched for
      categories TEXT,                             -- JSON array: ["vegetables","eggs"]
      city TEXT,                                   -- Geographic filter
      result_count INTEGER DEFAULT 0,              -- How many results returned
      response_time_ms INTEGER,                    -- Request latency
      agent_id TEXT,                               -- Which agent (ChatGPT, Claude, etc.)
      client_ip_hash TEXT,                         -- Hashed IP (privacy-safe)
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ════════════════════════════════════════════════════════════
    -- ANALYTICS: Agent profile views (which producers are popular)
    -- ════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS analytics_agent_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,                      -- Producer UUID
      agent_name TEXT NOT NULL,                    -- Producer name
      city TEXT,                                   -- Producer's city
      view_source TEXT DEFAULT 'unknown',          -- 'search','direct','discovery','seo'
      created_at TEXT DEFAULT (datetime('now'))
    );
    -- ════════════════════════════════════════════════════════════
    -- PLATFORM_TRIGGERS: Inbound event ledger (webhooks + manual + GH Actions)
    -- Filled by POST /platform/triggers/:event_type
    -- Read by scheduled-agents that subscribe to specific event_types
    -- See ARCHITECTURE.md §3.3 + scheduled-agents/platform-trigger-router.md
    -- ════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS platform_triggers (
      trigger_id TEXT PRIMARY KEY,                 -- ULID/UUID generated by us
      event_type TEXT NOT NULL,                    -- gmail.received | deploy.completed | ...
      idempotency_key TEXT NOT NULL UNIQUE,        -- caller-provided, prevents dup fires
      payload TEXT NOT NULL DEFAULT '{}',          -- arbitrary JSON
      source TEXT NOT NULL DEFAULT 'unknown',      -- gmail | github | manual | api | ...
      signature_verified INTEGER NOT NULL DEFAULT 0, -- 1 if HMAC validated
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      consumed_at TEXT,                            -- when an agent claimed it
      consumed_by TEXT,                            -- which agent run_id
      result TEXT                                  -- consumed agent's brief outcome note
    );

    CREATE INDEX IF NOT EXISTS idx_triggers_pending
        ON platform_triggers(event_type, received_at)
        WHERE consumed_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_triggers_received
        ON platform_triggers(received_at DESC);

    -- ════════════════════════════════════════════════════════════
    -- RUNS: Platform run-ledger (every scheduled-agent run lands here)
    -- Contract defined in src/types/run-envelope.ts (RunEnvelope)
    -- Read by platform-verifier (3-layer probes) and orchestrator
    -- ════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,                     -- run-YYYY-MM-DD-<agent>-<seq>-<vertical>
      vertical TEXT NOT NULL DEFAULT 'rfb',        -- rfb | tannlege | ...
      agent TEXT NOT NULL,                         -- marketing | customer-service | enrichment | ...
      trigger_source TEXT NOT NULL,                -- cron | webhook | signal | manual
      started_at TEXT NOT NULL,                    -- ISO 8601 UTC
      finished_at TEXT,                            -- ISO 8601 UTC; null if interrupted
      status TEXT NOT NULL,                        -- completed | failed | partial (agent's view)
      claims TEXT NOT NULL DEFAULT '[]',           -- JSON array of Claim
      evidence TEXT NOT NULL DEFAULT '[]',         -- JSON array of Evidence
      next_suggested TEXT,                         -- JSON array of agent names
      errors TEXT,                                 -- JSON array of {message,meta}
      notes TEXT,                                  -- prose summary <500 chars
      verifier_state TEXT NOT NULL DEFAULT 'pending', -- pending | verified | failed | skipped
      verifier_checked_at TEXT,                    -- ISO 8601 UTC; null until verifier touches it
      verifier_findings TEXT,                      -- JSON array of VerifierFinding
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );


    -- ════════════════════════════════════════════════════════════
    -- RETENTION: Daily rollup tables for DB size management
    -- page_view_daily: aggregated page-view counts per day×path×source×bot_type×vertical
    -- runs_daily_summary: aggregated run-ledger counts after raw pruning
    -- ════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS page_view_daily (
      day TEXT NOT NULL,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'unknown',
      bot_type TEXT NOT NULL DEFAULT 'human',   -- human|chatgpt|claude|other_bot|dev|scanner
      vertical_id TEXT NOT NULL DEFAULT 'rfb',
      view_count INTEGER NOT NULL DEFAULT 0,
      session_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, path, source, bot_type, vertical_id)
    );
    CREATE INDEX IF NOT EXISTS idx_page_view_daily_day ON page_view_daily(day DESC);

    CREATE TABLE IF NOT EXISTS runs_daily_summary (
      day TEXT NOT NULL,
      vertical TEXT NOT NULL,
      agent TEXT NOT NULL,
      run_count INTEGER NOT NULL DEFAULT 0,
      completed_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      partial_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, vertical, agent)
    );

    -- ════════════════════════════════════════════════════════════
    -- INDEXES: Geo bounding-box + common lookups
    -- These make discovery fast without PostGIS
    -- ════════════════════════════════════════════════════════════
    CREATE INDEX IF NOT EXISTS idx_agents_geo ON agents(lat, lng) WHERE is_active = 1;
    CREATE INDEX IF NOT EXISTS idx_agents_role ON agents(role) WHERE is_active = 1;
    CREATE INDEX IF NOT EXISTS idx_agents_api_key ON agents(api_key);
    -- PR-93: speeds up GET /admin/agents (filters on last_seen_at + status)
    CREATE INDEX IF NOT EXISTS idx_agents_lastseen_active ON agents(last_seen_at, is_active);
    CREATE INDEX IF NOT EXISTS idx_listings_geo ON listings(lat, lng);
    CREATE INDEX IF NOT EXISTS idx_listings_agent ON listings(agent_id);
    CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_consumer ON tasks(consumer_agent_id);

    -- Interaction indexes
    CREATE INDEX IF NOT EXISTS idx_interactions_type ON interactions(type);
    CREATE INDEX IF NOT EXISTS idx_interactions_agent ON interactions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_interactions_created ON interactions(created_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_buyer ON conversations(buyer_agent_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_seller ON conversations(seller_agent_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
    -- Run ledger indexes
    CREATE INDEX IF NOT EXISTS idx_runs_vertical_agent_started
        ON runs(vertical, agent, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_verifier_pending
        ON runs(verifier_state, started_at DESC)
        WHERE verifier_state IN ('pending', 'failed');
    CREATE INDEX IF NOT EXISTS idx_runs_status_finished
        ON runs(status, finished_at DESC);


    -- Knowledge & claims indexes
    CREATE INDEX IF NOT EXISTS idx_agent_claims_agent ON agent_claims(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_claims_status ON agent_claims(status);
    CREATE INDEX IF NOT EXISTS idx_agent_claims_email ON agent_claims(claimant_email);

    -- ════════════════════════════════════════════════════════════
    -- MAGIC LINKS: Passwordless login tokens
    -- ════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS magic_links (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_magic_links_token ON magic_links(token);
    CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links(email);

    -- ─── agent_blocklist ─────────────────────────────────────
    -- "Do not re-add" list. When a producer asks to be removed
    -- (replies "fjern" to outreach, sends GDPR request, etc.) we
    -- delete their agent row AND record their identifying signals
    -- here, so the daily discovery agent doesn't just re-find them
    -- on lokalmat.no/Facebook the next morning and re-insert them.
    --
    -- identifier_type: 'website_domain' | 'email' (PR-14, literal) |
    --                  'name_normalized' | 'agent_id'
    -- LEGACY (purged on boot): 'email_domain' — see PR-14 migration below
    -- A single blocklist request typically inserts 2-3 rows
    -- (domain + normalized name) so we catch them whether the next
    -- discovery cycle finds them by name OR by website.
    CREATE TABLE IF NOT EXISTS agent_blocklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identifier_type TEXT NOT NULL,
      identifier_value TEXT NOT NULL,
      reason TEXT,
      source_email TEXT,
      original_agent_id TEXT,
      original_agent_name TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(identifier_type, identifier_value)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_blocklist_type_value ON agent_blocklist(identifier_type, identifier_value);

    -- PR-14 (2026-05-10): migrate away from 'email_domain' identifier_type.
    -- Reason: blocking whole email domains produces too many false-positives
    -- for free-mail addresses (every gmail.com user gets blocked when any
    -- gmail-using agent is deleted). New entries store literal email
    -- addresses under identifier_type='email'. Existing 'email_domain' rows
    -- are purged here. Migration is idempotent — runs every boot and only
    -- removes rows that survived a prior boot.
    DELETE FROM agent_blocklist WHERE identifier_type = 'email_domain';

    -- ─── email_bounces (Phase 4.14 / WO #6) ────────────────────
    -- Resend reports bounces; we mirror them so marketing-comms can
    -- exclude bounced addresses and enrichment-agent can investigate
    -- alternative addresses for hard-bounce producers.
    CREATE TABLE IF NOT EXISTS email_bounces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      bounced_at TEXT NOT NULL,
      resend_email_id TEXT,
      bounce_type TEXT,
      reason TEXT,
      agent_id_at_send TEXT,
      batch_id TEXT,
      investigated INTEGER DEFAULT 0,
      investigated_at TEXT,
      investigation_outcome TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_email_bounces_email ON email_bounces(email);
    CREATE INDEX IF NOT EXISTS idx_email_bounces_investigated ON email_bounces(investigated, bounced_at);
    CREATE INDEX IF NOT EXISTS idx_email_bounces_bounced_at ON email_bounces(bounced_at);
    -- UNIQUE on (email, COALESCE(resend_email_id,'')) so retries are idempotent
    CREATE UNIQUE INDEX IF NOT EXISTS idx_email_bounces_dedup
      ON email_bounces(email, COALESCE(resend_email_id, ''));


    -- Analytics indexes (for fast aggregation)
    CREATE INDEX IF NOT EXISTS idx_analytics_page_views_created ON analytics_page_views(created_at);
    CREATE INDEX IF NOT EXISTS idx_analytics_page_views_source ON analytics_page_views(source);
    CREATE INDEX IF NOT EXISTS idx_analytics_page_views_path ON analytics_page_views(path);
    CREATE INDEX IF NOT EXISTS idx_analytics_queries_created ON analytics_queries(created_at);
    CREATE INDEX IF NOT EXISTS idx_analytics_queries_protocol ON analytics_queries(protocol);
    CREATE INDEX IF NOT EXISTS idx_analytics_queries_agent ON analytics_queries(agent_id);
    CREATE INDEX IF NOT EXISTS idx_analytics_agent_views_created ON analytics_agent_views(created_at);
    CREATE INDEX IF NOT EXISTS idx_analytics_agent_views_agent ON analytics_agent_views(agent_id);
  `);

  // ════════════════════════════════════════════════════════════
  // CRM: contacts, threads, messages, actions, outbox
  // Inbox-CRM for customer-service workflow.
  // Producer threads link to agents.id; vendor/marketing threads
  // are stand-alone contacts.
  // ════════════════════════════════════════════════════════════
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_contacts (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('producer','marketing','vendor','unknown')),
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      email TEXT NOT NULL,
      name TEXT,
      domain TEXT,
      organization TEXT,
      notes TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','blocked','archived')),
      first_seen_at TEXT DEFAULT (datetime('now')),
      last_seen_at TEXT DEFAULT (datetime('now')),
      metadata TEXT DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_crm_contacts_email ON crm_contacts(email);
    CREATE INDEX IF NOT EXISTS idx_crm_contacts_type ON crm_contacts(type);
    CREATE INDEX IF NOT EXISTS idx_crm_contacts_agent ON crm_contacts(agent_id);
    CREATE INDEX IF NOT EXISTS idx_crm_contacts_domain ON crm_contacts(domain);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_contacts_email_unique ON crm_contacts(email);

    CREATE TABLE IF NOT EXISTS crm_threads (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
      subject TEXT,
      status TEXT DEFAULT 'new' CHECK(status IN ('new','in_progress','awaiting_review','done','archived')),
      assigned_to TEXT DEFAULT 'unassigned' CHECK(assigned_to IN ('unassigned','claude','daniel')),
      category TEXT CHECK(category IN ('innkommende','system','marketing','leverandor','unknown')),
      severity TEXT DEFAULT 'normal' CHECK(severity IN ('p0','p1','p2','normal')),
      message_count INTEGER DEFAULT 0,
      last_message_at TEXT,
      last_inbound_at TEXT,
      last_outbound_at TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_crm_threads_contact ON crm_threads(contact_id);
    CREATE INDEX IF NOT EXISTS idx_crm_threads_status ON crm_threads(status);
    CREATE INDEX IF NOT EXISTS idx_crm_threads_category ON crm_threads(category);
    CREATE INDEX IF NOT EXISTS idx_crm_threads_last_message ON crm_threads(last_message_at);

    CREATE TABLE IF NOT EXISTS crm_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES crm_threads(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK(direction IN ('in','out')),
      from_email TEXT NOT NULL,
      to_emails TEXT,
      cc_emails TEXT,
      subject TEXT,
      body_text TEXT,
      body_html TEXT,
      snippet TEXT,
      sent_at TEXT,
      received_at TEXT DEFAULT (datetime('now')),
      raw_metadata TEXT DEFAULT '{}',
      delivery_status TEXT NOT NULL DEFAULT 'sent'
        CHECK(delivery_status IN ('sent','queued','draft_in_gmail','failed'))
    );
    CREATE INDEX IF NOT EXISTS idx_crm_messages_thread ON crm_messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_crm_messages_sent_at ON crm_messages(sent_at);

    CREATE TABLE IF NOT EXISTS crm_actions (
      id TEXT PRIMARY KEY,
      thread_id TEXT REFERENCES crm_threads(id) ON DELETE CASCADE,
      contact_id TEXT REFERENCES crm_contacts(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      actor TEXT NOT NULL CHECK(actor IN ('claude','daniel','system')),
      payload TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_crm_actions_thread ON crm_actions(thread_id);
    CREATE INDEX IF NOT EXISTS idx_crm_actions_contact ON crm_actions(contact_id);
    CREATE INDEX IF NOT EXISTS idx_crm_actions_created ON crm_actions(created_at);

    CREATE TABLE IF NOT EXISTS crm_outbox (
      id TEXT PRIMARY KEY,
      thread_id TEXT REFERENCES crm_threads(id) ON DELETE SET NULL,
      contact_id TEXT REFERENCES crm_contacts(id) ON DELETE SET NULL,
      intent TEXT NOT NULL CHECK(intent IN ('gmail_draft','resend_send')),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed')),
      to_emails TEXT NOT NULL,
      cc_emails TEXT,
      subject TEXT NOT NULL,
      body_text TEXT NOT NULL,
      body_html TEXT,
      reply_to_message_id TEXT,
      result_id TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      processed_at TEXT,
      created_by TEXT NOT NULL CHECK(created_by IN ('claude','daniel'))
    );
    CREATE INDEX IF NOT EXISTS idx_crm_outbox_status ON crm_outbox(status);
    CREATE INDEX IF NOT EXISTS idx_crm_outbox_intent ON crm_outbox(intent);

    -- ─── producer_observations ───────────────────────────────
    -- Cache for LLM-generated personal observations used in v2
    -- outreach mailene.  One row per producer; reused across follow-up
    -- mails so we don't re-spend $ on the same observation.
    CREATE TABLE IF NOT EXISTS producer_observations (
      producer_id INTEGER PRIMARY KEY,
      observation TEXT NOT NULL,
      generated_at TEXT NOT NULL DEFAULT (datetime('now')),
      used_in_batches TEXT DEFAULT ''  -- comma-separated batch IDs (e16,e17,...)
    );
  `);


  // ─── Safe migrations for existing databases ─────────────────

  // crm_messages.delivery_status — added 2026-05-01 to fix a bug where outbound
  // messages were marked as sent immediately on compose, even when the actual
  // Resend send failed or the email was just queued as a Gmail draft.  Default
  // 'sent' keeps existing rows truthful (they were inbound or actually sent).
  try {
    db.exec("ALTER TABLE crm_messages ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'sent' CHECK(delivery_status IN ('sent','queued','draft_in_gmail','failed'))");
  } catch (e) {
    // column already exists — fine
  }

  // SQLite doesn't support ADD COLUMN IF NOT EXISTS, so we catch
  // the "duplicate column" error and ignore it.
  try {
    db.exec(`ALTER TABLE agent_claims ADD COLUMN claim_token_expires_at TEXT`);
  } catch {
    // Column already exists — expected after first migration
  }

  try {
    db.exec(`ALTER TABLE agent_knowledge ADD COLUMN external_links TEXT DEFAULT '[]'`);
  } catch {
    // Column already exists
  }

  try {
    db.exec(`ALTER TABLE agent_claims ADD COLUMN source TEXT DEFAULT 'organic'`);
  } catch {
    // Column already exists — expected after first migration
  }

  // ─── Tier 2: Add seasonality, delivery_radius, min_order_value ──
  try {
    db.exec(`ALTER TABLE agent_knowledge ADD COLUMN seasonality TEXT DEFAULT '[]'`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE agent_knowledge ADD COLUMN delivery_radius REAL`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE agent_knowledge ADD COLUMN min_order_value REAL`);
  } catch {
    // Column already exists
  }

  // ─── Tier 3: A2A protocol versioning fields ─────────────────
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN schema_version TEXT DEFAULT 'urn:a2a:1.0'`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN agent_version INTEGER DEFAULT 1`);
  } catch {
    // Column already exists
  }

  // ─── Phase 4.13 / WO #5: claim tracking columns ─────────────
  // claimed_by_user_id, claimed_at, claimed_via — populated when the
  // agent's owner takes ownership of the listing. Backfill not needed:
  // existing rows are pre-claim (or admin-manual), and that semantic
  // is captured by NULL claimed_via.
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN claimed_by_user_id TEXT`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN claimed_at TEXT`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN claimed_via TEXT`);
  } catch {
    // Column already exists
  }

  // ─── Add is_owner column to analytics tables ─────────────────
  // Allows filtering out owner/developer traffic in dashboard
  for (const table of ["analytics_page_views", "analytics_queries", "analytics_agent_views"]) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN is_owner INTEGER DEFAULT 0`);
    } catch {
      // Column already exists
    }
  }

  // ─── Add status_code to page_views ───────────────────────────
  // Lets us measure what AI bots actually hit — 200 vs 301 vs 404 —
  // so the fuzzy-redirect fix's effect is visible in analytics.
  try {
    db.exec(`ALTER TABLE analytics_page_views ADD COLUMN status_code INTEGER`);
  } catch {
    // Column already exists
  }

  // ─── Add source column to conversations ──────────────────────
  // Tracks where a conversation originated: a2a, mcp, web, api
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN source TEXT DEFAULT 'api'`);
  } catch {
    // Column already exists
  }

  // ─── M1 (Phase 5.4a): magic_links.used_at ───────────────────
  // Tracks WHEN a magic-link token was actually used (clicked & redeemed).
  // Backfill for already-used rows: copy created_at as best-available estimate.
  try {
    db.exec(`ALTER TABLE magic_links ADD COLUMN used_at TEXT`);
  } catch (e: any) {
    if (!String(e?.message || '').includes('duplicate column name')) throw e;
    // Column already exists — idempotent, safe to ignore
  }
  try {
    db.exec(`UPDATE magic_links SET used_at = created_at WHERE used = 1 AND used_at IS NULL`);
  } catch (e) {
    // backfill is best-effort
  }


  // ─── Phase 4.6a — vertical_id column on per-vertical tables ───
  // Multi-vertical groundwork: every per-tenant row belongs to exactly
  // one vertical. Default 'rfb' on existing rows means RFB is unaffected.
  // Phase 4.6b will start filtering queries by vertical_id; until then
  // this column is dormant data.
  //
  // SQLite supports NOT NULL DEFAULT on ALTER TABLE — existing rows
  // backfill automatically. Note: we don't add the column in CREATE TABLE
  // because that requires editing 22 multi-line statements with embedded
  // CHECK/DEFAULT clauses (regex-prone). The ALTER block below runs every
  // boot and is idempotent (try/catch on duplicate-column).
  for (const table of [
    "agents",
    "agent_blocklist",
    "agent_claims",
    "agent_knowledge",
    "agent_metrics",
    "analytics_agent_views",
    "analytics_page_views",
    "analytics_queries",
    "chain_prices",
    "conversations",
    "crm_actions",
    "crm_contacts",
    "crm_messages",
    "crm_outbox",
    "crm_threads",
    "interactions",
    "listings",
    "magic_links",
    "messages",
    "platform_triggers",
    "producer_observations",
    "tasks",
  ]) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN vertical_id TEXT NOT NULL DEFAULT 'rfb'`);
    } catch {
      // Column already exists — expected after first migration
    }
  }

  // Index for the hottest table (agents). Other tables get indexes
  // when Phase 4.6b starts filtering on them.
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_vertical_id ON agents(vertical_id)`);
  } catch {
    // Index already exists
  }

  // Dashboards filter analytics by vertical_id (rfb vs dental) — index the
  // analytics tables so the per-vertical WHERE clauses stay cheap.
  for (const [idx, tbl] of [
    ["idx_analytics_page_views_vertical", "analytics_page_views"],
    ["idx_analytics_queries_vertical", "analytics_queries"],
    ["idx_analytics_agent_views_vertical", "analytics_agent_views"],
  ]) {
    try {
      db.exec(`CREATE INDEX IF NOT EXISTS ${idx} ON ${tbl}(vertical_id, created_at)`);
    } catch {
      // Index already exists
    }
  }

  // ─── Backfill: dental page views misattributed as 'rfb' ───────
  // finn-tannlege.com went live 2026-06-04, but the analytics middleware
  // didn't stamp vertical_id until the vertical-split PR — so every dental
  // page view between launch and deploy sits with the default 'rfb'.
  // Best-effort re-tag: these path prefixes are served ONLY by the dental
  // SEO router (dental-seo.ts) and can't be rfb traffic. Shared paths
  // ("/", "/sok", "/om", sitemap/robots/llms) are ambiguous without the
  // Host header and intentionally stay as-is.
  // Migration-flagged: runs once, safe on fresh DBs (0 rows updated).
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
    const alreadyRan = db.prepare("SELECT 1 FROM migrations WHERE name = 'backfill_dental_vertical_v1'").get();
    if (!alreadyRan) {
      const result = db.prepare(`
        UPDATE analytics_page_views
        SET vertical_id = 'dental'
        WHERE vertical_id = 'rfb'
          AND (
            path LIKE '/klinikk/%'
            OR path LIKE '/fylke/%'
            OR path LIKE '/spesialitet/%'
            OR path LIKE '/sted/%'
            OR path = '/hvordan-det-fungerer'
            OR path LIKE '/api/tannlege%'
          )
      `).run();
      db.prepare("INSERT INTO migrations (name) VALUES ('backfill_dental_vertical_v1')").run();
      if (result.changes > 0) {
        console.log(`\u{1F9F9} Migration backfill_dental_vertical_v1: re-tagged ${result.changes} page view(s) as dental`);
      }
    }
  } catch (err) {
    console.error("Migration backfill_dental_vertical_v1 failed:", err);
  }


  // ─── Phase 4.9a — agent_knowledge.curated_fields ──────────────
  // Customer-curated content protection: when CS-agent applies a
  // customer-requested change (about-text, opening hours, contact info),
  // the field is locked here. Enrichment-agent must check curated_fields
  // before PUT and skip locked fields — otherwise customer's preferred
  // text gets overwritten on next crawl.
  //
  // Schema: JSON object, keyed by field name.
  //   {
  //     "about": {"locked_at": "ISO", "by": "rfb-customer-service",
  //               "thread_id": "<gmail-thread>", "request_summary": "..."},
  //     "opening_hours": {...}
  //   }
  // Empty {} = no locks (default for all existing rows).
  try {
    db.exec(`ALTER TABLE agent_knowledge ADD COLUMN curated_fields TEXT NOT NULL DEFAULT '{}'`);
  } catch {
    // Column already exists — expected after first migration
  }


  // ─── orch-pr-87 — agent_knowledge.sweep_round + sweep_processed_at ─
  // Systematic-sweep observability (PHASE5: full-sweep design,
  // 2026-05-23). `sweep_processed_at` is set on every verifier write
  // (see applyVerifierOutcome in lokal-agent-verifier.ts). `sweep_round`
  // is reserved for app-layer computation (current v1 leaves the column
  // at its default of 0; the useful signal today is the min/max of
  // sweep_processed_at, exposed via getSweepStatus() and the
  // GET /admin/verifier/sweep-status endpoint).
  //
  // Both ALTERs are wrapped in try/catch — idempotent across re-runs.
  try {
    db.exec(`ALTER TABLE agent_knowledge ADD COLUMN sweep_round INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists — expected after first migration
  }
  try {
    db.exec(`ALTER TABLE agent_knowledge ADD COLUMN sweep_processed_at TEXT`);
  } catch {
    // Column already exists — expected after first migration
  }


  // ─── Phase 4.10c-2 Steg 1 — DB-trigger: auto-update last_outbound_at ─
  // Whenever a crm_messages row is INSERTed with direction='out' AND
  // delivery_status='sent', set the parent thread's last_outbound_at if
  // either it's NULL or the new sent_at is newer. Closes the duplicate-send
  // bug where the agent never knew an outbound had already been sent.
  //
  // Idempotent: CREATE TRIGGER IF NOT EXISTS — safe to re-run on every boot.
  // Catches every write path including manual scripts, future agents,
  // Resend-webhooks if/when added — not just the composeNewThread path.
  //
  // Origin: orchestrator work-order #2 (run-2026-05-03T1940-platform-orchestrator-rfb).
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_update_thread_outbound_at
        AFTER INSERT ON crm_messages
        FOR EACH ROW
        WHEN NEW.direction = 'out' AND NEW.delivery_status = 'sent'
        BEGIN
          UPDATE crm_threads
          SET last_outbound_at = NEW.sent_at,
              updated_at = datetime('now')
          WHERE id = NEW.thread_id
            AND (last_outbound_at IS NULL OR last_outbound_at < NEW.sent_at);
        END
    `);
  } catch (err) {
    console.error("Migration trg_update_thread_outbound_at failed:", err);
  }

  // ─── Idempotent backfill: same migration block as the trigger ────
  // Catch threads that were created before the trigger landed, OR that
  // were INSERTed with delivery_status='sent' via paths not covered by
  // composeNewThread (which already sets last_outbound_at synchronously).
  // Safe re-run: WHERE filter ensures only NULL→MAX(sent_at) updates.
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
    const alreadyRan = db.prepare("SELECT 1 FROM migrations WHERE name = 'backfill_last_outbound_at_v1'").get();
    if (!alreadyRan) {
      const result = db.prepare(`
        UPDATE crm_threads
        SET last_outbound_at = (
              SELECT MAX(sent_at)
              FROM crm_messages
              WHERE crm_messages.thread_id = crm_threads.id
                AND direction = 'out'
                AND delivery_status = 'sent'
            ),
            updated_at = datetime('now')
        WHERE last_outbound_at IS NULL
          AND EXISTS (
            SELECT 1 FROM crm_messages
            WHERE crm_messages.thread_id = crm_threads.id
              AND direction = 'out'
              AND delivery_status = 'sent'
          )
      `).run();
      db.prepare("INSERT INTO migrations (name) VALUES ('backfill_last_outbound_at_v1')").run();
      if (result.changes > 0) {
        console.log(`🧹 Migration backfill_last_outbound_at_v1: updated ${result.changes} thread(s)`);
      }
    }
  } catch (err) {
    console.error("Migration backfill_last_outbound_at_v1 failed:", err);
  }


  // ─── One-time cleanup: reset all test verifications ──────────
  // No real sellers have claimed yet — all is_verified=1 entries
  // are from development/testing. Reset them to 0 and clean claims.
  // Uses a migration flag so this only runs once.
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
    const alreadyRan = db.prepare("SELECT 1 FROM migrations WHERE name = 'reset_test_verifications_v1'").get();
    if (!alreadyRan) {
      const resetCount = db.prepare("UPDATE agents SET is_verified = 0 WHERE is_verified = 1").run().changes;
      db.prepare("DELETE FROM agent_claims").run();
      db.prepare("INSERT INTO migrations (name) VALUES ('reset_test_verifications_v1')").run();
      if (resetCount > 0) {
        console.log(`🧹 Migration: reset ${resetCount} test verifications and cleared all claims`);
      }
    }
  } catch (err) {
    console.error("Migration reset_test_verifications failed:", err);
  }

  // ─── Phase 5.1 — verify-first schema (WO #7, 2026-05-05) ─────
  // Adds the columns that lokal-agent-verifier (WO #8, future) will
  // populate. All seven columns get safe defaults so the existing
  // 1416 agents start as `unverified`/`thin` and the marketing
  // pipeline keeps reading from the legacy uncontacted-pool until
  // WO #9 switches it to outreach_ready_pool.
  //
  // Reference: PHASE5-DATA-QUALITY-PLAN.md §3.1
  for (const stmt of [
    `ALTER TABLE agent_knowledge ADD COLUMN field_provenance TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE agent_knowledge ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'unverified'`,
    `ALTER TABLE agent_knowledge ADD COLUMN enrichment_status TEXT NOT NULL DEFAULT 'thin'`,
    `ALTER TABLE agent_knowledge ADD COLUMN outreach_eligible_at TEXT`,
    `ALTER TABLE agent_knowledge ADD COLUMN last_verified_at TEXT`,
    `ALTER TABLE agent_knowledge ADD COLUMN last_http_check_at TEXT`,
    `ALTER TABLE agent_knowledge ADD COLUMN last_http_status INTEGER`,
    // ─── PR-21 / WO-19 (2026-05-10): link-freshness probe ───
    // url_last_probed: ISO timestamp of the last HEAD/GET probe of agent.url
    // url_last_status: HTTP status returned (0 = network failure / abort).
    // Together with the outreach_ready_pool VIEW these enforce a 30d freshness
    // window so marketing never emails an agent whose homepage 4xx/5xx's.
    `ALTER TABLE agent_knowledge ADD COLUMN url_last_probed TEXT`,
    `ALTER TABLE agent_knowledge ADD COLUMN url_last_status INTEGER`,
  ]) {
    try {
      db.exec(stmt);
    } catch {
      // Column already exists — expected after first migration
    }
  }

  // outreach_sent_log — Phase 5 ledger of WHAT we have actually sent
  // through the verify-first pipeline. Empty initially; the WO #9
  // marketing-pool-switch will start writing rows here. CRM threads
  // are NOT backfilled in here on purpose — they belong to the legacy
  // uncontacted-pool and have their own dedupe (last_outbound_at).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS outreach_sent_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        sent_at TEXT NOT NULL DEFAULT (datetime('now')),
        channel TEXT NOT NULL DEFAULT 'email',
        message_id TEXT,
        notes TEXT
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_outreach_sent_log_agent ON outreach_sent_log(agent_id)`);
  } catch (err) {
    console.error("Migration outreach_sent_log failed:", err);
  }

  // ─── PR-38: auto-record marketing sends to outreach_sent_log ─────────────
  //
  // PROBLEM: outreach_sent_log had no live-path writer. The marketing agent
  // calls /admin/crm/ingest after each Resend send (category:"innkommende",
  // threadId:"marketing-batch-eN-<producerId>"). That INSERT fires into
  // crm_messages with delivery_status='sent' (the column default). Without
  // this trigger the outreach_ready_pool VIEW's NOT EXISTS gate never sees the
  // send, so the same producer leaks back into the pool on the next batch.
  //
  // DESIGN NOTE: we identify marketing threads by the canonical threadId prefix
  // "marketing-batch-" (NOT by crm_threads.category = 'marketing' — the agent
  // sends category:"innkommende" per its CRM-ingest addendum, confirmed in
  // marketing-comms-agent-crm-ingest-addendum.md). This is the authoritative
  // discriminator: every other thread kind uses Gmail thread IDs (long hex
  // strings) or the compose-<uuid> pattern from composeNewThread().
  //
  // Idempotent: CREATE TRIGGER IF NOT EXISTS — safe to re-run on every boot.
  // Dedup guard: NOT EXISTS on message_id prevents double-inserts if the
  // trigger somehow fires twice (e.g. future REPLACE INTO path).
  //
  // Origin: orchestrator PR-38 (2026-06-21).
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_log_marketing_send_to_outreach_sent_log
        AFTER INSERT ON crm_messages
        FOR EACH ROW
        WHEN NEW.direction = 'out' AND NEW.delivery_status = 'sent'
        BEGIN
          INSERT INTO outreach_sent_log (agent_id, sent_at, channel, message_id, notes)
          SELECT cc.agent_id,
                 COALESCE(NEW.sent_at, datetime('now')),
                 'email',
                 NEW.id,
                 'auto:marketing_crm_send'
          FROM crm_threads ct
          JOIN crm_contacts cc ON cc.id = ct.contact_id
          WHERE ct.id = NEW.thread_id
            AND ct.id LIKE 'marketing-batch-%'
            AND cc.agent_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM outreach_sent_log o WHERE o.message_id = NEW.id
            );
        END
    `);
  } catch (err) {
    console.error("Migration trg_log_marketing_send_to_outreach_sent_log failed:", err);
  }

  // ─── PR-38: backfill existing marketing sends into outreach_sent_log ─────
  //
  // One-time idempotent backfill: find every crm_messages row that is an
  // out/sent message on a marketing-batch thread whose agent_id is resolvable
  // and is NOT yet in outreach_sent_log, and insert it.
  //
  // "marketing-batch-" threadId prefix is the canonical discriminator (see
  // trigger comment above). We log each row count so the boot log shows
  // whether legacy sends were picked up.
  //
  // Guarded by the migrations table — runs exactly once per DB file.
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
    const alreadyRanBackfill = db.prepare("SELECT 1 FROM migrations WHERE name = 'backfill_marketing_sends_to_sent_log_v1'").get();
    if (!alreadyRanBackfill) {
      const backfillResult = db.prepare(`
        INSERT INTO outreach_sent_log (agent_id, sent_at, channel, message_id, notes)
        SELECT cc.agent_id,
               COALESCE(m.sent_at, datetime('now')),
               'email',
               m.id,
               'backfill:marketing_crm_send_v1'
        FROM crm_messages m
        JOIN crm_threads ct ON ct.id = m.thread_id
        JOIN crm_contacts cc ON cc.id = ct.contact_id
        WHERE m.direction = 'out'
          AND m.delivery_status = 'sent'
          AND ct.id LIKE 'marketing-batch-%'
          AND cc.agent_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM outreach_sent_log o WHERE o.message_id = m.id
          )
      `).run();
      db.prepare("INSERT INTO migrations (name) VALUES ('backfill_marketing_sends_to_sent_log_v1')").run();
      if (backfillResult.changes > 0) {
        console.log(`[PR-38] Migration backfill_marketing_sends_to_sent_log_v1: inserted ${backfillResult.changes} row(s) into outreach_sent_log`);
      }
    }
  } catch (err) {
    console.error("Migration backfill_marketing_sends_to_sent_log_v1 failed:", err);
  }

  // ─── v2: reclassify contacts via agent_knowledge.email + backfill sent log ─
  //
  // PROBLEM: classifyEmail() only matched agents.contact_email. Marketing's
  // real outreach recipient is agent_knowledge.email, which is frequently a
  // different (often personal) address. Contacts stuck at type='unknown' with
  // agent_id IS NULL never satisfy the PR-38 trigger's agent_id IS NOT NULL
  // guard, so their sends never landed in outreach_sent_log and they kept
  // reappearing in the outreach_ready_pool candidate list (confirmed live:
  // Olestølen Mikroysteri, agent_id 53c171e2-3b18-4486-bd82-5d7c9938c789,
  // recontacted 3 consecutive days 2026-07-01..2026-07-03 despite already
  // having been sent to on 2026-07-01).
  //
  // Step 1: reclassify existing unknown/unlinked crm_contacts by matching
  // their email against agent_knowledge.email (exact match only — see
  // classifyEmail() 1b for why domain-matching this column would be wrong).
  // Step 2: re-run the PR-38-style backfill so any marketing sends that were
  // stuck behind the unresolved agent_id now get logged into
  // outreach_sent_log, retroactively suppressing those producers from the
  // pool.
  //
  // Guarded by the migrations table — runs exactly once per DB file.
  try {
    const alreadyRanReclassify = db.prepare(
      "SELECT 1 FROM migrations WHERE name = 'reclassify_contacts_and_backfill_sent_log_v2_agent_knowledge_email'"
    ).get();
    if (!alreadyRanReclassify) {
      const reclassifyResult = db.prepare(`
        UPDATE crm_contacts
        SET type = 'producer',
            agent_id = (
              SELECT a.id
              FROM agent_knowledge k
              JOIN agents a ON a.id = k.agent_id
              WHERE LOWER(k.email) = crm_contacts.email
                AND a.is_active = 1
              LIMIT 1
            )
        WHERE type = 'unknown'
          AND agent_id IS NULL
          AND EXISTS (
            SELECT 1
            FROM agent_knowledge k
            JOIN agents a ON a.id = k.agent_id
            WHERE LOWER(k.email) = crm_contacts.email
              AND a.is_active = 1
          )
      `).run();
      if (reclassifyResult.changes > 0) {
        console.log(`[v2] Migration reclassify_contacts_and_backfill_sent_log_v2_agent_knowledge_email: reclassified ${reclassifyResult.changes} crm_contacts row(s) to producer via agent_knowledge.email`);
      }

      const backfillKnowledgeResult = db.prepare(`
        INSERT INTO outreach_sent_log (agent_id, sent_at, channel, message_id, notes)
        SELECT cc.agent_id,
               COALESCE(m.sent_at, datetime('now')),
               'email',
               m.id,
               'backfill:marketing_crm_send_agent_knowledge_email_v1'
        FROM crm_messages m
        JOIN crm_threads ct ON ct.id = m.thread_id
        JOIN crm_contacts cc ON cc.id = ct.contact_id
        WHERE m.direction = 'out'
          AND m.delivery_status = 'sent'
          AND ct.id LIKE 'marketing-batch-%'
          AND cc.agent_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM outreach_sent_log o WHERE o.message_id = m.id
          )
      `).run();
      if (backfillKnowledgeResult.changes > 0) {
        console.log(`[v2] Migration reclassify_contacts_and_backfill_sent_log_v2_agent_knowledge_email: inserted ${backfillKnowledgeResult.changes} row(s) into outreach_sent_log`);
      }

      db.prepare("INSERT INTO migrations (name) VALUES ('reclassify_contacts_and_backfill_sent_log_v2_agent_knowledge_email')").run();
    }
  } catch (err) {
    console.error("Migration reclassify_contacts_and_backfill_sent_log_v2_agent_knowledge_email failed:", err);
  }


  // outreach_ready_pool VIEW — the list marketing will read once
  // WO #9 switches over. Filtered by:
  //   - non-null email
  //   - verification_status = 'verified'
  //   - enrichment_status in ('partial','rich')
  //   - never sent through the new pipeline (outreach_sent_log)
  // NOTE: agents.removed_at does not exist yet (Phase 5.10) — using
  // 1=1 as placeholder so the VIEW resolves on prod today.
  try {
    db.exec(`DROP VIEW IF EXISTS outreach_ready_pool`);
    // ─── PR-21 / WO-19 (2026-05-10): link-freshness gating ───
    // Two extra conditions vs. the original WO #7 view:
    //   - url_last_status BETWEEN 200 AND 399  → URL was reachable last probe
    //   - url_last_probed > now-30d            → probe is fresh
    // Together: an agent whose URL has not been probed in 30d, OR whose last
    // probe returned 4xx/5xx/0, is silently dropped from the marketing pool
    // until lokal-agent-verifier re-probes successfully.
    db.exec(`
      CREATE VIEW outreach_ready_pool AS
      SELECT
        a.id AS agent_id,
        a.name,
        a.role,
        a.city AS location_city,
        k.email,
        k.phone,
        k.verification_status,
        k.enrichment_status,
        k.outreach_eligible_at,
        k.last_verified_at,
        k.url_last_probed,
        k.url_last_status
      FROM agents a
      INNER JOIN agent_knowledge k ON k.agent_id = a.id
      WHERE
        k.email IS NOT NULL
        AND k.email != ''
        AND a.umbrella_type IS NULL  /* Phase 5.11 A4.1: exclude umbrella agents from marketing outreach */
        AND k.verification_status = 'verified'
        AND k.enrichment_status IN ('partial', 'rich')
        AND 1=1  /* TODO Phase 5.10: AND a.removed_at IS NULL */
        AND k.url_last_status IS NOT NULL
        AND k.url_last_status >= 200
        AND k.url_last_status < 400
        AND k.url_last_probed IS NOT NULL
        AND k.url_last_probed > datetime('now', '-30 days')
        AND NOT EXISTS (
          SELECT 1 FROM outreach_sent_log o
          WHERE o.agent_id = a.id
        )
    `);
  } catch (err) {
    console.error("Migration outreach_ready_pool VIEW failed:", err);
  }

  // Phase 5.1 backfill — populate field_provenance for existing rows
  // from data_source + auto_sources. Tier-B confidence (0.7) since
  // these were enriched before per-field provenance existed.
  try {
    const alreadyRan = db.prepare(
      "SELECT 1 FROM migrations WHERE name = 'phase51_backfill_provenance_v1'"
    ).get();
    if (!alreadyRan) {
      const rows = db.prepare(`
        SELECT agent_id, address, phone, email, about, products,
               opening_hours, specialties, certifications,
               data_source, auto_sources, last_enriched_at
        FROM agent_knowledge
        WHERE field_provenance = '{}' OR field_provenance IS NULL
      `).all() as any[];
      const trackable = ['address','phone','email','about','products','opening_hours','specialties','certifications'];
      const upd = db.prepare("UPDATE agent_knowledge SET field_provenance = ? WHERE agent_id = ?");
      let touched = 0;
      const tx = db.transaction((batch: any[]) => {
        for (const r of batch) {
          let sources: string[] = [];
          try { sources = JSON.parse(r.auto_sources || '[]'); } catch { sources = []; }
          const provenance: Record<string, any> = {};
          const stamp = r.last_enriched_at || new Date().toISOString();
          for (const f of trackable) {
            const v = r[f];
            if (v && v !== '' && v !== '[]' && v !== '{}') {
              provenance[f] = {
                source_type: r.data_source || 'auto',
                source_url: sources[0] || 'unknown',
                evidence_level: 'B',
                confidence: 0.7,
                fetched_at: stamp,
                last_verified_at: stamp,
                verifier: 'backfill-phase51',
                cross_sources: [],
              };
            }
          }
          if (Object.keys(provenance).length > 0) {
            upd.run(JSON.stringify(provenance), r.agent_id);
            touched++;
          }
        }
      });
      tx(rows);
      db.prepare("INSERT INTO migrations (name) VALUES ('phase51_backfill_provenance_v1')").run();
      if (touched > 0) {
        console.log(`🧹 Migration phase51_backfill_provenance_v1: touched ${touched}/${rows.length} agent_knowledge row(s)`);
      }
    }
  } catch (err) {
    console.error("Migration phase51_backfill_provenance_v1 failed:", err);
  }

  // ─── M1 (Phase 5.4a): agent_knowledge_audit ─────────────────
  // Owner profile change history. Immutable changelog (insert-only).
  // Daniel uses GET /admin/agent-audit to inspect ownership changes.
  // FK ON DELETE CASCADE: orphan-audits cleaned up when agent removed.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_knowledge_audit (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        changed_by TEXT NOT NULL CHECK(changed_by IN ('owner', 'admin', 'system')),
        changed_by_email TEXT,
        changed_at TEXT NOT NULL DEFAULT (datetime('now')),
        notes TEXT,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_knowledge_audit_agent ON agent_knowledge_audit(agent_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_knowledge_audit_changed_at ON agent_knowledge_audit(changed_at)`);
  } catch (err) {
    console.error("Migration agent_knowledge_audit failed:", err);
  }

  // ─── Phase 5.3 (WO-16): cross-source verification columns ────────────────
  // verification_review_reason: JSON object with per-field CrossSourceResult so
  // the admin dashboard can surface WHY an agent is review_required.
  // field_provenance_v2: idempotent migration — if existing rows have a single-
  // object (legacy) shape per field, convert to 1-element array. New rows from
  // WO-16 onwards write array shape directly.
  try {
    db.exec(`ALTER TABLE agent_knowledge ADD COLUMN verification_review_reason TEXT NOT NULL DEFAULT '{}'`);
  } catch {
    // Column already exists — expected after first migration
  }

  // Backfill: convert legacy single-object field_provenance entries to arrays.
  // An agent's field_provenance is "legacy" if any of the tracked fields stores
  // a plain JSON object (not an array). The UPDATE is guarded by a SELECT so it
  // only touches rows that actually need migration, making it safe to re-run.
  try {
    const alreadyRan = db.prepare(
      "SELECT 1 FROM migrations WHERE name = 'phase53_provenance_to_array_v1'"
    ).get();
    if (!alreadyRan) {
      const rows = db.prepare(
        `SELECT agent_id, field_provenance FROM agent_knowledge WHERE field_provenance != '{}' AND field_provenance IS NOT NULL`
      ).all() as { agent_id: string; field_provenance: string }[];

      const upd = db.prepare("UPDATE agent_knowledge SET field_provenance = ? WHERE agent_id = ?");
      let migrated = 0;

      const TRACKED_FIELDS = ["address", "phone", "business_status", "email", "about",
                              "products", "opening_hours", "specialties", "certifications"];

      const tx = db.transaction((batch: { agent_id: string; field_provenance: string }[]) => {
        for (const row of batch) {
          let prov: Record<string, unknown>;
          try { prov = JSON.parse(row.field_provenance); } catch { continue; }

          let needsUpdate = false;
          for (const field of TRACKED_FIELDS) {
            const val = prov[field];
            if (val && typeof val === "object" && !Array.isArray(val)) {
              // Legacy single-record → wrap in 1-element array
              prov[field] = [val];
              needsUpdate = true;
            }
          }
          if (needsUpdate) {
            upd.run(JSON.stringify(prov), row.agent_id);
            migrated++;
          }
        }
      });
      tx(rows);

      db.prepare("INSERT INTO migrations (name) VALUES ('phase53_provenance_to_array_v1')").run();
      if (migrated > 0) {
        console.log(`Migration phase53_provenance_to_array_v1: converted ${migrated} legacy provenance row(s) to array shape`);
      }
    }
  } catch (err) {
    console.error("Migration phase53_provenance_to_array_v1 failed:", err);
  }

  // ─── PR-19 (2026-05-10): gate-split data_insufficient reclassification ──
  // Background: as of 2026-05-10, ~119 agents from the pre-WO-7-enrichment
  // back-catalogue landed in the review-queue with source_count=0 for ALL
  // critical fields, because their field_provenance is empty. They don't
  // need human review — they need more enrichment. Reclassify them into a
  // new 'data_insufficient' bucket so the review queue stays focused on
  // genuine conflicts.
  //
  // Only touches rows where:
  //   - verification_status = 'review_required'
  //   - verification_review_reason parses as JSON
  //   - EVERY tracked field (address, phone, business_status) reports
  //     source_count === 0
  //
  // Idempotent — guarded by the migrations table.
  try {
    const alreadyRan = db.prepare(
      "SELECT 1 FROM migrations WHERE name = 'pr19_data_insufficient_reclassify_v1'"
    ).get();
    if (!alreadyRan) {
      const rows = db.prepare(
        `SELECT agent_id, verification_review_reason
           FROM agent_knowledge
          WHERE verification_status = 'review_required'`
      ).all() as { agent_id: string; verification_review_reason: string }[];

      const upd = db.prepare(
        `UPDATE agent_knowledge SET verification_status = 'data_insufficient' WHERE agent_id = ?`
      );
      const TRACKED = ["address", "phone", "business_status"];
      let reclassified = 0;

      const tx = db.transaction((batch: { agent_id: string; verification_review_reason: string }[]) => {
        for (const row of batch) {
          let reason: Record<string, unknown>;
          try { reason = JSON.parse(row.verification_review_reason || "{}"); } catch { continue; }
          // All three tracked fields must be present AND have source_count===0
          let allZero = true;
          for (const f of TRACKED) {
            const r = reason[f] as { source_count?: number } | undefined;
            if (!r || typeof r.source_count !== "number" || r.source_count !== 0) {
              allZero = false;
              break;
            }
          }
          if (allZero) {
            upd.run(row.agent_id);
            reclassified++;
          }
        }
      });
      tx(rows);

      db.prepare("INSERT INTO migrations (name) VALUES ('pr19_data_insufficient_reclassify_v1')").run();
      console.log(`Migration pr19_data_insufficient_reclassify_v1: reclassified ${reclassified} review_required agent(s) → data_insufficient (scanned ${rows.length} review_required rows)`);
    }
  } catch (err) {
    console.error("Migration pr19_data_insufficient_reclassify_v1 failed:", err);
  }

  // ─── PR-23 (2026-05-11): backfill field_provenance for stranded agents ──
  // Background: as of 2026-05-11, 1271 agents are stranded outside the
  // outreach_ready_pool with verification_status ∈ {data_insufficient,
  // pending_verify, unverified} because their field_provenance has no
  // Tier-A/B sources. The verifier reads but never WRITES field_provenance,
  // and the enrichment SKILL never writes it either. Result: source_count=0
  // for every agent the back-catalogue migration (phase51) didn't already
  // touch, and even those rows wrote source_type='auto' (Tier-C).
  //
  // This migration synthesizes Tier-A/B provenance records from columns that
  // already exist on agents / agent_knowledge:
  //   - homepage              : agent.url + agent_knowledge.url_last_status 200-399
  //                             AND agent_knowledge.about >= 80 chars
  //   - google_places         : agent_knowledge.google_rating IS NOT NULL OR
  //                             agent_knowledge.google_review_count IS NOT NULL
  //   - facebook_official_page: agent_knowledge.external_links JSON contains
  //                             an entry with type='facebook'
  //   (brreg: no column exists → skipped; needs real lookup)
  //
  // For each agent we write entries into address / phone / business_status:
  //   - address          : value = agent_knowledge.address (if non-empty)
  //   - phone            : value = agent_knowledge.phone   (if non-empty)
  //   - business_status  : value = 'active' if agents.is_active=1 else 'closed'
  //
  // All sources share the same observed value because we don't have separate
  // per-source captures recorded — they all agreed at enrichment time. The
  // validator's normalizer collapses identical values into one agreement
  // group, so 2+ sources → verdict=pool_eligible.
  //
  // Only touches rows where:
  //   - field_provenance IS NULL OR field_provenance = '{}' OR no Tier-A/B
  //     record has been written yet (legacy auto-only)
  //   - verification_status NOT IN ('verified') — leave the pool untouched
  //
  // Idempotent — guarded by the migrations table.
  try {
    const alreadyRan = db.prepare(
      "SELECT 1 FROM migrations WHERE name = 'pr23_backfill_field_provenance_v1'"
    ).get();
    if (!alreadyRan) {
      // Pull every stranded agent in one SELECT.
      const rows = db.prepare(`
        SELECT a.id           AS agent_id,
               a.url          AS agent_url,
               a.is_active    AS is_active,
               k.address      AS address,
               k.phone        AS phone,
               k.website      AS website,
               k.about        AS about,
               k.google_rating AS google_rating,
               k.google_review_count AS google_review_count,
               k.external_links AS external_links,
               k.url_last_status AS url_last_status,
               k.last_enriched_at AS last_enriched_at,
               k.field_provenance AS field_provenance,
               k.verification_status AS verification_status
          FROM agents a
          JOIN agent_knowledge k ON k.agent_id = a.id
         WHERE k.verification_status != 'verified'
           AND (k.field_provenance IS NULL OR k.field_provenance = '{}' OR k.field_provenance NOT LIKE '%"homepage"%')
      `).all() as Array<{
        agent_id: string;
        agent_url: string | null;
        is_active: number | null;
        address: string | null;
        phone: string | null;
        website: string | null;
        about: string | null;
        google_rating: number | null;
        google_review_count: number | null;
        external_links: string | null;
        url_last_status: number | null;
        last_enriched_at: string | null;
        field_provenance: string | null;
        verification_status: string | null;
      }>;

      const upd = db.prepare(
        "UPDATE agent_knowledge SET field_provenance = ? WHERE agent_id = ?"
      );

      let backfilled = 0;
      let skipped = 0;
      const scanned = rows.length;

      // Chunk into transactions of 100 rows so progress is visible and a
      // single bad row doesn't roll the whole migration back.
      const CHUNK = 100;
      type Row = (typeof rows)[number];

      const runChunk = db.transaction((batch: Row[]) => {
        for (const r of batch) {
          // ── Decide which Tier-A/B sources we can attest to for this row ──
          const sources: string[] = [];

          // homepage: url is set + url_last_status is 2xx/3xx + about non-trivial
          const aboutLen = (r.about ?? "").trim().length;
          const urlOk = typeof r.url_last_status === "number"
            && r.url_last_status >= 200 && r.url_last_status < 400;
          const hasUrl = !!(r.agent_url && r.agent_url.trim()) || !!(r.website && r.website.trim());
          if (hasUrl && urlOk && aboutLen >= 80) {
            sources.push("homepage");
          }

          // google_places: any google_* signal recorded
          if (r.google_rating != null || r.google_review_count != null) {
            sources.push("google_places");
          }

          // facebook_official_page: scan external_links JSON
          if (r.external_links) {
            try {
              const links = JSON.parse(r.external_links) as Array<{ type?: string; url?: string }>;
              if (Array.isArray(links) && links.some(l => l && l.type === "facebook" && typeof l.url === "string" && l.url.length > 0)) {
                sources.push("facebook_official_page");
              }
            } catch { /* malformed JSON — skip */ }
          }

          if (sources.length === 0) {
            skipped++;
            continue;
          }

          // ── Build the field_provenance JSON ─────────────────────────────
          // Start from any existing provenance so we don't lose Tier-C / legacy
          // entries the validator already tolerates (it just won't count them).
          let existing: Record<string, unknown> = {};
          if (r.field_provenance) {
            try { existing = JSON.parse(r.field_provenance) as Record<string, unknown>; } catch { existing = {}; }
          }

          const stamp = r.last_enriched_at || new Date().toISOString();
          const addrValue = (r.address ?? "").trim();
          const phoneValue = (r.phone ?? "").trim();
          const bizValue = r.is_active === 0 ? "closed" : "active";

          // Build records for each field where we have a value.
          const buildRecords = (value: string) => sources.map(src => ({
            value,
            source_type: src,
            fetched_at: stamp,
          }));

          // Merge: take existing array (post phase53 coercion) per field and
          // append new Tier-A/B records. If existing is single-object (legacy),
          // wrap into array; if missing, start empty.
          const mergeField = (field: string, newRecords: Array<{ value: string; source_type: string; fetched_at: string }>) => {
            const cur = existing[field];
            let arr: Array<Record<string, unknown>>;
            if (Array.isArray(cur)) {
              arr = cur as Array<Record<string, unknown>>;
            } else if (cur && typeof cur === "object") {
              arr = [cur as Record<string, unknown>];
            } else {
              arr = [];
            }
            // Don't duplicate a Tier-A/B source we already have on this field
            const haveSources = new Set(arr.map(rec => (rec.source_type as string | undefined) ?? ""));
            for (const rec of newRecords) {
              if (!haveSources.has(rec.source_type)) {
                arr.push(rec);
              }
            }
            if (arr.length > 0) existing[field] = arr;
          };

          if (addrValue) mergeField("address", buildRecords(addrValue));
          if (phoneValue) mergeField("phone", buildRecords(phoneValue));
          // business_status: always synthesizable from is_active
          mergeField("business_status", buildRecords(bizValue));

          upd.run(JSON.stringify(existing), r.agent_id);
          backfilled++;

          if (backfilled > 0 && backfilled % 200 === 0) {
            console.log(`[migration:pr23] backfilled ${backfilled} agents`);
          }
        }
      });

      for (let i = 0; i < rows.length; i += CHUNK) {
        runChunk(rows.slice(i, i + CHUNK));
      }

      db.prepare("INSERT INTO migrations (name) VALUES ('pr23_backfill_field_provenance_v1')").run();
      console.log(`[migration:pr23] DONE: backfilled ${backfilled} / scanned ${scanned} / skipped ${skipped} (no usable sources)`);
    }
  } catch (err) {
    console.error("Migration pr23_backfill_field_provenance_v1 failed:", err);
  }

  // ─── PR-25 (2026-05-11): relax homepage-source backfill condition ───────
  // Hot-fix on top of PR-23. Background: PR-23 only added the homepage
  // source when url_last_status BETWEEN 200-399. The link-freshness probe
  // (PR-22) had only backfilled url_last_status for the 129 agents already
  // in the pool — leaving ~1271 stranded agents with NULL url_last_status.
  // Net effect: ~450+ agents with rich Google Places ratings ended up with
  // only google_places (source_count=1 → review_required) even though they
  // also have a homepage URL + rich about-text that the homepage scraper
  // already produced.
  //
  // PR-25 adds a homepage source for the SAME set of agents PR-23 already
  // touched, with a RELAXED condition: drop the url_last_status check. We
  // still require:
  //   - agent.url is non-empty (so a "homepage source" claim is meaningful)
  //   - about >= 80 chars (same rich-text threshold PR-23 used to justify
  //     trusting the homepage as a source)
  //
  // The migration only touches rows where PR-23 already produced a non-empty
  // field_provenance, and skips rows where 'homepage' is already recorded
  // (idempotency safeguard — also lets us re-run safely).
  //
  // Source entry shape is the SAME PR-23 used: {value, source_type, fetched_at}.
  // The validator collapses duplicate values into one agreement group, so
  // having homepage + google_places agreeing on address/phone → pool_eligible.
  //
  // Idempotent — guarded by the migrations table AND by an in-row check.
  try {
    const alreadyRan = db.prepare(
      "SELECT 1 FROM migrations WHERE name = 'pr25_backfill_homepage_source_v1'"
    ).get();
    if (!alreadyRan) {
      const rows = db.prepare(`
        SELECT a.id           AS agent_id,
               a.url          AS agent_url,
               k.address      AS address,
               k.phone        AS phone,
               k.about        AS about,
               k.last_enriched_at AS last_enriched_at,
               k.field_provenance AS field_provenance
          FROM agents a
          JOIN agent_knowledge k ON k.agent_id = a.id
         WHERE k.field_provenance IS NOT NULL
           AND k.field_provenance != '{}'
           AND k.field_provenance NOT LIKE '%"homepage"%'
           AND a.url IS NOT NULL
           AND TRIM(a.url) != ''
           AND LENGTH(COALESCE(k.about, '')) >= 80
      `).all() as Array<{
        agent_id: string;
        agent_url: string | null;
        address: string | null;
        phone: string | null;
        about: string | null;
        last_enriched_at: string | null;
        field_provenance: string | null;
      }>;

      const upd = db.prepare(
        "UPDATE agent_knowledge SET field_provenance = ? WHERE agent_id = ?"
      );

      let backfilled = 0;
      let skipped = 0;
      const scanned = rows.length;

      const CHUNK = 100;
      type Row = (typeof rows)[number];

      const runChunk = db.transaction((batch: Row[]) => {
        for (const r of batch) {
          let existing: Record<string, unknown> = {};
          if (r.field_provenance) {
            try { existing = JSON.parse(r.field_provenance) as Record<string, unknown>; } catch { existing = {}; }
          }

          const stamp = r.last_enriched_at || new Date().toISOString();
          const addrValue = ((r.address ?? "").trim() || null) as string | null;
          const phoneValue = ((r.phone ?? "").trim() || null) as string | null;
          // business_status: we don't have is_active in this SELECT (and
          // PR-23 already wrote a value); use null so the entry attests
          // presence-of-source without overriding the captured value.
          const bizValue: string | null = null;

          // Merge: dedupe by {source_type, value} so re-running is safe.
          const mergeField = (field: string, value: string | null) => {
            const cur = existing[field];
            let arr: Array<Record<string, unknown>>;
            if (Array.isArray(cur)) {
              arr = cur as Array<Record<string, unknown>>;
            } else if (cur && typeof cur === "object") {
              arr = [cur as Record<string, unknown>];
            } else {
              arr = [];
            }
            const dup = arr.some(rec =>
              (rec.source_type as string | undefined) === "homepage"
              && ((rec.value as string | null | undefined) ?? null) === value
            );
            if (!dup) {
              arr.push({ value, source_type: "homepage", fetched_at: stamp });
              existing[field] = arr;
            }
          };

          let touched = false;
          // Only merge fields PR-23 already has an entry for, to stay
          // strictly additive within the agent's existing field set.
          if ("address" in existing) { mergeField("address", addrValue); touched = true; }
          if ("phone" in existing) { mergeField("phone", phoneValue); touched = true; }
          if ("business_status" in existing) { mergeField("business_status", bizValue); touched = true; }

          if (!touched) {
            skipped++;
            continue;
          }

          upd.run(JSON.stringify(existing), r.agent_id);
          backfilled++;

          if (backfilled > 0 && backfilled % 200 === 0) {
            console.log(`[migration:pr25] backfilled ${backfilled} agents`);
          }
        }
      });

      for (let i = 0; i < rows.length; i += CHUNK) {
        runChunk(rows.slice(i, i + CHUNK));
      }

      db.prepare("INSERT INTO migrations (name) VALUES ('pr25_backfill_homepage_source_v1')").run();
      console.log(`[migration:pr25] DONE: backfilled ${backfilled} / scanned ${scanned} / skipped ${skipped} (no PR-23 field entries)`);
    }
  } catch (err) {
    console.error("Migration pr25_backfill_homepage_source_v1 failed:", err);
  }



  // ─── Phase 5.11 — Umbrella agents schema (A1, 2026-05-15) ────────────
  // Introduces the data model for umbrella-type agents (Bondens marked,
  // Mathallen Oslo, Hanen, Debio, REKO, etc.) that represent organizations
  // OVER producers rather than being producers themselves.
  //
  // Discriminator: umbrella_type IS NOT NULL identifies an umbrella agent.
  // We do NOT add a new role value because the existing agents.role CHECK
  // constraint limits it to A2A-marketplace roles (producer/consumer/...).
  // Adding role='umbrella' would require a table-recreation migration; the
  // umbrella_type discriminator pattern is simpler and forward-compatible.
  //
  // All new columns are nullable so the 1431 existing producer agents are
  // unaffected (all stay umbrella_type=NULL, parent_umbrella_id=NULL, etc).

  // 5.11.A1.1 — new columns on agents (idempotent ALTERs)
  for (const stmt of [
    `ALTER TABLE agents ADD COLUMN umbrella_type TEXT`,
    `ALTER TABLE agents ADD COLUMN parent_umbrella_id TEXT`,
    `ALTER TABLE agents ADD COLUMN umbrella_member_count INTEGER`,
    `ALTER TABLE agents ADD COLUMN umbrella_scrape_config TEXT`,
    `ALTER TABLE agents ADD COLUMN umbrella_venues TEXT`,
  ]) {
    try { db.exec(stmt); } catch { /* already exists — expected */ }
  }

  // 5.11.A1.2 — agent_affiliations table for producer ↔ umbrella links
  // PR-58 (2026-05-16): added 'inferred' to source CHECK + new evidence_json
  // column to support C.1-C auto-tag enrichment (Debio organic-cert detector
  // POSTs pending_confirmation rows with evidence snippets).
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_affiliations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      producer_id TEXT NOT NULL,
      umbrella_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_confirmation'
        CHECK(status IN ('pending_confirmation','active','historical','rejected','review_required')),
      source TEXT NOT NULL
        CHECK(source IN ('self_claimed','scraped','admin','umbrella_confirmed','inferred')),
      labels TEXT,                          -- JSON array of label keys
      notes TEXT,
      joined_at TEXT,
      confirmed_at TEXT,
      expires_at TEXT,
      field_provenance TEXT,
      evidence_json TEXT,                   -- PR-58: JSON {matched_keywords, evidence_snippets, confidence, source_url}
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(producer_id, umbrella_id),
      FOREIGN KEY (producer_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (umbrella_id) REFERENCES agents(id) ON DELETE CASCADE
    )
  `);

  // 5.11.A1.3 — Indexes for the two most-common query patterns
  db.exec(`CREATE INDEX IF NOT EXISTS idx_affiliations_producer ON agent_affiliations(producer_id, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_affiliations_umbrella ON agent_affiliations(umbrella_id, status)`);

  // ─── PR-58 (2026-05-16): additive migrations for existing DBs ────────
  // Two changes vs A1.2 baseline:
  //   1. Add evidence_json column (nullable) — easy ALTER.
  //   2. Widen source CHECK constraint to include 'inferred' — SQLite
  //      can't ALTER CHECK in place, so we rebuild the table only when
  //      the constraint is missing (idempotent on already-migrated DBs).
  try {
    const cols = db.prepare("PRAGMA table_info(agent_affiliations)").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === "evidence_json")) {
      db.exec("ALTER TABLE agent_affiliations ADD COLUMN evidence_json TEXT");
    }
  } catch (e) {
    console.warn("[init][pr-58] evidence_json migration skipped:", e instanceof Error ? e.message : String(e));
  }

  try {
    // Read the table's create-statement from sqlite_master and check
    // whether 'inferred' already appears in the source CHECK list.
    const schemaRow = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_affiliations'"
    ).get() as { sql: string } | undefined;
    const needsRebuild = schemaRow && !/'inferred'/.test(schemaRow.sql);
    if (needsRebuild) {
      // Rebuild table with widened source CHECK. Wrapped in a transaction
      // so we never leave a half-rebuilt schema if one statement fails.
      const tx = db.transaction(() => {
        db.exec(`
          CREATE TABLE agent_affiliations__pr58_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            producer_id TEXT NOT NULL,
            umbrella_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending_confirmation'
              CHECK(status IN ('pending_confirmation','active','historical','rejected')),
            source TEXT NOT NULL
              CHECK(source IN ('self_claimed','scraped','admin','umbrella_confirmed','inferred')),
            labels TEXT,
            notes TEXT,
            joined_at TEXT,
            confirmed_at TEXT,
            expires_at TEXT,
            field_provenance TEXT,
            evidence_json TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            UNIQUE(producer_id, umbrella_id),
            FOREIGN KEY (producer_id) REFERENCES agents(id) ON DELETE CASCADE,
            FOREIGN KEY (umbrella_id) REFERENCES agents(id) ON DELETE CASCADE
          )
        `);
        // Copy all existing rows. evidence_json may already exist (from the
        // ALTER above), or default to NULL.
        db.exec(`
          INSERT INTO agent_affiliations__pr58_new
            (id, producer_id, umbrella_id, status, source, labels, notes,
             joined_at, confirmed_at, expires_at, field_provenance,
             evidence_json, created_at, updated_at)
          SELECT id, producer_id, umbrella_id, status, source, labels, notes,
                 joined_at, confirmed_at, expires_at, field_provenance,
                 evidence_json, created_at, updated_at
          FROM agent_affiliations
        `);
        db.exec(`DROP TABLE agent_affiliations`);
        db.exec(`ALTER TABLE agent_affiliations__pr58_new RENAME TO agent_affiliations`);
        // Indexes were dropped with the old table — recreate them now so
        // the same boot doesn't leave them missing.
        db.exec(`CREATE INDEX IF NOT EXISTS idx_affiliations_producer ON agent_affiliations(producer_id, status)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_affiliations_umbrella ON agent_affiliations(umbrella_id, status)`);
      });
      tx();
      console.log("[init][pr-58] agent_affiliations.source CHECK widened to include 'inferred'");
    }
  } catch (e) {
    console.warn("[init][pr-58] source-CHECK widening skipped:", e instanceof Error ? e.message : String(e));
  }

  // ─── PR-64 (2026-05-16): widen status CHECK to include 'review_required' ──
  // Adds a fifth allowed status used by the Hanen matcher v2 for MEDIUM-
  // confidence matches that need human triage before the producer is
  // exposed publicly as a Hanen member. Mirrors the PR-58 rebuild
  // pattern exactly — idempotent: only runs when the current CHECK
  // doesn't already include 'review_required'.
  try {
    const schemaRow = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_affiliations'"
    ).get() as { sql: string } | undefined;
    const needsRebuild = schemaRow && !/'review_required'/.test(schemaRow.sql);
    if (needsRebuild) {
      const tx = db.transaction(() => {
        db.exec(`
          CREATE TABLE agent_affiliations__pr64_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            producer_id TEXT NOT NULL,
            umbrella_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending_confirmation'
              CHECK(status IN ('pending_confirmation','active','historical','rejected','review_required')),
            source TEXT NOT NULL
              CHECK(source IN ('self_claimed','scraped','admin','umbrella_confirmed','inferred')),
            labels TEXT,
            notes TEXT,
            joined_at TEXT,
            confirmed_at TEXT,
            expires_at TEXT,
            field_provenance TEXT,
            evidence_json TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            UNIQUE(producer_id, umbrella_id),
            FOREIGN KEY (producer_id) REFERENCES agents(id) ON DELETE CASCADE,
            FOREIGN KEY (umbrella_id) REFERENCES agents(id) ON DELETE CASCADE
          )
        `);
        db.exec(`
          INSERT INTO agent_affiliations__pr64_new
            (id, producer_id, umbrella_id, status, source, labels, notes,
             joined_at, confirmed_at, expires_at, field_provenance,
             evidence_json, created_at, updated_at)
          SELECT id, producer_id, umbrella_id, status, source, labels, notes,
                 joined_at, confirmed_at, expires_at, field_provenance,
                 evidence_json, created_at, updated_at
          FROM agent_affiliations
        `);
        db.exec(`DROP TABLE agent_affiliations`);
        db.exec(`ALTER TABLE agent_affiliations__pr64_new RENAME TO agent_affiliations`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_affiliations_producer ON agent_affiliations(producer_id, status)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_affiliations_umbrella ON agent_affiliations(umbrella_id, status)`);
      });
      tx();
      console.log("[init][pr-64] agent_affiliations.status CHECK widened to include 'review_required'");
    }
  } catch (e) {
    console.warn("[init][pr-64] status-CHECK widening skipped:", e instanceof Error ? e.message : String(e));
  }

  // 5.11.A1.4 — Optional partial index on umbrella agents (umbrella_type IS NOT NULL)
  // Speeds up "list all umbrellas" queries. Partial-index pattern matches PR-23's
  // is_active filter so it stays cheap.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_umbrella_type ON agents(umbrella_type) WHERE umbrella_type IS NOT NULL`);

  // ─── Phase 5.11 PR-56 (2026-05-16): Bondens marked events scraper ────
  // Stores upcoming markedsdager scraped daily from bondensmarked.no/markeder.
  // Each row links to a venue agent (umbrella_type='venue') OR — when no
  // venue matches by name — falls back to the lokallag whose city contains
  // the event's location_text. event_slug is the canonical
  // <venue-slug>-<YYYY-MM-DD> string from the source URL and is unique so
  // re-runs are idempotent (INSERT OR REPLACE).
  db.exec(`
    CREATE TABLE IF NOT EXISTS bm_market_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venue_agent_id TEXT NOT NULL,
      event_slug TEXT UNIQUE NOT NULL,
      event_name TEXT NOT NULL,
      location_text TEXT,
      start_at TEXT NOT NULL,
      end_at TEXT,
      source_url TEXT NOT NULL,
      scraped_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (venue_agent_id) REFERENCES agents(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bm_events_venue ON bm_market_events(venue_agent_id, start_at)`);
  // Regular index on start_at — supports "upcoming events" range queries
  // (datetime('now')-relative). A partial index with WHERE clause was
  // considered but rejected: SQLite evaluates datetime('now') at index-build
  // time only, which would fix the cutoff at deploy time and need a manual
  // REINDEX as the cutoff drifts forward. A regular index is simpler and
  // SQLite's planner handles the range scan cheaply at this table size.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bm_events_start ON bm_market_events(start_at)`);

  // ─── PR-94 (2026-06-01): Phase B.2 — bm_venue agents ────────────────
  // Root-cause analysis 2026-06-01 found ~73% of unmatched BM events are
  // festivals / town-squares / landmarks (not producers and not lokallag).
  // The matcher\'s PR-56 premise — "every BM event matches an existing
  // agent" — was wrong; these venues need their own agent rows.
  //
  // Design: extend the existing agents table (not a new table) with two
  // nullable columns:
  //   - agent_review_status TEXT  — only populated for umbrella_type=\'bm_venue\';
  //                                  values \'pending_review\', \'confirmed\', \'rejected\'.
  //                                  All existing rows stay NULL (no behavioural change).
  //   - bm_venue_meta TEXT (JSON)  — first-seen event name + locations list +
  //                                  first_seen_at; lets Daniel decide whether
  //                                  to confirm the venue without re-scraping.
  //
  // umbrella_type=\'bm_venue\' is a new discriminator value (not added to a
  // CHECK constraint — umbrella_type is a plain TEXT column). Marketplace
  // search already filters umbrella_type IS NULL so public producer search
  // is untouched. Profile/umbrella/bm-events endpoints filter out
  // pending_review+rejected rows.
  for (const stmt of [
    `ALTER TABLE agents ADD COLUMN agent_review_status TEXT`,
    `ALTER TABLE agents ADD COLUMN bm_venue_meta TEXT`,
  ]) {
    try { db.exec(stmt); } catch { /* already exists — expected on re-init */ }
  }
  // Partial index on the review-queue column so the admin "list pending"
  // endpoint is cheap even when the agents table is large.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_review_status ON agents(agent_review_status) WHERE agent_review_status IS NOT NULL`);

  // ─── Phase 5.11 C.2 (2026-05-16): Hanen member-scraping unmatched log ──
  // hanen.no/medlemmer scraper (src/services/hanen-scraper.ts) writes one
  // row per parsed Hanen member that did NOT match any existing agent
  // above the 0.85 Dice threshold. The table is intentionally append-and-
  // refresh (UNIQUE on parsed_name): re-running the scraper updates the
  // last_seen_at + best_match_score so we can audit drift over time, but
  // never creates duplicate rows. Phase B.2-equivalent (auto-create new
  // producer agents for unmatched Hanen members) will read from here
  // later — that work is deferred.
  //
  // Why a separate table (not just errors[]): the bm-events errors[] is
  // ephemeral (returned in the scrape response, then lost). Hanen has
  // potentially ~50-200 unmatched members across a year of re-scrapes;
  // they're worth durable storage so we can build a triage UI for Daniel.
  db.exec(`
    CREATE TABLE IF NOT EXISTS hanen_unmatched_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parsed_name TEXT UNIQUE NOT NULL,
      parsed_location TEXT,
      parsed_website TEXT,
      parsed_category TEXT,
      source_url TEXT NOT NULL,
      best_match_score REAL,
      first_seen_at TEXT DEFAULT (datetime('now')),
      last_seen_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_hanen_unmatched_last_seen ON hanen_unmatched_members(last_seen_at)`);

  // ─── PR-68 (2026-05-17): hanen_unmatched_members.imported_agent_id ──
  // Phase B.2 batch-import endpoint promotes unmatched Hanen rows into
  // new producer agents. We track the resulting agent id ON the
  // unmatched row so subsequent /admin/hanen/batch-import-unmatched
  // calls skip already-imported rows (re-run safety). Mirrors the
  // PR-58 additive-migration pattern (ALTER TABLE inside a try/catch).
  try {
    const cols = db.prepare("PRAGMA table_info(hanen_unmatched_members)").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === "imported_agent_id")) {
      db.exec(`ALTER TABLE hanen_unmatched_members ADD COLUMN imported_agent_id TEXT`);
    }
  } catch (e) {
    console.warn("[init][pr-68] hanen_unmatched_members.imported_agent_id migration skipped:", e instanceof Error ? e.message : String(e));
  }
  // ─── Phase 5.11 C.1-A (2026-05-16): Debio TRACES cross-check ────────
  // Unmatched Debio organic-operators surfaced by /admin/debio/cross-check.
  // We do NOT auto-create producer agents for these — the operator may be
  // a legal entity that legitimately isn't on our marketplace yet. The row
  // gives the orchestrator visibility (`first_seen_at`, `last_seen_at`,
  // `best_match_score`) so a future manual-review or relaxed-fuzzy pass can
  // attempt the link. operator_name is UNIQUE so the cross-check is
  // idempotent on re-runs (ON CONFLICT updates `last_seen_at`).
  db.exec(`
    CREATE TABLE IF NOT EXISTS debio_unmatched_operators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operator_name TEXT UNIQUE NOT NULL,
      postal_code TEXT,
      operator_identifier TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      best_match_score REAL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_debio_unmatched_last_seen ON debio_unmatched_operators(last_seen_at)`);

  // ─── PR-95 (2026-06-01): Debio organic-cert verification flags ──────
  // Daniel directive: only show "Debio" label when actually verified via
  // finnoko.debio.no. These columns are populated by
  // syncDebioVerifications() (src/services/debio-verification-service.ts)
  // which runs daily at 04:00 UTC. They are NOT set by seed-data or
  // text-inference; that source-of-truth was removed in PR-95 from
  // src/_seeds/seed-knowledge.ts.
  //   debio_verified         : 1 iff matched against the public
  //                            finnoko.debio.no/api/acm/companies feed.
  //   debio_verified_at      : ISO-8601 timestamp of last successful match.
  //   debio_finnoko_id       : partner_sid from the finnoko record (stable
  //                            numeric id, stored as text for column-type
  //                            compatibility with other id columns).
  // Additive — idempotent ALTERs, same defensive try/catch pattern as the
  // PR-58/PR-68 migrations above.
  for (const stmt of [
    `ALTER TABLE agents ADD COLUMN debio_verified INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE agents ADD COLUMN debio_verified_at TEXT`,
    `ALTER TABLE agents ADD COLUMN debio_finnoko_id TEXT`,
  ]) {
    try { db.exec(stmt); } catch { /* already exists — expected */ }
  }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_debio_verified ON agents(debio_verified) WHERE debio_verified = 1`);
  } catch { /* partial index unsupported or already created */ }


  // ─── Phase 0 (orch-pr-20260614-5): products catalog table ────────────────
  // Queryable product catalog seeded from agent_knowledge.products via
  // POST /admin/products/backfill. Availability field defaults to 'in_stock'
  // for backfill rows; Phase 1 will add cart + delivery windows.
  //
  // UNIQUE(agent_id, name_norm) ensures idempotent upserts: re-running
  // backfill updates price/category but never creates duplicate rows.
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id           TEXT PRIMARY KEY,
      agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      name_norm    TEXT NOT NULL,
      description  TEXT,
      unit         TEXT,
      price_nok    REAL,
      currency     TEXT NOT NULL DEFAULT 'NOK',
      availability TEXT NOT NULL DEFAULT 'in_stock',
      stock_qty    INTEGER,
      category     TEXT,
      image_url    TEXT,
      source       TEXT NOT NULL DEFAULT 'enrichment',
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_products_agent_id ON products(agent_id)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_products_agent_name_norm ON products(agent_id, name_norm)`);

  // ─── Phase 1 (orch-pr-20260614-6): cart + orders tables ─────────────────
  // Cart MVP ("handleliste"). No payment, no seller notification (Phase 1).
  // Anonymous buyer: capability-token model (buyer_ref). Pickup only.
  // These tables supersede the in-memory reservation routes going forward;
  // the old /api/reservations routes are kept for backward compat during
  // the transition period.

  db.exec(`
    CREATE TABLE IF NOT EXISTS carts (
      id          TEXT PRIMARY KEY,
      buyer_ref   TEXT NOT NULL,
      buyer_kind  TEXT NOT NULL DEFAULT 'platform_agent',
      status      TEXT NOT NULL DEFAULT 'open'
                    CHECK(status IN ('open','submitted','cancelled','expired')),
      currency    TEXT NOT NULL DEFAULT 'NOK',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at  TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_carts_buyer_ref ON carts(buyer_ref)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cart_items (
      id                   TEXT PRIMARY KEY,
      cart_id              TEXT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
      product_id           TEXT NOT NULL,
      agent_id             TEXT NOT NULL,
      qty                  INTEGER NOT NULL CHECK(qty > 0),
      unit_price_snapshot  REAL,
      line_note            TEXT,
      added_at             TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(cart_id, product_id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cart_items_cart_id ON cart_items(cart_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id             TEXT PRIMARY KEY,
      cart_id        TEXT,
      agent_id       TEXT NOT NULL,
      buyer_ref      TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'pending'
                       CHECK(status IN ('pending','confirmed','declined','ready','completed','cancelled')),
      fulfilment     TEXT NOT NULL DEFAULT 'pickup',
      pickup_time    TEXT,
      total_nok      REAL,
      confirm_token  TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_cart_id   ON orders(cart_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_agent_id  ON orders(agent_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS order_items (
      id                   TEXT PRIMARY KEY,
      order_id             TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id           TEXT,
      name_snapshot        TEXT,
      qty                  INTEGER,
      unit_price_snapshot  REAL,
      line_total           REAL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id)`);

  // ─── Slice 1 of dev-request 2026-06-30-brreg-verification-gate ─────────
  // Schema + lookup-function ONLY. This slice does NOT wire org-nr
  // verification into any registration/enrichment endpoint — that's
  // deferred to a later slice. Purely additive: unused new nullable/
  // defaulted columns, populated by nobody yet.
  //
  //   org_nr             : the agent's 9-digit Norwegian org number, as its
  //                        own column (today it only lives encoded as an
  //                        `org_nr:<value>` tag string inside `tags`).
  //   brreg_verified      : 1 iff a future caller has confirmed this org_nr
  //                        against Brreg via verifyOrgNumber() (services/
  //                        brreg-client.ts). Defaults to 0 — unverified.
  //   brreg_flag          : last BrregFlag ("dissolved" | "bankrupt" |
  //                        "wrong_nace" | "name_mismatch" | "no_orgnr" | null).
  //   brreg_checked_at    : ISO-8601 timestamp of the last verifyOrgNumber()
  //                        check, if any.
  // Additive — idempotent ALTERs, same defensive try/catch pattern as the
  // PR-58/PR-68/PR-95 (debio_verified) migrations above.
  for (const stmt of [
    `ALTER TABLE agents ADD COLUMN org_nr TEXT`,
    `ALTER TABLE agents ADD COLUMN brreg_verified INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE agents ADD COLUMN brreg_flag TEXT`,
    `ALTER TABLE agents ADD COLUMN brreg_checked_at TEXT`,
  ]) {
    try { db.exec(stmt); } catch { /* already exists — expected */ }
  }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_org_nr ON agents(org_nr) WHERE org_nr IS NOT NULL`);
  } catch { /* partial index unsupported or already created */ }

  // ─── Backfill: agents.org_nr from the legacy `org_nr:<value>` tag ───────
  // Existing agent registration (routes/admin-agents.ts) has only ever
  // stored org-nr encoded as a tag string inside the JSON `tags` column.
  // This backfill copies that value into the new first-class org_nr column
  // so a later slice's verification pass has something to read without
  // re-parsing tags. Idempotent — guarded by the migrations table, runs
  // once per DB file. Needs JS/JSON parsing (tags is a JSON array of
  // strings), so this is done in JS rather than raw SQL.
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
    const alreadyRan = db.prepare(
      "SELECT 1 FROM migrations WHERE name = 'backfill_agents_org_nr_from_tags_v1'"
    ).get();
    if (!alreadyRan) {
      const rows = db.prepare("SELECT id, tags FROM agents").all() as { id: string; tags: string | null }[];
      const orgNrTagRe = /^org_nr:(\d+)$/;
      let backfilled = 0;
      const update = db.prepare("UPDATE agents SET org_nr = ? WHERE id = ?");
      for (const row of rows) {
        if (!row.tags) continue;
        let tags: unknown;
        try { tags = JSON.parse(row.tags); } catch { continue; }
        if (!Array.isArray(tags)) continue;
        for (const t of tags) {
          if (typeof t !== "string") continue;
          const m = orgNrTagRe.exec(t);
          if (m) {
            update.run(m[1], row.id);
            backfilled++;
            break;
          }
        }
      }
      db.prepare("INSERT INTO migrations (name) VALUES ('backfill_agents_org_nr_from_tags_v1')").run();
      console.log(`\u{1F9F9} Migration backfill_agents_org_nr_from_tags_v1: backfilled org_nr for ${backfilled} agent(s) from tags`);
    }
  } catch (err) {
    console.error("Migration backfill_agents_org_nr_from_tags_v1 failed:", err);
  }

  // ─── Slice 1 of dev-request 2026-07-03-agent-profile-conversations-stats ──
  // contact_clicks: intent-tracking for mailto:/tel: clicks (POST beacon)
  // and website/social-link clicks (GET /ut/:agentId/:kind counting
  // redirect). Purely additive — brand-new table, nothing existing reads or
  // writes it yet (frontend wiring + owner-dashboard UI are later slices).
  // Same idiom as the other new-table blocks above (products/carts/orders):
  // a plain `CREATE TABLE IF NOT EXISTS` is itself the safe migration for a
  // never-existed-before table, so no `migrations`-table guard is needed —
  // that guard is only for statements that mutate ALREADY-DEPLOYED rows
  // (ALTERs, backfills), which this isn't.
  //
  //   agent_id   : which agent's profile the click happened on. No FK/
  //                REFERENCES — same convention as analytics_agent_views —
  //                so click history survives an agent later being deleted
  //                or blocklisted.
  //   kind       : 'email' | 'phone' | 'website' | 'external:<type>' where
  //                <type> mirrors agent_knowledge.external_links[].type
  //                (e.g. 'external:facebook'). Never a URL — see
  //                routes/contact-tracking.ts for why that matters (the
  //                open-redirect guard on GET /ut/:agentId/:kind).
  //   session_id : "<ipHash>:<userAgent>", identical shape to
  //                analytics_page_views.session_id (reuses
  //                analyticsService.getOrCreateSessionId — same privacy
  //                posture: hashed IP via crypto.sha256, never a raw IP).
  //   is_bot     : 1 iff parseUserAgent(ua).isBot from analytics-service.ts
  //                (exported for reuse so this doesn't drift from the bot
  //                heuristic used everywhere else in the codebase).
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_clicks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id   TEXT NOT NULL,
      kind       TEXT NOT NULL,
      session_id TEXT,
      is_bot     INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_contact_clicks_agent_id ON contact_clicks(agent_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_contact_clicks_created_at ON contact_clicks(created_at)`);

  // ─── Measure 2 of dev-request 2026-07-03-places-api-cost-reduction ──────
  // (SKU field-splitting, RFB google-rating-batch): Places API (New) Text
  // Search bills the whole call at Enterprise-tier pricing (1k free calls/mo)
  // the moment ANY Enterprise-tier field (rating, userRatingCount, websiteUri,
  // internationalPhoneNumber) is in the FieldMask — even if most of the mask
  // is Essentials/Pro tier. `google_rating`/`google_review_count` already
  // exist and cover the common case (agent has been rated before), but an
  // agent that was searched and got a genuine "no match"/"no rating" result
  // has no rating column to key off — without a separate marker it would be
  // re-sent with the full Enterprise mask on every single recurring run
  // forever. `google_enterprise_fetched_at` records "we already spent one
  // Enterprise-tier Places Text Search call on this agent" independent of
  // whether that call found a rating, so routes/marketplace.ts can drop
  // straight to an Essentials/Pro-only mask for repeat runs either way.
  // Additive, nullable, idempotent — same defensive try/catch ALTER idiom as
  // the org_nr/debio_verified/brreg_* migrations above.
  try {
    db.exec(`ALTER TABLE agent_knowledge ADD COLUMN google_enterprise_fetched_at TEXT`);
  } catch { /* already exists — expected on subsequent boots */ }

  // ─── dev-request 2026-07-03-places-api-cost-reduction, measure 2 (cont.) ─
  // Call-usage log for the Google Places API, so the daily brief can flag
  // when the Enterprise-SKU free-tier cap (1,000 calls/month) is at risk.
  // Complements the per-run counters above (data.enterprise_calls etc. on
  // the response) with a durable cross-run log for monthly aggregation.
  // Written by services/places-usage-tracker.ts. Observability only — a
  // logging failure there is caught and never blocks/alters enrichment.
  db.exec(`
    CREATE TABLE IF NOT EXISTS places_api_call_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      vertical   TEXT NOT NULL,
      endpoint   TEXT NOT NULL,
      sku        TEXT NOT NULL,
      called_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_places_api_call_log_called_at ON places_api_call_log(called_at)`);

}

export function closeDb(): void {
  if (db) {
    db.close();
  }
}
