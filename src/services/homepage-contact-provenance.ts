// ─── Homepage contact-provenance predicate (shared) ──────────────────────────
//
// dev-request 2026-10-28-rfb-uttrekk-adresse-og-hjemmeside-forverring, AC4
// (skive C1). POST /admin/homepage-provenance-batch's default auto-select
// (routes/marketplace.ts) used to skip any profile whose field_provenance
// contained the string "homepage" anywhere. But several writers tag
// NON-contact fields with a `source_type: "homepage"` record:
//   - applyRfbAgentWebsite (routes/admin-rfb-website-discovery.ts) writes one
//     on `website` when a discovered website is applied;
//   - the judged thin-profile text writer in routes/admin-agents.ts
//     (tynne_profiler slice 2) writes them on `about` / `description`;
//   - dental writers put them on `helfo_agreement` / `acute_vakt`.
// (`website_homepage`, used by routes/admin-knowledge.ts, is a different
// source_type and never matched — neither by the old LIKE nor by this rule.)
// Only the contact extraction in homepage-provenance-batch itself (and the
// one-off PR-23/PR-25 backfills in database/init.ts) writes them on
// `address`, `phone` and `email` — the three fields the batch extracts. So a
// profile that only just got a website (or an about text) from its homepage
// was excluded from contact extraction forever. The rule now is: the batch's
// auto-select skips a profile only when the homepage has ALREADY been used
// for a contact field, i.e. one of address/phone/email carries a homepage
// source.
//
// On-disk shape of agent_knowledge.field_provenance (TEXT JSON, written via
// mergeFieldProvenance in routes/admin-knowledge.ts): `{ field: [record, …] }`
// with records `{ value, source_type, fetched_at, source_url? }`. Legacy rows
// may still hold `{ field: { sources: [ … ] } }` or a single bare record, and
// old records may use `source` instead of `source_type`; matching the JSON
// text of the field's value catches every one of these shapes.
//
// NULL, '{}', a non-object and malformed JSON all count as "no homepage
// contact source" (the profile stays selectable, as before) — json_valid()
// guards json_extract() so invalid JSON never throws.

export const HOMEPAGE_CONTACT_PROVENANCE_FIELDS = ["address", "phone", "email"] as const;

const HOMEPAGE_SOURCE_MARKERS = ['"source_type":"homepage"', '"source":"homepage"'] as const;

/**
 * SQL boolean expression: true when `<alias>.field_provenance` has a homepage
 * source on address, phone or email. Always 0/1, never NULL, never throws.
 * WHERE-clause use: `AND NOT ${homepageContactProvenanceSql("k")}`.
 */
export function homepageContactProvenanceSql(alias = "k"): string {
  const col = `${alias}.field_provenance`;
  const legs = HOMEPAGE_CONTACT_PROVENANCE_FIELDS.flatMap((f) =>
    HOMEPAGE_SOURCE_MARKERS.map(
      (m) => `COALESCE(json_extract(${col},'$.${f}'),'') LIKE '%${m}%'`,
    ),
  );
  return `(CASE WHEN json_valid(${col}) THEN (${legs.join(" OR ")}) ELSE 0 END)`;
}

/** The default auto-select's provenance exclusion, ready for a WHERE clause. */
export const HOMEPAGE_CONTACT_PROVENANCE_EXCLUSION_SQL = `AND NOT ${homepageContactProvenanceSql("k")}`;

/**
 * JS mirror of homepageContactProvenanceSql for diagnosis routes
 * (admin-pool-blocker-explain). Same result for every stored value:
 * JSON.stringify of the parsed field is the same compact text json_extract
 * returns.
 */
export function hasHomepageContactProvenance(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  for (const f of HOMEPAGE_CONTACT_PROVENANCE_FIELDS) {
    const val = (parsed as Record<string, unknown>)[f];
    if (val === undefined || val === null) continue;
    const text = typeof val === "string" ? val : JSON.stringify(val);
    if (HOMEPAGE_SOURCE_MARKERS.some((m) => text.includes(m))) return true;
  }
  return false;
}
