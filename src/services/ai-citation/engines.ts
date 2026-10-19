// ─── AI citation panel: the engine adapters ──────────────────────────────────
// A2A dev-request 2026-10-16-siteringspanel, S5a.
//
// Once a week the panel (panel-runner.ts, run by panel-job.ts) asks ~50 fixed
// Norwegian questions (config/ai-citation-panel.json) to four AI APIs that
// search the web, and stores which URLs each answer cites. This file is the
// four APIs. Every adapter has the same shape (CitationEngine):
//   { engine, enabled(), run(prompt) -> { citedUrls, answerSnippet, costUsd } }
// and is built by defineEngine() from its request and its parser, so a new
// engine is one more defineEngine({...}) in CITATION_ENGINES. Order there is the
// order the runner asks in: Anthropic first, since its key is already in prod.
//
//   anthropic   POST api.anthropic.com/v1/messages, server tool web_search_20250305
//               (max_uses 3). Cited = the text blocks' web_search_result_location
//               citations. Billed: tokens + usage.server_tool_use.web_search_requests.
//   openai      POST api.openai.com/v1/responses, tool web_search (max_tool_calls 3,
//               store false). Cited = output_text url_citation annotations.
//               Billed: tokens + one fee per web_search_call item.
//   perplexity  POST api.perplexity.ai/chat/completions, model sonar, search context
//               low. Cited = `citations` (else search_results[].url). Billed:
//               usage.cost.total_cost when the API reports it, else tokens + the
//               request fee.
//   gemini      POST generativelanguage.googleapis.com/v1beta/models/<m>:generateContent,
//               tool google_search, thinking off. Cited = groundingMetadata.groundingChunks.
//               Their uri is a Google redirect link, so the source domain comes from
//               chunk.web.domain / .title instead (citedDomains). Billed: tokens + one
//               fee per grounded prompt (the free daily allowance is not counted, so the
//               figure errs high).
// Prices and model ids are the providers' list prices as known when this was
// built (2026-10-19), not re-read from their pages (the build has no network);
// check them, and the providers' own spend caps, before the flag goes on (the
// spec's cost estimate, «verifiseres ved bygging»). They feed the caps and the
// report only, never a bill.
//
// Caps: each adapter states maxCostUsdPerCall, an upper bound the runner checks
// against the run and month caps BEFORE a call. A call whose cost cannot be read
// (timeout, a 2xx that is not the documented shape or has no usage object) is
// booked at that bound, so the caps stay safe. A non-2xx answer is booked at 0
// (not billed).
//
// Secrets: a key is read from the environment when a call starts (keyEnv) and
// goes only into a request header (Gemini too: x-goog-api-key, not the URL).
// Nothing here logs. Failures are fixed reason codes (no_key, timeout, network,
// http_<status>, invalid_json, unexpected_response, refusal, search_tool_error),
// never response text or an exception message, so a provider error that echoes
// the key cannot carry it any further. Each request is counted with
// noteLlmCall("ai-citation-<engine>") right before it is sent.

import { noteLlmCall } from "../llm-call-meter";
import { hostFromUrlLike, registrableDomain } from "../cross-source-validator";

export type CitationEngineId = "anthropic" | "openai" | "perplexity" | "gemini";

/** One request (fetch + body read) is aborted after this long. Web search answers take 10–60 s. */
export const AI_CITATION_REQUEST_TIMEOUT_MS = 120_000;
/** ai_citation_results.answer_snippet holds at most this many characters. */
export const ANSWER_SNIPPET_MAX_CHARS = 300;
/** At most this many distinct cited URLs are kept per answer. */
export const MAX_CITED_URLS = 40;
const MAX_URL_CHARS = 1000;

/**
 * The same instruction goes to every engine (system prompt / instructions), so the
 * answers are comparable: answer as for a user in Norway, and search first.
 */
export const CITATION_PANEL_INSTRUCTION =
  "Svar kort på norsk, slik du ville svart en bruker i Norge. Søk på nettet før du svarer, og bygg svaret på kildene du finner.";

