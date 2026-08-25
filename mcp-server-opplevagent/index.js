#!/usr/bin/env node

/**
 * opplevagent-mcp — MCP stdio server for opplevagent.no
 *
 * Find Norwegian experiences and activities from Claude Desktop, ChatGPT,
 * Cursor, or any MCP-compatible AI assistant.
 *
 * Install / run:
 *   npx opplevagent-mcp
 *
 * Or add to Claude Desktop config (~/.claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "opplevagent": {
 *         "command": "npx",
 *         "args": ["opplevagent-mcp"]
 *       }
 *     }
 *   }
 *
 * Environment:
 *   OPPLEVAGENT_URL  Override API base URL (default: https://opplevagent.no)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.OPPLEVAGENT_URL || "https://opplevagent.no").replace(/\/$/, "");
const USER_AGENT = "opplevagent-mcp/0.2.0";

// ── Helpers ───────────────────────────────────────────────────

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

// postJSON does NOT throw on a non-2xx response — book_gardssalg needs the
// parsed body even on 400/200-paused/500 to report the real reason back to
// the caller instead of a generic "HTTP xxx" error (mirrors createBooking's
// own error-shaped responses in src/routes/opplevelser.ts).
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ── MCP Server ────────────────────────────────────────────────

const server = new McpServer({
  name: "opplevagent",
  version: "0.2.0",
});

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
    inputSchema: {
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
    },
    annotations: {
      title: "Discover Norwegian experiences",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ fylke, kommune, category, weather, season, indoor_outdoor, group_size, age, max_price, duration_max, language, limit }) => {
    const params = new URLSearchParams();
    if (fylke) params.append("fylke", fylke);
    if (kommune) params.append("kommune", kommune);
    if (category) params.append("category", category);
    if (weather) params.append("weather", weather);
    if (season) params.append("season", season);
    if (indoor_outdoor) params.append("indoor_outdoor", indoor_outdoor);
    if (typeof group_size === "number") params.append("group_size", String(group_size));
    if (typeof age === "number") params.append("age", String(age));
    if (typeof max_price === "number") params.append("max_price", String(max_price));
    if (typeof duration_max === "number") params.append("duration_max", String(duration_max));
    if (language) params.append("language", language);
    params.append("limit", String(limit ?? 20));

    const data = await fetchJSON(`${BASE_URL}/api/opplevelser/discover?${params}`);

    if (!data || (Array.isArray(data.results) && data.results.length === 0)) {
      return {
        content: [{ type: "text", text: `Ingen opplevelser funnet med de angitte filtrene. / No experiences found matching the given filters.` }],
      };
    }

    const results = Array.isArray(data.results) ? data.results : [];
    const summary = `Fant ${data.count ?? results.length} opplevelse(r). / Found ${data.count ?? results.length} experience(s).`;

    const formatted = results.map((e, i) => {
      const parts = [`**${i + 1}. ${e.title}**`];
      if (e.category) parts.push(`   🏷 ${e.category}`);
      const location = [e.kommune, e.fylke].filter(Boolean).join(", ");
      if (location) parts.push(`   📍 ${location}`);
      if (e.indoor_outdoor) parts.push(`   🏠 ${e.indoor_outdoor}`);
      if (e.price_from != null) parts.push(`   💰 fra ${e.price_from} kr`);
      else if (e.price_band) parts.push(`   💰 ${e.price_band}`);
      if (e.duration_min != null) parts.push(`   ⏱ ${e.duration_min} min`);
      if (e.booking_url) parts.push(`   🔗 ${e.booking_url}`);
      parts.push(`   🆔 id: ${e.id}`);
      return parts.filter(Boolean).join("\n");
    });

    const header = `🎯 **Opplevagent.no** — ${summary}\n`;
    return { content: [{ type: "text", text: header + "\n" + formatted.join("\n\n") }] };
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
    inputSchema: {},
    annotations: {
      title: "List experience categories",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const data = await fetchJSON(`${BASE_URL}/api/opplevelser/categories`);

    const categories = Array.isArray(data.categories) ? data.categories : [];

    if (categories.length === 0) {
      return {
        content: [{ type: "text", text: "Ingen kategorier tilgjengelig for øyeblikket. / No category data available at this time." }],
      };
    }

    const header = `📂 **Opplevagent.no kategorier** — ${categories.length} kategorier:\n`;
    const lines = categories.map((c, i) => {
      const count = c.count != null ? ` (${c.count} opplevelser)` : "";
      return `**${i + 1}. ${c.category ?? c.name ?? c.slug ?? c}**${count}`;
    });

    return { content: [{ type: "text", text: header + "\n" + lines.join("\n") }] };
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
    inputSchema: {
      id: z.string().uuid().describe(
        "UUID of the experience to fetch. Example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'"
      ),
    },
    annotations: {
      title: "Get experience details",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ id }) => {
    const data = await fetchJSON(`${BASE_URL}/api/opplevelser/${encodeURIComponent(id)}`);

    const experience = data.experience ?? data;

    if (!experience || !experience.id) {
      return {
        content: [{ type: "text", text: `Ingen opplevelse funnet med id ${id}. / No experience found with id ${id}.` }],
        isError: true,
      };
    }

    const sections = [`# ${experience.title}`];

    const location = [experience.meeting_point, experience.kommune, experience.fylke].filter(Boolean).join(", ");
    if (location) sections.push(`📍 ${location}`);

    if (experience.category) sections.push(`\n🏷 Kategori: ${experience.category}${experience.subcategory ? ` / ${experience.subcategory}` : ""}`);
    if (experience.indoor_outdoor) sections.push(`🏠 Innendørs/utendørs: ${experience.indoor_outdoor}`);
    if (Array.isArray(experience.season) && experience.season.length) sections.push(`🗓 Sesong: ${experience.season.join(", ")}`);
    if (experience.weather_dependent != null) sections.push(`☁️ Væravhengig: ${experience.weather_dependent ? "ja" : "nei"}`);

    const duration = [
      experience.duration_min != null ? `min ${experience.duration_min} min` : null,
      experience.duration_max != null ? `maks ${experience.duration_max} min` : null,
    ].filter(Boolean).join(" – ");
    if (duration) sections.push(`\n⏱ Varighet: ${duration}`);

    const group = [
      experience.group_min != null ? `min ${experience.group_min}` : null,
      experience.group_max != null ? `maks ${experience.group_max}` : null,
    ].filter(Boolean).join(" – ");
    if (group) sections.push(`👥 Gruppestørrelse: ${group}`);

    if (experience.min_age != null) sections.push(`🔞 Minimumsalder: ${experience.min_age} år`);
    if (experience.age_suitability) sections.push(`👶 Aldersgruppe: ${experience.age_suitability}`);

    if (experience.price_from != null) sections.push(`\n💰 Pris fra: ${experience.price_from} kr${experience.price_unit ? ` per ${experience.price_unit}` : ""}`);
    else if (experience.price_band) sections.push(`\n💰 Priskategori: ${experience.price_band}`);

    if (Array.isArray(experience.languages) && experience.languages.length) sections.push(`🌐 Språk: ${experience.languages.join(", ")}`);
    if (Array.isArray(experience.accessibility) && experience.accessibility.length) sections.push(`♿ Tilgjengelighet: ${experience.accessibility.join(", ")}`);

    if (experience.description) sections.push(`\n${experience.description}`);

    if (experience.booking_url) sections.push(`\n📅 Bestill: ${experience.booking_url}${experience.booking_type ? ` (${experience.booking_type})` : ""}`);

    if (experience.verification_status) sections.push(`\n✔ Status: ${experience.verification_status}`);

    // Provenance summary (dev-request 2026-07-13-proveniens-transparens-side,
    // slice 2): additive — only present when the provider behind this
    // experience has real field_provenance + brreg_checked_at. This tool
    // reshapes the REST JSON into markdown (not a verbatim passthrough), so
    // the new field needs an explicit line here to actually reach the
    // AI-agent caller.
    if (experience.provenance?.sources?.length) {
      sections.push(`\n🔎 Kilder: ${experience.provenance.sources.join(", ")} (sist bekreftet ${experience.provenance.last_verified})`);
    }

    return { content: [{ type: "text", text: sections.join("\n") }] };
  }
);

// Tool 4: discover_gardssalg
// Mirrors the remote io.github.slookisen/opplevagent-mcp tool 1:1 (schema,
// annotations, description — see src/routes/experiences-mcp.ts's
// DiscoverGardssalgInputSchema + registerTool("discover_gardssalg", ...)),
// but reached via the REST surface (GET /api/opplevelser/discover with
// category=gardssalg_smaking) rather than an in-process store call, since
// this stdio proxy only ever talks HTTP to BASE_URL. That REST route
// (opplevelser.ts) reuses the exact same searchGardssalgProviders() store
// function and returns byte-identical result shaping, so parity holds.
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
    inputSchema: {
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
    },
    annotations: {
      title: "Discover gårdssalg producers",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ fylke, kommune, producer_type, booking_live, lat, lng, radius_km, limit }) => {
    const params = new URLSearchParams();
    params.append("category", "gardssalg_smaking");
    if (fylke) params.append("fylke", fylke);
    if (kommune) params.append("kommune", kommune);
    if (producer_type) params.append("producer_type", producer_type);
    // Only the literal string "true" is a real filter server-side (see
    // opplevelser.ts's req.query.booking_live === "true" check) — omitting a
    // false value here matches that "no filter" semantics exactly.
    if (booking_live === true) params.append("booking_live", "true");
    if (typeof lat === "number") params.append("lat", String(lat));
    if (typeof lng === "number") params.append("lng", String(lng));
    if (typeof radius_km === "number") params.append("radius_km", String(radius_km));
    params.append("limit", String(limit ?? 20));

    const data = await fetchJSON(`${BASE_URL}/api/opplevelser/discover?${params}`);
    const results = Array.isArray(data.results) ? data.results : [];

    const result = {
      summary:
        results.length === 0
          ? "Ingen gårdssalg-produsenter funnet med de angitte filtrene. / No gårdssalg producers found matching the given filters."
          : `Fant ${results.length} gårdssalg-produsent(er). / Found ${results.length} gårdssalg producer(s).`,
      count: data.count ?? results.length,
      filter_applied: data.query ?? {},
      gardssalg_producers: results,
    };

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 5: book_gardssalg
// Mirrors the remote tool's schema/annotations/description 1:1 (see
// experiences-mcp.ts's BookGardssalgInputSchema + registerTool("book_gardssalg",
// ...)), proxying to the SAME POST /api/opplevelser/book endpoint the web
// booking form and the remote MCP tool both call — same BookingInputSchema
// validation, same dark-launch-stop dispatch/booking_live gate, same
// createBooking() write path. This stdio tool can therefore never do more
// than remote: an unauthorized/paused producer is rejected identically.
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
    inputSchema: {
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
    },
    annotations: {
      title: "Request a gårdssalg booking",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ provider_id, experience_id, slot_at, party_size, guest_name, guest_email, guest_phone, notes }) => {
    const body = { provider_id, slot_at, party_size, guest_name, guest_email };
    if (experience_id) body.experience_id = experience_id;
    if (guest_phone) body.guest_phone = guest_phone;
    if (notes) body.notes = notes;

    const { ok, status, data } = await postJSON(`${BASE_URL}/api/opplevelser/book`, body);

    // 400: BookingInputSchema rejected the input (same validation POST
    // /api/opplevelser/book runs) -- surface the field-level issues.
    if (status === 400) {
      const details = Array.isArray(data.details)
        ? data.details.map((d) => `${(d.path || []).join(".") || "(root)"}: ${d.message}`).join("; ")
        : (data.error || "ugyldig forespørsel");
      return {
        content: [{ type: "text", text: `Ugyldig forespørsel: ${details}. / Invalid request: ${details}.` }],
        isError: true,
      };
    }

    // 200 + paused:true: the dark-launch-stop gate rejected a not-yet-live
    // producer -- not an HTTP error, a normal honest "not bookable yet" reply.
    if (data && data.paused === true) {
      return {
        content: [{ type: "text", text: data.message || "Booking er ikke aktivert for denne produsenten ennå. / Booking is not activated for this producer yet." }],
      };
    }

    if (!ok || data.success !== true) {
      return {
        content: [{ type: "text", text: "Kunne ikke opprette påmelding. / Could not create the booking request." }],
        isError: true,
      };
    }

    return {
      content: [{
        type: "text",
        text: `✅ Forespørsel registrert (${data.booking_ref}, status: ${data.status}). ${data.message}`,
      }],
    };
  }
);

// ── Start ──────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
