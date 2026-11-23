// ─── Monthly owner report e-mail: TEMPLATE only (no sending) ────────────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, S5-3. The owner-feature
// registry entry `notify.report` (surface email:owner_monthly_report, default
// monthly) promises a monthly e-mail with views, «med i AI-søk» and clicks and
// a link to «Mine valg». This module only RENDERS that e-mail for one
// producer and one calendar month. Nothing here sends, schedules or writes:
// the first edition is approved by Daniel, and any send-out is Daniel's own,
// via POST /admin/crm/compose.
//
// Numbers — no new tracking; the same tables and filters as the owner's
// Statistikk tab (owner-stats-service.ts) and the 12-month tiles
// (profile-year-compute.ts), cut to the month's UTC days:
//
//   views       people's profile page views. Days still in the raw tables
//               (from the raw floor, profileYearRawFrom) come from
//               analytics_page_views via readPathViewGroups (class 'human',
//               owner rows out, 2xx/304); older days from agent_view_daily
//               (legacy bucket out), never before AGENT_VIEW_CLASSIFIED_SINCE.
//   aiSearches  «Med i AI-søk»: profile_ai_deliveries for vertical 'rfb', from
//               aiDeliveriesCountingSince() on.
//   clicks      contact_clicks, is_bot = 0, through countContactClicksByKind
//               (the same helper the Statistikk tab and the partner report use).
//
// A number whose source does not cover the month is left out of the e-mail
// (never shown as 0); a number that covers only part of it says «fra <dato>».
// The comparison with the previous month is shown only when both months are
// fully covered.
//
// Unsubscribe: a stateless signed token for this agent with its OWN purpose
// string (avmeld-service.serverSignatureFor), so neither an /avmeld token nor
// an S5-2 preview token validates as one and vice versa. S5-4: the route that
// consumes it is live — `/rapport-avmeld/:token` (routes/rapport-avmeld.ts):
// GET confirms only, POST (or the RFC 8058 one-click body) sets
// notify.report = off through recordOwnerReportUnsubscribe below, also while
// the entry is coming_soon (registry `recipientOptOut`), and this builder then
// answers would_send false / notify_report_off. The preview says so
// (`unsubscribe.route_live: true`).

import crypto from "crypto";
import type Database from "better-sqlite3";
import { serverSignatureFor } from "./avmeld-service";
import { customerRuleSql } from "./customer-rule";
import { countContactClicksByKind, readPathViewGroups } from "./owner-stats-service";
import { AGENT_VIEW_CLASSIFIED_SINCE, profileYearRawFrom } from "./profile-year-compute";
import { aiDeliveriesCountingSince } from "./profile-ai-deliveries-compute";
import { isAnalyticsRollupReadEnabled } from "./analytics-rollup-boundary";
import { LEGACY_AGENT_VIEW_SOURCE } from "../database/analytics-sql";
import { getOwnerFeature, ownerFeatureRegistryFor, ownerFeatureStatus, type OwnerFeatureEntry, type OwnerFeatureStatus } from "../owner-features/registry";
import { featureValue, setOwnerFeatureValue, type SetOwnerFeatureResult } from "../owner-features/resolve";
import { ownerPlannedAnchor, ownerRowAnchor } from "../owner-features/anchors";
import { slugify } from "../utils/slug";

type Db = Database.Database;

export const OWNER_REPORT_UNSUB_PURPOSE = "owner-report-unsub-v1";
export const OWNER_REPORT_UNSUB_PATH = "/rapport-avmeld/";
const REPORT_TZ = "Europe/Oslo";
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MIN_YEAR = 2020;

const MONTHS_NB = [
  "januar", "februar", "mars", "april", "mai", "juni",
  "juli", "august", "september", "oktober", "november", "desember",
];

// ── Month helpers ───────────────────────────────────────────────────────────
export interface ReportMonth {
  /** 'YYYY-MM'. */
  month: string;
  /** First UTC day 'YYYY-MM-DD'. */
  from: string;
  /** Last UTC day 'YYYY-MM-DD' (inclusive). */
  to: string;
  /** «oktober 2026». */
  label: string;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function monthOf(year: number, month1: number): ReportMonth {
  const last = new Date(Date.UTC(year, month1, 0)).getUTCDate();
  const m = `${year}-${pad2(month1)}`;
  return { month: m, from: `${m}-01`, to: `${m}-${pad2(last)}`, label: `${MONTHS_NB[month1 - 1]} ${year}` };
}

/** The current calendar month in Europe/Oslo, 'YYYY-MM'. */
export function osloMonthOf(nowMs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: REPORT_TZ, year: "numeric", month: "2-digit" }).formatToParts(new Date(nowMs));
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  return `${y}-${m}`;
}

