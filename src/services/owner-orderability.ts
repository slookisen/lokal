// ─── Owner orderability (dev-request «RFB bestillinger fra start til slutt for
// eier», slice B1) ──────────────────────────────────────────────────────────
// What the /eier portal's «Varer som kan bestilles» card reads and writes:
//
//   - listOwnerProductOrderability(): every product row of the producer with
//     cart-service orderabilityReasons() — the same core as the real-order
//     gate isRowOrderableForRealOrder(), so the card can never disagree with
//     what a buyer can order;
//   - confirmOwnerProductInStock() / confirmAllOwnerProductsInStock(): «Bekreft
//     at varen er på lager» through the EXISTING write path
//     supply-graph.setProducerAvailabilityByProductId() (availability
//     'in_stock', fresh timestamp, source 'producer_dashboard'; an
//     'admin_producer_confirmed' row keeps its source, as that path does);
//   - addOwnerProduct(): a new product row the owner states (name, price,
//     unit, and the existing optional food columns), validated with the admin
//     producer-list rules (marketplace-catalog validateProducerList), written
//     with availability_source 'producer_dashboard'.
//
// Behind OWNER_ORDERABILITY_PORTAL_ENABLED (read at call time, "1"/"true" =
// on, default OFF): off = no card, the routes answer 404 — the portal is
// unchanged. The callers (routes/owner-portal.ts) do the owner checks.
// B1a: with the flag on, the card, the routes and the B2 banner are still
// only for a subject in OWNER_FEATURES_ALLOWED_SUBJECTS (the «Mine valg»
// allowlist, owner-features/allowlist.ts) — off the list = as if the flag
// were off, so turning the flag on to test with the test producer is not a
// rollout. ownerOrderabilityPortalEnabledFor() is that combined check.
//
// Category labels and alcohol / services are never confirmed by these writes
// (their reason is not something a stock confirmation can fix, and confirming
// a label would make it count as a producer-set product). Rows without a
// price (price_nok NULL) are not confirmed either: one click must not turn an
// unpriced scraped row into an orderable one. That is a portal-side rule only;
// the real-order gate (cart-service) is unchanged.

import crypto from "crypto";
import { getDb } from "../database/init";
import {
  isProducerStatedSource,
  orderabilityReasons,
  producerOrderability,
  type OrderabilityReason,
  type OrderabilityResult,
  type OrderabilityRow,
} from "./cart-service";
import { setProducerAvailabilityByProductId } from "./supply-graph";
import { validateProducerList } from "../routes/marketplace-catalog";
import { normalizeName } from "./product-catalog-sync";
import { ownerFeatureAccess } from "../owner-features/feature-tiers";

export const OWNER_ORDERABILITY_PORTAL_FLAG = "OWNER_ORDERABILITY_PORTAL_ENABLED";

export function ownerOrderabilityPortalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[OWNER_ORDERABILITY_PORTAL_FLAG];
  return v === "1" || v === "true";
}

/** B1a: the flag AND this producer on the owner-features allowlist (`rfb:<id>`). */
export function ownerOrderabilityPortalEnabledFor(agentId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return ownerOrderabilityPortalEnabled(env) && ownerFeatureAccess("orderability", "rfb", agentId, env).allowed;
}

/** Reasons a stock confirmation cannot fix: such rows get no confirm button and are skipped by «Bekreft alle». */
export const NOT_CONFIRMABLE: ReadonlySet<string> = new Set(["category_label", "alcohol", "service", "ban_check_failed"]);

export interface OwnerProductOrderability extends OrderabilityResult {
  id: string;
  name: string;
  price_nok: number | null;
  unit: string | null;
  availability: string;
  availability_source: string | null;
  /** Portal-only: the row has no price, so it cannot be confirmed here (not a gate reason). */
  missing_price: boolean;
  /** «Bekreft at varen er på lager» can be used on this row. */
  confirmable: boolean;
}

export interface OwnerOrderabilityOverview {
  products: OwnerProductOrderability[];
  orderable_count: number;
  /** Profile-level reasons (they block every row); [] when the profile may take orders. */
  profile_reasons: OrderabilityReason[];
}

export type OwnerProductRow = OrderabilityRow & { id: string; unit: string | null };
type ProductRow = OwnerProductRow;

/** Every product row of the producer, in the card's order (B2 reads the same rows). */
export function readOwnerProductRows(db: any, agentId: string): ProductRow[] {
  return readRows(db, agentId);
}

function readRows(db: any, agentId: string): ProductRow[] {
  return db
    .prepare(
      `SELECT id, agent_id, name, description, category, price_nok, unit, availability, availability_updated_at, availability_source
         FROM products WHERE agent_id = ? ORDER BY name COLLATE NOCASE, id`,
    )
    .all(agentId) as ProductRow[];
}

