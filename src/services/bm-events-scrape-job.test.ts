/**
 * bm-events-scrape-job.test.ts — tests for the fire-and-forget BM events scrape
 * job (services/bm-events-scrape-job.ts) added in orch-pr-20.
 *
 * Mirrors search-enrich-sweep.test.ts:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting (prod-like schema)
 *   - ZERO network: globalThis.fetch is stubbed for the real-scrape path, OR an
 *     injectable `runner` stub is used for deterministic timing/counts.
 *   - exported runBmEventsScrapeJobTests({log}) → TestSummary; wired into
 *     tests/test.ts. Standalone: npx tsx src/services/bm-events-scrape-job.test.ts
 *
 * Pins the PR's invariants:
 *   - async start returns {started, run_id} immediately (does NOT block on the scrape)
 *   - 409/already_running while a job is in flight
 *   - GET-style getBmEventsScrapeJob() reports status + counts
 *   - the job runs runBmEventsScraper (stubbed fetch) and upserts idempotently
 *   - synchronous mode (direct runBmEventsScraper) still works + is unchanged
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { runBmEventsScraper, type ScrapeResult } from "./bm-events-scraper";
import {
  startBmEventsScrapeJob,
  getBmEventsScrapeJob,
  __resetBmEventsScrapeJobForTesting,
} from "./bm-events-scrape-job";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// ─── Minimal prod-like schema (mirrors the bits the scraper touches) ───────────
function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      umbrella_type TEXT,
      parent_umbrella_id TEXT,
      city TEXT,
      is_active INTEGER DEFAULT 1,
      agent_review_status TEXT,
      bm_venue_meta TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE bm_market_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venue_agent_id TEXT NOT NULL,
      event_slug TEXT UNIQUE NOT NULL,
      event_name TEXT NOT NULL,
      location_text TEXT,
      start_at TEXT NOT NULL,
      end_at TEXT,
      source_url TEXT NOT NULL,
      scraped_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (venue_agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );
  `);
  // Tree: national → Agder lokallag (Kristiansand) → Lyngdal venue.
  db.prepare("INSERT INTO agents (id, name, umbrella_type) VALUES ('nat-1', 'Bondens marked Norge', 'market_network')").run();
  db.prepare("INSERT INTO agents (id, name, umbrella_type, parent_umbrella_id, city) VALUES ('lok-agder', 'Bondens Marked Agder', 'market_network', 'nat-1', 'Kristiansand')").run();
  db.prepare("INSERT INTO agents (id, name, umbrella_type, parent_umbrella_id) VALUES ('ven-lyngdal', 'Bondens marked — Lyngdal', 'venue', 'lok-agder')").run();
  return db;
}

// ─── Deterministic fetch stub (one Lyngdal venue event) ────────────────────────
function installFetchStub(): () => void {
  const realFetch = (globalThis as any).fetch;
  const listingHtml = `<html><body>
    <a href="/markeder/lyngdal-sentrum-2026-05-16">Lyngdal</a>
  </body></html>`;
  const lyngdalEventHtml = `<html><head>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Event","name":"Lyngdal Sentrum","startDate":"2026-05-16T08:00:00+00:00","endDate":"2026-05-16T13:00:00+00:00","location":{"@type":"Place","name":"Lyngdal"},"url":"https://bondensmarked.no/markeder/lyngdal-sentrum-2026-05-16"}</script>
  </head><body>x</body></html>`;
  (globalThis as any).fetch = async (url: string) => {
    let body = "";
    if (url.endsWith("/markeder")) body = listingHtml;
    else if (url.endsWith("lyngdal-sentrum-2026-05-16")) body = lyngdalEventHtml;
    else body = "<html></html>";
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  };
  return () => { (globalThis as any).fetch = realFetch; };
}

function makeScrapeResult(over: Partial<ScrapeResult> = {}): ScrapeResult {
  return {
    fetched: 0,
    parsed: 0,
    matched_to_venue: 0,
    matched_to_lokallag_fallback: 0,
    auto_created_bm_venue: 0,
    unmatched: 0,
    upserted: 0,
    event_times_checked: 0,
    event_times_corrected: 0,
    errors: [],
    ...over,
  };
}

export function runBmEventsScrapeJobTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  async function waitForJobDone(timeoutMs = 4000): Promise<void> {
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (getBmEventsScrapeJob().status !== "running") {
          clearInterval(interval);
          resolve();
        }
      }, 5);
      setTimeout(() => { clearInterval(interval); resolve(); }, timeoutMs);
    });
  }

  return (async () => {
    // ──────────────────────────────────────────────────────────────────────────
    // PART A — async start returns immediately + 409 while running + GET status.
    // Uses an injectable runner we control so we can hold the job "running" and
    // assert the start call did NOT block on the scrape.
    // ──────────────────────────────────────────────────────────────────────────
    {
      __resetBmEventsScrapeJobForTesting();

      // A runner that blocks until we release it — proves start is non-blocking
      // and lets us hit the 409 path deterministically.
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const slowRunner = async (): Promise<ScrapeResult> => {
        await gate;
        return makeScrapeResult({ fetched: 5, parsed: 5, matched_to_venue: 5, upserted: 5 });
      };

      const before = Date.now();
      const started = startBmEventsScrapeJob({ runner: slowRunner });
      const elapsed = Date.now() - before;

      assertTrue(started.started === true, "async start returns started=true");
      if (started.started) {
        assertTrue(typeof started.run_id === "string" && started.run_id.length > 0, "async start returns a run_id");
        assertEq(started.status, "running", "async start returns status=running");
      }
      assertTrue(elapsed < 500, `async start returns immediately (did not block on scrape) — ${elapsed}ms`);

      // GET-style status while running.
      const running = getBmEventsScrapeJob();
      assertEq(running.status, "running", "GET status reports running while in flight");
      assertTrue(running.started_at !== null, "GET status has started_at while running");
      assertEq(running.finished_at, null, "GET status finished_at is null while running");

      // 409: a second start while running is rejected as already_running.
      const second = startBmEventsScrapeJob({ runner: slowRunner });
      assertTrue(second.started === false, "second start while running → started=false");
      if (!second.started) {
        assertEq(second.reason, "already_running", "second start reason=already_running (409)");
      }

      // Release the runner and let the job complete.
      release();
      await waitForJobDone();

      const done = getBmEventsScrapeJob();
      assertEq(done.status, "done", "GET status reports done after completion");
      assertEq(done.counts.fetched, 5, "GET counts.fetched folded from ScrapeResult");
      assertEq(done.counts.upserted, 5, "GET counts.upserted folded from ScrapeResult");
      assertEq(done.counts.match_rate, 1, "GET counts.match_rate = matched/parsed (5/5=1)");
      assertTrue(done.finished_at !== null, "GET status has finished_at after completion");

      // After done, a new job is allowed (not stuck in already_running).
      __resetBmEventsScrapeJobForTesting();
      const afterReset = getBmEventsScrapeJob();
      assertEq(afterReset.status, "idle", "job resets to idle (re-runnable)");
    }

    // ──────────────────────────────────────────────────────────────────────────
    // PART B — the job runs the REAL scraper (stubbed fetch + injected DB) and
    // upserts to bm_market_events idempotently.
    // ──────────────────────────────────────────────────────────────────────────
    {
      __resetBmEventsScrapeJobForTesting();
      const db = makeDb();
      initMod.__setDbForTesting(db);
      const restoreFetch = installFetchStub();
      try {
        // Default runner = real runBmEventsScraper (no `runner` override).
        const started = startBmEventsScrapeJob({ maxEvents: 10, useRenderWorker: false, correctTimes: false });
        assertTrue(started.started === true, "real-scrape job starts");
        await waitForJobDone();

        const job = getBmEventsScrapeJob();
        assertEq(job.status, "done", "real-scrape job finishes with status=done");
        assertEq(job.counts.fetched, 1, "real-scrape job: fetched 1 slug from stubbed listing");
        assertEq(job.counts.parsed, 1, "real-scrape job: parsed the Lyngdal event JSON-LD");
        assertTrue(job.counts.upserted >= 1, `real-scrape job: upserted ≥1 (got ${job.counts.upserted})`);

        // The row landed in bm_market_events, matched to the Lyngdal venue.
        const stored = db.prepare("SELECT event_slug, venue_agent_id FROM bm_market_events WHERE event_slug = ?").get("lyngdal-sentrum-2026-05-16") as any;
        assertTrue(!!stored, "real-scrape job: Lyngdal event upserted to bm_market_events");
        assertEq(stored?.venue_agent_id, "ven-lyngdal", "real-scrape job: row matched to ven-lyngdal");

        // Idempotent: a second job run must not duplicate (UNIQUE event_slug).
        __resetBmEventsScrapeJobForTesting();
        const second = startBmEventsScrapeJob({ maxEvents: 10, useRenderWorker: false, correctTimes: false });
        assertTrue(second.started === true, "idempotency: second real-scrape job starts");
        await waitForJobDone();
        const total = (db.prepare("SELECT COUNT(*) AS c FROM bm_market_events").get() as any).c;
        assertEq(total, 1, "idempotency: re-running the job does not duplicate rows (UNIQUE on event_slug)");
      } finally {
        restoreFetch();
        __resetBmEventsScrapeJobForTesting();
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // PART C — synchronous mode (direct runBmEventsScraper) STILL works and is
    // unchanged: same stubbed fetch path, returns the ScrapeResult inline.
    // ──────────────────────────────────────────────────────────────────────────
    {
      const db = makeDb();
      initMod.__setDbForTesting(db);
      const restoreFetch = installFetchStub();
      try {
        const result = await runBmEventsScraper({ maxEvents: 10, useRenderWorker: false, correctTimes: false });
        assertEq(result.fetched, 1, "sync mode: runBmEventsScraper still returns fetched inline");
        assertEq(result.parsed, 1, "sync mode: runBmEventsScraper still returns parsed inline");
        assertTrue(result.upserted >= 1, `sync mode: runBmEventsScraper still upserts inline (got ${result.upserted})`);
        const stored = db.prepare("SELECT venue_agent_id FROM bm_market_events WHERE event_slug = ?").get("lyngdal-sentrum-2026-05-16") as any;
        assertEq(stored?.venue_agent_id, "ven-lyngdal", "sync mode: row matched to ven-lyngdal (behaviour identical)");
      } finally {
        restoreFetch();
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // PART D — a hard scrape failure marks the job status=error + last_error
    // (per-event errors are NOT failures — those stay in counts.errors with
    // status=done; covered implicitly by Part B).
    // ──────────────────────────────────────────────────────────────────────────
    {
      __resetBmEventsScrapeJobForTesting();
      const boomRunner = async (): Promise<ScrapeResult> => { throw new Error("db unavailable"); };
      const started = startBmEventsScrapeJob({ runner: boomRunner });
      assertTrue(started.started === true, "error-path job starts");
      await waitForJobDone();
      const job = getBmEventsScrapeJob();
      assertEq(job.status, "error", "hard scrape failure → status=error");
      assertEq(job.last_error, "db unavailable", "hard scrape failure → last_error captured");
      assertTrue(job.finished_at !== null, "errored job has finished_at");
      __resetBmEventsScrapeJobForTesting();
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: npx tsx src/services/bm-events-scrape-job.test.ts
if (require.main === module) {
  console.log("── bm-events-scrape-job tests ──");
  runBmEventsScrapeJobTests({ log: true }).then((r) => {
    console.log(`\nbm-events-scrape-job: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
