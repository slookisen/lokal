/**
 * admin-bm-producer-harvest-offset.test.ts — dev-request
 * 2026-10-10-rfb-berikelse-nattjobb (Daniel live 2026-10-11): the optional
 * `offset` query param of GET /admin/bm-producer-harvest.
 *
 * Covers, against a stub bondensmarked.no (10-slug sitemap; every producer
 * page request is recorded, so "which slugs were processed" is observed
 * directly, not inferred):
 *   o1 parseBmHarvestOffset: absent / junk / negative / fractional / array → 0
 *   o2 dry-run default (no offset) is unchanged: the first `limit` slugs,
 *      response reports offset 0
 *   o3 dry-run offset slices the slug list BEFORE limit, is reported
 *   o4 dry-run offset near / past the end: a short / empty window
 *   o5 apply (dry_run=false) default unchanged: first `limit` slugs, offset 0
 *   o6 apply offset slices before limit, reported; results carry those slugs
 *   o7 junk offset on apply behaves exactly like no offset
 *
 * Fresh in-memory DB (pinned + restored), stubbed globalThis.fetch (restored).
 * Pages are deliberately unparseable (no LocalBusiness JSON-LD), so the apply
 * branch writes nothing — this suite is about the window, not the writes
 * (admin-bm-producer-harvest.test.ts covers those).
 *
 * Standalone: npx tsx src/routes/admin-bm-producer-harvest-offset.test.ts
 */

import * as initMod from "../database/init";
import router, { parseBmHarvestOffset } from "./admin-bm-producer-harvest";

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

export async function runAdminBmProducerHarvestOffsetTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // o1 — pure parser
  assertEq(
    [undefined, "", "0", "5", "-3", "abc", "1.5", " 7 ", ["5"], 5].map((v) => parseBmHarvestOffset(v as unknown)),
    [0, 0, 0, 5, 0, 0, 0, 7, 0, 0],
    "o1: offset parser — only a plain non-negative integer string counts; everything else is 0",
  );

  // Adopt the ambient suite key (tests/test.ts assigns it once); standalone fallback.
  const key = process.env.ADMIN_KEY || "bm-offset-test-key";
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
  let pageFetches: string[] = [];
  (globalThis as any).fetch = async (url: any) => {
    const u = String(url);
    if (u === "https://bondensmarked.no/sitemap.xml") {
      return new Response(sitemap, { status: 200, headers: { "content-type": "application/xml" } });
    }
    const m = /\/produsenter\/([a-z0-9-]+)$/.exec(u);
    if (m) {
      pageFetches.push(m[1]);
      return new Response("<html><body>no structured data</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response("not found", { status: 404 });
  };
  const get = async (query: Record<string, string>) => {
    pageFetches = [];
    return callRoute(router, { url: "/", headers: auth, query });
  };

  try {
    // o2 — dry-run default unchanged
    let r = await get({ limit: "3" });
    assertEq([r.status, r.body?.offset, r.body?.fetched, r.body?.total_slugs], [200, 0, 3, 10], "o2: dry-run without offset → offset 0, first 3 of 10");
    assertEq(pageFetches, ["gard-0", "gard-1", "gard-2"], "o2: dry-run without offset processes the first `limit` slugs (pre-offset behaviour)");

    // o3 — dry-run offset slices before limit
    r = await get({ limit: "3", offset: "4" });
    assertEq([r.status, r.body?.offset, r.body?.fetched], [200, 4, 3], "o3: dry-run offset=4 limit=3 → reported offset 4, fetched 3");
    assertEq(pageFetches, ["gard-4", "gard-5", "gard-6"], "o3: dry-run offset=4 limit=3 processes slugs 4..6");

    // o4 — near / past the end
    r = await get({ limit: "5", offset: "9" });
    assertEq([r.body?.offset, r.body?.fetched, pageFetches], [9, 1, ["gard-9"]], "o4: offset 9 of 10 → a one-slug window");
    r = await get({ limit: "5", offset: "50" });
    assertEq([r.status, r.body?.offset, r.body?.fetched, pageFetches.length], [200, 50, 0, 0], "o4: offset past the end → empty window, no page fetched");

    // o5 — apply default unchanged
    r = await get({ dry_run: "false", limit: "2" });
    assertEq([r.status, r.body?.dry_run, r.body?.offset, r.body?.scanned], [200, false, 0, 2], "o5: apply without offset → offset 0, scanned 2");
    assertEq((r.body?.results ?? []).map((x: any) => x.slug), ["gard-0", "gard-1"], "o5: apply without offset processes the first `limit` slugs");

    // o6 — apply offset
    r = await get({ dry_run: "false", limit: "2", offset: "3" });
    assertEq([r.status, r.body?.offset, r.body?.scanned, r.body?.total_slugs], [200, 3, 2, 10], "o6: apply offset=3 limit=2 → reported offset 3, scanned 2 of 10");
    assertEq((r.body?.results ?? []).map((x: any) => x.slug), ["gard-3", "gard-4"], "o6: apply offset=3 limit=2 processes slugs 3..4");
    assertEq(pageFetches, ["gard-3", "gard-4"], "o6: and fetches only those pages");

    // o7 — junk offset == no offset
    r = await get({ dry_run: "false", limit: "2", offset: "-1" });
    assertEq([r.body?.offset, (r.body?.results ?? []).map((x: any) => x.slug)], [0, ["gard-0", "gard-1"]], "o7: a negative offset behaves exactly like no offset");
  } catch (err) {
    failed++;
    failures.push(`unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  } finally {
    (globalThis as any).fetch = prevFetch;
    restoreDb();
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminBmProducerHarvestOffsetTests({ log: true }).then((r) => {
    console.log(`\nadmin-bm-producer-harvest-offset: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      for (const f of r.failures) console.log(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
