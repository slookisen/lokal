/**
 * dental-rest-claims.ts — A2A dev-request
 * 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon, F2-S7 (Daniel's answer
 * to question 29, 2026-10-19). The raw REST answers, GET /api/tannlege/agents
 * and GET /api/tannlege/agents/:id, give acute_vakt and helfo_agreement as the
 * clinic card does (dental-clinic-card.ts: MCP, A2A, /api/tannlege/discover),
 * so the same clinic is described the same way everywhere. No new rule:
 *
 *   acute_vakt       a stored 1 is 1 only when the card says «Akuttvakt»
 *                    (publicAcuteVakt: resolveAcuteClaim "vakt"), else null.
 *                    A stored 0 or null is not an akutt claim and stays as
 *                    stored.
 *   helfo_agreement  shownHelfoAgreement (F2-S6): a stored 'true' without a
 *                    source is "unknown"; every other value as stored.
 *
 * The filters of GET /api/tannlege/agents follow the same values (the
 * `sourcedClaims` option of buildDentalWhere in dental-store.ts), so every
 * row an acute_vakt or helfo_agreement filter lists has the value asked for.
 *
 * With a valid X-Admin-Key (the enrichment routine reads the stored values
 * back) the answer keeps the stored values, as A4-D does for the Places
 * columns.
 *
 * Switch: REST_CLAIMS_REQUIRE_SOURCE. Off (false) gives the stored values and
 * the column filters to every caller, the answer as before F2-S7: rollback is
 * a one-line change here.
 *
 * Pure: no DB access, no data changes.
 */

import { publicAcuteVakt } from "./dental-clinic-card";
import { shownHelfoAgreement } from "./dental-helfo-claim";

/** Switch for F2-S7. Off (false): the raw REST answers and filters as before. */
export const REST_CLAIMS_REQUIRE_SOURCE = true;

let restClaimsForTesting: boolean | null = null;

/** Test-only: act as if REST_CLAIMS_REQUIRE_SOURCE were `on`; null restores it. */
export function __setRestClaimsRequireSourceForTesting(on: boolean | null): void {
  restClaimsForTesting = on;
}

/** REST_CLAIMS_REQUIRE_SOURCE, or the test override. Read per call. */
export function restClaimsRequireSource(): boolean {
  return restClaimsForTesting ?? REST_CLAIMS_REQUIRE_SOURCE;
}

interface RestClaimRow {
  acute_vakt?: 0 | 1 | null;
  helfo_agreement?: string | null;
  field_provenance?: Record<string, unknown> | null;
  patient_focus?: string[] | null;
}

/**
 * `shown` with acute_vakt and helfo_agreement as the card gives them for the
 * stored row `stored` (the claims read the stored field_provenance, which a
 * public answer leaves out). Every key keeps its place; nothing else changes.
 */
export function withRestClaims<T extends { acute_vakt?: unknown; helfo_agreement?: unknown }>(
  shown: T,
  stored: RestClaimRow
): T {
  return {
    ...shown,
    acute_vakt: stored.acute_vakt === 1 ? publicAcuteVakt(stored) : shown.acute_vakt,
    helfo_agreement: shownHelfoAgreement(stored),
  };
}
