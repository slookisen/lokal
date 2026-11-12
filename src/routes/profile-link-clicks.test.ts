/**
 * profile-link-clicks.test.ts — slice S4 of dev-request
 * 2026-10-23-admin-ordre-og-henvisningsdashbord: counting redirects + click
 * beacon for the outgoing links on the Opplevagent (opplevelse / tilbyder /
 * gårdssalg produsent) and Finn-tannlege (klinikk) profile pages, and their
 * numbers in GET /admin/api/ordre/oversikt + eksport.csv.
 *
 * No network, no production DB: in-memory lokal.db (pinned on init.getDb),
 * in-memory experiences.db / dental.db (EXPERIENCES_DB_PATH / DENTAL_DB_PATH
 * = ":memory:", fresh db-factory copy via swapOutModules), the real
 * experiences-seo / dental-seo routers on an ephemeral local HTTP server.
 *
 *   P    the profile pages route booking/website/directory links through
 *        /ut/<surface>/<id>/<kind> and put the beacon attributes on tel:/mailto:
 *   AC5  each redirect counts exactly one click and 302s to the DB target
 *        (website with the page's old UTM tags); unknown id / kind / surface
 *        → 404 and no row; query-parameter injection is ignored; an id of
 *        another entity type or of the other host's surface → 404; stored
 *        javascript: / data: / scheme-less values → 404; unpublished / hidden
 *        rows → 404; beacon validation (400/404/204)
 *   AC6  a known bot UA is counted with is_bot = 1 and is not in the main
 *        number of the overview; overview = direct SQL count; test-provider
 *        clicks in their own row; no session id / IP hash / UA / e-mail in
 *        the overview JSON or the CSV
 *
 * Standalone: npx tsx src/routes/profile-link-clicks.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";
import * as http from "http";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HttpResult { status: number; headers: http.IncomingHttpHeaders; text: string }

export async function runProfileLinkClicksTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed++; if (log) console.log(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${e}\n    actual:   ${a}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  const ENV_KEYS = [
    "EXPERIENCES_DB_PATH", "DENTAL_DB_PATH", "ENABLE_EXPERIENCES", "ENABLE_DENTAL", "ADMIN_KEY", "ANALYTICS_ADMIN_KEY",
    "EMAIL_REVEAL_GUARD_EXPERIENCES", "EMAIL_REVEAL_GUARD_DENTAL", "OPPLEVAGENT_LANG_SWITCHER_ENABLED",
  ];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.EXPERIENCES_DB_PATH = ":memory:";
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.ENABLE_EXPERIENCES = "1";
  process.env.ENABLE_DENTAL = "1";
  const ADMIN_KEY = "profile-link-clicks-test-key";
  process.env.ADMIN_KEY = ADMIN_KEY;

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevMainDb = initMod.getDb();
  const mainDb = new Database(":memory:");

  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("../services/experience-store"),
    require.resolve("../services/dental-store"),
    require.resolve("../services/profile-link-clicks"),
    require.resolve("./experiences-seo"),
    require.resolve("./dental-seo"),
    require.resolve("./admin-order-stats"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
  let server: http.Server | null = null;
  // Pin IMPORT_VALUES_HIDDEN on (its production value); another suite may have left an override.
  const importDisplay = require("../services/dental-import-display") as typeof import("../services/dental-import-display");
  const prevImportHidden = importDisplay.__setImportValuesHiddenForTesting(true);
  let dbFactory: typeof import("../database/db-factory") | null = null;

  try {
    initMod.__setDbForTesting(mainDb as any);
    initMod.__initSchemaForTesting(mainDb as any);

    dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const exp = dbFactory.getDb("experiences") as Database.Database;
    const dent = dbFactory.getDb("dental") as Database.Database;
    const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
    const dentalStore = require("../services/dental-store") as typeof import("../services/dental-store");
    const plc = require("../services/profile-link-clicks") as typeof import("../services/profile-link-clicks");
    const expSeo = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;
    const dentalSeo = (require("./dental-seo") as typeof import("./dental-seo")).default as any;
    const orderStatsRoute = require("./admin-order-stats") as typeof import("./admin-order-stats");
    const svc = require("../services/admin-order-stats") as typeof import("../services/admin-order-stats");
    const analytics = require("../services/analytics-service") as typeof import("../services/analytics-service");

    // ── Schema: every column the new SQL names exists ─────────────────────
    {
      const cols = (mainDb.prepare("PRAGMA table_info(profile_link_clicks)").all() as Array<{ name: string }>).map((c) => c.name);
      assertEq(cols, ["id", "platform", "entity_type", "entity_id", "provider_id", "kind", "session_id", "is_bot", "is_test", "created_at"],
        "schema: profile_link_clicks columns");
      assertTrue(!cols.some((c) => /ip|email|epost|name|navn|url|utm/i.test(c)), "schema: no IP, e-mail, name, URL or utm column");
      // Additive: running the schema init twice on the same DB is a no-op.
      initMod.__initSchemaForTesting(mainDb as any);
      assertTrue(true, "schema: second init on an existing DB does not throw");
    }

    // ── Seed Opplevagent ──────────────────────────────────────────────────
    const provA = expStore.createProvider({
      navn: "Fjordpadling AS", org_nr: "912345670", fylke: "Rogaland", kommune: "Strand",
      hjemmeside: "https://fjordpadling.example.no", telefon: "+47 51 00 00 00",
      brreg_verified: 1, brreg_active: 1, verification_status: "verified",
    } as any);
    exp.prepare("UPDATE experience_providers SET slug = 'fjordpadling-as' WHERE id = ?").run(provA);
    const mkExp = (title: string, provider: string, fields: Record<string, unknown>): string => expStore.createExperience({
      title, provider_id: provider, provider_match_status: "matched", category: "natur_friluft", fylke: "Rogaland", kommune: "Strand",
      confidence: "high", verification_status: "verified", description: "Guidet kajakktur i fjorden med alt utstyr inkludert.", ...fields,
    } as any);
    const exp1 = mkExp("Kajakktur i fjorden", provA, { booking_url: "https://booking.fjordpadling.example.no/tur?id=7" });
    const exp1Slug = (expStore.getExperienceById(exp1) as any).slug as string;
    const exp2 = mkExp("Kveldspadling", provA, { booking_url: "https://booking.fjordpadling.example.no/kveld" });
    const expJs = mkExp("Ødelagt lenke 1", provA, {});
    const expData = mkExp("Ødelagt lenke 2", provA, {});
    const expBare = mkExp("Ødelagt lenke 3", provA, {});
    // Stored values that are not absolute http(s) URLs (legacy / corrupted rows).
    exp.prepare("UPDATE experiences SET booking_url = 'javascript:alert(1)' WHERE id = ?").run(expJs);
    exp.prepare("UPDATE experiences SET booking_url = 'data:text/html,<script>alert(1)</script>' WHERE id = ?").run(expData);
    exp.prepare("UPDATE experiences SET booking_url = 'www.evil.example' WHERE id = ?").run(expBare);
    const expHidden = mkExp("Skjult opplevelse", provA, { booking_url: "https://skjult.example.no", verification_status: "needs_review" });
    // N4: a provider whose only experience is unpublished has no /tilbyder/ page.
    const provUnpub = expStore.createProvider({ navn: "Upublisert Tilbyder AS", hjemmeside: "https://upublisert.example.no", brreg_verified: 1, brreg_active: 1, verification_status: "verified" } as any);
    mkExp("Upublisert tur", provUnpub, { verification_status: "needs_review" });

    // Gårdssalg producers: a public one, a hidden (delisted) one, a test one.
    const gsA = expStore.createProvider({ navn: "Sider fra Bakken", fylke: "Vestland", kommune: "Ullensvang", hjemmeside: "https://bakken-sider.example.no", telefon: "55 00 11 22", epost: "post@bakken-sider.example.no" } as any);
    exp.prepare("UPDATE experience_providers SET slug = 'sider-fra-bakken', producer_type = 'siderprodusent' WHERE id = ?").run(gsA);
    const gsHidden = expStore.createProvider({ navn: "Fjernet Bryggeri", hjemmeside: "https://fjernet.example.no" } as any);
    exp.prepare("UPDATE experience_providers SET slug = 'fjernet-bryggeri', producer_type = 'bryggeri', catalog_hidden = 1 WHERE id = ?").run(gsHidden);
    const gsTest = expStore.createProvider({ navn: "Testgård (kun test)", hjemmeside: "https://testgard.example.no" } as any);
    exp.prepare("UPDATE experience_providers SET slug = 'testgard', producer_type = 'bryggeri', catalog_hidden = 1, catalog_hidden_reason = 'test_fixture', is_test_provider = 1 WHERE id = ?").run(gsTest);

    // ── Seed Finn-tannlege ────────────────────────────────────────────────
    const clinic = dentalStore.createDentalAgent({
      navn: "Sentrum Tannklinikk AS", org_nr: "923456781", poststed: "OSLO", fylke: "Oslo", adresse: "Storgata 1",
      telefon: "22110099", epost: "post@sentrumtann.example.no", hjemmeside: "https://sentrumtann.example.no",
      organisasjonsform: "AS", naeringskode: "86.230",
    } as any);
    dent.prepare("UPDATE dental_agents SET online_booking_url = ?, directory_url = ?, catalog_class = 'klinikk' WHERE id = ?")
      .run("https://booking.sentrumtann.example.no/time", "https://www.facebook.com/sentrumtann", clinic);
    const clinicRejected = dentalStore.createDentalAgent({ navn: "Avvist Klinikk AS", org_nr: "923456782", hjemmeside: "https://avvist.example.no", organisasjonsform: "AS" } as any);
    dent.prepare("UPDATE dental_agents SET verification_status = 'rejected' WHERE id = ?").run(clinicRejected);
    // N4: an import-only row (no org.nr., organisasjonsform or naeringskode) is hidden on the profile page.
    const clinicImport = dentalStore.createDentalAgent({ navn: "Importert Klinikk", hjemmeside: "https://importert.example.no" } as any);
    const clinicJs = dentalStore.createDentalAgent({ navn: "Rar Lenke Klinikk AS", org_nr: "923456783", organisasjonsform: "AS" } as any);
    dent.prepare("UPDATE dental_agents SET online_booking_url = 'javascript:alert(document.cookie)' WHERE id = ?").run(clinicJs);

    // ── HTTP server: the real routers, one "host" per header ──────────────
    const express = require("express") as typeof import("express");
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => { req.lang = "no"; next(); });
    app.use("/api/track", plc.profileClickTrackRouter);
    app.use("/admin/api/ordre", orderStatsRoute.default);
    app.use((req: any, res: any, next: any) => (req.headers["x-test-host"] === "dental" ? dentalSeo(req, res, next) : expSeo(req, res, next)));
    server = http.createServer(app);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port as number;

    const UA_HUMAN = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    const UA_BOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)";
    const req = (method: string, path: string, o: { host?: "dental"; ua?: string; body?: unknown; key?: string } = {}): Promise<HttpResult> =>
      new Promise((resolve, reject) => {
        const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
        const headers: Record<string, string> = { "user-agent": o.ua ?? UA_HUMAN };
        if (o.host) headers["x-test-host"] = o.host;
        if (o.key) headers["x-admin-key"] = o.key;
        if (payload) { headers["content-type"] = "application/json"; headers["content-length"] = String(Buffer.byteLength(payload)); }
        const r = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c) => { text += c; });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
        });
        r.on("error", reject);
        if (payload) r.write(payload);
        r.end();
      });
    const clickCount = (): number => (mainDb.prepare("SELECT COUNT(*) AS n FROM profile_link_clicks").get() as { n: number }).n;
    const lastClick = (): any => mainDb.prepare("SELECT * FROM profile_link_clicks ORDER BY id DESC LIMIT 1").get();
    const hrefs = (html: string): string[] => [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

    // ── P: the profile pages ──────────────────────────────────────────────
    {
      const page = await req("GET", `/opplevelse/${exp1Slug}`);
      assertEq(page.status, 200, "p-opplevelse: page renders");
      const h = hrefs(page.text);
      assertTrue(h.includes(`/ut/opplevelse/${exp1}/booking`), "p-opplevelse: booking CTA goes through /ut/opplevelse/:id/booking");
      assertTrue(h.includes(`/ut/opplevelse/${exp1}/website`), "p-opplevelse: provider website link goes through /ut/opplevelse/:id/website");
      assertTrue(!h.some((x) => x.startsWith("https://booking.fjordpadling") || x.startsWith("https://fjordpadling.example.no")),
        "p-opplevelse: no direct href to the booking page or the provider website is left");
      assertTrue(/<a class="cta" href="\/ut\/opplevelse\/[^"]+\/booking" target="_blank" rel="noopener nofollow">/.test(page.text), "p-opplevelse: CTA keeps target and rel=noopener nofollow");
      assertTrue(page.text.includes(`data-track-surface="opplevelse" data-track-id="${exp1}" data-track-kind="phone"`), "p-opplevelse: tel: link carries the beacon attributes");
      assertTrue(page.text.includes("/api/track/profile-click"), "p-opplevelse: page has the beacon script");
      assertTrue(/href="tel:\+4751000000"/.test(page.text), "p-opplevelse: the tel: href itself is unchanged");

      const tilb = await req("GET", "/tilbyder/fjordpadling-as");
      assertEq(tilb.status, 200, "p-tilbyder: page renders");
      const th = hrefs(tilb.text);
      assertTrue(th.includes(`/ut/tilbyder/${provA}/website`), "p-tilbyder: website goes through /ut/tilbyder/:id/website");
      assertTrue(!th.some((x) => x.startsWith("https://fjordpadling.example.no")), "p-tilbyder: no direct website href left");
      assertTrue(tilb.text.includes(`data-track-surface="tilbyder" data-track-id="${provA}" data-track-kind="phone"`), "p-tilbyder: tel: link carries the beacon attributes");

      const gs = await req("GET", "/kategori/gardssalg/produsent/sider-fra-bakken");
      assertEq(gs.status, 200, "p-gardssalg: page renders");
      const gh = hrefs(gs.text);
      assertTrue(gh.includes(`/ut/gardssalg/${gsA}/website`), "p-gardssalg: website goes through /ut/gardssalg/:id/website");
      assertTrue(!gh.some((x) => x.startsWith("https://bakken-sider.example.no")), "p-gardssalg: no direct website href left");
      assertTrue(gs.text.includes(`data-track-surface="gardssalg" data-track-id="${gsA}" data-track-kind="phone"`), "p-gardssalg: tel: link carries the beacon attributes");
      assertTrue(gs.text.includes(`data-track-surface="gardssalg" data-track-id="${gsA}" data-track-kind="email"`), "p-gardssalg: mailto: link carries the beacon attributes");
      assertTrue(gs.text.includes('href="mailto:post@bakken-sider.example.no"'), "p-gardssalg: the mailto: href itself is unchanged");

      const kl = await req("GET", `/klinikk/id/${clinic}`, { host: "dental" });
      assertEq(kl.status, 200, "p-klinikk: page renders");
      const kh = hrefs(kl.text);
      for (const kind of ["booking", "website", "directory"]) {
        assertTrue(kh.includes(`/ut/klinikk/${clinic}/${kind}`), `p-klinikk: ${kind} goes through /ut/klinikk/:id/${kind}`);
      }
      assertTrue(!kh.some((x) => /^https:\/\/(booking\.)?sentrumtann\.example\.no|^https:\/\/www\.facebook\.com\/sentrumtann/.test(x)), "p-klinikk: no direct outgoing href left");
      assertTrue(/<a href="\/ut\/klinikk\/[^"]+\/booking" rel="nofollow noopener" target="_blank" class="btn-book">/.test(kl.text), "p-klinikk: booking keeps rel=nofollow noopener");
      assertTrue(kl.text.includes(`data-track-surface="klinikk" data-track-id="${clinic}" data-track-kind="phone"`), "p-klinikk: tel: links carry the beacon attributes");
      assertTrue(kl.text.includes(`data-track-surface="klinikk" data-track-id="${clinic}" data-track-kind="email"`), "p-klinikk: mailto: link carries the beacon attributes");
      assertTrue(kl.text.includes("/api/track/profile-click"), "p-klinikk: page has the beacon script");
    }

    // ── AC5: the redirects ────────────────────────────────────────────────
    const UTM_PROVIDER = "utm_source=opplevagent&utm_medium=referral&utm_campaign=provider_profile";
    const UTM_GS = "utm_source=opplevagent&utm_medium=referral&utm_campaign=gardssalg_profile";
    const UTM_CLINIC = "utm_source=finn-tannlege&utm_medium=referral&utm_campaign=clinic_profile";
    const okCases: Array<{ path: string; host?: "dental"; target: string; platform: string; entity: string; entityId: string; provider: string; kind: string; label: string }> = [
      { path: `/ut/opplevelse/${exp1}/booking`, target: "https://booking.fjordpadling.example.no/tur?id=7", platform: "opplevelser", entity: "experience", entityId: exp1, provider: provA, kind: "booking", label: "opplevelse booking" },
      { path: `/ut/opplevelse/${exp2}/booking`, target: "https://booking.fjordpadling.example.no/kveld", platform: "opplevelser", entity: "experience", entityId: exp2, provider: provA, kind: "booking", label: "another experience's own booking URL" },
      { path: `/ut/opplevelse/${exp1}/website`, target: `https://fjordpadling.example.no/?${UTM_PROVIDER}`, platform: "opplevelser", entity: "experience", entityId: exp1, provider: provA, kind: "website", label: "opplevelse website (provider site + UTM)" },
      { path: `/ut/tilbyder/${provA}/website`, target: `https://fjordpadling.example.no/?${UTM_PROVIDER}`, platform: "opplevelser", entity: "provider", entityId: provA, provider: provA, kind: "website", label: "tilbyder website" },
      { path: `/ut/gardssalg/${gsA}/website`, target: `https://bakken-sider.example.no/?${UTM_GS}`, platform: "gardssalg", entity: "provider", entityId: gsA, provider: gsA, kind: "website", label: "gårdssalg website" },
      { path: `/ut/klinikk/${clinic}/booking`, host: "dental", target: "https://booking.sentrumtann.example.no/time", platform: "tannlege", entity: "clinic", entityId: clinic, provider: clinic, kind: "booking", label: "klinikk booking" },
      { path: `/ut/klinikk/${clinic}/website`, host: "dental", target: `https://sentrumtann.example.no/?${UTM_CLINIC}`, platform: "tannlege", entity: "clinic", entityId: clinic, provider: clinic, kind: "website", label: "klinikk website" },
      { path: `/ut/klinikk/${clinic}/directory`, host: "dental", target: "https://www.facebook.com/sentrumtann", platform: "tannlege", entity: "clinic", entityId: clinic, provider: clinic, kind: "directory", label: "klinikk directory link" },
    ];
    for (const c of okCases) {
      const before = clickCount();
      const r = await req("GET", c.path, { host: c.host });
      assertEq(r.status, 302, `ac5 ${c.label}: 302`);
      assertEq(r.headers.location, c.target, `ac5 ${c.label}: Location is the DB target`);
      assertEq(clickCount(), before + 1, `ac5 ${c.label}: exactly one click counted`);
      const row = lastClick();
      assertEq([row.platform, row.entity_type, row.entity_id, row.provider_id, row.kind, row.is_bot, row.is_test], [c.platform, c.entity, c.entityId, c.provider, c.kind, 0, 0], `ac5 ${c.label}: row fields`);
      assertTrue(typeof row.session_id === "string" && row.session_id.length > 0 && !row.session_id.includes("127.0.0.1"), `ac5 ${c.label}: pseudonymised session id, no raw IP`);
      assertTrue(/noindex/.test(String(r.headers["x-robots-tag"] ?? "")), `ac5 ${c.label}: X-Robots-Tag noindex`);
    }

    // Query-parameter / header injection is ignored.
    {
      const r = await req("GET", `/ut/opplevelse/${exp1}/booking?to=https://evil.example&url=https://evil.example&target=//evil.example`);
      assertEq([r.status, r.headers.location], [302, "https://booking.fjordpadling.example.no/tur?id=7"], "ac5 open-redirect: query parameters never change the target");
    }

    const notFound: Array<{ path: string; host?: "dental"; label: string }> = [
      { path: "/ut/opplevelse/00000000-0000-0000-0000-000000000000/booking", label: "unknown experience id" },
      { path: `/ut/opplevelse/${exp1}/directory`, label: "kind not valid for the surface" },
      { path: `/ut/opplevelse/${exp1}/phone`, label: "phone is beacon-only" },
      { path: `/ut/opplevelse/${exp1}/evil`, label: "unknown kind" },
      { path: `/ut/evil/${exp1}/booking`, label: "unknown surface" },
      { path: `/ut/klinikk/${clinic}/website`, label: "klinikk surface on the opplevagent host" },
      { path: `/ut/opplevelse/${exp1}/booking`, host: "dental", label: "opplevelse surface on the finn-tannlege host" },
      { path: `/ut/opplevelse/${provA}/booking`, label: "provider id under the experience surface" },
      { path: `/ut/tilbyder/${exp1}/website`, label: "experience id under the tilbyder surface" },
      { path: `/ut/gardssalg/${clinic}/website`, label: "clinic id under the gårdssalg surface" },
      { path: `/ut/klinikk/${gsA}/website`, host: "dental", label: "provider id under the klinikk surface" },
      { path: `/ut/opplevelse/${expJs}/booking`, label: "stored javascript: booking URL" },
      { path: `/ut/opplevelse/${expData}/booking`, label: "stored data: booking URL" },
      { path: `/ut/opplevelse/${expBare}/booking`, label: "stored scheme-less booking URL" },
      { path: `/ut/klinikk/${clinicJs}/booking`, host: "dental", label: "stored javascript: clinic booking URL" },
      { path: `/ut/opplevelse/${expHidden}/booking`, label: "unpublished (needs_review) experience" },
      { path: `/ut/gardssalg/${gsHidden}/website`, label: "hidden (delisted) gårdssalg producer" },
      { path: `/ut/klinikk/${clinicRejected}/website`, host: "dental", label: "rejected clinic" },
      { path: `/ut/klinikk/${clinicImport}/website`, host: "dental", label: "hidden import-only clinic" },
      { path: `/ut/tilbyder/${provUnpub}/website`, label: "provider without a published experience (no /tilbyder/ page)" },
      { path: `/ut/klinikk/${clinic}/../../evil.example/website`, host: "dental", label: "path traversal" },
      { path: "/ut/opplevelse/https%3A%2F%2Fevil.example/booking", label: "URL as the id" },
      { path: `/ut/opplevelse/${exp1}%2F..%2Fx/booking`, label: "encoded slash in the id" },
    ];
    for (const c of notFound) {
      const before = clickCount();
      const r = await req("GET", c.path, { host: c.host });
      assertEq(r.status, 404, `ac5 404: ${c.label}`);
      assertTrue(r.headers.location === undefined, `ac5 404: ${c.label} — no Location header`);
      assertEq(clickCount(), before, `ac5 404: ${c.label} — no click recorded`);
    }

    // Test provider: redirect works (end-to-end test click), counted as test.
    {
      const r = await req("GET", `/ut/gardssalg/${gsTest}/website`);
      assertEq([r.status, r.headers.location], [302, `https://testgard.example.no/?${UTM_GS}`], "ac5 test provider: redirects to its own stored site");
      assertEq([lastClick().is_test, lastClick().provider_id], [1, gsTest], "ac5 test provider: row is_test = 1");
      // N4: a bot click on a test provider is stored with both flags; the overview counts it as bot (bot wins).
      const rb = await req("GET", `/ut/gardssalg/${gsTest}/website`, { ua: UA_BOT });
      assertEq([rb.status, lastClick().is_bot, lastClick().is_test], [302, 1, 1], "ac6 bot on test provider: stored with is_bot = 1 and is_test = 1");
    }

    // ── B1: the /ut routes chain the shared generalLimiter (same check as /sok, /reise) ──
    {
      const { generalLimiter } = require("../middleware/security") as typeof import("../middleware/security");
      for (const [name, router] of [["experiences-seo", expSeo], ["dental-seo", dentalSeo]] as const) {
        const layers = (router.stack as any[]).filter((l) => l.route && l.route.path === "/ut/:surface/:id/:kind" && l.route.methods.get);
        assertEq(layers.length, 1, `b1 ${name}: GET /ut/:surface/:id/:kind registered once`);
        const st = layers[0]?.route.stack as any[] | undefined;
        const i = st ? st.findIndex((s) => s.handle === generalLimiter) : -1;
        assertTrue(!!st && i >= 0 && i < st.length - 1, `b1 ${name}: /ut chains the exported generalLimiter instance before its handler`);
      }
    }

    // ── AC5: the beacon ───────────────────────────────────────────────────
    {
      let before = clickCount();
      let r = await req("POST", "/api/track/profile-click", { body: { surface: "gardssalg", id: gsA, kind: "phone" } });
      assertEq(r.status, 204, "beacon: phone → 204");
      assertEq(clickCount(), before + 1, "beacon: one row");
      assertEq([lastClick().platform, lastClick().kind, lastClick().entity_id], ["gardssalg", "phone", gsA], "beacon: row fields");
      r = await req("POST", "/api/track/profile-click", { body: { surface: "klinikk", id: clinic, kind: "email" } });
      assertEq([r.status, lastClick().platform, lastClick().kind], [204, "tannlege", "email"], "beacon: clinic e-mail → 204 + row");
      r = await req("POST", "/api/track/profile-click", { body: { surface: "opplevelse", id: exp1, kind: "phone" } });
      assertEq([r.status, lastClick().platform, lastClick().entity_type], [204, "opplevelser", "experience"], "beacon: experience phone → 204 + row");
      r = await req("POST", "/api/track/profile-click", { body: { surface: "tilbyder", id: provA, kind: "phone" } });
      assertEq([r.status, lastClick().entity_type], [204, "provider"], "beacon: tilbyder phone → 204 + row");

      before = clickCount();
      const bad: Array<[unknown, number, string]> = [
        [{ surface: "gardssalg", id: gsA, kind: "website" }, 400, "website is redirect-only"],
        [{ surface: "gardssalg", id: gsA, kind: "https://evil.example" }, 400, "URL as kind"],
        [{ surface: "evil", id: gsA, kind: "phone" }, 400, "unknown surface"],
        [{ surface: "gardssalg", id: "https://evil.example", kind: "phone" }, 400, "URL as id"],
        [{ surface: "gardssalg", kind: "phone" }, 400, "missing id"],
        [{ surface: "gardssalg", id: "nope-404", kind: "phone" }, 404, "unknown id"],
        [{ surface: "gardssalg", id: gsHidden, kind: "phone" }, 404, "hidden producer"],
        [{ surface: "klinikk", id: gsA, kind: "phone" }, 404, "provider id as clinic"],
      ];
      for (const [body, status, label] of bad) {
        const rr = await req("POST", "/api/track/profile-click", { body });
        assertEq(rr.status, status, `beacon: ${label} → ${status}`);
      }
      assertEq(clickCount(), before, "beacon: rejected requests record nothing");
    }

    // ── AC6: bot UA ───────────────────────────────────────────────────────
    {
      assertTrue(analytics.parseUserAgent(UA_BOT).isBot, "ac6: GPTBot UA is a bot per parseUserAgent");
      const r = await req("GET", `/ut/opplevelse/${exp1}/booking`, { ua: UA_BOT });
      assertEq([r.status, lastClick().is_bot], [302, 1], "ac6: bot click redirects and is stamped is_bot = 1");
      const r2 = await req("POST", "/api/track/profile-click", { ua: UA_BOT, body: { surface: "klinikk", id: clinic, kind: "phone" } });
      assertEq([r2.status, lastClick().is_bot], [204, 1], "ac6: bot beacon is stamped is_bot = 1");
    }

    // ── AC6: the overview equals a direct SQL count ────────────────────────
    {
      // Spread a few rows over days so the time series is exercised.
      mainDb.prepare("UPDATE profile_link_clicks SET created_at = '2026-11-02 10:00:00' WHERE id % 3 = 0").run();
      mainDb.prepare("UPDATE profile_link_clicks SET created_at = '2026-11-05 10:00:00' WHERE id % 3 = 1").run();
      mainDb.prepare("UPDATE profile_link_clicks SET created_at = '2026-11-09 10:00:00' WHERE id % 3 = 2").run();
      // One row outside the period.
      mainDb.prepare(`INSERT INTO profile_link_clicks (platform, entity_type, entity_id, provider_id, kind, session_id, is_bot, is_test, created_at)
                      VALUES ('opplevelser', 'experience', ?, ?, 'booking', 'x:y', 0, 0, '2026-09-01 10:00:00')`).run(exp1, provA);

      orderStatsRoute.__setAdminOrderStatsTestDbs(mainDb as any, exp as any);
      orderStatsRoute.__setAdminOrderStatsNowForTesting(new Date("2026-11-10T12:00:00Z"));
      const P = "fra=2026-11-01&til=2026-11-10";
      const ov = await req("GET", `/admin/api/ordre/oversikt?plattform=alle&${P}`, { key: ADMIN_KEY });
      assertEq(ov.status, 200, "overview: 200 with key");
      const body = JSON.parse(ov.text);
      const sql = (where: string, ...params: unknown[]) => (mainDb.prepare(
        `SELECT COUNT(*) AS n FROM profile_link_clicks WHERE created_at >= '2026-11-01' AND created_at < '2026-11-11' AND ${where}`).get(...params) as { n: number }).n;
      const typeOf: Record<string, string> = { booking: "booking", website: "nettside", phone: "telefon", email: "e_post", directory: "annet" };
      for (const p of ["opplevelser", "gardssalg", "tannlege"]) {
        const h = body.henvisninger?.[p];
        assertTrue(h && h.available === true, `overview ${p}: block present`);
        if (!h || !h.available) continue;
        assertEq(h.total, sql("platform = ? AND is_bot = 0 AND is_test = 0", p), `overview ${p}: main total = SQL (no bots, no test)`);
        assertEq(h.bot.total, sql("platform = ? AND is_bot = 1", p), `overview ${p}: bot total = SQL`);
        assertEq(h.test.total, sql("platform = ? AND is_bot = 0 AND is_test = 1", p), `overview ${p}: test total = SQL`);
        for (const [kind, t] of Object.entries(typeOf)) {
          if (t === "annet" && p !== "tannlege") continue;
          assertEq(h.by_type[t], sql("platform = ? AND is_bot = 0 AND is_test = 0 AND kind = ?", p, kind), `overview ${p}: by_type.${t} = SQL`);
        }
        assertEq(h.series.reduce((a: number, s: any) => a + s.total, 0), h.total, `overview ${p}: series sums to the total`);
        assertEq(h.series.length, 10, `overview ${p}: one bucket per day`);
        assertEq(h.series.find((s: any) => s.bucket === "2026-11-05")?.total, sql("platform = ? AND is_bot = 0 AND is_test = 0 AND date(created_at) = '2026-11-05'", p), `overview ${p}: day bucket = SQL`);
      }
      const opp = body.henvisninger.opplevelser;
      assertTrue(opp.bot.total >= 1 && opp.total === sql("platform = 'opplevelser' AND is_bot = 0"), "ac6: the GPTBot click is in bot, not in the main number");
      const gsH = body.henvisninger.gardssalg;
      assertEq(gsH.test.providers, [{ provider_id: gsTest, name: "Testgård (kun test)", total: 1 }], "overview gardssalg: test provider in its own row, named");
      assertEq(gsH.test.total, 1, "overview gardssalg: test click not in the main total");
      assertEq(gsH.bot.total, sql("platform = 'gardssalg' AND is_bot = 1"), "overview gardssalg: the bot click on the test provider is counted as bot, not test");
      assertTrue(body.henvisninger.rfb && body.henvisninger.rfb.available, "overview: RFB block still present for plattform=alle");
      assertTrue(svc.PROFIL_HENVISNING_TYPER.every((t) => t in opp.by_type && t in opp.type_forklaring), "overview: every type has a count and an explanation");

      const gsOnly = JSON.parse((await req("GET", `/admin/api/ordre/oversikt?plattform=gardssalg&${P}`, { key: ADMIN_KEY })).text);
      assertTrue(gsOnly.henvisninger && gsOnly.henvisninger.gardssalg && !gsOnly.henvisninger.rfb && !gsOnly.henvisninger.opplevelser && !gsOnly.henvisninger.tannlege,
        "overview: plattform=gardssalg carries only the gårdssalg clicks");
      const rfbOnly = JSON.parse((await req("GET", `/admin/api/ordre/oversikt?plattform=rfb&${P}`, { key: ADMIN_KEY })).text);
      assertTrue(rfbOnly.henvisninger && rfbOnly.henvisninger.rfb && Object.keys(rfbOnly.henvisninger).length === 1, "overview: plattform=rfb carries only the RFB clicks");

      // Service on its own (unavailable path).
      const empty = new Database(":memory:");
      const per = svc.parseOversiktParams({ fra: "2026-11-01", til: "2026-11-10" }, new Date("2026-11-10T12:00:00Z"));
      if (per.ok) {
        const u = svc.computeProfilReferrals(empty as any, "tannlege", per.params.periode, "dag");
        assertEq(u.available, false, "service: no table → available: false");
      }
      empty.close();

      // No PII / session data in the JSON or the CSV.
      const sessions = (mainDb.prepare("SELECT DISTINCT session_id FROM profile_link_clicks WHERE session_id IS NOT NULL").all() as Array<{ session_id: string }>).map((r) => r.session_id);
      const csv = await req("GET", `/admin/api/ordre/eksport.csv?plattform=alle&${P}`, { key: ADMIN_KEY });
      assertEq(csv.status, 200, "csv: 200");
      for (const [label, text] of [["overview", ov.text], ["csv", csv.text]] as const) {
        assertTrue(!sessions.some((s) => s.length > 3 && text.includes(s)), `${label}: no session id`);
        assertTrue(!/session_id|ip_hash|user_agent|GPTBot|Mozilla/.test(text), `${label}: no session / IP / UA field or value`);
        assertTrue(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text), `${label}: no e-mail address`);
        assertTrue(!/sentrumtann\.example|bakken-sider\.example|fjordpadling\.example/.test(text), `${label}: no target URL`);
      }
      // CSV rows: one per aggregate, measure antall_klikk, totals equal the JSON.
      const lines = csv.text.replace(/^﻿/, "").trim().split(/\r\n/).map((l) => l.split(","));
      const hdr = lines[0];
      const vi = hdr.indexOf("verdi");
      const find = (pl: string, om: string, kat: string, key: string) => lines.find((d) => d[0] === pl && d[1] === om && d[2] === kat && d[3] === key)?.[vi];
      for (const p of ["opplevelser", "gardssalg", "tannlege"]) {
        assertEq(find(p, "ekte", "henvisninger_total", ""), String(body.henvisninger[p].total), `csv ${p}: main click total = JSON`);
        assertEq(find(p, "bot", "henvisninger_total", ""), String(body.henvisninger[p].bot.total), `csv ${p}: bot total in its own row`);
        assertEq(find(p, "test", "henvisninger_total", ""), String(body.henvisninger[p].test.total), `csv ${p}: test total in its own row`);
        assertEq(find(p, "ekte", "henvisninger_type", "booking") ?? (p === "gardssalg" ? "0" : undefined), String(body.henvisninger[p].by_type.booking), `csv ${p}: booking clicks`);
      }
      assertEq(find("gardssalg", "test", "henvisninger_tilbyder", gsTest), "1", "csv gardssalg: test provider row");
      const profRows = lines.slice(1).filter((d) => ["opplevelser", "tannlege"].includes(d[0]) || (d[0] === "gardssalg" && d[2].startsWith("henvisninger_")));
      assertTrue(profRows.length > 0 && profRows.every((d) => d[5] === "antall_klikk" || d[5] === "tilgjengelig"), "csv: S4 rows use the antall_klikk measure only");
      orderStatsRoute.__setAdminOrderStatsTestDbs(null);
      orderStatsRoute.__setAdminOrderStatsNowForTesting(null);
    }

    // ── Admin page: the S4 sections ───────────────────────────────────────
    {
      const fs = require("fs") as typeof import("fs");
      const page = fs.readFileSync(orderStatsRoute.ADMIN_ORDRE_HTML, "utf8");
      assertTrue(page.includes("Opplevagent opplevelser — henvisninger") && page.includes("Finn-tannlege — henvisninger") && page.includes("Opplevagent gårdssalg — henvisninger"),
        "page: sections for the Opplevagent and Finn-tannlege clicks");
      assertTrue(!/innerHTML/.test(page.replace(/never innerHTML/g, "")), "page: still writes data with textContent only");
    }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${err?.stack || err}`);
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    try { dbFactory?.__resetDbFactoryForTesting(); } catch { /* ignore */ }
    restoreModuleCache();
    importDisplay.__setImportValuesHiddenForTesting(prevImportHidden);
    initMod.__setDbForTesting(prevMainDb as any);
    try { mainDb.close(); } catch { /* ignore */ }
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runProfileLinkClicksTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0);
  });
}
