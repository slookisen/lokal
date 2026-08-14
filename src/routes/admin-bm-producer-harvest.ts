// ─── Admin: Bondens Marked producer harvest (dev-request 2026-08-14-bm-fullhoest-katalogbred, slice 2) ──
//
// GET /admin/bm-producer-harvest
//
//   READ-ONLY / DRY-RUN ONLY diagnostic. Fetches bondensmarked.no's
//   ~345 producer pages (via services/bm-producer-harvest.ts), fuzzy-matches
//   each parsed record against our own `agents` catalog, and reports what a
//   future "apply" slice WOULD write — without writing anything.
//
//   Query params:
//     limit    — optional positive integer, default = process all slugs,
//                hard-capped at 400 regardless of what's requested.
//     dry_run  — optional, default "true". The literal string "false" is
//                the ONLY way to reach the apply-mode stub below.
//
// GET /admin/bm-producer-harvest?dry_run=false
//
//   Responds 501 — apply mode is not implemented in this slice. This branch
//   does NOTHING else: no fetch, no DB access, no work of any kind. That is
//   deliberate, not merely "no writes" — the apply path does not exist as
//   working code yet, only this stub.
//
// Auth: X-Admin-Key (same pattern as admin-bm-reconcile.ts — own local
// requireAdmin, no shared middleware, per this codebase's convention).
//
// ZERO DATABASE WRITES anywhere in this file, in either branch. No
// INSERT/UPDATE/DELETE/.run( at all. The one SELECT against `agents` is a
// read used only to decide whether a BM-sourced value would actually
// change anything (the would_write_estimate numbers) — never a write.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import {
  fetchBmProducerSlugs,
  fetchBmProducerRecord,
  matchBmProducerToCatalog,
} from "../services/bm-producer-harvest";

const router = Router();

// ─── Auth helper (same pattern as admin-bm-reconcile.ts) ──────────────────

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

const HARD_CAP_SLUGS = 400;

router.get("/", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  // The ONLY way into apply-mode's stub is the literal string "false" —
  // missing, "1", "yes", anything else stays on the safe dry-run path.
  const dryRunParam = typeof req.query.dry_run === "string" ? req.query.dry_run : "true";
  if (dryRunParam === "false") {
    res.status(501).json({
      error: "apply mode not yet implemented — see dev-request 2026-08-14-bm-fullhoest-katalogbred slice 3",
    });
    return;
  }

  const t0 = Date.now();
  try {
    let limit = HARD_CAP_SLUGS;
    if (typeof req.query.limit === "string") {
      const n = parseInt(req.query.limit, 10);
      if (Number.isFinite(n) && n > 0) {
        limit = Math.min(n, HARD_CAP_SLUGS);
      }
    }

    const allSlugs = await fetchBmProducerSlugs();
    const total_slugs = allSlugs.length;
    const slugsToProcess = allSlugs.slice(0, limit);

    const db = getDb();

    let parse_failed = 0;
    let matched = 0;
    let unmatched = 0;
    let bm_domain_email_excluded_count = 0;
    // NOTE: address_2nd_source is a raw upper-bound estimate — it increments
    // once per matched record and does NOT apply cross-source-validator's
    // blocked_both gating. Wiring into that aggregate logic is out of scope
    // for this slice.
    const would_write_estimate = { email: 0, phone: 0, address_2nd_source: 0 };
    const sample: Array<{
      slug: string;
      bmName: string;
      agentId: string;
      agentName: string;
      nameScore: number;
    }> = [];

    for (const slug of slugsToProcess) {
      const record = await fetchBmProducerRecord(slug);
      if (!record) {
        parse_failed++;
        continue;
      }
      if (record.bmDomainEmailExcluded) bm_domain_email_excluded_count++;

      const match = matchBmProducerToCatalog(db, record);
      if (!match) {
        unmatched++;
        continue;
      }
      matched++;

      if (sample.length < 20) {
        sample.push({
          slug,
          bmName: record.name,
          agentId: match.agentId,
          agentName: match.agentName,
          nameScore: match.nameScore,
        });
      }

      // Read-only lookup of the matched agent's CURRENT contact_email/url —
      // used only to decide whether the BM-sourced value would actually
      // change anything. No write happens here or anywhere in this file.
      const agentRow = db
        .prepare("SELECT contact_email, url FROM agents WHERE id = ?")
        .get(match.agentId) as { contact_email: string | null; url: string | null } | undefined;

      if (record.email) {
        const current = (agentRow?.contact_email ?? "").trim();
        if (!current || current.toLowerCase() !== record.email.trim().toLowerCase()) {
          would_write_estimate.email++;
        }
      }
      // `agents` carries no phone column of its own (phone lives on
      // agent_knowledge, a second table deliberately left untouched by this
      // single-table read) — so from what we selected here "current" is
      // always absent, and any BM-sourced phone counts as a would-be fill.
      if (record.phone) {
        would_write_estimate.phone++;
      }
      would_write_estimate.address_2nd_source++;
    }

    res.json({
      total_slugs,
      fetched: slugsToProcess.length,
      parse_failed,
      matched,
      unmatched,
      would_write_estimate,
      bm_domain_email_excluded_count,
      sample,
      duration_ms: Date.now() - t0,
    });
  } catch (err: any) {
    res.status(500).json({
      error: "bm-producer-harvest failed",
      detail: err?.message || String(err),
    });
  }
});

export default router;
