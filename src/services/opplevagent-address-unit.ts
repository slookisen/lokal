// ─── Opplevagent address as one unit (street + postnummer + poststed) ──────
// dev-request 2026-11-26-cs-endring-som-eier-opplevagent (slookisen/A2A), §2.
//
// A CS change request's `address` on Opplevagent is ONE value with street,
// postnummer and poststed («Universitetsgata 2, 0164 Oslo»). It is written as
// one unit: `adresse` (the street line), `postnummer`, `poststed` and the
// map point (`lat`/`lon`) together, so the map never shows the old place
// under a new street. This module only PARSES and CHECKS the value; it never
// touches a database or the network.
//
// What goes into `adresse`: the street line only — the segment right before
// «<postnummer> <poststed>». Anything before that segment (a venue or farm
// name: «Rebel, Universitetsgata 2, 0164 Oslo», a «c/o» line) is NOT stored:
// the provider's name lives in `navn`, and the public JSON-LD reads `adresse`
// as streetAddress, which must be a street. The dropped part is reported
// (`ignored`) so the dry run shows it. A trailing «Norge»/«Norway» segment is
// dropped too.
//
// Refused (nothing is written, the request gets the reason):
//   - no «<4 digits> <place>» part (adresse_mangler_postnummer_og_poststed)
//   - no street line before it (adresse_mangler_gate)
//   - a post box as the street line (postboks_er_ikke_besoksadresse)
//   - a postnummer not in the register (postnummer_ukjent:<nnnn>)
//   - a poststed that is not the register's place for that postnummer
//     (poststed_passer_ikke_postnummer:<nnnn>=<REGISTER>)

import { poststedForPostnummer } from "./norway-postnummer";

export interface AddressUnit {
  /** The street line, stored in `adresse`. */
  street: string;
  postnummer: string;
  /** The place as written in the request (not upper-cased). */
  poststed: string;
  /** Segments before the street line that are not stored (a venue name). */
  ignored: string[];
}

export type AddressUnitParse = ({ ok: true } & AddressUnit) | { ok: false; reason: string };

const POSTAL_SEGMENT = /^(\d{4})\s+([\p{L}][\p{L}\s.'’-]*)$/u;
const POSTAL_TAIL = /^(.*\S)\s+(\d{4})\s+([\p{L}][\p{L}\s.'’-]*)$/u;
const COUNTRY_SEGMENT = /^(norge|norway|noreg)$/i;
const POST_BOX = /^(postboks|postbox|pb\.?|p\.\s?b\.?|boks)\b/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function placeKey(s: string): string {
  return s.normalize("NFC").toUpperCase().replace(/[^\p{L}]+/gu, " ").trim();
}

/** Parse «[venue, ]street, nnnn place» (comma before the postnummer optional). Pure apart from the postnummer register. */
export function parseAddressUnit(raw: string): AddressUnitParse {
  if (typeof raw !== "string") return { ok: false, reason: "adresse_mangler" };
  if (CONTROL.test(raw)) return { ok: false, reason: "adresse_har_kontrolltegn" };
  const text = raw.replace(/[\r\n]+/g, ", ").replace(/[ \t]+/g, " ").trim();
  if (!text) return { ok: false, reason: "adresse_mangler" };
  const segs = text.split(",").map((s) => s.trim()).filter(Boolean);
  while (segs.length > 1 && COUNTRY_SEGMENT.test(segs[segs.length - 1])) segs.pop();
  if (segs.length === 0) return { ok: false, reason: "adresse_mangler" };

  let street: string | null = null;
  let postnummer: string;
  let poststed: string;
  let before: string[];
  const last = segs[segs.length - 1];
  const pm = POSTAL_SEGMENT.exec(last);
  if (pm) {
    postnummer = pm[1];
    poststed = pm[2].trim();
    if (segs.length < 2) return { ok: false, reason: "adresse_mangler_gate" };
    street = segs[segs.length - 2];
    before = segs.slice(0, -2);
  } else {
    const tm = POSTAL_TAIL.exec(last);
    if (!tm) return { ok: false, reason: "adresse_mangler_postnummer_og_poststed" };
    street = tm[1].trim();
    postnummer = tm[2];
    poststed = tm[3].trim();
    before = segs.slice(0, -1);
  }
  if (!street || !/\p{L}/u.test(street)) return { ok: false, reason: "adresse_mangler_gate" };
  if (POST_BOX.test(street)) return { ok: false, reason: "postboks_er_ikke_besoksadresse" };
  const official = poststedForPostnummer(postnummer);
  if (!official) return { ok: false, reason: `postnummer_ukjent:${postnummer}` };
  if (placeKey(official) !== placeKey(poststed)) return { ok: false, reason: `poststed_passer_ikke_postnummer:${postnummer}=${official}` };
  return { ok: true, street, postnummer, poststed, ignored: before };
}
