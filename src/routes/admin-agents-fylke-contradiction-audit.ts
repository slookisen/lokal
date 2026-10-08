// ─── Admin: GET /admin/agents/fylke-contradiction-audit ─────────────────────
//
// dev-request 2026-10-06-rfb-brreg-navnetreff-feil-adresse, Mål 1 (read-only
// revisjon). Snill Bie (Bømlo) had the address of an unrelated Brreg company
// in Fåberg written onto it through a plain name hit. Mål 3 (the guard,
// lokal#998) stops new cases; this report finds the existing ones.
//
// For every active RFB producer it resolves the fylke each place signal points
// to and lists the rows where at least two signals disagree:
//   - name_suffix: the trailing place in the name ("Snill Bie — Bømlo")
//   - city:        agents.city
// Each flagged row carries the sources that delivered the address
// (agent_knowledge.auto_sources + field_provenance keys for address/postal
// code), the org.nr, and the postal code, so a human can decide per row.
// Signals that cannot be resolved to a fylke are never counted as a
// contradiction; such rows are only counted (`unresolved_signal_rows`).
//
// Read-only: no writes anywhere. Fixing rows is Mål 2 and stays a separate,
// per-row, sourced step. Postal-code and geocoded-point signals, and the Brreg
// kommune for rows with an org.nr, are not part of this slice (no postnr→fylke
// table exists yet — see the dev-request's FUNN block).

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { cityToFylke, fylkerMatch, normaliseFylke } from "../services/norway-fylke";
import { parseNameLocationSuffix } from "../services/location-suffix-parser";

const router = Router();

function requireAdmin(req: Request, res: Response): boolean {
  const expected = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  if (((req.headers["x-admin-key"] as string) || "") !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

export interface FylkeSignals {
  name: string | null;
  city: string | null;
}

export interface FylkeVerdict {
  nameSuffixFylke: string | null;
  cityFylke: string | null;
  /** "contradiction" only when both signals resolve and the fylker differ. */
  status: "contradiction" | "agree" | "unresolved";
}

/** PURE: resolve each place signal to a fylke and compare. */
export function classifyFylkeSignals(s: FylkeSignals): FylkeVerdict {
  const hint = parseNameLocationSuffix(s.name).location_hint;
  const nameSuffixFylke = hint ? (cityToFylke(hint) ?? normaliseFylke(hint)) : null;
  const cityFylke = cityToFylke(s.city);
  if (nameSuffixFylke && cityFylke) {
    return {
      nameSuffixFylke,
      cityFylke,
      status: fylkerMatch(nameSuffixFylke, cityFylke) ? "agree" : "contradiction",
    };
  }
  return { nameSuffixFylke, cityFylke, status: "unresolved" };
}

interface Row {
  id: string;
  name: string;
  city: string | null;
  org_nr: string | null;
  postal_code: string | null;
  address: string | null;
  auto_sources: string | null;
  field_provenance: string | null;
}

const ROW_LIMIT_DEFAULT = 200;
const ROW_LIMIT_MAX = 1000;

function provenanceSources(raw: string | null, field: string): string[] {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    const v = p && typeof p === "object" ? (p as Record<string, unknown>)[field] : null;
    const list = Array.isArray(v) ? v : v ? [v] : [];
    return list
      .map((x) => (x && typeof x === "object" ? String((x as any).source_type ?? "") : ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    let limit = ROW_LIMIT_DEFAULT;
    if (req.query.limit !== undefined) {
      const n = parseInt(String(req.query.limit), 10);
      if (Number.isFinite(n) && n >= 1) limit = Math.min(n, ROW_LIMIT_MAX);
    }
    const rows = getDb()
      .prepare(
        `SELECT a.id, a.name, a.city, a.org_nr,
                k.postal_code, k.address, k.auto_sources, k.field_provenance
           FROM agents a
           LEFT JOIN agent_knowledge k ON k.agent_id = a.id
          WHERE COALESCE(a.vertical_id, 'rfb') = 'rfb'
            AND a.role = 'producer'
            AND a.is_active = 1`,
      )
      .all() as Row[];

    let agree = 0;
    let unresolved = 0;
    const flagged: Array<Record<string, unknown>> = [];
    let contradictionCount = 0;
    for (const r of rows) {
      const v = classifyFylkeSignals({ name: r.name, city: r.city });
      if (v.status === "agree") agree++;
      else if (v.status === "unresolved") unresolved++;
      else {
        contradictionCount++;
        if (flagged.length < limit) {
          let autoSources: unknown = [];
          try { autoSources = r.auto_sources ? JSON.parse(r.auto_sources) : []; } catch { /* keep [] */ }
          flagged.push({
            id: r.id,
            name: r.name,
            city: r.city,
            org_nr: r.org_nr,
            postal_code: r.postal_code,
            address: r.address,
            name_suffix_fylke: v.nameSuffixFylke,
            city_fylke: v.cityFylke,
            auto_sources: autoSources,
            address_provenance: provenanceSources(r.field_provenance, "address"),
            postal_code_provenance: provenanceSources(r.field_provenance, "postal_code"),
          });
        }
      }
    }

    res.json({
      success: true,
      scanned_count: rows.length,
      agree_count: agree,
      unresolved_signal_rows: unresolved,
      contradiction_count: contradictionCount,
      returned: flagged.length,
      contradictions: flagged,
    });
  } catch (err) {
    console.error("[admin-agents] fylke-contradiction-audit failed:", err);
    res.status(500).json({ success: false, error: "internal error" });
  }
});

export default router;
