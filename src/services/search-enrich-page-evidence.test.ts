/**
 * search-enrich-page-evidence.test.ts — dev-request
 * 2026-06-30-open-stuck-verification-bucket, Step 2: buildPageEvidence's
 * same-host sub-page crawl now includes /produkter (alongside the existing
 * /kontakt, /om-oss), mirroring the identical, already-shipped
 * HCR_CONTENT_PATHS pattern in routes/admin-knowledge.ts. Stubs
 * globalThis.fetch (repo convention — see
 * admin-agents-brreg-description-fallback.test.ts) to verify all three
 * same-host paths are requested and their content merged, with no regression
 * to the pre-existing /kontakt + /om-oss behavior.
 */
import { buildPageEvidence } from "./search-enrich";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runPageEvidenceCrawlTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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

  const prevFetch = globalThis.fetch;
  try {
    const requestedPaths: string[] = [];
    const bodies: Record<string, string> = {
      "/": "<html><body>Forside for Gaarden AS. kontakt@gaarden.example</body></html>",
      "/kontakt": "<html><body>Ring 12345678 eller post@gaarden.example</body></html>",
      "/om-oss": "<html><body>Vi driver økologisk gårdsbutikk siden 1990.</body></html>",
      "/produkter": "<html><body>Grønnsaker, egg og honning selges hver lørdag.</body></html>",
    };
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      requestedPaths.push(urlStr);
      const path = new URL(urlStr).pathname;
      const body = bodies[path];
      if (body === undefined) {
        return { ok: false, status: 404, text: async () => "" } as unknown as Response;
      }
      return { ok: true, status: 200, text: async () => body } as unknown as Response;
    }) as typeof fetch;

    const evidence = await buildPageEvidence("https://gaarden.example/");

    assertTrue(evidence !== null, "pageEvidence: buildPageEvidence returns non-null for a reachable primary page");
    assertTrue(
      requestedPaths.some((u) => u.endsWith("/produkter")),
      "pageEvidence: /produkter is requested alongside /kontakt and /om-oss (Step 2 deeper-crawl lever)"
    );
    assertTrue(
      requestedPaths.some((u) => u.endsWith("/kontakt")) && requestedPaths.some((u) => u.endsWith("/om-oss")),
      "pageEvidence: pre-existing /kontakt and /om-oss crawl is unchanged (no regression)"
    );
    assertTrue(
      (evidence?.contentText ?? "").includes("Grønnsaker") || (evidence?.html ?? "").includes("Grønnsaker"),
      "pageEvidence: /produkter page content is merged into combinedHtml/contentText"
    );
    assertTrue(
      (evidence?.phones ?? []).includes("12345678"),
      "pageEvidence: /kontakt-sourced phone is still extracted (no regression from adding /produkter)"
    );
    assertTrue(
      (evidence?.emails ?? []).includes("post@gaarden.example"),
      "pageEvidence: /kontakt-sourced email is still extracted (no regression from adding /produkter)"
    );

    // A primary page with no reachable sub-pages at all must still return
    // evidence from the primary page alone (best-effort, never throws).
    const requestedPaths2: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      requestedPaths2.push(urlStr);
      const path = new URL(urlStr).pathname;
      if (path === "/") {
        return { ok: true, status: 200, text: async () => "<html><body>Bare forsiden.</body></html>" } as unknown as Response;
      }
      return { ok: false, status: 404, text: async () => "" } as unknown as Response;
    }) as typeof fetch;
    const evidenceNoSubpages = await buildPageEvidence("https://ensom-gard.example/");
    assertTrue(
      evidenceNoSubpages !== null && evidenceNoSubpages.html.includes("Bare forsiden"),
      "pageEvidence: still returns primary-page evidence when all three sub-pages 404 (best-effort, no throw)"
    );
  } finally {
    globalThis.fetch = prevFetch;
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runPageEvidenceCrawlTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) process.exit(1);
  });
}
