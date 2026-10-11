// ─── FTS5 trigram index for the public name search ──────────────────────
// S3 of dev-request 2026-10-09-rfb-grunnmur-wal-backup-fts-spillbok (A2A).
//
// discover()'s name search (marketplace-registry.ts) loaded EVERY public agent
// row and kept those whose `name.toLowerCase()` contains each query word. That
// is linear in the catalog. This index only decides WHICH rows are loaded:
// the same public predicate and the same JS filters/sorting still run on the
// candidates, so the answer is the same as the full scan.
//
//   - tokenize 'trigram': substring match for terms of >= 3 characters
//     ("dyrøy" finds "Dyrøymat"), case-folded, diacritics KEPT ("gard" does
//     not match "gård" — the JS `includes` does not either).
//   - Own copy of (agent_id, name), not external content keyed on rowid:
//     agents has `id TEXT PRIMARY KEY`, so its rowid is implicit and VACUUM
//     may renumber it.
//   - Plain-SQL triggers keep it in sync for every connection (no JS
//     functions, which a worker thread's connection would not have).
//   - Superset by construction. SQLite's fold agrees with JS toLowerCase()
//     for every code point up to U+017F (Latin-1 + Latin Extended-A: æøåäöüé
//     …) EXCEPT "İ": JS lowercases it to "i" + U+0307, SQLite leaves it as is.
//     It disagrees for ~400 letters in other scripts (Cherokee, Georgian
//     Mtavruli, newer Latin/Cyrillic additions, several astral scripts).
//     So only words made of U+0021–U+007E / U+00A1–U+017F go to FTS; a word
//     ending in "i" also searches the "…İ" spelling (only a word's LAST "i"
//     can line up with an "İ" in JS, the U+0307 that follows never occurs
//     in such a word). Any other word is left to the JS filter (strict
//     path) or forces the full scan (any-word path).
//
// Kill switch: RFB_NAME_FTS=0 → full scan as before; table and triggers stay.
// Rollback: drop the TRIGGERS before the table — a trigger whose body names a
// missing table makes every write to agents fail:
//   DROP TRIGGER IF EXISTS agents_name_fts_ai; DROP TRIGGER IF EXISTS agents_name_fts_ad;
//   DROP TRIGGER IF EXISTS agents_name_fts_au; DROP TABLE IF EXISTS agents_name_fts;
//
// PURE (type-only import), so marketplace-registry.ts can use it without
// breaching its rfb-vertical isolation (same rule as geo-distance.ts).

import type Database from "better-sqlite3";

export const NAME_FTS_TABLE = "agents_name_fts";

/** False only when RFB_NAME_FTS=0. */
export function isNameFtsEnabled(): boolean {
  return process.env.RFB_NAME_FTS !== "0";
}

const FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS ${NAME_FTS_TABLE} USING fts5(agent_id UNINDEXED, name, tokenize = 'trigram')`;

// The UPDATE trigger only fires when id or name really changed, so a write
// that re-sets the same name costs nothing. A REPLACE that deletes an old row
// fires no DELETE trigger (recursive_triggers is off) and leaves a stale extra
// entry — harmless (candidates are re-checked against agents) and removed by
// syncAgentsNameFts (boot + nightly), because the row counts then differ.
const TRIGGER_DDL = [
  `CREATE TRIGGER IF NOT EXISTS agents_name_fts_ai AFTER INSERT ON agents BEGIN
     INSERT INTO ${NAME_FTS_TABLE}(agent_id, name) VALUES (new.id, new.name);
   END`,
  `CREATE TRIGGER IF NOT EXISTS agents_name_fts_ad AFTER DELETE ON agents BEGIN
     DELETE FROM ${NAME_FTS_TABLE} WHERE agent_id = old.id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS agents_name_fts_au AFTER UPDATE OF id, name ON agents
   WHEN old.id IS NOT new.id OR old.name IS NOT new.name BEGIN
     DELETE FROM ${NAME_FTS_TABLE} WHERE agent_id = old.id;
     INSERT INTO ${NAME_FTS_TABLE}(agent_id, name) VALUES (new.id, new.name);
   END`,
];

let unavailableLogged = false;
let queryFailureLogged = false;

/** Logs the first failed FTS query of the process; the caller falls back to the full scan. */
export function noteNameFtsQueryFailure(err: unknown): void {
  if (queryFailureLogged) return;
  queryFailureLogged = true;
  console.error(`[name-fts] FTS query failed, name search uses the full scan: ${(err as Error)?.message ?? err}`);
}

export interface NameFtsSyncResult {
  agents: number;
  indexed: number;
  rebuilt: boolean;
  ms: number;
  error?: string;
}

/**
 * Rebuilds the index when its row count differs from agents (empty included):
 * one DELETE + INSERT … SELECT in a transaction. Boot (via ensure) and the
 * nightly auto-prune tick. Never throws.
 */
export function syncAgentsNameFts(db: Database.Database): NameFtsSyncResult {
  const t0 = performance.now();
  try {
    const agents = (db.prepare("SELECT COUNT(*) AS c FROM agents").get() as { c: number }).c;
    const indexed = (db.prepare(`SELECT COUNT(*) AS c FROM ${NAME_FTS_TABLE}`).get() as { c: number }).c;
    if (agents === indexed) return { agents, indexed, rebuilt: false, ms: performance.now() - t0 };
    db.transaction(() => {
      db.exec(`DELETE FROM ${NAME_FTS_TABLE}`);
      db.exec(`INSERT INTO ${NAME_FTS_TABLE}(agent_id, name) SELECT id, name FROM agents`);
    })();
    return { agents, indexed, rebuilt: true, ms: performance.now() - t0 };
  } catch (err) {
    return { agents: -1, indexed: -1, rebuilt: false, ms: performance.now() - t0, error: (err as Error)?.message ?? String(err) };
  }
}

/**
 * Migration (database/init.ts): table + triggers if missing, then populate if
 * empty or out of step. Table and triggers are created in one transaction, so
 * there is never a table without its triggers. When FTS5/trigram is missing
 * it logs once and creates nothing — the search keeps using the full scan.
 */
export function ensureAgentsNameFts(db: Database.Database): NameFtsSyncResult | null {
  try {
    db.transaction(() => {
      db.exec(FTS_DDL);
      for (const ddl of TRIGGER_DDL) db.exec(ddl);
    })();
  } catch (err) {
    if (!unavailableLogged) {
      unavailableLogged = true;
      console.error(`[name-fts] could not create the FTS5 trigram index, name search uses the full scan: ${(err as Error)?.message ?? err}`);
    }
    return null;
  }
  const r = syncAgentsNameFts(db);
  if (r.error) console.error(`[name-fts] populate failed (non-fatal): ${r.error}`);
  else if (r.rebuilt) console.log(`[name-fts] built ${NAME_FTS_TABLE}: ${r.agents} rows (had ${r.indexed}) in ${r.ms.toFixed(1)}ms`);
  return r;
}

// ─── Query helpers ──────────────────────────────────────────────────────

function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Every code point in U+0021–U+007E or U+00A1–U+017F (see header). */
function isFoldSafe(word: string): boolean {
  for (const ch of word) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x21 || (cp > 0x7e && cp < 0xa1) || cp > 0x17f) return false;
  }
  return true;
}

function isFtsWord(word: string): boolean {
  return codePointLength(word) >= 3 && isFoldSafe(word);
}

function phrase(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function term(word: string): string {
  return word.endsWith("i") ? `(${phrase(word)} OR ${phrase(word.slice(0, -1) + "İ")})` : phrase(word);
}

/**
 * MATCH expression for "name contains every word": AND of the words FTS can
 * check; shorter/other words are still enforced by the caller's JS filter.
 * Null when no word qualifies (caller does the full scan). Words must already
 * be lowercased.
 */
export function nameFtsAllWordsMatch(words: string[]): string | null {
  const terms = words.filter(isFtsWord).map(term);
  return terms.length > 0 ? terms.join(" AND ") : null;
}

/**
 * MATCH expression for "name contains at least one word": OR of all words.
 * Null unless EVERY word qualifies — dropping one would lose its rows.
 */
export function nameFtsAnyWordMatch(words: string[]): string | null {
  if (words.length === 0 || !words.every(isFtsWord)) return null;
  return words.map(term).join(" OR ");
}
