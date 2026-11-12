/**
 * «Klikk fra AI-svar · 60d: N» tile (dev-request 2026-10-14-klikk-fra-ai-svar-
 * per-profil, slice 5a): visits from people who clicked through to the profile
 * from an AI assistant's answer, last 60 days, split per AI in the tooltip.
 * Twin of the «Med i AI-søk» tile (profile-ai-deliveries-tile.ts on dental /
 * experiences / gårdssalg pages, the pf-stat in seo.ts on the rfb producer
 * page); read server-side at render time, only daily sums, never a visit.
 *
 * Display rule (as the sister tile, Daniel 2026-10-15): never a 0, never «60d»
 * for a counting younger than the window. At 0 while the counting is younger
 * than the window the tile shows «Fra <dato>» instead of the number; with
 * clicks it says «siden <dato>» until a whole window has passed, then «60d».
 * A 0 over a full window, or a vertical with no counting yet, shows no tile.
 * Any read error → no tile; the page renders as before.
 */

import { getDb } from "../database/init";
import {
  AI_CLICK_WINDOW_DAYS, getProfileAiClicksTile, type AiClickVendor, type ProfileAiClicksTile,
} from "./profile-ai-clicks-compute";

type Lang = "nb" | "en";

const DAY_MS = 24 * 60 * 60 * 1000;

export const AI_CLICKS_LABEL = { nb: "Klikk fra AI-svar", en: "Clicks from AI answers" } as const;
export const AI_CLICKS_SUBTITLE = {
  nb: "besøk fra folk som klikket seg inn fra et AI-svar (minst)",
  en: "visits from people who clicked through from an AI answer (at least)",
} as const;

const VENDOR_LABELS: Array<[AiClickVendor, { nb: string; en: string }]> = [
  ["chatgpt", { nb: "ChatGPT", en: "ChatGPT" }],
  ["claude", { nb: "Claude", en: "Claude" }],
  ["perplexity", { nb: "Perplexity", en: "Perplexity" }],
  ["gemini", { nb: "Gemini", en: "Gemini" }],
  ["copilot", { nb: "Copilot", en: "Copilot" }],
  ["other", { nb: "Annet", en: "Other" }],
];

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function shortDate(day: string, lang: Lang): string {
  return new Date(Date.parse(day + "T00:00:00Z"))
    .toLocaleDateString(lang === "en" ? "en-GB" : "nb-NO", { day: "numeric", month: "short", timeZone: "UTC" });
}

export interface AiClicksTileView {
  /** The number slot: the count, or «Fra <dato>» at 0 inside the first window. */
  value: string;
  /** Text after the label: «60d» over a full window, «siden <dato>» before; "" at 0. */
  period: string;
  /** Tooltip: help text, then the split per AI. */
  help: string;
  total: number;
}

/** The tile's words, or null when no tile is shown (no counting, or 0 over a full window). */
export function aiClicksTileView(c: ProfileAiClicksTile | null | undefined, nowMs: number, lang: Lang = "nb"): AiClicksTileView | null {
  if (!c || !c.countingSince) return null;
  const sinceMs = Date.parse(c.countingSince + "T00:00:00Z");
  if (Number.isNaN(sinceMs)) return null;
  const windowDays = c.windowDays || AI_CLICK_WINDOW_DAYS;
  // Same cut as aiDeliveriesPeriodLabel: partial while the first counted day is inside the window.
  const partial = nowMs - sinceMs < (windowDays - 1) * DAY_MS;
  const total = c.total > 0 ? c.total : 0;
  if (total === 0 && !partial) return null;
  const date = shortDate(c.countingSince, lang);
  const en = lang === "en";
  const helpPeriod = partial ? (en ? `since ${date}` : `siden ${date}`) : (en ? `in the last ${windowDays} days` : `de siste ${windowDays} dagene`);
  const parts = VENDOR_LABELS.filter(([k]) => c.byVendor[k] > 0).map(([k, l]) => `${l[lang]} ${c.byVendor[k].toLocaleString(en ? "en-GB" : "nb-NO")}`);
  const help = (en
    ? `Number of visits from people who clicked through to this profile from an AI assistant's answer (ChatGPT, Claude, Perplexity …), ${helpPeriod}. It is a minimum: not every AI tells us where a visit came from.`
    : `Antall besøk fra folk som klikket seg inn på profilen fra et svar i en AI-assistent (ChatGPT, Claude, Perplexity …), ${helpPeriod}. Tallet er et minimum: ikke alle AI-er sier fra hvor besøket kom fra.`)
    + (parts.length ? `\n${parts.join(" · ")}` : "");
  if (total === 0) return { value: en ? `From ${date}` : `Fra ${date}`, period: "", help, total };
  return {
    value: total.toLocaleString(en ? "en-GB" : "nb-NO"),
    period: partial ? (en ? `since ${date}` : `siden ${date}`) : `${windowDays}d`,
    help,
    total,
  };
}

