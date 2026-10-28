// ─── Public listability of an RFB `agents` row — ONE shared predicate ──────
// dev-request 2026-10-01-rfb-skjult-testprodusent-for-ordreflyt (Design 2) +
// the RFB vertical filter (2026-10-04 listing-honesty slice: test/non-food
// rows must not inflate public RFB lists or stats).
//
// A row is publicly listable on an RFB surface iff BOTH hold:
//   1. agents.catalog_hidden is 0 — the hidden RFB test fixture (POST
//      /admin/test-producer) never appears on any public list/search surface;
//   2. COALESCE(agents.vertical_id, 'rfb') = 'rfb' — the dental/experiences
//      rows that brreg-nace-discovery registered into `agents` via
//      /admin/agents/register (e.g. «DENTIX TANNHELSE AS») are not food
//      producers and must not surface or be counted as RFB producers. Those
//      rows are not changed or deleted — only filtered on RFB surfaces.
//
// Every public list/search surface uses this ONE predicate (SQL fragment or
// the in-memory twin below) ON TOP of whatever gates it already had
// (is_active, umbrella_type, is_vetted, verification …) — it never replaces
// one. Direct-id order-flow paths (/catalog/agents/:id/products, cart add/
// submit, /produsent/ordre/:token, admin inbox) deliberately do NOT use it:
// the fixture must stay orderable by id while invisible in every list.
//
// PURE (no project imports — only Node's async_hooks for the as-public view
// below), so marketplace-registry.ts can use it without breaching its
// rfb-vertical isolation (same rule as geo-distance.ts).

import { AsyncLocalStorage } from "node:async_hooks";

/** The only vertical whose `agents` rows are RFB food producers. */
export const RFB_VERTICAL_ID = "rfb";

function col(alias: string | undefined, name: string): string {
  return alias ? `${alias}.${name}` : name;
}

// ─── «Vis som offentlig» — the as-public view (dev-request ─────────────────
// 2026-10-22-rfb-mine-valg-eierbrytere, slice S2d-2, AC22) ───────────────────
// The hidden RFB test fixture (origin = 'test_fixture' AND catalog_hidden = 1,
// POST /admin/test-producer) is invisible everywhere, so an owner switch on it
// («Mine valg», visibility.*) cannot be observed. A request that carries a
// valid admin key AND the explicit opt-in `?as_public=1` (on one of the public
// surfaces listed in middleware/as-public-view.ts) runs inside this
// request-scoped context: the helpers in this file then read catalog_hidden as
// 0 for rows with origin = 'test_fixture' ONLY. Every other gate (is_active,
// vertical, vetting, role, owner pause, the owner's visibility choices) still
// applies, so toggling a switch on the fixture is observable. A real hidden
// row is never affected. Outside the context (every normal request, every
// boot/background job) every helper answers byte-identically to before.

/** The `agents.origin` the test fixture carries (routes/admin-test-producer.ts). */
export const TEST_FIXTURE_ORIGIN = "test_fixture";

const asPublicViewStore = new AsyncLocalStorage<true>();

/** Is the current request an admin's «Vis som offentlig» view? */
export function isAsPublicView(): boolean {
  return asPublicViewStore.getStore() === true;
}

/** Run `fn` (and everything it awaits) as an as-public view. */
export function runAsPublicView<T>(fn: () => T): T {
  return asPublicViewStore.run(true, fn);
}

/** The catalog_hidden half of the predicate on its own. */
export function notCatalogHiddenSql(alias?: string, opts: { asPublic?: boolean } = {}): string {
  const base = `COALESCE(${col(alias, "catalog_hidden")}, 0) = 0`;
  // As-public view: the fixture reads as not hidden. COALESCE keeps the OR
  // two-valued, so NOT (…) (notPubliclyListableAgentIdsSql) stays exact.
  if (opts.asPublic !== false && isAsPublicView()) {
    return `(${base} OR COALESCE(${col(alias, "origin")}, '') = '${TEST_FIXTURE_ORIGIN}')`;
  }
  return base;
}

/** In-memory twin of notCatalogHiddenSql() for a raw `agents` row. */
function catalogHiddenForView(row: { catalog_hidden?: number | null; origin?: string | null }): boolean {
  if ((row.catalog_hidden ?? 0) === 0) return false;
  return !(isAsPublicView() && row.origin === TEST_FIXTURE_ORIGIN);
}

