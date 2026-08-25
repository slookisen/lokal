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
 * Tools exposed (5):
 *   discover_experiences         — filter-based discovery (fylke, category, weather, …)
 *   list_experience_categories   — all categories with experience counts
 *   get_experience               — fetch one experience by UUID
 *   discover_gardssalg           — filter-based discovery over the gårdssalg
 *                                  (farm-sale drink producer) vertical, which
 *                                  has zero rows in `experiences` (dev-request
 *                                  2026-07-20-gardssalg-mcp-discoverability)
 *   book_gardssalg                — submit a booking REQUEST for a gårdssalg
 *                                  producer (dev-request 2026-07-21-mcp-
 *                                  booking-tool). A THIN wrapper over the SAME
 *                                  createBooking()/sendBookingConfirmation()/
 *                                  sendProducerNotification() chain the web
 *                                  form (POST /api/opplevelser/book) uses —
 *                                  same table, same confirm-token lifecycle,
 *                                  same gates. ALWAYS returns a pending/draft
 *                                  result; this tool can never itself confirm
 *                                  a booking — only the producer's response
 *                                  (confirm / suggest another time / decline,
 *                                  existing, untouched flow) can do that. The
 *                                  guest's emailed link is a read-only status
 *                                  link, never a confirm-action.
 *
 * Defensive: if the experiences DB is not open (ENABLE_EXPERIENCES not set),
 * every tool returns a graceful "ingen data / not available" text result —
 * never throws (mirrors safeCategories() in experiences-seo.ts).
 *
 * Rate limiting: uses jsonRpcLimiter (same limiter as experiences-a2a.ts).
 * The host-gate in index.ts inserts /mcp BEFORE /a2a, so the global
 * app.use('/a2a', jsonRpcLimiter) mount is never reached for MCP requests.
 */

import { isPlausibleNorwayCoord } from "../services/geo-distance";
import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import {
  discoverExperiencesRelaxed,
  buildRelaxationNote,
  buildNarrowingSuggestions,
  listCategories,
  // dev-request 2026-06-23-experiences-richer-profiles, faithfulness-
  // inflow slice (2026-08-25): get_experience reads through the PUBLISH-
  // GATED by-id variant — same PUBLISH_GATE_SQL as discover_experiences —
  // so a quarantined (needs_review/rejected) or dedup-merged-away row is
  // indistinguishable from a missing id to MCP callers.
  getPublishedExperienceById,
  searchGardssalgProviders,
  countGardssalgProviders,
  getProviderById,
  type DiscoverFilter,
  type GardssalgSearchFilter,
} from "../services/experience-store";
// isBookingPaused: used both by discover_gardssalg (this tool's query already
// excludes catalog_hidden=1 rows entirely — see searchGardssalgProviders'
// base WHERE clause — so catalog_hidden is always absent/undefined at that
// call site; isBookingPaused(providerBookingLive) with catalog_hidden
// undefined falls straight to the "real providers: still need the global
// master switch" branch — identical behavior to a normal (non-hidden)
// provider passed explicitly) AND by book_gardssalg below (there
// catalog_hidden IS passed, from getProviderById's full row, exactly like
// POST /api/opplevelser/book does).
//
// book_gardssalg (dev-request 2026-07-21-mcp-booking-tool) reuses — never
// forks — the exact same booking chain as the web form:
//   BookingInputSchema  — the SAME zod validation POST /api/opplevelser/book
//                         runs (src/routes/opplevelser.ts) via .safeParse().
//   createBooking()     — the SAME DB write (gardssalg_bookings), confirm-
//                         token + respond-token issuance. Never reimplemented
//                         here. Only the optional `source` argument (added
//                         additively, default unchanged "opplevagent") is new
//                         — purely an analytics channel stamp, no behavior
//                         change to validation, gating, or token lifecycle.
//   sendBookingConfirmation() / sendProducerNotification() — the SAME guest +
//                         producer emails, fire-and-forget exactly as the web
//                         route does it.
// This tool NEVER calls resolveBooking/producerRespondConfirm/any confirm-
// token verification logic — those are untouched. A booking created here can
// only ever become confirmed once the PRODUCER responds (confirms, proposes
// another time, or declines) via their own emailed respond-link, same as
// every other channel — the guest's emailed link is a read-only status page
// and cannot finalize anything.
import {
  isBookingPaused,
  createBooking,
  BookingInputSchema,
  sendBookingConfirmation,
  sendProducerNotification,
  BOOKING_NOT_ACTIVATED_MSG,
} from "../services/booking-store";