export interface CitationEngineDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface CitationAnswer {
  /** Distinct http(s) URLs the answer cites, in the order the engine gave them. */
  citedUrls: string[];
  /**
   * Source domains as the engine names them, when its URLs are redirect links
   * (Gemini). Absent: the runner takes the domains from citedUrls.
   */
  citedDomains?: string[];
  /** The answer text, whitespace collapsed, at most ANSWER_SNIPPET_MAX_CHARS. */
  answerSnippet: string;
  costUsd: number;
}

export type CitationRunResult = ({ ok: true } & CitationAnswer) | { ok: false; reason: string; costUsd: number };

export interface CitationEngine {
  engine: CitationEngineId;
  /** The Fly secret that holds the API key. */
  keyEnv: string;
  model: string;
  /** Upper bound of one call's cost; the runner checks it against the caps before the call. */
  maxCostUsdPerCall: number;
  /** True when the key is set. */
  enabled(env?: NodeJS.ProcessEnv): boolean;
  run(prompt: string, deps?: CitationEngineDeps): Promise<CitationRunResult>;
}

// ── Shared helpers ────────────────────────────────────────────────────

function readKey(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = (env[name] ?? "").trim();
  return v ? v : null;
}

/** Whitespace collapsed, cut at ANSWER_SNIPPET_MAX_CHARS characters (code points, so no half emoji). */
export function answerSnippetOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= ANSWER_SNIPPET_MAX_CHARS ? flat : chars.slice(0, ANSWER_SNIPPET_MAX_CHARS).join("");
}

/** Distinct http(s) URLs (trimmed, at most MAX_URL_CHARS long), in order, at most MAX_CITED_URLS. */
export function cleanCitedUrls(list: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const s = raw.trim();
    if (!s || s.length > MAX_URL_CHARS || seen.has(s)) continue;
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      continue;
    }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || !u.hostname) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_CITED_URLS) break;
  }
  return out;
}

/**
 * The domain a citation counts for: the registrable domain (eTLD+1) of a URL or a bare
 * host, lowercase, without www. and a trailing dot (cross-source-validator's own
 * hostFromUrlLike + registrableDomain). "https://www.visitnorway.no/x" -> "visitnorway.no",
 * "m.facebook.com" -> "facebook.com". null when there is no host.
 */
export function citedDomainOf(urlOrHost: string): string | null {
  const host = hostFromUrlLike(urlOrHost);
  if (!host || !host.includes(".") || /\s/.test(host)) return null;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host : registrableDomain(host);
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const isObject = (v: unknown): boolean => !!v && typeof v === "object" && !Array.isArray(v);

/** USD for `tokens` at `usdPerMTok`. */
const tokenUsd = (tokens: number, usdPerMTok: number): number => (tokens * usdPerMTok) / 1_000_000;

type PostResult = { ok: true; body: any } | { ok: false; reason: string; costUnknown: boolean };

/**
 * One JSON POST. Never throws. A timeout or a 2xx without readable JSON may still be
 * billed (costUnknown); a non-2xx is not. The response text is never passed on.
 */
async function postJson(url: string, headers: Record<string, string>, body: unknown, deps: CitationEngineDeps): Promise<PostResult> {
  let status: number;
  let text: string;
  try {
    const res = await (deps.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deps.timeoutMs ?? AI_CITATION_REQUEST_TIMEOUT_MS),
    });
    status = res.status;
    text = await res.text();
  } catch (err: any) {
    const timeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    return { ok: false, reason: timeout ? "timeout" : "network", costUnknown: timeout };
  }
  if (status < 200 || status >= 300) return { ok: false, reason: `http_${status}`, costUnknown: false };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "invalid_json", costUnknown: true };
  }
}

/** What one engine adds to the shared run: its request and how to read its answer. */
interface EngineDef extends Pick<CitationEngine, "engine" | "keyEnv" | "model" | "maxCostUsdPerCall"> {
  request(prompt: string, key: string): { url: string; headers: Record<string, string>; body: unknown };
  /** The 2xx body -> result; null when it is not the documented shape. */
  parse(body: any): CitationRunResult | null;
}

