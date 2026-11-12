/**
 * rfb-contact-form-only-sd2.test.ts — dev-request
 * 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, S-D2
 * («Kontaktskjema som valg per profil», RFB REST + A2A, not MCP): with
 * CONTACT_FORM_RFB on, a profile with agents.contact_form_only = 1 has its
 * e-mail left out of the public API answers, exactly as for a producer
 * without one (no new field).
 *
 * Surfaces:
 *   card     GET  /api/marketplace/agents/:id/card      contact.email (left out)
 *   info     GET  /api/marketplace/agents/:id/info      data.knowledge.email (null)
 *   vcard    GET  /api/marketplace/agents/:id/vcard     EMAIL line (left out)
 *   agentjs  GET  /agents/:id/agent.json                x-knowledge.email (left out)
 *   a2ainfo  POST /a2a agent/info                       knowledge.email (null)
 *   search   GET  /api/marketplace/search               results[].contact.email (null / { vcardUrl })
 *   discover POST /api/marketplace/discover             results[].contact.email (null / { vcardUrl })
 *   cart     POST /api/marketplace/cart/:id/submit      contact_handoffs[].email (null)
 *   offers   GET  /api/marketplace/catalog/offers       offers[].producer.email (null)
 *   conv     POST/GET /api/conversations[/:id], /samtale/:id   the seller's ✉️ line
 *   helpers  withContactFormOnlyProducerEmailNull (the /handleliste pre-selection),
 *            withoutSellerEmailAlways (/samtaler, front page), messageForListener (live streams)
 *
 *   O  switch off: every surface byte-identical with the flag set and unset
 *      (the flag is not read), the e-mail present, no Cache-Control added
 *   F  switch on, flagged: the address nowhere in the body; the body is the
 *      switch-off body less the e-mail (as the S-A5 withheld shape)
 *   U  switch on, unflagged: byte-identical to switch off
 *   X  the buyer's own order (GET /orders/:id producer_contact) keeps the
 *      flagged seller's e-mail
 *   B  with the per-IP e-mail guard on too, a flagged profile spends no budget
 *   D  stored rows unchanged (no DB write)
 *
 * Standalone: npx tsx src/routes/rfb-contact-form-only-sd2.test.ts
 * Wired into tests/test.ts via runRfbContactFormOnlySd2Tests().
 */

import Database from "better-sqlite3";
import { seedRfbApiEmailFixture, type HttpResult } from "./rfb-api-email-reveal.test";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const BROWSER = "Mozilla/5.0 (test)";

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

async function startApp(): Promise<{ get(path: string, ip: string, headers?: Record<string, string>): Promise<HttpResult>; post(path: string, body: unknown, ip: string, headers?: Record<string, string>): Promise<HttpResult>; close(): Promise<void> }> {
  const express = require("express") as typeof import("express");
  const http = require("http") as typeof import("http");
  for (const m of ["./marketplace", "./marketplace-cart", "./marketplace-catalog", "./a2a", "./conversation-ui", "./seo"]) {
    try { delete require.cache[require.resolve(m)]; } catch { /* not loaded */ }
  }
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use(require("../i18n/middleware").langMiddleware);
  app.use("/api/marketplace", require("./marketplace").default);
  app.use("/api/marketplace/catalog", require("./marketplace-catalog").catalogRouter);
  app.use("/api/marketplace", require("./marketplace-cart").cartRouter);
  app.use("/", require("./a2a").default);
  app.use("/", require("./conversation-ui").default);
  app.use("/", require("./seo").default);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("net").AddressInfo).port;
  const call = (method: string, path: string, body: unknown, ip: string, extra: Record<string, string> = {}): Promise<HttpResult> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string> = { "x-forwarded-for": ip, "user-agent": BROWSER, accept: "application/json", ...extra };
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
    get: (path, ip, headers) => call("GET", path, undefined, ip, headers),
    post: (path, body, ip, headers) => call("POST", path, body, ip, headers),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

