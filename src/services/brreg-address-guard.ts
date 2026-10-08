// ─── Brreg name-hit address guard ───────────────────────────────────────────
// dev-request 2026-10-06-rfb-brreg-navnetreff-feil-adresse, Mål 3.
//
// Snill Bie (Bømlo) got the address of an unrelated Brreg company
// (SNILLE AATEIGEN, 920331076, Fåberg) through a plain NAME hit. A Brreg
// address found by name only is written when the company is demonstrably the
// producer's own:
//   1. the hit's org.nr equals the producer's stored org.nr (linked), or
//   2. the postal codes are identical, or
//   3. the company's fylke (from Brreg poststed) equals the producer's fylke, or
//   4. the producer has no postal code and no place on record (nothing to
//      contradict).
// Anything else — including "could not tell" — is rejected and the caller logs
// the reason. A rejected hit costs nothing: the caller falls back to the
// Google address exactly as if Brreg had no hit.
//
// PURE: no I/O. The caller passes already-loaded values.

import { cityToFylke, fylkerMatch } from "./norway-fylke";

export interface BrregAddressGuardInput {
  /** Org.nr stored on the producer (agents.org_nr), if any. */
  producerOrgNr?: string | null;
  producerPostal?: string | null;
  /** Producer's place name (agents.city / knowledge city), if any. */
  producerCity?: string | null;
  hitOrgNr?: string | null;
  hitPostal?: string | null;
  hitPoststed?: string | null;
}

export interface BrregAddressGuardVerdict {
  accept: boolean;
  reason: "org_nr_linked" | "same_postal" | "no_producer_location" | "same_fylke" | "fylke_mismatch" | "unverifiable";
}

const digits = (s: string | null | undefined): string => (s || "").replace(/\D/g, "");

export function checkBrregNameHitAddress(i: BrregAddressGuardInput): BrregAddressGuardVerdict {
  const pOrg = digits(i.producerOrgNr);
  const hOrg = digits(i.hitOrgNr);
  if (pOrg.length === 9 && pOrg === hOrg) return { accept: true, reason: "org_nr_linked" };

  const pPostal = (i.producerPostal || "").trim();
  const hPostal = (i.hitPostal || "").trim();
  if (/^\d{4}$/.test(pPostal) && pPostal === hPostal) return { accept: true, reason: "same_postal" };

  // Nothing on record to contradict (no postal code, no place): the Brreg
  // address is the only evidence available and fills an otherwise empty
  // record — unchanged pre-guard behaviour. The guard targets the case where
  // the producer's place is known and the hit cannot be reconciled with it.
  if (!/^\d{4}$/.test(pPostal) && !(i.producerCity || "").trim()) {
    return { accept: true, reason: "no_producer_location" };
  }

  const pFylke = cityToFylke(i.producerCity);
  const hFylke = cityToFylke(i.hitPoststed);
  if (pFylke && hFylke) {
    return fylkerMatch(pFylke, hFylke)
      ? { accept: true, reason: "same_fylke" }
      : { accept: false, reason: "fylke_mismatch" };
  }
  return { accept: false, reason: "unverifiable" };
}