import { jsonRpcLimiter } from "../middleware/security";
import { conversationService, buildRequestMeta, type RequestMeta } from "../services/conversation-service";

const router = Router();

// dev-request 2026-07-20-gardssalg-mcp-discoverability: same convention as
// booking-store.ts / opplevelser.ts (APP_URL = process.env.APP_URL ||
// "https://opplevagent.no") — used to build the discover_gardssalg
// profile_url below.
const APP_URL = process.env.APP_URL || "https://opplevagent.no";

// Apply rate limiting to all routes on this router (same pattern as dental-mcp.ts)
router.use(jsonRpcLimiter);

// ─── Conversation logging (dev-request 2026-07-10-opplevagent-conversation-logging, slice 1) ──
// Deliberate, narrow exception to this module's content-isolation from the rfb DB:
// `conversations` is a SHARED cross-vertical table (main db, conversation-service.ts),
// tagged per-row with vertical_id — this is agent-traffic observability, not experience
// content. Experience content still goes exclusively through experience-store.ts /
// getDb('experiences').
//
// FAIL-OPEN IS ABSOLUTE: these are live, agent-facing tool calls. A logging failure
// must NEVER change the tool result a real agent gets — every call site wraps this
// in try/catch and ignores it.
interface ExperiencesRequestCtx {
  requestMeta?: RequestMeta;
  clientIdentity?: string;
}

function logExperiencesInteraction(opts: {
  skill: string;
  queryText?: string;
  ctx?: ExperiencesRequestCtx;
}): void {
  conversationService.startConversation({
    verticalId: "experiences",
    source: "mcp",
    queryText: opts.queryText || opts.skill,
    clientIdentity: opts.ctx?.clientIdentity,
    requestMeta: opts.ctx?.requestMeta,
    autoRespond: false,
  });
}

// ─── MCP client identity detection (mirrors mcp.ts's detectMcpClient) ────────
export function detectExperiencesMcpClient(req: Request): string | undefined {
  const ua = (req.headers["user-agent"] as string || "").toLowerCase();
  const origin = (req.headers["origin"] as string || "").toLowerCase();

  if (ua.includes("chatgpt") || ua.includes("openai") || origin.includes("openai") || origin.includes("chatgpt")) return "ChatGPT";
  if (ua.includes("claude") || origin.includes("claude.ai") || origin.includes("anthropic")) return "Claude";
  if (ua.includes("cursor")) return "Cursor";
  if (ua.includes("copilot") || origin.includes("github.com")) return "GitHub Copilot";
  if (ua.includes("windsurf")) return "Windsurf";
  if (ua.includes("cline")) return "Cline";
  if (ua.includes("continue")) return "Continue";
  if (ua.includes("python")) return "Python SDK";
  if (ua.includes("node")) return "Node SDK";
  return undefined;
}

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
  lat: z.number().min(-90).max(90).optional().describe(
    "Origin latitude for a near-me search (decimal degrees). Must be given together with lng. Example: 69.65 (Tromsø)"
  ),
  lng: z.number().min(-180).max(180).optional().describe(
    "Origin longitude for a near-me search (decimal degrees). Must be given together with lat. Example: 18.95 (Tromsø)"
  ),
  radius_km: z.number().positive().max(5000).optional().describe(
    "Max distance from lat/lng in kilometers. Only applies when lat/lng are given. Example: 50"
  ),
  sort: z.enum(["distance"]).optional().describe(
    "'distance' — sort results ascending by distance from lat/lng. Already the default whenever lat/lng are given; this makes the request explicit."
  ),
  limit: z.number().min(1).max(50).default(20).describe(
    "Max results (default 20, max 50)"
  ),
};

export const ListExperienceCategoriesInputSchema = {};

