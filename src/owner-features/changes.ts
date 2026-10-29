// ─── «Mine valg» — levels, undo, change log, first-login card ───────────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, slice S2b. Server-side
// logic behind the owner page (./page.ts, routes/owner-features.ts). Every
// write goes through setOwnerFeatureValue (./resolve.ts) — the same code path
// as a single PUT /api/owner/:id/features/:key — so locks, requirements,
// coming_soon and the one-audit-row-per-change rule hold for levels and undo
// too. A page change is recorded as one owner_feature_change_batch row that
// points at the contiguous owner_feature_audit id range it wrote; «Angre»
// reverts the newest batch as one unit.

import { getDb } from "../database/init";
import {
  ownerFeatureRegistryFor,
  findOwnerFeature,
  type LocalizedText,
  type OwnerFeatureEntry,
  type OwnerFeatureValue,
  type OwnerFeatureVertical,
} from "./registry";
import {
  resolveOwnerFeatures,
  setOwnerFeatureValue,
  type OwnerFeatureOptions,
  type ResolvedOwnerFeatures,
} from "./resolve";

export type OwnerActor = { actor: "owner" | "admin" | "cs" | "system"; detail?: string | null };

// ── Levels («Hvor aktiv vil du være?») ─────────────────────────────────────
// S2e (v2 principle 3, «Ærlige nivåer»): exactly two levels — «Bare synlig»
// and «Ta imot bestillinger». «Aktiv» and «Full fart» are gone from the page
// (they did the same, and «Full fart» could not be chosen); a third level
// comes only when there is something real to put in it (separate decision).
// A level is a preset over live keys: applying it only touches entries that
// are `live`; coming_soon (or unknown) keys are skipped silently.
// Stored level choices from S2b («aktiv» / «full_fart» in
// owner_feature_change_batch.level) read as «Ta imot bestillinger»; nothing
// is rewritten and no switch changes because of the new model.

export type OwnerLevelKey = "bare_synlig" | "ta_imot_bestillinger" | "ta_imot_besok";

export interface OwnerLevel {
  key: OwnerLevelKey;
  label: LocalizedText;
  description: LocalizedText;
  recommended: boolean;
  /** Applied in this order (a key another one requires comes first). */
  values: Array<[string, OwnerFeatureValue]>;
}

export const OWNER_LEVELS: OwnerLevel[] = [
  {
    key: "bare_synlig",
    label: { no: "Bare synlig", en: "Just visible" },
    description: {
      no: "Folk og AI-assistenter finner deg og får kontaktinformasjonen din. Ingen bestillinger å svare på.",
      en: "People and AI assistants find you and get your contact details. No orders to answer.",
    },
    recommended: false,
    values: [
      ["orders.enabled", false],
    ],
  },
  {
    key: "ta_imot_bestillinger",
    label: { no: "Ta imot bestillinger", en: "Accept orders" },
    description: {
      no: "Kunder og AI-assistenter kan sende deg bestillinger på henting. Kunden betaler når varene hentes.",
      en: "Customers and AI assistants can send you pickup orders. The customer pays when the goods are picked up.",
    },
    recommended: false,
    values: [
      ["orders.enabled", true],
    ],
  },
];

/**
 * Opplevagent gårdssalg (dev-request 2026-10-22-opplevagent-mine-valg-
 * gardssalg, v2 principle 3): the same two honest levels, «Bare synlig» and
 * «Ta imot besøk». «Full fart» does not exist here. A preset over live keys
 * only (booking.enabled ↔ booking_live).
 */
export const GARDSSALG_OWNER_LEVELS: OwnerLevel[] = [
  {
    key: "bare_synlig",
    label: { no: "Bare synlig", en: "Just visible" },
    description: {
      no: "Gjester og AI-assistenter finner deg og får kontaktinformasjonen din. Ingen forespørsler å svare på.",
      en: "Guests and AI assistants find you and get your contact details. No requests to answer.",
    },
    recommended: false,
    values: [
      ["booking.enabled", false],
    ],
  },
  {
    key: "ta_imot_besok",
    label: { no: "Ta imot besøk", en: "Accept visits" },
    description: {
      no: "Gjester og AI-assistenter kan be om å komme på besøk. Du svarer på e-post, og besøket skjer hos dere.",
      en: "Guests and AI assistants can ask to visit you. You answer by e-mail, and the visit takes place at your premises.",
    },
    recommended: false,
    values: [
      ["booking.enabled", true],
    ],
  },
];

