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
  /**
   * Asserts the call throws WITH A MESSAGE MATCHING `expect`.
   *
   * The `expect` argument is not optional decoration. The first version of this
   * helper accepted any throw, and a reviewer showed that cv8 and cv12b then
   * passed even with `assertVertical` DELETED from resolveContact and
   * enqueueOutbox — SQLite's own NOT NULL / bind error masqueraded as the guard
   * firing. Two tests passing for the wrong reason, in a suite whose whole
   * subject is a guard. Matching on the message is what tells the two apart.
   */
  function assertThrows(fn: () => unknown, expect: RegExp, label: string): void {
    try {
      fn();
      assertTrue(false, `${label} — expected a throw, got a return`);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      assertTrue(expect.test(msg), `${label} (message ${JSON.stringify(msg)} must match ${expect})`);
    }
  }
  const GUARD = /vertical must be one of/;

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
      assertThrows(() => crm.assertVertical(undefined, "t"), GUARD, "cv2: undefined throws — the commonest way a caller forgets");
      assertThrows(() => crm.assertVertical("", "t"), GUARD, "cv3: empty string throws");
      assertThrows(() => crm.assertVertical("opplevagent", "t"), GUARD, "cv4: a PLAUSIBLE but wrong value throws — this is the one a human would type");
      assertThrows(() => crm.assertVertical(null, "t"), GUARD, "cv5: null throws");
      assertThrows(() => crm.assertVertical("RFB", "t"), GUARD, "cv6: case variants throw rather than being normalised — SQL comparison is case-sensitive, so accepting 'RFB' here would write a value no read query can find");

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
      assertThrows(() => (crm.crmService as any).resolveContact("x@y.no", null, undefined), GUARD,
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
      assertThrows(() => (crm.crmService as any).enqueueOutbox({
          intent: "resend_send", toEmails: ["a@b.no"], subject: "s", bodyText: "b", createdBy: "daniel",
        }), GUARD,
        "cv12b: enqueueOutbox with no vertical throws — an outbound send is the one place a wrong platform reaches a real person");
      // REVIEW O2: cv12b only covers the MISSING case, which SQLite's NOT NULL
      // would reject anyway — so deleting assertVertical from enqueueOutbox
      // survived the whole suite. A present-but-INVALID string is the case only
      // the guard can catch, because SQLite will happily store 'opplevagent'.
      assertThrows(() => (crm.crmService as any).enqueueOutbox({
          intent: "resend_send", toEmails: ["a@b.no"], subject: "s", bodyText: "b",
          createdBy: "daniel", vertical: "opplevagent",
        }), GUARD,
        "cv12c: …and an INVALID vertical is rejected by the GUARD, not silently stored — SQLite would have accepted that string");
      assertThrows(() => (crm.crmService as any).resolveContact("z@y.no", null, "opplevagent"), GUARD,
        "cv12d: same for resolveContact — the guard, not the column type, is what rejects it");

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
      // ═══════════════════════════════════════════════════════════════
      // cv21-cv26 — THE ROUTE. Acceptance criterion 1, verbatim:
      //   «POST /admin/crm/ingest uten vertical → 400, null skriv.»
      //
      // cv1-cv20 all drive the SERVICE. That is one layer below the thing the
      // criterion is about, and a service guard proves nothing about the route
      // if the route never reaches it — which is exactly how lokal#377's cap
      // survived being deleted from the production factory with 10 443 tests
      // green. So these go through the real router with a real request.
      //
      // «null skriv» is asserted as a whole-table row count taken BEFORE and
      // AFTER the rejected call. A 400 that still wrote a row would satisfy a
      // status-code-only assertion, and a silently-created contact is the
      // precise damage this dev-request exists to stop.
      // ═══════════════════════════════════════════════════════════════
      {
        // The CRM router authenticates on ANALYTICS_ADMIN_KEY / ADMIN_API_KEY —
        // deliberately NOT the shared ADMIN_KEY that 62 other test sites fight
        // over, so this block does not add to that known non-determinism.
        // Saved and restored regardless.
        const prevAdminKey = process.env.ANALYTICS_ADMIN_KEY;
        process.env.ANALYTICS_ADMIN_KEY = "crm-vertical-test-key";
        try {
          const crmRoutes = require("../routes/crm") as any;
          const router = crmRoutes.default ?? crmRoutes.router ?? crmRoutes;

          const post = (body: any): { status: number; body: any } => {
            let out = { status: 200, body: undefined as any };
            const req: any = {
              method: "POST", url: "/ingest", query: {}, body,
              headers: { "x-admin-key": "crm-vertical-test-key" },
              // Express handlers read headers via req.get(), not req.headers.
              get(name: string) { return this.headers[name.toLowerCase()]; },
            };
            const res: any = {
              statusCode: 200,
              status(c: number) { this.statusCode = c; return this; },
              json(p: any) { out = { status: this.statusCode, body: p }; return this; },
            };
            router.handle(req, res, () => { /* unmatched → leave default */ });
            return out;
          };

          const countRows = () =>
            (db.prepare("SELECT COUNT(*) n FROM crm_contacts").get() as any).n +
            (db.prepare("SELECT COUNT(*) n FROM crm_threads").get() as any).n +
            (db.prepare("SELECT COUNT(*) n FROM crm_messages").get() as any).n;

          const baseBody = {
            threadId: "cv-route-1",
            primaryFromEmail: "rute@example.no",
            messages: [{ messageId: "cv-route-msg-1", direction: "in", fromEmail: "rute@example.no" }],
          };

          const before = countRows();
          const missing = post({ ...baseBody });
          assertEq(missing.status, 400, "cv21: /ingest WITHOUT vertical is rejected");
          assertEq(countRows(), before, "cv22: …and wrote NOTHING — not a contact, not a thread, not a message");

          const unknown = post({ ...baseBody, vertical: "opplevagent" });
          assertEq(unknown.status, 400, "cv23: an unknown vertical is rejected too — a typo must not become a platform");
          assertEq(countRows(), before, "cv24: …and also wrote nothing");

          const ok = post({ ...baseBody, vertical: "experiences" });
          assertEq(ok.status, 200, "cv25: WITH a valid vertical the same call succeeds — the guard rejects the omission, not the endpoint");
          const t = db.prepare("SELECT vertical_id FROM crm_threads WHERE id = 'cv-route-1'").get() as any;
          assertEq(t?.vertical_id, "experiences", "cv26: …and the row lands on the platform the caller named");

          // ── cv27-cv29: a REPLY takes its platform from the THREAD ──
          //
          // Found by mutation, not by design: rewriting
          //     vertical: thread.vertical_id
          //  →  vertical: req.body?.vertical ?? "rfb"
          // in POST /threads/:id/send left all 32 assertions green. That mutant
          // is the mixing scenario itself — an Opplevagent conversation answered
          // under the Rett fra Bonden identity, chosen by whoever sent the
          // request rather than by the conversation's own history. cv21-cv26
          // covered /ingest and stopped there, which is the same "tested the
          // neighbourhood, not the line" shape as lokal#377's B1.
          const send = (body: any): { status: number; body: any } => {
            let out = { status: 200, body: undefined as any };
            const req: any = {
              method: "POST", url: "/threads/cv-route-1/send", query: {}, body,
              headers: { "x-admin-key": "crm-vertical-test-key" },
              get(name: string) { return this.headers[name.toLowerCase()]; },
            };
            const res: any = {
              statusCode: 200,
              status(c: number) { this.statusCode = c; return this; },
              json(p: any) { out = { status: this.statusCode, body: p }; return this; },
            };
            router.handle(req, res, () => { /* unmatched → leave default */ });
            return out;
          };

          // The thread is 'experiences' (cv26). Ask for it to be sent as 'rfb'.
          const reply = send({
            intent: "gmail_draft",
            toEmails: ["rute@example.no"],
            subject: "Svar",
            bodyText: "Hei igjen",
            createdBy: "daniel",
            vertical: "rfb",
          });
          assertEq(reply.status, 200, "cv27: a reply on an existing thread is accepted");
          const ob = db.prepare(
            "SELECT vertical_id FROM crm_outbox WHERE thread_id = 'cv-route-1' ORDER BY rowid DESC LIMIT 1"
          ).get() as any;
          assertEq(ob?.vertical_id, "experiences",
            "cv28: …and it is queued on the THREAD's platform, ignoring the 'rfb' the caller asked for — a reply belongs to the conversation it continues");
          assertTrue(ob?.vertical_id !== "rfb",
            "cv29: …so a request body can never re-platform an existing conversation");

          // ── cv30: a thread with an unroutable platform refuses to send ──
          //
          // Not reachable through the app today (vertical_id is NOT NULL
          // DEFAULT 'rfb', and every writer now goes through assertVertical),
          // so this pins a guard against a state only a direct DB write or a
          // future migration can produce. Written rather than waved away: the
          // alternative to the guard is guessing a platform for an email that
          // reaches a real person, and mutation showed nothing else caught its
          // removal.
          db.prepare("UPDATE crm_threads SET vertical_id = 'garbage' WHERE id = 'cv-route-1'").run();
          const broken = send({
            intent: "gmail_draft", toEmails: ["rute@example.no"],
            subject: "Svar", bodyText: "x", createdBy: "daniel",
          });
          assertEq(broken.status, 409,
            "cv30: a thread whose vertical is unroutable refuses the send rather than guessing a platform");
          db.prepare("UPDATE crm_threads SET vertical_id = 'experiences' WHERE id = 'cv-route-1'").run();

          // ── cv37-cv39: /compose — REVIEW T6, T7, T8 ──
          //
          // Zero route-level tests existed for /admin/crm/compose. That one gap
          // let THREE mutants live: making `vertical` optional with a default of
          // 'rfb', and hardcoding 'rfb' into either downstream call. It is the
          // endpoint that actually SENDS mail, so a wrong platform there reaches
          // a real person under the wrong brand — strictly worse than /ingest.
          const compose = (body: any): { status: number; body: any } => {
            let out = { status: 200, body: undefined as any };
            const req: any = {
              method: "POST", url: "/compose", query: {}, body,
              headers: { "x-admin-key": "crm-vertical-test-key" },
              get(name: string) { return this.headers[name.toLowerCase()]; },
            };
            const res: any = {
              statusCode: 200,
              status(c: number) { this.statusCode = c; return this; },
              json(p: any) { out = { status: this.statusCode, body: p }; return this; },
            };
            router.handle(req, res, () => { /* unmatched */ });
            return out;
          };
          const composeBody = {
            to: "compose-rute@example.no", subject: "Emne", bodyText: "Tekst",
            intent: "gmail_draft", createdBy: "daniel",
          };

          const cBefore = countRows();
          const cMissing = compose({ ...composeBody });
          assertEq(cMissing.status, 400, "cv37: /compose WITHOUT vertical is rejected — it is the endpoint that sends mail");
          assertEq(countRows(), cBefore, "cv38: …and wrote nothing");

          compose({ ...composeBody, vertical: "experiences" });
          const cThread = db.prepare(
            "SELECT t.vertical_id tv, c.vertical_id cv FROM crm_threads t JOIN crm_contacts c ON c.id = t.contact_id WHERE t.subject = 'Emne'"
          ).get() as any;
          assertEq(cThread?.tv, "experiences", "cv39: …and with a vertical the thread lands on the named platform");
          assertEq(cThread?.cv, "experiences", "cv39b: …as does the contact — not hardcoded to rfb on either call");
          // REVIEW T8: cv39/cv39b cover composeNewThread's two rows. The route
          // makes a SECOND downstream call — enqueueOutbox — and hardcoding
          // 'rfb' there survived, because nothing read the outbox row. That is
          // the row the sender actually acts on.
          const cOut = db.prepare(
            "SELECT vertical_id FROM crm_outbox WHERE subject = 'Emne' ORDER BY rowid DESC LIMIT 1"
          ).get() as any;
          assertEq(cOut?.vertical_id, "experiences",
            "cv39c: …and so is the OUTBOX row — the one the sender acts on, reached by a separate call the other two assertions never touch");

          // ── cv40-cv41: REVIEW B4 — a thread cannot change platform ──
          //
          // CS ingest is idempotent by design and re-sends the same Gmail
          // threadIds every run. Before the guard, re-ingesting an 'rfb' thread
          // as 'experiences' left the thread 'rfb', stamped the NEW messages
          // 'experiences', and stranded a second contact attached to nothing.
          const conflict = post({
            threadId: "cv-route-1",
            vertical: "rfb",
            primaryFromEmail: "rute@example.no",
            messages: [{ messageId: "cv-route-msg-2", direction: "in", fromEmail: "rute@example.no" }],
          });
          assertEq(conflict.status, 409,
            "cv40: re-ingesting an 'experiences' thread as 'rfb' is refused — a conversation does not change platform");
          const stray = db.prepare("SELECT COUNT(*) n FROM crm_messages WHERE id = 'cv-route-msg-2'").get() as any;
          assertEq(stray?.n, 0,
            "cv41: …and nothing was half-written — the refusal is whole, so the caller can safely retry the same immutable thread");
        } finally {
          if (prevAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
          else process.env.ANALYTICS_ADMIN_KEY = prevAdminKey;
        }
      }
      // ═══════════════════════════════════════════════════════════════
      // cv42-cv45 — REVIEW B3: POST /api/contact, the PUBLIC form.
      //
      // This endpoint is live on all three domains and is the only CRM write
      // path a stranger can reach. Two defects, both measured on the real
      // router before the fix:
      //
      //   (a) its contact lookup was `WHERE email = ?` with no vertical, so a
      //       form submitted on opplevagent.no attached its thread to the RETT
      //       FRA BONDEN contact — an `experiences` thread owned by an `rfb`
      //       contact, invisible to listContacts(vertical:'experiences'). Under
      //       the new UNIQUE(email, vertical_id) an email no longer identifies a
      //       row at all, so the unscoped lookup was not just wrong, it was
      //       undefined behaviour.
      //   (b) its crm_messages INSERT named no vertical_id, so every message
      //       from the form fell on the column default 'rfb' — even when its own
      //       contact and thread were correctly stamped 'experiences'.
      //
      // (a) is also the duplicate-manufacturing path that ARMS the cv31 crash:
      // form-first then CS-ingest produced two contacts sharing an email.
      // ═══════════════════════════════════════════════════════════════
      {
        const prevSkip = process.env.SKIP_TURNSTILE;
        process.env.SKIP_TURNSTILE = "true";
        try {
          const contactRoutes = require("../routes/contact") as any;
          const contactRouter = contactRoutes.default ?? contactRoutes;

          // The route is POST /contact (not "/"), and it is async — the first
          // version of this helper posted to "/" and therefore never reached
          // the handler at all. Every assertion below then read a DIFFERENT
          // thread that happened to match its LIKE pattern, and the whole block
          // passed while testing nothing. Both bugs are named here because the
          // failure mode — green assertions over an unexecuted route — is the
          // one this suite exists to catch elsewhere.
          const submit = async (body: any): Promise<number> => {
            const req: any = {
              method: "POST", url: "/contact", query: {}, body,
              headers: { host: "opplevagent.no" },
              get(n: string) { return this.headers[n.toLowerCase()]; },
              ip: "203.0.113.9",
            };
            let settle: () => void;
            const done = new Promise<void>((r) => { settle = r; });
            const res: any = {
              statusCode: 200,
              status(c: number) { this.statusCode = c; return this; },
              json() { settle(); return this; },
            };
            contactRouter.handle(req, res, () => settle());
            await done;
            return res.statusCode;
          };

          // Same address already exists as an RFB contact (created by cv13).
          const SHARED = "bonde@begge-steder.no";
          const before = (db.prepare("SELECT COUNT(*) n FROM crm_contacts WHERE email = ?").get(SHARED) as any).n;

          await submit({
            name: "Kari", email: SHARED, subject: "KONTAKTSKJEMA-CV42",
            message: "Hei, jeg vil booke", platform: "experiences",
          });

          const after = (db.prepare("SELECT COUNT(*) n FROM crm_contacts WHERE email = ?").get(SHARED) as any).n;
          assertEq(after, before,
            "cv42: an experiences form submission reuses the EXISTING experiences contact — it does not manufacture a duplicate that would crash the next boot");

          const th = db.prepare(
            "SELECT t.vertical_id tv, c.vertical_id cv FROM crm_threads t JOIN crm_contacts c ON c.id = t.contact_id WHERE t.subject LIKE '%KONTAKTSKJEMA-CV42%' ORDER BY t.rowid DESC LIMIT 1"
          ).get() as any;
          assertEq(th?.tv, "experiences", "cv43: the thread is stamped experiences…");
          assertEq(th?.cv, "experiences",
            "cv44: …and is owned by the EXPERIENCES contact, not the rfb one — this is the mixing Daniel named, on the one endpoint the public can reach");

          const msg = db.prepare(
            "SELECT m.vertical_id FROM crm_messages m JOIN crm_threads t ON t.id = m.thread_id WHERE t.subject LIKE '%KONTAKTSKJEMA-CV42%' ORDER BY m.rowid DESC LIMIT 1"
          ).get() as any;
          assertEq(msg?.vertical_id, "experiences",
            "cv45: …and so is the message — its INSERT named no vertical_id at all, so it fell on the 'rfb' default while its own thread said experiences");
        } finally {
          if (prevSkip === undefined) delete process.env.SKIP_TURNSTILE;
          else process.env.SKIP_TURNSTILE = prevSkip;
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // cv31-cv33 — REVIEW B1: initSchema must survive the SECOND boot.
      //
      // The first version of this migration re-created UNIQUE(email) in the DDL
      // block on every boot while dropping it further down, so from boot 2 the
      // DROP stopped being a no-op — SQLite rebuilt the index and validated it
      // against data that, by then, legally held two contacts sharing an email.
      // It threw out of initSchema(), out of getDb(), and index.ts calls getDb()
      // at module top level: the process never reached app.listen(). A crash
      // loop on the production database, arriving one restart after the first
      // genuine cross-vertical contact.
      //
      // The suite could not see it because it called __initSchemaForTesting
      // exactly once. This block calls it again, with the duplicate pair from
      // cv13-cv17 already in the table.
      // ═══════════════════════════════════════════════════════════════
      {
        let threw: string | null = null;
        try { initMod.__initSchemaForTesting(db as any); } catch (e: any) { threw = String(e?.message ?? e); }
        assertEq(threw, null, "cv31: a SECOND initSchema pass on a DB holding a cross-vertical contact pair does not throw");

        try { initMod.__initSchemaForTesting(db as any); } catch (e: any) { threw = String(e?.message ?? e); }
        assertEq(threw, null, "cv32: …nor a third — this runs on every boot, so it must be idempotent across BOOTS, not just DB states");

        // And the migration must not have quietly stopped protecting anything.
        let dupRejected = false;
        try {
          db.prepare(`INSERT INTO crm_contacts (id, type, email, vertical_id) VALUES ('cv31-dup','unknown','bonde@begge-steder.no','rfb')`).run();
        } catch { dupRejected = true; }
        assertTrue(dupRejected,
          "cv33: …and a true duplicate is STILL rejected after repeated boots — surviving the boot must not mean losing uniqueness");
      }

      // ═══════════════════════════════════════════════════════════════
      // cv34-cv36 — REVIEW V1-V3: the READ side.
      //
      // vSql() could be reduced to `return ""` — deleting the vertical filter
      // from listContacts, countContactsByType and getDashboardSummary — and the
      // entire suite stayed green. The write side was pinned; the half a human
      // actually looks at was not. These read back the two-platform contact pair
      // that cv13-cv17 created.
      // ═══════════════════════════════════════════════════════════════
      {
        const rfbOnly = crm.crmService.listContacts("unknown", { vertical: "rfb", limit: 500 });
        const expOnly = crm.crmService.listContacts("unknown", { vertical: "experiences", limit: 500 });
        const shared = "bonde@begge-steder.no";
        assertEq(rfbOnly.filter((c: any) => c.email === shared).length, 1,
          "cv34: listContacts(vertical:'rfb') returns the rfb contact…");
        assertEq(expOnly.filter((c: any) => c.email === shared).length, 1,
          "cv35: …and listContacts(vertical:'experiences') the OTHER one — one row each, not both in both");
        const bothRfb = rfbOnly.filter((c: any) => c.email === shared)[0];
        const bothExp = expOnly.filter((c: any) => c.email === shared)[0];
        assertTrue(bothRfb?.id !== bothExp?.id,
          "cv36: …and they are genuinely different rows, so deleting the vertical filter from vSql cannot pass");
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
