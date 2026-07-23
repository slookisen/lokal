// ─── Admin: POST /admin/verifier/wrong-entity-retro-sweep ────────────────────
//
// dev-request 2026-07-16-wrong-entity-opprydding-rfb — the "deretter" (then)
// step of the spec: a platform-wide retro-sweep over the WHOLE agent base
// using cheap, mechanical detectors, producing a report of flagged
// candidates (not the per-cohort manual cleanup itself, which slice 1 and
// addendum 2 already did by hand — see enrichment-reports/2026-07-21-* and
// enrichment-reports/2026-07-22-*).
//
// The dev-request's spec section lists four candidate heuristics. This
// endpoint implements the two that are groundable in data already in the DB
// with a low false-positive rate:
//
//   - duplicate_value_clusters: the exact technique that manually caught the
//     addendum-2 REKO-ring finding (72/99 agents sharing an identical planted
//     "Såkrokveien 156, 1923 SØRUM" address, 3 also sharing an identical
//     phone) and the Addendum-2 duplicate-phone signature — generalized:
//     group non-umbrella agents by normalized address / phone / opening_hours
//     value, flag any group of size >= 3 as a candidate wrong-entity/planted-
//     data cluster. A real chain/franchise CAN legitimately share these
//     fields, so this bucket is report-only, never auto-written.
//   - postal_code_mismatches: address contains a confident, unambiguous
//     4-digit Norwegian postal-code token that differs from the stored
//     postal_code column (only when address is NOT a JS-app placeholder and
//     the token position is unambiguous — see extractPostalCodeFromAddress).
//
// Deliberately NOT implemented in this slice: "retningsnummer-vs-fylke"
// (phone-area-code-vs-county). Modern Norwegian numbers (post-1990s
// numbering reform) are 8-digit with no reliable area-code-to-county
// mapping — mobile/VOIP numbers carry no geographic signal at all, and a
// fabricated area-code table would produce a high false-positive rate on
// perfectly correct agents. Building this honestly needs a real reference
// dataset, not a guessed one; left for a future slice if such a source is
// found. The fourth heuristic (email-domain != website-domain) is NOT
// reimplemented here — it already exists as
// /admin/verifier/domain-coherence-sweep (admin-domain-coherence.ts).
//
// Like domain-coherence-sweep, this is dry-run by default (report only).
// apply:true does NOT write any agent_knowledge content field (address,
// phone, opening_hours, website) — the acceptance criteria for this
// dev-request treats "does a real different entity own this data" as a
// judgment call that needs a fresh source re-check per agent (the same
// discipline slice 1 and addendum 2 applied by hand), which cheap
// heuristics alone cannot safely automate. apply:true only stamps
// wrong_entity_retro_checked_at/_outcome so the daily verifier / a future
// manual pass doesn't re-surface the SAME cluster/mismatch every run
// (30-day backoff, same idiom as domain_reconciliation_* in
// admin-domain-coherence.ts) — a value change on any involved agent lifts
// the parking immediately (snapshot comparison), same escape hatch.
//
// Requires X-Admin-Key header (same requireAdmin pattern as every other
// admin route in this codebase).

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";

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

// Normalizes a field value for cluster-grouping: trim, collapse internal
// whitespace, lowercase. Returns null for values too short/generic to be a
// meaningful duplicate signal (empty, or under MIN_CLUSTER_VALUE_LEN chars —
// avoids grouping on e.g. a bare "17:00" opening-hours fragment).
const MIN_CLUSTER_VALUE_LEN = 8;
function normalizeForCluster(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const norm = raw.trim().replace(/\s+/g, " ").toLowerCase();
  if (norm.length < MIN_CLUSTER_VALUE_LEN) return null;
  return norm;
}

const CLUSTER_FIELDS = ["address", "phone", "opening_hours"] as const;
type ClusterField = (typeof CLUSTER_FIELDS)[number];
const CLUSTER_MIN_GROUP_SIZE = 3; // matches the dev-request's "3+ profiler" evidence bar

interface AgentRow {
  agent_id: string;
  name: string;
  address: string | null;
  postal_code: string | null;
  phone: string | null;
  opening_hours: string | null;
  wrong_entity_retro_checked_at: string | null;
  wrong_entity_retro_outcome: string | null;
}

interface DuplicateCluster {
  field: ClusterField;
  normalized_value: string;
  sample_value: string;
  agent_count: number;
  agents: Array<{ agent_id: string; name: string }>;
}

interface PostalCodeMismatch {
  agent_id: string;
  name: string;
  address: string;
  stored_postal_code: string;
  address_postal_code: string;
}

