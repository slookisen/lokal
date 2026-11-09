// ─── T13 V1a — the owner portal's «Varer» card: one row's view ─────────────
// dev-request 2026-10-30-rfb-eierportal-testrunde-1, punkt 7 («Varer: en
// arbeidsliste, ikke en regelforklaring»), slice T13, part V1a (view + safe
// bulk). V1b adds «Merk som utsolgt» (a «Mer» action on in-stock rows) and
// the texts of the new «Legg til vare» form (kategori, lagervalg,
// ferdigpakket); readOwnerItems() also reads orders.auto_confirm for the
// form's default.
//
//   ownerItemView(row, ctx)   pure: the row's group, status chip (brikke),
//                             one reason line, at most one primary action and
//                             the «Mer» actions. No DB, no clock of its own.
//   readOwnerItems(...)       the rows and counts the card renders, read with
//                             the order gate itself: `gate_orderable` is
//                             cart-service isRowOrderableForRealOrder() and the
//                             header count is countOrderableProducts() — no
//                             rule of its own, so the card cannot disagree
//                             with what a buyer can order.
//
// «Kan bestilles» (chip) only when the gate says yes. Soft expiry
// (STOCK_SOFT_EXPIRY_ENABLED + the allowlist, B2b-1) is read from the row's
// orderabilityReasons() fields; the texts follow it on and off. Fresh rows and
// admin-confirmed rows get no primary action.

import { getDb } from "../database/init";
import {
  countOrderableProducts,
  isProducerStatedSource,
  isRowOrderableForRealOrder,
  orderabilityReasons,
  producerOrderability,
  type OrderabilityReason,
} from "./cart-service";
import { getSupplyGraphHardStaleDays, getSupplyGraphStaleDays, producerStockExpiresAt, producerStockHardExpiresAt } from "./supply-graph";
import { stockSoftExpiryActiveFor } from "./stock-soft-expiry";
import { NOT_CONFIRMABLE, isConfirmable, orderabilityReasonTextNb, readOwnerProductRows } from "./owner-orderability";
import { resolveOwnerFeature } from "../owner-features/resolve";

// ─── Texts ──────────────────────────────────────────────────────────────────

/** The card's texts, exactly as in the spec (punkt 7, «Tekst»). */
export const OWNER_ITEMS_TEXT_NB = {
  title: "Varer",
  countLine: "{n} av {m} varer kan bestilles nå.",
  validity: "Når du bekrefter at en vare er på lager, kan kundene bestille den i {14} dager.",
  validitySoft: "Når du bekrefter at en vare er på lager, kan kundene bestille den. Etter {14} dager ser kundene datoen du sist bekreftet. Etter {60} dager må du bekrefte på nytt.",
  profileBlocked: "Kundene kan ikke bestille noe ennå",
  goToChoices: "Gå til Mine valg",
  fromWebsiteIntro: "Kundene ser disse varene, men kan ikke bestille dem før du har bekreftet pris og lager.",
  notHereIntro: "Alkohol, tjenester og overskrifter fra nettsiden din kan ikke bestilles her. Du trenger ikke gjøre noe med dem.",
  lineFresh: "Sist bekreftet {dato}. Kan bestilles til {dato2}.",
  lineSoft: "Sist bekreftet {dato}. Kundene ser denne datoen.",
  lineExpired: "Lagerstatus gikk ut {dato}. Kundene kan ikke bestille varen.",
  lineMissingPrice: "Mangler pris – legg inn pris først.",
  lineFromWebsite: "Fra nettsiden din – sjekk at prisen stemmer.",
  lineSoldOut: "Merket som utsolgt {dato}.",
  actionConfirm: "Bekreft på lager",
  actionConfirmPriceAndStock: "Bekreft pris og lager",
  actionBackInStock: "På lager igjen",
  more: "Mer",
  moreConfirmNow: "Bekreft på lager nå",
  confirmAll: "Bekreft alle ({n})",
  notConfirmedMissingPrice: "{k} varer ble ikke bekreftet fordi de mangler pris.",
  empty: "Du har ingen varer ennå.",
  readOnly: "Du kan se varene, men ikke endre dem med denne innloggingen.",
  today: "i dag",
  yesterday: "i går",
  // V1b
  moreMarkSoldOut: "Merk som utsolgt",
  markedSoldOut: "Varen er merket som utsolgt. Kundene kan ikke bestille den.",
  addTitle: "Legg til vare",
  fieldName: "Navn",
  fieldPrice: "Pris (kr)",
  fieldUnit: "Enhet",
  fieldCategory: "Kategori (valgfritt)",
  fieldInStock: "Varen er på lager nå",
  inStockOrdersOnHint: "Kunder kan bestille varen med en gang.",
  packagedQuestion: "Er varen ferdigpakket?",
  groups: {
    needs_action: "Trenger handling",
    orderable: "Kan bestilles",
    orderable_orders_off: "Klar når bestillinger er på",
    sold_out: "Utsolgt",
    from_website: "Fra nettsiden din",
    not_here: "Kan ikke bestilles her",
  },
  chips: {
    orderable: "Kan bestilles",
    should_confirm: "Bør bekreftes",
    must_confirm: "Må bekreftes",
    sold_out: "Utsolgt",
    not_orderable: "Kan ikke bestilles",
  },
} as const;

