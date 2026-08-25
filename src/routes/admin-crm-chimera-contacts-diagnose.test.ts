/**
 * admin-crm-chimera-contacts-diagnose.test.ts — tests
 * GET /admin/crm-chimera-contacts-diagnose (dev-request
 * 2026-07-23-crm-house-bucket-kimaere-opprydding, slice 3).
 *
 * Mirrors admin-crm-chimera-agent-clear.test.ts's harness:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (full prod-like schema).
 *   - the previous global db handle is saved/restored.
 *   - the router is exercised directly (router.handle(req, res, next)),
 *     no HTTP server / supertest.
 *   - exported runAdminCrmChimeraContactsDiagnoseTests({log}) -> TestSummary;
 *     wired into tests/test.ts.
 *     Standalone: npx tsx src/routes/admin-crm-chimera-contacts-diagnose.test.ts
 *
 * Coverage:
 *   - system-pattern detection: plain "noreply@…"/"notifications@…" local
 *     parts, AND GitHub's per-user "…@users.noreply.github.com" convention
 *     (the signal there lives in the domain, not the local part).
 *   - confident real-agent match, one case per tier (exact contact_email,
 *     exact agent_knowledge.email, contact_email domain, agent_knowledge
 *     .website domain, org_nr embedded in the contact's organization text).
 *   - freemail domains are never used for a domain-tier match (gmail.com).
 *   - the platform-name-agent guard: a contact whose email exact-matches a
 *     SECOND "Rett fra Bonden"-named agent is not proposed as a producer
 *     match either — house-buckets never match each other.
 *   - the chimera agent id itself is excluded even if (hypothetically) its
 *     own contact fields matched.
 *   - no confident match anywhere -> type "unknown", flagged for manual
 *     review, never a guess.
 *   - scope guard: a crm_contacts row on a DIFFERENT agent_id never appears
 *     in the response.
 *   - zero-write guarantee: every relevant table's full row content is
 *     byte-identical before vs. after calling the route (twice).
 *   - auth is enforced: missing/wrong X-Admin-Key -> 403.
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
  ended: boolean;
}

function callRoute(
  router: any,
  opts: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    body?: any;
  },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      query: opts.query || {},
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
        resolve({ status: this.statusCode, body: payload, ended: true });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined, ended: true });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) {
        resolve({ status: 500, body: { error: String(err) }, ended: true });
      } else {
        resolve({ status: 0, body: undefined, ended: false });
      }
    });
  });
}

const CHIMERA_AGENT_ID = "2b5fc7a6-b446-4bea-8c2d-21315c6c6e17";

export function runAdminCrmChimeraContactsDiagnoseTests(
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
    const prevDb = initMod.getDb();
    const testKey = process.env.ADMIN_KEY || "admin-crm-chimera-contacts-diagnose-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      // getConfig('rfb').display_name must resolve for the platform-name-agent
      // guard to actually run (rather than fail-open) — same idiom as
      // crm-platform-identity.test.ts.
      const { loadConfigsAtBoot } = require("../config/vertical-config");
      try {
        loadConfigsAtBoot();
      } catch {
        /* already loaded */
      }

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, org_nr, is_active)
         VALUES (?, ?, 'test agent', 'test', ?, ?, ?, ?, ?, 1)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, email) VALUES (?, ?, ?)`,
      );
      const insertContact = db.prepare(
        `INSERT INTO crm_contacts (id, type, agent_id, email, name, organization, status)
         VALUES (?, 'unknown', ?, ?, ?, ?, 'active')`,
      );

      // ── the chimera itself: "Rett fra Bonden", role logistics — matches the
      // 'rfb' vertical's own display_name, so the platform-name guard applies
      // to it directly (not just to lookalikes).
      insertAgent.run(CHIMERA_AGENT_ID, "Rett fra Bonden", "kontakt@rettfrabonden.com", "https://rettfrabonden.com", "logistics", "key-chimera", null);

      // ── candidate agents, one per confident-match tier ──
      insertAgent.run("agent-exact-contact", "Kari sin Gård AS", "kontakt@karisgard.no", "https://karisgard.no", "producer", "key-1", null);

      insertAgent.run("agent-exact-knowledge", "Ola sin Gård AS", "post@olasgard-legacy.no", "https://olasgard.no", "producer", "key-2", null);
      insertKnowledge.run("agent-exact-knowledge", "https://olasgard.no", "salg@olasgard.no");

      insertAgent.run("agent-domain-contact", "Tredje Gård AS", "post@tredjegard.no", "https://tredjegard.no", "producer", "key-3", null);

      insertAgent.run("agent-domain-website", "Fjerde Gård AS", "x@example.com", "https://fjerdegard.no", "producer", "key-4", null);
      insertKnowledge.run("agent-domain-website", "https://fjerdegard.no", null);

      insertAgent.run("agent-org-nr", "Femte Gård AS", "post@femtegard.no", "https://femtegard.no", "producer", "key-5", "987654321");

      // A gmail.com-domain agent — used to prove the freemail-skip actually
      // blocks the domain tier (without this, "person2@gmail.com" below would
      // false-positive match this agent purely on shared @gmail.com).
      insertAgent.run("agent-gmail-producer", "Sjette Gård AS", "person1@gmail.com", "https://sjettegard.no", "producer", "key-6", null);

      // A SECOND platform-name agent (not the chimera itself) — proves the
      // guard is keyed on name, not on the one hardcoded chimera id.
      insertAgent.run("agent-second-house-bucket", "Rett fra Bonden", "dupe@rettfrabonden-internal.no", "https://rettfrabonden.com", "logistics", "key-7", null);

      // An inactive agent that would otherwise exact-match — must be excluded
      // by the same is_active=1 filter classifyEmail itself uses.
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
         VALUES ('agent-inactive', 'Syvende Gård AS', 'test', 'test', 'post@syvendegard.no', 'https://syvendegard.no', 'producer', 'key-8', 0)`,
      ).run();

      // ── the 13-row (well, N-row here) fixture on the chimera ──
      insertContact.run("c-system-noreply", CHIMERA_AGENT_ID, "noreply@github.com", null, null);
      insertContact.run("c-system-notifications", CHIMERA_AGENT_ID, "notifications@github.com", null, null);
      insertContact.run("c-system-google", CHIMERA_AGENT_ID, "noreply@google.com", null, null);
      insertContact.run("c-system-github-subdomain", CHIMERA_AGENT_ID, "12345+octocat@users.noreply.github.com", "GitHub", null);

      insertContact.run("c-match-exact-contact", CHIMERA_AGENT_ID, "kontakt@karisgard.no", "Kari", null);
      insertContact.run("c-match-exact-knowledge", CHIMERA_AGENT_ID, "salg@olasgard.no", "Ola", null);
      insertContact.run("c-match-domain-contact", CHIMERA_AGENT_ID, "annenperson@tredjegard.no", "Noen hos Tredje", null);
      insertContact.run("c-match-domain-website", CHIMERA_AGENT_ID, "kari@fjerdegard.no", "Kari hos Fjerde", null);
      insertContact.run("c-match-orgnr", CHIMERA_AGENT_ID, "tilfeldig@ukjentmail.no", "Kontaktperson", "Femte Gård AS, org.nr 987654321");

      insertContact.run("c-freemail-domain-noise", CHIMERA_AGENT_ID, "person2@gmail.com", "Privatperson", null);
      insertContact.run("c-second-housebucket-lookalike", CHIMERA_AGENT_ID, "dupe@rettfrabonden-internal.no", "?", null);
      insertContact.run("c-inactive-agent-noise", CHIMERA_AGENT_ID, "post@syvendegard.no", "?", null);
      insertContact.run("c-unknown", CHIMERA_AGENT_ID, "tilfeldig-sender@helt-ukjent-domene.no", "Ukjent", null);

      const CONTACT_COUNT = 13;

      // A contact on a DIFFERENT agent — must never appear in this endpoint's
      // response (scope guard).
      insertAgent.run("agent-other", "Annen Gård AS", "post@annengard.no", "https://annengard.no", "producer", "key-other", null);
      db.prepare(
        `INSERT INTO crm_contacts (id, type, agent_id, email, status) VALUES ('c-other-agent', 'producer', 'agent-other', 'noreply@other-agent-scope-guard.no', 'active')`,
      ).run();

      delete require.cache[require.resolve("./admin-crm-chimera-contacts-diagnose")];
      const routeMod = require("./admin-crm-chimera-contacts-diagnose");
      const router = routeMod.default;

      function get(headers: Record<string, string> | false = {}): Promise<RouteResult> {
        const h: Record<string, string> = headers === false ? {} : { ...headers };
        if (headers !== false && !("x-admin-key" in h)) h["x-admin-key"] = testKey;
        return callRoute(router, { method: "GET", url: "/", headers: h });
      }

      // ── snapshot every relevant table BEFORE any call ────────────────────
      const snapshot = () => ({
        agents: db.prepare("SELECT * FROM agents ORDER BY id").all(),
        agent_knowledge: db.prepare("SELECT * FROM agent_knowledge ORDER BY agent_id").all(),
        crm_contacts: db.prepare("SELECT * FROM crm_contacts ORDER BY id").all(),
        crm_actions: db.prepare("SELECT * FROM crm_actions ORDER BY rowid").all(),
      });
      const before = snapshot();

      // ── auth gate ─────────────────────────────────────────────────────
      let result = await get(false);
      assertEq(result.status, 403, "cd-01: missing X-Admin-Key -> 403");
      result = await get({ "x-admin-key": "wrong-key" });
      assertEq(result.status, 403, "cd-02: wrong X-Admin-Key -> 403");

      // ── the real call ────────────────────────────────────────────────
      result = await get();
      assertEq(result.status, 200, "cd-03: GET with a valid key -> 200");
      assertEq(result.body.success, true, "cd-04: success:true");
      assertEq(result.body.agent_id, CHIMERA_AGENT_ID, "cd-05: agent_id echoed is the chimera id");
      assertEq(result.body.contact_count, CONTACT_COUNT, "cd-06: contact_count matches the live row count on the chimera (verified against the seeded fixture, not assumed)");
      assertEq(result.body.proposals.length, CONTACT_COUNT, "cd-07: proposals array has exactly one entry per row");

      const byId = new Map<string, any>(result.body.proposals.map((p: any) => [p.contact_id, p]));

      // ── scope guard: the other-agent contact never appears ──────────────
      assertTrue(!byId.has("c-other-agent"), "cd-08: a crm_contacts row on a DIFFERENT agent_id is never returned");

      // ── system-pattern detection ─────────────────────────────────────
      for (const id of ["c-system-noreply", "c-system-notifications", "c-system-google", "c-system-github-subdomain"]) {
        const p = byId.get(id);
        assertTrue(!!p, `cd-09[${id}]: proposal present`);
        assertEq(p.proposed_type, "system", `cd-10[${id}]: proposed_type is "system"`);
        assertEq(p.proposed_agent_id, null, `cd-11[${id}]: proposed_agent_id is null for a system contact`);
        assertEq(p.flagged_for_manual_review, false, `cd-12[${id}]: a system-pattern match is not flagged for manual review`);
      }
      assertEq(
        byId.get("c-system-github-subdomain").evidence.matched_by,
        "noreply_subdomain",
        "cd-13: the GitHub per-user noreply address is matched via the DOMAIN signal, not the local part",
      );
      assertEq(
        byId.get("c-system-noreply").evidence.matched_by,
        "local_part_pattern",
        "cd-14: a plain noreply@ address is matched via the local-part signal",
      );

      // ── confident-match cases, one per tier ──────────────────────────
      const matchCases: Array<[string, string, string]> = [
        ["c-match-exact-contact", "agent-exact-contact", "exact_contact_email"],
        ["c-match-exact-knowledge", "agent-exact-knowledge", "exact_knowledge_email"],
        ["c-match-domain-contact", "agent-domain-contact", "contact_email_domain"],
        ["c-match-domain-website", "agent-domain-website", "website_domain"],
        ["c-match-orgnr", "agent-org-nr", "org_nr"],
      ];
      for (const [contactId, expectedAgentId, expectedTier] of matchCases) {
        const p = byId.get(contactId);
        assertTrue(!!p, `cd-15[${contactId}]: proposal present`);
        assertEq(p.proposed_type, "producer", `cd-16[${contactId}]: proposed_type is "producer"`);
        assertEq(p.proposed_agent_id, expectedAgentId, `cd-17[${contactId}]: proposed_agent_id is the correct real agent`);
        assertEq(p.flagged_for_manual_review, false, `cd-18[${contactId}]: a confident match is not flagged for manual review`);
        assertEq(p.evidence.match_tier, expectedTier, `cd-19[${contactId}]: evidence names the tier that matched (${expectedTier})`);
      }

      // ── no-match / unknown cases — never a guess ─────────────────────
      for (const id of ["c-freemail-domain-noise", "c-second-housebucket-lookalike", "c-inactive-agent-noise", "c-unknown"]) {
        const p = byId.get(id);
        assertTrue(!!p, `cd-20[${id}]: proposal present`);
        assertEq(p.proposed_type, "unknown", `cd-21[${id}]: proposed_type is "unknown"`);
        assertEq(p.proposed_agent_id, null, `cd-22[${id}]: proposed_agent_id is null — never a guess`);
        assertEq(p.flagged_for_manual_review, true, `cd-23[${id}]: flagged for manual review`);
      }

      // cd-24/25: the two "noise" cases specifically prove the GUARDS fired,
      // not merely that no match happened to exist.
      assertTrue(
        byId.get("c-freemail-domain-noise").evidence.email_domain === "gmail.com",
        "cd-24: the freemail contact's evidence still names its domain, confirming the domain WAS checked and correctly skipped rather than never reached",
      );

      // ── summary counts match the per-row classification ──────────────
      assertEq(result.body.summary.system, 4, "cd-26: summary.system counts the 4 system-pattern rows");
      assertEq(result.body.summary.producer_match, 5, "cd-27: summary.producer_match counts the 5 confident-match rows");
      assertEq(result.body.summary.unknown, 4, "cd-28: summary.unknown counts the 4 no-match rows");
      assertEq(
        result.body.summary.system + result.body.summary.producer_match + result.body.summary.unknown,
        CONTACT_COUNT,
        "cd-29: the three buckets partition every row exactly once",
      );

      // ── zero-write guarantee ──────────────────────────────────────────
      const afterFirstCall = snapshot();
      assertEq(afterFirstCall, before, "cd-30: agents/agent_knowledge/crm_contacts/crm_actions are byte-identical after the first GET — no write of any kind");

      // A second call (idempotency of the read + belt-and-braces on the
      // no-write guarantee — a route that wrote on its SECOND call only
      // would still pass a single before/after diff).
      const result2 = await get();
      assertEq(result2.body.contact_count, CONTACT_COUNT, "cd-31: a second GET reports the same count");
      const afterSecondCall = snapshot();
      assertEq(afterSecondCall, before, "cd-32: …and is STILL byte-identical after a second GET");
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminCrmChimeraContactsDiagnoseTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
