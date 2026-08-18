/**
 * opplevelser-veien-til-pool.test.ts — dev-request
 * 2026-08-10-veien-til-pool-berikelseskjede-og-koedrenering, skive 1.
 *
 * Tre mangler gjorde at berikelseskjeden ikke fullførte, målt mot prod
 * 2026-08-10. Hver test her binder seg til den konkrete feilen:
 *
 *   vp-1..vp-5    providerIds i kontaktuttrekket (AK1). Uten parameteren kunne
 *                 ruta bare kjøre hele kohorten, så EN dårlig kandidat i
 *                 bunken tvang oss til å droppe hele kjøringen — og 67 North
 *                 Distillerys egen korrekte adresse ble stående uskrevet.
 *                 Innsnevring skal ALDRI utvide: alle eksisterende vern
 *                 (fill-only, låst rad, testrad, uten hjemmeside) må overleve.
 *
 *   vp-6..vp-11   Paraply-vernet (AK2). En kohortkjøring ville skrevet
 *                 post@norskedestillerier.no til Norstill (interesse-
 *                 organisasjon for ~40 destillerier) og
 *                 post@mosseolets-venner.no til Moss Bryggeri (medlems-
 *                 forening). Daniels regel: e-post til DEM, aldri til
 *                 paraplyen. Vernet må også IKKE slå ut på legitime
 *                 av-domene-adresser (by-gaard.no for By Brenneri) — «ikke
 *                 blokker unødvendig» er en del av kravet.
 *
 *   vp-12..vp-17  Navneoverlapp for manual_verified (AK4). Brreg-navnet er
 *                 ofte et juridisk foretaksnavn som leser annerledes enn
 *                 handelsnavnet — BALHOLM AS, «KARIN MO VALLAND /
 *                 SJURAGARDEN», «ARILD HEBNES». Likhet ville avvist alle tre;
 *                 «AS» alene må aldri utgjøre enighet.
 *
 *   vp-18..vp-24  content-clear (AK6). Fill-only-oppfriskningen går forbi et
 *                 felt fylt med FEIL innhold, og rollback restaurerer bare
 *                 forrige reviderte verdi (som for Geiranger Bryggeri selv var
 *                 skrapet — kjeden endte i already_current). Leveren må tømme
 *                 KUN navngitte rader, avvise ukjent felt, og aldri sveipe.
 *
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/routes/opplevelser-veien-til-pool.test.ts
 */

