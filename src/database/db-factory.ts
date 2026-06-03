// ─── DB Factory — Phase 6 (PR-89) ───────────────────────────────────
//
// Vertical → DB-handle abstraction. Designed to migrate to Postgres
// later via config flip — for now we just open one SQLite file per
// vertical and cache the handle.
//
// CRITICAL ISOLATION INVARIANT (Daniel-req 2026-05-27):
//   - `rfb` ALWAYS returns the existing rfb handle from src/database/init.ts.
//     This module MUST NOT mutate, re-open, or alter that DB in any way.
//   - Any other vertical opens its OWN file at /app/data/<vertical>.db.
//     A code-bug in dental-store.ts can write/delete arbitrarily inside
//     /app/data/dental.db, but cannot touch /app/data/lokal.db — they're physically
//     different files on the same volume.
//
// See PHASE6-ARCH-DECISION-SEPARATE-DB.md (Option B) for full rationale.

import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";

// Import existing rfb DB getter — DO NOT modify it.
// We re-export through this factory only — callers that already
// use init.ts directly are unaffected.
import { getDb as getRfbDb } from "./init";

// Schema-initialiser for the dental DB. Lazy-required below to avoid
// pulling in dental schema code when only rfb is requested.
import { initDentalSchema } from "./init-dental";

export type DbBackend = "sqlite"; // 'postgres' later
export type DbHandle = Database.Database;

// In-process cache. Key = vertical_id, Value = open handle.
// rfb is NOT cached here — we always delegate to init.ts's own cache.
const handles = new Map<string, DbHandle>();

/**
 * Return a DB handle for the given vertical.
 *
 * - `rfb` → delegates to src/database/init.ts (unchanged path).
 * - any other vertical → opens /app/data/<vertical>.db (or the path
 *   from `<VERTICAL>_DB_PATH` env, useful in test/dev).
 *
 * First call for a non-rfb vertical triggers schema-init. Subsequent
 * calls return the cached handle.
 */
export function getDb(vertical: string): DbHandle {
  if (vertical === "rfb") {
    // Delegate — init.ts owns its own cache + pragmas. We never
    // create or replace this handle.
    return getRfbDb();
  }

  const cached = handles.get(vertical);
  if (cached) return cached;

  // Resolve path: env override first, otherwise /app/data/<vertical>.db
  // (the Fly persistent volume mount — see fly.toml [[mounts]] destination).
  // In dev/test you typically set DENTAL_DB_PATH=./data/dental.db
  // (or :memory: for unit tests).
  const envKey = `${vertical.toUpperCase()}_DB_PATH`;
  const dbPath = process.env[envKey] || `/app/data/${vertical}.db`;

  // Ensure parent dir exists (mirrors init.ts behaviour).
  // Skip for :memory: which has no filesystem path.
  if (dbPath !== ":memory:") {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(dbPath);
  console.log(`[db-factory] vertical=${vertical} opened at ${dbPath}`);

  // Performance + safety pragmas. WAL falls back to DELETE on
  // filesystems that don't support it (Windows mount points etc.) —
  // same defensive pattern as init.ts.
  try {
    db.pragma("journal_mode = WAL");
  } catch {
    console.log(
      `[${vertical}] WAL mode not supported on this filesystem, using DELETE journal mode`
    );
    db.pragma("journal_mode = DELETE");
  }
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -64000");
  db.pragma("foreign_keys = ON");

  // Vertical-specific schema-init. Add new verticals here.
  if (vertical === "dental") {
    initDentalSchema(db);
  } else {
    // Defensive: unknown verticals get an empty DB. We log so it's
    // obvious in boot logs if someone calls getDb('xyz') by mistake.
    console.log(
      `[db-factory] WARN: unknown vertical '${vertical}' — opened empty DB at ${dbPath}`
    );
  }

  handles.set(vertical, db);
  return db;
}

/**
 * Test-only: clear the handle cache. Used by unit tests that want
 * a fresh in-memory DB per test. Never call from production code.
 */
export function __resetDbFactoryForTesting(): void {
  for (const [, handle] of handles) {
    try {
      handle.close();
    } catch {
      // ignore
    }
  }
  handles.clear();
}

// Re-export the schema-init so src/index.ts can call it explicitly
// on boot when ENABLE_DENTAL=1 (defence-in-depth: dental.db doesn't
// even get opened unless explicitly enabled).
export { initDentalSchema };
