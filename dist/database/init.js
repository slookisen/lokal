"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDb = getDb;
exports.closeDb = closeDb;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const path_1 = __importDefault(require("path"));
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
const DB_PATH = process.env.DB_PATH || path_1.default.join(__dirname, "../../data/lokal.db");
let db;
function getDb() {
    if (!db) {
        // Ensure data directory exists
        const dir = path_1.default.dirname(DB_PATH);
        const fs = require("fs");
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        db = new better_sqlite3_1.default(DB_PATH);
        // Performance tuning:
        // Try WAL mode first (best perf), fall back to DELETE if filesystem doesn't support it
        try {
            db.pragma("journal_mode = WAL");
        }
        catch {
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
function initSchema(db) {
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
  `);
}
function closeDb() {
    if (db) {
        db.close();
    }
}
//# sourceMappingURL=init.js.map