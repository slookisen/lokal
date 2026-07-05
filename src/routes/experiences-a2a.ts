/**
 * experiences-a2a.ts — Forenklet A2A JSON-RPC 2.0 router for Opplevagent (opplevagent.no)
 *
 * orchestrator-pr-19: Host-aware A2A endpoint for the experiences vertical.
 * Mirrors src/routes/dental-a2a.ts.
 *
 * Supported methods:
 *   message/send  — natural-language or structured experience discovery
 *   tasks/send    — backward-compat alias for older A2A clients (<0.3)
 *
 * Intentionally does NOT implement tasks/get, tasks/list, or
 * agent/authenticatedExtendedCard: experience discovery is stateless
 * (request/response) so task-lifecycle methods add no value in v0.1.
 * They are NOT advertised in getExperiencesAgentCard().
 *
 * HOST ISOLATION: every query goes through the experiences store against
 * /data/experiences.db (getDb('experiences')) — NEVER the rfb `agents`
 * table or the dental DB. This router is mounted ONLY behind the
 * opplevagent.no host gate in src/index.ts.
 *
 * Rate-limiting note (same situation as dental-a2a):
 *   In src/index.ts the global `app.use("/a2a", jsonRpcLimiter)` is mounted
 *   AFTER the opplevagent host-gate. Because the gate calls
 *   experiencesA2aRouter(req, res, next) instead of next(), opplevagent
 *   requests never reach the global limiter mount. This router therefore
 *   applies `jsonRpcLimiter` (200 req / 15 min per IP) by importing it from
 *   security.ts. If the gate ordering ever changes and both limiters fire,
 *   the tighter of the two wins — harmless.
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  discoverExperiences,
  getExperienceById,
  listCategories,
  type DiscoverFilter,
} from "../services/experience-store";
import { __FYLKE_INTERNAL, NON_KOMMUNE_REGION_LABELS } from "../services/norway-fylke";
import { getExperiencesAgentCard } from "../services/experiences-agent-card";
import { jsonRpcLimiter } from "../middleware/security";

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

// ─── Text extractor (mirrors dental a2a.ts approach) ─────────

const MAX_MESSAGE_TEXT = 2000; // cap free-text length (DoS hygiene)

function extractText(msg: unknown): string | null {
  if (typeof msg === "string") return msg.slice(0, MAX_MESSAGE_TEXT);
  if (msg && typeof msg === "object") {
    const m = msg as Record<string, unknown>;
    if (typeof m.text === "string" && m.text) return m.text.slice(0, MAX_MESSAGE_TEXT);
    if (Array.isArray(m.parts)) {
      for (const p of m.parts) {
        if (!p || typeof p !== "object") continue;
        const part = p as Record<string, unknown>;
        if (typeof part.text === "string" && part.text) {
          if (part.type !== undefined && part.type !== "text") continue;
          if (part.kind !== undefined && part.kind !== "text") continue;
          return part.text.slice(0, MAX_MESSAGE_TEXT);
        }
      }
    }
  }
  return null;
}

// ─── Intent parser ───────────────────────────────────────────
// Extracts discovery parameters from a Norwegian/English natural-language
// query. Keeps it simple: keyword matching on known fylker + signals.

const FYLKER = [
  "oslo", "akershus", "østfold", "buskerud", "innlandet", "vestfold",
  "telemark", "agder", "rogaland", "vestland", "møre og romsdal",
  "trøndelag", "nordland", "troms", "finnmark", "svalbard",
];

// The indoor/outdoor keywords are short Norwegian substrings ("inne", "ute")
// that collide with unrelated words — e.g. "finne" (to find) contains "inne",
// which previously forced indoor_outdoor="indoor" on any query using the verb
// "finne" (dev-request 2026-07-04-opplevagent-nl-parser-og-fylkesnormalisering:
// "hva kan vi finne på i Tromsø om vinteren?" wrongly excluded outdoor results).
// JS's \b doesn't treat æøå as word characters, so a plain regex \b boundary
// can't be used here. This checks the actual preceding character is not a
// Unicode letter/digit, while leaving the keyword's own end open so inflected
// continuations ("inne" + "ndørs" → "innendørs") still match.
function matchesAsWordPrefix(haystack: string, keyword: string): boolean {
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(keyword, from);
    if (idx === -1) return false;
    const precedingChar = idx > 0 ? haystack[idx - 1] : "";
    if (!/[\p{L}\p{N}]/u.test(precedingChar)) return true;
    from = idx + 1;
  }
}

// Known kommune (city/municipality) display names, reused from
// norway-fylke.ts rather than hand-rolling a second list. Checked BEFORE
// the FYLKER substring loop below: a kommune name is the more specific
// signal, and several kommune names substring-match into FYLKER (e.g.
// "Tromsø" contains "troms"), which previously produced a wrong/
// over-broad fylke instead of the intended kommune (the flagship demo
// query "hva kan vi finne på i Tromsø om vinteren?" — dev-request
// 2026-07-04-opplevagent-nl-parser-og-fylkesnormalisering item 1).
// Excludes traditional region/valley/district labels (Romsdal, Sunnmøre, …)
// that appear in CITY_TO_FYLKE_RAW for fylke-resolution purposes but are
// NOT themselves a literal DB `kommune` value — see NON_KOMMUNE_REGION_LABELS
// in norway-fylke.ts for why (caught in PR #146 review: "Møre og Romsdal"
// queries were regressing to a nonexistent `kommune: "Romsdal"` match).
const KOMMUNE_NAMES: string[] = Object.keys(__FYLKE_INTERNAL.CITY_TO_FYLKE_RAW)
  .filter(name => !NON_KOMMUNE_REGION_LABELS.has(name));

// Detect a kommune name in `lower` (already-lowercased text) using the same
// word-boundary-aware matching as the indoor/outdoor keywords. When several
// kommune names match (e.g. short kommune "Os" is a substring-prefix of
// "Oslo"), the LONGEST match wins — this resolves the common
// short-name-inside-longer-name case without needing a full tokeniser.
// NOTE: this does not fully solve general false positives from very short
// kommune names that happen to be substring-prefixes of unrelated Norwegian
// words with no longer kommune name present (e.g. "Os" inside "oster"/
// "ost", or "Time" ["hour"] inside an unrelated "en time i ..." phrase) —
// left out of scope per the dev-request (word-boundary matching already
// eliminates the worse substring-inside-a-word bug class; full NLP
// disambiguation of short ambiguous place names is a separate concern).
function detectKommune(lower: string): string | null {
  let best: string | null = null;
  for (const display of KOMMUNE_NAMES) {
    if (matchesAsWordPrefix(lower, display.toLowerCase())) {
      if (!best || display.length > best.length) best = display;
    }
  }
  return best;
}

export function parseExperiencesIntent(text: string): DiscoverFilter {
  const lower = text.toLowerCase();
  const params: DiscoverFilter = {};

  // Kommune detection takes priority over fylke (see detectKommune above).
  // A caller who only cares about kommune shouldn't also get a redundant
  // (and possibly stale-era) fylke constraint ANDed in by discoverExperiences.
  const kommune = detectKommune(lower);
  if (kommune) {
    params.kommune = kommune;
  } else {
    // Fylke detection — only when no kommune matched.
    for (const f of FYLKER) {
      if (lower.includes(f)) {
        params.fylke = f.charAt(0).toUpperCase() + f.slice(1);
        break;
      }
    }
  }

  // Weather detection
  if (lower.includes("regn") || lower.includes("rain")) {
    params.weather = "rain";
  } else if (lower.includes("snø") || lower.includes("snow")) {
    params.weather = "snow";
  } else if (lower.includes("sol") || lower.includes("clear") || lower.includes("fint vær")) {
    params.weather = "clear";
  }

  // Indoor / outdoor detection (word-prefix-aware — see matchesAsWordPrefix)
  if (matchesAsWordPrefix(lower, "inne") || matchesAsWordPrefix(lower, "indoor")) {
    params.indoor_outdoor = "indoor";
  } else if (matchesAsWordPrefix(lower, "ute") || matchesAsWordPrefix(lower, "outdoor") || matchesAsWordPrefix(lower, "friluft")) {
    params.indoor_outdoor = "outdoor";
  }

  // Season detection
  if (lower.includes("vinter") || lower.includes("winter")) {
    params.season = "winter";
  } else if (lower.includes("sommer") || lower.includes("summer")) {
    params.season = "summer";
  } else if (lower.includes("vår") || lower.includes("spring")) {
    params.season = "spring";
  } else if (lower.includes("høst") || lower.includes("autumn") || lower.includes("fall")) {
    params.season = "autumn";
  }

  return params;
}

// ─── message/send handler (exported for unit tests) ──────────

export function handleExperiencesMessageSend(
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
  let filter: DiscoverFilter = {};

  if (messageText) {
    filter = parseExperiencesIntent(messageText);
  } else if (message && typeof message === "object") {
    const m = message as Record<string, unknown>;
    if (m.data && typeof m.data === "object") {
      const d = m.data as Record<string, unknown>;
      if (typeof d.fylke === "string") filter.fylke = d.fylke;
      if (typeof d.kommune === "string") filter.kommune = d.kommune;
      if (typeof d.category === "string") filter.category = d.category;
      if (d.indoor_outdoor === "indoor" || d.indoor_outdoor === "outdoor" || d.indoor_outdoor === "both") {
        filter.indoor_outdoor = d.indoor_outdoor;
      }
      if (d.weather === "rain" || d.weather === "snow" || d.weather === "clear" || d.weather === "any") {
        filter.weather = d.weather;
      }
      if (typeof d.season === "string") filter.season = d.season;
      if (typeof d.group_size === "number") filter.group_size = d.group_size;
      if (typeof d.age === "number") filter.age = d.age;
      if (typeof d.max_price === "number") filter.max_price = d.max_price;
      if (typeof d.duration_max === "number") filter.duration_max = d.duration_max;
      if (typeof d.language === "string") filter.language = d.language;
    }
  }

  const lowerText = (messageText || "").toLowerCase();

  // Special intent: list categories
  if (
    lowerText.includes("kategori") ||
    lowerText.includes("categories") ||
    lowerText.includes("category")
  ) {
    try {
      const categories = listCategories();
      return rpcOk(id, {
        taskId: `experiences-categories-${Date.now()}`,
        status: { state: "completed", timestamp: new Date().toISOString() },
        artifacts: [
          {
            artifactId: "categories",
            name: "experience-categories",
            parts: [{ kind: "data", data: { categories } }],
          },
        ],
        metadata: { skill: "opplevelser_categories" },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return rpcErr(id, -32603, "Internal error", msg);
    }
  }

  // Special intent: single experience by UUID
  const idMatch = lowerText.match(
    /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/
  );
  if (idMatch) {
    try {
      const exp = getExperienceById(idMatch[1]!);
      if (!exp) {
        return rpcOk(id, {
          taskId: `experiences-info-${Date.now()}`,
          status: { state: "completed", timestamp: new Date().toISOString() },
          artifacts: [
            {
              artifactId: "experience",
              name: "experience",
              parts: [{ kind: "text", text: `Ingen opplevelse funnet med id ${idMatch[1]}` }],
            },
          ],
          metadata: { skill: "opplevelser_info", id: idMatch[1] },
        });
      }
      return rpcOk(id, {
        taskId: `experiences-info-${Date.now()}`,
        status: { state: "completed", timestamp: new Date().toISOString() },
        artifacts: [
          {
            artifactId: "experience",
            name: "experience",
            parts: [{ kind: "data", data: exp }],
          },
        ],
        metadata: { skill: "opplevelser_info", id: idMatch[1] },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return rpcErr(id, -32603, "Internal error", msg);
    }
  }

  // Default: discover
  try {
    const results = discoverExperiences(filter, 20);

    const summaryText =
      results.length === 0
        ? "Ingen opplevelser funnet med de angitte filtrene. / No experiences found matching the given filters."
        : `Fant ${results.length} opplevelse(r). / Found ${results.length} experience(s).`;

    return rpcOk(id, {
      taskId: `experiences-discover-${Date.now()}`,
      status: { state: "completed", timestamp: new Date().toISOString() },
      artifacts: [
        {
          artifactId: "discover-summary",
          name: "experience-discover-summary",
          parts: [{ kind: "text", text: summaryText }],
        },
        {
          artifactId: "discover-results",
          name: "experience-discover-results",
          parts: [{ kind: "data", data: { count: results.length, experiences: results } }],
        },
      ],
      metadata: {
        skill: "opplevelser_discover",
        filter,
        parsedFrom: messageText || null,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return rpcErr(id, -32603, "Internal error", msg);
  }
}

// ─── Apply jsonRpcLimiter to /a2a on this router ──────────────
// See module docstring for why this is done here rather than in index.ts.
router.use(jsonRpcLimiter);

// ─── GET /a2a — health check & agent card ────────────────────
router.get("/a2a", (_req: Request, res: Response) => {
  res.json(getExperiencesAgentCard());
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
      case "message/send":
      case "tasks/send": { // Backward-compat alias for older A2A clients (<0.3)
        const result = handleExperiencesMessageSend(params, id);
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
