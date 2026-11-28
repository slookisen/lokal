// ─── AI citation panel: the engine adapters ──────────────────────────────────
// A2A dev-request 2026-10-16-siteringspanel, S5a.
//
// Once a week the panel (panel-runner.ts, run by panel-job.ts) asks ~50 fixed
// Norwegian questions (config/ai-citation-panel.json) to four AI APIs that
// search the web, and stores which URLs each answer cites. This file is the
// four APIs. Every adapter has the same shape (CitationEngine):
//   { engine, enabled(), run(prompt) -> { citedUrls, answerSnippet, costUsd } }
// and is built from its definition (request + parser) in CITATION_ENGINE_DEFS,
// so a new engine is one more definition there plus its block in the config.
// Order there is the order the runner asks in: Anthropic first, since its key
// is already in prod.
//
//   anthropic   POST api.anthropic.com/v1/messages, server tool web_search_20250305
//               (max_uses 3), output_config.effort. Cited = the text blocks'
//               web_search_result_location citations. Searches =
//               usage.server_tool_use.web_search_requests. Cut off = stop_reason
//               max_tokens / model_context_window_exceeded.
//   openai      POST api.openai.com/v1/responses, tool web_search (max_tool_calls 3,
//               store false), reasoning.effort. Cited = output_text url_citation
//               annotations. Searches = the web_search_call items. Cut off = status
//               incomplete.
//   perplexity  POST api.perplexity.ai/v1/sonar (Sonar chat shape; Perplexity now serves
//               it through its Agent API), search context low, no effort setting.
//               Cited = `citations` (else search_results[].url). Cost =
//               usage.cost.total_cost when the API reports it, else tokens + the
//               request fee. Cut off = finish_reason length.
//   gemini      POST generativelanguage.googleapis.com/v1beta/models/<m>:generateContent,
//               tool google_search, thinkingConfig.thinkingLevel. Cited =
//               groundingMetadata.groundingChunks. Their uri is an expiring
//               Google redirect link, so it is not kept: the source domain comes from
//               chunk.web.domain / .title (citedDomains). Searches = webSearchQueries
//               (Gemini 3 bills grounding per search query; the 5 000 free a month are
//               not counted, so the figure errs high). Cut off = finishReason MAX_TOKENS.
//
// Models, prices and the two request settings an answer depends on are config, not
// code: config/ai-citation-panel.json "engines" holds, per engine, the default model
// and, per model id, the list prices (input / output per MTok, an optional long-prompt
// tier, per search, per request), maxCostUsdPerCall, maxOutputTokens (the answer's token
// limit, reasoning included) and an optional effort (the reasoning depth, sent as the
// engine's own field above; absent = the model's default, which for a reasoning model
// may spend the whole limit before the answer). AI_CITATION_<ENGINE>_MODEL (e.g.
// AI_CITATION_OPENAI_MODEL) picks another model, which must be listed there as well:
// the caps are computed with the asked model's own prices and it is asked with its
// own token limit and effort, so a model that is not listed is never asked (the
// engine is off). The config is checked when it is loaded (loadCitationEngineConfig);
// an invalid one makes no call. The shipped prices are the providers' list prices as
// read on 2026-10-19 (Perplexity no longer lists Sonar prices, so the last published
// ones stand in until the API reports a cost). They feed the caps and the report
// only, never a bill; the providers' own spend caps stay the outer limit.
//
// Caps: maxCostUsdPerCall is an upper bound the runner checks against the run and
// month caps BEFORE a call. A call whose cost cannot be read (timeout, a 2xx that is
// not the documented shape or has no usage object) is booked at that bound, so the
// caps stay safe. A non-2xx answer is booked at 0 (not billed). The shipped bounds
// cover a call that spends the model's whole token limit with its most searches
// (Gemini sets no search limit: 8 queries are covered).
//
// Only a whole answer is stored as one: an answer cut off at the token limit is the
// error incomplete (what it cited so far is not what the answer cites), and an answer
// with no visible text is empty_answer, so neither counts as "answered, not cited" in
// the share. Both are billed, so their cost is booked as for an answer.
//
// Secrets: a key is read from the environment when a call starts (keyEnv) and
// goes only into a request header (Gemini too: x-goog-api-key, not the URL).
// Nothing here logs. Failures are fixed reason codes (no_key, model_unpriced,
// timeout, network, http_<status>, invalid_json, unexpected_response, refusal,
// pause_turn, search_tool_error, incomplete, empty_answer), never response text or
// an exception message, so a provider error that echoes the key cannot carry it any
// further. Each request is counted with noteLlmCall("ai-citation-<engine>") right
// before it is sent.

