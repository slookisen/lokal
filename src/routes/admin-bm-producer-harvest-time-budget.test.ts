/**
 * admin-bm-producer-harvest-time-budget.test.ts — 502 fix for
 * GET /admin/bm-producer-harvest: a 30 s wall-clock budget
 * (BM_HARVEST_TIME_BUDGET_MS) in BOTH branches, plus `processed` and the
 * `next_offset` resume cursor.
 *
 * Against a stub bondensmarked.no (10-slug sitemap, unparseable pages, every
 * page request recorded) and an injected clock (__setBmHarvestNowForTesting)
 * that advances STEP_MS per producer-page fetch:
 *   t1 constants: budget 30 s, APPLY_TIME_BUDGET_MS is the same value (alias)
 *   t2 AC7.1 dry-run budget exceeded after N slugs → time_budget_exceeded,
 *      processed N, skipped, next_offset = offset+N, only N pages fetched,
 *      existing fields unchanged
 *   t3 AC7.1 dry-run not exceeded, window reaches catalog end → next_offset null
 *   t4 AC7.1 dry-run window ends before catalog end → next_offset = offset+limit
 *   t5 AC7.2 apply budget exceeded → processed/scanned N, next_offset offset+N
 *   t6 AC7.2 apply completed: window before end → offset+limit; at end → null
 *
 * Fresh in-memory DB (pinned + restored), stubbed globalThis.fetch (restored),
 * clock override reset in finally.
 *
 * Standalone: npx tsx src/routes/admin-bm-producer-harvest-time-budget.test.ts
 */

import * as initMod from "../database/init";
import router, {
  APPLY_TIME_BUDGET_MS,
  BM_HARVEST_TIME_BUDGET_MS,
  __setBmHarvestNowForTesting,
} from "./admin-bm-producer-harvest";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(
  routerInstance: any,
  opts: { url: string; headers?: Record<string, string>; query?: Record<string, string> },
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: "GET",
      url: opts.url,
      originalUrl: opts.url,
      query: opts.query || {},
      headers,
      body: undefined,
      ip: "127.0.0.1",
      get(name: string) {
        return headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    routerInstance.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: { error: String(err ?? "unmatched") } }));
  });
}

