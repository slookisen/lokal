// ─── GET /admin/dod-bulk ─────────────────────────────────────────────────────
//
// scripts/dod-scorecard.py (A2A repo) is a READ-ONLY build-quality scorecard
// that has carried a `provenance + per-agent verification_status:
// **MEASUREMENT-PENDING**` placeholder for ~2 months (see that script's own
// docstring, v2 2026-06-20): no bulk/admin endpoint exposed
// `field_provenance` / `verification_status` per-agent, so the script could
// only estimate 5 of the 8 DoD checks (identity/location/contact/website/
// richness) off a small random per-agent sample, never the full 8-check
// `build_complete` (adds opening_hours, verified, provenance-completeness).
//
// This route closes that gap: READ-ONLY, paginated, one batch call returns
// per-agent `verification_status` + the raw signals AND pre-computed booleans
// for all 8 DoD checks, over the SAME producer population dod-scorecard.py /
// scripts/v3-b0-quality-harness.py already use (`role='producer' AND
// umbrella_type IS NULL`). It writes nothing and calls no external network.
//
// NOT this route's job: wiring dod-scorecard.py to actually call this
// endpoint instead of sampling — that is a separate follow-up slice.
//
// Auth: X-Admin-Key (same local requireAdmin convention as every other admin
// route file in this codebase — deliberately re-defined locally, none share
// it via import; see admin-homepage-provenance-cohort.ts / admin-pool-
// blocker-explain.ts).
//
// ── The 8 DoD checks, and where each number comes from (judgment calls) ──
//
//   1. identity            — agents.name (always present, NOT NULL) AND
//                             agents.categories parses to a non-empty array.
//   2. location             — agents.lat AND agents.lng both non-null. This
//                             mirrors marketplace-registry.ts's own
//                             `rowToAgent()` — the public `/api/marketplace/
//                             agents` "location" field is only emitted when
//                             BOTH lat and lng are set (a bare `city` string
//                             is not treated as "has location" anywhere else
//                             in this codebase — see the 2026-07-26 "28.5% of
//                             producers rendered as Oslo" incident note at
//                             that call site for why no city-only fallback
//                             is used).
//   3. contact              — agent_knowledge.email OR .phone non-empty.
//   4. website               — agent_knowledge.website non-empty. Deliberately
//                             NOT falling back to agents.url (which is
//                             NOT NULL / always present as an A2A-protocol
//                             field and would make this check vacuous) —
//                             matches dod-scorecard.py's own definition
//                             (`k.get("website")` off the admin knowledge
//                             payload, no agents.url fallback).
//   5. richness              — about is real long-form text (>=120 chars,
//                             trimmed, and not a short nav/menu fragment) OR
//                             products parses to a non-empty array. Ported
//                             verbatim from dod-scorecard.py's `rich_text()`
//                             for consistency with the number the script has
//                             been reporting.
//   6. opening_hours         — agent_knowledge.opening_hours parses to a
//                             non-empty array.
//   7. verified              — agent_knowledge.verification_status ===
//                             'verified' (the real DATA-verification gate,
//                             not the owner-claim `agents.is_verified`
//                             artifact — same fix dod-scorecard.py v2 made).
//   8. provenance_complete   — field_provenance has at least one field with
//                             >=2 well-formed, NON-inference source records
//                             (source_type + value both present). Reuses
//                             `isInferenceSource` from cross-source-
//                             validator.ts (the SAME deny-list the pool-
//                             eligibility gate uses) rather than
//                             re-inventing it, so "has provenance" here means
//                             the same thing it means everywhere else in this
//                             codebase — an AI/heuristic guess does not count
//                             as a source. This is deliberately looser than
//                             `crossSourceAgreement()`'s Tier-A/B/S gate (any
//                             field qualifying, not just address/phone/
//                             business_status) since field_provenance is a
//                             free-form `Record<string, ProvenanceRecord[]>`
//                             keyed by whatever field the enrichment SKILL
//                             wrote (about/products/address/phone/... — see
//                             admin-knowledge.ts's header comment), and the
//                             DoD check is about provenance existing at all,
//                             not about any one specific field's agreement.
//
// `build_complete` = all 8 above true.
//
// A caller that disagrees with any of these calls can ignore `checks` /
// `build_complete` entirely and recompute from the raw fields (`city`, `lat`,
// `lng`, `website`, `email`, `phone`, `about_length`, `categories_count`,
// `products_count`, `opening_hours_count`, `field_provenance`,
// `field_source_counts`) returned alongside them.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { isInferenceSource } from "../services/cross-source-validator";

