/**
 * email-reveal-ai-reader-ip-lists.test.ts — dev-request
 * 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, S-A2 (IP-list slice).
 *
 *   C   CIDR parsing and matching, IPv4 + IPv6, boundaries (first/last address,
 *       /32, /128), too-broad prefixes (/0 …) rejected, host bits, mapped forms
 *   P   list body validation: the published JSON format only; one bad entry
 *       rejects the whole body
 *   R   the source table: one list per fetcher, operator matches, https URLs
 *   S   per-fetcher selection: GPTBot is checked against gptbot.json only, …
 *   L   the loader: not loaded → not verified + one background fetch, dedup,
 *       24 h refresh, 1 h retry after a failure, malformed / empty / HTTP error
 *       keeps the previous list, size cap (declared and streamed), timeout,
 *       no redirects, stale list (7 days) dropped, no IPs in events
 *   G   through revealEmailFor: switch off → the fetcher is never called;
 *       listed GPTBot gets the higher limit after the fetch; spoofed UA from an
 *       unlisted IP and a GPTBot UA from a ChatGPT-User IP stay at base; CCBot
 *       never; no fetch when the AI-reader limit gives nothing; no raw IP logged
 *
 * No network: every fetcher is a fake. Standalone:
 *   npx tsx src/services/email-reveal-ai-reader-ip-lists.test.ts
 * Wired into tests/test.ts via runEmailRevealAiReaderIpListsTests().
 */

import {
  AI_READER_IP_LISTS,
  AI_READER_REGISTRY,
  AiReaderIpLists,
  AiReaderVerifier,
  IP_LIST_MAX_AGE_MS,
  IP_LIST_MAX_PREFIXES,
  IP_LIST_REFRESH_MS,
  IP_LIST_RETRY_MS,
  cidrContains,
  parseCidr,
  parseIpList,
  type AiReaderIpListFetcher,
  type AiReaderIpListId,
  type AiReaderResolver,
  type IpListEvent,
  type IpListResponse,
} from "./email-reveal-ai-readers";
import { revealEmailFor, __emailRevealAiReadersSettledForTesting, __resetEmailRevealGuardForTesting } from "./email-reveal-guard";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const URL_GPTBOT = AI_READER_IP_LISTS["openai-gptbot"].url;
const URL_CHATGPT_USER = AI_READER_IP_LISTS["openai-chatgpt-user"].url;
const URL_SEARCHBOT = AI_READER_IP_LISTS["openai-searchbot"].url;
const URL_ANTHROPIC = AI_READER_IP_LISTS["anthropic-bots"].url;
const URL_PPLX_BOT = AI_READER_IP_LISTS["perplexity-bot"].url;
const URL_PPLX_USER = AI_READER_IP_LISTS["perplexity-user"].url;

/** A list body in the operators' published format. */
function listBody(v4: string[], v6: string[] = []): string {
  return JSON.stringify({
    creationTime: "2026-11-01T00:00:00.000000",
    prefixes: [...v4.map((p) => ({ ipv4Prefix: p })), ...v6.map((p) => ({ ipv6Prefix: p }))],
  });
}

// Documentation ranges only (RFC 5737 / RFC 3849).
const GPTBOT_IP = "192.0.2.10";
const CHATGPT_USER_IP = "198.51.100.5";
const SEARCHBOT_IP = "198.51.100.200";
const ANTHROPIC_IP = "203.0.113.70";
const PPLX_BOT_IP = "203.0.113.5";
const PPLX_USER_IP = "203.0.113.6";
const OUTSIDE_IP = "203.0.113.200";
const LISTS: Record<string, string> = {
  [URL_GPTBOT]: listBody(["192.0.2.0/24"], ["2001:db8:1::/48"]),
  [URL_CHATGPT_USER]: listBody(["198.51.100.0/28"]),
  [URL_SEARCHBOT]: listBody(["198.51.100.192/26"]),
  [URL_ANTHROPIC]: listBody(["203.0.113.64/26"]),
  [URL_PPLX_BOT]: listBody(["203.0.113.5/32"]),
  [URL_PPLX_USER]: listBody(["203.0.113.6/32"]),
};

