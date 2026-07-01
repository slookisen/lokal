/**
 * brreg-verify.test.ts — unit tests for the single-org Brreg verification
 * lookup (services/brreg-verify.ts).
 *
 * dev-request 2026-06-30-brreg-verification-gate, slice 1.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/brreg-verify.test.ts
 *   2. (Not yet wired into tests/test.ts — this slice is additive-only and
 *      intentionally does not touch any existing file, including the main
 *      test gate. A future slice may fold runBrregVerifyTests() in.)
 *
 * All fetch calls are mocked via __setBrregVerifyFetchForTesting — no real
 * network calls are made in this suite, matching the convention already
 * used in services/experience-brreg.ts (__setBrregFetchForTesting).
 */

import {
  brregVerify,
  sanitizeOrgNumber,
  isValidOrgNumber,
  __setBrregVerifyFetchForTesting,
  type BrregVerifyResult,
} from "./brreg-verify";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type FetchLike = typeof fetch;

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

export async function runBrregVerifyTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // ── sanitizeOrgNumber / isValidOrgNumber (pure) ─────────────────────────
  {
    assertEq(sanitizeOrgNumber("923 609 016"), "923609016", "sanitizeOrgNumber strips spaces");
    assertEq(sanitizeOrgNumber("923609016"), "923609016", "sanitizeOrgNumber no-op on clean input");
    assertTrue(isValidOrgNumber("923609016"), "isValidOrgNumber: 9 digits valid");
    assertTrue(isValidOrgNumber("923 609 016"), "isValidOrgNumber: 9 digits with spaces valid");
    assertTrue(!isValidOrgNumber("12345"), "isValidOrgNumber: too short invalid");
    assertTrue(!isValidOrgNumber("1234567890"), "isValidOrgNumber: too long invalid");
    assertTrue(!isValidOrgNumber("92360901a"), "isValidOrgNumber: non-digit invalid");
    assertTrue(!isValidOrgNumber(""), "isValidOrgNumber: empty invalid");
  }

  // ── malformed org-number: brregVerify short-circuits, no network call ──
  {
    let called = false;
    const fetchImpl: FetchLike = (async () => {
      called = true;
      throw new Error("should not be called for invalid org-number");
    }) as unknown as FetchLike;
    __setBrregVerifyFetchForTesting(fetchImpl);
    const res = await brregVerify("not-a-number");
    assertEq(res, { exists: false, orgNumber: "not-a-number", status: "unknown" }, "malformed org-number: short-circuits");
    assertTrue(!called, "malformed org-number: no network call made");
    __setBrregVerifyFetchForTesting(null);
  }

  // ── valid active org (mocked fetch) ─────────────────────────────────────
  {
    const fetchImpl: FetchLike = (async () =>
      mockResponse(200, {
        organisasjonsnummer: "923609016",
        navn: "EQUINOR ASA",
        registreringsdatoEnhetsregisteret: "1995-01-13",
        naeringskode1: { kode: "06.100" },
        naeringskode2: { kode: "19.200" },
      })) as unknown as FetchLike;
    const res = await brregVerify("923609016", { fetchImpl });
    assertTrue(res.exists, "active org: exists=true");
    assertEq(res.orgNumber, "923609016", "active org: orgNumber echoed");
    assertEq(res.name, "EQUINOR ASA", "active org: name mapped");
    assertEq(res.status, "active", "active org: status=active");
    assertEq(res.nace, ["06.100", "19.200"], "active org: nace codes extracted from naeringskode1/2");
    assertEq(res.registrertDato, "1995-01-13", "active org: registrertDato mapped");
    assertTrue(res.slettetDato === undefined, "active org: no slettetDato");
    assertTrue(res.konkurs === false, "active org: konkurs=false");
    assertTrue(res.raw !== undefined, "active org: raw response attached");
  }

  // ── 404 / not-found ──────────────────────────────────────────────────────
  {
    const fetchImpl: FetchLike = (async () => mockResponse(404, {})) as unknown as FetchLike;
    const res = await brregVerify("999999999", { fetchImpl });
    assertEq(res, { exists: false, orgNumber: "999999999" }, "404: not-found returns exists=false, no throw");
  }

  // ── dissolved org (slettedato present) ──────────────────────────────────
  {
    const fetchImpl: FetchLike = (async () =>
      mockResponse(200, {
        organisasjonsnummer: "111111111",
        navn: "NEDLAGT AS",
        slettedato: "2020-05-01",
      })) as unknown as FetchLike;
    const res = await brregVerify("111111111", { fetchImpl });
    assertTrue(res.exists, "dissolved org: exists=true");
    assertEq(res.status, "dissolved", "dissolved org: status=dissolved");
    assertEq(res.slettetDato, "2020-05-01", "dissolved org: slettetDato mapped");
    assertTrue(res.konkurs === false, "dissolved org: konkurs=false (not bankrupt)");
  }

  // ── bankrupt org (konkurs=true) ──────────────────────────────────────────
  {
    const fetchImpl: FetchLike = (async () =>
      mockResponse(200, {
        organisasjonsnummer: "222222222",
        navn: "KONKURS AS",
        konkurs: true,
      })) as unknown as FetchLike;
    const res = await brregVerify("222222222", { fetchImpl });
    assertTrue(res.exists, "bankrupt org: exists=true");
    assertEq(res.status, "bankrupt", "bankrupt org: status=bankrupt");
    assertEq(res.konkurs, true, "bankrupt org: konkurs=true");
  }

  // ── liquidation org (underAvvikling=true, not yet slettet/konkurs) ──────
  {
    const fetchImpl: FetchLike = (async () =>
      mockResponse(200, {
        organisasjonsnummer: "333333333",
        navn: "UNDER AVVIKLING AS",
        underAvvikling: true,
      })) as unknown as FetchLike;
    const res = await brregVerify("333333333", { fetchImpl });
    assertTrue(res.exists, "liquidation org: exists=true");
    assertEq(res.status, "liquidation", "liquidation org: status=liquidation");
  }

  // ── simulated network failure: never throws ──────────────────────────────
  {
    const fetchImpl: FetchLike = (async () => {
      throw new Error("network unreachable (simulated)");
    }) as unknown as FetchLike;
    let threw = false;
    let res: BrregVerifyResult | undefined;
    try {
      res = await brregVerify("923609016", { fetchImpl });
    } catch {
      threw = true;
    }
    assertTrue(!threw, "network failure: brregVerify does not throw");
    assertEq(res, { exists: false, orgNumber: "923609016", status: "unknown" }, "network failure: returns unknown status");
  }

  // ── simulated 500 server error: never throws ──────────────────────────────
  {
    const fetchImpl: FetchLike = (async () => mockResponse(500, {})) as unknown as FetchLike;
    const res = await brregVerify("923609016", { fetchImpl });
    assertEq(res, { exists: false, orgNumber: "923609016", status: "unknown" }, "5xx: returns unknown status, no throw");
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/brreg-verify.test.ts`
// (require.main === module is the CJS entrypoint check; tsconfig compiles to CJS.)
if (require.main === module) {
  (async () => {
    console.log("── brreg-verify unit tests ──");
    const r = await runBrregVerifyTests({ log: true });
    console.log(`\nbrreg-verify: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  })();
}
