// ─── «Mine valg» — the switch probe («bryterprobe») ─────────────────────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, slice S2d-3. Binding
// spec (Daniel): against the hidden test producer, through the owner write
// path, switch every `live` entry off and on, probe every surface in its
// `surfaces` (as-public for the visibility surfaces), check the change in the
// change log, and restore everything to the starting point. One row per key ×
// surface × direction (PASS/FAIL, observed value, time to effect). Plus:
// unmet requirement → 409 and no effect; locked choices cannot be turned off;
// the levels give the same effect as the single switches; «Angre» restores the
// effect; coming_soon entries cannot be changed (409, no effect). Time to
// effect over 60 min is FAIL. 100 % PASS is required before
// ready_for_daniel_test.
//
// The routine that runs it cannot log in as an owner (the magic link goes to
// e-mail), so the probe runs in-process behind an admin route
// (routes/admin-owner-features-switch-probe.ts):
//   writes   setOwnerFeatureValue / applyOwnerSingleChange / applyOwnerLevel /
//            undoOwnerChange — exactly what PUT /api/owner/:id/features/:key
//            and the «Mine valg» page call (validation, locks, requirements,
//            audit). Actor `admin`, actor_detail `switch-probe`. The result
//            kind maps to the PUT route's HTTP status (blocked → 409 …).
//   effects  the surface's own code path, read-only:
//            visibility surfaces  the real route handlers / MCP tools / feeds,
//                                 run inside runAsPublicView() («Vis som
//                                 offentlig», the same context the as-public
//                                 middleware opens), as internal admin traffic
//            order_gate           cart-service isEligibleForRealOrder()
//            email:order_*        order-notify resolveOrderNotificationRecipient()
//                                 — the send decision only, NOTHING is sent
//            job:order_followups  the same decision the job's reminder step takes
//            job:knowledge_write  knowledgeService.upsertKnowledge() as a
//                                 non-owner write on an owner-locked field,
//                                 inside a transaction that is always rolled back
//            job:rfb_enrichment_nightly  loadRfbEnrichmentCohort() (read-only)
//            email:outreach       avmeld unsubscribeHeaderValues() — the header
//                                 decision a cold send uses; nothing is sent
//   restore  the fixture's stored choices (owner_feature_settings rows, the
//            adapter columns, the pause row, the level choice, the first-login
//            answer) are snapshotted first and restored exactly in `finally`;
//            the result says `restored` and lists any difference.
// Only the hidden fixture (origin='test_fixture' AND catalog_hidden=1) in the
// OWNER_FEATURES_ALLOWED_SUBJECTS allowlist is ever written: the owner writes
// go through setOwnerFeatureValue for that subject id, and every UPDATE /
// DELETE this file issues on owner state (restore, the rolled-back checks)
// repeats the fixture pin in its own WHERE clause. The one other kind of
// write: the public read paths the readers run log their own rows (A2A
// `tasks`, `analytics_agent_views`). The probe captures only the rows written
// in the SYNCHRONOUS part of one of its own handler / tool calls (Node runs
// nothing else in between): `tasks` by rowid + id, views by rowid + agent_id
// (= the fixture). At the end it deletes exactly those rows, each by
// `rowid = ? AND id = ?` / `rowid = ? AND agent_id = <fixture>`, never a range
// or a whole table. A row a read path writes after an `await` is not captured:
// it stays (a leak, never an over-delete). `side_effects.left_after_run`
// counts the fixture's rows from the run window that are still there (an
// indicator: it can include another admin's as-public views of the fixture).

import { getDb } from "../database/init";
import {
  OWNER_FEATURE_REGISTRY,
  findOwnerFeature,
  type OwnerFeatureEntry,
  type OwnerFeatureValue,
} from "./registry";
import {
  resolveOwnerFeatures,
  setOwnerFeatureValue,
  type ResolvedOwnerFeatures,
  type SetOwnerFeatureResult,
} from "./resolve";
import {
  OWNER_LEVELS,
  applyOwnerLevel,
  applyOwnerSingleChange,
  ownerFeatureChangeLog,
  undoOwnerChange,
  type OwnerActor,
} from "./changes";
import { isSubjectAllowedForOwnerFeatures } from "./allowlist";

const VERTICAL = "rfb" as const;
export const SWITCH_PROBE_ACTOR: OwnerActor = { actor: "admin", detail: "switch-probe" };
const RESTORE_ACTOR_DETAIL = "switch-probe:restore";
export const SWITCH_PROBE_FIXTURE_ORIGIN = "test_fixture";
/** Spec: time to effect over 60 min is FAIL (caches). */
export const SWITCH_PROBE_EFFECT_MAX_MS = 60 * 60 * 1000;
export const SWITCH_PROBE_DEFAULT_MAX_WAIT_MS = 2000;
export const SWITCH_PROBE_MAX_WAIT_CAP_MS = 30_000;
const POLL_MS = 100;
/** Surfaces that rebuild a whole catalogue view per read: polled at most every 2 s. */
const HEAVY_POLL_MS = 2000;
const HEAVY_SURFACES = new Set(["listing_html", "sitemap", "llms", "acp_feed"]);
/** List surfaces (ranking / sampling): «on» needs at least one endpoint. Every other surface needs all. */
const LIST_SURFACES = new Set(["listing_html", "mcp_search", "acp_feed", "leaderboard"]);
/** Tables the public read paths write to (A2A task log, profile views). */
export const SWITCH_PROBE_SIDE_EFFECT_TABLES = ["tasks", "analytics_agent_views"] as const;
const HANDLER_TIMEOUT_MS = 20_000;
const FIXTURE_PIN = `origin = '${SWITCH_PROBE_FIXTURE_ORIGIN}' AND catalog_hidden = 1`;

/** Env flags the probe reports (a `live` key's effect depends on some of them). */
export const SWITCH_PROBE_ENV_FLAGS = [
  "OWNER_FEATURES_ENFORCE",
  "OWNER_PAUSE_ENABLED",
  "OWNER_VISIBILITY_ENFORCE_BY_ID",
  "OWNER_LOCK_ENFORCE_WRITES",
  "OUTREACH_UNSUBSCRIBE_ENABLED",
  "OWNER_ORDER_EMAIL_ENABLED",
  "RFB_DISABLE_ORDER_FOLLOWUPS",
  "PUBLIC_STATS_MIN_VIEWS",
] as const;

/**
 * Rows whose effect only exists with an env flag on (review follow-ups of
 * S4-2a): with the flag off the key is not really live in this environment,
 * so the row is FAIL with that reason.
 */
export const SWITCH_PROBE_FLAG_DEPENDENCIES: Readonly<Record<string, string>> = {
  "auto.guarantee × job:knowledge_write": "OWNER_LOCK_ENFORCE_WRITES",
  "comms.unsubscribe × email:outreach": "OUTREACH_UNSUBSCRIBE_ENABLED",
};
const FLAG_OFF_REASON = "flag off in this environment";

export type ProbeVerdict = "PASS" | "FAIL";
export type ProbeDirection = "off" | "on" | "parent_off" | "parent_on";

export interface SwitchProbeRow {
  key: string;
  surface: string;
  direction: ProbeDirection;
  result: ProbeVerdict;
  /** What the surface showed (no e-mail addresses). */
  observed: string;
  expected: string;
  /** From the write to the observed effect; null = no effect seen / not applicable. */
  ms_to_effect: number | null;
  /** HTTP status the owner PUT would have answered for the write of this step. */
  write_status: number | null;
  /** The write is in owner_feature_audit and the owner's change log (null = no write expected). */
  change_logged: boolean | null;
  /**
   * false = the reader is expected to show the same thing before and after
   * (a refused write): a reader that never changes would also pass, so the
   * row is not proof that the surface reacts to the switch.
   */
  discriminating: boolean;
  reason?: string;
}

export interface SwitchProbeCheck {
  check: string;
  key?: string;
  result: ProbeVerdict;
  observed: string;
  reason?: string;
}

export interface SwitchProbePlanRow {
  key: string;
  surface: string;
  direction: ProbeDirection;
  kind: "switch" | "locked" | "guarantee" | "confirm_by_email";
  reader: boolean;
}

export interface SwitchProbePlan {
  agent_id: string;
  segment: string;
  allowlisted: boolean;
  env_flags: Record<string, string | null>;
  baseline: Array<{ key: string; status: string; type: string; value: OwnerFeatureValue | string; source: string; block: string | null }>;
  rows: SwitchProbePlanRow[];
  checks: string[];
}

export interface SwitchProbeResult {
  ok: boolean;
  dry_run: boolean;
  agent_id: string;
  started_at: string;
  finished_at: string;
  env_flags: Record<string, string | null>;
  rows: SwitchProbeRow[];
  checks: SwitchProbeCheck[];
  pass: number;
  fail: number;
  restored: boolean;
  restore_diff: Array<{ table: string; before: unknown; after: unknown }>;
  /** Rows the readers' public read paths logged (captured by rowid) and how many the probe removed again. */
  side_effects: SideEffectCount[];
  ready_for_daniel_test: boolean;
  error?: string;
  markdown: string;
}

// ── Fixture selection ─────────────────────────────────────────────────────

export type FixtureSelection =
  | { ok: true; agentId: string }
  | { ok: false; status: number; error: string; detail: string; ids?: string[] };

/**
 * The ONE row the probe may touch: `agent_id` given → it must be the fixture
 * (origin='test_fixture' AND catalog_hidden=1); none given → the single fixture
 * row. Either way it must be in OWNER_FEATURES_ALLOWED_SUBJECTS. Read-only.
 */
export function selectSwitchProbeFixture(db: any, agentId: string | undefined, env: NodeJS.ProcessEnv = process.env): FixtureSelection {
  let id: string;
  if (agentId !== undefined) {
    const row = db.prepare(`SELECT id, origin, catalog_hidden FROM agents WHERE id = ?`).get(agentId) as
      | { id: string; origin: string | null; catalog_hidden: number | null } | undefined;
    if (!row) return { ok: false, status: 404, error: "agent_not_found", detail: "Fant ingen produsent med denne id-en. Ingenting er endret." };
    if (row.origin !== SWITCH_PROBE_FIXTURE_ORIGIN || row.catalog_hidden !== 1) {
      return {
        ok: false, status: 409, error: "not_a_test_fixture",
        detail: "Bryterproben kjører bare mot raden med origin='test_fixture' AND catalog_hidden=1. Ingenting er endret.",
      };
    }
    id = row.id;
  } else {
    const rows = db.prepare(`SELECT id FROM agents WHERE ${FIXTURE_PIN} ORDER BY created_at, id`).all() as Array<{ id: string }>;
    if (rows.length === 0) return { ok: false, status: 404, error: "no_test_fixture", detail: "Ingen testprodusent (origin='test_fixture' AND catalog_hidden=1). Ingenting er endret." };
    if (rows.length > 1) {
      return { ok: false, status: 409, error: "multiple_test_fixtures", detail: "Oppgi agent_id. Ingenting er endret.", ids: rows.map((r) => r.id) };
    }
    id = rows[0].id;
  }
  if (!isSubjectAllowedForOwnerFeatures(VERTICAL, id, env)) {
    return {
      ok: false, status: 409, error: "not_allowlisted",
      detail: "Testprodusenten står ikke i OWNER_FEATURES_ALLOWED_SUBJECTS (rfb:<id>). Ingenting er endret.",
    };
  }
  return { ok: true, agentId: id };
}

// ── Small helpers ─────────────────────────────────────────────────────────

function envFlags(env: NodeJS.ProcessEnv): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const k of SWITCH_PROBE_ENV_FLAGS) out[k] = env[k] ?? null;
  return out;
}

