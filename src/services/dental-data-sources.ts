// ─── Finn-tannlege's data sources, listed once ───────────────────────────────
// A2A dev-request 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon, F2-S1.
//
// Every surface that says where the clinic data comes from reads this list:
// the footer's «Datakilder» column, /om, /hvordan-det-fungerer, /proveniens
// and llms.txt (routes/dental-seo.ts), and the OpenAPI description and
// licence (services/dental-openapi.ts). The pages read it on each request,
// so a new integration (HPR, NTF, an official Helfo list) is one entry here,
// added in the same change that ships the code that uses it. A source the
// code does not use is never listed: HPR, NTF and Helsedirektoratet are not
// sources today (no client exists; Daniel 2026-10-18, question 14: each comes
// later as its own case). dental-sources-truth.test.ts fails when a page names
// a source this list does not have, and when an entry has no code behind it.
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
  /** What the source gives a clinic profile, in display words. */
  fields: readonly { nb: string; en: string }[];
  /** How the values are obtained, as the code named above the entry does it. */
  method_nb: string;
  method_en: string;
  /** Where to read about the source; null when it has no single address (each clinic's own site). */
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
  // default; Brreg gives no wording of its own.
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
    method_nb: "Oppslag på organisasjonsnummeret i Enhetsregisteret.",
    method_en: "A lookup by organisation number in the Central Coordinating Register for Legal Entities (Enhetsregisteret).",
    url: "https://www.brreg.no/",
    license: { name: "Norsk lisens for offentlige data (NLOD) 2.0", url: "https://data.norge.no/nlod/no/2.0" },
    attribution: "Inneholder data under Norsk lisens for offentlige data (NLOD) tilgjengeliggjort av Brønnøysundregistrene",
  },
  // The dental-agent-enrichment routine (Stage X/V) reads the site with an AI
  // model and writes through PUT /api/tannlege/agents/:id; the verifier only
  // matches the org.nr. or name and place on it (websiteOwnershipMatch).
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
    url: null,
  },
  // POST /api/tannlege/admin/google-places-batch (routes/dental.ts): the
  // match guard isConfidentPlaceMatch (places-match.ts) and fill-only writes
  // of hjemmeside, adresse, telefon and opening_hours. businessStatus is in
  // the field mask but nothing writes it. Display rule: dental-places-display.ts.
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
    url: "https://developers.google.com/maps/documentation/places/web-service/overview",
  },
  // dental-geocode-worker.ts: ws.geonorge.no/adresser, lat/lng with
  // geocode_source 'kartverket'. No licence is stated: the API documentation
  // names none (read 2026-10-19), and none is guessed here.
  {
    id: "kartverket_geocoding",
    name_nb: "Kartverket",
    name_en: "Kartverket",
    fields: [{ nb: "kartplassering", en: "map position" }],
    method_nb: "Adressen slås opp i Kartverkets åpne adresse-API for å plassere klinikken på kartet.",
    method_en: "The address is looked up in Kartverket's open address API to place the clinic on the map.",
    url: "https://ws.geonorge.no/adresser/v1/",
  },
  // norway-postnummer.ts over src/data/postnummer-kommune-2026.json (A2A
  // dev-request 2026-10-16-tannlege-sok-naturlig-sprak, S1): the kommune
  // search in dental-query-parser.ts. Licence and credit line as in the
  // file's own meta block (the truth test keeps them equal).
  {
    id: "kartverket_postnummer",
    name_nb: "Kartverket",
    name_en: "Kartverket",
    fields: [{ nb: "kommune (ut fra postnummeret)", en: "municipality (from the postcode)" }],
    method_nb: "Kartverkets åpne datasett over postnummerområder, lagret i tjenesten, sier hvilken kommune et postnummer hører til. Det brukes når du søker på en kommune.",
    method_en: "Kartverket's open dataset of postcode areas, stored in the service, tells which municipality a postcode belongs to. It is used when you search for a municipality.",
    url: "https://kartkatalog.geonorge.no/metadata/462a5297-33ef-438a-82a5-07fff5799be3",
    license: { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/deed.no" },
    attribution: "Inneholder data under norsk lisens CC BY 4.0 fra Kartverket (Postnummerområder, Posten Norge/Kartverket)",
  },
];

