/**
 * dental-openapi.ts — OpenAPI 3.1 spec for finn-tannlege.com
 *
 * PR-113: Compact but complete spec covering all public dental API paths.
 * Built as a JS object so it can be tree-shaken and unit-tested without
 * loading from disk.  Served at GET /openapi.json on the dental host.
 */

import { BRAND_ENTITIES } from "../config/brand-entities";
import { DENTAL_DATA_SOURCES, dentalSourceName, dentalSourceNamesSentence } from "./dental-data-sources";

const DENTAL_BASE_URL =
  process.env.DENTAL_BASE_URL || "https://finn-tannlege.com";

export function getDentalOpenapi(): object {
  const url = (DENTAL_BASE_URL || "https://finn-tannlege.com").replace(/\/$/, "");
  // A2A dev-request 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon (F2-S1):
  // the sources and the Brreg licence come from dental-data-sources.ts, as on
  // the pages. The licence was "CC0 (Brreg data)"; Brreg publishes the
  // register under NLOD 2.0 (data.brreg.no, read 2026-10-19).
  const brreg = DENTAL_DATA_SOURCES.find((s) => s.id === "brreg");
  return {
    openapi: "3.1.0",
    info: {
      title: "Finn-tannlege.com API",
      // dev-request 2026-09-02-dental-profilkvalitet-finn-tannlege (5a): see
      // the identical note in dental-agent-card.ts -- the stale "~6 900"
      // count (raw Brreg-sweep rows, not honestly-filtered clinics) is
      // dropped rather than wired to a live DB count from this DB-free spec
      // module; the live count is not stated here.
      // A2A dev-request 2026-10-16-merkevare-entitet-og-connector-pakker (G3-S8):
      // the sentence that sets Finn-tannlege.com apart from FINN.no, from brand-entities.ts.
      description: (
        `REST API for Norwegian dental clinic discovery, sourced from ${dentalSourceNamesSentence("en")}. ` +
        "All read endpoints are public; no authentication required. " +
        (BRAND_ENTITIES.dental.disambiguation?.en ?? "")
      ).trim(),
      version: "0.1.0",
      contact: { url: `${url}/kontakt` },
      ...(brreg?.license
        ? { license: { name: `${brreg.license.name}, for data from ${dentalSourceName(brreg, "en")}`, url: brreg.license.url } }
        : {}),
    },
    servers: [{ url, description: "Production" }],
    paths: {
      "/api/tannlege/agents": {
        get: {
          operationId: "listDentalAgents",
          summary: "List dental clinics (raw list)",
          description:
            "Returns a raw, paginated list of stored dental clinic records, with no public-catalog filtering. " +
            "For searching, use /api/tannlege/discover. All parameters are optional and combinable.",
          parameters: [
            { name: "q", in: "query", description: "Free-text search (name or city)", schema: { type: "string" }, example: "Oslo tannklinikk" },
            { name: "fylke", in: "query", description: "County name (e.g. «Oslo», «Vestland»)", schema: { type: "string" }, example: "Vestland" },
            { name: "specialty", in: "query", description: "Specialty slug (e.g. «kjeveortopedi», «endodonti»)", schema: { type: "string" }, example: "kjeveortopedi" },
            { name: "helfo_agreement", in: "query", description: "\"true\" to include only Helfo-agreement clinics", schema: { type: "string", enum: ["true", "false", "unknown"] } },
            { name: "acute_vakt", in: "query", description: "1 to include only emergency-duty clinics", schema: { type: "integer", enum: [0, 1] } },
            { name: "enrichment_state", in: "query", description: "Filter by enrichment state", schema: { type: "string", enum: ["raw", "enriched", "thin_site"] } },
            { name: "limit", in: "query", description: "Max results (default 50, max 500)", schema: { type: "integer", default: 50, minimum: 1, maximum: 500 } },
            { name: "offset", in: "query", description: "Pagination offset", schema: { type: "integer", default: 0, minimum: 0 } },
          ],
          responses: {
            "200": {
              description: "Object with count and an array of dental clinic objects",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      count: { type: "integer" },
                      agents: { type: "array", items: { $ref: "#/components/schemas/DentalClinic" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/tannlege/agents/{id}": {
        get: {
          operationId: "getDentalAgent",
          summary: "Get a single clinic by ID",
          parameters: [
            { name: "id", in: "path", required: true, description: "Clinic UUID", schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Object with the dental clinic under agent",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { agent: { $ref: "#/components/schemas/DentalClinic" } } },
                },
              },
            },
            "404": { description: "Not found" },
          },
        },
      },
      "/api/tannlege/agents/{id}/specialists": {
        get: {
          operationId: "getDentalSpecialists",
          summary: "List registered specialists at a clinic",
          parameters: [
            { name: "id", in: "path", required: true, description: "Clinic UUID", schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Array of specialist records",
              content: {
                "application/json": {
                  schema: { type: "array", items: { type: "object", properties: { name: { type: "string" }, specialty: { type: "string" } } } },
                },
              },
            },
          },
        },
      },
      "/api/tannlege/chains": {
        get: {
          operationId: "listDentalChains",
          summary: "List all dental chains",
          description: "Returns distinct chain brands with clinic counts.",
          responses: {
            "200": {
              description: "Array of chain objects",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        chain_brand: { type: "string" },
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
      "/api/tannlege/discover": {
        get: {
          operationId: "discoverDentalAgents",
          summary: "Search dental clinics (primary public search)",
          description:
            "The primary public search. Only real, open clinics are returned (rejected, permanently closed, " +
            "non-clinic and test rows are left out). `q` is free text in Norwegian (e.g. «tannlege i Bergen», " +
            "«kjeveortoped Oslo»); the explicit parameters win over what the text says. `tolkning` in the " +
            "answer says how the text was read.",
          parameters: [
            { name: "q", in: "query", description: "Free-text query in Norwegian", schema: { type: "string" }, example: "tannlege i Bergen" },
            { name: "fylke", in: "query", description: "County name", schema: { type: "string" } },
            { name: "specialty", in: "query", description: "Specialty name or slug", schema: { type: "string" } },
            { name: "poststed", in: "query", description: "City or place name", schema: { type: "string" } },
            { name: "helfo_agreement", in: "query", description: "\"true\" to include only Helfo-agreement clinics (alias: helfo)", schema: { type: "string", enum: ["true", "false", "unknown"] } },
            { name: "helfo", in: "query", description: "Alias for helfo_agreement", schema: { type: "string", enum: ["true", "false", "unknown"] } },
            { name: "akutt", in: "query", description: "1 to include only clinics with an emergency claim (akuttvakt or takes emergency patients)", schema: { type: "integer", enum: [0, 1] } },
            { name: "limit", in: "query", description: "Max results (default 20, max 100)", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
            { name: "offset", in: "query", description: "Pagination offset", schema: { type: "integer", default: 0, minimum: 0 } },
          ],
          responses: {
            "200": {
              description: "Discovery result",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      vertical: { type: "string" },
                      count: { type: "integer", description: "Number of results in this page" },
                      total: { type: "integer", description: "Number of matching clinics in all" },
                      tolkning: { type: "object", description: "How the free text was read (only when q is given)" },
                      results: { type: "array", items: { type: "object", description: "Clinic card with id, navn, org_nr, adresse, postnummer, poststed, fylke, telefon, hjemmeside, helfo_agreement, akutt, badges, profil_url" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/a2a": {
        get: {
          operationId: "getDentalA2ACard",
          summary: "A2A agent card (health check)",
          responses: {
            "200": { description: "Agent card JSON", content: { "application/json": { schema: { type: "object" } } } },
          },
        },
        post: {
          operationId: "dentalA2AJsonRpc",
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
                    method: { type: "string", enum: ["message/send"] },
                    params: { type: "object" },
                    id: { type: ["string", "number"] },
                  },
                },
                examples: {
                  search: {
                    summary: "Search clinics by county",
                    value: { jsonrpc: "2.0", method: "message/send", params: { message: { text: "finn tannlege i Oslo" } }, id: "1" },
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
          operationId: "getDentalAgentCardWellKnown",
          summary: "A2A Agent Card (well-known)",
          responses: {
            "200": { description: "Agent card", content: { "application/json": { schema: { type: "object" } } } },
          },
        },
      },
      "/llms.txt": {
        get: {
          operationId: "getLlmsTxt",
          summary: "LLM-friendly site overview",
          responses: {
            "200": { description: "Plain-text overview for LLMs", content: { "text/plain": { schema: { type: "string" } } } },
          },
        },
      },
      "/mcp": {
        post: {
          operationId: "dentalMcpStreamableHttp",
          summary: "MCP Streamable HTTP endpoint (PR-114)",
          description:
            "Model Context Protocol (MCP) Streamable HTTP transport for finn-tannlege.com. " +
            "Exposes 5 tools: tannlege_search, tannlege_info, tannlege_stats, tannlege_akutt, tannlege_kjeder. " +
            "Compatible with ChatGPT (paste URL as MCP server), Claude Desktop, and any MCP client.",
          externalDocs: {
            description: "MCP Streamable HTTP spec",
            url: "https://modelcontextprotocol.io/docs/concepts/transports",
          },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", description: "MCP JSON-RPC 2.0 message" },
              },
            },
          },
          responses: {
            "200": {
              description: "MCP JSON-RPC response or SSE stream",
              content: {
                "application/json": { schema: { type: "object" } },
                "text/event-stream": { schema: { type: "string" } },
              },
            },
          },
        },
        get: {
          operationId: "dentalMcpSse",
          summary: "MCP SSE notification stream",
          description: "Server-Sent Events stream for MCP server-to-client notifications. Requires mcp-session-id header.",
          responses: {
            "200": { description: "SSE stream", content: { "text/event-stream": { schema: { type: "string" } } } },
            "400": { description: "Missing or invalid mcp-session-id" },
          },
        },
      },
    },
    components: {
      schemas: {
        DentalClinic: {
          type: "object",
          properties: {
            id: { type: "string", description: "UUID" },
            org_nr: { type: "string", description: "9-digit Norwegian organisation number" },
            navn: { type: "string", description: "Clinic name" },
            poststed: { type: "string" },
            fylke: { type: "string" },
            adresse: { type: "string", nullable: true },
            telefon: { type: "string", nullable: true },
            hjemmeside: { type: "string", nullable: true },
            helfo_agreement: { type: "string", enum: ["true", "false", "unknown"] },
            acute_vakt: { type: "integer", nullable: true },
            available_specialties: { type: "array", items: { type: "string" } },
            chain_brand: { type: "string", nullable: true },
            is_chain_member: { type: "integer" },
            verification_status: { type: "string" },
            enrichment_state: { type: "string" },
            lat: { type: "number", nullable: true },
            lng: { type: "number", nullable: true },
          },
        },
      },
    },
  };
}