export async function runAdminBmProducerHarvestTimeBudgetTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // t1 — constants
  assertEq([BM_HARVEST_TIME_BUDGET_MS, APPLY_TIME_BUDGET_MS], [30_000, 30_000], "t1: budget is 30 s and APPLY_TIME_BUDGET_MS aliases it");

  const key = process.env.ADMIN_KEY || "bm-time-budget-test-key";
  const prevAdminKey = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = key;
  const auth = { "x-admin-key": key };
  const prevFetch = globalThis.fetch;
  const restoreDb = initMod.__pinInMemoryDbForTesting();

  const slugs = Array.from({ length: 10 }, (_, i) => `gard-${i}`);
  const sitemap =
    `<?xml version="1.0"?><urlset>` +
    slugs.map((s) => `<url><loc>https://bondensmarked.no/produsenter/${s}</loc></url>`).join("") +
    `<url><loc>https://bondensmarked.no/produsenter</loc></url></urlset>`;

  // Each producer-page fetch advances the injected clock by stepMs. With
  // stepMs = 11 s the check before slug k sees (k-1)*11 s elapsed: slugs 1..3
  // start (0, 11, 22 s), slug 4 sees 33 s > 30 s → break after N = 3.
  let mockNow = 1_000_000;
  let stepMs = 0;
  let pageFetches: string[] = [];
  (globalThis as any).fetch = async (url: any) => {
    const u = String(url);
    if (u === "https://bondensmarked.no/sitemap.xml") {
      return new Response(sitemap, { status: 200, headers: { "content-type": "application/xml" } });
    }
    const m = /\/produsenter\/([a-z0-9-]+)$/.exec(u);
    if (m) {
      pageFetches.push(m[1]);
      mockNow += stepMs;
      return new Response("<html><body>no structured data</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response("not found", { status: 404 });
  };
  __setBmHarvestNowForTesting(() => mockNow);
  const get = async (query: Record<string, string>, step: number) => {
    pageFetches = [];
    stepMs = step;
    return callRoute(router, { url: "/", headers: auth, query });
  };
  const SLOW = 11_000;

  try {
    // t2 — dry-run, budget exceeded after N = 3 slugs
    let r = await get({ offset: "2", limit: "6" }, SLOW);
    assertEq(
      [r.status, r.body?.time_budget_exceeded, r.body?.processed, r.body?.skipped_due_to_time_budget, r.body?.next_offset],
      [200, true, 3, 3, 5],
      "t2: dry-run budget exceeded after 3 of 6 → processed 3, skipped 3, next_offset 2+3",
    );
    assertEq(pageFetches, ["gard-2", "gard-3", "gard-4"], "t2: dry-run stops starting slugs once the budget is exceeded");
    assertEq(
      [r.body?.total_slugs, r.body?.offset, r.body?.fetched, r.body?.parse_failed, r.body?.matched, r.body?.unmatched, r.body?.duration_ms],
      [10, 2, 6, 3, 0, 0, 33_000],
      "t2: existing dry-run fields keep their meaning (fetched = window size), duration_ms uses the injected clock",
    );

    // t2b — default dry-run (no limit) also honours the budget
    r = await get({}, SLOW);
    assertEq(
      [r.body?.time_budget_exceeded, r.body?.processed, r.body?.skipped_due_to_time_budget, r.body?.next_offset],
      [true, 3, 7, 3],
      "t2b: default dry-run (whole catalog) is cut at the budget → next_offset 3",
    );

    // t3 — dry-run not exceeded, window reaches catalog end
    r = await get({ offset: "6" }, 0);
    assertEq(
      [r.body?.time_budget_exceeded, r.body?.processed, r.body?.skipped_due_to_time_budget, r.body?.next_offset, pageFetches.length],
      [false, 4, 0, null, 4],
      "t3: dry-run within budget reaching the catalog end → next_offset null",
    );
    r = await get({ offset: "50" }, 0);
    assertEq([r.body?.processed, r.body?.next_offset], [0, null], "t3: offset past the end → processed 0, next_offset null");

    // t4 — dry-run window ends before catalog end
    r = await get({ offset: "1", limit: "4" }, 0);
    assertEq(
      [r.body?.time_budget_exceeded, r.body?.processed, r.body?.skipped_due_to_time_budget, r.body?.next_offset],
      [false, 4, 0, 5],
      "t4: dry-run limit smaller than the remainder → next_offset = offset+limit",
    );

    // t5 — apply, budget exceeded after N = 3
    r = await get({ dry_run: "false", offset: "4", limit: "5" }, SLOW);
    assertEq(
      [r.status, r.body?.dry_run, r.body?.time_budget_exceeded, r.body?.processed, r.body?.scanned, r.body?.skipped_due_to_time_budget, r.body?.next_offset],
      [200, false, true, 3, 3, 2, 7],
      "t5: apply budget exceeded after 3 of 5 → processed 3, next_offset 4+3",
    );
    assertEq((r.body?.results ?? []).map((x: any) => x.slug), ["gard-4", "gard-5", "gard-6"], "t5: every started slug is in results (parse_failed counted)");

    // t6 — apply completed
    r = await get({ dry_run: "false", offset: "2", limit: "3" }, 0);
    assertEq(
      [r.body?.time_budget_exceeded, r.body?.processed, r.body?.next_offset],
      [false, 3, 5],
      "t6: apply within budget, window before the end → next_offset = offset+limit",
    );
    r = await get({ dry_run: "false", offset: "8", limit: "20" }, 0);
    assertEq(
      [r.body?.time_budget_exceeded, r.body?.processed, r.body?.next_offset],
      [false, 2, null],
      "t6: apply within budget reaching the catalog end → next_offset null",
    );
  } catch (err) {
    failed++;
    failures.push(`unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  } finally {
    __setBmHarvestNowForTesting(null);
    (globalThis as any).fetch = prevFetch;
    restoreDb();
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminBmProducerHarvestTimeBudgetTests({ log: true }).then((r) => {
    console.log(`\nadmin-bm-producer-harvest-time-budget: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      for (const f of r.failures) console.log(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
