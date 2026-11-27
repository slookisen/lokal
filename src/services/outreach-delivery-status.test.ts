/**
 * outreach-delivery-status.test.ts — dev-request
 * 2026-11-26-innsyn-i-levering-dmarc-leveringsstatus-og-kontrollkopier, point 4
 * («Levert per utsending», AK5): Resend's delivered / soft bounce / bounce /
 * complaint events land on the CRM messages of the two outreach jobs, and the
 * measurements count «delivered».
 *
 * Runs the REAL webhook route over loopback HTTP (Svix-signed, same raw-body
 * capture as index.ts), the REAL gårdssalg send helper
 * (sendGardssalgOutreachToEligibleProvider, with a stub transporter that returns
 * a Message-ID like nodemailer does) and the REAL compose path the RFB daily job
 * sends through (executeCompose with its sendRaw seam).
 *
 *   od1-od4   gårdssalg: email.delivered (data.message_id) → «delivered» on the CRM
 *             message, in the thread detail, and by_round counts it
 *   od5-od6   a seed copy's delivery is linked to nothing and not counted
 *   od7-od8   a complaint outranks a later «delivered» and is not counted as delivered
 *   od9-od12  RFB: delivered → status + computeRfbMarketingDeliveryCounts; a bounce
 *             outranks a later «delivered»; this run's own sends are outside the count
 *   od12b     data.message_id links where the subject heuristic alone finds nothing
 *   od8b/od8c N1/N3 gårdssalg: linked via crm_messages.id with a differing subject; an
 *             upper-case Message-ID without <> matches
 *   od12c     B2: consecutive RFB runs count non-overlapping windows
 *   od12d     N3 RFB: upper-case Message-ID without <> matches crm_outbox.result_id
 *   od13-od15 non-outreach / no message_id: the recipient + time path is unchanged;
 *             an RFC 2047-encoded subject still matches; a message_id whose CRM
 *             message went to another address is not trusted
 *
 * Standalone:
 *   npx tsx src/services/outreach-delivery-status.test.ts
 */

import crypto from "crypto";
import http from "http";
import type { AddressInfo } from "net";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const VERIFIED_PROVENANCE = {
  hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-09-01T00:00:00.000Z" },
};
const REALISTIC_ABOUT_TEXT =
  "Vi driver et lite gårdsbruk og lager drikke av råvarer fra vår egen gård. " +
  "Produktene selges direkte fra gårdsutsalget til besøkende gjennom hele sesongen.";

export function runOutreachDeliveryStatusTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const out = console.log.bind(console);
  function eq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) out(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) out("  " + msg);
    }
  }

  return (async () => {
    const prevEnv = {
      EXPERIENCES_DB_PATH: process.env.EXPERIENCES_DB_PATH,
      OUTREACH_COOLDOWN_DAYS: process.env.OUTREACH_COOLDOWN_DAYS,
      DAILY_PREP_MAX_CANDIDATES: process.env.DAILY_PREP_MAX_CANDIDATES,
      EMAIL_FORCE_DRY_RUN: process.env.EMAIL_FORCE_DRY_RUN,
      OUTREACH_PAUSED: process.env.OUTREACH_PAUSED,
      ENABLE_EXPERIENCES: process.env.ENABLE_EXPERIENCES,
    };
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.OUTREACH_COOLDOWN_DAYS = "40";
    process.env.EMAIL_FORCE_DRY_RUN = "true";
    delete process.env.DAILY_PREP_MAX_CANDIDATES;
    delete process.env.OUTREACH_PAUSED;
    delete process.env.ENABLE_EXPERIENCES;

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("./email-service"),
      require.resolve("./blocklist-service"),
      require.resolve("./experience-store"),
      require.resolve("../routes/opplevelser"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

    let prevRfbDb: any = null;
    let server: http.Server | null = null;
    let emailSvc: any = null;
    let prevTransport: { isConfigured: boolean; transporter: unknown } | null = null;
    const origLog = console.log;
    const origWarn = console.warn;
    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch {
        // already loaded
      }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const initMod = require("../database/init") as typeof import("../database/init");
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const rfbDb = new Database(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);

      const m = require("../routes/opplevelser") as typeof import("../routes/opplevelser");
      const emailMod = require("./email-service") as typeof import("./email-service");
      const crmRoute = require("../routes/crm") as typeof import("../routes/crm");
      const crm = require("./crm-service") as typeof import("./crm-service");
      const rfbDaily = require("./rfb-marketing-daily") as typeof import("./rfb-marketing-daily");
      const routeMod = require("../routes/resend-webhook") as typeof import("../routes/resend-webhook");
      const svc = require("./resend-webhook") as typeof import("./resend-webhook");

      // ── Loopback webhook, signed like Svix ──
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const express = require("express");
      const keyBytes = crypto.randomBytes(24);
      const app = express();
      app.use(express.json({ limit: "1mb", verify: (req: any, _res: any, buf: Buffer) => { req.rawBody = buf; } }));
      app.set("resendWebhookSecret", "whsec_" + keyBytes.toString("base64"));
      app.use("/", routeMod.default);
      server = await new Promise<http.Server>((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });
      const port = (server.address() as AddressInfo).port;
      let svixSeq = 0;
      const webhook = async (type: string, to: string, data: Record<string, unknown> = {}): Promise<{ status: number; body: any }> => {
        const now = new Date().toISOString();
        const body = JSON.stringify({ type, created_at: now, data: { created_at: now, email_id: crypto.randomUUID(), to: [to], ...data } });
        const id = `msg_od_${++svixSeq}`;
        const ts = String(Math.floor(Date.now() / 1000));
        const sig = svc.computeSvixSignature(keyBytes, id, ts, body);
        console.log = () => undefined; // the route logs the outcome line
        console.warn = () => undefined;
        try {
          return await new Promise((resolve, reject) => {
            const req = http.request(
              { host: "127.0.0.1", port, path: "/webhooks/resend", method: "POST",
                headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` } },
              (res) => {
                let raw = "";
                res.on("data", (c) => (raw += c));
                res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }));
              },
            );
            req.on("error", reject);
            req.end(body);
          });
        } finally {
          console.log = origLog;
          console.warn = origWarn;
        }
      };
      const verdict = (id: string): string | undefined =>
        (rfbDb.prepare(`SELECT status FROM crm_message_delivery WHERE crm_message_id = ?`).get(id) as { status: string } | undefined)?.status;
      const verdictCount = (): number => (rfbDb.prepare(`SELECT COUNT(*) AS n FROM crm_message_delivery`).get() as { n: number }).n;

      // ── Stub transporter: what nodemailer returns over Resend's SMTP relay ──
      emailSvc = emailMod.emailService as any;
      prevTransport = { isConfigured: emailSvc.isConfigured, transporter: emailSvc.transporter };
      const wire: Array<{ to: string; subject: string; messageId: string }> = [];
      emailSvc.isConfigured = true;
      emailSvc.transporter = {
        sendMail: async (o: any) => {
          const messageId = `<od-${wire.length + 1}-${crypto.randomUUID()}@rettfrabonden.com>`;
          wire.push({ to: String(o.to), subject: String(o.subject), messageId });
          return { messageId };
        },
      };

      // ── Gårdssalg outreach (Opplevagent) ──
      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, kommune, rfb_seed_source, producer_type,
            epost, telefon, hjemmeside, about_text, visit_text, opening_hours_text,
            products, content_source, booking_live, catalog_hidden, slug, field_provenance,
            brreg_verified, antall_ansatte, naeringskode,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @org_nr, 'Voss', 'rfb-seed', 'bryggeri',
            @epost, NULL, @hjemmeside, @about_text, NULL, NULL,
            'Øl, juleøl', 'provider_site', 0, 0, @slug, @field_provenance,
            1, 4, NULL,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      let seq = 0;
      const mk = (id: string): string => {
        seq++;
        const domain = `${id}.no`;
        insertProvider.run({
          id, navn: `Gård ${id}`, org_nr: String(410000000 + seq), epost: `post@${domain}`,
          hjemmeside: `https://${domain}`, about_text: REALISTIC_ABOUT_TEXT, slug: id,
          field_provenance: JSON.stringify({
            ...VERIFIED_PROVENANCE,
            epost: [{ source_type: "registry", value: `post@${domain}`, source_url: `https://data.brreg.no/enhetsregisteret/api/enheter/${410000000 + seq}` }],
          }),
        });
        return `post@${domain}`;
      };
      const g1 = mk("od-g1");
      const g2 = mk("od-g2");
      const g3 = mk("od-g3");
      const g4 = mk("od-g4");
      const prep = m.computeGardssalgOutreachDailyPrep(expDb);
      const sendG = async (providerId: string) => {
        const elig = prep.selected.find((s) => s.provider_id === providerId)!;
        return m.sendGardssalgOutreachToEligibleProvider(expDb, elig, { template: elig.template, isTest: false, source: "od-test" });
      };
      const r1 = await sendG("od-g1");
      const r2 = await sendG("od-g2");
      eq([r1.status, r2.status, r1.crm_recorded, r2.crm_recorded], ["sent", "sent", true, true], "od0: both gårdssalg sends went out and were filed in the CRM");
      const w1 = wire.find((w) => w.to === g1)!;
      const w2 = wire.find((w) => w.to === g2)!;
      const thread1 = "opplevagent-outreach-od-g1";
      const msg1 = (rfbDb.prepare(`SELECT id FROM crm_messages WHERE thread_id = ? AND direction = 'out'`).get(thread1) as { id: string }).id;

      const d1 = await webhook("email.delivered", g1, { message_id: w1.messageId, subject: w1.subject });
      eq([d1.status, d1.body?.outcome], [200, "delivery_recorded"], "od1: the signed email.delivered is accepted");
      eq(verdict(msg1), "delivered", "od2: the gårdssalg outreach CRM message is «delivered»");
      eq(crm.crmService.getThreadDetail(thread1)?.deliveries?.[msg1]?.status, "delivered", "od3: the thread detail shows the status");
      let meas = m.computeGardssalgV4Measurement(expDb, rfbDb as any, { days: 28 });
      eq([meas.by_round["1"]?.sends, meas.by_round["1"]?.delivered], [2, 1], "od4: by_round counts the delivered send (1 of 2)");

      // Seed copy of the g1 mail (lokal#1680): its own Message-ID, filed nowhere.
      const seedTo = "seed.kontroll@seed-test.example";
      const seedRes = await emailSvc.sendGardssalgOutreachSeedCopy(seedTo, { providerName: "Gård od-g1", profileUrl: "https://opplevagent.no/x", template: "personal-v4" });
      const seedWire = wire.find((w) => w.to === seedTo)!;
      const before = verdictCount();
      const ds = await webhook("email.delivered", seedTo, { message_id: seedWire.messageId, subject: seedWire.subject });
      eq([seedRes.success, ds.status, verdictCount()], [true, 200, before], "od5: a seed copy's delivery is linked to no CRM message");
      meas = m.computeGardssalgV4Measurement(expDb, rfbDb as any, { days: 28 });
      eq(meas.by_round["1"]?.delivered, 1, "od6: …and is not counted");

      const msg2 = (rfbDb.prepare(`SELECT id FROM crm_messages WHERE thread_id = ? AND direction = 'out'`).get("opplevagent-outreach-od-g2") as { id: string }).id;
      await webhook("email.complained", g2, { message_id: w2.messageId, subject: w2.subject });
      await webhook("email.delivered", g2, { message_id: w2.messageId, subject: w2.subject });
      eq(verdict(msg2), "complained", "od7: a complaint outranks a later «delivered»");
      meas = m.computeGardssalgV4Measurement(expDb, rfbDb as any, { days: 28 });
      eq([meas.by_round["1"]?.delivered, meas.sends.map((s) => s.delivery).sort()], [1, ["complained", "delivered"]], "od8: the complained send is not counted as delivered");

      // N1: a gårdssalg event whose subject differs from the stored one is linked by
      // crm_messages.id = data.message_id (the subject heuristic alone finds nothing).
      await sendG("od-g3");
      const w3 = wire.find((w) => w.to === g3)!;
      const msg3 = (rfbDb.prepare(`SELECT id FROM crm_messages WHERE thread_id = ? AND direction = 'out'`).get("opplevagent-outreach-od-g3") as { id: string }).id;
      await webhook("email.delivered", g3, { message_id: w3.messageId, subject: "Et helt annet emne" });
      eq([msg3 === w3.messageId, verdict(msg3)], [true, "delivered"], "od8b: gårdssalg — a differing subject is still linked via crm_messages.id = message_id");
      // N3: Message-ID compared lower-case and without <> (as cs-inbound.ts does).
      await sendG("od-g4");
      const w4 = wire.find((w) => w.to === g4)!;
      const msg4 = (rfbDb.prepare(`SELECT id FROM crm_messages WHERE thread_id = ? AND direction = 'out'`).get("opplevagent-outreach-od-g4") as { id: string }).id;
      await webhook("email.delivered", g4, { message_id: w4.messageId.replace(/[<>]/g, "").toUpperCase(), subject: "Et helt annet emne" });
      eq(verdict(msg4), "delivered", "od8c: gårdssalg — an upper-case Message-ID without <> still matches");

      // ── RFB outreach (rfb-marketing-daily sends through executeCompose) ──
      const rfbSend = async (to: string) => {
        const outcome = await crmRoute.executeCompose(
          { to, contactName: "Produsent", subject: "Hei fra Rett fra Bonden — synlig for kundene dine?", bodyText: "Hei!", intent: "resend_send", category: "marketing", createdBy: "claude", vertical: "rfb" },
          {
            sendRaw: async (o) => {
              const messageId = `<od-rfb-${crypto.randomUUID()}@rettfrabonden.com>`;
              wire.push({ to: o.to, subject: o.subject, messageId });
              return { success: true, messageId };
            },
            messageMetadata: { template: "rfb-v4", subject_arm: "A" },
          },
        );
        const b = outcome.body as any;
        const msgId = (rfbDb.prepare(`SELECT id FROM crm_messages WHERE thread_id = ? AND direction = 'out'`).get(b.threadId) as { id: string }).id;
        return { outboxId: b.outboxId as string, threadId: b.threadId as string, messageId: b.messageId as string, crmMessageId: msgId };
      };
      const ledger = (to: string, outboxId: string, threadId: string, messageId: string, hoursAgo: number, status = "sent") => {
        const at = new Date(Date.now() - hoursAgo * 3600_000);
        rfbDb
          .prepare(
            `INSERT INTO rfb_marketing_send_ledger (day, run_id, agent_id, recipient_email, touch, status, reserved_at, updated_at, thread_id, outbox_id, message_id)
             VALUES (?, 'od-run', 'od-agent', ?, 'first', ?, ?, ?, ?, ?, ?)`,
          )
          .run(at.toISOString().slice(0, 10) + `-${to}`, to, status, at.toISOString(), at.toISOString(), threadId, outboxId, messageId);
      };
      const a = await rfbSend("rfb-a@gard-test.no");
      const b = await rfbSend("rfb-b@gard-test.no");
      const c = await rfbSend("rfb-c@gard-test.no");
      ledger("rfb-a@gard-test.no", a.outboxId, a.threadId, a.messageId, 20);
      ledger("rfb-b@gard-test.no", b.outboxId, b.threadId, b.messageId, 20);
      ledger("rfb-c@gard-test.no", c.outboxId, c.threadId, c.messageId, 0.01); // this run's own send
      // N2: a 'failed' ledger row (pointing at a delivered message) is never counted.
      ledger("rfb-f@gard-test.no", a.outboxId, a.threadId, a.messageId, 20, "failed");
      await webhook("email.delivered", "rfb-a@gard-test.no", { message_id: a.messageId, subject: "Hei fra Rett fra Bonden — synlig for kundene dine?" });
      eq(verdict(a.crmMessageId), "delivered", "od9: the RFB outreach CRM message is «delivered»");
      await webhook("email.bounced", "rfb-b@gard-test.no", { message_id: b.messageId, bounce: { type: "Permanent", subType: "General" } });
      await webhook("email.delivered", "rfb-b@gard-test.no", { message_id: b.messageId });
      eq(verdict(b.crmMessageId), "bounced", "od10: a bounce outranks a later «delivered»");
      await webhook("email.delivered", "rfb-c@gard-test.no", { message_id: c.messageId });
      const counts = rfbDaily.computeRfbMarketingDeliveryCounts(rfbDb as any, new Date(Date.now() - 60_000));
      eq([counts.window_from, counts.sent, counts.delivered, counts.bounced, counts.no_verdict], ["fallback_lookback", 2, 1, 1, 0], "od11: without a previous run: the 48h fallback — 1 delivered, 1 bounced; the 'failed' ledger row is not counted");
      const all = rfbDaily.computeRfbMarketingDeliveryCounts(rfbDb as any, new Date(Date.now() + 60_000));
      eq([all.sent, all.delivered], [3, 2], "od12: a send inside the window is counted once its delivery has arrived");

      // B2: consecutive runs get touching, non-overlapping windows (from the previous
      // rfb-marketing-daily run's start), so each send is counted by exactly one run.
      {
        const addRun = (id: string, hoursAgo: number) =>
          rfbDb
            .prepare(`INSERT INTO runs (run_id, vertical, agent, trigger_source, started_at, status) VALUES (?, 'rfb', ?, 'cron', ?, 'completed')`)
            .run(id, rfbDaily.RFB_MARKETING_DAILY_AGENT, new Date(Date.now() - hoursAgo * 3600_000).toISOString());
        addRun("od-run-1", 30);
        const r2Start = new Date(Date.now() - 15 * 3600_000);
        const r2 = rfbDaily.computeRfbMarketingDeliveryCounts(rfbDb as any, r2Start);
        addRun("od-run-2", 15);
        const r3 = rfbDaily.computeRfbMarketingDeliveryCounts(rfbDb as any, new Date(Date.now() - 60_000));
        eq(
          [r2.window_from, r2.sent, r2.delivered, r3.window_from, r3.window_since === r2Start.toISOString(), r3.sent, r3.delivered],
          ["previous_run", 2, 1, "previous_run", true, 0, 0],
          "od12c: run 2 counts the sends after run 1's start; run 3 starts at run 2's start and does not count them again",
        );
      }

      // N3 (outbox path): RFB Message-ID upper-case and without <>.
      const h = await rfbSend("rfb-h@gard-test.no");
      await webhook("email.delivered", "rfb-h@gard-test.no", { message_id: h.messageId.replace(/[<>]/g, "").toUpperCase(), subject: "Et helt annet emne" });
      eq(verdict(h.crmMessageId), "delivered", "od12d: RFB — an upper-case Message-ID without <> matches crm_outbox.result_id");

      // The recipient + time + subject heuristic alone misses an event whose subject
      // differs from the stored one; the exact data.message_id link does not.
      const d = await rfbSend("rfb-d@gard-test.no");
      const e = await rfbSend("rfb-e@gard-test.no");
      await webhook("email.delivered", "rfb-e@gard-test.no", { subject: "Hei fra Rett fra Bonden" });
      await webhook("email.delivered", "rfb-d@gard-test.no", { message_id: d.messageId, subject: "Hei fra Rett fra Bonden" });
      eq([verdict(d.crmMessageId), verdict(e.crmMessageId)], ["delivered", undefined], "od12b: data.message_id links exactly where the subject heuristic finds nothing");

      // ── Unchanged: non-outreach CRM messages, events without message_id ──
      crm.crmService.ingestThread(
        { threadId: "od-cs", subject: "Spørsmål", category: "innkommende", messages: [{ messageId: "od-cs-in", direction: "in", fromEmail: "kunde@x-test.no", bodyText: "Hei", sentAt: new Date(Date.now() - 3 * 3600_000).toISOString() }] } as any,
        "kunde@x-test.no",
        "rfb",
      );
      const reply = crm.crmService.recordOutboundReply({ threadId: "od-cs", vertical: "rfb", toEmails: ["kunde@x-test.no"], subject: "Re: Spørsmål om gårdsbutikken", bodyText: "Svar", deliveryStatus: "sent", sentAt: new Date(Date.now() - 3600_000).toISOString() }).messageId;
      await webhook("email.delivered", "kunde@x-test.no", { subject: "Re: Spørsmål om gårdsbutikken" });
      eq(verdict(reply), "delivered", "od13: a CS reply without data.message_id is still linked by recipient + time + subject");
      const reply2 = crm.crmService.recordOutboundReply({ threadId: "od-cs", vertical: "rfb", toEmails: ["kunde2@x-test.no"], subject: "Re: Gårdssalg på Voss", bodyText: "Svar", deliveryStatus: "sent", sentAt: new Date(Date.now() - 3600_000).toISOString() }).messageId;
      await webhook("email.delivered", "kunde2@x-test.no", { subject: "=?UTF-8?Q?Re:_G=C3=A5rdssalg_p=C3=A5?= =?UTF-8?Q?_Voss?=" });
      eq(verdict(reply2), "delivered", "od14: an RFC 2047-encoded subject matches the stored subject");
      // B1: e (od12b) has no verdict yet; its Message-ID on an event for ANOTHER address
      // must not give it one.
      eq(verdict(e.crmMessageId), undefined, "od15a: precondition — e has no verdict");
      await webhook("email.delivered", "annen@x-test.no", { message_id: e.messageId });
      const evRow = rfbDb.prepare(`SELECT crm_message_id FROM email_delivery_events WHERE email = 'annen@x-test.no'`).get() as { crm_message_id: string | null } | undefined;
      eq([verdict(e.crmMessageId), evRow ? evRow.crm_message_id : "missing"], [undefined, null], "od15: a message_id whose CRM message went to another address is not trusted");
    } catch (err) {
      failed++;
      failures.push(`✗ outreach-delivery-status suite threw: ${(err as Error)?.stack ?? err}`);
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      if (emailSvc && prevTransport) {
        emailSvc.isConfigured = prevTransport.isConfigured;
        emailSvc.transporter = prevTransport.transporter;
      }
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      try {
        if (prevRfbDb) (require("../database/init") as typeof import("../database/init")).__setDbForTesting(prevRfbDb);
      } catch {
        // best-effort
      }
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch {
        // best-effort
      }
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      restoreModuleCache();
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOutreachDeliveryStatusTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    for (const f of summary.failures) console.log(f);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
