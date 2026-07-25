/**
 * experiences-agent-card.ts — A2A Agent Card for Opplevagent (opplevagent.no)
 *
 * orchestrator-pr-19: Host-aware AI-discovery for the experiences vertical.
 * Exported as a plain object getter — no Express dependency — so tests can
 * call it without spinning up a server. Mirrors dental-agent-card.ts.
 *
 * HOST ISOLATION: this card describes ONLY the experiences vertical
 * (opplevagent.no + /api/opplevelser/*). It is served exclusively on the
 * opplevagent.no host gate in src/index.ts — never on rettfrabonden.com or
 * finn-tannlege.com.
 */

import { signAgentCard } from "./agent-card-signing";

const OPPLEVAGENT_BASE_URL =
  process.env.OPPLEVAGENT_BASE_URL || "https://opplevagent.no";

// Single source of truth for Opplevagent's ChatGPT Custom GPT — referenced
// both by the agent card's x-distribution entry and by the "For AI-agenter"
// human-facing link on the homepage (src/routes/experiences-seo.ts).
export const OPPLEVAGENT_CUSTOM_GPT_URL =
  "https://chatgpt.com/g/g-6a3ab590a7f081919c528a15c6765a7d-opplevagent-finn-opplevelser-i-norge";

// Ensure URL never has a trailing slash (A2A spec requirement).
function baseUrl(): string {
  return OPPLEVAGENT_BASE_URL.replace(/\/$/, "");
}

export function getExperiencesAgentCard(): object {
  const url = baseUrl();
  const card = {
    name: "Opplevagent",
    description:
      "A2A-markedsplass for norske opplevelser og aktiviteter — søkbar for AI-agenter. " +
      "Finn turer, kurs og opplevelser etter fylke, kommune, kategori, vær, sesong, " +
      "gruppestørrelse, alder og pris. " +
      "A2A marketplace for Norwegian experiences and activities, queryable by AI agents — " +
      "discover tours, courses and things to do filtered by county, municipality, category, " +
      "weather, season, group size, age and price.",
    url: `${url}/a2a`,
    // A2A v1.0 (Linux Foundation, released April 2026) top-level protocol fields,
    // dual-published alongside legacy `authentication` below (additive-only —
    // dev-request 2026-07-13-a2a-card-v1-signing slice 1).
    protocolVersion: "1.0.0",
    preferredTransport: "JSONRPC",
    additionalInterfaces: [
      { url: `${url}/api/opplevelser`, transport: "HTTP+JSON" },
    ],
    provider: {
      organization: "Opplevagent",
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
    // opplevagent.no has no producer/write API, so `authentication` above
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
          "produsent/skrive-nøkkel, men opplevagent.no har ingen skrive-API, så her betyr " +
          "X-API-Key utelukkende denne valgfrie forbrukernøkkelen. " +
          "Søk er allerede helt åpent uten nøkkel. Sender du nøkkelen får du en ca. 3x høyere " +
          "rate-grense (200→600 på /a2a og /mcp, 300→900 på REST-søk) og en egen forbrukslogg — " +
          "helt frivillig, aldri påkrevd. " +
          "Voluntary, completely free identity key for AI agents — get one via POST /api/keys " +
          "(optional label/contact_email in the JSON body), no login or account needed. " +
          "The same header name (X-API-Key) may elsewhere also be used for a separate, " +
          "unrelated producer/write key, but opplevagent.no has no write API, so here " +
          "X-API-Key refers exclusively to this optional consumer key. Search is " +
          "already fully open without a key. Sending it grants roughly a 3x higher rate-limit " +
          "ceiling (200→600 on /a2a and /mcp, 300→900 on REST search) and a per-key usage " +
          "ledger — always optional, never required.",
      },
    },
    skills: [
      {
        id: "opplevelser_discover",
        name: "Finn opplevelser / Discover experiences",
        description:
          "Søk blant norske opplevelser og aktiviteter med fritekst og/eller strukturerte filtre. " +
          "Search Norwegian experiences and activities using free text and/or structured filters. " +
          "Backed by the discovery API: " + `${url}/api/opplevelser/discover. ` +
          "Parameters: fylke (county, e.g. «Troms», «Oslo»), kommune (municipality), " +
          "category (e.g. «dyreliv_safari», «natur_friluft»), " +
          "indoor_outdoor («indoor» | «outdoor» | «both»), " +
          "weather («rain» | «snow» | «clear» | «any» — rain/snow prefer indoor & weather-independent), " +
          "season («summer» | «winter» | ...), group_size (integer), age (integer), " +
          "max_price (NOK), duration_max (minutes), language. " +
          "Eksempel / Example: «hva kan vi finne på i Oslo når det regner», " +
          "\"family-friendly outdoor activities in Tromsø in winter\".",
        inputModes: ["text/plain", "application/json"],
        outputModes: ["application/json"],
        examples: [
          "hva kan vi finne på i Oslo når det regner",
          "hvalsafari i Tromsø",
          "familievennlige aktiviteter utendørs i Bergen",
          "things to do in Trondheim under 500 kr",
        ],
      },
      {
        id: "opplevelser_info",
        name: "Hent opplevelse / Get experience details",
        description:
          "Hent fullstendig profil for én opplevelse via id. " +
          "Fetch the full profile for a single experience by id. " +
          "Returns: title, description, category, county/municipality, indoor/outdoor, " +
          "duration, group size, age suitability, price, languages, booking URL and confidence. " +
          "Parameter: id (experience UUID). " +
          "Eksempel / Example: hent opplevelse med id «…».",
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        examples: [
          "{ \"id\": \"00000000-0000-0000-0000-000000000000\" }",
          "hent opplevelse med id 00000000-0000-0000-0000-000000000000",
        ],
      },
      {
        id: "opplevelser_categories",
        name: "Kategorier / List categories",
        description:
          "List alle opplevelses-kategorier med antall publiserte opplevelser. " +
          "List all experience categories with the count of published experiences in each. " +
          "Eksempel / Example: «hvilke kategorier finnes», \"what categories are available?\".",
        inputModes: ["text/plain", "application/json"],
        outputModes: ["application/json"],
        examples: [
          "hvilke kategorier finnes",
          "list kategorier",
          "what categories are available?",
        ],
      },
    ],
    endpoints: {
      rest: `${url}/api/opplevelser`,
      discover: `${url}/api/opplevelser/discover`,
      a2a: `${url}/a2a`,
      openapi: `${url}/openapi.json`,
      llms: `${url}/llms.txt`,
      // dev-request 2026-07-25-proveniens-transparens: additive link to the
      // public "how we verify our data" page (Brreg provider cross-check,
      // already live server-side — docs only, no new behavior).
      provenancePage: `${url}/proveniens`,
    },
    "x-distribution": [
      {
        channel: "custom-gpt",
        url: OPPLEVAGENT_CUSTOM_GPT_URL,
        install: OPPLEVAGENT_CUSTOM_GPT_URL,
        status: "live",
        description: "ChatGPT Custom GPT — Opplevagent experiences discovery; 3 Actions on opplevagent.no/openapi.json (discover/categories/get).",
      },
    ],
  };
  // JWS card signing (dev-request 2026-07-13-a2a-card-v1-signing slice 2) —
  // sign the card exactly as assembled above (no `signatures` key present
  // yet), then attach only if a signing key is actually configured. This
  // covers both consumers of this function (experiences' /a2a route AND its
  // .well-known/agent-card.json route) with one signature computation.
  const signatures = signAgentCard(card);
  if (signatures.length > 0) (card as any).signatures = signatures;
  return card;
}
