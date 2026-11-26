// ─── The owner changes the address on the gårdssalg owner portal ──────────
// dev-request 2026-11-26-opplevagent-eier-endrer-adresse-selv (slookisen/A2A),
// slice 1 (spec points 1–3).
//
// The logged-in owner of a claimed Opplevagent gårdssalg profile writes a new
// street, postnummer and poststed on the owner portal. Saving reuses the
// address writing of the sister item (dev-request 2026-11-26-cs-endring-som-
// eier-opplevagent):
//   - the address-unit rules (opplevagent-address-unit.ts parseAddressUnit:
//     a street line with letters, no post box, a postnummer in the register,
//     the register's poststed for it),
//   - the same map lookup (cs-change-requests.ts defaultAddressGeocoder, the
//     Kartverket ladder the geocode worker uses), BEFORE anything is written,
//   - the one-unit writer applyGardssalgSetAddressUnit (experience-store.ts):
//     adresse, postnummer, poststed, lat and lon in one transaction, or
//     nothing at all; one gardssalg_content_audit row per address column.
// A failed lookup stores nothing and the owner gets a Norwegian message.
//
// The owner lock for every other writer is unchanged: the writer gets the
// owner-portal context (gardssalg-owner-portal-write.ts), which it verifies
// itself against the session row. The change is also one row in the owner's
// change log («Endringslogg», owner_feature_audit, key
// GARDSSALG_OWNER_ADDRESS_EDIT_KEY, actor «owner»), written in the same
// lokal.db transaction as the address write (the address write last; a
// refused write rolls the log row back).
//
// Flag GARDSSALG_OWNER_ADDRESS_EDIT_ENABLED (default off): off → the portal
// shows no address form and the address POST routes do not exist (404).
// "pilot" → only `gardssalg:<id>` on OWNER_FEATURES_ALLOWED_SUBJECTS;
// "1"/"true" → every claimed profile. Read per request. Slice 2: the
// owner's own switch contact.address_edit («Mine valg»; coming_soon until
// the prod switch probe passes, so the owner default «on» holds) is read too
// (gardssalgOwnerAddressEditOpenFor): switched off → no form, both POST
// routes 404, nothing written.

import { getDb as getRfbDb } from "../database/init";
import { getDb as getVerticalDb } from "../database/db-factory";
import { parseAddressUnit } from "./opplevagent-address-unit";
// Type only: cs-change-requests.ts (and its marketplace imports) is loaded
// lazily, on the first real map lookup — see defaultGeocoder() below.
import type { AddressGeocoder } from "./cs-change-requests";
import { applyGardssalgSetAddressUnit } from "./experience-store";
import { isPlausibleNorwayCoord } from "./geo-distance";
import { OWNER_PORTAL_ADDRESS_SOURCE } from "./gardssalg-owner-portal-write";

// The flag lives with the other gårdssalg owner flags (owner-features/gardssalg.ts).
export {
  GARDSSALG_OWNER_ADDRESS_EDIT_ENV, gardssalgOwnerAddressEditMode, gardssalgOwnerAddressEditOnFor,
  gardssalgOwnerAddressEditSwitchOn, gardssalgOwnerAddressEditOpenFor,
} from "../owner-features/gardssalg";

/** The owner-feature registry key of this function (owner-features/registry.ts). */
export const GARDSSALG_OWNER_ADDRESS_EDIT_KEY = "contact.address_edit";

export const OWNER_ADDRESS_STREET_MAX = 200;
export const OWNER_ADDRESS_POSTSTED_MAX = 100;

export type OwnerAddressError =
  | "gate_mangler"
  | "gate_for_lang"
  | "gate_ugyldig"
  | "postnummer_ugyldig"
  | "postnummer_ukjent"
  | "poststed_mangler"
  | "poststed_ugyldig"
  | "poststed_passer_ikke"
  | "postboks"
  | "adresse_ugyldig"
  | "kartoppslag_feilet"
  | "laast"
  | "ikke_tilgang"
  | "feil";

export interface OwnerAddressInput {
  street: unknown;
  postnummer: unknown;
  poststed: unknown;
}

export type OwnerAddressOutcome =
  | {
      ok: true;
      changed: boolean;
      address: { adresse: string; postnummer: string; poststed: string };
    }
  | { ok: false; error: OwnerAddressError; postnummer?: string; registerPoststed?: string };

let geocoderOverride: AddressGeocoder | null = null;

/** Test seam: the map lookup the routes use (null = the Kartverket default). */
export function __setOwnerAddressGeocoderForTesting(g: AddressGeocoder | null): void {
  geocoderOverride = g;
}

