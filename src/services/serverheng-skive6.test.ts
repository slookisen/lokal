/**
 * serverheng-skive6.test.ts — A2A dev-request
 * 2026-10-08-serverheng-hovedtraad-oppstart-statistikk-samtaler, skive 6.
 *
 *   S1–S3  GET /api/agents/:id/stats computation in the stats worker ("public"
 *          lane) is identical to the synchronous computation.
 *   S4     createMaxTouchStatusLookup (batched) answers exactly like
 *          getMaxTouchStatusForEmail (per address), incl. case/whitespace and
 *          non-ASCII letters that SQLite's LOWER() does not fold.
 *   S5     lowerCurrentThreadPriority: Linux-only, clamped, fail-soft.
 *   S6     a stats worker thread really runs at the lower priority while the
 *          main thread stays at 0 (Linux only).
 *
 * Run by tests/test.ts (sequential block, after offthread-stats).
 */
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  runStatsTaskOffThread,
  statsTaskLane,
  getOffThreadStatsState,
  __resetOffThreadStatsForTesting,
} from "./offthread-stats";
import { computeAgentStats, type AgentStatsPayload } from "./agent-stats-compute";
import {
  createMaxTouchStatusLookup,
  getMaxTouchStatusForEmail,
  type OutreachMaxTouchVernConfig,
} from "./outreach-max-touch-vern";
import { lowerCurrentThreadPriority, WORKER_THREAD_NICE } from "./thread-priority";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function sqliteAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString().replace("T", " ").slice(0, 19);
}

function threadNices(): number[] {
  const out: number[] = [];
  for (const tid of fs.readdirSync("/proc/self/task")) {
    try {
      const st = fs.readFileSync(`/proc/self/task/${tid}/stat`, "utf8");
      const after = st.slice(st.lastIndexOf(")") + 2).split(" ");
      out.push(Number(after[16]));
    } catch {
      // thread exited while listing
    }
  }
  return out;
}

