// ─── Organic-word daily summary (økologi S3f) ───────────────────────────────
// A2A dev-request 2026-10-28-rfb-okologisk-merking-debio-register-og-
// tekstrevisjon, slice S3f: a read-only count of organic claim words on
// ACTIVE RFB producer profiles, per Debio status, so a daily check can see
// whether unverified producers still carry organic words in stored data.
//
// Fields read (the ones the S0/S3 organic work evaluates):
//   agents.description, agent_knowledge.about          (free text, 1 entry each)
//   agent_knowledge.products                           (1 entry per product: name,
//                                                       note, description or organic:true)
//   agent_knowledge.specialties / certifications,
//   agents.tags / categories                           (1 entry per list element)
// The detector is organic-claims.ts containsOrganicClaim — no new word list.
// «Valid status» is description-quality.ts hasValidDebioStatus
// (agents.debio_verified). Status comes from agent_debio_status.debio_status
// («ukjent» when the agent has no row).
//
// READ ONLY: SELECT statements only; nothing is written.

import type Database from "better-sqlite3";
import { containsOrganicClaim } from "./organic-claims";
import { hasValidDebioStatus } from "./description-quality";

export const ORGANIC_SUMMARY_STATUSES = ["okologisk", "karens", "annet", "ingen", "ukjent"] as const;
export type OrganicSummaryStatus = (typeof ORGANIC_SUMMARY_STATUSES)[number];

/** Max entries in unverified_sample. */
export const ORGANIC_SUMMARY_SAMPLE_CAP = 50;

export interface OrganicStatusBucket {
  profiles_with_hits: number;
  hits: number;
}

export interface OrganicClaimsSummary {
  generated_at: string;
  active_profiles: number;
  by_status: Record<OrganicSummaryStatus, OrganicStatusBucket>;
  unverified_profiles_with_hits: number;
  alert: boolean;
  unverified_sample: Array<{ agent_id: string; name: string; fields: string[] }>;
}

function parseList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function productHasHit(p: unknown): boolean {
  if (typeof p === "string") return containsOrganicClaim(p);
  if (!p || typeof p !== "object" || Array.isArray(p)) return false;
  const o = p as Record<string, unknown>;
  return o.organic === true || containsOrganicClaim(o.name) || containsOrganicClaim(o.note) || containsOrganicClaim(o.description);
}

/** Organic hits per field for one profile row: { field: count } (fields without hits omitted). */
export function organicHitsForProfile(row: {
  description?: unknown; about?: unknown; products?: unknown; specialties?: unknown;
  certifications?: unknown; tags?: unknown; categories?: unknown;
}): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (field: string, n: number) => { if (n > 0) out[field] = n; };
  add("description", containsOrganicClaim(row.description) ? 1 : 0);
  add("about", containsOrganicClaim(row.about) ? 1 : 0);
  add("products", parseList(row.products).filter(productHasHit).length);
  for (const f of ["specialties", "certifications", "tags", "categories"] as const) {
    add(f, parseList(row[f]).filter((e) => containsOrganicClaim(e)).length);
  }
  return out;
}

function normaliseStatus(raw: unknown): OrganicSummaryStatus {
  return raw === "okologisk" || raw === "karens" || raw === "annet" || raw === "ingen" ? raw : "ukjent";
}

/** Read-only summary over active RFB producer profiles. */
export function buildOrganicClaimsSummary(db: Database.Database, now: Date = new Date()): OrganicClaimsSummary {
  const rows = db.prepare(`
    SELECT a.id, a.name, a.description, a.tags, a.categories, a.debio_verified,
           k.about, k.products, k.specialties, k.certifications,
           s.debio_status
    FROM agents a
    LEFT JOIN agent_knowledge k ON k.agent_id = a.id
    LEFT JOIN agent_debio_status s ON s.agent_id = a.id
    WHERE a.is_active = ?
      AND COALESCE(a.vertical_id, 'rfb') = ?
      AND (a.umbrella_type IS NULL OR a.umbrella_type = '')
      AND (a.role IS NULL OR a.role = ?)
    ORDER BY a.id
  `).all(1, "rfb", "producer") as any[];

  const by_status = Object.fromEntries(
    ORGANIC_SUMMARY_STATUSES.map((s) => [s, { profiles_with_hits: 0, hits: 0 }]),
  ) as Record<OrganicSummaryStatus, OrganicStatusBucket>;
  let unverified = 0;
  const sample: OrganicClaimsSummary["unverified_sample"] = [];

  for (const r of rows) {
    const hits = organicHitsForProfile(r);
    const fields = Object.keys(hits);
    if (fields.length === 0) continue;
    const bucket = by_status[normaliseStatus(r.debio_status)];
    bucket.profiles_with_hits++;
    bucket.hits += fields.reduce((n, f) => n + hits[f], 0);
    if (!hasValidDebioStatus(r)) {
      unverified++;
      if (sample.length < ORGANIC_SUMMARY_SAMPLE_CAP) sample.push({ agent_id: r.id, name: r.name, fields });
    }
  }

  return {
    generated_at: now.toISOString(),
    active_profiles: rows.length,
    by_status,
    unverified_profiles_with_hits: unverified,
    alert: unverified > 0,
    unverified_sample: sample,
  };
}