/** The month before 'YYYY-MM'. */
export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map((s) => parseInt(s, 10));
  return m === 1 ? `${y - 1}-12` : `${y}-${pad2(m - 1)}`;
}

/** Default report month: the previous calendar month in Europe/Oslo. */
export function defaultReportMonth(nowMs: number = Date.now()): string {
  return previousMonth(osloMonthOf(nowMs));
}

/**
 * 'YYYY-MM' → the month, or null when malformed, before MIN_YEAR or after the
 * current Oslo month (the current month is allowed; it is marked partial).
 */
export function parseReportMonth(raw: unknown, nowMs: number = Date.now()): ReportMonth | null {
  if (typeof raw !== "string") return null;
  const m = MONTH_RE.exec(raw);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  if (year < MIN_YEAR) return null;
  if (raw > osloMonthOf(nowMs)) return null;
  return monthOf(year, parseInt(m[2], 10));
}

function addDaysIso(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function shortDate(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${d.getUTCDate()}. ${MONTHS_NB[d.getUTCMonth()]}`;
}

// ── Unsubscribe token (own purpose) ─────────────────────────────────────────
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** null when no server secret is configured (fail closed) or the id is unusable. */
export function makeOwnerReportUnsubToken(agentId: string): string | null {
  if (!agentId || agentId.includes("\n") || agentId.length > 200) return null;
  const payload = b64url(Buffer.from(`ru1\n${agentId}`, "utf8"));
  const sig = serverSignatureFor(OWNER_REPORT_UNSUB_PURPOSE, payload);
  return sig ? `${payload}.${sig}` : null;
}

/** The agent id the token was signed for, or null when it is not a report-unsubscribe token. */
export function verifyOwnerReportUnsubToken(token: string): string | null {
  if (typeof token !== "string" || token.length > 600) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const expectedSig = serverSignatureFor(OWNER_REPORT_UNSUB_PURPOSE, payload);
  if (!expectedSig) return null;
  const given = Buffer.from(token.slice(dot + 1), "utf8");
  const expected = Buffer.from(expectedSig, "utf8");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  const parts = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8").split("\n");
  if (parts.length !== 2 || parts[0] !== "ru1" || !parts[1]) return null;
  return parts[1];
}

/** The value the report's unsubscribe link sets (registry notify.report.recipientOptOut). */
export const OWNER_REPORT_OFF_VALUE = "off";

/**
 * S5-4: a recipient's unsubscribe — sets the RFB owner feature notify.report
 * to "off" (one owner_feature_audit row when it changed, actor system,
 * detail «rapport-avmeld»). Idempotent. Never touches the profile or the
 * outreach suppression (email_bounces). Only ever writes "off".
 */
export function recordOwnerReportUnsubscribe(db: Db, agentId: string): SetOwnerFeatureResult {
  return setOwnerFeatureValue(
    "rfb",
    agentId,
    "notify.report",
    OWNER_REPORT_OFF_VALUE,
    { actor: "system", detail: "rapport-avmeld" },
    { db, recipientOptOut: true },
  );
}

// ── Metrics ─────────────────────────────────────────────────────────────────
export interface MonthMetric {
  value: number;
  /** null = the whole month is covered; else the first day counted. */
  countedFrom: string | null;
}

export interface MonthMetrics {
  /** null = no source covers this month (the line is left out). */
  views: MonthMetric | null;
  aiSearches: MonthMetric | null;
  clicks: (MonthMetric & { byKind: Record<string, number> }) | null;
}

function tableExists(db: Db, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function readViews(db: Db, agentId: string, path: string, m: ReportMonth, nowMs: number): MonthMetric | null {
  const rawFrom = profileYearRawFrom(db, nowMs);
  let value = 0;
  let firstCovered: string | null = null;

  // Stored part: days before the raw floor, never before classification began.
  const storedFrom = m.from > AGENT_VIEW_CLASSIFIED_SINCE ? m.from : AGENT_VIEW_CLASSIFIED_SINCE;
  const storedTo = m.to < addDaysIso(rawFrom, -1) ? m.to : addDaysIso(rawFrom, -1);
  if (storedFrom <= storedTo && isAnalyticsRollupReadEnabled() && tableExists(db, "agent_view_daily")) {
    const r = db.prepare(
      `SELECT COALESCE(SUM(view_count), 0) AS n FROM agent_view_daily
        WHERE agent_id = ? AND day >= ? AND day <= ? AND view_source != ?`,
    ).get(agentId, storedFrom, storedTo, LEGACY_AGENT_VIEW_SOURCE) as { n: number };
    value += r.n;
    firstCovered = storedFrom;
  }

  // Raw part: from the raw floor (or the month's first day) to the month's end.
  const rawStart = m.from > rawFrom ? m.from : rawFrom;
  if (rawStart <= m.to) {
    const iso = `${rawStart} 00:00:00`;
    for (const g of readPathViewGroups(db, path, iso, { yearFromIso: iso })) {
      if (g.cls !== "human" || g.day < rawStart || g.day > m.to) continue;
      value += g.yearViews ?? 0;
    }
    if (firstCovered === null) firstCovered = rawStart;
  }

  if (firstCovered === null) return null;
  return { value, countedFrom: firstCovered > m.from ? firstCovered : null };
}

function readAiSearches(db: Db, agentId: string, m: ReportMonth): MonthMetric | null {
  if (!tableExists(db, "profile_ai_deliveries")) return null;
  const since = aiDeliveriesCountingSince();
  if (since > m.to) return null;
  const start = m.from > since ? m.from : since;
  const r = db.prepare(
    `SELECT COALESCE(SUM(count), 0) AS n FROM profile_ai_deliveries
      WHERE vertical_id = 'rfb' AND profile_id = ? AND day >= ? AND day <= ?`,
  ).get(agentId, start, m.to) as { n: number };
  return { value: r.n, countedFrom: start > m.from ? start : null };
}

function readClicks(db: Db, agentId: string, m: ReportMonth): MonthMetrics["clicks"] {
  if (!tableExists(db, "contact_clicks")) return null;
  const rows = countContactClicksByKind(db, agentId, { from: m.from, to: m.to });
  const byKind: Record<string, number> = {};
  let value = 0;
  for (const r of rows) {
    byKind[r.kind] = r.count;
    value += r.count;
  }
  return { value, countedFrom: null, byKind };
}

/** All three numbers for one producer and one month. Read only. */
export function readMonthMetrics(db: Db, agentId: string, path: string, m: ReportMonth, nowMs: number): MonthMetrics {
  return {
    views: readViews(db, agentId, path, m, nowMs),
    aiSearches: readAiSearches(db, agentId, m),
    clicks: readClicks(db, agentId, m),
  };
}

// ── Render ──────────────────────────────────────────────────────────────────
export interface OwnerMonthlyReportEmail {
  subject: string;
  text: string;
  html: string;
}

export interface OwnerMonthlyReportInput {
  producerName: string;
  month: ReportMonth;
  metrics: MonthMetrics;
  /** The previous month's numbers; a line compares only when both are fully covered. */
  previous: MonthMetrics | null;
  mineValgUrl: string;
  /** null when no signing secret is configured (no one-click link). */
  unsubscribeUrl: string | null;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function nbNum(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Strip control characters / newlines from a header value (the subject). */
function headerSafe(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

interface Line {
  label: string;
  value: number;
  note: string | null;
}

function compareNote(cur: MonthMetric, prev: MonthMetric | null | undefined): string | null {
  if (!prev || cur.countedFrom !== null || prev.countedFrom !== null) return null;
  if (cur.value === prev.value) return "samme som måneden før";
  return `${nbNum(prev.value)} måneden før`;
}

function linesFor(input: OwnerMonthlyReportInput): Line[] {
  const { metrics: cur, previous: prev } = input;
  const out: Line[] = [];
  const add = (label: string, metric: MonthMetric | null, prevMetric: MonthMetric | null | undefined) => {
    if (!metric) return;
    const notes: string[] = [];
    if (metric.countedFrom) notes.push(`telt fra ${shortDate(metric.countedFrom)}`);
    const cmp = compareNote(metric, prevMetric);
    if (cmp) notes.push(cmp);
    out.push({ label, value: metric.value, note: notes.length ? notes.join(", ") : null });
  };
  add("Besøk på profilen", cur.views, prev?.views);
  add("Med i treffene til AI-assistenter", cur.aiSearches, prev?.aiSearches);
  add("Trykk på telefon, e-post eller nettside", cur.clicks, prev?.clicks);
  return out;
}

/** Pure: the e-mail for already-read numbers. */
export function renderOwnerMonthlyReport(input: OwnerMonthlyReportInput): OwnerMonthlyReportEmail {
  const name = String(input.producerName ?? "").trim() || "profilen din";
  const monthLabel = input.month.label;
  const subject = headerSafe(`Profilen din i ${monthLabel} – Rett fra Bonden`);
  const lines = linesFor(input);
  const allZero = lines.length > 0 && lines.every((l) => l.value === 0);

  const intro = `Her er tallene for ${name} på Rett fra Bonden i ${monthLabel}.`;
  const zeroNote = "Det var stille denne måneden. Det er vanlig for en profil som er ny eller lite kjent. Oppdaterte varer og åpningstider gjør det lettere for folk og AI-assistenter å finne deg.";
  const noData = "Vi har ingen tall for denne måneden ennå.";

  // Plain text.
  const textLines: string[] = ["Hei!", "", intro, ""];
  if (lines.length === 0) textLines.push(noData);
  for (const l of lines) textLines.push(`- ${l.label}: ${nbNum(l.value)}${l.note ? ` (${l.note})` : ""}`);
  if (allZero) textLines.push("", zeroNote);
  textLines.push(
    "",
    "Se mer og bestem selv hva profilen din viser i «Mine valg»:",
    input.mineValgUrl,
    "",
    "Hilsen Rett fra Bonden",
    "",
    "--",
    `Du får denne e-posten fordi du eier profilen ${name} på Rett fra Bonden.`,
    `Endre hvor ofte du får rapporten: ${input.mineValgUrl}`,
  );
  if (input.unsubscribeUrl) textLines.push(`Ikke send flere rapporter: ${input.unsubscribeUrl}`);
  const text = textLines.join("\n") + "\n";

  // HTML (every interpolated value escaped).
  const rows = lines
    .map((l) => `<tr><td style="padding:6px 12px 6px 0">${esc(l.label)}</td><td style="padding:6px 0;font-weight:600;text-align:right">${esc(nbNum(l.value))}</td></tr>`
      + (l.note ? `<tr><td colspan="2" style="padding:0 0 6px;color:#555;font-size:13px">${esc(l.note)}</td></tr>` : ""))
    .join("");
  const table = lines.length ? `<table role="presentation" style="border-collapse:collapse;margin:12px 0">${rows}</table>` : `<p>${esc(noData)}</p>`;
  const unsub = input.unsubscribeUrl ? ` · <a href="${esc(input.unsubscribeUrl)}" style="color:#555">Ikke send flere rapporter</a>` : "";
  const html = `<!doctype html><html lang="nb"><head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="margin:0;background:#ffffff;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.5">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<p>Hei!</p>
<p>${esc(intro)}</p>
${table}
${allZero ? `<p>${esc(zeroNote)}</p>` : ""}
<p><a href="${esc(input.mineValgUrl)}" style="color:#2D5016">Se mer og bestem selv i «Mine valg»</a></p>
<p>Hilsen Rett fra Bonden</p>
<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 12px">
<p style="color:#555;font-size:13px">Du får denne e-posten fordi du eier profilen ${esc(name)} på Rett fra Bonden.<br>
<a href="${esc(input.mineValgUrl)}" style="color:#555">Endre hvor ofte du får rapporten</a>${unsub}</p>
</div></body></html>`;

  return { subject, text, html };
}

// ── Build (read + render) ───────────────────────────────────────────────────
export type WouldSendReason =
  | "would_send_if_sending_existed"
  | "notify_report_off"
  | "quarterly_not_due"
  | "not_owner"
  | "inactive"
  | "no_signing_secret"
  | "setting_unreadable";

export interface OwnerMonthlyReport extends OwnerMonthlyReportEmail {
  agentId: string;
  producerName: string;
  month: ReportMonth;
  /** True when the month is the current (unfinished) Oslo month. */
  partialMonth: boolean;
  metrics: MonthMetrics;
  previous: MonthMetrics;
  mineValgUrl: string;
  unsubscribeUrl: string | null;
  notifyReport: string | null;
  /** The entry's run-time status (coming_soon = owners cannot change it yet; the default applies, except a recipient's unsubscribe). */
  notifyReportStatus: OwnerFeatureStatus;
  isOwner: boolean;
  wouldSend: boolean;
  wouldSendReason: WouldSendReason;
}

function publicBase(): string {
  return (process.env.APP_URL || "https://rettfrabonden.com").replace(/\/+$/, "");
}

export function ownerMineValgReportUrl(agentId: string): string {
  const entry = getOwnerFeature("notify.report", ownerFeatureRegistryFor("rfb"));
  const anchor = ownerFeatureStatus(entry) === "live" ? ownerRowAnchor("notify.report") : ownerPlannedAnchor("notify.report");
  return `${publicBase()}/eier/${encodeURIComponent(agentId)}/valg#${anchor}`;
}

export function ownerReportUnsubscribeUrl(agentId: string): string | null {
  const token = makeOwnerReportUnsubToken(agentId);
  return token ? `${publicBase()}${OWNER_REPORT_UNSUB_PATH}${token}` : null;
}

/**
 * Reads and renders the report for one producer and month. null = unknown
 * agent. Read only: SELECTs, no writes, no sending.
 */
export function buildOwnerMonthlyReport(
  db: Db,
  agentId: string,
  month: ReportMonth,
  opts: { nowMs?: number; registry?: OwnerFeatureEntry[] } = {},
): OwnerMonthlyReport | null {
  const nowMs = opts.nowMs ?? Date.now();
  const row = db.prepare(
    `SELECT a.id AS id, a.name AS name, a.is_active AS is_active, ${customerRuleSql("a")} AS owned
       FROM agents a WHERE a.id = ?`,
  ).get(agentId) as { id: string; name: string | null; is_active: number | null; owned: number } | undefined;
  if (!row) return null;

  const producerName = String(row.name ?? "");
  const path = `/produsent/${slugify(producerName)}`;
  const metrics = readMonthMetrics(db, agentId, path, month, nowMs);
  const prevMonth = monthOfString(previousMonth(month.month));
  const previous = readMonthMetrics(db, agentId, path, prevMonth, nowMs);
  const mineValgUrl = ownerMineValgReportUrl(agentId);
  const unsubscribeUrl = ownerReportUnsubscribeUrl(agentId);

  let notifyReport: string | null = null;
  let settingOk = true;
  try {
    const v = featureValue("rfb", agentId, "notify.report", { db, ...(opts.registry ? { registry: opts.registry } : {}) });
    notifyReport = typeof v === "string" ? v : null;
  } catch {
    settingOk = false;
  }
  const isOwner = row.owned === 1;
  const quarterEnd = /-(03|06|09|12)$/.test(month.month);
  let wouldSendReason: WouldSendReason = "would_send_if_sending_existed";
  if (!isOwner) wouldSendReason = "not_owner";
  else if (row.is_active !== 1) wouldSendReason = "inactive";
  else if (!settingOk) wouldSendReason = "setting_unreadable";
  else if (notifyReport === "off") wouldSendReason = "notify_report_off";
  else if (notifyReport === "quarterly" && !quarterEnd) wouldSendReason = "quarterly_not_due";
  else if (!unsubscribeUrl) wouldSendReason = "no_signing_secret";

  const email = renderOwnerMonthlyReport({ producerName, month, metrics, previous, mineValgUrl, unsubscribeUrl });
  return {
    ...email,
    agentId,
    producerName,
    month,
    partialMonth: month.month === osloMonthOf(nowMs),
    metrics,
    previous,
    mineValgUrl,
    unsubscribeUrl,
    notifyReport,
    notifyReportStatus: ownerFeatureStatus(getOwnerFeature("notify.report", opts.registry ?? ownerFeatureRegistryFor("rfb"))),
    isOwner,
    wouldSend: wouldSendReason === "would_send_if_sending_existed",
    wouldSendReason,
  };
}

function monthOfString(month: string): ReportMonth {
  const [y, m] = month.split("-").map((s) => parseInt(s, 10));
  return monthOf(y, m);
}
