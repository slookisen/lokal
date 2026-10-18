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
  countPublicDentalAgents,
  getDentalAgentByOrgnr,
  getDentalStats,
  listPoststeder,
  type ListFilter,
} from "../services/dental-store";
import { isDentalSyntheticProbeId } from "../services/dental-contamination";
import {
  isDentalQueryParserDisabled,
  parseDentalQuery,
  planDentalSearch,
  type DentalSearchTolkning,
} from "../services/dental-query-parser";
import { getDentalSearchGazetteer } from "../services/dental-search-gazetteer";
import { safeHonestCatalogCount } from "../services/honest-count";
import { getDentalAgentCard } from "../services/dental-agent-card";
import { dentalLimiter } from "../middleware/security";
import { buildRequestMeta, isInternalTraffic } from "../services/conversation-service";
import { a2aLookupCountable } from "../services/a2a-traffic-classifier";
import { hashIP } from "../services/analytics-service";
import { recordA2aDelivery } from "../services/profile-ai-deliveries";
import { toDentalA2aClinic } from "../services/dental-clinic-card";
import { a2aMessageData } from "../utils/a2a-message";
import { capFreeText } from "../utils/free-text";

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

// The text is cut to MAX_FREE_TEXT_CHARS (2000; review note #1, DoS hygiene)
// by the helper the three platforms share (utils/free-text.ts, dev-request
// 2026-10-17-integrasjonstest-oppfolging, slice I-Y), at a word boundary. This
// file used to cut at 2000 itself, in the middle of a word, and the piece
// before the cut was read («Oslo» of «Osloveien» as the fylke). A word the cut
// splits is now dropped whole.

function extractText(msg: unknown): string | null {
  if (typeof msg === "string") return capFreeText(msg);
  if (msg && typeof msg === "object") {
    const m = msg as Record<string, unknown>;
    if (typeof m.text === "string" && m.text) return capFreeText(m.text);
    if (Array.isArray(m.parts)) {
      for (const p of m.parts) {
        if (!p || typeof p !== "object") continue;
        const part = p as Record<string, unknown>;
        if (typeof part.text === "string" && part.text) {
          if (part.type !== undefined && part.type !== "text") continue;
          if (part.kind !== undefined && part.kind !== "text") continue;
          return capFreeText(part.text);
        }
      }
    }
  }
  return null;
}

// ─── Intent parser ───────────────────────────────────────────
// dev-request 2026-10-16-tannlege-sok-naturlig-sprak (S3): free text goes
// through the shared parser (services/dental-query-parser.ts), the same one
// MCP tannlege_search and /sok use. The keyword matcher below
// (legacyParseIntent) stays as the rollback (DENTAL_QUERY_PARSER_DISABLED=1)
// and as the old reading planDentalSearch keeps next to the parsed one: its
// hits stay in the result and come first, so no message finds fewer clinics.

const FYLKER = [
  "oslo", "akershus", "østfold", "buskerud", "innlandet", "vestfold",
  "telemark", "agder", "rogaland", "vestland", "møre og romsdal",
  "trøndelag", "nordland", "troms", "finnmark",
];

const SPECIALTIES = [
  "kjeveortopedi", "oral kirurgi", "oral medisin", "periodonti",
  "endodonti", "pedodonti", "oral protetikk", "kjeve- og ansiktsradiologi",
];

// The store's own list filter: what parseIntent, the planned text and
// message.data give the search, so every field the parser sets
// (poststed_or_postnummer, fylke_in, natural …) is typed as the store reads it.
export type DentalSearchParams = ListFilter;

export function parseIntent(text: string): DentalSearchParams {
  if (isDentalQueryParserDisabled()) return legacyParseIntent(text);
  return parseDentalQuery(text, getDentalSearchGazetteer(listPoststeder)).filter;
}

