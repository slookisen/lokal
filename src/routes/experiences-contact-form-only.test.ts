/**
 * experiences-contact-form-only.test.ts — dev-request
 * 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, S-D3b
 * («Kontaktskjema som valg per profil») on opplevagent.no: the
 * experience_providers.contact_form_only flag (admin POST
 * /admin/experiences/providers/:id/contact-form-only), the gårdssalg producer
 * page /kategori/gardssalg/produsent/:providerSlug (form instead of the
 * «E-post» row, no JSON-LD `email`), «Vis e-post» (GET …/:providerSlug/epost →
 * 404) and POST …/:providerSlug/kontakt (forwarding through a stubbed sender
 * — no network), all behind CONTACT_FORM_EXPERIENCES.
 *
 * Fixture (own in-memory experiences DB, made-up names, example addresses): a
 * flagged producer, an unflagged one, a flagged one without e-mail, a flagged
 * one whose e-mail is under review (AC4), a flagged hidden one and a flagged
 * visible test producer.
 *
 *   O   switch off: with the flags set, every page (and «Vis e-post» with the
 *       guard on) is byte-identical to the same page unflagged (status, body,
 *       Cache-Control); the POST path is the catch-all 404 byte for byte;
 *       nothing sent / logged
 *   A   admin endpoint: 200 on/off, 400 non-boolean, 404 unknown id, 403
 *       wrong/missing key, 503 unconfigured, the stored e-mail untouched, no
 *       mail
 *   F   switch on, flagged: the form (honeypot, labels), the address nowhere
 *       in the page, no JSON-LD `email`, no «Vis e-post», Cache-Control as on
 *       main; unflagged / no e-mail / under review → byte-identical to switch
 *       off; /en with the language switcher → English form posting to /en/…;
 *       guard on: no budget spent, «Vis e-post» 404 without the address
 *   P   POST: happy path (HTML and JSON) sends ONE mail (to = the stored
 *       address, replyTo = the sender, From Opplevagent); honeypot → success,
 *       no send; invalid input incl. CR/LF → 400; CR/LF in the name never
 *       reaches the subject; no req.ip → 429; 6th message from one IP → 429 +
 *       Retry-After, another IP unaffected; the RFB and dental stores
 *       untouched; unknown / unflagged / no e-mail / under review / hidden /
 *       test producer → 404; send failure → 502; switch off → 404;
 *       Cache-Control: private, no-store
 *   X   HTML in the producer name: escaped in the back link of the
 *       thank-you, 429, 502 and 400 pages (and /en); the mail is text only,
 *       its greeting carries the name as text (review N1)
 *   S   /sv POST (SV_LOCALE_ENABLED + switcher): Swedish thank-you and 400;
 *       /en 400; switcher off → Norwegian; SV locale off → 404 (review N6)
 *   G   no POST/admin body carries a producer address; log lines carry no
 *       address, no IP and no message text
 *
 * Standalone: npx tsx src/routes/experiences-contact-form-only.test.ts
 * Wired into tests/test.ts via runExperiencesContactFormOnlyTests().
 */

import type { EmailOptions } from "../services/email-service";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HttpResult {
  status: number;
  text: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

const BROWSER = "Mozilla/5.0 (test)";

function jsonLdBlocks(html: string): any[] {
  return Array.from(html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)).map((m) => {
    try { return JSON.parse(m[1]!); } catch { return null; }
  });
}

function jsonLdHasEmail(html: string): boolean {
  return JSON.stringify(jsonLdBlocks(html)).includes('"email"');
}

const FIXTURE = {
  F: { id: "ecf-p1", slug: "skjemaprove-sideri-en", navn: "Skjemaprøve Sideri En", epost: "post1@skjemaprove-sideri.example" },
  U: { id: "ecf-p2", slug: "skjemaprove-sideri-to", navn: "Skjemaprøve Sideri To", epost: "post2@skjemaprove-sideri.example" },
  N: { id: "ecf-p3", slug: "utenpost-skjemaprove-sideri", navn: "Utenpost Skjemaprøve Sideri", epost: null as string | null },
  R: { id: "ecf-p4", slug: "skjemaprove-bryggeri-review", navn: "Skjemaprøve Bryggeri Review", epost: "avvik@annet-domene.example" },
  H: { id: "ecf-p5", slug: "skjult-skjemaprove-sideri", navn: "Skjult Skjemaprøve Sideri", epost: "skjult@skjemaprove-sideri.example" },
  T: { id: "ecf-p6", slug: "test-skjemaprove-sideri", navn: "Test Skjemaprøve Sideri", epost: "test@skjemaprove-sideri.example" },
  // Review N1 (lokal#1525): HTML and the five escaped characters in the producer name.
  X: { id: "ecf-p7", slug: "html-skjemaprove-sideri", navn: `Ond <script>alert("x")</script> & 'Co' <b>Sideri</b>`, epost: "html@skjemaprove-sideri.example" },
};