function headline(v: AiClicksTileView, lang: Lang): string {
  const label = escapeHtml(AI_CLICKS_LABEL[lang]);
  const strong = `<strong data-fill="aiClicks">${escapeHtml(v.value)}</strong>`;
  return v.period ? `${label} &middot; ${escapeHtml(v.period)}: ${strong}` : `${label} &middot; ${strong}`;
}

/** Pure render for the dental / experiences / gårdssalg pages (style of aiDeliveriesTileHtml). */
export function aiClicksTileHtml(c: ProfileAiClicksTile | null | undefined, nowMs: number = Date.now(), lang: Lang = "nb"): string {
  const v = aiClicksTileView(c, nowMs, lang);
  if (!v) return "";
  return `<div class="ai-clicks-tile" data-ai-clicks="${v.total}" title="${escapeHtml(v.help)}" style="display:inline-flex;align-items:center;gap:10px;margin:0 0 20px;padding:10px 14px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc">`
    + `<span aria-hidden="true">&#128433;</span>`
    + `<span>${headline(v, lang)}<br><small style="color:#64748b">${escapeHtml(AI_CLICKS_SUBTITLE[lang])}</small></span></div>`;
}

/**
 * Pure render for the rfb producer page's .pf-stats row (next to «Med i AI-søk»),
 * in that row's layout: the number (or «Fra <dato>») above «Klikk fra AI-svar · 60d».
 * No data-stat attribute: those tiles are hidden by CSS until the page's script
 * fills them, while this one is complete server-side (no script, no API change).
 */
export function aiClicksPfStatHtml(c: ProfileAiClicksTile | null | undefined, nowMs: number = Date.now(), lang: Lang = "nb"): string {
  const v = aiClicksTileView(c, nowMs, lang);
  if (!v) return "";
  return `<div class="pf-stat" data-ai-clicks="${v.total}" title="${escapeHtml(v.help)}"><div class="pf-stat-icon a">&#128433;</div>`
    + `<div><strong data-fill="aiClicks">${escapeHtml(v.value)}</strong><small>${escapeHtml(AI_CLICKS_LABEL[lang])}${v.period ? ` &middot; ${escapeHtml(v.period)}` : ""}`
    + `<br><span class="pf-stat-meta">${escapeHtml(AI_CLICKS_SUBTITLE[lang])}</span></small></div></div>`;
}

function read(vertical: "rfb" | "dental" | "experiences", profileId: string, nowMs: number): ProfileAiClicksTile {
  return getProfileAiClicksTile(getDb(), vertical, String(profileId), nowMs);
}

/** Reads the 60-day sums for one profile and renders the tile; "" on any failure. */
export function aiClicksTileFor(vertical: "dental" | "experiences", profileId: string, lang: Lang = "nb"): string {
  try {
    const now = Date.now();
    return aiClicksTileHtml(read(vertical, profileId, now), now, lang);
  } catch {
    return "";
  }
}

/** The rfb producer page's pf-stat; "" on any failure. */
export function aiClicksPfStatFor(profileId: string, lang: Lang = "nb"): string {
  try {
    const now = Date.now();
    return aiClicksPfStatHtml(read("rfb", profileId, now), now, lang);
  } catch {
    return "";
  }
}
