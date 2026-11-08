// ─── Owner portal: the «Oversikt» block (eierportal T15b) ──────────────────
// dev-request 2026-10-30-rfb-eierportal-testrunde-1, punkt 9 «eierportalen som
// dashbord», slice T15b «Oversikt».
//
// Pure rendering: renderOwnerOverview(model) → HTML. The data is gathered by
// owner-ui/overview-data.ts (buildOwnerOverviewModel, ownerActionCounts) from
// the sources the owner pages already use; nothing here reads the DB, the
// clock or the environment.
//
// On /eier/:id/portal, under the page's single <h1> (the producer's name), in
// this order:
//   1. status badges — visibility and orders;
//   2. «Se profilen din» (or «Skjult for kunder» without a link);
//   3. the level line from «Mine valg» (T8) with «Endre»;
//   4. «Dette bør du gjøre nå» — the same numbers as the menu badges;
//   5. «Dette har profilen gjort for deg» — three numbers of the S2f card;
//   6. «Alt i eierportalen» — one link per part that exists today;
//   7. «Nyheter og tips» — the T7 question (placement oversikt_question);
//   8. the help line.
//
// No inline style, no on*= handler, no script: works without JavaScript; the
// colours are the T6 tokens; every tap target is ≥ 44 px. Every text is in
// OWNER_OVERVIEW_TEXTS (the news question's words are the versioned T7
// consent text, OWNER_NEWS_CONSENT_TEXT).

import { OWNER_NEWS_CONSENT_TEXT, OWNER_NEWS_PLACEMENT_OVERVIEW } from "../owner-features/news-consent";
import { OWNER_SHELL_TEXTS, ownerShellLinks, type OwnerActionCounts } from "./shell";

export type { OwnerActionCounts } from "./shell";

/** Every text the «Oversikt» block shows (except the T7 consent text). */
export const OWNER_OVERVIEW_TEXTS = {
  title: "Oversikt",
  statusLabel: "Status",
  visibility: {
    visible: "Synlig for kunder",
    paused: "På pause",
    hidden: "Skjult for kunder",
  },
  orders: {
    on: "Tar imot bestillinger",
    off: "Tar ikke imot bestillinger",
    onNoItems: "Bestillinger er på, men ingen varer kan bestilles",
  },
  publicProfile: "Se profilen din",
  profileHidden: "Skjult for kunder",
  levelChange: "Endre",
  levelNone: "Se hvor aktiv du er i Mine valg.",
  todoTitle: "Dette bør du gjøre nå",
  todoOrders: "{n} bestillinger venter på svar",
  todoOrdersOne: "1 bestilling venter på svar",
  todoOrdersHint: "Bekreft eller avslå i Mine ordrer.",
  todoItems: "{n} varer bør bekreftes",
  todoItemsOne: "1 vare bør bekreftes",
  todoItemsHint: "Bekreft at de fortsatt er på lager.",
  todoNone: "Alt er i orden. Du har ingenting som venter.",
  statsTitle: "Dette har profilen gjort for deg",
  statsHumanViews: "Sidevisninger fra mennesker",
  statsAiViews: "AI-søk",
  statsAiDeliveries: "Med i AI-søk",
  statsMissing: "—",
  partsTitle: "Alt i eierportalen",
  partOrders: OWNER_SHELL_TEXTS.orders,
  partItems: OWNER_SHELL_TEXTS.items,
  partFeatures: OWNER_SHELL_TEXTS.features,
  partProfile: OWNER_SHELL_TEXTS.profile,
  partStats: OWNER_SHELL_TEXTS.stats,
  newsTitle: "Nyheter og tips",
  newsAnswer: {
    yes: "Takk! Du får nyheter og tips på e-post. Du kan slå det av i Mine valg når som helst.",
    later: "Greit. Vi spør igjen tidligst om tre måneder. Du kan slå det på i Mine valg når du vil.",
    never: "Greit. Vi spør ikke igjen. Du kan slå det på i Mine valg hvis du ombestemmer deg.",
    error: "Svaret ble ikke lagret. Prøv igjen.",
  },
  helpBefore: "Trenger du hjelp? Skriv til ",
  helpEmail: "kontakt@rettfrabonden.com",
  helpAfter: ".",
} as const;

/** The block's anchors (ids on the portal page, only with the dashboard on). */
export const OWNER_OVERVIEW_ANCHOR = "oversikt";
export const OWNER_OVERVIEW_TODO_ANCHOR = "gjor-na";
export const OWNER_OVERVIEW_NEWS_ANCHOR = "nyheter";