/**
 * What the «Verifisert» badge means, as dental-verifier.ts sets and removes it
 * (computeDentalVerifiedRule and runDentalVerifierBatch's downgrade rules;
 * the numbers are DENTAL_VERIFIER_MIN_RICH_FIELDS of DENTAL_RICH_FIELDS). In
 * production the verifier runs only by hand, through POST
 * /admin/run-dental-verifier (at most 50 rows a call); the standalone runner
 * src/scripts/run-dental-verifier.ts does nothing unless
 * DENTAL_VERIFIER_SCHEDULER_ENABLED=1, and nothing schedules it.
 * /proveniens, /hvordan-det-fungerer and llms.txt print this text; the truth
 * test checks the numbers and the rule against the verifier. Plain text
 * without HTML-special characters other than quotes.
 */
export const DENTAL_VERIFIED_BADGE_TEXT = {
  nb:
    "«Verifisert»-merket settes på to måter: manuelt, etter at en administrator har gått gjennom profilen, eller av en regelstyrt kontroll. " +
    "Kontrollen gir merket når enheten er aktiv i Brønnøysundregistrene, nettstedet er bekreftet som klinikkens eget (siden viser klinikkens organisasjonsnummer, eller navnet sammen med poststed eller postnummer; for en offentlig tannklinikk holder det med en katalogoppføring), og minst 3 av 10 utvidede profilfelt er fylt ut. " +
    "Kontrollen kjøres i dag manuelt, i små partier, så de fleste klinikker er ikke kontrollert ennå. " +
    "Den tar også merket bort når Brønnøysundregistrene viser at enheten er slettet, konkurs eller under avvikling, når næringskoden ikke passer en tannklinikk, eller når nettstedet ikke kan bekreftes tre ganger på rad.",
  en:
    "The \"Verified\" badge is set in one of two ways: by hand, after an administrator has reviewed the profile, or by a rule-based check. " +
    "The check gives the badge when the entity is active in Brønnøysundregistrene, the website is confirmed as the clinic's own (the page shows the clinic's organisation number, or its name together with its town or postcode; for a public dental clinic a directory listing is enough), and at least 3 of 10 extended profile fields are filled in. " +
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

/** The name as a list label: first letter capitalised (proper names are already). */
export function dentalSourceLabel(source: DentalDataSource, lang: DentalSourceLang): string {
  const name = dentalSourceName(source, lang);
  return name.charAt(0).toLocaleUpperCase(lang === "en" ? "en" : "nb") + name.slice(1);
}

/** The source's fields joined for running text: "navn, adresse og næringskode". */
export function dentalSourceFields(source: DentalDataSource, lang: DentalSourceLang): string {
  return joinDentalList(source.fields.map((f) => (lang === "en" ? f.en : f.nb)), lang);
}

/** The source's method text in the given language. */
export function dentalSourceMethod(source: DentalDataSource, lang: DentalSourceLang): string {
  return lang === "en" ? source.method_en : source.method_nb;
}

/**
 * The sources by name, each name once, in list order (two Kartverket datasets
 * are one «Kartverket»). Read on each call, so a test can add an entry.
 */
export function dentalSourceNames(lang: DentalSourceLang): string[] {
  return [...new Set(DENTAL_DATA_SOURCES.map((s) => dentalSourceName(s, lang)))];
}

/** The same, as list labels (the footer column). */
export function dentalSourceLabels(lang: DentalSourceLang): string[] {
  return [...new Set(DENTAL_DATA_SOURCES.map((s) => dentalSourceLabel(s, lang)))];
}

/** «Brønnøysundregistrene, klinikkenes egne nettsider (KI-assistert uttrekk), Google Places og Kartverket». */
export function dentalSourceNamesSentence(lang: DentalSourceLang): string {
  return joinDentalList(dentalSourceNames(lang), lang);
}

/** The entries that carry a licence (llms.txt «Lisens», /om, the OpenAPI licence). */
export function dentalLicensedSources(): Array<DentalDataSource & { license: DentalDataSourceLicense }> {
  return DENTAL_DATA_SOURCES.filter((s): s is DentalDataSource & { license: DentalDataSourceLicense } => !!s.license);
}
