/**
 * init-outreach-pool-own-domain-exclusion.test.ts — dev-request 2026-09-22-
 * telefon-css-js-identifikator-falske-positiver, point 4:
 * POOL_OWN_PLATFORM_DOMAIN_EXCLUSION_SQL / isOwnPlatformHomepage
 * (src/database/init.ts). An agent whose "homepage" (COALESCE(k.website,
 * a.url), the same `homepage_url` concept every other call site in this
 * codebase already computes) is actually rettfrabonden.com — the platform's
 * OWN domain — is a data bug, never a real producer's own site, and must
 * never appear in `outreach_ready_pool` (would mail the producer a link to
 * our own homepage as if it were theirs).
 *
 * Mirrors admin-outreach-pool-rich-vs-partial.test.ts's own in-memory-DB +
 * fixture convention exactly (same insertAgent/insertKnowledge shape),
 * since this is the same VIEW.
 *
 * Exported runInitOutreachPoolOwnDomainExclusionTests({log}) -> TestSummary;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/database/init-outreach-pool-own-domain-exclusion.test.ts
 */

import Database from "better-sqlite3";
import { getDb, __setDbForTesting, __initSchemaForTesting, isOwnPlatformHomepage } from "./init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runInitOutreachPoolOwnDomainExclusionTests(
  opts: { log?: boolean } = {},
): TestSummary {
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

  // ═══════════════════════════════════════════════════════════════════
  // isOwnPlatformHomepage — pure JS mirror.
  // ═══════════════════════════════════════════════════════════════════
  assertEq(isOwnPlatformHomepage({ website: "https://rettfrabonden.com", url: null }), true, "own-01: bare rettfrabonden.com website -> true");
  assertEq(isOwnPlatformHomepage({ website: null, url: "https://rettfrabonden.com/agent/x" }), true, "own-02: falls back to agents.url when website is blank -> true");
  assertEq(isOwnPlatformHomepage({ website: "https://admin.rettfrabonden.com/x", url: null }), true, "own-03: subdomain of the platform domain -> true");
  assertEq(isOwnPlatformHomepage({ website: "https://ekte-gard.no", url: "https://rettfrabonden.com" }), false, "own-04: a real website takes priority over agents.url (website non-blank) -> false");
  assertEq(isOwnPlatformHomepage({ website: "", url: "https://ekte-gard.no" }), false, "own-05: a genuine third-party domain -> false");
  assertEq(isOwnPlatformHomepage({ website: null, url: null }), false, "own-06: neither field set -> false (no false positive on absence)");

  // ═══════════════════════════════════════════════════════════════════
  // outreach_ready_pool VIEW — end-to-end exclusion.
  // ═══════════════════════════════════════════════════════════════════
  const prevDb = getDb();
  const db = new Database(":memory:");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);

  function insertAgent(id: string, name: string, email: string, url: string): void {
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
      VALUES (?, ?, 'test producer', 'test', ?, ?, 'producer', ?)
    `).run(id, name, email, url, `key-${id}`);
  }

  function insertKnowledge(
    id: string,
    email: string,
    website: string | null,
  ): void {
    db.prepare(`
      INSERT INTO agent_knowledge
        (agent_id, email, website, field_provenance, verification_status, enrichment_status,
         url_last_status, url_last_probed, about, products)
      VALUES (?, ?, ?, '{}', 'verified', 'rich', 200, datetime('now'), ?, ?)
    `).run(id, email, website, "x".repeat(200), JSON.stringify([{ name: "a" }, { name: "b" }, { name: "c" }]));
  }

  try {
    // ── own-07: agent_knowledge.website is our own platform domain, and is
    //    otherwise FULLY pool-eligible (verified, rich, fresh 2xx probe,
    //    valid email, non-umbrella) — must NOT appear. ────────────────────
    insertAgent("pod-own-website", "Feilkonfigurert Gård", "own-website@pod-test.no", "https://real-fallback.no");
    insertKnowledge("pod-own-website", "own-website@pod-test.no", "https://rettfrabonden.com");

    // ── own-08: agent_knowledge.website is BLANK and agents.url is our own
    //    platform domain (the COALESCE fallback case) — must NOT appear
    //    either. ────────────────────────────────────────────────────────
    insertAgent("pod-own-url-fallback", "Solvang-Style Gård", "own-url@pod-test.no", "https://rettfrabonden.com");
    insertKnowledge("pod-own-url-fallback", "own-url@pod-test.no", null);

    // ── own-09: subdomain shape — admin.rettfrabonden.com — also excluded. ─
    insertAgent("pod-own-subdomain", "Subdomene Gård", "own-subdomain@pod-test.no", "https://real-fallback-2.no");
    insertKnowledge("pod-own-subdomain", "own-subdomain@pod-test.no", "https://admin.rettfrabonden.com/agent/x");

    // Control: an otherwise-identical, genuinely third-party domain — must
    // still appear (no over-broad exclusion / no regression).
    insertAgent("pod-real-control", "Ekte Kontroll Gård", "real-control@pod-test.no", "https://ekte-gard-kontroll.no");
    insertKnowledge("pod-real-control", "real-control@pod-test.no", "https://ekte-gard-kontroll.no");

    const viewRows = db
      .prepare(`SELECT agent_id FROM outreach_ready_pool ORDER BY agent_id`)
      .all() as Array<{ agent_id: string }>;
    const viewIds = viewRows.map((r) => r.agent_id);

    assertTrue(
      !viewIds.includes("pod-own-website"),
      "own-07: an otherwise fully-eligible agent whose agent_knowledge.website is rettfrabonden.com does NOT appear in outreach_ready_pool",
    );
    assertTrue(
      !viewIds.includes("pod-own-url-fallback"),
      "own-08: an otherwise fully-eligible agent whose agents.url (COALESCE fallback, website blank) is rettfrabonden.com does NOT appear",
    );
    assertTrue(
      !viewIds.includes("pod-own-subdomain"),
      "own-09: a rettfrabonden.com SUBDOMAIN homepage also does NOT appear",
    );
    assertTrue(
      viewIds.includes("pod-real-control"),
      "own-10 (no regression): an otherwise-identical agent with a genuine third-party homepage still appears",
    );
  } catch (err) {
    failed++;
    failures.push(`init-outreach-pool-own-domain-exclusion: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    __setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runInitOutreachPoolOwnDomainExclusionTests({ log: true });
  console.log(`\n${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}
