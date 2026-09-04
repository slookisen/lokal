/**
 * dental-verifier.test.ts — unit + integration tests for
 * src/services/dental-verifier.ts (dev-request
 * 2026-09-02-dental-verifier-website-ownership).
 *
 * Two blocks:
 *   1. Pure-function unit tests (no DB, no network) for the small exported
 *      helpers -- countRichFields, websiteOwnershipMatch,
 *      isWebsiteOwnershipCacheFresh, interpretBrregResult,
 *      computeDentalVerifiedRule.
 *   2. Integration tests driving the real runDentalVerifierBatch()
 *      entrypoint against an in-memory dental.db, with brregLookupFn/
 *      fetchPageFn/now all injected (test seams -- never a real network
 *      call), covering: the verified rule end-to-end, the downgrade rule
 *      (3x website_ownership_streak), "any success resets the streak",
 *      the Brreg-dissolved/bankrupt inactive path, the 7-day homepage
 *      cache/TTL, the offentlig_klinikk+directory_url verified path, the
 *      NACE-mismatch review path, specialists_verified, and that a
 *      'rejected' clinic is never re-picked/promoted.
 *
 * Same fixture/mocking discipline as dental-wrong-entity-streak.test.ts:
 * DENTAL_DB_PATH=":memory:", db-factory reset + require-cache clear
 * around each in-process DB, injectable fns rather than real network.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/dental-verifier.test.ts
 *   2. Wired into the gate: tests/test.ts imports runDentalVerifierTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 */