const router = Router();

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

export const DOD_BULK_DEFAULT_LIMIT = 100;
export const DOD_BULK_MAX_LIMIT = 1000;

// ─── Helpers (pure, exported for unit-testing) ───────────────────────────────

export function parseJsonArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseFieldProvenance(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// Coerce one field's provenance entry to a record array. Mirrors
// admin-knowledge.ts's extractSources()/mergeFieldProvenance() handling of
// the same on-disk shapes: a plain array, a wrapped `{ sources: [...] }`, or
// a legacy pre-WO-16 single-record object.
function toRecordArray(entry: unknown): Array<{ value?: unknown; source_type?: unknown }> {
  if (Array.isArray(entry)) return entry as Array<{ value?: unknown; source_type?: unknown }>;
  if (entry && typeof entry === "object" && Array.isArray((entry as { sources?: unknown }).sources)) {
    return (entry as { sources: Array<{ value?: unknown; source_type?: unknown }> }).sources;
  }
  if (entry && typeof entry === "object") return [entry as { value?: unknown; source_type?: unknown }];
  return [];
}

// Real (non-inference) evidence count for one field's provenance array —
// "well-formed" means both value and source_type are non-empty strings;
// inference source_types (category_inference / web_search / ...) are
// excluded, matching cross-source-validator.ts's own `source_count`.
export function realSourceCount(entry: unknown): number {
  let n = 0;
  for (const r of toRecordArray(entry)) {
    const value = r?.value;
    const sourceType = r?.source_type;
    if (typeof value !== "string" || value.trim() === "") continue;
    if (typeof sourceType !== "string" || sourceType.trim() === "") continue;
    if (isInferenceSource(sourceType)) continue;
    n++;
  }
  return n;
}

export function fieldSourceCounts(fieldProvenance: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [field, entry] of Object.entries(fieldProvenance)) {
    const n = realSourceCount(entry);
    if (n > 0) out[field] = n;
  }
  return out;
}

// Ported verbatim (same regex, same 120-char / 400-char thresholds) from
// A2A/scripts/dod-scorecard.py's `rich_text()` so this endpoint's `richness`
// check matches what the script has been reporting.
const NAV_JUNK_RE = /(skip to content|^\s*meny\b|forside.*kontakt oss)/i;

export function isRichAbout(about: string | null | undefined): boolean {
  if (!about) return false;
  const t = String(about).trim();
  if (t.length < 120) return false;
  if (NAV_JUNK_RE.test(t) && t.length < 400) return false;
  return true;
}

