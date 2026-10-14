/**
 * ai-lookups.test.ts — dev-request 2026-10-13-statistikk-riktig-for-investorer, S7
 * (Daniel 2026-10-14: «Ta med MCP/A2A i AI-søk, vis crawlere separat»).
 *
 * Covers:
 *   (a) computeAiLookups: MCP calls to our data tools count; handshakes and
 *       catalogue health checks (initialize, tools/list, notifications/…,
 *       ping, server/discover) and unknown methods do not; A2A requests count
 *       only with countable = 1 (rows without the verdict cannot be told from
 *       spam); owner rows, 4xx/5xx answers, other verticals and rows outside
 *       the window are left out.
 *   (b) computeQueryStats counts an A2A search only with countable = 1.
 *   (c) computeTrafficStats: aiSearchTotal = aiSearchViews + aiLookups, and
 *       humanViews + aiSearchViews + aiCrawlerViews + otherBotViews = pageViews.
 *   (d) mcp-usage-logger.ts stores the A2A verdict a handler leaves in
 *       res.locals.a2aCountable (1/0), NULL for MCP calls and for A2A calls
 *       that never reached the verdict.
 *
 * Exported runAiLookupsTests({log}) -> Promise<TestSummary>; wired into
 * tests/test.ts. Standalone: npx tsx src/services/ai-lookups.test.ts
 */

