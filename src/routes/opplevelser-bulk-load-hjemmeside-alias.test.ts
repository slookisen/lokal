/**
 * opplevelser-bulk-load-hjemmeside-alias.test.ts
 *
 * Regression proof for dev-request 2026-07-27-harvest-hjemmeside-feltnavn-tapes.
 *
 * The harvest SKILL (scheduled-agents/experiences-harvest.md) instructs its
 * agent to send a row field named `hjemmeside` — under the heading "Build rows
 * matching BulkRowSchema EXACTLY" — while BulkRowSchema only ever accepted
 * `website`. `z.object()` strips unknown keys silently, so every harvested
 * homepage was discarded at the door: HTTP 200, provider created, homepage
 * column NULL, no error anywhere.
 *
 * The consequence is not cosmetic, but it is NOT the one first claimed here.
 * An earlier version of this header said such a provider "could never be
 * content-enriched" — independent review showed that is not what the code does,
 * and the source comment in opplevelser.ts was corrected. Keeping the retracted
 * version alive in the regression-proof file would be worse than useless, so:
 *
 * selectProvidersForContentRefresh() (services/experience-store.ts) COALESCEs
 * the homepage with the provider's first non-empty experience `evidence_url`,
 * and its WHERE explicitly admits `hjemmeside IS NULL` rows that have one. So
 * affected providers WERE still picked up — and enrichment then fetched and
 * extracted from the EVIDENCE url, i.e. the DMO/listing page the provider was
 * discovered on, rather than the provider's own site. That is the same
 * aggregator-as-homepage failure dev-request 2026-07-19-agg-website-leak was
 * filed for, and it is why enrichment runs kept reporting `fetch_failed`
 * against visitnorway.com / visithelgeland.com URLs.
 *
 * These tests pin BOTH names as accepted, so the two sides cannot silently
 * drift apart again.
 */

