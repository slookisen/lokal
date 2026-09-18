/**
 * opplevelser-experience-orgnr-from-name-kommune.test.ts — tests for
 * POST /admin/experiences-orgnr-from-name-kommune (routes/opplevelser.ts)
 * and its underlying services/experience-orgnr-from-name-kommune.ts.
 *
 * PROBLEM this closes (dev-request 2026-09-14-opplevagent-karantene-utgang-
 * brreg-krav, Trinn B): 1774 experience_providers rows are stuck at
 * brreg_active IS NULL forever — the existing fuzzy name-search recheck
 * only resolves a small fraction, and Trinn A (org.nr-from-website, a
 * separate not-yet-merged slice) only helps rows with a website carrying a
 * LABELED org.nr. This file's target searches Brreg by NAME restricted to
 * the provider's own KOMMUNE (`enheter?navn=…&kommunenummer=…`), accepting
 * a hit only on exactly-one-hit, or an address/domain corroboration among
 * several hits — never guessing among ambiguous ties.
 *
 * Same harness conventions as opplevelser-experience-orgnr-from-website.test.ts
 * (Trinn A): in-memory experiences DB (EXPERIENCES_DB_PATH=":memory:"),
 * fresh requires per run, router.handle() as the HTTP entry point,
 * globalThis.fetch stubbed directly (searchBrregByNameAndKommune/
 * verifyOrgNumber/fetchBrregWebsite have no injected-fetchImpl call site at
 * this call depth — same convention Trinn A's own test file already uses
 * for verifyOrgNumber/fetchBrregBusinessAddress). No live network anywhere
 * in this file. The vendored 357-row kommune table is swapped for a small
 * deterministic fixture set via __setKommuneFylke2024RowsForTesting, so
 * this file's kommune-name-resolution assertions never depend on real
 * Norwegian kommune codes.
 *
 * Covers:
 *   (a) auth: no X-Admin-Key -> 403.
 *   (b) selection: brreg_active already 0/1, owner-locked (content_source
 *       manual/claim), catalog_hidden=1 — all excluded, and a candidate with
 *       NO hjemmeside at all is STILL selected (Trinn B is deliberately
 *       wider than Trinn A here).
 *   (c) kommunenummer resolution: row's own kommunenummer column used
 *       directly (name resolution skipped) WHEN VALID; row's kommune NAME
 *       resolved via resolveKommunenummerForName() when kommunenummer is
 *       blank; blank kommune+kommunenummer, an unresolvable kommune name,
 *       AND a non-blank own kommunenummer that ISN'T in the vendored table
 *       (typo'd/stale/wrong code) all -> no_kommune_match, never a Brreg
 *       call for these rows — the invalid-own-column case also proves there
 *       is NO silent fallback to name-resolution even when the row's
 *       kommune NAME would otherwise have resolved fine.
 *   (d) exactly one Brreg hit -> accepted (resolved_active / resolved_inactive),
 *       no corroboration attempted.
 *   (e) zero Brreg hits -> no_brreg_hits.
 *   (f) 2+ hits, no corroboration possible -> ambiguous_name, never guessed.
 *   (g) 2+ hits, exactly one address-corroborated -> accepted.
 *   (h) 2+ hits, exactly one domain-corroborated (address unavailable on
 *       either side) -> accepted.
 *   (i) 2+ hits, MULTIPLE independently corroborated -> ambiguous_name
 *       (never picks one arbitrarily).
 *   (j) org_nr collision: accepted org.nr already held by a different row.
 *   (k) an org.nr the search itself just returned, but the direct verify
 *       lookup doesn't confirm it exists -> error (never guessed active).
 *   (l) dry-run: every outcome bucket classified correctly, ZERO DB writes.
 *   (m) apply (dry_run:false): resolved_active/resolved_inactive rows are
 *       ACTUALLY written; every other outcome leaves brreg_active NULL.
 *   (n) STRICT dry_run parse: dry_run:"false" (string) is NOT apply.
 *   (o) pagination: a full page advances next_after; a page with no writes
 *       still advances (never re-selects the same rows forever).
 *   (p) time budget: an injected clock already past budget on the very
 *       first check -> the row lands in skipped_due_to_time_budget, ZERO
 *       Brreg search calls attempted for it.
 *   (q) enrichment write-pause fence: blocks apply (423), never blocks
 *       dry-run.
 *   (s) persisted after-cursor (dev-request 2026-09-14-opplevagent-
 *       karantene-utgang-brreg-krav, FUNN "orgnr-fra-webside-og-navn-
 *       kommune-mangler-cron-kobling-og-persistert-cursor"): an omitted
 *       `after` resumes from (and, on success, persists) the cursor in
 *       experience_orgnr_sweep_state under this route's OWN key
 *       ('orgnr_from_name_kommune'); an explicit `after` stays purely
 *       request-driven and never reads or writes that state; a dry-run
 *       call still advances the persisted cursor exactly like apply.
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
  opts: { url: string; headers?: Record<string, string>; body?: any },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const url = opts.url;
    const req: any = {
      method: "POST",
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      app: { get() { return undefined; } },
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

/** Deterministic PER-LABEL 9-digit org_nr — avoids hardcoded literals
 * colliding across test scenarios (org_nr carries a UNIQUE constraint on
 * experience_providers). Mirrors Trinn A test's own orgNrFor() helper. */
function orgNrFor(label: string): string {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return "7" + String(h % 100000000).padStart(8, "0");
}

function notFoundResponse(): Response {
  return {
    ok: false,
    status: 404,
    statusText: "Not Found",
    headers: { get: () => null },
  } as unknown as Response;
}

type SearchHitFixture = {
  orgNr: string;
  navn: string;
  address?: { street: string; postnummer?: string; poststed?: string } | null;
};

function enheterSearchResponse(hits: SearchHitFixture[]): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      _embedded: {
        enheter: hits.map((h) => ({
          organisasjonsnummer: h.orgNr,
          navn: h.navn,
          forretningsadresse: h.address
            ? { adresse: [h.address.street], postnummer: h.address.postnummer ?? null, poststed: h.address.poststed ?? null }
            : null,
        })),
      },
    }),
  } as unknown as Response;
}

