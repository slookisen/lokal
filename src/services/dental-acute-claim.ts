/**
 * dental-acute-claim.ts — dev-request 2026-10-06-dental-nedlagte-og-akuttpastander,
 * skive B. «Tannlegevakt»/«Akuttvakt» is a health claim and may only be shown
 * when the row carries provenance for `acute_vakt`; otherwise the soft claim
 * «Tar imot akuttpasienter» is shown when patient_focus mentions akutt; else nothing.
 *
 * Provenance rule: `field_provenance.acute_vakt` exists and is either a
 * non-empty array of sources (enrichment/mergeFieldProvenance shape) or an
 * object with a non-empty `sources` array (stage_v_correction shape).
 * Pure functions, no DB access, no data changes.
 */

export type AcuteClaim = "vakt" | "accepts" | null;

interface AcuteClaimInput {
  acute_vakt?: 0 | 1 | null;
  field_provenance?: Record<string, unknown> | null;
  patient_focus?: string[] | null;
}

export const ACUTE_ACCEPTS_LABEL = "Tar imot akuttpasienter";

export function hasAcuteVaktProvenance(
  fieldProvenance: Record<string, unknown> | null | undefined
): boolean {
  if (!fieldProvenance || typeof fieldProvenance !== "object") return false;
  const entry = (fieldProvenance as Record<string, unknown>)["acute_vakt"];
  if (Array.isArray(entry)) return entry.length > 0;
  if (entry && typeof entry === "object") {
    const sources = (entry as { sources?: unknown }).sources;
    return Array.isArray(sources) && sources.length > 0;
  }
  return false;
}

export function patientFocusMentionsAkutt(focus: string[] | null | undefined): boolean {
  return Array.isArray(focus) && focus.some((f) => typeof f === "string" && /akutt/i.test(f));
}

export function resolveAcuteClaim(a: AcuteClaimInput): AcuteClaim {
  if (a.acute_vakt === 1 && hasAcuteVaktProvenance(a.field_provenance)) return "vakt";
  if (patientFocusMentionsAkutt(a.patient_focus)) return "accepts";
  return null;
}
