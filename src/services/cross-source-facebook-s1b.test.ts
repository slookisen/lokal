/**
 * cross-source-facebook-s1b.test.ts — enrichment-kadens S1b.
 * facebook_official_page = existence-only: never corroborates address/phone.
 */
import {
  crossSourceAgreement,
  tierForSource,
  countsForField,
  type FieldName,
} from "./cross-source-validator";
import { computeFacebookTierShadow } from "./facebook-tier-shadow";

export interface TestSummary { passed: number; failed: number; failures: string[] }

const rec = (source_type: string, value: string) => ({ source_type, value, fetched_at: "2026-10-01T00:00:00Z" });
const ADDR = "Storgata 1, 0150 Oslo";
const PHONE = "91234567";

export async function runCrossSourceFacebookS1bTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0, failed = 0;
  const failures: string[] = [];
  const eq = (a: unknown, b: unknown, label: string) => {
    const ok = JSON.stringify(a) === JSON.stringify(b);
    if (ok) passed++; else { failed++; failures.push(`✗ ${label}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }
    if (opts.log) console.log(`  ${ok ? "ok" : "✗"} ${label}`);
  };

  // (3) existence semantics unchanged
  eq(tierForSource("facebook_official_page"), "B", "(3) tierForSource without field is B");
  eq(tierForSource("brreg"), "B", "brreg unaffected");
  eq(countsForField("facebook_official_page"), true, "countsForField no field");
  eq(countsForField("facebook_official_page", "address"), false, "countsForField address");
  eq(countsForField("homepage", "address"), true, "countsForField other source");

  // (1) facebook alone / + one source does NOT give pool_eligible
  for (const [f, v] of [["address", ADDR], ["phone", PHONE]] as const) {
    const alone = crossSourceAgreement({ [f]: [rec("facebook_official_page", v)] }, f);
    eq([alone.verdict, alone.source_count, alone.sources_used], ["data_insufficient", 0, []], `(1) ${f}: facebook alone`);
    for (const other of ["google_places", "homepage", "brreg"]) {
      const r = crossSourceAgreement({ [f]: [rec("facebook_official_page", v), rec(other, v)] }, f);
      eq([r.verdict, r.agree, r.sources_used], ["review_required", false, [other]], `(1) ${f}: facebook + ${other}`);
    }
  }

  // (2) facebook beside >=2 agreeing sources: pool_eligible, facebook not in sources_used
  const two = crossSourceAgreement({ address: [rec("facebook_official_page", ADDR), rec("brreg", ADDR), rec("homepage", ADDR)] }, "address");
  eq([two.verdict, two.agree, two.source_count, two.sources_used], ["pool_eligible", true, 2, ["brreg", "homepage"]], "(2) address fb + brreg + homepage");
  const twoP = crossSourceAgreement({ phone: [rec("facebook_official_page", PHONE), rec("google_places", PHONE), rec("homepage", "+47 91234567")] }, "phone");
  eq([twoP.verdict, twoP.agree], ["pool_eligible", true], "(2) phone fb + 2 agreeing");
  // business_status: facebook still counts (identical to the pre-S1b result: 2 B/A sources agree)
  const bs = crossSourceAgreement({ business_status: [rec("facebook_official_page", "OPERATIONAL"), rec("brreg", "OPERATIONAL")] }, "business_status");
  eq([bs.verdict, bs.agree, bs.source_count, bs.sources_used], ["pool_eligible", true, 2, ["facebook_official_page", "brreg"]], "(2) business_status fb + brreg unchanged");

  // Equality with the shadow reference for a handful of fixtures
  const fixtures: Record<string, unknown>[] = [
    { address: [rec("facebook_official_page", ADDR), rec("homepage", ADDR)], phone: [rec("facebook_official_page", PHONE), rec("google_places", PHONE)] },
    { address: [rec("facebook_official_page", ADDR), rec("brreg", ADDR), rec("google_places", ADDR)] },
    { address: rec("facebook_official_page", ADDR) },
    { address: [rec("facebook_official_page", ADDR), rec("owner", ADDR)], phone: [rec("facebook_official_page", PHONE)] },
    { address: [rec("facebook_official_page", ADDR), rec("homepage", "Annen vei 9, 5000 Bergen")], phone: [rec("homepage", PHONE)] },
    { address: [rec("facebook_official_page", ADDR), rec("category_inference", ADDR), rec("homepage", ADDR)] },
    { address: [rec("homepage", ADDR), rec("brreg", ADDR)] },
    {},
  ];
  fixtures.forEach((fx, i) => {
    const sh = computeFacebookTierShadow(fx, { ownName: "Test Gard" });
    for (const f of ["address", "phone"] as FieldName[]) {
      eq(crossSourceAgreement(fx, f, { ownName: "Test Gard" }), (sh.fields as any)[f].shadow, `fixture ${i} ${f}: production == shadow`);
    }
  });

  return { passed, failed, failures };
}

if (require.main === module) {
  runCrossSourceFacebookS1bTests({ log: true }).then((r) => {
    console.log(`\ncross-source-facebook-s1b: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) { console.log(r.failures.join("\n")); process.exit(1); }
  });
}
