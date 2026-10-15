/**
 * «Med i AI-svar · 60d» tile for dental clinic and experience / gårdssalg
 * profile pages (dev-request 2026-10-14-med-i-ai-svar-per-profil, S2). Same
 * numbers, wording and help text as the rfb producer page tile (seo.ts); the
 * count is read server-side at render time and the tile is left out while it
 * is 0. «Sendt til AI-en», never «vist»: it does not say anybody saw it.
 */

import { getDb } from "../database/init";
import {
  AI_DELIVERY_WINDOW_DAYS, computeAiDeliveries, type AiDeliveries,
} from "./profile-ai-deliveries-compute";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const VENDOR_LABELS: Array<[keyof AiDeliveries["byVendor"], string]> = [
  ["chatgpt", "ChatGPT"], ["claude", "Claude"], ["perplexity", "Perplexity"], ["other", "Annet"], ["unknown", "Ukjent"],
];

/** Pure render: "" when nothing was sent to an AI in the window. */
export function aiDeliveriesTileHtml(d: AiDeliveries | null | undefined): string {
  if (!d || !(d.total > 0)) return "";
  const parts = VENDOR_LABELS.filter(([k]) => d.byVendor[k] > 0).map(([k, label]) => `${label} ${d.byVendor[k]}`);
  const help = `Antall ganger profilen er sendt til AI-assistenter som ChatGPT og Claude som svar på spørsmål, siste ${AI_DELIVERY_WINDOW_DAYS} dager. Tallet viser ikke hvor mange som så den.`
    + (parts.length ? `\n${parts.join(" · ")}` : "");
  return `<div class="ai-deliveries-tile" data-stat="aiDeliveries" title="${escapeHtml(help)}" style="display:inline-flex;align-items:center;gap:10px;margin:0 0 20px;padding:10px 14px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc">`
    + `<span aria-hidden="true">&#128228;</span>`
    + `<span><strong data-fill="aiDeliveries">${d.total.toLocaleString("nb")}</strong> `
    + `<span>Med i AI-svar</span><br><small style="color:#64748b">sendt til AI-en &middot; ${AI_DELIVERY_WINDOW_DAYS}d</small></span></div>`;
}

/** Reads the 60-day sums for one profile and renders the tile; "" on any failure. */
export function aiDeliveriesTileFor(vertical: "dental" | "experiences", profileId: string): string {
  try {
    return aiDeliveriesTileHtml(computeAiDeliveries(getDb(), vertical, profileId, AI_DELIVERY_WINDOW_DAYS, Date.now()));
  } catch {
    return "";
  }
}
