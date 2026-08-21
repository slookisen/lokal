/**
 * opplevelser-gardssalg-website-discovery.test.ts — tests for skive B of
 * dev-request 2026-07-19-gardssalg-nye-agenter-komplett-foer-synlig:
 * POST /admin/gardssalg-website-discovery (deterministic candidate hosts from
 * the provider's own name, SSRF-guarded fetch with redirect re-check,
 * ownership evidence org_nr/name+place, verified candidates parked in
 * gardssalg_website_review_queue — never written directly) and
 * POST /admin/gardssalg-website-review-approve (strict confirmation surface
 * mirroring the org_nr lever, writes via applyGardssalgProviderWebsite's
 * fill-only/lock/shared-host guards + audit/provenance/rollback).
 * Also pins the komplett-foer-synlig prerequisites: hidden rows ARE selected
 * for discovery, and gardssalgSharedHostCounts now counts hidden rows
 * (excluding only the test provider by marker).
 *
 * Same conventions as sibling gårdssalg route test files: :memory: DB, fresh
 * requires, router.handle(), mocked globalThis.fetch keyed on URL.
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
    const url = opts.url || "/admin/gardssalg-website-discovery";
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

export function runOpplevelserGardssalgWebsiteDiscoveryTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-wd-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const brregClientPath = require.resolve("../services/brreg-client");
    const blocklistPath = require.resolve("../services/blocklist-service");
    const opplevelserPath = require.resolve("./opplevelser");
    const providerWorkQueuePath = require.resolve("../services/provider-work-queue");
    const cachePaths = [dbFactoryPath, experienceStorePath, brregClientPath, blocklistPath, opplevelserPath, providerWorkQueuePath];
    for (const p of cachePaths) delete require.cache[p];

    let prevRfbDb: any = null;

    try {
      // Skive D (dev-request 2026-08-17-cs-plattformparitet-og-verifisert-
      // utfoerelse): the blocklist gate reads agent_blocklist, which lives on
      // the RFB db (database/init.ts), NOT the experiences db — inject a
      // fresh :memory: instance (same pattern as the other gårdssalg route
      // test files that exercise the blocklist gate).
      const initMod = require("../database/init") as typeof import("../database/init");
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const rfbDb = new Database(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);
      const blocklistSvc = require("../services/blocklist-service") as typeof import("../services/blocklist-service");

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const providerWorkQueue = require("../services/provider-work-queue") as typeof import("../services/provider-work-queue");
      const adminHeaders = { "x-admin-key": testKey };

      // ═══ Section A — pure candidate-host generation ═════════════════════
      {
        const h1 = expStore.gardssalgWebsiteCandidateHosts("Fjelldal Brenneri AS");
        assertTrue(h1.includes("fjelldalbrenneri.no"), "wd-a1: joined .no candidate, org-suffix dropped");
        assertTrue(h1.includes("fjelldal-brenneri.no"), "wd-a2: hyphenated candidate");
        const h2 = expStore.gardssalgWebsiteCandidateHosts("Bjørkegård Sideri — Hardanger");
        assertTrue(h2.includes("bjorkegardsideri.no"), "wd-a3: ø→o/å→a variant, «— Sted» pruned before generation");
        assertTrue(h2.includes("bjoerkegaardsideri.no"), "wd-a4: ø→oe/å→aa variant generated too");
        assertTrue(h2.length <= 6, "wd-a5: at most 6 candidates (v2 — .no guesses plus .com variants)");
        const h3 = expStore.gardssalgWebsiteCandidateHosts("Ås AS");
        assertEq(h3.length, 0, "wd-a6: degenerate too-short label yields no candidates");
      }

      // ═══ Section B — pure ownership-evidence matching ═══════════════════
      {
        const page = expStore.gardssalgPageText(
          "<html><head><style>.x{color:red}</style></head><body><h1>Testbryggeriet Nord</h1>" +
          "<script>var t='ignorert 999888777';</script>" +
          "<p>Org.nr: 925 174 971 &mdash; Fjordbygda</p></body></html>"
        );
        assertTrue(!page.includes("999888777"), "wd-b1: script content stripped before matching");
        assertTrue(!page.includes("color:red"), "wd-b2: style content stripped");
        const ev1 = expStore.gardssalgWebsiteEvidenceMatch(page, { orgNr: "925174971", navn: "Ukjent Navn", kommune: null, poststed: null });
        assertEq(ev1.org_nr_found, true, "wd-b3: space-separated org_nr on page is found");
        assertEq(ev1.verified, true, "wd-b4: org_nr alone verifies");
        const ev2 = expStore.gardssalgWebsiteEvidenceMatch("kontonummer 1925174971x", { orgNr: "925174971", navn: "X", kommune: null, poststed: null });
        assertEq(ev2.org_nr_found, false, "wd-b5: org_nr embedded in a longer digit run does NOT match");
        const ev3 = expStore.gardssalgWebsiteEvidenceMatch(
          "Velkommen til Testbryggeriet Nord i vakre Fjordbygda kommune",
          { orgNr: null, navn: "Testbryggeriet Nord — Fjordbygda", kommune: "Fjordbygda", poststed: null }
        );
        assertEq(ev3.name_found, true, "wd-b6: exact pruned name found");
        assertEq(ev3.place_found, true, "wd-b7: kommune found");
        assertEq(ev3.verified, true, "wd-b8: name+place verifies without org_nr");
        const ev4 = expStore.gardssalgWebsiteEvidenceMatch(
          "Velkommen til Testbryggeriet Nord",
          { orgNr: null, navn: "Testbryggeriet Nord", kommune: "Fjordbygda", poststed: null }
        );
        assertEq(ev4.verified, false, "wd-b9: name WITHOUT place does not verify");
        const ev5 = expStore.gardssalgWebsiteEvidenceMatch(
          "Vi selger sider i Fjordbygda",
          { orgNr: null, navn: "Sider", kommune: "Fjordbygda", poststed: null }
        );
        assertEq(ev5.verified, false, "wd-b10: short generic single-token name never verifies on name+place");
        // Review M2 (2026-07-19): word boundaries in the normalized space.
        const ev6 = expStore.gardssalgWebsiteEvidenceMatch(
          "Berg Gardsdrift held til i Nes kommune",
          { orgNr: null, navn: "Berg Gard", kommune: "Nes", poststed: null }
        );
        assertEq(ev6.name_found, false, "wd-b11: name is NOT found mid-word («berg gard» vs «Berg Gardsdrift»)");
        const ev7 = expStore.gardssalgWebsiteEvidenceMatch(
          "Vi held til i Sandnes sentrum",
          { orgNr: null, navn: "Testbryggeriet Nord", kommune: "Nes", poststed: null }
        );
        assertEq(ev7.place_found, false, "wd-b12: kommune «Nes» does NOT match inside «Sandnes»");
        const ev8 = expStore.gardssalgWebsiteEvidenceMatch(
          "Garden ligg i Nes på Hedmarken",
          { orgNr: null, navn: "Testbryggeriet Nord", kommune: "Nes", poststed: null }
        );
        assertEq(ev8.place_found, true, "wd-b13: kommune «Nes» as its own word still matches (boundaries, not blanket rejection)");
      }

      // ═══ Section C — search-based candidate helpers (pure) — dev-request
      //     2026-07-21-gardssalg-soekebasert-nettsidefunn ═══════════════════
      {
        const q1 = expStore.gardssalgWebsiteSearchQuery({ navn: "Fjelldal Brenneri AS", kommune: "Saltdal", poststed: null, producer_type: "bryggeri" });
        assertEq(q1, `"Fjelldal Brenneri AS" Saltdal bryggeri`, "wd-c1: query is «\"name\" kommune producer_type»");
        const q2 = expStore.gardssalgWebsiteSearchQuery({ navn: "Bjørkegård Sideri — Hardanger", kommune: null, poststed: "5750 Odda", producer_type: null });
        assertEq(q2, `"Bjørkegård Sideri" 5750 Odda`, "wd-c2: «— Sted» pruned from name; poststed used when kommune absent; no trailing keyword when producer_type unknown");

        const hosts1 = expStore.gardssalgWebsiteSearchCandidateHosts([
          { title: "A", url: "https://Www.Eksempel.no/om-oss", description: "" },
          { title: "B", url: "https://eksempel.no/kontakt", description: "" }, // same host (www-insensitive) — deduped
          { title: "C", url: "https://annen-gard.no", description: "" },
          { title: "D", url: "", description: "" }, // unparsable/empty — skipped, not thrown
        ] as any);
        assertEq(JSON.stringify(hosts1), JSON.stringify(["eksempel.no", "annen-gard.no"]),
          "wd-c3: hosts deduped (www-insensitive), Brave's own relevance order preserved, empty url skipped");
        const hosts2 = expStore.gardssalgWebsiteSearchCandidateHosts(
          Array.from({ length: 8 }, (_, i) => ({ title: "x", url: `https://host${i}.no`, description: "" })) as any,
          3,
        );
        assertEq(hosts2.length, 3, "wd-c4: capped at maxCandidates");

        assertEq(expStore.gardssalgSocialMediaHostReason("www.facebook.com"), "social_media_host", "wd-c5: facebook.com (www-prefixed) is a social host");
        assertEq(expStore.gardssalgSocialMediaHostReason("m.facebook.com"), "social_media_host", "wd-c6: subdomain family (m.facebook.com) also matches");
        assertEq(expStore.gardssalgSocialMediaHostReason("eksempel.no"), null, "wd-c7: an ordinary host is not a social host");
        assertEq(expStore.gardssalgWebsiteHostExclusionReason("instagram.com"), "social_media_host",
          "wd-c8: combined exclusion reports the MORE SPECIFIC social reason for a host that is both social AND a curated directory host");
        assertEq(expStore.gardssalgWebsiteHostExclusionReason("hanen.no"), "blocklisted_directory_domain",
          "wd-c9: a non-social directory host still reports its own reason via the combined check");
      }

      // ═══ Fixtures ═══════════════════════════════════════════════════════
      const insertProviderStmt = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, kommune, poststed, hjemmeside, catalog_hidden, content_source, products,
            producer_type, enrichment_state, verification_status, source, confidence, field_provenance)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @kommune, @poststed, @hjemmeside, @catalog_hidden, @content_source, '["x"]',
            @producer_type, 'raw', 'pending_verify', 'test-fixture', 'medium', @field_provenance)`,
      );
      // Wrapper so most fixtures can omit field_provenance entirely (defaults
      // to null/none) while owner-lock-specific fixtures below can stamp it.
      const insertProvider = {
        run(params: Record<string, unknown>): void {
          insertProviderStmt.run({ field_provenance: null, ...params });
        },
      };
      // HIDDEN row (the komplett-foer-synlig batch shape) — page will carry its org_nr.
      insertProvider.run({ id: "wd-hidden", navn: "Fjelldal Brenneri", org_nr: "944444444", kommune: "Saltdal", poststed: null, hjemmeside: null, catalog_hidden: 1, content_source: null, producer_type: "destilleri" });
      // Visible row whose candidate host collides with the curated directory list (hanen.no).
      insertProvider.run({ id: "wd-agg", navn: "Hanen", org_nr: "911111111", kommune: "Oslo", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "bryggeri" });
      // Row whose candidate host is ALREADY carried by another catalog row.
      insertProvider.run({ id: "wd-taken", navn: "Solbakken Gard", org_nr: "922222222", kommune: "Voss", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "sideri" });
      // Blank row for the scheme-optional fill-path fixture (2026-08-13 fix).
      insertProvider.run({ id: "wd-schemeless", navn: "Skjemalos Bryggeri", org_nr: "911223222", kommune: "Bergen", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "bryggeri" });
      insertProvider.run({ id: "wd-owner", navn: "Annen Produsent", org_nr: "933333333", kommune: "Voss", poststed: null, hjemmeside: "https://solbakkengard.no", catalog_hidden: null, content_source: null, producer_type: "sideri" });
      // Claim-locked row — never processed. Stamped with
      // field_provenance.owner_locks.hjemmeside (dev-request 2026-08-03-
      // gardssalg-owner-lock-rollback, pilot widened to
      // applyGardssalgProviderWebsite): this is now a true "owner touched
      // THIS field via the claim portal" positive, not just a bare
      // content_source='claim' row-level assumption — see wd-6a/f below.
      insertProvider.run({
        id: "wd-locked", navn: "Kravsatt Gard", org_nr: "955555555", kommune: "Bodø", poststed: null,
        hjemmeside: null, catalog_hidden: null, content_source: "claim", producer_type: "bryggeri",
        field_provenance: JSON.stringify({ owner_locks: { hjemmeside: { locked_at: "2026-08-01T12:00:00.000Z" } } }),
      });
      // Claim row where the owner touched a DIFFERENT claim-editable field
      // (about_text) but never hjemmeside — proves the per-field narrowing
      // actually unlocks writes it should, not just that nothing broke.
      insertProvider.run({
        id: "wd-claim-unlocked", navn: "Ny Eier Gard", org_nr: "944555666", kommune: "Bodø", poststed: null,
        hjemmeside: null, catalog_hidden: null, content_source: "claim", producer_type: "bryggeri",
        field_provenance: JSON.stringify({ owner_locks: { about_text: { locked_at: "2026-08-01T12:00:00.000Z" } } }),
      });
      // Manual row — unconditionally locked, never consults owner_locks (no
      // field_provenance at all here, matching the real write path).
      insertProvider.run({ id: "wd-manual", navn: "Manuell Gard", org_nr: "944777888", kommune: "Bodø", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: "manual", producer_type: "bryggeri" });
      // Row with no verifiable page anywhere.
      insertProvider.run({ id: "wd-none", navn: "Ukjent Fjellgard", org_nr: "966666666", kommune: "Lom", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "bryggeri" });
      // Test provider — must never be selected nor counted.
      insertProvider.run({ id: "wd-testprov", navn: "Test Gardssalg", org_nr: "977777777", kommune: "Oslo", poststed: null, hjemmeside: "https://testgardssalg.example.no", catalog_hidden: 1, content_source: null, producer_type: "test-gardssalg" });
      // Redirect-re-check fixtures (review M1): both pages CARRY full
      // ownership evidence — the ONLY thing that may reject them is the
      // final-host re-check after the redirect. Deleting that block turns
      // these into proposals and wd-9 fails.
      insertProvider.run({ id: "wd-redir-agg", navn: "Omdirigert Gard", org_nr: "988000001", kommune: "Rana", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "bryggeri" });
      insertProvider.run({ id: "wd-redir-taken", navn: "Viderekoblet Gard", org_nr: "988000002", kommune: "Voss", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "sideri" });

      let fetchCalls: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        fetchCalls.push(urlStr);
        const mk = (html: string, finalUrl?: string) =>
          ({ ok: true, status: 200, url: finalUrl ?? urlStr, text: async () => html } as unknown as Response);
        if (urlStr.startsWith("https://fjelldalbrenneri.no")) {
          return mk("<html><body>Fjelldal Brenneri — org.nr 944 444 444</body></html>");
        }
        if (urlStr.startsWith("https://omdirigertgard.no")) {
          // Full evidence on the page, but the request LANDED on a curated
          // directory host — only the final-host re-check can reject this.
          return mk("<html><body>Omdirigert Gard, Rana — org.nr 988000001</body></html>", "https://en.hanen.no/medlem/omdirigert-gard");
        }
        if (urlStr.startsWith("https://viderekobletgard.no")) {
          // Full evidence, but the final host is already carried by wd-owner.
          return mk("<html><body>Viderekoblet Gard, Voss — org.nr 988000002</body></html>", "https://solbakkengard.no/ny-side");
        }
        if (urlStr.startsWith("https://ukjentfjellgard.no") || urlStr.startsWith("https://ukjent-fjellgard.no")) {
          return mk("<html><body>Parkert domene til salgs</body></html>");
        }
        // Everything else: unreachable.
        return { ok: false, status: 404, url: urlStr, text: async () => "" } as unknown as Response;
      }) as unknown as typeof fetch;

      // ── wd-1: auth + validation. ────────────────────────────────────────
      {
        const r = await callRoute(opplevelserRouter, { body: {} });
        assertEq(r.status, 403, "wd-1a: no admin key → 403");
      }
      {
        const ids = Array.from({ length: 49 }, (_, i) => `x-${i}`);
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { providerIds: ids } });
        assertEq(r.status, 400, "wd-1b: more than 48 providerIds → 400");
      }

      // ── wd-2: DRY-RUN — fetches happen, NOTHING is written. ─────────────
      {
        fetchCalls = [];
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { providerIds: ["wd-hidden", "wd-agg", "wd-taken", "wd-locked", "wd-none", "finnes-ikke"] },
        });
        assertEq(r.status, 200, "wd-2a: dry-run 200");
        assertEq(r.body.dry_run, true, "wd-2b: dry-run is the default");
        assertEq(r.body.scanned, 4, "wd-2c: locked + unknown never reach processing (4 real targets)");
        assertEq((r.body.skipped_locked as any[])[0]?.provider_id, "wd-locked", "wd-2d: locked row reported");
        assertEq((r.body.not_found as any[])[0], "finnes-ikke", "wd-2e: unknown id reported");
        assertEq(r.body.proposed_count, 1, "wd-2f: exactly one verified proposal (wd-hidden)");
        const prop = (r.body.proposed as any[])[0];
        assertEq(prop?.provider_id, "wd-hidden", "wd-2g: HIDDEN row is discoverable (komplett-foer-synlig batch shape)");
        assertEq(prop?.candidate_url, "https://fjelldalbrenneri.no", "wd-2h: candidate is the final origin");
        assertEq(prop?.evidence?.org_nr_found, true, "wd-2i: verified via org_nr on the page");
        const aggEx = (r.body.excluded as any[]).find((e) => e.provider_id === "wd-agg");
        assertTrue(!!aggEx && aggEx.hosts.some((h: any) => h.host === "hanen.no" && h.reason === "blocklisted_directory_domain"),
          "wd-2j: curated directory host excluded BEFORE fetch");
        assertTrue(!fetchCalls.some((u) => u.includes("hanen.no")), "wd-2k: no fetch ever went to the excluded host");
        const takenEx = (r.body.excluded as any[]).find((e) => e.provider_id === "wd-taken");
        assertTrue(!!takenEx && takenEx.hosts.some((h: any) => h.reason === "host_already_in_catalog"),
          "wd-2l: host already carried by another provider excluded (identity guard)");
        assertTrue(!fetchCalls.some((u) => u.includes("solbakkengard.no")), "wd-2m: no fetch to the taken host either");
        const nn = (r.body.no_candidate_verified as any[]).find((e) => e.provider_id === "wd-none");
        assertTrue(!!nn && nn.tried.length > 0, "wd-2n: unverifiable row lands in no_candidate_verified with tried hosts");
        const qCnt = (expDb.prepare(`SELECT COUNT(*) c FROM gardssalg_website_review_queue`).get() as any).c;
        assertEq(qCnt, 0, "wd-2o: dry-run wrote NOTHING to the queue");
        const stamped = (expDb.prepare(`SELECT COUNT(*) c FROM experience_providers WHERE website_discovery_attempted_at IS NOT NULL`).get() as any).c;
        assertEq(stamped, 0, "wd-2p: dry-run stamped NOTHING");
      }

      // ── wd-9: redirect-re-check is load-bearing (review M1) — pages with
      //    FULL evidence must still be rejected when the request lands on an
      //    excluded/taken final host. ─────────────────────────────────────
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { providerIds: ["wd-redir-agg", "wd-redir-taken"] },
        });
        assertEq(r.body.proposed_count, 0, "wd-9a: full on-page evidence proposes NOTHING when the final host is rejected");
        const aggEx = (r.body.excluded as any[]).find((e) => e.provider_id === "wd-redir-agg");
        assertTrue(!!aggEx && aggEx.hosts.some((h: any) => h.host === "en.hanen.no" && h.reason === "blocklisted_directory_domain"),
          "wd-9b: redirect onto a curated directory host rejected by the FINAL-host re-check");
        const takenEx = (r.body.excluded as any[]).find((e) => e.provider_id === "wd-redir-taken");
        assertTrue(!!takenEx && takenEx.hosts.some((h: any) => h.host === "solbakkengard.no" && h.reason === "host_already_in_catalog"),
          "wd-9c: redirect onto a host another provider already carries rejected (identity guard)");
        const nn = (r.body.no_candidate_verified as any[]).map((e) => e.provider_id).sort();
        assertEq(JSON.stringify(nn), JSON.stringify(["wd-redir-agg", "wd-redir-taken"]),
          "wd-9d: both rows fall through to no_candidate_verified — never to proposed");
      }

      // ── wd-3: APPLY — queue upserted, attempts stamped (incl. failures). ─
      let queuedUrl = "";
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { providerIds: ["wd-hidden", "wd-none"], apply: true },
        });
        assertEq(r.body.dry_run, false, "wd-3a: apply mode");
        assertEq(r.body.proposed_count, 1, "wd-3b: same single proposal");
        const q = expDb.prepare(`SELECT * FROM gardssalg_website_review_queue WHERE provider_id='wd-hidden'`).get() as any;
        assertTrue(!!q, "wd-3c: verified candidate parked in the review queue");
        assertEq(q?.candidate_url, "https://fjelldalbrenneri.no", "wd-3d: queued candidate_url is the final origin");
        assertEq(q?.reason, "website_discovery_candidate", "wd-3e: queue reason marks discovery as origin");
        assertEq(q?.confidence, 1.0, "wd-3f: org_nr evidence → confidence 1.0");
        queuedUrl = q?.candidate_url;
        const hj = (expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id='wd-hidden'`).get() as any).hjemmeside;
        assertEq(hj, null, "wd-3g: discovery NEVER writes hjemmeside directly");
        const stamps = expDb.prepare(`SELECT id FROM experience_providers WHERE website_discovery_attempted_at IS NOT NULL ORDER BY id`).all() as any[];
        assertEq(stamps.length, 2, "wd-3h: BOTH processed rows stamped (anti-starvation incl. the failure)");
        assertEq(r.body.queue_size, 1, "wd-3i: queue size reported");
      }

      // ── wd-4: auto-select respects the attempt stamp + skips test provider. ─
      {
        const sel = expStore.selectGardssalgProvidersForWebsiteDiscovery(48);
        const ids = sel.map((s: any) => s.id);
        assertTrue(!ids.includes("wd-testprov"), "wd-4a: test provider never selected");
        assertTrue(!ids.includes("wd-locked"), "wd-4b: locked row never selected");
        assertTrue(!ids.includes("wd-owner"), "wd-4c: row WITH hjemmeside never selected");
        assertTrue(ids.includes("wd-hidden"), "wd-4d: hidden row IS selectable");
        assertEq(ids[0], "wd-agg", "wd-4e: never-attempted rows order before stamped ones");
      }

      // ── wd-5: approve lever — strict confirmation surface. ──────────────
      {
        const dry = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          url: "/admin/gardssalg-website-review-approve",
          body: { approvals: [
            { provider_id: "wd-hidden", url: queuedUrl },
            { provider_id: "wd-hidden", url: queuedUrl },
            { provider_id: "ukjent", url: "https://x.no" },
            { provider_id: "wd-none", url: "https://feil.no" },
          ] },
        });
        assertEq(dry.body.dry_run, true, "wd-5a: approve dry-run default");
        assertEq(dry.body.approved_count, 1, "wd-5b: only the queued exact pair approves");
        const reasons = Object.fromEntries((dry.body.rejected as any[]).map((r: any) => [r.provider_id, r.reason]));
        assertEq(reasons["wd-hidden"], "duplicate_in_request", "wd-5c: duplicate item rejected");
        assertEq(reasons["ukjent"], "not_in_review_queue", "wd-5d: non-queued provider rejected");
        assertEq(reasons["wd-none"], "not_in_review_queue", "wd-5e: provider without queue entry rejected");
        const hjDry = (expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id='wd-hidden'`).get() as any).hjemmeside;
        assertEq(hjDry, null, "wd-5f: dry-run wrote nothing");
        const bad = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          url: "/admin/gardssalg-website-review-approve",
          body: { approvals: [{ provider_id: "wd-hidden", url: "https://noe-annet.no" }], apply: true },
        });
        assertEq((bad.body.rejected as any[])[0]?.reason, "mismatch_with_queued_candidate",
          "wd-5g: a DIFFERENT url than the queued candidate is rejected (no arbitrary-write surface)");
        const ok = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          url: "/admin/gardssalg-website-review-approve",
          body: { approvals: [{ provider_id: "wd-hidden", url: queuedUrl }], apply: true },
        });
        assertEq(ok.body.written_count, 1, "wd-5h: queued pair applies");
        const row = expDb.prepare(`SELECT hjemmeside, field_provenance FROM experience_providers WHERE id='wd-hidden'`).get() as any;
        assertEq(row.hjemmeside, "https://fjelldalbrenneri.no", "wd-5i: hjemmeside persisted via the guarded applier");
        assertTrue(!!JSON.parse(row.field_provenance || "{}").hjemmeside, "wd-5j: field_provenance.hjemmeside stamped");
        const audit = (expDb.prepare(`SELECT COUNT(*) c FROM gardssalg_content_audit WHERE provider_id='wd-hidden' AND field_name='hjemmeside'`).get() as any).c;
        assertEq(audit, 1, "wd-5k: approve write carries the audit trail");
        const qLeft = (expDb.prepare(`SELECT COUNT(*) c FROM gardssalg_website_review_queue WHERE provider_id='wd-hidden'`).get() as any).c;
        assertEq(qLeft, 0, "wd-5l: queue entry cleared on confirmed write");
        const again = expStore.applyGardssalgProviderWebsite("wd-hidden", "https://helt-annen.no", "https://x");
        assertEq(again.length, 0, "wd-5m: fill-only — a second write on a filled row is a no-op");
      }

      // ── wd-6: write-time identity guards in applyGardssalgProviderWebsite. ─
      // wd-6a/d-f extended for the per-field owner-lock narrowing (dev-
      // request 2026-08-03-gardssalg-owner-lock-rollback, pilot widened to
      // this write lever): a content_source='claim' row now stays locked
      // for hjemmeside IFF the owner specifically touched hjemmeside via the
      // claim portal (field_provenance.owner_locks.hjemmeside), rather than
      // the old row-level "any claim row is fully frozen" assumption.
      {
        const wLocked = expStore.applyGardssalgProviderWebsite("wd-locked", "https://kravsattgard.no", "https://x");
        assertEq(wLocked.length, 0, "wd-6a: claim row WITH owner_locks.hjemmeside → nothing written (field-locked)");
        const wTaken = expStore.applyGardssalgProviderWebsite("wd-taken", "https://solbakkengard.no", "https://x");
        assertEq(wTaken.length, 0, "wd-6b: host already carried by another provider → write refused (shared-host guard)");
        const wBad = expStore.applyGardssalgProviderWebsite("wd-agg", "ikke-en-url", "https://x");
        assertEq(wBad.length, 0, "wd-6c: non-URL rejected by sanity gate");

        // wd-6g/h (2026-08-13 fix, dev-request 2026-08-07-kontaktjakt-
        // drikkeprodusenter): a scheme-less but genuinely domain-shaped
        // candidate (Brreg-style, e.g. "hardangersider.no") on a BLANK row
        // must now be accepted on the fill path — it used to be silently
        // refused (write_skipped_by_guards) purely for lacking "https://",
        // even though this same column already stores scheme-less values
        // elsewhere. "ikke-en-url" above (no dot) must still be refused —
        // the sanity gate is relaxed on scheme, not removed.
        const wSchemeless = expStore.applyGardssalgProviderWebsite("wd-schemeless", "hardangersider.no", "https://evidence-schemeless.example");
        assertEq(JSON.stringify(wSchemeless), JSON.stringify(["hjemmeside"]), "wd-6g: scheme-less domain-shaped candidate on a blank row now succeeds");
        const rowSchemeless = expDb.prepare(`SELECT hjemmeside, field_provenance FROM experience_providers WHERE id='wd-schemeless'`).get() as any;
        assertEq(rowSchemeless.hjemmeside, "hardangersider.no", "wd-6h: stored verbatim, scheme NOT added");
        assertTrue(!!JSON.parse(rowSchemeless.field_provenance || "{}").hjemmeside, "wd-6i: field_provenance.hjemmeside stamped for the scheme-less fill write");

        // wd-6d/e: positive unlock case — the owner touched about_text, NOT
        // hjemmeside, via the claim portal, so hjemmeside is fair game.
        const wUnlocked = expStore.applyGardssalgProviderWebsite("wd-claim-unlocked", "https://ny-eier-gard.no", "https://x");
        assertEq(JSON.stringify(wUnlocked), JSON.stringify(["hjemmeside"]), "wd-6d: claim row with owner_locks on a DIFFERENT field → write succeeds");
        const rowUnlocked = expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id = 'wd-claim-unlocked'`).get() as { hjemmeside: string | null };
        assertEq(rowUnlocked.hjemmeside, "https://ny-eier-gard.no", "wd-6e: hjemmeside actually persisted to the DB for the field-unlocked claim row");

        // wd-6f: negative control — content_source='manual' rows stay
        // blocked unconditionally and never consult owner_locks.
        const wManual = expStore.applyGardssalgProviderWebsite("wd-manual", "https://manuellgard.no", "https://x");
        assertEq(wManual.length, 0, "wd-6f: manual row → nothing written, regardless of owner_locks");
      }

      // ── wd-11: "godkjenn-på-plass" — a candidate byte-identical to the
      //    row's OWN current hjemmeside is not a fill-only violation, it's a
      //    no-op re-approval: provenance gets (re)stamped and the write
      //    succeeds instead of forever tripping the fill-only guard (which
      //    used to strand these forever in the review queue). ─────────────
      {
        insertProvider.run({ id: "wd-atplace", navn: "Plassert Gard", org_nr: "911222333", kommune: "Voss", poststed: null, hjemmeside: "https://atplace-gard.no", catalog_hidden: null, content_source: null, producer_type: "sideri" });
        insertProvider.run({ id: "wd-atplace-route", navn: "Plassert Rute Gard", org_nr: "911222444", kommune: "Voss", poststed: null, hjemmeside: "https://atplace-route-gard.no", catalog_hidden: null, content_source: null, producer_type: "sideri" });
        insertProvider.run({
          id: "wd-manual-atplace", navn: "Manuell Plassert Gard", org_nr: "911222555", kommune: "Voss", poststed: null,
          hjemmeside: "https://manuell-egen.no", catalog_hidden: null, content_source: "manual", producer_type: "sideri",
        });
        insertProvider.run({
          id: "wd-locked-atplace", navn: "Kravsatt Plassert Gard", org_nr: "911222666", kommune: "Voss", poststed: null,
          hjemmeside: "https://kravsatt-egen.no", catalog_hidden: null, content_source: "claim", producer_type: "sideri",
          field_provenance: JSON.stringify({ owner_locks: { hjemmeside: { locked_at: "2026-08-01T12:00:00.000Z" } } }),
        });
        // wd-11m-r fixtures — normalized at-place (AC9 follow-up, dev-request
        // 2026-08-07-kontaktjakt-drikkeprodusenter): scheme/trailing-slash-
        // only textual differences from the queue vs. production
        // 2026-08-07T15:1x Z apply run (8/19 candidates rejected purely on
        // this superficial formatting, e.g. www.auroraspirit.com vs.
        // https://www.auroraspirit.com).
        insertProvider.run({ id: "wd-atplace-norm-scheme", navn: "Aurora Spirit Norm", org_nr: "911222777", kommune: "Voss", poststed: null, hjemmeside: "https://www.auroraspirit.com", catalog_hidden: null, content_source: null, producer_type: "sideri" });
        insertProvider.run({ id: "wd-atplace-norm-slash", navn: "Foo Trailing Test", org_nr: "911222888", kommune: "Voss", poststed: null, hjemmeside: "https://foo-trailing-test.no", catalog_hidden: null, content_source: null, producer_type: "sideri" });
        insertProvider.run({ id: "wd-atplace-norm-both", navn: "Foo Both Test", org_nr: "911222999", kommune: "Voss", poststed: null, hjemmeside: "https://foo-both-test.no/", catalog_hidden: null, content_source: null, producer_type: "sideri" });
        insertProvider.run({ id: "wd-atplace-norm-neg", navn: "Foo Neg Test", org_nr: "911223000", kommune: "Voss", poststed: null, hjemmeside: "https://foo-neg-test.no", catalog_hidden: null, content_source: null, producer_type: "sideri" });
        insertProvider.run({ id: "wd-atplace-norm-route", navn: "Aurora Spirit Norm Route", org_nr: "911223111", kommune: "Voss", poststed: null, hjemmeside: "https://www.auroraspirit-route.com", catalog_hidden: null, content_source: null, producer_type: "sideri" });

        // (a) exact-match candidate: succeeds, value UNCHANGED, provenance
        //     stamped, exactly one new audit row.
        const auditBefore = (expDb.prepare(`SELECT COUNT(*) c FROM gardssalg_content_audit WHERE provider_id='wd-atplace' AND field_name='hjemmeside'`).get() as any).c;
        assertEq(auditBefore, 0, "wd-11a0: no pre-existing audit row for wd-atplace/hjemmeside");
        const wAtPlace = expStore.applyGardssalgProviderWebsite("wd-atplace", "https://atplace-gard.no", "https://evidence-atplace.example");
        assertEq(JSON.stringify(wAtPlace), JSON.stringify(["hjemmeside"]), 'wd-11a: at-place candidate returns ["hjemmeside"] (not [])');
        const rowAtPlace = expDb.prepare(`SELECT hjemmeside, field_provenance FROM experience_providers WHERE id='wd-atplace'`).get() as any;
        assertEq(rowAtPlace.hjemmeside, "https://atplace-gard.no", "wd-11b: hjemmeside column UNCHANGED by the at-place write");
        assertEq(
          JSON.parse(rowAtPlace.field_provenance || "{}").hjemmeside?.source_url,
          "https://evidence-atplace.example",
          "wd-11c: field_provenance.hjemmeside stamped with the new evidence url",
        );
        const auditAfter = (expDb.prepare(`SELECT COUNT(*) c FROM gardssalg_content_audit WHERE provider_id='wd-atplace' AND field_name='hjemmeside'`).get() as any).c;
        assertEq(auditAfter, 1, "wd-11d: exactly one new gardssalg_content_audit row written");

        // (b) same scenario driven through the approve ROUTE with apply:true
        //     — must land as a real write, not write_skipped_by_guards, and
        //     must clear the queue entry.
        expStore.upsertGardssalgWebsiteReviewQueue({
          provider_id: "wd-atplace-route",
          provider_name: "Plassert Rute Gard",
          candidate_url: "https://atplace-route-gard.no",
          final_url: "https://atplace-route-gard.no",
          reason: "website_discovery_candidate",
        });
        const approveRes = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          url: "/admin/gardssalg-website-review-approve",
          body: { approvals: [{ provider_id: "wd-atplace-route", url: "https://atplace-route-gard.no" }], apply: true },
        });
        assertEq(approveRes.body.written_count, 1, "wd-11e: approve route treats the at-place candidate as a real write (not write_skipped_by_guards)");
        const qLeftAtPlace = (expDb.prepare(`SELECT COUNT(*) c FROM gardssalg_website_review_queue WHERE provider_id='wd-atplace-route'`).get() as any).c;
        assertEq(qLeftAtPlace, 0, "wd-11f: queue entry for the at-place candidate is cleared");

        // (c) negative control — a DIFFERENT candidate on a row that already
        //     carries a hjemmeside still hits the unchanged fill-only guard
        //     (proves the non-at-place path is untouched).
        const wDiffers = expStore.applyGardssalgProviderWebsite("wd-atplace", "https://helt-annen-url.no", "https://x");
        assertEq(wDiffers.length, 0, "wd-11g: negative control — non-matching candidate on a filled row still refused (fill-only path unchanged)");
        const rowDiffers = expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id='wd-atplace'`).get() as any;
        assertEq(rowDiffers.hjemmeside, "https://atplace-gard.no", "wd-11h: hjemmeside still unchanged after the refused non-matching write");

        // (d) the manual / owner-lock guards must still fire BEFORE the
        //     at-place check — isAtPlace must never bypass them, and NOTHING
        //     (not even provenance) gets stamped for either, even though the
        //     candidate equals the row's own current hjemmeside.
        const wManualAtPlace = expStore.applyGardssalgProviderWebsite("wd-manual-atplace", "https://manuell-egen.no", "https://x");
        assertEq(wManualAtPlace.length, 0, "wd-11i: manual row → still refused even when candidate equals its own hjemmeside");
        const rowManualAtPlace = expDb.prepare(`SELECT field_provenance FROM experience_providers WHERE id='wd-manual-atplace'`).get() as any;
        assertEq(rowManualAtPlace.field_provenance, null, "wd-11j: manual row's field_provenance was NOT stamped by the at-place path");

        const wLockedAtPlace = expStore.applyGardssalgProviderWebsite("wd-locked-atplace", "https://kravsatt-egen.no", "https://x");
        assertEq(wLockedAtPlace.length, 0, "wd-11k: owner-locked claim row → still refused even when candidate equals its own hjemmeside");
        const rowLockedAtPlace = expDb.prepare(`SELECT field_provenance FROM experience_providers WHERE id='wd-locked-atplace'`).get() as any;
        assertTrue(
          !JSON.parse(rowLockedAtPlace.field_provenance || "{}").hjemmeside,
          "wd-11l: owner-locked row's field_provenance.hjemmeside was NOT stamped by the at-place path",
        );

        // (e/m) normalized at-place — scheme-only difference (candidate has
        //     no http(s):// prefix; stored value does).
        const wNormScheme = expStore.applyGardssalgProviderWebsite(
          "wd-atplace-norm-scheme", "www.auroraspirit.com", "https://evidence-norm-scheme.example",
        );
        assertEq(JSON.stringify(wNormScheme), JSON.stringify(["hjemmeside"]),
          'wd-11m: scheme-only-different candidate is treated as at-place, returns ["hjemmeside"]');
        const rowNormScheme = expDb.prepare(`SELECT hjemmeside, field_provenance FROM experience_providers WHERE id='wd-atplace-norm-scheme'`).get() as any;
        assertEq(rowNormScheme.hjemmeside, "https://www.auroraspirit.com", "wd-11n: hjemmeside column UNCHANGED (still carries the scheme)");
        assertEq(
          JSON.parse(rowNormScheme.field_provenance || "{}").hjemmeside?.source_url,
          "https://evidence-norm-scheme.example",
          "wd-11o: field_provenance.hjemmeside stamped with the new evidence url",
        );
        const auditNormScheme = expDb.prepare(
          `SELECT old_value, new_value FROM gardssalg_content_audit WHERE provider_id='wd-atplace-norm-scheme' AND field_name='hjemmeside'`
        ).all() as any[];
        assertEq(auditNormScheme.length, 1, "wd-11p: exactly one new audit row for the scheme-normalized at-place write");
        assertEq(auditNormScheme[0]?.old_value, "https://www.auroraspirit.com", "wd-11q: audit old_value is the ORIGINAL stored value");
        assertEq(auditNormScheme[0]?.new_value, "https://www.auroraspirit.com",
          "wd-11r: audit new_value is the ORIGINAL stored value too (not the scheme-less candidate) — the write never actually changed the column");

        // (f/n) normalized at-place — trailing-slash-only difference
        //     (candidate carries a trailing slash the stored value lacks).
        const wNormSlash = expStore.applyGardssalgProviderWebsite(
          "wd-atplace-norm-slash", "https://foo-trailing-test.no/", "https://evidence-norm-slash.example",
        );
        assertEq(JSON.stringify(wNormSlash), JSON.stringify(["hjemmeside"]),
          'wd-11s: trailing-slash-only-different candidate is treated as at-place, returns ["hjemmeside"]');
        const rowNormSlash = expDb.prepare(`SELECT hjemmeside, field_provenance FROM experience_providers WHERE id='wd-atplace-norm-slash'`).get() as any;
        assertEq(rowNormSlash.hjemmeside, "https://foo-trailing-test.no", "wd-11t: hjemmeside column UNCHANGED (no trailing slash)");
        assertEq(
          JSON.parse(rowNormSlash.field_provenance || "{}").hjemmeside?.source_url,
          "https://evidence-norm-slash.example",
          "wd-11u: field_provenance.hjemmeside stamped with the new evidence url",
        );
        const auditNormSlash = expDb.prepare(
          `SELECT old_value, new_value FROM gardssalg_content_audit WHERE provider_id='wd-atplace-norm-slash' AND field_name='hjemmeside'`
        ).all() as any[];
        assertEq(auditNormSlash.length, 1, "wd-11v: exactly one new audit row for the slash-normalized at-place write");
        assertEq(auditNormSlash[0]?.new_value, "https://foo-trailing-test.no",
          "wd-11w: audit new_value is the ORIGINAL stored value (no trailing slash), not the slashed candidate");

        // (g/o) normalized at-place — BOTH scheme and trailing slash
        //     stripped from the candidate.
        const wNormBoth = expStore.applyGardssalgProviderWebsite(
          "wd-atplace-norm-both", "foo-both-test.no", "https://evidence-norm-both.example",
        );
        assertEq(JSON.stringify(wNormBoth), JSON.stringify(["hjemmeside"]),
          'wd-11x: scheme-AND-trailing-slash-different candidate is treated as at-place, returns ["hjemmeside"]');
        const rowNormBoth = expDb.prepare(`SELECT hjemmeside, field_provenance FROM experience_providers WHERE id='wd-atplace-norm-both'`).get() as any;
        assertEq(rowNormBoth.hjemmeside, "https://foo-both-test.no/", "wd-11y: hjemmeside column UNCHANGED (still carries scheme + trailing slash)");
        assertEq(
          JSON.parse(rowNormBoth.field_provenance || "{}").hjemmeside?.source_url,
          "https://evidence-norm-both.example",
          "wd-11z: field_provenance.hjemmeside stamped with the new evidence url",
        );
        const auditNormBoth = expDb.prepare(
          `SELECT old_value, new_value FROM gardssalg_content_audit WHERE provider_id='wd-atplace-norm-both' AND field_name='hjemmeside'`
        ).all() as any[];
        assertEq(auditNormBoth.length, 1, "wd-11aa: exactly one new audit row for the both-normalized at-place write");
        assertEq(auditNormBoth[0]?.new_value, "https://foo-both-test.no/",
          "wd-11ab: audit new_value is the ORIGINAL stored value (scheme + trailing slash), not the bare candidate");

        // (h/p) negative control — a www. prefix difference is NOT scheme
        //     or trailing-slash, so it must NOT be treated as at-place: the
        //     normalization is narrowly scoped and this is a real host
        //     difference, refused exactly like today (fill-only guard fires
        //     because the row already carries a hjemmeside).
        const wNormNeg = expStore.applyGardssalgProviderWebsite(
          "wd-atplace-norm-neg", "https://www.foo-neg-test.no", "https://evidence-norm-neg.example",
        );
        assertEq(wNormNeg.length, 0, "wd-11ac: www.-prefix-only difference is NOT at-place — refused (narrow normalization scope)");
        const rowNormNeg = expDb.prepare(`SELECT hjemmeside, field_provenance FROM experience_providers WHERE id='wd-atplace-norm-neg'`).get() as any;
        assertEq(rowNormNeg.hjemmeside, "https://foo-neg-test.no", "wd-11ad: hjemmeside unchanged after the refused www.-prefix write");
        assertEq(rowNormNeg.field_provenance, null, "wd-11ae: field_provenance NOT stamped for the refused www.-prefix write");

        // (i/q) same normalized-match scenario driven through the approve
        //     ROUTE with apply:true — written_count reflects the real write
        //     (not write_skipped_by_guards), and the queue entry is cleared.
        expStore.upsertGardssalgWebsiteReviewQueue({
          provider_id: "wd-atplace-norm-route",
          provider_name: "Aurora Spirit Norm Route",
          candidate_url: "www.auroraspirit-route.com",
          final_url: "www.auroraspirit-route.com",
          reason: "website_discovery_candidate",
        });
        const approveResNorm = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          url: "/admin/gardssalg-website-review-approve",
          body: { approvals: [{ provider_id: "wd-atplace-norm-route", url: "www.auroraspirit-route.com" }], apply: true },
        });
        assertEq(approveResNorm.body.written_count, 1,
          "wd-11af: approve route treats the normalized (scheme-stripped) at-place candidate as a real write (not write_skipped_by_guards)");
        const qLeftNorm = (expDb.prepare(`SELECT COUNT(*) c FROM gardssalg_website_review_queue WHERE provider_id='wd-atplace-norm-route'`).get() as any).c;
        assertEq(qLeftNorm, 0, "wd-11ag: queue entry for the normalized at-place candidate is cleared");
        const rowNormRoute = expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id='wd-atplace-norm-route'`).get() as any;
        assertEq(rowNormRoute.hjemmeside, "https://www.auroraspirit-route.com", "wd-11ah: hjemmeside column UNCHANGED by the route-driven normalized at-place write");
      }

      // ── wd-7: shared-host counter counts hidden rows, excludes test provider. ─
      {
        const counts = expStore.gardssalgSharedHostCounts();
        assertEq(counts.get("fjelldalbrenneri.no"), 1, "wd-7a: HIDDEN row's adopted host is counted (contamination guard sees the hidden batch)");
        assertEq(counts.get("solbakkengard.no"), 1, "wd-7b: visible row still counted");
        assertTrue(!counts.has("testgardssalg.example.no"), "wd-7c: test provider excluded by producer_type marker, not by hidden-ness");
      }

      // ── wd-8: hjemmeside is rollbackable via the standard lever. ────────
      {
        const plan = expStore.planGardssalgContentRollback({ provider_id: "wd-hidden", field_name: "hjemmeside" });
        assertEq(plan.skipped.length, 0, "wd-8a: hjemmeside is not skipped as unknown_field");
        assertEq(plan.restorable.length, 1, "wd-8b: the adopted hjemmeside is restorable");
        assertEq(plan.restorable[0]?.restore_to, null, "wd-8c: plan restores to the original blank value");
      }

      // ── wd-10: tier-2 SEARCH-based candidates (dev-request 2026-07-21-
      //    gardssalg-soekebasert-nettsidefunn) — route-level integration.
      //    Fixtures/mocks placed at the very END on purpose: earlier sections
      //    (esp. wd-4's auto-select ordering assertion) snapshot the DB, and
      //    these new rows must not shift that snapshot. Tier 1 (name-guess)
      //    is guaranteed to fail for all four rows below because none of
      //    their guessed hosts are given a 200 response by either fetch mock
      //    (the outer one, still in effect until we swap it below, or the
      //    inner one) — every guessed host falls through to the default 404
      //    — so every row reaches tier 2, exactly as intended. ────────────
      {
        insertProvider.run({ id: "wd-search-orgnr", navn: "Kveldsro Sideri", org_nr: "999111222", kommune: "Ulvik", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "sideri" });
        insertProvider.run({ id: "wd-search-dir", navn: "Blaabaerlia Gard", org_nr: "999222333", kommune: "Nesna", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "gardsbutikk" });
        insertProvider.run({ id: "wd-search-social", navn: "Fjordtun Gardsutsalg", org_nr: "999333444", kommune: "Stryn", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "gardsbutikk" });
        insertProvider.run({ id: "wd-search-none", navn: "Ukjent Soekefjell", org_nr: "999444555", kommune: "Aardal", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "gardsbutikk" });

        const searchScenarios: Record<string, Array<{ title: string; url: string; description: string }>> = {
          "Kveldsro Sideri": [{ title: "Kveldsro Sideri", url: "https://kveldsrosideri-ekte.no", description: "Kveldsro Sideri i Ulvik" }],
          "Blaabaerlia Gard": [{ title: "Blåbærlia Gård — Hanen", url: "https://hanen.no/blabarlia", description: "medlem" }],
          "Fjordtun Gardsutsalg": [{ title: "Fjordtun Gardsutsalg", url: "https://www.facebook.com/fjordtungard", description: "Følg oss på Facebook" }],
          "Ukjent Soekefjell": [],
        };
        const searchCalls: string[] = [];
        // Injectable-search test seam (mirrors experience-brreg.ts's
        // __setBrregFetchForTesting) — NO real network, hands back
        // BraveResult[] directly like search-enrich-sweep's injected
        // EnrichDeps.search, per the dev-request's test-idiom requirement.
        expStore.__setGardssalgWebsiteSearchForTesting(async (query: string) => {
          searchCalls.push(query);
          const m = query.match(/^"([^"]+)"/);
          const name = m ? m[1]! : query;
          return searchScenarios[name] ?? [];
        });

        const searchFetchCalls: string[] = [];
        const prevFetch2 = globalThis.fetch;
        globalThis.fetch = (async (url: string | URL | Request) => {
          const urlStr = String(url);
          searchFetchCalls.push(urlStr);
          if (urlStr.startsWith("https://kveldsrosideri-ekte.no")) {
            return { ok: true, status: 200, url: urlStr, text: async () => "<html><body>Kveldsro Sideri — org.nr 999 111 222 — Ulvik</body></html>" } as unknown as Response;
          }
          return { ok: false, status: 404, url: urlStr, text: async () => "" } as unknown as Response;
        }) as unknown as typeof fetch;

        try {
          const r = await callRoute(opplevelserRouter, {
            headers: adminHeaders,
            body: { providerIds: ["wd-search-orgnr", "wd-search-dir", "wd-search-social", "wd-search-none"], apply: true },
          });

          assertEq(searchCalls.length, 4, "wd-10a: exactly one braveSearch call per row — cost control (max 1 search API call per row per run)");

          // (a) a search hit that verifies via org-nr evidence gets queued.
          const orgnrProp = (r.body.proposed as any[]).find((p) => p.provider_id === "wd-search-orgnr");
          assertTrue(!!orgnrProp, "wd-10b: search-sourced candidate verified via org_nr is proposed");
          assertEq(orgnrProp?.candidate_url, "https://kveldsrosideri-ekte.no", "wd-10c: proposed candidate is the search-discovered host");
          assertEq(orgnrProp?.evidence?.org_nr_found, true, "wd-10d: verified via org_nr, identical evidence contract as tier 1");
          const qRow = expDb.prepare(`SELECT candidate_url FROM gardssalg_website_review_queue WHERE provider_id='wd-search-orgnr'`).get() as any;
          assertEq(qRow?.candidate_url, "https://kveldsrosideri-ekte.no", "wd-10e: search-sourced candidate lands in the SAME review queue — no new write path");
          const hjOrgnr = (expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id='wd-search-orgnr'`).get() as any).hjemmeside;
          assertEq(hjOrgnr, null, "wd-10f: discovery still never writes hjemmeside directly, even via search");

          // (b) a directory/aggregator host appearing in search results is
          //     excluded pre-fetch (reusing the SAME curated exclusion).
          const dirEx = (r.body.excluded as any[]).find((e) => e.provider_id === "wd-search-dir");
          assertTrue(!!dirEx && dirEx.hosts.some((h: any) => h.host === "hanen.no" && h.reason === "blocklisted_directory_domain"),
            "wd-10g: directory host surfaced by search excluded pre-fetch with the SAME curated reason as tier 1");
          assertTrue(!searchFetchCalls.some((u) => u.includes("hanen.no")), "wd-10h: no fetch ever went to the search-sourced directory host");
          assertTrue((r.body.no_candidate_verified as any[]).some((e) => e.provider_id === "wd-search-dir"), "wd-10i: falls through to no_candidate_verified");

          // (c) a social-media host appearing in search results is excluded
          //     as a homepage candidate specifically (never auto-proposed).
          const socEx = (r.body.excluded as any[]).find((e) => e.provider_id === "wd-search-social");
          assertTrue(!!socEx && socEx.hosts.some((h: any) => h.host === "facebook.com" && h.reason === "social_media_host"),
            "wd-10j: Facebook host surfaced by search excluded with its OWN social_media_host reason (a found-but-not-homepage signal, not a generic directory hit)");
          assertTrue(!searchFetchCalls.some((u) => u.includes("facebook.com")), "wd-10k: no fetch ever went to the social-media host");
          assertTrue((r.body.no_candidate_verified as any[]).some((e) => e.provider_id === "wd-search-social"), "wd-10l: a social profile is never proposed as the homepage");

          // (d) zero search hits → no candidate verified, no write.
          assertTrue((r.body.no_candidate_verified as any[]).some((e) => e.provider_id === "wd-search-none"), "wd-10m: zero search hits → no_candidate_verified");
          assertTrue(!(r.body.proposed as any[]).some((p) => p.provider_id === "wd-search-none"), "wd-10n: nothing proposed for the zero-hit row");
          const noneQ = (expDb.prepare(`SELECT COUNT(*) c FROM gardssalg_website_review_queue WHERE provider_id='wd-search-none'`).get() as any).c;
          assertEq(noneQ, 0, "wd-10o: zero search hits → no queue write");

          assertEq(r.body.search_calls, 4, "wd-10p: response reports the search-call count for cost-control observability");
        } finally {
          globalThis.fetch = prevFetch2;
          expStore.__setGardssalgWebsiteSearchForTesting(null);
        }
      }

      // ═══ Section v2 (Daniels retning 2026-07-30): flere kandidater +
      //     fler-signal-bevis + kontaktside-crawl ═══════════════════════════

      // ── wd-11: normaliseNorwegianPhone ──────────────────────────────────
      {
        assertEq(expStore.normaliseNorwegianPhone("+47 912 34 567"), "91234567", "wd-11a: +47 with spaces normalises to 8 digits");
        assertEq(expStore.normaliseNorwegianPhone("0047 91 23 45 67"), "91234567", "wd-11b: 0047 prefix stripped");
        assertEq(expStore.normaliseNorwegianPhone("91234567"), "91234567", "wd-11c: bare 8-digit passes through");
        assertEq(expStore.normaliseNorwegianPhone("9123456"), null, "wd-11d: 7 digits is not a phone — partials must never match");
        assertEq(expStore.normaliseNorwegianPhone(null), null, "wd-11e: null in, null out");
      }

      // ── wd-12: evidence v2 — signals from data we HOLD, not just navn ──
      {
        const base = { orgNr: null, navn: "Fjelldal Brenneri", kommune: "Saltdal", poststed: null };
        // v1 subset preserved: name+place still verifies.
        const v1 = expStore.gardssalgWebsiteEvidenceMatch("Fjelldal Brenneri ligger i Saltdal", base);
        assertEq(v1.verified, true, "wd-12a: the v1 rule (name+place) still verifies — widening, never tightening");
        // phone + name verifies WITHOUT place.
        const ph = expStore.gardssalgWebsiteEvidenceMatch(
          "Velkommen til Fjelldal Brenneri. Ring oss: +47 912 34 567",
          { ...base, kommune: null, telefon: "912 34 567" });
        assertEq(ph.phone_found, true, "wd-12b: the provider's registered number found despite +47/space formatting");
        assertEq(ph.verified, true, "wd-12c: phone+name verifies without place");
        // phone ALONE does not verify.
        const phAlone = expStore.gardssalgWebsiteEvidenceMatch(
          "Ringeliste: 912 34 567", { orgNr: null, navn: "Fjelldal Brenneri", kommune: null, poststed: null, telefon: "91234567" });
        assertEq(phAlone.phone_found, true, "wd-12d: number found…");
        assertEq(phAlone.verified, false, "wd-12e: …but phone ALONE never verifies (call-list pages)");
        // a DIFFERENT number must not fire.
        const phWrong = expStore.gardssalgWebsiteEvidenceMatch(
          "Fjelldal Brenneri i Saltdal, tlf 999 99 999", { ...base, kommune: null, telefon: "91234567" });
        assertEq(phWrong.phone_found, false, "wd-12f: a different number on the page is NOT the provider's phone");
        // name + registered street address verifies.
        const ad = expStore.gardssalgWebsiteEvidenceMatch(
          "Fjelldal Brenneri, Bryggeveien 12, Norge", { ...base, kommune: null, adresse: "Bryggeveien 12" });
        assertEq(ad.address_found, true, "wd-12g: registered address found at token boundaries");
        assertEq(ad.verified, true, "wd-12h: name+address verifies without kommune");
        // postnummer strengthens name but NEVER suffices with place alone.
        const pn = expStore.gardssalgWebsiteEvidenceMatch(
          "Fjelldal Brenneri, 8250", { ...base, kommune: null, postnummer: "8250" });
        assertEq(pn.verified, true, "wd-12i: name+postnummer verifies");
        const pnAlone = expStore.gardssalgWebsiteEvidenceMatch(
          "Bedrifter i Saltdal 8250", { ...base, navn: "Fjelldal Brenneri", postnummer: "8250" });
        assertEq(pnAlone.verified, false, "wd-12j: place+postnummer WITHOUT the name never verifies — thousands share a postal code");
      }

      // ── wd-13: contact-page link extraction ────────────────────────────
      {
        const html = `<a href="/kontakt">Kontakt oss</a>
          <a href="https://annenside.no/kontakt">Kontakt</a>
          <a href="mailto:x@y.no">Kontakt</a>
          <a href="/om-oss">Om oss</a>
          <a href="/produkter">Produkter</a>
          <a href="/side">Ta kontakt her</a>`;
        const links = expStore.gardssalgContactPageLinks(html, "fjelldalbrenneri.no");
        assertTrue(links.includes("https://fjelldalbrenneri.no/kontakt"), "wd-13a: /kontakt by href");
        assertTrue(links.includes("https://fjelldalbrenneri.no/om-oss"), "wd-13b: /om-oss by href");
        assertTrue(links.includes("https://fjelldalbrenneri.no/side"), "wd-13c: contact-ish ANCHOR TEXT qualifies a neutral path");
        assertTrue(!links.some((l) => l.includes("annenside.no")), "wd-13d: cross-host link never followed — only the exclusion pipeline judges other sites");
        assertTrue(!links.some((l) => l.startsWith("mailto:")), "wd-13e: mailto skipped");
        assertTrue(links.length <= 3, "wd-13f: capped");
      }

      // ── wd-14: .com candidate guesses ──────────────────────────────────
      {
        const h = expStore.gardssalgWebsiteCandidateHosts("7 Fjell Bryggeri");
        assertTrue(h.includes("7fjellbryggeri.com"), "wd-14a: .com variant generated (the real 7 Fjell domain tier 1 used to miss)");
        assertTrue(h.indexOf("7fjellbryggeri.no") < h.indexOf("7fjellbryggeri.com"), "wd-14b: .no still tried before .com");
      }

      // ── wd-15/16/17: route-level — subpage crawl + graded confidence ───
      {
        insertProvider.run({ id: "wd-sub-orgnr", navn: "Kystbrygg Vestland", org_nr: "922000001", kommune: "Askvoll", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "bryggeri" });
        insertProvider.run({ id: "wd-sub-none", navn: "Ukjent Kystfjell", org_nr: "922000002", kommune: "Askvoll", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "bryggeri" });
        insertProvider.run({ id: "wd-sub-phone", navn: "Telefonbrygg Nord", org_nr: "922000003", kommune: "Bodø", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "bryggeri" });
        expDb.prepare(`UPDATE experience_providers SET telefon = '+47 912 34 567' WHERE id = 'wd-sub-phone'`).run();

        const scenarios: Record<string, Array<{ title: string; url: string; description: string }>> = {
          "Kystbrygg Vestland": [{ title: "Kystbrygg", url: "https://kystbrygg-ekte.no", description: "bryggeri" }],
          "Ukjent Kystfjell": [{ title: "?", url: "https://helturelatert.no", description: "?" }],
          "Telefonbrygg Nord": [{ title: "Telefonbrygg", url: "https://telefonbrygg-ekte.no", description: "bryggeri" }],
        };
        expStore.__setGardssalgWebsiteSearchForTesting(async (query: string) => {
          const m = query.match(/^"([^"]+)"/);
          return scenarios[m ? m[1]! : query] ?? [];
        });

        const subFetchCalls: string[] = [];
        const prevFetch3 = globalThis.fetch;
        globalThis.fetch = (async (url: string | URL | Request) => {
          const u = String(url);
          subFetchCalls.push(u);
          // Front page: name only (no place, no org) + a /kontakt link.
          if (u === "https://kystbrygg-ekte.no" || u === "https://kystbrygg-ekte.no/") {
            return { ok: true, status: 200, url: u, text: async () =>
              '<html><body>Kystbrygg Vestland — håndverksøl. <a href="/kontakt">Kontakt oss</a></body></html>' } as unknown as Response;
          }
          // The kontakt subpage carries the org_nr — THE deciding evidence.
          if (u.startsWith("https://kystbrygg-ekte.no/kontakt")) {
            return { ok: true, status: 200, url: u, text: async () =>
              "<html><body>Org.nr 922 000 001 — Askvoll</body></html>" } as unknown as Response;
          }
          // Unrelated page: NO signal at all, but a tempting /kontakt link.
          if (u === "https://helturelatert.no" || u === "https://helturelatert.no/") {
            return { ok: true, status: 200, url: u, text: async () =>
              '<html><body>Helt annet innhold. <a href="/kontakt">Kontakt</a></body></html>' } as unknown as Response;
          }
          // Phone case: front page has name + the provider's registered number.
          if (u === "https://telefonbrygg-ekte.no" || u === "https://telefonbrygg-ekte.no/") {
            return { ok: true, status: 200, url: u, text: async () =>
              "<html><body>Telefonbrygg Nord — ring +47 912 34 567</body></html>" } as unknown as Response;
          }
          return { ok: false, status: 404, url: u, text: async () => "" } as unknown as Response;
        }) as unknown as typeof fetch;

        try {
          const r = await callRoute(opplevelserRouter, {
            headers: adminHeaders,
            body: { providerIds: ["wd-sub-orgnr", "wd-sub-none", "wd-sub-phone"], apply: true },
          });

          const subProp = (r.body.proposed as any[]).find((p) => p.provider_id === "wd-sub-orgnr");
          assertTrue(!!subProp, "wd-15a: front page name-only + org_nr on /kontakt → VERIFIED via subpage crawl (v1 rejected this row)");
          assertEq(subProp?.evidence?.org_nr_found, true, "wd-15b: the deciding signal is the org_nr from the subpage");
          assertTrue(String(subProp?.final_url || "").includes("/kontakt"), "wd-15c: final_url records WHERE the evidence actually was");
          assertEq(subProp?.confidence, 1.0, "wd-15d: org.nr evidence keeps registry-grade confidence");

          assertTrue(!subFetchCalls.some((u) => u.startsWith("https://helturelatert.no/kontakt")),
            "wd-16a: a front page with ZERO signals never gets its subpages crawled — no signal, no budget");
          assertTrue((r.body.no_candidate_verified as any[]).some((e) => e.provider_id === "wd-sub-none"),
            "wd-16b: …and the row falls through honestly");

          const phProp = (r.body.proposed as any[]).find((p) => p.provider_id === "wd-sub-phone");
          assertTrue(!!phProp, "wd-17a: name + the provider's own registered phone verifies on the front page");
          assertEq(phProp?.evidence?.phone_found, true, "wd-17b: phone signal recorded in evidence");
          assertEq(phProp?.confidence, 0.95, "wd-17c: phone-verified confidence is 0.95 — between org.nr and name+place");
        } finally {
          globalThis.fetch = prevFetch3;
          expStore.__setGardssalgWebsiteSearchForTesting(null);
        }
      }

      // ── wd-18/19/20: title corroboration on the discovery flow itself
      //    (dev-request/reviewer follow-up 2026-08-06) — this is the
      //    LITERAL originating incident: sibling-TLD/search-tier candidate
      //    guessing (tryGardssalgCandidateHosts, backing THIS route) is
      //    where 7 of 9 guessed-TLD candidates were wrong — squatted
      //    domains and unrelated orgs that all passed on name+place body
      //    text alone. gardssalgWebsiteEvidenceMatch's title gate was
      //    already proven at the other 3 call sites; wd-18/19/20 prove it
      //    now also applies at the two real call sites INSIDE
      //    tryGardssalgCandidateHosts — the front-page match (~line 2946)
      //    and the subpage-crawl match (~line 2965). ──────────────────────
      {
        // wd-18: pure regression check — same page, same evidence, only
        // whether a title source is offered differs. This is exactly the
        // shape of the incident: a squatted/unrelated <title> sitting on
        // top of a body that happens to contain the producer's name+place.
        const incidentBody = "Kaldvik Gardsutsalg i vakre Alta.";
        const squattedTitle = "Kjøp dette domenet — DomainBrokers Inc";
        const incidentTarget = { orgNr: null, navn: "Kaldvik Gardsutsalg", kommune: "Alta", poststed: null };
        const withoutTitleSource = expStore.gardssalgWebsiteEvidenceMatch(incidentBody, incidentTarget);
        assertEq(withoutTitleSource.verified, true, "wd-18a: name+place alone verifies when no title source is offered (the pre-fix / not-yet-wired shape)");
        const withSquattedTitle = expStore.gardssalgWebsiteEvidenceMatch(incidentBody, incidentTarget, squattedTitle);
        assertEq(withSquattedTitle.title_found, false, "wd-18b: the squatted-domain title does not contain the producer's name");
        assertEq(withSquattedTitle.verified, false, "wd-18c: the SAME page is now rejected once a title source is supplied — the incident shape, fixed");

        // wd-19: route-level, FRONT-PAGE call site (~line 2946) —
        // tryGardssalgCandidateHosts's tier-1 name-guess lands directly on
        // a squatted sibling-TLD host whose body text hits name+place but
        // whose <title> is the squatter's, not the producer's.
        insertProvider.run({ id: "wd-title-front", navn: "Kaldvik Gardsutsalg", org_nr: "922000004", kommune: "Alta", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "gardsbutikk" });

        const titleFetchCalls: string[] = [];
        const prevFetch4 = globalThis.fetch;
        globalThis.fetch = (async (url: string | URL | Request) => {
          const u = String(url);
          titleFetchCalls.push(u);
          // Guessed front-page host for "Kaldvik Gardsutsalg": name+place
          // in the body, but a squatted-domain <title> — no contact links,
          // so there is nothing to crawl further.
          if (u === "https://kaldvikgardsutsalg.no" || u === "https://kaldvikgardsutsalg.no/") {
            return { ok: true, status: 200, url: u, text: async () =>
              "<html><head><title>Kjøp dette domenet — DomainBrokers Inc</title></head>" +
              "<body>Kaldvik Gardsutsalg i vakre Alta.</body></html>" } as unknown as Response;
          }
          return { ok: false, status: 404, url: u, text: async () => "" } as unknown as Response;
        }) as unknown as typeof fetch;

        try {
          const r = await callRoute(opplevelserRouter, {
            headers: adminHeaders,
            body: { providerIds: ["wd-title-front"], apply: true },
          });
          assertTrue(!(r.body.proposed as any[]).some((p) => p.provider_id === "wd-title-front"),
            "wd-19a: squatted-title sibling-TLD candidate is NOT proposed at the front-page call site (previously it would have been — name+place alone used to verify)");
          assertTrue((r.body.no_candidate_verified as any[]).some((e) => e.provider_id === "wd-title-front"),
            "wd-19b: falls through honestly to no_candidate_verified");
          const qCnt = (expDb.prepare(`SELECT COUNT(*) c FROM gardssalg_website_review_queue WHERE provider_id='wd-title-front'`).get() as any).c;
          assertEq(qCnt, 0, "wd-19c: nothing queued for the rejected candidate");
        } finally {
          globalThis.fetch = prevFetch4;
        }

        // wd-20: route-level, SUBPAGE-CRAWL call site (~line 2965) — the
        // front page shows only a partial signal (name, no place), so the
        // contact-page crawl fires; the /kontakt subpage is where the
        // name+place hit actually lands, but its <title> is still the
        // squatter's — must be rejected there too, not just on the front
        // page.
        insertProvider.run({ id: "wd-title-sub", navn: "Mork Gardsutsalg", org_nr: "922000005", kommune: "Alta", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "gardsbutikk" });

        const subTitleFetchCalls: string[] = [];
        const prevFetch5 = globalThis.fetch;
        globalThis.fetch = (async (url: string | URL | Request) => {
          const u = String(url);
          subTitleFetchCalls.push(u);
          if (u === "https://morkgardsutsalg.no" || u === "https://morkgardsutsalg.no/") {
            return { ok: true, status: 200, url: u, text: async () =>
              '<html><body>Mork Gardsutsalg — besøksgard. <a href="/kontakt">Kontakt oss</a></body></html>' } as unknown as Response;
          }
          if (u.startsWith("https://morkgardsutsalg.no/kontakt")) {
            return { ok: true, status: 200, url: u, text: async () =>
              "<html><head><title>Dette domenet er til salgs</title></head>" +
              "<body>Mork Gardsutsalg ligger i Alta.</body></html>" } as unknown as Response;
          }
          return { ok: false, status: 404, url: u, text: async () => "" } as unknown as Response;
        }) as unknown as typeof fetch;

        try {
          const r = await callRoute(opplevelserRouter, {
            headers: adminHeaders,
            body: { providerIds: ["wd-title-sub"], apply: true },
          });
          assertTrue(subTitleFetchCalls.some((u) => u.startsWith("https://morkgardsutsalg.no/kontakt")),
            "wd-20a: the name-only front-page signal DID trigger the subpage crawl (sanity — the flow reached the second call site)");
          assertTrue(!(r.body.proposed as any[]).some((p) => p.provider_id === "wd-title-sub"),
            "wd-20b: the subpage's name+place hit is NOT proposed once its squatted title fails the gate (previously it would have verified via v1 name+place)");
          assertTrue((r.body.no_candidate_verified as any[]).some((e) => e.provider_id === "wd-title-sub"),
            "wd-20c: falls through honestly to no_candidate_verified");
          const qCnt = (expDb.prepare(`SELECT COUNT(*) c FROM gardssalg_website_review_queue WHERE provider_id='wd-title-sub'`).get() as any).c;
          assertEq(qCnt, 0, "wd-20d: nothing queued for the rejected subpage candidate");
        } finally {
          globalThis.fetch = prevFetch5;
        }
      }

      // ── wd-21 (Skive D, dev-request 2026-08-17-cs-plattformparitet-og-
      //    verifisert-utfoerelse): a target whose org_nr was explicitly
      //    blocklisted (producer removed via "fjern oss") gets NO discovery
      //    effort at all — no fetch, no proposal, no queue entry — and the
      //    rejection is counted/reported instead of silently falling into
      //    no_candidate_verified. ───────────────────────────────────────────
      {
        insertProvider.run({ id: "wd-blocked", navn: "Blokkert Sideri", org_nr: "999000001", kommune: "Voss", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "sideri" });
        blocklistSvc.addManualEntry({ identifierType: "org_nr", identifierValue: "999000001" });

        const wd21FetchCalls: string[] = [];
        const prevFetch6 = globalThis.fetch;
        globalThis.fetch = (async (url: string | URL | Request) => {
          wd21FetchCalls.push(String(url));
          return { ok: false, status: 404, url: String(url), text: async () => "" } as unknown as Response;
        }) as unknown as typeof fetch;

        try {
          const r = await callRoute(opplevelserRouter, {
            headers: adminHeaders,
            body: { providerIds: ["wd-blocked"], apply: true },
          });
          assertEq(wd21FetchCalls.length, 0, "wd-21a: a blocklisted target triggers ZERO candidate fetches — no discovery effort spent on it");
          assertEq(r.body.rejected_blocklisted_count, 1, "wd-21b: top-level rejected_blocklisted_count reflects it");
          const rej = (r.body.rejected_blocklisted as any[]).find((x) => x.provider_id === "wd-blocked");
          assertTrue(!!rej, "wd-21c: it is reported, not silently dropped");
          assertEq(rej?.matched_by, "org_nr", "wd-21d: matched_by=org_nr");
          assertEq(rej?.matched_value, "999000001", "wd-21e: matched_value is the blocklisted org_nr");
          assertTrue(!(r.body.proposed as any[]).some((p: any) => p.provider_id === "wd-blocked"), "wd-21f: never proposed");
          assertTrue(!(r.body.no_candidate_verified as any[]).some((e: any) => e.provider_id === "wd-blocked"), "wd-21g: NOT reported as an ordinary no-candidate row either — it has its own distinct outcome");
          const qCnt = (expDb.prepare(`SELECT COUNT(*) c FROM gardssalg_website_review_queue WHERE provider_id='wd-blocked'`).get() as any).c;
          assertEq(qCnt, 0, "wd-21h: nothing queued for the blocklisted target");
        } finally {
          globalThis.fetch = prevFetch6;
        }
      }

      // ── wd-22 (Skive 1, dev-request 2026-08-17-forsyningskjede-samarbeid-
      //    og-kvalitetsoppdatering): selectGardssalgProvidersForWebsiteDiscovery
      //    pulls provider_work_queue items targeted at "discovery" FIRST,
      //    ahead of the normal oldest-first rotation — and still respects the
      //    existing eligibility filters for queue-sourced candidates (a
      //    queued provider that already has a hjemmeside is simply skipped,
      //    its queue row left untouched for a later cycle). ─────────────────
      {
        insertProvider.run({ id: "wd-queue-a", navn: "Køprioritert Gard", org_nr: "999100001", kommune: "Voss", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "sideri" });
        providerWorkQueue.enqueueProviderWorkQueueItem({
          provider_id: "wd-queue-a",
          provider_name: "Køprioritert Gard",
          from_system: "sweep",
          to_system: "discovery",
          reason: "missing_source",
        });
        // wd-owner already has a stored hjemmeside (see fixtures above) — a
        // work-queue item targeting it must never surface it as a discovery
        // target, and must NOT be resolved/touched by the selector itself.
        providerWorkQueue.enqueueProviderWorkQueueItem({
          provider_id: "wd-owner",
          from_system: "berikelse",
          to_system: "discovery",
          reason: "parked_needs_replacement",
        });

        const sel = expStore.selectGardssalgProvidersForWebsiteDiscovery(48);
        const ids = sel.map((s: any) => s.id);
        assertEq(ids[0], "wd-queue-a", "wd-22a: queue-pending eligible provider sorts FIRST, ahead of every never-attempted rotation row");
        assertTrue(!ids.includes("wd-owner"), "wd-22b: a queued provider that no longer meets the eligibility filters (has hjemmeside) is not returned");
        const stillPending = providerWorkQueue.listPendingProviderWorkQueue("discovery").map((p) => p.provider_id);
        assertTrue(stillPending.includes("wd-owner"), "wd-22c: the ineligible queue row is left alone (not resolved) for a later cycle to re-evaluate");
      }

      // ── wd-22d (Skive 1 fix-up, CHANGES-REQUESTED finding): a provider can
      //    legitimately have TWO unresolved provider_work_queue rows both
      //    targeting "discovery" — the idempotency key is provider_id +
      //    to_system + reason, so a later sweep run can add a second reason
      //    (e.g. evidence_url_rejected) for a provider still pending from an
      //    earlier one (missing_source) before either resolves. The selector
      //    must dedupe by provider_id and return that provider exactly ONCE,
      //    not once per queue row. ──────────────────────────────────────────
      {
        insertProvider.run({ id: "wd-queue-dup", navn: "Dobbelkoet Gard", org_nr: "999100003", kommune: "Voss", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "sideri" });
        providerWorkQueue.enqueueProviderWorkQueueItem({
          provider_id: "wd-queue-dup",
          provider_name: "Dobbelkoet Gard",
          from_system: "sweep",
          to_system: "discovery",
          reason: "missing_source",
        });
        providerWorkQueue.enqueueProviderWorkQueueItem({
          provider_id: "wd-queue-dup",
          provider_name: "Dobbelkoet Gard",
          from_system: "berikelse",
          to_system: "discovery",
          reason: "evidence_url_rejected",
        });
        const pendingDup = providerWorkQueue
          .listPendingProviderWorkQueue("discovery")
          .filter((p) => p.provider_id === "wd-queue-dup");
        assertEq(pendingDup.length, 2, "wd-22d-setup: two distinct-reason queue rows exist for the same provider");

        const selDup = expStore.selectGardssalgProvidersForWebsiteDiscovery(48);
        const idsDup = selDup.map((s: any) => s.id);
        const dupCount = idsDup.filter((id: string) => id === "wd-queue-dup").length;
        assertEq(dupCount, 1, "wd-22d: a provider with two unresolved discovery-queue rows (different reasons) appears exactly ONCE in the selection, not twice");
      }

      // ── wd-23 (Skive 1, dev-request 2026-08-17-forsyningskjede-samarbeid-
      //    og-kvalitetsoppdatering): approving a discovery candidate resolves
      //    the pending discovery-targeted provider_work_queue row(s) for that
      //    provider AND triggers the ownership-verification sweep for that
      //    ONE provider in the SAME request. ──────────────────────────────
      {
        insertProvider.run({ id: "wd-sweep-trigger", navn: "Samkjoert Gard", org_nr: "999100002", kommune: "Voss", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "sideri" });
        expStore.upsertGardssalgWebsiteReviewQueue({
          provider_id: "wd-sweep-trigger",
          provider_name: "Samkjoert Gard",
          candidate_url: "https://samkjoertgard.no",
        });
        // The pending item this approval is expected to resolve: some
        // earlier pipeline (sweep, here) asked discovery for a homepage.
        providerWorkQueue.enqueueProviderWorkQueueItem({
          provider_id: "wd-sweep-trigger",
          from_system: "sweep",
          to_system: "discovery",
          reason: "missing_source",
        });

        const prevFetch7 = globalThis.fetch;
        const sweepTriggerHtml = "<html><body>Samkjoert Gard, Voss — org.nr 999 100 002</body></html>";
        globalThis.fetch = (async (url: string | URL | Request) => {
          const urlStr = String(url);
          if (urlStr.startsWith("https://samkjoertgard.no")) {
            return {
              ok: true, status: 200, url: urlStr,
              arrayBuffer: async () => new TextEncoder().encode(sweepTriggerHtml).buffer,
              headers: { get: () => null },
            } as unknown as Response;
          }
          return { ok: false, status: 404, url: urlStr, headers: { get: () => null } } as unknown as Response;
        }) as unknown as typeof fetch;

        try {
          const r = await callRoute(opplevelserRouter, {
            headers: adminHeaders,
            url: "/admin/gardssalg-website-review-approve",
            body: { approvals: [{ provider_id: "wd-sweep-trigger", url: "https://samkjoertgard.no" }], apply: true },
          });
          assertEq(r.body.written_count, 1, "wd-23a: approval writes hjemmeside as before");
          const hj = (expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id='wd-sweep-trigger'`).get() as any).hjemmeside;
          assertEq(hj, "https://samkjoertgard.no", "wd-23b: hjemmeside persisted");

          const resolvedRow = expDb.prepare(
            `SELECT resolved_at, outcome FROM provider_work_queue WHERE provider_id='wd-sweep-trigger' AND to_system='discovery'`
          ).get() as any;
          assertTrue(!!resolvedRow?.resolved_at, "wd-23c: the pending discovery-targeted work-queue row for this provider is resolved by the approval");
          assertEq(resolvedRow?.outcome, "hjemmeside_written", "wd-23d: resolved with outcome hjemmeside_written");
          const stillPendingAfterResolve = providerWorkQueue.listPendingProviderWorkQueue("discovery").some((p) => p.provider_id === "wd-sweep-trigger");
          assertTrue(!stillPendingAfterResolve, "wd-23e: no longer reported as pending by listPendingProviderWorkQueue");

          // The SAME-cycle sweep trigger: field_provenance.hjemmeside_
          // verification is stamped by applyGardssalgWebsiteVerification,
          // which ONLY the internal .../gardssalg-website-verification-
          // remediation call (never applyGardssalgProviderWebsite itself)
          // ever writes — its presence proves the sweep really ran inside
          // the SAME request as the approval above, not merely that
          // hjemmeside was written.
          const prov = JSON.parse(
            (expDb.prepare(`SELECT field_provenance FROM experience_providers WHERE id='wd-sweep-trigger'`).get() as any).field_provenance || "{}"
          );
          assertTrue(!!prov.hjemmeside_verification, "wd-23f: the ownership-verification sweep ran in the SAME request as the approval (field_provenance.hjemmeside_verification stamped)");
          assertEq(prov.hjemmeside_verification.classification, "verified", "wd-23g: the mocked candidate page carries matching ownership evidence, so the same-cycle sweep verifies it");

          // wd-22a's queue item for a DIFFERENT provider (wd-queue-a) must be
          // completely unaffected by approving wd-sweep-trigger.
          const wdQueueAStillPending = providerWorkQueue.listPendingProviderWorkQueue("discovery").some((p) => p.provider_id === "wd-queue-a");
          assertTrue(wdQueueAStillPending, "wd-23h: an unrelated provider's pending discovery-targeted queue item is untouched by this approval");
        } finally {
          globalThis.fetch = prevFetch7;
        }
      }

      // ── wd-24 (dev-request 2026-08-17-discovery-hand-off-og-skedulering,
      //    Skive 2 — the one gap Skive 1's provider_work_queue left open): a
      //    pending sweep->discovery "evidence_url_rejected" queue row already
      //    carries the exact URL the sweep just disproved for this provider
      //    (payload.rejected_url) — discovery must never re-propose that SAME
      //    host, via EITHER tier, and must never even fetch it. ─────────────
      {
        insertProvider.run({ id: "wd-rejhost", navn: "Kveldsro Sideri", org_nr: "999111266", kommune: "Ulvik", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "sideri" });
        // The sweep already tried this exact host (via an evidence_url
        // candidate) and it failed ownership-proof — recorded as a pending
        // discovery-targeted work-queue row, same shape Skive 1 writes.
        providerWorkQueue.enqueueProviderWorkQueueItem({
          provider_id: "wd-rejhost",
          provider_name: "Kveldsro Sideri",
          from_system: "sweep",
          to_system: "discovery",
          reason: "evidence_url_rejected",
          payload: JSON.stringify({ rejected_url: "https://kveldsrosideri-ekte.no/om-oss" }),
        });

        // Tier-2 search is rigged to hand back EXACTLY that host as its only
        // result — proving the exclusion applies to search-sourced
        // candidates too, not just the tier-1 name-guess list.
        expStore.__setGardssalgWebsiteSearchForTesting(async () => [
          { title: "Kveldsro Sideri", url: "https://kveldsrosideri-ekte.no", description: "Kveldsro Sideri i Ulvik" },
        ]);

        const rejHostFetchCalls: string[] = [];
        const prevFetch8 = globalThis.fetch;
        globalThis.fetch = (async (url: string | URL | Request) => {
          const urlStr = String(url);
          rejHostFetchCalls.push(urlStr);
          // Would VERIFY if ever fetched — proves any exclusion observed
          // below is the rejected-host guard, not a missing/failing page.
          // Title tag included deliberately: the weakest verification branch
          // (name+place, no org_nr/phone match) also requires the producer's
          // name in <title> (2026-08-06 incident fix) — without it this page
          // would never verify for EITHER provider below, making wd-24a's
          // "would verify if fetched" premise false.
          if (urlStr.startsWith("https://kveldsrosideri-ekte.no")) {
            return { ok: true, status: 200, url: urlStr, text: async () => "<html><head><title>Kveldsro Sideri</title></head><body>Kveldsro Sideri, Ulvik</body></html>" } as unknown as Response;
          }
          return { ok: false, status: 404, url: urlStr, text: async () => "" } as unknown as Response;
        }) as unknown as typeof fetch;

        try {
          const r = await callRoute(opplevelserRouter, {
            headers: adminHeaders,
            body: { providerIds: ["wd-rejhost"], apply: true },
          });

          assertTrue(!(r.body.proposed as any[]).some((p) => p.provider_id === "wd-rejhost"),
            "wd-24a: the just-rejected host is never proposed, even though it would verify if fetched");
          assertTrue((r.body.no_candidate_verified as any[]).some((e) => e.provider_id === "wd-rejhost"),
            "wd-24b: falls through to no_candidate_verified instead");
          assertTrue(!rejHostFetchCalls.some((u) => u.includes("kveldsrosideri-ekte.no")),
            "wd-24c: the rejected host is never even fetched (excluded pre-fetch, both tiers)");
          const rejQ = (expDb.prepare(`SELECT COUNT(*) c FROM gardssalg_website_review_queue WHERE provider_id='wd-rejhost'`).get() as any).c;
          assertEq(rejQ, 0, "wd-24d: no review-queue write for the excluded row");

          // A DIFFERENT provider's tier-2 result for the SAME host string
          // must be unaffected — the exclusion is scoped per-provider (keyed
          // off THAT provider's own pending queue row), not global.
          insertProvider.run({ id: "wd-rejhost-other", navn: "Kveldsro Sideri", org_nr: "999111299", kommune: "Ulvik", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "sideri" });
          expStore.__setGardssalgWebsiteSearchForTesting(async () => [
            { title: "Kveldsro Sideri", url: "https://kveldsrosideri-ekte.no", description: "Kveldsro Sideri i Ulvik" },
          ]);
          const r2 = await callRoute(opplevelserRouter, {
            headers: adminHeaders,
            body: { providerIds: ["wd-rejhost-other"], apply: true },
          });
          assertTrue((r2.body.proposed as any[]).some((p) => p.provider_id === "wd-rejhost-other" && p.candidate_url === "https://kveldsrosideri-ekte.no"),
            "wd-24e: the SAME host is proposed for an unrelated provider with no rejection recorded against it — exclusion is per-provider, not a global blocklist");
        } finally {
          globalThis.fetch = prevFetch8;
          expStore.__setGardssalgWebsiteSearchForTesting(null);
        }
      }

      // ── wd-25: auto-mode approve — M0d Del A (dev-request 2026-08-19-
      //    kursjustering-drikkefunnel-llm-og-supply, "Grep 8 punkt 2"):
      //    server-side selection by confidence, NEVER a client-supplied list
      //    in this mode, run through the SAME write loop as approvals-mode. ─
      {
        // Isolate from any queue rows left behind by earlier sections above.
        expDb.prepare(`DELETE FROM gardssalg_website_review_queue`).run();

        insertProvider.run({ id: "wd-auto-orgnr", navn: "Auto Orgnr Gard", org_nr: "922333444", kommune: "Voss", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "sideri" });
        insertProvider.run({ id: "wd-auto-phone", navn: "Auto Phone Gard", org_nr: "922333445", kommune: "Voss", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "sideri" });
        insertProvider.run({ id: "wd-auto-addr", navn: "Auto Addr Gard", org_nr: "922333446", kommune: "Voss", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "sideri" });
        insertProvider.run({ id: "wd-auto-name", navn: "Auto Name Gard", org_nr: "922333447", kommune: "Voss", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "sideri" });
        insertProvider.run({ id: "wd-auto-null", navn: "Auto Null Gard", org_nr: "922333448", kommune: "Voss", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "sideri" });

        // Mixed confidence tiers, same graded scale the discovery route
        // itself sets at insertion (1.0 org_nr / 0.95 phone / 0.92 address /
        // 0.9 name+place); the last row mirrors the brreg-only insertion
        // path, which never sets confidence at all (SQL NULL).
        expStore.upsertGardssalgWebsiteReviewQueue({ provider_id: "wd-auto-orgnr", provider_name: "Auto Orgnr Gard", candidate_url: "https://auto-orgnr-gard.no", final_url: "https://auto-orgnr-gard.no", confidence: 1.0, reason: "website_discovery_candidate" });
        expStore.upsertGardssalgWebsiteReviewQueue({ provider_id: "wd-auto-phone", provider_name: "Auto Phone Gard", candidate_url: "https://auto-phone-gard.no", final_url: "https://auto-phone-gard.no", confidence: 0.95, reason: "website_discovery_candidate" });
        expStore.upsertGardssalgWebsiteReviewQueue({ provider_id: "wd-auto-addr", provider_name: "Auto Addr Gard", candidate_url: "https://auto-addr-gard.no", final_url: "https://auto-addr-gard.no", confidence: 0.92, reason: "website_discovery_candidate" });
        expStore.upsertGardssalgWebsiteReviewQueue({ provider_id: "wd-auto-name", provider_name: "Auto Name Gard", candidate_url: "https://auto-name-gard.no", final_url: "https://auto-name-gard.no", confidence: 0.9, reason: "website_discovery_candidate" });
        expStore.upsertGardssalgWebsiteReviewQueue({ provider_id: "wd-auto-null", provider_name: "Auto Null Gard", candidate_url: "https://auto-null-gard.no", final_url: "https://auto-null-gard.no", reason: "brreg_registered_hjemmeside" });

        // wd-25a-i: default min_confidence (1.0) only approves/writes the
        //    org.nr-tier row.
        const auto1 = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          url: "/admin/gardssalg-website-review-approve",
          body: { auto: true, apply: true },
        });
        assertEq(auto1.body.mode, "auto", "wd-25a: response reports mode:'auto'");
        assertEq(auto1.body.min_confidence, 1, "wd-25b: default min_confidence is 1.0");
        assertEq(auto1.body.candidates_considered, 1, "wd-25c: only the org_nr row qualifies at default min_confidence");
        assertEq(auto1.body.approved_count, 1, "wd-25d: exactly one approved");
        assertEq((auto1.body.approved as any[])[0]?.provider_id, "wd-auto-orgnr", "wd-25e: the org_nr-tier row is the one approved");
        assertEq(auto1.body.written_count, 1, "wd-25f: exactly one written");
        const rowAutoOrgnr = expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id='wd-auto-orgnr'`).get() as any;
        assertEq(rowAutoOrgnr.hjemmeside, "https://auto-orgnr-gard.no", "wd-25g: hjemmeside actually written for the org_nr row");
        const qLeftAutoOrgnr = (expDb.prepare(`SELECT COUNT(*) c FROM gardssalg_website_review_queue WHERE provider_id='wd-auto-orgnr'`).get() as any).c;
        assertEq(qLeftAutoOrgnr, 0, "wd-25h: queue entry cleared for the auto-approved row");
        const rowAutoPhoneUntouched = expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id='wd-auto-phone'`).get() as any;
        assertEq(rowAutoPhoneUntouched.hjemmeside, null, "wd-25i: lower-confidence rows are NOT written at default min_confidence");

        // wd-25j-p: explicit min_confidence: 0.9 approves everything except
        //    the NULL row (never selected at any threshold).
        const auto2 = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          url: "/admin/gardssalg-website-review-approve",
          body: { auto: true, apply: true, min_confidence: 0.9 },
        });
        assertEq(auto2.body.min_confidence, 0.9, "wd-25j: min_confidence echoed back");
        assertEq(auto2.body.candidates_considered, 3, "wd-25k: three remaining rows (phone/addr/name) qualify, NULL row excluded");
        assertEq(auto2.body.approved_count, 3, "wd-25l: all three approved");
        assertEq(auto2.body.written_count, 3, "wd-25m: all three written");
        const approvedIds2 = (auto2.body.approved as any[]).map((a: any) => a.provider_id).sort();
        assertEq(JSON.stringify(approvedIds2), JSON.stringify(["wd-auto-addr", "wd-auto-name", "wd-auto-phone"]), "wd-25n: exactly the three non-NULL, sub-org_nr-tier rows");
        const rowAutoNullUntouched = expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id='wd-auto-null'`).get() as any;
        assertEq(rowAutoNullUntouched.hjemmeside, null, "wd-25o: the NULL-confidence (unverified brreg-only) row is never auto-approved at any min_confidence");
        const qLeftAutoNull = (expDb.prepare(`SELECT COUNT(*) c FROM gardssalg_website_review_queue WHERE provider_id='wd-auto-null'`).get() as any).c;
        assertEq(qLeftAutoNull, 1, "wd-25p: NULL-confidence row still sits untouched in the queue");

        // wd-25q-s: min_confidence outside [0,1], or non-numeric -> 400.
        const autoBadHigh = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          url: "/admin/gardssalg-website-review-approve",
          body: { auto: true, min_confidence: 1.5 },
        });
        assertEq(autoBadHigh.status, 400, "wd-25q: min_confidence > 1 -> 400");
        const autoBadNeg = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          url: "/admin/gardssalg-website-review-approve",
          body: { auto: true, min_confidence: -0.1 },
        });
        assertEq(autoBadNeg.status, 400, "wd-25r: min_confidence < 0 -> 400");
        const autoBadNaN = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          url: "/admin/gardssalg-website-review-approve",
          body: { auto: true, min_confidence: "1.0" },
        });
        assertEq(autoBadNaN.status, 400, "wd-25s: non-numeric min_confidence -> 400");

        // wd-25t: auto:true + non-empty approvals -> 400 (mutually exclusive).
        const autoPlusApprovals = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          url: "/admin/gardssalg-website-review-approve",
          body: { auto: true, approvals: [{ provider_id: "wd-auto-orgnr", url: "https://auto-orgnr-gard.no" }] },
        });
        assertEq(autoPlusApprovals.status, 400, "wd-25t: combining 'auto' and non-empty 'approvals' -> 400");

        // wd-25u-y: empty qualifying set -> approved/written/rejected all
        //    empty arrays, no error.
        expDb.prepare(`DELETE FROM gardssalg_website_review_queue`).run();
        const autoEmpty = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          url: "/admin/gardssalg-website-review-approve",
          body: { auto: true, apply: true },
        });
        assertEq(autoEmpty.status, 200, "wd-25u: empty qualifying set is still a 200");
        assertEq(autoEmpty.body.candidates_considered, 0, "wd-25v: candidates_considered is 0");
        assertEq(JSON.stringify(autoEmpty.body.approved), "[]", "wd-25w: approved is an empty array");
        assertEq(JSON.stringify(autoEmpty.body.written), "[]", "wd-25x: written is an empty array");
        assertEq(JSON.stringify(autoEmpty.body.rejected), "[]", "wd-25y: rejected is an empty array too — nothing to reject");

        // wd-25z-ab: cap — >30 qualifying rows -> exactly 30 processed,
        //    candidates_considered shows the full UNCAPPED count.
        for (let i = 0; i < 35; i++) {
          const pid = `wd-auto-cap-${i}`;
          insertProvider.run({ id: pid, navn: `Auto Cap Gard ${i}`, org_nr: String(900000000 + i), kommune: "Voss", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "sideri" });
          expStore.upsertGardssalgWebsiteReviewQueue({ provider_id: pid, provider_name: `Auto Cap Gard ${i}`, candidate_url: `https://auto-cap-gard-${i}.no`, final_url: `https://auto-cap-gard-${i}.no`, confidence: 1.0, reason: "website_discovery_candidate" });
        }
        const autoCap = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          url: "/admin/gardssalg-website-review-approve",
          body: { auto: true, apply: false },
        });
        assertEq(autoCap.body.candidates_considered, 35, "wd-25z: candidates_considered reports the full UNCAPPED count");
        assertEq(autoCap.body.approved_count, 30, "wd-25aa: exactly GARDSSALG_AUTO_APPROVE_BATCH_CAP (30) processed");
        const cappedQueueLeft = (expDb.prepare(`SELECT COUNT(*) c FROM gardssalg_website_review_queue`).get() as any).c;
        assertEq(cappedQueueLeft, 35, "wd-25ab: dry-run leaves ALL 35 rows in the queue (the cap bounds processing, not the queue itself)");

        // wd-25ac-ad: existing client-supplied 'approvals' mode stays
        //    byte-for-byte unchanged when 'auto' is absent — no 'mode' field,
        //    and NOT gated by the auto-mode confidence threshold at all.
        expDb.prepare(`DELETE FROM gardssalg_website_review_queue`).run();
        insertProvider.run({ id: "wd-manual-mode-check", navn: "Manual Mode Check Gard", org_nr: "922444555", kommune: "Voss", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "sideri" });
        expStore.upsertGardssalgWebsiteReviewQueue({ provider_id: "wd-manual-mode-check", provider_name: "Manual Mode Check Gard", candidate_url: "https://manual-mode-check-gard.no", final_url: "https://manual-mode-check-gard.no", confidence: 0.5, reason: "website_discovery_candidate" });
        const manualStillWorks = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          url: "/admin/gardssalg-website-review-approve",
          body: { approvals: [{ provider_id: "wd-manual-mode-check", url: "https://manual-mode-check-gard.no" }], apply: true },
        });
        assertEq(manualStillWorks.body.mode, undefined, "wd-25ac: non-auto response carries no 'mode' field");
        assertEq(manualStillWorks.body.written_count, 1, "wd-25ad: client-supplied approvals mode still writes a sub-threshold-confidence row (auto's confidence gate never applies to this mode)");
      }

    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-website-discovery: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      try {
        const initMod = require("../database/init") as typeof import("../database/init");
        if (prevRfbDb) initMod.__setDbForTesting(prevRfbDb);
      } catch { /* best-effort */ }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}
