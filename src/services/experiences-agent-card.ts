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
  return {
    name: "Opplevagent",
    description:
      "A2A-markedsplass for norske opplevelser og aktiviteter — søkbar for AI-agenter. " +
      "Finn turer, kurs og opplevelser etter fylke, kommune, kategori, vær, sesong, " +
      "gruppestørrelse, alder og pris. " +
      "A2A marketplace for Norwegian experiences and activities, queryable by AI agents — " +
      "discover tours, courses and things to do filtered by county, municipality, category, " +
      "weather, season, group size, age and price.",
    url: `${url}/a2a`,
    protocolVersion: "0.3.0",
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
}
