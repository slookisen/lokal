// ─── Admin: POST /admin/agents/products-tab-cleanup ────────────────────────
//
// Dev-request 2026-11-10-rfb-bakke-rydding-dublett-og-innlimte-varer, S2.
// A producer pasted a spreadsheet into its product list: agent_knowledge.
// products holds one header row and 33 products where the WHOLE tab-separated
// row sits in `name` («Solbærsyltetøy\tSyltetøy\t95 kr\tIkke oppgitt»), the
// price is empty and the category is often wrong. PUT /admin/knowledge has no
// dry run, so this is the honest, previewable, audited lever for that one
// defect. ONE profile per call.
//
// In short: a split price is stored as TEXT «kr 95» + priceUnit "kr" (the
// ProductInfo.price string form, not the number 95), and the apply also
// renames / retires the matching rows of the `products` catalog table
// (only this agent's rows; a referenced row is set out_of_stock, never
// deleted) — both detailed below.
//
// Body: { agent_id: string, apply?: boolean }  (?apply=1|true also applies —
// isExplicitApply, shared with duplicate-merge). Dry run by default; a dry
// run writes nothing.
//
// What it does to `products` (a JSON array of ProductInfo objects, see
// services/knowledge-service.ts), in planProductsTabCleanup():
//   - Only OBJECT entries whose string `name` contains a TAB are touched
//     ("tab rows"). Every other entry (objects without a tab, plain-string
//     entries, malformed entries) is kept byte-identical (same JSON) and in
//     its original position.
//   - Columns: by default cell 0 = name, 1 = category, 2 = price,
//     3 = availability. When a header row is present its cells decide the
//     columns instead (produkt/navn → name, kategori → category, pris →
//     price, tilgjengelighet / sesong → availability, whose meaningful
//     value goes to `note` — see «Availability» under split below).
//   - removed_header: a tab row with >= 2 non-empty cells that are ALL known
//     column-header words (HEADER_WORDS).
//   - removed_alcohol: the raw row matches ALCOHOL_RE (cognac, aquavit,
//     akevitt, akvavit — case-insensitive, also inside a word: «Aquavitgelé»,
//     «Kirsebærgelé med Cognac»). Only tab rows: a non-tab row is never
//     changed by this route (they are listed in `non_tab_alcohol_rows` for
//     the caller to see, nothing more).
//   - removed_duplicate: the cleaned name equals (normalizeName — case and
//     whitespace) a non-tab row's name, or an earlier tab row's cleaned name.
//     The existing row is kept, the tab row is dropped (e.g. an existing
//     summary row «Groviser (håndlaget)»).
//   - split: name = the name cell; category = CATEGORY_MAP of the category
//     cell (Syltetøy/Gelé → preserves, Bakst/Kjeks → bakery, Spekemat →
//     meat; all three are PLATFORM_CATEGORIES in services/search-enrich.ts),
//     unknown cell → the row's existing category; price: «95 kr» / «kr 95» /
//     «95,-» / «120 kr/kg» → price "kr 95" + priceUnit "kr". The price is
//     stored as TEXT in the same «kr N[/unit]» form normalizeProducts() and
//     owner-import formatPrice() store (ProductInfo.price is a string; the
//     public profile prints the price text and hides priceUnit "kr", so a
//     bare number 95 would show as «95» without «kr»). An unparseable price
//     («Ikke oppgitt») leaves the price as it was (empty), and a row that
//     already has a price keeps it. Availability: ProductInfo has no
//     availability field; a meaningful cell goes to `note` (the free-text
//     field the type documents as «Kun i sesong (juni-september)») when the
//     row has no note, and «Ikke oppgitt» / «-» / empty is dropped. Extra
//     cells beyond the known columns are dropped. Every dropped cell is
//     listed per row (`dropped_cells`). All other fields of the row (seasonal,
//     organic, source, …) are kept.
//   - skipped_unparseable: a tab row whose name cell is empty is kept as it
//     is and reported.
//
// Locks: `products` in agent_knowledge.curated_fields (a JSON object keyed
// by column name, set by the producer in the owner portal) → outcome
// skipped_curated, reason products_locked, nothing written — on apply too.
// The OWNER lock (claimed_at / verified claim) does NOT stop this route: the
// profile this was built for is owner-verified and the cleanup is the
// dev-request's explicit decision; the response reports `owner_locked` so the
// caller sees it. No enrichment write-pause gate: this is a one-shot,
// admin-key correction a person runs, not an enrichment write surface (the
// pause's importer set is pinned by enrichment-write-pause test ewp-125).
//
// Apply: one transaction that RE-READS agent_knowledge (products +
// curated_fields) inside it, re-plans, writes the new products array and
// one agent_knowledge_audit row (field_name products, changed_by admin, the
// full OLD stored text in old_value — revert = write old_value back).
//
// Catalog (`products` table, UNIQUE(agent_id, name_norm), filled from
// agent_knowledge.products by product-catalog-sync.ts, which only upserts):
// left alone the tab rows' catalog rows (keyed by the whole tab line) would
// stay listed forever, the alcohol rows included. So in the same transaction,
// per changed tab row, located by the sync's own key
// (normalizeName(parseProductPrice(entry).cleanName)) — same rules as
// content-correction's product_name rename:
//   - no catalog row for the old key → "none";
//   - split, and no row for the new key yet → "rename_in_place" (id kept, so
//     cart references still resolve; the next sync updates price/category);
//   - removed rows, or a split whose new key already has a row → retire:
//     "retire_delete" when no cart_items / cart_wishes reference the id, else
//     "retire_out_of_stock".
// Reported per row (dry run too) and in the audit notes with the full old
// catalog row, so it can be rolled back.

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import { isExplicitApply } from "./admin-agents-duplicate-merge";
import { isProductHeader, isProductNoise, parseProductPrice } from "../services/knowledge-service";
import { normalizeName } from "../services/product-catalog-sync";

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

