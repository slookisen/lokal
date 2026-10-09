/**
 * agentplatform-partners.test.ts — /partnere on agentplatform.no and the live
 * figures behind it (A2A dev-request 2026-10-09-agentplatform-partnerside).
 *
 * Covers:
 *   (a) /partnere and /en/partners render (200, right language, canonical,
 *       hreflang), redirects for common spellings, nav + sitemap + llms.txt link
 *   (b) figures: every tile has its definition; sums need all three services;
 *       a missing or zero figure hides its tile; values are rounded DOWN with "+"
 *   (c) the investor section carries the "not an offer of shares" disclaimer;
 *       no prices, no names of prospective partners
 *   (d) front page: founder name + role, JSON-LD founder, LinkedIn only when set,
 *       partner teaser linking to /partnere
 *   (e) computeAgentToolCalls counts only real MCP tool calls (no handshakes,
 *       no server/discover, no owner rows, no probe clients, inside the window),
 *       also through the worker's runStatsTask, and the reader's sync path caches
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/agentplatform-partners.test.ts
 *   2. Wired into the gate via tests/test.ts.
 */

import * as http from "http";
import express from "express";
import Database from "better-sqlite3";
import {
  collectPlatformMetrics,
  createAgentplatformHostGate,
  createAgentplatformRouter,
  floorForTile,
  renderPartners,
  type AgentCallReading,
  type TrafficReading,
} from "./agentplatform-site";
import { computeAgentToolCalls } from "../services/agent-usage-compute";
import { createAgentUsageReader } from "../services/agent-usage";
import { runStatsTask } from "../services/offthread-stats-worker";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runAgentplatformPartnersTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log !== false;
  const summary: TestSummary = { passed: 0, failed: 0, failures: [] };
  const check = (name: string, cond: boolean, detail?: string) => {
    if (cond) {
      summary.passed++;
      if (log) console.log(`  ✓ ${name}`);
    } else {
      summary.failed++;
      summary.failures.push(detail ? `${name} — ${detail}` : name);
      if (log) console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    }
  };

  const counts: Record<string, number> = { rfb: 1560, experiences: 563, dental: 5446 };
  const traffic: Record<string, TrafficReading> = {
    rfb: { realVisitors: 61_234, aiCrawlerViews: 140_999, windowDays: 60 },
    experiences: { realVisitors: 9_100, aiCrawlerViews: 13_400, windowDays: 60 },
    dental: { realVisitors: 7_050, aiCrawlerViews: 7_700, windowDays: 60 },
  };
  const agent: AgentCallReading = { toolCalls: 5_527, windowDays: 30 };

  const router = createAgentplatformRouter({
    readCount: (v) => counts[v] ?? null,
    readTraffic: (v) => traffic[v] ?? null,
    readAgentCalls: () => agent,
  });
  const app = express();
  app.set("trust proxy", true);
  app.use(createAgentplatformHostGate(router));
  app.use((_req, res) => res.status(418).send("fell-through"));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  const get = (p: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> =>
    new Promise((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: p, headers: { host: "agentplatform.no" } }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => resolve({ status: resp.statusCode || 0, headers: resp.headers, body: Buffer.concat(chunks).toString("utf8") }));
        })
        .on("error", reject);
    });

  try {
    // ── (a) pages, redirects, links ──────────────────────────────────────
    const nb = await get("/partnere");
    const en = await get("/en/partners");
    check("a1: /partnere → 200 Norwegian", nb.status === 200 && nb.body.includes('<html lang="nb">'));
    check("a2: /en/partners → 200 English", en.status === 200 && en.body.includes('<html lang="en">'));
    check("a3: canonical + hreflang pair", nb.body.includes('<link rel="canonical" href="https://agentplatform.no/partnere">') && nb.body.includes('hreflang="en" href="https://agentplatform.no/en/partners"'));
    const r1 = await get("/partners");
    const r2 = await get("/investorer");
    check("a4: /partners → /en/partners, /investorer → /partnere#investorer", r1.status === 301 && r1.headers.location === "/en/partners" && r2.status === 301 && r2.headers.location === "/partnere#investorer");
    const home = await get("/");
    check("a5: header nav links to /partnere", home.body.includes('<a class="opt" href="/partnere">Partnere</a>'));
    const sm = await get("/sitemap.xml");
    const llms = await get("/llms.txt");
    check("a6: sitemap lists /partnere and /en/partners; llms.txt links the partner page", sm.body.includes("<loc>https://agentplatform.no/partnere</loc>") && sm.body.includes("<loc>https://agentplatform.no/en/partners</loc>") && llms.body.includes("https://agentplatform.no/en/partners"));

    // ── (b) figures ───────────────────────────────────────────────────────
    check("b1: catalog total (exact) 7 569", nb.body.includes("<strong>7 569</strong>"));
    check("b2: human visits 77 384 → 77 000+ with 60-day label", nb.body.includes("<strong>77 000+</strong><span class=\"m-label\">besøk fra mennesker siste 60 dager</span>"));
    check("b3: AI-crawler views 162 099 → 162 000+", nb.body.includes("<strong>162 000+</strong><span class=\"m-label\">sidevisninger fra AI-crawlere siste 60 dager</span>"));
    check("b4: agent tool calls 5 527 → 5 500+ with 30-day label", nb.body.includes("<strong>5 500+</strong><span class=\"m-label\">verktøykall fra AI-agenter siste 30 dager</span>"));
    check("b5: every tile has a definition", (nb.body.match(/class="m-def"/g) || []).length === 4);
    check("b5b: the tool-call definition names what is counted (incl. cart and ordering)", nb.body.includes("søk, oppslag, handlekurv og bestilling") && en.body.includes("search, lookup, cart and ordering"));
    check("b6: floorForTile rounds down", floorForTile(162_099) === 162_000 && floorForTile(5_527) === 5_500 && floorForTile(812) === 812 && floorForTile(10_999) === 10_000);
    check("b7: never 'AI-brukere' / 'AI users'", !/AI-brukere|AI users/i.test(nb.body + en.body));

    const partial = collectPlatformMetrics(
      { readTraffic: (v) => (v === "dental" ? null : traffic[v]), readAgentCalls: () => null },
      { rfb: 1560, experiences: 563, dental: 5446 },
    );
    check("b8: a service without traffic data hides both traffic sums", partial.humanVisits === null && partial.aiCrawlerViews === null && partial.trafficWindowDays === null);
    check("b9: no agent reading → no agent figure", partial.agentToolCalls === null);
    const partialHtml = renderPartners("nb", partial);
    check("b10: hidden figures render no tile (only the catalog)", (partialHtml.match(/class="metric"/g) || []).length === 1 && !partialHtml.includes("besøk fra mennesker"));
    const zero = collectPlatformMetrics(
      { readTraffic: () => ({ realVisitors: 0, aiCrawlerViews: 0, windowDays: 60 }), readAgentCalls: () => ({ toolCalls: 0, windowDays: 30 }) },
      { rfb: null, experiences: 563, dental: 5446 },
    );
    const zeroHtml = renderPartners("nb", zero);
    check("b11: zeros and a missing catalog count hide the whole figures band", !zeroHtml.includes('id="tall"') && !zeroHtml.includes('href="#tall"'));
    const mixedWindows = collectPlatformMetrics(
      { readTraffic: (v) => ({ ...traffic[v], windowDays: v === "rfb" ? 60 : 30 }), readAgentCalls: () => agent },
      { rfb: 1, experiences: 1, dental: 1 },
    );
    check("b12: traffic windows that disagree hide the sums (no mislabelled period)", mixedWindows.humanVisits === null && mixedWindows.trafficWindowDays === null);

    // ── (c) investor section ─────────────────────────────────────────────
    check("c1: disclaimer (nb)", nb.body.includes("ikke et tilbud om kjøp eller tegning av aksjer"));
    check("c2: disclaimer (en)", en.body.includes("not an offer to buy or subscribe for shares"));
    check("c3: investor anchor present for the /investorer redirect", nb.body.includes('id="investorer"'));
    const visible = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, "");
    check("c4: no prices on the page", !/\bkr\b|NOK|\d\s?%|per måned|per month|kroner/i.test(visible(nb.body) + visible(en.body)));
    check("c5: no names of prospective partners", !/Gisle|Agric|Norske Gårder|norskegarder/i.test(nb.body + en.body));
    check("c6: mailto carries a subject", nb.body.includes("mailto:kontakt@agentplatform.no?subject=Samarbeid") && nb.body.includes("subject=Investering"));

    // ── (d) front page founder + teaser ──────────────────────────────────
    check("d1: founder name and role in Om oss", home.body.includes("<strong>Daniel Fredriksen</strong><span>Gründer og daglig leder"));
    check(
      "d2: LinkedIn link next to the founder, and nowhere else on the page",
      home.body.includes('<a href="https://www.linkedin.com/in/danielfredriksen" rel="me noopener">LinkedIn-profil</a>') &&
        (home.body.match(/linkedin\.com/g) || []).length === 2, // founder link + JSON-LD sameAs
    );
    const ld = home.body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    let json: any = null;
    try { json = ld ? JSON.parse(ld[1]) : null; } catch { json = null; }
    check(
      "d3: JSON-LD founder Person with LinkedIn sameAs",
      json?.founder?.["@type"] === "Person" && json?.founder?.name === "Daniel Fredriksen" &&
        json?.founder?.sameAs?.[0] === "https://www.linkedin.com/in/danielfredriksen",
    );
    check("d4: partner teaser on the front page links to /partnere", home.body.includes('<a class="teaser" href="/partnere">'));
    const enHome = await get("/en");
    check("d5: English front page: founder role + teaser to /en/partners", enHome.body.includes("Founder and CEO") && enHome.body.includes('<a class="teaser" href="/en/partners">'));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }

  // ── (e) tool-call count ─────────────────────────────────────────────────
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE analytics_mcp_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, protocol TEXT NOT NULL, vertical_id TEXT NOT NULL DEFAULT 'rfb',
    tool_name TEXT, client_name TEXT, client_version TEXT, user_agent TEXT, ip_hash TEXT, duration_ms INTEGER,
    is_owner INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`);
  const now = Date.parse("2026-10-09T12:00:00Z");
  const at = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString().replace("T", " ").slice(0, 19);
  const ins = db.prepare("INSERT INTO analytics_mcp_calls (protocol, tool_name, client_name, is_owner, created_at) VALUES (?, ?, ?, ?, ?)");
  const rows: Array<[string, string | null, string | null, number, number]> = [
    ["mcp", "lokal_search", "unknown", 0, 1], // counts
    ["mcp", "tannlege_search", "Claude", 0, 2], // counts
    ["mcp", "get_experience", null, 0, 29], // counts
    ["mcp", "tools/list", "Claude", 0, 1],
    ["mcp", "initialize", "Claude", 0, 1],
    ["mcp", "notifications/initialized", "Claude", 0, 1],
    ["mcp", "server/discover", "glama", 0, 1],
    ["mcp", "ping", "unknown", 0, 1],
    ["mcp", "lokal_search", "glimind-probe", 0, 1], // probe
    ["mcp", "lokal_search", "mcpbeat", 0, 1], // monitor
    ["mcp", "lokal_search", "unknown", 1, 1], // our own agent
    ["mcp", "lokal_search", "unknown", 0, 31], // outside the window
    ["a2a", "message/send", "unknown", 0, 1], // A2A not counted
    ["agent_card", null, "unknown", 0, 1],
  ];
  for (const r of rows) ins.run(r[0], r[1], r[2], r[3], at(r[4]));
  const direct = computeAgentToolCalls(db, now, 30);
  check("e1: only real MCP tool calls inside 30 days, no owner/probe/handshake rows", direct.toolCalls === 3 && direct.windowDays === 30, JSON.stringify(direct));
  const viaWorker = runStatsTask(db, { kind: "agentToolCalls", nowMs: now, windowDays: 30 }) as any;
  check("e2: the worker task returns the same count", viaWorker?.toolCalls === 3);

  let computes = 0;
  let clock = now;
  const reader = createAgentUsageReader({
    getDb: () => db,
    offThreadUsable: () => false,
    runOffThread: () => Promise.reject(new Error("not used")),
    computeSync: (d, n) => {
      computes++;
      return computeAgentToolCalls(d, n);
    },
    now: () => clock,
    syncTtlMs: 600_000,
    offThreadTtlMs: 3_600_000,
    retryAfterMs: 60_000,
    log: () => {},
  });
  const s1 = reader.snapshot();
  const s2 = reader.snapshot();
  check("e3: sync path computes once and caches", s1.ready && s1.stats.toolCalls === 3 && s2.stats.toolCalls === 3 && computes === 1);
  clock += 600_000;
  reader.snapshot();
  check("e4: sync cache expires after its TTL", computes === 2);
  const broken = createAgentUsageReader({
    getDb: () => { throw new Error("no db"); },
    offThreadUsable: () => false,
    runOffThread: () => Promise.reject(new Error("x")),
    computeSync: () => ({ toolCalls: 1, windowDays: 30 }),
    now: () => now, syncTtlMs: 1, offThreadTtlMs: 1, retryAfterMs: 1, log: () => {},
  });
  check("e5: no DB → not ready (figure hidden), never throws", broken.snapshot().ready === false);

  // Production path: off-thread. Not ready until the first refresh lands, then
  // served from cache without recomputing; prewarm() starts the refresh early;
  // the main thread never computes.
  let offCalls = 0;
  let syncCalls = 0;
  let offClock = now;
  const fakeFileDb = { name: "/data/lokal.db" } as unknown as Database.Database;
  const off = createAgentUsageReader({
    getDb: () => fakeFileDb,
    offThreadUsable: (_d, key) => key === "agentToolCalls",
    runOffThread: async (_p, _n, windowDays) => {
      offCalls++;
      return { toolCalls: 42, windowDays };
    },
    computeSync: () => {
      syncCalls++;
      return { toolCalls: 1, windowDays: 30 };
    },
    now: () => offClock,
    syncTtlMs: 1,
    offThreadTtlMs: 3_600_000,
    retryAfterMs: 60_000,
    log: () => {},
  });
  off.prewarm();
  check("e6: prewarm() starts the off-thread refresh, and the figure is not ready before it lands", offCalls === 1 && off.snapshot().ready === false && offCalls === 1);
  await off.settled();
  const o1 = off.snapshot();
  const o2 = off.snapshot();
  check("e7: off-thread value served from cache, no second refresh, main thread never computes", o1.ready && o1.stats.toolCalls === 42 && o2.stats.toolCalls === 42 && offCalls === 1 && syncCalls === 0);
  offClock += 3_600_000;
  off.snapshot();
  await off.settled();
  check("e8: a stale value triggers one background refresh", offCalls === 2 && syncCalls === 0);
  db.close();

  return summary;
}

// Standalone runner
if (require.main === module) {
  runAgentplatformPartnersTests({ log: true }).then((s) => {
    console.log(`\nagentplatform-partners: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      for (const f of s.failures) console.error(`  FAILED: ${f}`);
      process.exit(1);
    }
  });
}
