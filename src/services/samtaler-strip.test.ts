/**
 * samtaler-strip.test.ts — dev-request 2026-10-08-serverheng-hovedtraad-oppstart-
 * statistikk-samtaler (A2A), skive 4: /samtaler's referral strip in the stats
 * worker with SWR, finished HTML cached per kilde, conversations index built in
 * the night window.
 *
 *   E1–E5   the strip computed by the new path (own domains filtered in SQL,
 *           INDEXED BY) equals the old synchronous computation (verbatim copy
 *           of getHumanReferralPatterns' read + aggregateHumanReferrals) on
 *           seeded data, for every vertical; the SQL own-domain filter agrees
 *           with classifyReferralSource row by row
 *   W1–W2   the real worker (admin lane) returns the same strip; SWR timing
 *           (30 min TTL / 60 min max stale) of the strip reader
 *   C1–C3   createHtmlCache: TTL, expiry, bounded
 *   R1–R6   GET /samtaler on a real Express app with injected reader + cache:
 *           worker failure → 503 (reader called, no sync strip); worker answer
 *           → strip rendered; second request within the TTL served from the
 *           HTML cache byte-identical; kilde variants cached separately;
 *           unknown kilde never cached
 *   N1–N5   conversations(vertical_id, updated_at) is not created by the schema
 *           init, is built by ensureNightIndexes, idempotently, and columns exist
 *
 * No process.env mutation across an await. Exported runSamtalerStripTests({log});
 * standalone: npx tsx src/services/samtaler-strip.test.ts
 */

