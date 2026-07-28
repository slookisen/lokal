/**
 * crm-vertical.test.ts — dev-request
 * 2026-07-27-crm-plattformadskillelse-opplevagent, steg 1 + steg 2.
 *
 * Daniel, 2026-07-27:
 *   «Det er ekstremt viktig at rfb og opplevagent.no håndteres hver for seg og
 *    vi ikke begynner å blande henvendelser fra hver av plattformene.»
 *
 * The mixing had ALREADY happened when this was written. `vertical_id` existed
 * on every CRM table with `DEFAULT 'rfb'`, and the READ side already filtered on
 * it — but not one of the five INSERT statements set it. So every row in the
 * CRM was tagged `rfb`, Opplevagent enquiries included, and no query could tell
 * them apart. This suite pins the two halves of the fix:
 *
 *   cv1-cv6    assertVertical is FAIL-CLOSED. Missing, empty, unknown, null,
 *              and case-variant values all throw. There is deliberately no
 *              default parameter: a silent default to 'rfb' is the exact
 *              mechanism that caused the damage, so a guard that falls back is
 *              worse than no guard at all — it looks like protection.
 *   cv7-cv12   All five write paths stamp vertical_id. One test per INSERT,
 *              asserting on the ROW IN THE DATABASE rather than on a return
 *              value, because a return value can be right while the write is
 *              wrong (that is how #370's tests passed while producers still
 *              rendered as Oslo).
 *   cv13-cv17  Steg 2 — «adskilte kontakter». The same address on two
 *              platforms is two contacts, each resolvable independently, and
 *              the composite UNIQUE index is what makes that representable.
 *              Under the old UNIQUE(email) the second INSERT threw.
 *   cv18-cv20  The migration itself: the old index is gone, the new one exists
 *              and is UNIQUE, and it still blocks a true duplicate (same email
 *              AND same vertical). A migration that drops a uniqueness
 *              constraint without replacing it is a silent data-quality
 *              regression, so "the new index exists" is not enough — it has to
 *              still reject.
 *
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/services/crm-vertical.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runCrmVerticalTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      actual === expected,
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }
  /** Asserts the call throws AND that the message names the offending value. */
  function assertThrows(fn: () => unknown, label: string): void {
    try { fn(); assertTrue(false, `${label} — expected a throw, got a return`); }
    catch { assertTrue(true, label); }
  }

  return (async () => {
    const prevDb = initMod.__peekDbForTesting();
    const db = new Database(":memory:");
    const crm = require("./crm-service") as typeof import("./crm-service");

    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      // ═══════════════════════════════════════════════════════════════
      // cv1-cv6 — FAIL-CLOSED.
      //
      // Every one of these inputs would, under the pre-fix code, have been
      // written as 'rfb' by the column default without anyone noticing.
      // ═══════════════════════════════════════════════════════════════
      assertEq(crm.assertVertical("rfb", "t"), "rfb", "cv1: a valid vertical passes through unchanged");
      assertEq(crm.assertVertical("experiences", "t"), "experiences", "cv1b: …including the one this whole change exists for");
      assertThrows(() => crm.assertVertical(undefined, "t"), "cv2: undefined throws — the commonest way a caller forgets");
      assertThrows(() => crm.assertVertical("", "t"), "cv3: empty string throws");
      assertThrows(() => crm.assertVertical("opplevagent", "t"), "cv4: a PLAUSIBLE but wrong value throws — this is the one a human would type");
      assertThrows(() => crm.assertVertical(null, "t"), "cv5: null throws");
      assertThrows(() => crm.assertVertical("RFB", "t"), "cv6: case variants throw rather than being normalised — SQL comparison is case-sensitive, so accepting 'RFB' here would write a value no read query can find");

      // The message must name the bad value. A guard that throws
      // `Error: invalid` sends whoever is on call reading source instead of logs.
      {
        let msg = "";
        try { crm.assertVertical("opplevagent", "ingestThread"); } catch (e: any) { msg = String(e?.message ?? ""); }
        assertTrue(msg.includes("opplevagent") && msg.includes("ingestThread"),
          "cv6b: the error names BOTH the rejected value and the call site");
      }

      // ═══════════════════════════════════════════════════════════════
      // cv7-cv12 — every write path stamps vertical_id.
      //
      // Asserted against the DATABASE ROW, never a return value.
      // ═══════════════════════════════════════════════════════════════
      {
        const r = crm.crmService.resolveContact("post@opplevagent-test.no", "Testy", "experiences");
        const row = db.prepare("SELECT vertical_id, email FROM crm_contacts WHERE id = ?").get(r.id) as any;
        assertEq(row?.vertical_id, "experiences", "cv7: resolveContact writes vertical_id on crm_contacts");
      }
      assertThrows(
        () => (crm.crmService as any).resolveContact("x@y.no", null, undefined),
        "cv8: resolveContact with no vertical throws instead of creating an 'rfb' contact");

      {
        crm.crmService.ingestThread(
          {
            threadId: "cv-thread-1",
            subject: "Booking av gårdsbesøk",
            messages: [{
              messageId: "cv-msg-1",
              direction: "in",
              fromEmail: "gjest@example.no",
              sentAt: "2026-07-28T10:00:00Z",
            }],
          },
          "gjest@example.no",
          "experiences",
        );
        const t = db.prepare("SELECT vertical_id FROM crm_threads WHERE id = 'cv-thread-1'").get() as any;
        const m = db.prepare("SELECT vertical_id FROM crm_messages WHERE id = 'cv-msg-1'").get() as any;
        const c = db.prepare("SELECT vertical_id FROM crm_contacts WHERE email = 'gjest@example.no'").get() as any;
        assertEq(t?.vertical_id, "experiences", "cv9: ingestThread stamps crm_threads");
        assertEq(m?.vertical_id, "experiences", "cv10: …and crm_messages");
        assertEq(c?.vertical_id, "experiences", "cv10b: …and the contact it resolved on the way");
      }

      {
        const r = crm.crmService.composeNewThread({
          toEmail: "produsent@example.no",
          subject: "Hei",
          bodyText: "Test",
          createdBy: "daniel",
          vertical: "experiences",
        });
        const t = db.prepare("SELECT vertical_id FROM crm_threads WHERE id = ?").get(r.threadId) as any;
        const m = db.prepare("SELECT vertical_id FROM crm_messages WHERE id = ?").get(r.messageId) as any;
        assertEq(t?.vertical_id, "experiences", "cv11: composeNewThread stamps the thread");
        assertEq(m?.vertical_id, "experiences", "cv11b: …and the outbound message it records");
      }

      {
        const o = crm.crmService.enqueueOutbox({
          intent: "resend_send",
          toEmails: ["mottaker@example.no"],
          subject: "Emne",
          bodyText: "Tekst",
          createdBy: "daniel",
          vertical: "experiences",
        });
        const row = db.prepare("SELECT vertical_id FROM crm_outbox WHERE id = ?").get(o.id) as any;
        assertEq(row?.vertical_id, "experiences", "cv12: enqueueOutbox stamps crm_outbox");
      }
      assertThrows(
        () => (crm.crmService as any).enqueueOutbox({
          intent: "resend_send", toEmails: ["a@b.no"], subject: "s", bodyText: "b", createdBy: "daniel",
        }),
        "cv12b: enqueueOutbox with no vertical throws — an outbound send is the one place a wrong platform reaches a real person");

      // ═══════════════════════════════════════════════════════════════
      // cv13-cv17 — steg 2, «adskilte kontakter» (Daniels valg A).
      //
      // Under the old UNIQUE(email) the second resolveContact below threw a
      // constraint error, so this scenario could not be represented AT ALL.
      // ═══════════════════════════════════════════════════════════════
      {
        const SHARED = "bonde@begge-steder.no";
        const a = crm.crmService.resolveContact(SHARED, "Bonden", "rfb");
        const b = crm.crmService.resolveContact(SHARED, "Bonden", "experiences");
        assertTrue(a.created, "cv13: first platform creates the contact");
        assertTrue(b.created, "cv14: the SAME address on the OTHER platform creates a SECOND contact — not a reused one");
        assertTrue(a.id !== b.id, "cv15: …and they are genuinely distinct rows");

        const again = crm.crmService.resolveContact(SHARED, null, "rfb");
        assertEq(again.id, a.id, "cv16: resolving again on rfb finds the rfb one, not the experiences one");
        assertTrue(!again.created, "cv16b: …and does not create a third");

        const rows = db.prepare("SELECT vertical_id FROM crm_contacts WHERE email = ? ORDER BY vertical_id").all(SHARED) as any[];
        assertEq(rows.map((r) => r.vertical_id).join(","), "experiences,rfb",
          "cv17: exactly two rows exist, one per platform");
      }

      // ═══════════════════════════════════════════════════════════════
      // cv18-cv20 — the migration.
      //
      // "The new index exists" is not the property that matters; "it still
      // rejects a real duplicate" is. A migration that widened uniqueness into
      // uselessness would pass a mere existence check.
      // ═══════════════════════════════════════════════════════════════
      {
        const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='crm_contacts'`).all() as any[];
        const names = idx.map((r) => r.name);
        assertTrue(!names.includes("idx_crm_contacts_email_unique"),
          "cv18: the old UNIQUE(email) index is gone — while it exists, two-platform contacts are impossible");
        assertTrue(names.includes("idx_crm_contacts_email_vertical_unique"),
          "cv19: the composite UNIQUE(email, vertical_id) index exists");

        // Same email AND same vertical must still be refused.
        let threw = false;
        try {
          db.prepare(`INSERT INTO crm_contacts (id, type, email, vertical_id) VALUES ('dup-1','unknown','bonde@begge-steder.no','rfb')`).run();
        } catch { threw = true; }
        assertTrue(threw,
          "cv20: a TRUE duplicate (same email, same platform) is still rejected — the migration relaxed uniqueness, it did not remove it");
      }
    } finally {
      try { db.close(); } catch { /* already closed */ }
      initMod.__setDbForTesting(prevDb as any);
    }

    if (log) console.log(`\n${passed} passed, ${failed} failed`);
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runCrmVerticalTests({ log: true }).then((s) => {
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
