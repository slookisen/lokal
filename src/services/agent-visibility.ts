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
