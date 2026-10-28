// ─── «Mine valg» — the owner page (HTML) ────────────────────────────────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, slice S2b. Pure
// rendering: the route (routes/owner-features.ts) gathers the data and wraps
// the body in the owner portal shell. Groups, order and rows come from the
// registry only — a new registry entry gets a row in its group with no UI
// change (AC10). Plain forms (POST → 303), no client framework, no script;
// mobile first (375 px, tap targets ≥ 44 px), light and dark (AC13).
// Every piece of text and every attribute value goes through escapeHtml.

import { escapeHtml } from "../routes/owner-portal";
import {
  OWNER_FEATURE_GROUPS,
  OWNER_FEATURE_REGISTRY,
  findOwnerFeature,
  type OwnerFeatureEntry,
  type OwnerFeatureValue,
} from "./registry";
import type { ResolvedOwnerFeature, ResolvedOwnerFeatures } from "./resolve";
import {
  OWNER_LEVELS,
  OWNER_LEVEL_CUSTOM_LABEL,
  type OwnerChangeLogRow,
  type OwnerLevelKey,
  type OwnerLevelPreview,
} from "./changes";

/** Entries that need this key on are shown only when it is on (spec «Grensesnitt»). */
export const OWNER_PAGE_REVEAL_KEY = "orders.enabled";
/** «Nytt» badge for this many days after `since` (spec principle 6). */
export const OWNER_PAGE_NEW_DAYS = 30;
/** «Slik er du nå» status line. */
export const OWNER_PAGE_STATUS_KEYS = [
  "visibility.profile", "visibility.ai_assistants", "orders.enabled",
  "payments.prepay", "products.weekly_sync", "notify.report",
];

export interface OwnerPageNotice {
  ok: boolean;
  text: string;
  /** Set when «Angre» applies to this change. */
  undoBatchId?: number | null;
}

export interface OwnerPageModel {
  agent: { id: string; name: string };
  resolved: ResolvedOwnerFeatures;
  registry?: OwnerFeatureEntry[];
  level: OwnerLevelKey | "custom";
  showIntro: boolean;
  notice: OwnerPageNotice | null;
  /** In-page confirm panel for one switch (confirmOn / confirmOff). */
  confirm: { key: string; value: boolean } | null;
  levelPreview: OwnerLevelPreview | null;
  log: { rows: OwnerChangeLogRow[]; page: number; pages: number; total: number };
  now?: Date;
}

const esc = (v: unknown): string => escapeHtml(String(v ?? ""));

export function formatOwnerFeatureValue(e: OwnerFeatureEntry | undefined, v: OwnerFeatureValue): string {
  if (e && e.type === "guarantee") return "Alltid";
  if (v === true) return e && e.type === "locked" ? "Låst på" : "På";
  if (v === false) return "Av";
  if (v === null || v === undefined) {
    if (e && e.type === "number") return "Ingen";
    if (e && e.type === "email") return "Profilens e-post";
    return "Gjelder ikke";
  }
  if (e && e.type === "choice") {
    const o = (e.options || []).find((x) => x.value === v);
    if (o) return o.label.no;
  }
  return String(v);
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", dateStyle: "short", timeStyle: "short" }).format(d);
  } catch {
    return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  }
}

const ACTOR_LABELS: Record<string, string> = {
  owner: "Du",
  cs: "Kundeservice",
  admin: "Rett fra Bonden",
  system: "Systemet",
};

function isNew(e: OwnerFeatureEntry, now: Date): boolean {
  if (e.status !== "live") return false;
  const since = new Date(`${e.since}T00:00:00Z`).getTime();
  if (Number.isNaN(since)) return false;
  const age = now.getTime() - since;
  return age >= 0 && age < OWNER_PAGE_NEW_DAYS * 86_400_000;
}

function actionPath(agentId: string, tail: string): string {
  return `/eier/${encodeURIComponent(agentId)}/valg${tail}`;
}

