/**
 * admin-corrected-address-guard.test.ts — dev-request
 * 2026-11-08-rfb-adresse-skriveveier-respekterer-admin-retting (Daniel live
 * 2026-11-08, Lega «Litangen 2»).
 *
 * An address a person corrected with POST /admin/agents/content-correction
 * (field "address", lokal#1457) must not be put back to a different value by
 * an automatic write path. services/admin-corrected-address.ts holds the one
 * shared check (isAdminCorrectedAddress / adminCorrectedAddressBlocks); this
 * file drives every write path through the real routes where it can:
 *
 *   U.  the check itself (latest real audited change, value still in the
 *       column, mixed changed_at formats, no-op audit rows skipped)
 *   P1. PUT /admin/knowledge without allow_correct
 *   P2. PUT /admin/knowledge with allow_correct — inference-only provenance
 *       (ok_existing_inference_only) and unverified website
 *       (ok_existing_website_unverified), each with an unguarded control
 *   P3. PUT /api/marketplace/agents/:id/knowledge, admin key
 *   P4. road-designation → street-address upgrades: Brreg backfill
 *       (applyAgentBrregContact — the function the route calls per agent;
 *       the route itself also runs the LLM contact gate, so it is not driven
 *       here), POST /admin/google-rating-batch (Places batch, Brreg address),
 *       POST /admin/homepage-provenance-batch
 *   O.  owner lane (API key) passes; afterwards the guard no longer applies
 *   N.  a new content-correction passes; the guard then protects the new value
 *   F.  empty-field fills and the ", Norge" sweep are unchanged
 *
 * Harness: better-sqlite3 ":memory:" + __setDbForTesting/__initSchemaForTesting,
 * routers driven through router.handle() with a fake req/res, global fetch
 * stubbed (Places, Brreg, homepage pages, LLM judge). No network.
 *
 * Exported runAdminCorrectedAddressGuardTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/admin-corrected-address-guard.test.ts
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

const OLD = "Linutvegen 2";
const FIXED = "Litangen 2";
const ROAD = "Fv109, 5776 Nå";
const STREET = "Reisetevegen 83, 5776 Nå";
const REC = (value: string, source_type: string) => ({ value, source_type, fetched_at: "2026-06-01T00:00:00Z" });

export async function runAdminCorrectedAddressGuardTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const guard = require("../services/admin-corrected-address") as typeof import("../services/admin-corrected-address");

  const prevDb = initMod.__peekDbForTesting();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const prevPlacesKey = process.env.GOOGLE_PLACES_API_KEY;
  const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const prevFetch = (globalThis as any).fetch;
  const ADMIN_KEY = process.env.ADMIN_KEY || "admin-corrected-address-guard-test-key";
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  let ccMod: any = null;
  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;
    process.env.GOOGLE_PLACES_API_KEY = "test-places-key";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-admin-corrected-address";

    const insertAgent = (id: string, name: string, url = "") =>
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, created_at)
         VALUES (?, ?, 't', 't', '', ?, 'producer', ?, 'rfb', '2026-01-01 00:00:00')`,
      ).run(id, name, url, `key-${id}`);
    const insertKnowledge = (id: string, address: string | null, fp: unknown = {}, extra: { website?: string; postal?: string } = {}) =>
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, address, field_provenance, website, postal_code) VALUES (?, ?, ?, ?, ?)`,
      ).run(id, address, JSON.stringify(fp), extra.website ?? null, extra.postal ?? null);
    const know = (id: string) =>
      db.prepare(`SELECT address, phone, email, about, field_provenance FROM agent_knowledge WHERE agent_id = ?`).get(id) as any;
    const audits = (id: string) =>
      db.prepare(`SELECT field_name, old_value, new_value, changed_by, notes FROM agent_knowledge_audit WHERE agent_id = ? ORDER BY rowid`).all(id) as any[];

    delete require.cache[require.resolve("./admin-agents-content-correction")];
    ccMod = require("./admin-agents-content-correction");
    ccMod.__setContentCorrectionDbForTesting(db as any);
    const ccRouter = ccMod.default;
    delete require.cache[require.resolve("./admin-knowledge")];
    const akMod = require("./admin-knowledge");
    const akRouter = akMod.default as any;
    const sweepRouter = akMod.addressNorgeSuffixSweepRouter as any;
    delete require.cache[require.resolve("./marketplace")];
    const mpRouter = require("./marketplace").default as any;
    delete require.cache[require.resolve("./admin-agents")];
    const adminAgents = require("./admin-agents") as typeof import("./admin-agents");

    const adminHeaders = { "x-admin-key": ADMIN_KEY, "content-type": "application/json" };
    const correct = (id: string, text: string) =>
      callRoute(ccRouter, {
        method: "POST",
        url: "/",
        headers: adminHeaders,
        body: { reason: "Test: adressen rettes etter produsentens nettside", items: [{ agent_id: id, field: "address", text }] },
        query: { apply: "1" },
      });
    const putAdminKnowledge = (body: any, query?: Record<string, string>) =>
      callRoute(akRouter, { method: "PUT", url: "/", headers: adminHeaders, body, query });
    const putMarketplaceKnowledge = (id: string, body: any, headers: Record<string, string> = adminHeaders) =>
      callRoute(mpRouter, { method: "PUT", url: `/agents/${id}/knowledge`, headers, body });
    /** Fixture: agent with `start` stored, then corrected to `to` via the real route. */
    const correctedAgent = async (id: string, name: string, start: string | null, to: string, fp: unknown = {}, extra: { website?: string; postal?: string; url?: string } = {}) => {
      insertAgent(id, name, extra.url ?? "");
      insertKnowledge(id, start, fp, extra);
      const r = await correct(id, to);
      assertEq([r.status, r.body?.results?.[0]?.outcome, know(id)?.address], [200, "written", to], `fixture ${id}: content-correction written`);
    };

    // ═══ U. the shared check ═══════════════════════════════════════════════
    insertAgent("u-none", "U Ingen");
    insertKnowledge("u-none", OLD);
    assertEq(guard.isAdminCorrectedAddress(db as any, "u-none"), false, "U01: no audit rows -> not admin-corrected");
    assertEq(guard.isAdminCorrectedAddress(db as any, "u-missing"), false, "U02: unknown agent -> false");

    await correctedAgent("u-a", "U A", OLD, FIXED);
    assertEq(guard.isAdminCorrectedAddress(db as any, "u-a"), true, "U03: after content-correction -> admin-corrected");
    const a0 = audits("u-a")[0];
    assertTrue(a0?.changed_by === "admin" && String(a0?.notes).startsWith("content-correction-"), "U04: fixture audit row is the content-correction shape");
    assertEq(guard.adminCorrectedAddressBlocks(db as any, "u-a", OLD), true, "U05: a different value is blocked");
    assertEq(guard.adminCorrectedAddressBlocks(db as any, "u-a", ` ${FIXED} `), false, "U06: the same value (trimmed) is not blocked");
    assertEq(guard.adminCorrectedAddressBlocks(db as any, "u-a", undefined), false, "U07: no address in the write -> not blocked");
    assertEq(guard.adminCorrectedAddressBlocks(db as any, "u-none", OLD + "x"), false, "U08: not admin-corrected -> never blocked");

    // A later row that records no change (old = new, e.g. Brreg provenance-only) does not lift the guard.
    db.prepare(
      `INSERT INTO agent_knowledge_audit (id, agent_id, field_name, old_value, new_value, changed_by, changed_at, notes)
       VALUES ('u-a-noop', 'u-a', 'address', ?, ?, 'system', '2099-01-01T00:00:00.000Z', 'batch:x source:brreg')`,
    ).run(FIXED, FIXED);
    assertEq(guard.isAdminCorrectedAddress(db as any, "u-a"), true, "U09: a later no-change audit row does not lift the guard");
    // Column changed without an audit row (e.g. an owner write) -> guard off.
    db.prepare(`UPDATE agent_knowledge SET address = 'Eiervegen 5' WHERE agent_id = 'u-a'`).run();
    assertEq(guard.isAdminCorrectedAddress(db as any, "u-a"), false, "U10: column no longer holds the corrected value -> not admin-corrected");

    // Mixed changed_at formats order by time, not by text.
    insertAgent("u-mix", "U Mix");
    insertKnowledge("u-mix", FIXED);
    const audit = db.prepare(
      `INSERT INTO agent_knowledge_audit (id, agent_id, field_name, old_value, new_value, changed_by, changed_at, notes) VALUES (?, 'u-mix', 'address', ?, ?, ?, ?, ?)`,
    );
    audit.run("mix-1", OLD, FIXED, "admin", "2026-11-10 12:00:00", "content-correction-20261110-120000: r");
    audit.run("mix-2", FIXED, "Annen vei 1", "owner", "2026-11-10T09:00:00.000Z", "owner edit (earlier, ISO format)");
    assertEq(guard.isAdminCorrectedAddress(db as any, "u-mix"), true, "U11: an earlier ISO-format owner row does not outrank a later space-format correction");
    audit.run("mix-3", FIXED, FIXED + " B", "owner", "2026-11-10T13:00:00.000Z", "owner edit (later)");
    assertEq(guard.isAdminCorrectedAddress(db as any, "u-mix"), false, "U12: a later owner row lifts the guard");
    insertAgent("u-other", "U Other");
    insertKnowledge("u-other", FIXED);
    db.prepare(
      `INSERT INTO agent_knowledge_audit (id, agent_id, field_name, old_value, new_value, changed_by, changed_at, notes)
       VALUES ('o-1', 'u-other', 'address', ?, ?, 'admin', datetime('now'), 'put_admin_knowledge: something else')`,
    ).run(OLD, FIXED);
    assertEq(guard.isAdminCorrectedAddress(db as any, "u-other"), false, "U13: an admin audit row from another route is not a content-correction");

    // ═══ P1. PUT /admin/knowledge without allow_correct ════════════════════
    insertAgent("p1-ctl", "P1 Kontroll");
    insertKnowledge("p1-ctl", FIXED);
    let r = await putAdminKnowledge({ agent_id: "p1-ctl", address: OLD });
    assertEq([r.status, know("p1-ctl")?.address, r.body?.address_rejected_reason], [200, OLD, undefined], "P1-00: control — without a correction the address IS overwritten (test is not vacuous)");

    await correctedAgent("p1", "P1 Gård", OLD, FIXED);
    r = await putAdminKnowledge({ agent_id: "p1", address: OLD, about: "P1 Gård lager ost og smør på gården." });
    assertEq(r.status, 200, "P1-01: mixed write -> 200");
    assertEq(know("p1")?.address, FIXED, "P1-02: corrected address kept");
    assertEq(r.body?.address_rejected_reason, "admin_corrected", "P1-03: response says admin_corrected");
    assertTrue(!(r.body?.columns_updated ?? []).includes("address") && (r.body?.columns_updated ?? []).includes("about"), "P1-04: address absent from columns_updated, about present");
    assertEq(know("p1")?.about, "P1 Gård lager ost og smør på gården.", "P1-05: about written in the same call");
    r = await putAdminKnowledge({ agent_id: "p1", address: FIXED });
    assertEq([r.status, r.body?.address_rejected_reason, know("p1")?.address], [200, undefined, FIXED], "P1-06: re-sending the corrected value is no change, not refused");
    r = await putAdminKnowledge({ agent_id: "p1", address: `${FIXED}, Norge` });
    assertEq([r.body?.address_rejected_reason, know("p1")?.address], [undefined, FIXED], "P1-07: same value after the ', Norge' normalisation is not refused");

    // ═══ P2. PUT /admin/knowledge with allow_correct ═══════════════════════
    const FP_INFER = { address: [REC(OLD, "web_search:gulesider.no")] };
    const FP_UNVERIFIED = { address: [REC(OLD, "google_places")], website_ownership: { status: "unverified" } };
    const INCOMING_2A = { address: [REC(OLD + "x", "homepage"), REC(OLD + "x", "google_places")] };
    // Controls: the same provenance without a correction -> overwrite allowed by canCorrectFactualField.
    insertAgent("p2-ctl-inf", "P2 Kontroll A");
    insertKnowledge("p2-ctl-inf", FIXED, FP_INFER);
    r = await putAdminKnowledge({ agent_id: "p2-ctl-inf", address: OLD + "x", field_provenance: INCOMING_2A }, { allow_correct: "1" });
    assertEq([know("p2-ctl-inf")?.address, (r.body?.corrections ?? []).find((c: any) => c.field === "address")?.reason],
      [OLD + "x", "ok_existing_inference_only"], "P2-00a: control — inference-only provenance is corrected (ok_existing_inference_only)");
    insertAgent("p2-ctl-unv", "P2 Kontroll B");
    insertKnowledge("p2-ctl-unv", FIXED, FP_UNVERIFIED);
    r = await putAdminKnowledge({ agent_id: "p2-ctl-unv", address: OLD + "x", field_provenance: INCOMING_2A }, { allow_correct: "1" });
    assertEq([know("p2-ctl-unv")?.address, (r.body?.corrections ?? []).find((c: any) => c.field === "address")?.reason],
      [OLD + "x", "ok_existing_website_unverified"], "P2-00b: control — unverified website is corrected (ok_existing_website_unverified)");

    for (const [id, fp] of [["p2-inf", FP_INFER], ["p2-unv", FP_UNVERIFIED]] as const) {
      await correctedAgent(id, `Gård ${id}`, OLD, FIXED, fp);
      r = await putAdminKnowledge(
        { agent_id: id, address: OLD + "x", about: `Om ${id}: gardsbutikk med egg.`, field_provenance: INCOMING_2A },
        { allow_correct: "1" },
      );
      const c = (r.body?.corrections ?? []).filter((x: any) => x.field === "address");
      assertEq(know(id)?.address, FIXED, `P2-01 ${id}: corrected address kept under allow_correct`);
      assertEq(c, [{ field: "address", action: "refused", reason: "admin_corrected" }], `P2-02 ${id}: corrections[] has one refused/admin_corrected entry`);
      assertEq(r.body?.address_rejected_reason, "admin_corrected", `P2-03 ${id}: address_rejected_reason`);
      assertEq(know(id)?.about, `Om ${id}: gardsbutikk med egg.`, `P2-04 ${id}: about written in the same call`);
    }

    // ═══ P3. PUT /api/marketplace/agents/:id/knowledge (admin key) ═════════
    insertAgent("p3-ctl", "P3 Kontroll");
    insertKnowledge("p3-ctl", FIXED);
    r = await putMarketplaceKnowledge("p3-ctl", { address: OLD });
    assertEq([r.status, know("p3-ctl")?.address], [200, OLD], "P3-00: control — admin lane overwrites without a correction");

    await correctedAgent("p3", "P3 Gård", OLD, FIXED);
    r = await putMarketplaceKnowledge("p3", { address: OLD, about: "P3 Gård selger lam og ull." });
    assertEq(r.status, 200, "P3-01: admin lane mixed write -> 200");
    assertEq(know("p3")?.address, FIXED, "P3-02: corrected address kept");
    assertEq(r.body?.address_rejected_reason, "admin_corrected", "P3-03: response says admin_corrected");
    assertEq(know("p3")?.about, "P3 Gård selger lam og ull.", "P3-04: about written in the same call");
    assertTrue(!r.body?.geocode_invalidated, "P3-05: no geocode reset (nothing moved)");
    r = await putMarketplaceKnowledge("p3", { address: OLD, dataSource: "owner" });
    assertEq([know("p3")?.address, r.body?.address_rejected_reason], [FIXED, "admin_corrected"], "P3-06: dataSource owner on the shared admin key is not the owner");
    r = await putMarketplaceKnowledge("p3", { address: "", about: "P3 Gård selger lam, ull og skinn." });
    assertEq([know("p3")?.address, r.body?.address_rejected_reason], [FIXED, "admin_corrected"], "P3-07: clearing the corrected address on the admin lane is refused too");
    r = await putMarketplaceKnowledge("p3", { address: FIXED });
    assertEq([r.status, r.body?.address_rejected_reason], [200, undefined], "P3-08: same value -> no refusal");

    // ═══ O. owner lane passes; then the guard no longer applies ════════════
    r = await putMarketplaceKnowledge("p3", { address: "Eiervegen 7" }, { "x-api-key": "key-p3" });
    assertEq([r.status, know("p3")?.address, r.body?.address_rejected_reason], [200, "Eiervegen 7", undefined], "O01: owner (API key) write passes after an admin correction");
    assertEq(guard.isAdminCorrectedAddress(db as any, "p3"), false, "O02: after the owner's change the guard no longer applies");
    r = await putAdminKnowledge({ agent_id: "p3", address: "Berikingsvegen 9" });
    assertEq([know("p3")?.address, r.body?.address_rejected_reason], ["Berikingsvegen 9", undefined], "O03: an automatic write after the owner's change is not refused");

    // ═══ N. a new content-correction passes; the guard then protects it ════
    await correctedAgent("n1", "N1 Gård", OLD, FIXED);
    r = await correct("n1", "Litangen 4");
    assertEq([r.body?.results?.[0]?.outcome, know("n1")?.address], ["written", "Litangen 4"], "N01: a new content-correction passes over the old one");
    r = await putAdminKnowledge({ agent_id: "n1", address: FIXED });
    assertEq([know("n1")?.address, r.body?.address_rejected_reason], ["Litangen 4", "admin_corrected"], "N02: the previous corrected value is now refused (guard protects the new value)");
    r = await putMarketplaceKnowledge("n1", { address: OLD });
    assertEq([know("n1")?.address, r.body?.address_rejected_reason], ["Litangen 4", "admin_corrected"], "N03: marketplace admin lane refused too");

    // ═══ P4a. Brreg backfill (applyAgentBrregContact) ═════════════════════
    insertAgent("b-ctl", "Brreg Kontroll");
    insertKnowledge("b-ctl", ROAD);
    adminAgents.applyAgentBrregContact(db as any, "b-ctl", { address: STREET }, "https://data.brreg.no/x");
    assertEq(know("b-ctl")?.address, STREET, "P4a-00: control — Brreg upgrades a road-only address without a correction");

    await correctedAgent("b1", "Brreg Gård", "Gamlevegen 1, 5776 Nå", ROAD);
    const report: { addressSkippedReason?: string } = {};
    const touched = adminAgents.applyAgentBrregContact(db as any, "b1", { address: STREET, phone: "+4755123456" }, "https://data.brreg.no/x", { report });
    assertEq(know("b1")?.address, ROAD, "P4a-01: corrected road-only address NOT upgraded by Brreg");
    assertEq(report.addressSkippedReason, "admin_corrected", "P4a-02: report says admin_corrected");
    assertEq(know("b1")?.phone, "+4755123456", "P4a-03: phone filled in the same call (fill-only unchanged)");
    assertTrue(touched.includes("phone"), "P4a-04: phone reported touched");
    assertTrue(JSON.parse(know("b1")?.field_provenance || "{}").address?.some((x: any) => x.source_type === "brreg"), "P4a-05: Brreg address provenance still recorded");
    assertEq(guard.isAdminCorrectedAddress(db as any, "b1"), true, "P4a-06: Brreg's provenance-only audit row does not lift the guard");
    const report2: { addressSkippedReason?: string } = {};
    adminAgents.applyAgentBrregContact(db as any, "b1", { address: STREET }, "https://data.brreg.no/x2", { report: report2 });
    assertEq([know("b1")?.address, report2.addressSkippedReason], [ROAD, "admin_corrected"], "P4a-07: a second Brreg run is still refused");
    const reportDry: { addressSkippedReason?: string } = {};
    adminAgents.applyAgentBrregContact(db as any, "b1", { address: STREET }, "https://data.brreg.no/x3", { dryRun: true, report: reportDry });
    assertEq(reportDry.addressSkippedReason, "admin_corrected", "P4a-08: dry-run reports the same refusal");

    // ═══ P4b. Places batch (POST /admin/google-rating-batch, Brreg address) ═
    (require("../services/places-match") as typeof import("../services/places-match")).__setPlacesAddressFetchForTesting(true);
    let brregAdresse: string[] | null = ["Reisetevegen 83"];
    const homepages: Record<string, string> = {};
    (globalThis as any).fetch = async (url: string) => {
      const u = String(url);
      if (u.includes("api.anthropic.com")) {
        return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "GODKJENN\nEkte kontaktinfo." }] }) } as any;
      }
      if (u.includes("places.googleapis.com")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            places: [{
              id: "place-kv",
              displayName: { text: "Kvestad Sideri" },
              rating: 4.8,
              userRatingCount: 40,
              formattedAddress: ROAD,
              internationalPhoneNumber: "+4755555555",
              addressComponents: [
                { longText: "5776", shortText: "5776", types: ["postal_code"] },
                { longText: "Nå", shortText: "Nå", types: ["postal_town"] },
              ],
            }],
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
      for (const [host, html] of Object.entries(homepages)) {
        if (u.includes(host)) return { ok: true, status: 200, text: async () => html } as any;
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as any;
    };
    const runPlaces = (id: string) =>
      callRoute(mpRouter, {
        method: "POST",
        url: "/admin/google-rating-batch",
        headers: adminHeaders,
        body: { agentIds: [id], include_address_phone: true, max_details_calls: 0 },
      });

    insertAgent("g-ctl", "Kvestad Sideri Kontroll");
    insertKnowledge("g-ctl", ROAD, { address: [REC(ROAD, "google_places")] }, { postal: "5776" });
    r = await runPlaces("g-ctl");
    assertEq([r.body?.data?.results?.[0]?.addressCorrected, know("g-ctl")?.address], [true, "Reisetevegen 83, 5776 NÅ"],
      "P4b-00: control — the Places batch upgrades a road-only address without a correction");

    await correctedAgent("g1", "Kvestad Sideri Rettet", "Gamlevegen 1, 5776 Nå", ROAD, { address: [REC(ROAD, "google_places")] }, { postal: "5776" });
    r = await runPlaces("g1");
    let row0 = r.body?.data?.results?.[0];
    assertEq(know("g1")?.address, ROAD, "P4b-01: corrected road-only address NOT upgraded by the Places batch");
    assertEq([row0?.addressWritten, row0?.addressCorrected, row0?.addressSkippedReason], [false, undefined, "admin_corrected"], "P4b-02: result says admin_corrected");
    assertEq(know("g1")?.phone, "+4755555555", "P4b-03: phone filled in the same call (fill-only unchanged)");
    assertTrue(JSON.parse(know("g1")?.field_provenance || "{}").address?.some((x: any) => x.source_type === "brreg"), "P4b-04: Brreg address provenance still merged");

    // Empty column: the Places fill is unchanged (an empty column is never admin-corrected).
    insertAgent("g-empty", "Kvestad Sideri Tom");
    insertKnowledge("g-empty", null, {}, { postal: "5776" });
    r = await runPlaces("g-empty");
    assertEq([r.body?.data?.results?.[0]?.addressWritten, know("g-empty")?.address], [true, "Reisetevegen 83, 5776 NÅ"], "F01: Places fill of an empty address unchanged");
    brregAdresse = null;

    // ═══ P4c. Homepage batch (POST /admin/homepage-provenance-batch) ═══════
    const page = (name: string, host: string) =>
      `<html><head><title>${name}</title></head><body><h1>${name}</h1>
       <p>Besøk oss på gården.</p><p>Reisetevegen 83, 5776 Nå</p>
       <a href="mailto:post@${host}">post@${host}</a></body></html>`;
    const runHomepage = (id: string) =>
      callRoute(mpRouter, {
        method: "POST",
        url: "/admin/homepage-provenance-batch",
        headers: adminHeaders,
        body: { agentIds: [id] },
      });
    homepages["hpkontroll.no"] = page("Hpkontroll Gard", "hpkontroll.no");
    insertAgent("h-ctl", "Hpkontroll Gard", "https://hpkontroll.no");
    insertKnowledge("h-ctl", ROAD, {}, { website: "https://hpkontroll.no" });
    r = await runHomepage("h-ctl");
    assertEq([r.status, know("h-ctl")?.address, r.body?.data?.address_corrected_ids], [200, STREET, ["h-ctl"]],
      "P4c-00: control — the homepage batch upgrades a road-only address without a correction");

    homepages["hprettet.no"] = page("Hprettet Gard", "hprettet.no");
    await correctedAgent("h1", "Hprettet Gard", "Gamlevegen 1, 5776 Nå", ROAD, {}, { website: "https://hprettet.no", url: "https://hprettet.no" });
    r = await runHomepage("h1");
    assertEq(r.status, 200, "P4c-01: batch -> 200");
    assertEq(know("h1")?.address, ROAD, "P4c-02: corrected road-only address NOT upgraded by the homepage batch");
    assertEq([r.body?.data?.address_skipped_admin_corrected_ids, r.body?.data?.address_skipped_reason, r.body?.data?.address_corrected_ids],
      [["h1"], "admin_corrected", []], "P4c-03: response says admin_corrected");
    assertEq(know("h1")?.email, "post@hprettet.no", "P4c-04: email filled in the same call (fill-only unchanged)");
    assertTrue(JSON.parse(know("h1")?.field_provenance || "{}").address?.some((x: any) => x.source_type === "homepage" && x.value === STREET),
      "P4c-05: homepage address provenance still merged");

    homepages["hptom.no"] = page("Hptom Gard", "hptom.no");
    insertAgent("h-empty", "Hptom Gard", "https://hptom.no");
    insertKnowledge("h-empty", null, {}, { website: "https://hptom.no" });
    r = await runHomepage("h-empty");
    assertEq([know("h-empty")?.address, r.body?.data?.address_skipped_admin_corrected_ids], [STREET, undefined], "F02: homepage fill of an empty address unchanged");

    // ═══ F. formatting sweep unchanged ════════════════════════════════════
    await correctedAgent("f-norge", "Norge Gård", OLD, `${FIXED}, Norge`);
    r = await callRoute(sweepRouter, { method: "POST", url: "/address-norge-suffix-sweep", headers: adminHeaders, body: { dry_run: false } });
    assertEq([r.status, know("f-norge")?.address], [200, FIXED], "F03: ', Norge' sweep still strips the suffix of a corrected address (unchanged)");
    assertEq(audits("f-norge").length, 1, "F04: the sweep writes no audit row — it is not counted as a new correction");
    insertAgent("f-fill", "Tom Gård");
    insertKnowledge("f-fill", null);
    r = await putAdminKnowledge({ agent_id: "f-fill", address: OLD });
    assertEq([know("f-fill")?.address, r.body?.address_rejected_reason], [OLD, undefined], "F05: PUT /admin/knowledge fill of an empty address unchanged");
  } finally {
    (globalThis as any).fetch = prevFetch;
    try {
      (require("../services/places-match") as typeof import("../services/places-match")).__setPlacesAddressFetchForTesting(null);
    } catch { /* ignore */ }
    try { ccMod?.__setContentCorrectionDbForTesting(null); } catch { /* ignore */ }
    initMod.__setDbForTesting(prevDb as any);
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
    else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevPlacesKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
    else process.env.GOOGLE_PLACES_API_KEY = prevPlacesKey;
    if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminCorrectedAddressGuardTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    // marketplace.ts keeps module-level timers alive — exit explicitly.
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
