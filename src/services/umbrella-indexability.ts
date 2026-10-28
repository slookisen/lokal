// ─── Is an umbrella page worth indexing? — ONE shared predicate ─────────────
// dev-request 2026-10-06-rfb-sitemap-rollesperre-bm-event-og-paraply-canonical
// (Skive B, option A). An umbrella page (/produsent/<slug> for an agent with a
// non-null umbrella_type: market networks, lokallag, venues, orgs) is "empty"
// when it shows NO members and NO upcoming market days. An empty umbrella page
// answers 200 but carries robots noindex, and it is left out of the sitemap.
//
// The membership and event clauses mirror, clause for clause, what the
// umbrella render in routes/seo.ts lists:
//   members  = direct children (agents.parent_umbrella_id = umbrella, active,
//              publicly listable)
//            + active agent_affiliations rows whose producer is active and
//              publicly listable;
//   events   = bm_market_events with start_at >= now, only for the Bondens
//              marked tree, exactly as the page's «Kommende markedsdager» card:
//                venue    -> its own events,
//                lokallag -> events at its venues (or at itself),
//                national («Bondens marked Norge») -> any BM event,
//              each with the page's bm_venue review condition.
// Both the route (one id) and the sitemap (all umbrellas in ONE query, never
// one SELECT per umbrella) run the same SQL below.

import { publicListableSql, activeVettedListableSql } from "./agent-visibility";

type Db = { prepare(sql: string): { all(...params: unknown[]): unknown[] } };

/** Name of the national Bondens marked umbrella, lower-cased (the page compares agent.name.toLowerCase()). */
const BM_NATIONAL_NAME_LOWER = "bondens marked norge";

/**
 * Wrap-safe SQL: the umbrella row aliased `u` has at least one member or one
 * upcoming market day. Uses the named parameter `@now` (ISO timestamp) when
 * `withEvents` is true.
 */
export function umbrellaHasContentSql(withEvents: boolean = true): string {
  const members = `EXISTS (SELECT 1 FROM agents c
        WHERE c.parent_umbrella_id = u.id AND c.is_active = 1 AND ${publicListableSql("c")})
    OR EXISTS (SELECT 1 FROM agent_affiliations aff INNER JOIN agents p ON p.id = aff.producer_id
        WHERE aff.umbrella_id = u.id AND aff.status = 'active' AND p.is_active = 1 AND ${publicListableSql("p")})`;
  if (!withEvents) return `(${members})`;
  // Same review condition as the page's three event queries.
  const reviewed = (v: string) => `(${v}.umbrella_type != 'bm_venue' OR ${v}.agent_review_status = 'confirmed')`;
  const events = `
    OR (u.umbrella_type = 'venue' AND EXISTS (SELECT 1 FROM bm_market_events e
        WHERE e.venue_agent_id = u.id AND e.start_at >= @now AND ${reviewed("u")}))
    OR (u.umbrella_type = 'market_network' AND COALESCE(u.parent_umbrella_id, '') <> ''
        AND EXISTS (SELECT 1 FROM bm_market_events e INNER JOIN agents v ON v.id = e.venue_agent_id
          WHERE (v.parent_umbrella_id = u.id OR e.venue_agent_id = u.id) AND e.start_at >= @now AND ${reviewed("v")}))
    OR (LOWER(u.name) = '${BM_NATIONAL_NAME_LOWER}'
        AND EXISTS (SELECT 1 FROM bm_market_events e INNER JOIN agents v ON v.id = e.venue_agent_id
          WHERE e.start_at >= @now AND ${reviewed("v")}))`;
  return `(${members}${events})`;
}

/**
 * Runs `SELECT u.id, u.name FROM agents u WHERE <where> AND <has content>`.
 * If the event table is missing (fresh deploy before the BM scraper, minimal
 * schemas) the page silently omits events, so this retries without the event
 * clause. Returns null when even that fails.
 */
function selectWithContent(db: Db, where: string, params: Record<string, unknown>, nowIso: string): Array<{ id: string; name: string }> | null {
  try {
    return db.prepare(`SELECT u.id AS id, u.name AS name FROM agents u WHERE ${where} AND ${umbrellaHasContentSql(true)}`)
      .all({ ...params, now: nowIso }) as Array<{ id: string; name: string }>;
  } catch {
    try {
      return db.prepare(`SELECT u.id AS id, u.name AS name FROM agents u WHERE ${where} AND ${umbrellaHasContentSql(false)}`)
        .all(params) as Array<{ id: string; name: string }>;
    } catch (e) {
      console.error("[umbrella-indexability] content query failed:", e);
      return null;
    }
  }
}

/**
 * Route side: true = the umbrella has members or upcoming market days,
 * false = empty (page gets noindex), null = could not tell (fail-open: the
 * page stays indexable, exactly as before this predicate existed).
 */
export function umbrellaHasContent(db: Db, umbrellaId: string, nowIso: string = new Date().toISOString()): boolean | null {
  const rows = selectWithContent(db, "u.id = @id", { id: umbrellaId }, nowIso);
  return rows === null ? null : rows.length > 0;
}

/**
 * Sitemap side, ONE query: every umbrella whose /produsent/<slug> page answers
 * 200 under the route's gates (active, vetted, publicly listable; umbrellas
 * pass the role gate by definition) AND is not empty. Ordered like the route's
 * slug lookup scan. null = query failed (the caller lists no umbrellas).
 */
export function indexableUmbrellas(db: Db, nowIso: string = new Date().toISOString()): Array<{ id: string; name: string }> | null {
  return selectWithContent(db, `COALESCE(u.umbrella_type, '') <> '' AND ${activeVettedListableSql("u")}`, {}, nowIso);
}