import panelConfig from "../../config/ai-citation-panel.json";
import { noteLlmCall } from "../llm-call-meter";
import { hostFromUrlLike, registrableDomain } from "../cross-source-validator";

/** The engines, in the order the runner asks them. */
export const CITATION_ENGINE_IDS = ["anthropic", "openai", "perplexity", "gemini"] as const;
export type CitationEngineId = (typeof CITATION_ENGINE_IDS)[number];

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
   * Source domains as the engine names them, when it gives no source URLs (Gemini's
   * are redirect links). Absent: the runner takes the domains from citedUrls.
   */
  citedDomains?: string[];
  /** The answer text, whitespace collapsed, at most ANSWER_SNIPPET_MAX_CHARS. */
  answerSnippet: string;
  costUsd: number;
}

export type CitationRunResult = ({ ok: true } & CitationAnswer) | { ok: false; reason: string; costUsd: number };

// ── Models and prices (config/ai-citation-panel.json "engines") ──────

/** One model's list prices (USD) and the bound of one call. */
export interface CitationModelPrice {
  inUsdPerMTok: number;
  outUsdPerMTok: number;
  /** Long-prompt tier: above this many input tokens both long rates apply; null = one tier. */
  longPromptTokens: number | null;
  longInUsdPerMTok: number;
  longOutUsdPerMTok: number;
  /** Per search the answer reports (see the table at the top). */
  usdPerSearch: number;
  /** Per request (Perplexity's request fee). */
  usdPerRequest: number;
  /** Upper bound of one call: checked against the caps before the call, booked when the cost cannot be read. */
  maxCostUsdPerCall: number;
  /** The answer's token limit, reasoning included (max_tokens / max_output_tokens / maxOutputTokens). */
  maxOutputTokens: number;
  /** Reasoning depth, one of the engine's effortLevels (CitationEngineDef); null = the model's default. */
  effort: string | null;
}

export interface CitationEngineConfig {
  /** The model asked unless AI_CITATION_<ENGINE>_MODEL names another listed one. */
  model: string;
  /** Prices per model id; only a model listed here is ever asked. */
  models: Readonly<Record<string, CitationModelPrice>>;
}

export type CitationEnginesConfig = Readonly<Record<CitationEngineId, CitationEngineConfig>>;

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const PRICE_KEYS = [
  "inUsdPerMTok", "outUsdPerMTok", "longPromptTokens", "longInUsdPerMTok", "longOutUsdPerMTok",
  "usdPerSearch", "usdPerRequest", "maxCostUsdPerCall", "maxOutputTokens", "effort",
];

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** The env var that overrides an engine's model, e.g. AI_CITATION_OPENAI_MODEL. */
export function citationModelEnvOf(engine: CitationEngineId): string {
  return `AI_CITATION_${engine.toUpperCase()}_MODEL`;
}

/**
 * The "engines" block of config/ai-citation-panel.json (or `raw`), checked: exactly the four
 * engines; per engine a default model that is listed under models; per model the input and
 * output price, optional per-search / per-request fees (default 0), a long-prompt tier given in
 * full or not at all, a maxCostUsdPerCall above 0, a maxOutputTokens and, optionally, an effort
 * the engine knows (its effortLevels; Perplexity has none); no unknown keys (a misspelt fee must
 * not silently drop out of the cost). Prices are finite and ≥ 0. Throws with every problem
 * listed by its path, so a broken edit makes no call.
 */
