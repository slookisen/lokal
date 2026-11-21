/**
 * recently-enriched-sample.ts — shared helpers for the `include_stored=1`
 * top-up on the three verifier spot-check sample endpoints:
 *   GET /api/marketplace/admin/agents/recently-enriched   (marketplace.ts)
 *   GET /api/tannlege/admin/agents/recently-enriched      (dental.ts)
 *   GET /api/opplevelser/admin/providers/recently-enriched (opplevelser.ts)
 *
 * Why: the endpoints only return rows enriched inside the `since` window. While
 * a vertical's enrichment writes are paused the window is empty, the weekly
 * spot-check records `insufficient_sample`, and the pause blinds its own
 * follow-up measurement. With `include_stored=1` the sample is topped up with
 * random rows of content already stored in the DB (enriched at some point,
 * outside the window), each row marked with `sample_source`.
 *
 * Read-only. Default (param absent / any value other than the literal "1")
 * leaves every endpoint's response byte-identical to before.
 */

export type SampleSource = "recent" | "stored";

/** Only the literal value "1" enables the top-up (same rule as with_fields). */
export function wantsStoredTopUp(param: unknown): boolean {
  return param === "1";
}

/**
 * `AND <column> NOT IN (?, ?, …)` with one bound parameter per id, or an empty
 * clause when there is nothing to exclude. `column` is always a hard-coded
 * identifier from the caller, never request input.
 */
export function notInClause(column: string, ids: string[]): { sql: string; params: string[] } {
  if (ids.length === 0) return { sql: "", params: [] };
  return { sql: `AND ${column} NOT IN (${ids.map(() => "?").join(", ")})`, params: ids };
}

/**
 * Recent rows first, then stored rows not already present (by id), capped at
 * `limit`. Every row gets a `sample_source` marker; counts are returned for the
 * top-level `sample_source_counts`.
 */
export function mergeSample<T extends { id: string }>(
  recent: T[],
  stored: T[],
  limit: number,
): { rows: Array<T & { sample_source: SampleSource }>; counts: { recent: number; stored: number } } {
  const seen = new Set<string>();
  const rows: Array<T & { sample_source: SampleSource }> = [];
  for (const r of recent) {
    if (rows.length >= limit) break;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    rows.push({ ...r, sample_source: "recent" });
  }
  const recentCount = rows.length;
  for (const r of stored) {
    if (rows.length >= limit) break;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    rows.push({ ...r, sample_source: "stored" });
  }
  return { rows, counts: { recent: recentCount, stored: rows.length - recentCount } };
}