function brregEnhetDetailResponse(o: {
  orgNr: string;
  navn: string;
  konkurs?: boolean;
  hjemmeside?: string | null;
}): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      organisasjonsnummer: o.orgNr,
      navn: o.navn,
      konkurs: o.konkurs ?? false,
      underAvvikling: false,
      underTvangsavviklingEllerTvangsopplosning: false,
      slettedato: null,
      hjemmeside: o.hjemmeside ?? null,
    }),
  } as unknown as Response;
}

export function runOpplevelserExperienceOrgnrFromNameKommuneTests(
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
    const testKey = process.env.ADMIN_KEY || "orgnr-from-name-kommune-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const svcPath = require.resolve("../services/experience-orgnr-from-name-kommune");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, svcPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    const initMod = require("../database/init") as typeof import("../database/init");
    const brregClient = require("../services/brreg-client") as typeof import("../services/brreg-client");
    const fylkeMod = require("../services/fylke-2024-migration") as typeof import("../services/fylke-2024-migration");
    brregClient.__clearBrregVerifyCacheForTesting();
    brregClient.__clearBrregNameKommuneCacheForTesting();
    brregClient.__clearBrregWebsiteCacheForTesting();

    // Deterministic, small kommune table — this file's kommune-name
    // resolution assertions never depend on the real 357-row vendored file.
    fylkeMod.__setKommuneFylke2024RowsForTesting([
      { kommunenummer: "1001", kommunenavn: "Testkommune Ett", fylkesnummer: "01", fylkesnavn: "Testfylke" },
      { kommunenummer: "1002", kommunenavn: "Testkommune To", fylkesnummer: "01", fylkesnavn: "Testfylke" },
    ]);

    // URL keyspace: exact "/enheter?navn=…&kommunenummer=…" search calls vs
    // "/enheter/<9-digit-orgnr>" direct lookups (verifyOrgNumber AND
    // fetchBrregWebsite/fetchBrregContact hit the SAME endpoint — one
    // fixture map serves both). No fetchImpl injection point at this call
    // depth (same convention Trinn A's own test file already uses for
    // verifyOrgNumber/fetchBrregBusinessAddress) — swap globalThis.fetch.
    const searchFixtures: Map<string, Response> = new Map();
    const detailFixtures: Map<string, Response> = new Map();
    const fetchCalls: string[] = [];

    function searchKey(navn: string, kommunenummer: string): string {
      return `${navn}|${kommunenummer}`;
    }

    function stubFetch(): typeof fetch {
      return (async (url: string | URL | Request) => {
        const urlStr = String(url);
        fetchCalls.push(urlStr);
        const enhetMatch = urlStr.match(/\/enheter\/(\d{9})$/);
        if (enhetMatch) {
          return detailFixtures.get(enhetMatch[1]!) ?? notFoundResponse();
        }
        const searchMatch = urlStr.match(/\/enheter\?navn=([^&]+)&kommunenummer=([^&]+)/);
        if (searchMatch) {
          const navn = decodeURIComponent(searchMatch[1]!);
          const knr = decodeURIComponent(searchMatch[2]!);
          return searchFixtures.get(searchKey(navn, knr)) ?? enheterSearchResponse([]);
        }
        return notFoundResponse();
      }) as unknown as typeof fetch;
    }
    globalThis.fetch = stubFetch();

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const svc = require("../services/experience-orgnr-from-name-kommune") as
        typeof import("../services/experience-orgnr-from-name-kommune");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const pauseSvc = require("../services/enrichment-write-pause") as typeof import("../services/enrichment-write-pause");
      const adminHeaders = { "x-admin-key": testKey };
      const ROUTE = "/admin/experiences-orgnr-from-name-kommune";

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, brreg_active, brreg_verified, org_nr, content_source, catalog_hidden,
            kommune, kommunenummer, adresse, hjemmeside, producer_type)
         VALUES (@id, @navn, @brreg_active, @brreg_verified, @org_nr, @content_source, @catalog_hidden,
                 @kommune, @kommunenummer, @adresse, @hjemmeside, @producer_type)`,
      );
      const seedProvider = (o: {
        id: string; navn: string; brreg_active?: number | null; brreg_verified?: number; org_nr?: string | null;
        content_source?: string | null; catalog_hidden?: number | null; kommune?: string | null;
        kommunenummer?: string | null; adresse?: string | null; hjemmeside?: string | null;
        // dev-request 2026-09-18-opplevagent-skop-katalogen-til-gardssalg-og-
        // drikke, del 1: defaults to 'bryggeri' so every fixture in this file
        // (whose subject — Trinn B org.nr-from-name+kommune — is unrelated to
        // the scope gate) is, by construction, in the gårdssalg cohort per
        // experience-scope.ts's isProviderInGardssalgCohort(). Pass
        // `producer_type: null` explicitly to seed a genuinely OUT-OF-SCOPE
        // provider for the dedicated scope-gate cases below.
        producer_type?: string | null;
      }) => {
        insertProvider.run({
          id: o.id, navn: o.navn,
          brreg_active: o.brreg_active === undefined ? null : o.brreg_active,
          brreg_verified: o.brreg_verified ?? 0,
          org_nr: o.org_nr ?? null,
          content_source: o.content_source ?? null,
          catalog_hidden: o.catalog_hidden ?? null,
          kommune: o.kommune ?? null,
          kommunenummer: o.kommunenummer ?? null,
          adresse: o.adresse ?? null,
          hjemmeside: o.hjemmeside ?? null,
          producer_type: o.producer_type === undefined ? "bryggeri" : o.producer_type,
        });
      };
      const providerRow = (id: string) =>
        expDb
          .prepare(`SELECT brreg_active, brreg_verified, org_nr, brreg_checked_at FROM experience_providers WHERE id = ?`)
          .get(id) as { brreg_active: number | null; brreg_verified: number; org_nr: string | null; brreg_checked_at: string | null };

      // ═══ (a) auth ═══════════════════════════════════════════════════════
      {
        const r = await callRoute(opplevelserRouter, { url: ROUTE, body: {} });
        assertEq(r.status, 403, "onk-a1: no X-Admin-Key -> 403");
      }

      // ═══ (b)-(k) main batch: selection exclusions + every outcome ═══════
      // ── selection-exclusion rows (never a candidate) ─────────────────────
      seedProvider({ id: "prov-already-active", navn: "Aktiv AlleredeSatt AS", brreg_active: 1, brreg_verified: 1, kommunenummer: "1001" });
      seedProvider({ id: "prov-already-inactive", navn: "Nedlagt AlleredeSatt AS", brreg_active: 0, brreg_verified: 1, kommunenummer: "1001" });
      seedProvider({ id: "prov-locked-manual", navn: "Låst Eier AS", content_source: "manual", kommunenummer: "1001" });
      seedProvider({ id: "prov-locked-claim", navn: "Låst Claim AS", content_source: "claim", kommunenummer: "1001" });
      seedProvider({ id: "prov-hidden", navn: "Skjult Katalog AS", catalog_hidden: 1, kommunenummer: "1001" });

      // ── (b) wider-than-Trinn-A: a candidate with NO hjemmeside is STILL
      //    selected + resolved via exactly-one-hit ───────────────────────
      const orgNrNoWebsite = orgNrFor("nowebsite1");
      seedProvider({ id: "prov-no-website", navn: "Ingen Nettside Gaard AS", kommunenummer: "1001", hjemmeside: null });
      searchFixtures.set(
        searchKey("Ingen Nettside Gaard AS", "1001"),
        enheterSearchResponse([{ orgNr: orgNrNoWebsite, navn: "INGEN NETTSIDE GAARD AS" }]),
      );
      detailFixtures.set(orgNrNoWebsite, brregEnhetDetailResponse({ orgNr: orgNrNoWebsite, navn: "INGEN NETTSIDE GAARD AS" }));

      // ── (c) kommunenummer resolution: own column used directly ─────────
      const orgNrOwnKnr = orgNrFor("ownknr1");
      seedProvider({ id: "prov-own-knr", navn: "Egenkommune Gaard AS", kommunenummer: "1001", kommune: "Helt Feil Navn" });
      searchFixtures.set(
        searchKey("Egenkommune Gaard AS", "1001"),
        enheterSearchResponse([{ orgNr: orgNrOwnKnr, navn: "EGENKOMMUNE GAARD AS" }]),
      );
      detailFixtures.set(orgNrOwnKnr, brregEnhetDetailResponse({ orgNr: orgNrOwnKnr, navn: "EGENKOMMUNE GAARD AS" }));

      // ── (c) kommunenummer resolution: kommune NAME resolved via
      //    resolveKommunenummerForName() when own kommunenummer is blank ──
      const orgNrNameResolved = orgNrFor("nameresolved1");
      seedProvider({ id: "prov-name-resolved", navn: "Navnetest Gaard AS", kommunenummer: null, kommune: "Testkommune To" });
      searchFixtures.set(
        searchKey("Navnetest Gaard AS", "1002"),
        enheterSearchResponse([{ orgNr: orgNrNameResolved, navn: "NAVNETEST GAARD AS" }]),
      );
      detailFixtures.set(orgNrNameResolved, brregEnhetDetailResponse({ orgNr: orgNrNameResolved, navn: "NAVNETEST GAARD AS", konkurs: true }));

      // ── (c) no_kommune_match: blank kommune AND blank kommunenummer ─────
      seedProvider({ id: "prov-blank-kommune", navn: "Uten Kommune AS", kommunenummer: null, kommune: null });

      // ── (c) no_kommune_match: unresolvable kommune name ─────────────────
      seedProvider({ id: "prov-unknown-kommune", navn: "Ukjent Kommune AS", kommunenummer: null, kommune: "Ikke En Ekte Kommune" });

      // ── (c) no_kommune_match: own kommunenummer column is non-blank but
      //    NOT in the vendored table (typo'd digit / stale pre-2024 code /
      //    upstream geocode error) — independent-reviewer finding on Trinn B.
      //    kommune ALSO carries a name that WOULD resolve fine on its own
      //    ("Testkommune To" -> 1002), to prove the invalid own-column value
      //    does NOT silently fall back to name-resolution (that would just
      //    substitute one unvalidated guess for another). No searchFixtures
      //    entry for EITHER "9999" or "1002" under this row's name — if
      //    either got searched, the assertions below (outcome + fetchCalls)
      //    would catch it.
      seedProvider({
        id: "prov-invalid-own-knr", navn: "Ugyldig Kommunenummer AS",
        kommunenummer: "9999", kommune: "Testkommune To",
      });

      // ── (e) no_brreg_hits ────────────────────────────────────────────────
      seedProvider({ id: "prov-nohits", navn: "Uten Treff AS", kommunenummer: "1001" });
      // Deliberately no searchFixtures entry -> falls through to
      // enheterSearchResponse([]) (a genuine zero-hit Brreg response).

      // ── (f) 2+ hits, no corroboration possible -> ambiguous_name ────────
      const orgNrAmbig1 = orgNrFor("ambig1a");
      const orgNrAmbig2 = orgNrFor("ambig1b");
      seedProvider({ id: "prov-ambig", navn: "Vanlig Gaard AS", kommunenummer: "1001", adresse: "Testveien 1", hjemmeside: null });
      searchFixtures.set(
        searchKey("Vanlig Gaard AS", "1001"),
        enheterSearchResponse([
          { orgNr: orgNrAmbig1, navn: "VANLIG GAARD AS", address: { street: "Annenvei 5", postnummer: "0000", poststed: "Ukjent" } },
          { orgNr: orgNrAmbig2, navn: "VANLIG GAARD ENK", address: { street: "Tredjevei 9", postnummer: "0000", poststed: "Ukjent" } },
        ]),
      );

      // ── (g) 2+ hits, exactly one address-corroborated -> accepted ───────
      const orgNrAddrYes = orgNrFor("addryes1");
      const orgNrAddrNo = orgNrFor("addrno1");
      seedProvider({ id: "prov-addr-confirm", navn: "Adressebekreftet Gaard AS", kommunenummer: "1001", adresse: "Gaardsveien 12", hjemmeside: null });
      searchFixtures.set(
        searchKey("Adressebekreftet Gaard AS", "1001"),
        enheterSearchResponse([
          { orgNr: orgNrAddrYes, navn: "ADRESSEBEKREFTET GAARD AS", address: { street: "Gaardsveien 12", postnummer: "2600", poststed: "Test" } },
          { orgNr: orgNrAddrNo, navn: "ADRESSEBEKREFTET GAARD ENK", address: { street: "Annenvei 3", postnummer: "2600", poststed: "Test" } },
        ]),
      );
      detailFixtures.set(orgNrAddrYes, brregEnhetDetailResponse({ orgNr: orgNrAddrYes, navn: "ADRESSEBEKREFTET GAARD AS" }));

      // ── (h) 2+ hits, exactly one domain-corroborated (no usable address
      //    on either side) -> accepted ─────────────────────────────────────
      const orgNrDomYes = orgNrFor("domyes1");
      const orgNrDomNo = orgNrFor("domno1");
      seedProvider({ id: "prov-domain-confirm", navn: "Domenebekreftet Gaard AS", kommunenummer: "1001", adresse: null, hjemmeside: "https://domenebekreftet1.test" });
      searchFixtures.set(
        searchKey("Domenebekreftet Gaard AS", "1001"),
        enheterSearchResponse([
          { orgNr: orgNrDomYes, navn: "DOMENEBEKREFTET GAARD AS" },
          { orgNr: orgNrDomNo, navn: "DOMENEBEKREFTET GAARD ENK" },
        ]),
      );
      detailFixtures.set(orgNrDomYes, brregEnhetDetailResponse({ orgNr: orgNrDomYes, navn: "DOMENEBEKREFTET GAARD AS", hjemmeside: "https://domenebekreftet1.test" }));
      detailFixtures.set(orgNrDomNo, brregEnhetDetailResponse({ orgNr: orgNrDomNo, navn: "DOMENEBEKREFTET GAARD ENK", hjemmeside: "https://heltannendomene1.test" }));

      // ── (i) 2+ hits, MULTIPLE independently corroborated -> ambiguous_name
      const orgNrMulti1 = orgNrFor("multi1a");
      const orgNrMulti2 = orgNrFor("multi1b");
      seedProvider({ id: "prov-multi-confirm", navn: "Dobbelbekreftet Gaard AS", kommunenummer: "1001", adresse: "Gaardsveien 99", hjemmeside: null });
      searchFixtures.set(
        searchKey("Dobbelbekreftet Gaard AS", "1001"),
        enheterSearchResponse([
          { orgNr: orgNrMulti1, navn: "DOBBELBEKREFTET GAARD AS", address: { street: "Gaardsveien 99", postnummer: "0000", poststed: "X" } },
          { orgNr: orgNrMulti2, navn: "DOBBELBEKREFTET GAARD ENK", address: { street: "Gaardsveien 99", postnummer: "0000", poststed: "X" } },
        ]),
      );

      // ── (j) org_nr collision ─────────────────────────────────────────────
      const orgNrCollide = orgNrFor("collide1");
      seedProvider({ id: "prov-collide-existing", navn: "Kolliderende Original AS", org_nr: orgNrCollide, brreg_active: 1, brreg_verified: 1 });
      seedProvider({ id: "prov-collide-new", navn: "Kolliderende Gaard AS", kommunenummer: "1001" });
      searchFixtures.set(
        searchKey("Kolliderende Gaard AS", "1001"),
        enheterSearchResponse([{ orgNr: orgNrCollide, navn: "KOLLIDERENDE GAARD AS" }]),
      );

      // ── (k) verify lookup doesn't confirm existence -> error ─────────────
      const orgNrUnconfirmed = orgNrFor("unconfirmed1");
      seedProvider({ id: "prov-unconfirmed", navn: "Ubekreftet Gaard AS", kommunenummer: "1001" });
      searchFixtures.set(
        searchKey("Ubekreftet Gaard AS", "1001"),
        enheterSearchResponse([{ orgNr: orgNrUnconfirmed, navn: "UBEKREFTET GAARD AS" }]),
      );
      // Deliberately no detailFixtures entry for orgNrUnconfirmed -> the
      // direct verify lookup 404s even though the search "found" it.

      // ── (l) dry-run: correct classification everywhere, ZERO writes ─────
      let dryRes: RouteResult;
      {
        const trackedIds = [
          "prov-no-website", "prov-own-knr", "prov-name-resolved", "prov-blank-kommune",
          "prov-unknown-kommune", "prov-invalid-own-knr", "prov-nohits", "prov-ambig", "prov-addr-confirm",
          "prov-domain-confirm", "prov-multi-confirm", "prov-collide-new", "prov-unconfirmed",
        ];
        const beforeRows: Record<string, any> = {};
        for (const id of trackedIds) beforeRows[id] = providerRow(id);

        dryRes = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { limit: 30 } });
        assertEq(dryRes.status, 200, "onk-l1: dry-run -> 200");
        assertEq(dryRes.body.dry_run, true, "onk-l2: apply omitted -> dry_run:true");

        const byId = new Map<string, any>((dryRes.body.planned as any[]).map((p) => [p.provider_id, p]));

        assertEq(byId.get("prov-no-website")?.outcome, "resolved_active", "onk-l3: NO hjemmeside is STILL a valid candidate, exactly-one-hit accepted");
        assertEq(byId.get("prov-own-knr")?.outcome, "resolved_active", "onk-l4: row's OWN kommunenummer column used directly");
        assertEq(byId.get("prov-name-resolved")?.outcome, "resolved_inactive", "onk-l5: blank kommunenummer -> resolved via resolveKommunenummerForName(kommune)");
        assertEq(byId.get("prov-blank-kommune")?.outcome, "no_kommune_match", "onk-l6: blank kommune+kommunenummer -> no_kommune_match");
        assertEq(byId.get("prov-unknown-kommune")?.outcome, "no_kommune_match", "onk-l7: unresolvable kommune name -> no_kommune_match");
        assertEq(
          byId.get("prov-invalid-own-knr")?.outcome,
          "no_kommune_match",
          "onk-l7b: own kommunenummer column holds a non-blank, UNKNOWN code (not in the vendored table) -> no_kommune_match, NOT no_brreg_hits, and NOT a silent fallback to the row's (otherwise-resolvable) kommune name",
        );
        assertTrue(
          !fetchCalls.some((u) => u.includes("Ugyldig") || u.includes("kommunenummer=9999")),
          "onk-l7c: NO Brreg search call was made for the invalid-own-kommunenummer row (neither for its own '9999' nor for its name at all) — proves the wrong-kommune search this finding warns about can no longer even be attempted",
        );
        assertEq(byId.get("prov-nohits")?.outcome, "no_brreg_hits", "onk-l8: zero Brreg hits -> no_brreg_hits");
        assertEq(byId.get("prov-ambig")?.outcome, "ambiguous_name", "onk-l9: 2+ hits, no corroboration -> ambiguous_name");
        assertEq(byId.get("prov-addr-confirm")?.outcome, "resolved_active", "onk-l10: 2+ hits, exactly one address-corroborated -> accepted");
        assertEq(byId.get("prov-addr-confirm")?.org_nr, orgNrAddrYes, "onk-l10b: …and it's the CORRECT (address-matching) hit, not the other one");
        assertEq(byId.get("prov-domain-confirm")?.outcome, "resolved_active", "onk-l11: 2+ hits, exactly one domain-corroborated -> accepted");
        assertEq(byId.get("prov-domain-confirm")?.org_nr, orgNrDomYes, "onk-l11b: …and it's the CORRECT (domain-matching) hit");
        assertEq(byId.get("prov-multi-confirm")?.outcome, "ambiguous_name", "onk-l12: 2+ hits, MULTIPLE independently confirmed -> ambiguous_name, never picks one");
        assertEq(byId.get("prov-collide-new")?.outcome, "orgnr_collision", "onk-l13: confirmed org.nr already held by a different row");
        assertEq(byId.get("prov-unconfirmed")?.outcome, "error", "onk-l14: search returned an org.nr the direct verify lookup didn't confirm -> error, never guessed");

        assertEq(dryRes.body.processed, 13, "onk-l15: processed = exactly the 13 tracked candidates (the 5 selection-exclusion rows + prov-collide-existing are never selected)");
        assertEq(dryRes.body.resolved_active, 4, "onk-l16: aggregate resolved_active (no-website + own-knr + addr-confirm + domain-confirm)");
        assertEq(dryRes.body.resolved_inactive, 1, "onk-l17: aggregate resolved_inactive (name-resolved)");
        assertEq(dryRes.body.no_kommune_match, 3, "onk-l18: aggregate no_kommune_match (blank-kommune + unknown-kommune-name + invalid-own-knr)");
        assertEq(dryRes.body.no_brreg_hits, 1, "onk-l19: aggregate no_brreg_hits");
        assertEq(dryRes.body.ambiguous_name, 2, "onk-l20: aggregate ambiguous_name (prov-ambig + prov-multi-confirm)");
        assertEq(dryRes.body.orgnr_collision, 1, "onk-l21: aggregate orgnr_collision");
        assertEq(dryRes.body.errors, 1, "onk-l22: aggregate errors");
        assertEq(
          dryRes.body.resolved_active + dryRes.body.resolved_inactive + dryRes.body.no_kommune_match +
          dryRes.body.no_brreg_hits + dryRes.body.ambiguous_name + dryRes.body.orgnr_collision + dryRes.body.errors,
          dryRes.body.processed,
          "onk-l23: every outcome bucket sums exactly to processed — no double counting",
        );

        for (const excludedId of [
          "prov-already-active", "prov-already-inactive", "prov-locked-manual", "prov-locked-claim", "prov-hidden",
        ]) {
          assertTrue(!byId.has(excludedId), `onk-l24 ${excludedId}: never selected as a candidate`);
        }
        assertTrue(
          !fetchCalls.some((u) => u.includes("Aktiv+AlleredeSatt") || u.includes("Aktiv%20AlleredeSatt")),
          "onk-l25: an already brreg_active=1 row's name never even hits Brreg",
        );

        // ZERO writes from the dry-run, across every outcome bucket.
        for (const id of trackedIds) {
          assertEq(providerRow(id), beforeRows[id], `onk-l26 ${id}: dry-run wrote NOTHING`);
        }
      }

      // ── (n) STRICT dry_run parse: a STRING "false" is NOT apply ─────────
      {
        const before = providerRow("prov-no-website");
        const r = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { dry_run: "false", limit: 30 } });
        assertEq(r.body.dry_run, true, "onk-n1: dry_run:'false' (string) is still treated as dry-run");
        assertEq(providerRow("prov-no-website"), before, "onk-n2: …and nothing was written");
      }

      // ═══ (m) apply: actual writes, only for the two resolved buckets ════
      {
        const r = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { dry_run: false, limit: 30 } });
        assertEq(r.status, 200, "onk-m1: apply -> 200");
        assertEq(r.body.dry_run, false, "onk-m2: dry_run:false echoed back");
        assertEq(r.body.resolved_active, 4, "onk-m3: resolved_active=4 on the real run too");
        assertEq(r.body.resolved_inactive, 1, "onk-m4: resolved_inactive=1");

        const noWebsite = providerRow("prov-no-website");
        assertEq(noWebsite.brreg_active, 1, "onk-m5: prov-no-website.brreg_active -> 1 (actually written)");
        assertEq(noWebsite.brreg_verified, 1, "onk-m6: prov-no-website.brreg_verified -> 1");
        assertEq(noWebsite.org_nr, orgNrNoWebsite, "onk-m7: prov-no-website.org_nr written");
        assertTrue(!!noWebsite.brreg_checked_at, "onk-m8: prov-no-website.brreg_checked_at stamped");

        const ownKnr = providerRow("prov-own-knr");
        assertEq(ownKnr.brreg_active, 1, "onk-m9: prov-own-knr.brreg_active -> 1");
        assertEq(ownKnr.org_nr, orgNrOwnKnr, "onk-m10: prov-own-knr.org_nr written");

        const nameResolved = providerRow("prov-name-resolved");
        assertEq(nameResolved.brreg_active, 0, "onk-m11: prov-name-resolved.brreg_active -> 0 (konkurs, a confirmed answer, not a guess)");
        assertEq(nameResolved.brreg_verified, 1, "onk-m12: prov-name-resolved.brreg_verified -> 1");
        assertEq(nameResolved.org_nr, orgNrNameResolved, "onk-m13: prov-name-resolved.org_nr written");

        const addrConfirm = providerRow("prov-addr-confirm");
        assertEq(addrConfirm.brreg_active, 1, "onk-m14: prov-addr-confirm.brreg_active -> 1");
        assertEq(addrConfirm.org_nr, orgNrAddrYes, "onk-m15: prov-addr-confirm.org_nr is the address-matching hit");

        const domainConfirm = providerRow("prov-domain-confirm");
        assertEq(domainConfirm.brreg_active, 1, "onk-m16: prov-domain-confirm.brreg_active -> 1");
        assertEq(domainConfirm.org_nr, orgNrDomYes, "onk-m17: prov-domain-confirm.org_nr is the domain-matching hit");

        // Every non-resolved bucket stays byte-identical — NEVER guessed.
        assertEq(providerRow("prov-blank-kommune").brreg_active, null, "onk-m18: prov-blank-kommune STILL NULL");
        assertEq(providerRow("prov-unknown-kommune").brreg_active, null, "onk-m19: prov-unknown-kommune STILL NULL");
        assertEq(providerRow("prov-invalid-own-knr").brreg_active, null, "onk-m19b: prov-invalid-own-knr STILL NULL — invalid own kommunenummer never guessed, never fell back to name-resolution");
        assertEq(providerRow("prov-nohits").brreg_active, null, "onk-m20: prov-nohits STILL NULL");
        assertEq(providerRow("prov-ambig").brreg_active, null, "onk-m21: prov-ambig STILL NULL — never guessed among ambiguous ties");
        assertEq(providerRow("prov-multi-confirm").brreg_active, null, "onk-m22: prov-multi-confirm STILL NULL — never picks one among multiple confirmed hits");
        assertEq(providerRow("prov-collide-new").brreg_active, null, "onk-m23: prov-collide-new STILL NULL (fail-closed on collision)");
        assertEq(providerRow("prov-collide-new").org_nr, null, "onk-m24: prov-collide-new.org_nr never written");
        assertEq(providerRow("prov-collide-existing").org_nr, orgNrCollide, "onk-m25: the row that legitimately holds the org_nr is untouched");
        assertEq(providerRow("prov-unconfirmed").brreg_active, null, "onk-m26: prov-unconfirmed STILL NULL");
      }

      // ═══ (o) pagination: a page with no writes still ADVANCES ══════════
      {
        seedProvider({ id: "zzp-01", navn: "Ingen Treff Ett AS", kommunenummer: "1001" });
        seedProvider({ id: "zzp-02", navn: "Ingen Treff To AS", kommunenummer: "1001" });
        seedProvider({ id: "zzp-03", navn: "Ingen Treff Tre AS", kommunenummer: "1001" });
        // Deliberately no searchFixtures entries -> all three land in
        // no_brreg_hits (no state change) — proving next_after still
        // converges instead of a bare `ORDER BY id LIMIT ?` re-selecting
        // them forever.

        const page1 = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { dry_run: false, limit: 2, after: "zzp-00" } });
        assertEq(page1.body.processed, 2, "onk-o1: page 1 processes exactly `limit` rows");
        assertEq(page1.body.next_after, "zzp-02", "onk-o2: next_after is the id of the LAST row this call scanned");
        const page1Ids = (page1.body.planned as any[]).map((p) => p.provider_id);
        assertTrue(
          page1Ids.includes("zzp-01") && page1Ids.includes("zzp-02") && !page1Ids.includes("zzp-03"),
          `onk-o3: page 1 covers rows 1-2, not row 3 (got ${JSON.stringify(page1Ids)})`,
        );
        assertEq(providerRow("zzp-01").brreg_active, null, "onk-o4: row 1 left unchanged (no_brreg_hits, never guessed) — STILL eligible");

        const page2 = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { dry_run: false, limit: 2, after: page1.body.next_after } });
        const page2Ids = (page2.body.planned as any[]).map((p) => p.provider_id);
        assertTrue(
          !page2Ids.includes("zzp-01") && !page2Ids.includes("zzp-02"),
          `onk-o5: page 2 does NOT re-process rows page 1 already scanned (got ${JSON.stringify(page2Ids)})`,
        );
        assertTrue(
          page2Ids.includes("zzp-03") && page2.body.next_after === null,
          `onk-o6: page 2 reaches row 3, and next_after is null once the page comes back shorter than \`limit\` (ids=${JSON.stringify(page2Ids)}, next_after=${page2.body.next_after})`,
        );
      }

      // ═══ (p) time budget: skip everything, zero Brreg search calls ═════
      {
        seedProvider({ id: "zzt-01", navn: "Tidsbudsjett Ett AS", kommunenummer: "1001" });
        seedProvider({ id: "zzt-02", navn: "Tidsbudsjett To AS", kommunenummer: "1001" });
        // Fixtures deliberately absent — if the budget guard failed to skip
        // these rows, a fetch would go out to enheterSearchResponse([]) and
        // the row would resolve no_brreg_hits instead of being skipped,
        // which the assertions below would catch via the fetch-call count.

        const fetchCallsBefore = fetchCalls.length;
        let calls = 0;
        svc.__setNowForTesting(() => {
          calls++;
          // First call establishes the batch's own start time (0). Every
          // subsequent call (the per-candidate budget check) reports the
          // budget as already exceeded — deterministic, no real waiting.
          return calls === 1 ? 0 : svc.EXPERIENCE_ORGNR_NAME_KOMMUNE_TIME_BUDGET_MS + 1;
        });
        try {
          const r = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { dry_run: false, limit: 10, after: "zzt-00" } });
          assertEq(r.status, 200, "onk-p1: a time-budget-exceeded batch does not error");
          assertEq(r.body.processed, 0, "onk-p2: processed=0 — nothing was attempted");
          assertEq(
            [...r.body.skipped_due_to_time_budget].sort(),
            ["zzt-01", "zzt-02"],
            "onk-p3: both candidates land in skipped_due_to_time_budget",
          );
          assertEq(fetchCalls.length, fetchCallsBefore, "onk-p4: ZERO Brreg calls were made for a batch that never got a chance to start");
        } finally {
          svc.__setNowForTesting(null);
        }
      }

      // ═══ (q) enrichment write-pause fence ════════════════════════════════
      {
        const BetterSqlite = require("better-sqlite3") as typeof import("better-sqlite3");
        const mainDb = new BetterSqlite(":memory:");
        mainDb.pragma("journal_mode = DELETE");
        mainDb.pragma("foreign_keys = OFF");
        const prevMainDb = initMod.__peekDbForTesting();
        initMod.__setDbForTesting(mainDb as any);
        initMod.__initSchemaForTesting(mainDb as any);

        const orgNrPaused = orgNrFor("paused1");
        seedProvider({ id: "prov-paused-01", navn: "Aktiv UnderPause AS", kommunenummer: "1001" });
        searchFixtures.set(searchKey("Aktiv UnderPause AS", "1001"), enheterSearchResponse([{ orgNr: orgNrPaused, navn: "AKTIV UNDERPAUSE AS" }]));
        detailFixtures.set(orgNrPaused, brregEnhetDetailResponse({ orgNr: orgNrPaused, navn: "AKTIV UNDERPAUSE AS" }));

        pauseSvc.setEnrichmentWritePause(mainDb as any, { vertical: "experiences", enabled: true, reason: "test: orgnr-from-name-kommune pause" }, "verifier");

        const before = providerRow("prov-paused-01");
        const blockedApply = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { dry_run: false, limit: 5, after: "prov-paused-00" } });
        assertEq(blockedApply.status, 423, "onk-q1: apply under a live experiences pause -> 423");
        assertEq(blockedApply.body?.paused, true, "onk-q2: body.paused===true");
        assertEq(blockedApply.body?.vertical, "experiences", "onk-q3: body.vertical==='experiences'");
        assertEq(providerRow("prov-paused-01"), before, "onk-q4: ZERO writes across the blocked apply call");

        const dryUnderPause = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { limit: 5, after: "prov-paused-00" } });
        assertEq(dryUnderPause.status, 200, "onk-q5: dry-run under the SAME pause is NEVER blocked");

        pauseSvc.setEnrichmentWritePause(mainDb as any, { vertical: "experiences", enabled: false, cleared_by: "daniel" }, "verifier");
        const afterClear = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { dry_run: false, limit: 5, after: "prov-paused-00" } });
        assertEq(afterClear.status, 200, "onk-q6: apply goes through again once the pause is cleared");
        assertEq(providerRow("prov-paused-01").brreg_active, 1, "onk-q7: …and actually writes now");

        initMod.__setDbForTesting(prevMainDb);
        try { mainDb.close(); } catch { /* ignore */ }
      }

      // ═══ (r) dev-request 2026-09-18-opplevagent-skop-katalogen-til-
      //      gardssalg-og-drikke, del 1: the in-scope gate. An out-of-scope
      //      provider (producer_type:null, no mat_drikke experience) is
      //      NEVER selected/searched — proven on the fetchCalls log, not
      //      just a response counter. A provider IN the gårdssalg cohort is
      //      still resolved even with zero mat_drikke experiences (OR
      //      rule). ═══════════════════════════════════════════════════════
      {
        const fetchCallsBefore = fetchCalls.length;

        seedProvider({
          id: "prov-scope-outofscope", navn: "Ukjent Museum AS",
          kommunenummer: "1001", producer_type: null,
        });
        // Deliberately no searchFixtures/detailFixtures entry — if this row
        // were ever searched it would see zero hits and stay unresolved
        // either way, so the real proof below is that no Brreg call for it
        // (by name) ever fires at all.

        seedProvider({
          id: "prov-scope-viacohort", navn: "Gaardsdrikke Cohort AS",
          kommunenummer: "1001", producer_type: "bryggeri",
        });
        const orgNrCohort = orgNrFor("scopecohort1");
        searchFixtures.set(searchKey("Gaardsdrikke Cohort AS", "1001"), enheterSearchResponse([{ orgNr: orgNrCohort, navn: "GAARDSDRIKKE COHORT AS" }]));
        detailFixtures.set(orgNrCohort, brregEnhetDetailResponse({ orgNr: orgNrCohort, navn: "GAARDSDRIKKE COHORT AS" }));

        // `after` scoped past every earlier fixture id in this file (all
        // "prov-…" < "prov-scope-000" alphabetically) so this call's
        // candidate set is exactly these 2 new rows (+ the harmless already-
        // exercised zz*-prefixed pagination/time-budget fixtures, which sort
        // after "prov-scope-…" and are idempotent either way).
        const r = await callRoute(opplevelserRouter, {
          url: ROUTE, headers: adminHeaders, body: { dry_run: false, limit: 10, after: "prov-scope-000" },
        });
        assertEq(r.status, 200, "onk-r1: apply -> 200");
        assertTrue(
          !fetchCalls.slice(fetchCallsBefore).some((u) => u.includes("Ukjent") || u.includes("museum")),
          "onk-r2: the out-of-scope provider was NEVER searched (no Brreg call names it)",
        );
        assertEq(providerRow("prov-scope-outofscope").brreg_active, null, "onk-r3: out-of-scope provider's brreg_active left untouched (still NULL)");
        assertEq(providerRow("prov-scope-viacohort").brreg_active, 1, "onk-r4: the gårdssalg-cohort provider (zero mat_drikke experiences) WAS resolved and written");
        assertTrue((r.body.skipped_out_of_scope as number) >= 1, "onk-r5: response reports skipped_out_of_scope >= 1 (additive field, on top of every pre-existing field)");
      }

      // ═══ (s) persisted after-cursor (dev-request 2026-09-14-opplevagent-
      //      karantene-utgang-brreg-krav, FUNN "orgnr-fra-webside-og-navn-
      //      kommune-mangler-cron-kobling-og-persistert-cursor") ══════════
      {
        const sweepState = require("../services/experience-orgnr-sweep-state") as
          typeof import("../services/experience-orgnr-sweep-state");
        // Prime this route's own persisted cursor ('orgnr_from_name_kommune'
        // — independent of the sibling Trinn-A route's own 'orgnr_from_
        // website' key) to a known value just BEFORE the fixtures below,
        // rather than relying on "resume from the true start", which
        // earlier sections' own still-unresolved leftover candidates would
        // otherwise intercept first.
        sweepState.setExperienceOrgnrSweepAfter(expDb, "orgnr_from_name_kommune", "zzz-00");

        // Blank kommune + kommunenummer -> no_kommune_match, never a Brreg
        // call (see section (c)'s own doc comment above) — the simplest
        // deterministic, network-free outcome for isolating cursor
        // behavior from search/corroboration logic.
        seedProvider({ id: "zzz-01", navn: "Cursor Ett AS" });
        seedProvider({ id: "zzz-02", navn: "Cursor To AS" });
        seedProvider({ id: "zzz-03", navn: "Cursor Tre AS" });

        // s1: OMITTED `after` -> resumes from the primed persisted cursor
        // (zzz-00), processes zzz-01, and (dry-run included) persists
        // next_after.
        const s1 = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { limit: 1 } });
        const s1Ids = (s1.body.planned as any[]).map((p: any) => p.provider_id);
        assertEq(s1.body.dry_run, true, "onk-s1: apply omitted -> dry_run:true");
        assertTrue(s1Ids.includes("zzz-01") && !s1Ids.includes("zzz-02"), `onk-s1b: omitted-after resumes from the primed persisted cursor (got ${JSON.stringify(s1Ids)})`);
        assertEq(
          sweepState.getExperienceOrgnrSweepAfter(expDb, "orgnr_from_name_kommune"),
          s1.body.next_after,
          "onk-s2: a DRY-RUN call with omitted `after` still PERSISTS its own next_after (mirrors gardssalg-website-verification-remediation's own dry-run persistence)",
        );
        assertEq(s1.body.next_after, "zzz-01", "onk-s2b: next_after is the last id this call scanned");

        // s2: OMITTED `after` again -> resumes from the persisted cursor
        // (zzz-01), processes zzz-02, not zzz-01 again.
        const s2 = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { limit: 1 } });
        const s2Ids = (s2.body.planned as any[]).map((p: any) => p.provider_id);
        assertTrue(s2Ids.includes("zzz-02") && !s2Ids.includes("zzz-01"), `onk-s3: second omitted-after call resumes from the persisted cursor, not the start (got ${JSON.stringify(s2Ids)})`);
        assertEq(sweepState.getExperienceOrgnrSweepAfter(expDb, "orgnr_from_name_kommune"), "zzz-02", "onk-s3b: persisted cursor now advanced to zzz-02");

        // s3: EXPLICIT `after` (pointing before zzz-01) -> purely
        // request-driven: re-scans zzz-01 regardless of the persisted
        // cursor (zzz-02) — and must NOT read OR write persisted state.
        const s3 = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { limit: 1, after: "zzz-00" } });
        const s3Ids = (s3.body.planned as any[]).map((p: any) => p.provider_id);
        assertTrue(s3Ids.includes("zzz-01"), `onk-s4: explicit \`after\` is purely request-driven — ignores the persisted cursor entirely (got ${JSON.stringify(s3Ids)})`);
        assertEq(
          sweepState.getExperienceOrgnrSweepAfter(expDb, "orgnr_from_name_kommune"),
          "zzz-02",
          "onk-s5: explicit `after` call left the persisted cursor UNCHANGED (still zzz-02, not overwritten with zzz-01)",
        );

        // s4: OMITTED `after` again -> proves s3's explicit call never
        // clobbered the persisted cursor; resumes from zzz-02, reaching
        // zzz-03.
        const s4 = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { limit: 1 } });
        const s4Ids = (s4.body.planned as any[]).map((p: any) => p.provider_id);
        assertTrue(s4Ids.includes("zzz-03"), `onk-s6: omitted-after call after the explicit one correctly resumed from zzz-02, reaching zzz-03 (got ${JSON.stringify(s4Ids)})`);

        // s7: the sibling Trinn-A route's own persisted cursor
        // ('orgnr_from_website') is completely independent — this route's
        // own cursor never touches it.
        assertEq(
          sweepState.getExperienceOrgnrSweepAfter(expDb, "orgnr_from_website"),
          undefined,
          "onk-s7: this route's own cursor writes never touch the sibling Trinn-A route's own key",
        );
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-experience-orgnr-from-name-kommune: unexpected error: " + String(err?.stack || err));
    } finally {
      globalThis.fetch = prevFetch;
      brregClient.__clearBrregVerifyCacheForTesting();
      brregClient.__clearBrregNameKommuneCacheForTesting();
      brregClient.__clearBrregWebsiteCacheForTesting();
      fylkeMod.__setKommuneFylke2024RowsForTesting(null);
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOpplevelserExperienceOrgnrFromNameKommuneTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