export function loadCitationEngineConfig(raw: unknown = panelConfig): CitationEnginesConfig {
  const engines = isObject(raw) ? raw.engines : undefined;
  if (!isObject(engines)) throw new Error("ai-citation-panel.json: engines must be an object");
  const problems: string[] = [];
  for (const k of Object.keys(engines)) {
    if (!(CITATION_ENGINE_IDS as readonly string[]).includes(k)) problems.push(`engines.${k}: unknown engine`);
  }
  const out: Partial<Record<CitationEngineId, CitationEngineConfig>> = {};
  for (const id of CITATION_ENGINE_IDS) {
    const e = engines[id];
    const at = `engines.${id}`;
    if (!isObject(e)) {
      problems.push(`${at}: missing`);
      continue;
    }
    const models: Record<string, CitationModelPrice> = {};
    if (!isObject(e.models) || Object.keys(e.models).length === 0) problems.push(`${at}.models: must list at least one model`);
    else {
      for (const [modelId, m] of Object.entries(e.models)) {
        const mat = `${at}.models.${modelId}`;
        if (!MODEL_ID_RE.test(modelId)) problems.push(`${mat}: model id`);
        const price = checkPrice(m, mat, problems, id);
        if (price) models[modelId] = Object.freeze(price);
      }
    }
    if (typeof e.model !== "string" || !MODEL_ID_RE.test(e.model)) problems.push(`${at}.model: model id`);
    else if (isObject(e.models) && !hasOwn(e.models, e.model)) problems.push(`${at}.model: not listed under models`);
    for (const k of Object.keys(e)) if (k !== "model" && k !== "models") problems.push(`${at}.${k}: unknown key`);
    out[id] = Object.freeze({ model: e.model, models: Object.freeze(models) });
  }
  if (problems.length > 0) throw new Error(`ai-citation-panel.json: ${problems.join("; ")}`);
  return Object.freeze(out as Record<CitationEngineId, CitationEngineConfig>);
}

function checkPrice(m: unknown, at: string, problems: string[], engine: CitationEngineId): CitationModelPrice | null {
  if (!isObject(m)) {
    problems.push(`${at}: must be an object`);
    return null;
  }
  const before = problems.length;
  const usd = (k: string, required: boolean): number => {
    const v = m[k];
    if (v === undefined && !required) return 0;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) problems.push(`${at}.${k}: must be a number ≥ 0`);
    return typeof v === "number" ? v : 0;
  };
  const price: CitationModelPrice = {
    inUsdPerMTok: usd("inUsdPerMTok", true),
    outUsdPerMTok: usd("outUsdPerMTok", true),
    longPromptTokens: null,
    longInUsdPerMTok: 0,
    longOutUsdPerMTok: 0,
    usdPerSearch: usd("usdPerSearch", false),
    usdPerRequest: usd("usdPerRequest", false),
    maxCostUsdPerCall: usd("maxCostUsdPerCall", true),
    maxOutputTokens: 0,
    effort: null,
  };
  if (!(price.maxCostUsdPerCall > 0)) problems.push(`${at}.maxCostUsdPerCall: must be above 0`);
  if (!Number.isInteger(m.maxOutputTokens) || m.maxOutputTokens <= 0) problems.push(`${at}.maxOutputTokens: must be a whole number above 0`);
  else price.maxOutputTokens = m.maxOutputTokens;
  const longKeys = ["longPromptTokens", "longInUsdPerMTok", "longOutUsdPerMTok"].filter((k) => m[k] !== undefined);
  if (longKeys.length === 3) {
    const t = m.longPromptTokens;
    if (!Number.isInteger(t) || t <= 0) problems.push(`${at}.longPromptTokens: must be a whole number above 0`);
    price.longPromptTokens = typeof t === "number" ? t : null;
    price.longInUsdPerMTok = usd("longInUsdPerMTok", true);
    price.longOutUsdPerMTok = usd("longOutUsdPerMTok", true);
  } else if (longKeys.length > 0) {
    problems.push(`${at}: longPromptTokens, longInUsdPerMTok and longOutUsdPerMTok go together`);
  }
  if (m.effort !== undefined) {
    const levels = effortLevelsOf(engine);
    if (levels.length === 0) problems.push(`${at}.effort: ${engine} has no effort setting`);
    else if (!levels.includes(m.effort)) problems.push(`${at}.effort: one of ${levels.join(", ")}`);
    else price.effort = m.effort;
  }
  for (const k of Object.keys(m)) if (!PRICE_KEYS.includes(k)) problems.push(`${at}.${k}: unknown key`);
  return problems.length === before ? price : null;
}

