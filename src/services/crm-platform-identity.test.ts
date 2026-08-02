/**
 * crm-platform-identity.test.ts — dev-request
 * 2026-07-27-crm-plattformadskillelse-opplevagent, steg 3 + its precondition.
 *
 * Funn 2, observed live in Daniel's Gmail 18 July (booking GARD-20260718-C5EEN):
 * a gårdssalg producer's booking notice arrived `From: kontakt@rettfrabonden.com`
 * carrying Opplevagent content. Not theoretical — production.
 *
 *   pi1-pi8    resolveCrmIdentity / crmFromHeader. Fail-closed, and the From
 *              header is RFC 5322 shaped with the display name escaped.
 *   pi9-pi16   THE SEND PATH. Asserted on the mail options that would reach the
 *              transport — not on a return value, and not on the identity
 *              helper's output. A helper can be perfect while nothing calls it;
 *              that is exactly how lokal#377's cap was deletable with 10 443
 *              tests green.
 *   pi17-pi22  The steg-3 PRECONDITION: outreach_sent_log is an RFB-only
 *              ledger, so an `experiences` send must not write a suppression
 *              row against an RFB agent_id. A silent under-send — the producer
 *              simply stops being contacted and nothing errors.
 *
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/services/crm-platform-identity.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runCrmPlatformIdentityTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    try { fn(); assertTrue(false, `${label} — expected a throw, got a return`); }
    catch (e: any) {
      const msg = String(e?.message ?? e);
      assertTrue(expect.test(msg), `${label} (message ${JSON.stringify(msg)} must match ${expect})`);
    }
  }

  return (async () => {
    const prevDb = initMod.__peekDbForTesting();
    const db = new Database(":memory:");
    const ident = require("./crm-platform-identity") as typeof import("./crm-platform-identity");

    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      // ═══════════════════════════════════════════════════════════════
      // pi1-pi8 — the identity table itself.
      // ═══════════════════════════════════════════════════════════════
      assertEq(ident.resolveCrmIdentity("experiences").displayName, "Opplevagent",
        "pi1: experiences reads as Opplevagent in the inbox list");
      assertEq(ident.resolveCrmIdentity("experiences").replyTo, "kontakt@opplevagent.no",
        "pi2: …and replies land on the Opplevagent forwarder — the inbound discriminator steg 4 needs");
      assertEq(ident.resolveCrmIdentity("rfb").displayName, "Rett fra Bonden",
        "pi3: rfb is unchanged");
      assertEq(ident.resolveCrmIdentity("rfb").replyTo, "kontakt@rettfrabonden.com",
        "pi4: …including its reply-to");
      assertTrue(
        ident.resolveCrmIdentity("experiences").displayName !== ident.resolveCrmIdentity("rfb").displayName,
        "pi5: the two platforms are genuinely DISTINGUISHABLE — asserting each alone would pass if both said the same thing");
      assertTrue(
        ident.resolveCrmIdentity("experiences").replyTo !== ident.resolveCrmIdentity("rfb").replyTo,
        "pi5b: …on reply-to too, which is what keeps the return path separable");

      assertThrows(() => ident.resolveCrmIdentity(undefined), /vertical must be one of/,
        "pi6: no vertical refuses to send rather than defaulting to the RFB identity");
      assertThrows(() => ident.resolveCrmIdentity("opplevagent"), /vertical must be one of/,
        "pi7: a plausible typo refuses too");

      assertEq(ident.crmFromHeader("experiences"), '"Opplevagent" <kontakt@rettfrabonden.com>',
        "pi8: the From header is RFC 5322 display-name form over the one Resend-verified address");

      // pi8b — the escaping, driven through the REAL function.
      //
      // The first version of this assertion re-typed the regex inside the test
      // and compared the result against itself. It never called crmFromHeader,
      // so deleting the escaping from the shipped function left it green: a
      // tautology dressed as a test. It is called out here because the failure
      // mode — an assertion that cannot fail — is the one this whole suite
      // exists to catch elsewhere.
      {
        const mod = require("./crm-platform-identity");
        const table = mod.__identityTableForTesting();
        const prevName = table.rfb.displayName;
        try {
          table.rfb.displayName = 'Bonde "Ola" Nordmann';
          assertEq(mod.crmFromHeader("rfb"), '"Bonde \\"Ola\\" Nordmann" <kontakt@rettfrabonden.com>',
            "pi8b: a quote in the display name is escaped by crmFromHeader itself — an unescaped one truncates the From header at the stray quote, which is a deliverability failure, not a cosmetic one");
          table.rfb.displayName = "Back\\slash";
          assertEq(mod.crmFromHeader("rfb"), '"Back\\\\slash" <kontakt@rettfrabonden.com>',
            "pi8c: …and so is a backslash — escaping only the quote leaves a trailing escape that swallows the closing delimiter");
        } finally {
          table.rfb.displayName = prevName;
        }
      }

      // A3/A4 — every platform must be distinguishable from every other, not
      // merely experiences-from-rfb. `dental` had zero assertions, so it could
      // silently inherit another platform's brand. Iterating CRM_VERTICALS means
      // a fourth vertical is covered the day it is added.
      {
        const crmMod = require("./crm-service") as typeof import("./crm-service");
        const names = crmMod.CRM_VERTICALS.map((v) => ident.resolveCrmIdentity(v).displayName);
        assertEq(new Set(names).size, crmMod.CRM_VERTICALS.length,
          `pi8d: every vertical has a DISTINCT display name (${names.join(" / ")}) — a platform must not be able to inherit another's brand`);
        for (const v of crmMod.CRM_VERTICALS) {
          const id = ident.resolveCrmIdentity(v);
          assertTrue(!!id.displayName && !!id.replyTo,
            `pi8e[${v}]: …and both fields are populated — a half-configured vertical would send under a blank brand`);
        }
        // pi8f — reply-to is what preserves the INBOUND discriminator, and
        // nothing pinned it per vertical: swapping dental's to the opplevagent
        // address left the suite green. A distinctness set would over-constrain
        // (rfb and dental legitimately share one address today), so the property
        // is narrower and exact: opplevagent.no belongs to experiences alone.
        const onOpplevagent = crmMod.CRM_VERTICALS.filter(
          (v) => ident.resolveCrmIdentity(v).replyTo.endsWith("@opplevagent.no"),
        );
        assertEq(onOpplevagent.join(","), "experiences",
          "pi8f: EXACTLY ONE vertical replies to opplevagent.no — a second would route another platform's replies through the Opplevagent forwarder and destroy the steg-4 discriminator");
      }

      // ═══════════════════════════════════════════════════════════════
      // pi9-pi16 — THE SEND PATH, through the real route and a real
      // transport stub. This is the part that can rot silently: the helper
      // above could be perfect while no caller uses it.
      // ═══════════════════════════════════════════════════════════════
      {
        // dev-request 2026-08-02-crm-summary-401-auth: crm.ts's requireAdminAuth
        // now checks ADMIN_KEY first (fleet-wide pattern), ANALYTICS_ADMIN_KEY
        // as fallback — previously the reverse. process.env.ADMIN_KEY is
        // pinned suite-wide (tests/test.ts's SUITE_ADMIN_KEY) to a value this
        // block doesn't know, so it must now also pin ADMIN_KEY itself to the
        // key it sends below, not just ANALYTICS_ADMIN_KEY. Both saved and
        // restored regardless.
        const prevAdminKey = process.env.ADMIN_KEY;
        const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
        const prevSmtp = {
          host: process.env.SMTP_HOST, port: process.env.SMTP_PORT,
          user: process.env.SMTP_USER, pass: process.env.SMTP_PASS,
        };
        // Determinisme (2026-08-02): adopter suitens kanoniske nøkler når de
        // finnes — aldri bytt de prosess-globale verdiene midt i en kjøring
        // (se SHARED GLOBAL STATE-kontrakten i tests/test.ts). Literal kun som
        // standalone-fallback.
        const crmIdentityKey = process.env.ADMIN_KEY || "crm-identity-test-key";
        process.env.ADMIN_KEY = crmIdentityKey;
        process.env.ANALYTICS_ADMIN_KEY = process.env.ANALYTICS_ADMIN_KEY || crmIdentityKey;

        const emailMod = require("./email-service") as typeof import("./email-service");
        const svc = emailMod.emailService as any;
        const realSendRaw = svc.sendRaw.bind(svc);
        const sent: any[] = [];
        // Capture what the SEND would carry. Stubbing sendRaw keeps the assertion
        // on the arguments the route builds, which is the thing under test.
        svc.sendRaw = async (o: any) => { sent.push(o); return { success: true, messageId: "stub-1" }; };

        try {
          const crmRoutes = require("../routes/crm") as any;
          const router = crmRoutes.default ?? crmRoutes.router ?? crmRoutes;

          const post = async (url: string, body: any): Promise<{ status: number }> => {
            const req: any = {
              method: "POST", url, query: {}, body,
              headers: { "x-admin-key": crmIdentityKey },
              get(n: string) { return this.headers[n.toLowerCase()]; },
            };
            let settle: () => void;
            const done = new Promise<void>((r) => { settle = r; });
            const res: any = {
              statusCode: 200,
              status(c: number) { this.statusCode = c; return this; },
              json() { settle(); return this; },
            };
            router.handle(req, res, () => settle());
            await done;
            return { status: res.statusCode };
          };

          // ── compose on experiences ──
          sent.length = 0;
          await post("/compose", {
            to: "gjest@example.no", subject: "Booking bekreftet", bodyText: "Hei",
            intent: "resend_send", createdBy: "daniel", vertical: "experiences",
          });
          assertEq(sent.length, 1, "pi9: an experiences compose reaches the transport exactly once");
          assertEq(sent[0]?.from, '"Opplevagent" <kontakt@rettfrabonden.com>',
            "pi10: …branded Opplevagent — this is funn 2, the booking notice that went out as Rett fra Bonden");
          assertEq(sent[0]?.replyTo, "kontakt@opplevagent.no",
            "pi11: …with the Opplevagent reply-to, so the reply comes back through the right forwarder");

          // ── compose on rfb, same endpoint ──
          sent.length = 0;
          await post("/compose", {
            to: "bonde@example.no", subject: "Hei", bodyText: "Hei",
            intent: "resend_send", createdBy: "daniel", vertical: "rfb",
          });
          assertEq(sent[0]?.from, '"Rett fra Bonden" <kontakt@rettfrabonden.com>',
            "pi12: the SAME endpoint brands an rfb send as Rett fra Bonden…");
          assertEq(sent[0]?.replyTo, "kontakt@rettfrabonden.com",
            "pi13: …with its own reply-to. Asserting only the experiences case would pass on a hardcoded constant");

          // ── reply on an existing thread: identity from the THREAD ──
          sent.length = 0;
          const seedThread = () => {
            const contact = require("./crm-service").crmService.resolveContact("tr@example.no", null, "experiences");
            db.prepare(`INSERT INTO crm_threads (id, contact_id, subject, category, severity, vertical_id)
                        VALUES ('pi-thread','${contact.id}','Emne','innkommende','normal','experiences')`).run();
          };
          seedThread();
          await post("/threads/pi-thread/send", {
            intent: "resend_send", toEmails: ["tr@example.no"],
            subject: "Svar", bodyText: "Hei igjen", createdBy: "daniel",
            // Ask for the WRONG platform — the thread must win.
            vertical: "rfb",
          });
          assertEq(sent[0]?.from, '"Opplevagent" <kontakt@rettfrabonden.com>',
            "pi14: a reply is branded by the THREAD's platform, not by what the caller asked for");
          assertEq(sent[0]?.replyTo, "kontakt@opplevagent.no",
            "pi15: …reply-to too — otherwise the answer to an Opplevagent conversation returns down the RFB pipe");

          // ── the address never changes ──
          assertTrue(
            String(sent[0]?.from).includes("<kontakt@rettfrabonden.com>"),
            "pi16: every platform still sends FROM the one Resend-verified address — the brand is the display name, not a second domain");

          // ── pi16b-pi16d: the REAL sendRaw must honour the override ──
          //
          // Everything above stubs sendRaw, so it tests what the ROUTE builds
          // and nothing about what sendRaw does with it. Mutation showed that:
          // making sendRaw ignore `options.from` entirely left all 24
          // assertions green, i.e. the route could hand over a perfect From
          // header and the transport would drop it on the floor. Same shape as
          // the cap that was deletable in lokal#377.
          //
          // So this drives the real method against a stub TRANSPORTER and reads
          // the mail options that would go on the wire.
          svc.sendRaw = realSendRaw;
          const prevConfigured = svc.isConfigured;
          const prevTransporter = svc.transporter;
          const wire: any[] = [];
          svc.isConfigured = true;
          svc.transporter = { sendMail: async (o: any) => { wire.push(o); return { messageId: "wire-1" }; } };
          try {
            await svc.sendRaw({
              to: "x@example.no", subject: "S", textContent: "T",
              from: '"Opplevagent" <kontakt@rettfrabonden.com>',
              replyTo: "kontakt@opplevagent.no",
            });
            assertEq(wire.length, 1, "pi16b: the real sendRaw reaches the transport");
            assertEq(wire[0]?.from, '"Opplevagent" <kontakt@rettfrabonden.com>',
              "pi16c: …and puts the caller's From on the wire — dropping the override was invisible to every assertion above");
            assertEq(wire[0]?.replyTo, "kontakt@opplevagent.no",
              "pi16d: …and the caller's reply-to with it");

            // pi16e — REPORTED FIXED AND WAS NOT. The first version called
            // sendRaw without `from`; `this.fromAddress` threw because
            // loadConfigsAtBoot() had not run, sendRaw caught it, nothing
            // reached the transport, `wire` stayed empty, and the assertion was
            // trivially true against `undefined`. A vacuous test that I then
            // described as closed. Booting the config makes the fallback real.
            const { loadConfigsAtBoot: boot } = require("../config/vertical-config");
            try { boot(); } catch { /* already loaded */ }
            wire.length = 0;
            await svc.sendRaw({ to: "x@example.no", subject: "S", textContent: "T" });
            assertEq(wire.length, 1,
              "pi16e: omitting `from` still SENDS — the previous version of this assertion passed on an empty wire, which is no assertion at all");
            assertEq(wire[0]?.from, "kontakt@rettfrabonden.com",
              "pi16e2: …falling back on the configured address, bare and unquoted — the override adds a case, it does not replace the old one");
          } finally {
            svc.isConfigured = prevConfigured;
            svc.transporter = prevTransporter;
            svc.sendRaw = async (o: any) => { sent.push(o); return { success: true, messageId: "stub-1" }; };
          }
        } finally {
          svc.sendRaw = realSendRaw;
          if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
          else process.env.ADMIN_KEY = prevAdminKey;
          if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
          else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
          for (const [k, v] of Object.entries(prevSmtp)) {
            const key = "SMTP_" + k.toUpperCase();
            if (v === undefined) delete process.env[key]; else process.env[key] = v;
          }
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // pi16f-pi16h — THE BOOKING PATH, which is where funn 2 was ACTUALLY seen.
      //
      // The first version of this branch wired only sendRaw, whose two callers
      // are both CRM routes. A reviewer measured that the booking notice Daniel
      // screenshotted goes through sendEmail instead, and still came out as a
      // bare `kontakt@rettfrabonden.com` with no display name at all. So steg 3
      // closed funn 2 everywhere except the one place funn 2 was observed.
      //
      // Deleting `from:` from the booking call sites has to fail HERE.
      // ═══════════════════════════════════════════════════════════════
      {
        const { loadConfigsAtBoot } = require("../config/vertical-config");
        try { loadConfigsAtBoot(); } catch { /* already loaded */ }
        const emailMod2 = require("./email-service") as any;
        const svc2 = emailMod2.emailService;
        const prevConf = svc2.isConfigured;
        const prevTrans = svc2.transporter;
        const wire2: any[] = [];
        svc2.isConfigured = true;
        svc2.transporter = { sendMail: async (o: any) => { wire2.push(o); return { messageId: "bw" }; } };
        try {
          await svc2.sendGardssalgClaimMagicLink({
            to: "produsent@example.no", providerName: "Dobel Gård",
            magicUrl: "https://opplevagent.no/claim/x",
          });
          assertEq(wire2.length, 1, "pi16f: the Opplevagent claim mail reaches the transport");
          assertEq(wire2[0]?.from, '"Opplevagent" <kontakt@rettfrabonden.com>',
            "pi16g: …branded Opplevagent — before this it was a bare address with NO display name, which is the header from funn 2");
          assertEq(wire2[0]?.replyTo, "kontakt@opplevagent.no",
            "pi16h: …and still replies to the Opplevagent forwarder");

          // ── pi16i-pi16p: ALL SEVEN booking-store senders ──
          //
          // pi16f-pi16h cover the CLAIM mail only. A reviewer deleted each of
          // the seven `from:` lines in booking-store.ts individually and every
          // one survived — including :610, `sendProducerNotification`, which IS
          // the GARD-20260718-C5EEN mail Daniel screenshotted. Deleting that one
          // line left the FULL suite at 11650/3, byte-identical to clean.
          //
          // So the fix was correct today and undefended tomorrow on the exact
          // path that carried the bug into production unnoticed for weeks. Each
          // sender gets its own assertion; a loop keeps a future eighth sender
          // from being forgotten only if someone adds it here, so the names are
          // spelled out deliberately rather than discovered by reflection.
          // The gated producer senders read `experience_providers` from the
          // EXPERIENCES database (db-factory, a different file from the rfb one
          // this harness injects). Point it at a scratch file and seed one
          // provider, so the gate opens and the shared `from:` line inside
          // sendGatedProducerEmail is actually reached. Without this the loop
          // below would silently cover 5 of 7 while reporting all-green.
          const os = require("os"), fsm = require("fs"), pathm = require("path");
          const scratchDir = fsm.mkdtempSync(pathm.join(os.tmpdir(), "pi-exp-"));
          const prevExpDb = process.env.EXPERIENCES_DB_PATH;
          process.env.EXPERIENCES_DB_PATH = pathm.join(scratchDir, "experiences.db");
          const dbf = require("../database/db-factory") as any;
          dbf.__resetDbFactoryForTesting?.();
          // REVIEW T5 — assert the redirect took, BEFORE seeding anything.
          //
          // Without the env line above, db-factory falls back to
          // /app/data/experiences.db (db-factory.ts:63) — the production path —
          // and the CREATE TABLE IF NOT EXISTS + INSERT OR REPLACE below happily
          // seed a REAL database. A reviewer demonstrated exactly that: mtime
          // advanced and the fixture provider was present in the live file
          // afterwards. The suite would have stayed green the whole time.
          //
          // Deleting the redirect must fail HERE, loudly, before any write.
          assertTrue(
            String(process.env.EXPERIENCES_DB_PATH ?? "").startsWith(scratchDir),
            `pi16i-guard: EXPERIENCES_DB_PATH points inside the scratch dir (${process.env.EXPERIENCES_DB_PATH}) — without this the seeding below writes to the PRODUCTION experiences database and nothing complains`);
          const expDb = dbf.getDb("experiences");
          expDb.exec(`CREATE TABLE IF NOT EXISTS experience_providers (
            id TEXT PRIMARY KEY, navn TEXT, epost TEXT, booking_live INTEGER, catalog_hidden INTEGER)`);
          expDb.prepare(`INSERT OR REPLACE INTO experience_providers (id, navn, epost, booking_live, catalog_hidden)
                         VALUES ('prov-1','Dobel Gård','produsent@example.no',1,1)`).run();
          // catalog_hidden = 1 on purpose: that is booking-store's documented
          // "hidden, admin-created, email-pinned test provider" case, which
          // dispatches without the global master switch. A real provider
          // (catalog_hidden = 0) additionally needs bookingDispatchEnabled(),
          // and flipping a global env just to reach a From header would test
          // the switch rather than the header.

          const booking = require("./booking-store") as any;
          const fixture = {
            booking_id: "pi-bk-1", experience_id: null, provider_id: "prov-1",
            slot_at: new Date(Date.parse("2026-09-01T10:00:00Z")).toISOString(),
            party_size: 2, guest_name: "Kari", guest_email: "kari@example.no",
            guest_phone: null, booking_ref: "GARD-PI-TEST", confirm_token: "tok-1",
            source: "test", status: "pending", resolved_by: null, resolved_at: null,
            commission_rate: null, billable: 0, notes: null,
            created_at: new Date(Date.parse("2026-08-01T10:00:00Z")).toISOString(),
            respond_token: "rt-1", previsit_status: null, previsit_suggested_at: null,
            // sendSuggestionToGuest bails without BOTH of these — it returned
            // early and sent nothing on the first attempt, which the loop
            // correctly reported as an unpinnable assertion rather than a pass.
            guest_decision_token: "gdt-1",
            suggested_slot_at: new Date(Date.parse("2026-09-02T12:00:00Z")).toISOString(),
            is_test: 0,
          };
          const senders: Array<[string, () => Promise<unknown>]> = [
            ["sendBookingConfirmation (gjestekvittering)", () => booking.sendBookingConfirmation(fixture)],
            ["sendProducerNotification (FUNN 2 — produsentvarselet)", () => booking.sendProducerNotification(fixture, "produsent@example.no")],
            ["sendPrevisitConfirmedToGuest", () => booking.sendPrevisitConfirmedToGuest(fixture)],
            ["sendPrevisitDeclinedToGuest", () => booking.sendPrevisitDeclinedToGuest(fixture)],
            ["sendSuggestionToGuest", () => booking.sendSuggestionToGuest(fixture)],
            ["sendPrevisitExpiredToGuest", () => booking.sendPrevisitExpiredToGuest(fixture)],
            ["sendPrevisitReminderToProducer (gated)", () => booking.sendPrevisitReminderToProducer(fixture)],
          ];
          let covered = 0;
          for (const [label, run] of senders) {
            wire2.length = 0;
            try { await run(); } catch { /* a sender may bail on missing DB state — asserted below */ }
            if (wire2.length === 0) {
              assertTrue(false, `pi16i[${label}]: sent nothing — this assertion cannot pin a From header it never sees`);
              continue;
            }
            covered++;
            assertEq(wire2[0]?.from, '"Opplevagent" <kontakt@rettfrabonden.com>',
              `pi16i[${label}]: branded Opplevagent`);
          }
          assertEq(covered, senders.length,
            `pi16p: ALL ${senders.length} booking senders actually reached the transport (${covered}) — a loop whose fixtures make senders bail would report all-green while pinning nothing`);
          if (prevExpDb === undefined) delete process.env.EXPERIENCES_DB_PATH;
          else process.env.EXPERIENCES_DB_PATH = prevExpDb;
          try { expDb.close(); } catch { /* already closed */ }
          dbf.__resetDbFactoryForTesting?.();
          try { fsm.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
        } finally {
          svc2.isConfigured = prevConf;
          svc2.transporter = prevTrans;
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // pi17-pi22 — THE STEG-3 PRECONDITION.
      //
      // outreach_sent_log gates outreach_ready_pool, whose rows are RFB
      // catalogue agents. Its triggers resolve an agent_id from the RFB tables
      // BY EMAIL. So before this guard, an Opplevagent send to a producer who
      // is also an RFB agent wrote a suppression row against that RFB agent_id
      // and dropped them from RFB outreach permanently.
      //
      // A silent under-send: nothing errors, the producer simply stops being
      // contacted, and the absence of an email is not something anyone notices.
      // ═══════════════════════════════════════════════════════════════
      {
        db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
                    VALUES ('agent-doble','Doble Gård','x','test','doble@example.no','https://doble.example.no','producer','pi-key-1',1)`).run();
        // Make the agent genuinely POOL-ELIGIBLE. Without this the pool assertions
        // below would read false for reasons that have nothing to do with
        // suppression — a test that "passes" because its fixture never qualified
        // proves nothing about the clause under test.
        db.prepare(`INSERT INTO agent_knowledge (agent_id, email, verification_status, enrichment_status,
                      url_last_status, url_last_probed)
                    VALUES ('agent-doble','doble@example.no','verified','rich',200,datetime('now'))`).run();

        const mkSend = (vertical: string, msgId: string) => {
          const c = require("./crm-service").crmService.resolveContact("doble@example.no", null, vertical);
          const tid = `pi-osl-${vertical}`;
          db.prepare(`INSERT INTO crm_threads (id, contact_id, subject, category, severity, vertical_id)
                      VALUES (?,?,'Utsending','marketing','normal',?)`).run(tid, c.id, vertical);
          db.prepare(`INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, cc_emails,
                        subject, body_text, sent_at, raw_metadata, delivery_status, vertical_id)
                      VALUES (?,?,'out','kontakt@rettfrabonden.com','[]','[]','Utsending','x',datetime('now'),'{}','sent',?)`)
            .run(msgId, tid, vertical);
        };

        const oslRows = () => db.prepare(
          `SELECT o.vertical_id AS v, o.recipient_email AS email FROM outreach_sent_log o ORDER BY o.rowid`
        ).all() as any[];
        const inPool = () => !!db.prepare(
          `SELECT 1 FROM outreach_ready_pool WHERE agent_id = 'agent-doble'`
        ).get();

        // ── The design, after review B2 ──
        //
        // outreach_sent_log serves TWO purposes the original schema conflated,
        // and they want OPPOSITE scopes:
        //
        //   the 60-day cold-outreach cooldown  → keyed on the recipient EMAIL,
        //     must stay CROSS-PLATFORM. Mailing the same human as "Rett fra
        //     Bonden" on Monday and "Opplevagent" on Wednesday is spam however
        //     clean the data model is.
        //   the outreach_ready_pool exclusion  → keyed on the RFB agent, must be
        //     RFB-ONLY. An Opplevagent send must never drop a producer out of
        //     RFB outreach.
        //
        // The first attempt guarded the WRITE, which fixed the pool and silently
        // deleted the cooldown for every non-rfb vertical — a reviewer measured
        // the same recipient being cold-mailed twice two days apart. The row is
        // now always written and STAMPED instead, and the pool scopes its read.
        mkSend("experiences", "pi-msg-exp");
        assertEq(oslRows().length, 1,
          "pi17: an EXPERIENCES send DOES write an outreach_sent_log row — the 60-day cooldown protects the human, not the platform");
        assertEq(oslRows()[0]?.v, "experiences",
          "pi17b: …stamped with its own platform, which is what lets the two readers disagree");
        assertTrue(inPool(),
          "pi18: …and the RFB producer is STILL in the RFB outreach pool — an Opplevagent send must not suppress them there");

        mkSend("rfb", "pi-msg-rfb");
        assertEq(oslRows().length, 2,
          "pi19: an RFB send writes its row too…");
        assertEq(oslRows()[1]?.v, "rfb", "pi19b: …stamped rfb");
        assertTrue(!inPool(),
          "pi20: …and THAT one does drop them out of the pool — the scoping narrows suppression, it does not disable it");

        // And the trigger definitions must actually carry the guard in the
        // database, not merely in the source: they are created IF NOT EXISTS,
        // so without an explicit DROP an edit here is a no-op on any DB that
        // already has them — i.e. on production.
        for (const t of ["trg_log_cold_outreach_to_sent_log_v2", "trg_log_cold_outreach_on_send_confirm_v2"]) {
          const r = db.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?`).get(t) as any;
          assertTrue(String(r?.sql ?? "").includes("NEW.vertical_id"),
            `pi21/pi22: ${t} STAMPS the platform onto the row IN THE DATABASE — CREATE IF NOT EXISTS makes a source-only edit invisible on an existing DB`);
        }

        // ── pi23-pi24: THE UPGRADE PATH for the triggers ──
        //
        // Every test DB is fresh, so the trigger never pre-exists and
        // CREATE IF NOT EXISTS always creates the new definition. Production is
        // the opposite: the OLD trigger is already there. Mutation confirmed the
        // gap — deleting the DROP left all assertions green while the fix became
        // a no-op on exactly the database that matters.
        //
        // This installs a guard-less trigger first, the way prod carries it, and
        // then re-runs initSchema.
        {
          const legacy = new Database(":memory:");
          try {
            initMod.__setDbForTesting(legacy as any);
            initMod.__initSchemaForTesting(legacy as any);
            legacy.exec(`DROP TRIGGER IF EXISTS trg_log_cold_outreach_to_sent_log_v2`);
            legacy.exec(`
              CREATE TRIGGER trg_log_cold_outreach_to_sent_log_v2
                AFTER INSERT ON crm_messages FOR EACH ROW
                WHEN NEW.direction = 'out' AND NEW.delivery_status = 'sent'
                BEGIN
                  INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes)
                  SELECT cc.agent_id, LOWER(cc.email), datetime('now'), 'email', NEW.id, 'legacy'
                  FROM crm_threads ct JOIN crm_contacts cc ON cc.id = ct.contact_id
                  WHERE ct.id = NEW.thread_id AND cc.agent_id IS NOT NULL;
                END
            `);
            // The CONFIRM trigger needs a pre-fix shape as well, or its upgrade
            // assertion is vacuous: a fresh initSchema already created the
            // stamping version, so nothing would have to be replaced and
            // deleting its DROP would be invisible. Measured — F4 survived
            // exactly this way.
            legacy.exec(`DROP TRIGGER IF EXISTS trg_log_cold_outreach_on_send_confirm_v2`);
            legacy.exec(`
              CREATE TRIGGER trg_log_cold_outreach_on_send_confirm_v2
                AFTER UPDATE OF delivery_status ON crm_messages FOR EACH ROW
                WHEN NEW.direction = 'out' AND NEW.delivery_status = 'sent'
                BEGIN
                  INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes)
                  SELECT cc.agent_id, LOWER(cc.email), datetime('now'), 'email', NEW.id, 'legacy-confirm'
                  FROM crm_threads ct JOIN crm_contacts cc ON cc.id = ct.contact_id
                  WHERE ct.id = NEW.thread_id AND cc.agent_id IS NOT NULL;
                END
            `);
            const beforeConf = (legacy.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_log_cold_outreach_on_send_confirm_v2'`).get() as any)?.sql ?? "";
            assertTrue(!beforeConf.includes("NEW.vertical_id"),
              "pi23b: …and so is the CONFIRM trigger's pre-fix shape");

            const before = (legacy.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_log_cold_outreach_to_sent_log_v2'`).get() as any)?.sql ?? "";
            assertTrue(!before.includes("NEW.vertical_id"),
              "pi23: the pre-fix production shape is in place — a trigger that does NOT stamp the platform");

            initMod.__initSchemaForTesting(legacy as any);   // the upgrade boot

            const after = (legacy.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_log_cold_outreach_to_sent_log_v2'`).get() as any)?.sql ?? "";
            assertTrue(after.includes("NEW.vertical_id"),
              "pi24: …and booting the new code REPLACES it with the stamping one — without the explicit DROP this whole fix is a no-op in production");

            // F4: the CONFIRM trigger — the path the marketing agent actually
            // takes — had no upgrade assertion at all, so its DROP was deletable.
            const conf = (legacy.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_log_cold_outreach_on_send_confirm_v2'`).get() as any)?.sql ?? "";
            assertTrue(conf.includes("NEW.vertical_id"),
              "pi24b: …and so is the CONFIRM trigger, which is the one the marketing agent actually uses — fixing the upgrade path on one trigger and not the other is half a fix");

            // ── pi25-pi27: the column DEFAULT, on a genuinely pre-column table.
            //
            // `DEFAULT 'rfb'` is the highest-consequence line in the diff and
            // nothing exercised it: every test DB creates the column and then
            // writes rows through the trigger, which stamps explicitly. In
            // production that default carries ~770 historical sends. Flip it to
            // 'experiences' and none of them match `o.vertical_id = 'rfb'`, the
            // pool's NOT EXISTS stops excluding them, and the ENTIRE contacted
            // history returns to the outreach pool — re-mailing everyone the
            // 2026-07-11 P0 fix exists to protect.
            //
            // So this rebuilds the table WITHOUT the column, the way prod had
            // it, writes an unstamped row for a pool-eligible agent, and boots.
            legacy.exec(`DROP VIEW IF EXISTS outreach_ready_pool`);
            legacy.exec(`DROP TABLE IF EXISTS outreach_sent_log`);
            legacy.exec(`CREATE TABLE outreach_sent_log (
              id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, sent_at TEXT,
              channel TEXT, message_id TEXT, notes TEXT, recipient_email TEXT)`);
            legacy.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
                            VALUES ('agent-legacy','Legacy Gård','x','test','legacy@example.no','https://l.example.no','producer','pi-key-2',1)`).run();
            legacy.prepare(`INSERT INTO agent_knowledge (agent_id, email, verification_status, enrichment_status, url_last_status, url_last_probed)
                            VALUES ('agent-legacy','legacy@example.no','verified','rich',200,datetime('now'))`).run();
            legacy.prepare(`INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes)
                            VALUES ('agent-legacy','legacy@example.no',datetime('now'),'email','legacy-msg-1','historical')`).run();

            initMod.__initSchemaForTesting(legacy as any);   // the upgrade boot

            const legacyRow = legacy.prepare(
              `SELECT vertical_id FROM outreach_sent_log WHERE message_id = 'legacy-msg-1'`
            ).get() as any;
            assertEq(legacyRow?.vertical_id, "rfb",
              "pi25: an UNSTAMPED historical row reads 'rfb' after the upgrade — every send before the split genuinely was rfb, and this default is what carries that fact");
            const stillSuppressed = !legacy.prepare(
              `SELECT 1 FROM outreach_ready_pool WHERE agent_id = 'agent-legacy'`
            ).get();
            assertTrue(stillSuppressed,
              "pi26: …and that producer is STILL excluded from the outreach pool — flipping this default returns the whole contacted history to the pool and re-mails everyone");
            const cnt = (legacy.prepare(`SELECT COUNT(*) n FROM outreach_sent_log`).get() as any).n;
            assertEq(cnt, 1,
              "pi27: …with the historical row preserved, not dropped and recreated by the migration");
          } finally {
            try { legacy.close(); } catch { /* already closed */ }
            initMod.__setDbForTesting(db as any);
          }
        }
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
  runCrmPlatformIdentityTests({ log: true }).then((s) => {
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
