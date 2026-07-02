/**
 * brreg-client.test.ts — unit tests for services/brreg-client.ts, focused on
 * verifyOrgNumber(orgNr) (Slice 1 of dev-request
 * 2026-06-30-brreg-verification-gate — schema + lookup function only, NOT
 * wired into any registration/enrichment endpoint yet).
 *
 * All I/O is stubbed via an injected fetchImpl — ZERO real network calls.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/brreg-client.test.ts
 *   2. Wired into the gate: tests/test.ts imports runBrregClientTests() and
 *      folds its pass/fail counts into the `npm test` summary.
 */

import { verifyOrgNumber, __clearBrregVerifyCacheForTesting, type BrregVerifyResult } from "./brreg-client";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Minimal fetch-shaped stub, mirrors the Response subset the client uses.
function makeFetch(
  handler: (url: string) => { status: number; ok: boolean; json: () => Promise<unknown> } | Promise<never>,
): typeof fetch {
  return (async (url: string | URL | Request) => {
    const result = handler(String(url));
    return result as unknown as Response;
  }) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): { status: number; ok: boolean; json: () => Promise<unknown> } {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

export async function runBrregClientTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // ── (a) Active/exists org ──────────────────────────────────────────────
  {
    __clearBrregVerifyCacheForTesting();
    const fetchImpl = makeFetch((url) => {
      assertTrue(url.includes("/enheter/910244132"), "active: URL hits /enheter/{orgnr} direct endpoint");
      return jsonResponse(200, {
        organisasjonsnummer: "910244132",
        navn: "Gårdsbutikken Test AS",
        konkurs: false,
        underAvvikling: false,
        underTvangsavviklingEllerTvangsopplosning: false,
        slettedato: null,
        registreringsdatoEnhetsregisteret: "2015-03-01",
        naeringskode1: { kode: "47.210" },
      });
    });
    const r: BrregVerifyResult = await verifyOrgNumber("910244132", fetchImpl);
    assertEq(r.exists, true, "active: exists === true");
    assertEq(r.active, true, "active: active === true");
    assertEq(r.name, "Gårdsbutikken Test AS", "active: name matches Brreg's navn");
    assertEq(r.nace, ["47.210"], "active: nace array contains naeringskode1");
    assertEq(r.registrertDato, "2015-03-01", "active: registrertDato populated");
    assertEq(r.slettetDato, null, "active: slettetDato null");
    assertEq(r.flag, null, "active: flag null (active + exists)");
  }

  // ── (b) Dissolved (slettedato set) ─────────────────────────────────────
  {
    __clearBrregVerifyCacheForTesting();
    const fetchImpl = makeFetch(() =>
      jsonResponse(200, {
        organisasjonsnummer: "987654321",
        navn: "Nedlagt Foretak AS",
        konkurs: false,
        underAvvikling: false,
        underTvangsavviklingEllerTvangsopplosning: false,
        slettedato: "2022-01-15",
        registreringsdatoEnhetsregisteret: "2010-05-01",
        naeringskode1: { kode: "01.130" },
      })
    );
    const r = await verifyOrgNumber("987654321", fetchImpl);
    assertEq(r.exists, true, "dissolved: exists === true (still a real Brreg record)");
    assertEq(r.active, false, "dissolved: active === false");
    assertEq(r.slettetDato, "2022-01-15", "dissolved: slettetDato populated");
    assertEq(r.flag, "dissolved", "dissolved: flag === 'dissolved'");
  }

  // ── (c) Bankrupt (konkurs boolean set — real Brreg field, mirrors ─────
  //        experience-brreg.ts's BrregEntity.konkurs convention) ─────────
  {
    __clearBrregVerifyCacheForTesting();
    const fetchImpl = makeFetch(() =>
      jsonResponse(200, {
        organisasjonsnummer: "912345678",
        navn: "Konkurs Bedrift AS",
        konkurs: true,
        underAvvikling: false,
        underTvangsavviklingEllerTvangsopplosning: false,
        slettedato: null,
        registreringsdatoEnhetsregisteret: "2012-09-10",
        naeringskode1: { kode: "56.101" },
      })
    );
    const r = await verifyOrgNumber("912345678", fetchImpl);
    assertEq(r.exists, true, "bankrupt: exists === true");
    assertEq(r.active, false, "bankrupt: active === false");
    assertEq(r.slettetDato, null, "bankrupt: slettetDato still null (not deleted, just bankrupt)");
    assertEq(r.flag, "bankrupt", "bankrupt: flag === 'bankrupt'");
  }

  // ── (d) 404 / not found ─────────────────────────────────────────────────
  {
    __clearBrregVerifyCacheForTesting();
    const fetchImpl = makeFetch(() => jsonResponse(404, { message: "not found" }));
    const r = await verifyOrgNumber("000000000", fetchImpl);
    assertEq(r.exists, false, "404: exists === false");
    assertEq(r.active, false, "404: active === false");
    assertEq(r.name, null, "404: name === null");
    assertEq(r.nace, [], "404: nace === []");
    assertEq(r.flag, "no_orgnr", "404: flag === 'no_orgnr' (safe default)");
  }

  // ── (e) Network error ────────────────────────────────────────────────────
  {
    __clearBrregVerifyCacheForTesting();
    const fetchImpl = (async () => {
      throw new Error("simulated network failure");
    }) as unknown as typeof fetch;
    const r = await verifyOrgNumber("123456789", fetchImpl);
    assertEq(r.exists, false, "network error: exists === false");
    assertEq(r.active, false, "network error: active === false");
    assertEq(r.flag, "no_orgnr", "network error: flag === 'no_orgnr' (safe default, never throws)");
  }

  // ── Multi-NACE + empty org-nr guard ─────────────────────────────────────
  {
    __clearBrregVerifyCacheForTesting();
    const fetchImpl = makeFetch(() =>
      jsonResponse(200, {
        organisasjonsnummer: "999888777",
        navn: "Multi Nace AS",
        konkurs: false,
        underAvvikling: false,
        underTvangsavviklingEllerTvangsopplosning: false,
        slettedato: null,
        naeringskode1: { kode: "56.101" },
        naeringskode2: { kode: "47.111" },
      })
    );
    const r = await verifyOrgNumber("999888777", fetchImpl);
    assertEq(r.nace, ["56.101", "47.111"], "multi-nace: nace array collects naeringskode1+2");

    const empty = await verifyOrgNumber("", fetchImpl);
    assertEq(empty.exists, false, "empty org-nr: returns safe default without calling fetch");
    assertEq(empty.flag, "no_orgnr", "empty org-nr: flag === 'no_orgnr'");
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/brreg-client.test.ts`
if (require.main === module) {
  console.log("── brreg-client (verifyOrgNumber) unit tests ──");
  runBrregClientTests({ log: true }).then((r) => {
    console.log(`\nbrreg-client: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
