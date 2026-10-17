/**
 * safe-script-json-pages.test.ts — dev-request
 * 2026-10-17-jsonld-script-escaping-felles-serialiserer: rendered pages on
 * Opplevagent and Finn-tannlege with DB values that contain `<!--<script>`.
 *
 * Before this dev-request every JSON-in-<script> emitter on the two sites
 * escaped only `</`. A value with `<!--<script>` put the HTML parser in the
 * "script data double escaped" state, so the real `</script>` no longer ended
 * the element and the rest of the page was swallowed. The pages now go through
 * serializeJsonForScript()/jsonLdScriptTag() (src/services/safe-script-json.ts).
 *
 * Covers, for each page (tests/helpers/html-script-elements.ts reads the page
 * the way the parser does):
 *   (a) every <script> element ends where it should: all closed, and as many
 *       elements as `<script` start tags in the page, so no start tag hides
 *       inside another script;
 *   (b) the number of ld+json blocks is the same as before the change
 *       (pinned per page), each one parses, and the parser's blocks are the
 *       ones jsonLdBlocks() reads;
 *   (c) no `<\/` and no raw `<`, `>` or `&` is left in any JSON script;
 *   (d) the payload reaches the JSON-LD and the map data unchanged once
 *       parsed (the test is not vacuous), on detail, category, kommune,
 *       fylke, combo and provider pages, the gårdssalg base, type, producer
 *       and booking pages, and two dental pages; the static pages keep their
 *       blocks;
 *   (e) byte-identical where the content has none of the five characters:
 *       the gårdssalg base page's CollectionPage equals the hand-written blob
 *       it replaced, the producer and booking pages' inline-script values are
 *       unchanged, and agentplatform.no's Organization and the RFB
 *       handleliste copy JSON equal their previous serializers' output for
 *       every language (and payments on/off).
 *
 * Harness: same as rfb-jsonld-ingen-tredjepartsrating.test.ts (C) and (D)
 * (EXPERIENCES_DB_PATH / DENTAL_DB_PATH=":memory:", db-factory reset,
 * router.handle()).
 *
 * Run standalone: npx tsx src/routes/safe-script-json-pages.test.ts
 * Wired into `npm test` via tests/test.ts.
 */

import { jsonLdBlocks } from "../../tests/helpers/jsonld-invariants";
import { scriptElements, scriptStartTagCount } from "../../tests/helpers/html-script-elements";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// The probe from the lokal#1103 review, plus `>`.
const P = "X</script><script>alert(1)</script><!--<script>&\"'>";
const LD_START = "<script type=\"application/ld+json\">";

function callHtmlRoute(router: any, url: string): Promise<{ handled: boolean; status: number; body: string }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: {},
      ip: "127.0.0.1",
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

/** Every string value in a parsed JSON tree. */
function allStrings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(allStrings);
  if (v && typeof v === "object") return Object.values(v as Record<string, unknown>).flatMap(allStrings);
  return [];
}

export async function runSafeScriptJsonPagesTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.log(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  /**
   * (a)–(d) for one rendered page. `ldCount` is the page's number of ld+json
   * blocks before the change; `payloadIn` names the ld+json @types (or
   * "map:<id>" for a map data island) that must carry the payload.
   */
  function checkPage(label: string, r: { handled: boolean; status: number; body: string }, ldCount: number, payloadIn: string[]): void {
    assertTrue(r.handled && r.status === 200, `${label}: renders 200 (status ${r.status})`);
    const els = scriptElements(r.body);
    assertTrue(els.length > 0 && els.every((e) => e.closed),
      `${label} (a): every <script> element is closed (${els.filter((e) => !e.closed).length} of ${els.length} swallow the rest of the page)`);
    assertEq(els.length, scriptStartTagCount(r.body), `${label} (a): as many script elements as <script start tags (none hides inside a script)`);

    const ld = els.filter((e) => e.startTag === LD_START);
    assertEq(ld.length, ldCount, `${label} (b): ${ldCount} ld+json block(s), as before the change`);
    let parsed: unknown[] = [];
    try { parsed = ld.map((e) => JSON.parse(e.content)); } catch (err) { assertTrue(false, `${label} (b): every ld+json block parses (${String(err)})`); }
    assertTrue(parsed.length === ld.length, `${label} (b): every ld+json block parses`);
    let regexView: unknown[] = [];
    try { regexView = jsonLdBlocks(r.body); } catch { /* reported by the assertion below */ }
    assertEq(regexView, parsed, `${label} (b): the parser's ld+json blocks are the ones jsonLdBlocks() reads`);

    const json = els.filter((e) => /type="application\/(?:ld\+)?json"/.test(e.startTag));
    assertTrue(json.every((e) => !e.content.includes("<\\/")), `${label} (c): no <\\/ left in any JSON script`);
    assertTrue(json.every((e) => !/[<>&]/.test(e.content)), `${label} (c): no raw < > & in any JSON script`);

    for (const where of payloadIn) {
      let values: string[] = [];
      if (where.startsWith("map:")) {
        const el = els.find((e) => e.startTag.includes(`id="${where.slice(4)}"`));
        try { values = el ? allStrings(JSON.parse(el.content)) : []; } catch { values = []; }
      } else {
        values = allStrings(parsed.filter((b) => (b as any)?.["@type"] === where));
      }
      assertTrue(values.some((s) => s.includes(P)), `${label} (d): the DB value with <!--<script> reaches ${where} unchanged`);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Opplevagent
  // ══════════════════════════════════════════════════════════════
  {
    const prevDb = process.env.EXPERIENCES_DB_PATH;
    const prevDispatch = process.env.BOOKING_DISPATCH_ENABLED;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.BOOKING_DISPATCH_ENABLED = "true";
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
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const db = dbFactory.getDb("experiences") as any;
      const router = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;

      // ── fixtures: the payload in titles, descriptions, names and places ──
      const FYLKE = `Troms ${P}`;
      const KOMMUNE = `Tromsø ${P}`;
      const provId = expStore.createProvider({
        navn: `Arktisk ${P} AS`, fylke: FYLKE, kommune: KOMMUNE, hjemmeside: "https://hval.example.no",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const mkExp = (title: string, price: number, at: [number, number]): string => {
        const id = expStore.createExperience({
          title, provider_id: provId, provider_match_status: "matched",
          category: "dyreliv_safari", fylke: FYLKE, kommune: KOMMUNE,
          description: `${title} — guidet tur med lokal tilbyder for små grupper hele året.`,
          price_from: price, price_unit: "per_person",
          loc_lat: at[0], loc_lon: at[1], geo_precision: "address",
          confidence: "high", verification_status: "verified",
        } as any);
        return (expStore.getExperienceById(id) as any).slug as string;
      };
      const slug1 = mkExp(`Hvalsafari ${P}`, 1290, [69.65, 18.96]);
      mkExp(`Nordlys ${P}`, 900, [69.68, 18.94]);

      db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
            geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
         VALUES
           ('ssj-gs', @navn, 'experiences', 'Vestland', 'Voss', @poststed, 'bryggeri', 1, NULL, 60.63, 6.42,
            'high', 'ssj-bryggeri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      ).run({ navn: `Bryggeri ${P}`, poststed: `Voss ${P}` });

      // /tilbyder/<id> answers 301 to the provider's slug URL once it has one.
      const byId = await callHtmlRoute(router, `/tilbyder/${provId}`);
      const tilbyderPath = byId.status === 301 ? byId.body : `/tilbyder/${provId}`;
      const enc = encodeURIComponent;
      const pages: Array<[string, number, string[]]> = [
        // [path, ld+json blocks before the change, where the payload must arrive]
        ["/", 2, []],
        [`/opplevelse/${slug1}`, 3, ["TouristAttraction", "Service", "BreadcrumbList", "map:mini-map-data"]],
        ["/kategori/dyreliv_safari", 3, ["CollectionPage"]],
        [`/kommune/${enc(KOMMUNE)}`, 3, ["CollectionPage", "BreadcrumbList", "FAQPage"]],
        [`/fylke/${enc(FYLKE)}`, 3, ["CollectionPage", "BreadcrumbList", "FAQPage", "map:fylke-map-data"]],
        [`/kategori/dyreliv_safari/${enc(KOMMUNE)}`, 3, ["CollectionPage", "BreadcrumbList", "FAQPage"]],
        [tilbyderPath, 3, ["CollectionPage", "BreadcrumbList", "Organization"]],
        ["/kategori/gardssalg", 1, ["map:gardssalg-map-data"]],
        ["/kategori/gardssalg/bryggeri", 2, ["map:gardssalg-map-data"]],
        ["/kategori/gardssalg/produsent/ssj-bryggeri", 2, ["LocalBusiness", "BreadcrumbList"]],
        ["/kategori/gardssalg/book/ssj-bryggeri", 0, []],
        ["/sok?q=hval", 1, []],
        ["/for-tilbydere", 2, []],
        ["/slik-fungerer-det", 2, []],
        ["/guide-opplevelser-mcp", 1, []],
      ];
      const bodies = new Map<string, string>();
      for (const [p, ldCount, payloadIn] of pages) {
        const r = await callHtmlRoute(router, p);
        bodies.set(p, r.body);
        checkPage(`oa ${decodeURIComponent(p).replace(P, "<P>")}`, r, ldCount, payloadIn);
      }

      // ── (e) byte-identical where nothing needs escaping ──────────────────
      {
        const base = bodies.get("/kategori/gardssalg") ?? "";
        assertTrue(base.includes(LD_START + "{\"@context\":\"https://schema.org\",\"@type\":\"CollectionPage\",\"name\":\"Gårdssalg og smaking\","
          + "\"description\":\"Lokale drikkeprodusenter med gårdsbesøk og smaking\",\"url\":\"https://opplevagent.no/kategori/gardssalg\"}</script>"),
          "oa-e1: /kategori/gardssalg keeps the exact CollectionPage blob it had as a hand-written literal");
        const prod = bodies.get("/kategori/gardssalg/produsent/ssj-bryggeri") ?? "";
        assertTrue(prod.includes("var providerId = \"ssj-gs\";")
          && prod.includes("var portalHref = \"/kategori/gardssalg/eier/ssj-bryggeri/portal\";")
          && prod.includes("var previewHref = \"/kategori/gardssalg/book/ssj-bryggeri\";"),
          "oa-e2: the producer page's inline-script values are unchanged");
        const book = bodies.get("/kategori/gardssalg/book/ssj-bryggeri") ?? "";
        const { BOOKING_NOT_ACTIVATED_MSG } = require("../services/booking-store") as typeof import("../services/booking-store");
        assertTrue(book.includes("window.location.href = \"https://opplevagent.no/kategori/gardssalg/book/ssj-bryggeri\" + \"/confirm/\"")
          && book.includes(`res.data.message || ${JSON.stringify(BOOKING_NOT_ACTIVATED_MSG)};`),
          "oa-e3: the booking page's inline-script values are unchanged");
      }
    } catch (err) {
      failed++;
      failures.push(`oa section: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
    } finally {
      if (prevDb === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevDb;
      if (prevDispatch === undefined) delete process.env.BOOKING_DISPATCH_ENABLED; else process.env.BOOKING_DISPATCH_ENABLED = prevDispatch;
      try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best-effort */ }
      restoreModuleCache();
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Finn-tannlege
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
      const store = require("../services/dental-store") as typeof import("../services/dental-store");
      const router = (require("./dental-seo") as typeof import("./dental-seo")).default as any;

      const clinicId = store.createDentalAgent({
        navn: `Voss Tannklinikk ${P} AS`,
        org_nr: "918800099",
        adresse: "Storgata 2",
        postnummer: "5700",
        poststed: "VOSS",
        fylke: "Vestland",
        telefon: "+47 56 51 00 00",
        hjemmeside: "https://voss-tann.example.no",
      } as any);

      checkPage("dental /klinikk/id/:id", await callHtmlRoute(router, `/klinikk/id/${clinicId}`), 2, ["Dentist"]);
      checkPage("dental /fylke/Vestland", await callHtmlRoute(router, "/fylke/Vestland"), 2, ["ItemList"]);
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
  // (e) agentplatform.no and RFB handleliste: byte-identical to before
  // ══════════════════════════════════════════════════════════════
  {
    const ap = require("./agentplatform-site") as typeof import("./agentplatform-site");
    for (const lang of ["nb", "en"] as const) {
      const html = ap.renderHome(lang, { rfb: 1, experiences: 1, dental: 1 });
      const blocks = scriptElements(html).filter((e) => e.startTag === LD_START);
      const before = (s: string): string => JSON.stringify(JSON.parse(s)).replace(/</g, "\\u003c");
      assertTrue(blocks.length === 1 && blocks[0].content === before(blocks[0].content),
        `ap-e1: agentplatform.no ${lang}: the Organization block is byte-identical to the previous .replace(/</g, "\\\\u003c") serializer`);
    }

    const prevPay = process.env.PAYMENTS_ENABLED;
    try {
      const hl = require("./handleliste-page") as typeof import("./handleliste-page");
      const before = (s: string): string => JSON.stringify(JSON.parse(s))
        .replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
      for (const pay of [undefined, "1"]) {
        if (pay === undefined) delete process.env.PAYMENTS_ENABLED; else process.env.PAYMENTS_ENABLED = pay;
        for (const lang of ["no", "en"] as const) {
          const els = scriptElements(hl.buildHandelistePage(lang).content).filter((e) => e.startTag.includes("id=\"hl-copy\""));
          assertTrue(els.length === 1 && els[0].closed && els[0].content === before(els[0].content),
            `hl-e1: handleliste ${lang}, payments ${pay ? "on" : "off"}: the copy JSON is byte-identical to the previous serializer`);
        }
      }
    } finally {
      if (prevPay === undefined) delete process.env.PAYMENTS_ENABLED; else process.env.PAYMENTS_ENABLED = prevPay;
    }
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/safe-script-json-pages.test.ts`
if (require.main === module) {
  console.log("── safe-script-json: pages with <!--<script> in DB values (dev-request 2026-10-17) ──");
  runSafeScriptJsonPagesTests({ log: true }).then((r) => {
    console.log(`\nsafe-script-json-pages: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
