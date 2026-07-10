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
            "confidence is medium/high are surfaced.",
          parameters: [
            { name: "fylke", in: "query", description: "County name (e.g. «Oslo», «Troms»)", schema: { type: "string" }, example: "Troms" },
            { name: "kommune", in: "query", description: "Municipality name (e.g. «Tromsø»)", schema: { type: "string" }, example: "Tromsø" },
            { name: "category", in: "query", description: "Category slug (e.g. «dyreliv_safari», «natur_friluft»)", schema: { type: "string" }, example: "dyreliv_safari" },
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
              description: "Discovery result",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      vertical: { type: "string", enum: ["experiences"] },
                      query: { type: "object" },
                      count: { type: "integer" },
                      results: { type: "array", items: { $ref: "#/components/schemas/Experience" } },
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
      },
    },
  };
}
