/**
 * claim-assessment.test.ts — dev-request
 * 2026-10-30-rfb-eierkrav-automatisk-vurdering-og-ettklikk, slice A
 * (record-only). Unit tests of assessClaim (services/claim-assessment.ts):
 * green A1+S1, yellow anchor-without-support, yellow sibling profile, one
 * test per red flag, Brreg / RDAP / website / DNS down → never green (AC8),
 * S4 alone never satisfies support, privacy (no Brreg person names stored).
 *
 * All network (fetchApi, fetchSite, resolveMx) and the clock are stubs — no
 * request leaves the process.
 *
 * Exported runClaimAssessmentTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/claim-assessment.test.ts
 */

import {
  type ClaimAssessmentDeps, type ClaimAssessmentInput, BRREG_ROLES_URL, assessClaim, claimAssessmentEnabled,
  homoglyphSkeleton, isLookalikeDomain, pageHasAddress, pageHasEmail, pageHasOrgNr, pageHasPhone, personNameMatches, rdapUrl,
  preparePage, recordClaimIp, __resetClaimIpWindowForTesting,
} from "./claim-assessment";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const NOW = new Date("2026-11-02T12:00:00.000Z");
const daysAgo = (d: number): string => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const ORG = "912345678";

/** Brreg roles answer: Kari Nordmann daglig leder, Ola Hansen styremedlem. */
const BRREG_ROLES = {
  rollegrupper: [
    { type: { kode: "DAGL" }, roller: [{ type: { kode: "DAGL" }, person: { navn: { fornavn: "Kari", mellomnavn: "Sofie", etternavn: "Nordmann" } }, fratraadt: false }] },
    { type: { kode: "STYR" }, roller: [{ type: { kode: "MEDL" }, person: { navn: { fornavn: "Ola", etternavn: "Hansen" } }, fratraadt: false }] },
  ],
};

function baseInput(over: Partial<ClaimAssessmentInput> = {}, profile: Partial<ClaimAssessmentInput["profile"]> = {}): ClaimAssessmentInput {
  return {
    claimantName: "Kari Nordmann",
    claimantEmail: "kari@solbakkegard.no",
    claimantPhone: null,
    siblings: [],
    sharedAddress: false,
    otherFarmHasDomain: false,
    enrichment: { emails: [], phones: [] },
    recentClaims: { sameEmail: 1, sameDomain: 1, sameIp: 1 },
    ...over,
    profile: {
      orgNr: ORG, orgNrIndependent: true, phone: "+47 912 34 567", address: "Solbakkevegen 12, 2610 Mesnali", postalCode: "2610",
      websiteHost: "www.solbakkegard.no", independentWebsiteHost: "www.solbakkegard.no", hasOwner: false,
      ...profile,
    },
  };
}

interface StubOpts {
  brreg?: "ok" | "nohit" | "down" | "500" | "hang" | "resigned";
  rdapDays?: number | "down" | "nodate" | "404";
  mx?: "ok" | "none" | "nxdomain" | "down";
  site?: Record<string, string | "down" | "500">;
}

