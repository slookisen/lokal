/**
 * admin-agents-content-correction-owner-consent.test.ts — A2A dev-request
 * 2026-10-28-rfb-okologisk-merking-debio-register-og-tekstrevisjon, S2e.
 *
 * POST /admin/agents/content-correction used to answer skipped_claimed for
 * every owner-locked profile. An item may now carry
 * `owner_consent: { crm_message_id }`: an inbound CRM reply from the agent's
 * own contact, after an outbound message we sent in the same thread, lets
 * that ONE item past the owner lock (and only the owner lock).
 *
 * Covers: no consent -> skipped_claimed (unchanged); malformed consent shape
 * -> invalid_item; consent from another agent's contact, an outbound message
 * (that itself follows a sent outbound, so only the direction check rejects
 * it), an inbound with no earlier sent outbound (incl. only a failed
 * outbound, only an earlier INBOUND, or an outbound at exactly the same
 * timestamp), an inbound on the right thread from a third-party address, a
 * nonexistent id -> invalid_consent with nothing written; a sender matching
 * the contact's email up to case/whitespace is accepted; valid consent in
 * dry-run -> would_write_with_owner_consent, nothing written / audited / no
 * crm_actions; valid consent + apply -> written_with_owner_consent, audit
 * notes carry ` · owner_consent=<id>`, crm_actions owner_consent_applied row;
 * valid consent on a curated field -> skipped_curated, nothing written;
 * consent on a NOT owner-locked row is ignored (plain `written`, no
 * crm_actions); a later outbound (our confirmation) does not void consent.
 *
 * S2e-2: the earlier sent outbound may be in ANY thread with the same
 * contact (replies are often imported as a new thread), at most 30 days
 * before the reply; crm_actions stays on the reply's thread and records
 * basis_outbound_message_id. Outbound only to another contact of the agent,
 * older than 30 days, after the reply, or none at all -> invalid_consent;
 * exactly 30 days with mixed ISO/SQLite timestamp formats -> valid.
 *
 * Same harness as admin-agents-content-quality.test.ts (better-sqlite3
 * ":memory:" + __initSchemaForTesting, the route's own DB seam,
 * router.handle() with a fake req/res — no HTTP). Mutates no shared global.
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
  opts: { headers?: Record<string, string>; body?: any; query?: Record<string, string> },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: "POST",
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
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ status: err ? 500 : 0, body: err ? { error: String(err) } : undefined });
    });
  });
}

const OLD_DESC = "Vi selger økologiske grønnsaker direkte fra gården hver lørdag.";
const NEW_DESC = "Vi selger grønnsaker direkte fra gården hver lørdag.";

export function runAdminAgentsContentCorrectionOwnerConsentTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const ambientKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
    const setKeyOurselves = ambientKey === "";
    if (setKeyOurselves) process.env.ADMIN_KEY = "content-correction-consent-standalone-key";
    const testKey = process.env.ADMIN_KEY as string;

    const db = new Database(":memory:");
    try {
      initMod.__initSchemaForTesting(db as any);
      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, claimed_at)
         VALUES (?, ?, ?, 'test', 'post@example.no', 'https://example.no', 'producer', ?, 'rfb', ?)`,
      );
      const insertKnowledge = db.prepare(`INSERT INTO agent_knowledge (agent_id, about, curated_fields) VALUES (?, ?, ?)`);
      const insertContact = db.prepare(`INSERT INTO crm_contacts (id, type, agent_id, email) VALUES (?, 'producer', ?, ?)`);
      const insertThread = db.prepare(`INSERT INTO crm_threads (id, contact_id, subject) VALUES (?, ?, 'Retting av tekst')`);
      const insertMsg = db.prepare(
        `INSERT INTO crm_messages (id, thread_id, direction, from_email, sent_at, received_at, delivery_status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      // Outbound from us; inbound from the contact's own address unless given.
      const CONTACT_EMAIL: Record<string, string> = {};
      const THREAD_CONTACT: Record<string, string> = {};
      const msg = (id: string, thread: string, dir: "in" | "out", sentAt: string | null, receivedAt: string, status: string, from?: string) =>
        insertMsg.run(id, thread, dir, from ?? (dir === "out" ? "post@rettfrabonden.com" : CONTACT_EMAIL[THREAD_CONTACT[thread]]), sentAt, receivedAt, status);
      const contact = (id: string, agentId: string, email: string) => {
        CONTACT_EMAIL[id] = email;
        insertContact.run(id, agentId, email);
      };
      const thread = (id: string, contactId: string) => {
        THREAD_CONTACT[id] = contactId;
        insertThread.run(id, contactId);
      };
      const CLAIMED = "2026-01-01T00:00:00.000Z";

      // Owner-locked producer with a proper notice -> reply thread.
      insertAgent.run("oc-a", "Gård A", OLD_DESC, "k-oc-a", CLAIMED);
      insertKnowledge.run("oc-a", null, "{}");
      contact("cc-a", "oc-a", "a@example.no");
      thread("th-a", "cc-a");
      msg("m-a-out", "th-a", "out", "2026-10-29T08:00:00.000Z", "2026-10-29 08:00:00", "sent");
      // Inbound with sent_at NULL: falls back to received_at (datetime('now') format).
      // Sender differs from crm_contacts.email only in case/padding — still the contact.
      msg("m-a-in", "th-a", "in", null, "2026-10-29 10:00:00", "sent", "  A@Example.NO ");
      // Our confirmation reply AFTER the «ja» — must not void the consent.
      msg("m-a-out2", "th-a", "out", "2026-10-29T11:00:00.000Z", "2026-10-29 11:00:00", "sent");
      // The no-earlier-outbound cases below each get their OWN contact of oc-a:
      // since S2e-2 any sent outbound to the same contact (in any thread)
      // counts, so sharing cc-a would let th-a/th-a5's outbound validate them.
      // Inbound that came BEFORE any outbound to its contact.
      contact("cc-a2", "oc-a", "a2@example.no");
      thread("th-a2", "cc-a2");
      msg("m-a2-in", "th-a2", "in", "2026-10-28T09:00:00.000Z", "2026-10-28 09:00:00", "sent");
      msg("m-a2-out", "th-a2", "out", "2026-10-28T12:00:00.000Z", "2026-10-28 12:00:00", "sent");
      // Inbound whose only earlier outbound was never delivered (failed).
      contact("cc-a3", "oc-a", "a3@example.no");
      thread("th-a3", "cc-a3");
      msg("m-a3-out", "th-a3", "out", null, "2026-10-27 08:00:00", "failed");
      msg("m-a3-in", "th-a3", "in", "2026-10-27T09:00:00.000Z", "2026-10-27 09:00:00", "sent");

      // Only message before the inbound reply is another INBOUND (no outbound).
      contact("cc-a4", "oc-a", "a4@example.no");
      thread("th-a4", "cc-a4");
      msg("m-a4-in1", "th-a4", "in", "2026-10-26T08:00:00.000Z", "2026-10-26 08:00:00", "sent");
      msg("m-a4-in2", "th-a4", "in", "2026-10-26T09:00:00.000Z", "2026-10-26 09:00:00", "sent");
      // Right thread, after our notice, but from a CC'd third party.
      thread("th-a5", "cc-a");
      msg("m-a5-out", "th-a5", "out", "2026-10-25T08:00:00.000Z", "2026-10-25 08:00:00", "sent");
      msg("m-a5-in", "th-a5", "in", "2026-10-25T09:00:00.000Z", "2026-10-25 09:00:00", "sent", "naboen@example.no");
      // Inbound with EXACTLY the same timestamp as the only sent outbound.
      contact("cc-a6", "oc-a", "a6@example.no");
      thread("th-a6", "cc-a6");
      msg("m-a6-out", "th-a6", "out", "2026-10-24T08:00:00.000Z", "2026-10-24 08:00:00", "sent");
      msg("m-a6-in", "th-a6", "in", "2026-10-24T08:00:00.000Z", "2026-10-24 08:00:00", "sent");

      // Another owner-locked producer, with its own valid reply.
      insertAgent.run("oc-b", "Gård B", OLD_DESC, "k-oc-b", CLAIMED);
      insertKnowledge.run("oc-b", null, "{}");
      contact("cc-b", "oc-b", "b@example.no");
      thread("th-b", "cc-b");
      msg("m-b-out", "th-b", "out", "2026-10-29T08:00:00.000Z", "2026-10-29 08:00:00", "sent");
      msg("m-b-in", "th-b", "in", "2026-10-29T09:00:00.000Z", "2026-10-29 09:00:00", "sent");

      // Owner-locked producer whose description is curated by the owner.
      insertAgent.run("oc-cur", "Gård Kuratert", OLD_DESC, "k-oc-cur", CLAIMED);
      insertKnowledge.run("oc-cur", null, JSON.stringify({ description: { by: "owner" } }));
      contact("cc-cur", "oc-cur", "cur@example.no");
      thread("th-cur", "cc-cur");
      msg("m-cur-out", "th-cur", "out", "2026-10-29T08:00:00.000Z", "2026-10-29 08:00:00", "sent");
      msg("m-cur-in", "th-cur", "in", "2026-10-29T09:00:00.000Z", "2026-10-29 09:00:00", "sent");

      // ── S2e-2 fixtures: owner-locked oc-c, consent across threads per contact ──
      insertAgent.run("oc-c", "Gård C", OLD_DESC, "k-oc-c", CLAIMED);
      insertKnowledge.run("oc-c", null, "{}");
      contact("cc-c", "oc-c", "c@example.no");
      // Our notice in one thread (ISO sent_at) ...
      thread("th-c1", "cc-c");
      msg("m-c-out", "th-c1", "out", "2026-10-20T08:00:00.000Z", "2026-10-20 08:00:00", "sent");
      // ... a failed outbound later (must not be picked as the basis) ...
      msg("m-c-out-failed", "th-c1", "out", null, "2026-10-21 07:00:00", "failed");
      // ... and the reply imported as a NEW thread, sent_at NULL (SQLite format).
      thread("th-c2", "cc-c");
      msg("m-c-in", "th-c2", "in", null, "2026-10-21 09:00:00", "sent");
      // Another contact of the SAME agent, never written to: our outbound to cc-c does not count.
      contact("cc-d", "oc-c", "d@example.no");
      thread("th-d", "cc-d");
      msg("m-d-in", "th-d", "in", "2026-10-21T10:00:00.000Z", "2026-10-21 10:00:00", "sent");
      // Outbound older than 30 days (SQLite format) vs reply in ISO «Z» format.
      contact("cc-e", "oc-c", "e@example.no");
      thread("th-e1", "cc-e");
      msg("m-e-out", "th-e1", "out", null, "2026-09-01 08:00:00", "sent");
      thread("th-e2", "cc-e");
      msg("m-e-in", "th-e2", "in", "2026-10-01T08:00:01Z", "2026-10-01 08:00:01", "sent");
      // Exactly 30 days, mixed formats (ISO outbound, SQLite-format reply) -> still valid.
      contact("cc-f", "oc-c", "f@example.no");
      thread("th-f1", "cc-f");
      msg("m-f-out", "th-f1", "out", "2026-09-01T08:00:00.000Z", "2026-09-01 08:00:00", "sent");
      thread("th-f2", "cc-f");
      msg("m-f-in", "th-f2", "in", null, "2026-10-01 08:00:00", "sent");
      // Our only outbound to the contact was sent AFTER the reply (other thread).
      contact("cc-g", "oc-c", "g@example.no");
      thread("th-g1", "cc-g");
      msg("m-g-in", "th-g1", "in", "2026-10-21T09:00:00.000Z", "2026-10-21 09:00:00", "sent");
      thread("th-g2", "cc-g");
      msg("m-g-out", "th-g2", "out", "2026-10-22T09:00:00.000Z", "2026-10-22 09:00:00", "sent");
      // Owner-locked producer with no outbound at all to anyone.
      insertAgent.run("oc-h", "Gård H", OLD_DESC, "k-oc-h", CLAIMED);
      insertKnowledge.run("oc-h", null, "{}");
      contact("cc-h", "oc-h", "h@example.no");
      thread("th-h", "cc-h");
      msg("m-h-in", "th-h", "in", "2026-10-21T09:00:00.000Z", "2026-10-21 09:00:00", "sent");

      // NOT owner-locked producer.
      insertAgent.run("oc-open", "Gård Åpen", OLD_DESC, "k-oc-open", null);
      insertKnowledge.run("oc-open", null, "{}");

      delete require.cache[require.resolve("./admin-agents-content-correction")];
      const routeMod = require("./admin-agents-content-correction");
      const router = routeMod.default;
      routeMod.__setContentCorrectionDbForTesting(db as any);

      const REASON = "Fjerner udokumentert «økologisk» etter eiers «ja» (okologi S2e)";
      const post = (items: any[], apply = false) =>
        callRoute(router, { headers: { "x-admin-key": testKey }, body: { reason: REASON, items }, query: apply ? { apply: "1" } : {} });
      const item = (agent_id: string, crm_message_id?: unknown, extra: Record<string, unknown> = {}) => ({
        agent_id,
        field: "description",
        text: NEW_DESC,
        ...(crm_message_id === undefined ? {} : { owner_consent: { crm_message_id } }),
        ...extra,
      });
      const descOf = (id: string) => (db.prepare(`SELECT description FROM agents WHERE id = ?`).get(id) as any)?.description ?? null;
      const auditFor = (id: string) =>
        db.prepare(`SELECT field_name, old_value, new_value, changed_by, notes FROM agent_knowledge_audit WHERE agent_id = ?`).all(id) as any[];
      const consentActions = () =>
        db.prepare(`SELECT thread_id, contact_id, type, actor, payload FROM crm_actions WHERE type = 'owner_consent_applied'`).all() as any[];
      const first = (r: RouteResult) => r.body?.results?.[0];

      // ── No consent: unchanged behaviour ──
      let r = await post([item("oc-a")], true);
      assertEq(first(r)?.outcome, "skipped_claimed", "oc-01: owner-locked without owner_consent -> skipped_claimed");
      assertEq(descOf("oc-a"), OLD_DESC, "oc-02: nothing written");
      assertEq(first(r)?.detail, undefined, "oc-03: no detail added to the plain skipped_claimed result");

      // ── Malformed consent shape -> invalid_item at parse time ──
      r = await post([
        item("oc-a", ""),
        item("oc-a", 42),
        item("oc-a", "x".repeat(201)),
        { agent_id: "oc-a", field: "description", text: NEW_DESC, owner_consent: "m-a-in" },
        { agent_id: "oc-a", field: "description", text: NEW_DESC, owner_consent: ["m-a-in"] },
      ], true);
      assertEq(r.status, 200, "oc-04: malformed consent reported per-item");
      assertEq(r.body?.counts?.invalid_item, 5, "oc-05: empty / non-string / over-long id and non-object shapes are invalid_item");
      assertEq(descOf("oc-a"), OLD_DESC, "oc-06: nothing written");

      // ── Invalid consent cases (apply) ──
      // Each case pins WHICH check rejects it (exact detail), so removing any
      // one check is caught even when a later check would also reject.
      const NOT_FOUND = "owner_consent: crm message not found";
      const NOT_IN = "owner_consent: crm message is not inbound";
      const OTHER_AGENT = "owner_consent: crm message's contact does not belong to this agent";
      const NOT_SENDER = "owner_consent: sender is not the profile's contact";
      const NO_EARLIER = "owner_consent: no sent outbound message to this contact in the 30 days before the reply — not a reply to our notice";
      const invalidCases: Array<[string, string, string, string]> = [
        ["m-b-in", "oc-07", "message from another agent's contact", OTHER_AGENT],
        // m-a-out2 HAS an earlier sent outbound in th-a — the direction check is what rejects it.
        ["m-a-out2", "oc-08", "an outbound message", NOT_IN],
        ["m-a2-in", "oc-09", "inbound with no earlier outbound to its contact", NO_EARLIER],
        ["m-a3-in", "oc-10", "inbound whose only earlier outbound failed to send", NO_EARLIER],
        ["does-not-exist", "oc-11", "nonexistent message id", NOT_FOUND],
        ["m-a4-in2", "oc-11x", "inbound whose only earlier message is another inbound", NO_EARLIER],
        ["m-a5-in", "oc-11y", "inbound on the right thread from a different address (CC'd third party)", NOT_SENDER],
        ["m-a6-in", "oc-11z", "inbound with exactly the same timestamp as the only sent outbound (strictly earlier required)", NO_EARLIER],
      ];
      for (const [msgId, label, what, detail] of invalidCases) {
        r = await post([item("oc-a", msgId)], true);
        assertEq(first(r)?.outcome, "invalid_consent", `${label}: ${what} -> invalid_consent`);
        assertEq(first(r)?.detail, detail, `${label}b: rejected by the right check`);
      }
      assertEq(descOf("oc-a"), OLD_DESC, "oc-12: no invalid consent wrote anything");
      assertEq(auditFor("oc-a").length, 0, "oc-13: no audit rows");
      assertEq(consentActions().length, 0, "oc-14: no crm_actions rows");

      // Invalid consent shows in dry-run too.
      r = await post([item("oc-a", "m-b-in")]);
      assertEq(first(r)?.outcome, "invalid_consent", "oc-15: dry-run reports invalid_consent");

      // ── Valid consent, dry-run: reported, nothing written ──
      r = await post([item("oc-a", "m-a-in")]);
      assertEq(r.body?.dry_run, true, "oc-16: dry-run by default");
      assertEq(first(r)?.outcome, "would_write_with_owner_consent", "oc-17: dry-run -> would_write_with_owner_consent");
      assertEq(r.body?.counts?.would_write_with_owner_consent, 1, "oc-18: counted under its own key");
      assertEq(descOf("oc-a"), OLD_DESC, "oc-19: dry-run wrote nothing");
      assertEq(auditFor("oc-a").length, 0, "oc-20: dry-run audited nothing");
      assertEq(consentActions().length, 0, "oc-21: dry-run inserted no crm_actions row");

      // ── Valid consent on a curated field -> skipped_curated ──
      r = await post([item("oc-cur", "m-cur-in")], true);
      assertEq(first(r)?.outcome, "skipped_curated", "oc-22: consent bypasses the owner lock only — curated field still skipped_curated");
      assertEq(descOf("oc-cur"), OLD_DESC, "oc-23: curated row untouched");
      assertEq(auditFor("oc-cur").length, 0, "oc-24: no audit on curated row");
      assertEq(consentActions().length, 0, "oc-25: no crm_actions on curated row");

      // ── Junk guard still applies with consent ──
      r = await post([{ ...item("oc-a", "m-a-in"), text: "Importert fra Hanen-medlemslisten — venter på verifisering" }], true);
      assertEq(first(r)?.outcome, "refused_junk_text", "oc-26: junk gate still applies with consent");

      // ── Valid consent + apply ──
      r = await post([item("oc-a", "m-a-in")], true);
      assertEq(r.body?.dry_run, false, "oc-27: apply=1");
      assertEq(first(r)?.outcome, "written_with_owner_consent", "oc-28: apply -> written_with_owner_consent (later confirmation outbound does not void it)");
      assertEq(r.body?.counts?.written_with_owner_consent, 1, "oc-29: counted under its own key");
      assertEq(descOf("oc-a"), NEW_DESC, "oc-30: field written");
      const audit = auditFor("oc-a");
      assertEq(audit.length, 1, "oc-31: one audit row");
      assertEq(audit[0]?.changed_by, "admin", "oc-32: changed_by=admin");
      assertEq(audit[0]?.old_value, OLD_DESC, "oc-33: full old value kept");
      assertTrue(
        new RegExp(`^content-correction-\\d{8}-\\d{6}: ${REASON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} · owner_consent=m-a-in$`).test(audit[0]?.notes ?? ""),
        "oc-34: audit notes = `${batchTag}: ${reason} · owner_consent=<id>`",
      );
      const acts = consentActions();
      assertEq(acts.length, 1, "oc-35: one crm_actions row");
      assertEq([acts[0]?.thread_id, acts[0]?.contact_id, acts[0]?.actor], ["th-a", "cc-a", "system"], "oc-36: crm_actions on the message's thread/contact, actor=system");
      const payload = JSON.parse(acts[0]?.payload ?? "{}");
      assertEq(
        [payload.agent_id, payload.field, payload.crm_message_id, payload.basis_outbound_message_id, payload.batch_tag],
        ["oc-a", "description", "m-a-in", "m-a-out", r.body?.batch_tag],
        "oc-37: crm_actions payload {agent_id, field, crm_message_id, basis_outbound_message_id (latest earlier sent outbound), batch_tag}",
      );

      // Re-apply: unchanged, nothing new.
      r = await post([item("oc-a", "m-a-in")], true);
      assertEq(first(r)?.outcome, "skipped_unchanged", "oc-38: re-apply -> skipped_unchanged");
      assertEq(consentActions().length, 1, "oc-39: no second crm_actions row");

      // ── Not owner-locked: consent ignored, normal outcome ──
      r = await post([item("oc-open", "m-b-in")], true);
      assertEq(first(r)?.outcome, "written", "oc-40: unlocked row with (even foreign) consent -> plain written, consent not checked or claimed");
      assertEq(descOf("oc-open"), NEW_DESC, "oc-41: written");
      assertTrue(!/owner_consent/.test(auditFor("oc-open")[0]?.notes ?? ""), "oc-42: no owner_consent suffix in audit");
      assertEq(consentActions().length, 1, "oc-43: no crm_actions row for the unlocked write");

      // ── S2e-2: consent across threads with the same contact ──
      const s2Invalid: Array<[string, string, string, string]> = [
        ["oc-c", "m-d-in", "oc-50", "outbound only to ANOTHER contact of the same agent"],
        ["oc-c", "m-e-in", "oc-51", "only outbound to the contact is older than 30 days (mixed formats)"],
        ["oc-c", "m-g-in", "oc-52", "only outbound to the contact was sent AFTER the reply (other thread)"],
        ["oc-h", "m-h-in", "oc-53", "no outbound at all"],
      ];
      for (const [agentId, msgId, label, what] of s2Invalid) {
        r = await post([item(agentId, msgId)], true);
        assertEq(first(r)?.outcome, "invalid_consent", `${label}: ${what} -> invalid_consent`);
        assertEq(first(r)?.detail, NO_EARLIER, `${label}b: rejected by the outbound-to-contact check`);
      }
      assertEq([descOf("oc-c"), descOf("oc-h")], [OLD_DESC, OLD_DESC], "oc-54: no S2e-2 invalid consent wrote anything");
      assertEq(consentActions().length, 1, "oc-55: no crm_actions rows from invalid S2e-2 consents");

      // Exactly 30 days (inclusive), ISO outbound vs SQLite-format reply -> valid (dry-run).
      r = await post([item("oc-c", "m-f-in")]);
      assertEq(first(r)?.outcome, "would_write_with_owner_consent", "oc-56: outbound exactly 30 days before the reply, mixed formats -> valid");

      // Reply imported as a NEW thread with the same contact -> valid; apply.
      r = await post([item("oc-c", "m-c-in")]);
      assertEq(first(r)?.outcome, "would_write_with_owner_consent", "oc-57: reply in a new thread after our notice to the same contact -> valid (dry-run)");
      assertEq(descOf("oc-c"), OLD_DESC, "oc-58: dry-run wrote nothing");
      r = await post([item("oc-c", "m-c-in")], true);
      assertEq(first(r)?.outcome, "written_with_owner_consent", "oc-59: apply -> written_with_owner_consent");
      assertEq(descOf("oc-c"), NEW_DESC, "oc-60: field written");
      const actsC = consentActions().filter((a) => JSON.parse(a.payload ?? "{}").agent_id === "oc-c");
      assertEq(actsC.length, 1, "oc-61: one crm_actions row for oc-c");
      assertEq([actsC[0]?.thread_id, actsC[0]?.contact_id], ["th-c2", "cc-c"], "oc-62: crm_actions on the REPLY's thread (not the notice's)");
      const payloadC = JSON.parse(actsC[0]?.payload ?? "{}");
      assertEq(
        [payloadC.crm_message_id, payloadC.basis_outbound_message_id],
        ["m-c-in", "m-c-out"],
        "oc-63: basis_outbound_message_id = the sent notice in the other thread (failed outbound ignored)",
      );
    } finally {
      try { require("./admin-agents-content-correction").__setContentCorrectionDbForTesting(null); } catch { /* ignore */ }
      try { db.close(); } catch { /* ignore */ }
      if (setKeyOurselves) delete process.env.ADMIN_KEY;
    }
    return { passed, failed, failures };
  })();
}
