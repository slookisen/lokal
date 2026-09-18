// ─── Admin: GET/POST /admin/agents/category-description-provenance-audit ────
//
// dev-request 2026-09-09-rfb-kategori-og-beskrivelse-provenance-audit
// (slookisen/A2A). Daniel's 14-day reply-review found two root causes behind
// factually-wrong outreach emails:
//
//   1. `agents.categories` (and the derived `agent_knowledge.products`)
//      defaulted from a NACE industry-code / harvest guess, never
//      corroborated against the producer's own website. Live examples: "Soli
//      Brug" (an art gallery/café) got category "fish" + product "Fisk";
//      "Tyholmen Kolonial" ("vi selger veldig lite lokal mat" — the
//      producer's own reply); "Øverland Andelslandbruk" (membership, not
//      sales); "Anikonic Cider" (fruktvin/rådgivning, not a cider house);
//      "Lillehammer Kaffebrenneri" (honey listed for a coffee roaster);
//      "Judiths Urtehage" (wrong categories); "Ystebakken" (products the
//      owner had since removed).
//   2. `agents.description` / `agent_knowledge.about` containing scraped
//      website boilerplate/navigation text instead of real content. Live
//      examples: "DalPro Gårdsmat" ("Meny Gårdsopplevelser Kurs
//      Industrikurs …" — literal nav-menu text) and "Smaken av Grimstad"
//      ("Lokalmat - Bransjeportalen for lokalmat … Stiftelsen Norsk Mat" — a
//      directory-site's own boilerplate).
//
// ── The dev-request's own spec has a factual error — corrected here ─────────
// Its routing section asks for the categories gate to use "samme mekanisme
// som held-for-reenrichment". That mechanism name DOES NOT EXIST anywhere in
// this codebase (grepped the whole src/ tree — zero matches). The real,
// analogous mechanism this codebase already has is the field-provenance /
// inference-only-factual-field guard family in cross-source-validator.ts
// (orchestrator-pr-16), consumed by the outreach-candidate suppression gate
// in admin-outreach-candidates.ts. That is what this dev-request actually
// extends — see categoriesLackWebsiteCorroboration in cross-source-
// validator.ts and the `suppressedForCategoriesNotCorroborated` check wired
// into GET /admin/outreach-candidates. THIS FILE is the read-only audit
// report (+ the opt-in boilerplate-description routing action); it never
// itself decides outreach eligibility — that decision lives entirely in the
// real gate above, which this file's GET report cross-checks against so the
// numbers are provably the same signal, not a parallel one.
//
// ── Detection: REUSES existing detectors, does not duplicate them ───────────
//   - Boilerplate description: isJunkDescription() (services/description-
//     quality.ts) — the existing render-time nav-boilerplate/junk detector
//     the dev-request itself points at. NOT classifyAboutCheapBar (the
//     retro-scan's own, separate, deterministic-garbage classifier a few
//     hundred lines up in admin-agents.ts) — that one exists for a narrower
//     purpose (retro-scan's LLM-judge cascade) and this dev-request names
//     isJunkDescription specifically.
//   - NACE-default-only categories: categoriesLackWebsiteCorroboration()
//     (cross-source-validator.ts) — the SAME predicate the real outreach
//     gate now consults (see above), so this report's counts are exactly
//     "how many rows the real gate is holding back for this reason", not an
//     independent estimate.
//
// ── Non-goals (dev-request's own, verbatim) ──────────────────────────────────
//   - No automatic deletion of rows.
//   - No automatic recategorization without corroboration — a human/CS still
//     resolves individual replies, same as before. This file NEVER writes to
//     `agents.categories` / `agent_knowledge.products`; it only REPORTS and,
//     via the real gate above, HOLDS such rows out of outreach.
//   - The ONLY write this file performs at all is the opt-in POST route
//     below, and even that only ever NULLS a confirmed-boilerplate
//     description/about value (routing the row back to re-enrichment) — it
//     never fabricates or guesses a replacement.
//
// ── Re-enrichment routing (boilerplate descriptions only) ───────────────────
// POST /admin/agents/category-description-provenance-audit/route-boilerplate-
// to-reenrichment reuses applyRfbRetroScanNull (exported from admin-agents.ts
// for exactly this purpose) — the SAME null + field_provenance-removal +
// agent_knowledge_audit write the RFB retro-scan already uses. Nulling
// `description` is the real "back to re-enrichment" trigger already built
// into this codebase: admin-agents.ts's brreg-description-fallback candidate
// set is `TRIM(description) = ''`, i.e. re-selecting empty descriptions for
// (re-)enrichment IS the existing re-enrichment queue for this field — not a
// new mechanism invented here. Dry-run by default (apply=1 / body.apply to
// write), admin-key-gated, and scoped to ONLY rows this route itself just
// flagged via isJunkDescription — it can never touch a row that passed the
// detector.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { isJunkDescription } from "../services/description-quality";
import { fieldLacksWebsiteCorroboration } from "../services/cross-source-validator";
import { applyRfbRetroScanNull } from "./admin-agents";

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

