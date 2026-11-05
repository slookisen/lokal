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
 *
 * d-f) A6 (phone, website, opening hours off). Blocks a-f run with the A5
 * switch (PLACES_ADDRESS_FETCH_ENABLED) on, the pre-A5 behaviour.
 *
 * g-h) A5, same dev-request: with the address switch off (the production
 * default) Phase 2G no longer selects a clinic because its address is empty,
 * sends no places.formattedAddress, looks up and writes no address (Brreg's
 * included: by_field.adresse 0) and writes no address provenance, also when
 * Places answers with one. g: with A6 off too, nothing is left to fetch. h:
 * with A6 set back on, the homepage is still filled, without the address.
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
      // Blocks a-f assert the pre-A5 address behaviour: A5 switch on. Blocks
      // g-h below run with it off.
      pm.__setPlacesAddressFetchForTesting(true);
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
      assertEq([logged.length, [...new Set(logged.map((r) => r.endpoint))]], [masks.length, ["google-places-batch+address"]],
        "c3: every dental Places call is logged with its mask, none marked as a rating call (+rating); the address mark (A5) as the masks ask for it");

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

      // g) A5: address switch off (the production default), A6 off too.
      //    Places answers with an address for every query, and Brreg would too.
      pm.__setPlacesAddressFetchForTesting(null);
      assertEq(pm.placesAddressFetchEnabled(), false, "g0: PLACES_ADDRESS_FETCH_ENABLED defaults to false");
      const tracker = require("../services/places-usage-tracker") as typeof import("../services/places-usage-tracker");
      const a5Calls: Array<{ mask: string; query: string }> = [];
      let a5Brreg = 0;
      (globalThis as any).fetch = async (url: unknown, init?: any) => {
        const u = String(url);
        if (u.includes("brreg.no")) {
          a5Brreg++;
          return { ok: true, status: 200, text: async () => "{}", json: async () => ({ _embedded: { enheter: [{
            organisasjonsnummer: "999888777", navn: "A5 HJEMMESIDE TANNKLINIKK AS",
            forretningsadresse: { adresse: ["Brreggata 3"], postnummer: "0150", poststed: "OSLO" },
          }] } }) };
        }
        if (!u.includes("places.googleapis.com")) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
        const query = String(JSON.parse(String(init?.body ?? "{}")).textQuery ?? "");
        a5Calls.push({ mask: String(init?.headers?.["X-Goog-FieldMask"] ?? ""), query });
        return {
          ok: true, status: 200, text: async () => "{}",
          json: async () => ({ places: [{
            displayName: { text: query.replace(/ Norway$/, "").replace(/ Oslo$/, "") },
            addressComponents: [{ longText: "0150", shortText: "0150", types: ["postal_code"] }, { longText: "Oslo", shortText: "Oslo", types: ["postal_town"] }],
            formattedAddress: "Placesveien 7, 0150 Oslo, Norge",
            websiteUri: "https://a5-klinikk.example.no",
          }] }),
        };
      };
      db.prepare(`DELETE FROM dental_agents`).run();
      db.prepare(`DELETE FROM places_api_call_log`).run();
      const ins3 = db.prepare(
        `INSERT INTO dental_agents (id, navn, postnummer, poststed, adresse, telefon, hjemmeside, opening_hours)
         VALUES (@id, @navn, '0150', 'Oslo', @adresse, @telefon, @hjemmeside, @oh)`
      );
      // a5-adresse: only the address is missing. a5-hjemmeside: the homepage and the address are missing.
      ins3.run({ id: "a5-adresse", navn: "A5 Adresse Tannklinikk", adresse: "", telefon: "22110000", hjemmeside: "https://a5-adresse.example.no", oh: "[]" });
      ins3.run({ id: "a5-hjemmeside", navn: "A5 Hjemmeside Tannklinikk", adresse: "", telefon: "22110001", hjemmeside: "", oh: "[]" });
      const a5Row = (id: string) => db.prepare(`SELECT adresse, hjemmeside, field_provenance, places_attempted_at FROM dental_agents WHERE id = ?`).get(id) as any;
      const g = await callBatch(router, headers, { limit: 10, write: true });
      assertEq([g.status, idsOf(g), g.body?.data?.pool_empty], [200, [], true], "g1: A5+A6 off -> no row is selected because its address is empty (pool_empty)");
      assertEq([a5Calls.length, a5Brreg], [0, 0], "g2: no Places call and no Brreg address lookup");
      assertEq(g.body?.data?.by_field, { hjemmeside: 0, adresse: 0, telefon: 0, opening_hours: 0 }, "g3: by_field.adresse is 0");
      const gIds = await callBatch(router, headers, { agentIds: ["a5-adresse"], write: true });
      assertEq((gIds.body?.data?.results ?? []).map((x: any) => x.status), ["skipped_places_fields_disabled"], "g4: agentIds with only the address missing -> nothing left to fetch, skipped");
      assertEq([a5Calls.length, (db.prepare(`SELECT COUNT(*) AS n FROM places_api_call_log`).get() as any).n, a5Row("a5-adresse").places_attempted_at ?? null], [0, 0, null],
        "g5: no fetch, no logPlacesCall, no no-retry marker");
      assertEq([a5Row("a5-adresse").adresse, a5Row("a5-adresse").field_provenance ?? null], ["", null], "g6: the address stays empty, no provenance written");

      // h) A6 set back on, address still off: the homepage is filled as before,
      //    without the address (the acceptance for Phase 2G before A6).
      pm.__setDentalPlacesContactFieldsFetchForTesting(true);
      const h = await callBatch(router, headers, { limit: 10, write: true });
      assertEq(idsOf(h), ["a5-hjemmeside"], "h1: only the row missing a contact field is selected, not the one missing only its address");
      assertEq(a5Calls.length, 1, "h2: one Places call");
      assertEq(a5Calls.filter((c) => c.mask.split(",").includes("places.formattedAddress")).length, 0, "h3: X-Goog-FieldMask has no places.formattedAddress");
      assertEq(a5Calls[0]?.mask.split(",").includes("places.addressComponents"), true, "h4: …but still places.addressComponents for the match guard");
      assertEq(a5Brreg, 0, "h5: no Brreg address lookup");
      assertEq(h.body?.data?.by_field, { hjemmeside: 1, adresse: 0, telefon: 0, opening_hours: 0 }, "h6: the homepage is written, by_field.adresse is 0");
      const hRow = a5Row("a5-hjemmeside");
      assertEq([hRow.adresse, hRow.hjemmeside], ["", "https://a5-klinikk.example.no"], "h7: the address stays empty although Places answered with one");
      const hProv = JSON.parse(hRow.field_provenance ?? "{}");
      assertEq(Object.keys(hProv).sort(), ["website"], "h8: no address provenance (no google_places record, no brreg record)");
      assertEq(JSON.stringify(hProv).includes("0150") || JSON.stringify(hProv).includes("Placesveien"), false, "h9: no street, postal code or town from Places in the provenance");
      const hLog = db.prepare(`SELECT endpoint FROM places_api_call_log`).all() as Array<{ endpoint: string }>;
      assertEq([hLog.map((r) => r.endpoint), tracker.getPlacesAddressFieldCallsThisMonth(db as any)], [["google-places-batch"], 0],
        "h10: the logged call carries no +address mark; address-field calls this month = 0");
      pm.__setDentalPlacesContactFieldsFetchForTesting(null);
    } catch (err: any) {
      failed++;
      failures.push("dental-places-batch-order: unexpected error: " + String(err?.stack || err));
    } finally {
      (globalThis as any).fetch = prevFetch;
      pm.__setDentalPlacesContactFieldsFetchForTesting(null);
      pm.__setPlacesAddressFetchForTesting(null);
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
