/**
 * «Med i AI-søk» (was «Med i AI-svar · 60d») tile for dental clinic and experience / gårdssalg
 * profile pages (dev-request 2026-10-14-med-i-ai-svar-per-profil, S2). Same
 * numbers, wording and help text as the rfb producer page tile (seo.ts); the
 * count is read server-side at render time and the tile is left out while it
 * is 0. «Sendt til AI-en», never «vist»: it does not say anybody saw it.
 *
 * Window: the last 12 months, labelled «siste 12 måneder» or «siden <dato>»
 * exactly like the site strip (dev-request 2026-10-22-statistikk-samme-tall-
 * 12-mnd, S2c).
 */

import { getDb } from "../database/init";
import {
  AI_DELIVERIES_LABEL, AI_DELIVERIES_SUBTITLE, computeAiDeliveries, type AiDeliveries,
} from "./profile-ai-deliveries-compute";
import { aiDeliveriesYearPeriodLabel } from "./profile-year-compute";
import { TRAFFIC_YEAR_DAYS } from "./traffic-year-compute";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const VENDOR_LABELS: Array<[keyof AiDeliveries["byVendor"], string]> = [
  ["chatgpt", "ChatGPT"], ["claude", "Claude"], ["perplexity", "Perplexity"], ["other", "Annet"], ["unknown", "Ukjent"],
];

/** Pure render: "" when nothing was sent to an AI in the window. */
export function aiDeliveriesTileHtml(d: AiDeliveries | null | undefined, nowMs: number = Date.now()): string {
  if (!d || !(d.total > 0)) return "";
  const parts = VENDOR_LABELS.filter(([k]) => d.byVendor[k] > 0).map(([k, label]) => `${label} ${d.byVendor[k]}`);
  const period = aiDeliveriesYearPeriodLabel(d.countingSince, nowMs, "nb");
  const help = `Antall ganger profilen var blant treffene en AI-assistent som ChatGPT eller Claude hentet for noen som spurte (søk, sted, kategori, profilsiden, MCP eller A2A), ${period}. Tallet viser ikke hvor mange som så den.`
    + (parts.length ? `\n${parts.join(" · ")}` : "");
  return `<div class="ai-deliveries-tile" data-stat="aiDeliveries" title="${escapeHtml(help)}" style="display:inline-flex;align-items:center;gap:10px;margin:0 0 20px;padding:10px 14px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc">`
    + `<span aria-hidden="true">&#128228;</span>`
    + `<span><strong data-fill="aiDeliveries">${d.total.toLocaleString("nb")}</strong> `
    + `<span>${AI_DELIVERIES_LABEL.nb}</span><br><small style="color:#64748b">${AI_DELIVERIES_SUBTITLE.nb} &middot; ${escapeHtml(period)}</small></span></div>`;
}

/** Reads the 12-month sums for one profile (indexed by vertical, profile and day) and renders the tile; "" on any failure. */
export function aiDeliveriesTileFor(vertical: "dental" | "experiences", profileId: string): string {
  try {
    return aiDeliveriesTileHtml(computeAiDeliveries(getDb(), vertical, profileId, TRAFFIC_YEAR_DAYS, Date.now()));
  } catch {
    return "";
  }
}