function legacyParseIntent(text: string): DentalSearchParams {
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

/**
 * Whether a message/send counts as an AI lookup («AI-søk», dev-request
 * 2026-10-13-statistikk-riktig-for-investorer, S7): it asked something, an
 * external caller (not spam, a probe or our own traffic) got data back, under
 * the per-IP cap (a2a-traffic-classifier.ts a2aLookupCountable). Logged with
 * the call by mcp-usage-logger.ts.
 *
 * Asked something = stats, a clinic by org number, or a search with a parsed
 * filter. A search with no filter («hi», an empty message, data {}) answers
 * with the first 20 clinics, which is not an answer to a question.
 */
export function dentalAskedSomething(result: object): boolean {
  const md = (result as { result?: { metadata?: { skill?: unknown; filter?: unknown } } }).result?.metadata;
  if (md?.skill === "tannlege_stats" || md?.skill === "tannlege_info") return true;
  return md?.skill === "tannlege_search" && hasFilter(md.filter);
}

function hasFilter(filter: unknown): boolean {
  return !!filter && typeof filter === "object" &&
    Object.values(filter as Record<string, unknown>).some((v) => v !== undefined && v !== null && v !== "");
}

function a2aRequestCountable(req: Request, params: unknown, result: object): boolean {
  const message = params && typeof params === "object" ? (params as Record<string, unknown>).message : undefined;
  const text = extractText(message);
  // A DataPart counts as message.data (I-X, utils/a2a-message.ts).
  const data = a2aMessageData(message);
  const meta = buildRequestMeta(req);
  return a2aLookupCountable({
    vertical: "dental",
    ipHash: hashIP(req.ip || "unknown"),
    text: text ?? (data !== undefined ? JSON.stringify(data) : ""),
    ua: meta.userAgent,
    hasStructuredData: !text,
    isInternal: isInternalTraffic(meta),
    askedSomething: dentalAskedSomething(result),
    response: result,
  });
}

/** Clinic ids in a message/send answer (the search list or the single clinic). */
export function dentalAnswerProfileIds(answer: unknown): string[] {
  const ids: string[] = [];
  const artifacts = (answer as any)?.result?.artifacts;
  if (!Array.isArray(artifacts)) return ids;
  for (const a of artifacts) {
    for (const part of Array.isArray(a?.parts) ? a.parts : []) {
      const d = part?.data;
      if (!d || typeof d !== "object") continue;
      if (Array.isArray(d.clinics)) for (const c of d.clinics) if (typeof c?.id === "string") ids.push(c.id);
      if (a.name === "dental-clinic" && typeof d.id === "string") ids.push(d.id);
    }
  }
  return ids;
}

/**
 * The org.nr a message asks about: nine digits in a row, or 3+3+3 with one
 * whitespace character (also no-break space) between the groups, as
 * Brønnøysundregistrene print it («912 345 678»; I-X, FUNN
 * dental-a2a-orgnr-med-mellomrom). The digits in a row are looked for
 * first, as before. Eight digits (a phone number, also «22 33 44 55» or
 * «912 34 567») and a postnummer are no org.nr, and nor are three groups
 * inside a longer spaced number («123 912 345 678», «kr 1 234 567 890»).
 */
function orgNrIn(text: string): string | null {
  const plain = text.match(/\b(\d{9})\b/);
  if (plain) return plain[1]!;
  const spaced = text.match(/(?<!\d\s)\b(\d{3})\s(\d{3})\s(\d{3})\b(?!\s\d)/);
  return spaced ? spaced[1]! + spaced[2]! + spaced[3]! : null;
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

  // Structured search (message.data, or the first standard DataPart: I-X,
  // utils/a2a-message.ts); free text is planned in the search branch below.
  const messageText = extractText(message);
  let searchParams: DentalSearchParams = {};

  if (!messageText && message && typeof message === "object") {
    const data = a2aMessageData(message);
    if (data && typeof data === "object") {
      const d = data as Record<string, unknown>;
      if (typeof d.fylke === "string") searchParams.fylke = d.fylke;
      if (typeof d.specialty === "string") searchParams.specialty = d.specialty;
      if (d.helfo_agreement === "true" || d.helfo_agreement === "false") {
        searchParams.helfo_agreement = d.helfo_agreement as "true" | "false";
      }
      if (d.acute_vakt === 1 || d.acute_vakt === 0) {
        searchParams.acute_vakt = d.acute_vakt as 0 | 1;
      }
      // Slice I-Y: the free-text `q` (a name or place as written) is cut like
      // message text (utils/free-text.ts). It is a LIKE pattern, and one past
      // SQLite's pattern limit (50 000 bytes) was an internal error.
      if (typeof d.q === "string") searchParams.q = capFreeText(d.q);
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

  // Special intent: single clinic by org_nr (also «912 345 678», orgNrIn)
  const orgNr = orgNrIn(lowerText);
  if (orgNr) {
    try {
      const found = getDentalAgentByOrgnr(orgNr);
      // The synthetic schema-probe row (org_nr 999999999) is not a clinic.
      const clinic = found && !isDentalSyntheticProbeId(found.id) ? found : null;
      if (!clinic) {
        return rpcOk(id, {
          taskId: `dental-info-${Date.now()}`,
          status: { state: "completed", timestamp: new Date().toISOString() },
          artifacts: [
            {
              artifactId: "clinic",
              name: "dental-clinic",
              parts: [{ kind: "text", text: `Ingen klinikk funnet med orgnr ${orgNr}` }],
            },
          ],
          metadata: { skill: "tannlege_info", org_nr: orgNr },
        });
      }
      return rpcOk(id, {
        taskId: `dental-info-${Date.now()}`,
        status: { state: "completed", timestamp: new Date().toISOString() },
        artifacts: [
          {
            artifactId: "clinic",
            name: "dental-clinic",
            // Same clean-up and card fields as the search list (dental-clinic-card.ts).
            parts: [{ kind: "data", data: toDentalA2aClinic(clinic) }],
          },
        ],
        metadata: { skill: "tannlege_info", org_nr: orgNr },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return rpcErr(id, -32603, "Internal error", msg);
    }
  }

  // Default: list/search
  try {
    let tolkning: DentalSearchTolkning | null = null;
    let total: number | null = null;
    if (messageText) {
      const plan = planDentalSearch({
        query: messageText,
        explicit: {},
        gazetteer: () => getDentalSearchGazetteer(listPoststeder),
        count: (f) => countPublicDentalAgents(f as DentalSearchParams),
        legacy: (text) => ({ ...legacyParseIntent(text) }),
      });
      searchParams = plan.filter as DentalSearchParams;
      tolkning = plan.tolkning;
      total = plan.count;
    }

    const results = listPublicDentalAgents(searchParams, 20, 0);
    // D3c: total is every clinic that matches, not this page. Free text was
    // counted by its plan; structured message.data is counted here.
    total ??= countPublicDentalAgents(searchParams);

    const summaryText =
      results.length === 0
        ? "Ingen tannlegeklinikker funnet med de angitte filtrene. / No dental clinics found matching the given filters."
        : total > results.length
          ? `Fant ${total} tannlegeklinikk(er), viser de ${results.length} første. / Found ${total} dental clinic(s), showing the first ${results.length}.`
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
          // dev-request 2026-10-16-tannlege-mcp-instrukser-og-klinikkort (S4b):
          // the stored row with untrue values made honest (displayable phones,
          // acute_vakt only with provenance), no rating fields or
          // field_provenance, plus the search card shared with MCP. count is
          // the clinics in this answer; total (D3c) every clinic that matches.
          parts: [{ kind: "data", data: { count: results.length, total, clinics: results.map(toDentalA2aClinic) } }],
        },
      ],
      metadata: {
        skill: "tannlege_search",
        filter: searchParams,
        parsedFrom: messageText || null,
        ...(tolkning ? { tolkning } : {}),
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
  res.json(getDentalAgentCard(safeHonestCatalogCount("dental")));
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
        (res.locals ||= {}).a2aCountable = a2aRequestCountable(req, params, result);
        // «Med i AI-svar»: the clinics in a countable answer, once per profile.
        recordA2aDelivery(req, res, dentalAnswerProfileIds(result), JSON.stringify(params ?? null), "dental");
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
