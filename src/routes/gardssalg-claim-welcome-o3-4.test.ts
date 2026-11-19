/**
 * gardssalg-claim-welcome-o3-4.test.ts — A2A dev-request 2026-11-12-
 * opplevagent-o3-eierkrav-og-innlogging, slice O3-4: «Du er nå eier av
 * profilen» after a completed claim (flag GARDSSALG_CLAIM_WELCOME_EMAIL_
 * ENABLED, default off) + the claim e-mails filed in the producer's CRM thread.
 *
 * Covers:
 *   (k1) AK1 flag off ("unset" and "false"): a completed claim sends no mail
 *        and files nothing in the CRM.
 *   (k2) AK2 flag on, confirm step off (GET path): exactly one mail, to the
 *        claim's address (not the profile's epost); a repeat GET and a later
 *        login link for the same address send nothing more.
 *   (k3) AK2 flag on, confirm step on (POST path): the GET sends nothing, the
 *        POST sends one mail; a second POST and a GET after send nothing.
 *   (t)  AK3 subject and body verbatim (literal in this test), HTML escaped.
 *   (c)  the welcome mail lands in the producer's CRM thread; the magic-link
 *        copy carries a placeholder, never a token; a throwing archive does
 *        not fail the claim.
 *   (l)  no token or link in any log line.
 *
 * In-memory experiences + main (CRM) db, stub transporter; restored in finally.
 * Exported runGardssalgClaimWelcomeO34Tests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/gardssalg-claim-welcome-o3-4.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface SentMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

const EXPECTED_SUBJECT = "Du er nå eier av profilen til Øvre Æble & Sønn på Opplevagent";
const EXPECTED_TEXT = `Hei,

Du har tatt over profilen til Øvre Æble & Sønn på Opplevagent.

Du er logget inn i 7 dager på enheten du brukte nå. Senere logger du inn her: https://opplevagent.no/kategori/gardssalg/eier/ovre-aeble
Der ber du om en innloggingslenke, som kommer på e-post. Du trenger ikke passord.

Som eier kan du:
- rette opplysningene om stedet og åpningstidene
- bestemme om stedet skal ta imot forespørsler om besøk
- svare på forespørsler og se oversikten over dem

Har du ikke tatt over denne profilen selv, svarer du på denne e-posten med en gang, så stopper vi det.

Hilsen
Opplevagent`;

export function runGardssalgClaimWelcomeO34Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const out = console.log.bind(console); // the assertion output is not part of the captured logs
  const assertEq = (actual: unknown, expected: unknown, label: string): void => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) out(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) out("  " + msg);
    }
  };
  const assertTrue = (cond: boolean, label: string): void => assertEq(!!cond, true, label);

  return (async () => {
    const ENV_KEYS = [
      "EXPERIENCES_DB_PATH",
      "OPPLEVAGENT_BASE_URL",
      "GARDSSALG_CLAIM_CONFIRM_STEP_ENABLED",
      "GARDSSALG_CLAIM_WELCOME_EMAIL_ENABLED",
      "GARDSSALG_OWNER_SESSION_SLIDING_ENABLED",
    ] as const;
    const savedEnv: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.OPPLEVAGENT_BASE_URL = "https://opplevagent.no";

    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("../services/gardssalg-claim"),
      require.resolve("./gardssalg-claim"),
    ]);
    const initMod = require("../database/init") as typeof import("../database/init");
    const restoreMainDb = initMod.__pinInMemoryDbForTesting();
    const emailSvc = (require("../services/email-service") as typeof import("../services/email-service")).emailService as any;
    const origConfigured = emailSvc.isConfigured;
    const origTransporter = emailSvc.transporter;
    const archiveMod = require("../services/gardssalg-claim-crm-archive") as typeof import("../services/gardssalg-claim-crm-archive");
    const mails: SentMail[] = [];
    const logged: string[] = [];
    const origConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    let server: any = null;

    try {
      emailSvc.isConfigured = true;
      emailSvc.transporter = {
        sendMail: async (m: Record<string, any>) => {
          mails.push({ to: String(m.to), subject: String(m.subject), text: String(m.text ?? ""), html: String(m.html ?? "") });
          return { messageId: `<stub-o34-${mails.length}@test>` };
        },
      };
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const mainDb = initMod.__peekDbForTesting()!;
      const routerMod = require("./gardssalg-claim") as typeof import("./gardssalg-claim");

      const insertProvider = db.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, content_source, epost, enrichment_state, verification_status, source, confidence)
        VALUES (@id, @navn, @slug, 'experiences', @org_nr, 1, NULL, 'profil@example.test', 'raw', 'pending_verify', 'test-fixture', 'medium')
      `);
      insertProvider.run({ id: "prov-o34-off", navn: "Flagg Av Gård", slug: "o34-flagg-av", org_nr: "913400001" });
      insertProvider.run({ id: "prov-o34-get", navn: "Øvre Æble & Sønn", slug: "ovre-aeble", org_nr: "913400002" });
      insertProvider.run({ id: "prov-o34-post", navn: "Bekreft Bryggeri", slug: "o34-bekreft", org_nr: "913400003" });
      insertProvider.run({ id: "prov-o34-fail", navn: "Arkiv Feil Gård", slug: "o34-arkiv-feil", org_nr: "913400004" });

      const hex = (c: string) => c.repeat(64).slice(0, 64);
      const DAY = 86400000;
      const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();
      const insertClaim = (id: string, providerId: string, email: string, token: string) =>
        db.prepare(`
          INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at, revoked_at, draft_mode, is_test)
          VALUES (?, ?, ?, 'stored_epost_verified', ?, 0, ?, ?, NULL, 0, 0)
        `).run(id, providerId, email, token, iso(0), iso(1));
      const OFF1 = hex("a"); insertClaim("gsc_o34_off1", "prov-o34-off", "eier-av@example.test", OFF1);
      const OFF2 = hex("b"); insertClaim("gsc_o34_off2", "prov-o34-off", "eier-av2@example.test", OFF2);
      const G1 = hex("c"); insertClaim("gsc_o34_g1", "prov-o34-get", "eier-get@example.test", G1);
      const G2 = hex("d"); insertClaim("gsc_o34_g2", "prov-o34-get", "eier-get@example.test", G2);
      const P1 = hex("e"); insertClaim("gsc_o34_p1", "prov-o34-post", "eier-post@example.test", P1);
      const F1 = hex("f"); insertClaim("gsc_o34_f1", "prov-o34-fail", "eier-feil@example.test", F1);
      const TOKENS = [OFF1, OFF2, G1, G2, P1, F1];

      const expressMod = require("express") as typeof import("express");
      const app = expressMod();
      app.use("/", routerMod.default);
      const httpMod = require("http") as typeof import("http");
      server = httpMod.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const port = (server.address() as any).port as number;
      const req = (method: string, path: string, body?: string) =>
        new Promise<{ status: number; headers: any; body: string }>((resolve, reject) => {
          const headers: Record<string, string> = { "X-Forwarded-For": "203.0.113.34" };
          if (body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
          const r = httpMod.request({ method, host: "127.0.0.1", port, path, headers }, (resp) => {
            const chunks: Buffer[] = [];
            resp.on("data", (c) => chunks.push(c as Buffer));
            resp.on("end", () => resolve({ status: resp.statusCode || 0, headers: resp.headers, body: Buffer.concat(chunks).toString("utf8") }));
          });
          r.on("error", reject);
          if (body !== undefined) r.write(body);
          r.end();
        });
      // The welcome mail is sent after the response (fire-and-forget).
      const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10)); };
      const VERIFY = "/kategori/gardssalg/eier/magic-link-verify";
      const CONFIRM = "/kategori/gardssalg/eier/magic-link-confirm";
      const crmRows = (providerId: string) => mainDb.prepare(`
        SELECT m.direction, m.to_emails, m.subject, m.body_text, m.body_html, m.vertical_id, t.vertical_id AS thread_vertical
          FROM crm_messages m JOIN crm_threads t ON t.id = m.thread_id
         WHERE m.thread_id = ? ORDER BY m.rowid`).all(archiveMod.gardssalgClaimCrmThreadId(providerId)) as any[];

      for (const k of ["log", "warn", "error", "info"] as const) {
        (console as any)[k] = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
      }

      // ── (k1) AK1 flag off ───────────────────────────────────────────────
      const k1 = await req("GET", `${VERIFY}?token=${OFF1}`);
      await settle();
      assertEq([k1.status, k1.headers.location], [302, "/kategori/gardssalg/eier/o34-flagg-av/portal"], "k1-1: flag unset, the claim completes as before");
      assertEq(mails.length, 0, "k1-2: AK1 flag unset -> no mail sent");
      process.env.GARDSSALG_CLAIM_WELCOME_EMAIL_ENABLED = "false";
      const k1b = await req("GET", `${VERIFY}?token=${OFF2}`);
      await settle();
      assertEq([k1b.status, mails.length], [302, 0], "k1-3: AK1 flag \"false\" -> claim completes, no mail sent");
      assertEq(crmRows("prov-o34-off").length, 0, "k1-4: flag off -> nothing filed in the CRM");

      // ── (k2) AK2 flag on, confirm step off: the GET path ────────────────
      process.env.GARDSSALG_CLAIM_WELCOME_EMAIL_ENABLED = "true";
      const k2 = await req("GET", `${VERIFY}?token=${G1}`);
      await settle();
      assertEq([k2.status, k2.headers.location], [302, "/kategori/gardssalg/eier/ovre-aeble/portal"], "k2-1: flag on, GET completes the claim as before");
      assertEq(mails.map((m) => m.to), ["eier-get@example.test"], "k2-2: AK2 exactly one mail, to the claim's address (not the profile epost)");
      await req("GET", `${VERIFY}?token=${G1}`);
      await settle();
      assertEq(mails.length, 1, "k2-3: AK2 a repeat GET of the same link sends nothing more");
      const k2login = await req("GET", `${VERIFY}?token=${G2}`);
      await settle();
      assertEq([k2login.status, mails.length], [302, 1], "k2-4: a later login link for the same address logs in, no second mail");

      // ── (t) AK3 verbatim ────────────────────────────────────────────────
      const w = mails[0];
      assertEq(w.subject, EXPECTED_SUBJECT, "t1: AK3 subject verbatim");
      assertEq(w.text, EXPECTED_TEXT, "t2: AK3 text body verbatim");
      assertTrue(w.html.includes("Du har tatt over profilen til Øvre Æble &amp; Sønn på Opplevagent.") && !w.html.includes("Æble & Sønn"),
        "t3: HTML derived from the text, {produsent} escaped");
      assertTrue(w.html.includes('<a href="https://opplevagent.no/kategori/gardssalg/eier/ovre-aeble">'), "t4: HTML links the owner login page");
      assertTrue(!TOKENS.some((t) => w.text.includes(t) || w.html.includes(t)), "t5: the welcome mail carries no token");

      // ── (c) CRM archive of the welcome mail ─────────────────────────────
      const rows = crmRows("prov-o34-get");
      assertEq(rows.map((r) => [r.direction, JSON.parse(r.to_emails), r.subject, r.vertical_id, r.thread_vertical]),
        [["out", ["eier-get@example.test"], EXPECTED_SUBJECT, "experiences", "experiences"]],
        "c1: the welcome mail is filed once in the producer's CRM thread (experiences)");
      assertEq(rows[0]?.body_text, EXPECTED_TEXT, "c2: … with the text that was sent");

      // ── (k3) AK2 flag on, confirm step on: the POST path ────────────────
      process.env.GARDSSALG_CLAIM_CONFIRM_STEP_ENABLED = "true";
      const before = mails.length;
      const k3get = await req("GET", `${VERIFY}?token=${P1}`);
      await settle();
      assertEq([k3get.status, mails.length - before], [200, 0], "k3-1: confirm step on, the GET only shows the confirm page, no mail");
      const k3 = await req("POST", CONFIRM, `token=${P1}&action=confirm`);
      await settle();
      assertEq([k3.status, k3.headers.location], [302, "/kategori/gardssalg/eier/o34-bekreft/portal"], "k3-2: the POST completes the claim");
      assertEq(mails.slice(before).map((m) => [m.to, m.subject]),
        [["eier-post@example.test", "Du er nå eier av profilen til Bekreft Bryggeri på Opplevagent"]], "k3-3: AK2 exactly one mail, to the claim's address");
      const k3again = await req("POST", CONFIRM, `token=${P1}&action=confirm`);
      await req("GET", `${VERIFY}?token=${P1}`);
      await settle();
      assertEq([k3again.status, k3again.headers["set-cookie"], mails.length - before], [200, undefined, 1],
        "k3-4: AK2 a second POST (and a GET) with the same token sends nothing more");
      delete process.env.GARDSSALG_CLAIM_CONFIRM_STEP_ENABLED;

      // ── (c) a throwing archive does not fail the claim ──────────────────
      archiveMod.__setGardssalgClaimCrmIngestForTesting(() => { throw new Error("crm down"); });
      const beforeFail = mails.length;
      const cf = await req("GET", `${VERIFY}?token=${F1}`);
      await settle();
      archiveMod.__setGardssalgClaimCrmIngestForTesting(null);
      const owner = db.prepare("SELECT content_source, claimed_at FROM experience_providers WHERE id = 'prov-o34-fail'").get() as any;
      assertEq([cf.status, cf.headers.location, String((cf.headers["set-cookie"] || [])[0] || "").startsWith(`oa_owner_session=${F1};`)],
        [302, "/kategori/gardssalg/eier/o34-arkiv-feil/portal", true], "c3: archive throws -> the claim still succeeds with a session");
      assertEq([owner.content_source, typeof owner.claimed_at, mails.length - beforeFail], ["claim", "string", 1], "c4: … ownership set, the mail still sent");
      assertTrue(logged.some((l) => l.includes("[gardssalg-claim-crm-archive] welcome mail for provider prov-o34-fail not filed")), "c5: … and the failure is logged");

      // ── (c) the magic-link copy never holds the link ────────────────────
      const { renderGardssalgClaimMagicLink } = require("../services/email-service") as typeof import("../services/email-service");
      const filed = archiveMod.archiveGardssalgClaimMail({
        kind: "magic_link",
        providerId: "prov-o34-get",
        claimId: "gsc_o34_g2",
        to: "eier-get@example.test",
        rendered: renderGardssalgClaimMagicLink("Øvre Æble & Sønn", archiveMod.GARDSSALG_CLAIM_CRM_LINK_PLACEHOLDER),
        sendResult: { success: true, messageId: "<stub-o34-ml@test>" },
      });
      const leaky = archiveMod.archiveGardssalgClaimMail({
        kind: "magic_link",
        providerId: "prov-o34-get",
        to: "eier-get@example.test",
        rendered: { subject: "s", textContent: `x https://opplevagent.no${VERIFY}?token=${G2} y`, htmlContent: `<a href="${VERIFY}?token=${G2}">` },
        sendResult: { success: true, messageId: "<stub-o34-leak@test>" },
      });
      const all = crmRows("prov-o34-get");
      assertEq([filed, leaky, all.length], [true, true, 3], "c6: magic-link copies filed in the same producer thread");
      assertTrue(all[1].body_text.includes(archiveMod.GARDSSALG_CLAIM_CRM_LINK_PLACEHOLDER), "c7: … the magic-link copy carries the placeholder");
      assertTrue(!all.some((r) => TOKENS.some((t) => String(r.body_text).includes(t) || String(r.body_html).includes(t))), "c8: … no token in any CRM copy (safety net masks token=)");
      const skipped = [
        archiveMod.archiveGardssalgClaimMail({ kind: "welcome", providerId: "prov-o34-get", to: "x@example.test", rendered: { subject: "s", textContent: "t", htmlContent: "h" }, sendResult: { success: true, messageId: "DRY_RUN" } }),
        archiveMod.archiveGardssalgClaimMail({ kind: "welcome", providerId: "prov-o34-get", to: "x@example.test", rendered: { subject: "s", textContent: "t", htmlContent: "h" }, sendResult: { success: false } }),
        archiveMod.archiveGardssalgClaimMail({ kind: "welcome", providerId: "prov-o34-get", to: "x@example.test", isTest: true, rendered: { subject: "s", textContent: "t", htmlContent: "h" }, sendResult: { success: true, messageId: "<t@x>" } }),
      ];
      assertEq(skipped, [false, false, false], "c9: a dry-run, failed or test send is not filed");

      // ── (l) logs ────────────────────────────────────────────────────────
      const allLogs = logged.join("\n");
      assertTrue(!TOKENS.some((t) => allLogs.includes(t)) && !allLogs.includes("token=") && !allLogs.includes("/kategori/gardssalg/eier/"),
        "l1: no token or link in any log line");
    } catch (err: any) {
      failed++;
      failures.push("gardssalg-claim-welcome-o3-4: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      Object.assign(console, origConsole);
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      archiveMod.__setGardssalgClaimCrmIngestForTesting(null);
      emailSvc.isConfigured = origConfigured;
      emailSvc.transporter = origTransporter;
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* ignore */ }
      restoreModuleCache();
      restoreMainDb();
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runGardssalgClaimWelcomeO34Tests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      for (const f of r.failures) console.log(f);
      process.exit(1);
    }
  });
}
