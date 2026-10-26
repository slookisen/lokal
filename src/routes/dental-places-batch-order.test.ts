/**
 * dental-places-batch-order.test.ts — selection ORDER of
 * POST /api/tannlege/admin/google-places-batch auto-select (src/routes/dental.ts).
 *
 * Bug: with the old ORDER BY (missing-homepage, missing-fields, navn) an
 * expired 90-day no-retry window let old A-named retries sort before
 * never-attempted rows with later names (e.g. 'Åsane'), starving them.
 * Fix: never-attempted rows (places_attempted_at IS NULL) come first; within
 * that class the old keys + navn; retries sort oldest places_attempted_at first.
 *
 * Setup mirrors dental-agents-recently-enriched.test.ts (in-memory dental DB,
 * router.handle()). global.fetch is mocked (no network); write:false so no DB
 * writes. adresse/telefon are filled on every row so the Brreg-first lookup
 * is skipped; opening_hours is NULL so rows stay in the auto-select pool.
 *
 * c) dev-request 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-
 * places-treffvakt, S4-A2: the FieldMasks the batch sends are the pre-S4-A2
 * ones verbatim and carry no Google rating field (dental builds them with
 * placesFieldMask(…, false), whatever RFB's lever says; the lever itself is
 * not flipped here, because this block does not run in the runSerial chain).
 * Every one of them is in the Places call log, none marked as a rating call.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callBatch(router: any, headers: Record<string, string>, body: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req: any = {
      method: "POST",
      url: "/admin/google-places-batch",
      originalUrl: "/admin/google-places-batch",
      path: "/admin/google-places-batch",
      query: {},
      body,
      headers,
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function runDentalPlacesBatchOrderTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  return (async () => {
    const prevDentalPath = process.env.DENTAL_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    const prevPlacesKey = process.env.GOOGLE_PLACES_API_KEY;
    const prevFetch = (globalThis as any).fetch;
    const testKey = process.env.ADMIN_KEY || "dental-places-order-test-key";
    process.env.DENTAL_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.GOOGLE_PLACES_API_KEY = "test-places-key";
    delete process.env.ANALYTICS_ADMIN_KEY;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const dentalStorePath = require.resolve("../services/dental-store"); // updateDentalAgent writes through its own db-factory copy
    const dentalPath = require.resolve("./dental");
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([dbFactoryPath, dentalStorePath, dentalPath]);

    const pm = require("../services/places-match") as typeof import("../services/places-match");
    const masks: string[] = [];
    try {
      // Blocks a-c assert the pre-A6 behaviour (selection by missing
      // opening_hours, the full masks): run with the A6 switch on. Block d
      // below runs with it off.
      pm.__setDentalPlacesContactFieldsFetchForTesting(true);
      // No network: Google answers "no places" for every query.
      (globalThis as any).fetch = async (url: unknown, init?: any) => {
        if (String(url).includes("places.googleapis.com")) masks.push(String(init?.headers?.["X-Goog-FieldMask"] ?? ""));
        return {
          ok: true,
          status: 200,
          json: async () => ({ places: [] }),
          text: async () => "{}",
        };
      };

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("dental");

      const ins = db.prepare(
        `INSERT INTO dental_agents (id, navn, adresse, telefon, hjemmeside, places_attempted_at)
         VALUES (@id, @navn, 'Storgata 1', '12345678', @hjemmeside, @places_attempted_at)`
      );
      const HP = "https://x.example.no";
      ins.run({ id: "n-aasane", navn: "Åsane Tannklinikk", hjemmeside: HP, places_attempted_at: null });
      ins.run({ id: "n-bergen", navn: "Bergen Tann", hjemmeside: HP, places_attempted_at: null });
      ins.run({ id: "n-zeta-nohp", navn: "Zeta Tann", hjemmeside: "", places_attempted_at: null });
      ins.run({ id: "r-zz-old", navn: "Zz Retry Gammel", hjemmeside: HP, places_attempted_at: daysAgoIso(200) });
      ins.run({ id: "r-aa-new", navn: "Aa Retry Nyere", hjemmeside: HP, places_attempted_at: daysAgoIso(100) });
      ins.run({ id: "r-in-window", navn: "Aaa Innen Vindu", hjemmeside: "", places_attempted_at: daysAgoIso(10) });
      ins.run({ id: "r-nohp-old", navn: "Aaaa Retry Uten Hjemmeside", hjemmeside: "", places_attempted_at: daysAgoIso(150) });

      const router = (require("./dental") as typeof import("./dental")).default as any;
      const headers = { "x-admin-key": testKey };
      const idsOf = (r: { body: any }) => (r.body?.data?.results ?? []).map((x: any) => x.agentId);

      // a) full order: never-attempted first (missing homepage, then navn),
      //    then retries oldest places_attempted_at first; in-window row excluded.
      const all = await callBatch(router, headers, { limit: 10, write: false });
      assertEq(all.status, 200, "a1: auto-select dry-run -> 200");
      assertEq(
        idsOf(all),
        ["n-zeta-nohp", "n-bergen", "n-aasane", "r-nohp-old", "r-zz-old", "r-aa-new"],
        "a2: never-attempted (missing-homepage, then navn) before retries (oldest first); in-window row excluded",
      );

      // b) limit=1 with Å-name never-attempted vs 90+ day-old A-name retry
      db.prepare(`DELETE FROM dental_agents WHERE id IN ('n-zeta-nohp','n-bergen')`).run();
      const one = await callBatch(router, headers, { limit: 1, write: false });
      assertEq(idsOf(one), ["n-aasane"], "b1: limit=1 selects never-attempted 'Åsane' before 90+d-old 'Aa' retry");

      // c) S4-A2: the masks sent above (Enterprise for the rows missing a
      //    homepage, Pro for the rest).
      const PRE_A2_MASKS = [
        "places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.websiteUri,places.regularOpeningHours,places.businessStatus,places.addressComponents",
        "places.displayName,places.formattedAddress,places.regularOpeningHours,places.businessStatus,places.addressComponents",
      ].sort();
      const ratingField = (m: string) => m.split(",").some((f) => pm.PLACES_RATING_FIELDS.includes(f));
      assertEq([...new Set(masks)].sort(), PRE_A2_MASKS, "c1: dental sends its pre-S4-A2 Enterprise and Pro masks, byte for byte");
      assertEq(masks.filter(ratingField), [], "c2: no dental Places call asks for a Google rating field");
      const logged = db.prepare(`SELECT endpoint FROM places_api_call_log`).all() as Array<{ endpoint: string }>;
      assertEq([logged.length, [...new Set(logged.map((r) => r.endpoint))]], [masks.length, ["google-places-batch"]],
        "c3: every dental Places call is logged with its mask, none marked as a rating call (+rating)");

      // d) A6: switch off (the production default). Places answers with phone,
      //    website and opening hours for every query.
      pm.__setDentalPlacesContactFieldsFetchForTesting(null);
      assertEq(pm.dentalPlacesContactFieldsFetchEnabled(), false, "d0: DENTAL_PLACES_CONTACT_FIELDS_FETCH_ENABLED defaults to false");
      const CONTACT = ["places.internationalPhoneNumber", "places.websiteUri", "places.regularOpeningHours"];
      const calls: Array<{ mask: string; query: string }> = [];
      (globalThis as any).fetch = async (url: unknown, init?: any) => {
        // The Brreg-first address lookup also goes through fetch: it is not a Places call.
        if (!String(url).includes("places.googleapis.com")) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
        const query = String(JSON.parse(String(init?.body ?? "{}")).textQuery ?? "");
        calls.push({ mask: String(init?.headers?.["X-Goog-FieldMask"] ?? ""), query });
        const navn = query.replace(/ Norway$/, "");
        return {
          ok: true, status: 200, text: async () => "{}",
          json: async () => ({ places: [{
            displayName: { text: navn },
            addressComponents: [{ longText: "0150", shortText: "0150", types: ["postal_code"] }],
            formattedAddress: "Storgata 9, 0150 Oslo, Norge",
            internationalPhoneNumber: "+47 22 11 00 99",
            websiteUri: "https://a6-klinikk.example.no",
            regularOpeningHours: { periods: [{ open: { day: 1, hour: 8, minute: 0 }, close: { day: 1, hour: 16, minute: 0 } }] },
          }] }),
        };
      };
      db.prepare(`DELETE FROM dental_agents`).run();
      db.prepare(`DELETE FROM places_api_call_log`).run();
      const ins2 = db.prepare(
        `INSERT INTO dental_agents (id, navn, postnummer, poststed, adresse, telefon, hjemmeside, opening_hours)
         VALUES (@id, @navn, '0150', 'Oslo', @adresse, @telefon, @hjemmeside, NULL)`
      );
      // a6-kontakt: only phone/website/hours missing -> not selected any more.
      ins2.run({ id: "a6-kontakt", navn: "Kontakt Mangler Tannklinikk", adresse: "Storgata 1", telefon: "", hjemmeside: "" });
      // a6-adresse: address missing (and the rest) -> selected for the address alone.
      ins2.run({ id: "a6-adresse", navn: "Adresse Mangler Tannklinikk", adresse: "", telefon: "", hjemmeside: "" });
      const off = await callBatch(router, headers, { limit: 10, write: true });
      assertEq(off.status, 200, "d1: auto-select with the switch off -> 200");
      assertEq(idsOf(off), ["a6-adresse"], "d2: a row missing only phone/website/hours is not selected");
      assertEq(calls.length, 1, "d3: only the address row is sent to Google");
      assertEq(CONTACT.filter((f) => calls.some((c) => c.mask.split(",").includes(f))), [], "d4: X-Goog-FieldMask has none of phone, website, opening hours");
      assertEq(calls[0]?.mask, "places.displayName,places.formattedAddress,places.businessStatus,places.addressComponents", "d5: the mask is the Pro mask without the three fields");
      assertEq([off.body.data.enterprise_calls, off.body.data.pro_calls, off.body.data.places_calls], [0, 1, 1], "d6: no Enterprise call");
      assertEq(off.body.data.by_field, { hjemmeside: 0, adresse: 1, telefon: 0, opening_hours: 0 }, "d7: by_field is 0 for hjemmeside, telefon, opening_hours; the address is still filled");
      assertEq(off.body.data.homepages_backfilled, 0, "d8: no homepage backfilled");
      const row = db.prepare(`SELECT adresse, telefon, hjemmeside, opening_hours, field_provenance FROM dental_agents WHERE id = 'a6-adresse'`).get() as any;
      assertEq([row.adresse, row.telefon, row.hjemmeside, row.opening_hours], ["Storgata 9, 0150 Oslo, Norge", "", "", null], "d9: none of phone, website, hours is written");
      const prov = JSON.parse(row.field_provenance ?? "{}");
      assertEq(Object.keys(prov).sort(), ["address"], "d10: no provenance row for phone, website or opening hours");
      const kontakt = db.prepare(`SELECT places_attempted_at FROM dental_agents WHERE id = 'a6-kontakt'`).get() as any;
      assertEq(kontakt.places_attempted_at ?? null, null, "d11: the unselected row is untouched");

      // e) explicit agentIds: a row with nothing left to fetch is skipped, no fetch, no log, no marker.
      calls.length = 0;
      db.prepare(`DELETE FROM places_api_call_log`).run();
      const skip = await callBatch(router, headers, { agentIds: ["a6-kontakt"], write: true });
      assertEq((skip.body?.data?.results ?? []).map((x: any) => x.status), ["skipped_places_fields_disabled"], "e1: no field left to fetch -> skipped_places_fields_disabled");
      assertEq(calls.length, 0, "e2: no fetch");
      assertEq((db.prepare(`SELECT COUNT(*) AS n FROM places_api_call_log`).get() as any).n, 0, "e3: no logPlacesCall");
      assertEq([skip.body.data.matched, skip.body.data.places_calls, skip.body.data.by_field], [0, 0, { hjemmeside: 0, adresse: 0, telefon: 0, opening_hours: 0 }], "e4: nothing matched, nothing counted");
      assertEq((db.prepare(`SELECT places_attempted_at FROM dental_agents WHERE id = 'a6-kontakt'`).get() as any).places_attempted_at ?? null, null, "e5: no no-retry marker is set");

      // f) switch on: the same data as main (fields written, Enterprise mask, provenance).
      pm.__setDentalPlacesContactFieldsFetchForTesting(true);
      calls.length = 0;
      const on = await callBatch(router, headers, { limit: 10, write: true });
      assertEq(idsOf(on), ["a6-kontakt"], "f1: switch on selects the row missing only contact fields (a6-adresse is in its no-retry window)");
      assertEq(calls[0]?.mask, PRE_A2_MASKS.find((m) => m.includes("websiteUri")), "f2: switch on sends the Enterprise mask byte for byte");
      assertEq(on.body.data.by_field, { hjemmeside: 1, adresse: 0, telefon: 1, opening_hours: 1 }, "f3: switch on writes hjemmeside, telefon, opening_hours");
      const provOn = JSON.parse((db.prepare(`SELECT field_provenance FROM dental_agents WHERE id = 'a6-kontakt'`).get() as any).field_provenance ?? "{}");
      assertEq(Object.keys(provOn).sort(), ["address", "opening_hours", "phone", "website"], "f4: switch on writes the google_places provenance for the three fields");
      pm.__setDentalPlacesContactFieldsFetchForTesting(null);
    } catch (err: any) {
      failed++;
      failures.push("dental-places-batch-order: unexpected error: " + String(err?.stack || err));
    } finally {
      (globalThis as any).fetch = prevFetch;
      pm.__setDentalPlacesContactFieldsFetchForTesting(null);
      try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch {}
      restoreModuleCache();
      const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
      restore("DENTAL_DB_PATH", prevDentalPath);
      restore("ADMIN_KEY", prevAdminKey);
      restore("ANALYTICS_ADMIN_KEY", prevAnalyticsAdminKey);
      restore("GOOGLE_PLACES_API_KEY", prevPlacesKey);
    }
    return { passed, failed, failures };
  })();
}