/** The control for one row. */
function controlHtml(agentId: string, e: OwnerFeatureEntry, r: ResolvedOwnerFeature): string {
  const state = `<span class="mv-state">${esc(formatOwnerFeatureValue(e, r.value))}</span>`;
  if (e.status === "coming_soon") {
    return `${state}<button type="button" class="ep-btn mv-btn-off" disabled aria-disabled="true">Kommer snart</button>`;
  }
  if (e.type === "guarantee") return `<span class="mv-state mv-always">Alltid</span>`;
  if (!r.changeable || e.type === "locked" || e.type === "action") return state;
  const form = (inner: string) =>
    `<form method="post" action="${esc(actionPath(agentId, "/sett"))}" class="mv-ctl-form">` +
    `<input type="hidden" name="key" value="${esc(e.key)}">${inner}</form>`;
  const fieldId = `mv-f-${e.key.replace(/[^a-z0-9]/gi, "-")}`;
  switch (e.type) {
    case "switch": {
      const on = r.value === true;
      return state + form(
        `<input type="hidden" name="value" value="${on ? "false" : "true"}">` +
        `<button type="submit" class="ep-btn ${on ? "ep-btn-secondary" : "ep-btn-primary"}" aria-pressed="${on ? "true" : "false"}">${on ? "Slå av" : "Slå på"}</button>`,
      );
    }
    case "choice": {
      const opts = (e.options || []).map((o) =>
        `<option value="${esc(o.value)}"${o.value === r.value ? " selected" : ""}>${esc(o.label.no)}</option>`).join("");
      return form(
        `<label class="mv-sr" for="${esc(fieldId)}">${esc(e.label.no)}</label>` +
        `<select id="${esc(fieldId)}" name="value">${opts}</select>` +
        `<button type="submit" class="ep-btn ep-btn-secondary">Lagre</button>`,
      );
    }
    case "number":
    case "email":
    case "date": {
      const type = e.type === "number" ? "number" : e.type === "email" ? "email" : "date";
      const extra = e.type === "number"
        ? `${e.min !== undefined ? ` min="${esc(e.min)}"` : ""}${e.max !== undefined ? ` max="${esc(e.max)}"` : ""} inputmode="numeric"`
        : "";
      return form(
        `<label class="mv-sr" for="${esc(fieldId)}">${esc(e.label.no)}</label>` +
        `<input id="${esc(fieldId)}" name="value" type="${type}" value="${esc(r.value ?? "")}"${extra}>` +
        `<button type="submit" class="ep-btn ep-btn-secondary">Lagre</button>`,
      );
    }
    default:
      return state;
  }
}

function rowHtml(agentId: string, e: OwnerFeatureEntry, r: ResolvedOwnerFeature, now: Date): string {
  const badges =
    (isNew(e, now) ? ` <span class="mv-badge mv-badge-new">Nytt</span>` : "") +
    (e.status === "coming_soon" ? ` <span class="mv-badge">Kommer snart</span>` : "") +
    (e.consent ? ` <span class="mv-badge">Samtykke</span>` : "");
  // A lock / requirement reason (coming_soon has its badge instead).
  const reason = r.reason && e.status !== "coming_soon" && e.type !== "guarantee"
    ? `<p class="mv-reason">${esc(r.reason.no)}</p>` : "";
  return `<li class="mv-item${e.status === "coming_soon" ? " mv-item-soon" : ""}" id="valg-${esc(e.key)}" data-key="${esc(e.key)}">
          <div class="mv-item-text"><strong>${esc(e.label.no)}</strong>${badges}<p class="mv-desc">${esc(e.description.no)}</p>${reason}</div>
          <div class="mv-item-ctl">${controlHtml(agentId, e, r)}</div>
        </li>`;
}

