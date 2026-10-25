// ─── Admin: business-type marker + retail classification dry-run ───────────
// dev-request 2026-10-01-rfb-butikker-i-outreach-poolen (changes 1 + 3).
//
//   POST /admin/agents/business-type
//     Sets or clears agents.business_type / agents.retail_focus for EXPLICIT
//     agentIds. Dry-run by DEFAULT (`apply` must be an explicit truthy form).
//     One agent_knowledge_audit row per changed column per agent (old/new
//     value, changed_by 'admin'). Never classifies anything itself — it only
//     executes a decision the caller already made. No bulk/automatic mode.
//       body: { agentIds: string[], business_type: 'producer'|'farm_shop'|
//               'retail_shop'|'cafe'|null (null clears), retail_focus?:
//               'frukt_gront'|'fisk'|'annet', reason: string, apply?: bool }
//     retail_focus is REQUIRED for 'retail_shop' and must be absent otherwise.
//     Rollback: call again with business_type:null (or restore from the audit
//     rows' old_value).
//
//   GET /admin/agents/business-type/classification-dryrun
//     READ-ONLY candidate list for Daniel's review (never writes, never marks).
//     Cohort: active, non-umbrella, unmarked agents that are in the outreach
//     pool (scope=pool) or not yet sent through RFB outreach (scope=uncontacted,
//     default; includes the pool). Signals: name + about keywords. Sorted by
//     confidence, highest first. `gardsbutikk` hints lower the confidence — a
//     producer-run farm shop must NOT be marked retail_shop.
//
// Auth: X-Admin-Key (local requireAdmin convention, same as sibling routes).

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../database/init";

const router = Router();

let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;
/** Test-only. Pass null to clear. */
export function __setBusinessTypeDbForTesting(db: ReturnType<typeof getDb> | null): void {
  dbOverrideForTesting = db;
}
function resolveDb(): ReturnType<typeof getDb> {
  return dbOverrideForTesting ?? getDb();
}

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

export const BUSINESS_TYPES = ["producer", "farm_shop", "retail_shop", "cafe"] as const;
export const RETAIL_FOCUSES = ["frukt_gront", "fisk", "annet"] as const;
export const BUSINESS_TYPE_MAX_AGENTS = 50;
export const CLASSIFICATION_DRYRUN_MAX_LIMIT = 500;