/**
 * For the non-public pipelines that must leave the fixture alone but have no
 * business filtering on vertical (the RFB verifier batch pickers — their
 * vertical behaviour is unchanged by this slice): resolves the catalog_hidden
 * ids up front and returns ` AND <alias>.id NOT IN ('…')`, or "" when there
 * are none — so the caller's SQL is byte-identical to before on every DB
 * without a fixture (including the minimal hand-built schemas older tests
 * use). Ids come from our own table and are quote-escaped. A failed read
 * (no column) also yields "" — fail-open, the fixture is merely re-verified.
 * Deliberately NOT affected by the as-public view: not a public surface.
 */
export function catalogHiddenIdExclusionSql(
  db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } },
  alias?: string,
): string {
  let ids: string[];
  try {
    ids = (db.prepare("SELECT id FROM agents WHERE catalog_hidden = 1").all() as Array<{ id: string }>).map((r) => String(r.id));
  } catch {
    return "";
  }
  if (ids.length === 0) return "";
  return ` AND ${col(alias, "id")} NOT IN (${ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(", ")})`;
}

/**
 * SQL fragment for "publicly listable on an RFB surface". `alias` is the
 * table alias the caller's query uses for `agents` (omit for an unaliased
 * `FROM agents`). Always wrap-safe: it is a plain AND-chain (the as-public
 * view's OR is parenthesised), so it can be appended as `AND ${publicListableSql("a")}` anywhere.
 */
export function publicListableSql(alias?: string, opts: { ownerChoices?: boolean } = {}): string {
  // `ownerChoices: false` (SQL that outlives the request) never carries the
  // request-scoped as-public exception either.
  const base = `${notCatalogHiddenSql(alias, { asPublic: opts.ownerChoices !== false })} AND COALESCE(${col(alias, "vertical_id")}, '${RFB_VERTICAL_ID}') = '${RFB_VERTICAL_ID}'`;
  // S1b punkt 6: with OWNER_PAUSE_ENABLED on, an owner-paused profile is not
  // listable either. Flag off = the exact string above (byte-identical SQL).
  const paused = ownerPauseEnabled() ? `${base} AND ${notOwnerPausedSql(alias)}` : base;
  // S2c-2: a profile whose owner switched «Profilen er synlig»
  // (visibility.profile) off is not listable either — same effect as the
  // pause. "" (the exact string above) unless OWNER_FEATURES_ENFORCE is on and
  // an allowlisted profile resolves hidden. `ownerChoices: false` is for SQL
  // that outlives the request (the outreach VIEW built at boot): a baked-in
  // id list would go stale.
  return opts.ownerChoices === false ? paused : paused + notOwnerHiddenSql("profile", alias);
}

// ─── Owner pause — S1b punkt 6 «Pause som virker» (dev-request ─────────────
// 2026-10-22-rfb-mine-valg-eierbrytere) ──────────────────────────────────────
// A verified owner can pause their profile from /eier (visibility.profile =
// false), optionally with a resume date. Stored in its own additive table
// (NOT as columns on `agents`: extra agents columns shift SQLite's plan
// choice for the unordered public scans and so the row order of today's
// answers, which the MCP/API golden tests pin byte for byte):
//   owner_profile_pause(agent_id PK, paused_at, pause_until, set_by)
//   pause_until NULL = until the owner resumes; 'YYYY-MM-DD' = the pause ends
//   at the start of that UTC day. No row = not paused.
// While paused, the profile drops out of every surface that reads this file's
// predicates: publicListableSql() (search, lokal_search, lists, feeds,
// sitemap, llms*.txt, stats …) and isAgentPubliclyVisible() / the by-id
// lookups (lokal_info, MCP resource, card/info/vcard/trust, metrics). The
// resume date is evaluated at read time, so passing it restores everything
// with no job. Behind OWNER_PAUSE_ENABLED (default OFF): with the flag off no
// SQL or answer changes, and the table is never read.

/** Env flag (read at call time, "1" or "true" = on). Default OFF. */
export const OWNER_PAUSE_FLAG = "OWNER_PAUSE_ENABLED";

export function ownerPauseEnabled(): boolean {
  const v = process.env[OWNER_PAUSE_FLAG];
  return v === "1" || v === "true";
}

