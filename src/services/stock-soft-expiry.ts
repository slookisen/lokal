// ─── B2b-1: soft stock expiry — the rule's switch and the order path ────────
// dev-request 2026-10-28-rfb-bestillinger-fra-start-til-slutt-for-eier,
// «B2b — myk utløp», slice B2b-1 (Daniel 2026-10-30, record
// daniel-responses/2026-10-30-live-lagerstatus-myk-utlop.md).
//
// A producer_dashboard 'in_stock' row older than the staleness window
// (getSupplyGraphStaleDays(), 14) stays orderable until the hard window
// (getSupplyGraphHardStaleDays(), 60), with the date the producer last
// confirmed it shown to the buyer (supply-graph.ts evaluateStockFreshness()).
//
// Active only when STOCK_SOFT_EXPIRY_ENABLED is on ("1"/"true", read per call,
// default OFF) AND the profile is on the owner-features allowlist
// (OWNER_FEATURES_ALLOWED_SUBJECTS, `rfb:<id>` — the same check B1a uses).
// Off → every caller behaves exactly as before.
//
// The order path (called from order-actions.ts applyOrderAction):
//   - the producer confirms an order → its producer_dashboard 'in_stock'
//     items get a fresh confirmation time (availability_updated_at);
//     'admin_producer_confirmed' rows are untouched;
//   - «Avslå – utsolgt» → the chosen items of the order (default all) are
//     set to 'out_of_stock' through the existing producer write path
//     (supply-graph setProducerAvailabilityByProductId).
// Each written row gets an agent_knowledge_audit row (changed_by 'owner'),
// the log the owner's product writes already use.

import crypto from "crypto";
import { isSubjectAllowedForOwnerFeatures } from "../owner-features/allowlist";
import { setProducerAvailabilityByProductId } from "./supply-graph";

export const STOCK_SOFT_EXPIRY_FLAG = "STOCK_SOFT_EXPIRY_ENABLED";

export function stockSoftExpiryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[STOCK_SOFT_EXPIRY_FLAG];
  return v === "1" || v === "true";
}

/** The flag AND this producer on the owner-features allowlist (`rfb:<id>`). */
export function stockSoftExpiryActiveFor(agentId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!agentId) return false;
  return stockSoftExpiryEnabled(env) && isSubjectAllowedForOwnerFeatures("rfb", agentId, env);
}

/** dd.mm.åååå in Norwegian time ("" when unparseable). */
export function formatStockConfirmedDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("nb-NO", { timeZone: "Europe/Oslo", day: "2-digit", month: "2-digit", year: "numeric" });
}

const BUYER_TEMPLATE: Record<"no" | "en", string> = {
  no: "Sist bekreftet av produsenten {date}. Produsenten bekrefter at varen er på lager før bestillingen gjelder.",
  en: "Last confirmed by the producer {date}. The producer confirms that the item is in stock before the order applies.",
};

/** The buyer's text with a `{date}` placeholder (for the /handleliste client script). */
export function stockSoftExpiryBuyerTemplate(lang: "no" | "en"): string {
  return BUYER_TEMPLATE[lang];
}

/** The buyer's text next to the item and in the checkout for a row that needs the producer's confirmation. */
export function stockSoftExpiryBuyerTextNb(stockConfirmedAt: string): string {
  return BUYER_TEMPLATE.no.replace("{date}", formatStockConfirmedDate(stockConfirmedAt));
}

function sqlTs(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function audit(db: any, agentId: string, field: string, oldValue: string | null, newValue: string | null, notes: string, now: Date): void {
  db.prepare(
    `INSERT INTO agent_knowledge_audit
     (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
     VALUES (?, ?, ?, ?, ?, 'owner', NULL, ?, ?)`,
  ).run(`audit_${crypto.randomBytes(8).toString("hex")}`, agentId, field, oldValue, newValue, now.toISOString(), notes);
}

interface OrderProductRow {
  product_id: string;
  name: string;
  availability: string;
  availability_source: string | null;
  availability_updated_at: string | null;
}

/** The order's lines that are a product of this producer (one per product, in order). */
function orderProducts(db: any, orderId: string, agentId: string): OrderProductRow[] {
  const rows = db.prepare(
    `SELECT p.id AS product_id, p.name AS name, p.availability AS availability,
            p.availability_source AS availability_source, p.availability_updated_at AS availability_updated_at
       FROM order_items oi
       INNER JOIN products p ON p.id = oi.product_id AND p.agent_id = ?
      WHERE oi.order_id = ?
      ORDER BY oi.rowid`,
  ).all(agentId, orderId) as OrderProductRow[];
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.product_id) ? false : (seen.add(r.product_id), true)));
}

/** The «Utsolgt» choices of an order: its products of this producer (id + name). */
export function soldOutChoices(db: any, orderId: string, agentId: string): Array<{ product_id: string; name: string }> {
  try {
    return orderProducts(db, orderId, agentId).map((r) => ({ product_id: r.product_id, name: r.name }));
  } catch {
    return [];
  }
}

/**
 * The producer confirmed `orderId`: its producer_dashboard 'in_stock' items get
 * availability_updated_at = now. Returns the refreshed product ids. The caller
 * checks stockSoftExpiryActiveFor().
 */
export function refreshStockConfirmationForOrder(db: any, orderId: string, agentId: string, now: Date = new Date()): string[] {
  const ts = sqlTs(now);
  const refreshed: string[] = [];
  db.transaction(() => {
    for (const r of orderProducts(db, orderId, agentId)) {
      if (r.availability_source !== "producer_dashboard" || r.availability !== "in_stock") continue;
      const res = db.prepare(
        `UPDATE products SET availability_updated_at = ?, updated_at = ?
          WHERE id = ? AND agent_id = ? AND availability_source = 'producer_dashboard' AND availability = 'in_stock'`,
      ).run(ts, ts, r.product_id, agentId);
      if (res.changes > 0) {
        refreshed.push(r.product_id);
        audit(db, agentId, "products.availability_updated_at", r.availability_updated_at, ts,
          `stock confirmed by confirmed order ${orderId.slice(0, 8)} (B2b-1): ${r.product_id}`, now);
      }
    }
  })();
  return refreshed;
}

/**
 * «Avslå – utsolgt»: the chosen items of `orderId` (`productIds`; null/empty =
 * every product of the order) → 'out_of_stock' through the existing producer
 * write path (source 'producer_dashboard'; an 'admin_producer_confirmed' row
 * keeps its source, as that path does). Ids that are not in the order are
 * ignored. Returns the written product ids. The caller checks
 * stockSoftExpiryActiveFor().
 */
export function markOrderItemsSoldOut(
  db: any,
  orderId: string,
  agentId: string,
  productIds: readonly string[] | null | undefined,
  now: Date = new Date(),
): string[] {
  const wanted = productIds && productIds.length ? new Set(productIds) : null;
  const written: string[] = [];
  db.transaction(() => {
    for (const r of orderProducts(db, orderId, agentId)) {
      if (wanted && !wanted.has(r.product_id)) continue;
      if (!setProducerAvailabilityByProductId(agentId, r.product_id, "out_of_stock", db).success) continue;
      written.push(r.product_id);
      audit(db, agentId, "products.availability", r.availability, "out_of_stock",
        `sold out on declined order ${orderId.slice(0, 8)} (B2b-1 «Utsolgt»): ${r.product_id}`, now);
    }
  })();
  return written;
}

/** The «sold_out» field of a form post (one value or several) as a list of ids. */
export function soldOutIdsFromBody(v: unknown): string[] {
  const list = Array.isArray(v) ? v : v == null ? [] : [v];
  return list.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 128);
}
