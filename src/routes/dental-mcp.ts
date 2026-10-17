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
  listPoststeder,
  listSpecialistsForClinic,
} from "../services/dental-store";
import { isDentalSyntheticProbeId } from "../services/dental-contamination";
import { planDentalSearch } from "../services/dental-query-parser";
import { getDentalSearchGazetteer } from "../services/dental-search-gazetteer";
import { recordMcpDelivery } from "../services/profile-ai-deliveries";
import { toDentalClinicCard, type DentalSearchCard } from "../services/dental-clinic-card";

import { createMcpRateLimiters, MCP_RATE_LIMIT_PROFILES } from "../middleware/mcp-rate-limit";
import { isMcpInitializeRequestBody, sendMcpSessionNotFound } from "../services/mcp-session-protocol";
import { companyFooterLineHtml } from "../services/company-legal";
import { BRAND_ENTITIES } from "../config/brand-entities";

const router = Router();

// Rate limiting for all routes on this router (dev-request
// 2026-10-16-mcp-rate-limit-dental-opplevagent-per-okt): this router's own
// buckets — IP brake, then a quota per MCP session (else per recognized
// consumer key, else per IP). Not dentalLimiter, which /api/tannlege and
// dental /a2a keep. See middleware/mcp-rate-limit.ts.
router.use(createMcpRateLimiters({ ...MCP_RATE_LIMIT_PROFILES.dental, isKnownSession: hasDentalMcpSession }).chain);

// ─── Server instructions and serverInfo ──────────────────────
// A2A dev-request 2026-10-16-tannlege-mcp-instrukser-og-klinikkort (S4a), after
// OPPLEVAGENT_MCP_INSTRUCTIONS (experiences-mcp.ts). Facts about what the
// server covers and returns; nothing about other servers or their tools, and no
// figures (the catalog count lives in honest-count). The server card in
// dental-seo.ts reads the title and description below, so there is no copy to
// keep in step. Locked by dental-mcp-instructions.test.ts.

/** Server-wide guidance returned from `initialize`, read by clients alongside the tool descriptions. */
export const DENTAL_MCP_INSTRUCTIONS =
  "Finn-tannlege is a read-only directory of dental clinics in Norway only: general dentists, orthodontists and " +
  "other specialists. When the user asks about a place outside Norway, say that Finn-tannlege only covers Norway; " +
  "do not present Norwegian clinics as an answer unless the user asks for Norway. " +
  "Pass the user's request, with any place they named, in tannlege_search's `query`. Set `fylke`, `spesialitet`, " +
  "`helfo` or `akutt` only when the user states that filter explicitly. " +
  "The response's `tolkning` shows how the request was read (place, specialty, filters, or a fallback to a plain " +
  "text search). `count` is the number of matching clinics; `klinikker` lists the first of them. " +
  "Helfo (`helfo_agreement`) means the clinic has a direct-settlement agreement (direkteoppgjør) with Helfo: " +
  "Helfo's share of a treatment that qualifies for support is settled with the clinic, and the patient pays the " +
  "rest. It does not mean the treatment is free. " +
  "«Akuttvakt» (`akutt`: \"vakt\") is an emergency duty backed by a recorded source; «Tar imot akuttpasienter» " +
  "(`akutt`: \"accepts\") only says that the clinic takes emergency patients. " +
  "For acute toothache or a dental injury, give the clinic's phone number and the advice on the municipal " +
  "out-of-hours dental service (kommunal tannlegevakt) from tannlege_akutt. Finn-tannlege gives no medical or " +
  "dental advice. " +
  "Finn-tannlege takes no bookings and no payments: the user books through the clinic's `online_booking_url` " +
  "when it has one, or by phone. `prisniva` is set only when the price level has a source, and the answers carry " +
  "no ratings or reviews.";

/** serverInfo title; also the server card's title. */
export const DENTAL_MCP_SERVER_TITLE = `${BRAND_ENTITIES.dental.name} — Norwegian dental clinic search`;

/** serverInfo description; the server card puts the catalog count in front of it. */
export const DENTAL_MCP_SERVER_DESCRIPTION =
  "Find a dentist (tannlege), orthodontist (kjeveortoped) or emergency dentist (akutt tannlege) in Norway by " +
  "place, county (fylke), specialty, Helfo direct-billing agreement or emergency care. Supports natural-language " +
  "queries in Norwegian and English. Read-only: no booking, no payment and no dental advice.";

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
  klinikker: DentalSearchCard[];
}