/** The sister item's Kartverket lookup (cs-change-requests.ts defaultAddressGeocoder), loaded on first use. */
function defaultGeocoder(): AddressGeocoder {
  return (require("./cs-change-requests") as typeof import("./cs-change-requests")).defaultAddressGeocoder;
}

function text(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

/** PURE apart from the postnummer register: the input as an address unit, or why not. */
export function checkOwnerAddressInput(input: OwnerAddressInput):
  | { ok: true; street: string; postnummer: string; poststed: string }
  | { ok: false; error: OwnerAddressError; postnummer?: string; registerPoststed?: string } {
  if (typeof input.street !== "string" && input.street !== undefined && input.street !== null) return { ok: false, error: "gate_ugyldig" };
  const street = text(input.street);
  const postnummer = text(input.postnummer);
  const poststed = text(input.poststed);
  if (!street) return { ok: false, error: "gate_mangler" };
  if (street.length > OWNER_ADDRESS_STREET_MAX) return { ok: false, error: "gate_for_lang" };
  if (!/^\d{4}$/.test(postnummer)) return { ok: false, error: "postnummer_ugyldig" };
  if (!poststed) return { ok: false, error: "poststed_mangler" };
  if (poststed.length > OWNER_ADDRESS_POSTSTED_MAX) return { ok: false, error: "poststed_ugyldig" };
  // The sister item's rules, on the same «gate, nnnn sted» value CS writes.
  const a = parseAddressUnit(`${street}, ${postnummer} ${poststed}`);
  if (!a.ok) {
    if (a.reason === "adresse_mangler_gate" || a.reason === "adresse_mangler") return { ok: false, error: "gate_mangler" };
    if (a.reason === "postboks_er_ikke_besoksadresse") return { ok: false, error: "postboks" };
    if (a.reason.startsWith("postnummer_ukjent")) return { ok: false, error: "postnummer_ukjent", postnummer };
    if (a.reason.startsWith("poststed_passer_ikke_postnummer")) {
      const register = a.reason.split("=")[1] ?? "";
      return { ok: false, error: "poststed_passer_ikke", postnummer, registerPoststed: register };
    }
    if (a.reason === "adresse_mangler_postnummer_og_poststed") return { ok: false, error: "poststed_ugyldig" };
    return { ok: false, error: "gate_ugyldig" };
  }
  // The street field holds the street line only: a comma would make part of
  // it a «venue» that is not stored.
  if (a.ignored.length > 0 || a.street !== street) return { ok: false, error: "gate_ugyldig" };
  return { ok: true, street: a.street, postnummer: a.postnummer, poststed: a.poststed };
}

/** The address as the owner sees it in the change log. */
export function ownerAddressLine(a: { adresse: string | null; postnummer: string | null; poststed: string | null }): string | null {
  const place = [a.postnummer, a.poststed].filter((x) => typeof x === "string" && x.trim() !== "").join(" ");
  const line = [a.adresse ?? "", place].filter((x) => x.trim() !== "").join(", ");
  return line || null;
}

class Refusal extends Error {
  constructor(readonly out: OwnerAddressOutcome) {
    super("owner_address_refused");
  }
}

/**
 * The owner's own address save. `ctx.sessionToken` is the session the
 * request came with; the store writer verifies it again. Nothing is written
 * unless every check and the map lookup pass.
 */
export async function saveGardssalgOwnerAddress(
  providerId: string,
  input: OwnerAddressInput,
  ctx: { sessionToken: string; actorDetail?: string | null },
  deps: { geocode?: AddressGeocoder } = {},
): Promise<OwnerAddressOutcome> {
  const checked = checkOwnerAddressInput(input);
  if (!checked.ok) return checked;
  const { street, postnummer, poststed } = checked;

  const row = getVerticalDb("experiences")
    .prepare(`SELECT adresse, postnummer, poststed, content_source FROM experience_providers WHERE id = ?`)
    .get(providerId) as { adresse: string | null; postnummer: string | null; poststed: string | null; content_source: string | null } | undefined;
  if (!row) return { ok: false, error: "feil" };
  if (row.content_source === "manual") return { ok: false, error: "laast" };
  if ((row.adresse ?? "").trim() === street && (row.postnummer ?? "").trim() === postnummer && (row.poststed ?? "").trim() === poststed) {
    return { ok: true, changed: false, address: { adresse: street, postnummer, poststed } };
  }

  let geo: Awaited<ReturnType<AddressGeocoder>> = null;
  try {
    geo = await (deps.geocode ?? geocoderOverride ?? defaultGeocoder())({ street, postnummer, poststed });
  } catch (e: any) {
    console.error(`[gardssalg-owner-address] map lookup failed for provider ${providerId}:`, String(e?.message ?? e).slice(0, 200));
    geo = null;
  }
  if (!geo || !isPlausibleNorwayCoord(geo.lat, geo.lon)) return { ok: false, error: "kartoppslag_feilet" };

  const oldLine = ownerAddressLine(row);
  const newLine = ownerAddressLine({ adresse: street, postnummer, poststed });
  const rfb = getRfbDb();
  try {
    return rfb.transaction((): OwnerAddressOutcome => {
      // lokal.db first (the change-log row), the experiences.db write LAST:
      // a refused write throws and rolls the log row back.
      rfb.prepare(
        `INSERT INTO owner_feature_audit (vertical, subject_id, key, old_json, new_json, actor, actor_detail, at)
         VALUES ('gardssalg', ?, ?, ?, ?, 'owner', ?, ?)`,
      ).run(providerId, GARDSSALG_OWNER_ADDRESS_EDIT_KEY, JSON.stringify(oldLine), JSON.stringify(newLine), ctx.actorDetail ?? null, new Date().toISOString());
      const res = applyGardssalgSetAddressUnit(
        providerId,
        { street, postnummer, poststed, lat: geo!.lat, lon: geo!.lon, confidence: geo!.confidence },
        OWNER_PORTAL_ADDRESS_SOURCE,
        { ownerPortal: { sessionToken: ctx.sessionToken } },
      );
      if (!res.ok) {
        let error: OwnerAddressError = "feil";
        if (res.reason === "owner_portal_invalid") error = res.detail === "locked_by_manual" ? "laast" : "ikke_tilgang";
        else if (res.reason === "defective_value") error = "adresse_ugyldig";
        else if (res.reason === "implausible_coordinate") error = "kartoppslag_feilet";
        else if (res.reason === "invalid_postnummer") error = "postnummer_ugyldig";
        else if (res.reason === "value_required") error = "gate_mangler";
        throw new Refusal({ ok: false, error });
      }
      console.log(`[gardssalg-owner-address] owner changed the address for provider ${providerId}`);
      return { ok: true, changed: true, address: { adresse: street, postnummer, poststed } };
    })();
  } catch (e) {
    if (e instanceof Refusal) return e.out;
    throw e;
  }
}

/** The Norwegian message for an outcome (portal alert and JSON `message`). */
export function ownerAddressMessage(o: OwnerAddressOutcome, csEmail: string): string {
  if (o.ok) return o.changed ? "Adressen er lagret. Kartet viser det nye stedet." : "Adressen er den samme som før. Ingenting er endret.";
  switch (o.error) {
    case "gate_mangler": return "Skriv inn gateadressen, for eksempel «Gardsvegen 12». Ingenting er lagret.";
    case "gate_for_lang": return `Gateadressen kan være høyst ${OWNER_ADDRESS_STREET_MAX} tegn. Ingenting er lagret.`;
    case "gate_ugyldig": return "Skriv bare gatenavn og nummer i gatefeltet, uten komma. Ingenting er lagret.";
    case "postnummer_ugyldig": return "Postnummeret må være fire sifre. Ingenting er lagret.";
    case "postnummer_ukjent": return `Vi finner ikke postnummeret ${o.postnummer ?? ""} i postregisteret. Sjekk at det er riktig. Ingenting er lagret.`;
    case "poststed_mangler": return "Skriv inn poststedet. Ingenting er lagret.";
    case "poststed_ugyldig": return "Poststedet kan bare inneholde bokstaver. Ingenting er lagret.";
    case "poststed_passer_ikke": return `Poststedet passer ikke med postnummeret ${o.postnummer ?? ""}${o.registerPoststed ? `. I postregisteret heter det ${o.registerPoststed}` : ""}. Ingenting er lagret.`;
    case "postboks": return "En postboks kan ikke brukes. Skriv adressen der besøkende kommer. Ingenting er lagret.";
    case "adresse_ugyldig": return "Adressen ser ikke ut som en gateadresse. Ingenting er lagret.";
    case "kartoppslag_feilet": return "Vi fant ikke adressen på kartet, så ingenting er lagret. Sjekk gate, postnummer og poststed og prøv igjen.";
    case "laast": return `Adressen er låst av Opplevagent-support. Skriv til ${csEmail} for å endre den.`;
    case "ikke_tilgang": return "Du har ikke tilgang til å endre denne profilen. Logg inn på nytt.";
    default: return "Klarte ikke å lagre adressen. Prøv igjen.";
  }
}
