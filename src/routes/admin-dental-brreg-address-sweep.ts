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
// dev-request 2026-10-21-dental-brreg-adresse-feil-for-videre-sweep (spec
// 1-5) tightened what may be written:
//   1. ENK: the registered address of a sole proprietorship is often the
//      dentist's home. A street line is written for an ENK only with support
//      from another source: another clinic row at the same address, the
//      clinic's own website showing the street and postnummer, or an active
//      sub-unit whose beliggenhetsadresse is the address being written.
//      Without support only an empty postnummer/poststed is filled.
//   2. Whole address from one source: street, postnummer and poststed come
//      from the same Brreg sub-object. A stored postnummer (or, with no
//      postnummer, a stored poststed) that differs from it means nothing is
//      written and the row is flagged.
//   3. Units under liquidation, bankrupt or deleted, and addresses outside
//      Norway, are skipped and flagged.
//   4. An active sub-unit's beliggenhetsadresse is preferred over the
//      forretningsadresse (then postadresse). Several distinct sub-unit
//      addresses are narrowed by the stored postnummer; still ambiguous
//      means skipped and flagged.
//   5. results[] has one entry per row: id, status, outcome, fields written,
//      address source, ENK support, flag. Never the address itself.
//      field_provenance records carry address_source for every field
//      written (address, postnummer, poststed).
//
// Other guard rails (unchanged):
//   - fill-only: never overwrites a non-empty adresse/postnummer/poststed;
//     the UPDATE re-checks all three at write time.
//   - catalog_class-aware: only rows the classifier left as a clinic
//     (DENTAL_CLINIC_CLASS_SQL) and not is_inactive / rejected.
//   - no-retry marker brreg_address_attempted_at: a row that got a definite
//     answer (written, skipped, no address) is stamped and not re-asked for
//     BRREG_ADDRESS_NO_RETRY_DAYS days. A transport failure is NOT stamped.
//   - hard cap BRREG_ADDRESS_SWEEP_CAP rows per call, sequential requests,
//     dry-run by default (a dry run writes nothing, stamps included).

import { Router, Request, Response } from "express";
import { getDb } from "../database/db-factory";
import {
  fetchBrregAddressEvidence,
  type BrregAddressSource,
  type BrregStructuredAddress,
} from "../services/brreg-client";
import { DENTAL_CLINIC_CLASS_SQL } from "../services/dental-catalog-class";
import { classifyHjemmeside } from "../services/dental-hjemmeside-classifier";
import { fetchPage, DEFAULT_FETCH_TIMEOUT_MS } from "../services/fetch-page";

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

interface SweepRow {
  id: string;
  org_nr: string;
  postnummer: string | null;
  poststed: string | null;
  hjemmeside: string | null;
  organisasjonsform: string | null;
  field_provenance: string | null;
}

export type SweepOutcome =
  | "write_address"            // street (+ empty postnummer/poststed) from one Brreg address
  | "write_postal_only"        // ENK without support: only empty postnummer/poststed filled
  | "enk_unsupported"          // ENK without support, nothing empty to fill
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

export type EnkSupport = "other_clinic_row" | "sub_unit" | "own_website";

