/**
 * email-reveal-ai-readers.test.ts — dev-request
 * 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, S-A2.
 *
 *   E   env: EMAIL_REVEAL_AI_READER_PER_HOUR (default 300) and the cap on both limits
 *   U   UA registry: tokens shared with traffic-classifier; no -Extended control tokens
 *   F   forward-confirmed reverse DNS with a fake resolver (PTR domain, forward match)
 *   V   the verifier: miss → false + background lookup, dedup, positive/negative/error
 *       cache with TTLs, timeout, bounds
 *   D   emailRevealLimitFor directly: CCBot from a verified IP -> base
 *   G   through revealEmailFor: verified Googlebot gets the higher limit after the
 *       lookup; spoofed UA stays at base; CCBot never; switch off → no DNS at all;
 *       ip_list operators make no lookup; one log line without the IP
 *
 * No network: every resolver is a fake. Standalone:
 *   npx tsx src/services/email-reveal-ai-readers.test.ts
 * Wired into tests/test.ts via runEmailRevealAiReadersTests().
 */

import {
  AI_READER_REGISTRY,
  AiReaderVerifier,
  aiReaderEntryOf,
  forwardConfirmedReverseDns,
  normalizeIp,
  NEGATIVE_TTL_MS,
  POSITIVE_TTL_MS,
  ERROR_TTL_MS,
  type AiReaderIpListFetcher,
  type AiReaderResolver,
} from "./email-reveal-ai-readers";
import {
  EMAIL_REVEAL_AI_READER_DEFAULT_LIMIT,
  EMAIL_REVEAL_MAX_LIMIT,
  emailRevealAiReaderLimit,
  emailRevealBaseLimit,
  emailRevealLimitFor,
  revealEmailFor,
  __emailRevealAiReadersSettledForTesting,
  __resetEmailRevealGuardForTesting,
} from "./email-reveal-guard";
import { AI_AGENT_REGISTRY, SEARCH_ENGINE_PATTERNS } from "./traffic-classifier";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type Records = { ptr?: Record<string, string[]>; a?: Record<string, string[]>; aaaa?: Record<string, string[]> };

/** A fake resolver over fixed records; counts calls; `mode` can make it fail or hang. */
function fakeResolver(rec: Records, mode: { fail?: boolean; hang?: boolean; delayMs?: number } = {}) {
  const calls = { reverse: 0, resolve4: 0, resolve6: 0 };
  const answer = <T>(fn: () => T): Promise<T> => {
    if (mode.hang) return new Promise<T>(() => {});
    if (mode.fail) return Promise.reject(Object.assign(new Error("SERVFAIL"), { code: "ESERVFAIL" }));
    if (mode.delayMs) return new Promise<T>((res, rej) => setTimeout(() => { try { res(fn()); } catch (e) { rej(e); } }, mode.delayMs));
    try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); }
  };
  const notFound = () => Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  const resolver: AiReaderResolver = {
    reverse: (ip) => { calls.reverse++; return answer(() => { const v = rec.ptr?.[ip]; if (!v) throw notFound(); return v; }); },
    resolve4: (h) => { calls.resolve4++; return answer(() => { const v = rec.a?.[h]; if (!v) throw notFound(); return v; }); },
    resolve6: (h) => { calls.resolve6++; return answer(() => { const v = rec.aaaa?.[h]; if (!v) throw notFound(); return v; }); },
  };
  return { resolver, calls, total: () => calls.reverse + calls.resolve4 + calls.resolve6 };
}

/** An IP-list fetcher that never reaches the network (every list: HTTP 404, so no list loads). */
const noLists: AiReaderIpListFetcher = async () => ({ ok: false, status: 404, headers: { get: () => null }, body: null });

