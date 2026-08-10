/**
 * opplevelser-gardssalg-medlemsliste-bekreft.test.ts — dev-request
 * 2026-08-10-veien-til-pool-berikelseskjede-og-koedrenering, Skive 3.
 *
 * Norske Destilleriers medlemsliste (norskedestillerier.no/medlemmer/)
 * confirms/enriches EXISTING gårdssalg rows by DOMAIN match — never creates
 * a row. New: POST /admin/gardssalg-medlemsliste-bekreft.
 *
 *   nd-1..nd-6    parseNorskeDestillererMedlemmerPage (PURE): the real
 *                 page's structure (verified against the live page
 *                 2026-08-10) — name+sted split, multi-line address,
 *                 postnr/poststed line detection, Tlf./E-post/Nettside
 *                 lines each independently optional, the " - " alternate-
 *                 site case, entity decode (en-dash name).
 *   nd-7..nd-10   ndMemberDomain / ndProviderDomain / ndDomainsEqual
 *                 (PURE): website-first then email-fallback domain
 *                 extraction, hyphen-insensitive equality.
 *   nd-11..nd-16  matchNdMember (PURE): domain_match takes priority over a
 *                 name agreement; ambiguous domain/name -> needs_review,
 *                 never a guess; umbrella_self_reference backstop; genuine
 *                 no_match.
 *   nd-17..nd-19  Route plumbing: unauthenticated -> 403; oversized/empty
 *                 providerIds -> 400; a page-1 fetch failure reports
 *                 medlemsliste_fetch_failed (never a false no_match sweep).
 *   nd-20         AK10 / mandatory failing-test #1: apply:false (default)
 *                 writes NOTHING — re-read after the call proves every
 *                 field is still blank, even though the dry-run response
 *                 itself reports the fields it WOULD write.
 *   nd-21         AK10 / mandatory failing-test #2: apply:true fills only
 *                 the fields that were blank, stamps field_provenance with
 *                 source:"norskedestillerier_medlemsliste" AND the generic
 *                 {source_url, fetched_at} shape every sibling gårdssalg
 *                 writer uses, and writes one gardssalg_content_audit row
 *                 per field.
 *   nd-22         AK10 / mandatory failing-test #3: a field ALREADY
 *                 confirmed on the producer's own live website
 *                 (field_provenance.hjemmeside_verification.verified=true +
 *                 a pre-set adresse) is NEVER overwritten by the
 *                 medlemsliste value, even under apply:true.
 *   nd-23         Mandatory failing-test #4: a name-only match (no domain
 *                 corroboration) NEVER writes, apply:true or not — it lands
 *                 in needs_review with reason "name_only_match".
 *   nd-24         Mandatory failing-test #5: no new experience_providers
 *                 row is ever created — row count identical before/after a
 *                 full run that includes genuine no_match members.
 *   nd-25         providerIds narrows the PROVIDER side only: a provider
 *                 NOT named in providerIds is untouched even though its
 *                 hjemmeside would otherwise domain-match a fetched member.
 *   nd-26         Ambiguous domain match (two providers share one
 *                 hjemmeside domain) -> needs_review, writes to NEITHER.
 *   nd-27         owner-locked (content_source='manual') row: matched but
 *                 written=[] under apply:true (fill-only guard still
 *                 fires) and owner_locked:true is reported.
 *
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/routes/opplevelser-gardssalg-medlemsliste-bekreft.test.ts
 */

