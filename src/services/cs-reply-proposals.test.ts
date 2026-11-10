/**
 * cs-reply-proposals.test.ts — dev-request 2026-11-10-cs-paa-serveren
 * (slookisen/A2A), skive S2: proposals, the send worker and the approval queue.
 *
 *   cr1-cr8    create: recipient from the thread (never the caller), In-Reply-To,
 *              subject, autosend off → approval queue, supersede, 404/409.
 *   cr9-cr20   automatic send: every gate (kind, change verified, change wording,
 *              branding, æøå/mojibake, bounce, duplicate, quotas, live
 *              transport, newer customer message, already answered) and a clean
 *              send in the SAME thread with In-Reply-To.
 *   cr21-cr26  bookkeeping: outbox + crm_messages + action, no outreach_sent_log
 *              row, no outreach quota, thread leaves «trenger svar».
 *   cr27-cr33  transport failure: retry with back-off, one outbox/message row,
 *              failed after 3; lease expiry → «ukjent utfall», never re-sent;
 *              concurrent processing sends once.
 *   cr34-cr41  approval queue: approve (with edits) sends as daniel, reject,
 *              edit, refusal of unknown-outcome rows; worker run-ledger row.
 *   crx1-crx8  review fixes: Send from the queue never leaves a stuck row;
 *              edits after a failure are what the CRM shows; a newer customer
 *              message needs an explicit acknowledgement; never our own
 *              address, never a non-contact automatically; a change request
 *              must belong to the thread; a lost lease is not re-queued.
 *   cr42-cr52  routes, /outbox/:id/result validation, needs-reply + watchdog +
 *              digest integration.
 *
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/services/cs-reply-proposals.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { __resetDbFactoryForTesting } from "../database/db-factory";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runCsReplyProposalsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function ok(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function eq(actual: unknown, expected: unknown, label: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    ok(a === e, `${label} (expected ${e}, got ${a})`);
  }

  return (async () => {
    const prevDb = initMod.__peekDbForTesting();
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    __resetDbFactoryForTesting();
    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);
      const rp = require("./cs-reply-proposals") as typeof import("./cs-reply-proposals");
      const crm = require("./crm-service") as typeof import("./crm-service");
      const nr = require("./crm-needs-reply") as typeof import("./crm-needs-reply");
      const cw = require("./cs-watchdog") as typeof import("./cs-watchdog");

      const ON = { CS_AUTOSEND_ENABLED: "1" } as unknown as NodeJS.ProcessEnv;
      const OFF = {} as unknown as NodeJS.ProcessEnv;
      const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
      const sends: any[] = [];
      let sendResult: { success: boolean; messageId?: string; error?: string } = { success: true, messageId: "<smtp-1@rfb>" };
      const sendRaw = async (o: any) => { sends.push(o); return sendResult; };
      const deps = (extra: Record<string, unknown> = {}) => ({ env: ON, sendRaw, liveTransport: true, ...extra });

      let n = 0;
      const mkThread = (vertical: "rfb" | "experiences" = "rfb", opts: { email?: string; subject?: string; rfc?: string | null; h?: number } = {}) => {
        n++;
        const id = `rp-t${n}`;
        const email = opts.email ?? `kunde${n}@x.no`;
        crm.crmService.ingestThread(
          {
            threadId: id,
            subject: opts.subject ?? `Spørsmål ${n}`,
            category: "innkommende",
            messages: [
              {
                messageId: `${id}-in1`, direction: "in", fromEmail: email, toEmails: ["kontakt@rettfrabonden.com"],
                subject: opts.subject ?? `Spørsmål ${n}`, bodyText: "Hei, et spørsmål", sentAt: ago(opts.h ?? 2),
                rawMetadata: opts.rfc === null ? {} : { source: "resend_inbound", rfc_message_id: opts.rfc ?? `<in-${n}@mail.x.no>` },
              },
            ],
          },
          email,
          vertical,
        );
        return { id, email };
      };
      const addInbound = (threadId: string, email: string, msAhead = 1000) => {
        crm.crmService.ingestThread(
          { threadId, messages: [{ messageId: `${threadId}-in-${Date.now()}-${Math.random()}`, direction: "in", fromEmail: email, bodyText: "Og en ting til", sentAt: new Date(Date.now() + msAhead).toISOString() }] },
          email,
          "rfb",
        );
      };
      const create = (threadId: string, extra: Partial<Parameters<typeof rp.createReplyProposal>[0]> = {}, env = ON) =>
        rp.createReplyProposal({ threadId, kind: "takk", bodyText: "Takk for meldingen! Vi ser på saken og svarer deg i morgen.", createdBy: "claude", ...extra }, { env });
      const P = (id: string) => rp.getProposal(id)!;

      // ── create ───────────────────────────────────────────────────────
      const t1 = mkThread("rfb", { subject: "SV: Åpningstider i jula" });
      const c1 = create(t1.id);
      ok(c1.ok === true, "cr1: a proposal is created");
      const p1 = c1.ok ? c1.proposal : (null as any);
      eq([p1.status, p1.to_email, p1.in_reply_to], ["pending", t1.email, `<in-1@mail.x.no>`], "cr2: pending; recipient = sender of the latest inbound; In-Reply-To = its Message-ID");
      eq(p1.subject, "Re: Åpningstider i jula", "cr3: subject «Re: <original>» without stacking prefixes, æøå kept");
      const t2 = mkThread();
      const c2 = create(t2.id, {}, OFF);
      eq(c2.ok && [c2.proposal.status, c2.proposal.block_reason], ["approval_needed", "autosending_av"], "cr4: autosend off → straight to the approval queue (never a silent pending)");
      const c2b = create(t2.id, { bodyText: "Ny versjon av svaret." }, OFF);
      eq([c2b.ok && c2b.superseded, P(c2.ok ? c2.proposal.id : "").status], [[c2.ok ? c2.proposal.id : ""], "superseded"], "cr5: a newer proposal supersedes the open one on the same thread");
      eq((create("nope") as any).status, 404, "cr6: unknown thread → 404");
      crm.crmService.ingestThread(
        { threadId: "rp-out-only", subject: "Utsending", category: "marketing", messages: [{ messageId: "rp-out-only-1", direction: "out", fromEmail: "kontakt@rettfrabonden.com", toEmails: ["p@x.no"], sentAt: ago(5) }] },
        "p@x.no", "rfb");
      const c6 = create("rp-out-only");
      eq([(c6 as any).status, (c6 as any).error], [409, "no_inbound_message"], "cr7: a thread without a message from a person → 409 (use /compose)");
      eq(rp.replySubject("Re: SV: [Innkommende] Hei"), "Re: Hei", "cr8: replySubject strips Re:/SV:/[Innkommende]");

      // ── automatic send: a clean one ──────────────────────────────────
      sends.length = 0;
      const r1 = await rp.processProposal(p1.id, deps());
      eq(r1.outcome, "sent", "cr9: a clean «takk» proposal is sent automatically");
      eq([sends.length, sends[0]?.to, sends[0]?.inReplyToMessageId], [1, t1.email, "<in-1@mail.x.no>"], "cr10: to the thread's contact, in the same thread (In-Reply-To)");
      ok(String(sends[0]?.from).includes("Rett fra Bonden"), "cr11: From carries the thread platform's name");
      const sent1 = P(p1.id);
      eq([sent1.status, sent1.sent_mode, sent1.smtp_message_id], ["sent", "auto", "<smtp-1@rfb>"], "cr12: proposal sent (auto), SMTP id stored");

      // ── gates ────────────────────────────────────────────────────────
      const gate = async (threadOpts: Parameters<typeof mkThread>[1], extra: Partial<Parameters<typeof rp.createReplyProposal>[0]>, d: Record<string, unknown> = {}, vertical: "rfb" | "experiences" = "rfb") => {
        const t = mkThread(vertical, threadOpts);
        // A linked change belongs to the conversation it confirms.
        for (const cid of extra.changeRequestIds ?? []) db.prepare("UPDATE cs_change_requests SET thread_id = ? WHERE id = ?").run(t.id, cid);
        const c = create(t.id, extra);
        if (!c.ok) return { outcome: "create_failed", reason: (c as any).error };
        return rp.processProposal(c.proposal.id, deps(d));
      };
      eq(await gate({}, { kind: "annet" }).then((r) => [r.outcome, r.reason]), ["approval_needed", "kind_krever_godkjenning"], "cr13: kind «annet» → approval queue");
      eq(await gate({}, { kind: "fjernet", bodyText: "Profilen din er fjernet." }).then((r) => r.reason), "endring_mangler", "cr14: «fjernet» without a linked change request → stopped");
      eq(await gate({}, { kind: "takk", bodyText: "Takk! Vi har nå oppdatert åpningstidene på siden." }).then((r) => r.reason), "endring_ikke_verifisert", "cr15: text that says a change was made, without a verified change → stopped");
      eq(await gate({}, { kind: "rettelse_bekreftet", changeRequestIds: ["chg-1"], bodyText: "Vi har rettet telefonnummeret." }).then((r) => r.reason), "endring_ikke_verifisert", "cr16: a linked change that is not verified (S4 table absent) → stopped");
      const insCr = db.prepare(
        `INSERT INTO cs_change_requests (id, vertical, target_id, requester_email, kind, authority, status, created_by, created_at, updated_at)
         VALUES (?, 'rfb', 'ag-x', 'k@x.no', ?, 'registered_email', ?, 'claude', ?, ?)`,
      );
      const tsNow = new Date().toISOString();
      insCr.run("chg-ok", "profile_update", "verified", tsNow, tsNow);
      insCr.run("chg-pending", "profile_update", "executed", tsNow, tsNow);
      insCr.run("chg-failed", "profile_update", "verify_failed", tsNow, tsNow);
      insCr.run("chg-hidden", "removal", "hidden", tsNow, tsNow);
      eq(await gate({}, { kind: "rettelse_bekreftet", changeRequestIds: ["chg-pending"], bodyText: "Vi har rettet telefonnummeret." }).then((r) => [r.outcome, r.reason]), ["waiting", "venter_paa_endring"], "cr16b: executed but not yet verified → the reply WAITS (re-checked), not sent");
      eq(await gate({}, { kind: "rettelse_bekreftet", changeRequestIds: ["chg-failed"], bodyText: "Vi har rettet telefonnummeret." }).then((r) => [r.outcome, r.reason]), ["approval_needed", "endring_ikke_verifisert"], "cr16c: a change that failed verification → approval queue");
      eq(await gate({}, { kind: "fjern_steg1", changeRequestIds: ["chg-hidden"], bodyText: "Profilen din er nå skjult, og den slettes om 24 timer." }).then((r) => r.outcome), "sent", "cr16d: «fjern_steg1» may go once the removal is hidden");
      eq(await gate({}, { kind: "fjernet", changeRequestIds: ["chg-hidden"], bodyText: "Profilen din er fjernet." }).then((r) => r.outcome), "waiting", "cr16e: «fjernet» waits until the removal is VERIFIED");
      eq(await gate({}, { kind: "rettelse_bekreftet", changeRequestIds: ["chg-ok"], bodyText: "Vi har rettet telefonnummeret." }).then((r) => r.outcome), "sent", "cr17: the same reply with a VERIFIED change is sent");
      eq(await gate({}, { kind: "takk", bodyText: "Se rettfrabonden.com for mer." }, {}, "experiences").then((r) => r.reason), "feil_merkevare", "cr18: another platform's brand/domain in an Opplevagent reply → stopped");
      eq(await gate({}, { kind: "takk", bodyText: "Takk, vi ser paa saken." }).then((r) => r.reason), "tegnsett", "cr19: æøå written as «paa» → stopped");
      eq(await gate({}, { kind: "takk", bodyText: "Takk for svaret, vi ser pÃ¥ saken." }).then((r) => r.reason), "tegnsett", "cr19b: mojibake → stopped");
      eq(await gate({}, {}, { liveTransport: false }).then((r) => r.reason), "transport_ikke_live", "cr20: dry-run transport → stopped (a dry run is never «sent»)");
      {
        const t = mkThread("rfb", { email: "bounced@x.no" });
        db.prepare(`INSERT INTO email_bounces (email, bounced_at, bounce_type) VALUES ('bounced@x.no', '2026-11-01', 'hard')`).run();
        const c = create(t.id);
        eq(c.ok && (await rp.processProposal(c.proposal.id, deps())).reason, "mottaker_avvist", "cr20b: hard-bounced recipient → stopped on the automatic path");
      }
      {
        const t = mkThread();
        const c = create(t.id);
        addInbound(t.id, t.email);
        eq(c.ok && (await rp.processProposal(c.proposal.id, deps())).reason, "ny_melding_etter_forslag", "cr20c: the customer wrote again after the proposal → stopped");
      }
      {
        const t = mkThread();
        const c = create(t.id);
        crm.crmService.recordOutboundReply({ threadId: t.id, vertical: "rfb", toEmails: [t.email], subject: "Re", bodyText: "Daniel svarte selv", deliveryStatus: "sent", sentAt: new Date(Date.now() + 2000).toISOString() });
        const r = c.ok ? await rp.processProposal(c.proposal.id, deps()) : null;
        eq([r?.outcome, r?.reason], ["superseded", "allerede_besvart"], "cr20d: someone answered after the proposal → superseded, not sent");
      }

      // ── bookkeeping of the clean send ────────────────────────────────
      const msg = db.prepare(`SELECT id, direction, delivery_status, raw_metadata FROM crm_messages WHERE id = ?`).get(sent1.crm_message_id) as any;
      ok(msg?.direction === "out" && msg?.delivery_status === "sent" && JSON.parse(msg.raw_metadata).cs_reply === true, "cr21: crm_messages has the reply (out, sent, cs_reply)");
      const ob = db.prepare(`SELECT status, result_id, intent, created_by FROM crm_outbox WHERE id = ?`).get(sent1.outbox_id) as any;
      eq([ob?.status, ob?.result_id, ob?.intent, ob?.created_by], ["completed", "<smtp-1@rfb>", "resend_send", "claude"], "cr22: crm_outbox row completed with the SMTP id (threading key for the next inbound)");
      ok(!!db.prepare(`SELECT 1 FROM crm_actions WHERE thread_id = ? AND type = 'sent' AND payload LIKE ?`).get(t1.id, `%${p1.id}%`), "cr23: a «sent» action names the proposal");
      eq((db.prepare(`SELECT COUNT(*) n FROM outreach_sent_log WHERE message_id = ?`).get(sent1.crm_message_id) as any).n, 0, "cr24: a CS reply is never logged as cold outreach");
      {
        // Even when the contact maps to a producer agent (the trigger's own condition).
        db.pragma("foreign_keys = OFF");
        const t = mkThread();
        db.prepare(`UPDATE crm_contacts SET agent_id = 'ag-test-1' WHERE email = ?`).run(t.email);
        db.pragma("foreign_keys = ON");
        const c = create(t.id);
        if (c.ok) await rp.processProposal(c.proposal.id, deps());
        const mid = c.ok ? P(c.proposal.id).crm_message_id : null;
        eq((db.prepare(`SELECT COUNT(*) n FROM outreach_sent_log WHERE message_id = ?`).get(mid) as any).n, 0, "cr25: …also when the contact is a known producer");
      }
      ok(!nr.computeNeedsReply({}).threads.some((t) => t.thread_id === t1.id), "cr26: the answered thread leaves «trenger svar»");

      // ── duplicate + quotas ───────────────────────────────────────────
      {
        addInbound(t1.id, t1.email, 5000);
        const c = create(t1.id); // same body as the sent one
        eq(c.ok && (await rp.processProposal(c.proposal.id, deps())).reason, "duplikat", "cr26b: the same text again on the thread within 24 h → stopped");
        const c2 = create(t1.id, { bodyText: "Et annet svar på det nye spørsmålet." });
        eq(c2.ok && (await rp.processProposal(c2.proposal.id, deps({ env: { ...ON, CS_AUTOSEND_MAX_PER_RECIPIENT_PER_DAY: "1" } }))).reason, "kvote_mottaker", "cr26c: per-recipient reply quota");
        eq(c2.ok && (await rp.processProposal((create(t1.id, { bodyText: "Tredje variant." }) as any).proposal.id, deps({ env: { ...ON, CS_AUTOSEND_MAX_PER_DAY: "2" } }))).reason, "kvote_dag", "cr26d: per-day reply quota (separate from the outreach cap)");
      }

      // ── transport failure, lease, concurrency ────────────────────────
      {
        const t = mkThread();
        const c = create(t.id);
        const id = c.ok ? c.proposal.id : "";
        sendResult = { success: false, error: "421 try again" };
        const f1 = await rp.processProposal(id, deps());
        eq([f1.outcome, P(id).status, P(id).attempts], ["retry", "pending", 1], "cr27: a transport failure → retry later (back to pending)");
        eq((db.prepare(`SELECT status FROM crm_outbox WHERE id = ?`).get(P(id).outbox_id) as any).status, "failed", "cr28: during the back-off the outbox row is «failed», never «pending» (the routine's outbox reader must not pick it up)");
        eq((await rp.processProposal(id, deps())).reason, "retry_not_due", "cr29: not retried before the back-off");
        const later = (min: number) => new Date(Date.now() + min * 60_000);
        await rp.processProposal(id, deps({ now: later(3) }));
        const f3 = await rp.processProposal(id, deps({ now: later(10) }));
        eq([f3.outcome, P(id).status, P(id).block_reason, P(id).attempts], ["failed", "failed", "sending_feilet", 3], "cr30: failed after 3 attempts");
        eq([
          (db.prepare(`SELECT COUNT(*) n FROM crm_outbox WHERE thread_id = ?`).get(t.id) as any).n,
          (db.prepare(`SELECT COUNT(*) n FROM crm_messages WHERE thread_id = ? AND direction = 'out'`).get(t.id) as any).n,
          (db.prepare(`SELECT status FROM crm_outbox WHERE id = ?`).get(P(id).outbox_id) as any).status,
        ], [1, 1, "failed"], "cr31: one outbox row and one message across all attempts, both failed at the end");
        sendResult = { success: true, messageId: "<smtp-2@rfb>" };
      }
      {
        const t = mkThread();
        const c = create(t.id);
        const id = c.ok ? c.proposal.id : "";
        db.prepare(`UPDATE cs_reply_proposals SET status = 'sending', lease_until = ? WHERE id = ?`).run(new Date(Date.now() - 60_000).toISOString(), id);
        sends.length = 0;
        const run = await rp.runCsAutosend(deps());
        eq([P(id).status, P(id).block_reason, sends.filter((s) => s.to === t.email).length], ["failed", "ukjent_utfall", 0], "cr32: an expired lease → failed «ukjent utfall», never re-sent");
        eq(run.recovered_leases, [id], "cr32b: …reported by the worker run");
        const ap = await rp.approveProposal(id, {}, deps());
        eq([ap.ok, (ap as any).status], [false, 409], "cr32c: an unknown-outcome row cannot be re-sent from the queue");
      }
      {
        const t = mkThread();
        const c = create(t.id);
        const id = c.ok ? c.proposal.id : "";
        sends.length = 0;
        let release: () => void = () => {};
        const hold = new Promise<void>((r) => { release = r; });
        const slow = async (o: any) => { sends.push(o); await hold; return { success: true, messageId: "<smtp-c@rfb>" }; };
        const a = rp.processProposal(id, { env: ON, sendRaw: slow, liveTransport: true });
        const b = rp.processProposal(id, { env: ON, sendRaw: slow, liveTransport: true });
        release();
        const [ra, rb] = await Promise.all([a, b]);
        eq([sends.length, [ra.outcome, rb.outcome].sort()], [1, ["sent", "skipped"]], "cr33: two concurrent senders → exactly one e-mail");
      }

      // ── approval queue ───────────────────────────────────────────────
      {
        const t = mkThread();
        const c = create(t.id, { kind: "annet", bodyText: "Et spesielt svar." });
        const id = c.ok ? c.proposal.id : "";
        await rp.processProposal(id, deps());
        eq(P(id).status, "approval_needed", "cr34: in the approval queue");
        ok(rp.listProposals({ status: "approval_needed" }).some((x) => x.id === id), "cr35: listed in the queue with age");
        const e = rp.editProposal(id, { bodyText: "Et redigert svar." }, "daniel");
        eq([e.ok, P(id).status, P(id).body_text], [true, "approval_needed", "Et redigert svar."], "cr36: Endre keeps it in the queue");
        sends.length = 0;
        const ap = await rp.approveProposal(id, { edits: { subject: "Re: Endelig" } }, deps());
        eq([ap.ok && ap.result.outcome, P(id).status, P(id).sent_mode, sends[0]?.subject, sends[0]?.textContent], ["sent", "sent", "approved", "Re: Endelig", "Et redigert svar."], "cr37: Send from the queue sends the edited reply");
        eq((db.prepare(`SELECT created_by FROM crm_outbox WHERE id = ?`).get(P(id).outbox_id) as any).created_by, "daniel", "cr38: …recorded as Daniel's");
        const ap2 = await rp.approveProposal(id, {}, deps());
        eq((ap2 as any).status, 409, "cr39: a sent proposal cannot be sent again");
      }
      {
        const t = mkThread();
        const c = create(t.id, { kind: "annet", bodyText: "Noe." });
        const id = c.ok ? c.proposal.id : "";
        const rj = rp.rejectProposal(id, "feil tone", "daniel");
        eq([rj.ok, P(id).status, P(id).decision_note], [true, "rejected", "feil tone"], "cr40: Avvis records the reason");
        ok(nr.computeNeedsReply({}).threads.some((x) => x.thread_id === t.id), "cr40b: a rejected proposal leaves the thread in «trenger svar»");
      }
      {
        const t = mkThread();
        const t2b = mkThread();
        create(t.id);
        create(t2b.id);
        const run = await rp.runCsAutosend(deps());
        const sentNow = run.processed.filter((r) => r.outcome === "sent").length;
        ok(sentNow >= 2 && !!run.run_id && !!db.prepare("SELECT 1 FROM runs WHERE run_id = ? AND claims LIKE '%cs_autosend%'").get(run.run_id), "cr41: the worker sends due proposals and writes a run-ledger row");
        const idle = await rp.runCsAutosend(deps());
        eq([idle.run_id, idle.processed.length], [null, 0], "cr41b: an idle minute writes no ledger row");
        const t3 = mkThread();
        const c3 = create(t3.id);
        eq([rp.parkPendingWhenAutosendOff(OFF) >= 1, c3.ok && P(c3.proposal.id).status], [true, "approval_needed"], "cr41c: autosend switched off → pending proposals move to the queue");
      }

      // ── review fixes (S2 review B1–B6, N1) ──────────────────────────
      {
        // B1: Daniel presses Send with autosend off and the transport fails → back in the queue, never a stuck «approved».
        const t = mkThread();
        const c = create(t.id, { kind: "annet", bodyText: "Svar som feiler første gang." }, OFF);
        const id = c.ok ? c.proposal.id : "";
        sendResult = { success: false, error: "421 busy" };
        const a1 = await rp.approveProposal(id, {}, { env: OFF, sendRaw, liveTransport: true });
        eq([a1.ok && a1.result.outcome, P(id).status, P(id).block_reason], ["approval_needed", "approval_needed", "sending_feilet"], "crx1: a failed send from the queue goes back to the queue with the reason");
        sendResult = { success: true, messageId: "<smtp-x1@rfb>" };
        // B6: edit after the failure → the CRM shows the text actually sent
        const a2 = await rp.approveProposal(id, { edits: { bodyText: "Ny tekst fra Daniel." } }, { env: OFF, sendRaw, liveTransport: true });
        const m = db.prepare(`SELECT body_text, delivery_status FROM crm_messages WHERE id = ?`).get(P(id).crm_message_id) as any;
        const o = db.prepare(`SELECT body_text, status FROM crm_outbox WHERE id = ?`).get(P(id).outbox_id) as any;
        eq([a2.ok && a2.result.outcome, m.body_text, m.delivery_status, o.body_text, o.status], ["sent", "Ny tekst fra Daniel.", "sent", "Ny tekst fra Daniel.", "completed"], "crx2: after an edit, the reused message and outbox rows carry the text that was sent");
      }
      {
        // B2: a newer customer message stops Send too — unless Daniel explicitly acknowledges it.
        const t = mkThread();
        const c = create(t.id, { kind: "annet", bodyText: "Svar på det første spørsmålet." }, OFF);
        const id = c.ok ? c.proposal.id : "";
        addInbound(t.id, t.email, 2000);
        const b1 = await rp.approveProposal(id, {}, { env: OFF, sendRaw, liveTransport: true });
        eq([b1.ok && b1.result.reason, P(id).status], ["ny_melding_etter_forslag", "approval_needed"], "crx3: Send from the queue is stopped by a newer customer message");
        const b2 = await rp.approveProposal(id, { acknowledgeNewerInbound: true }, { env: OFF, sendRaw, liveTransport: true });
        eq(b2.ok && b2.result.outcome, "sent", "crx4: …and sent when Daniel says he has read it");
      }
      {
        // B3: our own address is never the recipient; a CC person is not the contact on the automatic path.
        const t = mkThread();
        crm.crmService.ingestThread({ threadId: t.id, messages: [{ messageId: `${t.id}-copy`, direction: "in", fromEmail: "kontakt@rettfrabonden.com", bodyText: "Videresendt kopi", sentAt: new Date(Date.now() + 1000).toISOString() }] }, t.email, "rfb");
        const c = create(t.id);
        eq(c.ok && c.proposal.to_email, t.email, "crx5: a newer message from our own address is skipped — the customer stays the recipient");
        const t2 = mkThread();
        crm.crmService.ingestThread({ threadId: t2.id, messages: [{ messageId: `${t2.id}-cc`, direction: "in", fromEmail: "kollega@annen.no", bodyText: "Jeg svarer for Kari", sentAt: new Date(Date.now() + 1000).toISOString() }] }, t2.email, "rfb");
        const c2 = create(t2.id);
        eq(c2.ok && (await rp.processProposal(c2.proposal.id, deps())).reason, "mottaker_ikke_kontakt", "crx6: a reply to someone other than the thread's contact waits for Daniel");
      }
      {
        // B4: a change request from another thread can neither be linked nor release a reply.
        const tA = mkThread();
        const tB = mkThread();
        const ts2 = new Date().toISOString();
        db.prepare(
          `INSERT INTO cs_change_requests (id, vertical, target_id, thread_id, requester_email, kind, authority, status, created_by, created_at, updated_at)
           VALUES ('chg-a', 'rfb', 'ag-a', ?, ?, 'profile_update', 'registered_email', 'verified', 'claude', ?, ?)`,
        ).run(tA.id, tA.email, ts2, ts2);
        const c = create(tB.id, { kind: "rettelse_bekreftet", changeRequestIds: ["chg-a"], bodyText: "Vi har nå oppdatert åpningstidene dine." });
        eq([(c as any).status, (c as any).error], [409, "change_request_other_thread"], "crx7: linking another thread's change request is refused");
      }
      {
        // N1: a lease that ran out during a slow send, then a late failure → the row is not put back in line.
        const t = mkThread();
        const c = create(t.id, { bodyText: "Treg sending." });
        const id = c.ok ? c.proposal.id : "";
        const slowFail = async () => {
          db.prepare(`UPDATE cs_reply_proposals SET status = 'failed', block_reason = 'ukjent_utfall' WHERE id = ?`).run(id);
          return { success: false, error: "timeout" };
        };
        const r = await rp.processProposal(id, { env: ON, sendRaw: slowFail, liveTransport: true });
        eq([r.reason, P(id).status], ["lease_lost", "failed"], "crx8: a late transport failure after the lease was lost does not re-queue the proposal");
      }

      // ── routes ───────────────────────────────────────────────────────
      const crmRoutes = require("../routes/crm") as any;
      const crmRouter = crmRoutes.default ?? crmRoutes;
      const call = async (method: string, url: string, body?: any, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
        const [path, qs] = url.split("?");
        const query: Record<string, string> = {};
        for (const kv of (qs ?? "").split("&").filter(Boolean)) {
          const [k, v] = kv.split("=");
          query[k] = decodeURIComponent(v ?? "");
        }
        const req: any = {
          method, url, originalUrl: url, path, query, body: body ?? {},
          headers: { "x-admin-key": process.env.ADMIN_KEY || "test-admin-key", host: "rettfrabonden.com", ...headers },
          get(n: string) { return this.headers[n.toLowerCase()]; },
        };
        let settle: () => void;
        const done = new Promise<void>((r) => { settle = r; });
        const res: any = {
          statusCode: 200, _body: undefined,
          status(c: number) { this.statusCode = c; return this; },
          json(b: any) { this._body = b; settle(); return this; },
          send(b: any) { this._body = b; settle(); return this; },
        };
        crmRouter.handle(req, res, () => settle());
        await done;
        return { status: res.statusCode, body: res._body };
      };
      const prevAutosend = process.env.CS_AUTOSEND_ENABLED;
      delete process.env.CS_AUTOSEND_ENABLED; // the routes read process.env: autosend off → straight to the queue
      try {
        const t = mkThread();
        const c = await call("POST", `/threads/${t.id}/reply-proposals`, { kind: "annet", bodyText: "Hei! Her er svaret ditt." });
        eq([c.status, c.body?.proposal?.status, c.body?.proposal?.to_email], [201, "approval_needed", t.email], "cr42: POST /threads/:id/reply-proposals → 201, recipient from the thread");
        eq((await call("POST", `/threads/${t.id}/reply-proposals`, { kind: "ukjent", bodyText: "x" })).status, 400, "cr43: unknown kind → 400");
        eq((await call("POST", `/threads/${t.id}/reply-proposals`, { kind: "takk", bodyText: "x", toEmail: "annen@x.no" })).body?.proposal?.to_email, t.email, "cr44: a caller-supplied recipient is ignored");
        const nrr = await call("GET", "/needs-reply?limit=5");
        ok(nrr.status === 200 && typeof nrr.body?.server_mode?.autosend === "boolean" && nrr.body.server_mode.autosend === false && typeof nrr.body.server_mode.change_requests === "boolean", "cr44b: needs-reply reports server_mode (which parts the server does), for the CS routine");
        const q = await call("GET", "/reply-proposals?status=approval_needed");
        ok(q.status === 200 && q.body.items.some((x: any) => x.thread_id === t.id && typeof x.age_hours === "number"), "cr45: GET /reply-proposals lists the queue");
        eq((await call("GET", "/reply-proposals?status=bogus")).status, 400, "cr45b: invalid status filter → 400");
        const pid = q.body.items.find((x: any) => x.thread_id === t.id).id;
        const ed = await call("POST", `/reply-proposals/${pid}/edit`, { bodyText: "Hei! Her er et bedre svar." });
        eq([ed.status, ed.body?.proposal?.body_text], [200, "Hei! Her er et bedre svar."], "cr46: POST edit");
        const ap = await call("POST", `/reply-proposals/${pid}/approve`, {}, { "x-admin-client": "admin-crm" });
        // The route uses the real transport (dry-run under test) → the live-transport gate stops it, visibly.
        eq([ap.status, ap.body?.sent, ap.body?.result?.reason], [409, false, "transport_ikke_live"], "cr47: approve with a dry-run transport → 409, not sent, reason given");
        ok(!!db.prepare(`SELECT 1 FROM crm_actions WHERE type = 'proposal_approved' AND payload LIKE '%admin-crm%'`).get(), "cr47b: the approval records where it came from");
        const rj = await call("POST", `/reply-proposals/${pid}/reject`, { reason: "Svarer selv på telefon" });
        eq([rj.status, rj.body?.proposal?.status], [200, "rejected"], "cr48: POST reject");
        eq((await call("POST", `/reply-proposals/${pid}/reject`, {})).status, 400, "cr48b: reject without reason → 400");
        eq((await call("GET", "/reply-proposals/nope")).status, 404, "cr48c: unknown proposal → 404");
      } finally {
        if (prevAutosend === undefined) delete process.env.CS_AUTOSEND_ENABLED;
        else process.env.CS_AUTOSEND_ENABLED = prevAutosend;
      }

      // ── /outbox/:id/result validation ────────────────────────────────
      {
        const t = mkThread();
        const ob = crm.crmService.enqueueOutbox({ threadId: t.id, vertical: "rfb", intent: "gmail_draft", toEmails: [t.email], subject: "s", bodyText: "b", createdBy: "claude" });
        eq((await call("POST", "/outbox/nope/result", { status: "completed" })).status, 404, "cr49: result for an unknown outbox id → 404");
        eq((await call("POST", `/outbox/${ob.id}/result`, { status: "completed", resultId: "d1" })).status, 200, "cr49b: result for a pending row → 200");
        eq((await call("POST", `/outbox/${ob.id}/result`, { status: "completed", resultId: "d1" })).body?.unchanged, true, "cr49c: the same result again → idempotent 200");
        eq((await call("POST", `/outbox/${ob.id}/result`, { status: "failed", error: "x" })).status, 409, "cr49d: a different result on a finished row → 409 (no silent overwrite)");
      }

      // ── needs-reply, watchdog, digest ────────────────────────────────
      {
        const rep = nr.computeNeedsReply({});
        ok(rep.counts.approval_needed >= 1, "cr50: needs-reply counts the approval queue");
        ok(rep.outbound_failed.some((o) => o.reason === "sending_feilet") && rep.counts.outbound_failed_7d >= 1, "cr50b: …and replies that did not get out");
        const queued = rep.threads.find((x) => x.proposal?.status === "approval_needed");
        ok(!!queued, "cr50c: a listed thread shows its open proposal");
        const alerts: any[] = [];
        // A resend_send outbox row left pending for 2 h by a crashed send (no proposal behind it).
        const t = mkThread();
        const stale = crm.crmService.enqueueOutbox({ threadId: t.id, vertical: "rfb", intent: "resend_send", toEmails: [t.email], subject: "Hang", bodyText: "b", createdBy: "daniel" });
        db.prepare(`UPDATE crm_outbox SET created_at = datetime('now', '-2 hours') WHERE id = ?`).run(stale.id);
        const w = await cw.runCsWatchdog({ send: async (o: any) => { alerts.push(o); return { success: true }; }, adminEmail: "admin@example.no", trigger: "manual", env: ON });
        const text = String(alerts[0]?.textContent ?? "");
        ok(text.includes("[Svar ikke sendt]") && text.includes("[Utboks henger]") && text.includes("Hang"), "cr51: the watchdog alerts a failed reply and a hanging outbox row");
        ok(w.alert_sent === true, "cr51b: …in one accepted alert");
        const d = cw.buildDailyDigest(new Date());
        ok(d.text.includes("GODKJENNINGSKØ") && /svar sendt automatisk/.test(d.text) && d.text.includes("SVAR SOM IKKE KOM UT"), "cr52: the digest shows auto-sent vs Daniel, the approval queue and failed replies");
      }
    } catch (err: any) {
      failed++;
      failures.push("unexpected error: " + String(err?.stack || err));
    } finally {
      try { db.close(); } catch { /* already closed */ }
      initMod.__setDbForTesting(prevDb as any);
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      __resetDbFactoryForTesting();
    }
    if (log) console.log(`\n${passed} passed, ${failed} failed`);
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runCsReplyProposalsTests({ log: true }).then((s) => {
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
