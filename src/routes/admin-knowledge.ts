// ─── Admin Knowledge endpoint — PR-24 (2026-05-11) ──────────────
//
// PUT /admin/knowledge — enrichment surface used by lokal-agent-enrichment
// (a Cowork scheduled task) to write the agent_knowledge profile during
// the Phase 2D crawl.
//
// Why this endpoint exists (PR-24):
//   Pool was frozen at 129 since 2026-05-05 because enrichment writes
//   agent_knowledge (about / products / openingHours / address / phone)
//   but did NOT update `field_provenance`. The WO-16 cross-source gate
//   in src/services/cross-source-validator.ts requires source_count >= 2
//   on address/phone/business_status. Without provenance entries, every
//   newly-enriched agent fails the gate.
//
//   The verifier never writes provenance (it only reads). The enrichment
//   SKILL must populate it on every crawl-write. This route is the
//   surface the SKILL PUTs into.
//
// Shape that the validator (cross-source-validator.ts) reads from disk:
//   field_provenance = {
//     <field>: ProvenanceRecord[]
//   }
//   ProvenanceRecord = { value, source_type, source_url?, fetched_at }
//
// Wire-shape this endpoint accepts (two flavours, both normalised in):
//   1. Wrapped:
//        { address: { sources: [{source_type, captured_at, raw_value}, ...] } }
//      Matches the SKILL-addendum example written for the enrichment-agent.
//   2. Flat array (matches on-disk shape):
//        { address: [{value, source_type, fetched_at, source_url?}, ...] }
//      Matches what the validator reads. Either works.
//
// PR-127 (2026-06-08): replace-mode. Body may include provenance_replace_fields:
//   string[] — for those fields the incoming sources REPLACE the existing
//   provenance array instead of appending. This is option (a) from the
//   2026-06-08 enrichment report: a clean re-crawl can purge garbage sources
//   (award text / prose mis-captured as address/phone) that the additive merge
//   could never evict. Default (omitted/empty) = merge, fully backwards-compatible.
//
// Merge semantics:
//   - For each tracked field, append new sources to the existing array.
//   - Dedupe by {source_type, normalised value}: same pair = no-op.
//   - Untouched fields preserve existing provenance.
//   - Untouched columns (about, products, ...) preserve existing values.
//
// PR-28 (2026-05-11): defensive handling of malformed existing
// field_provenance. The phase51_backfill_provenance_v1 migration writes
// records WITHOUT a `value` field (only source_type/source_url/
// confidence/fetched_at). phase53_provenance_to_array_v1 then wraps
// those legacy single-objects in a 1-element array. When this route
// loaded such an entry and called `mergeFieldProvenance` → `dedupKey`,
// `rec.value.trim()` threw on `undefined.trim()`, the error escaped the
// route's try/catch (which only wrapped tx()), and express's default
// handler returned plain-HTML 500 — breaking enrichment for address/
// phone on any agent touched by the back-catalogue migrations. We now
// (1) skip malformed records on the way in, (2) guard dedupKey against
// undefined, and (3) wrap mergeFieldProvenance + parse in try/catch so
// any unexpected shape returns a 500 JSON instead of crashing express.
//
// Auth: X-Admin-Key (same pattern as admin-outreach-pool).
//
// Reference:
//   - PR-23: parallel backfill for stranded back-catalogue (different file).
//   - PR-28: this defensive-coding fix.
//   - WO-16: source of the cross-source gate.
//   - scheduled-agents/lokal-agent-enrichment-field-provenance-addendum.md
//     (A2A repo) — SKILL update that makes use of this endpoint.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";

const router = Router();

// ─── Auth helper (mirrors admin-outreach-pool.ts pattern) ─────────────
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

// ─── Shape & merge logic for field_provenance ──────────────────────────

// On-disk shape (matches cross-source-validator.ProvenanceRecord)
type ProvenanceRecord = {
  value: string;
  source_type: string;
  source_url?: string;
  fetched_at: string;
};

// Wire-shape — the enrichment SKILL may emit either flat array or wrapped
// {sources:[...]} per field. Each source may use {raw_value, captured_at}
// (the convention used in the SKILL doc) or {value, fetched_at} (the
// on-disk names). We accept both and normalise.
type IncomingSource = {
  source_type?: string;
  value?: string;
  raw_value?: string;
  fetched_at?: string;
  captured_at?: string;
  source_url?: string;
};
type IncomingFieldEntry = IncomingSource[] | { sources?: IncomingSource[] };
type IncomingProvenance = Record<string, IncomingFieldEntry>;

function normaliseSource(s: IncomingSource): ProvenanceRecord | null {
  const source_type = (s.source_type ?? "").toString().trim();
  if (!source_type) return null;
  const value = (s.value ?? s.raw_value ?? "").toString();
  // Reject sources that carry no value — the validator filters them out
  // anyway, so storing them would just be noise.
  if (!value || !value.trim()) return null;
  const fetched_at = (s.fetched_at ?? s.captured_at ?? new Date().toISOString()).toString();
  const rec: ProvenanceRecord = { value, source_type, fetched_at };
  if (s.source_url) rec.source_url = String(s.source_url);
  return rec;
}

