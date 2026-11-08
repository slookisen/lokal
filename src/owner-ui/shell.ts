// ─── Owner portal: shared shell and menu (eierportal T15a) ─────────────────
// dev-request 2026-10-30-rfb-eierportal-testrunde-1, punkt 9 «eierportalen som
// dashbord», slice T15a «skall og meny».
//
// One shell around the three existing owner pages — Oversikt
// (/eier/:id/portal), Mine ordrer (/eier/:id/ordrer) and Mine valg
// (/eier/:id/valg):
//
//   - «Hopp til innholdet» is the first focusable element, to `#innhold`
//     (the page's <main>);
//   - exactly one <nav aria-label="Eierportal">, with aria-current="page" on
//     the page's own item (Varer and Mer have no page of their own yet, so
//     they are never current in T15a);
//   - a bottom menu below 900 px (Oversikt · Ordrer · Varer · Mine valg ·
//     Mer) and a side menu from 900 px; «Mer» is a <details> list, so it
//     opens without JavaScript;
//   - the colours are the T6 tokens (light and dark); the T9 status line
//     (#mv-status on Mine valg) is lifted above the bottom menu;
//   - no inline event handlers, no inline style attributes, no script;
//     every tap target ≥ 44 px; nothing wider than a 375 px screen.
//
// Gate: OWNER_DASHBOARD_ENABLED (off by default) AND the subject on
// OWNER_FEATURES_ALLOWED_SUBJECTS AND a verified owner session. Off, the
// three pages are byte-identical to before (the routes only add the shell
// when ownerDashboardActiveFor() says so).
//
// T15a links to existing targets only: Varer → the portal's
// #bestillbare-varer card, Mer → Profil (#profil on the portal), Statistikk
// (the /selger Statistikk tab), the public profile and «Logg ut». The own
// pages (/varer, /statistikk, /mer …) come in T15c, T15d and T16.
//
// T15b: Ordrer and Varer carry a count badge when something waits (orders
// waiting for an answer, items that should be confirmed) — the numbers come
// from ownerActionCounts() (owner-ui/overview-data.ts), the same read as the
// «Dette bør du gjøre nå» block on Oversikt. The number is aria-hidden; a
// visually hidden text says it in words («, 2 venter på svar»).
//
// T15c: «Varer» has its own page, /eier/:id/varer (the T13 card in the
// shell), when the dashboard is active AND the «Varer» card is shown
// (ownerItemsPageActiveFor, owner-ui/overview-data.ts). The caller passes
// `itemsPage: true` then: the Varer link goes to /varer, and on that page
// Varer carries aria-current="page". Without it the link is as in T15a.

import { isSubjectAllowedForOwnerFeatures } from "../owner-features/allowlist";

export const OWNER_DASHBOARD_ENABLED_ENV = "OWNER_DASHBOARD_ENABLED";

export function isOwnerDashboardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[OWNER_DASHBOARD_ENABLED_ENV];
  return v === "1" || v === "true";
}

/**
 * The shell's gate: the flag, the «Mine valg» allowlist and a verified owner
 * (the caller passes isVerifiedOwner(agentId, session) — this module does not
 * read sessions). Never throws: any failure means «no shell».
 */
export function ownerDashboardActiveFor(
  vertical: string,
  agentId: string,
  verifiedOwner: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    return verifiedOwner && isOwnerDashboardEnabled(env) && isSubjectAllowedForOwnerFeatures(vertical, agentId, env);
  } catch {
    return false;
  }
}

/** Every text the shell shows (punkt 9 «Tekst», tekstpakke B). */
export const OWNER_SHELL_TEXTS = {
  nav: "Eierportal",
  skip: "Hopp til innholdet",
  overview: "Oversikt",
  orders: "Mine ordrer",
  ordersShort: "Ordrer",
  items: "Varer",
  features: "Mine valg",
  more: "Mer",
  profile: "Profil",
  stats: "Statistikk",
  publicProfile: "Se profilen din",
  logout: "Logg ut",
  /** T15b: screen-reader text after the Ordrer badge ({n} ≥ 1). */
  ordersBadge: ", {n} venter på svar",
  /** T15b: screen-reader text after the Varer badge ({n} ≥ 1). */
  itemsBadge: ", {n} bør bekreftes",
  /** T15c: the line left on Oversikt where the «Varer» card was. */
  itemsMoved: "Varene dine har nå en egen side.",
  /** T15c: its link to the Varer page. */
  itemsMovedLink: "Gå til Varer",
} as const;

/** The id of the page's <main>, the skip link's target. */
export const OWNER_SHELL_MAIN_ID = "innhold";
/** The portal's profile card id (Mer → Profil), set only when the shell is on. */
export const OWNER_SHELL_PROFILE_ANCHOR = "profil";
/** The portal's orderable-items card (owner-portal ORDERABILITY_ANCHOR). */
export const OWNER_SHELL_ITEMS_ANCHOR = "bestillbare-varer";

