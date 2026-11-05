// ─── Opplevagent «Mine valg» — the switch probe («bryterprobe») for gårdssalg ─
// dev-request 2026-10-22-opplevagent-mine-valg-gardssalg, «v2 for
// Opplevagent», slice O2b. Same pattern as the RFB probe
// (owner-features/switch-probe.ts, S2d-3): against the hidden gårdssalg test
// producer, through the owner write path the «Mine valg» tab uses, switch
// every `live` entry off and on, read every gårdssalg surface that should
// react, check the change log, and put everything back exactly. One row per
// key × surface × direction (PASS / FAIL / IKKE OBSERVERBAR, observed value,
// time to effect). Locked choices and promises: the write is refused (409)
// and the surface does not change («Skiller = nei»). 100 % PASS with zero
// «ikke observerbar» rows is required before ready_for_daniel_test (AC 26).
//
// NOT_OBSERVABLE («ikke observerbar», the RFB lesson of 29.10): a surface
// whose reader does not show the test row in the starting state, where the
// row should be visible, proves nothing either way (an «off» row would pass
// with no evidence). Every row of that key × surface is NOT_OBSERVABLE with
// the reason — never PASS — and blocks readiness like a FAIL.
//
// Who is touched. Only the gårdssalg test producer: experience_providers
// with is_test_provider = 1 AND org_nr = 'TEST000000' AND catalog_hidden = 1
// AND catalog_hidden_reason IN ('test_fixture', 'owner_pause') (O2a: the
// fixture state, or the owner's own pause of it), in the allowlist
// (`gardssalg:<id>` in OWNER_FEATURES_ALLOWED_SUBJECTS), with
// OA_OWNER_FEATURES_ENABLED on. The owner writes go through
// setOwnerFeatureValue / applyOwnerLevel / undoOwnerChange for that id (the
// adapters write booking_live and the owner pause through the claim
// service, which never makes the test row public). Every UPDATE / DELETE
// this file issues itself (restore, the rolled-back checks) repeats the
// fixture pin in its own WHERE clause.
//
// How each surface is read (in-process, nothing on the wire):
//   visibility  the real route handlers and MCP tools, run inside
//               runAsPublicView() («Vis som offentlig», O2a: the hidden test
//               row reads as not hidden, nothing else changes), as internal
//               admin traffic:
//                 profile_html   GET /kategori/gardssalg/produsent/:slug
//                 listing_html   GET / (forside), GET /kategori/gardssalg
//                                (paged), GET /kategori/gardssalg/:type (when
//                                the producer type has a page), the map
//                                points the catalogue page draws
//                                (listGardssalgProviderMapPoints), the /reise
//                                corridor's gårdssalg step
//                                (loadGardssalgCandidates; the routing itself
//                                calls an outside service and is not run),
//                                GET /sok?q=<name>
//                 mcp_search     discover_gardssalg {query: <name>}
//                 mcp_info       book_gardssalg's provider lookup
//                                (resolveGardssalgProviderByQuery, surface
//                                mcp). get_experience reads `experiences`
//                                rows, never a gårdssalg producer.
//                 rest_card      GET /api/opplevelser/discover?category=
//                                gardssalg_smaking&q=<name>
//                 sitemap        GET /sitemap.xml (as-public: built fresh,
//                                the cache IndexNow reads is not touched)
//                 a2a            POST /a2a message/send (gårdssalg intent,
//                                near the producer's own place)
//   booking     the booking note on the discover surfaces above (same
//               as-public reads), the reserve button on the profile page,
//               and the booking gate:
//                 gate           isBookingPaused() + gardssalgBookingPausedByOwner()
//                                — the two checks every channel makes
//                 rest_book      POST /api/opplevelser/book   } outside the
//                 mcp_book       MCP book_gardssalg           } as-public view
//                 form_post      POST /kategori/gardssalg/book/:slug (inside
//                                the view: its slug lookup is the public one)
//               Every channel request carries a slot in the past
//               (SWITCH_PROBE_PAST_SLOT). All three channels check the pause
//               gates first and then the shared slot choke point
//               (checkBookingSlotAllowed), which refuses a past slot with a
//               hard 400 BEFORE createBooking() — so an open gate answers
//               «slot refused», a closed one «tar ikke imot» / «ikke
//               aktivert», and no request is ever created and no e-mail ever
//               sent. Before any channel call the probe checks that the slot
//               is still refused (slotBoundsError), and around every call it
//               counts the producer's gardssalg_bookings rows (a new row
//               aborts the reader with an error).
//   e-mail / jobs  the send decision only, nothing is sent:
//                 email:booking_request   the gate is open and the profile
//                                         has an address for requests
//                 email:booking_reminder, job:booking_previsit
//                                         sendGatedProducerEmail's gate
//                                         (isBookingPaused + address)
//                 email:outreach          unsubscribeHeaderValues(…,
//                                         "experiences"): signed List-Unsubscribe
//                 job:gardssalg_content_refresh  applyGardssalgProviderContent()
//                                         on an owner-locked text, inside a
//                                         transaction that is always rolled back
//                 job:rfb_knowledge_enrich isGardssalgFieldOwnerLocked() — the
//                                         guard every gårdssalg content writer
//                                         calls — on the same rolled-back lock
// Restore: the fixture's owner choices (owner_feature_settings, the level
// choice, the intro answer) and its experience_providers columns
// (booking_live, catalog_hidden + reason, the admin brake, epost,
// content_source, about_text, field_provenance, updated_at) are snapshotted
// first and put back exactly in `finally`; the result says `restored` and
// lists any difference. The public read paths log their own rows
// (conversations, analytics_queries): rows written in the synchronous
// part of one of the probe's own calls are captured by rowid + id and
// deleted again, one by one (as in the RFB probe).

import { getDb } from "../database/init";
import {
  GARDSSALG_OWNER_FEATURE_REGISTRY,
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
  GARDSSALG_OWNER_LEVELS,
  applyOwnerLevel,
  ownerFeatureChangeLog,
  undoOwnerChange,
  type OwnerActor,
} from "./changes";
import { isSubjectAllowedForOwnerFeatures } from "./allowlist";
import { oaOwnerFeaturesEnabled } from "./gardssalg";
import {
  PROBE_RESULT_LABEL,
  maskDeep,
  putStatusFor,
  type ProbeDirection,
  type ProbeRowResult,
  type ProbeVerdict,
  type SideEffectCount,
  type SwitchProbeCheck,
  type SwitchProbeRow,
} from "./switch-probe";

const VERTICAL = "gardssalg" as const;
const REGISTRY = GARDSSALG_OWNER_FEATURE_REGISTRY;
export const GARDSSALG_SWITCH_PROBE_ACTOR: OwnerActor = { actor: "admin", detail: "switch-probe" };
const RESTORE_ACTOR_DETAIL = "switch-probe:restore";
/** O2a: the test producer's org_nr (POST /admin/gardssalg/test-provider). */
export const GARDSSALG_TEST_ORG_NR = "TEST000000";
/** The only rows the probe may touch (also repeated in every UPDATE it issues). */
export const GARDSSALG_FIXTURE_PIN =
  `is_test_provider = 1 AND org_nr = '${GARDSSALG_TEST_ORG_NR}' AND catalog_hidden = 1 ` +
  `AND catalog_hidden_reason IN ('test_fixture', 'owner_pause')`;
export const GARDSSALG_SWITCH_PROBE_EFFECT_MAX_MS = 60 * 60 * 1000;
export const GARDSSALG_SWITCH_PROBE_DEFAULT_MAX_WAIT_MS = 2000;
export const GARDSSALG_SWITCH_PROBE_MAX_WAIT_CAP_MS = 30_000;
const POLL_MS = 100;
const HEAVY_POLL_MS = 2000;
const HANDLER_TIMEOUT_MS = 20_000;
const CATALOG_MAX_PAGES = 40;
/**
 * The slot every booking-channel request carries: in the past, so the shared
 * slot choke point refuses it (hard 400) before any request is created.
 */
export const SWITCH_PROBE_PAST_SLOT = "2000-01-03T12:00:00.000Z";
const PROBE_GUEST = { guest_name: "Bryterprobe (sendes aldri)", guest_email: "switch-probe@example.invalid", party_size: 1 };
const PROBE_HOST = "opplevagent.no";
const PROBE_UA = "opplevagent-switch-probe/1 (internal)";

/** Env flags the probe reports. */
export const GARDSSALG_SWITCH_PROBE_ENV_FLAGS = [
  "OA_OWNER_FEATURES_ENABLED",
  "OA_OWNER_FEATURES_SWITCH_PROBE_ENABLED",
  "BOOKING_DISPATCH_ENABLED",
  "OUTREACH_UNSUBSCRIBE_ENABLED",
  "BOOKING_MAX_DAYS_AHEAD",
] as const;

/** Rows whose effect only exists with an env flag on: flag off → FAIL with that reason. */
export const GARDSSALG_SWITCH_PROBE_FLAG_DEPENDENCIES: Readonly<Record<string, string>> = {
  "comms.unsubscribe × email:outreach": "OUTREACH_UNSUBSCRIBE_ENABLED",
  // The booking note on the discover surfaces (gardssalgBookingStatus) reads
  // isBookingPaused(booking_live) without the test-row exception: with the
  // global dispatch switch off it says «paused» for every producer, the test
  // row included, whatever the owner chose — the channels themselves still
  // let the test row through. So the note only follows the switches with it on.
  "booking.enabled × mcp_search": "BOOKING_DISPATCH_ENABLED",
  "booking.enabled × rest_card": "BOOKING_DISPATCH_ENABLED",
  "booking.enabled × a2a": "BOOKING_DISPATCH_ENABLED",
  "booking.pause × mcp_search": "BOOKING_DISPATCH_ENABLED",
  "booking.pause × rest_card": "BOOKING_DISPATCH_ENABLED",
  "booking.pause × a2a": "BOOKING_DISPATCH_ENABLED",
};
const FLAG_OFF_REASON = "flag off in this environment";

/** Side-effect tables of the public read paths (lokal.db): table → the column that pins a captured row. */
const SIDE_EFFECT_PIN: Record<string, string> = { conversations: "id", analytics_queries: "id" };
const SIDE_EFFECT_TABLES = Object.keys(SIDE_EFFECT_PIN);

/** Brand rule (AC 28): no output of the Opplevagent probe names the other platform. */
const OTHER_BRAND_RE = /rett\s*fra\s*bonden|rettfrabonden/gi;

export interface GardssalgSwitchProbeResult {
  ok: boolean;
  dry_run: boolean;
  provider_id: string;
  started_at: string;
  finished_at: string;
  env_flags: Record<string, string | null>;
  allowlisted: boolean;
  rows: SwitchProbeRow[];
  checks: SwitchProbeCheck[];
  pass: number;
  fail: number;
  not_observable: number;
  restored: boolean;
  restore_diff: Array<{ table: string; before: unknown; after: unknown }>;
  side_effects: SideEffectCount[];
  ready_for_daniel_test: boolean;
  error?: string;
  markdown: string;
}

export interface GardssalgSwitchProbePlanRow {
  key: string;
  surface: string;
  direction: ProbeDirection;
  kind: EntryKind;
  reader: boolean;
}

export interface GardssalgSwitchProbePlan {
  provider_id: string;
  verified_owner: boolean;
  allowlisted: boolean;
  env_flags: Record<string, string | null>;
  baseline: Array<{ key: string; type: string; value: OwnerFeatureValue | string; source: string; block: string | null }>;
  observability: string[];
  rows: GardssalgSwitchProbePlanRow[];
  checks: string[];
}

// ── Databases ─────────────────────────────────────────────────────────────

function experiencesDb(): any {
  return (require("../database/db-factory") as typeof import("../database/db-factory")).getDb("experiences");
}

// ── Fixture selection ─────────────────────────────────────────────────────

export type GardssalgFixtureSelection =
  | { ok: true; providerId: string }
  | { ok: false; status: number; error: string; detail: string; ids?: string[] };