/**
 * An adapter from its definition. run(): key check (no key -> no_key, no call), count the
 * call, POST, then parse; the cost of a failure is booked per the rules at the top.
 */
function defineEngine(def: EngineDef): CitationEngine {
  return Object.freeze({
    engine: def.engine,
    keyEnv: def.keyEnv,
    model: def.model,
    maxCostUsdPerCall: def.maxCostUsdPerCall,
    enabled: (env: NodeJS.ProcessEnv = process.env) => readKey(env, def.keyEnv) !== null,
    async run(prompt: string, deps: CitationEngineDeps = {}): Promise<CitationRunResult> {
      const key = readKey(deps.env ?? process.env, def.keyEnv);
      if (!key) return { ok: false, reason: "no_key", costUsd: 0 };
      const req = def.request(prompt, key);
      noteLlmCall(`ai-citation-${def.engine}`);
      const r = await postJson(req.url, req.headers, req.body, deps);
      if (!r.ok) return { ok: false, reason: r.reason, costUsd: r.costUnknown ? def.maxCostUsdPerCall : 0 };
      return def.parse(r.body) ?? { ok: false, reason: "unexpected_response", costUsd: def.maxCostUsdPerCall };
    },
  });
}

// ── Anthropic: Messages API + web_search ─────────────────────────────

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-haiku-5-5";
const ANTHROPIC_MAX_SEARCHES = 3;
// claude-haiku-5-5: $0.10 / $0.50 per MTok for a prompt up to 100K tokens, $0.50 / $2.50 above; search $10 / 1 000.
const ANTHROPIC_PRICE = { inUsdPerMTok: 0.1, outUsdPerMTok: 0.5, longInUsdPerMTok: 0.5, longOutUsdPerMTok: 2.5, longPromptTokens: 100_000, usdPerSearch: 0.01 };
/** One call at most: 3 searches ($0.03) + a long prompt of up to ~150K tokens ($0.075) + output. */
const ANTHROPIC_MAX_COST_USD = 0.12;

export interface AnthropicParsed {
  text: string;
  citedUrls: string[];
  searches: number;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
  /** A web_search_tool_result came back as an error object instead of results. */
  toolError: boolean;
  /** The body has a usage object; without one the cost is unknown. */
  usageKnown: boolean;
}

/** Messages API body -> answer text, cited URLs and usage; null when it is not that shape. */
export function parseAnthropicAnswer(body: any): AnthropicParsed | null {
  if (!body || !Array.isArray(body.content)) return null;
  const texts: string[] = [];
  const urls: unknown[] = [];
  let toolError = false;
  for (const block of body.content) {
    if (block?.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
      if (Array.isArray(block.citations)) {
        for (const c of block.citations) if (c?.type === "web_search_result_location") urls.push(c.url);
      }
    } else if (block?.type === "web_search_tool_result" && !Array.isArray(block.content)) {
      toolError = true;
    }
  }
  const u = body.usage ?? {};
  return {
    text: texts.join(""),
    citedUrls: cleanCitedUrls(urls),
    searches: num(u.server_tool_use?.web_search_requests),
    inputTokens: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
    outputTokens: num(u.output_tokens),
    stopReason: typeof body.stop_reason === "string" ? body.stop_reason : null,
    toolError,
    usageKnown: isObject(body.usage),
  };
}

export function anthropicCostUsd(p: Pick<AnthropicParsed, "inputTokens" | "outputTokens" | "searches">): number {
  const long = p.inputTokens > ANTHROPIC_PRICE.longPromptTokens;
  return (
    tokenUsd(p.inputTokens, long ? ANTHROPIC_PRICE.longInUsdPerMTok : ANTHROPIC_PRICE.inUsdPerMTok) +
    tokenUsd(p.outputTokens, long ? ANTHROPIC_PRICE.longOutUsdPerMTok : ANTHROPIC_PRICE.outUsdPerMTok) +
    p.searches * ANTHROPIC_PRICE.usdPerSearch
  );
}