// Extracts a confident 4-digit Norwegian postal code from a free-text
// address. Norwegian street addresses conventionally end "<gate/vei> <nr>,
// <4-digit-postnummer> <POSTSTED>" — so we require the token to be followed
// by at least one letter (the poststed name), not just anchor on "any 4
// digits anywhere" (which would false-positive on house numbers, unit
// numbers, etc.). Returns null (ambiguous, skip) if zero or more than one
// such token is found.
function extractPostalCodeFromAddress(address: string): string | null {
  const matches = address.match(/\b(\d{4})\b(?=[^\d]*[A-Za-zÆØÅæøå])/g);
  if (!matches) return null;
  const codes = new Set(matches.map((m) => m.match(/\d{4}/)![0]));
  if (codes.size !== 1) return null; // ambiguous (0 or multiple distinct codes) — skip
  return [...codes][0]!;
}

function parkingExclusionClause(): string {
  if (process.env.WRONG_ENTITY_RETRO_PARKING_DISABLED === "true") return "";
  return `AND (
      wrong_entity_retro_checked_at IS NULL
      OR wrong_entity_retro_checked_at <= datetime('now','-30 days')
    )`;
}

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const apply = req.body && (req.body.apply === true || req.body.apply === "true");

  try {
    const db = getDb();

    const rows = db
      .prepare(
        `SELECT a.id AS agent_id, a.name,
                k.address, k.postal_code, k.phone, k.opening_hours,
                k.wrong_entity_retro_checked_at, k.wrong_entity_retro_outcome
           FROM agents a
     INNER JOIN agent_knowledge k ON k.agent_id = a.id
          WHERE a.umbrella_type IS NULL
                ${parkingExclusionClause()}`
      )
      .all() as AgentRow[];

    const cohort_size = rows.length;

    // ── Duplicate-value clusters ──────────────────────────────────────────
    const groups = new Map<string, { field: ClusterField; sampleValue: string; rows: AgentRow[] }>();
    for (const field of CLUSTER_FIELDS) {
      for (const row of rows) {
        const raw = row[field];
        const norm = normalizeForCluster(raw);
        if (!norm) continue;
        const key = `${field}::${norm}`;
        const existing = groups.get(key);
        if (existing) {
          existing.rows.push(row);
        } else {
          groups.set(key, { field, sampleValue: raw as string, rows: [row] });
        }
      }
    }

    const duplicate_value_clusters: DuplicateCluster[] = [];
    const clusteredAgentIds = new Set<string>();
    for (const [key, group] of groups) {
      if (group.rows.length < CLUSTER_MIN_GROUP_SIZE) continue;
      const normalized_value = key.slice(group.field.length + 2);
      duplicate_value_clusters.push({
        field: group.field,
        normalized_value,
        sample_value: group.sampleValue,
        agent_count: group.rows.length,
        agents: group.rows.map((r) => ({ agent_id: r.agent_id, name: r.name })),
      });
      for (const r of group.rows) clusteredAgentIds.add(r.agent_id);
    }
    // Deterministic ordering: largest cluster first, ties broken by field+value.
    duplicate_value_clusters.sort((a, b) =>
      b.agent_count - a.agent_count ||
      a.field.localeCompare(b.field) ||
      a.normalized_value.localeCompare(b.normalized_value)
    );

    // ── Postal-code-vs-address mismatches ───────────────────────────────────
    const postal_code_mismatches: PostalCodeMismatch[] = [];
    const mismatchedAgentIds = new Set<string>();
    for (const row of rows) {
      if (!row.address || !row.postal_code) continue;
      const storedPostal = row.postal_code.trim();
      if (!/^\d{4}$/.test(storedPostal)) continue; // stored value itself isn't a clean 4-digit code — not this check's problem
      const addressPostal = extractPostalCodeFromAddress(row.address);
      if (!addressPostal) continue; // ambiguous — skip, never guess
      if (addressPostal === storedPostal) continue;
      postal_code_mismatches.push({
        agent_id: row.agent_id,
        name: row.name,
        address: row.address,
        stored_postal_code: storedPostal,
        address_postal_code: addressPostal,
      });
      mismatchedAgentIds.add(row.agent_id);
    }
    postal_code_mismatches.sort((a, b) => a.agent_id.localeCompare(b.agent_id));

    const flagged_agent_ids = new Set<string>([...clusteredAgentIds, ...mismatchedAgentIds]);

    let parked = 0;
    if (apply) {
      const stampStmt = db.prepare(
        `UPDATE agent_knowledge
            SET wrong_entity_retro_checked_at = datetime('now'),
                wrong_entity_retro_outcome = ?
          WHERE agent_id = ?`
      );
      for (const row of rows) {
        const outcome = clusteredAgentIds.has(row.agent_id) && mismatchedAgentIds.has(row.agent_id)
          ? "duplicate_cluster+postal_mismatch"
          : clusteredAgentIds.has(row.agent_id)
          ? "duplicate_cluster"
          : mismatchedAgentIds.has(row.agent_id)
          ? "postal_mismatch"
          : "no_action_needed";
        stampStmt.run(outcome, row.agent_id);
        parked++;
      }
    }

    res.json({
      success: true,
      apply: !!apply,
      cohort_size,
      flagged_count: flagged_agent_ids.size,
      duplicate_value_clusters,
      postal_code_mismatches,
      ...(apply ? { parked } : {}),
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: String(err?.message || err),
    });
  }
});

export default router;
