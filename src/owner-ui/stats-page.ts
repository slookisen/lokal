// ─── Owner portal: the «Statistikk» page (eierportal T15d) ──────────────────
// dev-request 2026-10-30-rfb-eierportal-testrunde-1, punkt 9, slice T15d.
//
// GET /eier/:id/statistikk (routes/owner-portal.ts) renders, inside the owner
// shell, the same sections, labels and windows as the Statistikk tab in
// /selger (src/public/selger.html, renderOwnerStats), from the same payload
// (getOwnerStats — the data behind GET /api/agents/:id/owner-stats). Nothing
// is counted anew here: this module only turns that payload into HTML, the
// way the tab's client code does.
//
//   - every text value (search terms, sources, kinds, labels) goes through
//     esc(); numbers are shown as the tab shows them;
//   - no inline event handlers, no inline style attributes, no script — the
//     bars are <meter> elements and the 30-day trend is an SVG;
//   - a failed read (stats === null) shows «—» and one short line.
//
// Every text is in OWNER_STATS_PAGE_TEXTS (tekstpakke B wording; the /selger
// tab keeps its own, older texts in selger.html).

import type { OwnerStats } from "../services/owner-stats-service";

/**
 * Every text the page shows. `readFailed` is new in T15d; the rest started as
 * the /selger tab's texts and was reworded in tekstpakke B (approved
 * 2026-11-09). The /selger tab (src/public/selger.html) has its own copies
 * and keeps its old wording. Day counts come from the payload (`{wd}`,
 * `{days}`), never a literal «Nd».
 */
