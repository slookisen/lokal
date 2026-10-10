/**
 * opplevelser-gardssalg-epost-homepage-proof.test.ts — dev-request
 * 2026-10-10-opplevagent-adressekontroll-leser-epost-kilde.
 *
 *   ep-1..ep-9   AC1: computeGardssalgAddressBasis reads field_provenance.epost
 *                (value == adresse + source_url på eget domene); fail closed
 *                uten value / feil value / fremmed domene; email-formen uendret.
 *   ep-10..ep-13 skriverne (set-contact-email) legger til value + source_type.
 *   ep-20..ep-29 pageContainsExactEmail + ruta gardssalg-epost-homepage-proof:
 *                dry-run skriver ingenting, funnet/ikke_funnet, apply skriver
 *                kun field_provenance (adressen urørt), maks 20.
 *
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/routes/opplevelser-gardssalg-epost-homepage-proof.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runGardssalgEpostHomepageProofTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const assertEq = (actual: unknown, expected: unknown, label: string): void => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
      if (log) console.log("  " + failures[failures.length - 1]);
    }
  };
  const assertTrue = (c: boolean, label: string): void => assertEq(!!c, true, label);

  return (async () => {
    const prevExpPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "epost-homepage-proof-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    const prevFetch = globalThis.fetch;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      const mod = require("./opplevelser") as typeof import("./opplevelser");
      const router = mod.default as any;
      mod.__setGsCxRowDelayForTesting(0);

      // ═══ AC1: computeGardssalgAddressBasis ═══
      const basis = mod.computeGardssalgAddressBasis;
      const ADDR = "Post@Gmail-Workspace.no";
      const SITE = "https://fjellbrygg.no";
      const prov = (o: unknown) => JSON.stringify(o);
      assertEq(
        basis(ADDR, SITE, prov({ epost: { source_url: "https://fjellbrygg.no/kontakt", fetched_at: "x", source_type: "homepage", value: "post@gmail-workspace.no" } })),
        "published_on_producer_site", "ep-1: epost-post med value = adressen + eget domene -> published_on_producer_site");
      assertEq(
        basis(ADDR, SITE, prov({ epost: { source_url: "https://www.fjellbrygg.no/", fetched_at: "x", value: "post@gmail-workspace.no" } })),
        "published_on_producer_site", "ep-2: …også uten source_type (gårdssalg-formen) og med www");
      assertEq(
        basis(ADDR, SITE, prov({ epost: [
          { source_url: "https://annet.no/", fetched_at: "x", value: "post@gmail-workspace.no" },
          { source_url: "https://fjellbrygg.no/om", fetched_at: "x", source_type: "homepage", value: "post@gmail-workspace.no" },
        ] })),
        "published_on_producer_site", "ep-3: liste-form — én gyldig post er nok");
      assertEq(
        basis(ADDR, SITE, prov({ epost: { source_url: "https://fjellbrygg.no/kontakt", fetched_at: "x", source_type: "homepage", value: "gammel@gmail-workspace.no" } })),
        "unverified", "ep-4: annen value -> unverified");
      assertEq(
        basis(ADDR, SITE, prov({ epost: { source_url: "https://fremmed.no/kontakt", fetched_at: "x", source_type: "homepage", value: "post@gmail-workspace.no" } })),
        "unverified", "ep-5: source_url på fremmed domene -> unverified");
      assertEq(
        basis(ADDR, SITE, prov({ epost: { source_url: "https://fjellbrygg.no/kontakt", fetched_at: "x", source_type: "homepage" } })),
        "unverified", "ep-6: post uten value -> unverified (fail closed)");
      assertEq(
        basis(ADDR, SITE, prov({ epost: { source_url: "https://fjellbrygg.no/kontakt", fetched_at: "x", source_type: "brreg", value: "post@gmail-workspace.no" } })),
        "unverified", "ep-7: annen source_type enn homepage tvinges ikke");
      assertEq(
        basis(ADDR, SITE, prov({ epost: "https://fjellbrygg.no/kontakt" })),
        "unverified", "ep-8: malformert epost-post -> unverified, kaster ikke");
      assertEq(
        basis(ADDR, SITE, prov({ email: [{ source_type: "homepage", value: "post@gmail-workspace.no", source_url: "https://fjellbrygg.no/" }] })),
        "published_on_producer_site", "ep-9: eksisterende email-form (RFB) uendret");
      assertEq(
        basis(ADDR, SITE, prov({ email: [{ source_type: "homepage", value: "post@gmail-workspace.no", source_url: "https://fremmed.no/" }] })),
        "unverified", "ep-9b: email-form på fremmed domene fortsatt unverified");

      // ═══ Fixtures ═══
      const ins = expDb.prepare(
        `INSERT INTO experience_providers (id, navn, vertical, producer_type, hjemmeside, epost, telefon, content_source, created_at, field_provenance)
         VALUES (@id, @navn, 'experiences', 'bryggeri', @hj, @ep, NULL, NULL, @created, @fp)`
      );
      ins.run({ id: "ep-a", navn: "Funnet Bryggeri", hj: "https://funnet.no", ep: "post@workspace-a.no", created: "2026-01-01", fp: null });
      ins.run({ id: "ep-b", navn: "Mangler Bryggeri", hj: "https://mangler.no", ep: "post@workspace-b.no", created: "2026-01-02", fp: null });
      ins.run({ id: "ep-c", navn: "Samme Domene", hj: "https://samme.no", ep: "post@samme.no", created: "2026-01-03", fp: null });
      ins.run({ id: "ep-d", navn: "Annen Adresse", hj: "https://annen.no", ep: "gammel@workspace-d.no", created: "2026-01-04", fp: JSON.stringify({ epost: { source_url: "https://annen.no/", fetched_at: "x" } }) });

      // ═══ ep-10..13: skriverne ═══
      {
        const r = store.applyGardssalgSetContactEmail("ep-c", "post@samme.no", "https://samme.no/kontakt", false);
        assertTrue(r.ok === true, "ep-10: set-contact-email ok");
        const fp = JSON.parse((expDb.prepare("SELECT field_provenance FROM experience_providers WHERE id='ep-c'").get() as any).field_provenance);
        assertEq(fp.epost.value, "post@samme.no", "ep-10b: set-contact-email skriver value");
        assertEq(fp.epost.source_type, "homepage", "ep-10c: …og source_type homepage når kilden er på nettstedets domene");
        const r2 = store.applyGardssalgSetContactEmail("ep-c", "post@samme.no", "https://tredjepart.no/liste", true);
        const fp2 = JSON.parse((expDb.prepare("SELECT field_provenance FROM experience_providers WHERE id='ep-c'").get() as any).field_provenance);
        assertTrue(r2.ok === true && fp2.epost.value === "post@samme.no" && fp2.epost.source_type === undefined,
          "ep-11: kilde utenfor nettstedets domene -> value, men ingen source_type homepage");
        assertEq(mod.computeGardssalgAddressBasis("post@samme.no", "https://samme.no", JSON.stringify(fp2)), "same_domain_as_website", "ep-11b: (basis uendret for samme domene)");
      }
      {
        const prevKey = process.env.ANTHROPIC_API_KEY;
        process.env.ANTHROPIC_API_KEY = "epost-homepage-proof-test-anthropic-key";
        globalThis.fetch = (async () => ({
          ok: true, status: 200,
          json: async () => ({ content: [{ type: "text", text: "GODKJENN\nEkte kontaktinfo." }] }),
        })) as any;
        expDb.prepare("INSERT INTO experience_providers (id, navn, vertical, producer_type, hjemmeside, epost, created_at) VALUES ('ep-w','Writer','experiences','bryggeri','https://writer.no',NULL,'2026-01-09')").run();
        await store.applyGardssalgProviderContact("ep-w", { epost: "bestill@writer.no" } as any, "https://writer.no/kontakt");
        const fp = JSON.parse((expDb.prepare("SELECT field_provenance FROM experience_providers WHERE id='ep-w'").get() as any).field_provenance ?? "{}");
        assertEq(fp.epost?.value, "bestill@writer.no", "ep-12: applyGardssalgProviderContact skriver value for epost");
        assertEq(fp.epost?.source_type, "homepage", "ep-12b: …og source_type homepage på eget domene");
        globalThis.fetch = prevFetch;
        if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
      }

      // ═══ pageContainsExactEmail ═══
      {
        const f = store.pageContainsExactEmail;
        assertTrue(f('<a href="mailto:Post@Foo.no">x</a>', "post@foo.no"), "ep-20: mailto, case-insensitiv");
        assertTrue(f("skriv til post&#64;foo.no.", "post@foo.no"), "ep-21: entity-@ og punktum etterpå");
        assertTrue(!f("xpost@foo.no", "post@foo.no"), "ep-22: lengre local part matcher ikke");
        assertTrue(!f("post@foo.nor", "post@foo.no"), "ep-23: lengre domene matcher ikke");
        assertTrue(!f("info@foo.no", "post@foo.no"), "ep-24: annen adresse matcher ikke");
      }

      // ═══ Rute ═══
      const callRoute = (routeBody: Record<string, unknown>): Promise<{ status: number; body: any }> => {
        const req: any = {
          method: "POST", url: "/admin/gardssalg-epost-homepage-proof",
          originalUrl: "/api/opplevelser/admin/gardssalg-epost-homepage-proof",
          path: "/admin/gardssalg-epost-homepage-proof", query: {}, body: routeBody,
          headers: { "x-admin-key": testKey }, get(n: string) { return this.headers[n.toLowerCase()]; },
        };
        let settle!: () => void;
        const done = new Promise<void>((r) => { settle = r; });
        const res: any = {
          statusCode: 200, _body: undefined,
          status(c: number) { this.statusCode = c; return this; },
          json(b: any) { this._body = b; settle(); return this; },
          send(b: any) { this._body = b; settle(); return this; },
        };
        router.handle(req, res, () => settle());
        return done.then(() => ({ status: res.statusCode, body: res._body }));
      };
      const pages: Record<string, string> = {
        "https://funnet.no/": '<html><body><a href="/kontakt">Kontakt</a></body></html>',
        "https://funnet.no/kontakt": '<html><body>Kontakt oss: <a href="mailto:post@workspace-a.no">post@workspace-a.no</a></body></html>',
        "https://mangler.no/": "<html><body>Velkommen. Ring oss.</body></html>",
        "https://annen.no/": "<html><body>Skriv til ny@workspace-d.no</body></html>",
      };
      let fetchCalls = 0;
      globalThis.fetch = (async (url: any) => {
        fetchCalls++;
        let key = String(url);
        try { key = new URL(key).href; } catch { /* keep */ }
        const body = pages[key];
        const ok = body !== undefined;
        return {
          ok, status: ok ? 200 : 404, url: String(url),
          headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "text/html" : null) },
          text: async () => body ?? "",
          arrayBuffer: async () => new TextEncoder().encode(body ?? "").buffer,
          body: null,
        } as any;
      }) as any;

      const snapshot = () => JSON.stringify(expDb.prepare("SELECT id, epost, field_provenance FROM experience_providers ORDER BY id").all());
      const before = snapshot();
      const dry = await callRoute({});
      assertEq(dry.status, 200, "ep-30: dry-run 200");
      assertEq(dry.body.dry_run, true, "ep-30b: dry_run er standard");
      assertTrue(fetchCalls > 0, "ep-30c: dry-run henter sider (stubbet fetch)");
      assertEq(dry.body.funnet.map((x: any) => x.provider_id), ["ep-a"], "ep-31: kun raden med adressen på eget nettsted er funnet");
      assertEq(dry.body.funnet[0].written, false, "ep-31b: dry-run: written false");
      assertEq(dry.body.funnet[0].source_url, "https://funnet.no/kontakt", "ep-31c: source_url er siden adressen sto på");
      assertTrue(
        dry.body.ikke_funnet.map((x: any) => x.provider_id).sort().join(",") === "ep-b,ep-d",
        "ep-32: rader uten eksakt adresse (annen adresse / ikke på siden) -> ikke_funnet");
      assertEq(snapshot(), before, "ep-33: dry-run skriver INGENTING (epost og field_provenance urørt)");
      assertTrue(!dry.body.funnet.some((x: any) => x.provider_id === "ep-c"), "ep-34: rad som allerede har grunnlag (samme domene) er ikke i kohorten");

      const capped = await callRoute({ limit: 500 });
      assertEq(capped.body.limit, 20, "ep-35: limit kappes til 20");

      const applied = await callRoute({ apply: true });
      assertEq(applied.body.dry_run, false, "ep-40: apply -> dry_run false");
      assertEq(applied.body.written_count, 1, "ep-40b: kun funnet rad skrevet");
      const rowA = expDb.prepare("SELECT epost, field_provenance FROM experience_providers WHERE id='ep-a'").get() as any;
      assertEq(rowA.epost, "post@workspace-a.no", "ep-41: adressen er uendret");
      const fpA = JSON.parse(rowA.field_provenance);
      assertEq(
        { s: fpA.epost.source_url, t: fpA.epost.source_type, v: fpA.epost.value, hasFetched: typeof fpA.epost.fetched_at === "string" },
        { s: "https://funnet.no/kontakt", t: "homepage", v: "post@workspace-a.no", hasFetched: true },
        "ep-41b: field_provenance.epost = {source_url, fetched_at, source_type, value}");
      const rowB = expDb.prepare("SELECT field_provenance FROM experience_providers WHERE id='ep-b'").get() as any;
      assertEq(rowB.field_provenance, null, "ep-42: ikke_funnet-rad får ingen skriving");
      assertEq(
        mod.computeGardssalgAddressBasis("post@workspace-a.no", "https://funnet.no", rowA.field_provenance),
        "published_on_producer_site", "ep-43: etter apply gir basis published_on_producer_site");
      const auditN = (expDb.prepare("SELECT COUNT(*) n FROM gardssalg_content_audit WHERE field_name='epost_provenance'").get() as any).n;
      assertEq(auditN, 1, "ep-44: én audit-rad for skrivingen");
      const again = await callRoute({ apply: true });
      assertEq(again.body.written_count, 0, "ep-45: idempotent — andre apply skriver ikke igjen");

      const noAuth = await new Promise<number>((resolve) => {
        const req: any = { method: "POST", url: "/admin/gardssalg-epost-homepage-proof", originalUrl: "/x", path: "/admin/gardssalg-epost-homepage-proof", query: {}, body: {}, headers: {}, get() { return undefined; } };
        const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json() { resolve(this.statusCode); return this; }, send() { resolve(this.statusCode); return this; } };
        router.handle(req, res, () => resolve(-1));
      });
      assertEq(noAuth, 403, "ep-50: uten admin-nøkkel -> 403");
    } catch (err: any) {
      failed++;
      failures.push("epost-homepage-proof: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      if (prevExpPath === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevExpPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runGardssalgEpostHomepageProofTests({ log: true }).then((s) => {
    console.log(`\ngardssalg-epost-homepage-proof: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) process.exit(1);
  });
}
