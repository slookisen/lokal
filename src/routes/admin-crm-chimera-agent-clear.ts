// ─── Admin: POST /admin/crm-chimera-agent-clear ───────────────────────────
//
// dev-request 2026-07-23-crm-house-bucket-kimaere-opprydding — slice 2, the
// live-data-cleanup half of PR #405 ("root-cause guards for the 'Rett fra
// Bonden' house-bucket chimera"). #405's own commit message is explicit:
// "the live data cleanup on agent 2b5fc7a6 is a separate, non-code
// operational step, not part of this PR" — this endpoint IS that step,
// finally made code (reviewable, dry-run-first, idempotent) instead of a
// manual hand-run SQL statement.
//
// Background: a May-2026 data-matching bug (already fixed) overwrote the
// SINGLE "chimera" agent_knowledge row — agent_id
// 2b5fc7a6-b446-4bea-8c2d-21315c6c6e17, agents.name "Rett fra Bonden" (the
// platform's own name), agents.role = 'logistics' — with a REAL, different
// producer's data ("Bondens Kolonial"). That real producer has since been
// correctly onboarded as its own clean agent record, so this row's
// contaminated fields are pure leftover junk. Confirmed still live via
// GET /api/marketplace/agents/2b5fc7a6.../card (a public, machine-readable
// A2A agent-card AI agents/crawlers consume) — it was misattributing a real
// person's email, phone, address, Google rating, opening hours,
// specialties, payment/delivery options, and an "about" text describing
// Bondens Kolonial to "Rett fra Bonden".
//
// Scope — ONE hardcoded row, ONE time. This is deliberately NOT a
// generalized sweep (unlike admin-wrong-entity-retro-sweep.ts /
// admin-domain-coherence.ts, which scan the whole catalog): CHIMERA_AGENT_ID
// below is the only id this route will ever touch. It does not accept an
// agent_id param at all — the safest option per the dev-request, since a
// parameterized version of this exact same clearing logic pointed at the
// wrong id would itself be a data-integrity incident.
//
// Fields cleared (exactly these — verified against both the
// agent_knowledge CREATE TABLE / ALTER history in src/database/init.ts and
// the actual read path serving the public card: GET /agents/:id/card in
// marketplace.ts reads via knowledgeService.getAgentInfo(), which maps
// google_rating/google_review_count -> knowledge.ratings.google.{score,
// reviews} and about/address/postal_code/phone/email/opening_hours/
// products/specialties/payment_methods/delivery_options 1:1 by name;
// external_reviews isn't read by the card route itself but IS rendered on
// the public producer page, seo.ts's k.externalReviews, so it carries the
// same contamination-class risk and is in scope):
//   about, address, postal_code, phone, email, opening_hours, products,
//   specialties, payment_methods, delivery_options, google_rating,
//   google_review_count, external_reviews
// Each field is cleared to its OWN column's schema default — NULL for the
// scalar TEXT/REAL/INTEGER columns (about/address/postal_code/phone/email/
// google_rating/google_review_count have no non-NULL CREATE TABLE default),
// '[]' for the JSON-array columns (opening_hours/products/specialties/
// payment_methods/delivery_options/external_reviews all default to '[]' in
// the CREATE TABLE) — never a different empty representation.
//
// Explicitly NOT touched (no evidence of contamination in the live card
// response, or out of scope per the dev-request): website, certifications,
// images, data_source, auto_sources, last_enriched_at, owner_updated_at,
// external_links, preferences, field_provenance, verification_status,
// enrichment_status, and every other agent_knowledge column. Also
// explicitly NOT touched: the 13 crm_contacts rows that reference this
// agent_id — that is a separate, human-input-needed step (out of scope
// here; this route never reads or writes crm_contacts). Also NOT touched:
// the /agents/:id/card route itself — no role-gate, no route-level change;
// the fix is purely at the data layer, since the card route's own
// `if (k.field) ...` guards already omit empty fields once they're cleared.
//
// Dry-run by default (report only, no writes). apply=true (query string
// ?apply=true or JSON body {apply:true}) performs the writes — mirrors the
// dry_run/apply convention used throughout this codebase's other one-off
// data-repair sweeps (admin-domain-coherence.ts, admin-agent-audit.ts's
// field-provenance-legacy-shape-normalize). Idempotent: a second apply call
// against an already-cleared row reports the same before/after (all already
// empty) and performs a no-op UPDATE (still touches exactly 1 row, still
// succeeds) rather than erroring.
//
// Requires X-Admin-Key header (same requireAdmin pattern as every other
// admin route in this codebase — copied verbatim from
// admin-domain-coherence.ts / admin-wrong-entity-retro-sweep.ts).

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";

