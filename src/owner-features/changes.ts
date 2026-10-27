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
  OWNER_FEATURE_REGISTRY,
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
// Spec «Grensesnitt»: «Bare synlig» = standard, «Aktiv» = anbefalt
// (bestillinger med betaling ved henting + månedsrapport), «Full fart»
// (forhåndsbetaling der mulig, ukentlig produktsynk, SMS, pilot, omtale).
// A level is a preset over the keys the spec names. Applying it only touches
// entries that are `live`; coming_soon (or unknown) keys are skipped silently.

export type OwnerLevelKey = "bare_synlig" | "aktiv" | "full_fart";

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
      no: "Folk og AI-assistenter finner deg. Ingen bestillinger eller plikter.",
      en: "People and AI assistants find you. No orders or duties.",
    },
    recommended: false,
    values: [
      ["orders.enabled", false],
      ["payments.prepay", false],
      ["products.weekly_sync", false],
      ["notify.order_sms", false],
      ["comms.beta", false],
      ["comms.featured", false],
    ],
  },
  {
    key: "aktiv",
    label: { no: "Aktiv", en: "Active" },
    description: {
      no: "Ta imot bestillinger med betaling ved henting, og få en rapport hver måned.",
      en: "Accept orders paid at pickup, and get a monthly report.",
    },
    recommended: true,
    values: [
      ["orders.enabled", true],
      ["payments.prepay", false],
      ["notify.report", "monthly"],
      ["products.weekly_sync", false],
      ["notify.order_sms", false],
      ["comms.beta", false],
      ["comms.featured", false],
    ],
  },
  {
    key: "full_fart",
    label: { no: "Full fart", en: "Full speed" },
    description: {
      no: "Alt i «Aktiv», pluss forhåndsbetaling der det er mulig, ukentlig produktsynk, SMS, nye funksjoner først og omtale fra oss.",
      en: "Everything in “Active”, plus prepayment where possible, weekly product sync, SMS, new features first and being featured by us.",
    },
    recommended: false,
    values: [
      ["orders.enabled", true],
      ["payments.prepay", true],
      ["notify.report", "monthly"],
      ["products.weekly_sync", true],
      ["notify.order_sms", true],
      ["comms.beta", true],
      ["comms.featured", true],
    ],
  },
];

export const OWNER_LEVEL_CUSTOM_LABEL: LocalizedText = { no: "Egendefinert", en: "Custom" };

