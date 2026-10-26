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
  formatOsloStamp,
  renderPartners,
  type AgentCallReading,
  type TrafficReading,
} from "./agentplatform-site";
import { computeAgentToolCalls } from "../services/agent-usage-compute";
import { AGENT_USAGE_OFFTHREAD_TTL_MS, AGENT_USAGE_PREWARM_INTERVAL_MS, createAgentUsageReader } from "../services/agent-usage";
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
  // The 12-month block per service (dev-request 2026-10-22-statistikk-samme-tall-12-mnd, S2).
  const yr = (visits: number, views: number, ai: number, crawler: number, deliv: number, since: string | null, delivSince: string | null): TrafficReading["year"] => ({
    humanVisits: { value: visits, since }, humanViews: { value: views, since }, aiSearch: { value: ai, since },
    aiCrawlerViews: { value: crawler, since }, aiDeliveries: { value: deliv, since: delivSince },
  });
  const traffic: Record<string, TrafficReading> = {
    rfb: { year: yr(61_234, 80_000, 6_805, 140_999, 12_490, "2026-08-14", "2026-10-26") },
    experiences: { year: yr(9_100, 12_000, 900, 13_400, 300, "2026-08-14", "2026-10-26") },
    dental: { year: yr(7_050, 9_000, 500, 7_700, 210, "2026-08-14", "2026-10-26") },
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
    check("b2: human visits 77 384 → 77 000+ with the strip's name and «siden <dato>»", nb.body.includes("<strong>77 000+</strong><span class=\"m-label\">Besøk fra mennesker</span><span class=\"m-period\">siden 14. aug. 2026</span>"));
    check("b3: AI-crawler views 162 099 → 162 000+, 12-month block", nb.body.includes("<strong>162 000+</strong><span class=\"m-label\">AI-crawlere</span><span class=\"m-period\">siden 14. aug. 2026</span>"));
    check("b3b: «Med i AI-søk» platform number 13 000+ from its own start date; AI-søk and human page views too",
      nb.body.includes("<strong>13 000+</strong><span class=\"m-label\">Med i AI-søk</span><span class=\"m-period\">siden 26. okt. 2026</span>") &&
      nb.body.includes("<strong>8 200+</strong><span class=\"m-label\">AI-søk</span>") &&
      nb.body.includes("<strong>101 000+</strong><span class=\"m-label\">Sidevisninger fra mennesker</span>"));
    check("b3c: English names and periods", en.body.includes("<span class=\"m-label\">In AI searches</span><span class=\"m-period\">since 26 Oct 2026</span>") && en.body.includes("<span class=\"m-label\">Visits by people</span>"));
    check("b3d: no 60-day traffic label left, no «Med i AI-svar»", !/siste 60 dager|last 60 days|Med i AI-svar/.test(nb.body + en.body));
    check("b4: agent tool calls 5 527 → 5 500+ with 30-day label", nb.body.includes("<strong>5 500+</strong><span class=\"m-label\">verktøykall fra AI-agenter siste 30 dager</span>"));
    check("b5: every tile has a definition", (nb.body.match(/class="m-def"/g) || []).length === 7);
    check("b5b: the tool-call definition names what is counted (incl. cart and ordering)", nb.body.includes("søk, oppslag, handlekurv og bestilling") && en.body.includes("search, lookup, cart and ordering"));
    check("b6: floorForTile rounds down", floorForTile(162_099) === 162_000 && floorForTile(5_527) === 5_500 && floorForTile(812) === 812 && floorForTile(10_999) === 10_000);
    check("b7: never 'AI-brukere' / 'AI users'", !/AI-brukere|AI users/i.test(nb.body + en.body));

    const partial = collectPlatformMetrics(
      { readTraffic: (v) => (v === "dental" ? null : traffic[v]), readAgentCalls: () => null },
      { rfb: 1560, experiences: 563, dental: 5446 },
    );
    check("b8: a service without traffic data hides every traffic sum", Object.values(partial.year).every((c) => c === null));
    check("b9: no agent reading → no agent figure", partial.agentToolCalls === null);
    const partialHtml = renderPartners("nb", partial);
    check("b10: hidden figures render no tile (only the catalog)", (partialHtml.match(/class="metric"/g) || []).length === 1 && !partialHtml.includes("Besøk fra mennesker"));
    const zero = collectPlatformMetrics(
      { readTraffic: () => ({ year: yr(0, 0, 0, 0, 0, null, null) }), readAgentCalls: () => ({ toolCalls: 0, windowDays: 30 }) },
      { rfb: null, experiences: 563, dental: 5446 },
    );
    const zeroHtml = renderPartners("nb", zero);
    check("b11: zeros and a missing catalog count hide the whole figures band", !zeroHtml.includes('id="tall"') && !zeroHtml.includes('href="#tall"'));
    const mixedSince = collectPlatformMetrics(
      { readTraffic: (v) => ({ year: v === "rfb" ? yr(10, 10, 10, 10, 10, null, null) : yr(5, 5, 5, 5, 5, "2026-09-01", "2026-10-26") }), readAgentCalls: () => agent },
      { rfb: 1, experiences: 1, dental: 1 },
    );
    check("b12: start dates that differ: the sum is labelled with the latest one (the first day all three have data)",
      mixedSince.year.humanVisits?.value === 20 && mixedSince.year.humanVisits?.since === "2026-09-01" && mixedSince.year.aiDeliveries?.since === "2026-10-26");
    const fullYear = collectPlatformMetrics({ readTraffic: () => ({ year: yr(1, 1, 1, 1, 1, null, null) }), readAgentCalls: () => null }, { rfb: 1, experiences: 1, dental: 1 });
    check("b12b: all three over the whole year → «siste 12 måneder»", fullYear.year.humanViews?.since === null && renderPartners("nb", fullYear).includes("<span class=\"m-period\">siste 12 måneder</span>"));
    const noYear = collectPlatformMetrics({ readTraffic: (v) => (v === "dental" ? { year: null } : traffic[v]), readAgentCalls: () => null }, { rfb: 1, experiences: 1, dental: 1 });
    check("b12c: a service whose 12-month block is missing hides the sums (never a partial sum)", Object.values(noYear.year).every((c) => c === null));

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

  // computedAt: when the value was computed, not when it was read.
  const syncComputedAt = clock;
  const c1 = reader.snapshot();
  clock += 1_000;
  const c2 = reader.snapshot();
  check("e9: sync snapshot carries its compute time, unchanged on a cached read", c1.computedAt === syncComputedAt && c2.computedAt === syncComputedAt);
  const landedAt = offClock;
  offClock += 5_000;
  const o3 = off.snapshot();
  check("e10: off-thread snapshot carries the time the value landed, not the read time", o3.ready && o3.computedAt === landedAt);
  check("e11: the tool-call figure refreshes hourly", AGENT_USAGE_OFFTHREAD_TTL_MS === 60 * 60_000);
  // The boot-time interval calls prewarm(): a fresh value is left alone, a stale one refreshes once.
  const beforeTick = offCalls;
  off.prewarm();
  const freshTick = offCalls;
  offClock += AGENT_USAGE_OFFTHREAD_TTL_MS;
  off.prewarm();
  await off.settled();
  check("e12: prewarm() refreshes only a stale value, so the interval keeps the figure hourly without visitors",
    freshTick === beforeTick && offCalls === beforeTick + 1 && AGENT_USAGE_PREWARM_INTERVAL_MS < AGENT_USAGE_OFFTHREAD_TTL_MS);
  db.close();

  // ── (f) «Oppdatert …» under the figures ──────────────────────────────
  const T0 = Date.UTC(2026, 9, 11, 12, 50); // 14.50 in Oslo (CEST)
  check("f1: Oslo stamp, summer time (nb/en)", formatOsloStamp(T0, "nb") === "11. oktober kl. 14.50" && formatOsloStamp(T0, "en") === "11 October, 14:50");
  check("f2: Oslo stamp, winter time and zero-padded minutes", formatOsloStamp(Date.UTC(2026, 11, 1, 13, 5), "nb") === "1. desember kl. 14.05");
  const stampedTraffic = (at: number) => (v: string) => ({ ...traffic[v], computedAt: at + (v === "dental" ? 60_000 : 0) });
  const stamped = collectPlatformMetrics(
    { readTraffic: stampedTraffic(T0 + 120_000), readAgentCalls: () => ({ ...agent, computedAt: T0 }) },
    counts as any,
    T0 + 300_000,
  );
  check("f3: updatedAt is the oldest compute time among the shown figures", stamped.updatedAt === T0, String(stamped.updatedAt));
  const hiddenOld = collectPlatformMetrics(
    { readTraffic: stampedTraffic(T0 + 120_000), readAgentCalls: () => ({ toolCalls: 0, windowDays: 30, computedAt: T0 - 86_400_000 }) },
    counts as any,
    T0 + 300_000,
  );
  check("f4: a hidden figure's timestamp does not count", hiddenOld.agentToolCalls === null && hiddenOld.updatedAt === T0 + 120_000, String(hiddenOld.updatedAt));
  const unstamped = collectPlatformMetrics({ readTraffic: (v) => traffic[v], readAgentCalls: () => ({ ...agent, computedAt: T0 }) }, counts as any, T0);
  const nothing = collectPlatformMetrics({ readTraffic: () => null, readAgentCalls: () => null }, { rfb: null, experiences: null, dental: null }, T0);
  check("f5: no stamp when a shown figure has no timestamp, or nothing is shown", unstamped.updatedAt === null && nothing.updatedAt === null);
  const stampHtmlNb = renderPartners("nb", stamped);
  const stampHtmlEn = renderPartners("en", stamped);
  check("f6: the stamp renders under the tiles with a machine-readable time (nb/en)",
    stampHtmlNb.includes('<p class="m-updated"><time datetime="2026-10-11T12:50:00.000Z">Oppdatert 11. oktober kl. 14.50</time></p>') &&
      stampHtmlEn.includes('<time datetime="2026-10-11T12:50:00.000Z">Updated 11 October, 14:50 (Norwegian time)</time>'));
  check("f7: no stamp line without a timestamp", !renderPartners("nb", unstamped).includes('class="m-updated"'));

  // Through the router: the count cache's own read time takes part.
  const stampRouter = createAgentplatformRouter({
    readCount: (v) => counts[v] ?? null,
    readTraffic: stampedTraffic(T0 + 120_000),
    readAgentCalls: () => ({ ...agent, computedAt: T0 + 60_000 }),
    now: () => T0 + 600_000,
  });
  const stampApp = express();
  stampApp.set("trust proxy", true);
  stampApp.use(createAgentplatformHostGate(stampRouter));
  const stampServer = http.createServer(stampApp);
  await new Promise<void>((r) => stampServer.listen(0, "127.0.0.1", () => r()));
  try {
    const stampPort = (stampServer.address() as any).port;
    const page = await new Promise<string>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port: stampPort, path: "/partnere", headers: { host: "agentplatform.no" } }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        })
        .on("error", reject);
    });
    check("f8: /partnere shows the oldest figure's time (tool calls, 14.51)", page.includes("Oppdatert 11. oktober kl. 14.51</time>"));
  } finally {
    await new Promise<void>((r) => stampServer.close(() => r()));
  }

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