import {
  countRichFields,
  websiteOwnershipMatch,
  isWebsiteOwnershipCacheFresh,
  interpretBrregResult,
  computeDentalVerifiedRule,
  coreClinicName,
  DENTAL_VERIFIER_HOMEPAGE_CACHE_MS,
  type DentalVerifierCandidateRow,
} from "./dental-verifier";
import type { BrregVerifyResult } from "./brreg-client";
import type { FetchPageResult } from "./fetch-page";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runDentalVerifierTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // ═══════════════════════════════════════════════════════════════════
  // Block 1: pure-function unit tests (no DB, no network)
  // ═══════════════════════════════════════════════════════════════════

  // ── countRichFields ─────────────────────────────────────────────────
  assertEq(countRichFields({}), 0, "rich-01: empty row -> 0 rich fields");
  assertEq(countRichFields({ om_oss: "  " }), 0, "rich-02: whitespace-only om_oss doesn't count");
  assertEq(countRichFields({ om_oss: "Vi er en moderne tannklinikk." }), 1, "rich-03: real om_oss text -> 1");
  assertEq(countRichFields({ specialists: "[]" }), 0, "rich-04: stored '[]' doesn't count (never written by jsonOrNull, defensively guarded anyway)");
  assertEq(countRichFields({ treatments_subtypes: "{}" }), 0, "rich-05: stored '{}' doesn't count");
  assertEq(
    countRichFields({
      om_oss: "Om klinikken vår",
      specialists: JSON.stringify([{ name: "Kari Nordmann", specialty: "endodonti" }]),
      treatment_tech: JSON.stringify(["laser", "cbct"]),
    }),
    3,
    "rich-06: om_oss + specialists + treatment_tech all populated -> 3"
  );
  assertEq(
    countRichFields({ treatments_subtypes: JSON.stringify({ fyllinger: ["hvit", "amalgam"] }) }),
    1,
    "rich-07: non-empty JSON object counts"
  );
  assertEq(countRichFields({ social_media: "not valid json {" }), 1, "rich-08: malformed-but-nonempty text still counts (write-bug tolerant, not silently 'not rich')");

  // ── websiteOwnershipMatch ───────────────────────────────────────────
  {
    const r = websiteOwnershipMatch("Kontakt oss. Org.nr: 911 234 567. Velkommen!", {
      orgNr: "911234567",
      navn: "Bjørn Tannlege AS",
      poststed: "Oslo",
      postnummer: "0150",
    });
    assertEq(r, { matched: true, reason: "org_nr" }, "wom-01: spaced org-nr on page matches stored bare org-nr");
  }
  {
    const r = websiteOwnershipMatch("Velkommen til Bjørn Tannlege. Vi holder til i Oslo sentrum.", {
      orgNr: "911234567",
      navn: "Bjørn Tannlege AS",
      poststed: "Oslo",
      postnummer: "0150",
    });
    assertEq(r, { matched: true, reason: "name_location" }, "wom-02: core name (AS stripped) + poststed both present -> matched");
  }
  {
    const r = websiteOwnershipMatch("Velkommen til Bjørn Tannlege.", {
      orgNr: "911234567",
      navn: "Bjørn Tannlege AS",
      poststed: "Oslo",
      postnummer: "0150",
    });
    assertTrue(!r.matched, "wom-03: name present but NO location signal at all -> not matched");
  }
  {
    const r = websiteOwnershipMatch("Book time hos en av våre tannleger i Oslo.", {
      orgNr: "911234567",
      navn: "Bjørn Tannlege AS",
      poststed: "Oslo",
      postnummer: "0150",
    });
    assertTrue(!r.matched, "wom-04: directory-style page mentioning only the city, not this clinic's name -> not matched");
  }
  {
    const r = websiteOwnershipMatch("Tannklinikken ligger i postnummer 0150 Oslo sentrum.", {
      orgNr: null,
      navn: "Helt Annet Navn AS",
      poststed: "Oslo",
      postnummer: "0150",
    });
    assertTrue(!r.matched, "wom-05: location present but wrong clinic name -> not matched (never location-only)");
  }
  assertEq(coreClinicName("Bjørn Tannlege AS"), "Bjørn Tannlege", "wom-06: coreClinicName strips trailing AS");
  assertEq(coreClinicName("Nordre Tannhelse ENK"), "Nordre Tannhelse", "wom-07: coreClinicName strips trailing ENK");

  // ── isWebsiteOwnershipCacheFresh ────────────────────────────────────
  {
    const now = Date.parse("2026-09-04T12:00:00.000Z");
    const twoDaysAgo = new Date(now - 2 * 86_400_000).toISOString();
    const eightDaysAgo = new Date(now - 8 * 86_400_000).toISOString();
    assertTrue(isWebsiteOwnershipCacheFresh("verified", twoDaysAgo, now), "ttl-01: 2 days ago, verified -> fresh");
    assertTrue(isWebsiteOwnershipCacheFresh("unverified", twoDaysAgo, now), "ttl-02: 2 days ago, unverified -> ALSO fresh (spec: successfully fetched, whether or not it matched)");
    assertTrue(!isWebsiteOwnershipCacheFresh("verified", eightDaysAgo, now), "ttl-03: 8 days ago -> stale");
    assertTrue(!isWebsiteOwnershipCacheFresh(null, twoDaysAgo, now), "ttl-04: never-checked (null status) -> never fresh");
    assertTrue(!isWebsiteOwnershipCacheFresh("verified", null, now), "ttl-05: no checked_at timestamp -> never fresh");
    assertTrue(!isWebsiteOwnershipCacheFresh("n/a", twoDaysAgo, now), "ttl-06: 'n/a' never counts as a cached fetch");
    assertEq(DENTAL_VERIFIER_HOMEPAGE_CACHE_MS, 7 * 86_400_000, "ttl-07: cache window constant is exactly 7 days");
  }

  // ── interpretBrregResult ────────────────────────────────────────────
  function fakeBrreg(over: Partial<BrregVerifyResult>): BrregVerifyResult {
    return {
      exists: true,
      active: true,
      name: "Test AS",
      nace: [],
      registrertDato: null,
      slettetDato: null,
      flag: null,
      employees: null,
      ...over,
    };
  }
  assertEq(
    interpretBrregResult(fakeBrreg({ nace: ["86.230"] })),
    { status: "active", naceMismatch: false },
    "brreg-01: active + allowed dental NACE -> active, no mismatch"
  );
  assertEq(
    interpretBrregResult(fakeBrreg({ nace: ["47.110"] })),
    { status: "active", naceMismatch: true },
    "brreg-02: active + only a non-dental NACE code -> active status, naceMismatch=true"
  );
  assertEq(
    interpretBrregResult(fakeBrreg({ nace: [] })),
    { status: "active", naceMismatch: false },
    "brreg-03: active + NO nace on file at all -> never flagged (no data to mismatch on)"
  );
  assertEq(
    interpretBrregResult(fakeBrreg({ active: false, flag: "dissolved", slettetDato: "2026-01-01" })),
    { status: "dissolved", naceMismatch: false },
    "brreg-04: dissolved"
  );
  assertEq(
    interpretBrregResult(fakeBrreg({ active: false, flag: "bankrupt" })),
    { status: "bankrupt", naceMismatch: false },
    "brreg-05: bankrupt"
  );
  assertEq(
    interpretBrregResult({ exists: false, active: false, name: null, nace: [], registrertDato: null, slettetDato: null, flag: "no_orgnr", employees: null }),
    { status: "orgnr_not_found_or_unreachable", naceMismatch: false },
    "brreg-06: exists:false (404 or network failure, indistinguishable) -> ambiguous bucket, never a confirmed-dead verdict"
  );
  assertEq(
    interpretBrregResult(fakeBrreg({ active: false, flag: null })),
    { status: "inactive_other", naceMismatch: false },
    "brreg-07: exists:true, active:false, flag:null (underAvvikling/tvangsopplosning) -> confirmed inactive_other, not the ambiguous bucket"
  );

  // ── computeDentalVerifiedRule ───────────────────────────────────────
  assertTrue(
    computeDentalVerifiedRule({ brregStatus: "active", websiteOwnership: "verified", catalogClass: "klinikk", directoryUrl: null, richFieldCount: 3 }),
    "vr-01: active + website verified + 3 rich fields -> verified"
  );
  assertTrue(
    !computeDentalVerifiedRule({ brregStatus: "active", websiteOwnership: "verified", catalogClass: "klinikk", directoryUrl: null, richFieldCount: 2 }),
    "vr-02: only 2 rich fields -> not verified"
  );
  assertTrue(
    !computeDentalVerifiedRule({ brregStatus: "dissolved", websiteOwnership: "verified", catalogClass: "klinikk", directoryUrl: null, richFieldCount: 5 }),
    "vr-03: brreg not active -> never verified regardless of everything else"
  );
  assertTrue(
    !computeDentalVerifiedRule({ brregStatus: "active", websiteOwnership: "unverified", catalogClass: "klinikk", directoryUrl: null, richFieldCount: 5 }),
    "vr-04: klinikk with unverified website and no directory_url escape hatch -> not verified"
  );
  assertTrue(
    computeDentalVerifiedRule({ brregStatus: "active", websiteOwnership: "n/a", catalogClass: "offentlig_klinikk", directoryUrl: "https://mrfylke.no/tannhelse/klinikk-1", richFieldCount: 3 }),
    "vr-05: offentlig_klinikk with directory_url present -> verified even with no own website"
  );
  assertTrue(
    !computeDentalVerifiedRule({ brregStatus: "active", websiteOwnership: "n/a", catalogClass: "offentlig_klinikk", directoryUrl: null, richFieldCount: 5 }),
    "vr-06: offentlig_klinikk but NO directory_url and no verified website -> not verified"
  );
  assertTrue(
    !computeDentalVerifiedRule({ brregStatus: "active", websiteOwnership: "unverified", catalogClass: "klinikk", directoryUrl: "https://x.no", richFieldCount: 3 }),
    "vr-07: a plain klinikk's directory_url does NOT count as the escape hatch -- only offentlig_klinikk gets it"
  );

  // ═══════════════════════════════════════════════════════════════════
  // Block 2: integration tests via runDentalVerifierBatch, in-memory DB
  // ═══════════════════════════════════════════════════════════════════

  const prevPath = process.env.DENTAL_DB_PATH;
  process.env.DENTAL_DB_PATH = ":memory:";

  const dbFacPath = require.resolve("../database/db-factory");
  const dentalStorePath = require.resolve("./dental-store");
  const dentalVerifierPath = require.resolve("./dental-verifier");
  const cachePaths = [dbFacPath, dentalStorePath, dentalVerifierPath];
  for (const p of cachePaths) delete require.cache[p];

  const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
  dbFactory.__resetDbFactoryForTesting();
  const dstore = require("./dental-store") as typeof import("./dental-store");
  const verifierMod = require("./dental-verifier") as typeof import("./dental-verifier");

  try {
    const dentalDb = dbFactory.getDb("dental");

    function updateRow(id: string, patch: Record<string, unknown>): void {
      const cols = Object.keys(patch);
      const setSql = cols.map((c) => `${c} = @${c}`).join(", ");
      dentalDb.prepare(`UPDATE dental_agents SET ${setSql} WHERE id = @id`).run({ ...patch, id });
    }

    function readRow(id: string): any {
      return dentalDb.prepare("SELECT * FROM dental_agents WHERE id = ?").get(id);
    }

    function makeClinic(navn: string, orgNr: string, overrides: Record<string, unknown> = {}): string {
      const id = dstore.createDentalAgent({ navn, org_nr: orgNr, hjemmeside: null } as any);
      updateRow(id, { catalog_class: "klinikk", ...overrides });
      return id;
    }

    function activeBrreg(nace: string[] = ["86.230"]): BrregVerifyResult {
      return { exists: true, active: true, name: null, nace, registrertDato: null, slettetDato: null, flag: null, employees: null };
    }
    function dissolvedBrreg(): BrregVerifyResult {
      return { exists: true, active: false, name: null, nace: [], registrertDato: null, slettetDato: "2026-01-01", flag: "dissolved", employees: null };
    }
    function bankruptBrreg(): BrregVerifyResult {
      return { exists: true, active: false, name: null, nace: [], registrertDato: null, slettetDato: null, flag: "bankrupt", employees: null };
    }

    function richPatch(): Record<string, unknown> {
      return {
        om_oss: "En etablert tannklinikk med fullt tilbud.",
        specialists: JSON.stringify([{ name: "Kari Nordmann", specialty: "endodonti" }]),
        treatment_tech: JSON.stringify(["laser", "cbct"]),
      };
    }

    function okFetch(html: string): FetchPageResult {
      return { ok: true, html, status: 200, finalUrl: "https://example.no", bytes: html.length, attempts: 1, redirected: false };
    }
    function transientFetch(): FetchPageResult {
      return { ok: false, reason: "timeout", persistence: "transient", status: null, detail: "timeout", attempts: 1 };
    }
    function deadFetch(): FetchPageResult {
      return { ok: false, reason: "dns_not_found", persistence: "permanent", status: null, detail: "dns", attempts: 1 };
    }

    // ── A: Verified rule end-to-end ─────────────────────────────────
    {
      const id = makeClinic("Solvik Tannklinikk AS", "911111111", {
        hjemmeside: "https://solvik-tannklinikk.no",
        poststed: "Bergen",
        postnummer: "5003",
        ...richPatch(),
      });
      const result = await verifierMod.runDentalVerifierBatch({
        db: dentalDb,
        pickFn: () => [readCandidateRow(dentalDb, id)],
        brregLookupFn: async () => activeBrreg(),
        fetchPageFn: async () => okFetch("Solvik Tannklinikk holder til i Bergen 5003. Velkommen!"),
        now: () => Date.parse("2026-09-04T08:00:00.000Z"),
      });
      assertEq(result.results.length, 1, "int-A-01: batch processed exactly the 1 candidate");
      assertEq(result.results[0].new_verification_status, "verified", "int-A-02: verified rule fires end-to-end");
      const row = readRow(id);
      assertEq(row.verification_status, "verified", "int-A-03: DB row persisted as verified");
      assertEq(row.website_ownership, "verified", "int-A-04: website_ownership persisted as verified");
      assertEq(row.website_ownership_streak, 0, "int-A-05: streak stays 0 on a verified result");
      assertEq(row.brreg_status, "active", "int-A-06: brreg_status persisted");
      assertTrue(!!row.last_verified_at, "int-A-07: last_verified_at stamped");
      assertTrue(!!row.website_ownership_checked_at, "int-A-08: website_ownership_checked_at stamped on a real fetch");
    }

    // ── B: downgrade rule -- 3 consecutive unverified strikes ────────
    {
      const id = makeClinic("Nordbø Tannlege AS", "911111222", {
        hjemmeside: "https://nordbo-eksempel.no",
        poststed: "Trondheim",
        postnummer: "7010",
      });
      let now = Date.parse("2026-01-01T08:00:00.000Z");
      const runOnce = () =>
        verifierMod.runDentalVerifierBatch({
          db: dentalDb,
          pickFn: () => [readCandidateRow(dentalDb, id)],
          brregLookupFn: async () => activeBrreg(),
          fetchPageFn: async () => okFetch("En helt annen tannklinikk i en annen by."),
          now: () => now,
        });

      const r1 = await runOnce();
      assertEq(r1.results[0].website_ownership, "unverified", "int-B-01: strike 1 -> unverified");
      assertEq(r1.results[0].website_ownership_streak, 1, "int-B-02: streak=1");
      assertEq(r1.results[0].new_verification_status, "pending_verify", "int-B-03: not yet downgraded at strike 1");

      now += 40 * 86_400_000; // past the 30-day re-verify cycle so the SAME row is picked again if using the default picker; here pickFn is overridden anyway
      const r2 = await runOnce();
      assertEq(r2.results[0].website_ownership_streak, 2, "int-B-04: streak=2");
      assertEq(r2.results[0].new_verification_status, "pending_verify", "int-B-05: still not downgraded at strike 2");

      now += 40 * 86_400_000;
      const r3 = await runOnce();
      assertEq(r3.results[0].website_ownership_streak, 3, "int-B-06: strike 3 -> streak=3");
      assertEq(r3.results[0].new_verification_status, "needs_review", "int-B-07: 3rd strike downgrades to needs_review");
      assertEq(r3.results[0].verifier_review_reason, "website_ownership_streak", "int-B-08: review reason recorded");
      const row = readRow(id);
      assertEq(row.verification_status, "needs_review", "int-B-09: DB row persisted as needs_review");
      assertEq(row.website_ownership_streak, 3, "int-B-10: DB row streak persisted as 3");

      // ── C: any success resets the strike counter ──────────────────
      now += 40 * 86_400_000;
      const r4 = await verifierMod.runDentalVerifierBatch({
        db: dentalDb,
        pickFn: () => [readCandidateRow(dentalDb, id)],
        brregLookupFn: async () => activeBrreg(),
        fetchPageFn: async () => okFetch("Nordbø Tannlege holder til i Trondheim 7010."),
        now: () => now,
      });
      assertEq(r4.results[0].website_ownership, "verified", "int-C-01: a real ownership match succeeds");
      assertEq(r4.results[0].website_ownership_streak, 0, "int-C-02: success resets the streak to 0 (mirrors RFB's own semantics)");
    }

    // ── D: Brreg dissolved -> is_inactive + needs_review, excluded from picker ──
    {
      const id = makeClinic("Nedlagt Tannlege AS", "911111333", { ...richPatch() });
      const result = await verifierMod.runDentalVerifierBatch({
        db: dentalDb,
        pickFn: () => [readCandidateRow(dentalDb, id)],
        brregLookupFn: async () => dissolvedBrreg(),
        fetchPageFn: async () => transientFetch(),
        now: () => Date.parse("2026-09-04T08:00:00.000Z"),
      });
      assertEq(result.results[0].new_is_inactive, true, "int-D-01: dissolved -> is_inactive true");
      assertEq(result.results[0].inactive_reason, "brreg_dissolved", "int-D-02: inactive_reason set");
      assertEq(result.results[0].new_verification_status, "needs_review", "int-D-03: dissolved -> needs_review");
      const row = readRow(id);
      assertEq(row.is_inactive, 1, "int-D-04: DB row is_inactive=1");
      assertEq(row.inactive_reason, "brreg_dissolved", "int-D-05: DB row inactive_reason");

      // Excluded from the REAL picker (not the injected pickFn) from now on.
      const picked = verifierMod.pickDentalVerifierBatch(dentalDb, 500);
      assertTrue(!picked.some((c) => c.id === id), "int-D-06: is_inactive=1 row never re-enters pickDentalVerifierBatch's candidate pool");
    }

    // ── D2: Brreg bankrupt -> same treatment ─────────────────────────
    {
      const id = makeClinic("Konkurs Tannlege AS", "911111444");
      const result = await verifierMod.runDentalVerifierBatch({
        db: dentalDb,
        pickFn: () => [readCandidateRow(dentalDb, id)],
        brregLookupFn: async () => bankruptBrreg(),
        fetchPageFn: async () => transientFetch(),
        now: () => Date.parse("2026-09-04T08:00:00.000Z"),
      });
      assertEq(result.results[0].inactive_reason, "brreg_bankrupt", "int-D2-01: bankrupt -> inactive_reason=brreg_bankrupt");
    }

    // ── E: 7-day homepage cache/TTL ───────────────────────────────────
    {
      const id = makeClinic("Cache Tannklinikk AS", "911111555", {
        hjemmeside: "https://cache-tannklinikk.no",
      });
      let fetchCalls = 0;
      const t0 = Date.parse("2026-05-01T08:00:00.000Z");

      const r1 = await verifierMod.runDentalVerifierBatch({
        db: dentalDb,
        pickFn: () => [readCandidateRow(dentalDb, id)],
        brregLookupFn: async () => activeBrreg(),
        fetchPageFn: async () => {
          fetchCalls++;
          return okFetch("uinteressant innhold");
        },
        now: () => t0,
      });
      assertEq(fetchCalls, 1, "int-E-01: first pass really fetches the homepage");
      assertEq(r1.results[0].website_ownership, "unverified", "int-E-02: no match -> unverified");

      // 2 days later -- inside the 7-day cache window -> NOT re-fetched.
      const r2 = await verifierMod.runDentalVerifierBatch({
        db: dentalDb,
        pickFn: () => [readCandidateRow(dentalDb, id)],
        brregLookupFn: async () => activeBrreg(),
        fetchPageFn: async () => {
          fetchCalls++;
          return okFetch("uinteressant innhold");
        },
        now: () => t0 + 2 * 86_400_000,
      });
      assertEq(fetchCalls, 1, "int-E-03: within 7 days -> cache hit, homepage NOT re-fetched");
      assertEq(r2.results[0].website_ownership, "unverified", "int-E-04: cached value reused");
      assertEq(r2.results[0].website_ownership_streak, 1, "int-E-05: streak untouched on a cache hit (no new observation)");

      // 8 days later -- past the cache window -> re-fetched.
      const r3 = await verifierMod.runDentalVerifierBatch({
        db: dentalDb,
        pickFn: () => [readCandidateRow(dentalDb, id)],
        brregLookupFn: async () => activeBrreg(),
        fetchPageFn: async () => {
          fetchCalls++;
          return okFetch("uinteressant innhold");
        },
        now: () => t0 + 8 * 86_400_000,
      });
      assertEq(fetchCalls, 2, "int-E-06: past 7 days -> homepage IS re-fetched");
      assertEq(r3.results[0].website_ownership_streak, 2, "int-E-07: streak increments again on the real re-fetch's negative result");

      // Transient failure never stamps checked_at nor counts a strike. A
      // real fetch RESETS website_ownership_checked_at (r3, above, at
      // t0+8d) so the cache is fresh again for a full 7 more days from
      // THAT point -- advance past t0+8d by another 8 days, not just 1, to
      // land outside the new window.
      const beforeTransient = readRow(id);
      const r4 = await verifierMod.runDentalVerifierBatch({
        db: dentalDb,
        pickFn: () => [readCandidateRow(dentalDb, id)],
        brregLookupFn: async () => activeBrreg(),
        fetchPageFn: async () => {
          fetchCalls++;
          return transientFetch();
        },
        now: () => t0 + 16 * 86_400_000,
      });
      assertEq(fetchCalls, 3, "int-E-08: cache expired again -> attempted fetch");
      assertEq(r4.results[0].website_ownership_streak, 2, "int-E-09: transient failure does not increment the streak");
      const afterTransient = readRow(id);
      assertEq(afterTransient.website_ownership_checked_at, beforeTransient.website_ownership_checked_at, "int-E-10: transient failure does not bump website_ownership_checked_at");
    }

    // ── F: n/a case -- no hjemmeside at all ───────────────────────────
    {
      const id = dstore.createDentalAgent({ navn: "Uten Nettside Tannlege AS", org_nr: "911111666", hjemmeside: null } as any);
      updateRow(id, { catalog_class: "klinikk" });
      let fetchCalls = 0;
      const result = await verifierMod.runDentalVerifierBatch({
        db: dentalDb,
        pickFn: () => [readCandidateRow(dentalDb, id)],
        brregLookupFn: async () => activeBrreg(),
        fetchPageFn: async () => {
          fetchCalls++;
          return okFetch("x");
        },
        now: () => Date.parse("2026-09-04T08:00:00.000Z"),
      });
      assertEq(fetchCalls, 0, "int-F-01: blank hjemmeside -> never fetched");
      assertEq(result.results[0].website_ownership, "n/a", "int-F-02: website_ownership='n/a'");
      assertEq(result.results[0].website_ownership_streak, 0, "int-F-03: streak untouched by n/a");
    }

    // ── G: offentlig_klinikk + directory_url verified path ───────────
    {
      const id = makeClinic("Fylkestannklinikk 1", "911111777", {
        catalog_class: "offentlig_klinikk",
        directory_url: "https://mrfylke.no/tannhelse/klinikk-1",
        ...richPatch(),
      });
      const result = await verifierMod.runDentalVerifierBatch({
        db: dentalDb,
        pickFn: () => [readCandidateRow(dentalDb, id)],
        brregLookupFn: async () => activeBrreg(),
        fetchPageFn: async () => okFetch("uinteressant"),
        now: () => Date.parse("2026-09-04T08:00:00.000Z"),
      });
      assertEq(result.results[0].new_verification_status, "verified", "int-G-01: offentlig_klinikk + directory_url + brreg active + rich fields -> verified without any own hjemmeside");
    }

    // ── H: NACE mismatch -> needs_review ──────────────────────────────
    {
      const id = makeClinic("Feil Bransje AS", "911111888", { ...richPatch() });
      const result = await verifierMod.runDentalVerifierBatch({
        db: dentalDb,
        pickFn: () => [readCandidateRow(dentalDb, id)],
        brregLookupFn: async () => activeBrreg(["47.110"]),
        fetchPageFn: async () => transientFetch(),
        now: () => Date.parse("2026-09-04T08:00:00.000Z"),
      });
      assertEq(result.results[0].new_verification_status, "needs_review", "int-H-01: NACE mismatch -> needs_review");
      assertEq(result.results[0].verifier_review_reason, "brreg_nace_mismatch", "int-H-02: review reason set");
    }

    // ── I: specialists_verified via dental_persons/affiliations ──────
    {
      const clinicId = makeClinic("HPR Sjekk Tannklinikk AS", "911111999", {
        specialists: JSON.stringify([{ name: "Ola Nordmann", specialty: "kjeveortopedi" }]),
      });
      const personId = dstore.upsertDentalPerson({ navn: "Ola Nordmann", hpr_nr: "HPR-12345" } as any);
      dstore.createAffiliation({ person_id: personId, clinic_agent_id: clinicId, is_active: 1 } as any);

      const result = await verifierMod.runDentalVerifierBatch({
        db: dentalDb,
        pickFn: () => [readCandidateRow(dentalDb, clinicId)],
        brregLookupFn: async () => activeBrreg(),
        fetchPageFn: async () => transientFetch(),
        now: () => Date.parse("2026-09-04T08:00:00.000Z"),
      });
      assertEq(result.results[0].specialists_verified, true, "int-I-01: an active dental_clinic_affiliations row -> specialists_verified true");

      const clinicId2 = makeClinic("HPR Uverifisert Tannklinikk AS", "911112000", {
        specialists: JSON.stringify([{ name: "Ukjent Person", specialty: "generell" }]),
      });
      const result2 = await verifierMod.runDentalVerifierBatch({
        db: dentalDb,
        pickFn: () => [readCandidateRow(dentalDb, clinicId2)],
        brregLookupFn: async () => activeBrreg(),
        fetchPageFn: async () => transientFetch(),
        now: () => Date.parse("2026-09-04T08:00:00.000Z"),
      });
      assertEq(result2.results[0].specialists_verified, false, "int-I-02: specialists JSON present but no matching affiliation row -> specialists_verified false");
    }

    // ── J: a 'rejected' clinic is never re-picked/promoted ────────────
    {
      const id = makeClinic("Avvist Tannlege AS", "911112111", {
        verification_status: "rejected",
        hjemmeside: "https://avvist-eksempel.no",
        ...richPatch(),
      });
      const picked = verifierMod.pickDentalVerifierBatch(dentalDb, 500);
      assertTrue(!picked.some((c) => c.id === id), "int-J-01: verification_status='rejected' row never enters the default picker's candidate pool");
    }

    // ── K: non-clinic catalog_class rows never enter the picker either ─
    {
      const id = dstore.createDentalAgent({ navn: "Tannteknisk Laboratorium AS", org_nr: "911112222" } as any);
      updateRow(id, { catalog_class: "lab_leverandor" });
      const picked = verifierMod.pickDentalVerifierBatch(dentalDb, 500);
      assertTrue(!picked.some((c) => c.id === id), "int-K-01: lab_leverandor row excluded from the picker (DENTAL_CLINIC_CLASS_SQL)");
    }

    if (log) console.log(`  dental-verifier: OK (${passed} assertions)`);
  } catch (err) {
    failed++;
    failures.push(`dental-verifier: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevPath;
    dbFactory.__resetDbFactoryForTesting();
    for (const p of cachePaths) delete require.cache[p];
  }

  return { passed, failed, failures };
}

// Reads one row back in DentalVerifierCandidateRow shape (mirrors
// pickDentalVerifierBatch's own SELECT column list) so injected pickFn
// stubs in the tests above reflect real, freshly-read row state rather
// than a stale in-test snapshot.
function readCandidateRow(db: any, id: string): DentalVerifierCandidateRow {
  return db
    .prepare(
      `SELECT id, navn, org_nr, hjemmeside, poststed, postnummer, catalog_class, directory_url,
              verification_status, last_verified_at,
              website_ownership, website_ownership_checked_at, website_ownership_streak,
              om_oss, specialists, treatment_tech, equipment_brands, patient_focus,
              accessibility, payment_options, online_booking_url, social_media, treatments_subtypes
         FROM dental_agents WHERE id = ?`
    )
    .get(id) as DentalVerifierCandidateRow;
}

// Standalone runner: `npx tsx src/services/dental-verifier.test.ts`
if (require.main === module) {
  runDentalVerifierTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
