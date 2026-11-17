/**
 * gardssalg-today-texts-o4-4.test.ts — A2A dev-request 2026-11-12-
 * opplevagent-o4-epost-og-tekster, slice O4-4: «Slik virker det i dag» in
 * the gårdssalg «Mine valg» and the pilot invitation, in one register
 * (src/services/gardssalg-today-texts.ts).
 *
 *   AK1  no owner-facing text in the registers says «5. september» or claims
 *        that the gårdssalg law is adopted (detector + positive controls).
 *   AK2  the register holds tekstpakke OA-3 §2 and §4 verbatim (copied below
 *        from the package approved by Daniel 2026-11-15). The package has
 *        these owner texts in Norwegian only; there is no English to hold.
 *   AK3  no owner- or guest-facing text in the registers (O4-2 e-mails,
 *        O4-3 address texts, O4-4 texts; nb and en) contains «gratis
 *        smaking», «barn velkommen» or a product name from PRODUCT_NAMES.
 *   (b)  no text promises a request while booking is off for the profile.
 *   (f)  flag GARDSSALG_TODAY_TEXTS_ENABLED off: «Mine valg» byte-identical
 *        whatever the law flag says; on: the block at the top, and
 *        `today.law` only with GARDSSALG_TODAY_LAW_ENABLED.
 *   (i)  the pilot invitation only fills the placeholders; nothing is sent.
 *
 * Fixtures: in-memory databases, test producers with example.no addresses;
 * every e-mail send is stubbed. No real data is touched.
 *
 * Exported runGardssalgTodayTextsO44Tests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/gardssalg-today-texts-o4-4.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const FLAG = "GARDSSALG_TODAY_TEXTS_ENABLED";
const LAW_FLAG = "GARDSSALG_TODAY_LAW_ENABLED";

// OA-3 §2, copied verbatim from the approved package (Daniel 2026-11-15).
const OA3_TODAY: Record<string, string> = {
  "today.heading": "Slik virker besøk gjennom Opplevagent",
  "today.request": "En gjest sender en forespørsel om besøk. Ingenting er avtalt før du har bekreftet.",
  "today.reply": "Du får e-post for hver forespørsel og kan bekrefte, foreslå et annet tidspunkt eller avslå. Svarer du ikke innen 60 timer, utløper forespørselen, og gjesten får beskjed.",
  "today.price": "Det er gratis å være med i piloten.",
  "today.noSales": "Opplevagent formidler besøket. Vi selger ikke alkohol og tar ikke imot betaling. Salg, servering og alderskontroll er ditt ansvar, etter bevillingene du har.",
  "today.content": "Profilen beskriver stedet og besøket, ikke varene. Alt som gjelder produktene dine, står på din egen nettside, som vi lenker til.",
  "today.pause": "Du kan slå «Ta imot besøk» av igjen når du vil.",
  "today.law": "Et forslag om utvidet gårdssalg har vært på høring og er til behandling. Det er ikke vedtatt. Besøk gjennom Opplevagent er ikke avhengig av forslaget.",
  "today.bookingOff": "Profilen din viser kontaktinformasjonen din. Gjester kan ikke sende forespørsler gjennom Opplevagent før du har slått på «Ta imot besøk».",
};

// OA-3 §4, copied verbatim from the approved package.
const OA3_INVITE_SUBJECT = "Vil {produsent} være med i piloten på Opplevagent?";
const OA3_INVITE_START = "Først tar du over profilen din her: {krav_url}. Det tar et par minutter.";
const OA3_INVITE_BODY = `Hei {fornavn},

Jeg heter Daniel og står bak Opplevagent. Takk for at du svarte oss {svartid}.

Opplevagent er bygget slik at AI-assistenter som ChatGPT kan bruke den når folk spør hvor de kan dra på besøk. Nå starter jeg en liten pilot der noen få produsenter kan ta imot forespørsler om besøk gjennom Opplevagent, og jeg vil gjerne at {produsent} er med. Dette er tidlig, og jeg kan ikke love mange forespørsler med en gang. Derfor håper jeg at du vil hjelpe meg å teste det i praksis.

{start_setning}

Slik fungerer det:
- En gjest sender en forespørsel om besøk, med tidspunkt og antall. Ingenting er avtalt før du har bekreftet.
- Du får en e-post for hver forespørsel og kan bekrefte, foreslå et annet tidspunkt eller avslå. Svarer du ikke innen 60 timer, utløper forespørselen, og gjesten får beskjed.
- Opplevagent formidler besøket. Vi selger ikke alkohol og tar ikke imot betaling. Salg, servering og alderskontroll er ditt ansvar, etter bevillingene du har.
- Profilen beskriver stedet og besøket, ikke varene. Alt som gjelder produktene, står på din egen nettside, som vi lenker til.
- Det er gratis å være med i piloten, og du kan ta pause eller slutte når du vil.

Vil du være med, logger du inn her: {innlogging}. Under «Mine valg» bekrefter du adressen forespørslene skal sendes til, og slår på «Ta imot besøk».

Har du spørsmål, svarer du på e-posten eller ringer meg på {telefon}. Vil du ikke ha flere e-poster fra oss om piloten, svarer du «nei takk».

Hilsen
Daniel Fredriksen
Opplevagent

Slik behandler vi personopplysninger: {personvern}`;

/**
 * AK3 test list: well-known drink brand and product names. A hit in any
 * owner- or guest-facing register text fails the test.
 */
