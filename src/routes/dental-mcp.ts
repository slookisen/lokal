/**
 * dental-mcp.ts — Streamable HTTP MCP server for finn-tannlege.com
 *
 * PR-114: Mirrors the mcp.ts (rfb) architecture with session management,
 * idle-cleanup, and registerTools pattern — but calls dental-store directly.
 *
 * Endpoint: POST https://finn-tannlege.com/mcp
 *           GET  https://finn-tannlege.com/mcp  (SSE stream for notifications)
 *           DELETE https://finn-tannlege.com/mcp (session cleanup)
 *
 * ChatGPT / Claude Desktop: paste https://finn-tannlege.com/mcp as the MCP URL.
 */

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import {
  listPublicDentalAgents,
  countPublicDentalAgents,
  getDentalAgentByOrgnr,
  getDentalAgentById,
  getDentalStats,
  listChains,
  listSpecialistsForClinic,
} from "../services/dental-store";

import { slugifyClinic } from "./dental-seo";
import { dentalLimiter } from "../middleware/security";

const router = Router();

// Apply rate limiting to all routes on this router (same pattern as dental-a2a.ts)
router.use(dentalLimiter);

const DENTAL_BASE_URL =
  process.env.DENTAL_BASE_URL || "https://finn-tannlege.com";

// ─── Zod input schemas (exported for testing — pr114-01) ─────

export const TannlegeSearchInputSchema = {
  query: z.string().optional().describe(
    "Free-text search (name or city). Examples: 'Oslo tannklinikk', 'kjeveortoped Bergen'"
  ),
  fylke: z.string().optional().describe(
    "Norwegian county (fylke). Examples: 'Oslo', 'Vestland', 'Rogaland'"
  ),
  spesialitet: z.string().optional().describe(
    "Specialty slug. Examples: 'kjeveortopedi', 'endodonti', 'periodonti'"
  ),
  helfo: z.boolean().optional().describe(
    "If true, only return clinics with Helfo direct-billing agreement"
  ),
  akutt: z.boolean().optional().describe(
    "If true, only return clinics with emergency-duty (akuttvakt)"
  ),
  limit: z.number().min(1).max(25).default(10).describe(
    "Max results (default 10, max 25)"
  ),
};

export const TannlegeInfoInputSchema = {
  org_nr: z.string().regex(/^\d{9}$/).optional().describe(
    "9-digit Norwegian organisation number. Example: '912345678'"
  ),
  id: z.string().uuid().optional().describe(
    "Clinic UUID (alternative to org_nr)"
  ),
};

export const TannlegeAkuttInputSchema = {
  fylke: z.string().optional().describe(
    "Limit to clinics in this county. Examples: 'Oslo', 'Vestland'"
  ),
};

// ─── Tool helpers (exported for unit testing — pr114-04) ─────

export interface SearchResult {
  count: number;
  klinikker: Array<{
    navn: string;
    org_nr: string | null | undefined;
    poststed: string | null | undefined;
    fylke: string | null | undefined;
    telefon: string | null | undefined;
    hjemmeside: string | null | undefined;
    helfo_agreement: string | undefined;
    badges: string[];
    profil_url: string;
  }>;
}

export function buildSearchResults(
  agents: ReturnType<typeof listPublicDentalAgents>
): SearchResult["klinikker"] {
  return agents.map((a) => {
    const badges: string[] = [];
    if (a.helfo_agreement === "true") badges.push("Helfo-avtale");
    if (a.acute_vakt === 1) badges.push("Akuttvakt");
    if (a.verification_status === "verified") badges.push("Verifisert");
    if (a.available_specialties?.length) badges.push("Spesialist");

    const slug = slugifyClinic(a.navn, a.org_nr ?? null);
    return {
      navn: a.navn,
      org_nr: a.org_nr,
      poststed: a.poststed,
      fylke: a.fylke,
      telefon: a.telefon,
      hjemmeside: a.hjemmeside,
      helfo_agreement: a.helfo_agreement,
      badges,
      profil_url: `${DENTAL_BASE_URL}/klinikk/${slug}`,
    };
  });
}

// ─── Tool registrations ──────────────────────────────────────