// dev-request 2026-07-20-gardssalg-mcp-discoverability: same shape/style as
// DiscoverExperiencesInputSchema above, scoped to the gårdssalg (farm-sale
// drink producer) vertical's own columns on experience_providers.
export const DiscoverGardssalgInputSchema = {
  fylke: z.string().optional().describe(
    "Norwegian county (fylke) of the producer. Examples: 'Oslo', 'Vestland', 'Troms', 'Rogaland'"
  ),
  kommune: z.string().optional().describe(
    "Norwegian municipality (kommune) of the producer. Examples: 'Tromsø', 'Bergen', 'Stavanger'"
  ),
  producer_type: z.string().optional().describe(
    "Type of drink producer. Examples: 'bryggeri' (brewery), 'cideri' (cidery), 'vingård' (vineyard), 'destilleri' (distillery), 'mjøderi' (meadery), 'seltzeri'"
  ),
  booking_live: z.boolean().optional().describe(
    "When true, only return producers that currently accept direct bookings. Omit to include producers regardless of booking status."
  ),
  lat: z.number().min(-90).max(90).optional().describe(
    "Origin latitude for a near-me search (decimal degrees). Must be given together with lng. Example: 69.65 (Tromsø)"
  ),
  lng: z.number().min(-180).max(180).optional().describe(
    "Origin longitude for a near-me search (decimal degrees). Must be given together with lat. Example: 18.95 (Tromsø)"
  ),
  radius_km: z.number().positive().max(5000).optional().describe(
    "Max distance from lat/lng in kilometers. Only applies when lat/lng are given. Example: 50"
  ),
  limit: z.number().min(1).max(50).default(20).describe(
    "Max results (default 20, max 50)"
  ),
};

export const GetExperienceInputSchema = {
  id: z.string().uuid().describe(
    "UUID of the experience to fetch. Example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'"
  ),
};

