// ─── dental-import-display — values only the May 2026 directory import gave ──
// A2A dev-request 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon, F2-S10
// (Daniel's choice B on question 32, 2026-10-19): no public surface shows a
// value that only the directory import of May 2026 gave. Nothing in the
// database changes; one switch turns it all back.
//
// (a) Rows without an org.nr. The rows the import added on its own have no
//     org_nr, no organisasjonsform and no naeringskode (all NULL or blank).
//     That is the entry of rule 4 in classifyDentalCatalogEntry
//     (dental-catalog-class.ts, no_brreg_metadata). The rule reads the columns
//     themselves, not catalog_class: rules 1-3 run before rule 4, and a row
//     never classified has catalog_class NULL. Such a row is not public at
//     all: every public query ANDs dentalPublicRowSql() (the SQL twin of
//     isImportOnlyRow, KEEP IN SYNC; dental-import-display.test.ts checks
//     that both pick the same rows), the profile 404s like a rejected row,
//     MCP tannlege_info answers «Klinikk ikke funnet.», and the raw REST
//     answer leaves it out without the admin key. Admin answers are as stored.
//
// (b) Rows with an org.nr. The import also filled empty adresse and
//     hjemmeside on some clinics with an org.nr. Which ones is only known from
//     the merge artefacts in A2A (the bulk insert stored no source per
//     field); src/data/dental-import-2026-05.json carries the result as
//     fields_by_org_nr (org.nr. -> column names, no values), read once.
//     importOnlyColumns() names the columns of a row that are hidden: in the
//     map for its org.nr., unless a real source confirms the stored value (a
//     field_provenance record that is not google_places and not an
//     inference source, with the same value once normalised: the
//     Corroboration of places-display-policy.ts), or, for hjemmeside, the
//     verifier found the clinic on the site (website_ownership 'verified').
//     dental-places-display.ts hiddenColumns() applies it, so every surface
//     that reads shownDentalAgent()/shownDentalFieldProvenance() follows.
//     Postnummer, poststed, map and coordinates stay. No public query
//     filters or counts on adresse or hjemmeside, so (b) has no SQL twin.
//
// Switch: IMPORT_VALUES_HIDDEN. Off (false) gives today's answers for (a)
// and (b), byte for byte; rollback is a one-line change here.

import * as fs from "fs";
import * as path from "path";
import { TRIM_CODE_POINTS } from "./dental-acute-claim";
import {
  fieldProvenanceRecords,
  isCorroboratingRecord,
  type PlacesDisplayField,
} from "./places-display-policy";

export const IMPORT_VALUES_HIDDEN = true;

let importValuesHiddenForTesting: boolean | null = null;

/** Test-only: act as if IMPORT_VALUES_HIDDEN were `on`; null restores it. Returns the override it replaced. */
export function __setImportValuesHiddenForTesting(on: boolean | null): boolean | null {
  const previous = importValuesHiddenForTesting;
  importValuesHiddenForTesting = on;
  return previous;
}

/** IMPORT_VALUES_HIDDEN, or the test override. Read per call. */
export function importValuesHidden(): boolean {
  return importValuesHiddenForTesting ?? IMPORT_VALUES_HIDDEN;
}

// ── (a) rows without an org.nr. ──────────────────────────────────────────

/** What rule (a) reads off a row. */
export interface ImportOnlyRowInput {
  org_nr?: unknown;
  organisasjonsform?: unknown;
  naeringskode?: unknown;
}