export async function runRfbContactFormOnlySd2Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const envKeys = ["CONTACT_FORM_RFB", "EMAIL_REVEAL_GUARD_RFB", "EMAIL_REVEAL_PER_IP_PER_HOUR", "OWNER_PAUSE_ENABLED", "OWNER_FEATURES_ENFORCE", "OWNER_FEATURES_ALLOWED_SUBJECTS", "PAYMENTS_ENABLED"];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  for (const k of envKeys) delete process.env[k];

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevMainDb = initMod.__peekDbForTesting();
  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");
  testDb.function("random", () => 0);

  const guard = require("../services/email-reveal-guard") as typeof import("../services/email-reveal-guard");
  const cf = require("../services/contact-form-only") as typeof import("../services/contact-form-only");
  const convGuard = require("../services/conversation-email-guard") as typeof import("../services/conversation-email-guard");
  const guardLog: string[] = [];
  guard.__resetEmailRevealGuardForTesting({ log: (l) => guardLog.push(l) });
  const switchOn = () => { process.env.CONTACT_FORM_RFB = "on"; };
  const switchOff = () => { delete process.env.CONTACT_FORM_RFB; };
  const clearRegistry = () => {
    const reg = (require("../services/marketplace-registry") as any).marketplaceRegistry;
    reg._agentsCache = null;
    reg._statsCache = null;
    reg._slugIdMap = null;
  };
  const { store } = require("../services/store") as typeof import("../services/store");
  let fixture: Array<{ id: string; name: string; email: string }> = [];
  let app: Awaited<ReturnType<typeof startApp>> | null = null;
  const prevConsoleLog = console.log;
  const consoleLines: string[] = [];
  if (!log) console.log = (...args: unknown[]) => { consoleLines.push(args.map(String).join(" ")); };

  try {
    initMod.__setDbForTesting(testDb as any);
    initMod.__initSchemaForTesting(testDb as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    fixture = seedRfbApiEmailFixture(testDb);
    for (const p of fixture) store.addProducer(storeProducer(p.id, p.name));
    clearRegistry();

    const F = fixture[0]!;   // flagged
    const U = fixture[1]!;   // unflagged
    const setFlag = (id: string, on: boolean) => testDb.prepare("UPDATE agents SET contact_form_only = ? WHERE id = ?").run(on ? 1 : 0, id);

    // Offers: a verified knowledge row and a product «Poteter» for F and U.
    for (const p of [F, U]) {
      testDb.prepare("UPDATE agent_knowledge SET verification_status = 'verified' WHERE agent_id = ?").run(p.id);
      testDb.prepare("INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability) VALUES (?, ?, 'Poteter', 'poteter', 30, 'kg', 'in_stock')").run(`sd2-prod-${p.id}`, p.id);
    }

    // Conversations, written straight through the service (no budget spent).
    const { conversationService } = require("../services/conversation-service") as typeof import("../services/conversation-service");
    const convF = conversationService.startConversation({ sellerAgentId: F.id, queryText: "poteter", source: "api" }).id;
    const convU = conversationService.startConversation({ sellerAgentId: U.id, queryText: "poteter", source: "api" }).id;

    // An order the buyer placed with F (the order-flow exclusion).
    const BUYER_REF = "sd2-buyer-ref-1";
    testDb.prepare("INSERT INTO orders (id, cart_id, agent_id, buyer_ref, status, fulfilment, total_nok) VALUES ('sd2-order-1', NULL, ?, ?, 'pending', 'pickup', 30)").run(F.id, BUYER_REF);

    const storedSnapshot = JSON.stringify([
      testDb.prepare("SELECT id, content, metadata FROM messages ORDER BY id").all(),
      testDb.prepare("SELECT agent_id, email FROM agent_knowledge ORDER BY agent_id").all(),
      testDb.prepare("SELECT id, contact_email, contact_form_only FROM agents ORDER BY id").all(),
    ]);

    app = await startApp();
    const a = app;
    const forms = (e: string) => [e, JSON.stringify(e).slice(1, -1), e.replace(/&/g, "&amp;"), e.replace(/&/g, "\\u0026"), encodeURIComponent(e), e.replace(/@/g, "\\@")];
    const leaks = (text: string, e: string) => forms(e).some((f) => text.includes(f));
    const body = (r: HttpResult) => { try { return JSON.parse(r.text); } catch { return null; } };
    const stable = (text: string) => text.replace(/^REV:.*$/m, "REV:…").replace(/"timestamp":"[^"]*"/g, '"timestamp":"…"');
    const cartComparable = (text: string) => text.replace(/"(cart_id|buyer_ref|id)":"[^"]*"/g, '"$1":"…"');

    // ── surfaces: name → (agent id) → response ───────────────────────────
    const cartSubmit = async (ids: string[], ip: string) => {
      const cart = require("../services/cart-service") as typeof import("../services/cart-service");
      const { cart_id, buyer_ref } = cart.createCart();
      for (const id of ids) {
        const w = cart.addCartWish(cart_id, "poteter", 1);
        if (!w.success) throw new Error("addCartWish failed: " + w.error);
        const c = cart.chooseCartWishOffer(cart_id, w.wish.id, { agentId: id });
        if (!c.success) throw new Error("chooseCartWishOffer failed: " + c.error);
      }
      return a.post(`/api/marketplace/cart/${cart_id}/submit`, { buyer_ref }, ip, { "x-cart-token": buyer_ref });
    };
    type Surface = { name: string; read: (p: { id: string; name: string }, ip: string) => Promise<HttpResult>; norm: (t: string) => string };
    const convOf = (id: string) => (id === F.id ? convF : convU);
    const SURFACES: Surface[] = [
      { name: "card", read: (p, ip) => a.get(`/api/marketplace/agents/${p.id}/card`, ip), norm: (t) => t },
      { name: "info", read: (p, ip) => a.get(`/api/marketplace/agents/${p.id}/info`, ip), norm: (t) => t },
      { name: "vcard", read: (p, ip) => a.get(`/api/marketplace/agents/${p.id}/vcard`, ip), norm: stable },
      { name: "agent.json", read: (p, ip) => a.get(`/agents/${p.id}/agent.json`, ip), norm: (t) => t },
      { name: "a2a agent/info", read: (p, ip) => a.post("/a2a", { jsonrpc: "2.0", method: "agent/info", params: { agentId: p.id }, id: `info-${p.id}` }, ip), norm: stable },
      { name: "search", read: (p, ip) => a.get("/api/marketplace/search?q=" + encodeURIComponent(p.name), ip), norm: (t) => t },
      { name: "discover", read: (_p, ip) => a.post("/api/marketplace/discover", { categories: ["vegetables"] }, ip), norm: (t) => t },
      { name: "cart submit", read: (p, ip) => cartSubmit([p.id], ip), norm: cartComparable },
      { name: "catalog offers", read: (_p, ip) => a.get("/api/marketplace/catalog/offers?q=poteter&lat=60.63&lng=6.42", ip), norm: (t) => t },
      { name: "conversation", read: (p, ip) => a.get(`/api/conversations/${convOf(p.id)}`, ip), norm: (t) => t },
      { name: "conversation list", read: (_p, ip) => a.get("/api/conversations?limit=50", ip), norm: (t) => t },
      { name: "samtale page", read: (p, ip) => a.get(`/samtale/${convOf(p.id)}`, ip, { accept: "text/html" }), norm: (t) => t },
    ];

    // ── O: switch off, flag set → byte-identical to flag unset ─────────
    const off = new Map<string, string>();
    const offCc = new Map<string, string>();
    switchOff();
    for (const s of SURFACES) {
      for (const p of [F, U]) {
        setFlag(F.id, false);
        const unset = await s.read(p, "203.0.113.10");
        setFlag(F.id, true);
        const set = await s.read(p, "203.0.113.11");
        off.set(`${s.name}:${p.id}`, unset.text);
        offCc.set(s.name, String(unset.headers["cache-control"]));
        ok(unset.status >= 200 && unset.status < 300, `O0: switch off → ${s.name} (${p.id}) answers ${unset.status}`);
        ok(s.norm(set.text) === s.norm(unset.text), `O1: switch off → ${s.name} (${p.id === F.id ? "flagged" : "unflagged"}) byte-identical with the flag set and unset`);
        eq(set.headers["cache-control"], unset.headers["cache-control"], `O2: switch off → ${s.name} (${p.id}) same Cache-Control with the flag set`);
      }
      const fText = off.get(`${s.name}:${F.id}`)!;
      ok(leaks(fText, F.email), `O3: switch off → ${s.name} carries the flagged producer's e-mail (as on main)`);
    }
    {
      const sam = await a.get("/samtaler?kilde=api", "203.0.113.12", { accept: "text/html" });
      ok(sam.status === 200, `O4: switch off → /samtaler answers (${sam.status})`);
      off.set("samtaler", sam.text);
    }

    // ── F / U: switch on ───────────────────────────────────────────────
    switchOn();
    setFlag(F.id, true);
    for (const s of SURFACES) {
      const f = await s.read(F, "203.0.113.20");
      ok(f.status >= 200 && f.status < 300, `F0: switch on → ${s.name} (flagged) still answers (${f.status})`);
      ok(!leaks(f.text, F.email), `F1: switch on → ${s.name}: the flagged producer's address is nowhere in the body`);
      eq(String(f.headers["cache-control"]), offCc.get(s.name), `F2: switch on → ${s.name}: Cache-Control as with the switch off`);
      const u = await s.read(U, "203.0.113.21");
      const perProducer = !["discover", "catalog offers", "conversation list"].includes(s.name);
      if (perProducer) {
        ok(s.norm(u.text) === s.norm(off.get(`${s.name}:${U.id}`)!), `U1: switch on → ${s.name} (unflagged) byte-identical to switch off`);
      }
      ok(leaks(u.text, U.email), `U2: switch on → ${s.name} still carries the unflagged producer's e-mail`);
    }

    // F3: exact shapes = the switch-off body less the e-mail.
    {
      const card = body(await a.get(`/api/marketplace/agents/${F.id}/card`, "203.0.113.22"));
      const offCard = JSON.parse(off.get(`card:${F.id}`)!);
      delete offCard.contact.email;
      eq(card, offCard, "F3: card = the switch-off card without contact.email");
      const info = body(await a.get(`/api/marketplace/agents/${F.id}/info`, "203.0.113.22"));
      const offInfo = JSON.parse(off.get(`info:${F.id}`)!);
      offInfo.data.knowledge.email = null;
      eq(info, offInfo, "F4: info = the switch-off info with knowledge.email null");
      const v = await a.get(`/api/marketplace/agents/${F.id}/vcard`, "203.0.113.22");
      eq(stable(v.text), stable(off.get(`vcard:${F.id}`)!).split(/(?<=\n)/).filter((l) => !l.startsWith("EMAIL;")).join(""), "F5: vcard = the switch-off vCard without its EMAIL line");
      const j = body(await a.get(`/agents/${F.id}/agent.json`, "203.0.113.22"));
      const offJ = JSON.parse(off.get(`agent.json:${F.id}`)!);
      delete offJ["x-knowledge"].email;
      eq(j, offJ, "F6: agent.json = the switch-off card without x-knowledge.email");
      const ai = await a.post("/a2a", { jsonrpc: "2.0", method: "agent/info", params: { agentId: F.id }, id: `info-${F.id}` }, "203.0.113.22");
      const k = body(ai)?.result?.artifacts?.[0]?.parts?.[0]?.data?.knowledge;
      ok(!!k && k.email === null && k.phone === "55512345", "F7: A2A agent/info → knowledge.email null, other contact fields stay");
      const row = (r: HttpResult, id: string) => ((body(r)?.results ?? []) as any[]).find((x) => x?.agent?.id === id);
      for (const name of ["search", "discover"] as const) {
        const r = name === "search" ? await a.get("/api/marketplace/search?q=" + encodeURIComponent(F.name), "203.0.113.22") : await a.post("/api/marketplace/discover", { categories: ["vegetables"] }, "203.0.113.22");
        const offRow = row({ status: 200, text: off.get(`${name}:${F.id}`)!, headers: {} }, F.id);
        const onRow = row(r, F.id);
        eq(onRow?.contact, { ...offRow?.contact, email: null }, `F8: ${name} → the flagged producer's contact block has email null, the rest as switch off`);
        const onU = row(r, U.id);
        const offU = row({ status: 200, text: off.get(`${name}:${F.id}`)!, headers: {} }, U.id);
        if (offU) eq(onU?.contact, offU.contact, `F9: ${name} → the unflagged producer's contact block unchanged in the same list`);
      }
      const cr = await cartSubmit([F.id, U.id], "203.0.113.22");
      const h = (body(cr)?.contact_handoffs ?? []) as any[];
      const hf = h.find((x) => x.agent_id === F.id);
      const hu = h.find((x) => x.agent_id === U.id);
      ok(cr.status === 201 && hf?.email === null && typeof hf?.profile_url === "string" && hu?.email === U.email, "F10: cart submit → the flagged handoff has email null (profile_url stays), the unflagged keeps its e-mail");
      const off2 = await (async () => { switchOff(); const r = await cartSubmit([F.id, U.id], "203.0.113.22"); switchOn(); return r; })();
      const offH = ((body(off2)?.contact_handoffs ?? []) as any[]).map((x) => (x.agent_id === F.id ? { ...x, email: null } : x));
      eq(h, offH, "F11: cart submit → handoffs = the switch-off handoffs with the flagged e-mail null");
      const of = await a.get("/api/marketplace/catalog/offers?q=poteter&lat=60.63&lng=6.42", "203.0.113.22");
      const offOf = JSON.parse(off.get(`catalog offers:${F.id}`)!);
      for (const o of offOf.offers ?? []) if (o.producer?.agent_id === F.id) o.producer.email = null;
      ok((offOf.offers ?? []).some((o: any) => o.producer?.agent_id === F.id), "F12a: catalog offers lists the flagged producer");
      eq(body(of), offOf, "F12: catalog offers = the switch-off answer with the flagged producer's email null");
      const conv = body(await a.get(`/api/conversations/${convF}`, "203.0.113.22"));
      const seller = (conv?.data?.messages ?? []).find((m: any) => m.senderRole === "seller");
      ok(!!seller && !/^\s*✉/m.test(seller.content) && seller.content.includes("📞 55512345"), "F13: conversation → the seller reply without the ✉️ line, the phone line stays");
      const sam = await a.get("/samtaler?kilde=api", "203.0.113.22", { accept: "text/html" });
      ok(sam.status === 200 && !leaks(sam.text, F.email), "F14: /samtaler (shared HTML) → no flagged seller e-mail");
    }

    // F15: the shared helpers (handleliste pre-selection, /samtaler, live streams).
    {
      const items = [{ producer: { agent_id: F.id, email: F.email as string | null } }, { producer: { agent_id: U.id, email: U.email as string | null } }];
      const onItems = cf.withContactFormOnlyProducerEmailNull(items);
      eq(onItems.map((o) => o.producer.email), [null, U.email], "F15: withContactFormOnlyProducerEmailNull → flagged email null, unflagged kept");
      ok(onItems[1] === items[1], "F16: … the unflagged item is the same object");
      const unflaggedOnly = [items[1]!];
      ok(cf.withContactFormOnlyProducerEmailNull(unflaggedOnly) === unflaggedOnly, "F17: … no flagged producer → the same array");
      const convs = [conversationService.getConversation(convF)!, conversationService.getConversation(convU)!];
      const always = convGuard.withoutSellerEmailAlways(convs);
      ok(!leaks(JSON.stringify(always[0]), F.email) && always[1] === convs[1], "F18: withoutSellerEmailAlways (guard off, switch on) → only the flagged seller's e-mail out");
      const fakeReq = { ip: "203.0.113.23", headers: { "user-agent": BROWSER } } as any;
      const msgF = { ...(convs[0]!.messages.find((m: any) => m.senderRole === "seller") as any), conversationId: convF };
      const msgU = { ...(convs[1]!.messages.find((m: any) => m.senderRole === "seller") as any), conversationId: convU };
      ok(!leaks(JSON.stringify(convGuard.messageForListener(fakeReq, msgF)), F.email), "F19: messageForListener → the flagged seller's live message without the e-mail");
      ok(convGuard.messageForListener(fakeReq, msgU) === msgU, "F20: messageForListener → the unflagged seller's message as given");
      const db = testDb as any;
      eq(cf.contactFormOnlyIds(db, [F.id, U.id, F.id, ""]), new Set([F.id]), "F21: contactFormOnlyIds → the flagged ids only");
      ok(Array.from(cf.contactFormOnlyIds(db, [F.id, U.id]) ?? []).join() === F.id, "F21b: … as a set of ids");
      ok(cf.contactFormOnlyIds(db, [F.id], "rfb", {}) === null, "F22: contactFormOnlyIds with the switch off → null (flag not read)");
      switchOff();
      ok(cf.withContactFormOnlyProducerEmailNull(items) === items, "F23: switch off → withContactFormOnlyProducerEmailNull returns the same array");
      ok(convGuard.withoutSellerEmailAlways(convs) === convs, "F24: switch off (guard off) → withoutSellerEmailAlways returns the same list");
      ok(convGuard.messageForListener(fakeReq, msgF) === msgF, "F25: switch off (guard off) → messageForListener returns the message as given");
      switchOn();
    }

    // ── X: the buyer's own order keeps the seller's e-mail ─────────────
    {
      const r = await a.get(`/api/marketplace/orders/sd2-order-1?buyer_ref=${encodeURIComponent(BUYER_REF)}`, "203.0.113.30", { "x-cart-token": BUYER_REF });
      const pc = body(r)?.producer_contact;
      ok(r.status === 200 && pc?.email === F.email, `X1: switch on → GET /orders/:id producer_contact keeps the flagged seller's e-mail (status ${r.status})`);
      const cartSvc = require("../services/cart-service") as typeof import("../services/cart-service");
      eq(cartSvc.producerContact(F.id, F.name).email, F.email, "X2: producerContact (order confirmation / lokal_order_status source) unchanged");
    }

    // ── B: with the e-mail guard on, a flagged profile spends no budget ─
    {
      process.env.EMAIL_REVEAL_GUARD_RFB = "on";
      process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = "1";
      guard.__resetEmailRevealGuardForTesting({ log: (l) => guardLog.push(l) });
      const ip = "203.0.113.40";
      const f = body(await a.get(`/api/marketplace/agents/${F.id}/card`, ip));
      ok(f?.contact && f.contact.email === undefined, "B1: guard on + switch on → flagged card has no e-mail");
      const u = body(await a.get(`/api/marketplace/agents/${U.id}/card`, ip));
      eq(u?.contact?.email, U.email, "B2: … and the flagged read spent no budget: the next (unflagged) profile gets its e-mail with limit 1");
      const u2 = body(await a.get(`/api/marketplace/agents/${fixture[2]!.id}/card`, ip));
      eq(u2?.contact?.email, undefined, "B3: … the limit still applies to the next unflagged profile");
      const l = await a.get("/api/marketplace/search?q=" + encodeURIComponent(F.name), "203.0.113.41");
      ok(!leaks(l.text, F.email), "B4: guard on + switch on → search has no flagged e-mail");
      eq(l.headers["cache-control"], "private", "B5: guard on → Cache-Control: private as before");
      const conv = await a.get(`/api/conversations/${convF}`, "203.0.113.42");
      ok(!leaks(conv.text, F.email), "B6: guard on + switch on → conversation without the flagged seller's e-mail");
      const convU2 = await a.get(`/api/conversations/${convU}`, "203.0.113.42");
      ok(leaks(convU2.text, U.email), "B7: … the flagged conversation spent no budget (the unflagged seller keeps it, limit 1)");
      delete process.env.EMAIL_REVEAL_GUARD_RFB;
      delete process.env.EMAIL_REVEAL_PER_IP_PER_HOUR;
    }

    // ── D: stored rows unchanged; G: no address in a log line ──────────
    {
      setFlag(F.id, false); // the snapshot was taken before the test set the flag
      const now = JSON.stringify([
        testDb.prepare("SELECT id, content, metadata FROM messages WHERE conversation_id IN (?, ?) ORDER BY id").all(convF, convU),
        testDb.prepare("SELECT agent_id, email FROM agent_knowledge ORDER BY agent_id").all(),
        testDb.prepare("SELECT id, contact_email, contact_form_only FROM agents ORDER BY id").all(),
      ]);
      const before = JSON.parse(storedSnapshot);
      const nowP = JSON.parse(now);
      ok(JSON.stringify(nowP[1]) === JSON.stringify(before[1]) && JSON.stringify(nowP[2]) === JSON.stringify(before[2]), "D1: agents / agent_knowledge unchanged");
      ok((nowP[0] as any[]).every((m) => (before[0] as any[]).some((b) => b.id === m.id && b.content === m.content && b.metadata === m.metadata)), "D2: the stored conversation messages unchanged");
      ok(!guardLog.some((l) => fixture.some((p) => leaks(l, p.email))), "G1: no guard log line carries an e-mail address");
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
    try { clearRegistry(); } catch { /* ignore */ }
    for (const m of ["./marketplace", "./marketplace-cart", "./marketplace-catalog", "./a2a", "./conversation-ui", "./seo"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* ignore */ }
    }
    if (prevMainDb) initMod.__setDbForTesting(prevMainDb as any);
    testDb.close();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbContactFormOnlySd2Tests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
