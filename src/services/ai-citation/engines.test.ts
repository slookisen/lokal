/**
 * engines.test.ts — A2A dev-request 2026-10-16-siteringspanel, S5a: the four engine adapters.
 *
 * No network: every call passes a fetch stub (deps.fetchImpl) that answers as the provider and
 * records the request; the keys are fakes. Covers the "engines" block of
 * config/ai-citation-panel.json (the shipped defaults, its validation, AI_CITATION_<ENGINE>_MODEL
 * picking a listed model, an unpriced model never asked, cost and per-call bound following the
 * config); per engine the request (URL, the key only in a header, the search tool, the
 * instruction, the configured model), the parsing of a documented answer (cited URLs, snippet ≤
 * 300 chars) and the cost; that an engine without its key is off and never calls; the failure
 * codes and how their cost is booked (non-2xx 0, timeout / unreadable 2xx at the bound); that
 * each request is counted with noteLlmCall("ai-citation-<engine>"); the URL and domain helpers;
 * and that a key never reaches a result, even when the provider echoes it.
 */
import panelConfig from "../../config/ai-citation-panel.json";
import {
  ANSWER_SNIPPET_MAX_CHARS,
  ANTHROPIC_MESSAGES_URL,
  CITATION_ENGINE_IDS,
  CITATION_PANEL_INSTRUCTION,
  GEMINI_API_BASE,
  MAX_CITED_URLS,
  OPENAI_RESPONSES_URL,
  PERPLEXITY_SONAR_URL,
  answerSnippetOf,
  citationCallCostUsd,
  citationEngineKeys,
  citationEnginesForView,
  citationHostOf,
  citationModelEnvOf,
  citedDomainOf,
  cleanCitedUrls,
  loadCitationEngineConfig,
  loadCitationEngines,
  parseAnthropicAnswer,
  parseGeminiAnswer,
  type CitationEngine,
  type CitationEngineId,
  type CitationRunResult,
} from "./engines";
import { createLlmCallMeter, runWithLlmCallMeter } from "../llm-call-meter";

export interface TestSummary { passed: number; failed: number; failures: string[] }

// ── Fixtures ──────────────────────────────────────────────────────────

export const FAKE_KEYS = {
  ANTHROPIC_API_KEY: "sk-ant-test-0123456789abcdefghijklmnop",
  OPENAI_API_KEY: "sk-proj-test-abcdefghijklmnop0123456789",
  PERPLEXITY_API_KEY: "pplx-test-0123456789abcdefghijklmnop",
  GEMINI_API_KEY: "AIzaTest0123456789abcdefghijklmnopqrstu",
} as const;
export const ENV_ALL = { ...FAKE_KEYS } as NodeJS.ProcessEnv;

type Reply = { status: number; body?: unknown; raw?: string } | Error;
export interface StubCall { url: string; init: any; body: any }

/** A fetch stub: records every request and answers with `reply`. */
export function stubFetch(reply: (url: string, body: any, init: any) => Reply | Promise<Reply>) {
  const calls: StubCall[] = [];
  const fetchImpl = (async (input: any, init: any) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, init, body });
    const r = await reply(url, body, init);
    if (r instanceof Error) throw r;
    const text = r.raw !== undefined ? r.raw : r.body === undefined ? "" : JSON.stringify(r.body);
    return new Response(text, { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** A copy of the shipped config, to edit in a test. */
export const configCopy = (): any => JSON.parse(JSON.stringify(panelConfig));

/** A documented answer per engine that cites `urls` (Gemini: as redirect links titled with the host). */
export function answerFor(engine: CitationEngineId, urls: readonly string[], text = "Her er noen forslag.") {
  switch (engine) {
    case "anthropic":
      return {
        type: "message",
        role: "assistant",
        stop_reason: "end_turn",
        content: [
          { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "q" } },
          { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: urls.map((url) => ({ type: "web_search_result", url, title: "t", encrypted_content: "x" })) },
          { type: "text", text, citations: urls.map((url) => ({ type: "web_search_result_location", url, title: "t", cited_text: "c", encrypted_index: "i" })) },
        ],
        usage: { input_tokens: 10_000, output_tokens: 400, server_tool_use: { web_search_requests: 1 } },
      };
    case "openai":
      return {
        id: "resp_1",
        status: "completed",
        output: [
          { type: "web_search_call", id: "ws_1", status: "completed" },
          { type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: urls.map((url) => ({ type: "url_citation", url, title: "t", start_index: 0, end_index: 1 })) }] },
        ],
        usage: { input_tokens: 8_000, output_tokens: 300 },
      };
    case "perplexity":
      return {
        id: "p1",
        model: "sonar",
        citations: [...urls],
        choices: [{ index: 0, message: { role: "assistant", content: text } }],
        usage: { prompt_tokens: 20, completion_tokens: 200, cost: { total_cost: 0.0064 } },
      };
    case "gemini":
      return {
        candidates: [{
          content: { role: "model", parts: [{ text }] },
          groundingMetadata: {
            webSearchQueries: ["q"],
            groundingChunks: urls.map((u) => ({ web: { uri: `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${encodeURIComponent(u)}`, title: new URL(u).hostname } })),
          },
        }],
        usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 250, toolUsePromptTokenCount: 1_000 },
      };
  }
}

