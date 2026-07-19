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
    const testKey = "gardssalg-wd-test-key";
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
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const adminHeaders = { "x-admin-key": testKey };

      // ═══ Section A — pure candidate-host generation ═════════════════════
      {
        const h1 = expStore.gardssalgWebsiteCandidateHosts("Fjelldal Brenneri AS");
        assertTrue(h1.includes("fjelldalbrenneri.no"), "wd-a1: joined .no candidate, org-suffix dropped");
        assertTrue(h1.includes("fjelldal-brenneri.no"), "wd-a2: hyphenated candidate");
        const h2 = expStore.gardssalgWebsiteCandidateHosts("Bjørkegård Sideri — Hardanger");
        assertTrue(h2.includes("bjorkegardsideri.no"), "wd-a3: ø→o/å→a variant, «— Sted» pruned before generation");
        assertTrue(h2.includes("bjoerkegaardsideri.no"), "wd-a4: ø→oe/å→aa variant generated too");
        assertTrue(h2.length <= 4, "wd-a5: at most 4 candidates");
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
      }

      // ═══ Fixtures ═══════════════════════════════════════════════════════
      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, kommune, poststed, hjemmeside, catalog_hidden, content_source, products,
            producer_type, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @kommune, @poststed, @hjemmeside, @catalog_hidden, @content_source, '["x"]',
            @producer_type, 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      // HIDDEN row (the komplett-foer-synlig batch shape) — page will carry its org_nr.
      insertProvider.run({ id: "wd-hidden", navn: "Fjelldal Brenneri", org_nr: "944444444", kommune: "Saltdal", poststed: null, hjemmeside: null, catalog_hidden: 1, content_source: null, producer_type: "destilleri" });
      // Visible row whose candidate host collides with the curated directory list (hanen.no).
      insertProvider.run({ id: "wd-agg", navn: "Hanen", org_nr: "911111111", kommune: "Oslo", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "bryggeri" });
      // Row whose candidate host is ALREADY carried by another catalog row.
      insertProvider.run({ id: "wd-taken", navn: "Solbakken Gard", org_nr: "922222222", kommune: "Voss", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "sideri" });
      insertProvider.run({ id: "wd-owner", navn: "Annen Produsent", org_nr: "933333333", kommune: "Voss", poststed: null, hjemmeside: "https://solbakkengard.no", catalog_hidden: null, content_source: null, producer_type: "sideri" });
      // Claim-locked row — never processed.
      insertProvider.run({ id: "wd-locked", navn: "Kravsatt Gard", org_nr: "955555555", kommune: "Bodø", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: "claim", producer_type: "bryggeri" });
      // Row with no verifiable page anywhere.
      insertProvider.run({ id: "wd-none", navn: "Ukjent Fjellgard", org_nr: "966666666", kommune: "Lom", poststed: null, hjemmeside: null, catalog_hidden: null, content_source: null, producer_type: "bryggeri" });
      // Test provider — must never be selected nor counted.
      insertProvider.run({ id: "wd-testprov", navn: "Test Gardssalg", org_nr: "977777777", kommune: "Oslo", poststed: null, hjemmeside: "https://testgardssalg.example.no", catalog_hidden: 1, content_source: null, producer_type: "test-gardssalg" });

      let fetchCalls: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        fetchCalls.push(urlStr);
        const mk = (html: string, finalUrl?: string) =>
          ({ ok: true, status: 200, url: finalUrl ?? urlStr, text: async () => html } as unknown as Response);
        if (urlStr.startsWith("https://fjelldalbrenneri.no")) {
          return mk("<html><body>Fjelldal Brenneri — org.nr 944 444 444</body></html>");
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
      {
        const wLocked = expStore.applyGardssalgProviderWebsite("wd-locked", "https://kravsattgard.no", "https://x");
        assertEq(wLocked.length, 0, "wd-6a: locked provider → nothing written");
        const wTaken = expStore.applyGardssalgProviderWebsite("wd-taken", "https://solbakkengard.no", "https://x");
        assertEq(wTaken.length, 0, "wd-6b: host already carried by another provider → write refused (shared-host guard)");
        const wBad = expStore.applyGardssalgProviderWebsite("wd-agg", "ikke-en-url", "https://x");
        assertEq(wBad.length, 0, "wd-6c: non-URL rejected by sanity gate");
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
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}
