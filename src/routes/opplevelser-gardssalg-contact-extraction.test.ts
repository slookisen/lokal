/**
 * opplevelser-gardssalg-contact-extraction.test.ts — Daniels GO 2026-07-30:
 * «Kjør kontakt-utvinning fra de nye hjemmesidene.»
 *
 * 243 av 389 gårdssalg-produsenter mangler både epost og telefon, Brreg er
 * uttømt, men website-discovery v2 ga kohorten ekte hjemmesider. Denne
 * leveren crawler dem og fyller kontaktfeltene — og den farligste feilen er
 * å skrive FEIL adresse (aggregators, webdesigner-kreditering, partner).
 * Testene er derfor organisert rundt måtene en feil verdi kan slippe inn:
 *
 *   cx-1..cx-6   E-post-ekstraksjon: mailto vinner, samme-domene foran
 *                freemail, freemail KUN på kontaktside, junk-postbokser
 *                aldri, søppel aldri.
 *   cx-7..cx-11  Telefon-ekstraksjon: +47-normalisering, cue foran bar
 *                sifferrekke, bar rekke kun på kontaktside, 9-sifret org.nr
 *                og 4-sifret postnr matcher aldri, 8xx avvises.
 *   cx-12..cx-14 Selektoren: kun gårdssalg-rader med hjemmeside og manglende
 *                kontakt; låste og testprovideren aldri; stabil paging.
 *   cx-15..cx-19 Ruta ende-til-ende med mocket fetch: kontaktside foretrekkes
 *                foran forside, fill-only (eksisterende verdi røres aldri),
 *                dry-run skriver ingenting, apply skriver med audit +
 *                provenance, låst rad hoppes over av skriveren.
 *   cx-20        Eksklusjonslistetillegget fra wdv2-målingen: taste*-DMO og
 *                *.blog avvises som hjemmesidekandidater.
 *   cx-24        Sitebuilder-placeholder-domener (mysite.com m.fl.) skrives
 *                aldri — funnet i 2026-07-31-kohorten via u-tilpasset Wix-mal.
 *   cx-25        epost/telefon er rullbare via content-rollback-leveren
 *                (audit-rader fantes siden #432; allowlisten manglet feltene).
 *   cx-26        Rolled-back-veto: en rullet-tilbake epost re-skrives ikke av
 *                neste kjøring selv om kilden serverer samme adresse (per felt).
 *   cx-21..cx-23 Herdingen etter prod-hendelsen 30.07 (dev-request
 *                2026-07-30-kontakt-utvinning-kjorelaas-og-pacing): kjørelås
 *                gir 409 på samtidig kall og slippes etterpå, default-limit
 *                er 8, og en frakoblet klient avbryter kjøringen i stedet
 *                for å fullføre i det stille.
 *   cx-27..cx-31 fetchPage()-bytte + per-host cooldown (dev-request
 *                2026-08-07-kontaktjakt-drikkeprodusenter, nedstrandbryggeri.no
 *                sin rate-limiter): en 503 blir automatisk retried (fetchPage()s
 *                interne ett-forsøks-retry) i stedet for umiddelbar
 *                fetch_failed; en 429 parkerer verten i cooldown, og et senere
 *                kall mot SAMME vert — samme kjøring eller en frisk kjøring
 *                innenfor vinduet — hoppes over med den dedikerte
 *                cooldown_skipped-bøtta i stedet for å bli fetchet på nytt;
 *                en vert UTENFOR cooldown fetches som normalt.
 *   cx-50..cx-53 Skrive-tids-domenegjerdet (dev-request 2026-08-17-
 *                kontaktadresse-feilkilde-og-override, Skive C(a)): en
 *                fremmed-domene-kandidat skrives ikke som publiserbar
 *                adresse, men stemples i review-køen og rapporteres i
 *                contact_email_flagged_for_review; telefonen fra samme side
 *                er upåvirket.
 *
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/routes/opplevelser-gardssalg-contact-extraction.test.ts
 */

