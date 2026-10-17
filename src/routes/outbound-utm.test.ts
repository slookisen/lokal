/**
 * outbound-utm.test.ts — dev-request
 * 2026-10-16-utgaende-lenker-utm-eller-referrer-policy, S1 (beslutning 3=A).
 *
 * Links to the partner's own website on finn-tannlege.com and opplevagent.no
 * carry UTM from the OUTBOUND_UTM rows in src/utils/url-utm.ts, through the
 * unchanged addUtmParams; Referrer-Policy stays no-referrer.
 *
 *   (A) the OUTBOUND_UTM rows hold the values the acceptance criteria name.
 *   (B) dental /klinikk/id/:id and /klinikk/<slug>: the «Hjemmeside» href has
 *       utm_source=finn-tannlege&utm_medium=referral&utm_campaign=clinic_profile
 *       (AC-S1-1) and the same visible text as before; «Book time online»
 *       (online_booking_url), the directory_url link and the JSON-LD (sameAs)
 *       carry no utm_ (AC-S1-3); a clinic's own utm_source is left alone; a
 *       quote in the stored URL cannot break out of the attribute.
 *   (C) Opplevagent, utm_source=opplevagent on every website link (AC-S1-2):
 *       /opplevelse/<slug> (CTA without booking_url, provider name),
 *       /tilbyder/<slug> (both «Tilbyderens nettside» chip branches, contact
 *       «Nettside») with utm_campaign=provider_profile, and
 *       /kategori/gardssalg/produsent/<slug> (intro link, «Nettside» fact)
 *       with utm_campaign=gardssalg_profile. booking_url, «Kilde:» and the
 *       JSON-LD url/sameAs carry no utm_ (AC-S1-3); a provider's own
 *       utm_source is left alone; a URL addUtmParams cannot parse is rendered
 *       as stored.
 *   (D) the site-wide Helmet header is still Referrer-Policy: no-referrer
 *       (AC-S1-3, the code side of the curl -sI probe).
 *
 * Harnesses: (B) as dental-seo.test.ts and (C) as
 * experiences-seo-visning-mcp-tilbyder.test.ts (DENTAL_DB_PATH /
 * EXPERIENCES_DB_PATH=":memory:", db-factory reset, router.handle()).
 *
 * Exported runOutboundUtmTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/outbound-utm.test.ts
 */

import { jsonLdBlocks } from "../../tests/helpers/jsonld-invariants";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callHtmlRoute(router: any, url: string): Promise<{ handled: boolean; status: number; body: string }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      params: {},
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: {},
      lang: "no",
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { statusCode = code; this.statusCode = code; return this; },
      setHeader() { return this; },
      redirect(code: number, loc: string) { resolve({ handled: true, status: code, body: loc }); },
      send(body: unknown) { resolve({ handled: true, status: statusCode, body: String(body) }); return this; },
      json(body: unknown) { resolve({ handled: true, status: statusCode, body: JSON.stringify(body) }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: err ? 500 : 404, body: err ? String(err) : "" });
    });
  });
}

// The attribute value as a browser reads it (escapeHtml's five entities).
function decodeAttr(v: string): string {
  return v.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

// Decoded href of every <a> whose opening tag matches `tagRe` (e.g. /class="cta"/).
function hrefsWhere(html: string, tagRe: RegExp): string[] {
  return [...html.matchAll(/<a\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => tagRe.test(tag))
    .map((tag) => decodeAttr(/\bhref="([^"]*)"/.exec(tag)?.[1] ?? ""));
}

// Decoded href of the <a> directly after `before` (a label or text that is
// unique on the page), or null.
function hrefAfter(html: string, before: string): string | null {
  const i = html.indexOf(before);
  if (i < 0) return null;
  const m = /<a\b[^>]*\bhref="([^"]*)"/.exec(html.slice(i + before.length));
  return m ? decodeAttr(m[1]) : null;
}

function tagged(url: string, source: string, campaign: string): string {
  const u = new URL(url);
  u.searchParams.set("utm_source", source);
  u.searchParams.set("utm_medium", "referral");
  u.searchParams.set("utm_campaign", campaign);
  return u.toString();
}

