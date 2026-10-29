// ─── Debio approval: read side (økologi S1) ─────────────────────────────────
// A2A dev-request 2026-10-28-rfb-okologisk-merking-debio-register-og-
// tekstrevisjon, S1.5 / AC1.5–AC1.6. What a public surface may show from the
// register status the sync (debio-register-sync.ts) writes on `agents`:
//
//   - no agent_debio_status row (never checked against the register): the S0
//     rule as before — `debio_verified = 1` from the finnoko sync.
//   - register-checked: shown only for `okologisk` with a certificate valid
//     today, and only while the last successful register sync is at most
//     DEBIO_REGISTER_STALE_DAYS old. karens / annet / ingen show nothing.
//
// The profile page shows «Godkjent av Debio for {hovedproduktgruppe(r)} —
// sjekket {dato}» linking to Debio's own search — never «✓ Debio-verifisert»,
// never the Ø-mark or the EU logo.

import type Database from "better-sqlite3";
import { isDebioVerifiedValue } from "./organic-claims";

export const DEBIO_REGISTER_STALE_DAYS = 7;
export const FINNOKO_SEARCH_URL = "https://finnoko.debio.no/?search=";

export interface DebioRegisterSyncState {
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_success_rows: number | null;
  last_reject_at: string | null;
  last_reject_reason: string | null;
}

/** The register sync's state row, or null (never run / older schema). */
export function readDebioRegisterState(db: Database.Database): DebioRegisterSyncState | null {
  try {
    return (db.prepare(
      "SELECT last_attempt_at, last_success_at, last_success_rows, last_reject_at, last_reject_reason FROM debio_register_sync_state WHERE id = 1",
    ).get() as DebioRegisterSyncState | undefined) ?? null;
  } catch {
    return null;
  }
}

/** More than DEBIO_REGISTER_STALE_DAYS since the last successful sync (or none at all)? */
export function debioRegisterStale(state: DebioRegisterSyncState | null, now: Date = new Date()): boolean {
  const ms = state?.last_success_at ? Date.parse(state.last_success_at) : NaN;
  if (!Number.isFinite(ms)) return true;
  return now.getTime() - ms > DEBIO_REGISTER_STALE_DAYS * 86_400_000;
}

export interface DebioStatusRow {
  debio_status: string;
  debio_cert_valid_to: string | null;
  debio_product_groups: string | null;
  debio_checked_at: string | null;
}

/** The agent's register status row (agent_debio_status), or null (never checked / older schema). */
export function readDebioStatusRow(db: Database.Database, agentId: string): DebioStatusRow | null {
  try {
    return (db.prepare(
      "SELECT debio_status, debio_cert_valid_to, debio_product_groups, debio_checked_at FROM agent_debio_status WHERE agent_id = ?",
    ).get(agentId) as DebioStatusRow | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Is a certificate valid-to date (YYYY-MM-DD) today or later? */
export function certValidOn(validTo: unknown, now: Date = new Date()): boolean {
  return typeof validTo === "string" && /^\d{4}-\d{2}-\d{2}/.test(validTo) && validTo.slice(0, 10) >= now.toISOString().slice(0, 10);
}

/**
 * May public surfaces show this producer's organic status right now?
 * `agent` is the agents row (id + debio_verified); the register status and
 * the sync state are read only for a verified producer (two single-row
 * queries).
 */
export function debioStatusShown(
  agent: { id?: unknown; debio_verified?: unknown } | null | undefined,
  db: Database.Database,
  opts: { now?: Date; statusRow?: DebioStatusRow | null; state?: DebioRegisterSyncState | null } = {},
): boolean {
  if (!agent || !isDebioVerifiedValue(agent.debio_verified)) return false;
  const row = opts.statusRow !== undefined ? opts.statusRow : readDebioStatusRow(db, String(agent.id ?? ""));
  if (!row) return true; // never checked against the register: finnoko-only, as before
  if (row.debio_status !== "okologisk") return false;
  const now = opts.now ?? new Date();
  if (!certValidOn(row.debio_cert_valid_to, now)) return false;
  const state = opts.state !== undefined ? opts.state : readDebioRegisterState(db);
  return !debioRegisterStale(state, now);
}

type Lang3 = "no" | "en" | "sv";
const langOf = (lang: string): Lang3 => (lang === "en" ? "en" : lang === "sv" ? "sv" : "no");

/** Short labels for Debio's main product groups. Unknown codes are left out. */
const PRODUCT_GROUP_LABELS: Record<string, Record<Lang3, string>> = {
  LBP: { no: "økologisk landbruksproduksjon", en: "organic agricultural production", sv: "ekologisk lantbruksproduktion" },
  FIO: { no: "foredling, import og omsetning", en: "processing, import and trade", sv: "förädling, import och handel" },
};

function groupKey(g: string): string | null {
  const s = g.trim().toUpperCase();
  if (PRODUCT_GROUP_LABELS[s]) return s;
  if (/LANDBRUK/.test(s)) return "LBP";
  if (/FOREDLING|IMPORT|OMSETNING/.test(s)) return "FIO";
  return null;
}

/** Known product-group labels for `groups` (JSON text or array), de-duplicated. */
export function productGroupLabels(groups: unknown, lang: string): string[] {
  let list: unknown = groups;
  if (typeof groups === "string") {
    try { list = JSON.parse(groups); } catch { list = []; }
  }
  if (!Array.isArray(list)) return [];
  const l = langOf(lang);
  const keys: string[] = [];
  for (const g of list) {
    if (typeof g !== "string") continue;
    const k = groupKey(g);
    if (k && !keys.includes(k)) keys.push(k);
  }
  return keys.map((k) => PRODUCT_GROUP_LABELS[k][l]);
}

function joinList(items: string[], lang: Lang3): string {
  if (items.length <= 1) return items.join("");
  const and = lang === "en" ? "and" : lang === "sv" ? "och" : "og";
  return `${items.slice(0, -1).join("; ")} ${and} ${items[items.length - 1]}`;
}

function formatDate(iso: unknown, lang: Lang3): string | null {
  if (typeof iso !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return lang === "sv" ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}.${m[2]}.${m[1]}`;
}

/**
 * «Godkjent av Debio for {groups} — sjekket {dato}» (EN «Approved by Debio
 * for … — checked …», SV «Godkänd av Debio för … — kontrollerad …»). Without
 * a known product group the «for …» part is left out.
 */
export function debioApprovalText(lang: string, groups: unknown, checkedAt: unknown): string {
  const l = langOf(lang);
  const labels = productGroupLabels(groups, l);
  const date = formatDate(checkedAt, l);
  const head = l === "en" ? "Approved by Debio" : l === "sv" ? "Godkänd av Debio" : "Godkjent av Debio";
  const forWord = l === "en" ? "for" : l === "sv" ? "för" : "for";
  const checked = l === "en" ? "checked" : l === "sv" ? "kontrollerad" : "sjekket";
  return `${head}${labels.length ? ` ${forWord} ${joinList(labels, l)}` : ""}${date ? ` — ${checked} ${date}` : ""}`;
}

/** Debio's own search for a producer name. */
export function finnokoSearchUrl(name: string): string {
  return FINNOKO_SEARCH_URL + encodeURIComponent(name);
}