function groupsHtml(m: OwnerPageModel, registry: OwnerFeatureEntry[], now: Date): string {
  const reveal = findOwnerFeature(OWNER_PAGE_REVEAL_KEY, registry);
  const revealOn = !!reveal && m.resolved.byKey[reveal.key]?.value === true;
  return OWNER_FEATURE_GROUPS.map((g) => {
    const entries = registry.filter((e) => e.group === g.key && m.resolved.byKey[e.key]);
    if (entries.length === 0) return "";
    const hidden = entries.filter((e) => !!reveal && !revealOn && e.requires.includes(reveal.key as any));
    const shown = entries.filter((e) => !hidden.includes(e));
    const basic = shown.filter((e) => !e.advanced).map((e) => rowHtml(m.agent.id, e, m.resolved.byKey[e.key], now)).join("");
    const adv = shown.filter((e) => e.advanced).map((e) => rowHtml(m.agent.id, e, m.resolved.byKey[e.key], now)).join("");
    const hiddenNote = hidden.length && reveal
      ? `<p class="mv-note">${hidden.length} valg til vises når du slår på «${esc(reveal.label.no)}».</p>`
      : "";
    return `<section class="ep-card mv-group" id="gruppe-${esc(g.key)}" data-group="${esc(g.key)}" aria-labelledby="mv-h-${esc(g.key)}">
        <h2 id="mv-h-${esc(g.key)}">${esc(g.label.no)}</h2>
        ${basic ? `<ul class="mv-list">${basic}</ul>` : ""}
        ${adv ? `<details class="mv-more"><summary>Flere valg</summary><ul class="mv-list">${adv}</ul></details>` : ""}
        ${hiddenNote}
      </section>`;
  }).join("\n");
}

function levelsHtml(m: OwnerPageModel): string {
  const cards = OWNER_LEVELS.map((l) => {
    const current = m.level === l.key;
    return `<li class="mv-level"${current ? ` aria-current="true"` : ""} data-level="${esc(l.key)}">
          <strong>${esc(l.label.no)}</strong>${l.recommended ? ` <span class="mv-badge mv-badge-new">Anbefalt</span>` : ""}${l.key === "bare_synlig" ? ` <span class="mv-badge">Standard</span>` : ""}
          <p class="mv-desc">${esc(l.description.no)}</p>
          ${current
            ? `<span class="mv-state">Valgt</span>`
            : `<form method="get" action="${esc(actionPath(m.agent.id, ""))}" class="mv-ctl-form"><input type="hidden" name="niva" value="${esc(l.key)}"><button type="submit" class="ep-btn ep-btn-secondary">Velg «${esc(l.label.no)}»</button></form>`}
        </li>`;
  }).join("");
  const customNote = m.level === "custom"
    ? `<p class="mv-note">Nå: <strong>${esc(OWNER_LEVEL_CUSTOM_LABEL.no)}</strong> — du har valgt noe annet enn nivåene under.</p>`
    : "";
  return `<section class="ep-card" id="niva" aria-labelledby="mv-h-niva">
        <h2 id="mv-h-niva">Hvor aktiv vil du være?</h2>
        ${customNote}
        <ul class="mv-levels">${cards}</ul>
        ${statusLineHtml(m)}
      </section>`;
}

function statusLineHtml(m: OwnerPageModel): string {
  const registry = m.registry ?? OWNER_FEATURE_REGISTRY;
  const items = OWNER_PAGE_STATUS_KEYS.map((k) => {
    const e = findOwnerFeature(k, registry);
    const r = m.resolved.byKey[k];
    if (!e || !r) return "";
    return `<li><span>${esc(e.label.no)}:</span> <strong>${esc(formatOwnerFeatureValue(e, r.value))}</strong></li>`;
  }).join("");
  return items ? `<div class="mv-status"><h3>Slik er du nå</h3><ul>${items}</ul></div>` : "";
}

