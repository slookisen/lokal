/**
 * opplevelser-gardssalg-kildeklasse-contact.test.ts — dev-request 2026-08-28-
 * gardssalg-kildebredde-wiring, Grep 3: 1881.no / bransje-medlemslister
 * (siderklynga.no, hanen.no) as an approved contact-candidate kildeklasse.
 * POST /admin/gardssalg-kildeklasse-contact-intake.
 *
 * Sections:
 *   A. Flag-OFF no-op proof — {enabled:false}, zero DB/network side effects.
 *   B. Request-validation (malformed candidates, oversized array, duplicate
 *      providerId within one call) — all before any DB/network work.
 *   C. Flag-ON integration (mocked globalThis.fetch for the Anthropic judge
 *      call; the route makes no other outbound fetch of its own):
 *      - invalid_source_url (including the proff.no non-goal case)
 *      - not_found / locked / blocklisted pre-checks
 *      - AC4: an epost candidate sourced from 1881.no is written, through
 *        the domain-gate + judge, with 1881 provenance (source_url +
 *        source_type) recorded
 *      - deterministic phone validation BEFORE the LLM judge (the ordering
 *        proof this dev-request calls out by name: FUNN
 *        m0e-dommer-avviser-gyldige-telefonnumre, 2026-08-27) — a formatted/
 *        country-code-prefixed phone number is normalised to 8 bare digits
 *        BEFORE the (mocked) judge ever sees it; the SAME mock rejects
 *        anything that is not already exactly 8 digits, so a pass here is
 *        only possible if normalisation ran first. A companion case proves
 *        a candidate that CANNOT normalise to 8 digits is rejected
 *        deterministically and the judge is never invoked for it at all
 *        (no fetch call).
 *      - fill-only / "egen side vinner ved avvik": an already-filled field
 *        is never overwritten; a hjemmeside-domain-mismatched email is
 *        withheld (flagged for review) rather than written
 *      - judge-reject -> not written, reported
 *      - the route never issues a fetch to any host other than
 *        api.anthropic.com (proves proff/gulesider/1881/etc. are never
 *        fetched by this code — only ever caller-supplied provenance)
 *
 * Same conventions as sibling gårdssalg route test files
 * (opplevelser-gardssalg-second-line.test.ts / opplevelser-gardssalg-
 * website-discovery.test.ts): :memory: experiences DB via db-factory,
 * :memory: RFB db via database/init's __setDbForTesting/
 * __initSchemaForTesting (agent_blocklist lives there), fresh requires,
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
    const url = opts.url || "/admin/gardssalg-kildeklasse-contact-intake";
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

export function runOpplevelserGardssalgKildeklasseContactTests(
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
    const prevFetch = globalThis.fetch;
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFlag = process.env.GS_KILDEKLASSE_CONTACT_ENABLED;
    const testKey = process.env.ADMIN_KEY || "gardssalg-kk-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const blocklistPath = require.resolve("../services/blocklist-service");
    const opplevelserPath = require.resolve("./opplevelser");
    const providerWorkQueuePath = require.resolve("../services/provider-work-queue");
    const cachePaths = [dbFactoryPath, experienceStorePath, blocklistPath, opplevelserPath, providerWorkQueuePath];
    for (const p of cachePaths) delete require.cache[p];

    let prevRfbDb: any = null;

    try {
      // Blocklist gate reads agent_blocklist, which lives on the RFB db
      // (database/init.ts), NOT the experiences db — inject a fresh
      // :memory: instance (same pattern as the other gårdssalg route test
      // files that exercise the blocklist gate).
      const initMod = require("../database/init") as typeof import("../database/init");
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const rfbDb = new Database(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);
      const blocklistSvc = require("../services/blocklist-service") as typeof import("../services/blocklist-service");

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const adminHeaders = { "x-admin-key": testKey };

      // ── Anthropic (LLM-judge) mock ──────────────────────────────────────
      // Keyed on the candidate string embedded in the prompt (same regex
      // extraction convention opplevelser-gardssalg-contact-backfill.test.ts
      // uses). `phoneJudgeRejectsUnlessExactly8Digits`: the ordering proof
      // for AC4's "deterministic telefonvalidering FØR LLM-dom" — while true,
      // the mock REJECTS any candidate that is not already exactly 8 digits,
      // simulating (a sharper, deliberately-strict version of) the
      // self-contradictory real-world rejection FUNN
      // m0e-dommer-avviser-gyldige-telefonnumre (2026-08-27) recorded for
      // unnormalised-but-valid numbers. A pass through the real route is only
      // possible if the route itself normalised the number to 8 digits BEFORE
      // this mock ever saw it.
      let anthropicRejectCandidates = new Set<string>();
      let phoneJudgeRejectsUnlessExactly8Digits = false;
      const fetchCallsToAnthropic: string[] = [];
      const fetchCallsToOtherHosts: string[] = [];
      globalThis.fetch = (async (input: any, init?: any) => {
        const url = String(input);
        if (url.includes("api.anthropic.com")) {
          const body = init?.body ? JSON.parse(init.body) : {};
          const prompt: string = body?.messages?.[0]?.content ?? "";
          const m = prompt.match(/^Kandidat \([^)]+\): (.+)$/m);
          const candidate = m ? m[1].trim() : "";
          fetchCallsToAnthropic.push(candidate);
          if (anthropicRejectCandidates.has(candidate)) {
            return {
              ok: true, status: 200,
              json: async () => ({ content: [{ type: "text", text: "AVVIS\nSer ut som sidestøy, ikke ekte kontaktinfo for denne produsenten." }] }),
            } as any;
          }
          if (phoneJudgeRejectsUnlessExactly8Digits && prompt.includes("telefonnummer") && !/^\d{8}$/.test(candidate)) {
            return {
              ok: true, status: 200,
              json: async () => ({ content: [{ type: "text", text: "AVVIS\nFor kort/uvanlig format for et telefonnummer som typisk har 8 siffer." }] }),
            } as any;
          }
          return {
            ok: true, status: 200,
            json: async () => ({ content: [{ type: "text", text: "GODKJENN\nEkte kontaktinfo for produsenten." }] }),
          } as any;
        }
        fetchCallsToOtherHosts.push(url);
        return { ok: false, status: 404, json: async () => ({}) } as any;
      }) as any;

      const insertProviderStmt = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, kommune, poststed, hjemmeside, epost, telefon,
            catalog_hidden, content_source, products, producer_type,
            enrichment_state, verification_status, source, confidence, field_provenance)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @kommune, @poststed, @hjemmeside, @epost, @telefon,
            @catalog_hidden, @content_source, '["x"]', @producer_type,
            'raw', 'pending_verify', 'test-fixture', 'medium', @field_provenance)`,
      );
      // experience_providers.org_nr is UNIQUE — a padded-id derivation risks
      // collisions between ids sharing a prefix (e.g. "c1" vs "c10"), so
      // every auto-generated org_nr instead comes from a strictly
      // incrementing counter (same allocator idiom
      // opplevelser-gardssalg-contact-backfill.test.ts uses for its own
      // per-fixture org-nr allocation).
      let nextAutoOrgNrSeq = 900000000;
      function seedProvider(id: string, opts: {
        navn?: string;
        org_nr?: string;
        kommune?: string;
        hjemmeside?: string | null;
        epost?: string | null;
        telefon?: string | null;
        catalog_hidden?: number | null;
        content_source?: string | null;
        producer_type?: string | null;
        field_provenance?: Record<string, unknown> | null;
      } = {}): void {
        insertProviderStmt.run({
          id,
          navn: opts.navn ?? "Testgård " + id,
          org_nr: opts.org_nr ?? String(++nextAutoOrgNrSeq),
          kommune: opts.kommune ?? "Lillehammer",
          poststed: null,
          hjemmeside: opts.hjemmeside === undefined ? null : opts.hjemmeside,
          epost: opts.epost === undefined ? null : opts.epost,
          telefon: opts.telefon === undefined ? null : opts.telefon,
          catalog_hidden: opts.catalog_hidden ?? null,
          content_source: opts.content_source === undefined ? null : opts.content_source,
          producer_type: opts.producer_type ?? "sideri",
          field_provenance: opts.field_provenance === undefined ? null : JSON.stringify(opts.field_provenance),
        });
      }

      function readRow(id: string): any {
        return expDb.prepare(`SELECT * FROM experience_providers WHERE id = ?`).get(id) as any;
      }
      function readFieldProvenance(id: string): Record<string, unknown> {
        const row = readRow(id);
        return row?.field_provenance ? JSON.parse(row.field_provenance) : {};
      }

      // ═══════════════════════════════════════════════════════════════
      // Section A — flag-off no-op proof.
      // ═══════════════════════════════════════════════════════════════
      seedProvider("a1"); // would fully succeed if the flag were on
      for (const flagValue of [undefined, "false"] as const) {
        if (flagValue === undefined) delete process.env.GS_KILDEKLASSE_CONTACT_ENABLED;
        else process.env.GS_KILDEKLASSE_CONTACT_ENABLED = flagValue;
        fetchCallsToAnthropic.length = 0;
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ providerId: "a1", sourceType: "1881", sourceUrl: "https://www.1881.no/bedrift/a1", email: "post@a1-testgard.no" }] },
        });
        assertEq(r.body, { enabled: false }, `a-flag(${flagValue}): pure {enabled:false} no-op response`);
        assertEq(fetchCallsToAnthropic.length, 0, `a-flag(${flagValue}): judge never called`);
        assertEq(readRow("a1").epost, null, `a-flag(${flagValue}): epost NOT written`);
        assertTrue(!("epost" in readFieldProvenance("a1")), `a-flag(${flagValue}): field_provenance NOT touched`);
      }

      // ═══════════════════════════════════════════════════════════════
      // Section B — request validation (flag ON for all of section B/C).
      // ═══════════════════════════════════════════════════════════════
      process.env.GS_KILDEKLASSE_CONTACT_ENABLED = "true";

      {
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { candidates: [] } });
        assertEq(r.status, 400, "b-1: empty candidates array -> 400");
      }
      {
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: {} });
        assertEq(r.status, 400, "b-2: missing candidates -> 400");
      }
      {
        // missing sourceUrl -> malformed item poisons the whole call
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ providerId: "x", sourceType: "1881", email: "a@b.no" }] },
        });
        assertEq(r.status, 400, "b-3: candidate missing sourceUrl -> 400 (whole call, never a silent partial run)");
      }
      {
        // unknown sourceType -> malformed
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ providerId: "x", sourceType: "proff", sourceUrl: "https://proff.no/x", email: "a@b.no" }] },
        });
        assertEq(r.status, 400, "b-4: sourceType='proff' is not a recognised kildeklasse -> 400 (proff is never a source-of-record)");
      }
      {
        // neither email nor phone -> malformed
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ providerId: "x", sourceType: "1881", sourceUrl: "https://www.1881.no/bedrift/x" }] },
        });
        assertEq(r.status, 400, "b-5: candidate with neither email nor phone -> 400");
      }
      {
        // oversized array -> 400
        const many = Array.from({ length: 49 }, (_, i) => ({
          providerId: "p" + i, sourceType: "1881" as const, sourceUrl: "https://www.1881.no/bedrift/" + i, email: `a${i}@x.no`,
        }));
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { candidates: many } });
        assertEq(r.status, 400, "b-6: 49 candidates (> cap of 48) -> 400");
      }
      {
        // duplicate providerId within one call
        seedProvider("b7");
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: {
            candidates: [
              { providerId: "b7", sourceType: "1881", sourceUrl: "https://www.1881.no/bedrift/b7", email: "post@b7-testgard.no" },
              { providerId: "b7", sourceType: "hanen", sourceUrl: "https://www.hanen.no/produsent/b7", email: "other@b7-testgard.no" },
            ],
          },
        });
        const items = r.body.results as any[];
        assertEq(items[0].outcome, "written", "b-7a: first occurrence processed normally");
        assertEq(items[1].outcome, "duplicate_provider_in_request", "b-7b: second occurrence in the SAME call -> duplicate_provider_in_request, not processed");
        assertEq(readRow("b7").epost, "post@b7-testgard.no", "b-7c: only the first candidate's email was written");
      }

      // ═══════════════════════════════════════════════════════════════
      // Section C — flag-ON integration.
      // ═══════════════════════════════════════════════════════════════

      // c-1 (AC4): 1881 epost candidate -> written, through domain-gate +
      // judge, with 1881 provenance (source_url + source_type) recorded.
      seedProvider("c1", { navn: "Sideri C1" });
      {
        fetchCallsToAnthropic.length = 0;
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: {
            candidates: [{
              providerId: "c1", sourceType: "1881", sourceUrl: "https://www.1881.no/bedrift/c1-sideri",
              email: "post@c1-sideri.no", sourceContext: "1881-oppføring: org.nr 900000001, e-post post@c1-sideri.no.",
            }],
          },
        });
        const item = r.body.results.find((x: any) => x.provider_id === "c1");
        assertEq(item.outcome, "written", "c-1a: outcome=written");
        assertEq(item.written, ["epost"], "c-1b: epost is the field written");
        assertTrue(fetchCallsToAnthropic.length === 1, "c-1c: the shared LLM judge WAS called (evidence-gate not bypassed)");
        const row = readRow("c1");
        assertEq(row.epost, "post@c1-sideri.no", "c-1d: epost column written");
        const prov = readFieldProvenance("c1") as any;
        assertEq(prov.epost?.source_url, "https://www.1881.no/bedrift/c1-sideri", "c-1e: provenance.epost.source_url = the 1881 page URL");
        assertEq(prov.epost?.source_type, "1881", "c-1f: provenance.epost.source_type = '1881' (AC4's own wording: '1881-provenance')");
        assertTrue(typeof prov.epost?.fetched_at === "string", "c-1g: fetched_at timestamp set");
      }

      // c-2: proff.no can NEVER be the recorded source-of-record — even as a
      // sourceUrl under sourceType "1881", a proff.no url fails the
      // host-integrity check (this route never fetches proff.no either way).
      seedProvider("c2");
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ providerId: "c2", sourceType: "1881", sourceUrl: "https://www.proff.no/bedrift/c2", email: "post@c2.no" }] },
        });
        const item = r.body.results.find((x: any) => x.provider_id === "c2");
        assertEq(item.outcome, "invalid_source_url", "c-2a: proff.no url under sourceType '1881' -> invalid_source_url");
        assertTrue(!fetchCallsToOtherHosts.some((u) => u.includes("proff.no")), "c-2b: proff.no was never fetched by this route");
      }

      // c-3: hanen epost candidate — a different, independently-valid
      // sourceType, proving the host-allowlist is per-type, not hardcoded to
      // 1881 alone.
      seedProvider("c3");
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ providerId: "c3", sourceType: "hanen", sourceUrl: "https://www.hanen.no/produsent/c3", email: "post@c3-testgard.no" }] },
        });
        const item = r.body.results.find((x: any) => x.provider_id === "c3");
        assertEq(item.outcome, "written", "c-3a: hanen-sourced email written");
        assertEq(readFieldProvenance("c3").epost?.source_type, "hanen", "c-3b: source_type='hanen' recorded");
      }
      // c-3b: sourceUrl/sourceType mismatch (siderklynga URL under hanen type).
      seedProvider("c3b");
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ providerId: "c3b", sourceType: "hanen", sourceUrl: "https://www.siderklynga.no/produsent/c3b", email: "post@c3b.no" }] },
        });
        const item = r.body.results.find((x: any) => x.provider_id === "c3b");
        assertEq(item.outcome, "invalid_source_url", "c-3c: siderklynga.no url declared as sourceType 'hanen' -> invalid_source_url");
      }

      // c-4: not_found.
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ providerId: "does-not-exist", sourceType: "1881", sourceUrl: "https://www.1881.no/bedrift/x", email: "a@b.no" }] },
        });
        const item = r.body.results.find((x: any) => x.provider_id === "does-not-exist");
        assertEq(item.outcome, "not_found", "c-4: unknown provider id -> not_found, reported (never silently dropped)");
      }

      // c-5: locked (content_source='manual') -> never processed.
      seedProvider("c5", { content_source: "manual" });
      {
        fetchCallsToAnthropic.length = 0;
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ providerId: "c5", sourceType: "1881", sourceUrl: "https://www.1881.no/bedrift/c5", email: "a@c5.no" }] },
        });
        const item = r.body.results.find((x: any) => x.provider_id === "c5");
        assertEq(item.outcome, "locked", "c-5a: manual-locked row -> locked, never evaluated");
        assertEq(fetchCallsToAnthropic.length, 0, "c-5b: judge never reached for a locked row");
      }

      // c-6: blocklisted (org_nr) -> never processed.
      seedProvider("c6", { org_nr: "988888888" });
      blocklistSvc.add({ orgNr: "988888888", reason: "test blocklist entry" });
      {
        fetchCallsToAnthropic.length = 0;
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ providerId: "c6", sourceType: "1881", sourceUrl: "https://www.1881.no/bedrift/c6", email: "a@c6.no" }] },
        });
        const item = r.body.results.find((x: any) => x.provider_id === "c6");
        assertEq(item.outcome, "blocklisted", "c-6a: blocklisted org_nr -> blocklisted, never evaluated");
        assertEq(fetchCallsToAnthropic.length, 0, "c-6b: judge never reached for a blocklisted row");
      }

      // ── c-7/c-8: deterministic phone validation BEFORE the LLM judge ────
      // c-7: a validly-shaped-but-formatted Norwegian number (country code +
      // spaces) — the mock judge rejects anything not ALREADY exactly 8
      // digits, so this only passes if the route normalised it FIRST.
      phoneJudgeRejectsUnlessExactly8Digits = true;
      seedProvider("c7");
      {
        fetchCallsToAnthropic.length = 0;
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ providerId: "c7", sourceType: "1881", sourceUrl: "https://www.1881.no/bedrift/c7", phone: "+47 91 23 45 67" }] },
        });
        const item = r.body.results.find((x: any) => x.provider_id === "c7");
        assertEq(item.outcome, "written", "c-7a: formatted phone candidate is written (proves it was normalised to 8 digits BEFORE the mocked judge, which rejects anything else)");
        assertEq(item.written, ["telefon"], "c-7b: telefon is the field written");
        assertEq(readRow("c7").telefon, "91234567", "c-7c: stored value is the normalised bare 8-digit form (extractGardssalgContactPhone's own storage convention)");
        assertTrue(fetchCallsToAnthropic.includes("91234567"), "c-7d: the judge saw the ALREADY-NORMALISED 8-digit string, never the raw '+47 91 23 45 67'");
        assertTrue(!fetchCallsToAnthropic.some((c) => c.includes("+47")), "c-7e: the raw unnormalised candidate string was never sent to the judge at all");
      }

      // c-8: a candidate that CANNOT normalise to 8 digits (too short) is
      // rejected deterministically and the judge is NEVER invoked for it —
      // no fetch call at all for this field.
      seedProvider("c8");
      {
        fetchCallsToAnthropic.length = 0;
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ providerId: "c8", sourceType: "1881", sourceUrl: "https://www.1881.no/bedrift/c8", phone: "1234567" }] },
        });
        const item = r.body.results.find((x: any) => x.provider_id === "c8");
        assertEq(item.phone_rejected_reason, "deterministic_invalid_format: does not reduce to a valid 8-digit Norwegian number", "c-8a: deterministic rejection reason reported");
        assertEq((item.written ?? []).includes("telefon"), false, "c-8b: telefon NOT written");
        assertEq(readRow("c8").telefon, null, "c-8c: telefon column untouched");
        assertEq(fetchCallsToAnthropic.length, 0, "c-8d: the judge (Anthropic API) was NEVER called for the invalid phone — deterministic check ran first and short-circuited it");
      }
      phoneJudgeRejectsUnlessExactly8Digits = false;

      // c-9: fill-only — an already-filled epost is NEVER overwritten by a
      // kildeklasse candidate (this is what makes "egen side vinner ved
      // avvik" structurally true for epost: no overwrite path exists at all).
      seedProvider("c9", { epost: "eksisterende@c9-testgard.no" });
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ providerId: "c9", sourceType: "1881", sourceUrl: "https://www.1881.no/bedrift/c9", email: "annen@c9.no" }] },
        });
        const item = r.body.results.find((x: any) => x.provider_id === "c9");
        assertEq(item.outcome, "no_change", "c-9a: already-filled field -> no_change, nothing written");
        assertEq(readRow("c9").epost, "eksisterende@c9-testgard.no", "c-9b: EXISTING value untouched (own value wins, never overwritten)");
      }

      // c-10: "egen side vinner ved avvik" for epost — an established
      // hjemmeside (verified or not — the write-time domain gate applies
      // regardless) whose domain disagrees with the kildeklasse candidate's
      // domain withholds the write (flagged for review), never publishes the
      // disagreeing value.
      seedProvider("c10", {
        hjemmeside: "https://c10-egen-side.no",
        field_provenance: { hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-08-01T00:00:00Z" } },
      });
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ providerId: "c10", sourceType: "1881", sourceUrl: "https://www.1881.no/bedrift/c10", email: "post@et-helt-annet-domene.no" }] },
        });
        const item = r.body.results.find((x: any) => x.provider_id === "c10");
        assertEq(item.outcome, "no_change", "c-10a: domain-mismatched candidate against a verified own-site domain -> no_change");
        assertTrue(!!item.epost_flagged_for_review, "c-10b: withheld candidate is reported (flagged for review), never silently dropped");
        assertEq(readRow("c10").epost, null, "c-10c: the verified own-site's domain wins — the disagreeing 1881 value is NEVER published");
      }

      // c-11: judge-reject -> not written, reported.
      seedProvider("c11");
      anthropicRejectCandidates.add("post@c11-rejected.no");
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ providerId: "c11", sourceType: "1881", sourceUrl: "https://www.1881.no/bedrift/c11", email: "post@c11-rejected.no" }] },
        });
        const item = r.body.results.find((x: any) => x.provider_id === "c11");
        assertEq(item.outcome, "no_change", "c-11a: judge-rejected candidate -> no_change");
        assertTrue(!!item.contact_gate_rejected?.epost, "c-11b: rejection reason reported (contact_gate_rejected.epost)");
        assertEq(readRow("c11").epost, null, "c-11c: nothing written for a judge-rejected candidate");
      }
      anthropicRejectCandidates.delete("post@c11-rejected.no");

      // c-12: this route NEVER fetches anything other than the Anthropic
      // judge endpoint — across the ENTIRE run above (including c-2's
      // proff.no candidate and c-1/c-3's 1881.no/hanen.no source URLs),
      // confirm zero fetch calls ever reached any host other than
      // api.anthropic.com. The `invalid_source_url` check (c-2, c-3b) is a
      // pure host-string comparison (hostFromUrlLike/registrableDomain) —
      // no network access — and every kildeklasse source URL in this file is
      // caller-supplied provenance, never a fetch target. If this ever
      // becomes nonzero, some code path started making an unexpected live
      // network call — a regression, not a stale test to relax.
      assertEq(fetchCallsToOtherHosts.length, 0, "c-12: zero fetch calls to any non-Anthropic host across the whole run");
    } catch (err: any) {
      failed++;
      failures.push("kildeklasse-contact: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      if (prevFlag === undefined) delete process.env.GS_KILDEKLASSE_CONTACT_ENABLED; else process.env.GS_KILDEKLASSE_CONTACT_ENABLED = prevFlag;
      try {
        const initMod = require("../database/init") as typeof import("../database/init");
        if (prevRfbDb) initMod.__setDbForTesting(prevRfbDb);
      } catch { /* best-effort restore */ }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}
