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
// Private address (dev-request 2026-10-18-dental-privat-adresse-skjules,
// Daniel's question 13): a sole proprietorship (organisasjonsform ENK) whose
// stored address has «Bruksenhetsnummer», or «c/o» as a word of its own, is
// registered at its owner's home, so the address is hidden as well
// (isPrivateEnkAddress); postnummer and place stay, as for a Places address.
// One exception: when every «c/o» names a business (a clinic, a centre or a
// company, BUSINESS_WORD and COMPANY_FORM_LAST) and there is no
// «Bruksenhetsnummer», the address is that business's (the owner rents a
// chair there) and is shown. «c/o» with a name only, «Tannlege <name>»
// included, stays hidden: it cannot be told from a home. This rule does not
// depend on the Places switch, and an address the Places rule hides stays
// hidden.
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

/**
 * What the private-address rule reads off a clinic row. organisasjonsform is
 * a required key (optional on DentalAgent), so a caller that builds a row by
 * hand cannot leave it out and skip the rule unnoticed.
 */
export type PrivateAddressRow = Pick<DentalAgent, "adresse"> & { organisasjonsform: string | null };

/** What the rules read off a clinic row. */
export type DentalPlacesRow = Pick<DentalAgent, DentalPlacesColumn | "field_provenance"> &
  PrivateAddressRow & {
    stage_v_pending_correction?: unknown;
  };

/** «Bruksenhetsnummer», a dwelling's unit number; any case. */
const UNIT_NUMBER = /bruksenhetsnummer/i;

/** «c/o» with no letter or digit next to it; any case. */
const CARE_OF = /(?<![\p{L}\p{N}])c\/o(?![\p{L}\p{N}])/iu;

/**
 * The addressee of each «c/o»: the text after it up to the next comma or the
 * next «c/o», so «c/o <clinic> c/o <person>, <street>» has two (round 3).
 */
function careOfAddressees(adresse: string): string[] {
  return adresse.split(CARE_OF).slice(1).map((after) => after.split(",")[0]!);
}

/**
 * A word, with no letter or digit next to it and in any case, that names a
 * business: a clinic, a dental or health centre, a practice, an office, the
 * dentists of a group (tannlegene, tannleger; «tannlege» alone is a title
 * before a name), dental health, orthodontics, «dental», or a shopping
 * centre. Each is on the list review round 2 asked for, or occurs after
 * «c/o» in the ENK addresses of the 2026-10-18 public dump; none is a name.
 */
const BUSINESS_WORD =
  /(?<![\p{L}\p{N}])(?:(?:tann)?klinikk(?:en|ene)?|(?:tannlege|tannhelse|lege|helse|stor)?senter(?:et)?|tannlegekontor(?:et)?|tannlegepraksis|tannlege(?:ne|r|gruppen)|tannhelse|tannregulering|tannmedisin|dental)(?![\p{L}\p{N}])/iu;

/**
 * A company form, AS or ASA, as the addressee's last word («X Tannlegesenter
 * AS») and in capitals, as Brreg writes a company name. In other cases it can
 * be a surname («Kari As»), and anywhere else ASA can be a given name: the
 * dump has a clinic named «ASA <name>». An addressee all in capitals («C/O
 * KARI AS») still counts as a company: it cannot be told apart, and the dump
 * writes every AS after «c/o» in capitals.
 */
const COMPANY_FORM_LAST = /(?<![\p{L}\p{N}])ASA?[^\p{L}\p{N}]*$/u;

/** Whether a «c/o» addressee is a business rather than a person. */
function isBusinessAddressee(addressee: string): boolean {
  return BUSINESS_WORD.test(addressee) || COMPANY_FORM_LAST.test(addressee);
}

/**
 * Whether the clinic's stored address is its owner's home: the clinic is a
 * sole proprietorship (organisasjonsform ENK, the Brreg code) and the address
 * has «Bruksenhetsnummer», or a «c/o» (as a word of its own, any case) whose
 * addressee is not a business. An address whose every «c/o» names a business
 * is that business's, and is not private.
 */
export function isPrivateEnkAddress(agent: PrivateAddressRow): boolean {
  if ((agent.organisasjonsform ?? "").trim().toUpperCase() !== "ENK") return false;
  const adresse = agent.adresse ?? "";
  if (UNIT_NUMBER.test(adresse)) return true;
  return careOfAddressees(adresse).some((addressee) => !isBusinessAddressee(addressee));
}

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

/**
 * The columns (with their provenance keys) hidden on this clinic: those the
 * Places rule hides while `enabled`, and the address when it is a private one.
 */
function hiddenColumns(agent: DentalPlacesRow, enabled: boolean): typeof DENTAL_PLACES_COLUMNS {
  const verdicts = dentalPlacesVerdicts(agent, enabled);
  const privateAddress = isPrivateEnkAddress(agent);
  return DENTAL_PLACES_COLUMNS.filter(({ column }) => verdicts[column] !== "shown" || (column === "adresse" && privateAddress));
}

/**
 * The clinic as the public surfaces show it: each column the rules hide is
 * null, everything else (field_provenance included, for the callers' own
 * checks) as stored. The same object when nothing is hidden. `enabled` is the
 * Places rule's switch; a private address is hidden either way.
 */
export function shownDentalAgent<T extends DentalPlacesRow>(agent: T, enabled: boolean = placesDisplayPolicyEnabled()): T {
  const hidden = hiddenColumns(agent, enabled);
  if (hidden.length === 0) return agent;
  const shown: T = { ...agent };
  for (const { column } of hidden) (shown as DentalPlacesRow)[column] = null;
  return shown;
}

/**
 * field_provenance less the entries (under either key) of each column the
 * rules hide, for the public provenance summary on GET /api/tannlege/agents/:id
 * (routes/dental.ts): built from this, the summary names only the sources
 * behind values the answer shows, so never google_places for a hidden one. As
 * stored when nothing is hidden, or when it is not an object (the summary
 * reads nothing else). `enabled` as for shownDentalAgent.
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
