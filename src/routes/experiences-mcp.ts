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

// ─── OpenAI Apps SDK UI components (MCP resources) ──────────
// These HTML resources are served via resources/list + resources/read so
// ChatGPT can render inline cards when a tool result references the template.
// Content is fully self-contained (no external CDN) per spec.

const EXPERIENCES_LIST_HTML = `<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Opplevagent — Opplevelser</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 8px; background: #fff; }
  .card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; margin-bottom: 8px; cursor: pointer; }
  .card:hover { background: #f9fafb; }
  .card h3 { margin: 0 0 4px; font-size: 14px; font-weight: 600; color: #111; }
  .card p { margin: 0; font-size: 12px; color: #6b7280; }
  .badge { display: inline-block; background: #f3f4f6; border-radius: 4px; padding: 2px 6px; font-size: 11px; margin-right: 4px; }
</style>
</head>
<body>
<div id="root"></div>
<script>
(async () => {
  const data = await window.openai?.getToolOutput?.() || {};
  const results = data.results || data.experiences || [];
  const root = document.getElementById('root');
  if (!results.length) { root.innerHTML = '<p>Ingen opplevelser funnet.</p>'; return; }
  root.innerHTML = results.map(e => \`
    <div class="card" onclick="window.openai?.sendMessage?.('Vis detaljer for \${e.title}')">
      <h3>\${e.title}</h3>
      <p>
        <span class="badge">\${e.category || ''}</span>
        <span class="badge">\${e.fylke || e.kommune || ''}</span>
        \${e.price_from ? \`<span class="badge">fra \${e.price_from} kr</span>\` : ''}
        \${e.duration_min ? \`<span class="badge">\${e.duration_min} min</span>\` : ''}
      </p>
      <p><a href="https://opplevagent.no/opplevelse/\${e.slug}" target="_blank" rel="noopener">Les mer ↗</a></p>
    </div>
  \`).join('');
})();
</script>
</body>
</html>`;

const EXPERIENCE_DETAIL_HTML = `<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Opplevagent — Detaljer</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 12px; background: #fff; }
  h2 { margin: 0 0 8px; font-size: 16px; color: #111; }
  p { margin: 0 0 6px; font-size: 13px; color: #374151; }
  .meta { font-size: 12px; color: #6b7280; margin-bottom: 8px; }
  .badge { display: inline-block; background: #f3f4f6; border-radius: 4px; padding: 2px 6px; font-size: 11px; margin-right: 4px; }
  a.cta { display: inline-block; margin-top: 8px; padding: 8px 16px; background: #059669; color: #fff; border-radius: 6px; text-decoration: none; font-size: 13px; }
</style>
</head>
<body>
<div id="root"></div>
<script>
(async () => {
  const e = await window.openai?.getToolOutput?.() || {};
  const root = document.getElementById('root');
  root.innerHTML = \`
    <h2>\${e.title || 'Opplevelse'}</h2>
    <div class="meta">
      <span class="badge">\${e.category || ''}</span>
      <span class="badge">\${e.fylke || ''}</span>
      \${e.indoor_outdoor ? \`<span class="badge">\${e.indoor_outdoor}</span>\` : ''}
      \${e.price_from ? \`<span class="badge">fra \${e.price_from} kr</span>\` : ''}
      \${e.duration_min ? \`<span class="badge">\${e.duration_min} min</span>\` : ''}
    </div>
    <p>\${e.description || ''}</p>
    \${e.booking_url ? \`<a class="cta" href="\${e.booking_url}" target="_blank" rel="noopener">Book nå ↗</a>\` : ''}
    <br><a href="https://opplevagent.no/opplevelse/\${e.slug || ''}" target="_blank" rel="noopener" style="font-size:12px;color:#6b7280;">Se på opplevagent.no ↗</a>
  \`;
})();
</script>
</body>
</html>`;

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
      _meta: {
        "openai/outputTemplate": "ui://opplevagent/experiences-list",
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

  // ─── OpenAI Apps SDK resources ──────────────────────────────
  // resources/list returns these two; resources/read returns the HTML content.
  // ChatGPT uses these as output templates referenced by tools via _meta.

  server.resource(
    "experiences-list",
    "ui://opplevagent/experiences-list",
    {
      description: "ChatGPT inline card list for discover_experiences results — renders each experience as a clickable card with title, category, location, price, and duration.",
      mimeType: "text/html",
    },
    async () => ({
      contents: [
        {
          uri: "ui://opplevagent/experiences-list",
          text: EXPERIENCES_LIST_HTML,
          mimeType: "text/html",
        },
      ],
    })
  );

  server.resource(
    "experience-detail",
    "ui://opplevagent/experience-detail",
    {
      description: "ChatGPT inline card for get_experience results — renders full details for a single experience with title, meta badges, description, and a booking CTA.",
      mimeType: "text/html",
    },
    async () => ({
      contents: [
        {
          uri: "ui://opplevagent/experience-detail",
          text: EXPERIENCE_DETAIL_HTML,
          mimeType: "text/html",
        },
      ],
    })
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
      _meta: {
        "openai/outputTemplate": "ui://opplevagent/experience-detail",
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

// GET /mcp — SSE stream for server-to-client notifications
router.get(["/", "/mcp"], async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !experiencesSessions.has(sessionId)) {
    // Return a human-friendly landing page for browser GET (Accept: text/html, no session).
    // The MCP POST/session handshake path is unaffected — this branch only fires when
    // there is no valid session header, which a real MCP client would never send as GET.
    const accept = req.headers["accept"] || "";
    if (accept.includes("text/html")) {
      res.status(200).contentType("text/html").send(`<!doctype html>
<html lang="no">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Opplevagent MCP — Model Context Protocol</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 24px;color:#1a1a1a;line-height:1.6}
h1{font-size:1.5rem;margin-bottom:.25rem}p{margin:.75rem 0}code{background:#f0f0f0;padding:2px 6px;border-radius:4px;font-size:.9em}
pre{background:#f6f8fa;border:1px solid #e1e4e8;border-radius:6px;padding:16px;overflow-x:auto;font-size:.85rem}
a{color:#0070f3}.back{display:inline-block;margin-top:24px;color:#555;text-decoration:none;font-size:.9rem}</style>
</head>
<body>
<h1>Opplevagent MCP-endepunkt</h1>
<p>Dette er Opplevagent sitt <a href="https://modelcontextprotocol.io" rel="noopener">Model Context Protocol</a>-endepunkt (Streamable HTTP). Det er designet for AI-agenter og MCP-klienter, ikke nettlesere.</p>
<p><strong>Koble til fra Claude Desktop / ChatGPT:</strong><br>Lim inn denne URL-en som MCP-server:</p>
<pre>https://opplevagent.no/mcp</pre>
<p><strong>Tilgjengelige verktøy:</strong></p>
<ul>
<li><code>discover_experiences</code> — finn opplevelser etter fylke, kategori, vær, sesong, pris, varighet</li>
<li><code>list_experience_categories</code> — alle kategorier med antall opplevelser</li>
<li><code>get_experience</code> — hent én opplevelse med full profil</li>
</ul>
<p><strong>For utviklere — eksempel (cURL):</strong></p>
<pre>curl -X POST https://opplevagent.no/mcp \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'</pre>
<p>Se også: <a href="/.well-known/agent-card.json">Agent Card</a> · <a href="/openapi.json">OpenAPI 3.1</a> · <a href="/llms.txt">llms.txt</a></p>
<a class="back" href="/">← Tilbake til Opplevagent</a>
</body></html>`);
      return;
    }
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