import Database from "better-sqlite3";
import express from "express";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import { __initSchemaForTesting, __pinInMemoryDbForTesting } from "../database/init";
import { slugify } from "../utils/slug";
import {
  aggregateHumanReferrals,
  classifyReferralSource,
  externalReferrerSqlFilter,
  type HumanReferralPattern,
  type HumanReferralRow,
} from "./human-referrals";
import { computeHumanReferralPatterns } from "./admin-stats-compute";
import { createAdminStatsReader } from "./admin-stats";
import { __resetOffThreadStatsForTesting, runStatsTaskOffThread } from "./offthread-stats";
import {
  createHtmlCache,
  HTML_CACHE_APP_KEY,
  STRIP_READER_APP_KEY,
  STRIP_TTL_MS,
  STRIP_MAX_STALE_MS,
  STRIP_HOURS_BACK,
} from "./samtaler-strip";
import { ensureNightIndexes, NIGHT_INDEXES } from "./night-indexes";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function sqliteTs(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

/** The pre-skive-4 computation: AnalyticsService.getHumanReferralPatterns, on an explicit handle. */
function oldHumanReferralPatterns(db: Database.Database, hoursBack: number, nowMs: number, vertical?: string): HumanReferralPattern[] {
  const cutoff = sqliteTs(nowMs - hoursBack * 60 * 60 * 1000);
  const V = vertical ? " AND vertical_id = ?" : "";
  const vp: string[] = vertical ? [vertical] : [];
  const rows = db.prepare(`
    SELECT referrer, path, session_id, is_owner
    FROM analytics_page_views
    WHERE created_at > ?
      AND (is_owner IS NULL OR is_owner = 0)
      AND referrer IS NOT NULL AND TRIM(referrer) != ''${V}
  `).all(cutoff, ...vp) as HumanReferralRow[];
  if (rows.length === 0) return [];
  const producerNameBySlug = new Map<string, string>();
  const agents = db.prepare(`SELECT name FROM agents`).all() as Array<{ name: string }>;
  for (const a of agents) {
    if (!a.name) continue;
    const s = slugify(a.name);
    if (s && !producerNameBySlug.has(s)) producerNameBySlug.set(s, a.name);
  }
  return aggregateHumanReferrals(rows, { producerNameBySlug });
}

const REFERRERS = [
  "https://www.google.com/search?q=egg", "https://www.google.no/", "https://www.bing.com/search?q=ost",
  "https://duckduckgo.com/?q=honning", "https://chatgpt.com/", "https://chat.openai.com/c/1",
  "https://www.perplexity.ai/search/x", "https://gemini.google.com/app", "https://copilot.microsoft.com/",
  "https://www.facebook.com/", "https://l.instagram.com/?u=x", "https://t.co/abc", "https://bsky.app/profile/x",
  "https://example.org/blogg", "https://nyheter.no/artikkel",
  // own domains: dropped as "intern" ...
  "https://rettfrabonden.com/sok", "https://www.rettfrabonden.com/produsent/hanen", "https://finn-tannlege.com/",
  "https://opplevagent.no/opplevelser", "HTTPS://RettFraBonden.COM/Om",
  // ... unless a token tested before the own-domain branch is in the URL (still google/bing/…)
  "https://www.google.com/url?q=https://rettfrabonden.com/", "https://www.bing.com/ck?u=finn-tannlege.com",
  "https://example.org/?ref=opplevagent.no&via=facebook",
  "   ", "",
];
const SESSIONS = [
  "ip1:desktop:aaaa", "ip2:mobile:bbbb", "ip3:tablet:cccc", "ip6:desktop:dddd", "ip7:mobile:eeee", "ip8:desktop:ffff",
  "ip4:Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)", "ip5:Mozilla/5.0 (compatible; ClaudeBot/1.0)",
  "ip9:curl/8.0", null,
];
const PATHS = ["/", "/sok", "/oslo", "/produsent/hanen", "/produsent/gard-a", "/produsent/ukjent-gard", "/produsent/gard-b?x=1"];

function seedReferrals(db: Database.Database, nowMs: number): void {
  let a = 12345;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  for (const [id, name] of [["a1", "Hanen"], ["a2", "Gård A"], ["a3", "Gård B"]]) {
    db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
                VALUES (?, ?, 'x', 'x', 'x@example.com', 'https://example.com', 'producer', ?)`).run(id, name, `key-${id}`);
  }
  const ins = db.prepare(
    "INSERT INTO analytics_page_views (path, source, referrer, session_id, is_owner, vertical_id, created_at) VALUES (?,?,?,?,?,?,?)"
  );
  for (let i = 0; i < 1500; i++) {
    // ~half inside the 30-day window, the rest older (outside it).
    const ageMs = Math.floor(r() * 60 * 24 * 3600_000);
    ins.run(pick(PATHS), "referral", pick(REFERRERS), pick(SESSIONS), r() < 0.08 ? 1 : (r() < 0.1 ? null : 0),
      pick(["rfb", "rfb", "dental", "experiences"]), sqliteTs(nowMs - ageMs));
  }
  ins.run("/", "referral", null, "ip1:desktop:aaaa", 0, "rfb", sqliteTs(nowMs - 3600_000)); // NULL referrer
}

export async function runSamtalerStripTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function ok(cond: boolean, label: string, detail?: unknown): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}${detail === undefined ? "" : `\n    got: ${JSON.stringify(detail)}`}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const quiet = <T>(fn: () => T): T => {
    const prev = console.log;
    console.log = () => {};
    try { return fn(); } finally { console.log = prev; }
  };

  // ── E: new strip computation == old synchronous computation ──────
  const nowMs = Date.now();
  const sdb = new Database(":memory:");
  try {
    quiet(() => __initSchemaForTesting(sdb));
    seedReferrals(sdb, nowMs);
    const hours = 24 * 30;
    const oldAll = oldHumanReferralPatterns(sdb, hours, nowMs);
    const newAll = computeHumanReferralPatterns(sdb, hours, undefined, nowMs);
    ok(oldAll.length >= 5 && oldAll.every((p) => p.visitCount >= 3) && oldAll.some((p) => p.topProducers.length > 0),
      "E1: the seeded data yields a non-trivial strip (several sources, named producers)", oldAll);
    ok(eq(oldAll, newAll), "E2: strip (no vertical) is identical to the old synchronous computation", { oldAll, newAll });
    let bad: unknown = null;
    for (const v of ["rfb", "dental", "experiences"] as const) {
      const o = oldHumanReferralPatterns(sdb, hours, nowMs, v);
      const n = computeHumanReferralPatterns(sdb, hours, v, nowMs);
      if (!eq(o, n)) bad = bad ?? { v, o, n };
    }
    ok(bad === null, "E3: strip is identical per vertical", bad);
    const wide = oldHumanReferralPatterns(sdb, 24 * 60, nowMs);
    ok(eq(wide, computeHumanReferralPatterns(sdb, 24 * 60, undefined, nowMs)) && !eq(wide, oldAll),
      "E4: a different window gives a different but still identical strip");

    // E5: the SQL own-domain filter agrees with the classifier on every referrer shape.
    const f = externalReferrerSqlFilter();
    const probe = new Database(":memory:");
    probe.exec("CREATE TABLE t (referrer TEXT)");
    let mismatch: unknown = null;
    for (const ref of REFERRERS.filter((x) => x.trim() !== "")) {
      probe.exec("DELETE FROM t");
      probe.prepare("INSERT INTO t (referrer) VALUES (?)").run(ref);
      const kept = probe.prepare(`SELECT 1 FROM t WHERE referrer IS NOT NULL${f.sql}`).all(...f.params).length === 1;
      const intern = classifyReferralSource(ref).key === "intern";
      if (kept === intern) mismatch = mismatch ?? { ref, kept, cls: classifyReferralSource(ref).key };
    }
    probe.close();
    ok(mismatch === null, "E5: SQL excludes exactly the referrers classifyReferralSource calls intern", mismatch);
  } catch (e) {
    ok(false, "E: equivalence tests threw", (e as Error).stack);
  } finally {
    sdb.close();
  }

  // ── W: the real worker, and the strip reader's SWR timing ────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "samtaler-strip-"));
  const dbPath = path.join(tmp, "strip.db");
  const writer = new Database(dbPath);
  try {
    __resetOffThreadStatsForTesting();
    writer.pragma("journal_mode = WAL");
    quiet(() => __initSchemaForTesting(writer));
    seedReferrals(writer, nowMs);
    const expected = oldHumanReferralPatterns(writer, STRIP_HOURS_BACK, nowMs);
    const got = await runStatsTaskOffThread(dbPath, { kind: "adminStats", query: { name: "humanReferrals", hours: STRIP_HOURS_BACK }, nowMs });
    ok(expected.length > 0 && eq(got, expected), "W1: the worker returns the same strip as the old synchronous computation", { got, expected });
  } catch (e) {
    ok(false, "W: worker tests threw", (e as Error).stack);
  } finally {
    __resetOffThreadStatsForTesting();
    writer.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  {
    let t = 5_000_000;
    let calls = 0;
    let fail = false;
    const fileDb = { name: "/data/x.db", memory: false, pragma: () => "wal" } as unknown as Database.Database;
    const reader = createAdminStatsReader({
      getDb: () => fileDb,
      offThreadUsable: () => true,
      runOffThread: () => (fail ? Promise.reject(new Error("worker down")) : Promise.resolve([{ sourceKey: `v${++calls}` }])),
      now: () => t,
      ttlMs: STRIP_TTL_MS,
      maxStaleMs: STRIP_MAX_STALE_MS,
      retryAfterMs: 0,
      maxEntries: 4,
      log: () => {},
    });
    const q = { name: "humanReferrals", hours: STRIP_HOURS_BACK } as const;
    const first = await reader.read<any[]>(q, () => []);
    t += 29 * 60_000;
    const inTtl = await reader.read<any[]>(q, () => []);
    t += 5 * 60_000; // 34 min: stale but servable, refresh starts
    fail = false;
    const stale = await reader.read<any[]>(q, () => []);
    await reader.settled(q);
    t += 70 * 60_000; // way past max stale
    fail = true;
    const dead = await reader.read<any[]>(q, () => []);
    ok(first.ok && inTtl.ok && (inTtl as any).value[0].sourceKey === "v1" && stale.ok && (stale as any).value[0].sourceKey === "v1" && calls === 2 && !dead.ok,
      "W2: strip served from cache for 30 min, stale up to 60 min while refreshing, then not-ok when the worker fails", { calls, dead });
  }

  // ── C: HTML cache ────────────────────────────────────────────────
  {
    let t = 0;
    const c = createHtmlCache(60_000, () => t, 2);
    c.set("a", "A");
    t = 59_999;
    const hit = c.get("a");
    t = 60_000;
    const gone = c.get("a");
    c.set("x", "X"); c.set("y", "Y"); c.set("z", "Z");
    ok(hit === "A" && gone === undefined, "C1: an entry is served for the TTL and then dropped", { hit, gone });
    ok(c.get("x") === undefined && c.get("z") === "Z", "C2: past maxEntries the oldest entry is dropped");
    c.clear();
    ok(c.get("z") === undefined, "C3: clear() empties the cache");
  }

  // ── R: the route ─────────────────────────────────────────────────
  {
    const restoreDb = quiet(() => __pinInMemoryDbForTesting());
    let server: http.Server | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const conversationUi = require("../routes/conversation-ui").default;
      let mode: "ok" | "fail" = "fail";
      let reads = 0;
      let label = "Google-søk";
      const fileDb = { name: "/data/x.db", memory: false, pragma: () => "wal" } as unknown as Database.Database;
      let computeSyncCalls = 0;
      const reader = createAdminStatsReader({
        getDb: () => fileDb,
        offThreadUsable: () => true,
        runOffThread: () => {
          reads++;
          return mode === "ok"
            ? Promise.resolve([{ sourceKey: "google", sourceLabel: label, visitCount: 4, producerViews: 0, topProducers: [], otherProducerCount: 0 }])
            : Promise.reject(new Error("worker down"));
        },
        now: Date.now,
        ttlMs: 0, // every read refreshes, so the HTML cache is what decides what is served
        maxStaleMs: 0,
        retryAfterMs: 0,
        maxEntries: 4,
        log: () => {},
      });
      const origRead = reader.read.bind(reader);
      reader.read = ((query: any, sync: () => any) => origRead(query, () => { computeSyncCalls++; return sync(); })) as typeof reader.read;
      const cache = createHtmlCache(60_000);
      const setKeys: string[] = [];
      const origSet = cache.set.bind(cache);
      cache.set = ((k: string, v: string) => { setKeys.push(k); return origSet(k, v); }) as typeof cache.set;
      const app = express();
      app.set(STRIP_READER_APP_KEY, reader);
      app.set(HTML_CACHE_APP_KEY, cache);
      app.use("/", conversationUi);
      server = await new Promise<http.Server>((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });
      const port = (server.address() as AddressInfo).port;
      const get = (p: string) =>
        new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve) => {
          const req = http.request({ host: "127.0.0.1", port, path: p, method: "GET" }, (res) => {
            let buf = "";
            res.on("data", (c) => (buf += c));
            res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body: buf }));
          });
          req.on("error", () => resolve({ status: 0, headers: {}, body: "" }));
          req.end();
        });

      const down = await get("/samtaler");
      ok(down.status === 503 && down.headers["retry-after"] === "30" && reads >= 1 && computeSyncCalls === 0 && cache.get("") === undefined,
        "R1: worker failure with nothing cached → 503 + Retry-After, no synchronous strip, nothing cached", { status: down.status, reads, computeSyncCalls });

      mode = "ok";
      const up = await get("/samtaler");
      ok(up.status === 200 && up.body.includes("hv-card") && up.body.includes("Google-søk") && up.body.includes("4 bes&oslash;k"),
        "R2: once the worker answers, the page renders the strip", up.status);

      label = "Endret";
      const readsBefore = reads;
      const again = await get("/samtaler");
      ok(again.status === 200 && again.body === up.body && reads === readsBefore,
        "R3: a second request within the TTL is served from the HTML cache, byte-identical, without touching the strip reader");

      const mcp = await get("/samtaler?kilde=mcp");
      const mcp2 = await get("/samtaler?kilde=mcp");
      ok(mcp.status === 200 && mcp.body.includes("Endret") && mcp.body !== up.body && mcp2.body === mcp.body,
        "R4: each kilde has its own cache entry");

      const setsBeforeOdd = setKeys.length;
      const odd1 = await get("/samtaler?kilde=%3Cx%3E");
      const odd2 = await get("/samtaler?kilde=%3Cx%3E");
      // Asserted on the cache writes themselves: which strip label a refresh returns is timing-dependent.
      ok(odd1.status === 200 && odd2.status === 200 && setKeys.length === setsBeforeOdd,
        "R5: an unknown kilde is never cached", { setKeys });

      mode = "fail";
      const stillCached = await get("/samtaler");
      ok(stillCached.status === 200 && stillCached.body === up.body,
        "R6: a cached page is still served while the worker is down");
    } catch (e) {
      ok(false, "R: route tests threw", (e as Error).stack);
    } finally {
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      restoreDb();
    }
  }

  // ── N: night-window index ────────────────────────────────────────
  {
    const ndb = new Database(":memory:");
    try {
      quiet(() => __initSchemaForTesting(ndb));
      const has = () => !!ndb.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_conversations_vertical_updated'").get();
      ok(!has(), "N1: the schema init (boot) does not build the conversations index");
      const cols = (ndb.pragma("table_info(conversations)") as Array<{ name: string }>).map((c) => c.name);
      ok(NIGHT_INDEXES.every((ix) => ix.columns.split(",").every((c) => cols.includes(c.trim()))) && cols.includes("vertical_id") && cols.includes("updated_at"),
        "N2: every night-index column exists on conversations");
      const built = ensureNightIndexes(ndb);
      ok(eq(built, ["idx_conversations_vertical_updated"]) && has(), "N3: ensureNightIndexes builds it", built);
      ok(eq(ensureNightIndexes(ndb), []), "N4: a second night is a no-op");
      const plan = (ndb.prepare(
        "EXPLAIN QUERY PLAN SELECT c.* FROM conversations c WHERE c.vertical_id = ? ORDER BY c.updated_at DESC LIMIT 50"
      ).all("rfb") as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
      ok(/idx_conversations_vertical_updated/.test(plan), "N5: listConversations' WHERE/ORDER BY uses the new index", plan);
    } catch (e) {
      ok(false, "N: night-index tests threw", (e as Error).stack);
    } finally {
      ndb.close();
    }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runSamtalerStripTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed ? 1 : 0);
  });
}