/** The pause table (created in database/init.ts). Has no `id` column, so an unaliased outer `id` stays the agent's. */
export const OWNER_PAUSE_TABLE = "owner_profile_pause";

/** Wrap-safe SQL: the `agents` row is NOT currently owner-paused. */
export function notOwnerPausedSql(alias?: string): string {
  return `${col(alias, "id")} NOT IN (SELECT agent_id FROM ${OWNER_PAUSE_TABLE} WHERE agent_id IS NOT NULL AND COALESCE(pause_until, '9999-12-31') > date('now'))`;
}

export interface OwnerPauseRow {
  owner_paused_at?: string | null;
  owner_pause_until?: string | null;
}

/**
 * The pause state of one agent as an OwnerPauseRow ({} when not paused or the
 * table is missing — fail-open, exactly today's visibility).
 */
export function readOwnerPauseRow(
  db: { prepare(sql: string): { get(...params: unknown[]): unknown } },
  agentId: string,
): OwnerPauseRow {
  try {
    const r = db
      .prepare(`SELECT paused_at, pause_until FROM ${OWNER_PAUSE_TABLE} WHERE agent_id = ?`)
      .get(agentId) as { paused_at: string | null; pause_until: string | null } | undefined;
    return r ? { owner_paused_at: r.paused_at, owner_pause_until: r.pause_until } : {};
  } catch {
    return {};
  }
}

/** In-memory twin of NOT notOwnerPausedSql(). `now` is injectable for tests. */
export function isOwnerPaused(row: OwnerPauseRow | null | undefined, now: Date = new Date()): boolean {
  if (!row || !row.owner_paused_at) return false;
  if (!row.owner_pause_until) return true;
  const today = now.toISOString().slice(0, 10);
  return String(row.owner_pause_until).slice(0, 10) > today;
}

/**
 * Query yielding the ids of every `agents` row that is NOT publicly listable
 * (the hidden fixture + non-RFB-vertical rows) — for tables keyed by agent_id
 * that cannot join `agents` themselves (analytics view counts).
 */
export function notPubliclyListableAgentIdsSql(): string {
  return `SELECT id FROM agents WHERE NOT (${publicListableSql()})`;
}

/**
 * In-memory twin of publicListableSql() for a raw `agents` row (snake_case
 * columns). Missing/NULL columns read exactly like the SQL COALESCE defaults.
 */
export function isPubliclyListable(row: ({ catalog_hidden?: number | null; vertical_id?: string | null; origin?: string | null } & OwnerPauseRow) | null | undefined): boolean {
  if (!row) return false;
  if (catalogHiddenForView(row)) return false;
  if (ownerPauseEnabled() && isOwnerPaused(row)) return false;
  return (row.vertical_id ?? RFB_VERTICAL_ID) === RFB_VERTICAL_ID;
}

// ─── Does /produsent/<slug> exist for this agent? — ONE shared predicate ────
// dev-request 2026-10-06-rfb-sitemap-rollesperre-bm-event-og-paraply-canonical
// (Skive A2). routes/seo.ts's GET /produsent/:slug 404s an agent when
//   - it is NOT an umbrella AND has a non-"producer" role (quality/logistics:
//     HANEN, Debio, Dyrket.no …), or
//   - it is not vetted (is_vetted = 0), or
//   - it is not publicly listable (hidden fixture / non-RFB vertical).
// Every surface that emits a link to /produsent/<slug> (agent card
// canonicalUrl/links.profile, API/MCP/llms-full lists) asks THIS function so
// nobody hands out a URL that would 404. Umbrellas always have a page.
// PURE (no imports).

/** The role half of the gate: true when the page would 404 on role alone. */
export function failsProducerRoleGate(role: string | null | undefined, isUmbrella: boolean): boolean {
  return !isUmbrella && !!role && role !== "producer";
}

/**
 * Raw `agents` row (snake_case columns). Missing columns read like the
 * route's defaults: is_vetted NULL/undefined = vetted (schema default 1),
 * no umbrella_type = not an umbrella.
 */
export function hasProducerPage(
  row:
    | {
        role?: string | null;
        umbrella_type?: string | null;
        is_vetted?: number | null;
        catalog_hidden?: number | null;
        vertical_id?: string | null;
        origin?: string | null;
      }
    | null
    | undefined,
): boolean {
  if (!row) return false;
  if (failsProducerRoleGate(row.role, !!row.umbrella_type)) return false;
  if (row.is_vetted != null && !row.is_vetted) return false;
  return isPubliclyListable(row);
}