function flagOn(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name];
  return v === "1" || v === "true";
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Never print an e-mail address in the report (it lands in a git repo). */
export function maskEmail(v: unknown): string {
  if (typeof v !== "string" || !v.includes("@")) return String(v);
  const [local, domain] = v.split("@");
  return `${(local || "").slice(0, 1)}***@${domain || ""}`;
}

/** A copy with every string that holds an e-mail address masked. */
export function maskDeep<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? null), (_k, x) => (typeof x === "string" && /[^\s@]+@[^\s@]+/.test(x) ? maskEmail(x) : x));
}

function displayValue(e: OwnerFeatureEntry | undefined, v: OwnerFeatureValue): OwnerFeatureValue | string {
  return e && e.type === "email" && typeof v === "string" ? maskEmail(v) : v;
}

/** The PUT /api/owner/:id/features/:key status for a write result. */
export function putStatusFor(r: SetOwnerFeatureResult): number {
  switch (r.kind) {
    case "unknown_key":
    case "not_found":
      return 404;
    case "invalid_value":
      return 400;
    case "blocked":
      return 409;
    case "ok":
      return 200;
  }
}

function caseId(key: string, surface: string): string {
  return `${key} × ${surface}`;
}

type EntryKind = SwitchProbePlanRow["kind"];

function entryKind(e: OwnerFeatureEntry): EntryKind | null {
  if (e.confirmByEmail) return "confirm_by_email";
  if (e.type === "switch") return "switch";
  if (e.type === "locked") return "locked";
  if (e.type === "guarantee") return "guarantee";
  return null;
}

function directionsFor(kind: EntryKind, baseline: OwnerFeatureValue): ProbeDirection[] {
  switch (kind) {
    case "switch":
      // Away from the starting point first, then back: the run ends where it began.
      return baseline === false ? ["on", "off"] : ["off", "on"];
    case "locked":
      return ["off", "on", "parent_off", "parent_on"];
    case "guarantee":
    case "confirm_by_email":
      return ["off", "on"];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Snapshot / exact restore ──────────────────────────────────────────────

interface FixtureSnapshot {
  owner_feature_settings: any[];
  agents: any;
  owner_profile_pause: any[];
  owner_feature_level_choice: any[];
  owner_feature_intro: any[];
  agent_knowledge: any;
}

function tableExists(db: any, name: string): boolean {
  return !!db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

export function snapshotFixture(db: any, agentId: string): FixtureSnapshot {
  const rows = (table: string, where: string, ...params: unknown[]) =>
    tableExists(db, table) ? (db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY rowid`).all(...params) as any[]) : [];
  return {
    owner_feature_settings: rows("owner_feature_settings", "vertical = ? AND subject_id = ?", VERTICAL, agentId),
    agents: db.prepare(`SELECT order_notifications_opt_in, order_notification_email, is_verified, claimed_at FROM agents WHERE id = ?`).get(agentId) ?? null,
    owner_profile_pause: rows("owner_profile_pause", "agent_id = ?", agentId),
    owner_feature_level_choice: rows("owner_feature_level_choice", "vertical = ? AND subject_id = ?", VERTICAL, agentId),
    owner_feature_intro: rows("owner_feature_intro", "vertical = ? AND subject_id = ?", VERTICAL, agentId),
    agent_knowledge: tableExists(db, "agent_knowledge")
      ? db.prepare(`SELECT about, curated_fields FROM agent_knowledge WHERE agent_id = ?`).get(agentId) ?? null
      : null,
  };
}

function diffSnapshots(a: FixtureSnapshot, b: FixtureSnapshot): Array<{ table: string; before: unknown; after: unknown }> {
  const out: Array<{ table: string; before: unknown; after: unknown }> = [];
  for (const k of Object.keys(a) as Array<keyof FixtureSnapshot>) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push({ table: k, before: a[k], after: b[k] });
  }
  return out;
}

function insertRows(db: any, table: string, rows: any[]): void {
  for (const r of rows) {
    const cols = Object.keys(r);
    db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => r[c]));
  }
}

function invalidatePublicCaches(): void {
  try {
    const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
    marketplaceRegistry._agentsCache = null;
    marketplaceRegistry._statsCache = null;
    marketplaceRegistry._agentsCacheTime = 0;
    marketplaceRegistry._statsCacheTime = 0;
  } catch { /* best-effort */ }
  try {
    (require("../routes/seo") as typeof import("../routes/seo")).invalidateSitemapCache();
  } catch { /* best-effort */ }
}

/**
 * Puts the snapshot back exactly (one transaction, every write pinned to the
 * fixture). Keys whose resolved value this changes get one audit row
 * (actor admin, detail switch-probe:restore), so the change log shows it.
 */
function restoreSnapshot(db: any, agentId: string, snap: FixtureSnapshot): void {
  const pinned = `SELECT id FROM agents WHERE id = ? AND ${FIXTURE_PIN}`;
  db.transaction(() => {
    if (!db.prepare(pinned).get(agentId)) throw new Error("restore refused: the row is no longer the test fixture");
    const before = resolveOwnerFeatures(VERTICAL, agentId, { db });
    db.prepare(`DELETE FROM owner_feature_settings WHERE vertical = ? AND subject_id IN (${pinned})`).run(VERTICAL, agentId);
    insertRows(db, "owner_feature_settings", snap.owner_feature_settings);
    if (snap.agents) {
      db.prepare(`UPDATE agents SET order_notifications_opt_in = ?, order_notification_email = ?, is_verified = ?, claimed_at = ? WHERE id = ? AND ${FIXTURE_PIN}`)
        .run(snap.agents.order_notifications_opt_in, snap.agents.order_notification_email, snap.agents.is_verified, snap.agents.claimed_at, agentId);
    }
    if (tableExists(db, "owner_profile_pause")) {
      db.prepare(`DELETE FROM owner_profile_pause WHERE agent_id IN (${pinned})`).run(agentId);
      insertRows(db, "owner_profile_pause", snap.owner_profile_pause);
    }
    if (tableExists(db, "owner_feature_level_choice")) {
      db.prepare(`DELETE FROM owner_feature_level_choice WHERE vertical = ? AND subject_id IN (${pinned})`).run(VERTICAL, agentId);
      insertRows(db, "owner_feature_level_choice", snap.owner_feature_level_choice);
    }
    if (tableExists(db, "owner_feature_intro")) {
      db.prepare(`DELETE FROM owner_feature_intro WHERE vertical = ? AND subject_id IN (${pinned})`).run(VERTICAL, agentId);
      insertRows(db, "owner_feature_intro", snap.owner_feature_intro);
    }
    if (snap.agent_knowledge) {
      db.prepare(`UPDATE agent_knowledge SET about = ?, curated_fields = ? WHERE agent_id IN (${pinned})`)
        .run(snap.agent_knowledge.about, snap.agent_knowledge.curated_fields, agentId);
    }
    const after = resolveOwnerFeatures(VERTICAL, agentId, { db });
    const now = new Date().toISOString();
    for (const f of after.features) {
      const b = before.byKey[f.key];
      if (!b || sameValue(b.value, f.value)) continue;
      const e = findOwnerFeature(f.key);
      if (!e || e.status !== "live") continue;
      db.prepare(
        `INSERT INTO owner_feature_audit (vertical, subject_id, key, old_json, new_json, actor, actor_detail, at)
         VALUES (?, ?, ?, ?, ?, 'admin', ?, ?)`,
      ).run(VERTICAL, agentId, f.key, JSON.stringify(b.value ?? null), JSON.stringify(f.value ?? null), RESTORE_ACTOR_DETAIL, now);
    }
  })();
  invalidatePublicCaches();
}

// ── Surface effect readers ────────────────────────────────────────────────

/** One observation: per endpoint, is the effect there (profile shown / mail would go / job runs / promise holds)? */
export interface SurfaceObservation {
  endpoints: Record<string, boolean>;
  detail?: string;
  /** «on» needs every endpoint (single-object surfaces); unset = at least one (list surfaces). */
  requireAll?: boolean;
}

export interface ProbeFixture {
  id: string;
  name: string;
  slug: string;
  citySlug: string;
  categories: string[];
  productName: string | null;
  productId: string | null;
  lat: number | null;
  lng: number | null;
  /** The address a cold send would go to (never printed). */
  outreachEmail: string | null;
}

export interface ProbeReaderContext {
  db: any;
  fixture: ProbeFixture;
  env: NodeJS.ProcessEnv;
  adminKey: string;
  /** Rows the readers' read paths created, per side-effect table: rowid → its pin (tasks.id / views.agent_id). */
  created: Map<string, Map<number, string>>;
}

/** Per side-effect table: the column that pins a captured row besides its rowid. */
const SIDE_EFFECT_PIN: Record<(typeof SWITCH_PROBE_SIDE_EFFECT_TABLES)[number], string> = {
  tasks: "id",
  analytics_agent_views: "agent_id",
};

function maxRowid(db: any, table: string): number {
  try { return Number((db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${table}`).get() as { m: number }).m) || 0; } catch { return -1; }
}

/**
 * Runs the synchronous part of one handler / tool call and records the rowids
 * it created in the side-effect tables. Nothing else runs in between (one
 * thread, better-sqlite3 is synchronous), so these rows are the probe's own.
 */
function captureSync<T>(ctx: ProbeReaderContext, fn: () => T): T {
  const before = SWITCH_PROBE_SIDE_EFFECT_TABLES.map((t) => maxRowid(ctx.db, t));
  try {
    return fn();
  } finally {
    SWITCH_PROBE_SIDE_EFFECT_TABLES.forEach((t, i) => {
      if (before[i] < 0) return;
      const pin = SIDE_EFFECT_PIN[t];
      const ids = ctx.db.prepare(`SELECT rowid AS r, ${pin} AS p FROM ${t} WHERE rowid > ?`).all(before[i]) as Array<{ r: number; p: unknown }>;
      if (ids.length === 0) return;
      let m = ctx.created.get(t);
      if (!m) { m = new Map(); ctx.created.set(t, m); }
      for (const x of ids) m.set(Number(x.r), String(x.p));
    });
  }
}

export interface SideEffectCount {
  table: string;
  /** Rows captured as the probe's own. */
  created: number;
  removed: number;
  /** The fixture's rows from the run window still there after the cleanup (leak indicator). */
  left_after_run: number | null;
}

/** Max rowid per side-effect table at the start of the run (-1 = no table). */
function sideEffectStart(db: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of SWITCH_PROBE_SIDE_EFFECT_TABLES) out[t] = maxRowid(db, t);
  return out;
}

/**
 * Deletes exactly the captured rows: one DELETE per row, by rowid AND its pin
 * (tasks.id — a tasks rowid can be reused, the table has no AUTOINCREMENT —
 * or views.agent_id = the fixture). Never a range, never a whole table.
 */