function resp(body: string | null, status = 200, headers: Record<string, string> = {}): IpListResponse {
  return new Response(body, { status, headers }) as unknown as IpListResponse;
}

/** A body that streams `chunks` (no content-length) and then, if `hang`, never ends. */
function streamResp(chunks: Uint8Array[], hang = false): IpListResponse {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (i < chunks.length) { ctrl.enqueue(chunks[i++]!); return; }
      if (hang) return new Promise<void>(() => {});
      ctrl.close();
    },
  });
  return { ok: true, status: 200, headers: { get: () => null }, body: body as unknown as ReadableStream<Uint8Array> };
}

type Route = () => IpListResponse | Promise<IpListResponse>;

/** A fake fetcher over mutable routes; records every call. */
function fakeFetcher(routes: Record<string, Route> = Object.fromEntries(Object.entries(LISTS).map(([u, b]) => [u, () => resp(b)]))) {
  const calls: string[] = [];
  const inits: Array<Parameters<AiReaderIpListFetcher>[1]> = [];
  const fetcher: AiReaderIpListFetcher = async (url, init) => {
    calls.push(url);
    inits.push(init);
    const r = routes[url];
    return r ? r() : resp("not found", 404);
  };
  return { fetcher, calls, inits, routes };
}

/** A resolver that fails the test run if it is ever called (ip_list makes no DNS lookup). */
const noDns = (counter: { n: number }): AiReaderResolver => ({
  reverse: async () => { counter.n++; throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); },
  resolve4: async () => { counter.n++; return []; },
  resolve6: async () => { counter.n++; return []; },
});

const entry = (token: string) => AI_READER_REGISTRY.find((e) => e.token === token)!;

export async function runEmailRevealAiReaderIpListsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const ok = (cond: boolean, label: string) => {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  };
  const eq = (actual: unknown, expected: unknown, label: string) =>
    ok(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);

  const envKeys = ["EMAIL_REVEAL_GUARD_DENTAL", "EMAIL_REVEAL_GUARD_RFB", "EMAIL_REVEAL_GUARD_EXPERIENCES", "EMAIL_REVEAL_PER_IP_PER_HOUR", "EMAIL_REVEAL_AI_READER_PER_HOUR"];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

  try {
    // ── C: CIDR ──────────────────────────────────────────────────────────
    {
      const c = parseCidr("192.0.2.0/24", 4)!;
      ok(c !== null, "C1: 192.0.2.0/24 parses");
      eq([cidrContains(c, "192.0.2.0", 4), cidrContains(c, "192.0.2.255", 4)], [true, true], "C2: first and last address of a /24 are inside");
      eq([cidrContains(c, "192.0.1.255", 4), cidrContains(c, "192.0.3.0", 4)], [false, false], "C3: one below / one above the /24 are outside");
      const h = parseCidr("198.51.100.7/32", 4)!;
      eq([cidrContains(h, "198.51.100.7", 4), cidrContains(h, "198.51.100.6", 4), cidrContains(h, "198.51.100.8", 4)], [true, false, false], "C4: a /32 holds exactly one address");
      const wide = parseCidr("172.16.0.0/12", 4)!;
      eq([cidrContains(wide, "172.31.255.255", 4), cidrContains(wide, "172.32.0.0", 4)], [true, false], "C5: /12 (the broadest IPv4 accepted) boundaries");
      eq(parseCidr("10.0.0.0/16", 4)?.len, 16, "C5b: a /16 (as in today's chatgpt-user.json) is accepted");
      for (const bad of ["0.0.0.0/0", "10.0.0.0/8", "160.0.0.0/11", "192.0.2.1/24", "192.0.2.0/33", "192.0.2.0/024", "192.000.2.0/24", "256.0.0.0/16",
        "192.0.2.0", " 192.0.2.0/24", "192.0.2.0/24 ", "192.0.2.0/", "/24", "2001:db8::/32", "192.0.2.0/24/24", "1.2.3/24"]) {
        eq(parseCidr(bad, 4), null, `C6: ipv4Prefix ${JSON.stringify(bad)} is rejected`);
      }
      eq([parseCidr(24, 4), parseCidr(null, 4), parseCidr({}, 4)], [null, null, null], "C7: a non-string prefix is rejected");

      const v6 = parseCidr("2001:db8::/32", 6)!;
      ok(v6 !== null, "C8: 2001:db8::/32 parses");
      eq([cidrContains(v6, "2001:db8::", 6), cidrContains(v6, "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff", 6)], [true, true], "C9: first and last address of an IPv6 /32");
      eq([cidrContains(v6, "2001:db7:ffff:ffff:ffff:ffff:ffff:ffff", 6), cidrContains(v6, "2001:db9::", 6)], [false, false], "C10: one below / one above are outside");
      const one = parseCidr("2001:db8::1/128", 6)!;
      eq([cidrContains(one, "2001:db8::1", 6), cidrContains(one, "2001:db8::2", 6)], [true, false], "C11: a /128 holds exactly one address");
      eq(parseCidr("2001:DB8:0:0::/32", 6)?.len, 32, "C12: a non-canonical IPv6 prefix is normalised and accepted");
      for (const bad of ["::/0", "2001:db8::/16", "2001:db8::/23", "2001:db8::1/64", "2001:db8::/129", "::ffff:0:0/96", "::ffff:192.0.2.0/120",
        "2001:db8::%eth0/64", "192.0.2.0/24", "2001:db8:::/32", "2001:db8::/032", "gggg::/32"]) {
        eq(parseCidr(bad, 6), null, `C13: ipv6Prefix ${JSON.stringify(bad)} is rejected`);
      }
      eq([cidrContains(c, "2001:db8::1", 6), cidrContains(v6, "192.0.2.1", 4)], [false, false], "C14: a v4 range never matches a v6 address and vice versa");
    }

    // ── P: list body ─────────────────────────────────────────────────────
    {
      eq(parseIpList(LISTS[URL_GPTBOT]!)?.length, 2, "P1: the published format (v4 + v6) parses");
      eq(parseIpList('{"prefixes":[{"ipv4Prefix":"192.0.2.0/24"}]}')?.length, 1, "P2: creationTime is optional");
      eq(parseIpList(listBody([])), null, "P3: empty prefixes -> rejected");
      for (const [label, body] of [
        ["not JSON", "<html>blocked</html>"],
        ["truncated JSON", LISTS[URL_GPTBOT]!.slice(0, 40)],
        ["a top-level array", '[{"ipv4Prefix":"192.0.2.0/24"}]'],
        ["prefixes not an array", '{"prefixes":{"ipv4Prefix":"192.0.2.0/24"}}'],
        ["no prefixes key", '{"creationTime":"x"}'],
        ["null", "null"],
        ["one malformed prefix among good ones", listBody(["192.0.2.0/24", "192.0.2.300/32", "198.51.100.0/24"])],
        ["one too-broad prefix", listBody(["192.0.2.0/24", "0.0.0.0/0"])],
        ["an entry with both keys", '{"prefixes":[{"ipv4Prefix":"192.0.2.0/24","ipv6Prefix":"2001:db8::/32"}]}'],
        ["an entry with neither key", '{"prefixes":[{"ipv4Prefix":"192.0.2.0/24"},{"prefix":"198.51.100.0/24"}]}'],
        ["a v6 range under ipv4Prefix", '{"prefixes":[{"ipv4Prefix":"2001:db8::/32"}]}'],
        ["a non-object entry", '{"prefixes":["192.0.2.0/24"]}'],
      ] as const) {
        eq(parseIpList(body), null, `P4: ${label} -> rejected`);
      }
      const many = listBody(Array.from({ length: IP_LIST_MAX_PREFIXES + 1 }, () => "192.0.2.0/24"));
      eq(parseIpList(many), null, "P5: more than IP_LIST_MAX_PREFIXES -> rejected");
    }

    // ── R: the source table ──────────────────────────────────────────────
    {
      const ipListEntries = AI_READER_REGISTRY.filter((e) => e.method === "ip_list");
      ok(ipListEntries.length === 8 && ipListEntries.every((e) => e.ipList !== null && AI_READER_IP_LISTS[e.ipList].operator === e.operator),
        "R1: every ip_list entry names a list of its own operator");
      ok(AI_READER_REGISTRY.filter((e) => e.method === "fcrdns").every((e) => e.ipList === null), "R2: fcrdns entries have no list");
      eq(Object.fromEntries(ipListEntries.map((e) => [e.token, new URL(AI_READER_IP_LISTS[e.ipList!].url).pathname])), {
        "ChatGPT-User": "/chatgpt-user.json", "OAI-SearchBot": "/searchbot.json", GPTBot: "/gptbot.json",
        "Claude-User": "/crawling/bots.json", "Claude-SearchBot": "/crawling/bots.json", ClaudeBot: "/crawling/bots.json",
        "Perplexity-User": "/perplexity-user.json", PerplexityBot: "/perplexitybot.json",
      }, "R3: one list per fetcher (OpenAI, Perplexity); Anthropic's one list for its three bots");
      const hosts = new Set(Object.values(AI_READER_IP_LISTS).map((s) => { const u = new URL(s.url); return u.protocol + "//" + u.host; }));
      eq([...hosts].sort(), ["https://claude.com", "https://openai.com", "https://www.perplexity.ai"], "R4: https only, on the operators' own hosts");
    }

    // ── S: per-fetcher selection ─────────────────────────────────────────
    {
      const f = fakeFetcher();
      const dns = { n: 0 };
      const v = new AiReaderVerifier({ resolver: noDns(dns), ipListFetcher: f.fetcher });
      const checks: Array<[string, string]> = [
        ["GPTBot", GPTBOT_IP], ["GPTBot", CHATGPT_USER_IP], ["ChatGPT-User", CHATGPT_USER_IP], ["ChatGPT-User", GPTBOT_IP],
        ["OAI-SearchBot", SEARCHBOT_IP], ["OAI-SearchBot", GPTBOT_IP], ["PerplexityBot", PPLX_BOT_IP], ["PerplexityBot", PPLX_USER_IP],
        ["Perplexity-User", PPLX_USER_IP], ["Perplexity-User", PPLX_BOT_IP], ["ClaudeBot", ANTHROPIC_IP], ["Claude-User", ANTHROPIC_IP],
        ["Claude-SearchBot", ANTHROPIC_IP], ["ClaudeBot", GPTBOT_IP], ["GPTBot", OUTSIDE_IP],
      ];
      eq(checks.map(([t, ip]) => v.isVerified(ip, entry(t))), checks.map(() => false), "S1: nothing loaded yet -> nobody verified");
      await v.settled();
      eq(checks.map(([t, ip]) => v.isVerified(ip, entry(t))),
        [true, false, true, false, true, false, true, false, true, false, true, true, true, false, false],
        "S2: each UA is verified only against its own fetcher's list (GPTBot UA from a ChatGPT-User IP -> not verified)");
      eq([...f.calls].sort(), [URL_ANTHROPIC, URL_SEARCHBOT, URL_CHATGPT_USER, URL_GPTBOT, URL_PPLX_USER, URL_PPLX_BOT].sort(), "S3: each list fetched exactly once");
      eq(dns.n, 0, "S4: no DNS lookup for ip_list operators");
      eq([v.isVerified("2001:db8:1:ffff::1", entry("GPTBot")), v.isVerified("2001:db8:2::1", entry("GPTBot"))], [true, false], "S5: IPv6 client inside / outside the v6 range");
      eq([v.isVerified("::ffff:" + GPTBOT_IP, entry("GPTBot")), v.isVerified("::ffff:c000:20a", entry("GPTBot"))], [true, false],
        "S6: dotted IPv4-mapped (Node dual-stack form) = the IPv4 address; the hex-written mapped form never matches");
      eq([v.isVerified("192.0.2.256", entry("GPTBot")), v.isVerified("", entry("GPTBot")), v.isVerified("2001:db8:1::1%eth0", entry("GPTBot")), v.isVerified("192.0.2.10/32", entry("GPTBot"))],
        [false, false, false, false], "S7: malformed client IPs -> not verified");
      const g = { ...entry("GPTBot"), ipList: null };
      eq(v.isVerified(GPTBOT_IP, g), false, "S8: an ip_list entry without a list -> not verified");
    }

    // ── L: the loader ────────────────────────────────────────────────────
    {
      let t = 10_000_000;
      const events: IpListEvent[] = [];
      const f = fakeFetcher();
      const lists = new AiReaderIpLists({ fetcher: f.fetcher, now: () => t, onEvent: (e) => events.push(e) });
      const id: AiReaderIpListId = "openai-gptbot";
      eq(lists.contains(id, GPTBOT_IP), false, "L1: not loaded -> false on this call");
      eq([lists.contains(id, GPTBOT_IP), lists.contains(id, GPTBOT_IP)], [false, false], "L2: while the fetch runs -> still false");
      eq(f.calls.length, 1, "L3: one fetch for three calls (deduplicated)");
      eq([f.inits[0]?.redirect, f.inits[0]?.signal instanceof AbortSignal], ["error", true], "L4: no redirects followed; an abort signal is passed");
      await lists.settled();
      eq(lists.contains(id, GPTBOT_IP), true, "L5: loaded -> listed IP is verified");
      eq(events, [{ list: id, outcome: "loaded", prefixes: 2 }], "L6: one 'loaded' event with the prefix count");

      t += IP_LIST_REFRESH_MS - 1;
      lists.contains(id, GPTBOT_IP);
      await lists.settled();
      eq(f.calls.length, 1, "L7: no refresh before 24 h");
      t += 1;
      f.routes[URL_GPTBOT] = () => resp("{ this is not json");
      eq(lists.contains(id, GPTBOT_IP), true, "L8: at 24 h a refresh starts; the current list still answers");
      await lists.settled();
      eq(f.calls.length, 2, "L9: refreshed once after 24 h");
      eq(lists.contains(id, GPTBOT_IP), true, "L10: a malformed refresh keeps the previous good list");
      eq(events[1], { list: id, outcome: "failed", reason: "malformed", kept_previous: true }, "L11: 'failed' event (malformed, previous kept)");

      f.routes[URL_GPTBOT] = () => resp(listBody([]));
      t += IP_LIST_RETRY_MS - 1;
      lists.contains(id, GPTBOT_IP);
      await lists.settled();
      eq(f.calls.length, 2, "L12: no retry before 1 h after a failure");
      t += 1;
      lists.contains(id, GPTBOT_IP);
      await lists.settled();
      eq([f.calls.length, lists.contains(id, GPTBOT_IP), events[2]], [3, true, { list: id, outcome: "failed", reason: "malformed", kept_previous: true }],
        "L13: retried after 1 h; an empty list is rejected and the previous one kept");

      f.routes[URL_GPTBOT] = () => resp(listBody(["192.0.2.128/25"]));
      t += IP_LIST_RETRY_MS;
      lists.contains(id, GPTBOT_IP);
      await lists.settled();
      eq([lists.contains(id, GPTBOT_IP), lists.contains(id, "192.0.2.200")], [false, true], "L14: a good refresh replaces the list (an IP removed upstream is no longer verified)");

      f.routes[URL_GPTBOT] = () => resp("oops", 503);
      const loadedAt = t;
      for (let i = 0; i < 7 * 24 + 1; i++) { t += IP_LIST_RETRY_MS; lists.contains(id, "192.0.2.200"); await lists.settled(); }
      ok(t - loadedAt > IP_LIST_MAX_AGE_MS, "L15a: (more than 7 days of failed refreshes)");
      eq(lists.contains(id, "192.0.2.200"), false, "L15: a list whose last good load is older than 7 days is not used");
      ok(events.some((e) => e.outcome === "failed" && e.reason === "http_status"), "L16: HTTP error -> 'failed' (http_status)");
      ok(!JSON.stringify(events).includes("192.0.2") && !JSON.stringify(events).includes("198.51"), "L17: events carry no IP or prefix");
    }
    {
      const events: IpListEvent[] = [];
      const f = fakeFetcher({ [URL_GPTBOT]: () => resp("not json") });
      const lists = new AiReaderIpLists({ fetcher: f.fetcher, onEvent: (e) => events.push(e) });
      lists.contains("openai-gptbot", GPTBOT_IP);
      await lists.settled();
      eq([lists.contains("openai-gptbot", GPTBOT_IP), lists.loadedCount("openai-gptbot"), events[0]],
        [false, null, { list: "openai-gptbot", outcome: "failed", reason: "malformed", kept_previous: false }], "L18: malformed with no previous list -> nothing verified");
    }
    {
      // Size cap: declared content-length, streamed body, and the exact boundary.
      const body = LISTS[URL_GPTBOT]!;
      const bytes = Buffer.byteLength(body);
      let bodyRead = false;
      const declared = new ReadableStream<Uint8Array>({ pull(c) { bodyRead = true; c.enqueue(new TextEncoder().encode(body)); c.close(); } }, { highWaterMark: 0 });
      const events: IpListEvent[] = [];
      const f = fakeFetcher({
        [URL_GPTBOT]: () => ({ ok: true, status: 200, headers: { get: (n: string) => (n.toLowerCase() === "content-length" ? String(bytes) : null) }, body: declared as unknown as ReadableStream<Uint8Array> }),
        [URL_CHATGPT_USER]: () => streamResp(Array.from({ length: 20 }, () => new Uint8Array(64).fill(0x20))),
        [URL_SEARCHBOT]: () => streamResp([new TextEncoder().encode(body)]),
      });
      const lists = new AiReaderIpLists({ fetcher: f.fetcher, maxBytes: bytes - 1, onEvent: (e) => events.push(e) });
      lists.contains("openai-gptbot", GPTBOT_IP);
      lists.contains("openai-chatgpt-user", GPTBOT_IP);
      await lists.settled();
      eq(events.map((e) => [e.list, e.outcome === "failed" ? e.reason : e.outcome]).sort(), [["openai-chatgpt-user", "too_large"], ["openai-gptbot", "too_large"]],
        "L19: a declared content-length above the cap and a streamed body above the cap -> too_large");
      eq(bodyRead, false, "L20: ... the declared-too-large body is not read");
      eq(lists.contains("openai-gptbot", GPTBOT_IP), false, "L21: ... and nothing is verified");
      const exact = new AiReaderIpLists({ fetcher: f.fetcher, maxBytes: bytes });
      exact.contains("openai-searchbot", GPTBOT_IP);
      await exact.settled();
      eq(exact.contains("openai-searchbot", GPTBOT_IP), true, "L22: a body of exactly the cap is accepted");
      const under = new AiReaderIpLists({ fetcher: f.fetcher, maxBytes: bytes - 1 });
      under.contains("openai-searchbot", GPTBOT_IP);
      await under.settled();
      eq(under.contains("openai-searchbot", GPTBOT_IP), false, "L23: one byte over the cap (streamed, no content-length) is rejected");
    }
    {
      // Timeout: a fetcher that never answers, and a body that never ends.
      const events: IpListEvent[] = [];
      let aborted = false;
      const f = fakeFetcher({
        [URL_GPTBOT]: () => new Promise<IpListResponse>(() => {}),
        [URL_CHATGPT_USER]: () => streamResp([new TextEncoder().encode('{"prefixes":[')], true),
      });
      const wrapped: AiReaderIpListFetcher = (url, init) => { init.signal.addEventListener("abort", () => { aborted = true; }); return f.fetcher(url, init); };
      const lists = new AiReaderIpLists({ fetcher: wrapped, timeoutMs: 20, onEvent: (e) => events.push(e) });
      const started = Date.now();
      lists.contains("openai-gptbot", GPTBOT_IP);
      lists.contains("openai-chatgpt-user", CHATGPT_USER_IP);
      await lists.settled();
      ok(Date.now() - started < 1000, "L24: a hanging fetch is cut off by the timeout");
      eq(events.map((e) => (e.outcome === "failed" ? e.reason : e.outcome)), ["timeout", "timeout"], "L25: hanging headers and a hanging body -> timeout");
      eq([aborted, lists.contains("openai-gptbot", GPTBOT_IP)], [true, false], "L26: the request is aborted and nothing is verified");
    }
    {
      const events: IpListEvent[] = [];
      const f = fakeFetcher({
        [URL_GPTBOT]: () => { throw new Error("getaddrinfo ENOTFOUND openai.com"); },
        [URL_CHATGPT_USER]: () => ({ ok: true, status: 200, headers: { get: () => null }, body: new Response(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])).body as unknown as ReadableStream<Uint8Array> }),
      });
      const lists = new AiReaderIpLists({ fetcher: f.fetcher, onEvent: (e) => events.push(e) });
      lists.contains("openai-gptbot", GPTBOT_IP);
      lists.contains("openai-chatgpt-user", GPTBOT_IP);
      await lists.settled();
      eq(events.map((e) => [e.list, e.outcome === "failed" ? e.reason : e.outcome]).sort(), [["openai-chatgpt-user", "malformed"], ["openai-gptbot", "network"]],
        "L27: a thrown fetch -> network; invalid UTF-8 -> malformed (errors swallowed)");
      let threw = false;
      const throwing = new AiReaderIpLists({ fetcher: f.fetcher, onEvent: () => { throw new Error("log sink down"); } });
      try { throwing.contains("openai-gptbot", GPTBOT_IP); await throwing.settled(); } catch { threw = true; }
      eq(threw, false, "L28: a throwing event sink never throws out of the loader");
    }

    // ── G: through revealEmailFor ────────────────────────────────────────
    {
      const lines: string[] = [];
      const f = fakeFetcher();
      const dns = { n: 0 };
      __resetEmailRevealGuardForTesting({ log: (l) => lines.push(l), aiReaders: { resolver: noDns(dns), ipListFetcher: f.fetcher } });
      const req = (ip: string, ua?: string) => ({ ip, headers: ua === undefined ? {} : { "user-agent": ua } }) as any;
      const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
      const GPTBOT_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot";
      process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = "3";
      process.env.EMAIL_REVEAL_AI_READER_PER_HOUR = "10";

      for (const k of ["EMAIL_REVEAL_GUARD_DENTAL", "EMAIL_REVEAL_GUARD_RFB", "EMAIL_REVEAL_GUARD_EXPERIENCES"]) delete process.env[k];
      for (let i = 0; i < 3; i++) {
        eq([revealEmailFor(req(GPTBOT_IP, GPTBOT_UA), "dental", ["a"]), revealEmailFor(req(ANTHROPIC_IP, "ClaudeBot/1.0"), "rfb", ["a"]),
          revealEmailFor(req(PPLX_USER_IP, "Perplexity-User/1.0"), "experiences", ["a"])], [null, null, null], `G1.${i}: every switch off -> null`);
      }
      await __emailRevealAiReadersSettledForTesting();
      eq([f.calls.length, dns.n, lines.length], [0, 0, 0], "G2: switch off -> the IP-list fetcher is never called, no DNS, nothing logged");

      process.env.EMAIL_REVEAL_GUARD_DENTAL = "on";
      eq(revealEmailFor(req(GPTBOT_IP, GPTBOT_UA), "dental", ids("g", 6))?.size, 3, "G3: listed GPTBot, list not loaded yet -> base limit");
      eq(f.calls, [URL_GPTBOT], "G4: ... and only GPTBot's list is fetched, in the background");
      await __emailRevealAiReadersSettledForTesting();
      eq(revealEmailFor(req(GPTBOT_IP, GPTBOT_UA), "dental", ids("g", 12))?.size, 10, "G5: list loaded -> the AI-reader limit (10), same counter");
      eq(revealEmailFor(req(OUTSIDE_IP, GPTBOT_UA), "dental", ids("s", 8))?.size, 3, "G6: spoofed GPTBot UA from an unlisted IP -> base");
      eq(revealEmailFor(req(CHATGPT_USER_IP, GPTBOT_UA), "dental", ids("u", 8))?.size, 3, "G7: GPTBot UA from a ChatGPT-User IP -> base (per-fetcher list)");
      eq(revealEmailFor(req(GPTBOT_IP, "CCBot/2.0 " + GPTBOT_UA), "dental", ["c1"])?.size, 0, "G8: CCBot UA from a listed GPTBot IP -> still no e-mail (S-A3 wins)");
      eq(revealEmailFor(req("192.0.2.11", "Mozilla/5.0"), "dental", ids("b", 6))?.size, 3, "G9: listed IP with a browser UA -> base (the UA picks the list)");
      await __emailRevealAiReadersSettledForTesting();
      eq(f.calls, [URL_GPTBOT], "G10: no further fetch within 24 h");
      eq(dns.n, 0, "G11: no DNS lookup on the ip_list path");
      const parsed = lines.map((l) => JSON.parse(l));
      eq(parsed.filter((p) => p.evt === "email_reveal_ai_reader_ip_list"), [{ evt: "email_reveal_ai_reader_ip_list", list: "openai-gptbot", outcome: "loaded", prefixes: 2 }],
        "G12: one list log line (list id, outcome, count)");
      eq(parsed.filter((p) => p.evt === "email_reveal_ai_reader_verified").map((p) => [p.operator, p.token, p.host, typeof p.client]),
        [["openai", "GPTBot", "dental", "string"]], "G13: one verification log line for the listed IP (not one per request)");
      ok(lines.every((l) => !/192\.0\.2\.|198\.51\.100\.|203\.0\.113\./.test(l)), "G14: no raw IP or prefix in any log line");

      __resetEmailRevealGuardForTesting({ log: () => {}, aiReaders: { resolver: noDns(dns), ipListFetcher: f.fetcher } });
      process.env.EMAIL_REVEAL_AI_READER_PER_HOUR = "2";
      const before = f.calls.length;
      eq(revealEmailFor(req(ANTHROPIC_IP, "ClaudeBot/1.0"), "dental", ids("z", 6))?.size, 3, "G15: AI-reader limit below base -> base");
      await __emailRevealAiReadersSettledForTesting();
      eq(f.calls.length, before, "G16: ... and no list fetch when there is nothing to gain");
    }
  } catch (err: any) {
    failed++;
    failures.push("email reveal ai reader ip lists: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    for (const k of envKeys) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    __resetEmailRevealGuardForTesting();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── email reveal AI reader IP lists (dev-request 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, S-A2) ──");
  runEmailRevealAiReaderIpListsTests({ log: true }).then((r) => {
    console.log(`\nemail reveal ai reader ip lists: ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
