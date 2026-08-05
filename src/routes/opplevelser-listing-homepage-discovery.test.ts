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
    const testKey = process.env.ADMIN_KEY || "listing-homepage-test-key";
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

      // ── lh-8: cross-leg queue clobber guard — a provider that already has
      //    a pending queue row from leg (b) (Brreg) is excluded rather than
      //    silently overwritten by this leg's own verified candidate.
      //    Regression guard for the confirmed cross-leg clobber defect: this
      //    leg (a) route previously had no equivalent of leg (b)'s
      //    ownPendingOrApproved guard, so calling it on a provider a sibling
      //    leg had already queued would flip reason/candidate_url/created_at
      //    out from under the still-pending proposal with no trace of the
      //    original ever existing. ───────────────────────────────────────
      {
        insertProvider.run({ id: "lh-preclobbered", navn: "Forhåndskødd Gård", hjemmeside: null, listing_url: "https://visitnorway.no/produsent/preclobbered", content_source: null });
        (globalThis.fetch as any) = (async (url: string | URL | Request) => {
          const urlStr = String(url);
          const mk = (html: string) => ({ ok: true, status: 200, url: urlStr, text: async () => html } as unknown as Response);
          if (urlStr === "https://visitnorway.no/produsent/preclobbered") {
            return mk('<html><body><a href="https://preclobberedgard.no">Nettsted</a></body></html>');
          }
          if (urlStr === "https://preclobberedgard.no") {
            return mk("<html><body>Velkommen til Forhåndskødd Gård.</body></html>");
          }
          return { ok: false, status: 404, url: urlStr, text: async () => "" } as unknown as Response;
        }) as unknown as typeof fetch;

        // Simulate leg (b)'s prior proposal: a pending row for this SAME
        // provider, a DIFFERENT reason/candidate_url, already sitting in the
        // shared queue before this leg (a) call ever runs.
        const preExistingCreatedAt = "2026-07-01 00:00:00";
        expDb.prepare(
          `INSERT INTO experience_homepage_review_queue
             (id, provider_id, provider_name, candidate_url, final_url, evidence, confidence, reason, batch_id, status, created_at, resolved_at)
           VALUES ('lh-preclobbered-row', 'lh-preclobbered', 'Forhåndskødd Gård', 'https://brreg-real-site.no', 'https://brreg-real-site.no', '{}', 1.0, 'brreg_website_candidate', 'test-fixture-leg-b', 'pending', @createdAt, NULL)`,
        ).run({ createdAt: preExistingCreatedAt });

        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { providerIds: ["lh-preclobbered"], apply: true },
        });
        assertEq(r.body.proposed_count, 0, "lh-8a: pre-queued-by-another-leg provider is NOT proposed by this leg");
        const ex = (r.body.excluded as any[]).find((e) => e.provider_id === "lh-preclobbered");
        assertTrue(
          !!ex && ex.hosts.some((h: any) => h.host === "preclobberedgard.no" && h.reason === "already_queued_for_provider"),
          "lh-8b: excluded with reason already_queued_for_provider, reusing leg (b)'s exact reason string",
        );

        const row = expDb.prepare(`SELECT * FROM experience_homepage_review_queue WHERE provider_id = 'lh-preclobbered'`).get() as any;
        assertEq(row?.reason, "brreg_website_candidate", "lh-8c: existing row's reason UNCHANGED — not clobbered by this leg's own reason");
        assertEq(row?.candidate_url, "https://brreg-real-site.no", "lh-8d: existing row's candidate_url UNCHANGED");
        assertEq(row?.created_at, preExistingCreatedAt, "lh-8e: existing row's created_at UNCHANGED — never re-upserted");
        assertEq(row?.status, "pending", "lh-8f: existing row still pending, untouched");

        const qCount = (expDb.prepare(`SELECT COUNT(*) c FROM experience_homepage_review_queue WHERE provider_id = 'lh-preclobbered'`).get() as any).c;
        assertEq(qCount, 1, "lh-8g: still exactly one queue row for this provider — no duplicate inserted alongside it");
      }

      // ── lh-9: sub-slice 3e — the explicit-providerIds branch's lock check
      //    now goes through the shared isHjemmesideLocked() helper (already
      //    shipped for the hjemmeside-write route, sub-slice 3d), narrowing
      //    the freeze from an unconditional row-level content_source check
      //    to isGardssalgFieldOwnerLocked()'s per-field owner_locks stamp —
      //    but ONLY for gårdssalg-identified rows (producer_type set, or
      //    rfb_seed_source='rfb-seed'). A non-gårdssalg claim row keeps
      //    today's exact unconditional freeze. All listing_url: null here —
      //    these fixtures only need to prove skipped_locked membership, not
      //    a full discovery proposal (null listing_url just lands the row in
      //    no_candidate_verified once past the lock check). ───────────────
      {
        const insertGardssalgFixture = expDb.prepare(
          `INSERT INTO experience_providers
             (id, navn, vertical, hjemmeside, listing_url, content_source, source, confidence,
              enrichment_state, verification_status, producer_type, rfb_seed_source, field_provenance)
           VALUES
             (@id, @navn, 'experiences', NULL, NULL, @content_source, 'test-fixture', 'medium',
              'raw', 'pending_verify', @producer_type, @rfb_seed_source, @field_provenance)`,
        );

        // lh-3e-1: gårdssalg row (producer_type set), content_source='claim',
        // field_provenance has owner_locks but NOT for 'hjemmeside' → not locked.
        insertGardssalgFixture.run({
          id: "lh-3e-unlocked-producer-type",
          navn: "Ulåst Bryggeri",
          content_source: "claim",
          producer_type: "bryggeri",
          rfb_seed_source: null,
          field_provenance: JSON.stringify({ owner_locks: { about_text: { locked_at: "2026-08-01T00:00:00Z" } } }),
        });
        // lh-3e-2: same gårdssalg row shape, but owner_locks.hjemmeside IS
        // present → locked (negative control).
        insertGardssalgFixture.run({
          id: "lh-3e-locked-producer-type",
          navn: "Låst Bryggeri",
          content_source: "claim",
          producer_type: "bryggeri",
          rfb_seed_source: null,
          field_provenance: JSON.stringify({ owner_locks: { hjemmeside: { locked_at: "2026-08-01T00:00:00Z" } } }),
        });
        // lh-3e-3: gårdssalg identity via rfb_seed_source instead of
        // producer_type, no owner_locks.hjemmeside → not locked.
        insertGardssalgFixture.run({
          id: "lh-3e-unlocked-rfbseed",
          navn: "Ulåst Rfb-Seed",
          content_source: "claim",
          producer_type: null,
          rfb_seed_source: "rfb-seed",
          field_provenance: JSON.stringify({ owner_locks: {} }),
        });
        // lh-3e-4: critical safety test — NON-gårdssalg row (no producer_type,
        // no rfb_seed_source='rfb-seed'), content_source='claim', but an
        // ADVERSARIAL owner_locks.hjemmeside present anyway → still locked.
        // A non-gårdssalg claim row's freeze must never consult field_provenance.
        insertGardssalgFixture.run({
          id: "lh-3e-adversarial-non-gardssalg",
          navn: "Ikke Gårdssalg",
          content_source: "claim",
          producer_type: null,
          rfb_seed_source: null,
          field_provenance: JSON.stringify({ owner_locks: { hjemmeside: { locked_at: "2026-08-01T00:00:00Z" } } }),
        });
        // lh-3e-6: gårdssalg row with content_source='manual' → stays locked
        // unconditionally, regardless of field_provenance contents (manual
        // rows never consult owner_locks).
        insertGardssalgFixture.run({
          id: "lh-3e-manual-producer-type",
          navn: "Manuelt Bryggeri",
          content_source: "manual",
          producer_type: "bryggeri",
          rfb_seed_source: null,
          field_provenance: JSON.stringify({ owner_locks: {} }),
        });

        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: {
            providerIds: [
              "lh-3e-unlocked-producer-type",
              "lh-3e-locked-producer-type",
              "lh-3e-unlocked-rfbseed",
              "lh-3e-adversarial-non-gardssalg",
              "lh-3e-manual-producer-type",
            ],
          },
        });
        assertEq(r.status, 200, "lh-3e-0: request succeeds");
        const skippedIds = (r.body.skipped_locked as any[]).map((s) => s.provider_id);
        const noCandidateIds = (r.body.no_candidate_verified as any[]).map((n) => n.provider_id);

        assertTrue(
          !skippedIds.includes("lh-3e-unlocked-producer-type"),
          "lh-3e-1: gårdssalg row (producer_type), owner_locks without 'hjemmeside' → NOT skipped_locked",
        );
        assertTrue(
          noCandidateIds.includes("lh-3e-unlocked-producer-type"),
          "lh-3e-1b: ...and proceeds to normal discovery processing (reaches no_candidate_verified, null listing_url)",
        );

        assertTrue(
          skippedIds.includes("lh-3e-locked-producer-type"),
          "lh-3e-2: same gårdssalg row shape, but owner_locks.hjemmeside present → IS skipped_locked (negative control)",
        );

        assertTrue(
          !skippedIds.includes("lh-3e-unlocked-rfbseed"),
          "lh-3e-3: gårdssalg identity via rfb_seed_source='rfb-seed' (producer_type null), no owner_locks.hjemmeside → NOT skipped_locked",
        );
        assertTrue(
          noCandidateIds.includes("lh-3e-unlocked-rfbseed"),
          "lh-3e-3b: ...and proceeds to normal discovery processing",
        );

        assertTrue(
          skippedIds.includes("lh-3e-adversarial-non-gardssalg"),
          "lh-3e-4: non-gårdssalg claim row with adversarial owner_locks.hjemmeside → STILL skipped_locked (field_provenance never consulted for non-gårdssalg rows)",
        );

        assertTrue(
          skippedIds.includes("lh-3e-manual-producer-type"),
          "lh-3e-6: gårdssalg row with content_source='manual' → skipped_locked unconditionally regardless of field_provenance",
        );
      }

      // ── lh-9b: existing lh-locked fixture (non-gårdssalg claim row, no
      //    producer_type/rfb_seed_source, no field_provenance) — unmodified
      //    re-assertion that it still lands in skipped_locked after the
      //    switch to isHjemmesideLocked(). (lh-5: original coverage is
      //    lh-2d above; this is a direct, standalone re-check.) ───────────
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { providerIds: ["lh-locked"] },
        });
        assertEq(
          (r.body.skipped_locked as any[])[0]?.provider_id,
          "lh-locked",
          "lh-9b: pre-existing non-gårdssalg lh-locked fixture still lands in skipped_locked, unmodified",
        );
      }

      // ── lh-10: sub-slice 3f — the auto-batch branch (no providerIds in the
      //    body) gains a two-phase top-up: phase 1 is today's exact SQL query
      //    unchanged (LIMIT LH_DISCOVERY_BATCH_CAP=30); phase 2 ONLY runs when
      //    phase 1 under-fills the batch, widening eligibility to gårdssalg
      //    content_source='claim' rows that pass isHjemmesideLocked()===false
      //    (the same shared, already-shipped gate 3d/3e already use). All
      //    fetches in this section are forced to 404 — every fixture below
      //    only needs to prove it was PROCESSED (landed in `targets`, visible
      //    via proposed/excluded/no_candidate_verified) or NOT processed, not
      //    whether a website candidate was actually found. Each sub-test
      //    inserts its own uniquely-prefixed (`lh-3f-...`) fixtures and
      //    deletes them again afterward, so sub-tests don't leak into one
      //    another's phase-1/phase-2 pool. Baseline phase-1-eligible pool at
      //    the start of this section (from earlier sections in this same
      //    file, unmodified/reused): lh-agg-only, lh-taken, lh-taken2,
      //    lh-noname, lh-preclobbered — 5 rows, well under the 30 cap, so
      //    phase 2 runs by default for every sub-test here except lh-10a
      //    (which deliberately fills the cap with phase-1-only rows first). ──
      {
        (globalThis.fetch as any) = (async (url: string | URL | Request) => {
          return { ok: false, status: 404, url: String(url), text: async () => "" } as unknown as Response;
        }) as unknown as typeof fetch;

        const insertGardssalgClaim = expDb.prepare(
          `INSERT INTO experience_providers
             (id, navn, vertical, hjemmeside, listing_url, content_source, source, confidence,
              enrichment_state, verification_status, producer_type, rfb_seed_source, field_provenance)
           VALUES
             (@id, @navn, 'experiences', NULL, @listing_url, @content_source, 'test-fixture', 'medium',
              'raw', 'pending_verify', @producer_type, @rfb_seed_source, @field_provenance)`,
        );

        function autoBatch(): Promise<RouteResult> {
          return callRoute(opplevelserRouter, { headers: adminHeaders, body: {} });
        }
        function processedIdSet(r: RouteResult): Set<string> {
          const s = new Set<string>();
          for (const p of r.body.proposed as any[]) s.add(p.provider_id);
          for (const e of r.body.excluded as any[]) s.add(e.provider_id);
          for (const n of r.body.no_candidate_verified as any[]) s.add(n.provider_id);
          return s;
        }
        function deleteFixtures(ids: string[]): void {
          const del = expDb.prepare(`DELETE FROM experience_providers WHERE id = ?`);
          for (const id of ids) del.run(id);
        }

        // ── lh-10a (AC1): phase 1 alone already fills LH_DISCOVERY_BATCH_CAP
        //    (>=30 eligible non-manual/non-claim rows) → phase 2 does NOT
        //    run, even though an eligible+unlocked gårdssalg claim row
        //    exists. ─────────────────────────────────────────────────────
        {
          const capFillIds: string[] = [];
          const insertCapFill = expDb.prepare(
            `INSERT INTO experience_providers
               (id, navn, vertical, hjemmeside, listing_url, content_source, source, confidence,
                enrichment_state, verification_status)
             VALUES (@id, @navn, 'experiences', NULL, @listing_url, NULL, 'test-fixture', 'medium',
                     'raw', 'pending_verify')`,
          );
          for (let i = 0; i < 30; i++) {
            const id = `lh-3f-capfill-${i}`;
            capFillIds.push(id);
            insertCapFill.run({ id, navn: `Cap Fill ${i}`, listing_url: `https://lh3f-capfill-${i}.example.no` });
          }
          insertGardssalgClaim.run({
            id: "lh-3f-ac1-claim",
            navn: "AC1 Skulle Vært Med",
            listing_url: "https://lh3f-ac1-claim.example.no",
            content_source: "claim",
            producer_type: "bryggeri",
            rfb_seed_source: null,
            field_provenance: JSON.stringify({ owner_locks: {} }),
          });

          const r = await autoBatch();
          assertEq(r.body.scanned, 30, "lh-10a-1: phase 1 alone fills the cap (30 scanned)");
          assertTrue(
            !processedIdSet(r).has("lh-3f-ac1-claim"),
            "lh-10a-2: eligible+unlocked gårdssalg claim row NOT processed — phase 2 never ran because phase 1 already filled the cap",
          );

          deleteFixtures([...capFillIds, "lh-3f-ac1-claim"]);
        }

        // ── lh-10b (AC2): phase 1 under-fills; a gårdssalg (producer_type
        //    set) content_source='claim' row with owner_locks.hjemmeside NOT
        //    set → appears in targets (processed). ─────────────────────────
        {
          insertGardssalgClaim.run({
            id: "lh-3f-ac2-unlocked",
            navn: "AC2 Ulåst Bryggeri",
            listing_url: "https://lh3f-ac2-unlocked.example.no",
            content_source: "claim",
            producer_type: "bryggeri",
            rfb_seed_source: null,
            field_provenance: JSON.stringify({ owner_locks: { about_text: { locked_at: "2026-08-01T00:00:00Z" } } }),
          });

          const r = await autoBatch();
          assertTrue(
            processedIdSet(r).has("lh-3f-ac2-unlocked"),
            "lh-10b: gårdssalg claim row (producer_type), owner_locks without 'hjemmeside' → IS processed (widening works)",
          );

          deleteFixtures(["lh-3f-ac2-unlocked"]);
        }

        // ── lh-10c (AC3): same shape, but owner_locks.hjemmeside IS set →
        //    negative control, row does NOT appear in targets. ─────────────
        {
          insertGardssalgClaim.run({
            id: "lh-3f-ac3-locked",
            navn: "AC3 Låst Bryggeri",
            listing_url: "https://lh3f-ac3-locked.example.no",
            content_source: "claim",
            producer_type: "bryggeri",
            rfb_seed_source: null,
            field_provenance: JSON.stringify({ owner_locks: { hjemmeside: { locked_at: "2026-08-01T00:00:00Z" } } }),
          });

          const r = await autoBatch();
          assertTrue(
            !processedIdSet(r).has("lh-3f-ac3-locked"),
            "lh-10c: same gårdssalg row shape but owner_locks.hjemmeside present → NOT processed (negative control, same gate as 3d/3e)",
          );

          deleteFixtures(["lh-3f-ac3-locked"]);
        }

        // ── lh-10d (AC4): gårdssalg identity via rfb_seed_source='rfb-seed'
        //    (producer_type NULL) instead of producer_type, no
        //    owner_locks.hjemmeside → also appears (both identity signals
        //    honored, matching 3e's AC3). ────────────────────────────────
        {
          insertGardssalgClaim.run({
            id: "lh-3f-ac4-rfbseed",
            navn: "AC4 Ulåst Rfb-Seed",
            listing_url: "https://lh3f-ac4-rfbseed.example.no",
            content_source: "claim",
            producer_type: null,
            rfb_seed_source: "rfb-seed",
            field_provenance: JSON.stringify({ owner_locks: {} }),
          });

          const r = await autoBatch();
          assertTrue(
            processedIdSet(r).has("lh-3f-ac4-rfbseed"),
            "lh-10d: gårdssalg identity via rfb_seed_source='rfb-seed' (producer_type null), no owner_locks.hjemmeside → IS processed",
          );

          deleteFixtures(["lh-3f-ac4-rfbseed"]);
        }

        // ── lh-10e (AC5): critical safety proof — content_source='manual'
        //    rows never appear in targets, regardless of how many manual
        //    rows exist or how few phase-1 rows exist (phase 1's own pool
        //    here is the 5-row baseline, well under the cap, so phase 2
        //    genuinely runs). Proves phase 2's SQL-level content_source =
        //    'claim' filter — not just the JS gate — keeps manual out. ────
        {
          const manualIds: string[] = [];
          for (let i = 0; i < 5; i++) {
            const id = `lh-3f-ac5-manual-${i}`;
            manualIds.push(id);
            insertGardssalgClaim.run({
              id,
              navn: `AC5 Manuell ${i}`,
              listing_url: `https://lh3f-ac5-manual-${i}.example.no`,
              content_source: "manual",
              producer_type: "bryggeri",
              rfb_seed_source: null,
              field_provenance: JSON.stringify({ owner_locks: {} }),
            });
          }

          const r = await autoBatch();
          const processed = processedIdSet(r);
          assertTrue(
            manualIds.every((id) => !processed.has(id)),
            "lh-10e: content_source='manual' rows NEVER appear in targets, even gårdssalg-identified + field-level-unlocked ones",
          );

          deleteFixtures(manualIds);
        }

        // ── lh-10f (AC6): non-gårdssalg content_source='claim' row
        //    (producer_type NULL, rfb_seed_source NOT 'rfb-seed') is never
        //    returned by phase 2 even with an adversarial owner_locks entry
        //    that would look "unlocked" — proves the SQL-level gårdssalg-
        //    identity filter is the first gate, isHjemmesideLocked the
        //    second, belt-and-suspenders. ──────────────────────────────────
        {
          insertGardssalgClaim.run({
            id: "lh-3f-ac6-adversarial",
            navn: "AC6 Ikke Gårdssalg",
            listing_url: "https://lh3f-ac6-adversarial.example.no",
            content_source: "claim",
            producer_type: null,
            rfb_seed_source: null,
            field_provenance: JSON.stringify({ owner_locks: {} }),
          });

          const r = await autoBatch();
          assertTrue(
            !processedIdSet(r).has("lh-3f-ac6-adversarial"),
            "lh-10f: non-gårdssalg claim row (no producer_type/rfb_seed_source) never returned by phase 2, even with an adversarial owner_locks shape",
          );

          deleteFixtures(["lh-3f-ac6-adversarial"]);
        }

        // ── lh-10g (AC7): total targets.length from the combined phase-1 +
        //    phase-2 flow never exceeds LH_DISCOVERY_BATCH_CAP, even when
        //    phase 2 has far more eligible candidates (40) than remaining
        //    slots (25 = 30 - 5-row baseline). ──────────────────────────────
        {
          const ac7Ids: string[] = [];
          for (let i = 0; i < 40; i++) {
            const id = `lh-3f-ac7-${i}`;
            ac7Ids.push(id);
            insertGardssalgClaim.run({
              id,
              navn: `AC7 Kandidat ${i}`,
              listing_url: `https://lh3f-ac7-${i}.example.no`,
              content_source: "claim",
              producer_type: "bryggeri",
              rfb_seed_source: null,
              field_provenance: JSON.stringify({ owner_locks: {} }),
            });
          }

          const r = await autoBatch();
          assertEq(r.body.scanned, 30, "lh-10g-1: total scanned never exceeds the cap even with 40 eligible phase-2 candidates");
          const processed = processedIdSet(r);
          const ac7Processed = ac7Ids.filter((id) => processed.has(id));
          assertEq(ac7Processed.length, 25, "lh-10g-2: exactly remaining_slots (25) of the 40 eligible phase-2 candidates are taken, never more");

          deleteFixtures(ac7Ids);
        }

        // ── lh-10h (AC8): existing auto-batch tests (phase-1-only scenarios,
        //    no gårdssalg claim rows in the fixture set) pass unmodified —
        //    zero behavior change for the dominant case. lh-4 above already
        //    covers this against the full mixed fixture set; this is a
        //    direct, isolated re-check against the clean 5-row baseline
        //    (all lh-10a..g fixtures deleted above) confirming the result
        //    set is EXACTLY the baseline 5 rows, nothing more, nothing
        //    less. ─────────────────────────────────────────────────────────
        {
          const r = await autoBatch();
          assertEq(r.body.scanned, 5, "lh-10h-1: clean baseline (no gårdssalg claim rows) scans exactly the 5 pre-existing eligible rows");
          const processed = processedIdSet(r);
          for (const id of ["lh-agg-only", "lh-taken", "lh-taken2", "lh-noname", "lh-preclobbered"]) {
            assertTrue(processed.has(id), `lh-10h-2: baseline row ${id} still processed, unmodified by the 3f change`);
          }
        }
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
