/**
 * opplevelser-veien-til-pool-skive2.test.ts — dev-request
 * 2026-08-10-veien-til-pool-berikelseskjede-og-koedrenering, skive 2.
 *
 * Skive 1 (PR #554, `ea34294`) fixed the three leaks that stopped the
 * enrichment chain from ever completing. This file tests skive 2 — the new
 * POST /admin/gardssalg-veien-til-pool routine that walks a batch of
 * not-yet-`outreach_ready` providers through nettsted -> kontakt -> innhold
 * -> org.nr -> brreg-verifisering -> ny tiering, reusing the existing
 * guarded endpoints in-process for every write.
 *
 *   vtp2-1..vtp2-4   Pure helpers: gardssalgWebsiteDomainAffiliated (krav 7 —
 *                    domain-affiliation, NOT page-text `verified:true` alone;
 *                    the exact 2026-08-10 Himkok Rtd/Måge Sider false
 *                    positives, and 67 North's real positive), plus its
 *                    org_nr/address bases and short-label guard.
 *   vtp2-5..vtp2-7   computeGardssalgVeienTilPoolMissing (AK7's "what's
 *                    still missing" list) and gsVtpParseSqliteUtcMs /
 *                    computeGardssalgQueueAgeReport (AK9's age/staleness
 *                    math) as pure functions.
 *   vtp2-8..vtp2-10  Route plumbing: unauthenticated -> 403; empty/oversized
 *                    providerIds -> 400; a concurrent second call -> 409
 *                    (same kjørelås idiom as contact-extraction/brreg-verify).
 *   vtp2-11..vtp2-13 AK7 end-to-end: a batch walked through the full chain
 *                    reports, per provider, tier_before/tier_after and
 *                    exactly what remains for pool — including an
 *                    already-`outreach_ready` row correctly EXCLUDED rather
 *                    than reprocessed.
 *   vtp2-14..vtp2-16 Nettsted-steget: a queued candidate whose DOMAIN does
 *                    not tie to the producer stays queued and unwritten
 *                    (krav 7, "verified:true alone is not enough"); a
 *                    domain-affiliated candidate is approved AND
 *                    live-verified in one run; an unverified live classify
 *                    lands the row back in the queue (krav 8 — a queue that
 *                    actually gets fed, not just read).
 *   vtp2-17..vtp2-18 AK8: a classified fetch FAILURE on the kontakt step and
 *                    on the innhold step both report "retry_later" and write
 *                    NOTHING — never "not found", never a clear.
 *   vtp2-19..vtp2-20 org.nr-steget: no Brreg candidate queues (genuine
 *                    absence, reported with a reason); brreg-verifisering
 *                    writes brreg_verified from live registry evidence once
 *                    org_nr is present.
 *   vtp2-21          AK9: the queue-age report surfaces an old,
 *                    artificially-backdated queue row as `stale:true` and
 *                    first in `oldest_first`, on every run.
 *
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/routes/opplevelser-veien-til-pool-skive2.test.ts
 */

