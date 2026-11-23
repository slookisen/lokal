/**
 * admin-agents-duplicate-groups-backfill.test.ts — dev-request
 * 2026-11-22-rfb-dubletter-samme-nettsted-sammenslaaing-og-utsending,
 * points 1 and 3.
 *
 * GET /admin/agents/duplicate-groups (read-only detector):
 *   g1  groups by website domain (agents.url / agent_knowledge.website, www
 *       and subdomain folded to the registrable domain), org.nr. and e-mail
 *   g2  hosted platforms (facebook.com, wixsite.com) and free-mail website
 *       domains are no key; free-mail e-mail groups only with include_free_mail
 *   g3  inactive / merged / non-RFB / umbrella profiles excluded
 *   g4  no e-mail address in the response (hashed key only)
 *   g5  differing addresses, sent / replied / claimed flags, summary counts
 *       incl. shared_contact_emails (AC5), pagination + key_type filter
 *   g6  read-only: total_changes() unchanged
 *
 * POST /admin/agents/merge-history-backfill:
 *   b1  dry-run (default) writes nothing (total_changes) and reports counts +
 *       sample incl. the 2-level chain's final survivor
 *   b2  apply moves crm_contacts / outreach_sent_log / ledger rows (2-level
 *       chain ends at the active survivor), writes merge_moved:<table> audit
 *       rows on the merged profile
 *   b3  cycle, inactive and missing chain ends skipped + reported, not moved
 *   b4  idempotent: second apply moves 0; limit caps sources
 *   auth 403 on both routes without / with a wrong key
 *
 * Fresh in-memory SQLite with the real schema, wired through each route's
 * own DB seam (the getDb() singleton is not touched).
 *
 * Standalone: npx tsx src/routes/admin-agents-duplicate-groups-backfill.test.ts
 * Wired into the gate: tests/test.ts.
 */

import Database from "better-sqlite3";

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
  opts: { method: string; query?: Record<string, string>; headers?: Record<string, string>; body?: any },
): RouteResult {
  let result: RouteResult = { status: 0, body: undefined };
  const headers = opts.headers || {};
  const req: any = {
    method: opts.method,
    url: "/",
    originalUrl: "/",
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
      result = { status: this.statusCode, body: payload };
      return this;
    },
  };
  router.handle(req, res, (err?: any) => {
    if (err) result = { status: 500, body: { error: String(err) } };
  });
  return result;
}

