// ─── «Mine valg» — the owner page (HTML) ────────────────────────────────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, slice S2b, redesigned in
// S2e («v2 — ny utforming», Daniel 2026-10-28). Pure rendering: the route
// (routes/owner-features.ts) gathers the data and wraps the body in the owner
// portal shell. Groups, order and rows come from the registry only — a new
// registry entry gets a row in its group with no UI change (AC10).
//
// v2 principles this file carries:
//   2. Only real choices in the main view: a `coming_soon` entry is never a
//      (grey) switch; all of them sit in one closed «Planlagt — si fra hvis du
//      vil ha dette (N)» box at the bottom, each with «Gi meg beskjed».
//   3. Two honest levels; a level is marked only after the owner chose it.
//   4. orders.enabled explains itself where it is taken (fold-out) and shows
//      the prerequisite check (orderable items) above the switch.
//   5. No fake values: an unbuilt entry shows no value and is not in «Slik er
//      du nå».
//   6. One switch, one place: the profile pause and the order address live
//      here (the /eier cards link here instead).
//   7. Words: no «Gjelder ikke» for something the owner can get later; «Nytt»
//      only on live entries; «Alltid» / «Låst på» explained the first time.
//   8. The first-login answer is the comms.news row's value at once.
//   9. Foldable cards, jump links on mobile; a save updates only its card
//      when JavaScript runs (progressive enhancement), and every form works
//      as a plain POST → 303 without it.
// Mobile first (375 px, tap targets ≥ 44 px), light and dark (AC13). Every
// piece of text and every attribute value goes through escapeHtml.

import { escapeHtml } from "../routes/owner-portal";
import {
  OWNER_FEATURE_GROUPS,
  OWNER_FEATURE_REGISTRY,
  findOwnerFeature,
  type LocalizedText,
  type OwnerFeatureEntry,
  type OwnerFeatureGroup,
  type OwnerFeatureValue,
  type OwnerFeatureVertical,
} from "./registry";
import type { ResolvedOwnerFeature, ResolvedOwnerFeatures } from "./resolve";
import {
  OWNER_LEVELS,
  OWNER_LEVEL_CUSTOM_LABEL,
  type OwnerLevel,
  type OwnerChangeLogRow,
  type OwnerLevelKey,
  type OwnerLevelPreview,
} from "./changes";
import type { OwnerStats } from "../services/owner-stats-service";

/** Entries that need this key on are shown only when it is on (spec «Grensesnitt»). */
export const OWNER_PAGE_REVEAL_KEY = "orders.enabled";
/** «Nytt» badge for this many days after `since` (spec principle 6). */
export const OWNER_PAGE_NEW_DAYS = 30;
/** «Slik er du nå» status line — only the `live` ones are shown (v2 principle 5). */
export const OWNER_PAGE_STATUS_KEYS = [
  "visibility.profile", "visibility.ai_assistants", "orders.enabled",
  "payments.prepay", "products.weekly_sync", "notify.report",
];
/** The key whose row carries the order explanation and the prerequisite check. */
export const OWNER_PAGE_ORDERS_KEY = "orders.enabled";
/** The pause row (the old /eier «Pause og sletting» card). */
export const OWNER_PAGE_PAUSE_KEY = "visibility.profile";
/** The order-address row (the old form inside the /eier «Bestillinger» card). */
export const OWNER_PAGE_ORDER_EMAIL_KEY = "orders.email";
/** Heading of the planned box; the count is appended as « (N)». */
export const OWNER_PAGE_PLANNED_TITLE = "Planlagt — si fra hvis du vil ha dette";

const CS_EMAIL = "kontakt@rettfrabonden.com";

/**
 * What differs between the verticals that share this page (dev-request
 * 2026-10-22-opplevagent-mine-valg-gardssalg O1a: the gårdssalg tab is the
 * SAME component). Omitted = Rett fra Bonden, rendered exactly as before.
 */
export interface OwnerPageVariant {
  vertical: OwnerFeatureVertical;
  /** Who promises / locks («Alltid» explanation, the change log's admin actor). */
  platformName: string;
  /** Customer service address (deletion request on the pause row). */
  csEmail: string;
  /** The page's own path + tail (forms, links). */
  pagePath: (tail: string) => string;
  /** «Tilbake til eierportalen». */
  backHref: string;
  groups: Array<{ key: OwnerFeatureGroup; label: LocalizedText }>;
  levels: readonly OwnerLevel[];
  /** «Slik er du nå» keys (only the built ones show). */
  statusKeys: readonly string[];
  /** Entries that need this key on are shown only when it is on. */
  revealKey: string;
  /** The pause confirm panel offers the RFB resume date (owner_profile_pause.pause_until). */
  pauseResumeDate: boolean;
}

/** Gårdssalg booking row (booking.enabled): the prerequisite check and the explanation. */
export interface OwnerPageBooking {
  /** The address booking requests go to now (experience_providers.epost), or null. */
  requestEmail: string | null;
  /** Opplevagent stopped booking (admin brake); note = the operator's reason. */
  adminBrake: { note: string | null } | null;
  /** Where a missing or wrong address is fixed. */
  fixHref: string;
  /** Real timings from booking-store (previsitReminderHours / previsitExpireHours). */
  reminderHours: number;
  expireHours: number;
  /** Largest group a request can be for (BookingInputSchema party_size max). */
  maxPartySize: number;
  /** «Les mer» (/for-tilbydere#besok) — only when that page is published. */
  readMoreUrl: string | null;
}

/** Gårdssalg statistics block (the portal's own GET …/stats numbers). */
export interface OwnerPageGardssalgStats {
  humanViews: number;
  aiSearchViews: number;
  /** The page-view window of the source (ownerStatsWindowDays, raw retention). */
  windowDays: number;
  aiDeliveries: { value: number; label: string } | null;
  tip: string;
}

/** Daniel 29.10, verbatim (O1 «Prisbudskapet»): used at «Ta imot besøk». */
export const OWNER_PAGE_PRICE_MESSAGE =
  "Det koster ingenting i dag. Innfører vi provisjon på besøk, får du beskjed minst 30 dager før, og du kan slå av besøk når som helst.";
/** The gårdssalg row that carries the visit explanation, the price message and the prerequisite check. */
export const OWNER_PAGE_BOOKING_KEY = "booking.enabled";

export interface OwnerPageNotice {
  ok: boolean;
  text: string;
  /** Set when «Angre» applies to this change. */
  undoBatchId?: number | null;
}

export interface OwnerPageOrderable {
  /** Items that pass isRowOrderableForRealOrder (with orders switched on). */
  count: number;
  /** Where the owner edits the items. */
  itemsHref: string;
}

export interface OwnerPageOrderEmail {
  /** OWNER_ORDER_EMAIL_ENABLED: the change form is offered. */
  enabled: boolean;
  /** The address order mail goes to now (override or the profile e-mail). */
  current: string | null;
  /** A change waiting for the click from the new address. */
  pending: string | null;
}