/**
 * Texts the spec does not give, needed for cases it does not name. One list,
 * so they can be reviewed with tekstpakke A.
 */
export const OWNER_ITEMS_INVENTED_TEXT_NB = {
  /** «Kan bestilles» group while orders are on but the profile cannot take orders (not «orders off»). */
  groupOrderableProfileBlocked: "Klar når profilen kan ta imot bestillinger",
  /** An admin-confirmed row (no expiry, no date to show). */
  lineAdminConfirmed: "Bekreftet av Rett fra Bonden.",
  /** A producer-stated row whose stock status was never dated. */
  lineExpiredNoDate: "Lagerstatus har gått ut. Kundene kan ikke bestille varen.",
  /** A producer-stated row whose stock is neither in stock nor sold out (e.g. unknown). */
  lineNotInStock: "Ikke registrert på lager. Kundene kan ikke bestille varen.",
  /** A sold-out row without a date. */
  lineSoldOutNoDate: "Merket som utsolgt.",
  /** «{k} varer ble ikke bekreftet …» with k = 1. */
  notConfirmedMissingPriceOne: "1 vare ble ikke bekreftet fordi den mangler pris.",
  /** The count line with m = 1 (singular). */
  countLineOne: "{n} av 1 vare kan bestilles nå.",
  // ── V1b ──
  /** «Er varen ferdigpakket?» answers. */
  packagedYes: "Ja",
  packagedNo: "Nei",
  /** Labels of the three food fields (the spec names them, not their labels). */
  fieldIngredients: "Ingredienser",
  fieldAllergens: "Allergener",
  fieldNetWeight: "Nettovekt",
  /** Under the three food fields (they cannot be hidden without JavaScript). */
  packagedFieldsHint: "Må fylles ut hvis varen er ferdigpakket. Kundene ser dette før de bestiller.",
  allergensHint: "Skill med komma. Skriv «ingen» hvis varen ikke har allergener.",
  netWeightHint: "For eksempel 250 g eller 1,5 kg.",
  unitHint: "For eksempel kg eller stk.",
  /** The «Varen er på lager nå» box is off by default because orders are confirmed automatically. */
  inStockAutoConfirmHint: "Bestillinger bekreftes automatisk. Kryss av bare hvis du har varen nå.",
  /** After «Legg til vare» with the box unticked. */
  addedNotInStock: "Varen er lagt til. Den er ikke på lager, så kundene kan ikke bestille den ennå.",
  /** «Merk som utsolgt» on a row that cannot be marked (category name, alcohol, service, scraped). */
  cannotMarkSoldOut: "Denne varen kan ikke merkes som utsolgt her.",
  /** Field errors the B1 texts (OWNER_PRODUCT_FIELD_TEXT_NB) do not cover. */
  fieldErrors: {
    category: "Kategori er for lang (maks 40 tegn).",
    ingredients_required: "Ferdigpakket vare: skriv inn ingrediensene.",
    allergens_required: "Ferdigpakket vare: skriv inn allergenene, eller «ingen».",
    net_weight_required: "Ferdigpakket vare: skriv inn nettovekten, for eksempel 250 g.",
  },
} as const;

