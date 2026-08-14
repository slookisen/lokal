/**
 * bm-producer-harvest.test.ts — dev-request 2026-08-14-bm-fullhoest-katalogbred, slice 2.
 *
 * Covers AC1-AC4 from the slice spec:
 *   AC1 — fetchBmProducerSlugs: sitemap slug extraction, dedup, no false
 *         positives from non-producer <loc> entries.
 *   AC2 — parseBmProducerPage: LocalBusiness ld+json selection among several
 *         blocks, plus mailto:/tel: extraction.
 *   AC3 — directory-host website exclusion + @bondensmarked.no email
 *         exclusion.
 *   AC4 — matchBmProducerToCatalog: name-only match blocked by a
 *         disagreeing city anchor; positive match when both agree.
 *   AC3c — parseBmProducerPage: an unparseable JSON-LD url (hostOf() returns
 *         null) must fail CLOSED — website: null, not the raw string leaking
 *         through unvalidated.
 *   AC4e — matchBmProducerToCatalog / cityAnchorAgrees: the anchor requires
 *         an EXACT match after normalising, not "one contains the other" —
 *         short real Norwegian place names ("Os" vs "Oslo"/"Osen", "Nes" vs
 *         "Nesodden") must not rubber-stamp a match.
 *
 * All fetch access is via an injected fetchImpl fixture — nothing here
 * reaches the real network. Wired into tests/test.ts.
 * Standalone: npx tsx src/services/bm-producer-harvest.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import {
  fetchBmProducerSlugs,
  parseBmProducerPage,
  matchBmProducerToCatalog,
} from "./bm-producer-harvest";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runBmProducerHarvestTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // ── AC1: fetchBmProducerSlugs ─────────────────────────────────────────
  {
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url>
<loc>https://bondensmarked.no/produsenter</loc>
<changefreq>weekly</changefreq>
<priority>0.8</priority>
</url>
<url>
<loc>https://bondensmarked.no/bli-produsent</loc>
<changefreq>weekly</changefreq>
<priority>0.8</priority>
</url>
<url>
<loc>https://bondensmarked.no/lokallag</loc>
<changefreq>weekly</changefreq>
<priority>0.8</priority>
</url>
<url>
<loc>https://bondensmarked.no/produsenter/aalan-gard</loc>
<changefreq>weekly</changefreq>
<priority>0.8</priority>
</url>
<url>
<loc>https://bondensmarked.no/produsenter/aimee-s-farm</loc>
<changefreq>weekly</changefreq>
<priority>0.8</priority>
</url>
<url>
<loc>https://bondensmarked.no/produsenter/alm-gard</loc>
<changefreq>weekly</changefreq>
<priority>0.8</priority>
</url>
<url>
<loc>https://bondensmarked.no/produsenter/anitas-sjoemat</loc>
<changefreq>weekly</changefreq>
<priority>0.8</priority>
</url>
<url>
<loc>https://bondensmarked.no/produsenter/aalan-gard</loc>
<changefreq>weekly</changefreq>
<priority>0.8</priority>
</url>
<url>
<loc>https://bondensmarked.no/om-oss</loc>
</url>
</urlset>`;

    let fetchCalls = 0;
    const stubFetch = (async (url: any) => {
      fetchCalls++;
      assertEq(String(url), "https://bondensmarked.no/sitemap.xml", "ac1: fetches the sitemap URL");
      return new Response(sitemapXml, { status: 200, headers: { "content-type": "application/xml" } });
    }) as unknown as typeof fetch;

    const slugs = await fetchBmProducerSlugs(stubFetch);
    assertEq(fetchCalls, 1, "ac1: exactly one fetch call");
    assertEq(
      slugs,
      ["aalan-gard", "aimee-s-farm", "alm-gard", "anitas-sjoemat"],
      "ac1: exactly the real producer slugs come back, deduped, no false positives from /produsenter, /bli-produsent, /lokallag, /om-oss",
    );
  }

  // AC1b: non-OK HTTP response → empty array, not a throw
  {
    const failFetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const slugs = await fetchBmProducerSlugs(failFetch);
    assertEq(slugs, [], "ac1b: non-OK sitemap fetch yields an empty list, not a throw");
  }

  // AC1c: a thrown fetch (network error) → empty array, not a throw
  {
    const throwFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const slugs = await fetchBmProducerSlugs(throwFetch);
    assertEq(slugs, [], "ac1c: a fetch that throws yields an empty list, not a propagated throw");
  }

  // ── AC2: parseBmProducerPage, real aalan-gard fixture ──────────────────
  const AALAN_LOCAL_BUSINESS_LD_JSON =
    '{"@context":"https://schema.org","@type":"LocalBusiness","name":"Aalan Gård","url":"http://www.aalan.no","description":"På Aalan Gård finner du den ekte og naturlige lofotopplevelsen, der du som turist aktivt kan oppleve et mangfoldig gårdsbruk med osteproduksjon, urtehage og forskjellige dyr. Produktene våre kan kjøpes eller smakes på i gårdsbutikken eller i vår gårdskafé som har åpen på sommeren.","image":"https://ayifaapgvigdcnqsfdgo.supabase.co/storage/v1/object/public/producer-photos/0add5e80-f53e-46c1-8060-1800d8e03044/1770858975315-mevnaw.jpg","address":{"@type":"PostalAddress","addressLocality":"Bøstad","addressCountry":"NO"},"sameAs":["https://www.facebook.com/aalan.no"]}';

  const AALAN_BREADCRUMB_LD_JSON = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Hjem", item: "https://bondensmarked.no" },
      { "@type": "ListItem", position: 2, name: "Produsenter", item: "https://bondensmarked.no/produsenter" },
      { "@type": "ListItem", position: 3, name: "Aalan Gård", item: "https://bondensmarked.no/produsenter/aalan-gard" },
    ],
  });

  const AALAN_SOURCE_URL = "https://bondensmarked.no/produsenter/aalan-gard";
  const AALAN_HTML = `<!DOCTYPE html><html><head>
<script type="application/ld+json">${AALAN_BREADCRUMB_LD_JSON}</script>
<script type="application/ld+json">${AALAN_LOCAL_BUSINESS_LD_JSON}</script>
<script type="application/ld+json">${AALAN_BREADCRUMB_LD_JSON}</script>
</head><body>
<div class="producer-contact">
<a href="mailto:tove@aalan.no" class="text-sm inline-flex items-center gap-1">tove@aalan.no</a>
<a href="tel:+4797711184" class="text-sm inline-flex items-center gap-1">+47 977 11 184</a>
</div>
</body></html>`;

  {
    const record = parseBmProducerPage(AALAN_HTML, AALAN_SOURCE_URL);
    assertTrue(record !== null, "ac2: aalan-gard fixture parses to a non-null record");
    assertEq(record?.slug, "aalan-gard", "ac2: slug derived from sourceUrl");
    assertEq(record?.name, "Aalan Gård", "ac2: name — the LocalBusiness block was correctly selected among 3 ld+json blocks");
    assertEq(record?.website, "http://www.aalan.no", "ac2: website");
    assertEq(record?.city, "Bøstad", "ac2: city (address.addressLocality)");
    assertEq(record?.email, "tove@aalan.no", "ac2: email — first mailto: on the page");
    assertEq(record?.phone, "+4797711184", "ac2: phone — first tel: on the page");
    assertEq(record?.sourceUrl, AALAN_SOURCE_URL, "ac2: sourceUrl echoed back");
    assertEq(record?.bmDomainEmailExcluded, false, "ac2: a real producer email is not flagged as BM-domain-excluded");
  }

  // AC2b: no ld+json at all → null, logged not thrown
  {
    const record = parseBmProducerPage("<html><body>no ld+json here</body></html>", "https://bondensmarked.no/produsenter/nope");
    assertEq(record, null, "ac2b: a page with no LocalBusiness ld+json block parses to null");
  }

  // AC2c: LocalBusiness block present but name missing/empty → null
  {
    const ldNoName = JSON.stringify({ "@context": "https://schema.org", "@type": "LocalBusiness", url: "https://x.no" });
    const html = `<script type="application/ld+json">${ldNoName}</script>`;
    const record = parseBmProducerPage(html, "https://bondensmarked.no/produsenter/noname");
    assertEq(record, null, "ac2c: LocalBusiness block with no usable name parses to null");
  }

  // ── AC3a: JSON-LD url pointing at a bondensmarked.no host → website: null ──
  {
    const ld = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      name: "Test Gård AS",
      url: "https://bondensmarked.no/some-other-page",
      address: { "@type": "PostalAddress", addressLocality: "Oslo", addressCountry: "NO" },
    });
    const html = `<script type="application/ld+json">${ld}</script>`;
    const record = parseBmProducerPage(html, "https://bondensmarked.no/produsenter/test-gard");
    assertTrue(record !== null, "ac3a: record parses");
    assertEq(record?.website, null, "ac3a: a bondensmarked.no host in JSON-LD url is never surfaced as the producer's own website");
    assertEq(record?.name, "Test Gård AS", "ac3a: name is still extracted despite the website exclusion");
  }

  // ── AC3b: the only mailto: on the page is @bondensmarked.no → email: null ──
  {
    const ld = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      name: "Test To AS",
      url: "https://testto.no",
      address: { "@type": "PostalAddress", addressLocality: "Bergen", addressCountry: "NO" },
    });
    const html = `<script type="application/ld+json">${ld}</script><a href="mailto:kontakt@bondensmarked.no">Kontakt oss</a>`;
    const record = parseBmProducerPage(html, "https://bondensmarked.no/produsenter/test-to");
    assertTrue(record !== null, "ac3b: record parses");
    assertEq(record?.email, null, "ac3b: an @bondensmarked.no mailto: is never surfaced as the producer's contact email");
    assertEq(record?.bmDomainEmailExcluded, true, "ac3b: the exclusion is flagged for the route's bm_domain_email_excluded_count metric");
    assertEq(record?.website, "https://testto.no", "ac3b: a genuine website is unaffected by the email exclusion");
  }

  // ── AC3c: JSON-LD url that hostOf() cannot parse → website: null (fail
  // CLOSED, not fail-open-and-leak-the-raw-string). "https:// bondensmarked
  // .no" (a space right after the scheme) survives .trim() unchanged but
  // fails hostOf()'s scheme regex / new URL() — exactly the unparseable-host
  // shape a real malformed directory-host URL could take.
  {
    const UNPARSEABLE_URL = "https:// bondensmarked.no";
    const ld = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      name: "Test Tre AS",
      url: UNPARSEABLE_URL,
      address: { "@type": "PostalAddress", addressLocality: "Trondheim", addressCountry: "NO" },
    });
    const html = `<script type="application/ld+json">${ld}</script>`;
    const record = parseBmProducerPage(html, "https://bondensmarked.no/produsenter/test-tre");
    assertTrue(record !== null, "ac3c: record parses despite the unparseable url");
    assertEq(
      record?.website,
      null,
      "ac3c: an unparseable JSON-LD url (hostOf() -> null) fails CLOSED to website: null instead of leaking the raw unvalidated string",
    );
  }

  // ── AC4: matchBmProducerToCatalog ───────────────────────────────────────
  // matchBmProducerToCatalog takes its db handle as an explicit parameter
  // (not via getDb()), so these fixtures never touch the getDb() singleton
  // at all — a plain throwaway in-memory DB per sub-case is enough.
  {
    const db = new Database(":memory:");
    try {
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, is_active)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', 'https://example.no', 'producer', ?, ?, 1)`,
      );
      insertAgent.run("agent-trondheim", "Ringstad Gård", "api-key-trondheim", "Trondheim");
      insertAgent.run("agent-inactive", "Ringstad Gård", "api-key-inactive", "Bergen");
      db.prepare(
        `UPDATE agents SET is_active = 0 WHERE id = 'agent-inactive'`,
      ).run();

      // ac4a: near-exact name match, but city disagrees — the anchor blocks it.
      const recordCityMismatch = {
        slug: "ringstad-gard",
        name: "Ringstad Gård",
        website: null,
        city: "Bergen",
        email: null,
        phone: null,
        sourceUrl: "https://bondensmarked.no/produsenter/ringstad-gard",
        bmDomainEmailExcluded: false,
      };
      const resultMismatch = matchBmProducerToCatalog(db as any, recordCityMismatch);
      assertEq(resultMismatch, null, "ac4a: a name-only match (Bergen vs Trondheim) is blocked by the disagreeing city anchor");

      // ac4b: name AND city both agree — match returned.
      const recordCityAgrees = { ...recordCityMismatch, city: "Trondheim" };
      const resultAgrees = matchBmProducerToCatalog(db as any, recordCityAgrees);
      assertTrue(resultAgrees !== null, "ac4b: name + city agreement yields a match");
      assertEq(resultAgrees?.agentId, "agent-trondheim", "ac4b: matched the active Trondheim agent, not the inactive Bergen one");
      assertEq(resultAgrees?.agentName, "Ringstad Gård", "ac4b: agentName echoed back");
      assertEq(resultAgrees?.cityMatched, true, "ac4b: cityMatched is true");
      assertTrue((resultAgrees?.nameScore ?? 0) >= 0.85, "ac4b: nameScore clears the 0.85 threshold");

      // ac4c: record.city is null — the anchor cannot be verified, so no match
      // even though the name is a perfect hit.
      const recordNoCity = { ...recordCityMismatch, city: null };
      const resultNoCity = matchBmProducerToCatalog(db as any, recordNoCity);
      assertEq(resultNoCity, null, "ac4c: a null record.city fails the anchor requirement, even with a perfect name match");

      // ac4d: no catalog agents at all → null, not a throw.
      const emptyDb = new Database(":memory:");
      initMod.__initSchemaForTesting(emptyDb as any);
      const resultEmpty = matchBmProducerToCatalog(emptyDb as any, recordCityAgrees);
      assertEq(resultEmpty, null, "ac4d: an empty catalog yields null, not a throw");
      emptyDb.close();
    } finally {
      db.close();
    }
  }

  // ── AC4e: city anchor requires an EXACT match — no substring/"one
  // contains the other" leniency. A perfect (>=0.85) name match paired with
  // a short real Norwegian place name that happens to be a substring of an
  // unrelated municipality (Os/Oslo, Os/Osen, Nes/Nesodden) must NOT match.
  {
    const db = new Database(":memory:");
    try {
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, is_active)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', 'https://example.no', 'producer', ?, ?, 1)`,
      );
      insertAgent.run("agent-oslo", "Vestli Gård", "api-key-oslo", "Oslo");
      insertAgent.run("agent-osen", "Vestli Gård", "api-key-osen", "Osen");
      insertAgent.run("agent-nesodden", "Vestli Gård", "api-key-nesodden", "Nesodden");

      const baseRecord = {
        slug: "vestli-gard",
        name: "Vestli Gård",
        website: null,
        email: null,
        phone: null,
        sourceUrl: "https://bondensmarked.no/produsenter/vestli-gard",
        bmDomainEmailExcluded: false,
      };

      assertEq(
        matchBmProducerToCatalog(db as any, { ...baseRecord, city: "Os" }),
        null,
        'ac4e: BM city "Os" vs catalog city "Oslo" — high name-similarity alone must not rubber-stamp a match (substring rule regression)',
      );

      // Swap in a dedicated "Os" agent and confirm the exact-match case still
      // works correctly (the fix isn't overly strict — it just isn't fuzzy).
      db.prepare(`UPDATE agents SET is_active = 0 WHERE id != 'agent-oslo'`).run();
      db.prepare(`UPDATE agents SET city = 'Os' WHERE id = 'agent-oslo'`).run();
      const resultExactOs = matchBmProducerToCatalog(db as any, { ...baseRecord, city: "Os" });
      assertTrue(resultExactOs !== null, 'ac4e: an EXACT city match ("Os" === "Os") still succeeds after the fix');
    } finally {
      db.close();
    }
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/bm-producer-harvest.test.ts`
if (require.main === module) {
  (async () => {
    console.log("── bm-producer-harvest ──");
    const r = await runBmProducerHarvestTests({ log: true });
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  })();
}
