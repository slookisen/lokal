/**
 * opplevelser-experience-data-corrections.test.ts — tests for
 *
 *   POST /api/opplevelser/admin/experiences-data-corrections
 *   POST /api/opplevelser/admin/experiences-data-corrections/revert
 *
 * (source-backed factual corrections of kommune / fylke / title / season /
 * duration / price_from / homepage_url / provider on opplevagent rows, with
 * an audit table and a revert route).
 *
 * Sections:
 *   P — pure helpers (season codes, duration/price/provider parsing, kommune
 *       resolution against the vendored SSB table, normalisation).
 *   R — applyExperienceDataCorrections()/revertExperienceDataCorrections()
 *       and the two routes, on a FRESH in-memory experiences DB.
 *
 * NO network: globalThis.fetch is replaced by a stub that counts and throws;
 * the suite asserts the count is 0 at the end.
 *
 * Setup convention mirrors opplevelser-experience-description-write.test.ts:
 * EXPERIENCES_DB_PATH=":memory:", a fresh require of db-factory +
 * experience-store + the opplevelser router, the main db pinned in-memory
 * (write-pause lookups), the router driven via router.handle().
 */

import { createHash } from "node:crypto";
import * as opp0 from "./opplevelser";
import {
  expDcSeasonCodes,
  expDcParseDuration,
  expDcParsePrice,
  expDcParseProvider,
  expDcResolveKommune,
  expDcCanonicalFylke,
  expDcNormalise,
  experienceDescriptionFactsFingerprint,
} from "./opplevelser";

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
  opts: { method: "GET" | "POST"; url: string; headers?: Record<string, string>; body?: any; query?: Record<string, string> },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: opts.method,
      url: opts.url,
      originalUrl: opts.url,
      path: opts.url,
      query: opts.query || {},
      headers: opts.headers || {},
      body: opts.body,
      app: { get: (k: string) => ROUTE_APP_SETTINGS[k] },
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
      else resolve({ status: 404, body: { error: "unhandled" } });
    });
  });
}

const SRC = "https://kilde.example/side";
const ROUTE_APP_SETTINGS: Record<string, unknown> = {};

/** Brreg enheter fixtures for the stubbed GET /enheter/{orgNr}. */
const BRREG_FIXTURES: Record<string, Record<string, unknown>> = {
  "123123123": { organisasjonsnummer: "123123123", navn: "HELT NY TILBYDER AS", naeringskode1: { kode: "79.120" },
    forretningsadresse: { adresse: ["Nyveien 1"], postnummer: "5003", poststed: "BERGEN", kommune: "BERGEN" } },
  "946175986": { organisasjonsnummer: "946175986", navn: "SKIFORENINGEN", naeringskode1: { kode: "93.120" },
    forretningsadresse: { adresse: ["Kongeveien 5"], postnummer: "0787", poststed: "OSLO" } },
  "976912450": { organisasjonsnummer: "976912450", navn: "STIFTELSEN NORSK MARITIMT MUSEUM", naeringskode1: { kode: "91.021" },
    forretningsadresse: { adresse: ["Bygdøynesveien 37"], postnummer: "0286", poststed: "OSLO" } },
  "931735357": { organisasjonsnummer: "931735357", navn: "FJORD TOURS AS", naeringskode1: { kode: "79.120" },
    forretningsadresse: { adresse: ["Strandkaien 1"], postnummer: "5013", poststed: "BERGEN" } },
  "222333444": { organisasjonsnummer: "222333444", navn: "KONKURS TURER AS", konkurs: true },
  "333444555": { organisasjonsnummer: "333444555", navn: "SLETTET TURER AS", slettedato: "2024-01-01" },
  "444555666": { organisasjonsnummer: "444555666", navn: "AVVIKLING TURER AS", underAvvikling: true },
  "555666777": { organisasjonsnummer: "555666777", navn: "HELT ANNET SELSKAP AS", naeringskode1: { kode: "79.120" } },
  "666777888": { organisasjonsnummer: "666777888", navn: "AUST-AGDER MUSEUM OG ARKIV IKS", naeringskode1: { kode: "91.021" },
    forretningsadresse: { adresse: ["Vitensenteret 1"], postnummer: "4838", poststed: "ARENDAL" } },
};
const brregRequests: string[] = [];
const BRREG_FAIL = new Set<string>();
const BRREG_THROW = new Set<string>();
let anthropicRequests = 0;
const brregStub = (async (url: any) => {
  const u = String(url);
  if (u.includes("api.anthropic.com")) { anthropicRequests++; throw new Error("LLM call through the Brreg seam"); }
  brregRequests.push(u);
  if (!u.startsWith("https://data.brreg.no/")) throw new Error(`non-Brreg URL through the Brreg seam: ${u}`);
  const m = /\/enheter\/(\d{9})$/.exec(u);
  if (m && BRREG_FAIL.has(m[1])) return { ok: false, status: 503, json: async () => ({}) } as unknown as Response;
  if (m && BRREG_THROW.has(m[1])) throw new Error("ECONNRESET");
  const fx = m ? BRREG_FIXTURES[m[1]] : undefined;
  if (!fx) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  return { ok: true, status: 200, json: async () => fx } as unknown as Response;
}) as unknown as typeof fetch;
const QUOTE = "Sitat fra kilden.";