router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const limitRaw = req.query.limit;
  const offsetRaw = req.query.offset;
  const limit = Math.min(
    Math.max(1, parseInt(String(limitRaw ?? DOD_BULK_DEFAULT_LIMIT), 10) || DOD_BULK_DEFAULT_LIMIT),
    DOD_BULK_MAX_LIMIT
  );
  const offset = Math.max(0, parseInt(String(offsetRaw ?? "0"), 10) || 0);

  // Optional vertical filter — not required by the acceptance criteria, but
  // natural given other admin routes in this file family accept it (see
  // admin-agents.ts's vertical_id handling). Any string is accepted as-is
  // (parameterized) — an unknown vertical simply yields an empty page rather
  // than a 400, matching this endpoint's read-only, no-validation-needed
  // posture.
  const verticalFilter = typeof req.query.vertical === "string" && req.query.vertical.trim()
    ? req.query.vertical.trim()
    : null;

  const db = getDb();

  // Population = producers, excluding umbrella agents — the SAME predicate
  // A2A/scripts/dod-scorecard.py (`x.get("role")=="producer" and not
  // x.get("umbrella_type")`) and scripts/v3-b0-quality-harness.py's pool
  // sources ultimately rest on. Defined on `agents` alone (not joined to
  // agent_knowledge) because not every producer has an agent_knowledge row
  // yet (it is created lazily by enrichment/registration, not at agent
  // creation) — LEFT JOIN below so those rows still appear, with
  // verification_status defaulting to 'unverified' and no provenance.
  const whereClause = `
     FROM agents a
    WHERE a.role = 'producer'
      AND a.umbrella_type IS NULL
      ${verticalFilter ? "AND a.vertical_id = ?" : ""}
  `;
  const whereParams: unknown[] = verticalFilter ? [verticalFilter] : [];

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS total ${whereClause}`)
    .get(...whereParams) as { total: number };

  // Same population predicate as whereClause above, but with the LEFT JOIN
  // to agent_knowledge spliced in between FROM and WHERE (the count query
  // above doesn't need it — the population is defined on `agents` alone —
  // but the page query does, to pull k.* columns for every row).
  const pageWhereClause = whereClause.replace(
    "FROM agents a",
    "FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id"
  );

  const rows = db
    .prepare(
      `SELECT
         a.id AS agent_id,
         a.name AS name,
         a.vertical_id AS vertical_id,
         a.city AS city,
         a.lat AS lat,
         a.lng AS lng,
         a.categories AS categories,
         k.website AS website,
         k.email AS email,
         k.phone AS phone,
         k.about AS about,
         k.products AS products,
         k.opening_hours AS opening_hours,
         k.verification_status AS verification_status,
         k.field_provenance AS field_provenance
       ${pageWhereClause}
       ORDER BY a.id ASC
       LIMIT ? OFFSET ?`
    )
    .all(...whereParams, limit, offset) as Array<{
      agent_id: string;
      name: string;
      vertical_id: string | null;
      city: string | null;
      lat: number | null;
      lng: number | null;
      categories: string | null;
      website: string | null;
      email: string | null;
      phone: string | null;
      about: string | null;
      products: string | null;
      opening_hours: string | null;
      verification_status: string | null;
      field_provenance: string | null;
    }>;

  const agents = rows.map((row) => {
    const categories = parseJsonArray(row.categories);
    const products = parseJsonArray(row.products);
    const openingHours = parseJsonArray(row.opening_hours);
    const fieldProvenance = parseFieldProvenance(row.field_provenance);
    const sourceCounts = fieldSourceCounts(fieldProvenance);
    const verificationStatus = row.verification_status ?? "unverified";

    const hasIdentity = !!(row.name && row.name.trim() && categories.length > 0);
    const hasLocation = row.lat != null && row.lng != null;
    const hasContact = !!(row.email && row.email.trim()) || !!(row.phone && row.phone.trim());
    const hasWebsite = !!(row.website && row.website.trim());
    const hasRichness = isRichAbout(row.about) || products.length > 0;
    const hasOpeningHours = openingHours.length > 0;
    const isVerified = verificationStatus === "verified";
    const provenanceComplete = Object.values(sourceCounts).some((n) => n >= 2);

    const checks = {
      identity: hasIdentity,
      location: hasLocation,
      contact: hasContact,
      website: hasWebsite,
      richness: hasRichness,
      opening_hours: hasOpeningHours,
      verified: isVerified,
      provenance_complete: provenanceComplete,
    };

    return {
      agent_id: row.agent_id,
      name: row.name,
      vertical_id: row.vertical_id,
      verification_status: verificationStatus,
      city: row.city,
      lat: row.lat,
      lng: row.lng,
      website: row.website,
      email: row.email,
      phone: row.phone,
      about_length: row.about ? row.about.trim().length : 0,
      categories_count: categories.length,
      products_count: products.length,
      opening_hours_count: openingHours.length,
      field_provenance: fieldProvenance,
      field_source_counts: sourceCounts,
      checks,
      build_complete: Object.values(checks).every(Boolean),
    };
  });

  res.json({
    total: totalRow.total,
    limit,
    offset,
    returned: agents.length,
    vertical: verticalFilter,
    agents,
  });
});

export default router;