import Database from "better-sqlite3";
import express from "express";
import * as http from "http";
import type { AddressInfo } from "net";
import * as initMod from "../database/init";
import { computeAiLookups, computeQueryStats } from "./search-stats-compute";
import { computeTrafficStats } from "./traffic-stats-compute";
import { mcpUsageLogger } from "./mcp-usage-logger";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function ts(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export async function runAiLookupsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const ok = (cond: boolean, label: string, detail?: unknown) => {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}${detail === undefined ? "" : `\n    ${JSON.stringify(detail)}`}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  };
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  // ── (a)–(c) on a hand-built window ──────────────────────────────────
  {
    const db = new Database(":memory:");
    initMod.__initSchemaForTesting(db as any);
    const now = Date.UTC(2026, 9, 14, 12, 0, 0);
    const H = 3600_000;
    const call = db.prepare(`
      INSERT INTO analytics_mcp_calls (protocol, vertical_id, tool_name, client_name, user_agent, ip_hash, is_owner, status_code, countable, created_at)
      VALUES (?, ?, ?, 'c', 'ua', 'ip', ?, ?, ?, ?)
    `);
    const at = ts(now - 2 * H);
    // MCP data tools: counted (3 rfb, 1 dental, 1 experiences).
    call.run("mcp", "rfb", "lokal_search", 0, 200, null, at);
    call.run("mcp", "rfb", "lokal_info", 0, 200, null, at);
    call.run("mcp", "rfb", "resources/read", 0, 200, null, at);
    call.run("mcp", "dental", "tannlege_search", 0, 200, null, at);
    call.run("mcp", "experiences", "get_experience", 0, null, null, at); // legacy row without status
    // MCP handshakes, health checks and junk: not counted.
    for (const t of ["initialize", "tools/list", "notifications/initialized", "ping", "server/discover", "resources/list", "sandbox.execute_shell", "lokalxsearch"]) {
      call.run("mcp", "rfb", t, 0, 200, null, at);
    }
    // Our own traffic and error answers: not counted.
    call.run("mcp", "rfb", "lokal_search", 1, 200, null, at);
    call.run("mcp", "rfb", "lokal_search", 0, 429, null, at);
    // Outside a 24 h window.
    call.run("mcp", "rfb", "lokal_search", 0, 200, null, ts(now - 30 * H));
    // A2A: only countable = 1.
    call.run("a2a", "rfb", "message/send", 0, 200, 1, at);
    call.run("a2a", "rfb", "SendMessage", 0, 200, 1, at);
    call.run("a2a", "rfb", "message/send", 0, 200, 0, at); // spam/probe/no intent
    call.run("a2a", "rfb", "message/send", 0, 200, null, at); // written before the verdict
    call.run("a2a", "rfb", "tasks/get", 0, 200, 1, at); // not a request
    call.run("a2a", "rfb", "message/send", 1, 200, 1, at); // our own
    // Agent card fetches: not lookups.
    call.run("agent_card", "rfb", null, 0, 200, null, at);

    const all = computeAiLookups(db as any, 24, undefined, now);
    ok(eq(all, { mcp: 5, a2a: 2, total: 7 }), "a1: data tools and countable A2A requests count; handshakes, junk, owner, 4xx, old rows, NULL/0 verdicts and agent cards do not", all);
    ok(eq(computeAiLookups(db as any, 24, "rfb", now), { mcp: 3, a2a: 2, total: 5 }), "a2: the vertical filter keeps rfb's rows only", computeAiLookups(db as any, 24, "rfb", now));
    ok(computeAiLookups(db as any, 48, undefined, now).mcp === 6, "a3: a 48 h window takes the 30 h-old call too");

    const q = computeQueryStats(db as any, 24, undefined, now);
    ok(q.byChannel?.a2a === 2 && q.byChannel?.mcp === 2, "b1: search stats count an A2A search only with countable = 1 (MCP search tools: lokal_search, tannlege_search)", q.byChannel);
    ok(eq(q.aiLookups, all), "b2: query stats carry the same AI lookups", q.aiLookups);

    // Page views for (c): 3 people, 2 AI search pages, 4 AI crawler pages, 1 search engine page.
    const pv = db.prepare(`INSERT INTO analytics_page_views (path, session_id, is_owner, status_code, vertical_id, created_at, client_class) VALUES ('/', ?, 0, 200, 'rfb', ?, ?)`);
    for (let i = 0; i < 3; i++) pv.run(`ipP${i}:desktop:p${i}`, at, "human");
    for (let i = 0; i < 2; i++) pv.run(`ipA${i}:Mozilla/5.0 (compatible; ChatGPT-User/1.0)`, at, "ai_search");
    for (let i = 0; i < 4; i++) pv.run(`ipC${i}:Mozilla/5.0 (compatible; GPTBot/1.2)`, at, "ai_crawler");
    pv.run("ipG:Mozilla/5.0 (compatible; Googlebot/2.1)", at, "search_engine");
    const t = computeTrafficStats(db as any, "rfb", 1, now);
    ok(t.aiSearchViews === 2 && t.aiLookups === 5 && t.aiSearchTotal === 7,
      "c1: «AI-søk» = AI search pages + MCP/A2A lookups (rfb)", { aiSearchViews: t.aiSearchViews, aiLookups: t.aiLookups, aiSearchTotal: t.aiSearchTotal });
    ok(t.aiCrawlerViews === 4 && t.otherBotViews === 1 && t.humanViews + t.aiSearchViews + t.aiCrawlerViews + t.otherBotViews === t.pageViews,
      "c2: AI crawlers on their own; people + AI search pages + AI crawlers + other bots = page views", t);
    db.close();
  }

  // ── (d) the logger stores the A2A verdict ───────────────────────────
  {
    const prev = initMod.__peekDbForTesting();
    const db = new Database(":memory:");
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    let server: http.Server | undefined;
    try {
      const app = express();
      app.use(express.json());
      app.use("/a2a", mcpUsageLogger("a2a", "rfb"), (req, res) => {
        const verdict = req.headers["x-verdict"];
        if (verdict === "yes") res.locals.a2aCountable = true;
        if (verdict === "no") res.locals.a2aCountable = false;
        res.json({ jsonrpc: "2.0", id: 1, result: {} });
      });
      app.use("/mcp", mcpUsageLogger("mcp", "rfb"), (_req, res) => { res.json({ jsonrpc: "2.0", id: 1, result: {} }); });
      server = await new Promise<http.Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
      const port = (server.address() as AddressInfo).port;
      const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
        fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then((r) => r.text());
      await post("/a2a", { jsonrpc: "2.0", id: 1, method: "message/send", params: {} }, { "x-verdict": "yes" });
      await post("/a2a", { jsonrpc: "2.0", id: 2, method: "message/send", params: {} }, { "x-verdict": "no" });
      await post("/a2a", { jsonrpc: "2.0", id: 3, method: "tasks/get", params: {} });
      await post("/mcp", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "lokal_search" } });
      await new Promise((r) => setTimeout(r, 30));
      const rows = db.prepare("SELECT protocol, tool_name, countable FROM analytics_mcp_calls ORDER BY id").all();
      ok(eq(rows, [
        { protocol: "a2a", tool_name: "message/send", countable: 1 },
        { protocol: "a2a", tool_name: "message/send", countable: 0 },
        { protocol: "a2a", tool_name: "tasks/get", countable: null },
        { protocol: "mcp", tool_name: "lokal_search", countable: null },
      ]), "d1: the A2A verdict is stored with the call (1/0); NULL without one and for MCP", rows);
    } finally {
      if (server) await new Promise((r) => server!.close(() => r(null)));
      initMod.__setDbForTesting(prev as any);
      db.close();
    }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runAiLookupsTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed ? 1 : 0);
  });
}
