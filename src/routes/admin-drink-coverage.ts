// ─── GET /admin/agents/drink-coverage ─────────────────────────────────
//
// dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 5c:
// «Datadekning måles og rapporteres (hvor mange drikkesteder finnes faktisk
// per fylke).» — a read-only measurement of how many RFB producers actually
// qualify as drink venues, broken down by the six canonical drink-taxonomy.ts
// subcategories.
//
// Per-FYLKE, not per-city: RFB's `agents` table has no fylke/kommune column
// (only free-text `city` — see route-corridor-service.ts's own honesty-rule
// header and the dev-request's own "Datagrunnlag" section, which documents
// this exact gap). Claiming a fylke breakdown here would repeat the Fase-0
// mistake this whole dev-request exists to fix: a geo claim the data cannot
// back up. This report is grouped by `city` instead — the true granularity
// the table has — and says so in the response (`grouped_by: "city"`), rather
// than fabricating fylke buckets from unreliable text.
//
// Read-only — a single SELECT, no writes. Same requireAdmin convention as
// every other admin-*.ts file (X-Admin-Key header).
import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { DRINK_CATEGORIES } from "../services/route-corridor-service";
import { DRINK_SUBCATEGORIES, classifyDrinkSubcategoryFromText, type DrinkSubcategory } from "../services/drink-taxonomy";

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

interface Row {
  id: string;
  name: string;
  description: string | null;
  city: string | null;
  categories: string | null;
}

router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const db = getDb();
  let rows: Row[] = [];
  try {
    rows = db
      .prepare(
        `SELECT id, name, description, city, categories
           FROM agents
          WHERE is_active = 1
            AND role = 'producer'
            AND umbrella_type IS NULL`,
      )
      .all() as Row[];
  } catch (err: any) {
    res.status(500).json({ error: "drink-coverage query failed", detail: err.message });
    return;
  }

  let scanned = 0;
  let drinkTotal = 0;
  const bySubcategory: Record<DrinkSubcategory | "unclassified", number> = {
    bryggeri: 0, cideri: 0, vingård: 0, destilleri: 0, gårdskafé: 0, mjød: 0, unclassified: 0,
  };
  // city -> { total, bySubcategory }
  const byCity = new Map<string, { total: number; bySubcategory: Record<string, number> }>();

  for (const r of rows) {
    scanned++;
    let categories: string[] = [];
    try {
      categories = r.categories ? JSON.parse(r.categories) : [];
    } catch {
      categories = [];
    }
    const isDrink = categories.some((c) => DRINK_CATEGORIES.has(String(c || "").toLowerCase()));
    if (!isDrink) continue;

    drinkTotal++;
    const sub = classifyDrinkSubcategoryFromText(`${r.name} ${r.description ?? ""}`);
    bySubcategory[sub ?? "unclassified"]++;

    const cityKey = (r.city || "").trim() || "(ukjent by)";
    let cityBucket = byCity.get(cityKey);
    if (!cityBucket) {
      cityBucket = { total: 0, bySubcategory: {} };
      byCity.set(cityKey, cityBucket);
    }
    cityBucket.total++;
    const subKey = sub ?? "unclassified";
    cityBucket.bySubcategory[subKey] = (cityBucket.bySubcategory[subKey] || 0) + 1;
  }

  const cities = Array.from(byCity.entries())
    .map(([city, v]) => ({ city, total: v.total, by_subcategory: v.bySubcategory }))
    .sort((a, b) => b.total - a.total || a.city.localeCompare(b.city, "nb-NO"));

  res.json({
    success: true,
    // Honest about what this measures and at what granularity — see the
    // header comment on why this is `city`, not `fylke`.
    grouped_by: "city",
    subcategories: DRINK_SUBCATEGORIES,
    scanned_producers: scanned,
    drink_producers: drinkTotal,
    by_subcategory: bySubcategory,
    by_city: cities,
  });
});

export default router;
