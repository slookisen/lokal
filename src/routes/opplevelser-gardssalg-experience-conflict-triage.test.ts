/**
 * opplevelser-gardssalg-experience-conflict-triage.test.ts — route-level
 * tests for dev-request 2026-08-14-dublett-auto-triage:
 *
 *   GET /admin/gardssalg-experience-conflict-auto-triage (DRY-RUN / REPORT
 *   ONLY — no write path exists in this slice at all)
 *
 * The pure classification-logic tests (classifyGardssalgExperienceConflict
 * Pair, incl. the mandatory transient-forces-pending case, both auto_confirm
 * triggers, both auto_reject triggers, weak-signal pending, and the
 * name-token-alone-is-not-sufficient negative control) live in
 * services/gardssalg-experience-conflict-triage.test.ts — this file
 * exercises the same shapes end-to-end through the real HTTP route, a real
 * (in-memory) DB, and the actual crFetchGardssalgContent + gardssalgWebsite
 * EvidenceMatch plumbing those pure tests stub out.
 *
 * Mirrors opplevelser-gardssalg-website-verification.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + the new triage service + opplevelser router per run,
 * callRoute() exercising router.handle() directly with X-Admin-Key via
 * headers) and mocks globalThis.fetch, keyed by hostname, for the underlying
 * crFetchGardssalgContent crawl — same convention, since this route reuses
 * that SAME fetcher for BOTH sides.
 *
 * Covers:
 *   (a) 403 without X-Admin-Key
 *   (b) `limit` is MANDATORY — omitted -> 400; 0/negative/non-integer -> 400;
 *       over MAX_GARDSSALG_TRIAGE_LIMIT (6) -> 400; at the max -> 200
 *   (c) `offset` validation — negative -> 400
 *   (d) auto_confirm via matching registered DOMAIN on both sides — fires
 *       even when the fetch itself 404s (domain comparison uses the stored
 *       URLs, not fetched content)
 *   (e) auto_reject via distinct domain AND no name-token overlap
 *   (f) the mandatory transient-forces-pending case, exercised through a
 *       REAL flaky fetch (503 -> fetch-page.ts's persistenceOf -> transient)
 *       on the experience side, despite the producer side fetching real
 *       org.nr + name evidence successfully — must still be "pending"
 *   (g) pending via a genuinely weak signal (no booking_url at all on the
 *       experience side, one weak place_found signal on the producer side)
 *   (h) the pending bucket is sorted by confidence, descending — (f)'s
 *       richer-evidence pending pair must sort before (g)'s weaker one
 *   (i) an experience CURRENTLY LINKED to a DIFFERENT producer (provider_id
 *       set, not equal to the candidate producer_id) uses that OTHER
 *       producer's own registered identity (org.nr included) as its "own
 *       target identity" — proven via a real auto_reject-via-distinct-org.nr
 *       that only that DB join could produce
 *   (j) response shape: summary counts match the bucket array lengths,
 *       pagination block totals the full live-scanned queue (not just the
 *       page), zero DB writes anywhere (gardssalg_experience_conflict_review
 *       row count, every seeded producer's field_provenance, and every
 *       seeded experience's booking_url are BYTE-FOR-BYTE unchanged
 *       before/after the call)
 *
 * Run standalone: npx tsx src/routes/opplevelser-gardssalg-experience-conflict-triage.test.ts
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
    const method = opts.method || "GET";
    const url = opts.url || "/admin/gardssalg-experience-conflict-auto-triage";
    const [pathOnly, queryString] = url.split("?");
    const query: Record<string, string> = {};
    if (queryString) {
      for (const [k, v] of new URLSearchParams(queryString)) query[k] = v;
    }
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: pathOnly,
      query,
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

export function runOpplevelserGardssalgExperienceConflictTriageTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-experience-conflict-triage-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const conflictServicePath = require.resolve("../services/gardssalg-experience-conflict");
    const triageServicePath = require.resolve("../services/gardssalg-experience-conflict-triage");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, conflictServicePath, triageServicePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, kommune, rfb_seed_source, producer_type,
            epost, telefon, hjemmeside, about_text, products, content_source,
            booking_live, catalog_hidden, slug, field_provenance, brreg_verified,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @kommune, 'rfb-seed', NULL,
            @epost, @telefon, @hjemmeside, @about_text, @products, @content_source,
            0, 0, @slug, NULL, 1,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      const insertExperience = expDb.prepare(
        `INSERT INTO experiences (id, provider_id, title, booking_url, kommune, verification_status)
         VALUES (@id, @provider_id, @title, @booking_url, @kommune, 'pending_verify')`,
      );

      // ── (d) auto_confirm via matching domain — producer.hjemmeside and
      //    experience.booking_url resolve to the SAME registrable domain.
      //    Deliberately left UNMOCKED (falls to the default 404 handler
      //    below) — domain comparison must work from the stored URLs alone,
      //    with no dependency on a successful fetch. NOTE: this pair is
      //    NOT reachable through the real conflict-scan pipeline — a
      //    producer/experience pair whose registrable domains AGREE is
      //    classified status="agree" by findGardssalgProducerExperience
      //    Matches() (gardssalg-experience-conflict.ts) and is therefore
      //    NEVER queued at all (buildGardssalgExperienceConflictQueuePairs
      //    only surfaces status "conflict"/"ambiguous") — by construction,
      //    every pair THIS route ever actually sees already has DIFFERING
      //    domains. So this fixture instead demonstrates the org.nr trigger
      //    (auto_confirm rule 1a), which — unlike the domain trigger — CAN
      //    genuinely occur on a real queued (differing-domain) pair: the
      //    experience is UNLINKED (provider_id null — experience_providers.
      //    org_nr is UNIQUE, so it could never legitimately have its own
      //    "different producer, same org.nr" identity anyway), so its "own
      //    target identity" org.nr falls back to the CANDIDATE producer's
      //    own number (see the route's own doc comment) — and its page
      //    genuinely cites that number. Domains deliberately differ
      //    (fjordly.no vs fjordcruise.example) so the underlying scan status
      //    is "conflict", not "agree" — proving this fires on its own,
      //    independent of any domain signal at all. The pure domain-match
      //    trigger itself is covered directly (with a synthetic, not
      //    DB-derived, input) in services/gardssalg-experience-conflict-
      //    triage.test.ts's own case (c); fixture (i) below covers the
      //    LINKED-to-a-different-producer branch instead, via auto_reject. ─
      insertProvider.run({
        id: "prov-orgnr-match", navn: "Fjordly Bryggeri", org_nr: "600000000", kommune: null,
        epost: "post@fjordly.no", telefon: null, hjemmeside: "https://fjordly.no",
        about_text: "Om bryggeriet.", products: "Øl", content_source: "provider_site",
        slug: "fjordly-bryggeri",
      });
      insertExperience.run({
        id: "exp-orgnr-match", provider_id: null,
        title: "Fjordly Fjordcruise", booking_url: "https://fjordcruise.example/fjordly", kommune: null,
      });

      // ── (e) auto_reject via distinct domain AND no name-token overlap —
      //    a host_name-basis pair (Atlungstad-shaped): the experience's
      //    booking_url host label ("ukjentgaard") matches a token in the
      //    producer's OWN name, which is what gets it queued at all, while
      //    the experience's display TITLE shares no token with the producer
      //    name whatsoever — exactly the shape a bare name-token check would
      //    miss and only the booking_url's host reveals. ─────────────────
      insertProvider.run({
        id: "prov-distinct", navn: "Ukjentgaard Bryggeri", org_nr: null, kommune: null,
        epost: "post@ukjentgaard-produsent.no", telefon: null, hjemmeside: "https://ukjentgaard-produsent.no",
        about_text: "Om bryggeriet.", products: "Øl", content_source: "provider_site",
        slug: "ukjentgaard-bryggeri",
      });
      insertExperience.run({
        id: "exp-distinct", provider_id: null,
        title: "Helt Annen Ting", booking_url: "https://ukjentgaard.example/aktivitet", kommune: null,
      });

      // ── (f) transient-forces-pending — producer side fetches REAL org.nr +
      //    name evidence successfully; experience side is a flaky host that
      //    always answers 503 (fetch-page.ts: http_5xx -> persistence
      //    "transient"). The pair must still come back "pending". Producer
      //    name/experience title share the token "godprodusent" (>=5 chars)
      //    so name_token_support is ALSO true here — proving the transient
      //    override beats even a corroborated signal on top of org_nr+name. ─
      insertProvider.run({
        id: "prov-flaky", navn: "Godprodusent AS", org_nr: "300000000", kommune: null,
        epost: "post@godprodusent.no", telefon: null, hjemmeside: "https://godprodusent.no",
        about_text: "Om produsenten.", products: "Øl", content_source: "provider_site",
        slug: "godprodusent",
      });
      insertExperience.run({
        id: "exp-flaky", provider_id: null,
        title: "Godprodusent Aktivitet", booking_url: "https://flaky-experience.example/tur", kommune: null,
      });

      // ── (g) pending via weak signal — a name_token-basis pair (shared,
      //    distinctive token "lavtillit"), which is ALSO what makes the
      //    experience side's domain-distinct auto_reject rule not fire (the
      //    same overlap that got it matched/queued in the first place
      //    blocks that rule below). No org.nr anywhere, and the
      //    experience's booking_url points at an unmocked (404) host, so
      //    its own evidence stays null — only the producer side's one weak
      //    place_found signal exists at all. ─────────────────────────────
      insertProvider.run({
        id: "prov-weak", navn: "Lavtillit Sider", org_nr: null, kommune: "Ulvik",
        epost: "post@lavtillitsider.no", telefon: null, hjemmeside: "https://lavtillitsider.no",
        about_text: "Om sideriet.", products: "Sider", content_source: "provider_site",
        slug: "lavtillit-sider",
      });
      insertExperience.run({
        id: "exp-weak", provider_id: null,
        title: "Lavtillit Sommeraktiviteter", booking_url: "https://sommeraktiviteter.example/lavtillit", kommune: null,
      });

      // ── (i) experience linked to a DIFFERENT producer than the candidate
      //    — its "own target identity" must be the LINKED producer's row
      //    (org.nr included), not the candidate's and not a title/kommune-
      //    only fallback. Distinct, page-confirmed org.nr on each own side
      //    -> auto_reject, and ONLY the DB join under test can produce it. ──
      insertProvider.run({
        id: "prov-kanelbakken", navn: "Kanelbakken Bryggeri", org_nr: "400000000", kommune: null,
        epost: "post@kanelbakken.no", telefon: null, hjemmeside: "https://kanelbakken.no",
        about_text: "Om bryggeriet.", products: "Øl", content_source: "provider_site",
        slug: "kanelbakken-bryggeri",
      });
      insertProvider.run({
        id: "prov-linked-other", navn: "Nordkyst Handel AS", org_nr: "500000000", kommune: null,
        epost: "post@nordkysthandel.no", telefon: null, hjemmeside: "https://nordkysthandel.no",
        about_text: "Om aktøren.", products: null, content_source: "provider_site",
        slug: "annen-aktor",
      });
      insertExperience.run({
        id: "exp-linked", provider_id: "prov-linked-other",
        title: "Kanelbakken Reise", booking_url: "https://kanelbakken-reise.example/tur", kommune: null,
      });

      let fetchCallCount = 0;
      const fetchedHosts: string[] = [];
      const okResponse = (urlStr: string, html: string) =>
        ({
          ok: true, status: 200, text: async () => html,
          arrayBuffer: async () => new TextEncoder().encode(html).buffer,
          headers: { get: () => null }, url: urlStr,
        }) as unknown as Response;
      const failResponse = (urlStr: string, status: number, statusText: string) =>
        ({
          ok: false, status, statusText, text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          headers: { get: () => null }, url: urlStr,
        }) as unknown as Response;

      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        fetchCallCount++;
        const host = new URL(urlStr).hostname;
        fetchedHosts.push(host);
        if (host === "godprodusent.no") {
          return okResponse(urlStr, "<html><body>Godprodusent AS. Org.nr 300 000 000.</body></html>");
        }
        if (host === "flaky-experience.example") {
          return failResponse(urlStr, 503, "Service Unavailable");
        }
        if (host === "lavtillitsider.no") {
          return okResponse(urlStr, "<html><body>Velkommen til Ulvik.</body></html>");
        }
        if (host === "kanelbakken.no") {
          return okResponse(urlStr, "<html><body>Kanelbakken Bryggeri. Org.nr 400 000 000.</body></html>");
        }
        if (host === "kanelbakken-reise.example") {
          return okResponse(urlStr, "<html><body>Reise med Nordkyst Handel AS. Org.nr 500 000 000.</body></html>");
        }
        if (host === "fjordly.no") {
          return okResponse(urlStr, "<html><body>Fjordly Bryggeri. Org.nr 600 000 000.</body></html>");
        }
        if (host === "fjordcruise.example") {
          return okResponse(urlStr, "<html><body>Fjordly Aktiviteter AS. Org.nr 600 000 000.</body></html>");
        }
        // Default: 404 — covers the (e) auto_reject fixture's hosts (content
        // doesn't matter for a domain-only rule) and (g)'s experience side
        // (its evidence must stay null; only the producer side has any).
        return failResponse(urlStr, 404, "Not Found");
      }) as typeof fetch;

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── (a) 403 without X-Admin-Key ──────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-experience-conflict-auto-triage?limit=6",
      });
      assertEq(noKey.status, 403, "a1: GET without X-Admin-Key -> 403");

      // ── (b) `limit` validation ────────────────────────────────────────────
      const noLimit = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-experience-conflict-auto-triage",
        headers: { "x-admin-key": testKey },
      });
      assertEq(noLimit.status, 400, "b1: no limit at all -> 400 (mandatory, no unbounded default exists for this queue)");
      assertTrue(/limit er påkrevd/.test(noLimit.body.error || ""), "b1b: error names the mandatory-limit requirement");

      const zeroLimit = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-experience-conflict-auto-triage?limit=0",
        headers: { "x-admin-key": testKey },
      });
      assertEq(zeroLimit.status, 400, "b2: limit=0 -> 400");

      const negLimit = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-experience-conflict-auto-triage?limit=-1",
        headers: { "x-admin-key": testKey },
      });
      assertEq(negLimit.status, 400, "b3: limit=-1 -> 400");

      const strLimit = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-experience-conflict-auto-triage?limit=abc",
        headers: { "x-admin-key": testKey },
      });
      assertEq(strLimit.status, 400, "b4: limit=abc -> 400 (not an integer)");

      const overMax = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-experience-conflict-auto-triage?limit=7",
        headers: { "x-admin-key": testKey },
      });
      assertEq(overMax.status, 400, "b5: limit=7 (one over the max) -> 400");
      assertEq(overMax.body.error, "Ugyldig limit — maks er 6.", "b5b: error names the max");

      // ── (c) `offset` validation ───────────────────────────────────────────
      const negOffset = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-experience-conflict-auto-triage?limit=6&offset=-1",
        headers: { "x-admin-key": testKey },
      });
      assertEq(negOffset.status, 400, "c1: offset=-1 -> 400");
      assertTrue(/Ugyldig offset/.test(negOffset.body.error || ""), "c1b: error names the field");

      // ── zero-write pre-check snapshot ─────────────────────────────────────
      const decisionCountBefore = (expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_experience_conflict_review`).get() as any).n;
      const providerSnapshotBefore = expDb
        .prepare(`SELECT id, field_provenance FROM experience_providers ORDER BY id`)
        .all();
      const experienceSnapshotBefore = expDb
        .prepare(`SELECT id, booking_url FROM experiences ORDER BY id`)
        .all();

      // ── main run: limit=6 covers all 5 seeded pairs in one call ─────────
      const mainRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-experience-conflict-auto-triage?limit=6",
        headers: { "x-admin-key": testKey },
      });
      assertEq(mainRes.status, 200, "d0: main GET at the max limit -> 200");

      function findRow(bucket: any[], producerId: string): any {
        return bucket.find((r: any) => r.producer_id === producerId);
      }

      // ── (d) auto_confirm via matching org.nr, both sides page-confirmed,
      //    experience side UNLINKED, so its org.nr falls back to the
      //    CANDIDATE's own number and its page genuinely cites it, domains
      //    genuinely differing (a real, reachable queue pair) ─────────────
      const orgnrMatchRow = findRow(mainRes.body.auto_confirm, "prov-orgnr-match");
      assertTrue(!!orgnrMatchRow, "d1: prov-orgnr-match is in the auto_confirm bucket");
      assertTrue(orgnrMatchRow.reasons.includes("org_nr_match_both_sides"), "d2: reason names the org_nr match");
      assertEq(orgnrMatchRow.evidence.producer.org_nr, "600000000", "d3: producer-side org.nr is its own");
      assertEq(orgnrMatchRow.evidence.experience.org_nr, "600000000", "d4: experience-side org.nr fell back to the CANDIDATE's own number (unlinked experience)");
      assertEq(orgnrMatchRow.evidence.producer.domain, "fjordly.no", "d5: producer domain");
      assertEq(orgnrMatchRow.evidence.experience.domain, "fjordcruise.example", "d6: experience domain genuinely differs — the org.nr rule fired independent of any domain signal");

      // ── (e) auto_reject via distinct domain + no name overlap ────────────
      const distinctRow = findRow(mainRes.body.auto_reject, "prov-distinct");
      assertTrue(!!distinctRow, "e1: prov-distinct is in the auto_reject bucket");
      assertTrue(distinctRow.reasons.includes("domain_distinct_no_name_overlap"), "e2: reason names the domain-distinct-no-overlap rule");

      // ── (f) transient-forces-pending, through a REAL flaky fetch ─────────
      const flakyRow = findRow(mainRes.body.pending, "prov-flaky");
      assertTrue(!!flakyRow, "f1: prov-flaky is in the PENDING bucket, not auto_confirm/auto_reject");
      assertTrue(flakyRow.reasons.includes("transient_fetch_forces_pending"), "f2: reason names the transient override");
      assertEq(flakyRow.evidence.experience.persistence, "transient", "f3: experience side's real fetch outcome classified as transient (http_5xx via fetch-page.ts)");
      assertEq(flakyRow.evidence.producer.fetch_ok, true, "f4: producer side's fetch genuinely succeeded");
      assertEq(flakyRow.evidence.producer.evidence?.org_nr_found, true, "f5: producer side's evidence genuinely found org.nr — a strong signal that did NOT save it from pending");
      assertEq(flakyRow.evidence.producer.evidence?.name_found, true, "f6: producer side's evidence genuinely found the name too");
      assertTrue(flakyRow.name_token_support, "f7: name-token support ALSO fired here (godprodusent/godprodusent) — the override beats even a corroborated signal");
      assertTrue(fetchedHosts.includes("flaky-experience.example"), "f8: the flaky host really was fetched (sanity — the mock is not dead code)");

      // ── (g) pending via weak signal ───────────────────────────────────────
      const weakRow = findRow(mainRes.body.pending, "prov-weak");
      assertTrue(!!weakRow, "g1: prov-weak is in the pending bucket");
      assertTrue(weakRow.reasons.includes("weak_or_ambiguous_signal"), "g2: reason names the weak/ambiguous fallback (not the transient override — this pair never fetched anything transient)");
      assertEq(weakRow.evidence.experience.fetch_ok, false, "g3: experience side's fetch genuinely 404'd (an unmocked host)");
      assertEq(weakRow.evidence.experience.persistence, "permanent", "g4: a 404 classifies as permanent, not transient — this pair is pending on its own weak-evidence merits, not via the transient override");
      assertTrue(weakRow.name_token_support, "g4b: the shared token 'lavtillit' (what got this pair matched/queued at all) is exactly what keeps the domain-distinct auto_reject rule from firing here");
      assertEq(weakRow.evidence.producer.evidence?.place_found, true, "g5: producer side's weak place_found signal genuinely fired (kommune 'Ulvik' on the page)");
      assertEq(weakRow.evidence.producer.evidence?.org_nr_found, false, "g6: no org.nr signal on this pair at all");

      // ── (h) pending bucket sorted by confidence, descending ──────────────
      const pendingIds = mainRes.body.pending.map((r: any) => r.producer_id);
      const flakyIdx = pendingIds.indexOf("prov-flaky");
      const weakIdx = pendingIds.indexOf("prov-weak");
      assertTrue(flakyIdx >= 0 && weakIdx >= 0, "h0: both pending fixtures are present (precondition for the ordering check)");
      assertTrue(flakyRow.confidence > weakRow.confidence, "h1: the richer-evidence pending pair (org_nr+name+name_token_support) has strictly higher confidence than the weak one");
      assertTrue(flakyIdx < weakIdx, "h2: the pending bucket sorts higher-confidence pairs FIRST (best-evidence-first)");

      // ── (i) experience linked to a DIFFERENT producer — auto_reject via
      //    that producer's OWN distinct, page-confirmed org.nr ────────────
      const linkedRow = findRow(mainRes.body.auto_reject, "prov-kanelbakken");
      assertTrue(!!linkedRow, "i1: prov-kanelbakken/exp-linked is in the auto_reject bucket");
      assertTrue(linkedRow.reasons.includes("org_nr_distinct_both_sides"), "i2: reason names the org_nr distinctness");
      assertEq(linkedRow.evidence.producer.org_nr, "400000000", "i3: producer side's own org.nr");
      assertEq(linkedRow.evidence.experience.org_nr, "500000000", "i4: experience side's org.nr came from the LINKED producer (prov-linked-other), not the candidate and not a title/kommune-only fallback");
      assertEq(linkedRow.evidence.experience.evidence?.org_nr_found, true, "i5: the linked producer's org.nr was genuinely confirmed present on the experience's OWN fetched page");

      // ── (j) response shape + pagination + zero writes ────────────────────
      assertEq(
        mainRes.body.summary,
        {
          auto_confirm: mainRes.body.auto_confirm.length,
          auto_reject: mainRes.body.auto_reject.length,
          pending: mainRes.body.pending.length,
          total: mainRes.body.auto_confirm.length + mainRes.body.auto_reject.length + mainRes.body.pending.length,
        },
        "j1: summary counts exactly match the three bucket array lengths",
      );
      assertEq(mainRes.body.pagination.total, 5, "j2: pagination.total counts the full live-scanned queue (all 5 seeded pairs)");
      assertEq(mainRes.body.pagination.returned, 5, "j3: this call's limit=6 covered all 5 in one page");
      assertEq(mainRes.body.pagination.next_offset, null, "j4: nothing left to page — next_offset is null");

      const decisionCountAfter = (expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_experience_conflict_review`).get() as any).n;
      assertEq(decisionCountAfter, decisionCountBefore, "j5: zero writes — gardssalg_experience_conflict_review row count is unchanged");

      const providerSnapshotAfter = expDb
        .prepare(`SELECT id, field_provenance FROM experience_providers ORDER BY id`)
        .all();
      assertEq(providerSnapshotAfter, providerSnapshotBefore, "j6: zero writes — every producer row (incl. field_provenance) is byte-for-byte unchanged");

      const experienceSnapshotAfter = expDb
        .prepare(`SELECT id, booking_url FROM experiences ORDER BY id`)
        .all();
      assertEq(experienceSnapshotAfter, experienceSnapshotBefore, "j7: zero writes — every experience row (incl. booking_url) is byte-for-byte unchanged");

      // ── offset pagination sanity — page through with limit=2 ─────────────
      const page1 = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-experience-conflict-auto-triage?limit=2&offset=0",
        headers: { "x-admin-key": testKey },
      });
      assertEq(page1.body.pagination, { total: 5, offset: 0, limit: 2, returned: 2, next_offset: 2 }, "k1: first page of a limit=2 walk");
      const page2 = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-experience-conflict-auto-triage?limit=2&offset=2",
        headers: { "x-admin-key": testKey },
      });
      assertEq(page2.body.pagination, { total: 5, offset: 2, limit: 2, returned: 2, next_offset: 4 }, "k2: second page of the walk");
      const page3 = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-experience-conflict-auto-triage?limit=2&offset=4",
        headers: { "x-admin-key": testKey },
      });
      assertEq(page3.body.pagination, { total: 5, offset: 4, limit: 2, returned: 1, next_offset: null }, "k3: third (final) page — one row left, next_offset null");
    } catch (err: any) {
      failed++;
      failures.push(
        "opplevelser-gardssalg-experience-conflict-triage: unexpected error: " + String(err?.stack || err?.message || err),
      );
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-experience-conflict-triage.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgExperienceConflictTriageTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
