// ─── Postnummer -> kommune (read-only, bundled open data) ───────────────────
//
// dev-request 2026-10-16-tannlege-sok-naturlig-sprak (S1). dental_agents has
// postnummer/poststed/fylke but no kommune column, so a kommune that is not
// itself a poststed (Bærum, Kristiansand, Øygarden …) can only be searched
// through its postnumre. This module answers both directions from a static
// file and never touches a database.
//
// Data: src/data/postnummer-kommune-2026.json
//   Source:  Kartverket / Geonorge "Postnummerområder" (opphav Posten
//            Norge/Kartverket), dataset 462a5297-33ef-438a-82a5-07fff5799be3,
//            national GeoJSON (EPSG:4258), extract 2026-09-29, fetched
//            2026-10-16. Fields used per area: postnummer, poststed, kommune.
//   Licence: CC BY 4.0 — "Inneholder data under norsk lisens CC BY 4.0 fra
//            Kartverket". The same source/licence is in the file's `meta`.
//   Shape:   one row per postnummer (every area of a postnummer carries the
//            same kommune in the source). Postbox-only postnumre are not part
//            of the open dataset; Svalbard (2100) and Jan Mayen (2211) are
//            left out because they are not kommuner in the 2024 table.
//   Refresh: yearly (meta.fetched_at shows the age): download the same file,
//            keep postnummer/poststed/kommune, drop rows whose kommunenummer
//            is not in kommune-fylke-2024.json. norway-postnummer.test.ts
//            fails if any kommunenummer is unknown to that table.
//
// Kommune names and fylker come from the vendored 2024 kommune table through
// fylke-2024-migration.ts (isKnownKommunenummer, resolveFylke2024,
// kommune2024DisplayName); no second kommune table exists. The file is read
// lazily, once, on first use — never at import time and never per request.
// An unknown postnummer is reported as needs_review; this module never guesses.

import * as fs from "fs";
import * as path from "path";
import { isKnownKommunenummer, kommune2024DisplayName, resolveFylke2024 } from "./fylke-2024-migration";

export interface PostnummerRow {
  postnummer: string;
  poststed: string;
  kommunenummer: string;
}

export interface PostnummerDatasetMeta {
  source: string;
  license: string;
  fetched_at: string;
  kommune_basis: string;
  [key: string]: unknown;
}

export type ResolveKommuneFromPostnummerResult =
  | { kommunenummer: string; kommune: string; fylke: string }
  | { needs_review: string };

const DATA_FILE = path.join(__dirname, "..", "data", "postnummer-kommune-2026.json");
// Same vendored file fylke-2024-migration.ts reads; only kommunenummer ->
// kommunenavn is taken from it here (that module has no lookup by number).
const KOMMUNE_FILE = path.join(__dirname, "..", "data", "kommune-fylke-2024.json");

interface Loaded {
  meta: PostnummerDatasetMeta | null;
  byPostnummer: Map<string, PostnummerRow>;
  byKommune: Map<string, string[]>;
}

let loaded: Loaded | null = null;
let kommuneNames: Map<string, string> | null = null;

function load(): Loaded {
  if (loaded) return loaded;
  let rows: PostnummerRow[] = [];
  let meta: PostnummerDatasetMeta | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    meta = parsed?.meta ?? null;
  } catch (err) {
    // Same fail-safe as fylke-2024-migration.ts loadRows(): a missing or
    // corrupt file degrades every lookup to needs_review, never a crash.
    console.warn(
      "[norway-postnummer] failed to load postnummer-kommune-2026.json, all lookups will report needs_review:",
      err instanceof Error ? err.message : err,
    );
  }
  loaded = index(rows, meta);
  return loaded;
}

function index(rows: PostnummerRow[], meta: PostnummerDatasetMeta | null): Loaded {
  const byPostnummer = new Map<string, PostnummerRow>();
  const byKommune = new Map<string, string[]>();
  for (const r of rows) {
    if (!r || typeof r.postnummer !== "string" || typeof r.kommunenummer !== "string") continue;
    byPostnummer.set(r.postnummer, r);
    const list = byKommune.get(r.kommunenummer);
    if (list) list.push(r.postnummer);
    else byKommune.set(r.kommunenummer, [r.postnummer]);
  }
  for (const list of byKommune.values()) list.sort();
  return { meta, byPostnummer, byKommune };
}

function kommuneNameFor(kommunenummer: string): string | null {
  if (!kommuneNames) {
    kommuneNames = new Map();
    try {
      const rows = JSON.parse(fs.readFileSync(KOMMUNE_FILE, "utf-8"));
      for (const r of Array.isArray(rows) ? rows : []) {
        if (r && typeof r.kommunenummer === "string" && typeof r.kommunenavn === "string") {
          kommuneNames.set(r.kommunenummer, kommune2024DisplayName(r.kommunenavn));
        }
      }
    } catch {
      /* resolveFylke2024 already warns about this file; lookups report needs_review */
    }
  }
  return kommuneNames.get(kommunenummer) ?? null;
}

/**
 * The kommune a postnummer belongs to: {kommunenummer, kommune, fylke}, or
 * {needs_review} for a malformed or unknown postnummer, or a kommunenummer
 * the 2024 kommune table does not know.
 */
export function resolveKommuneFromPostnummer(pnr: string): ResolveKommuneFromPostnummerResult {
  const value = typeof pnr === "string" ? pnr.trim() : "";
  if (!/^\d{4}$/.test(value)) return { needs_review: `postnummer_invalid:${value}` };
  const row = load().byPostnummer.get(value);
  if (!row) return { needs_review: `postnummer_not_found:${value}` };
  const kommune = isKnownKommunenummer(row.kommunenummer) ? kommuneNameFor(row.kommunenummer) : null;
  const fylke = resolveFylke2024({ kommunenummer: row.kommunenummer });
  if (!kommune || !("fylke" in fylke)) return { needs_review: `kommunenummer_not_found:${row.kommunenummer}` };
  return { kommunenummer: row.kommunenummer, kommune, fylke: fylke.fylke };
}

/** Every postnummer in a kommune, sorted; [] for an unknown kommunenummer. */
export function postnumreForKommune(kommunenummer: string): string[] {
  return [...(load().byKommune.get((kommunenummer || "").trim()) ?? [])];
}

/** Kommuner that have at least one postnummer, with their display names. */
export function kommuner2024(): Array<{ kommunenummer: string; kommune: string }> {
  const out: Array<{ kommunenummer: string; kommune: string }> = [];
  for (const nr of load().byKommune.keys()) {
    const kommune = kommuneNameFor(nr);
    if (kommune) out.push({ kommunenummer: nr, kommune });
  }
  return out;
}

/** Distinct official poststed names (as Posten writes them, upper case). */
export function officialPoststeder(): string[] {
  const names = new Set<string>();
  for (const r of load().byPostnummer.values()) if (r.poststed) names.add(r.poststed);
  return [...names];
}

/** The file's `meta` block (source, licence, fetched_at, kommune_basis). */
export function postnummerDatasetMeta(): PostnummerDatasetMeta | null {
  return load().meta;
}

/** Test-only: inject rows instead of the bundled file, or null to re-read it. */
export function __setPostnummerRowsForTesting(rows: PostnummerRow[] | null): void {
  loaded = rows ? index(rows, null) : null;
}