import { BulkRowSchema, firstNonAggregatorWebsite, type BulkRow } from "./opplevelser";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runBulkLoadHjemmesideAliasTests(opts: { log?: boolean } = {}): TestSummary {
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

  const base = { title: "Guidet fjelltur", provider_name: "TrollAktiv", evidence_url: "https://kilde.example/x" };

  // ── The exact row shape the harvest SKILL tells its agent to build ──────
  {
    const row = BulkRowSchema.parse({ ...base, hjemmeside: "https://trollaktiv.no" });
    assertEq(row.hjemmeside, "https://trollaktiv.no", "alias-1: a row sent with `hjemmeside` keeps it (was silently stripped)");
    assertEq(
      firstNonAggregatorWebsite([row as BulkRow]),
      "https://trollaktiv.no",
      "alias-2: `hjemmeside` reaches the provider-CREATE homepage write",
    );
  }

  // ── The name the schema always accepted still works ────────────────────
  {
    const row = BulkRowSchema.parse({ ...base, website: "https://trollaktiv.no" });
    assertEq(firstNonAggregatorWebsite([row as BulkRow]), "https://trollaktiv.no", "alias-3: `website` still works (no regression)");
  }

  // ── Neither given → null, as before ────────────────────────────────────
  {
    const row = BulkRowSchema.parse({ ...base });
    assertEq(firstNonAggregatorWebsite([row as BulkRow]), null, "alias-4: a row with no homepage at all yields null, not a crash");
  }

  // ── `website` wins when a row carries both ─────────────────────────────
  {
    const row = BulkRowSchema.parse({ ...base, website: "https://kanonisk.no", hjemmeside: "https://annen.no" });
    assertEq(firstNonAggregatorWebsite([row as BulkRow]), "https://kanonisk.no", "alias-5: `website` wins when both are present (deterministic)");
  }

  // ── Empty / whitespace `website` must NOT shadow a real `hjemmeside` ────
  // Independent review found both of these as blocking: `??` only falls
  // through on null/undefined, so `website: ""` yielded null, and a
  // whitespace-only `website` was written verbatim — worse than null, since
  // selectProvidersForContentRefresh() requires TRIM(hjemmeside) != '' for its
  // primary branch and hjemmeside IS NULL for its evidence_url fallback, so a
  // whitespace value satisfies neither and drops the provider entirely.
  {
    const row = BulkRowSchema.parse({ ...base, website: "", hjemmeside: "https://trollaktiv.no" });
    assertEq(
      firstNonAggregatorWebsite([row as BulkRow]),
      "https://trollaktiv.no",
      "alias-8: an EMPTY-string `website` does not shadow a real `hjemmeside` (the `??`-vs-`||` bug)",
    );
  }
  {
    const row = BulkRowSchema.parse({ ...base, website: "   ", hjemmeside: "https://trollaktiv.no" });
    assertEq(
      firstNonAggregatorWebsite([row as BulkRow]),
      "https://trollaktiv.no",
      "alias-9: a WHITESPACE-only `website` does not shadow a real `hjemmeside`, and is never written verbatim",
    );
  }
  {
    const row = BulkRowSchema.parse({ ...base, website: "  https://trollaktiv.no  " });
    assertEq(
      firstNonAggregatorWebsite([row as BulkRow]),
      "https://trollaktiv.no",
      "alias-10: a padded URL is trimmed before it reaches the stored homepage",
    );
  }
  {
    const row = BulkRowSchema.parse({ ...base, website: "", hjemmeside: "" });
    assertEq(firstNonAggregatorWebsite([row as BulkRow]), null, "alias-11: both blank yields null, never an empty string");
  }

  // ── An aggregator in ONE field must not discard a real value in the other ─
  // Round-2 review, blocking: the candidate used to be resolved before the
  // aggregator screen, so an aggregator `website` beat a real `hjemmeside` and
  // the row yielded null.
  {
    const row = BulkRowSchema.parse({
      ...base,
      website: "https://www.visitnorway.com/listings/the-well-spa/12614/",
      hjemmeside: "https://trollaktiv.no",
    });
    assertEq(
      firstNonAggregatorWebsite([row as BulkRow]),
      "https://trollaktiv.no",
      "alias-12: an aggregator `website` does not discard a real `hjemmeside` in the same row",
    );
  }
  {
    const row = BulkRowSchema.parse({
      ...base,
      website: "https://trollaktiv.no",
      hjemmeside: "https://www.visitnorway.com/listings/x/1/",
    });
    assertEq(
      firstNonAggregatorWebsite([row as BulkRow]),
      "https://trollaktiv.no",
      "alias-13: and the mirror case — a real `website` is not lost to an aggregator alias",
    );
  }

  // ── Placeholder junk must never be stored, nor shadow the other field ────
  // Round-2 review (non-blocking #5): "-" / "n/a" / "TBD" are truthy and
  // survive isAggregatorWebsite()'s permissive unparseable-URL path, so they
  // were written verbatim into the provider's homepage — worse than null.
  //
  // Round-3 review (BLOCKING): the first screen here was `v.includes(".")`,
  // and this list was the ONLY thing it was calibrated against — every junk
  // value that happens to contain a dot still got stored AND still shadowed a
  // real `hjemmeside`. The dotted cases below are the reviewer's own
  // reproduction set, verbatim; they are the reason the screen now looks at the
  // parsed HOST (≥2 non-empty labels, alphabetic/punycode TLD ≥2 chars) rather
  // than at the raw string. Do not thin this list — its whole point is that the
  // check must hold for junk nobody wrote a fixture for.
  {
    const junkValues = [
      // dot-less (what the round-2 screen already caught)
      "-", "n/a", "TBD", "null", "   -   ", "ukjent", "localhost",
      // dotted — every one of these passed the round-2 screen and was stored
      "n.a", "n.a.", "N/A.", "tbd.", "..", ".", "-.-", "www.",
      // bare IP literals: a real host, never a producer's homepage
      "1.2.3.4", "0.0.0.0", "192.168.1.1",
      // single-char TLD / label — syntactically dotted, not a real domain
      "a.b",
      // an email address is not a homepage, even though its host parses fine
      "post@gard.no",
      // prose: whitespace-bearing, and the last one even contains a real host
      "Se nettsiden deres.", "ingen hjemmeside, kun facebook.com",
      // a dot-less HOST whose PATH carries the dot — the raw-string check's
      // blind spot in the other direction
      "http://gardsbutikken/index.html",
    ];
    for (const junk of junkValues) {
      const row = BulkRowSchema.parse({ ...base, website: junk, hjemmeside: "https://trollaktiv.no" });
      assertEq(
        firstNonAggregatorWebsite([row as BulkRow]),
        "https://trollaktiv.no",
        `alias-14/${junk.trim()}: placeholder \`${junk}\` neither stored nor allowed to shadow a real homepage`,
      );
      const alone = BulkRowSchema.parse({ ...base, website: junk });
      assertEq(
        firstNonAggregatorWebsite([alone as BulkRow]),
        null,
        `alias-15/${junk.trim()}: placeholder \`${junk}\` alone yields null, never a stored junk homepage`,
      );
    }
  }

  // ── …and the tightening must not cost a single legitimate homepage ──────
  // The other half of the round-3 fix: a shape check that rejects real
  // producer URLs would silently reintroduce the very loss this PR exists to
  // stop, just with a different cause. Every accepted form is pinned, including
  // the ones that motivated parsing the host instead of the string.
  {
    const legit = [
      "trollaktiv.no",
      "https://trollaktiv.no",
      "http://trollaktiv.no",
      "https://www.trollaktiv.no",
      "trollaktiv.no.",                    // trailing FQDN root dot
      "TROLLAKTIV.NO",                     // uppercase
      "gård.no",                           // IDN, unicode form
      "xn--grd-loa.no",                    // …and its punycode form
      "trollaktiv.no/gardsbutikk",         // deep link
      "https://trollaktiv.no/a/b?c=d#e",   // path + query + fragment
      "https://trollaktiv.no:8443/",       // explicit port
      "sjokoladefabrikken.co.uk",          // multi-label suffix
    ];
    for (const v of legit) {
      const row = BulkRowSchema.parse({ ...base, website: v });
      assertEq(
        firstNonAggregatorWebsite([row as BulkRow]),
        v,
        `alias-16/${v}: legitimate homepage \`${v}\` is accepted, and stored VERBATIM (not host-normalized)`,
      );
    }
  }

  // ── The aggregator screen still applies to the alias ────────────────────
  // dev-request 2026-07-19-agg-website-leak: a DMO/aggregator page written
  // into a provider's homepage makes every later content-refresh fail. The
  // alias must not become a bypass around that screen.
  {
    const row = BulkRowSchema.parse({ ...base, hjemmeside: "https://www.visitnorway.com/listings/the-well-spa/12614/" });
    assertEq(
      firstNonAggregatorWebsite([row as BulkRow]),
      null,
      "alias-6: an aggregator URL sent as `hjemmeside` is rejected exactly like one sent as `website`",
    );

    // Round-3 review (finding 4): this file's header and the source comment
    // both cite "visitnorway.com / visithelgeland.com" as the leak being
    // guarded against — but only visitnorway.com was ever in
    // KNOWN_DIRECTORY_HOSTS, so the second host in our own motivating example
    // passed the screen and got stored. It is on the list as of this PR
    // (cross-source-validator.ts), on the strength of the five fetch_failed
    // visithelgeland.com homepages in the 2026-07-25 enrichment run. Pinned in
    // both fields so the claim and the code cannot drift apart again.
    for (const field of ["website", "hjemmeside"] as const) {
      const helgeland = BulkRowSchema.parse({
        ...base,
        [field]: "https://visithelgeland.com/en/product/guided-kayak-tour-in-heroy/",
      });
      assertEq(
        firstNonAggregatorWebsite([helgeland as BulkRow]),
        null,
        `alias-6b/${field}: visithelgeland.com — the OTHER host this PR names — is screened too`,
      );
    }
  }

  // ── Order-independence across rows, via the alias ──────────────────────
  {
    const aggRow = BulkRowSchema.parse({ ...base, hjemmeside: "https://www.visitnorway.com/x" });
    const realRow = BulkRowSchema.parse({ ...base, title: "Rafting", hjemmeside: "https://trollaktiv.no" });
    assertEq(
      firstNonAggregatorWebsite([aggRow as BulkRow, realRow as BulkRow]),
      "https://trollaktiv.no",
      "alias-7: an earlier aggregator row does not shadow a later real homepage",
    );
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/opplevelser-bulk-load-hjemmeside-alias.test.ts`
if (require.main === module) {
  console.log("── bulk-load hjemmeside alias ──");
  const r = runBulkLoadHjemmesideAliasTests({ log: true });
  console.log(`\n${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
  process.exit(0);
}
