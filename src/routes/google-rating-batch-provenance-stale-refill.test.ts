/**
 * google-rating-batch-provenance-stale-refill.test.ts — regression suite for
 * dev-request 2026-09-05-google-rating-batch-provenance-write-mismatch
 * (slookisen/A2A): `POST /admin/google-rating-batch?include_address_phone=true`
 * (src/routes/marketplace.ts, the PR-82 block) reported `addressWritten:true`
 * / `phoneWritten:true` for real production agents (Kafferøst AS 2026-09-04,
 * "address"; Alm Gård — Feios 2026-09-05, "phone"; original observation
 * 2026-09-03), but an immediate `GET /admin/pool-blocker-explain` right after
 * showed `signals.provenance_source_counts` for that field still at 1, not 2
 * — silently defeating PR-82's whole purpose (a 2nd corroborating source so
 * the cross-source-validator's Tier-A/B agreement gate is satisfiable).
 *
 * ── Root cause ──────────────────────────────────────────────────────────
 * `writeAddr`/`writePhone` are fill-empty-only (`!currAddr && !!gAddrRaw`) —
 * true only when the COLUMN was genuinely empty going into this call. Every
 * OTHER write-site in this codebase that adds a "google_places"/"brreg"
 * provenance entry for address/phone ALSO writes the column in the same
 * transaction when the column was empty (this same PR-82 block; admin-
 * agents.ts's applyAgentBrregContact) — so under normal operation, a
 * pre-existing provenance entry for a field can only coexist with an EMPTY
 * column if something ELSE blanked the column afterwards WITHOUT touching
 * field_provenance. That pattern is real and already exists in this
 * codebase: admin-contact-write-guard-retro-sweep.ts's applyPhoneBlank sets
 * `phone = NULL` on a rule violation and never touches field_provenance.
 *
 * BRREG/Google answers are stable for a given business, so a later re-fill
 * of the now-empty column often reproduces the exact same {source_type,
 * value} pair already sitting in field_provenance. mergeFieldProvenance's
 * dedupKey (source_type + trimmed value, no timestamp — admin-knowledge.ts,
 * correct and unchanged here) then treats the fresh write as "already
 * known" and adds nothing — so field_provenance for that field is left
 * completely untouched even though `writeAddr`/`writePhone` (and therefore
 * `addressWritten`/`phoneWritten` in the response) are accurately true.
 *
 * ── Fix ─────────────────────────────────────────────────────────────────
 * marketplace.ts's PR-82 block now forces this call's own source into
 * field_provenance whenever `writeAddr`/`writePhone` is true (a genuine
 * empty→filled column transition), even if mergeFieldProvenance's dedup
 * against a stale prior entry would otherwise have dropped it — a column
 * that was empty going into this call cannot have been "already
 * corroborated" by anything currently live. This does NOT touch
 * mergeFieldProvenance/dedupKey itself (shared by many other callers) and
 * does NOT fire on the already-populated-column no-op path, so the
 * "genuine repeat of an already-successful write must not double-count"
 * behavior (case B below, and the pre-existing "f" block in
 * pending-verify-unpark-data-enriched-at-writesites.test.ts) is unchanged.
 *
 * Covers:
 *   A. The actual bug scenario (root cause) — empty column + a STALE
 *      pre-existing provenance entry with the identical {source_type,
 *      value} pair address will get this call → before the fix,
 *      pool-blocker-explain's source count stays at 1 despite
 *      `addressWritten:true`; after the fix, it becomes 2. Address and
 *      phone are both covered (matching both real production reports).
 *   B. Working-as-designed dedup: column ALREADY populated (a genuine
 *      earlier successful write) + an identical repeat Google answer →
 *      must NOT double-count and must NOT report *Written:true a second
 *      time — regression guard for AC-b, must not regress by this fix.
 *   C. AC2's literal scenario: empty column + a pre-existing 1-source
 *      entry of a DIFFERENT source_type (e.g. "homepage") → a
 *      `...Written:true` call → source count becomes 2. This already
 *      worked before the fix (dedupKey differs by source_type) — kept as
 *      a regression guard so the fix doesn't accidentally change it.
 *   D. AC3 sanity: a genuine first-ever fill (no prior provenance at all)
 *      still reports *Written:true / correct googleRating/reviewCount
 *      fields exactly as before — the fix doesn't alter that shape.
 *
 * Exercises the real POST /admin/google-rating-batch handler AND the real
 * GET /admin/pool-blocker-explain handler via router.handle directly (no
 * real HTTP socket) — same pattern as pending-verify-unpark-data-enriched-
 * at-writesites.test.ts's block (f), which this file complements.
 *
 * Two ways to run:
 *   1. Standalone: npx tsx src/routes/google-rating-batch-provenance-stale-refill.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runGoogleRatingBatchProvenanceStaleRefillTests() and folds its
 *      pass/fail counts into the `npm test` summary.
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: { method?: string; url: string; headers?: Record<string, string>; body?: any },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const queryString = opts.url.split("?")[1];
    const query: Record<string, string> = {};
    if (queryString) {
      for (const pair of queryString.split("&")) {
        const [k, v] = pair.split("=");
        if (k) query[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
      }
    }
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      query,
      headers,
      body: opts.body,
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
      end() {
        resolve({ status: this.statusCode, body: undefined });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export async function runGoogleRatingBatchProvenanceStaleRefillTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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

  const prevDb = initMod.__peekDbForTesting();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const prevPlacesKey = process.env.GOOGLE_PLACES_API_KEY;
  const prevFetch = (globalThis as any).fetch;

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = OFF");

  const ADMIN_KEY = process.env.ADMIN_KEY || "grb-provenance-stale-refill-test-key";
  const GADDR = "Storgata 1, 1400 Ski";
  const GPHONE = "+4712345678";

  function insertAgent(id: string, url: string): void {
    db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, created_at)
       VALUES (?, ?, 't', 't', '', ?, 'producer', ?, 'rfb', '2026-01-01 00:00:00')`,
    ).run(id, id, url, `key-${id}`);
  }

  function fieldSourceCount(explainBody: any, field: string): number {
    return explainBody?.agents?.[0]?.signals?.provenance_source_counts?.[field] ?? 0;
  }

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;
    process.env.GOOGLE_PLACES_API_KEY = "test-places-key";

    delete require.cache[require.resolve("./marketplace")];
    const marketplaceRouter = require("./marketplace").default as any;
    delete require.cache[require.resolve("./admin-pool-blocker-explain")];
    const poolBlockerExplainRouter = require("./admin-pool-blocker-explain").default as any;

    (globalThis as any).fetch = async (url: string) => {
      if (typeof url === "string" && url.includes("places.googleapis.com")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            places: [{ id: "place-1", rating: 4.5, userRatingCount: 10, formattedAddress: GADDR, internationalPhoneNumber: GPHONE }],
          }),
        } as any;
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as any;
    };

    async function runBatch(agentId: string): Promise<any> {
      const r = await callRoute(marketplaceRouter, {
        method: "POST",
        url: "/admin/google-rating-batch",
        headers: { "x-admin-key": ADMIN_KEY, "content-type": "application/json" },
        body: { agentIds: [agentId], include_address_phone: true, max_details_calls: 0 },
      });
      return r;
    }

    async function explain(agentId: string): Promise<any> {
      const r = await callRoute(poolBlockerExplainRouter, {
        method: "GET",
        url: `/?agentId=${agentId}`,
        headers: { "x-admin-key": ADMIN_KEY },
      });
      return r.body;
    }

    // ════════════════════════════════════════════════════════════════════
    // A1. THE BUG (address) — empty address column + a STALE pre-existing
    // "google_places" provenance entry with the identical value Google will
    // return this call (the state left behind by an external blank-without-
    // clearing-provenance write-site, e.g. applyPhoneBlank's phone=NULL
    // sibling pattern for address).
    // ════════════════════════════════════════════════════════════════════
    {
      const id = "a1-stale-address-refill";
      insertAgent(id, `https://${id}.example.com`);
      const staleProv = JSON.stringify({
        address: { sources: [{ source_type: "google_places", value: GADDR, fetched_at: "2026-01-01T00:00:00.000Z" }] },
      });
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, address, phone, field_provenance) VALUES (?, NULL, NULL, ?)`,
      ).run(id, staleProv);

      const before = await explain(id);
      assertEq(fieldSourceCount(before, "address"), 1, "A1a: before the call, pool-blocker-explain already shows the stale 1 source for address");

      const batchResult = await runBatch(id);
      const result = batchResult.body?.data?.results?.[0];
      assertEq(result?.addressWritten, true, "A1b: response reports addressWritten:true (the column really was empty and really did get written)");

      const row = db.prepare(`SELECT address FROM agent_knowledge WHERE agent_id = ?`).get(id) as any;
      assertEq(row.address, GADDR, "A1c: address column genuinely holds the freshly-fetched value");

      const after = await explain(id);
      assertEq(fieldSourceCount(after, "address"), 2, "A1d (THE FIX): pool-blocker-explain now shows source_count=2 for address — the fresh write is no longer silently swallowed by the stale-entry dedup");
    }

    // ════════════════════════════════════════════════════════════════════
    // A2. THE BUG (phone) — same mechanism, on the phone field. Matches the
    // "Alm Gård — Feios" production report specifically (2026-09-05,
    // phone). Phone's only real-world contributing source_type is
    // "google_places" (BRREG has no phone field, per PR-82's own header
    // comment), so this is the field where the stale-refill collision is
    // most likely to reproduce in production.
    // ════════════════════════════════════════════════════════════════════
    {
      const id = "a2-stale-phone-refill";
      insertAgent(id, `https://${id}.example.com`);
      const staleProv = JSON.stringify({
        phone: { sources: [{ source_type: "google_places", value: GPHONE, fetched_at: "2026-01-01T00:00:00.000Z" }] },
      });
      // Address already filled so this call's write is isolated to phone.
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, address, phone, field_provenance) VALUES (?, ?, NULL, ?)`,
      ).run(id, GADDR, staleProv);

      const before = await explain(id);
      assertEq(fieldSourceCount(before, "phone"), 1, "A2a: before the call, pool-blocker-explain already shows the stale 1 source for phone");

      const batchResult = await runBatch(id);
      const result = batchResult.body?.data?.results?.[0];
      assertEq(result?.phoneWritten, true, "A2b: response reports phoneWritten:true (the column really was empty and really did get written)");

      const row = db.prepare(`SELECT phone FROM agent_knowledge WHERE agent_id = ?`).get(id) as any;
      assertEq(row.phone, GPHONE, "A2c: phone column genuinely holds the freshly-fetched value");

      const after = await explain(id);
      assertEq(fieldSourceCount(after, "phone"), 2, "A2d (THE FIX): pool-blocker-explain now shows source_count=2 for phone");
    }

    // ════════════════════════════════════════════════════════════════════
    // B. Working-as-designed dedup — column ALREADY populated (a genuine
    // earlier successful write) + an identical repeat Google answer → must
    // NOT double-count and must NOT report *Written:true again. This is
    // the case dedup exists to protect, and the fix must not regress it.
    // ════════════════════════════════════════════════════════════════════
    {
      const id = "b-repeat-already-written";
      insertAgent(id, `https://${id}.example.com`);
      const existingProv = JSON.stringify({
        address: { sources: [{ source_type: "google_places", value: GADDR, fetched_at: "2026-01-01T00:00:00.000Z" }] },
        phone: { sources: [{ source_type: "google_places", value: GPHONE, fetched_at: "2026-01-01T00:00:00.000Z" }] },
      });
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, address, phone, field_provenance, google_enterprise_fetched_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      ).run(id, GADDR, GPHONE, existingProv);

      const before = await explain(id);
      assertEq(fieldSourceCount(before, "address"), 1, "Ba: before the repeat call, address source_count is 1 (the genuine earlier write)");
      assertEq(fieldSourceCount(before, "phone"), 1, "Bb: before the repeat call, phone source_count is 1");

      const batchResult = await runBatch(id);
      const result = batchResult.body?.data?.results?.[0];
      assertEq(result?.addressWritten, false, "Bc: repeat call on an already-populated column reports addressWritten:false (fill-only, nothing to write)");
      assertEq(result?.phoneWritten, false, "Bd: repeat call on an already-populated column reports phoneWritten:false");

      const after = await explain(id);
      assertEq(fieldSourceCount(after, "address"), 1, "Be (no regression): identical repeat answer does NOT add a 2nd address entry — dedup still works for the already-populated case");
      assertEq(fieldSourceCount(after, "phone"), 1, "Bf (no regression): identical repeat answer does NOT add a 2nd phone entry");
    }

    // ════════════════════════════════════════════════════════════════════
    // C. AC2's literal scenario — empty column + a pre-existing 1-source
    // entry of a DIFFERENT source_type ("homepage") → a *Written:true call
    // reaches source_count=2. Already worked before this fix (dedupKey
    // differs by source_type); kept as a regression guard.
    // ════════════════════════════════════════════════════════════════════
    {
      const id = "c-ac2-different-source-type";
      insertAgent(id, `https://${id}.example.com`);
      const existingProv = JSON.stringify({
        address: { sources: [{ source_type: "homepage", value: GADDR, fetched_at: "2026-01-01T00:00:00.000Z" }] },
      });
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, address, phone, field_provenance) VALUES (?, NULL, NULL, ?)`,
      ).run(id, existingProv);

      const batchResult = await runBatch(id);
      const result = batchResult.body?.data?.results?.[0];
      assertEq(result?.addressWritten, true, "Ca: AC2 scenario reports addressWritten:true");

      const after = await explain(id);
      assertEq(fieldSourceCount(after, "address"), 2, "Cb (AC2, regression guard): source_count reaches 2 (homepage + google_places)");
    }

    // ════════════════════════════════════════════════════════════════════
    // D. AC3 sanity — a genuine first-ever fill (no prior provenance at
    // all) still reports *Written:true / correct rating fields exactly as
    // before; the fix doesn't alter this shape (only the PHONE/ADDRESS
    // written flags feed the GOOGLE_RATINGS_ADDED envelope counter, per
    // the enrichment SKILL PHASE 6 — unaffected by this fix, which only
    // touches what gets merged into field_provenance).
    // ════════════════════════════════════════════════════════════════════
    {
      const id = "d-ac3-fresh-fill-sanity";
      insertAgent(id, `https://${id}.example.com`);
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, address, phone, field_provenance) VALUES (?, NULL, NULL, '{}')`,
      ).run(id);

      const batchResult = await runBatch(id);
      const result = batchResult.body?.data?.results?.[0];
      assertEq(result?.addressWritten, true, "Da: fresh fill still reports addressWritten:true");
      assertEq(result?.phoneWritten, true, "Db: fresh fill still reports phoneWritten:true");
      assertEq(result?.googleRating, 4.5, "Dc: googleRating unaffected by the fix");
      assertEq(result?.googleReviewCount, 10, "Dd: googleReviewCount unaffected by the fix");

      const after = await explain(id);
      assertEq(fieldSourceCount(after, "address"), 1, "De: a genuine first-ever fill correctly yields exactly 1 source (not fabricated to 2)");
      assertEq(fieldSourceCount(after, "phone"), 1, "Df: a genuine first-ever fill correctly yields exactly 1 source for phone too");
    }
  } catch (err: any) {
    failed++;
    failures.push(
      "google-rating-batch-provenance-stale-refill: unexpected error: " + String(err?.stack || err?.message || err),
    );
  } finally {
    (globalThis as any).fetch = prevFetch;
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
    else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevPlacesKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
    else process.env.GOOGLE_PLACES_API_KEY = prevPlacesKey;
    try {
      if (prevDb) initMod.__setDbForTesting(prevDb);
    } catch {
      /* best-effort restore */
    }
  }

  return { passed, failed, failures };
}

// Standalone runner: npx tsx src/routes/google-rating-batch-provenance-stale-refill.test.ts
if (require.main === module) {
  runGoogleRatingBatchProvenanceStaleRefillTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