// ─── Types ──────────────────────────────────────────────────────────────────

export type OwnerItemGroup = "needs_action" | "orderable" | "sold_out" | "from_website" | "not_here";
export type OwnerItemChip = "orderable" | "should_confirm" | "must_confirm" | "sold_out" | "not_orderable";
/** The primary action: all three post to the existing confirm route. */
export type OwnerItemAction = "confirm" | "confirm_price_and_stock" | "back_in_stock";
/** «Mer»: «Bekreft på lager nå» (V1a) and «Merk som utsolgt» (V1b). */
export type OwnerItemMore = "confirm_now" | "mark_sold_out";

export const OWNER_ITEM_GROUP_ORDER: readonly OwnerItemGroup[] = ["needs_action", "orderable", "sold_out", "from_website", "not_here"];

/** One product row as the view reads it. */
export interface OwnerItemRow {
  id: string;
  name: string;
  price_nok: number | null;
  unit: string | null;
  availability: string;
  availability_source: string | null;
  availability_updated_at: string | null;
  /** cart-service isRowOrderableForRealOrder() for (row, now) — the order gate itself. */
  gate_orderable: boolean;
  /** cart-service orderabilityReasons() (the gate's shared core). */
  reasons: OrderabilityReason[];
  /** B2b-1 soft window (only when the rule is active for the producer). */
  stock_confirmed_at?: string;
  needs_producer_confirmation?: true;
}

export interface OwnerItemViewCtx {
  now: Date;
  /** stockSoftExpiryActiveFor(agentId) — STOCK_SOFT_EXPIRY_ENABLED + the allowlist. */
  softExpiry: boolean;
  /** agents.order_notifications_opt_in = 1. */
  ordersOn: boolean;
  /** producerOrderability().eligible — the profile half of the gate. */
  profileEligible: boolean;
  /** The session is the verified claimant's own login (writes allowed). */
  canEdit: boolean;
}

export interface OwnerItemView {
  group: OwnerItemGroup;
  chip: OwnerItemChip | null;
  line: string;
  action: OwnerItemAction | null;
  more: OwnerItemMore[];
  /** May be confirmed by «Bekreft alle» (a confirmable, producer-stated row in «Trenger handling»). */
  bulkConfirmable: boolean;
  /** Sent with «Bekreft alle» (producer-stated rows in «Trenger handling», priced or not). */
  bulkCandidate: boolean;
}

// ─── Dates ──────────────────────────────────────────────────────────────────

/** products.availability_updated_at ("YYYY-MM-DD HH:MM:SS" UTC) or ISO → Date (null when unreadable). */
export function parseItemTimestamp(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  let s = String(ts).trim();
  if (s.includes(" ") && !s.includes("T")) s = s.replace(" ", "T");
  if (!/Z$|[+-]\d{2}:?\d{2}$/.test(s)) s += "Z";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function osloDayKey(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit" });
}

/** «i dag», «i går», else dd.mm.åååå — all in Norwegian time. "" when unreadable. */
export function formatOwnerItemDate(ts: string | Date | null | undefined, now: Date): string {
  const d = ts instanceof Date ? ts : parseItemTimestamp(ts);
  if (!d || Number.isNaN(d.getTime())) return "";
  const key = osloDayKey(d);
  const today = osloDayKey(now);
  if (key === today) return OWNER_ITEMS_TEXT_NB.today;
  const [y, m, day] = today.split("-").map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, day - 1)).toISOString().slice(0, 10);
  if (key === yesterday) return OWNER_ITEMS_TEXT_NB.yesterday;
  return d.toLocaleDateString("nb-NO", { timeZone: "Europe/Oslo", day: "2-digit", month: "2-digit", year: "numeric" });
}

