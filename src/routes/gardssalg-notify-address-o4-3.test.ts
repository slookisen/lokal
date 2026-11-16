/**
 * gardssalg-notify-address-o4-3.test.ts — A2A dev-request 2026-11-12-
 * opplevagent-o4-epost-og-tekster, slice O4-3: the owner confirms the
 * address booking requests go to (flag GARDSSALG_NOTIFY_ADDRESS_CONFIRM_ENABLED).
 *
 *   AK1  flag on: switching «Ta imot besøk» on without a confirmed address is
 *        refused with `addr.required` — the JSON PUT (409), the «Mine valg»
 *        page POST, and the portal writer (updateClaimedProviderProfile).
 *   AK2  a GET on the confirmation link changes nothing (both databases);
 *        only the POST from the page's button confirms; the token is
 *        single-use, expires after 24 hours, is stored only as a hash.
 *   AK3  flag off: the «Mine valg» page is byte-identical whatever the new
 *        table holds, the switch turns on as before, the new URLs fall
 *        through (no route of their own), and requests go to experience_
 *        providers.epost.
 *   (c)  address changed after a confirmation: confirmed again; requests go
 *        to the old address until then; the change notice (3.4) goes to the
 *        old address once and never names the new one.
 *   (t)  the register holds OA-3 §3 verbatim, Norwegian and English.
 *
 * Fixtures: in-memory databases, test producers with example.no addresses;
 * every e-mail send is stubbed. No real data is touched.
 *
 * Exported runGardssalgNotifyAddressO43Tests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/routes/gardssalg-notify-address-o4-3.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const FLAG = "GARDSSALG_NOTIFY_ADDRESS_CONFIRM_ENABLED";
const HOUR = 3600_000;

// OA-3 §3, copied verbatim from the approved package (Daniel 2026-11-15).
const OA3: Record<string, { nb: string; en: string }> = {
  "addr.label": { nb: "E-postadresse for forespørsler", en: "Email address for visit requests" },
  "addr.help": { nb: "Hit sender vi forespørsler om besøk. Bruk en adresse dere leser hver dag.", en: "We send visit requests to this address. Use one that is read every day." },
  "addr.send": { nb: "Send bekreftelse", en: "Send confirmation" },
  "addr.sent": { nb: "Vi har sendt en e-post til {adresse}. Åpne den og bekreft adressen. Lenken virker i 24 timer.", en: "We have sent an email to {adresse}. Open it and confirm the address. The link works for 24 hours." },
  "addr.confirmed": { nb: "Bekreftet {dato}", en: "Confirmed {dato}" },
  "addr.required": { nb: "Du må bekrefte adressen for forespørsler før du kan slå på «Ta imot besøk».", en: "You need to confirm the address for requests before you can turn on «Ta imot besøk»." },
  "addr.changed": { nb: "Adressen er endret og må bekreftes på nytt. Forespørsler går til den gamle adressen til den nye er bekreftet.", en: "The address has been changed and must be confirmed again. Requests go to the old address until the new one is confirmed." },
  "addr.email.subject": { nb: "Bekreft adressen for besøksforespørsler — {produsent}", en: "Confirm the address for visit requests — {produsent}" },
  "addr.email.body": {
    nb: "Hei,\n\nNoen som er logget inn som eier av {produsent} på Opplevagent, har oppgitt denne adressen som mottaker av forespørsler om besøk.\n\nStemmer det, bekrefter du her: {lenke}\n\nLenken virker i 24 timer. Stemmer det ikke, trenger du ikke gjøre noe. Da sender vi ingenting hit.\n\nHilsen\nOpplevagent",
    en: "Hi,\n\nSomeone signed in as the owner of {produsent} on Opplevagent has given this address as the recipient of visit requests.\n\nIf that is right, confirm here: {lenke}\n\nThe link works for 24 hours. If it is not right, you do not need to do anything. We will then send nothing to this address.\n\nBest regards,\nOpplevagent",
  },
  "addr.page.heading": { nb: "Bekreft adressen for forespørsler", en: "Confirm the address for requests" },
  "addr.page.body": { nb: "Forespørsler om besøk hos {produsent} sendes til {adresse}.", en: "Visit requests for {produsent} will be sent to {adresse}." },
  "addr.page.button": { nb: "Bekreft adressen", en: "Confirm the address" },
  "addr.page.done": { nb: "Adressen er bekreftet. Du kan nå slå på «Ta imot besøk» under «Mine valg».", en: "The address is confirmed. You can now turn on «Ta imot besøk» under «Mine valg»." },
  "addr.page.expired": { nb: "Lenken er utløpt eller brukt. Send en ny bekreftelse fra «Mine valg».", en: "The link has expired or has been used. Send a new confirmation from «Mine valg»." },
  "addr.changeNotice.subject": { nb: "Adressen for besøksforespørsler er endret — {produsent}", en: "The address for visit requests has been changed — {produsent}" },
  "addr.changeNotice.body": {
    nb: "Hei,\n\nAdressen som mottar forespørsler om besøk hos {produsent} på Opplevagent, er endret. Når den nye adressen er bekreftet, kommer forespørslene ikke lenger hit.\n\nHar dere ikke gjort endringen selv, svarer du på denne e-posten, så hjelper vi dere.\n\nHilsen\nOpplevagent",
    en: "Hi,\n\nThe address that receives visit requests for {produsent} on Opplevagent has been changed. Once the new address is confirmed, requests will no longer be sent here.\n\nIf you did not make this change, reply to this email and we will help you.\n\nBest regards,\nOpplevagent",
  },
};

export function runGardssalgNotifyAddressO43Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    assertEq(!!cond, true, label);
  }

  return (async () => {
    const ENV_KEYS = ["EXPERIENCES_DB_PATH", "OA_OWNER_FEATURES_ENABLED", "OWNER_FEATURES_ALLOWED_SUBJECTS", "BOOKING_DISPATCH_ENABLED",
      "WRITE_GUARD_FETCH_METADATA", "OPPLEVAGENT_BASE_URL", "GARDSSALG_OWNER_DASHBOARD_ENABLED", FLAG];
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env[FLAG];
    delete process.env.WRITE_GUARD_FETCH_METADATA;
    delete process.env.GARDSSALG_OWNER_DASHBOARD_ENABLED;
    process.env.OPPLEVAGENT_BASE_URL = "https://opplevagent.no";
    process.env.OA_OWNER_FEATURES_ENABLED = "1";
    process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = "gardssalg:o43-a,gardssalg:o43-b,gardssalg:o43-off";

    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("../services/gardssalg-claim"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("../services/blocklist-service"),
      require.resolve("../services/gardssalg-notify-address"),
      require.resolve("../services/gardssalg-booking-gate"),
      require.resolve("./gardssalg-claim"),
      require.resolve("./gardssalg-owner-features"),
      require.resolve("./gardssalg-notify-address"),
    ]);
    const LOOPBACK_KEY = "127.0.0.1";
    const { generalLimiter } = require("../middleware/security") as typeof import("../middleware/security");
    try { await generalLimiter.resetKey(LOOPBACK_KEY); } catch { /* ignore */ }
    const servers: any[] = [];
    let prevRfbDb: any = null;
    let initMod: typeof import("../database/init") | null = null;
    const emailSvc = (require("../services/email-service") as typeof import("../services/email-service")).emailService as any;
    const prevSendEmail = emailSvc.sendEmail;
    type Mail = { to: string; subject: string; text: string; html: string; from: string };
    const sent: Mail[] = [];
    let failSends = false;
    emailSvc.sendEmail = async (o: any) => {
      if (failSends) return { success: false, error: "stub failure" };
      sent.push({ to: o.to, subject: o.subject, text: o.textContent, html: o.htmlContent, from: String(o.from || "") });
      return { success: true, messageId: "stub" };
    };

    try {
      initMod = require("../database/init") as typeof import("../database/init");
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const rfbDb = new Database(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const svc = require("../services/gardssalg-notify-address") as typeof import("../services/gardssalg-notify-address");
      const claimSvc = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
      const store = require("../services/booking-store") as typeof import("../services/booking-store");

      // ── fixtures ──────────────────────────────────────────────────────
      const insertProvider = expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, brreg_active, hjemmeside, epost, content_source, products,
           producer_type, enrichment_state, verification_status, source, confidence, booking_live, is_test_provider, claimed_at)
        VALUES
          (@id, @navn, @slug, 'experiences', @org_nr, 1, 1, @hjemmeside, @epost, 'claim', '[]',
           'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium', 0, 1, '2026-11-01 10:00:00')
      `);
      const mkProvider = (id: string, navn: string, slug: string, org: string) =>
        insertProvider.run({ id, navn, slug, org_nr: org, hjemmeside: `https://${slug}.example.no`, epost: `besok@${slug}.example.no` });
      mkProvider("o43-a", "Testgård A", "o43agard", "918300001");
      mkProvider("o43-b", "Testgård B", "o43bgard", "918300002");
      mkProvider("o43-off", "Testgård Av", "o43avgard", "918300003");
      const claimRow = expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at)
         VALUES (?, ?, ?, 'verified_domain_address', ?, 1, datetime('now'), datetime('now','+7 days'))`,
      );
      for (const pid of ["o43-a", "o43-b", "o43-off"]) claimRow.run(`gsc_${pid}`, pid, `eier@${pid}.example.no`, `tok43-${pid}`);
      const addrA = "besok@o43agard.example.no";
      const addrB = "besok@o43bgard.example.no";

      const provider = (id: string) => expDb.prepare(`SELECT booking_live, epost FROM experience_providers WHERE id = ?`).get(id) as any;
      const addrRow = (id: string) => (expDb.prepare(`SELECT * FROM gardssalg_notify_address WHERE provider_id = ?`).get(id) as any) ?? null;
      const changes = () => [(expDb.prepare("SELECT total_changes() AS n").get() as any).n, (rfbDb.prepare("SELECT total_changes() AS n").get() as any).n];
      const setFlag = (v: string | undefined) => { if (v === undefined) delete process.env[FLAG]; else process.env[FLAG] = v; };

      // ── HTTP wiring ───────────────────────────────────────────────────
      const expressMod = require("express") as typeof import("express");
      const claimRouter = (require("./gardssalg-claim") as typeof import("./gardssalg-claim")).default;
      const app = expressMod();
      app.use("/", claimRouter);
      app.use((_req, res) => { res.status(404).type("text/plain").send("fallthrough-404"); });
      const httpMod = require("http") as typeof import("http");
      const server = httpMod.createServer(app);
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      type Resp = { status: number; headers: any; body: string };
      const request = (method: string, path: string, headers: Record<string, string> = {}, body?: string, type = "application/x-www-form-urlencoded") =>
        new Promise<Resp>((resolve, reject) => {
          const h: Record<string, string | number> = { ...headers };
          if (body !== undefined) {
            h["Content-Type"] = type;
            h["Content-Length"] = Buffer.byteLength(body);
          }
          const r = httpMod.request({ method, host: "127.0.0.1", port, path, headers: h }, (resp) => {
            const chunks: Buffer[] = [];
            resp.on("data", (c) => chunks.push(c as Buffer));
            resp.on("end", () => resolve({ status: resp.statusCode || 0, headers: resp.headers, body: Buffer.concat(chunks).toString("utf8") }));
          });
          r.on("error", reject);
          if (body !== undefined) r.write(body);
          r.end();
        });
      const cookie = (pid: string) => ({ Cookie: `oa_owner_session=tok43-${pid}` });
      const browserForm = { Origin: "null", "Sec-Fetch-Site": "same-origin" };
      const valg = (slug: string) => `/kategori/gardssalg/eier/${slug}/valg`;
      const form = (f: Record<string, string>) => new URLSearchParams(f).toString();
      const getValg = (slug: string, pid: string) => request("GET", valg(slug), cookie(pid));
      const putBooking = (pid: string, value: boolean) =>
        request("PUT", `/api/opplevelser/gardssalg-claim/${pid}/features/booking.enabled`, { ...cookie(pid), ...browserForm }, JSON.stringify({ value }), "application/json");
      const sendConfirm = (slug: string, pid: string, extra: Record<string, string> = browserForm) =>
        request("POST", `${valg(slug)}/adresse`, { ...cookie(pid), ...extra }, form({}));
      const linkOf = (m: Mail) => {
        const x = /https:\/\/opplevagent\.no(\/kategori\/gardssalg\/eier\/adresse\/[0-9a-f]{64})/.exec(m.text);
        return x ? x[1] : "";
      };
      const unescape = (s: string) => s.replace(/&#039;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      const fill = (t: string, v: Record<string, string>) => t.replace(/\{([a-zæøå_]+)\}/g, (m, n) => (n in v ? v[n] : m));

      // ── (t) the register: OA-3 §3 verbatim, nb + en ────────────────────
      {
        const R = svc.GARDSSALG_ADDRESS_TEXTS as Record<string, { nb: string; en: string }>;
        assertEq(Object.keys(R).sort(), Object.keys(OA3).sort(), "t1: the register has exactly the OA-3 §3 keys");
        for (const k of Object.keys(OA3)) {
          assertEq(R[k]?.nb, OA3[k].nb, `t2: ${k} nb verbatim`);
          assertEq(R[k]?.en, OA3[k].en, `t3: ${k} en verbatim`);
        }
        assertEq(svc.gardssalgNotifyAddressConfirmEnabled({} as any), false, "t4: flag unset → off");
        for (const v of ["1", "on", "TRUE", "true "]) assertEq(svc.gardssalgNotifyAddressConfirmEnabled({ [FLAG]: v } as any), false, `t5: flag ${JSON.stringify(v)} → off`);
        assertEq(svc.gardssalgNotifyAddressConfirmEnabled({ [FLAG]: "true" } as any), true, "t6: flag \"true\" → on");
      }

      // ── AK3: flag off ─────────────────────────────────────────────────
      setFlag(undefined);
      {
        const before = await getValg("o43avgard", "o43-off");
        assertEq(before.status, 200, "f1: flag off → «Mine valg» 200");
        assertTrue(!before.body.includes("data-addr-") && !before.body.includes("/valg/adresse"), "f2: flag off → no address block, no new form");
        for (const k of Object.keys(OA3)) {
          if (k.startsWith("addr.email") || k.startsWith("addr.changeNotice") || k === "addr.confirmed") continue;
          assertTrue(!unescape(before.body).includes(fill(OA3[k].nb, {})), `f3: flag off → no «${k}» on the page`);
        }
        // Whatever the new table holds, the page and the recipient are as before.
        expDb.prepare(`INSERT INTO gardssalg_notify_address (provider_id, confirmed_email, confirmed_at) VALUES ('o43-off', 'gammel@o43avgard.example.no', '2026-11-01T10:00:00.000Z')`).run();
        const after = await getValg("o43avgard", "o43-off");
        assertEq(after.body, before.body, "f4: flag off → «Mine valg» byte-identical whatever the address table holds");
        assertTrue(after.body.includes(`Forespørsler sendes til <strong>besok@o43avgard.example.no</strong>`), "f5: flag off → requests shown going to experience_providers.epost");
        assertEq(svc.gardssalgNotifyRecipient("o43-off", "besok@o43avgard.example.no"), "besok@o43avgard.example.no", "f6: flag off → recipient is epost");

        const ch = changes();
        const p = await sendConfirm("o43avgard", "o43-off");
        assertEq([p.status, p.body], [404, "fallthrough-404"], "f7: flag off → POST …/valg/adresse falls through (no route)");
        assertEq((await request("GET", `/kategori/gardssalg/eier/adresse/${"a".repeat(64)}`)).body, "fallthrough-404", "f8: flag off → GET link falls through");
        assertEq((await request("POST", `/kategori/gardssalg/eier/adresse/${"a".repeat(64)}`, browserForm, "")).body, "fallthrough-404", "f9: flag off → POST link falls through");
        assertEq(changes(), ch, "f10: flag off → nothing written by the new URLs");
        assertEq(sent.length, 0, "f11: flag off → no e-mail");

        // The switch turns on as before, with no confirmed address.
        const on = await putBooking("o43-off", true);
        assertEq(on.status, 200, "f12: flag off → «Ta imot besøk» turns on without a confirmation (as today)");
        assertEq(provider("o43-off").booking_live, 1, "f13: flag off → booking_live = 1");
        const gate = require("../services/gardssalg-booking-gate") as typeof import("../services/gardssalg-booking-gate");
        assertEq(gate.ownerBookingEnableBlock({ id: "o43-a", epost: addrA, booking_admin_brake_at: null, booking_admin_brake_note: null }), null,
          "f14: flag off → the portal's enable gate does not ask for a confirmation");
      }

      setFlag("true");

      // ── AK1: no confirmed address → refused with addr.required ─────────
      {
        const page = await getValg("o43agard", "o43-a");
        assertEq(page.status, 200, "a1: flag on → «Mine valg» 200");
        assertTrue(page.body.includes('data-addr-state="unconfirmed"') && unescape(page.body).includes(OA3["addr.required"].nb), "a2: page shows addr.required");
        assertTrue(unescape(page.body).includes(OA3["addr.label"].nb) && unescape(page.body).includes(OA3["addr.help"].nb), "a3: page shows addr.label and addr.help");
        assertTrue(page.body.includes(`action="/kategori/gardssalg/eier/o43agard/valg/adresse"`) && page.body.includes(`>${OA3["addr.send"].nb}</button>`), "a4: «Send bekreftelse» is a plain POST form");

        const ch = changes();
        const put = await putBooking("o43-a", true);
        assertEq(put.status, 409, "a5: PUT booking.enabled=true → 409");
        const j = JSON.parse(put.body);
        assertEq([j.error, j.reason, j.reason_en], ["requirement_not_met", OA3["addr.required"].nb, OA3["addr.required"].en], "a6: the 409 explains with addr.required (nb + en)");
        assertEq(provider("o43-a").booking_live, 0, "a7: booking_live stays 0");

        const sett = await request("POST", `${valg("o43agard")}/sett`, { ...cookie("o43-a"), ...browserForm }, form({ key: "booking.enabled", value: "true", confirmed: "1" }));
        assertEq(sett.status, 303, "a8: page POST → 303");
        assertTrue(/melding=(krav|sperret)/.test(String(sett.headers.location)), "a9: page POST → refused (krav/sperret)");
        assertEq(provider("o43-a").booking_live, 0, "a10: page POST → booking_live stays 0");
        assertEq(changes(), ch, "a11: nothing written by the refused switch-on");

        const portal = claimSvc.updateClaimedProviderProfile("o43-a", { booking_live: 1 }) as any;
        assertEq([portal.ok, portal.error, portal.block?.reason, portal.block?.message], [false, "booking_blocked", "address_unconfirmed", OA3["addr.required"].nb],
          "a12: the portal writer refuses with addr.required");
        assertEq(provider("o43-a").booking_live, 0, "a13: portal writer → booking_live stays 0");
      }

      // ── Send bekreftelse ───────────────────────────────────────────────
      let link = "";
      {
        const foreign = await sendConfirm("o43agard", "o43-a", { Origin: "https://evil.example" });
        assertEq(foreign.status, 403, "s1: a foreign Origin → 403");
        assertEq(sent.length, 0, "s2: … and no e-mail");
        const noSession = await request("POST", `${valg("o43agard")}/adresse`, browserForm, "");
        assertEq(noSession.status, 401, "s3: no session → 401");
        const other = await sendConfirm("o43agard", "o43-b");
        assertEq(other.status, 403, "s4: another producer's session → 403");
        assertEq(sent.length, 0, "s5: no e-mail for refused requests");

        const r = await sendConfirm("o43agard", "o43-a");
        assertEq(r.status, 303, "s6: POST …/valg/adresse → 303");
        assertEq(String(r.headers.location), "/kategori/gardssalg/eier/o43agard/valg#valg-booking.enabled", "s7: back to the «Ta imot besøk» row");
        assertEq(sent.length, 1, "s8: one e-mail");
        const m = sent[0];
        assertEq(m.to, addrA, "s9: to the address requests go to");
        assertEq(m.subject, fill(OA3["addr.email.subject"].nb, { produsent: "Testgård A" }), "s10: subject verbatim (3.2)");
        link = linkOf(m);
        assertTrue(link !== "", "s11: the e-mail carries an opplevagent.no link with a 64-hex token");
        assertEq(m.text, fill(OA3["addr.email.body"].nb, { produsent: "Testgård A", lenke: `https://opplevagent.no${link}` }), "s12: body verbatim (3.2)");
        assertTrue(m.html.includes(`<a href="https://opplevagent.no${link}">`), "s13: the HTML part links the page");
        assertTrue(/opplevagent|rettfrabonden/i.test(m.from) && !/gmail|hotmail|outlook/i.test(m.from), "s14: sent from the platform's own sender");
        const token = link.split("/").pop()!;
        const row = addrRow("o43-a");
        assertTrue(row && row.token_hash && row.token_hash !== token && row.token_hash.length === 64, "s15: the token is stored only as a hash");
        assertTrue(!JSON.stringify(row).includes(token), "s16: the raw token is not in the row");
        assertEq(Date.parse(row.token_expires_at) - Date.parse(row.token_sent_at), 24 * HOUR, "s17: the link works for 24 hours");

        const page = await getValg("o43agard", "o43-a");
        assertTrue(page.body.includes('data-addr-state="pending"') && unescape(page.body).includes(fill(OA3["addr.sent"].nb, { adresse: addrA })), "s18: page shows addr.sent");
        const again = await sendConfirm("o43agard", "o43-a");
        assertEq(again.status, 303, "s19: a double click → 303");
        assertEq(sent.length, 1, "s20: a double click sends no second e-mail");
        assertEq(addrRow("o43-a").token_hash, row.token_hash, "s21: … and keeps the token");
      }

      // ── AK2: GET on the link changes nothing ──────────────────────────
      {
        const snapshot = JSON.stringify([addrRow("o43-a"), provider("o43-a")]);
        const ch = changes();
        const g1 = await request("GET", link);
        const g2 = await request("GET", link);
        assertEq([g1.status, g2.status], [200, 200], "k1: GET link → 200 (twice)");
        assertEq(changes(), ch, "k2: AK2 — GET on the link writes nothing (both databases)");
        assertEq(JSON.stringify([addrRow("o43-a"), provider("o43-a")]), snapshot, "k3: AK2 — the rows are unchanged");
        assertEq(svc.notifyAddressState("o43-a", addrA).kind, "pending", "k4: still not confirmed after GETs");
        const b = unescape(g1.body);
        assertTrue(b.includes(OA3["addr.page.heading"].nb) && b.includes(fill(OA3["addr.page.body"].nb, { produsent: "Testgård A", adresse: addrA })), "k5: page 3.3 heading + body verbatim");
        assertTrue(g1.body.includes(`<form method="post" action="${link}">`) && b.includes(`>${OA3["addr.page.button"].nb}</button>`), "k6: the button is a POST form");
        assertEq([g1.headers["cache-control"], g1.headers["referrer-policy"]], ["no-store", "no-referrer"], "k7: no-store + no-referrer");
        assertTrue(String(g1.headers["x-robots-tag"]).includes("noindex"), "k8: noindex");

        const head = await request("HEAD", link);
        assertEq(head.status, 200, "k9: HEAD → 200");
        assertEq(changes(), ch, "k10: HEAD writes nothing");

        const foreign = await request("POST", link, { Origin: "https://evil.example" }, "");
        assertEq(foreign.status, 403, "k11: POST from a foreign Origin → 403");
        assertEq(changes(), ch, "k12: … nothing written");

        for (const bad of ["a".repeat(64), "short", link.split("/").pop()!.toUpperCase()]) {
          const r = await request("GET", `/kategori/gardssalg/eier/adresse/${bad}`);
          assertEq(r.status, 410, `k13: unknown token ${bad.slice(0, 8)}… → 410`);
          assertTrue(unescape(r.body).includes(OA3["addr.page.expired"].nb), `k14: unknown token → addr.page.expired`);
        }
        const pBad = await request("POST", `/kategori/gardssalg/eier/adresse/${"b".repeat(64)}`, browserForm, "");
        assertEq(pBad.status, 410, "k15: POST with an unknown token → 410");
        assertEq(changes(), ch, "k16: … nothing written");

        const ok = await request("POST", link, browserForm, "");
        assertEq(ok.status, 200, "k17: POST from the page → 200");
        assertTrue(unescape(ok.body).includes(OA3["addr.page.done"].nb), "k18: addr.page.done");
        const st = svc.notifyAddressState("o43-a", addrA);
        assertEq(st.kind, "confirmed", "k19: the address is confirmed");
        assertEq(addrRow("o43-a").token_hash, null, "k20: the token is used up");
        const reuse = await request("POST", link, browserForm, "");
        assertEq(reuse.status, 410, "k21: a second POST → 410 (single use)");
        assertTrue(unescape(reuse.body).includes(OA3["addr.page.expired"].nb), "k22: … addr.page.expired");
        assertEq((await request("GET", link)).status, 410, "k23: GET after use → 410");
      }

      // ── registry: contact.booking_email (live behind the flag, confirmByEmail) ──
      {
        const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");
        const e = reg.GARDSSALG_OWNER_FEATURE_REGISTRY.find((x) => x.key === "contact.booking_email")!;
        assertEq([e.status, e.liveFlag, e.devRequest, e.confirmByEmail, e.outward],
          ["live", FLAG, "2026-11-12-opplevagent-o4-epost-og-tekster", true, true], "r1: contact.booking_email is live behind the flag, confirmByEmail, outward");
        assertEq(e.surfaces, ["email:booking_request", "email:address_confirm", "email:address_change_notice", "owner_portal"], "r2: its surfaces");
        assertEq(reg.ownerFeatureStatus(e, { [FLAG]: "true" } as any), "live", "r3: flag on → live");
        assertEq(reg.ownerFeatureStatus(e, {} as any), "coming_soon", "r4: flag off → coming_soon");
        const page = await getValg("o43agard", "o43-a");
        const rowM = /<li class="mv-item" id="valg-contact\.booking_email"[\s\S]*?<\/li>/.exec(page.body);
        assertTrue(!!rowM && rowM[0].includes(addrA), "r5: flag on → the row shows where requests go");
        assertTrue(!!rowM && !rowM[0].includes("<form") && !rowM[0].includes("<input"), "r6: … with no direct edit form");
        const ch = changes();
        const put = await request("PUT", `/api/opplevelser/gardssalg-claim/o43-a/features/contact.booking_email`, { ...cookie("o43-a"), ...browserForm }, JSON.stringify({ value: "x@example.no" }), "application/json");
        assertEq([put.status, JSON.parse(put.body).error], [409, "confirm_by_email"], "r7: a direct write → 409 confirm_by_email");
        assertEq(changes(), ch, "r8: … nothing written");
        setFlag(undefined);
        const off = await getValg("o43agard", "o43-a");
        assertTrue(!off.body.includes('id="valg-contact.booking_email"') && off.body.includes('data-planned-key="contact.booking_email"'), "r9: flag off → planned only, as before");
        setFlag("true");
      }

      // ── confirmed → the switch turns on ───────────────────────────────
      {
        const page = await getValg("o43agard", "o43-a");
        assertTrue(page.body.includes('data-addr-state="confirmed"') && /Bekreftet \d{1,2}\. [a-zæøå]+ \d{4}/.test(page.body), "c1: page shows addr.confirmed with the date");
        assertTrue(!page.body.includes(`action="/kategori/gardssalg/eier/o43agard/valg/adresse"`), "c2: no send button once confirmed");
        const put = await putBooking("o43-a", true);
        assertEq(put.status, 200, "c3: PUT booking.enabled=true → 200 after confirmation");
        assertEq(provider("o43-a").booking_live, 1, "c4: booking_live = 1");
        const n = sent.length;
        assertEq((await sendConfirm("o43agard", "o43-a")).status, 303, "c5: «Send bekreftelse» on a confirmed address → 303");
        assertEq(sent.length, n, "c6: … no e-mail");
      }

      // ── expiry (24 h) ─────────────────────────────────────────────────
      {
        const n = sent.length;
        const past = new Date(Date.now() - 25 * HOUR);
        const out = await svc.requestNotifyAddressConfirmation("o43-b", past);
        assertEq(out.kind, "sent", "x1: a link sent 25 hours ago");
        const l = linkOf(sent[n]);
        const ch = changes();
        const g = await request("GET", l);
        assertEq(g.status, 410, "x2: after 24 hours → 410");
        assertTrue(unescape(g.body).includes(OA3["addr.page.expired"].nb), "x3: … addr.page.expired");
        assertEq((await request("POST", l, browserForm, "")).status, 410, "x4: POST after 24 hours → 410");
        assertEq(changes(), ch, "x5: an expired link writes nothing");
        assertEq(svc.notifyAddressState("o43-b", addrB).kind, "unconfirmed", "x6: still unconfirmed");
        // A new send replaces the old token.
        const t1 = await svc.requestNotifyAddressConfirmation("o43-b");
        const l1 = linkOf(sent[sent.length - 1]);
        const t2 = await svc.requestNotifyAddressConfirmation("o43-b", new Date(Date.now() + 2 * 60_000));
        const l2 = linkOf(sent[sent.length - 1]);
        assertEq([t1.kind, t2.kind], ["sent", "sent"], "x7: two sends");
        assertTrue(l1 !== l2, "x8: a new token each time");
        assertEq((await request("GET", l1)).status, 410, "x9: the older link no longer works");
        assertEq((await request("GET", l2)).status, 200, "x10: the newest link works");
        // A failed send leaves no live token behind.
        failSends = true;
        const f = await svc.requestNotifyAddressConfirmation("o43-b", new Date(Date.now() + 4 * 60_000));
        failSends = false;
        assertEq(f.kind, "failed", "x11: a failed send → failed");
        assertEq(svc.notifyAddressState("o43-b", addrB).kind, "unconfirmed", "x12: … and the page does not claim it was sent");
        // At most five e-mails per producer per 24 hours.
        const th = await svc.requestNotifyAddressConfirmation("o43-b", new Date(Date.now() + 6 * 60_000));
        const th2 = await svc.requestNotifyAddressConfirmation("o43-b", new Date(Date.now() + 8 * 60_000));
        const th3 = await svc.requestNotifyAddressConfirmation("o43-b", new Date(Date.now() + 10 * 60_000));
        assertEq([th.kind, th2.kind], ["sent", "sent"], "x13: the fourth and fifth attempts in the window go");
        assertEq(th3.kind, "throttled", "x14: the sixth attempt in 24 hours is throttled");
      }

      // ── (c) the address changes ───────────────────────────────────────
      {
        const NEW = "ny@o43agard.example.no";
        expDb.prepare(`UPDATE experience_providers SET epost = ? WHERE id = 'o43-a'`).run(NEW);
        const st = svc.notifyAddressState("o43-a", NEW);
        assertEq(st.kind, "unconfirmed", "c7: a changed address must be confirmed again");
        assertEq(svc.gardssalgNotifyRecipient("o43-a", NEW), addrA, "c8: requests go to the old address until the new one is confirmed");
        const page = await getValg("o43agard", "o43-a");
        assertTrue(unescape(page.body).includes(OA3["addr.changed"].nb), "c9: page shows addr.changed");
        assertTrue(page.body.includes(`Forespørsler sendes til <strong>${addrA}</strong>`), "c10: page says requests go to the old address");

        // The producer notification (booking-store) goes to the old address.
        process.env.BOOKING_DISPATCH_ENABLED = "true";
        const n0 = sent.length;
        const booking: any = {
          booking_id: "bid-o43", experience_id: null, provider_id: "o43-a", slot_at: new Date(Date.now() + 48 * HOUR).toISOString(),
          party_size: 2, guest_name: "Gjest", guest_email: "gjest@example.no", guest_phone: null, booking_ref: "GS-O43-1",
          confirm_token: "ctok-o43", source: "web", status: "reserved", resolved_by: null, resolved_at: null, notes: null,
          pre_status: "awaiting_provider", respond_token: "rtok-o43", respond_token_expires_at: null, is_test: 0,
        };
        try { await store.sendProducerNotification(booking, NEW, null); } catch { /* recorded below */ }
        const toProducer = sent.slice(n0).map((m) => m.to);
        assertTrue(toProducer.length >= 1 && toProducer.every((t) => t === addrA), "c11: the booking request e-mail goes to the old, confirmed address");
        // N1: the gated producer e-mails (reminder, cancellation — getProviderDispatchRow) go there too.
        const n0b = sent.length;
        const gated = await store.sendGatedProducerEmail(booking, "o43-test", (to) => ({ subject: "o43 gated", htmlContent: to, textContent: to }));
        assertEq(gated, true, "c11b: a gated producer e-mail is sent");
        assertEq(sent.slice(n0b).map((m) => [m.to, m.text]), [[addrA, addrA]], "c11c: the gated producer e-mail (sendGatedProducerEmail) goes to the old, confirmed address");
        const n0c = sent.length;
        const rem = await store.sendPrevisitReminderToProducer({ ...booking, respond_token_expires_at: new Date(Date.now() + 24 * HOUR).toISOString() });
        assertEq([rem, sent.slice(n0c).map((m) => m.to)], [true, [addrA]], "c11d: the producer reminder goes to the old, confirmed address");

        // Booking turned off: switching on again needs the new address confirmed.
        expDb.prepare(`UPDATE experience_providers SET booking_live = 0 WHERE id = 'o43-a'`).run();
        assertEq((await putBooking("o43-a", true)).status, 409, "c12: switching on with the changed, unconfirmed address → 409");

        const n1 = sent.length;
        const r = await sendConfirm("o43agard", "o43-a");
        assertEq(r.status, 303, "c13: «Send bekreftelse» for the new address → 303");
        const mails = sent.slice(n1);
        assertEq(mails.map((m) => m.to).sort(), [addrA, NEW].sort(), "c14: one e-mail to the new address, one notice to the old");
        const notice = mails.find((m) => m.to === addrA)!;
        assertEq(notice.subject, fill(OA3["addr.changeNotice.subject"].nb, { produsent: "Testgård A" }), "c15: notice subject verbatim (3.4)");
        assertEq(notice.text, fill(OA3["addr.changeNotice.body"].nb, { produsent: "Testgård A" }), "c16: notice body verbatim (3.4)");
        assertTrue(!notice.text.includes(NEW) && !notice.html.includes(NEW) && !notice.subject.includes(NEW), "c17: the notice never names the new address");
        const confirmMail = mails.find((m) => m.to === NEW)!;
        // A later resend does not repeat the notice.
        const n2 = sent.length;
        await svc.requestNotifyAddressConfirmation("o43-a", new Date(Date.now() + 2 * 60_000));
        assertEq(sent.slice(n2).map((m) => m.to), [NEW], "c18: a resend → no second notice to the old address");
        const newest = linkOf(sent[sent.length - 1]);
        assertEq((await request("GET", linkOf(confirmMail))).status, 410, "c19: the replaced link no longer works");
        assertEq((await request("POST", newest, browserForm, "")).status, 200, "c20: the new address confirmed");
        assertEq(svc.gardssalgNotifyRecipient("o43-a", NEW), NEW, "c21: requests now go to the new address");
        assertEq((await putBooking("o43-a", true)).status, 200, "c22: switching on now works");

        // A link for an address that changed after it was sent is stale.
        mkProvider("o43-c", "Testgård C", "o43cgard", "918300004");
        const out = await svc.requestNotifyAddressConfirmation("o43-c");
        assertEq(out.kind, "sent", "c23: a link for o43-c");
        const lc = linkOf(sent[sent.length - 1]);
        expDb.prepare(`UPDATE experience_providers SET epost = 'annen@o43cgard.example.no' WHERE id = 'o43-c'`).run();
        assertEq((await request("GET", lc)).status, 410, "c24: the address changed after the link was sent → 410");
        assertEq((await request("POST", lc, browserForm, "")).status, 410, "c25: … and POST confirms nothing");
        assertEq(svc.notifyAddressState("o43-c", "annen@o43cgard.example.no").kind, "unconfirmed", "c26: the new address is not confirmed by the old link");
      }
    } catch (e: any) {
      failed++;
      failures.push(`unexpected error: ${e?.stack || e}`);
    } finally {
      emailSvc.sendEmail = prevSendEmail;
      for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
      try { await generalLimiter.resetKey(LOOPBACK_KEY); } catch { /* ignore */ }
      if (initMod) initMod.__setDbForTesting(prevRfbDb);
      restoreModuleCache();
      for (const k of ENV_KEYS) {
        if (prevEnv[k] === undefined) delete process.env[k];
        else process.env[k] = prevEnv[k];
      }
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runGardssalgNotifyAddressO43Tests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      for (const f of r.failures) console.log(f);
      process.exit(1);
    }
  });
}
