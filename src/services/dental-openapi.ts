/**
 * dental-openapi.ts — OpenAPI 3.1 spec for finn-tannlege.com
 *
 * PR-113: Compact but complete spec covering all public dental API paths.
 * Built as a JS object so it can be tree-shaken and unit-tested without
 * loading from disk.  Served at GET /openapi.json on the dental host.
 */

const DENTAL_BASE_URL =
  process.env.DENTAL_BASE_URL || "https://finn-tannlege.com";

export function getDentalOpenapi(): object {
  const url = (DENTAL_BASE_URL || "https://finn-tannlege.com").replace(/\/$/, "");
  return {
    openapi: "3.1.0",
    info: {
      title: "Finn-tannlege.com API",
      description:
        "REST API for Norwegian dental clinic discovery. " +
        "~6 900 clinics sourced from Brreg, HPR, and direct enrichment. " +
        "All read endpoints are public; no authentication required.",
      version: "0.1.0",
      contact: { url: `${url}/kontakt` },
      license: { name: "CC0 (Brreg data)", url: "https://creativecommons.org/publicdomain/zero/1.0/" },
    },
    servers: [{ url, description: "Production" }],
    paths: {
      "/api/tannlege/agents": {
        get: {
          operationId: "listDentalAgents",
          summary: "List / search dental clinics",
          description:
            "Returns a paginated list of dental clinics. All parameters are optional and combinable.",
          parameters: [
            { name: "q", in: "query", description: "Free-text search (name or city)", schema: { type: "string" }, example: "Oslo tannklinikk" },
            { name: "fylke", in: "query", description: "County name (e.g. «Oslo», «Vestland»)", schema: { type: "string" }, example: "Vestland" },
            { name: "specialty", in: "query", description: "Specialty slug (e.g. «kjeveortopedi», «endodonti»)", schema: { type: "string" }, example: "kjeveortopedi" },
            { name: "helfo", in: "query", description: "\"true\" to include only Helfo-agreement clinics", schema: { type: "string", enum: ["true", "false"] } },
            { name: "acute_vakt", in: "query", description: "1 to include only emergency-duty clinics", schema: { type: "integer", enum: [0, 1] } },
            { name: "enrichment_state", in: "query", description: "Filter by enrichment state", schema: { type: "string", enum: ["raw", "enriched"] } },
            { name: "limit", in: "query", description: "Max results (default 50, max 500)", schema: { type: "integer", default: 50, minimum: 1, maximum: 500 } },
            { name: "offset", in: "query", description: "Pagination offset", schema: { type: "integer", default: 0, minimum: 0 } },
          ],
          responses: {
            "200": {
              description: "Array of dental clinic objects",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { $ref: "#/components/schemas/DentalClinic" },
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
              description: "Dental clinic object",
              content: { "application/json": { schema: { $ref: "#/components/schemas/DentalClinic" } } },
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
          summary: "Discover clinics (A2A-friendly discovery endpoint)",
          description: "Alias for /api/tannlege/agents; intended for agent discovery workflows.",
          parameters: [
            { name: "q", in: "query", schema: { type: "string" } },
            { name: "fylke", in: "query", schema: { type: "string" } },
            { name: "specialty", in: "query", schema: { type: "string" } },
            { name: "helfo", in: "query", schema: { type: "string" } },
            { name: "acute_vakt", in: "query", schema: { type: "integer" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          ],
          responses: {
            "200": {
              description: "Discovery result",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      count: { type: "integer" },
                      results: { type: "array", items: { $ref: "#/components/schemas/DentalClinic" } },
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
                      id: {},
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