export const OWNER_STATS_PAGE_TEXTS = {
  title: "Statistikk",
  readFailed: "Statistikken kunne ikke hentes akkurat nå. Prøv igjen senere.",
  emptyTitle: "Ingen aktivitet registrert ennå",
  emptyIntro: "Profilen din er ny, så det er helt normalt at tallene under står på null. Her er noen grep for å komme i gang:",
  emptyTips: [
    "Fyll ut profilen: om gården, kontaktinformasjon og åpningstider. Jo mer som står der, jo lettere er det for søk og AI-assistenter å finne og anbefale deg.",
    "Legg inn varer under «Varer», så har kunder og AI-assistenter noe å vise fram.",
    "Del lenken til profilen din (under «Se profilen din») i egne kanaler, for eksempel sosiale medier eller nyhetsbrev.",
    "Sjekk at e-post, telefon og nettside stemmer, så kundene når deg.",
  ],
  /** «siste N dager» — the window label wherever the payload has no label of its own. */
  windowLabel: "siste {days} dager",
  funnelTitle: "Fra visning til kontakt",
  funnelHint: "Besøk gjelder perioden på kortet, som på profilsiden din. Trykk på e-post, telefon og nettside gjelder de siste {wd} dagene. Et trykk viser at noen var interessert, ikke at de fikk tak i deg. «Vist i søkeresultater» teller alt siden start, også roboter og AI. For AI, se «Med i treffene til AI-assistenter».",
  funnelDiscovered: "Vist i søkeresultater (siden start, også roboter)",
  funnelSeen: "Besøk på profilsiden ({label})",
  funnelSeenBare: "Besøk på profilsiden",
  funnelContact: "Trykk på e-post, telefon eller nettside (siste {wd} dager)",
  funnelContactBare: "Trykk på e-post, telefon eller nettside",
  aiFunnelTitle: "Fra AI-assistenter",
  aiFunnelHint: "«Med i treffene» er hvor mange ganger profilen din var blant treffene en AI-assistent hentet. «Besøk fra et AI-svar» er folk som trykket seg inn på profilen fra et svar i ChatGPT, Claude, Perplexity eller lignende. Tallet er et minimum, fordi ikke alle sier fra hvor besøket kom fra. Trykk på e-post, telefon og nettside viser hvor mange av dem som tok kontakt. Siste {days} dager, eller fra datoen på kortet.",
  aiFunnelSent: "Med i treffene til AI ({label})",
  aiFunnelClicks: "Besøk fra et AI-svar ({label}, minst)",
  aiFunnelContact: "Trykk på e-post, telefon eller nettside ({label})",
  aiFunnelFromAi: "Av disse kom fra et AI-svar:",
  aiFunnelDefaultLabel: "siste {days} dager",
  aiFunnelVendorTitle: "Besøk fra AI-svar, per assistent",
  aiFunnelNoClicks: "Ingen besøk fra AI-svar ennå.",
  viewsTitle: "Hvor besøkene kom fra (siste {wd} dager)",
  viewsNone: "Ingen visninger registrert ennå.",
  trendTitle: "Siste 30 dager",
  trendNone: "Ingen data ennå.",
  aiTitle: "Hentet av AI-assistenter",
  aiHint: "Hvor mange ganger ChatGPT, Claude og andre AI-assistenter har hentet profilen din for noen som spurte. Roboter som bare leser sider for å lage register, telles ikke. Fordelingen per assistent gjelder de siste {wd} dagene.",
  aiAll: "Alle AI-assistenter ({label})",
  aiChatgpt: "ChatGPT (siste {wd} dager)",
  aiClaude: "Claude (siste {wd} dager)",
  aiOther: "Andre AI (siste {wd} dager)",
  dlTitle: "Med i treffene til AI-assistenter",
  dlHint: "Hvor mange ganger profilen din var blant treffene når en AI-assistent som ChatGPT eller Claude lette etter noe for noen: et søk, et sted, en kategori eller profilsiden din. Forsiden telles ikke. Tallet sier ikke hvor mange som så profilen. Svar AI-en gir fra egen hukommelse ser vi ikke, så tallet er et minimum.",
  dlStat: "Ganger profilen var blant treffene en AI-assistent hentet ({label})",
  dlSince: "siden {date}",
  dlAllPeriod: "hele perioden",
  dlVendorTitle: "Per assistent",
  dlChannelTitle: "Hvor treffet skjedde",
  dlRowTotal: "totalt",
  termsTitle: "Søk som traff profilen din",
  termsNone: "Ingen søk registrert ennå.",
  channelsTitle: "Samtaler per kanal",
  channelsNone: "Ingen samtaler registrert ennå.",
  clicksTitle: "Trykk på kontaktinformasjonen",
  clicksHint: "Trykk på e-post, telefon og nettside på profilen din. Det viser interesse, ikke at kunden fikk tak i deg.",
  clicksNone: "Ingen trykk registrert ennå.",
  clickExternal: "Lenke til ({host})",
  unknown: "Ukjent",
  /**
   * Tekstpakke B punkt 11: `organic` (a visit from another page on Rett fra
   * Bonden) has no name of its own; its count is shown under `direct`
   * («Direkte eller fra Rett fra Bonden») — see OWNER_STATS_SOURCE_MERGE.
   */
  sourceLabels: { direct: "Direkte eller fra Rett fra Bonden", search: "Søkemotorer (for eksempel Google)", social: "Sosiale medier", referral: "Lenker fra andre nettsider", unknown: "Ukjent" } as Record<string, string>,
  channelLabels: { web: "Nettside", a2a: "Andre AI-agenter (A2A)", mcp: "Direkte kobling for AI (MCP)", api: "Andre tjenester" } as Record<string, string>,
  clickKindLabels: { email: "E-post", phone: "Telefon", website: "Nettside" } as Record<string, string>,
  aiFunnelVendorLabels: { chatgpt: "ChatGPT", claude: "Claude", perplexity: "Perplexity", gemini: "Gemini", copilot: "Copilot", other: "Andre AI" } as Record<string, string>,
  dlVendorLabels: { chatgpt: "ChatGPT", claude: "Claude", perplexity: "Perplexity", other: "Andre AI", unknown: "Ukjent AI" } as Record<string, string>,
  dlChannelLabels: { ai_page_list: "Liste- og søkesider", ai_page_profile: "Profilsiden", mcp: "Direkte kobling for AI (MCP)", a2a: "Andre AI-agenter (A2A)" } as Record<string, string>,
} as const;

/** Tekstpakke B punkt 11: a source shown under another source's name (its count is added there). */
export const OWNER_STATS_SOURCE_MERGE: Record<string, string> = { organic: "direct" };

export interface OwnerStatsPageModel {
  /** The getOwnerStats() payload; null when the read failed. */
  stats: OwnerStats | null;
  /** «now» for the 30-day trend and «siden <dato>» (the tab uses the browser clock). */
  nowMs: number;
}

const DAY_MS = 86_400_000;

function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>
  )[c]);
}

