// ─── Admin: GET /admin/agents/duplicate-slugs (READ-ONLY) ───────────────────
//
// Detects — and ONLY detects — slug collisions among ACTIVE `agents` rows.
//
// Why this exists: POST /admin/agents/duplicate-merge is deployed and works,
// but it NEVER detects duplicates itself by design — it only executes an
// explicit {survivor_id, duplicate_id} decision someone else already made.
// Nothing on the platform produced that "someone else". The defect is live:
// sitemap.xml currently emits 4114 <loc> entries for 4092 unique URLs — 11
// producer slugs appear twice, i.e. two different active `agents` rows
// slugify to the same /produsent/<slug> URL. Which of the two rows the
// public route actually serves is decided by an UNORDERED table scan inside
// marketplace-registry.getAgentBySlugIncludingUmbrellas() — see
// `served_selection` below.
//
// This endpoint answers "which slugs collide, and which row of each pair is
// the better survivor" with data, so a human (or a follow-up routine) can
// feed a decision into the existing merge lever.
//
// ── STRICTLY READ-ONLY ──────────────────────────────────────────────────
// There is not a single write in this file. No merge, no is_active /
// merged_into flip, no agent_knowledge update, no agent_knowledge_audit row.
// One SELECT, all grouping/ranking in JS. `suggested_survivor_id` is
// ADVISORY output — nothing here acts on it.
//
// Explicit non-goals (each one deliberately NOT built here):
//   * No dedup of the sitemap output — the dev-request's acceptance criteria
//     forbid papering over the collision in seo.ts; the duplicate rows must
//     stay visible until they are actually merged.
//   * No automatic merge execution.
//   * No change to getAgentBySlugIncludingUmbrellas() — the scan-order
//     instability is REPORTED here (`served_selection`), not silently fixed.
//   * No change to 404 / robots / canonical signalling.
//
// Auth follows the same convention as admin-db-table-sizes.ts /
// admin-agents-duplicate-merge.ts: X-Admin-Key header, checked against
// ADMIN_KEY (falling back to ANALYTICS_ADMIN_KEY). `adminLimiter` is applied
// at the mount site in src/index.ts.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { slugify } from "../utils/slug";
import { isBlank } from "./admin-agents-duplicate-merge";

const router = Router();

// ── Injectable DB seam (tests only) ─────────────────────────────────────────
// Same seam convention as __setDuplicateMergeDbForTesting in
// admin-agents-duplicate-merge.ts — tests point this route at their own
// in-memory DB instead of pinning the shared getDb() singleton. Production
// code never calls the setter.
let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;

/** Test-only. Pass null to clear. Never called by production code. */
export function __setDuplicateSlugsDbForTesting(db: ReturnType<typeof getDb> | null): void {
  dbOverrideForTesting = db;
}

function resolveDb(): ReturnType<typeof getDb> {
  return dbOverrideForTesting ?? getDb();
}

function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

