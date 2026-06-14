/**
 * search-enrich.test.ts — unit tests for the PURE decision logic behind
 * POST /admin/search-enrich (services/search-enrich.ts).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/search-enrich.test.ts
 *   2. Wired into the main gate: tests/test.ts imports runSearchEnrichTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 *
 * These are anti-contamination tests — they pin the invariants that keep the
 * pipeline from ever writing a directory/coordinator email or guessing when
 * the evidence is ambiguous.
 */

import {
  nameStems,
  normalizePhone,
  confirmProducerPage,
  pickProducerEmail,
  rankCandidates,
  type PageEvidence,
  type StoredProducer,
  type BraveResult,
} from "./search-enrich";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runSearchEnrichTests(opts: { log?: boolean } = {}): TestSummary {
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

  // ── nameStems ──────────────────────────────────────────────────────────────
  assertEq(nameStems("Nalums Gårdsbutikk"), ["nalums", "nalum"], "nameStems: Nalums Gårdsbutikk → [nalums, nalum]");
  assertEq(nameStems("Stordalen Gård AS"), ["stordalen"], "nameStems: strips 'Gård' + 'AS' stopwords");
  assertEq(nameStems("Ås Gaard SA"), [], "nameStems: 'Ås'(<4 after accent) + stopwords → empty");
  assertTrue(nameStems("Bærum Økologiske").includes("baerum"), "nameStems: æ→ae (bærum→baerum)");
  assertTrue(nameStems("Bærum Økologiske").includes("okologiske"), "nameStems: ø→o, å→a (økologiske→okologiske)");
  assertEq(nameStems(""), [], "nameStems: empty string → []");

  // ── normalizePhone ───────────────────────────────────────────────────────────
  assertEq(normalizePhone("+47 92431142"), "92431142", "normalizePhone: +47 strip + spaces");
  assertEq(normalizePhone("0047 924 31 142"), "92431142", "normalizePhone: 0047 country code stripped");
  assertEq(normalizePhone("92431142"), "92431142", "normalizePhone: bare 8 digits");
  assertEq(normalizePhone("47 92 43 11 42"), "92431142", "normalizePhone: leading 47 + spaced");
  assertEq(normalizePhone(null), "", "normalizePhone: null → ''");
  assertEq(normalizePhone(undefined), "", "normalizePhone: undefined → ''");
  assertEq(normalizePhone("Ring oss!"), "", "normalizePhone: no digits → ''");

  // ── Nalums positive: STRONG confirm via phone, producer email picked ─────────
  {
    const stored: StoredProducer = { name: "Nalums Gårdsbutikk", phone: "+47 92431142" };
    const page: PageEvidence = {
      url: "https://hanen.no/produsent/nalums-gardsbutikk",
      title: "Nalums Gårdsbutikk - Hanen",
      html: "Kontakt: Tlf 924 31 142. E-post: post@hanen.no / hk-nalum@online.no",
      emails: ["post@hanen.no", "hk-nalum@online.no"],
      phones: ["92431142"],
    };
    const conf = confirmProducerPage(stored, page);
    assertEq(conf.strength, "strong", "Nalums: strength === 'strong' (phone match)");
    assertTrue(conf.confirmed, "Nalums: confirmed === true");
    assertTrue(conf.signals.includes("phone_match:92431142"), "Nalums: phone_match signal present");

    const pick = pickProducerEmail(page.emails, stored.name);
    assertEq(pick.email, "hk-nalum@online.no", "Nalums: picks hk-nalum@online.no (NOT post@hanen.no)");
    assertTrue(pick.reason.startsWith("name_stem_match"), `Nalums: reason name_stem_match (got '${pick.reason}')`);
    assertEq(pick.reason, "name_stem_match:nalum", "Nalums: reason names the matched stem 'nalum'");
  }

  // ── Coordinator-only: only post@hanen.no on a confirmed page → null ──────────
  {
    const pick = pickProducerEmail(["post@hanen.no"], "Nalums Gårdsbutikk");
    assertEq(pick.email, null, "Coordinator-only: returns null");
    assertEq(pick.reason, "no_acceptable_email", "Coordinator-only: reason no_acceptable_email");
  }
  // Also confirm the other hub families are rejected.
  {
    const pick = pickProducerEmail(
      ["kontakt@bondensmarkedtroms.no", "post@rekonorge.no"],
      "Nalums Gårdsbutikk",
    );
    assertEq(pick.email, null, "Hub families (bondensmarked/rekonorge) rejected → null");
    assertEq(pick.reason, "no_acceptable_email", "Hub families: no_acceptable_email");
  }

  // ── Wrong page (no key match) → NOT confirmed ────────────────────────────────
  {
    const stored: StoredProducer = { name: "Nalums Gårdsbutikk", phone: "92431142", postcode: "4365" };
    const page: PageEvidence = {
      url: "https://some-other-farm.no",
      title: "Helt Annen Gård",
      html: "Kontakt 99887766. Adresse: Annenveien 3, 1234 Annetsted",
      emails: ["post@some-other-farm.no"],
      phones: ["99887766"], // different phone
    };
    const conf = confirmProducerPage(stored, page);
    assertEq(conf.confirmed, false, "Wrong page: confirmed === false (no key/name/postcode match)");
    assertEq(conf.strength, "none", "Wrong page: strength === 'none'");
  }

  // ── Ambiguous emails: two free-mail, neither a name stem → null ──────────────
  {
    const pick = pickProducerEmail(
      ["random123@gmail.com", "other456@gmail.com"],
      "Nalums Gårdsbutikk",
    );
    assertEq(pick.email, null, "Ambiguous: two distinct free-mails, no stem → null");
    assertEq(pick.reason, "ambiguous_multiple", "Ambiguous: reason ambiguous_multiple");
  }

  // ── MEDIUM confirm: two soft signals (name_in_title + postcode) ──────────────
  {
    const stored: StoredProducer = { name: "Nalums Gårdsbutikk", phone: "92431142", postcode: "4365" };
    const page: PageEvidence = {
      url: "https://nalum.no",
      title: "Nalums Gårdsbutikk – Velkommen",
      html: "Vi holder til i 4365 Nærbø. Ring oss gjerne.",
      emails: ["post@nalum.no"],
      phones: ["55555555"], // wrong phone → not strong
    };
    const conf = confirmProducerPage(stored, page);
    assertEq(conf.strength, "medium", "Medium: strength === 'medium' (name_in_title + postcode)");
    assertTrue(conf.confirmed, "Medium: confirmed === true (2 soft signals)");
    assertTrue(conf.signals.includes("name_in_title"), "Medium: name_in_title signal");
    assertTrue(conf.signals.includes("postcode_on_page"), "Medium: postcode_on_page signal");
  }

  // ── site_domain_match priority: email on stored siteRoot wins ────────────────
  {
    const pick = pickProducerEmail(
      ["info@nalum.no", "someoneelse@gmail.com"],
      "Nalums Gårdsbutikk",
      "nalum.no",
    );
    assertEq(pick.email, "info@nalum.no", "siteRoot: own-domain email chosen first");
    assertEq(pick.reason, "site_domain_match", "siteRoot: reason site_domain_match");
  }

  // ── single free-mail (no stem) → accepted as free_mail ───────────────────────
  {
    const pick = pickProducerEmail(["lonely@gmail.com"], "Nalums Gårdsbutikk");
    assertEq(pick.email, "lonely@gmail.com", "free_mail: single free-mail accepted");
    assertEq(pick.reason, "free_mail", "free_mail: reason free_mail");
  }

  // ── rankCandidates: producer-named result beats unrelated ────────────────────
  {
    const results: BraveResult[] = [
      { title: "Totally Unrelated Blog", url: "https://unrelated.example.com/post", description: "nothing here" },
      { title: "Nalums Gårdsbutikk offisiell side", url: "https://nalum.no", description: "Nalums gårdsbutikk i Nærbø" },
      { title: "Random news", url: "https://news.example.com", description: "weather today" },
    ];
    const ranked = rankCandidates(results, "Nalums Gårdsbutikk");
    assertTrue(ranked.length >= 1, "rankCandidates: at least one match");
    assertEq(ranked[0], "https://nalum.no", "rankCandidates: producer result ranked first");
    assertTrue(!ranked.includes("https://news.example.com"), "rankCandidates: unrelated (score 0) excluded");
    assertTrue(ranked.length <= 2, "rankCandidates: returns at most 2 URLs");
  }

  // ── rankCandidates: no name → [] ─────────────────────────────────────────────
  {
    const ranked = rankCandidates(
      [{ title: "x", url: "https://x.no", description: "y" }],
      "AS SA OG", // all stopwords → no stems
    );
    assertEq(ranked, [], "rankCandidates: name with only stopwords → []");
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/search-enrich.test.ts`
// (require.main === module is the CJS entrypoint check; tsconfig compiles to CJS.)
if (require.main === module) {
  console.log("── search-enrich unit tests ──");
  const r = runSearchEnrichTests({ log: true });
  console.log(`\nsearch-enrich: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
  process.exit(0);
}
