/**
 * experiences-openapi.ts — OpenAPI 3.1 spec for Opplevagent (opplevagent.no)
 *
 * orchestrator-pr-19: Compact but complete spec covering the public
 * experiences API paths (/api/opplevelser/*) plus the A2A and discovery
 * surfaces. Built as a JS object so it can be tree-shaken and unit-tested
 * without loading from disk. Served at GET /openapi.json on the
 * opplevagent.no host. Mirrors dental-openapi.ts.
 */

import { EXPERIENCE_TAGS } from "./experience-tags";

const OPPLEVAGENT_BASE_URL =
  process.env.OPPLEVAGENT_BASE_URL || "https://opplevagent.no";

export function getExperiencesOpenapi(): object {
  const url = (OPPLEVAGENT_BASE_URL || "https://opplevagent.no").replace(/\/$/, "");
  return {
    openapi: "3.1.0",
    info: {
      title: "Opplevagent API",
      description:
        "REST API for Norwegian experience and activity discovery. " +
        "Experiences are harvested from curated sources and provider-verified " +
        "against Brønnøysundregistrene. All read endpoints are public; no " +
        "authentication required.",
      version: "0.1.0",
      contact: { url },
      license: { name: "CC0 (Brreg data)", url: "https://creativecommons.org/publicdomain/zero/1.0/" },
    },
    servers: [{ url, description: "Production" }],
    paths: {
      "/api/opplevelser/discover": {
        get: {
          operationId: "discoverExperiences",
          summary: "Discover experiences (intent discovery)",
          description:
            "«Hva kan vi finne på i [sted]» — intent discovery over published " +
            "experiences. All parameters are optional and combinable. Only " +
            "verified experiences whose provider is brreg-active and whose " +
            "confidence is medium/high are surfaced. " +
            "`category=gardssalg_smaking` routes to a distinct vertical — Brreg-registered " +
            "farm-sale drink producers (gårdssalg) stored separately from `experiences` — and " +
            "returns `vertical:\"gardssalg\"` with GardssalgProducer-shaped rows instead (see " +
            "`producer_type`/`booking_live` parameters and the GardssalgProducer schema below).",
          parameters: [
            { name: "fylke", in: "query", description: "County name (e.g. «Oslo», «Troms»)", schema: { type: "string" }, example: "Troms" },
            { name: "kommune", in: "query", description: "Municipality name (e.g. «Tromsø»)", schema: { type: "string" }, example: "Tromsø" },
            {
              name: "category",
              in: "query",
              description: "Category slug (e.g. «dyreliv_safari», «natur_friluft»). «gardssalg_smaking» routes to the gårdssalg producer vertical instead of `experiences`.",
              schema: { type: "string" },
              examples: {
                experience: { value: "dyreliv_safari", summary: "Regular experience category" },
                gardssalg: { value: "gardssalg_smaking", summary: "Gårdssalg (farm-sale drink producer) vertical" },
              },
            },
            {
              name: "producer_type",
              in: "query",
              description: "Gårdssalg-only: producer type filter (e.g. «bryggeri», «sideri», «vingård»). Ignored outside `category=gardssalg_smaking`.",
              schema: { type: "string" },
              example: "sideri",
            },
            {
              name: "booking_live",
              in: "query",
              description: "Gårdssalg-only: pass literal `true` to only return producers with live direct booking (omitted = no filter on this column, NOT «only paused»). Ignored outside `category=gardssalg_smaking`.",
              schema: { type: "boolean" },
            },
            {
              name: "q",
              in: "query",
              description:
                "Experiences: the user's request in their own words, with any place named (e.g. «hvalsafari i Tromsø»). " +
                "Read like `query` of the MCP tool `discover_experiences` (place, category, season, weather, search words); " +
                "what was read is returned in `query_interpretation`. Explicit parameters win; `q` only fills what they leave " +
                "empty. A place is never relaxed away: no hits gives `count: 0` and `zero_hit_reason`. A place outside Norway " +
                "gives `out_of_area`, buying food (e.g. stockfish) `out_of_scope`, both with no results. " +
                "Gårdssalg (`category=gardssalg_smaking`): lookup of ONE producer by name and/or place (e.g. «Fjordgard " +
                "Bryggeri»); every word must match. Book with its `id` as `provider_id`.",
              schema: { type: "string", maxLength: 200 },
              examples: {
                experience: { value: "hvalsafari i Tromsø", summary: "Experiences: a request in the user's words" },
                gardssalg: { value: "Fjordgard Bryggeri", summary: "Gårdssalg: one producer by name (with category=gardssalg_smaking)" },
              },
            },
            { name: "indoor_outdoor", in: "query", description: "Indoor / outdoor preference", schema: { type: "string", enum: ["indoor", "outdoor", "both"] } },
            { name: "weather", in: "query", description: "Weather hint — rain/snow prefer indoor & weather-independent", schema: { type: "string", enum: ["rain", "snow", "clear", "any"] } },
            { name: "season", in: "query", description: "Season (e.g. «summer», «winter»)", schema: { type: "string" }, example: "winter" },
            { name: "group_size", in: "query", description: "Number of people in the group", schema: { type: "integer", minimum: 1 } },
            { name: "age", in: "query", description: "Age of the youngest participant", schema: { type: "integer", minimum: 0 } },
            { name: "max_price", in: "query", description: "Maximum price (NOK)", schema: { type: "integer", minimum: 1 } },
            { name: "duration_max", in: "query", description: "Maximum duration (minutes)", schema: { type: "integer", minimum: 1 } },
            { name: "language", in: "query", description: "Required language (e.g. «en», «no»)", schema: { type: "string" } },
            { name: "lat", in: "query", description: "Origin latitude for a near-me search (decimal degrees). Must be given together with lng.", schema: { type: "number", minimum: -90, maximum: 90 }, example: 69.65 },
            { name: "lng", in: "query", description: "Origin longitude for a near-me search (decimal degrees). Must be given together with lat.", schema: { type: "number", minimum: -180, maximum: 180 }, example: 18.95 },
            { name: "radius_km", in: "query", description: "Max distance from lat/lng in kilometers. Only applies when lat/lng are given.", schema: { type: "number", exclusiveMinimum: 0, maximum: 5000 }, example: 50 },
            { name: "sort", in: "query", description: "'distance' — sort ascending by distance from lat/lng (already the default whenever lat/lng are given).", schema: { type: "string", enum: ["distance"] } },
            { name: "limit", in: "query", description: "Max results (default 20, max 100)", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
          ],
          responses: {
            "200": {
              description: "Discovery result — `vertical` and the shape of `results[]` depend on `category` (see GardssalgProducer for the gårdssalg branch).",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      vertical: { type: "string", enum: ["experiences", "gardssalg"] },
                      query: { type: "object", description: "The filter that was searched; with `q`, including what was read from it." },
                      count: { type: "integer" },
                      total: { type: "integer", description: "Experiences: all published rows matching the applied filter (`count` is this page)." },
                      relaxed_filters: {
                        type: "array",
                        items: { type: "string" },
                        description: "Experiences: filters dropped because the original ones found nothing, or «kommune→fylke» when a kommune was widened to its fylke.",
                      },
                      note: { type: "string", description: "Experiences: bilingual explanation of a relaxation or of a zero answer." },
                      suggestions: { type: "array", items: { type: "string" } },
                      query_interpretation: {
                        type: "object",
                        description: "Only with `q`, when something was read from it.",
                        properties: {
                          source: { type: "string", enum: ["query"] },
                          kommune: { type: "string" },
                          kommuner: { type: "array", items: { type: "string" }, description: "The kommuner of a region (e.g. Lofoten)." },
                          fylke: { type: "string" },
                          fylker: { type: "array", items: { type: "string" }, description: "The fylker of a landsdel (e.g. Nord-Norge)." },
                          category: { type: "string" },
                          season: { type: "string", enum: ["winter", "summer", "spring", "autumn"] },
                          weather: { type: "string", enum: ["rain", "snow", "clear"] },
                          indoor_outdoor: { type: "string", enum: ["indoor", "outdoor"] },
                          terms: {
                            type: "array",
                            items: { type: "string" },
                            description: "Search words, looked up in the title, Norwegian title, description and subcategory: the rows with all of them, or, when no row has all, the rows with the most of them (`note` says how many).",
                          },
                        },
                      },
                      zero_hit_reason: {
                        type: "string",
                        enum: ["unrecognized_query", "place_no_match", "relaxation_exhausted"],
                        description:
                          "Only with `q`, when `count` is 0 instead of an unrelated list: `q` gave nothing to search by or its search words " +
                          "match nothing; the place has no experiences; or every filter read from `q` had to be dropped.",
                      },
                      out_of_area: {
                        type: "boolean",
                        description: "Only with `q`: the request names a place outside Norway (in `q`, fylke, kommune or lat/lng); no results are suggested.",
                      },
                      place: { type: "string", description: "With `out_of_area`: the place named." },
                      out_of_scope: { type: "boolean", description: "Only with `q`: the request is outside experience discovery (buying food); no results are suggested." },
                      scope_reason: { type: "string", enum: ["food_product_purchase"], description: "With `out_of_scope`: why." },
                      valid_categories: {
                        type: "array",
                        items: { type: "string" },
                        description: "With `zero_hit_reason: unrecognized_query`, or when `q` asks for gårdssalg: the experience category slugs.",
                      },
                      results: {
                        type: "array",
                        items: { oneOf: [{ $ref: "#/components/schemas/Experience" }, { $ref: "#/components/schemas/GardssalgProducer" }] },
                      },
                    },
                  },
                  examples: {
                    experiencesQuery: {
                      summary: "q=hvalsafari i Tromsø",
                      value: {
                        vertical: "experiences",
                        query: { kommune: "Tromsø", text_terms: ["hvalsafari"] },
                        count: 1,
                        total: 1,
                        query_interpretation: { source: "query", kommune: "Tromsø", terms: ["hvalsafari"] },
                        results: [
                          {
                            id: "3f1c9a52-8d47-4b8e-9a1f-2c6d5e7b8a90",
                            slug: "winter-whale-safari-from-tromso--3f1c9a52",
                            title: "Winter Whale Safari from Tromsø",
                            title_no: "Vinterhvalsafari fra Tromsø",
                            category: "dyreliv_safari",
                            fylke: "Troms",
                            kommune: "Tromsø",
                            indoor_outdoor: "outdoor",
                            duration_min: 420,
                            price_from: 1600,
                            price_band: "premium",
                            booking_url: "https://example.com/whale-safari",
                            confidence: "high",
                            tags: ["sesong"],
                          },
                        ],
                      },
                    },
                    gardssalg: {
                      summary: "category=gardssalg_smaking&fylke=Vestland",
                      value: {
                        vertical: "gardssalg",
                        query: { fylke: "Vestland" },
                        count: 1,
                        results: [
                          {
                            navn: "Eksempel Sideri",
                            fylke: "Vestland",
                            kommune: "Ulvik",
                            producer_type: "sideri",
                            lat: 60.57,
                            lon: 6.9,
                            geocode_confidence: "high",
                            booking: { live: false, mode: "paused", note: "Reservasjoner åpner snart; ta kontakt via profilsiden. / Bookings open soon; visit the profile page to get in touch." },
                            profile_url: "https://opplevagent.no/kategori/gardssalg/produsent/eksempel-sideri--abc123",
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
            "400": { description: "Invalid query parameters" },
          },
        },
      },
      "/api/opplevelser/categories": {
        get: {
          operationId: "listExperienceCategories",
          summary: "List experience categories",
          description: "Returns distinct categories with the count of published experiences in each.",
          responses: {
            "200": {
              description: "Array of category objects",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      categories: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            category: { type: "string" },
                            count: { type: "integer" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/opplevelser/{id}": {
        get: {
          operationId: "getExperience",
          summary: "Get a single experience by ID",
          parameters: [
            { name: "id", in: "path", required: true, description: "Experience UUID", schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Experience object",
              content: { "application/json": { schema: { type: "object", properties: { experience: { $ref: "#/components/schemas/Experience" } } } } },
            },
            "404": { description: "Not found" },
          },
        },
      },
      "/a2a": {
        get: {
          operationId: "getExperiencesA2ACard",
          summary: "A2A agent card (health check)",
          responses: {
            "200": { description: "Agent card JSON", content: { "application/json": { schema: { type: "object" } } } },
          },
        },
        post: {
          operationId: "experiencesA2AJsonRpc",
          summary: "A2A JSON-RPC 2.0 endpoint",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["jsonrpc", "method", "id"],
                  properties: {
                    jsonrpc: { type: "string", enum: ["2.0"] },
                    method: { type: "string", enum: ["message/send", "tasks/send"] },
                    params: { type: "object" },
                    id: { type: ["string", "number"] },
                  },
                },
                examples: {
                  discover: {
                    summary: "Discover experiences by county and weather",
                    value: { jsonrpc: "2.0", method: "message/send", params: { message: { text: "hva kan vi finne på i Oslo når det regner" } }, id: "1" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "JSON-RPC response",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      jsonrpc: { type: "string" },
                      result: { type: "object" },
                      error: { type: "object" },
                      id: { type: ["string", "number"] },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/.well-known/agent-card.json": {
        get: {
          operationId: "getExperiencesAgentCardWellKnown",
          summary: "A2A Agent Card (well-known)",
          responses: {
            "200": { description: "Agent card", content: { "application/json": { schema: { type: "object" } } } },
          },
        },
      },
      "/llms.txt": {
        get: {
          operationId: "getExperiencesLlmsTxt",
          summary: "LLM-friendly site overview",
          responses: {
            "200": { description: "Plain-text overview for LLMs", content: { "text/plain": { schema: { type: "string" } } } },
          },
        },
      },
    },
    components: {
      schemas: {
        Experience: {
          type: "object",
          properties: {
            id: { type: "string", description: "UUID" },
            title: { type: "string", description: "Experience title" },
            category: { type: "string", nullable: true },
            fylke: { type: "string", nullable: true, description: "County" },
            kommune: { type: "string", nullable: true, description: "Municipality" },
            indoor_outdoor: { type: "string", enum: ["indoor", "outdoor", "both"], nullable: true },
            duration_min: { type: "integer", nullable: true, description: "Minimum duration (minutes)" },
            price_from: { type: "integer", nullable: true, description: "Price from (NOK)" },
            price_band: { type: "string", nullable: true },
            booking_url: { type: "string", nullable: true },
            confidence: { type: "string", enum: ["high", "medium", "low"], nullable: true },
            tags: {
              type: "array",
              description: "Derived cross-cutting filter tags (additive-only; computed from existing fields).",
              items: { type: "string", enum: [...EXPERIENCE_TAGS] },
            },
            distance_km: {
              type: "number",
              nullable: true,
              description:
                "Distance from the caller's lat/lng origin, in kilometers (rounded to 1 decimal). Only present " +
                "when lat/lng were given in the request. Never fabricated: rows with no geocoded location are " +
                "excluded from the result entirely rather than shown with a missing/guessed distance.",
            },
            geo_precision: {
              type: "string",
              enum: ["address", "kommune"],
              nullable: true,
              description:
                "How this row's location (and therefore distance_km) was derived. 'address' = geocoded from the " +
                "provider's exact street address (precise). 'kommune' = a municipality centroid (approximate — " +
                "do not present distance_km as exact for these rows). Only present when lat/lng were given.",
            },
          },
        },
        GardssalgProducer: {
          type: "object",
          description:
            "A gårdssalg (farm-sale drink producer) row — returned by `/api/opplevelser/discover?category=gardssalg_smaking` " +
            "and the `discover_gardssalg` MCP tool. Stored in `experience_providers`, not `experiences` — never mix with the Experience schema.",
          properties: {
            id: {
              type: "string",
              description: "The producer's id — the `provider_id` for `POST /api/opplevelser/book` and the `book_gardssalg` MCP tool.",
            },
            navn: { type: "string" },
            fylke: { type: "string", nullable: true },
            kommune: { type: "string", nullable: true },
            producer_type: { type: "string", nullable: true },
            lat: { type: "number", nullable: true },
            lon: { type: "number", nullable: true },
            geocode_confidence: {
              type: "string",
              enum: ["high", "medium", "low", "no_match", "approximate"],
              nullable: true,
              description:
                "Provider-address geocode quality (`experience_providers.geocode_confidence` — distinct from the " +
                "Experience schema's `geo_precision`, which uses 'address'/'kommune' instead). 'high'/'medium'/'low' " +
                "come from the address-geocoding step; 'approximate' is a kommune-centroid fallback; 'no_match' means " +
                "no coordinates could be resolved (lat/lon are null in that case).",
            },
            booking: {
              type: "object",
              description: "Honest booking status — never claims an active booking flow before the dark-launch gate opens.",
              properties: {
                live: { type: "boolean" },
                mode: { type: "string", enum: ["request", "paused"] },
                note: { type: "string" },
              },
            },
            profile_url: { type: "string", nullable: true },
            distance_km: {
              type: "number",
              nullable: true,
              description: "Only present when lat/lng were given in the request (near-me search).",
            },
          },
        },
      },
    },
  };
}
