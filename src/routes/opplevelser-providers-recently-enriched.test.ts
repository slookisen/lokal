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
    const testKey = process.env.ADMIN_KEY || "providers-recently-enriched-test-key";
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
            evidence_url, discovery_source, content_field_evidence, updated_at)
         VALUES
           (@id, @provider_id, @title, @description, @category, @subcategory, @booking_url,
            @content_source, @enrichment_state, @canonical_id, @verification_status,
            @evidence_url, @discovery_source, @content_field_evidence, @updated_at)`,
      );
      // `content_field_evidence` is a PER-FIELD map (round-6 review): the writer
      // only fills BLANK fields, so one row's fields come from different sources
      // at different times and a single row-level URL records only the last one.
      // `evidenceFor` is the shorthand for "all three judged fields came from
      // here", i.e. what the row-level column used to mean; a fixture that needs
      // mixed provenance passes `content_field_evidence` directly.
      const insertFull = (row: Record<string, unknown> & { evidenceFor?: string }) => {
        const { evidenceFor, ...rest } = row;
        const map = evidenceFor
          ? JSON.stringify({ description: evidenceFor, category: evidenceFor, booking_url: evidenceFor })
          : null;
        insertExperienceFull.run({
          evidence_url: null, discovery_source: null,
          content_field_evidence: map, ...rest,
        });
      };
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
        evidenceFor: "https://visitnorway.com/x",
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
        evidenceFor: "https://www.generisk.example.no/opplevelser",
        updated_at: daysAgoIso(4),
      });
      // Round-5 review: the filter's first version compared `evidence_url`,
      // which is DISCOVERY provenance and is never updated after insert. A row
      // discovered on an aggregator and later REWRITTEN from the provider's own
      // homepage therefore got dropped — a brand-new route to the checked=0
      // this endpoint exists to remove. It must be served.
      insertFull({
        id: "exp-rediscovered-1", provider_id: "prov-generic-enriched",
        title: "Oppdaget på DMO, innhold hentet fra egen side",
        description: "Beskrivelse hentet fra produsentens egen hjemmeside.",
        category: "natur_friluft", subcategory: null, booking_url: null,
        content_source: "provider_site", enrichment_state: "enriched",
        canonical_id: null, verification_status: "pending_verify",
        evidence_url: "https://visitnorway.com/oppdaget-her",       // stale discovery URL
        discovery_source: "visitnorway",
        evidenceFor: "https://generisk.example.no/tur",    // where the CONTENT came from
        updated_at: daysAgoIso(5),
      });
      // …and a subdomain of the provider's own site is still the provider's own
      // site. Bare-host equality dropped this; every other same-site check in
      // the repo compares registrable domains.
      insertFull({
        id: "exp-subdomain-1", provider_id: "prov-generic-enriched",
        title: "Innhold fra eget subdomene",
        description: "Beskrivelse hentet fra nettbutikken vår.",
        category: "mat_drikke", subcategory: null, booking_url: null,
        content_source: "provider_site", enrichment_state: "enriched",
        canonical_id: null, verification_status: "pending_verify",
        evidenceFor: "https://shop.generisk.example.no/produkt",
        updated_at: daysAgoIso(6),
      });
      // A provider whose OWN hjemmeside is an aggregator — documented in
      // production by dev-request 2026-07-19-agg-website-leak. Both sides of the
      // provenance comparison then match, so aggregator text is admitted and
      // judged against the aggregator page it came from, scoring `ok` and
      // INFLATING the signal. The consumer cannot see that from the rows.
      insertProvider.run({
        id: "prov-aggregator-homepage", navn: "Lekkasje Gård AS",
        hjemmeside: "https://www.visitnorway.com/gard/lekkasje",
        last_enriched_at: daysAgoIso(1),
        about_text: null, visit_text: null, opening_hours_text: null, products: null,
        content_source: null, content_evidence_url: null,
      });
      insertFull({
        id: "exp-agg-homepage-1", provider_id: "prov-aggregator-homepage",
        title: "Tekst fra DMO-siden", description: "AGGREGATOR-TEKST fra DMO-siden.",
        category: "kultur_historie", subcategory: null, booking_url: null,
        content_source: "provider_site", enrichment_state: "enriched",
        canonical_id: null, verification_status: "pending_verify",
        evidenceFor: "https://www.visitnorway.com/gard/lekkasje",
        updated_at: daysAgoIso(1),
      });
      // The filter used to run AFTER `LIMIT 10`, so a provider whose 10 freshest
      // rows were all harvest-sourced returned ZERO while good older rows
      // existed. 12 fresh aggregator-sourced rows + 2 older own-host ones.
      insertProvider.run({
        id: "prov-filter-after-limit", navn: "Mange Aggregatorrader AS",
        hjemmeside: "https://storgard.example.no",
        last_enriched_at: daysAgoIso(1),
        about_text: null, visit_text: null, opening_hours_text: null, products: null,
        content_source: null, content_evidence_url: null,
      });
      for (let i = 0; i < 12; i++) {
        insertFull({
          id: `exp-fresh-agg-${i}`, provider_id: "prov-filter-after-limit",
          title: `Aggregatorrad ${i}`, description: `AGGREGATOR-TEKST ${i}.`,
          category: "natur_friluft", subcategory: null, booking_url: null,
          content_source: "provider_site", enrichment_state: "enriched",
          canonical_id: null, verification_status: "pending_verify",
          evidenceFor: "https://visitnorway.com/x",
          updated_at: daysAgoIso(1),
        });
      }
      for (let i = 0; i < 2; i++) {
        insertFull({
          id: `exp-older-own-${i}`, provider_id: "prov-filter-after-limit",
          title: `Egen rad ${i}`, description: `Beskrivelse fra egen side ${i}.`,
          category: "natur_friluft", subcategory: null, booking_url: null,
          content_source: "provider_site", enrichment_state: "enriched",
          canonical_id: null, verification_status: "pending_verify",
          evidenceFor: "https://storgard.example.no/tur",
          updated_at: daysAgoIso(9),
        });
      }
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
        [
          "exp-enriched-1", "exp-homepage-sourced-1", "exp-nullverif-1",
          "exp-rediscovered-1", "exp-subdomain-1", "exp-verified-1",
        ],
        "h4: exactly the checkable rows are served — raw, manual, claim, merged-away, verification-locked and aggregator-CONTENT rows are all excluded",
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

      // ── (h20-h24) round-5 review: the filter was on the wrong column ─────
      assertTrue(
        (genericRow.enriched_experiences as any[]).some((e) => e.id === "exp-rediscovered-1"),
        "h20: a row DISCOVERED on an aggregator but whose CONTENT came from the homepage is served — filtering on the discovery URL hid exactly the rows enrichment had just rewritten",
      );
      assertTrue(
        (genericRow.enriched_experiences as any[]).some((e) => e.id === "exp-subdomain-1"),
        "h21: content evidence on a SUBDOMAIN of the provider's own site is own-site — compared on the registrable domain, as every other same-site check in this repo does",
      );
      const aggHomeRow = (shapeResp.body.providers as any[]).find((p) => p.id === "prov-aggregator-homepage");
      assertTrue(!!aggHomeRow, "h22a: a provider whose own hjemmeside is an aggregator is still sampled");
      assertEq(
        aggHomeRow.homepage_is_aggregator,
        true,
        "h22b: …and is flagged, because the provenance comparison cannot catch it — both sides match, so aggregator text would be judged against the aggregator page and score `ok`, inflating the signal",
      );
      assertTrue(
        genericRow.homepage_is_aggregator === undefined,
        "h22c: the flag is absent (not false) for a normal provider",
      );
      const afterLimitRow = (shapeResp.body.providers as any[]).find((p) => p.id === "prov-filter-after-limit");
      assertTrue(!!afterLimitRow, "h23a: prov-filter-after-limit present");
      assertEq(
        (afterLimitRow.enriched_experiences as any[]).map((e: any) => e.id).sort(),
        ["exp-older-own-0", "exp-older-own-1"],
        "h23b: 12 fresher aggregator-sourced rows do not starve the 2 good older ones — the filter used to run AFTER LIMIT 10 and returned zero",
      );
      assertEq(
        afterLimitRow.enriched_experiences_filtered,
        12,
        "h24: …and the count of filtered rows reaches the consumer, so an empty or short list is never read as 'enrichment wrote nothing'",
      );
      assertTrue(
        (shapeResp.body.providers as any[]).find((p) => p.id === "prov-recent")?.enriched_experiences_filtered === undefined,
        "h24b: the filtered count is absent when nothing was filtered",
      );

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

      // ── (h25-h27) mutations that survived round 5, now pinned ────────────
      // A guard whose STRICTNESS no test can kill is only half a guard: round 5
      // weakened the host comparison to a substring match and flipped the
      // NULL-homepage branch, and both left the suite green.
      //
      // h25 — substring matching must not pass. The registrable domain of the
      // evidence must CONTAIN the provider's as a substring for this to
      // discriminate: "ikke-gard.no".includes("gard.no") is true, so a
      // substring comparison admits a completely different registrant. (My
      // first attempt at this fixture used a .no-vs-.com pair whose registrable
      // domains do not overlap at all, so it passed under BOTH the correct and
      // the weakened comparison — it pinned nothing. Caught by re-running the
      // mutation, not by reading.)
      insertProvider.run({
        id: "prov-substring", navn: "Gard AS", hjemmeside: "https://gard.no",
        last_enriched_at: daysAgoIso(1),
        about_text: null, visit_text: null, opening_hours_text: null, products: null,
        content_source: null, content_evidence_url: null,
      });
      insertFull({
        id: "exp-substring-attack-1", provider_id: "prov-substring",
        title: "Domene som bare inneholder vårt",
        description: "AGGREGATOR-TEKST fra et domene som bare ligner.",
        category: "kultur_historie", subcategory: null, booking_url: null,
        content_source: "provider_site", enrichment_state: "enriched",
        canonical_id: null, verification_status: "pending_verify",
        evidenceFor: "https://ikke-gard.no/x",
        updated_at: daysAgoIso(7),
      });
      // h26 — a provider with NO hjemmeside: the verifier has nothing to compare
      // against and fetches the evidence URL itself, so the rows must be SERVED,
      // not dropped. Flipping that branch to `return false` left the suite green
      // because no fixture had a NULL hjemmeside.
      insertProvider.run({
        id: "prov-no-homepage", navn: "Uten Hjemmeside AS", hjemmeside: null,
        last_enriched_at: daysAgoIso(1),
        about_text: null, visit_text: null, opening_hours_text: null, products: null,
        content_source: null, content_evidence_url: null,
      });
      insertFull({
        id: "exp-no-homepage-1", provider_id: "prov-no-homepage",
        title: "Beriket uten registrert hjemmeside",
        description: "Beskrivelse skrevet av content-refresh via evidence_url.",
        category: "mat_drikke", subcategory: null, booking_url: null,
        content_source: "provider_site", enrichment_state: "enriched",
        canonical_id: null, verification_status: "pending_verify",
        evidenceFor: "https://en-eller-annen.example.no/side",
        updated_at: daysAgoIso(1),
      });
      const strictResp = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { since: daysAgoIso(30), limit: "50" },
      });
      const strictSub = (strictResp.body.providers as any[]).find((p) => p.id === "prov-substring");
      assertTrue(
        !!strictSub && !(strictSub.enriched_experiences as any[]).some((e) => e.id === "exp-substring-attack-1"),
        "h25: a domain that merely CONTAINS the provider's is not the provider's — pins the comparison as equality, not substring",
      );
      const noHomeRow = (strictResp.body.providers as any[]).find((p) => p.id === "prov-no-homepage");
      assertTrue(!!noHomeRow, "h26a: a provider with no hjemmeside is still sampled");
      assertTrue(
        (noHomeRow.enriched_experiences as any[]).some((e) => e.id === "exp-no-homepage-1"),
        "h26b: …and its rows are SERVED — with no homepage to compare against, dropping them would be a silent checked=0",
      );
      // h27 — the DEFAULT `since` path, not just the explicit one. Round 5
      // reverted only the default branch to raw ISO and the suite stayed green,
      // because h19 exercises ?since= only.
      {
        // On the BOUNDARY day of the DEFAULT 7-day window — one minute inside
        // it. A row comfortably inside the window has a different date part and
        // passes whatever the separator is, which is why the first version of
        // this assertion survived its own mutation.
        const sqliteNow = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 + 60 * 1000)
          .toISOString().slice(0, 19).replace("T", " ");
        insertProvider.run({
          id: "prov-default-window", navn: "Standardvindu AS", hjemmeside: "https://standardvindu.example.no",
          last_enriched_at: sqliteNow,
          about_text: "Beriket for en time siden.", visit_text: null,
          opening_hours_text: null, products: null,
          content_source: "provider_site", content_evidence_url: null,
        });
        const defResp = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          query: { limit: "50" },     // no `since` — exercises the DEFAULT path
        });
        assertTrue(
          (defResp.body.providers as any[]).some((p) => p.id === "prov-default-window"),
          "h27: a SQLite-stamped row is inside the DEFAULT 7-day window too — the default branch needs the same format as the explicit one",
        );
      }

      // ── (w1-w6) the WRITER, driven for real — round-6 review, BLOCKING ───
      // Every fixture above inserts provenance via raw SQL, so the whole write
      // half of this change survived its own deletion with the suite green:
      // dropping the `sourceUrl` argument at all three call sites, and deleting
      // the stamp itself, were all 77/0. Nothing ever called
      // applyExperienceContent. These do.
      {
        const store = require("../services/experience-store") as typeof import("../services/experience-store");
        const evidenceOf = (id: string): Record<string, string> => {
          const row = expDb.prepare("SELECT content_field_evidence FROM experiences WHERE id = ?").get(id) as
            { content_field_evidence: string | null } | undefined;
          return row?.content_field_evidence ? JSON.parse(row.content_field_evidence) : {};
        };

        // w1/w2 — the mixed-provenance sequence a row-level column got wrong in
        // BOTH directions. Harvest fills `description` from an aggregator; a
        // later homepage refresh fills a DIFFERENT, previously-blank field. The
        // description's provenance must NOT be relabelled by that second write.
        insertFull({
          id: "exp-writer-mixed-1", provider_id: "prov-generic-enriched",
          title: "Blandet proveniens", description: null, category: null, booking_url: null,
          subcategory: null, content_source: null, enrichment_state: "raw",
          canonical_id: null, verification_status: "pending_verify",
          updated_at: daysAgoIso(2),
        });
        store.applyExperienceContent("exp-writer-mixed-1",
          { description: "AGGREGATOR-TEKST om lammene." }, "https://visitnorway.com/found-here");
        store.applyExperienceContent("exp-writer-mixed-1",
          { season: ["sommer"] as any } as any, "https://generisk.example.no/");
        assertEq(
          evidenceOf("exp-writer-mixed-1").description,
          "https://visitnorway.com/found-here",
          "w1: a later homepage write of a DIFFERENT field does not relabel the aggregator description — the round-4 harm, which a row-level column reopened",
        );
        // …and the mirror: homepage first, re-harvest second.
        insertFull({
          id: "exp-writer-mixed-2", provider_id: "prov-generic-enriched",
          title: "Blandet proveniens 2", description: null, category: null, booking_url: null,
          subcategory: null, content_source: null, enrichment_state: "raw",
          canonical_id: null, verification_status: "pending_verify",
          updated_at: daysAgoIso(2),
        });
        store.applyExperienceContent("exp-writer-mixed-2",
          { description: "Ekte tekst fra egen hjemmeside." }, "https://generisk.example.no/");
        store.applyExperienceContent("exp-writer-mixed-2",
          { booking_url: "https://visitnorway.com/book/9" }, "https://visitnorway.com/found-here");
        const m2 = evidenceOf("exp-writer-mixed-2");
        assertEq(m2.description, "https://generisk.example.no/",
          "w2: …nor does a later re-harvest relabel genuine homepage content — the round-5 harm, which the same column reopened");
        assertEq(m2.booking_url, "https://visitnorway.com/found-here",
          "w3: each field records where IT came from");

        // w4 — the isBlank gate is what makes the map stable: a second write of
        // an already-filled field is a no-op, so neither the value nor its
        // recorded source moves. (This is why no "never overwrite a key" guard
        // is needed — and mutation testing showed such a guard was unreachable
        // AND wrong in the one case that could reach it.)
        store.applyExperienceContent("exp-writer-mixed-2",
          { description: "Forsøk på å skrive over." }, "https://annen.example.no/");
        const w4row = expDb.prepare("SELECT description FROM experiences WHERE id = ?")
          .get("exp-writer-mixed-2") as { description: string };
        assertEq(w4row.description, "Ekte tekst fra egen hjemmeside.", "w4a: a second write of an already-filled field does not change the value");
        assertEq(evidenceOf("exp-writer-mixed-2").description, "https://generisk.example.no/",
          "w4b: …so its recorded source does not move either");

        // w5 — a call that writes NOTHING must not stamp anything.
        const before = JSON.stringify(evidenceOf("exp-writer-mixed-2"));
        store.applyExperienceContent("exp-writer-mixed-2", { description: "igjen" }, "https://tredje.example.no/");
        assertEq(JSON.stringify(evidenceOf("exp-writer-mixed-2")), before,
          "w5: a no-op write leaves the provenance map untouched");

        // w6 — end to end: the projection blanks the aggregator-sourced field of
        // a mixed row and keeps the homepage-sourced one, rather than dropping
        // or serving the whole row.
        const wResp = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          query: { since: daysAgoIso(30), limit: "50" },
        });
        const wProv = (wResp.body.providers as any[]).find((p) => p.id === "prov-generic-enriched");
        const wRow = (wProv.enriched_experiences as any[]).find((e) => e.id === "exp-writer-mixed-2");
        assertTrue(!!wRow, "w6a: a mixed-provenance row is served, not dropped — it still has something checkable");
        assertEq(wRow.description, "Ekte tekst fra egen hjemmeside.", "w6b: the homepage-sourced field is served");
        assertEq(wRow.booking_url, null, "w6c: …and the aggregator-sourced field is blanked, so it is never judged against a page it did not come from");
        assertTrue((wProv.enriched_experiences_fields_blanked ?? 0) > 0, "w6d: the blanked-field count reaches the consumer");
      }

      // ── (w7-w11) round-7 review, BLOCKING: the fixtures did not discriminate ─
      {
        const store2 = require("../services/experience-store") as typeof import("../services/experience-store");
        const evidenceOf2 = (id: string): Record<string, string> => {
          const row = expDb.prepare("SELECT content_field_evidence FROM experiences WHERE id = ?").get(id) as
            { content_field_evidence: string | null } | undefined;
          return row?.content_field_evidence ? JSON.parse(row.content_field_evidence) : {};
        };

        // w7 — MULTI-FIELD writes. Every earlier writer test passed a candidate
        // with exactly ONE field, so `written.length === 1` throughout and
        // `evidence[written[0]] = sourceUrl` passed the whole suite. Both
        // production callers are multi-field: the content-refresh passes 8
        // candidate fields in one call and bulkInsertExperiences passes 9. A
        // regression that stamped only the first key would leave `category`
        // unstamped, read as "unknown -> keep", and served as homepage content:
        // the round-4 false-mismatch harm, re-reachable with green tests.
        insertFull({
          id: "exp-multifield-1", provider_id: "prov-generic-enriched",
          title: "Flerfeltsskriving", description: null, category: null, booking_url: null,
          subcategory: null, content_source: null, enrichment_state: "raw",
          canonical_id: null, verification_status: "pending_verify",
          updated_at: daysAgoIso(2),
        });
        store2.applyExperienceContent("exp-multifield-1", {
          description: "Tekst fra DMO.", category: "natur_friluft",
          booking_url: "https://visitnorway.com/book/1", subcategory: "fjelltur",
        }, "https://visitnorway.com/found-here");
        const mf = evidenceOf2("exp-multifield-1");
        for (const field of ["description", "category", "booking_url", "subcategory"]) {
          assertEq(mf[field], "https://visitnorway.com/found-here",
            `w7/${field}: EVERY field written in one call is stamped, not just the first`);
        }

        // w8 — the harvest sentinel. A harvest row with no evidence_url used to
        // stamp `null`, which the endpoint reads as "unknown -> keep" and serves
        // as judgeable homepage content — re-opening the round-4 leak for
        // exactly those rows. We know it is harvest-sourced even without a URL.
        // Own provider: on the shared one these rows fall outside the 10-row
        // slice, so the assertions below passed whether or not the field was
        // blanked. (Eighth non-discriminating fixture this session — caught, as
        // every one of them has been, by re-running the mutation.)
        insertProvider.run({
          id: "prov-sentinel", navn: "Sentinel AS", hjemmeside: "https://sentinel.example.no",
          last_enriched_at: daysAgoIso(1),
          about_text: null, visit_text: null, opening_hours_text: null, products: null,
          content_source: null, content_evidence_url: null,
        });
        insertFull({
          id: "exp-nosource-1", provider_id: "prov-sentinel",
          title: "Harvest uten evidence_url", description: null, category: null, booking_url: null,
          subcategory: null, content_source: null, enrichment_state: "raw",
          canonical_id: null, verification_status: "pending_verify",
          updated_at: daysAgoIso(2),
        });
        // w8 — the sentinel MECHANISM, and an honest note about its limit.
        //
        // A harvest row with no `evidence_url` used to stamp `null`. The two
        // halves that make that harmful are testable and tested here:
        //   (a) `null` stamps nothing at all, so the field has no map entry;
        //   (b) no map entry is read as "unknown" and KEPT — served to the
        //       spot-check as judgeable homepage content, which is the round-4
        //       false-mismatch harm reached one more way.
        // The sentinel closes it because a source that does not resolve to the
        // homepage is blanked rather than kept.
        //
        // What is NOT runtime-tested, stated rather than papered over: that the
        // two harvest CALL SITES pass the sentinel instead of `null`. Reaching
        // them requires the dedup matcher to fire, which needs a kommune on both
        // sides plus a provider identity — I could not construct it here without
        // a fixture more elaborate than the thing under test. That binding rests
        // on the required-parameter type and the shared constant, and a reviewer
        // should check it by reading the two call sites.
        insertFull({
          id: "exp-nullsource-1", provider_id: "prov-sentinel",
          title: "Skrevet uten kilde", description: null, category: null, booking_url: null,
          subcategory: null, content_source: null, enrichment_state: "raw",
          canonical_id: null, verification_status: "pending_verify",
          updated_at: daysAgoIso(2),
        });
        store2.applyExperienceContent("exp-nullsource-1", { description: "Tekst uten kjent kilde." }, null);
        assertEq(JSON.stringify(evidenceOf2("exp-nullsource-1")), "{}",
          "w8a: a null source stamps NOTHING — which is exactly why the harvest callers must not pass it");
        store2.applyExperienceContent("exp-nosource-1",
          { description: "AGGREGATOR-TEKST uten kilde-URL." }, store2.HARVEST_PROVENANCE_SENTINEL);
        assertEq(evidenceOf2("exp-nosource-1").description, store2.HARVEST_PROVENANCE_SENTINEL,
          "w8b: …while the sentinel IS recorded, so the field is attributable");
        const sentResp = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          query: { since: daysAgoIso(30), limit: "50" },
        });
        const sentProv = (sentResp.body.providers as any[]).find((p) => p.id === "prov-sentinel");
        assertTrue(!!sentProv, "w8c0: prov-sentinel is sampled, so the assertions below are about the slice they claim to be about");
        const sentRow = (sentProv.enriched_experiences as any[]).find((e) => e.id === "exp-nosource-1");
        // Precise, not a disjunction: `!sentRow || …` was satisfied by the row
        // being absent for ANY reason, so it passed with the guard removed too.
        // The contract is exact — this row's only judged field is blanked, so
        // nothing judgeable remains and the row is dropped.
        assertEq(sentRow, undefined,
          "w8c: a sentinel-sourced field is BLANKED, so its row is dropped — a present source that cannot be matched to the homepage is a mismatch, not an unknown");
        // The sentinel parses to a host ("harvest"), so it exercises the
        // different-domain branch. A map entry that yields NO host at all is a
        // separate branch, and it is the one that decides whether a PRESENT but
        // unusable source counts as "unknown" (kept) or "not the homepage"
        // (blanked). Keeping it was the old behavior and is the harmful reading.
        insertFull({
          id: "exp-garbagesource-1", provider_id: "prov-sentinel",
          title: "Ubrukelig kildeverdi", description: "AGGREGATOR-TEKST med ubrukelig kilde.",
          category: null, booking_url: null, subcategory: null,
          content_source: "provider_site", enrichment_state: "enriched",
          canonical_id: null, verification_status: "pending_verify",
          content_field_evidence: JSON.stringify({ description: "///" }),
          updated_at: daysAgoIso(3),
        });
        const garbResp = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          query: { since: daysAgoIso(30), limit: "50" },
        });
        const garbProv = (garbResp.body.providers as any[]).find((p) => p.id === "prov-sentinel");
        assertEq(
          (garbProv.enriched_experiences as any[]).find((e) => e.id === "exp-garbagesource-1"),
          undefined,
          "w8e: a PRESENT source that resolves to no host at all is treated as not-the-homepage and blanked — absence of an entry means unknown, an unusable entry does not",
        );
        const nullRow = (sentProv.enriched_experiences as any[]).find((e) => e.id === "exp-nullsource-1");
        assertTrue(!!nullRow && nullRow.description === "Tekst uten kjent kilde.",
          "w8d: …whereas a field with NO entry is genuinely unknown and is kept — which is what makes passing null harmful");
      }

      // ── (w12-w14) round-8 review, BLOCKING: JUDGED_FIELDS was unpinned ────
      // Every member of that list could be deleted with the suite green.
      // `booking_url` was pinned by w6c, but `description` and `category` were
      // not: w6b asserts a homepage-sourced description IS served, which stays
      // true when description is not judged at all, and w8c asserts a row is
      // DROPPED, which a removed `description` also causes — the field stops
      // counting toward `judgeable`. Both mutations were invisible.
      //
      // The shape that discriminates: one row per judged field, where THAT
      // field is aggregator-sourced and a DIFFERENT judged field is
      // homepage-sourced. The row survives (so it is not the drop path being
      // observed) and the aggregator field must come back null. Drop the field
      // from JUDGED_FIELDS and it is served instead.
      {
        const store3 = require("../services/experience-store") as typeof import("../services/experience-store");
        const evidenceOf3 = (id: string): Record<string, string> => {
          const row = expDb.prepare("SELECT content_field_evidence FROM experiences WHERE id = ?").get(id) as
            { content_field_evidence: string | null } | undefined;
          return row?.content_field_evidence ? JSON.parse(row.content_field_evidence) : {};
        };
        // Its own provider: on a crowded one these rows can fall outside the
        // 10-row slice, and then the assertions pass whether or not the field
        // was blanked — the seventh non-discriminating fixture this session was
        // exactly that.
        insertProvider.run({
          id: "prov-judged", navn: "Dømt AS", hjemmeside: "https://judged.example.no",
          last_enriched_at: daysAgoIso(1),
          about_text: null, visit_text: null, opening_hours_text: null, products: null,
          content_source: null, content_evidence_url: null,
        });
        for (const id of ["exp-judged-cat", "exp-judged-desc", "exp-judged-book"]) {
          insertFull({
            id, provider_id: "prov-judged",
            title: `Feltdom ${id}`, description: null, category: null, booking_url: null,
            subcategory: null, content_source: null, enrichment_state: "raw",
            canonical_id: null, verification_status: "pending_verify",
            updated_at: daysAgoIso(2),
          });
        }
        const HOME = "https://judged.example.no/om-oss";
        const AGG = "https://visitnorway.com/found-here";
        // category from the aggregator, description from the homepage
        store3.applyExperienceContent("exp-judged-cat", { description: "Ekte tekst fra egen side." }, HOME);
        store3.applyExperienceContent("exp-judged-cat", { category: "mat_drikke" }, AGG);
        // description from the aggregator, category from the homepage
        store3.applyExperienceContent("exp-judged-desc", { category: "natur_friluft" }, HOME);
        store3.applyExperienceContent("exp-judged-desc", { description: "AGGREGATOR-TEKST om turen." }, AGG);
        // booking_url from the aggregator, description from the homepage
        store3.applyExperienceContent("exp-judged-book", { description: "Ekte tekst nummer to." }, HOME);
        store3.applyExperienceContent("exp-judged-book", { booking_url: "https://visitnorway.com/book/77" }, AGG);

        const jResp = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          query: { since: daysAgoIso(30), limit: "50" },
        });
        const jProv = (jResp.body.providers as any[]).find((p) => p.id === "prov-judged");
        assertTrue(!!jProv, "w12a: prov-judged is sampled, so the assertions below are about the slice they claim to be about");
        const jRows = jProv.enriched_experiences as any[];

        const jCat = jRows.find((e) => e.id === "exp-judged-cat");
        assertTrue(!!jCat, "w12b: the row survives — its homepage-sourced description is still judgeable, so this is not the drop path");
        assertEq(jCat.description, "Ekte tekst fra egen side.", "w12c: the homepage-sourced field is served");
        assertEq(jCat.category, null, "w12d: an aggregator-sourced CATEGORY is blanked — drop `category` from JUDGED_FIELDS and it is served instead");

        const jDesc = jRows.find((e) => e.id === "exp-judged-desc");
        assertTrue(!!jDesc, "w13a: the row survives on its homepage-sourced category");
        assertEq(jDesc.category, "natur_friluft", "w13b: the homepage-sourced category is served");
        assertEq(jDesc.description, null, "w13c: an aggregator-sourced DESCRIPTION is blanked — drop `description` from JUDGED_FIELDS and it is served instead");

        // w14c — the map itself must not be served. It is the screen's input;
        // emitting it too hands the consumer a raw JSON string encoding the same
        // decision the blanking already made, in a different shape it would have
        // to parse and could then disagree with (round-8 review, MINOR 3).
        for (const row of jRows) {
          assertEq((row as any).content_field_evidence, undefined,
            `w14c/${row.id}: the per-field provenance map is an input to the screen, not part of the response`);
        }

        const jBook = jRows.find((e) => e.id === "exp-judged-book");
        assertTrue(!!jBook, "w14a: the row survives on its homepage-sourced description");
        assertEq(jBook.booking_url, null, "w14b: an aggregator-sourced BOOKING_URL is blanked");

        // w15 — a BLANK source string. `BulkRowSchema` declares `evidence_url`
        // as `z.string().optional().nullable()`, so "" validates and reaches the
        // writer. `??` only falls through on null/undefined, so "" was passed
        // straight through, `if (sourceUrl && …)` was falsy, nothing was
        // stamped, and the read side took the missing entry as unknown → keep →
        // the aggregator text was served as judgeable homepage content. The
        // writer now normalizes at its own boundary, so no call site can
        // reintroduce it (round-8 review, BLOCKING — the same `??`-vs-`||`
        // mistake #384 was blocked on twice, one field away).
        insertFull({
          id: "exp-blank-src", provider_id: "prov-judged",
          title: "Tom kilde-URL", description: null, category: null, booking_url: null,
          subcategory: null, content_source: null, enrichment_state: "raw",
          canonical_id: null, verification_status: "pending_verify",
          updated_at: daysAgoIso(2),
        });
        store3.applyExperienceContent("exp-blank-src", { description: "Ekte tekst tre." }, HOME);
        store3.applyExperienceContent("exp-blank-src", { category: "kultur_historie" }, "   ");
        assertEq(evidenceOf3("exp-blank-src").category, store3.BLANK_PROVENANCE_SENTINEL,
          "w15a: a blank source string is recorded as the blank sentinel, not skipped — skipping it is what let it read as unknown");
        const jResp2 = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          query: { since: daysAgoIso(30), limit: "50" },
        });
        const jProv2 = (jResp2.body.providers as any[]).find((p) => p.id === "prov-judged");
        const jBlank = (jProv2.enriched_experiences as any[]).find((e) => e.id === "exp-blank-src");
        assertTrue(!!jBlank, "w15b: the row survives on its homepage-sourced description");
        assertEq(jBlank.category, null,
          "w15c: …and the blank-sourced field is BLANKED, not served — the whole point of stamping it");

        // w16 — the harvest CALL SITE, driven for real. The previous round
        // stated plainly that this binding was untested and rested on the
        // required-parameter type plus a shared constant, and asked a reviewer
        // to check it by reading (round-8 review, MINOR 2/4). It is reachable
        // after all: bulkInsertExperiences() is an ordinary exported function,
        // and its dedup branch needs only a provider, a kommune on both sides,
        // and a candidate that outscores the existing row.
        //
        // This is what makes `?.trim() ||` at the call site falsifiable. The
        // writer's own boundary normalization already stops "" from skipping
        // the stamp, so reverting the call site to `??` no longer leaks — but
        // it does mislabel harvest content as unknown-blank, and provenance
        // that lies about where content came from is what these three rounds
        // have been about.
        insertProvider.run({
          id: "prov-harvest-site", navn: "Harvest Kallested AS", hjemmeside: "https://harvestkall.example.no",
          last_enriched_at: daysAgoIso(1),
          about_text: null, visit_text: null, opening_hours_text: null, products: null,
          content_source: null, content_evidence_url: null,
        });
        // Its own INSERT: the shared insertFull() has a fixed column list with
        // no `kommune`, and the dedup matcher needs one on BOTH sides.
        const insertWithKommune = expDb.prepare(
          `INSERT INTO experiences
             (id, provider_id, title, description, category, subcategory, booking_url,
              kommune, content_source, enrichment_state, canonical_id, verification_status,
              evidence_url, discovery_source, content_field_evidence, updated_at)
           VALUES
             (@id, @provider_id, @title, NULL, NULL, NULL, NULL,
              @kommune, NULL, 'raw', NULL, 'pending_verify',
              NULL, NULL, NULL, @updated_at)`,
        );
        // A DISTINCT title per case: the matcher keys on provider + kommune +
        // fuzzy title, so three cases sharing one title all matched the first
        // row — which the previous case had already enriched, so the candidate
        // no longer outscored it and the branch under test was never entered.
        // (w16a passed; w16b/w16c failed for that reason, not the real one.)
        const seedThin = (id: string, title: string) => {
          insertWithKommune.run({
            id, provider_id: "prov-harvest-site",
            title, kommune: "Voss", updated_at: daysAgoIso(2),
          });
        };
        const richer = (title: string, evidence_url: string | null | undefined) => ({
          provider_id: "prov-harvest-site",
          title,
          kommune: "Voss",
          category: "mat_drikke",
          subcategory: "gardsbesok",
          season: ["sommer"],
          indoor_outdoor: "outdoor",
          duration_min: 90,
          ...(evidence_url === undefined ? {} : { evidence_url }),
        });

        // The decision itself, directly. Both harvest call sites now call this
        // one function, so it is the rule — and it is falsifiable without a
        // route harness. What remains unverified at runtime, stated rather than
        // implied: that the bulk-load ROUTE's call site calls it. Reaching that
        // one needs a Brreg-mocking HTTP harness larger than the thing under
        // test; it is one readable line, and it can no longer hold a different
        // expression than the tested site because there is only one expression.
        assertEq(store3.harvestProvenanceOf(""), store3.HARVEST_PROVENANCE_SENTINEL,
          "w16-unit-a: a blank evidence_url yields the harvest sentinel — `??` would yield \"\"");
        assertEq(store3.harvestProvenanceOf("   "), store3.HARVEST_PROVENANCE_SENTINEL,
          "w16-unit-b: …and so does a whitespace-only one");
        assertEq(store3.harvestProvenanceOf(undefined), store3.HARVEST_PROVENANCE_SENTINEL,
          "w16-unit-c: …and an absent one");
        assertEq(store3.harvestProvenanceOf(null), store3.HARVEST_PROVENANCE_SENTINEL,
          "w16-unit-d: …and an explicit null");
        assertEq(store3.harvestProvenanceOf("https://visitnorway.com/listing/5"),
          "https://visitnorway.com/listing/5",
          "w16-unit-e: …while a real URL is returned as itself");

        seedThin("exp-harvest-blank", "Guidet gårdstur");
        store3.bulkInsertExperiences([richer("Guidet gårdstur", "") as any]);
        assertEq(evidenceOf3("exp-harvest-blank").category, store3.HARVEST_PROVENANCE_SENTINEL,
          "w16a: a harvest row whose evidence_url is BLANK is stamped as harvest-sourced — `??` passes \"\" straight through and mislabels it");

        seedThin("exp-harvest-absent", "Kveldsfiske i fjorden");
        store3.bulkInsertExperiences([richer("Kveldsfiske i fjorden", undefined) as any]);
        assertEq(evidenceOf3("exp-harvest-absent").category, store3.HARVEST_PROVENANCE_SENTINEL,
          "w16b: …and so is one with no evidence_url at all");

        seedThin("exp-harvest-real", "Ostesmaking på setra");
        store3.bulkInsertExperiences([richer("Ostesmaking på setra", "https://visitnorway.com/listing/5") as any]);
        assertEq(evidenceOf3("exp-harvest-real").category, "https://visitnorway.com/listing/5",
          "w16c: …while a real evidence_url is recorded as itself, so the sentinel is not swallowing every case");
      }

      // ── (h28) window_exhausted — round-7 review, BLOCKING: untested ───────
      // Deleting the flag entirely left the full suite green, yet A2A §8.3 tells
      // the cron to branch on it ("score `skipped`, never `checked=0`"). More
      // rows than the read window, almost all screened out.
      {
        insertProvider.run({
          id: "prov-window", navn: "Over Vinduet AS", hjemmeside: "https://overvinduet.example.no",
          last_enriched_at: daysAgoIso(1),
          about_text: null, visit_text: null, opening_hours_text: null, products: null,
          content_source: null, content_evidence_url: null,
        });
        for (let i = 0; i < 60; i++) {
          insertFull({
            id: `exp-win-${i}`, provider_id: "prov-window",
            title: `Rad ${i}`, description: `AGGREGATOR-TEKST ${i}.`,
            category: "natur_friluft", subcategory: null, booking_url: null,
            content_source: "provider_site", enrichment_state: "enriched",
            canonical_id: null, verification_status: "pending_verify",
            evidenceFor: "https://visitnorway.com/x",
            updated_at: daysAgoIso(1),
          });
        }
        const winResp2 = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          query: { since: daysAgoIso(30), limit: "50" },
        });
        const winRow = (winResp2.body.providers as any[]).find((p) => p.id === "prov-window");
        assertTrue(!!winRow, "h28a: prov-window is sampled");
        assertEq(winRow.enriched_experiences_window_exhausted, true,
          "h28b: more rows than the read window, and fewer than 10 survived — the consumer must score `skipped`, never checked=0");
        assertTrue(
          (shapeResp.body.providers as any[]).find((p) => p.id === "prov-generic-enriched")?.enriched_experiences_window_exhausted === undefined,
          "h28c: …and the flag is absent (not false) for a provider inside the window",
        );
        // h28d — EXACTLY the window size, with almost nothing surviving. "The
        // window filled" is not "there are more rows": A2A §8.3 tells the cron
        // to score the whole provider `skipped` on this flag, so over-triggering
        // throws away judgeable rows and can manufacture the very `checked=0`
        // this change exists to remove. My first fixture used 60 rows, where
        // both `>=` and `>` are true — it survived its own mutation.
        insertProvider.run({
          id: "prov-exact-window", navn: "Nøyaktig Vindu AS", hjemmeside: "https://noyaktig.example.no",
          last_enriched_at: daysAgoIso(1),
          about_text: null, visit_text: null, opening_hours_text: null, products: null,
          content_source: null, content_evidence_url: null,
        });
        for (let i = 0; i < 50; i++) {
          insertFull({
            id: `exp-exact-${i}`, provider_id: "prov-exact-window",
            title: `Rad ${i}`, description: `AGGREGATOR-TEKST ${i}.`,
            category: "natur_friluft", subcategory: null, booking_url: null,
            content_source: "provider_site", enrichment_state: "enriched",
            canonical_id: null, verification_status: "pending_verify",
            evidenceFor: "https://visitnorway.com/x",
            updated_at: daysAgoIso(1),
          });
        }
        const exactResp = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          query: { since: daysAgoIso(30), limit: "50" },
        });
        const exactRow = (exactResp.body.providers as any[]).find((p) => p.id === "prov-exact-window");
        assertTrue(!!exactRow, "h28d1: prov-exact-window is sampled");
        assertTrue(
          exactRow.enriched_experiences_window_exhausted === undefined,
          "h28d2: EXACTLY the window size does not set the flag — the window filling is not evidence that more rows exist",
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
