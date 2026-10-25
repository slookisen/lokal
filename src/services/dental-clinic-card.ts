/**
 * dental-clinic-card.ts — the one public card for a Finn-tannlege clinic
 * (A2A dev-request 2026-10-16-tannlege-mcp-instrukser-og-klinikkort, S4b).
 *
 * MCP tannlege_search / tannlege_akutt (the "search" card), MCP tannlege_info
 * (the "detail" card) and A2A message/send (toDentalA2aClinic) all build their
 * clinic objects here, so a field is added, cleaned or link-tagged in one
 * place. Every variant shows a phone only when isDisplayablePhone passes, the
 * raw acute_vakt flag only with «Akuttvakt», and the profile link only from
 * clinicProfileUrl. No variant carries a Google rating: that waits for
 * Daniel's rating policy (Maps Platform terms allow caching only lat/lng and
 * place_id). Dev-request 2026-10-17-dental-d3-rettelser (D3d): the search
 * card lists the specialties the specialty filter finds the clinic by
 * (clinicSpecialties), and every variant shows the poststed in its official
 * spelling and no placeholder postnummer "0000". Dev-request
 * 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-treffvakt
 * (A4-D): every variant shows the clinic through shownDentalAgent, so an
 * address, phone, website or opening hours that only Google Places gives, or
 * that is marked wrong, is null (dental-places-display.ts). A2A dev-request
 * 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon (F2-S8): «Verifisert»
 * and the A2A verification_status follow the read-time claim
 * (dental-verified-claim.ts), so a stored 'verified' without a basis shows no
 * badge and answers 'pending_verify'. No key is added or removed.
 *
 * Pure: no DB access (the detail card gets its specialists from the caller).
 */

import { DentalAgentSchema, withoutDentalSideColumns, type DentalAgent, type DentalAgentRow, type DentalPerson } from "./dental-store";
import { resolveVerifiedClaim, shownVerificationStatus } from "./dental-verified-claim";
import { resolveAcuteClaim, ACUTE_ACCEPTS_LABEL, type AcuteClaim } from "./dental-acute-claim";
import { isDisplayablePhone } from "./contact-normalizer";
import { shownPostnummer } from "./norway-postnummer";
import { officialPlaceSpelling } from "./search-intent/norwegian-query";
import { clinicSpecialties } from "../config/dental-search-vocabulary";
import { normalizeOpeningHours, openingHoursEntryText, type OpeningHoursEntry, type Weekday } from "../utils/opening-hours";
import { clinicProfileUrl, titleCasePoststed } from "../routes/dental-seo";
import { shownDentalAgent } from "./dental-places-display";

type ClinicRow = DentalAgentRow;

/**
 * One clinic in a search list (tannlege_search, tannlege_akutt). The required
 * keys are always there (null when unknown). The optional ones are left out
 * when the clinic has no such value, so a list of 25 stays short (about 12 KB
 * per call, dev-request S4b).
 */
export interface DentalSearchCard {
  navn: string;
  org_nr: string | null | undefined;
  adresse: string | null;
  postnummer: string | null;
  poststed: string | null | undefined;
  fylke: string | null | undefined;
  telefon: string | null;
  hjemmeside: string | null | undefined;
  online_booking_url?: string;
  /** Compact lines, weekdays with the same hours on one line ("Man–Fre 08:00–16:00"). */
  apningstider?: string[];
  helfo_agreement: string | undefined;
  /**
   * "vakt": emergency duty whose source is stored with its quote (F1-S4c);
   * "accepts": a source without a quote, or the clinic says it takes
   * emergency patients; null: neither (resolveAcuteClaim).
   */
  akutt: AcuteClaim;
  spesialiteter?: string[];
  chain_brand?: string;
  /** The price band, only when it has a source and is not "ukjent". */
  prisniva?: string;
  badges: string[];
  profil_url: string;
}

/** One clinic in full (tannlege_info): the keys that tool has always returned. */
export interface DentalDetailCard {
  id: string;
  org_nr: string | null | undefined;
  navn: string;
  adresse: string | null | undefined;
  postnummer: string | null;
  poststed: string | null | undefined;
  fylke: string | null | undefined;
  telefon: string | null;
  mobil: string | null;
  epost: string | null | undefined;
  hjemmeside: string | null | undefined;
  helfo_agreement: string | undefined;
  acute_vakt: 1 | null;
  chain_brand: string | null | undefined;
  is_chain_member: 0 | 1 | undefined;
  available_specialties: string[] | undefined;
  treatments: string[] | undefined;
  opening_hours: DentalAgent["opening_hours"];
  payment_options: string[] | null | undefined;
  om_oss: string | null | undefined;
  online_booking_url: string | null | undefined;
  specialists: Array<{ navn: string; primary_specialty: string | null | undefined; specialty_used_here: string | null }>;
  badges: string[];
  profil_url: string;
}

