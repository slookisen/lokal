/**
 * rfb-api-email-reveal.test.ts — dev-request
 * 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, S-A5 for
 * rettfrabonden.com, REST + A2A (not MCP): the producer e-mail in the API
 * answers follows the per-IP limit of services/email-reveal-guard.ts, the
 * rfb counter the profile page /produsent/:slug already uses (switch
 * EMAIL_REVEAL_GUARD_RFB, default off).
 *
 * Surfaces:
 *   card     GET  /api/marketplace/agents/:id/card      contact.email
 *   info     GET  /api/marketplace/agents/:id/info      data.knowledge.email
 *   vcard    GET  /api/marketplace/agents/:id/vcard     EMAIL line
 *   discover POST /api/marketplace/discover             results[].contact.email
 *   search   GET  /api/marketplace/search               results[].contact.email
 *   cart     POST /api/marketplace/cart/:id/submit      contact_handoffs[].email
 *   agentjs  GET  /agents/:id/agent.json                x-knowledge.email
 *   a2ainfo  POST /a2a agent/info                       artifacts[0].parts[0].data.knowledge.email
 *
 * Fixture (own in-memory main DB, made-up names and addresses; the seeding of
 * rfb-profile-email-reveal.test.ts): producers with an e-mail, one without,
 * one with an e-mail and no other contact, and 32 more with an e-mail.
 *
 *   O  switch off (unset, and "off"): every surface gives the e-mail however
 *      many profiles one IP reads (limit 1), headers as before (no
 *      Cache-Control on REST, agent.json keeps public, max-age=1800); CCBot
 *      too
 *   U  switch on, under the limit: every body byte-identical to switch off,
 *      plus Cache-Control: private
 *   L  switch on, over the limit: the e-mail is left out exactly as for a
 *      producer without one (same keys; card/agent.json/vcard: no key or
 *      line; info/agent-info/contact block/handoff: null; an e-mail-only
 *      contact block collapses to { vcardUrl }), the address nowhere in the
 *      body; a repeat view is free; another IP has its own budget
 *   N  a producer without an e-mail costs nothing
 *   C  CCBot: never an e-mail, on the first request, and no budget spent
 *   S  one rfb counter shared by every surface (REST, A2A, the profile page)
 *   M  lists: each producer with an e-mail counts on its own, in list order;
 *      200 producers read through each surface give ≤ N e-mails (N = limit)
 *   K  the owner's own /info read (X-Claim-Token) is not limited
 *      — but a bogus token, or a valid token for another agent, is treated
 *      like no token (review M5)
 *   V  vcard of a producer without an e-mail: no EMAIL line, Cache-Control:
 *      private with the switch on, no budget spent (review M10)
 *   W  lists / cart: a producer without an e-mail listed among those with one
 *      spends no budget (review M11)
 *   G  the guard's log lines carry no e-mail address and no IP
 *   T  S-A4 trap path /kontakt-arkiv on rettfrabonden.com: disallowed in every
 *     robots.txt group (switch on or off, same robots.txt); the hidden link
 *     is on the profile page only with the switch on, never in JSON-LD or the
 *     sitemap; switch off → the path falls through and nothing is recorded;
 *     switch on → a GET or HEAD blocks that IP for 24 h (injected clock): no
 *     e-mail on the profile page («Vis e-post»), the reveal endpoint (429),
 *     card and info; another IP is unaffected; log lines carry no IP/e-mail
 *
 * Byte-identity of switch-off against main itself was checked when the slice
 * was built (same requests answered from a clean main checkout and from this
 * branch; see the PR).
 *
 * Standalone: npx tsx src/routes/rfb-api-email-reveal.test.ts
 * Wired into tests/test.ts via runRfbApiEmailRevealTests().
 */

import Database from "better-sqlite3";
import { RFB_EMAIL_FIXTURE, seedRfbEmailFixture } from "./rfb-profile-email-reveal.test";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export interface HttpResult {
  status: number;
  text: string;
  headers: Record<string, string | string[] | undefined>;
}

const BROWSER = "Mozilla/5.0 (test)";
const CCBOT = "CCBot/2.0 (https://commoncrawl.org/faq/)";

/** A producer with an e-mail and no other contact field (address, phone, website). */
export const EMAIL_ONLY = { id: "rae-eo", name: "Bareepost Prøvegård", email: "bare@bareepost.example" };