export type OwnerShellSection = "oversikt" | "ordrer" | "varer" | "valg";

/**
 * T15b: what waits for the owner — read once per page by ownerActionCounts()
 * (owner-ui/overview-data.ts) and shown both as the menu badges and in
 * «Dette bør du gjøre nå», so the two can never differ.
 */
export interface OwnerActionCounts {
  /** Orders waiting for an answer (orders.status = 'pending'). */
  pendingOrders: number;
  /** «Varer» rows in «Trenger handling» (the T13 card's confirm-needed rows). */
  itemsToConfirm: number;
}

export interface OwnerShellOptions {
  agentId: string;
  /** The page the shell is around (its menu item gets aria-current="page"). */
  current: OwnerShellSection;
  /** The public profile's slug (/produsent/<slug>); empty = no link. */
  profileSlug?: string;
  /** T15b: the badge numbers (absent or 0 = no badge). */
  counts?: OwnerActionCounts;
  /** T15c: the Varer page exists (ownerItemsPageActiveFor) — the Varer link goes to /varer. */
  itemsPage?: boolean;
}

/** «Statistikk»: the Statistikk tab in /selger (selger.html opens it on #statistikk). */
export function ownerShellStatsHref(agentId: string): string {
  return `/selger?agent=${encodeURIComponent(agentId)}#statistikk`;
}

export interface OwnerShellLinks {
  oversikt: string;
  ordrer: string;
  varer: string;
  valg: string;
  profil: string;
  statistikk: string;
  publicProfile: string | null;
  logout: string;
}

/** T15c: the Varer page (only linked when ownerItemsPageActiveFor). */
export function ownerItemsPagePath(agentId: string): string {
  return `/eier/${encodeURIComponent(agentId)}/varer`;
}

export function ownerShellLinks(agentId: string, profileSlug = "", itemsPage = false): OwnerShellLinks {
  const base = `/eier/${encodeURIComponent(agentId)}`;
  return {
    oversikt: `${base}/portal`,
    ordrer: `${base}/ordrer`,
    varer: itemsPage ? ownerItemsPagePath(agentId) : `${base}/portal#${OWNER_SHELL_ITEMS_ANCHOR}`,
    valg: `${base}/valg`,
    profil: `${base}/portal#${OWNER_SHELL_PROFILE_ANCHOR}`,
    statistikk: ownerShellStatsHref(agentId),
    publicProfile: profileSlug ? `/produsent/${encodeURIComponent(profileSlug)}` : null,
    logout: `${base}/logout`,
  };
}

function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>
  )[c]);
}

/**
 * The shell's CSS (body CSS, on the T6 tokens). Below 900 px the menu is a
 * fixed bottom bar and the T9 status line sits above it; from 900 px it is a
 * fixed side menu and the page moves right.
 */
export const OWNER_SHELL_CSS = `
  .ow-skip { position: absolute; left: 8px; top: -200px; z-index: 50; display: inline-flex; align-items: center; min-height: 44px; padding: 10px 16px; border-radius: 8px; background: var(--ow-btn-primary-bg); color: var(--ow-btn-primary-text); font-weight: 700; text-decoration: none; }
  .ow-skip:focus { top: 8px; outline: 3px solid var(--ow-accent-line); outline-offset: 2px; }
  #${OWNER_SHELL_MAIN_ID}:focus { outline: none; }
  .ow-nav { --ow-nav-h: 60px; position: fixed; z-index: 30; box-sizing: border-box; background: var(--ow-surface); color: var(--ow-text); border: 0 solid var(--ow-border); font-size: 0.95rem; }
  .ow-nav ul { list-style: none; margin: 0; padding: 0; }
  .ow-nav-title { margin: 0 0 12px; padding: 0 12px; font-weight: 700; color: var(--ow-accent); }
  .ow-nav-item, .ow-more > summary { box-sizing: border-box; display: flex; align-items: center; justify-content: center; gap: 4px; min-height: 44px; padding: 8px 6px; border-radius: 8px; color: var(--ow-text); text-decoration: none; font-weight: 600; text-align: center; line-height: 1.2; overflow-wrap: anywhere; cursor: pointer; }
  .ow-nav-item[aria-current="page"] { background: var(--ow-badge-new-bg); color: var(--ow-badge-new-text); }
  .ow-nav-item:focus-visible, .ow-more > summary:focus-visible, .ow-more-item:focus-visible { outline: 3px solid var(--ow-accent-line); outline-offset: -3px; }
  .ow-more { position: relative; }
  .ow-more > summary { list-style: none; }
  .ow-more > summary::-webkit-details-marker { display: none; }
  .ow-more-list { box-sizing: border-box; background: var(--ow-surface); border: 1px solid var(--ow-border); border-radius: 10px; padding: 6px; }
  .ow-more-item { box-sizing: border-box; display: flex; align-items: center; width: 100%; min-height: 44px; padding: 10px 12px; border: 0; border-radius: 8px; background: none; color: var(--ow-accent); font: inherit; font-weight: 600; text-align: left; text-decoration: none; cursor: pointer; }
  .ow-more-item:hover { background: var(--ow-btn-secondary-hover); }
  .ow-more-form { margin: 0; }
  .ow-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  .ow-nav-badge { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; min-width: 1.5em; height: 1.5em; padding: 0 5px; border-radius: 999px; background: var(--ow-btn-primary-bg); color: var(--ow-btn-primary-text); font-size: 0.75rem; font-weight: 700; line-height: 1; }
  @media (max-width: 899.98px) {
    body { padding-bottom: calc(60px + env(safe-area-inset-bottom, 0px)); }
    .ow-nav { left: 0; right: 0; bottom: 0; border-top-width: 1px; padding: 0 4px env(safe-area-inset-bottom, 0px); }
    .ow-nav-title, .ow-nav-long { display: none; }
    .ow-nav-list { display: flex; }
    .ow-nav-list > li { flex: 1 1 0; min-width: 0; }
    .ow-nav-item, .ow-more > summary { min-height: var(--ow-nav-h); font-size: 0.8rem; }
    .ow-more-list { position: absolute; right: 0; bottom: calc(100% + 6px); width: max-content; max-width: calc(100vw - 16px); min-width: 200px; box-shadow: 0 2px 10px rgba(0,0,0,0.15); }
    body #mv-status { bottom: calc(60px + 12px + env(safe-area-inset-bottom, 0px)); }
  }
  @media (min-width: 900px) {
    body { padding-left: 232px; }
    .ow-nav { top: 0; bottom: 0; left: 0; width: 232px; overflow-y: auto; border-right-width: 1px; padding: 24px 12px; }
    .ow-nav-short { display: none; }
    .ow-nav-list { display: flex; flex-direction: column; gap: 4px; }
    .ow-nav-item, .ow-more > summary { justify-content: flex-start; padding: 10px 12px; text-align: left; }
    .ow-more-list { margin-top: 4px; }
  }
`;

