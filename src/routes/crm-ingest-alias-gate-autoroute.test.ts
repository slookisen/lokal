/**
 * crm-ingest-alias-gate-autoroute.test.ts — regression tests for dev-request
 * 2026-09-16-crm-ingest-alias-gate-autoroute (slookisen/A2A), FUNN
 * crm-ingest-alias-gate-blokkerer-ekte-eierrettelser.
 *
 * Root cause (src/routes/crm.ts, POST /admin/crm/ingest): deriveVertical()
 * correctly refuses to guess when the recipient headers name no platform
 * alias (code `no_platform_address`) — that refusal is right for a genuinely
 * unknown sender. But it ALSO parked a very common, NOT ambiguous case: a
 * real producer/agent (already on file as agents.contact_email,
 * agent_knowledge.email, or an experiences experience_providers.epost/
 * hjemmeside domain) replying from their own known address, just not TO a
 * platform alias (forwarded, replied-to-cc, landed in Daniel's personal
 * inbox). That sat in crm_untriaged for days waiting on Daniel's manual
 * POST /admin/crm/untriaged/:id/assign — the CS routine cannot unblock it on
 * its own initiative.
 *
 * Fix: when deriveVertical() refuses with EXACTLY `no_platform_address`
 * (never no_signals, never ambiguous_platform_addresses, never the separate
 * asserted-vertical-mismatch refusal), /ingest now tries
 * crmService.classifyEmail(primaryFromEmail, "rfb") and
 * classifyEmail(primaryFromEmail, "experiences"). If EXACTLY ONE comes back
 * `type: "producer"`, that vertical is used and the thread is ingested
 * exactly as if the caller had asserted it — same downstream logic, same 409
 * conflict handling. If both or neither match, it still parks, unchanged.
 *
 * Covers (numbered to match the dev-request's acceptance criteria):
 *   1. Exact match on agents.contact_email -> ingested (not parked), rfb.
 *   2. Exact match on agent_knowledge.email -> ingested, rfb.
 *   3. Domain match (non-freemail) on agents.contact_email -> ingested, rfb.
 *   4. Freemail-domain sender, no exact match anywhere -> still parked (no
 *      weaker freemail domain-only match introduced).
 *   5. Sender matches BOTH an rfb agent and an experiences provider -> still
 *      parked (ambiguous contact match — same discipline as ambiguous
 *      headers; never a coin flip).
 *   6. Genuinely unknown sender -> still parked, response shape unchanged.
 *   7. no_signals and ambiguous_platform_addresses are completely unaffected
 *      by the new fallback — pinned against a sender that WOULD auto-route
 *      under 1-3, to prove the fallback never fires for those two codes.
 *
 * Harness conventions, matching this repo's established patterns (see
 * crm-compose-cooldown-untriaged-inbound-exempt.test.ts for the router-
 * dispatch shape and crm-contact-provider-link.test.ts for the
 * EXPERIENCES_DB_PATH=":memory:" + db-factory reset needed for provider
 * matching):
 *   - Main DB: fresh in-memory db via database/init's
 *     __setDbForTesting/__initSchemaForTesting.
 *   - Experiences DB: EXPERIENCES_DB_PATH redirected to :memory: BEFORE
 *     anything touches db-factory, then db-factory reset so crm-service
 *     picks up the fresh handle.
 *   - Router dispatch: router.handle(req, res, next) directly, no HTTP
 *     server.
 *
 * Two ways to run:
 *   1. Standalone: npx tsx src/routes/crm-ingest-alias-gate-autoroute.test.ts
 *   2. Wired into the gate via tests/test.ts.
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: { method?: string; url: string; headers?: Record<string, string>; body?: any },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      path: opts.url,
      query: {},
      headers,
      body: opts.body,
      ip: "127.0.0.1",
      get(name: string) {
        return headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runCrmIngestAliasGateAutorouteTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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
    assertEq(cond, true, label);
  }

  return (async () => {
    const prevDb = initMod.__peekDbForTesting();
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevExpPath = process.env.EXPERIENCES_DB_PATH;
    const ADMIN_KEY = process.env.ADMIN_KEY || "test-admin-key-crm-ingest-autoroute";

    // Must be set BEFORE anything touches db-factory — its default path is
    // the production experiences.db volume (same defect class an earlier
    // reviewer caught elsewhere).
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const crmServicePath = require.resolve("../services/crm-service");
    const crmRoutePath = require.resolve("./crm");
    const cachePaths = [dbFactoryPath, crmServicePath, crmRoutePath];
    for (const p of cachePaths) delete require.cache[p];

    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();

    const db = new Database(":memory:");

    try {
      process.env.ADMIN_KEY = ADMIN_KEY;
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const xdb = dbFactory.getDb("experiences");

      // ── Fixtures ─────────────────────────────────────────────────
      // Three rfb agents, one via each matching tier, plus one for the
      // both-match ambiguity case; one experiences provider for the
      // both-match case and the freemail regression.
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
         VALUES ('ag-exact','Fjellgard Ysteri','x','test','post@fjellgard-test.no','https://fjellgard-test.no','producer','ag-key-1',1)`,
      ).run();
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
         VALUES ('ag-knowledge','Sylte og Rokt','x','test','post@sylteogrokt.no','https://sylteogrokt.no','producer','ag-key-2',1)`,
      ).run();
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, email) VALUES ('ag-knowledge', 'personlig@gmail-eier-test.com')`,
      ).run();
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
         VALUES ('ag-domain','Bakkegard Bryggeri','x','test','post@bakkegard-test.no','https://bakkegard-test.no','producer','ag-key-3',1)`,
      ).run();
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
         VALUES ('ag-both','Kryssvertikal Gard','x','test','begge@kryssvertikal-test.no','https://kryssvertikal-test.no','producer','ag-key-4',1)`,
      ).run();

      xdb.prepare(
        `INSERT INTO experience_providers (id, navn, epost, hjemmeside, brreg_active) VALUES (?, ?, ?, ?, ?)`,
      ).run("prov-both", "Kryssvertikal Opplevelse", "begge@kryssvertikal-test.no", "https://kryssvertikal-test.no", 1);

      const crmRouter = (require("./crm") as typeof import("./crm")).default as any;

      function baseIngestBody(overrides: Record<string, any> = {}): Record<string, any> {
        return {
          threadId: `gmail-thread-${Math.random().toString(36).slice(2)}`,
          primaryFromEmail: "someone@example.no",
          subject: "Angående min side",
          messages: [
            {
              messageId: `msg-${Math.random().toString(36).slice(2)}`,
              direction: "in",
              fromEmail: "someone@example.no",
              snippet: "Hei, jeg vil rette noe på min side.",
            },
          ],
          routingSignals: {
            // No platform alias anywhere -> deriveVertical refuses with
            // no_platform_address, the exact refusal this fix targets.
            deliveredTo: "daniel-personlig@gmail.com",
          },
          ...overrides,
        };
      }

      async function countUntriaged(): Promise<number> {
        const row = db.prepare("SELECT COUNT(*) AS n FROM crm_untriaged").get() as { n: number };
        return row.n;
      }

      // ══ 1. Exact match on agents.contact_email -> auto-routed, ingested ═
      {
        const email = "post@fjellgard-test.no";
        const threadId = `t-exact-${Math.random().toString(36).slice(2)}`;
        const res = await callRoute(crmRouter, {
          method: "POST",
          url: "/ingest",
          headers: { "x-admin-key": ADMIN_KEY },
          body: baseIngestBody({
            threadId,
            primaryFromEmail: email,
            messages: [
              { messageId: `msg-${threadId}`, direction: "in", fromEmail: email, snippet: "hei" },
            ],
          }),
        });
        assertEq(res.status, 200, "1a: exact agents.contact_email match -> 200 (not 202 parked)");
        assertEq(res.body?.untriaged, undefined, "1b: response has no untriaged field — this is a real ingest");
        assertTrue(typeof res.body?.threadId === "string", "1c: response carries a threadId");
        const thread = db.prepare("SELECT vertical_id FROM crm_threads WHERE id = ?").get(threadId) as any;
        assertEq(thread?.vertical_id, "rfb", "1d: thread landed in vertical rfb, matching the agent");
        const action = db
          .prepare("SELECT type FROM crm_actions WHERE type = 'crm_ingest_auto_routed_by_contact_match' ORDER BY created_at DESC LIMIT 1")
          .get() as any;
        assertTrue(!!action, "1e: a distinct crm_ingest_auto_routed_by_contact_match action was logged");
      }

      // ══ 2. Exact match on agent_knowledge.email -> auto-routed ══════════
      {
        const email = "personlig@gmail-eier-test.com";
        const threadId = `t-knowledge-${Math.random().toString(36).slice(2)}`;
        const res = await callRoute(crmRouter, {
          method: "POST",
          url: "/ingest",
          headers: { "x-admin-key": ADMIN_KEY },
          body: baseIngestBody({
            threadId,
            primaryFromEmail: email,
            messages: [
              { messageId: `msg-${threadId}`, direction: "in", fromEmail: email, snippet: "hei" },
            ],
          }),
        });
        assertEq(res.status, 200, "2a: exact agent_knowledge.email match -> 200 (not parked)");
        const thread = db.prepare("SELECT vertical_id FROM crm_threads WHERE id = ?").get(threadId) as any;
        assertEq(thread?.vertical_id, "rfb", "2b: thread landed in vertical rfb");
        const contact = db
          .prepare("SELECT agent_id FROM crm_contacts WHERE email = ? AND vertical_id = 'rfb'")
          .get(email) as any;
        assertEq(contact?.agent_id, "ag-knowledge", "2c: contact linked to the agent via its agent_knowledge.email row");
      }

      // ══ 3. Domain match (non-freemail) -> auto-routed ═══════════════════
      {
        const email = "annen-ansatt@bakkegard-test.no"; // not the exact contact_email, same domain
        const threadId = `t-domain-${Math.random().toString(36).slice(2)}`;
        const res = await callRoute(crmRouter, {
          method: "POST",
          url: "/ingest",
          headers: { "x-admin-key": ADMIN_KEY },
          body: baseIngestBody({
            threadId,
            primaryFromEmail: email,
            messages: [
              { messageId: `msg-${threadId}`, direction: "in", fromEmail: email, snippet: "hei" },
            ],
          }),
        });
        assertEq(res.status, 200, "3a: non-freemail domain match -> 200 (not parked)");
        const thread = db.prepare("SELECT vertical_id FROM crm_threads WHERE id = ?").get(threadId) as any;
        assertEq(thread?.vertical_id, "rfb", "3b: thread landed in vertical rfb via domain match");
      }

      // ══ 4. Freemail sender, no exact match -> still parked (regression:
      // no weaker freemail domain-only match introduced) ═══════════════════
      {
        const email = "tilfeldig-person@gmail.com";
        const before = await countUntriaged();
        const threadId = `t-freemail-${Math.random().toString(36).slice(2)}`;
        const res = await callRoute(crmRouter, {
          method: "POST",
          url: "/ingest",
          headers: { "x-admin-key": ADMIN_KEY },
          body: baseIngestBody({
            threadId,
            primaryFromEmail: email,
            messages: [
              { messageId: `msg-${threadId}`, direction: "in", fromEmail: email, snippet: "hei" },
            ],
          }),
        });
        assertEq(res.status, 202, "4a: freemail sender with no exact match -> still 202 parked");
        assertEq(res.body?.untriaged, true, "4b: untriaged:true");
        const after = await countUntriaged();
        assertEq(after, before + 1, "4c: exactly one new crm_untriaged row, no crm_threads row created");
        const thread = db.prepare("SELECT id FROM crm_threads WHERE id = ?").get(threadId) as any;
        assertEq(thread, undefined, "4d: no thread row was created for the parked sender");
      }

      // ══ 5. Sender matches BOTH an rfb agent and an experiences provider
      // -> still parked (ambiguous contact match, same discipline as
      // ambiguous headers — never a coin flip) ═════════════════════════════
      {
        const email = "begge@kryssvertikal-test.no";
        const before = await countUntriaged();
        const threadId = `t-both-${Math.random().toString(36).slice(2)}`;
        const res = await callRoute(crmRouter, {
          method: "POST",
          url: "/ingest",
          headers: { "x-admin-key": ADMIN_KEY },
          body: baseIngestBody({
            threadId,
            primaryFromEmail: email,
            messages: [
              { messageId: `msg-${threadId}`, direction: "in", fromEmail: email, snippet: "hei" },
            ],
          }),
        });
        assertEq(res.status, 202, "5a: sender matching both verticals' producers -> still 202 parked");
        assertEq(res.body?.untriaged, true, "5b: untriaged:true");
        const after = await countUntriaged();
        assertEq(after, before + 1, "5c: exactly one new crm_untriaged row");
        const thread = db.prepare("SELECT id FROM crm_threads WHERE id = ?").get(threadId) as any;
        assertEq(thread, undefined, "5d: no thread row was created — no coin flip between rfb and experiences");
      }

      // ══ 6. Genuinely unknown sender -> still parked, response shape
      // unchanged from before this fix (regression check) ═════════════════
      {
        const email = "helt-ukjent@ingensteds-test.no";
        const before = await countUntriaged();
        const threadId = `t-unknown-${Math.random().toString(36).slice(2)}`;
        const res = await callRoute(crmRouter, {
          method: "POST",
          url: "/ingest",
          headers: { "x-admin-key": ADMIN_KEY },
          body: baseIngestBody({
            threadId,
            primaryFromEmail: email,
            messages: [
              { messageId: `msg-${threadId}`, direction: "in", fromEmail: email, snippet: "hei" },
            ],
          }),
        });
        assertEq(res.status, 202, "6a: genuinely unknown sender -> 202 parked");
        assertEq(res.body?.untriaged, true, "6b: untriaged:true");
        assertTrue(typeof res.body?.untriagedId === "string", "6c: untriagedId present");
        assertEq(res.body?.reason, "none of the recipient addresses is a known platform alias (kontakt@rettfrabonden.com, kontakt@opplevagent.no) — the mail reached the mailbox some other way", "6d: reason is deriveVertical's verbatim no_platform_address message, unchanged");
        assertTrue(typeof res.body?.openUntriaged === "number", "6e: openUntriaged count present");
        const after = await countUntriaged();
        assertEq(after, before + 1, "6f: exactly one new crm_untriaged row");
      }

      // ══ 7. no_signals and ambiguous_platform_addresses are completely
      // unaffected — pinned with a sender that WOULD auto-route under 1-3,
      // to prove the new fallback never fires for these two codes ═════════
      {
        // 7a: no_signals — headers object present but every field empty.
        const email = "post@fjellgard-test.no"; // exact rfb agent match
        const before = await countUntriaged();
        const threadId = `t-nosignals-${Math.random().toString(36).slice(2)}`;
        const res = await callRoute(crmRouter, {
          method: "POST",
          url: "/ingest",
          headers: { "x-admin-key": ADMIN_KEY },
          body: baseIngestBody({
            threadId,
            primaryFromEmail: email,
            messages: [
              { messageId: `msg-${threadId}`, direction: "in", fromEmail: email, snippet: "hei" },
            ],
            routingSignals: {},
          }),
        });
        assertEq(res.status, 202, "7a: no_signals refusal -> still 202 parked, even for a known-contact sender");
        assertTrue(
          String(res.body?.reason || "").includes("no recipient headers were supplied"),
          "7b: reason is the no_signals message, not an auto-route",
        );
        const after = await countUntriaged();
        assertEq(after, before + 1, "7c: parked exactly once, no thread created");
        const thread = db.prepare("SELECT id FROM crm_threads WHERE id = ?").get(threadId) as any;
        assertEq(thread, undefined, "7d: no thread row — the known-contact match was never consulted for no_signals");
      }
      {
        // 7e: ambiguous_platform_addresses — both aliases present.
        const email = "post@fjellgard-test.no"; // exact rfb agent match
        const before = await countUntriaged();
        const threadId = `t-ambiguous-${Math.random().toString(36).slice(2)}`;
        const res = await callRoute(crmRouter, {
          method: "POST",
          url: "/ingest",
          headers: { "x-admin-key": ADMIN_KEY },
          body: baseIngestBody({
            threadId,
            primaryFromEmail: email,
            messages: [
              { messageId: `msg-${threadId}`, direction: "in", fromEmail: email, snippet: "hei" },
            ],
            routingSignals: {
              to: "kontakt@rettfrabonden.com",
              cc: "kontakt@opplevagent.no",
            },
          }),
        });
        assertEq(res.status, 202, "7f: ambiguous_platform_addresses -> still 202 parked, even for a known-contact sender");
        assertTrue(
          String(res.body?.reason || "").includes("more than one platform alias"),
          "7g: reason is the ambiguous_platform_addresses message, not an auto-route",
        );
        const after = await countUntriaged();
        assertEq(after, before + 1, "7h: parked exactly once, no thread created");
        const thread = db.prepare("SELECT id FROM crm_threads WHERE id = ?").get(threadId) as any;
        assertEq(thread, undefined, "7i: no thread row — the known-contact match was never consulted for ambiguous headers");
      }
    } catch (err: any) {
      failed++;
      failures.push(
        "crm-ingest-alias-gate-autoroute: unexpected error: " + String(err?.stack || err?.message || err),
      );
    } finally {
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
      if (prevExpPath === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevExpPath;
      if (prevDb) initMod.__setDbForTesting(prevDb);
      for (const p of cachePaths) delete require.cache[p];
      try { db.close(); } catch { /* best-effort */ }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runCrmIngestAliasGateAutorouteTests({ log: true }).then((r) => {
    console.log(`\ncrm-ingest-alias-gate-autoroute: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