/** NULL, or a string with nothing but String.prototype.trim's blanks. */
function isBlankColumn(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/**
 * The row is one the import added on its own: org_nr, organisasjonsform and
 * naeringskode are all NULL or blank. The definition alone, without the
 * switch. KEEP IN SYNC with DENTAL_IMPORT_ONLY_ROW_SQL.
 */
export function isImportOnlyRow(row: ImportOnlyRowInput): boolean {
  return isBlankColumn(row.org_nr) && isBlankColumn(row.organisasjonsform) && isBlankColumn(row.naeringskode);
}

/** Whether a public surface leaves the row out: the switch is on and the row is (a). */
export function isHiddenImportRow(row: ImportOnlyRowInput, enabled: boolean = importValuesHidden()): boolean {
  return enabled && isImportOnlyRow(row);
}

// A column that is NULL or blank once trimmed of the same blanks as JS trim
// (TRIM_CODE_POINTS, as the akutt and Helfo twins use).
const blankSql = (column: string): string =>
  `(${column} IS NULL OR trim(${column}, char(${TRIM_CODE_POINTS.join(", ")})) = '')`;

/** The SQL twin of isImportOnlyRow, over the bare dental_agents columns. */
export const DENTAL_IMPORT_ONLY_ROW_SQL = `(${blankSql("org_nr")} AND ${blankSql("organisasjonsform")} AND ${blankSql("naeringskode")})`;

/** The public-row clause with the switch on: not a row of (a). */
export const DENTAL_PUBLIC_ROW_SQL = `NOT ${DENTAL_IMPORT_ONLY_ROW_SQL}`;

/**
 * The clause every public query in dental-store.ts ANDs: DENTAL_PUBLIC_ROW_SQL
 * while the switch is on, "1" (every row) while it is off. Read per call, so
 * the test override applies.
 */
export function dentalPublicRowSql(enabled: boolean = importValuesHidden()): string {
  return enabled ? DENTAL_PUBLIC_ROW_SQL : "1";
}

// ── (b) adresse and hjemmeside on rows with an org.nr. ───────────────────

export type ImportColumn = "adresse" | "hjemmeside";

const IMPORT_COLUMNS: ReadonlyArray<{ column: ImportColumn; field: PlacesDisplayField; provenanceKeys: readonly string[] }> = [
  { column: "adresse", field: "address", provenanceKeys: ["adresse", "address"] },
  { column: "hjemmeside", field: "website", provenanceKeys: ["hjemmeside", "website"] },
];

const DATA_FILE = path.join(__dirname, "..", "data", "dental-import-2026-05.json");

let importFieldsByOrgNr: Map<string, ReadonlySet<ImportColumn>> | null = null;

/** The 9 digits of an org.nr. as stored («912 345 678» too), or "". */
function orgNrDigits(orgNr: unknown): string {
  if (typeof orgNr !== "string" && typeof orgNr !== "number") return "";
  const digits = String(orgNr).replace(/\D/g, "");
  return digits.length === 9 ? digits : "";
}

/**
 * fields_by_org_nr of the data file, loaded once. A missing or broken file
 * gives an empty map (a warning, never a crash), as norway-postnummer.ts
 * does; dental-import-display.test.ts checks the file is read.
 */
export function importFieldsMap(): ReadonlyMap<string, ReadonlySet<ImportColumn>> {
  if (importFieldsByOrgNr) return importFieldsByOrgNr;
  const map = new Map<string, ReadonlySet<ImportColumn>>();
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    const fields = parsed?.fields_by_org_nr;
    if (fields && typeof fields === "object" && !Array.isArray(fields)) {
      for (const [orgNr, columns] of Object.entries(fields)) {
        if (!/^\d{9}$/.test(orgNr) || !Array.isArray(columns)) continue;
        const set = new Set(columns.filter((c): c is ImportColumn => c === "adresse" || c === "hjemmeside"));
        if (set.size > 0) map.set(orgNr, set);
      }
    }
  } catch (err) {
    console.warn(
      "[dental-import-display] failed to load dental-import-2026-05.json, no import column is hidden:",
      err instanceof Error ? err.message : err,
    );
  }
  importFieldsByOrgNr = map;
  return map;
}

/** What rule (b) reads off a clinic row. */
export interface ImportColumnsRow {
  org_nr?: string | null;
  adresse?: string | null;
  hjemmeside?: string | null;
  field_provenance?: unknown;
  website_ownership?: string | null;
}

/** A blank stored value has nothing to hide. */
function hasValue(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * The columns (adresse, hjemmeside) of a row with an org.nr. whose stored
 * value only the import gave and nothing has confirmed since; [] with the
 * switch off, for an org.nr. outside the map, and for a blank value.
 * Confirmed: a field_provenance record under the column's keys from a real
 * source with the same normalised value (isCorroboratingRecord), or for
 * hjemmeside website_ownership 'verified'.
 */
export function importOnlyColumns(row: ImportColumnsRow, enabled: boolean = importValuesHidden()): ImportColumn[] {
  if (!enabled) return [];
  const orgNr = orgNrDigits(row.org_nr);
  if (!orgNr) return [];
  const columns = importFieldsMap().get(orgNr);
  if (!columns) return [];
  const hidden: ImportColumn[] = [];
  for (const { column, field, provenanceKeys } of IMPORT_COLUMNS) {
    if (!columns.has(column)) continue;
    const value = row[column];
    if (!hasValue(value)) continue;
    if (column === "hjemmeside" && row.website_ownership === "verified") continue;
    const records = fieldProvenanceRecords(row.field_provenance, provenanceKeys);
    if (records.some((r) => isCorroboratingRecord(field, value, r))) continue;
    hidden.push(column);
  }
  return hidden;
}
