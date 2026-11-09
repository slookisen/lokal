// ─── T13 V1a — the «Varer» card (renderOwnerItemsSection) ──────────────────
// dev-request 2026-10-30-rfb-eierportal-testrunde-1, punkt 7, slice T13 V1a.
// A reusable section (the later dashboard «Varer» page and the owner demo call
// it too): pure rendering of services/owner-items-view.ts readOwnerItems() +
// ownerItemView(). Rendered by routes/owner-portal.ts only for a profile on
// OWNER_FEATURES_ALLOWED_SUBJECTS with OWNER_ORDERABILITY_PORTAL_ENABLED on
// (ownerOrderabilityPortalEnabledFor) — no new flag.
//
// Every form posts to the existing B1 routes (no JavaScript needed):
//   «Bekreft på lager» / «Bekreft pris og lager» / «På lager igjen» /
//   «Bekreft på lager nå»   POST /eier/:id/varer/:productId/bekreft
//                           → 303 …?status=…&ved=vare-<id>#vare-<id>
//   «Bekreft alle ({n})»    POST /eier/:id/varer/bekreft-alle with the ids
//                           → 303 …?status=…#bestillbare-varer
//   «Merk som utsolgt» (V1b, under «Mer»)
//                           POST /eier/:id/varer/:productId/utsolgt
//                           → 303 …?status=vare_utsolgt&ved=vare-<id>#vare-<id>
//   «Legg til vare» (V1b: a closed <details> with Navn, Pris, Enhet, Kategori,
//   «Varen er på lager nå», «Er varen ferdigpakket?» and the food fields)
//                           POST /eier/:id/varer/ny → 303 to the new row; on a
//                           refusal the portal is rendered again with the form
//                           open, the values kept and the message in the form.
// Messages stand in the card, or in the row for a row's own POST (the T5
// anchor contract). All output is HTML-escaped.
//
// T15c: on the owner shell's «Varer» page (/eier/:id/varer) the card is
// rendered with `returnTo: "varer"` — every form then carries the hidden
// field tilbake=varer, and the POST routes send the owner back to the Varer
// page (a fixed internal path, never a URL from the request). Without it the
// card's markup is exactly as before.

import type { OwnerItemsModel, OwnerItemView, OwnerItemAction, OwnerItemGroup } from "../services/owner-items-view";
import {
  OWNER_ITEM_GROUP_ORDER, OWNER_ITEMS_INVENTED_TEXT_NB, OWNER_ITEMS_TEXT_NB, ownerItemGroupLabel, ownerItemView,
} from "../services/owner-items-view";
import { OWNER_PRODUCT_FIELD_TEXT_NB, orderabilityReasonTextNb, type OwnerProductField } from "../services/owner-orderability";

/** The card's id (kept from B1: bulk, add and old links land here). */
export const OWNER_ITEMS_ANCHOR = "bestillbare-varer";

/** T15c: the hidden form field that says «the form was on the Varer page». */
export const OWNER_ITEMS_RETURN_FIELD = "tilbake";
/** T15c: its one value. */
export const OWNER_ITEMS_RETURN_VARER = "varer";

/** T15c: the hidden field for a form on the Varer page ("" elsewhere, so the card is unchanged). */
export function ownerItemsReturnInput(returnTo: "varer" | null | undefined): string {
  return returnTo === OWNER_ITEMS_RETURN_VARER ? `<input type="hidden" name="${OWNER_ITEMS_RETURN_FIELD}" value="${OWNER_ITEMS_RETURN_VARER}">` : "";
}

/** One row's element id: li#vare-<id>. */
export function ownerItemAnchor(productId: string): string {
  return `vare-${productId}`;
}