// ─── By-id public visibility — ONE shared predicate (dev-request ────────────
// 2026-10-22-rfb-mine-valg-eierbrytere, slice S1a point 2) ───────────────────
// Until now each by-id surface did its own thing:
//   - /agents/:id/card|info|vcard|trust (and /api/agents/:id/stats) ask
//     marketplaceRegistry.isQuarantinedFromPublicView(): hidden when NOT
//     publicly listable (catalog_hidden / non-RFB vertical) OR a
//     self_registered agent that is not vetted. They do NOT look at is_active.
//   - lokal_info, the MCP producer-detail resource and /api/agents/:id/metrics
//     check nothing: any id that has a row is served, inactive or hidden.
//   - The list-shaped surfaces (llms.txt, llms-full.txt, sitemap.xml via
//     getActiveAgents(); the ACP catalog feeds via publicListableSql) already
//     filter in SQL; they get their fragment from here too so the rule lives
//     in one file.
//
// The first release preserves today's behaviour. The only new rule —
// `is_active = 0` is no longer served by id, and the ungated surfaces gain the
// quarantine rule — sits behind OWNER_VISIBILITY_ENFORCE_BY_ID (default OFF:
// with the flag unset every call below answers exactly as the surface did
// before). S2c-2 adds the owner's visibility choice (see the end of this file).
//
// Deliberate deviation: lokal_info passes `allowCatalogHidden` because the
// hidden RFB test fixture (catalog_hidden = 1) must stay orderable by id
// (dev-request 2026-10-01-rfb-skjult-testprodusent-for-ordreflyt AC1/AC2 —
// the order flow resolves product ids through lokal_info). It is still
// subject to is_active / vertical / vetted.

/** Env flag (read at call time, "1" or "true" = on). Default OFF. */
export const BY_ID_VISIBILITY_FLAG = "OWNER_VISIBILITY_ENFORCE_BY_ID";

export function byIdVisibilityEnforced(): boolean {
  const v = process.env[BY_ID_VISIBILITY_FLAG];
  return v === "1" || v === "true";
}

/** Raw `agents` row (snake_case columns); a missing column reads like the schema default. */
export interface AgentVisibilityRow extends OwnerPauseRow {
  is_active?: number | null;
  is_vetted?: number | null;
  catalog_hidden?: number | null;
  vertical_id?: string | null;
  origin?: string | null;
}

export interface AgentVisibilityOptions {
  /**
   * "gated"   — the surface already 404s quarantined agents today (card, info,
   *             vcard, trust, agent stats): flag off = today's quarantine rule.
   * "ungated" — the surface serves any existing id today (lokal_info, MCP
   *             resource, /metrics): flag off = visible.
   */
  surface: "gated" | "ungated";
  /** Keep the catalog_hidden test fixture reachable (lokal_info only). */
  allowCatalogHidden?: boolean;
  /**
   * S2c-2: "ai" = an AI-facing surface (MCP, A2A): the owner's «Synlig for
   * AI-assistenter» (visibility.ai_assistants) applies on top of
   * visibility.profile. Default: only visibility.profile.
   */
  audience?: OwnerVisibilityAudience;
  /** S2c-2: the row's id, so the owner's visibility choice can be read (isAgentPubliclyVisible). */
  agentId?: string;
}

/** Today's quarantine rule (what isQuarantinedFromPublicView() has always answered). */
function quarantinedToday(row: AgentVisibilityRow, allowCatalogHidden: boolean): boolean {
  const listable = isPubliclyListable(allowCatalogHidden ? { ...row, catalog_hidden: 0 } : row);
  if (!listable) return true;
  return row.origin === "self_registered" && row.is_vetted !== 1;
}

/**
 * May this agent be served on a public by-id surface? `null`/`undefined` (no
 * such row) is false. With the flag off: gated surfaces answer with today's
 * quarantine rule, ungated ones with true. With the flag on every surface
 * requires is_active, the quarantine rule (catalog_hidden, vertical, vetted).
 */
