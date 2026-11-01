/**
 * owner-features-t5-anchors.test.ts — dev-request 2026-10-30-rfb-eierportal-
 * testrunde-1, slice T5 («lagres der du står», steg 1, server side), AC1.
 *
 * The anchor contract (owner-features/anchors.ts):
 *   level      preview link …/valg?niva=<level>#niva-forhandsvis, the preview
 *              inside #niva; confirming → 303 …?endret=<n>#niva
 *   switch     #valg-<key>; its confirm panel inside li#valg-<key>
 *   news       the question → #gruppe-comms (the row: #valg-comms.news)
 *   planned    #planlagt-<key>
 *   undo       back to the row or card that was undone
 *   messages   in the card or row concerned, never in the top card
 *
 *   r  RFB «Mine valg» (/eier/:id/valg/*): every POST outcome — saved, no
 *      change, refused, invalid, rate-limited, undo, news answer, «Gi meg
 *      beskjed», order address — answers 303 with the contracted anchor; the
 *      GET page puts the message / panel inside that element; every <form>
 *      in .mv-page, submitted as rendered, lands on an anchor; GET never
 *      writes; the allowlist still gates (404); the script never navigates
 *      to the anchor-less Response.url and has no inline handlers.
 *   g  gårdssalg «Mine valg» (/kategori/gardssalg/eier/:slug/valg/*), the
 *      same contract over real HTTP.
 *
 * Real routers + services on the production schema in in-memory DBs (RFB:
 * handlers pulled off the router stack, as owner-features-s2e; gårdssalg: an
 * HTTP server, as gardssalg-owner-features-o1a). Exported
 * runOwnerFeaturesT5AnchorsTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/owner-features-t5-anchors.test.ts
 */

import Database from "better-sqlite3";
import * as vm from "vm";

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

const RFB_ENV = [
  "OWNER_FEATURES_ALLOWED_SUBJECTS", "OWNER_VERIFIED_OWNER_GATE_ENABLED", "OWNER_UNIFIED_SESSION_ENABLED", "OWNER_PAUSE_ENABLED",
  "OWNER_ORDER_EMAIL_ENABLED", "OWNER_FEATURES_ENFORCE",
];
const OWNED_ID = "t5-owned";
const UNVERIFIED_ID = "t5-unverified";
const NEWS_ID = "t5-news";
const NEWS_NO_ID = "t5-news-no";
const FORMS_ID = "t5-forms";
const OUTSIDE_ID = "t5-outside";

/** The element with id="<id>" (from its start tag to its matching end tag), or "". */
export function elementById(html: string, id: string): string {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) return "";
  const start = html.lastIndexOf("<", at);
  const tag = (/^<([a-z0-9]+)/i.exec(html.slice(start)) || [])[1];
  if (!tag) return "";
  const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, "gi");
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return html.slice(start);
}

/** The forms in a page: method, action and the fields a plain submit sends. */
export function pageForms(html: string): Array<{ tag: string; method: string; action: string; fields: Record<string, string> }> {
  const out: Array<{ tag: string; method: string; action: string; fields: Record<string, string> }> = [];
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
    const attrs = m[1];
    const inner = m[2];
    const method = ((/\smethod="([^"]*)"/.exec(attrs) || [])[1] || "get").toLowerCase();
    const action = ((/\saction="([^"]*)"/.exec(attrs) || [])[1] || "").replace(/&amp;/g, "&");
    const fields: Record<string, string> = {};
    for (const inp of inner.matchAll(/<input\b([^>]*)>/g)) {
      const name = (/\sname="([^"]*)"/.exec(inp[1]) || [])[1];
      if (!name) continue;
      const type = (/\stype="([^"]*)"/.exec(inp[1]) || [])[1] || "text";
      let value = ((/\svalue="([^"]*)"/.exec(inp[1]) || [])[1] || "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
      if (type === "email" && !value) value = "ny-adresse@t5.example.no";
      fields[name] = value;
    }
    for (const sel of inner.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
      const name = (/\sname="([^"]*)"/.exec(sel[1]) || [])[1];
      if (!name) continue;
      const opt = /<option value="([^"]*)" selected>/.exec(sel[2]) || /<option value="([^"]*)"/.exec(sel[2]);
      fields[name] = opt ? opt[1] : "";
    }
    out.push({ tag: `<form${attrs}>`, method, action, fields });
  }
  return out;
}