function extractSources(entry: IncomingFieldEntry): IncomingSource[] {
  if (Array.isArray(entry)) return entry;
  if (entry && typeof entry === "object" && Array.isArray((entry as any).sources)) {
    return (entry as { sources: IncomingSource[] }).sources;
  }
  return [];
}

// Dedupe key — same source_type and same trimmed value = same source.
// Intentionally pragmatic: the cross-source validator normalises
// per-field (phone strips +47 etc), but for dedup purposes the raw
// `${source_type}::${value.trim()}` pair is precise enough to avoid
// double-counting on repeat enrichment runs.
//
// PR-28: tolerates malformed records — if value or source_type is
// missing/non-string, returns null. Callers MUST treat null as "skip
// this record" (don't add to seen-set, don't include in output).
export function dedupKey(rec: ProvenanceRecord | null | undefined): string | null {
  if (!rec || typeof rec !== "object") return null;
  const st = rec.source_type;
  const v = rec.value;
  if (typeof st !== "string" || st.length === 0) return null;
  if (typeof v !== "string") return null;
  return `${st}::${v.trim()}`;
}

// PR-28: a record loaded from disk is "well-formed" only if both
// source_type and value are non-empty strings. Anything else is dropped
// before the merge so the rest of the merge pipeline can assume the
// invariant. Mirrors the validator's downstream filter.
function isWellFormedRecord(r: unknown): r is ProvenanceRecord {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  if (typeof o.source_type !== "string" || o.source_type.trim().length === 0) return false;
  if (typeof o.value !== "string" || o.value.trim().length === 0) return false;
  return true;
}

/**
 * Merge an incoming field_provenance payload into an existing on-disk
 * field_provenance object. Pure function — exported for unit-testing.
 *
 * PR-28: malformed existing records (missing value or source_type — as
 * produced by the phase51 backfill migration) are filtered out instead
 * of being carried forward. The route handler will overwrite the column
 * with the cleaned shape on the next provenance write.
 *
 * @param existing parsed JSON from agent_knowledge.field_provenance (may be {})
 * @param incoming wire-shape payload (wrapped or flat per field)
 * @returns merged on-disk shape
 */
export function mergeFieldProvenance(
  existing: Record<string, unknown>,
  incoming: IncomingProvenance,
  replaceFields?: Set<string>,
): Record<string, ProvenanceRecord[]> {
  // Start from a shallow copy of existing — coerce legacy single-record
  // shape into arrays, then drop malformed entries (PR-28 defensive
  // coding for back-catalogue rows from phase51 backfill).
  const out: Record<string, ProvenanceRecord[]> = {};
  for (const [field, val] of Object.entries(existing)) {
    let arr: unknown[];
    if (Array.isArray(val)) {
      arr = val.slice();
    } else if (val && typeof val === "object") {
      // Legacy single-record shape (pre-WO-16) → wrap in array.
      arr = [val];
    } else {
      // null / primitives → drop (mirrors validator behaviour).
      continue;
    }
    // PR-28: filter out malformed records before they reach dedupKey.
    out[field] = arr.filter(isWellFormedRecord);
  }

  for (const [field, entry] of Object.entries(incoming)) {
    const incomingSources = extractSources(entry);
    // Note: a replace-listed field with NO incoming sources is a no-op here
    // (existing provenance is preserved) — replace requires fresh sources;
    // it never purges to empty. Conservative by design (no silent data loss).
    if (incomingSources.length === 0) continue;
    // PR-127: replace-mode starts the field clean so incoming sources fully
    // overwrite the existing array (purges un-evictable garbage). Default merge
    // keeps existing and appends de-duped.
    const existingForField = replaceFields?.has(field) ? [] : (out[field] ?? []);
    // Seed seen-set from well-formed existing records. dedupKey now
    // returns null on malformed inputs — they were already filtered
    // above, but the null-guard keeps belt-and-braces.
    const seen = new Set<string>();
    for (const r of existingForField) {
      const k = dedupKey(r);
      if (k !== null) seen.add(k);
    }
    for (const s of incomingSources) {
      const rec = normaliseSource(s);
      if (!rec) continue;
      const key = dedupKey(rec);
      if (key === null) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      existingForField.push(rec);
    }
    out[field] = existingForField;
  }

  return out;
}

// ─── Column write — body fields → agent_knowledge ──────────────────────
//
// We do the provenance update in a single transaction with the column
// upsert so partial writes don't leave the row in a half-state.

type IncomingBody = {
  agent_id?: string;
  about?: string;
  products?: unknown;
  openingHours?: unknown;
  address?: string;
  phone?: string;
  email?: string;
  postalCode?: string;
  website?: string;
  field_provenance?: IncomingProvenance;
  // PR-127 (2026-06-08): fields listed here have their provenance REPLACED by
  // the incoming sources instead of appended. Lets a clean re-crawl purge
  // garbage sources (e.g. award text / prose captured as an address) that the
  // additive merge can never evict. Omitted/empty = merge (default).
  provenance_replace_fields?: string[];
};

