/**
 * agent-card-role-gate.test.ts — dev-request
 * 2026-10-06-rfb-sitemap-rollesperre-bm-event-og-paraply-canonical (Skive A2).
 *
 * GET /produsent/:slug 404s for non-producer, non-umbrella roles (quality /
 * logistics: HANEN, Debio, Dyrket.no …). GET /api/marketplace/agents/:id/card
 * used to hand out canonicalUrl + links.profile pointing at exactly that 404.
 * Asserts, through the REAL handlers pulled off the router stacks (same
 * harness convention as produsent-role-gate.test.ts):
 *   - quality / logistics agent: card has NO canonicalUrl and NO links.profile
 *     (other links stay), and /produsent/<slug> really is 404 (the premise);
 *   - ordinary producer: card keeps both, /produsent/<slug> is 200;
 *   - umbrella (role may be anything): card keeps both;
 *   - /llms-full.txt carries no «Profil:» link for the quality agent but does
 *     for the producer;
 *   - the shared predicate hasProducerPage() itself.
 *
 * Exported runAgentCardRoleGateTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/agent-card-role-gate.test.ts
 */

import Database from "better-sqlite3";
import { slugify } from "../utils/slug";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runAgentCardRoleGateTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");
  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  function seedAgent(row: { id: string; name: string; role: string; umbrella_type?: string | null }): void {
    testDb.prepare(
      `INSERT INTO agents (
        id, name, description, provider, contact_email, url, role, api_key,
        categories, tags, skills, capabilities, languages,
        trust_score, is_active, is_verified, discovery_count, interaction_count,
        total_interactions, created_at, last_seen_at, umbrella_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?,
        '[]', '[]', '[]', '{}', '["no"]',
        0.5, 1, 0, 0, 0, 0, datetime('now'), datetime('now'), ?)`,
    ).run(
      row.id, row.name, "En beskrivelse", row.name, `${row.id}@example.no`, `https://${row.id}.example.no`,
      row.role, `key-${row.id}`, row.umbrella_type ?? null,
    );
  }

  function findHandler(router: any, path: string): Function {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.get);
    if (!layer) throw new Error(`route not found: GET ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }

  function invoke(handler: Function, params: Record<string, string>): { status: number; body: any } {
    let status = 200;
    let body: any;
    const res: any = {
      status(c: number) { status = c; return res; },
      json(p: any) { body = p; return res; },
      send(p: any) { body = p; return res; },
      redirect(c: number, l: string) { status = c; body = { __redirect: l }; return res; },
      header() { return res; }, set() { return res; }, type() { return res; }, setHeader() { return res; },
    };
    const req: any = {
      params, query: {}, body: {}, headers: {}, ip: "127.0.0.1", lang: "no", protocol: "https",
      get(n: string) { return n.toLowerCase() === "host" ? "rettfrabonden.com" : undefined; },
    };
    handler(req, res, () => { /* next */ });
    return { status, body };
  }

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    seedAgent({ id: "acr-prod", name: "Kortsjekk Produsent", role: "producer" });
    seedAgent({ id: "acr-quality", name: "Kortsjekk Kvalitet", role: "quality" });
    seedAgent({ id: "acr-logistics", name: "Kortsjekk Logistikk", role: "logistics" });
    seedAgent({ id: "acr-umb", name: "Kortsjekk Paraply", role: "quality", umbrella_type: "industry_org" });

    const { loadConfigsAtBoot } = require("../config/vertical-config") as
      typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded */ }

    for (const m of ["./marketplace", "./seo", "./discovery"]) delete require.cache[require.resolve(m)];
    const marketplaceRouter = require("./marketplace").default as any;
    const seoRouter = require("./seo").default as any;
    const discoveryRouter = require("./discovery").default as any;
    const { marketplaceRegistry } = require("../services/marketplace-registry") as
      typeof import("../services/marketplace-registry");
    marketplaceRegistry._agentsCache = null;

    const cardHandler = findHandler(marketplaceRouter, "/agents/:id/card");
    const produsentHandler = findHandler(seoRouter, "/produsent/:slug");
    const llmsFullHandler = findHandler(discoveryRouter, "/llms-full.txt");

    // Premise: the page really is 404 for the gated roles, 200 otherwise.
    assertTrue(invoke(produsentHandler, { slug: slugify("Kortsjekk Kvalitet") }).status === 404, "premise: /produsent/<quality> is 404");
    assertTrue(invoke(produsentHandler, { slug: slugify("Kortsjekk Logistikk") }).status === 404, "premise: /produsent/<logistics> is 404");
    assertTrue(invoke(produsentHandler, { slug: slugify("Kortsjekk Produsent") }).status === 200, "premise: /produsent/<producer> is 200");

    for (const id of ["acr-quality", "acr-logistics"]) {
      const r = invoke(cardHandler, { id });
      assertTrue(r.status === 200 && !!r.body, `${id}: card is served`);
      assertTrue(r.body?.canonicalUrl === undefined, `${id}: card has NO canonicalUrl (would point at a 404)`);
      assertTrue(r.body?.links?.profile === undefined, `${id}: card has NO links.profile (would point at a 404)`);
      assertTrue(!!r.body?.links?.vcard, `${id}: other links (vcard) are kept`);
    }

    const prod = invoke(cardHandler, { id: "acr-prod" });
    assertTrue(prod.body?.canonicalUrl === `https://rettfrabonden.com/produsent/${slugify("Kortsjekk Produsent")}`, "producer: canonicalUrl kept");
    assertTrue(prod.body?.links?.profile === `https://rettfrabonden.com/produsent/${slugify("Kortsjekk Produsent")}`, "producer: links.profile kept");

    const umb = invoke(cardHandler, { id: "acr-umb" });
    assertTrue(umb.body?.canonicalUrl === `https://rettfrabonden.com/produsent/${slugify("Kortsjekk Paraply")}`, "umbrella: canonicalUrl kept");
    assertTrue(umb.body?.links?.profile === `https://rettfrabonden.com/produsent/${slugify("Kortsjekk Paraply")}`, "umbrella: links.profile kept");

    // llms-full: producer is linked, quality/logistics are not.
    const llms = String(invoke(llmsFullHandler, {}).body || "");
    assertTrue(llms.includes(`/produsent/${slugify("Kortsjekk Produsent")}`), "llms-full: producer keeps Profil link");
    assertTrue(!llms.includes(`/produsent/${slugify("Kortsjekk Kvalitet")}`), "llms-full: quality agent has no /produsent link");
    assertTrue(!llms.includes(`/produsent/${slugify("Kortsjekk Logistikk")}`), "llms-full: logistics agent has no /produsent link");

    // Shared predicate.
    const { hasProducerPage } = require("../services/agent-visibility") as typeof import("../services/agent-visibility");
    assertTrue(hasProducerPage({ role: "producer" }), "hasProducerPage: producer");
    assertTrue(!hasProducerPage({ role: "quality" }), "hasProducerPage: quality -> false");
    assertTrue(!hasProducerPage({ role: "logistics" }), "hasProducerPage: logistics -> false");
    assertTrue(hasProducerPage({ role: "quality", umbrella_type: "industry_org" }), "hasProducerPage: umbrella always true");
    assertTrue(!hasProducerPage({ role: "producer", is_vetted: 0 }), "hasProducerPage: unvetted -> false");
    assertTrue(!hasProducerPage({ role: "producer", catalog_hidden: 1 }), "hasProducerPage: hidden -> false");
    assertTrue(!hasProducerPage({ role: "producer", vertical_id: "dental" }), "hasProducerPage: non-rfb vertical -> false");
    assertTrue(!hasProducerPage(null), "hasProducerPage: null -> false");
  } finally {
    if (prevDb) __setDbForTesting(prevDb);
    for (const m of ["./marketplace", "./seo", "./discovery"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* ignore */ }
    }
    testDb.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runAgentCardRoleGateTests({ log: true }).then((r) => {
    console.log(`\nagent-card-role-gate: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) { console.log(r.failures.join("\n")); process.exit(1); }
    process.exit(0);
  });
}
