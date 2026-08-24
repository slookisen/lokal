/**
 * admin-gardssalg-review-queues-staleness.test.ts — unit tests for
 * GET /api/opplevelser/admin/gardssalg-review-queues-staleness
 * (src/routes/opplevelser.ts).
 *
 * dev-request 2026-08-15-orgnr-review-koe-stale-varsling: Daniel (live
 * session) asked for gårdssalg's two human-review queues
 * (gardssalg_orgnr_review_queue / gardssalg_website_review_queue) to stop
 * silently going stale — the fix is reporting-only, surfacing stale entries
 * in the daily brief. This route is the read half a sibling daily-brief
 * SKILL section will consume; it invents no new computation, it wires the
 * already-tested computeGardssalgQueueAgeReport() (AK9) over each queue's
 * own lister — the SAME 2-line call pattern POST
 * /admin/gardssalg-veien-til-pool already proves correct (see
 * opplevelser-veien-til-pool-skive2.test.ts's vtp2-21). Zero new SQL, zero
 * new writes.
 *
 * Harness: mirrors opplevelser-veien-til-pool-skive2.test.ts exactly — a
 * real db-factory-backed in-memory "experiences" DB (EXPERIENCES_DB_PATH=
 * ":memory:"), fresh require of db-factory/experience-store/opplevelser so
 * this file never runs against a stale module instance, and Router.handle()
 * dispatch (not a real HTTP server) so the actual requireAdmin middleware
 * chain — not just the inner handler — is exercised.
 *
 * Covers:
 *   s1  empty queues -> both reports show count:0, stale_count:0,
 *       oldest_first:[]
 *   s2  a queue row older than GS_VTP_QUEUE_STALE_DAYS -> appears in
 *       oldest_first with stale:true, counted in stale_count
 *   s3  a queue row with a fresh (today) created_at -> stale:false, NOT
 *       counted in stale_count
 *   s4  both queues covered independently in ONE response — a stale row in
 *       EACH queue makes both stale_counts 1, independently of each other
 *   s5  no X-Admin-Key header -> 403 (same status the neighbouring
 *       /admin/gardssalg-orgnr-review-queue GET route's own tests assert)
 *
 * Grep 8 slice 1 — the report gained a THIRD queue,
 * experience_homepage_review_queue (the M0c / generic listing-homepage
 * queue). It is the only one of the three whose approve lever MARKS the row
 * (`status='approved'` + `resolved_at`) instead of DELETING it, so it is read
 * through listExperienceHomepageReviewQueuePending()'s `status='pending'`
 * filter — without which every historically-resolved candidate would be
 * counted as still-queued and, since `created_at` never moves, reported as
 * permanently stale. s9 is the guard on exactly that.
 *
 *   s6  empty homepage queue -> experience_homepage_review_queue present with
 *       count:0, stale_count:0, oldest_first:[]
 *   s7  a pending homepage row older than GS_VTP_QUEUE_STALE_DAYS ->
 *       stale:true, counted in stale_count
 *   s8  a fresh (today) pending homepage row -> stale:false, NOT counted
 *   s9  resolved rows (status 'approved' / 'rejected') are EXCLUDED entirely:
 *       1 pending + 2 resolved -> count:1, and the returned row is the
 *       pending one
 *   s10 all THREE queues reported independently in ONE response, with the two
 *       pre-existing keys keeping their exact prior shape/values (regression
 *       guard for the daily-brief SKILL that already consumes them)
 *
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/routes/admin-gardssalg-review-queues-staleness.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runAdminGardssalgReviewQueuesStalenessTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  return (async () => {
    const prevExpPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = process.env.ADMIN_KEY || "stale-varsling-test-key";
    const testKey = process.env.ADMIN_KEY;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const opplevelserModule = require("./opplevelser") as typeof import("./opplevelser");
      const opplevelserRouter = opplevelserModule.default as any;

      const call = (
        query: Record<string, string> = {},
        reqExtra: Record<string, unknown> = {},
      ): Promise<{ status: number; body: any }> => {
        const path = "/admin/gardssalg-review-queues-staleness";
        const req: any = {
          method: "GET",
          url: path,
          originalUrl: `/api/opplevelser${path}`,
          path,
          query,
          body: {},
          headers: { "x-admin-key": testKey },
          get(n: string) { return this.headers[n.toLowerCase()]; },
          ...reqExtra,
        };
        let settle!: () => void;
        const done = new Promise<void>((r) => { settle = r; });
        const res: any = {
          statusCode: 200, _body: undefined,
          status(c: number) { this.statusCode = c; return this; },
          json(b: any) { this._body = b; settle(); return this; },
          send(b: any) { this._body = b; settle(); return this; },
        };
        opplevelserRouter.handle(req, res, () => settle());
        return done.then(() => ({ status: res.statusCode, body: res._body }));
      };

      // Same minimal experience_providers seeder skive2 uses — queue rows
      // carry a FK to experience_providers(id), so every seeded queue entry
      // needs a matching parent row.
      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, producer_type, hjemmeside, epost, telefon, org_nr, adresse,
            about_text, products, brreg_verified, catalog_hidden, slug, content_source,
            field_provenance, created_at)
         VALUES (@id, @navn, 'experiences', @pt, @hj, @ep, @tlf, @org_nr, @adresse,
                 @ab, @products, @brreg_verified, @catalog_hidden, @slug, @cs,
                 @field_provenance, @created)`
      );
      const seedProvider = (id: string, navn: string) =>
        insertProvider.run({
          id, navn, pt: "bryggeri", hj: null, ep: null, tlf: null, org_nr: null, adresse: null,
          ab: null, products: null, brreg_verified: 0, catalog_hidden: 0, slug: null,
          cs: null, field_provenance: null, created: "2026-01-01",
        });

      const insertOrgnrQueueRow = expDb.prepare(
        `INSERT INTO gardssalg_orgnr_review_queue
           (id, provider_id, provider_name, candidate_orgnr, candidate_name, candidate_confidence,
            candidate_address, reason, batch_id, created_at, updated_at)
         VALUES (@id, @provider_id, @provider_name, NULL, NULL, NULL, NULL, @reason, NULL, @created_at, @created_at)`
      );
      const insertWebsiteQueueRow = expDb.prepare(
        `INSERT INTO gardssalg_website_review_queue
           (id, provider_id, provider_name, candidate_url, final_url, evidence, confidence, reason, batch_id, created_at, updated_at)
         VALUES (@id, @provider_id, @provider_name, @candidate_url, NULL, NULL, NULL, @reason, NULL, @created_at, @created_at)`
      );
      // Grep 8 slice 1 — the third queue. Note it has NO updated_at (by
      // design) but DOES carry status/resolved_at, which is exactly what s9
      // exercises.
      const insertHomepageQueueRow = expDb.prepare(
        `INSERT INTO experience_homepage_review_queue
           (id, provider_id, provider_name, candidate_url, final_url, evidence, confidence, reason, batch_id, status, created_at, resolved_at)
         VALUES (@id, @provider_id, @provider_name, @candidate_url, NULL, NULL, NULL, @reason, NULL, @status, @created_at, @resolved_at)`
      );

      // SQLite-formatted UTC timestamp (space separator, no zone) — the
      // exact shape gsVtpParseSqliteUtcMs expects, matching datetime('now')
      // output and vtp2-6/vtp2-21's own fixtures.
      function sqliteUtcDaysAgo(days: number): string {
        return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
      }

      const staleThresholdDays = opplevelserModule.GS_VTP_QUEUE_STALE_DAYS;

      // ── s1: empty queues -> both reports zeroed out ──────────────────────
      {
        const r = await call();
        assertEq(r.status, 200, "s1a: empty queues -> 200");
        assertEq(r.body.orgnr_review_queue?.count, 0, "s1b: orgnr_review_queue.count 0");
        assertEq(r.body.orgnr_review_queue?.stale_count, 0, "s1c: orgnr_review_queue.stale_count 0");
        assertEq(JSON.stringify(r.body.orgnr_review_queue?.oldest_first), "[]", "s1d: orgnr_review_queue.oldest_first []");
        assertEq(r.body.website_review_queue?.count, 0, "s1e: website_review_queue.count 0");
        assertEq(r.body.website_review_queue?.stale_count, 0, "s1f: website_review_queue.stale_count 0");
        assertEq(JSON.stringify(r.body.website_review_queue?.oldest_first), "[]", "s1g: website_review_queue.oldest_first []");
        assertEq(r.body.orgnr_review_queue?.stale_threshold_days, staleThresholdDays, "s1h: threshold reported (orgnr)");
        assertEq(r.body.website_review_queue?.stale_threshold_days, staleThresholdDays, "s1i: threshold reported (website)");
        // dev-request 2026-08-23-opplevagent-drikke-selvforsyning-speiling,
        // item 3 — p95_age_days additive field, null on an empty queue.
        assertEq(r.body.orgnr_review_queue?.p95_age_days, null, "s1j: p95_age_days null on empty orgnr queue");
        assertEq(r.body.website_review_queue?.p95_age_days, null, "s1k: p95_age_days null on empty website queue");
      }

      // ── s2: a stale orgnr row (well over the threshold) ──────────────────
      {
        seedProvider("s2-orgnr-old", "Gammel Orgnr Gard");
        insertOrgnrQueueRow.run({
          id: "q-s2-old", provider_id: "s2-orgnr-old", provider_name: "Gammel Orgnr Gard",
          reason: "no_brreg_candidate", created_at: sqliteUtcDaysAgo(staleThresholdDays + 5),
        });

        const r = await call();
        assertEq(r.body.orgnr_review_queue?.count, 1, "s2a: orgnr_review_queue.count reflects the 1 seeded row");
        assertEq(r.body.orgnr_review_queue?.stale_count, 1, "s2b: the old row is counted stale");
        const row = (r.body.orgnr_review_queue?.oldest_first as any[])?.find((x) => x.provider_id === "s2-orgnr-old");
        assertTrue(!!row, "s2c: the old row is present in oldest_first");
        assertEq(row?.stale, true, "s2d: row carries stale:true");
        assertEq(row?.name, "Gammel Orgnr Gard", "s2e: row carries the provider name");
        assertEq(row?.reason, "no_brreg_candidate", "s2f: row carries the queue reason");
        assertTrue(typeof row?.age_days === "number" && row.age_days >= staleThresholdDays + 4, "s2g: age_days reflects the backdated created_at");
        // item 3 — with exactly 1 row, p95_age_days equals that row's own age.
        assertEq(r.body.orgnr_review_queue?.p95_age_days, row?.age_days, "s2h: p95_age_days equals the single row's age");
      }

      // ── s3: a fresh (today) orgnr row alongside the old one ──────────────
      {
        seedProvider("s3-orgnr-fresh", "Fersk Orgnr Gard");
        insertOrgnrQueueRow.run({
          id: "q-s3-fresh", provider_id: "s3-orgnr-fresh", provider_name: "Fersk Orgnr Gard",
          reason: "no_brreg_candidate", created_at: sqliteUtcDaysAgo(0),
        });

        const r = await call();
        assertEq(r.body.orgnr_review_queue?.count, 2, "s3a: orgnr_review_queue.count now 2 (old + fresh)");
        assertEq(r.body.orgnr_review_queue?.stale_count, 1, "s3b: stale_count STILL 1 — the fresh row is not counted");
        const freshRow = (r.body.orgnr_review_queue?.oldest_first as any[])?.find((x) => x.provider_id === "s3-orgnr-fresh");
        assertTrue(!!freshRow, "s3c: the fresh row is present in oldest_first");
        assertEq(freshRow?.stale, false, "s3d: fresh row carries stale:false");
        assertEq(freshRow?.age_days, 0, "s3e: fresh row's age_days is 0");
        // oldest-first ordering: the backdated s2 row must still sort ahead
        // of the fresh s3 row.
        const ids = (r.body.orgnr_review_queue?.oldest_first as any[]).map((x) => x.provider_id);
        assertTrue(ids.indexOf("s2-orgnr-old") < ids.indexOf("s3-orgnr-fresh"), "s3f: oldest-first ordering preserved");
      }

      // ── s4: both queues, independently — a stale row in EACH ─────────────
      {
        seedProvider("s4-website-old", "Gammel Nettsted Gard");
        insertWebsiteQueueRow.run({
          id: "q-s4-old", provider_id: "s4-website-old", provider_name: "Gammel Nettsted Gard",
          candidate_url: "https://gammel-nettsted-gard.example.no",
          reason: "website_discovery_candidate", created_at: sqliteUtcDaysAgo(staleThresholdDays + 3),
        });

        const r = await call();
        // orgnr side unaffected by the website-queue seed just now.
        assertEq(r.body.orgnr_review_queue?.stale_count, 1, "s4a: orgnr_review_queue.stale_count still 1 (unaffected by website queue)");
        assertEq(r.body.orgnr_review_queue?.count, 2, "s4b: orgnr_review_queue.count still 2 (unaffected by website queue)");
        // website side now carries its own, independent stale row.
        assertEq(r.body.website_review_queue?.count, 1, "s4c: website_review_queue.count reflects its own 1 seeded row");
        assertEq(r.body.website_review_queue?.stale_count, 1, "s4d: website_review_queue.stale_count 1, independently computed");
        const wRow = (r.body.website_review_queue?.oldest_first as any[])?.find((x) => x.provider_id === "s4-website-old");
        assertTrue(!!wRow, "s4e: the website-queue row is present in oldest_first");
        assertEq(wRow?.stale, true, "s4f: website-queue row carries stale:true");
        assertEq(wRow?.reason, "website_discovery_candidate", "s4g: website-queue row carries its own reason");
      }

      // ── s5: no X-Admin-Key header -> 403 (matches the neighbouring
      //       /admin/gardssalg-orgnr-review-queue GET route's own contract) ──
      {
        const r = await call({}, { headers: {} });
        assertEq(r.status, 403, "s5a: no X-Admin-Key -> 403");
        assertTrue(r.body?.orgnr_review_queue === undefined, "s5b: no-key response carries no queue payload");
      }

      // ── s6: homepage queue present and zeroed out while still empty ──────
      {
        const r = await call();
        assertEq(r.status, 200, "s6a: with the third queue wired in -> still 200");
        assertTrue(r.body?.experience_homepage_review_queue !== undefined, "s6b: experience_homepage_review_queue key present");
        assertEq(r.body.experience_homepage_review_queue?.count, 0, "s6c: experience_homepage_review_queue.count 0");
        assertEq(r.body.experience_homepage_review_queue?.stale_count, 0, "s6d: experience_homepage_review_queue.stale_count 0");
        assertEq(JSON.stringify(r.body.experience_homepage_review_queue?.oldest_first), "[]", "s6e: experience_homepage_review_queue.oldest_first []");
        assertEq(
          r.body.experience_homepage_review_queue?.stale_threshold_days,
          staleThresholdDays,
          "s6f: same threshold reported (no new threshold introduced)"
        );
      }

      // ── s7: a stale PENDING homepage row ─────────────────────────────────
      {
        seedProvider("s7-homepage-old", "Gammel Hjemmeside Gard");
        insertHomepageQueueRow.run({
          id: "q-s7-old", provider_id: "s7-homepage-old", provider_name: "Gammel Hjemmeside Gard",
          candidate_url: "https://gammel-hjemmeside-gard.example.no",
          reason: "listing_page_link_candidate", status: "pending",
          created_at: sqliteUtcDaysAgo(staleThresholdDays + 4), resolved_at: null,
        });

        const r = await call();
        assertEq(r.body.experience_homepage_review_queue?.count, 1, "s7a: homepage count reflects the 1 pending row");
        assertEq(r.body.experience_homepage_review_queue?.stale_count, 1, "s7b: the old pending row is counted stale");
        const row = (r.body.experience_homepage_review_queue?.oldest_first as any[])?.find((x) => x.provider_id === "s7-homepage-old");
        assertTrue(!!row, "s7c: the old pending row is present in oldest_first");
        assertEq(row?.stale, true, "s7d: row carries stale:true");
        assertEq(row?.name, "Gammel Hjemmeside Gard", "s7e: row carries the provider name");
        assertEq(row?.reason, "listing_page_link_candidate", "s7f: row carries the queue reason");
        assertTrue(typeof row?.age_days === "number" && row.age_days >= staleThresholdDays + 3, "s7g: age_days reflects the backdated created_at");
      }

      // ── s8: a fresh (today) PENDING homepage row alongside the old one ───
      {
        seedProvider("s8-homepage-fresh", "Fersk Hjemmeside Gard");
        insertHomepageQueueRow.run({
          id: "q-s8-fresh", provider_id: "s8-homepage-fresh", provider_name: "Fersk Hjemmeside Gard",
          candidate_url: "https://fersk-hjemmeside-gard.example.no",
          reason: "listing_page_link_candidate", status: "pending",
          created_at: sqliteUtcDaysAgo(0), resolved_at: null,
        });

        const r = await call();
        assertEq(r.body.experience_homepage_review_queue?.count, 2, "s8a: homepage count now 2 (old + fresh)");
        assertEq(r.body.experience_homepage_review_queue?.stale_count, 1, "s8b: stale_count STILL 1 — the fresh row is not counted");
        const freshRow = (r.body.experience_homepage_review_queue?.oldest_first as any[])?.find((x) => x.provider_id === "s8-homepage-fresh");
        assertTrue(!!freshRow, "s8c: the fresh row is present in oldest_first");
        assertEq(freshRow?.stale, false, "s8d: fresh row carries stale:false");
        assertEq(freshRow?.age_days, 0, "s8e: fresh row's age_days is 0");
      }

      // ── s9: RESOLVED rows are excluded entirely ──────────────────────────
      //
      // The load-bearing case. Unlike the two gårdssalg queues (which DELETE
      // a row on approval), this queue's approve lever sets status='approved'
      // + resolved_at and KEEPS the row. Reading the table unfiltered would
      // therefore count every historically-resolved candidate as still queued
      // — and since created_at never moves, every one of them would report as
      // permanently stale. Rebuild the table to the exact spec shape (1
      // pending + 2 resolved) so the count assertion is unambiguous.
      {
        expDb.prepare(`DELETE FROM experience_homepage_review_queue`).run();
        seedProvider("s9-homepage-pending", "Ventende Hjemmeside Gard");
        seedProvider("s9-homepage-approved", "Godkjent Hjemmeside Gard");
        seedProvider("s9-homepage-rejected", "Avvist Hjemmeside Gard");
        insertHomepageQueueRow.run({
          id: "q-s9-pending", provider_id: "s9-homepage-pending", provider_name: "Ventende Hjemmeside Gard",
          candidate_url: "https://ventende.example.no",
          reason: "listing_page_link_candidate", status: "pending",
          created_at: sqliteUtcDaysAgo(staleThresholdDays + 2), resolved_at: null,
        });
        insertHomepageQueueRow.run({
          id: "q-s9-approved", provider_id: "s9-homepage-approved", provider_name: "Godkjent Hjemmeside Gard",
          candidate_url: "https://godkjent.example.no",
          reason: "listing_page_link_candidate", status: "approved",
          created_at: sqliteUtcDaysAgo(staleThresholdDays + 90), resolved_at: sqliteUtcDaysAgo(1),
        });
        insertHomepageQueueRow.run({
          id: "q-s9-rejected", provider_id: "s9-homepage-rejected", provider_name: "Avvist Hjemmeside Gard",
          candidate_url: "https://avvist.example.no",
          reason: "listing_page_link_candidate", status: "rejected",
          created_at: sqliteUtcDaysAgo(staleThresholdDays + 60), resolved_at: sqliteUtcDaysAgo(2),
        });

        const r = await call();
        assertEq(r.body.experience_homepage_review_queue?.count, 1, "s9a: 1 pending + 2 resolved -> count 1, not 3");
        assertEq(r.body.experience_homepage_review_queue?.stale_count, 1, "s9b: only the pending row can be stale");
        const rows = (r.body.experience_homepage_review_queue?.oldest_first as any[]) ?? [];
        assertEq(rows.length, 1, "s9c: oldest_first holds exactly the 1 pending row");
        assertEq(rows[0]?.provider_id, "s9-homepage-pending", "s9d: the returned row IS the pending one");
        assertTrue(
          !rows.some((x) => x.provider_id === "s9-homepage-approved" || x.provider_id === "s9-homepage-rejected"),
          "s9e: neither resolved row leaks into the report"
        );
      }

      // ── s10: all THREE queues, independently, in ONE response ────────────
      //
      // Regression guard for the daily-brief SKILL: adding the third key must
      // not perturb the two pre-existing ones. Their values here are exactly
      // what s3/s4 already asserted (orgnr 2/1, website 1/1) — nothing seeded
      // since then touched either queue.
      {
        const r = await call();
        assertEq(r.status, 200, "s10a: 200");
        assertEq(r.body.orgnr_review_queue?.count, 2, "s10b: orgnr_review_queue.count unchanged at 2");
        assertEq(r.body.orgnr_review_queue?.stale_count, 1, "s10c: orgnr_review_queue.stale_count unchanged at 1");
        assertEq(r.body.orgnr_review_queue?.stale_threshold_days, staleThresholdDays, "s10d: orgnr threshold unchanged");
        assertEq((r.body.orgnr_review_queue?.oldest_first as any[])?.length, 2, "s10e: orgnr oldest_first still holds both rows");
        assertEq(r.body.website_review_queue?.count, 1, "s10f: website_review_queue.count unchanged at 1");
        assertEq(r.body.website_review_queue?.stale_count, 1, "s10g: website_review_queue.stale_count unchanged at 1");
        assertEq(r.body.website_review_queue?.stale_threshold_days, staleThresholdDays, "s10h: website threshold unchanged");
        assertEq((r.body.website_review_queue?.oldest_first as any[])?.length, 1, "s10i: website oldest_first still holds its row");
        assertEq(r.body.experience_homepage_review_queue?.count, 1, "s10j: homepage queue reported independently (count 1)");
        assertEq(r.body.experience_homepage_review_queue?.stale_count, 1, "s10k: homepage stale_count computed independently");
        // Exactly three keys — no accidental extra/renamed key in the payload.
        assertEq(
          JSON.stringify(Object.keys(r.body).sort()),
          JSON.stringify(["experience_homepage_review_queue", "orgnr_review_queue", "website_review_queue"]),
          "s10l: response carries exactly the three queue keys"
        );
      }
    } catch (err: any) {
      failed++;
      failures.push("admin-gardssalg-review-queues-staleness: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExpPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExpPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner
if (require.main === module) {
  runAdminGardssalgReviewQueuesStalenessTests({ log: true }).then((s) => {
    console.log(`\nadmin-gardssalg-review-queues-staleness: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      console.log(s.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
