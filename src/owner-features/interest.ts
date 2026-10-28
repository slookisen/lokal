// ─── «Mine valg» — «Gi meg beskjed» on planned entries (S2e) ────────────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, slice S2e (v2 principle 2).
// A `coming_soon` registry entry is not a switch on the page; it sits in the
// closed «Planlagt — si fra hvis du vil ha dette (N)» box, and «Gi meg
// beskjed» stores ONE interest row per (vertical, subject, key) with its time
// (owner_feature_interest, database/init.ts). The row has no effect on any
// surface, changes no setting and sends nothing. Admins read the counts per
// key (routes/admin-owner-features-interest.ts) to decide what to build after
// the pilot.

import { getDb } from "../database/init";
import { OWNER_FEATURE_REGISTRY, findOwnerFeature, type OwnerFeatureEntry, type OwnerFeatureVertical } from "./registry";

export type RecordInterestResult =
  | { kind: "ok"; created: boolean }
  /** Unknown key, or a key that is not `coming_soon` (a built entry has its own control). */
  | { kind: "not_planned" };

/** Stores the owner's interest once (idempotent). Writes nothing else. */
export function recordOwnerFeatureInterest(
  vertical: OwnerFeatureVertical,
  subjectId: string,
  key: string,
  actorDetail: string | null,
  opts: { db?: any; registry?: OwnerFeatureEntry[]; now?: Date } = {},
): RecordInterestResult {
  const e = findOwnerFeature(key, opts.registry ?? OWNER_FEATURE_REGISTRY);
  if (!e || e.status !== "coming_soon") return { kind: "not_planned" };
  const db = opts.db ?? getDb();
  const info = db
    .prepare(
      `INSERT INTO owner_feature_interest (vertical, subject_id, key, registered_at, actor_detail)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(vertical, subject_id, key) DO NOTHING`,
    )
    .run(vertical, subjectId, e.key, (opts.now ?? new Date()).toISOString(), actorDetail ?? null);
  return { kind: "ok", created: info.changes > 0 };
}

/** The keys this subject has asked to hear about. */
export function readOwnerFeatureInterest(vertical: string, subjectId: string, db: any = getDb()): Set<string> {
  try {
    const rows = db
      .prepare(`SELECT key FROM owner_feature_interest WHERE vertical = ? AND subject_id = ?`)
      .all(vertical, subjectId) as Array<{ key: string }>;
    return new Set(rows.map((r) => r.key));
  } catch {
    return new Set();
  }
}

export interface OwnerFeatureInterestCount {
  key: string;
  status: string;
  label_no: string;
  count: number;
  first_at: string | null;
  last_at: string | null;
}

/**
 * Interest per registry key for one vertical, registry order. Every
 * `coming_soon` key is listed (count 0 when nobody asked); a key that has
 * rows but is no longer planned (built since, or removed) is kept so no
 * signal is lost. Counts only — no subject ids, no addresses.
 */
export function ownerFeatureInterestCounts(
  vertical: string,
  opts: { db?: any; registry?: OwnerFeatureEntry[] } = {},
): OwnerFeatureInterestCount[] {
  const db = opts.db ?? getDb();
  const registry = opts.registry ?? OWNER_FEATURE_REGISTRY;
  const rows = db
    .prepare(
      `SELECT key, COUNT(*) AS n, MIN(registered_at) AS first_at, MAX(registered_at) AS last_at
         FROM owner_feature_interest WHERE vertical = ? GROUP BY key`,
    )
    .all(vertical) as Array<{ key: string; n: number; first_at: string | null; last_at: string | null }>;
  const byKey = new Map(rows.map((r) => [r.key, r] as const));
  const out: OwnerFeatureInterestCount[] = [];
  for (const e of registry) {
    const r = byKey.get(e.key);
    if (e.status !== "coming_soon" && !r) continue;
    out.push({ key: e.key, status: e.status, label_no: e.label.no, count: Number(r?.n) || 0, first_at: r?.first_at ?? null, last_at: r?.last_at ?? null });
    byKey.delete(e.key);
  }
  for (const r of byKey.values()) {
    out.push({ key: r.key, status: "unknown", label_no: r.key, count: Number(r.n) || 0, first_at: r.first_at, last_at: r.last_at });
  }
  return out;
}