// ─── The view of one row ────────────────────────────────────────────────────

const NOT_HERE_ORDER = ["category_label", "alcohol", "service", "ban_check_failed"];

/** The row's group, chip, line and actions. Pure. */
export function ownerItemView(row: OwnerItemRow, ctx: OwnerItemViewCtx): OwnerItemView {
  const T = OWNER_ITEMS_TEXT_NB;
  const X = OWNER_ITEMS_INVENTED_TEXT_NB;
  const codes = new Set(row.reasons.filter((r) => r.level === "product").map((r) => r.code));
  const missingPrice = row.price_nok == null;
  const confirmable = isConfirmable({ orderable: row.gate_orderable, reasons: row.reasons, stock_expires_at: null }, row.price_nok);
  const canAct = ctx.canEdit && confirmable;
  const date = (ts: string | Date | null | undefined) => formatOwnerItemDate(ts, ctx.now);
  const base = { more: [] as OwnerItemMore[], bulkConfirmable: false, bulkCandidate: false };

  // 1. Not something a stock confirmation can fix: alcohol, services, category names.
  const notHere = NOT_HERE_ORDER.find((c) => codes.has(c as any));
  if (notHere || row.reasons.some((r) => NOT_CONFIRMABLE.has(r.code))) {
    const reason = row.reasons.find((r) => r.code === notHere) ?? row.reasons.find((r) => NOT_CONFIRMABLE.has(r.code))!;
    return { ...base, group: "not_here", chip: "not_orderable", line: `${orderabilityReasonTextNb(reason)}.`, action: null };
  }

  // 2. Scraped rows (not stated by the producer): «Fra nettsiden din».
  if (!isProducerStatedSource(row.availability_source)) {
    return {
      ...base, group: "from_website", chip: "must_confirm",
      line: missingPrice ? T.lineMissingPrice : T.lineFromWebsite,
      action: canAct ? "confirm_price_and_stock" : null,
    };
  }

  // 3. Sold out (stated by the producer).
  if (row.availability === "out_of_stock") {
    const d = date(row.availability_updated_at);
    return {
      ...base, group: "sold_out", chip: "sold_out",
      line: missingPrice ? T.lineMissingPrice : d ? T.lineSoldOut.replace("{dato}", d) : X.lineSoldOutNoDate,
      action: canAct ? "back_in_stock" : null,
    };
  }

  // V1b: «Merk som utsolgt» on every producer-stated row that is not sold out
  // (needs a writing session; no price needed to say a row is sold out).
  const soldOutMore: OwnerItemMore[] = ctx.canEdit ? ["mark_sold_out"] : [];
  const needs = (chip: OwnerItemChip, line: string): OwnerItemView => ({
    group: "needs_action", chip, line: missingPrice ? T.lineMissingPrice : line,
    action: canAct ? "confirm" : null, more: soldOutMore, bulkConfirmable: confirmable, bulkCandidate: true,
  });

  // 4. Expired or not registered in stock: must be confirmed.
  const expired = row.reasons.find((r) => r.code === "stock_status_expired");
  if (expired) {
    const d = date(expired.expired_at ?? null);
    return needs("must_confirm", d ? T.lineExpired.replace("{dato}", d) : X.lineExpiredNoDate);
  }
  if (codes.has("not_in_stock")) return needs("must_confirm", X.lineNotInStock);

  // 5. B2b-1 soft window: still orderable, but should be confirmed.
  if (ctx.softExpiry && row.needs_producer_confirmation && row.stock_confirmed_at) {
    return needs("should_confirm", T.lineSoft.replace("{dato}", date(row.stock_confirmed_at)));
  }

  // 6. In stock. «Kan bestilles» only when the gate says yes; otherwise the
  //    profile blocks it (no chip — the reasons are shown once for the card).
  const chip: OwnerItemChip | null = row.gate_orderable ? "orderable" : null;
  if (row.availability_source === "producer_dashboard") {
    const exp = ctx.softExpiry ? producerStockHardExpiresAt(row.availability_updated_at) : producerStockExpiresAt(row.availability_updated_at);
    const line = T.lineFresh.replace("{dato}", date(row.availability_updated_at)).replace("{dato2}", date(exp));
    return { ...base, group: "orderable", chip, line, action: null, more: [...(canAct ? ["confirm_now" as const] : []), ...soldOutMore] };
  }
  return { ...base, group: "orderable", chip, line: X.lineAdminConfirmed, action: null, more: soldOutMore };
}