/**
 * The ONE row the probe may touch. Read-only. `provider_id` given → it must
 * be the gårdssalg test producer (GARDSSALG_FIXTURE_PIN); none given → the
 * single such row. OA_OWNER_FEATURES_ENABLED must be on and the row in
 * OWNER_FEATURES_ALLOWED_SUBJECTS (`gardssalg:<id>`).
 */
export function selectGardssalgSwitchProbeFixture(
  expDb: any, providerId: string | undefined, env: NodeJS.ProcessEnv = process.env,
): GardssalgFixtureSelection {
  if (!oaOwnerFeaturesEnabled(env)) {
    return {
      ok: false, status: 409, error: "owner_features_off",
      detail: "OA_OWNER_FEATURES_ENABLED er av: «Mine valg» for gårdssalg virker ikke i dette miljøet. Ingenting er endret.",
    };
  }
  let id: string;
  if (providerId !== undefined) {
    const row = expDb.prepare(`SELECT id FROM experience_providers WHERE id = ?`).get(providerId) as { id: string } | undefined;
    if (!row) return { ok: false, status: 404, error: "provider_not_found", detail: "Fant ingen gårdssalg-produsent med denne id-en. Ingenting er endret." };
    const pinned = expDb.prepare(`SELECT id FROM experience_providers WHERE id = ? AND ${GARDSSALG_FIXTURE_PIN}`).get(providerId);
    if (!pinned) {
      return {
        ok: false, status: 409, error: "not_a_test_fixture",
        detail: `Bryterproben kjører bare mot testprodusenten (is_test_provider=1, org_nr=${GARDSSALG_TEST_ORG_NR}, skjult som test_fixture). Ingenting er endret.`,
      };
    }
    id = row.id;
  } else {
    const rows = expDb.prepare(`SELECT id FROM experience_providers WHERE ${GARDSSALG_FIXTURE_PIN} ORDER BY created_at, id`).all() as Array<{ id: string }>;
    if (rows.length === 0) {
      return { ok: false, status: 404, error: "no_test_fixture", detail: "Ingen testprodusent for gårdssalg (POST /admin/gardssalg/test-provider). Ingenting er endret." };
    }
    if (rows.length > 1) {
      return { ok: false, status: 409, error: "multiple_test_fixtures", detail: "Oppgi provider_id. Ingenting er endret.", ids: rows.map((r) => r.id) };
    }
    id = rows[0].id;
  }
  if (!isSubjectAllowedForOwnerFeatures(VERTICAL, id, env)) {
    return {
      ok: false, status: 409, error: "not_allowlisted",
      detail: "Testprodusenten står ikke i OWNER_FEATURES_ALLOWED_SUBJECTS (gardssalg:<id>). Ingenting er endret.",
    };
  }
  return { ok: true, providerId: id };
}

// ── Small helpers ─────────────────────────────────────────────────────────

function envFlags(env: NodeJS.ProcessEnv): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const k of GARDSSALG_SWITCH_PROBE_ENV_FLAGS) out[k] = env[k] ?? null;
  return out;
}

function flagOn(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name];
  // bookingDispatchEnabled() (booking-store.ts) accepts only the literal "true".
  if (name === "BOOKING_DISPATCH_ENABLED") return v === "true";
  return v === "1" || v === "true";
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function caseId(key: string, surface: string): string {
  return `${key} × ${surface}`;
}

type EntryKind = "switch" | "locked" | "guarantee";

function entryKind(e: OwnerFeatureEntry): EntryKind | null {
  if (e.type === "switch") return "switch";
  if (e.type === "locked") return "locked";
  if (e.type === "guarantee") return "guarantee";
  return null;
}

function directionsFor(kind: EntryKind, baseline: OwnerFeatureValue): ProbeDirection[] {
  switch (kind) {
    case "switch": return baseline === false ? ["on", "off"] : ["off", "on"];
    case "locked": return ["off", "on", "parent_off", "parent_on"];
    case "guarantee": return ["off", "on"];
  }
}