export function runAdminAgentsDuplicateGroupsBackfillTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const eq = (actual: unknown, expected: unknown, label: string): void => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  };

  const ambientKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  const setKeyOurselves = ambientKey === "";
  if (setKeyOurselves) process.env.ADMIN_KEY = "duplicate-groups-standalone-key";
  const auth = { "x-admin-key": (process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY) as string };

  const initMod = require("../database/init") as typeof import("../database/init");
  const groupsMod = require("./admin-agents-duplicate-groups") as typeof import("./admin-agents-duplicate-groups");
  const backfillMod = require("./admin-agents-merge-history-backfill") as typeof import("./admin-agents-merge-history-backfill");
  const db = new Database(":memory:");

  try {
    initMod.__initSchemaForTesting(db as any);
    groupsMod.__setDuplicateGroupsDbForTesting(db as any);
    backfillMod.__setMergeHistoryBackfillDbForTesting(db as any);

    function agent(
      id: string,
      o: {
        url?: string;
        contactEmail?: string;
        orgNr?: string | null;
        city?: string | null;
        active?: number;
        mergedInto?: string | null;
        vertical?: string;
        umbrella?: string | null;
        claimed?: boolean;
        website?: string | null;
        kEmail?: string | null;
        address?: string | null;
        postal?: string | null;
      } = {},
    ): void {
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, org_nr, city,
                             is_active, merged_into, vertical_id, umbrella_type, claimed_at)
         VALUES (?, ?, 'test', 'test', ?, ?, 'producer', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        `Gård ${id}`,
        o.contactEmail ?? "",
        o.url ?? "https://rettfrabonden.com/produsent/" + id,
        `key-${id}`,
        o.orgNr ?? null,
        o.city ?? null,
        o.active ?? 1,
        o.mergedInto ?? null,
        o.vertical ?? "rfb",
        o.umbrella ?? null,
        o.claimed ? "2026-10-01T00:00:00Z" : null,
      );
      if (o.website !== undefined || o.kEmail !== undefined || o.address !== undefined || o.postal !== undefined) {
        db.prepare(`INSERT INTO agent_knowledge (agent_id, website, email, address, postal_code) VALUES (?, ?, ?, ?, ?)`).run(
          id,
          o.website ?? null,
          o.kEmail ?? null,
          o.address ?? null,
          o.postal ?? null,
        );
      }
    }
    function contact(id: string, agentId: string, email: string, inbound: boolean): void {
      db.prepare(`INSERT INTO crm_contacts (id, type, agent_id, email, name, vertical_id) VALUES (?, 'producer', ?, ?, ?, 'rfb')`).run(
        id,
        agentId,
        email,
        id,
      );
      if (!inbound) return;
      db.prepare(
        `INSERT INTO crm_threads (id, contact_id, subject, category, status, assigned_to)
         VALUES (?, ?, 'Svar', 'innkommende', 'in_progress', 'claude')`,
      ).run(`t-${id}`, id);
      db.prepare(
        `INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, subject, body_text, sent_at, received_at, delivery_status)
         VALUES (?, ?, 'in', ?, '["kontakt@rettfrabonden.com"]', 'Svar', 'Takk', datetime('now'), datetime('now'), 'sent')`,
      ).run(`m-${id}`, `t-${id}`, email);
    }
    function sent(agentId: string, email: string): number {
      return Number(
        db
          .prepare(
            `INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes)
             VALUES (?, ?, datetime('now', '-20 days'), 'email', ?, 'test')`,
          )
          .run(agentId, email, `msg-${agentId}-${email}`).lastInsertRowid,
      );
    }
    function ledger(agentId: string, email: string, day: string): number {
      return Number(
        db
          .prepare(
            `INSERT INTO rfb_marketing_send_ledger (day, run_id, agent_id, recipient_email, touch, status, reserved_at)
             VALUES (?, 'run-test', ?, ?, 'first', 'sent', ?)`,
          )
          .run(day, agentId, email, `${day}T08:00:00.000Z`).lastInsertRowid,
      );
    }
    const totalChanges = () => (db.prepare(`SELECT total_changes() AS n`).get() as any).n as number;

    // ── auth ─────────────────────────────────────────────────────────────
    eq(callRouteSync(groupsMod.default, { method: "GET" }).status, 403, "auth: duplicate-groups without key → 403");
    eq(
      callRouteSync(groupsMod.default, { method: "GET", headers: { "x-admin-key": "wrong" } }).status,
      403,
      "auth: duplicate-groups wrong key → 403",
    );
    eq(callRouteSync(backfillMod.default, { method: "POST", body: {} }).status, 403, "auth: backfill without key → 403");
    eq(
      callRouteSync(backfillMod.default, { method: "POST", headers: { "x-admin-key": "wrong" }, body: { dry_run: false } }).status,
      403,
      "auth: backfill wrong key → 403",
    );

    // ── detector fixtures ────────────────────────────────────────────────
    // Domain group: www / subdomain / knowledge website fold to gard-a.no.
    agent("d1", { url: "https://www.gard-a.no/", address: "Storvegen 1", postal: "2000", website: null });
    agent("d2", { website: "https://butikk.gard-a.no/om", address: "Lillevegen 9", postal: "3000", claimed: true });
    contact("c-d2", "d2", "post@gard-a.no", true);
    agent("d3", { url: "gard-a.no", vertical: "rfb" });
    sent("d3", "post@gard-a.no");
    // Same domain, but inactive / merged / dental / umbrella → excluded.
    agent("d-inactive", { url: "https://gard-a.no", active: 0 });
    agent("d-merged", { url: "https://gard-a.no", mergedInto: "d1", active: 0 });
    agent("d-dental", { url: "https://gard-a.no", vertical: "dental" });
    agent("d-umbrella", { url: "https://gard-a.no", umbrella: "cooperative" });
    // Platform hosts: two farms on facebook.com / wixsite.com are no group.
    agent("p1", { url: "https://www.facebook.com/gardp1" });
    agent("p2", { url: "https://www.facebook.com/gardp2" });
    agent("p3", { website: "https://gardp3.wixsite.com/home" });
    agent("p4", { website: "https://gardp4.wixsite.com/home" });
    // Free-mail/ISP personal pages: no domain group.
    agent("f1", { website: "http://home.online.no/~gardf1" });
    agent("f2", { website: "http://home.online.no/~gardf2" });
    // Org.nr. group (whitespace folded), same address.
    agent("o1", { orgNr: "999 888 777", address: "Fjellvegen 3", postal: "5000" });
    agent("o2", { orgNr: "999888777", address: "fjellvegen  3", postal: "5000" });
    agent("o3", { orgNr: "12345" }); // malformed: no key
    agent("o4", { orgNr: "12345" });
    // E-mail group on an own domain (contact_email vs knowledge email).
    agent("e1", { contactEmail: "Post@Felles-Gard.no " });
    agent("e2", { kEmail: "post@felles-gard.no", city: "Voss" });
    ledger("e2", "post@felles-gard.no", "2026-10-01");
    // E-mail group on free-mail (only with include_free_mail).
    agent("g1", { contactEmail: "bonden.hansen@gmail.com", city: "Hamar" });
    agent("g2", { kEmail: "bonden.hansen@gmail.com", city: "Elverum" });
    // A singleton (no group).
    agent("solo", { url: "https://solo-gard.no", contactEmail: "post@solo-gard.no", orgNr: "111222333" });

    const before = totalChanges();
    let r = callRouteSync(groupsMod.default, { method: "GET", headers: auth });
    eq(r.status, 200, "g: 200");
    const groups: any[] = r.body?.groups ?? [];
    const find = (kt: string, pred: (g: any) => boolean) => groups.find((g) => g.key_type === kt && pred(g));

    const dom = find("domain", (g) => g.key_value === "gard-a.no");
    eq(dom?.member_ids, ["d1", "d2", "d3"], "g1/g3: domain group gard-a.no = d1,d2,d3 (inactive/merged/dental/umbrella excluded)");
    eq(
      groups.filter((g) => g.key_type === "domain").map((g) => g.key_value),
      ["gard-a.no"],
      "g2: no domain group for facebook.com / wixsite.com / online.no",
    );
    eq(dom?.addresses_differ, true, "g5: gard-a.no members have differing addresses");
    eq(dom?.any_sent, true, "g5: domain group any_sent (outreach_sent_log on d3)");
    eq(dom?.any_replied, true, "g5: domain group any_replied (inbound crm on d2)");
    eq(dom?.any_claimed, true, "g5: domain group any_claimed (d2)");
    eq(
      dom?.members?.map((m: any) => [m.id, m.claimed, m.sent, m.replied]),
      [
        ["d1", false, false, false],
        ["d2", true, false, true],
        ["d3", false, true, false],
      ],
      "g5: per-member claimed/sent/replied",
    );

    const org = find("orgnr", () => true);
    eq([org?.key_value, org?.member_ids], ["999888777", ["o1", "o2"]], "g1: org.nr. group (whitespace folded), malformed ignored");
    eq(org?.addresses_differ, false, "g5: same street address (case/space folded) → not differing");

    const emailGroups = groups.filter((g) => g.key_type === "email");
    eq(emailGroups.map((g) => g.member_ids), [["e1", "e2"]], "g1/g2: e-mail group e1,e2; free-mail group left out by default");
    eq(emailGroups[0]?.key_value, groupsMod.emailHash("post@felles-gard.no"), "g4: e-mail key is the hash of the normalized address");
    eq(emailGroups[0]?.any_sent, true, "g5: e-mail group any_sent via rfb_marketing_send_ledger");
    const json = JSON.stringify(r.body);
    eq(
      ["felles-gard", "gmail", "post@gard-a.no", "solo-gard.no"].filter((s) => json.includes(s)),
      [],
      "g4: no e-mail address or address domain anywhere in the response",
    );

    const sum = r.body?.summary;
    eq(sum?.groups, 3, "g5: summary groups = 3");
    eq(sum?.profiles, 7, "g5: summary profiles = 7");
    eq(sum?.groups_with_differing_addresses, 1, "g5: groups with differing addresses = 1");
    eq(
      sum?.by_key_type,
      { domain: { groups: 1, profiles: 3 }, orgnr: { groups: 1, profiles: 2 }, email: { groups: 1, profiles: 2 } },
      "g5: per key type",
    );
    eq(
      sum?.shared_contact_emails,
      { addresses: 2, profiles: 4, free_mail_addresses: 1 },
      "g5/AC5: shared contact e-mails count ALL addresses (free-mail included)",
    );

    r = callRouteSync(groupsMod.default, { method: "GET", headers: auth, query: { include_free_mail: "1", key_type: "email" } });
    eq(
      (r.body?.groups ?? []).map((g: any) => [g.member_ids, g.free_mail, g.addresses_differ]).sort(),
      [
        [["e1", "e2"], false, false],
        [["g1", "g2"], true, true],
      ],
      "g2/g5: include_free_mail adds the gmail group (differing places), key_type filter",
    );
    eq(JSON.stringify(r.body).includes("hansen"), false, "g4: free-mail address not leaked either");

    r = callRouteSync(groupsMod.default, { method: "GET", headers: auth, query: { limit: "1", offset: "1" } });
    eq([r.body?.total_groups, r.body?.groups?.length, r.body?.offset, r.body?.limit], [3, 1, 1, 1], "g5: pagination");
    eq(callRouteSync(groupsMod.default, { method: "GET", headers: auth, query: { key_type: "phone" } }).status, 400, "g: bad key_type → 400");
    eq(totalChanges(), before, "g6: detector wrote nothing (total_changes unchanged)");

    // ── backfill fixtures ────────────────────────────────────────────────
    // 2-level chain: bA → bB → bC (active). History on bA and bB.
    agent("bC", {});
    agent("bB", { active: 0, mergedInto: "bC" });
    agent("bA", { active: 0, mergedInto: "bB" });
    contact("c-bA", "bA", "svar@chain.example.no", true);
    const sA = sent("bA", "svar@chain.example.no");
    const lA = ledger("bA", "svar@chain.example.no", "2026-07-01");
    const sB = sent("bB", "post@chain.example.no");
    // Cycle: bX → bY → bX.
    agent("bX", { active: 0, mergedInto: "bY" });
    agent("bY", { active: 0, mergedInto: "bX" });
    sent("bX", "x@cycle.example.no");
    // Dead end: chain ends at an inactive (deactivated, not merged) profile.
    agent("bDead", { active: 0 });
    agent("bToDead", { active: 0, mergedInto: "bDead" });
    contact("c-bToDead", "bToDead", "dead@end.example.no", false);
    // Missing target.
    agent("bOrphan", { active: 0, mergedInto: "does-not-exist" });
    sent("bOrphan", "o@orphan.example.no");
    // Active profile with history: never a source.
    sent("bC", "post@c.example.no");

    const beforeDry = totalChanges();
    r = callRouteSync(backfillMod.default, { method: "POST", headers: auth, body: {} });
    eq(r.status, 200, "b1: dry-run 200");
    eq(r.body?.dry_run, true, "b1: dry_run defaults to true");
    eq(totalChanges(), beforeDry, "b1: dry-run wrote nothing (total_changes unchanged)");
    eq(
      r.body?.counts,
      { crm_contacts: 1, crm_threads: 1, outreach_sent_log: 2, rfb_marketing_send_ledger: 1 },
      "b1: dry-run counts per table",
    );
    eq(
      (r.body?.sample ?? []).map((s: any) => [s.table, s.row_id, s.from, s.to]),
      [
        ["crm_contacts", "c-bA", "bA", "bC"],
        ["outreach_sent_log", sA, "bA", "bC"],
        ["rfb_marketing_send_ledger", lA, "bA", "bC"],
        ["outreach_sent_log", sB, "bB", "bC"],
      ],
      "b1: sample (row id, from, to) resolves the 2-level chain to bC",
    );
    eq(
      (r.body?.skipped ?? []).map((s: any) => [s.from, s.reason]).sort(),
      [
        ["bOrphan", "target_missing"],
        ["bToDead", "target_inactive"],
        ["bX", "cycle"],
      ],
      "b3: cycle / inactive / missing chain ends reported as skipped",
    );
    eq(
      callRouteSync(backfillMod.default, { method: "POST", headers: auth, body: { dry_run: "yes" } }).body?.dry_run,
      true,
      "b1: a non-false dry_run value stays a dry-run",
    );
    eq(totalChanges(), beforeDry, "b1: still nothing written");

    // limit caps the sources handled (sorted ids: bA, bB, bOrphan, bToDead, bX).
    r = callRouteSync(backfillMod.default, { method: "POST", headers: auth, body: { limit: 1 } });
    eq([r.body?.sources_total, r.body?.sources_handled, r.body?.counts?.outreach_sent_log], [5, 1, 1], "b4: limit caps sources");
    eq(callRouteSync(backfillMod.default, { method: "POST", headers: auth, body: { limit: 0 } }).status, 400, "b4: limit 0 → 400");

    r = callRouteSync(backfillMod.default, { method: "POST", headers: auth, body: { dry_run: false } });
    eq(r.status, 200, "b2: apply 200");
    eq(r.body?.dry_run, false, "b2: dry_run false applied");
    eq(
      r.body?.counts,
      { crm_contacts: 1, crm_threads: 1, outreach_sent_log: 2, rfb_marketing_send_ledger: 1 },
      "b2: moved counts",
    );
    const agentOf = (table: string, col: string, id: string | number) =>
      (db.prepare(`SELECT agent_id FROM ${table} WHERE ${col} = ?`).get(id) as any)?.agent_id;
    eq(
      [agentOf("crm_contacts", "id", "c-bA"), agentOf("outreach_sent_log", "id", sA), agentOf("rfb_marketing_send_ledger", "id", lA), agentOf("outreach_sent_log", "id", sB)],
      ["bC", "bC", "bC", "bC"],
      "b2: rows re-pointed to the final survivor bC",
    );
    eq(agentOf("crm_contacts", "id", "c-bToDead"), "bToDead", "b3: dead-end row not moved");
    eq(
      (db.prepare(`SELECT agent_id FROM outreach_sent_log WHERE recipient_email IN ('x@cycle.example.no','o@orphan.example.no') ORDER BY agent_id`).all() as any[]).map((x) => x.agent_id),
      ["bOrphan", "bX"],
      "b3: cycle / orphan rows not moved",
    );
    const audit = db
      .prepare(`SELECT agent_id, field_name, old_value, new_value, notes FROM agent_knowledge_audit WHERE field_name LIKE 'merge_moved:%' ORDER BY agent_id, field_name`)
      .all() as any[];
    eq(
      audit.map((a) => [a.agent_id, a.field_name, a.old_value, a.new_value]),
      [
        ["bA", "merge_moved:crm_contacts", "bA", "bC"],
        ["bA", "merge_moved:crm_threads", "bA", "bC"],
        ["bA", "merge_moved:outreach_sent_log", "bA", "bC"],
        ["bA", "merge_moved:rfb_marketing_send_ledger", "bA", "bC"],
        ["bB", "merge_moved:outreach_sent_log", "bB", "bC"],
      ],
      "b2: merge_moved:<table> audit rows like applyMergeWrites",
    );
    const n = JSON.parse(audit.find((a) => a.agent_id === "bB")?.notes ?? "{}");
    eq([n.count, n.ids, n.batch === r.body?.batch_tag], [1, [sB], true], "b2: audit notes carry ids + batch tag (rollback)");

    const beforeSecond = totalChanges();
    r = callRouteSync(backfillMod.default, { method: "POST", headers: auth, body: { dry_run: "false" } });
    eq(
      [r.body?.counts, r.body?.sources_moved],
      [{ crm_contacts: 0, crm_threads: 0, outreach_sent_log: 0, rfb_marketing_send_ledger: 0 }, 0],
      "b4: second apply moves 0 (idempotent)",
    );
    eq(totalChanges(), beforeSecond, "b4: second apply wrote nothing");

    // resolveMergeChain depth guard.
    let prev = "depth-0";
    agent(prev, {});
    for (let i = 1; i <= backfillMod.MERGE_CHAIN_MAX_DEPTH + 1; i++) {
      agent(`depth-${i}`, { active: 0, mergedInto: prev });
      prev = `depth-${i}`;
    }
    eq((backfillMod.resolveMergeChain(db as any, prev) as any).reason, "depth_exceeded", "b3: depth guard");
    eq(backfillMod.resolveMergeChain(db as any, "depth-2"), { ok: true, survivorId: "depth-0", depth: 2 }, "b3: short chain resolves");
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${err?.stack || err}`);
  } finally {
    groupsMod.__setDuplicateGroupsDbForTesting(null);
    backfillMod.__setMergeHistoryBackfillDbForTesting(null);
    if (setKeyOurselves) delete process.env.ADMIN_KEY;
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  const s = runAdminAgentsDuplicateGroupsBackfillTests({ log: true });
  console.log(`\nadmin-agents-duplicate-groups-backfill: ${s.passed} passed, ${s.failed} failed`);
  if (s.failed) for (const f of s.failures) console.log(f);
  process.exit(s.failed ? 1 : 0);
}