function levelPreviewHtml(m: OwnerPageModel): string {
  const p = m.levelPreview;
  if (!p) return "";
  const registry = m.registry ?? OWNER_FEATURE_REGISTRY;
  const label = (k: string) => findOwnerFeature(k, registry)?.label.no ?? k;
  const changes = p.changes.map((c) => {
    const e = findOwnerFeature(c.key, registry);
    const confirm = c.to === true ? e?.confirmOn : c.to === false ? e?.confirmOff : undefined;
    return `<li><strong>${esc(label(c.key))}</strong>: ${esc(formatOwnerFeatureValue(e, c.from))} → ${esc(formatOwnerFeatureValue(e, c.to))}${confirm ? `<p class="mv-desc">${esc(confirm.no)}</p>` : ""}</li>`;
  }).join("");
  const skipped = p.skipped.map((s) => `<li><strong>${esc(label(s.key))}</strong> endres ikke: ${esc(s.reason.no)}</li>`).join("");
  const cancel = `<a class="ep-btn ep-btn-secondary" href="${esc(actionPath(m.agent.id, "#niva"))}">Avbryt</a>`;
  const body = p.changes.length
    ? `<p>Dette endres:</p><ul>${changes}</ul>${skipped ? `<ul>${skipped}</ul>` : ""}
        <div class="ep-form-actions">
          <form method="post" action="${esc(actionPath(m.agent.id, "/niva"))}" class="mv-ctl-form">
            <input type="hidden" name="level" value="${esc(p.level.key)}">
            <input type="hidden" name="confirmed" value="1">
            <button type="submit" class="ep-btn ep-btn-primary">Bekreft «${esc(p.level.label.no)}»</button>
          </form>
          ${cancel}
        </div>`
    : `<p>Ingenting endres nå. Valgene i dette nivået som ikke er i gang ennå, kommer snart.</p>${skipped ? `<ul>${skipped}</ul>` : ""}
        <div class="ep-form-actions">${cancel}</div>`;
  return `<section class="ep-card mv-confirm" id="bekreft" role="region" aria-labelledby="mv-h-bekreft">
        <h2 id="mv-h-bekreft">Bytte til «${esc(p.level.label.no)}»?</h2>
        ${body}
      </section>`;
}

