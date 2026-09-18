// ─── Skop-katalogen: gårdssalg/mat_drikke in-scope gate ─────────────────────
//
// dev-request 2026-09-18-opplevagent-skop-katalogen-til-gardssalg-og-drikke
// (del 1 — "stop the inflow", NOT unpublishing). Daniel-approved live.
//
// PROBLEM. The experiences catalog has drifted into a generic tourism
// catalog: of 546 published rows, only 24 carry `mat_drikke` — the rest are
// museums, fortresses, restaurants, spas etc., unrelated to this platform's
// actual mission (farm-sales/gårdssalg + food/drink). Every night,
// judge/Brreg/enrichment budget is spent harvesting, judging and enriching
// out-of-scope rows.
//
// SCOPE RULE. A row is IN SCOPE if AT LEAST ONE holds:
//   1. Its provider is in the "gårdssalg cohort" — the SAME predicate
//      listGardssalgProviders() / countGardssalgProviders() /
//      computeGardssalgReadinessRows() (src/routes/opplevelser.ts,
//      src/services/experience-store.ts) already use:
//      `producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed'`.
//      Reused here VERBATIM (GARDSSALG_COHORT_PREDICATE_SQL /
//      isProviderInGardssalgCohort) — never hand-copied into a diverging
//      fourth place.
//   2. The experience has `mat_drikke` among its categories. `category` is a
//      single TEXT column today, but per Daniel's explicit rule
//      ("ingenting faller ut på en kategoriseringsfeil" — nothing should
//      fall out on a categorization error) a harvested row occasionally
//      carries a comma-separated composite ("mat_drikke,kultur_historie").
//      categoryIncludesMatDrikke()/matDrikkeCategorySql() are therefore
//      INCLUSIVE on ambiguity: they split on commas and match `mat_drikke`
//      as any one token, never requiring it to be the row's ONLY category.
//
// Everything else is OUT of scope.
//
// HARD INVARIANT — this module is read-only. It never writes a row, never
// changes verification_status/catalog_hidden/anything else. It only answers
// "is this row/provider in scope" for the 3 call sites (bulk-load harvest,
// experiences-content-judge-sweep, the 2 org.nr enrichment tricks) to skip
// (and count) out-of-scope rows BEFORE spending judge/Brreg/fetch budget on
// them — never to demote or hide an already-existing row.

const MAT_DRIKKE = "mat_drikke";

export type ScopeProviderCohortFields = {
  producer_type?: string | null;
  rfb_seed_source?: string | null;
};

/** The gårdssalg-cohort predicate every existing read path in
 * experience-store.ts / opplevelser.ts uses (producer_type set OR seeded via
 * RFB) — kept as one constant so new scope-gating code below reuses it
 * instead of a hand-copied, potentially-diverging string. Existing call
 * sites keep their own byte-identical `rfb_seed_source = 'rfb-seed'` text
 * (untouched); THIS constant instead uses SQLite's NULL-safe `IS` for that
 * comparison — `x = 'rfb-seed'` evaluates to SQL NULL (not FALSE) when x IS
 * NULL, which is harmless standing alone in a WHERE clause (NULL, like
 * FALSE, excludes the row) but corrupts `NOT (...)` — a NULL row-cohort
 * check wrapped in NOT() stays NULL, not TRUE, so it silently vanishes from
 * BOTH "in scope" and "out of scope" queries. providerInScopeSql() below
 * negates this predicate directly (no EXISTS() wrapper to absorb the NULL,
 * unlike providerCohortExistsSql()'s subquery), so it needs the NULL-safe
 * form to make `skipped_out_of_scope` counting correct. `IS` behaves
 * identically to `=` for any non-NULL comparison, so this is a pure
 * bugfix, never a behavior change for the ordinary (non-negated) case. */
export const GARDSSALG_COHORT_PREDICATE_SQL =
  "(producer_type IS NOT NULL OR rfb_seed_source IS 'rfb-seed')";

/** JS-side counterpart of GARDSSALG_COHORT_PREDICATE_SQL, for a provider row
 * already fetched into memory (e.g. getProviderByOrgnr()/getProviderByName()
 * -shaped Record<string, unknown>, or a plain {producer_type, rfb_seed_source}
 * object). `null`/`undefined` (no provider resolved yet) is never in scope
 * via this check alone — a brand-new bulk-load provider has neither field
 * set at creation time, so it only enters scope via the category rule below
 * until a LATER classification pass gives it a producer_type. */
export function isProviderInGardssalgCohort(
  provider: ScopeProviderCohortFields | Record<string, unknown> | null | undefined,
): boolean {
  if (!provider) return false;
  const p = provider as ScopeProviderCohortFields;
  return p.producer_type != null || p.rfb_seed_source === "rfb-seed";
}

/** True when `category` (a single value, or a comma-separated composite —
 * see file header) includes `mat_drikke` among its tokens. Case/whitespace
 * tolerant; `null`/blank is never in scope via this rule. */
