/**
 * w40-write-guards.test.ts — W40 RFB spot-check follow-up: enrichment write
 * guards for two verified classes of wrong producer data.
 *
 *   A. ADDRESS (Kvestad Sideri): Google Places wrote `Fv109, 5776 Nå` (a road
 *      designation, no house number) via POST /admin/google-rating-batch
 *      ?include_address_phone; the homepage/Brreg street address
 *      `Reisetevegen 83, 5776 Nå` never replaced it (fill-only).
 *        - services/street-address-parse.ts: isRoadDesignationOnlyAddress /
 *          hasStreetAndHouseNumber / streetAddressBeatsRoadDesignation /
 *          canCorrectRoadOnlyAddress
 *        - admin-knowledge.ts canCorrectFactualField: new
 *          ok_street_address_over_road_designation rule (+ PUT allow_correct)
 *        - marketplace.ts google-rating-batch: road-only Google address not
 *          written when a homepage/Brreg street address is on record; a Brreg
 *          street address corrects a stored road-only value
 *        - admin-agents.ts applyAgentBrregContact: same correction
 *   B. PHONE (Aalan Gård): an LLM-invented number written on the admin/auto
 *      lane with no source_url.
 *        - services/phone-source-write-guard.ts (fetch stubbed via
 *          __setPhoneGuardFetchImplForTesting — no network)
 *        - PUT /admin/knowledge, PUT /agents/:id/knowledge (admin lane; owner
 *          lane untouched), POST /admin/bulk-enrich
 *
 * Harness: better-sqlite3 ":memory:" + __setDbForTesting/__initSchemaForTesting,
 * routers driven through router.handle() with a fake req/res.
 *
 * Exported runW40WriteGuardsTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/w40-write-guards.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: { method?: string; url: string; headers?: Record<string, string>; body?: any; query?: Record<string, string> },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "PUT",
      url: opts.url,
      originalUrl: opts.url,
      query: opts.query || {},
      headers,
      body: opts.body,
      ip: "127.0.0.1",
      get(name: string) {
        return headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
      else resolve({ status: 0, body: undefined });
    });
  });
}

/** A minimal fetch Response stand-in for fetchPage (arrayBuffer + headers). */
function htmlResponse(html: string, status = 200, url = ""): any {
  const bytes = new TextEncoder().encode(html);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "ERR",
    url,
    redirected: false,
    headers: {
      get(name: string) {
        return name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null;
      },
    },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

// Kvestad-like and Aalan-like fixtures (shapes from the W40 spot-check).
const KVESTAD_ROAD = "Fv109, 5776 Nå";
const KVESTAD_STREET = "Reisetevegen 83, 5776 Nå";
const AALAN_SITE = "https://aalan.example.no/kontakt";
const AALAN_PAGE =
  "<html><body><h1>Aalan Gård</h1><p>Gardsbutikk på Aalan. Ring oss på " +
  '<a href="tel:+4791234567">912 34 567</a> eller send e-post.</p></body></html>';
const AALAN_REAL_PHONE = "+47 912 34 567";
const AALAN_INVENTED_PHONE = "+47 48 22 19 03"; // appears nowhere on the page
const PAGE_WITHOUT_PHONE = "<html><body><h1>Aalan Gård</h1><p>Velkommen til gården vår.</p></body></html>";

export async function runW40WriteGuardsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const addr = require("../services/street-address-parse") as typeof import("../services/street-address-parse");
  const guard = require("../services/phone-source-write-guard") as typeof import("../services/phone-source-write-guard");

  // ═══════════════════════════════════════════════════════════════════════
  // A-pure. Road-designation detection + precedence rule
  // ═══════════════════════════════════════════════════════════════════════
  assertEq(addr.isRoadDesignationOnlyAddress(KVESTAD_ROAD), true, "A01: 'Fv109, 5776 Nå' is road-designation-only (Kvestad)");
  assertEq(addr.isRoadDesignationOnlyAddress("Fv 109, 5776 Nå"), true, "A02: spaced 'Fv 109' is road-only");
  assertEq(addr.isRoadDesignationOnlyAddress("Rv. 7, 3570 Ål"), true, "A03: 'Rv. 7' is road-only");
  assertEq(addr.isRoadDesignationOnlyAddress("E6, 7500 Stjørdal"), true, "A04: 'E6' is road-only");
  assertEq(addr.isRoadDesignationOnlyAddress("Kv 12, 1234 Bygd"), true, "A05: 'Kv 12' is road-only");
  assertEq(addr.isRoadDesignationOnlyAddress("Fylkesvegen 109, 5776 Nå"), true, "A06: 'Fylkesvegen 109' is road-only");
  assertEq(addr.isRoadDesignationOnlyAddress("Kvestad Sideri, Fv109, 5776 Nå, Norway"), true, "A07: name-prefixed Google form is road-only");
  assertEq(addr.isRoadDesignationOnlyAddress("Fv109 5776 Nå"), true, "A08: comma-less 'Fv109 5776 Nå' is road-only");
  assertEq(addr.isRoadDesignationOnlyAddress(KVESTAD_STREET), false, "A09: real street + number is NOT road-only");
  assertEq(addr.isRoadDesignationOnlyAddress("Lønsdal, 8255 Røkland"), false, "A10: farm-name-only address is NOT road-only (never auto-corrected)");
  assertEq(addr.isRoadDesignationOnlyAddress(""), false, "A11: empty is not road-only");
  assertEq(addr.isRoadDesignationOnlyAddress(null), false, "A12: null is not road-only");
  assertEq(addr.hasStreetAndHouseNumber(KVESTAD_STREET), true, "A13: Reisetevegen 83 has street + number");
  assertEq(addr.hasStreetAndHouseNumber(KVESTAD_ROAD), false, "A14: Fv109 has no street + number");
  assertEq(
    addr.streetAddressBeatsRoadDesignation({ existing: KVESTAD_ROAD, incoming: KVESTAD_STREET, incomingSourceType: "homepage" }),
    true,
    "A15: homepage street address beats road designation",
  );
  assertEq(
    addr.streetAddressBeatsRoadDesignation({ existing: KVESTAD_ROAD, incoming: KVESTAD_STREET, incomingSourceType: "brreg" }),
    true,
    "A16: Brreg street address beats road designation",
  );
  assertEq(
    addr.streetAddressBeatsRoadDesignation({ existing: KVESTAD_ROAD, incoming: KVESTAD_STREET, incomingSourceType: "google_places" }),
    false,
    "A17: a google_places street address does NOT get the precedence",
  );
  assertEq(
    addr.streetAddressBeatsRoadDesignation({ existing: "Storgata 1, 1400 Ski", incoming: KVESTAD_STREET, incomingSourceType: "homepage" }),
    false,
    "A18: a real stored street address is never replaced by this rule",
  );
  assertEq(
    addr.streetAddressBeatsRoadDesignation({ existing: KVESTAD_ROAD, incoming: "Fv109, 5776 Nå", incomingSourceType: "homepage" }),
    false,
    "A19: incoming without house number never qualifies",
  );
  assertEq(
    addr.canCorrectRoadOnlyAddress({
      currAddr: KVESTAD_ROAD, incoming: KVESTAD_STREET, incomingSourceType: "homepage",
      existingAddressProvenance: [{ source_type: "google_places", value: KVESTAD_ROAD }], isCurated: false,
    }),
    true,
    "A20: canCorrectRoadOnlyAddress allows the Kvestad correction",
  );
  assertEq(
    addr.canCorrectRoadOnlyAddress({
      currAddr: KVESTAD_ROAD, incoming: KVESTAD_STREET, incomingSourceType: "homepage",
      existingAddressProvenance: [], isCurated: true,
    }),
    false,
    "A21: curated lock refuses the correction",
  );
  assertEq(
    addr.canCorrectRoadOnlyAddress({
      currAddr: KVESTAD_ROAD, incoming: KVESTAD_STREET, incomingSourceType: "brreg",
      existingAddressProvenance: [{ source_type: "owner", value: KVESTAD_ROAD }], isCurated: false,
    }),
    false,
    "A22: owner-attested road value is never corrected",
  );

  // canCorrectFactualField — new rule, and unchanged behaviour without values.
  {
    const ak = require("./admin-knowledge") as typeof import("./admin-knowledge");
    const base = {
      field: "address",
      existingFieldProvenance: [
        { source_type: "google_places", value: KVESTAD_ROAD, fetched_at: "2026-09-01T00:00:00Z" },
        { source_type: "homepage", value: KVESTAD_ROAD, fetched_at: "2026-09-01T00:00:00Z" },
      ],
      websiteOwnershipUnverified: false,
      incomingFieldProvenance: [{ source_type: "homepage", value: KVESTAD_STREET, fetched_at: "2026-09-30T00:00:00Z" }],
      isCurated: false,
    };
    assertEq(
      ak.canCorrectFactualField({ ...base, existingValue: KVESTAD_ROAD, incomingValue: KVESTAD_STREET }),
      { allowed: true, reason: "ok_street_address_over_road_designation" },
      "A23: canCorrectFactualField — homepage street address corrects a road-only address even over 2 Tier-A",
    );
    assertEq(
      ak.canCorrectFactualField(base),
      { allowed: false, reason: "existing_already_two_tierA" },
      "A24: without values passed, canCorrectFactualField behaves exactly as before",
    );
    assertEq(
      ak.canCorrectFactualField({
        ...base,
        incomingFieldProvenance: [{ source_type: "google_places", value: KVESTAD_STREET, fetched_at: "2026-09-30T00:00:00Z" }],
        existingValue: KVESTAD_ROAD,
        incomingValue: KVESTAD_STREET,
      }).reason,
      "existing_already_two_tierA",
      "A25: google_places-only incoming does not get the road-designation precedence",
    );
    assertEq(
      ak.canCorrectFactualField({
        ...base,
        incomingFieldProvenance: [{ source_type: "homepage", value: "Annen vei 2, 5776 Nå", fetched_at: "2026-09-30T00:00:00Z" }],
        existingValue: KVESTAD_ROAD,
        incomingValue: KVESTAD_STREET,
      }).reason,
      "existing_already_two_tierA",
      "A26: the provenance record must be for the SAME street + number as the incoming value",
    );
    assertEq(
      ak.canCorrectFactualField({ ...base, isCurated: true, existingValue: KVESTAD_ROAD, incomingValue: KVESTAD_STREET }),
      { allowed: false, reason: "curated_locked" },
      "A27: curated lock still absolute",
    );
    assertEq(
      ak.canCorrectFactualField({
        ...base,
        existingFieldProvenance: [{ source_type: "owner", value: KVESTAD_ROAD, fetched_at: "2026-09-01T00:00:00Z" }],
        existingValue: KVESTAD_ROAD,
        incomingValue: KVESTAD_STREET,
      }).allowed,
      false,
      "A28: owner-attested road value is not corrected by canCorrectFactualField",
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // B-pure. Phone guard helpers + page verification (stubbed fetch)
  // ═══════════════════════════════════════════════════════════════════════
  assertEq(
    guard.findPhoneSourceUrl(AALAN_REAL_PHONE, { explicitSourceUrl: AALAN_SITE }),
    AALAN_SITE,
    "B01: explicit phone_source_url wins",
  );
  assertEq(
    guard.findPhoneSourceUrl(AALAN_REAL_PHONE, {
      fieldProvenancePhone: { sources: [{ source_type: "homepage", raw_value: "91234567", source_url: AALAN_SITE }] },
    }),
    AALAN_SITE,
    "B02: source_url taken from a provenance record for the same number (wrapped shape, digits-normalized)",
  );
  assertEq(
    guard.findPhoneSourceUrl(AALAN_REAL_PHONE, {
      fieldProvenancePhone: [{ source_type: "homepage", value: "+47 22 22 22 22", source_url: AALAN_SITE }],
    }),
    null,
    "B03: a provenance record for a DIFFERENT number does not lend its source_url",
  );
  assertEq(
    guard.findPhoneSourceUrl(AALAN_INVENTED_PHONE, {
      fieldProvenancePhone: [{ source_type: "homepage", value: AALAN_INVENTED_PHONE }],
    }),
    null,
    "B04: Aalan-like — homepage provenance with no source_url gives no source page",
  );
  assertEq(
    guard.hasOwnerPhoneProvenance(AALAN_REAL_PHONE, [{ source_type: "owner", value: "91234567" }]),
    true,
    "B05: owner provenance for the same number is an owner relay",
  );
  assertEq(
    guard.withoutPhoneProvenanceFor(
      { sources: [{ source_type: "homepage", value: AALAN_INVENTED_PHONE }, { source_type: "google_places", value: "+4722222222" }] },
      AALAN_INVENTED_PHONE,
    ),
    { sources: [{ source_type: "google_places", value: "+4722222222" }] },
    "B06: refused number's provenance records are stripped, others kept, shape kept",
  );

  let fetchCalls: string[] = [];
  let pages: Record<string, { html: string; status?: number }> = {};
  const stubFetch = (async (url: string) => {
    fetchCalls.push(String(url));
    const p = pages[String(url)];
    if (!p) return htmlResponse("<html><body>not found page body with enough text to be usable</body></html>", 404, String(url));
    return htmlResponse(p.html, p.status ?? 200, String(url));
  }) as any;
  guard.__setPhoneGuardFetchImplForTesting(stubFetch);
  guard.__resetPhoneGuardCooldownForTesting();

  try {
    pages = { [AALAN_SITE]: { html: AALAN_PAGE } };
    let v = await guard.verifyPhoneOnSourcePage(AALAN_REAL_PHONE, AALAN_SITE);
    assertEq([v.allowed, v.outcome], [true, "verified"], "B07: real number on the source page -> verified");
    v = await guard.verifyPhoneOnSourcePage("91234567", AALAN_SITE);
    assertEq(v.outcome, "verified", "B08: bare 8 digits match the formatted page number");
    v = await guard.verifyPhoneOnSourcePage(AALAN_INVENTED_PHONE, AALAN_SITE);
    assertEq([v.allowed, v.outcome], [false, "rejected_not_on_source_page"], "B09: Aalan-like invented number -> rejected_not_on_source_page");
    v = await guard.verifyPhoneOnSourcePage(AALAN_REAL_PHONE, null);
    assertEq([v.allowed, v.outcome], [false, "rejected_no_source_url"], "B10: no source_url -> rejected_no_source_url");
    fetchCalls = [];
    v = await guard.verifyPhoneOnSourcePage(AALAN_REAL_PHONE, "http://127.0.0.1/kontakt");
    assertEq([v.allowed, v.outcome], [false, "rejected_source_url_invalid"], "B11: SSRF-blocked url -> rejected_source_url_invalid");
    v = await guard.verifyPhoneOnSourcePage(AALAN_REAL_PHONE, "aalan.example.no/kontakt");
    assertEq(v.outcome, "rejected_source_url_invalid", "B12: scheme-less url -> rejected_source_url_invalid");
    assertEq(fetchCalls.length, 0, "B13: invalid urls are never fetched");
    pages = { "https://down.example.no/": { html: "<html>err</html>", status: 503 } };
    v = await guard.verifyPhoneOnSourcePage(AALAN_REAL_PHONE, "https://down.example.no/");
    assertEq([v.allowed, v.outcome], [false, "fetch_failed"], "B14: unreadable page (5xx) -> fetch_failed, not written");
    pages = { "https://busy.example.no/": { html: "<html>slow down</html>", status: 429 } };
    v = await guard.verifyPhoneOnSourcePage(AALAN_REAL_PHONE, "https://busy.example.no/");
    assertEq(v.outcome, "fetch_failed", "B15: 429 -> fetch_failed");
    fetchCalls = [];
    v = await guard.verifyPhoneOnSourcePage(AALAN_REAL_PHONE, "https://busy.example.no/kontakt");
    assertEq([v.outcome, fetchCalls.length], ["cooldown_skipped", 0], "B16: host parked after 429 -> cooldown_skipped, no fetch");
    guard.__resetPhoneGuardCooldownForTesting();

    fetchCalls = [];
    let g = await guard.guardAutoPhoneWrite({ phone: "912 34 567", existingPhone: "+4791234567" });
    assertEq([g.allowed, g.outcome, fetchCalls.length], [true, "unchanged", 0], "B17: re-sending the stored number -> unchanged, no fetch");
    g = await guard.guardAutoPhoneWrite({ phone: "", existingPhone: "+4791234567" });
    assertEq([g.allowed, g.outcome], [true, "cleared"], "B18: clearing the phone is not gated");
    g = await guard.guardAutoPhoneWrite({ phone: AALAN_REAL_PHONE, existingPhone: null, ownerRelay: true });
    assertEq([g.allowed, g.outcome, fetchCalls.length], [true, "owner_relay", 0], "B19: owner relay is not gated");

    // ═════════════════════════════════════════════════════════════════════
    // Route-level tests (in-memory DB)
    // ═════════════════════════════════════════════════════════════════════
    const prevDb = initMod.__peekDbForTesting();
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    const prevPlacesKey = process.env.GOOGLE_PLACES_API_KEY;
    const prevFetch = (globalThis as any).fetch;
    const ADMIN_KEY = process.env.ADMIN_KEY || "w40-write-guards-test-key";
    const db = new Database(":memory:");
    db.pragma("foreign_keys = OFF");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);
      process.env.ADMIN_KEY = ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;
      process.env.GOOGLE_PLACES_API_KEY = "test-places-key";

      const insertAgent = (id: string, name: string) =>
        db.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, created_at)
           VALUES (?, ?, 't', 't', '', '', 'producer', ?, 'rfb', '2026-01-01 00:00:00')`,
        ).run(id, name, `key-${id}`);
      const knowledge = (id: string) =>
        db.prepare(`SELECT address, phone, about, field_provenance FROM agent_knowledge WHERE agent_id = ?`).get(id) as any;

      delete require.cache[require.resolve("./admin-knowledge")];
      const akRouter = require("./admin-knowledge").default as any;
      delete require.cache[require.resolve("./marketplace")];
      const mpRouter = require("./marketplace").default as any;
      const adminHeaders = { "x-admin-key": ADMIN_KEY, "content-type": "application/json" };
      const putAdminKnowledge = (body: any, query?: Record<string, string>) =>
        callRoute(akRouter, { method: "PUT", url: "/", headers: adminHeaders, body, query });
      const putMarketplaceKnowledge = (id: string, body: any, headers: Record<string, string> = adminHeaders) =>
        callRoute(mpRouter, { method: "PUT", url: `/agents/${id}/knowledge`, headers, body });

      pages = { [AALAN_SITE]: { html: AALAN_PAGE }, "https://aalan.example.no/": { html: PAGE_WITHOUT_PHONE } };

      // ── PUT /admin/knowledge ────────────────────────────────────────────
      insertAgent("aalan-1", "Aalan Gård");
      let r = await putAdminKnowledge({
        agent_id: "aalan-1",
        phone: AALAN_INVENTED_PHONE,
        field_provenance: { phone: { sources: [{ source_type: "homepage", captured_at: "2026-09-30T00:00:00Z", raw_value: AALAN_INVENTED_PHONE }] } },
      });
      assertEq(r.status, 422, "C01: Aalan-like phone-only write without source_url -> 422");
      assertEq(r.body?.phone_rejected_reason, "rejected_no_source_url", "C02: phone_rejected_reason names the cause");
      assertEq(knowledge("aalan-1")?.phone ?? null, null, "C03: phone column NOT written");

      r = await putAdminKnowledge({
        agent_id: "aalan-1",
        about: "Aalan Gård driv med gardsbutikk og sauehald i Lofoten.",
        phone: AALAN_INVENTED_PHONE,
        field_provenance: {
          phone: { sources: [{ source_type: "homepage", captured_at: "2026-09-30T00:00:00Z", raw_value: AALAN_INVENTED_PHONE, source_url: "https://aalan.example.no/" }] },
        },
      });
      assertEq(r.status, 200, "C04: mixed write with an unsubstantiated phone -> 200 (siblings still written)");
      assertEq(r.body?.phone_rejected_reason, "rejected_not_on_source_page", "C05: number not on its named source page -> rejected_not_on_source_page");
      assertEq(knowledge("aalan-1")?.phone ?? null, null, "C06: phone column still NOT written");
      assertTrue((knowledge("aalan-1")?.about ?? "").startsWith("Aalan Gård driv"), "C07: about written in the same call");
      assertTrue(!(r.body?.columns_updated ?? []).includes("phone"), "C08: 'phone' absent from columns_updated");
      assertTrue(
        !JSON.stringify(JSON.parse(knowledge("aalan-1")?.field_provenance || "{}").phone ?? []).includes("48221903"),
        "C09: the refused number's provenance record was not merged",
      );

      r = await putAdminKnowledge({
        agent_id: "aalan-1",
        phone: AALAN_REAL_PHONE,
        phone_source_url: AALAN_SITE,
        field_provenance: { phone: [{ source_type: "homepage", value: AALAN_REAL_PHONE, fetched_at: "2026-09-30T00:00:00Z", source_url: AALAN_SITE }] },
      });
      assertEq(r.status, 200, "C10: substantiated phone -> 200");
      assertEq(r.body?.phone_write?.outcome, "verified", "C11: phone_write.outcome = verified");
      assertEq(knowledge("aalan-1")?.phone, AALAN_REAL_PHONE, "C12: phone column written");
      assertEq(r.body?.phone_rejected_reason, undefined, "C13: no rejection reason on a verified write");

      fetchCalls = [];
      r = await putAdminKnowledge({ agent_id: "aalan-1", phone: "91234567" });
      assertEq([r.status, r.body?.phone_write?.outcome, fetchCalls.length], [200, "unchanged", 0], "C14: same number re-sent -> unchanged, no fetch");

      insertAgent("aalan-2", "Aalan Gård To");
      r = await putAdminKnowledge({
        agent_id: "aalan-2",
        phone: AALAN_REAL_PHONE,
        field_provenance: { phone: [{ source_type: "owner", value: AALAN_REAL_PHONE, fetched_at: "2026-09-30T00:00:00Z" }] },
      });
      assertEq([r.status, r.body?.phone_write?.outcome], [200, "owner_relay"], "C15: owner-sourced provenance relay is not gated");
      assertEq(knowledge("aalan-2")?.phone, AALAN_REAL_PHONE, "C16: owner relay phone written");

      r = await putAdminKnowledge({ agent_id: "aalan-2", about: "Ingen telefon her, bare tekst om garden." });
      assertTrue(!Object.prototype.hasOwnProperty.call(r.body ?? {}, "phone_write"), "C17: phone_write absent when no phone in the call");

      // Kvestad via PUT /admin/knowledge allow_correct
      insertAgent("kvestad-1", "Kvestad Sideri");
      db.prepare(`INSERT INTO agent_knowledge (agent_id, address, field_provenance) VALUES (?, ?, ?)`).run(
        "kvestad-1",
        KVESTAD_ROAD,
        JSON.stringify({ address: [{ source_type: "google_places", value: KVESTAD_ROAD, fetched_at: "2026-09-01T00:00:00Z" }] }),
      );
      r = await putAdminKnowledge(
        {
          agent_id: "kvestad-1",
          address: KVESTAD_STREET,
          field_provenance: {
            address: [{ source_type: "homepage", value: KVESTAD_STREET, fetched_at: "2026-09-30T00:00:00Z", source_url: "https://kvestad.example.no/" }],
          },
        },
        { allow_correct: "1" },
      );
      assertEq(knowledge("kvestad-1")?.address, KVESTAD_STREET, "C18: Kvestad — homepage street address corrects Fv109 via allow_correct");
      const kc = (r.body?.corrections ?? []).find((c: any) => c.field === "address");
      assertEq(kc?.reason, "ok_street_address_over_road_designation", "C19: corrections[] names the new rule");

      insertAgent("street-1", "Gate Gård");
      db.prepare(`INSERT INTO agent_knowledge (agent_id, address, field_provenance) VALUES (?, ?, ?)`).run(
        "street-1",
        "Storgata 1, 1400 Ski",
        JSON.stringify({ address: [{ source_type: "homepage", value: "Storgata 1, 1400 Ski", fetched_at: "2026-09-01T00:00:00Z" }] }),
      );
      await putAdminKnowledge(
        {
          agent_id: "street-1",
          address: "Annen gate 2, 1400 Ski",
          field_provenance: { address: [{ source_type: "homepage", value: "Annen gate 2, 1400 Ski", fetched_at: "2026-09-30T00:00:00Z" }] },
        },
        { allow_correct: "1" },
      );
      assertEq(knowledge("street-1")?.address, "Storgata 1, 1400 Ski", "C20: a real street address is NOT overwritten by the new rule");

      // ── PUT /agents/:id/knowledge (admin lane + owner lane) ─────────────
      insertAgent("aalan-3", "Aalan Gård Tre");
      r = await putMarketplaceKnowledge("aalan-3", { phone: AALAN_INVENTED_PHONE });
      assertEq(r.status, 422, "D01: admin lane, Aalan-like phone-only with no source -> 422");
      assertEq(r.body?.phone_rejected_reason, "rejected_no_source_url", "D02: reason rejected_no_source_url");
      assertEq(knowledge("aalan-3")?.phone ?? null, null, "D03: phone NOT written");

      r = await putMarketplaceKnowledge("aalan-3", {
        about: "Aalan Gård Tre selger lam og ull fra egen gard.",
        phone: AALAN_INVENTED_PHONE,
        phone_source_url: AALAN_SITE,
      });
      assertEq(r.status, 200, "D04: admin lane mixed write -> 200");
      assertEq(r.body?.phone_rejected_reason, "rejected_not_on_source_page", "D05: invented number not on the named page -> rejected");
      assertEq(knowledge("aalan-3")?.phone ?? null, null, "D06: phone NOT written");
      assertTrue((knowledge("aalan-3")?.about ?? "").startsWith("Aalan Gård Tre"), "D07: about still written");

      r = await putMarketplaceKnowledge("aalan-3", { phone: AALAN_REAL_PHONE, phone_source_url: AALAN_SITE });
      assertEq([r.status, r.body?.phone_write?.outcome], [200, "verified"], "D08: substantiated phone -> verified");
      assertEq(knowledge("aalan-3")?.phone, AALAN_REAL_PHONE, "D09: phone written");

      pages = { [AALAN_SITE]: { html: "<html>down</html>", status: 500 } };
      insertAgent("aalan-4", "Aalan Gård Fire");
      r = await putMarketplaceKnowledge("aalan-4", { phone: AALAN_REAL_PHONE, phone_source_url: AALAN_SITE });
      assertEq([r.status, r.body?.phone_rejected_reason], [422, "fetch_failed"], "D10: unreadable source page -> not written (fetch_failed)");
      assertEq(knowledge("aalan-4")?.phone ?? null, null, "D11: phone NOT written on fetch failure");
      pages = { [AALAN_SITE]: { html: AALAN_PAGE } };

      fetchCalls = [];
      r = await putMarketplaceKnowledge("aalan-4", { phone: AALAN_INVENTED_PHONE }, { "x-api-key": "key-aalan-4" });
      assertEq(r.status, 200, "D12: owner lane (API key) phone edit -> 200");
      assertEq(knowledge("aalan-4")?.phone, AALAN_INVENTED_PHONE, "D13: owner lane is NOT gated (written as given)");
      assertEq([r.body?.phone_write, fetchCalls.length], [undefined, 0], "D14: owner lane never fetches / reports phone_write");

      insertAgent("aalan-5", "Aalan Gård Fem");
      r = await putMarketplaceKnowledge("aalan-5", { phone: AALAN_REAL_PHONE, dataSource: "owner" });
      assertEq([r.status, r.body?.phone_write?.outcome], [200, "owner_relay"], "D15: admin relay with dataSource owner (CS) is not gated");
      assertEq(knowledge("aalan-5")?.phone, AALAN_REAL_PHONE, "D16: owner relay phone written");

      // ── POST /admin/bulk-enrich ─────────────────────────────────────────
      insertAgent("bulk-1", "Bulk Gård En");
      insertAgent("bulk-2", "Bulk Gård To");
      r = await callRoute(mpRouter, {
        method: "POST",
        url: "/admin/bulk-enrich",
        headers: adminHeaders,
        body: {
          agents: [
            { agentId: "bulk-1", data: { phone: AALAN_INVENTED_PHONE, about: "Bulk en har honning." } },
            { agentId: "bulk-2", data: { phone: AALAN_REAL_PHONE, phone_source_url: AALAN_SITE } },
          ],
        },
      });
      assertEq(r.body?.data?.phoneRejected, 1, "E01: bulk-enrich rejects the unsourced phone");
      assertEq(r.body?.data?.phoneRejections?.[0]?.outcome, "rejected_no_source_url", "E02: rejection outcome reported");
      assertEq(knowledge("bulk-1")?.phone ?? null, null, "E03: bulk-1 phone NOT written");
      assertEq(knowledge("bulk-1")?.about, "Bulk en har honning.", "E04: bulk-1 about still written");
      assertEq(knowledge("bulk-2")?.phone, AALAN_REAL_PHONE, "E05: bulk-2 substantiated phone written");

      // ── POST /admin/google-rating-batch (Kvestad) ───────────────────────
      let brregAdresse: string[] | null = null;
      (globalThis as any).fetch = async (url: string) => {
        const u = String(url);
        if (u.includes("places.googleapis.com")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              places: [{ id: "place-kv", rating: 4.8, userRatingCount: 40, formattedAddress: KVESTAD_ROAD, internationalPhoneNumber: "+4755555555" }],
            }),
          } as any;
        }
        if (u.includes("brreg.no") && brregAdresse) {
          const navn = decodeURIComponent((/navn=([^&]+)/.exec(u) || [])[1] || "");
          return {
            ok: true,
            status: 200,
            json: async () => ({
              _embedded: {
                enheter: [{
                  organisasjonsnummer: "999888777",
                  navn: navn.toUpperCase(),
                  forretningsadresse: { adresse: brregAdresse, postnummer: "5776", poststed: "NÅ" },
                }],
              },
            }),
          } as any;
        }
        return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as any;
      };
      const runBatch = (id: string) =>
        callRoute(mpRouter, {
          method: "POST",
          url: "/admin/google-rating-batch",
          headers: adminHeaders,
          body: { agentIds: [id], include_address_phone: true, max_details_calls: 0 },
        });

      // G1: empty column, homepage street address on record, Google road-only -> not written.
      insertAgent("kv-g1", "Kvestad Sideri Gee En");
      db.prepare(`INSERT INTO agent_knowledge (agent_id, address, field_provenance) VALUES (?, NULL, ?)`).run(
        "kv-g1",
        JSON.stringify({ address: [{ source_type: "homepage", value: KVESTAD_STREET, fetched_at: "2026-09-01T00:00:00Z" }] }),
      );
      r = await runBatch("kv-g1");
      let row0 = r.body?.data?.results?.[0];
      assertEq(row0?.addressWritten, false, "G01: Kvestad — Google 'Fv109' not written when a homepage street address is on record");
      assertEq(row0?.addressSkippedReason, "google_address_without_street_number_better_source_on_record", "G02: skip reason reported");
      assertEq(knowledge("kv-g1")?.address ?? null, null, "G03: address column untouched");

      // G2: empty column, nothing better known -> Google road value still fills (spec: only when better is known).
      insertAgent("kv-g2", "Kvestad Sideri Gee To");
      r = await runBatch("kv-g2");
      assertEq(r.body?.data?.results?.[0]?.addressWritten, true, "G04: road-only Google value still fills an empty column when nothing better is on record");
      assertEq(knowledge("kv-g2")?.address, KVESTAD_ROAD, "G05: column holds the Google value");

      // G3: stored Fv109 + Brreg street address this run -> corrected, geocode reset.
      insertAgent("kv-g3", "Kvestad Sideri Gee Tre");
      db.prepare(`UPDATE agents SET lat = 60.1, lng = 6.5, geo_precision = 'postcode' WHERE id = ?`).run("kv-g3");
      db.prepare(`INSERT INTO agent_knowledge (agent_id, address, field_provenance) VALUES (?, ?, ?)`).run(
        "kv-g3",
        KVESTAD_ROAD,
        JSON.stringify({ address: [{ source_type: "google_places", value: KVESTAD_ROAD, fetched_at: "2026-09-01T00:00:00Z" }] }),
      );
      brregAdresse = ["Reisetevegen 83"];
      r = await runBatch("kv-g3");
      row0 = r.body?.data?.results?.[0];
      assertEq([row0?.addressWritten, row0?.addressCorrected], [true, true], "G06: Brreg street address corrects the stored Fv109");
      assertEq(knowledge("kv-g3")?.address, "Reisetevegen 83, 5776 NÅ", "G07: column now holds the Brreg street address");
      const geo = db.prepare(`SELECT lat, geo_precision FROM agents WHERE id = ?`).get("kv-g3") as any;
      assertEq([geo.lat, geo.geo_precision], [null, null], "G08: geocode reset on the corrected address");

      // G4: same, but curated lock -> not corrected.
      insertAgent("kv-g4", "Kvestad Sideri Gee Fire");
      db.prepare(`INSERT INTO agent_knowledge (agent_id, address, field_provenance, curated_fields) VALUES (?, ?, '{}', ?)`).run(
        "kv-g4",
        KVESTAD_ROAD,
        JSON.stringify({ address: { locked_at: "2026-09-01T00:00:00Z" } }),
      );
      r = await runBatch("kv-g4");
      assertEq(r.body?.data?.results?.[0]?.addressCorrected, undefined, "G09: curated lock refuses the correction");
      assertEq(knowledge("kv-g4")?.address, KVESTAD_ROAD, "G10: curated road value kept");

      // G5: real stored street address is never touched (fill-only as before).
      insertAgent("kv-g5", "Kvestad Sideri Gee Fem");
      db.prepare(`INSERT INTO agent_knowledge (agent_id, address, field_provenance) VALUES (?, ?, '{}')`).run("kv-g5", "Storgata 1, 1400 Ski");
      r = await runBatch("kv-g5");
      assertEq(knowledge("kv-g5")?.address, "Storgata 1, 1400 Ski", "G11: a real street address is not replaced");

      // ── applyAgentBrregContact (Brreg backfill) ─────────────────────────
      const adminAgents = require("./admin-agents") as typeof import("./admin-agents");
      insertAgent("kv-b1", "Kvestad Sideri Be En");
      db.prepare(`INSERT INTO agent_knowledge (agent_id, address, field_provenance) VALUES (?, ?, '{}')`).run("kv-b1", KVESTAD_ROAD);
      const touched = adminAgents.applyAgentBrregContact(db as any, "kv-b1", { address: KVESTAD_STREET }, "https://data.brreg.no/x");
      assertTrue(touched.includes("address"), "H01: Brreg backfill reports address touched");
      assertEq(knowledge("kv-b1")?.address, KVESTAD_STREET, "H02: Brreg backfill corrects the stored Fv109");
      insertAgent("kv-b2", "Kvestad Sideri Be To");
      db.prepare(`INSERT INTO agent_knowledge (agent_id, address, field_provenance) VALUES (?, ?, '{}')`).run("kv-b2", "Lønsdal, 8255 Røkland");
      adminAgents.applyAgentBrregContact(db as any, "kv-b2", { address: KVESTAD_STREET }, "https://data.brreg.no/x");
      assertEq(knowledge("kv-b2")?.address, "Lønsdal, 8255 Røkland", "H03: a farm-name address is not overwritten by Brreg (fill-only as before)");
    } finally {
      (globalThis as any).fetch = prevFetch;
      initMod.__setDbForTesting(prevDb as any);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
      else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
      if (prevPlacesKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
      else process.env.GOOGLE_PLACES_API_KEY = prevPlacesKey;
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  } finally {
    guard.__setPhoneGuardFetchImplForTesting(null);
    guard.__resetPhoneGuardCooldownForTesting();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runW40WriteGuardsTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    // marketplace.ts keeps module-level timers alive — exit explicitly, same
    // as google-rating-batch-provenance-stale-refill.test.ts.
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