function stubDeps(o: StubOpts = {}, calls: string[] = []): ClaimAssessmentDeps {
  return {
    now: () => NOW,
    timeoutMs: 50,
    fetchApi: async (url: string) => {
      calls.push(url);
      if (url.startsWith("https://data.brreg.no/")) {
        const b = o.brreg ?? "ok";
        if (b === "down") throw new Error("ECONNREFUSED");
        if (b === "hang") return new Promise(() => { /* never */ });
        if (b === "500") return { status: 500, body: "" };
        if (b === "resigned") {
          return { status: 200, body: JSON.stringify({ rollegrupper: [{ type: { kode: "DAGL" }, roller: [
            { type: { kode: "DAGL" }, person: { navn: { fornavn: "Kari", etternavn: "Nordmann" } }, fratraadt: true },
          ] }] }) };
        }
        return { status: 200, body: JSON.stringify(b === "nohit" ? { rollegrupper: [] } : BRREG_ROLES) };
      }
      if (url.startsWith("https://rdap.")) {
        const r = o.rdapDays ?? 2000;
        if (r === "down") throw new Error("ETIMEDOUT");
        if (r === "nodate") return { status: 200, body: JSON.stringify({ events: [] }) };
        if (r === "404") return { status: 404, body: "" };
        return { status: 200, body: JSON.stringify({ events: [{ eventAction: "registration", eventDate: daysAgo(r) }] }) };
      }
      throw new Error(`unexpected url ${url}`);
    },
    fetchSite: async (host: string) => {
      calls.push(`site:${host}`);
      const page = o.site?.[host];
      if (page === "down") throw new Error("ECONNRESET");
      if (page === "500") return { status: 503, body: "" };
      return { status: 200, body: page ?? "<html><body>Velkommen</body></html>" };
    },
    resolveMx: async (d: string) => {
      calls.push(`mx:${d}`);
      const m = o.mx ?? "ok";
      if (m === "none") return [];
      if (m === "nxdomain") throw Object.assign(new Error("queryMx ENOTFOUND"), { code: "ENOTFOUND" });
      if (m === "down") throw Object.assign(new Error("queryMx ESERVFAIL"), { code: "ESERVFAIL" });
      return [{ exchange: `mx.${d}`, priority: 10 }];
    },
  };
}