export function categoryIncludesMatDrikke(category: string | null | undefined): boolean {
  if (!category) return false;
  return category
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .includes(MAT_DRIKKE);
}

/** The one shared in-scope predicate every call site below wires in: a
 * provider already known to be in the gårdssalg cohort (pass either the
 * pre-computed boolean via `providerInCohort`, or the raw `provider` row and
 * let this function compute it), OR the row's own category includes
 * mat_drikke. Inclusive-OR, per the scope rule above. */
export function isExperienceInScope(input: {
  providerInCohort?: boolean;
  provider?: ScopeProviderCohortFields | Record<string, unknown> | null;
  category?: string | null;
}): boolean {
  const providerInCohort =
    input.providerInCohort !== undefined ? input.providerInCohort : isProviderInGardssalgCohort(input.provider);
  return providerInCohort || categoryIncludesMatDrikke(input.category ?? null);
}

/** SQL fragment: true when `categoryCol` (a comma-separated category string
 * column/expression, or a single category) includes `mat_drikke` among its
 * values — the SQL counterpart of categoryIncludesMatDrikke(). Review
 * finding (2026-09-18, independent review of this PR): the original 6-LIKE-
 * pattern version only tolerated a space AFTER a separating comma, not
 * BEFORE — categoryIncludesMatDrikke() (JS) trims each token regardless of
 * which side the whitespace is on, so a category like "kultur_historie ,
 * mat_drikke" was correctly in-scope for the JS-side check (bulk-load
 * insert decision) but silently missed by this SQL fragment (judge-sweep/
 * org.nr candidate selection) — a starvation edge case where harvest could
 * insert a row this fragment would then never select for judging/
 * enrichment. Fixed by normalizing away a single space on EITHER side of a
 * comma before matching, so both sides agree on the same set of composite
 * forms (still only a single adjacent space, same proportionate scope as
 * the original — not a fully general whitespace-arbitrary regex, matching
 * categoryIncludesMatDrikke()'s trim() only up to that same single-space-
 * in-practice case this file has ever needed). Never string-interpolates
 * caller input, only ever called with a fixed column/expression name. */
export function matDrikkeCategorySql(categoryCol: string): string {
  const raw = `trim(COALESCE(${categoryCol}, ''))`;
  const normalized = `lower(replace(replace(${raw}, ' ,', ','), ', ', ','))`;
  return (
    `(${normalized} = '${MAT_DRIKKE}'` +
    ` OR ${normalized} LIKE '${MAT_DRIKKE},%'` +
    ` OR ${normalized} LIKE '%,${MAT_DRIKKE}'` +
    ` OR ${normalized} LIKE '%,${MAT_DRIKKE},%')`
  );
}

/** SQL fragment: true when the provider row referenced by `providerIdCol` (a
 * FK expression pointing at experience_providers.id — e.g. "e.provider_id")
 * is in the gårdssalg cohort. Mirrors GARDSSALG_COHORT_PREDICATE_SQL's logic
 * (aliased, via an EXISTS subquery so callers never need their own JOIN) —
 * `IS` rather than `=` for the same NULL-safety reason documented on that
 * constant; harmless here (already inside EXISTS, which never propagates a
 * NULL row-check outward) but keeps every cohort-check callers reuses
 * byte-consistent rather than one being negation-safe and one not. */
export function providerCohortExistsSql(providerIdCol: string, alias = "gp_scope"): string {
  return (
    `EXISTS (SELECT 1 FROM experience_providers ${alias} WHERE ${alias}.id = ${providerIdCol} ` +
    `AND (${alias}.producer_type IS NOT NULL OR ${alias}.rfb_seed_source IS 'rfb-seed'))`
  );
}

/** SQL fragment: true when the EXPERIENCE row (its own `categoryCol` and the
 * FK `providerIdCol` it carries) is in scope — provider in the gårdssalg
 * cohort OR the row's own category includes mat_drikke. For call sites that
 * SELECT from `experiences` (optionally already JOINed to
 * experience_providers — this fragment doesn't require that join, it uses
 * its own EXISTS subquery either way). */
export function experienceInScopeSql(categoryCol: string, providerIdCol: string): string {
  return `(${providerCohortExistsSql(providerIdCol)} OR ${matDrikkeCategorySql(categoryCol)})`;
}

/** SQL fragment: true when the PROVIDER itself (row from
 * experience_providers, `idCol` its own primary key expression — "id" when
 * unaliased) is in scope — either the provider is in the gårdssalg cohort
 * itself, OR it has at least one associated `experiences` row whose category
 * includes mat_drikke. For call sites that SELECT experience_providers rows
 * directly with no specific experience row in hand (the two org.nr
 * enrichment services below). */
export function providerInScopeSql(idCol = "id"): string {
  return (
    `(${GARDSSALG_COHORT_PREDICATE_SQL} OR EXISTS (` +
    `SELECT 1 FROM experiences e_scope WHERE e_scope.provider_id = ${idCol} ` +
    `AND ${matDrikkeCategorySql("e_scope.category")}))`
  );
}