// Same RFB-producer scoping idiom as GET /admin/agents/category-sanity-report
// (admin-agents.ts): COALESCE(vertical_id, 'rfb') = 'rfb' AND role =
// 'producer' AND is_active = 1.
const RFB_PRODUCER_SCOPE_SQL = `
  WHERE COALESCE(a.vertical_id, 'rfb') = 'rfb'
    AND a.role = 'producer'
    AND a.is_active = 1
`;

interface AuditRow {
  id: string;
  name: string;
  org_nr: string | null;
  description: string | null;
  categories: string | null;
  products: string | null;
  about: string | null;
  field_provenance: string | null;
}

interface NaceDefaultExample {
  id: string;
  name: string;
  org_nr: string | null;
  categories: string[];
  products_also_uncorroborated: boolean;
}

interface BoilerplateExample {
  id: string;
  name: string;
  org_nr: string | null;
  field: "description" | "about";
  excerpt: string;
}

const EXAMPLE_LIMIT = 25;

function excerpt(text: string): string {
  const t = text.trim();
  return t.length > 160 ? t.slice(0, 160) + "…" : t;
}

/**
 * The scan + classify pass shared by GET / (report) and POST /route-
 * boilerplate-to-reenrichment (which needs the SAME boilerplate candidate
 * set the report just showed, not a second independent query).
 */
function runAudit(db: ReturnType<typeof getDb>): {
  scannedCount: number;
  naceDefaultOnly: { count: number; examples: NaceDefaultExample[] };
  boilerplateDescription: { count: number; examples: BoilerplateExample[] };
  boilerplateAgentIds: Array<{ id: string; field: "description" | "about" }>;
} {
  const rows = db
    .prepare(
      `SELECT a.id, a.name, a.org_nr, a.description, a.categories,
              k.products, k.about, k.field_provenance
         FROM agents a
         LEFT JOIN agent_knowledge k ON k.agent_id = a.id
         ${RFB_PRODUCER_SCOPE_SQL}`
    )
    .all() as AuditRow[];

  const naceExamples: NaceDefaultExample[] = [];
  let naceCount = 0;
  const boilerplateExamples: BoilerplateExample[] = [];
  const boilerplateAgentIds: Array<{ id: string; field: "description" | "about" }> = [];
  let boilerplateCount = 0;

  for (const row of rows) {
    // ── NACE-default-only categories/products ──────────────────────────────
    let categories: unknown;
    try {
      categories = row.categories ? JSON.parse(row.categories) : [];
    } catch {
      categories = [];
    }
    let fieldProv: unknown;
    try {
      fieldProv = row.field_provenance ? JSON.parse(row.field_provenance) : {};
    } catch {
      fieldProv = {};
    }
    const fieldProvObj: Record<string, unknown> =
      fieldProv && typeof fieldProv === "object" && !Array.isArray(fieldProv)
        ? (fieldProv as Record<string, unknown>)
        : {};

    const hasCategories = Array.isArray(categories) && categories.length > 0;
    const categoriesUncorroborated = fieldLacksWebsiteCorroboration(
      hasCategories,
      fieldProvObj.categories
    );

    let products: unknown;
    try {
      products = row.products ? JSON.parse(row.products) : [];
    } catch {
      products = [];
    }
    const hasProducts = Array.isArray(products) && products.length > 0;
    const productsUncorroborated = fieldLacksWebsiteCorroboration(hasProducts, fieldProvObj.products);

    if (categoriesUncorroborated) {
      naceCount++;
      if (naceExamples.length < EXAMPLE_LIMIT) {
        naceExamples.push({
          id: row.id,
          name: row.name,
          org_nr: row.org_nr,
          categories: hasCategories ? (categories as string[]) : [],
          products_also_uncorroborated: productsUncorroborated,
        });
      }
    }

    // ── Boilerplate description/about (reuses isJunkDescription as-is) ─────
    if (row.description && isJunkDescription(row.description)) {
      boilerplateCount++;
      boilerplateAgentIds.push({ id: row.id, field: "description" });
      if (boilerplateExamples.length < EXAMPLE_LIMIT) {
        boilerplateExamples.push({
          id: row.id,
          name: row.name,
          org_nr: row.org_nr,
          field: "description",
          excerpt: excerpt(row.description),
        });
      }
    }
    if (row.about && isJunkDescription(row.about)) {
      boilerplateCount++;
      boilerplateAgentIds.push({ id: row.id, field: "about" });
      if (boilerplateExamples.length < EXAMPLE_LIMIT) {
        boilerplateExamples.push({
          id: row.id,
          name: row.name,
          org_nr: row.org_nr,
          field: "about",
          excerpt: excerpt(row.about),
        });
      }
    }
  }

  return {
    scannedCount: rows.length,
    naceDefaultOnly: { count: naceCount, examples: naceExamples },
    boilerplateDescription: { count: boilerplateCount, examples: boilerplateExamples },
    boilerplateAgentIds,
  };
}

