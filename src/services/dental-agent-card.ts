/**
 * dental-agent-card.ts — A2A Agent Card for Finn-tannlege.com
 *
 * PR-113: Host-aware AI-discovery for the dental vertical.
 * Exported as a plain object getter — no Express dependency —
 * so tests can call it without spinning up a server.
 */

const DENTAL_BASE_URL =
  process.env.DENTAL_BASE_URL || "https://finn-tannlege.com";

// Ensure URL never has a trailing slash (A2A spec requirement).
function baseUrl(): string {
  return DENTAL_BASE_URL.replace(/\/$/, "");
}

export function getDentalAgentCard(): object {
  const url = baseUrl();
  return {
    name: "Finn-tannlege",
    description:
      "A2A-markedsplass for norske tannlegeklinikker — ~6 900 klinikker med Helfo-avtale-, spesialitet- og akuttvakt-data. " +
      "A2A marketplace for Norwegian dental clinics — ~6,900 clinics with Helfo-agreement, speciality, and emergency-duty data.",
    url,
    provider: {
      organization: "Finn-tannlege",
      url,
    },
    version: "0.1.0",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["application/json"],
    authentication: { schemes: ["none"], credentials: null },
    skills: [
      {
        id: "tannlege_search",
        name: "Søk tannlegeklinikker / Search dental clinics",
        description:
          "Søk blant norske tannlegeklinikker med fritekst og/eller strukturerte filtre. " +
          "Search Norwegian dental clinics using free text and/or structured filters. " +
          "Parameters: q (free text, matches name/city), fylke (county name, e.g. «Oslo», «Vestland»), " +
          "spesialitet (specialty, e.g. «kjeveortopedi», «endodonti»), " +
          "helfo («true» = Helfo direct-billing agreement only), " +
          "akutt (1 = emergency duty clinics only). " +
          "Eksempel / Example: «finn tannlege med Helfo-avtale i Bergen», " +
          "\"find orthodontist in Trondheim\".",
        inputModes: ["text/plain", "application/json"],
        outputModes: ["application/json"],
        examples: [
          "finn tannlege med helfo-avtale i Oslo",
          "akuttvakt tannlege Stavanger",
          "find orthodontist in Bergen",
          "kjeveortoped Trondheim",
        ],
      },
      {
        id: "tannlege_info",
        name: "Hent klinikkdetaljer / Get clinic details",
        description:
          "Hent fullstendig profil for én tannlegeklinikk via organisasjonsnummer. " +
          "Fetch full profile for a single dental clinic by organisation number (org_nr). " +
          "Returns: name, address, county, phone, website, Helfo status, emergency duty, " +
          "specialities, chain affiliation, and enrichment metadata. " +
          "Parameter: org_nr (9-digit Norwegian organisation number). " +
          "Eksempel / Example: org_nr «912345678».",
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        examples: [
          "{ \"org_nr\": \"912345678\" }",
          "hent klinikk med orgnr 912345678",
        ],
      },
      {
        id: "tannlege_stats",
        name: "Aggregert statistikk / Aggregated statistics",
        description:
          "Hent aggregerte nøkkeltall for den norske tannlegemarkedet. " +
          "Fetch aggregated key figures for the Norwegian dental market. " +
          "Returns: total clinic count, per-county breakdown, Helfo count, chain count, " +
          "emergency-duty count, and specialist-clinic count. " +
          "Eksempel / Example: «hvor mange tannleger finnes det i Norge?», " +
          "\"how many dental clinics have Helfo agreement?\".",
        inputModes: ["text/plain", "application/json"],
        outputModes: ["application/json"],
        examples: [
          "hvor mange tannleger er det i Norge totalt?",
          "statistikk per fylke",
          "how many clinics have Helfo agreement?",
        ],
      },
    ],
    endpoints: {
      rest: `${url}/api/tannlege`,
      a2a: `${url}/a2a`,
      mcp: `${url}/mcp`,
      openapi: `${url}/openapi.json`,
      llms: `${url}/llms.txt`,
    },
  };
}
