/**
 * gardssalg-self-register.test.ts — HTTP-level tests for the gårdssalg
 * self-registration form (dev-request 2026-11-01-opplevagent-drikkeprodusent-
 * selvregistrering, skive 1: AC1–AC5).
 *
 * The real experiences-seo router (which mounts routes/gardssalg-self-
 * register.ts) runs on a real http.Server and is driven with raw
 * http.request(), the same harness as routes/gardssalg-claim.test.ts — never
 * global fetch, which tests/test.ts replaces for some blocks. Brreg is
 * mocked: the service's brregLookup dependency calls the REAL
 * lookupBrregEnhet() (brreg-client.ts) with a stub fetch, so the response
 * parsing is exercised too. The blocklist, write-pause and RFB-agent
 * dependencies are stubbed through __setSelfRegisterDepsForTesting so this
 * suite never touches the shared RFB database singleton; d1 pins that the
 * production defaults are the real RFB functions.
 *
 * Covers:
 *   AC1 flag off: /for-tilbydere/finn without hits has no registration link;
 *       GET and POST /for-tilbydere/registrer are 404 and write nothing.
 *   AC2 flag on: the no-hit page shows «Finner du ikke bedriften? Registrer
 *       den» next to the contact address; the form is noindex; the same
 *       org.nr (visible, hidden, merged → visible, merged → hidden) never
 *       creates a row: claimable → 303 to /kategori/gardssalg/eier/<slug>,
 *       hidden → «finnes skjult» page + trail row; Brreg is not even called.
 *   AC3 Brreg gate: not found, konkurs, deleted (410), wrong NACE (47.x),
 *       name mismatch → rejected, no row; Brreg down → 202, no provider row,
 *       a 'brreg_unavailable' registration row only.
 *   AC4 blocklist (name / e-mail), code / internal-note / theme-spam
 *       description, honeypot, write pause, same-origin guard (Origin: null
 *       allowed, foreign Origin and Sec-Fetch-Site cross-site refused), and
 *       the IP limiter (11th POST in the hour → 429).
 *   AC5 a valid submission creates exactly one hidden row with
 *       catalog_hidden_reason='self_registered_pending_review',
 *       origin='self_registered', Brreg fields (not the submitter's), no
 *       epost, booking_live=0; the submitter's data sits in
 *       gardssalg_self_registrations only; the row is on no public surface
 *       (gardssalgVisibleSql for every surface, /for-tilbydere/finn, search,
 *       MCP/A2A search, sitemap, produsent page lookup); ownerBookingEnable-
 *       Block refuses it. «Er dette deg?» (name+kommune, RFB org.nr) and the
 *       confirm-and-continue path with possible_duplicate_of.
 *
 * Exported runGardssalgSelfRegisterTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/gardssalg-self-register.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type BrregFixture =
  | { status: 404 }
  | { status: 410 }
  | { status: "throw" }
  | { status: 200; body: Record<string, unknown> };

function enhet(orgNr: string, navn: string, nace: string, extra: Record<string, unknown> = {}): BrregFixture {
  return {
    status: 200,
    body: {
      organisasjonsnummer: orgNr,
      navn,
      organisasjonsform: { kode: "AS" },
      naeringskode1: { kode: nace, beskrivelse: "test" },
      konkurs: false,
      underAvvikling: false,
      underTvangsavviklingEllerTvangsopplosning: false,
      forretningsadresse: {
        adresse: ["Gardsvegen 1"],
        postnummer: "6887",
        poststed: "LÆRDAL",
        kommune: "LÆRDAL",
        kommunenummer: "4642",
        land: "Norge",
        landkode: "NO",
      },
      ...extra,
    },
  };
}

/** The client address this suite's requests are counted under (TEST-NET-1,
 *  never a real client). */
const TEST_CLIENT_IP = "192.0.2.77";

export function runGardssalgSelfRegisterTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevFlag = process.env.GARDSSALG_SELF_REGISTER_ENABLED;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env.GARDSSALG_SELF_REGISTER_ENABLED;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const seoPath = require.resolve("./experiences-seo");
    const routePath = require.resolve("./gardssalg-self-register");
    const svcPath = require.resolve("../services/gardssalg-self-register");
    const claimSvcPath = require.resolve("../services/gardssalg-claim");
    const claimRoutePath = require.resolve("./gardssalg-claim");
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache"))
      .swapOutModules([dbFactoryPath, expStorePath, seoPath, routePath, svcPath, claimSvcPath, claimRoutePath]);
    const emailSvcMod = require("../services/email-service") as typeof import("../services/email-service");
    const origSendConfirm = emailSvcMod.emailService.sendGardssalgSelfRegisterConfirmLink;
    const sends: Array<{ to: string; providerName: string; confirmUrl: string; validHours: number }> = [];
    (emailSvcMod.emailService as any).sendGardssalgSelfRegisterConfirmLink = async (o: { to: string; providerName: string; confirmUrl: string; validHours: number }) => {
      sends.push({ ...o });
      return { success: true, messageId: "stub" };
    };

    let server: any = null;
    let svc: typeof import("../services/gardssalg-self-register") | null = null;
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      svc = require("../services/gardssalg-self-register") as typeof import("../services/gardssalg-self-register");
      const brregClient = require("../services/brreg-client") as typeof import("../services/brreg-client");
      const blocklist = require("../services/blocklist-service") as typeof import("../services/blocklist-service");
      const { gardssalgVisibleSql, GARDSSALG_SURFACES } = require("../services/gardssalg-visibility") as typeof import("../services/gardssalg-visibility");
      const { ownerBookingEnableBlock } = require("../services/gardssalg-booking-gate") as typeof import("../services/gardssalg-booking-gate");
      const { gardssalgSelfRegisterLimiter } = require("../middleware/security") as typeof import("../middleware/security");
      const { ac2LimitersFor } = require("../middleware/client-ip") as typeof import("../middleware/client-ip");

      // ── d: production defaults are RFB's own functions ──────────────────
      assertTrue(svc.defaultSelfRegisterDeps.isBlocked === blocklist.isBlocked,
        "d1: the default blocklist check IS blocklist-service.isBlocked (RFB's, not a copy)");
      assertTrue(ac2LimitersFor("/for-tilbydere/registrer").includes("general"),
        "d2: ac2LimitersFor counts /for-tilbydere/registrer against generalLimiter");
      assertEq(svc.isGardssalgSelfRegisterEnabled({}), false, "d3: the flag defaults to OFF");
      assertEq(svc.isGardssalgSelfRegisterEnabled({ GARDSSALG_SELF_REGISTER_ENABLED: "true" }), true, "d4: 'true' turns the flag on");

      // ── Fixtures ───────────────────────────────────────────────────────
      const ins = db.prepare(`
        INSERT INTO experience_providers
          (id, org_nr, navn, slug, kommune, poststed, producer_type, catalog_hidden, merged_into, brreg_verified, source)
        VALUES (@id, @org_nr, @navn, @slug, @kommune, @poststed, @producer_type, @catalog_hidden, @merged_into, 1, 'test-fixture')
      `);
      const base = { kommune: null, poststed: null, producer_type: "bryggeri", catalog_hidden: 0, merged_into: null };
      ins.run({ ...base, id: "sr-visible", org_nr: "911000001", navn: "Synlig Bryggeri", slug: "synlig-bryggeri" });
      ins.run({ ...base, id: "sr-hidden", org_nr: "911000002", navn: "Skjult Bryggeri", slug: "skjult-bryggeri", catalog_hidden: 1 });
      ins.run({ ...base, id: "sr-merged-vis", org_nr: "911000003", navn: "Gammel Dublett", slug: "gammel-dublett", merged_into: "sr-visible" });
      ins.run({ ...base, id: "sr-merged-hid", org_nr: "911000004", navn: "Gammel Skjult", slug: "gammel-skjult", merged_into: "sr-hidden" });
      ins.run({ ...base, id: "sr-namesake", org_nr: "911000005", navn: "Duplikat Sideri", slug: "duplikat-sideri", kommune: "Voss", poststed: "Voss", producer_type: "sideri" });
      const countProviders = () => (db.prepare("SELECT COUNT(*) AS n FROM experience_providers").get() as { n: number }).n;
      const countRegs = () => (db.prepare("SELECT COUNT(*) AS n FROM gardssalg_self_registrations").get() as { n: number }).n;

      // ── Brreg mock (real lookupBrregEnhet, stub fetch) ─────────────────
      const brregFixtures: Record<string, BrregFixture> = {
        "900000001": enhet("900000001", "TESTVIN GÅRD AS", "11.020"),
        "900000002": enhet("900000002", "KONKURS SIDERI AS", "11.030", { konkurs: true }),
        "900000003": enhet("900000003", "BUTIKKEN AS", "47.250"),
        "900000004": enhet("900000004", "HELT ANNET NAVN AS", "11.050"),
        "900000005": { status: 404 },
        "900000006": { status: "throw" },
        "900000007": enhet("900000007", "DUPLIKAT SIDERI AS", "11.030", {
          forretningsadresse: { adresse: ["Vossevegen 2"], postnummer: "5700", poststed: "VOSS", kommune: "VOSS", kommunenummer: "4621" },
        }),
        "900000008": enhet("900000008", "RFB MOSTERI AS", "10.320"),
        "900000009": { status: 410 },
        "900000010": enhet("900000010", "AVVIKLING BRYGG AS", "11.050", { underAvvikling: true }),
        "900000011": enhet("900000011", "SPERRET GÅRD AS", "11.020"),
        "900000012": enhet("900000012", "ORIGIN NULL GÅRD AS", "01.210"),
        "900000013": enhet("900000013", "GJETT IKKE GÅRD AS", "11.020"),
      };
      const brregCalls: string[] = [];
      const stubFetch = (async (input: unknown) => {
        const url = String(input);
        const orgNr = url.split("/").pop() || "";
        brregCalls.push(orgNr);
        const f = brregFixtures[orgNr] ?? { status: 404 };
        if (f.status === "throw") throw new Error("ETIMEDOUT (stub)");
        return {
          ok: f.status === 200,
          status: f.status,
          json: async () => (f.status === 200 ? (f as { body: unknown }).body : {}),
        } as unknown as Response;
      }) as unknown as typeof fetch;

      let pauseOn = false;
      const blockedCalls: Array<Record<string, unknown>> = [];
      svc.__setSelfRegisterDepsForTesting({
        brregLookup: (orgNr) => brregClient.lookupBrregEnhet(orgNr, stubFetch, 1000),
        isBlocked: ((o: { name?: string; email?: string; website?: string; orgNr?: string }) => {
          blockedCalls.push({ ...o });
          const name = String(o.name || "").toLowerCase();
          if (name.startsWith("sperret gård")) return { blocked: true, matchedBy: "name_normalized" as const, matchedValue: "sperret gard" };
          if (o.email === "spam@sperret.no") return { blocked: true, matchedBy: "email" as const, matchedValue: "spam@sperret.no" };
          return { blocked: false };
        }) as any,
        writePauseBlock: () => (pauseOn
          ? { error: "pause", paused: true, vertical: "experiences", reason: "x", triggered_at: null, fail_closed: false }
          : null),
        findRfbAgentByOrgNr: (orgNr) => (orgNr === "900000008" ? { agentId: "agent-rfb-1" } : null),
      });

      // ── HTTP harness ───────────────────────────────────────────────────
      const seo = require("./experiences-seo") as typeof import("./experiences-seo");
      const expressMod = require("express") as typeof import("express");
      const app = expressMod();
      // Every request below carries X-Forwarded-For: TEST_CLIENT_IP and the
      // app trusts it, so this suite's requests are counted under their own
      // key in the SHARED generalLimiter (and in gardssalgSelfRegisterLimiter)
      // instead of eating into 127.0.0.1's quota that the other route suites
      // in this process share. Both keys are reset in `finally`.
      app.set("trust proxy", true);
      // The ordinary owner-claim router (ahead of experiences-seo's catch-all
      // 404, as index.ts mounts it), so the draft session can be shown to be
      // refused there (portal JSON, pause/resume, magic-link-verify).
      app.use("/", (require("./gardssalg-claim") as any).default);
      app.use("/", (seo as any).default);
      const httpMod = require("http") as typeof import("http");
      server = httpMod.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;

      function req(method: string, urlPath: string, o: { headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: any; body: string }> {
        return new Promise((resolve, reject) => {
          const headers = { "X-Forwarded-For": TEST_CLIENT_IP, ...(o.headers || {}) };
          const r = httpMod.request({ method, host: "127.0.0.1", port, path: urlPath, headers }, (resp) => {
            const chunks: Buffer[] = [];
            resp.on("data", (c) => chunks.push(c as Buffer));
            resp.on("end", () => resolve({ status: resp.statusCode || 0, headers: resp.headers, body: Buffer.concat(chunks).toString("utf8") }));
          });
          r.on("error", reject);
          if (o.body) r.write(o.body);
          r.end();
        });
      }
      const resetIpLimit = () => { try { (gardssalgSelfRegisterLimiter as any).resetKey(TEST_CLIENT_IP); } catch { /* ignore */ } };
      function form(fields: Record<string, string>): string {
        return new URLSearchParams(fields).toString();
      }
      const valid = (over: Record<string, string> = {}): Record<string, string> => ({
        org_nr: "900000001",
        company_name: "Testvin Gård",
        place: "lerdal",
        producer_type: "vin",
        description: "Liten vingård med gårdssalg om sommeren.",
        website: "",
        submitter_name: "Kari Nordmann",
        email: "kari@testvin.no",
        phone: "+47 900 00 000",
        ...over,
      });
      function post(fields: Record<string, string>, headers: Record<string, string> = {}) {
        resetIpLimit();
        return req("POST", "/for-tilbydere/registrer", {
          headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "null", ...headers },
          body: form(fields),
        });
      }

      // ── AC1: flag OFF ──────────────────────────────────────────────────
      {
        const finnOff = await req("GET", "/for-tilbydere/finn?q=finnesikke");
        assertEq(finnOff.status, 200, "ac1-1: /for-tilbydere/finn without hits renders 200 with the flag off");
        assertTrue(finnOff.body.includes("kontakt@opplevagent.no"), "ac1-2: flag off — the no-hit page keeps the contact address");
        assertTrue(!finnOff.body.includes("/for-tilbydere/registrer") && !finnOff.body.includes("Registrer den"),
          "ac1-3: flag off — no registration link on the no-hit page (as today)");
        const getOff = await req("GET", "/for-tilbydere/registrer");
        assertEq(getOff.status, 404, "ac1-4: flag off — GET /for-tilbydere/registrer is 404");
        assertTrue(getOff.body.includes("Siden finnes ikke"), "ac1-5: flag off — the 404 is experiences-seo's ordinary 404 page");
        const before = countProviders();
        const postOff = await post(valid());
        assertEq(postOff.status, 404, "ac1-6: flag off — POST /for-tilbydere/registrer is 404");
        assertEq(countProviders(), before, "ac1-7: flag off — the POST created no provider row");
        assertEq(countRegs(), 0, "ac1-8: flag off — the POST stored no registration");
        assertEq(brregCalls.length, 0, "ac1-9: flag off — Brreg was never called");
      }

      process.env.GARDSSALG_SELF_REGISTER_ENABLED = "true";

      // ── AC2: link, form, same org.nr → no new row ──────────────────────
      {
        const finnOn = await req("GET", "/for-tilbydere/finn?q=finnesikke");
        assertTrue(finnOn.body.includes("Finner du ikke bedriften?") && finnOn.body.includes('href="/for-tilbydere/registrer?navn=finnesikke"'),
          "ac2-1: flag on — the no-hit page links «Finner du ikke bedriften? Registrer den» to the form");
        assertTrue(finnOn.body.includes("Registrer den"), "ac2-2: flag on — the link text is «Registrer den»");
        assertTrue(finnOn.body.includes("mailto:kontakt@opplevagent.no"), "ac2-3: flag on — the contact address stays as well");
        const finnHit = await req("GET", "/for-tilbydere/finn?q=Synlig");
        assertTrue(finnHit.body.includes("Synlig Bryggeri") && !finnHit.body.includes("Registrer den"),
          "ac2-4: a search WITH hits shows no registration link");

        const formPage = await req("GET", "/for-tilbydere/registrer?navn=Testvin");
        assertEq(formPage.status, 200, "ac2-5: flag on — GET /for-tilbydere/registrer is 200");
        assertTrue(formPage.body.includes('<meta name="robots" content="noindex, nofollow">'), "ac2-6: the form page is noindex,nofollow");
        assertEq(formPage.headers["x-robots-tag"], "noindex, nofollow", "ac2-7: the form page sends X-Robots-Tag noindex");
        assertTrue(formPage.body.includes('name="org_nr"') && formPage.body.includes('name="submitter_name"') && formPage.body.includes('name="producer_type"'),
          "ac2-8: the form has org.nr, submitter name and producer type fields");
        assertTrue(formPage.body.includes('name="_honey"'), "ac2-9: the form carries the honeypot field");
        assertTrue(formPage.body.includes('value="Testvin"'), "ac2-10: ?navn= prefills the company name");
        assertTrue(!formPage.body.includes("<link rel=\"canonical\""), "ac2-11: the noindex form page has no canonical");

        const robots = await req("GET", "/robots.txt");
        const groups = (robots.body.match(/User-agent: /g) || []).length;
        assertTrue(groups > 0 && (robots.body.match(/Disallow: \/for-tilbydere\/registrer\n/g) || []).length === groups,
          "ac2-12: robots.txt Disallows /for-tilbydere/registrer in every user-agent group, like the claim paths");

        const before = countProviders();
        const visible = await post(valid({ org_nr: "911000001", company_name: "Synlig Bryggeri" }));
        assertEq(visible.status, 303, "ac2-13: same org.nr as a visible profile → 303");
        assertEq(visible.headers.location, "/kategori/gardssalg/eier/synlig-bryggeri", "ac2-14: … to the claim page of that profile");
        const spaced = await post(valid({ org_nr: "911 000 001", company_name: "Synlig Bryggeri" }));
        assertEq(spaced.headers.location, "/kategori/gardssalg/eier/synlig-bryggeri", "ac2-15: an org.nr typed with spaces matches too");
        const mergedVis = await post(valid({ org_nr: "911000003", company_name: "Gammel Dublett" }));
        assertEq(mergedVis.headers.location, "/kategori/gardssalg/eier/synlig-bryggeri", "ac2-16: org.nr of a merged row → merged_into is followed to the visible target");
        const hidden = await post(valid({ org_nr: "911000002", company_name: "Skjult Bryggeri" }));
        assertEq(hidden.status, 200, "ac2-17: same org.nr as a hidden profile → 200 page, no redirect");
        assertTrue(hidden.body.includes('data-outcome="existing_hidden"') && hidden.body.includes("manuell vurdering"),
          "ac2-18: … telling the visitor the business exists and goes to manual review");
        assertTrue(!hidden.body.includes("Skjult Bryggeri</") && !hidden.body.includes("skjult-bryggeri"), "ac2-19: … without revealing the hidden profile's slug");
        const mergedHid = await post(valid({ org_nr: "911000004", company_name: "Gammel Skjult" }));
        assertTrue(mergedHid.body.includes('data-outcome="existing_hidden"'), "ac2-20: org.nr of a row merged into a hidden one → «finnes skjult»");
        assertEq(countProviders(), before, "ac2-21: no org.nr hit created a provider row");
        const trail = db.prepare("SELECT status, provider_id, submitter_email FROM gardssalg_self_registrations WHERE org_nr = '911000002'").all() as any[];
        assertEq(trail.map((t) => [t.status, t.provider_id, t.submitter_email]), [["exists_hidden", "sr-hidden", "kari@testvin.no"]],
          "ac2-22: the hidden hit left one minimal trail row (status exists_hidden, the target id)");
        const trail2 = db.prepare("SELECT provider_id FROM gardssalg_self_registrations WHERE org_nr = '911000004'").get() as any;
        assertEq(trail2?.provider_id, "sr-hidden", "ac2-23: the trail for a merged org.nr points at the merge target");
        assertEq(brregCalls.length, 0, "ac2-24: no org.nr hit called Brreg (the duplicate check runs first)");
      }

      // ── AC3: Brreg gate ────────────────────────────────────────────────
      {
        const before = countProviders();
        const cases: Array<[string, string, string, string]> = [
          ["900000005", "Finnes Ikke", "not_found", "ac3-1: org.nr not in Brreg (404)"],
          ["900000002", "Konkurs Sideri", "inactive", "ac3-2: konkurs"],
          ["900000009", "Slettet Gård", "inactive", "ac3-3: deleted unit (410 Gone)"],
          ["900000010", "Avvikling Brygg", "inactive", "ac3-4: under avvikling"],
          ["900000003", "Butikken", "wrong_nace", "ac3-5: wrong NACE (47.250 retail)"],
          ["900000004", "Testbryggeri", "name_mismatch", "ac3-6: name does not match the Brreg name"],
        ];
        for (const [orgNr, name, reason, label] of cases) {
          const r = await post(valid({ org_nr: orgNr, company_name: name }));
          assertTrue(r.status === 422 && r.body.includes(`data-reason="${reason}"`), `${label} → rejected (${reason}, 422; got ${r.status})`);
          assertTrue(r.body.includes("Ingen profil er laget") && r.body.includes("kontakt@opplevagent.no"), `${label} → friendly message + contact address`);
        }
        assertEq(countProviders(), before, "ac3-7: no rejected submission created a provider row");
        assertEq((db.prepare("SELECT COUNT(*) AS n FROM gardssalg_self_registrations WHERE org_nr LIKE '90000000%' AND org_nr NOT IN ('900000006')").get() as any).n, 0,
          "ac3-8: no rejected submission stored a registration row");

        const down = await post(valid({ org_nr: "900000006", company_name: "Nede Gård" }));
        assertEq(down.status, 202, "ac3-9: Brreg down / timeout → 202 «mottatt»");
        assertTrue(down.body.includes('data-outcome="brreg_unavailable"') && down.body.includes("ingen profil er laget"),
          "ac3-10: … saying Brreg could not be checked and no profile was made");
        assertEq(countProviders(), before, "ac3-11: Brreg down → NO provider row (nothing can be published)");
        const queued = db.prepare("SELECT status, provider_id, brreg_status, submitter_email FROM gardssalg_self_registrations WHERE org_nr = '900000006'").all() as any[];
        assertEq(queued.map((q) => [q.status, q.provider_id, q.brreg_status, q.submitter_email]), [["brreg_unavailable", null, "unavailable", "kari@testvin.no"]],
          "ac3-12: Brreg down → one registration row in the review queue (brreg_unavailable, no provider)");
        await post(valid({ org_nr: "900000006", company_name: "Nede Gård" }));
        assertEq((db.prepare("SELECT COUNT(*) AS n FROM gardssalg_self_registrations WHERE org_nr = '900000006'").get() as any).n, 1,
          "ac3-13: a resubmission while Brreg is down does not stack a second queue row");
      }

      // ── AC4: filters, honeypot, pause, same-origin, IP limit ───────────
      {
        const before = countProviders();
        const regsBefore = countRegs();
        const blockedName = await post(valid({ org_nr: "900000011", company_name: "Sperret Gård" }));
        assertEq(blockedName.status, 403, "ac4-1: blocklisted name → 403");
        assertTrue(blockedName.body.includes('data-outcome="blocked"') && !blockedName.body.toLowerCase().includes("sperreliste"),
          "ac4-2: … refused without saying why (as RFB's /register)");
        const blockedEmail = await post(valid({ email: "spam@sperret.no" }));
        assertEq(blockedEmail.status, 403, "ac4-3: blocklisted e-mail → 403");
        const lastCall = blockedCalls[blockedCalls.length - 1] || {};
        assertEq([lastCall.email, lastCall.orgNr], ["spam@sperret.no", "900000001"], "ac4-4: isBlocked gets the e-mail and the org.nr");
        await post(valid({ website: "https://testvin.no" }));
        assertTrue(blockedCalls.some((c) => c.website === "https://testvin.no" && c.name === "Testvin Gård"),
          "ac4-5: isBlocked gets the typed name and website");
        // That last post was valid → it created the row; remove it again for the counts below.
        db.prepare("DELETE FROM gardssalg_self_registrations WHERE org_nr = '900000001'").run();
        db.prepare("DELETE FROM experience_providers WHERE org_nr = '900000001'").run();

        const code = await post(valid({ description: "Vi lager sider. <script>alert(1)</script> function(){ var x = document.getElementById('a'); }" }));
        assertTrue(code.status === 400 && code.body.includes('data-outcome="content_rejected"'), `ac4-6: code artifact in the description → rejected (got ${code.status})`);
        const note = await post(valid({ description: "Vi lager sider. Kontakten er ikke verifisert." }));
        assertTrue(note.status === 400 && note.body.includes('data-outcome="content_rejected"'), "ac4-7: internal note in the description → rejected");
        const spam = await post(valid({ description: "Best online casino bonus, free spins og slots. Spill casino nå!" }));
        assertTrue(spam.status === 400 && spam.body.includes('data-outcome="content_rejected"'), "ac4-8: theme spam in the description → rejected");

        const honey = await post({ ...valid(), _honey: "http://spam.example" });
        assertTrue(honey.status === 400 && honey.body.includes('data-outcome="honeypot"'), "ac4-9: honeypot filled → 400, dropped");

        pauseOn = true;
        const paused = await post(valid());
        pauseOn = false;
        assertTrue(paused.status === 423 && paused.body.includes('data-outcome="paused"'), "ac4-10: experiences write pause → 423, nothing written");

        const foreign = await post(valid(), { Origin: "https://evil.example" });
        assertEq(foreign.status, 403, "ac4-11: a foreign Origin → 403 (shared same-origin write guard)");
        assertTrue(foreign.body.includes("Endringen ble ikke lagret"), "ac4-12: … with the shared refusal page");
        const crossSite = await post(valid(), { "Sec-Fetch-Site": "cross-site" });
        assertEq(crossSite.status, 403, "ac4-13: Sec-Fetch-Site: cross-site → 403");
        const invalid = await post(valid({ org_nr: "12345", email: "ikke-en-epost" }));
        assertTrue(invalid.status === 400 && invalid.body.includes('data-outcome="invalid"') && invalid.body.includes("9 siffer"),
          "ac4-14: invalid org.nr / e-mail → 400, the form again with the errors");
        assertTrue(invalid.body.includes('value="Kari Nordmann"'), "ac4-15: … keeping what was typed");
        assertEq(countProviders(), before, "ac4-16: none of the refused submissions created a provider row");
        assertEq(countRegs(), regsBefore, "ac4-17: none of the refused submissions stored a registration row");

        // IP limit: 10 an hour, the 11th is refused before the body is read.
        resetIpLimit();
        const statuses: number[] = [];
        for (let i = 0; i < 11; i++) {
          const r = await req("POST", "/for-tilbydere/registrer", {
            headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "null" },
            body: form({ org_nr: "x" }),
          });
          statuses.push(r.status);
        }
        assertEq(statuses.slice(0, 10).every((s) => s === 400), true, "ac4-18: the first 10 POSTs in the hour reach the form (400 invalid here)");
        assertEq(statuses[10], 429, "ac4-19: the 11th POST from the same IP → 429 (gardssalgSelfRegisterLimiter)");
        resetIpLimit();
      }

      // ── AC5: a valid submission → one hidden row, on no public surface ─
      let createdId = "";
      let createdSlug = "";
      {
        const before = countProviders();
        // Origin: null is what a plain form POST sends under Referrer-Policy:
        // no-referrer — it must be accepted (post() sends it by default).
        const ok = await post(valid());
        assertEq(ok.status, 200, "ac5-1: a valid submission (Origin: null) → 200");
        assertTrue(ok.body.includes('data-outcome="created"') && ok.body.includes("Registreringen er mottatt") && ok.body.includes("vurderes nå manuelt"),
          "ac5-2: the receipt says the registration is received and will be reviewed manually");
        assertEq(countProviders(), before + 1, "ac5-3: exactly one provider row was created");
        const row = db.prepare("SELECT * FROM experience_providers WHERE org_nr = '900000001'").get() as any;
        createdId = row?.id ?? "";
        createdSlug = row?.slug ?? "";
        assertEq([row?.catalog_hidden, row?.catalog_hidden_reason, row?.origin, row?.source],
          [1, "self_registered_pending_review", "self_registered", "self_registered"],
          "ac5-4: catalog_hidden=1, reason self_registered_pending_review, origin + source self_registered");
        assertEq([row?.navn, row?.kommune, row?.poststed, row?.adresse, row?.postnummer, row?.naeringskode, row?.organisasjonsform, row?.kommunenummer],
          ["Testvin Gård", "Lærdal", "Lærdal", "Gardsvegen 1", "6887", "11.020", "AS", "4642"],
          "ac5-5: the profile fields come from Brreg (not the typed place «lerdal»)");
        assertEq([row?.brreg_verified, row?.brreg_active, typeof row?.brreg_checked_at === "string" && row.brreg_checked_at.length > 0],
          [1, 1, true], "ac5-6: brreg_verified=1, brreg_active=1, brreg_checked_at set");
        assertEq([row?.epost, row?.telefon, row?.hjemmeside], [null, null, null], "ac5-7: no e-mail / phone / website on the profile (never guessed)");
        assertEq(row?.booking_live, 0, "ac5-8: booking is off");
        assertEq(row?.producer_type, "vingård", "ac5-9: producer_type from Brreg's NACE (11.020 → vingård)");
        assertEq(row?.possible_duplicate_of, null, "ac5-10: no duplicate marker without a duplicate");
        assertTrue(typeof createdSlug === "string" && createdSlug.startsWith("testvin-gard--"), "ac5-11: the row has a slug (same format as backfillProviderSlugs)");
        const reg = db.prepare("SELECT * FROM gardssalg_self_registrations WHERE provider_id = ?").get(createdId) as any;
        assertEq([reg?.status, reg?.submitter_name, reg?.submitter_email, reg?.submitter_email_source, reg?.submitter_phone, reg?.brreg_status, reg?.description],
          ["pending_review", "Kari Nordmann", "kari@testvin.no", "self_registered", "+47 900 00 000", "verified", "Liten vingård med gårdssalg om sommeren."],
          "ac5-12: the submitter's name / e-mail / phone sit in gardssalg_self_registrations (provenance self_registered)");
        assertEq((db.prepare("SELECT COUNT(*) AS n FROM experience_providers WHERE lower(epost) = 'kari@testvin.no'").get() as any).n, 0,
          "ac5-13: the submitter's e-mail is on no experience_providers row");

        for (const surface of GARDSSALG_SURFACES) {
          const n = (db.prepare(`SELECT COUNT(*) AS n FROM experience_providers WHERE id = ? AND ${gardssalgVisibleSql(surface)}`).get(createdId) as any).n;
          assertEq(n, 0, `ac5-14: gardssalgVisibleSql('${surface}') excludes the pending row`);
        }
        assertEq(store.searchGardssalgProvidersByQuery("Testvin", 30).length, 0, "ac5-15: free-text search (/sok, /for-tilbydere/finn) does not find it");
        assertTrue(!store.searchGardssalgProviders({}, 100, { surface: "mcp" }).some((p: any) => p.id === createdId), "ac5-16: MCP discover_gardssalg search does not list it");
        assertTrue(!store.searchGardssalgProviders({}, 100, { surface: "a2a" }).some((p: any) => p.id === createdId), "ac5-17: A2A gardssalg_discover search does not list it");
        assertEq(store.getGardssalgProviderBySlug(createdSlug), null, "ac5-18: the public produsent page lookup does not find it");
        const finn = await req("GET", "/for-tilbydere/finn?q=Testvin");
        assertTrue(!finn.body.includes(createdSlug) && finn.body.includes("Ingen treff"), "ac5-19: /for-tilbydere/finn does not list it");
        const sitemap = await req("GET", "/sitemap.xml");
        assertTrue(sitemap.status === 200 && !sitemap.body.includes(createdSlug), "ac5-20: sitemap.xml does not list it");
        const produsent = await req("GET", `/kategori/gardssalg/produsent/${createdSlug}`);
        assertTrue(produsent.status === 404 && !produsent.body.includes("Testvin Gård"), `ac5-21: GET /kategori/gardssalg/produsent/<slug> is 404 (got ${produsent.status})`);

        const block = ownerBookingEnableBlock(row);
        assertEq(block?.reason, "pending_review", "ac5-22: ownerBookingEnableBlock refuses booking for the pending row");
        const withEmail = ownerBookingEnableBlock({ ...row, epost: "post@testvin.no" });
        assertEq(withEmail?.reason, "pending_review", "ac5-23: … even once the row has an e-mail address");
        assertEq(ownerBookingEnableBlock({ epost: "post@x.no", booking_admin_brake_at: null, booking_admin_brake_note: null }), null,
          "ac5-24: rows without the pending reason are unchanged (an e-mail still allows booking)");

        const again = await post(valid());
        assertTrue(again.body.includes('data-outcome="existing_hidden"'), "ac5-25: submitting the same org.nr again → «finnes skjult», no second row");
        assertEq(countProviders(), before + 1, "ac5-26: still exactly one new provider row");
      }

      // ── «Er dette deg?» (duplicate checks 2 and 3) ─────────────────────
      {
        const before = countProviders();
        const nk = await post(valid({ org_nr: "900000007", company_name: "Duplikat Sideri", place: "Voss", producer_type: "sider" }));
        assertEq(nk.status, 200, "dup-1: similar name in the same kommune → 200 «Er dette deg?»");
        assertTrue(nk.body.includes('data-outcome="possible_duplicate"') && nk.body.includes('href="/kategori/gardssalg/eier/duplikat-sideri"'),
          "dup-2: … linking to the claim page of the existing profile");
        assertTrue(nk.body.includes('name="confirm_not_duplicate" value="1"') && nk.body.includes('name="org_nr" value="900000007"'),
          "dup-3: … with a separate confirm field that re-posts the form");
        assertEq(countProviders(), before, "dup-4: «Er dette deg?» created no row");
        const nkGo = await post({ ...valid({ org_nr: "900000007", company_name: "Duplikat Sideri", place: "Voss", producer_type: "sider" }), confirm_not_duplicate: "1" });
        assertTrue(nkGo.body.includes('data-outcome="created"'), "dup-5: confirming «not us» creates the row");
        const nkRow = db.prepare("SELECT possible_duplicate_of, catalog_hidden, producer_type FROM experience_providers WHERE org_nr = '900000007'").get() as any;
        assertEq([nkRow?.possible_duplicate_of, nkRow?.catalog_hidden, nkRow?.producer_type], ["sr-namesake", 1, "sideri"],
          "dup-6: … hidden, with possible_duplicate_of = the existing profile (never merged)");
        assertEq((db.prepare("SELECT merged_into FROM experience_providers WHERE id = 'sr-namesake'").get() as any).merged_into, null,
          "dup-7: the existing profile is untouched");

        const rfb = await post(valid({ org_nr: "900000008", company_name: "RFB Mosteri", producer_type: "annet" }));
        assertTrue(rfb.body.includes('data-outcome="possible_duplicate"') && rfb.body.includes("Rett fra Bonden"),
          "dup-8: same org.nr on an RFB agent → «Er dette deg?» naming Rett fra Bonden");
        const rfbGo = await post({ ...valid({ org_nr: "900000008", company_name: "RFB Mosteri", producer_type: "annet" }), confirm_not_duplicate: "1" });
        assertTrue(rfbGo.body.includes('data-outcome="created"'), "dup-9: confirming creates the row");
        const rfbRow = db.prepare("SELECT possible_duplicate_of, producer_type, naeringskode FROM experience_providers WHERE org_nr = '900000008'").get() as any;
        assertEq([rfbRow?.possible_duplicate_of, rfbRow?.producer_type, rfbRow?.naeringskode], ["rfb:agent-rfb-1", "annet", "10.320"],
          "dup-10: possible_duplicate_of = rfb:<agent id>; producer_type falls back to the form choice when the NACE code names none");

        const originNull = await post(valid({ org_nr: "900000012", company_name: "Origin Null Gård" }), { Origin: `http://127.0.0.1:${port}`, "Sec-Fetch-Site": "same-origin" });
        assertTrue(originNull.body.includes('data-outcome="created"'), "dup-11: a same-origin POST (real Origin, Sec-Fetch-Site same-origin) is accepted too");
      }

      // ── Skive 2 ────────────────────────────────────────────────────────
      const claimSvc = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
      const cryptoMod = require("crypto") as typeof import("crypto");
      const provRow = () => db.prepare("SELECT * FROM experience_providers WHERE id = ?").get(createdId) as any;
      const regRow = () => db.prepare("SELECT * FROM gardssalg_self_registrations WHERE provider_id = ?").get(createdId) as any;
      const countClaims = () => (db.prepare("SELECT COUNT(*) AS n FROM gardssalg_claims").get() as { n: number }).n;
      function postForm(urlPath: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
        return req("POST", urlPath, {
          headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "null", ...headers },
          body: form(fields),
        });
      }

      // ── N1: the booking gate sees catalog_hidden_reason on the REAL paths ─
      {
        const viaPortalSelect = claimSvc.getClaimProviderById(createdId);
        assertEq(viaPortalSelect?.catalog_hidden_reason, "self_registered_pending_review",
          "n1-1: getClaimProviderById (the portal's real SELECT) now returns catalog_hidden_reason");
        assertEq(viaPortalSelect ? ownerBookingEnableBlock(viaPortalSelect)?.reason : null, "pending_review",
          "n1-2: ownerBookingEnableBlock on that real row → pending_review");
        db.prepare("UPDATE experience_providers SET epost = 'post@testvin.no' WHERE id = ?").run(createdId);
        const upd = claimSvc.updateClaimedProviderProfile(createdId, { booking_live: 1 });
        assertTrue(!upd.ok && (upd as any).error === "booking_blocked" && (upd as any).block?.reason === "pending_review",
          "n1-3: updateClaimedProviderProfile (real service SELECT) refuses booking for the pending row even with an e-mail address");
        assertEq(provRow()?.booking_live, 0, "n1-4: … and nothing was written (booking_live still 0)");
        db.prepare("UPDATE experience_providers SET epost = NULL WHERE id = ?").run(createdId);
      }

      // ── AC6 / Spec D: the e-mail code ──────────────────────────────────
      let token = "";
      let sessionCookie = "";
      {
        const mine = sends.filter((x) => x.providerName === "Testvin Gård");
        const last = mine[mine.length - 1];
        assertEq(last?.to, "kari@testvin.no", "ac6-1: a valid submission sends the confirm link to the typed address");
        const m = /^https:\/\/opplevagent\.no\/for-tilbydere\/registrer\/bekreft\?t=([0-9a-f]{64})$/.exec(last?.confirmUrl || "");
        assertTrue(!!m, `ac6-2: the link is ${"<base>"}/for-tilbydere/registrer/bekreft?t=<64 hex> (got ${last?.confirmUrl})`);
        token = m ? m[1] : "";
        const reg = regRow();
        assertEq(reg?.email_code_hash, cryptoMod.createHash("sha256").update(token).digest("hex"),
          "ac6-3: only the SHA-256 of the token is stored");
        assertTrue(!JSON.stringify(reg).includes(token), "ac6-4: the raw token is nowhere on the registration row");
        const hrs = (Date.parse(reg?.email_code_expires_at) - Date.now()) / 3600000;
        assertTrue(hrs > 47 && hrs <= 48, `ac6-5: the code expires in 48 h (got ${hrs.toFixed(2)})`);

        // GET changes nothing.
        const snapReg = JSON.stringify(regRow());
        const snapProv = JSON.stringify(provRow());
        const claimsBefore = countClaims();
        const g = await req("GET", `/for-tilbydere/registrer/bekreft?t=${token}`);
        assertEq(g.status, 200, "ac6-6: GET on the confirm link → 200");
        assertTrue(g.body.includes('method="post" action="/for-tilbydere/registrer/bekreft"') && g.body.includes(`name="t" value="${token}"`),
          "ac6-7: … a page whose button POSTs the token");
        assertTrue(g.body.includes('<meta name="robots" content="noindex, nofollow">'), "ac6-8: the confirm page is noindex");
        assertEq(g.headers["set-cookie"], undefined, "ac6-9: GET sets no cookie");
        assertEq([JSON.stringify(regRow()), JSON.stringify(provRow()), countClaims()], [snapReg, snapProv, claimsBefore],
          "ac6-10: GET on the confirm link changed nothing (registration, provider, claims)");
        const g2 = await req("HEAD", `/for-tilbydere/registrer/bekreft?t=${token}`);
        assertEq([g2.status, JSON.stringify(regRow()), countClaims()], [200, snapReg, claimsBefore], "ac6-11: HEAD changes nothing either");

        // Wrong / malformed code.
        const wrong = await postForm("/for-tilbydere/registrer/bekreft", { t: cryptoMod.randomBytes(32).toString("hex") });
        assertTrue(wrong.status === 400 && wrong.body.includes('data-outcome="confirm_invalid"'), `ac6-12: a wrong code → 400 (got ${wrong.status})`);
        const junk = await postForm("/for-tilbydere/registrer/bekreft", { t: "x' OR 1=1 --" });
        assertEq(junk.status, 400, "ac6-13: a malformed code → 400");
        assertEq(wrong.headers["set-cookie"], undefined, "ac6-14: a refused code sets no cookie");
        const foreign = await postForm("/for-tilbydere/registrer/bekreft", { t: token }, { Origin: "https://evil.example" });
        assertEq(foreign.status, 403, "ac6-15: a foreign Origin on the confirm POST → 403 (shared write guard)");
        const xs = await postForm("/for-tilbydere/registrer/bekreft", { t: token }, { "Sec-Fetch-Site": "cross-site" });
        assertEq(xs.status, 403, "ac6-16: Sec-Fetch-Site: cross-site on the confirm POST → 403");
        assertEq([JSON.stringify(regRow()), countClaims()], [snapReg, claimsBefore], "ac6-17: refused POSTs changed nothing");

        // Valid code, Origin: null (plain form under no-referrer).
        const ok = await postForm("/for-tilbydere/registrer/bekreft", { t: token });
        assertEq([ok.status, ok.headers.location], [303, "/for-tilbydere/registrer/utkast"], "ac6-18: a valid code (Origin: null) → 303 to the draft editor");
        const setCookie = ([] as string[]).concat(ok.headers["set-cookie"] || []).find((c) => c.startsWith("oa_owner_session=")) || "";
        assertTrue(/HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie) && /SameSite=Lax/i.test(setCookie),
          "ac6-19: … setting the oa_owner_session cookie (HttpOnly, Secure, SameSite=Lax)");
        sessionCookie = setCookie.split(";")[0];
        const sessTok = sessionCookie.slice("oa_owner_session=".length);
        const reg2 = regRow();
        assertTrue(!!reg2?.email_code_used_at && !!reg2?.email_confirmed_at && reg2?.status === "pending_review",
          "ac6-20: the code is marked used, the e-mail confirmed, and the registration stays pending_review");
        const assess = JSON.parse(reg2?.claim_assessment || "{}");
        assertEq([assess.result, assess.rule_version, assess.reason], ["yellow", svc!.SELF_REGISTER_ASSESSMENT_RULE_VERSION, "assessment_module_missing"],
          "ac6-21: claim_assessment = yellow (no assessment module yet) with the rule version");
        assertTrue(Array.isArray(assess.signals) && assess.signals.every((x: any) => x.source && x.at),
          "ac6-22: … each signal carries its source and time");
        const claim = db.prepare("SELECT * FROM gardssalg_claims WHERE token = ?").get(sessTok) as any;
        assertEq([claim?.provider_id, claim?.draft_mode, claim?.used, claim?.email, claim?.email_source, claim?.revoked_at],
          [createdId, 1, 0, "kari@testvin.no", "self_registered", null],
          "ac6-23: the session is a gardssalg_claims row: draft_mode=1, used=0, the typed address, source self_registered");
        const p = provRow();
        assertEq([p?.catalog_hidden, p?.catalog_hidden_reason, p?.claimed_at, p?.content_source === "claim", p?.epost],
          [1, "self_registered_pending_review", null, false, null],
          "ac6-24: the row stays hidden/pending, no claimed_at (no badge), not content_source='claim', no epost");
        assertEq(claimSvc.isGardssalgProviderClaimed(createdId), false, "ac6-25: the provider does not count as claimed");

        const reuse = await postForm("/for-tilbydere/registrer/bekreft", { t: token });
        assertTrue(reuse.status === 409 && reuse.body.includes('data-outcome="confirm_used"'), `ac6-26: reusing the code → 409 (got ${reuse.status})`);
        assertEq((db.prepare("SELECT COUNT(*) AS n FROM gardssalg_claims WHERE provider_id = ?").get(createdId) as any).n, 1,
          "ac6-27: … and no second session was issued");

        // Expired code (another pending registration).
        const dupReg = db.prepare("SELECT r.id FROM gardssalg_self_registrations r WHERE r.org_nr = '900000007' AND r.status = 'pending_review'").get() as any;
        const issued = svc!.issueSelfRegisterConfirmToken(dupReg?.id);
        assertTrue(!!issued && issued.to === "kari@testvin.no", "ac6-28: a code can be issued for another pending registration");
        assertEq(svc!.confirmSelfRegisterEmail(issued!.token, new Date(Date.now() + 49 * 3600 * 1000)).ok, false, "ac6-29: the service refuses a code past its 48 h");
        db.prepare("UPDATE gardssalg_self_registrations SET email_code_expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), dupReg?.id);
        const expired = await postForm("/for-tilbydere/registrer/bekreft", { t: issued!.token });
        assertTrue(expired.status === 410 && expired.body.includes('data-outcome="confirm_expired"'), `ac6-30: an expired code → 410 (got ${expired.status})`);
        assertEq((db.prepare("SELECT email_confirmed_at FROM gardssalg_self_registrations WHERE id = ?").get(dupReg?.id) as any)?.email_confirmed_at, null,
          "ac6-31: … and nothing was confirmed");
      }

      // ── AC6 / Spec E: draft mode ───────────────────────────────────────
      {
        const noCookie = await req("GET", "/for-tilbydere/registrer/utkast");
        assertEq(noCookie.status, 401, "ac6-32: the draft editor without a session → 401");
        const page = await req("GET", "/for-tilbydere/registrer/utkast", { headers: { Cookie: sessionCookie } });
        assertEq(page.status, 200, "ac6-33: the draft editor with the draft session → 200");
        assertTrue(page.body.includes('data-draft-mode="1"') && page.body.includes("ikke publisert"), "ac6-34: … in draft mode, saying the profile is not published");
        assertTrue(!/bekreftet av eier/i.test(page.body), "ac6-35: … with no «bekreftet av eier» badge");
        assertTrue(!page.body.includes('name="field_booking_live"') && page.body.includes('data-booking-state="pending_review"'),
          "ac6-36: … and no booking switch (pending review message instead)");
        assertTrue(!/publiser<\/button>|action="[^"]*(resume|publish)/i.test(page.body), "ac6-37: … and no publish action");

        const save = await postForm("/for-tilbydere/registrer/utkast", {
          field_about_text: "Vi lager vin av egne druer.",
          field_visit_text: "Gårdssalg lørdager.",
          field_opening_hours_text: "Lør 12–16",
          field_products: "Rødvin, Hvitvin",
          field_hjemmeside: "https://testvin.no",
        }, { Cookie: sessionCookie });
        assertEq([save.status, save.headers.location], [303, "/for-tilbydere/registrer/utkast?status=saved"], "ac6-38: saving the draft (Origin: null) → 303 saved");
        const p = provRow();
        assertEq([p?.about_text, p?.visit_text, p?.opening_hours_text, p?.products, p?.hjemmeside],
          ["Vi lager vin av egne druer.", "Gårdssalg lørdager.", "Lør 12–16", JSON.stringify(["Rødvin", "Hvitvin"]), "https://testvin.no"],
          "ac6-39: the CLAIM_EDITABLE_FIELDS were written to the hidden row");
        assertEq([p?.catalog_hidden, p?.catalog_hidden_reason, p?.booking_live, p?.claimed_at, p?.epost], [1, "self_registered_pending_review", 0, null, null],
          "ac6-40: … which stays hidden, pending, booking off, unclaimed, without epost");
        const audit = (db.prepare("SELECT COUNT(*) AS n FROM gardssalg_content_audit WHERE provider_id = ? AND changed_by = 'owner'").get(createdId) as any).n;
        assertTrue(audit >= 5, "ac6-41: the edits are audited like owner-portal edits");

        // Booking through the real path, with and without an address.
        const book = await postForm("/for-tilbydere/registrer/utkast", { field_booking_live: "1" }, { Cookie: sessionCookie });
        assertTrue(book.status === 409 && book.body.includes('data-status="booking_blocked"'), `ac6-42: posting booking on → 409 refused (got ${book.status})`);
        db.prepare("UPDATE experience_providers SET epost = 'post@testvin.no' WHERE id = ?").run(createdId);
        const book2 = await postForm("/for-tilbydere/registrer/utkast", { field_booking_live: "1", field_about_text: "Endret" }, { Cookie: sessionCookie });
        assertEq(book2.status, 409, "ac6-43: … also when the row has an e-mail address (pending review wins)");
        assertEq([provRow()?.booking_live, provRow()?.about_text], [0, "Vi lager vin av egne druer."], "ac6-44: a refused save writes nothing");
        db.prepare("UPDATE experience_providers SET epost = NULL WHERE id = ?").run(createdId);

        const foreignSave = await postForm("/for-tilbydere/registrer/utkast", { field_about_text: "Hack" }, { Cookie: sessionCookie, Origin: "https://evil.example" });
        assertEq(foreignSave.status, 403, "ac6-45: a foreign Origin on the draft save → 403");
        const noSessSave = await postForm("/for-tilbydere/registrer/utkast", { field_about_text: "Hack" });
        assertEq(noSessSave.status, 401, "ac6-46: a draft save without a session → 401");
        assertEq(provRow()?.about_text, "Vi lager vin av egne druer.", "ac6-47: neither changed the row");

        // The draft session opens nothing on the ordinary owner surfaces.
        const sessTok = sessionCookie.slice("oa_owner_session=".length);
        assertEq(claimSvc.verifyGardssalgOwnerSessionToken(sessTok).valid, false, "ac6-48: verifyGardssalgOwnerSessionToken refuses the draft token");
        const prof = await req("GET", `/api/opplevelser/gardssalg-claim/${createdId}/profile`, { headers: { Cookie: sessionCookie } });
        assertEq(prof.status, 401, "ac6-49: the owner JSON profile route → 401 for the draft session");
        const resume = await req("POST", `/api/opplevelser/gardssalg-claim/${createdId}/resume`, { headers: { Cookie: sessionCookie } });
        assertEq(resume.status, 401, "ac6-50: the owner resume (publish) route → 401 for the draft session");
        const upd = await req("POST", `/api/opplevelser/gardssalg-claim/${createdId}/update-profile`, {
          headers: { Cookie: sessionCookie, "Content-Type": "application/json" }, body: JSON.stringify({ booking_live: 1 }),
        });
        assertEq(upd.status, 401, "ac6-51: the owner update-profile JSON route → 401 for the draft session");
        const mlv = await req("GET", `/kategori/gardssalg/eier/magic-link-verify?token=${sessTok}`);
        assertEq(mlv.headers.location, "/kategori/gardssalg?error=invalid_token", "ac6-52: magic-link-verify refuses the draft token");
        const c2 = db.prepare("SELECT used, draft_mode FROM gardssalg_claims WHERE token = ?").get(sessTok) as any;
        assertEq([c2?.used, c2?.draft_mode, provRow()?.claimed_at, provRow()?.content_source === "claim"], [0, 1, null, false],
          "ac6-53: … and did not turn it into a claim (no used, no claimed_at, no content_source='claim')");
        assertEq(provRow()?.catalog_hidden, 1, "ac6-54: the row is still hidden after every attempt");

        // Still on no public surface.
        for (const surface of GARDSSALG_SURFACES) {
          const n = (db.prepare(`SELECT COUNT(*) AS n FROM experience_providers WHERE id = ? AND ${gardssalgVisibleSql(surface)}`).get(createdId) as any).n;
          assertEq(n, 0, `ac6-55: after draft edits gardssalgVisibleSql('${surface}') still excludes the row`);
        }
        assertEq(store.searchGardssalgProvidersByQuery("Testvin", 30).length, 0, "ac6-56: search still does not find it");
        assertTrue(!store.searchGardssalgProviders({}, 100, { surface: "mcp" }).some((x: any) => x.id === createdId)
          && !store.searchGardssalgProviders({}, 100, { surface: "a2a" }).some((x: any) => x.id === createdId), "ac6-57: MCP/A2A still do not list it");
        const finn = await req("GET", "/for-tilbydere/finn?q=Testvin");
        assertTrue(!finn.body.includes(createdSlug), "ac6-58: /for-tilbydere/finn still does not list it");
        const sitemap = await req("GET", "/sitemap.xml");
        assertTrue(!sitemap.body.includes(createdSlug), "ac6-59: sitemap still does not list it");
        const produsent = await req("GET", `/kategori/gardssalg/produsent/${createdSlug}`);
        assertEq(produsent.status, 404, "ac6-60: the produsent page is still 404");

        // A row that leaves pending review ends the draft session.
        db.prepare("UPDATE experience_providers SET catalog_hidden_reason = 'self_registered_rejected' WHERE id = ?").run(createdId);
        const after = await req("GET", "/for-tilbydere/registrer/utkast", { headers: { Cookie: sessionCookie } });
        assertEq(after.status, 401, "ac6-61: once the row is no longer pending review the draft session is refused");
        db.prepare("UPDATE experience_providers SET catalog_hidden_reason = 'self_registered_pending_review' WHERE id = ?").run(createdId);
        db.prepare("UPDATE gardssalg_claims SET expires_at = ? WHERE token = ?").run(new Date(Date.now() - 1000).toISOString(), sessTok);
        const exp = await req("GET", "/for-tilbydere/registrer/utkast", { headers: { Cookie: sessionCookie } });
        assertEq(exp.status, 401, "ac6-62: an expired draft session is refused");
      }

      // ── Never guess an e-mail address (2026-08-06) ──────────────────────
      {
        const before = sends.length;
        const r = await post(valid({ org_nr: "900000013", company_name: "Gjett Ikke Gård", email: "eier.privat@gmail.com", website: "https://gjettikke.no" }));
        assertTrue(r.body.includes('data-outcome="created"'), "ng-1: a registration with a website and a free-mail address is created");
        await new Promise((res) => setTimeout(res, 20));
        const mine = sends.slice(before);
        assertEq(mine.map((x) => x.to), ["eier.privat@gmail.com"], "ng-2: the code goes to the typed address only — never post@/kontakt@<website domain>");
        const row = db.prepare("SELECT id, epost, hjemmeside FROM experience_providers WHERE org_nr = '900000013'").get() as any;
        assertEq([row?.epost, row?.hjemmeside], [null, null], "ng-3: the profile gets no epost and no website before approval");
        assertEq((db.prepare("SELECT COUNT(*) AS n FROM gardssalg_claims WHERE email LIKE '%gjettikke.no'").get() as any).n, 0,
          "ng-4: no claim/session row names a derived address");
        const allTyped = new Set(["kari@testvin.no", "eier.privat@gmail.com"]);
        assertTrue(sends.every((x) => allTyped.has(x.to)), "ng-5: every confirm link in this suite went to an address a submitter typed");
      }

      // ── Flag OFF → the skive-2 routes are 404 too ───────────────────────
      {
        delete process.env.GARDSSALG_SELF_REGISTER_ENABLED;
        const claimsBefore = countClaims();
        const a = await req("GET", `/for-tilbydere/registrer/bekreft?t=${token}`);
        const b = await postForm("/for-tilbydere/registrer/bekreft", { t: token });
        const c = await req("GET", "/for-tilbydere/registrer/utkast", { headers: { Cookie: sessionCookie } });
        const d = await postForm("/for-tilbydere/registrer/utkast", { field_about_text: "x" }, { Cookie: sessionCookie });
        assertEq([a.status, b.status, c.status, d.status], [404, 404, 404, 404], "off-1: flag off — GET/POST bekreft and GET/POST utkast are 404");
        assertEq(countClaims(), claimsBefore, "off-2: flag off — nothing was written");
        process.env.GARDSSALG_SELF_REGISTER_ENABLED = "true";
      }
    } catch (err: any) {
      failed++;
      failures.push(`✗ unexpected error: ${String(err?.stack || err?.message || err)}`);
    } finally {
      (emailSvcMod.emailService as any).sendGardssalgSelfRegisterConfirmLink = origSendConfirm;
      if (server) {
        try { server.close(); } catch { /* ignore */ }
      }
      try { svc?.__setSelfRegisterDepsForTesting(null); } catch { /* ignore */ }
      try {
        const { gardssalgSelfRegisterLimiter, generalLimiter } = require("../middleware/security") as typeof import("../middleware/security");
        (gardssalgSelfRegisterLimiter as any).resetKey(TEST_CLIENT_IP);
        (generalLimiter as any).resetKey(TEST_CLIENT_IP);
      } catch { /* ignore */ }
      if (prevFlag === undefined) delete process.env.GARDSSALG_SELF_REGISTER_ENABLED;
      else process.env.GARDSSALG_SELF_REGISTER_ENABLED = prevFlag;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* ignore */ }
      restoreModuleCache();
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runGardssalgSelfRegisterTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    // Open limiter timers and DB handles would keep a standalone run alive.
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