/** The label of a group (the «Kan bestilles» group follows orders on/off and the profile). */
export function ownerItemGroupLabel(group: OwnerItemGroup, ctx: Pick<OwnerItemViewCtx, "ordersOn" | "profileEligible">): string {
  if (group === "orderable" && !ctx.ordersOn) return OWNER_ITEMS_TEXT_NB.groups.orderable_orders_off;
  if (group === "orderable" && !ctx.profileEligible) return OWNER_ITEMS_INVENTED_TEXT_NB.groupOrderableProfileBlocked;
  return OWNER_ITEMS_TEXT_NB.groups[group];
}

// ─── Reading the card's data ────────────────────────────────────────────────

export interface OwnerItemsModel {
  rows: OwnerItemRow[];
  /** countOrderableProducts() — the header's n. */
  orderable_count: number;
  /** Every product row of the producer — the header's m. */
  total: number;
  /** Profile-level reasons (shown once); [] when the profile may take orders. */
  profile_reasons: OrderabilityReason[];
  ordersOn: boolean;
  profileEligible: boolean;
  softExpiry: boolean;
  staleDays: number;
  hardStaleDays: number;
  /** V1b: orders.auto_confirm (Mine valg) — «Varen er på lager nå» is then not ticked by default. */
  autoConfirm: boolean;
}

/** The rows and counts for the card, through the order gate itself. */
export function readOwnerItems(agentId: string, db: any = getDb(), now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): OwnerItemsModel {
  const producer = producerOrderability(db, agentId);
  const rows: OwnerItemRow[] = readOwnerProductRows(db, agentId).map((row) => {
    const r = orderabilityReasons(db, row, now, producer);
    return {
      id: row.id,
      name: row.name,
      price_nok: row.price_nok,
      unit: row.unit,
      availability: row.availability,
      availability_source: row.availability_source,
      availability_updated_at: row.availability_updated_at,
      gate_orderable: isRowOrderableForRealOrder(db, row, now),
      reasons: r.reasons,
      ...(r.needs_producer_confirmation && r.stock_confirmed_at
        ? { stock_confirmed_at: r.stock_confirmed_at, needs_producer_confirmation: true as const }
        : {}),
    };
  });
  let ordersOn = false;
  try {
    const o = db.prepare("SELECT order_notifications_opt_in AS v FROM agents WHERE id = ?").get(agentId) as { v?: number } | undefined;
    ordersOn = !!o && o.v === 1;
  } catch { ordersOn = false; }
  let autoConfirm = false;
  try {
    autoConfirm = resolveOwnerFeature("rfb", agentId, "orders.auto_confirm", { db }).value === true;
  } catch { autoConfirm = false; }
  return {
    rows,
    orderable_count: countOrderableProducts(agentId, db, now),
    total: rows.length,
    profile_reasons: producer.eligible ? [] : producer.reasons,
    ordersOn,
    profileEligible: producer.eligible,
    softExpiry: stockSoftExpiryActiveFor(agentId, env),
    staleDays: getSupplyGraphStaleDays(),
    hardStaleDays: getSupplyGraphHardStaleDays(),
    autoConfirm,
  };
}
