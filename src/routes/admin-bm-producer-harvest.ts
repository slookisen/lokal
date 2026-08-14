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
//   APPLY MODE (dev-request 2026-08-14-bm-fullhoest-katalogbred, slice 3).
//   Re-runs the same fetch/match loop as the dry-run branch above, for the
//   apply-mode slug window (default 20, hard max 50 — deliberately far below
//   the dry-run cap of 400), and writes `agents.contact_email` from the
//   harvested BM record's email for exactly the rows that pass the same
//   claimed/curated/validation gates as
//   POST /admin/agents/contact-email-write (admin-agents-contact-email-write.ts,
//   the canonical write-discipline reference for this column). ONE write
//   lever only: contact_email. No other column, no other table, is ever
//   written by this file.
//
// Auth: X-Admin-Key (same pattern as admin-bm-reconcile.ts — own local
// requireAdmin, no shared middleware, per this codebase's convention).
//
// The dry_run branch below performs ZERO database writes — no
// INSERT/UPDATE/DELETE/.run( at all — exactly as before slice 3. The apply
// branch is the only place in this file that writes, and only to
// agents.contact_email + one agent_knowledge_audit row per change.

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import {
  fetchBmProducerSlugs,
  fetchBmProducerRecord,
  matchBmProducerToCatalog,
} from "../services/bm-producer-harvest";
import {
  isSyntacticallyValidEmail,
  isPlatformOwnedEmailDomain,
  isContactEmailCurated,
} from "./admin-agents-contact-email-write";

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

// ─── Apply-mode (slice 3) ───────────────────────────────────────────────────

/** Deliberately far below HARD_CAP_SLUGS (400) — apply mode WRITES, dry-run only reads. */
const APPLY_DEFAULT_LIMIT = 20;
const APPLY_MAX_LIMIT = 50;

/**
 * Defense-in-depth: bm-producer-harvest.ts's own parser already excludes
 * @bondensmarked.no mailtos from `record.email` (bmDomainEmailExcluded), but
 * this route re-checks independently, in its OWN code, before any write
 * attempt — never trust a single upstream filter to guard a write path.
 * Mirrors isBmDomainEmail in services/bm-producer-harvest.ts (not exported,
 * so re-declared here rather than imported).
 */
function isBmDomainEmailForApply(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at === -1) return false;
  const domain = email
    .slice(at + 1)
    .toLowerCase()
    .replace(/\.$/, "");
  return domain === "bondensmarked.no" || domain.endsWith(".bondensmarked.no");
}

type ApplyOutcome =
  | "written"
  | "skipped_claimed"
  | "skipped_curated"
  | "skipped_unchanged"
  | "skipped_bm_domain"
  | "skipped_no_email"
  | "rejected_invalid_email"
  | "rejected_platform_domain"
  | "unmatched"
  | "parse_failed"
  | "error";

interface ApplyResultItem {
  slug: string;
  agent_id?: string;
  outcome: ApplyOutcome;
  old_value?: string | null;
  new_value?: string | null;
  detail?: string;
}

/**
 * Write ONE agent's contact_email from its matched BM record. Modeled
 * structurally on applyContactEmail() in admin-agents-contact-email-write.ts:
 * re-reads claimed_at + curated_fields + the current value from a FRESH
 * snapshot immediately before writing, inside its own transaction, and
 * writes one agent_knowledge_audit row carrying the OLD value on success.
 * One row per transaction — a failure here must never abort the batch, so
 * every path through this function returns rather than throws (the try/catch
 * is a final backstop for anything unexpected from better-sqlite3 itself).
 */
function applyBmEmail(
  db: ReturnType<typeof getDb>,
  agentId: string,
  newValue: string,
  batchTag: string,
  slug: string,
): { outcome: ApplyOutcome; oldValue?: string | null; detail?: string } {
  try {
    const tx = db.transaction((): { outcome: ApplyOutcome; oldValue?: string | null; detail?: string } => {
      const cur = db
        .prepare(
          `SELECT a.claimed_at AS claimed_at,
                  a.contact_email AS contact_email,
                  k.curated_fields AS curated_fields
             FROM agents a
             LEFT JOIN agent_knowledge k ON k.agent_id = a.id
            WHERE a.id = ?`,
        )
        .get(agentId) as
        | { claimed_at: string | null; contact_email: string | null; curated_fields: string | null }
        | undefined;

      if (!cur) return { outcome: "error", detail: "agent not found at write time" };
      if (cur.claimed_at) return { outcome: "skipped_claimed" };
      if (isContactEmailCurated(cur.curated_fields)) return { outcome: "skipped_curated" };

      const currentValue = cur.contact_email ?? "";
      if (currentValue.trim().toLowerCase() === newValue.trim().toLowerCase()) {
        return { outcome: "skipped_unchanged", oldValue: cur.contact_email };
      }

      db.prepare(`UPDATE agents SET contact_email = ? WHERE id = ?`).run(newValue, agentId);
      db.prepare(
        `INSERT INTO agent_knowledge_audit
           (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
         VALUES (?, ?, 'contact_email', ?, ?, 'system', NULL, datetime('now'), ?)`,
      ).run(randomUUID(), agentId, cur.contact_email, newValue, `${batchTag}: slug=${slug}`);

      return { outcome: "written", oldValue: currentValue };
    });
    return tx();
  } catch (e: any) {
    return { outcome: "error", detail: e?.message ?? String(e) };
  }
}