export interface SweepResult {
  id: string;
  status: "written" | "would_write" | "skipped" | "no_address" | "api_error";
  outcome: SweepOutcome;
  fields_written: string[];
  address_source?: BrregAddressSource;
  is_enk?: boolean;
  enk_support?: EnkSupport | null;
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

// Additive provenance merge for one field: append a {value, source_type,
// address_source, fetched_at} record to the field's array without touching
// other fields.
function appendProv(
  prov: Record<string, unknown>,
  field: string,
  value: string,
  addressSource: BrregAddressSource,
  nowIso: string,
): void {
  const existing = Array.isArray(prov[field]) ? (prov[field] as unknown[]) : [];
  prov[field] = [...existing, { value, source_type: "brreg", address_source: addressSource, fetched_at: nowIso }];
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

const addressKey = (a: BrregStructuredAddress): string => `${normaliseStreet(a.adresse)}|${a.postnummer ?? ""}`;

type Choice =
  | { kind: "chosen"; address: BrregStructuredAddress; source: BrregAddressSource }
  | { kind: "none" }
  | { kind: "ambiguous" }
  | { kind: "foreign" };

/** Spec 4: active sub-unit beliggenhetsadresse first, then forretnings-, then postadresse. */
export function chooseAddress(
  ev: {
    forretningsadresse: BrregStructuredAddress | null;
    postadresse: BrregStructuredAddress | null;
    activeSubUnits: { address: BrregStructuredAddress }[];
  },
  storedPostnummer: string | null,
): Choice {
  // A unit registered abroad (NUF with a foreign forretningsadresse) is
  // skipped even when it also has a Norwegian postadresse or sub-unit.
  if (ev.forretningsadresse?.adresse && !isNorwegian(ev.forretningsadresse)) return { kind: "foreign" };

  const distinct = new Map<string, BrregStructuredAddress>();
  for (const s of ev.activeSubUnits) {
    if (s.address.adresse && !isPostbox(s.address.adresse)) distinct.set(addressKey(s.address), s.address);
  }
  if (distinct.size > 0) {
    let pool = [...distinct.values()];
    if (pool.length > 1 && !blank(storedPostnummer)) {
      pool = pool.filter((a) => a.postnummer === storedPostnummer!.trim());
    }
    if (pool.length !== 1) return { kind: "ambiguous" };
    if (!isNorwegian(pool[0])) return { kind: "foreign" };
    return { kind: "chosen", address: pool[0], source: "beliggenhetsadresse" };
  }

  const candidates: Array<[BrregStructuredAddress | null, BrregAddressSource]> = [
    [ev.forretningsadresse, "forretningsadresse"],
    [ev.postadresse, "postadresse"],
  ];
  for (const [a, source] of candidates) {
    if (!a || !a.adresse || isPostbox(a.adresse)) continue;
    if (!isNorwegian(a)) return { kind: "foreign" };
    return { kind: "chosen", address: a, source };
  }
  return { kind: "none" };
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

/** The clinic's own website names the street and the postnummer. */
async function websiteSupports(hjemmeside: string | null, a: BrregStructuredAddress): Promise<boolean> {
  if (blank(hjemmeside) || !a.adresse || !a.postnummer) return false;
  if (classifyHjemmeside(hjemmeside).isBad) return false;
  const r = await fetchPage(hjemmeside!.trim(), {
    userAgent: SWEEP_USER_AGENT,
    timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
    fetchImpl: sweepFetchImpl,
  });
  if (!r.ok) return false;
  const text = pageText(r.html);
  const street = normaliseStreet(a.adresse);
  return street !== "" && text.includes(` ${street} `) && text.includes(` ${a.postnummer} `);
}

const router = Router();

// POST /admin/dental/brreg-address-sweep
// Body: { write?: boolean (default false), limit?: number (default 25, cap 100) }
router.post("/brreg-address-sweep", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const body = (req.body ?? {}) as { write?: unknown; limit?: unknown };
    const write = body.write === true;
    const limitRaw = typeof body.limit === "number" && Number.isFinite(body.limit) ? Math.floor(body.limit) : 25;
    const limit = Math.max(1, Math.min(BRREG_ADDRESS_SWEEP_CAP, limitRaw));

    const db = getDb("dental");
    const remaining = (db
      .prepare(`SELECT COUNT(*) AS n FROM dental_agents WHERE ${candidateWhereSql()}`)
      .get() as { n: number }).n;
    const rows = db
      .prepare(
        `SELECT id, org_nr, postnummer, poststed, hjemmeside, organisasjonsform, field_provenance
           FROM dental_agents WHERE ${candidateWhereSql()}
          ORDER BY (hjemmeside IS NOT NULL AND hjemmeside <> '') DESC, navn ASC, id ASC
          LIMIT ?`,
      )
      .all(limit) as SweepRow[];

    const nowIso = new Date().toISOString();
    const stampAttempt = db.prepare("UPDATE dental_agents SET brreg_address_attempted_at = ? WHERE id = ?");
    // Other clinic rows (spec 1, first kind of support) with a street at the
    // same postnummer; the street itself is compared in JS after normalising.
    const sameAreaClinics = db.prepare(
      `SELECT adresse FROM dental_agents
        WHERE id <> ? AND TRIM(postnummer) = ? AND adresse IS NOT NULL AND adresse <> ''
          AND (is_inactive IS NULL OR is_inactive = 0)
          AND (verification_status IS NULL OR verification_status <> 'rejected')
          AND ${DENTAL_CLINIC_CLASS_SQL}`,
    );
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
      counts.found++;
      const addr = choice.address;
      const source = choice.source;
      const isEnk = ev.orgForm === "ENK" || (row.organisasjonsform || "").trim().toUpperCase() === "ENK";
      const base = { address_source: source, is_enk: isEnk };

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

      // Spec 1: an ENK needs support from another source for the street line.
      let support: EnkSupport | null = null;
      if (isEnk) {
        if (source === "beliggenhetsadresse") {
          support = "sub_unit";
        } else {
          const street = normaliseStreet(addr.adresse);
          const others = sameAreaClinics.all(row.id, addr.postnummer) as Array<{ adresse: string }>;
          if (others.some((o) => normaliseStreet(streetPart(o.adresse)) === street)) {
            support = "other_clinic_row";
          } else if (await websiteSupports(row.hjemmeside, addr)) {
            support = "own_website";
          }
        }
      }
      const writeStreet = !isEnk || support !== null;

      const fields: string[] = [];
      const sets: string[] = [];
      const params: Record<string, unknown> = {
        id: row.id,
        now: nowIso,
        pn_before: (row.postnummer || "").trim(),
        ps_before: (row.poststed || "").trim(),
      };
      const prov = parseProv(row.field_provenance);
      if (writeStreet) {
        sets.push("adresse = @adresse");
        params.adresse = addr.adresse;
        fields.push("adresse");
        appendProv(prov, "address", addr.adresse!, source, nowIso);
      }
      if (blank(row.postnummer)) {
        sets.push("postnummer = @postnummer");
        params.postnummer = addr.postnummer;
        fields.push("postnummer");
        appendProv(prov, "postnummer", addr.postnummer, source, nowIso);
      }
      if (blank(row.poststed)) {
        sets.push("poststed = @poststed");
        params.poststed = addr.poststed;
        fields.push("poststed");
        appendProv(prov, "poststed", addr.poststed, source, nowIso);
      }
      const outcome: SweepOutcome = writeStreet ? "write_address" : fields.length > 0 ? "write_postal_only" : "enk_unsupported";
      const resultBase = { id: row.id, ...base, ...(isEnk ? { enk_support: support } : {}), outcome, flagged: false };

      if (fields.length === 0) {
        finish({ ...resultBase, status: "skipped", fields_written: [] }, true);
        continue;
      }
      if (!write) {
        finish({ ...resultBase, status: "would_write", fields_written: fields }, false);
        continue;
      }
      params.prov = JSON.stringify(prov);
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

export default router;