function seedProducer(db: Database.Database, id: string, o: { verified?: boolean } = {}): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
        order_notifications_opt_in)
     VALUES (?, ?, 'Testprodusent for T5.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, ?, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z', 0)`,
  ).run(id, `Ankergard ${id}`, `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`, o.verified === false ? 0 : 1);
  db.prepare(
    `INSERT INTO agent_knowledge (agent_id, email, website, about, verification_status, verified_second_line)
     VALUES (?, ?, ?, 'Liten familiegård.', 'verified', 0)`,
  ).run(id, `post@${id}.example.no`, `https://${id}.example.no`);
  db.prepare(
    `INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, category, description, availability_source)
     VALUES (?, ?, 'Poteter', 'poteter', 30, 'kg', 'in_stock', 'vegetables', NULL, 'admin_producer_confirmed')`,
  ).run(`p-${id}`, id);
}

export async function runOwnerFeaturesT5AnchorsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  /** The top card (heading «Mine valg») — never holds a message. */
  const topCard = (b: string) => {
    const i = b.indexOf(`<h1>Mine valg</h1>`);
    if (i < 0) return "";
    const start = b.lastIndexOf(`<div class="ep-card">`, i);
    return b.slice(start, b.indexOf("</nav>", i));
  };
  const toastIn = (b: string, id: string) => elementById(b, id).includes(`class="mv-toast`);
  const toastCount = (b: string) => (b.match(/class="mv-toast[ "]/g) || []).length;

  // ══════════════════════════════════════════════════════════════════════
  // r — RFB
  // ══════════════════════════════════════════════════════════════════════
  {
    const initMod = require("../database/init") as typeof import("../database/init");
    const prevDb = initMod.__peekDbForTesting();
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of RFB_ENV) prevEnv[k] = process.env[k];
    const db = new Database(":memory:");
    db.pragma("journal_mode = DELETE");
    db.pragma("foreign_keys = ON");
    const prevLog = console.log;
    if (!log) console.log = () => { /* silence route chatter */ };

    function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
      const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
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

    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);
      for (const k of RFB_ENV) delete process.env[k];
      for (const m of ["./owner-portal", "./owner-features"]) {
        try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
      }
      const featuresMod = require("./owner-features") as typeof import("./owner-features");
      const pg = require("../owner-features/page") as typeof import("../owner-features/page");
      const anchors = require("../owner-features/anchors") as typeof import("../owner-features/anchors");
      const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");

      const SEEDED = [OWNED_ID, UNVERIFIED_ID, NEWS_ID, NEWS_NO_ID, FORMS_ID, OUTSIDE_ID];
      for (const id of SEEDED) seedProducer(db, id, { verified: id !== UNVERIFIED_ID });
      const tokens: Record<string, string> = {};
      for (const id of SEEDED) {
        tokens[id] = `tok-${id}`;
        db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
          .run(`mlsess_${id}`, `post@${id}.example.no`, tokens[id], id, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
      }
      process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = SEEDED.filter((id) => id !== OUTSIDE_ID).map((id) => `rfb:${id}`).join(",");

      const H: Record<string, Function> = {
        page: findRouteHandler(featuresMod.default, "/eier/:agentId/valg", "get"),
        sett: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/sett", "post"),
        niva: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/niva", "post"),
        angre: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/angre", "post"),
        intro: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/intro", "post"),
        interesse: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/interesse", "post"),
        "ordre-epost": findRouteHandler(featuresMod.default, "/eier/:agentId/valg/ordre-epost", "post"),
      };
      const page = (id: string, query: Record<string, string> = {}) => invoke(H.page, makeReq({ params: { agentId: id }, query, token: tokens[id] }));
      const pageHtml = async (id: string, query: Record<string, string> = {}) => String((await page(id, query)).body ?? "");
      /** The GET page for a redirect target (its query, as the browser would request it). */
      const follow = async (id: string, location: string) => {
        const q = location.split("#")[0].split("?")[1] ?? "";
        return pageHtml(id, Object.fromEntries(new URLSearchParams(q)));
      };
      const post = (h: Function, id: string, body: any, o: { reset?: boolean; headers?: Record<string, string> } = {}) => {
        if (o.reset !== false) featuresMod.__resetOwnerFeaturesRateLimitForTesting();
        return invoke(h, makeReq({ params: { agentId: id }, body, token: tokens[id], headers: o.headers }));
      };
      const loc = (r: HandlerResult) => String(r.body?.__redirect ?? "");
      const P = (id: string, tail: string) => `/eier/${id}/valg${tail}`;
      const writes = (id: string) => [
        (db.prepare("SELECT COUNT(*) AS n FROM owner_feature_settings WHERE subject_id = ?").get(id) as any).n,
        (db.prepare("SELECT COUNT(*) AS n FROM owner_feature_audit WHERE subject_id = ?").get(id) as any).n,
        (db.prepare("SELECT COUNT(*) AS n FROM owner_feature_change_batch WHERE subject_id = ?").get(id) as any).n,
        (db.prepare("SELECT order_notifications_opt_in AS v FROM agents WHERE id = ?").get(id) as any).v,
      ];
      const endret = (l: string) => Number((/endret=(\d+)/.exec(l) || [])[1] || 0);

      // ── Level: preview link, preview inside #niva, confirm → #niva ─────────
      const b0 = await pageHtml(OWNED_ID);
      assertTrue(!/<form method="get"/.test(b0), "r01: no GET form on the page (the level choice is a link)");
      assertTrue(elementById(b0, "niva").includes(`href="/eier/${OWNED_ID}/valg?niva=ta_imot_bestillinger#niva-forhandsvis"`),
        "r02: «Velg «Ta imot bestillinger»» links to …/valg?niva=<level>#niva-forhandsvis inside #niva");
      const w0 = writes(OWNED_ID);
      const pv = await pageHtml(OWNED_ID, { niva: "ta_imot_bestillinger" });
      assertEq(writes(OWNED_ID), w0, "r03: the preview GET writes nothing (T2 kept)");
      assertTrue(elementById(pv, "niva").includes(`id="niva-forhandsvis"`) && elementById(pv, "niva-forhandsvis").includes("Bytte til «Ta imot bestillinger»?"),
        "r04: the level preview stands inside #niva");
      assertTrue(!pv.includes(`id="bekreft"`), "r05: no panel above the level card any more");
      const lv0 = await post(H.niva, OWNED_ID, { level: "ta_imot_bestillinger" });
      assertEq([lv0.status, loc(lv0)], [303, P(OWNED_ID, "?niva=ta_imot_bestillinger#niva-forhandsvis")], "r06: POST niva unconfirmed → 303 …?niva=<level>#niva-forhandsvis");
      const lv1 = await post(H.niva, OWNED_ID, { level: "ta_imot_bestillinger", confirmed: "1" });
      assertTrue(lv1.status === 303 && new RegExp(`^/eier/${OWNED_ID}/valg\\?endret=\\d+#niva$`).test(loc(lv1)), `r07: confirming a level → 303 …?endret=<n>#niva (${loc(lv1)})`);
      const pl1 = await follow(OWNED_ID, loc(lv1));
      assertTrue(toastIn(pl1, "niva") && !toastIn(pl1, "mv-toast-slot") && !topCard(pl1).includes("mv-toast"), "r08: the level message stands in #niva (not the slot, not the top card)");
      const lv2 = await post(H.niva, OWNED_ID, { level: "ta_imot_bestillinger", confirmed: "1" });
      assertEq(loc(lv2), P(OWNED_ID, "?melding=niva_valgt&ved=niva#niva"), "r09: the same level again (no change) → #niva");
      assertTrue(toastIn(await follow(OWNED_ID, loc(lv2)), "niva"), "r10: …and its message is in #niva");
      assertEq(loc(await post(H.niva, OWNED_ID, { level: "bogus", confirmed: "1" })), P(OWNED_ID, "?melding=ugyldig&ved=niva#niva"), "r11: unknown level → #niva");
      const lvU = await post(H.niva, UNVERIFIED_ID, { level: "ta_imot_bestillinger", confirmed: "1" });
      assertEq(loc(lvU), P(UNVERIFIED_ID, "?melding=hoppet&nokkel=orders.enabled&ved=niva#niva"), "r12: a skipped key (requirement) → #niva");
      assertTrue(toastIn(await follow(UNVERIFIED_ID, loc(lvU)), "niva"), "r13: …message in #niva");

      // ── Undo a level → back to #niva ─────────────────────────────────────
      const ul = await post(H.angre, OWNED_ID, { batch: String(endret(loc(lv1))) });
      assertTrue(ul.status === 303 && /\?endret=\d+#niva$/.test(loc(ul)), `r14: undoing a level → 303 …#niva (${loc(ul)})`);
      assertTrue(toastIn(await follow(OWNED_ID, loc(ul)), "niva"), "r15: the undo message stands in #niva");
      const ul2 = await post(H.angre, OWNED_ID, { batch: String(endret(loc(lv1))) });
      assertEq(loc(ul2), P(OWNED_ID, "?melding=angre_umulig&ved=niva#niva"), "r16: undoing it again (refused) → still the level card");
      assertEq(loc(await post(H.angre, OWNED_ID, { batch: "abc" })), P(OWNED_ID, "?melding=angre_umulig&ved=endringslogg#endringslogg"), "r17: a junk batch id → the change log card");

      // ── One switch: confirm panel in the row, save, no-op, refusals ──────
      const s1 = await post(H.sett, OWNED_ID, { key: "orders.enabled", value: "true" });
      assertEq([s1.status, loc(s1)], [303, P(OWNED_ID, "?bekreft=orders.enabled&verdi=1#valg-orders.enabled")], "r18: confirmOn switch → 303 …?bekreft=…#valg-<key>");
      const cp = await follow(OWNED_ID, loc(s1));
      const cpRow = elementById(cp, "valg-orders.enabled");
      assertTrue(cpRow.startsWith(`<li class="mv-item" id="valg-orders.enabled"`) && cpRow.includes(`data-confirm-key="orders.enabled"`) && cpRow.includes(`name="confirmed" value="1"`),
        "r19: the confirm panel stands inside li#valg-orders.enabled");
      assertEq((cp.match(/data-confirm-key=/g) || []).length, 1, "r20: exactly one confirm panel on the page");
      assertTrue(/<form method="post" action="[^"]+\/valg\/sett" class="mv-confirm-form" data-mv-row="gruppe-orders">/.test(cpRow), "r21: the panel's form names its card for the script");
      const s2 = await post(H.sett, OWNED_ID, { key: "orders.enabled", value: "true", confirmed: "1" });
      assertTrue(s2.status === 303 && new RegExp(`\\?endret=\\d+#valg-orders\\.enabled$`).test(loc(s2)), `r22: confirmed → 303 …?endret=<n>#valg-orders.enabled (${loc(s2)})`);
      const pS2 = await follow(OWNED_ID, loc(s2));
      assertTrue(toastIn(pS2, "valg-orders.enabled") && elementById(pS2, "valg-orders.enabled").includes(">Angre<"), "r23: the saved message (with «Angre») stands in the row");
      assertTrue(!toastIn(pS2, "mv-toast-slot") && !topCard(pS2).includes("mv-toast") && toastCount(pS2) === 1, "r24: one message only, not in the slot or the top card");
      const noop = await post(H.sett, OWNED_ID, { key: "orders.enabled", value: "true", confirmed: "1" });
      assertEq(loc(noop), P(OWNED_ID, "?melding=ingen_endring&ved=valg-orders.enabled#valg-orders.enabled"), "r25: no change → the row");
      assertTrue(toastIn(await follow(OWNED_ID, loc(noop)), "valg-orders.enabled"), "r26: …message in the row");
      const inv = await post(H.sett, OWNED_ID, { key: "orders.enabled", value: "kanskje", confirmed: "1" });
      assertEq(loc(inv), P(OWNED_ID, "?melding=ugyldig&ved=valg-orders.enabled#valg-orders.enabled"), "r27: invalid value → the row");
      const cs = await post(H.sett, OWNED_ID, { key: "visibility.leaderboard", value: "false", confirmed: "1" });
      assertEq(loc(cs), P(OWNED_ID, "?melding=sperret&nokkel=visibility.leaderboard&ved=valg-visibility.leaderboard#valg-visibility.leaderboard"), "r28: refused (planned key) → its anchor");
      const unk = await post(H.sett, OWNED_ID, { key: "nope.key", value: "x" });
      assertEq(loc(unk), P(OWNED_ID, "?melding=ugyldig#mv-toast-slot"), "r29: unknown key → the message slot (no row exists)");
      const pUnk = await follow(OWNED_ID, loc(unk));
      assertTrue(toastIn(pUnk, "mv-toast-slot") && !topCard(pUnk).includes("mv-toast"), "r30: …message in the slot, not the top card");
      const pause = await post(H.sett, OWNED_ID, { key: "visibility.profile", value: "false", confirmed: "1", until: "2001-01-01" });
      assertEq(loc(pause), P(OWNED_ID, "?melding=ugyldig_dato&ved=valg-visibility.profile#valg-visibility.profile"), "r31: a bad resume date → the pause row");

      // Undo a single switch → back to its row.
      const us = await post(H.angre, OWNED_ID, { batch: String(endret(loc(s2))) });
      assertTrue(us.status === 303 && /\?endret=\d+#valg-orders\.enabled$/.test(loc(us)), `r32: undoing a switch → 303 …#valg-orders.enabled (${loc(us)})`);
      assertTrue(toastIn(await follow(OWNED_ID, loc(us)), "valg-orders.enabled"), "r33: the undo message stands in the row");

      // Rate limit: the 31st write in a minute → 303 at the row.
      featuresMod.__resetOwnerFeaturesRateLimitForTesting();
      for (let i = 0; i < featuresMod.OWNER_FEATURES_WRITES_PER_MINUTE; i++) await post(H.sett, OWNED_ID, { key: "nope.key", value: "x" }, { reset: false });
      const wRl = writes(OWNED_ID);
      const rl = await post(H.sett, OWNED_ID, { key: "orders.enabled", value: "true", confirmed: "1" }, { reset: false });
      assertEq([rl.status, loc(rl)], [303, P(OWNED_ID, "?melding=for_mange&ved=valg-orders.enabled#valg-orders.enabled")], "r34: rate-limited → 303 «For mange endringer» at the row");
      assertEq(writes(OWNED_ID), wRl, "r35: …and nothing written");
      assertTrue(elementById(await follow(OWNED_ID, loc(rl)), "valg-orders.enabled").includes("For mange endringer. Prøv igjen om litt."), "r36: …the message stands in the row");
      const rlN = await post(H.niva, OWNED_ID, { level: "bare_synlig", confirmed: "1" }, { reset: false });
      assertEq(loc(rlN), P(OWNED_ID, "?melding=for_mange&ved=niva#niva"), "r37: rate-limited level → #niva");
      featuresMod.__resetOwnerFeaturesRateLimitForTesting();

      // Cross-site and the allowlist are unchanged (their own pages).
      const xs = await post(H.sett, OWNED_ID, { key: "orders.enabled", value: "true", confirmed: "1" }, { headers: { origin: "https://evil.example" } });
      assertEq(xs.status, 403, "r38: a cross-site POST is still refused with 403");
      assertEq((await post(H.sett, OUTSIDE_ID, { key: "orders.enabled", value: "true", confirmed: "1" })).status, 404, "r39: not on the allowlist → POST 404 (unchanged)");
      assertEq((await page(OUTSIDE_ID)).status, 404, "r40: not on the allowlist → page 404 (unchanged)");
      assertEq(writes(OUTSIDE_ID), [0, 0, 0, 0], "r41: …nothing written outside the list");

      // ── The news question → #gruppe-comms; the row #valg-comms.news ──────
      const newsLive = reg.findOwnerFeature("comms.news")?.status === "live";
      const i1 = await post(H.intro, NEWS_ID, { answer: "yes" });
      if (newsLive) {
        assertTrue(i1.status === 303 && /\?endret=\d+#gruppe-comms$/.test(loc(i1)), `r42: «Ja takk» → 303 …?endret=<n>#gruppe-comms (${loc(i1)})`);
        const pi = await follow(NEWS_ID, loc(i1));
        assertTrue(elementById(pi, "gruppe-comms").includes(`id="valg-comms.news"`) && toastIn(pi, "valg-comms.news"), "r43: the answer's message stands in the row #valg-comms.news inside #gruppe-comms");
        const ui = await post(H.angre, NEWS_ID, { batch: String(endret(loc(i1))) });
        assertTrue(/#valg-comms\.news$/.test(loc(ui)), `r44: undoing the answer → the row (${loc(ui)})`);
      } else {
        assertEq(loc(i1), P(NEWS_ID, "?melding=intro_ja&ved=gruppe-comms#gruppe-comms"), "r42: «Ja takk» → #gruppe-comms");
      }
      const i2 = await post(H.intro, NEWS_NO_ID, { answer: "no" });
      assertEq(loc(i2), P(NEWS_NO_ID, "?melding=intro_nei&ved=gruppe-comms#gruppe-comms"), "r45: «Nei takk» → #gruppe-comms");
      assertTrue(toastIn(await follow(NEWS_NO_ID, loc(i2)), "gruppe-comms"), "r46: …message in the group card");
      assertEq(loc(await post(H.intro, NEWS_NO_ID, { answer: "kanskje" })), P(NEWS_NO_ID, "?melding=ugyldig&ved=gruppe-comms#gruppe-comms"), "r47: junk answer → #gruppe-comms");

      // ── Planned item → #planlagt-<key> ───────────────────────────────────
      const KEY = "orders.daily_cap";
      const ip = await post(H.interesse, OWNED_ID, { key: KEY });
      assertEq(loc(ip), P(OWNED_ID, `?melding=interesse&ved=planlagt-${KEY}#planlagt-${KEY}`), "r48: «Gi meg beskjed» → #planlagt-<key>");
      const pp = await follow(OWNED_ID, loc(ip));
      assertTrue(toastIn(pp, `planlagt-${KEY}`) && /<details class="ep-card mv-planned" id="planlagt" open>/.test(pp), "r49: the message stands in the planned row, and the box is open");
      assertTrue(/<details class="ep-card mv-planned" id="planlagt">/.test(await pageHtml(OWNED_ID)), "r50: without a message the planned box stays closed");
      assertEq(loc(await post(H.interesse, OWNED_ID, { key: "orders.enabled" })), P(OWNED_ID, "?melding=ugyldig&ved=planlagt#planlagt"), "r51: a live key → refused, the planned box");

      // ── Order address → #valg-orders.email ───────────────────────────────
      assertEq(loc(await post(H["ordre-epost"], OWNED_ID, { email: "x@t5.example.no" })), P(OWNED_ID, "?melding=ordre_epost_av&ved=valg-orders.email#valg-orders.email"), "r52: order address → #valg-orders.email");

      // ── `ved=` only places at known ids ──────────────────────────────────
      const odd = await pageHtml(OWNED_ID, { melding: "ingen_endring", ved: `x"><script>` });
      assertTrue(toastIn(odd, "mv-toast-slot") && !odd.includes(`x"><script>`), "r53: an unknown ved= → the slot, nothing echoed");
      assertTrue(anchors.isOwnerPageAnchor("valg-orders.enabled") && !anchors.isOwnerPageAnchor("velkommen") && !anchors.isOwnerPageAnchor("__proto__"), "r54: the anchor list");

      // ── Every <form> in .mv-page lands on an anchor ──────────────────────
      process.env.OWNER_ORDER_EMAIL_ENABLED = "true";
      await post(H.sett, FORMS_ID, { key: "orders.enabled", value: "true", confirmed: "1" });
      const states: Array<Record<string, string>> = [
        {}, { bekreft: "orders.enabled", verdi: "0" }, { bekreft: "visibility.profile", verdi: "0" }, { niva: "bare_synlig" },
        { endret: String((db.prepare("SELECT MAX(id) AS m FROM owner_feature_change_batch WHERE subject_id = ?").get(FORMS_ID) as any).m) },
      ];
      let formsSeen = 0;
      const bad: string[] = [];
      for (const q of states) {
        const html = await pageHtml(FORMS_ID, q);
        const mv = html.slice(html.indexOf(`<div class="mv-page">`), html.indexOf("<script>", html.indexOf(`<div class="mv-page">`)));
        for (const f of pageForms(mv)) {
          formsSeen++;
          if (f.method !== "post") { if (!f.action.includes("#")) bad.push(`GET ${f.tag}`); continue; }
          const route = (/\/valg\/([a-z-]+)$/.exec(f.action) || [])[1] || "";
          const h = H[route];
          if (!h) { bad.push(`no route: ${f.tag}`); continue; }
          const r = await post(h, FORMS_ID, f.fields);
          const l = loc(r);
          if (r.status !== 303 || !/#[A-Za-z0-9._-]+$/.test(l)) bad.push(`${JSON.stringify(q)} ${f.tag} ${JSON.stringify(f.fields)} → ${r.status} ${l}`);
        }
      }
      assertTrue(formsSeen > 10, `r55: forms found on the page (${formsSeen})`);
      assertEq(bad, [], "r56: every <form> in .mv-page answers 303 with an anchor");

      // ── The script: no anchor-less navigation, no inline handlers ────────
      assertTrue(!pg.OWNER_PAGE_SCRIPT.includes("window.location") && !pg.OWNER_PAGE_SCRIPT.includes("getElementById(\"bekreft\")"), "r57: the script never navigates to Response.url");
      assertTrue(pg.OWNER_PAGE_SCRIPT.includes("f.submit()"), "r58: errors fall back to the plain form POST (its 303 keeps the anchor)");
      let compiles = true;
      try { new vm.Script(pg.OWNER_PAGE_SCRIPT); } catch { compiles = false; }
      assertTrue(compiles, "r59: the script compiles");
      assertTrue(!/\son[a-z]+\s*=/i.test(pS2.replace(/<script>[\s\S]*?<\/script>/g, "")), "r60: no inline event handlers on the page (CSP)");
    } catch (err: any) {
      failed++;
      failures.push("r: unexpected error: " + String(err?.stack || err));
    } finally {
      console.log = prevLog;
      for (const k of RFB_ENV) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
      try { (require("./owner-features") as typeof import("./owner-features")).__resetOwnerFeaturesRateLimitForTesting(); } catch { /* ignore */ }
      if (prevDb) initMod.__setDbForTesting(prevDb);
      try { db.close(); } catch { /* ignore */ }
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // g — gårdssalg (Opplevagent), the same contract over HTTP
  // ══════════════════════════════════════════════════════════════════════
  {
    const ENV_KEYS = ["EXPERIENCES_DB_PATH", "OA_OWNER_FEATURES_ENABLED", "OWNER_FEATURES_ALLOWED_SUBJECTS", "BOOKING_DISPATCH_ENABLED"];
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.OA_OWNER_FEATURES_ENABLED = "true";
    process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = "gardssalg:t5-g-test";
    delete process.env.BOOKING_DISPATCH_ENABLED;
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("../services/gardssalg-claim"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("../services/blocklist-service"),
      require.resolve("./gardssalg-claim"),
      require.resolve("./gardssalg-owner-features"),
    ]);
    const servers: any[] = [];
    const initMod = require("../database/init") as typeof import("../database/init");
    const prevRfbDb = initMod.__peekDbForTesting();
    const prevLog = console.log;
    if (!log) console.log = () => { /* silence route chatter */ };
    try {
      const rfbDb = new Database(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const ch = require("../owner-features/changes") as typeof import("../owner-features/changes");
      const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");

      expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, brreg_active, hjemmeside, epost, content_source, products,
           producer_type, enrichment_state, verification_status, source, confidence, booking_live, is_test_provider, claimed_at)
        VALUES ('t5-g-test', 'Ankergård Sideri', 't5-ankergard', 'experiences', '918500001', 1, 1, 'https://t5-ankergard.no', 'post@t5-ankergard.no',
          'claim', '["Eplesider"]', 'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium', 0, 1, datetime('now'))
      `).run();
      expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at)
         VALUES ('gsc_t5', 't5-g-test', 'eier@t5-ankergard.no', 'verified_domain_address', 'tok-t5g', 1, datetime('now'), datetime('now','+7 days'))`,
      ).run();

      const expressMod = require("express") as typeof import("express");
      const claimRouter = (require("./gardssalg-claim") as typeof import("./gardssalg-claim")).default;
      const ownerFeaturesRoutes = require("./gardssalg-owner-features") as typeof import("./gardssalg-owner-features");
      ownerFeaturesRoutes.__resetGardssalgOwnerFeaturesRateLimitForTesting();
      const app = expressMod();
      app.use("/", claimRouter);
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
      const SLUG = "t5-ankergard";
      const P = (tail = "") => `/kategori/gardssalg/eier/${SLUG}/valg${tail}`;
      const auth = { Cookie: "oa_owner_session=tok-t5g" };
      const form = { "Content-Type": "application/x-www-form-urlencoded", ...auth };
      const enc = (o: Record<string, string>) => new URLSearchParams(o).toString();
      const post = (route: string, fields: Record<string, string>, reset = true) => {
        if (reset) ownerFeaturesRoutes.__resetGardssalgOwnerFeaturesRateLimitForTesting();
        return req("POST", P(`/${route}`), form, enc(fields));
      };
      const getPage = async (location = P()) => (await req("GET", location.split("#")[0], auth)).body;
      const L = (r: { headers: any }) => String(r.headers.location ?? "");
      const endret = (l: string) => Number((/endret=(\d+)/.exec(l) || [])[1] || 0);
      const KEY = "booking.enabled";

      const p0 = await getPage();
      assertTrue(p0.includes(`class="mv-page"`), "g01: the gårdssalg «Mine valg» page renders");
      assertTrue(!/<form method="get"/.test(p0), "g02: no GET form (the level choice is a link)");
      const lvlKey = ch.GARDSSALG_OWNER_LEVELS.find((l) => l.key !== "bare_synlig")!.key;
      assertTrue(elementById(p0, "niva").includes(`href="${P(`?niva=${lvlKey}#niva-forhandsvis`)}"`), "g03: the level link carries #niva-forhandsvis, inside #niva");
      const pv = await getPage(P(`?niva=${lvlKey}`));
      assertTrue(elementById(pv, "niva").includes(`id="niva-forhandsvis"`), "g04: the preview stands inside #niva");
      const lv0 = await post("niva", { level: lvlKey });
      assertEq([lv0.status, L(lv0)], [303, P(`?niva=${lvlKey}#niva-forhandsvis`)], "g05: POST niva unconfirmed → #niva-forhandsvis");

      const s1 = await post("sett", { key: KEY, value: "true" });
      assertEq([s1.status, L(s1)], [303, P(`?bekreft=${KEY}&verdi=1#valg-${KEY}`)], "g06: confirmOn switch → …#valg-<key>");
      const cpRow = elementById(await getPage(L(s1)), `valg-${KEY}`);
      assertTrue(cpRow.includes(`data-confirm-key="${KEY}"`), "g07: the confirm panel stands inside li#valg-<key>");
      const s2 = await post("sett", { key: KEY, value: "true", confirmed: "1" });
      assertTrue(s2.status === 303 && new RegExp(`\\?endret=\\d+#valg-booking\\.enabled$`).test(L(s2)), `g08: confirmed → …?endret=<n>#valg-<key> (${L(s2)})`);
      const pS2 = await getPage(L(s2));
      assertTrue(toastIn(pS2, `valg-${KEY}`) && !toastIn(pS2, "mv-toast-slot") && !topCard(pS2).includes("mv-toast"), "g09: the message stands in the row");
      assertEq(L(await post("sett", { key: KEY, value: "true", confirmed: "1" })), P(`?melding=ingen_endring&ved=valg-${KEY}#valg-${KEY}`), "g10: no change → the row");
      assertEq(L(await post("sett", { key: "nope.key", value: "x" })), P("?melding=ugyldig#mv-toast-slot"), "g11: unknown key → the slot");
      const us = await post("angre", { batch: String(endret(L(s2))) });
      assertTrue(new RegExp(`\\?endret=\\d+#valg-booking\\.enabled$`).test(L(us)), `g12: undo → the row (${L(us)})`);
      assertTrue(toastIn(await getPage(L(us)), `valg-${KEY}`), "g13: …the undo message in the row");
      assertEq(L(await post("angre", { batch: "abc" })), P("?melding=angre_umulig&ved=endringslogg#endringslogg"), "g14: junk undo → the change log");

      const lv1 = await post("niva", { level: lvlKey, confirmed: "1" });
      assertTrue(/#niva$/.test(L(lv1)), `g15: confirming a level → …#niva (${L(lv1)})`);
      assertTrue(toastIn(await getPage(L(lv1)), "niva"), "g16: the level message stands in #niva");
      assertEq(L(await post("niva", { level: "bogus", confirmed: "1" })), P("?melding=ugyldig&ved=niva#niva"), "g17: unknown level → #niva");

      const planned = reg.GARDSSALG_OWNER_FEATURE_REGISTRY.find((e) => e.status === "coming_soon")!.key;
      const ip = await post("interesse", { key: planned });
      assertEq(L(ip), P(`?melding=interesse&ved=planlagt-${planned}#planlagt-${planned}`), "g18: «Gi meg beskjed» → #planlagt-<key>");
      assertTrue(toastIn(await getPage(L(ip)), `planlagt-${planned}`), "g19: …message in the planned row");

      ownerFeaturesRoutes.__resetGardssalgOwnerFeaturesRateLimitForTesting();
      for (let i = 0; i < ownerFeaturesRoutes.GARDSSALG_OWNER_FEATURES_WRITES_PER_MINUTE; i++) await post("sett", { key: "nope.key", value: "x" }, false);
      const rl = await post("sett", { key: KEY, value: "false", confirmed: "1" }, false);
      assertEq([rl.status, L(rl)], [303, P(`?melding=for_mange&ved=valg-${KEY}#valg-${KEY}`)], "g20: rate-limited → 303 at the row");
      ownerFeaturesRoutes.__resetGardssalgOwnerFeaturesRateLimitForTesting();

      // Every form in .mv-page lands on an anchor.
      const bad: string[] = [];
      let formsSeen = 0;
      for (const location of [P(), P(`?bekreft=${KEY}&verdi=1`), P(`?niva=${lvlKey}`)]) {
        const html = await getPage(location);
        const mv = html.slice(html.indexOf(`<div class="mv-page">`), html.indexOf("<script>", html.indexOf(`<div class="mv-page">`)));
        for (const f of pageForms(mv)) {
          formsSeen++;
          if (f.method !== "post") { if (!f.action.includes("#")) bad.push(`GET ${f.tag}`); continue; }
          const route = (/\/valg\/([a-z-]+)$/.exec(f.action) || [])[1] || "";
          const r = await post(route, f.fields);
          if (r.status !== 303 || !/#[A-Za-z0-9._-]+$/.test(L(r))) bad.push(`${location} ${f.tag} → ${r.status} ${L(r)}`);
        }
      }
      assertTrue(formsSeen > 5, `g21: forms found on the page (${formsSeen})`);
      assertEq(bad, [], "g22: every <form> in .mv-page answers 303 with an anchor");
    } catch (err: any) {
      failed++;
      failures.push("g: unexpected error: " + String(err?.stack || err));
    } finally {
      console.log = prevLog;
      for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
      initMod.__setDbForTesting(prevRfbDb);
      try { (require("./gardssalg-owner-features") as typeof import("./gardssalg-owner-features")).__resetGardssalgOwnerFeaturesRateLimitForTesting(); } catch { /* ignore */ }
      restoreModuleCache();
      for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerFeaturesT5AnchorsTests({ log: true }).then((r) => {
    console.info(`\nowner-features-t5-anchors: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
