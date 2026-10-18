/**
 * dental-agent-card.ts — A2A Agent Card for Finn-tannlege.com
 *
 * PR-113: Host-aware AI-discovery for the dental vertical.
 * Exported as a plain object getter — no Express dependency —
 * so tests can call it without spinning up a server.
 */

import { signAgentCard } from "./agent-card-signing";
import { registeredMcpTools } from "./mcp-tool-manifest";
import { agentCardProvider } from "./company-legal";
import { distributionFor } from "../config/distribution-channels";
import { placesDisplayPolicyEnabled } from "./places-display-policy";

const DENTAL_BASE_URL =
  process.env.DENTAL_BASE_URL || "https://finn-tannlege.com";

// Ensure URL never has a trailing slash (A2A spec requirement).
function baseUrl(): string {
  return DENTAL_BASE_URL.replace(/\/$/, "");
}

/**
 * @param honestCount the ONE catalog number (services/honest-count.ts), passed in by
 *   the route handlers. The card itself stays DB-free (see header); when no count is
 *   supplied it simply carries none — it never guesses one.
 */
export function getDentalAgentCard(honestCount?: number | null): object {
  const url = baseUrl();
  const hasCount = typeof honestCount === "number" && honestCount >= 0;
  const card = {
    name: "Finn-tannlege",
    // dev-request 2026-09-02-dental-profilkvalitet-finn-tannlege (5a): the
    // "~6 900 klinikker" claim here counted every Brreg-sweep row (raw
    // sole-proprietors, labs, holding vehicles included), not just real
    // clinics -- the exact dishonesty this dev-request fixes. Rather than
    // wiring a live DB count into this module (deliberately DB-free/pure —
    // see the file header — and called from many test-suite call sites that
    // assume no DB dependency), the stale specific number is simply dropped
    // here; GET /tannlege_stats (dental-mcp.ts) and getDentalStats() give an
    // agent/visitor the real, honestly-filtered count.
    description:
      "A2A-markedsplass for norske tannlegeklinikker med Helfo-avtale-, spesialitet- og akuttvakt-data. " +
      "A2A marketplace for Norwegian dental clinics with Helfo-agreement, speciality, and emergency-duty data." +
      (hasCount ? ` Katalog / catalog: ${honestCount} klinikker / clinics.` : ""),
    url: `${url}/a2a`,
    // A2A v1.0 (Linux Foundation, released April 2026) top-level protocol fields,
    // dual-published alongside legacy `authentication` below (additive-only —
    // dev-request 2026-07-13-a2a-card-v1-signing slice 1).
    protocolVersion: "1.0.0",
    preferredTransport: "JSONRPC",
    additionalInterfaces: [
      { url: `${url}/api/tannlege`, transport: "HTTP+JSON" },
    ],
    // T3 (A2A dev-request 2026-10-08-juridisk-info-nettsteder-agentplatform-as):
    // the provider is the company that operates the service; `name` keeps the brand.
    provider: agentCardProvider(),
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
          "rate-grensen på finn-tannlege.com (1000 kall per 15 min, per MCP-økt på /mcp, ellers " +
          "per IP) økes IKKE av nøkkelen. " +
          "Voluntary, completely free identity key for AI agents — get one via POST /api/keys " +
          "(optional label/contact_email in the JSON body), no login or account needed. " +
          "The same header name (X-API-Key) may elsewhere also be used for a separate, " +
          "unrelated producer/write key, but finn-tannlege.com has no write API, so here " +
          "X-API-Key refers exclusively to this optional consumer key. " +
          "Search is already fully open without a key. Grants a usage-ledger record; " +
          "finn-tannlege.com's rate limit (1000 calls per 15 minutes, per MCP session on /mcp, " +
          "otherwise per IP) is not raised by a key.",
      },
    },
    // A2A dev-request 2026-10-17-dental-d3-rettelser (D3d, point 4): the skill
    // texts say what message/send in routes/dental-a2a.ts does, under the S4a
    // rules for the MCP descriptions (a search word in the first sentence,
    // only what the answer has, no other tool or service, no directive or
    // promotional words) without copying them. Each example, and each request
    // quoted «like this», is answered by its own skill when sent as text, and
    // each message.data key named here is read (dental-agent-card.test.ts).
    // Ids, names, modes and x-mcp-tools are unchanged. Dev-request
    // 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-treffvakt
    // (A4-D): while the Places display rule is on, address, phone and website
    // are listed «when known», since a value only Google Places gives is null
    // (dental-places-display.ts); with it off the text is as before.
    skills: [
      {
        id: "tannlege_search",
        name: "Søk tannlegeklinikker / Search dental clinics",
        description:
          "Finn en tannlege, kjeveortoped eller akutt tannlege i Norge etter sted, fylke, spesialitet, " +
          "Helfo-avtale eller akuttilbud. " +
          "Find a dentist, orthodontist or emergency dentist in Norway by place, county (fylke), specialty, " +
          "Helfo agreement or emergency care. " +
          "Send the request as written in a text part, in Norwegian or English, such as «kjeveortoped Trondheim»; " +
          "`metadata.tolkning` shows how it was read. A text with a nine-digit org.nr gets that clinic, and a " +
          "text with a statistics word gets the statistics. " +
          "For a structured search, send `message.data` without a text part, with one or more of `fylke` " +
          "(a county such as Vestland), `specialty` (such as kjeveortopedi), `helfo_agreement` (\"true\" or " +
          "\"false\"), `acute_vakt` (1: clinics with an emergency claim, that is a sourced akuttvakt or that they " +
          "take emergency patients) and `q` (a clinic name or place as written); a data part in `parts` is not " +
          "read. `metadata.filter` shows the filter that was used. " +
          "`count` is the number of clinics in the answer (at most 20) and `total` the number of clinics that " +
          "match. `clinics` lists them, each with its name, org.nr, " +
          (placesDisplayPolicyEnabled()
            ? "postcode, place, county, Helfo status, emergency claim and profile URL, and its address, phone, " +
              "website, online booking link, opening hours, "
            : "address, postcode, place, county, phone, website, Helfo status, emergency claim and profile URL, " +
              "and its online booking link, opening hours, ") +
          "specialties and chain when known.",
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
          "Hent én tannlege eller spesialistpraksis i Norge etter organisasjonsnummer (org.nr). " +
          "Get one dental clinic in Norway, a dentist or specialist practice, by its organisation number " +
          "(org.nr). " +
          "Send the nine-digit org.nr in a text part; it is read from the text only. " +
          "The answer has the clinic with the same fields as each clinic in a search answer, or a text saying " +
          "that no clinic has that org.nr.",
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        examples: [
          "dental clinic with org.nr 912345678",
          "hent klinikk med orgnr 912345678",
        ],
      },
      {
        id: "tannlege_stats",
        name: "Aggregert statistikk / Aggregated statistics",
        description:
          "Nøkkeltall for det norske tannlegemarkedet: antall tannlege- og spesialistklinikker totalt og per " +
          "fylke, og hvor mange som har Helfo-avtale, hører til en kjede, viser en akuttpåstand (akuttvakt med " +
          "kilde, eller at klinikken tar imot akuttpasienter) eller oppgir spesialister eller spesialiteter. " +
          "En tekst med «statistikk», «totalt» eller «oversikt» gir tallene. " +
          "Key figures for dentist and specialist clinics in Norway: the total, per county (fylke), and how many " +
          "have a Helfo agreement, belong to a chain, show an emergency claim (a sourced akuttvakt, or that the " +
          "clinic takes emergency patients) or list specialists or specialties. " +
          "A text part with «stats», «total» or «how many» gets them too. " +
          "The figures are for all of Norway: a place or filter in the text is not applied.",
        inputModes: ["text/plain", "application/json"],
        outputModes: ["application/json"],
        examples: [
          "hvor mange tannlegeklinikker er det i Norge totalt?",
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
      // dev-request 2026-07-25-proveniens-transparens: additive link to the
      // public "how we verify our data" page (per-field source/date via
      // field_provenance, already live server-side — docs only, no new
      // behavior).
      provenancePage: `${url}/proveniens`,
    },
    // Catalog size + the MCP tools the live /mcp server registers (generated from the
    // registered tools, services/mcp-tool-manifest.ts; locked by discovery-truth.test.ts).
    ...(hasCount ? { "x-catalog": { vertical: "dental", honestCount } } : {}),
    "x-mcp-tools": registeredMcpTools("dental").map((t) => t.name),
    // Channels come from config/distribution-channels.ts (one source, each with a probe URL).
    "x-distribution": distributionFor("dental", `${url}/.well-known/agent-card.json`),
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