let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;
export function __setProductsTabCleanupDbForTesting(db: ReturnType<typeof getDb> | null): void {
  dbOverrideForTesting = db;
}
function db_(): ReturnType<typeof getDb> {
  return dbOverrideForTesting ?? getDb();
}

export const PRODUCTS_TAB_CLEANUP_MAX_AGENT_ID = 200;

// ─── Pure planning ─────────────────────────────────────────────────────────

/** Alcohol in a product name (Daniel 2026-11-10: the two alcohol jellies go). */
export const ALCOHOL_RE = /cognac|aquavit|akevitt|akvavit/i;

/** Pasted category cell → platform category (PLATFORM_CATEGORIES). */
export const CATEGORY_MAP: Readonly<Record<string, string>> = {
  "syltetøy": "preserves",
  "gelé": "preserves",
  "gele": "preserves",
  "bakst": "bakery",
  "kjeks": "bakery",
  "spekemat": "meat",
};

type Column = "name" | "category" | "price" | "availability";

/** Column-header words → the column they name. */
const HEADER_WORDS: Readonly<Record<string, Column | null>> = {
  produkt: "name", produkter: "name", produktnavn: "name", navn: "name", vare: "name", varer: "name", varenavn: "name",
  kategori: "category", type: "category",
  pris: "price", "pris (kr)": "price", "pris kr": "price",
  tilgjengelighet: "availability", tilgjengelig: "availability",
  sesong: "availability", sesonger: "availability", sesongvare: "availability",
  enhet: null, beskrivelse: null, merknad: null, kommentar: null,
};

/** Cell values that say nothing (dropped, never stored). */
const EMPTY_CELLS = new Set(["", "-", "–", "—", "ikke oppgitt", "ukjent", "n/a"]);

const DEFAULT_COLUMNS: Readonly<Record<Column, number>> = { name: 0, category: 1, price: 2, availability: 3 };

function cellKey(cell: string): string {
  return cell.trim().toLowerCase().replace(/:$/, "").replace(/\s+/g, " ");
}

function splitCells(name: string): string[] {
  return name.split("\t").map((c) => c.trim());
}