const router = Router();

// The ONLY agent_id this route will ever act on. Intentionally not
// accepted as a request param — see file header.
export const CHIMERA_AGENT_ID = "2b5fc7a6-b446-4bea-8c2d-21315c6c6e17";

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

// Scalar (non-JSON) columns — cleared to SQL NULL, matching their CREATE
// TABLE definitions (no DEFAULT clause, so the implicit default is NULL).
const SCALAR_FIELDS = [
  "about",
  "address",
  "postal_code",
  "phone",
  "email",
  "google_rating",
  "google_review_count",
] as const;

// JSON-array columns — cleared to the literal string '[]', matching their
// own `TEXT DEFAULT '[]'` CREATE TABLE definitions.
const JSON_ARRAY_FIELDS = [
  "opening_hours",
  "products",
  "specialties",
  "payment_methods",
  "delivery_options",
  "external_reviews",
] as const;

const ALL_FIELDS = [...SCALAR_FIELDS, ...JSON_ARRAY_FIELDS] as const;
type FieldName = (typeof ALL_FIELDS)[number];

interface KnowledgeRow {
  agent_id: string;
  about: string | null;
  address: string | null;
  postal_code: string | null;
  phone: string | null;
  email: string | null;
  google_rating: number | null;
  google_review_count: number | null;
  opening_hours: string | null;
  products: string | null;
  specialties: string | null;
  payment_methods: string | null;
  delivery_options: string | null;
  external_reviews: string | null;
}

function targetValueFor(field: FieldName): null | "[]" {
  return (JSON_ARRAY_FIELDS as readonly string[]).includes(field) ? "[]" : null;
}

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { apply?: unknown };
  const apply =
    req.query?.apply === "1" ||
    req.query?.apply === "true" ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === true ||
    body.apply === "true";

  try {
    const db = getDb();

    const row = db
      .prepare(
        `SELECT agent_id, about, address, postal_code, phone, email,
                google_rating, google_review_count, opening_hours, products,
                specialties, payment_methods, delivery_options, external_reviews
           FROM agent_knowledge
          WHERE agent_id = ?`
      )
      .get(CHIMERA_AGENT_ID) as KnowledgeRow | undefined;

    if (!row) {
      res.status(404).json({
        success: false,
        error: "agent_knowledge row not found for the chimera agent id",
        agent_id: CHIMERA_AGENT_ID,
      });
      return;
    }

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const field of ALL_FIELDS) {
      before[field] = row[field];
      after[field] = targetValueFor(field);
    }

    if (!apply) {
      res.json({
        success: true,
        apply: false,
        agent_id: CHIMERA_AGENT_ID,
        fields_cleared: ALL_FIELDS,
        before,
        after_preview: after,
        rows_touched: 0,
      });
      return;
    }

    const updateStmt = db.prepare(
      `UPDATE agent_knowledge
          SET about = NULL,
              address = NULL,
              postal_code = NULL,
              phone = NULL,
              email = NULL,
              google_rating = NULL,
              google_review_count = NULL,
              opening_hours = '[]',
              products = '[]',
              specialties = '[]',
              payment_methods = '[]',
              delivery_options = '[]',
              external_reviews = '[]'
        WHERE agent_id = ?`
    );
    const result = updateStmt.run(CHIMERA_AGENT_ID);

    res.json({
      success: true,
      apply: true,
      agent_id: CHIMERA_AGENT_ID,
      fields_cleared: ALL_FIELDS,
      before,
      after,
      rows_touched: result.changes,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: String(err?.message || err),
    });
  }
});

export default router;
