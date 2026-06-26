/**
 * experiences-mcp.ts — Streamable HTTP MCP server for opplevagent.no
 *
 * orchestrator-pr-33: Mirrors dental-mcp.ts architecture exactly for the
 * experiences vertical. Per-client transport+server pairs with idle-cleanup,
 * registerExperienceTools(server) with server.registerTool(...).
 *
 * Endpoint: POST https://opplevagent.no/mcp  (JSON-RPC tools/call, tools/list, …)
 *           GET  https://opplevagent.no/mcp  (SSE stream for server-to-client notifications)
 *           DELETE https://opplevagent.no/mcp (session cleanup)
 *
 * ChatGPT / Claude Desktop: paste https://opplevagent.no/mcp as the MCP URL.
 *
 * Tools exposed (3):
 *   discover_experiences         — filter-based discovery (fylke, category, weather, …)
 *   list_experience_categories   — all categories with experience counts
 *   get_experience               — fetch one experience by UUID
 *
 * Defensive: if the experiences DB is not open (ENABLE_EXPERIENCES not set),
 * every tool returns a graceful "ingen data / not available" text result —
 * never throws (mirrors safeCategories() in experiences-seo.ts).
 *
 * Rate limiting: uses jsonRpcLimiter (same limiter as experiences-a2a.ts).
 * The host-gate in index.ts inserts /mcp BEFORE /a2a, so the global
 * app.use('/a2a', jsonRpcLimiter) mount is never reached for MCP requests.
 */

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import {
  discoverExperiences,
  listCategories,
  getExperienceById,
  type DiscoverFilter,
} from "../services/experience-store";

import { jsonRpcLimiter } from "../middleware/security";

const router = Router();

// Apply rate limiting to all routes on this router (same pattern as dental-mcp.ts)
router.use(jsonRpcLimiter);

// ─── Zod input schemas (exported for testing) ─────────────────

export const DiscoverExperiencesInputSchema = {
  fylke: z.string().optional().describe(
    "Norwegian county (fylke). Examples: 'Oslo', 'Vestland', 'Troms', 'Rogaland'"
  ),
  kommune: z.string().optional().describe(
    "Norwegian municipality (kommune). Examples: 'Tromsø', 'Bergen', 'Stavanger'"
  ),
  category: z.string().optional().describe(
    "Experience category slug. Examples: 'natur_friluft', 'dyreliv_safari', 'mat_drikke', 'vinter'"
  ),
  weather: z.enum(["rain", "snow", "clear", "any"]).optional().describe(
    "Weather suitability filter. 'rain'/'snow' prefers indoor + weather-independent experiences. Examples: 'rain', 'clear'"
  ),
  season: z.string().optional().describe(
    "Season filter. Examples: 'summer', 'winter', 'spring', 'autumn'"
  ),
  indoor_outdoor: z.enum(["indoor", "outdoor", "both"]).optional().describe(
    "Indoor/outdoor preference. Examples: 'indoor', 'outdoor', 'both'"
  ),
  group_size: z.number().int().positive().optional().describe(
    "Number of people in the group. Used to filter experiences by min/max group capacity. Example: 4"
  ),
  age: z.number().int().nonnegative().optional().describe(
    "Age of the youngest participant. Filters out experiences with a minimum-age requirement above this. Example: 8"
  ),
  max_price: z.number().int().positive().optional().describe(
    "Maximum price per person in Norwegian kroner (NOK). Example: 500"
  ),
  duration_max: z.number().int().positive().optional().describe(
    "Maximum duration in minutes. Example: 120 (2 hours)"
  ),
  language: z.string().optional().describe(
    "Required language for the experience. Examples: 'no', 'en'"
  ),
  limit: z.number().min(1).max(50).default(20).describe(
    "Max results (default 20, max 50)"
  ),
};

export const ListExperienceCategoriesInputSchema = {};

export const GetExperienceInputSchema = {
  id: z.string().uuid().describe(
    "UUID of the experience to fetch. Example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'"
  ),
};

// ─── Tool registrations ──────────────────────────────────────