function requireAdmin(req: Request, res: Response): boolean {
  const expected = getAdminKey();
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (provided !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

/**
 * The scalar fields whose non-blankness counts as "enrichment depth".
 * `contact_email` lives on `agents`; the other six live on `agent_knowledge`
 * — exactly the set admin-agents-duplicate-merge.ts fill-only merges
 * (contact_email + KNOWLEDGE_MERGE_FIELDS), so "depth" here means the same
 * thing the merge lever would actually be able to carry over.
 */
export const DEPTH_FIELDS = [
  "contact_email",
  "address",
  "postal_code",
  "website",
  "phone",
  "email",
  "about",
] as const;

/**
 * Own keys of the `agent_knowledge.curated_fields` JSON object, sorted.
 * Advisory only — this is a deliberate SUPERSET: keys with falsy values are
 * listed too, because different write levers disagree on whether a falsy
 * value still counts as a lock (duplicate-merge's isFieldCurated vs
 * deactivate's hasAnyCuratedField). Over-reporting a possible lock is the
 * safe direction for a read-only advisory. Malformed / NULL / non-object
 * JSON yields [] rather than throwing.
 */
export function curatedLockedFields(curatedFieldsJson: string | null | undefined): string[] {
  if (!curatedFieldsJson) return [];
  try {
    const parsed = JSON.parse(curatedFieldsJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.keys(parsed as Record<string, unknown>).sort();
  } catch {
    return [];
  }
}

// ── Raw row shape (aliased exactly like readAgentSnapshot's SELECT) ─────────
interface RawRow {
  a_id: string;
  a_name: string;
  a_is_vetted: number | null;
  a_umbrella_type: string | null;
  a_vertical_id: string | null;
  a_role: string | null;
  a_trust_score: number | null;
  a_created_at: string | null;
  a_claimed_at: string | null;
  a_claimed_by_user_id: string | null;
  a_contact_email: string | null;
  a_merged_into: string | null;
  k_agent_id: string | null;
  k_address: string | null;
  k_postal_code: string | null;
  k_website: string | null;
  k_phone: string | null;
  k_email: string | null;
  k_about: string | null;
  k_enrichment_status: string | null;
  k_updated_at: string | null;
  k_curated_fields: string | null;
}

export interface DuplicateSlugRow {
  id: string;
  name: string;
  created_at: string | null;
  claimed: boolean;
  has_knowledge_row: boolean;
  enrichment_status: string | null;
  filled_fields: number;
  enrichment_depth: number;
  curated_locked_fields: string[];
  // Context a human needs to pick a survivor without a second query.
  is_vetted: boolean;
  umbrella_type: string | null;
  vertical_id: string | null;
  role: string | null;
  trust_score: number | null;
  merged_into: string | null;
  knowledge_updated_at: string | null;
  // True iff this row is one the sitemap generator would emit a
  // /produsent/<slug> entry for (getActiveAgents(): active + not umbrella +
  // vetted). See sitemapAffected below.
  in_sitemap_cohort: boolean;
}

export interface DuplicateSlugGroup {
  slug: string;
  row_count: number;
  sitemap_affected: boolean;
  currently_served_id: string | null;
  served_selection: "scan_order_dependent";
  suggested_survivor_id: string | null;
  tie: boolean;
  rows: DuplicateSlugRow[];
}

/**
 * LEFT JOIN, not INNER — same reasoning as readAgentSnapshot in
 * admin-agents-duplicate-merge.ts: an agent may legitimately have no
 * `agent_knowledge` row at all, and an INNER JOIN would silently hide
 * exactly the thin/skeleton rows that are the most likely duplicates.
 * `k_agent_id IS NULL` is the join-miss signal used for has_knowledge_row.
 *
 * `agent_knowledge.agent_id` is that table's PRIMARY KEY, so the join can
 * never fan a single agent out into multiple rows.
 *
 * No ORDER BY: the row order is deliberately the table's own scan order,
 * because that is what getAgentBySlugIncludingUmbrellas() sees (see
 * currentlyServedId below).
 */
function readActiveRows(db: ReturnType<typeof getDb>): RawRow[] {
  return db
    .prepare(
      `SELECT a.id AS a_id, a.name AS a_name, a.is_vetted AS a_is_vetted,
              a.umbrella_type AS a_umbrella_type, a.vertical_id AS a_vertical_id,
              a.role AS a_role, a.trust_score AS a_trust_score,
              a.created_at AS a_created_at, a.claimed_at AS a_claimed_at,
              a.claimed_by_user_id AS a_claimed_by_user_id,
              a.contact_email AS a_contact_email, a.merged_into AS a_merged_into,
              k.agent_id AS k_agent_id, k.address AS k_address, k.postal_code AS k_postal_code,
              k.website AS k_website, k.phone AS k_phone, k.email AS k_email, k.about AS k_about,
              k.enrichment_status AS k_enrichment_status, k.updated_at AS k_updated_at,
              k.curated_fields AS k_curated_fields
         FROM agents a
         LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE a.is_active = 1`,
    )
    .all() as RawRow[];
}

/** Count of non-blank DEPTH_FIELDS. '' and NULL both count as blank (isBlank). */
export function countFilledFields(row: RawRow): number {
  const values: Array<string | null> = [
    row.a_contact_email,
    row.k_address,
    row.k_postal_code,
    row.k_website,
    row.k_phone,
    row.k_email,
    row.k_about,
  ];
  return values.reduce<number>((n, v) => (isBlank(v) ? n : n + 1), 0);
}

function toRow(raw: RawRow): DuplicateSlugRow {
  const hasKnowledgeRow = raw.k_agent_id !== null;
  const filled = countFilledFields(raw);
  return {
    id: raw.a_id,
    name: raw.a_name,
    created_at: raw.a_created_at,
    // Same claimed truthiness convention as duplicate-merge / deactivate:
    // a non-null claimed_at is the row-level lock signal.
    claimed: raw.a_claimed_at !== null && raw.a_claimed_at !== undefined,
    has_knowledge_row: hasKnowledgeRow,
    enrichment_status: raw.k_enrichment_status,
    filled_fields: filled,
    // Having a knowledge row at all is worth one point on its own: it is the
    // difference between "enrichable" and "skeleton import".
    enrichment_depth: filled + (hasKnowledgeRow ? 1 : 0),
    curated_locked_fields: curatedLockedFields(raw.k_curated_fields),
    // agents.is_vetted is INTEGER NOT NULL DEFAULT 1 — 0 is false, anything
    // else (including NULL, defensively) is vetted, mirroring the is_active
    // convention in readAgentSnapshot.
    is_vetted: raw.a_is_vetted !== 0,
    umbrella_type: raw.a_umbrella_type,
    vertical_id: raw.a_vertical_id,
    role: raw.a_role,
    trust_score: raw.a_trust_score,
    merged_into: raw.a_merged_into,
    knowledge_updated_at: raw.k_updated_at,
    in_sitemap_cohort: raw.a_umbrella_type === null && raw.a_is_vetted !== 0,
  };
}

/**
 * created_at sort key. NULL sorts LAST (i.e. counts as newest, therefore
 * least preferred as survivor) — "￿" is above every ISO/SQLite
 * timestamp string. Never leaves the ranking comparison.
 */
function createdKey(row: DuplicateSlugRow): string {
  return row.created_at ?? "￿";
}

/**
 * Deterministic survivor ranking, strictly in this order:
 *   1. claimed (an owner-claimed row always outranks an unclaimed one)
 *   2. has_knowledge_row
 *   3. higher enrichment_depth
 *   4. older created_at
 * Returns < 0 when `a` should rank ahead of `b`.
 */
export function compareSurvivorCandidates(a: DuplicateSlugRow, b: DuplicateSlugRow): number {
  if (a.claimed !== b.claimed) return a.claimed ? -1 : 1;
  if (a.has_knowledge_row !== b.has_knowledge_row) return a.has_knowledge_row ? -1 : 1;
  if (a.enrichment_depth !== b.enrichment_depth) return b.enrichment_depth - a.enrichment_depth;
  const ka = createdKey(a);
  const kb = createdKey(b);
  if (ka !== kb) return ka < kb ? -1 : 1;
  return 0;
}

/**
 * Advisory survivor pick. If the top TWO candidates are indistinguishable on
 * all four ranking criteria there is no defensible winner, so this returns a
 * tie instead of flipping a coin on which producer profile survives.
 */
export function suggestSurvivor(rows: DuplicateSlugRow[]): { id: string | null; tie: boolean } {
  const ranked = [...rows].sort(compareSurvivorCandidates);
  if (ranked.length === 0) return { id: null, tie: false };
  if (ranked.length >= 2 && compareSurvivorCandidates(ranked[0], ranked[1]) === 0) {
    return { id: null, tie: true };
  }
  return { id: ranked[0].id, tie: false };
}

router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  try {
    const db = resolveDb();
    const raws = readActiveRows(db);

    // Grouping happens in JS, NOT in SQL: slugify() transliterates æ/ø/å and
    // collapses punctuation, and SQLite cannot reproduce that — a
    // GROUP BY lower(name) would both miss real collisions ("Ápal sideri!"
    // vs "Apal Sideri") and invent fake ones.
    const groups = new Map<string, RawRow[]>();
    for (const raw of raws) {
      const slug = slugify(raw.a_name ?? "");
      if (!slug) continue; // un-sluggable name has no /produsent/<slug> URL to collide on
      const bucket = groups.get(slug);
      if (bucket) bucket.push(raw);
      else groups.set(slug, [raw]);
    }

    // Exactly the extraction + find that
    // marketplace-registry.getAgentBySlugIncludingUmbrellas() performs:
    // all active rows, unordered, first slugify(name).toLowerCase() match
    // wins. slugify() already lowercases, so the extra .toLowerCase() is
    // carried over verbatim rather than "cleaned up". This is scan-order
    // dependent — hence served_selection below; the point of reporting it is
    // to make the instability visible, not to pretend it is stable.
    const currentlyServedId = (slug: string): string | null => {
      const hit = raws.find((r) => slugify(r.a_name ?? "").toLowerCase() === slug);
      return hit ? hit.a_id : null;
    };

    const out: DuplicateSlugGroup[] = [];
    for (const [slug, bucket] of groups) {
      if (bucket.length < 2) continue;
      const rows = bucket.map(toRow);
      // A collision only breaks the sitemap when at least TWO of the
      // colliding rows are in the cohort the sitemap actually emits —
      // getActiveAgents(): is_active = 1 AND umbrella_type IS NULL AND
      // is_vetted = 1 (src/services/marketplace-registry.ts). An
      // umbrella/unvetted row colliding with one producer is still a real
      // /produsent/<slug> ambiguity (so the group IS reported), but it does
      // not duplicate a <loc>.
      const sitemapAffected = rows.filter((r) => r.in_sitemap_cohort).length >= 2;
      const suggestion = suggestSurvivor(rows);
      out.push({
        slug,
        row_count: rows.length,
        sitemap_affected: sitemapAffected,
        currently_served_id: currentlyServedId(slug),
        served_selection: "scan_order_dependent",
        suggested_survivor_id: suggestion.id,
        tie: suggestion.tie,
        rows,
      });
    }

    out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

    // No pagination: ~1670 active rows in prod, and the collision groups are
    // a handful. Paginating a diagnostic this small would only make it
    // harder to reason about the whole picture at once.
    res.json({
      success: true,
      generated_at: new Date().toISOString(),
      total_active_rows: raws.length,
      collision_groups: out.length,
      sitemap_affected_groups: out.filter((g) => g.sitemap_affected).length,
      groups: out,
    });
  } catch (err: any) {
    console.error("[duplicate-slugs] failed:", err);
    res.status(500).json({ error: "duplicate_slugs_failed", detail: err?.message ?? String(err) });
  }
});

export default router;
