/**
 * opplevelser-gardssalg-second-line.test.ts — dev-request 2026-08-28-
 * gardssalg-kildebredde-wiring, Grep 2: gårdssalg's second (lower-bar)
 * verification line, mirroring RFB's own second line (lokal-agent-verifier.ts
 * / lokal-agent-verifier-second-line.test.ts) — a website_verified:false
 * profile can still reach the outreach-readiness pool via an owner-plausible,
 * provenance-backed email + a corroborating identity source +
 * judgeSecondLineProfile's whole-profile identity approval, gated behind
 * GS_SECOND_LINE_VERIFICATION_ENABLED (default OFF).
 *
 * Sections:
 *   A. Pure unit tests (no DB, no network) — isGardssalgSecondLineVerified,
 *      computeGardssalgSecondLineVerification (with an injected judgeFn, so
 *      no real ANTHROPIC_API_KEY/network call is made by this section).
 *   B. Flag-OFF byte-identical proof — POST /admin/gardssalg-second-line-
 *      verify with the flag unset and explicitly "false", against a row that
 *      WOULD verify if the flag were on: must be a pure {enabled:false}
 *      no-op (no field_provenance write, no fetch to the Anthropic API,
 *      readiness_tier unchanged).
 *   C. Flag-ON integration tests via the real route (mocked fetch for the
 *      judge's Anthropic call, since the route does not accept an injected
 *      judgeFn) — pass (+ readiness_tier promotion), judge-reject,
 *      terminal-status disqualify (both values), umbrella-email disqualify,
 *      hard-bounced-email disqualify, missing-provenance disqualify,
 *      no-accepted-source disqualify, already-website-verified skip,
 *      not_found, request-validation (empty/oversized providerIds).
 *
 * Same conventions as sibling gårdssalg route test files
 * (opplevelser-gardssalg-website-discovery.test.ts): :memory: experiences DB
 * via db-factory, :memory: RFB db via database/init's __setDbForTesting/
 * __initSchemaForTesting (email_bounces lives there), fresh requires,
 * router.handle(), mocked globalThis.fetch keyed on URL.
 */

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
  opts: { url?: string; method?: string; headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const url = opts.url || "/admin/gardssalg-second-line-verify";
    const req: any = {
      method: opts.method || "POST",
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
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

export function runOpplevelserGardssalgSecondLineTests(
  log = false,
): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else {
      failed++;
      failures.push(`✗ ${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  return (async () => {
    // ═══════════════════════════════════════════════════════════════════
    // Section A — pure unit tests (no DB, no network).
    // ═══════════════════════════════════════════════════════════════════
    try {
      const {
        computeGardssalgSecondLineVerification,
        isGardssalgSecondLineVerified,
      } = require("./opplevelser") as typeof import("./opplevelser");

      // ── isGardssalgSecondLineVerified ───────────────────────────────
      assertTrue(!isGardssalgSecondLineVerified(null), "a-1: null field_provenance -> false");
      assertTrue(!isGardssalgSecondLineVerified("not json"), "a-2: malformed JSON -> false, never throws");
      assertTrue(!isGardssalgSecondLineVerified("{}"), "a-3: no second_line_verification key -> false");
      assertTrue(
        !isGardssalgSecondLineVerified(JSON.stringify({ second_line_verification: { verified: false } })),
        "a-4: verified:false -> false",
      );
      assertTrue(
        !isGardssalgSecondLineVerified(JSON.stringify({ second_line_verification: { verified: "true" } })),
        "a-5: verified:'true' (string, not boolean) -> false (strict ===true)",
      );
      assertTrue(
        isGardssalgSecondLineVerified(JSON.stringify({ second_line_verification: { verified: true, sources: ["hanen_no"] } })),
        "a-6: verified:true -> true",
      );
      assertTrue(
        isGardssalgSecondLineVerified(
          JSON.stringify({ hjemmeside_verification: { verified: false }, second_line_verification: { verified: true } }),
        ),
        "a-7: coexists with an unrelated hjemmeside_verification key, unaffected",
      );

      // ── computeGardssalgSecondLineVerification ──────────────────────
      const baseInput = {
        producer_name: "Testgård",
        city: "Lillehammer",
        about: "En liten gård som selger sider og eplemost direkte fra tunet.",
        products: [{ name: "Sider" }, { name: "Eplemost" }],
        email: "kari@testgard.no",
        field_provenance: {
          epost: { source_url: "https://hanen.no/produsent/testgard", fetched_at: "2026-08-01T00:00:00Z" },
        },
        brreg_verified: true,
        terminal_status: null as "krever_eier" | "dod_kilde" | null,
      };

      {
        const r = await computeGardssalgSecondLineVerification({
          ...baseInput,
          judgeFn: async () => ({ approved: true, reason: "identitet bekreftet" }),
        });
        assertTrue(r.passes, "a-8: all deterministic checks + judge-approve -> passes");
        assertEq(r.sources, ["hanen_no"], "a-9: hanen.no source_url on the epost provenance record itself -> detected");
        assertTrue(r.reasons.email_has_provenance, "a-10: email_has_provenance true (epost record carries a source_url)");
      }
      {
        // Source detected on a DIFFERENT field key (not epost) — proves
        // computeSecondLineIdentitySources scans every field, matching RFB's
        // own cross-field behavior, reused unmodified.
        const r = await computeGardssalgSecondLineVerification({
          ...baseInput,
          field_provenance: {
            epost: { source_url: "https://testgard.no/kontakt", fetched_at: "2026-08-01T00:00:00Z" },
            adresse: { source_url: "https://bondensmarked.no/produsenter/testgard", fetched_at: "2026-08-01T00:00:00Z" },
          },
          judgeFn: async () => ({ approved: true }),
        });
        assertTrue(r.passes, "a-11: source on a non-epost field (adresse) still counts");
        assertTrue(r.sources.includes("bondensmarked_no"), "a-12: bondensmarked_no detected regardless of which field carried it");
      }
      {
        let judgeCalled = false;
        const r = await computeGardssalgSecondLineVerification({
          ...baseInput,
          judgeFn: async () => { judgeCalled = true; return { approved: false, reason: "for tynt grunnlag" }; },
        });
        assertTrue(judgeCalled, "a-13: deterministic checks passed -> judge WAS reached");
        assertTrue(!r.passes, "a-14: judge-reject -> does not pass");
      }
      {
        // brreg_verified:false -> fails, judge never called.
        let judgeCalled = false;
        const r = await computeGardssalgSecondLineVerification({
          ...baseInput,
          brreg_verified: false,
          judgeFn: async () => { judgeCalled = true; return { approved: true }; },
        });
        assertTrue(!r.passes, "a-15: brreg_verified=false -> fails");
        assertTrue(!r.reasons.brreg_ok, "a-16: reasons.brreg_ok=false");
        assertTrue(!judgeCalled, "a-17: brreg_verified=false -> judge never called");
      }
      {
        // terminal_status krever_eier disqualifies even with brreg_verified:true.
        let judgeCalled = false;
        const r = await computeGardssalgSecondLineVerification({
          ...baseInput,
          terminal_status: "krever_eier",
          judgeFn: async () => { judgeCalled = true; return { approved: true }; },
        });
        assertTrue(!r.passes, "a-18: terminal_status=krever_eier -> fails even with brreg_verified true");
        assertTrue(!r.reasons.brreg_ok, "a-19: reasons.brreg_ok=false for krever_eier");
        assertTrue(!judgeCalled, "a-20: krever_eier -> judge never called");
      }
      {
        // terminal_status dod_kilde — same disqualification.
        const r = await computeGardssalgSecondLineVerification({
          ...baseInput,
          terminal_status: "dod_kilde",
          judgeFn: async () => ({ approved: true }),
        });
        assertTrue(!r.passes, "a-21: terminal_status=dod_kilde -> fails");
      }
      {
        // No email at all.
        const r = await computeGardssalgSecondLineVerification({
          ...baseInput,
          email: null,
          judgeFn: async () => ({ approved: true }),
        });
        assertTrue(!r.passes, "a-22: no email -> fails");
        assertTrue(!r.reasons.email_present, "a-23: reasons.email_present=false");
      }
      {
        // Junk/favicon-shaped email — reused from contact-candidate-judge.
        let judgeCalled = false;
        const r = await computeGardssalgSecondLineVerification({
          ...baseInput,
          email: "favicon@2x.png",
          judgeFn: async () => { judgeCalled = true; return { approved: true }; },
        });
        assertTrue(!r.passes, "a-24: junk/favicon-shaped email -> fails");
        assertTrue(!judgeCalled, "a-25: junk email -> judge never called");
      }
      {
        // Umbrella/trade-association email (curated static list,
        // isUmbrellaContactEmail) — never accepted on the second line either.
        let judgeCalled = false;
        const r = await computeGardssalgSecondLineVerification({
          ...baseInput,
          email: "post@hanen.no",
          judgeFn: async () => { judgeCalled = true; return { approved: true }; },
        });
        assertTrue(!r.passes, "a-26: umbrella-routed email (post@hanen.no) -> second line never passes on it");
        assertTrue(!r.reasons.email_not_umbrella, "a-27: reasons.email_not_umbrella=false");
        assertTrue(!judgeCalled, "a-28: umbrella email -> judge never called");
      }
      {
        // Email present but field_provenance carries NO record for it at all
        // (a bare typed-in address, no documented source) -> fails on
        // email_has_provenance, the gårdssalg-specific extra gate beyond
        // RFB's own mirror (dev-request wording: "e-post MED provenance").
        let judgeCalled = false;
        const r = await computeGardssalgSecondLineVerification({
          ...baseInput,
          field_provenance: { adresse: { source_url: "https://hanen.no/x", fetched_at: "2026-08-01T00:00:00Z" } },
          judgeFn: async () => { judgeCalled = true; return { approved: true }; },
        });
        assertTrue(!r.passes, "a-29: email present but no field_provenance.epost record -> fails");
        assertTrue(!r.reasons.email_has_provenance, "a-30: reasons.email_has_provenance=false");
        assertTrue(!judgeCalled, "a-31: no email provenance -> judge never called");
      }
      {
        // Email HAS provenance but the source_url doesn't resolve to any
        // recognised identity source, and no other field does either ->
        // zero accepted sources.
        let judgeCalled = false;
        const r = await computeGardssalgSecondLineVerification({
          ...baseInput,
          field_provenance: { epost: { source_url: "https://testgard.no/kontakt", fetched_at: "2026-08-01T00:00:00Z" } },
          judgeFn: async () => { judgeCalled = true; return { approved: true }; },
        });
        assertTrue(!r.passes, "a-32: zero accepted identity sources -> fails");
        assertTrue(!r.reasons.has_accepted_source, "a-33: reasons.has_accepted_source=false");
        assertTrue(!judgeCalled, "a-34: zero sources -> judge never called");
      }
      {
        // Malformed field_provenance must never throw.
        const r = await computeGardssalgSecondLineVerification({
          ...baseInput,
          field_provenance: null as any,
          judgeFn: async () => ({ approved: true }),
        });
        assertTrue(!r.passes, "a-35: malformed (null) field_provenance -> fails, never throws");
      }

      // ── org_nr / brregLookupFn wiring (dev-request 2026-08-29-gs-brreg-
      // name-match-wiring) — no hanen.no/bondensmarked.no/etc provenance
      // in these fixtures, so brreg_name_match is the ONLY possible source,
      // isolating exactly what these new fields control.
      const noSourceProvenance = {
        epost: { source_url: "https://testgard.no/kontakt", fetched_at: "2026-08-01T00:00:00Z" },
      };
      {
        // org_nr set + injected brregLookupFn resolving to a near-exact-match
        // name -> brreg_name_match fires via the real scoreNameMatch, exactly
        // as it already does for RFB.
        let lookupOrgNr: string | null = null;
        let lookupCalls = 0;
        const r = await computeGardssalgSecondLineVerification({
          ...baseInput,
          org_nr: "912345678",
          field_provenance: noSourceProvenance,
          brregLookupFn: async (orgNr: string) => {
            lookupCalls++;
            lookupOrgNr = orgNr;
            return { exists: true, active: true, name: "Testgård" };
          },
          judgeFn: async () => ({ approved: true }),
        });
        assertEq(lookupCalls, 1, "a-36: brregLookupFn called exactly once");
        assertEq(lookupOrgNr, "912345678", "a-37: brregLookupFn called with input.org_nr");
        assertTrue(r.sources.includes("brreg_name_match"), "a-38: brreg_name_match fires on a high-scoring Brreg name match");
        assertTrue(r.passes, "a-39: brreg_name_match alone satisfies has_accepted_source -> gate passes");
      }
      {
        // Same setup, but the Brreg name is clearly a different business ->
        // scoreNameMatch scores well below 0.8 -> brreg_name_match must NOT
        // fire, and with no other source available the gate fails.
        const r = await computeGardssalgSecondLineVerification({
          ...baseInput,
          org_nr: "912345678",
          field_provenance: noSourceProvenance,
          brregLookupFn: async () => ({ exists: true, active: true, name: "Helt Forskjellig Bedrift Holding AS" }),
          judgeFn: async () => ({ approved: true }),
        });
        assertTrue(!r.sources.includes("brreg_name_match"), "a-40: clearly different Brreg name -> brreg_name_match does not fire");
        assertTrue(!r.reasons.has_accepted_source, "a-41: no other source available -> has_accepted_source=false");
        assertTrue(!r.passes, "a-42: -> gate fails");
      }
      {
        // brregLookupFn rejects -> must never escape the function; behaves
        // exactly as if brreg:null had been passed (today's hardcoded
        // behavior), never crashes, judge never reached (zero sources).
        let judgeCalled = false;
        let threw = false;
        let r: Awaited<ReturnType<typeof computeGardssalgSecondLineVerification>> | undefined;
        try {
          r = await computeGardssalgSecondLineVerification({
            ...baseInput,
            org_nr: "912345678",
            field_provenance: noSourceProvenance,
            brregLookupFn: async () => {
              throw new Error("brreg lookup failed");
            },
            judgeFn: async () => {
              judgeCalled = true;
              return { approved: true };
            },
          });
        } catch {
          threw = true;
        }
        assertTrue(!threw, "a-43: brregLookupFn rejecting never throws out of computeGardssalgSecondLineVerification");
        assertTrue(!!r && !r.sources.includes("brreg_name_match"), "a-44: falls back to brreg:null -> brreg_name_match never fires");
        assertTrue(!!r && !r.passes, "a-45: falls back to brreg:null -> gate fails cleanly (no accepted source)");
        assertTrue(!judgeCalled, "a-46: zero accepted sources -> judge never called");
      }
      {
        // org_nr null/empty -> brregLookupFn is NEVER called (no network call
        // at all when org_nr is missing, matching today's byte-identical
        // no-lookup behavior).
        let lookupCalled = false;
        const mockLookup = async () => {
          lookupCalled = true;
          return { exists: true, active: true, name: "Testgård" };
        };
        await computeGardssalgSecondLineVerification({
          ...baseInput,
          org_nr: null,
          brregLookupFn: mockLookup,
          judgeFn: async () => ({ approved: true }),
        });
        assertTrue(!lookupCalled, "a-47: org_nr=null -> brregLookupFn never called");
        await computeGardssalgSecondLineVerification({
          ...baseInput,
          org_nr: "",
          brregLookupFn: mockLookup,
          judgeFn: async () => ({ approved: true }),
        });
        assertTrue(!lookupCalled, "a-48: org_nr='' -> brregLookupFn never called");
      }
    } catch (err: any) {
      failed++;
      failures.push("second-line (section A): unexpected error: " + String(err?.stack || err?.message || err));
    }

    // ═══════════════════════════════════════════════════════════════════
    // Sections B + C — route integration (isolated in-memory DBs).
    // ═══════════════════════════════════════════════════════════════════
    const prevFetch = globalThis.fetch;
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFlag = process.env.GS_SECOND_LINE_VERIFICATION_ENABLED;
    const testKey = process.env.ADMIN_KEY || "gardssalg-sl-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const brregClientPath = require.resolve("../services/brreg-client");
    const blocklistPath = require.resolve("../services/blocklist-service");
    const opplevelserPath = require.resolve("./opplevelser");
    const providerWorkQueuePath = require.resolve("../services/provider-work-queue");
    const cachePaths = [dbFactoryPath, experienceStorePath, brregClientPath, blocklistPath, opplevelserPath, providerWorkQueuePath];
    for (const p of cachePaths) delete require.cache[p];

    let prevRfbDb: any = null;

    try {
      const initMod = require("../database/init") as typeof import("../database/init");
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const rfbDb = new Database(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const adminHeaders = { "x-admin-key": testKey };

      // Anthropic judge dispatcher — controllable per-scenario via
      // `judgeVerdictText`; throws if invoked when a scenario asserts the
      // judge must NEVER be reached (deterministic short-circuit proof).
      let judgeVerdictText = "GODKJENN\nNavn, sted og e-post stemmer overens.";
      let judgeShouldNotBeCalled = false;
      let judgeCallCount = 0;
      // Fix-up regression hook (lost-update finding on the field_provenance
      // read-modify-write): set to mutate the DB mid-flight, simulating a
      // concurrent writer landing during computeGardssalgSecondLineVerification's
      // own await (this mocked judge call stands in for that network round-
      // trip). Runs once, right before the mocked judge response resolves —
      // i.e. still inside the route's await window — then clears itself.
      let concurrentWriteFn: (() => void) | null = null;
      globalThis.fetch = (async (url: string | URL | Request, init?: any) => {
        const urlStr = String(url);
        if (urlStr.includes("api.anthropic.com")) {
          judgeCallCount++;
          if (judgeShouldNotBeCalled) {
            throw new Error("second-line judge must NOT have been called in this scenario");
          }
          if (concurrentWriteFn) {
            const fn = concurrentWriteFn;
            concurrentWriteFn = null;
            fn();
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ content: [{ type: "text", text: judgeVerdictText }] }),
          } as unknown as Response;
        }
        return { ok: false, status: 404, url: urlStr, text: async () => "" } as unknown as Response;
      }) as unknown as typeof fetch;

      const insertProviderStmt = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, kommune, poststed, hjemmeside, epost, telefon,
            about_text, products, catalog_hidden, content_source, slug, producer_type,
            brreg_verified, terminal_status, field_provenance,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @kommune, NULL, @hjemmeside, @epost, @telefon,
            @about_text, @products, @catalog_hidden, NULL, @slug, @producer_type,
            @brreg_verified, @terminal_status, @field_provenance,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      function seedProvider(id: string, opts: {
        navn?: string;
        org_nr?: string;
        kommune?: string;
        hjemmeside?: string | null;
        epost?: string | null;
        telefon?: string | null;
        about_text?: string | null;
        products?: unknown[];
        catalog_hidden?: number;
        field_provenance?: Record<string, unknown>;
        brreg_verified?: 0 | 1;
        terminal_status?: string | null;
      } = {}): void {
        insertProviderStmt.run({
          id,
          navn: opts.navn ?? "Testgård " + id,
          org_nr: opts.org_nr ?? "9" + id.padEnd(8, "0").slice(0, 8),
          kommune: opts.kommune ?? "Lillehammer",
          hjemmeside: opts.hjemmeside === undefined ? "https://" + id + "-testgard.no" : opts.hjemmeside,
          epost: opts.epost === undefined ? "kari@" + id + "-testgard.no" : opts.epost,
          telefon: opts.telefon === undefined ? "91234567" : opts.telefon,
          about_text: opts.about_text === undefined ? "En liten gård som selger sider og eplemost direkte fra tunet." : opts.about_text,
          products: JSON.stringify(opts.products ?? [{ name: "Sider" }, { name: "Eplemost" }]),
          catalog_hidden: opts.catalog_hidden ?? 0,
          slug: id + "-slug",
          producer_type: "sideri",
          brreg_verified: opts.brreg_verified === undefined ? 1 : opts.brreg_verified,
          terminal_status: opts.terminal_status === undefined ? null : opts.terminal_status,
          field_provenance: JSON.stringify(
            opts.field_provenance === undefined
              ? { epost: { source_url: "https://hanen.no/produsent/" + id, fetched_at: "2026-08-01T00:00:00Z" } }
              : opts.field_provenance,
          ),
        });
      }

      function readFieldProvenance(id: string): Record<string, unknown> {
        const row = expDb.prepare(`SELECT field_provenance FROM experience_providers WHERE id = ?`).get(id) as any;
        return row?.field_provenance ? JSON.parse(row.field_provenance) : {};
      }

      async function getReadinessTier(id: string): Promise<string | undefined> {
        const r = await callRoute(opplevelserRouter, {
          method: "GET",
          url: "/admin/gardssalg-outreach-readiness",
          headers: adminHeaders,
        });
        const row = (r.body.providers as any[]).find((p) => p.id === id);
        return row?.readiness_tier;
      }

      // ═══════════════════════════════════════════════════════════════
      // Section B — flag-off byte-identical proof.
      // ═══════════════════════════════════════════════════════════════
      seedProvider("b1"); // would fully pass if the flag were on (default fixture: hanen.no epost provenance)
      const tierBeforeB = await getReadinessTier("b1");
      assertEq(tierBeforeB, "nettsted_uverifisert", "b-0: b1 starts at nettsted_uverifisert (website unverified, everything else content-complete)");

      for (const flagValue of [undefined, "false"] as const) {
        if (flagValue === undefined) delete process.env.GS_SECOND_LINE_VERIFICATION_ENABLED;
        else process.env.GS_SECOND_LINE_VERIFICATION_ENABLED = flagValue;
        judgeShouldNotBeCalled = true;
        judgeCallCount = 0;
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { providerIds: ["b1"] } });
        assertEq(r.body, { enabled: false }, `b-flag(${flagValue}): pure {enabled:false} no-op response`);
        assertEq(judgeCallCount, 0, `b-flag(${flagValue}): judge (Anthropic API) never called`);
        assertTrue(
          !("second_line_verification" in readFieldProvenance("b1")),
          `b-flag(${flagValue}): field_provenance NOT touched at all`,
        );
        const tierAfter = await getReadinessTier("b1");
        assertEq(tierAfter, "nettsted_uverifisert", `b-flag(${flagValue}): readiness_tier unchanged (byte-identical to before this PR)`);
      }
      judgeShouldNotBeCalled = false;

      // ═══════════════════════════════════════════════════════════════
      // Section C — flag-ON integration tests.
      // ═══════════════════════════════════════════════════════════════
      process.env.GS_SECOND_LINE_VERIFICATION_ENABLED = "true";

      // c-1: full pass -> verified, DB stamped, readiness_tier promoted to
      // outreach_ready.
      seedProvider("c1");
      {
        judgeVerdictText = "GODKJENN\nIdentitet bekreftet.";
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { providerIds: ["c1"] } });
        assertEq(r.body.enabled, true, "c-1a: enabled:true");
        const item = r.body.results.find((x: any) => x.provider_id === "c1");
        assertEq(item.outcome, "verified", "c-1b: outcome=verified");
        assertTrue(Array.isArray(item.sources) && item.sources.includes("hanen_no"), "c-1c: sources includes hanen_no");
        const prov = readFieldProvenance("c1") as any;
        assertEq(prov.second_line_verification?.verified, true, "c-1d: field_provenance.second_line_verification.verified=true");
        assertTrue(!!prov.second_line_verification?.at, "c-1e: .at timestamp set");
        assertTrue(Array.isArray(prov.second_line_verification?.sources), "c-1f: .sources recorded");
        const tier = await getReadinessTier("c1");
        assertEq(tier, "outreach_ready", "c-1g: readiness_tier promoted to outreach_ready via verified_second_line");
      }

      // c-1h: same pass, but for a row with NO website at all (hjemmeside:
      // null) -- the population `verified_second_line` exists FOR. Before
      // dev-request 2026-08-29-gs-second-line-kildeklasse-bredde's fix,
      // computeGardssalgReadinessTier's `!has_website` check fired
      // unconditionally BEFORE the verified_second_line check further down,
      // so this row was dead-ended at "no_website" and could never reach
      // outreach_ready no matter how thoroughly it was second-line verified.
      seedProvider("c1h", { hjemmeside: null });
      {
        const tierBefore = await getReadinessTier("c1h");
        assertEq(tierBefore, "no_website", "c-1h-0: c1h (no hjemmeside, not yet second-line verified) starts at no_website");
        judgeVerdictText = "GODKJENN\nIdentitet bekreftet.";
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { providerIds: ["c1h"] } });
        const item = r.body.results.find((x: any) => x.provider_id === "c1h");
        assertEq(item.outcome, "verified", "c-1h-1: outcome=verified (no website is not itself a disqualifier for second-line verification)");
        const prov = readFieldProvenance("c1h") as any;
        assertEq(prov.second_line_verification?.verified, true, "c-1h-2: field_provenance.second_line_verification.verified=true");
        const tierAfter = await getReadinessTier("c1h");
        assertEq(tierAfter, "outreach_ready", "c-1h-3: readiness_tier promoted to outreach_ready even with no hjemmeside -- verified_second_line is no longer dead code for the no-website population");
      }

      // c-2: judge rejects -> gate_failed, no stamp, tier unchanged.
      seedProvider("c2");
      {
        judgeVerdictText = "AVVIS\nFor tynt bevisgrunnlag.";
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { providerIds: ["c2"] } });
        const item = r.body.results.find((x: any) => x.provider_id === "c2");
        assertEq(item.outcome, "gate_failed", "c-2a: judge-reject -> gate_failed");
        assertEq(item.reasons.judge_approved, false, "c-2b: reasons.judge_approved=false");
        assertTrue(!("second_line_verification" in readFieldProvenance("c2")), "c-2c: no stamp written on judge-reject");
        const tier = await getReadinessTier("c2");
        assertEq(tier, "nettsted_uverifisert", "c-2d: readiness_tier unchanged after judge-reject");
        judgeVerdictText = "GODKJENN\nIdentitet bekreftet.";
      }

      // c-3: already website_verified -> skipped entirely (1.linje priority),
      // reported (not silently dropped), never even reaches the judge.
      seedProvider("c3", {
        field_provenance: {
          hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-08-01T00:00:00Z" },
        },
      });
      {
        judgeShouldNotBeCalled = true;
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { providerIds: ["c3"] } });
        const item = r.body.results.find((x: any) => x.provider_id === "c3");
        assertEq(item.outcome, "already_website_verified", "c-3a: website_verified row is skipped, reported, never evaluated");
        judgeShouldNotBeCalled = false;
      }

      // c-4/c-5: terminal_status disqualifies ALWAYS, even with a perfect
      // profile otherwise — reported (never silently dropped), judge never
      // reached.
      for (const ts of ["krever_eier", "dod_kilde"] as const) {
        seedProvider("c4-" + ts, { terminal_status: ts });
        judgeShouldNotBeCalled = true;
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { providerIds: ["c4-" + ts] } });
        const item = r.body.results.find((x: any) => x.provider_id === "c4-" + ts);
        assertEq(item.outcome, "disqualified_terminal", `c-4-${ts}a: terminal_status=${ts} -> disqualified_terminal`);
        assertEq(item.detail, ts, `c-4-${ts}b: detail reports the exact terminal_status`);
        assertTrue(!("second_line_verification" in readFieldProvenance("c4-" + ts)), `c-4-${ts}c: no stamp written`);
        judgeShouldNotBeCalled = false;
      }

      // c-6: umbrella-routed email (curated static list, isUmbrellaContactEmail)
      // disqualifies, judge never reached.
      seedProvider("c6", { epost: "post@hanen.no" });
      {
        judgeShouldNotBeCalled = true;
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { providerIds: ["c6"] } });
        const item = r.body.results.find((x: any) => x.provider_id === "c6");
        assertEq(item.outcome, "gate_failed", "c-6a: umbrella email -> gate_failed");
        assertEq(item.reasons.email_not_umbrella, false, "c-6b: reasons.email_not_umbrella=false");
        judgeShouldNotBeCalled = false;
      }

      // c-7: hard-bounced email (email_bounces, RFB db, bounce_type='hard')
      // disqualifies — the guardrail this route reuses rather than inventing.
      seedProvider("c7", { epost: "bounced@c7-testgard.no" });
      rfbDb
        .prepare(
          `INSERT INTO email_bounces (email, bounced_at, bounce_type, reason) VALUES (?, datetime('now'), 'hard', 'mailbox does not exist')`,
        )
        .run("bounced@c7-testgard.no");
      {
        judgeShouldNotBeCalled = true;
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { providerIds: ["c7"] } });
        const item = r.body.results.find((x: any) => x.provider_id === "c7");
        assertEq(item.outcome, "disqualified_hard_bounced", "c-7a: hard-bounced email -> disqualified_hard_bounced");
        assertTrue(!("second_line_verification" in readFieldProvenance("c7")), "c-7b: no stamp written");
        judgeShouldNotBeCalled = false;
      }
      // c-8: control — a 'soft' bounce (not hard/complaint) does NOT
      // disqualify, proving the predicate is scoped to hard/complaint only.
      seedProvider("c8", { epost: "soft@c8-testgard.no" });
      rfbDb
        .prepare(
          `INSERT INTO email_bounces (email, bounced_at, bounce_type, reason) VALUES (?, datetime('now'), 'soft', 'mailbox full')`,
        )
        .run("soft@c8-testgard.no");
      {
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { providerIds: ["c8"] } });
        const item = r.body.results.find((x: any) => x.provider_id === "c8");
        assertTrue(item.outcome !== "disqualified_hard_bounced", "c-8a: a soft bounce does NOT trip the hard-bounce guard");
        assertEq(item.outcome, "verified", "c-8b: soft-bounced-but-otherwise-clean row still verifies");
      }

      // c-9: not_found.
      {
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { providerIds: ["does-not-exist"] } });
        const item = r.body.results.find((x: any) => x.provider_id === "does-not-exist");
        assertEq(item.outcome, "not_found", "c-9: unknown id -> not_found, reported");
      }

      // c-10: request validation — empty providerIds -> 400.
      {
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { providerIds: [] } });
        assertEq(r.status, 400, "c-10: empty providerIds -> 400");
      }
      // c-11: request validation — >48 providerIds -> 400.
      {
        const ids = Array.from({ length: 49 }, (_, i) => `x-${i}`);
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { providerIds: ids } });
        assertEq(r.status, 400, "c-11: more than 48 providerIds -> 400");
      }
      // c-12: no admin key -> 403 (same requireAdmin gate as every other
      // admin route in this file).
      {
        const r = await callRoute(opplevelserRouter, { body: { providerIds: ["c1"] } });
        assertEq(r.status, 403, "c-12: no admin key -> 403");
      }

      // c-13: multiple ids in one call, mixed outcomes, nothing silently
      // dropped from the response.
      seedProvider("c13a");
      seedProvider("c13b", { terminal_status: "dod_kilde" });
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { providerIds: ["c13a", "c13b", "c13-missing"] },
        });
        assertEq(r.body.results.length, 3, "c-13a: all three ids reported, nothing dropped");
        const byId = Object.fromEntries(r.body.results.map((x: any) => [x.provider_id, x.outcome]));
        assertEq(byId["c13a"], "verified", "c-13b: c13a verified");
        assertEq(byId["c13b"], "disqualified_terminal", "c-13c: c13b disqualified_terminal");
        assertEq(byId["c13-missing"], "not_found", "c-13d: c13-missing not_found");
      }

      // c-14: lost-update regression (fix-up for reviewer's blocking finding
      // on 43a153d). A concurrent writer (simulated via concurrentWriteFn,
      // fired from inside the mocked judge-fetch call — i.e. mid-await,
      // exactly the window computeGardssalgSecondLineVerification's real
      // network round-trip opens) stamps an UNRELATED field_provenance key
      // on the SAME row before the route's own write lands. The route's
      // write must be built from a FRESH re-read taken after the await, not
      // from the row snapshot read at the top of the loop iteration — so the
      // concurrent writer's key must survive, side-by-side with
      // second_line_verification, in the final row.
      seedProvider("c14");
      {
        concurrentWriteFn = () => {
          const cur = readFieldProvenance("c14");
          cur.concurrent_writer_stamp = { touched_at: "2026-08-29T12:00:00Z", by: "test-concurrent-writer" };
          expDb
            .prepare(`UPDATE experience_providers SET field_provenance = ? WHERE id = ?`)
            .run(JSON.stringify(cur), "c14");
        };
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { providerIds: ["c14"] } });
        const item = r.body.results.find((x: any) => x.provider_id === "c14");
        assertEq(item.outcome, "verified", "c-14a: c14 verifies normally despite the mid-flight concurrent write");
        const prov = readFieldProvenance("c14") as any;
        assertEq(prov.second_line_verification?.verified, true, "c-14b: second_line_verification.verified=true is written");
        assertTrue(
          prov.concurrent_writer_stamp?.by === "test-concurrent-writer",
          "c-14c: lost-update regression — the concurrent writer's key survives the route's write (fresh re-read, not a stale pre-await snapshot)",
        );
        assertEq(concurrentWriteFn, null, "c-14d: concurrentWriteFn hook fired exactly once and cleared itself");
      }
    } catch (err: any) {
      failed++;
      failures.push("second-line (sections B/C): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      const initMod = require("../database/init") as typeof import("../database/init");
      initMod.__setDbForTesting(prevRfbDb);
      globalThis.fetch = prevFetch;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      if (prevFlag === undefined) delete process.env.GS_SECOND_LINE_VERIFICATION_ENABLED;
      else process.env.GS_SECOND_LINE_VERIFICATION_ENABLED = prevFlag;
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOpplevelserGardssalgSecondLineTests(true).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) {
      for (const f of summary.failures) console.log(f);
      process.exit(1);
    }
  });
}
