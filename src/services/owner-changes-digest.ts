// ─── Daily «something changed on your profile» owner e-mail: TEMPLATE only ──
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, S5-6. The owner-feature
// registry entry `notify.changes` (surface email:owner_changes, default on)
// promises «En samlet e-post per dag når noe på profilen er endret av andre
// enn deg». This module only RENDERS that e-mail for one producer and one
// Oslo calendar day. Nothing here sends, schedules or writes: Daniel approves
// the first edition via the admin preview (routes/admin-owner-changes-preview.ts)
// before any send job or flag is built. There is no "sent" state here.
//
// Content: exactly the owner's «Endringslogg» (routes/owner-audit-log.ts) —
// the same fail-closed field table (OWNER_AUDIT_FIELDS), the same value
// formatting, the same «who» (ownerAuditWho: «Rett fra Bonden» /
// «Automatisk fra nettsiden din»), no notes, no e-mail values, no no-op
// rows — minus every row the owner made (changed_by = 'owner'). A day with
// no such row has no digest (null: nothing to send).
//
// Day: one calendar day in Europe/Oslo (default: yesterday), as the UTC
// half-open range [Oslo midnight, next Oslo midnight), DST-aware.
//
// Unsubscribe: a stateless signed token with its OWN purpose string
// (owner-changes-unsub-v1, tag cu1), so a report, milestone, /avmeld or
// preview token never validates as one and vice versa. The route
// `/endring-avmeld/:token` (routes/rapport-avmeld.ts) confirms on GET and on
// POST / RFC 8058 one-click sets notify.changes = false (registry
// `recipientOptOut`, also while the entry is coming_soon).

import type Database from "better-sqlite3";
import { customerRuleSql } from "./customer-rule";
import {
  esc,
  headerSafe,
  makeOwnerAgentToken,
  ownerEmailPublicBase,
  ownerMineValgUrlFor,
  verifyOwnerAgentToken,
} from "./owner-monthly-report";
import {
  OWNER_AUDIT_FIELD_NAMES,
  ownerAuditFeedRows,
  type OwnerAuditDbRow,
  type OwnerAuditFeedRow,
} from "../routes/owner-audit-log";
import { getOwnerFeature, ownerFeatureRegistryFor, ownerFeatureStatus, type OwnerFeatureEntry, type OwnerFeatureStatus } from "../owner-features/registry";
import { featureValue, setOwnerFeatureValue, type SetOwnerFeatureResult } from "../owner-features/resolve";

type Db = Database.Database;

export const OWNER_CHANGES_UNSUB_PURPOSE = "owner-changes-unsub-v1";
const OWNER_CHANGES_UNSUB_TAG = "cu1";
export const OWNER_CHANGES_UNSUB_PATH = "/endring-avmeld/";
/** The value the digest's unsubscribe link sets (registry notify.changes.recipientOptOut). */
export const OWNER_CHANGES_OFF_VALUE = false;
/** Most changes listed one by one; the rest are counted («… og N endringer til»). */
export const OWNER_CHANGES_LIST_MAX = 25;
/** Most stored rows one digest reads (bounds the query). */
export const OWNER_CHANGES_SCAN_MAX = 500;

const TZ = "Europe/Oslo";
const MIN_YEAR = 2024;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS_NB = [
  "januar", "februar", "mars", "april", "mai", "juni",
  "juli", "august", "september", "oktober", "november", "desember",
];
const CONTACT = "kontakt@rettfrabonden.com";

// ── Day helpers (Europe/Oslo) ───────────────────────────────────────────────
export interface OsloDay {
  /** 'YYYY-MM-DD' (the Oslo calendar day). */
  day: string;
  /** ISO 8601 UTC of Oslo midnight starting the day (inclusive). */
  fromUtc: string;
  /** ISO 8601 UTC of the next Oslo midnight (exclusive). */
  toUtc: string;
  /** «23. november 2026». */
  label: string;
}

