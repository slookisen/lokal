/**
 * engines.test.ts — A2A dev-request 2026-10-16-siteringspanel, S5a: the four engine adapters.
 *
 * No network: every call passes a fetch stub (deps.fetchImpl) that answers as the provider and
 * records the request; the keys are fakes. Covers per engine the request (URL, the key only in a
 * header, the search tool, the instruction), the parsing of a documented answer (cited URLs,
 * snippet ≤ 300 chars) and the cost; that an engine without its key is off and never calls; the
 * failure codes and how their cost is booked (non-2xx 0, timeout / unreadable 2xx at the bound);
 * that each request is counted with noteLlmCall("ai-citation-<engine>"); the URL and domain
 * helpers; and that a key never reaches a result, even when the provider echoes it.
 */
import {
  ANSWER_SNIPPET_MAX_CHARS,
  ANTHROPIC_MESSAGES_URL,
  CITATION_ENGINES,
  CITATION_PANEL_INSTRUCTION,
  GEMINI_API_BASE,
  MAX_CITED_URLS,
  OPENAI_RESPONSES_URL,
  PERPLEXITY_CHAT_URL,
  anthropicCostUsd,
  answerSnippetOf,
  citationEngineKeys,
  citedDomainOf,
  cleanCitedUrls,
  geminiCostUsd,
  openAiCostUsd,
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

const byId = (id: CitationEngineId): CitationEngine => CITATION_ENGINES.find((e) => e.engine === id)!;
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

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
  const run = async (id: CitationEngineId, f: ReturnType<typeof stubFetch>, env: NodeJS.ProcessEnv = ENV_ALL, extra: { timeoutMs?: number } = {}) => {
    const r = await byId(id).run("Tannlege i Bodø", { env, fetchImpl: f.fetchImpl, ...extra });
    emitted.push(JSON.stringify(r));
    return r;
  };
  const okOf = (r: CitationRunResult) => (r.ok ? r : null);

  try {
    // ── registry ──
    t(CITATION_ENGINES.map((e) => e.engine).join(",") === "anthropic,openai,perplexity,gemini", "E1: four engines, Anthropic first");
    t(CITATION_ENGINES.map((e) => e.keyEnv).join(",") === "ANTHROPIC_API_KEY,OPENAI_API_KEY,PERPLEXITY_API_KEY,GEMINI_API_KEY",
      "E2: each engine names its Fly secret");
    t(CITATION_ENGINES.every((e) => e.maxCostUsdPerCall > 0 && e.maxCostUsdPerCall <= 0.2 && Object.isFrozen(e)), "E3: every engine has a positive per-call bound and is frozen");

    // ── enabled() and no key ──
    t(CITATION_ENGINES.every((e) => !e.enabled({}) && !e.enabled({ [e.keyEnv]: "   " }) && e.enabled(ENV_ALL)),
      "K1: enabled() only when the key is set (unset or blank = off)");
    {
      const f = stubFetch(() => ({ status: 200, body: {} }));
      const meter = createLlmCallMeter();
      const results = await runWithLlmCallMeter(meter, () => Promise.all(CITATION_ENGINES.map((e) => e.run("x", { env: {}, fetchImpl: f.fetchImpl }))));
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
      t(c.body.model === "claude-haiku-5-5" && c.body.system === CITATION_PANEL_INSTRUCTION &&
        c.body.messages[0].content === "Tannlege i Bodø" && c.body.tools[0].type === "web_search_20250305" &&
        c.body.tools[0].name === "web_search" && c.body.tools[0].max_uses === 3 && c.body.tools[0].user_location.country === "NO",
        "A2: the question as the user turn, the web_search tool (max 3 searches, Norway) and the shared instruction");
      t(!JSON.stringify(c.body).includes(FAKE_KEYS.ANTHROPIC_API_KEY) && !c.url.includes(FAKE_KEYS.ANTHROPIC_API_KEY), "A3: the key is only in the header");
      t(!!r && r.citedUrls.join(" ") === "https://www.rettfrabonden.com/produsent/lia-gard https://visitnorway.no/x" && r.answerSnippet === "Her er noen forslag.",
        "A4: cited URLs come from the text citations, distinct, in order");
      t(!!r && close(r.costUsd, (10_000 * 0.1 + 400 * 0.5) / 1e6 + 0.01), "A5: cost = tokens at $0.10/$0.50 per MTok + $0.01 per search");
      t(close(anthropicCostUsd({ inputTokens: 120_000, outputTokens: 1_000, searches: 2 }), (120_000 * 0.5 + 1_000 * 2.5) / 1e6 + 0.02),
        "A6: a prompt over 100K tokens is priced at the long-prompt rate");
      const refusal = await run("anthropic", stubFetch(() => ({ status: 200, body: { ...answerFor("anthropic", []), stop_reason: "refusal" } })));
      t(!refusal.ok && refusal.reason === "refusal" && refusal.costUsd > 0, "A7: a refusal is an error with its cost booked");
      const toolErr = await run("anthropic", stubFetch(() => ({ status: 200, body: {
        content: [{ type: "web_search_tool_result", tool_use_id: "s", content: { type: "web_search_tool_result_error", error_code: "unavailable" } }, { type: "text", text: "Beklager." }],
        usage: { input_tokens: 500, output_tokens: 20 },
      } })));
      t(!toolErr.ok && toolErr.reason === "search_tool_error", "A8: a search tool error with nothing cited is search_tool_error");
      const nothing = okOf(await run("anthropic", stubFetch(() => ({ status: 200, body: { content: [{ type: "text", text: "Jeg vet ikke." }], usage: {} } }))));
      t(!!nothing && nothing.citedUrls.length === 0 && nothing.costUsd === 0, "A9: an answer without citations is ok with no URLs");
    }

    // ── OpenAI ──
    {
      const body = answerFor("openai", ["https://www.opplevagent.no/opplevelse/hvalsafari?utm_source=openai", "https://example.com/a"]) as any;
      body.output.unshift({ type: "web_search_call", id: "ws_0", status: "completed" });
      const f = stubFetch(() => ({ status: 200, body }));
      const r = okOf(await run("openai", f));
      const c = f.calls[0];
      t(c.url === OPENAI_RESPONSES_URL && c.init.headers.Authorization === `Bearer ${FAKE_KEYS.OPENAI_API_KEY}` &&
        c.body.model === "gpt-4.1-mini" && c.body.input === "Tannlege i Bodø" && c.body.instructions === CITATION_PANEL_INSTRUCTION &&
        c.body.tools[0].type === "web_search" && c.body.tools[0].user_location.country === "NO" && c.body.max_tool_calls === 3 && c.body.store === false,
        "O1: POST /v1/responses, Bearer key, web_search tool (Norway, max 3), not stored at OpenAI");
      t(!!r && r.citedUrls.length === 2 && r.citedUrls[0].startsWith("https://www.opplevagent.no/"), "O2: cited URLs from url_citation annotations");
      t(!!r && close(r.costUsd, openAiCostUsd({ inputTokens: 8_000, outputTokens: 300, searches: 2 })) && close(r.costUsd, (8_000 * 0.4 + 300 * 1.6) / 1e6 + 0.05),
        "O3: cost = tokens + $0.025 per web_search_call");
    }

    // ── Perplexity ──
    {
      const f = stubFetch(() => ({ status: 200, body: answerFor("perplexity", ["https://finn-tannlege.com/tannlege/bodo", "https://legelisten.no/x"]) }));
      const r = okOf(await run("perplexity", f));
      const c = f.calls[0];
      t(c.url === PERPLEXITY_CHAT_URL && c.init.headers.Authorization === `Bearer ${FAKE_KEYS.PERPLEXITY_API_KEY}` && c.body.model === "sonar" &&
        c.body.messages[0].role === "system" && c.body.messages[1].content === "Tannlege i Bodø" && c.body.web_search_options.search_context_size === "low",
        "P1: POST /chat/completions, Bearer key, sonar with low search context");
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
      const f = stubFetch(() => ({ status: 200, body: answerFor("gemini", ["https://www.finn-tannlege.com/x", "https://legelisten.no/y"]) }));
      const r = okOf(await run("gemini", f));
      const c = f.calls[0];
      t(c.url === `${GEMINI_API_BASE}gemini-2.5-flash:generateContent` && c.init.headers["x-goog-api-key"] === FAKE_KEYS.GEMINI_API_KEY &&
        !c.url.includes("key=") && !c.url.includes(FAKE_KEYS.GEMINI_API_KEY) && JSON.stringify(c.body.tools) === JSON.stringify([{ google_search: {} }]) &&
        c.body.contents[0].parts[0].text === "Tannlege i Bodø" && c.body.system_instruction.parts[0].text === CITATION_PANEL_INSTRUCTION,
        "G1: generateContent with google_search; the key in x-goog-api-key, never in the URL");
      t(!!r && r.citedUrls.length === 2 && r.citedUrls.every((u) => u.startsWith("https://vertexaisearch.cloud.google.com/")) &&
        JSON.stringify(r.citedDomains) === JSON.stringify(["finn-tannlege.com", "legelisten.no"]),
        "G2: grounding chunks are redirect links, so the source domains come from their titles");
      t(!!r && close(r.costUsd, geminiCostUsd({ inputTokens: 1_030, outputTokens: 250, grounded: true })) && close(r.costUsd, (1_030 * 0.3 + 250 * 2.5) / 1e6 + 0.035),
        "G3: cost = tokens (tool-use prompt included) + $0.035 per grounded prompt");
      const p = parseGeminiAnswer({ candidates: [{ content: { parts: [{ text: "a" }] }, groundingMetadata: { groundingChunks: [
        { web: { uri: "https://vertexaisearch.cloud.google.com/r/1", title: "Visit Norway – offisiell side" } },
        { web: { uri: "https://www.example.org/side", title: "Eksempel" } },
        { web: { uri: "https://vertexaisearch.cloud.google.com/r/2", title: "x", domain: "Tripadvisor.no" } },
      ] } }] });
      t(!!p && JSON.stringify(p.citedDomains) === JSON.stringify(["example.org", "tripadvisor.no"]),
        "G4: a title that is no host name and a redirect uri give no domain; web.domain and a direct uri do");
      const ungrounded = parseGeminiAnswer({ candidates: [{ content: { parts: [{ text: "a" }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } });
      t(!!ungrounded && !ungrounded.grounded && close(geminiCostUsd(ungrounded), (10 * 0.3 + 10 * 2.5) / 1e6), "G5: an answer without grounding pays no grounding fee");
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
      t(!timeout.ok && timeout.reason === "timeout" && timeout.costUsd === byId("anthropic").maxCostUsdPerCall,
        "F3: a timeout is booked at the per-call bound (it may have been billed)");
      const net = await run("gemini", stubFetch(() => new TypeError("fetch failed")));
      t(!net.ok && net.reason === "network" && net.costUsd === 0, "F4: a network error is network, cost 0");
      const badJson = await run("openai", stubFetch(() => ({ status: 200, raw: "{not json" })));
      t(!badJson.ok && badJson.reason === "invalid_json" && badJson.costUsd === byId("openai").maxCostUsdPerCall, "F5: a 2xx that is not JSON is booked at the bound");
      const odd = await Promise.all(CITATION_ENGINES.map((e) => run(e.engine, stubFetch(() => ({ status: 200, body: { hello: "world" } })))));
      t(odd.every((r, i) => !r.ok && r.reason === "unexpected_response" && r.costUsd === CITATION_ENGINES[i].maxCostUsdPerCall),
        "F6: a 2xx of the wrong shape is unexpected_response, booked at the bound");
      const noUsage = await Promise.all(CITATION_ENGINES.map((e) => {
        const body: any = answerFor(e.engine, ["https://a.no/"]);
        delete body.usage;
        delete body.usageMetadata;
        return run(e.engine, stubFetch(() => ({ status: 200, body })));
      }));
      t(noUsage.every((r, i) => r.ok && r.costUsd === CITATION_ENGINES[i].maxCostUsdPerCall && r.citedUrls.length === 1),
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
        for (const e of CITATION_ENGINES) await e.run("q", { env: ENV_ALL, fetchImpl: f.fetchImpl });
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