/**
 * The shell's markup before the page: the CSS, «Hopp til innholdet» (the
 * first focusable element) and the menu. The page puts its content in
 * <main id="innhold" tabindex="-1">.
 */
export function renderOwnerShellStart(opts: OwnerShellOptions): string {
  const T = OWNER_SHELL_TEXTS;
  const L = ownerShellLinks(opts.agentId, opts.profileSlug ?? "", opts.itemsPage === true);
  const cur = (s: OwnerShellSection) => (opts.current === s ? ` aria-current="page"` : "");
  const badge = (n: number | undefined, sr: string) => {
    const k = Number.isFinite(n) ? Math.floor(n as number) : 0;
    return k >= 1
      ? `<span class="ow-nav-badge" aria-hidden="true">${k}</span><span class="ow-sr">${esc(sr.replace("{n}", String(k)))}</span>`
      : "";
  };
  const item = (href: string, inner: string, section: OwnerShellSection | null) =>
    `<li><a class="ow-nav-item" href="${esc(href)}"${section ? cur(section) : ""}>${inner}</a></li>`;
  const more = [
    `<li><a class="ow-more-item" href="${esc(L.profil)}">${esc(T.profile)}</a></li>`,
    `<li><a class="ow-more-item" href="${esc(L.statistikk)}">${esc(T.stats)}</a></li>`,
    L.publicProfile ? `<li><a class="ow-more-item" href="${esc(L.publicProfile)}">${esc(T.publicProfile)}</a></li>` : "",
    `<li><form class="ow-more-form" method="post" action="${esc(L.logout)}"><button type="submit" class="ow-more-item">${esc(T.logout)}</button></form></li>`,
  ].join("");
  return `<style>${OWNER_SHELL_CSS}</style>
  <a class="ow-skip" href="#${OWNER_SHELL_MAIN_ID}">${esc(T.skip)}</a>
  <nav class="ow-nav" aria-label="${esc(T.nav)}">
    <p class="ow-nav-title">${esc(T.nav)}</p>
    <ul class="ow-nav-list">
      ${item(L.oversikt, esc(T.overview), "oversikt")}
      ${item(L.ordrer, `<span class="ow-nav-short">${esc(T.ordersShort)}</span><span class="ow-nav-long">${esc(T.orders)}</span>${badge(opts.counts?.pendingOrders, T.ordersBadge)}`, "ordrer")}
      ${item(L.varer, `${esc(T.items)}${badge(opts.counts?.itemsToConfirm, T.itemsBadge)}`, opts.itemsPage === true ? "varer" : null)}
      ${item(L.valg, esc(T.features), "valg")}
      <li><details class="ow-more"><summary>${esc(T.more)}</summary><ul class="ow-more-list">${more}</ul></details></li>
    </ul>
  </nav>`;
}

/** The opening tag of the page's <main> (the skip link's target). */
export const OWNER_SHELL_MAIN_OPEN = `<main id="${OWNER_SHELL_MAIN_ID}" tabindex="-1">`;