/** What a call used, as the answer reports it. */
export interface CitationUsage {
  inputTokens: number;
  outputTokens: number;
  searches: number;
}

/** USD for one call at `price`: tokens (the long tier when the prompt is over its threshold) + searches + the request fee. */
export function citationCallCostUsd(price: CitationModelPrice, u: CitationUsage): number {
  const long = price.longPromptTokens !== null && u.inputTokens > price.longPromptTokens;
  return (
    tokenUsd(u.inputTokens, long ? price.longInUsdPerMTok : price.inUsdPerMTok) +
    tokenUsd(u.outputTokens, long ? price.longOutUsdPerMTok : price.outUsdPerMTok) +
    u.searches * price.usdPerSearch +
    price.usdPerRequest
  );
}

// ── The adapter shape ─────────────────────────────────────────────────

export interface CitationEngine {
  engine: CitationEngineId;
  /** The Fly secret that holds the API key. */
  keyEnv: string;
  /** The env var that overrides the model (AI_CITATION_<ENGINE>_MODEL). */
  modelEnv: string;
  /** The model asked; null when the override names a model without prices in the config (the engine is then off). */
  model: string | null;
  /** That model's prices; null with model. */
  price: CitationModelPrice | null;
  /** Upper bound of one call (price.maxCostUsdPerCall; 0 without a model); the runner checks it against the caps before the call. */
  maxCostUsdPerCall: number;
  /** True when the model has prices and the key is set. */
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
 * The host of a cited URL or of a bare host name: lowercase, without www. and trailing dots.
 * An http(s) URL is read with WHATWG URL, the parser cleanCitedUrls validated it with (so
 * "https://evil.example\@rettfrabonden.com/x" is evil.example, as a browser reads it); a bare
 * host (Gemini's web.domain / title) goes through cross-source-validator's hostFromUrlLike.
 */
export function citationHostOf(urlOrHost: string): string | null {
  const s = urlOrHost.trim();
  if (!/^https?:\/\//i.test(s)) return hostFromUrlLike(s);
  try {
    return new URL(s).hostname.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * The domain a citation counts for: the registrable domain (eTLD+1) of a URL or a bare
 * host (citationHostOf + cross-source-validator's registrableDomain).
 * "https://www.visitnorway.no/x" -> "visitnorway.no", "m.facebook.com" -> "facebook.com".
 * null when there is no host.
 */
export function citedDomainOf(urlOrHost: string): string | null {
  const host = citationHostOf(urlOrHost);
  if (!host || !host.includes(".") || /\s/.test(host)) return null;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host : registrableDomain(host);
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

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

/**
 * A 2xx body read by one engine: the answer or a failure code, with what the call used (null =
 * not reported) and the cost the API reports, if it does.
 */
type ParsedCall = (
  | { ok: true; citedUrls: string[]; citedDomains?: string[]; answerSnippet: string }
  | { ok: false; reason: string }
) & { usage: CitationUsage | null; reportedCostUsd?: number | null };

/** What one engine adds to the shared run: its request and how to read its answer. */
export interface CitationEngineDef {
  engine: CitationEngineId;
  keyEnv: string;
  /** The values a model's `effort` may take in the config (the API's own names); empty = no such setting. */
  effortLevels: readonly string[];
  /** The request for `model`, with its maxOutputTokens and effort from the config. */
  request(prompt: string, key: string, model: string, price: CitationModelPrice): { url: string; headers: Record<string, string>; body: unknown };
  /** The 2xx body -> the answer; null when it is not the documented shape. */
  parse(body: any): ParsedCall | null;
}

/**
 * An adapter from its definition and the resolved model. run(): no model -> model_unpriced
 * and no key -> no_key, both without a call; else count the call, POST, parse, and book the
 * cost: the reported cost, else the model's prices on the reported usage, else the bound. An
 * answer without visible text is empty_answer, whatever the engine.
 */
function bindEngine(def: CitationEngineDef, model: string | null, price: CitationModelPrice | null): CitationEngine {
  const bound = price?.maxCostUsdPerCall ?? 0;
  return Object.freeze({
    engine: def.engine,
    keyEnv: def.keyEnv,
    modelEnv: citationModelEnvOf(def.engine),
    model: price ? model : null,
    price,
    maxCostUsdPerCall: bound,
    enabled: (env: NodeJS.ProcessEnv = process.env) => price !== null && readKey(env, def.keyEnv) !== null,
    async run(prompt: string, deps: CitationEngineDeps = {}): Promise<CitationRunResult> {
      if (!price || !model) return { ok: false, reason: "model_unpriced", costUsd: 0 };
      const key = readKey(deps.env ?? process.env, def.keyEnv);
      if (!key) return { ok: false, reason: "no_key", costUsd: 0 };
      const req = def.request(prompt, key, model, price);
      noteLlmCall(`ai-citation-${def.engine}`);
      const r = await postJson(req.url, req.headers, req.body, deps);
      if (!r.ok) return { ok: false, reason: r.reason, costUsd: r.costUnknown ? bound : 0 };
      const p = def.parse(r.body);
      if (!p) return { ok: false, reason: "unexpected_response", costUsd: bound };
      const reported = p.reportedCostUsd ?? null;
      const costUsd = reported !== null ? reported : p.usage ? citationCallCostUsd(price, p.usage) : bound;
      if (!p.ok) return { ok: false, reason: p.reason, costUsd };
      // Only reasoning, or nothing: not an answer that happens to cite nothing.
      if (!p.answerSnippet) return { ok: false, reason: "empty_answer", costUsd };
      return {
        ok: true,
        citedUrls: p.citedUrls,
        ...(p.citedDomains ? { citedDomains: p.citedDomains } : {}),
        answerSnippet: p.answerSnippet,
        costUsd,
      };
    },
  });
}

// ── Anthropic: Messages API + web_search ─────────────────────────────

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MAX_SEARCHES = 3;

export interface AnthropicParsed {
  /** The answer: the text after the last search (any preamble before it is dropped), else all text. */
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
  const blocks: any[] = body.content;
  let lastSearch = -1;
  blocks.forEach((b, i) => {
    if (b?.type === "server_tool_use" || b?.type === "web_search_tool_result") lastSearch = i;
  });
  const all: string[] = [];
  const after: string[] = [];
  const urls: unknown[] = [];
  let toolError = false;
  blocks.forEach((block, i) => {
    if (block?.type === "text" && typeof block.text === "string") {
      all.push(block.text);
      if (i > lastSearch) after.push(block.text);
      if (Array.isArray(block.citations)) {
        for (const c of block.citations) if (c?.type === "web_search_result_location") urls.push(c.url);
      }
    } else if (block?.type === "web_search_tool_result" && !Array.isArray(block.content)) {
      toolError = true;
    }
  });
  const u = body.usage ?? {};
  return {
    text: (after.length > 0 ? after : all).join(""),
    citedUrls: cleanCitedUrls(urls),
    searches: num(u.server_tool_use?.web_search_requests),
    inputTokens: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
    outputTokens: num(u.output_tokens),
    stopReason: typeof body.stop_reason === "string" ? body.stop_reason : null,
    toolError,
    usageKnown: isObject(body.usage),
  };
}

/** stop_reason values that cut the answer off before its end. */
const ANTHROPIC_CUT_OFF = ["max_tokens", "model_context_window_exceeded"];

const anthropicDef: CitationEngineDef = {
  engine: "anthropic",
  keyEnv: "ANTHROPIC_API_KEY",
  effortLevels: ["low", "medium", "high", "xhigh", "max"],
  request: (prompt, key, model, price) => ({
    url: ANTHROPIC_MESSAGES_URL,
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: {
      model,
      // Thinking (on by default in current models) counts against max_tokens.
      max_tokens: price.maxOutputTokens,
      system: CITATION_PANEL_INSTRUCTION,
      messages: [{ role: "user", content: prompt }],
      tools: [{
        type: "web_search_20250305",
        name: "web_search",
        max_uses: ANTHROPIC_MAX_SEARCHES,
        user_location: { type: "approximate", country: "NO", timezone: "Europe/Oslo" },
      }],
      ...(price.effort ? { output_config: { effort: price.effort } } : {}),
    },
  }),
  parse(body) {
    const p = parseAnthropicAnswer(body);
    if (!p) return null;
    const usage = p.usageKnown ? { inputTokens: p.inputTokens, outputTokens: p.outputTokens, searches: p.searches } : null;
    if (p.stopReason === "refusal") return { ok: false, reason: "refusal", usage };
    // The server-side search loop stopped before an answer; resuming would be a second billed call.
    if (p.stopReason === "pause_turn") return { ok: false, reason: "pause_turn", usage };
    if (p.stopReason !== null && ANTHROPIC_CUT_OFF.includes(p.stopReason)) return { ok: false, reason: "incomplete", usage };
    if (p.toolError && p.citedUrls.length === 0) return { ok: false, reason: "search_tool_error", usage };
    return { ok: true, citedUrls: p.citedUrls, answerSnippet: answerSnippetOf(p.text), usage };
  },
};

// ── OpenAI: Responses API + web_search ───────────────────────────────

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_MAX_SEARCHES = 3;

export interface OpenAiParsed {
  text: string;
  citedUrls: string[];
  searches: number;
  inputTokens: number;
  /** Reasoning included. */
  outputTokens: number;
  /** The response status: "incomplete" = cut off (incomplete_details.reason, e.g. max_output_tokens). */
  status: string | null;
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
    status: typeof body.status === "string" ? body.status : null,
    usageKnown: isObject(body.usage),
  };
}

const openAiDef: CitationEngineDef = {
  engine: "openai",
  keyEnv: "OPENAI_API_KEY",
  effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh"],
  request: (prompt, key, model, price) => ({
    url: OPENAI_RESPONSES_URL,
    headers: { Authorization: `Bearer ${key}` },
    body: {
      model,
      instructions: CITATION_PANEL_INSTRUCTION,
      input: prompt,
      tools: [{ type: "web_search", user_location: { type: "approximate", country: "NO" } }],
      max_tool_calls: OPENAI_MAX_SEARCHES,
      // A reasoning model spends this on reasoning first; at the limit it stops, maybe before any text.
      max_output_tokens: price.maxOutputTokens,
      ...(price.effort ? { reasoning: { effort: price.effort } } : {}),
      store: false,
    },
  }),
  parse(body) {
    const p = parseOpenAiAnswer(body);
    if (!p) return null;
    const usage = p.usageKnown ? { inputTokens: p.inputTokens, outputTokens: p.outputTokens, searches: p.searches } : null;
    if (p.status === "incomplete") return { ok: false, reason: "incomplete", usage };
    return { ok: true, citedUrls: p.citedUrls, answerSnippet: answerSnippetOf(p.text), usage };
  },
};

// ── Perplexity: Sonar ────────────────────────────────────────────────

export const PERPLEXITY_SONAR_URL = "https://api.perplexity.ai/v1/sonar";

export interface PerplexityParsed {
  text: string;
  citedUrls: string[];
  inputTokens: number;
  outputTokens: number;
  /** usage.cost.total_cost when the API reports it. */
  reportedCostUsd: number | null;
  /** choices[0].finish_reason: "length" = cut off at max_tokens. */
  finishReason: string | null;
  usageKnown: boolean;
}

/** Sonar body -> answer, citations and usage; null when it is not that shape. */
export function parsePerplexityAnswer(body: any): PerplexityParsed | null {
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== "string") return null;
  // `citations` is the answer's own list; newer responses may carry only search_results.
  const urls: unknown[] = Array.isArray(body.citations) && body.citations.length > 0
    ? body.citations
    : Array.isArray(body.search_results) ? body.search_results.map((r: any) => r?.url) : [];
  const u = body.usage ?? {};
  const reported = u.cost?.total_cost;
  const finish = body.choices[0].finish_reason;
  return {
    text,
    citedUrls: cleanCitedUrls(urls),
    inputTokens: num(u.prompt_tokens),
    outputTokens: num(u.completion_tokens),
    reportedCostUsd: typeof reported === "number" && Number.isFinite(reported) && reported >= 0 ? reported : null,
    finishReason: typeof finish === "string" ? finish : null,
    usageKnown: isObject(body.usage),
  };
}

const perplexityDef: CitationEngineDef = {
  engine: "perplexity",
  keyEnv: "PERPLEXITY_API_KEY",
  effortLevels: [],
  request: (prompt, key, model, price) => ({
    url: PERPLEXITY_SONAR_URL,
    headers: { Authorization: `Bearer ${key}` },
    body: {
      model,
      messages: [
        { role: "system", content: CITATION_PANEL_INSTRUCTION },
        { role: "user", content: prompt },
      ],
      max_tokens: price.maxOutputTokens,
      web_search_options: { search_context_size: "low", user_location: { country: "NO" } },
    },
  }),
  parse(body) {
    const p = parsePerplexityAnswer(body);
    if (!p) return null;
    const usage = p.usageKnown ? { inputTokens: p.inputTokens, outputTokens: p.outputTokens, searches: 0 } : null;
    if (p.finishReason === "length") return { ok: false, reason: "incomplete", usage, reportedCostUsd: p.reportedCostUsd };
    return { ok: true, citedUrls: p.citedUrls, answerSnippet: answerSnippetOf(p.text), usage, reportedCostUsd: p.reportedCostUsd };
  },
};

// ── Gemini: generateContent + Google Search grounding ────────────────

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
/** groundingChunks[].web.uri points here (an expiring redirect), not at the source. */
export const GEMINI_REDIRECT_HOST = "vertexaisearch.cloud.google.com";
const HOSTNAME_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\.?$/i;

export interface GeminiParsed {
  text: string;
  /** Source URLs only: the redirect links are left out. */
  citedUrls: string[];
  citedDomains: string[];
  /** Billed search queries: webSearchQueries, at least 1 when the answer is grounded. */
  searches: number;
  inputTokens: number;
  /** Thinking included. */
  outputTokens: number;
  /** candidates[0].finishReason: "MAX_TOKENS" = cut off at maxOutputTokens. */
  finishReason: string | null;
  usageKnown: boolean;
}

/** The source domain of one grounding chunk: web.domain, else a title that is a host name, else the uri unless it is the redirect. */
function geminiChunkDomain(web: any): string | null {
  for (const cand of [web?.domain, web?.title]) {
    if (typeof cand === "string" && HOSTNAME_RE.test(cand.trim())) return citedDomainOf(cand.trim());
  }
  if (typeof web?.uri !== "string") return null;
  const host = citationHostOf(web.uri);
  return host === null || host === GEMINI_REDIRECT_HOST ? null : citedDomainOf(web.uri);
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
    citedUrls: cleanCitedUrls(chunks.map((ch) => ch?.web?.uri)).filter((url) => citationHostOf(url) !== GEMINI_REDIRECT_HOST),
    citedDomains: domains,
    searches: Math.max(queries, chunks.length > 0 ? 1 : 0),
    inputTokens: num(u.promptTokenCount) + num(u.toolUsePromptTokenCount),
    outputTokens: num(u.candidatesTokenCount) + num(u.thoughtsTokenCount),
    finishReason: typeof cand.finishReason === "string" ? cand.finishReason : null,
    usageKnown: isObject(body.usageMetadata),
  };
}

const geminiDef: CitationEngineDef = {
  engine: "gemini",
  keyEnv: "GEMINI_API_KEY",
  effortLevels: ["minimal", "low", "medium", "high"],
  request: (prompt, key, model, price) => ({
    url: `${GEMINI_API_BASE}${encodeURIComponent(model)}:generateContent`,
    headers: { "x-goog-api-key": key },
    body: {
      system_instruction: { parts: [{ text: CITATION_PANEL_INSTRUCTION }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: {
        // Thinking counts against maxOutputTokens.
        maxOutputTokens: price.maxOutputTokens,
        ...(price.effort ? { thinkingConfig: { thinkingLevel: price.effort } } : {}),
      },
    },
  }),
  parse(body) {
    const p = parseGeminiAnswer(body);
    if (!p) return null;
    const usage = p.usageKnown ? { inputTokens: p.inputTokens, outputTokens: p.outputTokens, searches: p.searches } : null;
    if (p.finishReason === "MAX_TOKENS") return { ok: false, reason: "incomplete", usage };
    return { ok: true, citedUrls: p.citedUrls, citedDomains: p.citedDomains, answerSnippet: answerSnippetOf(p.text), usage };
  },
};

/** The engine definitions, in the order the runner asks them (CITATION_ENGINE_IDS). */
export const CITATION_ENGINE_DEFS: readonly CitationEngineDef[] = Object.freeze([anthropicDef, openAiDef, perplexityDef, geminiDef]);

/** The effort values the config may give a model of `engine` (its definition's effortLevels). */
function effortLevelsOf(engine: CitationEngineId): readonly string[] {
  return CITATION_ENGINE_DEFS.find((d) => d.engine === engine)?.effortLevels ?? [];
}

// ── Engines for an environment ───────────────────────────────────────

/**
 * The four engines for `env` from a checked config: each asks AI_CITATION_<ENGINE>_MODEL when
 * that is set, else the config's default, at that model's prices. An override without prices in
 * the config (or no config at all) leaves the engine off (model null).
 */
export function buildCitationEngines(config: CitationEnginesConfig | null, env: NodeJS.ProcessEnv = process.env): CitationEngine[] {
  return CITATION_ENGINE_DEFS.map((def) => {
    const cfg = config?.[def.engine];
    if (!cfg) return bindEngine(def, null, null);
    const model = (env[citationModelEnvOf(def.engine)] ?? "").trim() || cfg.model;
    return bindEngine(def, model, hasOwn(cfg.models, model) ? cfg.models[model] : null);
  });
}

/** buildCitationEngines on config/ai-citation-panel.json (or `raw`); throws when the config is invalid. */
export function loadCitationEngines(env: NodeJS.ProcessEnv = process.env, raw: unknown = panelConfig): CitationEngine[] {
  return buildCitationEngines(loadCitationEngineConfig(raw), env);
}

/** loadCitationEngines for the read views: with an invalid config every engine is off (model null) and configValid is false. */
export function citationEnginesForView(env: NodeJS.ProcessEnv = process.env, raw: unknown = panelConfig): { engines: CitationEngine[]; configValid: boolean } {
  try {
    return { engines: loadCitationEngines(env, raw), configValid: true };
  } catch {
    return { engines: buildCitationEngines(null, env), configValid: false };
  }
}

/** The keys currently set, for redacting log lines (never logged or returned themselves). */
export function citationEngineKeys(env: NodeJS.ProcessEnv = process.env, engines: readonly { keyEnv: string }[] = CITATION_ENGINE_DEFS): string[] {
  return engines.map((e) => readKey(env, e.keyEnv)).filter((k): k is string => k !== null);
}