import type {} from "node";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Local structural type mirroring GardssalgMedlemslisteMatchCandidate (kept
// separate rather than imported so this test file doesn't need a direct
// import of experience-store's internal type just for a test-local literal
// builder — matchNdMember itself is exercised via the real exported type).
type GardssalgMedlemslisteMatchCandidateShape = {
  id: string;
  navn: string;
  hjemmeside: string | null;
  content_source: string | null;
};

const ND_MEDLEMMER_URL_FOR_TEST = "https://norskedestillerier.no/medlemmer/";

// A condensed, structurally-faithful fixture: reproduces the REAL
// norskedestillerier.no/medlemmer/ markup shape (verified against the live
// page 2026-08-10) for a handful of synthetic members covering every
// parsing edge case the real page itself exhibits (multi-line address,
// blank Nettside, the " - " alternate-site form, an en-dash in the name).
function ndFixturePage(): string {
  return `
<div class="fl-post-grid" itemscope itemtype="https://schema.org/Collection">
<div class="fl-post-grid-post fl-post-align-default post-1 lokasjon type-lokasjon status-publish hentry" itemscope itemtype="https://schema.org/CreativeWork">
<div class="fl-post-text">
<h2 class="fl-post-title"><a href='https://norskedestillerier.no/lokasjon/domenetreff-gard-sted/' title='Domenetreff Gard, Sted'>Domenetreff Gard, Sted</a></h2>
<div class="fl-post-excerpt">
    Testveien 1<br />
1234 Sted<br />
Tlf. 900 00 001<br />
E-post: post@domenetreff.no<br />
Nettside: www.domenetreff.no
</div>
</div>
</div>
<div class="fl-post-grid-post fl-post-align-default post-2 lokasjon type-lokasjon status-publish hentry" itemscope itemtype="https://schema.org/CreativeWork">
<div class="fl-post-text">
<h2 class="fl-post-title"><a href='https://norskedestillerier.no/lokasjon/flerlinje-gaard-sted/' title='Flerlinje Gård &#8211; Bivrost, Sted'>Flerlinje Gård &#8211; Bivrost, Sted</a></h2>
<div class="fl-post-excerpt">
    Bygningen A<br />
Testveien 2<br />
5678 AnnetSted<br />
Tlf.: <br />
E-post: post@flerlinje.no<br />
Nettside: www.flerlinje.no - https://alt.flerlinje.no
</div>
</div>
</div>
<div class="fl-post-grid-post fl-post-align-default post-3 lokasjon type-lokasjon status-publish hentry" itemscope itemtype="https://schema.org/CreativeWork">
<div class="fl-post-text">
<h2 class="fl-post-title"><a href='https://norskedestillerier.no/lokasjon/bare-epost-gard/' title='Bare Epost Gard, Sted3'>Bare Epost Gard, Sted3</a></h2>
<div class="fl-post-excerpt">
    Ingensted 3<br />
9999 Sted3<br />
Tlf. 900 00 003<br />
E-post: kontakt@bareepost.no<br />
Nettside:
</div>
</div>
</div>
<div class="fl-post-grid-post fl-post-align-default post-4 lokasjon type-lokasjon status-publish hentry" itemscope itemtype="https://schema.org/CreativeWork">
<div class="fl-post-text">
<h2 class="fl-post-title"><a href='https://norskedestillerier.no/lokasjon/navnetreff-gard/' title='Navnetreff Unikt Gard, Sted4'>Navnetreff Unikt Gard, Sted4</a></h2>
<div class="fl-post-excerpt">
    Navneveien 4<br />
1111 Sted4<br />
Tlf. 900 00 004<br />
E-post: post@navnetreffunikt.no<br />
Nettside: www.navnetreffunikt.no
</div>
</div>
</div>
<div class="fl-post-grid-post fl-post-align-default post-5 lokasjon type-lokasjon status-publish hentry" itemscope itemtype="https://schema.org/CreativeWork">
<div class="fl-post-text">
<h2 class="fl-post-title"><a href='https://norskedestillerier.no/lokasjon/ingen-treff-gard/' title='Helt Urelatert Virksomhet, Sted5'>Helt Urelatert Virksomhet, Sted5</a></h2>
<div class="fl-post-excerpt">
    Ukjentveien 5<br />
2222 Sted5<br />
Tlf. 900 00 005<br />
E-post: post@ingentreff.no<br />
Nettside: www.ingentreff.no
</div>
</div>
</div>
</div>
`;
}

export function runGardssalgMedlemslisteBekreftTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  return (async () => {
    const prevExpPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = process.env.ADMIN_KEY || "nd-medlem-test-key";
    const testKey = process.env.ADMIN_KEY;

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
      const opplevelserModule = require("./opplevelser") as typeof import("./opplevelser");
      const opplevelserRouter = opplevelserModule.default as any;

      const call = (
        path: string,
        routeBody: Record<string, unknown>,
        reqExtra: Record<string, unknown> = {}
      ): Promise<{ status: number; body: any }> => {
        const req: any = {
          method: "POST",
          url: path,
          originalUrl: `/api/opplevelser${path}`,
          path,
          query: {},
          body: routeBody,
          headers: { "x-admin-key": testKey },
          get(n: string) {
            return this.headers[n.toLowerCase()];
          },
          ...reqExtra,
        };
        let settle!: () => void;
        const done = new Promise<void>((r) => {
          settle = r;
        });
        const res: any = {
          statusCode: 200,
          _body: undefined,
          status(c: number) {
            this.statusCode = c;
            return this;
          },
          json(b: any) {
            this._body = b;
            settle();
            return this;
          },
          send(b: any) {
            this._body = b;
            settle();
            return this;
          },
        };
        opplevelserRouter.handle(req, res, () => settle());
        return done.then(() => ({ status: res.statusCode, body: res._body }));
      };
      const callNd = (body: Record<string, unknown>, reqExtra: Record<string, unknown> = {}) =>
        call("/admin/gardssalg-medlemsliste-bekreft", body, reqExtra);

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, producer_type, hjemmeside, epost, telefon, adresse, postnummer, poststed,
            catalog_hidden, slug, content_source, field_provenance, created_at)
         VALUES (@id, @navn, 'experiences', @pt, @hj, @ep, @tlf, @adresse, @postnummer, @poststed,
                 @catalog_hidden, @slug, @cs, @field_provenance, @created)`
      );
      const seed = (o: Partial<Record<string, unknown>> & { id: string; navn: string }) =>
        insertProvider.run({
          pt: "destilleri",
          hj: null,
          ep: null,
          tlf: null,
          adresse: null,
          postnummer: null,
          poststed: null,
          catalog_hidden: 0,
          slug: null,
          cs: null,
          field_provenance: null,
          created: "2026-01-01",
          ...o,
        });
      const countProviders = (): number =>
        (expDb.prepare(`SELECT COUNT(*) AS n FROM experience_providers`).get() as { n: number }).n;
      const readProvider = (id: string): any => expDb.prepare(`SELECT * FROM experience_providers WHERE id = ?`).get(id);

      // ═══ nd-1..nd-6: parseNorskeDestillererMedlemmerPage (PURE) ═══
      {
        const parse = opplevelserModule.parseNorskeDestillererMedlemmerPage;
        const members = parse(ndFixturePage());
        assertEq(members.length, 5, "nd-1: alle 5 medlemmer i fixturen parses");

        const m0 = members[0]!;
        assertEq(m0.name, "Domenetreff Gard", "nd-2a: navn splittes fra ', <sted>'");
        assertEq(m0.adresse, "Testveien 1", "nd-2b: enkel adresselinje");
        assertEq(m0.postnummer, "1234", "nd-2c: postnummer");
        assertEq(m0.poststed, "Sted", "nd-2d: poststed");
        assertEq(m0.telefon, "900 00 001", "nd-2e: telefon");
        assertEq(m0.epost, "post@domenetreff.no", "nd-2f: e-post");
        assertEq(m0.website, "www.domenetreff.no", "nd-2g: nettside");

        const m1 = members[1]!;
        assertEq(m1.name, "Flerlinje Gård – Bivrost", "nd-3a: entity-dekoding (en-dash) i navn");
        assertEq(m1.adresse, "Bygningen A, Testveien 2", "nd-3b: flerlinjet adresse slås sammen");
        assertEq(m1.telefon, null, "nd-3c: tom Tlf.-linje -> null, ikke tom streng");
        assertEq(m1.website, "www.flerlinje.no", "nd-3d: kun FØRSTE nettside av et ' - '-par tas");

        const m2 = members[2]!;
        assertEq(m2.website, null, "nd-4: tom Nettside-linje -> null (Svalbard-klassen)");
        assertEq(m2.epost, "kontakt@bareepost.no", "nd-5: e-post finnes uavhengig av manglende nettside");

        const noExcerpt = parse(
          `<div class="fl-post-grid-post"><h2 class="fl-post-title"><a href='https://x.example/y/' title='Kun Navn, Sted'>Kun Navn, Sted</a></h2></div>`
        );
        assertEq(noExcerpt.length, 1, "nd-6a: blokk uten excerpt gir likevel ett medlem (navn/url)");
        assertEq(noExcerpt[0]!.adresse, null, "nd-6b: ...med alle detaljfelt null");
      }

      // ═══ nd-7..nd-10: domene-hjelpere (PURE) ═══
      {
        const memberDomain = opplevelserModule.ndMemberDomain;
        const providerDomain = opplevelserModule.ndProviderDomain;
        const domainsEqual = opplevelserModule.ndDomainsEqual;

        assertEq(
          memberDomain({ website: "www.eksempel.no", epost: "post@annet.no" }),
          "eksempel.no",
          "nd-7: nettside foretrekkes over e-post når begge finnes"
        );
        assertEq(
          memberDomain({ website: null, epost: "post@kun-epost.no" }),
          "kun-epost.no",
          "nd-8: faller tilbake til e-postdomene uten nettside"
        );
        assertEq(memberDomain({ website: null, epost: null }), null, "nd-9a: ingen av delene -> null");
        assertEq(providerDomain("https://www.produsent.no/side"), "produsent.no", "nd-9b: produsentens hjemmeside-domene");
        assertEq(providerDomain(null), null, "nd-9c: blank hjemmeside -> null");

        assertTrue(domainsEqual("lia-gard.no", "liagard.no"), "nd-10a: bindestrek-ufølsom likhet");
        assertTrue(!domainsEqual("slakthuset.no", "eidsmokjott.no"), "nd-10b: ekte ulike domener forblir ulike");
      }

      // ═══ nd-11..nd-16: matchNdMember (PURE) ═══
      {
        const match = opplevelserModule.matchNdMember;
        const member = (o: Partial<Parameters<typeof match>[0]>): any => ({
          name: "Test Gard",
          raw_title: "Test Gard, Sted",
          source_url: "https://norskedestillerier.no/lokasjon/test/",
          adresse: null,
          postnummer: null,
          poststed: null,
          telefon: null,
          epost: null,
          website: null,
          ...o,
        });
        const provider = (o: Partial<GardssalgMedlemslisteMatchCandidateShape>): GardssalgMedlemslisteMatchCandidateShape => ({
          id: "p-x",
          navn: "Provider",
          hjemmeside: null,
          content_source: null,
          ...o,
        });

        const domainVerdict = match(member({ website: "www.match.no" }), [
          provider({ id: "p-1", navn: "Noe Annet Navn", hjemmeside: "https://www.match.no" }),
        ]);
        assertEq(domainVerdict.tier, "domain_match", "nd-11: domenetreff slår navnetreff/mangel på navnetreff");
        assertEq((domainVerdict as any).provider_id, "p-1", "nd-11b: riktig provider_id på domenetreff");

        const ambiguousDomain = match(member({ website: "www.dup.no" }), [
          provider({ id: "p-2", hjemmeside: "https://www.dup.no" }),
          provider({ id: "p-3", hjemmeside: "https://dup.no" }),
        ]);
        assertEq(ambiguousDomain.tier, "ambiguous_domain_match", "nd-12: to rader med samme domene -> tvetydig, ALDRI en gjetning");

        const nameOnly = match(member({ name: "Unikt Navnetreff Gard", website: "www.ukjent-domene-xyz.no" }), [
          provider({ id: "p-4", navn: "Unikt Navnetreff Gard" }),
        ]);
        assertEq(nameOnly.tier, "name_only", "nd-13: navnetreff uten domenetreff -> name_only (needs_review), IKKE auto-skriv");

        const ambiguousName = match(member({ name: "Delt Navn Gard", website: "www.ukjent2.no" }), [
          provider({ id: "p-5", navn: "Delt Navn Gard" }),
          provider({ id: "p-6", navn: "Delt Navn Gard AS" }),
        ]);
        assertEq(ambiguousName.tier, "ambiguous_name_match", "nd-14: to navnetreff -> tvetydig");

        const noMatch = match(member({ name: "Helt Urelatert", website: "www.ukjent3.no" }), [
          provider({ id: "p-7", navn: "Fullstendig Annerledes Produsent" }),
        ]);
        assertEq(noMatch.tier, "no_match", "nd-15: verken domene- eller navnetreff -> no_match");

        const umbrella = match(member({ website: null, epost: "post@norskedestillerier.no" }), [
          provider({ id: "p-8", navn: "Uansett Provider" }),
        ]);
        assertEq(umbrella.tier, "umbrella_self_reference", "nd-16: paraplyens eget domene matcher ALDRI, selv om et navn skulle overlappe");
      }

      // ═══ nd-17..nd-19: rute-plumbing ═══
      {
        const noKey = await callNd({}, { headers: { "x-admin-key": "wrong" } });
        assertEq(noKey.status, 403, "nd-17: feil X-Admin-Key -> 403");

        const emptyIds = await callNd({ providerIds: [] });
        assertEq(emptyIds.status, 400, "nd-18a: tom providerIds -> 400");
        const tooMany = await callNd({ providerIds: Array.from({ length: 49 }, (_, i) => `id-${i}`) });
        assertEq(tooMany.status, 400, "nd-18b: for mange providerIds -> 400");

        globalThis.fetch = (async () => {
          throw Object.assign(new Error("getaddrinfo ENOTFOUND norskedestillerier.no"), {
            cause: { code: "ENOTFOUND" },
          });
        }) as unknown as typeof fetch;
        const fetchFail = await callNd({});
        assertEq(fetchFail.status, 200, "nd-19a: fetch-feil på side 1 -> 200 (ikke 500)");
        assertEq(fetchFail.body?.success, false, "nd-19b: ...men success:false");
        assertEq(fetchFail.body?.error, "medlemsliste_fetch_failed", "nd-19c: ...med eksplisitt feilkode");
        assertTrue(
          !("no_match" in (fetchFail.body ?? {})) || fetchFail.body.no_match === undefined,
          "nd-19d: en hentefeil rapporterer ALDRI no_match for noen (hentefeil ≠ fravær)"
        );
      }

      // ── Shared fetch mock for the write-behaviour scenarios below: page 1
      // serves the fixture, page 2 404s (permanent -> end of pagination).
      const mockHeaders = { get: () => null } as unknown as Headers;
      const htmlResponse = (u: string, html: string): Response =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          url: u,
          headers: mockHeaders,
          arrayBuffer: async () => new TextEncoder().encode(html).buffer,
        }) as unknown as Response;
      const notFoundResponse = (u: string): Response =>
        ({
          ok: false,
          status: 404,
          statusText: "Not Found",
          url: u,
          headers: mockHeaders,
          arrayBuffer: async () => new ArrayBuffer(0),
        }) as unknown as Response;
      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        if (u === ND_MEDLEMMER_URL_FOR_TEST) return htmlResponse(u, ndFixturePage());
        return notFoundResponse(u);
      }) as unknown as typeof fetch;

      // ═══ nd-20/nd-21: AK10 mandatory failing-tests #1/#2 (apply:false / apply:true) ═══
      {
        seed({ id: "nd-p-domain", navn: "Domenetreff Gard Provider", hj: "https://www.domenetreff.no" });

        const dry = await callNd({ providerIds: ["nd-p-domain"] });
        assertEq(dry.status, 200, "nd-20a: dry-run 200");
        assertEq(dry.body?.dry_run, true, "nd-20b: dry_run:true som standard (apply:false)");
        const dryMatch = (dry.body?.domain_match ?? []).find((m: any) => m.provider_id === "nd-p-domain");
        assertTrue(!!dryMatch, "nd-20c: domenetreffet rapporteres i dry-run");
        assertTrue(
          (dryMatch?.written ?? []).includes("adresse") && (dryMatch?.written ?? []).includes("epost"),
          "nd-20d: dry-run-forhåndsvisningen lister feltene den VILLE skrevet"
        );
        const afterDry = readProvider("nd-p-domain");
        assertEq(afterDry.adresse, null, "nd-20e (MANDATORY #1): apply:false skrev IKKE adresse");
        assertEq(afterDry.epost, null, "nd-20f (MANDATORY #1): apply:false skrev IKKE epost");
        assertEq(afterDry.postnummer, null, "nd-20g (MANDATORY #1): apply:false skrev IKKE postnummer");

        const applied = await callNd({ providerIds: ["nd-p-domain"], apply: true });
        assertEq(applied.status, 200, "nd-21a: apply:true 200");
        assertEq(applied.body?.dry_run, false, "nd-21b: dry_run:false");
        const afterApply = readProvider("nd-p-domain");
        assertEq(afterApply.adresse, "Testveien 1", "nd-21c: adresse fylt fra medlemslisten");
        assertEq(afterApply.postnummer, "1234", "nd-21d: postnummer fylt");
        assertEq(afterApply.poststed, "Sted", "nd-21e: poststed fylt");
        assertEq(afterApply.telefon, "900 00 001", "nd-21f: telefon fylt");
        assertEq(afterApply.epost, "post@domenetreff.no", "nd-21g: epost fylt");

        const prov = JSON.parse(afterApply.field_provenance);
        assertEq(prov.adresse?.source, "norskedestillerier_medlemsliste", "nd-21h: provenance source-tag stemplet");
        assertTrue(typeof prov.adresse?.confirmed_at === "string", "nd-21i: confirmed_at stemplet");
        assertTrue(typeof prov.adresse?.source_url === "string", "nd-21j: source_url (medlemmets egen lokasjonsside) stemplet");
        assertTrue(typeof prov.adresse?.fetched_at === "string", "nd-21k: generisk fetched_at-form bevart for verktøy som leser det");

        const auditRows = expDb
          .prepare(`SELECT field_name FROM gardssalg_content_audit WHERE provider_id = 'nd-p-domain' ORDER BY field_name`)
          .all() as Array<{ field_name: string }>;
        assertEq(auditRows.length, 5, "nd-21l: én audit-rad per skrevet felt (adresse/postnummer/poststed/telefon/epost)");

        // Idempotent re-run: everything is now filled, a second apply must
        // write nothing further (fill-only, not "always confirm again").
        const secondApply = await callNd({ providerIds: ["nd-p-domain"], apply: true });
        const secondMatch = (secondApply.body?.domain_match ?? []).find((m: any) => m.provider_id === "nd-p-domain");
        assertEq((secondMatch?.written ?? []).length, 0, "nd-21m: andre apply-kjøring skriver ingenting (allerede fylt)");
      }

      // ═══ nd-22: AK10 mandatory failing-test #3 — producer-own-website wins ═══
      {
        seed({
          id: "nd-p-verified",
          navn: "Domenetreff Gard Verified",
          hj: "https://www.domenetreff.no",
          adresse: "Ekte Produsentveien 99",
          field_provenance: JSON.stringify({
            hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-08-01T00:00:00Z" },
            adresse: { source_url: "https://www.domenetreff.no", fetched_at: "2026-08-01T00:00:00Z" },
          }),
        });
        const res = await callNd({ providerIds: ["nd-p-verified"], apply: true });
        const m = (res.body?.domain_match ?? []).find((x: any) => x.provider_id === "nd-p-verified");
        assertTrue(!!m, "nd-22a: raden matches fortsatt på domene");
        assertTrue(!(m?.written ?? []).includes("adresse"), "nd-22b (MANDATORY #3): adresse IKKE i written-lista");
        const after = readProvider("nd-p-verified");
        assertEq(after.adresse, "Ekte Produsentveien 99", "nd-22c (MANDATORY #3): produsentens EGEN, allerede-bekreftede adresse er UENDRET");
      }

      // ═══ nd-23: mandatory failing-test #4 — name-only never writes ═══
      {
        seed({ id: "nd-p-name-only", navn: "Navnetreff Unikt Gard", hj: null });
        const res = await callNd({ providerIds: ["nd-p-name-only"], apply: true });
        const inDomainMatch = (res.body?.domain_match ?? []).some((x: any) => x.provider_id === "nd-p-name-only");
        assertTrue(!inDomainMatch, "nd-23a (MANDATORY #4): et navnetreff havner ALDRI i domain_match");
        const review = (res.body?.needs_review ?? []).find((x: any) => x.candidate_provider_ids?.includes("nd-p-name-only"));
        assertTrue(!!review, "nd-23b: navnetreffet rapporteres i needs_review");
        assertEq(review?.reason, "name_only_match", "nd-23c: med korrekt begrunnelse");
        const after = readProvider("nd-p-name-only");
        assertEq(after.adresse, null, "nd-23d (MANDATORY #4): INGENTING skrevet for et navnetreff, selv under apply:true");
        assertEq(after.epost, null, "nd-23e (MANDATORY #4): ...heller ikke epost");
      }

      // ═══ nd-24: mandatory failing-test #5 — never creates a new row ═══
      {
        const before = countProviders();
        // "Helt Urelatert Virksomhet" (fixture member 5) has no domain or
        // name corroboration against ANY seeded provider -> genuine no_match.
        const res = await callNd({ apply: true }); // cohort mode — every eligible seeded row
        const after = countProviders();
        assertEq(after, before, "nd-24a (MANDATORY #5): providerantallet er UENDRET etter en full kjøring");
        const noMatchEntry = (res.body?.no_match ?? []).find((m: any) => m.member_name === "Helt Urelatert Virksomhet");
        assertTrue(!!noMatchEntry, "nd-24b: no_match rapporteres eksplisitt for et medlem uten noen match, i stedet for å opprette noe");
      }

      // ═══ nd-25: providerIds narrows the PROVIDER side only ═══
      {
        seed({ id: "nd-p-narrow-a", navn: "Domenetreff Narrow A", hj: "https://www.bareepost-annen.no" });
        // NOT included below — would domain-match "Bare Epost Gard" via epost domain if it were considered.
        seed({ id: "nd-p-narrow-b", navn: "Bare Epost Gard Narrow B", hj: "https://bareepost.no" });
        const res = await callNd({ providerIds: ["nd-p-narrow-a"], apply: true });
        const touchedB = (res.body?.domain_match ?? []).some((m: any) => m.provider_id === "nd-p-narrow-b");
        assertTrue(!touchedB, "nd-25: en provider utenfor providerIds røres ALDRI, selv om den ville matchet et medlem");
        const afterB = readProvider("nd-p-narrow-b");
        assertEq(afterB.epost, null, "nd-25b: ...og fikk ingenting skrevet");
      }

      // ═══ nd-26: ambiguous domain match writes to NEITHER row ═══
      {
        seed({ id: "nd-p-amb-1", navn: "Ambiguous One", hj: "https://www.ingentreff.no" });
        seed({ id: "nd-p-amb-2", navn: "Ambiguous Two", hj: "https://ingentreff.no" });
        const res = await callNd({ providerIds: ["nd-p-amb-1", "nd-p-amb-2"], apply: true });
        const inDomainMatch =
          (res.body?.domain_match ?? []).some((m: any) => m.provider_id === "nd-p-amb-1") ||
          (res.body?.domain_match ?? []).some((m: any) => m.provider_id === "nd-p-amb-2");
        assertTrue(!inDomainMatch, "nd-26a: tvetydig domenetreff skriver til INGEN av radene");
        const review = (res.body?.needs_review ?? []).find((r: any) => r.reason === "ambiguous_domain_match");
        assertTrue(!!review, "nd-26b: rapportert som needs_review/ambiguous_domain_match");
        assertEq(readProvider("nd-p-amb-1").adresse, null, "nd-26c: rad 1 uendret");
        assertEq(readProvider("nd-p-amb-2").adresse, null, "nd-26d: rad 2 uendret");
      }

      // ═══ nd-27: owner-locked row — matched but fill-only guard still fires ═══
      {
        seed({ id: "nd-p-locked", navn: "Domenetreff Gard Locked", hj: "https://www.domenetreff.no", cs: "manual" });
        const res = await callNd({ providerIds: ["nd-p-locked"], apply: true });
        const m = (res.body?.domain_match ?? []).find((x: any) => x.provider_id === "nd-p-locked");
        assertTrue(!!m, "nd-27a: eierlåst rad matches fortsatt på domene (rapporteres, ikke skjult)");
        assertEq((m?.written ?? []).length, 0, "nd-27b: ...men INGENTING skrives (content_source='manual')");
        assertEq(m?.owner_locked, true, "nd-27c: owner_locked:true rapporteres eksplisitt");
        assertEq(readProvider("nd-p-locked").adresse, null, "nd-27d: raden er uendret");
      }
    } finally {
      globalThis.fetch = prevFetch;
      if (prevExpPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExpPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}