export type DentalClinicSpecialist = Pick<DentalPerson, "navn" | "primary_specialty"> & { specialty_used_here: string | null };

export function toDentalClinicCard(agent: ClinicRow, variant: "search"): DentalSearchCard;
export function toDentalClinicCard(
  agent: ClinicRow,
  variant: "detail",
  extra: { specialists: readonly DentalClinicSpecialist[] }
): DentalDetailCard;
export function toDentalClinicCard(
  stored: ClinicRow,
  variant: "search" | "detail",
  extra?: { specialists: readonly DentalClinicSpecialist[] }
): DentalSearchCard | DentalDetailCard {
  const agent = shownDentalAgent(stored);
  if (variant === "detail") {
    return {
      id: agent.id,
      org_nr: agent.org_nr,
      navn: agent.navn,
      adresse: agent.adresse,
      postnummer: shownPostnummer(agent.postnummer),
      poststed: displayPoststed(agent.poststed),
      fylke: agent.fylke,
      telefon: displayablePhone(agent.telefon),
      mobil: displayablePhone(agent.mobil),
      epost: agent.epost,
      hjemmeside: agent.hjemmeside,
      helfo_agreement: agent.helfo_agreement,
      acute_vakt: publicAcuteVakt(agent),
      chain_brand: agent.chain_brand,
      is_chain_member: agent.is_chain_member,
      available_specialties: agent.available_specialties,
      treatments: agent.treatments,
      opening_hours: agent.opening_hours,
      payment_options: agent.payment_options,
      om_oss: agent.om_oss,
      online_booking_url: agent.online_booking_url,
      specialists: (extra?.specialists ?? []).map((s) => ({
        navn: s.navn,
        primary_specialty: s.primary_specialty,
        specialty_used_here: s.specialty_used_here,
      })),
      badges: clinicBadges(agent, false),
      profil_url: clinicProfileUrl(agent),
    };
  }
  const apningstider = compactOpeningHours(agent.opening_hours);
  const spesialiteter = clinicSpecialties(agent);
  const chainBrand = agent.chain_brand?.trim();
  const prisniva = sourcedPriceBand(agent);
  return {
    navn: agent.navn,
    org_nr: agent.org_nr,
    adresse: agent.adresse ?? null,
    postnummer: shownPostnummer(agent.postnummer),
    poststed: displayPoststed(agent.poststed),
    fylke: agent.fylke,
    telefon: displayablePhone(agent.telefon),
    hjemmeside: agent.hjemmeside,
    ...(agent.online_booking_url ? { online_booking_url: agent.online_booking_url } : {}),
    ...(apningstider.length ? { apningstider } : {}),
    helfo_agreement: agent.helfo_agreement,
    akutt: resolveAcuteClaim(agent),
    ...(spesialiteter.length ? { spesialiteter } : {}),
    ...(chainBrand ? { chain_brand: chainBrand } : {}),
    ...(prisniva ? { prisniva } : {}),
    badges: clinicBadges(agent, spesialiteter.length > 0),
    profil_url: clinicProfileUrl(agent),
  };
}

/**
 * A clinic in an A2A message/send answer: the stored row as before (so `id`
 * and every other key stay), with the values that were untrue made honest —
 * phone and mobile only when displayable, acute_vakt only with «Akuttvakt»,
 * the Places-only values null as on the cards (A4-D; also the row's own
 * opening_hours and hjemmeside), verification_status as the badge says it
 * (F2-S8: 'pending_verify' where the claim hides a stored 'verified') — the
 * Google rating fields, the internal field_provenance and the read-only side
 * values (Stage V's pending map, the claim's inputs) left out, and the search
 * card's fields added with the card's values.
 */
export function toDentalA2aClinic(stored: ClinicRow) {
  const agent = shownDentalAgent(stored);
  const {
    rating: _rating,
    rating_count: _ratingCount,
    rating_source: _ratingSource,
    field_provenance: _provenance,
    ...row
  } = withoutDentalSideColumns(agent);
  // The card's keys come last and keep the row's place for the ones it shares
  // (navn, telefon, adresse, …); its telefon is the displayable one. The two
  // row keys the card leaves out without a value are null, not the raw value
  // (a blank chain_brand).
  return {
    ...row,
    mobil: displayablePhone(agent.mobil),
    acute_vakt: publicAcuteVakt(agent),
    verification_status: shownVerificationStatus(agent),
    chain_brand: null,
    online_booking_url: null,
    ...toDentalClinicCard(agent, "search"),
  };
}

