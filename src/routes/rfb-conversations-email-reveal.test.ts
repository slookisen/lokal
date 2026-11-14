/**
 * rfb-conversations-email-reveal.test.ts — dev-request
 * 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, S-A5 for the
 * public RFB conversation answers: the seller auto-reply's «✉️ <e-mail>» line
 * follows the rfb per-IP counter of services/email-reveal-guard.ts (switch
 * EMAIL_REVEAL_GUARD_RFB, default off) — the counter the profile page and
 * the REST/A2A answers (rfb-api-email-reveal.test.ts) already share.
 *
 * Surfaces:
 *   list    GET  /api/conversations?limit=N            data[].messages[].content
 *   one     GET  /api/conversations/:id                data.messages[].content
 *   start   POST /api/conversations                    data.messages[].content
 *   page    GET  /samtale/:id                          the contact card (HTML)
 *   live    GET  /api/live                             conversation_message events
 *   agrun   POST /api/ag-ui/conversation/:id/run       replay + live TextMessageContent
 *   agget   GET  /api/ag-ui/conversation/:id           live TextMessageContent
 *   home    GET  /                                     showcase preview (shared HTML: never ✉️ with the switch on)
 *
 * Fixture: the made-up producers of rfb-api-email-reveal.test.ts (address,
 * phone, website and e-mail; one with an e-mail and nothing else; one with
 * no e-mail), own in-memory main DB.
 *
 *   O  switch off (unset and "off"): every surface keeps the ✉️ line however
 *      many sellers one IP reads (limit 1), headers as before; CCBot too;
 *      bodies equal to the stored conversation's (no guard touch)
 *   U  switch on, under the limit: bodies byte-identical to switch off, plus
 *      Cache-Control: private (streams: "no-cache, private")
 *   L  switch on, over the limit: only the ✉️ line goes (📍 📞 🌐 and
 *      «Kontakt:» stay); an e-mail-only seller reads as the auto-reply
 *      without an e-mail; the address nowhere in the body; a repeat seller is
 *      free; another IP has its own budget; metadata loses the address too
 *   M  a list counts each seller once, in list order
 *   C  CCBot: never the e-mail, no budget spent
 *   S  one rfb counter shared with the REST card
 *   D  stored rows unchanged
 *   G  log lines carry no e-mail and no IP
 *
 * Standalone: npx tsx src/routes/rfb-conversations-email-reveal.test.ts
 * Wired into tests/test.ts via runRfbConversationsEmailRevealTests().
 */

import Database from "better-sqlite3";
import { RFB_EMAIL_FIXTURE } from "./rfb-profile-email-reveal.test";
import { EMAIL_ONLY, seedRfbApiEmailFixture } from "./rfb-api-email-reveal.test";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HttpResult {
  status: number;
  text: string;
  headers: Record<string, string | string[] | undefined>;
}

interface Stream {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  events: any[];
  raw: () => string;
  close: () => void;
}

const BROWSER = "Mozilla/5.0 (test)";
const CCBOT = "CCBot/2.0 (https://commoncrawl.org/faq/)";

async function startApp() {
  const express = require("express") as typeof import("express");
  const http = require("http") as typeof import("http");
  for (const m of ["./a2a", "./conversation-ui", "./seo", "./marketplace"]) {
    try { delete require.cache[require.resolve(m)]; } catch { /* not loaded */ }
  }
  const a2aRoutes = require("./a2a").default;
  const uiRoutes = require("./conversation-ui").default;
  const seoRoutes = require("./seo").default;
  const marketplaceRoutes = require("./marketplace").default;
  const { langMiddleware } = require("../i18n/middleware");
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use(langMiddleware);
  app.use("/api/marketplace", marketplaceRoutes);
  app.use("/", a2aRoutes);
  app.use("/", uiRoutes);
  app.use("/", seoRoutes);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("net").AddressInfo).port;
  const headersFor = (ip: string, ua: string, payload?: string): Record<string, string> => {
    const h: Record<string, string> = { "x-forwarded-for": ip, "user-agent": ua, accept: "application/json" };
    if (payload !== undefined) { h["content-type"] = "application/json"; h["content-length"] = String(Buffer.byteLength(payload)); }
    return h;
  };
  const call = (method: string, path: string, body: unknown, ip: string, ua = BROWSER): Promise<HttpResult> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const r = http.request({ host: "127.0.0.1", port, path, method, headers: headersFor(ip, ua, payload) }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { text += c; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
      });
      r.on("error", reject);
      if (payload !== undefined) r.write(payload);
      r.end();
    });
  const open = (method: string, path: string, ip: string, ua = BROWSER, body?: unknown): Promise<Stream> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const events: any[] = [];
      let buf = "";
      let all = "";
      const r = http.request({ host: "127.0.0.1", port, path, method, headers: headersFor(ip, ua, payload) }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          all += c;
          buf += c;
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (chunk.startsWith("data: ")) { try { events.push(JSON.parse(chunk.slice(6))); } catch { /* ignore */ } }
          }
        });
        res.on("error", () => { /* closed */ });
        resolve({ status: res.statusCode ?? 0, headers: res.headers, events, raw: () => all, close: () => { r.destroy(); } });
      });
      r.on("error", (e) => { if (!events.length) reject(e); });
      if (payload !== undefined) r.write(payload);
      r.end();
    });
  return {
    get: (path: string, ip: string, ua?: string) => call("GET", path, undefined, ip, ua),
    post: (path: string, body: unknown, ip: string, ua?: string) => call("POST", path, body, ip, ua),
    open,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await wait(10); }
  return cond();
}

export async function runRfbConversationsEmailRevealTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const envKeys = ["EMAIL_REVEAL_GUARD_RFB", "EMAIL_REVEAL_PER_IP_PER_HOUR", "OWNER_PAUSE_ENABLED", "OWNER_FEATURES_ENFORCE", "OWNER_FEATURES_ALLOWED_SUBJECTS"];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  for (const k of envKeys) delete process.env[k];

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevMainDb = initMod.__peekDbForTesting();
  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");
  testDb.function("random", () => 0);

  const guard = require("../services/email-reveal-guard") as typeof import("../services/email-reveal-guard");
  const convGuard = require("../services/conversation-email-guard") as typeof import("../services/conversation-email-guard");
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

  let app: Awaited<ReturnType<typeof startApp>> | null = null;
  const streams: Stream[] = [];
  const prevConsoleLog = console.log;
  if (!log) console.log = () => { /* silence registry chatter */ };

  try {
    initMod.__setDbForTesting(testDb as any);
    initMod.__initSchemaForTesting(testDb as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    const fixture = seedRfbApiEmailFixture(testDb);
    clearRegistry();
    const { conversationService } = require("../services/conversation-service") as typeof import("../services/conversation-service");
    app = await startApp();
    const a = app;

    const P = fixture.slice(0, 3);
    const MASS = fixture.slice(3, 35);
    const NOEMAIL = RFB_EMAIL_FIXTURE.noEmail;
    const allEmails = fixture.map((p) => p.email);
    const forms = (e: string) => [e, JSON.stringify(e).slice(1, -1), e.replace(/&/g, "&amp;"), e.replace(/&/g, "\\u0026"), encodeURIComponent(e)];
    const leaks = (text: string, e: string) => forms(e).some((f) => text.includes(f));
    const body = (r: { text: string }) => { try { return JSON.parse(r.text); } catch { return null; } };
    const EMAIL_LINE = /^\s*✉/m;

    // Conversations, written straight through the service (no budget spent).
    const start = (sellerAgentId: string) => conversationService.startConversation({ sellerAgentId, queryText: "poteter", source: "api" });
    const convOf = new Map<string, string>();
    for (const p of [...P, EMAIL_ONLY]) convOf.set(p.id, start(p.id).id);
    convOf.set(NOEMAIL.id, start(NOEMAIL.id).id);
    const stored = (id: string) => conversationService.getConversation(id)!;
    const sellerMsg = (conv: any) => (conv?.messages ?? []).find((m: any) => m.senderRole === "seller");
    const storedSellerText = (pid: string) => sellerMsg(stored(convOf.get(pid)!)).content as string;
    ok(EMAIL_LINE.test(storedSellerText(P[0]!.id)) && storedSellerText(P[0]!.id).includes(`✉️ ${P[0]!.email}`), "F1: the fixture's auto-reply carries the ✉️ line");
    ok(!EMAIL_LINE.test(storedSellerText(NOEMAIL.id)), "F2: the no-e-mail seller's auto-reply has no ✉️ line");
    // A seller message whose metadata holds the address (an admin-posted seller message can).
    const metaConv = start(P[1]!.id).id;
    conversationService.addMessage({ conversationId: metaConv, senderRole: "seller", senderAgentId: P[1]!.id, content: "Ring oss gjerne.", messageType: "text", metadata: { contact: { email: P[1]!.email, phone: "55512345" }, note: `skriv til ${P[1]!.email}` } });
    const storedSnapshot = JSON.stringify(testDb.prepare("SELECT id, content, metadata FROM messages ORDER BY id").all());

    // ── readers ─────────────────────────────────────────────────────────
    const one = (pid: string, ip: string, ua?: string) => a.get(`/api/conversations/${convOf.get(pid)}`, ip, ua);
    const oneText = (r: HttpResult) => (sellerMsg(body(r)?.data)?.content ?? "") as string;
    const page = (pid: string, ip: string, ua?: string) => a.get(`/samtale/${convOf.get(pid)}`, ip, ua);
    const list = (limit: number, ip: string, ua?: string) => a.get(`/api/conversations?limit=${limit}`, ip, ua);
    const listRows = (r: HttpResult) => ((body(r)?.data ?? []) as any[]).map((c) => ({ seller: c.sellerAgentId as string, text: (sellerMsg(c)?.content ?? "") as string, msgs: c.messages }));
    const startPost = (pid: string, ip: string, ua?: string) => a.post("/api/conversations", { sellerAgentId: pid, queryText: "poteter" }, ip, ua);
    const startText = (r: HttpResult) => oneText(r);
    /** A body without its per-conversation ids and times, so two starts compare byte for byte. */
    const comparable = (t: string) => t.replace(/"(id|conversationId)":"[^"]*"/g, '"$1":"…"').replace(/"(createdAt|updatedAt)":"[^"]*"/g, '"$1":"…"');

    // ── O: switch off ───────────────────────────────────────────────────
    const offBodies = new Map<string, string>();
    for (const off of [undefined, "off"]) {
      switchOff(off);
      freshGuard(1);
      const tag = off ?? "unset";
      const ip = off === undefined ? "198.51.100.10" : "198.51.100.11";
      let keep = true; let hdr = true; let same = true;
      for (const p of [...P, EMAIL_ONLY]) {
        const r = await one(p.id, ip);
        if (r.status !== 200 || oneText(r) !== storedSellerText(p.id)) keep = false;
        if (r.headers["cache-control"] !== undefined) hdr = false;
        if (off === undefined) offBodies.set(`one:${p.id}`, r.text); else if (offBodies.get(`one:${p.id}`) !== r.text) same = false;
      }
      ok(keep, `O1 (${tag}): switch off → GET /api/conversations/:id keeps every seller's ✉️ line (limit 1)`);
      ok(hdr, `O2 (${tag}): switch off → GET /api/conversations/:id has no Cache-Control`);
      if (off === "off") ok(same, "O3: switch \"off\" → GET /api/conversations/:id bodies identical to switch unset");
      const l = await list(50, ip);
      const rows = listRows(l);
      ok(rows.filter((x) => EMAIL_LINE.test(x.text)).length >= 4, `O4 (${tag}): switch off → the list keeps every ✉️ line (limit 1)`);
      eq(l.headers["cache-control"], undefined, `O5 (${tag}): switch off → the list has no Cache-Control`);
      ok(((body(l)?.data ?? []) as any[]).every((c) => JSON.stringify(c.messages.filter((m: any) => m.senderRole === "seller"))
        === JSON.stringify(stored(c.id).messages.filter((m: any) => m.senderRole === "seller"))), `O6 (${tag}): switch off → list seller messages equal the stored rows`);
      if (off === undefined) offBodies.set("list", l.text);
      else {
        // The unset round's POST added a conversation; every earlier row reads the same.
        const now = (body(l).data as any[]);
        ok((JSON.parse(offBodies.get("list")!).data as any[]).every((o) => JSON.stringify(now.find((x) => x.id === o.id)) === JSON.stringify(o)), "O7: switch \"off\" → list rows identical to switch unset");
      }
      const pg = await page(P[0]!.id, ip);
      ok(pg.status === 200 && leaks(pg.text, P[0]!.email), `O8 (${tag}): switch off → /samtale/:id shows the e-mail in the contact card`);
      if (off === undefined) offBodies.set("page", pg.text); else ok(pg.text === offBodies.get("page"), "O9: switch \"off\" → /samtale/:id identical to switch unset");
      offBodies.set(`pagecc:${tag}`, String(pg.headers["cache-control"]));
      const st = await startPost(P[2]!.id, ip);
      ok(st.status === 200 && startText(st).includes(`✉️ ${P[2]!.email}`), `O10 (${tag}): switch off → POST /api/conversations returns the ✉️ line`);
      eq(st.headers["cache-control"], undefined, `O11 (${tag}): switch off → POST /api/conversations has no Cache-Control`);
      const stConv = stored(body(st).data.id);
      ok(comparable(st.text) === comparable(JSON.stringify({ success: true, data: stConv })), `O12 (${tag}): switch off → POST /api/conversations body is the stored conversation as before`);
      const cc = await one(P[0]!.id, ip, CCBOT);
      ok(oneText(cc) === storedSellerText(P[0]!.id), `O13 (${tag}): switch off → CCBot keeps the ✉️ line`);
    }
    // Off: the streams carry the ✉️ line and keep "no-cache".
    {
      switchOff();
      freshGuard(0);
      const live = await a.open("GET", "/api/live", "198.51.100.12"); streams.push(live);
      eq(live.headers["cache-control"], "no-cache", "O14: switch off → /api/live Cache-Control: no-cache as before");
      const run = await a.open("POST", `/api/ag-ui/conversation/${convOf.get(P[0]!.id)}/run`, "198.51.100.12", BROWSER, {}); streams.push(run);
      eq(run.headers["cache-control"], "no-cache", "O15: switch off → AG-UI run Cache-Control: no-cache as before");
      await until(() => run.events.some((e) => e.type === "TextMessageContent" && EMAIL_LINE.test(e.delta ?? "")));
      ok(run.events.some((e) => e.type === "TextMessageContent" && (e.delta ?? "").includes(P[0]!.email)), "O16: switch off → AG-UI run replays the ✉️ line (limit 0)");
      const agget = await a.open("GET", `/api/ag-ui/conversation/${convOf.get(P[1]!.id)}`, "198.51.100.12"); streams.push(agget);
      eq(agget.headers["cache-control"], "no-cache", "O17: switch off → AG-UI stream Cache-Control: no-cache as before");
      await wait(30);
      const before = live.events.length;
      conversationService.addMessage({ conversationId: convOf.get(P[1]!.id)!, senderRole: "seller", senderAgentId: P[1]!.id, content: `Hei!\n\nKontakt oss:\n📞 55512345\n✉️ ${P[1]!.email}`, messageType: "offer", metadata: { contact: { email: P[1]!.email } } });
      await until(() => live.events.length > before && agget.events.some((e) => e.type === "TextMessageContent"));
      const lv = live.events.slice(before).find((e) => e.type === "conversation_message" && e.senderRole === "seller");
      ok(!!lv && lv.content.includes(`✉️ ${P[1]!.email}`) && lv.metadata?.contact?.email === P[1]!.email, "O18: switch off → /api/live broadcasts the ✉️ line and metadata unchanged");
      const ag = agget.events.find((e) => e.type === "TextMessageContent");
      ok(!!ag && ag.delta.includes(`✉️ ${P[1]!.email}`), "O19: switch off → the AG-UI stream sends the ✉️ line");
      const agc = agget.events.find((e) => e.type === "Custom" && e.name === "a2a.message_type");
      ok(agc?.value?.metadata?.contact?.email === P[1]!.email, "O20: switch off → the AG-UI Custom event keeps the metadata");
      for (const s of streams.splice(0)) s.close();
      // The pure helpers: switch off returns the very same objects.
      const convs = [stored(convOf.get(P[0]!.id)!)];
      ok(convGuard.withoutSellerEmailAlways(convs) === convs, "O21: switch off → withoutSellerEmailAlways returns its input");
      eq(logLines.length, 0, "O22: switch off → the guard logs nothing");
    }

    // ── U: switch on, under the limit ───────────────────────────────────
    switchOn();
    freshGuard(1000);
    {
      const ip = "198.51.100.20";
      let same = true; let priv = true;
      for (const p of [...P, EMAIL_ONLY]) {
        const r = await one(p.id, ip);
        switchOff();
        const offNow = await one(p.id, ip);
        switchOn();
        if (r.text !== offNow.text || offNow.headers["cache-control"] !== undefined) same = false;
        if (r.headers["cache-control"] !== "private") priv = false;
      }
      ok(same, "U1: switch on, under the limit → GET /api/conversations/:id bodies byte-identical to switch off");
      ok(priv, "U2: switch on → GET /api/conversations/:id is Cache-Control: private");
      const l = await list(50, ip);
      // The off list was read before the off-section's POSTs and the stream message; compare the same rows.
      const offRows = ((JSON.parse(offBodies.get("list")!).data) as any[]);
      const onRows = ((body(l).data) as any[]);
      ok(offRows.every((o) => JSON.stringify(onRows.find((x) => x.id === o.id && x.updatedAt === o.updatedAt) ?? o) === JSON.stringify(o)), "U3: switch on, under the limit → list rows byte-identical to switch off");
      eq(l.headers["cache-control"], "private", "U4: switch on → the list is Cache-Control: private");
      const pg = await page(P[0]!.id, ip);
      ok(pg.text === offBodies.get("page"), "U5: switch on, under the limit → /samtale/:id byte-identical to switch off");
      eq(pg.headers["cache-control"], "private", "U6: switch on → /samtale/:id is Cache-Control: private");
      const st = await startPost(P[2]!.id, ip);
      ok(comparable(st.text) === comparable(JSON.stringify({ success: true, data: stored(body(st).data.id) })), "U7: switch on, under the limit → POST /api/conversations body as switch off");
      eq(st.headers["cache-control"], "private", "U8: switch on → POST /api/conversations is Cache-Control: private");
      const ne = await one(NOEMAIL.id, ip);
      ok(ne.text === JSON.stringify({ success: true, data: JSON.parse(ne.text).data }) && ne.headers["cache-control"] === "private" && !EMAIL_LINE.test(oneText(ne)), "N1: switch on → a seller without an e-mail: unchanged, private");
      const live = await a.open("GET", "/api/live", ip); streams.push(live);
      eq(live.headers["cache-control"], "no-cache, private", "U9: switch on → /api/live Cache-Control: no-cache, private");
      const run = await a.open("POST", `/api/ag-ui/conversation/${convOf.get(P[0]!.id)}/run`, ip, BROWSER, {}); streams.push(run);
      eq(run.headers["cache-control"], "no-cache, private", "U10: switch on → AG-UI run Cache-Control: no-cache, private");
      await until(() => run.events.some((e) => e.type === "TextMessageContent" && EMAIL_LINE.test(e.delta ?? "")));
      ok(run.events.some((e) => e.type === "TextMessageContent" && (e.delta ?? "").includes(P[0]!.email)), "U11: switch on, under the limit → AG-UI run replays the ✉️ line");
      const agget = await a.open("GET", `/api/ag-ui/conversation/${convOf.get(P[0]!.id)}`, ip); streams.push(agget);
      eq(agget.headers["cache-control"], "no-cache, private", "U12: switch on → AG-UI stream Cache-Control: no-cache, private");
      for (const s of streams.splice(0)) s.close();
    }

    // ── L: switch on, over the limit ────────────────────────────────────
    {
      freshGuard(1);
      const ip = "198.51.100.30";
      const r0 = await one(NOEMAIL.id, ip);   // N: costs nothing
      ok(r0.status === 200, "N2: a seller without an e-mail answers");
      const r1 = await one(P[0]!.id, ip);
      ok(oneText(r1) === storedSellerText(P[0]!.id), "L1: the first seller keeps its ✉️ line (limit 1; the no-e-mail seller cost nothing)");
      const r2 = await one(P[1]!.id, ip);
      const t2 = oneText(r2);
      const s2 = storedSellerText(P[1]!.id);
      ok(r2.status === 200 && !EMAIL_LINE.test(t2) && !leaks(r2.text, P[1]!.email), "L2: over the limit → no ✉️ line, the address nowhere in the body");
      eq(t2, s2.split("\n").filter((x) => !x.startsWith("✉️")).join("\n"), "L3: over the limit → only the ✉️ line is gone (📍 📞 🌐 and «Kontakt oss:» stay)");
      ok(t2.includes("\nKontakt:\n") && t2.includes("📍") && t2.includes("📞") && t2.includes("🌐"), "L4: over the limit → the other contact lines stay");
      eq(r2.headers["cache-control"], "private", "L5: over the limit → Cache-Control: private");
      const d2 = body(r2).data; const so2 = JSON.parse(offBodies.get(`one:${P[1]!.id}`)!).data;
      eq(Object.keys(d2), Object.keys(so2), "L6: over the limit → same keys as within the limit");
      eq(d2.messages.filter((m: any) => m.senderRole !== "seller"), so2.messages.filter((m: any) => m.senderRole !== "seller"), "L7: over the limit → buyer/system messages unchanged");
      const again = await one(P[0]!.id, ip);
      ok(oneText(again) === storedSellerText(P[0]!.id), "L8: a repeat view of a counted seller is free");
      const other = await one(P[1]!.id, "198.51.100.31");
      ok(oneText(other) === s2, "L9: another IP has its own budget");
      // The e-mail-only seller: the text reads as the auto-reply of that seller without an e-mail.
      const eo = await one(EMAIL_ONLY.id, ip);
      testDb.prepare("UPDATE agent_knowledge SET email = NULL WHERE agent_id = ?").run(EMAIL_ONLY.id);
      const ref = conversationService.generateSellerResponse(EMAIL_ONLY.id, "poteter")!.text;
      testDb.prepare("UPDATE agent_knowledge SET email = ? WHERE agent_id = ?").run(EMAIL_ONLY.email, EMAIL_ONLY.id);
      eq(oneText(eo), ref, "L10: e-mail-only seller over the limit → the auto-reply of the same seller without an e-mail (no empty «Kontakt oss:»)");
      // Metadata.
      const mr = await a.get(`/api/conversations/${metaConv}`, "198.51.100.32");   // fresh IP, limit 1: P[1] is its first
      const mm = body(mr).data.messages.find((m: any) => m.content === "Ring oss gjerne.");
      ok(mm?.metadata?.contact?.email === P[1]!.email, "L11: under the limit → metadata keeps the address");
      await one(P[0]!.id, "198.51.100.33");
      const mr2 = await a.get(`/api/conversations/${metaConv}`, "198.51.100.33");
      const mm2 = body(mr2).data.messages.find((m: any) => m.content === "Ring oss gjerne.");
      ok(!!mm2 && !leaks(mr2.text, P[1]!.email), "L12: over the limit → the address is out of the metadata too");
      eq(mm2?.metadata, { contact: { email: "", phone: "55512345" }, note: "skriv til " }, "L13: over the limit → metadata keeps its shape, other values unchanged");
      // POST /api/conversations over the limit.
      freshGuard(1);
      const ipS = "198.51.100.34";
      const s1 = await startPost(P[0]!.id, ipS);
      ok(startText(s1).includes(`✉️ ${P[0]!.email}`), "L14: POST /api/conversations → the first seller keeps its ✉️ line");
      const s2b = await startPost(P[1]!.id, ipS);
      ok(s2b.status === 200 && !EMAIL_LINE.test(startText(s2b)) && !leaks(s2b.text, P[1]!.email), "L15: POST /api/conversations over the limit → no ✉️ line, address nowhere");
      ok(EMAIL_LINE.test(sellerMsg(stored(body(s2b).data.id)).content), "L16: POST /api/conversations over the limit → the stored row keeps its ✉️ line");
      eq(s2b.headers["cache-control"], "private", "L17: POST /api/conversations over the limit → Cache-Control: private");
      // /samtale/:id over the limit.
      freshGuard(0);
      const pg = await page(P[0]!.id, "198.51.100.35");
      ok(pg.status === 200 && !leaks(pg.text, P[0]!.email) && pg.text.includes("Kontakt &amp; &aring;pningstider") && pg.text.includes("55512345"), "L18: /samtale/:id over the limit → the contact card without the e-mail, other lines stay");
      eq(pg.headers["cache-control"], "private", "L19: /samtale/:id over the limit → Cache-Control: private");
      ok(pg.text === offBodies.get("page")!.split("\n").map((ln) => ln.replace(/<div class="cc-line">✉️ [^<]*<\/div>/g, "")).join("\n"), "L20: /samtale/:id over the limit = the same page without the ✉️ card line");
    }

    // ── M: the list counts each seller once, in list order ─────────────
    {
      // A burst of conversations with the 32 extra sellers on top of the list.
      for (const p of MASS.slice(0, 10)) start(p.id);
      freshGuard(3);
      const ip = "198.51.100.40";
      const r = await list(200, ip);
      const rows = listRows(r);
      const withEmailStored = rows.filter((x) => x.seller && allEmails.includes(fixture.find((p) => p.id === x.seller)?.email ?? ""));
      const sellersInOrder: string[] = [];
      for (const x of withEmailStored) if (!sellersInOrder.includes(x.seller)) sellersInOrder.push(x.seller);
      const firstThree = sellersInOrder.slice(0, 3);
      const kept = rows.filter((x) => EMAIL_LINE.test(x.text)).map((x) => x.seller);
      eq([...new Set(kept)], firstThree, "M1: list, limit 3 → the first 3 sellers in list order keep the ✉️ line");
      const metaRow = ((body(r).data ?? []) as any[]).find((c) => c.id === metaConv);
      const metaKept = firstThree.includes(P[1]!.id);
      ok(!metaRow || metaKept || !leaks(JSON.stringify(metaRow), P[1]!.email), "M2: list → a withheld seller's metadata address is out too");
      ok(rows.length > 10 && rows.every((x) => !EMAIL_LINE.test(x.text) || firstThree.includes(x.seller)), "M3: list → every other seller loses its ✉️ line");
      const leaked = allEmails.filter((e) => leaks(r.text, e) && !firstThree.some((id) => fixture.find((p) => p.id === id)?.email === e));
      eq(leaked, [], "M4: list → no withheld address anywhere in the body");
      // A seller seen twice in the list costs once: P[1] has two conversations (auto-reply and metadata).
      const p1rows = rows.filter((x) => x.seller === P[1]!.id).length;
      ok(p1rows >= 2, `M5: the list holds ${p1rows} conversations of one seller`);
      const again = await list(200, ip);
      eq([...new Set(listRows(again).filter((x) => EMAIL_LINE.test(x.text)).map((x) => x.seller))], firstThree, "M6: a repeat list gives the same 3 (repeat sellers free, no new ones)");
      freshGuard(2);
      const r2 = await list(200, "198.51.100.41");
      const kept2 = new Set(listRows(r2).filter((x) => EMAIL_LINE.test(x.text)).map((x) => x.seller));
      eq(kept2.size, 2, "M7: list, limit 2 → two sellers keep the ✉️ line, each seller counted once however many rows it has");
      const cc = await list(200, "198.51.100.42", CCBOT);
      eq(listRows(cc).filter((x) => EMAIL_LINE.test(x.text)).length, 0, "M8: CCBot list → no ✉️ line");
      eq(cc.headers["cache-control"], "private", "M9: CCBot list → Cache-Control: private");
    }

    // ── C: CCBot never, no budget ───────────────────────────────────────
    {
      freshGuard(3);
      const ip = "198.51.100.50";
      const c1 = await one(P[0]!.id, ip, CCBOT);
      ok(!EMAIL_LINE.test(oneText(c1)) && !leaks(c1.text, P[0]!.email), "C1: CCBot gets no ✉️ line on its first request");
      const c2 = await startPost(P[0]!.id, ip, CCBOT);
      ok(c2.status !== 200 || (!EMAIL_LINE.test(startText(c2)) && !leaks(c2.text, P[0]!.email)), "C2: CCBot POST /api/conversations → no ✉️ line");
      const c3 = await page(P[0]!.id, ip, CCBOT);
      ok(!leaks(c3.text, P[0]!.email), "C3: CCBot /samtale/:id → no e-mail");
      const after = await Promise.all(P.map((p) => one(p.id, ip)));
      ok(after.every((x, i) => oneText(x) === storedSellerText(P[i]!.id)), "C4: CCBot spent none of the IP's budget (3 sellers still get their ✉️ line)");
    }

    // ── live streams over the limit ─────────────────────────────────────
    {
      freshGuard(1);
      const ipA = "198.51.100.60";   // will have spent its budget
      const ipB = "198.51.100.61";   // fresh
      await one(P[0]!.id, ipA);      // ipA: P[0] counted, budget gone
      const liveA = await a.open("GET", "/api/live", ipA); streams.push(liveA);
      const liveB = await a.open("GET", "/api/live", ipB); streams.push(liveB);
      const liveC = await a.open("GET", "/api/live", "198.51.100.62", CCBOT); streams.push(liveC);
      const agA = await a.open("GET", `/api/ag-ui/conversation/${convOf.get(P[1]!.id)}`, ipA); streams.push(agA);
      const agB = await a.open("GET", `/api/ag-ui/conversation/${convOf.get(P[1]!.id)}`, ipB); streams.push(agB);
      await wait(30);
      const text = `Hei!\n\nKontakt oss:\n📞 55512345\n✉️ ${P[1]!.email}`;
      conversationService.addMessage({ conversationId: convOf.get(P[1]!.id)!, senderRole: "seller", senderAgentId: P[1]!.id, content: text, messageType: "offer", metadata: { contact: { email: P[1]!.email } } });
      const sellerEv = (s: Stream) => s.events.find((e) => e.type === "conversation_message" && e.senderRole === "seller");
      await until(() => !!sellerEv(liveA) && !!sellerEv(liveB) && !!sellerEv(liveC)
        && agA.events.some((e) => e.type === "Custom" && e.name === "a2a.message_type") && agB.events.some((e) => e.type === "Custom" && e.name === "a2a.message_type"));
      const eA = sellerEv(liveA); const eB = sellerEv(liveB); const eC = sellerEv(liveC);
      ok(!!eB && eB.content === text && eB.metadata?.contact?.email === P[1]!.email, "V1: /api/live → a listener under the limit gets the ✉️ line");
      ok(!!eA && eA.content === "Hei!\n\nKontakt oss:\n📞 55512345" && !leaks(liveA.raw(), P[1]!.email), "V2: /api/live → a listener over the limit gets the message without the ✉️ line, address nowhere");
      eq(eA?.metadata, { contact: { email: "" } }, "V3: /api/live → over the limit the metadata address is out");
      ok(!!eC && !leaks(liveC.raw(), P[1]!.email), "V4: /api/live → CCBot listener never gets the address");
      eq(Object.keys(eA ?? {}), Object.keys(eB ?? {}), "V5: /api/live → the withheld event has the same keys");
      const agTxt = (s: Stream) => s.events.find((e) => e.type === "TextMessageContent")?.delta;
      eq(agTxt(agB), text, "V6: AG-UI stream → a client under the limit gets the ✉️ line");
      ok(agTxt(agA) === "Hei!\n\nKontakt oss:\n📞 55512345" && !leaks(agA.raw(), P[1]!.email), "V7: AG-UI stream → a client over the limit gets no ✉️ line, address nowhere (Custom metadata too)");
      // AG-UI run replay over the limit.
      const runA = await a.open("POST", `/api/ag-ui/conversation/${convOf.get(P[2]!.id)}/run`, ipA, BROWSER, {}); streams.push(runA);
      await until(() => runA.events.filter((e) => e.type === "TextMessageContent").length >= 2);
      const replay = runA.events.filter((e) => e.type === "TextMessageContent").map((e) => e.delta as string);
      ok(replay.length >= 2 && replay.every((d) => !EMAIL_LINE.test(d)) && !leaks(runA.raw(), P[2]!.email), "V8: AG-UI run over the limit → the replay has no ✉️ line");
      eq(runA.headers["cache-control"], "no-cache, private", "V9: AG-UI run over the limit → no-cache, private");
      for (const s of streams.splice(0)) s.close();
    }

    // ── shared pages: never the ✉️ line with the switch on, no budget ───
    {
      freshGuard(1);
      const ip = "198.51.100.70";
      const shown = convGuard.withoutSellerEmailAlways([stored(convOf.get(P[0]!.id)!)]);
      ok(!EMAIL_LINE.test(sellerMsg(shown[0]).content) && !JSON.stringify(shown).includes(P[0]!.email), "H1: withoutSellerEmailAlways → no ✉️ line (switch on)");
      // The front page: newest conversations first; make P[0]'s the newest (a no-product auto-reply would show the contact block in its preview).
      start(EMAIL_ONLY.id);
      const home = await a.get("/", ip);
      ok(home.status === 200 && home.text.includes("cv-card") && !leaks(home.text, EMAIL_ONLY.email), `H2: front page showcase → no seller e-mail with the switch on (status ${home.status})`);
      const after = await one(P[0]!.id, ip);
      ok(oneText(after) === storedSellerText(P[0]!.id), "H3: the front page spent none of the IP's budget");
      switchOff();
      const homeOff = await a.get("/", ip);
      ok(homeOff.status === 200 && leaks(homeOff.text, EMAIL_ONLY.email), "H4: switch off → the front page preview shows the e-mail-only seller's ✉️ line as before");
      switchOn();
      // /samtaler (finished-HTML cache per ?kilde= key: on reads "", off reads "api").
      freshGuard(1);
      const sam = await a.get("/samtaler", ip);
      ok(sam.status === 200 && sam.text.includes("agent-reply") && !leaks(sam.text, EMAIL_ONLY.email), `H5: /samtaler → no seller e-mail in the reply previews with the switch on (status ${sam.status})`);
      switchOff();
      const samOff = await a.get("/samtaler?kilde=api", ip);
      ok(samOff.status === 200 && leaks(samOff.text, EMAIL_ONLY.email), "H6: switch off → /samtaler previews show the e-mail-only seller's ✉️ line as before");
      switchOn();
      const after2 = await one(P[1]!.id, ip);
      ok(oneText(after2) === storedSellerText(P[1]!.id), "H7: /samtaler spent none of the IP's budget");
    }

    // ── S: one rfb counter with the REST card ───────────────────────────
    {
      freshGuard(2);
      const ip = "198.51.100.80";
      await a.get(`/api/marketplace/agents/${P[0]!.id}/card`, ip);
      await one(P[1]!.id, ip);
      const t = await one(P[2]!.id, ip);
      ok(!EMAIL_LINE.test(oneText(t)), "S1: REST card + a conversation spend one rfb budget → the 3rd seller has no ✉️ line");
      const back = await one(P[0]!.id, ip);
      ok(oneText(back) === storedSellerText(P[0]!.id), "S2: a seller counted on the REST card is free in a conversation");
    }

    // ── D: stored rows unchanged ────────────────────────────────────────
    {
      const now = testDb.prepare("SELECT id, content, metadata FROM messages ORDER BY id").all() as any[];
      const before = JSON.parse(storedSnapshot) as any[];
      ok(before.every((b) => { const n = now.find((x) => x.id === b.id); return n && n.content === b.content && n.metadata === b.metadata; }), "D1: the stored messages are unchanged");
    }

    // ── G: log lines ────────────────────────────────────────────────────
    {
      ok(logLines.length > 0, "G1: the guard logged withheld requests");
      const joined = logLines.join("\n");
      ok(!allEmails.some((e) => leaks(joined, e)), "G2: no log line carries an e-mail address");
      ok(!/198\.51\.100\./.test(joined), "G3: no log line carries an IP");
    }
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.log = prevConsoleLog;
    for (const s of streams) { try { s.close(); } catch { /* ignore */ } }
    if (app) await app.close().catch(() => {});
    for (const k of envKeys) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    guard.__resetEmailRevealGuardForTesting();
    try { clearRegistry(); } catch { /* ignore */ }
    for (const m of ["./a2a", "./conversation-ui", "./seo", "./marketplace"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* ignore */ }
    }
    if (prevMainDb) initMod.__setDbForTesting(prevMainDb as any);
    testDb.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbConversationsEmailRevealTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
