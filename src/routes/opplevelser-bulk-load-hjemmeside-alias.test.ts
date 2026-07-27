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
 * The consequence is not cosmetic. That column is the ONLY input to the
 * provider-CREATE homepage write, and selectProvidersForContentRefresh() skips
 * providers with an empty homepage — so a provider harvested this way could
 * never be content-enriched. The harvest SKILL names that exact symptom in its
 * own prose ("this is why enrichment was scanning 0") and tried to fix it by
 * telling the agent to fill the field, using the name the endpoint ignored.
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
