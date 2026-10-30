// ─── Admin: GET /admin/agents/facebook-tier-shadow ──────────────────────────
//
// Enrichment-kadens S1a (read-only shadow measurement). Planned rule change
// (S1b, not built here): `facebook_official_page` counts only as evidence that
// the producer exists, never as corroboration for `address` or `phone`. This
// report says how many RFB profiles would lose today's agreed result on each
// field, and on the aggregate verdict, if those records were ignored.
//
// The per-profile math is computeFacebookTierShadow (services/facebook-tier-
// shadow.ts), which calls the production crossSourceAgreement/aggregateVerdict
// exactly as the verifier does. This route only SELECTs and counts.
//
// Scope: the verifier's own scope (RFB_VERIFIER_SCOPE_SQL — non-umbrella RFB
// agents), minus opt_out / terminal_unconfirmable rows (which the verifier's
// pickers also skip), and only rows with a non-empty field_provenance.
//
// Read-only: no writes anywhere.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { RFB_VERIFIER_SCOPE_SQL } from "../agents/lokal-agent-verifier";
import {
  computeFacebookTierShadow,
  SHADOW_EXCLUDED_SOURCE_TYPE,
  SHADOW_FIELDS,
  type ShadowField,
} from "../services/facebook-tier-shadow";
import type { CrossSourceVerdict } from "../services/cross-source-validator";
import { slugify } from "../utils/slug";

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

const EXAMPLES_PER_FIELD = 3;

// Other verticals: checked by grep, not assumed (S1a task). Neither calls
// crossSourceAgreement() or tierForSource().
export const OTHER_VERTICALS = {
  gardssalg: {
    uses_validator: false,
    reason:
      "Opplevagent gårdssalg uses computeGardssalgSecondLineVerification (routes/opplevelser.ts) -> " +
      "computeSecondLineIdentitySources (agents/lokal-agent-verifier.ts), where facebook_official_page " +
      "is only an identity (exists) signal; no crossSourceAgreement/tierForSource call.",
  },
  dental: {
    uses_validator: false,
    reason:
      "Dental uses computeDentalVerifiedRule / resolveVerifiedClaim (services/dental-verified-claim.ts) " +
      "on brreg_status, website_ownership, catalog_class and directory_url; from cross-source-validator " +
      "it only imports coerceProvenanceToArrayShape and buildProvenanceSummary.",
  },
} as const;

interface Row {
  id: string;
  name: string | null;
  verification_status: string | null;
  field_provenance: string | null;
}

interface FieldStats {
  evaluated: number;
  with_records: number;
  has_facebook_record: number;
  agree_now: number;
  agree_shadow: number;
  would_lose: number;
  examples: Array<Record<string, unknown>>;
}

function parseProvenance(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const rows = getDb()
      .prepare(
        `SELECT a.id, a.name, k.verification_status, k.field_provenance
           FROM agents a
     INNER JOIN agent_knowledge k ON k.agent_id = a.id
          WHERE ${RFB_VERIFIER_SCOPE_SQL}
            AND k.verification_status NOT IN ('opt_out', 'terminal_unconfirmable')
            AND k.field_provenance IS NOT NULL
            AND k.field_provenance <> '{}'`,
      )
      .all() as Row[];

    const fields = {} as Record<ShadowField, FieldStats>;
    for (const f of SHADOW_FIELDS) {
      fields[f] = {
        evaluated: 0,
        with_records: 0,
        has_facebook_record: 0,
        agree_now: 0,
        agree_shadow: 0,
        would_lose: 0,
        examples: [],
      };
    }
    let unparseable = 0;
    let poolNow = 0;
    let poolShadow = 0;
    let aggLose = 0;
    const aggLoseTo: Partial<Record<CrossSourceVerdict, number>> = {};
    const aggExamples: Array<Record<string, unknown>> = [];

    for (const r of rows) {
      const prov = parseProvenance(r.field_provenance);
      if (!prov) {
        unparseable++;
        continue;
      }
      const s = computeFacebookTierShadow(prov, { ownName: r.name });
      const ident = { agent_id: r.id, name: r.name, slug: r.name ? slugify(r.name) : null };
      for (const f of SHADOW_FIELDS) {
        const st = fields[f];
        const fr = s.fields[f];
        st.evaluated++;
        if (fr.now.sources_used.length > 0) st.with_records++;
        if (fr.has_facebook_record) st.has_facebook_record++;
        if (fr.now.agree && fr.now.verdict === "pool_eligible") st.agree_now++;
        if (fr.shadow.agree && fr.shadow.verdict === "pool_eligible") st.agree_shadow++;
        if (fr.would_lose) {
          st.would_lose++;
          if (st.examples.length < EXAMPLES_PER_FIELD) {
            st.examples.push({
              ...ident,
              sources_used_now: fr.now.sources_used,
              shadow_verdict: fr.shadow.verdict,
            });
          }
        }
      }
      if (s.aggregate_now === "pool_eligible") poolNow++;
      if (s.aggregate_shadow === "pool_eligible") poolShadow++;
      if (s.aggregate_would_lose) {
        aggLose++;
        aggLoseTo[s.aggregate_shadow] = (aggLoseTo[s.aggregate_shadow] ?? 0) + 1;
        if (aggExamples.length < EXAMPLES_PER_FIELD) {
          aggExamples.push({
            ...ident,
            verification_status: r.verification_status,
            address_sources_used_now: s.fields.address.now.sources_used,
            shadow_verdict: s.aggregate_shadow,
          });
        }
      }
    }

    res.json({
      success: true,
      read_only: true,
      excluded_source_type: SHADOW_EXCLUDED_SOURCE_TYPE,
      fields_measured: SHADOW_FIELDS,
      scanned_count: rows.length,
      unparseable_provenance: unparseable,
      rfb: {
        uses_validator: true,
        fields,
        aggregate: {
          gating_fields: ["address"],
          pool_eligible_now: poolNow,
          pool_eligible_shadow: poolShadow,
          would_lose: aggLose,
          would_lose_to: aggLoseTo,
          examples: aggExamples,
        },
      },
      gardssalg: OTHER_VERTICALS.gardssalg,
      dental: OTHER_VERTICALS.dental,
    });
  } catch (err) {
    console.error("[admin-agents] facebook-tier-shadow failed:", err);
    res.status(500).json({ success: false, error: "internal error" });
  }
});

export default router;
