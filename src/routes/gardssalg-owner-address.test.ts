/**
 * gardssalg-owner-address.test.ts — dev-request 2026-11-26-opplevagent-eier-
 * endrer-adresse-selv (slookisen/A2A), slice 1 (spec points 1–3, AK1–AK4).
 *
 *   ak1-*  a logged-in owner saves a new address (form and JSON): adresse,
 *          postnummer, poststed, lat and lon all change; audit rows with the
 *          owner as source; one row in the owner's change log. No session →
 *          login / 401, another producer's session → 403, a cross-site POST →
 *          403: nothing changes.
 *   ak2-*  invalid postnummer, empty street, a poststed that does not match,
 *          a post box, a failed map lookup (null, a throw, an implausible
 *          point): nothing changes, a Norwegian message.
 *   ak3-*  flag off (and pilot without the allowlist): no form on the portal,
 *          both POST routes 404, nothing written.
 *   ak4-*  the registry entry (contact.address_edit): coming_soon, default on
 *          for owner, «Gjelder ikke» for unclaimed, no outward send; the
 *          governance shape and matrix rules pass.
 *   lock-* the owner lock for every other writer is unchanged.
 *
 * The map lookup is stubbed (__setOwnerAddressGeocoderForTesting): no
 * outbound network. Exported runGardssalgOwnerAddressTests({log}) ->
 * TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/gardssalg-owner-address.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runGardssalgOwnerAddressTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const ENV_KEYS = ["EXPERIENCES_DB_PATH", "GARDSSALG_OWNER_ADDRESS_EDIT_ENABLED", "OWNER_FEATURES_ALLOWED_SUBJECTS", "OA_OWNER_FEATURES_ENABLED", "GARDSSALG_OWNER_DASHBOARD_ENABLED"];
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env.GARDSSALG_OWNER_ADDRESS_EDIT_ENABLED;
    delete process.env.OA_OWNER_FEATURES_ENABLED;
    delete process.env.GARDSSALG_OWNER_DASHBOARD_ENABLED;
    delete process.env.OWNER_FEATURES_ALLOWED_SUBJECTS;

    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("../services/gardssalg-claim"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/gardssalg-owner-portal-write"),
      require.resolve("../services/gardssalg-owner-address"),
      require.resolve("./gardssalg-claim"),
      require.resolve("./gardssalg-owner-features"),
    ]);
    const servers: any[] = [];
    let prevRfbDb: any = null;
    let initMod: typeof import("../database/init") | null = null;
    let addrMod: typeof import("../services/gardssalg-owner-address") | null = null;

    try {
      initMod = require("../database/init") as typeof import("../database/init");
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const rfbDb = new Database(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);

      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded by an earlier suite in the same process */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const insertProvider = expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, brreg_active, hjemmeside, epost, content_source, products,
           producer_type, enrichment_state, verification_status, source, confidence, booking_live, claimed_at,
           adresse, postnummer, poststed, lat, lon, geocode_source, geocode_confidence)
        VALUES
          (@id, @navn, @slug, 'experiences', @org_nr, 1, 1, @hjemmeside, @epost, @content_source, '["Eplesider"]',
           'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium', 1, datetime('now'),
           'Gamlevegen 1', '5003', 'Bergen', 60.39, 5.32, 'test', 'exact')
      `);
      const mk = (id: string, navn: string, slug: string, org: string, contentSource = "claim") =>
        insertProvider.run({ id, navn, slug, org_nr: org, hjemmeside: `https://${slug}.no`, epost: `post@${slug}.no`, content_source: contentSource });
      mk("oa-a", "Gard A Sideri", "gard-a", "918200001");
      mk("oa-b", "Gard B Bryggeri", "gard-b", "918200002");
      mk("oa-m", "Gard M Kuratert", "gard-m", "918200003", "manual");
      const claimRow = expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at)
         VALUES (?, ?, ?, 'verified_domain_address', ?, 1, datetime('now'), datetime('now','+7 days'))`,
      );
      for (const [pid, tok] of [["oa-a", "tok-a"], ["oa-b", "tok-b"], ["oa-m", "tok-m"]]) claimRow.run(`gsc_${pid}`, pid, `eier@${pid}.no`, tok);

      addrMod = require("../services/gardssalg-owner-address") as typeof import("../services/gardssalg-owner-address");
      const geoCalls: Array<{ street: string; postnummer: string; poststed: string }> = [];
      let geoAnswer: { lat: number; lon: number; confidence: string } | null | "throw" = { lat: 59.9226, lon: 10.7339, confidence: "exact" };
      addrMod.__setOwnerAddressGeocoderForTesting(async (a) => {
        geoCalls.push(a);
        if (geoAnswer === "throw") throw new Error("kartverket nede");
        return geoAnswer;
      });

      const claimRoutes = require("./gardssalg-claim") as typeof import("./gardssalg-claim");
      const expressMod = require("express") as typeof import("express");
      const app = expressMod();
      app.use("/", claimRoutes.default);
      const httpMod = require("http") as typeof import("http");
      const server = httpMod.createServer(app);
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const req = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
        new Promise<{ status: number; headers: any; body: string }>((resolve, reject) => {
          const r = httpMod.request({ method, host: "127.0.0.1", port, path, headers }, (resp) => {
            const chunks: Buffer[] = [];
            resp.on("data", (c) => chunks.push(c as Buffer));
            resp.on("end", () => resolve({ status: resp.statusCode || 0, headers: resp.headers, body: Buffer.concat(chunks).toString("utf8") }));
          });
          r.on("error", reject);
          if (body) r.write(body);
          r.end();
        });
      const cookie = (t: string) => ({ Cookie: `oa_owner_session=${t}` });
      const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
      const JSONH = { "Content-Type": "application/json" };
      const portal = (slug: string) => `/kategori/gardssalg/eier/${slug}/portal`;
      const formPath = (slug: string) => `/kategori/gardssalg/eier/${slug}/adresse`;
      const apiPath = (id: string) => `/api/opplevelser/gardssalg-claim/${id}/update-address`;
      const formBody = (g: string, pn: string, ps: string) => new URLSearchParams({ gate: g, postnummer: pn, poststed: ps }).toString();
      const postForm = (slug: string, tok: string | null, g: string, pn: string, ps: string, extra: Record<string, string> = {}) =>
        req("POST", formPath(slug), { ...FORM, ...(tok ? cookie(tok) : {}), ...extra }, formBody(g, pn, ps));
      const postJson = (id: string, tok: string | null, body: Record<string, unknown>, extra: Record<string, string> = {}) =>
        req("POST", apiPath(id), { ...JSONH, ...(tok ? cookie(tok) : {}), ...extra }, JSON.stringify(body));
      type AddrRow = { adresse: string | null; postnummer: string | null; poststed: string | null; lat: number | null; lon: number | null; geocode_source: string | null; field_provenance: string | null; content_source: string | null };
      const row = (id: string) => expDb.prepare(
        `SELECT adresse, postnummer, poststed, lat, lon, geocode_source, field_provenance, content_source FROM experience_providers WHERE id = ?`,
      ).get(id) as AddrRow;
      const five = (r: AddrRow) => [r.adresse, r.postnummer, r.poststed, r.lat, r.lon];
      const ORIGINAL = ["Gamlevegen 1", "5003", "Bergen", 60.39, 5.32];
      const auditCount = (id: string) => (expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_content_audit WHERE provider_id = ?`).get(id) as { n: number }).n;
      const logCount = (id: string) => (rfbDb.prepare(`SELECT COUNT(*) AS n FROM owner_feature_audit WHERE vertical = 'gardssalg' AND subject_id = ?`).get(id) as { n: number }).n;
      const reset = (id: string) => {
        expDb.prepare(`UPDATE experience_providers SET adresse = 'Gamlevegen 1', postnummer = '5003', poststed = 'Bergen', lat = 60.39, lon = 5.32, geocode_source = 'test' WHERE id = ?`).run(id);
      };
      const nothingChanged = (id: string, audits: number, logs: number, label: string) => {
        assertEq(five(row(id)), ORIGINAL, `${label}: adresse/postnummer/poststed/lat/lon unchanged`);
        assertEq([auditCount(id), logCount(id)], [audits, logs], `${label}: no audit row, no change-log row`);
      };

      // ══ AK3 — flag off: no form, POST refused ═══════════════════════════
      const offPortal = await req("GET", portal("gard-a"), cookie("tok-a"));
      assertEq(offPortal.status, 200, "ak3-1: the portal opens with the flag off");
      assertTrue(!offPortal.body.includes('data-owner-address') && !offPortal.body.includes('id="gc-address-form"'), "ak3-2: flag off → no address form on the portal");
      assertTrue(/<form id="gc-release-form" method="post" action="[^"]+"><\/form>\n      <\/div>\n      <div class="gc-card" data-visibility-state="visible">/.test(offPortal.body),
        "ak3-3: flag off → the markup after the profile card is exactly as before");
      const offForm = await postForm("gard-a", "tok-a", "Universitetsgata 2", "0164", "Oslo");
      const offApi = await postJson("oa-a", "tok-a", { street: "Universitetsgata 2", postnummer: "0164", poststed: "Oslo" });
      assertEq([offForm.status, offApi.status], [404, 404], "ak3-4: flag off → the form POST and the JSON POST answer 404");
      assertEq(geoCalls.length, 0, "ak3-5: flag off → no map lookup");
      nothingChanged("oa-a", 0, 0, "ak3-6");
      process.env.GARDSSALG_OWNER_ADDRESS_EDIT_ENABLED = "pilot";
      process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = "gardssalg:oa-b";
      const pilotOff = await req("GET", portal("gard-a"), cookie("tok-a"));
      const pilotOffPost = await postForm("gard-a", "tok-a", "Universitetsgata 2", "0164", "Oslo");
      assertTrue(!pilotOff.body.includes("data-owner-address") && pilotOffPost.status === 404, "ak3-7: pilot, producer not on the allowlist → no form, POST 404");
      process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = "gardssalg:oa-a";
      const pilotOn = await req("GET", portal("gard-a"), cookie("tok-a"));
      assertTrue(pilotOn.body.includes('data-owner-address="1"'), "ak3-8: pilot, producer on the allowlist → the form is there");
      for (const v of ["0", "", "yes", "Pilot"]) {
        process.env.GARDSSALG_OWNER_ADDRESS_EDIT_ENABLED = v;
        assertEq(addrMod.gardssalgOwnerAddressEditOnFor("oa-a"), false, `ak3-9: flag value ${JSON.stringify(v)} is off`);
      }
      nothingChanged("oa-a", 0, 0, "ak3-10");

      // ══ Flag on ══════════════════════════════════════════════════════════
      process.env.GARDSSALG_OWNER_ADDRESS_EDIT_ENABLED = "1";
      delete process.env.OWNER_FEATURES_ALLOWED_SUBJECTS;
      const onPortal = await req("GET", portal("gard-a"), cookie("tok-a"));
      assertTrue(onPortal.body.includes('id="gc-address-form"') && onPortal.body.includes('action="/kategori/gardssalg/eier/gard-a/adresse"')
        && onPortal.body.includes('name="gate"') && onPortal.body.includes('name="postnummer"') && onPortal.body.includes('name="poststed"'),
        "ak1-1: flag on → the portal has the address form (gate, postnummer, poststed)");
      assertTrue(onPortal.body.includes('value="Gamlevegen 1"') && onPortal.body.includes('value="5003"') && onPortal.body.includes('value="Bergen"'),
        "ak1-2: the form shows the stored address");

      // ── AK1: no session / another producer / cross-site → nothing changes ──
      const noSess = await postForm("gard-a", null, "Universitetsgata 2", "0164", "Oslo");
      assertTrue(noSess.status === 303 && String(noSess.headers.location) === "/kategori/gardssalg/eier/gard-a", "ak1-3: form POST without a session → 303 to the login page");
      const noSessApi = await postJson("oa-a", null, { street: "Universitetsgata 2", postnummer: "0164", poststed: "Oslo" });
      assertEq(noSessApi.status, 401, "ak1-4: JSON POST without a session → 401");
      const badTok = await postJson("oa-a", "tok-unknown", { street: "Universitetsgata 2", postnummer: "0164", poststed: "Oslo" });
      assertEq(badTok.status, 401, "ak1-5: JSON POST with an unknown token → 401");
      const other = await postForm("gard-a", "tok-b", "Universitetsgata 2", "0164", "Oslo");
      const otherApi = await postJson("oa-a", "tok-b", { street: "Universitetsgata 2", postnummer: "0164", poststed: "Oslo" });
      assertEq([other.status, otherApi.status], [403, 403], "ak1-6: another producer's owner (form and JSON) → 403");
      const cross = await postForm("gard-a", "tok-a", "Universitetsgata 2", "0164", "Oslo", { "Sec-Fetch-Site": "cross-site" });
      const crossApi = await postJson("oa-a", "tok-a", { street: "Universitetsgata 2", postnummer: "0164", poststed: "Oslo" }, { Origin: "https://evil.example" });
      assertEq([cross.status, crossApi.status], [403, 403], "ak1-7: a cross-site POST (Sec-Fetch-Site / foreign Origin) → 403");
      assertEq(geoCalls.length, 0, "ak1-8: refused requests do no map lookup");
      nothingChanged("oa-a", 0, 0, "ak1-9");
      nothingChanged("oa-b", 0, 0, "ak1-10 (the other producer)");

      // ── AK1: the owner saves (form) ──────────────────────────────────────
      const saved = await postForm("gard-a", "tok-a", " Universitetsgata  2 ", "0164", "Oslo", { Origin: "null" });
      assertTrue(saved.status === 303 && String(saved.headers.location) === "/kategori/gardssalg/eier/gard-a/portal?adresse=lagret#adresse",
        "ak1-11: the owner's form save → 303 back to the address card, «lagret»");
      const after = row("oa-a");
      assertEq(five(after), ["Universitetsgata 2", "0164", "Oslo", 59.9226, 10.7339], "ak1-12: adresse, postnummer, poststed, lat and lon all changed");
      assertEq(after.geocode_source, "kartverket", "ak1-13: the map point is marked as the Kartverket lookup's");
      assertEq(geoCalls[geoCalls.length - 1], { street: "Universitetsgata 2", postnummer: "0164", poststed: "Oslo" }, "ak1-14: the map lookup got the unit (whitespace tidied)");
      assertEq(after.content_source, "claim", "ak1-15: the profile stays owner-claimed");
      const audits = expDb.prepare(`SELECT field_name, old_value, new_value, changed_by, batch_id, source_url FROM gardssalg_content_audit WHERE provider_id = 'oa-a' ORDER BY field_name`).all() as any[];
      const src = (require("../services/gardssalg-owner-portal-write") as typeof import("../services/gardssalg-owner-portal-write")).OWNER_PORTAL_ADDRESS_SOURCE;
      assertEq(audits.map((a) => [a.field_name, a.old_value, a.new_value, a.changed_by, a.batch_id, a.source_url]), [
        ["adresse", "Gamlevegen 1", "Universitetsgata 2", "owner", "owner-portal", src],
        ["postnummer", "5003", "0164", "owner", "owner-portal", src],
        ["poststed", "Bergen", "Oslo", "owner", "owner-portal", src],
      ], "ak1-16: one audit row per address column, changed_by owner, the owner-portal source (revision log)");
      const prov = JSON.parse(after.field_provenance || "{}");
      assertTrue(["adresse", "postnummer", "poststed"].every((c) => prov[c]?.source_url === src), "ak1-17: field_provenance names the owner as the source of the three columns");
      const logRows = rfbDb.prepare(`SELECT key, old_json, new_json, actor, actor_detail FROM owner_feature_audit WHERE vertical = 'gardssalg' AND subject_id = 'oa-a'`).all() as any[];
      assertEq(logRows.map((r) => [r.key, JSON.parse(r.old_json), JSON.parse(r.new_json), r.actor, r.actor_detail]),
        [["contact.address_edit", "Gamlevegen 1, 5003 Bergen", "Universitetsgata 2, 0164 Oslo", "owner", "eier@oa-a.no"]],
        "ak1-18: one row in the owner's change log (Endringslogg), actor owner");
      const okPage = await req("GET", "/kategori/gardssalg/eier/gard-a/portal?adresse=lagret", cookie("tok-a"));
      assertTrue(okPage.body.includes("Adressen er lagret.") && okPage.body.includes('value="Universitetsgata 2"'), "ak1-19: the card says it is saved and shows the new address");

      // Unchanged → nothing written, no lookup.
      const callsBefore = geoCalls.length;
      const same = await postForm("gard-a", "tok-a", "Universitetsgata 2", "0164", "Oslo");
      assertTrue(String(same.headers.location).includes("adresse=uendret") && geoCalls.length === callsBefore && auditCount("oa-a") === 3 && logCount("oa-a") === 1,
        "ak1-20: the same address again → «uendret», no lookup, no new rows");

      // ── AK1: the owner saves (JSON) ──────────────────────────────────────
      geoAnswer = { lat: 60.3913, lon: 5.3221, confidence: "exact" };
      const apiSave = await postJson("oa-b", "tok-b", { street: "Strandkaien 4", postnummer: "5013", poststed: "Bergen" });
      const apiBody = JSON.parse(apiSave.body);
      assertTrue(apiSave.status === 200 && apiBody.success === true && apiBody.changed === true && typeof apiBody.message === "string",
        "ak1-21: JSON save by the owner → 200 success, changed, a message");
      assertEq(five(row("oa-b")), ["Strandkaien 4", "5013", "Bergen", 60.3913, 5.3221], "ak1-22: JSON save → all five columns changed");
      assertEq([auditCount("oa-b"), logCount("oa-b")], [3, 1], "ak1-23: JSON save → 3 audit rows and 1 change-log row");
      reset("oa-b");

      // ══ AK2 — invalid input / failed lookup → nothing changes ════════════
      reset("oa-a");
      const a0 = auditCount("oa-a");
      const l0 = logCount("oa-a");
      geoAnswer = { lat: 59.9226, lon: 10.7339, confidence: "exact" };
      const cases: Array<[string, string, string, string, string]> = [
        ["ak2-1 postnummer with 3 digits", "Universitetsgata 2", "016", "Oslo", "postnummer_ugyldig"],
        ["ak2-2 postnummer with letters", "Universitetsgata 2", "01a4", "Oslo", "postnummer_ugyldig"],
        ["ak2-3 empty street", "   ", "0164", "Oslo", "gate_mangler"],
        ["ak2-4 street without letters", "12", "0164", "Oslo", "gate_mangler"],
        ["ak2-5 empty poststed", "Universitetsgata 2", "0164", "", "poststed_mangler"],
        ["ak2-6 poststed that does not match", "Universitetsgata 2", "0164", "Bergen", "poststed_passer_ikke"],
        ["ak2-7 unknown postnummer", "Universitetsgata 2", "0001", "Oslo", "postnummer_ukjent"],
        ["ak2-8 post box", "Postboks 12", "0164", "Oslo", "postboks"],
        ["ak2-9 a comma in the street", "Rebel, Universitetsgata 2", "0164", "Oslo", "gate_ugyldig"],
      ];
      const lookupsBefore = geoCalls.length;
      for (const [label, g, pn, ps, code] of cases) {
        claimRoutes.__resetGardssalgOwnerAddressRateLimitForTesting();
        const r = await postForm("gard-a", "tok-a", g, pn, ps);
        assertTrue(r.status === 303 && String(r.headers.location).includes(`adresse=${code}`), `${label} → 303 with «${code}»`);
      }
      assertEq(geoCalls.length, lookupsBefore, "ak2-10: invalid input is refused before any map lookup");
      const mismatch = await req("GET", "/kategori/gardssalg/eier/gard-a/portal?adresse=poststed_passer_ikke&g=Universitetsgata%202&pn=0164&ps=Bergen", cookie("tok-a"));
      assertTrue(mismatch.body.includes("Poststedet passer ikke med postnummeret 0164. I postregisteret heter det OSLO.") && mismatch.body.includes('value="Bergen"'),
        "ak2-11: the card explains the mismatch with the register's poststed and keeps what the owner wrote");
      const pnPage = await req("GET", "/kategori/gardssalg/eier/gard-a/portal?adresse=postnummer_ugyldig", cookie("tok-a"));
      assertTrue(pnPage.body.includes("Postnummeret må være fire sifre. Ingenting er lagret."), "ak2-12: the card says the postnummer must be four digits");
      claimRoutes.__resetGardssalgOwnerAddressRateLimitForTesting();
      const badApi = await postJson("oa-a", "tok-a", { street: "", postnummer: "0164", poststed: "Oslo" });
      const badApiBody = JSON.parse(badApi.body);
      assertTrue(badApi.status === 400 && badApiBody.error === "gate_mangler" && /Skriv inn gateadressen/.test(badApiBody.message), "ak2-13: JSON empty street → 400 gate_mangler with a Norwegian message");
      const wrongType = await postJson("oa-a", "tok-a", { street: ["Universitetsgata 2"], postnummer: 164, poststed: "Oslo" });
      assertEq(wrongType.status, 400, "ak2-14: JSON with the wrong types → 400");

      for (const [label, answer] of [["null", null], ["a throw", "throw"], ["an implausible point (0,0)", { lat: 0, lon: 0, confidence: "exact" }]] as const) {
        geoAnswer = answer as any;
        claimRoutes.__resetGardssalgOwnerAddressRateLimitForTesting();
        const before = geoCalls.length;
        const r = await postForm("gard-a", "tok-a", "Universitetsgata 2", "0164", "Oslo");
        assertTrue(r.status === 303 && String(r.headers.location).includes("adresse=kartoppslag_feilet") && geoCalls.length === before + 1,
          `ak2-15: map lookup gives ${label} → «kartoppslag_feilet»`);
      }
      geoAnswer = null;
      claimRoutes.__resetGardssalgOwnerAddressRateLimitForTesting();
      const geoApi = await postJson("oa-a", "tok-a", { street: "Universitetsgata 2", postnummer: "0164", poststed: "Oslo" });
      const geoApiBody = JSON.parse(geoApi.body);
      assertTrue(geoApi.status === 422 && geoApiBody.error === "kartoppslag_feilet" && geoApiBody.message.includes("Vi fant ikke adressen på kartet, så ingenting er lagret"),
        "ak2-16: JSON failed lookup → 422 with the Norwegian message");
      const geoPage = await req("GET", "/kategori/gardssalg/eier/gard-a/portal?adresse=kartoppslag_feilet&g=Universitetsgata%202&pn=0164&ps=Oslo", cookie("tok-a"));
      assertTrue(geoPage.body.includes("Vi fant ikke adressen på kartet, så ingenting er lagret."), "ak2-17: the card explains the failed lookup");
      nothingChanged("oa-a", a0, l0, "ak2-18");

      // Opplevagent-curated row: locked for the owner too.
      geoAnswer = { lat: 59.9226, lon: 10.7339, confidence: "exact" };
      const manualPage = await req("GET", portal("gard-m"), cookie("tok-m"));
      assertTrue(manualPage.body.includes("Adressen er låst av Opplevagent-support") && /id="f-gate"[^>]* disabled/.test(manualPage.body), "ak2-19: content_source=manual → the card says locked, inputs disabled");
      const manualPost = await postJson("oa-m", "tok-m", { street: "Universitetsgata 2", postnummer: "0164", poststed: "Oslo" });
      assertEq([manualPost.status, JSON.parse(manualPost.body).error], [409, "laast"], "ak2-20: content_source=manual → 409 «laast»");
      nothingChanged("oa-m", 0, 0, "ak2-21");

      // ══ The owner lock for every other writer is unchanged ═══════════════
      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      const unit = { street: "Universitetsgata 2", postnummer: "0164", poststed: "Oslo", lat: 59.9226, lon: 10.7339 };
      const plain = store.applyGardssalgSetAddressUnit("oa-a", unit, "admin-test");
      assertEq(plain, { ok: false, reason: "owner_locked", field: "adresse" }, "lock-1: a writer without the owner's context still meets owner_locked");
      const forged = store.applyGardssalgSetAddressUnit("oa-a", unit, "admin-test", { ownerPortal: { sessionToken: "tok-b" } });
      assertEq(forged, { ok: false, reason: "owner_portal_invalid", detail: "owner_session_wrong_provider" }, "lock-2: another producer's session token is refused by the writer itself");
      const bogus = store.applyGardssalgSetAddressUnit("oa-a", unit, "admin-test", { ownerPortal: { sessionToken: "nope" } });
      assertEq(bogus, { ok: false, reason: "owner_portal_invalid", detail: "owner_session_invalid" }, "lock-3: an unknown token is refused, never downgraded");
      const both = store.applyGardssalgSetAddressUnit("oa-a", unit, "admin-test", { ownerPortal: { sessionToken: "tok-a" }, ownerRequest: { changeRequestId: "x" } });
      assertEq(both, { ok: false, reason: "owner_portal_invalid", detail: "two_owner_contexts" }, "lock-4: two owner contexts together are refused");
      assertTrue(store.isGardssalgFieldOwnerLocked(row("oa-a"), "adresse") && store.isGardssalgFieldOwnerLocked(row("oa-a"), "postnummer"),
        "lock-5: isGardssalgFieldOwnerLocked still locks the address columns on the claimed row");
      expDb.prepare(`UPDATE gardssalg_claims SET revoked_at = datetime('now') WHERE token = 'tok-a'`).run();
      const revoked = store.applyGardssalgSetAddressUnit("oa-a", unit, "admin-test", { ownerPortal: { sessionToken: "tok-a" } });
      assertEq(revoked, { ok: false, reason: "owner_portal_invalid", detail: "owner_session_invalid" }, "lock-6: a revoked session is refused by the writer");
      expDb.prepare(`UPDATE gardssalg_claims SET revoked_at = NULL WHERE token = 'tok-a'`).run();
      nothingChanged("oa-a", a0, l0, "lock-7");

      // Rate cap per session.
      claimRoutes.__resetGardssalgOwnerAddressRateLimitForTesting();
      geoAnswer = null;
      let capped = false;
      for (let i = 0; i < claimRoutes.GARDSSALG_OWNER_ADDRESS_SAVES_PER_MINUTE + 1; i++) {
        const r = await postJson("oa-a", "tok-a", { street: "Universitetsgata 2", postnummer: "0164", poststed: "Oslo" });
        if (r.status === 429) capped = true;
      }
      assertTrue(capped, `cap-1: more than ${claimRoutes.GARDSSALG_OWNER_ADDRESS_SAVES_PER_MINUTE} saves a minute on one session → 429`);
      claimRoutes.__resetGardssalgOwnerAddressRateLimitForTesting();

      // ══ AK4 — the registry entry ═════════════════════════════════════════
      const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");
      const e = reg.GARDSSALG_OWNER_FEATURE_REGISTRY.find((x) => x.key === "contact.address_edit");
      assertTrue(!!e && (reg.GARDSSALG_OWNER_FEATURE_KEYS as readonly string[]).includes("contact.address_edit"), "ak4-1: contact.address_edit is a gårdssalg registry key with an entry");
      assertEq(e && [e.group, e.status, e.default, e.outward, e.consent, e.devRequest, e.verticals, e.surfaces],
        ["contact", "coming_soon", { owner: true, unclaimed: null }, false, false, "2026-11-26-opplevagent-eier-endrer-adresse-selv", ["gardssalg"], ["owner_portal"]],
        "ak4-2: coming_soon, default on for owner, «Gjelder ikke» for unclaimed, no outward send, devRequest set");
      assertEq(addrMod.GARDSSALG_OWNER_ADDRESS_EDIT_KEY, "contact.address_edit", "ak4-3: the change log uses the registry key");
      const gov = require("../owner-features/registry-governance-s4.test") as typeof import("../owner-features/registry-governance-s4.test");
      const shape = gov.checkEntryShape(reg.GARDSSALG_OWNER_FEATURE_REGISTRY, reg.GARDSSALG_OWNER_FEATURE_KEYS, reg.GARDSSALG_OWNER_FEATURE_GROUPS.map((g) => g.key));
      assertEq(shape, [], "ak4-4: governance rule 1 (shape) passes over the gårdssalg registry");
      assertEq(gov.checkMatrixCoverage(reg.GARDSSALG_OWNER_FEATURE_REGISTRY.filter((x) => x.key === "contact.address_edit"), []), [],
        "ak4-5: matrix rule: a coming_soon entry needs no matrix case (and may have none)");
    } catch (err: any) {
      failed++;
      failures.push("unexpected error: " + String(err?.stack || err));
    } finally {
      try { addrMod?.__setOwnerAddressGeocoderForTesting(null); } catch { /* ignore */ }
      for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
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
  runGardssalgOwnerAddressTests({ log: true }).then((r) => {
    console.log(`\ngardssalg-owner-address: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed ? 1 : 0);
  });
}