/** The `?nyheter=` value the /valg/intro POST sends back to the portal. */
export type OwnerOverviewNewsResult = "yes" | "later" | "never" | "error";
export const OWNER_OVERVIEW_NEWS_PARAM = "nyheter";
const NEWS_RESULT_PARAM: Record<OwnerOverviewNewsResult, string> = { yes: "ja", later: "ikke_na", never: "nei", error: "feil" };

/** `?nyheter=` value for an answer result. */
export function ownerOverviewNewsParam(r: OwnerOverviewNewsResult): string {
  return NEWS_RESULT_PARAM[r];
}

/** `?nyheter=` → the result, or null for anything else. */
export function parseOwnerOverviewNewsParam(raw: unknown): OwnerOverviewNewsResult | null {
  const hit = (Object.keys(NEWS_RESULT_PARAM) as OwnerOverviewNewsResult[]).find((k) => NEWS_RESULT_PARAM[k] === raw);
  return hit ?? null;
}

/** Where the answer from «Oversikt» lands: the portal, at the news block. */
export function ownerOverviewNewsBack(agentId: string, r: OwnerOverviewNewsResult): string {
  return `/eier/${encodeURIComponent(agentId)}/portal?${OWNER_OVERVIEW_NEWS_PARAM}=${ownerOverviewNewsParam(r)}#${OWNER_OVERVIEW_NEWS_ANCHOR}`;
}

export type OwnerOverviewVisibility = "visible" | "paused" | "hidden";
export type OwnerOverviewOrders = "on" | "off" | "on_no_items";

export interface OwnerOverviewStat {
  value: number;
  /** The period label of the source («siste 12 måneder» / «siden <dato>»). */
  label: string;
}

export interface OwnerOverviewModel {
  agentId: string;
  /** The public profile's slug (/produsent/<slug>). */
  profileSlug: string;
  visibility: OwnerOverviewVisibility;
  orders: OwnerOverviewOrders;
  /** The «Mine valg» level status line's text (ownerLevelStatusText); null = no level to show. */
  levelText: string | null;
  /** ownerActionCounts() — the same numbers as the menu badges. */
  counts: OwnerActionCounts;
  /** The S2f card's 12-month numbers (getOwnerStats().year); null = the read failed («—»). */
  stats: { humanViews: OwnerOverviewStat; aiViews: OwnerOverviewStat; aiDeliveries: OwnerOverviewStat } | null;
  /** The T7 question is shown (same conditions as on «Mine valg»). */
  showNewsQuestion: boolean;
  /** The answer just given from here (`?nyheter=`), shown in the news block. */
  newsResult: OwnerOverviewNewsResult | null;
}

function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>
  )[c]);
}