import type {} from "node";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runVeienTilPoolTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    process.env.ADMIN_KEY = process.env.ADMIN_KEY || "vp-test-key";
    const testKey = process.env.ADMIN_KEY;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const opplevelserModule = require("./opplevelser") as typeof import("./opplevelser");
      const opplevelserRouter = opplevelserModule.default as any;

      const call = (
        path: string,
        routeBody: Record<string, unknown>,
      ): Promise<{ status: number; body: any }> => {
        const req: any = {
          method: "POST",
          url: path,
          originalUrl: `/api/opplevelser${path}`,
          path,
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

      const ins = expDb.prepare(
        `INSERT INTO experience_providers (id, navn, vertical, producer_type, hjemmeside, epost, telefon, about_text, visit_text, content_source, created_at)
         VALUES (@id, @navn, 'experiences', @pt, @hj, @ep, @tlf, @ab, @vt, @cs, @created)`
      );
      const seed = (o: Partial<Record<string, unknown>> & { id: string; navn: string }) =>
        ins.run({ pt: "bryggeri", hj: "https://x.example.no", ep: null, tlf: null, ab: null, vt: null, cs: null, created: "2026-01-01", ...o });

      seed({ id: "vp-a", navn: "Alfa Bryggeri", hj: "https://alfa.example.no", created: "2026-01-01" });
      seed({ id: "vp-b", navn: "Beta Sideri", pt: "sideri", hj: "https://beta.example.no", created: "2026-01-02" });
      seed({ id: "vp-c", navn: "Gamma Gard", hj: "https://gamma.example.no", created: "2026-01-03" });
      seed({ id: "vp-locked", navn: "Laast Gard", hj: "https://laast.example.no", cs: "claim", created: "2026-01-04" });
      seed({ id: "vp-test", navn: "Testrad", pt: "test-gardssalg", hj: "https://t.example.no", created: "2026-01-05" });
      seed({ id: "vp-nosite", navn: "Uten Side", hj: null, created: "2026-01-06" });
      seed({ id: "vp-full", navn: "Har Alt", hj: "https://full.example.no", ep: "post@full.example.no", tlf: "99887766", created: "2026-01-07" });
      seed({ id: "vp-manual", navn: "Manuell Gard", hj: "https://manuell.example.no", cs: "manual", created: "2026-01-08" });

      // ═══ vp-1..vp-5: providerIds snevrer inn, utvider aldri (AK1) ═══
      {
        const all = expStore.selectGardssalgProvidersForContactExtraction(50, 0);
        const one = expStore.selectGardssalgProvidersForContactExtraction(50, 0, ["vp-b"]);
        assertEq(one.targets.length, 1, "vp-1: providerIds=[vp-b] gir nøyaktig én rad");
        assertEq(one.targets[0]?.id, "vp-b", "vp-2: og det er den navngitte raden");
        assertTrue(all.targets.length > one.targets.length, "vp-3: kohortkallet uten providerIds er fortsatt bredere");
        assertEq(one.cohortTotal, 1, "vp-4: cohortTotal reflekterer innsnevringen (ikke hele kohorten)");

        // Innsnevring må ikke kunne OMGÅ eksisterende vern:
        const guarded = expStore.selectGardssalgProvidersForContactExtraction(50, 0, [
          "vp-locked", "vp-test", "vp-nosite", "vp-full",
        ]);
        assertEq(guarded.targets.length, 0,
          "vp-5: navngitt låst/test/uten-hjemmeside/allerede-utfylt rad slipper fortsatt IKKE gjennom");
      }

      // ═══ vp-6..vp-11: paraply-vernet (AK2) ═══
      {
        const u = expStore.isUmbrellaContactEmail;
        assertEq(u("post@norskedestillerier.no"), true, "vp-6: bransjeforeningens adresse avvises");
        assertEq(u("post@mosseolets-venner.no"), true, "vp-7: medlemsforeningens adresse avvises");
        assertEq(u("POST@NorskeDestillerier.NO"), true, "vp-8: sjekken er case-insensitiv");
        assertEq(u("post@mail.norskedestillerier.no"), true, "vp-9: subdomene av paraplyen avvises også");
        // «Ikke blokker unødvendig»: legitime av-domene-adresser må slippe gjennom.
        assertEq(u("hermod.fledsberg@by-gaard.no"), false,
          "vp-10: By Brenneris egen av-domene-adresse blokkeres IKKE");
        assertEq(u("post@67northdistillery.no"), false, "vp-11a: produsentens egen adresse blokkeres ikke");
        assertEq(u(""), false, "vp-11b: tom streng er ikke en paraplyadresse");
        assertEq(u(null), false, "vp-11c: null er ikke en paraplyadresse");
        assertEq(u("ikke-en-adresse"), false, "vp-11d: streng uten @ er ikke en paraplyadresse");
      }

      // ═══ vp-12..vp-17: navneoverlapp for manual_verified (AK4) ═══
      {
        const ov = opplevelserModule.brregNameOverlapsProviderName;
        assertEq(ov("Ciderhuset Balholm — Balestrand", "BALHOLM AS"), true,
          "vp-12: handelsnavn vs foretaksnavn — Balholm gjenkjennes");
        assertEq(ov("Sjuragarden", "KARIN MO VALLAND / SJURAGARDEN"), true,
          "vp-13: enkeltpersonforetak med produsentnavnet i seg godtas");
        assertEq(ov("Hebnes Vingård — Hebnes", "ARILD HEBNES"), true,
          "vp-14: personnavn-foretak med stedsnavnet godtas");
        assertEq(ov("Alde Sider / Ulvik Frukt & Cideri", "SIDER AS"), false,
          "vp-15: «sider» er filler-nært og skal ikke alene binde — feiltreffet fra 2026-08-10 avvises");
        assertEq(ov("Noe Bryggeri", "HELT ANNET AS"), false, "vp-16: ingen felles token = ingen enighet");
        assertEq(ov("Kun AS", "OGSÅ AS"), false, "vp-17a: «AS» alene utgjør aldri enighet");
        assertEq(ov("", "BALHOLM AS"), false, "vp-17b: tomt produsentnavn gir aldri enighet");
        assertEq(ov("Balholm", null), false, "vp-17c: manglende Brreg-navn gir aldri enighet");
      }

      // ═══ vp-18..vp-24: content-clear (AK6) ═══
      {
        expDb.prepare(`UPDATE experience_providers SET about_text = ? WHERE id = ?`)
          .run("Vikingstøa er ein spenstig pale ale — skrapet produktomtale", "vp-a");
        expDb.prepare(`UPDATE experience_providers SET about_text = ? WHERE id = ?`)
          .run("Ekte og riktig tekst om Beta Sideri", "vp-b");

        const bad = await call("/admin/gardssalg-content-clear", { providerIds: ["vp-a"], field_name: "epost" });
        assertEq(bad.status, 400, "vp-18: et felt utenfor tillatt liste avvises med 400");

        const noIds = await call("/admin/gardssalg-content-clear", { providerIds: [], field_name: "about_text" });
        assertEq(noIds.status, 400, "vp-19: tom providerIds avvises — ingen sveip-modus finnes");

        const dry = await call("/admin/gardssalg-content-clear", { providerIds: ["vp-a"], field_name: "about_text" });
        assertEq(dry.body?.dry_run, true, "vp-20: default er tørrkjøring");
        assertEq(dry.body?.cleared_count, 1, "vp-21: tørrkjøringen rapporterer én rad som ville blitt tømt");
        const stillThere = expDb.prepare(`SELECT about_text FROM experience_providers WHERE id = 'vp-a'`).get() as any;
        assertTrue((stillThere?.about_text ?? "") !== "", "vp-22: tørrkjøring skrev INGENTING");

        const applied = await call("/admin/gardssalg-content-clear", {
          providerIds: ["vp-a"], field_name: "about_text", apply: true,
        });
        assertEq(applied.body?.cleared_count, 1, "vp-23a: apply tømmer den navngitte raden");
        const cleared = expDb.prepare(`SELECT about_text FROM experience_providers WHERE id = 'vp-a'`).get() as any;
        assertTrue((cleared?.about_text ?? "") === "" || cleared?.about_text === null,
          "vp-23b: feltet er faktisk tomt etterpå");
        const untouched = expDb.prepare(`SELECT about_text FROM experience_providers WHERE id = 'vp-b'`).get() as any;
        assertEq(untouched?.about_text, "Ekte og riktig tekst om Beta Sideri",
          "vp-24a: en rad som IKKE ble navngitt er urørt — leveren sveiper aldri");

        const audit = expDb
          .prepare(`SELECT COUNT(*) AS n FROM gardssalg_content_audit WHERE provider_id = 'vp-a' AND field_name = 'about_text'`)
          .get() as any;
        assertTrue((audit?.n ?? 0) > 0,
          "vp-24b: tømmingen er revisjonsført, så den kan rulles tilbake som enhver annen innholdsskriving");

        const again = await call("/admin/gardssalg-content-clear", {
          providerIds: ["vp-a"], field_name: "about_text", apply: true,
        });
        assertEq(again.body?.skipped?.[0]?.reason, "already_blank",
          "vp-24c: å kjøre den på nytt er trygt — allerede tom rapporteres, ikke skrives");

        // ═══ vp-25..vp-29: opening_hours_text i CLEARABLE (dev-request
        // 2026-08-18-apningstider-llm-dommer, spec D) — feltet gikk fra en
        // rå regex-skiver til en LLM-generert kandidat, og kan derfor bli
        // like kontaminert som about_text/visit_text kan. Samme sperrer.
        expDb.prepare(`UPDATE experience_providers SET opening_hours_text = ? WHERE id = ?`)
          .run("Previous Next Man-fre 10-18 Søk", "vp-c");
        expDb.prepare(`UPDATE experience_providers SET opening_hours_text = ? WHERE id = ?`)
          .run("Man-fre 10-18", "vp-manual");
        expDb.prepare(`UPDATE experience_providers SET opening_hours_text = ?, field_provenance = ? WHERE id = ?`)
          .run(
            "Lør 10-14",
            JSON.stringify({ owner_locks: { opening_hours_text: { locked_at: "2026-08-01T00:00:00.000Z" } } }),
            "vp-locked",
          );

        const hoursDry = await call("/admin/gardssalg-content-clear", {
          providerIds: ["vp-c"], field_name: "opening_hours_text",
        });
        assertEq(hoursDry.status, 200, "vp-25: opening_hours_text er nå et gyldig felt for denne leveren (ikke 400)");
        assertEq(hoursDry.body?.cleared_count, 1, "vp-26: tørrkjøringen ser en tømbar rad for opening_hours_text");

        const hoursApplied = await call("/admin/gardssalg-content-clear", {
          providerIds: ["vp-c"], field_name: "opening_hours_text", apply: true,
        });
        assertEq(hoursApplied.body?.cleared_count, 1, "vp-27a: apply tømmer opening_hours_text på den navngitte raden");
        const hoursCleared = expDb.prepare(`SELECT opening_hours_text FROM experience_providers WHERE id = 'vp-c'`).get() as any;
        assertTrue((hoursCleared?.opening_hours_text ?? "") === "" || hoursCleared?.opening_hours_text === null,
          "vp-27b: feltet er faktisk tomt etterpå");
        const hoursAudit = expDb
          .prepare(`SELECT COUNT(*) AS n FROM gardssalg_content_audit WHERE provider_id = 'vp-c' AND field_name = 'opening_hours_text'`)
          .get() as any;
        assertTrue((hoursAudit?.n ?? 0) > 0, "vp-27c: tømmingen av opening_hours_text er revisjonsført akkurat som de to andre feltene");

        // Samme sperrer som about_text/visit_text allerede respekterer må
        // gjelde IDENTISK for det nye feltet.
        const manualBlocked = await call("/admin/gardssalg-content-clear", {
          providerIds: ["vp-manual"], field_name: "opening_hours_text", apply: true,
        });
        assertEq(manualBlocked.body?.skipped?.[0]?.reason, "write_refused_locked_or_manual",
          "vp-28: content_source='manual' sperrer opening_hours_text akkurat som about_text/visit_text");
        const manualUntouched = expDb.prepare(`SELECT opening_hours_text FROM experience_providers WHERE id = 'vp-manual'`).get() as any;
        assertEq(manualUntouched?.opening_hours_text, "Man-fre 10-18", "vp-28b: den manuelle radens verdi er urørt");

        const claimOwnerLockedBlocked = await call("/admin/gardssalg-content-clear", {
          providerIds: ["vp-locked"], field_name: "opening_hours_text", apply: true,
        });
        assertEq(claimOwnerLockedBlocked.body?.skipped?.[0]?.reason, "write_refused_locked_or_manual",
          "vp-29: en eier-låst opening_hours_text (field_provenance.owner_locks) sperrer akkurat som for de to andre feltene");
        const claimUntouched = expDb.prepare(`SELECT opening_hours_text FROM experience_providers WHERE id = 'vp-locked'`).get() as any;
        assertEq(claimUntouched?.opening_hours_text, "Lør 10-14", "vp-29b: den eier-låste radens verdi er urørt");
      }
    } catch (err: any) {
      failed++;
      failures.push("veien-til-pool: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
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
  runVeienTilPoolTests({ log: true }).then((s) => {
    console.log(`\nveien-til-pool: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) process.exit(1);
  });
}