export interface OwnerPageModel {
  agent: { id: string; name: string };
  resolved: ResolvedOwnerFeatures;
  registry?: OwnerFeatureEntry[];
  /** The owner's own level choice; null = none made (no level marked). */
  level: OwnerLevelKey | "custom" | null;
  showIntro: boolean;
  notice: OwnerPageNotice | null;
  /** In-page confirm panel for one switch (confirmOn / confirmOff). */
  confirm: { key: string; value: boolean } | null;
  levelPreview: OwnerLevelPreview | null;
  log: { rows: OwnerChangeLogRow[]; page: number; pages: number; total: number };
  now?: Date;
  /** Planned keys this owner already asked to hear about. */
  interest?: ReadonlySet<string>;
  /** Prerequisite check on the orders.enabled row. */
  orderable?: OwnerPageOrderable | null;
  /** The orders.email row. */
  orderEmail?: OwnerPageOrderEmail | null;
  /** Resume date of a current profile pause (visibility.profile off). */
  pauseUntil?: string | null;
  /** FAQ anchor for «Les mer» — only when that page is published (else null: inline text only). */
  ordersReadMoreUrl?: string | null;
  /** Real follow-up timings for the explanation (ORDER_REMINDER_HOURS / ORDER_AUTOCANCEL_HOURS). */
  orderTimings?: { reminderHours: number; autocancelHours: number; dailyCap?: number; capNotice?: boolean };
  /**
   * S2f statistics block at the top (v2 principle 1). undefined = no block;
   * null = the read failed (the block says so and keeps the link).
   */
  stats?: OwnerPageStats | null;
  /** The vertical's differences; omitted = Rett fra Bonden. */
  variant?: OwnerPageVariant;
  /** Gårdssalg: the booking.enabled row's check and explanation. */
  booking?: OwnerPageBooking | null;
  /** Gårdssalg: the statistics block (instead of `stats`). undefined = none, null = read failed. */
  gardssalgStats?: OwnerPageGardssalgStats | null;
  /** «Se all statistikk» (the Statistikk tab in /selger). */
  statsHref?: string;
}

// ── S2f: «Dette har profilen gjort for deg» ─────────────────────────────────
// The numbers are the /selger Statistikk tab's own: the same getOwnerStats()
// payload (GET /api/agents/:id/owner-stats), the same fields and the same
// windows and labels as selger.html renderOwnerStats() — no new counting and
// no new definition. People's page views, all AI search and «Med i AI-søk»
// are over 12 months («siste 12 måneder» / «siden <dato>»); the ChatGPT /
// Claude / other split and the contact clicks exist only for the raw window
// (windowDays, 60), as in the tab, and say so. Clicks to the map are not
// counted anywhere yet, so the block says that instead of showing a number.

/** The statistics block's numbers, read off one getOwnerStats() payload. */
export interface OwnerPageStats {
  humanViews: { value: number; label: string };
  aiViews: { value: number; label: string };
  aiSplit: { chatgpt: number; claude: number; other: number; days: number };
  aiDeliveries: { value: number; label: string };
  clicks: { phone: number; website: number; days: number };
  /** The public threshold (PUBLIC_STATS_MIN_VIEWS) at render time. */
  minPublicViews: number;
  /** One concrete tip from what the profile is missing (shown with low numbers). */
  tip: string;
}

/** What the tip looks at (agent_knowledge columns). */
export interface OwnerProfileGaps {
  opening_hours?: unknown;
  products?: unknown;
  about?: unknown;
  phone?: unknown;
  website?: unknown;
}

function blankJson(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  const t = String(v).trim();
  if (t === "" || t === "[]" || t === "{}" || t === "null") return true;
  try {
    const p = JSON.parse(t);
    if (Array.isArray(p)) return p.length === 0;
    if (p && typeof p === "object") return Object.keys(p).length === 0;
  } catch { /* free text: not blank */ }
  return false;
}

/** ONE tip, from the first thing the profile is missing (else: share the link). */
export function ownerProfileTip(k: OwnerProfileGaps | null | undefined): string {
  const g = k || {};
  if (blankJson(g.opening_hours)) return "Legg til åpningstider, så vet folk når de kan komme.";
  if (blankJson(g.products)) return "Legg inn varene dine, så har folk og AI-assistenter noe konkret å finne.";
  if (blankJson(g.about)) return "Skriv noen setninger om gården og det du lager.";
  if (blankJson(g.phone)) return "Legg til telefonnummeret ditt, så kan folk ringe deg direkte.";
  if (blankJson(g.website)) return "Legg til nettsiden din, så kan folk lese mer om deg.";
  return "Del lenken til profilen din i egne kanaler, for eksempel Facebook eller nyhetsbrevet ditt.";
}

/**
 * The block's numbers from the tab's payload — exactly the fields and labels
 * selger.html shows: year.humanViews, year.aiViews, aiPlatforms, aiDeliveries.
 * window.total with year.labels.nb.aiDeliveries, contactClicksByKind.
 */
export function ownerPageStatsFrom(s: OwnerStats, opts: { minPublicViews: number; profile?: OwnerProfileGaps | null }): OwnerPageStats {
  const wd = s.windowDays || 60;
  const nb = (s.year && s.year.labels && s.year.labels.nb) || ({} as Record<string, string>);
  const clicks = (kind: string) => (s.contactClicksByKind || []).filter((c) => c.kind === kind).reduce((n, c) => n + (c.count || 0), 0);
  return {
    humanViews: { value: s.year?.humanViews?.value ?? 0, label: nb.humanViews || `${wd}d` },
    aiViews: { value: s.year?.aiViews?.value ?? 0, label: nb.aiViews || `${wd}d` },
    aiSplit: { chatgpt: s.aiPlatforms?.chatgpt ?? 0, claude: s.aiPlatforms?.claude ?? 0, other: s.aiPlatforms?.other ?? 0, days: wd },
    aiDeliveries: { value: s.aiDeliveries?.window?.total ?? 0, label: nb.aiDeliveries || "siste 12 måneder" },
    clicks: { phone: clicks("phone"), website: clicks("website"), days: wd },
    minPublicViews: opts.minPublicViews,
    tip: ownerProfileTip(opts.profile),
  };
}

/** Used when PUBLIC_STATS_MIN_VIEWS is 0 (no public threshold): what still counts as low. */
export const OWNER_PAGE_LOW_VIEWS_FALLBACK = 20;

/**
 * «Low» numbers: fewer people's page views over 12 months than the public
 * threshold (PUBLIC_STATS_MIN_VIEWS, default 20) — the same point at which
 * the public tiles appear on the profile. With the threshold switched off
 * (0) the default 20 is used, so a new profile still gets the tip.
 */
export function ownerStatsAreLow(st: OwnerPageStats): boolean {
  const min = st.minPublicViews > 0 ? st.minPublicViews : OWNER_PAGE_LOW_VIEWS_FALLBACK;
  return st.humanViews.value < min;
}

const esc = (v: unknown): string => escapeHtml(String(v ?? ""));

/** Is the entry built (shown in the main view with its value)? */
export function isOwnerFeatureBuilt(e: OwnerFeatureEntry): boolean {
  return e.status !== "coming_soon";
}

/**
 * The value as text (rows, change log, notices). Never «Gjelder ikke»
 * (v2 principle 7): null reads «Ikke valgt» unless the type names it.
 */