/** The levels for a vertical. */
export function ownerLevelsFor(vertical: OwnerFeatureVertical): OwnerLevel[] {
  return vertical === "gardssalg" ? GARDSSALG_OWNER_LEVELS : OWNER_LEVELS;
}

/** S2b level keys that are stored in owner_feature_change_batch.level → the v2 level they mean. */
export const LEGACY_OWNER_LEVEL_ALIASES: Readonly<Record<string, OwnerLevelKey>> = {
  aktiv: "ta_imot_bestillinger",
  full_fart: "ta_imot_bestillinger",
};

export const OWNER_LEVEL_CUSTOM_LABEL: LocalizedText = { no: "Egendefinert", en: "Custom" };

/** Level options: `levels` is injectable for tests (fixture presets); defaults to OWNER_LEVELS. */
export type OwnerLevelOptions = OwnerFeatureOptions & { levels?: readonly OwnerLevel[] };

/** A v2 level key, or a stored S2b key («aktiv» / «full_fart») read as its v2 level. */
export function findOwnerLevel(key: unknown, levels: readonly OwnerLevel[] = OWNER_LEVELS): OwnerLevel | undefined {
  if (typeof key !== "string") return undefined;
  const direct = levels.find((l) => l.key === key);
  if (direct) return direct;
  const alias = Object.prototype.hasOwnProperty.call(LEGACY_OWNER_LEVEL_ALIASES, key) ? LEGACY_OWNER_LEVEL_ALIASES[key] : undefined;
  return alias ? levels.find((l) => l.key === alias) : undefined;
}

