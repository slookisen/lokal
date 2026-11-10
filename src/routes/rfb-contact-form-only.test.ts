/**
 * rfb-contact-form-only.test.ts — dev-request
 * 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, S-D1
 * («Kontaktskjema som valg per profil») on rettfrabonden.com: the
 * agents.contact_form_only flag (admin POST /admin/agents/:id/contact-form-only),
 * the profile page /produsent/:slug (form instead of e-mail, no JSON-LD
 * `email`) and POST /produsent/:slug/kontakt (forwarding through a stubbed
 * sender — no network), behind CONTACT_FORM_RFB.
 *
 * Fixture: the made-up producers of rfb-profile-email-reveal.test.ts
 * (seedRfbEmailFixture) in an own in-memory main DB.
 *
 *   O   switch off: a flagged profile's page is byte-identical to the same
 *       page unflagged (the flag is not read), no Cache-Control; the POST path
 *       is the app's fall-through 404 byte for byte; nothing sent
 *   F   switch on: flagged producer / umbrella / /en page has the form
 *       (honeypot, Norwegian labels), no address anywhere, no JSON-LD
 *       `email`, no «Vis e-post»; unflagged page byte-identical to switch
 *       off; switch values; with the e-mail guard on the flagged profile
 *       spends no budget; flagged without stored e-mail → no form
 *   A   admin endpoint: 200 on/off, 400 non-boolean, 404 unknown id, 403
 *       wrong/missing key (the /admin/agents convention), no address echoed
 *   P   POST: happy path (HTML and JSON) sends ONE mail with to = stored
 *       address and replyTo = the sender; honeypot → success, no send;
 *       invalid input → 400; 6th message from one IP → 429 + Retry-After,
 *       another IP unaffected; unknown / unflagged / no e-mail / non-producer
 *       → 404; send failure → 502; /en
 *   G   no response body carries a producer address; log lines carry no
 *       address and no IP
 *
 * Standalone: npx tsx src/routes/rfb-contact-form-only.test.ts
 * Wired into tests/test.ts via runRfbContactFormOnlyTests().
 */

import Database from "better-sqlite3";
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