function confirmHtml(m: OwnerPageModel): string {
  const c = m.confirm;
  if (!c) return "";
  const registry = m.registry ?? OWNER_FEATURE_REGISTRY;
  const e = findOwnerFeature(c.key, registry);
  const text = e ? (c.value ? e.confirmOn : e.confirmOff) : undefined;
  if (!e || !text) return "";
  return `<section class="ep-card mv-confirm" id="bekreft" role="region" aria-labelledby="mv-h-bekreft">
        <h2 id="mv-h-bekreft">${esc(c.value ? "Slå på" : "Slå av")} «${esc(e.label.no)}»?</h2>
        <p>${esc(text.no)}</p>
        <div class="ep-form-actions">
          <form method="post" action="${esc(actionPath(m.agent.id, "/sett"))}" class="mv-ctl-form">
            <input type="hidden" name="key" value="${esc(e.key)}">
            <input type="hidden" name="value" value="${c.value ? "true" : "false"}">
            <input type="hidden" name="confirmed" value="1">
            <button type="submit" class="ep-btn ep-btn-primary">Ja, ${esc(c.value ? "slå på" : "slå av")}</button>
          </form>
          <a class="ep-btn ep-btn-secondary" href="${esc(actionPath(m.agent.id, `#valg-${e.key}`))}">Avbryt</a>
        </div>
      </section>`;
}

function introHtml(m: OwnerPageModel): string {
  if (!m.showIntro) return "";
  const form = (answer: "yes" | "no", label: string, cls: string) =>
    `<form method="post" action="${esc(actionPath(m.agent.id, "/intro"))}" class="mv-ctl-form"><input type="hidden" name="answer" value="${answer}"><button type="submit" class="ep-btn ${cls}">${label}</button></form>`;
  return `<section class="ep-card mv-intro" id="velkommen" aria-labelledby="mv-h-intro">
        <h2 id="mv-h-intro">Nyheter og tips</h2>
        <p>Vil du ha nyheter og tips fra Rett fra Bonden på e-post? Det er frivillig, og du kan endre svaret når som helst under «Kontakt fra Rett fra Bonden».</p>
        <div class="ep-form-actions">${form("yes", "Ja takk", "ep-btn-primary")}${form("no", "Nei takk", "ep-btn-secondary")}</div>
      </section>`;
}

function logHtml(m: OwnerPageModel): string {
  const registry = m.registry ?? OWNER_FEATURE_REGISTRY;
  const items = m.log.rows.map((r) => {
    const e = findOwnerFeature(r.key, registry);
    const label = e ? e.label.no : r.key;
    const who = ACTOR_LABELS[r.actor] ?? "Systemet";
    return `<li class="ep-audit-item"><strong>${esc(label)}</strong>: ${esc(formatOwnerFeatureValue(e, r.old_value))} → ${esc(formatOwnerFeatureValue(e, r.new_value))}${r.undo ? ` <span class="mv-badge">Angret</span>` : ""}
          <div class="ep-audit-meta">${esc(formatWhen(r.at))} · ${esc(who)}</div></li>`;
  }).join("");
  const nav: string[] = [];
  if (m.log.page > 1) nav.push(`<a class="ep-btn ep-btn-secondary" href="${esc(actionPath(m.agent.id, `?side=${m.log.page - 1}#endringslogg`))}">Nyere</a>`);
  if (m.log.page < m.log.pages) nav.push(`<a class="ep-btn ep-btn-secondary" href="${esc(actionPath(m.agent.id, `?side=${m.log.page + 1}#endringslogg`))}">Eldre</a>`);
  return `<section class="ep-card" id="endringslogg" aria-labelledby="mv-h-logg">
        <h2 id="mv-h-logg">Endringslogg</h2>
        <p class="mv-desc">Hva som er endret, når og av hvem. Nyeste først.</p>
        ${items ? `<ul class="ep-audit-list">${items}</ul>` : `<p class="mv-desc">Ingen endringer ennå.</p>`}
        ${nav.length ? `<div class="ep-form-actions mv-pager">${nav.join("")}<span class="mv-desc">Side ${m.log.page} av ${m.log.pages}</span></div>` : ""}
      </section>`;
}

function noticeHtml(m: OwnerPageModel): string {
  const n = m.notice;
  if (!n) return "";
  const undo = n.undoBatchId
    ? `<form method="post" action="${esc(actionPath(m.agent.id, "/angre"))}" class="mv-ctl-form"><input type="hidden" name="batch" value="${esc(n.undoBatchId)}"><button type="submit" class="ep-btn ep-btn-secondary">Angre</button></form>`
    : "";
  return `<div class="mv-toast ${n.ok ? "mv-toast-ok" : "mv-toast-error"}" role="${n.ok ? "status" : "alert"}"><span>${esc(n.text)}</span>${undo}</div>`;
}

/** Page-only CSS on top of PORTAL_PALETTE_CSS: layout, ≥ 44 px targets, dark mode. */
export const OWNER_PAGE_CSS = `
  :root { color-scheme: light dark; }
  .mv-page, .mv-page * { overflow-wrap: anywhere; }
  .mv-page { max-width: 100%; }
  .mv-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .mv-desc { margin: 4px 0 0; font-size: 0.88rem; color: #595959; }
  .mv-reason { margin: 4px 0 0; font-size: 0.85rem; color: #92400e; }
  .mv-note { font-size: 0.88rem; color: #595959; margin: 12px 0 0; }
  .mv-list { list-style: none; margin: 0; padding: 0; }
  .mv-item { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; padding: 12px 0; border-bottom: 1px solid #f0f0e8; }
  .mv-item:last-child { border-bottom: none; }
  .mv-item-text { flex: 1 1 220px; min-width: 0; }
  .mv-item-ctl { flex: 0 1 auto; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; max-width: 100%; }
  .mv-item-soon .mv-item-text strong { color: #595959; }
  .mv-ctl-form { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; max-width: 100%; }
  .mv-ctl-form select, .mv-ctl-form input:not([type=hidden]) { min-height: 44px; max-width: 100%; padding: 8px 10px; font-size: 1rem; font-family: inherit; border: 1px solid #d4d4d4; border-radius: 8px; background: #fff; color: #1a1a1a; }
  .mv-state { display: inline-flex; align-items: center; min-height: 44px; font-weight: 600; }
  .mv-always { color: #2D5016; }
  .mv-btn-off { background: #f0f0e8; color: #595959; cursor: not-allowed; }
  .mv-badge { display: inline-block; font-size: 0.72rem; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: #f0f0e8; color: #404040; vertical-align: middle; }
  .mv-badge-new { background: #e7f2dc; color: #2D5016; }
  .mv-levels { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: 1fr; gap: 12px; }
  .mv-level { border: 1px solid #e5e5e5; border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 6px; }
  .mv-level[aria-current="true"] { border-color: #2D5016; box-shadow: inset 0 0 0 1px #2D5016; }
  @media (min-width: 640px) { .mv-levels { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  .mv-status { margin-top: 16px; }
  .mv-status h3 { font-size: 0.95rem; margin: 0 0 6px; }
  .mv-status ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 0.88rem; }
  .mv-more summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; font-weight: 600; color: #2D5016; }
  .mv-confirm { border-color: #2D5016; }
  .mv-toast { position: sticky; bottom: 0; z-index: 10; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; margin-top: 16px; padding: 10px 14px; border-radius: 10px; font-size: 0.95rem; box-shadow: 0 -2px 8px rgba(0,0,0,0.08); }
  .mv-toast-ok { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }
  .mv-toast-error { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
  .mv-pager { align-items: center; }
  @media (prefers-color-scheme: dark) {
    body { background: #12150e; color: #ebe8dc; }
    a, .ep-logo { color: #b9d99a; }
    .ep-logo span { color: #e2bf97; }
    .ep-card { background: #1c2116; border-color: #313b27; box-shadow: none; }
    .ep-card h1, .ep-card h2, .mv-always, .mv-more summary { color: #b9d99a; }
    .ep-card h2, .mv-item, .ep-audit-item { border-color: #313b27; }
    .ep-btn-primary { background: #4c7d2c; color: #fff; }
    .ep-btn-primary:hover, .ep-btn-primary:focus { background: #5a9134; }
    .ep-btn-secondary { background: transparent; color: #cfe6b8; border-color: #8fb86e; }
    .ep-btn-secondary:hover { background: #26301d; }
    .ep-btn-ghost { color: #b5b0a0; }
    .mv-desc, .mv-note, .ep-audit-meta, .mv-item-soon .mv-item-text strong { color: #b5b0a0; }
    .mv-reason { color: #f5c27a; }
    .mv-btn-off { background: #2a3022; color: #a3a091; }
    .mv-badge { background: #2a3022; color: #d8d4c4; }
    .mv-badge-new { background: #2f4a1c; color: #cfe6b8; }
    .mv-level { border-color: #313b27; }
    .mv-level[aria-current="true"] { border-color: #8fb86e; box-shadow: inset 0 0 0 1px #8fb86e; }
    .mv-ctl-form select, .mv-ctl-form input:not([type=hidden]) { background: #12150e; color: #ebe8dc; border-color: #4a5640; }
    .mv-toast-ok { background: #15301d; color: #bbf7d0; border-color: #24543a; }
    .mv-toast-error { background: #3a1616; color: #fecaca; border-color: #6b2525; }
  }
`;

/** The page body (inside portalShell). */
export function renderOwnerFeaturesPageBody(m: OwnerPageModel): string {
  const registry = m.registry ?? OWNER_FEATURE_REGISTRY;
  const now = m.now ?? new Date();
  const back = `/eier/${encodeURIComponent(m.agent.id)}/portal`;
  return `<style>${OWNER_PAGE_CSS}</style>
    <div class="mv-page">
      <div class="ep-card">
        <h1>Mine valg</h1>
        <p><strong>${esc(m.agent.name)}</strong>. Endringer lagres med en gang, og du kan angre den siste.</p>
        <div class="ep-form-actions"><a class="ep-btn ep-btn-secondary" href="${esc(back)}">Tilbake til eierportalen</a></div>
      </div>
      ${introHtml(m)}
      ${confirmHtml(m)}
      ${levelPreviewHtml(m)}
      ${levelsHtml(m)}
      ${groupsHtml(m, registry, now)}
      ${logHtml(m)}
      ${noticeHtml(m)}
    </div>`;
}