function sameValue(a: OwnerFeatureValue | undefined, b: OwnerFeatureValue | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The level's preset restricted to entries that exist and are `live`. */
function liveLevelValues(level: OwnerLevel, registry: OwnerFeatureEntry[]): Array<[OwnerFeatureEntry, OwnerFeatureValue]> {
  const out: Array<[OwnerFeatureEntry, OwnerFeatureValue]> = [];
  for (const [key, value] of level.values) {
    const e = findOwnerFeature(key, registry);
    if (e && e.status === "live") out.push([e, value]);
  }
  return out;
}

export interface OwnerLevelPreview {
  level: OwnerLevel;
  changes: Array<{ key: string; from: OwnerFeatureValue; to: OwnerFeatureValue }>;
  skipped: Array<{ key: string; reason: LocalizedText }>;
}

class PreviewRollback extends Error {
  constructor(readonly out: ApplyOwnerLevelResult) { super("preview rollback"); }
}

/**
 * What choosing a level would change (the confirm panel). Runs the real
 * applyOwnerLevel inside a transaction that is always rolled back, so the
 * preview equals what a confirmed apply does (requirements switched on
 * earlier in the same preset included). Nothing is kept.
 */
export function previewOwnerLevel(
  vertical: OwnerFeatureVertical,
  subjectId: string,
  levelKey: string,
  opts: OwnerLevelOptions = {},
): OwnerLevelPreview | null {
  const level = findOwnerLevel(levelKey, opts.levels ?? ownerLevelsFor(vertical));
  if (!level) return null;
  const registry = opts.registry ?? ownerFeatureRegistryFor(vertical);
  const db = opts.db ?? getDb();
  const o = { ...opts, db, registry };
  const before = resolveOwnerFeatures(vertical, subjectId, o);
  let out: ApplyOwnerLevelResult | null = null;
  try {
    db.transaction(() => {
      throw new PreviewRollback(applyOwnerLevel(vertical, subjectId, level.key, { actor: "system", detail: "preview" }, o));
    })();
  } catch (e) {
    if (!(e instanceof PreviewRollback)) throw e;
    out = e.out;
  }
  if (!out || out.kind !== "ok") return { level, changes: [], skipped: [] };
  const target = new Map(level.values);
  return {
    level,
    changes: out.changed.map((key) => ({ key, from: before.byKey[key]?.value ?? null, to: target.get(key) ?? null })),
    skipped: out.skipped,
  };
}

/** The owner's own level choice (owner_feature_level_choice), or null. */
export function readOwnerLevelChoice(
  vertical: string,
  subjectId: string,
  db: any = getDb(),
): { level: string; chosen_at: string; batch_id: number | null } | null {
  try {
    const row = db
      .prepare(`SELECT level, chosen_at, batch_id FROM owner_feature_level_choice WHERE vertical = ? AND subject_id = ?`)
      .get(vertical, subjectId) as { level: string; chosen_at: string; batch_id: number | null } | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * The level the owner is on now (v2 principle 3): a level is shown as chosen
 * ONLY when the owner chose it themselves — the owner_feature_level_choice
 * row (written by applyOwnerLevel for actor "owner" only), or, for choices
 * made before S2e, the newest not-undone level batch whose audit rows the
 * owner wrote. Never because an admin, the test-producer arming or a single
 * switch set the keys. While the chosen level's live keys still match it is
 * the current level; once the owner changed a switch since, "custom"
 * («Egendefinert»). No owner choice → null (no level marked). A stored
 * «aktiv» / «full_fart» reads as «Ta imot bestillinger».
 */
export function currentOwnerLevel(
  vertical: OwnerFeatureVertical,
  subjectId: string,
  resolved: ResolvedOwnerFeatures,
  opts: OwnerLevelOptions = {},
): OwnerLevelKey | "custom" | null {
  const registry = opts.registry ?? ownerFeatureRegistryFor(vertical);
  const matches = (l: OwnerLevel) => {
    const live = liveLevelValues(l, registry);
    return live.length > 0 && live.every(([e, v]) => sameValue(resolved.byKey[e.key]?.value, v));
  };
  const db = opts.db ?? getDb();
  let levelKey: string | undefined = readOwnerLevelChoice(vertical, subjectId, db)?.level;
  if (!levelKey) {
    try {
      const last = db
        .prepare(
          `SELECT b.level AS level FROM owner_feature_change_batch b
            WHERE b.vertical = ? AND b.subject_id = ? AND b.kind = 'level' AND b.undone_at IS NULL
              AND EXISTS (SELECT 1 FROM owner_feature_audit a
                           WHERE a.vertical = b.vertical AND a.subject_id = b.subject_id
                             AND a.id BETWEEN b.first_audit_id AND b.last_audit_id AND a.actor = 'owner')
            ORDER BY b.id DESC LIMIT 1`,
        )
        .get(vertical, subjectId) as { level?: string } | undefined;
      levelKey = last?.level;
    } catch {
      levelKey = undefined; /* table missing → no owner choice known */
    }
  }
  const chosen = levelKey ? findOwnerLevel(levelKey, opts.levels ?? ownerLevelsFor(vertical)) : undefined;
  if (!chosen) return null;
  return matches(chosen) ? chosen.key : "custom";
}

// ── Batches ────────────────────────────────────────────────────────────────

export interface OwnerChangeBatch {
  id: number;
  vertical: string;
  subject_id: string;
  kind: "single" | "level" | "undo";
  level: string | null;
  first_audit_id: number;
  last_audit_id: number;
  actor_detail: string | null;
  created_at: string;
  undone_at: string | null;
  undone_by_batch: number | null;
  /** JSON array: keys that had no owner_feature_settings row before this batch. */
  new_row_keys: string | null;
}

function maxAuditId(db: any): number {
  const row = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM owner_feature_audit").get() as { m: number };
  return Number(row.m) || 0;
}

/** Keys that have an owner_feature_settings row for this subject now. */
function explicitRowKeys(db: any, vertical: string, subjectId: string): Set<string> {
  const rows = db
    .prepare(`SELECT key FROM owner_feature_settings WHERE vertical = ? AND subject_id = ?`)
    .all(vertical, subjectId) as Array<{ key: string }>;
  return new Set(rows.map((r) => r.key));
}

/**
 * Records the audit rows written for this subject after `beforeId` as one
 * batch. `priorRows` (the settings rows before the change) lets «Angre»
 * remove a row the change created instead of storing the default explicitly.
 */
function recordBatch(
  db: any,
  vertical: string,
  subjectId: string,
  beforeId: number,
  kind: OwnerChangeBatch["kind"],
  level: string | null,
  actor: OwnerActor,
  priorRows: Set<string> | null = null,
): number | null {
  const range = db
    .prepare(
      `SELECT MIN(id) AS lo, MAX(id) AS hi, COUNT(*) AS n FROM owner_feature_audit
        WHERE vertical = ? AND subject_id = ? AND id > ?`,
    )
    .get(vertical, subjectId, beforeId) as { lo: number | null; hi: number | null; n: number };
  if (!range.n || range.lo == null || range.hi == null) return null;
  let newRowKeys: string | null = null;
  if (priorRows) {
    const now = explicitRowKeys(db, vertical, subjectId);
    const created = [...now].filter((k) => !priorRows.has(k));
    newRowKeys = JSON.stringify(created);
  }
  const info = db
    .prepare(
      `INSERT INTO owner_feature_change_batch
         (vertical, subject_id, kind, level, first_audit_id, last_audit_id, actor_detail, created_at, new_row_keys)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(vertical, subjectId, kind, level, range.lo, range.hi, actor.detail ?? null, new Date().toISOString(), newRowKeys);
  return Number(info.lastInsertRowid);
}

export function getOwnerChangeBatch(vertical: string, subjectId: string, id: number, db: any = getDb()): OwnerChangeBatch | null {
  const row = db
    .prepare(`SELECT * FROM owner_feature_change_batch WHERE id = ? AND vertical = ? AND subject_id = ?`)
    .get(id, vertical, subjectId) as OwnerChangeBatch | undefined;
  return row ?? null;
}

/** The newest batch, when it can be undone (not an undo, not undone). */
export function latestUndoableBatch(vertical: string, subjectId: string, db: any = getDb()): OwnerChangeBatch | null {
  const row = db
    .prepare(`SELECT * FROM owner_feature_change_batch WHERE vertical = ? AND subject_id = ? ORDER BY id DESC LIMIT 1`)
    .get(vertical, subjectId) as OwnerChangeBatch | undefined;
  if (!row || row.kind === "undo" || row.undone_at) return null;
  return row;
}

/** Keys a batch changed, in the order they were written. */
export function batchKeys(batch: OwnerChangeBatch, db: any = getDb()): string[] {
  const rows = db
    .prepare(
      `SELECT key FROM owner_feature_audit WHERE vertical = ? AND subject_id = ? AND id BETWEEN ? AND ? ORDER BY id`,
    )
    .all(batch.vertical, batch.subject_id, batch.first_audit_id, batch.last_audit_id) as Array<{ key: string }>;
  return rows.map((r) => r.key);
}

// ── Single change (one switch on the page) ─────────────────────────────────

/** setOwnerFeatureValue + the batch row, in one transaction. */
export function applyOwnerSingleChange(
  vertical: OwnerFeatureVertical,
  subjectId: string,
  key: string,
  value: unknown,
  actor: OwnerActor,
  opts: OwnerFeatureOptions = {},
): { result: ReturnType<typeof setOwnerFeatureValue>; batchId: number | null } {
  const db = opts.db ?? getDb();
  const o = { ...opts, db };
  return db.transaction(() => {
    const before = maxAuditId(db);
    const prior = explicitRowKeys(db, vertical, subjectId);
    const result = setOwnerFeatureValue(vertical, subjectId, key, value, actor, o);
    const batchId = result.kind === "ok" && result.changed ? recordBatch(db, vertical, subjectId, before, "single", null, actor, prior) : null;
    return { result, batchId };
  })();
}

// ── Level apply ────────────────────────────────────────────────────────────

export type ApplyOwnerLevelResult =
  | { kind: "unknown_level" }
  | { kind: "not_found" }
  | {
      kind: "ok";
      level: OwnerLevel;
      batchId: number | null;
      changed: string[];
      skipped: Array<{ key: string; reason: LocalizedText }>;
    };

/**
 * Applies a level's preset. Only live keys are touched; each goes through
 * setOwnerFeatureValue, so a lock or unmet requirement skips that key (with
 * its reason) and every real change writes one audit row. One transaction,
 * one batch row (none when nothing changed).
 */
export function applyOwnerLevel(
  vertical: OwnerFeatureVertical,
  subjectId: string,
  levelKey: string,
  actor: OwnerActor,
  opts: OwnerLevelOptions = {},
): ApplyOwnerLevelResult {
  const level = findOwnerLevel(levelKey, opts.levels ?? ownerLevelsFor(vertical));
  if (!level) return { kind: "unknown_level" };
  const registry = opts.registry ?? ownerFeatureRegistryFor(vertical);
  const db = opts.db ?? getDb();
  const o = { ...opts, db, registry };
  return db.transaction((): ApplyOwnerLevelResult => {
    const before = maxAuditId(db);
    const prior = explicitRowKeys(db, vertical, subjectId);
    const changed: string[] = [];
    const skipped: Array<{ key: string; reason: LocalizedText }> = [];
    for (const [e, value] of liveLevelValues(level, registry)) {
      // Locked at the level's value already: nothing to do, nothing to report.
      // (A key that is off only because a requirement is off still gets the
      // explicit off, so it stays off when the requirement comes back.)
      const now = resolveOwnerFeatures(vertical, subjectId, o).byKey[e.key];
      if (now && sameValue(now.value, value) && !now.changeable && now.block !== "requirement_not_met") continue;
      const out = setOwnerFeatureValue(vertical, subjectId, e.key, value, actor, o);
      if (out.kind === "not_found") return { kind: "not_found" };
      if (out.kind === "ok") {
        if (out.changed) changed.push(e.key);
      } else if (out.kind === "blocked" || out.kind === "invalid_value") {
        skipped.push({ key: e.key, reason: out.reason });
      }
    }
    const batchId = changed.length ? recordBatch(db, vertical, subjectId, before, "level", level.key, actor, prior) : null;
    // S2e: the owner's own choice is remembered (also when nothing changed),
    // so the page marks this level — and only after an owner choice. A level
    // that could not fully apply (a key skipped for a lock or an unmet
    // requirement) is not recorded as chosen.
    if (actor.actor === "owner" && skipped.length === 0) {
      db.prepare(
        `INSERT INTO owner_feature_level_choice (vertical, subject_id, level, chosen_at, actor_detail, batch_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(vertical, subject_id) DO UPDATE SET
           level = excluded.level, chosen_at = excluded.chosen_at, actor_detail = excluded.actor_detail, batch_id = excluded.batch_id`,
      ).run(vertical, subjectId, level.key, new Date().toISOString(), actor.detail ?? null, batchId);
    }
    return { kind: "ok", level, batchId, changed, skipped };
  })();
}

// ── Undo («Angre») ─────────────────────────────────────────────────────────

export type UndoOwnerChangeResult =
  | { kind: "not_undoable" }
  | { kind: "changed_since"; key: string }
  | { kind: "blocked"; key: string; reason: LocalizedText }
  | { kind: "ok"; batchId: number | null; keys: string[] };

class UndoAbort extends Error {
  constructor(readonly out: UndoOwnerChangeResult) { super("undo aborted"); }
}

/**
 * Reverts batch `batchId` as one unit through setOwnerFeatureValue (so each
 * revert writes its own audit row). Reverts run newest first and are retried
 * until no more succeed, so a key whose requirement is restored later in the
 * same batch is reverted after it (in either direction). A settings row the
 * batch created is removed again (only explicit choices are stored). Only the
 * newest batch can be undone, and only while none of its keys has changed
 * since (a later audit row, or a column changed outside the page) — then
 * nothing is written. All or nothing: one transaction.
 */
export function undoOwnerChange(
  vertical: OwnerFeatureVertical,
  subjectId: string,
  batchId: number,
  actor: OwnerActor,
  opts: OwnerFeatureOptions = {},
): UndoOwnerChangeResult {
  const registry = opts.registry ?? ownerFeatureRegistryFor(vertical);
  const db = opts.db ?? getDb();
  const o = { ...opts, db, registry };
  try {
    return db.transaction((): UndoOwnerChangeResult => {
      const batch = latestUndoableBatch(vertical, subjectId, db);
      if (!batch || batch.id !== batchId) return { kind: "not_undoable" };
      const rows = db
        .prepare(
          `SELECT id, key, old_json, new_json FROM owner_feature_audit
            WHERE vertical = ? AND subject_id = ? AND id BETWEEN ? AND ? ORDER BY id DESC`,
        )
        .all(vertical, subjectId, batch.first_audit_id, batch.last_audit_id) as Array<{ id: number; key: string; old_json: string | null; new_json: string | null }>;
      if (rows.length === 0) return { kind: "not_undoable" };

      const resolved = resolveOwnerFeatures(vertical, subjectId, o);
      const seen = new Set<string>();
      for (const r of rows) {
        if (seen.has(r.key)) continue;
        seen.add(r.key);
        const later = db
          .prepare(`SELECT COUNT(*) AS n FROM owner_feature_audit WHERE vertical = ? AND subject_id = ? AND key = ? AND id > ?`)
          .get(vertical, subjectId, r.key, batch.last_audit_id) as { n: number };
        let newValue: OwnerFeatureValue = null;
        try { newValue = r.new_json == null ? null : JSON.parse(r.new_json); } catch { return { kind: "changed_since", key: r.key }; }
        const now = resolved.byKey[r.key];
        if (later.n > 0 || !now || !sameValue(now.value, newValue)) return { kind: "changed_since", key: r.key };
      }

      const before = maxAuditId(db);
      let pending = rows;
      while (pending.length) {
        const next: typeof rows = [];
        let lastBlock: UndoOwnerChangeResult | null = null;
        for (const r of pending) {
          let oldValue: OwnerFeatureValue = null;
          try { oldValue = r.old_json == null ? null : JSON.parse(r.old_json); } catch { throw new UndoAbort({ kind: "changed_since", key: r.key }); }
          const out = setOwnerFeatureValue(vertical, subjectId, r.key, oldValue, actor, o);
          if (out.kind === "ok") continue;
          if (out.kind === "blocked" || out.kind === "invalid_value") {
            next.push(r);
            lastBlock = { kind: "blocked", key: r.key, reason: out.reason };
            continue;
          }
          throw new UndoAbort({ kind: "not_undoable" });
        }
        if (next.length === pending.length) throw new UndoAbort(lastBlock ?? { kind: "not_undoable" });
        pending = next;
      }
      // Rows this batch created go away again (owner rows only, never an admin lock).
      let created: string[] = [];
      try { created = batch.new_row_keys ? JSON.parse(batch.new_row_keys) : []; } catch { created = []; }
      for (const k of Array.isArray(created) ? created : []) {
        if (!seen.has(k)) continue;
        db.prepare(`DELETE FROM owner_feature_settings WHERE vertical = ? AND subject_id = ? AND key = ? AND admin_locked = 0 AND set_by = 'owner'`)
          .run(vertical, subjectId, k);
      }
      const undoBatch = recordBatch(db, vertical, subjectId, before, "undo", batch.level, actor);
      // S2e: undoing the level change the owner chose withdraws that choice.
      if (batch.kind === "level") {
        db.prepare(`DELETE FROM owner_feature_level_choice WHERE vertical = ? AND subject_id = ? AND batch_id = ?`)
          .run(vertical, subjectId, batch.id);
      }
      db.prepare(`UPDATE owner_feature_change_batch SET undone_at = ?, undone_by_batch = ? WHERE id = ?`)
        .run(new Date().toISOString(), undoBatch, batch.id);
      return { kind: "ok", batchId: undoBatch, keys: [...seen] };
    })();
  } catch (e) {
    if (e instanceof UndoAbort) return e.out;
    throw e;
  }
}

// ── Change log ─────────────────────────────────────────────────────────────

export interface OwnerChangeLogRow {
  id: number;
  key: string;
  old_value: OwnerFeatureValue;
  new_value: OwnerFeatureValue;
  actor: string;
  at: string;
  /** Written by «Angre». */
  undo: boolean;
}

export const OWNER_CHANGE_LOG_PAGE_SIZE = 20;

function parseJson(raw: string | null): OwnerFeatureValue {
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** The owner's change log (owner_feature_audit), newest first, one page. */
export function ownerFeatureChangeLog(
  vertical: string,
  subjectId: string,
  page: number,
  db: any = getDb(),
  pageSize: number = OWNER_CHANGE_LOG_PAGE_SIZE,
): { rows: OwnerChangeLogRow[]; total: number; page: number; pages: number } {
  const total = Number((db
    .prepare(`SELECT COUNT(*) AS n FROM owner_feature_audit WHERE vertical = ? AND subject_id = ?`)
    .get(vertical, subjectId) as { n: number }).n) || 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const raw = db
    .prepare(
      `SELECT id, key, old_json, new_json, actor, at FROM owner_feature_audit
        WHERE vertical = ? AND subject_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .all(vertical, subjectId, pageSize, (p - 1) * pageSize) as Array<{ id: number; key: string; old_json: string | null; new_json: string | null; actor: string; at: string }>;
  let undoRanges: Array<{ lo: number; hi: number }> = [];
  try {
    undoRanges = (db
      .prepare(`SELECT first_audit_id AS lo, last_audit_id AS hi FROM owner_feature_change_batch WHERE vertical = ? AND subject_id = ? AND kind = 'undo'`)
      .all(vertical, subjectId) as Array<{ lo: number; hi: number }>);
  } catch { undoRanges = []; }
  const rows = raw.map((r) => ({
    id: r.id,
    key: r.key,
    old_value: parseJson(r.old_json),
    new_value: parseJson(r.new_json),
    actor: r.actor,
    at: r.at,
    undo: undoRanges.some((u) => r.id >= u.lo && r.id <= u.hi),
  }));
  return { rows, total, page: p, pages };
}

// ── First-login card («Nyheter og tips») ───────────────────────────────────

export function readOwnerIntro(vertical: string, subjectId: string, db: any = getDb()): { answer: "yes" | "no"; answered_at: string } | null {
  const row = db
    .prepare(`SELECT answer, answered_at FROM owner_feature_intro WHERE vertical = ? AND subject_id = ?`)
    .get(vertical, subjectId) as { answer: "yes" | "no"; answered_at: string } | undefined;
  return row ?? null;
}

export const OWNER_INTRO_KEY = "comms.news";

/**
 * Stores the first-login answer once (the row = the consent record with its
 * time; the card is not shown again). When comms.news is live, a «ja» is
 * also applied as the owner's explicit choice through setOwnerFeatureValue
 * (audit row + batch, so it can be undone). While comms.news is coming_soon
 * only the answer is stored — nothing is sent either way.
 */
export function answerOwnerIntro(
  vertical: OwnerFeatureVertical,
  subjectId: string,
  answer: "yes" | "no",
  actor: OwnerActor,
  opts: OwnerFeatureOptions = {},
): { kind: "ok"; stored: boolean; applied: boolean; batchId: number | null } {
  const registry = opts.registry ?? ownerFeatureRegistryFor(vertical);
  const db = opts.db ?? getDb();
  const o = { ...opts, db, registry };
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO owner_feature_intro (vertical, subject_id, answer, answered_at, actor_detail)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(vertical, subject_id) DO NOTHING`,
      )
      .run(vertical, subjectId, answer, new Date().toISOString(), actor.detail ?? null);
    if (info.changes === 0) return { kind: "ok" as const, stored: false, applied: false, batchId: null };
    const e = findOwnerFeature(OWNER_INTRO_KEY, registry);
    if (!e || e.status !== "live") return { kind: "ok" as const, stored: true, applied: false, batchId: null };
    const before = maxAuditId(db);
    const prior = explicitRowKeys(db, vertical, subjectId);
    const out = setOwnerFeatureValue(vertical, subjectId, OWNER_INTRO_KEY, answer === "yes", actor, o);
    const applied = out.kind === "ok" && out.changed;
    const batchId = applied ? recordBatch(db, vertical, subjectId, before, "single", null, actor, prior) : null;
    return { kind: "ok" as const, stored: true, applied, batchId };
  })();
}
