/**
 * owner-audit-log.test.ts — dev-request 2026-11-02-rfb-endringslogg-lettlest
 * (E1–E3): the owner portal's «Endringslogg» (GET /api/agents/:id/my-audit +
 * the portal script) reads like plain Norwegian, for all owners.
 *
 *   (t) the table: the form fields carry the portal form's own labels (read
 *       off the rendered form), the «Mine valg» names are the registry's, the
 *       category names are seo.ts formatCat's; technical and unknown fields
 *       are not in it (fail closed).
 *   (v) values: Norwegian date and time (Europe/Oslo, summer and winter, ISO
 *       and SQLite text), «Ja» / «Nei», «(tom)», lists, «N varer», opening
 *       hours, long text cut with «…», e-mail addresses removed.
 *   (w) who: «Du» / «Rett fra Bonden» / «Automatisk fra nettsiden din» for
 *       the notes the real writers store.
 *   (a) AC1–AC3, the API on the real router and the real writers, in-memory
 *       production schema: the portal save (update-profile), the product
 *       audit writer, the owner-relay phone writer, rows exactly as the
 *       order-activation / pause / order-e-mail / customer-service / sweep
 *       writers store them, technical rows, a no-op row; the LIMIT counts
 *       only shown rows; no notes, no e-mail address, no hidden field in the
 *       JSON; auth unchanged.
 *   (n) the nightly owner refresh (rfb-owner-refresh.ts applyOwnerRefreshWrites)
 *       → three rows «Automatisk fra nettsiden din», without the note text.
 *   (c) the claim-test fixture (POST /admin/test-claim-fixture, create + arm,
 *       a claim, arm again): is_verified / claimed_at / is_active / the
 *       e-mail row shown; agents.row, origin, catalog_hidden, claimed_via,
 *       agent_knowledge.data_source, agent_claims, magic_links hidden.
 *   (p) the portal script, run in a fake DOM on the real API answer.
 *   (e) AC4: empty feed (no rows, only hidden rows) → «Ingen endringer ennå.».
 *
 * Restores the getDb() singleton, env vars, console.log, fetch, the fixture
 * route's DB override and the registry caches in finally.
 * Exported runOwnerAuditLogTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/owner-audit-log.test.ts
 */

import Database from "better-sqlite3";
import * as vm from "vm";
import { inlineJsScripts } from "./owner-pages-inline-script-syntax-t0c.test";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HandlerResult {
  status: number;
  body: any;
}

const A = "al-owner";
const B = "al-night";
const D = "al-hidden";
const E = "al-empty";
const OWNER_EMAIL = `post@${A}.example.no`;
const FARM_EMAIL = "gard@al-fixture.example.no";
const NIGHT_ABOUT =
  "Vi driver en liten gård i Valdres med sau og bier, og selger lammekjøtt, honning og ull direkte fra gården hele året.";
const NIGHT_ABOUT_SHOWN = "Vi driver en liten gård i Valdres med sau og bier, og selger lammekjøtt, honnin…";
const TYNNE_ABOUT =
  "Familiegården ligger ved Strandavatnet og har produsert lammekjøtt, egg og grønnsaker i fire generasjoner.";
const ENV_KEYS = ["OWNER_VERIFIED_OWNER_GATE_ENABLED", "OWNER_AUTO_UPDATES_ENABLED", "OWNER_LOCK_ENFORCE_WRITES",
  "OWNER_FEATURES_ALLOWED_SUBJECTS", "OWNER_UNIFIED_SESSION_ENABLED", "OWNER_PAUSE_ENABLED", "ADMIN_KEY",
  "ADMIN_NOTIFICATION_EMAIL", "CLAIM_DOMAIN_RULE_ENABLED"] as const;

