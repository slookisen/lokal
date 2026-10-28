// ─── POST /admin/dental/brreg-address-sweep ─────────────────────────────────
//
// dev-request 2026-09-02-dental-hjemmeside-hygiene-og-brreg-gjenfinning
// (steg 2b of the 2026-09-02 dental pipeline review).
//
// WHY: 4 522 of 6 975 dental_agents rows have no street address, because the
// Phase-A Brreg import (A2A dental-phase-a/A1-brreg-summary.csv) carried
// postnummer/poststed but no adresse column -- even though Brreg's
// Enhetsregisteret has a forretningsadresse (or postadresse) for every
// org_nr. This sweep asks Brreg directly -- free, no key, GET
// /enheter/{orgNr} plus GET /underenheter?overordnetEnhet={orgNr}, wrapped
// by fetchBrregAddressEvidence() (services/brreg-client.ts) -- and
// FILL-ONLY writes adresse (and postnummer/poststed when those are empty).
//
// dev-request 2026-10-21-dental-brreg-adresse-feil-for-videre-sweep, with
// Daniel's answer after filing (it replaces spec point 1):
//   1. Best address, the same rule for every organisation form:
//        (a) an active sub-unit's beliggenhetsadresse;
//        (b) a Brreg address that another clinic row or the clinic's own
//            website supports (a clinic row whose own address came from a
//            Brreg write does not count as support);
//        (c) the forretningsadresse, as before.
//      The postadresse is used only when it is a street address (never a
//      postbox). field_provenance records which basis was used.
//   2. Whole address from one source: street, postnummer and poststed come
//      from the same Brreg sub-object. A stored postnummer (or, with no
//      postnummer, a stored poststed) that differs from it means nothing is
//      written and the row is flagged.
//   3. Units under liquidation, bankrupt or deleted, and addresses outside
//      Norway, are skipped and flagged.
//   4. Several distinct active sub-unit addresses are narrowed by the stored
//      postnummer; still ambiguous means skipped and flagged.
//   5. results[] has one entry per row: id, status, outcome, fields written,
//      address source and basis, flag. Never the address or the name.
//      field_provenance records carry address_source and address_basis for
//      every field written (address, postnummer, poststed).
//
// Correction mode (body.mode = "correct_mixed"): finds rows whose street
// came from a Brreg write (latest address provenance record has
// source_type "brreg" and is the stored street) while the stored postnummer
// does not match the Brreg address with that street (a poststed-only
// difference is reported and flagged, never written; a unit abroad or not
// active is flagged). Dry run by default; it changes rows only with
// body.apply === true (strict boolean; any other apply value is a 400).
// Applying sets postnummer, and poststed only when it differs too, from that
// same Brreg address and clears lat/lng/geocode_* so the geocode worker
// redoes them.
//
// Correction mode, runde 5 (Daniel's answer of 2026-10-26 on the review):
//   - correct_mixed runs chooseAddress (rule 1) first. A row is corrected
//     only when the address rule 1 picks is the same Brreg sub-object the
//     stored street came from. When an active sub-unit's
//     beliggenhetsadresse is preferred and its street (or postnummer) is
//     not the stored one, the row gets flag_sub_unit_preferred; several
//     active sub-unit addresses that the stored postnummer does not narrow
//     to one give flag_ambiguous_sub_units. Neither writes, even on apply.
//   - The UPDATE also sets fylke from resolveKommuneFromPostnummer(<new
//     postnummer>) (2024 fylke names, as the search filters expect); a
//     postnummer the register does not resolve leaves fylke alone and adds
//     the flag fylke_not_resolved. Results report fylke_change {from, to}
//     and the summary counts fylke_changes.
//   - Every results[] entry carries org_form (Brreg organisasjonsform code).
//
// Other guard rails (unchanged):
//   - fill-only (sweep mode): never overwrites a non-empty adresse/
//     postnummer/poststed; the UPDATE re-checks all three at write time.
//   - catalog_class-aware: only rows the classifier left as a clinic
//     (DENTAL_CLINIC_CLASS_SQL) and not is_inactive / rejected.
//   - no-retry marker brreg_address_attempted_at (sweep mode): a row that got
//     a definite answer is stamped and not re-asked for
//     BRREG_ADDRESS_NO_RETRY_DAYS days. A transport failure is NOT stamped.
//   - hard cap BRREG_ADDRESS_SWEEP_CAP rows per call, sequential requests,
//     dry-run by default (a dry run writes nothing, stamps included).

