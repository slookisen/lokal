/**
 * dental-a2a.ts — Forenklet A2A JSON-RPC 2.0 router for finn-tannlege.com
 *
 * PR-113: Host-aware A2A endpoint for the dental vertical.
 *
 * Supported methods:
 *   message/send  — natural-language or structured dental search
 *
 * Intentionally does NOT implement tasks/get, tasks/list, or agent/authenticatedExtendedCard:
 * dental searches are stateless (request/response) so task-lifecycle methods
 * add no value in v0.1.  They are NOT advertised in getDentalAgentCard().
 *
 * Rate-limiting note:
 *   In src/index.ts the global `app.use("/a2a", jsonRpcLimiter)` is mounted at
 *   line ~170, AFTER the PR-109 dental host-gate (line ~129).  Because the gate
 *   calls `dentalSeoRouter(req, res, next)` instead of `next()`, dental requests
 *   never reach the global limiter mount.  This router therefore applies
 *   `dentalLimiter` (1000 req / 15 min per IP — the same quota used by
 *   /api/tannlege/*) by importing it from security.ts.  If the gate ordering
 *   ever changes and both limiters fire, the tighter of the two wins — harmless.
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  listPublicDentalAgents,
  getDentalAgentByOrgnr,
  getDentalStats,
} from "../services/dental-store";
import { getDentalAgentCard } from "../services/dental-agent-card";
import { dentalLimiter } from "../middleware/security";

const router = Router();

// ─── JSON-RPC helpers ────────────────────────────────────────

function rpcOk(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", result, id };
}
function rpcErr(id: unknown, code: number, message: string, data?: unknown) {
  const err: Record<string, unknown> = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: "2.0", error: err, id };
}

// ─── Zod envelope schema ─────────────────────────────────────

const RpcEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.unknown().optional(),
  id: z.union([z.string(), z.number(), z.null()]),
});

// ─── Text extractor (mirrors rfb a2a.ts approach) ────────────

function extractText(msg: unknown): string | null {
  if (typeof msg === "string") return msg;
  if (msg && typeof msg === "object") {
    const m = msg as Record<string, unknown>;
    if (typeof m.text === "string" && m.text) return m.text;
    if (Array.isArray(m.parts)) {
      for (const p of m.parts) {
        if (!p || typeof p !== "object") continue;
        const part = p as Record<string, unknown>;
        if (typeof part.text === "string" && part.text) {
          if (part.type !== undefined && part.type !== "text") continue;
          if (part.kind !== undefined && part.kind !== "text") continue;
          return part.text;
        }
      }
    }
  }
  return null;
}

// ─── Intent parser ───────────────────────────────────────────
// Extracts search parameters from a Norwegian/English natural-language query.
// Keeps it simple: keyword matching on known fylker + specialties.

const FYLKER = [
  "oslo", "akershus", "østfold", "buskerud", "innlandet", "vestfold",
  "telemark", "agder", "rogaland", "vestland", "møre og romsdal",
  "trøndelag", "nordland", "troms", "finnmark",
];

const SPECIALTIES = [
  "kjeveortopedi", "oral kirurgi", "oral medisin", "periodonti",
  "endodonti", "pedodonti", "oral protetikk", "kjeve- og ansiktsradiologi",
];

export interface DentalSearchParams {
  q?: string;
  fylke?: string;
  specialty?: string;
  helfo_agreement?: "true" | "false";
  acute_vakt?: 0 | 1;
}

export function parseIntent(text: string): DentalSearchParams {
  const lower = text.toLowerCase();
  const params: DentalSearchParams = {};

  // Fylke detection
  for (const f of FYLKER) {
    if (lower.includes(f)) {
      params.fylke = f.charAt(0).toUpperCase() + f.slice(1);
      break;
    }
  }

  // Specialty detection
  for (const s of SPECIALTIES) {
    if (lower.includes(s)) {
      params.specialty = s;
      break;
    }
  }

  // Helfo
  if (
    lower.includes("helfo") ||
    lower.includes("direkteoppgj") ||
    lower.includes("direkteoppgjør")
  ) {
    params.helfo_agreement = "true";
  }

  // Akuttvakt
  if (lower.includes("akutt") || lower.includes("emergency")) {
    params.acute_vakt = 1;
  }

  // Residual free-text (words not yet captured, for name/city matching)
  const stopwords = new Set([
    "finn", "find", "søk", "search", "tannlege", "dental", "klinikk", "clinic",
    "i", "in", "med", "with", "og", "and", "en", "a", "på", "at",
  ]);
  const words = lower
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopwords.has(w))
    .filter((w) => {
      // remove words already matched as fylke/specialty
      if (params.fylke && w === params.fylke.toLowerCase()) return false;
      if (params.specialty && params.specialty.toLowerCase().includes(w)) return false;
      return true;
    });
  if (words.length > 0 && !params.fylke && !params.specialty) {
    params.q = words.slice(0, 3).join(" ");
  }

  return params;
}

// ─── message/send handler (exported for unit tests) ──────────

export function handleDentalMessageSend(
  params: unknown,
  id: unknown
): object {
  const p = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const message = p.message;

  if (!message) {
    return rpcErr(id, -32602, "Invalid params: 'message' required");
  }

  // Parse intent
  const messageText = extractText(message);
  let searchParams: DentalSearchParams = {};

  if (messageText) {
    searchParams = parseIntent(messageText);
  } else if (message && typeof message === "object") {
    const m = message as Record<string, unknown>;
    if (m.data && typeof m.data === "object") {
      const d = m.data as Record<string, unknown>;
      if (typeof d.fylke === "string") searchParams.fylke = d.fylke;
      if (typeof d.specialty === "string") searchParams.specialty = d.specialty;
      if (d.helfo_agreement === "true" || d.helfo_agreement === "false") {
        searchParams.helfo_agreement = d.helfo_agreement as "true" | "false";
      }
      if (d.acute_vakt === 1 || d.acute_vakt === 0) {
        searchParams.acute_vakt = d.acute_vakt as 0 | 1;
      }
      if (typeof d.q === "string") searchParams.q = d.q;
    }
  }

  // Special intent: stats query
  const lowerText = (messageText || "").toLowerCase();
  if (
    lowerText.includes("statistikk") ||
    lowerText.includes("stats") ||
    lowerText.includes("totalt") ||
    lowerText.includes("total") ||
    lowerText.includes("oversikt") ||
    lowerText.includes("how many")
  ) {
    try {
      const stats = getDentalStats();
      return rpcOk(id, {
        taskId: `dental-stats-${Date.now()}`,
        status: { state: "completed", timestamp: new Date().toISOString() },
        artifacts: [
          {
            artifactId: "stats",
            name: "dental-stats",
            parts: [{ kind: "data", data: stats }],
          },
        ],
        metadata: { skill: "tannlege_stats" },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return rpcErr(id, -32603, "Internal error", msg);
    }
  }

  // Special intent: single clinic by org_nr
  const orgMatch = lowerText.match(/\b(\d{9})\b/);
  if (orgMatch) {
    try {
      const clinic = getDentalAgentByOrgnr(orgMatch[1]!);
      if (!clinic) {
        return rpcOk(id, {
          taskId: `dental-info-${Date.now()}`,
          status: { state: "completed", timestamp: new Date().toISOString() },
          artifacts: [
            {
              artifactId: "clinic",
              name: "dental-clinic",
              parts: [{ kind: "text", text: `Ingen klinikk funnet med orgnr ${orgMatch[1]}` }],
            },
          ],
          metadata: { skill: "tannlege_info", org_nr: orgMatch[1] },
        });
      }
      return rpcOk(id, {
        taskId: `dental-info-${Date.now()}`,
        status: { state: "completed", timestamp: new Date().toISOString() },
        artifacts: [
          {
            artifactId: "clinic",
            name: "dental-clinic",
            parts: [{ kind: "data", data: clinic }],
          },
        ],
        metadata: { skill: "tannlege_info", org_nr: orgMatch[1] },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return rpcErr(id, -32603, "Internal error", msg);
    }
  }

  // Default: list/search
  try {
    const filter: Record<string, unknown> = {};
    if (searchParams.fylke) filter.fylke = searchParams.fylke;
    if (searchParams.specialty) filter.specialty = searchParams.specialty;
    if (searchParams.helfo_agreement) filter.helfo_agreement = searchParams.helfo_agreement;
    if (searchParams.acute_vakt !== undefined) filter.acute_vakt = searchParams.acute_vakt;
    if (searchParams.q) filter.q = searchParams.q;

    const results = listPublicDentalAgents(filter as any, 20, 0);

    const summaryText =
      results.length === 0
        ? "Ingen tannlegeklinikker funnet med de angitte filtrene. / No dental clinics found matching the given filters."
        : `Fant ${results.length} tannlegeklinikk(er). / Found ${results.length} dental clinic(s).`;

    return rpcOk(id, {
      taskId: `dental-search-${Date.now()}`,
      status: { state: "completed", timestamp: new Date().toISOString() },
      artifacts: [
        {
          artifactId: "search-summary",
          name: "dental-search-summary",
          parts: [{ kind: "text", text: summaryText }],
        },
        {
          artifactId: "search-results",
          name: "dental-search-results",
          parts: [{ kind: "data", data: { count: results.length, clinics: results } }],
        },
      ],
      metadata: {
        skill: "tannlege_search",
        filter: searchParams,
        parsedFrom: messageText || null,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return rpcErr(id, -32603, "Internal error", msg);
  }
}

// ─── Apply dentalLimiter to /a2a on this router ───────────────
// See module docstring for why this is done here rather than in index.ts.
router.use(dentalLimiter);

// ─── GET /a2a — health check & agent card ────────────────────
router.get("/a2a", (_req: Request, res: Response) => {
  res.json(getDentalAgentCard());
});

// ─── POST /a2a — JSON-RPC 2.0 dispatcher ─────────────────────
router.post("/a2a", (req: Request, res: Response) => {
  const body = req.body && typeof req.body === "object" ? req.body : null;
  if (!body) {
    res.status(400).json(rpcErr(null, -32700, "Parse error: body must be JSON. Set Content-Type: application/json."));
    return;
  }

  const parsed = RpcEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json(
      rpcErr((body as any).id ?? null, -32600, "Invalid Request: must include jsonrpc:'2.0', method, and id")
    );
    return;
  }

  const { method, params, id } = parsed.data;

  try {
    switch (method) {
      case "message/send": {
        const result = handleDentalMessageSend(params, id);
        res.json(result);
        break;
      }
      default:
        res.json(rpcErr(id, -32601, `Method not found: ${method}`));
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.json(rpcErr(id, -32603, "Internal error", msg));
  }
});

export default router;