/** The tab's `(x || 0)`: a finite number as is, anything else 0. */
function n0(v: unknown): number {
  const k = typeof v === "number" ? v : Number(v);
  return Number.isFinite(k) && k ? k : 0;
}

/** The tab's afNum: a positive finite number floored, else 0. */
function afNum(v: unknown): number {
  const k = Number(v);
  return Number.isFinite(k) && k > 0 ? Math.floor(k) : 0;
}

/** A table's own label (never Object.prototype's), else "". */
function ownLabel(labels: Record<string, string>, key: string): string {
  return Object.prototype.hasOwnProperty.call(labels, key) ? labels[key] : "";
}

function fill(t: string, vars: Record<string, string | number>): string {
  return t.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

export function ownerStatsClickKindLabel(kind: unknown): string {
  const T = OWNER_STATS_PAGE_TEXTS;
  const k = typeof kind === "string" ? kind : "";
  const label = ownLabel(T.clickKindLabels, k);
  if (label) return label;
  if (k.indexOf("external:") === 0) return fill(T.clickExternal, { host: k.slice("external:".length) });
  return k || T.unknown;
}

const stat = (num: string | number, label: string, attrs = "") =>
  `<div class="ep-stat"${attrs}><div class="ep-stat-num">${esc(num)}</div><div class="ep-stat-label">${label}</div></div>`;

const row = (name: string, meta: string, attrs = "") =>
  `<li class="ow-st-row"${attrs}><span>${name}</span><span class="ow-st-meta">${meta}</span></li>`;

const empty = (text: string) => `<li class="ow-st-empty">${esc(text)}</li>`;

/** The page's CSS (body CSS, T6 tokens only). */
export const OWNER_STATS_PAGE_CSS = `
  .ow-st-hint { margin: 0 0 12px; font-size: 0.9rem; color: var(--ow-muted); }
  .ow-st-card h3 { font-size: 1rem; margin: 16px 0 6px; }
  .ow-st-list { list-style: none; margin: 0; padding: 0; }
  .ow-st-row { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--ow-divider); overflow-wrap: anywhere; }
  .ow-st-row:last-child { border-bottom: none; }
  .ow-st-meta { color: var(--ow-muted); white-space: nowrap; }
  .ow-st-empty { padding: 12px 0; color: var(--ow-muted); text-align: center; }
  .ow-st-src { margin: 0 0 8px; }
  .ow-st-src-head { display: flex; justify-content: space-between; font-size: 0.9rem; }
  .ow-st-src meter { display: block; width: 100%; height: 10px; }
  .ow-st-trend { display: block; width: 100%; height: 50px; color: var(--ow-accent); }
  .ow-st-tips { margin: 0 0 16px; }
  .ow-st-tips ul { margin: 8px 0 0; padding-left: 20px; }
  .ow-st-failed { margin: 0 0 12px; }
`;

/** The /selger tab's empty-state banner: funnel, views by source and AI split all zero. */
function emptyStateHtml(s: OwnerStats): string {
  const T = OWNER_STATS_PAGE_TEXTS;
  const f = (s.funnel || {}) as Partial<OwnerStats["funnel"]>;
  const totals = (s.viewsBySource && s.viewsBySource.totals) || {};
  const ai = (s.aiPlatforms || {}) as Partial<OwnerStats["aiPlatforms"]>;
  const funnelAllZero = !(f.discovered || f.viewed || f.contactClicked);
  const viewsAllZero = Object.keys(totals).every((k) => !totals[k]);
  const aiAllZero = !(ai.chatgpt || ai.claude || ai.other);
  if (!(funnelAllZero && viewsAllZero && aiAllZero)) return "";
  return `<div class="ep-card ow-st-tips" data-stats="empty">
        <h2>${esc(T.emptyTitle)}</h2>
        <p>${esc(T.emptyIntro)}</p>
        <ul>${T.emptyTips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
      </div>`;
}

function trendHtml(daily: OwnerStats["viewsBySource"]["daily"], nowMs: number): string {
  const T = OWNER_STATS_PAGE_TEXTS;
  if (!Array.isArray(daily) || daily.length === 0) return `<p class="ow-st-hint" data-stats="trend-none">${esc(T.trendNone)}</p>`;
  const byDate: Record<string, number> = {};
  for (const r of daily) byDate[r.date] = (byDate[r.date] || 0) + (r.count || 0);
  const todayUtc = Date.parse(new Date(nowMs).toISOString().slice(0, 10) + "T00:00:00Z");
  const days: string[] = [];
  for (let i = 29; i >= 0; i--) days.push(new Date(todayUtc - i * DAY_MS).toISOString().slice(0, 10));
  const maxDay = Math.max(1, days.reduce((m, d) => Math.max(m, byDate[d] || 0), 0));
  const bars = days.map((d, i) => {
    const c = byDate[d] || 0;
    const pct = c > 0 ? Math.max(4, Math.round((c / maxDay) * 100)) : 2;
    const h = pct / 2; // 50 units tall
    return `<rect x="${i * 10 + 1}" y="${50 - h}" width="8" height="${h}" rx="1" fill="currentColor"${c > 0 ? "" : ` opacity="0.35"`} data-day="${esc(d)}" data-count="${c}"><title>${esc(d)}: ${c}</title></rect>`;
  }).join("");
  return `<svg class="ow-st-trend" viewBox="0 0 300 50" preserveAspectRatio="none" role="img" aria-label="${esc(T.trendTitle)}" data-stats="trend">${bars}</svg>`;
}

/** The page body under the <h1> card: the tab's sections, in the tab's order. */
export function renderOwnerStatsSections(m: OwnerStatsPageModel): string {
  const T = OWNER_STATS_PAGE_TEXTS;
  const s = m.stats;
  if (!s) {
    return `<div class="ep-card ow-st-card" data-stats="failed">
        <p class="ow-st-failed" role="status">${esc(T.readFailed)}</p>
        <div class="ep-stats">${stat("—", esc(T.funnelDiscovered))}${stat("—", esc(T.funnelSeenBare))}${stat("—", esc(T.funnelContactBare))}</div>
      </div>`;
  }
  const wd = n0(s.windowDays) || 60;

  // Funnel. «Besøk på profilsiden»: the 12-month tile (year.humanViews) with its label, else the window's.
  const f = (s.funnel || { discovered: 0, viewed: 0, contactClicked: 0 }) as OwnerStats["funnel"];
  const yr = s.year || null;
  const yrLabel = (key: string): string => (yr && yr.labels && yr.labels.nb && (yr.labels.nb as Record<string, string>)[key]) || "";
  const seen = yr && yr.humanViews ? { n: n0(yr.humanViews.value), label: yrLabel("humanViews") } : { n: n0(f.viewed), label: fill(T.windowLabel, { days: wd }) };
  const funnel = `<div class="ep-card ow-st-card" data-stats="funnel">
        <h2>${esc(T.funnelTitle)}</h2>
        <p class="ow-st-hint">${esc(fill(T.funnelHint, { wd }))}</p>
        <div class="ep-stats">${stat(n0(f.discovered), esc(T.funnelDiscovered), ` data-stat="discovered"`)}${stat(seen.n, esc(fill(T.funnelSeen, { label: seen.label })), ` data-stat="seen"`)}${stat(n0(f.contactClicked), esc(fill(T.funnelContact, { wd })), ` data-stat="contactClicked"`)}</div>
      </div>`;

  // AI funnel: only the steps the payload carries; no aiFunnel (or no step) = no card.
  let aiFunnel = "";
  const af = s.aiFunnel || null;
  if (af) {
    const afDays = n0(af.windowDays) || 60;
    const afLabel = (step: { label?: string } | undefined) => (step && step.label) || fill(T.aiFunnelDefaultLabel, { days: afDays });
    let tiles = "";
    let vendors = "";
    if (af.sentToAi) tiles += stat(afNum(af.sentToAi.total), esc(fill(T.aiFunnelSent, { label: afLabel(af.sentToAi) })), ` data-ai-funnel="sentToAi"`);
    if (af.aiClicks) {
      tiles += stat(afNum(af.aiClicks.total), esc(fill(T.aiFunnelClicks, { label: afLabel(af.aiClicks) })), ` data-ai-funnel="aiClicks"`);
      const bv = (af.aiClicks.byVendor || {}) as Record<string, number>;
      for (const k of Object.keys(T.aiFunnelVendorLabels)) {
        const c = afNum(bv[k]);
        if (c > 0) vendors += row(esc(T.aiFunnelVendorLabels[k]), String(c), ` data-vendor="${esc(k)}"`);
      }
    }
    if (af.contactClicks) {
      const from = (af.contactClicks.fromAi || {}) as { total?: number; label?: string };
      tiles += stat(afNum(af.contactClicks.total),
        `${esc(fill(T.aiFunnelContact, { label: afLabel(af.contactClicks) }))}<br>${esc(T.aiFunnelFromAi)} <strong data-ai-funnel-from-ai="1">${afNum(from.total)}</strong> (${esc(afLabel(from))})`,
        ` data-ai-funnel="contactClicks"`);
    }
    const vendorList = vendors || (af.aiClicks ? empty(T.aiFunnelNoClicks) : "");
    if (tiles) {
      aiFunnel = `<div class="ep-card ow-st-card" data-stats="ai-funnel">
        <h2>${esc(T.aiFunnelTitle)}</h2>
        <p class="ow-st-hint">${esc(fill(T.aiFunnelHint, { days: afDays }))}</p>
        <div class="ep-stats">${tiles}</div>
        <h3>${esc(T.aiFunnelVendorTitle)}</h3>
        <ul class="ow-st-list">${vendorList}</ul>
      </div>`;
    }
  }

  // Views by source (people, the window) and the 30-day trend.
  const vbs = s.viewsBySource || { totals: {}, daily: [] };
  const rawTotals = vbs.totals || {};
  const totals: Record<string, number> = {};
  for (const src of Object.keys(rawTotals)) {
    const into = Object.prototype.hasOwnProperty.call(OWNER_STATS_SOURCE_MERGE, src) ? OWNER_STATS_SOURCE_MERGE[src] : src;
    totals[into] = n0(totals[into]) + n0(rawTotals[src]);
  }
  const maxTotal = Math.max(1, Object.keys(totals).reduce((mx, k) => Math.max(mx, n0(totals[k])), 0));
  const srcRows = Object.keys(totals).map((src) => {
    const c = n0(totals[src]);
    return `<div class="ow-st-src" data-source="${esc(src)}" data-count="${c}"><div class="ow-st-src-head"><span>${esc(ownLabel(T.sourceLabels, src) || src)}</span><span>${c}</span></div><meter min="0" max="${maxTotal}" value="${c}">${c}</meter></div>`;
  }).join("");
  const views = `<div class="ep-card ow-st-card" data-stats="views">
        <h2>${esc(fill(T.viewsTitle, { wd }))}</h2>
        ${srcRows || `<p class="ow-st-hint">${esc(T.viewsNone)}</p>`}
        <h3>${esc(T.trendTitle)}</h3>
        ${trendHtml(vbs.daily || [], m.nowMs)}
      </div>`;

  // AI search: the 12-month tile, then the window's split per AI.
  const ai = (s.aiPlatforms || { chatgpt: 0, claude: 0, other: 0 }) as OwnerStats["aiPlatforms"];
  let aiTiles = "";
  if (yr && yr.aiViews) aiTiles += stat(n0(yr.aiViews.value), esc(fill(T.aiAll, { label: yrLabel("aiViews") })), ` data-stat="aiAll"`);
  aiTiles += stat(n0(ai.chatgpt), esc(fill(T.aiChatgpt, { wd })), ` data-stat="chatgpt"`);
  aiTiles += stat(n0(ai.claude), esc(fill(T.aiClaude, { wd })), ` data-stat="claude"`);
  aiTiles += stat(n0(ai.other), esc(fill(T.aiOther, { wd })), ` data-stat="aiOther"`);
  const aiCard = `<div class="ep-card ow-st-card" data-stats="ai">
        <h2>${esc(T.aiTitle)}</h2>
        <p class="ow-st-hint">${esc(fill(T.aiHint, { wd }))}</p>
        <div class="ep-stats">${aiTiles}</div>
      </div>`;

  // «Med i treffene til AI-assistenter»: 12 months (or «siden <dato>») and since counting started.
  const dl = (s.aiDeliveries || {}) as Partial<OwnerStats["aiDeliveries"]>;
  const dw = (dl.window || {}) as Partial<OwnerStats["aiDeliveries"]["window"]>;
  const da = (dl.allTime || {}) as Partial<OwnerStats["aiDeliveries"]["allTime"]>;
  const dwDays = n0(dw.windowDays) || 365;
  const sinceMs = dw.countingSince ? Date.parse(dw.countingSince + "T00:00:00Z") : NaN;
  const since = Number.isNaN(sinceMs) ? "" : new Date(sinceMs).toLocaleDateString("nb-NO", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const partial = !!since && (m.nowMs - sinceMs) < (dwDays - 1) * DAY_MS;
  const dlWinLabel = yrLabel("aiDeliveries") || (partial ? fill(T.dlSince, { date: since }) : fill(T.windowLabel, { days: dwDays }));
  const dlRows = (labels: Record<string, string>, w: Record<string, number> | undefined, a: Record<string, number> | undefined, attr: string) =>
    Object.keys(labels).map((k) => row(esc(labels[k]), `${n0((w || {})[k])} (${esc(dlWinLabel)}) · ${n0((a || {})[k])} ${esc(T.dlRowTotal)}`, ` data-${attr}="${esc(k)}"`)).join("");
  const dlCard = `<div class="ep-card ow-st-card" data-stats="ai-deliveries">
        <h2>${esc(T.dlTitle)}</h2>
        <p class="ow-st-hint">${esc(T.dlHint)}</p>
        <div class="ep-stats">${stat(n0(dw.total), esc(fill(T.dlStat, { label: dlWinLabel })), ` data-stat="dlWindow"`)}${stat(n0(da.total), esc(fill(T.dlStat, { label: since ? fill(T.dlSince, { date: since }) : T.dlAllPeriod })), ` data-stat="dlAllTime"`)}</div>
        <h3>${esc(T.dlVendorTitle)}</h3>
        <ul class="ow-st-list">${dlRows(T.dlVendorLabels, dw.byVendor as any, da.byVendor as any, "dl-vendor")}</ul>
        <h3>${esc(T.dlChannelTitle)}</h3>
        <ul class="ow-st-list">${dlRows(T.dlChannelLabels, dw.byChannel as any, da.byChannel as any, "dl-channel")}</ul>
      </div>`;

  // Search terms (visitor text — escaped), conversations per channel, contact clicks by kind.
  const terms = Array.isArray(s.matchingSearchQueries) ? s.matchingSearchQueries : [];
  const termsCard = `<div class="ep-card ow-st-card" data-stats="terms">
        <h2>${esc(T.termsTitle)}</h2>
        <ul class="ow-st-list">${terms.map((t) => row(esc(t.term), `${esc(t.count)} ×`, ` data-term-count="${esc(t.count)}"`)).join("") || empty(T.termsNone)}</ul>
      </div>`;
  const channels = Array.isArray(s.conversationsByChannel) ? s.conversationsByChannel : [];
  const channelsCard = `<div class="ep-card ow-st-card" data-stats="channels">
        <h2>${esc(T.channelsTitle)}</h2>
        <ul class="ow-st-list">${channels.map((c) => row(esc(ownLabel(T.channelLabels, c.source) || c.source), esc(c.count), ` data-channel="${esc(c.source)}"`)).join("") || empty(T.channelsNone)}</ul>
      </div>`;
  const clicks = Array.isArray(s.contactClicksByKind) ? s.contactClicksByKind : [];
  const clicksCard = `<div class="ep-card ow-st-card" data-stats="clicks">
        <h2>${esc(T.clicksTitle)}</h2>
        <p class="ow-st-hint">${esc(T.clicksHint)}</p>
        <ul class="ow-st-list">${clicks.map((c) => row(esc(ownerStatsClickKindLabel(c.kind)), esc(c.count), ` data-kind="${esc(c.kind)}"`)).join("") || empty(T.clicksNone)}</ul>
      </div>`;

  return [emptyStateHtml(s), funnel, aiFunnel, views, aiCard, dlCard, termsCard, channelsCard, clicksCard].filter(Boolean).join("\n      ");
}

/** The whole page body: the <h1> card and the sections (the route wraps it in the theme and the shell). */
export function renderOwnerStatsPageBody(m: OwnerStatsPageModel): string {
  return `<style>${OWNER_STATS_PAGE_CSS}</style>
      <div class="ep-card">
        <h1>${esc(OWNER_STATS_PAGE_TEXTS.title)}</h1>
      </div>
      ${renderOwnerStatsSections(m)}
    `;
}
