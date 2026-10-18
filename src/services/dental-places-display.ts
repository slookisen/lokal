// ─── dental-places-display — the Places display rule on a Finn-tannlege clinic ─
// dev-request 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-
// treffvakt, slice A4-D.
//
// Maps the four clinic columns Google Places can fill (POST
// /api/tannlege/admin/google-places-batch, routes/dental.ts) onto the shared
// rule in places-display-policy.ts. The batch writes only empty columns, and
// records Places' value verbatim as a google_places record whether it wrote
// it or not, so an exact match is its fingerprint. A value another writer
// stored that is exactly Places' own (most likely a website) therefore counts
// as Places evidence too, unless another source has it. Every public surface
// shows the clinic through shownDentalAgent(): the profile page and its
// JSON-LD, the web cards, the MCP and A2A cards (dental-clinic-card.ts), the
// public REST answers and the sitemap's thin-profile check; the provenance
// summary on GET /agents/:id reads shownDentalFieldProvenance(). The stored
// row is never changed; admin, enrichment and verifier code keep reading it
// as stored.
//
// Provenance keys: the batch writes address, phone, website and
// opening_hours; other writers (and older rows) use the column names adresse,
// telefon and hjemmeside, so both are read.
//
// Marked wrong: Stage V's pending correction of the opening hours (one
// observation of the clinic's own site that contradicts the stored hours, see
// dental-store.ts recordStageVFieldObservation) hides the hours until Stage V
// clears or corrects them. Dental has no owner flow, so no owner signal.
//
// PURE: no DB access (the caller passes the hydrated row).

import type { DentalAgent } from "./dental-store";
import {
  fieldProvenanceRecords,
  placesFieldVerdict,
  placesDisplayPolicyEnabled,
  type PlacesDisplayField,
  type PlacesFieldVerdict,
} from "./places-display-policy";

export type DentalPlacesColumn = "adresse" | "telefon" | "opening_hours" | "hjemmeside";

const DENTAL_PLACES_COLUMNS: ReadonlyArray<{
  column: DentalPlacesColumn;
  field: PlacesDisplayField;
  provenanceKeys: readonly string[];
}> = [
  { column: "adresse", field: "address", provenanceKeys: ["address", "adresse"] },
  { column: "telefon", field: "phone", provenanceKeys: ["phone", "telefon"] },
  { column: "opening_hours", field: "opening_hours", provenanceKeys: ["opening_hours"] },
  { column: "hjemmeside", field: "website", provenanceKeys: ["website", "hjemmeside"] },
];

/** What the rule reads off a clinic row. */
export type DentalPlacesRow = Pick<DentalAgent, DentalPlacesColumn | "field_provenance"> & {
  stage_v_pending_correction?: unknown;
};

/** The fields Stage V has a pending correction for (its JSON map, parsed or as stored). */
function pendingStageVFields(pending: unknown): Set<string> {
  let map = pending;
  if (typeof map === "string") {
    try {
      map = JSON.parse(map);
    } catch {
      return new Set();
    }
  }
  if (!map || typeof map !== "object" || Array.isArray(map)) return new Set();
  return new Set(Object.entries(map).filter(([, entry]) => entry && typeof entry === "object").map(([field]) => field));
}

/** The rule's verdict for each of the four columns. */
export function dentalPlacesVerdicts(
  agent: DentalPlacesRow,
  enabled: boolean = placesDisplayPolicyEnabled()
): Record<DentalPlacesColumn, PlacesFieldVerdict> {
  const pending = pendingStageVFields(agent.stage_v_pending_correction);
  const verdicts = {} as Record<DentalPlacesColumn, PlacesFieldVerdict>;
  for (const { column, field, provenanceKeys } of DENTAL_PLACES_COLUMNS) {
    verdicts[column] = placesFieldVerdict(
      {
        field,
        value: agent[column],
        records: fieldProvenanceRecords(agent.field_provenance, provenanceKeys),
        markedWrong: column === "opening_hours" && pending.has("opening_hours"),
      },
      enabled
    );
  }
  return verdicts;
}

/** The columns (with their provenance keys) the rule hides on this clinic. */
function hiddenColumns(agent: DentalPlacesRow, enabled: boolean): typeof DENTAL_PLACES_COLUMNS {
  const verdicts = dentalPlacesVerdicts(agent, enabled);
  return DENTAL_PLACES_COLUMNS.filter(({ column }) => verdicts[column] !== "shown");
}

/**
 * The clinic as the public surfaces show it: each column the rule hides is
 * null, everything else (field_provenance included, for the callers' own
 * checks) as stored. The same object when nothing is hidden.
 */
export function shownDentalAgent<T extends DentalPlacesRow>(agent: T, enabled: boolean = placesDisplayPolicyEnabled()): T {
  const hidden = hiddenColumns(agent, enabled);
  if (hidden.length === 0) return agent;
  const shown: T = { ...agent };
  for (const { column } of hidden) (shown as DentalPlacesRow)[column] = null;
  return shown;
}

/**
 * field_provenance less the entries (under either key) of each column the rule
 * hides, for the public provenance summary on GET /api/tannlege/agents/:id
 * (routes/dental.ts): built from this, the summary names only the sources
 * behind values the answer shows, so never google_places for a hidden one. As
 * stored when nothing is hidden, or when it is not an object (the summary
 * reads nothing else).
 */
export function shownDentalFieldProvenance(
  agent: DentalPlacesRow,
  enabled: boolean = placesDisplayPolicyEnabled()
): DentalPlacesRow["field_provenance"] {
  const prov = agent.field_provenance;
  if (!prov || typeof prov !== "object" || Array.isArray(prov)) return prov;
  const hiddenKeys = new Set(hiddenColumns(agent, enabled).flatMap(({ provenanceKeys }) => provenanceKeys));
  if (hiddenKeys.size === 0) return prov;
  return Object.fromEntries(Object.entries(prov).filter(([key]) => !hiddenKeys.has(key)));
}
