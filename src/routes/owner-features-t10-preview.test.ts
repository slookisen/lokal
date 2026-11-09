/**
 * owner-features-t10-preview.test.ts — dev-request
 * 2026-10-30-rfb-eierportal-testrunde-1, T10 (punkt 3 «Velge»): the level
 * preview with consequences, hard and soft requirements, and orderGateReady.
 *
 *   AC6  with is_verified = 0, without an order address, with a blocked order
 *        address or an unchecked profile, «Utnytte mulighetene» has «Dette
 *        mangler» («Du kan ikke velge «{nivå}» før dette er på plass:») and NO
 *        confirm button, and POST confirmed=1 writes nothing (column, audit,
 *        batch, settings, level choice) — server side;
 *        with 0 orderable items (and on pause) the level can be confirmed,
 *        with the warning;
 *        the hard requirements are empty iff isEligibleForRealOrder() is true
 *        with orders on (fixture matrix, the gate read with the column set);
 *        orderGateReady never switches off / changes an owner with orders on.
 *   page the six sections and their texts; «(ditt unntak)»; «Følger med» for
 *        the locked keys; «Bestillinger du allerede har fått …» when orders go
 *        off; the T9 fragment (?fragment=niva) renders the same preview; no
 *        inline on*= attribute; a level never changes comms.news /
 *        visibility.profile.
 *
 * Exported runOwnerFeaturesT10PreviewTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/owner-features-t10-preview.test.ts
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

interface Seed {
  isVerified?: boolean;
  email?: string | null;
  checked?: "verified" | "pending" | "second_line" | "none";
  umbrella?: boolean;
  active?: boolean;
  optIn?: boolean;
  products?: number;
}

function seed(db: Database.Database, id: string, o: Seed = {}): void {
  const email = o.email === undefined ? `post@${id}.example.no` : (o.email ?? "");
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
        order_notifications_opt_in, umbrella_type)
     VALUES (?, ?, 'Testprodusent for T10.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, ?, ?, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z', ?, ?)`,
  ).run(id, `T10 Gard ${id}`, email, `https://${id}.example.no`, `key-${id}`, o.active === false ? 0 : 1, o.isVerified === false ? 0 : 1,
    o.optIn ? 1 : 0, o.umbrella ? "cooperative" : null);
  const checked = o.checked ?? "verified";
  if (checked !== "none") {
    db.prepare(
      `INSERT INTO agent_knowledge (agent_id, email, website, about, verification_status, verified_second_line)
       VALUES (?, ?, ?, 'Liten familiegård.', ?, ?)`,
    ).run(id, `post@${id}.example.no`, `https://${id}.example.no`, checked === "pending" ? "pending" : "verified", checked === "second_line" ? 1 : 0);
  }
  for (let i = 0; i < (o.products ?? 1); i++) {
    db.prepare(
      `INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, category, description, availability_source)
       VALUES (?, ?, 'Poteter', 'poteter', 30, 'kg', 'in_stock', 'vegetables', NULL, 'admin_producer_confirmed')`,
    ).run(`p-${id}-${i}`, id);
  }
  db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
    .run(`mlsess_${id}`, email || `post@${id}.example.no`, `tok-${id}`, id, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
}

export async function runOwnerFeaturesT10PreviewTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  const sum: TestSummary = { passed: 0, failed: 0, failures: [] };
  const eq = (actual: unknown, expected: unknown, label: string) => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      sum.passed++;
      if (log) console.info(`  ok ${label}`);
    } else {
      sum.failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      sum.failures.push(msg);
      if (log) console.info("  " + msg);
    }
  };
  const ok = (c: boolean, label: string) => eq(!!c, true, label);

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const prevAllow = process.env[ALLOW_ENV];
  const prevGate = process.env[GATE_ENV];

  function findRouteHandler(router: any, path: string, method: "get" | "post" | "put"): Function {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; body?: any; query?: Record<string, string>; token?: string }): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com" };
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
        req,
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
    for (const m of ["./owner-features"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const featuresMod = require("./owner-features") as typeof import("./owner-features");
    const rs = require("../owner-features/resolve") as typeof import("../owner-features/resolve");
    const ch = require("../owner-features/changes") as typeof import("../owner-features/changes");
    const cart = require("../services/cart-service") as typeof import("../services/cart-service");

    const IDS = {
      ready: "t10-ready", noProd: "t10-noprod", unver: "t10-unver", noEmail: "t10-noemail", blocked: "t10-blocked",
      unchecked: "t10-unchecked", onUnready: "t10-on-unready", paused: "t10-paused", exc: "t10-exc", onReady: "t10-on-ready",
    };
    seed(db, IDS.ready);
    seed(db, IDS.noProd, { products: 0 });
    seed(db, IDS.unver, { isVerified: false });
    seed(db, IDS.noEmail, { email: null });
    seed(db, IDS.blocked, { email: "sperret@t10-blocked.example.no" });
    db.prepare(`INSERT INTO agent_blocklist (identifier_type, identifier_value, reason) VALUES ('email', 'sperret@t10-blocked.example.no', 't10')`).run();
    seed(db, IDS.unchecked, { checked: "pending" });
    seed(db, IDS.onUnready, { optIn: true, checked: "pending" });
    seed(db, IDS.paused);
    seed(db, IDS.exc, { optIn: true });
    seed(db, IDS.onReady, { optIn: true });
    process.env[ALLOW_ENV] = Object.values(IDS).map((id) => `rfb:${id}`).join(",");

    const H = {
      page: findRouteHandler(featuresMod.default, "/eier/:agentId/valg", "get"),
      niva: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/niva", "post"),
    };
    const page = (id: string, query: Record<string, string> = {}) => invoke(H.page, makeReq({ params: { agentId: id }, query, token: `tok-${id}` }));
    const post = (id: string, body: any) => { featuresMod.__resetOwnerFeaturesRateLimitForTesting(); return invoke(H.niva, makeReq({ params: { agentId: id }, body, token: `tok-${id}` })); };
    const loc = (r: HandlerResult) => String(r.body?.__redirect ?? "");
    const html = (r: HandlerResult) => String(r.body ?? "");
    const optIn = (id: string) => (db.prepare("SELECT order_notifications_opt_in AS v FROM agents WHERE id = ?").get(id) as any).v;
    const writes = (id: string) => JSON.stringify([
      optIn(id),
      db.prepare("SELECT COUNT(*) AS n FROM owner_feature_audit WHERE subject_id = ?").get(id),
      db.prepare("SELECT COUNT(*) AS n FROM owner_feature_change_batch WHERE subject_id = ?").get(id),
      db.prepare("SELECT COUNT(*) AS n FROM owner_feature_settings WHERE subject_id = ?").get(id),
      db.prepare("SELECT COUNT(*) AS n FROM owner_feature_level_choice WHERE subject_id = ?").get(id),
    ]);
    const previewOf = (body: string) => {
      const i = body.indexOf(`id="niva-forhandsvis"`);
      if (i < 0) return "";
      const end = body.indexOf("</section>", i);
      return body.slice(i, end < 0 ? undefined : end);
    };
    const U = "utnytte_mulighetene";
    const CANNOT = "Du kan ikke velge «Utnytte mulighetene» før dette er på plass:";
    const CONFIRM = "Bekreft «Utnytte mulighetene»";

    // ── Hard requirements: «Dette mangler», no confirm button, POST writes nothing ──
    const hardCases: Array<[string, string, string]> = [
      [IDS.unver, "owner_not_verified", "Profilen er ikke verifisert."],
      [IDS.noEmail, "order_email_missing", "Det finnes ingen e-postadresse som bestillingene kan sendes til."],
      [IDS.blocked, "order_email_suppressed", "E-postadressen for bestillinger kan ikke motta e-post fra oss."],
      [IDS.unchecked, "profile_not_checked", "Rett fra Bonden har ikke kontrollert profilen ennå."],
    ];
    for (const [id, code, text] of hardCases) {
      const w0 = writes(id);
      const g = await page(id, { niva: U });
      eq(g.status, 200, `hard ${code}: GET preview 200`);
      const pv = previewOf(html(g));
      ok(pv.includes("<h4>Dette mangler</h4>") && pv.includes(CANNOT) && pv.includes(`data-level-requirement="${code}"`) && pv.includes(text),
        `hard ${code}: «Dette mangler» + «Du kan ikke velge …» + the reason`);
      ok(!pv.includes(CONFIRM) && !pv.includes(`name="confirmed"`), `hard ${code}: no confirm button / form`);
      ok(pv.includes("Avbryt"), `hard ${code}: «Avbryt» is there`);
      eq(writes(id), w0, `hard ${code}: the preview GET writes nothing`);
      const p = await post(id, { level: U, confirmed: "1" });
      eq([p.status, loc(p)], [303, `/eier/${id}/valg?niva=${U}#niva-forhandsvis`], `hard ${code}: POST confirmed=1 → 303 back to the preview`);
      eq(writes(id), w0, `hard ${code}: POST confirmed=1 writes nothing (column, audit, batch, settings, choice)`);
      const direct = ch.applyOwnerLevel("rfb", id, U, { actor: "owner" });
      eq([direct.kind, direct.kind === "not_ready" ? direct.missing.map((m) => m.code) : null], ["not_ready", [code]], `hard ${code}: applyOwnerLevel → not_ready (server side)`);
      eq(writes(id), w0, `hard ${code}: applyOwnerLevel wrote nothing`);
      // «Minst mulig» is never stopped by it.
      eq(ch.ownerLevelRequirements("rfb", id, "minst_mulig").hard, [], `hard ${code}: «Minst mulig» has no requirement`);
    }

    // ── Soft requirements: warning, can confirm ───────────────────────────────
    {
      const g = previewOf(html(await page(IDS.noProd, { niva: U })));
      ok(g.includes(`data-level-warning="no_orderable_products"`) && g.includes("Du har ingen varer som kan bestilles ennå. Kundene kan ikke bestille før du har lagt inn varer.") && !g.includes(CANNOT),
        "soft: 0 orderable items → the warning, not a hard requirement");
      ok(g.includes(CONFIRM), "soft: 0 orderable items → the confirm button is there");
      const p = await post(IDS.noProd, { level: U, confirmed: "1" });
      ok(p.status === 303 && /\?endret=\d+#niva$/.test(loc(p)) && optIn(IDS.noProd) === 1, `soft: confirming with 0 items switches orders on (${loc(p)})`);
      const r0 = cart.orderReadiness(db, IDS.ready);
      eq([r0.ready, r0.missing, r0.orderable_if_on], [true, [], 1], "soft: orderReadiness of a ready producer with one item");
      eq(cart.orderReadiness(db, IDS.noProd).orderable_if_on, 0, "soft: orderable_if_on = 0 without items");
    }
    {
      const pz = rs.setOwnerFeatureValue("rfb", IDS.paused, "visibility.profile", false, { actor: "owner" });
      eq(pz.kind, "ok", "pause: the profile is put on pause");
      const g = previewOf(html(await page(IDS.paused, { niva: U })));
      ok(g.includes(`data-level-warning="profile_paused"`) && g.includes(CONFIRM) && g.includes("Profilen er synlig: Av"), "pause: a warning, confirmable, «Profilen er synlig: Av»");
      const p = await post(IDS.paused, { level: U, confirmed: "1" });
      ok(p.status === 303 && optIn(IDS.paused) === 1, "pause: confirming switches orders on");
      eq(rs.resolveOwnerFeature("rfb", IDS.paused, "visibility.profile", { db }).value, false, "pause: the level left visibility.profile off");
    }

    // ── The sections of a full preview ────────────────────────────────────────
    {
      const g = previewOf(html(await page(IDS.ready, { niva: U })));
      for (const h of ["Dette endres", "Følger med", "Endres ikke", "Dette må du gjøre", "Godt å vite"]) ok(g.includes(`<h4>${h}</h4>`), `sections: «${h}»`);
      ok(!g.includes("<h4>Dette mangler</h4>"), "sections: nothing missing → no «Dette mangler»");
      ok(g.includes("Du kan gjøre unntak etterpå. Trykker du «Angre», går hele nivåbyttet tilbake.") && !g.includes("«Angre» angrer hele nivåbyttet"),
        "Godt å vite: tekstpakke A punkt 2 — the new sentence, not the old");
      ok(g.includes("<strong>Ta imot bestillinger</strong>: Av → På"), "Dette endres: «{valg}: {fra} → {til}»");
      ok(g.includes("<strong>Påminnelse om ubesvarte bestillinger</strong>: Av → Låst på") && g.includes("<strong>Ordrevarsel på e-post</strong>: Av → Låst på"), "Følger med: the locked keys that follow orders.enabled");
      ok(g.includes("Profilen er synlig: På") && g.includes("Nyheter og tips: du bestemmer selv") && g.includes(`Bestillinger sendes til: post@${IDS.ready}.example.no`), "Endres ikke: visibility, «Nyheter og tips», the order address");
      ok(g.includes("Du får bestillinger på e-post og må svare kunden."), "Dette må du gjøre: the confirmOn text");
      ok(g.includes(CONFIRM), "sections: the confirm button");
      ok(!/\son[a-z]+=/i.test(html(await page(IDS.ready, { niva: U }))), "no inline on*= attribute on the page with the preview");
      // T9: the fragment of #niva renders the same preview.
      const f = await page(IDS.ready, { niva: U, fragment: "niva" });
      eq(f.status, 200, "fragment: GET ?niva=…&fragment=niva → 200");
      eq(previewOf(html(f)), g, "fragment: the same preview as the full page");
    }
    {
      // Orders on → «Minst mulig»: what the owner must still do.
      const g = previewOf(html(await page(IDS.onReady, { niva: "minst_mulig" })));
      ok(g.includes("<strong>Ta imot bestillinger</strong>: På → Av") && g.includes("Bestillinger du allerede har fått, må du fortsatt svare på. Nye kunder får kontaktinformasjonen din i stedet."),
        "minst_mulig from orders on: the change + «Bestillinger du allerede har fått …»");
      ok(g.includes("Bekreft «Minst mulig»") && !g.includes("Bestillinger sendes til:"), "minst_mulig: confirmable, no order address line");
    }
    {
      // «(ditt unntak)»: orders on, stock check off = an exception of «Utnytte mulighetene».
      const w = rs.setOwnerFeatureValue("rfb", IDS.exc, "products.stock_check", false, { actor: "owner" });
      eq(w.kind, "ok", "exception: stock check switched off");
      const g = previewOf(html(await page(IDS.exc, { niva: U })));
      ok(g.includes("<strong>Minn meg på å bekrefte lagerstatus</strong>: Av → På (ditt unntak)") && g.includes("Påminnelse om lagerstatus på e-post (høyst én hver 14. dag)"),
        "exception: the reset change is marked «(ditt unntak)» with the stock-check note");
    }

    // ── orderGateReady never switches off / changes an owner with orders on ──
    {
      const id = IDS.onUnready;
      const w0 = writes(id);
      eq(rs.resolveOwnerFeature("rfb", id, "orders.enabled", { db }).value, true, "on, not ready: orders are still shown on");
      const g = previewOf(html(await page(id, { niva: U })));
      ok(!g.includes(CANNOT) && (g.includes(CONFIRM) || g.includes("Valgene dine er allerede slik")), "on, not ready: «Utnytte mulighetene» is not blocked (nothing to switch on)");
      const p = await post(id, { level: U, confirmed: "1" });
      eq(p.status, 303, "on, not ready: POST confirmed → 303");
      eq(optIn(id), 1, "on, not ready: orders stay on");
      const put = rs.setOwnerFeatureValue("rfb", id, "orders.enabled", true, { actor: "owner" });
      eq([put.kind, put.kind === "ok" ? put.changed : null], ["ok", false], "on, not ready: PUT on is a no-op, never refused");
      const off = await post(id, { level: "minst_mulig", confirmed: "1" });
      ok(off.status === 303 && optIn(id) === 0, "on, not ready: the owner can still switch off («Minst mulig»)");
      const on = rs.setOwnerFeatureValue("rfb", id, "orders.enabled", true, { actor: "owner" });
      eq([on.kind, on.kind === "blocked" ? on.block : null, optIn(id)], ["blocked", "requirement_not_met", 0], "off, not ready: switching on again is refused");
      ok(w0 !== writes(id), "on, not ready: (the off switch was written)");
    }

    // ── A level never changes comms.news or visibility.profile ────────────────
    for (const lv of ch.OWNER_LEVELS) {
      ok(lv.values.every(([k]) => k !== "comms.news" && !k.startsWith("visibility.")), `invariant: ${lv.key} has no comms.news / visibility.* key`);
    }
    {
      const id = IDS.ready;
      rs.setOwnerFeatureValue("rfb", id, "comms.news", true, { actor: "owner" });
      const before = ["comms.news", "visibility.profile"].map((k) => rs.resolveOwnerFeature("rfb", id, k as any, { db }).value);
      for (const lv of ["utnytte_mulighetene", "minst_mulig", "utnytte_mulighetene"]) ch.applyOwnerLevel("rfb", id, lv, { actor: "owner" });
      const after = ["comms.news", "visibility.profile"].map((k) => rs.resolveOwnerFeature("rfb", id, k as any, { db }).value);
      eq(after, before, "invariant: levels leave comms.news and visibility.profile as they were");
    }

    // ── iff: hard requirements empty ⇔ isEligibleForRealOrder() with orders on ──
    {
      const combos: Array<[string, Seed]> = [
        ["iff-ok", {}], ["iff-unver", { isVerified: false }], ["iff-noemail", { email: null }], ["iff-blank", { email: "  " }],
        ["iff-pending", { checked: "pending" }], ["iff-second", { checked: "second_line" }], ["iff-noknow", { checked: "none" }],
        ["iff-umbrella", { umbrella: true }], ["iff-inactive", { active: false }], ["iff-blocked", { email: "sperret@t10-blocked.example.no" }],
        ["iff-unver-noemail", { isVerified: false, email: null }], ["iff-noprod", { products: 0 }],
      ];
      for (const [id, o] of combos) {
        seed(db, id, o);
        const gate = (() => {
          db.prepare("UPDATE agents SET order_notifications_opt_in = 1 WHERE id = ?").run(id);
          const v = cart.isEligibleForRealOrder(id, db);
          db.prepare("UPDATE agents SET order_notifications_opt_in = 0 WHERE id = ?").run(id);
          return v;
        })();
        const req = ch.ownerLevelRequirements("rfb", id, U);
        eq(req.hard.length === 0, gate, `iff ${id}: hard requirements empty (${req.hard.map((h) => h.code).join(",") || "none"}) ⇔ the gate with orders on (${gate})`);
        eq(cart.orderReadiness(db, id).ready, gate, `iff ${id}: orderReadiness.ready = the gate with orders on`);
        eq(optIn(id), 0, `iff ${id}: orderReadiness kept no write`);
        const out = ch.applyOwnerLevel("rfb", id, U, { actor: "admin", detail: "t10" });
        eq(out.kind === "ok" && optIn(id) === 1, gate, `iff ${id}: the level switches orders on iff the gate would be open`);
        if (gate) eq(cart.isEligibleForRealOrder(id, db), true, `iff ${id}: … and the real gate is then open`);
      }
    }
  } catch (err: any) {
    sum.failed++;
    sum.failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    if (prevAllow === undefined) delete process.env[ALLOW_ENV]; else process.env[ALLOW_ENV] = prevAllow;
    if (prevGate === undefined) delete process.env[GATE_ENV]; else process.env[GATE_ENV] = prevGate;
    initMod.__setDbForTesting(prevDb as any);
    try { db.close(); } catch { /* ignore */ }
  }
  return sum;
}

if (require.main === module) {
  runOwnerFeaturesT10PreviewTests({ log: true }).then((r) => {
    console.info(`owner-features-t10-preview: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