// dev-request 2026-07-21-mcp-booking-tool (Daniel GO 2026-07-21): input for
// book_gardssalg. Deliberately LOOSE here (basic types + describe() only,
// no .email()/.int()/.min()/.max() business rules) — the authoritative
// validation is BookingInputSchema (services/booking-store.ts), run via
// .safeParse() inside the handler below, so the actual rules live in exactly
// one place and can never drift between the web form and this tool. Field
// names match BookingInput 1:1 so the handler can hand the parsed object
// straight to BookingInputSchema without any renaming/remapping step.
export const BookGardssalgInputSchema = {
  provider_id: z.string().describe(
    "The gårdssalg producer's id, from a discover_gardssalg result (NOT the profile slug). Example: '3f1b2c4d-...'"
  ),
  experience_id: z.string().optional().describe(
    "Optional experience UUID if this booking is for a specific listed experience rather than a general gårdssalg visit."
  ),
  slot_at: z.string().describe(
    "Requested visit date/time, local (Europe/Oslo), format 'YYYY-MM-DDTHH:MM'. Example: '2026-08-15T13:00'. This is a REQUEST — the producer may confirm, suggest another time, or decline."
  ),
  party_size: z.number().describe(
    "Number of people in the group (1-50). Example: 4"
  ),
  guest_name: z.string().describe(
    "Full name of the person the reservation is for. Example: 'Kari Nordmann'"
  ),
  guest_email: z.string().describe(
    "Guest's email address — REQUIRED. Receives a confirmation-of-request email plus a read-only status link; the booking stays pending until the PRODUCER responds (confirms, proposes another time, or declines) — the guest's link cannot finalize anything. Example: 'kari@example.no'"
  ),
  guest_phone: z.string().optional().describe(
    "Optional guest phone number."
  ),
  notes: z.string().optional().describe(
    "Optional free-text note to the producer (e.g. dietary needs, arrival details)."
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

function registerExperienceTools(
  server: McpServer,
  getClientIdentity?: () => string | undefined,
  getRequestMeta?: () => RequestMeta | undefined,
): void {
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
        "Also supports near-me search via lat/lng (+ optional radius_km): when given, results include " +
        "a rounded distance_km and a geo_precision flag ('address' = exact, 'kommune' = approximate " +
        "municipality centroid) and are sorted nearest-first. " +
        "Returns title, category, location (fylke/kommune), description, and booking URL if available. " +
        "Only verified experiences from active providers (Brreg-checked) are returned. " +
        "Examples: 'hva kan vi finne på i Troms om vinteren?', 'outdoor activities in Oslo for 4 people', " +
        "'experiences within 50km of lat 69.65 / lng 18.95'.",
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
    async ({ fylke, kommune, category, weather, season, indoor_outdoor, group_size, age, max_price, duration_max, language, lat, lng, radius_km, sort, limit }) => {
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
        if (typeof lat === "number") filter.lat = lat;
        if (typeof lng === "number") filter.lng = lng;
        if (typeof radius_km === "number") filter.radius_km = radius_km;
        if (sort) filter.sort = sort;
        const hasGeo = typeof filter.lat === "number" && typeof filter.lng === "number";

        const { results, relaxedKeys } = discoverExperiencesRelaxed(filter, limit ?? 20);
        const relaxationNote = buildRelaxationNote(relaxedKeys);

        let summary =
          results.length === 0
            ? "Ingen opplevelser funnet med de angitte filtrene. / No experiences found matching the given filters."
            : `Fant ${results.length} opplevelse(r). / Found ${results.length} experience(s).`;
        if (relaxationNote) summary += ` ${relaxationNote}`;

        const suggestions = buildNarrowingSuggestions(results, relaxedKeys);

        const formatted = results.map((e) => ({
          id: e.id,
          slug: e.slug ?? null,
          title: e.title,
          title_no: e.title_no ?? null,
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
          tags: e.tags ?? [],
          // Only present when an origin (lat/lng) was given. geo_precision
          // tells the caller whether distance_km is an exact address-based
          // distance or an approximate kommune-centroid distance — never
          // presented as exact when it isn't.
          ...(hasGeo ? { distance_km: e.distance_km ?? null, geo_precision: e.geo_precision ?? null } : {}),
        }));

        const result = {
          summary,
          count: results.length,
          filter_applied: filter,
          relaxed_filters: relaxedKeys.length > 0 ? relaxedKeys : undefined,
          suggestions: suggestions.length > 0 ? suggestions : undefined,
          experiences: formatted,
        };

        try {
          logExperiencesInteraction({
            skill: "discover_experiences",
            queryText: Object.keys(filter).length ? JSON.stringify(filter) : undefined,
            ctx: { clientIdentity: getClientIdentity?.(), requestMeta: getRequestMeta?.() },
          });
        } catch { /* fail-open: never affects the tool result */ }

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
        // dev-request 2026-07-20-gardssalg-mcp-discoverability: the gårdssalg
        // vertical (farm-sale drink producers) has zero rows in `experiences`
        // (see getGardssalgProviderBySlug's doc comment in experience-store.ts)
        // so listCategories() never surfaces it — append one synthetic entry
        // so agents can discover it exists before calling discover_gardssalg.
        // Copy first: listCategories() returns a fresh array from a fresh
        // .all() call each time, but never mutate a store function's return
        // value on principle.
        const categories = [...listCategories()];
        categories.push({ category: "gardssalg_smaking", count: countGardssalgProviders() });
        const result = {
          count: categories.length,
          categories,
        };
        try {
          logExperiencesInteraction({
            skill: "list_experience_categories",
            ctx: { clientIdentity: getClientIdentity?.(), requestMeta: getRequestMeta?.() },
          });
        } catch { /* fail-open: never affects the tool result */ }
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
        // Publish-gated read (see the import comment above): a row failing
        // the publish gate returns the exact same not-found result as a
        // missing id — never a distinguishable "exists but hidden" answer.
        const experience = getPublishedExperienceById(id);

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
          title_no: experience.title_no ?? null,
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
          tags: experience.tags ?? [],
        };

        try {
          logExperiencesInteraction({
            skill: "get_experience",
            queryText: id,
            ctx: { clientIdentity: getClientIdentity?.(), requestMeta: getRequestMeta?.() },
          });
        } catch { /* fail-open: never affects the tool result */ }

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

  // Tool 4: discover_gardssalg (dev-request 2026-07-20-gardssalg-mcp-
  // discoverability). Gårdssalg producers have zero rows in `experiences` —
  // see getGardssalgProviderBySlug's doc comment in experience-store.ts —
  // so discover_experiences/get_experience never surface them. This tool is
  // the dedicated search surface over experience_providers for that
  // vertical, backed by searchGardssalgProviders().
  server.registerTool(
    "discover_gardssalg",
    {
      title: "Discover Norwegian farm-sale drink producers (gårdssalg)",
      description:
        "Search opplevagent.no's gårdssalg (farm-sale) vertical — Brreg-registered Norwegian drink " +
        "producers (bryggeri/cideri/vingård/destilleri/mjøderi/seltzeri) selling directly from the farm. " +
        "Finn norske gårdssalg-produsenter (drikkeprodusenter som selger direkte fra gården) etter fylke, " +
        "kommune og produsenttype. / Filter by county (fylke), municipality (kommune), and producer type. " +
        "Also supports near-me search via lat/lng (+ optional radius_km): when given, results include a " +
        "rounded distance_km and are sorted nearest-first, and rows with no geocoded location are excluded " +
        "(never a fabricated distance). Returns name, location, producer type, and an honest booking status " +
        "(live direct booking vs. a dark-launch 'coming soon' note — never overclaims booking availability). " +
        "Examples: 'gårdssalg i Vestland', 'cideri near lat 60.4 / lng 5.3', 'bryggeri med booking'.",
      inputSchema: DiscoverGardssalgInputSchema,
      annotations: {
        title: "Discover gårdssalg producers",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ fylke, kommune, producer_type, booking_live, lat, lng, radius_km, limit }) => {
      try {
        const filter: GardssalgSearchFilter = {};
        if (fylke) filter.fylke = fylke;
        if (kommune) filter.kommune = kommune;
        if (producer_type) filter.producer_type = producer_type;
        if (typeof booking_live === "boolean") filter.booking_live = booking_live;
        if (typeof lat === "number") filter.lat = lat;
        if (typeof lng === "number") filter.lng = lng;
        if (typeof radius_km === "number") filter.radius_km = radius_km;
        const hasGeo = typeof filter.lat === "number" && typeof filter.lng === "number";

        const results = searchGardssalgProviders(filter, limit ?? 20);

        const summary =
          results.length === 0
            ? "Ingen gårdssalg-produsenter funnet med de angitte filtrene. / No gårdssalg producers found matching the given filters."
            : `Fant ${results.length} gårdssalg-produsent(er). / Found ${results.length} gårdssalg producer(s).`;

        const formatted = results.map((row) => {
          // catalog_hidden is never 1 here — searchGardssalgProviders()'s base
          // WHERE clause already excludes those rows entirely — so this call
          // site never needs to (and never does) pass a catalog_hidden arg.
          const live = !isBookingPaused(row.booking_live);
          return {
            navn: row.navn,
            fylke: row.fylke ?? null,
            kommune: row.kommune ?? null,
            producer_type: row.producer_type ?? null,
            // An impossible coordinate is reported as "we do not know", not as a
            // position (Daniel 2026-08-25). An agent that trusts lat/lon would
            // otherwise route a traveller at a producer sitting on 0/0.
            lat: isPlausibleNorwayCoord(row.lat, row.lon) ? row.lat : null,
            lon: isPlausibleNorwayCoord(row.lat, row.lon) ? row.lon : null,
            geocode_confidence: row.geocode_confidence ?? null,
            booking: {
              live,
              mode: live ? ("request" as const) : ("paused" as const),
              note: live
                ? "Book direkte. / Book directly."
                : "Reservasjoner åpner snart; ta kontakt via profilsiden. / Bookings open soon; visit the profile page to get in touch.",
            },
            profile_url: row.slug ? `${APP_URL}/kategori/gardssalg/produsent/${row.slug}` : null,
            // Only present when an origin (lat/lng) was given — mirrors
            // discover_experiences's own ...(hasGeo ? {...} : {}) spread.
            ...(hasGeo ? { distance_km: row.distance_km ?? null } : {}),
          };
        });

        const result = {
          summary,
          count: results.length,
          filter_applied: filter,
          gardssalg_producers: formatted,
        };

        try {
          logExperiencesInteraction({
            skill: "discover_gardssalg",
            queryText: Object.keys(filter).length ? JSON.stringify(filter) : undefined,
            ctx: { clientIdentity: getClientIdentity?.(), requestMeta: getRequestMeta?.() },
          });
        } catch { /* fail-open: never affects the tool result */ }

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

  // Tool 5: book_gardssalg (dev-request 2026-07-21-mcp-booking-tool, Daniel
  // GO 2026-07-21). A THIN wrapper over the EXACT SAME booking chain
  // POST /api/opplevelser/book uses (opplevelser.ts) — see the import
  // comment above for the full reuse list. This tool can only ever produce
  // the same 'reserved'/pending draft state the web form produces; it never
  // calls, and this file never imports, any confirm-token verification
  // logic — a booking becomes real only once the PRODUCER responds (confirm /
  // suggest another time / decline) via their own emailed respond-link
  // (existing, untouched flow). The guest's emailed link is read-only status,
  // never a confirm action.
  server.registerTool(
    "book_gardssalg",
    {
      title: "Request a gårdssalg booking (pending — email confirmation required)",
      description:
        "Submit a booking REQUEST for a Norwegian gårdssalg (farm-sale) producer discovered via " +
        "discover_gardssalg. Send inn en reservasjonsforespørsel for et gårdssalg-besøk. " +
        "IMPORTANT: this NEVER creates a confirmed booking — it creates a PENDING request, exactly " +
        "like the producer's own website form. The PRODUCER reviews the request and responds " +
        "(confirms, proposes another time, or declines); guest_email only receives a read-only " +
        "status link, never anything that can finalize the booking. No payment is involved " +
        "(pickup/visit, pay on arrival, as today). Only producers with an active booking status " +
        "(see discover_gardssalg's booking.live field) can be booked — a paused/not-yet-onboarded " +
        "producer is rejected with a clear message, never a silent failure. " +
        "VIKTIG: oppretter ALDRI en bekreftet booking — kun en avventende forespørsel; produsenten " +
        "mottar forespørselen og svarer (bekrefter, foreslår nytt tidspunkt eller avslår). " +
        "Required: provider_id (from discover_gardssalg), slot_at (requested date/time), party_size, " +
        "guest_name, guest_email. Optional: experience_id, guest_phone, notes. " +
        "Example: book a table for 4 at provider '3f1b2c4d-...' for '2026-08-15T13:00' for " +
        "'Kari Nordmann' <kari@example.no>.",
      inputSchema: BookGardssalgInputSchema,
      annotations: {
        title: "Request a gårdssalg booking",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ provider_id, experience_id, slot_at, party_size, guest_name, guest_email, guest_phone, notes }) => {
      try {
        // Build a candidate object matching BookingInput's own field names
        // and hand it straight to BookingInputSchema.safeParse() — the SAME
        // zod schema POST /api/opplevelser/book runs. This is the ONLY place
        // the actual business rules (email format, party_size 1-50, string
        // length caps, …) are enforced; BookGardssalgInputSchema above is
        // deliberately loose so those rules are never duplicated/forked.
        const candidate: Record<string, unknown> = {
          provider_id,
          slot_at,
          party_size,
          guest_name,
          guest_email,
        };
        if (experience_id) candidate.experience_id = experience_id;
        if (guest_phone) candidate.guest_phone = guest_phone;
        if (notes) candidate.notes = notes;

        const parsed = BookingInputSchema.safeParse(candidate);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ");
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                pending: false,
                error: "invalid_input",
                message: `Ugyldig forespørsel: ${issues}. / Invalid request: ${issues}.`,
              }, null, 2),
            }],
            isError: true,
          };
        }

        // ─── Same gate as POST /api/opplevelser/book (dark-launch-stop) ───
        // Only booking_live=1 producers, AND (for real, non-hidden providers)
        // only while BOOKING_DISPATCH_ENABLED="true" globally — see
        // isBookingPaused() in services/booking-store.ts, never re-derived
        // here. An unknown provider_id falls through the same path (no row
        // -> booking_live undefined -> "not live"), same as the web form.
        const provider = getProviderById(parsed.data.provider_id) as
          | { booking_live?: number | null; epost?: string | null; catalog_hidden?: number | null }
          | null;
        if (isBookingPaused(provider?.booking_live ?? null, provider?.catalog_hidden ?? null)) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                pending: false,
                rejected: true,
                reason: "not_live",
                message:
                  BOOKING_NOT_ACTIVATED_MSG +
                  " / Booking is not activated for this producer yet.",
              }, null, 2),
            }],
          };
        }

        let booking;
        try {
          // "mcp" only stamps the channel column for analytics — createBooking()
          // is the exact same function (same DB table, same confirm-token +
          // respond-token issuance) the web form calls; nothing here reimplements it.
          booking = createBooking(parsed.data, "mcp");
        } catch (err: any) {
          console.error("[book_gardssalg] createBooking failed", err);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                pending: false,
                error: "internal_error",
                message: "Kunne ikke opprette påmelding. / Could not create the booking request.",
              }, null, 2),
            }],
            isError: true,
          };
        }

        // Fire-and-forget — the SAME two sends POST /api/opplevelser/book
        // triggers, never blocking the tool response on either.
        sendBookingConfirmation(booking).catch((e) =>
          console.error("[book_gardssalg] confirmation email failed", booking.booking_ref, e),
        );
        sendProducerNotification(booking, provider?.epost ?? null).catch((e) =>
          console.error("[book_gardssalg] producer notification failed", booking.booking_ref, e),
        );

        try {
          logExperiencesInteraction({
            skill: "book_gardssalg",
            queryText: booking.booking_ref,
            ctx: { clientIdentity: getClientIdentity?.(), requestMeta: getRequestMeta?.() },
          });
        } catch { /* fail-open: never affects the tool result */ }

        // NB: deliberately NEVER returns confirm_token/confirm_url — exactly
        // like POST /api/opplevelser/book's own response (see that handler's
        // comment): that credential belongs to the PRODUCER's attendance-
        // resolution flow, and handing it to the calling agent would let it
        // resolve its own booking. This tool has no way to confirm a
        // booking — only the PRODUCER's own response (via their emailed
        // respond-link) can do that.
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              pending: true,
              status: booking.status,
              booking_ref: booking.booking_ref,
              source: booking.source,
              confirmation_required: true,
              message:
                `Reservasjonsforespørsel mottatt (${booking.booking_ref}) — status: PENDING/AVVENTER. ` +
                `En bekreftelse på forespørselen er sendt til ${booking.guest_email}; produsenten er varslet ` +
                `og svarer på e-post (bekrefter, foreslår nytt tidspunkt eller avslår) — reservasjonen blir ` +
                `IKKE endelig før produsenten har svart. / ` +
                `Reservation request received (${booking.booking_ref}) — status: PENDING. A confirmation ` +
                `email has been sent to ${booking.guest_email}; the producer has been notified and will ` +
                `respond by email (confirm, propose another time, or decline) — the booking only becomes ` +
                `final once the producer responds, and this tool can never confirm it itself.`,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Bookingfeil: ${err.message}` }],
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
  clientIdentity?: string;
  requestMeta?: RequestMeta;  // (dev-request 2026-07-10-opplevagent-conversation-logging) internal-traffic classification signals
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
  sessionId?: string,
  req?: Request
): Promise<{ id: string; session: ExperiencesMcpSession }> {
  if (sessionId && experiencesSessions.has(sessionId)) {
    const session = experiencesSessions.get(sessionId)!;
    session.lastActivity = Date.now();
    if (!session.clientIdentity && req) {
      session.clientIdentity = detectExperiencesMcpClient(req);
    }
    if (!session.requestMeta && req) {
      session.requestMeta = buildRequestMeta(req);
    }
    return { id: sessionId, session };
  }

  const id = sessionId || randomUUID();
  const clientIdentity = req ? detectExperiencesMcpClient(req) : undefined;
  const requestMeta = req ? buildRequestMeta(req) : undefined;

  const server = new McpServer({
    name: "opplevagent",
    version: "0.1.0",
    title: "Opplevagent — norske opplevelser",
    description:
      "AI-discoverable marketplace of Norwegian experiences — curated, Brreg-verified activities " +
      "searchable by county, category, weather, season, and group size. / " +
      "Kuratert markedsplass for norske opplevelser, sokbar for AI-agenter.",
  });

  // Getters read live from the sessions map (by id) rather than closing over
  // a snapshot, so a later request on the same session that resolves a
  // clientIdentity/requestMeta the first request couldn't (see the reuse
  // branch above) is visible to tool calls made after that point too.
  registerExperienceTools(
    server,
    () => experiencesSessions.get(id)?.clientIdentity,
    () => experiencesSessions.get(id)?.requestMeta,
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => id,
  });

  await server.connect(transport);

  const session: ExperiencesMcpSession = {
    transport,
    server,
    lastActivity: Date.now(),
    clientIdentity,
    requestMeta,
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
    const { session } = await getOrCreateExperiencesSession(sessionId, req);
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
<li><code>discover_gardssalg</code> — finn gårdssalg-produsenter etter fylke, kommune, produsenttype, nær-meg og bookingstatus</li>
<li><code>book_gardssalg</code> — send inn en reservasjonsforespørsel hos en gårdssalg-produsent (kun avventende/pending — produsenten svarer via e-post, ingen betaling)</li>
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
