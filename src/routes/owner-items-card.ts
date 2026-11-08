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
//   «Legg til vare»         POST /eier/:id/varer/ny (the form as before)
// Messages stand in the card, or in the row for a row's own POST (the T5
// anchor contract). All output is HTML-escaped.

import type { OwnerItemsModel, OwnerItemView, OwnerItemAction, OwnerItemGroup } from "../services/owner-items-view";
import {
  OWNER_ITEM_GROUP_ORDER, OWNER_ITEMS_INVENTED_TEXT_NB, OWNER_ITEMS_TEXT_NB, ownerItemGroupLabel, ownerItemView,
} from "../services/owner-items-view";
import { orderabilityReasonTextNb } from "../services/owner-orderability";

/** The card's id (kept from B1: bulk, add and old links land here). */
export const OWNER_ITEMS_ANCHOR = "bestillbare-varer";

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

export interface OwnerItemsSectionInput {
  agentId: string;
  model: OwnerItemsModel;
  now: Date;
  /** The session is the verified claimant's own login: buttons and forms. Otherwise the list only. */
  canEdit: boolean;
  /** The existing products.stock_check reminder box (stockCheckBannerHtml), "" when none. */
  bannerHtml?: string;
  message?: OwnerItemsMessage | null;
}

function alertHtml(m: OwnerItemsMessage): string {
  return m.ok
    ? `<div class="ep-alert ep-alert-ok" role="status" data-items-message="1">${esc(m.text)}</div>`
    : `<div class="ep-alert ep-alert-error" role="alert" data-items-message="1">${esc(m.text)}</div>`;
}

/** The add-product form, as in the B1 card (V1b changes it, not V1a). */
function addProductFormHtml(id: string): string {
  const field = (name: string, label: string, type = "text", extra = "") =>
    `<div class="ep-field"><label for="ny_${name}">${esc(label)}</label><input id="ny_${name}" name="${name}" type="${type}" ${extra}></div>`;
  return `<h3 style="margin-top:20px;">Legg til vare</h3>
        <form method="post" action="/eier/${id}/varer/ny">
          ${field("name", "Navn", "text", 'required maxlength="120"')}
          ${field("price", "Pris (kr)", "text", 'required inputmode="decimal"')}
          ${field("unit", "Enhet (f.eks. kg, stk)", "text", 'maxlength="30"')}
          <div class="ep-field"><label for="ny_ingredients">Ingredienser (valgfritt)</label><textarea id="ny_ingredients" name="ingredients" maxlength="1500"></textarea></div>
          ${field("allergens", "Allergener (valgfritt, skill med komma)", "text")}
          ${field("net_weight", "Nettovekt (valgfritt, f.eks. 250 g)", "text", 'maxlength="20"')}
          <div class="ep-form-actions"><button type="submit" class="ep-btn ep-btn-primary">Legg til vare</button></div>
        </form>`;
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

  const confirmForm = (productId: string, label: string, cls: string) =>
    `<form method="post" action="/eier/${id}/varer/${esc(encodeURIComponent(productId))}/bekreft" style="margin:6px 0 0;">
            <button type="submit" class="ep-btn ${cls}">${esc(label)}</button>
          </form>`;

  const rowHtml = ({ row, view }: { row: OwnerItemsModel["rows"][number]; view: OwnerItemView }): string => {
    const chip = view.chip
      ? `<strong class="${view.chip === "orderable" ? "ep-orderable-yes" : "ep-orderable-no"}" data-chip="${view.chip}">${esc(T.chips[view.chip])}</strong> `
      : "";
    const action = canEdit && view.action ? confirmForm(row.id, ACTION_LABEL[view.action], "ep-btn-secondary") : "";
    const more = canEdit && view.more.length
      ? `<details class="ep-item-more" style="margin:6px 0 0;"><summary>${esc(T.more)}</summary>
            ${view.more.map(() => confirmForm(row.id, T.moreConfirmNow, "ep-btn-secondary")).join("")}
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
    ? `<form method="post" action="/eier/${id}/varer/bekreft-alle" style="margin:12px 0 0;" data-confirm-all="${bulkN}">
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

  return `<div class="ep-card" id="${OWNER_ITEMS_ANCHOR}" data-items-card="t13">
        <h2>${esc(T.title)}</h2>
        ${cardMessage}${canEdit ? input.bannerHtml ?? "" : ""}
        ${head}
        <p class="ep-audit-meta" data-items-validity="${model.softExpiry ? "soft" : "hard"}">${esc(ownerItemsValidityLine(model))}</p>
        ${profileHtml}${readOnly}
        ${bulk}
        ${groupsHtml}
        ${canEdit ? addProductFormHtml(id) : ""}
      </div>`;
}
