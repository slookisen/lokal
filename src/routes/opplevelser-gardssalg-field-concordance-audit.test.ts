/**
 * opplevelser-gardssalg-field-concordance-audit.test.ts — route-level tests
 * for orchestrator dev-request 2026-08-03-gardssalg-field-concordance:
 *
 *   GET /admin/gardssalg-field-concordance-audit
 *
 * For every producer in the verified drink-producer cohort (the SAME
 * provider-id set GET /admin/gardssalg-verified-drinkproducer-cohort
 * computes), compares epost/telefon/mobil/adresse/postnummer/poststed/
 * opening_hours_text against what's actually findable on the producer's own
 * already-verified homepage, and reports a per-field verdict:
 * bekreftet / avvik / ikke_funnet_på_siden. Zero writes anywhere.
 *
 * Mirrors opplevelser-gardssalg-website-verification.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * gardssalg-field-concordance + opplevelser router per run, callRoute()
 * exercising router.handle() directly with X-Admin-Key via headers, and
 * mocks globalThis.fetch keyed by hostname for the underlying
 * crFetchGardssalgContent crawl — same mocking convention, since this route
 * reuses that SAME fetcher).
 *
 * Covers:
 *   (a) 403 without X-Admin-Key, 403 with wrong X-Admin-Key
 *   (b) full-cohort run: a provider whose stored fields ALL verbatim-match
 *       the fetched page -> every field bekreftet
 *   (c) avvik fixture: epost/telefon/mobil stored values differ from what's
 *       extracted from the page -> avvik with correct current/found; the
 *       four presence-only fields (adresse/postnummer/poststed/
 *       opening_hours_text) never produce avvik (verdict space excludes it)
 *   (d) fetch failure (simulated 500) -> EVERY field for that provider
 *       verdicts ikke_funnet_på_siden, zero crash/throw
 *   (e) provider with a blank hjemmeside -> fails closed the same way as a
 *       fetch failure (never fetched, never crashes)
 *   (f) all-blank stored fields -> every field ikke_funnet_på_siden even
 *       though the page has real content (nothing stored to confirm)
 *   (g) cohort membership: an unverified drink-producer row is excluded
 *       from the cohort — never fetched, never appears in the response. A
 *       non-drink producer_type (bakeri, a recognised NON_DRINK_PRODUCER_
 *       TYPE) IS now included per the widened cohort (see g2 below) — this
 *       reflects the widening, not a regression.
 *   (g2) cohort widening (dev-request 2026-08-08-gardssalg-epost-korreksjon-
 *       utvidelse, criterion 1): an rfb-seed row with producer_type IS NULL
 *       but a verified hjemmeside now IS included (was previously excluded
 *       when the cohort was drink-producer-type-only); a genuinely
 *       non-gårdssalg row (no producer_type, no rfb_seed_source) is still
 *       excluded even with a verified hjemmeside (regression guard against
 *       "audit everything"); a producer_type = 'test-gardssalg' row is still
 *       excluded even with a verified hjemmeside; a catalog_hidden=1 rfb-seed
 *       row with a verified hjemmeside IS included (hidden rows are now in
 *       scope, not just visible ones)
 *   (h) providerIds filter: comma-separated query narrows to a subset;
 *       repeated-key (array) form is also accepted; an id outside the
 *       cohort is silently absent (never crashes the rest of the batch);
 *       duplicate ids collapse to one entry
 *   (i) validation: blank providerIds -> 400; >200 ids -> 400; exactly 200
 *       -> processed (querying an empty/no-op subset, still 200)
 *   (j) response shape: summary counts every verdict across the whole
 *       batch, one sub-object per field
 *   (k) zero writes anywhere — a full DB dump of experience_providers is
 *       byte-identical before and after the call
 *   (l) review fix-up (2026-08-08, unbounded-scan risk): `limit`/`offset`
 *       pagination — no params -> byte-identical to (b)/(j)'s unpaginated
 *       response shape (no `pagination` key at all); `limit` over the cap
 *       -> 400, never silently clamped; `offset` without `limit` -> 400;
 *       non-positive/non-integer `limit`, negative/non-integer `offset` ->
 *       400; a valid `limit`+`offset` returns exactly that page (in stable
 *       `ORDER BY id` order) AND — proven via a fetch-mock call-count
 *       assertion, not just response contents — rows outside the page never
 *       trigger a homepage fetch at all; `pagination`
 *       ({total, offset, limit, returned, next_offset}) present only when
 *       `limit` is supplied
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
    url?: string;
    headers?: Record<string, string>;
    query?: Record<string, unknown>;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const url = opts.url || "/admin/gardssalg-field-concordance-audit";
    const [pathOnly, queryString] = url.split("?");
    const query: Record<string, unknown> = opts.query ? { ...opts.query } : {};
    if (queryString) {
      for (const [k, v] of new URLSearchParams(queryString)) query[k] = v;
    }
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: pathOnly,
      query,
      headers: opts.headers || {},
      body: {},
      get() {
        return undefined;
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
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runOpplevelserGardssalgFieldConcordanceAuditTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-field-concordance-audit-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const concordanceServicePath = require.resolve("../services/gardssalg-field-concordance");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, concordanceServicePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, epost, telefon, mobil, adresse, postnummer, poststed,
            opening_hours_text, producer_type, rfb_seed_source, catalog_hidden, field_provenance,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @epost, @telefon, @mobil, @adresse, @postnummer, @poststed,
            @opening_hours_text, @producer_type, @rfb_seed_source, @catalog_hidden, @field_provenance,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      const VERIFIED_STAMP = JSON.stringify({
        hjemmeside_verification: { verified: true, classification: "verified" },
      });

      // ── (b) full match — every stored field appears verbatim on page ────
      insertProvider.run({
        id: "prov-full-match",
        navn: "Sidergarden Fullmatch",
        hjemmeside: "https://sidergarden-fullmatch.example.no",
        epost: "post@sidergarden.no",
        telefon: "91234567",
        mobil: "99887766",
        adresse: "Gardsveien 12",
        postnummer: "5750",
        poststed: "Odda",
        opening_hours_text: "Ma-Fr 10-16",
        producer_type: "sideri",
        rfb_seed_source: null,
        catalog_hidden: 0,
        field_provenance: VERIFIED_STAMP,
      });

      // ── (c) avvik — stored epost/telefon/mobil all differ from page ─────
      insertProvider.run({
        id: "prov-avvik",
        navn: "Bryggeriet Avvik",
        hjemmeside: "https://bryggeriet-avvik.example.no",
        epost: "gammel@avvikgard.no",
        telefon: "90000001",
        mobil: "90000002",
        adresse: "Fjellveien 3",
        postnummer: "6100",
        poststed: "Volda",
        opening_hours_text: "Man-Fre 09-15",
        producer_type: "bryggeri",
        rfb_seed_source: null,
        catalog_hidden: 0,
        field_provenance: VERIFIED_STAMP,
      });

      // ── (d) fetch failure (simulated 500) ────────────────────────────────
      insertProvider.run({
        id: "prov-fetch-fail",
        navn: "Vingård Utilgjengelig",
        hjemmeside: "https://vingard-utilgjengelig.example.no",
        epost: "post@utilgjengelig.no",
        telefon: "91112233",
        mobil: null,
        adresse: "Vinveien 1",
        postnummer: "4100",
        poststed: "Jørpeland",
        opening_hours_text: "Lø 11-15",
        producer_type: "vingård",
        rfb_seed_source: null,
        catalog_hidden: 0,
        field_provenance: VERIFIED_STAMP,
      });

      // ── (e) blank hjemmeside — never fetched, fails closed like (d) ──────
      insertProvider.run({
        id: "prov-no-website",
        navn: "Destilleri Uten Nettside",
        hjemmeside: null,
        epost: "post@utensted.no",
        telefon: "92223344",
        mobil: null,
        adresse: "Et sted 4",
        postnummer: "3000",
        poststed: "Drammen",
        opening_hours_text: "Alle dager 10-18",
        producer_type: "destilleri",
        rfb_seed_source: null,
        catalog_hidden: 0,
        field_provenance: VERIFIED_STAMP,
      });

      // ── (f) all stored fields blank — nothing to confirm, even though the
      //     page has real content ───────────────────────────────────────────
      insertProvider.run({
        id: "prov-blank-fields",
        navn: "Mjøderi Tomme Felt",
        hjemmeside: "https://mjoderi-tommefelt.example.no",
        epost: null,
        telefon: null,
        mobil: null,
        adresse: null,
        postnummer: null,
        poststed: null,
        opening_hours_text: null,
        producer_type: "mjøderi",
        rfb_seed_source: null,
        catalog_hidden: 0,
        field_provenance: VERIFIED_STAMP,
      });

      // ── (g) cohort-membership ─────────────────────────────────────────────
      // "bakeri" is a recognised NON_DRINK_PRODUCER_TYPE (route-corridor-
      // service.ts) — a real gårdssalg producer type, just not a drink one.
      // Under the OLD (pre-widening) drink-producer-type-only cohort this
      // row was excluded; under the WIDENED "all gårdssalg" cohort
      // (producer_type IS NOT NULL is sufficient, regardless of WHICH
      // producer_type) it is now correctly INCLUDED — this is the intended
      // effect of criterion 1, not a regression. See g2/g4 below.
      insertProvider.run({
        id: "prov-bakeri",
        navn: "Bakeriet Nå I Kohort",
        hjemmeside: "https://bakeriet-utenfor.example.no",
        epost: "post@bakeriet.no",
        telefon: null,
        mobil: null,
        adresse: null,
        postnummer: null,
        poststed: null,
        opening_hours_text: null,
        producer_type: "bakeri", // non-drink gårdssalg producer type
        rfb_seed_source: null,
        catalog_hidden: 0,
        field_provenance: VERIFIED_STAMP,
      });
      insertProvider.run({
        id: "prov-unverified",
        navn: "Sideri Uverifisert",
        hjemmeside: "https://sideri-uverifisert.example.no",
        epost: "post@uverifisert.no",
        telefon: null,
        mobil: null,
        adresse: null,
        postnummer: null,
        poststed: null,
        opening_hours_text: null,
        producer_type: "sideri",
        rfb_seed_source: null,
        catalog_hidden: 0,
        field_provenance: null, // never verified -> excluded from cohort
      });

      // ── (g2) cohort widening (dev-request 2026-08-08-gardssalg-epost-
      //     korreksjon-utvidelse, criterion 1) ─────────────────────────────

      // rfb-seed row, producer_type IS NULL, verified hjemmeside -> NOW
      // included (the dev-request's own stated acceptance test).
      insertProvider.run({
        id: "prov-rfbseed-nullptype",
        navn: "Rfb-seed Uten Producertype",
        hjemmeside: "https://rfbseed-nullptype.example.no",
        epost: "post@rfbseednull.no",
        telefon: "93334455",
        mobil: null,
        adresse: "Fjordveien 7",
        postnummer: "2000",
        poststed: "Lillestrøm",
        opening_hours_text: "Lø 10-14",
        producer_type: null,
        rfb_seed_source: "rfb-seed",
        catalog_hidden: 0,
        field_provenance: VERIFIED_STAMP,
      });

      // Genuinely outside gårdssalg entirely — no producer_type, no
      // rfb_seed_source — must stay excluded even with a verified
      // hjemmeside (regression guard: not "audit everything").
      insertProvider.run({
        id: "prov-non-gardssalg",
        navn: "Ren Opplevelse Utenfor Gårdssalg",
        hjemmeside: "https://ikke-gardssalg.example.no",
        epost: "post@ikkegardssalg.no",
        telefon: null,
        mobil: null,
        adresse: null,
        postnummer: null,
        poststed: null,
        opening_hours_text: null,
        producer_type: null,
        rfb_seed_source: null,
        catalog_hidden: 0,
        field_provenance: VERIFIED_STAMP,
      });

      // producer_type = 'test-gardssalg' — still excluded even with a
      // verified hjemmeside (regression guard on the existing synthetic-
      // fixture exclusion).
      insertProvider.run({
        id: "prov-test-gardssalg",
        navn: "Synthetic Test Provider",
        hjemmeside: "https://test-gardssalg-fixture.example.no",
        epost: "post@testgardssalg.no",
        telefon: null,
        mobil: null,
        adresse: null,
        postnummer: null,
        poststed: null,
        opening_hours_text: null,
        producer_type: "test-gardssalg",
        rfb_seed_source: null,
        catalog_hidden: 0,
        field_provenance: VERIFIED_STAMP,
      });

      // catalog_hidden=1, rfb-seed, verified hjemmeside -> IS included
      // (hidden rows are now in scope, not just visible ones — the endpoint
      // has never filtered on catalog_hidden, and the widened cohort
      // explicitly covers both).
      insertProvider.run({
        id: "prov-hidden-rfbseed",
        navn: "Skjult Rfb-seed",
        hjemmeside: "https://skjult-rfbseed.example.no",
        epost: "post@skjultrfbseed.no",
        telefon: "94445566",
        mobil: null,
        adresse: "Skogveien 9",
        postnummer: "7000",
        poststed: "Trondheim",
        opening_hours_text: "Etter avtale",
        producer_type: null,
        rfb_seed_source: "rfb-seed",
        catalog_hidden: 1,
        field_provenance: VERIFIED_STAMP,
      });

      // ── DB snapshot BEFORE any route call (zero-writes proof, section k) ─
      const dumpProviders = () =>
        (expDb.prepare(`SELECT * FROM experience_providers ORDER BY id`).all() as unknown[]).map((r) =>
          JSON.stringify(r),
        );
      const beforeDump = dumpProviders();

      let fetchCallCount = 0;
      const fetchedHosts: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        fetchCallCount++;
        const host = new URL(urlStr).hostname;
        fetchedHosts.push(host);

        if (host === "sidergarden-fullmatch.example.no") {
          const html = `<html><body><p>Sidergarden — velkommen til smaking.</p>
            <p>Kontakt oss: post@sidergarden.no eller ring 912 34 567 / 998 87 766.</p>
            <p>Adresse: Gardsveien 12, 5750 Odda.</p>
            <p>Åpningstider: Ma-Fr 10-16.</p></body></html>`;
          return {
            ok: true, status: 200, text: async () => html,
            arrayBuffer: async () => new TextEncoder().encode(html).buffer,
            headers: { get: () => null }, url: urlStr,
          } as unknown as Response;
        }
        if (host === "bryggeriet-avvik.example.no") {
          // A DIFFERENT email and DIFFERENT phone numbers than what's stored
          // — the classic avvik fixture. No address/postnr/poststed/opening
          // hours at all, so those four fields fall to ikke_funnet_på_siden.
          const html = `<html><body><p>Bryggeriet — kontakt: ny@avvikgard.no</p>
            <p>Ring 900 00 009 (dagtid) eller 900 00 008 (kveld).</p></body></html>`;
          return {
            ok: true, status: 200, text: async () => html,
            arrayBuffer: async () => new TextEncoder().encode(html).buffer,
            headers: { get: () => null }, url: urlStr,
          } as unknown as Response;
        }
        if (host === "vingard-utilgjengelig.example.no") {
          // Simulated 500 — must classify every field ikke_funnet_på_siden,
          // never throw, never crash the rest of the batch.
          return {
            ok: false, status: 500, statusText: "Internal Server Error", text: async () => "",
            arrayBuffer: async () => new ArrayBuffer(0),
            headers: { get: () => null }, url: urlStr,
          } as unknown as Response;
        }
        if (host === "mjoderi-tommefelt.example.no") {
          const html = `<html><body><p>Mjøderiet har alt innhold likevel: post@mjoderigard.no, 900 11 223.</p></body></html>`;
          return {
            ok: true, status: 200, text: async () => html,
            arrayBuffer: async () => new TextEncoder().encode(html).buffer,
            headers: { get: () => null }, url: urlStr,
          } as unknown as Response;
        }
        if (host === "rfbseed-nullptype.example.no") {
          // (g2) widened-cohort fixture: producer_type IS NULL, rfb-seed —
          // full match, every field bekreftet.
          const html = `<html><body><p>Kontakt: post@rfbseednull.no, ring 933 34 455.</p>
            <p>Adresse: Fjordveien 7, 2000 Lillestrøm.</p>
            <p>Åpningstider: Lø 10-14.</p></body></html>`;
          return {
            ok: true, status: 200, text: async () => html,
            arrayBuffer: async () => new TextEncoder().encode(html).buffer,
            headers: { get: () => null }, url: urlStr,
          } as unknown as Response;
        }
        if (host === "skjult-rfbseed.example.no") {
          // (g2) widened-cohort fixture: catalog_hidden=1, rfb-seed — full
          // match, every field bekreftet. Hidden rows are now in scope.
          const html = `<html><body><p>Kontakt: post@skjultrfbseed.no, ring 944 45 566.</p>
            <p>Adresse: Skogveien 9, 7000 Trondheim.</p>
            <p>Åpningstider: Etter avtale.</p></body></html>`;
          return {
            ok: true, status: 200, text: async () => html,
            arrayBuffer: async () => new TextEncoder().encode(html).buffer,
            headers: { get: () => null }, url: urlStr,
          } as unknown as Response;
        }
        // Should never be reached — bakeriet/uverifisert/non-gardssalg/
        // test-gardssalg are excluded from the cohort and prov-no-website
        // has no hjemmeside to fetch.
        return {
          ok: false, status: 404, statusText: "Not Found", text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          headers: { get: () => null }, url: urlStr,
        } as unknown as Response;
      }) as typeof fetch;

      // ── (a) auth gate ─────────────────────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter);
      assertEq(noKey.status, 403, "a1: GET without X-Admin-Key -> 403");
      assertTrue(!noKey.body?.providers, "a2: no-key response carries no payload");

      const badKey = await callRoute(opplevelserRouter, { headers: { "x-admin-key": "wrong-key" } });
      assertEq(badKey.status, 403, "a3: GET with wrong X-Admin-Key -> 403");

      const authHeaders = { "x-admin-key": testKey };

      // ── full-cohort run ──────────────────────────────────────────────────
      const full = await callRoute(opplevelserRouter, { headers: authHeaders });
      assertEq(full.status, 200, "full1: full-cohort GET -> 200");
      assertEq(full.body.success, true, "full2: success:true");
      const providers: any[] = full.body.providers;
      assertTrue(Array.isArray(providers), "full3: providers is an array");

      // ── (g) cohort membership — unverified excluded; bakeri (non-drink
      //     producer_type) now included per the widened cohort ─────────────
      assertEq(providers.length, 8, "g1: exactly 8 cohort members (unverified + non-gardssalg + test-gardssalg excluded; bakeri now included)");
      assertTrue(providers.some((p) => p.provider_id === "prov-bakeri"), "g2: non-drink producer_type (bakeri) IS now in the cohort (widened cohort — see g2w below)");
      assertTrue(!providers.some((p) => p.provider_id === "prov-unverified"), "g3: unverified drink producer never appears");
      assertTrue(fetchedHosts.includes("bakeriet-utenfor.example.no"), "g4: now-included bakeri homepage IS fetched");
      assertTrue(!fetchedHosts.includes("sideri-uverifisert.example.no"), "g5: excluded unverified homepage never fetched");

      // ── (g2) cohort widening (dev-request 2026-08-08-gardssalg-epost-
      //     korreksjon-utvidelse, criterion 1) ─────────────────────────────
      assertTrue(
        providers.some((p) => p.provider_id === "prov-rfbseed-nullptype"),
        "g2w1: rfb-seed row with producer_type IS NULL and a verified hjemmeside NOW is in the cohort",
      );
      const rfbSeedNullType = providers.find((p) => p.provider_id === "prov-rfbseed-nullptype");
      assertEq(rfbSeedNullType.epost, { verdict: "bekreftet", current: "post@rfbseednull.no", found: "post@rfbseednull.no" }, "g2w2: rfb-seed-null-producer-type row scanned correctly (epost bekreftet)");

      assertTrue(
        !providers.some((p) => p.provider_id === "prov-non-gardssalg"),
        "g2w3: a row with no producer_type AND no rfb_seed_source stays excluded (regression guard — not \"audit everything\")",
      );
      assertTrue(!fetchedHosts.includes("ikke-gardssalg.example.no"), "g2w4: excluded non-gardssalg homepage never fetched");

      assertTrue(
        !providers.some((p) => p.provider_id === "prov-test-gardssalg"),
        "g2w5: producer_type = 'test-gardssalg' stays excluded even with a verified hjemmeside",
      );
      assertTrue(!fetchedHosts.includes("test-gardssalg-fixture.example.no"), "g2w6: excluded test-gardssalg homepage never fetched");

      assertTrue(
        providers.some((p) => p.provider_id === "prov-hidden-rfbseed"),
        "g2w7: catalog_hidden=1 row with a verified hjemmeside IS included (hidden rows now in scope)",
      );
      const hiddenRfbSeed = providers.find((p) => p.provider_id === "prov-hidden-rfbseed");
      assertEq(hiddenRfbSeed.epost, { verdict: "bekreftet", current: "post@skjultrfbseed.no", found: "post@skjultrfbseed.no" }, "g2w8: hidden rfb-seed row scanned correctly (epost bekreftet)");

      // ── (b) full match -> every field bekreftet ──────────────────────────
      const fullMatch = providers.find((p) => p.provider_id === "prov-full-match");
      assertTrue(!!fullMatch, "b1: prov-full-match present");
      assertEq(fullMatch.provider_name, "Sidergarden Fullmatch", "b2: provider_name passthrough");
      assertEq(fullMatch.epost, { verdict: "bekreftet", current: "post@sidergarden.no", found: "post@sidergarden.no" }, "b3: epost bekreftet");
      assertEq(fullMatch.telefon.verdict, "bekreftet", "b4: telefon bekreftet");
      assertEq(fullMatch.mobil.verdict, "bekreftet", "b5: mobil bekreftet");
      assertEq(fullMatch.adresse, { verdict: "bekreftet" }, "b6: adresse bekreftet, presence-only shape (no current/found keys)");
      assertEq(fullMatch.postnummer, { verdict: "bekreftet" }, "b7: postnummer bekreftet");
      assertEq(fullMatch.poststed, { verdict: "bekreftet" }, "b8: poststed bekreftet");
      assertEq(fullMatch.opening_hours_text, { verdict: "bekreftet" }, "b9: opening_hours_text bekreftet");

      // ── (c) avvik fixture ─────────────────────────────────────────────────
      const avvik = providers.find((p) => p.provider_id === "prov-avvik");
      assertTrue(!!avvik, "c1: prov-avvik present");
      assertEq(avvik.epost, { verdict: "avvik", current: "gammel@avvikgard.no", found: "ny@avvikgard.no" }, "c2: epost avvik with correct current/found");
      // telefon and mobil both scan the SAME page text independently; the
      // page's first extracted phone run (90000009) differs from BOTH
      // stored numbers, so both fields correctly surface it as `found` —
      // the algorithm picks "the first candidate that differs from THIS
      // field's own stored value", with no cross-field exclusion required
      // by spec.
      assertEq(avvik.telefon, { verdict: "avvik", current: "90000001", found: "90000009" }, "c3: telefon avvik with correct current/found");
      assertEq(avvik.mobil, { verdict: "avvik", current: "90000002", found: "90000009" }, "c4: mobil avvik with correct current/found");
      assertEq(avvik.adresse.verdict, "ikke_funnet_på_siden", "c5: adresse not on the avvik page -> ikke_funnet_på_siden (never avvik)");
      assertEq(avvik.postnummer.verdict, "ikke_funnet_på_siden", "c6: postnummer not on page -> ikke_funnet_på_siden (never avvik)");
      assertEq(avvik.poststed.verdict, "ikke_funnet_på_siden", "c7: poststed not on page -> ikke_funnet_på_siden (never avvik)");
      assertEq(avvik.opening_hours_text.verdict, "ikke_funnet_på_siden", "c8: opening_hours_text not on page -> ikke_funnet_på_siden (never avvik)");

      // ── (d) fetch failure -> every field ikke_funnet_på_siden ────────────
      const fetchFail = providers.find((p) => p.provider_id === "prov-fetch-fail");
      assertTrue(!!fetchFail, "d1: prov-fetch-fail present");
      assertEq(fetchFail.epost, { verdict: "ikke_funnet_på_siden", current: "post@utilgjengelig.no", found: null }, "d2: epost fails closed with current still carried, found null");
      assertEq(fetchFail.telefon.verdict, "ikke_funnet_på_siden", "d3: telefon fails closed");
      assertEq(fetchFail.mobil, { verdict: "ikke_funnet_på_siden", current: null, found: null }, "d4: mobil (blank stored) fails closed, current null");
      assertEq(fetchFail.adresse, { verdict: "ikke_funnet_på_siden" }, "d5: adresse fails closed");
      assertEq(fetchFail.postnummer, { verdict: "ikke_funnet_på_siden" }, "d6: postnummer fails closed");
      assertEq(fetchFail.poststed, { verdict: "ikke_funnet_på_siden" }, "d7: poststed fails closed");
      assertEq(fetchFail.opening_hours_text, { verdict: "ikke_funnet_på_siden" }, "d8: opening_hours_text fails closed");

      // ── (e) blank hjemmeside -> never fetched, fails closed ──────────────
      const noWebsite = providers.find((p) => p.provider_id === "prov-no-website");
      assertTrue(!!noWebsite, "e1: prov-no-website present");
      assertEq(noWebsite.epost.verdict, "ikke_funnet_på_siden", "e2: epost fails closed (no hjemmeside)");
      assertEq(noWebsite.telefon.verdict, "ikke_funnet_på_siden", "e3: telefon fails closed (no hjemmeside)");
      assertTrue(!fetchedHosts.some((h) => h.includes("utensted")), "e4: no-website provider is never fetched at all");

      // ── (f) all-blank stored fields -> ikke_funnet_på_siden despite real
      //     page content (nothing stored to confirm) ────────────────────────
      const blankFields = providers.find((p) => p.provider_id === "prov-blank-fields");
      assertTrue(!!blankFields, "f1: prov-blank-fields present");
      assertEq(blankFields.epost, { verdict: "ikke_funnet_på_siden", current: null, found: null }, "f2: blank stored epost -> ikke_funnet_på_siden even though page has an email");
      assertEq(blankFields.telefon, { verdict: "ikke_funnet_på_siden", current: null, found: null }, "f3: blank stored telefon -> ikke_funnet_på_siden even though page has a phone run");
      assertEq(blankFields.adresse, { verdict: "ikke_funnet_på_siden" }, "f4: blank stored adresse -> ikke_funnet_på_siden");

      // ── (j) summary shape — counts every verdict across the whole batch ──
      const s = full.body.summary;
      assertTrue(!!s && !!s.epost && !!s.telefon, "j1: summary carries per-field sub-objects");
      assertEq(
        s.epost,
        { bekreftet: 3, avvik: 1, ikke_funnet_på_siden: 4 },
        "j2: epost summary — full-match+rfbseed-nullptype+hidden-rfbseed(bekreftet x3) + avvik(avvik) + fetch-fail/no-website/blank/bakeri(ikke_funnet_på_siden x4, bakeri fails closed on its unmocked/404 fetch)",
      );
      assertEq(full.body.count, 8, "j3: top-level count matches providers.length");

      // ── (h) providerIds filter ────────────────────────────────────────────
      const filtered = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        url: "/admin/gardssalg-field-concordance-audit?providerIds=prov-full-match,prov-avvik",
      });
      assertEq(filtered.status, 200, "h1: providerIds filter -> 200");
      assertEq(filtered.body.providers.length, 2, "h2: exactly 2 providers returned");
      assertTrue(
        filtered.body.providers.every((p: any) => ["prov-full-match", "prov-avvik"].includes(p.provider_id)),
        "h3: only the filtered ids are present",
      );

      // Array/repeated-key form (bypassing URL string parsing) — the route
      // must accept Array.isArray(req.query.providerIds) too.
      const filteredArrayForm = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        query: { providerIds: ["prov-full-match"] },
      });
      assertEq(filteredArrayForm.status, 200, "h4: array-form providerIds -> 200");
      assertEq(filteredArrayForm.body.providers.length, 1, "h5: array-form providerIds narrows to exactly one");
      assertEq(filteredArrayForm.body.providers[0].provider_id, "prov-full-match", "h6: array-form providerIds resolves the right row");

      // An id outside the cohort (unknown + a real-but-excluded id) mixed
      // into a real id -> silently absent, never crashes the rest.
      // prov-non-gardssalg (no producer_type, no rfb_seed_source) is used
      // here as the "real-but-excluded" id — prov-bakeri no longer qualifies
      // for this role since the widened cohort now includes it (see g2).
      const withUnknown = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        url: "/admin/gardssalg-field-concordance-audit?providerIds=prov-full-match,prov-does-not-exist,prov-non-gardssalg",
      });
      assertEq(withUnknown.status, 200, "h7: batch with unknown/excluded ids -> 200, no crash");
      assertEq(withUnknown.body.providers.length, 1, "h8: only the one real cohort member survives");
      assertEq(withUnknown.body.providers[0].provider_id, "prov-full-match", "h9: the surviving row is correct and unaffected");

      // Duplicate ids collapse to one entry.
      const withDupes = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        url: "/admin/gardssalg-field-concordance-audit?providerIds=prov-full-match,prov-full-match,prov-full-match",
      });
      assertEq(withDupes.status, 200, "h10: duplicate providerIds -> 200");
      assertEq(withDupes.body.providers.length, 1, "h11: duplicates collapse to exactly one entry");

      // ── (i) validation ─────────────────────────────────────────────────────
      const blankFilter = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        url: "/admin/gardssalg-field-concordance-audit?providerIds=",
      });
      assertEq(blankFilter.status, 400, "i1: blank providerIds -> 400");
      assertTrue(typeof blankFilter.body?.error === "string", "i1b: error message present");

      const whitespaceOnly = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        url: "/admin/gardssalg-field-concordance-audit?providerIds=%20%20,%20",
      });
      assertEq(whitespaceOnly.status, 400, "i2: whitespace-only providerIds entries -> 400 (nothing usable survives trimming)");

      const tooMany = Array.from({ length: 201 }, (_, i) => `prov-bulk-${i}`).join(",");
      const overCap = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        url: `/admin/gardssalg-field-concordance-audit?providerIds=${tooMany}`,
      });
      assertEq(overCap.status, 400, "i3: 201 ids -> 400 (exceeds cap of 200)");
      assertTrue(/200/.test(overCap.body.error || ""), "i3b: error message names the cap");

      const exactlyCap = Array.from({ length: 200 }, (_, i) => `prov-bulk-${i}`).join(",");
      const atCap = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        url: `/admin/gardssalg-field-concordance-audit?providerIds=${exactlyCap}`,
      });
      assertEq(atCap.status, 200, "i4: exactly 200 (all nonexistent) ids -> 200, not rejected");
      assertEq(atCap.body.providers.length, 0, "i5: none of the 200 nonexistent ids resolve to a row -> empty (but valid) response");
      assertEq(atCap.body.count, 0, "i6: count reflects the empty result");

      // ── (l) review fix-up: limit/offset pagination ────────────────────────
      // Full cohort, ORDER BY id, is (8 rows):
      //   0 prov-avvik            1 prov-bakeri           2 prov-blank-fields
      //   3 prov-fetch-fail       4 prov-full-match       5 prov-hidden-rfbseed
      //   6 prov-no-website       7 prov-rfbseed-nullptype

      // l1: no params -> byte-identical to the earlier unpaginated (b)/(j)
      // response — same shape, no `pagination` key at all (regression).
      const noParams = await callRoute(opplevelserRouter, { headers: authHeaders });
      assertEq(noParams.status, 200, "l1a: no-params GET -> 200");
      assertEq(noParams.body, full.body, "l1b: no-params response is byte-identical to the earlier unpaginated call");
      assertTrue(!("pagination" in noParams.body), "l1c: no `pagination` key when limit is omitted");

      // l2: limit over the cap (12) -> 400, never silently clamped.
      const overCapLimit = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        url: "/admin/gardssalg-field-concordance-audit?limit=13",
      });
      assertEq(overCapLimit.status, 400, "l2a: limit=13 (over cap) -> 400");
      assertTrue(/12/.test(overCapLimit.body.error || ""), "l2b: error message names the cap (12)");

      // l3: offset without limit -> 400.
      const offsetOnly = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        url: "/admin/gardssalg-field-concordance-audit?offset=1",
      });
      assertEq(offsetOnly.status, 400, "l3: offset without limit -> 400");

      // l3b/c/d: malformed limit/offset -> 400, never a silent fallback.
      const zeroLimit = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        url: "/admin/gardssalg-field-concordance-audit?limit=0",
      });
      assertEq(zeroLimit.status, 400, "l3b: limit=0 (non-positive) -> 400");

      const negativeLimit = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        url: "/admin/gardssalg-field-concordance-audit?limit=-1",
      });
      assertEq(negativeLimit.status, 400, "l3c: limit=-1 -> 400");

      const nonIntegerLimit = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        url: "/admin/gardssalg-field-concordance-audit?limit=abc",
      });
      assertEq(nonIntegerLimit.status, 400, "l3d: limit=abc (not a number) -> 400");

      const negativeOffset = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        url: "/admin/gardssalg-field-concordance-audit?limit=3&offset=-1",
      });
      assertEq(negativeOffset.status, 400, "l3e: negative offset -> 400");

      // l4/l5: valid limit+offset -> exactly that page, AND rows outside the
      // page never trigger a homepage fetch at all (fetch-mock call-count
      // assertion, not just "absent from the response").
      const fetchCountBeforePage = fetchCallCount;
      const fetchedHostsLenBeforePage = fetchedHosts.length;
      const page = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        url: "/admin/gardssalg-field-concordance-audit?limit=3&offset=2",
      });
      assertEq(page.status, 200, "l4a: valid limit+offset -> 200");
      assertEq(
        page.body.providers.map((p: any) => p.provider_id),
        ["prov-blank-fields", "prov-fetch-fail", "prov-full-match"],
        "l4b: page returns exactly the 3 rows at offset 2 (indices 2-4), in stable ORDER BY id order",
      );
      assertEq(
        page.body.pagination,
        { total: 8, offset: 2, limit: 3, returned: 3, next_offset: 5 },
        "l4c: pagination block matches {total, offset, limit, returned, next_offset}",
      );

      // Note on call-count: crFetchGardssalgContent fetches the primary page
      // PLUS up to 4 sub-pages per successful homepage, and fetchPage()
      // itself one-shot-retries a failing primary — so the raw fetch() call
      // count per row varies (5 for a successful crawl, 2 for the simulated
      // 500 below) and is not itself a stable "1 row = 1 call" signal. The
      // stable, implementation-independent signal is the DISTINCT-HOST set:
      // exactly the 3 paged rows' hosts must appear, and no others.
      const pageFetchDelta = fetchCallCount - fetchCountBeforePage;
      assertTrue(pageFetchDelta > 0, "l5a: at least one fetch call was made for this page (sanity)");
      const pageFetchedHosts = fetchedHosts.slice(fetchedHostsLenBeforePage);
      assertEq(
        new Set(pageFetchedHosts).size,
        3,
        "l5a2: exactly 3 DISTINCT hosts were fetched for this page — one per paged row with a hjemmeside, never more",
      );
      assertTrue(
        pageFetchedHosts.every((h) =>
          ["mjoderi-tommefelt.example.no", "vingard-utilgjengelig.example.no", "sidergarden-fullmatch.example.no"].includes(h),
        ),
        "l5b: only the paged rows' homepages were fetched during this call",
      );
      assertTrue(
        !pageFetchedHosts.some((h) =>
          ["bryggeriet-avvik.example.no", "bakeriet-utenfor.example.no", "skjult-rfbseed.example.no", "rfbseed-nullptype.example.no"].includes(h),
        ),
        "l5c: rows OUTSIDE the requested page were never fetched during this call — not just absent from the response",
      );

      // l6: pagination present when limit is supplied, even covering the
      // whole cohort (limit=8, offset omitted -> defaults to 0).
      const fullViaLimit = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        url: "/admin/gardssalg-field-concordance-audit?limit=8",
      });
      assertEq(fullViaLimit.status, 200, "l6a: limit=8 (covers whole cohort) -> 200");
      assertEq(
        fullViaLimit.body.pagination,
        { total: 8, offset: 0, limit: 8, returned: 8, next_offset: null },
        "l6b: next_offset is null once the page reaches the end of the cohort",
      );

      // l7: limit+offset combined with providerIds — freely combinable, not
      // mutually exclusive: providerIds narrows the eligible set via SQL,
      // limit/offset then pages over whatever that narrowed set turns out
      // to be (ORDER BY id).
      const providerIdsPlusLimit = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        url: "/admin/gardssalg-field-concordance-audit?providerIds=prov-avvik,prov-bakeri,prov-blank-fields&limit=2",
      });
      assertEq(providerIdsPlusLimit.status, 200, "l7a: providerIds + limit together -> 200");
      assertEq(
        providerIdsPlusLimit.body.providers.map((p: any) => p.provider_id),
        ["prov-avvik", "prov-bakeri"],
        "l7b: limit pages over the providerIds-narrowed set (first 2 of 3, ORDER BY id)",
      );
      assertEq(
        providerIdsPlusLimit.body.pagination,
        { total: 3, offset: 0, limit: 2, returned: 2, next_offset: 2 },
        "l7c: pagination `total` reflects the providerIds-narrowed cohort, not the full 8-row cohort",
      );

      // ── (k) zero writes anywhere ──────────────────────────────────────────
      const afterDump = dumpProviders();
      assertEq(afterDump, beforeDump, "k1: experience_providers table is byte-identical before/after every call above");
      assertTrue(fetchCallCount > 0, "k1b: sanity — the mocked fetch was actually exercised (the zero-writes assertion isn't vacuous)");
    } catch (err: any) {
      failed++;
      failures.push(
        "opplevelser-gardssalg-field-concordance-audit: unexpected error: " + String(err?.stack || err?.message || err),
      );
    } finally {
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
      globalThis.fetch = prevFetch;
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-field-concordance-audit.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgFieldConcordanceAuditTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
