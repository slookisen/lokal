/**
 * crm-service-relink-unlinked.test.ts — pins crmService.relinkUnlinkedRfb()
 * and POST /admin/crm/contacts/relink-unlinked (svarsperre follow-up to
 * lokal#1609: one-time relink of unlinked rfb contacts that classifyEmail()
 * now resolves to a producer, dry run first).
 *
 * Covers:
 *   R1  dry run counts a relinkable unlinked contact and writes nothing
 *       (row unchanged, no crm_actions row added — not even for a blocked
 *       platform-name match)
 *   R2  apply links it, writes one audit row, and is idempotent
 *   R3  vendor/marketing contacts and experiences contacts are never touched
 *   R4  a contact whose e-mail resolves to no producer stays unlinked
 *   R5  with_inbound_reply counts relinkable contacts with an inbound message
 *       or a retention inbound marker
 *   R6  route: dry_run absent or confirm missing => dry run (no write);
 *       dry_run=false + confirm "relink" => apply
 *   R7  no e-mail address appears in any response
 *
 * Standalone: npx tsx src/services/crm-service-relink-unlinked.test.ts
 * Wired into the gate: tests/test.ts.
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";
import { crmService } from "./crm-service";
import { getConfig, loadConfigsAtBoot } from "../config/vertical-config";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRouteSync(
  router: any,
  opts: { url: string; query?: Record<string, string>; headers?: Record<string, string>; body?: any },
): RouteResult {
  let result: RouteResult = { status: 0, body: undefined };
  const headers = opts.headers || {};
  const req: any = {
    method: "POST",
    url: opts.url,
    originalUrl: opts.url,
    query: opts.query || {},
    headers,
    body: opts.body,
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
      result = { status: this.statusCode, body: payload };
      return this;
    },
  };
  router.handle(req, res, (err?: any) => {
    if (err) result = { status: 500, body: { error: String(err) } };
  });
  return result;
}

export function runCrmServiceRelinkUnlinkedTests(opts: { log?: boolean } = {}): TestSummary {
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

  const prevDb = __peekDbForTesting();
  const prevAdminKey = process.env.ADMIN_KEY;
  const testKey = "crm-relink-unlinked-test-key";
  process.env.ADMIN_KEY = testKey;

  // The platform-name guard reads the rfb display_name; make sure a config is
  // loaded (another suite may already have loaded one — reuse it).
  let rfbDisplayName: string | null = null;
  try {
    rfbDisplayName = getConfig("rfb").display_name;
  } catch {
    try {
      loadConfigsAtBoot();
      rfbDisplayName = getConfig("rfb").display_name;
    } catch {
      rfbDisplayName = null;
    }
  }

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);

  function insertAgent(id: string, name: string, contactEmail: string): void {
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
      VALUES (?, ?, 'test producer', 'test', ?, 'https://example.no', 'producer', ?)
    `).run(id, name, contactEmail, `key-${id}`);
  }
  function insertKnowledgeEmail(agentId: string, email: string): void {
    db.prepare(`INSERT INTO agent_knowledge (agent_id, email, field_provenance) VALUES (?, ?, '{}')`).run(agentId, email);
  }
  function insertContact(id: string, type: string, email: string, vertical = "rfb"): void {
    db.prepare(
      `INSERT INTO crm_contacts (id, type, agent_id, email, name, vertical_id) VALUES (?, ?, NULL, ?, ?, ?)`,
    ).run(id, type, email, `Name ${id}`, vertical);
  }
  function insertMessage(contactId: string, direction: "in" | "out"): void {
    const threadId = `thread-${contactId}`;
    db.prepare(`
      INSERT OR IGNORE INTO crm_threads (id, contact_id, subject, category, status, assigned_to)
      VALUES (?, ?, 'Svar', 'innkommende', 'in_progress', 'claude')
    `).run(threadId, contactId);
    db.prepare(`
      INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, subject, body_text, sent_at, received_at, delivery_status)
      VALUES (?, ?, ?, 'a@b.no', '["c@d.no"]', 'Svar', 'hei', datetime('now'), datetime('now'), 'sent')
    `).run(`m-${contactId}-${direction}`, threadId, direction);
  }
  const contactRow = (id: string) =>
    db.prepare("SELECT type, agent_id, provider_id FROM crm_contacts WHERE id = ?").get(id) as any;
  const actionCount = () => (db.prepare("SELECT COUNT(*) AS n FROM crm_actions").get() as any).n as number;

  const ALL_EMAILS = [
    "post@gard-a.relink-test.no",
    "salg@gard-b.relink-test.no",
    "kontakt@gard-c.relink-test.no",
    "nomatch@nowhere.relink-test.no",
    "faktura@gard-a.relink-test.no",
    "press@gard-a.relink-test.no",
    "post@house.relink-test.no",
  ];
  const noEmailIn = (body: unknown, label: string) => {
    const text = JSON.stringify(body).toLowerCase();
    assertEq(
      ALL_EMAILS.some((e) => text.includes(e)) || text.includes("@"),
      false,
      `R7: no e-mail address in response (${label})`,
    );
  };

  try {
    // Producers.
    insertAgent("agent-a", "Gård A", "post@gard-a.relink-test.no");
    insertAgent("agent-b", "Gård B", "other@gard-b-own.relink-test.no");
    insertKnowledgeEmail("agent-b", "salg@gard-b.relink-test.no");

    // c-a: unknown, exact agents.contact_email match, has an inbound reply.
    insertContact("c-a", "unknown", "post@gard-a.relink-test.no");
    insertMessage("c-a", "in");
    // c-b: producer type, agent_knowledge match, only outbound + retention inbound marker.
    insertContact("c-b", "producer", "salg@gard-b.relink-test.no");
    insertMessage("c-b", "out");
    db.prepare("UPDATE crm_contacts SET retention_last_inbound_at = datetime('now', '-800 days') WHERE id = 'c-b'").run();
    // c-nomatch: resolves to no producer (no agent with that address or domain).
    insertContact("c-nomatch", "producer", "nomatch@nowhere.relink-test.no");
    insertMessage("c-nomatch", "in");
    // Vendor/marketing contacts whose e-mail would domain-match agent-a.
    insertContact("c-vendor", "vendor", "faktura@gard-a.relink-test.no");
    insertContact("c-marketing", "marketing", "press@gard-a.relink-test.no");
    // Experiences contact with an e-mail that matches an rfb producer exactly.
    insertContact("c-exp", "unknown", "post@gard-a.relink-test.no", "experiences");
    // House-bucket agent: a match must be blocked (and logged only on apply).
    if (rfbDisplayName) {
      insertAgent("agent-house", rfbDisplayName, "post@house.relink-test.no");
      insertContact("c-house", "unknown", "post@house.relink-test.no");
    }

    // ══ R1: dry run ═════════════════════════════════════════════════════
    const actionsBefore = actionCount();
    const dry = crmService.relinkUnlinkedRfb({ dryRun: true });
    assertEq(dry.dry_run, true, "R1: dry_run=true echoed");
    assertEq(dry.evaluated, rfbDisplayName ? 4 : 3, "R1: evaluated = rfb unlinked non-vendor/marketing contacts");
    assertEq(dry.relinkable, 2, "R1: relinkable counts the two resolvable contacts");
    assertEq(dry.relinked, 0, "R1: dry run relinks nothing");
    assertEq(
      dry.sample,
      [
        { contact_id: "c-a", agent_id: "agent-a", type: "producer" },
        { contact_id: "c-b", agent_id: "agent-b", type: "producer" },
      ],
      "R1: sample has ids + agent + type only",
    );
    assertEq(contactRow("c-a"), { type: "unknown", agent_id: null, provider_id: null }, "R1: c-a row unchanged after dry run");
    assertEq(actionCount(), actionsBefore, "R1: no crm_actions row written by dry run (incl. blocked house-bucket match)");
    noEmailIn(dry, "service dry run");

    // ══ R5: with_inbound_reply ══════════════════════════════════════════
    assertEq(dry.with_inbound_reply, 2, "R5: inbound message (c-a) and retention marker (c-b) both counted");

    // ══ R6: route defaults to dry run ═══════════════════════════════════
    const crmRouter = (require("../routes/crm") as typeof import("../routes/crm")).default as any;
    const auth = { "x-admin-key": testKey };
    const url = "/contacts/relink-unlinked";

    const r0 = callRouteSync(crmRouter, { url, headers: auth });
    assertEq([r0.status, r0.body?.dry_run, r0.body?.relinked], [200, true, 0], "R6-a: no params -> dry run");
    const r1 = callRouteSync(crmRouter, { url, headers: auth, body: { dry_run: false } });
    assertEq([r1.status, r1.body?.dry_run, r1.body?.relinked], [200, true, 0], "R6-b: dry_run=false without confirm -> dry run");
    const r2 = callRouteSync(crmRouter, { url, headers: auth, body: { confirm: "relink" } });
    assertEq([r2.status, r2.body?.dry_run, r2.body?.relinked], [200, true, 0], "R6-c: confirm without dry_run=false -> dry run");
    const r3 = callRouteSync(crmRouter, { url, headers: auth, query: { dry_run: "true" }, body: { confirm: "relink" } });
    assertEq(r3.body?.dry_run, true, "R6-d: dry_run=true + confirm -> dry run");
    const r4 = callRouteSync(crmRouter, { url, headers: auth, body: { dry_run: false, confirm: "yes" } });
    assertEq(r4.body?.dry_run, true, "R6-e: wrong confirm word -> dry run");
    const rUnauth = callRouteSync(crmRouter, { url, headers: {} });
    assertEq(rUnauth.status, 401, "R6-f: no admin key -> 401");
    assertEq(contactRow("c-a").agent_id, null, "R6: no write after the dry-run route calls");
    assertEq(actionCount(), actionsBefore, "R6: no crm_actions rows after the dry-run route calls");
    noEmailIn(r0.body, "route dry run");

    // ══ R2: apply through the route (query dry_run=false + body confirm) ═
    const apply = callRouteSync(crmRouter, {
      url,
      headers: auth,
      query: { dry_run: "false" },
      body: { confirm: "relink" },
    });
    assertEq(apply.status, 200, "R2: apply -> 200");
    assertEq(apply.body?.dry_run, false, "R2: apply dry_run=false echoed");
    assertEq(apply.body?.relinked, 2, "R2: apply relinks the two resolvable contacts");
    assertEq(apply.body?.with_inbound_reply, 2, "R2: apply reports with_inbound_reply");
    assertEq(contactRow("c-a"), { type: "producer", agent_id: "agent-a", provider_id: null }, "R2: c-a linked to agent-a");
    assertEq(contactRow("c-b"), { type: "producer", agent_id: "agent-b", provider_id: null }, "R2: c-b linked to agent-b");
    const audit = db
      .prepare("SELECT contact_id, actor, payload FROM crm_actions WHERE type = 'contact_reclassified' ORDER BY contact_id")
      .all() as Array<{ contact_id: string; actor: string; payload: string }>;
    assertEq(
      audit.map((a) => [a.contact_id, a.actor, JSON.parse(a.payload).source, JSON.parse(a.payload).agent_id]),
      [
        ["c-a", "system", "relink_unlinked_rfb", "agent-a"],
        ["c-b", "system", "relink_unlinked_rfb", "agent-b"],
      ],
      "R2: one audit row per relinked contact",
    );
    noEmailIn(apply.body, "route apply");

    // Idempotent.
    const again = crmService.relinkUnlinkedRfb({ dryRun: false });
    assertEq([again.relinkable, again.relinked], [0, 0], "R2: second apply relinks 0");
    assertEq(
      (db.prepare("SELECT COUNT(*) AS n FROM crm_actions WHERE type = 'contact_reclassified'").get() as any).n,
      2,
      "R2: second apply writes no further audit rows",
    );

    // ══ R3: vendor / marketing / experiences untouched ══════════════════
    assertEq(contactRow("c-vendor"), { type: "vendor", agent_id: null, provider_id: null }, "R3: vendor contact untouched");
    assertEq(
      contactRow("c-marketing"),
      { type: "marketing", agent_id: null, provider_id: null },
      "R3: marketing contact untouched",
    );
    assertEq(contactRow("c-exp"), { type: "unknown", agent_id: null, provider_id: null }, "R3: experiences contact untouched");

    // ══ R4: no-match stays unlinked ═════════════════════════════════════
    assertEq(contactRow("c-nomatch").agent_id, null, "R4: unresolvable contact stays unlinked");
    if (rfbDisplayName) {
      assertEq(contactRow("c-house").agent_id, null, "R4b: house-bucket match is not linked");
    }
  } finally {
    __setDbForTesting(prevDb as any);
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runCrmServiceRelinkUnlinkedTests({ log: true });
  console.log(`\ncrm-service-relink-unlinked: ${r.passed} passed, ${r.failed} failed`);
  // Explicit exit: importing the crm router opens handles that keep the
  // process alive in standalone mode.
  process.exit(r.failed > 0 ? 1 : 0);
}
