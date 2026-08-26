/**
 * experience-provider-canonicalize.test.ts — pure-function tests for
 * services/experience-provider-canonicalize.ts.
 *
 * dev-request 2026-08-25-experiences-retro-opprydding-boilerplate-innhold,
 * spec-punkt 2. Root-cause probe found Vitensenteret/Ringve/Brosundet/
 * Hunderfossen persisting as duplicate experience_providers ROWS (confirmed
 * live 2026-08-26 via GET .../admin/gardssalg-provider-lookup) — a gap the
 * experience-ROW dedup pass (experience-dedup.ts) can never close, since its
 * providerIdentityKey() only bridges rows that already share a provider_id or
 * org_nr. This module mirrors GET /admin/gardssalg-provider-dedup-audit's own
 * signal design (routes/opplevelser.ts) — same identity-vs-hint split, same
 * org_nr-conflict override — but scoped to the COMPLEMENT of that audit
 * (non-gårdssalg providers) and keyed on kommune instead of postnummer.
 *
 * Covers (no DB, no HTTP — groupExperienceProviderCandidates() is pure):
 *   (a) real production shape: three "Vitensenteret" spellings, same
 *       kommune, no org_nr on any of them -> one group, LOW confidence
 *       (name_first_token_kommune/name_first_token alone is a hint, never an
 *       identity-bearing signal — same lesson dev-request 2026-08-18-
 *       gardssalg-dedup-org-nr-override already encoded for the gårdssalg
 *       twin); this is the exact real shape the merge step is authorized to
 *       act on anyway, because THAT authorization comes from the out-of-band
 *       investigation, not from this audit's confidence grade
 *   (b) name_exact -> HIGH confidence
 *   (c) org_nr-only signal (distinct names) -> HIGH confidence
 *   (d) domain-only signal (distinct names/org_nr) -> HIGH confidence
 *   (e) org_nr conflict (both sides populated, different) overrides a
 *       name_exact match to LOW, org_nr_conflict:true
 *   (f) negative control — two genuinely different providers, different
 *       kommune, no shared token -> never grouped
 *   (g) response row shape: only id/navn/org_nr/kommune/fylke/content_source/
 *       has_website — no raw hjemmeside value anywhere
 *   (h) providerBestNameTier is symmetric in argument order
 */