const anthropicEngine = defineEngine({
  engine: "anthropic",
  keyEnv: "ANTHROPIC_API_KEY",
  model: ANTHROPIC_MODEL,
  maxCostUsdPerCall: ANTHROPIC_MAX_COST_USD,
  request: (prompt, key) => ({
    url: ANTHROPIC_MESSAGES_URL,
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: {
      model: ANTHROPIC_MODEL,
      max_tokens: 2048,
      system: CITATION_PANEL_INSTRUCTION,
      messages: [{ role: "user", content: prompt }],
      tools: [{
        type: "web_search_20250305",
        name: "web_search",
        max_uses: ANTHROPIC_MAX_SEARCHES,
        user_location: { type: "approximate", country: "NO", timezone: "Europe/Oslo" },
      }],
      output_config: { effort: "low" },
    },
  }),
  parse(body) {
    const p = parseAnthropicAnswer(body);
    if (!p) return null;
    const costUsd = p.usageKnown ? anthropicCostUsd(p) : ANTHROPIC_MAX_COST_USD;
    if (p.stopReason === "refusal") return { ok: false, reason: "refusal", costUsd };
    if (p.toolError && p.citedUrls.length === 0) return { ok: false, reason: "search_tool_error", costUsd };
    return { ok: true, citedUrls: p.citedUrls, answerSnippet: answerSnippetOf(p.text), costUsd };
  },
});

// ── OpenAI: Responses API + web_search ───────────────────────────────

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_MODEL = "gpt-4.1-mini";
const OPENAI_MAX_SEARCHES = 3;
// gpt-4.1-mini: $0.40 / $1.60 per MTok; web search tool call $25 / 1 000 (the higher of the two published rates).
const OPENAI_PRICE = { inUsdPerMTok: 0.4, outUsdPerMTok: 1.6, usdPerSearch: 0.025 };
/** One call at most: 3 searches ($0.075) + ~30K input and 2K output tokens. */
const OPENAI_MAX_COST_USD = 0.1;

export interface OpenAiParsed {
  text: string;
  citedUrls: string[];
  searches: number;
  inputTokens: number;
  outputTokens: number;
  usageKnown: boolean;
}

/** Responses API body -> output text, url_citation URLs and usage; null when it is not that shape. */
export function parseOpenAiAnswer(body: any): OpenAiParsed | null {
  if (!body || !Array.isArray(body.output)) return null;
  const texts: string[] = [];
  const urls: unknown[] = [];
  let searches = 0;
  for (const item of body.output) {
    if (item?.type === "web_search_call") searches++;
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part?.type !== "output_text" || typeof part.text !== "string") continue;
      texts.push(part.text);
      if (Array.isArray(part.annotations)) {
        for (const a of part.annotations) if (a?.type === "url_citation") urls.push(a.url);
      }
    }
  }
  const u = body.usage ?? {};
  return {
    text: texts.join(""),
    citedUrls: cleanCitedUrls(urls),
    searches,
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    usageKnown: isObject(body.usage),
  };
}

export function openAiCostUsd(p: Pick<OpenAiParsed, "inputTokens" | "outputTokens" | "searches">): number {
  return tokenUsd(p.inputTokens, OPENAI_PRICE.inUsdPerMTok) + tokenUsd(p.outputTokens, OPENAI_PRICE.outUsdPerMTok) + p.searches * OPENAI_PRICE.usdPerSearch;
}

const openAiEngine = defineEngine({
  engine: "openai",
  keyEnv: "OPENAI_API_KEY",
  model: OPENAI_MODEL,
  maxCostUsdPerCall: OPENAI_MAX_COST_USD,
  request: (prompt, key) => ({
    url: OPENAI_RESPONSES_URL,
    headers: { Authorization: `Bearer ${key}` },
    body: {
      model: OPENAI_MODEL,
      instructions: CITATION_PANEL_INSTRUCTION,
      input: prompt,
      tools: [{ type: "web_search", user_location: { type: "approximate", country: "NO" } }],
      max_tool_calls: OPENAI_MAX_SEARCHES,
      max_output_tokens: 2048,
      store: false,
    },
  }),
  parse(body) {
    const p = parseOpenAiAnswer(body);
    if (!p) return null;
    return { ok: true, citedUrls: p.citedUrls, answerSnippet: answerSnippetOf(p.text), costUsd: p.usageKnown ? openAiCostUsd(p) : OPENAI_MAX_COST_USD };
  },
});