export function runOpplevelserExperienceDataCorrectionsTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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

  return (async () => {
    const prevFetch = globalThis.fetch;
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;

    // ═══════════════════════════════════════════════════════════════════
    // Section P — pure helpers
    // ═══════════════════════════════════════════════════════════════════
    try {
      assertEq(expDcSeasonCodes("vår, sommer, høst, vinter"), ["autumn", "spring", "summer", "winter"], "dc-p1a: Norwegian labels -> codes (sorted)");
      assertEq(expDcSeasonCodes("vaar, sommer, host"), ["autumn", "spring", "summer"], "dc-p1b: vaar/host spellings");
      assertEq(expDcSeasonCodes('["vaar","host"]'), ["autumn", "spring"], "dc-p1c: raw JSON array with Norwegian codes");
      assertEq(expDcSeasonCodes('["summer","winter"]'), ["summer", "winter"], "dc-p1d: raw JSON array with English codes");
      assertEq(expDcSeasonCodes("hele året"), ["year_round"], "dc-p1e: hele året -> year_round");
      assertEq(expDcSeasonCodes("Høst og vinter"), ["autumn", "winter"], "dc-p1f: 'og' separator, case-insensitive");
      assertEq(expDcSeasonCodes("monsun"), null, "dc-p1g: unknown token -> null");
      assertEq(expDcSeasonCodes(null), [], "dc-p1h: null -> []");

      assertEq(expDcParseDuration("omtrent 120 minutter"), { min: 120, max: 120 }, "dc-p2a: 'omtrent N minutter'");
      assertEq(expDcParseDuration(150), { min: 150, max: 150 }, "dc-p2b: integer");
      assertEq(expDcParseDuration("150"), { min: 150, max: 150 }, "dc-p2c: numeric string");
      assertEq(expDcParseDuration("60-90 minutter"), { min: 60, max: 90 }, "dc-p2d: range");
      assertEq(expDcParseDuration("ca. 45 min"), { min: 45, max: 45 }, "dc-p2e: 'ca. N min'");
      assertEq(expDcParseDuration("to timer"), null, "dc-p2f: prose -> null");
      assertEq(expDcParseDuration(1.5), null, "dc-p2g: non-integer -> null");

      assertEq(expDcParsePrice("795"), 795, "dc-p3a: digits");
      assertEq(expDcParsePrice("fra 120 kroner"), 120, "dc-p3b: rendered form");
      assertEq(expDcParsePrice("1 700"), 1700, "dc-p3c: thousands separator");
      assertEq(expDcParsePrice("150 kr"), 150, "dc-p3d: kr suffix");
      assertEq(expDcParsePrice("gratis"), null, "dc-p3e: prose -> null");

      assertEq(expDcParseProvider("Fjord Tours AS (org.nr. 931735357)"), { name: "Fjord Tours AS", org_nr: "931735357" }, "dc-p4a: parenthesised org.nr.");
      assertEq(expDcParseProvider("Skiforeningen (Skimuseet Holmenkollen), org.nr. 946175986"),
        { name: "Skiforeningen (Skimuseet Holmenkollen)", org_nr: "946175986" }, "dc-p4b: trailing ', org.nr.' keeps the name's own parenthesis");
      assertEq(expDcParseProvider("Norsk Maritimt Museum"), { name: "Norsk Maritimt Museum", org_nr: null }, "dc-p4c: no org.nr.");
      assertEq(expDcParseProvider("Firma AS org nr: 123 456 789"), { name: "Firma AS", org_nr: "123456789" }, "dc-p4d: spaced org nr");

      assertEq(expDcResolveKommune("Sandefjord", null), { kommune: "Sandefjord", fylke: "Vestfold" }, "dc-p5a: plain kommune");
      assertEq(expDcResolveKommune("Vågan (Svolvær), Nordland", null), { kommune: "Vågan", fylke: "Nordland" }, "dc-p5b: 'Vågan (Svolvær), Nordland'");
      assertEq(expDcResolveKommune("Øvre Eiker (Buskerud)", null), { kommune: "Øvre Eiker", fylke: "Buskerud" }, "dc-p5c: fylke in parenthesis");
      assertEq(expDcResolveKommune("Herøy", "Møre og Romsdal"), { kommune: "Herøy", fylke: "Møre og Romsdal" }, "dc-p5d: Herøy disambiguated by the row's fylke");
      assertEq(expDcResolveKommune("Herøy", "Nordland"), { kommune: "Herøy", fylke: "Nordland" }, "dc-p5e: ...the other Herøy");
      assertTrue("error" in expDcResolveKommune("Herøy", "Oslo"), "dc-p5f: Herøy with an unrelated fylke -> error (never guessed)");
      assertTrue("error" in expDcResolveKommune("Herøy", null), "dc-p5g: Herøy with no fylke -> error");
      assertEq(expDcResolveKommune("Kåfjord", null), { kommune: "Kåfjord", fylke: "Troms" }, "dc-p5h: Norwegian name of a Sami-primary kommune is kept");
      assertTrue("error" in expDcResolveKommune("Svolvær", null), "dc-p5i: a town that is not a kommune -> error");
      assertTrue("error" in expDcResolveKommune("Sandefjord, Telemark", null), "dc-p5j: kommune/fylke hint conflict -> error");
      assertEq(expDcResolveKommune("midt-telemark", null), { kommune: "Midt-Telemark", fylke: "Telemark" }, "dc-p5k: case fold, canonical spelling stored");

      assertEq(opp0.expDcUrlHost("https://www.Example.no/x"), "example.no", "dc-p8a: WHATWG host, lower-case, www stripped");
      assertEq(opp0.expDcUrlHost("example.no"), "example.no", "dc-p8b: bare host gets https://");
      assertEq(opp0.expDcUrlHost("https://evil.com\\@example.no/x"), null, "dc-p8c: backslash -> null");
      assertEq(opp0.expDcUrlHost("https://user:pw@example.no/x"), null, "dc-p8d: userinfo -> null");
      assertEq(opp0.expDcUrlHost("https://example.no:8080/x"), null, "dc-p8e: non-default port -> null");
      assertEq(opp0.expDcUrlHost("https://example.no:443/x"), "example.no", "dc-p8f: default port is fine");
      assertEq(opp0.expDcBrregNameMatches("Stavanger Museum", "STAVANGER TAXI AS"), false, "dc-p9a: one shared token (half) is not a match");
      assertEq(opp0.expDcBrregNameMatches("Skiforeningen (Skimuseet Holmenkollen)", "SKIFORENINGEN"), true, "dc-p9b: >half of the shorter name");
      assertEq(opp0.expDcBrregNameMatches("Fjord Tours AS", "FJORD TOURS AS"), true, "dc-p9c: equal normalised names (filler-only)");
      assertEq(opp0.expDcBrregNameMatches("Norsk Maritimt Museum", "STIFTELSEN NORSK MARITIMT MUSEUM"), true, "dc-p9d: two shared tokens");
      assertEq(opp0.expDcBrregNameMatches("Bergen Fjord Tours", "STAVANGER FJORD TOURS AS"), false, "dc-p9e: filler words never bind");
      assertEq(opp0.expDcSeasonCanon(["autumn", "spring", "summer", "winter"]), ["year_round"], "dc-p10a: all four -> year_round");
      assertEq(expDcCanonicalFylke("vestfold"), "Vestfold", "dc-p6a: canonical fylke");
      assertEq(expDcCanonicalFylke("Viken"), null, "dc-p6b: 2020-era Viken is not accepted");
      assertEq(expDcCanonicalFylke("Vestfold og Telemark"), null, "dc-p6c: Vestfold og Telemark is not accepted");
      assertEq(expDcNormalise("  Null "), "", "dc-p7a: 'null' normalises to empty");
      assertEq(expDcNormalise("Fra  120\nKroner"), "fra 120 kroner", "dc-p7b: whitespace + case");
    } catch (err: any) {
      failed++;
      failures.push("experience-data-corrections (section P): unexpected error: " + String(err?.stack || err?.message || err));
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section R — function + routes
    // ═══════════════════════════════════════════════════════════════════
    const ADMIN_KEY_DC = process.env.ADMIN_KEY || "experience-data-corrections-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = ADMIN_KEY_DC;
    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    for (const p of [dbFactoryPath, experienceStorePath, opplevelserPath]) delete require.cache[p];
    let restoreMainDb: (() => void) | null = null;
    let networkCalls = 0;
    globalThis.fetch = (async (url: any) => {
      networkCalls++;
      if (String(url).includes("api.anthropic.com")) anthropicRequests++;
      throw new Error(`fetch must not be called (${String(url)})`);
    }) as typeof fetch;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const init = require("../database/init") as typeof import("../database/init");
      restoreMainDb = init.__pinInMemoryDbForTesting();
      const pauseSvc = require("../services/enrichment-write-pause") as typeof import("../services/enrichment-write-pause");
      const opp = require("./opplevelser") as typeof import("./opplevelser");
      const brregClient = require("../services/brreg-client") as typeof import("../services/brreg-client");
      brregClient.__clearBrregVerifyCacheForTesting();
      brregClient.__clearBrregAddressCacheForTesting();
      ROUTE_APP_SETTINGS["experienceDataCorrectionsBrregFetchImpl"] = brregStub;
      const router = opp.default as any;
      const auth = { "x-admin-key": ADMIN_KEY_DC };
      const post = (url: string, body: any) => {
        process.env.ADMIN_KEY = ADMIN_KEY_DC;
        return callRoute(router, { method: "POST", url, headers: auth, body });
      };
      const apply = async (items: any[], extra: Record<string, unknown> = {}): Promise<any> =>
        opp.applyExperienceDataCorrections(expDb as any, { items, ...extra }, { dryRun: false, brregFetchImpl: brregStub });
      const preview = async (items: any[]): Promise<any> =>
        opp.applyExperienceDataCorrections(expDb as any, { items }, { dryRun: true, brregFetchImpl: brregStub });
      const revert = (body: any, dryRun = false) =>
        opp.revertExperienceDataCorrections(expDb as any, body, { dryRun }) as any;
      const dumpAll = (): string =>
        JSON.stringify([
          expDb.prepare("SELECT * FROM experiences ORDER BY id").all(),
          expDb.prepare("SELECT * FROM experience_providers ORDER BY id").all(),
          expDb.prepare("SELECT * FROM experience_data_corrections ORDER BY id").all(),
        ]);
      const rowOf = (id: string): any => expDb.prepare("SELECT * FROM experiences WHERE id = ?").get(id);
      const provOf = (id: string): any => expDb.prepare("SELECT * FROM experience_providers WHERE id = ?").get(id);
      const fpOf = (id: string): string => {
        const r = expDb.prepare(
          `SELECT e.*, p.navn AS provider_navn, p.brreg_verified AS provider_brreg_verified,
                  p.field_provenance AS provider_field_provenance, p.hjemmeside AS provider_hjemmeside
             FROM experiences e LEFT JOIN experience_providers p ON p.id = e.provider_id WHERE e.id = ?`,
        ).get(id) as any;
        return experienceDescriptionFactsFingerprint(r);
      };
      const item = (id: string, field: string, expected_current: unknown, new_value: unknown, over: Record<string, unknown> = {}) => ({
        id, field, action: "correct", expected_current, new_value, source_url: SRC, quote: QUOTE, confidence: "high", ...over,
      });
      const clearItem = (id: string, field: string, expected_current: unknown, over: Record<string, unknown> = {}) => ({
        id, field, action: "clear", expected_current, source_url: SRC, quote: QUOTE, confidence: "high", ...over,
      });
      const resultOf = (out: any, i = 0) => out.results[i];

      // ── Seed ────────────────────────────────────────────────────────
      const verifiedProv = JSON.stringify({ hjemmeside_verification: { verified: true, classification: "verified" } });
      const provShared = expStore.createProvider({
        navn: "Delt Tilbyder AS", kommune: "Bergen", fylke: "Vestland",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified", hjemmeside: "https://delt.example",
      } as any);
      expDb.prepare("UPDATE experience_providers SET field_provenance = ? WHERE id = ?").run(verifiedProv, provShared);
      const provSolo = expStore.createProvider({
        navn: "Solo Tilbyder AS", org_nr: "999888777", brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        hjemmeside: "https://solo.example/en/",
      } as any);
      expDb.prepare("UPDATE experience_providers SET field_provenance = ? WHERE id = ?").run(verifiedProv, provSolo);
      const provClaimed = expStore.createProvider({ navn: "Eid Tilbyder AS", brreg_verified: 1, brreg_active: 1 } as any);
      expDb.prepare("UPDATE experience_providers SET claimed_at = datetime('now') WHERE id = ?").run(provClaimed);
      const provOther = expStore.createProvider({ navn: "Øvrig Turselskap AS", brreg_verified: 1, brreg_active: 1, org_nr: "911222333" } as any);
      const provDupA = expStore.createProvider({ navn: "Tvilling AS", brreg_verified: 1, brreg_active: 1 } as any);
      const provDupB = expStore.createProvider({ navn: "tvilling as", brreg_verified: 1, brreg_active: 1 } as any);

      const seed = (id: string, over: Record<string, unknown> = {}): string =>
        expStore.createExperience({
          id, title: "Kajakktur i fjorden", provider_id: provShared, kommune: "Bergen", fylke: "Vestland",
          category: "natur_friluft", season: ["summer"], indoor_outdoor: "outdoor",
          duration_min: 60, duration_max: 60, price_band: "standard", price_from: 890, price_unit: "per_person",
          verification_status: "verified", confidence: "high", slug: `slug-${id}`,
          ...over,
        } as any);
      seed("dc-a");
      seed("dc-b");
      seed("dc-solo", { provider_id: provSolo });
      seed("dc-manual", { content_source: "manual" });
      seed("dc-claimed", { provider_id: provClaimed });
      seed("dc-noprov", { provider_id: null });

      // ── dc-r1: structural 400s (function + route). ──────────────────
      {
        assertEq((await opp.applyExperienceDataCorrections(expDb as any, { items: [] }, { dryRun: true })), { ok: false, error: "items must be an array of 1..50 items" }, "dc-r1a: empty items -> error");
        assertTrue(!((await opp.applyExperienceDataCorrections(expDb as any, { items: Array.from({ length: 51 }, () => item("dc-a", "title", "x", "yyy")) }, { dryRun: true })) as any).ok, "dc-r1b: 51 items -> error");
        assertTrue(!((await opp.applyExperienceDataCorrections(expDb as any, { items: ["x"] }, { dryRun: true })) as any).ok, "dc-r1c: non-object item -> error");
        assertTrue(!((await opp.applyExperienceDataCorrections(expDb as any, { items: [{ field: "title" }] }, { dryRun: true })) as any).ok, "dc-r1d: missing id -> error");
        assertTrue(!((await opp.applyExperienceDataCorrections(expDb as any, { items: [item("dc-a", "title", "x", "yyy")], batch_label: 5 }, { dryRun: true })) as any).ok, "dc-r1e: non-string batch_label -> error");
        const r = await post("/admin/experiences-data-corrections", { items: "nope" });
        assertEq(r.status, 400, "dc-r1f: route answers 400 on a structural error");
        const unauth = await callRoute(router, { method: "POST", url: "/admin/experiences-data-corrections", headers: {}, body: { items: [] } });
        assertTrue(unauth.status === 401 || unauth.status === 403, "dc-r1g: no admin key -> 401/403");
      }

      // ── dc-r2: every per-item reject reason; nothing written. ───────
      {
        const before = dumpAll();
        const cases: Array<[string, any[]]> = [
          ["unknown_field", [item("dc-a", "colour", "x", "y")]],
          ["unknown_action", [item("dc-a", "title", "Kajakktur i fjorden", "Ny tittel", { action: "replace" })]],
          ["confidence_not_high", [item("dc-a", "title", "Kajakktur i fjorden", "Ny tittel", { confidence: "medium" })]],
          ["invalid_source_url", [item("dc-a", "price_from", 890, 900, { source_url: "ftp://x.example" })]],
          ["missing_quote", [item("dc-a", "duration", 60, 90, { quote: "  " })]],
          ["invalid_item", [{ id: "dc-a", field: "fylke", action: "correct", new_value: "Oslo", source_url: SRC, quote: QUOTE, confidence: "high" }]],
          ["duplicate_item", [item("dc-b", "kommune", "Bergen", "Voss"), item("dc-b", "kommune", "Bergen", "Askøy")]],
          ["not_found", [item("dc-missing", "title", "x", "Ny tittel")]],
          ["owner_managed", [item("dc-manual", "title", "Kajakktur i fjorden", "Ny tittel")]],
          ["stale_expected_current", [item("dc-a", "title", "Feil tittel", "Ny tittel")]],
          ["invalid_value", [item("dc-a", "season", "sommer", "monsun")]],
          ["no_provider", [item("dc-noprov", "homepage_url", null, "https://ny.example")]],
          ["shared_provider_host_change", [item("dc-a", "homepage_url", "https://delt.example", "https://annen.example/")]],
          ["invalid_value", [item("dc-a", "homepage_url", "https://delt.example", "https://delt.example/side")]],
          ["invalid_value", [item("dc-a", "homepage_url", "https://delt.example", "https://evil.com\\@delt.example/")]],
          ["invalid_value", [item("dc-a", "homepage_url", "https://delt.example", "https://user:pw@delt.example/")]],
          ["invalid_value", [item("dc-a", "homepage_url", "https://delt.example", "https://delt.example:8443/")]],
          ["invalid_item", [item("dc-a", "title", "Kajakktur i fjorden", "x".repeat(501))]],
          ["invalid_item", [item("dc-a", "title", "y".repeat(501), "Ny tittel")]],
          ["invalid_item", [item("dc-a", "title", "Kajakktur i fjorden", "Ny tittel", { quote: "q".repeat(2001) })]],
          ["invalid_item", [item("dc-a", "title", "Kajakktur i fjorden", "Ny tittel", { source_url: "https://k.example/" + "a".repeat(2048) })]],
          ["no_op", [item("dc-a", "price_from", "fra 890 kroner per person", 890)]],
          ["owner_managed", [item("dc-claimed", "homepage_url", "", "https://eid.example")]],
          ["ambiguous_provider", [item("dc-solo", "provider", "Solo Tilbyder AS", "Tvilling AS")]],
          ["invalid_value", [item("dc-a", "fylke", "Vestland", "Viken")]],
          ["invalid_value", [item("dc-a", "kommune", "Bergen", "Atlantis")]],
          ["invalid_value", [clearItem("dc-a", "title", "Kajakktur i fjorden")]],
          ["invalid_value", [item("dc-a", "duration", 60, "0")]],
          ["invalid_value", [item("dc-a", "price_from", 890, -5)]],
          ["invalid_value", [item("dc-a", "title", "Kajakktur i fjorden", "AB")]],
          ["invalid_value", [item("dc-a", "homepage_url", "https://delt.example", "delt.example")]],
          ["no_op", [item("dc-a", "kommune", "Bergen", "bergen")]],
        ];
        for (const [reason, items] of cases) {
          const out = (await apply(items));
          const label = `${reason} (${items[0].field}=${JSON.stringify(items[0].new_value ?? null)})`;
          assertEq(out.results.map((r: any) => [r.result, r.reason]), items.map(() => ["rejected", reason]), `dc-r2a: ${label}`);
          assertEq([out.totals.rejected, out.totals.applied, out.batch_id === null], [items.length, 0, false], `dc-r2b: totals for ${label}`);
        }
        assertEq(dumpAll(), before, "dc-r2d: nothing written when every item is rejected");
        const stale = (await apply([item("dc-a", "title", "Feil tittel", "Ny tittel")]));
        assertTrue(String(stale.results[0].detail).includes("Kajakktur i fjorden"), "dc-r2e: stale detail shows the current value");
        // Mixed request: a reject does not abort the other items.
        seed("dc-mix");
        const mix = (await apply([item("dc-mix", "fylke", "Vestland", "Viken"), item("dc-mix", "price_from", 890, 990)]));
        assertEq(mix.results.map((r: any) => r.result), ["rejected", "applied"], "dc-r2f: per-item reject does not abort the rest");
        assertEq(rowOf("dc-mix").price_from, 990, "dc-r2g: the valid item was written");
      }

      // ── dc-r3: dry run writes nothing, strict-false parse. ──────────
      {
        const before = dumpAll();
        const items = [
          item("dc-a", "kommune", "Bergen, Vestland", "Voss"),
          item("dc-solo", "provider", "Solo Tilbyder AS", "Helt Ny Tilbyder AS (org.nr. 123123123)"),
          item("dc-solo", "homepage_url", null, "https://helt-ny.example/"),
        ];
        const out = (await preview(items));
        assertEq(out.results.map((r: any) => r.result), ["would_apply", "would_apply", "would_apply"], "dc-r3a: dry run evaluates every item");
        assertEq(out.batch_id, null, "dc-r3b: dry run has no batch_id");
        assertTrue(out.results[1].warnings.some((w: any) => w.code === "provider_created"), "dc-r3c: dry run previews provider creation");
        assertEq(dumpAll(), before, "dc-r3d: dry run (function) writes nothing — incl. no provider row, no audit row");
        for (const dry of [undefined, "false", 0, null, "no"]) {
          const r = await post("/admin/experiences-data-corrections", { dry_run: dry, items });
          assertEq([r.status, r.body.dry_run, r.body.totals?.would_apply], [200, true, 3], `dc-r3e: dry_run=${JSON.stringify(dry)} is a dry run`);
        }
        assertEq(dumpAll(), before, "dc-r3f: dry-run route calls wrote nothing");
      }

      // ── dc-r4: write-pause fence on apply only (both routes). ───────
      {
        const mainDb = init.getDb();
        pauseSvc.setEnrichmentWritePause(mainDb as any, { vertical: "experiences", enabled: true, reason: "dc test" }, "verifier");
        const before = dumpAll();
        const a = await post("/admin/experiences-data-corrections", { dry_run: false, items: [item("dc-a", "kommune", "Bergen", "Voss")] });
        assertEq(a.status, 423, "dc-r4a: apply under an experiences pause -> 423");
        const rv = await post("/admin/experiences-data-corrections/revert", { dry_run: false, batch_id: "x" });
        assertEq(rv.status, 423, "dc-r4b: revert apply under the pause -> 423");
        assertEq(dumpAll(), before, "dc-r4c: nothing written while paused");
        const d = await post("/admin/experiences-data-corrections", { items: [item("dc-a", "kommune", "Bergen", "Voss")] });
        assertEq([d.status, d.body.results?.[0]?.result], [200, "would_apply"], "dc-r4d: dry run is not blocked by the pause");
        pauseSvc.setEnrichmentWritePause(mainDb as any, { vertical: "experiences", enabled: false, cleared_by: "daniel" }, "verifier");
      }

      // ── dc-r5: rendered-vs-raw expected_current matching. ───────────
      {
        seed("dc-m1", { season: ["vaar", "sommer", "host"], kommune: "Svolvaer", fylke: "Nordland", price_unit: null, price_from: 120 });
        expDb.prepare("UPDATE experiences SET title_no = ? WHERE id = ?").run("Kajakktur på norsk", "dc-m1");
        const out = (await preview([
          item("dc-m1", "kommune", "Svolvaer, Nordland", "Vågan"),          // rendered "Sted"
          item("dc-m1", "fylke", "NORDLAND", "Troms"),                     // raw, case-folded
          item("dc-m1", "season", "vaar, sommer, host", "hele året"),     // raw codes as text
          item("dc-m1", "duration", "omtrent 60 minutter", 90),            // rendered
          item("dc-m1", "price_from", "fra 120 kroner", 150),              // rendered (no unit)
          item("dc-m1", "title", "Kajakktur på norsk", "Kajakktur i Vågan"), // title_no
          item("dc-m1", "provider", "Delt Tilbyder AS", "Øvrig Turselskap AS"),
        ]));
        assertEq(out.results.map((r: any) => r.result), Array(7).fill("would_apply"), "dc-r5a: rendered/raw/case/slash forms all match");
        const out2 = (await preview([
          item("dc-a", "season", "sommer", "vinter"),                       // rendered label
          item("dc-a", "duration", "60", 90),                               // raw
          item("dc-a", "price_from", "fra 890 kroner per person", 990),     // rendered with unit
          item("dc-a", "price_from", "890", 990, { id: "dc-b" }),           // raw
          item("dc-a", "provider", "Delt Tilbyder AS (verifisert mot Brønnøysundregistrene)", "Øvrig Turselskap AS"),
        ]));
        assertEq(out2.results.map((r: any) => r.result), Array(5).fill("would_apply"), "dc-r5b: more rendered/raw forms match");
        seed("dc-m2", { season: ["spring", "autumn"] });
        assertEq((await preview([item("dc-m2", "season", "høst, vår", "sommer")])).results[0].result, "would_apply", "dc-r5c: season expected is order-insensitive + spelling-equivalent");
        assertEq((await preview([item("dc-m2", "season", "høst", "sommer")])).results[0].reason, "stale_expected_current", "dc-r5d: a season SUBSET is stale");
        assertEq((await preview([item("dc-noprov", "kommune", "null", "Voss")])).results[0].reason, "stale_expected_current", "dc-r5e: 'null' does not match a non-empty kommune");
        seed("dc-m3", { kommune: null, price_from: null, duration_min: null, duration_max: null, season: [] });
        const out3 = (await preview([
          item("dc-m3", "kommune", "", "Luster"),
          item("dc-m3", "price_from", null, 795),
          item("dc-m3", "duration", "null", "omtrent 120 minutter"),
          item("dc-m3", "season", "", "sommer"),
        ]));
        assertEq(out3.results.map((r: any) => r.result), Array(4).fill("would_apply"), "dc-r5f: ''/null/'null' all match an empty field");
      }

      // ── dc-r6: apply — season mapping, duration, price, title, kommune. ─
      let firstBatch = "";
      let evBefore: Record<string, unknown> = {};
      {
        seed("dc-w1", { description: "En fin tur i Bergen for 890 kroner med Delt Tilbyder AS." });
        expDb.prepare("UPDATE experiences SET title_no = ? WHERE id = ?").run("Kajakktur (no)", "dc-w1");
        const fpBefore = fpOf("dc-w1");
        evBefore = JSON.parse(rowOf("dc-w1").content_field_evidence || "{}");
        const out = (await apply([
          item("dc-w1", "season", "sommer", "vår, sommer, høst, vinter"),
          item("dc-w1", "duration", "omtrent 60 minutter", "omtrent 120 minutter"),
          item("dc-w1", "price_from", 890, "1 700"),
          item("dc-w1", "title", "Kajakktur i fjorden", "  Kajakktur  i Hardangerfjorden "),
          item("dc-w1", "kommune", "Bergen", "Sandefjord"),
        ], { batch_label: "test-batch" }));
        firstBatch = out.batch_id;
        assertTrue(typeof out.batch_id === "string" && out.batch_id.startsWith("data-corrections-"), "dc-r6a: apply returns a batch_id");
        assertEq(out.batch_label, "test-batch", "dc-r6b: batch_label echoed");
        assertEq(out.results.map((r: any) => r.result), Array(5).fill("applied"), "dc-r6c: all applied");
        const row = rowOf("dc-w1");
        assertEq(row.season, JSON.stringify(["year_round"]), "dc-r6d: all four seasons stored as [\"year_round\"] (page shows Hele året)");
        assertEq([row.duration_min, row.duration_max], [120, 120], "dc-r6e: duration_min = duration_max = 120");
        assertEq(row.price_from, 1700, "dc-r6f: price_from 1700");
        assertEq(row.price_band, "standard", "dc-r6g: price_band untouched");
        assertEq(row.title, "Kajakktur i Hardangerfjorden", "dc-r6h: title trimmed + whitespace-collapsed");
        assertEq(row.title_no, null, "dc-r6i: stale title_no cleared");
        assertEq(row.slug, "slug-dc-w1", "dc-r6j: slug unchanged");
        assertEq(row.kommune, "Sandefjord", "dc-r6k: kommune");
        assertEq(row.fylke, "Vestland", "dc-r6l: fylke NOT auto-changed");
        const kw = out.results[4].warnings;
        assertTrue(kw.some((w: any) => w.code === "fylke_mismatch" && w.implied_fylke === "Vestfold"), "dc-r6m: fylke_mismatch warning with implied fylke");
        assertTrue(kw.some((w: any) => w.code === "description_mentions_old_value" && w.old_value === "Bergen"), "dc-r6n: description mentions old kommune");
        assertTrue(out.results[2].warnings.some((w: any) => w.code === "description_mentions_old_value" && w.old_value === "890"), "dc-r6o: description mentions old price");
        assertTrue(out.results[3].warnings.some((w: any) => w.code === "title_no_cleared"), "dc-r6p: title_no_cleared warning");
        const ev = JSON.parse(row.content_field_evidence);
        assertEq([ev.season, ev.duration_min, ev.duration_max, ev.price_from, ev.title, ev.kommune], Array(6).fill(SRC), "dc-r6q: content_field_evidence records source_url per corrected column");
        assertTrue(fpOf("dc-w1") !== fpBefore, "dc-r6r: facts fingerprint changed after the correction");
        const audits = expDb.prepare("SELECT * FROM experience_data_corrections WHERE batch_id = ? ORDER BY rowid").all(out.batch_id) as any[];
        assertEq(audits.length, 5, "dc-r6s: one audit row per applied item");
        assertEq(audits.map((a) => a.id), out.results.map((r: any) => r.correction_id), "dc-r6t: audit ids = correction_ids in the response");
        const durChanges = JSON.parse(audits[1].column_changes);
        assertTrue(durChanges.some((c: any) => c.column === "duration_min" && c.old === 60 && c.new === 120), "dc-r6u: column_changes carries old/new per column");
        assertEq([audits[0].source_url, audits[0].quote, audits[0].confidence, audits[0].batch_label], [SRC, QUOTE, "high", "test-batch"], "dc-r6v: audit provenance columns");
        assertEq(out.totals.applied, 5, "dc-r6w: totals.applied");
      }

      // ── dc-r7: duration / price clear; fylke together with kommune. ─
      {
        seed("dc-w2", { fylke: "Vestfold og Telemark", kommune: "Stokke" });
        const out = (await apply([
          item("dc-w2", "kommune", "Stokke", "Sandefjord"),
          item("dc-w2", "fylke", "Vestfold og Telemark", "Vestfold"),
          clearItem("dc-w2", "duration", "omtrent 60 minutter"),
          clearItem("dc-w2", "price_from", "fra 890 kroner per person"),
        ]));
        assertEq(out.results.map((r: any) => r.result), Array(4).fill("applied"), "dc-r7a: applied");
        assertTrue(!out.results[0].warnings.some((w: any) => w.code === "fylke_mismatch"), "dc-r7b: no fylke_mismatch when the same request corrects fylke");
        const row = rowOf("dc-w2");
        assertEq([row.kommune, row.fylke, row.duration_min, row.duration_max, row.price_from], ["Sandefjord", "Vestfold", null, null, null], "dc-r7c: values written / cleared");
        assertEq((await preview([clearItem("dc-w2", "price_from", "")])).results[0].reason, "no_op", "dc-r7d: clearing an empty price is no_op");
        seed("dc-w3", { fylke: "Møre og Romsdal", kommune: "Ulstein" });
        const h = (await apply([item("dc-w3", "kommune", "Ulstein", "Herøy")]));
        assertEq([h.results[0].result, rowOf("dc-w3").kommune, h.results[0].warnings.length], ["applied", "Herøy", 0], "dc-r7e: Herøy disambiguated by the row's fylke, no mismatch");
      }

      // ── dc-r8: homepage_url — shared provider rules, verification reset. ─
      {
        assertEq((await preview([item("dc-m1", "homepage_url", "https://delt.example/", "https://www.delt.example/")])).results[0].result, "would_apply",
          "dc-r8-0: same-host root fix on a shared provider is allowed (expected matched modulo trailing slash)");
        const blocked = await apply([item("dc-a", "homepage_url", "https://delt.example", "https://www.delt-ny.example/")]);
        assertEq(blocked.results[0].reason, "shared_provider_host_change", "dc-r8-1: host change on a shared provider needs allow_shared_provider");
        const otherCount = (expDb.prepare("SELECT COUNT(*) AS n FROM experiences WHERE provider_id = ? AND id != 'dc-a'").get(provShared) as any).n;
        const out = (await apply([item("dc-a", "homepage_url", "https://delt.example", "https://www.delt-ny.example/", { allow_shared_provider: true })]));
        assertEq(out.results[0].result, "applied", "dc-r8a: host change on a shared provider applies with allow_shared_provider");
        const w = out.results[0].warnings.find((x: any) => x.code === "shared_provider_root_url");
        assertEq(w && w.other_experiences, otherCount, "dc-r8b: warning lists the count of other affected experiences");
        assertTrue(out.results[0].warnings.some((x: any) => x.code === "hjemmeside_verification_reset"), "dc-r8c: host changed -> verification reset");
        const p = provOf(provShared);
        assertEq(p.hjemmeside, "https://www.delt-ny.example/", "dc-r8d: provider hjemmeside written");
        const fp = JSON.parse(p.field_provenance);
        assertEq([fp.hjemmeside?.source_url, fp.hjemmeside_verification], [SRC, undefined], "dc-r8e: field_provenance.hjemmeside set, verification removed");
        // Unshared provider, deep URL on the same host -> applies, keeps verification.
        const fpSoloBefore = fpOf("dc-solo");
        assertEq((await preview([item("dc-solo", "homepage_url", "https://solo.example/en/", "https://solo.example/opplevelser/kajakk")])).results[0].reason, "invalid_value", "dc-r8f0: a non-root homepage_url is invalid_value");
        const o2 = (await apply([item("dc-solo", "homepage_url", "https://solo.example/en/", "https://solo.example/")]));
        assertEq(o2.results[0].result, "applied", "dc-r8f: root fix on an unshared provider applies");
        assertTrue(!o2.results[0].warnings.some((x: any) => x.code === "hjemmeside_verification_reset"), "dc-r8g: same host -> verification kept");
        assertTrue(JSON.parse(provOf(provSolo).field_provenance).hjemmeside_verification?.verified === true, "dc-r8h: verification still present");
        assertTrue(fpOf("dc-solo") !== fpSoloBefore, "dc-r8i: provider homepage change moves the facts fingerprint");
        assertEq((await preview([item("dc-solo", "homepage_url", "https://solo.example/", "https://SOLO.example")])).results[0].reason, "no_op", "dc-r8j: same URL modulo case/slash -> no_op");
      }

      // ── dc-r9: provider — relink existing by name / org.nr., create new. ─
      {
        seed("dc-p1");
        seed("dc-p2");
        seed("dc-p3");
        seed("dc-p4", { description: "Arrangeres av Delt Tilbyder AS." });
        const out = (await apply([
          item("dc-p1", "provider", "Delt Tilbyder AS", "øvrig turselskap as"),
          item("dc-p2", "provider", "Delt Tilbyder AS", "Øvrig Turselskap (org.nr. 911222333)"),
          item("dc-p3", "provider", "Delt Tilbyder AS", "Skiforeningen (Skimuseet Holmenkollen), org.nr. 946175986"),
          item("dc-p4", "provider", "Delt Tilbyder AS", "Norsk Maritimt Museum (org.nr. 976912450)"),
          item("dc-p4", "homepage_url", "", "https://marmuseum.no"),
        ]));
        assertEq(out.results.map((r: any) => r.result), Array(5).fill("applied"), "dc-r9a: all applied");
        assertEq(rowOf("dc-p1").provider_id, provOther, "dc-r9b: exact case-insensitive name -> existing provider");
        assertEq(rowOf("dc-p2").provider_id, provOther, "dc-r9c: org.nr. wins over the name");
        assertEq(provOf(provOther).navn, "Øvrig Turselskap AS", "dc-r9d: the existing provider is not renamed");
        const p3 = provOf(rowOf("dc-p3").provider_id);
        assertEq([p3.navn, p3.org_nr, p3.source, p3.hjemmeside, p3.brreg_verified, p3.brreg_active, p3.naeringskode, p3.adresse, p3.postnummer, p3.poststed],
          ["Skiforeningen (Skimuseet Holmenkollen)", "946175986", "data_correction", null, 1, 1, "93.120", "Kongeveien 5", "0787", "OSLO"], "dc-r9e: new provider row: request name, verified Brreg fields");
        assertEq(JSON.parse(p3.field_provenance).navn.brreg_name, "SKIFORENINGEN", "dc-r9e3: Brreg's name kept in field_provenance");
        assertTrue(typeof p3.brreg_checked_at === "string" && p3.brreg_checked_at.length > 0, "dc-r9e2: brreg_checked_at stamped");
        assertEq(JSON.parse(p3.field_provenance).created_by.source, "data_correction", "dc-r9f: provenance marks data_correction");
        assertEq(rowOf("dc-p3").provider_match_status, "matched", "dc-r9g: provider_match_status = matched");
        const p4prov = rowOf("dc-p4").provider_id;
        assertTrue(p4prov !== provShared, "dc-r9h: dc-p4 relinked");
        assertEq(provOf(p4prov).hjemmeside, "https://marmuseum.no", "dc-r9i: homepage item in the same request lands on the NEW provider");
        assertEq(provOf(provShared).hjemmeside, "https://www.delt-ny.example/", "dc-r9j: the old shared provider's homepage is untouched");
        assertTrue(!out.results[3].warnings.some((w: any) => w.code === "unpublished_after_correction"), "dc-r9k: a Brreg-verified new provider keeps the row published");
        assertEq(Number((expDb.prepare(`SELECT (${expStore.PUBLISH_GATE_SQL}) AS pub FROM experiences e LEFT JOIN experience_providers p ON p.id = e.provider_id WHERE e.id = 'dc-p4'`).get() as any).pub), 1, "dc-r9k2: dc-p4 still passes PUBLISH_GATE_SQL");
        assertTrue(!brregRequests.some((u) => u.includes("911222333")), "dc-r9k3: an existing provider's org_nr match makes no Brreg call");
        assertTrue(out.results[3].warnings.some((w: any) => w.code === "description_mentions_old_value"), "dc-r9l: description mentions old provider name");
        const ins = JSON.parse((expDb.prepare("SELECT column_changes FROM experience_data_corrections WHERE id = ?").get(out.results[2].correction_id) as any).column_changes);
        assertTrue(ins.some((c: any) => c.op === "insert" && c.table === "experience_providers"), "dc-r9m: audit records the created provider");
        assertEq((await preview([item("dc-p1", "provider", "Øvrig Turselskap AS", "Øvrig Turselskap AS")])).results[0].reason, "no_op", "dc-r9n: relink to the current provider is no_op");
        const claimedRelink = (await preview([item("dc-claimed", "provider", "Eid Tilbyder AS", "Øvrig Turselskap AS")]));
        assertEq(claimedRelink.results[0].reason, "owner_managed", "dc-r9o: moving a row away from a claimed provider -> owner_managed");
      }

      // ── dc-r10: fingerprint change re-enters the description queue. ──
      {
        seed("dc-q1", { description: null });
        const fp0 = fpOf("dc-q1");
        expDb.prepare(
          "INSERT INTO experience_description_attempts (experience_id, attempted_at, outcome, reason, facts_fingerprint) VALUES (?, datetime('now'), 'judge_rejected', 'x', ?)",
        ).run("dc-q1", fp0);
        const inQueue = () => opp.selectExperienceDescriptionQueue(expDb as any, null).eligibleRows.some((r: any) => r.id === "dc-q1");
        assertEq(inQueue(), false, "dc-r10a: recently attempted row is held back by the cooldown");
        (await apply([item("dc-q1", "kommune", "Bergen", "Voss")]));
        assertTrue(fpOf("dc-q1") !== fp0, "dc-r10b: fingerprint changed");
        assertEq(inQueue(), true, "dc-r10c: the corrected row re-enters the description queue");
      }

      // ── dc-r11: revert. ─────────────────────────────────────────────
      {
        // Dry-run revert writes nothing.
        const before = dumpAll();
        const dry = revert({ batch_id: firstBatch }, true);
        assertEq(dry.totals.would_revert, 5, "dc-r11a: dry-run revert previews 5");
        assertEq(dumpAll(), before, "dc-r11b: dry-run revert writes nothing");
        // Change one column by hand -> that correction is changed_since.
        expDb.prepare("UPDATE experiences SET price_from = 1800 WHERE id = 'dc-w1'").run();
        const r = revert({ batch_id: firstBatch });
        const byField: Record<string, any> = {};
        for (const x of r.results) byField[x.field] = x;
        assertEq(byField.price_from.reason, "changed_since", "dc-r11c: hand-edited price -> changed_since");
        assertEq(["season", "duration", "title", "kommune"].map((f) => byField[f].result), Array(4).fill("reverted"), "dc-r11d: other corrections reverted");
        assertEq(r.results.map((x: any) => x.field), ["kommune", "title", "price_from", "duration", "season"], "dc-r11e: reverse order of application");
        const row = rowOf("dc-w1");
        assertEq([row.season, row.duration_min, row.duration_max, row.title, row.title_no, row.kommune, row.price_from],
          [JSON.stringify(["summer"]), 60, 60, "Kajakktur i fjorden", "Kajakktur (no)", "Bergen", 1800], "dc-r11f: old values restored (hand edit kept)");
        const ev = JSON.parse(row.content_field_evidence);
        assertEq([ev.season, ev.duration_min, ev.title, ev.kommune, ev.price_from], [evBefore.season, evBefore.duration_min, undefined, undefined, SRC], "dc-r11g: evidence keys restored for reverted fields only");
        const aud = expDb.prepare("SELECT reverted_at, revert_batch_id, field FROM experience_data_corrections WHERE batch_id = ?").all(firstBatch) as any[];
        assertEq(aud.filter((a) => a.reverted_at).length, 4, "dc-r11h: reverted_at stamped on 4 rows");
        assertTrue(aud.filter((a) => a.reverted_at).every((a) => a.revert_batch_id === r.revert_batch_id), "dc-r11i: revert_batch_id recorded");
        const again = revert({ batch_id: firstBatch });
        assertEq(again.results.filter((x: any) => x.reason === "already_reverted").length, 4, "dc-r11j: second revert -> already_reverted");
        const nf = revert({ correction_ids: ["nope"] });
        assertEq(nf.results[0].reason, "not_found", "dc-r11k: unknown correction id -> not_found");
        assertTrue(!(revert({}) as any).ok, "dc-r11l: neither batch_id nor correction_ids -> error");
        // Revert of the provider batch deletes the created providers and restores links + homepage.
        const provBatch = (expDb.prepare("SELECT batch_id FROM experience_data_corrections WHERE experience_id = 'dc-p3'").get() as any).batch_id;
        const createdP3 = rowOf("dc-p3").provider_id;
        const createdP4 = rowOf("dc-p4").provider_id;
        const rp = revert({ batch_id: provBatch });
        assertEq(rp.totals.reverted, 5, "dc-r11m: provider batch reverted");
        assertEq(["dc-p1", "dc-p2", "dc-p3", "dc-p4"].map((id) => rowOf(id).provider_id), Array(4).fill(provShared), "dc-r11n: provider links restored");
        assertEq([provOf(createdP3), provOf(createdP4)], [undefined, undefined], "dc-r11o: created providers deleted");
        assertTrue(rp.results.some((x: any) => x.warnings.some((w: any) => w.code === "created_provider_deleted")), "dc-r11p: created_provider_deleted warning");
        // Route form.
        const rr = await post("/admin/experiences-data-corrections/revert", { dry_run: false, correction_ids: ["nope"] });
        assertEq([rr.status, rr.body.results?.[0]?.reason], [200, "not_found"], "dc-r11q: revert route");
        const bad = await post("/admin/experiences-data-corrections/revert", { dry_run: false });
        assertEq(bad.status, 400, "dc-r11r: revert route 400 without selector");
      }

      // ── dc-r12: route apply end-to-end. ─────────────────────────────
      {
        seed("dc-route");
        const r = await post("/admin/experiences-data-corrections", { dry_run: false, items: [item("dc-route", "fylke", "Vestland", "Rogaland")] });
        assertEq([r.status, r.body.success, r.body.dry_run, r.body.results?.[0]?.result, rowOf("dc-route").fylke], [200, true, false, "applied", "Rogaland"], "dc-r12a: route apply writes");
        assertTrue(typeof r.body.batch_id === "string" && !("ok" in r.body), "dc-r12b: response has batch_id, no internal ok flag");
      }

      // ── dc-r13: real-shaped rows modelled on the 2026-10-07 CSV. ────
      {
        const csvProv = expStore.createProvider({ navn: "Fjord Tours / Norled", brreg_verified: 1, brreg_active: 1 } as any);
        const go2 = expStore.createProvider({ navn: "Go2Lofoten AS", brreg_verified: 1, brreg_active: 1 } as any);
        seed("csv-sunnmor", { title: "Sunnmørsbadet — Aquatic & Wellness Centre in Ulsteinvik", kommune: "Ulstein", fylke: "Møre og Romsdal", season: ["vaar", "host"], provider_id: csvProv });
        seed("csv-go2", { title: "RIB Sea Eagle Safari to Trollfjord — Go2Lofoten", kommune: "Svolvaer", fylke: "Nordland", season: ["vaar", "sommer", "host"], duration_min: null, duration_max: null, price_from: null, price_unit: null, provider_id: go2 });
        seed("csv-stokke", { kommune: "Stokke", fylke: "Vestfold og Telemark" });
        seed("csv-fjord", { price_from: 1991, price_unit: null, duration_min: 60, duration_max: 60, provider_id: csvProv });
        seed("csv-dur", { duration_min: 5, duration_max: 5 });
        const csvItem = (id: string, felt: string, naa: string, foreslaatt: string, handling = "correct") =>
          handling === "clear" ? clearItem(id, felt, naa) : item(id, felt, naa, foreslaatt);
        const out = (await preview([
          csvItem("csv-sunnmor", "kommune", "Ulstein", "Herøy"),
          csvItem("csv-sunnmor", "title", "Sunnmørsbadet — Aquatic & Wellness Centre in Ulsteinvik", "Sunnmørsbadet — Aquatic & Wellness Centre in Fosnavåg"),
          csvItem("csv-sunnmor", "season", "vår, høst", "vår, sommer, høst, vinter"),
          csvItem("csv-go2", "kommune", "Svolvaer, Nordland", "Vågan (Svolvær), Nordland"),
          csvItem("csv-go2", "season", "vaar, sommer, host", "hele året"),
          csvItem("csv-go2", "homepage_url", "", "https://www.go2lofoten.no/"),
          csvItem("csv-go2", "duration", "", "omtrent 120 minutter"),
          csvItem("csv-go2", "price_from", "", "795"),
          csvItem("csv-stokke", "fylke", "Vestfold og Telemark", "Vestfold"),
          csvItem("csv-stokke", "kommune", "Stokke", "Sandefjord"),
          csvItem("csv-fjord", "price_from", "1991", "2698"),
          csvItem("csv-fjord", "provider", "Fjord Tours / Norled", "Fjord Tours AS (org.nr. 931735357)"),
          csvItem("csv-fjord", "duration", "60", "", "clear"),
          csvItem("csv-dur", "duration", "omtrent 5 minutter", "", "clear"),
        ]));
        assertEq(out.results.map((r: any) => `${r.id}.${r.field}=${r.result}${r.reason ? ":" + r.reason + ":" + r.detail : ""}`),
          out.results.map((r: any) => `${r.id}.${r.field}=would_apply`), "dc-r13a: every CSV-shaped item would apply");
        assertTrue(out.results[0].warnings.length === 0, "dc-r13b: Herøy in Møre og Romsdal — no fylke_mismatch");
        assertEq(out.results[3].column_changes.find((c: any) => c.column === "kommune")?.new, "Vågan", "dc-r13c: 'Vågan (Svolvær), Nordland' stored as Vågan");
        assertEq(out.results[4].column_changes.find((c: any) => c.column === "season")?.new, JSON.stringify(["year_round"]), "dc-r13d: hele året -> [\"year_round\"]");
      }

      // ── dc-r15: Brreg gate for new providers + never-unpublish. ─────
      {
        const provOf2 = (id: string) => rowOf(id).provider_id;
        for (const id of ["dc-g1", "dc-g2", "dc-g3", "dc-g4", "dc-g5", "dc-g6", "dc-g7", "dc-g8"]) seed(id);
        const before = dumpAll();
        const cases: Array<[string, string, string]> = [
          ["dc-g1", "Ukjent Opplevelse AS", "provider_needs_orgnr"],
          ["dc-g2", "Finnes Ikke AS (org.nr. 111222333)", "provider_unverified"],
          ["dc-g3", "Konkurs Turer AS (org.nr. 222333444)", "provider_unverified"],
          ["dc-g4", "Slettet Turer AS (org.nr. 333444555)", "provider_unverified"],
          ["dc-g5", "Avvikling Turer AS (org.nr. 444555666)", "provider_unverified"],
          ["dc-g6", "Fjelltur Bergen AS (org.nr. 555666777)", "provider_unverified"],
        ];
        for (const [id, nv, reason] of cases) {
          const out = await apply([item(id, "provider", "Delt Tilbyder AS", nv)]);
          assertEq([out.results[0].result, out.results[0].reason], ["rejected", reason], `dc-r15a: ${nv} -> ${reason}`);
        }
        assertEq(dumpAll(), before, "dc-r15b: no provider row and no link written for any rejected provider item");
        // IKS is ignored in the name comparison.
        const iks = await apply([item("dc-g7", "provider", "Delt Tilbyder AS", "Aust-Agder museum og arkiv IKS (org.nr. 666777888)")]);
        assertEq(iks.results[0].result, "applied", "dc-r15c: IKS name matches Brreg (legal form ignored)");
        assertEq(provOf(provOf2("dc-g7")).navn, "Aust-Agder museum og arkiv IKS", "dc-r15d: display name = request name (org.nr. stripped)");
        assertTrue(opp.expDcBrregNameMatches("Fjord Tours AS", "FJORD TOURS AS") && !opp.expDcBrregNameMatches("Fjelltur AS", "HELT ANNET SELSKAP AS"),
          "dc-r15e: name-overlap helper");
        // Existing org_nr match wins with no Brreg request.
        const nBefore = brregRequests.length;
        const ex = await apply([item("dc-g8", "provider", "Delt Tilbyder AS", "Solo Tilbyder (org.nr. 999888777)")]);
        assertEq([ex.results[0].result, provOf2("dc-g8"), brregRequests.length - nBefore], ["applied", provSolo, 0], "dc-r15f: existing org_nr -> relink, zero Brreg calls");

        // never-unpublish: relink a published row to an existing provider
        // that is not brreg_active=1 -> would_unpublish, item rolled back,
        // the other item in the same request still applies.
        const provInactive = expStore.createProvider({ navn: "Inaktiv Tilbyder AS", brreg_verified: 1, brreg_active: 0 } as any);
        seed("dc-u1");
        const u = await apply([
          item("dc-u1", "price_from", 890, 990),
          item("dc-u1", "provider", "Delt Tilbyder AS", "Inaktiv Tilbyder AS"),
        ]);
        assertEq(u.results.map((r: any) => [r.result, r.reason ?? null]), [["applied", null], ["rejected", "would_unpublish"]], "dc-r15g: would_unpublish rejects only that item");
        assertTrue(String(u.results[1].detail).includes("brreg_active=0"), "dc-r15h: detail names the failing gate input");
        assertEq([rowOf("dc-u1").provider_id, rowOf("dc-u1").price_from], [provShared, 990], "dc-r15i: provider link untouched, price written");
        assertEq((expDb.prepare("SELECT COUNT(*) AS n FROM experience_data_corrections WHERE experience_id = 'dc-u1'").get() as any).n, 1, "dc-r15j: no audit row for the rolled-back item");
        const ud = await preview([item("dc-u1", "provider", "Delt Tilbyder AS", "Inaktiv Tilbyder AS")]);
        assertEq(ud.results[0].reason, "would_unpublish", "dc-r15k: dry run reports would_unpublish too");
        // An already-unpublished row may move; becoming published is a warning.
        seed("dc-u2", { provider_id: provInactive });
        const up = await apply([item("dc-u2", "provider", "Inaktiv Tilbyder AS", "Øvrig Turselskap AS")]);
        assertEq(up.results[0].result, "applied", "dc-r15l: unpublished row may be relinked");
        assertTrue(up.results[0].warnings.some((w: any) => w.code === "published_after_correction"), "dc-r15m: published_after_correction warning");
        // Route uses the Brreg seam from app settings.
        seed("dc-u3");
        const rr = await post("/admin/experiences-data-corrections", { dry_run: false, items: [item("dc-u3", "provider", "Delt Tilbyder AS", "Fjord Tours AS (org.nr. 931735357)")] });
        assertEq([rr.status, rr.body.results?.[0]?.result], [200, "applied"], "dc-r15n: route verifies via the Brreg seam");
        assertTrue(brregRequests.every((x) => x.startsWith("https://data.brreg.no/")), "dc-r15o: the Brreg seam only ever saw data.brreg.no");
      }

      // ── dc-r16: source_page_url — field validation + kildetro wiring. ─
      {
        const verified = JSON.stringify({ hjemmeside_verification: { verified: true, classification: "verified" } });
        const provKt = expStore.createProvider({ navn: "Kildetur Fjord AS", brreg_verified: 1, brreg_active: 1, hjemmeside: "https://www.kilde-tur.example" } as any);
        expDb.prepare("UPDATE experience_providers SET field_provenance = ? WHERE id = ?").run(verified, provKt);
        const PAGE = "https://kilde-tur.example/opplevelser/kajakk";
        seed("dc-k1", { provider_id: provKt, description: null });
        seed("dc-k2", { provider_id: provKt, description: null });
        seed("dc-k3", { provider_id: provKt, description: null });
        seed("dc-k4", { provider_id: provKt, description: null });
        const sp = (id: string, expected: unknown, nv: unknown) => item(id, "source_page_url", expected, nv);

        // Validation.
        const v = async (it: any) => { const o = await preview([it]); return [o.results[0].result, o.results[0].reason ?? null]; };
        assertEq(await v(sp("dc-k1", "", "https://kilde-tur.example/")), ["rejected", "invalid_value"], "dc-r16a: root path -> invalid_value");
        assertEq(await v(sp("dc-k1", "", "https://annen-tur.example/opplevelser/kajakk")), ["rejected", "invalid_value"], "dc-r16b: other host -> invalid_value");
        assertEq(await v(sp("dc-k1", "", "ftp://kilde-tur.example/x")), ["rejected", "invalid_value"], "dc-r16c: non-http(s) -> invalid_value");
        assertEq(await v(sp("dc-noprov", "", PAGE)), ["rejected", "no_provider"], "dc-r16d: no provider -> no_provider");
        seed("dc-k-nohj", { provider_id: provOther });
        assertEq(await v(sp("dc-k-nohj", "", "https://x.example/side")), ["rejected", "invalid_value"], "dc-r16e: provider without hjemmeside -> invalid_value");
        assertEq(await v(sp("dc-k1", "https://feil.example/x", PAGE)), ["rejected", "stale_expected_current"], "dc-r16f: expected_current is the raw column (empty)");
        assertEq(await v(sp("dc-k1", null, PAGE)), ["would_apply", null], "dc-r16g: www-insensitive host, shared provider allowed");

        // Fingerprint: rows without source_page_url keep the exact pre-change
        // material; setting it changes the fingerprint.
        const rowJoin = (id: string): any => expDb.prepare(
          `SELECT e.*, p.navn AS provider_navn, p.brreg_verified AS provider_brreg_verified,
                  p.field_provenance AS provider_field_provenance, p.hjemmeside AS provider_hjemmeside
             FROM experiences e LEFT JOIN experience_providers p ON p.id = e.provider_id WHERE e.id = ?`).get(id);
        const legacyFp = (r: any) => createHash("sha256").update(JSON.stringify([
          opp.renderExperienceDescriptionFactsBlock(r, opp.buildExperienceDescriptionFacts(r)),
          r.provider_hjemmeside ?? "", r.provider_field_provenance ?? "",
        ]), "utf8").digest("hex");
        for (const id of ["dc-k1", "dc-k2", "dc-a", "dc-noprov"]) {
          assertEq(opp.experienceDescriptionFactsFingerprint(rowJoin(id)), legacyFp(rowJoin(id)), `dc-r16h: ${id} without source_page_url keeps a byte-identical fingerprint`);
        }

        // Cooldown re-entry.
        const fpK1 = opp.experienceDescriptionFactsFingerprint(rowJoin("dc-k1"));
        expDb.prepare("INSERT INTO experience_description_attempts (experience_id, attempted_at, outcome, reason, facts_fingerprint) VALUES (?, datetime('now'), 'generation_failed', 'kildetro:sentinel', ?)")
          .run("dc-k1", fpK1);
        const queued = (id: string) => opp.selectExperienceDescriptionQueue(expDb as any, null).eligibleRows.some((r: any) => r.id === id);
        assertEq(queued("dc-k1"), false, "dc-r16i: dc-k1 held back by the cooldown");
        const applied = await apply([sp("dc-k1", "", PAGE), sp("dc-k3", "", PAGE)]);
        assertEq(applied.results.map((r: any) => r.result), ["applied", "applied"], "dc-r16j: source_page_url applied");
        assertEq(rowOf("dc-k1").source_page_url, PAGE, "dc-r16k: column written");
        assertEq(JSON.parse(rowOf("dc-k1").content_field_evidence).source_page_url, SRC, "dc-r16l: evidence recorded");
        assertTrue(opp.experienceDescriptionFactsFingerprint(rowJoin("dc-k1")) !== fpK1, "dc-r16m: fingerprint changed for the row with source_page_url");
        assertEq(queued("dc-k1"), true, "dc-r16n: the row re-enters the queue after source_page_url is set");
        assertEq(opp.experienceKildetroSourceUrl(rowJoin("dc-k1")), PAGE, "dc-r16o: kildetro source = product page");
        assertEq(opp.experienceKildetroSourceUrl(rowJoin("dc-k2")), "https://www.kilde-tur.example", "dc-r16p: no source_page_url -> hjemmeside");
        // Host mismatch (e.g. the provider homepage later moved) -> fallback.
        expDb.prepare("UPDATE experiences SET source_page_url = ? WHERE id = 'dc-k4'").run("https://annen-tur.example/opplevelser/kajakk");
        assertEq(opp.experienceKildetroSourceUrl(rowJoin("dc-k4")), "https://www.kilde-tur.example", "dc-r16q: different host -> falls back to hjemmeside");

        // Candidates + description-write through the routes.
        expDb.prepare("UPDATE experiences SET description = ? WHERE id NOT IN ('dc-k1','dc-k2','dc-k3','dc-k4')")
          .run("En rolig og fin tur langs kysten sammen med erfarne lokale guider som kjenner området godt.");
        const fetched: string[] = [];
        const PAGE_HTML = "<html><body><p>Kajakktur i fjorden: rolig padling for hele familien med guide fra brygga.</p></body></html>";
        const ROOT_HTML = "<html><body><p>Kildetur Fjord tilbyr kajakktur og mange andre turer langs kysten.</p></body></html>";
        const hpStub = (async (url: any) => {
          if (String(url).includes("api.anthropic.com")) { anthropicRequests++; throw new Error("LLM via homepage seam"); }
          fetched.push(String(url));
          const u = new URL(String(url));
          const html = (u.pathname === "/opplevelser/kajakk" || u.pathname === "/opplevelser/flyttet") ? PAGE_HTML : (u.pathname === "/" || u.pathname === "") ? ROOT_HTML : null;
          if (!html) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } } as unknown as Response;
          const bytes = new TextEncoder().encode(html);
          // /opplevelser/flyttet "redirects" to another host.
          const finalUrl = u.pathname === "/opplevelser/flyttet" ? "https://annen-tur.example/landing" : String(url);
          return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer, url: finalUrl,
            headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) } } as unknown as Response;
        }) as unknown as typeof fetch;
        ROUTE_APP_SETTINGS["experienceDescriptionHomepageFetchImpl"] = hpStub;
        const cand = await callRoute(router, { method: "GET", url: "/admin/experiences-description-candidates", headers: auth, query: { limit: "50" } });
        const ci = (id: string) => (cand.body.items as any[]).find((x) => x.id === id);
        assertEq([ci("dc-k1")?.level, ci("dc-k1")?.homepage_url], ["kildetro", PAGE], "dc-r16r: candidates homepage_url = the product page that will be fetched");
        assertEq(ci("dc-k2")?.homepage_url, "https://www.kilde-tur.example", "dc-r16s: candidates homepage_url = root when unset");
        assertEq(ci("dc-k4")?.homepage_url, "https://www.kilde-tur.example", "dc-r16t: candidates homepage_url = root when hosts differ");
        const KT = "Vi tilbyr en kajakktur i rolig sjø for både nybegynnere og erfarne padlere, og turen starter ved brygga rett ved sjøen der guiden ønsker alle velkommen.";
        const KT_TEXT = [KT, KT, KT].join(" ");
        const wItem = (id: string, homepage_url: string) => ({
          id, facts_fingerprint: ci(id).facts_fingerprint, outcome: "write", level: "kildetro",
          description: KT_TEXT, judge: { approved: true }, homepage_url,
        });
        fetched.length = 0;
        const w = await post("/admin/experiences-description-write", { dry_run: false, items: [wItem("dc-k1", PAGE), wItem("dc-k4", "https://www.kilde-tur.example/")] });
        assertEq(w.body.results, [{ id: "dc-k1", result: "written" }, { id: "dc-k4", result: "written" }], "dc-r16u: description-write accepts the same-host product URL");
        assertEq(fetched[0], PAGE, "dc-r16v: kildetro fetched the product page first for dc-k1");
        assertTrue(fetched.includes("https://www.kilde-tur.example"), "dc-r16w: dc-k4 (host mismatch) fetched the root homepage");
        assertEq(JSON.parse(rowOf("dc-k1").content_field_evidence).description, PAGE, "dc-r16x: kildetro provenance = the fetched product URL");
        assertEq(JSON.parse(rowOf("dc-k4").content_field_evidence).description, "https://www.kilde-tur.example", "dc-r16y: fallback provenance = root URL");

        // The proposals job's shared apply path.
        const job = require("../services/experience-description-proposals-job") as typeof import("../services/experience-description-proposals-job");
        const fpK3 = opp.experienceDescriptionFactsFingerprint(rowJoin("dc-k3"));
        const fileText = JSON.stringify({ schema: "experiences-description-proposals/v1", run_id: "dc-run", created_at: "2026-10-07T00:00:00Z",
          items: [{ id: "dc-k3", facts_fingerprint: fpK3, outcome: "write", level: "kildetro", description: KT_TEXT, judge: { approved: true }, homepage_url: PAGE }] });
        const ghStub = (async (url: any) => {
          const u = String(url);
          if (u.includes("api.anthropic.com")) { anthropicRequests++; throw new Error("LLM via github seam"); }
          const path = decodeURIComponent(new URL(u).pathname.replace("/repos/slookisen/A2A/contents/", ""));
          if (path === "experiences-proposals") return { ok: true, status: 200, json: async () => [{ name: "2026-10-07", path: "experiences-proposals/2026-10-07", type: "dir", sha: "d1" }] } as unknown as Response;
          if (path === "experiences-proposals/2026-10-07") return { ok: true, status: 200, json: async () => [{ name: "dc.json", path: "experiences-proposals/2026-10-07/dc.json", type: "file", sha: "f1", size: fileText.length }] } as unknown as Response;
          if (path === "experiences-proposals/2026-10-07/dc.json") return { ok: true, status: 200, json: async () => ({ encoding: "base64", content: Buffer.from(fileText).toString("base64"), sha: "f1" }) } as unknown as Response;
          return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
        }) as unknown as typeof fetch;
        fetched.length = 0;
        const rep = await job.tickExperienceDescriptionProposals({
          fetchImpl: ghStub, homepageFetchImpl: hpStub, now: new Date("2026-10-07T12:00:00Z"),
          env: { EXPERIENCE_PROPOSALS_JOB_ENABLED: "true", A2A_READ_PAT: "test-pat" }, expDb: expDb as any, mainDb: () => init.getDb(),
        } as any);
        assertEq(rep.written, 1, "dc-r16z: proposals job wrote the kildetro description");
        assertEq(fetched[0], PAGE, "dc-r16z2: ...after fetching the product page");
        assertEq(JSON.parse(rowOf("dc-k3").content_field_evidence).description, PAGE, "dc-r16z3: ...with the product page as provenance");

        // N1: a product page that redirects off the provider's host -> its
        // text is dropped, the root homepage is fetched and stamped instead.
        expDb.prepare("UPDATE experiences SET source_page_url = ? WHERE id = 'dc-k2'").run("https://kilde-tur.example/opplevelser/flyttet");
        const cand2 = await callRoute(router, { method: "GET", url: "/admin/experiences-description-candidates", headers: auth, query: { limit: "50" } });
        const k2 = (cand2.body.items as any[]).find((x) => x.id === "dc-k2");
        fetched.length = 0;
        const wr = await post("/admin/experiences-description-write", { dry_run: false, items: [{
          id: "dc-k2", facts_fingerprint: k2.facts_fingerprint, outcome: "write", level: "kildetro",
          description: KT_TEXT, judge: { approved: true }, homepage_url: k2.homepage_url }] });
        assertEq(wr.body.results, [{ id: "dc-k2", result: "written" }], "dc-r16z5: written");
        assertEq(fetched.slice(0, 1), ["https://kilde-tur.example/opplevelser/flyttet"], "dc-r16z6: product page fetched first");
        assertTrue(fetched.includes("https://www.kilde-tur.example"), "dc-r16z7: ...then the root after the cross-host redirect");
        assertEq(JSON.parse(rowOf("dc-k2").content_field_evidence).description, "https://www.kilde-tur.example", "dc-r16z8: provenance = the root whose text was used");

        // Revert of a source_page_url correction restores NULL.
        const rv = revert({ correction_ids: [applied.results[1].correction_id] });
        assertEq([rv.results[0].result, rowOf("dc-k3").source_page_url], ["reverted", null], "dc-r16z4: revert restores NULL");
      }

      // ── dc-r17: review fixes (B1–B4, N1–N9). ───────────────────────
      {
        // B1: a rejected provider item blocks the dependent homepage item.
        seed("dc-b1");
        const b1 = await apply([
          item("dc-b1", "provider", "Delt Tilbyder AS", "Ukjent Selskap AS"),
          item("dc-b1", "homepage_url", "https://www.delt-ny.example/", "https://ukjent.example/"),
        ]);
        assertEq(b1.results.map((r: any) => r.reason), ["provider_needs_orgnr", "depends_on_rejected_provider"], "dc-r17a: homepage item depends on the rejected provider item");
        assertEq(provOf(provShared).hjemmeside, "https://www.delt-ny.example/", "dc-r17b: the old shared provider's homepage is untouched");
        // B1: stale guard uses the provider the row points to after the relink.
        seed("dc-b2");
        const b2 = await preview([
          item("dc-b2", "provider", "Delt Tilbyder AS", "Øvrig Turselskap AS"),
          item("dc-b2", "homepage_url", "https://www.delt-ny.example/", "https://ovrig.example/"),
        ]);
        assertEq(b2.results[1].reason, "stale_expected_current", "dc-r17c: expected_current checked against the NEW provider (which has no homepage)");
        // B2: org.nr. of an existing, differently named provider.
        seed("dc-b3");
        const b3 = await apply([item("dc-b3", "provider", "Delt Tilbyder AS", "Noe Helt Annet AS (org.nr. 911222333)")]);
        assertEq(b3.results[0].reason, "provider_name_mismatch", "dc-r17d: org.nr. match needs a name match");
        assertTrue(String(b3.results[0].detail).includes("Øvrig Turselskap AS"), "dc-r17e: detail names the existing provider");
        // B3: backslash / userinfo in source_page_url.
        seed("dc-b4", { provider_id: provSolo });
        for (const bad of ["https://evil.com\\@solo.example/x", "https://solo.example@evil.com/x", "https://u:p@solo.example/x", "https://solo.example:8080/x"]) {
          const r = await preview([item("dc-b4", "source_page_url", "", bad)]);
          assertEq([r.results[0].result, r.results[0].reason], ["rejected", "invalid_value"], `dc-r17f: ${bad} rejected`);
        }
        const rowB4 = { provider_hjemmeside: "https://solo.example/", source_page_url: "https://evil.com\\@solo.example/x" } as any;
        assertEq(opp.experienceKildetroSourceUrl(rowB4), "https://solo.example/", "dc-r17g: kildetro never fetches a backslash URL");
        // N9: Brreg unavailable is distinct from not found.
        BRREG_FAIL.add("777888999");
        const n9 = await apply([item("dc-b1", "provider", "Delt Tilbyder AS", "Nede Turer AS (org.nr. 777888999)")]);
        assertEq([n9.results[0].reason, n9.results[0].detail], ["provider_unverified", "brreg_unavailable"], "dc-r17h: Brreg 5xx -> brreg_unavailable");
        BRREG_THROW.add("888999000");
        const n9b = await apply([item("dc-b1", "provider", "Delt Tilbyder AS", "Nede Turer AS (org.nr. 888999000)")]);
        assertEq(n9b.results[0].detail, "brreg_unavailable", "dc-r17i: Brreg network error -> brreg_unavailable");
        // N6: a pause set while Brreg is being called stops the apply.
        const mainDb = init.getDb();
        seed("dc-n6");
        ROUTE_APP_SETTINGS["experienceDataCorrectionsBrregFetchImpl"] = (async (u: any, i: any) => {
          pauseSvc.setEnrichmentWritePause(mainDb as any, { vertical: "experiences", enabled: true, reason: "n6" }, "verifier");
          return brregStub(u, i);
        }) as any;
        brregClient.__clearBrregVerifyCacheForTesting();
        const beforeN6 = dumpAll();
        const n6 = await post("/admin/experiences-data-corrections", { dry_run: false, items: [item("dc-n6", "provider", "Delt Tilbyder AS", "Helt Ny Tilbyder AS (org.nr. 123123123)")] });
        assertEq(n6.status, 423, "dc-r17j: pause set during the Brreg await -> 423");
        assertEq(dumpAll(), beforeN6, "dc-r17k: nothing written");
        pauseSvc.setEnrichmentWritePause(mainDb as any, { vertical: "experiences", enabled: false, cleared_by: "daniel" }, "verifier");
        ROUTE_APP_SETTINGS["experienceDataCorrectionsBrregFetchImpl"] = brregStub;
        // Season: expected in all-four form matches a stored year_round.
        seed("dc-s4", { season: ["year_round"] });
        assertEq((await preview([item("dc-s4", "season", "vår, sommer, høst, vinter", "sommer")])).results[0].result, "would_apply", "dc-r17l: all-four expected matches stored year_round");
        // N2: byte-exact revert of JSON columns.
        const provBx = expStore.createProvider({ navn: "Byte Eksakt AS", brreg_verified: 1, brreg_active: 1, hjemmeside: "https://bx.example" } as any);
        const fpRaw = '{"hjemmeside_verification": {"verified": true}, "navn": {"x": 1}}';
        expDb.prepare("UPDATE experience_providers SET field_provenance = ? WHERE id = ?").run(fpRaw, provBx);
        seed("dc-bx", { provider_id: provBx });
        const ceRaw = '{ "kommune": "a" }';
        expDb.prepare("UPDATE experiences SET content_field_evidence = ? WHERE id = 'dc-bx'").run(ceRaw);
        const bx = await apply([item("dc-bx", "homepage_url", "https://bx.example", "https://annen-bx.example/"), item("dc-bx", "price_from", 890, 300), item("dc-bx", "duration", 60, 90)]);
        assertEq(bx.results.map((r: any) => r.result), ["applied", "applied", "applied"], "dc-r17m: applied");
        const rvx = revert({ batch_id: bx.batch_id });
        assertEq(rvx.totals.reverted, 3, "dc-r17n: reverted");
        assertEq(provOf(provBx).field_provenance, fpRaw, "dc-r17o: field_provenance restored byte for byte");
        assertEq(rowOf("dc-bx").content_field_evidence, ceRaw, "dc-r17p: content_field_evidence restored byte for byte");
        // N3: created provider with an FK child is kept on revert.
        seed("dc-fk");
        const fk = await apply([item("dc-fk", "provider", "Delt Tilbyder AS", "Helt Ny Tilbyder AS (org.nr. 123123123)")]);
        assertEq(fk.results[0].result, "applied", "dc-r17q: provider created");
        const created = rowOf("dc-fk").provider_id;
        expDb.prepare("INSERT INTO experience_provider_field_write_audit (id, provider_id, field_name, old_value, new_value) VALUES (?, ?, 'x', NULL, 'y')").run("fk-child-1", created);
        const rfk = revert({ correction_ids: [fk.results[0].correction_id] });
        assertEq([rfk.results[0].result, rowOf("dc-fk").provider_id], ["reverted", provShared], "dc-r17r: link restored");
        const kept = rfk.results[0].warnings.find((w: any) => w.code === "created_provider_kept");
        assertTrue(!!provOf(created) && !!kept && kept.referenced_by.some((x: any) => x.table === "experience_provider_field_write_audit"), "dc-r17s: provider kept, FK child table named");
        // N3: a created provider changed since -> changed_since (insert step checked).
        seed("dc-fk2");
        const fk2 = await apply([item("dc-fk2", "provider", "Delt Tilbyder AS", "Skiforeningen (org.nr. 946175986)")]);
        const created2 = rowOf("dc-fk2").provider_id;
        if (fk2.results[0].result === "applied") {
          expDb.prepare("UPDATE experience_providers SET navn = 'Endret' WHERE id = ?").run(created2);
          const r2 = revert({ correction_ids: [fk2.results[0].correction_id] });
          assertEq(r2.results[0].reason, "changed_since", "dc-r17t: edited created provider -> changed_since");
        } else {
          assertTrue(false, `dc-r17t: setup failed (${fk2.results[0].reason})`);
        }
      }

      assertEq(anthropicRequests, 0, "dc-r14b: ZERO requests to api.anthropic.com");
      assertEq(networkCalls, 0, "dc-r14: ZERO network requests across every path above");
      dbFactory.__resetDbFactoryForTesting();
    } catch (err: any) {
      failed++;
      failures.push("experience-data-corrections (section R): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (restoreMainDb) restoreMainDb();
      globalThis.fetch = prevFetch;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      for (const p of [dbFactoryPath, experienceStorePath, opplevelserPath]) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOpplevelserExperienceDataCorrectionsTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0);
  });
}