function displayablePhone(phone: string | null | undefined): string | null {
  return isDisplayablePhone(phone) ? phone : null;
}

/**
 * The raw emergency-duty flag, shown only when the card says «Akuttvakt»
 * (resolveAcuteClaim "vakt": a stored quote from the source, A2A dev-request
 * 2026-10-16-finn-tannlege-fasettsider F1-S4c), so no answer says
 * acute_vakt: 1 for a clinic whose card says «Tar imot akuttpasienter».
 */
function publicAcuteVakt(agent: ClinicRow): 1 | null {
  return resolveAcuteClaim(agent) === "vakt" ? 1 : null;
}

/**
 * «Spesialist» is a search-list badge only, as before, given when the search
 * card lists a specialty (clinicSpecialties); tannlege_info lists the
 * specialties themselves.
 */
function clinicBadges(agent: ClinicRow, specialist: boolean): string[] {
  const badges: string[] = [];
  if (agent.helfo_agreement === "true") badges.push("Helfo-avtale");
  const acute = resolveAcuteClaim(agent);
  if (acute === "vakt") badges.push("Akuttvakt");
  else if (acute === "accepts") badges.push(ACUTE_ACCEPTS_LABEL);
  if (resolveVerifiedClaim(agent)) badges.push("Verifisert");
  if (specialist) badges.push("Spesialist");
  return badges;
}

/**
 * The poststed as the cards show it (D3d): a value stored in ASCII form gets
 * its official spelling (officialPlaceSpelling), in capitals when stored in
 * capitals ("TROMSOE" -> "TROMSØ"), else title-cased for a poststed
 * ("Tromsoe" -> "Tromsø") or as the kommune is written ("Baerum" -> "Bærum").
 * An empty or unknown value, or one that differs from the official name only
 * in case ("Bergen", "Mo i Rana"), is kept as stored. Only the stored value is
 * read, never the postnummer's own poststed (a Tromsø clinic at 9022 Kroken
 * still shows Tromsø).
 */
function displayPoststed(stored: string | null | undefined): string | null | undefined {
  if (!stored) return stored;
  const official = officialPlaceSpelling(stored);
  if (!official || official.name.toLowerCase() === stored.toLowerCase()) return stored;
  if (stored === stored.toUpperCase()) return official.name.toUpperCase();
  return official.kind === "poststed" ? titleCasePoststed(official.name) : official.name;
}

// The canonical price bands, read from the write schema (dental-store's
// PRICE_BAND_ENUM) so there is one list; off-spec stored values such as
// "medium" (2026-08-25 audit) are never shown.
const SHOWN_PRICE_BANDS: ReadonlySet<string> = new Set(
  DentalAgentSchema.shape.price_band.unwrap().unwrap().options.filter((band) => band !== "ukjent")
);

function sourcedPriceBand(agent: ClinicRow): string | null {
  const band = agent.price_band;
  const hasSource = typeof agent.price_band_source === "string" && agent.price_band_source.trim() !== "";
  return band && hasSource && SHOWN_PRICE_BANDS.has(band) ? band : null;
}

/**
 * Opening hours as short lines, through the shared normaliser
 * (utils/opening-hours.ts). Weekdays with the same hours, the same note and
 * no season share one line, so a Monday–Friday clinic takes one line instead
 * of five; a day with a note of its own keeps its own line, so the shared
 * entry text never puts one day's note on another day.
 */
function compactOpeningHours(value: unknown): string[] {
  const lines: OpeningHoursEntry[] = [];
  const byHours = new Map<string, OpeningHoursEntry>();
  for (const entry of normalizeOpeningHours(value)) {
    if (!entry.days.length || entry.open === undefined || entry.period) {
      lines.push(entry);
      continue;
    }
    const key = JSON.stringify([entry.open, entry.close, entry.note ?? ""]);
    const same = byHours.get(key);
    if (same) {
      same.days = [...new Set([...same.days, ...entry.days])].sort((x, y) => x - y) as Weekday[];
      continue;
    }
    const line = { ...entry, days: [...entry.days] };
    byHours.set(key, line);
    lines.push(line);
  }
  return lines.map(openingHoursEntryText);
}