function isHeaderCells(cells: string[]): boolean {
  const nonEmpty = cells.filter((c) => c !== "");
  return nonEmpty.length >= 2 && nonEmpty.every((c) => Object.prototype.hasOwnProperty.call(HEADER_WORDS, cellKey(c)));
}

/** «95 kr» / «kr 95» / «95,-» / «120 kr/kg» → "kr 95" / "kr 120/kg"; else null. */
export function parsePriceCell(cell: string): string | null {
  const m = cell.trim().match(/^(?:kr\.?\s*)?(\d{1,6}(?:[.,]\d{1,2})?)\s*(?:kr\.?|nok|,-)?\s*(?:\/\s*([a-zæøå.]+))?$/i);
  if (!m) return null;
  if (!(parseFloat(m[1].replace(",", ".")) > 0)) return null;
  return `kr ${m[1]}${m[2] ? `/${m[2]}` : ""}`;
}

type RowAction = "split" | "removed_header" | "removed_alcohol" | "removed_duplicate" | "skipped_unparseable";

export interface RowChange {
  index: number;
  action: RowAction;
  before: unknown;
  after?: unknown;
  dropped_cells?: string[];
  detail?: string;
  catalog?: CatalogEffect;
}

export interface CleanupPlan {
  products: unknown[];
  changes: RowChange[];
  tab_rows: number;
  unchanged: number;
  non_tab_alcohol_rows: string[];
}

function isObj(p: unknown): p is Record<string, unknown> {
  return !!p && typeof p === "object" && !Array.isArray(p);
}

function isTabRow(p: unknown): p is Record<string, unknown> & { name: string } {
  return isObj(p) && typeof p.name === "string" && p.name.includes("\t");
}

function priceIsEmpty(price: unknown): boolean {
  if (price === undefined || price === null) return true;
  if (typeof price === "string") return price.trim() === "";
  return false;
}

/** Pure: the cleaned products array and what happened to each tab row. */
export function planProductsTabCleanup(products: unknown[]): CleanupPlan {
  // Column layout: from the (first) header row when there is one.
  let columns: Record<Column, number> = { ...DEFAULT_COLUMNS };
  for (const p of products) {
    if (!isTabRow(p)) continue;
    const cells = splitCells(p.name);
    if (!isHeaderCells(cells)) continue;
    const found: Partial<Record<Column, number>> = {};
    cells.forEach((c, i) => {
      const col = HEADER_WORDS[cellKey(c)];
      if (col && found[col] === undefined) found[col] = i;
    });
    if (found.name !== undefined) columns = { ...DEFAULT_COLUMNS, ...found } as Record<Column, number>;
    break;
  }
  const known = new Set(Object.values(columns));

  const nonTabNames = new Set<string>();
  const nonTabAlcohol: string[] = [];
  for (const p of products) {
    if (isTabRow(p)) continue;
    const n = typeof p === "string" ? p : isObj(p) && typeof p.name === "string" ? p.name : "";
    if (!n) continue;
    nonTabNames.add(normalizeName(n));
    if (ALCOHOL_RE.test(n)) nonTabAlcohol.push(n);
  }

  const out: unknown[] = [];
  const changes: RowChange[] = [];
  const seenSplit = new Set<string>();
  let tabRows = 0;

  products.forEach((p, index) => {
    if (!isTabRow(p)) {
      out.push(p);
      return;
    }
    tabRows++;
    const cells = splitCells(p.name);
    if (isHeaderCells(cells)) {
      changes.push({ index, action: "removed_header", before: p });
      return;
    }
    if (ALCOHOL_RE.test(p.name)) {
      changes.push({ index, action: "removed_alcohol", before: p });
      return;
    }
    const at = (c: Column): string => cells[columns[c]] ?? "";
    const name = at("name");
    if (!name) {
      out.push(p);
      changes.push({ index, action: "skipped_unparseable", before: p, after: p, detail: "name cell is empty" });
      return;
    }
    const key = normalizeName(name);
    if (nonTabNames.has(key) || seenSplit.has(key)) {
      changes.push({
        index,
        action: "removed_duplicate",
        before: p,
        detail: nonTabNames.has(key) ? "a non-tab row already has this name" : "an earlier tab row already has this name",
      });
      return;
    }
    seenSplit.add(key);

    const after: Record<string, unknown> = { ...p, name };
    const dropped: string[] = [];
    const catCell = at("category");
    const mapped = CATEGORY_MAP[cellKey(catCell)];
    if (mapped) after.category = mapped;
    else if (catCell) dropped.push(`category: ${catCell}`);
    const priceCell = at("price");
    const price = priceCell ? parsePriceCell(priceCell) : null;
    if (price && priceIsEmpty(p.price)) {
      after.price = price;
      after.priceUnit = "kr";
    } else if (priceCell && !price) {
      dropped.push(`price: ${priceCell}`);
    } else if (price) {
      dropped.push(`price: ${priceCell} (row already has a price)`);
    }
    const avail = at("availability");
    if (avail && !EMPTY_CELLS.has(cellKey(avail)) && !(typeof p.note === "string" && p.note.trim())) {
      after.note = avail;
    } else if (avail) {
      dropped.push(`availability: ${avail}`);
    }
    cells.forEach((c, i) => {
      if (!known.has(i) && c) dropped.push(`extra: ${c}`);
    });
    out.push(after);
    changes.push({ index, action: "split", before: p, after, ...(dropped.length ? { dropped_cells: dropped } : {}) });
  });

  return {
    products: out,
    changes,
    tab_rows: tabRows,
    unchanged: products.length - tabRows,
    non_tab_alcohol_rows: nonTabAlcohol,
  };
}

