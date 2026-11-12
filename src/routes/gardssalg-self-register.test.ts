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
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache"))
      .swapOutModules([dbFactoryPath, expStorePath, seoPath, routePath, svcPath]);

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
    } catch (err: any) {
      failed++;
      failures.push(`✗ unexpected error: ${String(err?.stack || err?.message || err)}`);
    } finally {
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