export function findOwnerLevel(key: unknown): OwnerLevel | undefined {
  return OWNER_LEVELS.find((l) => l.key === key);
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

/** What choosing a level would change (read-only; the confirm panel). */
export function previewOwnerLevel(
  vertical: OwnerFeatureVertical,
  subjectId: string,
  levelKey: string,
  opts: OwnerFeatureOptions = {},
): OwnerLevelPreview | null {
  const level = findOwnerLevel(levelKey);
  if (!level) return null;
  const registry = opts.registry ?? OWNER_FEATURE_REGISTRY;
  const resolved = resolveOwnerFeatures(vertical, subjectId, { ...opts, registry });
  const changes: OwnerLevelPreview["changes"] = [];
  const skipped: OwnerLevelPreview["skipped"] = [];
  for (const [e, to] of liveLevelValues(level, registry)) {
    const r = resolved.byKey[e.key];
    if (!r || sameValue(r.value, to)) continue;
    if (!r.changeable && r.block !== "requirement_not_met") {
      skipped.push({ key: e.key, reason: r.reason ?? { no: "Kan ikke endres nå.", en: "Cannot be changed now." } });
    } else if (r.block === "requirement_not_met" && to !== false) {
      skipped.push({ key: e.key, reason: r.reason ?? { no: "Et krav er ikke oppfylt.", en: "A requirement is not met." } });
    } else {
      changes.push({ key: e.key, from: r.value, to });
    }
  }
  return { level, changes, skipped };
}

/**
 * The level the owner is on now: the last level they chose when its live keys
 * still match, else the first level whose live keys all match, else "custom"
 * («Egendefinert»). Levels with no live key never match.
 */
export function currentOwnerLevel(
  vertical: OwnerFeatureVertical,
  subjectId: string,
  resolved: ResolvedOwnerFeatures,
  opts: OwnerFeatureOptions = {},
): OwnerLevelKey | "custom" {
  const registry = opts.registry ?? OWNER_FEATURE_REGISTRY;
  const matches = (l: OwnerLevel) => {
    const live = liveLevelValues(l, registry);
    return live.length > 0 && live.every(([e, v]) => sameValue(resolved.byKey[e.key]?.value, v));
  };
  const db = opts.db ?? getDb();
  try {
    const last = db
      .prepare(
        `SELECT level FROM owner_feature_change_batch
          WHERE vertical = ? AND subject_id = ? AND kind = 'level' AND undone_at IS NULL
          ORDER BY id DESC LIMIT 1`,
      )
      .get(vertical, subjectId) as { level?: string } | undefined;
    const chosen = last?.level ? findOwnerLevel(last.level) : undefined;
    if (chosen && matches(chosen)) return chosen.key;
  } catch { /* table missing → fall through to the plain match */ }
  for (const l of OWNER_LEVELS) if (matches(l)) return l.key;
  return "custom";
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
}

function maxAuditId(db: any): number {
  const row = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM owner_feature_audit").get() as { m: number };
  return Number(row.m) || 0;
}

/** Records the audit rows written for this subject after `beforeId` as one batch. */
function recordBatch(
  db: any,
  vertical: string,
  subjectId: string,
  beforeId: number,
  kind: OwnerChangeBatch["kind"],
  level: string | null,
  actor: OwnerActor,
): number | null {
  const range = db
    .prepare(
      `SELECT MIN(id) AS lo, MAX(id) AS hi, COUNT(*) AS n FROM owner_feature_audit
        WHERE vertical = ? AND subject_id = ? AND id > ?`,
    )
    .get(vertical, subjectId, beforeId) as { lo: number | null; hi: number | null; n: number };
  if (!range.n || range.lo == null || range.hi == null) return null;
  const info = db
    .prepare(
      `INSERT INTO owner_feature_change_batch
         (vertical, subject_id, kind, level, first_audit_id, last_audit_id, actor_detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(vertical, subjectId, kind, level, range.lo, range.hi, actor.detail ?? null, new Date().toISOString());
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
    const result = setOwnerFeatureValue(vertical, subjectId, key, value, actor, o);
    const batchId = result.kind === "ok" && result.changed ? recordBatch(db, vertical, subjectId, before, "single", null, actor) : null;
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
  opts: OwnerFeatureOptions = {},
): ApplyOwnerLevelResult {
  const level = findOwnerLevel(levelKey);
  if (!level) return { kind: "unknown_level" };
  const registry = opts.registry ?? OWNER_FEATURE_REGISTRY;
  const db = opts.db ?? getDb();
  const o = { ...opts, db, registry };
  return db.transaction((): ApplyOwnerLevelResult => {
    const before = maxAuditId(db);
    const changed: string[] = [];
    const skipped: Array<{ key: string; reason: LocalizedText }> = [];
    for (const [e, value] of liveLevelValues(level, registry)) {
      const out = setOwnerFeatureValue(vertical, subjectId, e.key, value, actor, o);
      if (out.kind === "not_found") return { kind: "not_found" };
      if (out.kind === "ok") {
        if (out.changed) changed.push(e.key);
      } else if (out.kind === "blocked" || out.kind === "invalid_value") {
        skipped.push({ key: e.key, reason: out.reason });
      }
    }
    const batchId = changed.length ? recordBatch(db, vertical, subjectId, before, "level", level.key, actor) : null;
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
 * Reverts batch `batchId` as one unit, newest audit row first, through
 * setOwnerFeatureValue (so each revert writes its own audit row). Only the
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
  const registry = opts.registry ?? OWNER_FEATURE_REGISTRY;
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
      for (const r of rows) {
        let oldValue: OwnerFeatureValue = null;
        try { oldValue = r.old_json == null ? null : JSON.parse(r.old_json); } catch { throw new UndoAbort({ kind: "changed_since", key: r.key }); }
        const out = setOwnerFeatureValue(vertical, subjectId, r.key, oldValue, actor, o);
        if (out.kind === "blocked" || out.kind === "invalid_value") throw new UndoAbort({ kind: "blocked", key: r.key, reason: out.reason });
        if (out.kind !== "ok") throw new UndoAbort({ kind: "not_undoable" });
      }
      const undoBatch = recordBatch(db, vertical, subjectId, before, "undo", batch.level, actor);
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
  const registry = opts.registry ?? OWNER_FEATURE_REGISTRY;
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
    const out = setOwnerFeatureValue(vertical, subjectId, OWNER_INTRO_KEY, answer === "yes", actor, o);
    const applied = out.kind === "ok" && out.changed;
    const batchId = applied ? recordBatch(db, vertical, subjectId, before, "single", null, actor) : null;
    return { kind: "ok" as const, stored: true, applied, batchId };
  })();
}
