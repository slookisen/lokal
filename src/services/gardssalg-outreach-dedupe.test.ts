/**
 * gardssalg-outreach-dedupe.test.ts — unit tests for
 * src/services/gardssalg-outreach-dedupe.ts's dedupeGardssalgOutreachRecipients.
 *
 * dev-request 2026-07-31-gardssalg-provider-dubletter-på-tvers-av-seeds,
 * Slice 2 ("outreach-guard"). Pure function, no DB.
 *
 * Covers:
 *   (a) exact-email duplicate -> 2nd candidate suppressed "duplikat_epost"
 *   (b) different emails, same non-freemail registrable domain -> 2nd
 *       candidate suppressed "duplikat_epost_domene"
 *   (c) different emails sharing a FREE_MAIL_DOMAINS domain (e.g. both
 *       @gmail.com, different local-part) -> NEITHER suppressed
 *   (d) null/empty email -> always allowed, never a dedup source or target
 *   (e) input order determines the winner (first seen)
 *
 * Run standalone: npx tsx src/services/gardssalg-outreach-dedupe.test.ts
 * Wired into tests/test.ts via runGardssalgOutreachDedupeTests().
 */

import { dedupeGardssalgOutreachRecipients } from "./gardssalg-outreach-dedupe";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runGardssalgOutreachDedupeTests(opts: { log?: boolean } = {}): TestSummary {
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

  // ── (a) exact-email duplicate ─────────────────────────────────────────
  {
    const r = dedupeGardssalgOutreachRecipients([
      { provider_id: "a1", email: "post@gardsbutikk.no" },
      { provider_id: "a2", email: "post@gardsbutikk.no" },
    ]);
    assertTrue(r.allowed.has("a1"), "a: first exact-email candidate allowed");
    assertTrue(!r.allowed.has("a2"), "a: second exact-email duplicate not allowed");
    assertEq(r.suppressed.get("a2"), "duplikat_epost", "a: second exact-email duplicate suppressed as duplikat_epost");
    assertTrue(!r.suppressed.has("a1"), "a: first candidate not suppressed");
  }
  // Case-insensitive / whitespace-insensitive exact match.
  {
    const r = dedupeGardssalgOutreachRecipients([
      { provider_id: "a1", email: "Post@Gardsbutikk.no" },
      { provider_id: "a2", email: "  post@gardsbutikk.no  " },
    ]);
    assertTrue(r.allowed.has("a1"), "a-case: first candidate allowed");
    assertEq(r.suppressed.get("a2"), "duplikat_epost", "a-case: lowercased/trimmed exact match still suppressed as duplikat_epost");
  }

  // ── (b) different emails, same non-freemail registrable domain ───────
  {
    const r = dedupeGardssalgOutreachRecipients([
      { provider_id: "b1", email: "post@gardsbutikk.no" },
      { provider_id: "b2", email: "kontakt@gardsbutikk.no" },
    ]);
    assertTrue(r.allowed.has("b1"), "b: first candidate allowed");
    assertTrue(!r.allowed.has("b2"), "b: second candidate (same domain, different email) not allowed");
    assertEq(r.suppressed.get("b2"), "duplikat_epost_domene", "b: second candidate suppressed as duplikat_epost_domene");
  }
  // Distinct non-freemail domains -> both allowed.
  {
    const r = dedupeGardssalgOutreachRecipients([
      { provider_id: "b3", email: "post@gard-a.no" },
      { provider_id: "b4", email: "post@gard-b.no" },
    ]);
    assertTrue(r.allowed.has("b3") && r.allowed.has("b4"), "b: distinct non-freemail domains both allowed");
    assertTrue(!r.suppressed.has("b3") && !r.suppressed.has("b4"), "b: distinct non-freemail domains -> no suppression");
  }

  // ── (c) shared FREE_MAIL_DOMAINS domain, different local-part -> OK ──
  {
    const r = dedupeGardssalgOutreachRecipients([
      { provider_id: "c1", email: "produsent.en@gmail.com" },
      { provider_id: "c2", email: "produsent.to@gmail.com" },
    ]);
    assertTrue(r.allowed.has("c1"), "c: first gmail.com candidate allowed");
    assertTrue(r.allowed.has("c2"), "c: second gmail.com candidate (different local-part) also allowed");
    assertTrue(!r.suppressed.has("c1") && !r.suppressed.has("c2"), "c: neither gmail.com candidate suppressed (freemail domain exempt from domain rule)");
  }
  // Norwegian ISP freemail domain (online.no) — same exemption.
  {
    const r = dedupeGardssalgOutreachRecipients([
      { provider_id: "c3", email: "ola@online.no" },
      { provider_id: "c4", email: "kari@online.no" },
    ]);
    assertTrue(r.allowed.has("c3") && r.allowed.has("c4"), "c: both online.no candidates allowed (freemail exemption)");
  }
  // But exact-email dedup STILL applies to freemail addresses.
  {
    const r = dedupeGardssalgOutreachRecipients([
      { provider_id: "c5", email: "samme@gmail.com" },
      { provider_id: "c6", email: "samme@gmail.com" },
    ]);
    assertEq(r.suppressed.get("c6"), "duplikat_epost", "c: exact-email rule still applies within a freemail domain");
  }

  // ── (d) null/empty email -> always allowed, never a dedup source/target ──
  {
    const r = dedupeGardssalgOutreachRecipients([
      { provider_id: "d1", email: null },
      { provider_id: "d2", email: "" },
      { provider_id: "d3", email: "   " },
    ]);
    assertTrue(r.allowed.has("d1") && r.allowed.has("d2") && r.allowed.has("d3"), "d: null/empty/whitespace-only emails all allowed");
    assertTrue(!r.suppressed.has("d1") && !r.suppressed.has("d2") && !r.suppressed.has("d3"), "d: null/empty emails never suppressed");
  }
  // A null-email candidate never suppresses a later real-email candidate,
  // even one sharing... nothing (there's nothing to share), and a real
  // candidate is never suppressed by a later null-email one either.
  {
    const r = dedupeGardssalgOutreachRecipients([
      { provider_id: "d4", email: null },
      { provider_id: "d5", email: "post@gardsbutikk.no" },
      { provider_id: "d6", email: null },
    ]);
    assertTrue(r.allowed.has("d4") && r.allowed.has("d5") && r.allowed.has("d6"), "d: null-email candidates never interfere with a real-email candidate");
  }

  // ── (e) input order determines the winner (first seen) ───────────────
  {
    const r = dedupeGardssalgOutreachRecipients([
      { provider_id: "e2", email: "post@gardsbutikk.no" },
      { provider_id: "e1", email: "post@gardsbutikk.no" },
    ]);
    // Whichever came FIRST in the input array wins, regardless of id sort order.
    assertTrue(r.allowed.has("e2"), "e: first-in-input-order candidate (e2) wins, not e1");
    assertEq(r.suppressed.get("e1"), "duplikat_epost", "e: later-in-input-order candidate (e1) is suppressed");
  }
  {
    // Same, but for the domain rule.
    const r = dedupeGardssalgOutreachRecipients([
      { provider_id: "e4", email: "andre@gardsbutikk.no" },
      { provider_id: "e3", email: "forste@gardsbutikk.no" },
    ]);
    assertTrue(r.allowed.has("e4"), "e-domain: first-in-input-order candidate (e4) wins the domain slot");
    assertEq(r.suppressed.get("e3"), "duplikat_epost_domene", "e-domain: later-in-input-order candidate (e3) is suppressed");
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── gardssalg-outreach-dedupe (pure function) unit tests ──");
  const r = runGardssalgOutreachDedupeTests({ log: true });
  console.log(`\ngardssalg-outreach-dedupe: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
  process.exit(0);
}