/** «Bekreft at varen er på lager» may be used on the row (B1 rule; B2 reuses it). */
export function isConfirmable(r: OrderabilityResult, priceNok: number | null): boolean {
  return priceNok != null && !r.reasons.some((x) => NOT_CONFIRMABLE.has(x.code));
}

export function listOwnerProductOrderability(agentId: string, db: any = getDb(), now: Date = new Date()): OwnerOrderabilityOverview {
  const producer = producerOrderability(db, agentId);
  const products = readRows(db, agentId).map((row) => {
    const r = orderabilityReasons(db, row, now, producer);
    return {
      id: row.id,
      name: row.name,
      price_nok: row.price_nok,
      unit: row.unit,
      availability: row.availability,
      availability_source: row.availability_source,
      ...r,
      missing_price: row.price_nok == null,
      confirmable: isConfirmable(r, row.price_nok),
    };
  });
  return {
    products,
    orderable_count: products.filter((p) => p.orderable).length,
    profile_reasons: producer.eligible ? [] : producer.reasons,
  };
}

export function auditOwnerProductChange(db: any, agentId: string, field: string, oldValue: string | null, newValue: string | null, email: string | null, notes: string): void {
  db.prepare(
    `INSERT INTO agent_knowledge_audit
     (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
     VALUES (?, ?, ?, ?, ?, 'owner', ?, ?, ?)`,
  ).run(`audit_${crypto.randomBytes(8).toString("hex")}`, agentId, field, oldValue, newValue, email, new Date().toISOString(), notes);
}

export type ConfirmResult =
  | { ok: true; confirmed: number }
  | { ok: false; error: "not_found" | "not_confirmable" | "missing_price" };

/** «Bekreft at varen er på lager» for one row of this producer. */
export function confirmOwnerProductInStock(
  agentId: string,
  productId: string,
  opts: { db?: any; actorEmail?: string | null; now?: Date } = {},
): ConfirmResult {
  const db = opts.db ?? getDb();
  const row = readRows(db, agentId).find((r) => r.id === productId);
  if (!row) return { ok: false, error: "not_found" };
  const reasons = orderabilityReasons(db, row, opts.now ?? new Date(), { eligible: true, reasons: [] }).reasons;
  if (reasons.some((x) => NOT_CONFIRMABLE.has(x.code))) return { ok: false, error: "not_confirmable" };
  if (row.price_nok == null) return { ok: false, error: "missing_price" };
  let out: ConfirmResult = { ok: false, error: "not_found" };
  db.transaction(() => {
    const w = setProducerAvailabilityByProductId(agentId, productId, "in_stock", db);
    if (!w.success) return;
    auditOwnerProductChange(db, agentId, "products.availability", row.availability, "in_stock", opts.actorEmail ?? null, `owner confirmed in stock: ${row.name} (B1)`);
    out = { ok: true, confirmed: 1 };
  })();
  return out;
}

/**
 * «Bekreft alle på lager»: every confirmable row of this producer, in one transaction.
 * T13 V1a: with `ids` («Bekreft alle ({n})» in the «Varer» card) only those
 * ids, and of them only this producer's producer-stated rows — an id of
 * another producer, or a scraped row sent along, is left untouched (a scraped
 * row keeps its source); the B1 confirmable rule still applies.
 */
export function confirmAllOwnerProductsInStock(
  agentId: string,
  opts: { db?: any; actorEmail?: string | null; now?: Date; ids?: readonly string[] } = {},
): { ok: true; confirmed: number; skipped_missing_price: number } {
  const db = opts.db ?? getDb();
  const now = opts.now ?? new Date();
  const wanted = opts.ids ? new Set(opts.ids) : null;
  const all = readRows(db, agentId).filter((r) => !wanted || (wanted.has(r.id) && isProducerStatedSource(r.availability_source)));
  // Unpriced rows a confirmation could otherwise fix: counted for the owner's message.
  const skipped_missing_price = all.filter((r) => r.price_nok == null
    && !orderabilityReasons(db, r, now, { eligible: true, reasons: [] }).reasons.some((x) => NOT_CONFIRMABLE.has(x.code))).length;
  const rows = all.filter((r) => isConfirmable(orderabilityReasons(db, r, now, { eligible: true, reasons: [] }), r.price_nok));
  let confirmed = 0;
  db.transaction(() => {
    for (const r of rows) {
      if (setProducerAvailabilityByProductId(agentId, r.id, "in_stock", db).success) confirmed++;
    }
    if (confirmed > 0) {
      auditOwnerProductChange(db, agentId, "products.availability", null, "in_stock", opts.actorEmail ?? null,
        wanted ? `owner confirmed ${confirmed} listed item(s) in stock (T13)` : `owner confirmed all in stock: ${confirmed} item(s) (B1)`);
    }
  })();
  return { ok: true, confirmed, skipped_missing_price };
}