router.get("/", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  // The ONLY way into apply-mode is the literal string "false" — missing,
  // "1", "yes", anything else stays on the safe dry-run path below.
  const dryRunParam = typeof req.query.dry_run === "string" ? req.query.dry_run : "true";
  if (dryRunParam === "false") {
    const tApply0 = Date.now();
    try {
      let limit = APPLY_DEFAULT_LIMIT;
      if (typeof req.query.limit === "string") {
        const n = parseInt(req.query.limit, 10);
        if (Number.isFinite(n) && n > 0) {
          limit = Math.min(n, APPLY_MAX_LIMIT);
        }
      }

      const allSlugs = await fetchBmProducerSlugs();
      const total_slugs = allSlugs.length;
      const slugsToProcess = allSlugs.slice(0, limit);

      const db = getDb();
      const batchTag = `bm-producer-harvest-${new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace("T", "-")
        .slice(0, 15)}`;

      const results: ApplyResultItem[] = [];

      for (const slug of slugsToProcess) {
        const record = await fetchBmProducerRecord(slug);
        if (!record) {
          results.push({ slug, outcome: "parse_failed" });
          continue;
        }

        const match = matchBmProducerToCatalog(db, record);
        if (!match) {
          results.push({ slug, outcome: "unmatched" });
          continue;
        }
        const agentId = match.agentId;

        // Defense-in-depth (AC2 of this slice): hard-skip before ANY write
        // attempt — never call the write path for a bondensmarked.no address.
        // Checked BEFORE the "no email" check below because the parser sets
        // `email: null` whenever it excludes a @bondensmarked.no mailto (see
        // services/bm-producer-harvest.ts), so `bmDomainEmailExcluded` must be
        // tested on its own, independent of whether `record.email` is set —
        // relying on "email is null" to imply "was a BM address" would be
        // relying on the very upstream behavior this check exists to not
        // solely depend on.
        if (record.bmDomainEmailExcluded) {
          results.push({ slug, agent_id: agentId, outcome: "skipped_bm_domain" });
          continue;
        }

        if (!record.email) {
          results.push({ slug, agent_id: agentId, outcome: "skipped_no_email" });
          continue;
        }

        // Second, independent form of the same defense-in-depth check: even
        // if a BM-domain email ever reached here with bmDomainEmailExcluded
        // NOT set, this route's own domain check still catches it.
        if (isBmDomainEmailForApply(record.email)) {
          results.push({ slug, agent_id: agentId, outcome: "skipped_bm_domain" });
          continue;
        }

        const candidate = record.email.trim();
        if (!isSyntacticallyValidEmail(candidate)) {
          results.push({ slug, agent_id: agentId, outcome: "rejected_invalid_email", new_value: candidate });
          continue;
        }
        if (isPlatformOwnedEmailDomain(candidate)) {
          results.push({ slug, agent_id: agentId, outcome: "rejected_platform_domain", new_value: candidate });
          continue;
        }

        const cur = db
          .prepare(
            `SELECT a.claimed_at AS claimed_at, a.contact_email AS contact_email, k.curated_fields AS curated_fields
               FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id
              WHERE a.id = ?`,
          )
          .get(agentId) as
          | { claimed_at: string | null; contact_email: string | null; curated_fields: string | null }
          | undefined;

        if (!cur) {
          results.push({ slug, agent_id: agentId, outcome: "error", detail: "matched agent not found" });
          continue;
        }
        if (cur.claimed_at) {
          results.push({ slug, agent_id: agentId, outcome: "skipped_claimed", old_value: cur.contact_email });
          continue;
        }
        if (isContactEmailCurated(cur.curated_fields)) {
          results.push({ slug, agent_id: agentId, outcome: "skipped_curated", old_value: cur.contact_email });
          continue;
        }
        if ((cur.contact_email ?? "").trim().toLowerCase() === candidate.toLowerCase()) {
          results.push({ slug, agent_id: agentId, outcome: "skipped_unchanged", old_value: cur.contact_email });
          continue;
        }

        const w = applyBmEmail(db, agentId, candidate, batchTag, slug);
        results.push({
          slug,
          agent_id: agentId,
          outcome: w.outcome,
          old_value: w.oldValue ?? cur.contact_email,
          new_value: candidate,
          ...(w.detail ? { detail: w.detail } : {}),
        });
      }

      const counts = results.reduce<Record<string, number>>((acc, r) => {
        acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
        return acc;
      }, {});

      res.json({
        success: true,
        dry_run: false,
        batch_tag: batchTag,
        total_slugs,
        scanned: slugsToProcess.length,
        counts,
        results,
        duration_ms: Date.now() - tApply0,
      });
    } catch (err: any) {
      res.status(500).json({
        error: "bm-producer-harvest apply failed",
        detail: err?.message || String(err),
      });
    }
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
