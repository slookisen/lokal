// ─── Fylke 2024-migrasjon: resolve a stale 2020-era fylke value to its ──────
// correct 2024-era successor ─────────────────────────────────────────────
//
// dev-request 2026-08-07-orch-fylke-2024-migrasjon. Norway's fylke (county)
// model changed again in 2024: three 2020-era merged fylker split back into
// six —
//   Viken                → Akershus / Buskerud / Østfold
//   Vestfold og Telemark  → Vestfold / Telemark
//   Troms og Finnmark     → Troms / Finnmark
//
// opplevagent's `experiences`/`experience_providers` rows can still carry
// one of those three stale 2020-era names in their `fylke` column (rows
// written before the app picked up the 2024 split, sitting alongside
// already-correct 2024-era rows). This module resolves ONE row's correct
// 2024 fylke, given whatever location data that row actually has —
// `kommunenummer` (preferred, exact) or a free-text `kommune` name
// (fallback, normalized+matched) — using the vendored SSB kommune→fylke
// table (src/data/kommune-fylke-2024.json, verbatim from
// protocols/kommune-fylke-2024.csv, 357 rows, 2024-01-01 kommune-inndeling).
//
// Pure function, no DB access, no writes — routes/opplevelser.ts's
// POST /api/opplevelser/admin/fylke-2024-migration is the caller that reads
// rows, calls this, and (on apply:true) writes the resolved fylke + audits
// the write. This module NEVER guesses: any kommunenummer not present in
// the vendored table, or any kommune name that resolves to zero OR more
// than one kommune, is reported via `needs_review` instead of a fylke guess.

import * as fs from "fs";
import * as path from "path";
import { key as fylkeKey } from "./norway-fylke";

export interface KommuneFylke2024Row {
  kommunenummer: string;
  kommunenavn: string;
  fylkesnummer: string;
  fylkesnavn: string;
}

export type ResolveFylke2024Result = { fylke: string } | { needs_review: string };

const DATA_FILE = path.join(__dirname, "..", "data", "kommune-fylke-2024.json");

let cache: KommuneFylke2024Row[] | null = null;

function loadRows(): KommuneFylke2024Row[] {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    cache = Array.isArray(parsed) ? (parsed as KommuneFylke2024Row[]) : [];
  } catch (err) {
    // Fail-safe, mirrors local-orgnr-candidates.ts's loadRecords() convention:
    // a missing/corrupt vendored file must never crash the migration route —
    // every lookup just degrades to "not found" -> needs_review, never a
    // guess.
    console.warn(
      "[fylke-2024-migration] failed to load vendored kommune-fylke-2024.json, all lookups will report needs_review:",
      err instanceof Error ? err.message : err,
    );
    cache = [];
  }
  return cache;
}

/** Test-only: inject a small fixture set instead of the real 357-row file, or reset to force a fresh disk read. */
export function __setKommuneFylke2024RowsForTesting(rows: KommuneFylke2024Row[] | null): void {
  cache = rows;
}

// The vendored CSV (SSB convention) disambiguates the table's two genuine
// duplicate kommune-navn pairs with a trailing " (<fylke>)" qualifier —
// "Herøy (Møre og Romsdal)" vs "Herøy (Nordland)", "Våler (Østfold)" vs
// "Våler (Innlandet)" — that a real DB `kommune` free-text column (typically
// written from a geocoder or manual entry) would never itself carry. Stripped
// BEFORE the key()-fold below so a bare "Herøy"/"Våler" query collides with
// BOTH rows (correctly ambiguous -> needs_review) instead of matching
// neither (0 matches — also needs_review, but for the wrong, coincidental
// reason, and fragile the moment a THIRD same-named kommune is ever added).
function stripKommuneDisambiguator(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "");
}

// Reuses norway-fylke.ts's exact key() fold/normalize convention (lowercase,
// æ/ø/å + a few other diacritics transliterated, non-alphanumeric stripped)
// — intentionally the SAME transformation as normaliseFylke()'s own internal
// key(), imported directly rather than re-implemented, so this module can
// never silently drift from that convention.
function kommuneKey(name: string): string {
  return fylkeKey(stripKommuneDisambiguator(name));
}

// Kommuner the vendored table lists ONLY under their Sami primary name — the
// everyday Norwegian name a geocoder/manual `kommune` entry would typically
// carry instead. 1:1, unambiguous (unlike Herøy/Våler) — safe to fold in
// before the name-match below. Source: 2026-08-07 fylke-2024-migration
// close-out residual analysis (grep on the source CSV confirmed no Norwegian-
// name entry exists for these three).
const KOMMUNE_NAME_ALIASES: Record<string, string> = {
  [kommuneKey("Kåfjord")]: kommuneKey("Gáivuotna"),
  [kommuneKey("Karasjok")]: kommuneKey("Kárášjohka"),
  [kommuneKey("Kautokeino")]: kommuneKey("Guovdageaidnu"),
};

/**
 * resolveFylke2024(opts) — resolve the correct 2024-era fylke for one row,
 * given whatever location data it carries. Never guesses:
 *
 *   - kommunenummer given: exact lookup against the vendored table's
 *     `kommunenummer` field. Found -> {fylke}. Not found ->
 *     {needs_review: "kommunenummer_not_found:<value>"}.
 *   - else kommune (name) given: normalized (kommuneKey) and matched against
 *     the vendored table's kommunenavn (also normalized). Exactly one match
 *     -> {fylke}. Zero or more than one match ->
 *     {needs_review: "ambiguous_or_unknown_kommune:<value>"} — this is where
 *     the two real vendored-table name collisions (Herøy, Våler) land.
 *   - neither given (or both blank/null) -> {needs_review: "no_kommune_data"}.
 */
export function resolveFylke2024(opts: {
  kommunenummer?: string | null;
  kommune?: string | null;
}): ResolveFylke2024Result {
  const kommunenummer = typeof opts.kommunenummer === "string" ? opts.kommunenummer.trim() : "";
  const kommune = typeof opts.kommune === "string" ? opts.kommune.trim() : "";

  if (kommunenummer) {
    const rows = loadRows();
    const hit = rows.find((r) => r && typeof r.kommunenummer === "string" && r.kommunenummer.trim() === kommunenummer);
    if (hit) return { fylke: hit.fylkesnavn };
    return { needs_review: `kommunenummer_not_found:${kommunenummer}` };
  }

  if (kommune) {
    const rows = loadRows();
    let qKey = kommuneKey(kommune);
    if (!qKey) return { needs_review: "no_kommune_data" };
    // Fold a Norwegian name onto its Sami-primary-name counterpart (the form
    // actually present in the vendored table) BEFORE matching — see
    // KOMMUNE_NAME_ALIASES above.
    if (qKey in KOMMUNE_NAME_ALIASES) qKey = KOMMUNE_NAME_ALIASES[qKey];
    const matches = rows.filter((r) => r && typeof r.kommunenavn === "string" && kommuneKey(r.kommunenavn) === qKey);
    // Exactly one row-name-key match -> resolved. Zero (unknown kommune) or
    // more than one (a genuine vendored-table name collision, e.g. Herøy /
    // Våler — see stripKommuneDisambiguator's doc comment) -> needs_review.
    // Never picks a "best" match among 2+ — that would be guessing.
    if (matches.length === 1) return { fylke: matches[0].fylkesnavn };
    return { needs_review: `ambiguous_or_unknown_kommune:${kommune}` };
  }

  return { needs_review: "no_kommune_data" };
}