router.put("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as IncomingBody;
  const agentId = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
  if (!agentId) {
    res.status(400).json({ error: "agent_id required" });
    return;
  }

  const db = getDb();
  const agentRow = db.prepare("SELECT id FROM agents WHERE id = ?").get(agentId) as
    | { id: string }
    | undefined;
  if (!agentRow) {
    res.status(404).json({ error: "agent not found" });
    return;
  }

  // ── Build the column-write piece ──────────────────────────────────────
  // Only touch columns the caller actually provided (matching the spirit
  // of the existing knowledge-service.upsertKnowledge merge — `undefined`
  // preserves, explicit value overwrites).
  const columnUpdates: { col: string; val: unknown }[] = [];
  if (typeof body.about === "string") columnUpdates.push({ col: "about", val: body.about });
  if (typeof body.address === "string") columnUpdates.push({ col: "address", val: body.address });
  if (typeof body.phone === "string") columnUpdates.push({ col: "phone", val: body.phone });
  if (typeof body.email === "string") columnUpdates.push({ col: "email", val: body.email });
  if (typeof body.postalCode === "string")
    columnUpdates.push({ col: "postal_code", val: body.postalCode });
  if (typeof body.website === "string") columnUpdates.push({ col: "website", val: body.website });
  if (body.products !== undefined)
    columnUpdates.push({ col: "products", val: JSON.stringify(body.products) });
  if (body.openingHours !== undefined)
    columnUpdates.push({ col: "opening_hours", val: JSON.stringify(body.openingHours) });

  // ── Build the field_provenance piece ──────────────────────────────────
  // PR-28: wrap merge in try/catch so an unexpected on-disk shape returns
  // a structured 500 JSON instead of letting the throw escape to express's
  // default HTML handler.
  let provenanceMerged: Record<string, ProvenanceRecord[]> | null = null;
  // PR-127: optional per-field replace set (default merge).
  let replaceFields: Set<string> | undefined;
  if (Array.isArray(body.provenance_replace_fields)) {
    replaceFields = new Set(
      body.provenance_replace_fields.filter(
        (f): f is string => typeof f === "string" && f.trim().length > 0,
      ),
    );
  }
  if (body.field_provenance && typeof body.field_provenance === "object") {
    const existingRow = db
      .prepare("SELECT field_provenance FROM agent_knowledge WHERE agent_id = ?")
      .get(agentId) as { field_provenance?: string } | undefined;
    let existing: Record<string, unknown> = {};
    if (existingRow?.field_provenance) {
      try {
        const parsed = JSON.parse(existingRow.field_provenance);
        if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
      } catch {
        existing = {};
      }
    }
    try {
      provenanceMerged = mergeFieldProvenance(existing, body.field_provenance, replaceFields);
    } catch (mergeErr: any) {
      res.status(500).json({
        error: "field_provenance_merge_failed",
        detail: mergeErr?.message ?? String(mergeErr),
      });
      return;
    }
  }

  // ── Apply ─────────────────────────────────────────────────────────────
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    // Ensure a row exists. The agent_knowledge row may not be present
    // for newly-registered agents that haven't been enriched before.
    const existsRow = db
      .prepare("SELECT 1 AS one FROM agent_knowledge WHERE agent_id = ?")
      .get(agentId) as { one: number } | undefined;
    if (!existsRow) {
      db.prepare(
        "INSERT INTO agent_knowledge (agent_id, field_provenance, updated_at) VALUES (?, '{}', ?)",
      ).run(agentId, now);
    }

    if (columnUpdates.length > 0) {
      const setClause = columnUpdates.map((u) => `${u.col} = ?`).join(", ");
      const params = columnUpdates.map((u) => u.val);
      params.push(now);
      params.push(agentId);
      db.prepare(
        `UPDATE agent_knowledge SET ${setClause}, updated_at = ? WHERE agent_id = ?`,
      ).run(...params);
    }

    if (provenanceMerged !== null) {
      db.prepare(
        "UPDATE agent_knowledge SET field_provenance = ?, updated_at = ? WHERE agent_id = ?",
      ).run(JSON.stringify(provenanceMerged), now, agentId);
    }
  });

  try {
    tx();
  } catch (err: any) {
    res.status(500).json({ error: "write_failed", detail: err?.message ?? String(err) });
    return;
  }

  // Echo back what we ended up with — useful for the SKILL to log
  // counts per field for the daily enrichment-report.
  const summary: Record<string, number> = {};
  if (provenanceMerged) {
    for (const [field, arr] of Object.entries(provenanceMerged)) {
      summary[field] = arr.length;
    }
  }

  res.json({
    success: true,
    agent_id: agentId,
    columns_updated: columnUpdates.map((u) => u.col),
    field_provenance_counts: summary,
    provenance_replaced_fields: replaceFields ? [...replaceFields] : [],
  });
});

export default router;