function n(v: number): number {
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** «{n} bestillinger venter på svar» (singular for 1). */
export function ownerOverviewOrdersLine(count: number): string {
  const T = OWNER_OVERVIEW_TEXTS;
  return count === 1 ? T.todoOrdersOne : T.todoOrders.replace("{n}", String(count));
}

/** «{n} varer bør bekreftes» (singular for 1). */
export function ownerOverviewItemsLine(count: number): string {
  const T = OWNER_OVERVIEW_TEXTS;
  return count === 1 ? T.todoItemsOne : T.todoItems.replace("{n}", String(count));
}

/** The block's CSS (body CSS, T6 tokens only). */
export const OWNER_OVERVIEW_CSS = `
  .ow-ov-badges { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
  .ow-ov-badge { display: inline-flex; align-items: center; min-height: 32px; padding: 4px 12px; border-radius: 999px; font-weight: 600; font-size: 0.9rem; background: var(--ow-badge-bg); color: var(--ow-badge-text); overflow-wrap: anywhere; }
  .ow-ov-badge[data-tone="ok"] { background: var(--ow-badge-new-bg); color: var(--ow-badge-new-text); }
  .ow-ov-badge[data-tone="warn"] { background: var(--ow-pill-warn-bg); color: var(--ow-pill-warn-text); }
  .ow-ov-line { margin: 8px 0 0; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
  .ow-ov-link { display: inline-flex; align-items: center; min-height: 44px; font-weight: 600; color: var(--ow-accent); }
  .ow-ov-list { list-style: none; margin: 0; padding: 0; }
  .ow-ov-list > li { border-bottom: 1px solid var(--ow-divider); }
  .ow-ov-list > li:last-child { border-bottom: none; }
  .ow-ov-row { display: flex; flex-direction: column; justify-content: center; min-height: 44px; padding: 10px 0; color: var(--ow-text); text-decoration: none; }
  .ow-ov-row strong { color: var(--ow-accent); }
  .ow-ov-row span { font-size: 0.88rem; color: var(--ow-muted); }
  a.ow-ov-row:focus-visible, .ow-ov-link:focus-visible { outline: 3px solid var(--ow-accent-line); outline-offset: 2px; border-radius: 4px; }
  .ow-ov-ok { margin: 0; color: var(--ow-ok-text); font-weight: 600; }
  .ow-ov-news h3 { font-size: 1rem; margin: 0 0 6px; }
  .ow-ov-news p { margin: 6px 0 0; }
  .ow-ov-answers { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .ow-ov-answers form, .ow-ov-never { margin: 0; }
  .ow-ov-answers .ep-btn { min-height: 44px; }
  .ow-ov-linkbtn { display: inline-flex; align-items: center; min-height: 44px; padding: 0 4px; margin-top: 4px; background: none; border: none; color: var(--ow-accent); font: inherit; font-size: 0.92rem; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
  .ow-ov-linkbtn:focus-visible { outline: 3px solid var(--ow-accent-line); outline-offset: 2px; border-radius: 4px; }
  .ow-ov-msg { margin: 8px 0 0; padding: 10px 14px; border-radius: 10px; }
  .ow-ov-msg[data-ok="1"] { background: var(--ow-ok-bg); color: var(--ow-ok-text); border: 1px solid var(--ow-ok-line); }
  .ow-ov-msg[data-ok="0"] { background: var(--ow-err-bg); color: var(--ow-err-text); border: 1px solid var(--ow-err-line); }
  .ow-ov-help { margin: 0 0 16px; padding: 0 4px; color: var(--ow-text); }
  .ow-ov-help a { display: inline-flex; align-items: center; min-height: 44px; color: var(--ow-accent); }
`;

/** The «Oversikt» block (sections 1–8), placed right under the card with the page's <h1>. */
export function renderOwnerOverview(m: OwnerOverviewModel): string {
  const T = OWNER_OVERVIEW_TEXTS;
  const id = encodeURIComponent(m.agentId);
  const L = ownerShellLinks(m.agentId, m.profileSlug);
  const counts = { pendingOrders: n(m.counts.pendingOrders), itemsToConfirm: n(m.counts.itemsToConfirm) };

  // 1. Status badges.
  const visText = m.visibility === "paused" ? T.visibility.paused : m.visibility === "hidden" ? T.visibility.hidden : T.visibility.visible;
  const visTone = m.visibility === "visible" ? "ok" : "warn";
  const ordText = m.orders === "on" ? T.orders.on : m.orders === "on_no_items" ? T.orders.onNoItems : T.orders.off;
  const ordTone = m.orders === "on" ? "ok" : m.orders === "on_no_items" ? "warn" : "neutral";
  const badges = `<ul class="ow-ov-badges" aria-label="${esc(T.statusLabel)}" data-ov="status">
          <li class="ow-ov-badge" data-tone="${visTone}" data-visibility="${esc(m.visibility)}">${esc(visText)}</li>
          <li class="ow-ov-badge" data-tone="${ordTone}" data-orders="${esc(m.orders)}">${esc(ordText)}</li>
        </ul>`;

  // 2. The public profile.
  const profile = m.visibility !== "hidden" && L.publicProfile
    ? `<p class="ow-ov-line" data-ov="profile"><a class="ow-ov-link" href="${esc(L.publicProfile)}">${esc(T.publicProfile)}</a></p>`
    : `<p class="ow-ov-line" data-ov="profile">${esc(T.profileHidden)}</p>`;

  // 3. The level line (Mine valg's T8 status) with «Endre».
  const level = `<p class="ow-ov-line" data-ov="level"><span>${esc(m.levelText ?? T.levelNone)}</span> <a class="ow-ov-link" href="/eier/${id}/valg#niva">${esc(T.levelChange)}</a></p>`;

  // 4. «Dette bør du gjøre nå».
  const todoRows: string[] = [];
  if (counts.pendingOrders >= 1) {
    todoRows.push(`<li data-todo="orders" data-count="${counts.pendingOrders}"><a class="ow-ov-row" href="${esc(L.ordrer)}"><strong>${esc(ownerOverviewOrdersLine(counts.pendingOrders))}</strong><span>${esc(T.todoOrdersHint)}</span></a></li>`);
  }
  if (counts.itemsToConfirm >= 1) {
    todoRows.push(`<li data-todo="items" data-count="${counts.itemsToConfirm}"><a class="ow-ov-row" href="#bestillbare-varer"><strong>${esc(ownerOverviewItemsLine(counts.itemsToConfirm))}</strong><span>${esc(T.todoItemsHint)}</span></a></li>`);
  }
  const todo = `<section class="ep-card" id="${OWNER_OVERVIEW_TODO_ANCHOR}" aria-labelledby="ow-ov-todo-h" data-ov="todo">
        <h2 id="ow-ov-todo-h">${esc(T.todoTitle)}</h2>
        ${todoRows.length ? `<ul class="ow-ov-list">${todoRows.join("")}</ul>` : `<p class="ow-ov-ok" data-todo="none">${esc(T.todoNone)}</p>`}
      </section>`;

  // 5. «Dette har profilen gjort for deg» (the S2f card's numbers).
  const stat = (label: string, s: OwnerOverviewStat | null, key: string) =>
    `<div class="ep-stat" data-stat="${key}"><div class="ep-stat-num">${esc(s ? String(s.value) : T.statsMissing)}</div><div class="ep-stat-label">${esc(s && s.label ? `${label} (${s.label})` : label)}</div></div>`;
  const st = m.stats;
  const stats = `<section class="ep-card" aria-labelledby="ow-ov-stats-h" data-ov="stats">
        <h2 id="ow-ov-stats-h">${esc(T.statsTitle)}</h2>
        <div class="ep-stats">${stat(T.statsHumanViews, st ? st.humanViews : null, "humanViews")}${stat(T.statsAiViews, st ? st.aiViews : null, "aiViews")}${stat(T.statsAiDeliveries, st ? st.aiDeliveries : null, "aiDeliveries")}</div>
      </section>`;

  // 6. «Alt i eierportalen».
  const part = (href: string, label: string, key: string) =>
    `<li data-part="${key}"><a class="ow-ov-row" href="${esc(href)}"><strong>${esc(label)}</strong></a></li>`;
  const parts = `<section class="ep-card" aria-labelledby="ow-ov-parts-h" data-ov="parts">
        <h2 id="ow-ov-parts-h">${esc(T.partsTitle)}</h2>
        <ul class="ow-ov-list">${part(L.ordrer, T.partOrders, "ordrer")}${part("#bestillbare-varer", T.partItems, "varer")}${part(L.valg, T.partFeatures, "valg")}${part("#profil", T.partProfile, "profil")}${part(L.statistikk, T.partStats, "statistikk")}</ul>
      </section>`;

  // 7. «Nyheter og tips» — the T7 question, posting to the same route.
  let news = "";
  const msg = m.newsResult ? T.newsAnswer[m.newsResult] : "";
  const msgHtml = msg ? `<p class="ow-ov-msg" role="${m.newsResult === "error" ? "alert" : "status"}" data-ok="${m.newsResult === "error" ? "0" : "1"}" data-news-result="${esc(m.newsResult)}">${esc(msg)}</p>` : "";
  if (m.showNewsQuestion || msgHtml) {
    const c = OWNER_NEWS_CONSENT_TEXT;
    const form = (answer: "yes" | "later" | "never", label: string, cls: string, formCls = "") =>
      `<form method="post" action="/eier/${id}/valg/intro"${formCls ? ` class="${formCls}"` : ""}><input type="hidden" name="answer" value="${answer}"><input type="hidden" name="placement" value="${esc(OWNER_NEWS_PLACEMENT_OVERVIEW)}"><button type="submit" class="${cls}">${esc(label)}</button></form>`;
    const question = m.showNewsQuestion
      ? `<div class="ow-ov-news" data-news-question="oversikt" role="group" aria-labelledby="ow-ov-news-q">
          <h3 id="ow-ov-news-q">${esc(c.question)}</h3>
          <p>${esc(c.body)}</p>
          <p class="ep-audit-meta">${esc(c.always)}</p>
          <div class="ow-ov-answers">${form("yes", c.yes, "ep-btn ep-btn-secondary")}${form("later", c.later, "ep-btn ep-btn-secondary")}</div>
          <p class="ep-audit-meta">${esc(c.laterNote)}</p>
          ${form("never", c.never, "ow-ov-linkbtn", "ow-ov-never")}
        </div>`
      : "";
    news = `
      <section class="ep-card" id="${OWNER_OVERVIEW_NEWS_ANCHOR}" aria-labelledby="ow-ov-news-h" data-ov="news">
        <h2 id="ow-ov-news-h">${esc(T.newsTitle)}</h2>
        ${msgHtml}${question}
      </section>`;
  }

  // 8. Help.
  const help = `<p class="ow-ov-help" data-ov="help">${esc(T.helpBefore)}<a href="mailto:${esc(T.helpEmail)}">${esc(T.helpEmail)}</a>${esc(T.helpAfter)}</p>`;

  return `
      <style>${OWNER_OVERVIEW_CSS}</style>
      <section class="ep-card" id="${OWNER_OVERVIEW_ANCHOR}" aria-labelledby="ow-ov-h" data-ov="overview">
        <h2 id="ow-ov-h">${esc(T.title)}</h2>
        ${badges}
        ${profile}
        ${level}
      </section>
      ${todo}
      ${stats}
      ${parts}${news}
      ${help}`;
}
