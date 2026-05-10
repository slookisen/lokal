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
    -- INDEXES: Geo bounding-box + common lookups
    -- These make discovery fast without PostGIS
    -- ════════════════════════════════════════════════════════════
    CREATE INDEX IF NOT EXISTS idx_agents_geo ON agents(lat, lng) WHERE is_active = 1;
    CREATE INDEX IF NOT EXISTS idx_agents_role ON agents(role) WHERE is_active = 1;
    CREATE INDEX IF NOT EXISTS idx_agents_api_key ON agents(api_key);
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
        k.last_verified_at
      FROM agents a
      INNER JOIN agent_knowledge k ON k.agent_id = a.id
      WHERE
        k.email IS NOT NULL
        AND k.email != ''
        AND k.verification_status = 'verified'
        AND k.enrichment_status IN ('partial', 'rich')
        AND 1=1  /* TODO Phase 5.10: AND a.removed_at IS NULL */
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

}

export function closeDb(): void {
  if (db) {
    db.close();
  }
}