// ─── Catalog (`products` table) ────────────────────────────────────────────

interface CatalogEffect {
  action: "none" | "rename_in_place" | "retire_delete" | "retire_out_of_stock";
  product_id?: string;
  old_name_norm?: string;
  new_name?: string;
  new_name_norm?: string;
  existing_product_id?: string;
  references?: { cart_items: number; cart_wishes: number };
  old_row?: Record<string, unknown>;
}

/** The sync's key for an entry (product-catalog-sync.ts); "" = not listed. */
function catalogKeyOf(entry: Record<string, unknown>): { key: string; cleanName: string } {
  const raw = typeof entry.name === "string" ? entry.name.trim() : "";
  if (!raw || isProductHeader(raw) || isProductNoise(raw)) return { key: "", cleanName: "" };
  const { cleanName } = parseProductPrice(entry as any);
  if (!cleanName) return { key: "", cleanName: "" };
  return { key: normalizeName(cleanName), cleanName };
}

/** Keys / catalog ids an earlier row of the same plan already uses. */
interface CatalogClaims {
  newKeys: Set<string>;
  productIds: Set<string>;
}

function planCatalog(db: ReturnType<typeof getDb>, agentId: string, change: RowChange, claimed: CatalogClaims): CatalogEffect {
  const before = change.before as Record<string, unknown>;
  const oldK = catalogKeyOf(before);
  if (!oldK.key) return { action: "none" };
  const oldRow = db.prepare(`SELECT * FROM products WHERE agent_id = ? AND name_norm = ?`).get(agentId, oldK.key) as
    | Record<string, unknown>
    | undefined;
  if (!oldRow) return { action: "none", old_name_norm: oldK.key };
  // Two identical tab lines share one catalog row: only the first acts on it.
  if (claimed.productIds.has(oldRow.id as string)) return { action: "none", old_name_norm: oldK.key, product_id: oldRow.id as string };
  claimed.productIds.add(oldRow.id as string);
  const base: CatalogEffect = { action: "none", product_id: oldRow.id as string, old_name_norm: oldK.key, old_row: oldRow };
  if (change.action === "split") {
    const newK = catalogKeyOf(change.after as Record<string, unknown>);
    const existing = newK.key
      ? (db.prepare(`SELECT id FROM products WHERE agent_id = ? AND name_norm = ?`).get(agentId, newK.key) as { id: string } | undefined)
      : undefined;
    // `claimed`: a new key an earlier row in this same plan already renames into.
    if (newK.key && !existing && !claimed.newKeys.has(newK.key)) {
      claimed.newKeys.add(newK.key);
      return { ...base, action: "rename_in_place", new_name: newK.cleanName, new_name_norm: newK.key };
    }
    if (existing) base.existing_product_id = existing.id;
  }
  const refs = {
    cart_items: (db.prepare(`SELECT COUNT(*) AS n FROM cart_items WHERE product_id = ?`).get(oldRow.id) as { n: number }).n,
    cart_wishes: (db.prepare(`SELECT COUNT(*) AS n FROM cart_wishes WHERE chosen_product_id = ?`).get(oldRow.id) as { n: number }).n,
  };
  return { ...base, references: refs, action: refs.cart_items + refs.cart_wishes > 0 ? "retire_out_of_stock" : "retire_delete" };
}

