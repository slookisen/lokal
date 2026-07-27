/**
 * opplevelser-providers-recently-enriched.test.ts — unit tests for
 * GET /api/opplevelser/admin/providers/recently-enriched
 * (src/routes/opplevelser.ts).
 *
 * Slice 5 of dev-request 2026-07-13-enrichment-metode-maldrevet-evidens:
 * experiences-vertical counterpart of admin-agents-recently-enriched.test.ts
 * (marketplace.ts) and dental-agents-recently-enriched.test.ts (dental.ts).
 * Experiences has NO field_provenance column (see the LOCK MODEL comment
 * near getProviderByName in experience-store.ts) — so this response omits
 * it in favor of `field_provenance: null, provenance_model: "none"`, and
 * instead surfaces the content fields the gårdssalg content-refresh writer
 * actually fills (about_text/visit_text/opening_hours_text/products/
 * content_source/content_evidence_url).
 *
 * Setup mirrors opplevelser-gardssalg-provider-lookup.test.ts exactly:
 * EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory + opplevelser
 * router per run, callRoute() exercised directly against router.handle()
 * (X-Admin-Key via headers) — no real HTTP server / supertest needed.
 *
 * Covers:
 *   (a) 403 without X-Admin-Key
 *   (b) default since (7d) excludes a provider enriched 10 days ago,
 *       includes one enriched 1 day ago
 *   (c) explicit since widens the window
 *   (d) invalid since falls back to the 7-day default (not 400/500)
 *   (e) limit default + clamping (0/negative -> 1, >50 -> 50)
 *   (f) shape of a returned row: id/name/website/last_enriched_at content
 *       fields + field_provenance:null + provenance_model:"none" — no
 *       rfb-shaped field_provenance object ever invented
 *   (g) malformed products JSON -> [] (never throws)
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
  opts: { headers?: Record<string, string>; query?: Record<string, string> } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const query = opts.query || {};
    const qs = Object.keys(query).length
      ? "?" + Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
      : "";
    const req: any = {
      method: "GET",
      url: "/admin/providers/recently-enriched" + qs,
      originalUrl: "/admin/providers/recently-enriched" + qs,
      path: "/admin/providers/recently-enriched",
      query,
      headers: opts.headers || {},
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

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function runOpplevelserProvidersRecentlyEnrichedTests(
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
    const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    const testKey = "providers-recently-enriched-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, last_enriched_at, about_text, visit_text,
            opening_hours_text, products, content_source, content_evidence_url,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @last_enriched_at, @about_text, @visit_text,
            @opening_hours_text, @products, @content_source, @content_evidence_url,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      insertProvider.run({
        id: "prov-recent", navn: "Nylig Enriched Sideri AS", hjemmeside: "https://nylig-sideri.example.no",
        last_enriched_at: daysAgoIso(1),
        about_text: "Vi lager sider på tradisjonelt vis.", visit_text: "Åpent for besøk lørdager.",
        opening_hours_text: "Lør 10-16", products: JSON.stringify(["Eplesider", "Eplemost"]),
        content_source: "provider_site", content_evidence_url: "https://nylig-sideri.example.no/om-oss",
      });
      insertProvider.run({
        id: "prov-old", navn: "Gammel Enriched Gård AS", hjemmeside: "https://gammel-gard.example.no",
        last_enriched_at: daysAgoIso(10),
        about_text: null, visit_text: null, opening_hours_text: null, products: null,
        content_source: null, content_evidence_url: null,
      });
      insertProvider.run({
        id: "prov-malformed-products", navn: "Rar Produkter AS", hjemmeside: "https://rar-produkter.example.no",
        last_enriched_at: daysAgoIso(2),
        about_text: null, visit_text: null, opening_hours_text: null, products: "{not json",
        content_source: null, content_evidence_url: null,
      });
      insertProvider.run({
        id: "prov-never-enriched", navn: "Aldri Enriched AS", hjemmeside: "https://aldri.example.no",
        last_enriched_at: null,
        about_text: null, visit_text: null, opening_hours_text: null, products: null,
        content_source: null, content_evidence_url: null,
      });

      // The 2026-W30 case (dev-request 2026-07-27-kvalitetsporter-uten-signal,
      // slice C): a provider the GENERIC content-refresh enriched. That writer
      // fills description/category on the provider's EXPERIENCES rows and only
      // stamps last_enriched_at on the provider — so every provider-level
      // (gårdssalg) content column here is legitimately null. Before this
      // slice such a provider came back with nothing checkable, which is why
      // the weekly spot-check reported "experiences: checked=0" while
      // enrichment was in fact writing.
      insertProvider.run({
        id: "prov-generic-enriched", navn: "Generisk Enriched Opplevelse AS",
        hjemmeside: "https://generisk.example.no",
        last_enriched_at: daysAgoIso(1),
        about_text: null, visit_text: null, opening_hours_text: null, products: null,
        content_source: null, content_evidence_url: null,
      });
      const insertExperience = expDb.prepare(
        `INSERT INTO experiences
           (id, provider_id, title, description, category, subcategory, booking_url,
            content_source, enrichment_state, updated_at)
         VALUES
           (@id, @provider_id, @title, @description, @category, @subcategory, @booking_url,
            @content_source, @enrichment_state, @updated_at)`,
      );
      insertExperience.run({
        id: "exp-enriched-1", provider_id: "prov-generic-enriched",
        title: "Guidet fjelltur", description: "Guidet tur til toppen med lokal fjellfører.",
        category: "natur_friluft", subcategory: null,
        booking_url: "https://generisk.example.no/booking",
        content_source: "provider_site", enrichment_state: "enriched",
        updated_at: daysAgoIso(1),
      });
      // A raw (un-enriched) row on the same provider must NOT be served — the
      // spot-check judges written content, and nothing was written here.
      insertExperience.run({
        id: "exp-raw-1", provider_id: "prov-generic-enriched",
        title: "Uberiket opplevelse", description: null, category: null, subcategory: null,
        booking_url: null, content_source: null, enrichment_state: "raw",
        updated_at: daysAgoIso(1),
      });
      // enrichment_state='verified' — the ladder's final rung. Nothing writes it
      // today, which is exactly why the IN ('enriched','verified') clause needs
      // a fixture: without one, a revert to `= 'enriched'` passes green
      // (round-2 review, finding 3).
      insertExperience.run({
        id: "exp-verified-1", provider_id: "prov-generic-enriched",
        title: "Verifisert opplevelse", description: "Verifisert beskrivelse fra hjemmesiden.",
        category: "kultur_historie", subcategory: null, booking_url: null,
        content_source: "provider_site", enrichment_state: "verified",
        updated_at: daysAgoIso(2),
      });
      // Owner/claim-authored rows must NEVER be served: applyExperienceContent
      // refuses to write them, so judging them against the provider's homepage
      // would score a mismatch that is not an error — and §8.4 pauses
      // enrichment writes for the whole vertical above a 10% error rate
      // (round-2 review, blocking finding 2).
      insertExperience.run({
        id: "exp-manual-1", provider_id: "prov-generic-enriched",
        title: "Eierskrevet opplevelse", description: "Tekst produsenten selv skrev.",
        category: "mat_drikke", subcategory: null, booking_url: null,
        content_source: "manual", enrichment_state: "enriched",
        updated_at: daysAgoIso(1),
      });
      insertExperience.run({
        id: "exp-claim-1", provider_id: "prov-generic-enriched",
        title: "Claim-skrevet opplevelse", description: "Tekst fra claim-flyten.",
        category: "mat_drikke", subcategory: null, booking_url: null,
        content_source: "claim", enrichment_state: "enriched",
        updated_at: daysAgoIso(1),
      });

      // Rows needing the two columns the statement above leaves at their
      // schema defaults (canonical_id NULL, verification_status
      // 'pending_verify') — round-3 review, findings 1 and 3.
      const insertExperienceFull = expDb.prepare(
        `INSERT INTO experiences
           (id, provider_id, title, description, category, subcategory, booking_url,
            content_source, enrichment_state, canonical_id, verification_status,
            evidence_url, discovery_source, updated_at)
         VALUES
           (@id, @provider_id, @title, @description, @category, @subcategory, @booking_url,
            @content_source, @enrichment_state, @canonical_id, @verification_status,
            @evidence_url, @discovery_source, @updated_at)`,
      );
      const insertFull = (row: Record<string, unknown>) =>
        insertExperienceFull.run({ evidence_url: null, discovery_source: null, ...row });
      // A row the dedup pass merged away must NEVER be served (round-3 review,
      // BLOCKING). Its updated_at is deliberately the NEWEST of any row on this
      // provider, because that is exactly what runDedupPass() produces: it
      // stamps canonical_id and bumps `updated_at = datetime('now')` in the
      // same UPDATE (experience-dedup.ts:562-563). Under the endpoint's
      // `ORDER BY updated_at DESC LIMIT 10` a merged-away row therefore sorts
      // ABOVE the live ones — so dropping `AND canonical_id IS NULL` does not
      // merely leak this row, it puts it FIRST. h11/h12 below fail on a revert.
      insertFull({
        id: "exp-merged-away-1", provider_id: "prov-generic-enriched",
        title: "Duplikat, foldet inn i exp-enriched-1",
        description: "Tekst fra en rad som ikke finnes på noen brukerflate lenger.",
        category: "natur_friluft", subcategory: null, booking_url: null,
        content_source: "provider_site", enrichment_state: "enriched",
        canonical_id: "exp-enriched-1", verification_status: "pending_verify",
        updated_at: daysAgoIso(0),
      });
      // verification_status NULL: isExperienceContentLocked treats NULL as
      // UNLOCKED, so applyExperienceContent would enrich this row — but SQL
      // three-valued logic makes a bare `verification_status != 'verified'`
      // evaluate to NULL and drop it, i.e. hide precisely the rows that ARE
      // checkable. Latent today (createExperience coalesces to
      // 'pending_verify'), pinned so the NULL guard cannot be simplified away.
      insertFull({
        id: "exp-nullverif-1", provider_id: "prov-generic-enriched",
        title: "Opplevelse uten verification_status",
        description: "Beskrivelse skrevet av generisk content-refresh.",
        category: "mat_drikke", subcategory: null, booking_url: null,
        content_source: "provider_site", enrichment_state: "enriched",
        canonical_id: null, verification_status: null,
        updated_at: daysAgoIso(3),
      });
      // verification_status = 'verified' — the OTHER half of round 2's lock
      // guard. Round-4 review ran a mutation matrix and found that deleting the
      // entire `verification_status` clause left the suite GREEN: no fixture
      // ever set the column to 'verified'. `exp-verified-1` sets
      // *enrichment_state* = 'verified' and leaves verification_status at the
      // 'pending_verify' default, and h13 pins only the NULL branch — which
      // survives deleting the whole clause too. So the one test that looked
      // like it guarded this clause guarded nothing about it.
      insertFull({
        id: "exp-verified-lock-1", provider_id: "prov-generic-enriched",
        title: "Låst av verification_status", description: "Verifisert av et menneske.",
        category: "kultur_historie", subcategory: null, booking_url: null,
        content_source: "provider_site", enrichment_state: "enriched",
        canonical_id: null, verification_status: "verified",
        updated_at: daysAgoIso(1),
      });
      // Harvest-sourced content mislabeled as homepage-sourced (round-4 review,
      // BLOCKING). applyExperienceContent() stamps content_source =
      // 'provider_site' unconditionally, including when bulkInsertExperiences
      // hands it a third-party harvest row — so `content_source` cannot
      // distinguish this from real homepage content, and no SQL predicate can.
      // Its evidence_url points at the aggregator, not at the page the verifier
      // is about to fetch, so judging it produces a false `mismatch` — which is
      // what trips the §8.4 write-pause.
      insertFull({
        id: "exp-aggregator-sourced-1", provider_id: "prov-generic-enriched",
        title: "Tekst hentet fra DMO-side",
        description: "AGGREGATOR-TEKST: Bli med inn i fjøset og mat lammene.",
        category: "dyreliv_safari", subcategory: null,
        booking_url: "https://visitnorway.com/book/123",
        content_source: "provider_site", enrichment_state: "enriched",
        canonical_id: null, verification_status: "pending_verify",
        evidence_url: "https://visitnorway.com/x", discovery_source: "visitnorway",
        updated_at: daysAgoIso(1),
      });
      // …and the control: same shape, but the evidence DOES point at the
      // provider's own homepage. This one must still be served, otherwise the
      // filter above would just be a new way to report checked=0.
      insertFull({
        id: "exp-homepage-sourced-1", provider_id: "prov-generic-enriched",
        title: "Tekst hentet fra egen hjemmeside",
        description: "Beskrivelse hentet fra produsentens egen side.",
        category: "natur_friluft", subcategory: null, booking_url: null,
        content_source: "provider_site", enrichment_state: "enriched",
        canonical_id: null, verification_status: "pending_verify",
        evidence_url: "https://www.generisk.example.no/opplevelser", discovery_source: "provider_site",
        updated_at: daysAgoIso(4),
      });
      // 11 enriched rows on their own provider, so `LIMIT 10` truncates by
      // exactly one. The doc-comment calls the truncation out as something
      // "which matters to a consumer computing `checked`"; nothing pinned it
      // (round-3 review, finding 4).
      insertProvider.run({
        id: "prov-many-experiences", navn: "Mange Opplevelser AS",
        hjemmeside: "https://mange.example.no",
        last_enriched_at: daysAgoIso(1),
        about_text: null, visit_text: null, opening_hours_text: null, products: null,
        content_source: null, content_evidence_url: null,
      });
      for (let i = 0; i < 11; i++) {
        insertExperience.run({
          id: `exp-many-${i}`, provider_id: "prov-many-experiences",
          title: `Opplevelse ${i}`, description: `Beskrivelse ${i}.`,
          category: "natur_friluft", subcategory: null, booking_url: null,
          content_source: "provider_site", enrichment_state: "enriched",
          updated_at: daysAgoIso(i + 1),
        });
      }

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── (a) 403 without X-Admin-Key ─────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, { query: { limit: "50" } });
      assertEq(noKey.status, 403, "a1: GET /admin/providers/recently-enriched without X-Admin-Key -> 403");
      assertTrue(!noKey.body?.providers, "a2: no-key response carries no providers payload");

      // ── (b) default since (7d) ───────────────────────────────────────────
      const dflt = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { limit: "50" },
      });
      assertEq(dflt.status, 200, "b1: default since/limit -> 200");
      {
        const ids = (dflt.body.providers as any[]).map((p) => p.id);
        assertTrue(ids.includes("prov-recent"), "b2: default window includes 1-day-old provider");
        assertTrue(!ids.includes("prov-old"), "b3: default window excludes 10-day-old provider");
        assertTrue(!ids.includes("prov-never-enriched"), "b4: never-enriched (NULL last_enriched_at) provider excluded");
      }

      // ── (c) explicit since widens the window ─────────────────────────────
      const wide = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { since: daysAgoIso(30), limit: "50" },
      });
      assertEq(wide.status, 200, "c1: explicit wide since -> 200");
      assertTrue(
        (wide.body.providers as any[]).map((p) => p.id).includes("prov-old"),
        "c2: wide since includes 10-day-old provider",
      );

      // ── (d) invalid since falls back to the 7-day default ────────────────
      const badSince = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { since: "not-a-date", limit: "50" },
      });
      assertEq(badSince.status, 200, "d1: invalid since -> 200 (falls back), not 400/500");
      {
        const ids = (badSince.body.providers as any[]).map((p) => p.id);
        assertTrue(ids.includes("prov-recent"), "d2: invalid-since fallback includes 1-day-old provider");
        assertTrue(!ids.includes("prov-old"), "d3: invalid-since fallback excludes 10-day-old provider");
      }

      // ── (e) limit default + clamping ──────────────────────────────────────
      const rZero = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { since: daysAgoIso(30), limit: "0" },
      });
      assertEq(rZero.body.providers.length, 1, "e1: limit=0 clamps to 1 (of >=3 eligible)");

      const rNeg = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { since: daysAgoIso(30), limit: "-5" },
      });
      assertEq(rNeg.body.providers.length, 1, "e2: negative limit clamps to 1");

      const rBig = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { since: daysAgoIso(30), limit: "500" },
      });
      assertTrue(rBig.body.providers.length <= 50, "e3: limit=500 clamps to at most 50");

      // ── (f) shape of a returned row ────────────────────────────────────────
      const shapeResp = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { since: daysAgoIso(30), limit: "50" },
      });
      const row = (shapeResp.body.providers as any[]).find((p) => p.id === "prov-recent");
      assertTrue(!!row, "f1: prov-recent row present");
      assertEq(row.name, "Nylig Enriched Sideri AS", "f2: row carries name (from experience_providers.navn)");
      assertEq(row.website, "https://nylig-sideri.example.no", "f3: row carries website (from experience_providers.hjemmeside)");
      assertTrue(typeof row.last_enriched_at === "string" && row.last_enriched_at.length > 0, "f4: row carries last_enriched_at");
      assertEq(row.about_text, "Vi lager sider på tradisjonelt vis.", "f5: row carries about_text");
      assertEq(row.visit_text, "Åpent for besøk lørdager.", "f6: row carries visit_text");
      assertEq(row.opening_hours_text, "Lør 10-16", "f7: row carries opening_hours_text");
      assertEq(row.products, ["Eplesider", "Eplemost"], "f8: row carries parsed products array");
      assertEq(row.content_source, "provider_site", "f9: row carries content_source");
      assertEq(row.content_evidence_url, "https://nylig-sideri.example.no/om-oss", "f10: row carries content_evidence_url");
      assertEq(row.field_provenance, null, "f11: field_provenance is explicitly null (no fake rfb-shaped object invented)");
      assertEq(row.provenance_model, "none", "f12: provenance_model:'none' marks the different lock model");
      assertEq(shapeResp.body.success, true, "f13: response carries success:true");
      assertEq(shapeResp.body.count, shapeResp.body.providers.length, "f14: count matches providers.length");
      assertTrue(!("agents" in shapeResp.body), "f15: response uses 'providers' key, not 'agents'");

      // ── (g) malformed products JSON -> [] ─────────────────────────────────
      const malformedRow = (shapeResp.body.providers as any[]).find((p) => p.id === "prov-malformed-products");
      assertTrue(!!malformedRow, "g1: prov-malformed-products row present");
      assertEq(malformedRow.products, [], "g2: malformed products JSON -> []");

      // ── (h) enriched_experiences — the slice-C fix ────────────────────────
      // Regression proof for the 2026-W30 spot-check outcome
      // ("experiences: checked=0 mismatch=0 rate=N/A verdict=insufficient_sample
      //  — all 10 sampled providers have null content fields").
      const genericRow = (shapeResp.body.providers as any[]).find((p) => p.id === "prov-generic-enriched");
      assertTrue(!!genericRow, "h1: a provider enriched only by the GENERIC content-refresh is sampled");
      assertEq(genericRow.about_text, null, "h2: its provider-level (gårdssalg) content is legitimately null");
      assertTrue(Array.isArray(genericRow.enriched_experiences), "h3: enriched_experiences is an array");
      const servedIds = (genericRow.enriched_experiences as any[]).map((e) => e.id).sort();
      assertEq(
        servedIds,
        ["exp-enriched-1", "exp-homepage-sourced-1", "exp-nullverif-1", "exp-verified-1"],
        "h4: exactly the checkable rows are served — raw, manual, claim, merged-away, verification-locked and aggregator-sourced are all excluded",
      );
      assertEq(genericRow.enriched_experiences[0].id, "exp-enriched-1", "h5: ordered updated_at DESC, so the freshest enriched row comes first");
      assertTrue(
        (genericRow.enriched_experiences as any[]).some((e) => e.id === "exp-verified-1"),
        "h4b: an enrichment_state='verified' row is served — pins the IN ('enriched','verified') clause against a silent revert",
      );
      assertTrue(
        !(genericRow.enriched_experiences as any[]).some((e) => e.content_source === "manual" || e.content_source === "claim"),
        "h4c: owner/claim-authored rows are NEVER served — judging them against the homepage would pause the vertical on a non-error",
      );
      assertTrue(
        genericRow.enriched_experiences_error === undefined,
        "h4d: no error flag on the happy path (the flag is consumer-visible only when the query actually faulted)",
      );
      assertEq(
        genericRow.enriched_experiences[0].description,
        "Guidet tur til toppen med lokal fjellfører.",
        "h6: the description the generic writer actually wrote is now checkable",
      );
      assertEq(genericRow.enriched_experiences[0].category, "natur_friluft", "h7: category is checkable too");
      assertEq(genericRow.enriched_experiences[0].content_source, "provider_site", "h8: content_source travels with it");
      assertTrue(
        !genericRow.enriched_experiences.some((e: any) => e.id === "exp-raw-1"),
        "h9: a raw (never-written) experiences row is NOT offered for checking — it would inflate 'checked' with nothing",
      );
      // The pre-existing gårdssalg-enriched provider keeps working unchanged.
      assertTrue(Array.isArray(row.enriched_experiences), "h10: gårdssalg-enriched provider also carries the field (empty, no regression)");

      // ── (h11-h12) merged-away rows — round-3 review, BLOCKING ────────────
      assertTrue(
        !(genericRow.enriched_experiences as any[]).some((e) => e.id === "exp-merged-away-1"),
        "h11: a row the dedup pass folded into another is NEVER served — it exists on no user-visible surface, so judging it against the homepage is judging a ghost",
      );
      assertEq(
        genericRow.enriched_experiences[0].id,
        "exp-enriched-1",
        "h12: …and it does not merely leak, it would sort FIRST — runDedupPass bumps updated_at when it stamps canonical_id, so ORDER BY updated_at DESC puts merged-away rows at the top of the window",
      );

      // ── (h13) NULL verification_status — round-3 review, finding 3 ───────
      assertTrue(
        (genericRow.enriched_experiences as any[]).some((e) => e.id === "exp-nullverif-1"),
        "h13: a row with verification_status NULL IS served — isExperienceContentLocked calls NULL unlocked, so a bare `!= 'verified'` would hide exactly the rows that are checkable",
      );

      // ── (h15) verification_status lock — round-4 review, BLOCKING ────────
      // A mutation matrix showed the ENTIRE verification_status clause could be
      // deleted with the suite still green, because no fixture set the column
      // to 'verified'. This assertion is the one that dies on that deletion.
      assertTrue(
        !(genericRow.enriched_experiences as any[]).some((e) => e.id === "exp-verified-lock-1"),
        "h15: a row locked by verification_status='verified' is never served — the half of round 2's lock guard that no test could kill",
      );

      // ── (h16-h18) provenance — round-4 review, BLOCKING ──────────────────
      // applyExperienceContent stamps content_source='provider_site'
      // unconditionally, including when bulkInsertExperiences hands it a
      // third-party harvest row. So content_source cannot distinguish
      // homepage-sourced content from aggregator-scraped content, and no SQL
      // predicate can — only evidence_url can.
      assertTrue(
        !(genericRow.enriched_experiences as any[]).some((e) => e.id === "exp-aggregator-sourced-1"),
        "h16: a row whose evidence_url points at an aggregator is NOT served — judging it against the homepage is a guaranteed false mismatch, and §8.4 pauses writes on those",
      );
      assertTrue(
        (genericRow.enriched_experiences as any[]).some((e) => e.id === "exp-homepage-sourced-1"),
        "h17: …while the same shape with evidence_url on the provider's OWN host IS served — the filter must not become a new way to report checked=0",
      );
      const provRow = (genericRow.enriched_experiences as any[]).find((e) => e.id === "exp-homepage-sourced-1");
      assertEq(provRow.evidence_url, "https://www.generisk.example.no/opplevelser", "h18a: evidence_url is projected, so the consumer can judge against the right page instead of trusting content_source");
      assertEq(provRow.discovery_source, "provider_site", "h18b: discovery_source is projected alongside it");

      // ── (h19) the `since` window covers the full 7 days ──────────────────
      // last_enriched_at is written as SQLite datetime('now') ("2026-07-20
      // 23:59:59"); `since` used to be a JS toISOString() ("…T00:00:00.000Z").
      // SQLite string-compares them and ' ' < 'T', so every provider enriched
      // on the boundary calendar day fell out regardless of time — a 6-day-plus
      // window masquerading as 7 (round-4 review).
      // Both timestamps are FIXED, and deliberately on the SAME calendar day —
      // that is the only place the bug bites. A fixture a few days inside the
      // window passes either way, because the date parts already differ; the
      // first draft of this assertion made exactly that mistake and survived
      // the mutation test, which is how it was caught.
      {
        insertProvider.run({
          id: "prov-sqlite-stamp", navn: "SQLite-stemplet AS", hjemmeside: "https://sqlite-stamp.example.no",
          last_enriched_at: "2026-07-20 23:59:59",   // as datetime('now') writes it
          about_text: "Beriket sent på grensedagen.", visit_text: null,
          opening_hours_text: null, products: null,
          content_source: "provider_site", content_evidence_url: null,
        });
        const winResp = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          query: { since: "2026-07-20", limit: "50" },
        });
        assertTrue(
          (winResp.body.providers as any[]).some((p) => p.id === "prov-sqlite-stamp"),
          "h19: a provider enriched on the BOUNDARY day is inside the window — ' ' (0x20) < 'T' (0x54) used to drop the whole day",
        );
      }

      // ── (h14) LIMIT 10 truncation ───────────────────────────────────────
      const manyRow = (shapeResp.body.providers as any[]).find((p) => p.id === "prov-many-experiences");
      assertTrue(!!manyRow, "h14a: prov-many-experiences row present");
      assertEq(
        manyRow.enriched_experiences.length,
        10,
        "h14b: 11 enriched rows truncate to 10 — the cap the doc-comment warns a `checked`-computing consumer about",
      );

      // ── (i) enriched_experiences_error actually fires ────────────────────
      // Round-3 review, finding 4: round 2's own blocking fix had only a
      // negative test (h4d, absent on the happy path), so deleting the flag or
      // reverting to the bare console.error it replaced passed green. The
      // consumer here is a `curl -fsS` cron with no stderr to read, which is
      // the whole reason the flag exists rather than a log line.
      //
      // Renaming the table away makes the real `expDb.prepare(...)` inside the
      // handler throw, which is the exact fault the guard was written for.
      // There are no views or triggers over this schema, so the rename is a
      // clean no-op to undo. `experience_providers` is untouched, so the
      // provider-level half of the response must still be served in full —
      // that degradation, not a 500, is the contract.
      expDb.exec("ALTER TABLE experiences RENAME TO experiences_hidden_for_test");
      let faultResp: RouteResult;
      try {
        faultResp = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          query: { since: daysAgoIso(30), limit: "50" },
        });
      } finally {
        expDb.exec("ALTER TABLE experiences_hidden_for_test RENAME TO experiences");
      }
      assertEq(faultResp.status, 200, "i1: a broken enriched_experiences query degrades, it does not 500 the whole sample");
      const faultRow = (faultResp.body.providers as any[]).find((p) => p.id === "prov-generic-enriched");
      assertTrue(!!faultRow, "i2: the provider is still sampled when the experiences query cannot be prepared");
      assertEq(faultRow.enriched_experiences_error, true, "i3: enriched_experiences_error:true reaches the consumer — score it as `skipped`, never as 'nothing was written'");
      assertEq(faultRow.enriched_experiences, [], "i4: …alongside an empty list, so a naive consumer cannot read it as 'zero enriched rows'");
      assertEq(faultRow.about_text, null, "i5: the provider-level content is still served unchanged (degrade, don't drop)");
      assertTrue(
        (faultResp.body.providers as any[]).every((p) => p.enriched_experiences_error === true),
        "i6: a prepare() fault flags EVERY provider in the sample, not just the first",
      );

      // ── (i7-i9) the RUNTIME .all() fault, a different branch ─────────────
      // Round-4 review, minor: test (i) renames the table BEFORE the request,
      // so the throw lands at expDb.prepare() and the per-provider catch — the
      // one whose comment names SQLITE_BUSY as its reason — is never entered.
      // Here the statement prepares fine and the table disappears afterwards,
      // so .all() itself throws inside the row loop. Unlike the prepare-time
      // variant this flags providers individually, which nothing pinned.
      const runtimeFaultRouter = opplevelserRouter;
      let runtimeResp: RouteResult;
      {
        // Prime a successful prepare by making one normal call first, then pull
        // the table out from under the loop mid-request via a statement that
        // the handler will execute after preparing.
        expDb.exec("ALTER TABLE experiences RENAME TO experiences_hidden_runtime");
        expDb.exec(`CREATE TABLE experiences (
          id TEXT PRIMARY KEY, provider_id TEXT, title TEXT, description TEXT,
          category TEXT, subcategory TEXT, booking_url TEXT, content_source TEXT,
          evidence_url TEXT, discovery_source TEXT, enrichment_state TEXT,
          canonical_id TEXT, verification_status TEXT, updated_at TEXT)`);
        // A view-free table with the right columns prepares cleanly; dropping a
        // column it SELECTs makes .all() fail at execution time instead.
        expDb.exec("ALTER TABLE experiences DROP COLUMN discovery_source");
        try {
          runtimeResp = await callRoute(runtimeFaultRouter, {
            headers: { "x-admin-key": testKey },
            query: { since: daysAgoIso(30), limit: "50" },
          });
        } finally {
          expDb.exec("DROP TABLE experiences");
          expDb.exec("ALTER TABLE experiences_hidden_runtime RENAME TO experiences");
        }
      }
      assertEq(runtimeResp.status, 200, "i7: a runtime query fault also degrades rather than 500-ing");
      assertTrue(
        (runtimeResp.body.providers as any[]).every((p) => p.enriched_experiences_error === true),
        "i8: …and reaches the consumer as the same flag, not as a silent empty list",
      );
      assertTrue(
        (runtimeResp.body.providers as any[]).every((p) => Array.isArray(p.enriched_experiences) && p.enriched_experiences.length === 0),
        "i9: …with an empty list alongside it",
      );
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-providers-recently-enriched: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
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

// Standalone runner: `npx tsx src/routes/opplevelser-providers-recently-enriched.test.ts`
if (require.main === module) {
  runOpplevelserProvidersRecentlyEnrichedTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