export async function runOwnerAuditLogTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  function assertTrue(cond: boolean, label: string, detail?: string): void {
    if (cond) { passed++; if (log) console.info(`  ok ${label}`); return; }
    failed++;
    const msg = `✗ ${label}${detail ? `\n    ${detail}` : ""}`;
    failures.push(msg);
    if (log) console.info("  " + msg);
  }

  function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { method?: string; params?: Record<string, string>; body?: any; query?: Record<string, string>; token?: string; headers?: Record<string, string> }): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com" };
    for (const [k, v] of Object.entries(o.headers || {})) headers[k.toLowerCase()] = v;
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    return {
      method: o.method || "GET", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: o.body ?? {}, query: o.query || {}, headers, cookies: {},
      ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return headers[name.toLowerCase()]; },
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
        redirect(c: number, loc?: string) { if (typeof c === "number") status = c; settle({ __redirect: loc ?? c }); return res; },
        end() { settle(undefined); return res; },
        header() { return res; }, set() { return res; }, type() { return res; }, cookie() { return res; },
        setHeader() { return res; }, clearCookie() { return res; },
      };
      try {
        const p = handler(req, res, (err?: any) => settle({ __next: true, err: err ? String(err) : undefined }));
        if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
      } catch (err) {
        settle({ __error: String(err) });
      }
    });
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevLog = console.log;
  const prevWarn = console.warn;
  const prevFetch = globalThis.fetch;
  if (!log) { console.log = () => { /* route chatter */ }; console.warn = () => { /* idem */ }; }

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  let cfMod: typeof import("./admin-test-claim-fixture") | null = null;
  let registry: any = null;
  const clearRegistryCaches = () => {
    if (!registry) return;
    registry._agentsCache = null;
    registry._statsCache = null;
    registry._agentsCacheTime = 0;
    registry._statsCacheTime = 0;
  };

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* already loaded */ }
    for (const k of ENV_KEYS) delete process.env[k];
    // No block may reach the network.
    (globalThis as any).fetch = async (url: any) => { throw new Error(`unexpected real fetch: ${String(url)}`); };
    for (const m of ["./owner-portal", "./admin-test-claim-fixture"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const lg = require("./owner-audit-log") as typeof import("./owner-audit-log");
    const portalMod = require("./owner-portal") as typeof import("./owner-portal");
    const myAudit = findRouteHandler(portalMod.default, "/api/agents/:agentId/my-audit", "get");
    const updateProfile = findRouteHandler(portalMod.default, "/api/agents/:id/update-profile", "post");
    const portalPage = findRouteHandler(portalMod.default, "/eier/:agentId/portal", "get");
    const feed = (agentId: string, token: string, limit = "20") =>
      invoke(myAudit, makeReq({ params: { agentId }, token, query: { limit } }));

    // ── seed ─────────────────────────────────────────────────────────────
    const insAgent = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
                           categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at)
       VALUES (?, ?, 'Testprodusent.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', ?, '[]', 0.7, 1, ?, 'discovery', 'rfb', 0, ?)`,
    );
    const insKnowledge = db.prepare(
      `INSERT INTO agent_knowledge (agent_id, email, phone, address, postal_code, website, about, verification_status, verified_second_line)
       VALUES (?, ?, '+47 400 00 000', 'Gardsveien 1', '0150', ?, ?, 'verified', 0)`,
    );
    const session = (id: string, email: string) => {
      const token = `tok-al-${id}-${Math.random().toString(36).slice(2)}`;
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${token}`, email, token, id, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
      return token;
    };
    for (const [id, cats, about] of [[A, '["vegetables"]', "Liten familiegård."], [B, "[]", ""], [D, "[]", "Tekst."], [E, "[]", "Tekst."]] as const) {
      insAgent.run(id, `Gård ${id}`, `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`, cats, id === B ? 0 : 1, "2026-10-01T00:00:00.000Z");
      insKnowledge.run(id, `post@${id}.example.no`, `https://${id}.example.no`, about);
    }
    const tokA = session(A, OWNER_EMAIL);
    const tokB = session(B, `post@${B}.example.no`);
    const tokD = session(D, `post@${D}.example.no`);
    const tokE = session(E, `post@${E}.example.no`);

    let seq = 0;
    const insAudit = db.prepare(
      `INSERT INTO agent_knowledge_audit (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const audit = (agentId: string, field: string, oldV: string | null, newV: string | null, by: "owner" | "admin" | "system", at: string, notes: string | null, email: string | null = null) =>
      insAudit.run(`al_${++seq}`, agentId, field, oldV, newV, by, email, at, notes);

    // ── (t) the table ────────────────────────────────────────────────────
    {
      const page = await invoke(portalPage, makeReq({ params: { agentId: A }, token: tokA }));
      const html = String(page.body || "");
      const formLabels: Record<string, string> = {};
      for (const m of html.matchAll(/<label for="field_([a-z_]+)">([^<]+)<\/label>/g)) formLabels[m[1] === "description" ? "about" : m[1]] = m[2];
      assertEq(Object.keys(formLabels).sort(), ["about", "address", "email", "opening_hours", "phone", "postal_code", "website"], "t1: the portal form renders its seven fields");
      for (const [dbField, label] of Object.entries(formLabels)) {
        assertEq(lg.OWNER_AUDIT_FIELDS[dbField]?.label, label, `t1: «${label}» — the log names ${dbField} with the form's own label`);
      }
      assertEq([lg.OWNER_AUDIT_FIELDS["agent_knowledge.email"].label, lg.OWNER_AUDIT_FIELDS.contact_email.label, lg.OWNER_AUDIT_FIELDS.url.label],
        [formLabels.email, formLabels.email, formLabels.website], "t1: the same facts under other writers' names carry the form label too");
      const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");
      for (const [field, key] of [["visibility.profile", "visibility.profile"], ["order_notifications_opt_in", "orders.enabled"], ["order_notification_email", "orders.email"]] as const) {
        assertEq(lg.OWNER_AUDIT_FIELDS[field].label, reg.getOwnerFeature(key).label.no, `t2: ${field} uses the «Mine valg» label of ${key}`);
      }
      const seo = require("./seo") as typeof import("./seo");
      for (const key of [...Object.keys(lg.OWNER_AUDIT_CATEGORY_NAMES), "organic", "unknown_key"]) {
        assertEq(lg.formatOwnerAuditValue("categories", JSON.stringify([key])), seo.formatCat(key), `t3: category ${key} reads as on the public profile (formatCat)`);
      }
      const technical = ["data_source", "agent_knowledge.data_source", "origin", "agent_claims", "catalog_hidden", "field_provenance",
        "field_provenance.address", "curated_fields", "owner_locks", "claimed_via", "agents.row", "magic_links", "owner_profile_pause",
        "owner_order_email_change.pending", "business_type", "retail_focus", "verification_status", "merge", "tags", "notes",
        "version", "last_enriched_at", "data_enriched_at", "products.availability", "products.availability_updated_at", "some_future_column"];
      assertEq(technical.filter((f) => f in lg.OWNER_AUDIT_FIELDS), [], "t4: no technical field is in the table");
      assertEq(lg.ownerAuditFeedRows(technical.map((f, i) => ({ id: `x${i}`, field_name: f, old_value: "a", new_value: "b", changed_by: "admin", changed_at: "2026-10-01T00:00:00Z", notes: null }))), [],
        "t4: rows for technical and unknown fields are dropped (fail closed)");
      assertEq(lg.ownerAuditFeedRows([{ id: "p", field_name: "__proto__", old_value: "a", new_value: "b", changed_by: "owner", changed_at: "2026-10-01T00:00:00Z", notes: null },
        { id: "c", field_name: "constructor", old_value: "a", new_value: "b", changed_by: "owner", changed_at: "2026-10-01T00:00:00Z", notes: null }]), [],
        "t4: inherited object keys are not fields");
      const labels = Object.values(lg.OWNER_AUDIT_FIELDS).map((f) => f.label);
      assertTrue(labels.every((l) => /^[A-ZÆØÅ][a-zæøå -]+$/.test(l)), "t5: every name is plain Norwegian words (no dots, underscores or code)", JSON.stringify(labels));
    }

    // ── (v) values ───────────────────────────────────────────────────────
    {
      const f = lg.formatOwnerAuditValue;
      assertEq([f("bool", "1"), f("bool", "0"), f("bool", "true"), f("bool", "false"), f("bool", "TRUE"), f("bool", null), f("bool", "")],
        ["Ja", "Nei", "Ja", "Nei", "Ja", "(tom)", "(tom)"], "v1: 1/0 and true/false → «Ja»/«Nei»; empty → «(tom)»");
      assertEq([f("visible", "on"), f("visible", "off (pause)"), f("visible", "off (pause til 2026-12-01)")], ["Ja", "Nei", "Nei"],
        "v2: the pause card's on/off values → «Ja»/«Nei»");
      assertEq([f("time", "2026-10-05T08:00:00.000Z"), f("time", "2026-07-02 10:15:00"), f("time", "2026-12-01T23:30:00Z"), f("time", "2026-11-02")],
        ["05.10.2026, 10:00", "02.07.2026, 12:15", "02.12.2026, 00:30", "02.11.2026"],
        "v3: timestamps as Norwegian date and time in Europe/Oslo (summer +2, winter +1; zone-less SQLite text is UTC; a date alone stays a date)");
      assertEq(lg.formatOwnerAuditTime("ikke en dato"), "ikke en dato", "v3: text that is no time stays text");
      assertEq([f("hours", JSON.stringify("Man–fre 10–17")), f("hours", "Lør 10–14"), f("hours", "[]"), f("hours", JSON.stringify([{ day: "mon", open: "10:00", close: "17:00" }]))],
        ["Man–fre 10–17", "Lør 10–14", "(tom)", "Man 10:00–17:00"], "v4: opening hours: the owner's text (JSON or raw), empty, structured");
      assertEq([f("categories", '["vegetables","honey"]'), f("categories", "[]")], ["Grønnsaker, Honning", "(tom)"], "v5: categories → the public names");
      const five = JSON.stringify(["Egg", "Lam", "Honning", "Ull", "Poteter"].map((name) => ({ name, category: "other" })));
      assertEq([f("products", five), f("products", '[{"name":"Poteter"},"Gulrøtter"]'), f("products", "[]")], ["5 varer", "Poteter, Gulrøtter", "(tom)"],
        "v6: products: up to three names, else «N varer»; empty → «(tom)»");
      assertEq([f("list", '["Lammekjøtt","Honning"]'), f("list", "ikke json")], ["Lammekjøtt, Honning", "ikke json"], "v7: a word list reads as a list; non-JSON as text");
      const long = f("text", TYNNE_ABOUT);
      assertTrue(long.length === lg.OWNER_AUDIT_TEXT_MAX && long.endsWith("…") && TYNNE_ABOUT.startsWith(long.slice(0, -1).trimEnd()), "v8: long text is cut to 80 characters with «…»", long);
      assertEq(f("text", "  Linje én\r\n\r\n  linje to  "), "Linje én linje to", "v8: whitespace and line breaks collapse");
      assertEq([f("text", "Skriv til Post.Gård@Gård-Eksempel.no eller ring"), f("text", "Kontakt: ola@gard"), f("text", "Følg oss @gardsbutikk")],
        ["Skriv til … eller ring", "Kontakt: …", "Følg oss @gardsbutikk"], "v9: e-mail addresses (also with æøå, also cut) become «…»; a handle is not an address");
      assertEq(f("products", JSON.stringify([{ name: "Bestill på ost@gard.no" }])), "Bestill på …", "v9: … also inside list items");
      const row = (field_name: string, old_value: string | null, new_value: string | null) =>
        ({ id: field_name, field_name, old_value, new_value, changed_by: "system", changed_at: "2026-10-01T00:00:00Z", notes: null });
      assertEq(lg.ownerAuditFeedRows([row("is_verified", "1", "true"), row("opening_hours", "[]", null), row("about", "Tekst  her", "Tekst her"),
        row("categories", '["honey"]', '[ "honey" ]'), row("email", " a@b.no ", "a@b.no")]), [],
        "v10: a row whose values read the same before and after (raw text differs) is not shown — nothing changed for the owner");
      assertEq(lg.ownerAuditFeedRows([row("email", "a@b.no", "c@d.no")]).map((x) => [x.label, x.values_hidden, x.old_value, x.new_value]), [["E-post", true, null, null]],
        "v10: … while a real e-mail change is shown, without values");
    }

    // ── (w) who ──────────────────────────────────────────────────────────
    {
      const w = lg.ownerAuditWho;
      assertEq([
        w("owner", null),
        w("owner", "owner confirmed in stock: Pølse (B1)"),
        w("admin", "admin/test-claim-fixture arm (existing)"),
        w("admin", "cs-batch-1: kunden ba om retting · owner_consent=crm_msg_1"),
        w("admin", "batch:manual source:rfb-website-review-approve"),
        w("admin", "auto.updates=fill_empty; kilde=website_homepage https://x.no; run"),
        w("system", "auto.updates=automatic; kilde=website_homepage https://al.example.no; run-1"),
        w("system", 'tynne_profiler_slice2: godkjent av dommer ("ok") — kilde: https://al.example.no'),
        w("system", "rfb-contact-extraction https://al.example.no/kontakt batch:b2"),
        w("system", "address-sweep kind=x kilde=website_about https://al.example.no/om-oss"),
        w("system", "batch:b-brreg source:brreg"),
        w("system", "batch-y: internal note removed"),
        w("system", null),
        w("unknown", "auto.updates=fill_empty; kilde=website_homepage"),
      ], ["Du", "Du", "Rett fra Bonden", "Rett fra Bonden", "Rett fra Bonden", "Rett fra Bonden",
        "Automatisk fra nettsiden din", "Automatisk fra nettsiden din", "Automatisk fra nettsiden din", "Automatisk fra nettsiden din",
        "Rett fra Bonden", "Rett fra Bonden", "Rett fra Bonden", "Rett fra Bonden"],
      "w1: owner → «Du»; admin / CS / support → «Rett fra Bonden»; a system write with a website source → «Automatisk fra nettsiden din»; other system → «Rett fra Bonden»");
    }

    // ── (a) the API on the real writers ──────────────────────────────────
    {
      // The portal save (owner) — real handler.
      const save = await invoke(updateProfile, makeReq({
        method: "POST", params: { id: A }, token: tokA,
        body: { phone: "+47 400 00 001", opening_hours: "Man–fre 10–17", description: `Ny tekst om gården. Skriv til ${OWNER_EMAIL} for bestilling.`, email: `ny@${A}.example.no` },
      }));
      assertEq([save.status, [...(save.body?.updated_fields || [])].sort()], [200, ["about", "email", "opening_hours", "phone"]], "a0: the owner's portal save writes four fields");
      // The product writer and the owner-relay phone writer — real functions.
      const { auditOwnerProductChange } = require("../services/owner-orderability") as typeof import("../services/owner-orderability");
      auditOwnerProductChange(db, A, "products.added", null, "Pølse", OWNER_EMAIL, "owner added a product (B1)");
      auditOwnerProductChange(db, A, "products.imported", null, "Ost, Smør", OWNER_EMAIL, "owner published 2 imported product(s) from run r1 (produktimport skive 3)");
      auditOwnerProductChange(db, A, "products.removed", "Brød", null, OWNER_EMAIL, "owner removed 1 product(s) in import run r1 (produktimport skive 3)");
      auditOwnerProductChange(db, A, "products.availability", null, "in_stock", OWNER_EMAIL, "owner confirmed in stock: Pølse (B1)");
      const { recordOwnerRelayPhoneAudit } = require("../services/phone-source-write-guard") as typeof import("../services/phone-source-write-guard");
      recordOwnerRelayPhoneAudit(db as any, A, "+47 400 00 001", "+47 400 00 002", { channel: "email", ref: "<msg-1@mail.example.com>", received_at: "2026-11-01T10:00:00Z" }, "cs");
      // Rows exactly as the other writers store them.
      const actNote = "order-activation-link:abcdef0123456789 (activated)";
      audit(A, "is_verified", "0", "1", "owner", "2026-10-05T08:00:00.000Z", actNote, OWNER_EMAIL);
      audit(A, "claimed_at", null, "2026-10-05T08:00:00.000Z", "owner", "2026-10-05T08:00:00.000Z", actNote, OWNER_EMAIL);
      audit(A, "claimed_via", null, "order_activation_link", "owner", "2026-10-05T08:00:00.000Z", actNote, OWNER_EMAIL);
      audit(A, "order_notifications_opt_in", "0", "1", "owner", "2026-10-05T08:00:00.000Z", actNote, OWNER_EMAIL);
      audit(A, "visibility.profile", "on", "off (pause til 2026-12-01)", "owner", "2026-10-06T09:00:00.000Z", "owner paused profile (S1b punkt 6)", OWNER_EMAIL);
      audit(A, "order_notification_email", OWNER_EMAIL, `ordre@${A}.example.no`, "owner", "2026-10-07T09:00:00.000Z",
        "owner confirmed new order e-mail from the new address (S1b punkt 7); previous recipient was contact_email", OWNER_EMAIL);
      const csNote = "cs-batch-1: kunden ba om retting · owner_consent=crm_msg_1";
      audit(A, "products", JSON.stringify(["Egg", "Lam", "Honning", "Ull", "Poteter"].map((name) => ({ name }))), JSON.stringify([{ name: "Poteter" }, { name: "Gulrøtter" }]), "admin", "2026-10-08T09:00:00.000Z", csNote);
      audit(A, "specialties", "[]", '["Lammekjøtt","Honning"]', "admin", "2026-10-08T09:00:01.000Z", csNote);
      audit(A, "certifications", '["Debio"]', "[]", "admin", "2026-10-08T09:00:02.000Z", csNote);
      audit(A, "address", null, "Gardsveien 1", "system", "2026-07-02 10:15:00", "batch:b-brreg source:brreg");
      audit(A, "address", "Gardsveien 1", "Gardsveien 1", "system", "2026-10-15 10:00:00", "batch:b-brreg source:brreg"); // a no-op row
      audit(A, "description", "Gård i Valdres. INTERN: ring først", "Gård i Valdres.", "system", "2026-10-09T09:00:00.000Z", "batch-y: internal note removed");
      audit(A, "about", "", TYNNE_ABOUT, "system", "2026-10-10T09:00:00.000Z", 'tynne_profiler_slice2: godkjent av dommer ("ok") — kilde: https://al-owner.example.no');
      audit(A, "contact_email", "", OWNER_EMAIL, "system", "2026-10-11T09:00:00.000Z", "rfb-contact-extraction https://al-owner.example.no/kontakt batch:b2");
      audit(A, "url", "", `https://${A}.example.no`, "system", "2026-10-28T09:00:00.000Z", "batch-u: url fix");
      audit(A, "is_active", "1", "0", "system", "2026-09-01T09:00:00.000Z", "batch-d: duplicate | evidence: x");
      // Technical rows, newer than most shown rows (they must not eat the LIMIT).
      const tech: Array<[string, string | null, string | null, "owner" | "admin" | "system"]> = [
        ["agents.row", null, "created", "admin"], ["origin", null, "claim_test_fixture", "admin"], ["catalog_hidden", null, "1", "admin"],
        ["agent_knowledge.data_source", "hybrid", "auto", "admin"], ["data_source", "owner", "auto", "system"], ["agent_claims", "1", "0", "admin"],
        ["magic_links", "2", "0", "admin"], ["owner_profile_pause", "1", "0", "admin"], ["owner_order_email_change.pending", "1", "0", "admin"],
        ["business_type", "farm", "shop", "admin"], ["retail_focus", "0", "1", "admin"], ["verification_status", "terminal_unconfirmable", "pending_verify", "system"],
        ["field_provenance", "{}", `{"email":[{"value":"${OWNER_EMAIL}"}]}`, "system"], ["field_provenance.address", "[]", '[{"a":1}]', "admin"],
        ["merge", A, "al-survivor", "system"], ["tags", "[]", '["lam"]', "admin"], ["curated_fields", "{}", '{"about":{"by":"owner"}}', "owner"],
        ["owner_locks", "[]", '["about"]', "owner"], ["notes", null, "Intern merknad", "admin"], ["version", "1", "2", "system"],
        ["last_enriched_at", null, "2026-10-20T00:00:00Z", "system"], ["products.availability_updated_at", null, "2026-10-20 00:00:00", "owner"],
        ["some_future_column", "a", "b", "system"],
      ];
      tech.forEach(([field, o, n, by], i) => audit(A, field, o, n, by, `2026-10-20T00:00:${String(i).padStart(2, "0")}.000Z`, `technical ${OWNER_EMAIL}`));

      const r = await feed(A, tokA, "200");
      const rows: any[] = r.body?.audits ?? [];
      const byField = (f: string) => rows.filter((x) => x.field_name === f);
      const one = (f: string) => byField(f)[0] ?? {};
      assertEq([r.status, r.body?.success, r.body?.count, rows.length, r.body?.agent_id], [200, true, 22, 22, A], "a1: 200, the 22 rows the owner sees (the no-op and technical rows are not among them)");
      assertEq(Object.keys(rows[0] || {}), ["id", "field_name", "label", "old_value", "new_value", "values_hidden", "who", "changed_at", "when"],
        "a1: each row carries only what the log shows (no notes, no changed_by_email, no raw changed_by)");
      const expectRow = (f: string, label: string, oldV: string | null, newV: string | null, who: string, what: string) =>
        assertEq([one(f).label, one(f).old_value, one(f).new_value, one(f).who], [label, oldV, newV, who], what);
      // AC1 — Norwegian names, readable values.
      expectRow("is_verified", "Bekreftet eier", "Nei", "Ja", "Du", "a2 (AC1): is_verified → «Bekreftet eier: Nei → Ja», by the owner (order activation)");
      expectRow("claimed_at", "Eierskap bekreftet", "(tom)", "05.10.2026, 10:00", "Du", "a2 (AC1): claimed_at → a Norwegian date and time");
      expectRow("opening_hours", "Åpningstider", "(tom)", "Man–fre 10–17", "Du", "a2 (AC1): opening_hours → «Åpningstider» (the owner's save)");
      assertEq(byField("about").map((x) => [x.label, x.old_value, x.new_value, x.who]), [
        ["Om produsenten", "Liten familiegård.", "Ny tekst om gården. Skriv til … for bestilling.", "Du"],
        ["Om produsenten", "(tom)", lg.formatOwnerAuditValue("text", TYNNE_ABOUT), "Automatisk fra nettsiden din"],
      ], "a2 (AC1): about → «Om produsenten»; the address inside the text is gone; a long text is cut with «…»");
      expectRow("phone", "Telefon", "+47 400 00 000", "+47 400 00 001", "Du", "a2: the owner's phone save");
      assertEq(byField("phone").map((x) => x.who).sort(), ["Du", "Rett fra Bonden"], "a2 (AC2): the owner-relay phone write (customer service) → «Rett fra Bonden»");
      expectRow("order_notifications_opt_in", "Ta imot bestillinger", "Nei", "Ja", "Du", "a2: order notifications → «Ta imot bestillinger: Nei → Ja»");
      expectRow("visibility.profile", "Profilen er synlig", "Ja", "Nei", "Du", "a2: the pause → «Profilen er synlig: Ja → Nei»");
      expectRow("products", "Varer", "5 varer", "Poteter, Gulrøtter", "Rett fra Bonden", "a2 (AC2): a customer-service product correction → «Varer: 5 varer → Poteter, Gulrøtter», «Rett fra Bonden»");
      expectRow("specialties", "Spesialiteter", "(tom)", "Lammekjøtt, Honning", "Rett fra Bonden", "a2: specialties as a list");
      expectRow("certifications", "Sertifiseringer", "Debio", "(tom)", "Rett fra Bonden", "a2: an emptied list → «(tom)»");
      expectRow("description", "Kort beskrivelse", "Gård i Valdres. INTERN: ring først", "Gård i Valdres.", "Rett fra Bonden", "a2 (AC2): a system sweep → «Rett fra Bonden»");
      expectRow("url", "Nettside", "(tom)", `https://${A}.example.no`, "Rett fra Bonden", "a2: url → «Nettside»");
      expectRow("is_active", "Aktiv profil", "Ja", "Nei", "Rett fra Bonden", "a2: is_active → «Aktiv profil»");
      expectRow("address", "Adresse", "(tom)", "Gardsveien 1", "Rett fra Bonden", "a2: a Brreg system write → «Rett fra Bonden»; the no-op row is left out");
      assertEq(byField("address").length, 1, "a2: … exactly one address row");
      expectRow("products.added", "Ny vare", "(tom)", "Pølse", "Du", "a2: products.added → «Ny vare»");
      expectRow("products.imported", "Varer hentet fra nettsiden", "(tom)", "Ost, Smør", "Du", "a2: products.imported");
      expectRow("products.removed", "Varer fjernet", "Brød", "(tom)", "Du", "a2: products.removed");
      // E-mail fields: shown, without values.
      for (const [f, label, who] of [["email", "E-post", "Du"], ["order_notification_email", "Bestillinger sendes til", "Du"], ["contact_email", "E-post", "Automatisk fra nettsiden din"]] as const) {
        assertEq([one(f).label, one(f).values_hidden, one(f).old_value, one(f).new_value, one(f).who], [label, true, null, null, who], `a3 (AC3): ${f} → «${label}» without values, ${who}`);
      }
      assertTrue(rows.filter((x) => x.values_hidden).length === 3 && rows.filter((x) => !x.values_hidden).every((x) => typeof x.old_value === "string" && typeof x.new_value === "string"),
        "a3: only the three e-mail rows hide values; every other row has text values");
      // AC1/AC3 — hidden rows.
      assertEq(rows.filter((x) => !(x.field_name in lg.OWNER_AUDIT_FIELDS)).length, 0, "a4 (AC1): no row outside the table");
      for (const f of ["claimed_via", "agent_knowledge.data_source", "origin", "agent_claims", "catalog_hidden", "field_provenance", "products.availability", "some_future_column"]) {
        assertEq(byField(f).length, 0, `a4 (AC1): no ${f} row`);
      }
      // AC3 — the JSON carries no address, no notes, no hidden field.
      const json = JSON.stringify(r.body);
      assertTrue(!json.includes("@"), "a5 (AC3): no e-mail address anywhere in the my-audit JSON", json.match(/.{20}@.{20}/)?.[0]);
      for (const leak of ["notes", "changed_by_email", "order-activation-link", "owner_consent", "owner_relay", "batch", "source:brreg", "kilde", "tynne_profiler", "rfb-contact-extraction", "technical", "claim_test_fixture", "order_activation_link", "hybrid", "terminal_unconfirmable", "Intern merknad"]) {
        assertTrue(!json.includes(leak), `a5 (AC3): «${leak}» is not in the JSON`);
      }
      // Time and order.
      assertEq([one("is_verified").when, one("url").when, one("address").when, one("url").changed_at], ["05.10.2026, 10:00", "28.10.2026, 10:00", "02.07.2026, 12:15", "2026-10-28T09:00:00.000Z"],
        "a6: «when» is Norwegian time in Europe/Oslo (CEST, CET, SQLite text as UTC); changed_at is ISO");
      const times = rows.map((x) => Date.parse(x.changed_at));
      assertTrue(times.every((t, i) => i === 0 || times[i - 1] >= t), "a6: newest first, whatever the stored time format");
      assertEq(rows.slice(-2).map((x) => x.field_name), ["is_active", "address"], "a6: the oldest two rows are last");
      // The LIMIT counts only shown rows.
      const r20 = await feed(A, tokA);
      assertEq([r20.body?.count, (r20.body?.audits ?? []).map((x: any) => x.field_name).slice(-1)[0], (r20.body?.audits ?? []).some((x: any) => x.field_name === "address" || x.field_name === "is_active")],
        [20, "is_verified", false], "a7: limit 20 → the 20 newest shown rows (23 newer technical rows do not count)");
      assertEq([(await feed(A, tokA, "2")).body?.count, (await feed(A, tokA, "-1")).body?.count, (await feed(A, tokA, "abc")).body?.count, (await feed(A, tokA, "999")).body?.count],
        [2, 1, 20, 22], "a7: limit 2 → 2; a negative limit → 1 (never «no limit»); junk → 20; above 200 → capped");
      // Auth unchanged.
      assertEq((await invoke(myAudit, makeReq({ params: { agentId: A } }))).status, 401, "a8: no session → 401");
      assertEq((await feed(A, tokB)).status, 403, "a8: another agent's session → 403");
    }

    // ── (n) the nightly owner refresh ────────────────────────────────────
    {
      const orf = require("../services/rfb-owner-refresh") as typeof import("../services/rfb-owner-refresh");
      db.prepare("UPDATE agents SET claimed_at = '2026-10-01T00:00:00.000Z', description = '' WHERE id = ?").run(B);
      db.prepare("UPDATE agent_knowledge SET verification_status = 'pending_verify', about = '' WHERE agent_id = ?").run(B);
      const hp = (field: string, table: "agent_knowledge" | "agents", value: string) => ({
        agent_id: B, field, table, column_value: value,
        provenance: { source_type: "website_homepage", value, fetched_at: "2026-11-02T03:00:00.000Z", source_url: `https://${B}.example.no` },
      });
      process.env.OWNER_AUTO_UPDATES_ENABLED = "1";
      const out = orf.applyOwnerRefreshWrites(db as any, B, [
        hp("about", "agent_knowledge", NIGHT_ABOUT),
        hp("description", "agents", NIGHT_ABOUT),
        hp("categories", "agents", JSON.stringify(["vegetables", "organic", "honey"])),
      ] as any, { runId: "run-al-night", now: new Date("2026-11-02T03:15:00.000Z") } as any);
      delete process.env.OWNER_AUTO_UPDATES_ENABLED;
      assertEq(out.written.map((x: any) => x.field), ["about", "description", "categories"], "n0: the real owner refresh writes about, description, categories (fill_empty)");
      const stored = db.prepare("SELECT field_name, changed_by, notes FROM agent_knowledge_audit WHERE agent_id = ? ORDER BY rowid").all(B) as any[];
      assertTrue(stored.length === 3 && stored.every((x) => x.changed_by === "system" && x.notes.startsWith("auto.updates=fill_empty; kilde=website_homepage")),
        "n0: … as system rows with the «auto.updates=…; kilde=website_homepage …» note");
      const r = await feed(B, tokB);
      assertEq((r.body?.audits ?? []).map((x: any) => [x.field_name, x.label, x.old_value, x.new_value, x.who, x.when]), [
        ["categories", "Kategorier", "(tom)", "Grønnsaker, Honning", "Automatisk fra nettsiden din", "02.11.2026, 04:15"],
        ["description", "Kort beskrivelse", "(tom)", NIGHT_ABOUT_SHOWN, "Automatisk fra nettsiden din", "02.11.2026, 04:15"],
        ["about", "Om produsenten", "(tom)", NIGHT_ABOUT_SHOWN, "Automatisk fra nettsiden din", "02.11.2026, 04:15"],
      ], "n1 (AC1/AC2): the nightly rows → «Kategorier» (public names), «Kort beskrivelse», «Om produsenten», «Automatisk fra nettsiden din»");
      const json = JSON.stringify(r.body);
      assertTrue(!/auto\.updates|kilde|website_homepage|run-al-night|example\.no/.test(json), "n2 (AC3): the note (choice, source, URL, run id) is not in the JSON", json);
    }

    // ── (c) the claim-test fixture ───────────────────────────────────────
    {
      process.env.ADMIN_KEY = "owner-audit-log-test-admin-key";
      registry = (require("../services/marketplace-registry") as typeof import("../services/marketplace-registry")).marketplaceRegistry as any;
      clearRegistryCaches();
      cfMod = require("./admin-test-claim-fixture") as typeof import("./admin-test-claim-fixture");
      cfMod.__setTestClaimFixtureDbForTesting(db as any);
      const fixtureRoute = findRouteHandler(cfMod.default, "/", "post");
      const call = (body: Record<string, unknown>) => invoke(fixtureRoute, makeReq({ method: "POST", body: { ...body, apply: true }, headers: { "x-admin-key": process.env.ADMIN_KEY! } }));
      const created = await call({ mode: "arm", farm_email: FARM_EMAIL });
      const C = String(created.body?.agent_id || "");
      assertEq([created.status, created.body?.target, !!C], [200, "create", true], "c0: the real fixture route creates the claim-test profile");
      // A verified claim on it, then «arm» again (the reset).
      db.prepare("UPDATE agents SET is_verified = 1, claimed_at = '2026-11-01T09:00:00.000Z', claimed_via = 'claim_code' WHERE id = ?").run(C);
      db.prepare("UPDATE agent_knowledge SET data_source = 'hybrid' WHERE agent_id = ?").run(C);
      db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, verified_at) VALUES ('al-claim-1', ?, 'Kari', ?, 'verified', '2026-11-01T09:00:00.000Z')`).run(C, FARM_EMAIL);
      session(C, FARM_EMAIL); // a magic link the reset removes
      const rearmed = await call({ mode: "arm", farm_email: FARM_EMAIL, agent_id: C });
      assertEq([rearmed.status, rearmed.body?.target], [200, "existing"], "c0: arm again resets the claimed fixture");
      const storedFields = (db.prepare("SELECT field_name FROM agent_knowledge_audit WHERE agent_id = ? ORDER BY rowid").all(C) as any[]).map((x) => x.field_name);
      assertEq(storedFields, ["agents.row", "origin", "catalog_hidden", "is_active", "is_verified", "agent_knowledge.email",
        "is_verified", "claimed_at", "claimed_via", "agent_knowledge.data_source", "agent_claims", "magic_links"],
        "c1: the fixture's admin writes store these rows (all still in the database)");
      const tokC = session(C, FARM_EMAIL);
      const r = await feed(C, tokC);
      assertEq((r.body?.audits ?? []).map((x: any) => [x.field_name, x.label, x.old_value, x.new_value, x.values_hidden, x.who]), [
        ["claimed_at", "Eierskap bekreftet", "01.11.2026, 10:00", "(tom)", false, "Rett fra Bonden"],
        ["is_verified", "Bekreftet eier", "Ja", "Nei", false, "Rett fra Bonden"],
        ["agent_knowledge.email", "E-post", null, null, true, "Rett fra Bonden"],
        ["is_verified", "Bekreftet eier", "(tom)", "Nei", false, "Rett fra Bonden"],
        ["is_active", "Aktiv profil", "(tom)", "Ja", false, "Rett fra Bonden"],
      ], "c2 (AC1/AC2/AC5): the fixture's log shows only readable rows, «Rett fra Bonden»; agents.row, origin, catalog_hidden, claimed_via, agent_knowledge.data_source, agent_claims, magic_links are hidden");
      const json = JSON.stringify(r.body);
      assertTrue(!json.includes("@") && !/test-claim-fixture|claim_test_fixture|claim_code|hybrid|data_source|agent_claims|magic_links|origin|catalog_hidden|agents\.row/.test(json),
        "c3 (AC3): no farm e-mail, note or hidden field in the fixture's JSON", json);
    }

    // ── (p) the portal script on the real API answer ─────────────────────
    async function runScript(agentId: string, token: string): Promise<string> {
      const page = await invoke(portalPage, makeReq({ params: { agentId }, token }));
      const code = inlineJsScripts(String(page.body || "")).find((c) => c.includes("my-audit")) || "";
      const answer = (await feed(agentId, token)).body;
      const ul: any = { innerHTML: "" };
      const form: any = { addEventListener() { /* save not exercised here */ }, querySelector() { return {}; }, submit() { /* idem */ } };
      const document = { getElementById(x: string) { return x === "ep-audit" ? ul : x === "ep-profile-form" ? form : null; } };
      const fetch = (url: string) => Promise.resolve({ ok: true, json: () => Promise.resolve(url.includes("my-audit") ? answer : { success: true }) });
      class FormData { get() { return null; } }
      const window: any = { fetch, location: { pathname: `/eier/${agentId}/portal`, href: "" } };
      vm.runInContext(code, vm.createContext({ window, document, fetch, FormData, JSON, String, Date, Promise, console: { log() {}, error() {} } }));
      for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r));
      return String(ul.innerHTML);
    }
    {
      const html = await runScript(A, tokA);
      assertEq((html.match(/<li class="ep-audit-item">/g) || []).length, 20, "p1: the portal script renders the 20 newest shown rows");
      for (const part of ["<strong>Telefon</strong>: +47 400 00 000 → +47 400 00 001", "<strong>E-post</strong> endret<div", "<strong>Åpningstider</strong>: (tom) → Man–fre 10–17",
        "· Du</div>", "· Rett fra Bonden</div>", "· Automatisk fra nettsiden din</div>", "<strong>Bestillinger sendes til</strong> endret"]) {
        assertTrue(html.includes(part), `p1 (AC1/AC2): the log shows «${part}»`, html);
      }
      assertTrue(!html.includes("@") && !html.includes("endret av") && !html.includes("Support") && !html.includes("(tomt)") && !html.includes("null") && !html.includes("undefined") && !/<strong>[a-z_.]+<\/strong>/.test(html),
        "p2: no address, no old wording, no raw field name, no null/undefined", html);
    }

    // ── (e) AC4: the empty state ─────────────────────────────────────────
    {
      audit(D, "origin", null, "discovery", "admin", "2026-10-01T00:00:00.000Z", "x");
      audit(D, "agent_knowledge.data_source", "auto", "hybrid", "admin", "2026-10-01T00:00:01.000Z", "x");
      audit(D, "phone", "+47 1", "+47 1", "system", "2026-10-01T00:00:02.000Z", "no-op");
      for (const [id, tok, what] of [[D, tokD, "only hidden and no-op rows"], [E, tokE, "no rows at all"]] as const) {
        const r = await feed(id, tok);
        assertEq([r.status, r.body?.success, r.body?.count, r.body?.audits], [200, true, 0, []], `e1 (AC4): ${what} → an empty list`);
        const html = await runScript(id, tok);
        assertEq(html, '<li class="ep-audit-item ep-audit-meta">Ingen endringer ennå.</li>', `e2 (AC4): ${what} → «Ingen endringer ennå.»`);
      }
    }
  } catch (err: any) {
    failed++;
    failures.push(`owner-audit-log: unexpected error: ${String(err?.stack || err)}`);
  } finally {
    try { cfMod?.__setTestClaimFixtureDbForTesting(null); } catch { /* ignore */ }
    clearRegistryCaches();
    (globalThis as any).fetch = prevFetch;
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    console.log = prevLog;
    console.warn = prevWarn;
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* best-effort */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerAuditLogTests({ log: true }).then((r) => {
    console.info(`owner-audit-log: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
