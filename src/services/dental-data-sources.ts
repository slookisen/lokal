// ─── Finn-tannlege's data sources, listed once ───────────────────────────────
// A2A dev-request 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon, F2-S1.
//
// Every surface that says where the clinic data comes from reads this list:
// the footer's «Datakilder» column, /om, /hvordan-det-fungerer, the field
// table on /proveniens («Metode og kilder», F2-S2) and llms.txt
// (routes/dental-seo.ts), and the OpenAPI description and licence
// (services/dental-openapi.ts). The pages read it on each request,
// so a new integration (HPR, NTF, an official Helfo list) is one entry here,
// added in the same change that ships the code that uses it. A source the
// code does not use is never listed: HPR, NTF and Helsedirektoratet are not
// sources today (no client exists; Daniel 2026-10-18, question 14: each comes
// later as its own case). dental-sources-truth.test.ts fails when a page names
// a source this list does not have, and when an entry has no code behind it.
// The one past import without code here (katalogimport_2026_05, F2-S9) is
// grounded in a data file with its counts instead.
//
// Pure data and plain-text helpers, no I/O. The pages escape the text.

export interface DentalDataSourceLicense {
  name: string;
  url: string;
}

export interface DentalDataSource {
  /** Stable key, for tests and the field table on /proveniens (F2-S2). */
  id: string;
  /**
   * The name as it reads in running text, with the qualifier a reader needs
   * to weigh the values (the clinics' websites are read by an AI model). A
   * list label capitalises the first letter (dentalSourceLabel).
   */
  name_nb: string;
  name_en: string;
  /**
   * The list label, when the name alone does not tell the entry apart from
   * another one with the same name (Kartverket's two datasets). Lists and the
   * field table show it; running text and the footer keep the name.
   */
  label_nb?: string;
  label_en?: string;
  /** What the source gives a clinic profile, in display words. */
  fields: readonly { nb: string; en: string }[];
  /** How the values are obtained, as the code named above the entry does it. */
  method_nb: string;
  method_en: string;
  /**
   * Which date is stored for a value from this source, as the code writing it
   * stores it (the «Dato» column of the field table on /proveniens). No
   * promise of how often anything is fetched.
   */
  date_nb: string;
  date_en: string;
  /**
   * Where to read about the source; null when it has no single address (each
   * clinic's own site) or is not named (the directory import, F2-S9).
   */
  url: string | null;
  license?: DentalDataSourceLicense;
  /** The credit line the licence asks for, worded as the licensor gives it. */
  attribution?: string;
}