export async function runServerhengSkive6Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function ok(cond: boolean, label: string, detail?: unknown): void {
    if (cond) {
      passed++;
      if (opts.log) console.log(`  ✓ ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
    }
  }

  // ── S1–S3: agent stats, worker vs synchronous ────────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skive6-"));
  const dbPath = path.join(tmp, "stats.db");
  const writer = new Database(dbPath);
  try {
    __resetOffThreadStatsForTesting();
    writer.pragma("journal_mode = WAL");
    writer.exec(`
      CREATE TABLE analytics_page_views (
        id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, session_id TEXT,
        created_at TEXT DEFAULT (datetime('now')), is_owner INTEGER DEFAULT 0,
        vertical_id TEXT NOT NULL DEFAULT 'rfb'
      );
      CREATE INDEX idx_analytics_page_views_created ON analytics_page_views(created_at);
      CREATE INDEX idx_analytics_page_views_path ON analytics_page_views(path);
      CREATE TABLE page_view_daily (
        day TEXT NOT NULL, path TEXT, vertical_id TEXT, bot_type TEXT, view_count INTEGER
      );
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, seller_agent_id TEXT, source TEXT, created_at TEXT,
        query_text TEXT, is_internal INTEGER, traffic_class TEXT
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, conversation_id TEXT, sender_role TEXT, content TEXT, created_at TEXT
      );
    `);
    const pagePath = "/produsent/testgarden";
    const ins = writer.prepare("INSERT INTO analytics_page_views (path, session_id, created_at, is_owner) VALUES (?,?,?,?)");
    // human-looking browser session with a few views, a GPTBot crawl, a
    // ClaudeBot crawl, an owner view, and a fast scraper-like session.
    for (let i = 0; i < 3; i++) ins.run(pagePath, "ip1:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36", sqliteAgo((i + 1) * 3_600_000), 0);
    ins.run(pagePath, "ip2:Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)", sqliteAgo(86_400_000), 0);
    ins.run(pagePath, "ip3:Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", sqliteAgo(2 * 86_400_000), 0);
    ins.run(pagePath, "ip4:desktop:owner", sqliteAgo(60_000), 1);
    const scraper = "ip5:Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    const base = Date.now() - 5 * 3_600_000;
    for (let i = 0; i < 25; i++) {
      ins.run(i === 0 ? pagePath : `/produsent/annen-${i}`, scraper, new Date(base + i * 5_000).toISOString().replace("T", " ").slice(0, 19), 0);
    }
    ins.run("/produsent/annen-side", "ip6:x", sqliteAgo(10_000), 0);
    writer.prepare("INSERT INTO page_view_daily (day, path, vertical_id, bot_type, view_count) VALUES (?,?,?,?,?)")
      .run(sqliteAgo(80 * 86_400_000).slice(0, 10), pagePath, "rfb", "chatgpt", 4);
    const conv = writer.prepare("INSERT INTO conversations (id, seller_agent_id, source, created_at, query_text, is_internal, traffic_class) VALUES (?,?,?,?,?,?,?)");
    conv.run("c1", "agent-1", "mcp", sqliteAgo(3_600_000), "Har dere epler?", 0, "external");
    conv.run("c2", "agent-1", "a2a", sqliteAgo(7_200_000), "", 0, "external");
    conv.run("c3", "agent-1", "mcp", sqliteAgo(9_000_000), "intern test", 1, "external");
    writer.prepare("INSERT INTO messages (id, conversation_id, sender_role, content, created_at) VALUES (?,?,?,?,?)")
      .run("m1", "c2", "buyer", "Selger dere honning?", sqliteAgo(7_200_000));

    const nowMs = Date.now();
    const expected = computeAgentStats(writer, "agent-1", pagePath, nowMs);
    const got = await runStatsTaskOffThread<AgentStatsPayload>(dbPath, { kind: "agentStats", agentId: "agent-1", path: pagePath, nowMs });
    ok(eq(got, expected), "S1: the worker computes exactly what the synchronous agent stats compute", { got, expected });
    ok(
      expected.conversationCount === 2 && expected.lastConversations.length === 2 && expected.aiBreakdown.chatgpt >= 5,
      "S2: the fixture exercises views, the rollup blend and conversations (non-trivial payload)",
      expected,
    );
    ok(statsTaskLane({ kind: "agentStats", agentId: "a", path: "/p", nowMs: 0 }) === "public", "S3a: agentStats runs in the public lane");
    ok(statsTaskLane({ kind: "trafficStats", windowDays: 60 }) === "background", "S3b: trafficStats stays in the background lane");
    const st = getOffThreadStatsState();
    ok(st.lanes.public !== undefined && st.lanes.public.workerRunning === true, "S3c: the public lane has its own running worker", st.lanes);

    // ── S6: the worker thread runs at the lower priority (Linux) ──────
    if (process.platform === "linux" && fs.existsSync("/proc/self/task")) {
      const nices = threadNices();
      ok(
        nices.includes(WORKER_THREAD_NICE) && os.getPriority(0) === 0,
        "S6: a stats worker thread runs at nice 10 while the main thread stays at 0",
        { nices, main: os.getPriority(0) },
      );
    } else {
      ok(true, "S6: skipped (not Linux)");
    }
  } catch (err) {
    ok(false, "S1–S3/S6: unexpected error", String((err as Error)?.stack || err));
  } finally {
    __resetOffThreadStatsForTesting();
    writer.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ── S4: batched max-touch lookup = per-address lookup ───────────────
  const mem = new Database(":memory:");
  try {
    mem.exec(`
      CREATE TABLE outreach_sent_log (id INTEGER PRIMARY KEY AUTOINCREMENT, recipient_email TEXT, sent_at TEXT, vertical_id TEXT);
      CREATE TABLE crm_contacts (id INTEGER PRIMARY KEY, email TEXT);
      CREATE TABLE crm_threads (id INTEGER PRIMARY KEY, contact_id INTEGER);
      CREATE TABLE crm_messages (id INTEGER PRIMARY KEY, thread_id INTEGER, direction TEXT);
    `);
    const send = mem.prepare("INSERT INTO outreach_sent_log (recipient_email, sent_at, vertical_id) VALUES (?,?,?)");
    send.run("post@gard.no", "2026-07-01 08:00:00", "rfb");
    send.run("POST@Gard.no", "2026-08-01 08:00:00", "rfb");
    send.run("post@gard.no", "2026-09-01 08:00:00", "experiences");
    send.run("svar@gard.no", "2026-07-01 08:00:00", "rfb");
    send.run("svar@gard.no", "2026-07-02 08:00:00", "rfb");
    send.run("svar@gard.no", "2026-07-03 08:00:00", "rfb");
    send.run("Øst@gard.no", "2026-07-01 08:00:00", "rfb");
    send.run(null, "2026-07-01 08:00:00", "rfb");
    mem.prepare("INSERT INTO crm_contacts (id, email) VALUES (?,?)").run(1, "SVAR@gard.no");
    mem.prepare("INSERT INTO crm_contacts (id, email) VALUES (?,?)").run(2, "post@gard.no");
    mem.prepare("INSERT INTO crm_contacts (id, email) VALUES (?,?)").run(3, null);
    mem.prepare("INSERT INTO crm_threads (id, contact_id) VALUES (?,?)").run(10, 1);
    mem.prepare("INSERT INTO crm_threads (id, contact_id) VALUES (?,?)").run(20, 2);
    mem.prepare("INSERT INTO crm_threads (id, contact_id) VALUES (?,?)").run(30, 3);
    mem.prepare("INSERT INTO crm_messages (id, thread_id, direction) VALUES (?,?,?)").run(100, 10, "in");
    mem.prepare("INSERT INTO crm_messages (id, thread_id, direction) VALUES (?,?,?)").run(200, 20, "out");
    mem.prepare("INSERT INTO crm_messages (id, thread_id, direction) VALUES (?,?,?)").run(300, 30, "in");
    const cfg: OutreachMaxTouchVernConfig = { enabled: true, threshold: 3, updated_at: null, updated_by: null, note: null, is_default: true } as OutreachMaxTouchVernConfig;
    const lookup = createMaxTouchStatusLookup(mem, cfg);
    const emails = ["post@gard.no", " Post@GARD.no ", "svar@gard.no", "SVAR@gard.no", "øst@gard.no", "Øst@gard.no", "ukjent@gard.no", ""];
    for (const e of emails) {
      const a = lookup(e);
      const b = getMaxTouchStatusForEmail(mem, e, cfg);
      ok(eq(a, b), `S4: batched max-touch = per-address for ${JSON.stringify(e)}`, { batched: a, perAddress: b });
    }
    ok(lookup("post@gard.no").send_count === 3 && lookup("post@gard.no").suppressed === true, "S4b: case-folded sends across verticals are summed (3 ≥ threshold, no reply)");
    ok(lookup("svar@gard.no").has_inbound_ever === true && lookup("svar@gard.no").suppressed === false, "S4c: an inbound reply lifts the suppression");
  } catch (err) {
    ok(false, "S4: unexpected error", String((err as Error)?.stack || err));
  } finally {
    mem.close();
  }

  // ── S5: lowerCurrentThreadPriority ───────────────────────────────────
  {
    const calls: Array<[number, number]> = [];
    const setP = (pid: number, prio: number) => { calls.push([pid, prio]); };
    ok(lowerCurrentThreadPriority(10, { platform: "darwin", setPriority: setP, getPriority: () => 0 }) === null && calls.length === 0, "S5a: no-op outside Linux");
    ok(lowerCurrentThreadPriority(10, { platform: "linux", env: { WORKER_THREAD_NICE_DISABLED: "1" }, setPriority: setP, getPriority: () => 0 }) === null && calls.length === 0, "S5b: kill switch");
    ok(lowerCurrentThreadPriority(10, { platform: "linux", env: {}, setPriority: setP, getPriority: () => 10 }) === 10 && eq(calls, [[0, 10]]), "S5c: sets the calling thread (pid 0) to the given nice", calls);
    calls.length = 0;
    lowerCurrentThreadPriority(25, { platform: "linux", env: {}, setPriority: setP, getPriority: () => 19 });
    ok(eq(calls, [[0, 19]]), "S5d: clamped to 19", calls);
    ok(lowerCurrentThreadPriority(10, { platform: "linux", env: {}, setPriority: () => { throw new Error("EACCES"); }, getPriority: () => 0 }) === null, "S5e: a failing setpriority is swallowed");
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runServerhengSkive6Tests({ log: true }).then((r) => {
    console.log(`serverheng-skive6: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
