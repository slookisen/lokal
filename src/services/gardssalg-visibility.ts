/**
 * gardssalg-visibility.ts — ONE predicate for "is this gårdssalg provider row
 * publicly visible on surface X", the single source of truth for every
 * public gårdssalg surface.
 *
 * dev-request 2026-10-22-opplevagent-mine-valg-gardssalg, G1 point 5
 * («Synlighet per flate»). This first edition is a pure refactor: it
 * PRESERVES today's semantics byte-for-byte. Before it, the same three
 * clauses were copy-pasted as SQL fragments in ~10 places
 * (experience-store.ts, route-corridor-service.ts, gardssalg-claim.ts). G2
 * will let the owner's choices feed into this predicate; nothing in here
 * reads an owner choice yet.
 *
 * The three clauses (all on experience_providers):
 *   group   — «is a gårdssalg producer»:
 *             producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed'
 *   hidden  — catalog_hidden IS NULL OR catalog_hidden != 1
 *             (admin visibility lever, owner «fjern», test fixture)
 *   merged  — merged_into IS NULL OR merged_into = ''
 *             (a folded-away duplicate is never public)
 *
 * Flate -> rule (today; every row is the same except `claim`):
 *
 *   surface  | served by                                              | group | hidden | merged
 *   ---------+--------------------------------------------------------+-------+--------+-------
 *   web      | category grid, counts, stats, produsent profile + book | yes   | yes    | yes
 *   map      | /kategori/gardssalg map points, route corridor         | yes   | yes    | yes
 *   search   | /sok producer search                                   | yes   | yes    | yes
 *   sitemap  | sitemap.xml producer URLs (IndexNow reads the sitemap  | yes   | yes    | yes
 *            | set — no separate IndexNow list exists)               |       |        |
 *   mcp      | discover_gardssalg / book_gardssalg / category counts  | yes   | yes    | yes
 *   a2a      | gardssalg_discover / opplevelser_info                  | yes   | yes    | yes
 *   rest     | /api/opplevelser/discover, POST /book                  | yes   | yes    | yes
 *   claim    | «Er dette din bedrift?» entry + portal slug lookup     | NO    | yes    | yes
 *
 * The one deliberate difference: `claim` never required the gårdssalg group
 * (getClaimProviderBySlug has always looked up any provider by slug — see
 * the dev-request's «Context»). It is kept as-is; do not «fix» it here.
 *
 * `includeHidden` (ADMIN-ONLY) skips the `hidden` clause only; `merged` still
 * applies. Only the admin-key-gated booking test-send route uses it.
 *
 * Not covered here, on purpose: the EXPERIENCE publish gate
 * (PUBLISH_GATE_SQL in experience-store.ts — verification_status /
 * needs_review quarantine, brreg_active, canonical_id) governs `experiences`
 * rows, not gårdssalg provider rows, and is already one shared constant.
 * Admin/cohort sweeps that filter on catalog_hidden for their own reasons
 * also stay as they are.
 */

export type GardssalgSurface = "web" | "map" | "search" | "sitemap" | "mcp" | "a2a" | "rest" | "claim";

export const GARDSSALG_SURFACES: readonly GardssalgSurface[] = [
  "web", "map", "search", "sitemap", "mcp", "a2a", "rest", "claim",
];

export interface GardssalgSurfaceRule {
  requireGroup: boolean;
  hideCatalogHidden: boolean;
  hideMerged: boolean;
}

const PUBLIC_RULE = (): GardssalgSurfaceRule => ({ requireGroup: true, hideCatalogHidden: true, hideMerged: true });

/** The flate -> rule table above, as data. Exported (mutable) only so the
 *  suite can prove every surface reads it; production code never writes it. */
export const GARDSSALG_SURFACE_RULES: Record<GardssalgSurface, GardssalgSurfaceRule> = {
  web: PUBLIC_RULE(),
  map: PUBLIC_RULE(),
  search: PUBLIC_RULE(),
  sitemap: PUBLIC_RULE(),
  mcp: PUBLIC_RULE(),
  a2a: PUBLIC_RULE(),
  rest: PUBLIC_RULE(),
  claim: { requireGroup: false, hideCatalogHidden: true, hideMerged: true },
};

export interface GardssalgVisibilityOpts {
  /** ADMIN-ONLY: do not apply the catalog_hidden clause. */
  includeHidden?: boolean;
}

export interface GardssalgVisibilityRow {
  producer_type?: string | null;
  rfb_seed_source?: string | null;
  catalog_hidden?: number | null;
  merged_into?: string | null;
}

const SQL_GROUP = "(producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')";
const SQL_HIDDEN = "(catalog_hidden IS NULL OR catalog_hidden != 1)";
const SQL_MERGED = "(merged_into IS NULL OR merged_into = '')";

/**
 * SQL WHERE fragment (no leading WHERE/AND, no bound parameters, unqualified
 * column names) for surface `surface`. Parens
 * around each clause are load-bearing: callers append further ANDs.
 */
export function gardssalgVisibleSql(surface: GardssalgSurface, opts: GardssalgVisibilityOpts = {}): string {
  const rule = GARDSSALG_SURFACE_RULES[surface];
  const parts: string[] = [];
  if (rule.requireGroup) parts.push(SQL_GROUP);
  if (rule.hideCatalogHidden && opts.includeHidden !== true) parts.push(SQL_HIDDEN);
  if (rule.hideMerged) parts.push(SQL_MERGED);
  // Never empty: a SQL fragment is spliced after WHERE. (Only reachable if a
  // rule is weakened, which production code never does.)
  return parts.length > 0 ? parts.join(" AND ") : "1 = 1";
}

/** Row-level twin of gardssalgVisibleSql(): same answer for the same row. */
export function isGardssalgVisibleOnSurface(
  row: GardssalgVisibilityRow,
  surface: GardssalgSurface,
  opts: GardssalgVisibilityOpts = {},
): boolean {
  const rule = GARDSSALG_SURFACE_RULES[surface];
  if (rule.requireGroup && !(row.producer_type != null || row.rfb_seed_source === "rfb-seed")) return false;
  if (rule.hideCatalogHidden && opts.includeHidden !== true && row.catalog_hidden != null && Number(row.catalog_hidden) === 1) return false;
  if (rule.hideMerged && !(row.merged_into == null || row.merged_into === "")) return false;
  return true;
}