function liveEntries(): OwnerFeatureEntry[] {
  return REGISTRY.filter((e) => e.status === "live");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tableExists(db: any, name: string): boolean {
  return !!db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

// ── Snapshot / exact restore ──────────────────────────────────────────────

/** The experience_providers columns the probe (or the owner write path it drives) can change. */
const PROVIDER_COLUMNS = [
  "booking_live", "catalog_hidden", "catalog_hidden_reason", "booking_admin_brake_at", "booking_admin_brake_note",
  "epost", "content_source", "about_text", "field_provenance", "updated_at",
] as const;

interface GardssalgFixtureSnapshot {
  owner_feature_settings: any[];
  owner_feature_level_choice: any[];
  owner_feature_intro: any[];
  experience_providers: Record<string, unknown> | null;
}

export function snapshotGardssalgFixture(lokalDb: any, expDb: any, providerId: string): GardssalgFixtureSnapshot {
  const rows = (table: string) =>
    tableExists(lokalDb, table)
      ? (lokalDb.prepare(`SELECT * FROM ${table} WHERE vertical = ? AND subject_id = ? ORDER BY rowid`).all(VERTICAL, providerId) as any[])
      : [];
  return {
    owner_feature_settings: rows("owner_feature_settings"),
    owner_feature_level_choice: rows("owner_feature_level_choice"),
    owner_feature_intro: rows("owner_feature_intro"),
    experience_providers: (expDb.prepare(`SELECT ${PROVIDER_COLUMNS.join(", ")} FROM experience_providers WHERE id = ?`).get(providerId) as Record<string, unknown> | undefined) ?? null,
  };
}

function diffSnapshots(a: GardssalgFixtureSnapshot, b: GardssalgFixtureSnapshot): Array<{ table: string; before: unknown; after: unknown }> {
  const out: Array<{ table: string; before: unknown; after: unknown }> = [];
  for (const k of Object.keys(a) as Array<keyof GardssalgFixtureSnapshot>) {
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

/**
 * Puts the snapshot back exactly. experience_providers: one UPDATE pinned to
 * the fixture; lokal.db: the gårdssalg owner rows of this subject replaced.
 * Keys whose resolved value this changes get one audit row (actor admin,
 * detail switch-probe:restore), so the owner's change log shows it.
 */
function restoreSnapshot(lokalDb: any, expDb: any, providerId: string, snap: GardssalgFixtureSnapshot): void {
  if (!expDb.prepare(`SELECT id FROM experience_providers WHERE id = ? AND ${GARDSSALG_FIXTURE_PIN}`).get(providerId)) {
    throw new Error("restore refused: the row is no longer the gårdssalg test fixture");
  }
  const before = resolveOwnerFeatures(VERTICAL, providerId, { db: lokalDb, registry: REGISTRY });
  if (snap.experience_providers) {
    const p = snap.experience_providers;
    const r = expDb
      .prepare(`UPDATE experience_providers SET ${PROVIDER_COLUMNS.map((c) => `${c} = @${c}`).join(", ")} WHERE id = @__id AND ${GARDSSALG_FIXTURE_PIN}`)
      .run({ ...p, __id: providerId });
    if (r.changes !== 1) throw new Error("restore refused: experience_providers row not pinned");
  }
  lokalDb.transaction(() => {
    for (const t of ["owner_feature_settings", "owner_feature_level_choice", "owner_feature_intro"] as const) {
      if (!tableExists(lokalDb, t)) continue;
      lokalDb.prepare(`DELETE FROM ${t} WHERE vertical = ? AND subject_id = ?`).run(VERTICAL, providerId);
      insertRows(lokalDb, t, snap[t]);
    }
    const after = resolveOwnerFeatures(VERTICAL, providerId, { db: lokalDb, registry: REGISTRY });
    const now = new Date().toISOString();
    for (const f of after.features) {
      const b = before.byKey[f.key];
      if (!b || sameValue(b.value, f.value)) continue;
      const e = findOwnerFeature(f.key, REGISTRY);
      if (!e || e.status !== "live") continue;
      lokalDb.prepare(
        `INSERT INTO owner_feature_audit (vertical, subject_id, key, old_json, new_json, actor, actor_detail, at)
         VALUES (?, ?, ?, ?, ?, 'admin', ?, ?)`,
      ).run(VERTICAL, providerId, f.key, JSON.stringify(b.value ?? null), JSON.stringify(f.value ?? null), RESTORE_ACTOR_DETAIL, now);
    }
  })();
}

// ── Reader context and the in-process surfaces ────────────────────────────

/** One observation: per endpoint, is the effect there? null = the endpoint did not show the test row at all. */
export interface GardssalgSurfaceObservation {
  endpoints: Record<string, boolean | null>;
  detail?: string;
  /** «on» needs every endpoint (single-object surfaces); unset = at least one (list surfaces). */
  requireAll?: boolean;
  /** Why the test row cannot appear on this surface (used as the IKKE OBSERVERBAR reason). */
  unobservableHint?: string;
}

export interface GardssalgProbeFixture {
  id: string;
  name: string;
  slug: string;
  producerType: string | null;
  kommune: string | null;
  fylke: string | null;
  lat: number | null;
  lon: number | null;
  /** Never printed. */
  epost: string | null;
}

export interface GardssalgProbeReaderContext {
  lokalDb: any;
  expDb: any;
  env: NodeJS.ProcessEnv;
  adminKey: string;
  fixture: GardssalgProbeFixture;
  /** Rows the read paths created, per side-effect table: rowid → its pin. */
  created: Map<string, Map<number, string>>;
}

export type GardssalgSurfaceReader = (ctx: GardssalgProbeReaderContext) => Promise<GardssalgSurfaceObservation> | GardssalgSurfaceObservation;

export interface GardssalgSurfaceReaderDef {
  read: GardssalgSurfaceReader;
  /** Synchronous variant (usable inside a rolled-back transaction and in the effect signature). */
  sync?: (ctx: GardssalgProbeReaderContext) => GardssalgSurfaceObservation;
  observe: string;
  pollMs?: number;
  /** The test row must be seen on the surface in the starting state (discover / page reads). */
  needsVisibleRow?: boolean;
}

function loadFixture(expDb: any, providerId: string): GardssalgProbeFixture {
  const r = expDb
    .prepare(`SELECT id, navn, slug, producer_type, kommune, fylke, lat, lon, epost FROM experience_providers WHERE id = ?`)
    .get(providerId) as any;
  return {
    id: providerId,
    name: String(r?.navn || ""),
    slug: String(r?.slug || ""),
    producerType: r?.producer_type ?? null,
    kommune: r?.kommune ?? null,
    fylke: r?.fylke ?? null,
    lat: typeof r?.lat === "number" ? r.lat : null,
    lon: typeof r?.lon === "number" ? r.lon : null,
    epost: typeof r?.epost === "string" && r.epost.trim() ? r.epost.trim() : null,
  };
}

function maxRowid(db: any, table: string): number {
  try { return Number((db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${table}`).get() as { m: number }).m) || 0; } catch { return -1; }
}

/** Runs the synchronous part of one call and records the rows it created in the side-effect tables. */
function captureSync<T>(ctx: GardssalgProbeReaderContext, fn: () => T): T {
  const before = SIDE_EFFECT_TABLES.map((t) => maxRowid(ctx.lokalDb, t));
  try {
    return fn();
  } finally {
    SIDE_EFFECT_TABLES.forEach((t, i) => {
      if (before[i] < 0) return;
      const pin = SIDE_EFFECT_PIN[t];
      const ids = ctx.lokalDb.prepare(`SELECT rowid AS r, ${pin} AS p FROM ${t} WHERE rowid > ?`).all(before[i]) as Array<{ r: number; p: unknown }>;
      if (ids.length === 0) return;
      let m = ctx.created.get(t);
      if (!m) { m = new Map(); ctx.created.set(t, m); }
      for (const x of ids) m.set(Number(x.r), String(x.p));
    });
  }
}

function removeSideEffects(ctx: GardssalgProbeReaderContext): SideEffectCount[] {
  const out: SideEffectCount[] = [];
  for (const t of SIDE_EFFECT_TABLES) {
    const rows = [...(ctx.created.get(t) ?? new Map<number, string>())];
    let removed = 0;
    if (rows.length && tableExists(ctx.lokalDb, t)) {
      const del = ctx.lokalDb.prepare(`DELETE FROM ${t} WHERE rowid = ? AND ${SIDE_EFFECT_PIN[t]} = ?`);
      ctx.lokalDb.transaction(() => { for (const [r, p] of rows) removed += del.run(r, p).changes; })();
    }
    out.push({ table: t, created: rows.length, removed, left_after_run: rows.length - removed });
  }
  return out;
}

interface HandlerResult { status: number; body: any; headers: Record<string, string> }

function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
  const layer = (router?.stack as any[] | undefined)?.find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

/** An internal admin request on the Opplevagent host (as_public=1 only for the as-public reads). */
function probeReq(
  ctx: GardssalgProbeReaderContext, path: string,
  o: { method?: "GET" | "POST"; params?: Record<string, string>; query?: Record<string, string>; body?: any; asPublic?: boolean } = {},
): any {
  const headers: Record<string, string> = { host: PROBE_HOST, "x-admin-key": ctx.adminKey, "user-agent": PROBE_UA };
  if (o.method === "POST") headers["content-type"] = "application/json";
  const query: Record<string, string> = { ...(o.query || {}), ...(o.asPublic ? { as_public: "1" } : {}) };
  const qs = Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const url = qs ? `${path}?${qs}` : path;
  return {
    method: o.method ?? "GET", url, path, originalUrl: url, baseUrl: "",
    params: o.params || {}, body: o.body ?? {}, query, headers, cookies: {},
    ip: "127.0.0.1", lang: "no", protocol: "https", hostname: PROBE_HOST, secure: true,
    socket: { remoteAddress: "127.0.0.1" },
    get(name: string) { return headers[name.toLowerCase()]; },
    header(name: string) { return headers[name.toLowerCase()]; },
  };
}

/** Runs one route handler in-process with a capturing response. */
function invokeHandler(ctx: GardssalgProbeReaderContext, handler: Function, req: any): Promise<HandlerResult> {
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
      const p = captureSync(ctx, () => handler(req, res, (err?: any) => { res.statusCode = 404; settle({ __next: true, err: err ? String(err) : undefined }); }));
      if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
    } catch (err) {
      settle({ __error: String(err) });
    }
  });
}

interface GsKit {
  handlers: Record<string, Function>;
  tool: (name: string, args: any) => Promise<string>;
}

let kitCache: { kit: GsKit; refs: unknown[] } | null = null;

/** The public gårdssalg route handlers and MCP tools (lazy: large modules). */
function gsKit(ctx: GardssalgProbeReaderContext): GsKit {
  const seoRouter = require("../routes/experiences-seo").default as any;
  const oppRouter = require("../routes/opplevelser").default as any;
  const a2aRouter = require("../routes/experiences-a2a").default as any;
  const mcpMod = require("../routes/experiences-mcp") as typeof import("../routes/experiences-mcp");
  const refs: unknown[] = [seoRouter, oppRouter, a2aRouter, mcpMod.registerExperienceTools, ctx.adminKey];
  if (kitCache && kitCache.refs.length === refs.length && kitCache.refs.every((r, i) => r === refs[i])) return kitCache.kit;
  const tools = new Map<string, (args: any, extra?: any) => Promise<any>>();
  const { buildRequestMeta } = require("../services/internal-traffic") as typeof import("../services/internal-traffic");
  const metaReq = probeReq(ctx, "/mcp", { method: "POST" });
  mcpMod.registerExperienceTools({
    registerTool(name: string, _config: any, handler: any) { tools.set(name, handler); },
    registerResource() { /* widgets: not read by the probe */ },
    resource() { /* no-op */ },
    tool() { /* legacy API: not used for the probed tools */ },
    prompt() { /* no-op */ },
    registerPrompt() { /* no-op */ },
  } as any, () => "opplevagent-switch-probe", () => buildRequestMeta(metaReq as any) as any);
  const extra = () => ({ requestInfo: { headers: { "x-admin-key": ctx.adminKey, "user-agent": PROBE_UA } } });
  const kit: GsKit = {
    handlers: {
      home: findRouteHandler(seoRouter, "/", "get"),
      catalog: findRouteHandler(seoRouter, "/kategori/gardssalg", "get"),
      typePage: findRouteHandler(seoRouter, "/kategori/gardssalg/:typeSlug", "get"),
      profile: findRouteHandler(seoRouter, "/kategori/gardssalg/produsent/:providerSlug", "get"),
      sok: findRouteHandler(seoRouter, "/sok", "get"),
      sitemap: findRouteHandler(seoRouter, "/sitemap.xml", "get"),
      formPost: findRouteHandler(seoRouter, "/kategori/gardssalg/book/:providerSlug", "post"),
      discover: findRouteHandler(oppRouter, "/discover", "get"),
      book: findRouteHandler(oppRouter, "/book", "post"),
      a2a: findRouteHandler(a2aRouter, "/a2a", "post"),
    },
    tool: async (name, args) => {
      const h = tools.get(name);
      if (!h) throw new Error(`MCP tool not registered: ${name}`);
      return String((await captureSync(ctx, () => h(args, extra())))?.content?.[0]?.text ?? "");
    },
  };
  kitCache = { kit, refs };
  return kit;
}

function asPublic<T>(fn: () => Promise<T>): Promise<T> {
  const { runAsPublicView } = require("../services/agent-visibility") as typeof import("../services/agent-visibility");
  return runAsPublicView(fn);
}

const text = (r: HandlerResult) => (typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? ""));
const htmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function profileHref(f: GardssalgProbeFixture): string {
  return `/kategori/gardssalg/produsent/${f.slug}`;
}

/** The fixture's drink-type page slug, when its producer type has one. */
function typePageSlug(f: GardssalgProbeFixture): string | null {
  if (!f.producerType) return null;
  try {
    const { GARDSSALG_TYPE_PAGES } = require("../routes/experiences-seo") as typeof import("../routes/experiences-seo");
    for (const [slug, def] of Object.entries(GARDSSALG_TYPE_PAGES)) if (def.producerTypes.includes(f.producerType)) return slug;
  } catch { /* no type pages */ }
  return null;
}

/** The as-public page / list reads of one discover-like surface: the test row's entry, or null. */
async function discoverEntry(ctx: GardssalgProbeReaderContext, surface: "mcp_search" | "rest_card" | "a2a"): Promise<any | null> {
  const kit = gsKit(ctx);
  const f = ctx.fixture;
  return asPublic(async () => {
    if (surface === "mcp_search") {
      const t = await kit.tool("discover_gardssalg", { query: f.name, limit: 50 });
      try { return (JSON.parse(t)?.gardssalg_producers ?? []).find((p: any) => p?.id === f.id) ?? null; } catch { return null; }
    }
    if (surface === "rest_card") {
      const r = await invokeHandler(ctx, kit.handlers.discover, probeReq(ctx, "/api/opplevelser/discover", {
        query: { category: "gardssalg_smaking", q: f.name, limit: "100" }, asPublic: true,
      }));
      return (r.body?.results ?? []).find((p: any) => p?.id === f.id) ?? null;
    }
    const r = await invokeHandler(ctx, kit.handlers.a2a, probeReq(ctx, "/a2a", { method: "POST", asPublic: true, body: a2aBody(f) }));
    const arts: any[] = r.body?.result?.artifacts ?? [];
    for (const a of arts) {
      for (const p of a?.parts ?? []) {
        const hit = (p?.data?.producers ?? []).find((x: any) => x?.id === f.id);
        if (hit) return hit;
      }
    }
    return null;
  });
}

/** A gårdssalg-intent A2A message as close to the test row as the skill can narrow (coordinates, else kommune). */
function a2aBody(f: GardssalgProbeFixture): any {
  const hasGeo = f.lat !== null && f.lon !== null;
  const words = !hasGeo && f.kommune ? `gårdssalg i ${f.kommune}` : "gårdssalg";
  const parts: any[] = [{ kind: "text", text: words }];
  if (hasGeo) parts.push({ kind: "data", data: { lat: f.lat, lng: f.lon, radius_km: 5 } });
  return { jsonrpc: "2.0", id: "switch-probe", method: "message/send", params: { message: { role: "user", parts } } };
}

/** Where the operator sets the test row's place (O2c). */
const A2A_LOCATION_ROUTE = "POST /api/opplevelser/admin/gardssalg/test-provider { email, lat, lon } (eventuelt { kommune })";

function a2aHint(f: GardssalgProbeFixture): string | undefined {
  if (f.lat === null || f.lon === null) {
    return f.kommune
      ? `testprodusenten har kommune (${f.kommune}), men ingen koordinater: A2A-søket (maks 20 treff, uten fritekst) når den bare ` +
        `hvis kommunenavnet gjenkjennes og raden er blant de 20 første — sett koordinater med ${A2A_LOCATION_ROUTE}`
      : "testprodusenten har verken koordinater eller kommune, så A2A-søket (maks 20 treff, uten fritekst) kan ikke nå den — " +
        `sett et sted på testraden med ${A2A_LOCATION_ROUTE}`;
  }
  return undefined;
}

// ── Visibility readers (visibility.profile): endpoint = the test row is shown ──

function visibilityReader(surface: string): GardssalgSurfaceReader {
  return async (ctx) => {
    const kit = gsKit(ctx);
    const f = ctx.fixture;
    const href = profileHref(f);
    const eps: Record<string, () => Promise<boolean>> = {};
    let requireAll = true;
    let hint: string | undefined;
    switch (surface) {
      case "profile_html":
        eps.profil = async () => {
          const r = await invokeHandler(ctx, kit.handlers.profile, probeReq(ctx, href, { params: { providerSlug: f.slug }, asPublic: true }));
          const h = text(r);
          return r.status === 200 && (h.includes(f.name) || h.includes(htmlEscape(f.name)));
        };
        break;
      case "listing_html": {
        requireAll = false;
        eps.forside = async () => text(await invokeHandler(ctx, kit.handlers.home, probeReq(ctx, "/", { asPublic: true }))).includes(href);
        eps.kategori = async () => {
          for (let page = 1; page <= CATALOG_MAX_PAGES; page++) {
            const h = text(await invokeHandler(ctx, kit.handlers.catalog, probeReq(ctx, "/kategori/gardssalg", { query: page > 1 ? { page: String(page) } : {}, asPublic: true })));
            if (h.includes(href)) return true;
            if (!h.includes("/kategori/gardssalg/produsent/")) return false;
          }
          return false;
        };
        const typeSlug = typePageSlug(f);
        if (typeSlug) {
          eps.drikketype = async () => {
            for (let page = 1; page <= CATALOG_MAX_PAGES; page++) {
              const r = await invokeHandler(ctx, kit.handlers.typePage, probeReq(ctx, `/kategori/gardssalg/${typeSlug}`, {
                params: { typeSlug }, query: page > 1 ? { page: String(page) } : {}, asPublic: true,
              }));
              const h = text(r);
              if (r.status === 200 && h.includes(href)) return true;
              if (r.status !== 200 || !h.includes("/kategori/gardssalg/produsent/")) return false;
            }
            return false;
          };
        }
        eps.kart = async () => {
          const store = require("../services/experience-store") as typeof import("../services/experience-store");
          return asPublic(async () => store.listGardssalgProviderMapPoints().some((p) => p.slug === f.slug));
        };
        if (f.lat !== null && f.lon !== null) {
          eps.reise_korridor = async () => {
            const rc = require("../services/route-corridor-service") as typeof import("../services/route-corridor-service");
            const d = 0.05;
            return asPublic(async () => rc.loadGardssalgCandidates({ minLat: f.lat! - d, maxLat: f.lat! + d, minLng: f.lon! - d, maxLng: f.lon! + d }, ctx.expDb).some((c) => c.id === f.id));
          };
        }
        eps.sok = async () => text(await invokeHandler(ctx, kit.handlers.sok, probeReq(ctx, "/sok", { query: { q: f.name }, asPublic: true }))).includes(href);
        break;
      }
      case "mcp_search":
        eps.discover_gardssalg = async () => (await discoverEntry(ctx, "mcp_search")) !== null;
        break;
      case "mcp_info":
        eps.book_gardssalg_oppslag = async () => {
          const { resolveGardssalgProviderByQuery } = require("../services/gardssalg-booking-resolve") as typeof import("../services/gardssalg-booking-resolve");
          return asPublic(async () => {
            const r = resolveGardssalgProviderByQuery(f.name, { surface: "mcp" });
            return r.kind === "one" ? r.provider.id === f.id : r.kind === "ambiguous" ? r.candidates.some((c: any) => c?.id === f.id) : false;
          });
        };
        break;
      case "rest_card":
        eps.rest_discover = async () => (await discoverEntry(ctx, "rest_card")) !== null;
        break;
      case "sitemap":
        eps.sitemap = async () => asPublic(async () => text(await invokeHandler(ctx, kit.handlers.sitemap, probeReq(ctx, "/sitemap.xml", { asPublic: true }))).includes(`${href}</loc>`));
        break;
      case "a2a":
        eps.a2a_gardssalg = async () => (await discoverEntry(ctx, "a2a")) !== null;
        hint = a2aHint(f);
        break;
      default:
        throw new Error(`no visibility reader for ${surface}`);
    }
    const endpoints: Record<string, boolean> = {};
    // The handlers read the view from their async context: run each one inside it.
    for (const [name, fn] of Object.entries(eps)) endpoints[name] = await asPublic(fn);
    return { endpoints, requireAll, ...(hint && !Object.values(endpoints).some((v) => v) ? { unobservableHint: hint } : {}) };
  };
}

// ── Booking readers ───────────────────────────────────────────────────────

type ChannelOutcome = "open" | "owner_paused" | "not_live" | null;

interface ProviderGateRow { booking_live: number | null; catalog_hidden: number | null; is_test_provider: number | null; epost: string | null }

function providerGateRow(ctx: GardssalgProbeReaderContext): ProviderGateRow | null {
  return (ctx.expDb.prepare(`SELECT booking_live, catalog_hidden, is_test_provider, epost FROM experience_providers WHERE id = ?`).get(ctx.fixture.id) as ProviderGateRow | undefined) ?? null;
}

/** The two checks every booking channel makes, in their order. */
function gateOutcome(ctx: GardssalgProbeReaderContext): ChannelOutcome {
  const { isBookingPaused } = require("../services/booking-store") as typeof import("../services/booking-store");
  const { gardssalgBookingPausedByOwner } = require("../services/gardssalg-booking-gate") as typeof import("../services/gardssalg-booking-gate");
  const row = providerGateRow(ctx);
  if (!row) return null;
  if (isBookingPaused(row.booking_live, row.catalog_hidden, row.is_test_provider)) return "not_live";
  if (gardssalgBookingPausedByOwner(ctx.fixture.id)) return "owner_paused";
  return "open";
}

function bookingCount(ctx: GardssalgProbeReaderContext): number {
  try { return Number((ctx.expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_bookings WHERE provider_id = ?`).get(ctx.fixture.id) as { n: number }).n) || 0; } catch { return 0; }
}

/** A channel call with the past slot; a new booking row for the producer aborts the reader. */
async function guardedChannel(ctx: GardssalgProbeReaderContext, name: string, fn: () => Promise<ChannelOutcome>): Promise<ChannelOutcome> {
  const n0 = bookingCount(ctx);
  const out = await fn();
  if (bookingCount(ctx) !== n0) throw new Error(`${name}: en forespørsel ble opprettet (skal aldri skje)`);
  return out;
}

/** The three booking channels, each with the past slot. Never creates a request (see the header). */
async function channelOutcomes(ctx: GardssalgProbeReaderContext): Promise<Record<string, ChannelOutcome>> {
  const { slotBoundsError } = require("../services/gardssalg-opening-hours") as typeof import("../services/gardssalg-opening-hours");
  if (slotBoundsError(SWITCH_PROBE_PAST_SLOT) === null) {
    throw new Error("tidspunktet i fortiden avvises ikke lenger av slot-kontrollen; bookingkanalene ble ikke kalt");
  }
  const kit = gsKit(ctx);
  const f = ctx.fixture;
  const body = { provider_id: f.id, slot_at: SWITCH_PROBE_PAST_SLOT, ...PROBE_GUEST };
  const out: Record<string, ChannelOutcome> = {};
  out.rest_book = await guardedChannel(ctx, "rest_book", async () => {
    const r = await invokeHandler(ctx, kit.handlers.book, probeReq(ctx, "/api/opplevelser/book", { method: "POST", body }));
    const b = r.body ?? {};
    if (b.paused === true) return b.reason === "owner_paused" ? "owner_paused" : "not_live";
    if (r.status === 400 && typeof b.error === "string" && b.success !== true) return "open";
    return null;
  });
  out.mcp_book = await guardedChannel(ctx, "mcp_book", async () => {
    const t = await kit.tool("book_gardssalg", body);
    let b: any;
    try { b = JSON.parse(t); } catch { return null; }
    if (b?.reason === "owner_paused") return "owner_paused";
    if (b?.reason === "not_live") return "not_live";
    if (b?.reason === "slot_bounds") return "open";
    return null;
  });
  // The form's slug lookup is the public one: inside the view, as for every read of the test row.
  out.form_post = await guardedChannel(ctx, "form_post", () => asPublic(async () => {
    const r = await invokeHandler(ctx, kit.handlers.formPost, {
      ...probeReq(ctx, `/kategori/gardssalg/book/${f.slug}`, { method: "POST", params: { providerSlug: f.slug } }),
      body: { slot_at: SWITCH_PROBE_PAST_SLOT, party_size: String(PROBE_GUEST.party_size), guest_name: PROBE_GUEST.guest_name, guest_email: PROBE_GUEST.guest_email },
    });
    const loc = String(r.body?.__redirect ?? "");
    if (loc.includes("error=not_taking")) return "owner_paused";
    if (loc.includes("error=paused")) return "not_live";
    if (loc.includes("error=slot_bounds")) return "open";
    return null;
  }));
  return out;
}

/** booking.enabled: endpoint = «a new request gets through the gate». booking.pause: = «refused with the not-taking line». */
type BookingKey = "booking.enabled" | "booking.pause";

function outcomeValue(key: BookingKey, o: ChannelOutcome): boolean | null {
  if (o === null) return null;
  if (key === "booking.enabled") return o === "open";
  // A «not activated» refusal says nothing about the owner's pause.
  return o === "not_live" ? null : o === "owner_paused";
}

function bookingNoteValue(key: BookingKey, entry: any | null): boolean | null {
  if (!entry || !entry.booking) return null;
  const { GARDSSALG_BOOKING_NOTE_NOT_TAKING } = require("../services/gardssalg-booking-gate") as typeof import("../services/gardssalg-booking-gate");
  if (key === "booking.enabled") return entry.booking.live === true;
  return entry.booking.live === false && entry.booking.note === GARDSSALG_BOOKING_NOTE_NOT_TAKING;
}

function outcomeLabel(o: ChannelOutcome): string {
  return o === "open" ? "slipper gjennom porten" : o === "owner_paused" ? "«tar ikke imot forespørsler nå»" : o === "not_live" ? "«ikke aktivert»" : "testraden ikke sett";
}

function bookingGateSync(key: BookingKey): (ctx: GardssalgProbeReaderContext) => GardssalgSurfaceObservation {
  return (ctx) => ({ endpoints: { gate: outcomeValue(key, gateOutcome(ctx)) }, requireAll: true });
}

function bookingGateReader(key: BookingKey): GardssalgSurfaceReader {
  return async (ctx) => {
    const g = gateOutcome(ctx);
    const ch = await channelOutcomes(ctx);
    const endpoints: Record<string, boolean | null> = { gate: outcomeValue(key, g) };
    for (const [k, v] of Object.entries(ch)) endpoints[k] = outcomeValue(key, v);
    return {
      endpoints, requireAll: true,
      detail: `port: ${outcomeLabel(g)}; ${Object.entries(ch).map(([k, v]) => `${k}: ${outcomeLabel(v)}`).join(", ")}`,
    };
  };
}

function bookingNoteReader(key: BookingKey, surface: "mcp_search" | "rest_card" | "a2a"): GardssalgSurfaceReader {
  return async (ctx) => {
    const entry = await discoverEntry(ctx, surface);
    const v = bookingNoteValue(key, entry);
    const hint = surface === "a2a" && entry === null ? a2aHint(ctx.fixture) : undefined;
    return {
      endpoints: { [surface === "mcp_search" ? "discover_gardssalg" : surface === "rest_card" ? "rest_discover" : "a2a_gardssalg"]: v },
      requireAll: true,
      detail: entry ? `booking.live=${entry.booking?.live}, mode=${entry.booking?.mode}` : "testraden ikke sett",
      ...(hint ? { unobservableHint: hint } : {}),
    };
  };
}

const profileReserveReader: GardssalgSurfaceReader = async (ctx) => {
  const kit = gsKit(ctx);
  const f = ctx.fixture;
  const r = await asPublic(() => invokeHandler(ctx, kit.handlers.profile, probeReq(ctx, profileHref(f), { params: { providerSlug: f.slug }, asPublic: true })));
  const h = text(r);
  const seen = r.status === 200 && h.includes('id="reserve-cta"');
  const v = seen ? h.includes('class="reserve-cta"') : null;
  return { endpoints: { reserver_knapp: v }, requireAll: true, detail: seen ? (v ? "«Reserver besøk»" : "«Meld interesse» (booking av)") : "testraden ikke sett" };
};

/** A request e-mail to the producer would go out: the channel gate is open and the profile has an address. */
const requestMailSync = (ctx: GardssalgProbeReaderContext): GardssalgSurfaceObservation => {
  const { hasBookingRequestEmail } = require("../services/gardssalg-booking-gate") as typeof import("../services/gardssalg-booking-gate");
  const row = providerGateRow(ctx);
  const g = gateOutcome(ctx);
  if (!row || g === null) return { endpoints: { request_mail: null }, requireAll: true, detail: "testraden finnes ikke" };
  const send = g === "open" && hasBookingRequestEmail(row.epost);
  return { endpoints: { request_mail: send }, requireAll: true, detail: `forespørsels-e-post ${send ? "sendes" : `sendes ikke (${g !== "open" ? outcomeLabel(g) : "ingen adresse"})`}` };
};

/** sendGatedProducerEmail's gate (the reminder after N hours and its job step). */
function producerMailGateSync(endpoint: string, what: string): (ctx: GardssalgProbeReaderContext) => GardssalgSurfaceObservation {
  return (ctx) => {
    const { isBookingPaused } = require("../services/booking-store") as typeof import("../services/booking-store");
    const row = providerGateRow(ctx);
    if (!row) return { endpoints: { [endpoint]: null }, requireAll: true, detail: "testraden finnes ikke" };
    const send = !isBookingPaused(row.booking_live, row.catalog_hidden, row.is_test_provider) && !!row.epost;
    return { endpoints: { [endpoint]: send }, requireAll: true, detail: `${what} ${send ? "sendes" : "sendes ikke"}` };
  };
}

class ReaderRollback extends Error {
  constructor(readonly obs: GardssalgSurfaceObservation) { super("gardssalg switch-probe reader rollback"); }
}

/**
 * An owner-locked text is never overwritten by the content job — evaluated
 * in an experiences.db transaction that is always rolled back.
 */
function ownerLockSync(mode: "content_refresh" | "lock_guard"): (ctx: GardssalgProbeReaderContext) => GardssalgSurfaceObservation {
  return (ctx) => {
    const store = require("../services/experience-store") as typeof import("../services/experience-store");
    const db = ctx.expDb;
    const id = ctx.fixture.id;
    try {
      db.transaction(() => {
        const row = db.prepare(`SELECT about_text, content_source, field_provenance FROM experience_providers WHERE id = ?`).get(id) as
          | { about_text: string | null; content_source: string | null; field_provenance: string | null } | undefined;
        if (!row) throw new ReaderRollback({ endpoints: { owner_text_kept: null }, requireAll: true, detail: "testraden finnes ikke" });
        let prov: Record<string, any> = {};
        try { const p = JSON.parse(row.field_provenance || "{}"); if (p && typeof p === "object" && !Array.isArray(p)) prov = p; } catch { prov = {}; }
        const ownerText = "Eierens egen tekst om gården, skrevet i eierportalen (bryterprobe, rulles tilbake).";
        const locks = { ...(prov.owner_locks && typeof prov.owner_locks === "object" ? prov.owner_locks : {}), about_text: { locked_at: new Date().toISOString() } };
        db.prepare(`UPDATE experience_providers SET about_text = ?, field_provenance = ? WHERE id = ? AND ${GARDSSALG_FIXTURE_PIN}`)
          .run(ownerText, JSON.stringify({ ...prov, owner_locks: locks }), id);
        if (mode === "lock_guard") {
          const r2 = db.prepare(`SELECT content_source, field_provenance FROM experience_providers WHERE id = ?`).get(id) as { content_source: string | null; field_provenance: string | null };
          const locked = store.isGardssalgFieldOwnerLocked(r2, "about_text");
          throw new ReaderRollback({ endpoints: { owner_lock_guard: locked }, requireAll: true, detail: locked ? "eierlåst felt avvises av låsevakten" : "låsevakten slipper gjennom et eierlåst felt" });
        }
        const candidate = "Ny tekst fra nettsiden som innholdsjobben vil skrive inn. Bryterproben prøver å overskrive eierens tekst, og alt rulles tilbake etterpå.";
        store.applyGardssalgProviderContent(id, { about_text: candidate }, "https://example.invalid/bryterprobe", "switch-probe", ["about_text"], undefined, ["about_text"]);
        const after = (db.prepare(`SELECT about_text FROM experience_providers WHERE id = ?`).get(id) as { about_text: string | null }).about_text;
        const kept = after === ownerText;
        throw new ReaderRollback({ endpoints: { owner_text_kept: kept }, requireAll: true, detail: kept ? "innholdsjobben lot eierens tekst stå" : "innholdsjobben overskrev eierens tekst" });
      })();
    } catch (e) {
      if (e instanceof ReaderRollback) return e.obs;
      throw e;
    }
    throw new Error("owner lock reader: no observation");
  };
}

const outreachSync = (ctx: GardssalgProbeReaderContext): GardssalgSurfaceObservation => {
  const av = require("../services/avmeld-service") as typeof import("../services/avmeld-service");
  const to = ctx.fixture.epost;
  if (!to) return { endpoints: { list_unsubscribe: null }, requireAll: true, detail: "ingen mottakeradresse" };
  const h = av.unsubscribeHeaderValues(to, "experiences");
  const m = h ? h.listUnsubscribe.match(/\/avmeld\/([^>]+)>$/) : null;
  const v = m ? av.verifyUnsubscribeToken(m[1]!) : null;
  const signed = !!v && v.email === av.normalizeRecipient(to) && v.vertical === "experiences";
  return {
    endpoints: { list_unsubscribe: !!h && signed }, requireAll: true,
    detail: h ? (signed ? "kald e-post får List-Unsubscribe (signert, Opplevagent)" : "List-Unsubscribe uten gyldig token") : "kald e-post får ingen List-Unsubscribe",
  };
};

const syncReader = (fn: (ctx: GardssalgProbeReaderContext) => GardssalgSurfaceObservation, observe: string): GardssalgSurfaceReaderDef => ({ read: fn, sync: fn, observe });

const VISIBILITY_SURFACES = ["profile_html", "listing_html", "mcp_search", "mcp_info", "rest_card", "sitemap", "a2a"];
const HEAVY_SURFACES = new Set(["listing_html", "sitemap", "booking_gate", "profile_html"]);

/**
 * The effect reader per live key × surface. A live key × surface without an
 * entry here is a FAIL row («mangler effektleser»), so a new live surface
 * cannot pass silently.
 */
export function defaultGardssalgSwitchProbeReaders(): Record<string, GardssalgSurfaceReaderDef> {
  const out: Record<string, GardssalgSurfaceReaderDef> = {};
  for (const s of VISIBILITY_SURFACES) {
    out[caseId("visibility.profile", s)] = {
      read: visibilityReader(s), observe: `${s} som offentlig: testprodusenten vist / borte`, needsVisibleRow: true,
      ...(HEAVY_SURFACES.has(s) ? { pollMs: HEAVY_POLL_MS } : {}),
    };
  }
  for (const key of ["booking.enabled", "booking.pause"] as BookingKey[]) {
    out[caseId(key, "booking_gate")] = {
      read: bookingGateReader(key), sync: bookingGateSync(key), pollMs: HEAVY_POLL_MS, needsVisibleRow: true,
      observe: "isBookingPaused + gardssalgBookingPausedByOwner, og REST /book, book_gardssalg og skjemaet (tidspunkt i fortiden: ingen forespørsel)",
    };
    for (const s of ["mcp_search", "rest_card", "a2a"] as const) {
      out[caseId(key, s)] = { read: bookingNoteReader(key, s), needsVisibleRow: true, observe: `${s} som offentlig: booking-merknaden for testprodusenten` };
    }
  }
  out[caseId("booking.enabled", "profile_html")] = { read: profileReserveReader, pollMs: HEAVY_POLL_MS, needsVisibleRow: true, observe: "profilsiden som offentlig: «Reserver besøk» / «Meld interesse»" };
  for (const key of ["booking.enabled", "booking.attendance", "notify.booking_email"]) {
    out[caseId(key, "email:booking_request")] = syncReader(requestMailSync, "porten + adresse: forespørsels-e-posten sendes / sendes ikke (ingenting sendes)");
  }
  out[caseId("booking.reminder", "email:booking_reminder")] = syncReader(producerMailGateSync("reminder_mail", "påminnelsen"), "sendGatedProducerEmail-porten: påminnelsen sendes / sendes ikke");
  out[caseId("booking.reminder", "job:booking_previsit")] = syncReader(producerMailGateSync("previsit_reminder_step", "jobbens påminnelsessteg"), "sendGatedProducerEmail-porten: jobbens påminnelse sendes / hoppes over");
  out[caseId("content.guarantee", "job:gardssalg_content_refresh")] = syncReader(ownerLockSync("content_refresh"), "applyGardssalgProviderContent() på eierlåst tekst (rulles tilbake): teksten står");
  out[caseId("content.guarantee", "job:rfb_knowledge_enrich")] = syncReader(ownerLockSync("lock_guard"), "isGardssalgFieldOwnerLocked() på eierlåst tekst (rulles tilbake): låst");
  out[caseId("comms.unsubscribe", "email:outreach")] = syncReader(outreachSync, "unsubscribeHeaderValues(…, experiences): kald e-post får List-Unsubscribe");
  return out;
}

// ── Plan ──────────────────────────────────────────────────────────────────

const PLANNED_CHECKS = [
  "coming_soon:<key> — PUT → 409 coming_soon, ingen lagring, ingen effekt (hver coming_soon-nøkkel for gårdssalg)",
  "requirement_unmet:booking.enabled — uten e-post for forespørsler → 409 requirement_not_met, ingen effekt (rullet tilbake)",
  "requirement_unmet:booking.pause — uten «Ta imot besøk» → 409 requirement_not_met, ingen effekt (rullet tilbake)",
  "level:<nivå> — «Bare synlig» / «Ta imot besøk» gir samme effekt som enkeltbryteren; undo:level:<nivå> — «Angre» gjenoppretter",
  "restore — alt tilbake til startpunktet (eksakt)",
  "brand — ingen tekst i rapporten nevner den andre plattformen",
];

function verifiedOwner(providerId: string): boolean {
  try { return (require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim")).isGardssalgProviderClaimed(providerId); } catch { return false; }
}

function observabilityNotes(f: GardssalgProbeFixture): string[] {
  const notes: string[] = [];
  if (f.lat === null || f.lon === null) notes.push("ingen koordinater: kartet og /reise-korridoren kan ikke vise testprodusenten");
  if (!typePageSlug(f)) notes.push(`produsenttypen (${f.producerType ?? "ingen"}) har ingen drikketypeside`);
  const h = a2aHint(f);
  if (h) notes.push(h);
  if (!f.epost) notes.push("ingen e-postadresse: «Ta imot besøk» kan ikke slås på");
  notes.push("get_experience leser `experiences`-rader, aldri en gårdssalg-produsent: ikke en flate for testprodusenten");
  notes.push("/reise: rutetjenesten (ekstern) kjøres ikke; proben leser korridorens gårdssalg-steg (loadGardssalgCandidates)");
  return notes;
}

export function planGardssalgSwitchProbe(
  lokalDb: any, expDb: any, providerId: string, env: NodeJS.ProcessEnv = process.env, readers = defaultGardssalgSwitchProbeReaders(),
): GardssalgSwitchProbePlan {
  const resolved = resolveOwnerFeatures(VERTICAL, providerId, { db: lokalDb, env, registry: REGISTRY });
  const rows: GardssalgSwitchProbePlanRow[] = [];
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
    provider_id: providerId,
    verified_owner: verifiedOwner(providerId),
    allowlisted: isSubjectAllowedForOwnerFeatures(VERTICAL, providerId, env),
    env_flags: envFlags(env),
    baseline: liveEntries().map((e) => {
      const r = resolved.byKey[e.key];
      return { key: e.key, type: e.type, value: r?.value ?? null, source: r?.source ?? "", block: r?.block ?? null };
    }),
    observability: observabilityNotes(loadFixture(expDb, providerId)),
    rows,
    checks: PLANNED_CHECKS,
  };
}

// ── Run ───────────────────────────────────────────────────────────────────

export type GardssalgProbeWriteFn = typeof setOwnerFeatureValue;

export interface GardssalgSwitchProbeOptions {
  /** lokal.db (owner_feature_* tables). Default getDb(). */
  db?: any;
  /** experiences.db. Default db-factory getDb("experiences"). */
  expDb?: any;
  env?: NodeJS.ProcessEnv;
  maxWaitMs?: number;
  /** Test seam: replace / add effect readers. */
  readers?: Record<string, GardssalgSurfaceReaderDef>;
  /** Test seam: called after every flip; a throw aborts the run (restore still runs). */
  afterFlip?: (key: string, direction: ProbeDirection) => void;
  /** Test seam: the owner write (default setOwnerFeatureValue). */
  write?: GardssalgProbeWriteFn;
}

let running = false;

export function isGardssalgSwitchProbeRunning(): boolean {
  return running;
}

export class GardssalgSwitchProbeBusyError extends Error {
  constructor() { super("gardssalg switch probe already running"); }
}

interface Ctx {
  lokalDb: any;
  expDb: any;
  env: NodeJS.ProcessEnv;
  providerId: string;
  readers: Record<string, GardssalgSurfaceReaderDef>;
  readerCtx: GardssalgProbeReaderContext;
  maxWaitMs: number;
  rows: SwitchProbeRow[];
  checks: SwitchProbeCheck[];
  afterFlip?: GardssalgSwitchProbeOptions["afterFlip"];
  write: GardssalgProbeWriteFn;
}

function probeWrite(c: Ctx, key: string, value: OwnerFeatureValue): SetOwnerFeatureResult {
  return c.write(VERTICAL, c.providerId, key, value, GARDSSALG_SWITCH_PROBE_ACTOR, { db: c.lokalDb, env: c.env, registry: REGISTRY });
}

function resolvedNow(c: Ctx): ResolvedOwnerFeatures {
  return resolveOwnerFeatures(VERTICAL, c.providerId, { db: c.lokalDb, env: c.env, registry: REGISTRY });
}

function maxAuditId(c: Ctx): number {
  return Number((c.lokalDb.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM owner_feature_audit WHERE vertical = ? AND subject_id = ?`).get(VERTICAL, c.providerId) as { m: number }).m) || 0;
}

function contentAuditCount(c: Ctx): number {
  try {
    return Number((c.expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_content_audit WHERE provider_id = ?`).get(c.providerId) as { n: number }).n) || 0;
  } catch { return 0; }
}

function storedFingerprint(c: Ctx): string {
  return JSON.stringify(snapshotGardssalgFixture(c.lokalDb, c.expDb, c.providerId));
}

/**
 * Exactly the expected change-log rows for one write: one new
 * owner_feature_audit row (this key, actor admin / switch-probe, the new
 * value) that is on the owner's change log, and for an adapter entry one new
 * gardssalg_content_audit row (the portal's own log of the column).
 */
function changeLogged(c: Ctx, e: OwnerFeatureEntry, value: OwnerFeatureValue, beforeId: number, contentBefore: number): boolean {
  const rows = c.lokalDb
    .prepare(`SELECT id, key, new_json, actor, actor_detail FROM owner_feature_audit WHERE vertical = ? AND subject_id = ? AND id > ? ORDER BY id`)
    .all(VERTICAL, c.providerId, beforeId) as Array<{ id: number; key: string; new_json: string | null; actor: string; actor_detail: string | null }>;
  if (rows.length !== 1) return false;
  const row = rows[0];
  if (row.key !== e.key || row.actor !== GARDSSALG_SWITCH_PROBE_ACTOR.actor || row.actor_detail !== GARDSSALG_SWITCH_PROBE_ACTOR.detail) return false;
  let v: unknown = null;
  try { v = row.new_json == null ? null : JSON.parse(row.new_json); } catch { return false; }
  if (!sameValue(v, value)) return false;
  const log = ownerFeatureChangeLog(VERTICAL, c.providerId, 1, c.lokalDb, 50);
  if (!log.rows.some((r) => r.id === row.id && r.key === e.key && sameValue(r.new_value, value))) return false;
  if (e.storage && contentAuditCount(c) !== contentBefore + 1) return false;
  return true;
}

type Evaluated = { pass: boolean; observed: string; unseen: string[] };

function describe(obs: GardssalgSurfaceObservation): string {
  const eps = Object.entries(obs.endpoints).map(([k, v]) => `${k}=${v === null ? "ikke sett" : v ? "ja" : "nei"}`).join(", ");
  return obs.detail ? `${obs.detail} [${eps}]` : eps;
}

/**
 * expected false: every endpoint without the effect. expected true: every
 * endpoint (single-object) or at least one (list), and every endpoint that
 * showed it at the reference shows it again. An endpoint that did not show
 * the test row at all (null) is never evidence: on a single-object surface
 * it fails the row; on a list surface it counts as «not shown».
 */
export function evaluateGardssalgObservation(obs: GardssalgSurfaceObservation, expected: boolean, ref: GardssalgSurfaceObservation | null): Evaluated {
  const vals = Object.entries(obs.endpoints);
  const unseen = vals.filter(([, v]) => v === null).map(([k]) => k);
  let pass: boolean;
  if (obs.requireAll && unseen.length) pass = false;
  else if (!expected) pass = vals.length > 0 && vals.every(([, v]) => v !== true);
  else {
    pass = obs.requireAll ? vals.length > 0 && vals.every(([, v]) => v === true) : vals.some(([, v]) => v === true);
    if (pass && ref) pass = Object.entries(ref.endpoints).every(([k, v]) => v !== true || obs.endpoints[k] === true);
  }
  const silent = expected && !obs.requireAll ? vals.filter(([, v]) => v !== true).map(([k]) => k) : [];
  return { pass, unseen, observed: describe(obs) + (silent.length && pass ? ` (listeflate, uten utslag her: ${silent.join(", ")})` : "") };
}

async function readSafe(def: GardssalgSurfaceReaderDef, rc: GardssalgProbeReaderContext): Promise<{ obs: GardssalgSurfaceObservation | null; error: string | null }> {
  try {
    return { obs: await def.read(rc), error: null };
  } catch (e: any) {
    return { obs: null, error: String(e?.message || e) };
  } finally {
    // The in-process handlers settle in microtasks only: give the event loop
    // (live traffic) a turn after every read, so a run never starves the server.
    await new Promise<void>((r) => setImmediate(r));
  }
}

async function awaitEffect(c: Ctx, def: GardssalgSurfaceReaderDef, expected: boolean, ref: GardssalgSurfaceObservation | null, t0: number) {
  for (;;) {
    const last = await readSafe(def, c.readerCtx);
    const ms = Date.now() - t0;
    if (last.obs) {
      const ev = evaluateGardssalgObservation(last.obs, expected, ref);
      if (ev.pass) return { ...ev, obs: last.obs, ms: ms as number | null, error: null as string | null };
      if (ms >= c.maxWaitMs) return { ...ev, obs: last.obs, ms: null as number | null, error: null as string | null };
    } else if (ms >= c.maxWaitMs) {
      return { pass: false, unseen: [] as string[], observed: `leser feilet: ${last.error}`, obs: null, ms: null as number | null, error: last.error };
    }
    await sleep(Math.max(POLL_MS, def.pollMs ?? POLL_MS));
  }
}

/** The surface shows the test row at all (for the IKKE OBSERVERBAR rule). */
function rowSeen(obs: GardssalgSurfaceObservation, visibilityRead: boolean): boolean {
  const vals = Object.values(obs.endpoints);
  if (visibilityRead) return vals.some((v) => v === true);
  return obs.requireAll ? vals.length > 0 && vals.every((v) => v !== null) : vals.some((v) => v !== null);
}

function pushRow(c: Ctx, r: Omit<SwitchProbeRow, "result"> & { pass: boolean; notObservable?: string }): void {
  const { pass, notObservable, ...rest } = r;
  let result: ProbeRowResult = pass ? "PASS" : notObservable ? "NOT_OBSERVABLE" : "FAIL";
  let reason = notObservable ?? rest.reason;
  if (result === "PASS" && rest.ms_to_effect !== null && rest.ms_to_effect > GARDSSALG_SWITCH_PROBE_EFFECT_MAX_MS) {
    result = "FAIL";
    reason = "tid til effekt over 60 min (cache)";
  }
  const flag = GARDSSALG_SWITCH_PROBE_FLAG_DEPENDENCIES[caseId(rest.key, rest.surface)];
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

/**
 * The starting-state read of every surface whose reader must see the test
 * row: surface → reference observation, and the surfaces that cannot see it
 * (IKKE OBSERVERBAR) or whose reader threw (FAIL).
 */
async function groundState(c: Ctx, e: OwnerFeatureEntry, surfaces: string[], baseline: OwnerFeatureValue) {
  const refs = new Map<string, GardssalgSurfaceObservation | null>();
  const unobservable = new Map<string, string>();
  const readError = new Map<string, string>();
  const visibleNow = resolvedNow(c).byKey["visibility.profile"]?.value === true;
  const isVis = e.key === "visibility.profile";
  for (const s of surfaces) {
    const def = c.readers[caseId(e.key, s)];
    if (!def.needsVisibleRow) continue;
    // visibility.profile: only a visible start says where the row must show (an «off» start flips on first).
    if (isVis && baseline !== true) continue;
    const first = await readSafe(def, c.readerCtx);
    let ref = first.obs;
    if (ref && rowSeen(ref, isVis)) { refs.set(s, ref); continue; }
    if (!visibleNow) {
      unobservable.set(s, "profilen er på pause i grunntilstanden, så flaten kan ikke vise testprodusenten");
      refs.set(s, ref);
      continue;
    }
    // Not seen at the first read: the normal wait before calling it unobservable.
    const t0 = Date.now();
    let err = first.error;
    for (;;) {
      if (Date.now() - t0 >= c.maxWaitMs) break;
      await sleep(Math.max(POLL_MS, def.pollMs ?? POLL_MS));
      const again = await readSafe(def, c.readerCtx);
      err = again.error;
      if (again.obs) { ref = again.obs; if (rowSeen(ref, isVis)) break; }
    }
    if (ref && rowSeen(ref, isVis)) { refs.set(s, ref); continue; }
    if (!ref && err) { readError.set(s, err); continue; }
    unobservable.set(s, ref?.unobservableHint ?? `testprodusenten vises ikke på ${s} i grunntilstanden, der den skal være synlig${ref ? ` (${describe(ref)})` : ""}`);
    refs.set(s, ref);
  }
  return { refs, unobservable, readError };
}

/** switch: flip away from the baseline and back; every surface observed after each flip. */
async function probeSwitch(c: Ctx, e: OwnerFeatureEntry, baseline: OwnerFeatureValue): Promise<void> {
  const dirs = directionsFor("switch", baseline);
  const surfaces = e.surfaces.filter((s) => c.readers[caseId(e.key, s)]);
  for (const s of e.surfaces) if (!c.readers[caseId(e.key, s)]) missingReaderRows(c, e, s, dirs);
  const { refs, unobservable, readError } = await groundState(c, e, surfaces, baseline);
  for (const d of dirs) {
    const value = d === "on";
    const before = maxAuditId(c);
    const content0 = contentAuditCount(c);
    const w = probeWrite(c, e.key, value);
    const t0 = Date.now();
    const status = putStatusFor(w);
    const logged = w.kind === "ok" && w.changed ? changeLogged(c, e, value, before, content0) : w.kind === "ok" ? null : false;
    c.afterFlip?.(e.key, d);
    for (const s of surfaces) {
      const def = c.readers[caseId(e.key, s)];
      const expected = value ? "effekt til stede" : "effekt borte";
      const err = readError.get(s);
      if (err !== undefined) {
        pushRow(c, {
          key: e.key, surface: s, direction: d, pass: false, observed: `leser feilet: ${err}`, expected,
          ms_to_effect: null, write_status: status, change_logged: logged, discriminating: true, reason: `leser feilet i grunntilstanden: ${err}`,
        });
        continue;
      }
      const why = unobservable.get(s);
      if (why && w.kind === "ok" && logged !== false) {
        const ref = refs.get(s);
        pushRow(c, {
          key: e.key, surface: s, direction: d, pass: false, notObservable: why,
          observed: `ikke observerbar${ref ? `: ${describe(ref)}` : ""}`, expected,
          ms_to_effect: null, write_status: status, change_logged: logged, discriminating: false, reason: why,
        });
        continue;
      }
      const ref = value === (baseline === true) ? refs.get(s) ?? null : null;
      const r = await awaitEffect(c, def, value, value ? ref : null, t0);
      const writeOk = w.kind === "ok";
      pushRow(c, {
        key: e.key, surface: s, direction: d,
        pass: writeOk && logged !== false && r.pass,
        observed: r.observed, expected,
        ms_to_effect: r.pass ? r.ms : null, write_status: status, change_logged: logged, discriminating: true,
        ...(!writeOk ? { reason: `skrivingen ble avvist (${status}${w.kind === "blocked" ? ` ${w.block}` : ""})` }
          : logged === false ? { reason: "endringen mangler i endringsloggen (eller ga flere rader enn én)" }
          : !r.pass ? { reason: r.error ? `leser feilet: ${r.error}` : r.unseen.length ? `testraden ikke sett: ${r.unseen.join(", ")}` : `ingen riktig effekt innen ${c.maxWaitMs} ms` } : {}),
      });
    }
  }
}

/** A write the owner may not make: 409 `block`, nothing stored, the effect as before. */
async function probeRefused(
  c: Ctx, e: OwnerFeatureEntry, direction: ProbeDirection, value: OwnerFeatureValue, block: string,
  expectedEffect: boolean,
): Promise<void> {
  const fp0 = storedFingerprint(c);
  const before = maxAuditId(c);
  const w = probeWrite(c, e.key, value);
  const t0 = Date.now();
  const status = putStatusFor(w);
  const unchanged = storedFingerprint(c) === fp0 && maxAuditId(c) === before;
  const refused = w.kind === "blocked" && w.block === block;
  c.afterFlip?.(e.key, direction);
  for (const s of e.surfaces) {
    const def = c.readers[caseId(e.key, s)];
    if (!def) { missingReaderRows(c, e, s, [direction]); continue; }
    const r = await awaitEffect(c, def, expectedEffect, null, t0);
    pushRow(c, {
      key: e.key, surface: s, direction,
      pass: refused && unchanged && r.pass,
      observed: `PUT ${JSON.stringify(value)} → ${status}${w.kind === "blocked" ? ` ${w.block}` : ""}; ${r.observed}`,
      expected: `409 ${block}, ingenting lagret, effekt ${expectedEffect ? "til stede" : "borte"} som før`,
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
  await probeRefused(c, e, "off", false, "locked", cur);
  await probeRefused(c, e, "on", true, "locked", cur);
  const parent = e.lockedWhen ? findOwnerFeature(e.lockedWhen, REGISTRY) : undefined;
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
    const before = maxAuditId(c);
    const content0 = contentAuditCount(c);
    const w = probeWrite(c, parent.key, value);
    const t0 = Date.now();
    const status = putStatusFor(w);
    const logged = w.kind === "ok" && w.changed ? changeLogged(c, parent, value, before, content0) : w.kind === "ok" ? null : false;
    c.afterFlip?.(e.key, d);
    const lockedValue = resolvedNow(c).byKey[e.key];
    for (const s of e.surfaces) {
      const def = c.readers[caseId(e.key, s)];
      if (!def) { missingReaderRows(c, e, s, [d]); continue; }
      const r = await awaitEffect(c, def, value, null, t0);
      const followsParent = lockedValue?.value === value;
      pushRow(c, {
        key: e.key, surface: s, direction: d,
        pass: w.kind === "ok" && logged !== false && followsParent && r.pass,
        observed: `${parent.key}=${value} → ${status}; ${e.key}=${lockedValue?.value} (låst); ${r.observed}`,
        expected: `${e.key} følger ${parent.key}: effekt ${value ? "til stede" : "borte"}`,
        ms_to_effect: r.pass ? r.ms : null, write_status: status, change_logged: logged, discriminating: true,
        ...(w.kind !== "ok" ? { reason: `skrivingen av ${parent.key} ble avvist (${status}${w.kind === "blocked" ? ` ${w.block}` : ""})` }
          : logged === false ? { reason: "endringen mangler i endringsloggen" }
          : !followsParent ? { reason: "den låste nøkkelen fulgte ikke forelderen" }
          : !r.pass ? { reason: r.error ? `leser feilet: ${r.error}` : `ingen riktig effekt innen ${c.maxWaitMs} ms` } : {}),
      });
    }
  }
}

/** guarantee: every write refused both ways; the promise holds at every step. */
async function probeGuarantee(c: Ctx, e: OwnerFeatureEntry): Promise<void> {
  await probeRefused(c, e, "off", false, "guarantee", true);
  await probeRefused(c, e, "on", true, "guarantee", true);
}

/** Every key's resolved value + every sync reader — what a change looks like from outside. */
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
    setOwnerFeatureValue(VERTICAL, c.providerId, k, b.value, GARDSSALG_SWITCH_PROBE_ACTOR, { db: c.lokalDb, env: c.env, registry: REGISTRY });
  }
}

function addCheck(c: Ctx, chk: Omit<SwitchProbeCheck, "result"> & { pass: boolean }): void {
  const { pass, ...rest } = chk;
  c.checks.push({ ...rest, result: (pass ? "PASS" : "FAIL") as ProbeVerdict });
}

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
  for (const e of REGISTRY.filter((x) => x.status === "coming_soon")) {
    const cur = r0.byKey[e.key];
    const value = otherValue(e, cur?.value ?? null);
    const fp0 = storedFingerprint(c);
    const sig0 = effectSignature(c);
    const before = maxAuditId(c);
    const w = probeWrite(c, e.key, value);
    const status = putStatusFor(w);
    const after = resolvedNow(c).byKey[e.key];
    const noEffect = storedFingerprint(c) === fp0 && maxAuditId(c) === before && sameValue(after?.value, cur?.value) && effectSignature(c) === sig0;
    const refused = w.kind === "blocked" && w.block === "coming_soon";
    addCheck(c, {
      check: `coming_soon:${e.key}`, key: e.key, pass: refused && noEffect,
      observed: `PUT → ${status}${w.kind === "blocked" ? ` ${w.block}` : ""}; ${noEffect ? "ingen effekt" : "EFFEKT"}`,
      ...(!refused ? { reason: `ventet 409 coming_soon, fikk ${status}${w.kind === "blocked" ? ` ${w.block}` : ""}` } : !noEffect ? { reason: "noe ble lagret eller endret" } : {}),
    });
    if (w.kind === "ok" && w.changed) restoreValues(c, r0, [e.key]);
  }
}

class CheckRollback extends Error {
  constructor() { super("gardssalg switch-probe check rollback"); }
}

/**
 * Unmet requirement → 409 requirement_not_met and no effect, inside
 * transactions on both databases that are always rolled back:
 *   booking.enabled  the request address cleared (epost NULL, pinned UPDATE)
 *   booking.pause    booking.enabled switched off through the write path
 */
function checkRequirements(c: Ctx): void {
  const cases: Array<{ key: string; setup: () => void; label: string }> = [
    {
      key: "booking.enabled", label: "ingen e-post for forespørsler",
      setup: () => {
        probeWrite(c, "booking.enabled", false);
        c.expDb.prepare(`UPDATE experience_providers SET epost = NULL WHERE id = ? AND ${GARDSSALG_FIXTURE_PIN}`).run(c.providerId);
      },
    },
    {
      key: "booking.pause", label: "«Ta imot besøk» av",
      setup: () => { probeWrite(c, "booking.pause", false); probeWrite(c, "booking.enabled", false); },
    },
  ];
  for (const k of cases) {
    const e = findOwnerFeature(k.key, REGISTRY);
    if (!e || e.status !== "live") continue;
    let out: { pass: boolean; observed: string; reason?: string } = { pass: false, observed: "—", reason: "ikke kjørt" };
    const syncDefs = e.surfaces.map((s) => [s, c.readers[caseId(e.key, s)]?.sync] as const).filter(([, f]) => !!f);
    try {
      c.expDb.transaction(() => {
        c.lokalDb.transaction(() => {
          k.setup();
          const before = maxAuditId(c);
          const fp0 = storedFingerprint(c);
          const effects0 = JSON.stringify(syncDefs.map(([s, f]) => [s, f!(c.readerCtx).endpoints]));
          const w = probeWrite(c, e.key, true);
          const status = putStatusFor(w);
          const nothing = maxAuditId(c) === before && storedFingerprint(c) === fp0;
          const effects = syncDefs.map(([s, f]) => [s, f!(c.readerCtx)] as const);
          const noEffect = JSON.stringify(effects.map(([s, o]) => [s, o.endpoints])) === effects0
            && effects.every(([, o]) => Object.values(o.endpoints).every((v) => v !== true)) && resolvedNow(c).byKey[e.key]?.value !== true;
          const refused = w.kind === "blocked" && w.block === "requirement_not_met";
          out = {
            pass: refused && nothing && noEffect,
            observed: `${k.label}; PUT true → ${status}${w.kind === "blocked" ? ` ${w.block}` : ""}; ${effects.map(([s, o]) => `${s}: ${describe(o)}`).join("; ") || "ingen synkron leser"}`,
            ...(!refused ? { reason: `ventet 409 requirement_not_met, fikk ${status}` } : !nothing ? { reason: "noe ble lagret" } : !noEffect ? { reason: "effekt tross uoppfylt krav" } : {}),
          };
          throw new CheckRollback();
        })();
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
  for (const level of GARDSSALG_OWNER_LEVELS) {
    const keys = level.values.map(([k]) => k).filter((k) => findOwnerFeature(k, REGISTRY)?.status === "live");
    restoreValues(c, baseline, keys);
    for (const [k, v] of level.values) if (findOwnerFeature(k, REGISTRY)?.status === "live") probeWrite(c, k, v);
    const single = effectSignature(c);
    restoreValues(c, baseline, keys);
    const out = applyOwnerLevel(VERTICAL, c.providerId, level.key, GARDSSALG_SWITCH_PROBE_ACTOR, { db: c.lokalDb, env: c.env, registry: REGISTRY, levels: GARDSSALG_OWNER_LEVELS });
    const viaLevel = effectSignature(c);
    const skipped = out.kind === "ok" ? out.skipped.map((s) => s.key) : [];
    addCheck(c, {
      check: `level:${level.key}`, pass: out.kind === "ok" && skipped.length === 0 && single === viaLevel,
      observed: `${level.values.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}; ${single === viaLevel ? "samme effekt som enkeltbryteren" : "ULIK effekt"}${skipped.length ? `; hoppet over: ${skipped.join(", ")}` : ""}`,
      ...(out.kind !== "ok" ? { reason: `nivået ble ikke brukt (${out.kind})` } : skipped.length ? { reason: "nivået hoppet over nøkler" } : single !== viaLevel ? { reason: "nivå og enkeltbryter ga ulik effekt" } : {}),
    });
    if (out.kind === "ok" && out.batchId) {
      const u = undoOwnerChange(VERTICAL, c.providerId, out.batchId, GARDSSALG_SWITCH_PROBE_ACTOR, { db: c.lokalDb, env: c.env, registry: REGISTRY });
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

/** Dry run: the plan, starting values and env flags. Reads only (no surface is read). */
export function dryRunGardssalgSwitchProbe(providerId: string, opts: GardssalgSwitchProbeOptions = {}): GardssalgSwitchProbeResult & { plan: GardssalgSwitchProbePlan } {
  const lokalDb = opts.db ?? getDb();
  const expDb = opts.expDb ?? experiencesDb();
  const env = opts.env ?? process.env;
  const started = new Date().toISOString();
  const plan = planGardssalgSwitchProbe(lokalDb, expDb, providerId, env, { ...defaultGardssalgSwitchProbeReaders(), ...(opts.readers || {}) });
  return {
    ok: true, dry_run: true, provider_id: providerId, started_at: started, finished_at: new Date().toISOString(),
    env_flags: plan.env_flags, allowlisted: plan.allowlisted, rows: [], checks: [], pass: 0, fail: 0, not_observable: 0,
    restored: true, restore_diff: [], side_effects: [], ready_for_daniel_test: false,
    markdown: brandSafe(renderGardssalgSwitchProbePlanMarkdown(plan, started)).text, plan,
  };
}

/**
 * The full probe. Refuses a second concurrent run (GardssalgSwitchProbeBusyError).
 * Always restores the snapshot in `finally`; a run that aborts returns
 * ok:false with the error, the rows so far and the restore outcome.
 */
export async function runGardssalgSwitchProbe(providerId: string, opts: GardssalgSwitchProbeOptions = {}): Promise<GardssalgSwitchProbeResult> {
  if (running) throw new GardssalgSwitchProbeBusyError();
  running = true;
  const lokalDb = opts.db ?? getDb();
  const env = opts.env ?? process.env;
  const started = new Date().toISOString();
  let expDb: any = opts.expDb ?? null;
  const c: Ctx = {
    lokalDb, expDb, env, providerId,
    readers: {},
    readerCtx: { lokalDb, expDb, env, adminKey: "", fixture: null as unknown as GardssalgProbeFixture, created: new Map() },
    maxWaitMs: Math.min(Math.max(0, Math.floor(opts.maxWaitMs ?? GARDSSALG_SWITCH_PROBE_DEFAULT_MAX_WAIT_MS)), GARDSSALG_SWITCH_PROBE_MAX_WAIT_CAP_MS),
    rows: [], checks: [], afterFlip: opts.afterFlip, write: opts.write ?? setOwnerFeatureValue,
  };
  let snap: GardssalgFixtureSnapshot | null = null;
  let error: string | undefined;
  let restored = false;
  let restoreDiff: Array<{ table: string; before: unknown; after: unknown }> = [];
  let sideEffects: SideEffectCount[] = [];
  try {
    expDb = expDb ?? experiencesDb();
    c.expDb = expDb;
    c.readers = { ...defaultGardssalgSwitchProbeReaders(), ...(opts.readers || {}) };
    c.readerCtx = { lokalDb, expDb, env, adminKey: env.ADMIN_KEY || env.ANALYTICS_ADMIN_KEY || "", fixture: loadFixture(expDb, providerId), created: c.readerCtx.created };
    snap = snapshotGardssalgFixture(lokalDb, expDb, providerId);
    const baseline = resolvedNow(c);
    for (const e of liveEntries()) {
      const kind = entryKind(e);
      const b = baseline.byKey[e.key]?.value ?? null;
      if (kind === "switch") await probeSwitch(c, e, b);
      else if (kind === "locked") await probeLocked(c, e);
      else if (kind === "guarantee") await probeGuarantee(c, e);
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
  } catch (e: any) {
    error = String(e?.message || e);
  } finally {
    try {
      if (snap && expDb) {
        restoreSnapshot(lokalDb, expDb, providerId, snap);
        restoreDiff = maskDeep(diffSnapshots(snap, snapshotGardssalgFixture(lokalDb, expDb, providerId)));
        restored = restoreDiff.length === 0;
      }
    } catch (e: any) {
      restored = false;
      error = error ? `${error}; restore: ${String(e?.message || e)}` : `restore: ${String(e?.message || e)}`;
    }
    try {
      sideEffects = removeSideEffects(c.readerCtx);
    } catch (e: any) {
      error = error ? `${error}; side effects: ${String(e?.message || e)}` : `side effects: ${String(e?.message || e)}`;
    }
    running = false;
  }
  c.checks.push({
    check: "restore", result: restored ? "PASS" : "FAIL",
    observed: restored ? "alle lagrede valg og kolonner er som ved start (eksakt)" : `avvik i: ${restoreDiff.map((d) => d.table).join(", ") || "ukjent"}`,
    ...(restored ? {} : { reason: "gjenopprettingen ble ikke identisk" }),
  });
  const result: GardssalgSwitchProbeResult = {
    ok: !error, dry_run: false, provider_id: providerId, started_at: started, finished_at: new Date().toISOString(),
    env_flags: envFlags(env), allowlisted: isSubjectAllowedForOwnerFeatures(VERTICAL, providerId, env),
    rows: c.rows, checks: c.checks, pass: 0, fail: 0, not_observable: 0,
    restored, restore_diff: restoreDiff, side_effects: sideEffects, ready_for_daniel_test: false,
    ...(error ? { error } : {}),
    markdown: "",
  };
  // AC 28, fail closed: the report never names the other platform. A hit is
  // masked and recorded as a FAIL check (so readiness drops with it).
  const probeText = brandSafe(renderGardssalgSwitchProbeMarkdown(tally(result)));
  addCheck(c, {
    check: "brand", pass: !probeText.hit,
    observed: probeText.hit ? "rapporten nevnte den andre plattformen (maskert)" : "ingen tekst nevner den andre plattformen",
    ...(probeText.hit ? { reason: "merkevareregelen (AC 28) brutt" } : {}),
  });
  tally(result);
  result.markdown = brandSafe(renderGardssalgSwitchProbeMarkdown(result)).text;
  return result;
}

function tally(r: GardssalgSwitchProbeResult): GardssalgSwitchProbeResult {
  r.pass = r.rows.filter((x) => x.result === "PASS").length + r.checks.filter((x) => x.result === "PASS").length;
  r.fail = r.rows.filter((x) => x.result === "FAIL").length + r.checks.filter((x) => x.result === "FAIL").length;
  r.not_observable = r.rows.filter((x) => x.result === "NOT_OBSERVABLE").length;
  // IKKE OBSERVERBAR is not PASS: it blocks readiness like a FAIL (reported apart).
  r.ready_for_daniel_test = !r.error && r.fail === 0 && r.not_observable === 0 && r.restored && r.rows.length > 0;
  return r;
}

/** Masks the other platform's name (AC 28) and says whether it was there. */
export function brandSafe(s: string): { text: string; hit: boolean } {
  OTHER_BRAND_RE.lastIndex = 0;
  const hit = OTHER_BRAND_RE.test(s);
  OTHER_BRAND_RE.lastIndex = 0;
  return { text: hit ? s.replace(OTHER_BRAND_RE, "[annen plattform]") : s, hit };
}

// ── Report ────────────────────────────────────────────────────────────────

const cell = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function renderGardssalgSwitchProbePlanMarkdown(plan: GardssalgSwitchProbePlan, at: string): string {
  const lines: string[] = [`# Opplevagent «Mine valg» — bryterprobe, plan (tørrkjøring) ${at.slice(0, 10)}`, ""];
  lines.push(`- Testprodusent: \`${plan.provider_id}\` (verifisert eier: ${plan.verified_owner ? "ja" : "nei"}, i allowlist: ${plan.allowlisted ? "ja" : "nei"})`);
  lines.push(`- Planlagte rader: ${plan.rows.length} · uten effektleser: ${plan.rows.filter((r) => !r.reader).length}`, "");
  lines.push("| Nøkkel | Flate | Retning | Type | Effektleser |", "|---|---|---|---|---|");
  for (const r of plan.rows) lines.push(`| ${r.key} | ${r.surface} | ${r.direction} | ${r.kind} | ${r.reader ? "ja" : "NEI"} |`);
  lines.push("", "## Startverdier", "", "| Nøkkel | Verdi | Kilde | Sperre |", "|---|---|---|---|");
  for (const b of plan.baseline) lines.push(`| ${b.key} | ${cell(JSON.stringify(b.value))} | ${b.source} | ${b.block ?? ""} |`);
  lines.push("", "## Miljøflagg", "", "| Flagg | Verdi |", "|---|---|");
  for (const [k, v] of Object.entries(plan.env_flags)) lines.push(`| ${k} | ${v === null ? "(ikke satt)" : cell(v)} |`);
  lines.push("", "## Hva proben kan se", "");
  for (const n of plan.observability) lines.push(`- ${n}`);
  lines.push("", "## Ekstra kontroller", "");
  for (const ch of plan.checks) lines.push(`- ${ch}`);
  lines.push("");
  return lines.join("\n");
}

/** Ready-to-commit report (reports/<dato>-opplevagent-mine-valg-bryterprobe.md in the A2A repo). */
export function renderGardssalgSwitchProbeMarkdown(r: GardssalgSwitchProbeResult): string {
  const date = r.started_at.slice(0, 10);
  const lines: string[] = [];
  lines.push(`# Opplevagent «Mine valg» — bryterprobe ${date}`, "");
  lines.push(`- Testprodusent (gårdssalg): \`${r.provider_id}\` · i allowlist: ${r.allowlisted ? "ja" : "nei"}`);
  lines.push(`- Start: ${r.started_at} · slutt: ${r.finished_at}`);
  lines.push(`- Resultat: **${r.pass} PASS / ${r.fail} FAIL / ${r.not_observable} IKKE OBSERVERBAR** — ${r.ready_for_daniel_test ? "100 % PASS: klar for `ready_for_daniel_test`" : "IKKE klar for `ready_for_daniel_test` (krever 100 % PASS; «ikke observerbar» teller ikke som PASS)"}`);
  lines.push(`- Gjenopprettet til startpunktet: ${r.restored ? "ja (eksakt)" : "NEI"}`);
  lines.push("- Ingen e-post sendes og ingen besøksforespørsel opprettes: bookingkanalene får et tidspunkt i fortiden, som avvises etter pausesjekkene og før en forespørsel lages.");
  if (r.error) lines.push(`- Kjøringen ble avbrutt: ${cell(r.error)}`);
  lines.push("", "## Miljøflagg", "", "| Flagg | Verdi |", "|---|---|");
  for (const [k, v] of Object.entries(r.env_flags)) lines.push(`| ${k} | ${v === null ? "(ikke satt)" : cell(v)} |`);
  lines.push("", "## Bryter × flate × retning", "");
  lines.push("«IKKE OBSERVERBAR»: flaten viser ikke testprodusenten selv i grunntilstanden der den skal være synlig, så ingen av retningene kan bevises. Raden er ikke PASS og stopper `ready_for_daniel_test` som en FAIL, men telles for seg.", "");
  lines.push("«Skiller» = nei: en avvist skriving (låst valg / løfte) der flaten skal vise det samme før og etter. Raden viser at skrivingen ble avvist, ikke at flaten reagerer på bryteren.", "");
  lines.push("| Nøkkel | Flate | Retning | Resultat | Skiller | Observert | Tid til effekt (ms) | Merknad |", "|---|---|---|---|---|---|---|---|");
  for (const row of r.rows) {
    lines.push(`| ${row.key} | ${row.surface} | ${row.direction} | ${PROBE_RESULT_LABEL[row.result]} | ${row.discriminating ? "ja" : "nei"} | ${cell(row.observed)} | ${row.ms_to_effect ?? "—"} | ${cell(row.reason ?? "")} |`);
  }
  lines.push("", "## Ekstra kontroller", "", "| Kontroll | Resultat | Observert | Merknad |", "|---|---|---|---|");
  for (const ch of r.checks) lines.push(`| ${cell(ch.check)} | ${ch.result} | ${cell(ch.observed)} | ${cell(ch.reason ?? "")} |`);
  lines.push("", "## Sideeffekter av lesingene", "", "Offentlige lesestier logger egne rader (intern trafikk). Proben fanger radene som skrives i den synkrone delen av sine egne kall (rowid + id) og sletter bare dem, én og én.", "", "| Tabell | Laget av proben | Slettet igjen | Igjen |", "|---|---|---|---|");
  for (const x of r.side_effects) lines.push(`| ${x.table} | ${x.created} | ${x.removed} | ${x.left_after_run ?? "—"} |`);
  if (r.restore_diff.length) {
    lines.push("", "## Avvik etter gjenoppretting", "");
    for (const d of r.restore_diff) lines.push(`- ${d.table}: før ${cell(JSON.stringify(d.before))} · etter ${cell(JSON.stringify(d.after))}`);
  }
  lines.push("", "## FUNN TIL OPPFØLGING");
  const listSurfaces = new Set(["listing_html"]);
  const fails: Array<{ id: string; text: string; prio: string }> = [
    ...r.rows.filter((x) => x.result === "FAIL").map((x) => ({ id: `${x.key}-${x.surface}-${x.direction}`, text: `${x.key} × ${x.surface} (${x.direction}): ${x.reason ?? "FAIL"}`, prio: "P1" })),
    ...r.checks.filter((x) => x.result === "FAIL").map((x) => ({ id: x.check, text: `${x.check}: ${x.reason ?? "FAIL"}`, prio: "P1" })),
    ...r.rows.filter((x) => x.result === "NOT_OBSERVABLE").map((x) => ({
      id: `${x.key}-${x.surface}-${x.direction}`, text: `${x.key} × ${x.surface} (${x.direction}): ikke observerbar — ${x.reason ?? ""}`,
      prio: listSurfaces.has(x.surface) || x.surface === "a2a" ? "P2" : "P1",
    })),
  ];
  if (r.error) fails.unshift({ id: "run-aborted", text: `kjøringen ble avbrutt: ${r.error}`, prio: "P1" });
  if (fails.length === 0) lines.push("- [FUNN] ingen");
  const slug = (s: string) => `oa-bryterprobe-${s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`.slice(0, 80);
  for (const f of fails) lines.push(`- [FUNN] ${slug(f.id)} · ${f.prio} · ${cell(f.text)} · første-sett: ${date} · gjentakelser: 1`);
  lines.push("");
  return lines.join("\n");
}