// ─── GET / — read-only report, never writes ──────────────────────────────────
router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDb();
    const audit = runAudit(db);
    res.json({
      success: true,
      scanned_count: audit.scannedCount,
      nace_default_only_categories: audit.naceDefaultOnly,
      boilerplate_description: audit.boilerplateDescription,
    });
  } catch (err) {
    console.error("[admin-agents] category-description-provenance-audit failed:", err);
    res.status(500).json({ success: false, error: "internal error" });
  }
});

// ─── POST /route-boilerplate-to-reenrichment — the ONE write this file does ──
// Dry-run by default (apply=1 in body or query turns writing on). Only ever
// touches rows THIS route's own isJunkDescription() pass just flagged — never
// a row outside that set, never the categories class (categories are gated,
// not mutated — see file header). limit caps how many rows are nulled in one
// call (default 25, hard-capped 100), same convention as the sibling sweep
// endpoints in this codebase (e.g. brreg-description-fallback).
router.post("/route-boilerplate-to-reenrichment", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDb();
    const body = (req.body || {}) as Record<string, unknown>;
    const apply = body.apply === true || body.apply === "true" || req.query.apply === "1" || req.query.apply === "true";

    let limit = 25;
    if (req.query.limit !== undefined) {
      const n = parseInt(String(req.query.limit), 10);
      if (Number.isFinite(n) && n >= 1) limit = Math.min(n, 100);
    }

    const audit = runAudit(db);
    const targets = audit.boilerplateAgentIds.slice(0, limit);

    const routed: Array<{ agent_id: string; field: "description" | "about" }> = [];
    if (apply) {
      // Group by agent_id — one agent can be flagged on both description and
      // about; applyRfbRetroScanNull takes the field LIST for a single row.
      const byAgent = new Map<string, Array<"description" | "about">>();
      for (const t of targets) {
        const list = byAgent.get(t.id) ?? [];
        list.push(t.field);
        byAgent.set(t.id, list);
      }
      for (const [agentId, fields] of byAgent) {
        const reasons: Record<string, string> = {};
        for (const f of fields) {
          reasons[f] =
            "category-description-provenance-audit: boilerplate/nav-junk content (isJunkDescription)";
        }
        const written = applyRfbRetroScanNull(db, agentId, fields, reasons);
        for (const f of written) routed.push({ agent_id: agentId, field: f as "description" | "about" });
      }
    }

    res.json({
      success: true,
      dry_run: !apply,
      candidate_count: targets.length,
      candidates: targets,
      routed_to_reenrichment: routed,
    });
  } catch (err) {
    console.error("[admin-agents] route-boilerplate-to-reenrichment failed:", err);
    res.status(500).json({ success: false, error: "internal error" });
  }
});

export default router;