export interface OwnerNewProductInput {
  name?: unknown;
  price?: unknown;
  unit?: unknown;
  ingredients?: unknown;
  allergens?: unknown;
  net_weight?: unknown;
  /** T13 V1b: «Kategori (valgfritt)» (products.category, max 40). */
  category?: unknown;
  /**
   * T13 V1b: «Varen er på lager nå». true/undefined → in stock (as before);
   * false → the row is written as the producer's statement 'out_of_stock'.
   */
  in_stock?: boolean;
  /** T13 V1b: «Er varen ferdigpakket?» = ja → ingredients, allergens and net weight are required. */
  packaged?: boolean;
}

export type AddProductResult =
  | { ok: true; product_id: string; in_stock: boolean }
  | { ok: false; error: "invalid"; fields: OwnerProductField[] }
  | { ok: false; error: "exists" };

/** The B1 form fields (their texts are OWNER_PRODUCT_FIELD_TEXT_NB). */
export type OwnerProductB1Field = "name" | "price" | "unit" | "ingredients" | "allergens" | "net_weight";
/**
 * T13 V1b adds the category and the three «required for ferdigpakket» cases;
 * their texts are in owner-items-view OWNER_ITEMS_INVENTED_TEXT_NB.fieldErrors.
 */
export type OwnerProductField = OwnerProductB1Field | "category" | "ingredients_required" | "allergens_required" | "net_weight_required";

/** validateProducerList's messages start with the field name; map them to the form's fields. */
function invalidFields(errors: string[]): OwnerProductField[] {
  const out = new Set<OwnerProductField>();
  for (const e of errors) {
    const msg = e.replace(/^products\[0\]: /, "");
    const f = msg.split(" ")[0];
    const required = /påkrevd for ferdigpakket/.test(msg);
    if (f === "price_nok") out.add("price");
    else if (required && (f === "ingredients" || f === "allergens" || f === "net_weight")) out.add(`${f}_required` as OwnerProductField);
    else if (f === "name" || f === "unit" || f === "ingredients" || f === "allergens" || f === "net_weight" || f === "category") out.add(f);
    else out.add("name");
  }
  // A too-long value is also «missing» to the packaged rule: name only the length.
  for (const f of ["ingredients", "allergens", "net_weight"] as const) {
    if (out.has(f)) out.delete(`${f}_required` as OwnerProductField);
  }
  return Array.from(out);
}

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** T13 V1b: «ingen» in the allergen field = the producer states none ('[]'). */
const NO_ALLERGENS_RE = /^(ingen|ingen allergener)\.?$/i;

/** «Ny vare»: the form's text fields → one validated row, written as producer-stated (in stock unless `in_stock: false`). */
export function addOwnerProduct(
  agentId: string,
  input: OwnerNewProductInput,
  opts: { db?: any; actorEmail?: string | null } = {},
): AddProductResult {
  const db = opts.db ?? getDb();
  const priceText = text(input.price).replace(/\s/g, "").replace(",", ".");
  const price = priceText && /^\d+(\.\d{1,2})?$/.test(priceText) ? Number(priceText) : NaN;
  const allergensText = text(input.allergens);
  const allergens = !allergensText
    ? undefined
    : NO_ALLERGENS_RE.test(allergensText) ? [] : allergensText.split(",").map((a) => a.trim()).filter(Boolean);
  const inStock = input.in_stock !== false;
  const v = validateProducerList([{
    name: text(input.name) || undefined,
    price_nok: price,
    unit: text(input.unit) || undefined,
    category: text(input.category) || undefined,
    availability: inStock ? "in_stock" : "out_of_stock",
    packaged: input.packaged === true,
    ingredients: text(input.ingredients) || undefined,
    allergens,
    net_weight: text(input.net_weight) || undefined,
  }]);
  if (!v.ok) return { ok: false, error: "invalid", fields: invalidFields(v.errors) };
  const p = v.products[0];
  // An empty allergen field means «not stated» here (NULL), never «none» ('[]').
  const allergensJson = allergens === undefined ? null : p.allergens;
  const nameNorm = normalizeName(p.name);
  const exists = db.prepare("SELECT 1 FROM products WHERE agent_id = ? AND name_norm = ?").get(agentId, nameNorm);
  if (exists) return { ok: false, error: "exists" };
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO products
         (id, agent_id, name, name_norm, unit, price_nok, currency, availability, category, source,
          availability_updated_at, availability_source, ingredients, allergens, net_weight, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'NOK', ?, ?, 'owner', datetime('now'), 'producer_dashboard', ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run(id, agentId, p.name, nameNorm, p.unit, p.price_nok, p.availability, p.category, p.ingredients, allergensJson, p.net_weight);
    auditOwnerProductChange(db, agentId, "products.added", null, p.name, opts.actorEmail ?? null,
      inStock ? "owner added a product (B1)" : "owner added a product, not in stock (T13)");
  })();
  return { ok: true, product_id: id, in_stock: inStock };
}

