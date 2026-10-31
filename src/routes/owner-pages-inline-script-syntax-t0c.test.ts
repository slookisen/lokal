/**
 * owner-pages-inline-script-syntax-t0c.test.ts — slice T0c of the owner
 * portal: every inline <script> on the owner-facing pages must be valid
 * JavaScript as the browser receives it.
 *
 * The pages are rendered with TypeScript template literals, so `\"` in the
 * source becomes a bare `"` in the HTML. The portal's change-log script had
 * `"<li class=\"ep-audit-item …\">"`, which reached the browser as
 * `"<li class="ep-audit-item …">"` — a SyntaxError that killed the whole
 * script: «Endringslogg» stayed on «Laster ...» and the fetch save never
 * attached. A source-level review cannot see this; only the rendered HTML can.
 *
 *   r  RFB pages, rendered through the real routers on an in-memory DB:
 *      /eier/:id (login), /eier/:id/portal, /eier/:id/valg, /eier/:id/ordrer,
 *      /produsent/ordre/:token (order link) and /produsent/ordre/:token/kompakt.
 *      Every inline script (no src=, JavaScript type) compiles with vm.Script.
 *   p  the portal script, run in a small fake DOM: the my-audit fetch fills
 *      «Endringslogg» (values HTML-escaped), the fetch save lands on
 *      ?status=saved, an error answer lands on ?status=error, and a failed
 *      fetch falls back to the plain form POST (form.submit()).
 *   g  gårdssalg owner pages (Opplevagent): /kategori/gardssalg/eier/:slug
 *      (login), …/portal (with and without «Mine valg») and …/valg.
 *
 * Exported runOwnerPagesInlineScriptSyntaxT0cTests({log}) -> TestSummary;
 * wired into tests/test.ts. Standalone:
 *   npx tsx src/routes/owner-pages-inline-script-syntax-t0c.test.ts
 */

import Database from "better-sqlite3";
import * as http from "http";
import * as vm from "vm";
import { scriptElements } from "../../tests/helpers/html-script-elements";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface Page {
  status: number;
  text: string;
  location: string | undefined;
}

const RFB_ID = "t0c-owner";
const RFB_TOKEN = "t0c-session-token";
const ORDER_TOKEN = "ctok_t0c-order-1";

/** The JavaScript a page's inline <script> elements hand to the browser. */
export function inlineJsScripts(html: string): string[] {
  const out: string[] = [];
  for (const el of scriptElements(html)) {
    if (/\ssrc\s*=/i.test(el.startTag)) continue;
    const type = (el.startTag.match(/\stype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    if (type && !/^(text|application)\/(javascript|ecmascript)$|^module$/i.test(type)) continue;
    const body = el.content.replace(/^<script[^>]*>/i, "");
    out.push(body);
  }
  return out;
}

function serve(app: any): Promise<{ server: http.Server; get: (p: string, cookie?: string) => Promise<Page> }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port as number;
      const get = (p: string, cookie?: string) => new Promise<Page>((res, rej) => {
        const headers: Record<string, string> = {};
        if (cookie) headers.Cookie = cookie;
        const r = http.request({ method: "GET", host: "127.0.0.1", port, path: p, headers }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => res({
            status: resp.statusCode || 0,
            text: Buffer.concat(chunks).toString("utf8"),
            location: resp.headers.location as string | undefined,
          }));
        });
        r.on("error", rej);
        r.end();
      });
      resolve({ server, get });
    });
  });
}

const close = (s: http.Server | null) => (s ? new Promise<void>((r) => s.close(() => r())) : Promise.resolve());

