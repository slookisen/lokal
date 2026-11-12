/**
 * owner-tekstpakke-c.test.ts — tekstpakke C (approved e-mail, buyer receipt
 * and /kjopsvilkar texts, 2026-11-09; dev-request
 * 2026-10-30-rfb-eierportal-testrunde-1, D3). One block per correction:
 *
 *   p1-*   «Ny henteordre» (v2): «Bestilling:», no «Kjøper-ref», «bestilling»,
 *          the payment line from pakke A; the subject stands.
 *   p2-*   the reminder after 24 hours.
 *   p3-*   the buyer withdrew / cancelled (producer e-mail).
 *   p4-*   the daily digest: ORDER_CAP_V2_ENABLED on → platform ceiling only,
 *          new text (singular / plural), the ceiling in force; off → as today.
 *   p5-*   the login link; the extra sentence only with
 *          OWNER_SESSION_SLIDING_ENABLED.
 *   p6-*   «Bekreft ny adresse for bestillinger» and «Profilen er nå din».
 *   p7-9-* the buyer receipts (deadline from orderAutocancelHours()), legal
 *          paragraphs byte-identical.
 *   p10-*  «Avslå – utsolgt»: the reason is stored with the order and the
 *          decline receipt says «… fordi varen er utsolgt (bestilling X).».
 *   p11-*  the T12 sentence exists; p12-* the buyer limit texts stand.
 *   p13-15 /kjopsvilkar; the legal sections are byte-identical.
 *
 * Own in-memory DB (the real schema). No network, no real e-mail. Every flag
 * it touches is restored.
 * Standalone: npx tsx src/routes/owner-tekstpakke-c.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";
import { createHash } from "crypto";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const SAVED_ENV = [
  "ORDER_AUTOCOMPLETE_ENABLED", "ORDER_NOTIFY_EMAIL_VERSION", "ORDER_CAP_V2_ENABLED", "ORDER_CAP_NOTICE_ENABLED",
  "OWNER_SESSION_SLIDING_ENABLED", "OWNER_SESSION_MAX_DAYS", "ORDER_AUTOCANCEL_HOURS", "ORDER_BUYER_RECEIPTS_ENABLED",
  "ORDER_CANCEL_DETAIL_RECEIPT_ENABLED", "STOCK_SOFT_EXPIRY_ENABLED", "OWNER_FEATURES_ALLOWED_SUBJECTS", "PAYMENTS_ENABLED",
  "ADMIN_NOTIFICATION_EMAIL",
];

export async function runOwnerTekstpakkeCTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const log = opts.log !== false;
  const ok = (cond: boolean, name: string) => {
    if (cond) { passed++; if (log) console.log(`  ✓ ${name}`); }
    else { failed++; failures.push(name); if (log) console.log(`  ✗ ${name}`); }
  };
  const eq = (actual: unknown, expected: unknown, name: string) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed++; if (log) console.log(`  ✓ ${name}`); }
    else {
      failed++;
      failures.push(`${name}\n    expected: ${e}\n    actual:   ${a}`);
      if (log) console.log(`  ✗ ${name}\n    expected: ${e}\n    actual:   ${a}`);
    }
  };
  /** Every new string present, every old string absent. */
  const swap = (text: string, news: string[], olds: string[], name: string) => {
    const missing = news.filter((s) => !text.includes(s));
    const left = olds.filter((s) => text.includes(s));
    ok(missing.length === 0 && left.length === 0, missing.length || left.length
      ? `${name} (missing ${JSON.stringify(missing)}, still there ${JSON.stringify(left)})` : name);
  };

  const initMod = require("../database/init") as typeof import("../database/init");
  const cartSvc = require("../services/cart-service") as typeof import("../services/cart-service");
  const notifySvc = require("../services/order-notify-service") as typeof import("../services/order-notify-service");
  const receiptSvc = require("../services/order-receipt-service") as typeof import("../services/order-receipt-service");
  const trustSvc = require("../services/trust-event-service") as typeof import("../services/trust-event-service");
  const capSvc = require("../services/order-cap-notice") as typeof import("../services/order-cap-notice");
  const actionsSvc = require("../services/order-actions") as typeof import("../services/order-actions");
  const emailMod = require("../services/email-service") as typeof import("../services/email-service");
  const texts = require("../owner-features/order-texts") as typeof import("../owner-features/order-texts");

  const saved: Record<string, string | undefined> = {};
  for (const k of SAVED_ENV) saved[k] = process.env[k];
  const prevDb = (() => { try { return initMod.getDb(); } catch { return undefined; } })();
  const db = new Database(":memory:");
  const notifyMails: Array<{ to: string; subject: string; text: string; html: string }> = [];
  const receipts: Array<{ to: string; subject: string; text: string }> = [];
  const emailSvcAny = emailMod.emailService as any;
  const ownSendEmail = Object.prototype.hasOwnProperty.call(emailSvcAny, "sendEmail") ? emailSvcAny.sendEmail : undefined;

  const vc = require("../config/vertical-config") as typeof import("../config/vertical-config");
  try { vc.loadConfigsAtBoot(); } catch { /* already loaded */ }

  try {
    for (const k of SAVED_ENV) delete process.env[k];
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    cartSvc.__setCartTestDb(db as any);
    trustSvc.__setTrustEventTestDb(db as any);
    notifySvc.__setOrderNotifyTestDb(db as any);
    receiptSvc.__setBuyerReceiptTestDb(db as any);
    capSvc.__setOrderCapNoticeTestDb(db as any);
    actionsSvc.__setOrderActionsTestDb(db as any);
    notifySvc.__setOrderNotifySendForTesting(async (o) => {
      notifyMails.push({ to: o.to, subject: o.subject, text: o.textContent || "", html: o.htmlContent || "" });
      return { success: true, messageId: "stub" };
    });
    receiptSvc.__setBuyerReceiptSendForTesting(async (o) => {
      receipts.push({ to: String(o.to), subject: String(o.subject), text: String(o.textContent) });
      return { success: true, messageId: "stub" };
    });
    const settle = () => new Promise((r) => setTimeout(r, 40));

    // Seed: the test producer, opted in and verified (the order e-mail's gate).
    const NAME = "Test Gard Brreg";
    db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories)
                VALUES (?, ?, 'Testprodusent', 'self', ?, 'https://example.no', 'producer', ?, '["vegetables"]')`)
      .run("ag-tpc", NAME, "gard-tpc@example.no", "k-tpc");
    db.prepare("INSERT INTO agent_knowledge (agent_id, verification_status, email, phone) VALUES (?, 'verified', ?, '+47 400 00 000')")
      .run("ag-tpc", "gard-tpc@example.no");
    db.prepare("UPDATE agents SET order_notifications_opt_in = 1, is_verified = 1 WHERE id = ?").run("ag-tpc");
    let seq = 0;
    const seedOrder = (status: string, idPrefix = "331197ea"): string => {
      const id = `${idPrefix}-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
      db.prepare(`
        INSERT INTO orders (id, agent_id, buyer_ref, status, fulfilment, confirm_token, total_nok, payment_mode,
                            notify_sent_at, buyer_name, buyer_email, created_at, updated_at)
        VALUES (?, 'ag-tpc', ?, ?, 'pickup', ?, 90, NULL, datetime('now'), 'Kari', 'kari.tpc@example.com', datetime('now'), datetime('now'))
      `).run(id, `bref_${id}`, status, `ctok_${id}`);
      db.prepare(`INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, category, availability_source)
                  VALUES (?, 'ag-tpc', ?, ?, 45, 'stk', 'in_stock', 'eggs', 'producer_dashboard')`).run(`prod-${id}`, `Egg ${seq}`, `egg ${seq}`);
      db.prepare("INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_snapshot, line_total) VALUES (?, ?, ?, 'Egg', 2, 45, 90)")
        .run(`${id}-i1`, id, `prod-${id}`);
      return id;
    };

    // ── 1. «Ny henteordre» (v2, the default) ──────────────────────────────────
    const input = {
      order_id: "331197ea-1111-4000-8000-000000000000", agent_id: "ag-tpc", producer_name: NAME, buyer_ref: "k3f9a0000000000000000",
      confirm_token: "ctok_tpc", pickup_time: null, total_nok: 90, items: [{ name: "Egg", qty: 2, unit: null, line_total: 90 }],
      buyer_name: "Kari", buyer_phone: "+47 900 00 000", buyer_email: "kari@example.com",
    };
    process.env.ORDER_AUTOCOMPLETE_ENABLED = "1";
    const m1 = notifySvc.renderOrderNotificationEmail(notifySvc.resolveOrderNotifyEmailVersion(), input);
    delete process.env.ORDER_AUTOCOMPLETE_ENABLED;
    const P1_NEW_TEXT = [
      "Bestilling: 331197ea",
      "Du trenger bare å bekrefte eller avslå. Bestillingen avsluttes av seg selv etter henting.",
      "Se alle bestillingene dine (krever innlogging)",
      "Kunden betaler deg når varene hentes. Rett fra Bonden tar ikke betalt.",
    ];
    const P1_OLD = [
      "Ordre-ref", "Kjøper-ref", "k3f9a", "Lenken er personlig for denne ordren — ikke del den videre.",
      "Ordren avsluttes av seg selv etter henting.", "Se alle ordrene dine", "Ingen betaling skjer via plattformen; oppgjør ved henting som vanlig.",
    ];
    swap(m1.textContent, P1_NEW_TEXT, P1_OLD, "p1-01: text part — every new string, no old string");
    swap(m1.htmlContent, [
      ">Bestilling:</td><td>331197ea</td>", "Lenken er personlig for denne bestillingen. Ikke del den videre.",
      "Du trenger bare å bekrefte eller avslå. Bestillingen avsluttes av seg selv etter henting.",
      ">Se alle bestillingene dine</a> (krever innlogging)", "<p>Kunden betaler deg når varene hentes. Rett fra Bonden tar ikke betalt.</p>",
    ], P1_OLD, "p1-02: HTML part — every new string, no old string");
    eq(m1.subject, "Ny henteordre — 331197ea", "p1-03: the subject «Ny henteordre» stands");
    ok(m1.textContent.includes("Kunde:\nNavn: Kari\nTelefon: +47 900 00 000\nE-post: kari@example.com") && m1.htmlContent.includes("Se og bekreft bestillingen")
      && m1.textContent.includes("Du har fått en ny henteordre via Rett fra Bonden."), "p1-04: the «Kunde» block, the button and the intro stand");
    // Prepayment texts are not part of pakke C: an authorized order keeps its payment line.
    const prepaid = notifySvc.renderOrderNotificationEmailV2({ ...input, payment: { status: "authorized", amount_nok: 90, confirm_by: null } });
    ok(prepaid.textContent.includes("Kunden har betalt 90 kr på forhånd.") && !prepaid.textContent.includes("Rett fra Bonden tar ikke betalt"),
      "p1-05: a prepaid order keeps its own payment line (not in pakke C)");

    // ── 2. The reminder ──────────────────────────────────────────────────────
    const rem = notifySvc.renderOrderNotificationEmailV2({ ...input, reminder: true });
    eq(rem.subject, "Påminnelse: bestilling venter på svar — 331197ea", "p2-01: the reminder subject");
    swap(rem.htmlContent, ["Påminnelse: du har en bestilling via Rett fra Bonden som ikke er besvart ennå. Kunden venter på svar:"],
      ["henteordre venter på svar", "Kunden venter på bekreftelse eller avslag"], "p2-02: the reminder lead (HTML)");
    swap(rem.textContent, ["Påminnelse: du har en bestilling via Rett fra Bonden som ikke er besvart ennå. Kunden venter på svar"],
      ["Kunden venter på bekreftelse eller avslag"], "p2-03: the reminder lead (text)");

    // ── 3. The buyer withdrew / cancelled ────────────────────────────────────
    {
      const w = seedOrder("cancelled");
      const c = seedOrder("cancelled");
      notifyMails.length = 0;
      await notifySvc.sendProducerBuyerCancelNotice(w, "withdraw");
      await notifySvc.sendProducerBuyerCancelNotice(c, "cancel");
      const [mw, mc] = notifyMails;
      ok(!!mw && !!mc, "p3-00: both notices were sent");
      const all = (m: typeof mw) => (m ? m.text + "\n" + m.html : "");
      swap(all(mw), ["Kunden har trukket bestillingen 331197ea før du bekreftet den. Bestillingen er kansellert. Du trenger ikke gjøre noe.",
        "Se alle bestillingene dine (krever innlogging)", ">Se alle bestillingene dine</a> (krever innlogging)"],
      ["teller ikke mot deg", "Ordren er kansellert", "Se alle ordrene dine"], "p3-01: withdrawn before confirmation");
      swap(all(mc), ["Kunden har avbestilt bestillingen 331197ea etter at du bekreftet den. Bestillingen er kansellert, så du trenger ikke holde av varene.",
        "Se alle bestillingene dine (krever innlogging)"],
      ["Ordren er kansellert", "Se alle ordrene dine"], "p3-02: cancelled after confirmation");
    }

    // ── 4. The daily digest ──────────────────────────────────────────────────
    {
      const one = notifySvc.renderOrderCapNoticeEmail({ agent_id: "ag-tpc", count: 1, cap: 50, oslo_day: "2026-11-08", v2: true });
      const three = notifySvc.renderOrderCapNoticeEmail({ agent_id: "ag-tpc", count: 3, cap: 50, oslo_day: "2026-11-08", v2: true });
      eq(three.subject, "3 kunder fikk kontaktinformasjonen din i går", "p4-01: the subject (plural)");
      eq(one.subject, "1 kunde fikk kontaktinformasjonen din i går", "p4-02: the subject (singular)");
      const LEAD3 = "I går (8. november) fikk du mer enn 50 bestillinger gjennom Rett fra Bonden. De neste 3 kundene fikk kontaktinformasjonen din i stedet, så de kan ta kontakt med deg direkte.";
      const LEAD1 = "I går (8. november) fikk du mer enn 50 bestillinger gjennom Rett fra Bonden. Den neste kunden fikk kontaktinformasjonen din i stedet, så de kan ta kontakt med deg direkte.";
      const OLD4 = ["etter grensen din", "per døgn", "kontaktforespørsel", "Kundene fikk kontaktinformasjonen din i stedet for å sende bestillingen"];
      swap(three.textContent + three.htmlContent, [LEAD3], OLD4, "p4-03: the new lead (plural), no old text");
      swap(one.textContent + one.htmlContent, [LEAD1], OLD4, "p4-04: «Den neste kunden fikk …» (singular)");
      const other = notifySvc.renderOrderCapNoticeEmail({ agent_id: "ag-tpc", count: 2, cap: 40, oslo_day: "2026-11-08", v2: true });
      ok(other.textContent.includes("mer enn 40 bestillinger") && other.textContent.includes("De neste 2 kundene"), "p4-05: the number is the ceiling passed in, not a literal 50");
      const legacy = notifySvc.renderOrderCapNoticeEmail({ agent_id: "ag-tpc", count: 3, cap: 10, oslo_day: "2026-11-08" });
      eq(legacy.subject, "3 bestillinger kom etter grensen din i går", "p4-06: without v2 the subject is as today");
      ok(legacy.textContent.includes("3 bestillinger kom etter grensen din på 10 bestillinger per døgn i går (søndag 8. november) og ble sendt som kontaktforespørsel."),
        "p4-07: without v2 the lead is as today");

      // The job: V2 on → only platform-ceiling hits, the ceiling in force, the new text.
      const insEv = db.prepare(`INSERT INTO order_cap_events (id, agent_id, cart_id, reason, cap, oslo_day, created_at, reason_detail)
                                VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`);
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories)
                  VALUES ('ag-tpc2', 'Annen Gård', 'Testprodusent', 'self', 'annen@example.no', 'https://example.no', 'producer', 'k-tpc2', '["vegetables"]')`).run();
      db.prepare("INSERT INTO agent_knowledge (agent_id, verification_status, email, phone) VALUES ('ag-tpc2', 'verified', 'annen@example.no', '+47 400 00 001')").run();
      db.prepare("UPDATE agents SET order_notifications_opt_in = 1, is_verified = 1 WHERE id = 'ag-tpc2'").run();
      let ev = 0;
      const day = "2026-11-08";
      for (let i = 0; i < 3; i++) insEv.run(`ev-${++ev}`, "ag-tpc", "producer_daily_cap", 50, day, "2026-11-08 12:00:00", "platform_ceiling");
      for (let i = 0; i < 2; i++) insEv.run(`ev-${++ev}`, "ag-tpc2", "buyer_open_cap", 10, day, "2026-11-08 12:00:00", "buyer_daily_cap");
      insEv.run(`ev-${++ev}`, "ag-tpc2", "buyer_open_cap", 3, day, "2026-11-08 12:00:00", "buyer_open_cap");
      // A row written before V2 was switched on (no detail) is not a ceiling hit.
      insEv.run(`ev-${++ev}`, "ag-tpc2", "producer_daily_cap", 10, day, "2026-11-08 06:00:00", null);
      notifyMails.length = 0;
      const env = { ...process.env, ORDER_CAP_NOTICE_ENABLED: "1", ORDER_CAP_V2_ENABLED: "1" };
      const r = await capSvc.processOrderCapNotices({ now: new Date("2026-11-09T08:00:00Z"), env });
      eq([r.day, r.candidates, r.sent], [day, 1, 1], "p4-08: V2 on → one producer, the one with platform-ceiling hits");
      eq(notifyMails.map((m) => [m.to, m.subject]), [["gard-tpc@example.no", "3 kunder fikk kontaktinformasjonen din i går"]],
        "p4-09: V2 on → the ceiling producer gets the new e-mail; no e-mail for the buyers' own limits");
      ok(!!notifyMails[0] && notifyMails[0].text.includes(LEAD3) && notifyMails[0].html.includes(LEAD3), "p4-10: V2 on → the sent mail has the new lead with the ceiling in force (50)");
      // V2 off → as today (the old trigger and the old text).
      const dayOff = "2026-11-15";
      for (let i = 0; i < 3; i++) insEv.run(`ev-${++ev}`, "ag-tpc", "producer_daily_cap", 10, dayOff, "2026-11-15 12:00:00", null);
      notifyMails.length = 0;
      const rOff = await capSvc.processOrderCapNotices({ now: new Date("2026-11-16T08:00:00Z"), env: { ...process.env, ORDER_CAP_NOTICE_ENABLED: "1" } });
      eq([rOff.candidates, rOff.sent], [1, 1], "p4-11: V2 off → the old trigger (reason producer_daily_cap)");
      eq(notifyMails.map((m) => m.subject), ["3 bestillinger kom etter grensen din i går"], "p4-12: V2 off → the old subject");
      ok(!!notifyMails[0] && notifyMails[0].text.includes("3 bestillinger kom etter grensen din på 10 bestillinger per døgn i går (søndag 15. november) og ble sendt som kontaktforespørsel.")
        && notifyMails[0].text.includes("Kundene fikk kontaktinformasjonen din i stedet for å sende bestillingen"), "p4-13: V2 off → the old text, byte for byte");
      let prepOk = true;
      try { db.prepare("SELECT 1 FROM order_cap_events e WHERE e.oslo_day = ? AND e.reason = 'producer_daily_cap' AND e.reason_detail = 'platform_ceiling'").all(day); } catch { prepOk = false; }
      ok(prepOk, "p4-14: the V2 query's columns exist in the production schema");
    }

    // ── 5. The login link ────────────────────────────────────────────────────
    {
      const url = "https://rettfrabonden.com/magic-link-verify?token=t";
      const SLIDING = "Når du har logget inn, holder du deg innlogget på denne enheten så lenge du bruker eierportalen minst én gang i måneden, men høyst i 90 dager.";
      const offText = emailMod.buildOwnerMagicLinkText(NAME, url);
      const offHtml = emailMod.buildOwnerMagicLinkHtml(NAME, url);
      swap(offText, ["Trykk på lenken under for å logge inn på eierportalen for Test Gard Brreg:", "Lenken virker én gang og er gyldig i 7 dager."],
        ["Klikk lenken under", "Lenken er gyldig i 7 dager.", "holder du deg innlogget"], "p5-01: flag off — the new text, no extra sentence (text)");
      swap(offHtml, ["Trykk på lenken under for å logge inn på eierportalen for <strong>Test Gard Brreg</strong>.", "<p>Lenken virker én gang og er gyldig i 7 dager.</p>"],
        ["Klikk lenken under", "Lenken er gyldig i 7 dager.", "holder du deg innlogget"], "p5-02: flag off — the new text, no extra sentence (HTML)");
      ok(offText.includes("Hvis du ikke ba om denne innloggingen, kan du trygt ignorere e-posten.") && offHtml.includes("Hvis du ikke ba om denne innloggingen, kan du trygt ignorere e-posten."),
        "p5-03: the «ignorer» sentence stands");
      process.env.OWNER_SESSION_SLIDING_ENABLED = "1";
      const onText = emailMod.buildOwnerMagicLinkText(NAME, url);
      const onHtml = emailMod.buildOwnerMagicLinkHtml(NAME, url);
      ok(onText.includes(`Lenken virker én gang og er gyldig i 7 dager.\n\n${SLIDING}\n\nHvis du ikke ba om`), "p5-04: flag on — the extra sentence in the text part");
      ok(onHtml.includes(`<p>${SLIDING}</p>`), "p5-05: flag on — the extra sentence in the HTML part");
      process.env.OWNER_SESSION_SLIDING_ENABLED = "true";
      process.env.OWNER_SESSION_MAX_DAYS = "60";
      ok(emailMod.buildOwnerMagicLinkText(NAME, url).includes("men høyst i 60 dager."), "p5-06: the cap comes from the session setting");
      delete process.env.OWNER_SESSION_MAX_DAYS;
      delete process.env.OWNER_SESSION_SLIDING_ENABLED;
      eq(emailMod.buildOwnerMagicLinkText(NAME, url), offText, "p5-07: flag off again → byte-identical to the first off render");
    }

    // ── 6. New address, «Profilen er nå din» ─────────────────────────────────
    {
      const captured: any[] = [];
      emailSvcAny.sendEmail = async (o: any) => { captured.push(o); return { success: true, messageId: "stub" }; };
      try {
        await emailMod.emailService.sendOwnerOrderEmailConfirm({ to: "ny@example.no", agentName: NAME, confirmUrl: "https://rettfrabonden.com/x", validHours: 48 });
      } finally {
        if (ownSendEmail) emailSvcAny.sendEmail = ownSendEmail; else delete emailSvcAny.sendEmail;
      }
      const addr = captured[0];
      swap(String(addr?.htmlContent ?? ""), ["Trykk på knappen under for å bekrefte. Til du har bekreftet, går bestillingene til den gamle adressen.", "Lenken er gyldig i 48 timer."],
        ["Klikk knappen under"], "p6-01: «Trykk på knappen under for å bekrefte.»");
      const claimHtml = emailSvcAny.generateClaimConfirmationHtml(NAME, "https://rettfrabonden.com/login", "ag-tpc") as string;
      const claimText = emailSvcAny.generateClaimConfirmationText(NAME, "https://rettfrabonden.com/login", "ag-tpc") as string;
      ok(claimHtml.includes("<li>rette varer, åpningstider og kontaktinformasjon</li>") && claimText.includes("- rette varer, åpningstider og kontaktinformasjon\n"),
        "p6-02: «kontaktinformasjon» in «Profilen er nå din»");
      ok(!/kontaktinfo\b/.test(claimHtml) && !/kontaktinfo\b/.test(claimText), "p6-03: no «kontaktinfo» left");
    }

    // ── 7–9. The buyer receipts ──────────────────────────────────────────────
    const rbase: import("../services/order-receipt-service").ReceiptData = {
      orderRef: "331197ea", producerName: NAME,
      contact: { address: "Gardsveien 1", phone: "+47 400 00 000", email: "gard@example.no", profile_url: "https://rettfrabonden.com/p/x" } as any,
      traderStatus: "trader", items: [{ name: "Egg", qty: 2, line_total: 90 }], totalNok: 90, cancelReason: null, payment: null,
      cardUrl: "https://rettfrabonden.com/ordre/x?ref=y", autoCloseOn: true,
    };
    const R = (ev: "submitted" | "confirmed" | "declined" | "cancelled", extra: Partial<typeof rbase> = {}) => receiptSvc.renderBuyerReceipt(ev, { ...rbase, ...extra })!;
    {
      const sub = R("submitted");
      swap(sub.text, ["Bestilling: 331197ea\n", "Svarer ikke produsenten innen 72 timer, blir bestillingen kansellert, og du får beskjed."],
        ["Ordre: ", "innen kort tid"], "p7-01 / p8-01: «Bestillingen din er sendt» — «Bestilling:» and the 72-hour deadline");
      ok(sub.text.includes("Se bestillingen, eller trekk den gratis før produsenten har bekreftet: ") && sub.subject === `Bestillingen din er sendt til ${NAME} (331197ea)`,
        "p8-02: the rest of the submitted receipt stands");
      process.env.ORDER_AUTOCANCEL_HOURS = "48";
      ok(R("submitted").text.includes("Svarer ikke produsenten innen 48 timer, blir bestillingen kansellert, og du får beskjed."),
        "p8-03: the deadline comes from orderAutocancelHours() (ORDER_AUTOCANCEL_HOURS=48)");
      delete process.env.ORDER_AUTOCANCEL_HOURS;

      const conf = R("confirmed");
      eq(conf.subject, `Bestillingen er bekreftet av ${NAME} (331197ea)`, "p9-01: the confirmation subject");
      swap(conf.text, ["Bestilling: 331197ea\n", "Bestillingen din: se den, avbestill eller si fra at du har hentet: https://rettfrabonden.com/ordre/x?ref=y",
        "Du trenger ikke gjøre noe mer etter hentingen: bestillingen avsluttes av seg selv etter hentetiden."],
      ["Ordre: ", "Ordrekort", "ordren avsluttes", "Ordrebekreftelse"], "p7-02 / p9-02: the confirmation — new strings, no old ones");
      const LEGAL_TRADER =
        "Avbestilling: Vil du avbestille før henting, kontakter du Test Gard Brreg direkte. Produsenten kan da kreve dekket dokumentert tap avbestillingen påfører produsenten (forbrukerkjøpsloven § 41).\n" +
        "Angrerett: Som hovedregel har du 14 dagers angrerett fra dagen du henter varene. Den gjelder ikke for varer som forringes eller raskt går ut på dato (angrerettloven § 22 b), og ikke for forseglede varer som av hensyn til helsevern eller hygiene ikke er egnet for retur, når forseglingen er brutt etter henting (§ 22 g). Bruker du angreretten, gir du Test Gard Brreg beskjed innen fristen og leverer varene tilbake senest 14 dager etter beskjeden. Du dekker returkostnaden. Produsenten betaler tilbake det du har betalt innen 14 dager etter beskjeden, men kan vente til varene er mottatt.\n" +
        "Reklamasjon: Er det feil ved varene, gir du Test Gard Brreg beskjed innen rimelig tid etter at du oppdaget feilen (forbrukerkjøpsloven § 27).\n\n" +
        "Angreskjema (angrerettloven § 8 h)\n" +
        "Fyll ut og send dette skjemaet til produsenten dersom du ønsker å gå fra avtalen. Du kan også gi beskjed på annen måte, for eksempel på e-post.\n" +
        "Til: Test Gard Brreg (kontaktinformasjon over)\n" +
        "Jeg/vi underretter herved om at jeg/vi ønsker å gå fra min/vår avtale om kjøp av følgende varer: ……………\n" +
        "Varen ble mottatt (hentet) den (dato): ……………\n" +
        "Forbrukerens navn: ……………\nForbrukerens adresse: ……………\nDato: ……………\n" +
        "Forbrukerens underskrift (bare hvis skjemaet sendes på papir): ……………\n\n";
      eq(conf.text.slice(conf.text.indexOf("Avbestilling: "), conf.text.indexOf("Kjøpsvilkår: ")), LEGAL_TRADER,
        "p9-03: Avbestilling, Angrerett, Reklamasjon and Angreskjema are byte-identical");
      const nt = R("confirmed", { traderStatus: "non_trader" }).text;
      eq(nt.slice(nt.indexOf("Hvilke regler"), nt.indexOf("Kjøpsvilkår: ")),
        "Hvilke regler som gjelder: Test Gard Brreg har oppgitt at produsenten ikke selger som næringsdrivende. Da gjelder kjøpsloven for kjøpet, ikke forbrukerkjøpsloven og angrerettloven. Vil du avbestille, eller er det feil ved varene, tar du kontakt med Test Gard Brreg direkte.\n\n",
        "p9-04: the non-trader rule is byte-identical");
      ok(conf.text.includes("har bekreftet bestillingen din via Rett fra Bonden. Kjøpet er dermed bindende. Denne e-posten er bekreftelsen din – ta vare på den."),
        "p9-05: the confirmation lead stands");

      const dec = R("declined");
      swap(dec.text, [`${NAME} kunne dessverre ikke ta imot bestillingen din (bestilling 331197ea).`], ["(ordre ", "fordi varen er utsolgt"],
        "p7-03 / p10-01: a plain decline — «(bestilling X)», no reason");
      eq(R("declined", { declineDetail: "sold_out" }).text.split("\n")[2],
        `${NAME} kunne dessverre ikke ta imot bestillingen din fordi varen er utsolgt (bestilling 331197ea).`, "p10-02: «Avslå – utsolgt» — the reason in the decline receipt");
      for (const reason of ["producer_no_response", "producer_cancelled", "buyer_cancelled", "no_show"]) {
        const c = R("cancelled", { cancelReason: reason }).text;
        swap(c, ["(Bestilling 331197ea.)"], ["(Ordre "], `p7-04: the cancellation receipt (${reason}) — «(Bestilling X.)»`);
      }
    }

    // ── 10. «Avslå – utsolgt» end to end: the button → the stored reason → the receipt ─
    {
      process.env.ORDER_BUYER_RECEIPTS_ENABLED = "1";
      // The button's posted form maps to decline + the sold-out choice (T12 component, soft-expiry rule on).
      process.env.STOCK_SOFT_EXPIRY_ENABLED = "1";
      process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = "rfb:ag-tpc";
      const mapped = actionsSvc.t12SellerActionFrom({ action: "decline_sold_out", sold_out: "prod-x" }, "ag-tpc");
      ok(!!mapped && mapped.action === "decline" && !!mapped.soldOut, "p10-03: «Avslå – utsolgt» posts decline with the sold-out choice");
      const a = seedOrder("pending");
      const b = seedOrder("pending");
      receipts.length = 0;
      const ra = await actionsSvc.applyOrderAction(a, "decline", { role: "seller", channel: "owner_portal" }, { soldOut: { productIds: [`prod-${a}`] } });
      const rb = await actionsSvc.applyOrderAction(b, "decline", { role: "seller", channel: "owner_portal" });
      await settle();
      const row = (id: string) => db.prepare("SELECT status, cancel_reason, cancel_detail FROM orders WHERE id = ?").get(id);
      eq([ra.success, row(a)], [true, { status: "declined", cancel_reason: null, cancel_detail: "sold_out" }], "p10-04: the reason is stored with the declined order");
      eq([rb.success, row(b)], [true, { status: "declined", cancel_reason: null, cancel_detail: null }], "p10-05: a plain decline stores no reason");
      const recA = receipts.find((x) => x.text.includes(`(bestilling ${a.slice(0, 8)})`) && x.subject.includes("ikke bekreftet"));
      ok(receipts.length === 2 && receipts.every((x) => x.to === "kari.tpc@example.com"), "p10-06: both decline receipts were sent to the buyer");
      ok(!!receipts.find((x) => x.text.includes(`${NAME} kunne dessverre ikke ta imot bestillingen din fordi varen er utsolgt (bestilling ${a.slice(0, 8)}).`)),
        "p10-07: the «utsolgt» decline receipt says why");
      ok(!!receipts.find((x) => x.text.includes(`${NAME} kunne dessverre ikke ta imot bestillingen din (bestilling ${b.slice(0, 8)}).`)) && !!recA,
        "p10-08: the plain decline receipt is as today, with «bestilling»");
      // The public option stays narrow: cancelDetail is still refused with decline (the reason comes only from the sold-out choice).
      const bad = await actionsSvc.applyOrderAction(seedOrder("pending"), "decline", { role: "seller", channel: "owner_portal" }, { cancelDetail: "sold_out" });
      ok(!bad.success && bad.status === 400, "p10-09: cancelDetail is still only accepted with cannot_deliver");
      delete process.env.STOCK_SOFT_EXPIRY_ENABLED;
      delete process.env.OWNER_FEATURES_ALLOWED_SUBJECTS;
    }

    // ── 11. T12 sentence; 12. buyer limit texts stand ────────────────────────
    {
      const t12 = R("cancelled", { cancelReason: "producer_cancelled", cancelDetail: "sold_out" }).text;
      ok(t12.includes(`${NAME} har kansellert bestillingen fordi varen er utsolgt.`), "p11-01: the T12 sentence «… fordi varen er utsolgt.» exists");
      ok(R("cancelled", { cancelReason: "producer_cancelled" }).text.includes(`${NAME} har kansellert bestillingen fordi den ikke kan leveres.`),
        "p11-02: without the detail the sentence stands");
      eq(texts.buyerOrderCapNotice("buyer_open_cap", 3, "no").startsWith("Du har allerede 3 ubesvarte bestillinger hos denne produsenten, så denne ble ikke sendt."), true,
        "p12-01: the buyer's open-limit text stands");
      eq(texts.buyerOrderCapNotice("buyer_daily_cap", 10, "no").startsWith("Du har sendt 10 bestillinger til denne produsenten i dag, så denne ble ikke sendt."), true,
        "p12-02: the buyer's daily-limit text stands");
      eq(texts.buyerOrderCapNotice("platform_ceiling", 50, "no").startsWith("Produsenten tar ikke imot flere bestillinger gjennom Rett fra Bonden i dag, så bestillingen ble ikke sendt."), true,
        "p12-03: the ceiling text stands");
    }

    // ── 13–15. /kjopsvilkar ──────────────────────────────────────────────────
    {
      const kv = require("./rfb-kjopsvilkar") as typeof import("./rfb-kjopsvilkar");
      const no = kv.renderKjopsvilkarContent("no");
      const P13 = "Bestillingen er en forespørsel til produsenten har bekreftet den. Svarer ikke produsenten innen 72 timer, blir bestillingen kansellert.";
      const P14 = "Noen produsenter tar ikke imot bestillinger gjennom oss, eller har fått mange bestillinger samme dag. Da får du i stedet produsentens kontaktinformasjon og en ferdig melding";
      const P15 = "Før produsenten har bekreftet bestillingen, kan du trekke den tilbake uten kostnad på bestillingssiden (lenken i e-posten fra oss) eller ved å gi produsenten beskjed.";
      swap(no, [P13], ["til produsenten til produsenten"], "p13-01: punkt 2 — no doubled «til produsenten», the 72-hour deadline");
      swap(no, [P14], ["Noen produsenter tar ikke imot bestillinger gjennom oss. Da får du"], "p14-01: punkt 2 — «eller har fått mange bestillinger samme dag»");
      swap(no, [P15], ["kan du trekke den tilbake uten kostnad ved å gi produsenten beskjed."], "p15-01: punkt 6 — «på bestillingssiden (lenken i e-posten fra oss)»");
      process.env.ORDER_AUTOCANCEL_HOURS = "48";
      ok(kv.renderKjopsvilkarContent("no").includes("Svarer ikke produsenten innen 48 timer, blir bestillingen kansellert."), "p13-02: the deadline comes from orderAutocancelHours()");
      delete process.env.ORDER_AUTOCANCEL_HOURS;
      // Legal sections 6–10 (avbestilling, ikke hentet, angrerett incl. angreskjema, reklamasjon, refusjon):
      // byte-identical to before pakke C apart from the punkt 15 sentence.
      const cfg = vc.getConfig();
      const legal = no.slice(no.indexOf('<h2 id="avbestilling">'), no.indexOf('<h2 id="ai-assistent">'))
        .split(cfg.display_name).join("{BRAND}").split(cfg.domain).join("{DOMAIN}")
        .replace("uten kostnad på bestillingssiden (lenken i e-posten fra oss) eller ved å gi", "uten kostnad ved å gi");
      eq(createHash("sha256").update(legal).digest("hex"), "d200844d9b15f2e67b8340b5cb6a45802005cb52dce47d7278a1a8036b1ffd09",
        "p15-02: the legal sections (6–10 and the angreskjema) are byte-identical apart from punkt 15");
    }
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${String(err?.stack || err)}`);
  } finally {
    notifySvc.__setOrderNotifySendForTesting(null);
    notifySvc.__setOrderNotifyTestDb(null);
    receiptSvc.__setBuyerReceiptSendForTesting(null);
    receiptSvc.__setBuyerReceiptTestDb(null);
    capSvc.__setOrderCapNoticeTestDb(null);
    actionsSvc.__setOrderActionsTestDb(null);
    cartSvc.__setCartTestDb(null);
    trustSvc.__setTrustEventTestDb(null);
    for (const k of SAVED_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* best-effort */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── owner-tekstpakke-c tests ──");
  runOwnerTekstpakkeCTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
