/**
 * partner-report-service.ts — admin effect report for a group of producers
 * (dev-request 2026-10-03-partner-effektrapport-per-gaard, SLICE 1).
 *
 * Slice 1 = contact clicks per agent (is_bot = 0), by kind and by utm_source,
 * read through the SAME helpers owner-stats uses (owner-stats-service.ts), so
 * numbers match by construction. Slice 2 (views_by_class) and slice 3
 * (discoveries_by_channel) are NOT built yet: those fields are omitted.
 *
 * Columns used (verified against init.ts): contact_clicks(agent_id, kind,
 * is_bot, utm_source, created_at); agents(id, name, umbrella_type);
 * agent_affiliations(producer_id, umbrella_id, status). Aggregates only —
 * never session_id / IP hash / UA.
 */
import type Database from "better-sqlite3";
import {
  countContactClicksByKind,
  countContactClicksByUtmSource,
  type ContactClickWindow,
} from "./owner-stats-service";

export const PARTNER_REPORT_MAX_AGENTS = 500;
export const PARTNER_REPORT_MAX_DAYS = 365;
export const PARTNER_REPORT_DEFAULT_DAYS = 30;

export class PartnerReportInputError extends Error {
  constructor(message: string, public status: number = 400) {
    super(message);
  }
}

export interface PartnerReportRow {
  agent_id: string;
  name: string | null;
  clicks_total: number;
  clicks_by_kind: Record<string, number>;
  clicks_by_utm_source: Record<string, number>;
}

export interface PartnerReport {
  success: true;
  window: { days: number | null; from: string | null; to: string | null };
  generated_at: string;
  agents: PartnerReportRow[];
  total: Omit<PartnerReportRow, "agent_id" | "name"> & { agent_count: number };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function validDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export interface PartnerReportInput {
  agentIds?: unknown;
  umbrella?: unknown;
  days?: unknown;
  from?: unknown;
  to?: unknown;
}

export function parsePartnerReportWindow(q: PartnerReportInput): {
  win: ContactClickWindow;
  meta: PartnerReport["window"];
} {
  const hasRange = q.from !== undefined || q.to !== undefined;
  if (hasRange) {
    if (q.days !== undefined) throw new PartnerReportInputError("Use either days or from/to, not both");
    const from = String(q.from ?? "");
    const to = String(q.to ?? "");
    if (!validDate(from) || !validDate(to)) throw new PartnerReportInputError("from and to must both be valid YYYY-MM-DD dates");
    if (from > to) throw new PartnerReportInputError("from must be on or before to");
    return { win: { from, to }, meta: { days: null, from, to } };
  }
  let days = PARTNER_REPORT_DEFAULT_DAYS;
  if (q.days !== undefined) {
    const s = String(q.days);
    if (!/^\d+$/.test(s)) throw new PartnerReportInputError("Invalid days — must be a positive integer");
    days = parseInt(s, 10);
    if (days < 1 || days > PARTNER_REPORT_MAX_DAYS) {
      throw new PartnerReportInputError(`Invalid days — must be 1..${PARTNER_REPORT_MAX_DAYS}`);
    }
  }
  return { win: { days }, meta: { days, from: null, to: null } };
}

export function resolvePartnerReportAgentIds(db: Database.Database, q: PartnerReportInput): string[] {
  const hasIds = q.agentIds !== undefined && String(q.agentIds) !== "";
  const hasUmbrella = q.umbrella !== undefined && String(q.umbrella) !== "";
  if (hasIds === hasUmbrella) throw new PartnerReportInputError("Provide exactly one of agentIds or umbrella");
  let ids: string[];
  if (hasIds) {
    ids = String(q.agentIds).split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) throw new PartnerReportInputError("agentIds is empty");
    if (ids.some((id) => !ID_RE.test(id))) throw new PartnerReportInputError("agentIds contains an invalid id");
    ids = Array.from(new Set(ids));
  } else {
    const uid = String(q.umbrella);
    if (!ID_RE.test(uid)) throw new PartnerReportInputError("Invalid umbrella id");
    const u = db.prepare(`SELECT id FROM agents WHERE id = ? AND umbrella_type IS NOT NULL`).get(uid);
    if (!u) throw new PartnerReportInputError("Umbrella not found", 404);
    // Same membership definition as computeUmbrellaTraffic (admin-stats-compute.ts).
    ids = (db
      .prepare(`SELECT DISTINCT producer_id FROM agent_affiliations WHERE umbrella_id = ? AND status = 'active' ORDER BY producer_id`)
      .all(uid) as Array<{ producer_id: string }>).map((r) => r.producer_id);
    if (ids.length === 0) throw new PartnerReportInputError("Umbrella has no active members", 404);
  }
  if (ids.length > PARTNER_REPORT_MAX_AGENTS) {
    throw new PartnerReportInputError(`Too many agents (${ids.length}); max ${PARTNER_REPORT_MAX_AGENTS}`);
  }
  return ids;
}

function toRecord(items: Array<{ key: string; count: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i.key] = i.count;
  return out;
}

export function computePartnerReport(db: Database.Database, q: PartnerReportInput, now: Date = new Date()): PartnerReport {
  const { win, meta } = parsePartnerReportWindow(q);
  const ids = resolvePartnerReportAgentIds(db, q);
  const nameStmt = db.prepare(`SELECT name FROM agents WHERE id = ?`);

  const totalKind: Record<string, number> = {};
  const totalUtm: Record<string, number> = {};
  let totalClicks = 0;
  const agents: PartnerReportRow[] = ids.map((id) => {
    const kinds = countContactClicksByKind(db, id, win);
    const utms = countContactClicksByUtmSource(db, id, win);
    const clicks_total = kinds.reduce((a, k) => a + k.count, 0);
    for (const k of kinds) totalKind[k.kind] = (totalKind[k.kind] || 0) + k.count;
    for (const u of utms) totalUtm[u.source] = (totalUtm[u.source] || 0) + u.count;
    totalClicks += clicks_total;
    const n = nameStmt.get(id) as { name: string } | undefined;
    return {
      agent_id: id,
      name: n?.name ?? null,
      clicks_total,
      clicks_by_kind: toRecord(kinds.map((k) => ({ key: k.kind, count: k.count }))),
      clicks_by_utm_source: toRecord(utms.map((u) => ({ key: u.source, count: u.count }))),
    };
  });

  return {
    success: true,
    window: meta,
    generated_at: now.toISOString(),
    agents,
    total: { agent_count: agents.length, clicks_total: totalClicks, clicks_by_kind: totalKind, clicks_by_utm_source: totalUtm },
  };
}

function csvCell(v: string | number | null): string {
  let s = v === null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Long-format CSV: one line per agent × dimension × key. TOTAL row last. */
export function partnerReportToCsv(r: PartnerReport): string {
  const lines = ["agent_id,name,dimension,key,count"];
  const emit = (id: string, name: string | null, p: { clicks_total: number; clicks_by_kind: Record<string, number>; clicks_by_utm_source: Record<string, number> }) => {
    lines.push([id, name, "clicks_total", "", p.clicks_total].map(csvCell).join(","));
    for (const [k, c] of Object.entries(p.clicks_by_kind)) lines.push([id, name, "clicks_by_kind", k, c].map(csvCell).join(","));
    for (const [k, c] of Object.entries(p.clicks_by_utm_source)) lines.push([id, name, "clicks_by_utm_source", k, c].map(csvCell).join(","));
  };
  for (const a of r.agents) emit(a.agent_id, a.name, a);
  emit("TOTAL", null, r.total);
  return lines.join("\n") + "\n";
}
