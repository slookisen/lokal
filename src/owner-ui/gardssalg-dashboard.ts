// ─── Gårdssalg owner dashboard: shell, tabs and empty states (O2-1) ────────
// dev-request 2026-11-12-opplevagent-o2-eierdashbord-for-besok, slice O2-1.
//
// The RFB owner shell (owner-ui/shell.ts, T15a) reused for the gårdssalg
// owner pages: the same CSS (OWNER_SHELL_CSS), the same skip link, the same
// <nav class="ow-nav"> markup and the same <main id="innhold"> target. Only
// the menu differs — four tabs, from tekstpakke OA-3 part 1.1:
//
//   Oversikt    /kategori/gardssalg/eier/:slug/portal      (the existing portal)
//   Mine besøk  /kategori/gardssalg/eier/:slug/besok       (empty state, O2-1)
//   Mine valg   /kategori/gardssalg/eier/:slug/valg        (existing content)
//   Statistikk  /kategori/gardssalg/eier/:slug/statistikk  (empty state, O2-1)
//
// The RFB shell module is not changed: its menu stays RFB's. The gårdssalg
// pages are light-only, so the T6 tokens the shell CSS reads are declared
// with their light values on the shell's own elements (no `color-scheme`
// change for the page around it).
//
// PURE: no database, no session, no env. The routes decide when the shell is
// on (gardssalgOwnerDashboardActiveFor, routes/gardssalg-owner-features.ts).
// Content rules for drink producers: the shell names no product, brand,
// strength or price — only the tabs and neutral empty states.

import { OWNER_SHELL_CSS, OWNER_SHELL_MAIN_ID, OWNER_SHELL_MAIN_OPEN, OWNER_SHELL_TEXTS } from "./shell";
import { OWNER_TOKENS } from "./tokens";

/** Every owner-facing text of the shell — tekstpakke OA-3 part 1.1, verbatim. */
export const GARDSSALG_DASHBOARD_TEXTS = {
  /** The menu's accessible name and title (as the RFB shell). */
  nav: OWNER_SHELL_TEXTS.nav,
  /** «Hopp til innholdet» (as the RFB shell). */
  skip: OWNER_SHELL_TEXTS.skip,
  "tab.overview": "Oversikt",
  "tab.visits": "Mine besøk",
  "tab.choices": "Mine valg",
  "tab.stats": "Statistikk",
  "empty.visits": "Du har ingen forespørsler ennå. Når noen ber om besøk, får du e-post, og forespørselen dukker opp her.",
  "empty.visitsOff": "«Ta imot besøk» er av. Slå det på under «Mine valg» når du vil ta imot forespørsler.",
  "empty.stats": "Det er ingen tall å vise ennå.",
  "help.contact": "Trenger du hjelp? Skriv til {kontaktadresse}.",
} as const;

export type GardssalgDashboardTab = "oversikt" | "besok" | "valg" | "statistikk";

export const GARDSSALG_DASHBOARD_TABS: readonly GardssalgDashboardTab[] = ["oversikt", "besok", "valg", "statistikk"];

const TAB_TEXT: Record<GardssalgDashboardTab, keyof typeof GARDSSALG_DASHBOARD_TEXTS> = {
  oversikt: "tab.overview",
  besok: "tab.visits",
  valg: "tab.choices",
  statistikk: "tab.stats",
};

/** The path of each tab for a producer slug. */
export function gardssalgDashboardPath(slug: string, tab: GardssalgDashboardTab): string {
  const base = `/kategori/gardssalg/eier/${encodeURIComponent(slug)}`;
  switch (tab) {
    case "oversikt": return `${base}/portal`;
    case "besok": return `${base}/besok`;
    case "valg": return `${base}/valg`;
    case "statistikk": return `${base}/statistikk`;
  }
}

function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>
  )[c]);
}

/** The T6 tokens with their light values, on the shell's own elements only. */
const LIGHT_TOKENS_CSS = `.ow-nav, .ow-skip { ${OWNER_TOKENS.map((t) => `--${t.name}: ${t.light};`).join(" ")} }`;

/**
 * The shell's markup before the page: CSS, «Hopp til innholdet» (first
 * focusable element) and the four-tab menu with aria-current="page" on the
 * current tab.
 */
export function renderGardssalgDashboardStart(slug: string, current: GardssalgDashboardTab): string {
  const T = GARDSSALG_DASHBOARD_TEXTS;
  const items = GARDSSALG_DASHBOARD_TABS.map((tab) =>
    `<li><a class="ow-nav-item" href="${esc(gardssalgDashboardPath(slug, tab))}"${tab === current ? ` aria-current="page"` : ""}>${esc(T[TAB_TEXT[tab]])}</a></li>`,
  ).join("\n      ");
  return `<style>${LIGHT_TOKENS_CSS}${OWNER_SHELL_CSS}</style>
  <a class="ow-skip" href="#${OWNER_SHELL_MAIN_ID}">${esc(T.skip)}</a>
  <nav class="ow-nav" aria-label="${esc(T.nav)}" data-gardssalg-dashboard="1">
    <p class="ow-nav-title">${esc(T.nav)}</p>
    <ul class="ow-nav-list">
      ${items}
    </ul>
  </nav>`;
}

/** The page body inside the shell: the menu, then <main id="innhold">. */
export function wrapGardssalgDashboard(slug: string, current: GardssalgDashboardTab, body: string): string {
  return `${renderGardssalgDashboardStart(slug, current)}${OWNER_SHELL_MAIN_OPEN}${body}</main>`;
}

/** «Trenger du hjelp? Skriv til …» with the address as a mailto link. */
export function gardssalgDashboardHelpHtml(contactEmail: string): string {
  const [before, after] = GARDSSALG_DASHBOARD_TEXTS["help.contact"].split("{kontaktadresse}");
  return `${esc(before)}<a href="mailto:${esc(contactEmail)}">${esc(contactEmail)}</a>${esc(after)}`;
}

/** «Statistikk» in O2-1: the neutral empty state (the numbers come in O2-4). */
export function renderGardssalgStatsEmpty(contactEmail: string): string {
  const T = GARDSSALG_DASHBOARD_TEXTS;
  return `<div class="gc-card" data-gardssalg-empty="statistikk">
    <h1>${esc(T["tab.stats"])}</h1>
    <p>${esc(T["empty.stats"])}</p>
    <p>${gardssalgDashboardHelpHtml(contactEmail)}</p>
  </div>`;
}