const GOOGLE_IP = "66.249.66.1";
const GOOGLE_HOST = "crawl-66-249-66-1.googlebot.com";
const GOOGLE_V6 = "2001:4860:4801:10::1";
const GOOGLE_V6_HOST = "crawl-2001-4860-4801-10--1.googlebot.com";
const GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const googleRecords: Records = {
  ptr: {
    [GOOGLE_IP]: [GOOGLE_HOST + "."],
    [GOOGLE_V6]: [GOOGLE_V6_HOST],
    "203.0.113.66": ["crawl.googlebot.com.evil.example"], // PTR not in the domain
    "203.0.113.67": [GOOGLE_HOST], // PTR claims Google, forward lookup says otherwise
    "157.55.39.1": ["msnbot-157-55-39-1.search.msn.com"],
    "203.0.113.80": ["crawl.evilgooglebot.com"], // ends in "googlebot.com" but not ".googlebot.com"
    "203.0.113.81": ["googlebot.com"], // the bare domain itself, not a host under it
    // four in-domain names; only the 4th forward-confirms (MAX_PTR_NAMES = 3)
    "203.0.113.82": ["a.googlebot.com", "b.googlebot.com", "c.googlebot.com", "d.googlebot.com"],
    // control: the same IP's confirming name within the first three
    "203.0.113.83": ["a.googlebot.com", "e.googlebot.com"],
  },
  a: {
    [GOOGLE_HOST]: [GOOGLE_IP],
    "msnbot-157-55-39-1.search.msn.com": ["157.55.39.1"],
    "crawl.evilgooglebot.com": ["203.0.113.80"],
    "googlebot.com": ["203.0.113.81"],
    "a.googlebot.com": ["192.0.2.250"],
    "b.googlebot.com": ["192.0.2.251"],
    "c.googlebot.com": ["192.0.2.252"],
    "d.googlebot.com": ["203.0.113.82"],
    "e.googlebot.com": ["203.0.113.83"],
  },
  aaaa: { [GOOGLE_V6_HOST]: ["2001:4860:4801:10:0:0:0:1"] },
};

export async function runEmailRevealAiReadersTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const googlebot = AI_READER_REGISTRY.find((e) => e.token === "Googlebot")!;

  try {
    // ── E: env ───────────────────────────────────────────────────────────
    eq(emailRevealAiReaderLimit({}), 300, "E1: no env -> 300");
    eq(EMAIL_REVEAL_AI_READER_DEFAULT_LIMIT, 300, "E1b: the default is 300");
    eq([emailRevealAiReaderLimit({ EMAIL_REVEAL_AI_READER_PER_HOUR: "120" }), emailRevealAiReaderLimit({ EMAIL_REVEAL_AI_READER_PER_HOUR: " 0 " })], [120, 0], "E2: a whole number is taken");
    for (const v of ["-1", "abc", "2.5", "1e3", "9999999", ""]) {
      eq(emailRevealAiReaderLimit({ EMAIL_REVEAL_AI_READER_PER_HOUR: v }), 300, `E3: ${JSON.stringify(v)} -> the default`);
    }
    eq(EMAIL_REVEAL_MAX_LIMIT, 1000, "E4: the cap is 1000");
    eq([emailRevealAiReaderLimit({ EMAIL_REVEAL_AI_READER_PER_HOUR: "5000" }), emailRevealAiReaderLimit({ EMAIL_REVEAL_AI_READER_PER_HOUR: "1000" })], [1000, 1000], "E5: the AI-reader limit is cut to the cap");
    eq([emailRevealBaseLimit({ EMAIL_REVEAL_PER_IP_PER_HOUR: "999999" }), emailRevealBaseLimit({ EMAIL_REVEAL_PER_IP_PER_HOUR: "30" })], [1000, 30], "E6: the base limit is cut to the same cap");

    // ── U: registry ──────────────────────────────────────────────────────
    const known = new Set<string>([...AI_AGENT_REGISTRY.map((e) => e.token), ...SEARCH_ENGINE_PATTERNS]);
    ok(AI_READER_REGISTRY.every((e) => known.has(e.token)), "U1: every token is a UA name from traffic-classifier");
    for (const t of ["GPTBot", "ChatGPT-User", "OAI-SearchBot", "ClaudeBot", "Claude-User", "Claude-SearchBot", "PerplexityBot", "Perplexity-User", "Googlebot", "Applebot", "bingbot"]) {
      eq(AI_READER_REGISTRY.some((e) => e.token === t), true, `U2: ${t} is configured`);
    }
    ok(!AI_READER_REGISTRY.some((e) => /Extended|CCBot/.test(e.token)), "U3: no Google-Extended / Applebot-Extended / CCBot");
    eq(aiReaderEntryOf("Mozilla/5.0 (compatible; Applebot-Extended/0.1)"), null, "U4: Applebot-Extended alone does not match Applebot");
    eq(aiReaderEntryOf("Google-Extended"), null, "U5: Google-Extended does not match");
    eq([aiReaderEntryOf(GOOGLEBOT_UA)?.operator, aiReaderEntryOf("Mozilla/5.0 (compatible; bingbot/2.0)")?.operator, aiReaderEntryOf("Mozilla/5.0 (Macintosh) Applebot/0.1")?.operator],
      ["google", "microsoft", "apple"], "U6: Googlebot / bingbot / Applebot resolve to their operator");
    eq([aiReaderEntryOf("Claude-User/1.0")?.token, aiReaderEntryOf("Perplexity-User/1.0")?.token, aiReaderEntryOf("ChatGPT-User/1.0")?.method],
      ["Claude-User", "Perplexity-User", "ip_list"], "U7: *-User tokens match first; OpenAI is ip_list");
    ok(AI_READER_REGISTRY.every((e) => (e.method === "fcrdns") === (e.domains.length > 0)), "U8: fcrdns entries have domains, ip_list entries none");
    ok(AI_READER_REGISTRY.filter((e) => ["openai", "anthropic", "perplexity"].includes(e.operator)).every((e) => e.method === "ip_list"),
      "U9: OpenAI / Anthropic / Perplexity are ip_list (verified against IP lists, see email-reveal-ai-reader-ip-lists.test.ts)");
    eq([aiReaderEntryOf("Mozilla/5.0"), aiReaderEntryOf(""), aiReaderEntryOf(undefined)], [null, null, null], "U10: other UAs -> null");

    // ── F: FCrDNS ────────────────────────────────────────────────────────
    eq([normalizeIp("::ffff:66.249.66.1")?.ip, normalizeIp("2001:4860:4801:10:0:0:0:1")?.ip, normalizeIp("999.1.1.1"), normalizeIp("nope")],
      ["66.249.66.1", "2001:4860:4801:10::1", null, null], "F0: IP normalisation");
    {
      const f = fakeResolver(googleRecords);
      eq(await forwardConfirmedReverseDns(f.resolver, GOOGLE_IP, googlebot), true, "F1: PTR in googlebot.com + forward A match -> verified");
      eq(await forwardConfirmedReverseDns(f.resolver, "::ffff:" + GOOGLE_IP, googlebot), true, "F2: IPv4-mapped form -> verified");
      eq(await forwardConfirmedReverseDns(f.resolver, GOOGLE_V6, googlebot), true, "F3: IPv6 PTR + AAAA in another notation -> verified");
      eq(await forwardConfirmedReverseDns(f.resolver, "203.0.113.66", googlebot), false, "F4: PTR outside the operator's domains -> not verified");
      eq(await forwardConfirmedReverseDns(f.resolver, "203.0.113.67", googlebot), false, "F5: forward lookup does not contain the IP -> not verified");
      eq(await forwardConfirmedReverseDns(f.resolver, "198.51.100.9", googlebot), false, "F6: no PTR (ENOTFOUND) -> not verified");
      eq(await forwardConfirmedReverseDns(f.resolver, "157.55.39.1", googlebot), false, "F7: a valid bingbot host does not verify Googlebot");
      const bing = AI_READER_REGISTRY.find((e) => e.token === "bingbot")!;
      eq(await forwardConfirmedReverseDns(f.resolver, "157.55.39.1", bing), true, "F8: ... but does verify bingbot");
      const before = f.total();
      eq(await forwardConfirmedReverseDns(f.resolver, GOOGLE_IP, AI_READER_REGISTRY.find((e) => e.token === "GPTBot")!), false, "F9: ip_list entry -> false");
      eq(f.total(), before, "F10: ... with no DNS call");
      eq(await forwardConfirmedReverseDns(f.resolver, "203.0.113.80", googlebot), false,
        "F12: PTR crawl.evilgooglebot.com (forward-confirmed) -> not verified: the domain must follow a dot");
      eq(await forwardConfirmedReverseDns(f.resolver, "203.0.113.81", googlebot), false,
        "F13: PTR = the bare domain googlebot.com (forward-confirmed) -> not verified: a host under the domain is required");
      const fc = f.calls.resolve4;
      eq(await forwardConfirmedReverseDns(f.resolver, "203.0.113.82", googlebot), false,
        "F14: four in-domain PTR names, only the 4th confirms -> not verified (MAX_PTR_NAMES = 3)");
      eq(f.calls.resolve4 - fc, 3, "F15: ... and only three forward lookups were made");
      eq(await forwardConfirmedReverseDns(f.resolver, "203.0.113.83", googlebot), true, "F16: control: a confirming name within the first three -> verified");
      const bad = fakeResolver(googleRecords, { fail: true });
      let threw = false;
      try { await forwardConfirmedReverseDns(bad.resolver, GOOGLE_IP, googlebot); } catch { threw = true; }
      eq(threw, true, "F11: a resolver failure (not ENOTFOUND) rejects (the verifier caches it as an error)");
    }

    // ── V: the verifier ──────────────────────────────────────────────────
    {
      let t = 1_000_000;
      const f = fakeResolver(googleRecords, { delayMs: 5 });
      const verified: string[] = [];
      const v = new AiReaderVerifier({ resolver: f.resolver, now: () => t, onVerified: (e) => verified.push(e.operator) });
      eq(v.isVerified(GOOGLE_IP, googlebot), false, "V1: cache miss -> false for this request");
      eq(v.inFlightSize(), 1, "V2: ... and one background lookup started");
      eq([v.isVerified(GOOGLE_IP, googlebot), v.isVerified(GOOGLE_IP, googlebot)], [false, false], "V3: while it runs -> still false");
      eq(v.inFlightSize(), 1, "V4: in-flight lookups are deduplicated");
      await v.settled();
      eq(f.calls.reverse, 1, "V5: one PTR lookup for three requests");
      eq(v.isVerified(GOOGLE_IP, googlebot), true, "V6: after it finished -> verified");
      eq(verified, ["google"], "V7: onVerified once");
      eq(v.isVerified("::ffff:" + GOOGLE_IP, googlebot), true, "V7b: the mapped form hits the same cache entry");
      t += POSITIVE_TTL_MS - 1;
      eq(v.isVerified(GOOGLE_IP, googlebot), true, "V8: still verified just before 24 h");
      eq(f.calls.reverse, 1, "V9: ... from the cache");
      t += 1;
      eq(v.isVerified(GOOGLE_IP, googlebot), false, "V10: after 24 h -> expired, false, re-verify started");
      await v.settled();
      eq([f.calls.reverse, v.isVerified(GOOGLE_IP, googlebot)], [2, true], "V11: re-verified");

      v.isVerified("203.0.113.67", googlebot);
      await v.settled();
      const calls = f.calls.reverse;
      eq(v.isVerified("203.0.113.67", googlebot), false, "V12: a failed verification is cached negatively");
      t += NEGATIVE_TTL_MS - 1;
      v.isVerified("203.0.113.67", googlebot);
      eq([f.calls.reverse, v.inFlightSize()], [calls, 0], "V13: no new lookup within the 1 h negative TTL");
      t += 1;
      v.isVerified("203.0.113.67", googlebot);
      eq(v.inFlightSize(), 1, "V14: after 1 h it is tried again");
      await v.settled();
    }
    {
      // N1: the cache key includes the operator.
      const f = fakeResolver(googleRecords);
      const v = new AiReaderVerifier({ resolver: f.resolver });
      const bingEntry = AI_READER_REGISTRY.find((e) => e.token === "bingbot")!;
      v.isVerified(GOOGLE_IP, googlebot);
      await v.settled();
      eq(v.isVerified(GOOGLE_IP, googlebot), true, "V7c: Google IP verified for Google");
      eq(v.isVerified(GOOGLE_IP, bingEntry), false, "V7d: the same IP with a bingbot UA is not verified for bing (key = IP + operator)");
      await v.settled();
      eq([f.calls.reverse, v.isVerified(GOOGLE_IP, bingEntry), v.isVerified(GOOGLE_IP, googlebot)], [2, false, true],
        "V7e: ... bing got its own lookup (PTR is googlebot.com -> not verified), Google stays verified");
    }
    {
      let t = 2_000_000;
      const f = fakeResolver(googleRecords, { fail: true });
      const v = new AiReaderVerifier({ resolver: f.resolver, now: () => t });
      v.isVerified(GOOGLE_IP, googlebot);
      await v.settled();
      eq(v.isVerified(GOOGLE_IP, googlebot), false, "V15: resolver error -> not verified");
      eq(f.calls.reverse, 1, "V16: ... cached (no retry storm)");
      t += ERROR_TTL_MS;
      v.isVerified(GOOGLE_IP, googlebot);
      eq(f.calls.reverse, 2, "V17: retried after the 10 min error TTL");
      await v.settled();
    }
    {
      const f = fakeResolver(googleRecords, { hang: true });
      const v = new AiReaderVerifier({ resolver: f.resolver, timeoutMs: 20 });
      const started = Date.now();
      v.isVerified(GOOGLE_IP, googlebot);
      await v.settled();
      ok(Date.now() - started < 1000, "V18: a hanging resolver is cut off by the timeout");
      eq([v.isVerified(GOOGLE_IP, googlebot), v.inFlightSize()], [false, 0], "V19: timeout -> not verified, nothing left running");
    }
    {
      const f = fakeResolver({}, { hang: true });
      const v = new AiReaderVerifier({ resolver: f.resolver, timeoutMs: 20, maxInFlight: 3, maxCache: 4, ipListFetcher: noLists });
      for (let i = 0; i < 10; i++) v.isVerified(`192.0.2.${i}`, googlebot);
      eq(v.inFlightSize(), 3, "V20: at most maxInFlight lookups at once (the rest just get base)");
      await v.settled();
      for (let i = 10; i < 20; i++) { v.isVerified(`192.0.2.${i}`, googlebot); await v.settled(); }
      ok(v.cacheSize() <= 4, "V21: the cache never holds more than maxCache entries");
      const before = f.total();
      eq([v.isVerified("not-an-ip", googlebot), v.isVerified(GOOGLE_IP, AI_READER_REGISTRY.find((e) => e.token === "ClaudeBot")!)], [false, false], "V22: bad IP / ip_list -> false");
      eq(f.total(), before, "V23: ... with no lookup");
    }

    // ── G: through revealEmailFor ────────────────────────────────────────
    {
      const lines: string[] = [];
      let t = 50_000_000;
      const f = fakeResolver(googleRecords);
      __resetEmailRevealGuardForTesting({ now: () => t, log: (l) => lines.push(l), aiReaders: { resolver: f.resolver, now: () => t, ipListFetcher: noLists } });
      const req = (ip: string, ua?: string) => ({ ip, headers: ua === undefined ? {} : { "user-agent": ua } }) as any;
      const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
      process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = "3";
      process.env.EMAIL_REVEAL_AI_READER_PER_HOUR = "10";

      for (const k of ["EMAIL_REVEAL_GUARD_DENTAL", "EMAIL_REVEAL_GUARD_RFB", "EMAIL_REVEAL_GUARD_EXPERIENCES"]) delete process.env[k];
      eq([revealEmailFor(req(GOOGLE_IP, GOOGLEBOT_UA), "dental", ["a"]), revealEmailFor(req(GOOGLE_IP, GOOGLEBOT_UA), "rfb", ["a"]),
        revealEmailFor(req(GOOGLE_IP, GOOGLEBOT_UA), "experiences", ["a"])], [null, null, null], "G1: every switch off -> null");
      await __emailRevealAiReadersSettledForTesting();
      eq([f.total(), lines.length], [0, 0], "G2: switch off -> the resolver is never called, nothing logged");

      process.env.EMAIL_REVEAL_GUARD_DENTAL = "on";
      eq(revealEmailFor(req(GOOGLE_IP, GOOGLEBOT_UA), "dental", ids("g", 6))?.size, 3, "G3: verified-to-be Googlebot, first request (cache miss) -> base limit");
      eq(f.calls.reverse, 1, "G4: ... and a background verification started");
      await __emailRevealAiReadersSettledForTesting();
      eq(revealEmailFor(req(GOOGLE_IP, GOOGLEBOT_UA), "dental", ids("g", 12))?.size, 10, "G5: after verification -> the AI-reader limit (10), same counter");
      eq(revealEmailFor(req(GOOGLE_IP, GOOGLEBOT_UA), "dental", ids("h", 2))?.size, 0, "G6: ... and the limit holds at 10 in the window");
      const verifiedLines = lines.map((l) => JSON.parse(l)).filter((p) => p.evt === "email_reveal_ai_reader_verified");
      eq(verifiedLines.map((p) => [p.operator, p.token, p.host, typeof p.client]), [["google", "Googlebot", "dental", "string"]], "G7: one verification log line (operator, host, hashed client)");
      ok(lines.every((l) => !l.includes(GOOGLE_IP) && !l.includes("66.249")), "G8: no raw IP in any log line");

      eq(revealEmailFor(req(GOOGLE_IP, "Mozilla/5.0"), "rfb", ids("b", 6)), null, "G9: rfb switch still off");
      process.env.EMAIL_REVEAL_GUARD_RFB = "on";
      eq(revealEmailFor(req(GOOGLE_IP, "Mozilla/5.0"), "rfb", ids("b", 6))?.size, 3, "G10: same IP with a browser UA -> base limit (the UA picks the operator)");

      const spoof = "203.0.113.67";
      revealEmailFor(req(spoof, GOOGLEBOT_UA), "dental", ["s0"]);
      await __emailRevealAiReadersSettledForTesting();
      eq(revealEmailFor(req(spoof, GOOGLEBOT_UA), "dental", ids("s", 8))?.size, 3, "G11: spoofed Googlebot UA (forward mismatch) -> stays at base");
      revealEmailFor(req("203.0.113.66", GOOGLEBOT_UA), "dental", ["s0"]);
      await __emailRevealAiReadersSettledForTesting();
      eq(revealEmailFor(req("203.0.113.66", GOOGLEBOT_UA), "dental", ids("s", 8))?.size, 3, "G12: spoofed Googlebot UA (PTR not Google) -> stays at base");

      const before = f.total();
      eq(revealEmailFor(req(GOOGLE_IP, "CCBot/2.0 Googlebot/2.1"), "dental", ["c1"])?.size, 0, "G13: CCBot from a verified Google IP -> still no e-mail");
      eq(revealEmailFor(req("198.51.100.77", "GPTBot/1.1"), "dental", ids("o", 6))?.size, 3, "G14: GPTBot (ip_list) -> base limit");
      eq(revealEmailFor(req("198.51.100.78", "Claude-User/1.0"), "dental", ids("o", 6))?.size, 3, "G15: Claude-User (ip_list) -> base limit");
      await __emailRevealAiReadersSettledForTesting();
      eq(f.total(), before, "G16: CCBot and ip_list operators cause no DNS lookup");

      process.env.EMAIL_REVEAL_AI_READER_PER_HOUR = "2";
      eq(revealEmailFor(req("66.249.66.200", GOOGLEBOT_UA), "dental", ids("z", 6))?.size, 3, "G17: AI-reader limit below base -> base (never lower)");
      await __emailRevealAiReadersSettledForTesting();
      eq(f.total(), before, "G18: ... and no lookup when there is nothing to gain");

      process.env.EMAIL_REVEAL_AI_READER_PER_HOUR = "10";
      t += 61 * 60_000;
      eq(revealEmailFor(req(GOOGLE_IP, GOOGLEBOT_UA), "dental", ids("n", 12))?.size, 10, "G19: an hour later the verified reader still gets 10 (cache, no new lookup)");
      eq(f.calls.reverse, 3, "G20: total PTR lookups: Google once + two spoofers");
    }

    // ── D: emailRevealLimitFor directly ──────────────────────────────────
    {
      const f = fakeResolver(googleRecords);
      __resetEmailRevealGuardForTesting({ log: () => {}, aiReaders: { resolver: f.resolver, ipListFetcher: noLists } });
      process.env.EMAIL_REVEAL_AI_READER_PER_HOUR = "300";
      const req = (ip: string, ua: string) => ({ ip, headers: { "user-agent": ua } }) as any;
      emailRevealLimitFor(req(GOOGLE_IP, GOOGLEBOT_UA), "dental", 30);
      await __emailRevealAiReadersSettledForTesting();
      eq(emailRevealLimitFor(req(GOOGLE_IP, GOOGLEBOT_UA), "dental", 30), 300, "D1: control: verified Googlebot IP -> the AI-reader limit");
      const before = f.total();
      eq(emailRevealLimitFor(req(GOOGLE_IP, "CCBot/2.0 " + GOOGLEBOT_UA), "dental", 30), 30, "D2: CCBot UA from the verified IP -> base limit");
      eq(emailRevealLimitFor(req(GOOGLE_IP, "ccbot"), "dental", 30), 30, "D3: lower-case ccbot -> base limit");
      eq(f.total(), before, "D4: ... with no DNS lookup");
    }
  } catch (err: any) {
    failed++;
    failures.push("email reveal ai readers: unexpected error: " + String(err?.stack || err?.message || err));
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
  console.log("── email reveal AI readers (dev-request 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, S-A2) ──");
  runEmailRevealAiReadersTests({ log: true }).then((r) => {
    console.log(`\nemail reveal ai readers: ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