// ── Perplexity: Sonar chat completions ───────────────────────────────

export const PERPLEXITY_CHAT_URL = "https://api.perplexity.ai/chat/completions";
const PERPLEXITY_MODEL = "sonar";
// sonar: $1 / $1 per MTok; request fee $5 / 1 000 at search context "low".
const PERPLEXITY_PRICE = { inUsdPerMTok: 1, outUsdPerMTok: 1, usdPerRequest: 0.005 };
/** One call at most: the $0.005 request fee + a few thousand tokens. */
const PERPLEXITY_MAX_COST_USD = 0.02;

export interface PerplexityParsed {
  text: string;
  citedUrls: string[];
  inputTokens: number;
  outputTokens: number;
  /** usage.cost.total_cost when the API reports it. */
  reportedCostUsd: number | null;
  usageKnown: boolean;
}

/** Chat completions body -> answer, citations and usage; null when it is not that shape. */
export function parsePerplexityAnswer(body: any): PerplexityParsed | null {
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== "string") return null;
  // `citations` is the answer's own list; newer responses may carry only search_results.
  const urls: unknown[] = Array.isArray(body.citations) && body.citations.length > 0
    ? body.citations
    : Array.isArray(body.search_results) ? body.search_results.map((r: any) => r?.url) : [];
  const u = body.usage ?? {};
  const reported = u.cost?.total_cost;
  return {
    text,
    citedUrls: cleanCitedUrls(urls),
    inputTokens: num(u.prompt_tokens),
    outputTokens: num(u.completion_tokens),
    reportedCostUsd: typeof reported === "number" && Number.isFinite(reported) && reported >= 0 ? reported : null,
    usageKnown: isObject(body.usage),
  };
}

export function perplexityCostUsd(p: Pick<PerplexityParsed, "inputTokens" | "outputTokens" | "reportedCostUsd">): number {
  if (p.reportedCostUsd !== null) return p.reportedCostUsd;
  return tokenUsd(p.inputTokens, PERPLEXITY_PRICE.inUsdPerMTok) + tokenUsd(p.outputTokens, PERPLEXITY_PRICE.outUsdPerMTok) + PERPLEXITY_PRICE.usdPerRequest;
}

const perplexityEngine = defineEngine({
  engine: "perplexity",
  keyEnv: "PERPLEXITY_API_KEY",
  model: PERPLEXITY_MODEL,
  maxCostUsdPerCall: PERPLEXITY_MAX_COST_USD,
  request: (prompt, key) => ({
    url: PERPLEXITY_CHAT_URL,
    headers: { Authorization: `Bearer ${key}` },
    body: {
      model: PERPLEXITY_MODEL,
      messages: [
        { role: "system", content: CITATION_PANEL_INSTRUCTION },
        { role: "user", content: prompt },
      ],
      max_tokens: 1024,
      web_search_options: { search_context_size: "low", user_location: { country: "NO" } },
    },
  }),
  parse(body) {
    const p = parsePerplexityAnswer(body);
    if (!p) return null;
    return { ok: true, citedUrls: p.citedUrls, answerSnippet: answerSnippetOf(p.text), costUsd: p.usageKnown ? perplexityCostUsd(p) : PERPLEXITY_MAX_COST_USD };
  },
});

// ── Gemini: generateContent + Google Search grounding ────────────────

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const GEMINI_MODEL = "gemini-2.5-flash";
/** groundingChunks[].web.uri points here (a redirect), not at the source. */
export const GEMINI_REDIRECT_HOST = "vertexaisearch.cloud.google.com";
// gemini-2.5-flash: $0.30 / $2.50 per MTok; grounding with Google Search $35 / 1 000 grounded prompts.
const GEMINI_PRICE = { inUsdPerMTok: 0.3, outUsdPerMTok: 2.5, usdPerGroundedPrompt: 0.035 };
/** One call at most: one grounded prompt ($0.035) + ~20K input and 2K output tokens. */
const GEMINI_MAX_COST_USD = 0.05;
const HOSTNAME_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\.?$/i;