export function formatOwnerFeatureValue(e: OwnerFeatureEntry | undefined, v: OwnerFeatureValue): string {
  if (e && e.type === "guarantee") return "Alltid";
  if (v === true) return e && e.type === "locked" ? "Låst på" : "På";
  if (v === false) return "Av";
  if (v === null || v === undefined) {
    if (e && e.type === "number") return "Ingen";
    if (e && e.type === "email") return "Profilens e-post";
    return "Ikke valgt";
  }
  if (e && e.type === "choice") {
    const o = (e.options || []).find((x) => x.value === v);
    if (o) return o.label.no;
  }
  return String(v);
}

/** The value shown in a row: none at all for an unbuilt entry (v2 principle 5). */
export function ownerFeatureRowValue(e: OwnerFeatureEntry, r: ResolvedOwnerFeature | undefined): string | null {
  if (!isOwnerFeatureBuilt(e) || !r) return null;
  return formatOwnerFeatureValue(e, r.value);
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

function formatDay(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : ymd;
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

function actionPath(m: OwnerPageModel, tail: string): string {
  if (m.variant) return m.variant.pagePath(tail);
  return `/eier/${encodeURIComponent(m.agent.id)}/valg${tail}`;
}

function platformName(m: OwnerPageModel): string {
  return m.variant ? m.variant.platformName : "Rett fra Bonden";
}

function pageGroups(m: OwnerPageModel): Array<{ key: OwnerFeatureGroup; label: LocalizedText }> {
  return m.variant ? m.variant.groups : OWNER_FEATURE_GROUPS;
}

/** Per-render state: «Alltid» / «Låst på» are explained the first time only. */
interface RenderCtx {
  m: OwnerPageModel;
  now: Date;
  explainedAlways: boolean;
  explainedLocked: boolean;
}

/** `data-mv-row` names the element the enhancement script swaps after a save. */
function rowForm(m: OwnerPageModel, tail: string, swap: string, inner: string): string {
  return `<form method="post" action="${esc(actionPath(m, tail))}" class="mv-ctl-form" data-mv-row="${esc(swap)}">${inner}</form>`;
}

/** The control for one row. */
function controlHtml(ctx: RenderCtx, e: OwnerFeatureEntry, r: ResolvedOwnerFeature, swap: string): string {
  const valueText = ownerFeatureRowValue(e, r) ?? "";
  if (e.type === "guarantee") return `<span class="mv-state mv-always">Alltid</span>`;
  if (e.key === OWNER_PAGE_ORDER_EMAIL_KEY) return orderEmailControlHtml(ctx, e, r, swap);
  const state = `<span class="mv-state">${esc(valueText)}</span>`;
  if (!r.changeable || e.type === "locked" || e.type === "action") return state;
  const form = (inner: string) => rowForm(ctx.m, "/sett", swap, `<input type="hidden" name="key" value="${esc(e.key)}">${inner}`);
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

/** orders.email: the address now, a pending change, and the confirmation form (S1b punkt 7). */
function orderEmailControlHtml(ctx: RenderCtx, e: OwnerFeatureEntry, r: ResolvedOwnerFeature, swap: string): string {
  const oe = ctx.m.orderEmail;
  const current = oe?.current ?? null;
  const shown = current ?? (r.value == null ? "" : String(r.value));
  const state = `<span class="mv-state">${shown ? esc(shown) : "Ingen adresse"}</span>`;
  if (!oe || !oe.enabled) return state;
  const fieldId = "mv-f-orders-email";
  return state + rowForm(
    ctx.m, "/ordre-epost", swap,
    `<label class="mv-sr" for="${fieldId}">Ny adresse for bestillinger</label>` +
    `<input id="${fieldId}" name="email" type="email" required autocomplete="email" placeholder="Ny adresse">` +
    `<button type="submit" class="ep-btn ep-btn-secondary">Send bekreftelse</button>`,
  );
}

/** Text under the label for the special rows (prerequisite check, explanation, pause, order address). */
function rowExtraHtml(ctx: RenderCtx, e: OwnerFeatureEntry, r: ResolvedOwnerFeature): string {
  const m = ctx.m;
  if (!m.variant && e.key === OWNER_PAGE_ORDERS_KEY) return ordersCheckHtml(m) + ordersExplainHtml(m);
  if (m.variant?.vertical === "gardssalg" && e.key === OWNER_PAGE_BOOKING_KEY) return bookingCheckHtml(m) + bookingExplainHtml(m);
  if (e.key === OWNER_PAGE_PAUSE_KEY) {
    const paused = r.value === false;
    const cs = m.variant ? m.variant.csEmail : CS_EMAIL;
    const subject = encodeURIComponent(`Be om sletting av profil: ${m.agent.name || m.agent.id} (${m.agent.id})`);
    const body = encodeURIComponent(`Hei,\n\nJeg ber om at profilen ${m.agent.name || ""} (${m.agent.id}) slettes fra ${platformName(m)}.\n\nHilsen`);
    // A row hidden by «fjern» / an admin quality hide is not the owner's pause
    // (gårdssalg: requirement visibilityOwnerControlled) — its reason says so.
    return (paused && r.block !== "requirement_not_met"
      ? `<p class="mv-check" role="status">Profilen er på midlertidig pause${m.pauseUntil ? ` til ${esc(formatDay(m.pauseUntil))}` : ""}. Den vises ikke i søk, lister, AI-tjenester eller kart.</p>`
      : "") +
      `<p class="mv-desc">Vil du heller at profilen slettes for godt? <a href="mailto:${cs}?subject=${subject}&amp;body=${body}">Be om sletting</a> — kundeservice hjelper deg.</p>`;
  }
  if (e.key === OWNER_PAGE_ORDER_EMAIL_KEY) {
    const oe = m.orderEmail;
    if (!oe) return "";
    return (oe.pending
      ? `<p class="mv-check" role="status">Venter på bekreftelse fra <strong>${esc(oe.pending)}</strong>. Klikk lenken vi sendte dit. Til da går bestillinger til den gamle adressen.</p>`
      : "") +
      (oe.enabled ? `<p class="mv-desc">Vi sender en lenke til den nye adressen. Bestillinger går til den gamle adressen til lenken er brukt.</p>` : "");
  }
  return "";
}

/**
 * Gårdssalg (O1 principle 4): the prerequisite check right at the «Ta imot
 * besøk» switch — the admin brake first (it wins over the owner), then the
 * address booking requests go to (the same rule the portal and the admin
 * lever use), with where it is fixed — and the price message, verbatim.
 */
function bookingCheckHtml(m: OwnerPageModel): string {
  const b = m.booking;
  const price = `<p class="mv-check mv-price" data-price-message="1">${esc(OWNER_PAGE_PRICE_MESSAGE)}</p>`;
  if (!b) return price;
  const cs = m.variant ? m.variant.csEmail : CS_EMAIL;
  let check: string;
  if (b.adminBrake) {
    check = `<p class="mv-check mv-check-missing" data-booking-check="admin_brake">Booking er stanset av ${esc(platformName(m))}.${b.adminBrake.note ? ` Grunn: ${esc(b.adminBrake.note)}.` : ""} Du kan ikke slå den på igjen selv. Ta kontakt med <a href="mailto:${esc(cs)}">${esc(cs)}</a>.</p>`;
  } else if (!b.requestEmail) {
    check = `<p class="mv-check mv-check-missing" data-booking-check="no_email">Profilen mangler en e-postadresse som forespørslene kan sendes til, så besøk kan ikke slås på ennå. <a href="${esc(b.fixHref)}">Be oss legge inn adressen</a>.</p>`;
  } else {
    check = `<p class="mv-check" data-booking-check="ok">Forespørsler sendes til <strong>${esc(b.requestEmail)}</strong>. Er adressen feil? <a href="${esc(b.fixHref)}">Si fra</a>.</p>`;
  }
  return check + price;
}

/** Gårdssalg (O1 principle 4): «Slik fungerer det», read from booking-store as built. */
function bookingExplainHtml(m: OwnerPageModel): string {
  const b = m.booking;
  if (!b) return "";
  const name = esc(platformName(m));
  const readMore = b.readMoreUrl ? `<p><a href="${esc(b.readMoreUrl)}">Les mer</a></p>` : "";
  return `<details class="mv-explain-box">
            <summary>Slik fungerer besøk</summary>
            <h3>Slik fungerer det</h3>
            <ul>
              <li>Gjesten ber om dato, tidspunkt og antall personer (opptil ${esc(b.maxPartySize)}) på profilen din eller via en AI-assistent.</li>
              <li>Du får en e-post med lenke til en svarside der du bekrefter, avslår eller foreslår et annet tidspunkt. Du trenger ikke logge inn.</li>
              <li>Besøket skjer hos dere. ${name} selger ingenting og håndterer ikke betaling.</li>
              <li>Etter besøket bekrefter du med lenken i den samme e-posten om gjesten kom.</li>
            </ul>
            <h3>Dette må du gjøre</h3>
            <ul>
              <li>Svar på hver forespørsel: bekreft, avslå eller foreslå et annet tidspunkt.</li>
              <li>Svarer du ikke, får du en påminnelse etter ${esc(b.reminderHours)} timer.</li>
              <li>Er forespørselen fortsatt ubesvart etter ${esc(b.expireHours)} timer, utløper den, og gjesten får beskjed.</li>
              <li>Bekreft oppmøte etter besøket.</li>
            </ul>
            <h3>Hva koster det?</h3>
            <p>${esc(OWNER_PAGE_PRICE_MESSAGE)}</p>
            <h3>Slik slår du av</h3>
            <ul>
              <li>Trykk «Slå av» på denne raden. Da får gjesten kontaktinformasjonen din i stedet, og profilen er fortsatt synlig.</li>
              <li>Vil du bare ta en pause, bruk «Sesongpause». Den vises når besøk er slått på.</li>
              <li>Forespørsler du allerede har fått, må du fortsatt svare på.</li>
            </ul>
            ${readMore}
          </details>`;
}

/** v2 principle 4: the prerequisite check stands above the orders switch. */
function ordersCheckHtml(m: OwnerPageModel): string {
  const o = m.orderable;
  if (!o) return "";
  const link = `<a href="${esc(o.itemsHref)}">Gå til varene dine</a>`;
  if (o.count <= 0) {
    return `<p class="mv-check mv-check-missing" data-orderable="0">Du har 0 varer som kan bestilles. Legg inn varer eller hent dem fra nettsiden din. ${link}</p>`;
  }
  const n = Math.floor(o.count);
  return `<p class="mv-check" data-orderable="${n}">Du har ${n} ${n === 1 ? "vare" : "varer"} som kan bestilles. ${link}</p>`;
}

/** v2 principle 4: the fold-out explanation, from the flow as it is built. */
function ordersExplainHtml(m: OwnerPageModel): string {
  const t = m.orderTimings ?? { reminderHours: 24, autocancelHours: 72 };
  // B4: the daily cap, from the configuration the route passes in
  // (ORDER_CAP_NEW_PER_PRODUCER_PER_DAY); no line when it is not given.
  const capLine = t.dailyCap && t.dailyCap > 0
    ? `<li data-order-cap="${esc(t.dailyCap)}">Du kan få inntil ${esc(t.dailyCap)} bestillinger per døgn. Kommer det flere, blir de gjort om til en kontaktforespørsel: kunden får kontaktinformasjonen din i stedet${t.capNotice ? ", og du får én samlet e-post om det dagen etter" : ""}.</li>`
    : "";
  const readMore = m.ordersReadMoreUrl
    ? `<p><a href="${esc(m.ordersReadMoreUrl)}">Les mer</a></p>` : "";
  return `<details class="mv-explain-box">
            <summary>Slik fungerer bestillinger</summary>
            <h3>Slik fungerer det</h3>
            <ul>
              <li>Kunder og AI-assistenter kan sende deg en bestilling på varer du har merket som på lager.</li>
              <li>Du får en e-post med emnet «Ny henteordre» til adressen under «Bestillinger sendes til».</li>
              <li>I e-posten bekrefter eller avslår du bestillingen med ett klikk. Du trenger ikke logge inn.</li>
              <li>Kunden henter varene hos deg og betaler når varene hentes. Rett fra Bonden tar ikke betalt.</li>
              ${capLine}
            </ul>
            <h3>Dette må du gjøre</h3>
            <ul>
              <li>Svar på hver bestilling: bekreft eller avslå.</li>
              <li>Svarer du ikke, får du en påminnelse etter ${esc(t.reminderHours)} timer.</li>
              <li>Er bestillingen fortsatt ubesvart etter ${esc(t.autocancelHours)} timer, blir den kansellert, og kunden får beskjed.</li>
              <li>Hold varene oppdatert, så kunden bare kan bestille det du har.</li>
            </ul>
            <h3>Slik slår du av</h3>
            <ul>
              <li>Trykk «Slå av» på denne raden. Da får kunden kontaktinformasjonen din i stedet.</li>
              <li>Bestillinger du allerede har fått, må du fortsatt svare på.</li>
            </ul>
            ${readMore}
          </details>`;
}

function rowHtml(ctx: RenderCtx, e: OwnerFeatureEntry, r: ResolvedOwnerFeature, swap: string): string {
  const badges =
    (isNew(e, ctx.now) ? ` <span class="mv-badge mv-badge-new">Nytt</span>` : "") +
    (e.consent ? ` <span class="mv-badge">Samtykke</span>` : "");
  const reason = r.reason && e.type !== "guarantee" && r.block !== "confirm_by_email"
    ? `<p class="mv-reason">${esc(r.reason.no)}</p>` : "";
  let explain = "";
  if (e.type === "guarantee" && !ctx.explainedAlways) {
    ctx.explainedAlways = true;
    explain = `<p class="mv-explain">«Alltid» betyr et løfte fra ${esc(platformName(ctx.m))}. Det gjelder hele tiden og kan ikke slås av.</p>`;
  } else if (e.type === "locked" && r.value === true && !ctx.explainedLocked) {
    ctx.explainedLocked = true;
    explain = `<p class="mv-explain">«Låst på» betyr at dette hører til noe du har slått på. Det følger det valget og kan ikke slås av alene.</p>`;
  }
  return `<li class="mv-item" id="valg-${esc(e.key)}" data-key="${esc(e.key)}">
          <div class="mv-item-text"><strong>${esc(e.label.no)}</strong>${badges}<p class="mv-desc">${esc(e.description.no)}</p>${reason}${explain}${rowExtraHtml(ctx, e, r)}</div>
          <div class="mv-item-ctl">${controlHtml(ctx, e, r, swap)}</div>
        </li>`;
}

/** The built entries of one group, split as the page shows them. */
function groupEntries(m: OwnerPageModel, registry: OwnerFeatureEntry[], group: string) {
  const reveal = findOwnerFeature(m.variant ? m.variant.revealKey : OWNER_PAGE_REVEAL_KEY, registry);
  const revealOn = !!reveal && m.resolved.byKey[reveal.key]?.value === true;
  const entries = registry.filter((e) => e.group === group && isOwnerFeatureBuilt(e) && m.resolved.byKey[e.key]);
  const hidden = entries.filter((e) => !!reveal && !revealOn && e.requires.includes(reveal.key as any));
  const shown = entries.filter((e) => !hidden.includes(e));
  return { reveal, shown, hidden };
}

function groupsHtml(ctx: RenderCtx, registry: OwnerFeatureEntry[]): string {
  const m = ctx.m;
  return pageGroups(m).map((g) => {
    const { reveal, shown, hidden } = groupEntries(m, registry, g.key);
    if (shown.length === 0 && hidden.length === 0) return "";
    const swap = `gruppe-${g.key}`;
    const basic = shown.filter((e) => !e.advanced).map((e) => rowHtml(ctx, e, m.resolved.byKey[e.key], swap)).join("");
    const adv = shown.filter((e) => e.advanced).map((e) => rowHtml(ctx, e, m.resolved.byKey[e.key], swap)).join("");
    const hiddenNote = hidden.length && reveal
      ? `<p class="mv-note">${hidden.length} valg til vises når du slår på «${esc(reveal.label.no)}».</p>`
      : "";
    return `<section class="ep-card mv-group" id="${esc(swap)}" data-group="${esc(g.key)}" aria-labelledby="mv-h-${esc(g.key)}">
        <details class="mv-fold" open>
          <summary class="mv-fold-summary"><h2 id="mv-h-${esc(g.key)}">${esc(g.label.no)}</h2></summary>
          ${basic ? `<ul class="mv-list">${basic}</ul>` : ""}
          ${adv ? `<details class="mv-more"><summary>Flere valg</summary><ul class="mv-list">${adv}</ul></details>` : ""}
          ${hiddenNote}
        </details>
      </section>`;
  }).join("\n");
}

/** v2 principle 2: every planned entry, closed by default, «Gi meg beskjed» per row, no value. */
function plannedHtml(m: OwnerPageModel, registry: OwnerFeatureEntry[]): string {
  const planned = registry.filter((e) => !isOwnerFeatureBuilt(e) && m.resolved.byKey[e.key]);
  if (planned.length === 0) return "";
  const groupLabel = new Map(pageGroups(m).map((g) => [g.key as string, g.label.no] as const));
  const interest = m.interest ?? new Set<string>();
  const rows = planned.map((e) => {
    const asked = interest.has(e.key);
    const ctl = asked
      ? `<span class="mv-state mv-asked">Du har sagt fra</span>`
      : rowForm(m, "/interesse", "planlagt",
          `<input type="hidden" name="key" value="${esc(e.key)}"><button type="submit" class="ep-btn ep-btn-secondary">Gi meg beskjed</button>`);
    return `<li class="mv-item mv-item-planned" id="planlagt-${esc(e.key)}" data-planned-key="${esc(e.key)}">
          <div class="mv-item-text"><strong>${esc(e.label.no)}</strong> <span class="mv-badge">${esc(groupLabel.get(e.group) ?? "")}</span><p class="mv-desc">${esc(e.description.no)}</p></div>
          <div class="mv-item-ctl">${ctl}</div>
        </li>`;
  }).join("");
  return `<details class="ep-card mv-planned" id="planlagt">
        <summary class="mv-fold-summary"><h2 id="mv-h-planlagt">${esc(OWNER_PAGE_PLANNED_TITLE)} (${planned.length})</h2></summary>
        <p class="mv-desc">Dette er ikke bygget ennå. Trykk «Gi meg beskjed» på det du vil ha. Vi lagrer bare at du har sagt fra: ingenting på profilen endres, og vi sender ingen e-post nå.</p>
        <ul class="mv-list">${rows}</ul>
      </details>`;
}

function levelsHtml(m: OwnerPageModel): string {
  const cards = (m.variant ? m.variant.levels : OWNER_LEVELS).map((l) => {
    const current = m.level === l.key;
    return `<li class="mv-level"${current ? ` aria-current="true"` : ""} data-level="${esc(l.key)}">
          <strong>${esc(l.label.no)}</strong>${l.recommended ? ` <span class="mv-badge mv-badge-new">Anbefalt</span>` : ""}${l.key === "bare_synlig" ? ` <span class="mv-badge">Standard</span>` : ""}
          <p class="mv-desc">${esc(l.description.no)}</p>
          ${current
            ? `<span class="mv-state">Valgt</span>`
            : `<form method="get" action="${esc(actionPath(m, ""))}" class="mv-ctl-form"><input type="hidden" name="niva" value="${esc(l.key)}"><button type="submit" class="ep-btn ep-btn-secondary">Velg «${esc(l.label.no)}»</button></form>`}
        </li>`;
  }).join("");
  const note = m.level === "custom"
    ? `<p class="mv-note">Nå: <strong>${esc(OWNER_LEVEL_CUSTOM_LABEL.no)}</strong> — du har endret noe etter at du valgte nivå.</p>`
    : m.level === null
      ? `<p class="mv-note">Du har ikke valgt nivå ennå. Valgene dine står under.</p>`
      : "";
  return `<section class="ep-card" id="niva" aria-labelledby="mv-h-niva">
        <h2 id="mv-h-niva">Hvor aktiv vil du være?</h2>
        ${note}
        <ul class="mv-levels">${cards}</ul>
        ${statusLineHtml(m)}
      </section>`;
}

function statusLineHtml(m: OwnerPageModel): string {
  const registry = m.registry ?? OWNER_FEATURE_REGISTRY;
  const items = (m.variant ? m.variant.statusKeys : OWNER_PAGE_STATUS_KEYS).map((k) => {
    const e = findOwnerFeature(k, registry);
    const r = m.resolved.byKey[k];
    const v = e ? ownerFeatureRowValue(e, r) : null;
    if (!e || v === null) return "";
    return `<li data-status-key="${esc(k)}"><span>${esc(e.label.no)}:</span> <strong>${esc(v)}</strong></li>`;
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
  const cancel = `<a class="ep-btn ep-btn-secondary" href="${esc(actionPath(m, "#niva"))}">Avbryt</a>`;
  const confirmForm = `<form method="post" action="${esc(actionPath(m, "/niva"))}" class="mv-ctl-form">
            <input type="hidden" name="level" value="${esc(p.level.key)}">
            <input type="hidden" name="confirmed" value="1">
            <button type="submit" class="ep-btn ep-btn-primary">Bekreft «${esc(p.level.label.no)}»</button>
          </form>`;
  const body = p.changes.length
    ? `<p>Dette endres:</p><ul>${changes}</ul>${skipped ? `<ul>${skipped}</ul>` : ""}
        <div class="ep-form-actions">
          ${confirmForm}
          ${cancel}
        </div>`
    : `<p>Valgene dine er allerede slik. Bekreft for å velge nivået.</p>${skipped ? `<ul>${skipped}</ul>` : ""}
        <div class="ep-form-actions">${skipped ? "" : confirmForm}${cancel}</div>`;
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
  // The pause keeps the optional resume date the /eier pause card had.
  const until = e.key === OWNER_PAGE_PAUSE_KEY && !c.value && (!m.variant || m.variant.pauseResumeDate)
    ? `<div class="ep-field"><label for="mv-pause-until">Kommer tilbake (valgfritt)</label><input id="mv-pause-until" name="until" type="date" aria-label="Dato profilen kommer tilbake"></div>`
    : "";
  return `<section class="ep-card mv-confirm" id="bekreft" role="region" aria-labelledby="mv-h-bekreft">
        <h2 id="mv-h-bekreft">${esc(c.value ? "Slå på" : "Slå av")} «${esc(e.label.no)}»?</h2>
        <p>${esc(text.no)}</p>
        <form method="post" action="${esc(actionPath(m, "/sett"))}" class="mv-confirm-form">
          <input type="hidden" name="key" value="${esc(e.key)}">
          <input type="hidden" name="value" value="${c.value ? "true" : "false"}">
          <input type="hidden" name="confirmed" value="1">
          ${until}
          <div class="ep-form-actions">
            <button type="submit" class="ep-btn ep-btn-primary">Ja, ${esc(c.value ? "slå på" : "slå av")}</button>
            <a class="ep-btn ep-btn-secondary" href="${esc(actionPath(m, `#valg-${e.key}`))}">Avbryt</a>
          </div>
        </form>
      </section>`;
}

function introHtml(m: OwnerPageModel): string {
  if (!m.showIntro) return "";
  const form = (answer: "yes" | "no", label: string, cls: string) =>
    `<form method="post" action="${esc(actionPath(m, "/intro"))}" class="mv-ctl-form"><input type="hidden" name="answer" value="${answer}"><button type="submit" class="ep-btn ${cls}">${label}</button></form>`;
  return `<section class="ep-card mv-intro" id="velkommen" aria-labelledby="mv-h-intro">
        <h2 id="mv-h-intro">Nyheter og tips</h2>
        <p>Vil du ha nyheter og tips fra Rett fra Bonden på e-post? Det er frivillig. Svaret ditt blir valget «Nyheter og tips» under «Kontakt fra Rett fra Bonden», og der kan du endre det når som helst.</p>
        <div class="ep-form-actions">${form("yes", "Ja takk", "ep-btn-primary")}${form("no", "Nei takk", "ep-btn-secondary")}</div>
      </section>`;
}

function logHtml(m: OwnerPageModel): string {
  const registry = m.registry ?? OWNER_FEATURE_REGISTRY;
  const items = m.log.rows.map((r) => {
    const e = findOwnerFeature(r.key, registry);
    const label = e ? e.label.no : r.key;
    const who = r.actor === "admin" ? platformName(m) : (ACTOR_LABELS[r.actor] ?? "Systemet");
    return `<li class="ep-audit-item"><strong>${esc(label)}</strong>: ${esc(formatOwnerFeatureValue(e, r.old_value))} → ${esc(formatOwnerFeatureValue(e, r.new_value))}${r.undo ? ` <span class="mv-badge">Angret</span>` : ""}
          <div class="ep-audit-meta">${esc(formatWhen(r.at))} · ${esc(who)}</div></li>`;
  }).join("");
  const nav: string[] = [];
  if (m.log.page > 1) nav.push(`<a class="ep-btn ep-btn-secondary" href="${esc(actionPath(m, `?side=${m.log.page - 1}#endringslogg`))}">Nyere</a>`);
  if (m.log.page < m.log.pages) nav.push(`<a class="ep-btn ep-btn-secondary" href="${esc(actionPath(m, `?side=${m.log.page + 1}#endringslogg`))}">Eldre</a>`);
  return `<section class="ep-card" id="endringslogg" aria-labelledby="mv-h-logg">
        <details class="mv-fold" open>
          <summary class="mv-fold-summary"><h2 id="mv-h-logg">Endringslogg</h2></summary>
          <p class="mv-desc">Hva som er endret, når og av hvem. Nyeste først.</p>
          ${items ? `<ul class="ep-audit-list">${items}</ul>` : `<p class="mv-desc">Ingen endringer ennå.</p>`}
          ${nav.length ? `<div class="ep-form-actions mv-pager">${nav.join("")}<span class="mv-desc">Side ${m.log.page} av ${m.log.pages}</span></div>` : ""}
        </details>
      </section>`;
}

function noticeHtml(m: OwnerPageModel): string {
  const n = m.notice;
  if (!n) return "";
  const undo = n.undoBatchId
    ? `<form method="post" action="${esc(actionPath(m, "/angre"))}" class="mv-ctl-form"><input type="hidden" name="batch" value="${esc(n.undoBatchId)}"><button type="submit" class="ep-btn ep-btn-secondary">Angre</button></form>`
    : "";
  return `<div class="mv-toast ${n.ok ? "mv-toast-ok" : "mv-toast-error"}" role="${n.ok ? "status" : "alert"}"><span>${esc(n.text)}</span>${undo}</div>`;
}

const nbNum = (n: number) => n.toLocaleString("nb-NO");

/**
 * Gårdssalg (O1 principle 1, proof first): the portal's own Statistikk
 * numbers (getGardssalgOwnerStats — the same source as GET
 * /api/opplevelser/gardssalg-claim/:id/stats, no new counting), each with the
 * period its source covers. Low numbers get one sentence and one tip.
 */
function gardssalgStatsHtml(m: OwnerPageModel): string {
  const st = m.gardssalgStats;
  if (st === undefined) return "";
  const link = m.statsHref ? `<div class="ep-form-actions"><a class="ep-btn ep-btn-secondary" href="${esc(m.statsHref)}">Se all statistikk</a></div>` : "";
  if (st === null) {
    return `<section class="ep-card" id="statistikk" aria-labelledby="statistikk-h"><h2 id="statistikk-h">Dette har profilen gjort for deg</h2>
      <p class="mv-note">Statistikken kunne ikke lastes akkurat nå. Prøv igjen senere.</p>${link}</section>`;
  }
  const tile = (value: number, label: string, period: string) =>
    `<li class="mv-stat"><strong>${esc(nbNum(value))}</strong><span>${esc(label)}</span><small>${esc(period)}</small></li>`;
  const low = st.humanViews < OWNER_PAGE_LOW_VIEWS_FALLBACK;
  return `<section class="ep-card" id="statistikk" aria-labelledby="statistikk-h">
      <h2 id="statistikk-h">Dette har profilen gjort for deg</h2>
      <ul class="mv-stats">
        ${tile(st.humanViews, "Personer som så profilen", `siste ${st.windowDays} dager`)}
        ${tile(st.aiSearchViews, "Funnet via AI-assistenter", `siste ${st.windowDays} dager`)}
        ${st.aiDeliveries ? tile(st.aiDeliveries.value, "Med i AI-søk", st.aiDeliveries.label) : ""}
      </ul>
      ${low ? `<p class="mv-note">Tallene er lave ennå, og det er vanlig for en profil som er ny eller lite kjent.</p>
      <p class="mv-check">Tips: ${esc(st.tip)}</p>` : ""}
      ${link}
    </section>`;
}

/** S2f: the statistics block (v2 principle 1: proof first). */
function statsHtml(m: OwnerPageModel): string {
  if (m.gardssalgStats !== undefined) return gardssalgStatsHtml(m);
  if (m.stats === undefined) return "";
  const link = m.statsHref ? `<div class="ep-form-actions"><a class="ep-btn ep-btn-secondary" href="${esc(m.statsHref)}">Se all statistikk</a></div>` : "";
  const st = m.stats;
  if (st === null) {
    return `<section class="ep-card" id="statistikk" aria-labelledby="statistikk-h"><h2 id="statistikk-h">Dette har profilen gjort for deg</h2>
      <p class="mv-note">Statistikken kunne ikke lastes akkurat nå. Prøv igjen senere.</p>${link}</section>`;
  }
  const tile = (value: number, label: string, period: string, extra = "") =>
    `<li class="mv-stat"><strong>${esc(nbNum(value))}</strong><span>${esc(label)}</span><small>${esc(period)}</small>${extra}</li>`;
  const split = `<small>${esc(`ChatGPT ${nbNum(st.aiSplit.chatgpt)} · Claude ${nbNum(st.aiSplit.claude)} · Andre ${nbNum(st.aiSplit.other)} (siste ${st.aiSplit.days} dager)`)}</small>`;
  const low = ownerStatsAreLow(st);
  const lowHtml = !low ? "" : st.minPublicViews > 0
    ? `<p class="mv-note">Tallene er lave ennå, og de vises ikke offentlig på profilen før den har ${esc(st.minPublicViews)} sidevisninger fra mennesker siste 12 måneder (her ser du dem alltid).</p>
      <p class="mv-check">Tips: ${esc(st.tip)}</p>`
    : `<p class="mv-note">Tallene er lave ennå, og det er vanlig for en profil som er ny eller lite kjent.</p>
      <p class="mv-check">Tips: ${esc(st.tip)}</p>`;
  return `<section class="ep-card" id="statistikk" aria-labelledby="statistikk-h">
      <h2 id="statistikk-h">Dette har profilen gjort for deg</h2>
      <ul class="mv-stats">
        ${tile(st.humanViews.value, "Sidevisninger fra mennesker", st.humanViews.label)}
        ${tile(st.aiViews.value, "AI-søk", st.aiViews.label, split)}
        ${tile(st.aiDeliveries.value, "Med i AI-søk", st.aiDeliveries.label)}
        ${tile(st.clicks.phone, "Klikk til telefon", `siste ${st.clicks.days} dager`)}
        ${tile(st.clicks.website, "Klikk til nettside", `siste ${st.clicks.days} dager`)}
      </ul>
      <p class="mv-note">Klikk til kart telles ikke ennå.</p>
      ${lowHtml}
      ${link}
    </section>`;
}

/** v2 principle 9: jump links (shown on narrow screens). */
function jumpNavHtml(m: OwnerPageModel, registry: OwnerFeatureEntry[]): string {
  const hasStats = m.stats !== undefined || m.gardssalgStats !== undefined;
  const links: Array<[string, string]> = hasStats ? [["statistikk", "Statistikk"], ["niva", "Nivå"]] : [["niva", "Nivå"]];
  for (const g of pageGroups(m)) {
    const { shown, hidden } = groupEntries(m, registry, g.key);
    if (shown.length || hidden.length) links.push([`gruppe-${g.key}`, g.label.no]);
  }
  if (registry.some((e) => !isOwnerFeatureBuilt(e) && m.resolved.byKey[e.key])) links.push(["planlagt", "Planlagt"]);
  links.push(["endringslogg", "Endringslogg"]);
  return `<nav class="mv-jump" aria-label="Hopp til">${links.map(([id, label]) => `<a href="#${esc(id)}">${esc(label)}</a>`).join("")}</nav>`;
}

/**
 * v2 principle 9: a save updates only its card. Progressive enhancement over
 * the plain forms (which keep working without JavaScript): a form marked
 * data-mv-row is POSTed with fetch, the 303 is followed, and the named card,
 * the levels card, the message and the change log are swapped in from the
 * returned page. A confirm panel, an error or anything unexpected → the
 * normal page load.
 */
export const OWNER_PAGE_SCRIPT = `
(function () {
  if (!window.fetch || !window.DOMParser || !window.FormData || !window.URLSearchParams) return;
  var page = document.querySelector(".mv-page");
  if (!page) return;
  function swap(doc, id) {
    var cur = document.getElementById(id), next = doc.getElementById(id);
    if (!cur || !next) return;
    if (cur.tagName === "DETAILS" && cur.open) next.setAttribute("open", "");
    var curFold = cur.querySelector("details.mv-fold"), nextFold = next.querySelector("details.mv-fold");
    if (curFold && nextFold && !curFold.open) nextFold.removeAttribute("open");
    cur.parentNode.replaceChild(document.importNode(next, true), cur);
  }
  page.addEventListener("submit", function (ev) {
    var f = ev.target;
    if (!f || f.tagName !== "FORM" || !f.getAttribute("data-mv-row") || String(f.method).toLowerCase() !== "post") return;
    ev.preventDefault();
    var btn = f.querySelector("button[type=submit]");
    if (btn) btn.disabled = true;
    fetch(f.action, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(new FormData(f)).toString()
    }).then(function (r) {
      return r.text().then(function (t) { return { ok: r.ok, url: r.url, html: t }; });
    }).then(function (out) {
      var doc = new DOMParser().parseFromString(out.html, "text/html");
      if (!out.ok || !doc.querySelector(".mv-page") || doc.getElementById("bekreft")) {
        window.location.href = out.url || f.action;
        return;
      }
      [f.getAttribute("data-mv-row"), "niva", "mv-toast-slot", "endringslogg"].forEach(function (id) { swap(doc, id); });
    }).catch(function () { f.submit(); });
  });
})();
`;

/** Page-only CSS on top of PORTAL_PALETTE_CSS: layout, ≥ 44 px targets, dark mode. */
export const OWNER_PAGE_CSS = `
  :root { color-scheme: light dark; }
  .mv-page, .mv-page * { overflow-wrap: anywhere; }
  .mv-page { max-width: 100%; }
  .mv-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .mv-desc { margin: 4px 0 0; font-size: 0.88rem; color: #595959; }
  .mv-reason { margin: 4px 0 0; font-size: 0.85rem; color: #92400e; }
  .mv-explain { margin: 4px 0 0; font-size: 0.85rem; color: #404040; font-style: italic; }
  .mv-note { font-size: 0.88rem; color: #595959; margin: 12px 0 0; }
  .mv-check { margin: 8px 0 0; font-size: 0.9rem; font-weight: 600; color: #2D5016; }
  .mv-check-missing { color: #92400e; }
  .mv-list { list-style: none; margin: 0; padding: 0; }
  .mv-item { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; padding: 12px 0; border-bottom: 1px solid #f0f0e8; }
  .mv-item:last-child { border-bottom: none; }
  .mv-item-text { flex: 1 1 220px; min-width: 0; }
  .mv-item-ctl { flex: 0 1 auto; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; max-width: 100%; }
  .mv-ctl-form, .mv-confirm-form { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; max-width: 100%; }
  .mv-confirm-form { flex-direction: column; align-items: stretch; }
  .mv-ctl-form select, .mv-ctl-form input:not([type=hidden]), .mv-confirm-form input:not([type=hidden]) { min-height: 44px; max-width: 100%; padding: 8px 10px; font-size: 1rem; font-family: inherit; border: 1px solid #d4d4d4; border-radius: 8px; background: #fff; color: #1a1a1a; }
  .mv-state { display: inline-flex; align-items: center; min-height: 44px; font-weight: 600; }
  .mv-always { color: #2D5016; }
  .mv-asked { color: #2D5016; }
  .mv-badge { display: inline-block; font-size: 0.72rem; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: #f0f0e8; color: #404040; vertical-align: middle; }
  .mv-badge-new { background: #e7f2dc; color: #2D5016; }
  .mv-levels { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: 1fr; gap: 12px; }
  .mv-level { border: 1px solid #e5e5e5; border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 6px; }
  .mv-level[aria-current="true"] { border-color: #2D5016; box-shadow: inset 0 0 0 1px #2D5016; }
  @media (min-width: 640px) { .mv-levels { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .mv-status { margin-top: 16px; }
  .mv-status h3 { font-size: 0.95rem; margin: 0 0 6px; }
  .mv-status ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 0.88rem; }
  .mv-fold-summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; list-style: none; }
  .mv-fold-summary::-webkit-details-marker { display: none; }
  .mv-fold-summary h2 { margin: 0; flex: 1 1 auto; }
  .mv-fold-summary::after { content: "▾"; margin-left: 8px; color: #2D5016; }
  details:not([open]) > .mv-fold-summary::after { content: "▸"; }
  .mv-more summary, .mv-explain-box summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; font-weight: 600; color: #2D5016; }
  .mv-explain-box { margin-top: 8px; font-size: 0.9rem; }
  .mv-explain-box h3 { font-size: 0.92rem; margin: 10px 0 4px; }
  .mv-explain-box ul { margin: 0; padding-left: 18px; }
  .mv-jump { display: flex; flex-wrap: wrap; gap: 4px 8px; margin-top: 12px; }
  .mv-jump a { display: inline-flex; align-items: center; min-height: 44px; padding: 0 10px; border: 1px solid #e5e5e5; border-radius: 999px; font-size: 0.88rem; text-decoration: none; }
  @media (min-width: 900px) { .mv-jump { display: none; } }
  .mv-confirm { border-color: #2D5016; }
  .mv-toast { position: sticky; bottom: 0; z-index: 10; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; margin-top: 16px; padding: 10px 14px; border-radius: 10px; font-size: 0.95rem; box-shadow: 0 -2px 8px rgba(0,0,0,0.08); }
  .mv-toast-ok { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }
  .mv-toast-error { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
  .mv-pager { align-items: center; }
  .mv-stats { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  @media (min-width: 640px) { .mv-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  .mv-stat { border: 1px solid #e5e5e5; border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .mv-stat strong { font-size: 1.4rem; color: #2D5016; }
  .mv-stat span { font-size: 0.88rem; font-weight: 600; }
  .mv-stat small { font-size: 0.78rem; color: #595959; }
  @media (prefers-color-scheme: dark) {
    body { background: #12150e; color: #ebe8dc; }
    a, .ep-logo { color: #b9d99a; }
    .ep-logo span { color: #e2bf97; }
    .ep-card { background: #1c2116; border-color: #313b27; box-shadow: none; }
    .ep-card h1, .ep-card h2, .mv-always, .mv-asked, .mv-more summary, .mv-explain-box summary, .mv-check { color: #b9d99a; }
    .mv-fold-summary::after { color: #b9d99a; }
    .ep-card h2, .mv-item, .ep-audit-item { border-color: #313b27; }
    .ep-btn-primary { background: #4c7d2c; color: #fff; }
    .ep-btn-primary:hover, .ep-btn-primary:focus { background: #5a9134; }
    .ep-btn-secondary { background: transparent; color: #cfe6b8; border-color: #8fb86e; }
    .ep-btn-secondary:hover { background: #26301d; }
    .ep-btn-ghost { color: #b5b0a0; }
    .mv-desc, .mv-note, .ep-audit-meta, .mv-explain { color: #b5b0a0; }
    .mv-reason, .mv-check-missing { color: #f5c27a; }
    .mv-badge { background: #2a3022; color: #d8d4c4; }
    .mv-badge-new { background: #2f4a1c; color: #cfe6b8; }
    .mv-level, .mv-jump a, .mv-stat { border-color: #313b27; }
    .mv-stat strong { color: #b9d99a; }
    .mv-stat small { color: #b5b0a0; }
    .mv-level[aria-current="true"] { border-color: #8fb86e; box-shadow: inset 0 0 0 1px #8fb86e; }
    .mv-ctl-form select, .mv-ctl-form input:not([type=hidden]), .mv-confirm-form input:not([type=hidden]) { background: #12150e; color: #ebe8dc; border-color: #4a5640; }
    .mv-toast-ok { background: #15301d; color: #bbf7d0; border-color: #24543a; }
    .mv-toast-error { background: #3a1616; color: #fecaca; border-color: #6b2525; }
  }
`;

/** The page body (inside portalShell). */
export function renderOwnerFeaturesPageBody(m: OwnerPageModel): string {
  const registry = m.registry ?? OWNER_FEATURE_REGISTRY;
  const ctx: RenderCtx = { m, now: m.now ?? new Date(), explainedAlways: false, explainedLocked: false };
  const back = m.variant ? m.variant.backHref : `/eier/${encodeURIComponent(m.agent.id)}/portal`;
  return `<style>${OWNER_PAGE_CSS}</style>
    <div class="mv-page">
      <div class="ep-card">
        <h1>Mine valg</h1>
        <p><strong>${esc(m.agent.name)}</strong>. Endringer lagres med en gang, og du kan angre den siste.</p>
        <div class="ep-form-actions"><a class="ep-btn ep-btn-secondary" href="${esc(back)}">Tilbake til eierportalen</a></div>
        ${jumpNavHtml(m, registry)}
      </div>
      ${statsHtml(m)}
      ${introHtml(m)}
      ${confirmHtml(m)}
      ${levelPreviewHtml(m)}
      ${levelsHtml(m)}
      ${groupsHtml(ctx, registry)}
      ${plannedHtml(m, registry)}
      ${logHtml(m)}
      <div id="mv-toast-slot">${noticeHtml(m)}</div>
    </div>
    <script>${OWNER_PAGE_SCRIPT}</script>`;
}