export function isAgentPubliclyVisible(row: AgentVisibilityRow | null | undefined, opts: AgentVisibilityOptions): boolean {
  if (!row) return false;
  // S1b punkt 6: an owner-paused profile is served on no by-id surface
  // (independent of OWNER_VISIBILITY_ENFORCE_BY_ID). Flag off = skipped.
  if (ownerPauseEnabled() && isOwnerPaused(row)) return false;
  // S2c-2: the owner's visibility choice (no query unless enforced + allowlisted).
  if (opts.agentId && ownerHidesAgent(opts.agentId, audienceChoice(opts.audience))) return false;
  if (!byIdVisibilityEnforced()) {
    return opts.surface === "gated" ? !quarantinedToday(row, false) : true;
  }
  if (row.is_active != null && !row.is_active) return false;
  return !quarantinedToday(row, opts.allowCatalogHidden === true);
}

/** Row lookup + isAgentPubliclyVisible() for callers that only hold an id. */
export function isAgentIdPubliclyVisible(
  db: { prepare(sql: string): { get(...params: unknown[]): unknown } },
  agentId: string,
  opts: AgentVisibilityOptions,
): boolean {
  // S2c-2: the owner's visibility choice first (no query unless
  // OWNER_FEATURES_ENFORCE is on and the id is allowlisted).
  if (ownerHidesAgent(agentId, audienceChoice(opts.audience))) return false;
  // Flag off + ungated: today's answer is "yes" without reading anything.
  const pause = ownerPauseEnabled();
  if (opts.surface === "ungated" && !byIdVisibilityEnforced() && !pause) return true;
  const found = db
    .prepare("SELECT is_active, is_vetted, catalog_hidden, vertical_id, origin FROM agents WHERE id = ?")
    .get(agentId) as AgentVisibilityRow | undefined;
  if (!found && opts.surface === "ungated" && !byIdVisibilityEnforced()) return true;
  // The pause table is only read with OWNER_PAUSE_ENABLED on.
  const row = found && pause ? { ...found, ...readOwnerPauseRow(db, agentId) } : found;
  return isAgentPubliclyVisible(row, opts);
}

/**
 * SQL twin for the feeds: publicListableSql() plus, with the flag on,
 * `is_active = 1`. Flag off = exactly publicListableSql(alias). Same
 * wrap-safe AND-chain.
 */
export function publiclyVisibleSql(alias?: string): string {
  const base = publicListableSql(alias);
  return byIdVisibilityEnforced() ? `${base} AND COALESCE(${col(alias, "is_active")}, 1) = 1` : base;
}

/**
 * The visibility half of getActiveAgents() (llms.txt, llms-full.txt,
 * sitemap.xml, agents.json …): active + vetted + publicly listable. Unchanged
 * semantics — only moved here so the rule lives in one file.
 */
export function activeVettedListableSql(alias?: string): string {
  return `${col(alias, "is_active")} = 1 AND ${col(alias, "is_vetted")} = 1 AND ${publicListableSql(alias)}`;
}

// ─── «Mine valg» — the owner's visibility choices (dev-request ──────────────
// 2026-10-22-rfb-mine-valg-eierbrytere, slice S2c-2) ─────────────────────────
// The six «Hvem kan finne deg» keys, enforced through THIS file so every
// surface asks the same predicate:
//   profile         visibility.profile — same effect as the owner pause:
//                   publicListableSql() (search, lists, feeds, sitemap,
//                   llms*.txt …) and every by-id check above; the profile page
//                   shows «Midlertidig pause» (isProfileOwnerHidden).
//   ai_assistants   visibility.ai_assistants — AI-facing surfaces only
//                   (audience "ai": MCP tools + resource, A2A, the REST
//                   search/discover API, llms*.txt).
//   search_engines  visibility.search_engines — noindex on the profile page,
//                   left out of sitemap.xml (and so of IndexNow).
//   shopping_feeds  visibility.shopping_feeds — the ACP feed and CSV.
//   english         visibility.english — no /en profile page, no EN hreflang,
//                   no EN sitemap entry.
//   leaderboard     visibility.leaderboard — /api/leaderboard.
// A key is hidden for a profile when it OR visibility.profile resolves off
// (the registry's `requires: visibility.profile`).
//
// Gate: OWNER_FEATURES_ENFORCE ("1"/"true") — read here without any import —
// AND the profile in OWNER_FEATURES_ALLOWED_SUBJECTS (checked by the lazily
// required owner-features/visibility.ts, which holds the lookup). Gate off:
// every helper below answers "nothing hidden" without a query or a require,
// and every SQL fragment is "" (byte-identical SQL). List surfaces get ONE
// id-set per call (one query for all allowlisted profiles), never a lookup
// per row. The lazy require keeps this file import-free (marketplace-registry
// isolation) and avoids an import cycle (database/init imports this file).

