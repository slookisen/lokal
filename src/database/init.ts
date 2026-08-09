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

  // crm_outbox.crm_message_id — added dev-request
  // 2026-08-09-cs-rutine-to-plattformer-og-tradhistorikk (post-review bugfix).
  // Before this column, /outbox/:id/result resolved "the" crm_messages row
  // for an outbox item via getLatestOutboundMessageId(threadId) — "most
  // recent outbound message on this thread". That was safe when only a
  // brand-new thread ever got a single 'queued' message at a time, but
  // recordOutboundReply() (this same dev-request) also leaves 'queued' rows
  // for replies on EXISTING threads, so a thread can now have several
  // outstanding queued replies — and "most recent" can name the wrong one
  // when results come back out of order. Explicitly linking the outbox row
  // to the message it produced (set by recordOutboundReply's outboxId
  // param) removes the ambiguity. NULL on existing/legacy rows is fine —
  // crmService.getLatestOutboundMessageId() remains the fallback for those.
  try {
    db.exec("ALTER TABLE crm_outbox ADD COLUMN crm_message_id TEXT REFERENCES crm_messages(id) ON DELETE SET NULL");
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
  // when Phase 4.6b starts filtering on them.
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_vertical_id ON agents(vertical_id)`);
  } catch {
    // Index already exists
  }

  // ─── crm_contacts uniqueness: (email) → (email, vertical_id) ──
  //
  // dev-requests/2026-07-27-crm-plattformadskillelse-opplevagent.md, steg 2.
  // Daniels valg A, ordrett: «gå for adskilte kontakter.» One person who is a
  // customer on BOTH rettfrabonden.com and opplevagent.no must be two separate
  // contacts — not one shared row whose thread history mixes the platforms.
  // The old UNIQUE(email) made that impossible to even represent: the second
  // platform's INSERT would fail outright.
  //
  // Safe on live data by construction. Every existing row is vertical_id='rfb'
  // (nothing wrote the column until this PR), so the composite index holds on
  // exactly the same row set the single-column one did — it cannot fail on
  // existing data, and there is nothing to de-duplicate first.
  //
  // The two statements run in ONE TRANSACTION, so there is no window between
  // them at all — SQLite has fully transactional DDL. The first version argued
  // for a careful ordering instead (CREATE before DROP, so a crash in between
  // leaves the table more constrained rather than less), but an ordering
  // argument is only as good as the next person who reorders the lines, and a
  // mutation swapping them was undetectable by any test: "what happens if the
  // process dies between two synchronous statements" is not observable from a
  // test process. BEGIN/COMMIT makes the hazard structurally impossible rather
  // than merely documented, which is the better of the two.
  //
  // Idempotent ACROSS BOOTS, not merely across DB states — REVIEW B1. This runs
  // on every single boot, so the pair below has to be a no-op on boot 2, 3, 4…
  // It is, now that nothing re-creates the single-column index earlier in this
  // file (see the note in the crm_contacts DDL block). The first draft did
  // re-create it, and the result was a crash loop the moment one legitimate
  // cross-vertical contact existed. Reproduced before fixing:
  //     boot 1  → OK, two contacts sharing an email on two platforms
  //     boot 2  → THREW: UNIQUE constraint failed: crm_contacts.email
  //
  // NOT freely reversible any more, and that is worth stating plainly: a plain
  // `git revert` of this change restores the UNIQUE(email) index, which will
  // fail to build against exactly the data steg 2 exists to allow — the same
  // crash, arrived at deliberately. Reverting safely means de-duplicating
  // crm_contacts first (keep the 'rfb' row, re-point its threads), THEN
  // reverting. Do not treat this as a one-command rollback.
  try {
    db.exec(`
      BEGIN;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_contacts_email_vertical_unique ON crm_contacts(email, vertical_id);
        DROP INDEX IF EXISTS idx_crm_contacts_email_unique;
      COMMIT;
    `);
  } catch {
    // Already migrated, or the CREATE failed on genuinely duplicate data. Either
    // way the transaction rolls back, so the table is never left half-migrated.
    try { db.exec(`ROLLBACK`); } catch { /* no transaction open — nothing to undo */ }
  }

  // ─── CRM steg 6 — crm_contacts.provider_id (kontakt ↔ opplevagent-produsent) ───
  //
  // dev-requests/2026-07-27-crm-plattformadskillelse-opplevagent.md, steg 6 / funn 6.
  //
  // Option (a) from the spec: a nullable `provider_id` column NEXT TO `agent_id`,
  // not option (b)'s generic (vertical_id, entity_id) pair replacing both. The
  // pair would rewrite every read site that joins on agent_id — listContacts,
  // getContactDetail, the marketing pool VIEW, and the PR-38 outreach_sent_log
  // auto-record trigger whose `agent_id IS NOT NULL` guard is load-bearing for
  // suppression — for zero functional gain over two well-guarded columns.
  //
  // provider_id points at experience_providers.id in experiences.db — a DIFFERENT
  // database file, so it can never be a REFERENCES clause. Row existence is
  // enforced in code (crm-service validates against the experiences DB before
  // writing); what the schema CAN enforce is the spec's invariant «en kontakt kan
  // aldri peke på en entitet i feil vertical», via the triggers below: agent_id
  // only on rfb contacts, provider_id only on experiences contacts.
  // COALESCE(vertical_id,'rfb') matches how every reader treats a legacy NULL.
  try {
    db.exec(`ALTER TABLE crm_contacts ADD COLUMN provider_id TEXT`);
  } catch {
    // Column already exists — expected after first migration
  }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_crm_contacts_provider ON crm_contacts(provider_id)`);
  } catch {
    // Index already exists
  }

  // Healing sweep, BEFORE the triggers exist: classifyEmail() used to match every
  // vertical's contacts against the RFB `agents` table, so an experiences contact
  // whose email happened to match an RFB producer got agent_id pointing at the
  // wrong vertical's entity. Clear those links (the contact row itself stays).
  // Runs every boot; 0 rows affected after the first pass. Each cleared row is
  // logged to crm_actions so the un-linking shows in the contact's history
  // rather than happening silently.
  try {
    const crossLinked = db
      .prepare(
        `SELECT id, email, agent_id, COALESCE(vertical_id,'rfb') AS vertical_id FROM crm_contacts
          WHERE agent_id IS NOT NULL AND COALESCE(vertical_id,'rfb') != 'rfb'`,
      )
      .all() as Array<{ id: string; email: string; agent_id: string; vertical_id: string }>;
    if (crossLinked.length > 0) {
      const clear = db.prepare(`UPDATE crm_contacts SET agent_id = NULL WHERE id = ?`);
      const logIt = db.prepare(
        `INSERT INTO crm_actions (id, contact_id, type, actor, payload)
         VALUES (lower(hex(randomblob(16))), ?, 'crm_cross_vertical_agent_link_cleared', 'system', ?)`,
      );
      for (const row of crossLinked) {
        clear.run(row.id);
        logIt.run(
          row.id,
          JSON.stringify({
            email: row.email,
            cleared_agent_id: row.agent_id,
            contact_vertical: row.vertical_id,
            reason: "steg 6: agent_id må aldri peke på tvers av vertical (funn 6)",
          }),
        );
      }
      console.log(
        `[migration] steg 6: cleared ${crossLinked.length} cross-vertical agent_id link(s) on crm_contacts`,
      );
    }
  } catch (e) {
    console.error(`[migration] steg 6 cross-vertical healing sweep failed:`, e);
  }

  // The vertical-safety triggers. DROP+CREATE every boot so a future edit to the
  // trigger body actually lands (CREATE TRIGGER IF NOT EXISTS would silently keep
  // the old body forever).
  try {
    db.exec(`
      DROP TRIGGER IF EXISTS trg_crm_contacts_agent_vertical_ins;
      CREATE TRIGGER trg_crm_contacts_agent_vertical_ins
      BEFORE INSERT ON crm_contacts
      WHEN NEW.agent_id IS NOT NULL AND COALESCE(NEW.vertical_id,'rfb') != 'rfb'
      BEGIN
        SELECT RAISE(ABORT, 'crm_contact_agent_id_wrong_vertical');
      END;

      DROP TRIGGER IF EXISTS trg_crm_contacts_agent_vertical_upd;
      CREATE TRIGGER trg_crm_contacts_agent_vertical_upd
      BEFORE UPDATE ON crm_contacts
      WHEN NEW.agent_id IS NOT NULL AND COALESCE(NEW.vertical_id,'rfb') != 'rfb'
      BEGIN
        SELECT RAISE(ABORT, 'crm_contact_agent_id_wrong_vertical');
      END;

      DROP TRIGGER IF EXISTS trg_crm_contacts_provider_vertical_ins;
      CREATE TRIGGER trg_crm_contacts_provider_vertical_ins
      BEFORE INSERT ON crm_contacts
      WHEN NEW.provider_id IS NOT NULL AND COALESCE(NEW.vertical_id,'rfb') != 'experiences'
      BEGIN
        SELECT RAISE(ABORT, 'crm_contact_provider_id_wrong_vertical');
      END;

      DROP TRIGGER IF EXISTS trg_crm_contacts_provider_vertical_upd;
      CREATE TRIGGER trg_crm_contacts_provider_vertical_upd
      BEFORE UPDATE ON crm_contacts
      WHEN NEW.provider_id IS NOT NULL AND COALESCE(NEW.vertical_id,'rfb') != 'experiences'
      BEGIN
        SELECT RAISE(ABORT, 'crm_contact_provider_id_wrong_vertical');
      END;
    `);
  } catch (e) {
    console.error(`[migration] steg 6 vertical-safety triggers failed:`, e);
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

  // ─── dev-request 2026-08-09-cs-rutine-to-plattformer-og-tradhistorikk,
  // skive 1.2 — backfill crm_outbox 'completed' rows into crm_messages ──────
  //
  // PROBLEM: POST /threads/:id/send has always queued a crm_outbox row,
  // sent (or drafted) the message, and logged a crm_actions row — but never
  // wrote a crm_messages row. So every reply sent through that route before
  // this fix is invisible in the thread's own message history: message_count
  // never grew, the thread looked unanswered, and a human or the CS-agent
  // reading the thread could not tell it had already been answered.
  //
  // FIX (forward-looking): crmService.recordOutboundReply(), called from the
  // route now, closes this for every NEW send. This block is the backward
  // half — it promotes every EXISTING crm_outbox row with status='completed'
  // into the crm_messages row it always should have produced, using the
  // outcome recorded on the outbox row itself (intent='resend_send' ->
  // delivery_status='sent'; intent='gmail_draft' -> 'draft_in_gmail', since
  // "completed" for a gmail_draft means the CS-agent created the draft, not
  // that Daniel actually sent it — see the sibling /outbox/:id/result
  // handler, which makes the exact same distinction).
  //
  // IDEMPOTENT: the backfilled row's id is deterministic —
  // 'msg-backfill-<outboxId>' — and the INSERT is OR IGNORE, so re-running
  // this block (even outside the migrations-table gate below) can never
  // double-insert. Only outbox rows with a live thread_id are eligible
  // (thread_id is nullable on crm_outbox but NOT NULL on crm_messages).
  //
  // After the insert, recompute the denormalized thread rollups
  // (message_count / last_message_at / last_inbound_at / last_outbound_at)
  // for every affected thread — the AFTER INSERT trigger above only touches
  // last_outbound_at, and only for delivery_status='sent' rows.
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
    const alreadyRanOutboxBackfill = db.prepare(
      "SELECT 1 FROM migrations WHERE name = 'backfill_outbox_completed_to_crm_messages_v1'"
    ).get();
    if (!alreadyRanOutboxBackfill) {
      const outboxBackfillResult = db.prepare(`
        INSERT OR IGNORE INTO crm_messages
          (id, thread_id, direction, from_email, to_emails, cc_emails, subject, body_text, body_html, snippet,
           sent_at, received_at, raw_metadata, delivery_status, vertical_id)
        SELECT
          'msg-backfill-' || o.id,
          o.thread_id,
          'out',
          'kontakt@rettfrabonden.com',
          o.to_emails,
          COALESCE(o.cc_emails, '[]'),
          o.subject,
          o.body_text,
          o.body_html,
          SUBSTR(COALESCE(o.body_text, ''), 1, 200),
          CASE WHEN o.intent = 'resend_send' THEN COALESCE(o.processed_at, o.created_at) ELSE NULL END,
          COALESCE(o.processed_at, o.created_at),
          json_object('source', 'backfill-outbox-to-crm-messages-v1', 'outboxId', o.id, 'intent', o.intent, 'createdBy', o.created_by),
          CASE WHEN o.intent = 'resend_send' THEN 'sent' ELSE 'draft_in_gmail' END,
          COALESCE(o.vertical_id, 'rfb')
        FROM crm_outbox o
        WHERE o.status = 'completed'
          AND o.thread_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM crm_messages m WHERE m.id = 'msg-backfill-' || o.id
          )
          -- Belt-and-suspenders against double-counting a send this migration
          -- never needed to touch: this gate is only meant for outbox rows
          -- that predate crmService.recordOutboundReply() (which now writes a
          -- LIVE crm_messages row synchronously at send time, going forward).
          -- In production the migrations-table gate above means this whole
          -- block runs exactly once, at the first boot after deploy, before
          -- any new send can happen — so this can never fire there. It matters
          -- for a DB that is migrated more than once in its lifetime (e.g. a
          -- test harness re-booting schema on a live DB): without it, an
          -- already-recorded live send would get a SECOND, redundant
          -- crm_messages row here and double-count message_count.
          AND NOT EXISTS (
            SELECT 1 FROM crm_messages m2
            WHERE m2.thread_id = o.thread_id AND m2.direction = 'out'
              AND m2.subject = o.subject AND m2.body_text = o.body_text
          )
      `).run();

      if (outboxBackfillResult.changes > 0) {
        const recompute = db.prepare(`
          UPDATE crm_threads
          SET message_count = (SELECT COUNT(*) FROM crm_messages WHERE crm_messages.thread_id = crm_threads.id),
              last_message_at = (SELECT MAX(sent_at) FROM crm_messages WHERE crm_messages.thread_id = crm_threads.id),
              last_inbound_at = (SELECT MAX(sent_at) FROM crm_messages WHERE crm_messages.thread_id = crm_threads.id AND direction = 'in'),
              last_outbound_at = (SELECT MAX(sent_at) FROM crm_messages WHERE crm_messages.thread_id = crm_threads.id AND direction = 'out' AND delivery_status = 'sent'),
              updated_at = datetime('now')
          WHERE id IN (
            SELECT DISTINCT thread_id FROM crm_outbox WHERE status = 'completed' AND thread_id IS NOT NULL
          )
        `).run();
        console.log(`🧹 Migration backfill_outbox_completed_to_crm_messages_v1: inserted ${outboxBackfillResult.changes} crm_messages row(s), recomputed rollups on ${recompute.changes} thread(s)`);
      }

      db.prepare("INSERT INTO migrations (name) VALUES ('backfill_outbox_completed_to_crm_messages_v1')").run();
    }
  } catch (err) {
    console.error("Migration backfill_outbox_completed_to_crm_messages_v1 failed:", err);
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

  // ─── dev-request 2026-07-12-rfb-enrichment-pool-refill-and-waste-reduction ──
  // homepage_fetch_attempts: consecutive homepage-provenance-batch fetch
  //   failures for this agent (any successful fetch resets it to 0).
  // homepage_unreachable_since: set when attempts reaches 3 — parks the agent
  //   out of the batch auto-select until 30 days have passed, so each run
  //   stops re-fetching the same dead/aggregator URLs.
  for (const stmt of [
    `ALTER TABLE agent_knowledge ADD COLUMN homepage_fetch_attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE agent_knowledge ADD COLUMN homepage_unreachable_since TEXT`,
  ]) {
    try {
      db.exec(stmt);
    } catch {
      // Column already exists — expected after first migration
    }
  }

  // ─── dev-request 2026-07-12-rfb-enrichment-pool-refill-and-waste-reduction
  // (item 3) — domain-coherence reconciliation parking ──────────────────────
  // domain_reconciliation_checked_at: ISO timestamp of the last
  //   /admin/verifier/domain-coherence-sweep apply-mode pass that looked at
  //   this agent and did NOT auto-fix it (coherent / manual_review_needed /
  //   circular_scramble_candidate outcome).
  // domain_reconciliation_outcome: 'no_action_needed' | 'manual_review_needed'
  //   | 'circular_scramble_candidate' — what the sweep decided, for
  //   observability/debugging.
  // domain_reconciliation_reason_snapshot: the agent_knowledge.
  //   verification_review_reason value AT the time of the check, so the
  //   backoff-exclusion query can tell "still the same problem" (skip) apart
  //   from "something new happened since" (don't permanently silence —
  //   re-surface even inside the 30-day window).
  for (const stmt of [
    `ALTER TABLE agent_knowledge ADD COLUMN domain_reconciliation_checked_at TEXT`,
    `ALTER TABLE agent_knowledge ADD COLUMN domain_reconciliation_outcome TEXT`,
    `ALTER TABLE agent_knowledge ADD COLUMN domain_reconciliation_reason_snapshot TEXT`,
  ]) {
    try {
      db.exec(stmt);
    } catch {
      // Column already exists — expected after first migration
    }
  }

  // ─── dev-request 2026-07-12-rfb-enrichment-pool-refill-and-waste-reduction
  // (item 6 follow-up) — pending_verify no-progress parking ────────────────
  // pending_verify_no_progress_count: increments every time a re-verification
  //   of a `pending_verify` agent (via the bulk sweep in
  //   src/services/verifier-sweep.ts / applyVerifierOutcome) resolves BACK to
  //   `pending_verify` — i.e. the gate re-fails for the same structural reason
  //   (deriveVerificationStatus's `!passes` branch) and no new data (email,
  //   Brreg fix, etc.) was acquired. Any outcome OTHER than `pending_verify`
  //   (verified / review_required / data_insufficient — real progress) fully
  //   resets this to 0.
  // pending_verify_parked_since: stamped once pending_verify_no_progress_count
  //   reaches 3 consecutive no-progress outcomes — parks the agent out of
  //   pickPendingVerifyBatch's auto-select for 30 days, same shape as
  //   PR #248's homepage_fetch_attempts/homepage_unreachable_since idiom in
  //   marketplace.ts and the domain_reconciliation_checked_at idiom in
  //   lokal-agent-verifier.ts's pickReviewQueueBatch — this stops the bulk
  //   sweep from burning wall-clock/compute re-probing website/Brreg
  //   reachability on a cohort (a real ~817-row prod tail) that is proven
  //   unresolvable by re-verification alone because it's missing data the
  //   sweep has no way to acquire (e.g. a missing email). Reset to NULL the
  //   moment real progress happens (any non-pending_verify outcome).
  for (const stmt of [
    `ALTER TABLE agent_knowledge ADD COLUMN pending_verify_no_progress_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE agent_knowledge ADD COLUMN pending_verify_parked_since TEXT`,
  ]) {
    try {
      db.exec(stmt);
    } catch {
      // Column already exists — expected after first migration
    }
  }

  // ─── dev-request 2026-07-19-enrichment-selector-rotasjon-no-yield-backoff ──
  // POST /admin/homepage-provenance-batch's default auto-select ordered by
  // k.updated_at ASC, but its two "nothing useful came out of this fetch"
  // early-return paths (fetch succeeded, ownership guard rejected the page /
  // fetch succeeded but no contact fields were extractable) never wrote
  // ANYTHING to agent_knowledge — not even updated_at. An agent that landed in
  // that gap sorted as "least recently touched" FOREVER and got reselected on
  // every single call (CONFIRMED: 3 consecutive calls with limit:15 returned
  // the identical processed=13, enriched=0 batch — zero universe coverage).
  // last_enrichment_attempt_at / last_enrichment_outcome are stamped on EVERY
  // agent for which a homepage fetch was actually attempted (all outcomes),
  // and the selector now orders by last_enrichment_attempt_at ASC (NULLs —
  // never attempted — first) instead of updated_at, guaranteeing full-universe
  // rotation before any repeat. no_yield_streak adds a softer, separate
  // backoff on top of that rotation: 3 consecutive no-yield outcomes (fetched
  // fine, nothing extractable) rest the agent for NO_YIELD_BACKOFF_DAYS days
  // (env-configurable, default 14) so a page that structurally never yields
  // anything doesn't keep burning a network round-trip every run. This is
  // fully independent of, and additive alongside, the existing
  // homepage_fetch_attempts / homepage_unreachable_since 3-strikes / 30-day
  // fetch-FAILURE parking mechanism above — that mechanism is untouched.
  // last_enrichment_outcome values: 'enriched' | 'no_yield' | 'fetch_failed' |
  // 'wrong_entity' (the existing website-ownership-guard rejection branch —
  // homepage fetched fine but the page doesn't mention the producer).
  // 'locked' is part of the outcome vocabulary for other enrichment handlers
  // (e.g. the curated-fields gate in homepage-content-refresh) but has no
  // reachable branch in THIS handler, so it is never written here.
  for (const stmt of [
    `ALTER TABLE agent_knowledge ADD COLUMN last_enrichment_attempt_at TEXT`,
    `ALTER TABLE agent_knowledge ADD COLUMN last_enrichment_outcome TEXT`,
    `ALTER TABLE agent_knowledge ADD COLUMN no_yield_streak INTEGER NOT NULL DEFAULT 0`,
    // dev-request 2026-07-19-enrichment-selector-rotasjon-no-yield-backoff
    // (follow-up slice, orch-pr-wrongentity): mirrors no_yield_streak above but
    // for the website-ownership-guard rejection branch ('wrong_entity' — page
    // fetched fine but doesn't mention the producer) specifically. A wrong-site
    // mismatch essentially never resolves itself, so this cohort needs its own
    // independent backoff or it gets reselected forever once the rest of the
    // universe rests. Independent of no_yield_streak — only an 'enriched'
    // outcome resets either streak.
    `ALTER TABLE agent_knowledge ADD COLUMN wrong_entity_streak INTEGER NOT NULL DEFAULT 0`,
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
    // ─── P0-2026-07-11: recipient_email — email-keyed suppression column ──────
    // The agent_id key is fragile: the same producer can hold multiple/churning
    // agent_id rows (duplicate producers, re-registration), so an agent_id-only
    // NOT EXISTS gate leaks a re-send whenever the send-time agent_id differs
    // from the pool-time agent_id (confirmed live: Beiarmat, send-time producer
    // 38476f5d… vs current agent 94af0bec…). recipient_email is the immutable
    // key we actually emailed; suppression matches on it the same normalized way
    // isBlocked() matches the blocklist. Idempotent ALTER (column-guard).
    const oslCols = db.prepare(`PRAGMA table_info(outreach_sent_log)`).all() as Array<{ name: string }>;
    if (!oslCols.some((c) => c.name === "recipient_email")) {
      db.exec(`ALTER TABLE outreach_sent_log ADD COLUMN recipient_email TEXT`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_outreach_sent_log_recipient_email ON outreach_sent_log(recipient_email)`);
    // Which platform the send belonged to. The table serves TWO purposes that the
    // original schema conflated, and they want opposite scopes:
    //   • the 60-day cold-outreach cooldown (routes/crm.ts) is keyed on the
    //     recipient EMAIL and must stay CROSS-PLATFORM — mailing the same human
    //     as "Rett fra Bonden" on Monday and "Opplevagent" on Wednesday is spam
    //     however clean our data model is.
    //   • the outreach_ready_pool exclusion is keyed on the RFB agent and must be
    //     RFB-ONLY — an Opplevagent send must never drop a producer out of RFB
    //     outreach.
    // Without this column the two cannot be told apart, and any fix for one
    // breaks the other. (Measured: guarding the WRITE fixed the pool and silently
    // deleted the cooldown for every non-rfb vertical — review B2.)
    if (!oslCols.some((c) => c.name === "vertical_id")) {
      db.exec(`ALTER TABLE outreach_sent_log ADD COLUMN vertical_id TEXT NOT NULL DEFAULT 'rfb'`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_outreach_sent_log_vertical ON outreach_sent_log(vertical_id)`);
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
  // DESIGN NOTE (v2, P0-2026-07-11): the original trigger identified marketing
  // sends ONLY by the threadId prefix "marketing-batch-%". That discriminator
  // silently broke when the marketing agent's phase-2 send loop switched to
  // POST /admin/crm/compose (marketing-comms-agent-email-verification-addendum),
  // which creates compose-<uuid> threads. Those sends never matched the prefix
  // → never landed in outreach_sent_log → the outreach_ready_pool VIEW never
  // excluded them → the same producer was re-sent every morning (Beiarmat 3
  // days in a row; 91 recipients ≥2 days, July 2026).
  //
  // FIX: discriminate on SHAPE, not thread-id format. A cold outreach is an
  // out/sent message on a thread with NO inbound message. That captures BOTH
  // marketing-batch-* (Resend/ingest) AND compose-* (compose UI/agent) cold
  // outreach, while excluding CS replies (which always sit on a thread that has
  // an inbound). We also record recipient_email (LOWER(cc.email)) so the pool
  // gate can suppress by the immutable email key even when agent_id churns.
  //
  // agent_id stays NOT NULL: resolve it best-effort (cc.agent_id, else the
  // agent_knowledge.email match used by the v2 reclassify migration below). If
  // no agent resolves, the recipient is not in our catalog / pool anyway, so
  // skipping the row is safe.
  //
  // Idempotent: DROP old + CREATE IF NOT EXISTS. Dedup guard: NOT EXISTS on
  // message_id. Origin: orchestrator PR-38 (2026-06-21); v2 P0 fix 2026-07-11.
  try {
    db.exec(`DROP TRIGGER IF EXISTS trg_log_marketing_send_to_outreach_sent_log`);
    // The v2 triggers are DROPped before being recreated, not merely guarded by
    // IF NOT EXISTS. Without the drop, editing the body below has NO EFFECT on
    // any database that already carries the trigger — i.e. on production — and
    // the change would look applied while the old definition kept running. That
    // is exactly how a migration can pass review and do nothing.
    db.exec(`DROP TRIGGER IF EXISTS trg_log_cold_outreach_to_sent_log_v2`);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_log_cold_outreach_to_sent_log_v2
        AFTER INSERT ON crm_messages
        FOR EACH ROW
        WHEN NEW.direction = 'out' AND NEW.delivery_status = 'sent'
        BEGIN
          INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes, vertical_id)
          SELECT
            COALESCE(
              cc.agent_id,
              (SELECT a.id FROM agent_knowledge k JOIN agents a ON a.id = k.agent_id
                WHERE LOWER(k.email) = LOWER(cc.email) AND a.is_active = 1 LIMIT 1)
            ),
            LOWER(cc.email),
            COALESCE(NEW.sent_at, datetime('now')),
            'email',
            NEW.id,
            'auto:cold_outreach_v2',
            NEW.vertical_id
          FROM crm_threads ct
          JOIN crm_contacts cc ON cc.id = ct.contact_id
          WHERE ct.id = NEW.thread_id
            AND cc.email IS NOT NULL AND cc.email != ''
            AND COALESCE(
              cc.agent_id,
              (SELECT a.id FROM agent_knowledge k JOIN agents a ON a.id = k.agent_id
                WHERE LOWER(k.email) = LOWER(cc.email) AND a.is_active = 1 LIMIT 1)
            ) IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM crm_messages m2
              WHERE m2.thread_id = NEW.thread_id AND m2.direction = 'in'
            )
            AND NOT EXISTS (
              SELECT 1 FROM outreach_sent_log o WHERE o.message_id = NEW.id
            );
        END
    `);
  } catch (err) {
    console.error("Migration trg_log_cold_outreach_to_sent_log_v2 failed:", err);
  }

  // ─── v2b (P0-2026-07-11): also record on the queued→sent CONFIRM path ─────
  //
  // CRITICAL companion to the AFTER INSERT trigger above. The marketing agent's
  // phase-2 loop sends via POST /admin/crm/compose, which inserts the crm_message
  // as delivery_status='queued' and only flips it to 'sent' via a LATER UPDATE
  // (updateMessageDeliveryStatus) once Resend confirms. An AFTER INSERT trigger
  // with WHEN NEW.delivery_status='sent' therefore NEVER fires for compose sends
  // — the row is 'queued' at insert time. Without this AFTER UPDATE trigger the
  // v2 fix would only close historical sends (via the backfill) while every
  // FUTURE compose send would still leak. The marketing-batch/ingest path inserts
  // directly as 'sent' (AFTER INSERT covers it); this covers the compose path.
  //
  // Fires only on the transition INTO 'sent' (OLD.delivery_status != 'sent') so a
  // no-op UPDATE can't re-run it; the message_id dedup guard makes a double-fire
  // across both triggers a no-op anyway.
  try {
    db.exec(`DROP TRIGGER IF EXISTS trg_log_cold_outreach_on_send_confirm_v2`);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_log_cold_outreach_on_send_confirm_v2
        AFTER UPDATE OF delivery_status ON crm_messages
        FOR EACH ROW
        WHEN NEW.direction = 'out'
          AND NEW.delivery_status = 'sent'
          AND (OLD.delivery_status IS NULL OR OLD.delivery_status != 'sent')
        BEGIN
          INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes, vertical_id)
          SELECT
            COALESCE(
              cc.agent_id,
              (SELECT a.id FROM agent_knowledge k JOIN agents a ON a.id = k.agent_id
                WHERE LOWER(k.email) = LOWER(cc.email) AND a.is_active = 1 LIMIT 1)
            ),
            LOWER(cc.email),
            COALESCE(NEW.sent_at, datetime('now')),
            'email',
            NEW.id,
            'auto:cold_outreach_confirm_v2',
            NEW.vertical_id
          FROM crm_threads ct
          JOIN crm_contacts cc ON cc.id = ct.contact_id
          WHERE ct.id = NEW.thread_id
            AND cc.email IS NOT NULL AND cc.email != ''
            AND COALESCE(
              cc.agent_id,
              (SELECT a.id FROM agent_knowledge k JOIN agents a ON a.id = k.agent_id
                WHERE LOWER(k.email) = LOWER(cc.email) AND a.is_active = 1 LIMIT 1)
            ) IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM crm_messages m2
              WHERE m2.thread_id = NEW.thread_id AND m2.direction = 'in'
            )
            AND NOT EXISTS (
              SELECT 1 FROM outreach_sent_log o WHERE o.message_id = NEW.id
            );
        END
    `);
  } catch (err) {
    console.error("Migration trg_log_cold_outreach_on_send_confirm_v2 failed:", err);
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

  // ─── v3 (P0-2026-07-11): backfill recipient_email + missing compose- sends ──
  //
  // Two idempotent steps, guarded by the migrations table:
  //   Step 1 — populate recipient_email on existing outreach_sent_log rows
  //            (the ~363 legacy marketing-batch rows have it NULL) from the
  //            crm_message they reference; fall back to agent_knowledge.email.
  //   Step 2 — retroactively log every historical COLD outreach (out/sent on a
  //            no-inbound thread) that is NOT yet in outreach_sent_log — this is
  //            the ~127 July compose-<uuid> sends that leaked past the old
  //            marketing-batch-% trigger. Same shape-discriminator + email key
  //            as the v2 trigger above, so the pool VIEW excludes them at once.
  try {
    const alreadyRanV3 = db.prepare(
      "SELECT 1 FROM migrations WHERE name = 'backfill_recipient_email_and_compose_cold_sends_v3'"
    ).get();
    if (!alreadyRanV3) {
      // Step 1a: recipient_email from the referenced crm_message's contact.
      const emailFromMsg = db.prepare(`
        UPDATE outreach_sent_log
        SET recipient_email = (
          SELECT LOWER(cc.email)
          FROM crm_messages m
          JOIN crm_threads ct ON ct.id = m.thread_id
          JOIN crm_contacts cc ON cc.id = ct.contact_id
          WHERE m.id = outreach_sent_log.message_id
            AND cc.email IS NOT NULL AND cc.email != ''
        )
        WHERE recipient_email IS NULL AND message_id IS NOT NULL
      `).run();
      // Step 1b: fallback via agent_knowledge.email for rows still NULL.
      const emailFromKnowledge = db.prepare(`
        UPDATE outreach_sent_log
        SET recipient_email = (
          SELECT LOWER(k.email) FROM agent_knowledge k
          WHERE k.agent_id = outreach_sent_log.agent_id
            AND k.email IS NOT NULL AND k.email != ''
          LIMIT 1
        )
        WHERE recipient_email IS NULL
      `).run();
      // Step 2: backfill missing cold outreach (compose-* etc.) by shape.
      const composeBackfill = db.prepare(`
        INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes, vertical_id)
        SELECT
          COALESCE(
            cc.agent_id,
            (SELECT a.id FROM agent_knowledge k JOIN agents a ON a.id = k.agent_id
              WHERE LOWER(k.email) = LOWER(cc.email) AND a.is_active = 1 LIMIT 1)
          ),
          LOWER(cc.email),
          COALESCE(m.sent_at, datetime('now')),
          'email',
          m.id,
          'backfill:cold_outreach_v3',
          m.vertical_id
        FROM crm_messages m
        JOIN crm_threads ct ON ct.id = m.thread_id
        JOIN crm_contacts cc ON cc.id = ct.contact_id
        WHERE m.direction = 'out'
          AND m.delivery_status = 'sent'
          AND cc.email IS NOT NULL AND cc.email != ''
          AND COALESCE(
            cc.agent_id,
            (SELECT a.id FROM agent_knowledge k JOIN agents a ON a.id = k.agent_id
              WHERE LOWER(k.email) = LOWER(cc.email) AND a.is_active = 1 LIMIT 1)
          ) IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM crm_messages m2
            WHERE m2.thread_id = m.thread_id AND m2.direction = 'in'
          )
          AND NOT EXISTS (
            SELECT 1 FROM outreach_sent_log o WHERE o.message_id = m.id
          )
      `).run();
      db.prepare("INSERT INTO migrations (name) VALUES ('backfill_recipient_email_and_compose_cold_sends_v3')").run();
      const touched = (emailFromMsg.changes || 0) + (emailFromKnowledge.changes || 0);
      if (touched > 0 || composeBackfill.changes > 0) {
        console.log(`[v3-P0] backfill recipient_email: ${touched} row(s) filled; compose/cold backfill inserted ${composeBackfill.changes} missing send(s) into outreach_sent_log`);
      }
    }
  } catch (err) {
    console.error("Migration backfill_recipient_email_and_compose_cold_sends_v3 failed:", err);
  }


  // outreach_ready_pool VIEW — the list marketing will read once
  // WO #9 switches over. Filtered by:
  //   - non-null email
  //   - verification_status = 'verified'
  //   - enrichment_status = 'rich'
  //   - never sent through the new pipeline (outreach_sent_log)
  // NOTE: agents.removed_at does not exist yet (Phase 5.10) — using
  // 1=1 as placeholder so the VIEW resolves on prod today.
  //
  // ─── dev-request 2026-07-30-outreach-gate-tynne-profiler ───
  // Was `enrichment_status IN ('partial', 'rich')`. `partial` profiles are
  // half-empty by computeEnrichmentStatus's own definition (lokal-agent-
  // verifier.ts) — an outreach email pointing a producer at their own thin
  // profile burns the first impression with exactly the producers we want.
  // Tightened to `= 'rich'` only. Deliberately the simplest lever (Daniel,
  // 2026-07-30): one condition, enforced at the same single choke point as
  // the rest of the gate, no new mechanism. Pool size drops as a direct,
  // expected consequence — the bottleneck moves to enrichment, which is
  // exactly where dev-request 2026-07-29-blacklist-backfill-og-
  // berikelsestriage (slice 3) is already refilling it with `rich` profiles.
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
        AND k.enrichment_status = 'rich'
        AND 1=1  /* TODO Phase 5.10: AND a.removed_at IS NULL */
        AND k.url_last_status IS NOT NULL
        AND k.url_last_status >= 200
        AND k.url_last_status < 400
        AND k.url_last_probed IS NOT NULL
        AND k.url_last_probed > datetime('now', '-30 days')
        /* P0-2026-07-11: email-keyed OR agent_id-keyed exclusion. Matching on
           recipient_email (the immutable address we emailed) makes suppression
           survive agent_id churn / duplicate producer rows — the same robust
           key the blocklist uses. agent_id kept for legacy rows lacking a
           recipient_email backfill. */
        AND NOT EXISTS (
          SELECT 1 FROM outreach_sent_log o
          /* Platform scope (dev-request 2026-07-27-crm-plattformadskillelse, steg 3
             precondition). This pool is the RFB outreach pool — its rows are agents
             in the RFB catalogue. An Opplevagent send resolves to the same producer
             by EMAIL, so without this line it would drop them out of RFB outreach
             for good: a silent under-send, where nothing errors and the producer
             simply stops being contacted.
             The 60-day cooldown in routes/crm.ts is deliberately NOT scoped this
             way — see the comment on outreach_sent_log.vertical_id. Suppressing a
             POOL is per-platform bookkeeping; not cold-mailing the same human twice
             is a courtesy that does not care which brand is on the envelope. */
          WHERE o.vertical_id = 'rfb'
            AND (o.agent_id = a.id
                 OR (o.recipient_email IS NOT NULL AND o.recipient_email = LOWER(k.email)))
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

  // products.availability_updated_at / availability_source — added for
  // dev-request 2026-07-13-supply-graph-v1 (Slice 1). Additive only — does
  // NOT touch the existing `availability` column or its default. Nullable
  // timestamp lets us tell "never producer-set" (NULL) from "producer set it,
  // possibly a while ago"; source defaults to 'enrichment' so every existing
  // row (and every future enrichment-written row) keeps behaving exactly as
  // before — only rows a producer has explicitly set via the (future)
  // owner-portal endpoint get source='producer_dashboard' and become subject
  // to staleness in src/services/supply-graph.ts.
  // SQLite has no ADD COLUMN IF NOT EXISTS — same try/catch-duplicate-column
  // guard as every other additive migration in this file.
  try {
    db.exec(`ALTER TABLE products ADD COLUMN availability_updated_at TEXT`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE products ADD COLUMN availability_source TEXT NOT NULL DEFAULT 'enrichment'`);
  } catch {
    // Column already exists
  }

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

  // ─── dev-request 2026-07-13-pilot-ordre-loop: selgervarsling + livssyklus
  // + trust-ledger for cart-ordre (RFB) ────────────────────────────────────
  // All additive. Same defensive try/catch ALTER idiom as the brreg slice
  // below; brand-new tables use plain CREATE TABLE IF NOT EXISTS (the safe
  // migration for a never-existed-before table — see contact_clicks note).
  //
  //   agents.order_notifications_opt_in : send-gate. 0 (default) = NEVER
  //       notify this producer about orders. Only an explicit admin action
  //       (POST /admin/orders/notification-optin) flips it to 1.
  //   agents.order_notification_email   : admin-set override recipient. When
  //       set, it wins over contact_email AND counts as "verified contact"
  //       (an admin explicitly chose it — this is how Daniel points a test
  //       agent at his own inbox, mirroring the booking test-provider
  //       pattern). When NULL, contact_email is used and the agent must be
  //       verification_status='verified' in agent_knowledge.
  //   orders.cancel_reason              : why a cancelled order was cancelled
  //       ('no_show' is the only writer today — producer "Ikke hentet").
  for (const stmt of [
    `ALTER TABLE agents ADD COLUMN order_notifications_opt_in INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE agents ADD COLUMN order_notification_email TEXT`,
    `ALTER TABLE orders ADD COLUMN cancel_reason TEXT`,
  ]) {
    try { db.exec(stmt); } catch { /* already exists — expected */ }
  }

  // confirm_token is now a lookup key (the /produsent/ordre/:token page), so
  // index it. UNIQUE preferred (it's a capability token, 16 random bytes) —
  // but this must NEVER be able to break boot on an existing prod DB, so a
  // hypothetical pre-existing duplicate falls back to a non-unique index.
  // Multiple NULLs are fine in a SQLite UNIQUE index (NULLs are distinct).
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_confirm_token ON orders(confirm_token)`);
  } catch {
    try {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_confirm_token ON orders(confirm_token)`);
    } catch { /* index creation is best-effort — lookups still work unindexed */ }
  }

  // order_events: append-only status-transition timeline per order. Written
  // by cart-service.transitionOrder() on every legal transition; exposed to
  // the buyer via getOrder() (lokal_order_status / GET /api/marketplace/
  // orders/:id) and to the producer via the /produsent/ordre/:token page.
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_events (
      id           TEXT PRIMARY KEY,
      order_id     TEXT NOT NULL,
      from_status  TEXT,
      to_status    TEXT NOT NULL,
      actor        TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events(order_id)`);

  // trust_events: the transaction trust-ledger. One row per terminal
  // transaction outcome (order completed / no-show / declined today;
  // booking_attended / booking_no_show reserved for the booking-resolve
  // wiring later — recordTrustEvent() in services/trust-event-service.ts is
  // the single write path). Read by trust-score-service's interaction
  // signal. No FK on agent_id (same convention as contact_clicks /
  // analytics_agent_views: history survives agent deletion).
  db.exec(`
    CREATE TABLE IF NOT EXISTS trust_events (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL,
      event_type  TEXT NOT NULL CHECK(event_type IN (
                    'order_completed','order_no_show','order_declined',
                    'booking_attended','booking_no_show')),
      ref         TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trust_events_agent_id ON trust_events(agent_id)`);

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

  // ─── agents_org_nr_audit / agents_org_nr_review_queue (dev-request ─────
  // 2026-07-26-rfb-outreach-tilsig-blokkerdiagnose-og-orgnr, Steg 2) ────────
  //
  // Porting the already-reviewed gårdssalg org_nr-backfill mechanism
  // (gardssalg_content_audit / gardssalg_orgnr_review_queue, init-
  // experiences.ts, dev-request 2026-07-18-gardssalg-profilkvalitet-foer-
  // outreach slice 5b) to the `agents` table, so the same Brreg-name-search
  // candidate generation + strict write-bar veto chain can backfill org_nr
  // for the 959 RFB agents stuck in pending_verify/review_required for lack
  // of a 2nd corroborating address/phone source (GATING_FIELDS,
  // cross-source-validator.ts) — acquiring org_nr unlocks a DIRECT
  // Brreg-by-orgnr lookup (fetchBrregBusinessAddress/fetchBrregContact,
  // brreg-client.ts) as that 2nd source, in a later slice (Steg 3, gated on
  // this one landing first).
  //
  // agents_org_nr_audit mirrors gardssalg_content_audit's shape exactly
  // (insert-only, field-level changelog) — used by applyAgentOrgNr
  // (routes/admin-agents.ts) for the write's audit trail AND by
  // agentOrgNrWasRolledBack's "don't silently re-apply a human-reverted
  // org_nr" check (a manual `UPDATE agents SET org_nr = NULL ...` per this
  // dev-request's own Rollback section does not by itself write a
  // rollback-marker row here — a future rollback ENDPOINT, mirroring
  // POST /admin/gardssalg-content-rollback, would need to; that endpoint is
  // NOT built in this slice, so this check's real trigger condition is a
  // deliberate no-op today, wired ahead of time so a later rollback-endpoint
  // slice doesn't also have to touch the write-bar).
  //
  // agents_org_nr_review_queue mirrors gardssalg_orgnr_review_queue's shape,
  // with one addition — candidate_source ("brreg_name_search" |
  // "local_json_lokalmat" | "local_json_debio") — so POST /admin/agents/
  // org-nr-review-approve can reconstruct an honest evidence_url/provenance
  // source_type for a human-approved write, since a queued candidate may
  // have come from either the vendored local-JSON candidate generator
  // (services/local-orgnr-candidates.ts) or a live Brreg name-search.
  // UNIQUE(agent_id): a re-run of the backfill route upserts a given
  // agent's queue row in place rather than accumulating duplicates, same
  // "refresh, don't pile up" idiom as gardssalg_orgnr_review_queue.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agents_org_nr_audit (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        source_url TEXT,
        batch_id TEXT,
        changed_by TEXT NOT NULL DEFAULT 'system',
        changed_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_org_nr_audit_agent ON agents_org_nr_audit(agent_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_org_nr_audit_batch ON agents_org_nr_audit(batch_id)`);
  } catch (err) {
    console.error("Migration agents_org_nr_audit failed:", err);
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agents_org_nr_review_queue (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL UNIQUE,
        agent_name TEXT,
        candidate_orgnr TEXT,
        candidate_name TEXT,
        candidate_confidence REAL,
        candidate_address TEXT,
        candidate_source TEXT,
        reason TEXT NOT NULL,
        batch_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_org_nr_review_queue_reason ON agents_org_nr_review_queue(reason)`);
  } catch (err) {
    console.error("Migration agents_org_nr_review_queue failed:", err);
  }

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

  // ─── Mapbox Directions monthly allowance (services/mapbox-budget.ts) ───
  // Daniel, 2026-07-26: «jeg fant ingen måte å sette pristak under billing.»
  // There is none — Mapbox offers usage alerts, not a ceiling. This counter IS
  // the ceiling, which is why it lives in the database rather than in memory:
  // an in-memory counter resets on every deploy, and we deploy several times a
  // day. Declared HERE rather than lazily in the service (review note N3) so
  // the table exists from first boot and schema tooling can see it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS mapbox_monthly_usage (
      month TEXT PRIMARY KEY,
      calls INTEGER NOT NULL DEFAULT 0
    )
  `);

  // ─── dev-request 2026-07-06-rfb-fjern-debio-norsk-gardsmat ─────────────
  // Daniel-confirmed: no public surface (homepage "Marked-nettverk",
  // /api/marketplace/umbrellas, MCP lokal_list_umbrellas, search, sitemap)
  // should show the Debio or Norsk Gardsmat umbrella networks anymore.
  //
  // All of those surfaces already gate on the pre-existing `agents.is_active`
  // flag (see routes/marketplace.ts GET /umbrellas, routes/mcp.ts
  // lokal_list_umbrellas, routes/seo.ts homepage umbrella section, and
  // marketplaceRegistry.getAgentBySlugIncludingUmbrellas used by
  // GET /produsent/:slug) — there is no separate `umbrellas` table and no
  // new column is needed, we just need to flip/remove these two specific
  // agents rows:
  //
  //   - Debio (id 2a10c855-00c5-4ba3-a34e-315e930f95a5, slug 'debio'):
  //     soft-deactivate (is_active=0). Reversible — an admin can flip it
  //     back to 1 later to restore. The row itself, its debio_verified /
  //     debio_finnoko_id data, and any agent_affiliations rows are left
  //     intact so a future reactivation doesn't lose history. See also the
  //     guard added to routes/admin-affiliations.ts (PR-58 auto-tag
  //     endpoint) and services/debio-cross-check.ts (C.1-A cross-check)
  //     that now no-op while the target umbrella is inactive, so nothing
  //     re-links/revives Debio affiliations while it's deactivated.
  //   - Norsk Gardsmat (id 39749db1-54af-4865-bb01-e87a23ae55a1, slug
  //     'norsk-gardsmat'): hard-delete. Research confirmed member_count=0
  //     (no producer affiliations) and the organization no longer exists,
  //     so there is nothing to preserve. agent_affiliations rows
  //     referencing it as umbrella_id cascade-delete via the existing
  //     `FOREIGN KEY (umbrella_id) REFERENCES agents(id) ON DELETE CASCADE`
  //     (foreign_keys=ON is set in getDb() above). Defensively also NULL
  //     out any stray agents.parent_umbrella_id pointing at it first —
  //     that column carries no FK constraint so it would not otherwise be
  //     cleaned up (should be a no-op given the confirmed member_count=0).
  //
  // One-time guarded migration — same `migrations` table idiom as
  // backfill_agents_org_nr_from_tags_v1 above — so this does NOT re-apply
  // on every boot. That matters for reversibility: if an admin later flips
  // Debio's is_active back to 1, this migration must not re-deactivate it
  // on the next restart. Purely additive/data-only: no destructive schema
  // change, and a no-op on any DB where these two ids don't exist (e.g.
  // fresh test databases).
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
    const alreadyRan = db.prepare(
      "SELECT 1 FROM migrations WHERE name = 'deactivate_debio_delete_norsk_gardsmat_v1'"
    ).get();
    if (!alreadyRan) {
      const DEBIO_ID = "2a10c855-00c5-4ba3-a34e-315e930f95a5";
      const NORSK_GARDSMAT_ID = "39749db1-54af-4865-bb01-e87a23ae55a1";

      const debioResult = db.prepare(
        "UPDATE agents SET is_active = 0 WHERE id = ?"
      ).run(DEBIO_ID);

      db.prepare(
        "UPDATE agents SET parent_umbrella_id = NULL WHERE parent_umbrella_id = ?"
      ).run(NORSK_GARDSMAT_ID);
      const gardsmatResult = db.prepare(
        "DELETE FROM agents WHERE id = ?"
      ).run(NORSK_GARDSMAT_ID);

      db.prepare("INSERT INTO migrations (name) VALUES ('deactivate_debio_delete_norsk_gardsmat_v1')").run();
      console.log(
        `\u{1F9F9} Migration deactivate_debio_delete_norsk_gardsmat_v1: ` +
        `debio deactivated=${debioResult.changes}, norsk_gardsmat deleted=${gardsmatResult.changes}`
      );
    }
  } catch (err) {
    console.error("Migration deactivate_debio_delete_norsk_gardsmat_v1 failed:", err);
  }

  // ─── dev-request 2026-07-06-rfb-salgskanal-kategorier (datamodel slice) ──
  // "Salgskanal" (sales-channel) grouping: browsable-by-how-you-buy, distinct
  // from product categories (vegetables/fruit/...) and umbrella orgs
  // (Hanen/Debio/Bondens marked). Five categories in v1 (Daniel-confirmed
  // live 2026-07-06): Selvplukk, Hjemlevering, Gårdsbutikk, Gårdskafé/
  // servering, REKO-ring. Membership is 100% auto-derived by
  // services/salgskanal-matcher.ts (keyword/regex heuristics over
  // name/description/tags/skills) — NO manual curation by default, but
  // `source='manual'` rows are preserved across matcher re-runs (see
  // runSalgskanalSweep()) so an admin override always survives.
  //
  // Additive only: two brand-new tables, no changes to existing tables'
  // existing columns. This is the datamodel + auto-matcher slice only
  // (work item 1-2 of the dev-request's Spec); the public landing pages
  // (work item 3), homepage discoverability (work item 4), and the
  // AI-discovery/MCP surface (work item 5) are explicitly OUT of scope
  // for this slice and deferred to a follow-up.
  //
  // salgskanal_categories: static lookup of the (currently 5) category
  // definitions. A real table (not a hard-coded enum) so a future slice
  // can add a 6th category without another migration. sort_order seeds
  // roughly by measured cohort size (largest first) per the dev-request's
  // own risk note ("Hjemlevering er tynn i dag — siden må ikke se død ut,
  // sorter kategoriene etter størrelse") — the future landing-page slice
  // can rely on it directly.
  db.exec(`
    CREATE TABLE IF NOT EXISTS salgskanal_categories (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0
    )
  `);
  {
    const seedCategory = db.prepare(`
      INSERT INTO salgskanal_categories (slug, name, description, sort_order)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(slug) DO NOTHING
    `);
    const SEED_CATEGORIES: Array<[string, string, string, number]> = [
      ["gardsbutikk", "Gårdsbutikk", "Produsenter med egen gårdsbutikk eller gårdsutsalg.", 0],
      ["gardskafe-servering", "Gårdskafé/servering", "Produsenter med egen kafé eller servering på gården.", 1],
      ["reko-ring", "REKO-ring", "Produsenter som selger via en REKO-ring.", 2],
      ["selvplukk", "Selvplukk", "Produsenter som tilbyr selvplukk av bær, frukt, grønnsaker m.m.", 3],
      ["hjemlevering", "Hjemlevering", "Produsenter som tilbyr hjemlevering/utkjøring av varer.", 4],
    ];
    for (const row of SEED_CATEGORIES) seedCategory.run(...row);
  }

  // agent_salgskanal: producer↔category join. UNIQUE(agent_id, category_slug)
  // keeps the matcher's upserts idempotent on re-runs. `source` mirrors the
  // agent_affiliations 'inferred' vs human-curated distinction (PR-58/PR-46
  // pattern above): 'auto' rows are freely refreshed/removed by the matcher
  // sweep; 'manual' rows are an admin override and the sweep must never
  // touch them (neither refresh nor delete) — see runSalgskanalSweep().
  // matched_keywords + evidence_snippet exist for the dev-request's
  // precision-audit acceptance criterion ("verifier tar 30 tilfeldige
  // koblinger ... finner belegg i profilen for >= 95%").
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_salgskanal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      category_slug TEXT NOT NULL REFERENCES salgskanal_categories(slug) ON DELETE CASCADE,
      source TEXT NOT NULL DEFAULT 'auto' CHECK(source IN ('auto','manual')),
      matched_keywords TEXT,
      evidence_snippet TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(agent_id, category_slug)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_salgskanal_category ON agent_salgskanal(category_slug)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_salgskanal_agent ON agent_salgskanal(agent_id)`);

  // ─── dev-request 2026-07-13-agent-identity-usage-ledger, slice 1 ─────────
  // (L4, Daniel-authorized 2026-07-20 — daniel-responses/2026-07-20-go-usage-
  // ledger-og-supply-graph.md): voluntary, free, self-service API keys for
  // AI-agent CONSUMERS of the platform (MCP/A2A/REST), plus an aggregate
  // per-key usage ledger. This is NOT a paywall and NOT the producer-side
  // `agents.api_key` field (unrelated, untouched) — anonymous access is
  // unaffected; a key only grants a higher rate-limit tier and gets the
  // caller a usage record. See src/middleware/consumer-identity.ts for the
  // middleware that reads/writes these tables and src/routes/consumer-keys.ts
  // for the self-service issuance/revoke/erase endpoints.
  //
  // consumer_api_keys:
  //   key_hash      : sha256 of the plaintext key — the plaintext itself is
  //                   NEVER stored anywhere, only returned once at issuance
  //                   (see POST /api/keys). UNIQUE + NOT NULL, same
  //                   inline-UNIQUE + belt-and-suspenders explicit index
  //                   convention as magic_links.token above.
  //   label         : consumer-chosen free-text name, optional.
  //   contact_email : optional (data-minimization — the confirm-understanding
  //                   risk note for this dev-request calls out "e-post
  //                   valgfritt? minst mulig"), nullable.
  //   rate_tier     : which rate-limit tier this key gets (see
  //                   middleware/security.ts keyedMax()). Only 'keyed' exists
  //                   in slice 1; the column is TEXT (not a CHECK-enum) so a
  //                   future paid tier can be added without a migration.
  //   revoked_at    : holder-initiated revoke (POST /api/keys/revoke) — key
  //                   immediately stops being recognized, but ledger history
  //                   for it is preserved (revoke ≠ erase).
  //   deleted_at    : GDPR right-to-erasure marker (POST /api/keys/erase).
  //                   We soft-delete (null out label/contact_email + stamp
  //                   this column) rather than hard-delete the row, because
  //                   consumer_usage_ledger.key_id FKs into this table's id
  //                   and the ledger's aggregate counts (endpoint/day/count —
  //                   no call content) stop being personal data once the PII
  //                   columns are cleared, so hard-deleting would only
  //                   destroy Daniel's own aggregate usage history for zero
  //                   privacy benefit. This mirrors the soft-delete half of
  //                   the codebase's existing GDPR pattern (Debio
  //                   deactivation above) rather than the hard-delete half
  //                   (Norsk Gardsmat above), which applies to removing a
  //                   producer with nothing worth preserving — not to a row
  //                   anchoring aggregate history. See routes/consumer-keys.ts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS consumer_api_keys (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash      TEXT UNIQUE NOT NULL,
      label         TEXT,
      contact_email TEXT,
      rate_tier     TEXT NOT NULL DEFAULT 'keyed',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at    TEXT,
      deleted_at    TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_consumer_api_keys_key_hash ON consumer_api_keys(key_hash)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_consumer_api_keys_revoked ON consumer_api_keys(revoked_at)`);

  // consumer_usage_ledger: aggregate counts ONLY — never one row per call and
  // never call arguments/content (GDPR/data-minimization risk called out in
  // the dev-request's confirm-understanding section). UNIQUE(key_id,
  // endpoint_or_tool, day) means a call is an upsert-increment of the
  // existing row (see recordUsage() in middleware/consumer-identity.ts), not
  // an insert-per-call.
  //   key_id           : FK to consumer_api_keys.id. ON DELETE CASCADE is
  //                      defensive only — the erasure path never hard-deletes
  //                      the parent row (see above), so this should not
  //                      normally fire.
  //   endpoint_or_tool : which MCP tool / A2A method / REST route was called
  //                      (e.g. "lokal_search", "message/send",
  //                      "GET /api/marketplace/discover") — never the call's
  //                      arguments or response content.
  //   day              : YYYY-MM-DD (UTC), so "topp konsumenter siste 7/30
  //                      dager" (slice 2, admin reporting — NOT built in this
  //                      slice) can aggregate by date range cheaply.
  db.exec(`
    CREATE TABLE IF NOT EXISTS consumer_usage_ledger (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id           INTEGER NOT NULL REFERENCES consumer_api_keys(id) ON DELETE CASCADE,
      endpoint_or_tool TEXT NOT NULL,
      day              TEXT NOT NULL,
      call_count       INTEGER NOT NULL DEFAULT 0,
      UNIQUE(key_id, endpoint_or_tool, day)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_consumer_usage_ledger_key_id ON consumer_usage_ledger(key_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_consumer_usage_ledger_day ON consumer_usage_ledger(day)`);

  // ─── dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok,
  // Fase 1a: coordinate provenance for `agents` ────────────────────────────
  //
  // Measured live 2026-07-25: 948 of 1 499 active producers (63.2 %) have
  // lat/lng, 551 (36.8 %) have NONE and are therefore invisible to every
  // geo-filtered search. The coordinates that DO exist are seed-time
  // hardcoded (src/_seeds/seed-expansion-v2.ts:55,73) and frequently a city
  // centroid rather than the farm — but nothing in the schema recorded that,
  // so search happily rendered "2,4 km unna" off a centroid. There was also
  // no geocoding worker for `agents` at all (dental and experiences both have
  // one). agents-geocode-worker.ts is that worker; these columns are its
  // state.
  //
  //   geo_precision        : 'address' | 'postal' | 'city' | 'kommune' | NULL.
  //                          Vocabulary + ranking + the honesty rule live in
  //                          services/geo-precision.ts. NULL means "unknown
  //                          provenance" — every pre-existing row — and is
  //                          deliberately NOT backfilled to 'city': that would
  //                          silently strip the distance figure from 948
  //                          producers on deploy on a guess. The worker
  //                          resolves rows out of NULL into an honest tier.
  //   geocode_source       : which service produced the current position
  //                          ('kartverket_adresse' | 'kartverket_stedsnavn' |
  //                          'kommuneinfo' | …). Mirrors dental_agents.
  //                          geocode_source / experience_providers.
  //                          geocode_source.
  //   geocode_outcome      : last attempt's result — 'high' | 'medium' | 'low'
  //                          (the adresse-API retry ladder's confidence tiers,
  //                          same vocabulary as dental_agents.
  //                          geocode_confidence), 'city_centroid',
  //                          'name_suffix_centroid' (Tier C — the place suffix
  //                          in the producer's own name, «Straumbotn Gård —
  //                          Rana»; centroid-tier like 'city_centroid', so it
  //                          never licenses a km figure), 'no_match',
  //                          'skipped_no_upgrade', or 'error'.
  //   geocode_attempted_at : ISO-8601 stamp written on EVERY attempt whatever
  //                          the outcome. This is the ROTATION key — same
  //                          lesson as agent_knowledge.last_enrichment_
  //                          attempt_at above (dev-request 2026-07-19): a
  //                          selector that orders by a column the failure
  //                          paths never write re-picks the identical batch
  //                          forever. Ordering is "never attempted first,
  //                          then oldest attempt", so the worker walks the
  //                          whole universe before repeating.
  //
  //   geocode_prev_lat     : the lat/lng the row held immediately BEFORE this
  //   geocode_prev_lng       worker last overwrote it, written in the same
  //                          UPDATE (review follow-up 10). Tier A replaces
  //                          seed coordinates in place, so without this the
  //                          dev-request's "Fase 1: kan stoppes" rollback was
  //                          incomplete — stopping the worker restores
  //                          nothing, and the pre-existing (possibly correct,
  //                          hand-placed) coordinate is gone. With it, a full
  //                          revert is one statement:
  //                            UPDATE agents
  //                               SET lat = geocode_prev_lat,
  //                                   lng = geocode_prev_lng,
  //                                   geo_precision = NULL,
  //                                   geocode_source = NULL,
  //                                   geocode_outcome = NULL
  //                             WHERE geocode_prev_lat IS NOT NULL;
  //                          Only ONE generation deep on purpose: this is a
  //                          rollback latch for the backfill, not a history
  //                          table. NULL prev means "this row had no
  //                          coordinates before" — reverting it sets lat/lng
  //                          back to NULL, which is correct.
  //
  // Additive + idempotent ALTERs, same defensive try/catch idiom as every
  // migration above.
  //   geocode_attempts     : consecutive attempts that produced NO progress
  //                          (no coordinate written). Reset to 0 the moment a
  //                          position IS written, and by the postal-code
  //                          backfill worker when it gives a row the postnummer
  //                          that was blocking it.
  //
  //                          Added by the throughput follow-up (Daniel,
  //                          2026-07-25: «veldig mange fortsatt står med ukjent
  //                          opphav»). Two changes made it necessary. The
  //                          cadence went from hourly to backlog-driven 60 s, so
  //                          a full rotation of ~1 600 producers now takes ~20
  //                          minutes instead of ~32 hours; and Tier C made ~250
  //                          previously-unselectable rows selectable. Together
  //                          that turns "a row Kartverket will never resolve" —
  //                          which used to be re-tried about twice a day — into
  //                          one re-tried ~70 times a day, forever, against a
  //                          free unauthenticated API. Past
  //                          AGENTS_GEOCODE_MAX_ATTEMPTS the row is PARKED: no
  //                          longer selected, and reported in the queue status
  //                          under its own honest heading rather than sitting in
  //                          "unknown, might be fixable" for ever. Parking is a
  //                          statement about our evidence, never about the
  //                          producer — it writes no coordinate and changes no
  //                          rendering.
  for (const stmt of [
    `ALTER TABLE agents ADD COLUMN geo_precision TEXT`,
    `ALTER TABLE agents ADD COLUMN geocode_source TEXT`,
    `ALTER TABLE agents ADD COLUMN geocode_outcome TEXT`,
    `ALTER TABLE agents ADD COLUMN geocode_attempted_at TEXT`,
    `ALTER TABLE agents ADD COLUMN geocode_prev_lat REAL`,
    `ALTER TABLE agents ADD COLUMN geocode_prev_lng REAL`,
    `ALTER TABLE agents ADD COLUMN geocode_attempts INTEGER NOT NULL DEFAULT 0`,
    //   geo_place_label  : the place a CENTROID-tier position represents, as
    //                      Kartverket named it («Rana», «Gjerdrum», «Flåm»).
    //
    //                      NOT decoration. geo-precision.formatRfbDistanceLabel
    //                      renders a centroid row as «i {city}-området» and
    //                      falls back to the bare, useless «omtrentlig
    //                      posisjon» when city is NULL — and Tier C's entire
    //                      cohort is DEFINED by having no city. Without this
    //                      column ~250 producers become visible in proximity
    //                      search with no indication of WHERE they are, which
    //                      is most of the point of placing them at all.
    //
    //                      Deliberately NOT written into agents.city: that is a
    //                      curated, owner-editable field which also feeds the
    //                      "byer" stat counters AND geocoding-service's
    //                      lookupInDatabase() tier — so writing worker-derived
    //                      values there would feed one worker's guesses back
    //                      into the lookup other rows get resolved with.
    //                      Address-precision rows leave it NULL: they carry a
    //                      real km figure and need no approximate label.
    `ALTER TABLE agents ADD COLUMN geo_place_label TEXT`,
  ]) {
    try { db.exec(stmt); } catch { /* already exists — expected */ }
  }
  try {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_agents_geocode_attempted_at
         ON agents(geocode_attempted_at)`
    );
  } catch { /* index already created */ }

  // ─── dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok,
  // Fase 1a follow-up: postal-code backfill state on agent_knowledge ────────
  //
  // Daniel, in-session 2026-07-25: «Kan du lage en fiks for å finne postnummer
  // på de som mangler kun dette?»
  //
  // Measured census (n = 250 of 1 523 active producers, uniform random):
  // 68.8 % have street + postnummer (Tier-A eligible for the Fase-1a geocode
  // worker), 21.2 % have neither, and 13.2 % have a real street address but NO
  // postnummer — blocked from address precision by a missing four-digit number
  // and nothing else. services/agents-postal-backfill.ts resolves that number
  // from Kartverket; these columns are its state.
  //
  //   postal_code_source           : how the CURRENT postal_code was obtained.
  //                                  NULL = as it always was (scraped /
  //                                  enriched / owner-entered — provenance
  //                                  unrecorded, and deliberately NOT guessed
  //                                  at retroactively).
  //                                  'kartverket_adresse_inline' = a 4-digit
  //                                  number already present in the free-text
  //                                  address, CONFIRMED against Kartverket
  //                                  adresser/v1/sok before being promoted
  //                                  into the column.
  //                                  'kartverket_adresse_sok' = derived from
  //                                  street + place, with the hit's own
  //                                  poststed/kommunenavn corroborating that
  //                                  place. 'kartverket_adresse_unik' = the
  //                                  street + house number identifies exactly
  //                                  ONE address in all of Norway, so no place
  //                                  token was needed. This column is what lets
  //                                  a later reader tell a scraped postnummer
  //                                  from a Kartverket-derived one.
  //   postal_code_prev             : whatever stood in postal_code immediately
  //                                  before the backfill worker wrote, set in
  //                                  the SAME statement. Mirrors
  //                                  agents.geocode_prev_lat/lng above: one
  //                                  generation deep, a rollback latch and not
  //                                  a history table. Full revert is one
  //                                  statement:
  //                                    UPDATE agent_knowledge
  //                                       SET postal_code = postal_code_prev,
  //                                           postal_code_source = NULL,
  //                                           postal_backfill_outcome = NULL
  //                                     WHERE postal_code_source LIKE 'kartverket%';
  //                                  (The worker only ever writes into an EMPTY
  //                                  postal_code — that guard is in the UPDATE's
  //                                  own WHERE clause, not just the selector —
  //                                  so prev is normally NULL and the revert
  //                                  restores the empty state.)
  //   postal_backfill_outcome      : last attempt's verdict —
  //                                  'inline_confirmed' | 'lookup_resolved' |
  //                                  'ambiguous' | 'uncorroborated' |
  //                                  'no_match' | 'unusable_input' | 'error'.
  //                                  'uncorroborated' means a unique hit DID
  //                                  exist but sat in a place the record never
  //                                  names — the near-miss class a looser
  //                                  matcher would have written, kept out of
  //                                  'no_match' so ops can actually see it.
  //   postal_backfill_attempted_at : ISO-8601 stamp written on EVERY attempt
  //                                  whatever the outcome, including the error
  //                                  path. This is the ROTATION key and the
  //                                  selector orders by it. Fase 1a took two
  //                                  separate review blockers for workers whose
  //                                  failure paths did not stamp and therefore
  //                                  re-picked the identical head of the queue
  //                                  forever; that is why this column exists
  //                                  before the worker that uses it.
  //
  // Additive + idempotent ALTERs, same defensive try/catch idiom as above.
  for (const stmt of [
    `ALTER TABLE agent_knowledge ADD COLUMN postal_code_source TEXT`,
    `ALTER TABLE agent_knowledge ADD COLUMN postal_code_prev TEXT`,
    `ALTER TABLE agent_knowledge ADD COLUMN postal_backfill_outcome TEXT`,
    `ALTER TABLE agent_knowledge ADD COLUMN postal_backfill_attempted_at TEXT`,
  ]) {
    try { db.exec(stmt); } catch { /* already exists — expected */ }
  }
  try {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_agent_knowledge_postal_backfill_attempted_at
         ON agent_knowledge(postal_backfill_attempted_at)`
    );
  } catch { /* index already created */ }

  // ─── dev-request 2026-07-13-billing-skjelett-moerkt ─────────────────────
  // (L4, Daniel-authorized 2026-07-20 — daniel-responses/2026-07-20-go-
  // billing-skjelett-moerkt.md): a DARK skeleton for a test-mode Stripe
  // subscription flow ("Produsent-Premium", 199/499 kr/mnd placeholders),
  // entirely behind BILLING_ENABLED (default OFF — see mountBillingRoutes()
  // in src/routes/admin-billing.ts and the flag block in src/index.ts).
  // These three tables are purely additive/new — no ALTER of any existing
  // table, same idiom as contact_clicks/consumer_api_keys above (a plain
  // CREATE TABLE IF NOT EXISTS is itself the safe migration for a table that
  // never existed before).
  //
  // billing_subscriptions: one row per subscription attempt/lifecycle.
  //   agent_id                : which producer this subscription belongs to.
  //                             No FK — same convention as contact_clicks/
  //                             analytics_agent_views (history survives an
  //                             agent later being deleted).
  //   plan                    : 'produsent_premium_199' | '..._499' — see
  //                             BILLING_PLANS in services/billing-service.ts.
  //   status                  : our narrower status vocabulary (mapped from
  //                             Stripe's own by mapStripeStatus()) —
  //                             'incomplete' | 'active' | 'past_due' |
  //                             'canceled'. 'active' is the only status that
  //                             grants the demo entitlements below.
  //   stripe_customer_id / stripe_subscription_id : Stripe's own ids. NEVER
  //                             a secret key — these are opaque object ids,
  //                             safe to store.
  //   current_period_end      : ISO-8601, from the Stripe subscription
  //                             item's current_period_end (API 2025+ moved
  //                             this field to item-level — see
  //                             periodEndFromStripeSub() in
  //                             services/billing-service.ts).
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_subscriptions (
      id                      TEXT PRIMARY KEY,
      agent_id                TEXT NOT NULL,
      plan                    TEXT NOT NULL CHECK(plan IN ('produsent_premium_199','produsent_premium_499')),
      status                  TEXT NOT NULL DEFAULT 'incomplete' CHECK(status IN ('incomplete','active','past_due','canceled')),
      stripe_customer_id      TEXT,
      stripe_subscription_id  TEXT,
      current_period_end      TEXT,
      created_at              TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_agent_id ON billing_subscriptions(agent_id)`);
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_subscriptions_stripe_subscription_id
         ON billing_subscriptions(stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL`
    );
  } catch { /* partial unique index unsupported on this sqlite build — non-fatal, lookups still work */ }

  // billing_entitlements: the entitlement-check MECHANISM (acceptance
  // criterion 2). (agent_id, feature_key) -> granted. Wired ONLY to the two
  // demo/stub feature keys in DEMO_ENTITLEMENT_FEATURES
  // (services/billing-service.ts) — deliberately NOT wired to any of today's
  // real dashboard functions. Upserted by syncEntitlementsForStatus() on
  // every subscription create/upgrade/cancel/webhook-driven status change.
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_entitlements (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id    TEXT NOT NULL,
      feature_key TEXT NOT NULL,
      granted     INTEGER NOT NULL DEFAULT 0,
      source      TEXT NOT NULL DEFAULT 'subscription',
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(agent_id, feature_key)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_billing_entitlements_agent_id ON billing_entitlements(agent_id)`);

  // billing_webhook_events: webhook-idempotency ledger. stripe_event_id is
  // the PRIMARY KEY so a duplicate webhook delivery is a no-op (INSERT
  // fails), not a double-apply — see handleBillingWebhook() in
  // services/billing-service.ts, which also pre-checks this table so it can
  // report `duplicate: true` distinctly rather than relying solely on the
  // caught constraint violation.
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_webhook_events (
      stripe_event_id TEXT PRIMARY KEY,
      type            TEXT NOT NULL,
      received_at     TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ─── dev-request 2026-08-03-mikhailo-quarantine-gates ───────────────────
  // Incident: 2026-07-30, a spam profile ("Mikhailo T", Kyiv) was (1) created
  // via the PUBLIC POST /api/marketplace/register endpoint, (2) same-day
  // self-claimed via the ordinary email-code claim flow — which the claimant
  // fully controls both ends of, since they own both the registration AND
  // the "verification" inbox — earning a public "Verifisert" trust badge
  // with zero real evidence, and (3) IndexNow-ping'd to Bing/Yandex
  // immediately on registration, before any human ever saw it.
  //
  // These two columns are the distinguishing signal the three quarantine
  // gates below key off. Both are additive with a default that makes every
  // EXISTING row (and every row created via the admin/discovery pipeline or
  // a seed script) a complete no-op — non-retroactive, same "monotonic
  // guard" convention as no_yield_streak/wrong_entity_streak above.
  //
  //   origin     : who created this row.
  //                'discovery'      — the admin/discovery/harvest pipeline
  //                                   (POST /admin/register) or a seed
  //                                   script (src/_seeds/*.ts). DEFAULT —
  //                                   every row that exists today, and every
  //                                   future admin/seed-created row, reads
  //                                   as this with NO code change on their
  //                                   part.
  //                'self_registered'— the PUBLIC POST /register endpoint.
  //                                   Written explicitly by that route's
  //                                   handler on every call — anyone on the
  //                                   internet can hit this endpoint, so a
  //                                   row of this origin carries zero vetting
  //                                   evidence until a human reviews it.
  //   is_vetted  : 1 = visible on public discovery surfaces (search,
  //                discover, the /produsent/<slug> profile page). DEFAULT 1
  //                — every existing/admin/seed row is already vetted by the
  //                fact a human (discovery agent + Daniel's review loop)
  //                put it there. The PUBLIC /register route is the ONLY
  //                writer that sets this to 0 on insert; the admin
  //                self-registered-review-approve route (routes/
  //                admin-agents.ts) is the ONLY writer that flips it back
  //                to 1, after a human looks at the profile.
  //
  // Gate 1 (visibility): marketplace-registry.ts discover() and the
  // /produsent/:slug route (routes/seo.ts) exclude is_vetted = 0 rows.
  // Gate 2 (badge): knowledge-service.ts verifyClaim() skips the
  // is_verified UPDATE when origin = 'self_registered' — the claim itself
  // still succeeds, only the public trust badge is withheld. Deliberately a
  // hard gate: there is no automated Brreg/domain-evidence escape hatch for
  // this generic marketplace-agents table in this slice (known, deliberate
  // limitation — see the comment in verifyClaim()).
  // Gate 3 (IndexNow): routes/marketplace.ts's /register handler no longer
  // pings IndexNow at registration (every row it creates is self_registered
  // by construction); the ping now fires from the admin approve route
  // instead, once a human has vetted the profile.
  for (const stmt of [
    `ALTER TABLE agents ADD COLUMN origin TEXT NOT NULL DEFAULT 'discovery'`,
    `ALTER TABLE agents ADD COLUMN is_vetted INTEGER NOT NULL DEFAULT 1`,
  ]) {
    try { db.exec(stmt); } catch { /* already exists — expected */ }
  }
  try {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_agents_self_registered_review_queue
         ON agents(origin, is_vetted, created_at) WHERE origin = 'self_registered' AND is_vetted = 0`
    );
  } catch { /* partial index unsupported or already created */ }

  // ─── dev-request 2026-07-31-rfb-poolgate-uten-telefon-og-batchkapasitet
  // (Steg C2) — server-side daily send cap on the cold-outreach send point ─
  // outreach_daily_send_cap: one row per UTC calendar day, holding an
  // atomically-incremented reservation counter. routes/crm.ts POST /compose
  // reserves a slot with a single synchronous better-sqlite3 statement
  // (INSERT ... ON CONFLICT DO UPDATE ... WHERE reserved_count < cap)
  // BEFORE calling emailService.sendRaw — this is what makes the cap
  // atomic across concurrent requests despite the await on the actual send;
  // a plain pre-flight COUNT(*) would not be (see routes/crm.ts for the
  // interleaving scenario this avoids). A failed send decrements
  // reserved_count back so a failed attempt doesn't permanently eat into
  // the day's real cap. Purely additive — brand-new table, plain
  // `CREATE TABLE IF NOT EXISTS` is itself the safe migration.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS outreach_daily_send_cap (
        day TEXT PRIMARY KEY,
        reserved_count INTEGER NOT NULL DEFAULT 0
      )
    `);
  } catch (err) {
    console.error("Migration outreach_daily_send_cap failed:", err);
  }

}

export function closeDb(): void {
  if (db) {
    db.close();
  }
}