function removeSideEffects(ctx: ProbeReaderContext, start: Record<string, number>): SideEffectCount[] {
  const out: SideEffectCount[] = [];
  const fixtureId = ctx.fixture?.id ?? null;
  for (const t of SWITCH_PROBE_SIDE_EFFECT_TABLES) {
    const rows = [...(ctx.created.get(t) ?? new Map<number, string>())];
    let removed = 0;
    if (t === "tasks") {
      const del = ctx.db.prepare(`DELETE FROM tasks WHERE rowid = ? AND id = ?`);
      ctx.db.transaction(() => { for (const [r, id] of rows) removed += del.run(r, id).changes; })();
    } else if (fixtureId) {
      const del = ctx.db.prepare(`DELETE FROM analytics_agent_views WHERE rowid = ? AND agent_id = ?`);
      ctx.db.transaction(() => { for (const [r] of rows) removed += del.run(r, fixtureId).changes; })();
    }
    let left: number | null = null;
    if (fixtureId && (start[t] ?? -1) >= 0) {
      try {
        left = t === "tasks"
          ? Number((ctx.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE rowid > ? AND (params LIKE ? OR params LIKE ?)`)
              .get(start[t], `%${fixtureId}%`, `%${ctx.fixture.name || fixtureId}%`) as { n: number }).n)
          : Number((ctx.db.prepare(`SELECT COUNT(*) AS n FROM analytics_agent_views WHERE rowid > ? AND agent_id = ?`).get(start[t], fixtureId) as { n: number }).n);
      } catch { left = null; }
    }
    out.push({ table: t, created: rows.length, removed, left_after_run: left });
  }
  return out;
}

export type SurfaceReader = (ctx: ProbeReaderContext) => Promise<SurfaceObservation> | SurfaceObservation;

export interface SurfaceReaderDef {
  read: SurfaceReader;
  /** Synchronous variant (usable inside a rolled-back transaction). */
  sync?: (ctx: ProbeReaderContext) => SurfaceObservation;
  observe: string;
  /** Poll interval while waiting for an effect (default 100 ms). */
  pollMs?: number;
}

function loadFixture(db: any, agentId: string): ProbeFixture {
  const { slugify } = require("../utils/slug") as typeof import("../utils/slug");
  const a = db.prepare(`SELECT id, name, city, categories, lat, lng, contact_email FROM agents WHERE id = ?`).get(agentId) as any;
  const k = db.prepare(`SELECT email FROM agent_knowledge WHERE agent_id = ?`).get(agentId) as { email?: string | null } | undefined;
  const p = db.prepare(`SELECT id, name FROM products WHERE agent_id = ? ORDER BY CASE availability WHEN 'in_stock' THEN 0 ELSE 1 END, created_at, id LIMIT 1`).get(agentId) as
    | { id: string; name: string } | undefined;
  let categories: string[] = [];
  try { const c = JSON.parse(a?.categories || "[]"); if (Array.isArray(c)) categories = c.map(String); } catch { categories = []; }
  const name = String(a?.name || "");
  return {
    id: agentId,
    name,
    slug: slugify(name),
    citySlug: slugify(String(a?.city || "")),
    categories,
    productName: p?.name ?? null,
    productId: p?.id ?? null,
    lat: typeof a?.lat === "number" ? a.lat : null,
    lng: typeof a?.lng === "number" ? a.lng : null,
    outreachEmail: (String(a?.contact_email || "").trim() || String(k?.email || "").trim()) || null,
  };
}

interface HandlerResult { status: number; body: any; headers: Record<string, string> }

function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
  const layer = (router?.stack as any[] | undefined)?.find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

/** An admin «Vis som offentlig» request (internal traffic: X-Admin-Key, as_public=1). */
function probeReq(ctx: ProbeReaderContext, path: string, o: { method?: "GET" | "POST"; params?: Record<string, string>; query?: Record<string, string>; body?: any } = {}): any {
  const headers: Record<string, string> = {
    host: "rettfrabonden.com",
    "x-admin-key": ctx.adminKey,
    "user-agent": "rfb-switch-probe/1 (internal)",
  };
  const query: Record<string, string> = { ...(o.query || {}), as_public: "1" };
  const qs = Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const url = `${path}?${qs}`;
  return {
    method: o.method ?? "GET", url, path, originalUrl: url, baseUrl: "",
    params: o.params || {}, body: o.body ?? {}, query, headers, cookies: {},
    ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com", secure: true,
    get(name: string) { return headers[name.toLowerCase()]; },
    header(name: string) { return headers[name.toLowerCase()]; },
  };
}

/** Runs one route handler in-process with a capturing response (nothing goes on the wire). */
function invokeHandler(ctx: ProbeReaderContext, handler: Function, req: any): Promise<HandlerResult> {
  return new Promise((resolve) => {
    let settled = false;
    const headers: Record<string, string> = {};
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (body: any) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ status: res.statusCode, body, headers });
    };
    const res: any = {
      statusCode: 200,
      locals: {},
      headersSent: false,
      status(c: number) { res.statusCode = c; return res; },
      sendStatus(c: number) { res.statusCode = c; settle(undefined); return res; },
      json(p: any) { settle(p); return res; },
      send(p: any) { settle(p); return res; },
      end(p?: any) { settle(p); return res; },
      redirect(c: any, loc?: string) { if (typeof c === "number") res.statusCode = c; else res.statusCode = 302; settle({ __redirect: loc ?? c }); return res; },
      setHeader(k: string, v: any) { headers[String(k).toLowerCase()] = String(v); return res; },
      header(k: any, v?: any) {
        if (k && typeof k === "object") { for (const [kk, vv] of Object.entries(k)) res.setHeader(kk, vv); } else res.setHeader(k, v);
        return res;
      },
      set(k: any, v?: any) { return res.header(k, v); },
      type(t: string) { return res.setHeader("Content-Type", t); },
      getHeader(k: string) { return headers[String(k).toLowerCase()]; },
      removeHeader(k: string) { delete headers[String(k).toLowerCase()]; return res; },
      vary() { return res; },
      append() { return res; },
      once() { return res; },
      on() { return res; },
      write() { return true; },
    };
    timer = setTimeout(() => settle({ __error: "handler timeout" }), HANDLER_TIMEOUT_MS);
    try {
      const p = captureSync(ctx, () => handler(req, res, (err?: any) => settle({ __next: true, err: err ? String(err) : undefined })));
      if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
    } catch (err) {
      settle({ __error: String(err) });
    }
  });
}

interface VisKit {
  handlers: Record<string, Function>;
  tool: (name: string, args: any) => Promise<string>;
  resource: (name: string, uri: URL) => Promise<any>;
  buildSitemapXml: () => string;
}

let visKitCache: { kit: VisKit; refs: unknown[] } | null = null;

/** The public route handlers and MCP tools (lazy: these modules are large). */
function visKit(ctx: ProbeReaderContext): VisKit {
  const marketplaceRouter = require("../routes/marketplace").default as any;
  const { catalogRouter } = require("../routes/marketplace-catalog") as typeof import("../routes/marketplace-catalog");
  const seoMod = require("../routes/seo") as typeof import("../routes/seo");
  const a2aRouter = require("../routes/a2a").default as any;
  const discoveryRouter = require("../routes/discovery").default as any;
  const mcpMod = require("../routes/mcp") as typeof import("../routes/mcp");
  // Rebuilt when a module was reloaded (tests clear require.cache) or the key changed.
  const refs: unknown[] = [marketplaceRouter, catalogRouter, seoMod.default, a2aRouter, discoveryRouter, mcpMod.registerTools, ctx.adminKey];
  if (visKitCache && visKitCache.refs.length === refs.length && visKitCache.refs.every((r, i) => r === refs[i])) return visKitCache.kit;
  const tools = new Map<string, (args: any, extra?: any) => Promise<any>>();
  const resources = new Map<string, (uri: URL, extra?: any) => Promise<any>>();
  const { buildRequestMeta } = require("../services/internal-traffic") as typeof import("../services/internal-traffic");
  const metaReq = probeReq(ctx, "/mcp");
  mcpMod.registerTools({
    registerTool(name: string, _config: any, handler: any) { tools.set(name, handler); },
    tool() { /* legacy API: not used for the probed tools */ },
    resource(name: string, _uri: any, _meta: any, handler: any) { resources.set(name, typeof _meta === "function" ? _meta : handler); },
    prompt() { /* no-op */ },
    registerResource() { /* no-op */ },
    registerPrompt() { /* no-op */ },
  } as any, () => "rfb-switch-probe", () => buildRequestMeta(metaReq as any) as any);
  const extra = () => ({ requestInfo: { headers: { "x-admin-key": ctx.adminKey, "user-agent": "rfb-switch-probe/1 (internal)" } } });
  const kit: VisKit = {
    handlers: {
      search: findRouteHandler(marketplaceRouter, "/search", "get"),
      discover: findRouteHandler(marketplaceRouter, "/discover", "post"),
      card: findRouteHandler(marketplaceRouter, "/agents/:id/card", "get"),
      info: findRouteHandler(marketplaceRouter, "/agents/:id/info", "get"),
      vcard: findRouteHandler(marketplaceRouter, "/agents/:id/vcard", "get"),
      feed: findRouteHandler(catalogRouter, "/feed", "get"),
      acp: findRouteHandler(catalogRouter, "/acp-feed.csv", "get"),
      produsent: findRouteHandler(seoMod.default, "/produsent/:slug", "get"),
      home: findRouteHandler(seoMod.default, "/", "get"),
      city: findRouteHandler(seoMod.default, "/:city", "get"),
      a2a: findRouteHandler(a2aRouter, "/a2a", "post"),
      leaderboard: findRouteHandler(a2aRouter, "/api/leaderboard", "get"),
      llms: findRouteHandler(discoveryRouter, "/llms.txt", "get"),
      llmsFull: findRouteHandler(discoveryRouter, "/llms-full.txt", "get"),
    },
    tool: async (name, args) => {
      const h = tools.get(name);
      if (!h) throw new Error(`MCP tool not registered: ${name}`);
      return String((await captureSync(ctx, () => h(args, extra())))?.content?.[0]?.text ?? "");
    },
    resource: async (name, uri) => {
      const h = resources.get(name);
      if (!h) throw new Error(`MCP resource not registered: ${name}`);
      return captureSync(ctx, () => h(uri, extra()));
    },
    buildSitemapXml: () => seoMod.buildSitemapXml(),
  };
  visKitCache = { kit, refs };
  return kit;
}

const LD_RE = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
const htmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const jsonInner = (s: string) => JSON.stringify(s).slice(1, -1);

/** «Is the fixture there?» per endpoint of one visibility surface, run as-public. */
function visibilityReader(surface: string): SurfaceReader {
  return async (ctx) => {
    const { runAsPublicView } = require("../services/agent-visibility") as typeof import("../services/agent-visibility");
    return runAsPublicView(async () => {
      const kit = visKit(ctx);
      const f = ctx.fixture;
      const call = (h: string, path: string, o: Parameters<typeof probeReq>[2] = {}) => invokeHandler(ctx, kit.handlers[h], probeReq(ctx, path, o));
      const text = (r: HandlerResult) => (typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? ""));
      const page = async () => call("produsent", `/produsent/${f.slug}`, { params: { slug: f.slug } });
      const hasName = (s: string) => s.includes(f.name) || s.includes(htmlEscape(f.name));
      const entryRe = new RegExp(`(^|\\n|\\*\\*)\\d+\\. ${f.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
      const listsName = (s: string) => entryRe.test(s);
      const ldOf = (html: string) => [...html.matchAll(LD_RE)].map((m) => m[1]).join("\n");
      const ldHasName = (html: string) => ldOf(html).includes(`"name":"${jsonInner(f.name)}"`);
      const a2a = (body: any) => call("a2a", "/a2a", { method: "POST", body: { jsonrpc: "2.0", id: 1, ...body } });
      const eps: Record<string, () => Promise<boolean>> = {};
      switch (surface) {
        case "profile_html":
          eps.produsent = async () => { const r = await page(); const h = text(r); return r.status === 200 && hasName(h) && !h.includes("Midlertidig pause"); };
          break;
        case "json_ld":
          eps.produsent_jsonld = async () => { const r = await page(); return r.status === 200 && ldHasName(text(r)); };
          break;
        case "listing_html":
          eps.home_cards = async () => text(await call("home", "/")).includes(`href="/produsent/${f.slug}"`);
          eps.city_jsonld = async () => {
            if (!f.citySlug) return false;
            const r = await call("city", `/${f.citySlug}`, { params: { city: f.citySlug } });
            return r.status === 200 && ldHasName(text(r));
          };
          break;
        case "mcp_search":
          // A result entry («**3. Navn**» / «3. Navn»), not the echoed query.
          eps.lokal_search = async () => listsName(await kit.tool("lokal_search", { query: f.name }));
          if (f.categories.length) eps.lokal_discover = async () => listsName(await kit.tool("lokal_discover", { categories: f.categories.slice(0, 1) }));
          eps.rest_search = async () => ((await call("search", "/api/marketplace/search", { query: { q: f.name, heleNorge: "true" } })).body?.results ?? []).some((r: any) => r?.agent?.id === f.id);
          if (f.categories.length) eps.rest_discover = async () => ((await call("discover", "/api/marketplace/discover", { method: "POST", body: { categories: f.categories.slice(0, 1) } })).body?.results ?? []).some((r: any) => r?.agent?.id === f.id);
          if (f.productName && f.lat !== null && f.lng !== null) {
            eps.lokal_find_offers = async () => {
              const t = await kit.tool("lokal_find_offers", { items: [f.productName!.toLowerCase()], lat: f.lat, lng: f.lng });
              let parsed: any;
              try { parsed = JSON.parse(t); } catch { return false; }
              return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((x: any) => x?.offers ?? []).some((o: any) => o?.producer?.agent_id === f.id);
            };
          }
          break;
        case "mcp_info":
          eps.lokal_info = async () => (await kit.tool("lokal_info", { agentId: f.id })).includes(`# ${f.name}`);
          eps.mcp_resource = async () => {
            const r = await kit.resource("producer-detail", new URL(`lokal://producers/${f.id}`));
            try { return JSON.parse(String(r?.contents?.[0]?.text ?? ""))?.agent?.id === f.id; } catch { return false; }
          };
          break;
        case "rest_card":
          eps.card = async () => (await call("card", `/api/marketplace/agents/${f.id}/card`, { params: { id: f.id } })).status === 200;
          eps.info = async () => (await call("info", `/api/marketplace/agents/${f.id}/info`, { params: { id: f.id } })).status === 200;
          break;
        case "vcard":
          eps.vcard = async () => text(await call("vcard", `/api/marketplace/agents/${f.id}/vcard`, { params: { id: f.id } })).includes("BEGIN:VCARD");
          break;
        case "acp_feed":
          eps.feed = async () => ((await call("feed", "/api/marketplace/catalog/feed")).body?.items ?? []).some((i: any) => i?.seller?.agent_id === f.id);
          if (f.productId) eps.acp_csv = async () => text(await call("acp", "/api/marketplace/catalog/acp-feed.csv")).includes(f.productId!);
          break;
        case "sitemap":
          eps.sitemap_xml = async () => kit.buildSitemapXml().includes(`/produsent/${f.slug}</loc>`);
          break;
        case "llms":
          eps.llms_txt = async () => text(await call("llms", "/llms.txt")).includes(f.slug);
          eps.llms_full = async () => hasName(text(await call("llmsFull", "/llms-full.txt")));
          break;
        case "a2a":
          eps.agent_info = async () => !!(await a2a({ method: "agent/info", params: { agentId: f.id } })).body?.result;
          eps.a2a_search = async () => JSON.stringify((await a2a({ method: "message/send", params: { message: { role: "user", parts: [{ kind: "text", text: f.name }] } } })).body ?? "").includes(f.id);
          break;
        case "leaderboard":
          eps.api_leaderboard = async () => ((await call("leaderboard", "/api/leaderboard")).body?.data ?? []).some((r: any) => r?.agentId === f.id);
          break;
        default:
          throw new Error(`no visibility reader for ${surface}`);
      }
      const endpoints: Record<string, boolean> = {};
      for (const [name, fn] of Object.entries(eps)) endpoints[name] = await fn();
      return { endpoints, requireAll: !LIST_SURFACES.has(surface) };
    });
  };
}

function recipientDecision(ctx: ProbeReaderContext): { eligible: boolean; detail: string } {
  const { resolveOrderNotificationRecipient } = require("../services/order-notify-service") as typeof import("../services/order-notify-service");
  const r = resolveOrderNotificationRecipient(ctx.fixture.id);
  return r.eligible ? { eligible: true, detail: `sendes (via ${r.via})` } : { eligible: false, detail: `sendes ikke (${r.reason})` };
}

const orderGateSync = (ctx: ProbeReaderContext): SurfaceObservation => {
  const { isEligibleForRealOrder } = require("../services/cart-service") as typeof import("../services/cart-service");
  const open = isEligibleForRealOrder(ctx.fixture.id, ctx.db);
  return { endpoints: { isEligibleForRealOrder: open }, detail: open ? "ekte ordre" : "kontaktoverlevering" };
};
const orderMailSync = (ctx: ProbeReaderContext): SurfaceObservation => {
  const d = recipientDecision(ctx);
  return { endpoints: { order_notification: d.eligible }, detail: `ordrevarsel ${d.detail}` };
};
const reminderMailSync = (ctx: ProbeReaderContext): SurfaceObservation => {
  const d = recipientDecision(ctx);
  return { endpoints: { order_reminder: d.eligible }, detail: `påminnelse ${d.detail}` };
};
const followupsJobSync = (ctx: ProbeReaderContext): SurfaceObservation => {
  const d = recipientDecision(ctx);
  const stopped = ctx.env.RFB_DISABLE_ORDER_FOLLOWUPS === "1";
  return {
    endpoints: { reminder_step: d.eligible },
    detail: `jobben ${d.eligible ? "sender påminnelsen" : "hopper over påminnelsen"}${stopped ? " (jobben er stoppet: RFB_DISABLE_ORDER_FOLLOWUPS=1)" : ""}`,
  };
};

class ReaderRollback extends Error {
  constructor(readonly obs: SurfaceObservation) { super("switch-probe reader rollback"); }
}

/** A non-owner write of an owner-locked field is skipped — evaluated in a transaction that is always rolled back. */
const knowledgeWriteSync = (ctx: ProbeReaderContext): SurfaceObservation => {
  const { knowledgeService } = require("../services/knowledge-service") as typeof import("../services/knowledge-service");
  const db = getDb();
  try {
    db.transaction(() => {
      const row = db.prepare(`SELECT about, curated_fields FROM agent_knowledge WHERE agent_id = ?`).get(ctx.fixture.id) as
        | { about: string | null; curated_fields: string | null } | undefined;
      if (!row) throw new ReaderRollback({ endpoints: { owner_lock_kept: false }, detail: "ingen agent_knowledge-rad" });
      let locks: Record<string, any> = {};
      try { const p = JSON.parse(row.curated_fields || "{}"); if (p && typeof p === "object") locks = p; } catch { locks = {}; }
      const ownerText = row.about && locks.about?.by === "owner" ? row.about : "Eierens egen tekst (bryterprobe, rulles tilbake).";
      db.prepare(`UPDATE agent_knowledge SET about = ?, curated_fields = ? WHERE agent_id = ? AND agent_id IN (SELECT id FROM agents WHERE ${FIXTURE_PIN})`)
        .run(ownerText, JSON.stringify({ ...locks, about: { by: "owner", locked_at: new Date().toISOString() } }), ctx.fixture.id);
      const r = knowledgeService.upsertKnowledge(ctx.fixture.id, { about: "Bryterprobe prøver å overskrive (rulles tilbake).", dataSource: "auto" } as any);
      const after = (db.prepare(`SELECT about FROM agent_knowledge WHERE agent_id = ?`).get(ctx.fixture.id) as { about: string | null }).about;
      const skipped = r.skipped.some((s) => s.field === "about" && s.reason === "owner_locked");
      const kept = after === ownerText;
      throw new ReaderRollback({
        endpoints: { owner_lock_kept: skipped && kept },
        detail: skipped && kept ? "ikke-eier-skriving hoppet over (owner_locked), eierens tekst beholdt" : "ikke-eier-skriving overskrev eierens tekst",
      });
    })();
  } catch (e) {
    if (e instanceof ReaderRollback) return e.obs;
    throw e;
  }
  throw new Error("knowledge_write reader: no observation");
};

const enrichmentNightlyReader: SurfaceReader = async (ctx) => {
  const { loadRfbEnrichmentCohort } = require("../services/rfb-enrichment-nightly") as typeof import("../services/rfb-enrichment-nightly");
  const cohort = await loadRfbEnrichmentCohort(ctx.db);
  const picked = cohort.rows.some((r) => r.id === ctx.fixture.id);
  return { endpoints: { not_in_cohort: !picked }, detail: picked ? "valgt i nattkohorten" : "ikke valgt i nattkohorten" };
};

const outreachSync = (ctx: ProbeReaderContext): SurfaceObservation => {
  const av = require("../services/avmeld-service") as typeof import("../services/avmeld-service");
  const to = ctx.fixture.outreachEmail;
  if (!to) return { endpoints: { list_unsubscribe: false }, detail: "ingen mottakeradresse" };
  const h = av.unsubscribeHeaderValues(to);
  const m = h ? h.listUnsubscribe.match(/\/avmeld\/([^>]+)>$/) : null;
  const signed = !!m && av.verifyUnsubscribeToken(m[1]!)?.email === av.normalizeRecipient(to);
  return {
    endpoints: { list_unsubscribe: !!h && signed },
    detail: h ? (signed ? "kald e-post får List-Unsubscribe (signert for eieren)" : "List-Unsubscribe uten gyldig token") : "kald e-post får ingen List-Unsubscribe",
  };
};

const syncReader = (fn: (ctx: ProbeReaderContext) => SurfaceObservation, observe: string): SurfaceReaderDef => ({ read: fn, sync: fn, observe });

const VISIBILITY_SURFACES = ["profile_html", "json_ld", "listing_html", "mcp_search", "mcp_info", "rest_card", "vcard", "acp_feed", "sitemap", "llms", "a2a", "leaderboard"];

/**
 * The effect reader per live key × surface — the same cases (and the same
 * code paths, decision-only where the matrix test sends) as
 * OWNER_FEATURE_MATRIX_CASES. A live key × surface without an entry here is a
 * FAIL row («mangler effektleser»), so a new live surface cannot pass silently.
 */
export function defaultSwitchProbeReaders(): Record<string, SurfaceReaderDef> {
  const out: Record<string, SurfaceReaderDef> = {
    "orders.enabled × order_gate": syncReader(orderGateSync, "isEligibleForRealOrder(): ekte ordre vs kontaktoverlevering"),
    "orders.enabled × email:order_notification": syncReader(orderMailSync, "resolveOrderNotificationRecipient(): ordrevarsel sendes / sendes ikke"),
    "notify.order_email × email:order_notification": syncReader(orderMailSync, "resolveOrderNotificationRecipient(): ordrevarsel sendes / sendes ikke"),
    "orders.email × email:order_notification": syncReader(orderMailSync, "resolveOrderNotificationRecipient(): mottakeren endres ikke ved direkte skriving"),
    "orders.reminder × email:order_reminder": syncReader(reminderMailSync, "påminnelsens sendebeslutning (resolveOrderNotificationRecipient)"),
    "orders.reminder × job:order_followups": syncReader(followupsJobSync, "processOrderFollowups' påminnelsessteg: kjører / hopper over"),
    "auto.guarantee × job:rfb_enrichment_nightly": { read: enrichmentNightlyReader, observe: "loadRfbEnrichmentCohort(): testprodusenten velges aldri" },
    "auto.guarantee × job:knowledge_write": syncReader(knowledgeWriteSync, "upsertKnowledge() ikke-eier på eierlåst felt (rulles tilbake): owner_locked, verdi beholdt"),
    "comms.unsubscribe × email:outreach": syncReader(outreachSync, "unsubscribeHeaderValues(): kald e-post får List-Unsubscribe"),
  };
  for (const s of VISIBILITY_SURFACES) {
    out[caseId("visibility.profile", s)] = {
      read: visibilityReader(s), observe: `${s} som offentlig: testprodusenten vist / borte`,
      ...(HEAVY_SURFACES.has(s) ? { pollMs: HEAVY_POLL_MS } : {}),
    };
  }
  return out;
}

// ── Plan ──────────────────────────────────────────────────────────────────

function liveEntries(): OwnerFeatureEntry[] {
  return OWNER_FEATURE_REGISTRY.filter((e) => e.status === "live");
}

const PLANNED_CHECKS = [
  "coming_soon:<key> — PUT → 409 coming_soon, ingen lagring, ingen effekt (hver coming_soon-nøkkel)",
  "requirement_unmet:<key> — uoppfylt krav → 409 requirement_not_met, ingen lagring, ingen effekt (rullet tilbake)",
  "level:<nivå> — nivået gir samme effekt som enkeltbryterne",
  "undo:level:<nivå> / undo:single:<key> — «Angre» gjenoppretter effekten",
  "no_surface:<key> — live-nøkkel uten flater: skriving + endringslogg",
  "public_stats_threshold — «Vis som offentlig»: statistikkflisene på profilsiden vises bare med minst PUBLIC_STATS_MIN_VIEWS sidevisninger fra mennesker siste 12 mnd (eierens «Sett»), prøvd på begge sider av terskelen",
  "restore — alt tilbake til startpunktet (eksakt)",
];

export function planSwitchProbe(db: any, agentId: string, env: NodeJS.ProcessEnv = process.env, readers = defaultSwitchProbeReaders()): SwitchProbePlan {
  const resolved = resolveOwnerFeatures(VERTICAL, agentId, { db, env });
  const rows: SwitchProbePlanRow[] = [];
  for (const e of liveEntries()) {
    const kind = entryKind(e);
    if (!kind) continue;
    for (const s of e.surfaces) {
      for (const d of directionsFor(kind, resolved.byKey[e.key]?.value ?? null)) {
        rows.push({ key: e.key, surface: s, direction: d, kind, reader: !!readers[caseId(e.key, s)] });
      }
    }
  }
  return {
    agent_id: agentId,
    segment: resolved.subject.segment,
    allowlisted: isSubjectAllowedForOwnerFeatures(VERTICAL, agentId, env),
    env_flags: envFlags(env),
    baseline: liveEntries().map((e) => {
      const r = resolved.byKey[e.key];
      return { key: e.key, status: e.status, type: e.type, value: displayValue(e, r.value), source: r.source, block: r.block };
    }),
    rows,
    checks: PLANNED_CHECKS,
  };
}

// ── Run ───────────────────────────────────────────────────────────────────

export interface SwitchProbeOptions {
  db?: any;
  env?: NodeJS.ProcessEnv;
  /** Max wait for an effect after a write (polled). Default 2 s, capped at 120 s. */
  maxWaitMs?: number;
  /** Test seam: replace / add effect readers. */
  readers?: Record<string, SurfaceReaderDef>;
  /** Test seam: called after every switch flip; a throw aborts the run (restore still runs). */
  afterFlip?: (key: string, direction: ProbeDirection) => void;
  /** Test seam: the owner write the probe makes (default setOwnerFeatureValue). */
  write?: ProbeWriteFn;
}

export type ProbeWriteFn = typeof setOwnerFeatureValue;

let running = false;

export function isSwitchProbeRunning(): boolean {
  return running;
}

export class SwitchProbeBusyError extends Error {
  constructor() { super("switch probe already running"); }
}

type Evaluated = { pass: boolean; observed: string };

function describe(obs: SurfaceObservation): string {
  const eps = Object.entries(obs.endpoints).map(([k, v]) => `${k}=${v ? "ja" : "nei"}`).join(", ");
  return obs.detail ? `${obs.detail} [${eps}]` : eps;
}

/**
 * expected false: every endpoint must be without the effect. expected true:
 * at least one endpoint shows it, and every endpoint that showed it at the
 * reference observation shows it again (list surfaces with ranking/sampling
 * may never show the fixture; those endpoints are named, not counted).
 */
export function evaluateObservation(obs: SurfaceObservation, expected: boolean, ref: SurfaceObservation | null): Evaluated {
  const vals = Object.entries(obs.endpoints);
  let pass: boolean;
  if (!expected) pass = vals.length > 0 && vals.every(([, v]) => !v);
  else {
    pass = obs.requireAll ? vals.length > 0 && vals.every(([, v]) => v) : vals.some(([, v]) => v);
    if (pass && ref) pass = Object.entries(ref.endpoints).every(([k, v]) => !v || obs.endpoints[k] === true);
  }
  const silent = expected ? vals.filter(([, v]) => !v).map(([k]) => k) : [];
  return { pass, observed: describe(obs) + (expected && silent.length && pass ? ` (listeflate, uten utslag her: ${silent.join(", ")})` : "") };
}

interface Ctx {
  db: any;
  env: NodeJS.ProcessEnv;
  agentId: string;
  readers: Record<string, SurfaceReaderDef>;
  readerCtx: ProbeReaderContext;
  maxWaitMs: number;
  rows: SwitchProbeRow[];
  checks: SwitchProbeCheck[];
  afterFlip?: SwitchProbeOptions["afterFlip"];
  write: ProbeWriteFn;
}

/** One owner write of the probe (actor admin / switch-probe) through the write seam. */
function probeWrite(c: Ctx, key: string, value: OwnerFeatureValue): SetOwnerFeatureResult {
  return c.write(VERTICAL, c.agentId, key, value, SWITCH_PROBE_ACTOR, { db: c.db, env: c.env });
}

function maxAuditId(db: any, agentId: string): number {
  return Number((db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM owner_feature_audit WHERE vertical = ? AND subject_id = ?`).get(VERTICAL, agentId) as { m: number }).m) || 0;
}

function settingsFingerprint(db: any, agentId: string): string {
  return JSON.stringify(snapshotFixture(db, agentId));
}

function resolvedNow(c: Ctx): ResolvedOwnerFeatures {
  return resolveOwnerFeatures(VERTICAL, c.agentId, { db: c.db, env: c.env });
}

/** The write is in owner_feature_audit (this actor) and on the first page of the owner's change log. */
function changeLogged(c: Ctx, key: string, value: OwnerFeatureValue, beforeId: number): boolean {
  const row = c.db
    .prepare(`SELECT id, new_json, actor, actor_detail FROM owner_feature_audit WHERE vertical = ? AND subject_id = ? AND key = ? AND id > ? ORDER BY id DESC LIMIT 1`)
    .get(VERTICAL, c.agentId, key, beforeId) as { id: number; new_json: string | null; actor: string; actor_detail: string | null } | undefined;
  if (!row || row.actor !== SWITCH_PROBE_ACTOR.actor || row.actor_detail !== SWITCH_PROBE_ACTOR.detail) return false;
  let v: unknown = null;
  try { v = row.new_json == null ? null : JSON.parse(row.new_json); } catch { return false; }
  if (!sameValue(v, value)) return false;
  const log = ownerFeatureChangeLog(VERTICAL, c.agentId, 1, c.db, 50);
  return log.rows.some((r) => r.id === row.id && r.key === key && sameValue(r.new_value, value));
}

async function readSafe(def: SurfaceReaderDef, rc: ProbeReaderContext): Promise<{ obs: SurfaceObservation | null; error: string | null }> {
  try {
    return { obs: await def.read(rc), error: null };
  } catch (e: any) {
    return { obs: null, error: String(e?.message || e) };
  }
}

/** Polls the reader until the expectation holds or the wait is over. */
async function awaitEffect(c: Ctx, def: SurfaceReaderDef, expected: boolean, ref: SurfaceObservation | null, t0: number) {
  let last: { obs: SurfaceObservation | null; error: string | null } = { obs: null, error: null };
  for (;;) {
    last = await readSafe(def, c.readerCtx);
    const ms = Date.now() - t0;
    if (last.obs) {
      const ev = evaluateObservation(last.obs, expected, ref);
      if (ev.pass) return { ...ev, obs: last.obs, ms, error: null };
      if (ms >= c.maxWaitMs) return { ...ev, obs: last.obs, ms: null as number | null, error: null };
    } else if (ms >= c.maxWaitMs) {
      return { pass: false, observed: `leser feilet: ${last.error}`, obs: null, ms: null as number | null, error: last.error };
    }
    await sleep(Math.max(POLL_MS, def.pollMs ?? POLL_MS));
  }
}

function pushRow(c: Ctx, r: Omit<SwitchProbeRow, "result"> & { pass: boolean }): void {
  const { pass, ...rest } = r;
  let result: ProbeVerdict = pass ? "PASS" : "FAIL";
  let reason = rest.reason;
  if (result === "PASS" && rest.ms_to_effect !== null && rest.ms_to_effect > SWITCH_PROBE_EFFECT_MAX_MS) {
    result = "FAIL";
    reason = "tid til effekt over 60 min (cache)";
  }
  const flag = SWITCH_PROBE_FLAG_DEPENDENCIES[caseId(rest.key, rest.surface)];
  if (flag && !flagOn(c.env, flag)) {
    result = "FAIL";
    reason = `${FLAG_OFF_REASON} (${flag}=${c.env[flag] ?? "unset"})`;
  }
  c.rows.push({ ...rest, result, ...(reason ? { reason } : {}) });
}

function missingReaderRows(c: Ctx, e: OwnerFeatureEntry, surface: string, dirs: ProbeDirection[]): void {
  for (const d of dirs) {
    pushRow(c, {
      key: e.key, surface, direction: d, pass: false, observed: "—", expected: "—",
      ms_to_effect: null, write_status: null, change_logged: null, discriminating: false, reason: "mangler effektleser for flaten",
    });
  }
}

/** switch: flip away from the baseline and back; every surface observed after each flip. */
async function probeSwitch(c: Ctx, e: OwnerFeatureEntry, baseline: OwnerFeatureValue): Promise<void> {
  const dirs = directionsFor("switch", baseline);
  const surfaces = e.surfaces.filter((s) => c.readers[caseId(e.key, s)]);
  for (const s of e.surfaces) if (!c.readers[caseId(e.key, s)]) missingReaderRows(c, e, s, dirs);
  const refs = new Map<string, SurfaceObservation | null>();
  // Reference observation at the starting point (an "on" baseline names the endpoints that must show it again).
  if (baseline === true) {
    for (const s of surfaces) refs.set(s, (await readSafe(c.readers[caseId(e.key, s)], c.readerCtx)).obs);
  }
  for (const d of dirs) {
    const value = d === "on";
    const before = maxAuditId(c.db, c.agentId);
    const w = probeWrite(c, e.key, value);
    const t0 = Date.now();
    const status = putStatusFor(w);
    const logged = w.kind === "ok" && w.changed ? changeLogged(c, e.key, value, before) : w.kind === "ok" ? null : false;
    c.afterFlip?.(e.key, d);
    for (const s of surfaces) {
      const def = c.readers[caseId(e.key, s)];
      const ref = value ? refs.get(s) ?? null : null;
      const r = await awaitEffect(c, def, value, ref, t0);
      if (value && r.obs && !refs.get(s)) refs.set(s, r.obs);
      const writeOk = w.kind === "ok";
      pushRow(c, {
        key: e.key, surface: s, direction: d,
        pass: writeOk && logged !== false && r.pass,
        observed: r.observed, expected: value ? "effekt til stede" : "effekt borte",
        ms_to_effect: r.pass ? r.ms : null, write_status: status, change_logged: logged, discriminating: true,
        ...(!writeOk ? { reason: `skrivingen ble avvist (${status}${w.kind === "blocked" ? ` ${w.block}` : ""})` }
          : logged === false ? { reason: "endringen mangler i endringsloggen" }
          : !r.pass ? { reason: r.error ? `leser feilet: ${r.error}` : `ingen riktig effekt innen ${c.maxWaitMs} ms${visibilityFlagHint(c, e.key)}` } : {}),
      });
    }
  }
}

function visibilityFlagHint(c: Ctx, key: string): string {
  if (!key.startsWith("visibility.")) return "";
  return flagOn(c.env, "OWNER_FEATURES_ENFORCE") || flagOn(c.env, "OWNER_PAUSE_ENABLED")
    ? ""
    : ` — ${FLAG_OFF_REASON} (OWNER_FEATURES_ENFORCE og OWNER_PAUSE_ENABLED er av)`;
}

/** A write the owner may not make: 409 `block`, nothing stored, the effect as before. */
async function probeRefused(
  c: Ctx, e: OwnerFeatureEntry, direction: ProbeDirection, value: OwnerFeatureValue, block: string,
  expectedEffect: (s: string) => boolean,
): Promise<void> {
  const fp0 = settingsFingerprint(c.db, c.agentId);
  const before = maxAuditId(c.db, c.agentId);
  const w = probeWrite(c, e.key, value);
  const t0 = Date.now();
  const status = putStatusFor(w);
  const unchanged = settingsFingerprint(c.db, c.agentId) === fp0 && maxAuditId(c.db, c.agentId) === before;
  const refused = w.kind === "blocked" && w.block === block;
  c.afterFlip?.(e.key, direction);
  for (const s of e.surfaces) {
    const def = c.readers[caseId(e.key, s)];
    if (!def) { missingReaderRows(c, e, s, [direction]); continue; }
    const exp = expectedEffect(s);
    const r = await awaitEffect(c, def, exp, null, t0);
    pushRow(c, {
      key: e.key, surface: s, direction,
      pass: refused && unchanged && r.pass,
      observed: `PUT ${JSON.stringify(displayValue(e, value))} → ${status}${w.kind === "blocked" ? ` ${w.block}` : ""}; ${r.observed}`,
      expected: `409 ${block}, ingenting lagret, effekt ${exp ? "til stede" : "borte"} som før`,
      ms_to_effect: r.pass ? r.ms : null, write_status: status, change_logged: null, discriminating: false,
      ...(!refused ? { reason: `ventet 409 ${block}, fikk ${status}${w.kind === "blocked" ? ` ${w.block}` : ""}` }
        : !unchanged ? { reason: "en avvist skriving endret lagret tilstand eller skrev en logglinje" }
        : !r.pass ? { reason: r.error ? `leser feilet: ${r.error}` : "effekten fulgte ikke forventningen" } : {}),
    });
  }
}

/** locked: owner writes refused both ways; the effect follows the parent (lockedWhen) off and on. */
async function probeLocked(c: Ctx, e: OwnerFeatureEntry): Promise<void> {
  const cur = resolvedNow(c).byKey[e.key]?.value === true;
  await probeRefused(c, e, "off", false, "locked", () => cur);
  await probeRefused(c, e, "on", true, "locked", () => cur);
  const parent = e.lockedWhen ? findOwnerFeature(e.lockedWhen) : undefined;
  if (!parent) {
    for (const s of e.surfaces) {
      for (const d of ["parent_off", "parent_on"] as ProbeDirection[]) {
        pushRow(c, { key: e.key, surface: s, direction: d, pass: false, observed: "—", expected: "—", ms_to_effect: null, write_status: null, change_logged: null, discriminating: false, reason: "låst nøkkel uten lockedWhen" });
      }
    }
    return;
  }
  const parentStart = resolvedNow(c).byKey[parent.key]?.value === true;
  const order: ProbeDirection[] = parentStart ? ["parent_off", "parent_on"] : ["parent_on", "parent_off"];
  for (const d of order) {
    const value = d === "parent_on";
    const before = maxAuditId(c.db, c.agentId);
    const w = probeWrite(c, parent.key, value);
    const t0 = Date.now();
    const status = putStatusFor(w);
    const logged = w.kind === "ok" && w.changed ? changeLogged(c, parent.key, value, before) : w.kind === "ok" ? null : false;
    c.afterFlip?.(e.key, d);
    const lockedValue = resolvedNow(c).byKey[e.key];
    for (const s of e.surfaces) {
      const def = c.readers[caseId(e.key, s)];
      if (!def) { missingReaderRows(c, e, s, [d]); continue; }
      const r = await awaitEffect(c, def, value, null, t0);
      const followsParent = lockedValue?.value === value && lockedValue.block === "locked";
      pushRow(c, {
        key: e.key, surface: s, direction: d,
        pass: w.kind === "ok" && logged !== false && followsParent && r.pass,
        observed: `${parent.key}=${value} → ${status}; ${e.key}=${lockedValue?.value} (låst); ${r.observed}`,
        expected: `${e.key} følger ${parent.key}: effekt ${value ? "til stede" : "borte"}`,
        ms_to_effect: r.pass ? r.ms : null, write_status: status, change_logged: logged, discriminating: true,
        ...(w.kind !== "ok" ? { reason: `skrivingen av ${parent.key} ble avvist (${status})` }
          : logged === false ? { reason: "endringen mangler i endringsloggen" }
          : !followsParent ? { reason: "den låste nøkkelen fulgte ikke forelderen" }
          : !r.pass ? { reason: r.error ? `leser feilet: ${r.error}` : `ingen riktig effekt innen ${c.maxWaitMs} ms` } : {}),
      });
    }
  }
}

/** confirm_by_email (orders.email): a direct write is refused both ways and the recipient does not change. */
async function probeConfirmByEmail(c: Ctx, e: OwnerFeatureEntry): Promise<void> {
  const fingerprint = () => {
    try { const d = recipientDecision(c.readerCtx); return d.detail; } catch (err: any) { return `feil: ${String(err?.message || err)}`; }
  };
  for (const [d, value] of [["off", null], ["on", "switch-probe@example.invalid"]] as Array<[ProbeDirection, OwnerFeatureValue]>) {
    const fp0 = settingsFingerprint(c.db, c.agentId);
    const rec0 = fingerprint();
    const before = maxAuditId(c.db, c.agentId);
    const w = probeWrite(c, e.key, value);
    const status = putStatusFor(w);
    const unchanged = settingsFingerprint(c.db, c.agentId) === fp0 && maxAuditId(c.db, c.agentId) === before;
    const refused = w.kind === "blocked" && w.block === "confirm_by_email";
    c.afterFlip?.(e.key, d);
    for (const s of e.surfaces) {
      const rec1 = fingerprint();
      const same = rec1 === rec0;
      pushRow(c, {
        key: e.key, surface: s, direction: d,
        pass: refused && unchanged && same,
        observed: `PUT ${JSON.stringify(displayValue(e, value))} → ${status}${w.kind === "blocked" ? ` ${w.block}` : ""}; ordrevarsel ${rec1}`,
        expected: "409 confirm_by_email, ingenting lagret, mottakeren uendret (endres bare med bekreftelseslenken)",
        ms_to_effect: null, write_status: status, change_logged: null, discriminating: false,
        ...(!refused ? { reason: `ventet 409 confirm_by_email, fikk ${status}` }
          : !unchanged ? { reason: "en avvist skriving endret lagret tilstand" }
          : !same ? { reason: "mottakeren endret seg" } : {}),
      });
    }
  }
}

/** guarantee: every write refused both ways; the promise holds at every step. */
async function probeGuarantee(c: Ctx, e: OwnerFeatureEntry): Promise<void> {
  await probeRefused(c, e, "off", false, "guarantee", () => true);
  await probeRefused(c, e, "on", true, "guarantee", () => true);
}

/** Every key's resolved value + every sync effect reader — what a change looks like from outside. */
function effectSignature(c: Ctx): string {
  const r = resolvedNow(c);
  const sig: Record<string, unknown> = {};
  for (const e of liveEntries()) sig[e.key] = r.byKey[e.key]?.value ?? null;
  for (const [id, def] of Object.entries(c.readers)) {
    if (!def.sync) continue;
    try { sig[id] = def.sync(c.readerCtx).endpoints; } catch (err: any) { sig[id] = `error: ${String(err?.message || err)}`; }
  }
  return JSON.stringify(sig);
}

/** Back to the starting values through the write path (the exact snapshot comes at the end). */
function restoreValues(c: Ctx, baseline: ResolvedOwnerFeatures, keys: string[]): void {
  for (const k of keys) {
    const b = baseline.byKey[k];
    if (!b) continue;
    const now = resolvedNow(c).byKey[k];
    if (now && sameValue(now.value, b.value)) continue;
    setOwnerFeatureValue(VERTICAL, c.agentId, k, b.value, SWITCH_PROBE_ACTOR, { db: c.db, env: c.env });
  }
}

function addCheck(c: Ctx, chk: Omit<SwitchProbeCheck, "result"> & { pass: boolean }): void {
  const { pass, ...rest } = chk;
  c.checks.push({ ...rest, result: pass ? "PASS" : "FAIL" });
}

/** A value of the entry's type that differs from `current` (for the coming_soon check). */
function otherValue(e: OwnerFeatureEntry, current: OwnerFeatureValue): OwnerFeatureValue {
  switch (e.type) {
    case "switch": return current === true ? false : true;
    case "choice": return (e.options || []).map((o) => o.value).find((v) => v !== current) ?? "x";
    case "number": { const n = e.min ?? 1; return current === n ? n + 1 : n; }
    case "date": return "2099-01-01";
    case "email": return "switch-probe@example.invalid";
    default: return true;
  }
}

function checkComingSoon(c: Ctx): void {
  const r0 = resolvedNow(c);
  for (const e of OWNER_FEATURE_REGISTRY.filter((x) => x.status === "coming_soon")) {
    const cur = r0.byKey[e.key];
    const value = otherValue(e, cur?.value ?? null);
    const fp0 = settingsFingerprint(c.db, c.agentId);
    const sig0 = effectSignature(c);
    const before = maxAuditId(c.db, c.agentId);
    const w = probeWrite(c, e.key, value);
    const status = putStatusFor(w);
    const after = resolvedNow(c).byKey[e.key];
    const noEffect = settingsFingerprint(c.db, c.agentId) === fp0 && maxAuditId(c.db, c.agentId) === before
      && sameValue(after?.value, cur?.value) && effectSignature(c) === sig0;
    const refused = w.kind === "blocked" && w.block === "coming_soon";
    addCheck(c, {
      check: `coming_soon:${e.key}`, key: e.key, pass: refused && noEffect,
      observed: `PUT ${JSON.stringify(displayValue(e, value))} → ${status}${w.kind === "blocked" ? ` ${w.block}` : ""}; ${noEffect ? "ingen effekt" : "EFFEKT"}`,
      ...(!refused ? { reason: `ventet 409 coming_soon, fikk ${status}${w.kind === "blocked" ? ` ${w.block}` : ""}` } : !noEffect ? { reason: "noe ble lagret eller endret" } : {}),
    });
    if (w.kind === "ok" && w.changed) restoreValues(c, r0, [e.key]);
  }
}

class CheckRollback extends Error {
  constructor() { super("switch-probe check rollback"); }
}

/**
 * Unmet requirement → 409 requirement_not_met and no effect. The requirement
 * is made unmet inside a transaction that is always rolled back (nothing of
 * it is kept): a key requirement switched off through the write path, or the
 * fixture's is_verified badge cleared (isVerifiedBadge).
 */
function checkRequirements(c: Ctx): void {
  for (const e of liveEntries()) {
    if (entryKind(e) !== "switch" || e.requires.length === 0) continue;
    const req = e.requires.find((r) => r === "isVerifiedBadge") ?? e.requires.find((r) => !!findOwnerFeature(r));
    if (!req) {
      addCheck(c, { check: `requirement_unmet:${e.key}`, key: e.key, pass: false, observed: "—", reason: `kravet (${e.requires.join(", ")}) kan ikke gjøres uoppfylt i proben` });
      continue;
    }
    let out: { pass: boolean; observed: string; reason?: string } = { pass: false, observed: "—", reason: "ikke kjørt" };
    const syncDefs = e.surfaces.map((s) => [s, c.readers[caseId(e.key, s)]?.sync] as const).filter(([, f]) => !!f);
    try {
      c.db.transaction(() => {
        // The key off first (an owner may always turn it off), so an accepted
        // «on» would be visible; then the requirement made unmet.
        probeWrite(c, e.key, false);
        if (req === "isVerifiedBadge") {
          c.db.prepare(`UPDATE agents SET is_verified = 0 WHERE id = ? AND ${FIXTURE_PIN}`).run(c.agentId);
        } else {
          probeWrite(c, req, false);
        }
        const stored = () => JSON.stringify(snapshotFixture(c.db, c.agentId));
        const before = maxAuditId(c.db, c.agentId);
        const fp0 = stored();
        const effects0 = JSON.stringify(syncDefs.map(([s, f]) => [s, f!(c.readerCtx).endpoints]));
        const w = probeWrite(c, e.key, true);
        const status = putStatusFor(w);
        const nothing = maxAuditId(c.db, c.agentId) === before && stored() === fp0;
        const effects = syncDefs.map(([s, f]) => [s, f!(c.readerCtx)] as const);
        const noEffect = JSON.stringify(effects.map(([s, o]) => [s, o.endpoints])) === effects0
          && effects.every(([, o]) => Object.values(o.endpoints).every((v) => !v)) && resolvedNow(c).byKey[e.key]?.value !== true;
        const refused = w.kind === "blocked" && w.block === "requirement_not_met";
        out = {
          pass: refused && nothing && noEffect,
          observed: `krav ${req} uoppfylt; PUT true → ${status}${w.kind === "blocked" ? ` ${w.block}` : ""}; ${effects.map(([s, o]) => `${s}: ${describe(o)}`).join("; ") || "ingen synkron leser"}`,
          ...(!refused ? { reason: `ventet 409 requirement_not_met, fikk ${status}` } : !nothing ? { reason: "noe ble lagret" } : !noEffect ? { reason: "effekt tross uoppfylt krav" } : {}),
        };
        throw new CheckRollback();
      })();
    } catch (err: any) {
      if (!(err instanceof CheckRollback)) out = { pass: false, observed: "—", reason: `feil: ${String(err?.message || err)}` };
    }
    addCheck(c, { check: `requirement_unmet:${e.key}`, key: e.key, ...out });
  }
}

/** Each level gives the same effect as setting its switches one by one; «Angre» on the level restores the start. */
function checkLevels(c: Ctx, baseline: ResolvedOwnerFeatures): void {
  const sig0 = effectSignature(c);
  for (const level of OWNER_LEVELS) {
    const keys = level.values.map(([k]) => k).filter((k) => findOwnerFeature(k)?.status === "live");
    restoreValues(c, baseline, keys);
    for (const [k, v] of level.values) {
      if (findOwnerFeature(k)?.status === "live") probeWrite(c, k, v);
    }
    const single = effectSignature(c);
    restoreValues(c, baseline, keys);
    const out = applyOwnerLevel(VERTICAL, c.agentId, level.key, SWITCH_PROBE_ACTOR, { db: c.db, env: c.env });
    const viaLevel = effectSignature(c);
    const skipped = out.kind === "ok" ? out.skipped.map((s) => s.key) : [];
    addCheck(c, {
      check: `level:${level.key}`, pass: out.kind === "ok" && skipped.length === 0 && single === viaLevel,
      observed: `${level.values.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}; ${single === viaLevel ? "samme effekt som enkeltbryterne" : "ULIK effekt"}${skipped.length ? `; hoppet over: ${skipped.join(", ")}` : ""}`,
      ...(out.kind !== "ok" ? { reason: `nivået ble ikke brukt (${out.kind})` } : skipped.length ? { reason: "nivået hoppet over nøkler" } : single !== viaLevel ? { reason: "nivå og enkeltbrytere ga ulik effekt" } : {}),
    });
    if (out.kind === "ok" && out.batchId) {
      const u = undoOwnerChange(VERTICAL, c.agentId, out.batchId, SWITCH_PROBE_ACTOR, { db: c.db, env: c.env });
      const back = effectSignature(c) === sig0;
      addCheck(c, {
        check: `undo:level:${level.key}`, pass: u.kind === "ok" && back,
        observed: `«Angre» → ${u.kind}; ${back ? "effekten er som ved start" : "effekten er IKKE som ved start"}`,
        ...(u.kind !== "ok" ? { reason: `angre ga ${u.kind}` } : !back ? { reason: "angre gjenopprettet ikke effekten" } : {}),
      });
    }
    restoreValues(c, baseline, keys);
  }
}

/** «Angre» on one switch restores the effect (every plain live switch). */
async function checkUndoSingle(c: Ctx, baseline: ResolvedOwnerFeatures): Promise<void> {
  for (const e of liveEntries()) {
    if (entryKind(e) !== "switch") continue;
    const b = baseline.byKey[e.key];
    if (!b || typeof b.value !== "boolean" || !b.changeable) continue;
    const asyncDefs = e.surfaces.map((s) => [s, c.readers[caseId(e.key, s)]] as const).filter(([, d]) => !!d && !d.sync);
    const readAll = async () => {
      const out: Record<string, unknown> = {};
      for (const [s, d] of asyncDefs) out[s] = (await readSafe(d!, c.readerCtx)).obs?.endpoints ?? "error";
      return JSON.stringify(out);
    };
    const sig0 = effectSignature(c);
    const async0 = await readAll();
    const ch = applyOwnerSingleChange(VERTICAL, c.agentId, e.key, !b.value, SWITCH_PROBE_ACTOR, { db: c.db, env: c.env });
    const moved = effectSignature(c) !== sig0;
    if (ch.result.kind !== "ok" || !ch.batchId) {
      addCheck(c, { check: `undo:single:${e.key}`, key: e.key, pass: false, observed: `endring → ${putStatusFor(ch.result)}`, reason: "kunne ikke endre bryteren før angre" });
      restoreValues(c, baseline, [e.key]);
      continue;
    }
    const u = undoOwnerChange(VERTICAL, c.agentId, ch.batchId, SWITCH_PROBE_ACTOR, { db: c.db, env: c.env });
    const back = effectSignature(c) === sig0;
    const asyncBack = asyncDefs.length === 0 || (await readAll()) === async0;
    addCheck(c, {
      check: `undo:single:${e.key}`, key: e.key, pass: moved && u.kind === "ok" && back && asyncBack,
      observed: `${e.key}=${!b.value} → «Angre» → ${u.kind}; ${back && asyncBack ? "effekten er som ved start" : "effekten er IKKE som ved start"}`,
      ...(!moved ? { reason: "endringen hadde ingen synlig effekt" } : u.kind !== "ok" ? { reason: `angre ga ${u.kind}` } : !(back && asyncBack) ? { reason: "angre gjenopprettet ikke effekten" } : {}),
    });
    restoreValues(c, baseline, [e.key]);
  }
}

/**
 * S2f («Bryterproben dekker terskelen med «vis som offentlig»»): the public
 * stats tiles on /produsent/<slug>, rendered as-public, follow the threshold
 * (services/public-stats-threshold.ts). The fixture's own 12-month «Sett» is
 * read, then the page is rendered with the threshold at that count (tiles
 * expected), one above it (no tiles expected) and at the environment's value
 * (PUBLIC_STATS_MIN_VIEWS). The two forced values only live in the probe's
 * async context, so nothing else sees them. With stats.public_counts off
 * no side may show tiles (the check then cannot discriminate and says so).
 */
async function checkPublicStatsThreshold(c: Ctx): Promise<void> {
  const check = "public_stats_threshold";
  try {
    const th = require("../services/public-stats-threshold") as typeof import("../services/public-stats-threshold");
    const { publicFieldChoices } = require("./enforce") as typeof import("./enforce");
    const { runAsPublicView } = require("../services/agent-visibility") as typeof import("../services/agent-visibility");
    const { slugify } = require("../utils/slug") as typeof import("../utils/slug");
    const f = c.readerCtx.fixture;
    // The same inputs the page uses (seo.ts: process env, the shared DB handle).
    const views = th.publicStatsHumanViews(c.db, f.id, `/produsent/${slugify(f.name)}`);
    const choices = publicFieldChoices(f.id, { db: c.db });
    const countsOn = !choices || choices.publicCounts;
    const envMin = th.publicStatsMinViews();
    const kit = visKit(c.readerCtx);
    const tiles = (): Promise<boolean | string> => runAsPublicView(async () => {
      const r = await invokeHandler(c.readerCtx, kit.handlers.produsent, probeReq(c.readerCtx, `/produsent/${f.slug}`, { params: { slug: f.slug } }));
      const h = typeof r.body === "string" ? r.body : "";
      if (r.status !== 200 || !h) return `HTTP ${r.status}`;
      return h.includes('class="pf-stat" data-stat="human"');
    });
    const cases: Array<{ min: number; label: string; forced: boolean }> = [
      { min: views, label: `terskel ${views}`, forced: true },
      { min: views + 1, label: `terskel ${views + 1}`, forced: true },
      { min: envMin, label: `PUBLIC_STATS_MIN_VIEWS=${envMin}`, forced: false },
    ];
    const parts: string[] = [];
    let ok = true;
    for (const k of cases) {
      const expected = countsOn && (k.min <= 0 || views >= k.min);
      const seen = k.forced ? await th.runWithPublicStatsMinViews(k.min, tiles) : await tiles();
      const pass = seen === expected;
      ok = ok && pass;
      parts.push(`${k.label}: fliser ${seen === true ? "vises" : seen === false ? "vises ikke" : `feil (${seen})`} (forventet ${expected ? "vises" : "vises ikke"})`);
    }
    addCheck(c, {
      check, key: "stats.public_counts", pass: ok,
      observed: `«Sett» siste 12 mnd: ${views}; stats.public_counts ${countsOn ? "på" : "av"}; ${parts.join("; ")}`,
      ...(!ok ? { reason: "profilsiden følger ikke terskelen" } : !countsOn ? { reason: "stats.public_counts er av: ingen side viser fliser, så kontrollen skiller ikke" } : {}),
    });
  } catch (err: any) {
    addCheck(c, { check, key: "stats.public_counts", pass: false, observed: "—", reason: `kontrollen feilet: ${String(err?.message || err)}` });
  }
}

/** A live switch without surfaces (comms.news): the write path and the change log only. */
function checkNoSurface(c: Ctx, e: OwnerFeatureEntry, baseline: OwnerFeatureValue): void {
  const dirs = directionsFor("switch", baseline);
  const parts: string[] = [];
  let ok = true;
  for (const d of dirs) {
    const value = d === "on";
    const before = maxAuditId(c.db, c.agentId);
    const w = probeWrite(c, e.key, value);
    const logged = w.kind === "ok" && w.changed && changeLogged(c, e.key, value, before);
    const val = resolvedNow(c).byKey[e.key]?.value;
    ok = ok && w.kind === "ok" && logged && val === value;
    parts.push(`${d}: ${putStatusFor(w)}, verdi ${val}, logget ${logged ? "ja" : "nei"}`);
  }
  addCheck(c, { check: `no_surface:${e.key}`, key: e.key, pass: ok, observed: parts.join("; "), ...(ok ? {} : { reason: "skriving eller endringslogg feilet" }) });
}

function readerContext(db: any, agentId: string, env: NodeJS.ProcessEnv): ProbeReaderContext {
  return { db, env, fixture: loadFixture(db, agentId), adminKey: env.ADMIN_KEY || env.ANALYTICS_ADMIN_KEY || "", created: new Map() };
}

/** Dry run: the plan and the starting values. Reads only. */
export function dryRunSwitchProbe(agentId: string, opts: SwitchProbeOptions = {}): SwitchProbeResult & { plan: SwitchProbePlan } {
  const db = opts.db ?? getDb();
  const env = opts.env ?? process.env;
  const started = new Date().toISOString();
  const plan = planSwitchProbe(db, agentId, env, { ...defaultSwitchProbeReaders(), ...(opts.readers || {}) });
  const result: SwitchProbeResult & { plan: SwitchProbePlan } = {
    ok: true, dry_run: true, agent_id: agentId, started_at: started, finished_at: new Date().toISOString(),
    env_flags: plan.env_flags, rows: [], checks: [], pass: 0, fail: 0, restored: true, restore_diff: [], side_effects: [],
    ready_for_daniel_test: false, markdown: renderSwitchProbePlanMarkdown(plan, started), plan,
  };
  return result;
}

/**
 * The full probe. Refuses a second concurrent run (SwitchProbeBusyError).
 * Always restores the snapshot in `finally`; a run that aborts returns ok:false
 * with the error, the rows so far and the restore outcome.
 */
export async function runSwitchProbe(agentId: string, opts: SwitchProbeOptions = {}): Promise<SwitchProbeResult> {
  if (running) throw new SwitchProbeBusyError();
  running = true;
  const db = opts.db ?? getDb();
  const env = opts.env ?? process.env;
  const started = new Date().toISOString();
  const c: Ctx = {
    db, env, agentId,
    readers: {},
    // Set inside the try (loadFixture reads the DB), so the run lock is always released.
    readerCtx: { db, env, fixture: null as unknown as ProbeFixture, adminKey: "", created: new Map<string, Map<number, string>>() },
    maxWaitMs: Math.min(Math.max(0, Math.floor(opts.maxWaitMs ?? SWITCH_PROBE_DEFAULT_MAX_WAIT_MS)), SWITCH_PROBE_MAX_WAIT_CAP_MS),
    rows: [], checks: [], afterFlip: opts.afterFlip, write: opts.write ?? setOwnerFeatureValue,
  };
  let snap: FixtureSnapshot | null = null;
  let error: string | undefined;
  let restored = false;
  let restoreDiff: Array<{ table: string; before: unknown; after: unknown }> = [];
  let sideEffects: SideEffectCount[] = [];
  const seStart = sideEffectStart(db);
  try {
    c.readers = { ...defaultSwitchProbeReaders(), ...(opts.readers || {}) };
    c.readerCtx = readerContext(db, agentId, env);
    snap = snapshotFixture(db, agentId);
    const baseline = resolvedNow(c);
    for (const e of liveEntries()) {
      const kind = entryKind(e);
      const b = baseline.byKey[e.key]?.value ?? null;
      if (e.surfaces.length === 0) {
        if (kind === "switch") checkNoSurface(c, e, b);
        restoreValues(c, baseline, [e.key]);
        continue;
      }
      if (kind === "switch") await probeSwitch(c, e, b);
      else if (kind === "locked") await probeLocked(c, e);
      else if (kind === "guarantee") await probeGuarantee(c, e);
      else if (kind === "confirm_by_email") await probeConfirmByEmail(c, e);
      else {
        for (const s of e.surfaces) {
          pushRow(c, { key: e.key, surface: s, direction: "on", pass: false, observed: "—", expected: "—", ms_to_effect: null, write_status: null, change_logged: null, discriminating: false, reason: `typen ${e.type} støttes ikke av proben` });
        }
      }
      restoreValues(c, baseline, liveEntries().map((x) => x.key));
    }
    checkComingSoon(c);
    checkRequirements(c);
    checkLevels(c, baseline);
    await checkUndoSingle(c, baseline);
    await checkPublicStatsThreshold(c);
  } catch (e: any) {
    error = String(e?.message || e);
  } finally {
    try {
      if (snap) {
        restoreSnapshot(db, agentId, snap);
        restoreDiff = maskDeep(diffSnapshots(snap, snapshotFixture(db, agentId)));
        restored = restoreDiff.length === 0;
      }
    } catch (e: any) {
      restored = false;
      error = error ? `${error}; restore: ${String(e?.message || e)}` : `restore: ${String(e?.message || e)}`;
    }
    try {
      sideEffects = removeSideEffects(c.readerCtx, seStart);
    } catch (e: any) {
      error = error ? `${error}; side effects: ${String(e?.message || e)}` : `side effects: ${String(e?.message || e)}`;
    }
    running = false;
  }
  c.checks.push({
    check: "restore", result: restored ? "PASS" : "FAIL",
    observed: restored ? "alle lagrede valg er som ved start (eksakt)" : `avvik i: ${restoreDiff.map((d) => d.table).join(", ") || "ukjent"}`,
    ...(restored ? {} : { reason: "gjenopprettingen ble ikke identisk" }),
  });
  const pass = c.rows.filter((r) => r.result === "PASS").length + c.checks.filter((x) => x.result === "PASS").length;
  const fail = c.rows.filter((r) => r.result === "FAIL").length + c.checks.filter((x) => x.result === "FAIL").length;
  const result: SwitchProbeResult = {
    ok: !error,
    dry_run: false,
    agent_id: agentId,
    started_at: started,
    finished_at: new Date().toISOString(),
    env_flags: envFlags(env),
    rows: c.rows,
    checks: c.checks,
    pass,
    fail,
    restored,
    restore_diff: restoreDiff,
    side_effects: sideEffects,
    ready_for_daniel_test: !error && fail === 0 && restored && c.rows.length > 0,
    ...(error ? { error } : {}),
    markdown: "",
  };
  result.markdown = renderSwitchProbeMarkdown(result);
  return result;
}

// ── Report ────────────────────────────────────────────────────────────────

const cell = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** The dry-run plan as Markdown (nothing has run). */
export function renderSwitchProbePlanMarkdown(plan: SwitchProbePlan, at: string): string {
  const lines: string[] = [`# Mine valg — bryterprobe, plan (tørrkjøring) ${at.slice(0, 10)}`, ""];
  lines.push(`- Testprodusent: \`${plan.agent_id}\` (segment ${plan.segment}, i allowlist: ${plan.allowlisted ? "ja" : "nei"})`);
  lines.push(`- Planlagte rader: ${plan.rows.length} · uten effektleser: ${plan.rows.filter((r) => !r.reader).length}`, "");
  lines.push("| Nøkkel | Flate | Retning | Type | Effektleser |", "|---|---|---|---|---|");
  for (const r of plan.rows) lines.push(`| ${r.key} | ${r.surface} | ${r.direction} | ${r.kind} | ${r.reader ? "ja" : "NEI"} |`);
  lines.push("", "## Startverdier", "", "| Nøkkel | Verdi | Kilde | Sperre |", "|---|---|---|---|");
  for (const b of plan.baseline) lines.push(`| ${b.key} | ${cell(JSON.stringify(b.value))} | ${b.source} | ${b.block ?? ""} |`);
  lines.push("", "## Ekstra kontroller", "");
  for (const c of plan.checks) lines.push(`- ${c}`);
  lines.push("");
  return lines.join("\n");
}

/** Ready-to-commit report (reports/<date>-mine-valg-bryterprobe.md in the A2A repo). */
export function renderSwitchProbeMarkdown(r: SwitchProbeResult): string {
  const date = r.started_at.slice(0, 10);
  const lines: string[] = [];
  lines.push(`# Mine valg — bryterprobe ${date}`, "");
  lines.push(`- Testprodusent: \`${r.agent_id}\``);
  lines.push(`- Start: ${r.started_at} · slutt: ${r.finished_at}`);
  lines.push(`- Resultat: **${r.pass} PASS / ${r.fail} FAIL** — ${r.ready_for_daniel_test ? "100 % PASS: klar for `ready_for_daniel_test`" : "IKKE klar for `ready_for_daniel_test` (krever 100 % PASS)"}`);
  lines.push(`- Gjenopprettet til startpunktet: ${r.restored ? "ja (eksakt)" : "NEI"}`);
  if (r.error) lines.push(`- Kjøringen ble avbrutt: ${cell(r.error)}`);
  lines.push("", "## Miljøflagg", "", "| Flagg | Verdi |", "|---|---|");
  for (const [k, v] of Object.entries(r.env_flags)) lines.push(`| ${k} | ${v === null ? "(ikke satt)" : cell(v)} |`);
  lines.push("", "## Bryter × flate × retning", "");
  lines.push("«Skiller» = nei: en avvist skriving (låst valg / løfte / bekreftelse på e-post) der flaten skal vise det samme før og etter. En leser som aldri endrer seg ville også bestått, så raden viser bare at skrivingen ble avvist, ikke at flaten reagerer på bryteren.", "");
  lines.push("| Nøkkel | Flate | Retning | Resultat | Skiller | Observert | Tid til effekt (ms) | Merknad |", "|---|---|---|---|---|---|---|---|");
  for (const row of r.rows) {
    lines.push(`| ${row.key} | ${row.surface} | ${row.direction} | ${row.result} | ${row.discriminating ? "ja" : "nei"} | ${cell(row.observed)} | ${row.ms_to_effect ?? "—"} | ${cell(row.reason ?? "")} |`);
  }
  lines.push("", "## Ekstra kontroller", "", "| Kontroll | Resultat | Observert | Merknad |", "|---|---|---|---|");
  for (const ch of r.checks) lines.push(`| ${cell(ch.check)} | ${ch.result} | ${cell(ch.observed)} | ${cell(ch.reason ?? "")} |`);
  lines.push("", "## Sideeffekter av lesingene", "", "Offentlige lesestier logger egne rader. Proben fanger bare radene som skrives i den synkrone delen av sine egne kall (rowid + id / agent_id) og sletter bare dem, én og én. En rad skrevet etter en `await` fanges ikke og blir liggende (lekkasje, aldri for mye slettet). «Igjen etter kjøringen» teller testprodusentens rader fra kjøringsvinduet som fortsatt finnes (kan også være andre admin-visninger).", "", "| Tabell | Laget av proben | Slettet igjen | Igjen etter kjøringen |", "|---|---|---|---|");
  for (const x of r.side_effects) lines.push(`| ${x.table} | ${x.created} | ${x.removed} | ${x.left_after_run ?? "—"} |`);
  if (r.restore_diff.length) {
    lines.push("", "## Avvik etter gjenoppretting", "");
    for (const d of r.restore_diff) lines.push(`- ${d.table}: før ${cell(JSON.stringify(d.before))} · etter ${cell(JSON.stringify(d.after))}`);
  }
  lines.push("", "## FUNN TIL OPPFØLGING");
  const fails = [...r.rows.filter((x) => x.result === "FAIL").map((x) => ({ id: `${x.key}-${x.surface}-${x.direction}`, text: `${x.key} × ${x.surface} (${x.direction}): ${x.reason ?? "FAIL"}` })),
    ...r.checks.filter((x) => x.result === "FAIL").map((x) => ({ id: x.check, text: `${x.check}: ${x.reason ?? "FAIL"}` }))];
  if (r.error) fails.unshift({ id: "run-aborted", text: `kjøringen ble avbrutt: ${r.error}` });
  if (fails.length === 0) lines.push("- [FUNN] ingen");
  const slug = (s: string) => `bryterprobe-${s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`.slice(0, 80);
  for (const f of fails) lines.push(`- [FUNN] ${slug(f.id)} · P1 · ${cell(f.text)} · første-sett: ${date} · gjentakelser: 1`);
  lines.push("");
  return lines.join("\n");
}