import {
  groupExperienceProviderCandidates,
  providerBestNameTier,
  type ExperienceProviderCandidateRow,
} from "./experience-provider-canonicalize";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runExperienceProviderCanonicalizeTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    try {
      function row(r: Partial<ExperienceProviderCandidateRow> & { id: string; navn: string }): ExperienceProviderCandidateRow {
        return {
          org_nr: null,
          hjemmeside: null,
          kommune: null,
          fylke: null,
          content_source: null,
          ...r,
        };
      }

      // ── (a) real production shape — Vitensenteret 3-way, no org_nr ────────
      const vitensenteretRows: ExperienceProviderCandidateRow[] = [
        row({ id: "prov-vit-a", navn: "Vitensenteret i Trondheim", kommune: "Trondheim", fylke: "Trøndelag" }),
        row({ id: "prov-vit-b", navn: "Vitensenteret Trondheim", kommune: "Trondheim", fylke: "Trøndelag" }),
        row({ id: "prov-vit-c", navn: "Vitensenteret", kommune: "Trondheim", fylke: "Trøndelag" }),
      ];
      const vitensenteretGroups = groupExperienceProviderCandidates(vitensenteretRows);
      assertEq(vitensenteretGroups.length, 1, "a1: the three Vitensenteret spellings collapse into exactly one group");
      const vitGroup = vitensenteretGroups[0];
      assertEq(vitGroup?.rows.length, 3, "a2: the group contains all three rows");
      assertEq(vitGroup?.confidence, "low", "a3: LOW confidence — no org_nr/domain/exact-name identity anchor, only a shared first token + kommune");
      assertEq(vitGroup?.confidence_signals, [], "a4: confidence_signals is empty — nothing identity-bearing fired");
      assertTrue(
        vitGroup?.signals.some((s) => s === "name_first_token_kommune" || s === "name_first_token") ?? false,
        "a5: signals report the first-token evidence (even though it's only a hint, it must not be silently dropped)",
      );
      assertEq(vitGroup?.org_nr_conflict, false, "a6: no org_nr conflict (none of the three rows carries an org_nr)");

      // ── (b) name_exact -> HIGH ──────────────────────────────────────────────
      const exactRows: ExperienceProviderCandidateRow[] = [
        row({ id: "prov-ringve-a", navn: "Ringve Museum", kommune: "Trondheim" }),
        row({ id: "prov-ringve-b", navn: "Ringve Museum", kommune: "Trondheim" }),
      ];
      const exactGroups = groupExperienceProviderCandidates(exactRows);
      assertEq(exactGroups.length, 1, "b1: identical names collapse into one group");
      assertEq(exactGroups[0]?.confidence, "high", "b2: name_exact alone is HIGH confidence");
      assertTrue(exactGroups[0]?.signals.includes("name_exact") ?? false, "b3: signals include name_exact");
      assertEq(exactGroups[0]?.confidence_signals, ["name_exact"], "b4: confidence_signals is exactly [\"name_exact\"]");

      // ── (c) org_nr-only signal (distinct names) -> HIGH ─────────────────────
      const orgNrRows: ExperienceProviderCandidateRow[] = [
        row({ id: "prov-org-a", navn: "Hunderfossen AS", org_nr: "912345678" }),
        row({ id: "prov-org-b", navn: "Hunderfossen Eventyrpark", org_nr: "912345678" }),
      ];
      const orgNrGroups = groupExperienceProviderCandidates(orgNrRows);
      assertEq(orgNrGroups.length, 1, "c1: same org_nr collapses into one group even with different names");
      assertEq(orgNrGroups[0]?.confidence, "high", "c2: org_nr match is HIGH confidence");
      assertEq(orgNrGroups[0]?.confidence_signals, ["org_nr"], "c3: confidence_signals is exactly [\"org_nr\"]");

      // ── (d) domain-only signal (distinct names/org_nr) -> HIGH ──────────────
      const domainRows: ExperienceProviderCandidateRow[] = [
        row({ id: "prov-dom-a", navn: "Hotel Brosundet", hjemmeside: "https://www.brosundet.no/hotell" }),
        row({ id: "prov-dom-b", navn: "Brosundet Restaurant", hjemmeside: "http://brosundet.no" }),
      ];
      const domainGroups = groupExperienceProviderCandidates(domainRows);
      assertEq(domainGroups.length, 1, "d1: shared registrable domain collapses into one group even with different names");
      assertEq(domainGroups[0]?.confidence, "high", "d2: domain match is HIGH confidence");
      assertEq(domainGroups[0]?.confidence_signals, ["domain"], "d3: confidence_signals is exactly [\"domain\"]");

      // ── (e) org_nr conflict overrides name_exact -> LOW ─────────────────────
      const conflictRows: ExperienceProviderCandidateRow[] = [
        row({ id: "prov-conflict-a", navn: "Fjellro Museum", org_nr: "111000111" }),
        row({ id: "prov-conflict-b", navn: "Fjellro Museum", org_nr: "222000222" }),
      ];
      const conflictGroups = groupExperienceProviderCandidates(conflictRows);
      assertEq(conflictGroups.length, 1, "e1: still grouped (name_exact matched) despite the org_nr conflict");
      assertEq(conflictGroups[0]?.confidence, "low", "e2: LOW confidence — different, both-populated org_nr overrides the exact-name match");
      assertEq(conflictGroups[0]?.confidence_signals, [], "e3: confidence_signals is empty — name_exact did NOT count toward confidence");
      assertTrue(conflictGroups[0]?.signals.includes("name_exact") ?? false, "e4: name_exact is still reported in signals (it WAS matched, just doesn't count)");
      assertEq(conflictGroups[0]?.org_nr_conflict, true, "e5: org_nr_conflict:true");

      // ── (f) negative control ────────────────────────────────────────────────
      const negRows: ExperienceProviderCandidateRow[] = [
        row({ id: "prov-neg-a", navn: "Nidarosdomen", kommune: "Trondheim" }),
        row({ id: "prov-neg-b", navn: "Bryggen i Bergen", kommune: "Bergen" }),
      ];
      const negGroups = groupExperienceProviderCandidates(negRows);
      assertEq(negGroups.length, 0, "f1: two genuinely different providers never group");

      // ── (g) response row shape / no raw hjemmeside ──────────────────────────
      const domainRowOut = domainGroups[0]?.rows.find((r) => r.id === "prov-dom-a");
      assertEq(
        Object.keys(domainRowOut ?? {}).sort(),
        ["content_source", "fylke", "has_website", "id", "kommune", "navn", "org_nr"].sort(),
        "g1: row object carries only the documented fields",
      );
      const serialized = JSON.stringify(domainGroups);
      assertTrue(!serialized.includes("brosundet.no"), "g2: response never includes the raw hjemmeside value");
      assertEq(domainRowOut?.has_website, true, "g3: has_website is true for a row with a populated hjemmeside");

      // ── (h) providerBestNameTier is symmetric ───────────────────────────────
      const a = { navn: "Vitensenteret", kommune: "Trondheim" };
      const b = { navn: "Vitensenteret i Trondheim", kommune: "Trondheim" };
      assertEq(providerBestNameTier(a, b), providerBestNameTier(b, a), "h1: providerBestNameTier is symmetric in argument order");
    } catch (err: any) {
      failed++;
      failures.push("experience-provider-canonicalize: unexpected error: " + String(err?.stack || err?.message || err));
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/services/experience-provider-canonicalize.test.ts`
if (require.main === module) {
  runExperienceProviderCanonicalizeTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
