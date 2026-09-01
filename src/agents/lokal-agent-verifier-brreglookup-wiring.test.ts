/**
 * lokal-agent-verifier-brreglookup-wiring.test.ts — dev-request
 * 2026-09-01-rfb-verifier-brreglookup-aldri-koblet: `runVerifierBatch`'s
 * opts.brregLookup was never passed by either production caller
 * (src/scripts/run-verifier.ts, src/routes/admin-run-verifier.ts), so
 * `brreg` was always null in production and the second verification line's
 * `brreg_name_match` identity source could never fire. This suite covers
 * the new `resolveBrregLookup` — the real BrregFn implementation now wired
 * into both callers as the default — in isolation (pure unit tests, no DB,
 * no real network).
 *
 * Fetch-stub convention copied verbatim from the sibling
 * lokal-agent-verifier-terminal-unconfirmable.test.ts's own
 * buildDeathCheckFetch/jsonResponse/searchHit/activeDetail/deadDetail
 * helpers (which itself mirrors admin-rfb-brreg-selfsufficiency.test.ts):
 * URL-pattern dispatch on `?navn=` (findOrgnumberByName's search endpoint)
 * vs `/enheter/{9-digit-orgnr}$` (verifyOrgNumber's direct-lookup endpoint).
 * brreg-client.ts's findOrgnumberByName/verifyOrgNumber caches are
 * module-level (per-process) — cleared at the top of this suite (same
 * convention as that sibling file) and each scenario below uses its own
 * unique search name / org-nr so scenarios never collide with each other
 * or with a fixture some other test file in the same `npm test` process
 * happened to reuse.
 *
 * Exported runLokalAgentVerifierBrregLookupWiringTests({log}) -> TestSummary;
 * wired into tests/test.ts via runSerial() at the tail, immediately after
 * the terminal-unconfirmable suite's own registration.
 * Standalone: npx tsx src/agents/lokal-agent-verifier-brreglookup-wiring.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runLokalAgentVerifierBrregLookupWiringTests(
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
    const { resolveBrregLookup } = require("./lokal-agent-verifier") as typeof import("./lokal-agent-verifier");
    const { __clearBrregCacheForTesting, __clearBrregVerifyCacheForTesting } =
      require("../services/brreg-client") as typeof import("../services/brreg-client");
    __clearBrregCacheForTesting();
    __clearBrregVerifyCacheForTesting();

    function jsonResponse(status: number, body: Record<string, unknown>): Response {
      return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
    }
    function searchHit(orgNr: string, navn: string) {
      return { organisasjonsnummer: orgNr, navn, forretningsadresse: { adresse: ["Testveien 1"] } };
    }
    function activeDetail(orgNr: string, navn: string, extra: Record<string, unknown> = {}) {
      return {
        organisasjonsnummer: orgNr, navn, konkurs: false, underAvvikling: false,
        underTvangsavviklingEllerTvangsopplosning: false, slettedato: null, ...extra,
      };
    }
    function deadDetail(orgNr: string, navn: string, flag: "bankrupt" | "dissolved") {
      return {
        organisasjonsnummer: orgNr, navn,
        konkurs: flag === "bankrupt",
        underAvvikling: false,
        underTvangsavviklingEllerTvangsopplosning: false,
        slettedato: flag === "dissolved" ? "2026-01-15" : null,
      };
    }

    function buildFetch(o: {
      bySearchName?: Record<string, { orgNr: string; navn: string }>;
      byOrgNr?: Record<string, Record<string, unknown>>;
      onSearchCall?: () => void;
      onDetailCall?: () => void;
    } = {}): typeof fetch {
      return (async (url: string | URL | Request) => {
        const u = String(url);
        const sm = /[?&]navn=([^&]+)/.exec(u);
        if (sm) {
          o.onSearchCall?.();
          const decoded = decodeURIComponent(sm[1]);
          const fx = o.bySearchName?.[decoded];
          if (fx) return jsonResponse(200, { _embedded: { enheter: [searchHit(fx.orgNr, fx.navn)] } });
          return jsonResponse(200, { _embedded: { enheter: [] } });
        }
        const dm = /\/enheter\/(\d{9})$/.exec(u);
        if (dm) {
          o.onDetailCall?.();
          const fx = o.byOrgNr?.[dm[1]];
          if (!fx) return jsonResponse(404, {});
          return jsonResponse(200, fx);
        }
        return jsonResponse(404, {});
      }) as typeof fetch;
    }

    try {
      // ── 1: confident name hit + active verified org -> populated result.
      {
        const fx = buildFetch({
          bySearchName: { "Solbakken Gård 1": { orgNr: "911111101", navn: "Solbakken Gård 1 AS" } },
          byOrgNr: {
            "911111101": activeDetail("911111101", "Solbakken Gård 1 AS", {
              naeringskode1: { kode: "01.110" },
            }),
          },
        });
        const r = await resolveBrregLookup("Solbakken Gård 1", null, fx);
        assertEq(
          r,
          { is_active: true, is_konkurs: false, naering: "01.110", navn: "Solbakken Gård 1 AS" },
          "1: confident hit + active verified org -> populated BrregLookupResult",
        );
      }

      // ── 2: confident name hit but verifyOrgNumber says bankrupt -> is_konkurs:true.
      {
        const fx = buildFetch({
          bySearchName: { "Konkursgården 2": { orgNr: "911111102", navn: "Konkursgården 2 AS" } },
          byOrgNr: { "911111102": deadDetail("911111102", "Konkursgården 2 AS", "bankrupt") },
        });
        const r = await resolveBrregLookup("Konkursgården 2", null, fx);
        assertTrue(r !== null && r.is_konkurs === true, "2: verifyOrgNumber reports bankrupt -> is_konkurs:true");
        assertTrue(r !== null && r.is_active === false, "2b: bankrupt entity -> is_active:false");
      }

      // ── 3: verifyOrgNumber says exists:false (404) -> returns null.
      {
        let searchCalls = 0;
        let detailCalls = 0;
        const fx = buildFetch({
          bySearchName: { "Fantomgården 3": { orgNr: "911111103", navn: "Fantomgården 3 AS" } },
          byOrgNr: {}, // no fixture for 911111103 -> jsonResponse(404) -> exists:false
          onSearchCall: () => searchCalls++,
          onDetailCall: () => detailCalls++,
        });
        const r = await resolveBrregLookup("Fantomgården 3", null, fx);
        assertEq(r, null, "3: verifyOrgNumber exists:false (404) -> resolveBrregLookup returns null");
        assertEq(searchCalls, 1, "3b: search WAS attempted");
        assertEq(detailCalls, 1, "3c: detail lookup WAS attempted (and correctly returned exists:false)");
      }

      // ── 4: findOrgnumberByName finds no hit -> verifyOrgNumber never called.
      {
        let detailCalls = 0;
        const fx = buildFetch({
          bySearchName: {}, // no fixture -> empty _embedded.enheter -> no hit
          onDetailCall: () => detailCalls++,
        });
        const r = await resolveBrregLookup("Ingensteds Gård 4", null, fx);
        assertEq(r, null, "4: no name hit -> returns null");
        assertEq(detailCalls, 0, "4b: no name hit -> verifyOrgNumber is never invoked (no wasted detail call)");
      }

      // ── 5a: findOrgnumberByName's fetch rejects/throws -> never throws out, returns null.
      {
        const throwingSearchFetch = (async (url: string | URL | Request) => {
          const u = String(url);
          if (/[?&]navn=/.test(u)) throw new Error("simulated network failure (search)");
          return jsonResponse(404, {});
        }) as unknown as typeof fetch;
        let threw = false;
        let r: unknown = "unset";
        try {
          r = await resolveBrregLookup("Feilende Gård 5a", null, throwingSearchFetch);
        } catch {
          threw = true;
        }
        assertTrue(!threw, "5a: findOrgnumberByName's fetch throwing never escapes resolveBrregLookup");
        assertEq(r, null, "5a-b: falls back to null on search-fetch failure");
      }

      // ── 5b: verifyOrgNumber's fetch rejects/throws -> never throws out, returns null.
      {
        const throwingDetailFetch = (async (url: string | URL | Request) => {
          const u = String(url);
          if (/[?&]navn=/.test(u)) {
            return jsonResponse(200, { _embedded: { enheter: [searchHit("911111105", "Feilende Gård 5b AS")] } });
          }
          if (/\/enheter\/\d{9}$/.test(u)) throw new Error("simulated network failure (detail)");
          return jsonResponse(404, {});
        }) as unknown as typeof fetch;
        let threw = false;
        let r: unknown = "unset";
        try {
          r = await resolveBrregLookup("Feilende Gård 5b", null, throwingDetailFetch);
        } catch {
          threw = true;
        }
        assertTrue(!threw, "5b: verifyOrgNumber's fetch throwing never escapes resolveBrregLookup");
        assertEq(r, null, "5b-b: falls back to null on detail-fetch failure");
      }

      // ── 6: naering falls back to null when Brreg has no naeringskode1 at all.
      {
        const fx = buildFetch({
          bySearchName: { "Uten Naering 6": { orgNr: "911111106", navn: "Uten Naering 6 AS" } },
          byOrgNr: { "911111106": activeDetail("911111106", "Uten Naering 6 AS") },
        });
        const r = await resolveBrregLookup("Uten Naering 6", null, fx);
        assertEq(r, { is_active: true, is_konkurs: false, naering: null, navn: "Uten Naering 6 AS" }, "6: no naeringskode1 -> naering:null");
      }

      // ── 7: findOrgnumberByName returns an ambiguous hit (exact_ties > 1,
      // e.g. "SOLBAKKEN GARD" (ENK) vs "SOLBAKKEN GARD AS" both scoring 1.0)
      // -> resolveBrregLookup treats it as no confident match: returns null
      // and NEVER calls verifyOrgNumber on the ambiguous hit (CHANGES-
      // REQUESTED finding 1, PR #758).
      {
        let detailCalls = 0;
        const fx = buildFetch({
          bySearchName: { "Solbakken Gård 7": { orgNr: "911111107", navn: "Solbakken Gård 7 AS" } },
          byOrgNr: { "911111107": activeDetail("911111107", "Solbakken Gård 7 AS") },
          onDetailCall: () => detailCalls++,
        });
        // Wrap the search leg so the returned hit carries exact_ties: 2,
        // mirroring the real ambiguous-collision shape (two 1.0-scoring
        // hits) without needing a second fixture entity in the response.
        const ambiguousFetch = (async (url: string | URL | Request) => {
          const u = String(url);
          if (/[?&]navn=/.test(u)) {
            return jsonResponse(200, {
              _embedded: {
                enheter: [
                  searchHit("911111107", "Solbakken Gård 7 AS"),
                  searchHit("911111108", "Solbakken Gård 7"),
                ],
              },
            });
          }
          return fx(url as any);
        }) as unknown as typeof fetch;
        const r = await resolveBrregLookup("Solbakken Gård 7", null, ambiguousFetch);
        assertEq(r, null, "7: exact_ties > 1 (ambiguous hit) -> resolveBrregLookup returns null");
        assertEq(detailCalls, 0, "7b: ambiguous hit -> verifyOrgNumber is never invoked");
      }
    } catch (err: any) {
      failed++;
      failures.push("resolveBrregLookup: unexpected error: " + String(err?.stack || err?.message || err));
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runLokalAgentVerifierBrregLookupWiringTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) {
      for (const f of summary.failures) console.log(f);
      process.exit(1);
    }
  });
}
