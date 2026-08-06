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
// Test-only companion to __setDbForTesting: returns whatever handle the
// singleton currently holds (null if none has been opened/injected yet), so a
// suite that swaps in its own in-memory DB can put the previous one back when
// it finishes. Without this a swapping suite leaves the singleton pointing at
// its own throwaway DB for every block that runs after it.
// Never call from production code.
export function __peekDbForTesting(): Database.Database | null {
  return db;
}

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
    -- ANALYTICS: MCP/A2A/agent-card usage (dev-request 2026-07-21-analytics-
    -- tre-boetter-mcp-logging-a2a-transparens, Slice B) — "hvilke verktøy gir
    -- mest, og hvem bruker oss mest". One row per JSON-RPC request on
    -- POST /mcp or POST /a2a, and one row per GET /.well-known/agent-card.json
    -- fetch. Observational only — never blocks/fails the logged call.
    -- ════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS analytics_mcp_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      protocol TEXT NOT NULL,                      -- 'mcp', 'a2a', 'agent_card'
      vertical_id TEXT NOT NULL DEFAULT 'rfb',      -- 'rfb', 'dental', 'experiences'
      tool_name TEXT,                               -- JSON-RPC method, or params.name for tools/call
      client_name TEXT,                             -- MCP initialize.clientInfo.name, else UA-derived
      client_version TEXT,                          -- MCP initialize.clientInfo.version, when available
      user_agent TEXT,                               -- raw UA (not hashed — needed for "hvem bruker oss")
      ip_hash TEXT,                                  -- privacy-safe hashed IP
      duration_ms INTEGER,                           -- request latency
      is_owner INTEGER DEFAULT 0,                    -- our own scheduled agents, excluded from client stats
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
    -- ORCHESTRATOR_LOCKS: session-level run-lock (orch-pr-20260724-wake-mutex)
    -- One row per agent name (e.g. 'platform-orchestrator') = current holder,
    -- if any. Server-side mutex closing the double-fire race: two independent
    -- Claude Code sessions have no other shared state to coordinate on, and
    -- the existing dev-request lease + fire-marker dedup don't catch a race
    -- where both sessions pass their initial checks before either commits
    -- anything to the dev-request queue. Deliberately a SEPARATE table from
    -- the "runs" table above — this is a transient session lock, not part
    -- of the permanent audit ledger, so the runs table/queries need zero
    -- changes.
    -- See src/services/run-ledger.ts (acquireLock/releaseLock) for the
    -- atomic INSERT...ON CONFLICT...DO UPDATE...WHERE pattern that uses it.
    -- ════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS orchestrator_locks (
      agent TEXT PRIMARY KEY,                      -- e.g. 'platform-orchestrator'
      run_id TEXT NOT NULL,                        -- current holder's run_id
      started_at TEXT NOT NULL,                    -- caller-supplied metadata only (unvalidated) -- NOT the staleness clock, see acquireLock()
      locked_at TEXT NOT NULL DEFAULT (datetime('now')) -- server-stamped when this row was (re)written; the ONLY staleness clock
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
    CREATE INDEX IF NOT EXISTS idx_analytics_mcp_calls_created ON analytics_mcp_calls(created_at);
    CREATE INDEX IF NOT EXISTS idx_analytics_mcp_calls_tool_name ON analytics_mcp_calls(tool_name);
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
    -- NOTE: there is deliberately NO unique index on crm_contacts(email) here.
    -- Uniqueness is UNIQUE(email, vertical_id) and is created further down this
    -- file, right after the ALTER TABLE loop that adds vertical_id (the column
    -- does not exist yet at this point, which is why it cannot be created here).
    --
    -- REVIEW B1 — do NOT re-add a UNIQUE(email) index here as a "safe interim".
    -- An earlier draft of this change did exactly that and it was a CRASH LOOP,
    -- reproduced: initSchema() runs on EVERY boot, so the DROP further down fired
    -- every boot too, which meant this line stopped being a no-op from boot 2
    -- onwards and genuinely rebuilt the index — against data that by then legally
    -- contained two contacts sharing an email. SQLite validates on CREATE, so it
    -- threw, out of initSchema(), out of getDb(), and index.ts calls getDb() at
    -- module top level — the process never reaches app.listen(). The branch
    -- reverted itself once per boot.
    --
    -- The gap this leaves is one synchronous initSchema() pass on a fresh DB,
    -- before any connection can write. Nothing can insert a duplicate in it.

    -- ─── crm_untriaged — the bucket for mail we CANNOT route ──────────
    --
    -- dev-request 2026-07-27-crm-plattformadskillelse, steg 4:
    --   «Ukjent/tvetydig signal → egen «utriaged»-bøtte for Daniel, ALDRI en gjetning.»
    --
    -- Deliberately NOT a vertical. vertical_id is NOT NULL with a closed union
    -- everywhere else, and adding an 'unknown' member would have been the easy
    -- move — but then every read that filters by platform has to decide what to
    -- do with it, and a BUG that writes 'unknown' becomes indistinguishable from
    -- a genuine untriaged item. Keeping it out of the union means the type system
    -- still guarantees every row in the CRM proper belongs to a real platform.
    --
    -- Why a table at all: without one, an unroutable thread cannot enter the CRM
    -- (POST /ingest rejects a missing vertical, correctly), so the agent's only
    -- option is to drop it. That is the silent failure this dev-request exists to
    -- stop — the mail disappears and nothing anywhere says so. This makes the
    -- undecidable case VISIBLE and countable instead.
    --
    -- Rows leave only by an explicit human assignment, which promotes them into
    -- the real CRM through the normal ingest path. Nothing here is ever guessed
    -- into a platform.
    CREATE TABLE IF NOT EXISTS crm_untriaged (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL UNIQUE,      -- Gmail threadId, so re-parking is idempotent
      from_email TEXT NOT NULL,
      subject TEXT,
      snippet TEXT,
      -- WHY we could not route it, in the agent's own words. Free text on purpose:
      -- the useful content is the signal it actually saw, and a closed enum here
      -- would push the agent to pick the nearest wrong label.
      reason TEXT NOT NULL,
      -- The raw routing evidence (delivered-to, wrapper From, Received chain…).
      -- Kept so a human can re-decide without going back to Gmail.
      signals TEXT NOT NULL DEFAULT '{}',
      raw_payload TEXT NOT NULL DEFAULT '{}',   -- the full ingest body, replayed on assign
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT,
      resolved_vertical TEXT,                    -- set on assignment; NULL while open
      resolved_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_crm_untriaged_open ON crm_untriaged(resolved_at, created_at);

    -- ─── crm_retro_tagging_audit — steg 5's reversibility ─────────────
    --
    -- dev-request 2026-07-27-crm-plattformadskillelse, steg 5:
    --   «Audit + reverserbart per rad/batch. ALDRI en blind UPDATE på historikk.»
    --
    -- One row per thread MOVED, written BEFORE the update inside the same
    -- transaction. from_contact_id is the load-bearing column: steg 2 made
    -- contacts unique per (email, vertical_id), so a revert that restored only
    -- vertical_id would leave the thread pointing at the other platform's
    -- contact — half-reverted, which is worse than not reverted because it
    -- looks done.
    --
    -- message_ids is captured rather than re-derived at revert time: a message
    -- ingested after the batch must NOT be dragged back by an undo, and
    -- re-querying by thread_id at revert time would do exactly that.
    CREATE TABLE IF NOT EXISTS crm_retro_tagging_audit (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      from_vertical TEXT NOT NULL,
      to_vertical TEXT NOT NULL,
      from_contact_id TEXT NOT NULL,
      to_contact_id TEXT NOT NULL,
      tier TEXT NOT NULL,
      evidence TEXT NOT NULL,
      message_ids TEXT NOT NULL DEFAULT '[]',
      applied_by TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now')),
      reverted_at TEXT,
      UNIQUE(batch_id, thread_id)
    );
    CREATE INDEX IF NOT EXISTS idx_crm_retro_batch ON crm_retro_tagging_audit(batch_id);
    CREATE INDEX IF NOT EXISTS idx_crm_retro_thread ON crm_retro_tagging_audit(thread_id);

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

  // ─── Add is_internal column to conversations ─────────────────
  // (rfb-samtaler dev-request 2026-07-04, item 3) Flags a conversation as OUR
  // OWN internal traffic — verifier probes, loop-dispatcher/fleet runs, health
  // checks, owner/admin/CI requests — so the public /samtaler counters can
  // report EXTERNAL traffic only. The write-time classifier lives in
  // conversation-service.ts (isInternalTraffic).
  //
  // Safety (data-model touch, deliberately conservative):
  //   • ADDITIVE only, NOT NULL DEFAULT 0 → every existing row reads as
  //     external (0) until an explicit backfill flips a clearly-internal one.
  //     No column is dropped or renamed, no row is rewritten by this migration.
  //   • Idempotent — guarded on "duplicate column name" so re-runs are no-ops.
  //   • Single-revert rollback — reverting the code makes getSourceStats() count
  //     every row again (totals reappear); this column can stay harmlessly, or
  //     be reset via conversationService.resetInternalFlags().
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN is_internal INTEGER NOT NULL DEFAULT 0`);
  } catch (e: any) {
    if (!String(e?.message || '').includes('duplicate column name')) throw e;
    // Column already exists — idempotent, safe to ignore
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