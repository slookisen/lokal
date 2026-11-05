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
 *   claim    | «Er dette din bedrift?» entry + portal slug lookup     | NO    | yes*   | yes
 *            | (* except catalog_hidden_reason='owner_pause', lokal#1235,
 *            |  and the test fixture, O2a — see below)
 *
 * The one deliberate difference: `claim` never required the gårdssalg group
 * (getClaimProviderBySlug has always looked up any provider by slug — see
 * the dev-request's «Context»). It is kept as-is; do not «fix» it here.
 *
 * `includeHidden` (ADMIN-ONLY) skips the `hidden` clause only; `merged` still
 * applies. Only the admin-key-gated booking test-send route uses it.
 *
 * The test fixture (slice O2a of the same dev-request): the one test producer
 * (is_test_provider = 1) is hidden with catalog_hidden_reason='test_fixture'
 * (POST /admin/gardssalg/test-provider). Every public surface keeps hiding it.
 * Two places read it as not hidden, and only for is_test_provider = 1:
 *   - `claim`, always — so its owner reaches the portal and «Mine valg», as
 *     with the owner's own pause;
 *   - the public surfaces inside an admin's «Vis som offentlig» request
 *     (isAsPublicView(), middleware/as-public-view.ts: X-Admin-Key +
 *     ?as_public=1 on a covered Opplevagent read path). Outside that request
 *     context the SQL is byte-identical to before.
 * Any other hidden row (reason NULL, remove_request, quality, owner_pause on
 * the public surfaces) is never affected.
 *
 * Not covered here, on purpose: the EXPERIENCE publish gate
 * (PUBLISH_GATE_SQL in experience-store.ts — verification_status /
 * needs_review quarantine, brreg_active, canonical_id) governs `experiences`
 * rows, not gårdssalg provider rows, and is already one shared constant.
 * Admin/cohort sweeps that filter on catalog_hidden for their own reasons
 * also stay as they are.
 */

import { isAsPublicView } from "./agent-visibility";

export type GardssalgSurface = "web" | "map" | "search" | "sitemap" | "mcp" | "a2a" | "rest" | "claim";

export const GARDSSALG_SURFACES: readonly GardssalgSurface[] = [
  "web", "map", "search", "sitemap", "mcp", "a2a", "rest", "claim",
];

export interface GardssalgSurfaceRule {
  requireGroup: boolean;
  hideCatalogHidden: boolean;
  hideMerged: boolean;
  /** catalog_hidden=1 rows with exactly this catalog_hidden_reason stay visible
   *  on the surface (claim: the owner's own pause, lokal#1235 — the owner must
   *  still reach the portal to resume). */
  hiddenExceptReason?: string;
  /** The test fixture (catalog_hidden_reason='test_fixture' AND
   *  is_test_provider = 1) stays visible on the surface (claim, O2a). */
  hiddenExceptTestFixture?: boolean;
}

/** catalog_hidden_reason of the hidden gårdssalg test producer (O2a). */
export const GARDSSALG_TEST_FIXTURE_REASON = "test_fixture";

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
  claim: { requireGroup: false, hideCatalogHidden: true, hideMerged: true, hiddenExceptReason: "owner_pause", hiddenExceptTestFixture: true },
};

export interface GardssalgVisibilityOpts {
  /** ADMIN-ONLY: do not apply the catalog_hidden clause. */
  includeHidden?: boolean;
}

export interface GardssalgVisibilityRow {
  producer_type?: string | null;
  rfb_seed_source?: string | null;
  catalog_hidden?: number | null;
  catalog_hidden_reason?: string | null;
  is_test_provider?: number | null;
  merged_into?: string | null;
}

const SQL_GROUP = "(producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')";
const SQL_HIDDEN = "(catalog_hidden IS NULL OR catalog_hidden != 1)";
const SQL_MERGED = "(merged_into IS NULL OR merged_into = '')";
const SQL_TEST_FIXTURE = `(catalog_hidden_reason = '${GARDSSALG_TEST_FIXTURE_REASON}' AND is_test_provider = 1)`;

/** The test fixture reads as not hidden: always on `claim`, and on every
 *  surface inside an admin's as-public request (O2a). */
function testFixtureVisible(rule: GardssalgSurfaceRule): boolean {
  return rule.hiddenExceptTestFixture === true || isAsPublicView();
}

function isTestFixtureRow(row: GardssalgVisibilityRow): boolean {
  return row.catalog_hidden_reason === GARDSSALG_TEST_FIXTURE_REASON && Number(row.is_test_provider) === 1;
}

/**
 * SQL WHERE fragment (no leading WHERE/AND, no bound parameters, unqualified
 * column names) for surface `surface`. Parens
 * around each clause are load-bearing: callers append further ANDs.
 */
export function gardssalgVisibleSql(surface: GardssalgSurface, opts: GardssalgVisibilityOpts = {}): string {
  const rule = GARDSSALG_SURFACE_RULES[surface];
  const parts: string[] = [];
  if (rule.requireGroup) parts.push(SQL_GROUP);
  if (rule.hideCatalogHidden && opts.includeHidden !== true) {
    const except: string[] = [];
    if (rule.hiddenExceptReason) except.push(`catalog_hidden_reason = '${rule.hiddenExceptReason}'`);
    if (testFixtureVisible(rule)) except.push(SQL_TEST_FIXTURE);
    parts.push(except.length > 0
      ? `(catalog_hidden IS NULL OR catalog_hidden != 1 OR ${except.join(" OR ")})`
      : SQL_HIDDEN);
  }
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
  if (rule.hideCatalogHidden && opts.includeHidden !== true && row.catalog_hidden != null && Number(row.catalog_hidden) === 1
      && !(rule.hiddenExceptReason && row.catalog_hidden_reason === rule.hiddenExceptReason)
      && !(testFixtureVisible(rule) && isTestFixtureRow(row))) return false;
  if (rule.hideMerged && !(row.merged_into == null || row.merged_into === "")) return false;
  return true;
}