function applyCatalog(db: ReturnType<typeof getDb>, c: CatalogEffect): void {
  if (c.action === "rename_in_place") {
    db.prepare(`UPDATE products SET name = ?, name_norm = ?, updated_at = datetime('now') WHERE id = ?`).run(c.new_name, c.new_name_norm, c.product_id);
  } else if (c.action === "retire_delete") {
    db.prepare(`DELETE FROM products WHERE id = ?`).run(c.product_id);
  } else if (c.action === "retire_out_of_stock") {
    db.prepare(`UPDATE products SET availability = 'out_of_stock', updated_at = datetime('now') WHERE id = ?`).run(c.product_id);
  }
}

// ─── Snapshot + evaluation ─────────────────────────────────────────────────

interface Snapshot {
  name: string;
  claimed_at: string | null;
  verified_claims: number;
  products: string | null;
  curated_fields: string | null;
  has_knowledge_row: number;
}

const SNAPSHOT_SQL = `
  SELECT a.name AS name, a.claimed_at AS claimed_at,
         (SELECT COUNT(*) FROM agent_claims c WHERE c.agent_id = a.id AND c.status = 'verified') AS verified_claims,
         k.products AS products, k.curated_fields AS curated_fields,
         (k.agent_id IS NOT NULL) AS has_knowledge_row
    FROM agents a
    LEFT JOIN agent_knowledge k ON k.agent_id = a.id
   WHERE a.id = ?`;

function isFieldCurated(curatedFieldsJson: string | null | undefined, fieldName: string): boolean {
  if (!curatedFieldsJson) return false;
  try {
    const parsed = JSON.parse(curatedFieldsJson);
    if (!parsed || typeof parsed !== "object") return false;
    return !!(parsed as Record<string, unknown>)[fieldName];
  } catch {
    return false;
  }
}

type Outcome =
  | "would_write"
  | "written"
  | "skipped_curated"
  | "skipped_no_tab_rows"
  | "skipped_malformed_json"
  | "not_found"
  | "error";

interface Evaluation {
  outcome: Outcome;
  reason?: string;
  snap?: Snapshot;
  plan?: CleanupPlan;
  catalog?: CatalogEffect[];
}

function evaluate(db: ReturnType<typeof getDb>, agentId: string): Evaluation {
  const snap = db.prepare(SNAPSHOT_SQL).get(agentId) as Snapshot | undefined;
  if (!snap) return { outcome: "not_found" };
  if (isFieldCurated(snap.curated_fields, "products")) return { outcome: "skipped_curated", reason: "products_locked", snap };
  let products: unknown;
  try {
    products = JSON.parse(snap.products || "[]");
  } catch {
    return { outcome: "skipped_malformed_json", reason: "products is not valid JSON", snap };
  }
  if (!Array.isArray(products)) return { outcome: "skipped_malformed_json", reason: "products is not a JSON array", snap };
  const plan = planProductsTabCleanup(products);
  const effective = plan.changes.filter((c) => c.action !== "skipped_unparseable");
  if (effective.length === 0) return { outcome: "skipped_no_tab_rows", snap, plan };
  const claimed: CatalogClaims = { newKeys: new Set(), productIds: new Set() };
  for (const c of effective) c.catalog = planCatalog(db, agentId, c, claimed);
  return { outcome: "would_write", snap, plan };
}