import { Router, Request, Response } from "express";
import { getDb } from "../database/db-factory";
import {
  fetchBrregAddressEvidence,
  type BrregAddressEvidence,
  type BrregAddressSource,
  type BrregStructuredAddress,
} from "../services/brreg-client";
import { DENTAL_CLINIC_CLASS_SQL } from "../services/dental-catalog-class";
import { classifyHjemmeside } from "../services/dental-hjemmeside-classifier";
import { fetchPage, DEFAULT_FETCH_TIMEOUT_MS } from "../services/fetch-page";
import { resolveKommuneFromPostnummer } from "../services/norway-postnummer";

function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

function requireAdmin(req: Request, res: Response): boolean {
  const expected = getAdminKey();
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (provided !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

export const BRREG_ADDRESS_SWEEP_CAP = 100;
export const BRREG_ADDRESS_NO_RETRY_DAYS = 90;
const SWEEP_USER_AGENT = "finn-tannlege.com address check (orchestrator@rettfrabonden.com)";

// Injectable fetch seam (Brreg + the clinic website), same convention as
// admin-dental-hjemmeside-discovery.ts's __setDentalWdFetchForTesting:
// tests never swap globalThis.fetch.
let sweepFetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => fetch(...args);
export function __setBrregAddressSweepFetchForTesting(impl?: typeof fetch): void {
  sweepFetchImpl = impl || ((...args: Parameters<typeof fetch>) => fetch(...args));
}

// Test-only hook run between the read and the UPDATE of a row, so a test can
// play "another writer changed the row meanwhile". Production leaves it null.
let beforeWriteHookForTesting: ((id: string) => void) | null = null;
export function __setBrregAddressSweepBeforeWriteForTesting(hook: ((id: string) => void) | null): void {
  beforeWriteHookForTesting = hook;
}

interface SweepRow {
  id: string;
  org_nr: string;
  postnummer: string | null;
  poststed: string | null;
  hjemmeside: string | null;
  field_provenance: string | null;
}

/** Which rule picked the address (field_provenance.address_basis). */
export type AddressBasis = "beliggenhetsadresse" | "other_clinic_row" | "own_website" | "forretningsadresse" | "postadresse";

export type SweepOutcome =
  | "write_address"            // street (+ empty postnummer/poststed) from one Brreg address
  | "postnummer_mismatch"      // stored postnummer differs from the Brreg address (flagged)
  | "poststed_mismatch"        // no stored postnummer, stored poststed differs (flagged)
  | "incomplete_address"       // Brreg address lacks postnummer or poststed (flagged)
  | "under_liquidation"        // (flagged)
  | "bankrupt"                 // (flagged)
  | "deleted"                  // (flagged)
  | "foreign_address"          // (flagged)
  | "ambiguous_sub_units"      // several active sub-unit addresses, none singled out (flagged)
  | "no_address"               // Brreg has no usable street line
  | "not_found"                // Brreg has no unit with this org.nr
  | "changed_meanwhile"        // write re-check failed: another writer changed a field
  | "api_error";

export interface SweepResult {
  id: string;
  status: "written" | "would_write" | "skipped" | "no_address" | "api_error";
  outcome: SweepOutcome;
  fields_written: string[];
  address_source?: BrregAddressSource;
  address_basis?: AddressBasis;
  flagged: boolean;
}

export function candidateWhereSql(): string {
  return `org_nr IS NOT NULL AND org_nr <> ''
    AND (adresse IS NULL OR adresse = '')
    AND (is_inactive IS NULL OR is_inactive = 0)
    AND (verification_status IS NULL OR verification_status <> 'rejected')
    AND ${DENTAL_CLINIC_CLASS_SQL}
    AND (brreg_address_attempted_at IS NULL
         OR brreg_address_attempted_at < datetime('now', '-${BRREG_ADDRESS_NO_RETRY_DAYS} days'))`;
}

function parseProv(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** The newest provenance record for a field, or null. */
function latestProv(prov: Record<string, unknown>, field: string): Record<string, unknown> | null {
  const arr = prov[field];
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const last = arr[arr.length - 1];
  return last && typeof last === "object" ? (last as Record<string, unknown>) : null;
}

// Additive provenance merge for one field: append a record to the field's
// array without touching other fields.
function appendProv(prov: Record<string, unknown>, field: string, record: Record<string, unknown>): void {
  const existing = Array.isArray(prov[field]) ? (prov[field] as unknown[]) : [];
  prov[field] = [...existing, record];
}

const blank = (v: string | null | undefined): boolean => !v || v.trim() === "";

/** Lowercase, Norwegian letters folded, punctuation dropped, spaces collapsed. */
export function normaliseStreet(s: string | null | undefined): string {
  return (s || "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A stored adresse sometimes carries ", 0155 Oslo"; keep the street part. */
function streetPart(stored: string): string {
  return stored.replace(/,?\s*\d{4}\s+[^,]*$/u, "");
}

function isNorwegian(a: BrregStructuredAddress | null): boolean {
  if (!a) return true;
  if (a.landkode && a.landkode.toUpperCase() !== "NO") return false;
  if (a.land && normaliseStreet(a.land) !== "norge") return false;
  return true;
}

const isPostbox = (street: string | null): boolean => !!street && /^(postboks|pb\.?|boks)\s*\d/i.test(street.trim());
const isStreet = (a: BrregStructuredAddress | null): a is BrregStructuredAddress => !!a && !!a.adresse && !isPostbox(a.adresse);

const addressKey = (a: BrregStructuredAddress): string => `${normaliseStreet(a.adresse)}|${a.postnummer ?? ""}`;

type FoundEvidence = Extract<BrregAddressEvidence, { kind: "found" }>;

export type Candidate = { address: BrregStructuredAddress; source: BrregAddressSource };

type Choice =
  | { kind: "sub_unit"; candidate: Candidate }
  | { kind: "registered"; candidates: Candidate[] } // forretningsadresse first, then a street postadresse
  | { kind: "none" }
  | { kind: "ambiguous" }
  | { kind: "foreign" };

/** Rules 1a/1c and spec 3-4, without the support check (that needs the DB/web). */
export function chooseAddress(
  ev: Pick<FoundEvidence, "forretningsadresse" | "postadresse" | "activeSubUnits">,
  storedPostnummer: string | null,
): Choice {
  // A unit registered abroad (NUF with a foreign forretningsadresse) is
  // skipped even when it also has a Norwegian postadresse or sub-unit.
  if (ev.forretningsadresse && !isNorwegian(ev.forretningsadresse)) return { kind: "foreign" };

  const distinct = new Map<string, BrregStructuredAddress>();
  for (const s of ev.activeSubUnits) {
    if (isStreet(s.address)) distinct.set(addressKey(s.address), s.address);
  }
  if (distinct.size > 0) {
    let pool = [...distinct.values()];
    if (pool.length > 1 && !blank(storedPostnummer)) {
      pool = pool.filter((a) => a.postnummer === storedPostnummer!.trim());
    }
    if (pool.length !== 1) return { kind: "ambiguous" };
    if (!isNorwegian(pool[0])) return { kind: "foreign" };
    return { kind: "sub_unit", candidate: { address: pool[0], source: "beliggenhetsadresse" } };
  }

  const candidates: Candidate[] = [];
  if (isStreet(ev.forretningsadresse)) candidates.push({ address: ev.forretningsadresse, source: "forretningsadresse" });
  if (isStreet(ev.postadresse) && isNorwegian(ev.postadresse)) {
    const dup = candidates.some((c) => addressKey(c.address) === addressKey(ev.postadresse!));
    if (!dup) candidates.push({ address: ev.postadresse, source: "postadresse" });
  }
  return candidates.length > 0 ? { kind: "registered", candidates } : { kind: "none" };
}

/** Strip tags/entities from a page and normalise it the same way as a street. */
function pageText(html: string): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&aring;/gi, "å").replace(/&oslash;/gi, "ø").replace(/&aelig;/gi, "æ")
    .replace(/&amp;/gi, "&");
  return ` ${normaliseStreet(text)} `;
}

/** The clinic's own website text, or null when there is none to read. */
async function ownWebsiteText(hjemmeside: string | null): Promise<string | null> {
  if (blank(hjemmeside) || classifyHjemmeside(hjemmeside).isBad) return null;
  const r = await fetchPage(hjemmeside!.trim(), {
    userAgent: SWEEP_USER_AGENT,
    timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
    fetchImpl: sweepFetchImpl,
  });
  return r.ok ? pageText(r.html) : null;
}

function pageNames(text: string, a: BrregStructuredAddress): boolean {
  const street = normaliseStreet(a.adresse);
  return street !== "" && !!a.postnummer && text.includes(` ${street} `) && text.includes(` ${a.postnummer} `);
}

const router = Router();

// POST /admin/dental/brreg-address-sweep
// Body (sweep, default):   { write?: boolean (default false), limit?: number (default 25, cap 100) }
// Body (correction mode):  { mode: "correct_mixed", apply?: boolean (strict, default false),
//                            limit?: number, after_id?: string }
router.post("/brreg-address-sweep", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.mode !== undefined && body.mode !== "sweep" && body.mode !== "correct_mixed") {
    res.status(400).json({ error: "mode må være \"sweep\" eller \"correct_mixed\"" });
    return;
  }
  if (body.mode === "correct_mixed") {
    await correctMixed(body, res);
    return;
  }
  try {
    const write = body.write === true;
    const limitRaw = typeof body.limit === "number" && Number.isFinite(body.limit) ? Math.floor(body.limit) : 25;
    const limit = Math.max(1, Math.min(BRREG_ADDRESS_SWEEP_CAP, limitRaw));

    const db = getDb("dental");
    const remaining = (db
      .prepare(`SELECT COUNT(*) AS n FROM dental_agents WHERE ${candidateWhereSql()}`)
      .get() as { n: number }).n;
    const rows = db
      .prepare(
        `SELECT id, org_nr, postnummer, poststed, hjemmeside, field_provenance
           FROM dental_agents WHERE ${candidateWhereSql()}
          ORDER BY (hjemmeside IS NOT NULL AND hjemmeside <> '') DESC, navn ASC, id ASC
          LIMIT ?`,
      )
      .all(limit) as SweepRow[];

    const nowIso = new Date().toISOString();
    const stampAttempt = db.prepare("UPDATE dental_agents SET brreg_address_attempted_at = ? WHERE id = ?");
    // Other clinic rows (rule 1b) with a street at the same postnummer; the
    // street itself is compared in JS after normalising.
    const sameAreaClinics = db.prepare(
      `SELECT adresse, field_provenance FROM dental_agents
        WHERE id <> ? AND TRIM(postnummer) = ? AND adresse IS NOT NULL AND adresse <> ''
          AND (is_inactive IS NULL OR is_inactive = 0)
          AND (verification_status IS NULL OR verification_status <> 'rejected')
          AND ${DENTAL_CLINIC_CLASS_SQL}`,
    );
    const clinicRowSupports = (id: string, a: BrregStructuredAddress): boolean => {
      if (!a.postnummer) return false;
      const street = normaliseStreet(a.adresse);
      const others = sameAreaClinics.all(id, a.postnummer) as Array<{ adresse: string; field_provenance: string | null }>;
      return others.some((o) => {
        if (normaliseStreet(streetPart(o.adresse)) !== street) return false;
        // A row whose own street came from a Brreg write repeats Brreg; it
        // is not a second source.
        return latestProv(parseProv(o.field_provenance), "address")?.source_type !== "brreg";
      });
    };

    const results: SweepResult[] = [];
    const counts = { found: 0, written: 0, no_address: 0, api_error: 0, skipped: 0, flagged: 0 };

    const finish = (r: SweepResult, stamp: boolean): void => {
      if (stamp && write) stampAttempt.run(nowIso, r.id);
      if (r.flagged) counts.flagged++;
      if (r.status === "skipped") counts.skipped++;
      results.push(r);
    };
    const skip = (id: string, outcome: SweepOutcome, extra: Partial<SweepResult> = {}): SweepResult => ({
      id, status: "skipped", outcome, fields_written: [], flagged: true, ...extra,
    });

    for (const row of rows) {
      const ev = await fetchBrregAddressEvidence(row.org_nr, sweepFetchImpl);
      if (ev.kind === "error") {
        counts.api_error++;
        finish({ id: row.id, status: "api_error", outcome: "api_error", fields_written: [], flagged: false }, false);
        continue;
      }
      if (ev.kind === "not_found") {
        counts.no_address++;
        finish({ id: row.id, status: "no_address", outcome: "not_found", fields_written: [], flagged: false }, true);
        continue;
      }

      // Spec 3: status before anything else.
      const statusOutcome: SweepOutcome | null = ev.slettet
        ? "deleted"
        : ev.konkurs
          ? "bankrupt"
          : ev.underAvvikling
            ? "under_liquidation"
            : null;
      if (statusOutcome) {
        finish(skip(row.id, statusOutcome), true);
        continue;
      }

      const choice = chooseAddress(ev, row.postnummer);
      if (choice.kind === "foreign") {
        finish(skip(row.id, "foreign_address"), true);
        continue;
      }
      if (choice.kind === "ambiguous") {
        finish(skip(row.id, "ambiguous_sub_units"), true);
        continue;
      }
      if (choice.kind === "none") {
        counts.no_address++;
        finish({ id: row.id, status: "no_address", outcome: "no_address", fields_written: [], flagged: false }, true);
        continue;
      }

      // Rule 1: sub-unit, else a supported registered address, else the first
      // registered one (forretningsadresse, else a street postadresse).
      let picked: Candidate;
      let basis: AddressBasis;
      if (choice.kind === "sub_unit") {
        picked = choice.candidate;
        basis = "beliggenhetsadresse";
      } else {
        const cands = choice.candidates;
        let supported: { c: Candidate; basis: AddressBasis } | null = null;
        for (const c of cands) {
          if (clinicRowSupports(row.id, c.address)) {
            supported = { c, basis: "other_clinic_row" };
            break;
          }
        }
        if (!supported) {
          // The website is read only when it can change the choice (two
          // different registered addresses); with one, rule 1c gives the
          // same address and the page fetch would be spent for nothing.
          const text = cands.length > 1 ? await ownWebsiteText(row.hjemmeside) : null;
          const hit = text ? cands.find((c) => pageNames(text, c.address)) : undefined;
          if (hit) supported = { c: hit, basis: "own_website" };
        }
        picked = supported ? supported.c : cands[0];
        basis = supported ? supported.basis : cands[0].source;
      }
      counts.found++;
      const addr = picked.address;
      const source = picked.source;
      const base = { address_source: source, address_basis: basis };

      // Spec 2: the whole address from one Brreg sub-object.
      if (!addr.postnummer || !addr.poststed) {
        finish(skip(row.id, "incomplete_address", base), true);
        continue;
      }
      if (!blank(row.postnummer) && row.postnummer!.trim() !== addr.postnummer) {
        finish(skip(row.id, "postnummer_mismatch", base), true);
        continue;
      }
      if (blank(row.postnummer) && !blank(row.poststed) && normaliseStreet(row.poststed) !== normaliseStreet(addr.poststed)) {
        finish(skip(row.id, "poststed_mismatch", base), true);
        continue;
      }

      const provRecord = (value: string) => ({
        value, source_type: "brreg", address_source: source, address_basis: basis, fetched_at: nowIso,
      });
      const fields: string[] = ["adresse"];
      const sets: string[] = ["adresse = @adresse"];
      const params: Record<string, unknown> = {
        id: row.id,
        now: nowIso,
        adresse: addr.adresse,
        pn_before: (row.postnummer || "").trim(),
        ps_before: (row.poststed || "").trim(),
      };
      const prov = parseProv(row.field_provenance);
      appendProv(prov, "address", provRecord(addr.adresse!));
      if (blank(row.postnummer)) {
        sets.push("postnummer = @postnummer");
        params.postnummer = addr.postnummer;
        fields.push("postnummer");
        appendProv(prov, "postnummer", provRecord(addr.postnummer));
      }
      if (blank(row.poststed)) {
        sets.push("poststed = @poststed");
        params.poststed = addr.poststed;
        fields.push("poststed");
        appendProv(prov, "poststed", provRecord(addr.poststed));
      }
      const resultBase = { id: row.id, ...base, outcome: "write_address" as SweepOutcome, flagged: false };

      if (!write) {
        finish({ ...resultBase, status: "would_write", fields_written: fields }, false);
        continue;
      }
      params.prov = JSON.stringify(prov);
      beforeWriteHookForTesting?.(row.id);
      // Re-check at write time that nothing changed meanwhile (Places batch,
      // enrichment PUT): adresse still empty, postnummer/poststed as read.
      const r = db
        .prepare(
          `UPDATE dental_agents
              SET ${sets.join(", ")}, field_provenance = @prov,
                  brreg_address_attempted_at = @now, updated_at = datetime('now')
            WHERE id = @id AND (adresse IS NULL OR adresse = '')
              AND IFNULL(TRIM(postnummer), '') = @pn_before
              AND IFNULL(TRIM(poststed), '') = @ps_before`,
        )
        .run(params);
      if (r.changes > 0) {
        counts.written++;
        finish({ ...resultBase, status: "written", fields_written: fields }, false);
      } else {
        finish({ ...resultBase, status: "skipped", outcome: "changed_meanwhile", fields_written: [] }, false);
      }
    }

    res.json({
      success: true,
      data: {
        mode: "sweep",
        dry_run: !write,
        processed: rows.length,
        found: counts.found,
        written: counts.written,
        no_address: counts.no_address,
        api_error: counts.api_error,
        skipped: counts.skipped,
        flagged: counts.flagged,
        remaining_before: remaining,
        pool_empty: rows.length === 0,
        results,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Internal error" });
  }
});

// ─── Correction mode: mixed addresses an earlier Brreg write left ──────────

export type CorrectionOutcome =
  | "would_correct"
  | "corrected"
  | "street_not_in_brreg"      // the stored street is no longer any Brreg address of the unit (flagged)
  | "incomplete_address"       // the matching Brreg address lacks postnummer/poststed (flagged)
  | "foreign_address"          // forretningsadresse or the matching address outside Norway (flagged)
  | "poststed_only_mismatch"   // postnummer fits, only poststed differs: reported, never written (flagged)
  | "flag_sub_unit_preferred"  // rule 1a picks an active sub-unit address that is not the stored street's (flagged, never written)
  | "flag_ambiguous_sub_units" // several active sub-unit addresses, none singled out (flagged, never written)
  | "under_liquidation" | "bankrupt" | "deleted" | "not_found" // (flagged, not corrected)
  | "changed_meanwhile"
  | "api_error";

export interface CorrectionResult {
  id: string;
  outcome: CorrectionOutcome;
  fields: string[];
  address_source?: BrregAddressSource;
  /** Brreg organisasjonsform code (ENK, AS, ...); null when Brreg gave none. */
  org_form: string | null;
  /** The fylke the correction sets (dry run: would set); only when it differs. */
  fylke_change?: { from: string | null; to: string };
  /** Extra flags, e.g. "fylke_not_resolved". */
  flags?: string[];
  flagged: boolean;
}

interface CorrectionRow {
  id: string;
  org_nr: string;
  adresse: string;
  postnummer: string | null;
  poststed: string | null;
  fylke: string | null;
  field_provenance: string | null;
  brreg_address_attempted_at: string | null;
}

async function correctMixed(body: Record<string, unknown>, res: Response): Promise<void> {
  if (body.apply !== undefined && typeof body.apply !== "boolean") {
    res.status(400).json({ error: "apply må være boolsk true/false" });
    return;
  }
  if (body.write !== undefined) {
    res.status(400).json({ error: "correct_mixed bruker apply, ikke write" });
    return;
  }
  try {
    const apply = body.apply === true;
    const limitRaw = typeof body.limit === "number" && Number.isFinite(body.limit) ? Math.floor(body.limit) : 25;
    const limit = Math.max(1, Math.min(BRREG_ADDRESS_SWEEP_CAP, limitRaw));
    const afterId = typeof body.after_id === "string" ? body.after_id : "";

    const db = getDb("dental");
    const rows = db
      .prepare(
        `SELECT id, org_nr, adresse, postnummer, poststed, fylke, field_provenance, brreg_address_attempted_at FROM dental_agents
          WHERE org_nr IS NOT NULL AND org_nr <> '' AND adresse IS NOT NULL AND adresse <> ''
            AND field_provenance LIKE '%"brreg"%'
            AND brreg_address_attempted_at IS NOT NULL
            AND (is_inactive IS NULL OR is_inactive = 0)
            AND (verification_status IS NULL OR verification_status <> 'rejected')
            AND ${DENTAL_CLINIC_CLASS_SQL}
            AND id > ?
          ORDER BY id ASC LIMIT ?`,
      )
      .all(afterId, limit) as CorrectionRow[];

    const nowIso = new Date().toISOString();
    const results: CorrectionResult[] = [];
    const counts = {
      checked: 0, consistent: 0, not_from_brreg_write: 0, would_correct: 0, corrected: 0, flagged: 0, api_error: 0,
      flag_sub_unit_preferred: 0, flag_ambiguous_sub_units: 0, fylke_changes: 0,
    };
    const push = (r: CorrectionResult) => {
      if (r.flagged) counts.flagged++;
      if (r.outcome === "flag_sub_unit_preferred") counts.flag_sub_unit_preferred++;
      if (r.outcome === "flag_ambiguous_sub_units") counts.flag_ambiguous_sub_units++;
      results.push(r);
    };

    for (const row of rows) {
      const prov = parseProv(row.field_provenance);
      const last = latestProv(prov, "address");
      // Only an address THIS sweep wrote: the Places batch writes the same
      // brreg-shaped provenance but never sets brreg_address_attempted_at, and
      // the sweep stamps both in one UPDATE, so fetched_at must equal the stamp.
      if (
        last?.source_type !== "brreg" ||
        !row.brreg_address_attempted_at ||
        last.fetched_at !== row.brreg_address_attempted_at ||
        normaliseStreet(String(last.value ?? "")) !== normaliseStreet(row.adresse)
      ) {
        counts.not_from_brreg_write++;
        continue;
      }
      counts.checked++;
      const ev = await fetchBrregAddressEvidence(row.org_nr, sweepFetchImpl);
      if (ev.kind === "error") {
        counts.api_error++;
        push({ id: row.id, outcome: "api_error", fields: [], org_form: null, flagged: false });
        continue;
      }
      if (ev.kind === "not_found") {
        push({ id: row.id, outcome: "not_found", fields: [], org_form: null, flagged: true });
        continue;
      }
      const org_form = ev.orgForm;
      if (ev.slettet || ev.konkurs || ev.underAvvikling) {
        const outcome: CorrectionOutcome = ev.slettet ? "deleted" : ev.konkurs ? "bankrupt" : "under_liquidation";
        push({ id: row.id, outcome, fields: [], org_form, flagged: true });
        continue;
      }

      // Rule 1 first, as in sweep mode. A unit registered abroad is never
      // corrected: a foreign forretningsadresse (or a chosen sub-unit
      // abroad) flags the row.
      const choice = chooseAddress(ev, row.postnummer);
      if (choice.kind === "foreign") {
        push({ id: row.id, outcome: "foreign_address", fields: [], org_form, flagged: true });
        continue;
      }
      if (choice.kind === "ambiguous") {
        push({ id: row.id, outcome: "flag_ambiguous_sub_units", fields: [], org_form, flagged: true });
        continue;
      }
      const street = normaliseStreet(streetPart(row.adresse));
      if (choice.kind === "sub_unit" && normaliseStreet(choice.candidate.address.adresse) !== street) {
        // Rule 1a prefers the practice location over the address the stored
        // street came from: moving the postnummer would mix two places.
        push({ id: row.id, outcome: "flag_sub_unit_preferred", fields: [], org_form, address_source: "beliggenhetsadresse", flagged: true });
        continue;
      }

      // The Brreg address carrying the stored street. With an active
      // sub-unit chosen, that is the sub-unit itself (same sub-object, its
      // street checked above); otherwise the registered address with the
      // stored street, the one the write recorded as its source first.
      let match: Candidate | undefined;
      if (choice.kind === "sub_unit") {
        match = choice.candidate;
      } else {
        const registered: Candidate[] = [
          ...(ev.forretningsadresse ? [{ address: ev.forretningsadresse, source: "forretningsadresse" as const }] : []),
          ...(ev.postadresse ? [{ address: ev.postadresse, source: "postadresse" as const }] : []),
        ];
        const matching = registered.filter((c) => c.address.adresse && normaliseStreet(c.address.adresse) === street);
        const recorded = typeof last.address_source === "string" ? last.address_source : "forretningsadresse";
        match = matching.find((c) => c.source === recorded) ?? matching[0];
      }
      if (!match) {
        push({ id: row.id, outcome: "street_not_in_brreg", fields: [], org_form, flagged: true });
        continue;
      }
      const a = match.address;
      const source = match.source;
      if (!isNorwegian(a)) {
        push({ id: row.id, outcome: "foreign_address", fields: [], org_form, address_source: source, flagged: true });
        continue;
      }
      if (!a.postnummer || !a.poststed) {
        push({ id: row.id, outcome: "incomplete_address", fields: [], org_form, address_source: source, flagged: true });
        continue;
      }
      const pnOk = (row.postnummer || "").trim() === a.postnummer;
      const psOk = normaliseStreet(row.poststed) === normaliseStreet(a.poststed);
      if (pnOk && psOk) {
        counts.consistent++;
        continue;
      }
      // Only a postnummer that does not fit is corrected (Daniel's limit);
      // a poststed-only difference (e.g. an old spelling) is reported.
      if (pnOk) {
        push({ id: row.id, outcome: "poststed_only_mismatch", fields: [], org_form, address_source: source, flagged: true });
        continue;
      }
      // fylke follows the new postnummer (the search and /fylke pages filter
      // on the fylke column). An unresolved postnummer leaves fylke alone.
      const resolved = resolveKommuneFromPostnummer(a.postnummer);
      const newFylke = "fylke" in resolved ? resolved.fylke : null;
      const fylkeChange = newFylke !== null && newFylke !== (row.fylke ?? null) ? { from: row.fylke ?? null, to: newFylke } : undefined;
      const extra: Pick<CorrectionResult, "fylke_change" | "flags"> = {
        ...(fylkeChange ? { fylke_change: fylkeChange } : {}),
        ...(newFylke === null ? { flags: ["fylke_not_resolved"] } : {}),
      };
      const fylkeFlag = newFylke === null;
      const fields = ["postnummer", ...(psOk ? [] : ["poststed"]), ...(fylkeChange ? ["fylke"] : []), "lat", "lng"];
      if (!apply) {
        counts.would_correct++;
        if (fylkeChange) counts.fylke_changes++;
        push({ id: row.id, outcome: "would_correct", fields, org_form, address_source: source, ...extra, flagged: fylkeFlag });
        continue;
      }
      const rec = (value: string) => ({
        value, source_type: "brreg", address_source: source, correction: "mixed_address", fetched_at: nowIso,
      });
      appendProv(prov, "postnummer", rec(a.postnummer));
      if (!psOk) appendProv(prov, "poststed", rec(a.poststed));
      if (fylkeChange) {
        appendProv(prov, "fylke", {
          value: fylkeChange.to, source_type: "postnummer_register", derived_from_postnummer: a.postnummer,
          correction: "mixed_address", fetched_at: nowIso,
        });
      }
      beforeWriteHookForTesting?.(row.id);
      const r = db
        .prepare(
          `UPDATE dental_agents
              SET postnummer = @pn,${psOk ? "" : " poststed = @ps,"}${fylkeChange ? " fylke = @fylke," : ""} field_provenance = @prov,
                  lat = NULL, lng = NULL, geocode_confidence = NULL, geocode_source = NULL,
                  updated_at = datetime('now')
            WHERE id = @id AND adresse = @adresse
              AND IFNULL(postnummer, '') = @pn_before AND IFNULL(poststed, '') = @ps_before
              AND IFNULL(fylke, '') = @fy_before`,
        )
        .run({
          id: row.id, adresse: row.adresse, pn: a.postnummer, ...(psOk ? {} : { ps: a.poststed }),
          ...(fylkeChange ? { fylke: fylkeChange.to } : {}), prov: JSON.stringify(prov),
          pn_before: row.postnummer ?? "", ps_before: row.poststed ?? "", fy_before: row.fylke ?? "",
        });
      if (r.changes > 0) {
        counts.corrected++;
        if (fylkeChange) counts.fylke_changes++;
        push({ id: row.id, outcome: "corrected", fields, org_form, address_source: source, ...extra, flagged: fylkeFlag });
      } else {
        push({ id: row.id, outcome: "changed_meanwhile", fields: [], org_form, address_source: source, flagged: false });
      }
    }

    res.json({
      success: true,
      data: {
        mode: "correct_mixed",
        dry_run: !apply,
        processed: rows.length,
        ...counts,
        next_after_id: rows.length === limit ? rows[rows.length - 1].id : null,
        results,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Internal error" });
  }
}

export default router;
