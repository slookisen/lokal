/**
 * analytics-partner-report.test.ts — GET /admin/analytics/partner-report,
 * SLICE 1 (dev-request 2026-10-03-partner-effektrapport-per-gaard): contact
 * clicks per agent. Covers auth (401/503), 400 validation, numbers equal to
 * owner-stats' contact-click groups for the same window, CSV == JSON, umbrella
 * resolution, bot exclusion, and that no session_id/IP/UA leaks.
 *
 * Run standalone: npx tsx src/routes/analytics-partner-report.test.ts
 * Wired into tests/test.ts via runAnalyticsPartnerReportTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined, text: undefined, headers: {} };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k.toLowerCase()] = v; };
  r.send = (t: string) => { r.text = t; return r; };
  return r;
}

export async function runAnalyticsPartnerReportTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    }
  }

  const { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } = require("../database/init") as
    typeof import("../database/init");
  const Database = require("better-sqlite3");
  const { getOwnerStats, ownerStatsWindowDays } = require("../services/owner-stats-service") as
    typeof import("../services/owner-stats-service");

  const prevDb = __peekDbForTesting();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsKey = process.env.ANALYTICS_ADMIN_KEY;

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = OFF");

  try {
    __setDbForTesting(db);
    __initSchemaForTesting(db);
    process.env.ADMIN_KEY = "partner-report-test-key";
    delete process.env.ANALYTICS_ADMIN_KEY;

    const routePath = require.resolve("./analytics");
    async function call(query: Record<string, string>, key: string | null = "partner-report-test-key") {
      delete require.cache[routePath];
      const router = (require("./analytics") as typeof import("./analytics")).default as any;
      const res = fakeRes();
      const headers: Record<string, string> = key === null ? {} : { "x-admin-key": key };
      const req: any = {
        method: "GET", url: "/partner-report", query, headers, hostname: "",
        get(n: string) { return this.headers[n.toLowerCase()]; },
      };
      await new Promise<void>((resolve) => {
        res.json = function (b: any) { this.body = b; resolve(); return this; };
        res.send = function (t: string) { this.text = t; resolve(); return this; };
        router.handle(req, res, () => resolve());
      });
      return res;
    }

    const insAgent = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, umbrella_type)
       VALUES (?, ?, 'd', 'p', 'a@b.no', 'http://x', 'producer', ?, ?)`,
    );
    insAgent.run("pr-a", "Gard A", "k-a", null);
    insAgent.run("pr-b", "Gard B", "k-b", null);
    insAgent.run("pr-c", "Gard C", "k-c", null);
    insAgent.run("pr-umb", "Paraply", "k-u", "market_network");
    db.prepare(`INSERT INTO agent_affiliations (producer_id, umbrella_id, status, source) VALUES ('pr-a','pr-umb','active','admin')`).run();
    db.prepare(`INSERT INTO agent_affiliations (producer_id, umbrella_id, status, source) VALUES ('pr-b','pr-umb','active','admin')`).run();
    db.prepare(`INSERT INTO agent_affiliations (producer_id, umbrella_id, status, source) VALUES ('pr-c','pr-umb','rejected','admin')`).run();

    const ins = db.prepare(
      `INSERT INTO contact_clicks (agent_id, kind, session_id, is_bot, utm_source, created_at) VALUES (?, ?, ?, ?, ?, datetime('now', ?))`,
    );
    ins.run("pr-a", "website", "SECRET-SESSION-1", 0, "chatgpt.com", "-1 days");
    ins.run("pr-a", "website", "SECRET-SESSION-2", 0, null, "-2 days");
    ins.run("pr-a", "phone", "SECRET-SESSION-3", 0, "google", "-3 days");
    ins.run("pr-a", "email", "SECRET-SESSION-4", 1, null, "-1 days"); // bot: excluded
    ins.run("pr-a", "website", "SECRET-SESSION-5", 0, null, "-200 days"); // outside 30 d
    ins.run("pr-b", "external:vipps", "SECRET-SESSION-6", 0, "chatgpt.com", "-5 days");
    ins.run("pr-b", "website", "SECRET-SESSION-7", 0, null, "-5 days");
    // pr-c: no clicks

    // ── auth ──
    assertEq((await call({ agentIds: "pr-a" }, null)).statusCode, 401, "1a: no X-Admin-Key -> 401");
    assertEq((await call({ agentIds: "pr-a" }, "wrong")).statusCode, 401, "1b: wrong key -> 401");

    // ── JSON shape + numbers ──
    const ok = await call({ agentIds: "pr-a,pr-b,pr-c", days: "30" });
    assertEq(ok.statusCode, 200, "2a: valid request -> 200");
    const body = ok.body;
    assertEq(body.agents.map((a: any) => a.agent_id), ["pr-a", "pr-b", "pr-c"], "2b: one row per agent, input order");
    assertEq(body.window, { days: 30, from: null, to: null }, "2c: window echoed");
    assertEq(typeof body.generated_at, "string", "2d: generated_at present");
    assertEq(body.agents[0].clicks_by_kind, { website: 2, phone: 1 }, "2e: pr-a kinds (bot + out-of-window excluded)");
    assertEq(body.agents[0].clicks_total, 3, "2f: pr-a total");
    assertEq(Object.entries(body.agents[0].clicks_by_utm_source).sort(), [["(none)", 1], ["chatgpt.com", 1], ["google", 1]], "2g: pr-a utm breakdown");
    assertEq(body.agents[2].clicks_total, 0, "2h: agent without clicks -> zero row");
    assertEq(body.total.clicks_total, 5, "2i: total row sums agents");
    assertEq(body.total.clicks_by_kind, { website: 3, phone: 1, "external:vipps": 1 }, "2j: total by kind");
    assertEq(body.total.agent_count, 3, "2k: total agent_count");
    assertEq("views_by_class" in body.agents[0] || "discoveries_by_channel" in body.agents[0], false, "2l: slice 2/3 fields omitted");
    const raw = JSON.stringify(body);
    assertEq(/SECRET-SESSION|session_id|ip_hash|user_agent/i.test(raw), false, "2m: no session_id / IP / UA in response");

    // ── matches owner-stats for the same window ──
    {
      const win = ownerStatsWindowDays();
      const r = await call({ agentIds: "pr-a,pr-b", days: String(Math.min(win, 365)) });
      const os = getOwnerStats(db, "pr-a", "/produsent/gard-a").contactClicksByKind;
      const mine = Object.entries(r.body.agents[0].clicks_by_kind).map(([kind, count]) => ({ kind, count }));
      const norm = (x: Array<{ kind: string; count: number }>) => [...x].sort((a, b) => a.kind.localeCompare(b.kind));
      assertEq(norm(mine as any), norm(os), "3a: pr-a per-kind numbers == owner-stats contactClicksByKind");
      const osB = getOwnerStats(db, "pr-b", "/produsent/gard-b").contactClicksByKind;
      const mineB = Object.entries(r.body.agents[1].clicks_by_kind).map(([kind, count]) => ({ kind, count }));
      assertEq(norm(mineB as any), norm(osB), "3b: pr-b per-kind numbers == owner-stats contactClicksByKind");
    }

    // ── from/to window ──
    {
      const day = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
      const r = await call({ agentIds: "pr-a", from: day(10), to: day(0) });
      assertEq(r.statusCode, 200, "4a: from/to -> 200");
      assertEq(r.body.agents[0].clicks_total, 3, "4b: from/to window counts same 3 clicks");
      assertEq(r.body.window.from, day(10), "4c: window.from echoed");
    }

    // ── umbrella ──
    {
      const r = await call({ umbrella: "pr-umb" });
      assertEq(r.statusCode, 200, "5a: umbrella -> 200");
      assertEq(r.body.agents.map((a: any) => a.agent_id), ["pr-a", "pr-b"], "5b: only active members");
      assertEq((await call({ umbrella: "nope" })).statusCode, 404, "5c: unknown umbrella -> 404");
      assertEq((await call({ umbrella: "pr-a" })).statusCode, 404, "5d: non-umbrella agent id -> 404");
    }

    // ── CSV == JSON ──
    {
      const csv = await call({ agentIds: "pr-a,pr-b,pr-c", days: "30", format: "csv" });
      assertEq(csv.statusCode, 200, "6a: csv -> 200");
      assertEq(String(csv.headers["content-type"]).startsWith("text/csv"), true, "6b: csv content-type");
      const lines = String(csv.text).trim().split("\n");
      assertEq(lines[0], "agent_id,name,dimension,key,count", "6c: csv header");
      const get = (id: string, dim: string, key: string) => {
        const l = lines.find((x) => x.startsWith(`${id},`) && x.split(",")[2] === dim && x.split(",")[3] === key);
        return l ? Number(l.split(",")[4]) : undefined;
      };
      assertEq(get("pr-a", "clicks_by_kind", "website"), body.agents[0].clicks_by_kind.website, "6d: csv pr-a website == json");
      assertEq(get("pr-b", "clicks_by_kind", "external:vipps"), body.agents[1].clicks_by_kind["external:vipps"], "6e: csv pr-b external == json");
      assertEq(get("pr-a", "clicks_total", ""), body.agents[0].clicks_total, "6f: csv pr-a total == json");
      assertEq(get("TOTAL", "clicks_total", ""), body.total.clicks_total, "6g: csv TOTAL == json total");
      assertEq(get("pr-a", "clicks_by_utm_source", "chatgpt.com"), 1, "6h: csv utm == json");
    }

    // ── validation -> 400 ──
    {
      assertEq((await call({})).statusCode, 400, "7a: neither agentIds nor umbrella -> 400");
      assertEq((await call({ agentIds: "pr-a", umbrella: "pr-umb" })).statusCode, 400, "7b: both -> 400");
      assertEq((await call({ agentIds: "pr-a", days: "abc" })).statusCode, 400, "7c: non-numeric days -> 400");
      assertEq((await call({ agentIds: "pr-a", days: "366" })).statusCode, 400, "7d: days > 365 -> 400");
      assertEq((await call({ agentIds: "pr-a", days: "0" })).statusCode, 400, "7e: days 0 -> 400");
      assertEq((await call({ agentIds: "pr-a", from: "2026-01-01" })).statusCode, 400, "7f: from without to -> 400");
      assertEq((await call({ agentIds: "pr-a", from: "2026-02-30", to: "2026-03-01" })).statusCode, 400, "7g: impossible date -> 400");
      assertEq((await call({ agentIds: "pr-a", from: "2026-03-02", to: "2026-03-01" })).statusCode, 400, "7h: from > to -> 400");
      assertEq((await call({ agentIds: "pr-a", days: "5", from: "2026-01-01", to: "2026-01-02" })).statusCode, 400, "7i: days + from/to -> 400");
      assertEq((await call({ agentIds: "pr-a", format: "xml" })).statusCode, 400, "7j: unknown format -> 400");
      assertEq((await call({ agentIds: "pr-a,'; DROP TABLE agents;--" })).statusCode, 400, "7k: malformed id -> 400");
      const many = Array.from({ length: 501 }, (_, i) => "id" + i).join(",");
      assertEq((await call({ agentIds: many })).statusCode, 400, "7l: >500 agentIds -> 400");
      const maxOk = Array.from({ length: 500 }, (_, i) => "id" + i).join(",");
      assertEq((await call({ agentIds: maxOk })).statusCode, 200, "7m: exactly 500 agentIds -> 200");
    }
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsKey;
    __setDbForTesting(prevDb as any);
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runAnalyticsPartnerReportTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0);
  });
}