export async function runClaimAssessmentTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const eq = (actual: unknown, expected: unknown, label: string): void => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  };
  const ok = (cond: boolean, label: string): void => eq(!!cond, true, label);
  // A domain registered 200 days ago: neither S3 (≥ 1 year) nor domain_young (< 90 days).
  const MID = 200;

  try {
    // ── flag ──
    eq([claimAssessmentEnabled({}), claimAssessmentEnabled({ CLAIM_AUTO_ASSESSMENT_ENABLED: "1" }),
      claimAssessmentEnabled({ CLAIM_AUTO_ASSESSMENT_ENABLED: "TRUE" }), claimAssessmentEnabled({ CLAIM_AUTO_ASSESSMENT_ENABLED: "true" })],
    [false, false, false, true], "flag: only the exact string \"true\" turns it on (default off)");

    // ── green: A1 + S1, no flags ──
    {
      const calls: string[] = [];
      const a = await assessClaim(baseInput(), stubDeps({ rdapDays: MID }, calls));
      eq(a.result, "green", "green: A1 + S1, no red flag, every source answered");
      eq([a.anchors, a.supports, a.red_flags, a.unavailable_sources], [["A1"], ["S1"], [], []], "green: anchors A1, supports S1 only");
      eq(a.rule_version, "A1", "green: rule_version A1");
      eq(a.org_nr, ORG, "green: org_nr stored");
      ok(calls.includes(BRREG_ROLES_URL(ORG)), "green: Brreg roles asked for the profile's org.nr");
      ok(calls.includes(rdapUrl("solbakkegard.no")) && rdapUrl("solbakkegard.no") === "https://rdap.norid.no/domain/solbakkegard.no",
        "green: .no domain → Norid RDAP");
      eq(rdapUrl("gard.com"), "https://rdap.org/domain/gard.com", "rdap: other TLDs → rdap.org");
      const s1 = a.signals.find((s) => s.id === "S1")!;
      eq([s1.hit, s1.source, s1.source_url, s1.checked_at, s1.status], [true, "brreg", BRREG_ROLES_URL(ORG), NOW.toISOString(), "ok"],
        "green: S1 signal has source, source_url and checked_at from the injected clock");
      for (const id of ["A2_brreg", "A2_bondensmarked", "A2_debio"]) {
        eq(a.signals.find((s) => s.id === id)?.status, "not_checked", `green: ${id} recorded as not checked (slice A)`);
      }
      ok(a.signals.every((s) => typeof s.checked_at === "string" && typeof s.hit === "boolean" && typeof s.source === "string"),
        "green: every signal has id, hit, source, checked_at");
    }

    // ── privacy ──
    {
      const a = await assessClaim(baseInput(), stubDeps({ rdapDays: MID }));
      const json = JSON.stringify(a);
      for (const name of ["Kari", "Nordmann", "Sofie", "Ola", "Hansen", "kari", "nordmann", "hansen"]) {
        ok(!json.includes(name), `privacy: «${name}» (a Brreg / claimant name) is not in the stored JSON`);
      }
      ok(!json.includes("DAGL") && !json.includes("rollegrupper"), "privacy: no Brreg role payload stored, only the hit yes/no");
      ok(!json.includes("Velkommen"), "privacy: fetched page text is not stored");
    }

    // ── yellow: anchor without support ──
    {
      const a = await assessClaim(baseInput(), stubDeps({ brreg: "nohit", rdapDays: MID }));
      eq([a.result, a.anchors, a.supports, a.red_flags], ["yellow", ["A1"], [], []], "yellow: A1 but no support (Brreg no role hit, domain < 1 year)");
      const n = await assessClaim(baseInput({}, { independentWebsiteHost: null }), stubDeps({ rdapDays: 2000 }));
      eq([n.result, n.anchors, n.supports], ["yellow", [], ["S1", "S3"]], "yellow: support but no anchor");
    }

    // ── yellow: sibling profile ──
    {
      const a = await assessClaim(baseInput({ siblings: [{ independentWebsiteHost: "solbakkegard.no" }] }, { independentWebsiteHost: null }),
        stubDeps({ rdapDays: 2000 }));
      eq([a.result, a.anchors, a.possible_duplicate], ["yellow", ["A1_sibling"], true], "yellow: A1 only through a sibling profile (possible duplicate)");
      const b = await assessClaim(baseInput({ siblings: [{ independentWebsiteHost: null }] }), stubDeps({ rdapDays: MID }));
      eq([b.result, b.anchors, b.supports, b.possible_duplicate], ["yellow", ["A1"], ["S1"], true],
        "yellow: own A1 + S1 but a sibling profile exists → never green");
    }

    // ── S4 alone never satisfies support ──
    {
      const input = baseInput({ claimantPhone: "912 34 567", enrichment: { emails: [], phones: [{ value: "+4791234567", sourceUrl: "https://www.gulesider.no/x" }] } });
      const a = await assessClaim(input, stubDeps({ brreg: "nohit", rdapDays: MID }));
      eq([a.result, a.anchors, a.supports], ["yellow", ["A1"], ["S4"]], "S4: A1 + S4 alone → yellow (S4 never counts alone)");
      const b = await assessClaim(input, stubDeps({ rdapDays: MID }));
      eq([b.result, b.supports], ["green", ["S1", "S4"]], "S4: alongside S1 it is recorded, and S1 carries the support");
      const c = await assessClaim(baseInput({ claimantPhone: "91234567" }, { independentWebsiteHost: null }),
        stubDeps({ brreg: "nohit", rdapDays: MID, site: { "solbakkegard.no": "<p>Ring 912 34 567</p>" } }));
      eq(c.supports.includes("S2"), true, "S2: the e-mail domain's site shows the profile's phone");
      const d = await assessClaim(baseInput({ claimantPhone: "91234567", enrichment: { emails: [], phones: [{ value: "91234567", sourceUrl: "https://x.no/" }] } },
        { independentWebsiteHost: null }), stubDeps({ brreg: "nohit", rdapDays: MID }));
      eq([d.result, d.anchors, d.supports], ["yellow", [], ["S4"]], "S4: S4 without anchor → yellow");
    }

    // ── A2 ──
    {
      const g = baseInput({ claimantEmail: "solbakke.gard@gmail.com" });
      const noA2 = await assessClaim(g, stubDeps({ rdapDays: MID }));
      eq([noA2.result, noA2.red_flags], ["red", ["free_mail"]], "red: free-mail without A2");
      const withA2 = await assessClaim(g, stubDeps({ rdapDays: MID, site: { "www.solbakkegard.no": '<a href="mailto:Solbakke.Gard@gmail.com">e-post</a>' } }));
      eq([withA2.result, withA2.anchors, withA2.red_flags], ["green", ["A2_website"], []], "A2: the address on the farm's independent site → anchor, no free-mail flag");
      const enr = await assessClaim(baseInput({ claimantEmail: "solbakke.gard@gmail.com",
        enrichment: { emails: [{ value: "solbakke.gard@gmail.com", sourceUrl: "https://www.bondensmarked.no/produsent/solbakke" }], phones: [] } }),
        stubDeps({ rdapDays: MID }));
      eq([enr.anchors, enr.red_flags], [["A2_enrichment"], []], "A2: an enrichment record with source_url → anchor");
      const own = await assessClaim(baseInput({ claimantEmail: "kari@annet.no",
        enrichment: { emails: [{ value: "kari@annet.no", sourceUrl: "https://annet.no/kontakt" }], phones: [] } }),
        stubDeps({ rdapDays: MID }));
      eq(own.anchors, [], "A2: an enrichment record from the claimant's own domain is not independent");
    }

    // ── red flags, one test each ──
    {
      const red = async (label: string, input: ClaimAssessmentInput, o: StubOpts, flag: string): Promise<void> => {
        const a = await assessClaim(input, stubDeps({ rdapDays: MID, ...o }));
        eq([a.result, a.red_flags.includes(flag as any)], ["red", true], `red: ${label}`);
      };
      await red("profile already has an owner", baseInput({}, { hasOwner: true }), {}, "has_owner");
      await red("shared address (1b)", baseInput({ sharedAddress: true }), {}, "shared_address");
      await red("domain registered < 90 days ago", baseInput(), { rdapDays: 30 }, "domain_young");
      await red("no MX records", baseInput(), { mx: "none" }, "no_mx");
      await red("domain without DNS (no MX, NXDOMAIN)", baseInput(), { mx: "nxdomain" }, "no_mx");
      await red("disposable domain", baseInput({ claimantEmail: "kari@mailinator.com" }), {}, "disposable");
      await red("lookalike of the farm's domain (edit distance 1)", baseInput({ claimantEmail: "kari@solbakkegaard.no" }), {}, "lookalike");
      await red("lookalike of the farm's domain (homoglyph 1 for l)", baseInput({ claimantEmail: "kari@so1bakkegard.no" }), {}, "lookalike");
      await red("domain belongs to another farm's profile", baseInput({ otherFarmHasDomain: true }), {}, "other_farm_domain");
      await red("≥ 3 claims from the same e-mail in 24 h", baseInput({ recentClaims: { sameEmail: 3, sameDomain: 3, sameIp: 1 } }), {}, "velocity_email");
      await red("≥ 3 claims from the same IP in 24 h", baseInput({ recentClaims: { sameEmail: 1, sameDomain: 1, sameIp: 3 } }), {}, "velocity_ip");
      await red("≥ 3 claims from the same domain in 24 h", baseInput({ recentClaims: { sameEmail: 1, sameDomain: 3, sameIp: 1 } }), {}, "velocity_domain");
      const two = await assessClaim(baseInput({ recentClaims: { sameEmail: 2, sameDomain: 2, sameIp: 2 } }), stubDeps({ rdapDays: MID }));
      eq(two.result, "green", "velocity: 2 claims in 24 h is not a flag");
      const gm = await assessClaim(baseInput({ claimantEmail: "a@gmail.com", recentClaims: { sameEmail: 1, sameDomain: 50, sameIp: 1 },
        enrichment: { emails: [{ value: "a@gmail.com", sourceUrl: "https://x.no/" }], phones: [] } }), stubDeps({ rdapDays: MID }));
      ok(!gm.red_flags.includes("velocity_domain"), "velocity: the domain count does not apply to free-mail domains");
      const eqDom = await assessClaim(baseInput(), stubDeps({ rdapDays: MID }));
      ok(!eqDom.red_flags.includes("lookalike"), "lookalike: the farm's own domain is not a lookalike");
    }

    // ── AC8: a source down → never green ──
    {
      const brDown = await assessClaim(baseInput(), stubDeps({ brreg: "down", rdapDays: 2000 }));
      eq([brDown.result, brDown.supports, brDown.unavailable_sources], ["yellow", ["S3"], ["brreg_roller"]],
        "AC8: Brreg down → yellow even with A1 + S3, brreg_roller unavailable");
      const br500 = await assessClaim(baseInput(), stubDeps({ brreg: "500", rdapDays: 2000 }));
      eq([br500.result, br500.unavailable_sources], ["yellow", ["brreg_roller"]], "AC8: Brreg HTTP 500 → yellow");
      const brHang = await assessClaim(baseInput(), stubDeps({ brreg: "hang", rdapDays: 2000 }));
      eq([brHang.result, brHang.unavailable_sources], ["yellow", ["brreg_roller"]], "AC8: Brreg timeout → yellow (per-source timeout)");
      const rdDown = await assessClaim(baseInput(), stubDeps({ rdapDays: "down" }));
      eq([rdDown.result, rdDown.supports, rdDown.unavailable_sources], ["yellow", ["S1"], ["rdap"]], "AC8: RDAP down → yellow even with A1 + S1");
      const rdNoDate = await assessClaim(baseInput(), stubDeps({ rdapDays: "nodate" }));
      eq([rdNoDate.result, rdNoDate.unavailable_sources], ["yellow", ["rdap"]], "AC8: RDAP without a registration date → yellow (age unknown)");
      const mxDown = await assessClaim(baseInput(), stubDeps({ rdapDays: MID, mx: "down" }));
      eq([mxDown.result, mxDown.unavailable_sources], ["yellow", ["dns_mx"]], "AC8: DNS SERVFAIL → yellow");
      const siteDown = await assessClaim(baseInput(), stubDeps({ rdapDays: MID, site: { "www.solbakkegard.no": "down" } }));
      eq([siteDown.result, siteDown.unavailable_sources], ["yellow", ["website_farm"]], "AC8: farm website down → yellow");
      const rd404 = await assessClaim(baseInput(), stubDeps({ rdapDays: "404" }));
      eq([rd404.result, rd404.supports, rd404.unavailable_sources, rd404.signals.find((x) => x.id === "S3")?.status],
        ["yellow", ["S1"], ["rdap"], "unavailable"], "AC8: RDAP 404 → rdap unavailable, never green");
      const site5xx = await assessClaim(baseInput(), stubDeps({ rdapDays: MID, site: { "www.solbakkegard.no": "500" } }));
      eq([site5xx.result, site5xx.unavailable_sources, site5xx.signals.find((x) => x.id === "A2_website")?.status],
        ["yellow", ["website_farm"], "unavailable"], "AC8: farm website HTTP 5xx → unavailable, never green");
      const emailSite5xx = await assessClaim(baseInput({ claimantEmail: "kari@annen-gard.no" }, { independentWebsiteHost: null }),
        stubDeps({ rdapDays: MID, site: { "annen-gard.no": "500" } }));
      eq(emailSite5xx.unavailable_sources, ["website_email_domain"], "AC8: e-mail-domain website HTTP 5xx → unavailable");
      const redDown = await assessClaim(baseInput({}, { hasOwner: true }), stubDeps({ brreg: "down" }));
      eq(redDown.result, "red", "AC8: a red flag stays red when a source is down");
    }

    // ── S1 rules ──
    {
      const self = await assessClaim(baseInput({}, { orgNrIndependent: false }), stubDeps({ rdapDays: MID }));
      eq([self.supports, self.signals.find((s) => s.id === "S1")?.note, self.org_nr], [[], "org_nr_not_independent", null],
        "S1: an org.nr from a self-registration is not asked about");
      const noOrg = await assessClaim(baseInput({}, { orgNr: null }), stubDeps({ rdapDays: MID }));
      eq(noOrg.signals.find((s) => s.id === "S1")?.status, "skipped", "S1: no org.nr → skipped, not unavailable");
      const resigned = await assessClaim(baseInput(), stubDeps({ brreg: "resigned", rdapDays: MID }));
      eq([resigned.result, resigned.supports], ["yellow", []], "S1: a resigned (fratraadt) daglig leder does not give S1");
      const styremedlem = await assessClaim(baseInput({ claimantName: "Ola Hansen" }), stubDeps({ rdapDays: MID }));
      eq(styremedlem.supports, [], "S1: a plain board member (MEDL) is not an S1 role");
      ok(personNameMatches("kari  nordmann", { fornavn: "Kari Sofie", etternavn: "Nordmann" }), "S1: middle names ignored, case-insensitive");
      ok(personNameMatches("Bjørn Ås", { fornavn: "Bjørn", etternavn: "Ås" }), "S1: Norwegian letters");
      ok(!personNameMatches("Kari", { fornavn: "Kari", etternavn: "Nordmann" }), "S1: a single name never matches");
      ok(!personNameMatches("Kari Hansen", { fornavn: "Kari", etternavn: "Nordmann" }), "S1: another surname does not match");
    }

    // ── helpers ──
    {
      ok(!isLookalikeDomain("gard.no", "gard.no"), "lookalike: equal is not a lookalike");
      ok(!isLookalikeDomain("ab.no", "cd.no"), "lookalike: short unrelated names are not lookalikes");
      ok(isLookalikeDomain("solbakkegard.com", "solbakkegard.no"), "lookalike: same name under another suffix");
      ok(!isLookalikeDomain("nordgard.no", "sorbakken.no"), "lookalike: different names");
      eq(homoglyphSkeleton("xn--slbakkegrd-l8a1u.no") === homoglyphSkeleton("solbakkegard.no"), false, "homoglyph: skeleton computed on IDN");
      ok(pageHasEmail('<a href="mailto:post@gard.no">', "post@gard.no"), "page: mailto address found");
      ok(!pageHasEmail("xpost@gard.no", "post@gard.no"), "page: no partial address match");
      ok(!pageHasEmail("post@gard.no.evil", "post@gard.no"), "page: no match inside a longer domain");
      ok(pageHasOrgNr("Org.nr: 912 345 678 MVA", ORG), "page: org.nr with spaces");
      ok(pageHasPhone("Tlf +47 912 34 567", "91234567"), "page: phone with +47 and spaces");
      // ReDoS guard (review B1): 512 KB of `<`, `<script`, `<style` must be handled linearly.
      const N = 512 * 1024;
      for (const [name, unit] of [["<", "<"], ["<script", "<script"], ["<style", "<style "], ["<a", "<a"], ["digit-dots", "1. "]] as const) {
        const html = unit.repeat(Math.ceil(N / unit.length));
        const t = Date.now();
        const pg = preparePage(html, Infinity);
        pageHasEmail(pg, "post@gard.no"); pageHasOrgNr(pg, ORG); pageHasPhone(pg, "91234567"); pageHasAddress(pg, "Gardsvegen 12");
        pageHasEmail(html, "post@gard.no"); pageHasOrgNr(html, ORG); pageHasPhone(html, "91234567"); pageHasAddress(html, "Gardsvegen 12");
        const ms = Date.now() - t;
        ok(ms < 200, `redos: 512 KB of «${name}» prepared and checked in < 200 ms (took ${ms} ms)`);
      }
      const closedBlocks = "<style>x</style>".repeat(40_000) + "<p>Org.nr 912 345 678</p>";
      const tb = Date.now();
      ok(pageHasOrgNr(preparePage(closedBlocks, Infinity), ORG), "page: text after many closed style blocks is kept");
      ok(Date.now() - tb < 200, "redos: many closed style blocks without a script stay linear");
      ok(!pageHasOrgNr("<script>var x = '912345678';</script>", ORG), "page: script content is not page text");
      ok(!pageHasOrgNr("<p>hei</p><script>912345678", ORG), "page: an unclosed script drops the rest of the page");
      ok(pageHasEmail("<p>Skriv til post&#64;gard.no</p>", "post@gard.no"), "page: &#64; entity decoded");
      __resetClaimIpWindowForTesting();
      const t0 = NOW.getTime();
      eq([recordClaimIp("10.0.0.1", t0), recordClaimIp("10.0.0.1", t0 + 1000), recordClaimIp("10.0.0.2", t0 + 2000),
        recordClaimIp("10.0.0.1", t0 + 25 * 3_600_000), recordClaimIp(undefined)], [1, 2, 1, 1, null],
      "ip window: counts per IP within 24 h, null without an IP");
      __resetClaimIpWindowForTesting();
    }
  } catch (err) {
    failed++;
    failures.push(`claim-assessment: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runClaimAssessmentTests({ log: true }).then((r) => {
    console.log(`\nclaim-assessment: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
