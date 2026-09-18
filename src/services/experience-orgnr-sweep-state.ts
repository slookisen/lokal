// ─── experience-orgnr-sweep-state.ts ────────────────────────────────────────
//
// Persisted `after`-cursor for POST /admin/experiences-orgnr-from-website
// (Trinn A) and POST /admin/experiences-orgnr-from-name-kommune (Trinn B) —
// dev-request 2026-09-14-opplevagent-karantene-utgang-brreg-krav, FUNN
// "orgnr-fra-webside-og-navn-kommune-mangler-cron-kobling-og-persistert-
// cursor". Both routes take an optional keyset-pagination `after` cursor in
// the request body; without persistence, a naive periodic caller that always
// omits it would re-scan the same unresolvable leading window of the
// brreg_active IS NULL backlog forever and never progress. These two
// functions are the persisted memory the routes now keep, keyed by `route` —
// see experience_orgnr_sweep_state (database/init-experiences.ts) for the
// table and each route's own doc comment (routes/opplevelser.ts) for exactly
// when each is called (only on the OMITTED-`after` path — an explicit
// `after` in the request stays purely request-driven, unchanged from before
// this dev-request, and never reads or writes this table either way).
//
// Same pattern, same idiom, as gardssalg_website_verification_sweep_state's
// own getGardssalgWebsiteVerificationSweepOffset/
// setGardssalgWebsiteVerificationSweepOffset (services/gardssalg-website-
// verification.ts) — adapted from a plain INTEGER offset to a TEXT keyset
// cursor (the last-scanned provider id), since that is what these two
// services' own `after`/`next_after` already are. A shared, small file (not
// folded into either service) because the cursor bookkeeping is identical
// for both otherwise-independent routes.

import type Database from "better-sqlite3";

/** The two routes sharing this table — see experience_orgnr_sweep_state's
 * own PRIMARY KEY. */
export type ExperienceOrgnrSweepRoute = "orgnr_from_website" | "orgnr_from_name_kommune";

/** Absence of a row (fresh DB, or a route never swept via the omitted-`after`
 *  path yet) means "resume from the start" — returns undefined, the exact
 *  shape experienceOrgnrFromWebsiteTick()'s/experienceOrgnrFromNameKommuneTick()'s
 *  own `deps.after` already expects for "start from the beginning". Never
 *  throws. */
export function getExperienceOrgnrSweepAfter(
  db: Database.Database,
  route: ExperienceOrgnrSweepRoute
): string | undefined {
  const row = db
    .prepare(`SELECT next_after FROM experience_orgnr_sweep_state WHERE route = ?`)
    .get(route) as { next_after: string | null } | undefined;
  return row?.next_after ?? undefined;
}

/** Persist where the NEXT omitted-`after` call for this route should resume.
 *  Pass `null` (the shape the tick's own `next_after` itself uses) when the
 *  route's backlog was exhausted this call — persisted as NULL, so the
 *  FOLLOWING call starts a fresh pass through the backlog rather than being
 *  stuck reporting "nothing left" forever. */
export function setExperienceOrgnrSweepAfter(
  db: Database.Database,
  route: ExperienceOrgnrSweepRoute,
  nextAfter: string | null
): void {
  db.prepare(
    `INSERT INTO experience_orgnr_sweep_state (route, next_after, updated_at)
     VALUES (@route, @next_after, datetime('now'))
     ON CONFLICT(route) DO UPDATE SET
       next_after = excluded.next_after,
       updated_at = excluded.updated_at`
  ).run({ route, next_after: nextAfter });
}