/** The Oslo calendar day of an instant, 'YYYY-MM-DD'. */
export function osloDayOf(nowMs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(nowMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Oslo's offset from UTC at an instant, in ms (+1 h or +2 h). */
function osloOffsetMs(ms: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant of Oslo midnight starting 'YYYY-MM-DD'. */
function osloMidnightMs(day: string): number {
  const [y, m, d] = day.split("-").map((s) => parseInt(s, 10));
  const wall = Date.UTC(y, m - 1, d);
  let t = wall - osloOffsetMs(wall);
  // Re-check at the found instant (DST never switches at midnight in Oslo, but stay exact).
  t = wall - osloOffsetMs(t);
  return t;
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function osloDay(day: string): OsloDay {
  const [y, m, d] = day.split("-").map((s) => parseInt(s, 10));
  return {
    day,
    fromUtc: new Date(osloMidnightMs(day)).toISOString(),
    toUtc: new Date(osloMidnightMs(addDays(day, 1))).toISOString(),
    label: `${d}. ${MONTHS_NB[m - 1]} ${y}`,
  };
}

/** Default digest day: yesterday in Europe/Oslo. */
export function defaultDigestDay(nowMs: number = Date.now()): string {
  return addDays(osloDayOf(nowMs), -1);
}

/**
 * 'YYYY-MM-DD' → the Oslo day, or null when malformed, not a calendar date,
 * before MIN_YEAR or after today in Oslo (today is allowed; it is partial).
 */
export function parseDigestDay(raw: unknown, nowMs: number = Date.now()): OsloDay | null {
  if (typeof raw !== "string") return null;
  const m = DAY_RE.exec(raw);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  if (y < MIN_YEAR || mo < 1 || mo > 12 || d < 1) return null;
  if (d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  if (raw > osloDayOf(nowMs)) return null;
  return osloDay(raw);
}

// ── Unsubscribe token (own purpose) ─────────────────────────────────────────
export function makeOwnerChangesUnsubToken(agentId: string): string | null {
  return makeOwnerAgentToken(OWNER_CHANGES_UNSUB_PURPOSE, OWNER_CHANGES_UNSUB_TAG, agentId);
}

export function verifyOwnerChangesUnsubToken(token: string): string | null {
  return verifyOwnerAgentToken(OWNER_CHANGES_UNSUB_PURPOSE, OWNER_CHANGES_UNSUB_TAG, token);
}

export function ownerChangesUnsubscribeUrl(agentId: string): string | null {
  const token = makeOwnerChangesUnsubToken(agentId);
  return token ? `${ownerEmailPublicBase()}${OWNER_CHANGES_UNSUB_PATH}${token}` : null;
}

export function ownerMineValgChangesUrl(agentId: string): string {
  return ownerMineValgUrlFor(agentId, "notify.changes");
}

/**
 * A recipient's unsubscribe — sets the RFB owner feature notify.changes to
 * false (one owner_feature_audit row when it changed, actor system, detail
 * «endring-avmeld»). Idempotent. Only ever writes false.
 */
export function recordOwnerChangesUnsubscribe(db: Db, agentId: string): SetOwnerFeatureResult {
  return setOwnerFeatureValue(
    "rfb",
    agentId,
    "notify.changes",
    OWNER_CHANGES_OFF_VALUE,
    { actor: "system", detail: "endring-avmeld" },
    { db, recipientOptOut: true },
  );
}

// ── Changes ─────────────────────────────────────────────────────────────────
/**
 * The day's changes made by someone other than the owner, oldest first, as
 * the owner's change log shows them (owner-audit-log.ts ownerAuditFeedRows:
 * allowlisted fields only, no-op rows dropped, no notes, e-mail values
 * hidden). Reads at most OWNER_CHANGES_SCAN_MAX stored rows.
 */
export function readOwnerChangesForDay(db: Db, agentId: string, day: OsloDay): OwnerAuditFeedRow[] {
  const names = OWNER_AUDIT_FIELD_NAMES;
  const rows = db.prepare(
    `SELECT id, field_name, old_value, new_value, changed_by, changed_at, notes
       FROM agent_knowledge_audit
      WHERE agent_id = ?
        AND changed_by <> 'owner'
        AND field_name IN (${names.map(() => "?").join(", ")})
        AND TRIM(IFNULL(old_value, '')) <> TRIM(IFNULL(new_value, ''))
        AND julianday(changed_at) >= julianday(?)
        AND julianday(changed_at) < julianday(?)
      ORDER BY julianday(changed_at) ASC, rowid ASC
      LIMIT ?`,
  ).all(agentId, ...names, day.fromUtc, day.toUtc, OWNER_CHANGES_SCAN_MAX) as OwnerAuditDbRow[];
  return ownerAuditFeedRows(rows);
}

const OSLO_TIME = new Intl.DateTimeFormat("nb-NO", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });

/** One change as the owner reads it: «Telefon: 1 → 2» or «E-post endret». */
export function ownerChangeLine(c: OwnerAuditFeedRow): string {
  return c.values_hidden ? `${c.label} endret` : `${c.label}: ${c.old_value} → ${c.new_value}`;
}

/** «kl. 10:15 · Rett fra Bonden». */
export function ownerChangeMeta(c: OwnerAuditFeedRow): string {
  const t = c.changed_at ? Date.parse(c.changed_at) : NaN;
  return Number.isNaN(t) ? c.who : `kl. ${OSLO_TIME.format(new Date(t))} · ${c.who}`;
}

// ── Render ──────────────────────────────────────────────────────────────────
export interface OwnerChangesEmail {
  subject: string;
  text: string;
  html: string;
}

export interface OwnerChangesEmailInput {
  producerName: string;
  dayLabel: string;
  changes: readonly OwnerAuditFeedRow[];
  mineValgUrl: string;
  /** null when no signing secret is configured (no one-click link). */
  unsubscribeUrl: string | null;
}

/** Pure: the digest for one day. null when there is nothing to tell (no changes). */
export function renderOwnerChangesEmail(input: OwnerChangesEmailInput): OwnerChangesEmail | null {
  if (input.changes.length === 0) return null;
  const name = String(input.producerName ?? "").trim() || "profilen din";
  const n = input.changes.length;
  const subject = headerSafe(`${n === 1 ? "Én endring" : `${n} endringer`} på profilen din ${input.dayLabel} – Rett fra Bonden`);
  const intro = `Dette ble endret på profilen til ${name} på Rett fra Bonden ${input.dayLabel}, av andre enn deg:`;
  const shown = input.changes.slice(0, OWNER_CHANGES_LIST_MAX);
  const rest = n - shown.length;
  const restLine = rest > 0 ? `… og ${rest} ${rest === 1 ? "endring" : "endringer"} til.` : null;
  const check = `Ser noe feil ut? Skriv til ${CONTACT}, så hjelper vi deg.`;
  const why = "Vi sender én samlet e-post per dag når noe på profilen er endret av andre enn deg. Endringer du gjør selv, får du ikke e-post om.";

  const textLines: string[] = ["Hei!", "", intro, ""];
  for (const c of shown) textLines.push(`- ${ownerChangeLine(c)} (${ownerChangeMeta(c)})`);
  if (restLine) textLines.push(restLine);
  textLines.push(
    "",
    check,
    "",
    "Se og bestem selv hva profilen din viser i «Mine valg»:",
    input.mineValgUrl,
    "",
    "Hilsen Rett fra Bonden",
    "",
    "--",
    `Du får denne e-posten fordi du eier profilen ${name} på Rett fra Bonden. ${why}`,
    `Slå av e-post om endringer i «Mine valg»: ${input.mineValgUrl}`,
  );
  if (input.unsubscribeUrl) textLines.push(`Ikke send flere e-poster om endringer: ${input.unsubscribeUrl}`);
  const text = textLines.join("\n") + "\n";

  const items = shown
    .map((c) => `<li style="margin:0 0 8px">${esc(ownerChangeLine(c))}<br><span style="color:#555;font-size:13px">${esc(ownerChangeMeta(c))}</span></li>`)
    .join("\n");
  const unsub = input.unsubscribeUrl ? ` · <a href="${esc(input.unsubscribeUrl)}" style="color:#555">Ikke send flere e-poster om endringer</a>` : "";
  const html = `<!doctype html><html lang="nb"><head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="margin:0;background:#ffffff;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.5">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<p>Hei!</p>
<p>${esc(intro)}</p>
<ul style="padding-left:20px">
${items}
</ul>
${restLine ? `<p>${esc(restLine)}</p>\n` : ""}<p>Ser noe feil ut? Skriv til <a href="mailto:${CONTACT}" style="color:#2D5016">${CONTACT}</a>, så hjelper vi deg.</p>
<p><a href="${esc(input.mineValgUrl)}" style="color:#2D5016">Se og bestem selv i «Mine valg»</a></p>
<p>Hilsen Rett fra Bonden</p>
<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 12px">
<p style="color:#555;font-size:13px">Du får denne e-posten fordi du eier profilen ${esc(name)} på Rett fra Bonden. ${esc(why)}<br>
<a href="${esc(input.mineValgUrl)}" style="color:#555">Slå av e-post om endringer i «Mine valg»</a>${unsub}</p>
</div></body></html>`;

  return { subject, text, html };
}

// ── Build (read + render) ───────────────────────────────────────────────────
export type ChangesWouldSendReason =
  | "would_send_if_sending_existed"
  | "not_owner"
  | "inactive"
  | "setting_unreadable"
  | "notify_changes_off"
  | "no_changes"
  | "no_signing_secret";

export interface OwnerChangesPreview {
  agentId: string;
  producerName: string;
  day: OsloDay;
  /** The day's changes by others, oldest first (as the owner's log shows them). */
  changes: OwnerAuditFeedRow[];
  /** null when there are no changes (nothing to send). */
  email: OwnerChangesEmail | null;
  mineValgUrl: string;
  unsubscribeUrl: string | null;
  notifyChanges: boolean | null;
  notifyChangesStatus: OwnerFeatureStatus;
  isOwner: boolean;
  wouldSend: boolean;
  wouldSendReason: ChangesWouldSendReason;
}

/**
 * Reads the day's changes and renders the digest for one producer. `day`
 * defaults to yesterday (Europe/Oslo). null = unknown agent. Read only:
 * SELECTs, no writes, no sending.
 */
export function buildOwnerChangesPreview(
  db: Db,
  agentId: string,
  opts: { day?: OsloDay | null; nowMs?: number; registry?: OwnerFeatureEntry[] } = {},
): OwnerChangesPreview | null {
  const nowMs = opts.nowMs ?? Date.now();
  const row = db.prepare(
    `SELECT a.id AS id, a.name AS name, a.is_active AS is_active, ${customerRuleSql("a")} AS owned
       FROM agents a WHERE a.id = ?`,
  ).get(agentId) as { id: string; name: string | null; is_active: number | null; owned: number } | undefined;
  if (!row) return null;

  const producerName = String(row.name ?? "");
  const day = opts.day ?? osloDay(defaultDigestDay(nowMs));
  const changes = readOwnerChangesForDay(db, agentId, day);
  const mineValgUrl = ownerMineValgChangesUrl(agentId);
  const unsubscribeUrl = ownerChangesUnsubscribeUrl(agentId);
  const email = renderOwnerChangesEmail({ producerName, dayLabel: day.label, changes, mineValgUrl, unsubscribeUrl });

  let notifyChanges: boolean | null = null;
  let settingOk = true;
  try {
    const v = featureValue("rfb", agentId, "notify.changes", { db, ...(opts.registry ? { registry: opts.registry } : {}) });
    notifyChanges = typeof v === "boolean" ? v : null;
  } catch {
    settingOk = false;
  }
  const isOwner = row.owned === 1;
  let wouldSendReason: ChangesWouldSendReason = "would_send_if_sending_existed";
  if (!isOwner) wouldSendReason = "not_owner";
  else if (row.is_active !== 1) wouldSendReason = "inactive";
  else if (!settingOk) wouldSendReason = "setting_unreadable";
  else if (notifyChanges === false) wouldSendReason = "notify_changes_off";
  else if (!email) wouldSendReason = "no_changes";
  else if (!unsubscribeUrl) wouldSendReason = "no_signing_secret";

  return {
    agentId,
    producerName,
    day,
    changes,
    email,
    mineValgUrl,
    unsubscribeUrl,
    notifyChanges,
    notifyChangesStatus: ownerFeatureStatus(getOwnerFeature("notify.changes", opts.registry ?? ownerFeatureRegistryFor("rfb"))),
    isOwner,
    wouldSend: wouldSendReason === "would_send_if_sending_existed",
    wouldSendReason,
  };
}
