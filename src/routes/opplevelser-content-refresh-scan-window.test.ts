/**
 * opplevelser-content-refresh-scan-window.test.ts — regression tests for the
 * 2026-08-01 selector-window fix to selectProvidersForContentRefresh()
 * (src/services/experience-store.ts) / POST /admin/content-refresh
 * (src/routes/opplevelser.ts).
 *
 * THE BUG: `last_content_attempt_at` is stamped ONLY on providers that are
 * actually processed by POST /admin/content-refresh (markProviderContentAttempted,
 * called unconditionally in apply mode before the fetch). A candidate the SQL
 * pre-filter fetches but the JS classifyProviderContentBucket() step then
 * discards as not-"enrichable" is NEVER stamped — it keeps
 * last_content_attempt_at IS NULL and therefore sorts first FOREVER under the
 * NULLs-first `ORDER BY (last_content_attempt_at IS NOT NULL), ...`. Once that
 * permanently-NULL clump of non-enrichable rows grows past a single SQL
 * fetch window, it silently buries every genuinely-enrichable row behind it —
 * the old single-shot selector then returned 0 candidates regardless of how
 * many enrichable providers actually existed further down the table
 * (measured live in prod 2026-07-31: limit=3 -> window 200 -> scanned=0;
 * limit=25 -> window 300 -> scanned=0; limit=100 -> window 1000 ->
 * scanned=88). Downstream cron reporting read that empty result as
 * `stop_reason: real-exhaustion` (genuine cohort exhaustion) when it was
 * actually window starvation.
 *
 * THE FIX: selectProvidersForContentRefresh() now pages through the SAME SQL
 * pre-filter/ORDER BY with an advancing OFFSET, filtering each page in JS,
 * until (a) `cap` enrichable providers are found, (b) the SQL side is
 * genuinely exhausted (a page returns fewer rows than requested), or (c) the
 * hard CONTENT_REFRESH_HARD_SCAN_CAP scan-budget is spent. It now returns
 * { targets, scanned, stopReason } instead of a bare array, and the route
 * threads stopReason through as `stop_reason` in its JSON response.
 *
 * Fixtures use direct bulk SQL inserts (not createProvider/createExperience)
 * for the large (350-/5000+-row) cohorts purely for speed — better-sqlite3
 * transaction-wrapped inserts of a few thousand rows are near-instant, while
 * going through the full validated store API for each row would not be.
 * created_at is stamped explicitly with strictly increasing timestamps (1s
 * apart) rather than relying on the DEFAULT — several rows landing in the
 * same DEFAULT (datetime('now')) second would make the created_at ASC
 * tiebreak (used once every row's last_content_attempt_at is NULL, which is
 * the whole point of this fixture) non-deterministic.
 *
 * Covers (mapped to the dev-request's acceptance criteria):
 *   (A1) [criterion 4] THE BUG REPRODUCTION: 350 non-enrichable providers
 *        (last_content_attempt_at IS NULL, created before) stacked in front
 *        of ONE enrichable provider — N=350 exceeds the old single-shot
 *        window for limit=25 (300 rows) — the fix still finds and returns
 *        the enrichable provider, with scanned > 300 (proof it paged past
 *        the old window) and stopReason "real-exhaustion" (only one
 *        enrichable provider exists in the whole cohort, so cap is never
 *        reached, but nothing is left to page through either — the honest
 *        "nothing left" case, correctly distinguished from cap_reached).
 *        This exact scenario was verified to fail against the pre-fix
 *        single-shot selector (git HEAD before this change) before this test
 *        was finalized — see the fix's commit message.
 *   (A2) [criterion 2] SAME fixture, cap varied (3 / 25 / 100): every cap
 *        finds the one enrichable provider and reports scanned > 0 — no
 *        longer monotonically dependent on limit the way the old
 *        window-sizing was (old code needed limit=100, window=1000, to find
 *        this exact provider; limit=3/25 returned nothing).
 *   (A3) [criterion 3, cap_reached] 40 enrichable providers, no non-enrichable
 *        rows ahead -> limit=10 finds exactly 10 and reports "cap_reached".
 *   (A4) [criterion 3, scan_cap_reached] 5050 non-enrichable providers and
 *        ZERO enrichable ones -> the hard scan-cap stops the search at
 *        exactly CONTENT_REFRESH_HARD_SCAN_CAP scanned rows and reports
 *        "scan_cap_reached", NOT "real-exhaustion" — the SQL side still had
 *        more (unscanned) rows left; the two stop reasons must not be
 *        conflated.
 *   (B1) [criterion 1] End-to-end through the REAL route: dry-run
 *        POST /admin/content-refresh against the same shaped fixture as A1
 *        (350 non-enrichable ahead of 1 enrichable) at the routine's own
 *        default limit (25) returns scanned > 0 and surfaces the enrichable
 *        provider in `changed` — the exact case that returned scanned=0 in
 *        prod. Also confirms `stop_reason` is wired through to the route's
 *        JSON response.
 *   (B2) [criterion 5] Write-behavior regression: apply=true against a
 *        provider with one LOCKED (verified) thin experience and one
 *        UNLOCKED thin experience, addressed via explicit providerIds (so
 *        this exercises ONLY the untouched write/apply path, decoupled from
 *        the selector change) — skipped_locked and by_field behave exactly
 *        as before (fill-only rule + lock guard untouched by this fix).
 *        Also confirms stop_reason is null for an explicit-providerIds
 *        request (no candidate scan ran).
 */

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
  opts: {
    method?: "GET" | "POST";
    url?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const url = opts.url || "/admin/content-refresh";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() { return undefined; },
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
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runOpplevelserContentRefreshScanWindowTests(
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

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevFetch = globalThis.fetch;
    const testKey = "content-refresh-scan-window-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, expStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      // `let`, not `const`: (A3) and (A4) below each reset the db-factory
      // and reassign this to a FRESH :memory: handle so each scenario's
      // cohort is isolated — otherwise leftover enrichable rows from an
      // earlier scenario would satisfy a later scenario's cap before its
      // own fixture is ever reached (e.g. (A3)'s 40 enrichable rows would
      // silently fill (A4)'s cap and turn its intended scan_cap_reached
      // case into a cap_reached one).
      let db = dbFactory.getDb("experiences");

      // Bulk-insert `count` providers whose sole experience is UNLOCKED and
      // matches the SQL pre-filter's EXISTS clause, but is genuinely NOT thin
      // (description AND category both already non-blank with no recorded
      // content_field_evidence — isContentFieldHomepageSourced treats an
      // evidence-less non-blank value as "unknown provenance -> keep", i.e.
      // homepage-sourced, i.e. NOT thin) — classifyProviderContentBucket()
      // therefore returns "done", not "enrichable". last_content_attempt_at
      // is left NULL (never touched by a real content-refresh attempt),
      // exactly reproducing the permanently-first-sorting clump the bug
      // depends on. created_at is strictly increasing (1s apart, explicit)
      // so ordering is deterministic.
      function seedNonEnrichableCohort(idPrefix: string, count: number, baseTimeMs: number): void {
        const insertProvider = db.prepare(
          `INSERT INTO experience_providers
             (id, org_nr, navn, hjemmeside, verification_status, brreg_verified, brreg_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'verified', 1, 1, ?, ?)`
        );
        const insertExperience = db.prepare(
          `INSERT INTO experiences
             (id, provider_id, title, description, category, verification_status, content_source,
              provider_match_status, fylke, kommune, confidence, created_at, updated_at)
           VALUES (?, ?, ?, 'Ferdig beskrivelse fra egen side.', 'mat_drikke', 'pending_verify', NULL,
                   'matched', 'Troms', 'Tromsø', 'high', ?, ?)`
        );
        const tx = db.transaction((n: number) => {
          for (let i = 0; i < n; i++) {
            const ts = new Date(baseTimeMs + i * 1000).toISOString();
            const pid = `${idPrefix}-p-${i}`;
            const eid = `${idPrefix}-e-${i}`;
            insertProvider.run(pid, `${idPrefix}${String(i).padStart(6, "0")}`, `Done Provider ${idPrefix} ${i}`, `https://done-${idPrefix}-${i}.example`, ts, ts);
            insertExperience.run(eid, pid, `Done opplevelse ${idPrefix} ${i}`, ts, ts);
          }
        });
        tx(count);
      }

      // Bulk-insert `count` providers that ARE enrichable (blank description
      // AND category on their sole, unlocked experience), same determinism
      // conventions as seedNonEnrichableCohort above.
      function seedEnrichableCohort(idPrefix: string, count: number, baseTimeMs: number, hjemmesidePrefix: string): string[] {
        const insertProvider = db.prepare(
          `INSERT INTO experience_providers
             (id, org_nr, navn, hjemmeside, verification_status, brreg_verified, brreg_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'verified', 1, 1, ?, ?)`
        );
        const insertExperience = db.prepare(
          `INSERT INTO experiences
             (id, provider_id, title, verification_status, content_source,
              provider_match_status, fylke, kommune, confidence, created_at, updated_at)
           VALUES (?, ?, ?, 'pending_verify', NULL, 'matched', 'Troms', 'Tromsø', 'high', ?, ?)`
        );
        const ids: string[] = [];
        const tx = db.transaction((n: number) => {
          for (let i = 0; i < n; i++) {
            const ts = new Date(baseTimeMs + i * 1000).toISOString();
            const pid = `${idPrefix}-p-${i}`;
            const eid = `${idPrefix}-e-${i}`;
            insertProvider.run(pid, `${idPrefix}${String(i).padStart(6, "0")}`, `Enrichable Provider ${idPrefix} ${i}`, `https://${hjemmesidePrefix}-${i}.example`, ts, ts);
            insertExperience.run(eid, pid, `Enrichable opplevelse ${idPrefix} ${i}`, ts, ts);
            ids.push(pid);
          }
        });
        tx(count);
        return ids;
      }

      // ═══════════════════════════════════════════════════════════════════
      // (A1)/(A2): the bug-shaped fixture — 350 non-enrichable ahead of 1
      // enrichable provider, N=350 exceeds the old limit=25 window (300).
      // ═══════════════════════════════════════════════════════════════════
      const base1 = Date.parse("2026-01-01T00:00:00.000Z");
      seedNonEnrichableCohort("bug", 350, base1);
      const enrichableIds1 = seedEnrichableCohort("bug-enr", 1, base1 + 350_000, "enrichable-bug");
      const enrichableId1 = enrichableIds1[0];

      // (A1) limit=25 (the routine's own default): old single-shot window
      // (300 rows) would never reach row 351 — the enrichable provider — and
      // would have returned 0. The fix pages past it.
      const selA1 = expStore.selectProvidersForContentRefresh(25);
      assertTrue(
        selA1.targets.some((t) => t.id === enrichableId1),
        "a1-1: THE FIX — limit=25 selection finds the enrichable provider stacked behind 350 non-enrichable NULL-attempt rows (old window=300 could not)",
      );
      assertTrue(
        selA1.scanned > 300,
        `a1-2: selector scanned more than the old single-shot window (300) to find it — scanned=${selA1.scanned}`,
      );
      assertEq(
        selA1.stopReason,
        "real-exhaustion",
        "a1-3: only one enrichable provider exists in the whole 351-row cohort — cap (25) is never reached, but the SQL side is genuinely tapped out afterward -> honest real-exhaustion",
      );
      assertTrue(selA1.targets.length < 25, "a1-4: sanity — fewer than cap were found (only 1 enrichable exists), so real-exhaustion (not cap_reached) is the only honest label");

      // (A2) [criterion 2] varying ONLY the cap against the SAME static
      // fixture (selectProvidersForContentRefresh is read-only — no state
      // mutation between calls) — every cap must find the provider and
      // report scanned > 0. Before the fix this was monotonically dependent
      // on limit (limit=3/25 -> window too small -> 0; limit=100 -> window
      // 1000 -> found).
      for (const cap of [3, 25, 100]) {
        const sel = expStore.selectProvidersForContentRefresh(cap);
        assertTrue(
          sel.targets.some((t) => t.id === enrichableId1),
          `a2-${cap}a: cap=${cap} still finds the enrichable provider (no longer limit-dependent)`,
        );
        assertTrue(sel.scanned > 0, `a2-${cap}b: cap=${cap} reports scanned > 0 (was 0 in prod at cap=3/25 before this fix) — scanned=${sel.scanned}`);
      }

      // ═══════════════════════════════════════════════════════════════════
      // (A3) [criterion 3, cap_reached]: 40 enrichable providers, nothing
      // ahead of them -> limit=10 finds exactly 10 and reports cap_reached.
      // Fresh DB (see the `let db` comment above) so (A1)/(A2)'s single
      // enrichable provider can't skew the exact-10 count.
      // ═══════════════════════════════════════════════════════════════════
      dbFactory.__resetDbFactoryForTesting();
      db = dbFactory.getDb("experiences");
      const base3 = Date.parse("2026-02-01T00:00:00.000Z");
      seedEnrichableCohort("capfound", 40, base3, "capfound-host");
      const selA3 = expStore.selectProvidersForContentRefresh(10);
      assertEq(selA3.targets.length, 10, "a3-1: limit=10 against 40 available enrichable providers returns exactly 10");
      assertEq(selA3.stopReason, "cap_reached", "a3-2: stopReason is cap_reached — cap was filled before the SQL side ran out or the scan budget was hit");

      // ═══════════════════════════════════════════════════════════════════
      // (A4) [criterion 3, scan_cap_reached]: 5050 non-enrichable providers,
      // ZERO enrichable ones anywhere -> the hard scan cap
      // (CONTENT_REFRESH_HARD_SCAN_CAP = 5000) must stop the search before
      // the SQL side is exhausted, and report scan_cap_reached — NOT
      // real-exhaustion (there genuinely IS more left, just not scanned).
      // Fresh DB again — (A3)'s 40 enrichable rows must not leak in and
      // fill this scenario's cap before the scan-cap budget is even tested.
      // ═══════════════════════════════════════════════════════════════════
      dbFactory.__resetDbFactoryForTesting();
      db = dbFactory.getDb("experiences");
      const base4 = Date.parse("2026-03-01T00:00:00.000Z");
      seedNonEnrichableCohort("hardcap", 5050, base4);
      const selA4 = expStore.selectProvidersForContentRefresh(25);
      assertEq(selA4.targets.length, 0, "a4-1: no enrichable providers exist in this cohort -> 0 targets found");
      assertEq(
        selA4.scanned,
        expStore.CONTENT_REFRESH_HARD_SCAN_CAP,
        `a4-2: scanned stops exactly at CONTENT_REFRESH_HARD_SCAN_CAP (${expStore.CONTENT_REFRESH_HARD_SCAN_CAP}), not the full 5050-row cohort`,
      );
      assertEq(
        selA4.stopReason,
        "scan_cap_reached",
        "a4-3: stopReason is scan_cap_reached (bounded budget stopped the search), NOT real-exhaustion — the SQL side genuinely had more (unscanned) rows left",
      );

      // ═══════════════════════════════════════════════════════════════════
      // (B1) [criterion 1]: end-to-end through the REAL route. Fresh DB,
      // same bug shape as (A1) but smaller (60 non-enrichable ahead of 1
      // enrichable — still exceeds a small cap's window) to keep the mocked
      // fetch call count trivial (only the ONE selected provider is ever
      // fetched — selection happens server-side before any network call).
      // ═══════════════════════════════════════════════════════════════════
      dbFactory.__resetDbFactoryForTesting();
      const db2 = dbFactory.getDb("experiences");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      function seedNonEnrichableCohortOn(targetDb: typeof db2, idPrefix: string, count: number, baseTimeMs: number): void {
        const insertProvider = targetDb.prepare(
          `INSERT INTO experience_providers
             (id, org_nr, navn, hjemmeside, verification_status, brreg_verified, brreg_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'verified', 1, 1, ?, ?)`
        );
        const insertExperience = targetDb.prepare(
          `INSERT INTO experiences
             (id, provider_id, title, description, category, verification_status, content_source,
              provider_match_status, fylke, kommune, confidence, created_at, updated_at)
           VALUES (?, ?, ?, 'Ferdig beskrivelse fra egen side.', 'mat_drikke', 'pending_verify', NULL,
                   'matched', 'Troms', 'Tromsø', 'high', ?, ?)`
        );
        const tx = targetDb.transaction((n: number) => {
          for (let i = 0; i < n; i++) {
            const ts = new Date(baseTimeMs + i * 1000).toISOString();
            const pid = `${idPrefix}-p-${i}`;
            const eid = `${idPrefix}-e-${i}`;
            insertProvider.run(pid, `${idPrefix}${String(i).padStart(6, "0")}`, `Done Provider ${idPrefix} ${i}`, `https://done-${idPrefix}-${i}.example`, ts, ts);
            insertExperience.run(eid, pid, `Done opplevelse ${idPrefix} ${i}`, ts, ts);
          }
        });
        tx(count);
      }

      const baseB1 = Date.parse("2026-04-01T00:00:00.000Z");
      seedNonEnrichableCohortOn(db2, "rb1", 60, baseB1);
      const enrProviderB1 = expStore.createProvider({
        navn: "Route Fixture Gard AS", org_nr: "900700800",
        fylke: "Troms", kommune: "Tromsø",
        hjemmeside: "https://route-scan-window.example",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      db2.prepare("UPDATE experience_providers SET created_at = ? WHERE id = ?")
        .run(new Date(baseB1 + 60_000).toISOString(), enrProviderB1);
      const enrExpB1 = expStore.createExperience({
        title: "Route fixture opplevelse", provider_id: enrProviderB1, provider_match_status: "matched",
        fylke: "Troms", kommune: "Tromsø", confidence: "high", verification_status: "pending_verify",
      });

      const ABOUT_TEXT =
        "Vi er en liten familiegård som tilbyr omvisning, dyrekontakt og salg av egne varer rett fra tunet hele sommeren.";
      globalThis.fetch = (async (url: string | URL | Request) => {
        const host = new URL(String(url)).hostname;
        if (host === "route-scan-window.example") {
          const html = `<html><head><meta property="og:description" content="${ABOUT_TEXT}"></head><body></body></html>`;
          return {
            ok: true, status: 200,
            arrayBuffer: async () => new Uint8Array(Buffer.from(html, "utf-8")).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        // Any other host being fetched at all would mean selection leaked a
        // non-enrichable candidate through to the network layer.
        return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } } as unknown as Response;
      }) as typeof fetch;

      const b1 = await callRoute(opplevelserRouter, {
        url: "/admin/content-refresh",
        headers: { "x-admin-key": testKey },
        body: { limit: 25 }, // dry-run by default
      });
      assertEq(b1.status, 200, "b1-1: POST /admin/content-refresh (dry-run, limit=25) -> 200");
      assertEq(b1.body.dry_run, true, "b1-2: dry-run by default (no apply flag)");
      assertTrue(
        b1.body.scanned > 0,
        `b1-3: THE FIX end-to-end — route's scanned > 0 against a fixture shaped exactly like the prod bug (was scanned=0 before this fix) — scanned=${b1.body.scanned}`,
      );
      assertTrue(
        Array.isArray(b1.body.changed) && b1.body.changed.some((c: any) => c.provider_id === enrProviderB1),
        "b1-4: the enrichable provider (buried behind 60 non-enrichable NULL-attempt rows) is surfaced in `changed`",
      );
      assertEq(
        b1.body.stop_reason,
        "real-exhaustion",
        "b1-5: stop_reason is wired through to the route's JSON response — only one enrichable provider exists here, cap not reached, SQL genuinely tapped out",
      );

      // ═══════════════════════════════════════════════════════════════════
      // (B2) [criterion 5]: write-behavior regression, via explicit
      // providerIds (bypasses the selector entirely — isolates the untouched
      // apply/write path from this fix's selection-side change).
      // ═══════════════════════════════════════════════════════════════════
      const provB2 = expStore.createProvider({
        navn: "Skriv Gard AS", org_nr: "900900100",
        fylke: "Troms", kommune: "Tromsø",
        hjemmeside: "https://write-regression.example",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const lockedExpB2 = expStore.createExperience({
        title: "Låst opplevelse", provider_id: provB2, provider_match_status: "matched",
        fylke: "Troms", kommune: "Tromsø", confidence: "high", verification_status: "verified",
      });
      const unlockedExpB2 = expStore.createExperience({
        title: "Ulåst opplevelse", provider_id: provB2, provider_match_status: "matched",
        fylke: "Troms", kommune: "Tromsø", confidence: "high", verification_status: "pending_verify",
      });

      globalThis.fetch = (async (url: string | URL | Request) => {
        const host = new URL(String(url)).hostname;
        if (host === "write-regression.example") {
          const html = `<html><head><meta property="og:description" content="${ABOUT_TEXT}"></head><body></body></html>`;
          return {
            ok: true, status: 200,
            arrayBuffer: async () => new Uint8Array(Buffer.from(html, "utf-8")).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } } as unknown as Response;
      }) as typeof fetch;

      const b2 = await callRoute(opplevelserRouter, {
        url: "/admin/content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: [provB2], apply: true },
      });
      assertEq(b2.status, 200, "b2-1: POST /admin/content-refresh (apply, explicit providerIds) -> 200");
      assertEq(b2.body.dry_run, false, "b2-2: apply=true -> dry_run false");
      assertEq(b2.body.stop_reason, null, "b2-3: stop_reason is null for an explicit-providerIds request (no candidate scan ran)");
      assertTrue(
        Array.isArray(b2.body.skipped_locked) &&
          b2.body.skipped_locked.some((s: any) => s.provider_id === provB2 && s.experience_ids.includes(lockedExpB2)),
        "b2-4: the LOCKED (verified) experience is reported in skipped_locked — lock guard unchanged",
      );
      assertEq(b2.body.by_field.description, 1, "b2-5: exactly one description write (the UNLOCKED experience only) — fill-only rule unchanged");
      assertTrue(
        Array.isArray(b2.body.changed) && b2.body.changed.some((c: any) => c.provider_id === provB2 && c.fields.includes("description")),
        "b2-6: provider reported in `changed` with description among the written fields",
      );
      const lockedRowB2 = db2.prepare("SELECT description FROM experiences WHERE id = ?").get(lockedExpB2) as { description: string | null };
      assertEq(lockedRowB2.description, null, "b2-7: the LOCKED experience's description was NOT written (still blank)");
      const unlockedRowB2 = db2.prepare("SELECT description FROM experiences WHERE id = ?").get(unlockedExpB2) as { description: string | null };
      assertEq(unlockedRowB2.description, ABOUT_TEXT, "b2-8: the UNLOCKED experience's description WAS written with the extracted text");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-content-refresh-scan-window: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      if (prevAdminKey === undefined) {
        delete process.env.ADMIN_KEY;
      } else {
        process.env.ADMIN_KEY = prevAdminKey;
      }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevelser-content-refresh-scan-window.test.ts`
if (require.main === module) {
  runOpplevelserContentRefreshScanWindowTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
