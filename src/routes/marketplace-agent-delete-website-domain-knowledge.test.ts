/**
 * marketplace-agent-delete-website-domain-knowledge.test.ts — admin DELETE
 * /agents/:id must blocklist website_domain from agent_knowledge.website too
 * (dev-request 2026-10-23-admin-delete-website-domain-ikke-alltid-auto).
 * Previously only agents.url fed the website_domain row.
 *
 * Run standalone: npx tsx src/routes/marketplace-agent-delete-website-domain-knowledge.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

export async function runMarketplaceAgentDeleteWebsiteDomainKnowledgeTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (actual === expected) {
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

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");

  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = ON");

  const ADMIN_KEY = process.env.ADMIN_KEY || "marketplace-delete-website-domain-knowledge-test-key";

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    // Fresh require so no stale closures from an earlier suite's DB linger.
    const marketplaceRoutePath = require.resolve("./marketplace");
    delete require.cache[marketplaceRoutePath];
    const marketplaceRouter = require("./marketplace").default as any;

    const { marketplaceRegistry } = require("../services/marketplace-registry") as
      typeof import("../services/marketplace-registry");
    marketplaceRegistry._agentsCache = null;

    const { normalizeDomain, normalizeEmail, normalizeName } = require("../services/blocklist-service") as
      typeof import("../services/blocklist-service");

    const deleteLayer = (marketplaceRouter.stack as any[]).find(
      (l: any) => l.route && l.route.path === "/agents/:id" && l.route.methods?.delete,
    );
    assertTrue(!!deleteLayer, "setup: DELETE /agents/:id handler is registered on the router");
    const deleteHandler = deleteLayer.route.stack[deleteLayer.route.stack.length - 1].handle;

    function insertAgent(o: {
      id: string;
      name: string;
      email: string;
      url: string;
      isActive?: boolean;
      knowledgeWebsite?: string;
    }): void {
      testDb.prepare(
        `INSERT INTO agents
           (id, name, description, provider, contact_email, url, role, api_key, city, trust_score, is_active, is_verified)
         VALUES (?, ?, 'desc', 'test', ?, ?, 'producer', ?, 'Bergen', 0.5, ?, 0)`,
      ).run(o.id, o.name, o.email, o.url, `k-${o.id}`, o.isActive === false ? 0 : 1);
      if (o.knowledgeWebsite !== undefined) {
        testDb.prepare("INSERT INTO agent_knowledge (agent_id, website) VALUES (?, ?)").run(o.id, o.knowledgeWebsite);
      }
    }
    function websiteRowCount(id: string): number {
      return (testDb.prepare(
        "SELECT COUNT(*) AS n FROM agent_blocklist WHERE identifier_type = 'website_domain' AND original_agent_id = ?",
      ).get(id) as any).n;
    }

    function readAgent(id: string): { id: string } | undefined {
      return testDb.prepare("SELECT id FROM agents WHERE id = ?").get(id) as any;
    }

    function blocklistRowsFor(type: string, value: string): any[] {
      return testDb.prepare(
        "SELECT * FROM agent_blocklist WHERE identifier_type = ? AND identifier_value = ?",
      ).all(type, value) as any[];
    }

    async function callDelete(id: string, query: Record<string, string> = {}): Promise<{ status: number; body: any }> {
      // Same-synchronous-turn env-var + handler-invocation pattern as the
      // #813 sibling — avoids interleaving with any peer test block sharing
      // process.env.ADMIN_KEY.
      process.env.ADMIN_KEY = ADMIN_KEY;
      const res = fakeRes();
      await deleteHandler(
        { headers: { "x-admin-key": ADMIN_KEY }, params: { id }, query, body: {}, ip: "127.0.0.1" } as any,
        res as any,
      );
      return { status: res.statusCode, body: res.body };
    }

    async function run(o: { id: string; url: string; kw?: string; query?: Record<string, string> }) {
      insertAgent({ id: o.id, name: `Produsent ${o.id}`, email: `post@${o.id}-mail.no`, url: o.url, knowledgeWebsite: o.kw });
      marketplaceRegistry._agentsCache = null;
      const r = await callDelete(o.id, o.query);
      assertEq(r.status, 200, `${o.id}: DELETE succeeds (200)`);
      assertEq(readAgent(o.id), undefined, `${o.id}: agent row is gone`);
      return r;
    }

    // AC1a: agents.url empty, knowledge.website set -> blocklisted.
    {
      const r = await run({ id: "kw-only", url: "", kw: "https://www.kunnskap-only.no/om-oss" });
      assertEq(blocklistRowsFor("website_domain", "kunnskap-only.no").length, 1, "kw-only: website_domain from agent_knowledge.website blocklisted");
      assertEq(websiteRowCount("kw-only"), 1, "kw-only: exactly one website_domain row");
      assertTrue((r.body?.blocklist?.rows || []).some((x: any) => x.identifier_type === "website_domain" && x.identifier_value === "kunnskap-only.no"), "kw-only: response rows carry the website_domain row");
    }
    // agents.url only -> still blocklisted.
    {
      await run({ id: "url-only", url: "https://url-only.no" });
      assertEq(blocklistRowsFor("website_domain", "url-only.no").length, 1, "url-only: website_domain from agents.url still blocklisted");
      assertEq(websiteRowCount("url-only"), 1, "url-only: exactly one website_domain row");
    }
    // Both set, different domains -> both rows; inserted counts both.
    {
      const r = await run({ id: "both-diff", url: "https://registry-dom.no", kw: "https://knowledge-dom.no" });
      assertEq(blocklistRowsFor("website_domain", "registry-dom.no").length, 1, "both-diff: agents.url domain blocklisted");
      assertEq(blocklistRowsFor("website_domain", "knowledge-dom.no").length, 1, "both-diff: knowledge domain blocklisted");
      assertEq(websiteRowCount("both-diff"), 2, "both-diff: two website_domain rows");
      assertEq(blocklistRowsFor("name_normalized", normalizeName("Produsent both-diff")).length, 1, "both-diff: name row not duplicated");
      assertEq(blocklistRowsFor("email", normalizeEmail("post@both-diff-mail.no")).length, 1, "both-diff: email row not duplicated");
      // agent_id + name + email + 2 domains = 5
      assertEq(r.body?.blocklist?.inserted, 5, "both-diff: inserted counts both website rows (agent_id+name+email+2 domains)");
      assertEq((r.body?.blocklist?.rows || []).filter((x: any) => x.identifier_type === "website_domain").length, 2, "both-diff: response carries both website rows");
    }
    // Both set, same domain (different spelling) -> single row.
    {
      await run({ id: "both-same", url: "https://same-dom.no", kw: "http://www.same-dom.no/side" });
      assertEq(blocklistRowsFor("website_domain", "same-dom.no").length, 1, "both-same: single website_domain row");
      assertEq(websiteRowCount("both-same"), 1, "both-same: exactly one website_domain row");
    }
    // Knowledge website is protected/own -> not blocklisted, delete succeeds.
    for (const [id, kw, dom] of [["kw-vipps", "https://vipps.no/xyz", "vipps.no"], ["kw-gmail", "https://gmail.com", "gmail.com"], ["kw-own", "https://rettfrabonden.com", "rettfrabonden.com"]] as const) {
      await run({ id, url: "", kw });
      assertEq(blocklistRowsFor("website_domain", dom).length, 0, `${id}: protected/own domain ${dom} NOT blocklisted`);
      assertEq(websiteRowCount(id), 0, `${id}: no website_domain row written`);
      assertEq(blocklistRowsFor("agent_id", id).length, 1, `${id}: agent_id still blocklisted`);
    }
    // Protected knowledge domain next to a real agents.url -> url row only.
    {
      await run({ id: "url-plus-vipps", url: "https://real-site.no", kw: "https://vipps.no/x" });
      assertEq(websiteRowCount("url-plus-vipps"), 1, "url-plus-vipps: only the agents.url domain written");
      assertEq(blocklistRowsFor("website_domain", "vipps.no").length, 0, "url-plus-vipps: vipps.no not blocklisted");
    }
    // ── AK6 (dev-request 2026-11-22-rfb-dubletter-samme-nettsted-
    //    sammenslaaing-og-utsending, point 6): another ACTIVE profile on the
    //    same website → no website_domain row for that domain. ──
    // Survivor shares the domain via agents.url (different spelling).
    {
      insertAgent({ id: "ak6-surv-url", name: "Felles Gård", email: "post@ak6-surv-url.no", url: "https://delt-dom.no" });
      const r = await run({ id: "ak6-dup-url", url: "https://www.delt-dom.no/om", kw: "http://delt-dom.no" });
      assertEq(blocklistRowsFor("website_domain", "delt-dom.no").length, 0, "ak6-dup-url: domain shared with an active profile NOT blocklisted");
      assertEq(websiteRowCount("ak6-dup-url"), 0, "ak6-dup-url: no website_domain row written");
      assertEq(blocklistRowsFor("agent_id", "ak6-dup-url").length, 1, "ak6-dup-url: agent_id still blocklisted");
      assertEq(blocklistRowsFor("email", normalizeEmail("post@ak6-dup-url-mail.no")).length, 1, "ak6-dup-url: email still blocklisted (not shared)");
      assertTrue(!(r.body?.blocklist?.rows || []).some((x: any) => x.identifier_type === "website_domain"), "ak6-dup-url: response carries no website_domain row");
      assertTrue(!!readAgent("ak6-surv-url"), "ak6-dup-url: survivor untouched");
    }
    // Survivor shares the domain only via agent_knowledge.website.
    {
      insertAgent({ id: "ak6-surv-kw", name: "Kunnskap Gård", email: "post@ak6-surv-kw.no", url: "", knowledgeWebsite: "https://kdelt-dom.no/" });
      await run({ id: "ak6-dup-kw", url: "https://kdelt-dom.no" });
      assertEq(blocklistRowsFor("website_domain", "kdelt-dom.no").length, 0, "ak6-dup-kw: domain shared via survivor's agent_knowledge.website NOT blocklisted");
    }
    // Two sources, only one shared → only the unshared domain is blocklisted.
    {
      insertAgent({ id: "ak6-surv-mix", name: "Blandet Gård", email: "post@ak6-surv-mix.no", url: "https://mix-delt.no" });
      await run({ id: "ak6-dup-mix", url: "https://mix-delt.no", kw: "https://mix-egen.no" });
      assertEq(blocklistRowsFor("website_domain", "mix-delt.no").length, 0, "ak6-dup-mix: shared agents.url domain NOT blocklisted");
      assertEq(blocklistRowsFor("website_domain", "mix-egen.no").length, 1, "ak6-dup-mix: own knowledge domain still blocklisted");
      assertEq(websiteRowCount("ak6-dup-mix"), 1, "ak6-dup-mix: exactly one website_domain row");
    }
    // Another profile on the domain that is INACTIVE (e.g. already merged) does
    // not count → the domain is blocklisted as before.
    {
      insertAgent({ id: "ak6-inactive", name: "Gammel Gård", email: "post@ak6-inactive.no", url: "https://inaktiv-dom.no", isActive: false });
      await run({ id: "ak6-dup-inactive", url: "https://inaktiv-dom.no" });
      assertEq(blocklistRowsFor("website_domain", "inaktiv-dom.no").length, 1, "ak6-dup-inactive: inactive sharer does not protect the domain");
    }
    // Sole profile on its domain → unchanged behaviour.
    {
      await run({ id: "ak6-sole", url: "https://eneste-dom.no" });
      assertEq(blocklistRowsFor("website_domain", "eneste-dom.no").length, 1, "ak6-sole: sole profile's domain still blocklisted");
      assertEq(websiteRowCount("ak6-sole"), 1, "ak6-sole: exactly one website_domain row");
    }
    // skipBlocklist=1 -> nothing written.
    {
      const r = await run({ id: "kw-skip", url: "", kw: "https://skip-dom.no", query: { skipBlocklist: "1" } });
      assertEq(blocklistRowsFor("website_domain", "skip-dom.no").length, 0, "kw-skip: skipBlocklist=1 writes no website_domain row");
      assertEq(blocklistRowsFor("agent_id", "kw-skip").length, 0, "kw-skip: skipBlocklist=1 writes no agent_id row");
      assertEq(r.body?.blocklist ?? null, null, "kw-skip: response blocklist is null");
    }
  } catch (err) {
    failed++;
    failures.push(`marketplace-agent-delete-website-domain-knowledge: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("./marketplace")]; } catch { /* ignore */ }
    testDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/marketplace-agent-delete-website-domain-knowledge.test.ts`
if (require.main === module) {
  console.log("── marketplace-agent-delete-website-domain-knowledge (DELETE /api/marketplace/agents/:id website-domain-from-knowledge) unit tests ──");
  runMarketplaceAgentDeleteWebsiteDomainKnowledgeTests({ log: true }).then((r) => {
    console.log(`\nmarketplace-agent-delete-website-domain-knowledge: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