export async function runOwnerPagesInlineScriptSyntaxT0cTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string, detail?: string): void {
    if (cond) { passed++; if (log) console.info(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}${detail ? `\n    ${detail}` : ""}`;
      failures.push(msg);
      if (log) console.info("  " + msg);
    }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    assertTrue(a === e, label, a === e ? undefined : `expected: ${e}\n    actual:   ${a}`);
  }

  /** Every inline script on the page compiles; returns the scripts. */
  function checkPage(label: string, page: Page): string[] {
    assertEq(page.status, 200, `${label}: renders (200)`);
    const scripts = inlineJsScripts(page.text);
    assertTrue(scripts.length > 0, `${label}: has at least one inline script`);
    scripts.forEach((code, i) => {
      let err: unknown = null;
      try { new vm.Script(code, { filename: `${label}#script${i}` }); } catch (e) { err = e; }
      assertTrue(err === null, `${label}: inline script #${i} is valid JavaScript`, err ? String((err as Error).message || err) : undefined);
    });
    return scripts;
  }

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence route logging */ };
  try {
    await rfbPart();
    await gardssalgPart();
  } finally {
    console.log = prevLog;
  }
  return { passed, failed, failures };

  // ── r + p: RFB owner pages ─────────────────────────────────────────────
  async function rfbPart(): Promise<void> {
    const initMod = require("../database/init") as typeof import("../database/init");
    const cartSvc = require("../services/cart-service") as typeof import("../services/cart-service");
    const ENV_KEYS = ["OWNER_FEATURES_ALLOWED_SUBJECTS", "OWNER_VERIFIED_OWNER_GATE_ENABLED", "ORDER_MESSAGES_ENABLED", "PAYMENTS_ENABLED"];
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
    const prevDb = initMod.__peekDbForTesting();
    const db = new Database(":memory:");
    db.pragma("journal_mode = DELETE");
    db.pragma("foreign_keys = ON");
    let server: http.Server | null = null;
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);
      cartSvc.__setCartTestDb(db as any);
      for (const k of ENV_KEYS) delete process.env[k];
      process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = `rfb:${RFB_ID}`;

      db.prepare(
        `INSERT INTO agents
           (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
            categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at)
         VALUES (?, 'T0c Gard', 'Testprodusent for T0c.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z')`,
      ).run(RFB_ID, `post@${RFB_ID}.example.no`, `https://${RFB_ID}.example.no`, `key-${RFB_ID}`);
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, email, phone, address, postal_code, website, about, verification_status, verified_second_line)
         VALUES (?, ?, '+47 400 00 000', 'Gardsveien 1', '0150', ?, 'Liten familiegård med "sitater" & <tegn>.', 'verified', 0)`,
      ).run(RFB_ID, `post@${RFB_ID}.example.no`, `https://${RFB_ID}.example.no`);
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${RFB_ID}`, `post@${RFB_ID}.example.no`, RFB_TOKEN, RFB_ID, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
      const SQL = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
      const created = SQL(new Date(Date.now() - 3_600_000));
      db.prepare(`
        INSERT INTO orders (id, agent_id, buyer_ref, status, fulfilment, confirm_token, pickup_time, total_nok, payment_mode,
                            notify_sent_at, buyer_name, buyer_email, created_at, updated_at)
        VALUES ('t0c-order-1', ?, 'bref_t0c', 'pending', 'pickup', ?, ?, 90, NULL, ?, 'Kari Kunde', 'kari.t0c@example.com', ?, ?)
      `).run(RFB_ID, ORDER_TOKEN, new Date(Date.now() + 86_400_000).toISOString(), created, created, created);
      db.prepare("INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_snapshot, line_total) VALUES ('t0c-order-1-i1', 't0c-order-1', NULL, 'Poteter', 2, 45, 90)").run();

      const express = require("express");
      const app = express();
      app.use("/", (require("./owner-portal") as typeof import("./owner-portal")).default);
      app.use("/", (require("./owner-orders") as typeof import("./owner-orders")).default);
      app.use("/", (require("./owner-features") as typeof import("./owner-features")).default);
      app.use("/produsent/ordre", (require("./marketplace-cart") as typeof import("./marketplace-cart")).producerOrderRouter);
      const s = await serve(app);
      server = s.server;
      const cookie = `rfb_owner_session=${RFB_TOKEN}`;
      const id = encodeURIComponent(RFB_ID);

      checkPage("r-login /eier/:id", await s.get(`/eier/${id}`));
      const portalScripts = checkPage("r-portal /eier/:id/portal", await s.get(`/eier/${id}/portal`, cookie));
      checkPage("r-valg /eier/:id/valg", await s.get(`/eier/${id}/valg`, cookie));
      checkPage("r-ordrer /eier/:id/ordrer", await s.get(`/eier/${id}/ordrer`, cookie));
      checkPage("r-kompakt /produsent/ordre/:token/kompakt", await s.get(`/produsent/ordre/${ORDER_TOKEN}/kompakt`));
      const link = await s.get(`/produsent/ordre/${ORDER_TOKEN}`);
      assertEq(link.status, 200, "r-ordrelenke /produsent/ordre/:token: renders (200)");
      for (const [i, code] of inlineJsScripts(link.text).entries()) {
        let err: unknown = null;
        try { new vm.Script(code); } catch (e) { err = e; }
        assertTrue(err === null, `r-ordrelenke: inline script #${i} is valid JavaScript`, err ? String(err) : undefined);
      }

      const main = portalScripts.find((c) => c.includes("my-audit")) || "";
      assertTrue(main.includes(`fetch("/api/agents/${id}/my-audit?limit=20"`), "r-portal: the portal script fetches the my-audit feed");
      assertTrue(main.includes(`"/api/agents/${id}/update-profile"`), "r-portal: the portal script saves via update-profile");
      await runPortalScript(main, `/eier/${id}/portal`);
    } catch (err: any) {
      failed++;
      failures.push(`✗ rfb: unexpected error: ${String(err?.stack || err)}`);
    } finally {
      await close(server);
      cartSvc.__setCartTestDb(null);
      for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
      if (prevDb) initMod.__setDbForTesting(prevDb);
      try { db.close(); } catch { /* best-effort */ }
    }
  }

  /** p: run the portal script against a fake DOM and a stubbed fetch. */
  async function runPortalScript(code: string, pathname: string): Promise<void> {
    const flush = () => new Promise<void>((r) => setImmediate(r));
    function makeEnv(fetchImpl: (url: string, init?: any) => Promise<any>) {
      const ul: any = { innerHTML: "" };
      const btn: any = { disabled: false, textContent: "Lagre alle endringer" };
      const listeners: Record<string, Function> = {};
      const fields: Record<string, string> = { field_phone: "+47 400 00 001", field_email: "post@t0c-owner.example.no" };
      const form: any = {
        submitted: 0,
        addEventListener(ev: string, fn: Function) { listeners[ev] = fn; },
        querySelector() { return btn; },
        submit() { this.submitted++; },
      };
      const location: any = { pathname, href: pathname };
      const calls: Array<{ url: string; init?: any }> = [];
      const fetch = (url: string, init?: any) => { calls.push({ url, init }); return fetchImpl(url, init); };
      class FormData { constructor(_f: any) { /* fake */ } get(k: string) { return k in fields ? fields[k] : null; } }
      const document = { getElementById(x: string) { return x === "ep-audit" ? ul : x === "ep-profile-form" ? form : null; } };
      const window: any = { fetch, location };
      const ctx = vm.createContext({ window, document, fetch, FormData, JSON, String, Date, Promise, console: { log() {}, error() {} } });
      return { ctx, ul, btn, form, listeners, location, calls };
    }
    const json = (ok: boolean, body: unknown) => Promise.resolve({ ok, json: () => Promise.resolve(body) });
    const audits = [
      { field_name: "phone", changed_by: "owner", changed_at: "2026-10-01T10:00:00.000Z", old_value: 'a"<b>&', new_value: "+47 400 00 001" },
      { field_name: "about", changed_by: "admin", changed_at: "2026-10-02T10:00:00.000Z", old_value: null, new_value: "Ny tekst" },
    ];

    {
      // p1: the change log loads and escapes values.
      const e1 = makeEnv((url) => url.includes("my-audit") ? json(true, { success: true, audits }) : json(true, { success: true }));
      vm.runInContext(code, e1.ctx);
      for (let i = 0; i < 5; i++) await flush();
      assertTrue(!e1.ul.innerHTML.includes("Laster"), "p-01: «Endringslogg» no longer says «Laster ...»");
      assertTrue((e1.ul.innerHTML.match(/<li class="ep-audit-item">/g) || []).length === 2, "p-02: one list item per audit row", e1.ul.innerHTML);
      assertTrue(e1.ul.innerHTML.includes("<strong>phone</strong> endret av Du") && e1.ul.innerHTML.includes("endret av Support"), "p-03: field and actor are shown");
      assertTrue(e1.ul.innerHTML.includes("a&quot;&lt;b&gt;&amp;") && !e1.ul.innerHTML.includes('a"<b>'), "p-04: values are HTML-escaped", e1.ul.innerHTML);
      assertTrue(e1.ul.innerHTML.includes("(tomt)"), "p-05: a null value shows (tomt)");

      // p2: empty feed.
      const e2 = makeEnv(() => json(true, { success: true, audits: [] }));
      vm.runInContext(code, e2.ctx);
      for (let i = 0; i < 5; i++) await flush();
      assertTrue(e2.ul.innerHTML.includes("Ingen endringer ennå."), "p-06: empty feed says «Ingen endringer ennå.»");

      // p3: fetch save → ?status=saved, with the form fields as JSON.
      const e3 = makeEnv((url) => url.includes("update-profile") ? json(true, { success: true, updated_fields: ["phone"] }) : json(true, { success: true, audits: [] }));
      vm.runInContext(code, e3.ctx);
      assertTrue(typeof e3.listeners.submit === "function", "p-07: the fetch save attaches to the form");
      let prevented = false;
      e3.listeners.submit?.({ preventDefault() { prevented = true; } });
      for (let i = 0; i < 5; i++) await flush();
      const save = e3.calls.find((c) => c.url.includes("update-profile"));
      assertTrue(prevented && !!save && save.init?.method === "POST", "p-08: submit is sent as POST to update-profile");
      assertEq(save ? JSON.parse(save.init.body).phone : null, "+47 400 00 001", "p-09: the payload carries the form value");
      assertEq(e3.location.href, `${pathname}?status=saved`, "p-10: a saved answer lands on ?status=saved");
      assertEq(e3.form.submitted, 0, "p-11: no extra form POST after a successful fetch save");

      // p4: an error answer → ?status=error.
      const e4 = makeEnv((url) => url.includes("update-profile") ? json(false, { success: false, error: "x" }) : json(true, { success: true, audits: [] }));
      vm.runInContext(code, e4.ctx);
      e4.listeners.submit?.({ preventDefault() {} });
      for (let i = 0; i < 5; i++) await flush();
      assertEq(e4.location.href, `${pathname}?status=error`, "p-12: an error answer lands on ?status=error");

      // p5: the fetch fails (network / non-JSON) → the plain form POST runs.
      const e5 = makeEnv((url) => url.includes("update-profile") ? Promise.reject(new Error("offline")) : json(true, { success: true, audits: [] }));
      vm.runInContext(code, e5.ctx);
      e5.listeners.submit?.({ preventDefault() {} });
      for (let i = 0; i < 5; i++) await flush();
      assertEq(e5.form.submitted, 1, "p-13: a failed fetch save falls back to the plain form POST (/eier/:id/save)");
    }
  }

  // ── g: gårdssalg owner pages ───────────────────────────────────────────
  async function gardssalgPart(): Promise<void> {
    const ENV_KEYS = ["EXPERIENCES_DB_PATH", "OA_OWNER_FEATURES_ENABLED", "OWNER_FEATURES_ALLOWED_SUBJECTS"];
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("../services/gardssalg-claim"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("../services/blocklist-service"),
      require.resolve("./gardssalg-claim"),
      require.resolve("./gardssalg-owner-features"),
      require.resolve("./opplevelser"),
      require.resolve("./experiences-mcp"),
      require.resolve("./experiences-seo"),
    ]);
    const initMod = require("../database/init") as typeof import("../database/init");
    const prevRfbDb = initMod.__peekDbForTesting();
    let server: http.Server | null = null;
    try {
      const rfbDb = new Database(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      // No outbound requests: the login page's address harvest gets a stub.
      const claimSvc = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
      claimSvc.__resetClaimHarvestCacheForTesting();
      claimSvc.__setClaimHarvestFetchForTesting((async () => new Response("", { status: 404 })) as any);
      const insertProvider = expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, brreg_active, hjemmeside, epost, content_source, products,
           producer_type, enrichment_state, verification_status, source, confidence, is_test_provider)
        VALUES
          (@id, @navn, @slug, 'experiences', @org_nr, 1, 1, @hjemmeside, @epost, @content_source, '["eplemost"]',
           'bryggeri', 'raw', 'pending_verify', 'test-fixture', 'medium', @is_test)
      `);
      const mk = (id: string, navn: string, slug: string, org: string, contentSource: string | null, isTest: number) =>
        insertProvider.run({ id, navn, slug, org_nr: org, hjemmeside: `https://${slug}.no`, epost: `post@${slug}.no`, content_source: contentSource, is_test: isTest });
      mk("t0c-g-a", "Valggård", "t0c-valggard", "917100001", "claim", 1);
      mk("t0c-g-b", "Vanliggård", "t0c-vanliggard", "917100002", "claim", 0);
      // content_source 'manual' → the stored epost is a claim candidate, so the
      // login page shows its «send me a link» form (and its script).
      mk("t0c-g-c", "Ueidgård", "t0c-ueidgard", "917100003", "manual", 0);
      const claimRow = expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at)
         VALUES (?, ?, 'post@x.no', 'verified_domain_address', ?, 1, datetime('now'), datetime('now','+7 days'))`,
      );
      claimRow.run("gsc_t0c-g-a", "t0c-g-a", "tok-t0c-a");
      claimRow.run("gsc_t0c-g-b", "t0c-g-b", "tok-t0c-b");
      process.env.OA_OWNER_FEATURES_ENABLED = "1";
      process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = "gardssalg:t0c-g-a";

      const expressMod = require("express") as typeof import("express");
      const app = expressMod();
      app.use("/api/opplevelser", expressMod.json(), (require("./opplevelser") as typeof import("./opplevelser")).default as any);
      app.use("/", (require("./gardssalg-claim") as typeof import("./gardssalg-claim")).default);
      const s = await serve(app);
      server = s.server;
      const cookie = (t: string) => `oa_owner_session=${t}`;

      checkPage("g-login /kategori/gardssalg/eier/:slug", await s.get("/kategori/gardssalg/eier/t0c-ueidgard"));
      const portalA = checkPage("g-portal (Mine valg) …/portal", await s.get("/kategori/gardssalg/eier/t0c-valggard/portal", cookie("tok-t0c-a")));
      const portalB = checkPage("g-portal (uten Mine valg) …/portal", await s.get("/kategori/gardssalg/eier/t0c-vanliggard/portal", cookie("tok-t0c-b")));
      checkPage("g-valg …/valg", await s.get("/kategori/gardssalg/eier/t0c-valggard/valg", cookie("tok-t0c-a")));
      assertTrue(portalA.some((c) => c.includes("gardssalg-claim/t0c-g-a/update-profile")) && portalB.some((c) => c.includes("booking_live")),
        "g-portal: both portal variants carry their save script");
      try { rfbDb.close(); } catch { /* best-effort */ }
    } catch (err: any) {
      failed++;
      failures.push(`✗ gardssalg: unexpected error: ${String(err?.stack || err)}`);
    } finally {
      await close(server);
      try { (require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim")).__setClaimHarvestFetchForTesting(undefined); } catch { /* ignore */ }
      try { initMod.__setDbForTesting(prevRfbDb as any); } catch { /* ignore */ }
      restoreModuleCache();
      for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    }
  }
}

if (require.main === module) {
  runOwnerPagesInlineScriptSyntaxT0cTests({ log: true }).then((r) => {
    console.info(`owner-pages-inline-script-syntax-t0c: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