function mailtos(html: string): string[] {
  return Array.from(html.matchAll(/mailto:([^"'\s<>]*@[^"'\s<>]*)/gi)).map((m) => m[1]!);
}

export async function runRfbContactFormOnlyTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const envKeys = ["CONTACT_FORM_RFB", "EMAIL_REVEAL_GUARD_RFB", "EMAIL_REVEAL_PER_IP_PER_HOUR", "OWNER_PAUSE_ENABLED", "OWNER_FEATURES_ENFORCE", "OWNER_FEATURES_ALLOWED_SUBJECTS", "ADMIN_KEY", "ANALYTICS_ADMIN_KEY"];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  for (const k of envKeys) delete process.env[k];
  const ADMIN_KEY = "contact-form-only-test-key";

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevMainDb = initMod.__peekDbForTesting();
  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");
  testDb.function("random", () => 0);

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
  const clearRegistry = () => {
    const reg = (require("../services/marketplace-registry") as any).marketplaceRegistry;
    reg._agentsCache = null;
    reg._statsCache = null;
    reg._slugIdMap = null;
  };
  let closeHttp: (() => Promise<void>) | null = null;
  const prevConsoleLog = console.log;
  const adminLog: string[] = [];
  if (!log) console.log = (...args: unknown[]) => { adminLog.push(args.map(String).join(" ")); };

  try {
    initMod.__setDbForTesting(testDb as any);
    initMod.__initSchemaForTesting(testDb as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    const { seedRfbEmailFixture, RFB_EMAIL_FIXTURE } = require("./rfb-profile-email-reveal.test") as typeof import("./rfb-profile-email-reveal.test");
    seedRfbEmailFixture(testDb);
    clearRegistry();
    try { delete require.cache[require.resolve("./seo")]; } catch { /* not loaded yet */ }
    try { delete require.cache[require.resolve("./admin-agents")]; } catch { /* not loaded yet */ }
    const seoMod = require("./seo") as typeof import("./seo");
    const adminMod = require("./admin-agents") as typeof import("./admin-agents");
    const { langMiddleware } = require("../i18n/middleware") as typeof import("../i18n/middleware");
    const { slugify } = require("../utils/slug") as typeof import("../utils/slug");
    guard.__resetEmailRevealGuardForTesting({ log: (l) => guardLog.push(l) });
    freshContactForm();

    const P = RFB_EMAIL_FIXTURE.producers;
    const U = RFB_EMAIL_FIXTURE.umbrella;
    const flagged = P[0]!;
    const unflagged = P[1]!;
    const flaggedSlug = slugify(flagged.name);
    const unflaggedSlug = slugify(unflagged.name);
    const umbSlug = slugify(U.name);
    const noEmailSlug = slugify(RFB_EMAIL_FIXTURE.noEmail.name);
    const logisticsSlug = slugify(RFB_EMAIL_FIXTURE.logistics.name);
    const producerEmails = [...P.map((p) => p.email), U.email, RFB_EMAIL_FIXTURE.logistics.email];
    const setFlag = (id: string, on: boolean) => testDb.prepare("UPDATE agents SET contact_form_only = ? WHERE id = ?").run(on ? 1 : 0, id);

    const leaks = (html: string, email: string) => [
      email,
      email.replace(/&/g, "&amp;"),
      encodeURIComponent(email),
      JSON.stringify(email).slice(1, -1),
    ].some((form) => html.includes(form)) || html.includes(email.split("@")[0]! + "@");
    const allBodies: Array<{ label: string; text: string }> = [];

    // ── HTTP app ──────────────────────────────────────────────────────────
    const express = require("express") as typeof import("express");
    const http = require("http") as typeof import("http");
    const app = express();
    app.set("trust proxy", true);
    app.use("/admin/agents", express.json(), adminMod.default as any);
    app.use(langMiddleware);
    app.use("/", seoMod.default as any);
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
            resolve({ status: res.statusCode ?? 0, text, headers: res.headers });
          });
        });
        r.on("error", reject);
        if (body !== undefined) r.write(body);
        r.end();
      });
    const page = (slug: string, ip = "198.51.100.1", prefix = "") => request("GET", `${prefix}/produsent/${slug}`, ip);
    const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
    const goodFields = { name: "Kari Kunde", reply_email: "kari@kunde.example", message: "Hei! Har dere poteter igjen denne uka?", _honey: "" };
    const postForm = (slug: string, ip: string, fields: Record<string, string> = goodFields, prefix = "") =>
      request("POST", `${prefix}/produsent/${slug}/kontakt`, ip, form(fields), { "content-type": "application/x-www-form-urlencoded", accept: "text/html" });
    const postJson = (slug: string, ip: string, fields: Record<string, unknown>) =>
      request("POST", `/produsent/${slug}/kontakt`, ip, JSON.stringify(fields), { "content-type": "application/json", accept: "application/json" });
    const admin = (id: string, body: unknown, key: string | null = ADMIN_KEY) =>
      request("POST", `/admin/agents/${encodeURIComponent(id)}/contact-form-only`, "198.51.100.200", JSON.stringify(body), {
        "content-type": "application/json",
        ...(key === null ? {} : { "x-admin-key": key }),
      });
    const formAction = (slug: string, prefix = "") => `action="${prefix}/produsent/${slug}/kontakt"`;
    const hasForm = (html: string, slug: string, prefix = "") =>
      html.includes(formAction(slug, prefix)) && html.includes('name="_honey"') && html.includes('name="reply_email"') && html.includes('name="message"') && html.includes('id="kontaktskjema"');
    const onlyPlatformMailto = (html: string) => mailtos(html).every((m) => /^kontakt@/i.test(m));

    process.env.ADMIN_KEY = ADMIN_KEY;

    // ── O: switch off ─────────────────────────────────────────────────────
    {
      const before = await page(flaggedSlug);
      const beforeUmb = await page(umbSlug);
      setFlag(flagged.id, true);
      setFlag(U.id, true);
      const off = await page(flaggedSlug);
      ok(off.status === 200 && off.text === before.text, "O1: switch off -> a flagged profile's page is byte-identical to the same page unflagged");
      ok(off.text.includes(`href="mailto:${flagged.email}"`) && jsonLdHasEmail(off.text), "O2: switch off -> the flagged profile still shows its mailto: and JSON-LD email");
      ok(!off.text.includes("kontaktskjema") && !off.text.includes(`/produsent/${flaggedSlug}/kontakt`) && !off.text.includes('name="_honey"'), "O3: switch off -> no contact form");
      eq(off.headers["cache-control"], undefined, "O4: switch off -> no Cache-Control");
      ok((await page(umbSlug)).text === beforeUmb.text, "O5: switch off -> flagged umbrella byte-identical");
      process.env.CONTACT_FORM_RFB = "off";
      ok((await page(flaggedSlug)).text === before.text, "O6: switch \"off\" -> same as unset");
      process.env.CONTACT_FORM_RFB = "yes";
      ok((await page(flaggedSlug)).text === before.text, "O7: switch \"yes\" -> off");
      delete process.env.CONTACT_FORM_RFB;
      const fallThrough = await request("POST", `/produsent/${flaggedSlug}/finnes-ikke`, "198.51.100.2", form(goodFields), { "content-type": "application/x-www-form-urlencoded" });
      const offPost = await postForm(flaggedSlug, "198.51.100.2");
      ok(offPost.status === 404 && offPost.text === fallThrough.text.replace("/finnes-ikke", "/kontakt"), "O8: switch off -> POST /produsent/:slug/kontakt is the app's fall-through 404, byte for byte");
      eq([offPost.headers["cache-control"], offPost.headers["x-robots-tag"]], [undefined, undefined], "O9: switch off -> the POST path has none of the new headers");
      eq(sent.length, 0, "O10: switch off -> nothing sent");
      eq(cfLog.length, 0, "O11: switch off -> no contact-form log line");
    }

    // ── A: admin endpoint ─────────────────────────────────────────────────
    {
      setFlag(flagged.id, false);
      const on = await admin(flagged.id, { enabled: true });
      ok(on.status === 200 && JSON.stringify(JSON.parse(on.text)) === JSON.stringify({ id: flagged.id, contact_form_only: true }), `A1: enable -> 200 { id, contact_form_only: true } (got ${on.status} ${on.text})`);
      eq((testDb.prepare("SELECT contact_form_only FROM agents WHERE id = ?").get(flagged.id) as any).contact_form_only, 1, "A2: the flag is stored");
      const offR = await admin(unflagged.id, { enabled: false });
      ok(offR.status === 200 && JSON.parse(offR.text).contact_form_only === false, "A3: disable -> 200 contact_form_only false");
      for (const body of [{ enabled: "true" }, { enabled: 1 }, {}, { enabled: null }]) {
        eq((await admin(flagged.id, body)).status, 400, `A4: ${JSON.stringify(body)} -> 400`);
      }
      eq((testDb.prepare("SELECT contact_form_only FROM agents WHERE id = ?").get(flagged.id) as any).contact_form_only, 1, "A5: a 400 changes nothing");
      eq((await admin("finnes-ikke-id", { enabled: true })).status, 404, "A6: unknown id -> 404");
      eq((await admin(flagged.id, { enabled: false }, "wrong-key")).status, 403, "A7: wrong admin key -> 403 (the /admin/agents convention)");
      eq((await admin(flagged.id, { enabled: false }, null)).status, 403, "A8: no admin key -> 403");
      eq((testDb.prepare("SELECT contact_form_only FROM agents WHERE id = ?").get(flagged.id) as any).contact_form_only, 1, "A9: a refused call changes nothing");
      const emailAfter = (testDb.prepare("SELECT email FROM agent_knowledge WHERE agent_id = ?").get(flagged.id) as any).email;
      eq(emailAfter, flagged.email, "A10: the stored e-mail address is untouched");
      eq(sent.length, 0, "A11: the admin endpoint sends no mail");
      ok(adminLog.filter((l) => l.includes("contact_form_only_set")).every((l) => !producerEmails.some((e) => l.includes(e))), "A12: the admin log line carries no address");
    }

    // ── F: switch on, profile pages ───────────────────────────────────────
    setFlag(flagged.id, true);
    setFlag(U.id, true);
    const unflaggedOff = await page(unflaggedSlug);
    process.env.CONTACT_FORM_RFB = "on";
    {
      const r = await page(flaggedSlug);
      ok(r.status === 200 && hasForm(r.text, flaggedSlug), "F1: switch on, flagged -> the page has the contact form (honeypot, name, reply e-mail, message)");
      ok(r.text.includes("Send melding til produsenten") && r.text.includes(">Send melding</button>"), "F2: Norwegian labels");
      ok(!leaks(r.text, flagged.email) && onlyPlatformMailto(r.text), "F3: flagged -> the address is nowhere in the HTML, no producer mailto:");
      ok(!jsonLdHasEmail(r.text), "F4: flagged -> JSON-LD has no email");
      ok(jsonLdBlocks(r.text).some((b) => b && b["@type"] === "LocalBusiness" && b.telephone), "F5: the LocalBusiness JSON-LD is otherwise there");
      ok(!r.text.includes("Vis e-post") && !r.text.includes("/epost"), "F6: no «Vis e-post»");
      eq(r.headers["cache-control"], undefined, "F7: the page does not vary by client (guard off) -> no Cache-Control");
      const umb = await page(umbSlug);
      ok(umb.status === 200 && hasForm(umb.text, umbSlug) && !leaks(umb.text, U.email) && onlyPlatformMailto(umb.text), "F8: flagged umbrella -> form, no address");
      const en = await page(flaggedSlug, "198.51.100.1", "/en");
      ok(en.status === 200 && hasForm(en.text, flaggedSlug, "/en") && en.text.includes("Send a message to the producer") && !leaks(en.text, flagged.email) && !jsonLdHasEmail(en.text), "F9: /en flagged -> English form posting to /en/…/kontakt, no address");
      const un = await page(unflaggedSlug);
      ok(un.text === unflaggedOff.text && un.headers["cache-control"] === undefined, "F10: switch on, unflagged profile -> byte-identical to switch off");
      for (const v of ["1", "true", "TRUE", " On "]) {
        process.env.CONTACT_FORM_RFB = v;
        ok(hasForm((await page(flaggedSlug)).text, flaggedSlug), `F11: switch ${JSON.stringify(v)} -> on`);
      }
      process.env.CONTACT_FORM_RFB = "on";
      // With the e-mail guard on too: no reveal, nothing counted for the flagged profile.
      process.env.EMAIL_REVEAL_GUARD_RFB = "on";
      process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = "1";
      guard.__resetEmailRevealGuardForTesting({ log: (l) => guardLog.push(l) });
      const g = await page(flaggedSlug, "198.51.100.3");
      ok(hasForm(g.text, flaggedSlug) && !leaks(g.text, flagged.email) && !g.text.includes("Vis e-post") && !jsonLdHasEmail(g.text), "F12: guard on + flagged -> form, no «Vis e-post», no address");
      eq(g.headers["cache-control"], "private", "F13: guard on -> Cache-Control: private (as every guarded page)");
      const next = await page(unflaggedSlug, "198.51.100.3");
      ok(next.text.includes(`href="mailto:${unflagged.email}"`), "F14: the flagged profile spent none of the IP's e-mail budget (limit 1: the next profile still shows its e-mail)");
      delete process.env.EMAIL_REVEAL_GUARD_RFB;
      delete process.env.EMAIL_REVEAL_PER_IP_PER_HOUR;
      guard.__resetEmailRevealGuardForTesting({ log: (l) => guardLog.push(l) });
      // Flagged but no stored e-mail → nothing to forward to → no form.
      setFlag(RFB_EMAIL_FIXTURE.noEmail.id, true);
      const ne = await page(noEmailSlug);
      ok(ne.status === 200 && !ne.text.includes("kontaktskjema") && onlyPlatformMailto(ne.text), "F15: flagged without a stored e-mail -> no form");
    }

    // ── P: POST /produsent/:slug/kontakt ──────────────────────────────────
    freshContactForm();
    {
      const r = await postForm(flaggedSlug, "198.51.100.10");
      ok(r.status === 200 && r.text.includes("Takk for meldingen"), `P1: happy path -> 200 Norwegian thank-you page (got ${r.status})`);
      eq([r.headers["cache-control"], r.headers["x-robots-tag"]], ["private, no-store", "noindex, nofollow"], "P2: Cache-Control private, no-store + noindex");
      eq(sent.length, 1, "P3: exactly one mail sent");
      const m = sent[0];
      ok(!!m && m.to === flagged.email && m.replyTo === goodFields.reply_email, "P4: to = the stored address, replyTo = the sender's address");
      ok(!!m && m.subject === `Melding via Rett fra Bonden: ${goodFields.name}`, `P5: subject «Melding via Rett fra Bonden: …» (got ${m?.subject})`);
      ok(!!m && m.textContent.includes(goodFields.message) && m.textContent.includes("videresendt av Rett fra Bonden"), "P6: the body carries the message and the forwarded-by-platform footer");
      ok(!!m && m.redactRecipientInLogs === true && m.omitAgentHeader === true && typeof m.logSubjectAs === "string", "P7: the send log is redacted (no recipient, no visitor subject)");
      ok(!leaks(r.text, flagged.email), "P8: the producer's address is not in the answer");

      const j = await postJson(flaggedSlug, "198.51.100.11", goodFields);
      ok(j.status === 200 && JSON.stringify(JSON.parse(j.text)) === JSON.stringify({ ok: true }), `P9: JSON client -> 200 {"ok":true} (got ${j.status} ${j.text})`);
      eq(sent.length, 2, "P10: ... and one more mail");

      const hp = await postForm(flaggedSlug, "198.51.100.12", { ...goodFields, _honey: "http://spam.example" });
      ok(hp.status === 200 && hp.text.includes("Takk for meldingen"), "P11: honeypot filled -> answered like a success");
      eq(sent.length, 2, "P12: honeypot -> nothing sent");

      for (const [label, fields] of [
        ["bad reply e-mail", { ...goodFields, reply_email: "ikke-en-adresse" }],
        ["reply e-mail with a newline", { ...goodFields, reply_email: "kari@kunde.example\nBcc: x@y.example" }],
        ["missing message", { ...goodFields, message: "  " }],
        ["message too long", { ...goodFields, message: "x".repeat(2001) }],
        ["missing name", { ...goodFields, name: "" }],
        ["name too long", { ...goodFields, name: "n".repeat(101) }],
      ] as Array<[string, Record<string, string>]>) {
        const bad = await postForm(flaggedSlug, "198.51.100.13", fields);
        ok(bad.status === 400 && bad.text.includes("Meldingen ble ikke sendt") && !leaks(bad.text, flagged.email), `P13: ${label} -> 400, no address`);
      }
      const badJson = await postJson(flaggedSlug, "198.51.100.13", { ...goodFields, reply_email: "nei" });
      ok(badJson.status === 400 && JSON.parse(badJson.text).fields?.includes("reply_email"), "P14: JSON invalid -> 400 with the field");
      eq(sent.length, 2, "P15: invalid input -> nothing sent");

      // Per-IP limit: 5 per hour.
      freshContactForm();
      const ip = "198.51.100.20";
      let firstFive = true;
      for (let n = 0; n < 5; n++) firstFive = (await postForm(flaggedSlug, ip)).status === 200 && firstFive;
      ok(firstFive, "P16: 5 messages from one IP -> all 200");
      const sixth = await postForm(flaggedSlug, ip);
      ok(sixth.status === 429 && sixth.text.includes("For mange meldinger"), "P17: the 6th -> 429");
      const ra = Number(sixth.headers["retry-after"]);
      ok(Number.isFinite(ra) && ra > 0 && ra <= 3600, `P18: 429 has Retry-After in seconds (got ${sixth.headers["retry-after"]})`);
      eq(sent.length, 5, "P19: the 6th was not sent");
      eq((await postForm(umbSlug, ip)).status, 429, "P20: the limit is per IP, not per profile");
      eq((await postForm(flaggedSlug, "198.51.100.21")).status, 200, "P21: another IP has its own budget");
      const hpOver = await postForm(flaggedSlug, ip, { ...goodFields, _honey: "x" });
      eq(hpOver.status, 200, "P22: honeypot is answered like a success even over the limit (bots learn nothing)");

      // 404s
      freshContactForm();
      for (const [label, slug] of [
        ["unknown slug", "finnes-ikke-gard"],
        ["unflagged profile", unflaggedSlug],
        ["flagged without e-mail", noEmailSlug],
        ["non-producer", logisticsSlug],
      ] as Array<[string, string]>) {
        const nf = await postForm(slug, "198.51.100.30");
        ok(nf.status === 404 && nf.headers["x-robots-tag"] === "noindex, nofollow", `P23: ${label} -> 404 noindex`);
      }
      eq((await postJson(unflaggedSlug, "198.51.100.30", goodFields)).status, 404, "P24: unflagged (JSON) -> 404");
      setFlag(flagged.id, false);
      eq((await postForm(flaggedSlug, "198.51.100.31")).status, 404, "P25: flag removed -> 404");
      setFlag(flagged.id, true);
      eq(sent.length, 0, "P26: no 404 sent anything");

      // Owner-paused profile → 404.
      process.env.OWNER_PAUSE_ENABLED = "1";
      testDb.prepare("INSERT INTO owner_profile_pause (agent_id, paused_at, pause_until, set_by) VALUES (?, '2026-10-01T00:00:00.000Z', NULL, 'owner')").run(flagged.id);
      try {
        eq((await postForm(flaggedSlug, "198.51.100.32")).status, 404, "P27: owner-paused flagged profile -> 404");
      } finally {
        testDb.prepare("DELETE FROM owner_profile_pause WHERE agent_id = ?").run(flagged.id);
        delete process.env.OWNER_PAUSE_ENABLED;
      }

      // Send failure.
      freshContactForm();
      sendResult = { success: false, error: "boom" };
      const fail = await postForm(flaggedSlug, "198.51.100.40");
      ok(fail.status === 502 && !leaks(fail.text, flagged.email), "P28: send failure -> 502, no address");

      // /en
      freshContactForm();
      const en = await postForm(flaggedSlug, "198.51.100.41", goodFields, "/en");
      ok(en.status === 200 && en.text.includes("Thank you for your message"), "P29: /en POST -> English thank-you page");
      eq(sent.length, 1, "P30: /en POST sent one mail");

      // Switch off again: the POST is back to the fall-through 404.
      delete process.env.CONTACT_FORM_RFB;
      freshContactForm();
      eq((await postForm(flaggedSlug, "198.51.100.42")).status, 404, "P31: switch turned off -> POST 404");
      eq(sent.length, 0, "P32: ... nothing sent");
    }

    // ── G: bodies and logs ────────────────────────────────────────────────
    {
      const pageAndPostBodies = allBodies.filter((b) => b.label.includes("/kontakt") || b.label.includes("/admin/"));
      const leaked = pageAndPostBodies.filter((b) => producerEmails.some((e) => leaks(b.text, e)));
      ok(leaked.length === 0, `G1: no POST/admin response body carries a producer address (${leaked.map((b) => b.label).join(", ")})`);
      ok(cfLog.length > 0, "G2: contact-form outcomes were logged");
      const joined = cfLog.join("\n");
      ok(![...producerEmails, goodFields.reply_email, "visprove-gard", "kunde.example"].some((e) => joined.includes(e)), "G3: no contact-form log line carries an e-mail address");
      ok(!/198\.51\.100\./.test(joined), "G4: no contact-form log line carries an IP");
      ok(!joined.includes(goodFields.message), "G5: no log line carries the message text");
      ok(cfLog.every((l) => { try { const o = JSON.parse(l); return o.evt === "contact_form" && o.host === "rfb" && typeof o.profile_id === "string"; } catch { return false; } }), "G6: every line is the contact-form JSON line with a profile id");
    }
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.log = prevConsoleLog;
    if (closeHttp) await closeHttp().catch(() => {});
    for (const k of envKeys) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    guard.__resetEmailRevealGuardForTesting();
    cf.__resetContactFormForTesting();
    try { clearRegistry(); } catch { /* ignore */ }
    try { delete require.cache[require.resolve("./seo")]; } catch { /* ignore */ }
    try { delete require.cache[require.resolve("./admin-agents")]; } catch { /* ignore */ }
    if (prevMainDb) initMod.__setDbForTesting(prevMainDb as any);
    testDb.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbContactFormOnlyTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
