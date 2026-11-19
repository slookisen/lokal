#!/usr/bin/env tsx
/**
 * selvreg-own-origin-oslo-dry-run.ts — READ-ONLY census of self-registered
 * profiles that the old /selger form filled with invented data.
 *
 * dev-request selvregistrering-uten-nettside, slice F1.
 *
 * Until F1, the /selger registration form (src/public/selger.html) sent
 *   url:      window.location.origin       → our own site as the producer's website
 *   location: { city, lat: 59.91, lng: 10.75 } → Oslo coordinates for every city
 * The form no longer does either. This script lists the profiles already
 * stored that way, so the cleanup can be decided separately:
 *
 *   A. own_origin_url  — origin = 'self_registered' and agents.url is our own
 *      origin (rettfrabonden.com / lokal.fly.dev; http or https, with or
 *      without www., with or without a trailing slash; root path only).
 *   B. oslo_coords_not_oslo — origin = 'self_registered' and lat/lng ≈
 *      59.91/10.75 (±0.0005) while the stored city is not Oslo.
 *
 * DELIBERATELY READ-ONLY: the database is opened with
 * { readonly: true, fileMustExist: true }; there is no apply mode. Any fix is
 * run separately, by a human, after reading this output.
 *
 * Usage:
 *   npx tsx scripts/selvreg-own-origin-oslo-dry-run.ts [--db=/path/to/lokal.db] [--json]
 * The DB path defaults to $DB_PATH, then ./data/lokal.db (the same default as
 * src/database/init.ts). The production image does not ship scripts/, so run
 * it against a copy of the production database.
 */

import * as path from "node:path";

export const OWN_ORIGIN_HOSTS: ReadonlySet<string> = new Set(["rettfrabonden.com", "lokal.fly.dev"]);
export const FAKE_OSLO_LAT = 59.91;
export const FAKE_OSLO_LNG = 10.75;
export const COORD_TOLERANCE = 0.0005;

export interface SelfRegRow {
  id: string;
  name: string;
  url: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  origin?: string | null;
  is_vetted?: number | null;
  is_active?: number | null;
  created_at?: string | null;
}

export type SuspectReason = "own_origin_url" | "oslo_coords_not_oslo";

export interface SuspectRow {
  id: string;
  name: string;
  url: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  is_vetted: number | null;
  is_active: number | null;
  created_at: string | null;
  reasons: SuspectReason[];
}

/** True when `url` is just our own origin (any scheme/www./trailing-slash variant). */
export function isOwnOriginUrl(url: string | null | undefined): boolean {
  if (typeof url !== "string") return false;
  const raw = url.trim();
  if (!raw) return false;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  if (!OWN_ORIGIN_HOSTS.has(host)) return false;
  return (u.pathname === "/" || u.pathname === "") && !u.search && !u.hash;
}

/** Stored city is Oslo («Oslo», «oslo», «Oslo sentrum», «Oslo, Norge» …). */
export function isOsloCity(city: string | null | undefined): boolean {
  const c = String(city ?? "").trim().toLowerCase();
  return c === "oslo" || /^oslo[\s,]/.test(c);
}

/** lat/lng are the form's old hard-coded 59.91/10.75 (within COORD_TOLERANCE). */
export function hasFakeOsloCoords(lat: number | null | undefined, lng: number | null | undefined): boolean {
  if (typeof lat !== "number" || typeof lng !== "number") return false;
  return Math.abs(lat - FAKE_OSLO_LAT) <= COORD_TOLERANCE && Math.abs(lng - FAKE_OSLO_LNG) <= COORD_TOLERANCE;
}

/** Pure selection: the suspect self-registered rows, each with its reason(s). */
export function selectSuspectSelfRegistrations(rows: readonly SelfRegRow[]): SuspectRow[] {
  const out: SuspectRow[] = [];
  for (const r of rows) {
    if ((r.origin ?? "self_registered") !== "self_registered") continue;
    const reasons: SuspectReason[] = [];
    if (isOwnOriginUrl(r.url)) reasons.push("own_origin_url");
    if (hasFakeOsloCoords(r.lat, r.lng) && !isOsloCity(r.city)) reasons.push("oslo_coords_not_oslo");
    if (reasons.length === 0) continue;
    out.push({
      id: r.id,
      name: r.name,
      url: r.url,
      city: r.city,
      lat: r.lat,
      lng: r.lng,
      is_vetted: r.is_vetted ?? null,
      is_active: r.is_active ?? null,
      created_at: r.created_at ?? null,
      reasons,
    });
  }
  return out;
}

export interface SuspectReport {
  scanned: number;
  count: number;
  by_reason: Record<SuspectReason, number>;
  rows: SuspectRow[];
}

export function buildSuspectReport(rows: readonly SelfRegRow[]): SuspectReport {
  const suspects = selectSuspectSelfRegistrations(rows);
  return {
    scanned: rows.length,
    count: suspects.length,
    by_reason: {
      own_origin_url: suspects.filter((s) => s.reasons.includes("own_origin_url")).length,
      oslo_coords_not_oslo: suspects.filter((s) => s.reasons.includes("oslo_coords_not_oslo")).length,
    },
    rows: suspects,
  };
}

function main(): void {
  const argDb = process.argv.find((a) => a.startsWith("--db="));
  const dbPath = argDb
    ? argDb.slice("--db=".length)
    : process.env.DB_PATH || path.join(__dirname, "..", "data", "lokal.db");
  const asJson = process.argv.includes("--json");

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require("better-sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(
      `SELECT id, name, url, city, lat, lng, origin, is_vetted, is_active, created_at
         FROM agents
        WHERE origin = 'self_registered'
        ORDER BY created_at ASC, id ASC`,
    ).all() as SelfRegRow[];
    const report = buildSuspectReport(rows);
    if (asJson) {
      console.log(JSON.stringify({ db: dbPath, dry_run: true, ...report }, null, 2));
      return;
    }
    console.log(`DRY RUN (read-only) — ${dbPath}`);
    console.log(`Self-registered profiles scanned: ${report.scanned}`);
    console.log(`Suspect profiles: ${report.count} (own_origin_url: ${report.by_reason.own_origin_url}, oslo_coords_not_oslo: ${report.by_reason.oslo_coords_not_oslo})`);
    for (const r of report.rows) {
      console.log(
        `- ${r.id}  «${r.name}»  city=${r.city ?? "∅"}  lat/lng=${r.lat ?? "∅"}/${r.lng ?? "∅"}  url=${r.url || "∅"}  ` +
        `vetted=${r.is_vetted ?? "?"}  [${r.reasons.join(", ")}]`,
      );
    }
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main();
}
