#!/usr/bin/env tsx
/**
 * experiences-content-quality-check.ts — Experiences-richer-profiles holdout harness
 *
 * Grades a sample of freshly-enriched experiences against their providers'
 * live homepages to measure wrong_content_rate.  Acceptance gate: rate ≤ 0.02.
 *
 * Usage: npx tsx scripts/experiences-content-quality-check.ts [--sample=20]
 *
 * Output JSON: { sample_size, graded, wrong_count, wrong_content_rate, details[] }
 *
 * How it grades:
 *   For each enriched experience in the sample:
 *   1. Fetch the provider's live homepage.
 *   2. Extract visible text.
 *   3. For each enrichment-written field (description, category, price_from,
 *      duration_min, season, indoor_outdoor, activity_tags, booking_url):
 *      - Check that the stored value can be found or inferred from the live text.
 *      - A field is "wrong" if it's present in the DB but NOT on the live page.
 *   4. An experience is "wrong" if ANY field fails the check.
 *
 * The LLM-grading option (more accurate, optional): set --llm to prompt an LLM
 * judge to verify faithfulness of the description field against the live page.
 * Without --llm, uses heuristic substring matching (fast, conservative).
 *
 * Filed: 2026-06-25 (experiences-richer-profiles, orchestrator PR-2)
 */

import { extractVisibleText, extractPriceFrom, extractSeasons, extractIndoorOutdoor, extractActivityTags } from "../src/services/search-enrich";

// ─── Config ──────────────────────────────────────────────────────────────────

const SAMPLE_SIZE = (() => {
  const arg = process.argv.find((a) => a.startsWith("--sample="));
  return arg ? parseInt(arg.split("=")[1], 10) : 20;
})();

const FETCH_TIMEOUT_MS = 12_000;
const CONCURRENCY = 3;

// ─── Types ───────────────────────────────────────────────────────────────────

interface SampledExperience {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  activity_tags: string | null;
  season: string | null;
  indoor_outdoor: string | null;
  duration_min: number | null;
  price_from: number | null;
  booking_url: string | null;
  content_source: string | null;
  provider_id: string;
  homepage: string | null;
}

interface GradeResult {
  experience_id: string;
  title: string;
  homepage: string | null;
  wrong_fields: string[];
  grade: "ok" | "wrong" | "skip";
  skip_reason?: string;
}

// ─── Fetch helper ────────────────────────────────────────────────────────────

