/**
 * owner-features-s2b.test.ts — dev-request 2026-10-22-rfb-mine-valg-eierbrytere,
 * slice S2b: the «Mine valg» owner page on top of the S2a API.
 *
 *   gate       allowlist off ⇒ page/POSTs 404 and the /eier portal is
 *              byte-identical (no «Mine valg» card); order allowlist 404 →
 *              session 401 → verified owner 403 → Origin 403 → rate limit 429.
 *   page       groups/order from the registry, coming_soon disabled «Kommer
 *              snart», guarantees «Alltid», lock/requirement reasons in
 *              Norwegian, orders.* rows revealed when orders are on, status line.
 *   AC10       a fixture registry entry shows up in its group with no UI change.
 *   switch     confirm panel (confirmOn) → confirmed POST → column + one audit
 *              row + one batch; coming_soon POST blocked, nothing written.
 *   levels     preview; apply changes only live keys, one audit per changed
 *              key, unmet requirement skipped with reason; current level.
 *   undo       reverts the newest change (a level as one unit) with audit rows;
 *              refuses an older batch, a second undo, and a key changed since.
 *   log        newest first, who/when, «Angret», pagination.
 *   intro      (T7) the «Nyheter og tips» question shown until answered;
 *              answer stored once (owner_feature_prompt); full T7 cases in
 *              owner-features-t7.test.ts;
 *              coming_soon comms.news writes no setting; live fixture applies.
 *   N1         the old Bestillinger routes write the orders.enabled audit row.
 *   escaping   agent name, registry text and query parameters are escaped.
 *   AC13       page CSS: dark mode, ≥ 44 px targets, no fixed wide widths.
 *
 * Real routers + services on the production schema in an in-memory DB;
 * handlers pulled off the router stack (same harness as owner-features-s2a).
 * Exported runOwnerFeaturesS2bTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/owner-features-s2b.test.ts
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
  headers: Record<string, string>;
}

const ALLOW_ENV = "OWNER_FEATURES_ALLOWED_SUBJECTS";
const GATE_ENV = "OWNER_VERIFIED_OWNER_GATE_ENABLED";
const OWNED_ID = "s2b-owned";
const UNBADGED_ID = "s2b-unbadged";
const EMAILMATCH_ID = "s2b-emailmatch";
const OTHER_ID = "s2b-other";
const LOG_ID = "s2b-log";
const XSS_ID = "s2b-xss";
const XSS_NAME = `Gard <script>alert("x")</script> & Sønn`;

function seedProducer(db: Database.Database, id: string, o: { claimed: boolean; isVerified: boolean; name?: string }): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
        order_notifications_opt_in)
     VALUES (?, ?, 'Testprodusent for Mine valg.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, ?, 'discovery', 'rfb', 0, ?, 0)`,
  ).run(
    id, o.name ?? `Valgside Gard ${id}`, `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`,
    o.isVerified ? 1 : 0, o.claimed ? "2026-10-01T00:00:00.000Z" : null,
  );
  db.prepare(
    `INSERT INTO agent_knowledge (agent_id, email, website, about, verification_status, verified_second_line)
     VALUES (?, ?, ?, 'Liten familiegård.', 'verified', 0)`,
  ).run(id, `post@${id}.example.no`, `https://${id}.example.no`);
}

export async function runOwnerFeaturesS2bTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.info(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.info("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.info(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.info(`  ✗ ${label}`);
    }
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const prevAllow = process.env[ALLOW_ENV];
  const prevGate = process.env[GATE_ENV];
  const setAllow = (v: string | null) => { if (v === null) delete process.env[ALLOW_ENV]; else process.env[ALLOW_ENV] = v; };

  function findRouteHandler(router: any, path: string, method: "get" | "post" | "put"): Function {
    const layer = (router.stack as any[]).find(
      (l: any) => l.route && l.route.path === path && l.route.methods?.[method],
    );
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; body?: any; query?: Record<string, string>; token?: string; headers?: Record<string, string> }): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com", ...(o.headers || {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    return {
      method: "GET", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: o.body, query: o.query || {}, headers, cookies: {},
      ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
  }
  function invoke(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const headers: Record<string, string> = {};
      const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body, headers }); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { settle(p); return res; },
        send(p: any) { settle(p); return res; },
        redirect(c: number, loc: string) { status = c; settle({ __redirect: loc }); return res; },
        end() { settle(undefined); return res; },
        header() { return res; }, set() { return res; }, type() { return res; }, cookie() { return res; },
        setHeader(k: string, v: string) { headers[k.toLowerCase()] = String(v); return res; },
      };
      try {
        const p = handler(req, res, (err?: any) => settle({ __next: true, err: err ? String(err) : undefined }));
        if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
      } catch (err) {
        settle({ __error: String(err) });
      }
    });
  }

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence route chatter */ };

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    delete process.env[GATE_ENV];
    for (const m of ["./owner-portal", "./owner-features"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const portalMod = require("./owner-portal") as typeof import("./owner-portal");
    const featuresMod = require("./owner-features") as typeof import("./owner-features");
    const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");
    const rs = require("../owner-features/resolve") as typeof import("../owner-features/resolve");
    const ch = require("../owner-features/changes") as typeof import("../owner-features/changes");
    const pg = require("../owner-features/page") as typeof import("../owner-features/page");
    type Entry = import("../owner-features/registry").OwnerFeatureEntry;

    seedProducer(db, OWNED_ID, { claimed: true, isVerified: true });
    seedProducer(db, UNBADGED_ID, { claimed: true, isVerified: false });
    seedProducer(db, EMAILMATCH_ID, { claimed: false, isVerified: false });
    seedProducer(db, OTHER_ID, { claimed: true, isVerified: true });
    seedProducer(db, LOG_ID, { claimed: true, isVerified: true });
    seedProducer(db, XSS_ID, { claimed: true, isVerified: true, name: XSS_NAME });

    const tokens: Record<string, string> = {};
    for (const id of [OWNED_ID, UNBADGED_ID, EMAILMATCH_ID, OTHER_ID, LOG_ID, XSS_ID]) {
      tokens[id] = `tok-${id}`;
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${id}`, `post@${id}.example.no`, tokens[id], id, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
    }
    const ALL_ALLOWED = [OWNED_ID, UNBADGED_ID, EMAILMATCH_ID, OTHER_ID, LOG_ID, XSS_ID].map((id) => `rfb:${id}`).join(",");

    const H = {
      page: findRouteHandler(featuresMod.default, "/eier/:agentId/valg", "get"),
      sett: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/sett", "post"),
      niva: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/niva", "post"),
      angre: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/angre", "post"),
      intro: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/intro", "post"),
      portal: findRouteHandler(portalMod.default, "/eier/:agentId/portal", "get"),
      optInApi: findRouteHandler(portalMod.default, "/api/agents/:id/order-notifications", "post"),
      optInForm: findRouteHandler(portalMod.default, "/eier/:agentId/order-notifications", "post"),
    };
    const page = (id: string, query: Record<string, string> = {}, token: string | undefined = tokens[id]) =>
      invoke(H.page, makeReq({ params: { agentId: id }, query, token }));
    const post = (h: Function, id: string, body: any, token: string | undefined = tokens[id], headers: Record<string, string> = {}) =>
      invoke(h, makeReq({ params: { agentId: id }, body, token, headers }));
    const portal = (id: string) => invoke(H.portal, makeReq({ params: { agentId: id }, token: tokens[id] }));
    const optInCol = (id: string) => (db.prepare("SELECT order_notifications_opt_in AS v FROM agents WHERE id = ?").get(id) as any).v;
    const audits = (id: string) => db.prepare("SELECT key, old_json, new_json, actor, actor_detail FROM owner_feature_audit WHERE subject_id = ? ORDER BY id").all(id) as any[];
    const batches = (id: string) => db.prepare("SELECT * FROM owner_feature_change_batch WHERE subject_id = ? ORDER BY id").all(id) as any[];
    const settingsRows = (id: string) => (db.prepare("SELECT COUNT(*) AS n FROM owner_feature_settings WHERE subject_id = ?").get(id) as any).n;
    const loc = (r: HandlerResult) => String(r.body?.__redirect ?? "");
    const html = (r: HandlerResult) => String(r.body ?? "");
    const resetCap = () => featuresMod.__resetOwnerFeaturesRateLimitForTesting();

    // ── Allowlist off ⇒ nothing observable ───────────────────────────────────
    setAllow(null);
    const portalOff = await portal(OWNED_ID);
    assertEq(portalOff.status, 200, "allowlist off: portal 200");
    assertTrue(!html(portalOff).includes(`/eier/${OWNED_ID}/valg`) && !html(portalOff).includes(`id="mine-valg"`), "allowlist off: portal has no «Mine valg» card or link");
    setAllow(`rfb:${OTHER_ID}`);
    const portalOther = await portal(OWNED_ID);
    assertEq(html(portalOther), html(portalOff), "allowlist lists another subject: portal byte-identical to allowlist unset");
    setAllow("");
    assertEq(html(await portal(OWNED_ID)), html(portalOff), "allowlist empty string: portal byte-identical");
    setAllow(null);
    assertEq((await page(OWNED_ID)).status, 404, "allowlist off: GET /eier/:id/valg → 404");
    for (const [name, h, body] of [
      ["sett", H.sett, { key: "orders.enabled", value: "true", confirmed: "1" }],
      ["niva", H.niva, { level: "ta_imot_bestillinger", confirmed: "1" }],
      ["angre", H.angre, { batch: "1" }],
      ["intro", H.intro, { answer: "yes" }],
    ] as Array<[string, Function, any]>) {
      assertEq((await post(h, OWNED_ID, body)).status, 404, `allowlist off: POST valg/${name} → 404`);
    }
    assertEq([optInCol(OWNED_ID), audits(OWNED_ID).length, batches(OWNED_ID).length, settingsRows(OWNED_ID)], [0, 0, 0, 0],
      "allowlist off: nothing written");
    assertEq((db.prepare("SELECT COUNT(*) AS n FROM owner_feature_intro").get() as any).n, 0, "allowlist off: no intro row");
    assertEq((db.prepare("SELECT COUNT(*) AS n FROM owner_feature_prompt").get() as any).n, 0, "allowlist off (T7): no prompt row");

    // ── Check order ──────────────────────────────────────────────────────────
    assertEq((await page(OWNED_ID, {}, "")).status, 404, "order: allowlist before session (no session, not listed → 404)");
    setAllow(ALL_ALLOWED);
    assertEq((await page(OWNED_ID, {}, "")).status, 401, "order: listed, no session → 401");
    assertEq((await page(OWNED_ID, {}, "tok-bogus")).status, 401, "order: unknown token → 401");
    assertEq((await post(H.sett, OWNED_ID, { key: "orders.enabled", value: "true", confirmed: "1" }, "")).status, 401, "order: POST without session → 401");
    assertEq((await page(OWNED_ID, {}, tokens[OTHER_ID])).status, 403, "order: another agent's session → 403");
    const em = await page(EMAILMATCH_ID);
    assertEq(em.status, 403, "order: e-mail-match session without verified ownership → 403");
    assertTrue(html(em).includes("Eierskapet til profilen er ikke bekreftet"), "order: 403 page explains ownership");
    assertEq((await post(H.sett, EMAILMATCH_ID, { key: "comms.beta", value: "true" })).status, 403, "order: POST e-mail-match → 403");
    const xs = await post(H.sett, OWNED_ID, { key: "orders.enabled", value: "true", confirmed: "1" }, tokens[OWNED_ID], { origin: "https://evil.example" });
    assertEq([xs.status, optInCol(OWNED_ID), audits(OWNED_ID).length], [403, 0, 0], "order: cross-site Origin on POST → 403, nothing written");
    assertEq((await post(H.niva, OWNED_ID, { level: "ta_imot_bestillinger", confirmed: "1" }, tokens[OWNED_ID], { origin: "https://evil.example" })).status, 403, "order: cross-site level POST → 403");
    assertEq((await post(H.intro, OWNED_ID, { answer: "yes" }, tokens[OWNED_ID], { origin: "https://evil.example" })).status, 403, "order: cross-site intro POST → 403");
    resetCap();
    let okCount = 0;
    for (let i = 0; i < featuresMod.OWNER_FEATURES_WRITES_PER_MINUTE; i++) {
      if ((await post(H.sett, OWNED_ID, { key: "nope.key", value: "x" })).status === 303) okCount++;
    }
    assertEq(okCount, featuresMod.OWNER_FEATURES_WRITES_PER_MINUTE, "rate limit: 30 page writes per minute allowed");
    const over = await post(H.sett, OWNED_ID, { key: "nope.key", value: "x" });
    assertEq([over.status, loc(over)], [303, `/eier/${OWNED_ID}/valg?melding=for_mange#mv-toast-slot`], "rate limit: 31st page write → 303 «For mange endringer» (T5; shared per-session cap)");
    assertEq((await page(OWNED_ID)).status, 200, "rate limit: page reads not limited");
    resetCap();

    // ── Portal card with allowlist on ────────────────────────────────────────
    const portalOn = html(await portal(OWNED_ID));
    assertTrue(portalOn.includes(`href="/eier/${OWNED_ID}/valg"`) && portalOn.includes("Mine valg"), "allowlist on: portal links to «Mine valg»");
    const portalEm = await portal(EMAILMATCH_ID);
    assertEq([portalEm.status, html(portalEm).includes(`id="mine-valg"`), html(portalEm).includes(`/eier/${EMAILMATCH_ID}/valg`)], [200, false, false],
      "allowlist on: e-mail-match session (portal reachable, gate flag off) gets no «Mine valg» card — needs isVerifiedOwner");

    // ── Page structure (real registry) ───────────────────────────────────────
    const p0 = await page(OWNED_ID);
    const b0 = html(p0);
    assertEq([p0.status, p0.headers["cache-control"]], [200, "no-store"], "page: 200 no-store");
    // S2e: a group is rendered only when it has a built (non-coming_soon) entry.
    const builtGroups = reg.OWNER_FEATURE_GROUPS.filter((g) => reg.OWNER_FEATURE_REGISTRY.some((e) => e.group === g.key && e.status !== "coming_soon"));
    const groupPos = builtGroups.map((g) => b0.indexOf(`data-group="${g.key}"`));
    assertTrue(groupPos.every((p) => p > 0) && groupPos.every((p, i) => i === 0 || p > groupPos[i - 1]), "page: every group with a built entry rendered, in Vedlegg A order");
    assertTrue(reg.OWNER_FEATURE_GROUPS.filter((g) => !builtGroups.includes(g)).every((g) => !b0.includes(`data-group="${g.key}"`)),
      "page (S2e): a group with only planned entries has no card");
    // T7: groups in OWNER_FEATURE_GROUPS order, rows in registry order within their group.
    const groupIdx = (g: string) => reg.OWNER_FEATURE_GROUPS.findIndex((x) => x.key === g);
    const shownKeys = reg.OWNER_FEATURE_REGISTRY.filter((e) => !e.advanced)
      .map((e, i) => ({ k: e.key, g: groupIdx(e.group), i }))
      .sort((a, b) => a.g - b.g || a.i - b.i)
      .map((x) => x.k)
      .filter((k) => b0.includes(`data-key="${k}"`));
    const keyPos = shownKeys.map((k) => b0.indexOf(`data-key="${k}"`));
    assertTrue(keyPos.every((p, i) => i === 0 || p > keyPos[i - 1]), "page: rows in registry order within their group (advanced ones under «Flere valg»)");
    // One row: from its <li> to the end of its control column (rows may hold nested lists).
    const row = (b: string, key: string) => {
      const i = b.indexOf(`data-key="${key}"`);
      if (i < 0) return "";
      const ctl = b.indexOf(`<div class="mv-item-ctl">`, i);
      return b.slice(i, b.indexOf("</div>\n        </li>", ctl));
    };
    assertTrue(!b0.includes(`data-key="visibility.leaderboard"`) && b0.includes(`data-planned-key="visibility.leaderboard"`),
      "page (S2e): a coming_soon entry is not a row in the main view; it is in «Planlagt»");
    assertTrue(!b0.includes("Kommer snart") && !/disabled aria-disabled/.test(b0), "page (S2e): no grey «Kommer snart» switches");
    assertTrue(row(b0, "auto.guarantee").includes("Alltid"), "page: guarantee shows «Alltid»");
    assertTrue(row(b0, "orders.reminder").includes("Gjelder bare når «Ta imot bestillinger» er på."), "page: locked row shows the Norwegian reason");
    assertTrue(row(b0, "orders.enabled").includes(`name="value" value="true"`) && row(b0, "orders.enabled").includes("Slå på"), "page: live switch offers «Slå på»");
    assertTrue(!b0.includes(`data-key="orders.email"`), "page: orders.* rows hidden while orders are off");
    assertTrue(b0.includes("valg til vises når du slår på «Ta imot bestillinger»"), "page: hidden-rows note");
    assertTrue(!b0.includes("Flere valg"), "page (S2e): no «Flere valg» while no advanced entry is built");
    assertTrue(b0.includes("Slik er du nå") && b0.includes("Hvor aktiv vil du være?"), "page: levels + status line");
    assertTrue(!b0.includes(`aria-current="true" data-level=`), "page (S2e): no level marked before the owner chose one");
    // T7: no first-login card; the unanswered question stands in #gruppe-comms.
    assertTrue(!b0.includes(`id="velkommen"`) && b0.includes(`data-news-question="1"`), "page (T7): no first-login card; the news question is shown");
    assertTrue(b0.includes("Ingen endringer ennå."), "page: empty change log");
    const unb = html(await page(UNBADGED_ID));
    assertTrue(row(unb, "orders.enabled").includes("Krever at profilen er verifisert av Rett fra Bonden"), "page: requirement reason (is_verified) shown");
    assertTrue(!row(unb, "orders.enabled").includes("<form"), "page: requirement-locked switch has no form");

    // ── AC10: fixture entry appears in its group with no UI change ──────────
    {
      const fixture: Entry = {
        key: "contact.fixture_s2b", group: "contact", type: "switch",
        label: { no: "Fiksturvalg S2b", en: "Fixture S2b" }, description: { no: "Testoppføring.", en: "Test entry." },
        default: { owner: true, unclaimed: true }, requires: [], status: "live", consent: false, outward: false,
        advanced: false, verticals: ["rfb"], since: "2026-10-27", devRequest: "2026-10-22-rfb-mine-valg-eierbrytere",
        surfaces: ["profile_html"],
      };
      const R = [...reg.OWNER_FEATURE_REGISTRY];
      R.splice(R.findIndex((e) => e.key === "contact.address") + 1, 0, fixture);
      const resolved = rs.resolveOwnerFeatures("rfb", OWNED_ID, { registry: R, db });
      const body = pg.renderOwnerFeaturesPageBody({
        agent: { id: OWNED_ID, name: "Gard" }, resolved, registry: R, level: "bare_synlig", showIntro: false,
        notice: null, confirm: null, levelPreview: null, log: { rows: [], page: 1, pages: 1, total: 0 },
        now: new Date("2026-10-28T00:00:00Z"),
      });
      const fx = body.indexOf(`data-key="contact.fixture_s2b"`);
      const contactStart = body.indexOf(`data-group="contact"`);
      const nextGroup = body.indexOf(`data-group="`, contactStart + 1);
      assertTrue(fx > contactStart && fx < nextGroup && contactStart > 0, "AC10: fixture row inside the «Kontaktinformasjon» group");
      assertTrue(fx > body.indexOf(`data-key="contact.address"`), "AC10: fixture row after contact.address (registry order)");
      assertTrue(row(body, "contact.fixture_s2b").includes("Fiksturvalg S2b") && row(body, "contact.fixture_s2b").includes("Slå av"), "AC10: fixture row has its label and a working switch");
      assertTrue(row(body, "contact.fixture_s2b").includes("Nytt"), "page: «Nytt» badge within 30 days of since");
      const later = pg.renderOwnerFeaturesPageBody({
        agent: { id: OWNED_ID, name: "Gard" }, resolved, registry: R, level: "bare_synlig", showIntro: false,
        notice: null, confirm: null, levelPreview: null, log: { rows: [], page: 1, pages: 1, total: 0 },
        now: new Date("2026-12-15T00:00:00Z"),
      });
      assertTrue(!row(later, "contact.fixture_s2b").includes("Nytt"), "page: no «Nytt» badge after 30 days");
    }

    // ── One switch: confirm panel → write → audit + batch → undo ─────────────
    const s1 = await post(H.sett, OWNED_ID, { key: "orders.enabled", value: "true" });
    assertEq([s1.status, loc(s1)], [303, `/eier/${OWNED_ID}/valg?bekreft=orders.enabled&verdi=1#valg-orders.enabled`], "switch: confirmOn entry → in-page confirm panel first (T5: anchored at its row)");
    assertEq([optInCol(OWNED_ID), audits(OWNED_ID).length], [0, 0], "switch: nothing written before confirm");
    const cp = html(await page(OWNED_ID, { bekreft: "orders.enabled", verdi: "1" }));
    assertTrue(cp.includes(`data-confirm-key="orders.enabled"`) && cp.includes("Du får bestillinger på e-post og må svare kunden."), "switch: confirm panel shows the registry confirmOn text");
    const s2 = await post(H.sett, OWNED_ID, { key: "orders.enabled", value: "true", confirmed: "1" });
    const b1 = batches(OWNED_ID);
    assertEq([s2.status, optInCol(OWNED_ID), audits(OWNED_ID).length, b1.length, b1[0]?.kind], [303, 1, 1, 1, "single"], "switch: confirmed → column 1, one audit row, one batch");
    assertEq(loc(s2), `/eier/${OWNED_ID}/valg?endret=${b1[0].id}#valg-orders.enabled`, "switch: 303 back with the change id");
    assertEq([audits(OWNED_ID)[0].key, audits(OWNED_ID)[0].actor, audits(OWNED_ID)[0].actor_detail], ["orders.enabled", "owner", `post@${OWNED_ID}.example.no`], "switch: audit row actor owner + session e-mail");
    const pAfter = html(await page(OWNED_ID, { endret: String(b1[0].id) }));
    assertTrue(pAfter.includes("Lagret: «Ta imot bestillinger» er På.") && pAfter.includes(`name="batch" value="${b1[0].id}"`) && pAfter.includes(">Angre<"), "switch: message with «Angre»");
    assertTrue(row(pAfter, "orders.enabled").includes(`class="mv-toast mv-toast-inline`), "switch (T5): the message stands in the row that changed");
    assertTrue(pAfter.includes(`data-key="orders.email"`), "page: orders.* rows revealed once orders are on");
    assertTrue(!pAfter.includes(`aria-current="true" data-level=`), "level (S2e): a single switch marks no level (only the owner's level choice does)");
    const noop = await post(H.sett, OWNED_ID, { key: "orders.enabled", value: "true", confirmed: "1" });
    assertEq([loc(noop).includes("melding=ingen_endring"), audits(OWNED_ID).length, batches(OWNED_ID).length], [true, 1, 1], "switch: no-op writes nothing");
    const cs = await post(H.sett, OWNED_ID, { key: "visibility.leaderboard", value: "false", confirmed: "1" });
    assertEq([loc(cs), audits(OWNED_ID).length, settingsRows(OWNED_ID)], [`/eier/${OWNED_ID}/valg?melding=sperret&nokkel=visibility.leaderboard&ved=valg-visibility.leaderboard#valg-visibility.leaderboard`, 1, 0], "switch: coming_soon blocked, nothing written");
    assertTrue(html(await page(OWNED_ID, { melding: "sperret", nokkel: "visibility.leaderboard" })).includes("Kan ikke endres: Kommer snart."), "switch: blocked message with Norwegian reason");
    const inv = await post(H.sett, OWNED_ID, { key: "orders.enabled", value: "kanskje", confirmed: "1" });
    assertEq([loc(inv).includes("melding=ugyldig"), audits(OWNED_ID).length], [true, 1], "switch: invalid value → message, nothing written");
    // Undo the single change.
    const u1 = await post(H.angre, OWNED_ID, { batch: String(b1[0].id) });
    const b2 = batches(OWNED_ID);
    assertEq([u1.status, optInCol(OWNED_ID), audits(OWNED_ID).length], [303, 0, 2], "undo: reverted through the server, one more audit row");
    assertEq([b2.length, b2[1].kind, b2[0].undone_by_batch, !!b2[0].undone_at], [2, "undo", b2[1].id, true], "undo: undo batch recorded, original stamped undone");
    assertEq([audits(OWNED_ID)[1].old_json, audits(OWNED_ID)[1].new_json], ["true", "false"], "undo: audit row old true → new false");
    const pUndo = html(await page(OWNED_ID, { endret: String(b2[1].id) }));
    assertTrue(pUndo.includes("Angret.") && !pUndo.includes(">Angre<"), "undo: message without a second «Angre»");
    const u2 = await post(H.angre, OWNED_ID, { batch: String(b1[0].id) });
    assertEq([loc(u2).includes("melding=angre_umulig"), audits(OWNED_ID).length], [true, 2], "undo: second undo refused, nothing written");
    assertEq(loc(await post(H.angre, OWNED_ID, { batch: "abc" })).includes("melding=angre_umulig"), true, "undo: junk batch id refused");

    // ── Levels (S2e: «Bare synlig» / «Ta imot bestillinger») ────────────────
    const lv0 = await post(H.niva, OWNED_ID, { level: "ta_imot_bestillinger" });
    assertEq(loc(lv0), `/eier/${OWNED_ID}/valg?niva=ta_imot_bestillinger#niva-forhandsvis`, "level: unconfirmed → preview panel (T5: inside the level card)");
    const prev = html(await page(OWNED_ID, { niva: "ta_imot_bestillinger" }));
    assertTrue(prev.includes("Bytte til «Ta imot bestillinger»?") && prev.includes("<strong>Ta imot bestillinger</strong>: Av → På") && prev.includes("Bekreft «Ta imot bestillinger»"), "level: preview lists the live change");
    const auditsBefore = audits(OWNED_ID).length;
    const lv1 = await post(H.niva, OWNED_ID, { level: "ta_imot_bestillinger", confirmed: "1" });
    const lb = batches(OWNED_ID).at(-1);
    assertEq([lv1.status, optInCol(OWNED_ID), audits(OWNED_ID).length - auditsBefore, lb.kind, lb.level], [303, 1, 1, "level", "ta_imot_bestillinger"], "level: «Ta imot bestillinger» changes only orders.enabled (live) — one audit row, one level batch");
    assertEq(settingsRows(OWNED_ID), 0, "level: no setting rows");
    assertTrue(html(await page(OWNED_ID, { endret: String(lb.id) })).includes("Du har valgt «Ta imot bestillinger». Lagret: «Ta imot bestillinger» er På."), "level: message names the level and the change");
    const lv2 = await post(H.niva, OWNED_ID, { level: "ta_imot_bestillinger", confirmed: "1" });
    assertEq([loc(lv2).includes("melding=niva_valgt"), audits(OWNED_ID).length - auditsBefore], [true, 1], "level: choosing it again changes nothing more");
    const pl = html(await page(OWNED_ID));
    assertTrue(pl.includes(`aria-current="true" data-level="ta_imot_bestillinger"`), "level: the owner's chosen level is marked");
    const lv3 = await post(H.niva, OWNED_ID, { level: "bare_synlig", confirmed: "1" });
    const lb3 = batches(OWNED_ID).at(-1);
    assertEq([lv3.status, optInCol(OWNED_ID), lb3.level, audits(OWNED_ID).length - auditsBefore], [303, 0, "bare_synlig", 2], "level: «Bare synlig» turns orders off");
    // Undo a level as one unit.
    const ul = await post(H.angre, OWNED_ID, { batch: String(lb3.id) });
    assertEq([ul.status, optInCol(OWNED_ID), audits(OWNED_ID).length - auditsBefore], [303, 1, 3], "undo: level reverted as one unit");
    assertEq(loc(await post(H.niva, OWNED_ID, { level: "bogus", confirmed: "1" })).includes("melding=ugyldig"), true, "level: unknown level refused");
    // Unmet requirement: skipped with reason.
    const lu = await post(H.niva, UNBADGED_ID, { level: "ta_imot_bestillinger", confirmed: "1" });
    assertEq([loc(lu), optInCol(UNBADGED_ID), audits(UNBADGED_ID).length], [`/eier/${UNBADGED_ID}/valg?melding=hoppet&nokkel=orders.enabled&ved=niva#niva`, 0, 0], "level: unmet requirement → key skipped, nothing written");
    assertTrue(html(await page(UNBADGED_ID, { melding: "hoppet", nokkel: "orders.enabled" })).includes("«Ta imot bestillinger»: Krever at profilen er verifisert"), "level: skipped message carries the Norwegian reason");
    assertTrue(!html(await page(UNBADGED_ID)).includes(`aria-current="true" data-level=`), "level (S2e): a level that could not apply is not marked as chosen");
    // The undo/preview machinery over multi-key presets (fixture levels: the S2b «Aktiv» / «Full fart» presets).
    const FIXTURE_LEVELS: any[] = [
      { key: "bare_synlig", label: { no: "Bare synlig", en: "Just visible" }, description: { no: "x", en: "x" }, recommended: false,
        values: [["orders.enabled", false], ["payments.prepay", false], ["products.weekly_sync", false], ["notify.order_sms", false], ["comms.beta", false], ["comms.featured", false]] },
      { key: "ta_imot_bestillinger", label: { no: "Full fart", en: "Full speed" }, description: { no: "x", en: "x" }, recommended: false,
        values: [["orders.enabled", true], ["payments.prepay", true], ["notify.report", "monthly"], ["products.weekly_sync", true], ["notify.order_sms", true], ["comms.beta", true], ["comms.featured", true]] },
    ];
    // Level apply with a second live key (fixture registry): only live keys change, one audit each.
    {
      const R = reg.OWNER_FEATURE_REGISTRY.map((e) => (e.key === "comms.beta" ? { ...e, status: "live" as const } : e));
      const a0 = audits(LOG_ID).length;
      const out = ch.applyOwnerLevel("rfb", LOG_ID, "ta_imot_bestillinger", { actor: "owner", detail: "t" }, { registry: R, db, levels: FIXTURE_LEVELS });
      assertEq(out.kind === "ok" ? [...out.changed].sort() : out.kind, ["comms.beta", "orders.enabled"], "level (fixture): exactly the live keys changed");
      assertEq(audits(LOG_ID).length - a0, 2, "level (fixture): one audit row per changed key");
      assertEq((db.prepare("SELECT key FROM owner_feature_settings WHERE subject_id = ?").all(LOG_ID) as any[]).map((r) => r.key), ["comms.beta"], "level (fixture): coming_soon preset keys not stored");
      const resolved = rs.resolveOwnerFeatures("rfb", LOG_ID, { registry: R, db });
      assertEq(ch.currentOwnerLevel("rfb", LOG_ID, resolved, { registry: R, db, levels: FIXTURE_LEVELS }), "ta_imot_bestillinger", "level (fixture): current level = the owner's choice");
      const u = ch.undoOwnerChange("rfb", LOG_ID, (out as any).batchId, { actor: "owner", detail: "t" }, { registry: R, db });
      assertEq([u.kind, optInCol(LOG_ID), audits(LOG_ID).length - a0], ["ok", 0, 4], "undo (fixture): both keys reverted, two more audit rows");
      const res2 = rs.resolveOwnerFeatures("rfb", LOG_ID, { registry: R, db });
      assertEq([res2.byKey["comms.beta"].value, ch.currentOwnerLevel("rfb", LOG_ID, res2, { registry: R, db, levels: FIXTURE_LEVELS })], [false, null], "undo (fixture): «Full fart» undone → no owner level choice left (none marked)");
      assertEq(settingsRows(LOG_ID), 0, "undo (fixture): the settings row the level created is removed, not stored as default");
      db.prepare("DELETE FROM owner_feature_settings WHERE subject_id = ?").run(LOG_ID);
      db.prepare("DELETE FROM owner_feature_audit WHERE subject_id = ?").run(LOG_ID);
      db.prepare("DELETE FROM owner_feature_change_batch WHERE subject_id = ?").run(LOG_ID);
      db.prepare("DELETE FROM owner_feature_level_choice WHERE subject_id = ?").run(LOG_ID);
    }

    // Dependent live keys (fixture): preview == apply, and undo works both ways.
    {
      const live = new Set(["comms.beta", "notify.order_sms"]);
      const R = reg.OWNER_FEATURE_REGISTRY.map((e) => (live.has(e.key) ? { ...e, status: "live" as const } : e));
      const o = { registry: R, db, levels: FIXTURE_LEVELS };
      const val = (k: string) => rs.resolveOwnerFeatures("rfb", LOG_ID, o).byKey[k].value;
      const actor = { actor: "owner" as const, detail: "t" };
      const pv = ch.previewOwnerLevel("rfb", LOG_ID, "ta_imot_bestillinger", o)!;
      assertEq([audits(LOG_ID).length, batches(LOG_ID).length, optInCol(LOG_ID), settingsRows(LOG_ID)], [0, 0, 0, 0], "preview (fixture): nothing kept");
      const ap = ch.applyOwnerLevel("rfb", LOG_ID, "ta_imot_bestillinger", actor, o) as any;
      assertEq(pv.changes.map((c) => c.key), ap.changed, "preview (fixture): preview.changes == apply.changed");
      assertTrue(ap.changed.includes("notify.order_sms") && pv.skipped.length === 0, "preview (fixture): key whose requirement is switched on earlier in the preset is listed as a change");
      assertEq(pv.changes.find((c) => c.key === "notify.order_sms"), { key: "notify.order_sms", from: false, to: true }, "preview (fixture): from/to for the dependent key");
      assertEq([val("orders.enabled"), val("notify.order_sms"), val("comms.beta")], [true, true, true], "apply (fixture): «Full fart» on");
      const u1 = ch.undoOwnerChange("rfb", LOG_ID, ap.batchId, actor, o);
      assertEq([u1.kind, val("orders.enabled"), val("notify.order_sms"), val("comms.beta"), settingsRows(LOG_ID)], ["ok", false, false, false, 0], "undo (fixture): «Full fart» batch reverted, created rows removed");
      const ap2 = ch.applyOwnerLevel("rfb", LOG_ID, "ta_imot_bestillinger", actor, o) as any;
      assertEq(ap2.changed.length, 3, "apply (fixture): «Full fart» again");
      const pvb = ch.previewOwnerLevel("rfb", LOG_ID, "bare_synlig", o)!;
      const apb = ch.applyOwnerLevel("rfb", LOG_ID, "bare_synlig", actor, o) as any;
      assertEq(pvb.changes.map((c) => c.key), apb.changed, "preview (fixture): «Bare synlig» preview == apply");
      assertEq([val("orders.enabled"), val("notify.order_sms"), val("comms.beta")], [false, false, false], "apply (fixture): «Bare synlig» off");
      const a1 = audits(LOG_ID).length;
      const u2 = ch.undoOwnerChange("rfb", LOG_ID, apb.batchId, actor, o);
      assertEq([u2.kind, val("orders.enabled"), val("notify.order_sms"), val("comms.beta"), audits(LOG_ID).length - a1], ["ok", true, true, true, 3],
        "undo (fixture): «Bare synlig» batch reverted (dependent key after its requirement), one audit row each");
      assertEq(settingsRows(LOG_ID), 2, "undo (fixture): rows that existed before the batch are kept");
      // A row that existed before the change is kept (value restored), not deleted.
      const s1 = ch.applyOwnerSingleChange("rfb", LOG_ID, "comms.beta", false, actor, o);
      const u3 = ch.undoOwnerChange("rfb", LOG_ID, s1.batchId!, actor, o);
      const rowBeta = db.prepare("SELECT value_json FROM owner_feature_settings WHERE subject_id = ? AND key = 'comms.beta'").get(LOG_ID) as any;
      assertEq([u3.kind, rowBeta?.value_json], ["ok", "true"], "undo: pre-existing explicit row restored, not deleted");
      // A→B→A elsewhere after the change blocks undo (later audit rows).
      const s2 = ch.applyOwnerSingleChange("rfb", LOG_ID, "orders.enabled", false, actor, o);
      await invoke(H.optInApi, makeReq({ params: { id: LOG_ID }, body: { opt_in: true }, token: tokens[LOG_ID] }));
      await invoke(H.optInApi, makeReq({ params: { id: LOG_ID }, body: { opt_in: false }, token: tokens[LOG_ID] }));
      const a2 = audits(LOG_ID).length;
      assertEq(val("orders.enabled"), false, "undo-guard: value back to what the batch set");
      const u4 = ch.undoOwnerChange("rfb", LOG_ID, s2.batchId!, actor, o);
      assertEq([u4.kind, val("orders.enabled"), audits(LOG_ID).length - a2], ["changed_since", false, 0], "undo-guard: A→B→A elsewhere blocks undo, nothing written");
      db.prepare("DELETE FROM owner_feature_settings WHERE subject_id = ?").run(LOG_ID);
      db.prepare("DELETE FROM owner_feature_audit WHERE subject_id = ?").run(LOG_ID);
      db.prepare("DELETE FROM owner_feature_change_batch WHERE subject_id = ?").run(LOG_ID);
      db.prepare("UPDATE agents SET order_notifications_opt_in = 0 WHERE id = ?").run(LOG_ID);
    }

    // ── Undo refused when the key changed since (old route) ─────────────────
    {
      const c = await post(H.sett, OWNED_ID, { key: "orders.enabled", value: "false", confirmed: "1" });
      const bid = Number(new URLSearchParams(loc(c).split("?")[1]?.split("#")[0]).get("endret"));
      assertEq(optInCol(OWNED_ID), 0, "undo-guard: page turned orders off");
      const n0 = audits(OWNED_ID).length;
      await invoke(H.optInApi, makeReq({ params: { id: OWNED_ID }, body: { opt_in: true }, token: tokens[OWNED_ID] }));
      assertEq([optInCol(OWNED_ID), audits(OWNED_ID).length - n0], [1, 1], "N1: old API route writes the column and one orders.enabled audit row");
      const last = audits(OWNED_ID).at(-1);
      assertEq([last.key, last.old_json, last.new_json, last.actor, last.actor_detail], ["orders.enabled", "false", "true", "owner", `post@${OWNED_ID}.example.no`], "N1: audit row old/new/actor/detail");
      const ug = await post(H.angre, OWNED_ID, { batch: String(bid) });
      assertEq([loc(ug).includes("melding=angre_endret"), optInCol(OWNED_ID), audits(OWNED_ID).length - n0], [true, 1, 1], "undo: refused when the key changed since; nothing written");
      await invoke(H.optInApi, makeReq({ params: { id: OWNED_ID }, body: { opt_in: true }, token: tokens[OWNED_ID] }));
      assertEq(audits(OWNED_ID).length - n0, 1, "N1: same value again → no audit row");
      const f = await invoke(H.optInForm, makeReq({ params: { agentId: OWNED_ID }, body: { opt_in: "0" }, token: tokens[OWNED_ID] }));
      assertEq([f.status, optInCol(OWNED_ID), audits(OWNED_ID).length - n0, audits(OWNED_ID).at(-1).new_json], [303, 0, 2, "false"], "N1: old form route writes the audit row too");
      const bad = await invoke(H.optInApi, makeReq({ params: { id: UNBADGED_ID }, body: { opt_in: true }, token: tokens[UNBADGED_ID] }));
      assertEq([bad.status, audits(UNBADGED_ID).length], [409, 0], "N1: old route's existing 409 unchanged, no audit row");
      const no = await invoke(H.optInApi, makeReq({ params: { id: OWNED_ID }, body: { opt_in: true } }));
      assertEq([no.status, audits(OWNED_ID).length - n0], [401, 2], "N1: old route's 401 unchanged, no audit row");
    }

    // ── Change log ───────────────────────────────────────────────────────────
    {
      const pLog = html(await page(OWNED_ID));
      const logStart = pLog.indexOf(`id="endringslogg"`);
      const logHtml = pLog.slice(logStart);
      assertTrue(logStart > 0 && logHtml.includes("<strong>Ta imot bestillinger</strong>: På → Av") && logHtml.includes("· Du"), "log: label, old → new, who");
      assertTrue(logHtml.indexOf("På → Av") < logHtml.indexOf("Av → På"), "log: newest first");
      assertTrue(logHtml.includes(">Angret<"), "log: undo rows marked «Angret»");
      const ins = db.prepare("INSERT INTO owner_feature_audit (vertical, subject_id, key, old_json, new_json, actor, actor_detail, at) VALUES ('rfb', ?, ?, ?, ?, ?, NULL, ?)");
      for (let i = 0; i < 25; i++) {
        ins.run(LOG_ID, "orders.enabled", i % 2 ? "true" : "false", i % 2 ? "false" : "true", i === 24 ? "cs" : i === 23 ? "admin" : "owner", new Date(Date.UTC(2026, 9, 1, 8, i)).toISOString());
      }
      const l1 = html(await page(LOG_ID));
      const l1log = l1.slice(l1.indexOf(`id="endringslogg"`));
      assertEq((l1log.match(/class="ep-audit-item"/g) || []).length, ch.OWNER_CHANGE_LOG_PAGE_SIZE, "log: one page = 20 rows");
      assertTrue(l1log.includes(`href="/eier/${LOG_ID}/valg?side=2#endringslogg"`) && l1log.includes("Side 1 av 2"), "log: «Eldre» link to page 2");
      assertTrue(l1log.indexOf("· Kundeservice") < l1log.indexOf("· Rett fra Bonden") && l1log.includes("01.10.2026"), "log: who (cs/admin) + Oslo date, newest first");
      const l2 = html(await page(LOG_ID, { side: "2" }));
      const l2log = l2.slice(l2.indexOf(`id="endringslogg"`));
      assertEq((l2log.match(/class="ep-audit-item"/g) || []).length, 5, "log: page 2 = the 5 oldest");
      assertTrue(l2log.includes("?side=1#endringslogg") && l2log.includes("Side 2 av 2"), "log: «Nyere» link back");
      assertEq((html(await page(LOG_ID, { side: "99" })).match(/Side 2 av 2/g) || []).length, 1, "log: page out of range clamps to the last");
    }

    // ── «Nyheter og tips» question (T7; the S2b first-login card is gone) ───
    {
      const i1 = await post(H.intro, OWNED_ID, { answer: "yes" });
      const p1 = db.prepare("SELECT state, answered_at, actor_detail FROM owner_feature_prompt WHERE subject_id = ? AND key = 'comms.news'").get(OWNED_ID) as any;
      assertEq([loc(i1).startsWith(`/eier/${OWNED_ID}/valg?endret=`), p1?.state, p1?.actor_detail], [true, "yes", `post@${OWNED_ID}.example.no`], "intro (T7): «Ja takk» stored with the session e-mail, applied to comms.news with a batch");
      assertTrue(/^\d{4}-\d{2}-\d{2}T/.test(String(p1?.answered_at)), "intro: answer time stored (ISO)");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM owner_feature_intro").get() as any).n, 0, "intro (T7): no owner_feature_intro row is written any more");
      assertEq((db.prepare("SELECT value_json, set_by FROM owner_feature_settings WHERE key = 'comms.news' AND subject_id = ?").get(OWNED_ID) as any), { value_json: "true", set_by: "owner" }, "intro: live comms.news gets the owner's explicit row");
      const after = html(await page(OWNED_ID));
      assertTrue(!after.includes(`data-news-question="1"`), "intro: question not shown again");
      const second = await post(H.intro, OWNED_ID, { answer: "never" });
      assertTrue(loc(second).includes("melding=ingen_endring"), "intro (T7): an answer while the question is closed changes nothing");
      assertEq((db.prepare("SELECT state FROM owner_feature_prompt WHERE subject_id = ?").get(OWNED_ID) as any).state, "yes", "intro: a second answer does not overwrite the first");
      assertEq(loc(await post(H.intro, OTHER_ID, { answer: "kanskje" })).includes("melding=ugyldig"), true, "intro: junk answer refused");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM owner_feature_prompt WHERE subject_id = ?").get(OTHER_ID) as any).n, 0, "intro: junk answer stores nothing");
      const out = ch.answerOwnerNewsQuestion("rfb", OTHER_ID, "yes", { actor: "owner", detail: "t" }, { db });
      assertEq(out.kind === "ok" && [out.changed, !!out.batchId], [true, true], "intro (live comms.news): «Ja takk» applied as the explicit choice with a batch");
      assertEq(rs.resolveOwnerFeature("rfb", OTHER_ID, "comms.news", { db }).value, true, "intro (live comms.news): value on");
      assertEq(audits(OTHER_ID).map((a) => a.key), ["comms.news"], "intro (live comms.news): one audit row");
      const R = reg.OWNER_FEATURE_REGISTRY.map((e) => (e.key === "comms.news" ? { ...e, status: "coming_soon" as const } : e));
      const cs = ch.answerOwnerNewsQuestion("rfb", LOG_ID, "yes", { actor: "owner", detail: "t" }, { registry: R, db });
      assertEq(cs.kind, "not_open", "intro: coming_soon comms.news → no question, nothing written");
    }

    // ── Escaping ─────────────────────────────────────────────────────────────
    {
      const x = html(await page(XSS_ID, { bekreft: `"><script>alert(1)</script>`, verdi: "1", melding: "sperret", nokkel: `<img src=x onerror=alert(1)>`, niva: `<b>` }));
      assertTrue(!x.includes("<script>alert") && x.includes("Gard &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Sønn"), "escaping: agent name escaped");
      assertTrue(!x.includes("<img src=x") && !x.includes("onerror=alert"), "escaping: query parameters never reflected");
      const proto = await page(XSS_ID, { melding: "constructor", bekreft: "constructor", verdi: "1", nokkel: "__proto__" });
      assertEq([proto.status, html(proto).includes(`class="mv-toast`), html(proto).includes(`id="bekreft"`)], [200, false, false], "query: prototype names are not looked up");
      const fixture: Entry = {
        key: "contact.xss", group: "contact", type: "choice",
        label: { no: `<img src=x onerror="a()">Valg`, en: "x" }, description: { no: `"'><b>beskrivelse</b>`, en: "x" },
        options: [{ value: `"><i>v</i>`, label: { no: "<u>alt</u>", en: "x" } }],
        default: { owner: `"><i>v</i>`, unclaimed: `"><i>v</i>` }, requires: [], status: "live", consent: false, outward: false,
        advanced: false, verticals: ["rfb"], since: "2026-10-27", devRequest: "x", surfaces: ["profile_html"],
      };
      const R = [...reg.OWNER_FEATURE_REGISTRY, fixture];
      const resolved = rs.resolveOwnerFeatures("rfb", XSS_ID, { registry: R, db });
      const body = pg.renderOwnerFeaturesPageBody({
        agent: { id: `<x>"`, name: "<b>n</b>" }, resolved, registry: R, level: "custom", showIntro: true,
        notice: { ok: false, text: `<script>bad()</script>`, undoBatchId: null }, confirm: null, levelPreview: null,
        log: { rows: [{ id: 1, key: "contact.xss", old_value: `<s>o</s>`, new_value: `"><i>v</i>`, actor: "<x>", at: "not-a-date<", undo: false }], page: 1, pages: 1, total: 1 },
      });
      for (const bad of ["<img src=x", "<b>beskrivelse", "<i>v</i>", "<u>alt", "<script>bad", "<s>o", "<b>n</b>", `/eier/<x>`]) {
        assertTrue(!body.includes(bad), `escaping: «${bad}» not emitted raw`);
      }
      assertTrue(body.includes("&lt;img src=x onerror=&quot;a()&quot;&gt;Valg") && body.includes("/eier/%3Cx%3E%22/valg"), "escaping: text escaped, ids URL-encoded");
    }

    // ── AC13: mobile + dark CSS ──────────────────────────────────────────────
    {
      const full = html(await page(OWNED_ID));
      assertTrue(full.includes(`name="viewport" content="width=device-width, initial-scale=1.0"`), "AC13: viewport meta");
      assertTrue(pg.OWNER_PAGE_CSS.includes("@media (prefers-color-scheme: dark)") && pg.OWNER_PAGE_CSS.includes("color-scheme: light dark"), "AC13: dark mode");
      assertTrue((pg.OWNER_PAGE_CSS.match(/min-height: 44px/g) || []).length >= 3, "AC13: ≥ 44 px tap targets for inputs, state and «Flere valg»");
      const widths = [...pg.OWNER_PAGE_CSS.matchAll(/(?:^|[\s;{])(?:min-)?width:\s*(\d+)px/g)].map((m) => Number(m[1]));
      assertTrue(widths.every((w) => w <= 1), "AC13: no fixed pixel widths that could overflow 375 px");
      assertTrue(pg.OWNER_PAGE_CSS.includes("flex-wrap: wrap") && pg.OWNER_PAGE_CSS.includes("overflow-wrap: anywhere"), "AC13: rows wrap, long words break");
      // S2e (principle 9): one inline script, progressive enhancement only — every form still posts as a plain form.
      const bodyPart = full.slice(full.indexOf(`class="mv-page"`));
      assertEq((bodyPart.match(/<script/gi) || []).length, 1, "page (S2e): one enhancement script, nothing else");
      const forms = bodyPart.match(/<form [^>]*>/g) || [];
      assertTrue(forms.length > 0 && forms.every((f) => /method="(post|get)"/.test(f) && /action="\/eier\//.test(f)), "page (S2e): every form has a method and an /eier action (works without JavaScript)");
    }

    // ── Schema ───────────────────────────────────────────────────────────────
    {
      let threw = false;
      try {
        db.prepare("INSERT INTO owner_feature_intro (vertical, subject_id, answer, answered_at) VALUES ('rfb', 'z', 'maybe', 'x')").run();
      } catch { threw = true; }
      assertTrue(threw, "schema: intro answer CHECK (the S2b table is kept)");
      threw = false;
      try {
        db.prepare("INSERT INTO owner_feature_change_batch (vertical, subject_id, kind, first_audit_id, last_audit_id, created_at) VALUES ('rfb', 'z', 'bogus', 1, 1, 'x')").run();
      } catch { threw = true; }
      assertTrue(threw, "schema: batch kind CHECK");
    }
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err));
  } finally {
    console.log = prevLog;
    if (prevAllow === undefined) delete process.env[ALLOW_ENV]; else process.env[ALLOW_ENV] = prevAllow;
    if (prevGate === undefined) delete process.env[GATE_ENV]; else process.env[GATE_ENV] = prevGate;
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerFeaturesS2bTests({ log: true }).then((r) => {
    console.info(`\nowner-features-s2b: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
