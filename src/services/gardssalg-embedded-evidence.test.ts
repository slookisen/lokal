/**
 * gardssalg-embedded-evidence.test.ts — tests for the embedded-content
 * evidence layer (dev-request 2026-08-08-gardssalg-brreg-verify-og-embedded-
 * evidens): gardssalgEmbeddedPageText() plus its two consumers'
 * pure-function behavior — the ownership-evidence match run over
 * visible+embedded text, and extractGardssalgContactEmail()'s new
 * lowest-priority "embedded_same_domain" tier.
 *
 * The load-bearing fixture reproduces the live 67 North Distillery case
 * (67northdistillery.no, org 925174971, Saltdal/Rognan): a sitebuilder SPA
 * whose raw HTML renders NO visible body text — the <title> is the only
 * tag-strippable content — while the script-embedded JSON carries the
 * registered street address ("Skomakergata 13\n8250 Rognan") and the
 * same-domain contact email ("post@67northdistillery.no"). On the
 * pre-change code the evidence match scores name-only (never verifies) and
 * the email extractor returns null; with the embedded layer both succeed —
 * with signals still matched exclusively against registry-held data.
 *
 * Covers:
 *   (a) gardssalgEmbeddedPageText: escaped-JSON decoding (\n, \", \uXXXX,
 *       \/), base64-blob and huge-string skipping, meta description/og:*
 *       extraction in both attribute orders, empty/no-script inputs
 *   (b) evidence: visible-layer fail + combined-layer verify on the SPA
 *       fixture (name + place/address + title branch); an unrelated SPA
 *       (no registry signals in its JSON) still does NOT verify
 *   (c) email extraction: embedded same-domain → "embedded_same_domain";
 *       embedded freemail NEVER returned (even on contact-ish pages);
 *       embedded placeholder-domain rejected; visible-text tiers keep
 *       priority when both layers carry addresses
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runGardssalgEmbeddedEvidenceTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    assertEq(cond, true, label);
  }

  return (async () => {
    const {
      gardssalgEmbeddedPageText,
      gardssalgPageText,
      gardssalgPageTitle,
      gardssalgWebsiteEvidenceMatch,
      extractGardssalgContactEmail,
    } = require("./experience-store") as typeof import("./experience-store");

    // ── Fixture: minimal Wix-style SPA shell shaped like the live
    // 67northdistillery.no page — real body is empty, content lives as
    // escaped string literals inside a script-embedded JSON blob. ──────────
    const SPA_67N_HTML = [
      "<!doctype html><html><head>",
      "<title>67 North Distillery</title>",
      '<meta property="og:title" content="67 North Distillery"/>',
      "</head><body>",
      '<div id="root"></div>',
      "<script>",
      'var warmupData = {"pages":[{"N":"paragraph1","a":{"A":[{"A?":"A","A":"Skomakergata 13\\n8250 Rognan\\n"}]}},',
      '{"N":"paragraph2","a":{"A":[{"A?":"A","A":"post@67northdistillery.no\\n"}]}},',
      '{"N":"photo","G":"https://www.facebook.com/RognanOnTheRocks/"},',
      '{"N":"blob","B":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]};',
      "</script>",
      "</body></html>",
    ].join("\n");

    const TARGET_67N = {
      orgNr: "925174971",
      navn: "67 North Distillery",
      kommune: "Saltdal",
      poststed: "Rognan",
      telefon: null,
      mobil: null,
      adresse: "Skomakergata 13",
      postnummer: "8250",
    };

    // ── (a) gardssalgEmbeddedPageText ───────────────────────────────────────
    const embedded = gardssalgEmbeddedPageText(SPA_67N_HTML);
    assertTrue(embedded.includes("Skomakergata 13 8250 Rognan"), "embedded: \\n-escaped address decoded to spaced text");
    assertTrue(embedded.includes("post@67northdistillery.no"), "embedded: email string literal extracted");
    assertTrue(!embedded.includes("AAAAAAAA"), "embedded: base64ish blob (>=80 chars) skipped");
    assertTrue(embedded.includes("67 North Distillery"), "embedded: og:title meta content extracted");

    const visible = gardssalgPageText(SPA_67N_HTML);
    assertTrue(!visible.includes("Skomakergata"), "visible layer control: address NOT in tag-stripped text");
    assertTrue(!visible.includes("post@67northdistillery.no"), "visible layer control: email NOT in tag-stripped text");

    assertEq(gardssalgEmbeddedPageText(""), "", "embedded: empty input -> empty string");
    assertEq(gardssalgEmbeddedPageText("<p>Hei</p>"), "", "embedded: no scripts/metas -> empty string");

    const unicodeHtml = '<script>var a = {"t":"Br\\u00f8dr. Hansen G\\u00e5rd"};</script>';
    assertTrue(
      gardssalgEmbeddedPageText(unicodeHtml).includes("Brødr. Hansen Gård"),
      "embedded: \\uXXXX escapes decoded",
    );

    const metaFirstOrder = '<meta content="Destilleri i Saltdal" name="description">';
    assertTrue(
      gardssalgEmbeddedPageText(metaFirstOrder).includes("Destilleri i Saltdal"),
      "embedded: meta with content BEFORE name still extracted",
    );

    // ── (b) evidence match: visible fails, visible+embedded verifies ──────
    const title = gardssalgPageTitle(SPA_67N_HTML);
    const evVisible = gardssalgWebsiteEvidenceMatch(visible, TARGET_67N, title);
    assertEq(evVisible.verified, false, "evidence(visible): 67N SPA does NOT verify on tag-stripped text alone");
    assertEq(evVisible.name_found, true, "evidence(visible): name IS found (title text survives tag-strip)");
    assertEq(evVisible.place_found, false, "evidence(visible): place NOT found in visible text");

    const evCombined = gardssalgWebsiteEvidenceMatch(`${visible} ${embedded}`, TARGET_67N, title);
    assertEq(evCombined.verified, true, "evidence(visible+embedded): 67N SPA VERIFIES");
    assertEq(evCombined.place_found, true, "evidence(visible+embedded): place (Rognan) found in embedded JSON");
    assertEq(evCombined.address_found, true, "evidence(visible+embedded): registered street address found");
    assertEq(evCombined.title_found, true, "evidence(visible+embedded): title corroborates the name");

    // Unrelated SPA (different business's JSON) must NOT verify — the layer
    // widens where we read, not what counts as evidence.
    const SPA_OTHER_HTML = [
      "<title>Fjellbekk Design</title>",
      '<script>var d = {"a":"Storgata 99\\n0155 Oslo","e":"hei@fjellbekkdesign.no"};</script>',
    ].join("\n");
    const evOther = gardssalgWebsiteEvidenceMatch(
      `${gardssalgPageText(SPA_OTHER_HTML)} ${gardssalgEmbeddedPageText(SPA_OTHER_HTML)}`,
      TARGET_67N,
      gardssalgPageTitle(SPA_OTHER_HTML),
    );
    assertEq(evOther.verified, false, "evidence(embedded): unrelated SPA carrying no registry signals does NOT verify");

    // ── (c) email extraction: embedded tier ───────────────────────────────
    const embeddedEmail = extractGardssalgContactEmail(SPA_67N_HTML, "67northdistillery.no", false);
    assertEq(
      embeddedEmail,
      { email: "post@67northdistillery.no", source: "embedded_same_domain" },
      "email: same-domain address in embedded JSON -> embedded_same_domain",
    );

    // Same page, WRONG homepage domain -> the embedded tier must not fire
    // (same-domain only; an embedded other-domain address is config noise).
    assertEq(
      extractGardssalgContactEmail(SPA_67N_HTML, "annengard.no", false),
      null,
      "email: embedded address with non-matching homepage domain -> null",
    );

    // Embedded freemail must NEVER be returned — not even on a contact-ish
    // page (the visible-text contact-page tier deliberately keeps freemail
    // for VISIBLE addresses only).
    const freemailEmbedded = '<script>var cfg = {"owner":"gardsdrift77@gmail.com"};</script>';
    assertEq(
      extractGardssalgContactEmail(freemailEmbedded, "minprodusent.no", true),
      null,
      "email: embedded freemail -> null even on contact-ish page",
    );

    // Embedded placeholder-domain (un-customised sitebuilder boilerplate)
    // rejected by the shared push-guards.
    const placeholderEmbedded = '<script>var cfg = {"m":"info@mysite.com"};</script>';
    assertEq(
      extractGardssalgContactEmail(placeholderEmbedded, "mysite.com", false),
      null,
      "email: embedded placeholder-domain address -> null",
    );

    // Visible-text tiers keep priority when both layers carry addresses.
    const bothLayers = [
      "<p>Kontakt: post@synliggard.no</p>",
      '<script>var d = {"e":"skjult@synliggard.no"};</script>',
    ].join("\n");
    assertEq(
      extractGardssalgContactEmail(bothLayers, "synliggard.no", false),
      { email: "post@synliggard.no", source: "text_same_domain" },
      "email: visible same-domain address outranks embedded address",
    );

    // mailto still outranks everything (regression on the existing tiers).
    const mailtoPlusEmbedded = [
      '<a href="mailto:direkte@gardsbruk.no">Send epost</a>',
      '<script>var d = {"e":"annen@gardsbruk.no"};</script>',
    ].join("\n");
    assertEq(
      extractGardssalgContactEmail(mailtoPlusEmbedded, "gardsbruk.no", false),
      { email: "direkte@gardsbruk.no", source: "mailto" },
      "email: mailto tier still outranks embedded tier",
    );

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/services/gardssalg-embedded-evidence.test.ts`
if (require.main === module) {
  runGardssalgEmbeddedEvidenceTests({ log: true }).then((s) => {
    console.log(`\ngardssalg-embedded-evidence: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      for (const f of s.failures) console.error(f);
      process.exit(1);
    }
  });
}
