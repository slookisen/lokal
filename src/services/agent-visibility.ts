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
// PURE (no imports), so marketplace-registry.ts can use it without breaching
// its rfb-vertical isolation (same rule as geo-distance.ts).

/** The only vertical whose `agents` rows are RFB food producers. */
export const RFB_VERTICAL_ID = "rfb";

function col(alias: string | undefined, name: string): string {
  return alias ? `${alias}.${name}` : name;
}

/** The catalog_hidden half of the predicate on its own. */
export function notCatalogHiddenSql(alias?: string): string {
  return `COALESCE(${col(alias, "catalog_hidden")}, 0) = 0`;
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
 * `FROM agents`). Always wrap-safe: it is a plain AND-chain with no OR, so it
 * can be appended as `AND ${publicListableSql("a")}` anywhere.
 */
export function publicListableSql(alias?: string): string {
  return `${notCatalogHiddenSql(alias)} AND COALESCE(${col(alias, "vertical_id")}, '${RFB_VERTICAL_ID}') = '${RFB_VERTICAL_ID}'`;
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
export function isPubliclyListable(row: { catalog_hidden?: number | null; vertical_id?: string | null } | null | undefined): boolean {
  if (!row) return false;
  if ((row.catalog_hidden ?? 0) !== 0) return false;
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
// before). S2 will teach this predicate to read the owner's visibility choice.
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
export interface AgentVisibilityRow {
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
  // Flag off + ungated: today's answer is "yes" without reading anything.
  if (opts.surface === "ungated" && !byIdVisibilityEnforced()) return true;
  const row = db
    .prepare("SELECT is_active, is_vetted, catalog_hidden, vertical_id, origin FROM agents WHERE id = ?")
    .get(agentId) as AgentVisibilityRow | undefined;
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