function esc(text: unknown): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
  return String(text ?? "").replace(/[&<>"']/g, (c) => map[c]);
}

function formatPrice(price: number | null, unit: string | null): string {
  if (price == null) return "Ingen pris";
  const p = Number.isInteger(price) ? String(price) : price.toFixed(2).replace(".", ",");
  return `kr ${p}${unit ? ` / ${unit}` : ""}`;
}

/** «{k} varer ble ikke bekreftet fordi de mangler pris.» ("" for k ≤ 0). */
export function ownerItemsMissingPriceText(k: number): string {
  if (!Number.isFinite(k) || k <= 0) return "";
  if (k === 1) return OWNER_ITEMS_INVENTED_TEXT_NB.notConfirmedMissingPriceOne;
  return OWNER_ITEMS_TEXT_NB.notConfirmedMissingPrice.replace("{k}", String(Math.floor(k)));
}

/** The header line «{n} av {m} varer kan bestilles nå.» */
export function ownerItemsCountLine(n: number, m: number): string {
  if (m === 1) return OWNER_ITEMS_INVENTED_TEXT_NB.countLineOne.replace("{n}", String(n));
  return OWNER_ITEMS_TEXT_NB.countLine.replace("{n}", String(n)).replace("{m}", String(m));
}

/** The one explanation line, with or without soft expiry. */
export function ownerItemsValidityLine(model: Pick<OwnerItemsModel, "softExpiry" | "staleDays" | "hardStaleDays">): string {
  return model.softExpiry
    ? OWNER_ITEMS_TEXT_NB.validitySoft.replace("{14}", String(model.staleDays)).replace("{60}", String(model.hardStaleDays))
    : OWNER_ITEMS_TEXT_NB.validity.replace("{14}", String(model.staleDays));
}

const ACTION_LABEL: Record<OwnerItemAction, string> = {
  confirm: OWNER_ITEMS_TEXT_NB.actionConfirm,
  confirm_price_and_stock: OWNER_ITEMS_TEXT_NB.actionConfirmPriceAndStock,
  back_in_stock: OWNER_ITEMS_TEXT_NB.actionBackInStock,
};

export interface OwnerItemsMessage {
  ok: boolean;
  text: string;
  /** A row's own POST: the message stands in that row (else in the card). */
  productId?: string | null;
}

/** V1b: the «Legg til vare» form as it was posted (shown again, open, after a refusal). */
export interface OwnerItemsAddFormValues {
  name: string;
  price: string;
  unit: string;
  category: string;
  in_stock: boolean;
  packaged: boolean;
  ingredients: string;
  allergens: string;
  net_weight: string;
}

export interface OwnerItemsAddFormState {
  values: OwnerItemsAddFormValues;
  /** The refusal, shown in the form. */
  message: string;
  /** The fields to mark invalid (the first one gets autofocus, so the page scrolls to it without JavaScript). */
  fields: OwnerProductField[];
}

/** The posted body → the values to show again (strings only, length-capped; never trusted for anything but display). */
export function ownerItemsAddFormValues(body: Record<string, unknown>): OwnerItemsAddFormValues {
  const t = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  return {
    name: t(body.name, 200),
    price: t(body.price, 40),
    unit: t(body.unit, 60),
    category: t(body.category, 80),
    in_stock: body.paa_lager === "1",
    packaged: body.ferdigpakket === "ja",
    ingredients: t(body.ingredients, 3000),
    allergens: t(body.allergens, 1500),
    net_weight: t(body.net_weight, 40),
  };
}

/** «Varen ble ikke lagt til. …» for the refused fields (B1 texts, V1b texts for the new cases). */
export function ownerItemsAddErrorText(fields: readonly OwnerProductField[]): string {
  const X = OWNER_ITEMS_INVENTED_TEXT_NB.fieldErrors as Record<string, string>;
  const B1 = OWNER_PRODUCT_FIELD_TEXT_NB as Record<string, string>;
  const detail = fields.map((f) => X[f] ?? B1[f] ?? "").filter(Boolean).join(" ");
  return `Varen ble ikke lagt til. ${detail || "Sjekk feltene og prøv igjen."}`;
}

export interface OwnerItemsSectionInput {
  agentId: string;
  model: OwnerItemsModel;
  now: Date;
  /** The session is the verified claimant's own login: buttons and forms. Otherwise the list only. */
  canEdit: boolean;
  /** The existing products.stock_check reminder box (stockCheckBannerHtml), "" when none. */
  bannerHtml?: string;
  message?: OwnerItemsMessage | null;
  /** V1b: the posted «Legg til vare» form after a refusal (the form opens with these values). */
  addForm?: OwnerItemsAddFormState | null;
  /** T15c: the card stands on the Varer page — its forms say so (tilbake=varer). */
  returnTo?: "varer" | null;
}

function alertHtml(m: OwnerItemsMessage): string {
  return m.ok
    ? `<div class="ep-alert ep-alert-ok" role="status" data-items-message="1">${esc(m.text)}</div>`
    : `<div class="ep-alert ep-alert-error" role="alert" data-items-message="1">${esc(m.text)}</div>`;
}

/** Which form field a refused field marks. */
const FIELD_INPUT: Record<OwnerProductField, string> = {
  name: "name", price: "price", unit: "unit", category: "category",
  ingredients: "ingredients", ingredients_required: "ingredients",
  allergens: "allergens", allergens_required: "allergens",
  net_weight: "net_weight", net_weight_required: "net_weight",
};

/**
 * V1b «Legg til vare»: a closed <details> until opened (open again after a
 * refusal). Works without JavaScript: the food fields are always there, and
 * the server requires them when «Er varen ferdigpakket?» = Ja. The hidden
 * `skjema=v1b` tells the route that an unticked «Varen er på lager nå» means
 * «not in stock» (an unticked box sends nothing).
 */
/**
 * F-e: the «Legg til vare» summary is display:flex (inline style), which drops
 * the disclosure marker; a ▸ that turns when open shows it can be expanded.
 * The marker has empty alt text, so screen readers keep the summary's own
 * expanded/collapsed state. Rendered with the form only.
 */
export const ITEMS_ADD_SUMMARY_CSS = `.ep-items-add > summary::before { content: "\\25B8"; content: "\\25B8" / ""; display: inline-block; flex: none; width: 1em; text-align: center; transition: transform 0.15s ease; }
  .ep-items-add[open] > summary::before { transform: rotate(90deg); }
  @media (prefers-reduced-motion: reduce) { .ep-items-add > summary::before { transition: none; } }`;

function addProductFormHtml(id: string, model: Pick<OwnerItemsModel, "ordersOn" | "autoConfirm">, state: OwnerItemsAddFormState | null, back = ""): string {
  const T = OWNER_ITEMS_TEXT_NB;
  const X = OWNER_ITEMS_INVENTED_TEXT_NB;
  const v: OwnerItemsAddFormValues = state?.values ?? {
    name: "", price: "", unit: "", category: "", in_stock: !model.autoConfirm, packaged: false, ingredients: "", allergens: "", net_weight: "",
  };
  const bad = new Set((state?.fields ?? []).map((f) => FIELD_INPUT[f]).filter(Boolean));
  const first = ["name", "price", "unit", "category", "ingredients", "allergens", "net_weight"].find((f) => bad.has(f)) ?? null;
  const attrs = (name: string) => `${bad.has(name) ? ' aria-invalid="true"' : ""}${first === name ? " autofocus" : ""}`;
  const hint = (name: string, text: string) => `<div class="ep-hint" id="ny_${name}_hint">${esc(text)}</div>`;
  const field = (name: string, label: string, value: string, extra: string, hintText?: string) =>
    `<div class="ep-field"><label for="ny_${name}">${esc(label)}</label><input id="ny_${name}" name="${name}" type="text" value="${esc(value)}" ${extra}${hintText ? ` aria-describedby="ny_${name}_hint"` : ""}${attrs(name)}>${hintText ? hint(name, hintText) : ""}</div>`;
  const choice = "display:flex;align-items:center;gap:10px;min-height:44px;cursor:pointer;";
  const box = "width:24px;height:24px;margin:0;flex:none;";
  const stockHints = [model.ordersOn ? T.inStockOrdersOnHint : "", model.autoConfirm ? X.inStockAutoConfirmHint : ""].filter(Boolean);
  const errorHtml = state ? `<div class="ep-alert ep-alert-error" role="alert" data-items-message="1" data-items-add-error="1">${esc(state.message)}</div>` : "";
  return `<style>${ITEMS_ADD_SUMMARY_CSS}</style>
        <details class="ep-items-add" data-items-add="1" style="margin-top:20px;"${state ? " open" : ""}>
          <summary style="${choice}font-weight:600;">${esc(T.addTitle)}</summary>
          ${errorHtml}
          <form method="post" action="/eier/${id}/varer/ny" data-items-add-form="v1b">
            <input type="hidden" name="skjema" value="v1b">${back}
            ${field("name", T.fieldName, v.name, 'required maxlength="120"')}
            ${field("price", T.fieldPrice, v.price, 'required inputmode="decimal"')}
            ${field("unit", T.fieldUnit, v.unit, 'maxlength="30"', X.unitHint)}
            ${field("category", T.fieldCategory, v.category, 'maxlength="40"')}
            <div class="ep-items-choice" style="margin-bottom:16px;">
              <label style="${choice}"><input type="checkbox" name="paa_lager" value="1" style="${box}"${v.in_stock ? " checked" : ""} data-in-stock-default="${model.autoConfirm ? "0" : "1"}"> ${esc(T.fieldInStock)}</label>
              ${stockHints.map((h) => `<div class="ep-audit-meta" data-in-stock-hint="1">${esc(h)}</div>`).join("")}
            </div>
            <fieldset style="border:none;padding:0;margin:0 0 16px;">
              <legend style="font-weight:600;margin-bottom:4px;">${esc(T.packagedQuestion)}</legend>
              <label style="${choice}"><input type="radio" name="ferdigpakket" value="ja" style="${box}"${v.packaged ? " checked" : ""}> ${esc(X.packagedYes)}</label>
              <label style="${choice}"><input type="radio" name="ferdigpakket" value="nei" style="${box}"${v.packaged ? "" : " checked"}> ${esc(X.packagedNo)}</label>
              <div class="ep-audit-meta">${esc(X.packagedFieldsHint)}</div>
            </fieldset>
            <div class="ep-field"><label for="ny_ingredients">${esc(X.fieldIngredients)}</label><textarea id="ny_ingredients" name="ingredients" maxlength="1500"${attrs("ingredients")}>${esc(v.ingredients)}</textarea></div>
            ${field("allergens", X.fieldAllergens, v.allergens, "", X.allergensHint)}
            ${field("net_weight", X.fieldNetWeight, v.net_weight, 'maxlength="20"', X.netWeightHint)}
            <div class="ep-form-actions"><button type="submit" class="ep-btn ep-btn-primary">${esc(T.addTitle)}</button></div>
          </form>
        </details>`;
}

/** The «Varer» card. */
export function renderOwnerItemsSection(input: OwnerItemsSectionInput): string {
  const T = OWNER_ITEMS_TEXT_NB;
  const { model, now, canEdit } = input;
  const id = encodeURIComponent(input.agentId);
  const ctx = { now, softExpiry: model.softExpiry, ordersOn: model.ordersOn, profileEligible: model.profileEligible, canEdit };
  const views = model.rows.map((row) => ({ row, view: ownerItemView(row, ctx) }));
  const msg = input.message ?? null;
  const rowMessageId = msg && msg.productId && views.some((v) => v.row.id === msg.productId) ? msg.productId : null;
  const cardMessage = msg && !rowMessageId ? alertHtml(msg) : "";
  const back = ownerItemsReturnInput(input.returnTo);

  const rowForm = (productId: string, path: "bekreft" | "utsolgt", label: string, cls: string) =>
    `<form method="post" action="/eier/${id}/varer/${esc(encodeURIComponent(productId))}/${path}" style="margin:6px 0 0;">${back}
            <button type="submit" class="ep-btn ${cls}">${esc(label)}</button>
          </form>`;
  const confirmForm = (productId: string, label: string, cls: string) => rowForm(productId, "bekreft", label, cls);

  const rowHtml = ({ row, view }: { row: OwnerItemsModel["rows"][number]; view: OwnerItemView }): string => {
    const chip = view.chip
      ? `<strong class="${view.chip === "orderable" ? "ep-orderable-yes" : "ep-orderable-no"}" data-chip="${view.chip}">${esc(T.chips[view.chip])}</strong> `
      : "";
    const action = canEdit && view.action ? confirmForm(row.id, ACTION_LABEL[view.action], "ep-btn-secondary") : "";
    const more = canEdit && view.more.length
      ? `<details class="ep-item-more" style="margin:6px 0 0;"><summary>${esc(T.more)}</summary>
            ${view.more.map((m) => m === "mark_sold_out"
              ? rowForm(row.id, "utsolgt", T.moreMarkSoldOut, "ep-btn-secondary")
              : confirmForm(row.id, T.moreConfirmNow, "ep-btn-secondary")).join("")}
          </details>`
      : "";
    const rowMsg = rowMessageId === row.id && msg ? alertHtml(msg) : "";
    return `<li class="ep-audit-item" id="${esc(`vare-${row.id}`)}" data-product-id="${esc(row.id)}" data-orderable="${row.gate_orderable ? "1" : "0"}" data-group="${view.group}" data-chip="${view.chip ?? ""}" data-action="${canEdit && view.action ? view.action : ""}">
          <div><strong>${esc(row.name)}</strong> <span class="ep-audit-meta">${esc(formatPrice(row.price_nok, row.unit))}</span></div>
          <div>${chip}<span class="ep-audit-meta" data-item-line="1">${esc(view.line)}</span></div>
          ${rowMsg}${action}${more}
        </li>`;
  };

  const groupIntro: Partial<Record<OwnerItemGroup, string>> = { from_website: T.fromWebsiteIntro, not_here: T.notHereIntro };
  const groupsHtml = OWNER_ITEM_GROUP_ORDER.map((g) => {
    const items = views.filter((v) => v.view.group === g);
    if (items.length === 0) return "";
    const label = esc(ownerItemGroupLabel(g, ctx));
    const intro = groupIntro[g] ? `<p class="ep-audit-meta">${esc(groupIntro[g])}</p>` : "";
    const list = `<ul class="ep-audit-list">${items.map(rowHtml).join("")}</ul>`;
    if (g === "not_here") {
      return `<details class="ep-items-group" data-items-group="${g}" style="margin-top:16px;"><summary><strong>${label}</strong> (${items.length})</summary>
          ${intro}${list}
        </details>`;
    }
    return `<section class="ep-items-group" data-items-group="${g}" style="margin-top:16px;">
          <h3>${label}</h3>
          ${intro}${list}
        </section>`;
  }).join("");

  // «Bekreft alle ({n})»: only with ≥ 2 confirmable rows in «Trenger handling»;
  // n counts only those (scraped rows are never in that group). The form also
  // sends the group's unpriced producer-stated rows, so the answer can say how
  // many were not confirmed for want of a price.
  const bulkN = views.filter((v) => v.view.group === "needs_action" && v.view.bulkConfirmable).length;
  const bulkIds = views.filter((v) => v.view.group === "needs_action" && v.view.bulkCandidate).map((v) => v.row.id);
  const bulk = canEdit && bulkN >= 2
    ? `<form method="post" action="/eier/${id}/varer/bekreft-alle" style="margin:12px 0 0;" data-confirm-all="${bulkN}">${back}
          ${bulkIds.map((pid) => `<input type="hidden" name="id" value="${esc(pid)}">`).join("")}
          <button type="submit" class="ep-btn ep-btn-primary">${esc(T.confirmAll.replace("{n}", String(bulkN)))}</button>
        </form>`
    : "";

  const profileHtml = model.profile_reasons.length
    ? `<div class="ep-alert ep-alert-error" role="note" data-orderability-profile="blocked"><strong>${esc(T.profileBlocked)}</strong><ul>${model.profile_reasons.map((r) => `<li data-reason="${esc(r.code)}">${esc(orderabilityReasonTextNb(r))}</li>`).join("")}</ul><a href="/eier/${id}/valg">${esc(T.goToChoices)}</a></div>`
    : "";

  const head = model.total
    ? `<p data-orderable-count="${model.orderable_count}">${esc(ownerItemsCountLine(model.orderable_count, model.total))}</p>`
    : `<p data-items-empty="1">${esc(T.empty)}</p>`;
  const readOnly = canEdit ? "" : `<p class="ep-audit-meta" data-items-read-only="1">${esc(T.readOnly)}</p>`;

  // Tekstpakke B: on the Varer page (returnTo "varer") the page's own <h1>
  // «Varer» stands right above, so the card has no second «Varer» heading.
  const titleHtml = input.returnTo === OWNER_ITEMS_RETURN_VARER ? "" : `\n        <h2>${esc(T.title)}</h2>`;
  return `<div class="ep-card" id="${OWNER_ITEMS_ANCHOR}" data-items-card="t13">${titleHtml}
        ${cardMessage}${canEdit ? input.bannerHtml ?? "" : ""}
        ${head}
        <p class="ep-audit-meta" data-items-validity="${model.softExpiry ? "soft" : "hard"}">${esc(ownerItemsValidityLine(model))}</p>
        ${profileHtml}${readOnly}
        ${bulk}
        ${groupsHtml}
        ${canEdit ? addProductFormHtml(id, model, input.addForm ?? null, back) : ""}
      </div>`;
}