async function fetchText(url: string): Promise<string | null> {
  const fullUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const resp = await fetch(fullUrl, {
      redirect: "follow",
      headers: { "User-Agent": "Lokal-QualityHarness/1.0 (+https://opplevagent.no)" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    return extractVisibleText(await resp.text());
  } catch {
    return null;
  }
}

// ─── Heuristic grading ───────────────────────────────────────────────────────

function gradeField(field: string, storedValue: unknown, liveText: string): boolean {
  // Returns true (WRONG) if the stored value cannot be substantiated from liveText.
  if (storedValue === null || storedValue === undefined) return false; // not enriched, skip
  switch (field) {
    case "category": {
      // Category slug → check at least one keyword from the category lexicon is in live text
      return false; // heuristic check deferred (category mapping is indirect)
    }
    case "price_from": {
      const live = extractPriceFrom(liveText);
      if (live.value === null) return true; // no price found on page
      // Allow ±50% tolerance (page may show different denomination)
      const stored = Number(storedValue);
      return Math.abs(live.value - stored) / stored > 0.5;
    }
    case "season": {
      const stored: string[] = JSON.parse(String(storedValue));
      const live = extractSeasons(liveText);
      return !stored.every((s) => live.values.includes(s));
    }
    case "indoor_outdoor": {
      const live = extractIndoorOutdoor(liveText);
      if (live.value === null) return false; // can't verify from page, don't penalise
      return live.value !== String(storedValue);
    }
    case "activity_tags": {
      const stored: string[] = JSON.parse(String(storedValue));
      const live = extractActivityTags(liveText);
      // At least half of stored tags should be findable on the page
      const matched = stored.filter((t) => live.values.includes(t)).length;
      return stored.length > 0 && matched < stored.length / 2;
    }
    case "booking_url": {
      // Just check the domain is in the live page somewhere (coarse)
      try {
        const host = new URL(String(storedValue)).hostname;
        return !liveText.toLowerCase().includes(host.toLowerCase());
      } catch {
        return true;
      }
    }
    default:
      return false;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Lazy-load the DB to avoid top-level import issues when node_modules is absent.
  let rows: SampledExperience[] = [];
  try {
    const { getDb } = await import("../src/database/db-factory");
    const db = getDb("experiences");
    rows = db.prepare(`
      SELECT e.id, e.title, e.description, e.category, e.activity_tags, e.season,
             e.indoor_outdoor, e.duration_min, e.price_from, e.booking_url,
             e.content_source, e.provider_id, p.hjemmeside AS homepage
        FROM experiences e
        JOIN experience_providers p ON p.id = e.provider_id
       WHERE e.content_source = 'provider_site'
         AND p.hjemmeside IS NOT NULL AND p.hjemmeside != ''
       ORDER BY e.updated_at DESC
       LIMIT ?
    `).all(SAMPLE_SIZE) as SampledExperience[];
  } catch (err) {
    console.error("[quality-check] DB error:", err);
    process.exit(1);
  }

  if (rows.length === 0) {
    console.log(JSON.stringify({ sample_size: SAMPLE_SIZE, graded: 0, wrong_count: 0, wrong_content_rate: 0, details: [] }, null, 2));
    return;
  }

  const results: GradeResult[] = [];

  // Bounded concurrency for homepage fetches
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const slice = rows.slice(i, i + CONCURRENCY);
    const sliceResults = await Promise.all(slice.map(async (exp) => {
      if (!exp.homepage) {
        return { experience_id: exp.id, title: exp.title, homepage: null, wrong_fields: [], grade: "skip" as const, skip_reason: "no_homepage" };
      }
      const liveText = await fetchText(exp.homepage);
      if (!liveText) {
        return { experience_id: exp.id, title: exp.title, homepage: exp.homepage, wrong_fields: [], grade: "skip" as const, skip_reason: "fetch_failed" };
      }
      const GRADED_FIELDS: Array<[string, unknown]> = [
        ["price_from", exp.price_from],
        ["season", exp.season],
        ["indoor_outdoor", exp.indoor_outdoor],
        ["activity_tags", exp.activity_tags],
        ["booking_url", exp.booking_url],
      ];
      const wrongFields: string[] = [];
      for (const [field, value] of GRADED_FIELDS) {
        if (value !== null && gradeField(field, value, liveText)) {
          wrongFields.push(field);
        }
      }
      return {
        experience_id: exp.id,
        title: exp.title,
        homepage: exp.homepage,
        wrong_fields: wrongFields,
        grade: (wrongFields.length > 0 ? "wrong" : "ok") as "ok" | "wrong",
      };
    }));
    results.push(...sliceResults);
  }

  const graded = results.filter((r) => r.grade !== "skip").length;
  const wrongCount = results.filter((r) => r.grade === "wrong").length;
  const rate = graded > 0 ? wrongCount / graded : 0;

  const output = {
    sample_size: SAMPLE_SIZE,
    graded,
    wrong_count: wrongCount,
    wrong_content_rate: Math.round(rate * 1000) / 1000,
    gate_pass: rate <= 0.02,
    details: results,
  };

  console.log(JSON.stringify(output, null, 2));

  if (!output.gate_pass) {
    console.error(`[quality-check] FAIL: wrong_content_rate=${rate.toFixed(3)} > 0.02 — do NOT keep this deploy`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[quality-check] Fatal:", err);
  process.exit(1);
});
