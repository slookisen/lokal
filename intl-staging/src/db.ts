// SQLite schema for the SE/DK staging base. This database lives on its own Fly
// volume in its own app (rfb-intl-staging), never inside the prod `lokal` app
// (DPIA T17: the candidate base lies outside prod).
//
// Scope rule (Daniel live 2026-10-13, A2A daniel-responses/2026-10-13-live-se-
// batchjobb-staging.md): only legal persons (AB, HB/KB, ekonomisk förening).
// Nothing here may hold a personnummer or a sole trader's (enskild firma) row —
// the importer drops those in memory and the draft checks refuse them.
import Database from "better-sqlite3";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS register_units (
  unit_id TEXT PRIMARY KEY,
  country TEXT NOT NULL,
  org_nr TEXT NOT NULL,
  name TEXT NOT NULL,
  trade_name TEXT,
  name_norm TEXT NOT NULL,
  legal_form TEXT NOT NULL,
  sni TEXT NOT NULL,
  street TEXT,
  postal_code TEXT,
  postal_town TEXT,
  town_norm TEXT,
  county TEXT,
  ad_block INTEGER NOT NULL DEFAULT 0,
  signal TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  last_seen_import TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_units_town ON register_units(country, town_norm);

CREATE TABLE IF NOT EXISTS candidates (
  candidate_id TEXT PRIMARY KEY REFERENCES register_units(unit_id),
  country TEXT NOT NULL,
  origin TEXT NOT NULL,
  priority INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  status_reason TEXT,
  lease_run_id TEXT,
  lease_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidates_queue ON candidates(country, status, priority, created_at);

CREATE TABLE IF NOT EXISTS drafts (
  draft_id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id),
  builder_run_id TEXT NOT NULL,
  language TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  check_json TEXT NOT NULL,
  status TEXT NOT NULL,
  judge_lease_run_id TEXT,
  judge_lease_expires_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_queue ON drafts(status, created_at);

CREATE TABLE IF NOT EXISTS excerpts (
  excerpt_id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL,
  url TEXT NOT NULL,
  text TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_excerpts_candidate ON excerpts(candidate_id);
CREATE INDEX IF NOT EXISTS idx_excerpts_expiry ON excerpts(expires_at);

CREATE TABLE IF NOT EXISTS verdicts (
  verdict_id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL REFERENCES drafts(draft_id),
  judge_run_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  entity_match INTEGER NOT NULL,
  direct_sale_ok INTEGER NOT NULL,
  language_ok INTEGER NOT NULL,
  personal_data_found INTEGER NOT NULL,
  excerpt_verified INTEGER,
  field_results_json TEXT NOT NULL,
  reasons TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outcomes (
  outcome_id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS optout (
  key_hash TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(file: string): DB {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  // Cap the WAL so a long import cannot balloon the volume (DPIA T17 note).
  db.pragma("journal_size_limit = 67108864");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Schema migrations keyed on PRAGMA user_version. SCHEMA above is version 1;
// a later column goes in as `if (v < 2) { ALTER TABLE …; }` so an existing
// volume gets it too (CREATE TABLE IF NOT EXISTS never alters a table).
const SCHEMA_VERSION = 1;
function migrate(db: DB): void {
  const v = db.pragma("user_version", { simple: true }) as number;
  if (v < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

/** Case-folds Swedish text for search (SQLite's NOCASE only folds ASCII). */
export function norm(s: string | null | undefined): string {
  return (s || "").toLocaleLowerCase("sv-SE").replace(/\s+/g, " ").trim();
}

export function getMeta(db: DB, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function deleteMeta(db: DB, key: string): void {
  db.prepare("DELETE FROM meta WHERE key = ?").run(key);
}
