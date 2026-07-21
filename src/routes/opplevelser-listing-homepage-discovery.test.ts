/**
 * opplevelser-listing-homepage-discovery.test.ts — tests for dev-request
 * 2026-07-12-experiences-enrichment-supply-and-aggregator-hygiene, Daniel's
 * decision, step 2, evidence-leg (a): POST /admin/listing-homepage-discovery
 * (fetches a provider's listing_url — the DMO/aggregator catalog page step 1
 * moved hjemmeside into — extracts outbound <a href> hostnames, screens out
 * directory/aggregator hosts and hosts already adopted elsewhere, then
 * verifies the provider's own name on the first surviving candidate host's
 * own page before parking it in experience_homepage_review_queue — NEVER
 * written directly to hjemmeside) and POST /admin/listing-homepage-review-
 * approve (strict confirmation-surface approve lever, fill-only + lock
 * re-check immediately before writing via the shared writeProviderHjemmeside
 * helper also used by PATCH /admin/providers/:id/hjemmeside).
 *
 * Same conventions as opplevelser-gardssalg-website-discovery.test.ts: an
 * in-memory experiences DB, fresh requires per run, router.handle() as the
 * HTTP entry point, and a mocked globalThis.fetch keyed on URL — the
 * IDENTICAL fetch-mocking mechanism, per the dev-request's test-fetch
 * conventions note (no second, divergent mocking approach introduced here).
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
  opts: { url?: string; headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const url = opts.url || "/admin/listing-homepage-discovery";
    const req: any = {
      method: "POST",
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
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runOpplevelserListingHomepageDiscoveryTests(
  log = false,
): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (actual === expected) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else {
      failed++;
      failures.push(`✗ ${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  return (async () => {
    const prevFetch = globalThis.fetch;
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = "listing-homepage-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const brregClientPath = require.resolve("../services/brreg-client");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, brregClientPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const oppl = require("./opplevelser") as typeof import("./opplevelser");
      const opplevelserRouter = oppl.default as any;
      const adminHeaders = { "x-admin-key": testKey };

      // ═══ Section A — pure host-extraction / name-verification helpers ═══
      {
        const html =
          '<html><body><nav><a href="/om-oss">Om oss</a></nav>' +
          '<p>Besøk oss: <a href="https://www.eksempelgard.no/kontakt">nettsiden</a></p>' +
          '<a href="mailto:post@eksempelgard.no">e-post</a>' +
          '<a href="#top">til toppen</a>' +
          '<a href="https://visitnorway.no/andre-produsenter">flere produsenter</a>' +
          '<a href="https://www.listeside.no/samme-vert">selvhenvisning</a></body></html>';
        const hosts = oppl.extractOutboundHostsFromListingPage(html, "https://www.listeside.no/produsent/eksempel");
        assertTrue(hosts.includes("eksempelgard.no"), "a1: relative-resolved outbound link's host extracted, www stripped");
        assertTrue(hosts.includes("visitnorway.no"), "a2: second outbound host also extracted");
        assertTrue(!hosts.includes("listeside.no"), "a3: link back to the listing page's OWN host excluded");
        assertEq(hosts.indexOf("eksempelgard.no") < hosts.indexOf("visitnorway.no"), true, "a4: first-seen page order preserved");
        assertTrue(!hosts.some((h) => h.includes("mailto")), "a5: mailto: href never treated as a host");

        const dupHtml = '<a href="https://a.no/x">1</a><a href="https://a.no/y">2</a>';
        const dupHosts = oppl.extractOutboundHostsFromListingPage(dupHtml, "https://listeside.no");
        assertEq(dupHosts.length, 1, "a6: same host de-duplicated across multiple hrefs");

        const badHtml = '<a href="not a valid url at all :::">x</a>';
        const badHosts = oppl.extractOutboundHostsFromListingPage(badHtml, "https://listeside.no");
        assertEq(badHosts.length, 0, "a7: unresolvable href swallowed, never throws");
      }
      {
        const page = "<html><body><h1>Velkommen til Eksempelgård</h1><p>Vi held til på Vestlandet.</p></body></html>";
        assertTrue(oppl.listingHomepageNameVerified(page, "Eksempelgård"), "a8: exact name substring found, case-insensitive");
        assertTrue(oppl.listingHomepageNameVerified(page, "eksempelgård"), "a9: lowercase input name still matches");
        assertTrue(!oppl.listingHomepageNameVerified(page, "Ukjent Gård"), "a10: absent name not found");
        assertTrue(!oppl.listingHomepageNameVerified(page, ""), "a11: blank name never verifies");
        const scripted = "<html><body><script>var x='Eksempelgård';</script><p>Reelt innhold uten navnet</p></body></html>";
        assertTrue(!oppl.listingHomepageNameVerified(scripted, "Eksempelgård"), "a12: name inside <script> is stripped before matching");
      }

      // ═══ Fixtures ═══════════════════════════════════════════════════════
      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, listing_url, content_source, source, confidence,
            enrichment_state, verification_status)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @listing_url, @content_source, 'test-fixture', 'medium',
            'raw', 'pending_verify')`,
      );
      // Verifiable row: listing page links to the provider's OWN real domain,
      // whose own page carries the provider's name.
      insertProvider.run({ id: "lh-good", navn: "Eksempelgård", hjemmeside: null, listing_url: "https://visitnorway.no/produsent/eksempelgard", content_source: null });
      // Listing page's ONLY outbound link is to another known aggregator/DMO host.
      insertProvider.run({ id: "lh-agg-only", navn: "Kunaggregator Gård", hjemmeside: null, listing_url: "https://visitnorway.no/produsent/kunaggregator", content_source: null });
      // Listing page's outbound link's host is already live as a DIFFERENT provider's hjemmeside.
      insertProvider.run({ id: "lh-taken", navn: "Tatt Gård", hjemmeside: null, listing_url: "https://visitnorway.no/produsent/tatt", content_source: null });
      insertProvider.run({ id: "lh-owner", navn: "Annen Eier", hjemmeside: "https://tattdomene.no", listing_url: null, content_source: null });
      // Same as lh-taken/lh-owner, but the existing owner's stored hjemmeside
      // carries a trailing path (the realistic common case: raw Brreg data /
      // lightly-validated admin PATCHes, not a bare host) — regression guard
      // for the LIKE '%'||host suffix-match bug: 'https://x.no/kontakt-oss'
      // does not literally END with 'x.no', so a raw LIKE suffix match on the
      // stored URL string silently misses it.
      insertProvider.run({ id: "lh-taken2", navn: "Tatt Gård To", hjemmeside: null, listing_url: "https://visitnorway.no/produsent/tatt2", content_source: null });
      insertProvider.run({ id: "lh-owner2", navn: "Annen Eier To", hjemmeside: "https://existing-real-site.no/kontakt-oss", listing_url: null, content_source: null });
      // Listing page's outbound link's own page does NOT contain the provider's name.
      insertProvider.run({ id: "lh-noname", navn: "Navnløs Gård", hjemmeside: null, listing_url: "https://visitnorway.no/produsent/navnlos", content_source: null });
      // Locked row — never processed.
      insertProvider.run({ id: "lh-locked", navn: "Krevd Gård", hjemmeside: null, listing_url: "https://visitnorway.no/produsent/krevd", content_source: "claim" });
      // Already has hjemmeside — never processed.
      insertProvider.run({ id: "lh-has-website", navn: "Har Nettside", hjemmeside: "https://harnettside.no", listing_url: "https://visitnorway.no/produsent/har-nettside", content_source: null });
      // No listing_url at all — not a candidate for auto-select.
      insertProvider.run({ id: "lh-no-listing", navn: "Uten Liste", hjemmeside: null, listing_url: null, content_source: null });

      let fetchCalls: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        fetchCalls.push(urlStr);
        const mk = (html: string, finalUrl?: string) =>
          ({ ok: true, status: 200, url: finalUrl ?? urlStr, text: async () => html } as unknown as Response);
        const notFound = () => ({ ok: false, status: 404, url: urlStr, text: async () => "" } as unknown as Response);

        if (urlStr === "https://visitnorway.no/produsent/eksempelgard") {
          return mk(
            '<html><body><h1>Eksempelgård hos Visit Norway</h1>' +
            '<a href="https://eksempelgard.no">Besøk eksempelgard.no</a></body></html>',
          );
        }
        if (urlStr === "https://eksempelgard.no") {
          return mk("<html><body>Velkommen til Eksempelgård, ekte gårdsbutikk.</body></html>");
        }
        if (urlStr === "https://visitnorway.no/produsent/kunaggregator") {
          // Only outbound link is ANOTHER curated directory/aggregator host.
          return mk('<html><body><a href="https://tripadvisor.com/attraction/kunaggregator">Se mer</a></body></html>');
        }
        if (urlStr === "https://visitnorway.no/produsent/tatt") {
          return mk('<html><body><a href="https://tattdomene.no/om">Nettsted</a></body></html>');
        }
        if (urlStr === "https://visitnorway.no/produsent/tatt2") {
          return mk('<html><body><a href="https://existing-real-site.no/some-page">Nettsted</a></body></html>');
        }
        if (urlStr === "https://visitnorway.no/produsent/navnlos") {
          return mk('<html><body><a href="https://navnlosdomene.no">Nettsted</a></body></html>');
        }
        if (urlStr === "https://navnlosdomene.no") {
          return mk("<html><body>Dette er en helt annen tekst uten treff.</body></html>");
        }
        if (urlStr === "https://visitnorway.no/produsent/krevd" || urlStr === "https://visitnorway.no/produsent/har-nettside") {
          return mk('<html><body><a href="https://skalikkebesokes.no">x</a></body></html>');
        }
        return notFound();
      }) as unknown as typeof fetch;

      // ── lh-1: auth gate on BOTH new routes. ─────────────────────────────
      {
        const r1 = await callRoute(opplevelserRouter, { body: {} });
        assertEq(r1.status, 403, "lh-1a: no admin key → 403 on discovery route");
        const r2 = await callRoute(opplevelserRouter, {
          url: "/admin/listing-homepage-review-approve",
          body: { approvals: [{ provider_id: "x", url: "https://x.no" }] },
        });
        assertEq(r2.status, 403, "lh-1b: no admin key → 403 on approve route");
      }

      // ── lh-2: DRY-RUN — fetches happen, NOTHING is written. ─────────────
      {
        fetchCalls = [];
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: {
            providerIds: [
              "lh-good", "lh-agg-only", "lh-taken", "lh-taken2", "lh-noname",
              "lh-locked", "lh-has-website", "finnes-ikke",
            ],
          },
        });
        assertEq(r.status, 200, "lh-2a: dry-run 200");
        assertEq(r.body.dry_run, true, "lh-2b: dry-run is the default");
        assertEq(r.body.scanned, 5, "lh-2c: locked + already-has-website + unknown never reach processing (5 real targets)");
        assertEq((r.body.skipped_locked as any[])[0]?.provider_id, "lh-locked", "lh-2d: locked row reported");
        assertEq((r.body.already_has_website as any[])[0]?.provider_id, "lh-has-website", "lh-2e: already-has-website row reported (reused naming)");
        assertEq((r.body.not_found as any[])[0], "finnes-ikke", "lh-2f: unknown id reported");
        assertEq(r.body.proposed_count, 1, "lh-2g: exactly one verified proposal (lh-good)");
        const prop = (r.body.proposed as any[])[0];
        assertEq(prop?.provider_id, "lh-good", "lh-2h: verified candidate is lh-good");
        assertEq(prop?.candidate_url, "https://eksempelgard.no", "lh-2i: candidate_url is the candidate host's own final origin");
        assertEq(prop?.evidence?.name_verified, true, "lh-2j: evidence records the name-verification");

        const aggEx = (r.body.excluded as any[]).find((e) => e.provider_id === "lh-agg-only");
        assertTrue(
          !!aggEx && aggEx.hosts.some((h: any) => h.host === "tripadvisor.com" && h.reason === "directory_or_aggregator_host"),
          "lh-2k: listing page's only link is a known aggregator/DMO host → excluded, not proposed",
        );
        assertTrue(!(r.body.proposed as any[]).some((p) => p.provider_id === "lh-agg-only"), "lh-2l: aggregator-only row never proposed");

        const takenEx = (r.body.excluded as any[]).find((e) => e.provider_id === "lh-taken");
        assertTrue(
          !!takenEx && takenEx.hosts.some((h: any) => h.host === "tattdomene.no" && h.reason === "host_already_in_catalog"),
          "lh-2m: host already live as a DIFFERENT provider's hjemmeside → excluded",
        );
        assertTrue(!(r.body.proposed as any[]).some((p) => p.provider_id === "lh-taken"), "lh-2n: already-in-catalog row never proposed");
        assertTrue(!fetchCalls.includes("https://tattdomene.no"), "lh-2o: the taken host's own page is never fetched (excluded before the ownership fetch)");

        // Regression guard: the owner's stored hjemmeside has a trailing path
        // ('https://existing-real-site.no/kontakt-oss'), not a bare host —
        // must still be caught (normalized-host comparison, not a raw LIKE
        // '%'||host suffix match against the stored URL string).
        const taken2Ex = (r.body.excluded as any[]).find((e) => e.provider_id === "lh-taken2");
        assertTrue(
          !!taken2Ex && taken2Ex.hosts.some((h: any) => h.host === "existing-real-site.no" && h.reason === "host_already_in_catalog"),
          "lh-2m2: host already live as a DIFFERENT provider's hjemmeside WITH a trailing path → still excluded",
        );
        assertTrue(!(r.body.proposed as any[]).some((p) => p.provider_id === "lh-taken2"), "lh-2n2: already-in-catalog (trailing-path owner) row never proposed");
        assertTrue(!fetchCalls.includes("https://existing-real-site.no"), "lh-2o2: the taken host's own page is never fetched (excluded before the ownership fetch)");

        const nn = (r.body.no_candidate_verified as any[]).find((e) => e.provider_id === "lh-noname");
        assertTrue(!!nn && nn.tried.includes("navnlosdomene.no"), "lh-2p: candidate page fetched but name not found → no_candidate_verified, hostname listed");

        const qCnt = (expDb.prepare(`SELECT COUNT(*) c FROM experience_homepage_review_queue`).get() as any).c;
        assertEq(qCnt, 0, "lh-2q: dry-run wrote NOTHING to the queue");
        const hj = (expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id='lh-good'`).get() as any).hjemmeside;
        assertEq(hj, null, "lh-2r: dry-run never writes hjemmeside directly");
        const stamped = (expDb.prepare(`SELECT COUNT(*) c FROM experience_providers WHERE listing_homepage_discovery_attempted_at IS NOT NULL`).get() as any).c;
        assertEq(stamped, 0, "lh-2s: dry-run stamped NOTHING (strict !dryRun-only convention)");
      }

      // ── lh-3: APPLY — queue upserted, attempt stamps land on EVERY
      //    processed row (verified or not), hjemmeside is STILL untouched. ──
      let queuedUrl = "";
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { providerIds: ["lh-good", "lh-agg-only", "lh-taken", "lh-noname"], apply: true },
        });
        assertEq(r.body.dry_run, false, "lh-3a: apply mode");
        assertEq(r.body.proposed_count, 1, "lh-3b: same single verified proposal");
        const q = expDb.prepare(`SELECT * FROM experience_homepage_review_queue WHERE provider_id='lh-good'`).get() as any;
        assertTrue(!!q, "lh-3c: verified candidate parked in the NEW review queue table");
        assertEq(q?.candidate_url, "https://eksempelgard.no", "lh-3d: queued candidate_url is the candidate's own final origin");
        assertEq(q?.reason, "listing_page_link_candidate", "lh-3e: default reason per spec");
        assertEq(q?.status, "pending", "lh-3f: queue row starts pending");
        queuedUrl = q?.candidate_url;
        const hj = (expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id='lh-good'`).get() as any).hjemmeside;
        assertEq(hj, null, "lh-3g: apply on discovery NEVER writes hjemmeside directly — queue-only, the core regression guard");
        const stamps = expDb.prepare(
          `SELECT id FROM experience_providers WHERE listing_homepage_discovery_attempted_at IS NOT NULL ORDER BY id`,
        ).all() as any[];
        assertEq(stamps.length, 4, "lh-3h: ALL 4 processed rows stamped, including the 3 that did not verify");
        assertEq(r.body.queue_size, 1, "lh-3i: queue size reported");
      }

      // ── lh-4: auto-select candidate-set query. ──────────────────────────
      {
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: {} });
        const ids = (r.body.proposed as any[]).map((p) => p.provider_id)
          .concat((r.body.excluded as any[]).map((e) => e.provider_id))
          .concat((r.body.no_candidate_verified as any[]).map((e) => e.provider_id));
        assertTrue(!ids.includes("lh-locked"), "lh-4a: locked row never auto-selected");
        assertTrue(!ids.includes("lh-has-website"), "lh-4b: row WITH hjemmeside never auto-selected");
        assertTrue(!ids.includes("lh-no-listing"), "lh-4c: row with no listing_url never auto-selected");
      }

      // ── lh-5: approve lever — strict confirmation surface. ──────────────
      {
        const dry = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          url: "/admin/listing-homepage-review-approve",
          body: {
            approvals: [
              { provider_id: "lh-good", url: queuedUrl },
              { provider_id: "lh-good", url: queuedUrl },
              { provider_id: "ukjent", url: "https://x.no" },
              { provider_id: "lh-noname", url: "https://feil.no" },
            ],
          },
        });
        assertEq(dry.body.dry_run, true, "lh-5a: approve dry-run default");
        assertEq(dry.body.approved_count, 1, "lh-5b: only the queued exact pair approves");
        const reasons = Object.fromEntries((dry.body.rejected as any[]).map((r: any) => [r.provider_id, r.reason]));
        assertEq(reasons["lh-good"], "duplicate_in_request", "lh-5c: duplicate item rejected");
        assertEq(reasons["ukjent"], "not_in_review_queue", "lh-5d: non-queued provider rejected");
        assertEq(reasons["lh-noname"], "not_in_review_queue", "lh-5e: provider without a pending queue entry rejected");
        const hjDry = (expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id='lh-good'`).get() as any).hjemmeside;
        assertEq(hjDry, null, "lh-5f: dry-run wrote nothing");

        const bad = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          url: "/admin/listing-homepage-review-approve",
          body: { approvals: [{ provider_id: "lh-good", url: "https://noe-annet.no" }], apply: true },
        });
        assertEq(
          (bad.body.rejected as any[])[0]?.reason, "mismatch_with_queued_candidate",
          "lh-5g: a DIFFERENT url than the queued candidate is rejected (no arbitrary-write surface)",
        );

        const ok = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          url: "/admin/listing-homepage-review-approve",
          body: { approvals: [{ provider_id: "lh-good", url: queuedUrl }], apply: true },
        });
        assertEq(ok.body.written_count, 1, "lh-5h: queued pair applies");
        const row = expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id='lh-good'`).get() as any;
        assertEq(row.hjemmeside, "https://eksempelgard.no", "lh-5i: hjemmeside persisted via the shared writeProviderHjemmeside helper");
        const qRow = expDb.prepare(`SELECT status, resolved_at FROM experience_homepage_review_queue WHERE provider_id='lh-good'`).get() as any;
        assertEq(qRow.status, "approved", "lh-5j: queue row flipped to approved");
        assertTrue(!!qRow.resolved_at, "lh-5k: resolved_at timestamp stamped");

        const again = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          url: "/admin/listing-homepage-review-approve",
          body: { approvals: [{ provider_id: "lh-good", url: queuedUrl }], apply: true },
        });
        assertEq(
          (again.body.rejected as any[])[0]?.reason, "not_in_review_queue",
          "lh-5l: repeat approve call on the same provider_id/url is idempotent (approved row no longer 'in the review queue')",
        );
        assertEq(again.body.written_count, 0, "lh-5m: repeat call writes nothing (no double-write)");
      }

      // ── lh-6: approve-lever concurrent-write guard (write_skipped_by_guards). ─
      {
        // Fresh candidate: lh-agg-only's queue row wasn't created (aggregator
        // excluded before ownership verification) — use a purpose-built row
        // instead so we can queue THEN simulate a concurrent hjemmeside write.
        insertProvider.run({ id: "lh-guard", navn: "Vernet Gård", hjemmeside: null, listing_url: "https://visitnorway.no/produsent/vernet", content_source: null });
        (globalThis.fetch as any) = (async (url: string | URL | Request) => {
          const urlStr = String(url);
          const mk = (html: string) => ({ ok: true, status: 200, url: urlStr, text: async () => html } as unknown as Response);
          if (urlStr === "https://visitnorway.no/produsent/vernet") {
            return mk('<html><body><a href="https://vernetgard.no">Nettsted</a></body></html>');
          }
          if (urlStr === "https://vernetgard.no") {
            return mk("<html><body>Velkommen til Vernet Gård.</body></html>");
          }
          return { ok: false, status: 404, url: urlStr, text: async () => "" } as unknown as Response;
        }) as unknown as typeof fetch;

        const disc = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { providerIds: ["lh-guard"], apply: true },
        });
        assertEq(disc.body.proposed_count, 1, "lh-6a: lh-guard's candidate verifies and queues");
        const guardedUrl = (disc.body.proposed as any[])[0]?.candidate_url;

        // Simulate a concurrent direct write between queueing and approving
        // (e.g. another admin action filled hjemmeside in the meantime).
        expDb.prepare(`UPDATE experience_providers SET hjemmeside = 'https://concurrent-write.no' WHERE id = 'lh-guard'`).run();

        const approve = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          url: "/admin/listing-homepage-review-approve",
          body: { approvals: [{ provider_id: "lh-guard", url: guardedUrl }], apply: true },
        });
        assertEq(
          (approve.body.rejected as any[])[0]?.reason, "write_skipped_by_guards",
          "lh-6b: hjemmeside filled concurrently since queueing → approve rejects with write_skipped_by_guards",
        );
        assertEq(approve.body.written_count, 0, "lh-6c: guard rejection writes nothing");
        const finalHj = (expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id='lh-guard'`).get() as any).hjemmeside;
        assertEq(finalHj, "https://concurrent-write.no", "lh-6d: the concurrently-set value is NOT overwritten by the guarded approve");
        const qRow = expDb.prepare(`SELECT status FROM experience_homepage_review_queue WHERE provider_id='lh-guard'`).get() as any;
        assertEq(qRow?.status, "pending", "lh-6e: queue row stays pending on a guard rejection (not approved, not rejected)");
      }

      // ── lh-7: migration is additive + idempotent. ───────────────────────
      {
        const initModule = require("../database/init-experiences") as typeof import("../database/init-experiences");
        const rawDb = require("better-sqlite3");
        const scratchDb = new rawDb(":memory:");
        initModule.initExperiencesSchema(scratchDb);
        initModule.initExperiencesSchema(scratchDb); // second call must not throw
        const cols = scratchDb.prepare(`PRAGMA table_info(experience_providers)`).all() as any[];
        assertTrue(
          cols.some((c) => c.name === "listing_homepage_discovery_attempted_at"),
          "lh-7a: listing_homepage_discovery_attempted_at column exists after migration",
        );
        const tables = scratchDb.prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='experience_homepage_review_queue'`,
        ).all() as any[];
        assertEq(tables.length, 1, "lh-7b: experience_homepage_review_queue table exists after migration");
        scratchDb.close();
        // Also confirmed on the live test DB (used throughout this file):
        // existing rows from earlier sections are unaffected by the migration
        // having already run twice at boot (dbFactory.getDb() init + this
        // section's standalone re-init above touch different DB handles, but
        // pin the same additive-column guarantee on the live handle too).
        const liveCols = (expDb.prepare(`PRAGMA table_info(experience_providers)`).all() as any[]).map((c) => c.name);
        assertTrue(liveCols.includes("listing_homepage_discovery_attempted_at"), "lh-7c: column also present on the live test DB handle");
        const untouchedRow = expDb.prepare(`SELECT navn FROM experience_providers WHERE id = 'lh-owner'`).get() as any;
        assertEq(untouchedRow?.navn, "Annen Eier", "lh-7d: existing rows unaffected by the additive migration");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-listing-homepage-discovery: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
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