export interface GeminiParsed {
  text: string;
  citedUrls: string[];
  citedDomains: string[];
  grounded: boolean;
  inputTokens: number;
  outputTokens: number;
  usageKnown: boolean;
}

/** The source domain of one grounding chunk: web.domain, else a title that is a host name, else the uri unless it is the redirect. */
function geminiChunkDomain(web: any): string | null {
  for (const cand of [web?.domain, web?.title]) {
    if (typeof cand === "string" && HOSTNAME_RE.test(cand.trim())) return citedDomainOf(cand.trim());
  }
  if (typeof web?.uri !== "string") return null;
  let host: string;
  try {
    host = new URL(web.uri).hostname.toLowerCase();
  } catch {
    return null;
  }
  return host === GEMINI_REDIRECT_HOST ? null : citedDomainOf(host);
}

/** generateContent body -> answer, grounding sources and usage; null when it is not that shape. */
export function parseGeminiAnswer(body: any): GeminiParsed | null {
  const cand = Array.isArray(body?.candidates) ? body.candidates[0] : undefined;
  if (!cand || typeof cand !== "object") return null;
  const parts = Array.isArray(cand.content?.parts) ? cand.content.parts : [];
  const text = parts.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("");
  const gm = cand.groundingMetadata ?? {};
  const chunks: any[] = Array.isArray(gm.groundingChunks) ? gm.groundingChunks : [];
  const domains: string[] = [];
  for (const ch of chunks) {
    const d = geminiChunkDomain(ch?.web);
    if (d && !domains.includes(d)) domains.push(d);
  }
  const queries = Array.isArray(gm.webSearchQueries) ? gm.webSearchQueries.length : 0;
  const u = body.usageMetadata ?? {};
  return {
    text,
    citedUrls: cleanCitedUrls(chunks.map((ch) => ch?.web?.uri)),
    citedDomains: domains,
    grounded: queries > 0 || chunks.length > 0,
    inputTokens: num(u.promptTokenCount) + num(u.toolUsePromptTokenCount),
    outputTokens: num(u.candidatesTokenCount) + num(u.thoughtsTokenCount),
    usageKnown: isObject(body.usageMetadata),
  };
}

export function geminiCostUsd(p: Pick<GeminiParsed, "inputTokens" | "outputTokens" | "grounded">): number {
  return tokenUsd(p.inputTokens, GEMINI_PRICE.inUsdPerMTok) + tokenUsd(p.outputTokens, GEMINI_PRICE.outUsdPerMTok) + (p.grounded ? GEMINI_PRICE.usdPerGroundedPrompt : 0);
}

const geminiEngine = defineEngine({
  engine: "gemini",
  keyEnv: "GEMINI_API_KEY",
  model: GEMINI_MODEL,
  maxCostUsdPerCall: GEMINI_MAX_COST_USD,
  request: (prompt, key) => ({
    url: `${GEMINI_API_BASE}${GEMINI_MODEL}:generateContent`,
    headers: { "x-goog-api-key": key },
    body: {
      system_instruction: { parts: [{ text: CITATION_PANEL_INSTRUCTION }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
    },
  }),
  parse(body) {
    const p = parseGeminiAnswer(body);
    if (!p) return null;
    return { ok: true, citedUrls: p.citedUrls, citedDomains: p.citedDomains, answerSnippet: answerSnippetOf(p.text), costUsd: p.usageKnown ? geminiCostUsd(p) : GEMINI_MAX_COST_USD };
  },
});

/** All engines, in the order the runner asks them. */
export const CITATION_ENGINES: readonly CitationEngine[] = Object.freeze([anthropicEngine, openAiEngine, perplexityEngine, geminiEngine]);

/** The keys currently set, for redacting log lines (never logged or returned themselves). */
export function citationEngineKeys(env: NodeJS.ProcessEnv = process.env, engines: readonly CitationEngine[] = CITATION_ENGINES): string[] {
  return engines.map((e) => readKey(env, e.keyEnv)).filter((k): k is string => k !== null);
}