export type MarkSoldOutResult =
  | { ok: true; changed: boolean }
  | { ok: false; error: "not_found" | "not_markable" };

/**
 * T13 V1b «Merk som utsolgt» for one row of this producer, through the same
 * write path as «Bekreft på lager» (supply-graph
 * setProducerAvailabilityByProductId, availability 'out_of_stock', fresh
 * timestamp; an 'admin_producer_confirmed' row keeps its source). Only a
 * producer-stated row that a stock statement can describe (not a category
 * label, alcohol or a service; not a scraped row). An already sold-out row is
 * left as it is (its date stays). «På lager igjen» is confirmOwnerProductInStock.
 */
export function markOwnerProductSoldOut(
  agentId: string,
  productId: string,
  opts: { db?: any; actorEmail?: string | null; now?: Date } = {},
): MarkSoldOutResult {
  const db = opts.db ?? getDb();
  const row = readRows(db, agentId).find((r) => r.id === productId);
  if (!row) return { ok: false, error: "not_found" };
  if (!isProducerStatedSource(row.availability_source)) return { ok: false, error: "not_markable" };
  const reasons = orderabilityReasons(db, row, opts.now ?? new Date(), { eligible: true, reasons: [] }).reasons;
  if (reasons.some((x) => NOT_CONFIRMABLE.has(x.code))) return { ok: false, error: "not_markable" };
  if (row.availability === "out_of_stock") return { ok: true, changed: false };
  let out: MarkSoldOutResult = { ok: false, error: "not_found" };
  db.transaction(() => {
    const w = setProducerAvailabilityByProductId(agentId, productId, "out_of_stock", db);
    if (!w.success) return;
    auditOwnerProductChange(db, agentId, "products.availability", row.availability, "out_of_stock", opts.actorEmail ?? null, `owner marked sold out: ${row.name} (T13)`);
    out = { ok: true, changed: true };
  })();
  return out;
}

// ─── Owner-facing words (bokmål) ────────────────────────────────────────────

/** dd.mm.åååå in Norwegian time. */
export function formatOwnerDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("nb-NO", { timeZone: "Europe/Oslo", day: "2-digit", month: "2-digit", year: "numeric" });
}

/** One reason as the owner reads it. */
export function orderabilityReasonTextNb(r: OrderabilityReason): string {
  switch (r.code) {
    case "category_label": return "Dette er et kategorinavn, ikke en vare";
    case "alcohol": return "Alkohol kan ikke bestilles her";
    case "service": return "Tjenester og opplevelser kan ikke bestilles her";
    case "ban_check_failed": return "Vi klarte ikke å sjekke varen nå. Prøv igjen senere";
    case "stock_status_expired":
      return r.expired_at ? `Lagerstatus utgått ${formatOwnerDate(r.expired_at)}. Bekreft at varen er på lager` : "Lagerstatus utgått. Bekreft at varen er på lager";
    case "not_in_stock": return "Ikke registrert på lager";
    case "not_confirmed_by_owner": return "Ikke bekreftet av deg ennå";
    case "orders_off": return "Bestillinger er slått av";
    case "owner_not_verified": return "Eierskapet er ikke bekreftet";
    case "order_email_missing": return "Mangler e-postadresse for bestillinger";
    case "order_email_suppressed": return "E-postadressen for bestillinger kan ikke motta e-post fra oss";
    case "profile_not_checked": return "Rett fra Bonden har ikke kontrollert profilen ennå. Kontakt kontakt@rettfrabonden.com";
    case "producer_not_eligible": return "Profilen kan ikke ta imot bestillinger ennå. Kontakt kontakt@rettfrabonden.com";
  }
}

/** Form field → what is wrong with it. */
export const OWNER_PRODUCT_FIELD_TEXT_NB: Record<OwnerProductB1Field, string> = {
  name: "Navn mangler eller er for langt (maks 120 tegn).",
  price: "Pris må være et tall over 0, f.eks. 89 eller 89,50.",
  unit: "Enhet er for lang (maks 30 tegn).",
  ingredients: "Ingredienser er for lange (maks 1500 tegn).",
  allergens: "Allergener: skriv dem med komma mellom (maks 30, hver maks 40 tegn).",
  net_weight: "Nettovekt må være et tall med enhet, f.eks. 250 g eller 1,5 kg.",
};