function registerDentalTools(server: McpServer): void {
  // Tool 1: tannlege_search
  server.registerTool(
    "tannlege_search",
    {
      title: "Search Norwegian dental clinics",
      description:
        "Search the finn-tannlege.com directory of Norwegian dental clinics. " +
        "Supports free-text search, county (fylke) filter, specialty filter, " +
        "Helfo direct-billing filter, and emergency-duty (akuttvakt) filter. " +
        "Returns clinic name, address, contact info, Helfo status, and profile URL. " +
        "Example: 'finn kjeveortoped i Bergen med Helfo-avtale'.",
      inputSchema: TannlegeSearchInputSchema,
      annotations: {
        title: "Search Norwegian dental clinics",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, fylke, spesialitet, helfo, akutt, limit }) => {
      try {
        const filter: Record<string, unknown> = {};
        if (query) filter.q = query;
        if (fylke) filter.fylke = fylke;
        if (spesialitet) filter.specialty = spesialitet;
        if (helfo === true) filter.helfo_agreement = "true";
        if (akutt === true) filter.acute_vakt = 1;

        const agents = listPublicDentalAgents(filter as any, limit ?? 10);
        const total = countPublicDentalAgents(filter as any);
        const klinikker = buildSearchResults(agents);

        const result = { count: total, klinikker };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Søkefeil: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 2: tannlege_info
  server.registerTool(
    "tannlege_info",
    {
      title: "Get full details for a dental clinic",
      description:
        "Fetch complete profile for a single Norwegian dental clinic by organisation number (org_nr) " +
        "or internal UUID. Returns name, address, phone, website, Helfo status, emergency duty, " +
        "specialities, chain affiliation, specialists list, treatments, opening hours, " +
        "payment options, and profile URL. " +
        "Example: org_nr '912345678' or id 'uuid-here'.",
      inputSchema: TannlegeInfoInputSchema,
      annotations: {
        title: "Get dental clinic details",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ org_nr, id }) => {
      try {
        if (!org_nr && !id) {
          return {
            content: [{ type: "text" as const, text: "Feil: oppgi enten org_nr (9 siffer) eller id (UUID)." }],
            isError: true,
          };
        }

        const agent = org_nr
          ? getDentalAgentByOrgnr(org_nr)
          : id
          ? getDentalAgentById(id)
          : null;

        if (!agent) {
          return {
            content: [{ type: "text" as const, text: "Klinikk ikke funnet." }],
            isError: true,
          };
        }

        const specialists = listSpecialistsForClinic(agent.id);
        const slug = slugifyClinic(agent.navn, agent.org_nr ?? null);
        const profil_url = `${DENTAL_BASE_URL}/klinikk/${slug}`;

        const badges: string[] = [];
        if (agent.helfo_agreement === "true") badges.push("Helfo-avtale");
        if (agent.acute_vakt === 1) badges.push("Akuttvakt");
        if (agent.verification_status === "verified") badges.push("Verifisert");

        const result = {
          id: agent.id,
          org_nr: agent.org_nr,
          navn: agent.navn,
          adresse: agent.adresse,
          postnummer: agent.postnummer,
          poststed: agent.poststed,
          fylke: agent.fylke,
          telefon: agent.telefon,
          mobil: agent.mobil,
          epost: agent.epost,
          hjemmeside: agent.hjemmeside,
          helfo_agreement: agent.helfo_agreement,
          acute_vakt: agent.acute_vakt,
          chain_brand: agent.chain_brand,
          is_chain_member: agent.is_chain_member,
          available_specialties: agent.available_specialties,
          treatments: agent.treatments,
          opening_hours: agent.opening_hours,
          payment_options: agent.payment_options,
          om_oss: agent.om_oss,
          online_booking_url: agent.online_booking_url,
          specialists: specialists.map((s) => ({
            navn: s.navn,
            primary_specialty: s.primary_specialty,
            specialty_used_here: s.specialty_used_here,
          })),
          badges,
          profil_url,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Feil: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 3: tannlege_stats
  server.registerTool(
    "tannlege_stats",
    {
      title: "Norwegian dental market statistics",
      description:
        "Fetch aggregated statistics for the Norwegian dental market from finn-tannlege.com. " +
        "Returns total clinic count, per-county breakdown (per fylke), Helfo count, " +
        "chain-member count, emergency-duty (akuttvakt) count, and specialist-clinic count. " +
        "Example question: 'how many dental clinics are there in Norway?'.",
      inputSchema: {},
      annotations: {
        title: "Norwegian dental market statistics",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const stats = getDentalStats();
        const explanation = {
          ...stats,
          _forklaring: {
            total: "Totalt antall tannlegeklinikker i databasen (ekskl. avviste).",
            helfo_count: "Antall klinikker med Helfo-direkteoppgjørsavtale.",
            chain_count: "Antall klinikker som er del av en kjede.",
            acute_count: "Antall klinikker med akuttvakt-tilbud.",
            specialist_clinic_count: "Antall klinikker der minst én spesialist er registrert.",
            per_fylke: "Fordeling per norsk fylke, sortert etter antall.",
          },
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(explanation, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Statistikkfeil: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 4: tannlege_akutt
  server.registerTool(
    "tannlege_akutt",
    {
      title: "Find emergency-duty dental clinics in Norway",
      description:
        "Find Norwegian dental clinics that offer emergency-duty (akuttvakt) — i.e. treatment " +
        "outside normal working hours. Optionally filter by county (fylke). " +
        "Also returns advice about the municipal dental emergency service (kommunal tannlegevakt). " +
        "Example: 'finn akutt tannlege i Oslo'.",
      inputSchema: TannlegeAkuttInputSchema,
      annotations: {
        title: "Find emergency-duty dental clinics",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ fylke }) => {
      try {
        const filter: Record<string, unknown> = { acute_vakt: 1 };
        if (fylke) filter.fylke = fylke;

        const agents = listPublicDentalAgents(filter as any, 25);
        const total = countPublicDentalAgents(filter as any);
        const klinikker = buildSearchResults(agents);

        const advice =
          "Mange kommuner har kommunal tannlegevakt på kvelder og helger — " +
          "ring klinikken direkte for å bekrefte åpningstider og tilgjengelighet. " +
          "Klinikker med Akuttvakt-merke setter som regel av tid til akuttpasienter på kort varsel.";

        const result = {
          count: total,
          klinikker,
          rad_om_kommunal_tannlegevakt: advice,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Feil: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 5: tannlege_kjeder
  server.registerTool(
    "tannlege_kjeder",
    {
      title: "List Norwegian dental chains",
      description:
        "List all Norwegian dental chains (kjeder) registered on finn-tannlege.com, " +
        "including the number of clinic locations per chain. " +
        "Examples of chains: 'Tannhelse Øst', 'Colosseum Tannlege', 'Nordic Dental'. " +
        "Example question: 'hvilke tannlegekjeder finnes i Norge?'.",
      inputSchema: {},
      annotations: {
        title: "List Norwegian dental chains",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const chains = listChains();

        // Enrich each chain with a count of clinics in the DB
        const enriched = chains.map((c) => {
          const count = countPublicDentalAgents({ chain_brand: c.chain_brand } as any);
          return { ...c, antall_lokasjoner_i_db: count };
        });

        const result = {
          count: enriched.length,
          kjeder: enriched,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
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
// Sessions are cleaned up after 30 min of inactivity (mirrors mcp.ts).

interface DentalMcpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
}

const dentalSessions = new Map<string, DentalMcpSession>();
const DENTAL_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Cleanup stale sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of dentalSessions) {
    if (now - session.lastActivity > DENTAL_SESSION_TTL_MS) {
      session.transport.close?.();
      dentalSessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

async function getOrCreateDentalSession(
  sessionId?: string
): Promise<{ id: string; session: DentalMcpSession }> {
  if (sessionId && dentalSessions.has(sessionId)) {
    const session = dentalSessions.get(sessionId)!;
    session.lastActivity = Date.now();
    return { id: sessionId, session };
  }

  const id = sessionId || randomUUID();

  const server = new McpServer({
    name: "finn-tannlege",
    version: "0.1.0",
    // Title and description for MCP registry / client display
  });

  // McpServer metadata via registerTool title convention
  // Title/description visible to clients at the server level:
  // "Finn-tannlege MCP — Norwegian dental clinic directory"
  registerDentalTools(server);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => id,
  });

  await server.connect(transport);

  const session: DentalMcpSession = {
    transport,
    server,
    lastActivity: Date.now(),
  };
  dentalSessions.set(id, session);
  return { id, session };
}

// ─── Routes ─────────────────────────────────────────────────

// POST /mcp — Main MCP message handler (JSON-RPC over HTTP)
router.post("/", async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const { session } = await getOrCreateDentalSession(sessionId);
    await session.transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error("[dental-mcp] POST error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "MCP transport error" });
    }
  }
});

// GET /mcp — SSE stream for server-to-client notifications
router.get("/", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !dentalSessions.has(sessionId)) {
    res.status(400).json({ error: "Missing or invalid mcp-session-id header" });
    return;
  }
  const session = dentalSessions.get(sessionId)!;
  session.lastActivity = Date.now();
  await session.transport.handleRequest(req, res, req.body);
});

// DELETE /mcp — Session cleanup
router.delete("/", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && dentalSessions.has(sessionId)) {
    const session = dentalSessions.get(sessionId)!;
    session.transport.close?.();
    dentalSessions.delete(sessionId);
  }
  res.status(200).json({ ok: true });
});

export default router;