const ENGINES = loadCitationEngines(ENV_ALL);
const byId = (id: CitationEngineId, engines: readonly CitationEngine[] = ENGINES): CitationEngine => engines.find((e) => e.engine === id)!;
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;
/** Snapshot ids announced for removal or limited to past users (OpenAI / Google deprecation pages, 2026-10-19). */
const RETIRING_MODEL_RE = /^(gpt-4\.1|gpt-4o|gpt-5(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$|gpt-5\.1$|gpt-5\.4-nano|gemini-2\.|gemini-1\.)/;

export async function runEnginesTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const t = (cond: boolean, label: string) => {
    if (cond) { passed++; if (opts.log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (opts.log) console.log(`  ✗ ${label}`); }
  };
  // Every result is collected and checked for keys at the end.
  const emitted: string[] = [];
  const run = async (id: CitationEngineId, f: ReturnType<typeof stubFetch>, env: NodeJS.ProcessEnv = ENV_ALL, extra: { timeoutMs?: number; engines?: readonly CitationEngine[] } = {}) => {
    const r = await byId(id, extra.engines).run("Tannlege i Bodø", { env, fetchImpl: f.fetchImpl, timeoutMs: extra.timeoutMs });
    emitted.push(JSON.stringify(r));
    return r;
  };
  const okOf = (r: CitationRunResult) => (r.ok ? r : null);

  try {
    // ── registry ──
    t(ENGINES.map((e) => e.engine).join(",") === "anthropic,openai,perplexity,gemini" && CITATION_ENGINE_IDS.join(",") === "anthropic,openai,perplexity,gemini",
      "E1: four engines, Anthropic first");
    t(ENGINES.map((e) => e.keyEnv).join(",") === "ANTHROPIC_API_KEY,OPENAI_API_KEY,PERPLEXITY_API_KEY,GEMINI_API_KEY" &&
      ENGINES.map((e) => e.modelEnv).join(",") === "AI_CITATION_ANTHROPIC_MODEL,AI_CITATION_OPENAI_MODEL,AI_CITATION_PERPLEXITY_MODEL,AI_CITATION_GEMINI_MODEL",
      "E2: each engine names its Fly secret and its model override");
    t(ENGINES.every((e) => e.maxCostUsdPerCall > 0 && e.maxCostUsdPerCall <= 0.2 && e.price?.maxCostUsdPerCall === e.maxCostUsdPerCall && Object.isFrozen(e)),
      "E3: every engine has a positive per-call bound from the config and is frozen");

    // ── the engines block of the shipped config (B1) ──
    {
      const cfg = loadCitationEngineConfig();
      t(JSON.stringify(ENGINES.map((e) => e.model)) === JSON.stringify(CITATION_ENGINE_IDS.map((id) => cfg[id].model)) &&
        JSON.stringify(ENGINES.map((e) => e.model)) === JSON.stringify(["claude-haiku-5-5", "gpt-6-luna", "sonar", "gemini-3.5-flash-lite"]),
        "CFG1: without an override each engine asks the config's default model");
      t(ENGINES.every((e) => !!e.model && !RETIRING_MODEL_RE.test(e.model)),
        "CFG2: no default is a model announced for removal (gpt-4.1-mini, 2027-01-14) or closed to new projects (gemini-2.5)");
      t(CITATION_ENGINE_IDS.every((id) => Object.entries(cfg[id].models).every(([, m]) => m.inUsdPerMTok > 0 && m.outUsdPerMTok > 0 && m.maxCostUsdPerCall > 0)) &&
        cfg.anthropic.models["claude-haiku-5-5"].usdPerSearch === 0.01 && cfg.openai.models["gpt-6-luna"].usdPerSearch === 0.01 &&
        cfg.gemini.models["gemini-3.5-flash-lite"].usdPerSearch === 0.014 && cfg.perplexity.models.sonar.usdPerRequest === 0.005 &&
        cfg.gemini.models["gemini-3.5-flash-lite"].thinkingLevel === "minimal" && cfg.openai.models["gpt-6-luna"].longPromptTokens === 272_000,
        "CFG3: list prices per model: tokens, per search (Gemini per search query), Perplexity's request fee, Gemini 3's thinkingLevel");
      t(Object.isFrozen(cfg) && Object.isFrozen(cfg.openai.models) && Object.isFrozen(cfg.openai.models["gpt-6-luna"]), "CFG4: the loaded config is frozen");
    }
    {
      const bad = (raw: unknown) => { try { loadCitationEngineConfig(raw); return ""; } catch (e: any) { return String(e?.message); } };
      t(bad({}) !== "" && bad(null) !== "" && bad({ engines: [] }) !== "" && bad({ prompts: panelConfig.prompts }) !== "", "CFG5: a config without an engines object is rejected");
      const c = configCopy();
      delete c.engines.perplexity;
      c.engines.bing = { model: "x", models: {} };
      c.engines.anthropic.model = "claude-unlisted";
      c.engines.openai.models["gpt-6-luna"].inUsdPerMTok = -1;
      c.engines.openai.models["gpt-6-luna"].usdPerSerch = 0.01;
      c.engines.openai.models["gpt bad"] = { inUsdPerMTok: 1, outUsdPerMTok: 1, maxCostUsdPerCall: 0.1 };
      c.engines.gemini.models["gemini-3.5-flash-lite"].maxCostUsdPerCall = 0;
      c.engines.gemini.models["gemini-3.5-flash-lite"].thinkingLevel = "max";
      c.engines.gemini.models["g-long"] = { inUsdPerMTok: 1, outUsdPerMTok: 1, maxCostUsdPerCall: 0.1, longPromptTokens: 1000 };
      c.engines.gemini.models["g-long2"] = { inUsdPerMTok: 1, outUsdPerMTok: 1, maxCostUsdPerCall: 0.1, longPromptTokens: 1.5, longInUsdPerMTok: 2, longOutUsdPerMTok: 2 };
      c.engines.gemini.extra = true;
      c.engines.anthropic.models["claude-haiku-5-5"].thinkingLevel = "low";
      const msg = bad(c);
      const want = [
        "engines.bing: unknown engine", "engines.perplexity: missing", "engines.anthropic.model: not listed under models",
        "engines.openai.models.gpt-6-luna.inUsdPerMTok: must be a number ≥ 0", "engines.openai.models.gpt-6-luna.usdPerSerch: unknown key",
        "engines.openai.models.gpt bad: model id", "engines.gemini.models.gemini-3.5-flash-lite.maxCostUsdPerCall: must be above 0",
        "engines.gemini.models.gemini-3.5-flash-lite.thinkingLevel: one of", "engines.gemini.models.g-long: longPromptTokens, longInUsdPerMTok and longOutUsdPerMTok go together",
        "engines.gemini.models.g-long2.longPromptTokens: must be a whole number above 0", "engines.gemini.extra: unknown key",
        "engines.anthropic.models.claude-haiku-5-5.thinkingLevel: only for gemini",
      ];
      const missing = want.filter((w) => !msg.includes(w));
      t(missing.length === 0, `CFG6: every problem is listed by its path (missing engine, unknown engine / key / misspelt fee, unlisted default, bad price, bound 0, half long tier, bad thinkingLevel)` + (missing.length ? ` — not found: ${missing.join(" | ")}` : ""));
      const empty = configCopy();
      empty.engines.openai.models = {};
      t(bad(empty).includes("engines.openai.models: must list at least one model"), "CFG7: an engine with no models is rejected");
      const view = citationEnginesForView(ENV_ALL, c);
      const f = stubFetch(() => ({ status: 200, body: {} }));
      const results = await Promise.all(view.engines.map((e) => e.run("x", { env: ENV_ALL, fetchImpl: f.fetchImpl })));
      t(!view.configValid && view.engines.length === 4 && view.engines.every((e) => e.model === null && !e.enabled(ENV_ALL) && e.maxCostUsdPerCall === 0) &&
        results.every((r) => !r.ok && r.reason === "model_unpriced" && r.costUsd === 0) && f.calls.length === 0 &&
        citationEnginesForView(ENV_ALL).configValid,
        "CFG8: with an invalid config every engine is off and makes no call (the read views still work)");
      let threw = false;
      try { loadCitationEngines(ENV_ALL, c); } catch { threw = true; }
      t(threw, "CFG9: loadCitationEngines (the job's path) throws on an invalid config");
    }

    // ── AI_CITATION_<ENGINE>_MODEL picks a listed model; its prices follow (B1) ──
    {
      const c = configCopy();
      c.engines.openai.models["gpt-6.1-sol"] = { inUsdPerMTok: 2, outUsdPerMTok: 10, usdPerSearch: 0.01, maxCostUsdPerCall: 0.2 };
      const env = { ...ENV_ALL, AI_CITATION_OPENAI_MODEL: " gpt-6.1-sol " } as NodeJS.ProcessEnv;
      const engines = loadCitationEngines(env, c);
      const f = stubFetch(() => ({ status: 200, body: answerFor("openai", ["https://a.no/"]) }));
      const r = okOf(await run("openai", f, env, { engines }));
      t(citationModelEnvOf("openai") === "AI_CITATION_OPENAI_MODEL" && byId("openai", engines).model === "gpt-6.1-sol" && f.calls[0].body.model === "gpt-6.1-sol" &&
        byId("anthropic", engines).model === "claude-haiku-5-5",
        "MO1: AI_CITATION_OPENAI_MODEL picks another listed model for that engine only");
      t(!!r && close(r.costUsd, (8_000 * 2 + 300 * 10) / 1e6 + 0.01) && byId("openai", engines).maxCostUsdPerCall === 0.2,
        "MO2: the cost and the per-call bound are that model's own, from the config");
      const hang = await run("openai", stubFetch(() => new DOMException("timed out", "TimeoutError") as any), env, { engines });
      t(!hang.ok && hang.reason === "timeout" && hang.costUsd === 0.2, "MO3: a timeout is booked at the overriding model's bound");
      const unpriced = { ...ENV_ALL, AI_CITATION_GEMINI_MODEL: "gemini-2.5-flash" } as NodeJS.ProcessEnv;
      const ue = loadCitationEngines(unpriced);
      const uf = stubFetch(() => ({ status: 200, body: answerFor("gemini", ["https://a.no/"]) }));
      const meter = createLlmCallMeter();
      const ur = await runWithLlmCallMeter(meter, () => byId("gemini", ue).run("q", { env: unpriced, fetchImpl: uf.fetchImpl }));
      t(byId("gemini", ue).model === null && byId("gemini", ue).price === null && !byId("gemini", ue).enabled(unpriced) &&
        !ur.ok && ur.reason === "model_unpriced" && ur.costUsd === 0 && uf.calls.length === 0 && meter.calls === 0 && byId("openai", ue).enabled(unpriced),
        "MO4: an override without prices in the config turns that engine off: no call, not counted, the others unaffected");
      const proto = ["constructor", "__proto__", "toString", "hasOwnProperty"].map((m) => byId("openai", loadCitationEngines({ ...ENV_ALL, AI_CITATION_OPENAI_MODEL: m })).model);
      t(proto.every((m) => m === null), "MO5: an override that is an Object.prototype name is not a listed model");
      t(byId("perplexity", loadCitationEngines({ ...ENV_ALL, AI_CITATION_PERPLEXITY_MODEL: "   " })).model === "sonar", "MO6: a blank override keeps the default");
      const cheap = configCopy();
      cheap.engines.gemini.models["gemini-3.5-flash-lite"].usdPerSearch = 0.05;
      const g = okOf(await run("gemini", stubFetch(() => ({ status: 200, body: answerFor("gemini", ["https://a.no/"]) })), ENV_ALL, { engines: loadCitationEngines(ENV_ALL, cheap) }));
      t(!!g && close(g.costUsd, (1_030 * 0.3 + 250 * 2.5) / 1e6 + 0.05), "MO7: a price edited in the config is the price the cost uses");
    }

    // ── enabled() and no key ──
    t(ENGINES.every((e) => !e.enabled({}) && !e.enabled({ [e.keyEnv]: "   " }) && e.enabled(ENV_ALL)),
      "K1: enabled() only when the key is set (unset or blank = off)");
    {
      const f = stubFetch(() => ({ status: 200, body: {} }));
      const meter = createLlmCallMeter();
      const results = await runWithLlmCallMeter(meter, () => Promise.all(ENGINES.map((e) => e.run("x", { env: {}, fetchImpl: f.fetchImpl }))));
      t(results.every((r) => !r.ok && r.reason === "no_key" && r.costUsd === 0) && f.calls.length === 0 && meter.calls === 0,
        "K2 (AC5): an engine without its key makes no request, books no cost and is not counted");
    }

    // ── Anthropic ──
    {
      const urls = ["https://www.rettfrabonden.com/produsent/lia-gard", "https://visitnorway.no/x", "https://www.rettfrabonden.com/produsent/lia-gard"];
      const f = stubFetch(() => ({ status: 200, body: answerFor("anthropic", urls) }));
      const r = okOf(await run("anthropic", f));
      const c = f.calls[0];
      t(f.calls.length === 1 && c.url === ANTHROPIC_MESSAGES_URL && c.init.method === "POST" &&
        c.init.headers["x-api-key"] === FAKE_KEYS.ANTHROPIC_API_KEY && c.init.headers["anthropic-version"] === "2023-06-01",
        "A1: POST /v1/messages with the key in x-api-key");
      t(c.body.model === "claude-haiku-5-5" && c.body.system === CITATION_PANEL_INSTRUCTION && c.body.output_config.effort === "low" &&
        c.body.messages[0].content === "Tannlege i Bodø" && c.body.tools[0].type === "web_search_20250305" &&
        c.body.tools[0].name === "web_search" && c.body.tools[0].max_uses === 3 && c.body.tools[0].user_location.country === "NO",
        "A2: the question as the user turn, the web_search tool (max 3 searches, Norway) and the shared instruction");
      t(!JSON.stringify(c.body).includes(FAKE_KEYS.ANTHROPIC_API_KEY) && !c.url.includes(FAKE_KEYS.ANTHROPIC_API_KEY), "A3: the key is only in the header");
      t(!!r && r.citedUrls.join(" ") === "https://www.rettfrabonden.com/produsent/lia-gard https://visitnorway.no/x" && r.answerSnippet === "Her er noen forslag.",
        "A4: cited URLs come from the text citations, distinct, in order");
      t(!!r && close(r.costUsd, (10_000 * 0.1 + 400 * 0.5) / 1e6 + 0.01), "A5: cost = tokens at $0.10/$0.50 per MTok + $0.01 per search");
      const ap = byId("anthropic").price!;
      t(close(citationCallCostUsd(ap, { inputTokens: 120_000, outputTokens: 1_000, searches: 2 }), (120_000 * 0.5 + 1_000 * 2.5) / 1e6 + 0.02) &&
        close(citationCallCostUsd(ap, { inputTokens: 100_000, outputTokens: 1_000, searches: 0 }), (100_000 * 0.1 + 1_000 * 0.5) / 1e6),
        "A6: a prompt over 100K tokens is priced at the long-prompt rate (exactly 100K is not)");
      const refusal = await run("anthropic", stubFetch(() => ({ status: 200, body: { ...answerFor("anthropic", []), stop_reason: "refusal" } })));
      t(!refusal.ok && refusal.reason === "refusal" && refusal.costUsd > 0, "A7: a refusal is an error with its cost booked");
      const toolErr = await run("anthropic", stubFetch(() => ({ status: 200, body: {
        content: [{ type: "web_search_tool_result", tool_use_id: "s", content: { type: "web_search_tool_result_error", error_code: "unavailable" } }, { type: "text", text: "Beklager." }],
        usage: { input_tokens: 500, output_tokens: 20 },
      } })));
      t(!toolErr.ok && toolErr.reason === "search_tool_error", "A8: a search tool error with nothing cited is search_tool_error");
      const nothing = okOf(await run("anthropic", stubFetch(() => ({ status: 200, body: { content: [{ type: "text", text: "Jeg vet ikke." }], usage: {} } }))));
      t(!!nothing && nothing.citedUrls.length === 0 && nothing.costUsd === 0, "A9: an answer without citations is ok with no URLs");
      const paused = await run("anthropic", stubFetch(() => ({ status: 200, body: { ...answerFor("anthropic", ["https://a.no/"]), stop_reason: "pause_turn" } })));
      t(!paused.ok && paused.reason === "pause_turn" && close(paused.costUsd, (10_000 * 0.1 + 400 * 0.5) / 1e6 + 0.01),
        "A10 (S6): pause_turn (the search loop stopped before an answer) is an error with its cost booked, not a partial ok");
      const pre = answerFor("anthropic", ["https://a.no/"], "Her er tre tannleger i Bodø.") as any;
      pre.content.unshift({ type: "text", text: "Jeg søker etter tannleger i Bodø. " });
      const preR = okOf(await run("anthropic", stubFetch(() => ({ status: 200, body: pre }))));
      const noSearch = parseAnthropicAnswer({ content: [{ type: "text", text: "Kun " }, { type: "text", text: "tekst." }], usage: {} });
      t(!!preR && preR.answerSnippet === "Her er tre tannleger i Bodø." && preR.citedUrls.length === 1 && noSearch?.text === "Kun tekst.",
        "A11 (S6): the snippet is the text after the last search; the preamble before it is dropped (no search: all text)");
    }

    // ── OpenAI ──
    {
      const body = answerFor("openai", ["https://www.opplevagent.no/opplevelse/hvalsafari?utm_source=openai", "https://example.com/a"]) as any;
      body.output.unshift({ type: "web_search_call", id: "ws_0", status: "completed" });
      const f = stubFetch(() => ({ status: 200, body }));
      const r = okOf(await run("openai", f));
      const c = f.calls[0];
      t(c.url === OPENAI_RESPONSES_URL && c.init.headers.Authorization === `Bearer ${FAKE_KEYS.OPENAI_API_KEY}` &&
        c.body.model === "gpt-6-luna" && c.body.input === "Tannlege i Bodø" && c.body.instructions === CITATION_PANEL_INSTRUCTION &&
        c.body.tools[0].type === "web_search" && c.body.tools[0].user_location.country === "NO" && c.body.max_tool_calls === 3 && c.body.store === false,
        "O1: POST /v1/responses, Bearer key, web_search tool (Norway, max 3), not stored at OpenAI");
      t(!!r && r.citedUrls.length === 2 && r.citedUrls[0].startsWith("https://www.opplevagent.no/"), "O2: cited URLs from url_citation annotations");
      t(!!r && close(r.costUsd, (8_000 * 0.1 + 300 * 0.5) / 1e6 + 2 * 0.01), "O3: cost = tokens at $0.10/$0.50 per MTok + $0.01 per web_search_call");
      const op = byId("openai").price!;
      t(close(citationCallCostUsd(op, { inputTokens: 300_000, outputTokens: 1_000, searches: 3 }), (300_000 * 0.2 + 1_000 * 0.75) / 1e6 + 0.03) &&
        close(citationCallCostUsd(op, { inputTokens: 272_000, outputTokens: 0, searches: 0 }), (272_000 * 0.1) / 1e6),
        "O4: over 272K input tokens the long-context rates apply");
      t(byId("openai").maxCostUsdPerCall >= citationCallCostUsd(op, { inputTokens: 272_000, outputTokens: 2_048, searches: 3 }),
        "O5 (S8): the per-call bound covers 3 searches, a full short-context prompt and max_output_tokens");
    }

    // ── Perplexity ──
    {
      const f = stubFetch(() => ({ status: 200, body: answerFor("perplexity", ["https://finn-tannlege.com/tannlege/bodo", "https://legelisten.no/x"]) }));
      const r = okOf(await run("perplexity", f));
      const c = f.calls[0];
      t(c.url === PERPLEXITY_SONAR_URL && c.url === "https://api.perplexity.ai/v1/sonar" && c.init.headers.Authorization === `Bearer ${FAKE_KEYS.PERPLEXITY_API_KEY}` && c.body.model === "sonar" &&
        c.body.messages[0].role === "system" && c.body.messages[1].content === "Tannlege i Bodø" && c.body.web_search_options.search_context_size === "low",
        "P1: POST /v1/sonar, Bearer key, sonar with low search context");
      t(!!r && r.citedUrls.length === 2 && close(r.costUsd, 0.0064), "P2: cited URLs from `citations`; the reported usage.cost.total_cost is the cost");
      const r2 = okOf(await run("perplexity", stubFetch(() => ({ status: 200, body: {
        search_results: [{ title: "a", url: "https://a.no/1" }, { title: "b", url: "https://b.no/2" }],
        choices: [{ message: { content: "Svar" } }],
        usage: { prompt_tokens: 1_000, completion_tokens: 1_000 },
      } }))));
      t(!!r2 && r2.citedUrls.join(",") === "https://a.no/1,https://b.no/2" && close(r2.costUsd, 2_000 / 1e6 + 0.005),
        "P3: without `citations` the search_results URLs count; without a reported cost: tokens + the $0.005 request fee");
    }

    // ── Gemini ──
    {
      const body = answerFor("gemini", ["https://www.finn-tannlege.com/x", "https://legelisten.no/y"]) as any;
      body.candidates[0].groundingMetadata.webSearchQueries = ["tannlege bodø", "tannlege bodø helfo"];
      const f = stubFetch(() => ({ status: 200, body }));
      const r = okOf(await run("gemini", f));
      const c = f.calls[0];
      t(c.url === `${GEMINI_API_BASE}gemini-3.5-flash-lite:generateContent` && c.init.headers["x-goog-api-key"] === FAKE_KEYS.GEMINI_API_KEY &&
        !c.url.includes("key=") && !c.url.includes(FAKE_KEYS.GEMINI_API_KEY) && JSON.stringify(c.body.tools) === JSON.stringify([{ google_search: {} }]) &&
        c.body.contents[0].parts[0].text === "Tannlege i Bodø" && c.body.system_instruction.parts[0].text === CITATION_PANEL_INSTRUCTION,
        "G1: generateContent on the configured model with google_search; the key in x-goog-api-key, never in the URL");
      t(JSON.stringify(c.body.generationConfig) === JSON.stringify({ maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: "minimal" } }),
        "G1b: Gemini 3 thinking is set with thinkingLevel from the config (no thinkingBudget)");
      t(!!r && r.citedUrls.length === 0 && JSON.stringify(r.citedDomains) === JSON.stringify(["finn-tannlege.com", "legelisten.no"]),
        "G2 (S5): the expiring redirect links are not kept; the source domains come from the chunks' titles");
      t(!!r && close(r.costUsd, (1_030 * 0.3 + 250 * 2.5) / 1e6 + 2 * 0.014),
        "G3: cost = tokens (tool-use prompt included) + $0.014 per search query (Gemini 3 grounding)");
      const p = parseGeminiAnswer({ candidates: [{ content: { parts: [{ text: "a" }] }, groundingMetadata: { groundingChunks: [
        { web: { uri: "https://vertexaisearch.cloud.google.com/r/1", title: "Visit Norway – offisiell side" } },
        { web: { uri: "https://www.example.org/side", title: "Eksempel" } },
        { web: { uri: "https://vertexaisearch.cloud.google.com/r/2", title: "x", domain: "Tripadvisor.no" } },
      ] } }] });
      t(!!p && JSON.stringify(p.citedDomains) === JSON.stringify(["example.org", "tripadvisor.no"]) && JSON.stringify(p.citedUrls) === JSON.stringify(["https://www.example.org/side"]),
        "G4: a title that is no host name and a redirect uri give no domain; web.domain and a direct uri do (a direct uri is kept as a URL)");
      t(!!p && p.searches === 1, "G4b: grounding chunks without webSearchQueries still count one search query");
      const gp = byId("gemini").price!;
      const ungrounded = parseGeminiAnswer({ candidates: [{ content: { parts: [{ text: "a" }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, thoughtsTokenCount: 5 } });
      t(!!ungrounded && ungrounded.searches === 0 && close(citationCallCostUsd(gp, ungrounded), (10 * 0.3 + 15 * 2.5) / 1e6),
        "G5: an answer without grounding pays no search fee; thinking tokens are output");
      const noLevel = configCopy();
      delete noLevel.engines.gemini.models["gemini-3.5-flash-lite"].thinkingLevel;
      const nf = stubFetch(() => ({ status: 200, body: answerFor("gemini", []) }));
      await run("gemini", nf, ENV_ALL, { engines: loadCitationEngines(ENV_ALL, noLevel) });
      t(JSON.stringify(nf.calls[0].body.generationConfig) === JSON.stringify({ maxOutputTokens: 2048 }), "G6: a model without thinkingLevel keeps its default thinking");
    }

    // ── failures and how their cost is booked ──
    {
      const echo = await run("openai", stubFetch(() => ({ status: 401, body: { error: { message: `Incorrect API key provided: ${FAKE_KEYS.OPENAI_API_KEY}` } } })));
      t(!echo.ok && echo.reason === "http_401" && echo.costUsd === 0 && !JSON.stringify(echo).includes(FAKE_KEYS.OPENAI_API_KEY),
        "F1: a 401 that echoes the key is http_401 with no text and cost 0");
      const e500 = await run("perplexity", stubFetch(() => ({ status: 503, raw: "<html>down</html>" })));
      t(!e500.ok && e500.reason === "http_503" && e500.costUsd === 0, "F2: a 5xx is http_<status>, cost 0");
      // AbortSignal.timeout's timer does not keep the process alive, so the hanging request holds a timer of its own.
      const hang = stubFetch((_u, _b, init) => new Promise<Reply>((_res, rej) => {
        const keepAlive = setTimeout(() => rej(new Error("abort never fired")), 5_000);
        init.signal.addEventListener("abort", () => { clearTimeout(keepAlive); rej(init.signal.reason); });
      }));
      const timeout = await run("anthropic", hang, ENV_ALL, { timeoutMs: 20 });
      t(!timeout.ok && timeout.reason === "timeout" && timeout.costUsd === byId("anthropic").maxCostUsdPerCall && timeout.costUsd === 0.12,
        "F3: a timeout is booked at the per-call bound (it may have been billed)");
      const net = await run("gemini", stubFetch(() => new TypeError("fetch failed")));
      t(!net.ok && net.reason === "network" && net.costUsd === 0, "F4: a network error is network, cost 0");
      const badJson = await run("openai", stubFetch(() => ({ status: 200, raw: "{not json" })));
      t(!badJson.ok && badJson.reason === "invalid_json" && badJson.costUsd === byId("openai").maxCostUsdPerCall, "F5: a 2xx that is not JSON is booked at the bound");
      const odd = await Promise.all(ENGINES.map((e) => run(e.engine, stubFetch(() => ({ status: 200, body: { hello: "world" } })))));
      t(odd.every((r, i) => !r.ok && r.reason === "unexpected_response" && r.costUsd === ENGINES[i].maxCostUsdPerCall),
        "F6: a 2xx of the wrong shape is unexpected_response, booked at the bound");
      const noUsage = await Promise.all(ENGINES.map((e) => {
        const body: any = answerFor(e.engine, ["https://a.no/"]);
        delete body.usage;
        delete body.usageMetadata;
        return run(e.engine, stubFetch(() => ({ status: 200, body })));
      }));
      t(noUsage.every((r, i) => r.ok && r.costUsd === ENGINES[i].maxCostUsdPerCall && (r.citedUrls.length === 1 || (ENGINES[i].engine === "gemini" && r.citedDomains?.length === 1))),
        "F7: an answer without a usage object is kept, its cost booked at the bound");
    }

    // ── call counting ──
    {
      const meter = createLlmCallMeter();
      const f = stubFetch((url) => {
        const id: CitationEngineId = url.includes("anthropic") ? "anthropic" : url.includes("openai") ? "openai" : url.includes("perplexity") ? "perplexity" : "gemini";
        return { status: 200, body: answerFor(id, ["https://a.no/"]) };
      });
      await runWithLlmCallMeter(meter, async () => {
        for (const e of ENGINES) await e.run("q", { env: ENV_ALL, fetchImpl: f.fetchImpl });
        await byId("openai").run("q", { env: {}, fetchImpl: f.fetchImpl });
      });
      t(meter.calls === 4 && f.calls.length === 4 &&
        ["anthropic", "openai", "perplexity", "gemini"].every((id) => meter.bySource[`ai-citation-${id}`] === 1),
        "M1: each request is counted once as ai-citation-<engine>; the no-key run is not");
    }

    // ── helpers ──
    t(citedDomainOf("https://www.VisitNorway.no/x?y=1") === "visitnorway.no" && citedDomainOf("m.facebook.com") === "facebook.com" &&
      citedDomainOf("https://shop.example.co.uk/a") === "example.co.uk" && citedDomainOf("finn-tannlege.com.") === "finn-tannlege.com" &&
      citedDomainOf("http://10.1.2.3/x") === "10.1.2.3" && citedDomainOf("not a host") === null && citedDomainOf("") === null,
      "D1: cited domain = registrable domain, lowercase, without www. and a trailing dot");
    t(citationHostOf("https://evil.example\\@rettfrabonden.com/x") === "evil.example" && citedDomainOf("https://evil.example\\@rettfrabonden.com/x") === "evil.example" &&
      citationHostOf("https://WWW.Finn-Tannlege.com./t") === "finn-tannlege.com" && citationHostOf("https://user:pw@www.opplevagent.no:8443/x") === "opplevagent.no" &&
      citationHostOf("https://svanøylaks.no/") === "xn--svanylaks-o8a.no" && citationHostOf("https://[::1]/") === "[::1]" && citedDomainOf("https://[::1]/") === null &&
      citationHostOf("www.Visitnorway.no") === "visitnorway.no" && citationHostOf("https://") === null,
      "D1b (S2): a URL's host is read as WHATWG URL reads it (a backslash before @ ends the host), lowercase, without www., dots, user info and port");
    const many = Array.from({ length: 60 }, (_, i) => `https://s${i}.no/`);
    const cleaned = cleanCitedUrls([" https://a.no/x ", "https://a.no/x", "ftp://a.no/", "javascript:alert(1)", 42, null, `https://a.no/${"x".repeat(1_100)}`, "http://b.no"]);
    t(JSON.stringify(cleaned) === JSON.stringify(["https://a.no/x", "http://b.no"]) && cleanCitedUrls(many).length === MAX_CITED_URLS,
      "D2: cited URLs: http(s) only, trimmed, distinct, not over-long, at most 40");
    const long = answerSnippetOf(`${"Ærlig   svar\n".repeat(60)}🙂🙂`);
    t(Array.from(long).length === ANSWER_SNIPPET_MAX_CHARS && !/\s{2}|\n/.test(long) && answerSnippetOf("  kort \n svar ") === "kort svar",
      "D3: the snippet is whitespace-collapsed and at most 300 characters");
    t(JSON.stringify(citationEngineKeys({ OPENAI_API_KEY: "k-123456789", GEMINI_API_KEY: " " })) === JSON.stringify(["k-123456789"]),
      "D4: citationEngineKeys lists only the keys that are set");

    // ── no key anywhere ──
    const out = emitted.join("\n");
    const leaked = Object.values(FAKE_KEYS).filter((k) => out.includes(k));
    t(emitted.length >= 15 && leaked.length === 0, `SEC1 (AC5): no key in any of ${emitted.length} results` + (leaked.length ? ` (leaked: ${leaked.length})` : ""));
  } catch (err: any) {
    failed++;
    failures.push("engines: unexpected error: " + String(err?.stack || err?.message || err));
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runEnginesTests({ log: true }).then((r) => {
    console.log(`\nai-citation engines: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
