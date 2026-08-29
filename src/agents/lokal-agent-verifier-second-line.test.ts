/**
 * lokal-agent-verifier-second-line.test.ts — dev-request 2026-08-23-rfb-
 * andrelinje-verifisering-lav-terskel (Fase-1, items 1+2): RFB's second
 * (lower-bar) verification line + the paraply(umbrella)-routing guard.
 *
 * Sections:
 *   A. Pure unit tests (no DB, no network) — isParaplyRoutedEmail,
 *      computeSecondLineIdentitySources, computeSecondLineVerification
 *      (with an injected judgeFn, so no real ANTHROPIC_API_KEY/network
 *      call is ever made by this suite).
 *   B. Flag-OFF byte-identical proof — a table of representative
 *      computeKvalitetsGate/deriveVerificationStatus scenarios (including
 *      ones that WOULD second-line-verify or WOULD paraply-block if the
 *      flag were on) run through the real runVerifierBatch with
 *      RFB_SECOND_LINE_VERIFICATION_ENABLED unset, then explicitly
 *      "false" — both must reproduce exactly what computeKvalitetsGate +
 *      deriveVerificationStatus alone would produce, and a THROWING
 *      judgeFn proves the judge is never even reached.
 *   C. Flag-ON integration tests via runVerifierBatch — second line
 *      passes (+ provenance stamp persisted), judge-reject, NACE-
 *      blacklist short-circuit, Brreg-konkurs short-circuit, paraply
 *      email (both the curated static list and the schema-based
 *      agent_affiliations signal).
 *
 * Exported runLokalAgentVerifierSecondLineTests({log}) -> TestSummary;
 * wired into tests/test.ts via runSerial() at the tail (see that file's
 * own established convention for new registrations).
 * Standalone: npx tsx src/agents/lokal-agent-verifier-second-line.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runLokalAgentVerifierSecondLineTests(
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
    const {
      computeKvalitetsGate,
      deriveVerificationStatus,
      computeSecondLineIdentitySources,
      computeSecondLineVerification,
      isParaplyRoutedEmail,
      runVerifierBatch,
      applyVerifierOutcome,
    } = require("./lokal-agent-verifier") as typeof import("./lokal-agent-verifier");

    // ═══════════════════════════════════════════════════════════════════
    // Section A — pure unit tests (no DB, no network).
    // ═══════════════════════════════════════════════════════════════════
    try {
      // ── isParaplyRoutedEmail ────────────────────────────────────────
      assertTrue(isParaplyRoutedEmail("post@hanen.no"), "a-1: post@hanen.no -> paraply (curated static list)");
      assertTrue(isParaplyRoutedEmail("Post@Hanen.NO"), "a-2: case-insensitive");
      assertTrue(isParaplyRoutedEmail("regional@bm.bondensmarked.no"), "a-3: subdomain of a curated umbrella domain -> paraply");
      assertTrue(!isParaplyRoutedEmail("post@gardsbutikken.no"), "a-4: an ordinary producer domain -> NOT paraply");
      assertTrue(!isParaplyRoutedEmail(null), "a-5: null email -> not paraply (that's the junk-check's job, not this one's)");
      assertTrue(!isParaplyRoutedEmail(""), "a-6: blank email -> not paraply");
      assertTrue(!isParaplyRoutedEmail("not-an-email"), "a-7: no '@' -> not paraply");
      // Schema-based signal: an affiliated umbrella's OWN domain, not on the
      // curated static list at all.
      assertTrue(
        isParaplyRoutedEmail("post@minlokalforening.no", ["minlokalforening.no"]),
        "a-8: schema-based affiliatedUmbrellaDomains match -> paraply, even though NOT on the curated static list",
      );
      assertTrue(
        !isParaplyRoutedEmail("post@minlokalforening.no", ["etannetlag.no"]),
        "a-9: affiliatedUmbrellaDomains present but does NOT match -> not paraply",
      );

      // ── computeSecondLineIdentitySources ────────────────────────────
      assertEq(
        computeSecondLineIdentitySources({ website_ok: false, field_provenance: {}, brreg: null, producer_name: "Testgård" }),
        [],
        "a-10: no signals anywhere -> empty source list",
      );
      assertEq(
        computeSecondLineIdentitySources({ website_ok: true, field_provenance: {}, brreg: null, producer_name: "Testgård" }),
        ["own_website"],
        "a-11: website_ok=true -> own_website",
      );
      assertTrue(
        computeSecondLineIdentitySources({
          website_ok: false,
          field_provenance: { address: [{ value: "x", source_type: "facebook_official_page", source_url: "https://facebook.com/testgard", fetched_at: "2026-08-01T00:00:00Z" }] },
          brreg: null,
          producer_name: "Testgård",
        }).includes("facebook_official_page"),
        "a-12: field_provenance record with source_type facebook_official_page -> detected",
      );
      assertTrue(
        computeSecondLineIdentitySources({
          website_ok: false,
          field_provenance: { address: [{ value: "x", source_type: "directory_listing", source_url: "https://hanen.no/produsent/testgard", fetched_at: "2026-08-01T00:00:00Z" }] },
          brreg: null,
          producer_name: "Testgård",
        }).includes("hanen_no"),
        "a-13: source_url host hanen.no -> detected regardless of source_type string used",
      );
      assertTrue(
        computeSecondLineIdentitySources({
          website_ok: false,
          field_provenance: { phone: { value: "x", source_type: "directory_listing", source_url: "https://bondensmarked.no/produsenter/testgard", fetched_at: "2026-08-01T00:00:00Z" } },
          brreg: null,
          producer_name: "Testgård",
        }).includes("bondensmarked_no"),
        "a-14: single-record (non-array) legacy provenance shape with bondensmarked.no source_url -> also detected",
      );
      assertTrue(
        computeSecondLineIdentitySources({
          website_ok: false,
          field_provenance: { address: [{ value: "x", source_type: "directory_listing", source_url: "https://1881.no/foretak/testgard", fetched_at: "2026-08-01T00:00:00Z" }] },
          brreg: null,
          producer_name: "Testgård",
        }).includes("1881_no"),
        "a-14b: source_url host 1881.no -> detected (dev-request 2026-08-28-gardssalg-kildebredde-wiring Grep 2 gap fix)",
      );
      assertTrue(
        computeSecondLineIdentitySources({
          website_ok: false,
          field_provenance: { phone: { value: "x", source_type: "directory_listing", source_url: "https://siderklynga.no/medlemmer/testgard", fetched_at: "2026-08-01T00:00:00Z" } },
          brreg: null,
          producer_name: "Testgård",
        }).includes("siderklynga_no"),
        "a-14c: single-record (non-array) legacy provenance shape with siderklynga.no source_url -> also detected",
      );
      assertTrue(
        !computeSecondLineIdentitySources({
          website_ok: false,
          field_provenance: { address: [{ value: "x", source_type: "directory_listing", source_url: "https://proff.no/foretak/testgard", fetched_at: "2026-08-01T00:00:00Z" }] },
          brreg: null,
          producer_name: "Testgård",
        }).length,
        "a-14d: source_url host proff.no (NOT in the accepted list) -> no source added, no false-positive widening",
      );
      assertTrue(
        computeSecondLineIdentitySources({
          website_ok: false,
          field_provenance: {},
          brreg: { is_active: true, is_konkurs: false, navn: "Testgård AS" },
          producer_name: "Testgård",
        }).includes("brreg_name_match"),
        "a-15: Brreg navn first-token match ('Testgård' vs 'Testgård AS') -> brreg_name_match",
      );
      assertTrue(
        !computeSecondLineIdentitySources({
          website_ok: false,
          field_provenance: {},
          brreg: { is_active: true, is_konkurs: false, navn: "Et Helt Annet Selskap AS" },
          producer_name: "Testgård",
        }).includes("brreg_name_match"),
        "a-16: Brreg navn does NOT match -> brreg_name_match absent",
      );
      // Malformed field_provenance must never throw.
      assertEq(
        computeSecondLineIdentitySources({ website_ok: false, field_provenance: null as any, brreg: null, producer_name: null }),
        [],
        "a-17: malformed (null) field_provenance -> [] , never throws",
      );

      // ── computeSecondLineVerification (injected judgeFn) ────────────
      const baseInput = {
        producer_name: "Testgård",
        city: "Lillehammer",
        about: "En liten gård som selger egg og grønnsaker direkte fra tunet.",
        products: [{ name: "Egg" }, { name: "Poteter" }],
        email: "kari@testgard.no",
        field_provenance: { address: [{ value: "x", source_type: "facebook_official_page", source_url: "https://facebook.com/testgard", fetched_at: "2026-08-01T00:00:00Z" }] },
        brreg: null as any,
        gate_reasons: { website_ok: false, no_wrong_fit: true, brreg_active: true },
      };

      {
        const r = await computeSecondLineVerification({
          ...baseInput,
          judgeFn: async () => ({ approved: true, reason: "ok" }),
        });
        assertTrue(r.passes, "a-18: all deterministic checks + judge-approve -> passes");
        assertEq(r.sources, ["facebook_official_page"], "a-19: sources reported correctly");
      }
      {
        let judgeCalled = false;
        const r = await computeSecondLineVerification({
          ...baseInput,
          judgeFn: async () => { judgeCalled = true; return { approved: false, reason: "usikker identitet" }; },
        });
        assertTrue(judgeCalled, "a-20: deterministic checks passed -> judge WAS reached");
        assertTrue(!r.passes, "a-21: judge-reject -> does not pass");
      }
      {
        // NACE blacklist -> must short-circuit BEFORE the judge is ever
        // called (cost control), even though email+source are otherwise fine.
        let judgeCalled = false;
        const r = await computeSecondLineVerification({
          ...baseInput,
          gate_reasons: { website_ok: false, no_wrong_fit: false, brreg_active: true },
          judgeFn: async () => { judgeCalled = true; return { approved: true }; },
        });
        assertTrue(!r.passes, "a-22: no_wrong_fit=false (NACE blacklist) -> fails even with everything else good");
        assertTrue(!judgeCalled, "a-23: NACE blacklist -> judge never called");
      }
      {
        // Brreg konkurs/inactive -> same short-circuit.
        let judgeCalled = false;
        const r = await computeSecondLineVerification({
          ...baseInput,
          gate_reasons: { website_ok: false, no_wrong_fit: true, brreg_active: false },
          judgeFn: async () => { judgeCalled = true; return { approved: true }; },
        });
        assertTrue(!r.passes, "a-24: brreg_active=false (konkurs/slettet) -> fails even with everything else good");
        assertTrue(!judgeCalled, "a-25: brreg inactive -> judge never called");
      }
      {
        // No accepted source at all.
        let judgeCalled = false;
        const r = await computeSecondLineVerification({
          ...baseInput,
          field_provenance: {},
          judgeFn: async () => { judgeCalled = true; return { approved: true }; },
        });
        assertTrue(!r.passes, "a-26: zero accepted identity sources -> fails");
        assertTrue(!judgeCalled, "a-27: zero sources -> judge never called");
      }
      {
        // Junk email (favicon-shaped) — reused from contact-candidate-judge.
        let judgeCalled = false;
        const r = await computeSecondLineVerification({
          ...baseInput,
          email: "favicon@2x.png",
          judgeFn: async () => { judgeCalled = true; return { approved: true }; },
        });
        assertTrue(!r.passes, "a-28: junk/favicon-shaped email -> fails");
        assertTrue(!judgeCalled, "a-29: junk email -> judge never called");
      }
      {
        // Paraply email — never accepted on the second line either.
        let judgeCalled = false;
        const r = await computeSecondLineVerification({
          ...baseInput,
          email: "post@hanen.no",
          judgeFn: async () => { judgeCalled = true; return { approved: true }; },
        });
        assertTrue(!r.passes, "a-30: paraply-routed email -> second line never passes on it");
        assertTrue(!judgeCalled, "a-31: paraply email -> judge never called");
      }
      {
        // No email at all.
        const r = await computeSecondLineVerification({
          ...baseInput,
          email: null,
          judgeFn: async () => ({ approved: true }),
        });
        assertTrue(!r.passes, "a-32: no email -> fails");
      }
    } catch (err: any) {
      failed++;
      failures.push("second-line (section A): unexpected error: " + String(err?.stack || err?.message || err));
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section A2 — judgeSecondLineProfile's OWN fail-closed HTTP contract,
    // direct unit tests (fetch mocking) — mirrors contact-candidate-judge.
    // test.ts's Section B exactly: missing key / network throw / non-200 /
    // unparseable JSON / ambiguous text / clean approval / clean rejection.
    // ═══════════════════════════════════════════════════════════════════
    {
      const { judgeSecondLineProfile } = require("../services/second-line-profile-judge") as
        typeof import("../services/second-line-profile-judge");
      const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
      const prevFetch = globalThis.fetch;
      try {
        const CALL_PARAMS = {
          businessName: "Testgård AS",
          city: "Lillehammer",
          about: "En liten gård som selger egg.",
          products: ["Egg"],
          email: "kari@testgard.no",
          acceptedSources: ["facebook_official_page"],
        };

        // a2-1: missing ANTHROPIC_API_KEY -> approved:false, fetch NEVER invoked.
        delete process.env.ANTHROPIC_API_KEY;
        globalThis.fetch = (async () => {
          throw new Error("a2-1: fetch must NOT be called when ANTHROPIC_API_KEY is missing");
        }) as unknown as typeof fetch;
        {
          const v = await judgeSecondLineProfile(CALL_PARAMS);
          assertEq(v.approved, false, "a2-1: missing ANTHROPIC_API_KEY -> approved:false");
        }

        process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

        // a2-2: network throw -> approved:false, not re-thrown.
        globalThis.fetch = (async () => { throw new Error("simulated network failure"); }) as unknown as typeof fetch;
        {
          const v = await judgeSecondLineProfile(CALL_PARAMS);
          assertEq(v.approved, false, "a2-2: fetch throw (network failure) -> approved:false, not re-thrown");
        }

        // a2-3: non-200 response -> approved:false.
        globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) })) as unknown as typeof fetch;
        {
          const v = await judgeSecondLineProfile(CALL_PARAMS);
          assertEq(v.approved, false, "a2-3: non-200 response -> approved:false");
        }

        // a2-4: unparseable JSON -> approved:false.
        globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } })) as unknown as typeof fetch;
        {
          const v = await judgeSecondLineProfile(CALL_PARAMS);
          assertEq(v.approved, false, "a2-4: unparseable JSON -> approved:false");
        }

        // a2-5: ambiguous/garbled model text (neither exact token) -> approved:false.
        globalThis.fetch = (async () => ({
          ok: true, status: 200,
          json: async () => ({ content: [{ type: "text", text: "Kanskje? Vet ikke helt." }] }),
        })) as unknown as typeof fetch;
        {
          const v = await judgeSecondLineProfile(CALL_PARAMS);
          assertEq(v.approved, false, "a2-5: ambiguous model text -> approved:false, fail-closed");
        }

        // a2-6: exact reject token -> approved:false with the model's reason surfaced.
        globalThis.fetch = (async () => ({
          ok: true, status: 200,
          json: async () => ({ content: [{ type: "text", text: "AVVIS\nFor tynt bevisgrunnlag." }] }),
        })) as unknown as typeof fetch;
        {
          const v = await judgeSecondLineProfile(CALL_PARAMS);
          assertEq(v.approved, false, "a2-6: exact AVVIS token -> approved:false");
          assertTrue(/tynt/i.test(v.reason ?? ""), "a2-7: rejection reason is surfaced");
        }

        // a2-8: exact approve token -> approved:true with the model's reason surfaced.
        globalThis.fetch = (async () => ({
          ok: true, status: 200,
          json: async () => ({ content: [{ type: "text", text: "GODKJENN\nNavn og sted stemmer overens." }] }),
        })) as unknown as typeof fetch;
        {
          const v = await judgeSecondLineProfile(CALL_PARAMS);
          assertEq(v.approved, true, "a2-8: exact GODKJENN token -> approved:true");
          assertTrue(/stemmer/i.test(v.reason ?? ""), "a2-9: approval reason is surfaced");
        }
      } catch (err: any) {
        failed++;
        failures.push("second-line (section A2, judgeSecondLineProfile HTTP contract): unexpected error: " + String(err?.stack || err?.message || err));
      } finally {
        if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
        globalThis.fetch = prevFetch;
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Sections B + C — runVerifierBatch integration (isolated in-memory DB).
    // ═══════════════════════════════════════════════════════════════════
    const prevDb = initMod.getDb();
    const prevFlag = process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
    const db = new Database(":memory:");
    try {
      db.pragma("journal_mode = DELETE");
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_verified)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?, ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, address, phone, email, website, about, products, field_provenance, verification_status, enrichment_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_verify', 'partial')`,
      );

      function domainFromEmail(email: string | null | undefined): string | null {
        if (!email || !email.includes("@")) return null;
        return email.split("@")[1] || null;
      }

      function seedAgent(id: string, opts: {
        name?: string;
        website?: string | null;
        email?: string | null;
        about?: string | null;
        products?: unknown[];
        field_provenance?: Record<string, unknown>;
        isVerified?: boolean;
      } = {}): void {
        // agents.url is NOT NULL — always supply a registration URL. This
        // suite is testing the SECOND-line gate specifically, so agents.url
        // is deliberately pinned to the SAME domain as the email (an
        // EXISTING, unrelated guard — domainCoherenceCheck — would
        // otherwise downgrade every scenario to review_required purely
        // because a random placeholder registration host disagrees with
        // the test email's domain, which is noise unrelated to what these
        // tests are checking). agent_knowledge.website stays independently
        // controlled by opts.website below — that is the SEPARATE, nullable
        // column the gate/second-line logic actually reads.
        const effectiveEmail = opts.email === undefined ? "kari@testgard.no" : opts.email;
        const emailDom = domainFromEmail(effectiveEmail);
        const agentUrl = emailDom ? `https://${emailDom}` : `https://example-registration.invalid/${id}`;
        insertAgent.run(id, opts.name ?? "Testgård " + id, agentUrl, "key-" + id, opts.isVerified ? 1 : 0);
        insertKnowledge.run(
          id,
          "Testveien 1, 2600 Lillehammer",
          "91234567",
          opts.email === undefined ? "kari@testgard.no" : opts.email,
          opts.website ?? null,
          opts.about ?? "En liten gård som selger egg og grønnsaker direkte fra tunet. Familiedrevet i tre generasjoner.",
          JSON.stringify(opts.products ?? [{ name: "Egg" }, { name: "Poteter" }, { name: "Honning" }]),
          JSON.stringify(opts.field_provenance ?? {}),
        );
      }

      function knowledgeRow(id: string): any {
        return db.prepare(
          `SELECT verification_status, verified_second_line, verified_second_line_at, verified_second_line_sources
             FROM agent_knowledge WHERE agent_id = ?`
        ).get(id);
      }

      // pickFn scoped to exactly ONE agent id, to keep each scenario isolated.
      function pickOnly(id: string) {
        return (dbi: any) => dbi.prepare(
          `SELECT a.id, a.name, a.url AS agent_url, a.city AS location_city, a.is_verified,
                  k.email, k.phone, k.address, k.website, k.about, k.products, k.field_provenance,
                  k.verification_status, k.enrichment_status,
                  k.last_verified_at, k.last_http_check_at, k.last_http_status
             FROM agents a INNER JOIN agent_knowledge k ON k.agent_id = a.id
            WHERE a.id = ?`
        ).all(id);
      }

      const throwingJudge = async (): Promise<{ approved: boolean; reason?: string }> => {
        throw new Error("second-line judge must NOT have been called in this scenario");
      };

      async function runOne(id: string, opts: { flag?: string; judgeFn?: any; headProbeStatus?: number | null } = {}) {
        const prev = process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
        if (opts.flag === undefined) delete process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
        else process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED = opts.flag;
        try {
          const result = await runVerifierBatch({
            db,
            pickFn: pickOnly(id),
            headProbe: async () => (opts.headProbeStatus === undefined ? null : opts.headProbeStatus),
            brregLookup: null,
            secondLineJudgeFn: opts.judgeFn,
          });
          return result.results[0];
        } finally {
          if (prev === undefined) delete process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
          else process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED = prev;
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // Section B — flag-off byte-identical proof.
      // ═══════════════════════════════════════════════════════════════

      // b-1: no website, thin evidence -> pending_verify (first-line-only).
      seedAgent("b1", { website: null, about: "kort", products: [], field_provenance: {} });
      // b-2: NACE-blacklisted Brreg naering -> review_required regardless of flag.
      // (brreg is passed via opts.brregLookup=null in this suite, so we can't
      // exercise brreg-derived flags through runVerifierBatch directly here —
      // covered instead by computeKvalitetsGate's OWN existing test suite,
      // which this PR does not touch. b1/b3/b4/b5 below exercise the flag's
      // effect on paths runVerifierBatch DOES control end-to-end.)
      // b-3: would-be second-line-eligible (no website, but a
      // facebook_official_page source + a good email) -> MUST stay
      // pending_verify with the flag off (this is the key proof that the
      // second line is not even attempted).
      seedAgent("b3", {
        website: null,
        email: "kari@testgard.no",
        field_provenance: { address: [{ value: "x", source_type: "facebook_official_page", source_url: "https://facebook.com/testgard", fetched_at: "2026-08-01T00:00:00Z" }] },
      });
      // b-4: paraply-routed email, no website -> MUST stay pending_verify
      // (NOT paraply_epost_mangler) with the flag off.
      seedAgent("b4", { website: null, email: "post@hanen.no" });
      // b-5: a normal, gate-passing profile (live website, matching-domain
      // email, decent content) with empty field_provenance -> gate.passes
      // true, cross-source data_insufficient (0 sources) -> deriveVerificationStatus
      // returns 'data_insufficient' either way; proves the flag doesn't
      // perturb the passes=true path either.
      seedAgent("b5", { website: "https://testgard.no", email: "kari@testgard.no", field_provenance: {} });

      for (const flagValue of [undefined, "false"] as const) {
        const r1 = await runOne("b1", { flag: flagValue, judgeFn: throwingJudge });
        assertEq(r1.new_verification_status, "pending_verify", `b-flag(${flagValue}): b1 thin/no-website -> pending_verify`);
        assertEq(r1.verified_second_line, false, `b-flag(${flagValue}): b1 verified_second_line=false in result`);

        const r3 = await runOne("b3", { flag: flagValue, judgeFn: throwingJudge });
        assertEq(r3.new_verification_status, "pending_verify", `b-flag(${flagValue}): b3 would-be-second-line-eligible -> STILL pending_verify (second line not attempted)`);
        assertEq(knowledgeRow("b3").verified_second_line, 0, `b-flag(${flagValue}): b3 verified_second_line column stays 0`);

        const r4 = await runOne("b4", { flag: flagValue, judgeFn: throwingJudge });
        assertEq(r4.new_verification_status, "pending_verify", `b-flag(${flagValue}): b4 paraply email -> STILL pending_verify, NOT paraply_epost_mangler (guard off)`);

        const r5 = await runOne("b5", { flag: flagValue, judgeFn: throwingJudge, headProbeStatus: 200 });
        assertEq(r5.new_verification_status, "data_insufficient", `b-flag(${flagValue}): b5 gate-passing/0-cross-source-sources control -> data_insufficient, unaffected by the flag`);
      }
      // If any throwingJudge had fired, the awaited runVerifierBatch call
      // above would have rejected and this whole try-block would already
      // have jumped to the catch — reaching here at all is itself part of
      // the proof that the judge was never invoked with the flag off.
      assertTrue(true, "b-6: no scenario above ever invoked the (throwing) second-line judge while the flag was off/false");

      // ═══════════════════════════════════════════════════════════════
      // Section C — flag-ON integration tests.
      // ═══════════════════════════════════════════════════════════════

      // c-1: second line passes (good email + judge-approve + 1 accepted
      // source + NACE/Brreg clean [brregLookup=null -> both default true]).
      seedAgent("c1", {
        website: null,
        email: "kari@testgard.no",
        field_provenance: { address: [{ value: "x", source_type: "facebook_official_page", source_url: "https://facebook.com/testgard", fetched_at: "2026-08-01T00:00:00Z" }] },
      });
      {
        const r = await runOne("c1", { flag: "true", judgeFn: async () => ({ approved: true, reason: "identitet bekreftet" }) });
        assertEq(r.new_verification_status, "verified", "c-1: second-line pass -> verified");
        assertEq(r.verified_second_line, true, "c-2: VerifierResult.verified_second_line=true");
        const row = knowledgeRow("c1");
        assertEq(row.verification_status, "verified", "c-3: DB verification_status=verified");
        assertEq(row.verified_second_line, 1, "c-4: DB verified_second_line=1 (provenance stamp set)");
        assertTrue(!!row.verified_second_line_at, "c-5: DB verified_second_line_at is set");
        const sources = JSON.parse(row.verified_second_line_sources || "[]");
        assertTrue(Array.isArray(sources) && sources.includes("facebook_official_page"), "c-6: DB verified_second_line_sources records the accepted source");
      }

      // c-7: judge rejects -> stays pending_verify (not verified), no stamp.
      seedAgent("c7", {
        website: null,
        email: "kari@testgard.no",
        field_provenance: { address: [{ value: "x", source_type: "facebook_official_page", source_url: "https://facebook.com/testgard", fetched_at: "2026-08-01T00:00:00Z" }] },
      });
      {
        const r = await runOne("c7", { flag: "true", judgeFn: async () => ({ approved: false, reason: "for tynt grunnlag" }) });
        assertEq(r.new_verification_status, "pending_verify", "c-7: judge-reject -> stays pending_verify");
        assertEq(knowledgeRow("c7").verified_second_line, 0, "c-8: judge-reject -> no provenance stamp");
      }

      // c-9: NACE-blacklist disqualifies second line even with everything
      // else good. Since runVerifierBatch's opts.brregLookup is what feeds
      // computeKvalitetsGate's `brreg` input, we wire a brregLookup here
      // (only for this scenario) that returns a blacklisted naering.
      seedAgent("c9", {
        website: null,
        email: "kari@testgard.no",
        field_provenance: { address: [{ value: "x", source_type: "facebook_official_page", source_url: "https://facebook.com/testgard", fetched_at: "2026-08-01T00:00:00Z" }] },
      });
      {
        const prevFlagInner = process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
        process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED = "true";
        try {
          const result = await runVerifierBatch({
            db,
            pickFn: pickOnly("c9"),
            headProbe: async () => null,
            brregLookup: async () => ({ is_active: true, is_konkurs: false, naering: "Drift av restauranter" }),
            secondLineJudgeFn: throwingJudge,
          });
          const r = result.results[0];
          assertEq(r.new_verification_status, "review_required", "c-9: NACE-blacklist -> review_required, second line does not override it");
          assertEq(knowledgeRow("c9").verified_second_line, 0, "c-10: NACE-blacklist -> no provenance stamp (judge never reached, proven by throwingJudge not throwing)");
        } finally {
          if (prevFlagInner === undefined) delete process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
          else process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED = prevFlagInner;
        }
      }

      // c-11: Brreg konkurs disqualifies second line even with everything
      // else good.
      seedAgent("c11", {
        website: null,
        email: "kari@testgard.no",
        field_provenance: { address: [{ value: "x", source_type: "facebook_official_page", source_url: "https://facebook.com/testgard", fetched_at: "2026-08-01T00:00:00Z" }] },
      });
      {
        const prevFlagInner = process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
        process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED = "true";
        try {
          const result = await runVerifierBatch({
            db,
            pickFn: pickOnly("c11"),
            headProbe: async () => null,
            brregLookup: async () => ({ is_active: false, is_konkurs: true, naering: null }),
            secondLineJudgeFn: throwingJudge,
          });
          const r = result.results[0];
          assertEq(r.new_verification_status, "review_required", "c-11: Brreg konkurs -> review_required (via first-line's own NACE/Brreg flag branch), second line does not override");
          assertEq(knowledgeRow("c11").verified_second_line, 0, "c-12: Brreg konkurs -> no provenance stamp");
        } finally {
          if (prevFlagInner === undefined) delete process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
          else process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED = prevFlagInner;
        }
      }

      // c-13: paraply-routed email (curated static list) -> paraply_epost_mangler.
      seedAgent("c13", { website: null, email: "post@hanen.no" });
      {
        const r = await runOne("c13", { flag: "true", judgeFn: throwingJudge });
        assertEq(r.new_verification_status, "paraply_epost_mangler", "c-13: paraply email (static list) -> paraply_epost_mangler");
        assertEq(knowledgeRow("c13").verification_status, "paraply_epost_mangler", "c-14: DB also reflects paraply_epost_mangler");
      }

      // c-15: paraply-routed email via the SCHEMA-BASED signal
      // (agent_affiliations -> an umbrella agent's own domain), NOT on the
      // curated static list at all.
      insertAgent.run("umbrella-x", "Andelslaget X", "https://andelslaget-x.no", "key-umbrella-x", 0);
      insertKnowledge.run("umbrella-x", null, null, null, "https://andelslaget-x.no", null, "[]", "{}");
      seedAgent("c15", { website: null, email: "post@andelslaget-x.no" });
      db.prepare(
        `INSERT INTO agent_affiliations (producer_id, umbrella_id, status, source)
         VALUES (?, ?, 'active', 'admin')`
      ).run("c15", "umbrella-x");
      {
        const r = await runOne("c15", { flag: "true", judgeFn: throwingJudge });
        assertEq(r.new_verification_status, "paraply_epost_mangler", "c-15: paraply email via agent_affiliations schema signal (not on the static list) -> paraply_epost_mangler");
      }
      // Control: an active affiliation to an umbrella whose domain does NOT
      // match the producer's email -> must NOT trip the guard.
      seedAgent("c16", { website: null, email: "kari@testgard.no" });
      db.prepare(
        `INSERT INTO agent_affiliations (producer_id, umbrella_id, status, source)
         VALUES (?, ?, 'active', 'admin')`
      ).run("c16", "umbrella-x");
      {
        const r = await runOne("c16", { flag: "true", judgeFn: throwingJudge });
        assertTrue(r.new_verification_status !== "paraply_epost_mangler", "c-17: affiliation present but email domain does NOT match the umbrella's own domain -> guard does not fire");
      }
    } catch (err: any) {
      failed++;
      failures.push("second-line (sections B/C): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevFlag === undefined) delete process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
      else process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED = prevFlag;
      try { db.close(); } catch { /* ignore */ }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runLokalAgentVerifierSecondLineTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) {
      for (const f of summary.failures) console.log(f);
      process.exit(1);
    }
  });
}