import type {} from "node";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runVeienTilPoolSkive2Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    process.env.ADMIN_KEY = process.env.ADMIN_KEY || "vtp2-test-key";
    const testKey = process.env.ADMIN_KEY;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    // Same fresh-require pairing opplevelser-gardssalg-website-verification
    // .test.ts uses for this exact module: gardssalg-website-verification.ts
    // imports upsertGardssalgWebsiteReviewQueue/listGardssalgWebsiteReviewQueue
    // from experience-store.ts at ITS OWN load time — if this module is left
    // cached from an earlier suite while experience-store.ts is busted+
    // refreshed, it keeps calling the STALE experience-store instance's
    // DB-bound functions against a since-closed connection, surfacing as a
    // FOREIGN KEY constraint failure only under full-suite run order (the
    // exact module-instance-divergence class documented at the top of
    // tests/test.ts).
    const websiteVerificationServicePath = require.resolve("../services/gardssalg-website-verification");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, websiteVerificationServicePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    const prevFetch = globalThis.fetch;
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const brregClient = require("../services/brreg-client") as typeof import("../services/brreg-client");
      brregClient.__clearBrregCacheForTesting();
      brregClient.__clearBrregVerifyCacheForTesting();
      const opplevelserModule = require("./opplevelser") as typeof import("./opplevelser");
      const opplevelserRouter = opplevelserModule.default as any;

      const call = (
        path: string,
        routeBody: Record<string, unknown>,
        reqExtra: Record<string, unknown> = {},
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
      const callVtp = (body: Record<string, unknown>, reqExtra: Record<string, unknown> = {}) =>
        call("/admin/gardssalg-veien-til-pool", body, reqExtra);

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, producer_type, hjemmeside, epost, telefon, org_nr, adresse,
            about_text, products, brreg_verified, catalog_hidden, slug, content_source,
            field_provenance, created_at)
         VALUES (@id, @navn, 'experiences', @pt, @hj, @ep, @tlf, @org_nr, @adresse,
                 @ab, @products, @brreg_verified, @catalog_hidden, @slug, @cs,
                 @field_provenance, @created)`
      );
      const seed = (o: Partial<Record<string, unknown>> & { id: string; navn: string }) =>
        insertProvider.run({
          pt: "bryggeri", hj: null, ep: null, tlf: null, org_nr: null, adresse: null,
          ab: null, products: null, brreg_verified: 0, catalog_hidden: 0, slug: null,
          cs: null, field_provenance: null, created: "2026-01-01",
          ...o,
        });

      const verifiedProvenance = (extra?: Record<string, unknown>) =>
        JSON.stringify({ hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-08-01T00:00:00Z", ...extra } });

      // ═══ vtp2-1..vtp2-4: gardssalgWebsiteDomainAffiliated (PURE, krav 7) ═══
      {
        const aff = opplevelserModule.gardssalgWebsiteDomainAffiliated;
        assertEq(aff("https://67northdistillery.no", { navn: "67 North Distillery" }), true,
          "vtp2-1: 67 North sitt EGET domene knytter seg til navnet (den kjente riktige raden)");
        assertEq(aff("https://olssonbarbieri.com", { navn: "Himkok Rtd" }), false,
          "vtp2-2: Himkok Rtd -> olssonbarbieri.com (designbyrå) — INGEN domenetilhørighet, avvises");
        assertEq(aff("https://tastehardanger.com", { navn: "Måge Sider" }), false,
          "vtp2-3: Måge Sider -> tastehardanger.com (reiselivsside) — avvises likeså");
        assertEq(aff("https://912345678.example", { navn: "Helt Urelatert Navn", org_nr: "912345678" }), true,
          "vtp2-4a: org.nr funnet i domenet alene er nok (org-basis), selv uten navnetreff");
        assertEq(aff("https://gamleveien12.example", { navn: "Ukjent Gard", adresse: "Gamleveien 12" }), true,
          "vtp2-4b: adresse funnet i domenet alene er nok (adresse-basis, >=6 tegn)");
        assertEq(aff("https://ab.example", { navn: "Ab Gard" }), false,
          "vtp2-4c: for kort domenelabel (<4 tegn) avvises alltid, uansett navn");
      }

      // ═══ vtp2-5: computeGardssalgVeienTilPoolMissing (PURE, AK7) ═══
      {
        const missingFn = opplevelserModule.computeGardssalgVeienTilPoolMissing;
        const readyRow: any = {
          readiness_tier: "outreach_ready", has_email: true, has_phone: true, has_website: true,
          has_about_text: true, has_products: true, website_verified: true, has_duplicate_conflict: false,
        };
        assertEq(missingFn(readyRow, true).length, 0, "vtp2-5a: outreach_ready -> ingenting mangler");
        const gapRow: any = {
          readiness_tier: "needs_enrichment", has_email: false, has_phone: false, has_website: true,
          has_about_text: false, has_products: true, website_verified: true, has_duplicate_conflict: false,
        };
        const missing = missingFn(gapRow, false);
        assertTrue(missing.includes("contact_method"), "vtp2-5b: mangler kontakt rapporteres");
        assertTrue(missing.includes("about_text"), "vtp2-5c: mangler about_text rapporteres");
        assertTrue(missing.includes("brreg_verified"), "vtp2-5d: manglende brreg_verified rapporteres");
        assertTrue(!missing.includes("hjemmeside"), "vtp2-5e: hjemmeside finnes -> IKKE i listen");
      }

      // ═══ vtp2-6..vtp2-7: dato/alder (PURE, AK9) ═══
      {
        const parse = opplevelserModule.gsVtpParseSqliteUtcMs;
        const sqliteMs = parse("2026-08-03 09:00:00");
        assertEq(new Date(sqliteMs).toISOString(), "2026-08-03T09:00:00.000Z",
          "vtp2-6: SQLite-formatert dato (mellomrom, ingen sone) tolkes som UTC");

        const nowMs = Date.parse("2026-08-10T09:00:00.000Z");
        const report = opplevelserModule.computeGardssalgQueueAgeReport(
          [
            { provider_id: "p-new", provider_name: "Ny", created_at: "2026-08-09 09:00:00", reason: "x" },
            { provider_id: "p-old", provider_name: "Gammel", created_at: "2026-07-20 09:00:00", reason: "y" },
          ],
          nowMs,
        );
        assertEq(report.count, 2, "vtp2-7a: begge radene telles");
        assertEq(report.oldest_first[0]?.provider_id, "p-old", "vtp2-7b: eldste først");
        assertEq(report.oldest_first[0]?.stale, true, "vtp2-7c: >7 dager -> stale");
        assertEq(report.oldest_first[1]?.stale, false, "vtp2-7d: 1 dag -> ikke stale");
        assertEq(report.stale_count, 1, "vtp2-7e: stale_count teller korrekt");
        assertEq(report.stale_threshold_days, opplevelserModule.GS_VTP_QUEUE_STALE_DAYS, "vtp2-7f: terskelen rapporteres");
      }

      // ═══ vtp2-8..vtp2-10: rute-plumbing ═══
      {
        const noKey = await call("/admin/gardssalg-veien-til-pool", {}, { headers: { "x-admin-key": "wrong" } });
        assertEq(noKey.status, 403, "vtp2-8: feil X-Admin-Key -> 403");

        const emptyIds = await callVtp({ providerIds: [] });
        assertEq(emptyIds.status, 400, "vtp2-9a: tom providerIds -> 400");
        const tooMany = await callVtp({ providerIds: Array.from({ length: 25 }, (_, i) => `id-${i}`) });
        assertEq(tooMany.status, 400, "vtp2-9b: for mange providerIds -> 400");

        seed({ id: "vtp2-lock", navn: "Lock Gard", hj: "https://lock.example.no" });
        const [ra, rb] = await Promise.all([
          callVtp({ providerIds: ["vtp2-lock"] }),
          callVtp({ providerIds: ["vtp2-lock"] }),
        ]);
        assertTrue(ra.status === 409 || rb.status === 409, "vtp2-10: en samtidig kjøring får 409 (kjørelås)");
      }

      // Shared fetch mock — every scenario below uses its OWN distinct host,
      // so one switch-style mock safely serves the whole file. Any
      // unrecognised URL falls through to a plain 404 (never silently hangs
      // or throws unexpectedly).
      const mockHeaders = { get: () => null } as unknown as Headers;
      const htmlResponse = (u: string, html: string): Response =>
        ({ ok: true, status: 200, statusText: "OK", url: u, headers: mockHeaders,
           arrayBuffer: async () => new TextEncoder().encode(html).buffer }) as unknown as Response;
      const notFoundResponse = (u: string): Response =>
        ({ ok: false, status: 404, statusText: "Not Found", url: u, headers: mockHeaders,
           arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) }) as unknown as Response;

      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        // ── nettsted: domenetilknyttet kandidat, live-verifisering lykkes ──
        if (u.startsWith("https://nordlygard.no")) {
          return htmlResponse(u, `<html><body>Nordly Gard, org.nr 912340001, alt om oss</body></html>`);
        }
        // ── nettsted: hjemmeside finnes men uverifisert -> live-sjekk feiler ──
        if (u.startsWith("https://mismatch-vtp2.example")) {
          return htmlResponse(u, `<html><body>Helt urelatert forsidetekst uten noen treff</body></html>`);
        }
        // ── kontakt-steget: klassifisert HENTEFEIL (AK8) ──
        if (u.startsWith("https://cx-fail-vtp2.example")) {
          throw Object.assign(new Error("read ECONNRESET"), { cause: { code: "ECONNRESET" } });
        }
        // ── innhold-steget: klassifisert HENTEFEIL (AK8) ──
        if (u.startsWith("https://cr-fail-vtp2.example")) {
          throw Object.assign(new Error("read ECONNRESET"), { cause: { code: "ECONNRESET" } });
        }
        // ── org.nr-steget: Brreg navnesøk, ingen treff ──
        if (u.includes("/enheter?navn=")) {
          return { ok: true, status: 200, json: async () => ({ _embedded: { enheter: [] } }) } as unknown as Response;
        }
        // ── brreg-verifisering: gyldig, aktiv, navnematch ──
        const dm = u.match(/\/enheter\/(\d{9})$/);
        if (dm && dm[1] === "912340099") {
          return { ok: true, status: 200, json: async () => ({ organisasjonsnummer: dm[1], navn: "Brreg Vingaard Gard" }) } as unknown as Response;
        }
        if (dm) {
          return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
        }
        return notFoundResponse(u);
      }) as unknown as typeof fetch;

      // ═══ vtp2-11..vtp2-13: AK7 ende-til-ende ═══
      {
        seed({
          id: "vtp2-bare", navn: "Bare Gard", hj: null,
          created: "2026-01-02",
        });
        seed({
          id: "vtp2-ready", navn: "Ferdig Gard", hj: "https://ferdig-vtp2.example", ep: "post@ferdig-vtp2.example",
          tlf: "91112233", org_nr: "912340077", ab: "Ekte og fyldig tekst om Ferdig Gard, mer enn tredve tegn lang.",
          products: JSON.stringify(["sider"]), brreg_verified: 1, slug: "ferdig-gard",
          field_provenance: verifiedProvenance(), created: "2026-01-03",
        });

        const res = await callVtp({ providerIds: ["vtp2-bare", "vtp2-ready"] });
        assertEq(res.status, 200, "vtp2-11: ruta svarer 200");
        assertEq(res.body.dry_run, true, "vtp2-11b: dry-run er default");
        assertTrue(
          (res.body.already_outreach_ready as any[]).some((r) => r.provider_id === "vtp2-ready"),
          "vtp2-12: allerede outreach_ready rad ekskluderes fra kjeden, ikke kjørt på nytt",
        );
        assertTrue(!(res.body.providers as any[]).some((p) => p.provider_id === "vtp2-ready"),
          "vtp2-12b: …og finnes derfor ikke i providers[]");

        const bare = (res.body.providers as any[]).find((p) => p.provider_id === "vtp2-bare");
        assertTrue(!!bare, "vtp2-13a: den ufullstendige raden ER med i providers[]");
        assertEq(bare.steps.website.status, "no_website_no_candidate", "vtp2-13b: nettsted-steget rapporterer riktig grunn");
        assertEq(bare.steps.contact.status, "blocked_no_website", "vtp2-13c: kontakt blokkeres av manglende nettsted, IKKE feilklassifisert");
        assertTrue(Array.isArray(bare.missing_for_pool) && bare.missing_for_pool.length > 0,
          "vtp2-13d: missing_for_pool lister konkret hva som gjenstår");
        assertTrue(bare.missing_for_pool.includes("hjemmeside"), "vtp2-13e: …inkludert selve hjemmesiden");
        assertTrue(!!bare.tier_before && !!bare.tier_after, "vtp2-13f: tier_before/tier_after er begge oppgitt");
      }

      // ═══ vtp2-14: nettsted — kø-kandidat UTEN domenetilhørighet ═══
      {
        seed({ id: "vtp2-queued-bad", navn: "Skal Forbli Kø Gard", hj: null, created: "2026-01-04" });
        const upsertQ = expDb.prepare(
          `INSERT INTO gardssalg_website_review_queue
             (id, provider_id, provider_name, candidate_url, final_url, evidence, confidence, reason, batch_id, created_at, updated_at)
           VALUES ('q-bad', 'vtp2-queued-bad', 'Skal Forbli Kø Gard', 'https://unrelated-agency-vtp2.example', NULL, NULL, NULL, 'website_discovery_candidate', NULL, datetime('now'), datetime('now'))`
        );
        upsertQ.run();

        const res = await callVtp({ providerIds: ["vtp2-queued-bad"], apply: true });
        const row = (res.body.providers as any[]).find((p) => p.provider_id === "vtp2-queued-bad");
        assertEq(row.steps.website.status, "queued_needs_domain_affiliation",
          "vtp2-14a: krav 7 — verified:true (om noen) alene skriver IKKE, domenet knytter seg ikke til produsenten");
        const stillQueued = expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_website_review_queue WHERE provider_id='vtp2-queued-bad'`).get() as any;
        assertEq(stillQueued.n, 1, "vtp2-14b: kø-raden lever fortsatt — ingen sveip, ingen sletting");
        const stillBlank = expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id='vtp2-queued-bad'`).get() as any;
        assertTrue(stillBlank.hjemmeside === null, "vtp2-14c: hjemmeside forblir ubeskrevet");
      }

      // ═══ vtp2-15: nettsted — domenetilknyttet kandidat, live-verifisering lykkes ═══
      {
        seed({ id: "vtp2-nordly", navn: "Nordly Gard", hj: null, org_nr: "912340001", created: "2026-01-05" });
        expDb.prepare(
          `INSERT INTO gardssalg_website_review_queue
             (id, provider_id, provider_name, candidate_url, final_url, evidence, confidence, reason, batch_id, created_at, updated_at)
           VALUES ('q-nordly', 'vtp2-nordly', 'Nordly Gard', 'https://nordlygard.no', NULL, NULL, NULL, 'website_discovery_candidate', NULL, datetime('now'), datetime('now'))`
        ).run();

        const res = await callVtp({ providerIds: ["vtp2-nordly"], apply: true });
        const row = (res.body.providers as any[]).find((p) => p.provider_id === "vtp2-nordly");
        assertEq(row.steps.website.status, "written_and_verified",
          "vtp2-15a: domenetilknyttet + ekte fetch-basert verifisering -> skrevet OG verifisert i samme kjøring");
        const written = expDb.prepare(`SELECT hjemmeside, field_provenance FROM experience_providers WHERE id='vtp2-nordly'`).get() as any;
        assertEq(written.hjemmeside, "https://nordlygard.no", "vtp2-15b: hjemmeside faktisk skrevet");
        assertTrue(String(written.field_provenance || "").includes('"verified":true'), "vtp2-15c: hjemmeside_verification.verified===true er stemplet");
        const cleared = expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_website_review_queue WHERE provider_id='vtp2-nordly'`).get() as any;
        assertEq(cleared.n, 0, "vtp2-15d: kø-raden er tømt etter en bekreftet skriving");
      }

      // ═══ vtp2-16: nettsted — eksisterende, uverifisert hjemmeside; live-sjekk feiler -> havner i kø ═══
      {
        seed({ id: "vtp2-mismatch", navn: "Mismatch Gard", hj: "https://mismatch-vtp2.example", created: "2026-01-06" });
        const before = expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_website_review_queue`).get() as any;

        const res = await callVtp({ providerIds: ["vtp2-mismatch"], apply: true });
        const row = (res.body.providers as any[]).find((p) => p.provider_id === "vtp2-mismatch");
        assertEq(row.steps.website.status, "queued_verification_failed",
          "vtp2-16a: krav 8 — en reell fetch-basert sjekk som IKKE finner bevis havner i køen (mates), ikke stille forkastet");
        const after = expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_website_review_queue`).get() as any;
        assertTrue(after.n > before.n, "vtp2-16b: …og køen faktisk fikk en ny rad (matbar, ikke bare lesbar)");
        const stillThere = expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id='vtp2-mismatch'`).get() as any;
        assertEq(stillThere.hjemmeside, "https://mismatch-vtp2.example", "vtp2-16c: den eksisterende hjemmesiden er urørt, ikke tømt");
      }

      // ═══ vtp2-17: AK8 — kontakt-steget, klassifisert hentefeil ═══
      {
        seed({
          id: "vtp2-cxfail", navn: "Cx Fail Gard", hj: "https://cx-fail-vtp2.example",
          field_provenance: verifiedProvenance(), created: "2026-01-07",
        });
        const res = await callVtp({ providerIds: ["vtp2-cxfail"], apply: true });
        const row = (res.body.providers as any[]).find((p) => p.provider_id === "vtp2-cxfail");
        assertEq(row.steps.contact.status, "retry_later", "vtp2-17a: klassifisert hentefeil -> prøv igjen, ALDRI «ikke funnet»");
        assertTrue(row.steps.contact.status !== "no_contact_found", "vtp2-17b: eksplisitt IKKE forvekslet med fravær");
        const stillBlank = expDb.prepare(`SELECT epost, telefon FROM experience_providers WHERE id='vtp2-cxfail'`).get() as any;
        assertTrue(stillBlank.epost === null && stillBlank.telefon === null, "vtp2-17c: ingenting skrevet/tømt ved hentefeil");
      }

      // ═══ vtp2-18: AK8 — innhold-steget, klassifisert hentefeil ═══
      {
        seed({
          id: "vtp2-crfail", navn: "Cr Fail Gard", hj: "https://cr-fail-vtp2.example",
          ep: "post@cr-fail-vtp2.example", tlf: "91234567",
          ab: "Eksisterende, ekte tekst som IKKE skal røres av en hentefeil.",
          field_provenance: verifiedProvenance(), created: "2026-01-08",
        });
        const res = await callVtp({ providerIds: ["vtp2-crfail"], apply: true });
        const row = (res.body.providers as any[]).find((p) => p.provider_id === "vtp2-crfail");
        assertEq(row.steps.content.status, "retry_later", "vtp2-18a: klassifisert hentefeil på innhold -> prøv igjen");
        const stillThere = expDb.prepare(`SELECT about_text FROM experience_providers WHERE id='vtp2-crfail'`).get() as any;
        assertEq(stillThere.about_text, "Eksisterende, ekte tekst som IKKE skal røres av en hentefeil.",
          "vtp2-18b: eksisterende about_text er urørt — hentefeil tømmer ALDRI et felt");
      }

      // ═══ vtp2-19: org.nr — ingen Brreg-kandidat (ekte fravær) -> kø ═══
      {
        seed({ id: "vtp2-noorgnr", navn: "Ukjentnavn I Brreg Xyz Gard", hj: "https://noorgnr-vtp2.example", created: "2026-01-09" });
        const before = expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_orgnr_review_queue`).get() as any;
        const res = await callVtp({ providerIds: ["vtp2-noorgnr"], apply: true });
        const row = (res.body.providers as any[]).find((p) => p.provider_id === "vtp2-noorgnr");
        assertEq(row.steps.orgnr.status, "queued", "vtp2-19a: ingen Brreg-treff -> kø, ikke feil");
        assertEq(row.steps.orgnr.reason, "no_brreg_candidate", "vtp2-19b: grunnen er den ekte, spesifikke årsaken");
        const after = expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_orgnr_review_queue`).get() as any;
        assertTrue(after.n > before.n, "vtp2-19c: org.nr-køen fikk faktisk en ny rad");
      }

      // ═══ vtp2-20: brreg-verifisering — org.nr finnes, blir verifisert ═══
      {
        seed({
          id: "vtp2-brregok", navn: "Brreg Vingaard Gard", hj: "https://brregok-vtp2.example",
          org_nr: "912340099", created: "2026-01-10",
        });
        const before = expDb.prepare(`SELECT brreg_verified FROM experience_providers WHERE id='vtp2-brregok'`).get() as any;
        assertEq(before.brreg_verified, 0, "vtp2-20a: sanity — starter uverifisert");
        const res = await callVtp({ providerIds: ["vtp2-brregok"], apply: true });
        const row = (res.body.providers as any[]).find((p) => p.provider_id === "vtp2-brregok");
        assertEq(row.steps.brreg.status, "written", "vtp2-20b: gyldig, aktiv, navnematch -> skrevet");
        const after = expDb.prepare(`SELECT brreg_verified FROM experience_providers WHERE id='vtp2-brregok'`).get() as any;
        assertEq(after.brreg_verified, 1, "vtp2-20c: brreg_verified er faktisk satt");
      }

      // ═══ vtp2-21: AK9 — køalder rapporteres hver kjøring, gammel rad flagges ═══
      {
        seed({ id: "vtp2-agecheck", navn: "Age Check Gard", hj: "https://agecheck-vtp2.example", created: "2026-01-11" });
        expDb.prepare(
          `INSERT INTO gardssalg_orgnr_review_queue
             (id, provider_id, provider_name, candidate_orgnr, candidate_name, candidate_confidence,
              candidate_address, reason, batch_id, created_at, updated_at)
           VALUES ('q-old-orgnr', 'vtp2-agecheck', 'Age Check Gard', NULL, NULL, NULL, NULL,
                   'no_brreg_candidate', NULL, '2026-07-01 00:00:00', '2026-07-01 00:00:00')`
        ).run();

        const res = await callVtp({ providerIds: ["vtp2-nordly"] }); // any small valid batch — queue report is global
        assertTrue(res.body.queues?.orgnr_review_queue?.count > 0, "vtp2-21a: org.nr-køen rapporteres på HVER kjøring");
        const oldRow = (res.body.queues.orgnr_review_queue.oldest_first as any[]).find((r: any) => r.provider_id === "vtp2-agecheck");
        assertTrue(!!oldRow, "vtp2-21b: den gamle raden er med i rapporten");
        assertEq(oldRow.stale, true, "vtp2-21c: langt over terskelen -> stale:true");
        assertEq(res.body.queues.orgnr_review_queue.oldest_first[0]?.provider_id, "vtp2-agecheck",
          "vtp2-21d: eldste rad står FØRST (oldest-first)");
        assertTrue(res.body.queues?.website_review_queue !== undefined, "vtp2-21e: nettsted-køen rapporteres samtidig");
      }
    } catch (err: any) {
      failed++;
      failures.push("veien-til-pool-skive2: unexpected error: " + String(err?.stack || err?.message || err));
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
  runVeienTilPoolSkive2Tests({ log: true }).then((s) => {
    console.log(`\nveien-til-pool-skive2: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) process.exit(1);
  });
}