type Outcome = "would_set" | "set" | "unchanged" | "not_found" | "error";

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const apply =
    body.apply === true || body.apply === 1 || body.apply === "1" || body.apply === "true" ||
    req.query?.apply === "1" || req.query?.apply === "true";

  const ids = Array.isArray(body.agentIds)
    ? Array.from(new Set((body.agentIds as unknown[]).filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean)))
    : [];
  if (ids.length === 0 || ids.length > BUSINESS_TYPE_MAX_AGENTS) {
    res.status(400).json({ error: `agentIds må være en liste med 1–${BUSINESS_TYPE_MAX_AGENTS} eksplisitte agent-IDer` });
    return;
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    res.status(400).json({ error: "reason er påkrevd" });
    return;
  }
  const bt = body.business_type;
  if (bt !== null && !(typeof bt === "string" && (BUSINESS_TYPES as readonly string[]).includes(bt))) {
    res.status(400).json({ error: `business_type må være en av ${BUSINESS_TYPES.join(", ")} eller null (fjerner merket)` });
    return;
  }
  const rf = body.retail_focus ?? null;
  if (rf !== null && !(typeof rf === "string" && (RETAIL_FOCUSES as readonly string[]).includes(rf))) {
    res.status(400).json({ error: `retail_focus må være en av ${RETAIL_FOCUSES.join(", ")}` });
    return;
  }
  if (bt === "retail_shop" && rf === null) {
    res.status(400).json({ error: "retail_focus er påkrevd for business_type=retail_shop" });
    return;
  }
  if (bt !== "retail_shop" && rf !== null) {
    res.status(400).json({ error: "retail_focus kan bare settes sammen med business_type=retail_shop" });
    return;
  }

  const newType = bt as string | null;
  const newFocus = rf as string | null;
  const db = resolveDb();
  const batchTag = `business-type-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
  const results: Array<{ id: string; outcome: Outcome; old?: { business_type: string | null; retail_focus: string | null }; detail?: string }> = [];

  const sel = db.prepare(`SELECT business_type, retail_focus FROM agents WHERE id = ?`);
  for (const id of ids) {
    try {
      const cur = sel.get(id) as { business_type: string | null; retail_focus: string | null } | undefined;
      if (!cur) { results.push({ id, outcome: "not_found" }); continue; }
      const old = { business_type: cur.business_type ?? null, retail_focus: cur.retail_focus ?? null };
      if (old.business_type === newType && old.retail_focus === newFocus) {
        results.push({ id, outcome: "unchanged", old });
        continue;
      }
      if (!apply) { results.push({ id, outcome: "would_set", old }); continue; }
      db.transaction(() => {
        db.prepare(`UPDATE agents SET business_type = ?, retail_focus = ? WHERE id = ?`).run(newType, newFocus, id);
        const audit = db.prepare(
          `INSERT INTO agent_knowledge_audit
             (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
           VALUES (?, ?, ?, ?, ?, 'admin', NULL, datetime('now'), ?)`,
        );
        if (old.business_type !== newType) audit.run(randomUUID(), id, "business_type", old.business_type, newType, `${batchTag}: ${reason}`);
        if (old.retail_focus !== newFocus) audit.run(randomUUID(), id, "retail_focus", old.retail_focus, newFocus, `${batchTag}: ${reason}`);
      })();
      results.push({ id, outcome: "set", old });
    } catch (e: any) {
      results.push({ id, outcome: "error", detail: e?.message ?? String(e) });
    }
  }

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});
  res.json({ success: true, dry_run: !apply, batch_tag: batchTag, business_type: newType, retail_focus: newFocus, counts, results });
});

// ── Change 3: classification dry-run (READ-ONLY) ────────────────────────────

const NAME_SIGNALS: Array<[string, number]> = [
  ["nettbutikk", 0.5], ["kolonial", 0.6], ["dagligvare", 0.6], ["butikk", 0.45],
  ["kafé", 0.4], ["kafe", 0.4], ["café", 0.4], ["supermarked", 0.6],
];
const ABOUT_SIGNALS: Array<[string, number]> = [
  ["nettbutikk", 0.25], ["kolonial", 0.3], ["dagligvare", 0.3], ["butikk", 0.2],
  ["kafé", 0.2], ["kafe", 0.2], ["café", 0.2],
];
const FARM_SHOP_HINTS = ["gårdsbutikk", "gardsbutikk", "gårdsutsalg", "gardsutsalg"];

export function classifyRetailSignals(row: { name?: string | null; about?: string | null; categories?: string | null }): {
  confidence: number;
  signals: string[];
  farm_shop_hint: boolean;
  suggested_business_type: "retail_shop" | "cafe" | null;
} {
  const name = (row.name ?? "").toLowerCase();
  const about = (row.about ?? "").toLowerCase();
  const cats = (row.categories ?? "").toLowerCase();
  const signals: string[] = [];
  let score = 0;
  for (const [kw, w] of NAME_SIGNALS) if (name.includes(kw)) { signals.push(`name:${kw}`); score += w; }
  for (const [kw, w] of ABOUT_SIGNALS) if (about.includes(kw)) { signals.push(`about:${kw}`); score += w; }
  for (const [kw] of ABOUT_SIGNALS) if (cats.includes(kw)) { signals.push(`category:${kw}`); score += 0.1; }
  const farmHint = FARM_SHOP_HINTS.some((h) => name.includes(h) || about.includes(h));
  if (farmHint) score -= 0.3;
  const confidence = Math.max(0, Math.min(1, Math.round(score * 100) / 100));
  const cafeOnly = signals.length > 0 && signals.every((s) => /kaf[eé]|café/.test(s));
  return { confidence, signals, farm_shop_hint: farmHint, suggested_business_type: signals.length === 0 ? null : cafeOnly ? "cafe" : "retail_shop" };
}

router.get("/classification-dryrun", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const scope = req.query.scope === "pool" ? "pool" : "uncontacted";
  const limitRaw = parseInt(String(req.query.limit ?? ""), 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, CLASSIFICATION_DRYRUN_MAX_LIMIT) : 200;
  const db = resolveDb();
  const cohortSql =
    scope === "pool"
      ? `a.id IN (SELECT agent_id FROM outreach_ready_pool)`
      : `NOT EXISTS (SELECT 1 FROM outreach_sent_log o WHERE o.vertical_id = 'rfb' AND o.agent_id = a.id)`;
  const rows = db.prepare(
    `SELECT a.id AS agent_id, a.name AS name, k.about AS about, a.categories AS categories,
            EXISTS(SELECT 1 FROM outreach_ready_pool p WHERE p.agent_id = a.id) AS in_pool
       FROM agents a
       LEFT JOIN agent_knowledge k ON k.agent_id = a.id
      WHERE a.is_active = 1 AND a.umbrella_type IS NULL AND a.business_type IS NULL
        AND ${cohortSql}`,
  ).all() as Array<{ agent_id: string; name: string | null; about: string | null; categories: string | null; in_pool: number }>;

  const candidates = rows
    .map((r) => ({ agent_id: r.agent_id, name: r.name, in_pool: r.in_pool === 1, ...classifyRetailSignals(r) }))
    .filter((c) => c.signals.length > 0)
    .sort((a, b) => b.confidence - a.confidence || String(a.name).localeCompare(String(b.name)))
    .slice(0, limit);

  res.json({
    success: true,
    read_only: true,
    scope,
    scanned: rows.length,
    returned: candidates.length,
    note: "Forslag til gjennomgang. Ingenting er merket. Merking skjer bare via POST /admin/agents/business-type med eksplisitte agentIds.",
    candidates,
  });
});

export default router;