function counts(plan: CleanupPlan | undefined): Record<string, number> {
  const c: Record<string, number> = {
    split: 0, removed_header: 0, removed_alcohol: 0, removed_duplicate: 0, skipped_unparseable: 0,
    unchanged: plan?.unchanged ?? 0,
  };
  for (const ch of plan?.changes ?? []) c[ch.action]++;
  return c;
}

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { agent_id?: unknown; apply?: unknown };
  if (typeof body.agent_id !== "string" || !body.agent_id.trim()) {
    res.status(400).json({ error: "agent_id required (string)" });
    return;
  }
  const agentId = body.agent_id.trim();
  if (agentId.length > PRODUCTS_TAB_CLEANUP_MAX_AGENT_ID || /\s/.test(agentId)) {
    res.status(400).json({ error: "agent_id invalid" });
    return;
  }

  const apply = isExplicitApply(body.apply, req.query?.apply);
  const dryRun = !apply;
  const batchTag = `products-tab-cleanup-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
  const db = db_();

  let ev: Evaluation;
  let auditId: string | undefined;
  if (dryRun) {
    ev = evaluate(db, agentId);
  } else {
    try {
      ev = db.transaction((): Evaluation => {
        // Fresh re-read + re-plan inside the transaction.
        const e = evaluate(db, agentId);
        if (e.outcome !== "would_write") return e;
        const oldValue = e.snap!.products;
        const newValue = JSON.stringify(e.plan!.products);
        db.prepare(`UPDATE agent_knowledge SET products = ?, updated_at = ? WHERE agent_id = ?`).run(newValue, new Date().toISOString(), agentId);
        const catalogNotes: CatalogEffect[] = [];
        for (const c of e.plan!.changes) {
          if (c.catalog && c.catalog.action !== "none") {
            applyCatalog(db, c.catalog);
            catalogNotes.push(c.catalog);
          }
        }
        const k = counts(e.plan);
        let notes = `${batchTag}: products tab cleanup (dev-request 2026-11-10-rfb-bakke-rydding-dublett-og-innlimte-varer S2) ` +
          `split=${k.split} removed_header=${k.removed_header} removed_alcohol=${k.removed_alcohol} removed_duplicate=${k.removed_duplicate}`;
        if (catalogNotes.length) notes += ` [catalog: ${JSON.stringify(catalogNotes)}]`;
        auditId = randomUUID();
        db.prepare(
          `INSERT INTO agent_knowledge_audit
             (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
           VALUES (?, ?, 'products', ?, ?, 'admin', NULL, datetime('now'), ?)`,
        ).run(auditId, agentId, oldValue ?? null, newValue, notes);
        return { ...e, outcome: "written" };
      })();
    } catch (err: any) {
      res.status(500).json({ success: false, dry_run: false, agent_id: agentId, outcome: "error", detail: err?.message ?? String(err) });
      return;
    }
  }

  if (ev.outcome === "not_found") {
    res.status(404).json({ success: false, dry_run: dryRun, agent_id: agentId, outcome: "not_found", error: "agent not found" });
    return;
  }

  const plan = ev.plan;
  res.json({
    success: true,
    dry_run: dryRun,
    batch_tag: batchTag,
    agent_id: agentId,
    name: ev.snap?.name,
    outcome: ev.outcome,
    ...(ev.reason ? { reason: ev.reason } : {}),
    owner_locked: !!ev.snap?.claimed_at || (ev.snap?.verified_claims ?? 0) > 0,
    ...(auditId ? { audit_id: auditId } : {}),
    products_before: plan ? plan.unchanged + plan.tab_rows : undefined,
    products_after: plan ? plan.products.length : undefined,
    tab_rows: plan?.tab_rows ?? 0,
    counts: counts(plan),
    rows: plan?.changes ?? [],
    non_tab_alcohol_rows: plan?.non_tab_alcohol_rows ?? [],
  });
});

export default router;
