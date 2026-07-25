/**
 * dental-agent-card.ts — A2A Agent Card for Finn-tannlege.com
 *
 * PR-113: Host-aware AI-discovery for the dental vertical.
 * Exported as a plain object getter — no Express dependency —
 * so tests can call it without spinning up a server.
 */

import { signAgentCard } from "./agent-card-signing";

const DENTAL_BASE_URL =
  process.env.DENTAL_BASE_URL || "https://finn-tannlege.com";

// Ensure URL never has a trailing slash (A2A spec requirement).
function baseUrl(): string {
  return DENTAL_BASE_URL.replace(/\/$/, "");
}

export function getDentalAgentCard(): object {
  const url = baseUrl();
  const card = {
    name: "Finn-tannlege",
    description:
      "A2A-markedsplass for norske tannlegeklinikker — ~6 900 klinikker med Helfo-avtale-, spesialitet- og akuttvakt-data. " +
      "A2A marketplace for Norwegian dental clinics — ~6,900 clinics with Helfo-agreement, speciality, and emergency-duty data.",
    url: `${url}/a2a`,
    // A2A v1.0 (Linux Foundation, released April 2026) top-level protocol fields,
    // dual-published alongside legacy `authentication` below (additive-only —
    // dev-request 2026-07-13-a2a-card-v1-signing slice 1).
    protocolVersion: "1.0.0",
    preferredTransport: "JSONRPC",
    additionalInterfaces: [
      { url: `${url}/api/tannlege`, transport: "HTTP+JSON" },
    ],
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
    // dev-request 2026-07-13-agent-identity-usage-ledger, slice 2 (docs-only
    // advertisement — the key system itself already shipped in PR #337/#350).
    // finn-tannlege.com has no producer/write API, so `authentication` above
    // stays "none" (unchanged) and there is no pre-existing `apiKey` scheme
    // to preserve here — this is the platform-wide, purely-optional consumer
    // identity key, advertised for the first time on this card. Not added to
    // any `security` requirement list: reads stay unauthenticated-optional.
    // NOTE: description deliberately does not name any other domain/brand —
    // this card is host-isolated (orch19-03/orch19-06 guard against cross-
    // vertical identity leakage), so keep the wording generic/self-contained.
    securitySchemes: {
      consumerApiKey: {
        type: "apiKey",
        in: "header",
        name: "X-API-Key",
        description:
          "Frivillig og helt gratis identitetsnøkkel for AI-agenter — hentes via POST /api/keys " +
          "(valgfritt label/contact_email i JSON-body), ingen innlogging eller konto kreves. " +
          "Samme headernavn (X-API-Key) kan andre steder også brukes til en egen, urelatert " +
          "produsent/skrive-nøkkel, men finn-tannlege.com har ingen skrive-API, så her betyr " +
          "X-API-Key utelukkende denne valgfrie forbrukernøkkelen. " +
          "Søk er allerede helt åpent uten nøkkel. Gir en egen forbrukslogg; " +
          "rate-grensen på finn-tannlege.com er per i dag en flat IP-kvote som IKKE økes av " +
          "nøkkelen. " +
          "Voluntary, completely free identity key for AI agents — get one via POST /api/keys " +
          "(optional label/contact_email in the JSON body), no login or account needed. " +
          "The same header name (X-API-Key) may elsewhere also be used for a separate, " +
          "unrelated producer/write key, but finn-tannlege.com has no write API, so here " +
          "X-API-Key refers exclusively to this optional consumer key. " +
          "Search is already fully open without a key. Grants a usage-ledger record; " +
          "finn-tannlege.com's rate limit is currently a flat per-IP quota not raised by a key.",
      },
    },
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
    "x-distribution": [
      {
        channel: "custom-gpt",
        url: "https://chatgpt.com/g/g-6a21e79241cc8191a04642bda508e42b-finn-tannlege-i-norge",
        install: "https://chatgpt.com/g/g-6a21e79241cc8191a04642bda508e42b-finn-tannlege-i-norge",
        status: "live",
        description: "ChatGPT Custom GPT — Finn tannlege i Norge clinic discovery; Actions on finn-tannlege.com/openapi.json.",
      },
    ],
  };
  // JWS card signing (dev-request 2026-07-13-a2a-card-v1-signing slice 2) —
  // sign the card exactly as assembled above (no `signatures` key present
  // yet), then attach only if a signing key is actually configured. This
  // covers both consumers of this function (dental's /a2a route AND its
  // .well-known/agent-card.json route) with one signature computation.
  const signatures = signAgentCard(card);
  if (signatures.length > 0) (card as any).signatures = signatures;
  return card;
}