export const PRODUCT_NAMES: readonly string[] = [
  "Aass", "Ringnes", "Hansa", "Mack", "Lysholm", "Linie", "Løiten", "Gammel Opland", "Arcus",
  "Heineken", "Carlsberg", "Tuborg", "Guinness", "Jägermeister", "Absolut", "Smirnoff", "Bacardi",
  "Hennessy", "Moët", "Grevens", "Nøgne Ø", "Kopparberg", "Somersby",
];

/** AK1: «5. september» or a sentence that says the law is adopted (no negation in that sentence). */
export function ak1Violations(text: string): string[] {
  const out: string[] = [];
  if (/\b5\.?\s*sep(tember|t)?\b/i.test(text) || /\bseptember\s+5(th)?\b/i.test(text)) out.push("5. september");
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const claims = /\b(vedtatt|vedtatte|vedtok|vedtas|trådt i kraft|trer i kraft|ny lov|adopted|passed|enacted|in force)\b/i.test(sentence);
    if (claims && !/\b(ikke|ikkje|not|no)\b/i.test(sentence)) out.push(`law claimed adopted: «${sentence.trim()}»`);
  }
  return out;
}

/** AK3 + content rules: «gratis smaking», «barn velkommen», a product name from the list, strength, medals. */
export function ak3Violations(text: string): string[] {
  const out: string[] = [];
  if (/gratis\s+smak/i.test(text) || /free\s+tasting/i.test(text)) out.push("gratis smaking");
  if (/barn\s+(er\s+)?velkomn?e?/i.test(text) || /children\s+(are\s+)?welcome/i.test(text)) out.push("barn velkommen");
  for (const name of PRODUCT_NAMES) {
    const re = new RegExp(`(?<![\\p{L}\\d])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\d])`, "iu");
    if (re.test(text)) out.push(`product name «${name}»`);
  }
  if (/\d+([.,]\d+)?\s*%\s*(alk|vol|abv)/i.test(text)) out.push("strength");
  if (/\bmedal(je|jer|jen|s)?\b/i.test(text)) out.push("medal");
  return out;
}

