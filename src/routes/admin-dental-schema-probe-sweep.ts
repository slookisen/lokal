// ─── POST /admin/dental/schema-probe-sweep ──────────────────────────────────
// dev-request 2026-07-21-dental-schema-probe-writepath-fix, follow-up.
//
// WHY: PR #323 added isTestFingerprintPayload as a write-path guard on
// PUT /api/tannlege/agents/:id (src/routes/dental.ts) that REJECTS future
// writes matching the known test/probe contamination fingerprint unless the
// target id is on the DENTAL_SYNTHETIC_PROBE_IDS allowlist. That fixes
// FUTURE writes only. Two real production dental_agents rows were already
// contaminated by this fingerprint before the guard existed. This endpoint
// is the read-side follow-up: it scans the full dental_agents catalog
// (~6,975 rows) for rows already carrying the fingerprint and, on request,
// REPAIRS them by clearing (nulling) ONLY the individually-contaminated
// field(s) — never the whole row, never fabricating replacement data — and
// flags the row verification_status = 'needs_review' so the existing
// enrichment re-extraction pipeline naturally re-fills it with real data on
// its next pass. This is explicitly NOT a blind revert and NOT an attempt to
// write "real" data ourselves.
//
// Fingerprint definition + the per-field contamination logic live in
// ../services/dental-contamination.ts (findContaminatedFields) — the exact
// same logic the PUT write-path guard uses (isTestFingerprintPayload), so
// this sweep and that guard can never disagree about what counts as
// contaminated.
//
// Body: { apply?: boolean } — defaults to false (dry-run: report only, zero
// writes). Only the literal JSON boolean `true` triggers a real write; a
// missing key, undefined, or any other value means dry-run. Dry-run is the
// default specifically so an accidental GET-shaped/browser-triggered POST
// with no body can never mutate anything.
//
// Full-catalog pass, no batch cap / no pagination: the table is small enough
// (~7k rows) that a single synchronous SELECT + (on apply) per-row UPDATE
// via better-sqlite3 (synchronous driver) comfortably fits in one request —
// this deliberately does NOT follow the BRREG_SWEEP_BATCH_CAP /
// HJEMMESIDE_CLEANUP_BATCH_CAP convention used by other admin sweeps in this
// codebase, because those operate over much larger or continuously-growing
// candidate sets where an unbounded scan would be unsafe; this one is a
// one-time full-catalog repair pass over a small, static-sized table.
//
// Requires X-Admin-Key header — same requireAdmin/getAdminKey pattern as
// admin-dental-hjemmeside-cleanup.ts (the house style for this kind of
// standalone single-file admin sweep route mounted directly, not nested
// inside dental.ts's router).

import { Router, Request, Response } from "express";
import { getDb } from "../database/db-factory";
import { findContaminatedFields } from "../services/dental-contamination";
import { updateDentalAgent, type DentalAgent } from "../services/dental-store";

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

interface ScannedRow {
  id: string;
  navn: string;
  specialists: string | null;
  online_booking_url: string | null;
  social_media: string | null;
  om_oss: string | null;
  field_provenance: string | null;
  verification_status: string | null;
}

// Parses a raw dental_agents TEXT column (JSON object, possibly null/
// malformed) into a plain object — malformed/non-object/array JSON is
// treated as empty so a corrupted existing blob never blocks a repair
// write. Mirrors parseFieldProvenance in admin-dental-hjemmeside-cleanup.ts
// / admin-domain-coherence.ts.
function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function fetchAllRows(db: ReturnType<typeof getDb>): ScannedRow[] {
  return db
    .prepare(
      `SELECT id, navn, specialists, online_booking_url, social_media, om_oss, field_provenance, verification_status
       FROM dental_agents`,
    )
    .all() as ScannedRow[];
}

const router = Router();

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  // Only the literal JSON boolean `true` triggers a real write.
  const body = (req.body ?? {}) as { apply?: unknown };
  const apply = body.apply === true;

  try {
    const db = getDb("dental");
    const rows = fetchAllRows(db);

    if (!apply) {
      const matches: Array<{ id: string; navn: string; contaminated_fields: string[] }> = [];
      for (const row of rows) {
        const contaminatedFields = findContaminatedFields(row);
        if (contaminatedFields.length === 0) continue;
        matches.push({ id: row.id, navn: row.navn, contaminated_fields: contaminatedFields });
      }
      res.json({
        scanned: rows.length,
        mode: "dry_run",
        matched_count: matches.length,
        matches,
      });
      return;
    }

    // Apply: for every row with at least one contaminated field, build a
    // patch containing ONLY the keys that row actually needs touched (never
    // re-writing an untouched column) and hand it to updateDentalAgent,
    // which already handles JSON-stringifying the JSON-typed columns and
    // stamping updated_at.
    const repairs: Array<{ id: string; navn: string; cleared_fields: string[] }> = [];
    const tx = db.transaction(() => {
      for (const row of rows) {
        const contaminatedFields = findContaminatedFields(row);
        if (contaminatedFields.length === 0) continue;

        const patch: Record<string, unknown> = {};
        const clearedFields: string[] = [];

        for (const field of contaminatedFields) {
          if (field === "specialists" || field === "online_booking_url" || field === "om_oss") {
            patch[field] = null;
            clearedFields.push(field);
          } else if (field === "social_media") {
            const existing = parseJsonObject(row.social_media);
            if (existing.facebook === "https://facebook.com/x") {
              delete existing.facebook;
            }
            patch.social_media = Object.keys(existing).length > 0 ? existing : null;
            clearedFields.push(field);
          } else if (field === "field_provenance") {
            const existing = parseJsonObject(row.field_provenance);
            for (const key of Object.keys(existing)) {
              if (key === "_smoke_test_provenance_probe" || key.startsWith("_smoke_test")) {
                delete existing[key];
              }
            }
            patch.field_provenance = Object.keys(existing).length > 0 ? existing : null;
            clearedFields.push(field);
          }
        }

        // Idempotent — always fine to set, even if the row already carries
        // needs_review.
        patch.verification_status = "needs_review";

        updateDentalAgent(row.id, patch as Partial<DentalAgent>);
        repairs.push({ id: row.id, navn: row.navn, cleared_fields: clearedFields });
      }
    });
    tx();

    res.json({
      scanned: rows.length,
      mode: "apply",
      repaired_count: repairs.length,
      repairs,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Schema-probe sweep failed", detail: err?.message ?? String(err) });
  }
});

export default router;