/** The made-up producers the API tests read, seeded into `db` (also used by the one-off main-vs-branch comparison). */
export function seedRfbApiEmailFixture(db: Database.Database): Array<{ id: string; name: string; email: string }> {
  const all = seedRfbEmailFixture(db, 32);
  db.prepare(
    `INSERT INTO agents (
      id, name, description, provider, contact_email, url, role, api_key,
      categories, tags, skills, capabilities, languages, city, lat, lng,
      trust_score, is_active, is_verified, brreg_verified, discovery_count, interaction_count,
      total_interactions, created_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'producer', ?,
      '["vegetables"]', '[]', '[]', '{}', '["no"]', 'Voss', 60.63, 6.42,
      0.5, 1, 0, 0, 0, 0, 0, '2026-10-01 00:00:00', '2026-10-01 00:00:00')`,
  ).run(EMAIL_ONLY.id, EMAIL_ONLY.name, "Liten gård som selger grønnsaker rett fra tunet hele året.", EMAIL_ONLY.name, `kontakt-${EMAIL_ONLY.id}@agents.example`, "", `key-${EMAIL_ONLY.id}`);
  db.prepare(
    `INSERT INTO agent_knowledge (agent_id, email, about, products, updated_at, created_at)
     VALUES (?, ?, 'Vi dyrker poteter.', '[]', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
  ).run(EMAIL_ONLY.id, EMAIL_ONLY.email);
  return [...all, EMAIL_ONLY];
}

/** The legacy store producer agentCardService.generateCard needs for GET /agents/:id/agent.json. */
function storeProducer(id: string, name: string): any {
  const now = "2026-10-01T00:00:00.000Z";
  return {
    id, name, description: "", type: "farm",
    location: { lat: 60.63, lng: 6.42, city: "Voss" },
    openingHours: [], tags: [], certifications: [], deliveryOptions: ["pickup"],
    trustScore: 0.5, totalTransactions: 0, availabilityAccuracy: 0.5,
    registeredAt: now, lastActiveAt: now, isActive: true,
  };
}

export interface RfbApiHarness {
  get(path: string, ip: string, ua?: string, headers?: Record<string, string>): Promise<HttpResult>;
  post(path: string, body: unknown, ip: string, ua?: string, headers?: Record<string, string>): Promise<HttpResult>;
  head(path: string, ip: string, ua?: string): Promise<HttpResult>;
  close(): Promise<void>;
}

/**
 * An HTTP app with the RFB REST and A2A routers mounted as in index.ts (trust
 * proxy, so X-Forwarded-For picks the test IP; no rate limiters). `root` is
 * the src directory to load the routers from (the one-off comparison points
 * it at a main checkout).
 */
export async function startRfbApiApp(root = __dirname + "/.."): Promise<RfbApiHarness> {
  const express = require("express") as typeof import("express");
  const http = require("http") as typeof import("http");
  for (const m of ["routes/marketplace", "routes/marketplace-cart", "routes/a2a", "routes/seo"]) {
    try { delete require.cache[require.resolve(`${root}/${m}`)]; } catch { /* not loaded */ }
  }
  const marketplaceRoutes = require(`${root}/routes/marketplace`).default;
  const { cartRouter } = require(`${root}/routes/marketplace-cart`);
  const a2aRoutes = require(`${root}/routes/a2a`).default;
  const seoRoutes = require(`${root}/routes/seo`).default;
  const { langMiddleware } = require(`${root}/i18n/middleware`);
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use(langMiddleware);
  app.use("/api/marketplace", marketplaceRoutes);
  app.use("/api/marketplace", cartRouter);
  app.use("/", a2aRoutes);
  app.use("/", seoRoutes);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("net").AddressInfo).port;
  const call = (method: string, path: string, body: unknown, ip: string, ua = BROWSER, extra: Record<string, string> = {}): Promise<HttpResult> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string> = { "x-forwarded-for": ip, "user-agent": ua, accept: "application/json", ...extra };
      if (payload !== undefined) { headers["content-type"] = "application/json"; headers["content-length"] = String(Buffer.byteLength(payload)); }
      const r = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
      });
      r.on("error", reject);
      if (payload !== undefined) r.write(payload);
      r.end();
    });
  return {
    get: (path, ip, ua, headers) => call("GET", path, undefined, ip, ua, headers),
    post: (path, body, ip, ua, headers) => call("POST", path, body, ip, ua, headers),
    head: (path, ip, ua) => call("HEAD", path, undefined, ip, ua),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

export async function runRfbApiEmailRevealTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const ok = (cond: boolean, label: string) => {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  };
  const eq = (actual: unknown, expected: unknown, label: string) =>
    ok(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);

  const envKeys = ["EMAIL_REVEAL_GUARD_RFB", "EMAIL_REVEAL_PER_IP_PER_HOUR", "OWNER_PAUSE_ENABLED", "OWNER_FEATURES_ENFORCE", "OWNER_FEATURES_ALLOWED_SUBJECTS", "PAYMENTS_ENABLED"];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  for (const k of envKeys) delete process.env[k];

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevMainDb = initMod.__peekDbForTesting();
  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");
  testDb.function("random", () => 0);

  const guard = require("../services/email-reveal-guard") as typeof import("../services/email-reveal-guard");
  const logLines: string[] = [];
  const freshGuard = (limit?: number) => {
    guard.__resetEmailRevealGuardForTesting({ log: (l) => logLines.push(l) });
    if (limit === undefined) delete process.env.EMAIL_REVEAL_PER_IP_PER_HOUR;
    else process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = String(limit);
  };
  const switchOn = () => { process.env.EMAIL_REVEAL_GUARD_RFB = "on"; };
  const switchOff = (v?: string) => { if (v === undefined) delete process.env.EMAIL_REVEAL_GUARD_RFB; else process.env.EMAIL_REVEAL_GUARD_RFB = v; };
  const clearRegistry = () => {
    const reg = (require("../services/marketplace-registry") as any).marketplaceRegistry;
    reg._agentsCache = null;
    reg._statsCache = null;
    reg._slugIdMap = null;
  };

  const { store } = require("../services/store") as typeof import("../services/store");
  let fixture: Array<{ id: string; name: string; email: string }> = [];
  let app: RfbApiHarness | null = null;
  const prevConsoleLog = console.log;
  if (!log) console.log = () => { /* silence registry chatter */ };

  try {
    initMod.__setDbForTesting(testDb as any);
    initMod.__initSchemaForTesting(testDb as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    fixture = seedRfbApiEmailFixture(testDb);
    for (const p of fixture) store.addProducer(storeProducer(p.id, p.name));
    store.addProducer(storeProducer(RFB_EMAIL_FIXTURE.noEmail.id, RFB_EMAIL_FIXTURE.noEmail.name));
    clearRegistry();
    app = await startRfbApiApp();
    const a = app;

    const P = fixture.slice(0, 3);                    // the three named producers with an e-mail
    const MASS = fixture.slice(3, 35);                // 32 more with an e-mail
    const NOEMAIL = RFB_EMAIL_FIXTURE.noEmail;
    const allEmails = [...fixture.map((p) => p.email), RFB_EMAIL_FIXTURE.umbrella.email, RFB_EMAIL_FIXTURE.logistics.email];
    const leaks = (text: string, email: string) => [email, JSON.stringify(email).slice(1, -1), encodeURIComponent(email), email.replace(/&/g, "\\u0026")]
      .some((form) => text.includes(form));
    const anyLeak = (text: string) => allEmails.some((e) => leaks(text, e));
    const body = (r: HttpResult) => { try { return JSON.parse(r.text); } catch { return null; } };
    /** A body without its per-request timestamps (the vCard's REV line, the A2A task status). */
    const stable = (text: string) => text.replace(/^REV:.*$/m, "REV:…").replace(/"timestamp":"[^"]*"/g, '"timestamp":"…"');

    // ── per-surface readers: (id, ip, ua?) → { r, email } ───────────────
    type One = (id: string, ip: string, ua?: string, headers?: Record<string, string>) => Promise<{ r: HttpResult; email: unknown; shape: unknown }>;
    const keysOf = (o: any) => (o && typeof o === "object" ? Object.keys(o) : null);
    const card: One = async (id, ip, ua) => { const r = await a.get(`/api/marketplace/agents/${id}/card`, ip, ua); const b = body(r); return { r, email: b?.contact?.email, shape: keysOf(b?.contact) }; };
    const info: One = async (id, ip, ua, h) => { const r = await a.get(`/api/marketplace/agents/${id}/info`, ip, ua, h); const b = body(r); return { r, email: b?.data?.knowledge?.email, shape: keysOf(b?.data?.knowledge) }; };
    const vcard: One = async (id, ip, ua) => { const r = await a.get(`/api/marketplace/agents/${id}/vcard`, ip, ua); const m = /^EMAIL;TYPE=WORK:(.*)$/m.exec(r.text); return { r, email: m ? m[1]!.replace(/\\/g, "") : undefined, shape: r.text.split(/\r?\n/).filter((l) => !l.startsWith("EMAIL")).map((l) => l.split(":")[0]) }; };
    const agentJson: One = async (id, ip, ua) => { const r = await a.get(`/agents/${id}/agent.json`, ip, ua); const b = body(r); return { r, email: b?.["x-knowledge"]?.email, shape: keysOf(b?.["x-knowledge"]) }; };
    const a2aInfo: One = async (id, ip, ua) => {
      const r = await a.post("/a2a", { jsonrpc: "2.0", method: "agent/info", params: { agentId: id }, id: `info-${id}` }, ip, ua);
      const k = body(r)?.result?.artifacts?.[0]?.parts?.[0]?.data?.knowledge;
      return { r, email: k?.email, shape: keysOf(k) };
    };
    const SINGLE: Array<[string, One, "absent" | "null"]> = [
      ["card", card, "absent"], ["info", info, "null"], ["vcard", vcard, "absent"], ["agent.json", agentJson, "absent"], ["a2a agent/info", a2aInfo, "null"],
    ];
    const withheldValue = (kind: "absent" | "null") => (kind === "null" ? null : undefined);

    // ── list readers ────────────────────────────────────────────────────
    const listContacts = (r: HttpResult) => ((body(r)?.results ?? []) as any[]).map((x) => ({ id: x?.agent?.id as string, contact: x?.contact }));
    const discover = (ip: string, ua?: string) => a.post("/api/marketplace/discover", { categories: ["vegetables"] }, ip, ua);
    const search = (ip: string, ua?: string) => a.get("/api/marketplace/search?q=" + encodeURIComponent("grønnsaker") + "&lat=60.63&lng=6.42", ip, ua);
    const cartSubmit = async (ids: string[], ip: string, ua?: string) => {
      const cart = require("../services/cart-service") as typeof import("../services/cart-service");
      const { cart_id, buyer_ref } = cart.createCart();
      for (const id of ids) {
        const w = cart.addCartWish(cart_id, "poteter", 1);
        if (!w.success) throw new Error("addCartWish failed: " + w.error);
        const c = cart.chooseCartWishOffer(cart_id, w.wish.id, { agentId: id });
        if (!c.success) throw new Error("chooseCartWishOffer failed: " + c.error);
      }
      return a.post(`/api/marketplace/cart/${cart_id}/submit`, { buyer_ref }, ip, ua, { "x-cart-token": buyer_ref });
    };
    /** A cart answer without its per-cart ids, so two submits compare byte for byte. */
    const cartComparable = (r: HttpResult) => r.text.replace(/"(cart_id|buyer_ref|id)":"[^"]*"/g, '"$1":"…"');

    // ── O: switch off ───────────────────────────────────────────────────
    const offBodies = new Map<string, string>();
    for (const off of [undefined, "off"]) {
      switchOff(off);
      freshGuard(1);
      const ip = off === undefined ? "203.0.113.10" : "203.0.113.11";
      for (const [name, read] of SINGLE) {
        let all = true;
        let headersOk = true;
        for (const p of [...P, ...MASS.slice(0, 5), EMAIL_ONLY]) {
          const { r, email } = await read(p.id, ip);
          if (r.status !== 200 || email !== p.email) all = false;
          const cc = r.headers["cache-control"];
          if (name === "agent.json" ? cc !== "public, max-age=1800" : cc !== undefined) headersOk = false;
          if (off === undefined) offBodies.set(`${name}:${p.id}`, r.text);
          else if (stable(offBodies.get(`${name}:${p.id}`)!) !== stable(r.text)) all = false;
        }
        ok(all, `O1 (${off ?? "unset"}): switch off → ${name} gives the e-mail of 9 profiles to one IP with limit 1`);
        ok(headersOk, `O2 (${off ?? "unset"}): switch off → ${name} headers as before (${name === "agent.json" ? "public, max-age=1800" : "no Cache-Control"})`);
        const cc = await read(P[0]!.id, ip, CCBOT);
        ok(cc.email === P[0]!.email, `O3 (${off ?? "unset"}): switch off → ${name} gives CCBot the e-mail`);
      }
      for (const [name, run] of [["discover", discover], ["search", search]] as const) {
        const r = await run(ip);
        const rows = listContacts(r);
        const withEmail = rows.filter((x) => x.contact?.email);
        ok(r.status === 200 && withEmail.length >= 15, `O4 (${off ?? "unset"}): switch off → ${name} lists ≥ 15 contact e-mails (${withEmail.length}) with limit 1`);
        eq(r.headers["cache-control"], undefined, `O5 (${off ?? "unset"}): switch off → ${name} has no Cache-Control`);
        if (off === undefined) offBodies.set(name, r.text);
        else eq(r.text === offBodies.get(name), true, `O6: switch "off" → ${name} body identical to switch unset`);
      }
      const cr = await cartSubmit([P[0]!.id, P[1]!.id, EMAIL_ONLY.id], ip);
      const handoffs = (body(cr)?.contact_handoffs ?? []) as any[];
      ok(cr.status === 201 && handoffs.length === 3 && handoffs.every((h) => fixture.find((p) => p.id === h.agent_id)?.email === h.email),
        `O7 (${off ?? "unset"}): switch off → cart submit's contact_handoffs carry every e-mail (limit 1)`);
      eq(cr.headers["cache-control"], undefined, `O8 (${off ?? "unset"}): switch off → cart submit has no Cache-Control`);
      if (off === undefined) offBodies.set("cart", cartComparable(cr));
      else ok(cartComparable(cr) === offBodies.get("cart"), `O9: switch "off" → cart submit body identical to switch unset`);
    }
    eq(logLines.length, 0, "O10: switch off → the guard logs nothing");

    // ── U: switch on, under the limit — bodies byte-identical to off ────
    switchOn();
    freshGuard(1000);
    {
      const ip = "203.0.113.20";
      for (const [name, read] of SINGLE) {
        let same = true;
        let priv = true;
        for (const p of [...P, ...MASS.slice(0, 5), EMAIL_ONLY]) {
          const { r } = await read(p.id, ip);
          if (stable(r.text) !== stable(offBodies.get(`${name}:${p.id}`)!)) same = false;
          if (r.headers["cache-control"] !== "private") priv = false;
        }
        ok(same, `U1: switch on, under the limit → ${name} bodies byte-identical to switch off`);
        ok(priv, `U2: switch on → ${name} is Cache-Control: private`);
      }
      for (const [name, run] of [["discover", discover], ["search", search]] as const) {
        const r = await run(ip);
        ok(r.text === offBodies.get(name), `U3: switch on, under the limit → ${name} body byte-identical to switch off`);
        eq(r.headers["cache-control"], "private", `U4: switch on → ${name} is Cache-Control: private`);
      }
      const cr = await cartSubmit([P[0]!.id, P[1]!.id, EMAIL_ONLY.id], ip);
      ok(cartComparable(cr) === offBodies.get("cart"), "U5: switch on, under the limit → cart submit body byte-identical to switch off");
      eq(cr.headers["cache-control"], "private", "U6: switch on → cart submit is Cache-Control: private");
      // A producer without an e-mail: same answer as off, private, no budget (N).
      const r = await card(NOEMAIL.id, ip);
      ok(r.r.status === 200 && r.email === undefined && r.r.headers["cache-control"] === "private", "N1: switch on → a producer without an e-mail: card has no e-mail, Cache-Control: private");
    }

    // ── L: switch on, over the limit (per surface, fresh budget) ────────
    for (const [name, read, kind] of SINGLE) {
      freshGuard(2);
      const ip = "203.0.113.30";
      const r0 = await read(NOEMAIL.id, ip);   // N: costs nothing
      ok(r0.r.status === 200, `N2: ${name} answers a producer without an e-mail`);
      const r1 = await read(P[0]!.id, ip);
      const r2 = await read(P[1]!.id, ip);
      ok(r1.email === P[0]!.email && r2.email === P[1]!.email, `L1: ${name} → the first 2 profiles get their e-mail (limit 2; a producer without one cost nothing)`);
      const r3 = await read(P[2]!.id, ip);
      ok(r3.r.status === 200, `L2: ${name} over the limit → still 200`);
      ok(r3.email === withheldValue(kind), `L3: ${name} over the limit → e-mail ${kind === "null" ? "null" : "left out"}, as for a producer without one`);
      ok(!leaks(r3.r.text, P[2]!.email), `L4: ${name} over the limit → the address is nowhere in the body`);
      const within = (await read(P[2]!.id, "203.0.113.31")).shape as string[];
      eq(r3.shape, kind === "null" || name === "vcard" ? within : within.filter((k) => k !== "email"),
        `L5: ${name} over the limit → the keys of the same answer within the limit${kind === "null" ? "" : ", less the e-mail"}`);
      eq(r3.r.headers["cache-control"], "private", `L6: ${name} over the limit → Cache-Control: private`);
      const again = await read(P[0]!.id, ip);
      ok(again.email === P[0]!.email, `L7: ${name} → a repeat view of a counted profile is free`);
      const other = await read(P[2]!.id, "203.0.113.32");
      ok(other.email === P[2]!.email, `L8: ${name} → another IP has its own budget`);
      // C: CCBot never, no budget.
      freshGuard(5);
      const c = await read(P[0]!.id, "203.0.113.33", CCBOT);
      ok(c.r.status === 200 && c.email === withheldValue(kind) && !leaks(c.r.text, P[0]!.email), `C1: ${name} → CCBot gets no e-mail on its first request`);
      eq(c.r.headers["cache-control"], "private", `C2: ${name} → CCBot answer is Cache-Control: private`);
      const after = await Promise.all(P.map((p) => read(p.id, "203.0.113.33")));
      ok(after.every((x, i) => x.email === P[i]!.email), `C3: ${name} → CCBot spent none of the IP's budget`);
    }
    // vcard over the limit = the vCard of the same producer without the EMAIL line.
    {
      freshGuard(0);
      const v = await vcard(P[0]!.id, "203.0.113.34");
      eq(stable(v.r.text), stable(offBodies.get(`vcard:${P[0]!.id}`)!).split(/(?<=\n)/).filter((l) => !l.startsWith("EMAIL;")).join(""), "L9: vcard over the limit = the same vCard without its EMAIL line");
      const c = await card(P[0]!.id, "203.0.113.34");
      const offCard = JSON.parse(offBodies.get(`card:${P[0]!.id}`)!);
      delete offCard.contact.email;
      eq(c.r.text, JSON.stringify(offCard), "L10: card over the limit = the same card without contact.email");
      const j = await agentJson(P[0]!.id, "203.0.113.34");
      const offJ = JSON.parse(offBodies.get(`agent.json:${P[0]!.id}`)!);
      delete offJ["x-knowledge"].email;
      eq(j.r.text, JSON.stringify(offJ), "L11: agent.json over the limit = the same card without x-knowledge.email");
      // The e-mail-only producer: card contact has nothing but the country left → no contact block, as without an e-mail.
      const eo = await card(EMAIL_ONLY.id, "203.0.113.34");
      const offEo = JSON.parse(offBodies.get(`card:${EMAIL_ONLY.id}`)!);
      const { email: _e, ...eoRest } = offEo.contact ?? {};
      eq(body(eo.r)?.contact, Object.keys(eoRest).length > 1 ? eoRest : undefined,
        "L12: card over the limit for an e-mail-only producer → the contact block reads as without an e-mail");
    }

    // ── M: lists count each producer with an e-mail on its own ──────────
    for (const [name, run] of [["discover", discover], ["search", search]] as const) {
      freshGuard(3);
      const ip = "203.0.113.40";
      const offRows = listContacts({ status: 200, text: offBodies.get(name)!, headers: {} });
      const r = await run(ip);
      const rows = listContacts(r);
      const shown = rows.filter((x) => x.contact?.email);
      eq(shown.length, 3, `M1: ${name} → exactly 3 contact e-mails with limit 3`);
      const expectIds = offRows.filter((x) => x.contact?.email).slice(0, 3).map((x) => x.id);
      eq(shown.map((x) => x.id), expectIds, `M2: ${name} → the first 3 producers with an e-mail in list order get it`);
      ok(rows.length === offRows.length && rows.every((x, i) => x.id === offRows[i]!.id), `M3: ${name} → the same producers in the same order as switch off`);
      let shapeOk = true;
      for (const [i, x] of rows.entries()) {
        const o = offRows[i]!.contact;
        if (!o?.email || shown.some((s) => s.id === x.id)) { if (JSON.stringify(x.contact) !== JSON.stringify(o)) shapeOk = false; continue; }
        const hasOther = !!(o.address || o.phone || o.website);
        const expected = hasOther ? { ...o, email: null } : { vcardUrl: o.vcardUrl };
        if (JSON.stringify(x.contact) !== JSON.stringify(expected)) shapeOk = false;
      }
      ok(shapeOk, `M4: ${name} → a withheld contact block is what the producer without an e-mail gets (email null; e-mail-only → { vcardUrl })`);
      const leaked = allEmails.filter((e) => leaks(r.text, e) && !shown.some((s) => s.contact.email === e));
      eq(leaked.length, 0, `M6: ${name} → no withheld address anywhere in the body`);
      const again = await run(ip);
      eq(listContacts(again).filter((x) => x.contact?.email).map((x) => x.id), expectIds, `M7: ${name} → a repeat list gives the same 3 (repeat views free, no new ones)`);
      const cc = await run("203.0.113.41", CCBOT);
      eq(listContacts(cc).filter((x) => x.contact?.email).length, 0, `M8: ${name} → CCBot gets no contact e-mail`);
    }
    // The e-mail-only producer (ranks below the 20-result cap in the lists above): found by name
    // through search (discover shares guardContactBlocks with search).
    for (const [name, run] of [
      ["search", (ip: string) => a.get("/api/marketplace/search?q=" + encodeURIComponent(EMAIL_ONLY.name), ip)],
    ] as const) {
      freshGuard(0);
      const rows = listContacts(await run("203.0.113.44"));
      const eoRow = rows.find((x) => x.id === EMAIL_ONLY.id);
      ok(!!eoRow && JSON.stringify(eoRow.contact) === JSON.stringify({ vcardUrl: `/api/marketplace/agents/${EMAIL_ONLY.id}/vcard` }),
        `M5: ${name} → the e-mail-only producer over the limit gets { vcardUrl } only, as with no contact at all (${JSON.stringify(eoRow?.contact)})`);
    }
    {
      freshGuard(1);
      const ids = [P[0]!.id, NOEMAIL.id, P[1]!.id, EMAIL_ONLY.id];
      const r = await cartSubmit(ids, "203.0.113.42");
      const h = (body(r)?.contact_handoffs ?? []) as any[];
      const byId = new Map(h.map((x) => [x.agent_id, x]));
      ok(r.status === 201 && h.length === 4, "M9: cart submit with 4 contact producers → 4 handoffs");
      const withEmail = h.filter((x) => x.email);
      eq(withEmail.length, 1, "M10: cart submit, limit 1 → one handoff keeps its e-mail");
      ok(byId.get(P[1]!.id)?.email === null && byId.get(EMAIL_ONLY.id)?.email === null && byId.get(NOEMAIL.id)?.email === null,
        "M11: cart submit → withheld handoffs have email null, as the producer without one");
      eq(Object.keys(byId.get(P[1]!.id) ?? {}), Object.keys(byId.get(NOEMAIL.id) ?? {}), "M12: cart submit → withheld handoff has the same keys as a no-e-mail handoff");
      ok(!leaks(r.text, P[1]!.email) && !leaks(r.text, EMAIL_ONLY.email), "M13: cart submit → withheld addresses nowhere in the body");
      eq(r.headers["cache-control"], "private", "M14: cart submit → Cache-Control: private");
      const stored = testDb.prepare("SELECT COUNT(*) AS n FROM cart_handoffs").get() as { n: number } | undefined;
      ok(!!stored && stored.n > 0, "M15: cart submit still stores its handoff rows (cart-service unchanged)");
      const cc = await cartSubmit([P[0]!.id], "203.0.113.43", CCBOT);
      ok((body(cc)?.contact_handoffs ?? []).every((x: any) => x.email === null), "M16: cart submit → CCBot gets no handoff e-mail");
    }

    // Acceptance 9: 200 profile reads from one IP through each surface → ≤ N e-mails.
    {
      const N = 5;
      const pool = [...fixture, NOEMAIL as any];
      for (const [name, read] of SINGLE) {
        freshGuard(N);
        const ip = "203.0.113.50";
        let got = 0;
        const gotIds = new Set<string>();
        for (let n = 0; n < 200; n++) {
          const p = pool[n % pool.length]!;
          const { email } = await read(p.id, ip);
          if (email) { got++; gotIds.add(p.id); }
        }
        ok(gotIds.size <= N, `M17: ${name} → 200 reads from one IP give e-mail for ≤ ${N} distinct profiles (${gotIds.size})`);
      }
      for (const [name, run] of [["discover", discover], ["search", search]] as const) {
        freshGuard(N);
        const ids = new Set<string>();
        for (let n = 0; n < 10; n++) for (const x of listContacts(await run("203.0.113.51"))) if (x.contact?.email) ids.add(x.id);
        ok(ids.size <= N, `M18: ${name} → 10 lists from one IP give e-mail for ≤ ${N} distinct profiles (${ids.size})`);
      }
    }

    // ── S: one rfb counter for every surface and the profile page ───────
    {
      freshGuard(3);
      const ip = "203.0.113.60";
      await card(P[0]!.id, ip);
      await a2aInfo(P[1]!.id, ip);
      const { slugify } = require("../utils/slug") as typeof import("../utils/slug");
      await a.get(`/produsent/${slugify(P[2]!.name)}`, ip, "Mozilla/5.0 (test)");
      const v = await vcard(MASS[0]!.id, ip);
      ok(v.email === undefined, "S1: card + A2A agent/info + profile page spend one rfb budget → the 4th profile's vcard has no e-mail");
      const back = await Promise.all([info(P[0]!.id, ip), agentJson(P[1]!.id, ip), card(P[2]!.id, ip)]);
      ok(back[0]!.email === P[0]!.email && back[1]!.email === P[1]!.email && back[2]!.email === P[2]!.email, "S2: a profile counted on one surface is free on another");
      const list = await discover(ip);
      eq(listContacts(list).filter((x) => x.contact?.email).map((x) => x.id).sort(), P.map((p) => p.id).filter((id) => listContacts(list).some((x) => x.id === id)).sort(),
        "S3: a list after the limit gives e-mail only for the profiles already counted");
    }

    // ── K: the owner's own /info read is not limited ────────────────────
    {
      freshGuard(0);
      const token = "rae-claim-token-1";
      try {
        testDb.prepare(
          `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, claim_token, created_at, verified_at)
           VALUES ('rae-claim-1', ?, 'Eier', 'eier@example.invalid', 'verified', ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
        ).run(P[0]!.id, token);
      } catch (err: any) { ok(false, "K0: seed claim: " + err?.message); }
      const own = await info(P[0]!.id, "203.0.113.70", BROWSER, { "x-claim-token": token });
      ok(own.email === P[0]!.email, "K1: the owner's /info read (X-Claim-Token) keeps the e-mail with limit 0");
      eq(own.r.headers["cache-control"], "private", "K2: the owner's /info read is Cache-Control: private with the switch on");
      const pub = await info(P[0]!.id, "203.0.113.70");
      ok(pub.email === null, "K3: the same /info read without the token, limit 0 → e-mail null");
      // Review M5 (lokal#1436): only a claim token for exactly this agent bypasses the budget.
      const bogus = await info(P[0]!.id, "203.0.113.71", BROWSER, { "x-claim-token": "rae-bogus-token-does-not-exist" });
      ok(bogus.r.status === 200 && bogus.email === null && !leaks(bogus.r.text, P[0]!.email), "K4: a bogus X-Claim-Token is treated like no token (limit 0 → e-mail null, address nowhere)");
      eq(bogus.r.headers["cache-control"], "private", "K5: ... Cache-Control: private");
      const foreign = await info(P[1]!.id, "203.0.113.71", BROWSER, { "x-claim-token": token });
      ok(foreign.r.status === 200 && foreign.email === null && !leaks(foreign.r.text, P[1]!.email), "K6: a valid claim token for ANOTHER agent does not bypass the budget (e-mail null)");
      freshGuard(1);
      const spent = await info(P[2]!.id, "203.0.113.72", BROWSER, { "x-claim-token": "rae-bogus-token-does-not-exist" });
      const next = await info(MASS[0]!.id, "203.0.113.72");
      ok(spent.email === P[2]!.email && next.email === null, "K7: a read with a bogus token spends the IP's budget like a tokenless read (limit 1: the next profile is withheld)");
    }

    // ── V: vcard for a producer without an e-mail (review M10, lokal#1436) ──
    {
      freshGuard(1);
      const ip = "203.0.113.75";
      const v = await vcard(NOEMAIL.id, ip);
      ok(v.r.status === 200 && v.email === undefined && !/^EMAIL/m.test(v.r.text), "V1: switch on → vcard of a producer without an e-mail has no EMAIL line");
      eq(v.r.headers["cache-control"], "private", "V2: switch on → vcard of a producer without an e-mail is Cache-Control: private (no shared cache entry)");
      ok(/^X-LOKAL-AGENT-ID:rer-p4\r?$/m.test(v.r.text) && v.r.text.includes(`FN;CHARSET=UTF-8:${NOEMAIL.name}`) && !anyLeak(v.r.text),
        "V3: ... it is that producer's own vCard (FN, agent id), no other producer's address in it");
      const after = await vcard(P[0]!.id, ip);
      ok(after.email === P[0]!.email, "V4: the no-e-mail vcard spent none of the IP's budget (limit 1: the next producer still gets its EMAIL line)");
      const v2 = await vcard(NOEMAIL.id, ip);
      ok(v2.email === undefined && v2.r.headers["cache-control"] === "private" && stable(v2.r.text) === stable(v.r.text), "V5: over the limit → the no-e-mail vcard is unchanged and still private");
      switchOff();
      const vOff = await vcard(NOEMAIL.id, ip);
      eq(vOff.r.headers["cache-control"], undefined, "V6: switch off → the no-e-mail vcard has no Cache-Control (as before)");
      switchOn();
    }

    // ── W: producers without an e-mail spend no list budget (review M11, lokal#1436) ──
    for (const [name, run] of [["discover", discover], ["search", search]] as const) {
      // List order (switch off): the no-e-mail producer rer-p4 sits among the first
      // producers with an e-mail. With limit 4 the 4th e-mail goes to the first
      // producer WITH an e-mail after it; were rer-p4 counted, that one would be withheld.
      const LIMIT = 4;
      freshGuard(LIMIT);
      const offRows = listContacts({ status: 200, text: offBodies.get(name)!, headers: {} });
      const expectIds = offRows.filter((x) => x.contact?.email).slice(0, LIMIT).map((x) => x.id);
      const noIdx = offRows.findIndex((x) => x.id === NOEMAIL.id);
      const lastIdx = offRows.findIndex((x) => x.id === expectIds[LIMIT - 1]);
      ok(expectIds.length === LIMIT && noIdx >= 0 && noIdx < lastIdx && !offRows[noIdx]!.contact?.email,
        `W0: ${name} lists the no-e-mail producer before the ${LIMIT}th producer with an e-mail (idx ${noIdx} < ${lastIdx})`);
      const r = await run("203.0.113.80");
      eq(listContacts(r).filter((x) => x.contact?.email).map((x) => x.id), expectIds,
        `W1: ${name}, limit ${LIMIT} → the first ${LIMIT} producers WITH an e-mail get it; the one without, listed among them, spent nothing`);
    }
    {
      freshGuard(1);
      const cr = await cartSubmit([NOEMAIL.id, P[0]!.id], "203.0.113.82");
      const h = (body(cr)?.contact_handoffs ?? []) as any[];
      const byId = new Map(h.map((x) => [x.agent_id, x]));
      ok(cr.status === 201 && byId.get(NOEMAIL.id)?.email === null && byId.get(P[0]!.id)?.email === P[0]!.email,
        "W2: cart submit [no e-mail, P0], limit 1 → the no-e-mail handoff spent nothing, P0 keeps its e-mail");
    }

    // ── G: log lines ────────────────────────────────────────────────────
    {
      ok(logLines.length > 0, "G1: the guard logged withheld requests");
      const joined = logLines.join("\n");
      ok(!anyLeak(joined), "G2: no log line carries an e-mail address");
      ok(!/203\.0\.113\./.test(joined), "G3: no log line carries an IP");
      ok(logLines.every((l) => { try { const o = JSON.parse(l); return o.evt === "email_reveal_withheld" && o.host === "rfb"; } catch { return false; } }), "G4: every line is the guard's JSON line for rfb");
    }

    // ── T: the trap path (S-A4) ─────────────────────────────────────────
    {
      const trap = require("../services/email-reveal-trap") as typeof import("../services/email-reveal-trap");
      const robotsParser = require("../services/product-import/robots") as typeof import("../services/product-import/robots");
      const { slugify } = require("../utils/slug") as typeof import("../utils/slug");
      const pageOf = (i: number, ip: string) => a.get(`/produsent/${slugify(P[i]!.name)}`, ip, "Mozilla/5.0 (test)");
      const jsonLdText = (html: string) => Array.from(html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)).map((m) => m[1]).join("\n");
      const trapLinks = (html: string) => html.split(trap.EMAIL_TRAP_LINK_HTML).length - 1;
      let now = 50_000_000;
      const trapLines: string[] = [];
      guard.__resetEmailRevealGuardForTesting({ now: () => now, log: (l) => trapLines.push(l) });
      delete process.env.EMAIL_REVEAL_PER_IP_PER_HOUR;

      // robots.txt: every group disallows the trap path; same text switch on or off
      switchOff();
      const robotsOff = await a.get("/robots.txt", "203.0.113.200");
      switchOn();
      const robotsOn = await a.get("/robots.txt", "203.0.113.200");
      ok(robotsOff.status === 200 && robotsOff.text === robotsOn.text, "T1: robots.txt is the same with the switch on and off");
      const agents = Array.from(robotsOn.text.matchAll(/^User-agent: (.+)$/gm)).map((m) => m[1]!.trim());
      ok(agents.length > 20 && agents.includes("*") && agents.includes("Googlebot") && agents.includes("GPTBot"), "T2: robots.txt has the * group and the named groups");
      const allowedFor = agents.filter((ua) => {
        const policy = robotsParser.parseRobotsTxt(robotsOn.text, ua === "*" ? "some-unlisted-bot" : ua);
        return robotsParser.isPathAllowed(policy, "/kontakt-arkiv/") || robotsParser.isPathAllowed(policy, "/kontakt-arkiv");
      });
      eq(allowedFor, [], "T3: no robots.txt group (incl. *) may fetch the trap path");
      const groups = robotsOn.text.split(/\n\n/).filter((g) => /^User-agent: /m.test(g));
      ok(groups.every((g) => g.includes(trap.EMAIL_TRAP_ROBOTS_DISALLOW)), "T4: the Disallow line is repeated inside every User-agent group");
      ok(robotsParser.isPathAllowed(robotsParser.parseRobotsTxt(robotsOn.text, "Googlebot"), `/produsent/${slugify(P[0]!.name)}`), "T5: profile pages stay crawlable");

      // switch off: no link, the path falls through, nothing recorded
      switchOff();
      const offPage = await pageOf(0, "203.0.113.201");
      eq(trapLinks(offPage.text), 0, "T6: switch off -> no trap link on the profile page");
      ok(!offPage.text.includes("kontakt-arkiv"), "T6b: ... the path is nowhere in the page");
      const offTrap = await a.get("/kontakt-arkiv/", "203.0.113.201");
      ok(!offTrap.text.includes("Ingen oppføringer") && offTrap.headers["cache-control"] !== "no-store", "T7: switch off -> the trap path is not answered by the trap");
      eq(trapLines.length, 0, "T8: switch off -> nothing logged");
      switchOn();
      eq((await card(P[0]!.id, "203.0.113.201")).email, P[0]!.email, "T9: a hit while the switch was off left no block");

      // switch on: link on the page, not in JSON-LD, not in the sitemap
      const onPage = await pageOf(0, "203.0.113.202");
      eq(trapLinks(onPage.text), 1, "T10: switch on -> the hidden trap link once on the producer page");
      ok(!jsonLdText(onPage.text).includes("kontakt-arkiv"), "T11: ... and not in JSON-LD");
      ok(/<a href="\/kontakt-arkiv\/" rel="nofollow" tabindex="-1" aria-hidden="true" hidden style="display:none">/.test(onPage.text), "T12: the link is hidden from humans (hidden, display:none, aria-hidden, tabindex -1, nofollow)");
      const umbOn = await a.get(`/produsent/${slugify(RFB_EMAIL_FIXTURE.umbrella.name)}`, "203.0.113.202", "Mozilla/5.0 (test)");
      eq(trapLinks(umbOn.text), 1, "T13: ... and on the umbrella page");
      const sitemap = await a.get("/sitemap.xml", "203.0.113.202");
      ok(sitemap.status === 200 && sitemap.text.includes("/produsent/") && !sitemap.text.includes("kontakt-arkiv"), "T14: the trap path is not in the sitemap");

      // a hit blocks this IP on every surface of the host
      const ip = "203.0.113.210";
      ok((await pageOf(1, ip)).text.includes(`href="mailto:${P[1]!.email}"`), "T15: before the hit the page shows the e-mail");
      const hit = await a.get("/kontakt-arkiv/", ip);
      ok(hit.status === 200 && hit.text.includes("Ingen oppføringer"), "T16: the trap answers a small 200 page");
      eq([hit.headers["x-robots-tag"], hit.headers["cache-control"]], ["noindex, nofollow", "no-store"], "T17: ... noindex, nofollow and no-store");
      ok(!anyLeak(hit.text), "T18: ... with no e-mail");
      const blockedPage = await pageOf(1, ip);
      ok(blockedPage.status === 200 && !leaks(blockedPage.text, P[1]!.email) && !jsonLdText(blockedPage.text).includes('"email"') && blockedPage.text.includes("Vis e-post"),
        "T19: blocked -> the page renders, «Vis e-post», no address, no JSON-LD email (a profile it saw before too)");
      eq((await a.get(`/produsent/${slugify(P[2]!.name)}/epost`, ip, "Mozilla/5.0 (test)")).status, 429, "T20: blocked -> the reveal endpoint answers as over the limit (429)");
      const blockedCard = await card(P[2]!.id, ip);
      const freeCard = await card(P[2]!.id, "203.0.113.211");
      eq([blockedCard.email, freeCard.email], [undefined, P[2]!.email], "T21: blocked -> card without e-mail; another IP gets it");
      eq((await card(NOEMAIL.id, ip)).shape, (await card(NOEMAIL.id, "203.0.113.211")).shape, "T21b: ... the blocked card has the shape of a producer without e-mail");
      eq((await info(P[0]!.id, ip)).email, null, "T22: blocked -> info knowledge.email null");
      const headHit = await a.head("/kontakt-arkiv/noe", "203.0.113.212");
      eq(headHit.status, 200, "T23: HEAD on a path below the trap is the trap too");
      eq((await card(P[0]!.id, "203.0.113.212")).email, undefined, "T24: ... and blocks that IP");
      await a.get("/kontakt-arkiv", "203.0.113.213");
      eq((await card(P[0]!.id, "203.0.113.213")).email, undefined, "T25: /kontakt-arkiv without the slash is the trap too");
      const enTrap = await a.get("/en/kontakt-arkiv/", "203.0.113.214");
      ok(!enTrap.text.includes("Ingen oppføringer"), "T25b: /en/kontakt-arkiv/ (not in robots.txt) is not the trap");
      eq((await card(P[0]!.id, "203.0.113.214")).email, P[0]!.email, "T25c: ... and blocks nobody");
      now += 24 * 60 * 60_000 - 1;
      eq((await card(P[0]!.id, ip)).email, undefined, "T26: still blocked just before 24 h");
      now += 1;
      eq((await card(P[0]!.id, ip)).email, P[0]!.email, "T27: after 24 h the e-mail is back");
      const joined = trapLines.join("\n");
      ok(trapLines.some((l) => JSON.parse(l).evt === "email_reveal_trap_hit" && JSON.parse(l).host === "rfb"), "T28: the hit is logged (email_reveal_trap_hit, host rfb)");
      ok(trapLines.some((l) => JSON.parse(l).reason === "trap_blocked"), "T29: withheld answers are logged with reason trap_blocked");
      ok(!anyLeak(joined) && !/203\.0\.113\./.test(joined), "T30: no log line carries an e-mail address or an IP");
      switchOff();
    }
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.log = prevConsoleLog;
    if (app) await app.close().catch(() => {});
    for (const k of envKeys) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    guard.__resetEmailRevealGuardForTesting();
    const producers = (store as unknown as { producers: Map<string, unknown> }).producers;
    for (const p of fixture) producers.delete(p.id);
    producers.delete(RFB_EMAIL_FIXTURE.noEmail.id);
    try { clearRegistry(); } catch { /* ignore */ }
    for (const m of ["./marketplace", "./marketplace-cart", "./a2a", "./seo"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* ignore */ }
    }
    if (prevMainDb) initMod.__setDbForTesting(prevMainDb as any);
    testDb.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbApiEmailRevealTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