export function runGardssalgTodayTextsO44Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      "WRITE_GUARD_FETCH_METADATA", "OPPLEVAGENT_BASE_URL", "GARDSSALG_OWNER_DASHBOARD_ENABLED", "GARDSSALG_NOTIFY_ADDRESS_CONFIRM_ENABLED",
      FLAG, LAW_FLAG];
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env[FLAG];
    delete process.env[LAW_FLAG];
    delete process.env.WRITE_GUARD_FETCH_METADATA;
    delete process.env.GARDSSALG_OWNER_DASHBOARD_ENABLED;
    delete process.env.GARDSSALG_NOTIFY_ADDRESS_CONFIRM_ENABLED;
    process.env.OPPLEVAGENT_BASE_URL = "https://opplevagent.no";
    process.env.OA_OWNER_FEATURES_ENABLED = "1";
    process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = "gardssalg:o44-a";

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
    let sends = 0;
    emailSvc.sendEmail = async () => { sends++; return { success: true, messageId: "stub" }; };

    try {
      const today = require("../services/gardssalg-today-texts") as typeof import("../services/gardssalg-today-texts");
      const emailTexts = require("../services/gardssalg-email-texts") as typeof import("../services/gardssalg-email-texts");
      const addrTexts = require("../services/gardssalg-notify-address") as typeof import("../services/gardssalg-notify-address");

      // ── AK2: OA-3 §2 and §4 verbatim ───────────────────────────────────
      {
        const R = today.GARDSSALG_TODAY_TEXTS as Record<string, string>;
        assertEq(Object.keys(R).sort(), Object.keys(OA3_TODAY).sort(), "t1: the register has exactly the OA-3 §2 keys");
        for (const k of Object.keys(OA3_TODAY)) assertEq(R[k], OA3_TODAY[k], `t2: ${k} verbatim`);
        const I = today.GARDSSALG_PILOT_INVITATION_TEXTS;
        assertEq(I["invite.subject"], OA3_INVITE_SUBJECT, "t3: invitation subject verbatim");
        assertEq(I["invite.body"], OA3_INVITE_BODY, "t4: invitation body verbatim");
        assertEq(I["invite.startSentence.notClaimed"], OA3_INVITE_START, "t5: {start_setning} (not taken over) verbatim");
        assertEq(Object.keys(I).sort(), ["invite.body", "invite.startSentence.notClaimed", "invite.subject"], "t6: no other invitation texts");
        for (const [f, fn] of [[FLAG, today.gardssalgTodayTextsEnabled], [LAW_FLAG, today.gardssalgTodayLawEnabled]] as const) {
          assertEq(fn({} as any), false, `t7: ${f} unset → off`);
          for (const v of ["1", "on", "TRUE", "true "]) assertEq(fn({ [f]: v } as any), false, `t8: ${f} ${JSON.stringify(v)} → off`);
          assertEq(fn({ [f]: "true" } as any), true, `t9: ${f} "true" → on`);
        }
      }

      // Every text in the registers, with who reads it.
      const registerTexts: Array<{ where: string; audience: "owner" | "guest"; text: string }> = [];
      for (const [k, v] of Object.entries(today.GARDSSALG_TODAY_TEXTS)) registerTexts.push({ where: `today ${k}`, audience: "owner", text: v });
      for (const [k, v] of Object.entries(today.GARDSSALG_PILOT_INVITATION_TEXTS)) registerTexts.push({ where: `invite ${k}`, audience: "owner", text: v });
      for (const [k, v] of Object.entries(addrTexts.GARDSSALG_ADDRESS_TEXTS)) {
        registerTexts.push({ where: `addr ${k} nb`, audience: "owner", text: v.nb });
        registerTexts.push({ where: `addr ${k} en`, audience: "owner", text: v.en });
      }
      for (const [k, v] of Object.entries(emailTexts.GARDSSALG_EMAIL_TEXTS as Record<string, { nb: string; en: string | null; audience: string }>)) {
        const audience = v.audience === "producer" ? "owner" : "guest";
        registerTexts.push({ where: `email ${k} nb`, audience, text: v.nb });
        if (v.en) registerTexts.push({ where: `email ${k} en`, audience, text: v.en });
      }
      // The rendered invitation (both start variants) and the blocks.
      const inviteVars = { produsent: "Testgård", fornavn: "Kari", svartid: "i oktober", innlogging: "https://opplevagent.no/eier", telefon: "00000000", personvern: "https://opplevagent.no/personvern" };
      const invClaimed = today.renderPilotInvitation({ ...inviteVars, claimed: true });
      const invNotClaimed = today.renderPilotInvitation({ ...inviteVars, claimed: false, krav_url: "https://opplevagent.no/krav" });
      registerTexts.push({ where: "invite rendered (claimed)", audience: "owner", text: `${invClaimed.subject}\n${invClaimed.text}` });
      registerTexts.push({ where: "invite rendered (not claimed)", audience: "owner", text: `${invNotClaimed.subject}\n${invNotClaimed.text}` });
      for (const bookingOn of [true, false]) {
        registerTexts.push({ where: `today block bookingOn=${bookingOn}`, audience: "owner", text: today.renderTodayBlock({ bookingOn, law: true }) });
      }
      assertTrue(registerTexts.length > 60, "s0: the scan sees the O4-2, O4-3 and O4-4 registers");

      // ── AK1 ────────────────────────────────────────────────────────────
      {
        assertEq(ak1Violations("Forslaget er på høring med frist 5. september."), ["5. september"], "a1: control — «5. september» is caught");
        assertTrue(ak1Violations("Loven om gårdssalg er vedtatt.").length === 1, "a2: control — «er vedtatt» is caught");
        assertTrue(ak1Violations("Stortinget vedtok utvidet gårdssalg i år.").length === 1, "a3: control — «vedtok» is caught");
        assertTrue(ak1Violations("The farm sales law has been adopted.").length === 1, "a4: control — English «adopted» is caught");
        assertEq(ak1Violations(OA3_TODAY["today.law"]), [], "a5: today.law (a proposal, «Det er ikke vedtatt») passes");
        for (const t of registerTexts.filter((x) => x.audience === "owner")) {
          assertEq(ak1Violations(t.text), [], `a6: owner-facing ${t.where} — no «5. september», no adopted law`);
        }
      }

      // ── AK3 ────────────────────────────────────────────────────────────
      {
        assertEq(ak3Violations("Kom innom for gratis smaking!"), ["gratis smaking"], "c1: control — «gratis smaking» is caught");
        assertEq(ak3Violations("Barn velkommen på omvisningen."), ["barn velkommen"], "c2: control — «barn velkommen» is caught");
        assertEq(ak3Violations("Smak på Lysholm Linie hos oss."), ["product name «Lysholm»", "product name «Linie»"], "c3: control — product names are caught");
        assertEq(ak3Violations("Vi tilbyr en smaksprøve etter omvisningen."), [], "c4: control — plain «smaksprøve» passes");
        assertEq(ak3Violations("Massasje og makrell"), [], "c5: control — no hit inside other words (Aass/Mack)");
        for (const t of registerTexts) {
          assertEq(ak3Violations(t.text), [], `c6: ${t.audience}-facing ${t.where} — no «gratis smaking», «barn velkommen» or product name`);
        }
      }

      // ── (b) booking off: no line promises a request ────────────────────
      {
        assertEq(today.todayTextKeys({ bookingOn: false, law: false }),
          ["today.bookingOff", "today.request", "today.reply", "today.price", "today.noSales", "today.content"], "b1: booking off → bookingOff first, no pause line");
        assertEq(today.todayTextKeys({ bookingOn: true, law: false }),
          ["today.request", "today.reply", "today.price", "today.noSales", "today.content", "today.pause"], "b2: booking on → no bookingOff, pause line last");
        assertEq(today.todayTextKeys({ bookingOn: true, law: true }).slice(-1), ["today.law"], "b3: law flag on → today.law last");
        const off = today.renderTodayBlock({ bookingOn: false, law: false });
        assertTrue(off.includes(OA3_TODAY["today.bookingOff"]) && !off.includes("data-today=\"today.pause\""), "b4: rendered off block");
        assertTrue(!off.includes("data-today=\"today.law\""), "b5: law flag off → no today.law");
      }

      // ── (i) the pilot invitation ───────────────────────────────────────
      {
        assertEq(invClaimed.subject, "Vil Testgård være med i piloten på Opplevagent?", "i1: subject filled");
        assertTrue(!invClaimed.text.includes("Først tar du over") && !invClaimed.text.includes("{") && !invClaimed.text.includes("\n\n\n"),
          "i2: taken over → start sentence removed, no placeholder or extra blank line left");
        assertEq(invClaimed.text.split("\n").slice(0, 7).join("\n"),
          "Hei Kari,\n\nJeg heter Daniel og står bak Opplevagent. Takk for at du svarte oss i oktober.\n\n" +
          OA3_INVITE_BODY.split("\n")[4].replace("{produsent}", "Testgård") + "\n\nSlik fungerer det:", "i3: taken over → «Slik fungerer det» follows the intro paragraph");
        assertTrue(invNotClaimed.text.includes("\n\nFørst tar du over profilen din her: https://opplevagent.no/krav. Det tar et par minutter.\n\nSlik fungerer det:"),
          "i4: not taken over → the start sentence with {krav_url}");
        assertTrue(!invNotClaimed.text.includes("{"), "i5: no placeholder left");
        let threw = false;
        try { today.renderPilotInvitation({ ...inviteVars, claimed: false }); } catch { threw = true; }
        assertTrue(threw, "i6: not taken over without krav_url → error, not a broken text");
        assertEq(sends, 0, "i7: rendering the invitation sends nothing");
      }

      // ── (f) «Mine valg» ────────────────────────────────────────────────
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
      expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, brreg_active, hjemmeside, epost, content_source, products,
           producer_type, enrichment_state, verification_status, source, confidence, booking_live, is_test_provider, claimed_at)
        VALUES
          ('o44-a', 'Testgård A', 'o44agard', 'experiences', '918400001', 1, 1, 'https://o44agard.example.no', 'besok@o44agard.example.no', 'claim', '[]',
           'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium', 0, 1, '2026-11-01 10:00:00')
      `).run();
      expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at)
         VALUES ('gsc_o44-a', 'o44-a', 'eier@o44-a.example.no', 'verified_domain_address', 'tok44-o44-a', 1, datetime('now'), datetime('now','+7 days'))`,
      ).run();

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
      const getValg = () => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const r = httpMod.request({ method: "GET", host: "127.0.0.1", port, path: "/kategori/gardssalg/eier/o44agard/valg", headers: { Cookie: "oa_owner_session=tok44-o44-a" } }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => resolve({ status: resp.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
        });
        r.on("error", reject);
        r.end();
      });
      const setEnv = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
      const unescape = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

      // Flag off.
      setEnv(FLAG, undefined);
      setEnv(LAW_FLAG, undefined);
      const before = await getValg();
      assertEq(before.status, 200, "f1: flag off → «Mine valg» 200");
      assertTrue(!before.body.includes("data-today"), "f2: flag off → no «Slik virker det i dag» block");
      for (const k of Object.keys(OA3_TODAY)) {
        assertTrue(!unescape(before.body).includes(OA3_TODAY[k]), `f3: flag off → no «${k}» on the page`);
      }
      for (const [f, v] of [[LAW_FLAG, "true"], [FLAG, "1"], [FLAG, "TRUE"]] as const) {
        setEnv(f, v);
        assertEq((await getValg()).body, before.body, `f4: ${FLAG} not "true" (${f}=${v}) → «Mine valg» byte-identical`);
      }
      setEnv(LAW_FLAG, undefined);

      // Flag on, booking off.
      setEnv(FLAG, "true");
      {
        const p = await getValg();
        const body = unescape(p.body);
        assertEq(p.status, 200, "f5: flag on → 200");
        assertTrue(p.body.includes(`data-today-block="off"`), "f6: booking off → the off block");
        assertTrue(body.includes(OA3_TODAY["today.heading"]) && body.includes(OA3_TODAY["today.bookingOff"]), "f7: heading and today.bookingOff shown");
        assertTrue(!p.body.includes(`data-today="today.pause"`) && !p.body.includes(`data-today="today.law"`), "f8: no pause line, no law line (law flag off)");
        const at = p.body.indexOf("data-today-block");
        assertTrue(at > p.body.indexOf("<h1>Mine valg</h1>") && at < p.body.indexOf(`class="ep-card mv-group"`) && (p.body.indexOf(`id="statistikk"`) < 0 || at < p.body.indexOf(`id="statistikk"`)),
          "f9: the block stands at the top, above statistics and the groups");
        assertEq(p.body.replace(/<div class="ep-card" data-today-block="off">[\s\S]*?<\/div>\n      /, ""), before.body,
          "f10: apart from the block, the page is unchanged");
      }
      // Law flag on.
      setEnv(LAW_FLAG, "true");
      assertTrue(unescape((await getValg()).body).includes(OA3_TODAY["today.law"]), "f11: law flag on → today.law shown");
      setEnv(LAW_FLAG, undefined);
      // Booking on.
      expDb.prepare(`UPDATE experience_providers SET booking_live = 1 WHERE id = 'o44-a'`).run();
      {
        const p = await getValg();
        assertTrue(p.body.includes(`data-today-block="on"`) && p.body.includes(`data-today="today.pause"`) && !p.body.includes(`data-today="today.bookingOff"`),
          "f12: booking on → the on block with the pause line, no bookingOff");
      }
      // Admin brake → off.
      expDb.prepare(`UPDATE experience_providers SET booking_admin_brake_at = '2026-11-16 10:00:00' WHERE id = 'o44-a'`).run();
      assertTrue((await getValg()).body.includes(`data-today-block="off"`), "f13: admin brake → the off block");
      assertEq(sends, 0, "f14: no e-mail sent");
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
  runGardssalgTodayTextsO44Tests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      for (const f of r.failures) console.log(f);
      process.exit(1);
    }
  });
}
