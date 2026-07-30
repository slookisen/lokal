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
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      const callRoute = (routeBody: Record<string, unknown>): Promise<{ status: number; body: any }> => {
        const req: any = {
          method: "POST",
          url: "/admin/gardssalg-contact-extraction",
          originalUrl: "/api/opplevelser/admin/gardssalg-contact-extraction",
          path: "/admin/gardssalg-contact-extraction",
          query: {},
          body: routeBody,
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
      const fetchCalls: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        fetchCalls.push(u);
        if (u.startsWith("https://fjellbrygg.no/kontakt")) {
          return { ok: true, status: 200, url: u, text: async () =>
            '<html><body>Kontakt oss: <a href="mailto:post@fjellbrygg.no">post@fjellbrygg.no</a> — tlf 912 34 567</body></html>' } as unknown as Response;
        }
        if (u === "https://fjellbrygg.no" || u === "https://fjellbrygg.no/") {
          return { ok: true, status: 200, url: u, text: async () =>
            '<html><body>Fjellbrygg — håndverksøl. feil@aggregator.no <a href="/kontakt">Kontakt</a></body></html>' } as unknown as Response;
        }
        if (u.startsWith("https://delvis.no")) {
          return { ok: true, status: 200, url: u, text: async () =>
            "<html><body>Delvis vingård. Ring 45 67 89 01 for besøk</body></html>" } as unknown as Response;
        }
        return { ok: false, status: 404, url: u, text: async () => "" } as unknown as Response;
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
