#!/usr/bin/env tsx
/**
 * gardssalg-claim-eligibility-coverage.ts — AC7's before/after coverage
 * measurement, made repeatable.
 *
 * dev-request 2026-08-06-aldri-gjett-epostadresse, AC7.
 *
 * WHY THIS EXISTS AS A SCRIPT AND NOT AS A NUMBER IN A REPORT: the AC7
 * measurement is a LIVE, PRODUCTION measurement — "of the published gårdssalg
 * cohort, how many producers can actually claim their profile today". The
 * dev-request's own "Live-verifisering 2026-08-07T07:3xZ" section recorded it
 * by hand against prod (10/87 -> 0/87 after the guessing tier was deleted and
 * before its replacement was wired in). Nothing in a build worktree can
 * reproduce that number: there is no production DB here and no honest way to
 * infer live coverage from fixtures. So this script automates exactly the
 * hand measurement instead, so the after-number is produced the same way the
 * before-number was, by the same method, against the same cohort.
 *
 * Usage:
 *   npx tsx scripts/gardssalg-claim-eligibility-coverage.ts
 *   npx tsx scripts/gardssalg-claim-eligibility-coverage.ts --base=https://opplevagent.no --concurrency=2
 *
 * Output (JSON on stdout, one object):
 *   {
 *     base, cohort_size,
 *     eligible,            // entry page offers the self-service link
 *     manual_fallback,     // entry page shows kontakt@opplevagent.no only
 *     errors,              // non-200 / unreachable
 *     eligible_slugs[], manual_fallback_slugs[], error_slugs[]
 *   }
 *
 * HOW IT MEASURES — deliberately from the OUTSIDE, over HTTP, exactly like a
 * producer would experience it:
 *   1. GET /sitemap.xml and take every /kategori/gardssalg/produsent/<slug>
 *      entry. That is the published cohort (the 87), by the same definition
 *      the dev-request used.
 *   2. GET /kategori/gardssalg/eier/<slug> — the unauthenticated claim entry
 *      page — for each slug.
 *   3. Classify on the page's own visible outcome: does it render the
 *      "Send meg tilgangslenke" button (claimable) or only the manual
 *      fallback contact (not claimable)? Nothing here inspects internals,
 *      reads a DB, or trusts an admin endpoint's own idea of eligibility —
 *      if the page does not offer the link, the producer cannot claim, full
 *      stop.
 *
 * DELIBERATELY READ-ONLY: only GETs, no admin key, no writes, no claim ever
 * issued (the POST that would send a producer an email is never called).
 * Running this against production emails nobody.
 *
 * ONE REAL CAVEAT, stated rather than hidden: step 3 fetches each producer's
 * entry page, and (post-SLICE-5) that page may perform the found-address
 * harvest, i.e. cause opplevagent.no to fetch that producer's own website.
 * The in-process harvest cache (CLAIM_HARVEST_CACHE_TTL_MS, 12 min) means a
 * re-run inside the TTL costs those third-party sites nothing; a first run
 * over a cold cache does one harvest per eligible-shaped producer. Keep
 * --concurrency low (default 2) for that reason.
 */

const BASE = (() => {
  const arg = process.argv.find((a) => a.startsWith("--base="));
  return (arg ? arg.split("=")[1]! : "https://opplevagent.no").replace(/\/$/, "");
})();

const CONCURRENCY = (() => {
  const arg = process.argv.find((a) => a.startsWith("--concurrency="));
  const n = arg ? parseInt(arg.split("=")[1]!, 10) : 2;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 8) : 2;
})();

const FETCH_TIMEOUT_MS = 20_000;

// The exact string the entry page renders on its self-service submit button
// (src/routes/gardssalg-claim.ts). Its ABSENCE is what "manual fallback only"
// means — the same signal routes/gardssalg-claim.test.ts's own a4/a6/w2/w12
// assertions use, so script and test suite agree on what "claimable" means.
const CLAIMABLE_MARKER = "Send meg tilgangslenke";

async function getText(url: string): Promise<{ ok: boolean; status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal, headers: { "user-agent": "lokal-claim-coverage-check/1.0" } });
    const body = await resp.text();
    return { ok: resp.ok, status: resp.status, body };
  } catch {
    return { ok: false, status: 0, body: "" };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const sitemap = await getText(`${BASE}/sitemap.xml`);
  if (!sitemap.ok) {
    console.error(`sitemap.xml unreachable (status ${sitemap.status}) at ${BASE}`);
    process.exit(1);
  }

  const slugs: string[] = [];
  const seen = new Set<string>();
  for (const m of sitemap.body.matchAll(/\/kategori\/gardssalg\/produsent\/([^<\s]+)</g)) {
    const slug = decodeURIComponent(m[1]!);
    if (seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
  }

  const eligible: string[] = [];
  const manualFallback: string[] = [];
  const errored: string[] = [];

  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= slugs.length) return;
      const slug = slugs[i]!;
      const page = await getText(`${BASE}/kategori/gardssalg/eier/${encodeURIComponent(slug)}`);
      if (!page.ok) errored.push(slug);
      else if (page.body.includes(CLAIMABLE_MARKER)) eligible.push(slug);
      else manualFallback.push(slug);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slugs.length || 1) }, () => worker()));

  console.log(
    JSON.stringify(
      {
        base: BASE,
        cohort_size: slugs.length,
        eligible: eligible.length,
        manual_fallback: manualFallback.length,
        errors: errored.length,
        eligible_slugs: eligible.sort(),
        manual_fallback_slugs: manualFallback.sort(),
        error_slugs: errored.sort(),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(String(err?.stack || err));
  process.exit(1);
});
