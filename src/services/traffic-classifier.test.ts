/**
 * traffic-classifier.test.ts — tests for THE shared UA/session classifier
 * (src/services/traffic-classifier.ts), dev-request
 * 2026-07-21-analytics-tre-boetter-mcp-logging-a2a-transparens slice A.
 *
 * Covers, with REAL sample UA strings:
 *   - every named agent lands in its Daniel-decided bucket
 *   - ordering edge cases: ChatGPT-User vs GPTBot, Claude-User vs ClaudeBot,
 *     Perplexity-User vs PerplexityBot, Applebot-Extended vs Applebot
 *   - empty/missing UA → other_bot (NOT human — honesty rule)
 *   - real browser UAs (desktop Chrome, iPhone Safari, Firefox) → human
 *   - session_id recovery when the UA itself contains colons
 *   - scanner folding: fake-stale-Chrome UA heuristic + scannerPaths opt
 *
 * Pure module — no DB, no singleton swaps. Exported runTrafficClassifierTests
 * ({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/services/traffic-classifier.test.ts
 */

import {
  classifyUA,
  classifySession,
  uaFromSessionId,
  isScannerUA,
  TrafficCategory,
} from "./traffic-classifier";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runTrafficClassifierTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (actual === expected) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  function expectBucket(ua: string, expected: TrafficCategory, label: string): void {
    assertEq(classifyUA(ua), expected, `${label}: ${JSON.stringify(ua.slice(0, 60))} → ${expected}`);
  }

  // ── ai_search: ONLY the `*-User` (human-initiated retrieval) class ──────
  expectBucket(
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
    "ai_search", "as1 ChatGPT-User");
  expectBucket(
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)",
    "ai_search", "as2 Claude-User");
  expectBucket(
    "Mozilla/5.0 (compatible; Claude-Web/1.0; +http://www.anthropic.com/bot.html)",
    "ai_search", "as3 Claude-Web");
  expectBucket(
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)",
    "ai_search", "as4 Perplexity-User");
  expectBucket(
    "DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)",
    "ai_search", "as5 DuckAssistBot");

  // ── ai_crawler: autonomous AI crawlers ──────────────────────────────────
  expectBucket(
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.4; +https://openai.com/gptbot",
    "ai_crawler", "ac1 GPTBot");
  // Daniel explicitly: OAI-SearchBot is NOT human search.
  expectBucket(
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot",
    "ai_crawler", "ac2 OAI-SearchBot");
  expectBucket(
    "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
    "ai_crawler", "ac3 ClaudeBot");
  expectBucket("Mozilla/5.0 (compatible; anthropic-ai/1.0)", "ai_crawler", "ac4 anthropic-ai");
  expectBucket(
    "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
    "ai_crawler", "ac5 PerplexityBot");
  expectBucket("Mozilla/5.0 (compatible; Google-Extended)", "ai_crawler", "ac6 Google-Extended");
  expectBucket(
    "Mozilla/5.0 (compatible; GoogleOther) AppleWebKit/537.36",
    "ai_crawler", "ac7 GoogleOther");
  // Daniel explicitly: Amazonbot and Bytespider are NOT human search.
  expectBucket(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_1) AppleWebKit/600.2.5 (KHTML, like Gecko) Version/8.0.2 Safari/600.2.5 (Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)",
    "ai_crawler", "ac8 Amazonbot");
  expectBucket(
    "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)",
    "ai_crawler", "ac9 Bytespider");
  expectBucket("CCBot/2.0 (https://commoncrawl.org/faq/)", "ai_crawler", "ac10 CCBot");
  expectBucket(
    "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
    "ai_crawler", "ac11 meta-externalagent");
  expectBucket(
    "Mozilla/5.0 (Device; OS_version) AppleWebKit/WebKit_version (KHTML, like Gecko) Version/Safari_version Safari/WebKit_version (Applebot-Extended/Applebot_version)",
    "ai_crawler", "ac12 Applebot-Extended (must NOT fall into search_engine's Applebot)");
  expectBucket("Mozilla/5.0 (compatible; cohere-ai/1.0)", "ai_crawler", "ac13 cohere-ai");
  expectBucket("Mozilla/5.0 (compatible; YouBot/1.0; +https://you.com)", "ai_crawler", "ac14 YouBot");
  expectBucket("Mozilla/5.0 (compatible; cloud-crawler/1.0)", "ai_crawler", "ac15 cloud-crawler");
  expectBucket(
    "Mozilla/5.0 (compatible; NotHumanSearch/1.0; +https://nothumansearch.com)",
    "ai_crawler", "ac16 NotHumanSearch");
  expectBucket("Gemini/1.0", "ai_crawler", "ac17 Gemini");

  // ── search_engine ───────────────────────────────────────────────────────
  expectBucket(
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/125.0.6422.175 Safari/537.36",
    "search_engine", "se1 Googlebot");
  expectBucket(
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36",
    "search_engine", "se2 bingbot");
  expectBucket(
    "Mozilla/5.0 (Windows Phone 8.1; ARM; Trident/7.0; Touch; rv:11.0; IEMobile/11.0) like Gecko BingPreview/1.0b",
    "search_engine", "se3 BingPreview");
  expectBucket(
    "Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)",
    "search_engine", "se4 Baiduspider");
  expectBucket(
    "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
    "search_engine", "se5 YandexBot");
  expectBucket(
    "DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)",
    "search_engine", "se6 DuckDuckBot");
  expectBucket(
    "Mozilla/5.0 (Device; OS_version) AppleWebKit/WebKit_version (KHTML, like Gecko; compatible; Applebot/0.1; +http://www.apple.com/go/applebot)",
    "search_engine", "se7 plain Applebot");
  expectBucket(
    "Mozilla/5.0 (Linux; Android 7.0;) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)",
    "search_engine", "se8 PetalBot");
  expectBucket("Mozilla/5.0 (compatible; SeekportBot; +https://bot.seekport.com)", "search_engine", "se9 SeekportBot");
  expectBucket("Mozilla/5.0 (compatible; MojeekBot/0.11; +https://www.mojeek.com/bot.html)", "search_engine", "se10 MojeekBot");

  // ── seo_bot ─────────────────────────────────────────────────────────────
  expectBucket(
    "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)",
    "seo_bot", "sb1 SemrushBot");
  expectBucket(
    "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
    "seo_bot", "sb2 AhrefsBot");
  expectBucket(
    "Mozilla/5.0 (compatible; DataForSeoBot/1.0; +https://dataforseo.com/dataforseo-bot)",
    "seo_bot", "sb3 DataForSeoBot");
  expectBucket("Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)", "seo_bot", "sb4 MJ12bot");
  expectBucket("Mozilla/5.0 (compatible; DotBot/1.2; +https://opensiteexplorer.org/dotbot)", "seo_bot", "sb5 DotBot");
  expectBucket("Mozilla/5.0 (compatible; AwarioBot/1.0; +https://awario.com/bots.html)", "seo_bot", "sb6 AwarioBot");
  expectBucket("Mozilla/5.0 (compatible; SERankingBacklinksBot/1.0)", "seo_bot", "sb7 SERankingBacklinksBot");
  expectBucket("serpstatbot/2.1 (advanced backlink tracking bot; https://serpstatbot.com/)", "seo_bot", "sb8 serpstatbot");
  expectBucket("Mozilla/5.0 (compatible; BLEXBot/1.0; +http://webmeup-crawler.com/)", "seo_bot", "sb9 BLEXBot");
  expectBucket("Mozilla/5.0 (compatible; ImagesiftBot; +imagesift.com)", "seo_bot", "sb10 ImagesiftBot");
  expectBucket("Mozilla/5.0 (compatible; Diffbot/0.1; +https://www.diffbot.com)", "seo_bot", "sb11 Diffbot");
  expectBucket("Mozilla/5.0 (compatible; Dataprovider.com)", "seo_bot", "sb12 Dataprovider");
  expectBucket("jscrawler/1.0", "seo_bot", "sb13 jscrawler");

  // ── social ──────────────────────────────────────────────────────────────
  expectBucket("facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", "social", "so1 facebookexternalhit");
  expectBucket("Twitterbot/1.0", "social", "so2 Twitterbot");
  expectBucket("LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)", "social", "so3 LinkedInBot");
  expectBucket("Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)", "social", "so4 Slackbot");
  expectBucket("WhatsApp/2.23.20.0", "social", "so5 WhatsApp");
  expectBucket("TelegramBot (like TwitterBot)", "social", "so6 TelegramBot");

  // ── dev ─────────────────────────────────────────────────────────────────
  expectBucket("curl/8.4.0", "dev", "d1 curl");
  expectBucket("Python/3.11 aiohttp/3.9.1", "dev", "d2 Python+aiohttp");
  expectBucket("Python-urllib/3.9", "dev", "d3 Python-urllib");
  expectBucket("node-fetch/1.0 (+https://github.com/bitinn/node-fetch)", "dev", "d4 node-fetch");
  expectBucket("axios/1.6.2", "dev", "d5 axios");
  expectBucket("Go-http-client/2.0", "dev", "d6 Go-http-client");
  expectBucket("Lokal-Enricher/1.0", "dev", "d7 Lokal-Enricher");

  // ── other_bot: generic fallback + named oddballs + empty UA ─────────────
  expectBucket("Mozilla/5.0 (compatible; SomeRandomBot/3.2; +https://example.com/bot)", "other_bot", "ob1 generic *Bot");
  expectBucket("weird-spider/0.1", "other_bot", "ob2 generic spider");
  expectBucket("mycrawler/2.0", "other_bot", "ob3 generic crawl");
  expectBucket("Chiark-0.5", "other_bot", "ob4 Chiark");
  // HONESTY RULE: no real browser sends an empty UA — empty is NOT human.
  expectBucket("", "other_bot", "ob5 empty UA");
  expectBucket("   ", "other_bot", "ob6 whitespace-only UA");

  // ── human: real browser UAs ─────────────────────────────────────────────
  expectBucket(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "human", "h1 desktop Chrome");
  expectBucket(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "human", "h2 iPhone Safari");
  expectBucket(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0",
    "human", "h3 macOS Firefox");
  expectBucket(
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
    "human", "h4 Android Chrome");

  // ── ordering edge cases (the spec-mandated pairs) ───────────────────────
  // Each *-User agent must classify ai_search even though its family crawler
  // exists in ai_crawler, and each family crawler must NOT leak into
  // ai_search.
  assertEq(classifyUA("Mozilla/5.0 (compatible; ChatGPT-User/1.0)"), "ai_search", "o1 ChatGPT-User ≠ GPTBot");
  assertEq(classifyUA("Mozilla/5.0 (compatible; GPTBot/1.4)"), "ai_crawler", "o2 GPTBot ≠ ChatGPT-User");
  assertEq(classifyUA("Mozilla/5.0 (compatible; Claude-User/1.0)"), "ai_search", "o3 Claude-User not swallowed by ClaudeBot family");
  assertEq(classifyUA("Mozilla/5.0 (compatible; ClaudeBot/1.0)"), "ai_crawler", "o4 ClaudeBot stays ai_crawler");
  assertEq(classifyUA("Mozilla/5.0 (compatible; Perplexity-User/1.0)"), "ai_search", "o5 Perplexity-User before PerplexityBot");
  assertEq(classifyUA("Mozilla/5.0 (compatible; PerplexityBot/1.0)"), "ai_crawler", "o6 PerplexityBot stays ai_crawler");

  // ── session_id recovery (UAs contain colons) ────────────────────────────
  const colonUa = "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com) mailto:test";
  assertEq(uaFromSessionId(`iphash123:${colonUa}`), colonUa, "s1 UA with colons recovered intact");
  assertEq(uaFromSessionId("no-colon-session"), "", "s2 session_id without colon → empty UA");
  assertEq(classifySession(`iphash123:${colonUa}`), "ai_crawler", "s3 classifySession recovers + classifies");
  assertEq(classifySession("no-colon-session"), "other_bot", "s4 unrecoverable UA is NOT human");

  // ── scanner folding ─────────────────────────────────────────────────────
  const fakeOldChrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/78.0.3904.108 Safari/537.36";
  const realChrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  assertEq(isScannerUA(fakeOldChrome), true, "sc1 fake stale Chrome/78.0 matches scanner heuristic");
  assertEq(isScannerUA(realChrome), false, "sc2 current Chrome does not");
  assertEq(classifySession(`ip1:${fakeOldChrome}`), "scanner", "sc3 fake-old-Chrome session → scanner");
  assertEq(classifySession(`ip1:${realChrome}`), "human", "sc4 real browser session → human");
  assertEq(classifySession(`ip1:${realChrome}`, { scannerPaths: true }), "scanner",
    "sc5 browser-looking session that probed wp-admin/.env paths → scanner");
  // scanner never claims a session already in a named bot bucket
  assertEq(classifySession("ip1:Mozilla/5.0 (compatible; GPTBot/1.4)", { scannerPaths: true }), "ai_crawler",
    "sc6 named bot stays in its bucket even with scanner paths");

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/traffic-classifier.test.ts`
if (require.main === module) {
  const summary = runTrafficClassifierTests({ log: true });
  console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
  process.exit(summary.failed > 0 ? 1 : 0);
}