/** The search card per clinic (services/dental-clinic-card.ts, shared with A2A). */
export function buildSearchResults(
  agents: ReturnType<typeof listPublicDentalAgents>
): SearchResult["klinikker"] {
  return agents.map((a) => toDentalClinicCard(a, "search"));
}

// ─── Tool registrations ──────────────────────────────────────

export function registerDentalTools(server: McpServer): void {
  // «Med i AI-svar» (dev-request 2026-10-14-med-i-ai-svar-per-profil, S2): the
  // clinics a data tool hands the caller, counted with the same rules as rfb
  // (profile-ai-deliveries.ts recordMcpDelivery).
  type ToolExtra = { sessionId?: string; requestInfo?: { headers?: Record<string, string | string[] | undefined> } } | undefined;
  const deliver = (tool: string, args: unknown, extra: ToolExtra, profileIds: string[]) => {
    recordMcpDelivery({
      vertical: "dental",
      tool,
      args,
      profileIds,
      clientName: (server as any).server?.getClientVersion?.()?.name ?? null,
      headers: extra?.requestInfo?.headers,
      sessionId: extra?.sessionId,
    });
  };

  // Tool 1: tannlege_search
  server.registerTool(
    "tannlege_search",
    {
      title: "Search Norwegian dental clinics",
      description:
        "Find a dentist (tannlege), orthodontist (kjeveortoped) or emergency dentist (akutt tannlege) in Norway " +
        "by place, county (fylke), specialty, Helfo direct billing or emergency care. " +
        "The request can go in `query` as written, such as 'kjeveortoped i Bergen med Helfo-avtale'; the response's " +
        "`tolkning` shows how it was read, and `count` is the number of matching clinics. " +
        "Each clinic has its name, address, postcode, place, county, phone, website, Helfo status, emergency status " +
        "(`akutt`) and profile URL, and when known its online booking link, opening hours, specialties, chain and a " +
        "price level that has a source.",
      inputSchema: TannlegeSearchInputSchema,
      annotations: {
        title: "Search Norwegian dental clinics",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, fylke, spesialitet, helfo, akutt, limit }, extra) => {
      try {
        // dev-request 2026-10-16-tannlege-sok-naturlig-sprak (S3): `query`
        // goes through the shared parser; the explicit arguments win over
        // what it found (helfo/akutt false removes a parsed one). The store
        // also reads a slug or synonym in `spesialitet` («kjeveortoped»,
        // «orthodontist») as the stored specialty name, and acute_vakt 1 (from
        // `akutt` or the parser) as the akutt claim the card shows (S2b).
        const explicit: Record<string, unknown> = {};
        if (fylke) explicit.fylke = fylke;
        if (spesialitet) explicit.specialty = spesialitet;
        if (helfo !== undefined) explicit.helfo_agreement = helfo ? "true" : undefined;
        if (akutt !== undefined) explicit.acute_vakt = akutt ? 1 : undefined;

        const plan = planDentalSearch({
          query,
          explicit,
          gazetteer: () => getDentalSearchGazetteer(listPoststeder),
          count: (f) => countPublicDentalAgents(f as any),
        });
        const agents = listPublicDentalAgents(plan.filter as any, limit ?? 10);
        const klinikker = buildSearchResults(agents);

        // `tolkning` (only when a query was parsed) says what the search used.
        const result = { count: plan.count, klinikker, ...(plan.tolkning ? { tolkning: plan.tolkning } : {}) };
        deliver("tannlege_search", { query, fylke, spesialitet, helfo, akutt, limit }, extra, agents.map((a) => a.id));
        // Compact JSON: indentation was a third of a 25-card answer (S4b keeps it near 12 KB).
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
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
        "Get the full record of one dental clinic in Norway, a dentist (tannlege) or specialist practice, " +
        "by organisation number (org_nr) or id. " +
        "Returns name, address, phone, mobile, e-mail, website, online booking link, Helfo status, emergency duty " +
        "when it has a recorded source, specialties, chain, specialists, treatments, opening hours, payment options, " +
        "the clinic's own description and profile URL.",
      inputSchema: TannlegeInfoInputSchema,
      annotations: {
        title: "Get dental clinic details",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ org_nr, id }, extra) => {
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

        // The synthetic schema-probe row (org_nr 999999999) is not a clinic.
        if (!agent || isDentalSyntheticProbeId(agent.id)) {
          return {
            content: [{ type: "text" as const, text: "Klinikk ikke funnet." }],
            isError: true,
          };
        }

        // The detail card: the keys this tool has always returned, with the
        // phone, acute_vakt (Skive B: only with provenance) and profile-link
        // rules of the search card.
        const result = toDentalClinicCard(agent, "detail", { specialists: listSpecialistsForClinic(agent.id) });

        deliver("tannlege_info", { org_nr, id }, extra, [agent.id]);
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
        "Counts of dentist practices (tannlegeklinikker) in Norway: the total, per county (fylke), and how many " +
        "have Helfo direct billing, belong to a chain, show an emergency claim or list a specialist. " +
        "An emergency claim is an emergency duty with a recorded source (akuttvakt), or that the clinic says it " +
        "takes emergency patients.",
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
            acute_count:
              "Antall klinikker som viser akuttpåstand på kortet: «Akuttvakt» (med kilde) eller «Tar imot akuttpasienter». " +
              "Samme tall som tannlege_akutt.count og /sok?akutt=1.",
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
        "Find an emergency dentist (akutt tannlege) in Norway: dental clinics with an emergency duty that has a " +
        "recorded source (akuttvakt) or that say they take emergency patients, optionally in one county (fylke). " +
        "Each clinic's `akutt` is \"vakt\" when the emergency duty has a recorded source (badge «Akuttvakt») and " +
        "\"accepts\" when the clinic says it takes emergency patients («Tar imot akuttpasienter»). " +
        "`count` is the number of matching clinics. " +
        "Each clinic has its address, phone and profile URL, and when known its opening hours and online booking " +
        "link. The response also has advice on the municipal out-of-hours dental service (kommunal tannlegevakt).",
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
        // S2b: the public store reads acute_vakt 1 as the akutt claim
        // (DENTAL_ACUTE_CLAIM_SQL), so `count` and every card here are clinics
        // whose `akutt` is "vakt" or "accepts", never a bare flag.
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

        // Compact JSON, as tannlege_search: up to 25 cards.
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
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
        "List dentist chains (tannlegekjeder) in Norway that are registered in the directory, " +
        "each with its number of clinic locations.",
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
        // S6: the chains come from the clinics' chain_brand (dental_chains is
        // empty), each with its antall_lokasjoner_i_db from one GROUP BY in
        // listChains() instead of a count query per chain.
        const kjeder = listChains();
        const result = { count: kjeder.length, kjeder };

        // Compact JSON, as tannlege_search.
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
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

// The rate limiter's "is this a live session?" check (router.use at the top
// of this file): only a session this router minted gets its own bucket.
export function hasDentalMcpSession(sessionId: string): boolean {
  return dentalSessions.has(sessionId);
}

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
  sessionId: string | undefined,
  isInitialize: boolean
): Promise<{ id: string; session: DentalMcpSession } | { notFound: true }> {
  if (sessionId && dentalSessions.has(sessionId)) {
    const session = dentalSessions.get(sessionId)!;
    session.lastActivity = Date.now();
    return { id: sessionId, session };
  }

  if (!isInitialize) {
    // Not an initialize call, and the top guard above didn't find (or
    // wasn't given) a live session — either a session id was PROVIDED but
    // is unknown/expired (e.g. the in-memory map was wiped by a
    // deploy/restart), or NO session id was sent at all. Per the MCP spec
    // both are a 404, not a silently-created new session — creating one
    // here would leave a phantom, never properly-negotiated session that
    // still fails every subsequent call (the SDK's own transport would
    // reject it with a misleading 400 "Server not initialized" the moment
    // a real request reached it, since this fresh transport instance never
    // actually ran `initialize`). This is AC2 of the filed dev-request:
    // "tools/list uten sesjon og uten forutgående initialize -> 404".
    // Nothing is inserted into dentalSessions on this branch.
    return { notFound: true };
  }

  // Either no session id was sent at all (a legitimate fresh `initialize`),
  // or the client sent `initialize` together with a stale/foreign
  // `mcp-session-id` header (e.g. retrying after a 404, or after this
  // process restarted and wiped the map). Either way, `initialize` ALWAYS
  // mints the server's own id — a client-supplied id is never adopted here.
  const id = randomUUID();

  const server = new McpServer({
    name: "finn-tannlege",
    version: "0.1.0",
    title: DENTAL_MCP_SERVER_TITLE,
    description: DENTAL_MCP_SERVER_DESCRIPTION,
    websiteUrl: BRAND_ENTITIES.dental.url,
  }, { instructions: DENTAL_MCP_INSTRUCTIONS });

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
// PR-115: the dental host-gate in index.ts dispatches the UNstripped path
// ("/mcp") into this router (no app.use prefix mounting, mirroring
// dental-a2a.ts). Routes therefore match both "/" and "/mcp" so the router
// works under either mounting style and never falls through (next()) to
// rfb's /mcp router.
router.post(["/", "/mcp"], async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const result = await getOrCreateDentalSession(sessionId, isMcpInitializeRequestBody(req.body));
    if ("notFound" in result) {
      sendMcpSessionNotFound(res);
      return;
    }
    await result.session.transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error("[dental-mcp] POST error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "MCP transport error" });
    }
  }
});

// GET /mcp — SSE stream for server-to-client notifications
router.get(["/", "/mcp"], async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !dentalSessions.has(sessionId)) {
    // Return a human-friendly landing page for browser GET (Accept: text/html, no session).
    // The MCP POST/session handshake path is unaffected — this branch only fires when
    // there is no valid session header, which a real MCP client would never send as GET.
    const accept = req.headers["accept"] || "";
    if (accept.includes("text/html")) {
      res.status(200).contentType("text/html").send(`<!doctype html>
<html lang="no">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Finn-tannlege MCP — Model Context Protocol</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 24px;color:#1a1a1a;line-height:1.6}
h1{font-size:1.5rem;margin-bottom:.25rem}p{margin:.75rem 0}code{background:#f0f0f0;padding:2px 6px;border-radius:4px;font-size:.9em}
pre{background:#f6f8fa;border:1px solid #e1e4e8;border-radius:6px;padding:16px;overflow-x:auto;font-size:.85rem}
a{color:#0070f3}.back{display:inline-block;margin-top:24px;color:#555;text-decoration:none;font-size:.9rem}
.company-line{margin-top:32px;padding-top:12px;border-top:1px solid #e1e4e8;font-size:.8rem;color:#666}.company-line a{color:inherit}</style>
</head>
<body>
<h1>Finn-tannlege MCP-endepunkt</h1>
<p>Dette er Finn-tannlege sitt <a href="https://modelcontextprotocol.io" rel="noopener">Model Context Protocol</a>-endepunkt (Streamable HTTP). Det er designet for AI-agenter og MCP-klienter, ikke nettlesere.</p>
<p><strong>Koble til fra Claude Desktop / ChatGPT:</strong><br>Lim inn denne URL-en som MCP-server:</p>
<pre>https://finn-tannlege.com/mcp</pre>
<p><strong>Tilgjengelige verktøy:</strong></p>
<ul>
<li><code>tannlege_search</code> — fritekstsøk blant tannleger</li>
<li><code>tannlege_info</code> — hent én tannlege med full profil</li>
<li><code>tannlege_stats</code> — plattformstatistikk (antall klinikker, byer, kjeder)</li>
<li><code>tannlege_akutt</code> — finn akutt-/ø-hjelpstannleger nær deg</li>
<li><code>tannlege_kjeder</code> — tannlegekjeder og deres klinikker</li>
</ul>
<p><strong>For utviklere — eksempel (cURL):</strong></p>
<pre>curl -X POST https://finn-tannlege.com/mcp \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'</pre>
<p>Se også: <a href="/.well-known/agent-card.json">Agent Card</a> · <a href="/openapi.json">OpenAPI 3.1</a> · <a href="/llms.txt">llms.txt</a></p>
<a class="back" href="/">← Tilbake til Finn-tannlege</a>
<footer class="company-line">${companyFooterLineHtml("nb", { contactHref: "/kontakt" })}</footer>
</body></html>`);
      return;
    }
    // Non-browser caller with no valid session (never sent one, or sent an
    // unknown/expired one) on a GET: same premise as the POST-side 404 —
    // this must never have created a session, so there is nothing to clean
    // up here either.
    sendMcpSessionNotFound(res);
    return;
  }
  const session = dentalSessions.get(sessionId)!;
  session.lastActivity = Date.now();
  await session.transport.handleRequest(req, res, req.body);
});

// DELETE /mcp — Session cleanup
router.delete(["/", "/mcp"], async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && dentalSessions.has(sessionId)) {
    const session = dentalSessions.get(sessionId)!;
    session.transport.close?.();
    dentalSessions.delete(sessionId);
  }
  res.status(200).json({ ok: true });
});

// PR-115: hard stop — any /mcp/* subpath that didn't match above must NOT
// fall through to rfb's /mcp router via next().
router.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found on Finn-tannlege MCP endpoint" });
});

export default router;
