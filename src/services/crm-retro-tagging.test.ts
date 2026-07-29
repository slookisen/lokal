/**
 * crm-retro-tagging.test.ts — dev-request
 * 2026-07-27-crm-plattformadskillelse-opplevagent, steg 5.
 *
 *   «Dry-run default … Apply krever Daniels godkjenning av tallet …
 *    Audit + reverserbart per rad/batch. ALDRI en blind UPDATE på historikk.»
 *
 * This is the only step in the dev-request that writes to HISTORY, where a wrong
 * value is indistinguishable from a right one forever after — nobody re-reads a
 * two-month-old mail to check which platform it arrived on. So the tests are
 * organised around the ways a retro-tag could be wrong and still look fine:
 *
 *   rt1-rt10    EVIDENCE, not inference. A thread moves only on something the
 *               system recorded at the time. Subject text, body text and the
 *               sender's domain must NOT move anything, however suggestive.
 *   rt11-rt16   Tier A (the form recorded the platform) outranks Tier B (a
 *               recipient header), and an unknown-but-present platform is not
 *               evidence at all.
 *   rt17-rt22   Retro-tagging AGREES with live routing by construction — it
 *               calls the same deriveVertical. If they could disagree, a
 *               re-tagged thread would later 409 against the live path.
 *   rt23-rt31   The approval gate. Fingerprint AND count must both match, and
 *               the fingerprint must actually change when the plan changes —
 *               otherwise the gate is a ceremony.
 *   rt32-rt40   Apply moves thread + messages + contact TOGETHER, and the audit
 *               row is written BEFORE the update.
 *   rt41-rt48   Revert restores the contact_id too, is idempotent, and does not
 *               drag back messages that arrived after the batch.
 *
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/services/crm-retro-tagging.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runCrmRetroTaggingTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
  function assertThrows(fn: () => unknown, expect: RegExp, label: string): void {
    try {
      fn();
      assertTrue(false, `${label} — expected a throw, got a return`);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      assertTrue(expect.test(msg), `${label} (message ${JSON.stringify(msg)} must match ${expect})`);
    }
  }

  return (async () => {
    const prevDb = initMod.__peekDbForTesting();
    const db = new Database(":memory:");
    const retro = require("./crm-retro-tagging") as typeof import("./crm-retro-tagging");
    const crm = require("./crm-service") as typeof import("./crm-service");

    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const OPPLEV = "kontakt@opplevagent.no";
      const RFB = "kontakt@rettfrabonden.com";

      // ── Fixture helper: a thread as production actually holds it, i.e.
      //    everything stamped 'rfb' regardless of where it really came from.
      let seq = 0;
      const mkThread = (o: {
        email: string;
        subject?: string;
        toEmails?: string[];
        ccEmails?: string[];
        rawMetadata?: any;
        formPlatform?: string | null;
        bodyText?: string;
      }): { threadId: string; contactId: string; messageId: string } => {
        seq++;
        const tid = `rt-thread-${seq}`;
        const mid = `rt-msg-${seq}`;
        const contact = crm.crmService.resolveContact(o.email, null, "rfb");
        db.prepare(
          `INSERT INTO crm_threads (id, contact_id, subject, category, severity, vertical_id)
           VALUES (?,?,?,'innkommende','normal','rfb')`,
        ).run(tid, contact.id, o.subject ?? `Emne ${seq}`);
        db.prepare(
          `INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, cc_emails,
             subject, body_text, snippet, sent_at, raw_metadata, vertical_id)
           VALUES (?,?,'in',?,?,?,?,?,?,datetime('now'),?, 'rfb')`,
        ).run(
          mid, tid, o.email,
          JSON.stringify(o.toEmails ?? [RFB]),
          JSON.stringify(o.ccEmails ?? []),
          o.subject ?? `Emne ${seq}`,
          o.bodyText ?? "Hei",
          "utdrag",
          JSON.stringify(o.rawMetadata ?? {}),
        );
        if (o.formPlatform !== undefined && o.formPlatform !== null) {
          db.prepare(
            `INSERT INTO crm_actions (id, thread_id, contact_id, type, actor, payload)
             VALUES (?,?,?, 'imported','system', ?)`,
          ).run(
            `rt-act-${seq}`, tid, contact.id,
            JSON.stringify({ source: "kontaktskjema", platform: o.formPlatform, name: "Tester" }),
          );
        }
        return { threadId: tid, contactId: contact.id, messageId: mid };
      };

      const findCandidate = (plan: retroPlanT, threadId: string) =>
        plan.candidates.find((c) => c.threadId === threadId);
      type retroPlanT = ReturnType<typeof retro.planRetroTagging>;

      // ═══════════════════════════════════════════════════════════════
      // rt1-rt10 — EVIDENCE, not inference.
      //
      // Each "suggestive" fixture below is one a classifier would happily move.
      // None of them may move, because none of them is something the system
      // recorded — they are things a reader might infer.
      // ═══════════════════════════════════════════════════════════════
      const tempting = [
        mkThread({ email: "a@example.no", subject: "Booking av opplevelse på Opplevagent" }),
        mkThread({ email: "b@example.no", subject: "Spørsmål", bodyText: "Jeg fant dere på opplevagent.no" }),
        mkThread({ email: "c@opplevagent.no", subject: "Hei fra oss" }),
        mkThread({ email: "d@example.no", subject: "gårdsbesøk", rawMetadata: { note: "opplevagent" } }),
      ];
      {
        const plan = retro.planRetroTagging();
        assertEq(plan.candidates.length, 0,
          "rt1: a subject naming Opplevagent, a BODY naming opplevagent.no, an opplevagent.no SENDER and a stray metadata string move NOTHING — all four are inference, and this writes to history");
        // These four are addressed to kontakt@rettfrabonden.com, which is real
        // tier-B evidence FOR 'rfb' — so they are "already correct", not
        // "undecidable". The first version of this assertion expected
        // undecidable=4 and failed, which is how the missing third bucket was
        // found: without it ~1400 prod threads would vanish from the report.
        assertEq(plan.alreadyCorrect, tempting.length,
          "rt2: …they are counted as ALREADY CORRECT (their headers name the rfb alias), not silently dropped");
        assertEq(
          plan.candidates.length + plan.alreadyCorrect + plan.undecidable, plan.scanned,
          "rt2b: candidates + alreadyCorrect + undecidable === scanned. The report must account for EVERY row it looked at — a bucket that swallows rows is how ~1400 threads would go missing from the number Daniel approves against");
        assertEq(plan.scanned, tempting.length, "rt3: every thread was scanned");
        for (const t of tempting) {
          const row = db.prepare("SELECT vertical_id FROM crm_threads WHERE id = ?").get(t.threadId) as any;
          assertEq(row?.vertical_id, "rfb", `rt4-${t.threadId}: …and the row is untouched — planning is READ-ONLY`);
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // rt11-rt16 — Tier A and Tier B, and what is NOT evidence.
      // ═══════════════════════════════════════════════════════════════
      const tierA = mkThread({ email: "form@example.no", subject: "KONTAKT-A", formPlatform: "experiences" });
      const tierB = mkThread({ email: "hdr@example.no", subject: "HEADER-B", toEmails: [OPPLEV] });
      const badPlatform = mkThread({ email: "bad@example.no", subject: "KONTAKT-UGYLDIG", formPlatform: "opplevagent" });
      const alreadyRight = mkThread({ email: "ok@example.no", subject: "ALLEREDE", toEmails: [RFB], formPlatform: "rfb" });
      {
        const plan = retro.planRetroTagging();

        const a = findCandidate(plan, tierA.threadId);
        assertTrue(!!a, "rt11: a thread whose FORM recorded platform=experiences is a candidate");
        assertEq(a?.proposedVertical, "experiences", "rt11b: …proposed as experiences");
        assertEq(a?.tier, "A_form_recorded_platform", "rt12: …at tier A, because that is a value we WROTE DOWN and then ignored, not something inferred");
        assertTrue(!!a && a.evidence.includes("kontaktskjema"), "rt12b: …with quotable evidence naming the source");

        const b = findCandidate(plan, tierB.threadId);
        assertTrue(!!b, "rt13: a thread whose recipient header names the opplevagent alias is a candidate");
        assertEq(b?.tier, "B_recipient_header", "rt13b: …at tier B");
        assertEq(b?.proposedVertical, "experiences", "rt13c: …proposed as experiences");

        assertEq(findCandidate(plan, badPlatform.threadId), undefined,
          "rt14: a form that recorded platform='opplevagent' — PRESENT but not a valid vertical — is NOT evidence. Same fail-open hole steg 4 closed on the live route; it must not reopen as a retro-guess");
        assertEq(findCandidate(plan, alreadyRight.threadId), undefined,
          "rt15: a thread already on its correct platform is not a candidate…");
        assertEq(
          plan.candidates.length + plan.alreadyCorrect + plan.undecidable, plan.scanned,
          "rt16: …and the three buckets still account for every scanned row, now that tier-A/B fixtures are in the mix too");
      }

      // Tier A must OUTRANK tier B when they disagree: the form knew the
      // platform directly; a header is us reading a routing artefact.
      const conflict = mkThread({
        email: "both@example.no", subject: "BEGGE", toEmails: [OPPLEV], formPlatform: "dental",
      });
      {
        const plan = retro.planRetroTagging();
        const c = findCandidate(plan, conflict.threadId);
        assertEq(c?.proposedVertical, "dental",
          "rt16b: when the form says dental and the header says experiences, the FORM wins — a recorded platform outranks an inferred one");
        assertEq(c?.tier, "A_form_recorded_platform", "rt16c: …and the tier reports which source actually decided");
      }

      // ═══════════════════════════════════════════════════════════════
      // rt17-rt22 — retro-tagging and live routing cannot disagree.
      //
      // Tier B calls the SAME crm-triage.deriveVertical the live ingest path
      // uses. If it did not, a retro-tagged thread would later be refused by
      // the B4 409 when the CS agent re-ingested it with the same headers.
      // ═══════════════════════════════════════════════════════════════
      {
        const triage = require("./crm-triage") as typeof import("./crm-triage");
        const ambiguous = mkThread({ email: "amb@example.no", subject: "TVETYDIG", toEmails: [RFB], ccEmails: [OPPLEV] });
        const plan = retro.planRetroTagging();
        assertEq(findCandidate(plan, ambiguous.threadId), undefined,
          "rt17: a thread naming BOTH aliases is not re-tagged — the live path refuses to pick, so retro must refuse too");

        const live = triage.deriveVertical({ to: [RFB], cc: [OPPLEV] });
        assertEq(live.routed, false, "rt17b: …and the live function agrees it is unroutable, which is why they cannot diverge");

        const liveB = triage.deriveVertical({ to: [OPPLEV] });
        const planB = findCandidate(retro.planRetroTagging(), tierB.threadId);
        assertTrue(liveB.routed === true && liveB.vertical === planB?.proposedVertical,
          "rt18: for the SAME headers, live routing and retro-tagging produce the SAME vertical — asserted rather than assumed");
      }

      // ═══════════════════════════════════════════════════════════════
      // rt23-rt31 — the approval gate.
      //
      // «Apply krever Daniels godkjenning av tallet.» The gate has to be real:
      // if approving "N rows" can silently become N+1, the approval means
      // nothing.
      // ═══════════════════════════════════════════════════════════════
      const plan1 = retro.planRetroTagging();
      const fp1 = plan1.planFingerprint;
      const n1 = plan1.candidates.length;
      assertTrue(n1 > 0, "rt23: there is something to apply (guards every assertion below)");

      {
        const plan2 = retro.planRetroTagging();
        assertEq(plan2.planFingerprint, fp1,
          "rt24: two scans of an UNCHANGED database give the same fingerprint — so Daniel can read a plan, think, and approve it later");
      }

      assertThrows(
        () => retro.applyRetroTagging({ approvedFingerprint: "not-the-plan", approvedCount: n1, approvedBy: "daniel" }),
        /plan changed since it was approved/,
        "rt25: a wrong fingerprint is refused",
      );
      assertThrows(
        () => retro.applyRetroTagging({ approvedFingerprint: fp1, approvedCount: n1 + 1, approvedBy: "daniel" }),
        /approved count .* does not match/,
        "rt26: a right fingerprint with the WRONG count is still refused — the number IS the approval",
      );
      {
        const before = db.prepare("SELECT COUNT(*) n FROM crm_retro_tagging_audit").get() as any;
        assertEq(before.n, 0, "rt27: …and neither refusal wrote an audit row, i.e. neither half-applied");
        const stillRfb = db.prepare("SELECT COUNT(*) n FROM crm_threads WHERE vertical_id != 'rfb'").get() as any;
        assertEq(stillRfb.n, 0, "rt28: …and nothing moved");
      }

      // The fingerprint must actually MOVE when the plan changes, or the gate
      // is decoration. A new candidate is the realistic change.
      {
        mkThread({ email: "new@example.no", subject: "NY-KANDIDAT", toEmails: [OPPLEV] });
        const plan3 = retro.planRetroTagging();
        assertTrue(plan3.planFingerprint !== fp1,
          "rt29: adding one candidate CHANGES the fingerprint — this is what makes rt25 a gate rather than a ritual");
        assertEq(plan3.candidates.length, n1 + 1, "rt29b: …and the count moved with it");
        assertThrows(
          () => retro.applyRetroTagging({ approvedFingerprint: fp1, approvedCount: n1, approvedBy: "daniel" }),
          /plan changed since it was approved/,
          "rt30: …so yesterday's approval no longer applies, even though its own count still matches its own plan",
        );
      }

      // ═══════════════════════════════════════════════════════════════
      // rt32-rt40 — apply moves the whole family, atomically.
      // ═══════════════════════════════════════════════════════════════
      const planFinal = retro.planRetroTagging();
      const result = retro.applyRetroTagging({
        approvedFingerprint: planFinal.planFingerprint,
        approvedCount: planFinal.candidates.length,
        approvedBy: "daniel",
      });
      assertEq(result.applied, planFinal.candidates.length, "rt32: apply moves exactly the approved number of threads");

      {
        // Tier B thread: thread, message AND contact must all be experiences.
        const t = db.prepare("SELECT vertical_id, contact_id FROM crm_threads WHERE id = ?").get(tierB.threadId) as any;
        assertEq(t?.vertical_id, "experiences", "rt33: the thread moved");
        const m = db.prepare("SELECT vertical_id FROM crm_messages WHERE id = ?").get(tierB.messageId) as any;
        assertEq(m?.vertical_id, "experiences", "rt34: …and its message moved with it — a thread whose messages stayed behind is the half-split review B4 refused");
        const c = db.prepare("SELECT vertical_id, email FROM crm_contacts WHERE id = ?").get(t?.contact_id) as any;
        assertEq(c?.vertical_id, "experiences", "rt35: …and it now points at the EXPERIENCES contact, not the rfb one");
        assertEq(c?.email, "hdr@example.no", "rt35b: …for the same person");
        assertTrue(t?.contact_id !== tierB.contactId, "rt36: …which is a DIFFERENT row from the original rfb contact, because steg 2 made contacts per-(email, vertical)");

        // The original rfb contact must still exist — this is a move, not a
        // rewrite of someone's identity.
        const orig = db.prepare("SELECT vertical_id FROM crm_contacts WHERE id = ?").get(tierB.contactId) as any;
        assertEq(orig?.vertical_id, "rfb", "rt37: the original rfb contact row is left intact");
      }
      {
        const audit = db.prepare(
          "SELECT * FROM crm_retro_tagging_audit WHERE thread_id = ?",
        ).get(tierB.threadId) as any;
        assertTrue(!!audit, "rt38: every moved thread has an audit row");
        assertEq(audit.from_vertical, "rfb", "rt38b: …recording where it came FROM");
        assertEq(audit.to_vertical, "experiences", "rt38c: …and where it went");
        assertEq(audit.from_contact_id, tierB.contactId, "rt39: …including the ORIGINAL contact_id, without which a revert could only half-restore");
        assertEq(audit.applied_by, "daniel", "rt39b: …and who approved it");
        assertTrue(String(audit.evidence).length > 20, "rt39c: …and the evidence, so the decision is auditable years later");
        assertTrue(JSON.parse(audit.message_ids).includes(tierB.messageId),
          "rt40: …and the exact message ids as of apply time");
      }

      // ═══════════════════════════════════════════════════════════════
      // rt41-rt48 — revert, exactly.
      // ═══════════════════════════════════════════════════════════════
      {
        // A message arriving AFTER the batch must not be dragged back by an undo.
        db.prepare(
          `INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, cc_emails,
             subject, body_text, sent_at, raw_metadata, vertical_id)
           VALUES ('rt-post-batch-msg', ?, 'in', 'hdr@example.no', ?, '[]', 'Etterpå', 'Hei', datetime('now'), '{}', 'experiences')`,
        ).run(tierB.threadId, JSON.stringify([OPPLEV]));

        const batches = retro.listRetroBatches();
        assertEq(batches.length, 1, "rt41: the batch is listed");
        assertEq(batches[0].rows, result.applied, "rt41b: …with its row count");
        assertEq(batches[0].reverted_rows, 0, "rt41c: …and nothing reverted yet");

        const rev = retro.revertRetroTaggingBatch(result.batchId);
        assertEq(rev.reverted, result.applied, "rt42: revert undoes every row in the batch");

        const t = db.prepare("SELECT vertical_id, contact_id FROM crm_threads WHERE id = ?").get(tierB.threadId) as any;
        assertEq(t?.vertical_id, "rfb", "rt43: the thread is back on rfb");
        assertEq(t?.contact_id, tierB.contactId,
          "rt44: …AND back on its original contact. A vertical-only revert would leave it pointing at the experiences contact — half-reverted, which looks done");
        const m = db.prepare("SELECT vertical_id FROM crm_messages WHERE id = ?").get(tierB.messageId) as any;
        assertEq(m?.vertical_id, "rfb", "rt45: …and its messages are back");

        const again = retro.revertRetroTaggingBatch(result.batchId);
        assertEq(again.reverted, 0, "rt46: reverting a second time is a no-op, not a double-undo");
        const t2 = db.prepare("SELECT vertical_id FROM crm_threads WHERE id = ?").get(tierB.threadId) as any;
        assertEq(t2?.vertical_id, "rfb", "rt46b: …and the state is unchanged by the second call");

        assertThrows(
          () => retro.revertRetroTaggingBatch("no-such-batch"),
          /no audit rows/,
          "rt47: reverting an unknown batch throws rather than silently succeeding",
        );

        const batchesAfter = retro.listRetroBatches();
        assertEq(batchesAfter[0].reverted_rows, result.applied, "rt48: the batch reports itself as fully reverted");
      }

      // After a full revert the plan should offer the same work again — the
      // system is back where it started, not in a third state.
      {
        const replan = retro.planRetroTagging();
        assertEq(replan.candidates.length, planFinal.candidates.length,
          "rt49: after a full revert the same candidates are proposed again — revert restored the INPUT state, not just the output");
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
  runCrmRetroTaggingTests({ log: true }).then((s) => {
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