export const DENTAL_DATA_SOURCES: readonly DentalDataSource[] = [
  // brreg-client.ts (verifyOrgNumber, fetchBrregBusinessAddress,
  // fetchBrregWebsite): the import, the address sweep
  // (admin-dental-brreg-address-sweep.ts), the website candidate
  // (admin-dental-hjemmeside-discovery.ts, tier 1) and the verifier's status
  // and NACE check (dental-verifier.ts). Licence read on data.brreg.no's
  // Enhetsregisteret API documentation and brreg.no/produkter-og-tjenester/
  // apne-data on 2026-10-19: NLOD, not CC0. The credit line is NLOD 2.0 §5's
  // default; Brreg gives no wording of its own. Origin (F2-S9): the clinic
  // list was built from one Phase-A search of Enhetsregisteret by industry
  // code on 2026-05-27, with the codes and counts in
  // src/data/dental-import-2026-05.json; later lookups go by org.nr. A row
  // without one comes from the directory import below, so this entry says it
  // applies to clinics with an org.nr. Dates: the Phase-A search
  // stored none; the address sweep and the website candidate write a
  // field_provenance record with fetched_at; the verifier stamps
  // brreg_checked_at on each lookup (applyDentalVerifierResult), also when
  // Brreg gives no definite answer (orgnr_not_found_or_unreachable: not
  // found, no response or an error), and writes NULL only for a clinic
  // without an org.nr. (no lookup). So the date says when we asked, not that
  // Brreg confirmed anything (and a repeat lookup in the same process can be
  // answered from brreg-client's verifyCache).
  {
    id: "brreg",
    name_nb: "Brønnøysundregistrene",
    name_en: "Brønnøysundregistrene",
    fields: [
      { nb: "navn", en: "name" },
      { nb: "organisasjonsnummer", en: "organisation number" },
      { nb: "adresse", en: "address" },
      { nb: "næringskode", en: "industry code" },
      { nb: "om enheten er aktiv", en: "whether the entity is active" },
      { nb: "nettstedet klinikken har registrert", en: "the website the clinic has registered" },
    ],
    method_nb: "Gjelder klinikker med organisasjonsnummer. Klinikklisten ble bygd i mai 2026 med ett søk i Enhetsregisteret etter næringskoden for tannlegetjenester (86.230) og to nærliggende koder (86.221 og 32.500). Senere oppslag gjøres på organisasjonsnummeret.",
    method_en: "Applies to clinics with an organisation number. The list of clinics was built in May 2026 with one search of the Central Coordinating Register for Legal Entities (Enhetsregisteret) by the industry code for dental practice activities (86.230) and two related codes (86.221 and 32.500). Later lookups are by organisation number.",
    date_nb: "Det som kom med søket i mai 2026, har ingen egen dato. En adresse eller et nettsted hentet fra registeret senere lagres med hentedato. Når kontrollen slår opp organisasjonsnummeret, lagres datoen for oppslaget, også når registeret ikke gir et sikkert svar.",
    date_en: "What came with the search in May 2026 has no date of its own. An address or website taken from the register later is stored with the date it was fetched. When the check looks up the organisation number, the date of the lookup is stored, also when the register gives no definite answer.",
    url: "https://www.brreg.no/",
    license: { name: "Norsk lisens for offentlige data (NLOD) 2.0", url: "https://data.norge.no/nlod/no/2.0" },
    attribution: "Inneholder data under Norsk lisens for offentlige data (NLOD) tilgjengeliggjort av Brønnøysundregistrene",
  },
  // The dental-agent-enrichment routine (Stage X/V) reads the site with an AI
  // model and writes through PUT /api/tannlege/agents/:id; the verifier only
  // matches the org.nr. or name and place on it (websiteOwnershipMatch).
  // Dates: the field_provenance records the routine sends are merged per
  // field (mergeFieldProvenance, which does not require fetched_at), and a
  // PUT that marks the row enriched stamps last_enriched_at (updateDentalAgent).
  {
    id: "clinic_websites",
    name_nb: "klinikkenes egne nettsider (KI-assistert uttrekk)",
    name_en: "the clinics' own websites (AI-assisted extraction)",
    fields: [
      { nb: "Helfo-direkteoppgjør", en: "Helfo direct billing" },
      { nb: "akuttvakt", en: "emergency duty" },
      { nb: "spesialiteter", en: "specialties" },
      { nb: "behandlinger", en: "treatments" },
      { nb: "åpningstider", en: "opening hours" },
      { nb: "kontaktinformasjon", en: "contact details" },
      { nb: "presentasjon", en: "presentation" },
    ],
    method_nb: "En KI-modell leser klinikkens egne nettsider og henter ut opplysningene. Helfo-avtale og akuttvakt er derfor tolket automatisk fra klinikkens egen tekst, ikke hentet fra Helfo.",
    method_en: "An AI model reads the clinic's own web pages and extracts the details. A Helfo agreement and emergency duty are therefore read automatically from the clinic's own text, not taken from Helfo.",
    date_nb: "Når uttrekket oppgir kilden, lagres den sammen med feltet, og hentedatoen når den er oppgitt. Datoen for siste fullførte uttrekk lagres også.",
    date_en: "When the extraction gives its source, it is stored with the field, and the date it was fetched when that is given. The date of the last completed extraction is stored too.",
    url: null,
  },
  // POST /api/tannlege/admin/google-places-batch (routes/dental.ts): the
  // match guard isConfidentPlaceMatch (places-match.ts) and fill-only writes
  // of hjemmeside, adresse, telefon and opening_hours. businessStatus is in
  // the field mask but nothing writes it. Display rule: dental-places-display.ts.
  // Dates: each value it writes gets a google_places record with fetched_at.
  {
    id: "google_places",
    name_nb: "Google Places",
    name_en: "Google Places",
    fields: [
      { nb: "adresse", en: "address" },
      { nb: "telefon", en: "phone" },
      { nb: "nettsted", en: "website" },
      { nb: "åpningstider", en: "opening hours" },
    ],
    method_nb: "Søk på klinikkens navn og sted. Et treff brukes bare når navnet ligner og postnummer eller poststed stemmer, og det fyller bare felt som er tomme.",
    method_en: "A search on the clinic's name and place. A result is used only when the name is similar and the postcode or town matches, and it only fills fields that are empty.",
    date_nb: "Hentedatoen lagres sammen med hvert felt det fyller.",
    date_en: "The date it was fetched is stored with each field it fills.",
    url: "https://developers.google.com/maps/documentation/places/web-service/overview",
  },
  // dental-geocode-worker.ts: ws.geonorge.no/adresser, lat/lng with
  // geocode_source 'kartverket'. Licence as Kartkatalog gives it for
  // «Adresse REST-API» (metadata 44eeffdc-6069-4000-a49b-2d6bfc59ac61, owner
  // Kartverket, read 2026-10-19): CC BY 4.0, linked to the licence text
  // below. The catalogue gives no credit wording, so the line names the
  // licensor and the service. Dates: the worker writes no date of its own
  // (only lat, lng, geocode_source and geocode_confidence).
  {
    id: "kartverket_geocoding",
    name_nb: "Kartverket",
    name_en: "Kartverket",
    label_nb: "Kartverket (adresse-API)",
    label_en: "Kartverket (address API)",
    fields: [{ nb: "kartplassering", en: "map position" }],
    method_nb: "Adressen slås opp i Kartverkets åpne adresse-API for å plassere klinikken på kartet.",
    method_en: "The address is looked up in Kartverket's open address API to place the clinic on the map.",
    date_nb: "Ingen egen dato lagres for kartplasseringen.",
    date_en: "No date of its own is stored for the map position.",
    url: "https://kartkatalog.geonorge.no/metadata/44eeffdc-6069-4000-a49b-2d6bfc59ac61",
    license: { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
    attribution: "Inneholder data fra Kartverket (Adresse REST-API)",
  },
  // norway-postnummer.ts over src/data/postnummer-kommune-2026.json (A2A
  // dev-request 2026-10-16-tannlege-sok-naturlig-sprak, S1): the kommune
  // search in dental-query-parser.ts. Licence, credit line and the extract
  // date as in the file's own meta block (the truth test keeps them equal).
  {
    id: "kartverket_postnummer",
    name_nb: "Kartverket",
    name_en: "Kartverket",
    label_nb: "Kartverket (postnummerområder)",
    label_en: "Kartverket (postcode areas)",
    fields: [{ nb: "kommune (ut fra postnummeret)", en: "municipality (from the postcode)" }],
    method_nb: "Kartverkets åpne datasett over postnummerområder, lagret i tjenesten, sier hvilken kommune et postnummer hører til. Det brukes når du søker på en kommune.",
    method_en: "Kartverket's open dataset of postcode areas, stored in the service, tells which municipality a postcode belongs to. It is used when you search for a municipality.",
    date_nb: "Datasettet er et uttrekk fra 29. september 2026.",
    date_en: "The dataset is an extract from 29 September 2026.",
    url: "https://kartkatalog.geonorge.no/metadata/462a5297-33ef-438a-82a5-07fff5799be3",
    license: { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/deed.no" },
    attribution: "Inneholder data under norsk lisens CC BY 4.0 fra Kartverket (Postnummerområder, Posten Norge/Kartverket)",
  },
  // F2-S9 (interim). The Phase-A import of 2026-05-27 also took entries from
  // an online directory: the rows without an org.nr. (navn, adresse,
  // postnummer, poststed, fylke, telefon, hjemmeside), and empty adresse,
  // telefon and hjemmeside filled on rows with one. It ran outside this
  // repository and stored no source per field, so nothing here re-fetches it;
  // the counts are in src/data/dental-import-2026-05.json (from A2A
  // dental-phase-a/dental-merge-report-all.md), and the rows without an
  // org.nr. are the ones dental-catalog-class.ts rule 4 (no_brreg_metadata)
  // classifies. The directory is not named, and the entry has no url,
  // licence or credit line, until Daniel has decided what happens to its data
  // (A2A FUNN dental-katalogimport-valg-hos-daniel); the truth test locks
  // that. Not «åpen nettkatalog»: «åpen» could read as an open licence.
  {
    id: "katalogimport_2026_05",
    name_nb: "en engangsimport fra en nettkatalog (mai 2026)",
    name_en: "a one-time import from an online directory (May 2026)",
    label_nb: "Katalogimport (mai 2026)",
    label_en: "Directory import (May 2026)",
    fields: [
      { nb: "navn", en: "name" },
      { nb: "adresse", en: "address" },
      { nb: "telefon", en: "phone" },
      { nb: "nettsted", en: "website" },
    ],
    method_nb: "Navn, adresse, telefon og nettsted for oppføringer uten organisasjonsnummer ble hentet én gang fra en nettkatalog i mai 2026. Importen fylte samtidig tomme adresser, telefonnumre og nettsteder på en del klinikker med organisasjonsnummer. Verdiene er ikke hentet på nytt, og ingen kilde er lagret per felt.",
    method_en: "Name, address, phone and website for listings without an organisation number were taken once from an online directory in May 2026. The import also filled empty addresses, phone numbers and websites on some clinics with an organisation number. The values have not been fetched again, and no source is stored per field.",
    date_nb: "Ingen dato per felt. Verdiene er fra mai 2026.",
    date_en: "No date per field. The values are from May 2026.",
    url: null,
  },
];

/**
 * What the «Verifisert» badge means, as the public pages show it (F2-S8): the
 * read-time claim resolveVerifiedClaim (dental-verified-claim.ts) shows it
 * only when the stored fields pass computeDentalVerifiedRule (the numbers are
 * DENTAL_VERIFIER_MIN_RICH_FIELDS of DENTAL_RICH_FIELDS) and the clinic is
 * not closed, whoever stored 'verified'. No manual way is named: no review is
 * recorded anywhere, and the stored badges came mostly from the enrichment
 * routine through PUT, not from a review. The last sentence is
 * runDentalVerifierBatch's downgrade rules. In production the verifier runs
 * only by hand, through POST /admin/run-dental-verifier (at most 50 rows a
 * call); the standalone runner src/scripts/run-dental-verifier.ts does
 * nothing unless DENTAL_VERIFIER_SCHEDULER_ENABLED=1, and nothing schedules
 * it. /proveniens, /hvordan-det-fungerer and llms.txt print this text; the
 * truth test checks the numbers and the rule against the verifier and the
 * claim. Plain text without HTML-special characters other than quotes.
 */
export const DENTAL_VERIFIED_BADGE_TEXT = {
  nb:
    "«Verifisert»-merket vises bare når den siste kontrollen fant enheten aktiv i Brønnøysundregistrene og nettstedet bekreftet som klinikkens eget (siden viser klinikkens organisasjonsnummer, eller navnet sammen med poststed eller postnummer), og minst 3 av 10 utvidede profilfelt er fylt ut. " +
    "For en offentlig tannklinikk kan en katalogoppføring erstatte kravet om bekreftet nettsted, men ikke kravet om aktiv enhet i Brønnøysundregistrene. " +
    "Et merke som er satt på annen måte, for eksempel av en tidligere automatisk rutine, vises bare når de samme vilkårene er oppfylt. " +
    "Kontrollen kjøres i dag manuelt, i små partier, så de fleste klinikker er ikke kontrollert ennå. " +
    "Den tar også merket bort når Brønnøysundregistrene viser at enheten er slettet, konkurs eller under avvikling, når næringskoden ikke passer en tannklinikk, eller når nettstedet ikke kan bekreftes tre ganger på rad.",
  en:
    "The \"Verified\" badge is shown only when the latest check found the entity active in Brønnøysundregistrene and the website confirmed as the clinic's own (the page shows the clinic's organisation number, or its name together with its town or postcode), and at least 3 of 10 extended profile fields are filled in. " +
    "For a public dental clinic, a directory listing can take the place of a confirmed website, but not of an active entity in Brønnøysundregistrene. " +
    "A badge set in another way, for example by an earlier automated routine, is shown only when the same conditions are met. " +
    "The check is run by hand today, in small batches, so most clinics have not been checked yet. " +
    "It also removes the badge when Brønnøysundregistrene shows the entity as dissolved, bankrupt or being wound up, when its industry code does not fit a dental clinic, or when the website cannot be confirmed three times in a row.",
} as const;

export type DentalSourceLang = "nb" | "en";

/** "a", "a og b", "a, b og c" (en: "and", no serial comma, as the spec's wording). */
export function joinDentalList(items: readonly string[], lang: DentalSourceLang): string {
  if (items.length <= 1) return items.join("");
  const and = lang === "en" ? " and " : " og ";
  return `${items.slice(0, -1).join(", ")}${and}${items[items.length - 1]}`;
}

/** The source's name in running text, in the given language. */
export function dentalSourceName(source: DentalDataSource, lang: DentalSourceLang): string {
  return lang === "en" ? source.name_en : source.name_nb;
}

/** First letter capitalised (proper names are already). */
function capitalise(text: string, lang: DentalSourceLang): string {
  return text.charAt(0).toLocaleUpperCase(lang === "en" ? "en" : "nb") + text.slice(1);
}

/**
 * The source as a list label: its own label when it has one (Kartverket's two
 * datasets), otherwise the name with the first letter capitalised.
 */
export function dentalSourceLabel(source: DentalDataSource, lang: DentalSourceLang): string {
  const label = lang === "en" ? source.label_en : source.label_nb;
  return label ?? capitalise(dentalSourceName(source, lang), lang);
}

/** The source's fields joined for running text: "navn, adresse og næringskode". */
export function dentalSourceFields(source: DentalDataSource, lang: DentalSourceLang): string {
  return joinDentalList(source.fields.map((f) => (lang === "en" ? f.en : f.nb)), lang);
}

/** The source's method text in the given language. */
export function dentalSourceMethod(source: DentalDataSource, lang: DentalSourceLang): string {
  return lang === "en" ? source.method_en : source.method_nb;
}

/** One of the source's fields as a table label: «Helfo-direkteoppgjør», «Om enheten er aktiv». */
export function dentalFieldLabel(field: DentalDataSource["fields"][number], lang: DentalSourceLang): string {
  return capitalise(lang === "en" ? field.en : field.nb, lang);
}

/** Which date is stored for the source's values, in the given language. */
export function dentalSourceDate(source: DentalDataSource, lang: DentalSourceLang): string {
  return lang === "en" ? source.date_en : source.date_nb;
}

/**
 * The sources by name, each name once, in list order (two Kartverket datasets
 * are one «Kartverket»). Read on each call, so a test can add an entry.
 */
export function dentalSourceNames(lang: DentalSourceLang): string[] {
  return [...new Set(DENTAL_DATA_SOURCES.map((s) => dentalSourceName(s, lang)))];
}

/**
 * The names with the first letter capitalised, each once, in list order: the
 * footer column, where Kartverket's two datasets stay one «Kartverket».
 */
export function dentalSourceNameLabels(lang: DentalSourceLang): string[] {
  return [...new Set(DENTAL_DATA_SOURCES.map((s) => capitalise(dentalSourceName(s, lang), lang)))];
}

/** «Brønnøysundregistrene, klinikkenes egne nettsider (KI-assistert uttrekk), Google Places, Kartverket og en engangsimport fra en nettkatalog (mai 2026)». */
export function dentalSourceNamesSentence(lang: DentalSourceLang): string {
  return joinDentalList(dentalSourceNames(lang), lang);
}

/** The entries that carry a licence (llms.txt «Lisens», /om, the OpenAPI licence). */
export function dentalLicensedSources(): Array<DentalDataSource & { license: DentalDataSourceLicense }> {
  return DENTAL_DATA_SOURCES.filter((s): s is DentalDataSource & { license: DentalDataSourceLicense } => !!s.license);
}