function seed(db: any): void {
  const insert = db.prepare(
    `INSERT INTO experience_providers
       (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, is_test_provider,
        lat, lon, geocode_confidence, slug, epost, telefon, hjemmeside, field_provenance,
        enrichment_state, verification_status, source, confidence)
     VALUES
       (@id, @navn, 'experiences', 'Vestland', 'Voss', 'Voss', 'sideri', 1, @hidden, @test,
        60.63, 6.42, 'high', @slug, @epost, '55512345', @site, @prov,
        'raw', 'verified', 'test-fixture', 'medium')`,
  );
  const row = (p: { id: string; slug: string; navn: string; epost: string | null }, extra: { hidden?: number | null; test?: number; prov?: string | null } = {}) =>
    insert.run({
      id: p.id, slug: p.slug, navn: p.navn, epost: p.epost, site: `https://${p.slug}.example.no`,
      hidden: extra.hidden ?? null, test: extra.test ?? 0, prov: extra.prov ?? null,
    });
  row(FIXTURE.F);
  row(FIXTURE.U);
  row(FIXTURE.N);
  row(FIXTURE.R, { prov: JSON.stringify({ contact_email_flagged_review: { flagged_email: FIXTURE.R.epost, flagged_at: "2026-10-01T00:00:00.000Z" } }) });
  row(FIXTURE.H, { hidden: 1 });
  row(FIXTURE.T, { test: 1 });
  row(FIXTURE.X);
}

export async function runExperiencesContactFormOnlyTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const ok = (cond: boolean, label: string) => {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  };
  const eq = (actual: unknown, expected: unknown, label: string) =>
    ok(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);

  const envKeys = [
    "EXPERIENCES_DB_PATH", "CONTACT_FORM_EXPERIENCES", "CONTACT_FORM_DENTAL", "CONTACT_FORM_RFB",
    "EMAIL_REVEAL_GUARD_EXPERIENCES", "EMAIL_REVEAL_PER_IP_PER_HOUR", "OPPLEVAGENT_LANG_SWITCHER_ENABLED",
    "ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "SV_LOCALE_ENABLED",
  ];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  for (const k of envKeys) delete process.env[k];
  process.env.EXPERIENCES_DB_PATH = ":memory:";
  const ADMIN_KEY = "experiences-contact-form-only-test-key";

  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
    require.resolve("../database/db-factory"),
    require.resolve("../services/experience-store"),
    require.resolve("../services/experiences-contact-form-only"),
    require.resolve("./experiences-seo"),
    require.resolve("./admin-experiences-contact-form-only"),
  ]);
  const guard = require("../services/email-reveal-guard") as typeof import("../services/email-reveal-guard");
  const cf = require("../services/contact-form-only") as typeof import("../services/contact-form-only");
  const guardLog: string[] = [];
  const cfLog: string[] = [];
  const sent: EmailOptions[] = [];
  let sendResult: { success: boolean; error?: string } = { success: true };
  const freshContactForm = () => {
    sent.length = 0;
    sendResult = { success: true };
    cf.__resetContactFormForTesting({
      log: (l) => cfLog.push(l),
      sender: async (o) => { sent.push(o); return sendResult; },
    });
  };
  const freshGuard = () => guard.__resetEmailRevealGuardForTesting({ log: (l) => guardLog.push(l) });
  let closeHttp: (() => Promise<void>) | null = null;
  const prevConsoleLog = console.log;
  const consoleLines: string[] = [];
  if (!log) console.log = (...args: unknown[]) => { consoleLines.push(args.map(String).join(" ")); };

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("experiences");
    seed(db);
    const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default;
    const adminRouter = (require("./admin-experiences-contact-form-only") as typeof import("./admin-experiences-contact-form-only")).default as any;
    const { langMiddleware } = require("../i18n/middleware") as typeof import("../i18n/middleware");
    freshGuard();
    freshContactForm();

    const { F, U, N, R, H, T, X } = FIXTURE;
    const providerEmails = [F.epost, U.epost, R.epost, H.epost, T.epost, X.epost];
    const setFlag = (id: string, on: boolean) => db.prepare("UPDATE experience_providers SET contact_form_only = ? WHERE id = ?").run(on ? 1 : 0, id);
    const flagRow = (id: string) => (db.prepare("SELECT contact_form_only, epost FROM experience_providers WHERE id = ?").get(id) as any);
    const leaks = (text: string, email: string) => [email, encodeURIComponent(email), JSON.stringify(email).slice(1, -1)].some((f) => text.includes(f)) || text.includes(email.split("@")[0]! + "@");
    const allBodies: Array<{ label: string; text: string }> = [];

    // ── HTTP app: admin + the experiences pages (trust proxy as in index.ts) ──
    const express = require("express") as typeof import("express");
    const http = require("http") as typeof import("http");
    const app = express();
    app.set("trust proxy", true);
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      if (req.headers["x-test-no-ip"]) Object.defineProperty(req, "ip", { value: "", configurable: true });
      next();
    });
    app.use(langMiddleware);
    app.use("/admin/experiences/providers", adminRouter);
    app.use("/", seoRouter as any);
    const httpServer = http.createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    closeHttp = () => new Promise<void>((resolve) => { httpServer.closeAllConnections?.(); httpServer.close(() => resolve()); });
    const port = (httpServer.address() as import("net").AddressInfo).port;
    const request = (method: string, path: string, ip: string, body?: string, headers: Record<string, string> = {}): Promise<HttpResult> =>
      new Promise((resolve, reject) => {
        const h: Record<string, string | number> = { "x-forwarded-for": ip, "user-agent": BROWSER, ...headers };
        if (body !== undefined) h["content-length"] = Buffer.byteLength(body);
        const r = http.request({ host: "127.0.0.1", port, path, method, headers: h }, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { text += chunk; });
          res.on("end", () => {
            allBodies.push({ label: `${method} ${path}`, text });
            let parsed: any = null;
            try { parsed = JSON.parse(text); } catch { /* not JSON */ }
            resolve({ status: res.statusCode ?? 0, text, headers: res.headers, body: parsed });
          });
        });
        r.on("error", reject);
        if (body !== undefined) r.write(body);
        r.end();
      });
    const get = (path: string, ip: string, headers?: Record<string, string>) => request("GET", path, ip, undefined, headers);
    const pagePath = (slug: string) => `/kategori/gardssalg/produsent/${slug}`;
    const page = (slug: string, ip = "198.51.100.1") => get(pagePath(slug), ip);
    const reveal = (slug: string, ip: string) => get(`${pagePath(slug)}/epost`, ip);
    const kontakt = (slug: string) => `${pagePath(slug)}/kontakt`;

    /** Every page the switch touches, for one IP. */
    const surfaces = async (ip: string) => {
      const out: Record<string, { status: number; text: string; cacheControl?: string }> = {};
      for (const [label, p] of [["F", F], ["U", U], ["N", N], ["R", R], ["T", T]] as const) {
        const r = await page(p.slug, ip);
        out[`page ${label}`] = { status: r.status, text: r.text, cacheControl: r.headers["cache-control"] as string | undefined };
      }
      return out;
    };
    const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
    const goodFields = { name: "Kari Gjest", reply_email: "kari@gjest.example", message: "Hei! Har dere gårdssalg på lørdag?", _honey: "" };
    const postForm = (slug: string, ip: string, fields: Record<string, string> = goodFields, headers: Record<string, string> = {}) =>
      request("POST", kontakt(slug), ip, form(fields), { "content-type": "application/x-www-form-urlencoded", accept: "text/html", ...headers });
    const postJson = (slug: string, ip: string, fields: Record<string, unknown>) =>
      request("POST", kontakt(slug), ip, JSON.stringify(fields), { "content-type": "application/json", accept: "application/json" });
    const admin = (id: string, body: unknown, key: string | null = ADMIN_KEY) =>
      request("POST", `/admin/experiences/providers/${encodeURIComponent(id)}/contact-form-only`, "198.51.100.200", JSON.stringify(body), {
        "content-type": "application/json",
        ...(key === null ? {} : { "x-admin-key": key }),
      });
    const hasForm = (html: string, slug: string, prefix = "") =>
      html.includes(`action="${prefix}/kategori/gardssalg/produsent/${slug}/kontakt"`) && html.includes('name="_honey"') && html.includes('name="reply_email"')
      && html.includes('name="message"') && html.includes('id="kontaktskjema"');
    const providerMailtos = (html: string) => Array.from(html.matchAll(/mailto:([^"'\s<>?]*@[^"'\s<>?]*)/gi)).map((m) => m[1]!).filter((m) => !/@opplevagent\.no$/i.test(m));

    // ── O: switch off ─────────────────────────────────────────────────────
    const offBase = await surfaces("203.0.113.10");
    process.env.EMAIL_REVEAL_GUARD_EXPERIENCES = "on";
    process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = "100";
    freshGuard();
    const offRevealBase = await reveal(F.slug, "203.0.113.11");
    const offGuardPageBase = await page(F.slug, "203.0.113.11");
    delete process.env.EMAIL_REVEAL_GUARD_EXPERIENCES;
    delete process.env.EMAIL_REVEAL_PER_IP_PER_HOUR;
    freshGuard();
    {
      ok(offBase["page F"]!.text.includes(`href="mailto:${F.epost}"`) && jsonLdHasEmail(offBase["page F"]!.text), "O0: baseline -> producer F shows its mailto: and JSON-LD email");
      eq(offBase["page F"]!.cacheControl, "public, max-age=300", "O0b: baseline Cache-Control as on main");
      for (const p of [F, N, R, H, T]) setFlag(p.id, true);
      const off = await surfaces("203.0.113.10");
      for (const key of Object.keys(offBase)) {
        ok(JSON.stringify(off[key]) === JSON.stringify(offBase[key]), `O1: switch off -> ${key} byte-identical with the flags set (status, body, Cache-Control)`);
      }
      process.env.CONTACT_FORM_EXPERIENCES = "off";
      ok(JSON.stringify(await surfaces("203.0.113.10")) === JSON.stringify(offBase), "O2: switch \"off\" -> every page as unset");
      process.env.CONTACT_FORM_EXPERIENCES = "yes";
      ok(JSON.stringify(await surfaces("203.0.113.10")) === JSON.stringify(offBase), "O3: switch \"yes\" -> off");
      // Other hosts' switches do not turn this one on.
      process.env.CONTACT_FORM_EXPERIENCES = "";
      process.env.CONTACT_FORM_DENTAL = "on";
      process.env.CONTACT_FORM_RFB = "on";
      ok(JSON.stringify(await surfaces("203.0.113.10")) === JSON.stringify(offBase), "O4: CONTACT_FORM_DENTAL / CONTACT_FORM_RFB on -> experiences pages unchanged");
      delete process.env.CONTACT_FORM_DENTAL;
      delete process.env.CONTACT_FORM_RFB;
      delete process.env.CONTACT_FORM_EXPERIENCES;
      process.env.EMAIL_REVEAL_GUARD_EXPERIENCES = "on";
      process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = "100";
      freshGuard();
      const r = await reveal(F.slug, "203.0.113.11");
      ok(r.status === 200 && r.text === offRevealBase.text && r.headers["cache-control"] === offRevealBase.headers["cache-control"], "O5: switch off, guard on -> «Vis e-post» of a flagged producer unchanged (200 with the address)");
      const gp = await page(F.slug, "203.0.113.11");
      ok(gp.status === offGuardPageBase.status && gp.text === offGuardPageBase.text && gp.headers["cache-control"] === offGuardPageBase.headers["cache-control"], "O6: switch off, guard on -> flagged page byte-identical to unflagged");
      delete process.env.EMAIL_REVEAL_GUARD_EXPERIENCES;
      delete process.env.EMAIL_REVEAL_PER_IP_PER_HOUR;
      freshGuard();
      const fallThrough = await request("POST", `${pagePath(F.slug)}/finnes-ikke`, "203.0.113.12", form(goodFields), { "content-type": "application/x-www-form-urlencoded" });
      const offPost = await postForm(F.slug, "203.0.113.12");
      ok(offPost.status === 404 && offPost.text === fallThrough.text, "O7: switch off -> POST …/kontakt is the catch-all 404, byte for byte");
      eq([offPost.headers["cache-control"], offPost.headers["x-robots-tag"], offPost.headers["content-type"]], [fallThrough.headers["cache-control"], fallThrough.headers["x-robots-tag"], fallThrough.headers["content-type"]], "O8: switch off -> the POST path has the catch-all's headers");
      eq(sent.length, 0, "O9: switch off -> nothing sent");
      eq(cfLog.length, 0, "O10: switch off -> no contact-form log line");
    }

    // ── A: admin endpoint ─────────────────────────────────────────────────
    process.env.ADMIN_KEY = ADMIN_KEY;
    {
      setFlag(F.id, false);
      const on = await admin(F.id, { enabled: true });
      ok(on.status === 200 && JSON.stringify(on.body) === JSON.stringify({ id: F.id, contact_form_only: true }), `A1: enable -> 200 { id, contact_form_only: true } (got ${on.status} ${on.text})`);
      eq(flagRow(F.id).contact_form_only, 1, "A2: the flag is stored");
      const offR = await admin(U.id, { enabled: false });
      ok(offR.status === 200 && JSON.stringify(offR.body) === JSON.stringify({ id: U.id, contact_form_only: false }), "A3: disable -> 200 contact_form_only false");
      for (const body of [{ enabled: "true" }, { enabled: 1 }, {}, { enabled: null }]) {
        eq((await admin(F.id, body)).status, 400, `A4: ${JSON.stringify(body)} -> 400`);
      }
      eq(flagRow(F.id).contact_form_only, 1, "A5: a 400 changes nothing");
      eq((await admin("finnes-ikke-id", { enabled: true })).status, 404, "A6: unknown id -> 404");
      eq((await admin(F.id, { enabled: false }, "wrong-key")).status, 403, "A7: wrong admin key -> 403");
      eq((await admin(F.id, { enabled: false }, null)).status, 403, "A8: no admin key -> 403");
      eq(flagRow(F.id).contact_form_only, 1, "A9: a refused call changes nothing");
      eq(flagRow(F.id).epost, F.epost, "A10: the stored e-mail address is untouched");
      eq(sent.length, 0, "A11: the admin endpoint sends no mail");
      // (console.log is only captured when the suite runs quietly.)
      ok((log || consoleLines.filter((l) => l.includes("contact_form_only_set")).length >= 2)
        && consoleLines.filter((l) => l.includes("contact_form_only_set")).every((l) => !providerEmails.some((e) => e && l.includes(e))), "A12: the admin log line is written and carries no address");
      delete process.env.ADMIN_KEY;
      eq((await admin(F.id, { enabled: false })).status, 503, "A13: no admin key configured -> 503");
      eq(flagRow(F.id).contact_form_only, 1, "A14: ... nothing changed");
    }

    // ── F: switch on ──────────────────────────────────────────────────────
    process.env.CONTACT_FORM_EXPERIENCES = "on";
    {
      const on = await surfaces("203.0.113.20");
      const t = on["page F"]!.text;
      ok(on["page F"]!.status === 200 && hasForm(t, F.slug), "F1: flagged page -> the contact form (honeypot, name, reply e-mail, message)");
      ok(t.includes(">Send melding</th>") && t.includes(">Send melding</button>"), "F2: Norwegian labels");
      ok(!leaks(t, F.epost) && providerMailtos(t).length === 0, "F3: the address nowhere in the HTML, no producer mailto:");
      ok(!jsonLdHasEmail(t) && jsonLdBlocks(t).some((b) => b && b.telephone), "F4: JSON-LD without email (telephone still there)");
      ok(!t.includes("Vis e-post") && !t.includes(`${pagePath(F.slug)}/epost`), "F5: no «Vis e-post»");
      eq(on["page F"]!.cacheControl, "public, max-age=300", "F6: Cache-Control as on main (the flag does not vary by client)");
      // Apart from the form row and the e-mail row/JSON-LD, the page is the switch-off page.
      // (Booking off: the aside contact card repeats the same row as a <li> —
      // dev-request 2026-11-06-opplevagent-meld-interesse-fjernes-mens-booking-av.)
      const stripForm = (html: string) => html.replace(/<tr><th scope="row">Send melding<\/th><td><form[\s\S]*?<\/form><\/td><\/tr>/, "")
        .replace(/<li><span class="reserve-contact-k">Send melding<\/span> <a href="#kontaktskjema">Send melding<\/a><\/li>/, "");
      const stripEmail = (html: string) => html
        .replace(/<tr><th scope="row">E-post<\/th><td><a href="mailto:[^"]*"[^>]*>[^<]*<\/a><\/td><\/tr>/, "")
        .replace(/<li><span class="reserve-contact-k">E-post<\/span> <a href="mailto:[^"]*"[^>]*>[^<]*<\/a><\/li>/, "")
        .replace(/,"email":"[^"]*"/, "");
      ok(stripForm(t) === stripEmail(offBase["page F"]!.text), "F7: otherwise byte-identical to the switch-off page (form row in, e-mail row + JSON-LD email out)");
      for (const key of ["page U", "page N", "page R"]) {
        ok(JSON.stringify(on[key]) === JSON.stringify(offBase[key]), `F8: ${key} -> byte-identical to switch off (unflagged / flagged without e-mail / under review: no form)`);
      }
      {
        const tt = on["page T"]!.text;
        ok(!hasForm(tt, T.slug) && !tt.includes("kontaktskjema") && !leaks(tt, T.epost!) && !jsonLdHasEmail(tt), "F9: a flagged test producer -> no form (its POST is a 404) and no address");
      }
      ok(!on["page R"]!.text.includes("kontaktskjema") && !leaks(on["page R"]!.text, R.epost!), "F10: under review -> no form, the address still nowhere (AC4 unchanged)");
      eq((await page(H.slug)).status, 404, "F11: a hidden producer still has no public page");

      for (const v of ["1", "true", "TRUE", " On "]) {
        process.env.CONTACT_FORM_EXPERIENCES = v;
        ok(hasForm((await page(F.slug)).text, F.slug), `F12: switch ${JSON.stringify(v)} -> on`);
      }
      process.env.CONTACT_FORM_EXPERIENCES = "on";

      // Language switcher on: /en page → English form posting to /en/…/kontakt.
      process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED = "true";
      const en = await get(`/en${pagePath(F.slug)}`, "203.0.113.22");
      ok(en.status === 200 && hasForm(en.text, F.slug, "/en") && en.text.includes(">Send message</button>") && !leaks(en.text, F.epost), `F13: /en page -> English form to /en/…/kontakt, no address (got ${en.status})`);
      delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;

      // With the e-mail guard on too: no reveal, no budget spent for the flagged producer.
      process.env.EMAIL_REVEAL_GUARD_EXPERIENCES = "on";
      process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = "1";
      freshGuard();
      const g = await page(F.slug, "203.0.113.30");
      ok(hasForm(g.text, F.slug) && !leaks(g.text, F.epost) && !g.text.includes("Vis e-post") && !jsonLdHasEmail(g.text), "F14: guard on + flagged -> form, no «Vis e-post», no address");
      eq(g.headers["cache-control"], "private", "F15: guard on -> Cache-Control: private (as every guarded page)");
      const gu = await page(U.slug, "203.0.113.30");
      ok(gu.text.includes(`href="mailto:${U.epost}"`), "F16: the flagged producer spent none of the IP's budget (limit 1: the unflagged one still shows its e-mail)");
      const rv = await reveal(F.slug, "203.0.113.31");
      ok(rv.status === 404 && !leaks(rv.text, F.epost) && providerMailtos(rv.text).length === 0, `F17: guard on + flagged -> «Vis e-post» 404 without the address (got ${rv.status})`);
      eq([rv.headers["cache-control"], rv.headers["x-robots-tag"]], ["private", "noindex, nofollow"], "F18: ... private + noindex like the guard's own 404");
      const rvU = await reveal(U.slug, "203.0.113.31");
      ok(rvU.status === 200 && rvU.text.includes(`mailto:${U.epost}`), "F19: guard on, unflagged -> «Vis e-post» unchanged (200 with the address)");
      delete process.env.EMAIL_REVEAL_GUARD_EXPERIENCES;
      delete process.env.EMAIL_REVEAL_PER_IP_PER_HOUR;
      freshGuard();
    }

    // ── P: POST …/kontakt ─────────────────────────────────────────────────
    freshContactForm();
    {
      const r = await postForm(F.slug, "198.51.100.10");
      ok(r.status === 200 && r.text.includes("Takk for meldingen"), `P1: happy path -> 200 Norwegian thank-you page (got ${r.status})`);
      eq([r.headers["cache-control"], r.headers["x-robots-tag"]], ["private, no-store", "noindex, nofollow"], "P2: Cache-Control private, no-store + noindex");
      ok(String(r.headers["content-type"] ?? "").startsWith("text/html"), "P2b: HTML answer");
      eq(sent.length, 1, "P3: exactly one mail sent");
      const m = sent[0];
      ok(!!m && m.to === F.epost && m.replyTo === goodFields.reply_email, "P4: to = the stored address, replyTo = the sender's address");
      ok(!!m && m.subject === `Melding via Opplevagent: ${goodFields.name}`, `P5: subject «Melding via Opplevagent: …» (got ${m?.subject})`);
      ok(!!m && m.textContent.includes(goodFields.message) && m.textContent.includes("videresendt av Opplevagent") && m.textContent.includes(`/kategori/gardssalg/produsent/${F.slug}`) && !m.htmlContent, "P6: plain text body with the message, the profile link and the forwarded-by footer");
      const { crmFromHeader } = require("../services/crm-platform-identity") as typeof import("../services/crm-platform-identity");
      ok(!!m && m.from === crmFromHeader("experiences"), `P7: From is the Opplevagent identity of the booking notices (got ${m?.from})`);
      ok(!!m && m.redactRecipientInLogs === true && m.omitAgentHeader === true && m.logSubjectAs === "[Kontaktskjema · gårdssalg]", "P8: the send log is redacted");
      ok(!leaks(r.text, F.epost), "P9: the producer's address is not in the answer");

      const j = await postJson(F.slug, "198.51.100.11", goodFields);
      ok(j.status === 200 && JSON.stringify(j.body) === JSON.stringify({ ok: true }) && String(j.headers["content-type"] ?? "").includes("application/json"), `P10: JSON client -> 200 {"ok":true} as JSON (got ${j.status} ${j.text})`);
      eq(j.headers["cache-control"], "private, no-store", "P10b: JSON answer is private too");
      eq(sent.length, 2, "P11: ... and one more mail");

      const hp = await postForm(F.slug, "198.51.100.12", { ...goodFields, _honey: "http://spam.example" });
      ok(hp.status === 200 && hp.text.includes("Takk for meldingen"), "P12: honeypot filled -> answered like a success");
      eq(sent.length, 2, "P13: honeypot -> nothing sent");

      for (const [label, fields] of [
        ["bad reply e-mail", { ...goodFields, reply_email: "ikke-en-adresse" }],
        ["reply e-mail with CR/LF", { ...goodFields, reply_email: "kari@gjest.example\r\nBcc: x@y.example" }],
        ["missing message", { ...goodFields, message: "  " }],
        ["message too long", { ...goodFields, message: "x".repeat(2001) }],
        ["missing name", { ...goodFields, name: "" }],
        ["name too long", { ...goodFields, name: "n".repeat(101) }],
      ] as Array<[string, Record<string, string>]>) {
        const bad = await postForm(F.slug, "198.51.100.13", fields);
        ok(bad.status === 400 && bad.text.includes("Meldingen ble ikke sendt") && !leaks(bad.text, F.epost), `P14: ${label} -> 400, no address`);
      }
      const badJson = await postJson(F.slug, "198.51.100.13", { ...goodFields, reply_email: "nei" });
      ok(badJson.status === 400 && badJson.body?.fields?.includes("reply_email"), "P15: JSON invalid -> 400 with the field");
      eq(sent.length, 2, "P16: invalid input -> nothing sent");

      freshContactForm();
      const crlf = await postForm(F.slug, "198.51.100.14", { ...goodFields, name: "Kari\r\nBcc: x@y.example\u0000\u2028Gjest" });
      ok(crlf.status === 200 && sent.length === 1, "P17: a name with CR/LF/control chars is accepted (sanitized)");
      ok(!!sent[0] && !/[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(sent[0].subject) && sent[0].subject.startsWith("Melding via Opplevagent: Kari "), `P18: the subject has no line break or control char (got ${JSON.stringify(sent[0]?.subject)})`);

      freshContactForm();
      const noIp = await postForm(F.slug, "198.51.100.15", goodFields, { "x-test-no-ip": "1" });
      ok(noIp.status === 429 && Number(noIp.headers["retry-after"]) > 0, `P19: no req.ip -> 429 with Retry-After (got ${noIp.status})`);
      eq(sent.length, 0, "P20: no req.ip -> nothing sent");

      // Per-IP limit: 5 per hour.
      freshContactForm();
      const ip = "198.51.100.20";
      let firstFive = true;
      for (let n = 0; n < 5; n++) firstFive = (await postForm(F.slug, ip)).status === 200 && firstFive;
      ok(firstFive, "P21: 5 messages from one IP -> all 200");
      const sixth = await postForm(F.slug, ip);
      ok(sixth.status === 429 && sixth.text.includes("For mange meldinger"), "P22: the 6th -> 429");
      const ra = Number(sixth.headers["retry-after"]);
      ok(Number.isFinite(ra) && ra > 0 && ra <= 3600, `P23: 429 has Retry-After in seconds (got ${sixth.headers["retry-after"]})`);
      eq(sixth.headers["cache-control"], "private, no-store", "P23b: the 429 is private too");
      eq(sent.length, 5, "P24: the 6th was not sent");
      eq((await postForm(F.slug, "198.51.100.21")).status, 200, "P25: another IP has its own budget");
      eq((await postForm(F.slug, ip, { ...goodFields, _honey: "x" })).status, 200, "P26: honeypot is answered like a success even over the limit");
      ok(cf.contactFormRateCheck({ ip } as any, "rfb").ok === true, "P27: the experiences limit does not spend the RFB store");
      ok(cf.contactFormRateCheck({ ip } as any, "dental").ok === true, "P28: ... nor the dental store");
      ok(cf.contactFormRateCheck({ ip } as any).ok === true, "P29: ... and the default host is still RFB");
      eq(cf.CONTACT_FORM_SWITCH_ENV, { rfb: "CONTACT_FORM_RFB", dental: "CONTACT_FORM_DENTAL", experiences: "CONTACT_FORM_EXPERIENCES" }, "P30: one switch per host, RFB and dental unchanged");
      // Filling the RFB and dental stores does not touch the experiences one.
      freshContactForm();
      for (let n = 0; n < 5; n++) {
        const a = cf.contactFormRateCheck({ ip: "198.51.100.22" } as any, "rfb");
        if (a.ok) cf.contactFormRecordSend(a.key, "rfb");
        const d = cf.contactFormRateCheck({ ip: "198.51.100.22" } as any, "dental");
        if (d.ok) cf.contactFormRecordSend(d.key, "dental");
      }
      ok(cf.contactFormRateCheck({ ip: "198.51.100.22" } as any, "rfb").ok === false && cf.contactFormRateCheck({ ip: "198.51.100.22" } as any, "dental").ok === false, "P31: RFB and dental stores reach their own limit as before");
      eq((await postForm(F.slug, "198.51.100.22")).status, 200, "P32: ... and the experiences POST from that IP still goes through");

      // 404s
      freshContactForm();
      for (const [label, slug] of [
        ["unknown slug", "finnes-ikke-sideri"],
        ["unflagged producer", U.slug],
        ["flagged without e-mail", N.slug],
        ["flagged, e-mail under review", R.slug],
        ["flagged hidden producer", H.slug],
        ["flagged test producer", T.slug],
      ] as Array<[string, string]>) {
        const nf = await postForm(slug, "198.51.100.30");
        ok(nf.status === 404 && nf.headers["x-robots-tag"] === "noindex, nofollow" && nf.headers["cache-control"] === "private, no-store" && !providerEmails.some((e) => e && leaks(nf.text, e)), `P33: ${label} -> 404 noindex private, no address (got ${nf.status})`);
      }
      eq((await postJson(U.slug, "198.51.100.30", goodFields)).status, 404, "P34: unflagged (JSON) -> 404");
      setFlag(F.id, false);
      eq((await postForm(F.slug, "198.51.100.31")).status, 404, "P35: flag removed -> 404");
      setFlag(F.id, true);
      eq(sent.length, 0, "P36: no 404 sent anything");

      // Send failure.
      freshContactForm();
      sendResult = { success: false, error: "boom" };
      const fail = await postForm(F.slug, "198.51.100.40");
      ok(fail.status === 502 && !leaks(fail.text, F.epost), "P37: send failure -> 502, no address");

      // /en form post (langMiddleware strips the prefix).
      freshContactForm();
      process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED = "true";
      const enPost = await request("POST", `/en${kontakt(F.slug)}`, "198.51.100.41", form(goodFields), { "content-type": "application/x-www-form-urlencoded", accept: "text/html" });
      ok(enPost.status === 200 && enPost.text.includes("Thank you for your message") && sent.length === 1, `P38: /en POST -> English thank-you, one mail (got ${enPost.status})`);
      delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;

      // Switch off again: the POST is back to the fall-through 404.
      delete process.env.CONTACT_FORM_EXPERIENCES;
      freshContactForm();
      eq((await postForm(F.slug, "198.51.100.42")).status, 404, "P39: switch turned off -> POST 404");
      eq(sent.length, 0, "P40: ... nothing sent");
    }

    // ── X: HTML in the producer name (review N1, lokal#1525) ──────────────
    process.env.CONTACT_FORM_EXPERIENCES = "on";
    setFlag(X.id, true);
    {
      const escName = "Ond &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Co&#39; &lt;b&gt;Sideri&lt;/b&gt;";
      const backLink = (prefix = "", hash = "", back = "Tilbake til") => `<a href="${prefix}${pagePath(X.slug)}${hash}">&larr; ${back} ${escName}</a>`;
      const rawFree = (html: string) => !html.includes(X.navn) && !html.includes("<script>alert") && !html.includes("<b>Sideri</b>") && !html.includes(`'Co'`);

      freshContactForm();
      const r = await postForm(X.slug, "198.51.100.50");
      ok(r.status === 200 && r.text.includes("Takk for meldingen"), `X1: HTML name -> thank-you page 200 (got ${r.status})`);
      ok(r.text.includes(backLink()), "X2: thank-you page -> the back link carries the escaped name");
      ok(rawFree(r.text), "X3: thank-you page -> the raw name / tags nowhere");
      eq(sent.length, 1, "X4: one mail sent");
      const m = sent[0];
      const greeting = m?.textContent.split("\n")[0];
      eq(greeting, `Hei ${X.navn}!`, "X5: the plain-text greeting carries the name as text (one line, not HTML-escaped: text/plain)");
      ok(!!m && m.htmlContent === undefined && !m.textContent.includes("&lt;"), "X6: the mail is text only (no HTML part where the name could render)");

      freshContactForm();
      const noIp = await postForm(X.slug, "198.51.100.51", goodFields, { "x-test-no-ip": "1" });
      ok(noIp.status === 429 && noIp.text.includes(backLink()) && rawFree(noIp.text), `X7: 429 page -> escaped back link, raw name nowhere (got ${noIp.status})`);

      freshContactForm();
      sendResult = { success: false, error: "boom" };
      const fail = await postForm(X.slug, "198.51.100.52");
      ok(fail.status === 502 && fail.text.includes(backLink()) && rawFree(fail.text), `X8: 502 page -> escaped back link, raw name nowhere (got ${fail.status})`);

      freshContactForm();
      const bad = await postForm(X.slug, "198.51.100.53", { ...goodFields, reply_email: "nei" });
      ok(bad.status === 400 && bad.text.includes(backLink("", "#kontaktskjema")) && rawFree(bad.text), `X9: 400 page -> escaped back link to the form, raw name nowhere (got ${bad.status})`);
      eq(sent.length, 0, "X10: the 400 sent nothing");

      process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED = "true";
      const enOk = await request("POST", `/en${kontakt(X.slug)}`, "198.51.100.54", form(goodFields), { "content-type": "application/x-www-form-urlencoded", accept: "text/html" });
      ok(enOk.status === 200 && enOk.text.includes(backLink("/en", "", "Back to")) && rawFree(enOk.text), `X11: /en thank-you page -> escaped back link to /en/… (got ${enOk.status})`);
      delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;
      ok(!leaks(r.text + noIp.text + fail.text + bad.text + enOk.text, X.epost), "X12: the producer's address is in none of these answers");
    }
    setFlag(X.id, false);

    // ── S: /sv and /en POST variants (review N6, lokal#1525) ──────────────
    // langMiddleware recognises /sv only with SV_LOCALE_ENABLED=true; the
    // answer is Swedish only with the opplevagent language switcher on too.
    {
      const postSv = (ip: string, fields: Record<string, string> = goodFields) =>
        request("POST", `/sv${kontakt(F.slug)}`, ip, form(fields), { "content-type": "application/x-www-form-urlencoded", accept: "text/html" });
      process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED = "true";
      process.env.SV_LOCALE_ENABLED = "true";
      freshContactForm();
      const sv = await postSv("198.51.100.60");
      ok(sv.status === 200 && sv.text.includes("Tack för meddelandet") && sv.text.includes(`<html lang="sv"`), `S1: /sv POST -> Swedish thank-you page (got ${sv.status})`);
      ok(sv.text.includes(`<a href="/sv${pagePath(F.slug)}">&larr; Tillbaka till ${F.navn}</a>`), "S2: ... back link to the /sv profile");
      eq(sent.length, 1, "S3: /sv POST -> one mail");
      ok(!!sent[0] && sent[0].to === F.epost && sent[0].replyTo === goodFields.reply_email && sent[0].textContent.includes(`/kategori/gardssalg/produsent/${F.slug}`), "S4: ... to the stored address, Reply-To the sender, profile link in the mail");
      ok(!leaks(sv.text, F.epost), "S5: ... the address not in the answer");
      eq([sv.headers["cache-control"], sv.headers["x-robots-tag"]], ["private, no-store", "noindex, nofollow"], "S6: ... private, no-store + noindex");

      freshContactForm();
      const svBad = await postSv("198.51.100.61", { ...goodFields, reply_email: "inte-en-adress" });
      ok(svBad.status === 400 && svBad.text.includes("Meddelandet skickades inte") && svBad.text.includes("Skriv en giltig e-postadress"), `S7: /sv invalid reply e-mail -> 400 Swedish error (got ${svBad.status})`);
      ok(svBad.text.includes(`<a href="/sv${pagePath(F.slug)}#kontaktskjema">&larr; Tillbaka till ${F.navn}</a>`) && !leaks(svBad.text, F.epost), "S8: ... back link to the /sv form, no address");
      eq(sent.length, 0, "S9: /sv invalid -> nothing sent");

      const enBad = await request("POST", `/en${kontakt(F.slug)}`, "198.51.100.62", form({ ...goodFields, message: "" }), { "content-type": "application/x-www-form-urlencoded", accept: "text/html" });
      ok(enBad.status === 400 && enBad.text.includes("The message was not sent") && enBad.text.includes("Write a message") && enBad.text.includes(`<a href="/en${pagePath(F.slug)}#kontaktskjema">`), `S10: /en invalid message -> 400 English error, back to the /en form (got ${enBad.status})`);
      eq(sent.length, 0, "S11: /en invalid -> nothing sent");

      // Switcher off, /sv locale on: the prefix is stripped, the answer is Norwegian.
      delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;
      freshContactForm();
      const svNo = await postSv("198.51.100.63");
      ok(svNo.status === 200 && svNo.text.includes("Takk for meldingen") && svNo.text.includes(`<a href="${pagePath(F.slug)}">`) && sent.length === 1, `S12: /sv POST with the switcher off -> Norwegian thank-you, unprefixed back link, one mail (got ${svNo.status})`);

      // /sv locale off: /sv/… is not a language prefix → no route, nothing sent.
      delete process.env.SV_LOCALE_ENABLED;
      process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED = "true";
      freshContactForm();
      const svOff = await postSv("198.51.100.64");
      eq(svOff.status, 404, "S13: SV_LOCALE_ENABLED off -> POST /sv/…/kontakt is a 404");
      eq(sent.length, 0, "S14: ... nothing sent");
      delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;
    }
    delete process.env.CONTACT_FORM_EXPERIENCES;
    freshContactForm();

    // ── G: bodies and logs ────────────────────────────────────────────────
    {
      const postAndAdmin = allBodies.filter((b) => b.label.includes("/kontakt") || b.label.includes("/admin/"));
      const leaked = postAndAdmin.filter((b) => providerEmails.some((e) => e && leaks(b.text, e)));
      ok(leaked.length === 0, `G1: no POST/admin response body carries a producer address (${leaked.map((b) => b.label).join(", ")})`);
      ok(cfLog.length > 0, "G2: contact-form outcomes were logged");
      const joined = cfLog.join("\n");
      ok(![...providerEmails, goodFields.reply_email, "skjemaprove-sideri.example", "gjest.example"].some((e) => e && joined.includes(e)), "G3: no contact-form log line carries an e-mail address");
      ok(!/198\.51\.100\./.test(joined), "G4: no contact-form log line carries an IP");
      ok(!joined.includes(goodFields.message), "G5: no log line carries the message text");
      ok(cfLog.every((l) => { try { const o = JSON.parse(l); return o.evt === "contact_form" && o.host === "experiences" && typeof o.profile_id === "string" && o.profile_id !== ""; } catch { return false; } }), "G6: every line is the experiences contact-form JSON line with a provider id");
      ok(guardLog.every((l) => !providerEmails.some((e) => e && l.includes(e))), "G7: no guard log line carries an address");
    }
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.log = prevConsoleLog;
    if (closeHttp) await closeHttp().catch(() => {});
    try {
      (require("../services/profile-ai-deliveries") as typeof import("../services/profile-ai-deliveries")).__resetAiDeliveriesForTesting();
    } catch { /* best-effort */ }
    for (const k of envKeys) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    guard.__resetEmailRevealGuardForTesting();
    cf.__resetContactFormForTesting();
    try {
      (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
    } catch { /* best-effort */ }
    restoreModuleCache();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runExperiencesContactFormOnlyTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
