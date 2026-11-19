/**
 * marketplace-selvreg-uten-nettside.test.ts — dev-request
 * selvregistrering-uten-nettside, slice F1.
 *
 * A producer without a website (REKO-ring / market seller) must be able to
 * self-register, and the registration must stop inventing a website (our own
 * origin) and a location (Oslo's 59.91/10.75 for every city).
 *
 * Runs the REAL POST /register handler pulled off the marketplace router
 * with a fake req/res (same harness as marketplace-quarantine-gates.test.ts)
 * against its own in-memory DB via __setDbForTesting/__initSchemaForTesting.
 * REGISTRATION_PRECHECK_ENABLED is set to "false" for the run (no network);
 * the pre-check input is read with gatherRegistrationPrecheckInput instead.
 *
 * Cases:
 *   AK1  registration without a website → stored url is "" (never our origin)
 *   AK2  city «Røros» without coordinates → lat/lng NULL, city kept (the
 *        geocode worker places it later); never Oslo
 *   AK3  the dry-run script's pure selection finds the two bad cases + count
 *   +    url present but invalid → 400; non-http(s) url → 400; valid url kept
 *   +    org.nr invalid (length / MOD11) → 400; valid org.nr → one
 *        `org_nr:` tag the pre-check reads as self-reported
 *   +    phone invalid → 400; phone + «Hvor selger du?» → agent_knowledge
 *   +    lat without lng → 400; selger.html no longer sends origin / 59.91
 *
 * Exported runSelvregUtenNettsideTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/marketplace-selvreg-uten-nettside.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HandlerResult {
  status: number;
  body: any;
}

export async function runSelvregUtenNettsideTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  // ── AK3: pure selection of the dry-run script (no DB) ──────────────────
  {
    const { buildSuspectReport, isOwnOriginUrl } = require("../../scripts/selvreg-own-origin-oslo-dry-run") as
      typeof import("../../scripts/selvreg-own-origin-oslo-dry-run");
    const rows = [
      // bad 1: our own origin as the website
      { id: "a", name: "Eggbonden", url: "https://rettfrabonden.com", city: "Oslo", lat: 59.91, lng: 10.75, origin: "self_registered" },
      // bad 2: Oslo coordinates, city Røros
      { id: "b", name: "Rørosbonden", url: "", city: "Røros", lat: 59.91, lng: 10.75, origin: "self_registered" },
      // fine: real site, real Oslo
      { id: "c", name: "Oslogården", url: "https://oslogarden.no", city: "Oslo", lat: 59.91, lng: 10.75, origin: "self_registered" },
      // fine: geocoded Røros
      { id: "d", name: "Fjellgården", url: "", city: "Røros", lat: 62.5747, lng: 11.3842, origin: "self_registered" },
      // not self-registered: never listed
      { id: "e", name: "Discovery", url: "https://rettfrabonden.com/", city: "Bergen", lat: 59.91, lng: 10.75, origin: "discovery" },
      // no coordinates at all
      { id: "f", name: "Ny", url: "", city: "Røros", lat: null, lng: null, origin: "self_registered" },
    ];
    const report = buildSuspectReport(rows);
    assertEq(report.count, 2, "ak3: dry-run selection reports count 2");
    assertEq(report.rows.map((r) => r.id), ["a", "b"], "ak3: the two bad cases are the ones listed");
    assertEq(report.rows[0]!.reasons, ["own_origin_url"], "ak3: own-origin row has reason own_origin_url");
    assertEq(report.rows[1]!.reasons, ["oslo_coords_not_oslo"], "ak3: Røros-with-Oslo-coords row has reason oslo_coords_not_oslo");
    assertEq(report.by_reason, { own_origin_url: 1, oslo_coords_not_oslo: 1 }, "ak3: by_reason counts");
    for (const v of ["https://rettfrabonden.com", "http://rettfrabonden.com/", "https://www.rettfrabonden.com/", "HTTPS://RettFraBonden.com", "https://lokal.fly.dev"]) {
      assertTrue(isOwnOriginUrl(v), `ak3: own-origin variant matched: ${v}`);
    }
    for (const v of ["", null, "https://rettfrabonden.com/produsent/x", "https://minrettfrabonden.com", "https://garden.no"]) {
      assertTrue(!isOwnOriginUrl(v as any), `ak3: not own origin: ${String(v)}`);
    }
  }

  // ── selger.html source: the invented values are gone ──────────────────
  {
    const fs = require("fs");
    const path = require("path");
    const html: string = fs.readFileSync(path.join(__dirname, "..", "public", "selger.html"), "utf8");
    const m = html.match(/getElementById\('btnRegister'\)\.addEventListener[\s\S]*?var resp = await fetch\(API \+ '\/register'/);
    assertTrue(!!m, "form: btnRegister handler located");
    const block = m ? m[0] : "";
    assertTrue(!block.includes("window.location.origin"), "form: register body no longer uses window.location.origin as url");
    assertTrue(!/59\.91|10\.75/.test(block), "form: register body has no hard-coded Oslo coordinates");
    for (const id of ["regWebsite", "regOrgNr", "regPhone", "regSalesPlace"]) {
      assertTrue(html.includes(`id="${id}"`), `form: input #${id} exists`);
    }
  }

  // ── Route tests on an in-memory DB ──────────────────────────────────────
  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");
  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();
  const prevPrecheck = process.env.REGISTRATION_PRECHECK_ENABLED;
  const prevConfirm = process.env.REGISTRATION_CONFIRMATION_EMAIL_ENABLED;
  process.env.REGISTRATION_PRECHECK_ENABLED = "false";
  process.env.REGISTRATION_CONFIRMATION_EMAIL_ENABLED = "false";

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = ON");

  function findRouteHandler(router: any, routePath: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find(
      (l: any) => l.route && l.route.path === routePath && l.route.methods?.[method],
    );
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${routePath}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(body: any): any {
    return {
      params: {}, body, query: {}, headers: {}, ip: "127.0.0.1", lang: "no", protocol: "https",
      get(name: string) { return name.toLowerCase() === "host" ? "rettfrabonden.com" : undefined; },
    };
  }
  function invoke(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body }); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { settle(p); return res; },
        send(p: any) { settle(p); return res; },
        end() { settle(undefined); return res; },
        header() { return res; }, set() { return res; }, type() { return res; }, setHeader() { return res; },
      };
      try {
        const p = handler(req, res, () => settle({ __next: true }));
        if (p && typeof p.catch === "function") p.catch((e: any) => settle({ __error: String(e) }));
      } catch (e) {
        settle({ __error: String(e) });
      }
    });
  }

  let n = 0;
  const baseBody = (over: Record<string, unknown> = {}): any => {
    n++;
    return {
      name: `Testbonden ${n} Røros`,
      description: "Vi selger egg og grønnsaker på REKO-ringen hver torsdag.",
      provider: `Testbonden ${n}`,
      contactEmail: `bonde${n}@example.test`,
      role: "producer",
      categories: ["eggs"],
      tags: ["local"],
      skills: [{ id: "sell-eggs", name: "Egg", description: "Egg fra gården", tags: ["eggs", "local"] }],
      ...over,
    };
  };

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    const marketplaceRoutePath = require.resolve("./marketplace");
    delete require.cache[marketplaceRoutePath];
    const marketplaceRouter = require("./marketplace").default as any;
    const { marketplaceRegistry } = require("../services/marketplace-registry") as
      typeof import("../services/marketplace-registry");
    marketplaceRegistry._agentsCache = null;
    const { gatherRegistrationPrecheckInput } = require("../services/registration-precheck") as
      typeof import("../services/registration-precheck");
    const registerHandler = findRouteHandler(marketplaceRouter, "/register", "post");
    const row = (id: string): any => testDb.prepare("SELECT url, lat, lng, city, tags, org_nr FROM agents WHERE id = ?").get(id);

    // AK1 — no website
    {
      const r = await invoke(registerHandler, makeReq(baseBody({ location: { city: "Røros" } })));
      assertEq(r.status, 201, "ak1: registration without url → 201");
      const id = r.body?.data?.id;
      const a = id ? row(id) : null;
      assertEq(a?.url, "", "ak1: stored url is empty (no website)");
      assertTrue(!!a && !/rettfrabonden\.com/i.test(String(a.url)), "ak1: stored url is not our own origin");
      // AK2 — Røros, no Oslo coordinates
      assertEq(a?.city, "Røros", "ak2: city Røros stored");
      assertEq([a?.lat, a?.lng], [null, null], "ak2: no coordinates stored (geocode worker fills them from the city)");
      assertTrue(!(a?.lat === 59.91 && a?.lng === 10.75), "ak2: Røros does not get Oslo coordinates");
      const pre = id ? gatherRegistrationPrecheckInput(getDb(), id) : null;
      assertEq(pre?.url ?? null, "", "ak1: pre-check sees no website (url \"\")");
    }

    // empty-string url is the same as none
    {
      const r = await invoke(registerHandler, makeReq(baseBody({ url: "" })));
      assertEq(r.status, 201, "url \"\" → 201 (treated as no website)");
    }

    // url present but invalid → 400; non-http(s) → 400; valid → kept
    {
      const r1 = await invoke(registerHandler, makeReq(baseBody({ url: "ikke en nettside" })));
      assertEq(r1.status, 400, "url present but invalid → 400");
      const r2 = await invoke(registerHandler, makeReq(baseBody({ url: "javascript:alert(1)" })));
      assertEq(r2.status, 400, "url with non-http(s) scheme → 400");
      const r3 = await invoke(registerHandler, makeReq(baseBody({ url: "https://minogard.no" })));
      assertEq(r3.status, 201, "valid url → 201");
      assertEq(row(r3.body.data.id)?.url, "https://minogard.no", "valid url stored as given");
    }

    // lat without lng → 400; explicit coordinates from an API client still accepted
    {
      const r1 = await invoke(registerHandler, makeReq(baseBody({ location: { city: "Røros", lat: 62.57 } })));
      assertEq(r1.status, 400, "lat without lng → 400");
      const r2 = await invoke(registerHandler, makeReq(baseBody({ location: { city: "Røros", lat: 62.5747, lng: 11.3842 } })));
      assertEq(r2.status, 201, "explicit lat+lng still accepted");
      const a = row(r2.body.data.id);
      assertEq([a?.lat, a?.lng], [62.5747, 11.3842], "explicit lat+lng stored as given");
    }

    // org.nr
    {
      const bad1 = await invoke(registerHandler, makeReq(baseBody({ orgNr: "12345" })));
      assertEq(bad1.status, 400, "org.nr too short → 400");
      const bad2 = await invoke(registerHandler, makeReq(baseBody({ orgNr: "987654321" })));
      assertEq(bad2.status, 400, "org.nr failing MOD11 → 400");
      const bad3 = await invoke(registerHandler, makeReq(baseBody({ orgNr: "98765432a" })));
      assertEq(bad3.status, 400, "org.nr with a letter → 400");
      const ok = await invoke(registerHandler, makeReq(baseBody({
        orgNr: "987 654 325",
        tags: ["local", "org_nr:923609016"], // a body-supplied tag is replaced by the validated one
      })));
      assertEq(ok.status, 201, "valid org.nr (with spaces) → 201");
      const a = row(ok.body.data.id);
      const tags: string[] = JSON.parse(a?.tags || "[]");
      assertEq(tags.filter((t) => t.startsWith("org_nr:")), ["org_nr:987654325"], "valid org.nr stored as exactly one org_nr: tag");
      assertEq(a?.org_nr ?? null, null, "agents.org_nr (audited column) is not written by self-registration");
      const pre = gatherRegistrationPrecheckInput(getDb(), ok.body.data.id);
      assertEq(pre?.orgNr, "987654325", "pre-check reads the registrant's org.nr");
      assertEq(pre?.orgNrSelfReported, true, "pre-check treats it as self-reported");
    }

    // phone + «Hvor selger du?»
    {
      const bad = await invoke(registerHandler, makeReq(baseBody({ phone: "123" })));
      assertEq(bad.status, 400, "invalid phone → 400");
      const longPlace = await invoke(registerHandler, makeReq(baseBody({ salesPlace: "x".repeat(121) })));
      assertEq(longPlace.status, 400, "salesPlace over 120 chars → 400");
      const ok = await invoke(registerHandler, makeReq(baseBody({ phone: "912 34 567", salesPlace: "REKO-ringen Røros" })));
      assertEq(ok.status, 201, "phone + salesPlace → 201");
      const k = testDb.prepare("SELECT phone, delivery_options FROM agent_knowledge WHERE agent_id = ?").get(ok.body.data.id) as any;
      assertEq(k?.phone, "912 34 567", "phone stored in agent_knowledge.phone");
      assertEq(JSON.parse(k?.delivery_options || "[]"), ["REKO-ringen Røros"], "salesPlace stored in agent_knowledge.delivery_options");
      const plain = await invoke(registerHandler, makeReq(baseBody()));
      const none = testDb.prepare("SELECT 1 FROM agent_knowledge WHERE agent_id = ?").get(plain.body.data.id);
      assertTrue(!none, "no knowledge row written when neither phone nor salesPlace is given");
    }

    // still quarantined like every self-registration
    {
      const cnt = testDb.prepare("SELECT COUNT(*) AS c FROM agents WHERE origin = 'self_registered' AND is_vetted = 0").get() as any;
      const all = testDb.prepare("SELECT COUNT(*) AS c FROM agents").get() as any;
      assertEq(cnt.c, all.c, "every agent created here is self_registered + unvetted");
    }
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${String(err?.stack || err)}`);
  } finally {
    if (prevPrecheck === undefined) delete process.env.REGISTRATION_PRECHECK_ENABLED;
    else process.env.REGISTRATION_PRECHECK_ENABLED = prevPrecheck;
    if (prevConfirm === undefined) delete process.env.REGISTRATION_CONFIRMATION_EMAIL_ENABLED;
    else process.env.REGISTRATION_CONFIRMATION_EMAIL_ENABLED = prevConfirm;
    if (prevDb) __setDbForTesting(prevDb as any);
    try {
      const { marketplaceRegistry } = require("../services/marketplace-registry") as
        typeof import("../services/marketplace-registry");
      marketplaceRegistry._agentsCache = null;
    } catch { /* ignore */ }
    testDb.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runSelvregUtenNettsideTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      for (const f of r.failures) console.log(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