function registerExperienceTools(server: McpServer): void {
  // Tool 1: discover_experiences
  server.registerTool(
    "discover_experiences",
    {
      title: "Discover Norwegian experiences",
      description:
        "Search the opplevagent.no curated marketplace of Norwegian experiences and activities. " +
        "Filtrer på fylke (county), kategori, vær, sesong, innendørs/utendørs, gruppestørrelse, " +
        "pris og varighet. / Filter by county, category, weather, season, indoor/outdoor, group size, " +
        "price, and duration. " +
        "Returns title, category, location (fylke/kommune), description, and booking URL if available. " +
        "Only verified experiences from active providers (Brreg-checked) are returned. " +
        "Examples: 'hva kan vi finne på i Troms om vinteren?', 'outdoor activities in Oslo for 4 people'.",
      inputSchema: DiscoverExperiencesInputSchema,
      annotations: {
        title: "Discover Norwegian experiences",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ fylke, kommune, category, weather, season, indoor_outdoor, group_size, age, max_price, duration_max, language, limit }) => {
      try {
        const filter: DiscoverFilter = {};
        if (fylke) filter.fylke = fylke;
        if (kommune) filter.kommune = kommune;
        if (category) filter.category = category;
        if (weather) filter.weather = weather;
        if (season) filter.season = season;
        if (indoor_outdoor) filter.indoor_outdoor = indoor_outdoor;
        if (typeof group_size === "number") filter.group_size = group_size;
        if (typeof age === "number") filter.age = age;
        if (typeof max_price === "number") filter.max_price = max_price;
        if (typeof duration_max === "number") filter.duration_max = duration_max;
        if (language) filter.language = language;

        const results = discoverExperiences(filter, limit ?? 20);

        const summary =
          results.length === 0
            ? "Ingen opplevelser funnet med de angitte filtrene. / No experiences found matching the given filters."
            : `Fant ${results.length} opplevelse(r). / Found ${results.length} experience(s).`;

        const formatted = results.map((e) => ({
          id: e.id,
          title: e.title,
          category: e.category ?? null,
          subcategory: e.subcategory ?? null,
          fylke: e.fylke ?? null,
          kommune: e.kommune ?? null,
          indoor_outdoor: e.indoor_outdoor ?? null,
          season: e.season ?? [],
          price_from: e.price_from ?? null,
          price_unit: e.price_unit ?? null,
          duration_min: e.duration_min ?? null,
          duration_max: e.duration_max ?? null,
          description: e.description
            ? e.description.slice(0, 300) + (e.description.length > 300 ? "…" : "")
            : null,
          booking_url: e.booking_url ?? null,
          booking_type: e.booking_type ?? null,
        }));

        const result = {
          summary,
          count: results.length,
          filter_applied: filter,
          experiences: formatted,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        // Defensive: DB not open or other failure -> graceful degradation
        if (err.message?.includes("database") || err.message?.includes("no such table") || err.message?.includes("getDb")) {
          return {
            content: [{ type: "text" as const, text: "Ingen data tilgjengelig for oyeblikket. / No experience data available at this time." }],
          };
        }
        return {
          content: [{ type: "text" as const, text: `Sokefeil: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 2: list_experience_categories
  server.registerTool(
    "list_experience_categories",
    {
      title: "List Norwegian experience categories",
      description:
        "List all experience categories available on opplevagent.no, " +
        "along with the number of verified experiences in each category. " +
        "Henter alle kategorier med antall verifiserte opplevelser. " +
        "Use this to understand what kinds of experiences are available before " +
        "calling discover_experiences with a specific category filter. " +
        "Example question: 'hvilke typer opplevelser finnes i Norge?', 'what categories are available?'.",
      inputSchema: ListExperienceCategoriesInputSchema,
      annotations: {
        title: "List experience categories",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const categories = listCategories();
        const result = {
          count: categories.length,
          categories,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        // Defensive: DB not open -> graceful degradation (mirrors safeCategories())
        if (err.message?.includes("database") || err.message?.includes("no such table") || err.message?.includes("getDb")) {
          return {
            content: [{ type: "text" as const, text: "Ingen kategorier tilgjengelig for oyeblikket. / No category data available at this time." }],
          };
        }
        return {
          content: [{ type: "text" as const, text: `Feil: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 3: get_experience
  server.registerTool(
    "get_experience",
    {
      title: "Get full details for a Norwegian experience",
      description:
        "Fetch complete details for a single experience from opplevagent.no by its UUID. " +
        "Henter fullstendig informasjon om en opplevelse via UUID. " +
        "Returns title, full description, category, location (fylke/kommune/meeting point), " +
        "indoor/outdoor, season, weather suitability, group size limits, age suitability, " +
        "price, duration, languages, booking URL, and booking type. " +
        "Obtain the UUID from discover_experiences results. " +
        "Example: id 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'.",
      inputSchema: GetExperienceInputSchema,
      annotations: {
        title: "Get experience details",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id }) => {
      try {
        const experience = getExperienceById(id);

        if (!experience) {
          return {
            content: [{ type: "text" as const, text: `Ingen opplevelse funnet med id ${id}. / No experience found with id ${id}.` }],
            isError: true,
          };
        }

        // Return the full hydrated experience record
        const result = {
          id: experience.id,
          title: experience.title,
          slug: experience.slug ?? null,
          description: experience.description ?? null,
          category: experience.category ?? null,
          subcategory: experience.subcategory ?? null,
          activity_tags: experience.activity_tags ?? [],
          season: experience.season ?? [],
          indoor_outdoor: experience.indoor_outdoor ?? null,
          weather_dependent: experience.weather_dependent,
          physical_intensity: experience.physical_intensity ?? null,
          duration_min: experience.duration_min ?? null,
          duration_max: experience.duration_max ?? null,
          group_min: experience.group_min ?? null,
          group_max: experience.group_max ?? null,
          age_suitability: experience.age_suitability ?? null,
          min_age: experience.min_age ?? null,
          price_band: experience.price_band ?? null,
          price_from: experience.price_from ?? null,
          price_unit: experience.price_unit ?? null,
          languages: experience.languages ?? [],
          accessibility: experience.accessibility ?? [],
          booking_url: experience.booking_url ?? null,
          booking_type: experience.booking_type ?? null,
          meeting_point: experience.meeting_point ?? null,
          kommune: experience.kommune ?? null,
          fylke: experience.fylke ?? null,
          verification_status: experience.verification_status ?? null,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        // Defensive: DB not open -> graceful degradation
        if (err.message?.includes("database") || err.message?.includes("no such table") || err.message?.includes("getDb")) {
          return {
            content: [{ type: "text" as const, text: "Ingen data tilgjengelig for oyeblikket. / No experience data available at this time." }],
          };
        }
        return {
          content: [{ type: "text" as const, text: `Feil: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}

// ─── Session management ──────────────────────────────────────
// Each MCP client gets its own transport+server pair.
// Sessions are cleaned up after 30 min of inactivity (mirrors dental-mcp.ts).

interface ExperiencesMcpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
}

const experiencesSessions = new Map<string, ExperiencesMcpSession>();
const EXPERIENCES_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Cleanup stale sessions every 5 minutes (mirrors dental-mcp.ts)
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of experiencesSessions) {
    if (now - session.lastActivity > EXPERIENCES_SESSION_TTL_MS) {
      session.transport.close?.();
      experiencesSessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

async function getOrCreateExperiencesSession(
  sessionId?: string
): Promise<{ id: string; session: ExperiencesMcpSession }> {
  if (sessionId && experiencesSessions.has(sessionId)) {
    const session = experiencesSessions.get(sessionId)!;
    session.lastActivity = Date.now();
    return { id: sessionId, session };
  }

  const id = sessionId || randomUUID();

  const server = new McpServer({
    name: "opplevagent",
    version: "0.1.0",
    title: "Opplevagent — norske opplevelser",
    description:
      "AI-discoverable marketplace of Norwegian experiences — curated, Brreg-verified activities " +
      "searchable by county, category, weather, season, and group size. / " +
      "Kuratert markedsplass for norske opplevelser, sokbar for AI-agenter.",
  });

  registerExperienceTools(server);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => id,
  });

  await server.connect(transport);

  const session: ExperiencesMcpSession = {
    transport,
    server,
    lastActivity: Date.now(),
  };
  experiencesSessions.set(id, session);
  return { id, session };
}

// ─── Routes ─────────────────────────────────────────────────

// POST /mcp — Main MCP message handler (JSON-RPC over HTTP)
// The opplevagent host-gate in index.ts dispatches the UNstripped path
// ("/mcp") into this router (no app.use prefix mounting, mirroring
// dental-mcp.ts / dental-a2a.ts). Routes therefore match both "/" and "/mcp"
// so the router works under either mounting style and never falls through
// (next()) to the rfb /mcp router.
router.post(["/", "/mcp"], async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const { session } = await getOrCreateExperiencesSession(sessionId);
    await session.transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error("[experiences-mcp] POST error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "MCP transport error" });
    }
  }
});

// GET /mcp — SSE stream for server-to-client notifications.
// If no mcp-session-id header is present (e.g. a browser navigating directly),
// return a friendly HTML landing page (200) instead of a raw 400 JSON error.
router.get(["/", "/mcp"], async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId) {
    // Browser-friendly landing page — explains what the endpoint is and how
    // to connect. Only shown when the session header is absent (browser visit).
    // MCP POST/session handshake is NOT affected by this branch.
    res.status(200).setHeader("Content-Type", "text/html; charset=utf-8").send(`<!doctype html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opplevagent MCP-endepunkt</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f7f4ee;color:#18130d;line-height:1.6;padding:40px 24px}
  .card{max-width:640px;margin:0 auto;background:#fff;border:1px solid #e4ded0;border-radius:14px;padding:36px 36px 32px;box-shadow:0 6px 18px rgba(24,19,13,.08)}
  h1{font-size:1.45rem;font-weight:800;letter-spacing:-.02em;color:#0e3c36;margin-bottom:8px}
  .sub{color:#544a3e;margin-bottom:24px;font-size:.97rem}
  .label{font-size:.75rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#0c7264;margin-bottom:6px}
  .endpoint{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.92rem;background:#f0ede6;border:1px solid #ddd8cc;border-radius:7px;padding:10px 14px;color:#18130d;margin-bottom:20px;word-break:break-all}
  pre{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.82rem;background:#0e3c36;color:#d4f0e8;border-radius:9px;padding:16px 18px;overflow-x:auto;line-height:1.55;margin-bottom:24px}
  .back{font-size:.88rem;color:#0c7264}
  .back a{color:#0c7264;font-weight:600}
</style>
</head>
<body>
<div class="card">
  <h1>Opplevagent MCP-endepunkt</h1>
  <p class="sub">Dette er <strong>opplevagent.no</strong> sitt MCP-endepunkt. For &aring; koble til trenger du en MCP-klient (f.eks. Claude Desktop, Cursor, eller en AI-assistent med MCP-st&oslash;tte).</p>

  <div class="label">Endepunkt-URL</div>
  <div class="endpoint">https://opplevagent.no/mcp</div>

  <div class="label">curl-eksempel (initialize)</div>
  <pre>curl -X POST https://opplevagent.no/mcp \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"my-agent","version":"1.0"}}}'</pre>

  <div class="label">Tilgjengelige verkt&oslash;y</div>
  <p class="sub" style="margin-bottom:20px">discover_experiences &bull; list_experience_categories &bull; get_experience</p>

  <p class="back">&larr; <a href="/">Tilbake til opplevagent.no</a></p>
</div>
</body>
</html>`);
    return;
  }
  if (!experiencesSessions.has(sessionId)) {
    res.status(400).json({ error: "Missing or invalid mcp-session-id header" });
    return;
  }
  const session = experiencesSessions.get(sessionId)!;
  session.lastActivity = Date.now();
  await session.transport.handleRequest(req, res, req.body);
});

// DELETE /mcp — Session cleanup
router.delete(["/", "/mcp"], async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && experiencesSessions.has(sessionId)) {
    const session = experiencesSessions.get(sessionId)!;
    session.transport.close?.();
    experiencesSessions.delete(sessionId);
  }
  res.status(200).json({ ok: true });
});

// Hard stop — any /mcp/* subpath that did not match above must NOT
// fall through to rfb's /mcp router via next() (mirrors dental-mcp.ts PR-115 pattern).
router.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found on Opplevagent MCP endpoint" });
});

export default router;