export type OwnerVisibilityChoice =
  | "profile" | "ai_assistants" | "search_engines" | "shopping_feeds" | "english" | "leaderboard";

export const OWNER_VISIBILITY_CHOICES: readonly OwnerVisibilityChoice[] = [
  "profile", "ai_assistants", "search_engines", "shopping_feeds", "english", "leaderboard",
];

export type OwnerVisibilityAudience = "all" | "ai";

function audienceChoice(audience: OwnerVisibilityAudience | undefined): OwnerVisibilityChoice {
  return audience === "ai" ? "ai_assistants" : "profile";
}

const OWNER_FEATURES_ENFORCE_FLAG = "OWNER_FEATURES_ENFORCE";

/** Is the owner-choice enforcement switched on at all (env only, no DB)? */
export function ownerVisibilityEnforced(): boolean {
  const v = process.env[OWNER_FEATURES_ENFORCE_FLAG];
  return v === "1" || v === "true";
}

interface OwnerVisibilityModule {
  ownerHiddenIdsFor(choice: OwnerVisibilityChoice): ReadonlySet<string>;
  ownerHiddenChoicesFor(agentId: string): ReadonlySet<OwnerVisibilityChoice>;
}

function ownerVisibilityModule(): OwnerVisibilityModule {
  return require("../owner-features/visibility") as OwnerVisibilityModule;
}

const NONE_HIDDEN: ReadonlySet<never> = new Set<never>();

/** Ids of the profiles hidden for `choice` (empty, without a query, when not enforced). */
export function ownerHiddenAgentIds(choice: OwnerVisibilityChoice): ReadonlySet<string> {
  if (!ownerVisibilityEnforced()) return NONE_HIDDEN;
  return ownerVisibilityModule().ownerHiddenIdsFor(choice);
}

/** The choices that hide this profile (empty, without a query, when not enforced or not allowlisted). */
export function ownerHiddenChoices(agentId: string): ReadonlySet<OwnerVisibilityChoice> {
  if (!agentId || !ownerVisibilityEnforced()) return NONE_HIDDEN;
  return ownerVisibilityModule().ownerHiddenChoicesFor(agentId);
}

/** Does the owner's choice hide this profile on a `choice` surface? */
export function ownerHidesAgent(agentId: string, choice: OwnerVisibilityChoice): boolean {
  return ownerHiddenChoices(agentId).has(choice);
}

/**
 * ` AND <alias>.id NOT IN ('…')` for the profiles hidden for `choice`, or ""
 * when none is (always "" with the gate off). Ids come from our own table
 * and are quote-escaped. Append it after an existing condition.
 */
export function notOwnerHiddenSql(choice: OwnerVisibilityChoice, alias?: string): string {
  const ids = ownerHiddenAgentIds(choice);
  if (ids.size === 0) return "";
  return ` AND ${col(alias, "id")} NOT IN (${[...ids].sort().map((id) => `'${id.replace(/'/g, "''")}'`).join(", ")})`;
}

/** `list` without the profiles hidden for `choice` — the same array when none is. */
export function withoutOwnerHidden<T extends { id: string }>(list: T[], choice: OwnerVisibilityChoice): T[] {
  const ids = ownerHiddenAgentIds(choice);
  if (ids.size === 0) return list;
  return list.filter((x) => !ids.has(x.id));
}

/**
 * Should /produsent/:slug show «Midlertidig pause» for this profile: owner
 * pause (OWNER_PAUSE_ENABLED) or visibility.profile off (enforced)? No query
 * with both gates off.
 */
export function isProfileOwnerHidden(
  db: { prepare(sql: string): { get(...params: unknown[]): unknown } },
  agentId: string,
): boolean {
  if (ownerPauseEnabled() && isOwnerPaused(readOwnerPauseRow(db, agentId))) return true;
  return ownerHidesAgent(agentId, "profile");
}