import type {} from "node";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runGardssalgContactExtractionTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    process.env.ADMIN_KEY = process.env.ADMIN_KEY || "cx-test-key";
    const testKey = process.env.ADMIN_KEY;

    // Fresh-require pairing (repoets gardssalg-claim-mønster): db-factory og
    // alle moduler som holder closure over den, SAMMEN — ellers lander seeds
    // i en database ruta aldri leser (den harde lærdommen fra
    // crm-contact-provider-link-suiten samme dag).
    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    const prevFetch = globalThis.fetch;
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const opplevelserModule = require("./opplevelser") as typeof import("./opplevelser");
      const opplevelserRouter = opplevelserModule.default as any;
      // Radpause 0 i test: harnesset er timing-sensitivt (runSerial-kjeden i
      // tests/test.ts), og sekunder med kunstig pause her forskyver urelaterte
      // suiter inn i kjente races. Yield-semantikken (ekte setTimeout) beholdes.
      opplevelserModule.__setGsCxRowDelayForTesting(0);

      const callRoute = (
        routeBody: Record<string, unknown>,
        reqExtra: Record<string, unknown> = {},
      ): Promise<{ status: number; body: any }> => {
        const req: any = {
          method: "POST",
          url: "/admin/gardssalg-contact-extraction",
          originalUrl: "/api/opplevelser/admin/gardssalg-contact-extraction",
          path: "/admin/gardssalg-contact-extraction",
          query: {},
          body: routeBody,
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

      // ═══ cx-1..cx-6: e-post-ekstraksjon (PURE) ═══
      {
        const ex = expStore.extractGardssalgContactEmail;
        const r1 = ex('<a href="mailto:post@fjellbrygg.no">Skriv til oss</a> ellers kontakt@aggregator.no', "fjellbrygg.no", false);
        assertEq(r1?.email, "post@fjellbrygg.no", "cx-1: mailto vinner over tekstadresser");
        assertEq(r1?.source, "mailto", "cx-1b: …med mailto-proveniens");
        const r2 = ex("Kontakt: hei@fjellbrygg.no eller følg oss", "fjellbrygg.no", false);
        assertEq(r2?.email, "hei@fjellbrygg.no", "cx-2: samme-domene tekstadresse aksepteres også utenfor kontaktside");
        assertEq(r2?.source, "text_same_domain", "cx-2b: …med samme-domene-proveniens");
        const r3 = ex("Bestill: fjellbrygg@gmail.com", "fjellbrygg.no", false);
        assertEq(r3, null, "cx-3: freemail på en IKKE-kontaktside skrives aldri — kan være hvem som helst");
        const r4 = ex("Bestill: fjellbrygg@gmail.com", "fjellbrygg.no", true);
        assertEq(r4?.email, "fjellbrygg@gmail.com", "cx-4: freemail PÅ kontaktsiden aksepteres — små gårder bruker gmail");
        assertEq(r4?.source, "text_contact_page", "cx-4b: …ærlig merket med svakere proveniens");
        const r5 = ex('<a href="mailto:noreply@fjellbrygg.no">x</a> webmaster@fjellbrygg.no', "fjellbrygg.no", true);
        assertEq(r5, null, "cx-5: junk-postbokser (noreply/webmaster) matcher aldri, selv via mailto");
        const r6 = ex("Utviklet av byraa@webdesign.no", "fjellbrygg.no", false);
        assertEq(r6, null, "cx-6: webdesigner-kreditering på forsiden skrives ikke (feil domene + ikke kontaktside)");
      }

      // ═══ cx-50..cx-55: domeneblind mailto/tekst — dev-request
      // kontaktadresse-domeneblind-mailto-og-tekst (lofotpils.no-saken:
      // tg@dng-norge.no, en distributørs mailto, slo den ekte produsent-
      // adressen lenger ned på siden). Samme-domene rangeres nå FØR
      // fremmed-domene i alle kanaler; en gjenværende fremmed-domene-
      // adresse returneres fortsatt (aldri stille droppet) men flagget
      // needsReview. ═══
      {
        const ex = expStore.extractGardssalgContactEmail;
        // cx-50: akseptansekriteriet fra dev-requesten selv — fremmed-domene
        // mailto OG produsentens egen samme-domene-adresse i tekst samtidig
        // -> den egne adressen vinner.
        const r50 = ex(
          '<a href="mailto:tg@bryggdistribusjon.no">Distributør</a> Kontakt oss: post@fjellbrygg2.no',
          "fjellbrygg2.no",
          false,
        );
        assertEq(r50?.email, "post@fjellbrygg2.no",
          "cx-50: egen samme-domene-adresse vinner over distributørens fremmed-domene mailto");
        assertEq(r50?.source, "text_same_domain", "cx-50b: …med samme-domene-proveniens");
        assertEq((r50 as any)?.needsReview, undefined, "cx-50c: …og uten needsReview (den vant på ekte grunnlag)");

        // cx-51: KUN fremmed-domene mailto (ingen samme-domene-kandidat) ->
        // adressen returneres likevel (aldri droppet), flagget needsReview.
        const r51 = ex('<a href="mailto:tg@bryggdistribusjon.no">Distributør</a>', "fjellbrygg2.no", false);
        assertEq(r51?.email, "tg@bryggdistribusjon.no",
          "cx-51: fremmed-domene mailto uten alternativ -> returnert, ikke droppet");
        assertEq(r51?.source, "mailto_other_domain", "cx-51b: …med proveniens mailto_other_domain");
        assertEq(r51?.needsReview, true, "cx-51c: …og flagget needsReview");

        // cx-52: KUN fremmed-domene tekstadresse PÅ kontaktside (ingen
        // mailto, ingen samme-domene) -> flagget needsReview.
        const r52 = ex("Kontakt: post@annenfirma.no", "fjellbrygg2.no", true);
        assertEq(r52?.email, "post@annenfirma.no", "cx-52: fremmed-domene tekstadresse på kontaktside -> returnert");
        assertEq(r52?.source, "text_other_domain", "cx-52b: …med proveniens text_other_domain");
        assertEq(r52?.needsReview, true, "cx-52c: …og flagget needsReview");

        // cx-53: samme som cx-52, men IKKE kontaktside -> null (speiler den
        // eksisterende cx-6-porten: fremmed-domene tekst uten kontaktside-
        // signal skrives aldri).
        const r53 = ex("Kontakt: post@annenfirma.no", "fjellbrygg2.no", false);
        assertEq(r53, null, "cx-53: samme fremmed-domene-adresse på IKKE-kontaktside -> null");

        // cx-54: freemail via mailto på en IKKE-kontaktside -> fortsatt
        // akseptert uten needsReview (mailto er ubetinget på sidetype,
        // uendret fra før).
        const r54 = ex('<a href="mailto:fjellbrygg2@gmail.com">Skriv</a>', "fjellbrygg2.no", false);
        assertEq(r54?.email, "fjellbrygg2@gmail.com",
          "cx-54: freemail via mailto er fortsatt ubetinget akseptert på sidetype");
        assertEq(r54?.source, "mailto", "cx-54b: …med proveniens mailto — ingen needsReview");
        assertEq((r54 as any)?.needsReview, undefined, "cx-54c: …og needsReview-feltet er fraværende, ikke false");

        // cx-55: den eksisterende embedded-same-domain-regresjonen bekreftes
        // i src/services/gardssalg-embedded-evidence.test.ts (67northdistillery.no-
        // fixturen) — ikke duplisert her.
      }

      // ═══ cx-7..cx-11: telefon-ekstraksjon (PURE) ═══
      {
        const px = expStore.extractGardssalgContactPhone;
        const r7 = px("Ring oss på tlf +47 912 34 567 for omvisning", false);
        assertEq(r7?.phone, "91234567", "cx-7: +47 med mellomrom normaliseres, cue «tlf» funnet");
        assertEq(r7?.cued, true, "cx-7b: …merket som cued");
        const r8 = px("Ordrenummer 12345678 er sendt", false);
        assertEq(r8, null, "cx-8: bar 8-sifret rekke UTEN cue på ikke-kontaktside skrives aldri (ordrenummer-fella)");
        const r9 = px("Vi holder til i Bryggeveien: 91234567", true);
        assertEq(r9?.phone, "91234567", "cx-9: bar rekke PÅ kontaktside aksepteres");
        const r10 = px("Org.nr 912 345 678 — post 5780", true);
        assertEq(r10, null, "cx-10: 9-sifret org.nr og 4-sifret postnr matcher aldri som telefon");
        const r11 = px("tlf 812 34 567", true);
        assertEq(r11, null, "cx-11: 8xx-nummer (teletorg) avvises — aldri en produsents kontakttelefon");
      }

      // ═══ Fixtures for selektor + rute ═══
      const ins = expDb.prepare(
        `INSERT INTO experience_providers (id, navn, vertical, producer_type, hjemmeside, epost, telefon, content_source, created_at)
         VALUES (@id, @navn, 'experiences', @pt, @hj, @ep, @tlf, @cs, @created)`
      );
      ins.run({ id: "cx-a", navn: "Fjellbrygg AS", pt: "bryggeri", hj: "https://fjellbrygg.no", ep: null, tlf: null, cs: null, created: "2026-01-01" });
      ins.run({ id: "cx-b", navn: "Har Alt AS", pt: "sideri", hj: "https://haralt.no", ep: "post@haralt.no", tlf: "99887766", cs: null, created: "2026-01-02" });
      ins.run({ id: "cx-c", navn: "Låst Gard", pt: "bryggeri", hj: "https://laastgard.no", ep: null, tlf: null, cs: "claim", created: "2026-01-03" });
      ins.run({ id: "cx-d", navn: "Testrad", pt: "test-gardssalg", hj: "https://test.example.no", ep: null, tlf: null, cs: null, created: "2026-01-04" });
      ins.run({ id: "cx-e", navn: "Uten Side", pt: "bryggeri", hj: null, ep: null, tlf: null, cs: null, created: "2026-01-05" });
      ins.run({ id: "cx-f", navn: "Delvis AS", pt: "vingård", hj: "https://delvis.no", ep: "post@delvis.no", tlf: null, cs: null, created: "2026-01-06" });

      // ═══ cx-12..cx-14: selektoren ═══
      {
        const { targets, cohortTotal } = expStore.selectGardssalgProvidersForContactExtraction(10, 0);
        const ids = targets.map((t) => t.id);
        assertTrue(ids.includes("cx-a") && ids.includes("cx-f"), "cx-12: rader med hjemmeside og manglende kontakt er i kohorten (helt og delvis manglende)");
        assertTrue(!ids.includes("cx-b"), "cx-12b: rad med BÅDE epost og telefon er ikke i kohorten");
        assertTrue(!ids.includes("cx-c") && !ids.includes("cx-d") && !ids.includes("cx-e"),
          "cx-13: låst rad, testprovider og rad uten hjemmeside er aldri i kohorten");
        assertEq(cohortTotal, 2, "cx-13b: cohort_total teller nøyaktig de kvalifiserte");
        const page2 = expStore.selectGardssalgProvidersForContactExtraction(1, 1);
        assertEq(page2.targets[0]?.id, "cx-f", "cx-14: offset-paging over stabil totalorden");
      }

      // ═══ cx-15..cx-19: ruta ende-til-ende ═══
      // Mocken svarer KUN for denne suitens fixture-domener og 404-er resten av
      // suitens egne crawl-mål. Loopback-URL-er (127.0.0.1/localhost) sendes
      // videre til fetchen som var installert da suiten startet: andre
      // harness-blokker (pr106/tnb/selger-open-tracking) gjør ekte loopback-
      // HTTP via globalThis.fetch KONKURRENT med denne suitens await-vinduer,
      // og en mock som 404-er alt (uten headers) er nøyaktig stub-klassen
      // tests/test.ts-headeren dokumenterer som kilde til interleaving-krasj
      // («Cannot read properties of undefined (reading 'get')»).
      // fetchPage()-compatible: bodies read via arrayBuffer(), not .text() —
      // fetchPage decodes the raw bytes itself (see src/services/fetch-page.ts).
      // headers.get() defaults to null throughout (no content-type override
      // needed, the html fixtures all carry markup so the charset-sniff falls
      // back to utf-8; no retry-after needed outside the cooldown suite below).
      const cxMockHeaders = { get: () => null } as unknown as Headers;
      const fetchCalls: string[] = [];
      const mkHtmlResponse = (u: string, html: string): Response =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          url: u,
          headers: cxMockHeaders,
          arrayBuffer: async () => new TextEncoder().encode(html).buffer,
        }) as unknown as Response;
      const mk404Response = (u: string): Response =>
        ({
          ok: false,
          status: 404,
          statusText: "Not Found",
          url: u,
          headers: cxMockHeaders,
          arrayBuffer: async () => new ArrayBuffer(0),
        }) as unknown as Response;
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        const host = (() => { try { return new URL(u).hostname; } catch { return ""; } })();
        if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
          return (prevFetch as typeof fetch)(url as any, init);
        }
        fetchCalls.push(u);
        if (u.startsWith("https://fjellbrygg.no/kontakt")) {
          return mkHtmlResponse(u,
            '<html><body>Kontakt oss: <a href="mailto:post@fjellbrygg.no">post@fjellbrygg.no</a> — tlf 912 34 567</body></html>');
        }
        if (u === "https://fjellbrygg.no" || u === "https://fjellbrygg.no/") {
          return mkHtmlResponse(u,
            '<html><body>Fjellbrygg — håndverksøl. feil@aggregator.no <a href="/kontakt">Kontakt</a></body></html>');
        }
        if (u.startsWith("https://delvis.no")) {
          return mkHtmlResponse(u, "<html><body>Delvis vingård. Ring 45 67 89 01 for besøk</body></html>");
        }
        return mk404Response(u);
      }) as unknown as typeof fetch;

      {
        const dry = await callRoute({});
        assertEq(dry.status, 200, "cx-15: ruta svarer 200");
        assertEq(dry.body.dry_run, true, "cx-15b: dry-run er default");
        const a = (dry.body.changed as any[]).find((c) => c.provider_id === "cx-a");
        assertEq(a?.epost, "post@fjellbrygg.no", "cx-16: e-posten hentes fra KONTAKTSIDEN (mailto), ikke aggregator-adressen på forsiden");
        assertEq(a?.telefon, "91234567", "cx-16b: telefonen fra samme side, cue-et og normalisert");
        assertTrue(String(a?.source_url || "").includes("/kontakt"), "cx-16c: proveniens-URL peker på siden verdien faktisk sto på");
        const rowA = expDb.prepare("SELECT epost, telefon FROM experience_providers WHERE id='cx-a'").get() as any;
        assertTrue(rowA.epost === null && rowA.telefon === null, "cx-17: dry-run skriver INGENTING");

        const applied = await callRoute({ apply: true });
        const rowA2 = expDb.prepare("SELECT epost, telefon, field_provenance FROM experience_providers WHERE id='cx-a'").get() as any;
        assertEq(rowA2.epost, "post@fjellbrygg.no", "cx-18: apply skriver e-posten");
        assertEq(rowA2.telefon, "91234567", "cx-18b: …og telefonen");
        assertTrue(String(rowA2.field_provenance || "").includes("fjellbrygg.no/kontakt"),
          "cx-18c: field_provenance bærer bevis-URL-en per felt");
        const rowF = expDb.prepare("SELECT epost, telefon FROM experience_providers WHERE id='cx-f'").get() as any;
        assertEq(rowF.epost, "post@delvis.no", "cx-19: fill-only — eksisterende epost på cx-f er urørt");
        assertEq(rowF.telefon, "45678901", "cx-19b: …mens den manglende telefonen fylles (cue «Ring»)");
        assertTrue((applied.body.changed as any[]).length >= 2, "cx-19c: begge radene rapporteres som endret");
      }

      // ═══ cx-20: eksklusjonslistetillegget fra wdv2-målingen ═══
      {
        assertEq(expStore.gardssalgSharedDomainReason("tastehardanger.com"), "dmo_taste_domain",
          "cx-20: taste*-DMO avvises som hjemmesidekandidat (Måge Sider-feiltreffet)");
        assertEq(expStore.gardssalgSharedDomainReason("hobbylivpasorlandet.blog"), "blog_tld_host",
          "cx-20b: *.blog avvises (Borøy-feiltreffet) — en blogg-TLD er aldri en produsents hjemmeside");
        assertEq(expStore.gardssalgSharedDomainReason("fjellbrygg.no"), null,
          "cx-20c: vanlige domener er fortsatt upåvirket");
      }

      // ═══ cx-21..cx-23: herdingen etter prod-hendelsen 30.07 ═══
      // (kjørelås → 409, default-limit 8, frakoblings-abort — dev-request
      // 2026-07-30-kontakt-utvinning-kjorelaas-og-pacing)
      {
        // Ti nye kvalifiserte rader — cx-a/cx-f ble fylt av apply-kjøringen
        // over og er ute av kohorten. Hjemmesidene 404-er i fetch-mocken, så
        // radene lander i fetch_failed; det er kjøre-mekanikken som testes her.
        for (let i = 1; i <= 10; i++) {
          ins.run({ id: `cx-l${i}`, navn: `Låsegard ${i}`, pt: "bryggeri", hj: `https://laasegard${i}.no`, ep: null, tlf: null, cs: null, created: `2026-02-${String(i).padStart(2, "0")}` });
        }

        // Kjørelåsen settes synkront før første await i handleren, så kall B
        // fyrt rett etter A ser låsen — nøyaktig scenarioet fra 30.07 der
        // timede-ut apply-kall stablet seg.
        const pA = callRoute({});
        const pB = callRoute({});
        const b = await pB;
        assertEq(b.status, 409, "cx-21: samtidig kall nummer to får 409 umiddelbart");
        assertEq(b.body?.error, "run_in_progress", "cx-21b: …med run_in_progress-feilkoden");
        const a = await pA;
        assertEq(a.status, 200, "cx-21c: den første kjøringen fullfører upåvirket av det avviste kallet");
        assertEq(a.body.scanned, 8, "cx-22: default-limit er 8 (ned fra 24) — pacing-punktet i spec-en");
        const c = await callRoute({ limit: 1 });
        assertEq(c.status, 200, "cx-21d: låsen er sluppet etter fullført kjøring — neste kall går gjennom");

        // Frakoblet klient: kjøringen skal avbrytes FØR crawling, ikke
        // fullføre i det stille (det var de forlatte kjøringene som stablet
        // seg og mettet event-loopen).
        const fetchesBefore = fetchCalls.length;
        const d = await callRoute({ limit: 5 }, { aborted: true });
        assertEq(d.status, 200, "cx-23: frakoblet klient → kjøringen avbrytes ryddig");
        assertEq(d.body?.aborted_client_disconnect, true, "cx-23b: …og svaret sier ærlig at den ble avbrutt");
        assertEq((d.body?.changed as any[])?.length, 0, "cx-23c: ingen rader behandlet etter frakobling");
        assertEq(fetchCalls.length, fetchesBefore, "cx-23d: ingen crawl-fetches gjort for den avbrutte kjøringen");
        const e2 = await callRoute({ limit: 1 });
        assertEq(e2.status, 200, "cx-23e: låsen er sluppet også etter en avbrutt kjøring (finally-garantien)");
      }

      // ═══ cx-24: sitebuilder-placeholder-domener skrives aldri ═══
      // (2026-07-31-kohorten: u-tilpasset Wix-mal serverte mailto:info@mysite.com
      // på en ekte produsents side, og mailto er høyeste tillitsnivå — guarden
      // må derfor sitte i push(), før tillitsordenen i det hele tatt vurderes.)
      {
        const ex = expStore.extractGardssalgContactEmail;
        const r24 = ex('<a href="mailto:info@mysite.com">Kontakt</a>', "nedstrandbryggeri.no", true);
        assertEq(r24, null, "cx-24: mailto mot placeholder-domene (mysite.com) skrives aldri — selv på kontaktside");
        const r24b = ex("Skriv til oss: post@yourdomain.com eller ring", "fjellbrygg.no", true);
        assertEq(r24b, null, "cx-24b: tekst-adresse på placeholder-domene avvises også");
        const r24c = ex('<a href="mailto:info@mysite.com">x</a> ellers post@fjellbrygg.no', "fjellbrygg.no", false);
        assertEq(r24c?.email, "post@fjellbrygg.no", "cx-24c: ekte samme-domene-adresse vinner når placeholderen er filtrert bort");
      }

      // ═══ cx-25: epost/telefon er rullbare via content-rollback-leveren ═══
      // (Audit-rader har eksistert siden lokal#432; allowlisten manglet feltene,
      // så en giftig adresse hadde ingen undo. cx-a fikk epost+telefon skrevet av
      // apply-kjøringen i cx-18 — rull epost tilbake og la telefon stå.)
      {
        const callRollback = (rbBody: Record<string, unknown>): Promise<{ status: number; body: any }> => {
          const req: any = {
            method: "POST",
            url: "/admin/gardssalg-content-rollback",
            originalUrl: "/api/opplevelser/admin/gardssalg-content-rollback",
            path: "/admin/gardssalg-content-rollback",
            query: {},
            body: rbBody,
            headers: { "x-admin-key": testKey },
            get(n: string) { return this.headers[n.toLowerCase()]; },
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

        const dry = await callRollback({ provider_id: "cx-a", field_name: "epost" });
        assertEq(dry.status, 200, "cx-25: rollback-planen svarer 200 for epost");
        assertEq((dry.body?.restorable ?? dry.body?.restored)?.length ?? 0, 1,
          "cx-25b: epost er nå et kjent, rullbart felt (ikke unknown_field)");
        const rowBefore = expDb.prepare("SELECT epost, telefon FROM experience_providers WHERE id='cx-a'").get() as any;
        assertEq(rowBefore.epost, "post@fjellbrygg.no", "cx-25c: dry-run rørte ingenting");

        const applied25 = await callRollback({ provider_id: "cx-a", field_name: "epost", apply: true });
        assertEq(applied25.status, 200, "cx-25d: rollback apply svarer 200");
        const rowAfter = expDb.prepare("SELECT epost, telefon FROM experience_providers WHERE id='cx-a'").get() as any;
        assertEq(rowAfter.epost, null, "cx-25e: epost er rullet tilbake til pre-write-verdien (null)");
        assertEq(rowAfter.telefon, "91234567", "cx-25f: telefon står urørt — rollbacken er per felt");

        // ═══ cx-26: rolled-back-veto — undo-en un-undoer seg ikke ═══
        // (lokal#438-review B1: rollback nuller feltet → raden er tilbake i
        // fill-only-kohorten, og kilden serverer fortsatt samme mailto. Uten
        // veto ville neste kjøring stille re-skrevet verdien mennesket nettopp
        // rullet tilbake — org_nr-presedensens «undo that un-undoes itself».)
        assertEq(expStore.gardssalgContactFieldWasRolledBack("cx-a", "epost"), true,
          "cx-26: siste audit-rad for cx-a/epost er en rollback");
        assertEq(expStore.gardssalgContactFieldWasRolledBack("cx-a", "telefon"), false,
          "cx-26b: telefon er IKKE rullet tilbake — veto-en er per felt");
        const reRun = await callRoute({ apply: true, limit: 12 });
        assertEq(reRun.status, 200, "cx-26c: ny apply-kjøring etter rollback svarer 200");
        const rowVeto = expDb.prepare("SELECT epost, telefon FROM experience_providers WHERE id='cx-a'").get() as any;
        assertEq(rowVeto.epost, null,
          "cx-26d: epost forblir null — samme mailto på kilden re-skrives IKKE etter rollback");
        assertEq(rowVeto.telefon, "91234567", "cx-26e: telefonen (aldri rullet tilbake) står fortsatt");
        const reWrites = (reRun.body.changed as any[]).filter((c) => c.provider_id === "cx-a");
        assertEq(reWrites.length, 0, "cx-26f: kjøringen rapporterer heller ingen skriving for cx-a");
      }

      // ═══ cx-27..cx-31: fetchPage() retry + per-host cooldown ═══
      // (dev-request 2026-08-07-kontaktjakt-drikkeprodusenter: nedstrandbryggeri.no's
      // aggressive rate-limiter 429s a dry-run and then 429s AGAIN on the very
      // next apply against the same host. The route now fetches via the shared
      // classified fetcher fetchPage() — src/services/fetch-page.ts — instead
      // of the single-shot wdFetchPage(), so a transient/5xx failure is retried
      // once transparently, and a 429 parks its host in an in-process cooldown
      // so a later fetch to the SAME host is skipped rather than re-hammered.)
      {
        // Tracked SEPARATELY from `fetchCalls` (and by exact URL, not just
        // host) so cx-29d/cx-31b below can assert a specific cooldown-parked
        // URL was NEVER fetched at all — not merely "not seen in the outer
        // suite's counter", which would be vacuously true regardless of
        // whether the cooldown logic actually skipped the call.
        let retryHostCalls = 0;
        const newHostCalls: string[] = [];
        const cxMockFetch2 = globalThis.fetch;
        globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
          const u = String(url);
          if (u.startsWith("https://retryhost.no")) {
            newHostCalls.push(u);
            retryHostCalls++;
            if (retryHostCalls === 1) {
              return { ok: false, status: 503, statusText: "Service Unavailable", url: u, headers: cxMockHeaders, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
            }
            return mkHtmlResponse(u, "<html><body>Retry gård. Ring 23 45 67 89 for besøk</body></html>");
          }
          if (u.startsWith("https://cooldownhost.no")) {
            newHostCalls.push(u);
            return { ok: false, status: 429, statusText: "Too Many Requests", url: u, headers: cxMockHeaders, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
          }
          if (u.startsWith("https://normalhost.no")) {
            newHostCalls.push(u);
            return mkHtmlResponse(u, "<html><body>Normal gård. Ring 34 56 78 90 for besøk</body></html>");
          }
          return (cxMockFetch2 as typeof fetch)(url as any, init);
        }) as unknown as typeof fetch;

        ins.run({ id: "cx-retry", navn: "Retry Gard", pt: "bryggeri", hj: "https://retryhost.no", ep: null, tlf: null, cs: null, created: "2026-03-01" });
        ins.run({ id: "cx-cool1", navn: "Cooldown Gard 1", pt: "bryggeri", hj: "https://cooldownhost.no", ep: null, tlf: null, cs: null, created: "2026-03-02" });
        ins.run({ id: "cx-cool2", navn: "Cooldown Gard 2", pt: "bryggeri", hj: "https://cooldownhost.no/annen-side", ep: null, tlf: null, cs: null, created: "2026-03-03" });
        ins.run({ id: "cx-normal", navn: "Normal Gard", pt: "bryggeri", hj: "https://normalhost.no", ep: null, tlf: null, cs: null, created: "2026-03-04" });

        const r27 = await callRoute({ limit: 20 });
        assertEq(r27.status, 200, "cx-27: ruta svarer 200 med de nye radene i kohorten");

        // (a) transient (503) fetches get fetchPage()'s one retry, not an
        // immediate fetchFailed.
        assertEq(retryHostCalls, 2, "cx-27b: retryhost.no ble forsøkt to ganger — det interne retry-passet i fetchPage()");
        assertTrue(!(r27.body.fetch_failed as any[]).some((f) => f.provider_id === "cx-retry"),
          "cx-27c: cx-retry endte IKKE i fetch_failed — retryen reddet forsøket");
        const retryRow = (r27.body.changed as any[]).find((c) => c.provider_id === "cx-retry");
        assertEq(retryRow?.telefon, "23456789", "cx-27d: telefonen fra den vellykkede retry-responsen ble hentet ut");

        // (b) a 429 parks its host; a later fetch to the SAME host in the
        // SAME run is skipped with the dedicated cooldown_skipped reason, not
        // lumped into fetch_failed/errors.
        assertTrue((r27.body.fetch_failed as any[]).some((f) => f.provider_id === "cx-cool1"),
          "cx-28: cx-cool1 (som selv fikk 429-svaret) rapporteres i fetch_failed, som før");
        const cool2Entry = (r27.body.cooldown_skipped as any[]).find((c) => c.provider_id === "cx-cool2");
        assertTrue(!!cool2Entry, "cx-29: cx-cool2 er i den dedikerte cooldown_skipped-bøtta");
        assertEq(cool2Entry?.host, "cooldownhost.no", "cx-29b: …med riktig vert");
        assertTrue(!(r27.body.fetch_failed as any[]).some((f) => f.provider_id === "cx-cool2"),
          "cx-29c: cx-cool2 er IKKE også lumpet inn i fetch_failed");
        assertTrue(!newHostCalls.includes("https://cooldownhost.no/annen-side"),
          "cx-29d: cx-cool2s egen URL ble ALDRI fetchet — cooldownen hoppet over kallet helt");

        // (c) a host NOT in cooldown fetches normally.
        const normalRow = (r27.body.changed as any[]).find((c) => c.provider_id === "cx-normal");
        assertEq(normalRow?.telefon, "34567890", "cx-30: normalhost.no (ikke i cooldown) fetches og ekstraheres normalt");

        // A fresh run (separate POST) within the cooldown window still skips
        // the same host — the map is per-process, not per-request.
        ins.run({ id: "cx-cool3", navn: "Cooldown Gard 3", pt: "bryggeri", hj: "https://cooldownhost.no/tredje", ep: null, tlf: null, cs: null, created: "2026-03-05" });
        const r31 = await callRoute({ limit: 20 });
        const cool3Entry = (r31.body.cooldown_skipped as any[]).find((c) => c.provider_id === "cx-cool3");
        assertTrue(!!cool3Entry, "cx-31: cooldownen består inn i en FRISK kjøring innenfor vinduet");
        assertTrue(!newHostCalls.includes("https://cooldownhost.no/tredje"),
          "cx-31b: …og cx-cool3s egen URL ble aldri fetchet i den friske kjøringen heller");
      }

      // ═══ cx-32..cx-40: headless-eskalering (67 North-saken, 2026-08-16) ═══
      //
      // Denne ruta svarte `no_contact_found` for 67 North Distillery mens
      // post@67northdistillery.no lå i sidens eget innhold hele tiden: rå-
      // dokumentet er 19 synlige tegn, adressen finnes først etter at JS har
      // kjørt, og ruta rendret aldri. Den svarte altså om en side den ikke
      // hadde lest. Samme rad rendrer til 4 558 tegn gjennom workeren.
      //
      // JS_SHELL etterligner nettopp den formen: nok bytes til å passere
      // shouldEscalateToRender sin byte-terskel, <script> til stede, og nesten
      // ingen synlig tekst — så den PURE regelen (ikke testen) avgjør at raden
      // er kvalifisert.
      {
        const prevFlag = process.env.GARDSSALG_HEADLESS_FALLBACK_ENABLED;
        const JS_SHELL =
          "<html><head><title>67 Nord</title></head><body><div id=root></div>" +
          "<script>" + "x".repeat(3000) + "</script></body></html>";
        const RENDERED_FRONT =
          '<html><body><h1>67 Nord Destilleri</h1><a href="/kontakt">Kontakt</a>' +
          "<p>Vi lager akevitt i Saltdal.</p></body></html>";
        const RENDERED_KONTAKT =
          '<html><body>Kontakt oss: <a href="mailto:post@jsgard.no">post@jsgard.no</a></body></html>';

        const cxMockFetch3 = globalThis.fetch;
        let renderCalls: string[] = [];
        const restoreFetch = () => { globalThis.fetch = cxMockFetch3; };
        globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
          const u = String(url);
          // Både forsiden og /kontakt kommer tilbake som JS-skall over HTTP —
          // det er nettopp poenget: uten rendering er de begge ulesbare.
          if (u.startsWith("https://jsgard.no")) return mkHtmlResponse(u, JS_SHELL);
          return (cxMockFetch3 as typeof fetch)(url as any, init);
        }) as unknown as typeof fetch;

        const mkRenderStub = (opts: { ok?: boolean; reason?: string } = {}) =>
          (async (u: string) => {
            renderCalls.push(u);
            if (opts.ok === false) {
              return { ok: false as const, reason: opts.reason ?? "renderer_unavailable", detail: "stub", elapsedMs: 5 };
            }
            const html = u.includes("/kontakt") ? RENDERED_KONTAKT : RENDERED_FRONT;
            return { ok: true as const, html, finalUrl: u, text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), elapsedMs: 42 };
          }) as any;

        ins.run({ id: "cx-js", navn: "JS Gard", pt: "bryggeri", hj: "https://jsgard.no", ep: null, tlf: null, cs: null, created: "2026-04-01" });

        // ── cx-32/33: flagget AV — uendret oppførsel, men nå observerbart. ──
        delete process.env.GARDSSALG_HEADLESS_FALLBACK_ENABLED;
        renderCalls = [];
        opplevelserModule.__setGardssalgRenderPageImplForTesting(mkRenderStub());
        {
          const r = await callRoute({ providerIds: ["cx-js"] });
          assertEq(renderCalls.length, 0, "cx-32: flagg AV → ingen render forsøkt");
          const d = (r.body.render_diagnostic as any[]).find((x) => x.provider_id === "cx-js");
          assertTrue(!!d, "cx-33: render_diagnostic har likevel en rad — «ingen eskalering» er ikke et fravær");
          assertEq(d?.flag_enabled, false, "cx-33b: flag_enabled=false");
          assertEq(d?.attempted, false, "cx-33c: attempted=false");
          assertEq(d?.eligible, true, "cx-33d: eligible=true — siden ER et JS-skall; det er flagget som stopper, ikke regelen");
          assertTrue(
            !!(r.body.no_contact_found as any[]).find((x) => x.provider_id === "cx-js"),
            "cx-33e: uten rendering finner ruta fortsatt ingenting — akkurat som 67 North",
          );
        }

        // ── cx-34..37: flagget PÅ — saken dette ble bygget for. ──
        process.env.GARDSSALG_HEADLESS_FALLBACK_ENABLED = "true";
        renderCalls = [];
        {
          const r = await callRoute({ providerIds: ["cx-js"] });
          const c = (r.body.changed as any[]).find((x) => x.provider_id === "cx-js");
          assertEq(c?.epost, "post@jsgard.no", "cx-34: adressen hentes fra den RENDREDE kontaktsiden — hullet er tettet");
          assertTrue(String(c?.source_url || "").includes("/kontakt"),
            "cx-35: proveniens peker på kontaktsiden, ikke forsiden");
          assertTrue(renderCalls.some((u) => u.includes("/kontakt")),
            "cx-36: undersiden ble OGSÅ rendret — /kontakt er like ulesbar som forsiden på en JS-side");
          const d = (r.body.render_diagnostic as any[]).find((x) => x.provider_id === "cx-js");
          assertEq(d?.ok, true, "cx-37: forsidens render rapporteres ok");
          assertEq(d?.subpages_rendered, 1, "cx-37b: og underside-telleren havner i rapporten, ikke i en kopi som forsvinner");
          assertTrue((d?.chars_after ?? 0) > (d?.chars_before ?? 0),
            "cx-37c: chars_before/after viser hva renderingen faktisk ga");
        }

        // ── cx-38/39: render-feil er IKKE fatal. Siden ble hentet; å felle
        //    raden på en valgfri ekstra ville gjort en forbedring til en
        //    regresjon. Grunnen rapporteres, så feilen aldri er taus. ──
        renderCalls = [];
        opplevelserModule.__setGardssalgRenderPageImplForTesting(mkRenderStub({ ok: false, reason: "renderer_unavailable" }));
        {
          const r = await callRoute({ providerIds: ["cx-js"] });
          assertEq(r.status, 200, "cx-38: render-feil felle ikke kjøringen");
          const d = (r.body.render_diagnostic as any[]).find((x) => x.provider_id === "cx-js");
          assertEq(d?.ok, false, "cx-38b: rapporten sier at renderingen feilet");
          assertEq(d?.reason, "renderer_unavailable",
            "cx-39: …med grunn, så en operatør ser om botemiddelet er konfigurasjon eller nettstedet");
          assertEq(d?.subpages_rendered, undefined,
            "cx-39b: undersider rendres ALDRI når forsiden feilet — eskaleringen er portet på et bevist-JS-nettsted");
        }

        // ── cx-40: en server-rendret side betaler ingenting. Den PURE regelen
        //    avgjør fortsatt per side, så flagget alene starter ikke en
        //    blankett-runde med rendering over hver eneste produsent. ──
        renderCalls = [];
        opplevelserModule.__setGardssalgRenderPageImplForTesting(mkRenderStub());
        ins.run({ id: "cx-ssr", navn: "SSR Gard", pt: "bryggeri", hj: "https://fjellbrygg.no", ep: null, tlf: null, cs: null, created: "2026-04-02" });
        {
          const r = await callRoute({ providerIds: ["cx-ssr"] });
          assertEq(renderCalls.length, 0, "cx-40: server-rendret side → ingen render, selv med flagget på");
          const d = (r.body.render_diagnostic as any[]).find((x) => x.provider_id === "cx-ssr");
          assertEq(d?.eligible, false, "cx-40b: eligible=false er regelens svar, ikke testens");
          assertEq(d?.flag_enabled, true, "cx-40c: …og flagget var påslått, så de to bitene er tydelig atskilt");
        }

        // ═══ cx-41..cx-44: rå-fallback — rendering skal aldri TREKKE FRA ═══
        //
        // 67northdistillery.no, målt 2026-08-16: adressen ligger som en streng
        // inne i sidebyggerens <script>-nyttelast, og den PURE uttrekkeren
        // returnerer {"source":"embedded_same_domain"} mot rå-HTML-en. En
        // vellykket render gir tilbake DOM-en etter JS — nyttelasten er borte
        // fra den. Uten fallbacken ville altså det å koble inn rendering vært
        // en netto REGRESJON for nettopp den klassen nettsted den ble bygget
        // for.
        //
        // EMBEDDED_SHELL er den formen: et JS-skall der adressen finnes KUN i
        // script-strengene, og en rendret DOM uten adressen i det hele tatt.
        {
          const EMBEDDED_SHELL =
            "<html><head><title>Rå Gard</title></head><body><div id=root></div>" +
            '<script>{"A":"post@raagard.no\\n","B":"' + "x".repeat(3000) + '"}</script></body></html>';
          const RENDERED_NO_EMAIL =
            "<html><body><h1>Rå Gard Destilleri</h1><p>Vi lager akevitt.</p></body></html>";

          globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
            const u = String(url);
            if (u.startsWith("https://raagard.no")) return mkHtmlResponse(u, EMBEDDED_SHELL);
            return (cxMockFetch3 as typeof fetch)(url as any, init);
          }) as unknown as typeof fetch;
          opplevelserModule.__setGardssalgRenderPageImplForTesting((async (u: string) => ({
            ok: true as const,
            html: RENDERED_NO_EMAIL,
            finalUrl: u,
            text: RENDERED_NO_EMAIL.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
            elapsedMs: 30,
          })) as any);
          ins.run({ id: "cx-raw", navn: "Rå Gard", pt: "destilleri", hj: "https://raagard.no", ep: null, tlf: null, cs: null, created: "2026-04-03" });

          const r = await callRoute({ providerIds: ["cx-raw"] });
          const c = (r.body.changed as any[]).find((x) => x.provider_id === "cx-raw");
          assertEq(c?.epost, "post@raagard.no",
            "cx-41: adressen overlever renderingen — hentet fra RÅ-dokumentet da den rendrede DOM-en ikke hadde den");
          assertEq(c?.email_source, "embedded_same_domain",
            "cx-42: …via embedded-nivået, klassifiseringen bevart");
          assertEq(c?.email_from_raw, true,
            "cx-43: og rapporten SIER at den kom fra rå-laget — et andrevalgs-nivå skal ikke se ut som et førstevalg");
          const d = (r.body.render_diagnostic as any[]).find((x) => x.provider_id === "cx-raw");
          assertEq(d?.ok, true, "cx-43b: renderingen lyktes — fallbacken er ikke en maskering av en render-feil");

          // cx-44: den rendrede siden vinner når den HAR adressen. Rå brukes
          // bare som andresjanse, aldri som erstatning — og da settes ikke
          // email_from_raw, så flagget forblir et ekte signal.
          opplevelserModule.__setGardssalgRenderPageImplForTesting((async (u: string) => {
            const html = '<html><body>Kontakt: <a href="mailto:post@raagard.no">post@raagard.no</a></body></html>';
            return { ok: true as const, html, finalUrl: u, text: "Kontakt: post@raagard.no", elapsedMs: 30 };
          }) as any);
          expDb.prepare("UPDATE experience_providers SET epost=NULL WHERE id='cx-raw'").run();
          const r2 = await callRoute({ providerIds: ["cx-raw"] });
          const c2 = (r2.body.changed as any[]).find((x) => x.provider_id === "cx-raw");
          assertEq(c2?.email_source, "mailto",
            "cx-44: rendret treff vinner og beholder sin egen (høyere-tillits) klassifisering");
          assertEq(c2?.email_from_raw, undefined,
            "cx-44b: …og rå-flagget settes ikke når rå aldri ble brukt");
        }

        // ═══ cx-45..cx-49: team-sider + pages_read (Eik & Tid / Frøya) ═══
        //
        // Daniel, 2026-08-17, med skjermbilde: adressene står rett på siden.
        // eiktid.no har INGEN kontaktside — de fire lenkene er /, /the-brewery/,
        // /the-beer/ og /the-team/, og alle tre adressene står på den siste.
        // Ruta hentet /the-brewery/, fant ingenting, og rapporterte produsenten
        // som helt uten kontaktinfo. Siden var alltid lesbar; den ble aldri
        // etterspurt.
        {
          opplevelserModule.__setGardssalgRenderPageImplForTesting(null);
          delete process.env.GARDSSALG_HEADLESS_FALLBACK_ENABLED;
          const FRONT_EIKTID =
            '<html><body><nav><a href="/">Home</a><a href="/the-brewery/">The Brewery</a>' +
            '<a href="/the-beer/">The Beer</a><a href="/the-team/">The Team</a></nav>' +
            "<p>Eik &amp; Tid brygger kveik.</p></body></html>";
          const TEAM_EIKTID =
            "<html><body><h1>OUR TEAM</h1><p>Bjørn Harald Færøvik — GM / BREWER / OWNER<br>" +
            "Phone: +47 24 02 22 12<br>Email: bjorn@eiktid.no</p></body></html>";
          const BREWERY_EIKTID = "<html><body><h1>The Brewery</h1><p>Vi startet i 2015.</p></body></html>";

          globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
            const u = String(url);
            if (u.includes("eiktidtest.no/the-team")) return mkHtmlResponse(u, TEAM_EIKTID);
            if (u.includes("eiktidtest.no/the-brewery")) return mkHtmlResponse(u, BREWERY_EIKTID);
            if (u.startsWith("https://eiktidtest.no")) return mkHtmlResponse(u, FRONT_EIKTID);
            return (cxMockFetch3 as typeof fetch)(url as any, init);
          }) as unknown as typeof fetch;
          ins.run({ id: "cx-team", navn: "Eik Test", pt: "bryggeri", hj: "https://eiktidtest.no", ep: null, tlf: null, cs: null, created: "2026-04-04" });

          const r = await callRoute({ providerIds: ["cx-team"] });
          const c = (r.body.changed as any[]).find((x) => x.provider_id === "cx-team");
          assertEq(c?.epost, "bjorn@eiktid.no",
            "cx-45: adressen på TEAM-siden blir funnet — siden var alltid lesbar, den ble bare aldri hentet");
          assertEq(c?.telefon, "24022212", "cx-45b: …og telefonen fra samme side");
          assertTrue(String(c?.source_url || "").includes("/the-team"),
            "cx-45c: proveniens peker på team-siden");
        }

        // ── cx-46: en ekte kontaktside slår team-siden. En generell postkasse
        //    er et bedre outreach-mål enn en navngitt persons adresse, så
        //    team er en RESERVE, ikke en konkurrent. ─────────────────────────
        {
          const FRONT_BOTH =
            '<html><body><a href="/the-team/">Team</a><a href="/kontakt">Kontakt</a></body></html>';
          globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
            const u = String(url);
            if (u.includes("beggeto.no/the-team")) return mkHtmlResponse(u, "<html><body>Email: person@beggeto.no</body></html>");
            if (u.includes("beggeto.no/kontakt")) return mkHtmlResponse(u, "<html><body>Kontakt: post@beggeto.no</body></html>");
            if (u.startsWith("https://beggeto.no")) return mkHtmlResponse(u, FRONT_BOTH);
            return (cxMockFetch3 as typeof fetch)(url as any, init);
          }) as unknown as typeof fetch;
          ins.run({ id: "cx-both", navn: "Begge To", pt: "bryggeri", hj: "https://beggeto.no", ep: null, tlf: null, cs: null, created: "2026-04-05" });
          const r = await callRoute({ providerIds: ["cx-both"] });
          const c = (r.body.changed as any[]).find((x) => x.provider_id === "cx-both");
          assertEq(c?.epost, "post@beggeto.no",
            "cx-46: kontaktsidens generelle postkasse vinner over team-sidens personadresse — selv om team-lenken står FØRST i dokumentet");
        }

        // ── cx-47..49: pages_read — «pages_tried: 3» var et tall uten noe bak.
        //    Uten dette kunne ikke Frøya avgjøres: rendret, fant ingenting, og
        //    ingen respons kunne si HVILKE sider som ble lest eller hvor mye
        //    tekst hver ga. ──────────────────────────────────────────────────
        {
          globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
            const u = String(url);
            if (u.includes("tomgard.no/kontakt")) return mkHtmlResponse(u, "<html><body>Skjema uten adresse. Fyll ut under.</body></html>");
            if (u.startsWith("https://tomgard.no")) return mkHtmlResponse(u, '<html><body><a href="/kontakt">Kontakt</a>Tom Gard</body></html>');
            return (cxMockFetch3 as typeof fetch)(url as any, init);
          }) as unknown as typeof fetch;
          ins.run({ id: "cx-tom", navn: "Tom Gard", pt: "bryggeri", hj: "https://tomgard.no", ep: null, tlf: null, cs: null, created: "2026-04-06" });
          const r = await callRoute({ providerIds: ["cx-tom"] });
          const n = (r.body.no_contact_found as any[]).find((x) => x.provider_id === "cx-tom");
          assertTrue(!!n, "cx-47: raden havner i no_contact_found (kontaktskjema uten adresse — ekte negativ, som Druehagen)");
          assertTrue(Array.isArray(n?.pages_read) && n.pages_read.length === n.pages_tried,
            "cx-48: pages_read har én rad per side som faktisk ble lest, og stemmer med pages_tried");
          const kontakt = (n?.pages_read as any[]).find((p) => String(p.url).includes("/kontakt"));
          assertTrue(!!kontakt, "cx-48b: kontaktsiden er navngitt — ikke bare talt");
          assertTrue((kontakt?.visible_chars ?? 0) > 20,
            "cx-49: …med hvor mye tekst den faktisk ga, som er det som skiller en render-svikt fra en side uten adresse");
          assertEq(kontakt?.contactish, true, "cx-49b: og om siden ble regnet som kontaktside");
          assertEq(kontakt?.rendered, false, "cx-49c: og om den ble rendret (her: nei, server-rendret side)");
        }

        // ── cx-50..53: skrive-tids-domenegjerdet (dev-request 2026-08-17-
        //    kontaktadresse-feilkilde-og-override, Skive C(a)). En mailto på
        //    et FREMMED domene (Skive B klassifiserer den som
        //    `mailto_other_domain` + needsReview) skrives ikke lenger som en
        //    publiserbar adresse: den havner i review-køen
        //    (field_provenance.contact_email_flagged_review) og rapporteres i
        //    responsen. Telefonen fra samme side er upåvirket — gjerdet
        //    gjelder bare e-post. ────────────────────────────────────────────
        {
          const FOREIGN_MAILTO =
            '<html><body><h1>Fremmedgård</h1><p>Tlf: 41 41 41 41</p>' +
            '<a href="mailto:tg@distributoren-as.no">Kontakt oss</a></body></html>';
          globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
            const u = String(url);
            if (u.startsWith("https://fremmedgard.no")) return mkHtmlResponse(u, FOREIGN_MAILTO);
            return (cxMockFetch3 as typeof fetch)(url as any, init);
          }) as unknown as typeof fetch;
          ins.run({ id: "cx-foreign", navn: "Fremmed Gard", pt: "bryggeri", hj: "https://fremmedgard.no", ep: null, tlf: null, cs: null, created: "2026-04-07" });

          const r = await callRoute({ providerIds: ["cx-foreign"], apply: true });
          const flagged = (r.body.contact_email_flagged_for_review as any[]).find((x) => x.provider_id === "cx-foreign");
          assertEq(flagged?.candidate_email, "tg@distributoren-as.no",
            "cx-50: fremmed-domene-kandidaten rapporteres i contact_email_flagged_for_review");
          assertEq(flagged?.website_domain, "fremmedgard.no", "cx-50b: …med hjemmesidedomenet den er uenig med");
          assertEq(flagged?.email_domain, "distributoren-as.no", "cx-50c: …og e-postdomenet");
          const rowForeign = expDb.prepare(
            "SELECT epost, telefon, field_provenance FROM experience_providers WHERE id='cx-foreign'"
          ).get() as any;
          assertEq(rowForeign?.epost, null, "cx-51: adressen er IKKE skrevet til raden");
          assertEq(rowForeign?.telefon, "41414141", "cx-51b: telefonen fra samme side skrives som før — gjerdet gjelder kun e-post");
          assertEq(
            JSON.parse(rowForeign?.field_provenance || "{}").contact_email_flagged_review?.flagged_email,
            "tg@distributoren-as.no",
            "cx-52: kandidaten er stemplet i review-køen, ikke stille droppet",
          );
          const changedForeign = (r.body.changed as any[]).find((x) => x.provider_id === "cx-foreign");
          assertTrue(!(changedForeign?.fields ?? []).includes("epost"),
            "cx-53: den flaggede adressen dukker aldri opp som skrevet epost i changed[]");
          assertEq(changedForeign?.epost ?? null, null, "cx-53b: …og rapporteres ikke som skrevet verdi heller");
        }

        opplevelserModule.__setGardssalgRenderPageImplForTesting(null);
        if (prevFlag === undefined) delete process.env.GARDSSALG_HEADLESS_FALLBACK_ENABLED;
        else process.env.GARDSSALG_HEADLESS_FALLBACK_ENABLED = prevFlag;
        restoreFetch();
      }
    } catch (err: any) {
      failed++;
      failures.push("gardssalg-contact-extraction: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
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
  runGardssalgContactExtractionTests({ log: true }).then((s) => {
    console.log(`\ngardssalg-contact-extraction: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) process.exit(1);
  });
}