export async function runOutboundUtmTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  function assertNoUtmInJsonLd(html: string, label: string): unknown[] {
    let blocks: unknown[] = [];
    try { blocks = jsonLdBlocks(html); } catch (err) { assertTrue(false, `${label}: ld+json parses (${String(err)})`); }
    assertTrue(blocks.length > 0, `${label}: page has ld+json to check`);
    assertTrue(!JSON.stringify(blocks).includes("utm_"), `${label}: no utm_ anywhere in the JSON-LD`);
    return blocks;
  }
  const flat = (blocks: unknown[]): any[] =>
    blocks.flatMap((b: any) => (Array.isArray(b) ? b : b && Array.isArray(b["@graph"]) ? [b, ...b["@graph"]] : [b]));

  const { OUTBOUND_UTM } = require("../utils/url-utm") as typeof import("../utils/url-utm");

  // ══════════════════════════════════════════════════════════════
  // (A) the config rows
  // ══════════════════════════════════════════════════════════════
  assertEq(OUTBOUND_UTM.dental.clinic_profile, { source: "finn-tannlege", campaign: "clinic_profile" },
    "config: dental clinic_profile row");
  assertEq(OUTBOUND_UTM.opplevagent.provider_profile, { source: "opplevagent", campaign: "provider_profile" },
    "config: opplevagent provider_profile row");
  assertEq(OUTBOUND_UTM.opplevagent.gardssalg_profile, { source: "opplevagent", campaign: "gardssalg_profile" },
    "config: opplevagent gardssalg_profile row");

  // ══════════════════════════════════════════════════════════════
  // (B) finn-tannlege /klinikk
  // ══════════════════════════════════════════════════════════════
  {
    const prevDentalPath = process.env.DENTAL_DB_PATH;
    process.env.DENTAL_DB_PATH = ":memory:";
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("./dental-seo"),
      require.resolve("../services/dental-store"),
    ]);
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("dental");
      const store = require("../services/dental-store") as typeof import("../services/dental-store");
      const dentalSeo = require("./dental-seo") as typeof import("./dental-seo");
      const router = dentalSeo.default as any;
      const mkClinic = (navn: string, orgNr: string, hjemmeside: string): string => store.createDentalAgent({
        navn, org_nr: orgNr, adresse: "Storgata 2", postnummer: "5700", poststed: "VOSS", fylke: "Vestland",
        telefon: "+47 56 51 00 00", hjemmeside,
      } as any);

      const site = "https://voss-tann.example.no/om-oss";
      const booking = "https://booking.example.no/voss?sig=abc123";
      const directory = "https://www.vestlandfylke.no/tannhelse/voss";
      const clinicId = mkClinic("Voss Tannklinikk AS", "918800201", site);
      db.prepare("UPDATE dental_agents SET catalog_class = 'klinikk', online_booking_url = ?, directory_url = ? WHERE id = ?")
        .run(booking, directory, clinicId);

      const expected = tagged(site, "finn-tannlege", "clinic_profile");
      for (const path of [`/klinikk/id/${clinicId}`, `/klinikk/${dentalSeo.slugifyClinic("Voss Tannklinikk AS", "918800201")}`]) {
        const tag = `dental ${path.startsWith("/klinikk/id/") ? "/klinikk/id/:id" : "/klinikk/<slug>"}`;
        const r = await callHtmlRoute(router, path);
        assertTrue(r.handled && r.status === 200, `${tag}: renders 200 (status ${r.status})`);
        const href = hrefAfter(r.body, '<div class="info-label">Hjemmeside</div>');
        assertEq(href, expected, `${tag}: Hjemmeside href is the stored URL plus UTM`);
        assertTrue(!!href && href.includes("utm_source=finn-tannlege&utm_medium=referral&utm_campaign=clinic_profile"),
          `${tag}: Hjemmeside href carries utm_source=finn-tannlege&utm_medium=referral&utm_campaign=clinic_profile (AC-S1-1)`);
        assertTrue(r.body.includes("utm_source=finn-tannlege&amp;utm_medium=referral&amp;utm_campaign=clinic_profile"),
          `${tag}: the & between the UTM params is HTML-escaped in the attribute`);
        assertTrue(r.body.includes('rel="nofollow noopener" target="_blank">voss-tann.example.no/om-oss</a>'),
          `${tag}: Hjemmeside link text is the stored URL without scheme, as before`);
        assertEq(hrefsWhere(r.body, /class="btn-book"/), [booking], `${tag}: «Book time online» href is online_booking_url as stored`);
        assertEq(hrefAfter(r.body, '<div class="info-label">Oversikt hos fylkeskommunen</div>'), directory,
          `${tag}: directory_url href is as stored`);
        const blocks = assertNoUtmInJsonLd(r.body, tag);
        const dentist = flat(blocks).find((n) => n?.["@type"] === "Dentist");
        assertEq(dentist?.sameAs, site, `${tag}: Dentist sameAs is the stored hjemmeside`);
      }

      // The clinic's own utm_source wins (addUtmParams leaves the URL alone).
      const ownUtm = "https://egen-tann.example.no/?utm_source=nyhetsbrev&utm_medium=email";
      const ownId = mkClinic("Egen Utm Tannklinikk AS", "918800202", ownUtm);
      const own = await callHtmlRoute(router, `/klinikk/id/${ownId}`);
      assertEq(hrefAfter(own.body, '<div class="info-label">Hjemmeside</div>'), ownUtm,
        "dental: a hjemmeside with its own utm_source is rendered untouched");
      assertTrue(!own.body.includes("utm_source=finn-tannlege"), "dental: … and finn-tannlege UTM is not added anywhere on that page");

      // A quote in the stored URL stays inside the attribute.
      const quoteId = mkClinic("Sitat Tannklinikk AS", "918800203", 'https://sitat.example.no/a"onmouseover="alert(1)');
      const quote = await callHtmlRoute(router, `/klinikk/id/${quoteId}`);
      assertTrue(quote.status === 200 && !quote.body.includes('"onmouseover="'), "dental: a quote in hjemmeside cannot break out of the href attribute");
      const quoteHref = hrefAfter(quote.body, '<div class="info-label">Hjemmeside</div>') ?? "";
      assertTrue(quoteHref.startsWith("https://sitat.example.no/") && quoteHref.includes("utm_campaign=clinic_profile"),
        "dental: … and the link still goes to the clinic with UTM");
    } catch (err) {
      failed++;
      failures.push(`dental section: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
    } finally {
      if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalPath;
      try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best-effort */ }
      restoreModuleCache();
    }
  }

  // ══════════════════════════════════════════════════════════════
  // (C) Opplevagent
  // ══════════════════════════════════════════════════════════════
  {
    const prevDb = process.env.EXPERIENCES_DB_PATH;
    const prevSwitcher = process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("../services/gardssalg-claim"),
      require.resolve("./experiences-seo"),
    ]);
    try {
      try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* already loaded */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");

      const insProv = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, adresse, postnummer, poststed, fylke, kommune, telefon, hjemmeside, slug,
            brreg_active, brreg_verified, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @org, 'Storgata 1', '5700', 'Voss', 'Vestland', 'Voss', '+47 91234567', @site, @slug,
            1, @bv, 'verified', 'test-fixture', 'high')`,
      );
      const insExp = db.prepare(
        `INSERT INTO experiences (id, provider_id, slug, title, title_no, description, category, kommune, fylke,
           indoor_outdoor, verification_status, evidence_url, booking_url)
         VALUES (@id, @pid, @slug, @title, @title, 'En ekte opplevelse med lokal guide for små grupper og familier.',
           'mat_drikke', 'Voss', 'Vestland', 'outdoor', 'verified', @ev, @bk)`,
      );
      const site = "https://full.example.no/";
      const evidence = "https://kilde.example.no/program/matvandring";
      const booking = "https://book.example.no/tur?token=signert-abc";
      const ownUtm = "https://egen.example.no/?utm_source=facebook&utm_medium=social";
      const unparseable = "https://ikke gyldig.example.no/";
      insProv.run({ id: "ou-full", navn: "Full Tilbyder AS", org: "923456781", site, slug: "full-tilbyder", bv: 1 });
      insProv.run({ id: "ou-unverified", navn: "Uverifisert Tilbyder", org: "923456782", site: "https://uverifisert.example.no/turer", slug: "uverifisert-tilbyder", bv: 0 });
      insProv.run({ id: "ou-own", navn: "Egen Utm Tilbyder", org: "923456783", site: ownUtm, slug: "egen-utm-tilbyder", bv: 1 });
      insProv.run({ id: "ou-bad", navn: "Ugyldig Url Tilbyder", org: "923456784", site: unparseable, slug: "ugyldig-url-tilbyder", bv: 1 });
      insExp.run({ id: "ou-exp-site", pid: "ou-full", slug: "ou-uten-booking", title: "Matvandring", ev: evidence, bk: null });
      insExp.run({ id: "ou-exp-book", pid: "ou-full", slug: "ou-med-booking", title: "Ølsmaking", ev: null, bk: booking });
      insExp.run({ id: "ou-exp-unv", pid: "ou-unverified", slug: "ou-uverifisert", title: "Fjordtur", ev: null, bk: null });
      insExp.run({ id: "ou-exp-own", pid: "ou-own", slug: "ou-egen-utm", title: "Gardsbesøk", ev: null, bk: null });
      insExp.run({ id: "ou-exp-bad", pid: "ou-bad", slug: "ou-ugyldig-url", title: "Brevandring", ev: null, bk: null });

      const insGs = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
            geocode_confidence, slug, hjemmeside, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', 'Vestland', 'Voss', 'Voss', 'bryggeri', 0, NULL, 60.63, 6.42,
            'high', @slug, @site, 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      const gsSite = "https://gard.example.no/";
      insGs.run({ id: "ou-gs", navn: "Vossa Bryggeri", slug: "vossa-bryggeri", site: gsSite });
      insGs.run({ id: "ou-gs-own", navn: "Egen Utm Bryggeri", slug: "egen-utm-bryggeri", site: ownUtm });

      const router = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;
      const provTagged = tagged(site, "opplevagent", "provider_profile");

      // /opplevelse without booking_url: CTA and provider name go to the site.
      {
        const tag = "oa /opplevelse (no booking_url)";
        const r = await callHtmlRoute(router, "/opplevelse/ou-uten-booking");
        assertTrue(r.handled && r.status === 200, `${tag}: renders 200 (status ${r.status})`);
        assertEq(hrefsWhere(r.body, /class="cta"/), [provTagged], `${tag}: website CTA href carries utm_source=opplevagent / provider_profile (AC-S1-2)`);
        assertEq(hrefAfter(r.body, '<p class="prov-name">'), provTagged, `${tag}: provider-name link carries the same UTM`);
        assertTrue(r.body.includes(">Full Tilbyder AS</a>"), `${tag}: provider-name link text unchanged`);
        assertEq(hrefAfter(r.body, '<p class="evidence">Kilde: '), evidence, `${tag}: «Kilde:» href is evidence_url as stored`);
        const blocks = assertNoUtmInJsonLd(r.body, tag);
        assertTrue(JSON.stringify(blocks).includes(JSON.stringify(site)), `${tag}: JSON-LD still names the stored website`);
      }
      // /opplevelse with booking_url: CTA is the booking URL, untouched.
      {
        const tag = "oa /opplevelse (booking_url)";
        const r = await callHtmlRoute(router, "/opplevelse/ou-med-booking");
        assertTrue(r.handled && r.status === 200, `${tag}: renders 200 (status ${r.status})`);
        assertEq(hrefsWhere(r.body, /class="cta"/), [booking], `${tag}: booking CTA href is booking_url as stored`);
        assertEq(hrefAfter(r.body, '<p class="prov-name">'), provTagged, `${tag}: provider-name link still carries UTM`);
        assertNoUtmInJsonLd(r.body, tag);
      }
      // /tilbyder, Brreg-verified: chip + contact «Nettside».
      {
        const tag = "oa /tilbyder (verified)";
        const r = await callHtmlRoute(router, "/tilbyder/full-tilbyder");
        assertTrue(r.handled && r.status === 200, `${tag}: renders 200 (status ${r.status})`);
        assertTrue(r.body.includes("✓ Verifisert mot Brønnøysundregistrene"), `${tag}: the verified chip branch rendered`);
        assertEq(hrefsWhere(r.body, /class="chip"/), [provTagged], `${tag}: «Tilbyderens nettside» chip href carries UTM (AC-S1-2)`);
        assertEq(hrefAfter(r.body, "<strong>Nettside:</strong> "), provTagged, `${tag}: contact «Nettside» href carries UTM`);
        assertTrue(r.body.includes(">full.example.no</a></li>"), `${tag}: contact «Nettside» link text is still the host`);
        const blocks = assertNoUtmInJsonLd(r.body, tag);
        const org = flat(blocks).find((n) => n?.["@type"] === "Organization" && n?.name === "Full Tilbyder AS");
        assertEq(org?.sameAs, [site], `${tag}: Organization sameAs is the stored website`);
      }
      // /tilbyder, not Brreg-verified: the other chip branch.
      {
        const tag = "oa /tilbyder (unverified)";
        const r = await callHtmlRoute(router, "/tilbyder/uverifisert-tilbyder");
        assertTrue(r.handled && r.status === 200, `${tag}: renders 200 (status ${r.status})`);
        assertTrue(!r.body.includes("✓ Verifisert mot Brønnøysundregistrene"), `${tag}: the unverified chip branch rendered`);
        assertEq(hrefsWhere(r.body, /class="chip"/), [tagged("https://uverifisert.example.no/turer", "opplevagent", "provider_profile")],
          `${tag}: «Tilbyderens nettside» chip href carries UTM`);
      }
      // The provider's own utm_source wins on every link.
      {
        const tag = "oa own utm_source";
        const exp = await callHtmlRoute(router, "/opplevelse/ou-egen-utm");
        assertEq(hrefsWhere(exp.body, /class="cta"/), [ownUtm], `${tag}: /opplevelse CTA href untouched`);
        assertEq(hrefAfter(exp.body, '<p class="prov-name">'), ownUtm, `${tag}: /opplevelse provider-name href untouched`);
        const prov = await callHtmlRoute(router, "/tilbyder/egen-utm-tilbyder");
        assertEq(hrefsWhere(prov.body, /class="chip"/), [ownUtm], `${tag}: /tilbyder chip href untouched`);
        assertEq(hrefAfter(prov.body, "<strong>Nettside:</strong> "), ownUtm, `${tag}: /tilbyder contact href untouched`);
        for (const [path, body] of [["/opplevelse", exp.body], ["/tilbyder", prov.body]]) {
          assertTrue(!body.includes("utm_source=opplevagent"), `${tag}: ${path} adds no opplevagent UTM anywhere`);
        }
      }
      // A URL that addUtmParams cannot parse is rendered exactly as before.
      {
        const tag = "oa unparseable website";
        const r = await callHtmlRoute(router, "/tilbyder/ugyldig-url-tilbyder");
        assertTrue(r.handled && r.status === 200, `${tag}: renders 200 (status ${r.status})`);
        assertEq(hrefsWhere(r.body, /class="chip"/), [unparseable], `${tag}: chip href is the stored value, no UTM`);
      }
      // Gårdssalg producer page: intro link + «Nettside» fact.
      {
        const tag = "oa /kategori/gardssalg/produsent";
        const r = await callHtmlRoute(router, "/kategori/gardssalg/produsent/vossa-bryggeri");
        assertTrue(r.handled && r.status === 200, `${tag}: renders 200 (status ${r.status})`);
        const gsTagged = tagged(gsSite, "opplevagent", "gardssalg_profile");
        assertEq(hrefAfter(r.body, "Les mer om produsenten og produktene på "), gsTagged,
          `${tag}: intro link carries utm_source=opplevagent / gardssalg_profile (AC-S1-2)`);
        assertEq(hrefAfter(r.body, '<th scope="row">Nettside</th><td>'), gsTagged, `${tag}: «Nettside» fact href carries the same UTM`);
        assertTrue(r.body.includes(">gard.example.no</a>"), `${tag}: link text is still the host`);
        assertTrue(!r.body.includes("utm_campaign=provider_profile"), `${tag}: the page uses the gardssalg_profile row only`);
        const blocks = assertNoUtmInJsonLd(r.body, tag);
        assertTrue(flat(blocks).some((n) => Array.isArray(n?.sameAs) && n.sameAs.includes(gsSite)), `${tag}: JSON-LD sameAs is the stored website`);

        const own = await callHtmlRoute(router, "/kategori/gardssalg/produsent/egen-utm-bryggeri");
        assertEq(hrefAfter(own.body, '<th scope="row">Nettside</th><td>'), ownUtm, `${tag}: a website with its own utm_source is untouched`);
        assertTrue(!own.body.includes("utm_source=opplevagent"), `${tag}: … and no opplevagent UTM is added anywhere on that page`);
      }
    } catch (err) {
      failed++;
      failures.push(`oa section: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
    } finally {
      if (prevDb === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevDb;
      if (prevSwitcher === undefined) delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED; else process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED = prevSwitcher;
      try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best-effort */ }
      restoreModuleCache();
    }
  }

  // ══════════════════════════════════════════════════════════════
  // (D) Referrer-Policy is unchanged
  // ══════════════════════════════════════════════════════════════
  {
    const { securityHeaders } = require("../middleware/security") as typeof import("../middleware/security");
    const headers: Record<string, string> = {};
    const res: any = {
      setHeader(name: string, value: string) { headers[name.toLowerCase()] = String(value); return this; },
      removeHeader(name: string) { delete headers[name.toLowerCase()]; },
      getHeader(name: string) { return headers[name.toLowerCase()]; },
    };
    let nextCalled = false;
    securityHeaders({ method: "GET", url: "/", headers: {} } as any, res, () => { nextCalled = true; });
    assertTrue(nextCalled, "helmet: securityHeaders calls next()");
    assertEq(headers["referrer-policy"], "no-referrer", "helmet: Referrer-Policy is still no-referrer (beslutning 3=A)");
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/outbound-utm.test.ts`
if (require.main === module) {
  console.log("── outbound partner-link UTM (dev-request 2026-10-16-utgaende-lenker-utm-eller-referrer-policy S1) ──");
  runOutboundUtmTests({ log: true }).then((r) => {
    console.log(`\noutbound-utm: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
